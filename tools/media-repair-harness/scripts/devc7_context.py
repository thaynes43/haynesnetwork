#!/usr/bin/env python3
"""dev-c7 measurement (WO-W23): offline context sizing of prompt v7 + format v3.1-format at the registered qwen context, num_ctx 16384, for the two
candidate page budgets (--tool-output-bytes 8192, the registered default, and 4096).  No model call, no network: the real runner (`run.run_case`) is driven
by scripted MAXIMAL replies (a 200-character `why`, a 400-character `reason`) and the replay tools serve the recorded fixtures of the measured suite
(suite-dev-v1.1, dev split).  It reuses `devc7_sizes.py` (the sequences and the estimate rule) and prints and writes aggregates only: no case id, no text.

Estimate (the Ollama adapter's own, deliberately pessimistic): max over the requests of one conversation of (system prompt + every accumulated message)
characters / 3, plus the 640-token output reserve, compared with 16384.  A second figure divides by 3.97 characters per token instead, the LOWEST ratio of
prompt characters to reported prompt_eval_count over the 107 turns of the dev-c6 qwen run (median 4.27); it is a calibration on v6 + format v3 text, not a
certification of v7 (EPUB body text is new).

Sequences per case (at most the 6-call tool budget; a page fetch counts as a call, as in the runner):
  first      the first message alone (system prompt + first message);
  recorded   each tool-call sequence the three dev-c6 runs made on the case (qwen, Haiku, Astra), re-run under v7 + v3.1-format, every page fetched;
  advertised the first six advertised operations of the frozen exploration policy (passability-1), every page fetched within the budget;
  epub       for each readable EPUB: {} then five maximal excerpts (maximal), and {} plus one excerpt with every page fetched (page fetch), as in devc7_sizes.

    PYTHONPATH=tools/media-repair-harness/src nice -n 19 python3 tools/media-repair-harness/scripts/devc7_context.py [--out runs/dev-c7/context-sizing.json]
"""
import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'src'))

import devc7_sizes as SZ                                   # noqa: E402  (the sequences, maximal replies and the estimate rule)
import passability as PB                                   # noqa: E402  (advertised_operations, the frozen exploration order)
from media_repair_harness import adapters as A             # noqa: E402
from media_repair_harness import protocol as P             # noqa: E402
from media_repair_harness import run as R                  # noqa: E402
from media_repair_harness import tools as T                # noqa: E402

NUM_CTX = 16384
BUDGETS = (8192, 4096)
CALIBRATED_CPT = 3.97          # lowest prompt chars / reported prompt_eval_count over the dev-c6 qwen turns
SUITE = SZ.SUITES['suite-dev-v1.1']
DEVC6 = HERE.parent / 'runs' / 'dev-c6'
DEVC6_RUNS = ('devc6-qwen3.8-27b', 'devc6-haiku-5-5', 'devc6-gpt-6-astra')


class Fetching(SZ.Capture):
    """Scripted maximal replies; before each planned reply it fetches every page of a paginated result while the tool budget lasts."""

    def __init__(self, model, replies, offered):
        super().__init__(model, replies)
        self.calls_used, self.offered = 0, [t for t in offered if t in P.TOOLS]

    def complete(self, system, messages, schema=None):
        last = messages[-1]['content'].split('\n')[0] if messages else ''
        try:
            body = json.loads(last)
        except ValueError:
            body = {}
        page = ((body.get('output') or body.get('evidence') or {}) if isinstance(body, dict) else {}).get('page') or {}
        nxt = page.get('next') if isinstance(page, dict) else None
        planned = json.loads(self.replies[0]) if self.replies else {}
        if nxt and self.offered and self.calls_used < P.MAX_TOOL_CALLS:
            tool = body.get('tool') if isinstance(body, dict) and body.get('tool') in self.offered else self.offered[0]
            self.replies.insert(0, json.dumps({'type': 'tool_call', 'tool': tool, 'why': SZ.MAX_WHY, 'args': {'cursor': nxt}}))
        elif planned.get('type') == 'tool_call' and self.calls_used >= P.MAX_TOOL_CALLS:
            self.replies = [r for r in self.replies if json.loads(r).get('type') != 'tool_call']
        if self.replies and json.loads(self.replies[0]).get('type') == 'tool_call':
            self.calls_used += 1
        return super().complete(system, messages, schema)


