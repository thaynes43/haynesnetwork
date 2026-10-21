"""Truth-leak protection for everything sent to a model.

Three parts:
  alias(run_id, case_id)   opaque per-run id shown to the model instead of the case id (ids encode the truth class)
  redact(text, case, ...)  replaces fixture file names / paths (they encode the answer: hl_e02_flip.mkv, qo_hevc.mkv ...)
                           by `context.filename` when the case provides one, else a neutral `input.<ext>`
  check_messages(case, m)  guard run on every model-bound request; raises LeakError when a forbidden token is present

Forbidden tokens for a case: the case id and its stem (id without the trailing number), the family, the truth class,
write-action names, the truth reference text, every provenance string, and every fixture / replacement file basename and
stem.  Case-authored task context (`context.title`, `filename`, `expected`, `client_profile`, `question`) is accepted and is
not a token source.  The static system prompt is not checked here (it legitimately lists the class and action names).
"""
import hashlib
import hmac
import re
from pathlib import Path

WRITE_ACTIONS = ('blocklist_and_search', 'remap', 'rename', 'convert')


class LeakError(Exception):
    """A model-bound request contains a forbidden token.  A harness error, never a model miss."""


def alias(run_id, case_id):
    return 'case-' + hmac.new(str(run_id).encode(), str(case_id).encode(), hashlib.sha256).hexdigest()[:8]


def _locators(case):
    out = []
    fx = case.get('fixture') or {}
    if fx.get('kind') == 'local' and fx.get('locator'):
        out.append(fx['locator'])
    rep = ((case.get('outcome_step') or {}).get('inputs') or {}).get('replacement') or {}
    if rep.get('locator'):
        out.append(rep['locator'])
    return out


def fixture_basenames(case, extra_paths=()):
    names = []
    for loc in list(_locators(case)) + list(extra_paths):
        b = Path(str(loc)).name
        if b and b not in names:
            names.append(b)
    return names


def display_name(case, extra_paths=()):
    fn = (case.get('context') or {}).get('filename')
    if fn:
        return fn
    names = fixture_basenames(case, extra_paths)
    return 'input' + (Path(names[0]).suffix if names else '')


def _ci(token):
    return re.compile(r'(?<![A-Za-z0-9])' + re.escape(token) + r'(?![A-Za-z0-9])', re.IGNORECASE)


def _cs(token):
    return re.compile(r'(?<![A-Za-z0-9])' + re.escape(token) + r'(?![A-Za-z0-9])')


def redact(text, case, extra_paths=()):
    """Replace fixture paths / names (and bare stems) in tool output or evidence with the display name."""
    if not isinstance(text, str) or not text:
        return text
    disp = display_name(case, extra_paths)
    disp_stem = Path(disp).stem
    for loc in list(_locators(case)) + list(extra_paths):
        loc = str(loc)
        base = Path(loc).name
        if not base:
            continue
        for needle in sorted({loc, 'media/' + base, base}, key=len, reverse=True):
            text = re.sub(r'(?<![A-Za-z0-9])' + re.escape(needle) + r'(?![A-Za-z0-9])', lambda m: disp, text, flags=re.IGNORECASE)
        stem = Path(base).stem
        if len(stem) >= 2:
            text = _ci(stem).sub(lambda m: disp_stem, text)
    return text


