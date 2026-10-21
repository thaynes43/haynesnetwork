"""Deterministic decision guards (dev-c4, opt-in `--guards v1`, default off).

Post-decision checks that look at the model's FINAL decision and at what the model could see (the case's own evidence and the run's tool
results), never at the model's wording and never at a case id, title or label.  They are conservative: a guard can only turn a decision into
`insufficient_evidence` / `escalate`, it never creates a write or a diagnosis.  The model does not see them (they run after the last turn).
The model's original decision is kept in the run record's `guard` field:

  guard = {version, applied: [{rule, original: <the model's full decision>, reason}], final_changed}

`guard` is present only when guards are on (`applied` is empty when none fired); with guards off the record has no such key and is byte-identical
to a dev-c3-shaped record.  The record's `decision`, `action_audit`, `decision_flags`, `bad_evidence_refs`, `refs_to_*` and `evidence.gaps_cited`
describe the FINAL decision; `forced` keeps its meaning (the harness forced the decision after a failed repair) and is not set by a guard.

Rules
  G-healthy  A `healthy` / `none` decision when the model-visible evidence holds no integrity check that ran with status `ok`.  Integrity checks
             are by evidence type: a probe (ffprobe), a decode or sampled decode (decode_sample, audio_sample), a package or archive check
             (epub_inspect) and an audiobook stream check (audiobook_inspect).  Identity and title records (arr_lookup, ocr, prior_record, a
             frame handle) are not integrity checks.  A result that failed, timed out, was partial or unavailable, or was an injected failure, does not
             count as ok.  It never fires when at least one ok integrity check exists, whatever else is missing: that is a healthy control with
             partial but representative checks (evaluator ruling C2).  It covers both case-provided evidence and the run's tool results.
  G-write    A write action (blocklist_and_search, remap, rename, convert) when (a) a precondition the audit COMPUTES from the case data is unmet
             (`action_audit.preconditions` with basis `computed`, except the text-matching `target_in_context`; a precondition that only rests on the
             model's claim text is never acted on), or
             (b) no evidence_refs entry points to a result usable as support for a defect: an `ok` result of a tool or of case-provided evidence, or
             damage a tool that ran reported about the file itself.  (b) is the audit's `cited_evidence_supports` check; whether the cited text really
             shows a defect is not decided here, only that the model cited something that ran.

Both rules are small on purpose.  The `reason` of the final decision names the guard.

Guards v3 (W18, `--guards v3`, any prompt; v1 and v2 are unchanged)
  G-healthy v3  Examines ALL shown evidence (the case's own and the run's tool results) with the typed layer of `evidence_v2`: a KNOWN integrity defect
                (decoder errors, damaged container or package, a collector's input failure) contradicts `healthy` / `none` even next to clean results, in any
                order; an `ok` result that reports a defect is not clean; an unknown field is neither clean nor damaged, and without at least one clean
                integrity result there is nothing to support healthy.  It never infers whole-file health from a clean sample and it can only abstain.  The reason
                names the finding kind, its location and the observation id; the model's decision stays in `guard.applied[].original`.
  G-write v3    Exactly the v2 relaxations.

Contract v3 (dev-c6, `--evidence-format v3 --prompt v6`): guards v3 apply UNCHANGED to a decision-v3 decision.  G-healthy v3 reads the class, the action and
the shown observations; G-write reads the class, the action, evidence_refs and the context (its `target_named` check is met by the decision-v3 target object
the validator requires, and the audit-object checks belong to turn protocol v2 only), so contract v3 needs no new guard version.  The only difference is the
shape of the escalate a guard writes: under turn protocol v3 it carries no target (none and escalate have neither source nor target in decision-v3).  A v3
record's derived fields use audit v3 (evidence_v3.action_audit).
"""
import copy

from . import audit as AU
from . import evidence_v2 as EV2
from . import gaps as GP
from . import protocol as P
from . import tools as T

