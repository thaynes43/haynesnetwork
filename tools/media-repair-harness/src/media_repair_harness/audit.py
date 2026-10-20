"""Action audit (dev-c1): what a proposed write would need, and which of that the case data actually satisfies.

This harness never executes a write.  Every run record carries an `action_audit`.  For a write action
(blocklist_and_search, remap, rename, convert) it is the audit object of the proposal:

  execution_status   'proposed_not_executed' (always; 'no_write_proposed' for none / escalate)
  executed           false, always
  intent             {class, action, target} as decided
  target             the decided target
  audit              the audit object the model wrote (target, preconditions, readback, verify), verbatim, or null
  preconditions      [{id, met, basis, detail}]  checked by the HARNESS from the case data and the run's own tool calls.
                     basis 'computed' = derived from recorded data; basis 'claim_text' = the model's own audit text states it and
                     nothing in the case can confirm it (so `met` only says the claim was made, never that it is true)
  preconditions_unmet / unmet   any check with met=false, plus 'claim:<what>' for a claim that contradicts the context
  claimed_preconditions   the model's list, verbatim; never taken as satisfied
  readback_plan / verification_plan   from the audit object (what would be read back / checked after a real write)

Nothing here says a repair happened: the words in a record are proposal / intent / not executed.  Everything is computed from
model-visible case data only (context, pre-collected evidence, the run's own tool calls).
"""
import json
import re

from . import protocol as P

WRITE_ACTIONS = ('blocklist_and_search', 'remap', 'rename', 'convert')
EXECUTION_PROPOSED = 'proposed_not_executed'
EXECUTION_NONE = 'no_write_proposed'
# class a write needs positive evidence for.  Only these pairs are consistent; every other write is a flagged intent.
ACTION_CLASSES = {
    'blocklist_and_search': ('identity_mismatch', 'corrupt_file'),
    'remap': ('identity_mismatch',),
    'rename': ('metadata_naming',),
    'convert': ('decoder_incompatible',),
}
# prompt v4 (dev-c4) also sends a wrong episode / item link (a good copy filed under the wrong item) to remap under metadata_naming; v1 to v3 keep the table above
ACTION_CLASSES_V4 = dict(ACTION_CLASSES, remap=('identity_mismatch', 'metadata_naming'))
NEEDS_ARR = ('blocklist_and_search', 'remap')
# lazylibrarian: the estate's book and audiobook manager (CONTRACT-v1.1 section 1); a book write with it has its managing app.
ARR_APPS = ('sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf', 'lazylibrarian')
NON_OK = ('error', 'timeout', 'partial', 'unavailable')
# Wording that states a prerequisite which the case data cannot confirm (claim_text checks)
SLOT_FREE_WORDS = re.compile(r'\b(free|empty|unoccupied|vacant|no file|not linked|nothing linked|unlinked)\b', re.I)
UNDO_WORDS = re.compile(r'\b(original|previous|current name|old name|revert|rename back|restore|undo|back to)\b', re.I)
COPY_WORDS = re.compile(r'\b(copy|new file|separate|isolated|original (is )?(kept|untouched|unchanged)|not (touch|modify|replace))', re.I)


def _norm(text):
    return ' '.join(re.sub(r'[^0-9a-z]+', ' ', str(text).lower()).split())


def _context_texts(case):
    """Model-visible strings a target may legitimately be found in: context title / filename / expected / arr, and the text
    of pre-collected evidence.  (The case's hidden fields are not read.)"""
    ctx = case.get('context') or {}
    texts = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)
        elif v is not None:
            texts.append(str(v))
    for k in ('title', 'filename', 'expected', 'arr', 'question'):
        walk(ctx.get(k))
    return texts


BROAD_SCOPE = re.compile(r'\b(all|every|each|any|entire|whole|everything|library|libraries|indexers?|series|seasons?|collection|catalog|catalogue)\b')
# arr.ids keys that are descriptive text, not identifiers: `format` is 'ebook' / 'audiobook' (CONTRACT-v1.1), so a target that merely contains the word
# 'audiobook' must not read as identified.  Everything else under arr.ids stays an identifier (bookId, movieFileId, episodeId, releaseId, ...).
ID_SKIP_KEYS = ('note', 'format')
ID_MIN_LEN = 4   # an id shorter than this ("1", "12") is a number, not an identifier


def _token_in(needle, hay):
    """needle occurs in hay on token boundaries (both already normalised)."""
    return bool(needle) and (' ' + needle + ' ') in (' ' + hay + ' ')