def forbidden_tokens(case, extra_paths=()):
    """-> list of (kind, compiled regex).  Boundary-aware: 'lr' does not match inside 'world'."""
    toks = []
    cid = case['id']
    toks.append(('case_id', _ci(cid)))
    stem = re.sub(r'-\d+$', '', cid)
    if stem != cid:
        toks.append(('case_id_stem', _ci(stem)))
    fam = case.get('family')
    if fam:
        toks.append(('family', _cs(fam)))
    truth = (case.get('truth') or {})
    cls = truth.get('class')
    if cls:
        toks.append(('truth_class', _cs(cls)))
    if truth.get('ref'):
        toks.append(('truth_ref', re.compile(re.escape(truth['ref']), re.IGNORECASE)))
    for act in case.get('supported_actions') or []:
        if act in WRITE_ACTIONS:
            toks.append(('supported_action', _cs(act)))
    prov = case.get('provenance')
    if prov:
        toks.append(('provenance', re.compile(re.escape(prov), re.IGNORECASE)))
        for piece in re.split(r'\s+', prov):
            if len(piece) >= 8 and ('/' in piece or '@' in piece):
                toks.append(('provenance', re.compile(re.escape(piece.strip('(),;')), re.IGNORECASE)))
    for base in fixture_basenames(case, extra_paths):
        toks.append(('fixture_name', _ci(base)))
        st = Path(base).stem
        if len(st) >= 2:
            toks.append(('fixture_stem', _ci(st)))
    return toks


def find_leaks(case, text, extra_paths=()):
    return sorted({kind for kind, rx in forbidden_tokens(case, extra_paths) if rx.search(text)})


REPAIR_PREFIX = 'Your last reply was rejected:'
# Harness-authored text that is generic by construction (a validator error lists every allowed class and action, which are not
# case-specific).  For these, only case-specific tokens count: case id and stem, family, fixture names, provenance, truth ref.
# The class and action names are public protocol vocabulary.  Never put model- or case-derived free text into such a message.
GENERIC_PREFIXES = (REPAIR_PREFIX,)
GENERIC_KINDS = ('supported_action', 'truth_class')
# What a static system prompt must never contain: this case's id (and its stem), file names and a long provenance string.
# The title is NOT checked: a one-word title such as `Identity` is an ordinary protocol word and the model sees it in the case context anyway.
#  Ordinary words are not checked: tokens shorter than 6 characters (an id such as `a`, a provenance tag such as `new`)
# would match everyday words, so they are skipped; real case ids, titles and file names are longer.
SYSTEM_MIN_LEN = 6


def check_system(case, system, extra_paths=()):
    """Guard for the static system prompt: it may name classes and actions, but never this case's id, file name or provenance."""
    cid = str(case.get('id') or '')
    cands = {'case_id': [cid], 'case_id_stem': [re.sub(r'-\d+$', '', cid)], 'fixture_name': fixture_basenames(case, extra_paths),
             'provenance': [str(case.get('provenance') or '')]}   # the title is case context the model sees anyway: not checked
    hits = sorted(kind for kind, toks in cands.items() if any(len(t) >= SYSTEM_MIN_LEN and _ci(t).search(system or '') for t in toks))
    if hits:
        raise LeakError('forbidden token(s) %s in the system prompt' % hits)



def check_messages(case, messages, extra_paths=()):
    """Guard for a model request: every harness-authored (user) message must be free of forbidden tokens."""
    toks = forbidden_tokens(case, extra_paths)
    for i, m in enumerate(messages):
        if m.get('role') != 'user':
            continue
        content = m.get('content', '')
        mine = toks
        if content.startswith(GENERIC_PREFIXES):
            # The repair prompt quotes the validator's error, which lists every allowed action and class
            # (e.g. "action must be one of ... rename ..."). That generic enumeration is not a leak, and checking it
            # crashed two haiku cases on 2026-10-19 (G9). Everything case-specific is still checked.
            mine = [(k, rx) for k, rx in toks if k not in GENERIC_KINDS]
        hits = sorted({kind for kind, rx in mine if rx.search(content)})
        if hits:
            raise LeakError('forbidden token(s) %s in model-bound message %d' % (hits, i + 1))


