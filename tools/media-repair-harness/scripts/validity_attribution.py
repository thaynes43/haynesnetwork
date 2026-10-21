#!/usr/bin/env python3
"""Proposed attribution for the blinded validity run (#159), applying PREREGISTRATION.md §13 as amended by §14.

Offline, no model call.  It computes every MECHANICAL part of the ordered table and marks each case whose category needs a
reviewer judgement (`reviewer` lists what).  The coordinator's output is a PROPOSAL: the independent results reviewer
assigns the final category, and any disagreement is D (§13 item 7).  Reads the run's records (guarded and restored), the
frozen predictions-a5.json, ceiling-a5.json and score.py's per-case facts.

    python3 scripts/validity_attribution.py --run <run> --restored <run>-restored --suite <suite> \
        --predictions runs/dev-validity-opus55/predictions-a5.json --ceiling runs/dev-validity-opus55/ceiling-a5.json --out-json <file>
"""
import argparse
import glob
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import score_compat  # noqa: E402

WRITES = ('blocklist_and_search', 'remap', 'rename', 'convert')


def first_case(rec):
    p = rec['turns'][0]['raw_request']['prompt']
    return json.loads(p[p.index('[CASE]') + 6:p.index('\n\n[HARNESS]')].strip())


def delivered_known_defect(rec):
    """A known_defect finding in any delivered tool result (the mechanical healthy/none defeater)."""
    for tc in rec.get('tool_calls', []):
        try:
            out = json.loads(tc.get('output') or '{}')
        except ValueError:
            continue
        for f in out.get('findings', []) or []:
            if isinstance(f, dict) and f.get('known_defect') is True:
                return tc['id']
    return None


def ablk3_ok(rec, refs):
    """Each non-ok reference is an initial error result carrying a located known_defect whose cause is not 'tool' (A-BLK-3)."""
    items = {it['id']: it for it in first_case(rec)['evidence']['items']}
    for ref in refs:
        it = items.get(ref)
        if not it:
            return False
        ex = it.get('execution') or {}
        if ex.get('status') != 'error' or ex.get('cause') == 'tool':
            return False
        if not any(isinstance(f, dict) and f.get('known_defect') is True and f.get('location') for f in it.get('findings', []) or []):
            return False
    return True


def warranted_tools(entries):
    return [e.split(' ', 1)[0] for e in entries]