def item_identifiers(case):
    """-> ([(kind, normalised text)], episode_regex or None): what identifies THIS case's own item in the model-visible context.
    A file name / path, a linked item id, the item's title (for a TV episode only together with its season and episode), nothing broader.
    App names (sonarr), free words and tool / evidence output are never identifiers."""
    ctx = case.get('context') or {}
    exp = ctx.get('expected') or {}
    ids = []
    fn = ctx.get('filename')
    if fn:
        full = _norm(fn)
        ids.append(('filename', full))
        stem = _norm(re.sub(r'\.[A-Za-z0-9]{2,5}$', '', str(fn)))
        if len(stem) >= ID_MIN_LEN:
            ids.append(('filename', stem))
    for k, v in ((ctx.get('arr') or {}).get('ids') or {}).items():
        if k not in ID_SKIP_KEYS and isinstance(v, (str, int)) and not isinstance(v, bool) and len(_norm(v)) >= ID_MIN_LEN:
            ids.append(('id', _norm(v)))
    names = [x for x in (ctx.get('title'), exp.get('title'), exp.get('series')) if isinstance(x, str) and len(_norm(x)) >= ID_MIN_LEN]
    se, ep = exp.get('season'), exp.get('episode')
    ep_rx = None
    if isinstance(se, int) and isinstance(ep, int) and not isinstance(se, bool):
        ep_rx = re.compile(r'\b(s0*{s}e0*{e}|s0*{s} e0*{e}|0*{s}x0*{e}|season 0*{s} episode 0*{e})\b'.format(s=se, e=ep))
    return ids, names, ep_rx


def target_identity(case, target):
    """-> (status, detail).  status: identified | broad | unverifiable | unidentified.
    `identified` only when the target equals or contains a specific identifier of the case's own item (file name, linked item id, or the
    title -- with its season and episode for a TV item) and names no broader scope (all / every / whole / library / series / indexer ...)."""
    fn = (case.get('context') or {}).get('filename')
    raw = str(target or '')
    if fn:
        # a directory prefix that runs straight into the exact file name (/tv/Show/Season 01/<file>) is a location, not a scope
        raw = re.sub(r'(?i)^\s*(?:[a-z]:)?[/\\][^\n]*?[/\\](?=%s)' % re.escape(str(fn)), '', raw)
    t = _norm(raw)
    if not t:
        return 'unidentified', 'no target'
    ids, names, ep_rx = item_identifiers(case)
    hit = []
    rest = t
    for kind, v in ids:
        if _token_in(v, t):
            hit.append(kind)
            rest = ' '.join(rest.replace(v, ' ').split())
    ep_hit = ep_rx.search(t) if ep_rx else None
    for n in sorted({_norm(x) for x in names}, key=len, reverse=True):
        if _token_in(n, t) and (ep_rx is None or ep_hit or ep_rx.search(n)):
            hit.append('title+episode' if ep_rx else 'title')
            rest = ' '.join(rest.replace(n, ' ').split())
    if ep_hit and hit:
        rest = ' '.join(ep_rx.sub(' ', rest).split())
    broad = BROAD_SCOPE.search(rest) if hit else BROAD_SCOPE.search(t)
    if broad:
        return 'broad', 'the target names a broader scope (%r), not one file or item' % broad.group(1)
    if hit:
        return 'identified', 'the target contains the case\'s own %s' % '/'.join(sorted(set(hit)))
    return 'unidentified', 'the target contains no file name, linked item id or title (with season and episode for TV) of this case\'s item'


def target_in_text(case, target, tool_calls=()):
    """The target only appears inside free evidence / tool output (never counts as identifying; reported as unverifiable)."""
    t = _norm(target)
    if len(t) < 8:
        return False
    hay = [_norm(e.get('output') if isinstance(e.get('output'), str) else str(e.get('output'))) for e in case.get('evidence', [])]
    hay += [_norm(c.get('output')) for c in tool_calls if c.get('status') == 'ok']
    return any(t in h for h in hay if h)


def target_in_context(case, target, tool_calls=()):
    """True only when the target identifies the case's own item (see target_identity); never on app names, generic words, broad
    scopes or matches inside free tool output."""
    return target_identity(case, target)[0] == 'identified'


def _check(cid, met, detail, basis='computed'):
    return {'id': cid, 'met': bool(met), 'basis': basis, 'detail': detail}


