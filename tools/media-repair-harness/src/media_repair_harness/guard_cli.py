"""`mrh-guard <run dir> --suite <suite dir> --out <dir>`: apply the dev-c4 decision guards (`--guards v1`) offline to existing run records.

No model is called and nothing is run.  The input run directory is only read; every record is COPIED (deep copy) into --out with a
`guard` field, and when a guard fires the copy's `decision` and the fields derived from it are replaced (the model's original decision stays
in `guard.applied[].original`).  The output directory also gets a manifest (copied, with a `guard_whatif` note), a run_summary (copied, with
a `guards` block) and an audit.jsonl for the final decisions, so it scores with the unchanged `score.py` (`mrh-score <out> --suite <suite>`).
The suite is needed because a record names the evidence it showed but not its status or tool; --suite defaults to the manifest's suite_dir
when that still exists.
"""
import argparse
import json
import sys
from pathlib import Path

from . import decision_guard as DG
from . import protocol as P
from . import run as R

SKIP = ('manifest.json', 'run_summary.json', 'score.json')


def load_run_records(run_dir):
    recs = []
    for f in sorted(Path(run_dir).glob('*.json')):
        if f.name in SKIP:
            continue
        d = json.loads(f.read_text())
        if isinstance(d, dict) and 'case_id' in d and 'decision' in d:
            recs.append(d)
    return recs


def guard_run(run_dir, suite, out_dir, restore=False, version=DG.GUARD_VERSION):
    """-> {'records': n, 'changed': [{case_id, rule, before, after}], 'by_rule': {...}}"""
    run_dir, out_dir = Path(run_dir), Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise SystemExit('refusing to reuse a non-empty output directory: %s' % out_dir)
    suite_dir = R.suite_root(suite)
    loaded = R.load_cases(suite)
    cases = {c['id']: c for c, _ in loaded}
    shas = {c['id']: s for c, s in loaded}
    out_dir.mkdir(parents=True, exist_ok=True)
    changed, by_rule, finals = [], {}, []
    for rec in load_run_records(run_dir):
        case = cases.get(rec['case_id'])
        if case is None:
            raise SystemExit('record %s has no case in the suite %s' % (rec['case_id'], suite))
        if rec.get('case_sha256') != shas[rec['case_id']]:
            # the guards read the case's evidence; a record made against another version of the case would be judged on the wrong data
            raise SystemExit('record %s: case_sha256 %s does not match the case in the suite %s (%s); refusing to guard it' % (
                rec['case_id'], rec.get('case_sha256'), suite, shas[rec['case_id']]))
        if not restore and version != 'v3' and (rec.get('evidence_format') or {}).get('version') in ('v3', 'v3.1-format'):
            # contract v3 is valid with guards off or v3 only (run.check_option_combination); an offline re-guard must not create another combination
            raise SystemExit('record %s is a contract-v3 record (evidence format %s): only --guards v3 (or --restore) applies to it, not --guards %s' % (rec['case_id'], rec['evidence_format']['version'], version))
        shown = R.resolve_evidence_raw(case, suite_dir) if rec.get('evidence_format') else R.resolve_evidence(case, suite_dir)
        new = DG.restore_original(rec, case, shown) if restore else DG.apply_to_record(rec, case, shown, version)
        for a in ([] if restore else new['guard']['applied']):
            by_rule[a['rule']] = by_rule.get(a['rule'], 0) + 1
            o = a['original']
            changed.append({'case_id': rec['case_id'], 'rule': a['rule'], 'before': '%s/%s' % (o.get('class'), o.get('action')),
                            'after': '%s/%s' % (new['decision']['class'], new['decision']['action']), 'reason': a['reason']})
        (out_dir / (rec['case_id'] + '.json')).write_text(json.dumps(new, indent=2, ensure_ascii=False, sort_keys=True) + '\n')
        finals.append(new)
    manifest = json.loads((run_dir / 'manifest.json').read_text()) if (run_dir / 'manifest.json').is_file() else {}
    source_guards = (manifest.get('config') or {}).get('guards')
    if restore:
        # the restored records hold the model's own decisions: the source's recorded guard setting no longer describes them
        (manifest.get('config') or {}).pop('guards', None)
    elif source_guards is not None and manifest.get('config'):
        manifest['config']['guards'] = version    # re-guarding a guarded run: the copies carry the version applied here
    manifest['guard_whatif'] = {'guards': None if restore else version, 'source_guards': source_guards, 'source_run': run_dir.name, 'offline': True, 'model_calls': 0, 'restore': bool(restore), 'source_run': run_dir.name, 'offline': True, 'model_calls': 0, 'restore': bool(restore),
                                'note': ('records copied from a guarded run with the model\'s original decisions restored (the run scored as if guards were off)' if restore else
                                         'records copied from the source run with the decision guards applied offline') + '; nothing was re-run'}
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str) + '\n')
    summary = json.loads((run_dir / 'run_summary.json').read_text()) if (run_dir / 'run_summary.json').is_file() else {}
    if restore:
        if 'guards' in summary:     # the source's counts (decisions_changed ...) describe the guarded decisions, not these copies
            summary['guards'] = {'version': None, 'restored_from': (summary['guards'] or {}).get('version'), 'decisions_changed': 0}
    else:
        summary['guards'] = R.guard_summary(finals)
    (out_dir / 'run_summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True, default=str) + '\n')
    with open(out_dir / 'audit.jsonl', 'w') as audit:
        for rec in finals:
            audit.write(R.canonical({'run_id': rec.get('run_id'), 'case_id': rec['case_id'], 'case_sha256': rec.get('case_sha256'), 'at': rec.get('started_at'),
                                     'forced': rec.get('forced'), **rec['action_audit']}) + '\n')
    return {'records': len(finals), 'changed': changed, 'by_rule': by_rule}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('run_dir', help='an existing run directory (read only)')
    ap.add_argument('--out', required=True, help='new directory for the guarded copies (must be empty or absent)')
    ap.add_argument('--restore', action='store_true', help='the inverse: the input is a guarded run; write copies with the model\'s original decisions back (scores the run as if guards were off)')
    ap.add_argument('--guards', choices=list(DG.GUARD_VERSIONS), default=DG.GUARD_VERSION, help='guard version to apply (default v1, the measured one; v2 relaxes two G-write checks)')
    ap.add_argument('--suite', help='suite directory (with cases/); default: the manifest suite_dir when it exists')
    args = ap.parse_args(argv)
    suite = args.suite
    if not suite:
        try:
            suite = json.loads((Path(args.run_dir) / 'manifest.json').read_text()).get('suite_dir')
        except (OSError, ValueError):
            suite = None
        if not suite or not Path(suite).exists():
            raise SystemExit('--suite is required (the manifest suite_dir %r does not exist here)' % (suite,))
    res = guard_run(args.run_dir, suite, args.out, restore=args.restore, version=args.guards)
    for c in res['changed']:
        print('%s: %s -> %s (%s)' % (c['case_id'], c['before'], c['after'], c['rule']))
    print('guards %s: %d records, %d changed %s' % (args.guards, res['records'], len(res['changed']), json.dumps(res['by_rule'], sort_keys=True)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