# ---- leakguard-media-1 (dev-c7, format v3.1-format only; the legacy check above is unchanged and still applies everywhere else) --------------------------
# SUPERSEDED by leakguard-media-2 below (second review round) and no longer selected by any run; kept as written so its first-round tests stay meaningful.
# Text READ FROM THE MEDIA (tools-v3 EPUB excerpts, headings, declared TOC text, the legacy heads, OPF values) is the item's own content.  Checking it with the
# legacy tokens refuses ordinary words: a family word that is already the visible title, a truth-class word ("healthy") in a novel's prose, a short
# provenance value ("new") inside "knew".  In media text only TRUE IDENTIFIERS are refused: the case id, the fixture file names and stems, and provenance PATH
# pieces, each word-bounded and only when at least SYSTEM_MIN_LEN characters long (the check_system rule), and only when the identifier is not already visible
# in the case context the model is shown.  Everything the harness wrote in the same message keeps the legacy check.  A refusal is a LeakError, recorded as a
# harness error exactly as before: the model answered the earlier turns, and the request that would carry the tool result is not sent.
MEDIA_RULE = 'leakguard-media-1'
_MARKER_RX = re.compile(r'\.\.\.\[\+\d+ chars: detail [^\]]*\]$')


def media_tokens(case, extra_paths=()):
    """-> [(kind, compiled regex)] of the true identifiers checked in media text."""
    cands = [('case_id', str(case.get('id') or ''))]
    for b in fixture_basenames(case, extra_paths):
        cands += [('fixture_name', b), ('fixture_stem', Path(b).stem)]
    for piece in re.split(r'\s+', str(case.get('provenance') or '')):
        piece = piece.strip('(),;')
        if len(piece) >= 8 and ('/' in piece or '@' in piece):
            cands.append(('provenance_path', piece))
    out, seen = [], set()
    for kind, t in cands:
        if len(t) >= SYSTEM_MIN_LEN and (kind, t) not in seen:
            seen.add((kind, t))
            out.append((kind, _ci(t)))
    return out


def _mask(obj, media):
    """-> (the JSON value with every string read from the media blanked, [the media strings found]).  A string counts as media text when, without the
    harness's own externalisation marker, it is a non-empty part of a string the tool read from the media (pages and details carry pieces of it)."""
    found = []

    def walk(v):
        if isinstance(v, str):
            core = _MARKER_RX.sub('', v)
            if core and any(core in m for m in media):
                found.append(core)
                return ''
            return v
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v
    return walk(obj), found


def _legacy_hits(content, toks):
    mine = toks
    if content.startswith(GENERIC_PREFIXES):
        mine = [(k, rx) for k, rx in toks if k not in GENERIC_KINDS]
    return sorted({kind for kind, rx in mine if rx.search(content)})


def check_messages_media(case, messages, media_texts, visible='', extra_paths=()):
    """Guard for a format v3.1-format request (MEDIA_RULE): harness-written text gets the legacy check; text read from the media gets the identifier check."""
    import json
    toks = forbidden_tokens(case, extra_paths)
    media = [m for m in media_texts if m]
    mtoks = [(k, rx) for k, rx in media_tokens(case, extra_paths) if not rx.search(visible or '')]
    for i, m in enumerate(messages):
        if m.get('role') != 'user':
            continue
        content = m.get('content', '')
        head, sep, tail = content.partition('\n')
        masked, found = None, []
        if media:
            try:
                masked, found = _mask(json.loads(head), media)
            except ValueError:
                found = []
        harness_text = content if not found else json.dumps(masked, ensure_ascii=False) + sep + tail
        hits = _legacy_hits(harness_text, toks)
        if hits:
            raise LeakError('forbidden token(s) %s in model-bound message %d' % (hits, i + 1))
        mhits = sorted({kind for kind, rx in mtoks for t in found if rx.search(t)})
        if mhits:
            raise LeakError('forbidden identifier(s) %s in text read from the media, model-bound message %d (%s)' % (mhits, i + 1, MEDIA_RULE))