GUARD_VERSION = 'v1'          # the version a bare `--guards v1` means and the one measured in runs/dev-c4; v1 behaviour never changes
GUARD_VERSIONS = ('v1', 'v2', 'v3')
RULE_HEALTHY = 'G-healthy'
RULE_WRITE = 'G-write'
# computed audit checks the guard does not act on: `target_in_context` matches the model's free-text target against the case's identifiers and calls a
# target "broad" when it also names a series or an id of a wider scope, so a correct, specific target written in another form fails it (seen in the
# offline what-if).  It stays in the record's action_audit; it just is not a reason to overrule a decision.
TEXT_MATCH_CHECKS = ('target_in_context',)
# evidence types that are integrity checks.  frame_sample (a handle to a recorded frame), ocr (on-screen text), arr_lookup and prior_record
# (catalog / identity records) are not.
INTEGRITY_TOOLS = ('ffprobe', 'decode_sample', 'audio_sample', 'epub_inspect', 'audiobook_inspect')


def sources(evidence_shown, tool_calls):
    """[{id, tool, status, source}] for every result the model could see: case-provided evidence as shown, then the run's tool calls.  Only the status the
    model saw is read (an injected failure comes back as error, timeout or partial, so it never counts as ok); the harness-side `injected` flag is not."""
    out = [{'id': e.get('id'), 'tool': e.get('tool'), 'status': e.get('status', 'ok'), 'source': 'evidence'} for e in evidence_shown or []]
    out += [{'id': c.get('id'), 'tool': c.get('tool'), 'status': c.get('status'), 'source': 'tool_call'} for c in tool_calls or []]
    return out


def ok_integrity_checks(evidence_shown, tool_calls):
    return [s for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS and s['status'] == 'ok']


def guard_escalation(rule, detail):
    d = P.forced_decision('')   # same shape as every escalate decision the harness writes
    d['reason'] = ('guard %s (not the model): %s' % (rule, detail))[:400]
    return d


def check_healthy(decision, evidence_shown, tool_calls):
    """-> reason string when G-healthy fires, else None."""
    if decision.get('class') != 'healthy' or decision.get('action') != 'none':
        return None
    if ok_integrity_checks(evidence_shown, tool_calls):
        return None
    seen = sorted({'%s:%s' % (s['tool'], s['status']) for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS})
    return 'healthy/none with no integrity check (probe, decode, package or audiobook check) that ran with status ok in the evidence%s' % (
        '; integrity results seen: ' + ', '.join(seen) if seen else '; none was offered or run')


def shown_observations(evidence_shown, tool_calls):
    """Observations (evidence_v2 narrow interface) for every result the model could see: case evidence as shown, then the run's tool calls.  Only the
    status, the text and the actual backend are read (an injected failure comes back as the error, timeout or partial result the model saw)."""
    obs = [EV2.make_observation(e.get('id'), e.get('tool'), e.get('args'), e.get('status', 'ok'), e.get('output'), None, 'case') for e in evidence_shown or []]
    for c in tool_calls or []:
        if c.get('continuation'):    # a page fetch is not an observation
            continue
        obs.append(EV2.make_observation(c.get('id'), c.get('tool'), EV2.safe_args(c.get('args')), c.get('status'), c.get('raw_output', c.get('output')), c.get('mode'), 'tool',
                                        bool(c.get('collector_truncated'))))
    return obs


def check_healthy_v3(decision, evidence_shown, tool_calls):
    """Guards v3 G-healthy: examines ALL shown initial evidence and tool findings.  A known integrity defect contradicts healthy even next to clean
    observations (it is not outvoted); an `ok` result that reports a defect does not count as clean; unknown fields are neither clean nor damaged; and
    without at least one clean integrity result nothing supports healthy.  Whole-file health is never inferred from a clean sample: this guard only
    abstains.  -> reason string when it fires, else None."""
    if decision.get('class') != 'healthy' or decision.get('action') != 'none':
        return None
    state = EV2.integrity_findings(shown_observations(evidence_shown, tool_calls))
    if state['damaged']:
        oid, f = state['damaged'][0]
        where = f.get('location') or {}
        loc = ', '.join('%s %s' % (k, v) for k, v in where.items() if v is not None)
        return 'healthy/none while an integrity result reports a defect (%s in %s%s); a clean observation does not outvote it' % (f['kind'], oid, (' at ' + loc) if loc else '')
    if state['clean']:
        return None
    seen = sorted({'%s:%s' % (s['tool'], s['status']) for s in sources(evidence_shown, tool_calls) if s['tool'] in INTEGRITY_TOOLS})
    return 'healthy/none with no clean integrity result (probe, decode, package or audiobook check) in the evidence%s' % (
        '; integrity results seen: ' + ', '.join(seen) if seen else '; none was offered or run')


