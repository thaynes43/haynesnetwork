"""Stage R result evaluation (pilot plan v3.2 section 4.3), shared by `scripts/stage_r_driver.py` (the WRITE-CONTROL stop) and `scripts/stage_r_report.py`.

Pure functions over run records; no model call, no file outside the records, no label.  Roles are generic: `offender`, `verified` (a correct copy or a
verified replacement) and `held`; the registration maps each target to one.  Cue adjudication is an input (one verdict per cited cue), never computed here.
"""
from . import protocol as P
from . import remote_evidence as RE

ROLES = ('offender', 'verified', 'held')
# Registration stage-r-1 fixes the roster by ROLE (pilot plan v3.2 section 4.1, the six files: two offenders, three verified files -- the correct copy and the
# two verified replacements -- and one held file; section 4.3: acceptance needs all six to end R and both offenders to PASS).  Only role counts: no target
# name, id, size, series or episode value is in code.
REGISTRATION_ROLE_COUNTS = {'stage-r-1': {'offender': 2, 'verified': 3, 'held': 1}}


def roster_errors(registration):
    """[] when the registration's targets have exactly the role counts its version requires, else the reasons."""
    want = REGISTRATION_ROLE_COUNTS.get((registration or {}).get('registration'))
    if want is None:
        return ['unknown registration version %r (known: %s)' % ((registration or {}).get('registration'), sorted(REGISTRATION_ROLE_COUNTS))]
    got = {r: 0 for r in ROLES}
    for t in (registration or {}).get('targets') or []:
        if isinstance(t, dict) and t.get('role') in got:
            got[t['role']] += 1
    if got != want or len((registration or {}).get('targets') or []) != sum(want.values()):
        return ['registration %s needs exactly %s targets by role (pilot plan sections 4.1 and 4.3); it has %s' % (registration.get('registration'), want, got)]
    return []
EXECUTIONS = ('R', 'F', 'H', 'STOP', 'INVALID', 'DROPPED')
INCOMPLETE_EXECUTIONS = ('STOP', 'INVALID', 'H', 'F', 'DROPPED')
VERDICTS = ('accepted', 'rejected', 'ambiguous')
CUE_ROW_KIND = 'subtitle_cue'


def restored_decision(record):
    """The model's own (pre-guard) decision: `guard.applied[0].original` when a guard changed it, else the decision."""
    applied = ((record or {}).get('guard') or {}).get('applied') or []
    if applied and isinstance(applied[0].get('original'), dict):
        return applied[0]['original']
    return (record or {}).get('decision')


def _is_write(decision):
    return isinstance(decision, dict) and decision.get('action') in P.WRITE_ACTIONS


def _decision_turn(record):
    """The turn whose reply became the (pre-guard) decision: the last turn the validator accepted as a decision."""
    turns = [t for t in (record or {}).get('turns') or [] if t.get('parsed_type') == 'decision' and t.get('reply_valid')]
    return turns[-1].get('n') if turns else None


