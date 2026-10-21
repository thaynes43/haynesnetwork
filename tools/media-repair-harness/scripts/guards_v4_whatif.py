#!/usr/bin/env python3
"""dev-c8 guards v4 what-if (WO-W26 item 4 with the AUDIT-ASTRA-36 item 2 accounting): apply guards v3 and v4 OFFLINE to recorded contract-v3 runs and write
one SHADOW record per case.  Nothing is rescored, overwritten or re-run; no model is called.  The v4 specification (guard_v4.V4_SPEC; it lived in decision_guard.py until review round 3) was frozen and
committed before this script first ran.

For every named input run (the online-guarded run directory; its `-restored` sibling holds the archived score of the model's ORIGINAL decisions):
  * the evidence is rebuilt exactly as the run built it (fixture names redacted by the case's own redactor; format v3.1-format EPUB evidence literal);
  * guards v3 are re-applied offline and must reproduce the recorded decision (a fidelity check, reported);
  * guards v4 are applied (v3 first, unchanged; then G-role);
  * the shadow record holds the original proposal, the v3 decision, the hypothetical v4 decision, the rule, the role checks with their evidence
    references, and the archived score facts of the original proposal (score.json of the restored run: unsafe_writes, false_diagnoses).
A write is score-correct by the archived facts exactly when it is in neither list (score.py: correct = class accepted and action supported; a write
outside the supported set is an unsafe write, a class not accepted is a false diagnosis).

Usage: guards_v4_whatif.py --suite <suite dir> --out <dir> <run dir> [<run dir> ...]
"""
import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))

from media_repair_harness import decision_guard as DG  # noqa: E402
from media_repair_harness import guard_v4 as GV4  # noqa: E402
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import tools as T  # noqa: E402

SHADOW_VERSION = 'guards-v4-whatif-2'   # -2 (review round 1): adds source_reference to each record; every decision and count of -1 is unchanged (tests/test_devc8.py)
BINDING_CHECKS = ('A-REN-0', 'A-BLK-2', 'A-MAP-2', 'A-CNV-0')
NON_RECORDS = ('manifest.json', 'score.json', 'run_summary.json')


def shown_evidence(rec, case, suite_dir):
    """The case evidence as run_case built it for this record's format."""
    v31 = (rec.get('evidence_format') or {}).get('version') == 'v3.1-format'
    ctx = T.Context(case, T.Fixture.from_case(case, suite_dir), tempfile.mkdtemp(prefix='mrh-w26-'), suite_dir=suite_dir, which=lambda _n: None,
                    tools_behavior='v3' if v31 else 'v2', keep_raw=True)
    return R.resolve_evidence_raw(case, suite_dir, ctx.redact, literal_epub=v31)


def source_reference(original, rec, case, shown):
    """The form of the cited source and whether the binding prerequisite was met, so the reference-form category is countable from data:
    evidence_id (a result the model was shown, or a page of one), case_item, context_arr_id (a value of context.arr.ids), other."""
    src = (original.get('source') or {}).get('ref') if isinstance(original.get('source'), dict) else None
    if src is None:
        return None
    shown_ids = {e.get('id') for e in shown} | {c.get('id') for c in rec.get('tool_calls') or []}
    arr_ids = {str(v) for v in (((case.get('context') or {}).get('arr') or {}).get('ids') or {}).values() if v is not None}
    kind = 'case_item' if src == 'case_item' else 'evidence_id' if src in shown_ids else 'context_arr_id' if src in arr_ids else 'other'
    return {'cited': src, 'kind': kind}


def _rule(guard):
    return guard['applied'][0]['rule'] if guard.get('final_changed') else None


def _da(d):
    return '%s/%s' % ((d or {}).get('class'), (d or {}).get('action'))


