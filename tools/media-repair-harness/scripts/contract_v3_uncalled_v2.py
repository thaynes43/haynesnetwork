#!/usr/bin/env python3
"""Offline count of uncalled available checks at the decision prefix with counter `uncalled-2` (W25 item 9), over the format v3.1-format records of dev-c7.

No model call, no tool run.  `scripts/contract_v3_uncalled.py` (counter uncalled-1, the dev-c6 logic) is unchanged and still writes
docs/contract-v3-uncalled.json for dev-c5.  This script applies uncalled-2 (experimental/contract_v3/uncalled_v2.py: links as the v3.1 session links them,
plus the EPUB body excerpt capability and unfetched pages) and, beside it, uncalled-1 on the same records, so the difference is visible.  The restored views
carry identical transcripts and are not counted twice.  Usage: contract_v3_uncalled_v2.py [--out FILE]"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness.experimental.contract_v3 import uncalled as UC1      # noqa: E402
from media_repair_harness.experimental.contract_v3 import uncalled_v2 as UC2   # noqa: E402

REPO = COMPONENT.parents[1]
SUITE = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
RUNS = {'claude-haiku-5-5': COMPONENT / 'runs' / 'dev-c7' / 'devc7-haiku-5-5', 'gpt-6-astra': COMPONENT / 'runs' / 'dev-c7' / 'devc7-gpt-6-astra',
        'qwen3.8:27b (re-registered pass)': COMPONENT / 'runs' / 'dev-c7-qwen-r2' / 'devc7r2-qwen3.8-27b',
        'qwen3.8:27b (aborted first pass, 5 cases)': COMPONENT / 'runs' / 'dev-c7' / 'devc7-qwen3.8-27b'}
KEYS = ('decisions', 'escalations', 'escalations_with_uncalled_available_check', 'budget_exhausted_escalations', 'non_escalations_with_uncalled_available_check',
        'by_tool', 'by_scope')


def pairs_of(run):
    out = []
    for p in sorted(run.glob('*-*-*.json')):
        rec = json.loads(p.read_text())
        raw = (SUITE / 'cases' / (rec['case_id'] + '.json')).read_bytes()
        if hashlib.sha256(raw).hexdigest() != rec['case_sha256']:
            raise SystemExit('case hash mismatch for a record of %s' % run.name)
        out.append((rec, json.loads(raw)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    out = {'note': 'neutral transcript observation: an available, offered, valid, not-yet-made check existed at the decision with budget left; not an error count',
           'counter': UC2.COUNTER_VERSION, 'suite': 'suite-dev-v1.1', 'runs': {}}
    for model, run in RUNS.items():
        pairs = pairs_of(run)
        s2 = UC2.summarise(pairs, SUITE)
        s1 = UC1.summarise(pairs, SUITE)
        out['runs'][model] = {'run': str(run.relative_to(COMPONENT)), UC2.COUNTER_VERSION: s2, 'uncalled-1 (unchanged counter, same records)': {k: s1[k] for k in KEYS}}
        print('%s: uncalled-2 escalations %d, with >= 1 uncalled available check %d (uncalled-1: %d); candidates by family %s, by scope %s; non-escalations with one %d (uncalled-1: %d)'
              % (model, s2['escalations'], s2['escalations_with_uncalled_available_check'], s1['escalations_with_uncalled_available_check'], s2['by_family'], s2['by_scope'],
                 s2['non_escalations_with_uncalled_available_check'], s1['non_escalations_with_uncalled_available_check']))
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
