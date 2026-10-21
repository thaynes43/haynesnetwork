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

from media_repair_harness import adapters as A           # noqa: E402
from media_repair_harness import epub_text_v3 as ET       # noqa: E402  (tools behaviour v3 reads with xhtml-body-text-3)
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


OUTPUT_RESERVE_TOKENS = 640       # run.py: the Ollama num_predict of a turn-v2 / turn-v3 prompt (v7 speaks turn-v3)
MAX_WHY = 'w' * 200               # the longest tool-call reason the protocol allows
MAX_REASON = 'r' * 400            # the longest decision reason


class Capture(A.ScriptedAdapter):
    def __init__(self, model, replies):
        super().__init__(model, replies)
        self.sent = []

    def complete(self, system, messages, schema=None):
        self.sent.append(len(system) + sum(len(m['content']) for m in messages))
        return super().complete(system, messages, schema)


class FetchAllPages(Capture):
    """A scripted model that fetches every page of every paginated result (copying page.next) before its next planned reply: a page-fetch trajectory."""

    def complete(self, system, messages, schema=None):
        last = messages[-1]['content'].split('\n')[0] if messages else ''
        try:
            body = json.loads(last)
        except ValueError:
            body = {}
        page = ((body.get('output') or body.get('evidence') or {}) if isinstance(body, dict) else {}).get('page') or {}
        if isinstance(page, dict) and page.get('next') and len(self.sent) < 7:
            self.replies.insert(0, json.dumps({'type': 'tool_call', 'tool': 'epub_inspect', 'why': MAX_WHY, 'args': {'cursor': page['next']}}))
        return super().complete(system, messages, schema)


def excerpt_sequence(path, d, calls):
    """The maximal excerpt sequence a model could request after the default call: 1200 code points at a time through the spine, `calls` calls."""
    out = []
    for i, (_m, text, _h, _n) in enumerate(ET.read_items(path, d)):
        off = 0
        while off < len(text) and len(out) < calls:
            out.append({'spine': i, 'offset': off, 'length': ET.MAX_EXCERPT_CHARS})
            off += ET.MAX_EXCERPT_CHARS
        if len(out) >= calls:
            break
    return out