# guards v2 (offline-measured relaxations of G-write; v1 stays exactly as measured):
#   full_decode_ok     convert works on an isolated copy and the contract does not require a clean full decode, so it is not a reason to overrule;
#   no_failed_tool_cited  citing a failed tool next to valid support (cited_evidence_supports is met) is not a reason to overrule.
V2_IGNORED = ('full_decode_ok',)


def check_write(case, decision, tool_calls, prompt_version, forced=False, version='v1', shown=None):
    """-> reason string when G-write fires, else None.  Only checks the audit computes from the case data count (basis `computed`).  Guards v3 reads the audit-v2 support
    (an error result supports a write only through a typed positive damage finding, never an execution failure); v1 and v2 keep the shape-based support."""
    if decision.get('action') not in P.WRITE_ACTIONS:
        return None
    audit = AU.compute(case, decision, tool_calls, forced=forced, prompt_version=prompt_version, v4_tables=True,        # the guard reads the dev-c4 tables whatever prompt ran
                       audit_version='v2' if version == 'v3' else 'v1', shown=shown if version == 'v3' else None)
    unmet = [c['id'] for c in audit['preconditions'] if c.get('basis') == 'computed' and not c.get('met') and c['id'] not in TEXT_MATCH_CHECKS]
    if version != 'v1':   # v3 keeps the v2 G-write relaxations (the contract has no clean-full-decode prerequisite for an isolated copy)
        unmet = [i for i in unmet if i not in V2_IGNORED and not (i == 'no_failed_tool_cited' and 'cited_evidence_supports' not in unmet)]
    if not unmet:
        return None
    return '%s proposed with unmet computed precondition(s): %s' % (decision.get('action'), ', '.join(unmet))


def record_resolver(record, evidence_shown):
    """The resolver for a run record: a format-v2 record cites finding ids (`t1.f1`) that this run emitted, recomputed here from the same observations by the same
    typed layer; any other record resolves nothing (references are never rewritten)."""
    if not (record or {}).get('evidence_format'):
        return lambda refs: list(refs or [])
    obs = shown_observations(evidence_shown, (record or {}).get('tool_calls'))
    known = [o['id'] for o in obs]
    return EV2.reference_resolver(known, EV2.emitted_ids(EV2.analyze(obs, {})), EV2.page_origin_map((record or {}).get('tool_calls')))


def apply(case, decision, tool_calls, evidence_shown, prompt_version, forced=False, version=GUARD_VERSION, resolve=None):
    """-> (final_decision, guard_record).  The input decision is never modified.  `resolve` (the one reference resolver) normalises the references the checks read;
    the original decision, with its references as written, is what the record keeps."""
    if version not in GUARD_VERSIONS:
        raise ValueError('unknown guard version %r (known: %s)' % (version, ', '.join(GUARD_VERSIONS)))
    original = decision
    if resolve is not None and decision:
        decision = dict(decision, evidence_refs=resolve(decision.get('evidence_refs')))
    applied = []
    reason = check_healthy_v3(decision, evidence_shown, tool_calls) if version == 'v3' else check_healthy(decision, evidence_shown, tool_calls)
    rule = RULE_HEALTHY
    if reason is None:
        reason = check_write(case, decision, tool_calls, prompt_version, forced, version, evidence_shown)
        rule = RULE_WRITE
    if reason is not None:
        applied.append({'rule': rule, 'original': copy.deepcopy(original), 'reason': reason})
        final = guard_escalation(rule, reason)
        if _protocol(prompt_version) == 'v3':
            final.pop('target', None)        # decision-v3: an escalate has no target
    else:
        final = original
    return final, {'version': version, 'applied': applied, 'final_changed': bool(applied)}


def _protocol(prompt_version):
    try:
        return P.protocol_of(prompt_version)
    except ValueError:
        return None


