#!/usr/bin/env python3
"""Offline guard what-if: apply the dev-c4 decision guards (`mrh-guard`) to existing run directories and rescore both with the unchanged
`score.py` (through `score_compat`).  No model is called.  Usage:

  PYTHONPATH=tools/media-repair-harness/src python3 -B tools/media-repair-harness/scripts/guard_whatif.py \
      --suite <suite-dev-v1.1> --scratch <dir for the guarded record copies> --out <dir for summary.json / summary.md> RUN_DIR [RUN_DIR ...]

The guarded copies (full records) stay in --scratch; only the compact summary is meant to be committed.  Labelled dev-tuned: the suite is the dev split.
"""
import argparse
import json
import sys
from pathlib import Path

from media_repair_harness import guard_cli, score_compat

GATES = ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10')


def gate_cell(g):
    v = g['value']
    if isinstance(v, dict):
        v = 'crashes %s, p95 %ss' % (v.get('crashes'), v.get('p95_s'))
    elif isinstance(v, float):
        v = '%.1f%%' % (100 * v)
    return '%s %s' % (v if v is not None else 'n/a', g['status'].upper())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('runs', nargs='+')
    ap.add_argument('--suite', required=True)
    ap.add_argument('--scratch', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    score = score_compat.load_score().score
    scratch, out = Path(a.scratch), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {'guards': 'v1', 'suite': Path(a.suite).name, 'label': 'dev-tuned, offline, no model calls; one dev-c3 run per model', 'models': {}}
    for run in a.runs:
        run = Path(run)
        name = json.loads((run / 'manifest.json').read_text()).get('requested_model') or run.name
        res = guard_cli.guard_run(run, a.suite, scratch / name.replace(':', '-'))
        before = score(run, a.suite)
        after = score(scratch / name.replace(':', '-'), a.suite)
        ch = []
        for c in res['changed']:
            b, f = before['cases'][c['case_id']], after['cases'][c['case_id']]
            ch.append(dict(c, truth=b['truth'], correct_before=b['correct'], correct_after=f['correct'], unsafe_before=b['unsafe_write'], unsafe_after=f['unsafe_write']))
        summary['models'][name] = {
            'records': res['records'], 'by_rule': res['by_rule'], 'changed': ch,
            'gates_before': {g['gate']: gate_cell(g) for g in before['gates']}, 'gates_after': {g['gate']: gate_cell(g) for g in after['gates']},
            'g1_cases_before': before['gates'][0]['detail']['cases'], 'g1_cases_after': after['gates'][0]['detail']['cases'],
            'healthy_correct_decisions_changed': [c['case_id'] for c in ch if c['truth'] == 'healthy' and c['correct_before']],
            'correct_before_wrong_after': [c['case_id'] for c in ch if c['correct_before'] and not c['correct_after']],
            'wrong_before_correct_after': [c['case_id'] for c in ch if not c['correct_before'] and c['correct_after']],
        }
    (out / 'summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
    lines = ['# Guard what-if (`--guards v1`, offline)', '', 'Label: %s. Suite `%s`. Gate cells are `before -> after` (the unchanged score.py).' % (summary['label'], summary['suite']), '',
             '| Gate | ' + ' | '.join(summary['models']) + ' |', '|---|' + '---|' * len(summary['models'])]
    for gname in GATES:
        cells = []
        for m in summary['models'].values():
            b, f = m['gates_before'][gname], m['gates_after'][gname]
            cells.append(b if b == f else '%s -> **%s**' % (b, f))
        lines.append('| %s | %s |' % (gname, ' | '.join(cells)))
    lines += ['', '## Decisions changed by a guard', '', '| Model | Case | Truth | Rule | Before | After | Correct before | Correct after |', '|---|---|---|---|---|---|---|---|']
    for name, m in summary['models'].items():
        for c in m['changed']:
            lines.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (name, c['case_id'], c['truth'], c['rule'], c['before'], c['after'], c['correct_before'], c['correct_after']))
    lines += ['', '## Required check', '']
    for name, m in summary['models'].items():
        lines.append('- %s: decisions changed %d; correct truth-healthy decisions changed: %s; correct -> wrong: %s; wrong -> correct: %s' % (
            name, len(m['changed']), m['healthy_correct_decisions_changed'] or 'none', m['correct_before_wrong_after'] or 'none', m['wrong_before_correct_after'] or 'none'))
    (out / 'summary.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    return 0


if __name__ == '__main__':
    sys.exit(main())
