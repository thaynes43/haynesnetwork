#!/usr/bin/env python3
"""dev-c7 offline size measurement (WO-W22 item 3; no model call, no network): the page and context budgets of format v3.1-format / tools v3 over BOTH public
suites (suite-dev-v1 and suite-dev-v1.1), against format v3 / tools v2 on the same cases.

It reads only the public suites and their fixtures.  A case whose fixture is not available in this checkout is COUNTED as unavailable coverage and skipped; a
case whose locator names the forbidden harness cache is skipped without resolving it.  It prints and writes aggregate counts only (medians, maxima, page counts):
no excerpt text, no case id, no label.  The extraction rules were frozen (commit 97b30d34) before this script first ran.

    PYTHONPATH=tools/media-repair-harness/src nice -n 19 python3 tools/media-repair-harness/scripts/devc7_sizes.py [--out docs/devc7-sizes.json]
"""
import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
REPO = COMPONENT.parents[1]
sys.path.insert(0, str(COMPONENT / 'src'))

from media_repair_harness import epub_text as ET          # noqa: E402
from media_repair_harness import evidence_v2 as EV2       # noqa: E402
from media_repair_harness import evidence_v3 as EV3       # noqa: E402
from media_repair_harness import evidence_v31 as EV31     # noqa: E402
from media_repair_harness import leakguard                # noqa: E402
from media_repair_harness import protocol as P            # noqa: E402
from media_repair_harness import run as R                 # noqa: E402
from media_repair_harness import tools as T               # noqa: E402

H = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
SUITES = {'suite-dev-v1': H / 'suite', 'suite-dev-v1.1': H / 'suite-dev-v1.1'}
FORBIDDEN_CACHE = 'media-repair-harness-1019'
BUDGETS = (8192, 4096, 2560)


def stats(xs):
    xs = list(xs)
    return {'n': len(xs), 'median': statistics.median(xs) if xs else None, 'max': max(xs) if xs else None}


def setup(case, suite_dir, fmt, budget):
    behavior = 'v3' if fmt == 'v3.1-format' else 'v2'
    fixture = T.Fixture.from_case(case, suite_dir)
    ctx = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w22-size-'), which=lambda _n: None, suite_dir=suite_dir, tools_behavior=behavior, keep_raw=True)
    evidence = R.resolve_evidence_raw(case, suite_dir, ctx.redact)
    alias = leakguard.alias('size', case['id'])
    view = P.case_view(case, [], case_alias=alias)
    caps = T.capabilities(ctx)
    mod = EV31 if fmt == 'v3.1-format' else EV3
    session = mod.Session(alias, view['context'], view['media_type'], view['tools_available'], caps, budget=budget)
    frame = {'case_id': view['case_id'], 'media_type': view['media_type'], 'context': view['context'], 'tools_available': view['tools_available'],
             'tool_call_budget': view['tool_call_budget'], 'capabilities': caps, 'evidence_format': mod.FORMAT_VERSION}
    block, npages = session.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], frame)
    first = EV2.nbytes(EV2.canon(dict(frame, evidence=block)))
    return ctx, session, first, npages