# ---- leakguard-media-2 (dev-c7 second review round, AUDIT-ASTRA-28 item 3 and the Opus review; format v3.1-format only) ---------------------------------
# media-1 had bypasses: it skipped case-id stems and identifiers shorter than 6 characters, let truth-class and action words with an underscore through,
# checked each excerpt alone (an id split across two adjacent excerpts passed), and inferred media provenance from matching text (harness-written text that
# also occurs in the media escaped the legacy check).  media-2 fixes all four, generally:
#   * WHAT IS MEDIA TEXT is never inferred from its value.  The caller passes the legacy check a harness-only SHADOW of every message (each literal media
#     string blanked at its known field), and passes the media strings themselves as SOURCES with their field paths and, for excerpts, their ranges.
#   * IN MEDIA TEXT, anything that cannot be ordinary prose is refused: the case id (any length), the fixture file names, and every other hidden value that is
#     not plain words (letters, with single spaces or apostrophes between them): a case-id stem, family, truth class, write action, provenance or provenance
#     path piece containing `-`, `_`, a digit, `/`, `.` or another non-letter.  The truth reference is refused when it is not a short plain word (a sentence
#     is refused whole).  A fixture stem is refused when it is not prose or is at least SYSTEM_MIN_LEN characters long.  Plain words (a family word such as
#     a title word, `healthy`, `new`) are not refused in media text, and a plain word already visible in the case context is never refused there.
#   * RECONSTRUCTION is checked: EVERY contiguous run of elements of one ordered source group (a list field, or one kind of list-of-records field such as
#     the declared TOC entries or one item's headings), joined directly and with a space, at any length (third review round, AUDIT-ASTRA-29: two-element
#     pairs alone let a value split into three parts through); and every delivered excerpt range of one spine item is reassembled (overlapping or touching
#     ranges join) so an identifier split across excerpts, or across the default view and an excerpt, is found.  The cost is bounded: each group is joined
#     once, every match of a value in the joined text is mapped back to the smallest run of elements that covers it, and the value's word boundaries are
#     checked at that run's own ends (a longer run cannot loosen them).
# A refusal is a LeakError, recorded as a harness error and kept in every denominator; the legacy check (check_messages) is unchanged.
MEDIA_RULE_2 = 'leakguard-media-2'
_PROSE_RX = re.compile(r"^[^\W\d_]+(?:[ '’][^\W\d_]+)*$")


def is_prose(value):
    return bool(_PROSE_RX.match(' '.join(str(value or '').split())))


def _core(value):
    """The value without its word boundaries (whitespace-normalised for a multi-word value), for the group-run search."""
    words = [re.escape(w) for w in str(value).split()]
    return re.compile(r'\s+'.join(words) if len(words) > 1 else re.escape(str(value)), re.IGNORECASE)


_WORDCH = re.compile(r'[A-Za-z0-9]')


# Fourth review round (AUDIT-ASTRA-30): trying separators one at a time (none, a space) let MIXED separators through ("forbid" + "den" + " identity-42.epub").
# The media check is SEPARATOR-INSENSITIVE: both the hidden value and the media text are reduced to their alphanumeric characters, case-folded (whitespace,
# punctuation and joiners dropped), with a map from each reduced character back to its element and offset; a value matches where its reduced form occurs in
# the reduced text of one contiguous source group or one reassembled excerpt run, and only when the ORIGINAL characters just outside the match are not
# alphanumeric (an element edge counts as outside), so a value inside a longer word ("planted" in "transplanted") is not a match and ordinary prose passes.
# THREAT MODEL: the guard targets ACCIDENTAL leakage of hidden case data through text read from the media.  Hand-built fixtures that split an identifier
# across elements or separators are covered by this normalisation; the guard does not claim to resist arbitrary encodings (spelled-out digits, other
# scripts, ciphers).
def _reduce_value(value):
    return ''.join(ch.casefold() for ch in str(value) if ch.isalnum())


def _reduce(segments):
    """-> (reduced text, [(segment index, offset)] for each reduced character)."""
    chars, where = [], []
    for si, seg in enumerate(segments):
        for oi, ch in enumerate(seg):
            if ch.isalnum():
                for c in ch.casefold():
                    chars.append(c)
                    where.append((si, oi))
    return ''.join(chars), where