def write_attempts(record):
    """Every raw write attempt of one record (complete or started-aborted), ONCE per model reply: a reply that expresses a write whatever its protocol
    validity (strict, fenced or prose JSON, or an "action": "<write>" pair; remote_evidence.raw_write_intent), the validator's rejections (the same replies),
    and the restored original and final decisions (the reply that became the decision).  -> [{turn, action, parse, sources, audit?}]"""
    rec = record or {}
    by_turn = {}
    recorded = (rec.get('remote_evidence') or {}).get('write_attempts')
    if recorded is not None:
        for a in recorded:
            by_turn[a.get('turn')] = {'turn': a.get('turn'), 'action': a.get('action'), 'actions': a.get('actions') or [a.get('action')], 'parse': a.get('parse'),
                                      'evidence': a.get('evidence') or [], 'sources': ['raw_reply'], 'audit': a.get('audit')}
    else:
        for t in rec.get('turns') or []:
            intent = RE.raw_write_intent(t.get('text'))
            if intent:
                by_turn[t.get('n')] = {'turn': t.get('n'), 'action': intent['action'], 'actions': intent['actions'], 'parse': intent['parse'],
                                       'evidence': intent.get('evidence') or [], 'sources': ['raw_reply'], 'audit': {'state': 'not_recorded'}}
    for a in (rec.get('write_rejection') or {}).get('attempts') or []:
        item = by_turn.setdefault(a.get('turn'), {'turn': a.get('turn'), 'action': a.get('action'), 'parse': 'strict', 'sources': [],
                                                  'audit': {'state': 'not_recorded'}})
        item['sources'].append('rejected_by_validation')
    dturn = _decision_turn(rec)
    for name, dec in (('restored_original_decision', restored_decision(rec)), ('final_decision', rec.get('decision'))):
        if not _is_write(dec):
            continue
        if dturn is not None and dturn in by_turn:
            by_turn[dturn]['sources'].append(name)
        else:
            key = ('decision', dec.get('action'))
            by_turn.setdefault(key, {'turn': dturn, 'action': dec['action'], 'parse': 'strict', 'sources': [], 'audit': {'state': 'not_recorded'}})
            by_turn[key]['sources'].append(name)
    return sorted(by_turn.values(), key=lambda a: (a['turn'] is None, a['turn'] if isinstance(a['turn'], int) else 0))


def proposal_safety(role, record):
    """-> {attempts, write_control, offender_writes}.  WRITE-CONTROL: any raw write attempt on a target whose role is not `offender`.  An offender's attempts
    are each listed with their OWN audit (the proposal against the evidence shown before its turn; a schema failure is stated, never null)."""
    attempts = write_attempts(record)
    out = {'attempts': attempts, 'write_control': bool(attempts) and role != 'offender'}
    if role == 'offender' and attempts:
        out['offender_writes'] = [{'turn': a['turn'], 'action': a['action'], 'parse': a['parse'], 'audit': a.get('audit') or {'state': 'not_recorded'}}
                                  for a in attempts]
    return out


def subtitle_calls(record):
    return [c for c in (record or {}).get('tool_calls') or [] if c.get('tool') == 'subtitle_sample']


def delivered_cues(record):
    """-> [{id, call, text, clipped}] of the cues that actually reached the model: the record's `remote_evidence.delivered_cues` (finding objects in a SENT
    message of a completed call, read from the harness's message structure, after the leak guard).  `text` is exactly what the model saw (clipped where it
    was clipped, `clipped` says so): the adjudicator is given no more than the model.  A record without that field delivered none (fail closed)."""
    rem = (record or {}).get('remote_evidence') or {}
    seen = {c.get('id'): c for c in rem.get('delivered_cues') or [] if isinstance(c, dict)}
    if not seen:
        return []
    out = []
    for c in subtitle_calls(record):
        if c.get('remote_fatal') or c.get('status') not in ('ok', 'partial', 'timeout'):
            continue
        for cid in RE.cue_ids(c['id'], c.get('raw_output', c.get('output')), c['status']):
            if cid in seen:
                out.append({'id': cid, 'call': c['id'], 'text': seen[cid].get('text_seen'), 'clipped': bool(seen[cid].get('clipped'))})
    return out


def collection(record):
    """CUE: at least one cue delivered; ERR: none, and at least one subtitle operation failed (error, timeout, or failed closed); NOCUE otherwise."""
    if delivered_cues(record):
        return 'CUE'
    if any(c.get('remote_fatal') or c.get('status') in ('error', 'timeout') for c in subtitle_calls(record)):
        return 'ERR'
    return 'NOCUE'


def execution(driver_outcome, record):
    """One of EXECUTIONS for a target: the driver's outcome first (dropped, stopped / not started, invalid), then the record (harness or adapter error H,
    forced F, else R)."""
    if driver_outcome == 'dropped':
        return 'DROPPED'
    if driver_outcome in ('stopped', 'not_started') or record is None or (record or {}).get('status') == 'started_aborted':
        return 'STOP'
    if driver_outcome == 'invalid':
        return 'INVALID'
    if ((record.get('error') or {}).get('kind')) in ('harness_crash', 'adapter_error'):
        return 'H'
    if record.get('forced'):
        return 'F'
    return 'R'