def conversation(case, sdir, budget, args_seq, adapter=None):
    """Run the real runner with scripted maximal replies (no model): -> (max over requests of the 3-characters-per-token estimate of the WHOLE request,
    system prompt and every accumulated message, plus the output reserve; the number of requests; the leak-guard error or None)."""
    replies = [json.dumps({'type': 'tool_call', 'tool': 'epub_inspect', 'why': MAX_WHY, 'args': a}) for a in args_seq]
    replies.append(json.dumps({'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': MAX_REASON, 'confidence': 0.5, 'evidence_refs': ['e1']}))
    ad = (adapter or Capture)('size-model', replies)
    rec = R.run_case(case, 'sha', ad, sdir, tempfile.mkdtemp(prefix='mrh-w22-size-'), run_id='size', prompt_version='v7', evidence_format='v3.1-format',
                     guards='v3', replay='auto', which=lambda _n: None, tool_output_bytes=budget)
    err = (rec.get('error') or {}).get('message')
    return (max(ad.sent) // 3 + OUTPUT_RESERVE_TOKENS if ad.sent else None), len(ad.sent), err


def refusal_scan(case, sdir):
    """Over ALL text the tools read from this EPUB (the default view and every spine item's whole body text): does the legacy check, or leakguard-media-1,
    find a forbidden token?  -> (legacy kinds, media kinds); text is never printed."""
    fixture = T.Fixture.from_case(case, sdir)
    ctx = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w22-scan-'), which=lambda _n: None, suite_dir=sdir, tools_behavior='v3', keep_raw=True)
    res = T.call_tool(ctx, 'epub_inspect', {})
    if res['status'] != 'ok':
        return None
    texts = T.epub_v3_literals(json.loads(res['raw_output']))
    d = T._epub_module().inspect(fixture.path)
    texts += [t for _m, t, _h, _n in ET.read_items(fixture.path, d)]
    visible = json.dumps(P.case_view(case, [])['context'], ensure_ascii=False)
    legacy = sorted({k for t in texts for k in leakguard.find_leaks(case, t, ctx.forbidden_extra)})
    sources = T.epub_v3_sources(json.loads(res['raw_output']), 'scan') + [{'source': 'scan', 'field': 'item', 'group': 'item[%d]' % i, 'text': t}
                                                                           for i, (_m, t, _h, _n) in enumerate(ET.read_items(fixture.path, d)) if t]
    media = leakguard.media_hits_2(case, sources, visible, ctx.forbidden_extra)        # the guard's own media check (elements, excerpt runs, group runs)
    return legacy, media


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
        conv = {str(b): {'default': [], 'maximal': [], 'pages': [], 'requests_max': 0} for b in (8192, 4096, 2560)}
        refusals = {'scanned': 0, 'legacy_rule_cases': 0, 'media_rule_cases': 0, 'legacy_kinds': {}, 'media_kinds': {}, 'run_refusals': 0}
        for c in epub_cases:
            if FORBIDDEN_CACHE in str((c.get('fixture') or {}).get('locator') or ''):
                continue
            scan = refusal_scan(c, sdir)
            if scan is None:
                continue
            refusals['scanned'] += 1
            for key, kinds in (('legacy', scan[0]), ('media', scan[1])):
                refusals[key + '_rule_cases'] += bool(kinds)
                for k in kinds:
                    refusals[key + '_kinds'][k] = refusals[key + '_kinds'].get(k, 0) + 1
            fixture = T.Fixture.from_case(c, sdir)
            seq = excerpt_sequence(fixture.path, T._epub_module().inspect(fixture.path), 5)
            for b in (8192, 4096, 2560):
                for seq_name, args_seq, adapter in (('default', [{}], None), ('maximal', [{}] + seq, None), ('pages', [{}, seq[0]] if seq else [{}], FetchAllPages)):
                    est, n, err = conversation(c, sdir, b, args_seq, adapter)
                    refusals['run_refusals'] += bool(err)
                    if est is not None:
                        conv[str(b)][seq_name].append(est)
                    conv[str(b)]['requests_max'] = max(conv[str(b)]['requests_max'], n)
        ep['full_conversation'] = {b: {'default_sequence': dict(stats(v['default']), at_or_over_8192=sum(1 for x in v['default'] if x >= 8192)),
                                       'maximal_sequence': dict(stats(v['maximal']), at_or_over_8192=sum(1 for x in v['maximal'] if x >= 8192)),
                                       'page_fetch_sequence': dict(stats(v['pages']), at_or_over_8192=sum(1 for x in v['pages'] if x >= 8192)),
                                       'requests_max': v['requests_max']} for b, v in conv.items()}
        ep['full_conversation_note'] = ('max over the requests of one conversation of (system prompt + every accumulated message) / 3 characters per token, plus the '
                                        '%d-token output reserve; replies are maximal (200-character why, 400-character reason); default = epub_inspect {} then '
                                        'a decision; maximal = {} then five 1200-code-point excerpts through the spine, then a decision; page_fetch = {}, every page of it fetched by cursor, '
                                        'one maximal excerpt and every page of it, then a decision (at most 7 requests)' % OUTPUT_RESERVE_TOKENS)
        ep['refusals'] = refusals
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
    floor = len(P.get_prompt('v7')['text']) // 3 + OUTPUT_RESERVE_TOKENS
    report['context_floor'] = {'v7_system_prompt_plus_output_reserve_tokens_estimate': floor,
                               'note': ('v7\'s system prompt and the output reserve alone are about %d estimated tokens of an 8192-token context, before any case '
                                        'evidence; no --tool-output-bytes budget can bring a conversation with a tool result under 8192, so a local 8192-context '
                                        'measurement of v7 is not feasible as built (estimates, not demonstrated truncation)' % floor)}
    report['context_policy_candidate'] = ('NOT FROZEN (a documented measurement prerequisite): run every case with a uniform --tool-output-bytes 4096; the '
                                          'primary context flag is the model runtime\'s REPORTED prompt-token count (prompt_at_context_limit, '
                                          'context_full_after_generation), the 3-characters-per-token estimate is a secondary flag; a run whose reported '
                                          'tokens reach the context is kept and reported, never dropped from a denominator')
    report['prompt'] = {'v6_bytes': len(v6.encode()), 'v7_bytes': len(v7.encode()), 'v7_minus_v6_bytes': len(v7.encode()) - len(v6.encode()),
                        'v6_tokens_estimate_3cpt': len(v6) // 3, 'v7_tokens_estimate_3cpt': len(v7) // 3,
                        'context_note': 'the 8192-token local context of the qwen runs is the binding budget: the system prompt and every message share it'}
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