def conversation(case, budget, calls):
    replies = [json.dumps({'type': 'tool_call', 'tool': t, 'why': SZ.MAX_WHY, 'args': a}) for t, a in calls]
    replies.append(json.dumps({'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': SZ.MAX_REASON, 'confidence': 0.5,
                               'evidence_refs': ['e1']}))
    ad = Fetching('size-model', replies, case.get('tools_available') or [])
    rec = R.run_case(case, 'sha', ad, SUITE, tempfile.mkdtemp(prefix='mrh-w23-ctx-'), run_id='size', prompt_version='v7', evidence_format='v3.1-format',
                     guards='v3', replay='auto', which=lambda _n: None, tool_output_bytes=budget)
    err = (rec.get('error') or {}).get('message')
    if not ad.sent:
        return None, 0, err
    chars = max(ad.sent)
    return {'estimate': chars // 3 + SZ.OUTPUT_RESERVE_TOKENS, 'calibrated': int(chars / CALIBRATED_CPT) + SZ.OUTPUT_RESERVE_TOKENS}, len(ad.sent), err


def recorded_calls(case_id):
    out = []
    for run in DEVC6_RUNS:
        p = DEVC6 / run / (case_id + '.json')
        if not p.exists():
            continue
        rec = json.loads(p.read_text())
        calls = [(c['tool'], c.get('args') or {}) for c in rec.get('tool_calls') or [] if not c.get('continuation') and c.get('tool') in P.TOOLS]
        out.append(calls)
    return out


def summary(rows):
    est = [r['estimate'] for r in rows]
    cal = [r['calibrated'] for r in rows]
    return {'n': len(rows), 'estimate_median': statistics.median(est) if est else None, 'estimate_max': max(est) if est else None,
            'estimate_at_or_over_16384': sum(1 for x in est if x >= NUM_CTX), 'calibrated_max': max(cal) if cal else None,
            'calibrated_at_or_over_16384': sum(1 for x in cal if x >= NUM_CTX), 'calibrated_at_or_over_input_budget_15744': sum(1 for x in cal if x >= NUM_CTX - SZ.OUTPUT_RESERVE_TOKENS)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    args = ap.parse_args(argv)
    cases = [json.loads(p.read_text()) for p in sorted((SUITE / 'cases').glob('*.json'))]
    cases = [c for c in cases if c.get('split', 'dev') == 'dev' and SZ.FORBIDDEN_CACHE not in str((c.get('fixture') or {}).get('locator') or '')]
    system = P.get_prompt('v7')['text']
    report = {'note': 'aggregates only; offline; no model call; prompt v7 + format v3.1-format, suite-dev-v1.1 dev split, scripted maximal replies',
              'num_ctx': NUM_CTX, 'output_reserve_tokens': SZ.OUTPUT_RESERVE_TOKENS, 'input_budget_tokens': NUM_CTX - SZ.OUTPUT_RESERVE_TOKENS,
              'calibrated_chars_per_token': CALIBRATED_CPT, 'cases': len(cases), 'v7_system_chars': len(system),
              'v7_system_plus_reserve_tokens_estimate': len(system) // 3 + SZ.OUTPUT_RESERVE_TOKENS, 'budgets': {}}
    for budget in BUDGETS:
        rows = {'first': [], 'recorded': [], 'advertised': [], 'epub_maximal': [], 'epub_page_fetch': []}
        errors, requests_max, multi_page_first = 0, 0, 0
        for c in cases:
            _ctx, _s, first, npages = SZ.setup(c, SUITE, 'v3.1-format', budget)
            multi_page_first += npages > 1
            rows['first'].append({'estimate': int((len(system) + first) / 3.0) + SZ.OUTPUT_RESERVE_TOKENS,
                                  'calibrated': int((len(system) + first) / CALIBRATED_CPT) + SZ.OUTPUT_RESERVE_TOKENS})
            seqs = [('recorded', s) for s in recorded_calls(c['id'])]
            ctx = T.Context(c, T.Fixture.from_case(c, SUITE), tempfile.mkdtemp(prefix='mrh-w23-caps-'), which=lambda _n: None, suite_dir=SUITE, tools_behavior='v3')
            seqs.append(('advertised', PB.advertised_operations(c, T.capabilities(ctx))[:P.MAX_TOOL_CALLS]))
            if 'epub_inspect' in (c.get('tools_available') or []):
                probe = T.call_tool(ctx, 'epub_inspect', {})
                if probe['status'] == 'ok':
                    fixture = T.Fixture.from_case(c, SUITE)
                    seq = SZ.excerpt_sequence(fixture.path, T._epub_module().inspect(fixture.path), 5)
                    seqs.append(('epub_maximal', [('epub_inspect', {})] + [('epub_inspect', a) for a in seq]))
                    seqs.append(('epub_page_fetch', [('epub_inspect', {})] + ([('epub_inspect', seq[0])] if seq else [])))
            for kind, calls in seqs:
                est, n, err = conversation(c, budget, calls)
                errors += bool(err)
                requests_max = max(requests_max, n)
                if est is not None:
                    rows[kind].append(est)
        report['budgets'][str(budget)] = {k: summary(v) for k, v in rows.items()}
        report['budgets'][str(budget)].update(harness_errors=errors, requests_max=requests_max, multi_page_first_messages=multi_page_first)
        allrows = [r for v in rows.values() for r in v]
        report['budgets'][str(budget)]['all_sequences'] = summary(allrows)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
