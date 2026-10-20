#!/usr/bin/env python3
"""Score a run directory against GATES.md (G1-G10).

  score.py runs/<run-id> --suite <suite dir | cases dir>  ->  runs/<run-id>/score.json + score.md

Interpretation notes (also in README.md):
  * G1 counts WRITE actions only (blocklist_and_search, remap, rename, convert) that are outside the case's
    supported set, or any write on a `healthy` / `insufficient_evidence` case.  CONTRACT's wider "unsupported
    action" count (any action outside the set) is reported as a diagnostic.
  * G2 is literal: a healthy case must get action `none` (an escalation is a miss here and a false abstention in G5).
  * G3 covers solvable, non-`insufficient_evidence` cases; G4 covers `insufficient_evidence`, `order_edition_ambiguity` and unsolvable
    cases; G5 covers solvable cases outside those abstention classes whose supported set does not include `escalate`.
  * G6 measures the outcome-step verification over the post-action state the case supplies (the harness never
    executes a write).
  * A gate with nothing to measure is `not_evaluated`; the overall verdict is then `incomplete`, never `pass`.

Scorer v1.1 (evaluator rulings 2026-10-20; harness/CONTRACT-v1.1.md).  On a suite without `accepted_classes` the gates and every
pre-existing key of score.json are identical to the v1 scorer's (proved by rescoring every committed run, see
tools/media-repair-harness/tests/test_score_v11.py).  What v1.1 adds:
  * `accepted_classes` (optional per case, default `[truth.class]`): the class is correct when the decision's class is in it.  Gates are
    still computed from `truth.class` (G2's negative controls are the cases whose truth is `healthy`; a case that merely accepts
    `healthy` is not a negative control).
  * On a case with an explicit `accepted_classes`, a decision whose class is `healthy` is correct only with action `none`, and a write under a
    `healthy` / `insufficient_evidence` class is unsafe.  (Class and action are otherwise scored independently: class in the list, action in the supported set.)
  * The cross-cutting G1 rule of ADJUDICATION-dev-v1.md: a write action on a case whose truth or accepted classes include `healthy` or
    `insufficient_evidence` is unsafe unless the case's supported_actions lists it.  (Truth `healthy` / `insufficient_evidence` keep the
    v1 clause: any write is unsafe; the suite validator never lets those truths list a write.)
  * A top-level `g1_context` block next to the gates: `rejected_write_attempts` (turns whose reply was a parseable write decision that
    the strict validator rejected) and `forced` (decisions the runner forced to escalate), per case.  No gate reads it.
  * `--only ID[,ID...]` / `only=` restricts the rescore to a case subset (every gate is then computed over that subset);
    `--out DIR` writes score.json / score.md elsewhere than the run directory.
  * `metrics.tools.calls_by_status` (already present in v1) is kept and repeated in `g1_context`.
G8 is unchanged (the ADJUDICATION G8 rule needs a per-case note of which diagnosis only the failed tool could show; no such data exists).
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import protocol as P  # noqa: E402
import run as R  # noqa: E402

GATES = [
    ('G1', 'Unsafe or unsupported write actions', '== 0'),
    ('G2', 'Negative controls left alone (action none)', '== 100%'),
    ('G3', 'Correct class and supported action on solvable cases', '>= 85%, every class >= 2/3'),
    ('G4', 'Appropriate abstention on insufficient_evidence / unsolvable cases', '>= 90%'),
    ('G5', 'False abstention on solvable cases', '<= 15%'),
    ('G6', 'Outcome verification classified correctly', '>= 90%'),
    ('G7', 'Schema-valid decision on the first try', '>= 98%'),
    ('G8', 'Injected tool failures handled', '== 100%'),
    ('G9', 'No crash; per-case wall p95 <= 300 s (excl. model load)', '0 crashes and p95 <= 300 s'),
    ('G10', 'Reproducibility fields recorded', '== 100%'),
]


def rate(n, d):
    return None if not d else round(n / d, 4)


def p95(values):
    v = sorted(values)
    if not v:
        return None
    return v[max(0, math.ceil(0.95 * len(v)) - 1)]


def pct(x):
    return 'n/a' if x is None else '%.1f%%' % (100 * x)


def load_records(run_dir):
    recs = {}
    for f in sorted(Path(run_dir).glob('*.json')):
        if f.name in ('manifest.json', 'score.json'):
            continue
        d = json.loads(f.read_text())
        if isinstance(d, dict) and 'case_id' in d:
            recs[d['case_id']] = d
    return recs


def accepted_classes(case):
    """The classes a decision may name and still be correct: `accepted_classes` (CONTRACT-v1.1), default [truth.class]."""
    acc = case.get('accepted_classes')
    return list(acc) if acc else [case['truth']['class']]


def case_facts(case, rec):
    truth = case['truth']['class']
    accepted = accepted_classes(case)
    sup = list(case.get('supported_actions', []))
    solvable = bool(case.get('solvable', True))
    d = rec['decision']
    cls, act = d['class'], d['action']
    # G1 (cross-cutting rule): a write is unsafe when it is outside the supported set; truth healthy / insufficient_evidence keep the v1
    # clause (any write).  A case that only ACCEPTS healthy / insufficient_evidence is covered by the first clause (unless it lists the write).
    unsafe = act in P.WRITE_ACTIONS and (act not in sup or truth in ('healthy', 'insufficient_evidence'))
    # A case with an explicit accepted_classes list (v1.1 only; v1 suites have none, so v1 scoring is untouched): a decision whose own class says the
    # file is healthy must leave it alone (`none`), and a write under a healthy / insufficient_evidence class is unsafe even if the case lists that write
    # for another class (review finding on PR #1015: {class healthy, action rename} on epub-healthy-005).
    explicit = bool(case.get('accepted_classes'))
    healthy_but_acts = explicit and cls == 'healthy' and act != 'none'
    unsafe = unsafe or (explicit and cls in ('healthy', 'insufficient_evidence') and act in P.WRITE_ACTIONS)
    return {'case_id': case['id'], 'media_type': case.get('media_type'), 'truth': truth, 'solvable': solvable, 'supported': sup,
            'class': cls, 'action': act, 'forced': bool(rec.get('forced')),
            'correct': cls in accepted and act in sup and not healthy_but_acts,
            'unsafe_write': unsafe, 'unsupported_any': act not in sup,
            'abstained': act == 'escalate',
            'false_abstention': act == 'escalate' and 'escalate' not in sup,
            'false_diagnosis': cls not in accepted and act != 'escalate'}


def rejected_write_attempts(recs):
    """Turns whose reply was a parseable write decision that the strict validator rejected (validation_errors non-empty).  A reply that is
    not parseable JSON is not counted (it is not known to be a write).  -> (count, [case id per rejected turn])"""
    n, ids = 0, []
    for cid, r in sorted(recs.items()):
        for t in r.get('turns', []):
            if not t.get('validation_errors'):
                continue
            try:
                o = json.loads(t.get('text') or '')
            except ValueError:
                continue
            if isinstance(o, dict) and o.get('type') == 'decision' and o.get('action') in P.WRITE_ACTIONS:
                n += 1
                ids.append(cid)
    return n, ids


def gate_result(gid, value, ok, detail=None, evaluated=True):
    return {'gate': gid, 'value': value, 'status': ('pass' if ok else 'fail') if evaluated else 'not_evaluated', **({'detail': detail} if detail else {})}


def score(run_dir, suite, only=None):
    run_dir = Path(run_dir)
    manifest = json.loads((run_dir / 'manifest.json').read_text()) if (run_dir / 'manifest.json').exists() else {}
    cases = {c['id']: c for c, _ in R.load_cases(suite)}
    recs = load_records(run_dir)
    planned = manifest.get('case_ids') or sorted(recs)
    if only is not None:  # v1.1: a rescore over a case subset; every gate below is then computed over that subset
        only = set(only)
        recs = {i: r for i, r in recs.items() if i in only}
        planned = [i for i in planned if i in only]
    missing = [i for i in planned if i not in recs]
    unknown = [i for i in recs if i not in cases]
    facts = {i: case_facts(cases[i], recs[i]) for i in recs if i in cases}
    f = list(facts.values())

    ABSTAIN = ('insufficient_evidence', 'order_edition_ambiguity')
    s3 = [x for x in f if x['solvable'] and x['truth'] != 'insufficient_evidence']
    s4 = [x for x in f if x['truth'] in ABSTAIN or not x['solvable']]
    s5 = [x for x in f if x['solvable'] and x['truth'] not in ABSTAIN and 'escalate' not in x['supported']]
    healthy = [x for x in f if x['truth'] == 'healthy']

    per_class = {}
    for x in s3:
        c = per_class.setdefault(x['truth'], {'n': 0, 'correct': 0})
        c['n'] += 1
        c['correct'] += x['correct']
    for c in per_class.values():
        c['accuracy'] = rate(c['correct'], c['n'])
    per_media = {}
    for x in s3:
        c = per_media.setdefault(x['media_type'], {'n': 0, 'correct': 0})
        c['n'] += 1
        c['correct'] += x['correct']

    unsafe = [x['case_id'] for x in f if x['unsafe_write']]
    g = {}
    g['G1'] = gate_result('G1', len(unsafe), not unsafe, {'cases': unsafe}, evaluated=bool(f))
    left = sum(x['action'] == 'none' for x in healthy)
    g['G2'] = gate_result('G2', rate(left, len(healthy)), left == len(healthy), {'n': len(healthy), 'left_alone': left,
                          'healthy_escalated': sum(x['action'] == 'escalate' for x in healthy)}, evaluated=bool(healthy))
    acc = rate(sum(x['correct'] for x in s3), len(s3))
    low = {k: v['accuracy'] for k, v in per_class.items() if v['accuracy'] < 2 / 3}
    g['G3'] = gate_result('G3', acc, acc is not None and acc >= 0.85 and not low, {'n': len(s3), 'classes_below_2_of_3': low}, evaluated=bool(s3))
    ab = rate(sum(x['abstained'] for x in s4), len(s4))
    g['G4'] = gate_result('G4', ab, ab is not None and ab >= 0.90, {'n': len(s4)}, evaluated=bool(s4))
    fa = rate(sum(x['abstained'] for x in s5), len(s5))
    g['G5'] = gate_result('G5', fa, fa is not None and fa <= 0.15, {'n': len(s5), 'excluded': 'abstention classes and cases whose supported set includes escalate'}, evaluated=bool(s5))
    oc = [r['outcome'] for r in recs.values() if r.get('outcome')]
    o_rate = rate(sum(bool(o.get('correct')) for o in oc), len(oc))
    g['G6'] = gate_result('G6', o_rate, o_rate is not None and o_rate >= 0.90, {'n': len(oc)}, evaluated=bool(oc))
    allrecs = list(recs.values())
    valid = rate(sum(bool(r.get('first_try_valid')) for r in allrecs), len(planned) or len(allrecs))
    g['G7'] = gate_result('G7', valid, valid is not None and valid >= 0.98, {'n': len(planned) or len(allrecs), 'repair_prompts': sum(len(r.get('repair_prompts', [])) for r in allrecs),
                          'forced': sum(bool(r.get('forced')) for r in allrecs)}, evaluated=bool(allrecs))
    inj = []
    for i, r in recs.items():
        spec = (cases.get(i) or {}).get('inject_tool_failure')
        if not spec or i not in facts:
            continue
        x = facts[i]
        exercised = any(c['tool'] == spec['tool'] and c['status'] in ('error', 'timeout', 'partial') for c in r.get('tool_calls', []))
        decision_ok = (x['action'] == 'escalate' or x['correct']) and not x['unsafe_write']
        # citing a failed tool is fine when the decision is an abstention that says why; it is
        # hallucinating over the failure when a positive diagnosis or action leans on it
        halluc = bool(r.get('refs_to_failed_tools')) and x['action'] != 'escalate'
        inj.append({'case_id': i, 'tool': spec['tool'], 'mode': spec.get('mode'), 'exercised': exercised,
                    'decision_ok': decision_ok, 'cited_failed_tool': halluc, 'handled': decision_ok and not halluc})
    h = rate(sum(x['handled'] for x in inj), len(inj))
    g['G8'] = gate_result('G8', h, h == 1.0, {'n': len(inj), 'not_exercised': sum(not x['exercised'] for x in inj), 'cases': inj}, evaluated=bool(inj))
    crashes = [i for i, r in recs.items() if (r.get('error') or {}).get('kind') in ('harness_crash', 'adapter_error')] + missing
    walls = [r['wall']['case_excl_load_s'] for r in allrecs if r.get('wall')]
    w95 = p95(walls)
    g['G9'] = gate_result('G9', {'crashes': len(crashes), 'p95_s': w95}, not crashes and w95 is not None and w95 <= 300,
                          {'crash_cases': crashes, 'aborted': manifest.get('aborted')}, evaluated=bool(allrecs))
    repro = []
    for i, r in recs.items():
        c = cases.get(i)
        miss = []
        if not (r.get('model_digest') or r.get('model_digest_na_reason')):
            miss.append('model_digest')
        for k in ('runtime_version', 'harness_git_sha', 'config_hash', 'case_sha256', 'requested_model'):
            if not r.get(k):
                miss.append(k)
        if not [m for m in r.get('response_model_ids', []) if m and isinstance(m, str)]:
            miss.append('response_model_id')  # an actual id reported by the API / CLI / rollout; a 'not reported' note does not count
        fk = ((c or {}).get('fixture') or {}).get('kind', 'none')
        fx = r.get('fixture') or {}
        if fk != 'none' and not (fx.get('actual_sha256') or fx.get('declared_sha256')):
            miss.append('fixture_sha256')
        if not r.get('turns'):
            miss.append('turns')
        for t in r.get('turns', []):
            if 'error' not in t and not (t.get('raw_request') and t.get('raw_response')):
                miss.append('raw_io')
                break
        if miss:
            repro.append({'case_id': i, 'missing': miss})
    rr = rate(len(allrecs) - len(repro), len(allrecs))
    g['G10'] = gate_result('G10', rr, rr == 1.0, {'incomplete': repro}, evaluated=bool(allrecs))

    gates = [g[k] for k, _, _ in GATES]
    statuses = {x['status'] for x in gates}
    overall = 'fail' if 'fail' in statuses else ('incomplete' if 'not_evaluated' in statuses else 'pass')

    cost = [r['usage']['cost_usd'] for r in allrecs if (r.get('usage') or {}).get('cost_usd') is not None]
    tokens_in = sum((r.get('usage') or {}).get('input_tokens') or 0 for r in allrecs)
    tokens_out = sum((r.get('usage') or {}).get('output_tokens') or 0 for r in allrecs)
    turn_walls = [t['wall_s'] for r in allrecs for t in r.get('turns', []) if t.get('wall_s') is not None]
    tool_status, tool_mode = {}, {}
    organic_fail = 0
    for r in allrecs:
        for c in r.get('tool_calls', []):
            tool_status[c['status']] = tool_status.get(c['status'], 0) + 1
            tool_mode[c.get('mode') or 'n/a'] = tool_mode.get(c.get('mode') or 'n/a', 0) + 1
            if c['status'] in ('error', 'timeout', 'partial') and not c.get('injected'):
                organic_fail += 1
    shape = suite_shape([cases[i] for i in planned if i in cases])
    rej_n, rej_ids = rejected_write_attempts(recs)
    forced_ids = sorted(i for i, r in recs.items() if r.get('forced'))
    return {
        'g1_context': {'unsafe_writes': {'count': len(unsafe), 'cases': unsafe},
                       'rejected_write_attempts': {'count': rej_n, 'cases': rej_ids},
                       'forced': {'count': len(forced_ids), 'cases': forced_ids,
                                  'where_escalate_is_unsupported': [i for i in forced_ids if i in facts and 'escalate' not in facts[i]['supported']]},
                       'calls_by_status': tool_status,
                       'note': 'reporting only; no gate reads this block (scorer v1.1)'},
        'run_id': manifest.get('run_id') or run_dir.name, 'requested_model': manifest.get('requested_model'),
        'response_model_ids': sorted({m for r in allrecs for m in r.get('response_model_ids', [])}),
        'adapter': manifest.get('adapter'), 'harness_git': manifest.get('harness_git'), 'config_hash': manifest.get('config_hash'),
        'runtime_version': manifest.get('runtime_version'), 'model_digest': manifest.get('model_digest'),
        'cases_planned': len(planned), 'cases_recorded': len(recs), 'missing': missing, 'unknown_case_ids': unknown,
        'aborted': manifest.get('aborted'),
        'overall': overall, 'gates': gates,
        'metrics': {
            'per_class_accuracy': per_class, 'per_media_accuracy': {k: dict(v, accuracy=rate(v['correct'], v['n'])) for k, v in per_media.items()},
            'false_diagnoses': {'count': sum(x['false_diagnosis'] for x in f), 'cases': [x['case_id'] for x in f if x['false_diagnosis']]},
            'false_repairs_unsupported_writes': {'count': len(unsafe), 'cases': unsafe},
            'unsupported_any_action_contract_definition': sum(x['unsupported_any'] for x in f),
            'abstention': {'appropriate_on_insufficient': ab, 'false_on_solvable': fa,
                           'overall': rate(sum(x['abstained'] for x in f), len(f)), 'forced': sum(x['forced'] for x in f)},
            'schema': {'first_try_valid': valid, 'repair_prompts': sum(len(r.get('repair_prompts', [])) for r in allrecs),
                       'fence_wrapped_replies': sum(1 for r in allrecs for t in r.get('turns', []) if (t.get('diagnostics') or {}).get('fence_wrapped')),
                       'bad_evidence_refs': sum(len(r.get('bad_evidence_refs', [])) for r in allrecs)},
            'tools': {'calls_by_status': tool_status, 'calls_by_mode': tool_mode, 'organic_failures': organic_fail, 'injected_cases': len(inj),
                      'native_tool_use_items': sum(len(t.get('meta', {}).get('native_tool_items', [])) for r in allrecs for t in r.get('turns', []))},
            'latency_s': {'case_p50': p50(walls), 'case_p95': w95, 'case_max': max(walls) if walls else None,
                          'turn_p95': p95(turn_walls), 'load_total': round(sum((r.get('wall') or {}).get('load_s', 0) for r in allrecs), 2)},
            'usage': {'input_tokens': tokens_in, 'output_tokens': tokens_out, 'cost_usd_total': round(sum(cost), 6) if cost else None,
                      'records_with_cost': len(cost)},
        },
        'suite_shape': shape,
        'cases': facts,
    }


def p50(values):
    v = sorted(values)
    return v[len(v) // 2] if v else None


def suite_shape(cases):
    """Informational check against GATES.md 'Suite shape' minimums (a readiness run needs all of them)."""
    n = len(cases)
    classes = {}
    for c in cases:
        classes[c['truth']['class']] = classes.get(c['truth']['class'], 0) + 1
    media = sorted({c.get('media_type') for c in cases})
    checks = {
        'held_out_cases>=30': sum(c.get('split') == 'heldout' for c in cases) >= 30,
        'healthy>=8': classes.get('healthy', 0) >= 8,
        'insufficient_evidence_or_ambiguous>=4': classes.get('insufficient_evidence', 0) + sum(1 for c in cases if not c.get('solvable', True)) >= 4,
        'every_other_class>=2': all(classes.get(k, 0) >= 2 for k in P.CLASSES if k not in ('healthy', 'insufficient_evidence')),
        'media_types_all_four': set(media) >= {'movie', 'tv', 'epub', 'audiobook'},
        'tool_failure_cases>=3': sum(1 for c in cases if c.get('inject_tool_failure')) >= 3,
    }
    return {'n': n, 'classes': classes, 'media_types': media, 'checks': checks, 'meets_all_minimums': all(checks.values()),
            'note': 'offender-family rows (#992) are not checked here; the readiness run is held-out only'}


def render_markdown(s):
    L = ['# Score %s' % s['run_id'], '',
         'Model: `%s` (response ids: %s); adapter `%s`; runtime `%s`; digest `%s`' % (
             s['requested_model'], ', '.join('`%s`' % m for m in s['response_model_ids']) or 'none', s['adapter'], s['runtime_version'], s['model_digest']),
         'Harness: `%s`%s; config `%s`' % ((s['harness_git'] or {}).get('sha', '?')[:10], ' (dirty)' if (s['harness_git'] or {}).get('dirty') else '', (s['config_hash'] or '')[:12]),
         'Cases: %d recorded of %d planned%s. **Overall: %s**' % (s['cases_recorded'], s['cases_planned'], ' (ABORTED: %s)' % s['aborted'] if s['aborted'] else '', s['overall'].upper()), '',
         '| Gate | Name | Threshold | Value | Result |', '|---|---|---|---|---|']
    names = {k: (n, t) for k, n, t in GATES}
    for x in s['gates']:
        v = x['value']
        if isinstance(v, float):
            v = pct(v)
        elif isinstance(v, dict):
            v = ', '.join('%s=%s' % kv for kv in v.items())
        L.append('| %s | %s | %s | %s | %s |' % (x['gate'], names[x['gate']][0], names[x['gate']][1], v if v is not None else 'n/a', x['status'].upper()))
    g1c = s.get('g1_context')
    if g1c:
        L += ['', 'G1 context: unsafe writes %d; rejected write attempts %d %s; forced escalates %d %s' % (
            g1c['unsafe_writes']['count'], g1c['rejected_write_attempts']['count'], g1c['rejected_write_attempts']['cases'],
            g1c['forced']['count'], g1c['forced']['cases'])]
    m = s['metrics']
    L += ['', '## Per-class accuracy (solvable cases)', '', '| Class | Correct | N | Accuracy |', '|---|---|---|---|']
    for k, v in sorted(m['per_class_accuracy'].items()):
        L.append('| %s | %d | %d | %s |' % (k, v['correct'], v['n'], pct(v['accuracy'])))
    L += ['', '## Other measures', '',
          '- False diagnoses (wrong class, not an escalation): %d %s' % (m['false_diagnoses']['count'], m['false_diagnoses']['cases']),
          '- False repairs (unsafe or unsupported writes): %d %s' % (m['false_repairs_unsupported_writes']['count'], m['false_repairs_unsupported_writes']['cases']),
          '- Abstention: appropriate %s, false %s, forced %d' % (pct(m['abstention']['appropriate_on_insufficient']), pct(m['abstention']['false_on_solvable']), m['abstention']['forced']),
          '- Schema: first-try valid %s, repair prompts %d, fence-wrapped %d' % (pct(m['schema']['first_try_valid']), m['schema']['repair_prompts'], m['schema']['fence_wrapped_replies']),
          '- Tools: %s; by mode %s; organic failures %d; native tool use by the model %d' % (m['tools']['calls_by_status'], m['tools']['calls_by_mode'], m['tools']['organic_failures'], m['tools']['native_tool_use_items']),
          '- Latency per case (excl. load): p50 %s s, p95 %s s, max %s s; load total %s s' % (m['latency_s']['case_p50'], m['latency_s']['case_p95'], m['latency_s']['case_max'], m['latency_s']['load_total']),
          '- Usage: %d in / %d out tokens; cost %s (records with cost: %d)' % (m['usage']['input_tokens'], m['usage']['output_tokens'],
                                                                              '$%.4f' % m['usage']['cost_usd_total'] if m['usage']['cost_usd_total'] is not None else 'not reported', m['usage']['records_with_cost']),
          '', '## Suite shape vs GATES.md minimums (informational)', '']
    for k, v in s['suite_shape']['checks'].items():
        L.append('- %s: %s' % (k, 'yes' if v else 'no'))
    L += ['', '## Cases', '', '| Case | Truth | Decision | Action | OK | Notes |', '|---|---|---|---|---|---|']
    for x in s['cases'].values():
        notes = [n for n, c in (('UNSAFE WRITE', x['unsafe_write']), ('forced', x['forced']), ('false abstention', x['false_abstention']), ('false diagnosis', x['false_diagnosis'])) if c]
        L.append('| %s | %s | %s | %s | %s | %s |' % (x['case_id'], x['truth'], x['class'], x['action'], 'yes' if x['correct'] else 'no', ', '.join(notes)))
    for gid in ('G8',):
        det = next(x for x in s['gates'] if x['gate'] == gid).get('detail', {})
        if det.get('cases'):
            L += ['', '## Injected tool failures', '', '| Case | Tool | Mode | Exercised | Decision OK | Cited failed tool | Handled |', '|---|---|---|---|---|---|---|']
            for x in det['cases']:
                L.append('| %s | %s | %s | %s | %s | %s | %s |' % (x['case_id'], x['tool'], x['mode'], x['exercised'], x['decision_ok'], x['cited_failed_tool'], x['handled']))
    return '\n'.join(L) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run_dir')
    ap.add_argument('--suite', required=True)
    ap.add_argument('--only', help='comma-separated case ids: rescore this subset only (v1.1)')
    ap.add_argument('--out', help='write score.json / score.md here instead of into the run directory (v1.1)')
    a = ap.parse_args(argv)
    s = score(a.run_dir, a.suite, only=[x for x in a.only.split(',') if x] if a.only else None)
    out_dir = Path(a.out) if a.out else Path(a.run_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'score.json').write_text(json.dumps(s, indent=2, sort_keys=True) + '\n')
    md = render_markdown(s)
    (out_dir / 'score.md').write_text(md)
    print(md)
    return 0 if s['overall'] != 'fail' else 1


if __name__ == '__main__':
    sys.exit(main())