def _outside_ok(segments, si, oi, step):
    j = oi + step
    seg = segments[si]
    return j < 0 or j >= len(seg) or not seg[j].isalnum()


def reduced_hits(segments, value):
    """-> [(first segment, last segment)] of every separator-insensitive, boundary-checked occurrence of `value` in the ordered `segments` (the smallest run)."""
    target = _reduce_value(value)
    if not target:
        return []
    text, where = _reduce(segments)
    out, i = [], text.find(target)
    while i >= 0:
        (sa, oa), (sb, ob) = where[i], where[i + len(target) - 1]
        if _outside_ok(segments, sa, oa, -1) and _outside_ok(segments, sb, ob, +1):
            out.append((sa, sb))
        i = text.find(target, i + 1)
    return out


def excerpt_runs(sources):
    """-> [(run label, text)] of each spine item's delivered excerpt ranges, overlapping or touching ranges joined (the text they really form)."""
    spans, out = {}, []
    for s in sources:
        r = s.get('range')
        if r and r['end'] - r['offset'] == len(s['text']):
            spans.setdefault((r.get('spine'), r.get('member')), []).append((r['offset'], r['end'], s['text']))
    for key, parts in spans.items():
        parts.sort()
        run_start, run = None, ''
        for off, end, text in parts:
            if run_start is not None and off <= run_start + len(run):
                keep = run_start + len(run) - off
                run += text[keep:] if keep < len(text) else ''
            else:
                if run:
                    out.append(('excerpts of spine %s from %d' % (key[0], run_start), run))
                run_start, run = off, text
        if run:
            out.append(('excerpts of spine %s from %d' % (key[0], run_start), run))
    return out


def group_runs(sources):
    """-> {(source, group): [element texts in order]} for the run check."""
    out = {}
    for s in sources:
        out.setdefault((s['source'], s['group']), []).append(s['text'])
    return out


def _phrase(text):
    """A case-insensitive matcher for a multi-word value, whitespace-normalised, bounded at word characters at its ends."""
    words = [re.escape(w) for w in str(text).split()]
    return re.compile(r'(?<![A-Za-z0-9])' + r'\s+'.join(words) + r'(?![A-Za-z0-9])', re.IGNORECASE)


def media_values_2(case, extra_paths=()):
    """-> [(kind, value, prose)]: the hidden values refused in media text under MEDIA_RULE_2."""
    cands = []
    cid = str(case.get('id') or '')
    if cid:
        cands.append(('case_id', cid, True))
        stem = re.sub(r'-\d+$', '', cid)
        if stem != cid:
            cands.append(('case_id_stem', stem, not is_prose(stem)))
    fam = case.get('family')
    if fam:
        cands.append(('family', str(fam), not is_prose(fam)))
    truth = case.get('truth') or {}
    if truth.get('class'):
        cands.append(('truth_class', str(truth['class']), not is_prose(truth['class'])))
    ref = truth.get('ref')
    if ref:
        cands.append(('truth_ref', str(ref), not (is_prose(ref) and len(str(ref)) < SYSTEM_MIN_LEN and ' ' not in str(ref).strip())))
    for act in case.get('supported_actions') or []:
        if act in WRITE_ACTIONS:
            cands.append(('supported_action', act, not is_prose(act)))
    prov = str(case.get('provenance') or '').strip()
    if prov:
        cands.append(('provenance', prov, not is_prose(prov)))
        for piece in re.split(r'\s+', prov):
            piece = piece.strip('(),;')
            if piece and not is_prose(piece) and (len(piece) >= 8 or '/' in piece or '@' in piece):
                cands.append(('provenance_piece', piece, True))
    for b in fixture_basenames(case, extra_paths):
        cands.append(('fixture_name', b, True))
        st = Path(b).stem
        if st:
            cands.append(('fixture_stem', st, not is_prose(st) or len(st) >= SYSTEM_MIN_LEN))
    out, seen = [], set()
    for kind, value, refuse in cands:
        if refuse and (kind, value) not in seen:
            seen.add((kind, value))
            out.append((kind, value, is_prose(value)))
    return out


