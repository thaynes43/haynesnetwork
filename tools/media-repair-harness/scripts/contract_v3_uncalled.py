#!/usr/bin/env python3
"""Offline count of uncalled available checks at the decision prefix of the dev-c5 records (contract v3, WO-W20 item 5 under A16 item 4).

No model call, no tool run: the recorded requests' observations are re-derived from the suite's case evidence and each record's own tool
results, the links from the capabilities each record says were advertised.  The restored views carry identical transcripts and are not counted
twice.  Usage: contract_v3_uncalled.py [--out FILE]   (prints the summary; --out writes it as JSON)."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness.experimental.contract_v3 import uncalled as UC   # noqa: E402

REPO = COMPONENT.parents[1]
SUITE = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
RUNS = {'claude-haiku-5-5': COMPONENT / 'runs' / 'dev-c5' / 'devc5-b-haiku-5-5', 'qwen3.8:27b': COMPONENT / 'runs' / 'dev-c5' / 'devc5-b-qwen3.8-27b'}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    out = {'note': 'neutral transcript observation: an available, offered, valid, not-yet-made check existed at the decision with budget left; not an error count',
           'suite': 'suite-dev-v1.1', 'runs': {}}
    for model, run in RUNS.items():
        pairs = []
        for p in sorted(run.glob('*-*-*.json')):
            rec = json.loads(p.read_text())
            cpath = SUITE / 'cases' / (rec['case_id'] + '.json')
            raw = cpath.read_bytes()
            if hashlib.sha256(raw).hexdigest() != rec['case_sha256']:
                raise SystemExit('case hash mismatch for a record of %s' % run.name)
            pairs.append((rec, json.loads(raw)))
        s = UC.summarise(pairs, SUITE)
        s['run'] = run.name
        out['runs'][model] = s
    for model, s in out['runs'].items():
        print('%s: decisions %d, escalations %d, escalations with >= 1 uncalled available check %d, budget-exhausted escalations %d; by tool %s; by scope %s; non-escalations with one %d'
              % (model, s['decisions'], s['escalations'], s['escalations_with_uncalled_available_check'], s['budget_exhausted_escalations'], s['by_tool'], s['by_scope'],
                 s['non_escalations_with_uncalled_available_check']))
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