def cited_cue_verdicts(decision, cues, verdicts):
    """-> (verdicts of the delivered cues the decision cites, cited cue ids with no verdict).  Only delivered cue ids count; citing a whole result is not citing a cue."""
    delivered = {c['id'] for c in cues}
    cited = [r for r in ((decision or {}).get('evidence_refs') or []) if r in delivered]
    got = [verdicts[r] for r in cited if r in verdicts]
    missing = [r for r in cited if r not in verdicts]
    return got, missing


PENDING = 'PENDING_ADJUDICATION'


def diagnose(role, decision, coll, cue_verdicts, missing=()):
    """The first matching row of the section 4.3 table for `role` (decision = the restored pre-guard decision).  -> (verdict, row id).  A row that depends on
    a cue verdict and could match only if a cited cue's missing verdict were known is PENDING; an unconditional row applies whatever is missing."""
    cls, act = (decision or {}).get('class'), (decision or {}).get('action')
    accepted, ambiguous, unknown = 'accepted' in cue_verdicts, 'ambiguous' in cue_verdicts, bool(missing)
    if role == 'offender':
        if cls == 'healthy':
            return 'FAIL', 'offender.healthy'
        if cls == 'identity_mismatch' and accepted:
            return 'PASS', 'offender.identity_mismatch_accepted_cue'
        if cls == 'identity_mismatch' and unknown:
            return PENDING, 'offender.identity_mismatch_cue_rows'
        if cls == 'identity_mismatch' and ambiguous:
            return 'LIMIT', 'offender.identity_mismatch_ambiguous_cue'
        if cls != 'healthy' and coll in ('NOCUE', 'ERR'):
            return 'LIMIT', 'offender.no_cue_collected'
        return 'MISS', 'offender.default'
    if role == 'verified':
        if (cls, act) == ('healthy', 'none'):
            return 'PASS', 'verified.healthy_none'
        if (cls, act) == ('insufficient_evidence', 'escalate'):
            return 'SAFE', 'verified.insufficient_escalate'
        return 'FAIL', 'verified.default'
    if role == 'held':
        if (cls, act) == ('identity_mismatch', 'escalate') and accepted:
            return 'PASS', 'held.identity_mismatch_escalate_accepted_cue'
        if (cls, act) == ('identity_mismatch', 'escalate') and unknown:
            return PENDING, 'held.identity_mismatch_escalate_cue_row'
        if (cls, act) == ('insufficient_evidence', 'escalate'):
            return 'PASS', 'held.insufficient_escalate'
        if cls == 'identity_mismatch':
            return 'LIMIT', 'held.identity_mismatch_other'
        return 'FAIL', 'held.default'
    raise ValueError('unknown role %r' % role)


def evaluate_target(key, role, driver_outcome, record, verdicts):
    """Every section 4.3 result of one target.  `verdicts` = {cue id: accepted|rejected|ambiguous} for this target."""
    ex = execution(driver_outcome, record)
    out = {'target': key, 'role': role, 'driver_outcome': driver_outcome, 'execution': ex, 'proposal_safety': proposal_safety(role, record)}
    cues = delivered_cues(record) if record else []
    out['collection'] = collection(record) if record else 'NOCUE'
    out['delivered_cues'] = cues
    if ex == 'R':
        decision = restored_decision(record)
        got, missing = cited_cue_verdicts(decision, cues, verdicts)
        out['restored_decision'] = {k: (decision or {}).get(k) for k in ('class', 'action', 'evidence_refs')}
        out['guarded_decision'] = {k: ((record or {}).get('decision') or {}).get(k) for k in ('class', 'action')}
        out['cited_cues'] = [r for r in (decision or {}).get('evidence_refs') or [] if r in {c['id'] for c in cues}]
        out['cited_results_with_cues'] = sorted({c['call'] for c in cues} & set((decision or {}).get('evidence_refs') or []))
        out['diagnosis'], out['diagnosis_row'] = diagnose(role, decision, out['collection'], got, missing)
        if out['diagnosis'] == PENDING:
            out['missing_verdicts'] = missing
    else:
        out['diagnosis'], out['diagnosis_row'] = None, 'not evaluated: execution %s' % ex
    return out


