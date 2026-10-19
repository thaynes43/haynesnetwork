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


def check_messages(case, messages, extra_paths=()):
    """Guard for a model request: every harness-authored (user) message must be free of forbidden tokens."""
    toks = forbidden_tokens(case, extra_paths)
    for i, m in enumerate(messages):
        if m.get('role') != 'user':
            continue
        hits = sorted({kind for kind, rx in toks if rx.search(m.get('content', ''))})
        if hits:
            raise LeakError('forbidden token(s) %s in model-bound message %d' % (hits, i + 1))
