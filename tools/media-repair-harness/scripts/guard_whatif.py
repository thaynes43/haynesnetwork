#!/usr/bin/env python3
"""Offline guard what-if: apply the dev-c4 decision guards (`mrh-guard`) to existing run directories and rescore with the unchanged `score.py`
(through `score_compat`).  No model is called.  Usage:

  PYTHONPATH=tools/media-repair-harness/src python3 -B tools/media-repair-harness/scripts/guard_whatif.py \
      --suite <suite-dev-v1.1> --scratch <dir for the guarded record copies> --out <dir for summary.json / summary.md> [--guards v1,v2] RUN_DIR [RUN_DIR ...]

For every run: "off" is the model's own decisions (a run that was already guarded is first restored to them), then each guard version in --guards is applied and scored.
A run that was recorded with guards on is re-based on the model's original decisions, so v1 and v2 can be compared on the same records.
The guarded copies (full records) stay in --scratch; only the compact summary is meant to be committed.  Labelled dev-tuned: the suite is the dev split.
"""
import argparse
import json
import sys
from pathlib import Path

from media_repair_harness import decision_guard as DG
from media_repair_harness import guard_cli, score_compat

GATES = ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10')


def gate_cell(g):
    v = g['value']
    if isinstance(v, dict):
        v = 'crashes %s, p95 %ss' % (v.get('crashes'), v.get('p95_s'))
    elif isinstance(v, float):
        v = '%.1f%%' % (100 * v)
    return '%s %s' % (v if v is not None else 'n/a', g['status'].upper())


def label_of(run):
    man = json.loads((run / 'manifest.json').read_text())
    name = man.get('requested_model') or run.name
    return name + (' [dev-c4 v4]' if (man.get('config') or {}).get('prompt_version') == 'v4' else '')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('runs', nargs='+')
    ap.add_argument('--suite', required=True)
    ap.add_argument('--scratch', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--guards', default='v1', help='comma separated guard versions to compare, e.g. v1,v2')
    a = ap.parse_args(argv)
    versions = [v for v in a.guards.split(',') if v]
    for v in versions:
        if v not in DG.GUARD_VERSIONS:
            raise SystemExit('unknown guard version %r' % v)
    score = score_compat.load_score().score
    scratch, out = Path(a.scratch), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {'guards': versions, 'suite': Path(a.suite).name, 'label': 'dev-tuned, offline, no model calls; one run per model', 'models': {}}
    for run in a.runs:
        run = Path(run)
        label = label_of(run)
        slug = (label.replace(':', '-').replace(' ', '_').replace('[', '').replace(']', '')) + '-' + run.name[-12:]
        guarded_source = any('guard' in json.loads(p.read_text()) for p in sorted(run.glob('*-*-*.json'))[:1])
        if guarded_source:
            guard_cli.guard_run(run, a.suite, scratch / (slug + '-off'), restore=True)
            off_dir = scratch / (slug + '-off')
        else:
            off_dir = run
        before = score(off_dir, a.suite)
        entry = {'source': run.name, 'recorded_with_guards': guarded_source, 'gates_off': {g['gate']: gate_cell(g) for g in before['gates']},
                 'g1_cases_off': before['gates'][0]['detail']['cases'], 'versions': {}}
        for v in versions:
            res = guard_cli.guard_run(run, a.suite, scratch / (slug + '-' + v), version=v)
            after = score(scratch / (slug + '-' + v), a.suite)
            ch = []
            for c in res['changed']:
                b, f = before['cases'][c['case_id']], after['cases'][c['case_id']]
                ch.append(dict(c, truth=b['truth'], correct_before=b['correct'], correct_after=f['correct'], unsafe_before=b['unsafe_write'], unsafe_after=f['unsafe_write']))
            entry['versions'][v] = {
                'by_rule': res['by_rule'], 'changed': ch, 'gates': {g['gate']: gate_cell(g) for g in after['gates']},
                'g1_cases': after['gates'][0]['detail']['cases'],
                'healthy_correct_decisions_changed': [c['case_id'] for c in ch if c['truth'] == 'healthy' and c['correct_before']],
                'correct_before_wrong_after': [c['case_id'] for c in ch if c['correct_before'] and not c['correct_after']],
                'wrong_before_correct_after': [c['case_id'] for c in ch if not c['correct_before'] and c['correct_after']],
            }
        summary['models'][label] = entry
    (out / 'summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
    names = list(summary['models'])
    lines = ['# Guard what-if (offline)', '', 'Label: %s. Suite `%s`. Cells: guards off, then each guard version (the unchanged score.py). A cell is shown once when the versions agree with off.' % (summary['label'], summary['suite']), '']
    lines += ['| Gate | ' + ' | '.join(names) + ' |', '|---|' + '---|' * len(names)]
    for gname in GATES:
        cells = []
        for n in names:
            m = summary['models'][n]
            vals = [m['gates_off'][gname]] + [m['versions'][v]['gates'][gname] for v in versions]
            if len(set(vals)) == 1:
                cells.append(vals[0])
            else:
                cells.append('off %s; ' % vals[0] + '; '.join('**%s** %s' % (v, x) for v, x in zip(versions, vals[1:])))
        lines.append('| %s | %s |' % (gname, ' | '.join(cells)))
    lines += ['', '## Decisions changed by a guard', '', '| Model | Version | Case | Truth | Rule | Before | After | Correct before | Correct after |', '|---|---|---|---|---|---|---|---|---|']
    for n, m in summary['models'].items():
        for v in versions:
            for c in m['versions'][v]['changed']:
                lines.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (n, v, c['case_id'], c['truth'], c['rule'], c['before'], c['after'], c['correct_before'], c['correct_after']))
    lines += ['', '## Required check', '']
    for n, m in summary['models'].items():
        for v in versions:
            x = m['versions'][v]
            lines.append('- %s, %s: decisions changed %d; correct truth-healthy decisions changed: %s; correct -> wrong: %s; wrong -> correct: %s' % (
                n, v, len(x['changed']), x['healthy_correct_decisions_changed'] or 'none', x['correct_before_wrong_after'] or 'none', x['wrong_before_correct_after'] or 'none'))
    (out / 'summary.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    return 0


if __name__ == '__main__':
    sys.exit(main())