def usable_as_support(status, output, injected=False, cause=None):
    """May a result be cited as support for a diagnosis?  ok: yes.  partial / timeout / unavailable / an injected failure: no, the
    tool did not run to completion.  error: only when it is a finding about the file itself, i.e. the tool ran and reported
    damage in its structured shape (an exit code or a stage with the tool's own message); a plain failure message is not.
    A live collector record says so itself: `cause: input` (the file is damaged or unreadable) is a finding, `cause: tool` is not."""
    if status == 'ok':
        return True
    if status != 'error' or injected:
        return False
    if cause is not None:
        return cause == 'input'
    try:
        d = json.loads(output) if isinstance(output, str) else output
    except ValueError:
        return False
    return isinstance(d, dict) and ('exit_code' in d or 'stage' in d)


def non_ok_evidence_ids(case, tool_calls):
    ids = {c['id'] for c in tool_calls if c.get('status') in NON_OK}
    ids |= {e['id'] for e in case.get('evidence', []) if e.get('status', 'ok') in NON_OK}
    return ids


def unsupportive_ids(case, tool_calls):
    """Ids of results that must not be cited as support (see usable_as_support)."""
    ids = {c['id'] for c in tool_calls if not usable_as_support(c.get('status'), c.get('output'), c.get('injected', False), (c.get('evidence') or {}).get('cause'))}
    ids |= {e['id'] for e in case.get('evidence', []) if not usable_as_support(e.get('status', 'ok'), e.get('output'))}
    return ids


def unverified_parts(case, tool_calls):
    """Every tool call or piece of pre-collected evidence that did not come back `ok`: a part of the item that was NOT verified.
    Informational (it is not scoring): a healthy / none decision next to a non-empty list is flagged in the record."""
    parts = [{'id': c['id'], 'tool': c.get('tool'), 'status': c['status'], 'source': 'tool_call'} for c in tool_calls if c.get('status') != 'ok']
    parts += [{'id': e['id'], 'tool': e.get('tool'), 'status': e.get('status', 'ok'), 'source': 'evidence'}
              for e in case.get('evidence', []) if e.get('status', 'ok') != 'ok']
    return parts


def decision_flags(decision, parts):
    flags = []
    if decision and decision.get('class') == 'healthy' and parts:
        flags.append('healthy_with_unverified_parts')
    if decision and decision.get('action') == 'none' and parts:
        flags.append('none_with_unverified_parts')
    return flags


def _ok_sources(case, tool_calls):
    """[(id, tool, args, output text)] of results that came back ok."""
    out = [(c['id'], c.get('tool'), c.get('args') or {}, str(c.get('output'))) for c in tool_calls if c.get('status') == 'ok']
    out += [(e['id'], e.get('tool'), e.get('args') or {}, str(e.get('output'))) for e in case.get('evidence', []) if e.get('status', 'ok') == 'ok']
    return out


def _supportive_sources(case, tool_calls):
    return [(c['id'], c.get('tool'), c.get('args') or {}, str(c.get('output'))) for c in tool_calls
            if usable_as_support(c.get('status'), c.get('output'), c.get('injected', False), (c.get('evidence') or {}).get('cause'))] + \
           [(e['id'], e.get('tool'), e.get('args') or {}, str(e.get('output'))) for e in case.get('evidence', [])
            if usable_as_support(e.get('status', 'ok'), e.get('output'))]


