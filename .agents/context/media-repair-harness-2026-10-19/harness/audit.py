"""Action audit (checkpoint 2): what a write intent would need, and what the case context actually satisfies.

This harness never executes a write.  For every decision the run record carries an `action_audit`; for a write intent
(blocklist_and_search, remap, rename, convert) it holds

  intent          class, action, target as decided
  write_intent    true
  executed        false, always
  audit           the audit object the model wrote (target, preconditions, readback, verify), verbatim, or null
  claimed_preconditions   the model's own list
  preconditions_checked   preconditions the HARNESS computed from the case context and the model's evidence refs
                          ([{id, ok, detail}]); the model's claims are never taken as satisfied
  preconditions_unmet     true when any required check failed or a claim contradicts the context
  unmet                   ids of the failed checks (and 'claim:<what>' for a contradicting claim)
  readback_plan, verify_plan   from the audit object (what the real system would read back / check after the write)

Everything is computed from model-visible case data only (context, pre-collected evidence, the run's own tool calls).
"""
import re

WRITE_ACTIONS = ('blocklist_and_search', 'remap', 'rename', 'convert')
# class a write needs positive evidence for.  Only these pairs are consistent; every other write is a flagged intent.
ACTION_CLASSES = {
    'blocklist_and_search': ('identity_mismatch', 'corrupt_file'),
    'remap': ('identity_mismatch',),
    'rename': ('metadata_naming',),
    'convert': ('decoder_incompatible',),
}
NEEDS_ARR = ('blocklist_and_search', 'remap')
ARR_APPS = ('sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf')
NON_OK = ('error', 'timeout', 'partial', 'unavailable')


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


def target_in_context(case, target, tool_calls=()):
    """True when the target string is, or contains, something the model could see: a context value, an evidence item, or a
    tool result.  Short or generic targets (under 4 characters after normalisation) never count."""
    t = _norm(target)
    if len(t) < 4:
        return False
    hay = [_norm(x) for x in _context_texts(case)]
    hay += [_norm(e.get('output') if isinstance(e.get('output'), str) else str(e.get('output'))) for e in case.get('evidence', [])]
    hay += [_norm(c.get('output')) for c in tool_calls if c.get('status') == 'ok']
    for h in hay:
        if not h:
            continue
        if t in h or (len(h) >= 4 and h in t):
            return True
    return False


def _check(cid, ok, detail):
    return {'id': cid, 'ok': bool(ok), 'detail': detail}


def non_ok_evidence_ids(case, tool_calls):
    ids = {c['id'] for c in tool_calls if c.get('status') in NON_OK}
    ids |= {e['id'] for e in case.get('evidence', []) if e.get('status', 'ok') in NON_OK}
    return ids


def compute(case, decision, tool_calls, forced=False, prompt_version='v1'):
    """-> the `action_audit` dict for one decision."""
    action = decision.get('action')
    audit = decision.get('audit') if isinstance(decision.get('audit'), dict) else None
    out = {'intent': {'class': decision.get('class'), 'action': action, 'target': decision.get('target')},
           'write_intent': action in WRITE_ACTIONS, 'executed': False,
           'note': 'recorded intent only; this harness never executes writes',
           'audit': audit, 'claimed_preconditions': list(audit.get('preconditions') or []) if audit else [],
           'readback_plan': audit.get('readback') if audit else None, 'verify_plan': audit.get('verify') if audit else None,
           'preconditions_checked': [], 'preconditions_unmet': False, 'unmet': []}
    if action not in WRITE_ACTIONS:
        return out
    ctx = case.get('context') or {}
    arr_app = ((ctx.get('arr') or {}).get('app') or '').lower() or None
    refs = list(decision.get('evidence_refs') or [])
    known = {e['id'] for e in case.get('evidence', [])} | {c['id'] for c in tool_calls}
    bad_ids = non_ok_evidence_ids(case, tool_calls)
    checks = []
    allowed = ACTION_CLASSES[action]
    checks.append(_check('class_matches_action', decision.get('class') in allowed,
                         'class %r, %s is for %s' % (decision.get('class'), action, '/'.join(allowed))))
    checks.append(_check('target_named', bool(str(decision.get('target') or '').strip()), 'target=%r' % (decision.get('target'),)))
    checks.append(_check('target_in_context', target_in_context(case, decision.get('target') or '', tool_calls),
                         'the target must be found in the context, the evidence or a tool result'))
    cited = [r for r in refs if r in known]
    checks.append(_check('positive_evidence_cited', bool(cited) and not [r for r in refs if r not in known],
                         'cites %s; unknown refs %s' % (cited, [r for r in refs if r not in known])))
    checks.append(_check('no_failed_tool_cited', not (set(refs) & bad_ids), 'cited refs that are error/timeout/partial/unavailable: %s' % sorted(set(refs) & bad_ids)))
    if action in NEEDS_ARR:
        checks.append(_check('arr_app_present', arr_app in ('sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf'), 'context.arr.app=%r' % arr_app))
    if action == 'convert':
        checks.append(_check('client_profile_present', bool(ctx.get('client_profile')), 'convert needs the stated client in the context'))
    if prompt_version == 'v2':
        checks.append(_check('audit_object_present', audit is not None, 'a v2 write decision must carry the audit object'))
        if audit is not None:
            same = _norm(audit.get('target')) == _norm(decision.get('target'))
            checks.append(_check('audit_target_matches', same, 'audit.target=%r target=%r' % (audit.get('target'), decision.get('target'))))
    unmet = [c['id'] for c in checks if not c['ok']]
    # a claimed precondition that names an *arr the context does not have contradicts the context
    claimed = ' '.join(out['claimed_preconditions']).lower()
    for app in ARR_APPS:
        if re.search(r'\b%s\b' % app, claimed) and arr_app != app:
            unmet.append('claim:%s_not_in_context' % app)
    out.update(preconditions_checked=checks, preconditions_unmet=bool(unmet), unmet=unmet)
    if forced:
        out['note'] += '; forced decision'
    return out
