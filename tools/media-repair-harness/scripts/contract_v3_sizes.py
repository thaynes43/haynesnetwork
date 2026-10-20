#!/usr/bin/env python3
"""Offline byte and page counts of the contract v3 presentation prototype on the dev-c5 first messages, next to the recorded format v2 ones.
Same frame (context, tools, capabilities), same page contract and budgets; no model call.  Usage: contract_v3_sizes.py [--out FILE]"""
import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import evidence_v2 as EV2   # noqa: E402
from media_repair_harness import protocol as P       # noqa: E402
from media_repair_harness import run as RUN          # noqa: E402
from media_repair_harness import tools as T          # noqa: E402
from media_repair_harness.experimental.contract_v3 import facts as FX   # noqa: E402

REPO = COMPONENT.parents[1]
SUITE = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
RUN_DIR = COMPONENT / 'runs' / 'dev-c5' / 'devc5-b-qwen3.8-27b'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    out = {}
    for budget in (8192, 2560):
        v2b, v3b, v2p, v3p, errors = [], [], [], [], 0
        for p in sorted(RUN_DIR.glob('*-*-*.json')):
            rec = json.loads(p.read_text())
            case = json.loads((SUITE / 'cases' / (rec['case_id'] + '.json')).read_text())
            fx = T.Fixture.from_case(case, SUITE)
            ctx = T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w20-'), suite_dir=SUITE, which=lambda _n: None, tools_behavior='v2', keep_raw=True)
            view = P.case_view(case, [], case_alias=rec['model_case_alias'])
            caps = T.capabilities(ctx)
            frame = {'case_id': view['case_id'], 'media_type': view['media_type'], 'context': view['context'], 'tools_available': view['tools_available'],
                     'tool_call_budget': view['tool_call_budget'], 'capabilities': caps, 'evidence_format': 'v3-prototype'}
            obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in RUN.resolve_evidence_raw(case, SUITE, ctx.redact)]
            ses = EV2.Session(rec['model_case_alias'], view['context'], view['media_type'], view['tools_available'], budget=budget)
            f2 = dict(frame, evidence_format='v2')
            _blk, n2 = ses.initial(obs, f2)
            v2b.append(ses.log[0]['bytes'][0])
            v2p.append(n2)
            try:
                r = FX.render(obs, view['context'], view['media_type'], view['tools_available'], caps, alias=rec['model_case_alias'], budget=budget, frame=frame)
            except EV2.PageBudgetError:
                errors += 1
                continue
            assert all(b <= budget for b in r['page_bytes'])
            v3b.append(r['page_bytes'][0])
            v3p.append(len(r['pages']))
        out[str(budget)] = {'cases': len(v2b), 'v2_first_bytes_median': statistics.median(v2b), 'v2_first_bytes_max': max(v2b), 'v3_first_bytes_median': statistics.median(v3b),
                            'v3_first_bytes_max': max(v3b), 'v2_multi_page_cases': sum(1 for n in v2p if n > 1), 'v3_multi_page_cases': sum(1 for n in v3p if n > 1),
                            'v3_page_budget_errors': errors, 'v3_max_pages': max(v3p)}
    print(json.dumps(out, indent=1))
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