def shadow_run(run_dir, suite_dir, cases, shas, root):
    run_dir = Path(run_dir)
    restored = run_dir.parent / (run_dir.name + '-restored') / 'score.json'
    score = json.loads(restored.read_text()) if restored.exists() else None
    unsafe = set(((score or {}).get('g1_context') or {}).get('unsafe_writes', {}).get('cases') or [])
    false_diag = set(((score or {}).get('metrics') or {}).get('false_diagnoses', {}).get('cases') or [])
    shadows = []
    for f in sorted(run_dir.glob('*.json')):
        if f.name in NON_RECORDS:
            continue
        rec = json.loads(f.read_text())
        cid = rec['case_id']
        case = cases.get(cid)
        if case is None or rec.get('case_sha256') != shas.get(cid):
            raise SystemExit('record %s does not match its suite case (case_sha256); refusing' % f)
        shown = shown_evidence(rec, case, suite_dir)
        guard = rec.get('guard') or {}
        original = guard['applied'][0]['original'] if guard.get('final_changed') else rec['decision']
        g3 = DG.apply_to_record(rec, case, shown, 'v3')
        g4 = DG.apply_to_record(rec, case, shown, 'v4')
        write = original.get('action') in P.WRITE_ACTIONS
        v3_changed, v4_changed = g3['guard']['final_changed'], g4['guard']['final_changed']
        audit_pre = {p['id']: p['state'] for p in ((rec.get('action_audit') or {}).get('prerequisites') or [])} if not guard.get('final_changed') else None
        role = g4['guard'].get('role_checks') or []
        ref = source_reference(original, rec, case, shown)
        if ref is not None:
            ref['binding'] = next((c['audit_state'] for c in role if c['id'] in BINDING_CHECKS), None)
        sh = {
            'shadow_version': SHADOW_VERSION, 'run': run_dir.name, 'input_record': str(f.relative_to(root)),
            'input_record_sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'case_id': cid,
            'original_proposal': original,
            'v3': {'decision': g3['decision'], 'rule': _rule(g3['guard']), 'changed': v3_changed, 'recorded_decision_reproduced': g3['decision'] == rec['decision']},
            'v4': {'decision': g4['decision'], 'rule': _rule(g4['guard']), 'changed': v4_changed, 'role_checks': role,
                   'reason': g4['guard']['applied'][0]['reason'] if v4_changed else None},
            'newly_intercepted_by_v4': bool(v4_changed and not v3_changed),
            'direction': ('%s -> %s' % (_da(original), _da(g4['decision']))) if (v4_changed and not v3_changed) else None,
            'audit_fidelity': None if audit_pre is None else {c['id']: {'record': audit_pre.get(c['id']), 'recomputed': c['audit_state']} for c in role
                                                              if audit_pre.get(c['id']) != c['audit_state']},
            'source_reference': ref,
            'score_facts': {'source': str(restored.relative_to(root)) if score else None,
                            'original_unsafe_write': cid in unsafe, 'original_false_diagnosis': cid in false_diag,
                            'original_score_correct_write': (write and cid not in unsafe and cid not in false_diag) if score else None},
            'note': 'what-if only: the run was not rescored, re-run or overwritten; no model call',
        }
        shadows.append(sh)
    return shadows, score is not None


def summarize(name, shadows, scored):
    writes = [s for s in shadows if s['original_proposal'].get('action') in P.WRITE_ACTIONS]
    new = [s for s in shadows if s['newly_intercepted_by_v4']]
    status = {}
    for s in shadows:
        for c in s['v4']['role_checks']:
            status.setdefault(c['id'], {}).setdefault(c['v4_status'], 0)
            status[c['id']][c['v4_status']] += 1
    unsafe = [s['case_id'] for s in shadows if s['score_facts']['original_unsafe_write']]
    caught = {s['case_id'] for s in shadows if s['v4']['changed']}
    return {
        'run': name, 'records': len(shadows), 'archived_score_facts': scored,
        'original_write_proposals': [s['case_id'] for s in writes],
        'original_unsafe_proposals_unchanged': unsafe,
        'original_unsafe_left_by_v3': [c for c in unsafe if not next(s for s in shadows if s['case_id'] == c)['v3']['changed']],
        'original_unsafe_left_by_v4': [c for c in unsafe if c not in caught],
        'intercepted_by_v3': [s['case_id'] for s in shadows if s['v3']['changed']],
        'newly_intercepted_by_v4': [{'case_id': s['case_id'], 'direction': s['direction'], 'rule': s['v4']['rule'],
                                     'enforced': [c['id'] for c in s['v4']['role_checks'] if c['v4_status'] == 'enforced']} for s in new],
        'newly_intercepted_score_correct_writes': [s['case_id'] for s in new if s['score_facts']['original_score_correct_write']],
        'newly_intercepted_unsafe_writes': [s['case_id'] for s in new if s['score_facts']['original_unsafe_write']],
        'newly_intercepted_false_diagnoses': [s['case_id'] for s in new if s['score_facts']['original_false_diagnosis']],
        'role_status_counts': {k: dict(sorted(v.items())) for k, v in sorted(status.items())},
        'newly_intercepted_by_reference': _by_reference(new),
        'write_proposals_by_reference': _by_reference(writes),
        'v3_replay_mismatches': [s['case_id'] for s in shadows if not s['v3']['recorded_decision_reproduced']],
        'audit_fidelity_differences': {s['case_id']: s['audit_fidelity'] for s in shadows if s['audit_fidelity']},
    }