def call(ctx, session, args, call_id='t1'):
    res = T.call_tool(ctx, 'epub_inspect', args)
    obs = EV2.make_observation(call_id, 'epub_inspect', EV2.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool')
    text, npages = session.result(obs, call_id, 5)
    return res, EV2.nbytes(text.split('\n')[0]), npages, session.log[-1]['bytes']


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', help='write the aggregate JSON here')
    args = ap.parse_args(argv)
    report = {'note': 'aggregates only; offline; no model call; format v3.1-format / tools v3 against format v3 / tools v2 on the same cases',
              'excerpt_rule': ET.RULE_ID, 'excerpt_rules_sha256': ET.rules_digest(), 'suites': {}}
    for name, sdir in SUITES.items():
        cases = [json.loads(p.read_text()) for p in sorted((sdir / 'cases').glob('*.json'))]
        cases = [c for c in cases if c.get('split', 'dev') == 'dev']
        out = {'cases': len(cases), 'first_message': {}, 'epub': {}}
        for budget in BUDGETS:
            row = {}
            for fmt in ('v3', 'v3.1-format'):
                firsts, pages, errors, ests = [], [], 0, []
                system = P.get_prompt('v7' if fmt == 'v3.1-format' else 'v6')['text']
                for c in cases:
                    if FORBIDDEN_CACHE in str((c.get('fixture') or {}).get('locator') or ''):
                        continue
                    try:
                        _ctx, _s, first, npages = setup(c, sdir, fmt, budget)
                    except EV2.PageBudgetError:
                        errors += 1
                        continue
                    firsts.append(first)
                    pages.append(npages)
                    ests.append(int((len(system) + first) / 3.0))      # the Ollama adapter's pessimistic estimate (3 characters per token; bytes as an upper bound)
                row[fmt] = {'first_page_bytes': stats(firsts), 'multi_page_first_messages': sum(1 for p in pages if p > 1), 'max_pages': max(pages) if pages else None,
                            'page_budget_errors': errors, 'system_plus_first_tokens_estimate': stats(ests), 'estimate_at_or_over_8192_tokens': sum(1 for e in ests if e >= 8192)}
            out['first_message'][str(budget)] = row
        epub_cases = [c for c in cases if 'epub_inspect' in (c.get('tools_available') or [])]
        ep = {'offering_epub_inspect': len(epub_cases), 'unavailable_here': 0, 'forbidden_cache_skipped': 0}
        sizes = {str(b): {'v2_default_wire_bytes': [], 'v3_default_wire_bytes': [], 'v3_default_pages': [], 'v3_max_excerpt_wire_bytes': [], 'v3_max_excerpt_pages': []}
                 for b in BUDGETS}
        raw_v2, raw_v3, items_total, headings, toc = [], [], [], [], {'nav': 0, 'ncx': 0, 'none': 0, 'error': 0}
        for c in epub_cases:
            if FORBIDDEN_CACHE in str((c.get('fixture') or {}).get('locator') or ''):
                ep['forbidden_cache_skipped'] += 1
                continue
            ctx3, _s, _f, _n = setup(c, sdir, 'v3.1-format', 8192)
            probe = T.call_tool(ctx3, 'epub_inspect', {})
            if probe['status'] != 'ok':
                ep['unavailable_here'] += 1 if probe['status'] == 'unavailable' else 0
                ep.setdefault('not_ok_default_call', {}).setdefault(probe['status'], 0)
                ep['not_ok_default_call'][probe['status']] += 1
                continue
            data = json.loads(probe['raw_output'])
            raw_v3.append(EV2.nbytes(probe['raw_output']))
            body = data.get('body') or {}
            items_total.append(body.get('items_total') or 0)
            headings.append(sum(len(i.get('headings') or []) for i in body.get('index') or []))
            t = data.get('declared_toc')
            toc['none' if t is None else ('error' if 'error' in t else t.get('source'))] += 1
            for budget in BUDGETS:
                b = str(budget)
                ctx2, s2, _f, _n = setup(c, sdir, 'v3', budget)
                r2, w2, _p2, _l2 = call(ctx2, s2, {})
                if budget == 8192:
                    raw_v2.append(EV2.nbytes(r2['raw_output']))
                sizes[b]['v2_default_wire_bytes'].append(w2)
                ctx3, s3, _f, _n = setup(c, sdir, 'v3.1-format', budget)
                _r3, w3, p3, _l3 = call(ctx3, s3, {})
                sizes[b]['v3_default_wire_bytes'].append(w3)
                sizes[b]['v3_default_pages'].append(p3)
                _r4, w4, p4, _l4 = call(ctx3, s3, {'spine': 0, 'offset': 0, 'length': ET.MAX_EXCERPT_CHARS}, 't2')
                sizes[b]['v3_max_excerpt_wire_bytes'].append(w4)
                sizes[b]['v3_max_excerpt_pages'].append(p4)
        ep['measured'] = len(raw_v3)
        ep['raw_tool_output_bytes'] = {'tools_v2': stats(raw_v2), 'tools_v3': stats(raw_v3)}
        ep['spine_items'] = stats(items_total)
        ep['observed_headings_in_index'] = stats(headings)
        ep['declared_toc_source'] = toc
        ep['wire'] = {b: {k: (stats(v) if 'bytes' in k else {'max': max(v) if v else None, 'multi_page': sum(1 for x in v if x > 1)}) for k, v in d.items()}
                      for b, d in sizes.items()}
        out['epub'] = ep
        report['suites'][name] = out
    v6, v7 = P.get_prompt('v6')['text'], P.get_prompt('v7')['text']
    report['prompt'] = {'v6_bytes': len(v6.encode()), 'v7_bytes': len(v7.encode()), 'v7_minus_v6_bytes': len(v7.encode()) - len(v6.encode()),
                        'v6_tokens_estimate_3cpt': len(v6) // 3, 'v7_tokens_estimate_3cpt': len(v7) // 3,
                        'context_note': 'the 8192-token local context of the qwen runs is the binding budget: the system prompt and every message share it'}
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