def derived_fields(case, decision, tool_calls, evidence_shown, evidence_mode, prompt_version, forced, outcome_step, resolve=None, v2=False, v3=None):
    """Record fields that are computed from the decision (run_case computes the same ones); used when a guard replaced it.  For a format-v2 record the references go
    through the same resolver and the audit is audit v2, as in the run; for a format-v3 record (`v3` = its recorded capabilities) the audit is audit v3."""
    ev_ids = {e['id'] for e in evidence_shown}
    call_ids = {c['id'] for c in tool_calls}
    refs = resolve(decision.get('evidence_refs', [])) if resolve else decision.get('evidence_refs', [])
    if v3 is not None:
        from . import evidence_v3 as EV3
        view = P.case_view(case, [])
        action_audit = EV3.action_audit(dict(decision, evidence_refs=refs), evidence_shown, tool_calls, view['context'], view['media_type'], v3, forced=forced)
    elif v2:
        action_audit = AU.compute(case, dict(decision, evidence_refs=refs), tool_calls, forced=forced, prompt_version=prompt_version, audit_version='v2', shown=evidence_shown)
    else:
        action_audit = AU.compute(case, decision, tool_calls, forced=forced, prompt_version=prompt_version)
    action_audit['outcome_step'] = outcome_step
    return {
        'decision_flags': AU.decision_flags(decision, AU.unverified_parts(case, tool_calls)),
        'bad_evidence_refs': sorted(r for r in refs if r not in ev_ids and r not in call_ids),
        'refs_to_failed_tools': sorted(set(refs) & {c['id'] for c in tool_calls if c['status'] in ('error', 'timeout') and c.get('injected')}),
        'refs_to_non_ok_tools': sorted(set(refs) & AU.non_ok_evidence_ids(case, tool_calls)),
        'action_audit': action_audit,
        'evidence': GP.evidence_summary(case, tool_calls, evidence_mode, decision, live_kinds=T.LIVE_KINDS),
    }


def _v3_caps(record):
    """The recorded capability advertisement of a format-v3 record (what its audit v3 reads), else None."""
    ef = (record or {}).get('evidence_format')
    return list(ef.get('capabilities') or []) if isinstance(ef, dict) and ef.get('version') == 'v3' else None


def apply_to_record(record, case, evidence_shown, version=GUARD_VERSION):
    """Offline: a COPY of a run record with the guards applied.  Always carries `guard`; when a guard fires, the decision and the fields
    derived from it are replaced and the model's original stays in `guard.applied[].original`.  A record that was already guarded is first
    returned to the model's own decision, so guarding never stacks and another guard version can be applied to a guarded run."""
    rec = copy.deepcopy(record)
    if rec.get('guard'):
        rec = restore_original(rec, case, evidence_shown)
        rec.pop('guard')
    pv = (rec.get('prompt') or {}).get('version') or P.DEFAULT_PROMPT
    resolve = record_resolver(rec, evidence_shown)
    final, guard = apply(case, rec['decision'], rec.get('tool_calls') or [], evidence_shown, pv, bool(rec.get('forced')), version, resolve=resolve)
    rec['guard'] = guard
    if guard['final_changed']:
        rec['decision'] = final
        outcome_step = (rec.get('action_audit') or {}).get('outcome_step')
        rec.update(derived_fields(case, final, rec.get('tool_calls') or [], evidence_shown, rec.get('evidence_mode', 'replay'), pv,
                                  bool(rec.get('forced')), outcome_step, resolve, bool(rec.get('evidence_format')), _v3_caps(rec)))
    return rec


def restore_original(record, case, evidence_shown):
    """Offline, the inverse view: a COPY of a guarded record with the model's original decision back (and the fields derived from it), so a guarded
    run can also be scored as if guards had been off.  The `guard` field stays, marked `restored`."""
    rec = copy.deepcopy(record)
    guard = rec.get('guard')
    if not guard:
        raise ValueError('record %s has no guard field' % rec.get('case_id'))
    if guard['final_changed']:
        orig = guard['applied'][0]['original']
        pv = (rec.get('prompt') or {}).get('version') or P.DEFAULT_PROMPT
        rec['decision'] = copy.deepcopy(orig)
        rec.update(derived_fields(case, orig, rec.get('tool_calls') or [], evidence_shown, rec.get('evidence_mode', 'replay'), pv,
                                  bool(rec.get('forced')), (rec.get('action_audit') or {}).get('outcome_step'), record_resolver(rec, evidence_shown), bool(rec.get('evidence_format')),
                                  _v3_caps(rec)))
    rec['guard'] = dict(guard, restored=True)
    return rec
