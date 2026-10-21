#!/usr/bin/env python3
"""Benchmark-validity ceiling (story #159): score decision sets that no model made, with the evaluator's unchanged score.py.

Offline, no model call.  It builds decision-only records (class and action, nothing else) for three views and scores each with
score.py's own `score()` through `score_compat`, so every gate population and correctness rule is the scorer's, not a copy:

  label        the public label itself: truth class with a supported action (`none` for healthy, else the first supported write,
               else `escalate`).  A sanity check that the labels can pass the decision gates at all.
  contract     the coordinator's frozen contract-faithful prediction per case (`cf` in predictions.json): what a model that follows
               contract v3 / prompt v7 exactly should decide from the delivered evidence.
  contract-best, contract-worst
               per case, the best or worst score.py outcome over `cf` and every listed contract-defensible alternative (`alt`).
               The spread is the part the contract or a hand judgement leaves open.

Only G1 to G5 and the per-class G3 counts are meaningful here (they read `decision.class` and `decision.action` only).  G6 to G10 need
real run records and are reported as not applicable.  predictions.json is never a model or harness input.

    python3 scripts/validity_ceiling.py --suite <suite-dev-v1.1> --predictions runs/dev-validity-opus55/predictions.json --out-json <file>
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import score_compat  # noqa: E402

DECISION_GATES = ('G1', 'G2', 'G3', 'G4', 'G5')
WRITES = ('blocklist_and_search', 'remap', 'rename', 'convert')


def label_decision(case):
    cls = case['truth']['class']
    sup = list(case.get('supported_actions', []))
    if cls == 'healthy':
        return cls, 'none'
    writes = [a for a in sup if a in WRITES]
    return cls, (writes[0] if writes else ('escalate' if 'escalate' in sup else sup[0]))


def score_decisions(score_mod, suite, decisions):
    with tempfile.TemporaryDirectory(prefix='mrh-validity-') as d:
        for cid, (cls, act) in decisions.items():
            Path(d, cid + '.json').write_text(json.dumps({'case_id': cid, 'decision': {'class': cls, 'action': act}}))
        Path(d, 'manifest.json').write_text(json.dumps({'case_ids': sorted(decisions)}))
        s = score_mod.score(d, suite)
    return s


def summary(s):
    gates = {g['gate']: g for g in s['gates']}
    return {gid: {'value': gates[gid]['value'], 'pass': gates[gid]['status'] == 'pass', 'detail': gates[gid].get('detail')}
            for gid in DECISION_GATES}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--suite', required=True)
    ap.add_argument('--predictions', required=True)
    ap.add_argument('--out-json')
    a = ap.parse_args(argv)
    score_mod = score_compat.load_score()
    cases = {c['id']: c for c, _ in R.load_cases(a.suite)}
    pred = json.loads(Path(a.predictions).read_text())['cases']
    missing = sorted(set(cases) - set(pred))
    extra = sorted(set(pred) - set(cases))
    if missing or extra:
        raise SystemExit('predictions do not cover the suite: missing %s, extra %s' % (missing, extra))

    def correct(cid, dec):
        rec = {'decision': {'class': dec[0], 'action': dec[1]}}
        return score_mod.case_facts(cases[cid], rec)

    views = {'label': {cid: label_decision(c) for cid, c in cases.items()},
             'contract': {cid: tuple(pred[cid]['cf']) for cid in cases}}
    best, worst, per_case = {}, {}, {}
    for cid in sorted(cases):
        options = [tuple(pred[cid]['cf'])] + [tuple(x) for x in pred[cid].get('alt', [])]
        facts = [(o, correct(cid, o)) for o in options]
        rank = lambda of: (not of[1]['unsafe_write'], of[1]['correct'], not of[1]['false_abstention'])  # noqa: E731
        best[cid] = max(facts, key=rank)[0]
        worst[cid] = min(facts, key=rank)[0]
        cf = facts[0][1]
        per_case[cid] = {'truth': cases[cid]['truth']['class'], 'accepted': score_mod.accepted_classes(cases[cid]),
                         'supported': list(cases[cid].get('supported_actions', [])), 'cf': list(options[0]),
                         'cf_correct': cf['correct'], 'cf_unsafe_write': cf['unsafe_write'], 'cf_false_abstention': cf['false_abstention'],
                         'any_option_correct': any(f['correct'] for _, f in facts), 'status': pred[cid].get('status')}
    views['contract-best'] = best
    views['contract-worst'] = worst
    result = {'tool': 'validity_ceiling.py', 'score_py': str(score_compat.score_path()), 'note': 'G6-G10 not applicable (decision-only records)',
              'views': {}, 'per_case': per_case}
    for name, dec in views.items():
        s = score_decisions(score_mod, a.suite, dec)
        result['views'][name] = {'gates': summary(s), 'per_class': s['metrics']['per_class_accuracy']}
    result['contract_label_fails'] = sorted(c for c, x in per_case.items() if not x['cf_correct'])
    result['never_correct_under_contract'] = sorted(c for c, x in per_case.items() if not x['any_option_correct'])
    text = json.dumps(result, indent=1, sort_keys=True)
    if a.out_json:
        Path(a.out_json).write_text(text + '\n')
    for name, v in result['views'].items():
        g = v['gates']
        print('%-15s ' % name + '  '.join('%s=%s%s' % (k, _fmt(g[k]['value']), '' if g[k]['pass'] else '(FAIL)') for k in DECISION_GATES)
              + '  classes ' + ' '.join('%s %d/%d' % (k[:3], c['correct'], c['n']) for k, c in sorted((v['per_class'] or {}).items())))
    print('cf incorrect under score.py: %d %s' % (len(result['contract_label_fails']), result['contract_label_fails']))
    print('no contract-defensible option correct: %d' % len(result['never_correct_under_contract']))
    return 0


def _fmt(v):
    return ('%.3f' % v) if isinstance(v, float) else str(v)


if __name__ == '__main__':
    sys.exit(main())