def _by_reference(shadows):
    out = {}
    for s in shadows:
        r = s.get('source_reference') or {'kind': 'no_source', 'binding': None}
        key = '%s, binding %s' % (r['kind'], r.get('binding'))
        out[key] = out.get(key, 0) + 1
    return dict(sorted(out.items()))


def render_md(summary):
    out = ['# Guards v4 what-if (dev-c8, offline shadow records)', '',
           'Frozen specification: `src/media_repair_harness/decision_guard.py` `V4_SPEC` (committed before this ran). Generated by `scripts/guards_v4_whatif.py`; '
           'one shadow record per case under this directory. Nothing was rescored, re-run or overwritten; no model was called. Score facts are the archived '
           '`score.json` of each run\'s `-restored` sibling (the model\'s original decisions).', '']
    out += ['| Run | Records | Original writes | Original unsafe (unchanged) | Unsafe left by v3 | Unsafe left by v4 | Intercepted by v3 | Newly intercepted by v4 | of which score-correct writes | v3 replay mismatches |',
            '|---|---:|---:|---|---|---|---|---|---|---:|']
    for s in summary['runs']:
        out.append('| `%s` | %d | %d | %s | %s | %s | %s | %s | %s | %d |' % (
            s['run'], s['records'], len(s['original_write_proposals']), ', '.join(s['original_unsafe_proposals_unchanged']) or 'none',
            ', '.join(s['original_unsafe_left_by_v3']) or 'none', ', '.join(s['original_unsafe_left_by_v4']) or 'none',
            ', '.join(s['intercepted_by_v3']) or 'none', ', '.join('%s (%s; %s)' % (n['case_id'], n['direction'], ', '.join(n['enforced'])) for n in s['newly_intercepted_by_v4']) or 'none',
            ', '.join(s['newly_intercepted_score_correct_writes']) or 'none', len(s['v3_replay_mismatches'])))
    out += ['', 'Cited source form of the newly intercepted proposals (kind, binding prerequisite state):', '']
    for s in summary['runs']:
        out.append('- `%s`: %s' % (s['run'], '; '.join('%s: %d' % kv for kv in s['newly_intercepted_by_reference'].items()) or 'none'))
    out += ['', 'Role-check statuses per run (prerequisite id: status counts over the original write proposals):', '']
    for s in summary['runs']:
        out.append('- `%s`: %s' % (s['run'], '; '.join('%s %s' % (k, ', '.join('%s %d' % kv for kv in v.items())) for k, v in s['role_status_counts'].items()) or 'no write proposal'))
    out.append('')
    return '\n'.join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--suite', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--root', default=str(HERE.parent), help='paths in the shadow records are relative to this directory (default: the component)')
    ap.add_argument('runs', nargs='+')
    a = ap.parse_args(argv)
    suite_dir = R.suite_root(a.suite)
    loaded = R.load_cases(a.suite)
    cases = {c['id']: c for c, _s in loaded}
    shas = {c['id']: s for c, s in loaded}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    root = Path(a.root).resolve()
    summary = {'shadow_version': SHADOW_VERSION, 'guards_v4_spec_sha256': hashlib.sha256(json.dumps(GV4.V4_SPEC, sort_keys=True).encode()).hexdigest(),
               'inputs': [str(Path(r).resolve().relative_to(root)) for r in a.runs], 'runs': []}
    for r in a.runs:
        shadows, scored = shadow_run(Path(r).resolve(), suite_dir, cases, shas, root)
        d = out / Path(r).name
        d.mkdir(parents=True, exist_ok=True)
        for s in shadows:
            (d / (s['case_id'] + '.json')).write_text(json.dumps(s, indent=1, sort_keys=True, ensure_ascii=False) + '\n')
        summary['runs'].append(summarize(Path(r).name, shadows, scored))
    (out / 'summary.json').write_text(json.dumps(summary, indent=1, sort_keys=True) + '\n')
    (out / 'summary.md').write_text(render_md(summary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
