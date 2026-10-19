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
import re

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
NEEDS_ARR = ('blocklist_and_search', 'remap')
ARR_APPS = ('sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf')
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


def _check(cid, met, detail, basis='computed'):
    return {'id': cid, 'met': bool(met), 'basis': basis, 'detail': detail}


def non_ok_evidence_ids(case, tool_calls):
    ids = {c['id'] for c in tool_calls if c.get('status') in NON_OK}
    ids |= {e['id'] for e in case.get('evidence', []) if e.get('status', 'ok') in NON_OK}
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


def compute(case, decision, tool_calls, forced=False, prompt_version='v1'):
    """-> the `action_audit` dict for one decision."""
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
    bad_ids = non_ok_evidence_ids(case, tool_calls)
    ok_src = _ok_sources(case, tool_calls)
    ok_cited = [s for s in ok_src if s[0] in refs]
    audit_text = ' '.join([str(audit.get('readback') or ''), str(audit.get('verify') or '')] + out['claimed_preconditions']) if audit else ''
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
    checks.append(_check('no_failed_tool_cited', not (set(refs) & bad_ids),
                         'cited refs that are error/timeout/partial/unavailable: %s' % sorted(set(refs) & bad_ids)))
    checks.append(_check('cited_evidence_ok', bool(ok_cited), 'cited results with status ok: %s' % [s[0] for s in ok_cited]))
    if action in NEEDS_ARR:
        checks.append(_check('arr_app_present', arr_app in ARR_APPS, 'context.arr.app=%r' % arr_app))
    if action == 'remap':
        checks.append(_check('target_slot_stated_free', bool(SLOT_FREE_WORDS.search(audit_text)),
                             'the audit states the target slot is free; nothing in the case can confirm it', basis='claim_text'))
    if action == 'rename':
        checks.append(_check('undo_path_stated', bool(UNDO_WORDS.search(audit_text)),
                             'the audit records how to rename back; nothing in the case can confirm it', basis='claim_text'))
    if action == 'convert':
        checks.append(_check('client_profile_present', bool(ctx.get('client_profile')), 'convert needs the stated client in the context'))
        full = [s for s in ok_src if s[1] == 'decode_sample' and (s[2].get('full') or s[2].get('t') == 'full')]
        checks.append(_check('full_decode_ok', bool(full), 'an ok full decode_sample result: %s' % [s[0] for s in full]))
        checks.append(_check('copy_stated', bool(COPY_WORDS.search(audit_text)),
                             'the audit states the original stays untouched; nothing in the case can confirm it', basis='claim_text'))
    if prompt_version == 'v2':
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
