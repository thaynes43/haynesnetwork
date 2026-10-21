#!/usr/bin/env python3
"""Offline byte and context counts of the WIRED contract v3 configuration (dev-c6: `--prompt v6 --evidence-format v3`), no model call.

1. First messages: every case of both public dev suites (dev-v1 and dev-v1.1) is run through the unchanged runner (`run.run_case`, replay, no binaries)
   with a scripted model that escalates at once; the first user message it was sent is measured: UTF-8 bytes (the 8192-byte page budget), pages,
   PageBudgetError, and the context estimate the Ollama adapter flags with (3 characters per token, deliberately pessimistic) of system prompt plus message.
2. Conversations: the tool-call sequences the dev-c5 qwen run actually made (its recorded replies, decisions replaced by a decision-v3 escalate) are
   replayed under v3; the largest request of each case (system plus every message) is measured the same way.  This is the v3 rendering of real call
   sequences, not a prediction of what a model will call.

Usage: contract_v3_budget.py [--out FILE]"""
import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import adapters as A    # noqa: E402
from media_repair_harness import protocol as P    # noqa: E402
from media_repair_harness import run as R         # noqa: E402

REPO = COMPONENT.parents[1]
H = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
SUITES = {'dev-v1': H / 'suite', 'dev-v1.1': H / 'suite-dev-v1.1'}
DEV_C5_QWEN = COMPONENT / 'runs' / 'dev-c5' / 'devc5-b-qwen3.8-27b'
NUM_CTX = 8192
NUM_PREDICT = 640
ESCALATE = json.dumps({'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': 'offline measurement', 'confidence': 0.0, 'evidence_refs': []})


def no_binaries(_name):
    return None


class Capture(A.ScriptedAdapter):
    def __init__(self, model, replies):
        super().__init__(model, replies)
        self.sent = []

    def complete(self, system, messages, schema=None):
        self.sent.append((system, [dict(m) for m in messages]))
        return super().complete(system, messages, schema)


def run(case, sha, suite, replies, run_id):
    ad = Capture('offline-measure', replies)
    rec = R.run_case(case, sha, ad, suite, tempfile.mkdtemp(prefix='mrh-w21-'), run_id=run_id, prompt_version='v6', evidence_format='v3', guards='v3',
                     replay='auto', which=no_binaries, tool_output_bytes=NUM_CTX)
    return rec, ad


def est(system, messages):
    return int((len(system) + sum(len(m['content']) for m in messages)) / 3.0)


def first_messages():
    out = {}
    for name, suite in SUITES.items():
        rows = []
        for case, sha in R.load_cases(suite, split='dev'):
            rec, ad = run(case, sha, suite, [ESCALATE], 'offline-budget')
            if rec.get('error'):
                rows.append({'case': case['id'], 'error': rec['error']['message']})
                continue
            system, msgs = ad.sent[0]
            first = msgs[0]['content']
            log = rec['evidence_format']['messages'][0]
            rows.append({'case': case['id'], 'bytes': len(first.encode('utf-8')), 'chars': len(first), 'pages': log['pages'], 'estimate_tokens': est(system, msgs[:1])})
        ok = [r for r in rows if 'bytes' in r]
        out[name] = {'cases': len(rows), 'errors': [r for r in rows if 'error' in r], 'first_bytes_median': statistics.median(r['bytes'] for r in ok),
                     'first_bytes_max': max(r['bytes'] for r in ok), 'over_8192_bytes': sum(1 for r in ok if r['bytes'] > NUM_CTX),
                     'multi_page_first_messages': sum(1 for r in ok if r['pages'] > 1), 'max_pages': max(r['pages'] for r in ok),
                     'estimate_tokens_max': max(r['estimate_tokens'] for r in ok), 'estimate_tokens_median': statistics.median(r['estimate_tokens'] for r in ok),
                     'estimate_at_or_over_8192': sum(1 for r in ok if r['estimate_tokens'] >= NUM_CTX),
                     'estimate_plus_num_predict_at_or_over_8192': sum(1 for r in ok if r['estimate_tokens'] + NUM_PREDICT >= NUM_CTX),
                     'largest': sorted(ok, key=lambda r: -r['bytes'])[:3]}
    return out


def conversations():
    suite = SUITES['dev-v1.1']
    shas = {c['id']: (c, s) for c, s in R.load_cases(suite, split='dev')}
    rows = []
    for p in sorted(DEV_C5_QWEN.glob('*-*-*.json')):
        rec5 = json.loads(p.read_text())
        case, sha = shas[rec5['case_id']]
        replies = []
        for t in rec5['turns']:
            try:
                o = json.loads(t.get('text') or '')
            except ValueError:
                continue
            if isinstance(o, dict) and o.get('type') == 'tool_call':
                replies.append(t['text'])
        replies.append(ESCALATE)
        rec, ad = run(case, sha, suite, replies, rec5['run_id'])
        worst = max(est(s, m) for s, m in ad.sent)
        rows.append({'case': rec5['case_id'], 'calls_replayed': len(replies) - 1, 'requests': len(ad.sent), 'estimate_tokens_max': worst,
                     'largest_message_bytes': max(len(m['content'].encode('utf-8')) for _s, ms in ad.sent for m in ms if m['role'] == 'user')})
    return {'source': 'the tool-call replies of runs/dev-c5/devc5-b-qwen3.8-27b, decisions replaced by a decision-v3 escalate', 'cases': len(rows),
            'with_tool_calls': sum(1 for r in rows if r['calls_replayed']), 'estimate_tokens_max': max(r['estimate_tokens_max'] for r in rows),
            'estimate_at_or_over_8192': [r['case'] for r in rows if r['estimate_tokens_max'] >= NUM_CTX],
            'estimate_plus_num_predict_at_or_over_8192': [r['case'] for r in rows if r['estimate_tokens_max'] + NUM_PREDICT >= NUM_CTX],
            'largest_message_bytes': max(r['largest_message_bytes'] for r in rows), 'largest': sorted(rows, key=lambda r: -r['estimate_tokens_max'])[:5]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    prompt = P.get_prompt('v6')
    out = {'prompt': {'version': 'v6', 'chars': len(prompt['text']), 'sha256': prompt['sha256'], 'estimate_tokens': int(len(prompt['text']) / 3.0)},
           'estimator': 'characters / 3 (the Ollama adapter\'s pessimistic per-turn estimate); num_ctx %d, num_predict %d' % (NUM_CTX, NUM_PREDICT),
           'first_messages': first_messages(), 'conversations_dev_c5_qwen_calls': conversations()}
    print(json.dumps(out, indent=1))
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