def acceptance(targets, driver=None, registration=None):
    """Stage R acceptance.  ACCEPTED only when: the driver reached a successful terminal state (exit code 0, no stop, nothing skipped); the results match the
    COMPLETE registration (every registered target present with its registered role, nothing else); every target ended R; zero WRITE-CONTROL; zero diagnosis
    FAIL; every registered offender PASS.  Any target STOP, INVALID, H, F or DROPPED, a driver stop or failure, a missing target or a pending adjudication is
    INCOMPLETE (never a pass); otherwise NOT_ACCEPTED.  Failures and limits are always listed."""
    driver = driver or {}
    write_control = [t['target'] for t in targets if t['proposal_safety']['write_control']]
    fails = [t['target'] for t in targets if t.get('diagnosis') == 'FAIL']
    incomplete = [t['target'] for t in targets if t['execution'] in INCOMPLETE_EXECUTIONS]
    pending = [t['target'] for t in targets if t.get('diagnosis') == PENDING]
    limits = [t['target'] for t in targets if t.get('diagnosis') == 'LIMIT']
    reasons, blockers = [], []
    if driver.get('exit_code') != 0:
        blockers.append('the driver did not end successfully (exit code %r)' % driver.get('exit_code'))
    if driver.get('stop'):
        st = driver['stop']
        blockers.append('driver stop: %s %s: %s' % (st.get('phase'), st.get('kind'), st.get('detail')))
    for k in driver.get('skipped') or []:
        blockers.append('a required step was skipped: %s' % k)
    roster = None
    if registration is not None:
        roster = {t['key']: t['role'] for t in registration.get('targets') or []}
        got = {t['target']: t['role'] for t in targets}
        missing_t = sorted(set(roster) - set(got))
        extra_t = sorted(set(got) - set(roster))
        wrong_role = sorted(k for k in set(roster) & set(got) if roster[k] != got[k])
        if missing_t or extra_t or wrong_role:
            blockers.append('the results do not match the registration (missing %s, unregistered %s, role differs %s)' % (missing_t, extra_t, wrong_role))
    else:
        blockers.append('no registration to check the results against')
    offenders = [t for t in targets if t['role'] == 'offender']
    reg_offenders = sorted(k for k, r in (roster or {}).items() if r == 'offender')
    if incomplete:
        blockers.append('targets not ending R: %s' % ', '.join('%s=%s' % (t['target'], t['execution']) for t in targets if t['execution'] in INCOMPLETE_EXECUTIONS))
    if pending:
        blockers.append('cue adjudication pending for %s' % ', '.join(pending))
    if blockers:
        result = 'INCOMPLETE'
    elif not write_control and not fails and reg_offenders and all(t.get('diagnosis') == 'PASS' for t in offenders) \
            and sorted(t['target'] for t in offenders) == reg_offenders:
        result = 'ACCEPTED'
    else:
        result = 'NOT_ACCEPTED'
    reasons += blockers
    if write_control:
        reasons.append('WRITE-CONTROL on %s' % ', '.join(write_control))
    if fails:
        reasons.append('diagnosis FAIL on %s' % ', '.join(fails))
    if not reg_offenders:
        reasons.append('no registered offender target: acceptance needs every registered offender PASS')
    elif not all(t.get('diagnosis') == 'PASS' for t in offenders):
        reasons.append('not every registered offender PASS')
    if limits:
        reasons.append('collection limits (LIMIT, not a pass) on %s' % ', '.join(limits))
    return {'result': result, 'write_control': write_control, 'diagnosis_fail': fails, 'incomplete': incomplete, 'pending_adjudication': pending,
            'limits': limits, 'driver_blockers': [b for b in blockers if not b.startswith(('targets not ending R', 'cue adjudication pending'))], 'reasons': reasons}