def compute(case, decision, tool_calls, forced=False, prompt_version='v1', v4_tables=False):
    """-> the `action_audit` dict for one decision.  v4_tables (or prompt_version 'v4'): the dev-c4 class table for remap and the nested client profile."""
    v4_tables = v4_tables or prompt_version == 'v4'
    action = decision.get('action')
    write = action in WRITE_ACTIONS
    audit = decision.get('audit') if isinstance(decision.get('audit'), dict) else None
    out = {'execution_status': EXECUTION_PROPOSED if write else EXECUTION_NONE, 'executed': False,
           'intent': {'class': decision.get('class'), 'action': action, 'target': decision.get('target')},
           'write_intent': write, 'target': decision.get('target'),
           'note': 'recorded proposal only; this harness never executes a write, and nothing was changed',
           'audit': audit, 'claimed_preconditions': list(audit.get('preconditions') or []) if audit else [],
           'readback_plan': audit.get('readback') if audit else None,
           'verification_plan': audit.get('verify') if audit else None,
           'preconditions': [], 'preconditions_unmet': False, 'unmet': []}
    if not write:
        return out
    ctx = case.get('context') or {}
    arr_app = ((ctx.get('arr') or {}).get('app') or '').lower() or None
    refs = list(decision.get('evidence_refs') or [])
    known = {e['id'] for e in case.get('evidence', [])} | {c['id'] for c in tool_calls}
    bad_ids = unsupportive_ids(case, tool_calls)
    ok_src = _ok_sources(case, tool_calls)
    ok_cited = [s for s in _supportive_sources(case, tool_calls) if s[0] in refs]
    audit_text = ' '.join([str(audit.get('readback') or ''), str(audit.get('verify') or '')] + out['claimed_preconditions']) if audit else ''
    checks = []
    allowed = (ACTION_CLASSES_V4 if v4_tables else ACTION_CLASSES)[action]
    checks.append(_check('class_matches_action', decision.get('class') in allowed,
                         'class %r, %s is for %s' % (decision.get('class'), action, '/'.join(allowed))))
    checks.append(_check('target_named', bool(str(decision.get('target') or '').strip()), 'target=%r' % (decision.get('target'),)))
    tstatus, tdetail = target_identity(case, decision.get('target') or '')
    if tstatus == 'unidentified' and target_in_text(case, decision.get('target') or '', tool_calls):
        tstatus, tdetail = 'unverifiable', 'the target appears only inside free evidence or tool output; nothing in the context confirms it identifies this item'
    checks.append(_check('target_in_context', tstatus == 'identified', tdetail, basis='claim_text' if tstatus == 'unverifiable' else 'computed'))
    cited = [r for r in refs if r in known]
    checks.append(_check('positive_evidence_cited', bool(cited) and not [r for r in refs if r not in known],
                         'cites %s; unknown refs %s' % (cited, [r for r in refs if r not in known])))
    checks.append(_check('no_failed_tool_cited', not (set(refs) & bad_ids),
                         'cited refs that did not run to completion (failure to run, timeout, partial, unavailable): %s' % sorted(set(refs) & bad_ids)))
    checks.append(_check('cited_evidence_supports', bool(ok_cited), 'cited results usable as support (ok, or damage the tool itself reported): %s' % [s[0] for s in ok_cited]))
    if action in NEEDS_ARR:
        checks.append(_check('arr_app_present', arr_app in ARR_APPS, 'context.arr.app=%r' % arr_app))
    if action == 'remap':
        checks.append(_check('target_slot_stated_free', bool(SLOT_FREE_WORDS.search(audit_text)),
                             'the audit states the target slot is free; nothing in the case can confirm it', basis='claim_text'))
    if action == 'rename':
        checks.append(_check('undo_path_stated', bool(UNDO_WORDS.search(audit_text)),
                             'the audit records how to rename back; nothing in the case can confirm it', basis='claim_text'))
    if action == 'convert':
        # the stated client sits at context.client_profile or, in the dev-v1.1 case shape, in context.expected.client_profile (both are model-visible);
        # v1 to v3 keep reading the first only, so their records do not change (dev-c4 reads both)
        profile = ctx.get('client_profile') or ((ctx.get('expected') or {}).get('client_profile') if v4_tables else None)
        checks.append(_check('client_profile_present', bool(profile), 'convert needs the stated client in the context'))
        full = [s for s in ok_src if s[1] == 'decode_sample' and (s[2].get('full') or s[2].get('t') == 'full')]
        checks.append(_check('full_decode_ok', bool(full), 'an ok full decode_sample result: %s' % [s[0] for s in full]))
        checks.append(_check('copy_stated', bool(COPY_WORDS.search(audit_text)),
                             'the audit states the original stays untouched; nothing in the case can confirm it', basis='claim_text'))
    if P.protocol_of(prompt_version) == 'v2':
        checks.append(_check('audit_object_present', audit is not None, 'a v2 write decision must carry the audit object'))
        if audit is not None:
            same = _norm(audit.get('target')) == _norm(decision.get('target'))
            checks.append(_check('audit_target_matches', same, 'audit.target=%r target=%r' % (audit.get('target'), decision.get('target'))))
            checks.append(_check('readback_and_verify_stated', bool(audit.get('readback') and audit.get('verify')),
                                 'the audit names what is read back and how success is checked'))
    unmet = [c['id'] for c in checks if not c['met']]
    # a claimed precondition that names an *arr the context does not have contradicts the context
    claimed = ' '.join(out['claimed_preconditions']).lower()
    for app in ARR_APPS:
        if re.search(r'\b%s\b' % app, claimed) and arr_app != app:
            unmet.append('claim:%s_not_in_context' % app)
    out.update(preconditions=checks, preconditions_unmet=bool(unmet), unmet=unmet)
    if forced:
        out['note'] += '; forced decision'
    return out