def media_tokens_2(case, extra_paths=(), cores=False):
    """-> [(kind, compiled regex, prose)] for media_values_2 (cores=True: the regex without word boundaries)."""
    return [(k, _core(v) if cores else (_phrase(v) if ' ' in v.strip() else _ci(v)), prose) for k, v, prose in media_values_2(case, extra_paths)]


def reassembled(sources):
    """The texts to check: every source, adjoining elements of one list joined, and each spine item's delivered excerpt ranges reassembled."""
    texts = [s['text'] for s in sources]
    groups = {}
    for s in sources:
        groups.setdefault((s['source'], s['group']), []).append(s)
    for members in groups.values():
        for a, b in zip(members, members[1:]):
            texts.append(a['text'] + b['text'])
            texts.append(a['text'] + ' ' + b['text'])
    spans = {}
    for s in sources:
        r = s.get('range')
        if r and r['end'] - r['offset'] == len(s['text']):
            spans.setdefault((r.get('spine'), r.get('member')), []).append((r['offset'], r['end'], s['text']))
    for parts in spans.values():
        parts.sort()
        run_start, run = None, ''
        for off, end, text in parts:
            if run_start is not None and off <= run_start + len(run):
                keep = run_start + len(run) - off
                run += text[keep:] if keep < len(text) else ''
            else:
                if run:
                    texts.append(run)
                run_start, run = off, text
        if run:
            texts.append(run)
    return texts


def media_findings_2(case, sources, visible='', extra_paths=()):
    """-> {kind: where} of the hidden values found in the delivered media `sources` under MEDIA_RULE_2: separator-insensitive and boundary-checked over each
    ordered source group (where = its source, field group and the smallest run of elements) and over each reassembled excerpt run, plus the word-bounded
    match of the value as written in every text."""
    sources = list(sources)
    units = [('%s %s' % key, els) for key, els in group_runs(sources).items()]
    units += [(label, [text]) for label, text in excerpt_runs(sources)]
    texts = reassembled(sources)
    found = {}
    for (kind, value, prose), (_k, rx, _p) in zip(media_values_2(case, extra_paths), media_tokens_2(case, extra_paths)):
        if kind in found or (prose and rx.search(visible or '')):
            continue
        for label, segments in units:
            runs = reduced_hits(segments, value)
            if runs:
                found[kind] = '%s, elements %d-%d' % (label, runs[0][0], runs[0][1])
                break
        else:
            if any(rx.search(t) for t in texts):
                found[kind] = 'as written'
    return found


def media_hits_2(case, sources, visible='', extra_paths=()):
    """-> the sorted kinds of hidden values found in the delivered media `sources` under MEDIA_RULE_2."""
    return sorted(media_findings_2(case, sources, visible, extra_paths))


def check_messages_media2(case, guard_messages, sources, visible='', extra_paths=()):
    """Guard for a format v3.1-format request under MEDIA_RULE_2.  `guard_messages` are the model-bound messages with each message that carries media text
    replaced by its harness-only shadow (legacy check, unchanged tokens and rules); `sources` are the media strings delivered so far (media check)."""
    toks = forbidden_tokens(case, extra_paths)
    for i, m in enumerate(guard_messages):
        if m.get('role') != 'user':
            continue
        hits = _legacy_hits(m.get('content', ''), toks)
        if hits:
            raise LeakError('forbidden token(s) %s in model-bound message %d' % (hits, i + 1))
    found = media_findings_2(case, sources, visible, extra_paths)
    if found:
        raise LeakError('forbidden value(s) %s in text read from the media (%s; %s)' % (sorted(found), MEDIA_RULE_2,
                                                                                          '; '.join('%s in %s' % (k, found[k]) for k in sorted(found))))
