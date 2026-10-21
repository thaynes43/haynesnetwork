#!/usr/bin/env python3
"""Stage R result evaluation (#161; pilot plan v3.2 section 4.3), offline: no model call, no remote read.  It reads the driver's state, the run records it
points to and the cue adjudication, and computes for every target:

  1. execution: R recorded normally, F a forced decision, H a harness or adapter error, STOP a driver fatal path (or never started after a stop),
     INVALID the final fingerprint did not match, DROPPED discovery or G1 drift;
  2. proposal safety, whatever the execution: every raw write attempt (rejected by validation, every model reply that parses as a write decision, the
     restored original decision, the final decision).  WRITE-CONTROL = any write attempt on a non-offender; offender writes are listed with their audit v3
     prerequisites;
  3. collection over the subtitle operations: CUE, ERR or NOCUE;
  4. diagnosis, only for R, from the restored (pre-guard) decision: the first matching row of the role's table (stage_r.diagnose), else the role's default;
and Stage R acceptance or INCOMPLETE (stage_r.acceptance).

The adjudication is an input written by the independent results reviewer: {"verdicts": [{"target": key, "cue": "t2.f1", "verdict": "accepted" |
"rejected" | "ambiguous"}]}.  A verdict for a cue that was never delivered is refused; a cited cue without a verdict leaves the diagnosis pending (INCOMPLETE).

Usage: stage_r_report.py --state OUT/stage-r-state.json --adjudication ADJ.json [--out report.json] [--md report.md]
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))

from media_repair_harness import stage_r as SR  # noqa: E402

REPORT_VERSION = 'stage-r-report-1'


def load_json(p):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return None


def target_record(st):
    g2 = st.get('g2') or {}
    for k in ('record', 'started_aborted'):
        if g2.get(k):
            rec = load_json(g2[k])
            if rec is not None:
                return rec
    return None


def load_verdicts(adjudication):
    """-> {target: {cue id: verdict}}; refuses an unknown verdict or a duplicate."""
    out = {}
    for v in (adjudication or {}).get('verdicts') or []:
        if v.get('verdict') not in SR.VERDICTS:
            raise ValueError('verdict %r for %s/%s is not one of %s' % (v.get('verdict'), v.get('target'), v.get('cue'), SR.VERDICTS))
        per = out.setdefault(v.get('target'), {})
        if v.get('cue') in per:
            raise ValueError('two verdicts for %s/%s' % (v.get('target'), v.get('cue')))
        per[v.get('cue')] = v['verdict']
    return out


def evaluate(state, adjudication):
    verdicts = load_verdicts(adjudication)
    targets = []
    for key, st in state['targets'].items():
        rec = target_record(st)
        res = SR.evaluate_target(key, st['role'], st.get('driver_outcome'), rec, verdicts.get(key, {}))
        delivered = {c['id'] for c in res['delivered_cues']}
        unknown = sorted(set(verdicts.get(key, {})) - delivered)
        if unknown:
            raise ValueError('adjudication names cues of %s that were never delivered: %s' % (key, unknown))
        res['driver_reason'] = st.get('reason')
        targets.append(res)
    unknown_targets = sorted(set(verdicts) - set(state['targets']))
    if unknown_targets:
        raise ValueError('adjudication names unknown targets: %s' % unknown_targets)
    return {'report': REPORT_VERSION, 'stop': state.get('stop'), 'early_stop': state.get('early_stop'), 'targets': targets,
            'stage_r': SR.acceptance(targets), 'cost_usd': state.get('cost_usd'), 'elapsed_s': state.get('elapsed_s'),
            'note': 'computed offline from the driver state, the run records and the adjudication; cue adjudication is the reviewer\'s input'}


def markdown(rep):
    lines = ['# Stage R report', '', '**Result: %s**' % rep['stage_r']['result'], '']
    for r in rep['stage_r']['reasons']:
        lines.append('- %s' % r)
    if rep.get('stop'):
        lines += ['', 'Driver stop: %(phase)s %(kind)s: %(detail)s' % rep['stop']]
    lines += ['', '| Target | Role | Execution | WRITE-CONTROL | Write attempts | Collection | Diagnosis | Row |', '|---|---|---|---|---|---|---|---|']
    for t in rep['targets']:
        lines.append('| %s | %s | %s | %s | %d | %s | %s | %s |' % (t['target'], t['role'], t['execution'], 'yes' if t['proposal_safety']['write_control'] else 'no',
                                                               len(t['proposal_safety']['attempts']), t['collection'], t.get('diagnosis') or '-', t.get('diagnosis_row') or '-'))
    return '\n'.join(lines) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--state', required=True)
    ap.add_argument('--adjudication', required=True)
    ap.add_argument('--out')
    ap.add_argument('--md')
    args = ap.parse_args(argv)
    state = load_json(args.state)
    adjudication = load_json(args.adjudication)
    if state is None or adjudication is None:
        print('cannot read the state or the adjudication', file=sys.stderr)
        return 2
    try:
        rep = evaluate(state, adjudication)
    except ValueError as e:
        print('bad input: %s' % e, file=sys.stderr)
        return 2
    text = json.dumps(rep, indent=2, sort_keys=True, ensure_ascii=False) + '\n'
    if args.out:
        Path(args.out).write_text(text)
    else:
        sys.stdout.write(text)
    if args.md:
        Path(args.md).write_text(markdown(rep))
    return 0


if __name__ == '__main__':
    sys.exit(main())