def attribute(rec, pred, never, facts, guarded_view, guard_changed):
    d = rec['decision']
    dec = (d['class'], d['action'])
    out = {'decision': list(dec), 'score_correct': facts['correct'], 'reviewer': []}
    calls = [(tc['tool'], tc.get('args') or {}) for tc in rec.get('tool_calls', [])]
    wt = warranted_tools(pred['warranted'])
    out['warranted_attempted'] = {w: any(t == w for t, _ in calls) for w in wt}
    out['T'] = any(t not in wt for t, _ in calls)
    opts = [('cf', tuple(pred['cf']), None)] + [('alt%d' % i, tuple(a), pred['alt_kind'][i]) for i, a in enumerate(pred['alt'])]
    match = next(((k, kind) for k, o, kind in opts if o == dec), None)
    out['match'] = match[0] if match else None
    if (rec.get('error') or {}).get('kind') in ('harness_crash', 'adapter_error') or rec.get('leakguard_refusal'):
        out['category'] = 'H'; return out
    if rec.get('forced'):
        out['category'] = 'F'; return out
    if guarded_view and guard_changed:
        out['category'] = 'G'; return out
    if not all(out['warranted_attempted'].values()):
        out['category'] = 'D'; out['reviewer'].append('row 4: a warranted check was never attempted (note B1 or why not)'); return out
    audit = rec.get('action_audit') or {}
    states = {p['id']: p['state'] for p in audit.get('prerequisites', [])}
    unmet = [k for k, s in states.items() if s == 'unmet']
    unknown = [k for k, s in states.items() if s == 'unknown']
    is_write = dec[1] in WRITES
    # Step 2 admissibility: requires (content) -> reviewer confirms; mechanical defeater for healthy/none
    if match:
        req = pred.get('requires', {}).get(match[0], [])
        if req:
            out['reviewer'].append('Step 2: confirm the required content was delivered: ' + '; '.join(req))
        if dec[0] == 'healthy' or dec[1] == 'none':
            kd = delivered_known_defect(rec)
            if kd:
                match = None
                out['match'] = None
                out['defeated_by'] = kd
    if not match:   # row 5
        if is_write and unmet:
            out['category'] = 'B4'
        elif dec[1] in ('escalate', 'none') and pred['cf'] != list(dec):
            out['category'] = 'B5'
            out['reviewer'].append('row 5 B5: confirm the reference was admissible at this prefix (else D / prediction error)')
        else:
            out['category'] = 'D'
            out['reviewer'].append('row 5: no listed option matches; the reviewer records B1/B2 or a prediction error')
        out['unmet'], out['unknown'] = unmet, unknown
        return out
    # row 6: unresolved judgement
    hj = pred.get('hand_judgement', {}).get(match[0], {})
    unresolved_unknown = [k for k in unknown if k not in hj.get('prerequisites', [])] if is_write else []
    if is_write and unknown and not unresolved_unknown:
        out['reviewer'].append('row 6: confirm hand_judgement %s on the transcript (unconfirmed -> D)' % hj.get('prerequisites'))
    if unresolved_unknown:
        out['category'] = 'D'; out['reviewer'].append('row 6: unknown prerequisites without a hand judgement: %s' % unresolved_unknown)
        out['unmet'], out['unknown'] = unmet, unknown
        return out
    # Step 3(a) consistency checks
    fails = []
    if rec.get('bad_evidence_refs'):
        fails.append('bad_evidence_refs')
    if rec.get('protocol_violations'):
        fails.append('protocol_violations')
    wr = rec.get('write_rejection') or {}
    if wr.get('rejected_write_attempts'):
        fails.append('write_rejection (%d rejected write attempt(s): %s)' % (wr['rejected_write_attempts'], '; '.join(sorted({e for a in wr.get('attempts', []) for e in a.get('errors', [])}))))
    nonok = rec.get('refs_to_non_ok_tools') or []
    if nonok and not ablk3_ok(rec, nonok):
        fails.append('refs to non-ok results outside the A-BLK-3 exception: %s' % nonok)
    if is_write and unmet:
        fails.append('unmet write prerequisites: %s' % unmet)
    out['reviewer'].append('Step 3(a): confirm the reason asserts nothing not delivered')
    out['consistency_failures'] = fails
    if fails:
        if facts['correct']:
            out['category'] = 'P!'
        elif is_write and unmet:
            out['category'] = 'B4'
        else:
            out['category'] = 'B2'
        return out
    if facts['correct']:
        out['category'] = 'P'
    elif rec['case_id'] in never:
        out['category'] = 'A1'
    elif match[1] is None and any(k == 'ii' for k in pred['alt_kind']):
        out['category'] = 'A2'
    elif match[1] == 'i':
        out['category'] = 'A3'
    else:
        out['category'] = 'D'; out['reviewer'].append('row 14: no other row applies')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    for k in ('run', 'restored', 'suite', 'predictions', 'ceiling'):
        ap.add_argument('--' + k, required=True)
    ap.add_argument('--out-json', required=True)
    a = ap.parse_args(argv)
    score_mod = score_compat.load_score()
    cases = {c['id']: c for c, _ in R.load_cases(a.suite)}
    pred = json.loads(Path(a.predictions).read_text())['cases']
    never = set(json.loads(Path(a.ceiling).read_text())['never_correct_under_contract'])
    result = {'tool': 'validity_attribution.py', 'note': 'coordinator PROPOSAL; the independent results reviewer assigns the final category; disagreement -> D',
              'views': {}}
    for view, d in (('restored', a.restored), ('guarded', a.run)):
        rows = {}
        for f in sorted(glob.glob(os.path.join(d, '*-*-[0-9]*.json'))):
            rec = json.loads(Path(f).read_text())
            cid = rec['case_id']
            facts = score_mod.case_facts(cases[cid], rec)
            gch = bool((rec.get('guard') or {}).get('final_changed'))
            rows[cid] = attribute(rec, pred[cid], never, facts, view == 'guarded', gch)
        counts = {}
        for r in rows.values():
            counts[r['category']] = counts.get(r['category'], 0) + 1
        reach = [c for c, r in rows.items() if r['category'] in ('P', 'A1', 'A2', 'A3')]
        result['views'][view] = {'counts': dict(sorted(counts.items())), 'cases': rows,
                                 'reaches_reference': {'all': len(reach), 'without_T': sum(not rows[c]['T'] for c in reach),
                                                       'without_A3': sum(rows[c]['category'] != 'A3' for c in reach),
                                                       'without_T_and_A3': sum(not rows[c]['T'] and rows[c]['category'] != 'A3' for c in reach)},
                                 'T_cases': sorted(c for c, r in rows.items() if r['T'])}
    Path(a.out_json).write_text(json.dumps(result, indent=1, sort_keys=True) + '\n')
    v = result['views']['restored']
    print('restored counts', v['counts'], 'reaches', v['reaches_reference'])
    print('guarded counts', result['views']['guarded']['counts'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
