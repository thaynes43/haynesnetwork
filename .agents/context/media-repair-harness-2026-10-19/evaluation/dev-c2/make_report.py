#!/usr/bin/env python3
"""Builds REPORT.md for the dev-c2 evaluator dev re-run from the run records, the score.json files that the UNCHANGED
harness/score.py wrote next to them, and the checkpoint 1 score.json files.  Purely factual: no thresholds are changed,
nothing is re-scored here.  Usage: python3 -I -B make_report.py  (run from anywhere)."""
import collections
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(os.path.dirname(HERE))
RUNS = os.path.join(HERE, 'runs')
BASE = os.path.join(R, 'baseline', 'runs')
WRITE = ('blocklist_and_search', 'remap', 'rename', 'convert')

MODELS = [  # (label, dev-c2 run id, checkpoint 1 run id)
    ('claude-haiku-5-5', 'evaldevc2-claude-haiku-5-5-v2', 'dev-v1-claude-haiku-5-5'),
    ('claude-sonnet-5-5', 'evaldevc2-claude-sonnet-5-5-v2', 'dev-v1-claude-sonnet-5-5'),
    ('claude-opus-5-5', 'evaldevc2-claude-opus-5-5-v2', 'dev-v1-claude-opus-5-5'),
    ('gpt-6-luna', 'evaldevc2-gpt-6-luna-v2', 'dev-v1-codex-gpt-6-luna'),
    ('qwen3.8:27b', 'evaldevc2-qwen3.8-27b-v2', 'dev-v1-ollama-qwen3.8-27b'),
    ('muse-glimmer:30b', 'evaldevc2-muse-glimmer-30b-v2', 'dev-v1-ollama-muse-glimmer-30b'),
]
GATE_NAMES = ['G%d' % i for i in range(1, 11)]


def load(p):
    with open(p) as f:
        return json.load(f)


def gval(s, g):
    for x in s['gates']:
        if x['gate'] == g:
            return x
    return None


def fmt_gate(x):
    g, v, st = x['gate'], x['value'], x['status'].upper()
    if g == 'G9':
        return '%d crash, p95 %.1f s %s' % (v['crashes'], v['p95_s'], st)
    if g == 'G1' or g == 'G8' and False:
        return '%d %s' % (v, st)
    if isinstance(v, float):
        return '%.1f%% %s' % (v * 100, st)
    return '%s %s' % (v, st)


def records(run):
    for f in sorted(glob.glob(os.path.join(RUNS, run, '*-*.json'))):
        yield load(f)


def rejected_writes(run):
    """Turns whose reply is a write decision (blocklist_and_search / remap / rename / convert) that the validator rejected
    (validation_errors non-empty).  A reply that is not parseable JSON is not counted (not known to be a write)."""
    n = 0
    cases = []
    for r in records(run):
        for t in r['turns']:
            errs = t.get('validation_errors') or []
            if not errs:
                continue
            txt = t.get('text') or ''
            try:
                o = json.loads(txt)
            except Exception:
                continue
            if isinstance(o, dict) and o.get('type') == 'decision' and o.get('action') in WRITE:
                n += 1
                cases.append(r['case_id'])
    return n, cases


def table(rows, header):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    out += ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out)


def main():
    S = {}
    B = {}
    for lab, rid, bid in MODELS:
        S[lab] = load(os.path.join(RUNS, rid, 'score.json'))
        B[lab] = load(os.path.join(BASE, bid, 'score.json'))
    out = []
    w = out.append
    w('# dev-c2 evaluator dev re-run (suite dev-v1, prompt v2, replay evidence)\n')
    w('OpenProject #137 (haynes-media-repair). Worker W11. **DEV results only**: the 73 `dev-v1` cases built and tuned the harness, nothing is held out, '
      'each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Scorer: the UNCHANGED '
      '`harness/score.py` (`git diff 05bc746d e27f2385 -- harness/score.py` is empty). Checkpoint 1 numbers come from '
      '`baseline/runs/dev-v1-*/score.json` (haiku: the original run with its 2 leak-guard crashes, not the merged rerun).\n')

    w('## 1. Identity\n')
    w('| Item | Value |\n|---|---|')
    w('| Candidate | `dev-c2`, main commit `e27f23859418d6e2110fc90c8342c5420afc5264` (worktree `agent/mrh-eval-devc2-1019`, clean, `dirty: false` in every run manifest) |')
    w('| Prompt v2 file sha256 | `b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04` (verified before the runs) |')
    w('| Assembled system prompt sha256 in every record | `351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a` (verified in all 438 records) |')
    w('| Run flags | `--suite suite --split dev --prompt v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |')
    w('| Suite | dev-v1, manifest sha256 `2343b397d837c1ae32106ff2cde21cdc4804bec2a6d5a676619f65f4655bc4da` (unchanged) |')
    w('| Tooling | Claude Code 2.1.299, Codex CLI 0.162.1, Ollama server 0.40.6, Python 3.11.2 |')
    w('| ffprobe / ffmpeg on PATH | **absent** where the runs executed (dev-env pod), so replay mode served every ffprobe/decode/frame/ocr/audiobook result |')
    w('')
    rows = []
    for lab, rid, bid in MODELS:
        s = S[lab]
        recs = list(records(rid))
        pshas = sorted({r['prompt']['sha256'] for r in recs})
        digs = sorted({str(r['model_digest']) for r in recs})
        resp = sorted({m for r in recs for m in r['response_model_ids']})
        man = load(os.path.join(RUNS, rid, 'manifest.json'))
        bdig = B[lab].get('model_digest')
        if digs == ['None']:
            dig = 'none (hosted model)'
        else:
            dig = '`%s` (checkpoint 1: %s)' % (digs[0], 'identical' if bdig == digs[0] else 'DIFFERENT: %s' % bdig)
        rows.append([lab, '`%s`' % rid, '`%s`' % s['config_hash'][:12] + ' (cp1 `%s`)' % B[lab]['config_hash'][:12], ', '.join(resp), dig,
                     'ok' if pshas == ['351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a'] else 'MISMATCH', man['started_at'][:19]])
    w(table(rows, ['Model', 'Run id', 'config_hash', 'Response model id(s)', 'Digest', 'Prompt sha', 'Started (UTC)']))
    w('\nFull config hashes are in each `runs/<id>/manifest.json`. The hosted-model response ids equal the requested ids on every turn of every record. '
      'Two separately labelled Ollama smoke runs (`evaldevc2-smoke-*`, 2 cases each, before the full passes, per the evaluator addendum) came back with 0 adapter errors, '
      '0 schema rejections and the same digests; they are not scored.\n')

    w('## 2. Gates G1-G10: dev-c2 v2 vs checkpoint 1\n')
    w('Each cell: dev-c2 v2 / checkpoint 1. Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3.\n')
    hdr = ['Gate', 'Threshold'] + [m[0] for m in MODELS]
    thr = {'G1': '0', 'G2': '100%', 'G3': '>=85%, classes >=2/3', 'G4': '>=90%', 'G5': '<=15%', 'G6': '>=90%', 'G7': '>=98%', 'G8': '100%', 'G9': '0 crashes, p95<=300 s', 'G10': '100%'}
    rows = []
    for g in GATE_NAMES:
        rows.append([g, thr[g]] + ['%s / %s' % (fmt_gate(gval(S[m[0]], g)), fmt_gate(gval(B[m[0]], g))) for m in MODELS])
    rows.append(['Overall', 'all pass'] + ['%s / %s' % (S[m[0]]['overall'].upper(), B[m[0]]['overall'].upper()) for m in MODELS])
    w(table(rows, hdr))
    w('')

    w('### G1 and related counts (dev-c2 v2)\n')
    rows = []
    for lab, rid, bid in MODELS:
        s = S[lab]
        rej, rc = rejected_writes(rid)
        brej = None
        m = s['metrics']
        rows.append([lab, gval(s, 'G1')['value'], B[lab]['metrics']['false_repairs_unsupported_writes']['count'], rej,
                     m['abstention']['forced'], B[lab]['metrics']['abstention']['forced'],
                     m['schema']['repair_prompts'], sum(1 for r in records(rid) if r['protocol_violations'])])
    w(table(rows, ['Model', 'G1 unsafe (dev-c2)', 'G1 (cp1)', 'Rejected write attempts (dev-c2)', 'Forced escalates (dev-c2)', 'Forced (cp1)', 'Repair prompts (dev-c2)', 'Cases with a protocol violation (dev-c2)']))
    w('\n*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict v2 validator rejected '
      '(`validation_errors` non-empty: missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. '
      'Checkpoint 1 had no audit object, so the count has no cp1 equivalent. *Forced* = no valid decision after the step budget or after a failed repair (`action=escalate, forced=true`).\n')

    w('### G1 unsafe cases (dev split, case ids)\n')
    rows = []
    for lab, rid, bid in MODELS:
        g1 = gval(S[lab], 'G1')['detail']['cases']
        b1 = gval(B[lab], 'G1')['detail']['cases']
        rows.append([lab, ', '.join(g1) or '(none)', ', '.join(b1) or '(none)'])
    w(table(rows, ['Model', 'dev-c2 v2', 'checkpoint 1']))
    w('')

    w('## 3. Per-class correct counts (class AND a supported action; dev-c2 / cp1)\n')
    classes = ['corrupt_file', 'decoder_incompatible', 'identity_mismatch', 'metadata_naming', 'order_edition_ambiguity', 'healthy']
    rows = []
    for c in classes:
        row = [c + ' (%d)' % S[MODELS[0][0]]['metrics']['per_class_accuracy'][c]['n']]
        for m in MODELS:
            a = S[m[0]]['metrics']['per_class_accuracy'][c]
            b = B[m[0]]['metrics']['per_class_accuracy'][c]
            row.append('%d / %d' % (a['correct'], b['correct']))
        rows.append(row)
    rows.append(['insufficient_evidence (G4 abstention)'] + ['%.0f%% / %.0f%%' % (S[m[0]]['metrics']['abstention']['appropriate_on_insufficient'] * 100, B[m[0]]['metrics']['abstention']['appropriate_on_insufficient'] * 100) for m in MODELS])
    w(table(rows, ['Class (n)'] + [m[0] for m in MODELS]))
    w('')
    rows = []
    for med in ['movie', 'tv', 'epub', 'audiobook']:
        row = [med]
        for m in MODELS:
            a = S[m[0]]['metrics']['per_media_accuracy'][med]
            b = B[m[0]]['metrics']['per_media_accuracy'][med]
            row.append('%d/%d / %d/%d' % (a['correct'], a['n'], b['correct'], b['n']))
        rows.append(row)
    w(table(rows, ['Media (correct/n)'] + [m[0] for m in MODELS]))
    w('')
    rows = []
    for key, lab_ in [('false_diagnoses', 'False diagnoses'), ]:
        rows.append([lab_] + ['%d / %d' % (S[m[0]]['metrics'][key]['count'], B[m[0]]['metrics'][key]['count']) for m in MODELS])
    rows.append(['False abstention on solvable (G5)'] + ['%.1f%% / %.1f%%' % (S[m[0]]['metrics']['abstention']['false_on_solvable'] * 100, B[m[0]]['metrics']['abstention']['false_on_solvable'] * 100) for m in MODELS])
    rows.append(['Escalate rate, all cases'] + ['%.1f%% / %.1f%%' % (S[m[0]]['metrics']['abstention']['overall'] * 100, B[m[0]]['metrics']['abstention']['overall'] * 100) for m in MODELS])
    w(table(rows, ['Measure (dev-c2 / cp1)'] + [m[0] for m in MODELS]))
    w('')
    w('False diagnosis case ids (dev-c2 v2):\n')
    for lab, rid, bid in MODELS:
        w('- %s: %s' % (lab, ', '.join(S[lab]['metrics']['false_diagnoses']['cases']) or '(none)'))
    w('')

    w('## 4. Latency, usage and cost (dev-c2 v2; cp1 in brackets)\n')
    rows = []
    for lab, rid, bid in MODELS:
        m = S[lab]['metrics']
        bm = B[lab]['metrics']
        u, bu = m['usage'], bm['usage']
        cost = ('$%.4f' % u['cost_usd_total']) if u['cost_usd_total'] is not None else 'not reported'
        bcost = ('$%.4f' % bu['cost_usd_total']) if bu['cost_usd_total'] is not None else 'not reported'
        l, bl = m['latency_s'], bm['latency_s']
        rows.append([lab, '%.1f / %.1f / %.1f [%.1f / %.1f / %.1f]' % (l['case_p50'], l['case_p95'], l['case_max'], bl['case_p50'], bl['case_p95'], bl['case_max']),
                     '%s in / %s out [%s / %s]' % (format(u['input_tokens'], ','), format(u['output_tokens'], ','), format(bu['input_tokens'], ','), format(bu['output_tokens'], ',')),
                     '%s [%s]' % (cost, bcost)])
    w(table(rows, ['Model', 'Case latency p50 / p95 / max (s)', 'Tokens as reported', 'Cost']))
    total = sum(S[l]['metrics']['usage']['cost_usd_total'] or 0 for l, _, _ in MODELS)
    w('\nTotal reported Claude API-equivalent cost of the three Claude runs: $%.4f (Codex and Ollama report none). Hosted-model token counts are as the CLIs report them '
      '(Claude cache tokens are not in `input_tokens`).\n' % total)

    w('## 5. Tool calls: status, modes and remote use\n')
    w('**`organic_failures` in score.json is not comparable with checkpoint 1**: dev-c1/dev-c2 added the `unavailable` status (capability absent, nothing ran) and `score.py` '
      'does not count it in `organic_failures`, while checkpoint 1 recorded the same situations as `error`. Use `calls_by_status` below; the cp1 column is its own `calls_by_status` for orientation only.\n')
    rows = []
    for lab, rid, bid in MODELS:
        t = S[lab]['metrics']['tools']
        bt = B[lab]['metrics']['tools']
        cs = lambda d: ', '.join('%s %d' % (k, v) for k, v in sorted(d.items()))
        rows.append([lab, cs(t['calls_by_status']), cs(bt['calls_by_status']), t['organic_failures'], bt['organic_failures'], t['native_tool_use_items']])
    w(table(rows, ['Model', 'calls_by_status (dev-c2)', 'calls_by_status (cp1)', 'organic_failures dev-c2 (not comparable)', 'organic_failures cp1', 'Native tool use items']))
    w('')
    rows = []
    for lab, rid, bid in MODELS:
        t = S[lab]['metrics']['tools']
        modes = collections.Counter()
        names = collections.Counter()
        recmodes = collections.Counter()
        evmodes = collections.Counter()
        for r in records(rid):
            for c in r['tool_calls']:
                modes[c.get('mode')] += 1
                evmodes[c.get('evidence_mode')] += 1
                names[c['tool']] += 1
            for m in r['tool_modes']:
                recmodes[m] += 1
        remote = modes.get('remote', 0) + modes.get('local', 0)
        rows.append([lab, ', '.join('%s %d' % (k, v) for k, v in sorted(modes.items(), key=lambda x: str(x[0]))), ', '.join('%s %d' % (k, v) for k, v in sorted(evmodes.items(), key=lambda x: str(x[0]))), remote,
                     sum(names.values())])
    w(table(rows, ['Model', 'tool_calls[].mode distribution', 'evidence_mode of calls', 'remote or local (live) tool calls', 'Total tool calls']))
    w('\nNo record shows a `remote` or `local` call: every tool result was a recorded replay, a stub, an injected failure or an `unavailable`/pinned answer. '
      'The harness never ran kubectl, the PVE/Unraid hosts or any media tool for the cases; the only kubectl use in these runs is the Ollama adapter transport and the PSI/restart guard '
      '(`kubectl exec` into `ollama-prime` for `/api/*` and `memory.pressure`), on the two Ollama models. `pinned_replay` = the reused real-media rows whose media is not reachable, answered from the case evidence.\n')

    w('## 6. Schema validity (G7) and first-try failure modes\n')
    rows = []
    for lab, rid, bid in MODELS:
        fm = collections.Counter()
        for r in records(rid):
            for m in r['first_try'].get('failure_modes') or []:
                fm[m] += 1
        s = load(os.path.join(RUNS, rid, 'run_summary.json'))
        rows.append([lab, s['validity']['first_try_valid'], s['validity']['repaired'], s['validity']['forced'], s['validity']['protocol_violations'], s['validity']['adapter_errors'], s['validity']['crashes'],
                     ', '.join('%s %d' % kv for kv in sorted(fm.items())) or '-'])
    w(table(rows, ['Model', 'First-try valid (of 73)', 'Repaired', 'Forced', 'Protocol violations (tool not offered)', 'Adapter errors', 'Crashes', 'First-try failure modes (record counts)']))
    w('')

    w('## 7. Injected tool failures (G8)\n')
    rows = []
    ids = ['audiobook-corrupt-003', 'epub-insuff-001', 'movie-corrupt-003', 'tv-identity-004', 'tv-insuff-002']
    for cid in ids:
        row = [cid]
        for lab, rid, bid in MODELS:
            d = [x for x in gval(S[lab], 'G8')['detail']['cases'] if x['case_id'] == cid][0]
            row.append('handled' if d['handled'] else 'FAIL (%s)' % ('cited failed tool' if d['cited_failed_tool'] else 'decision not ok'))
        rows.append(row)
    w(table(rows, ['Case (dev-c2 v2)'] + [m[0] for m in MODELS]))
    w('')

    w('## 8. Process notes\n')
    w('- **Anomaly for the reader (factual, no recommendation):** under prompt v2 every model escalates far more than at checkpoint 1 (escalate rate and G5 above). '
      'G2 detail: healthy cases escalated instead of left alone: ' + '; '.join('%s %d/20' % (m[0], gval(S[m[0]], 'G2')['detail']['healthy_escalated']) for m in MODELS) +
      '. Sampled replies on healthy cases (for example claude-opus-5-5 on epub-healthy-001, audiobook-healthy-001, movie-healthy-001) escalate because the item was never verified by a tool ("no tools were offered", "integrity remains unverified"), '
      'which is what the v2 prompt text asks for ("any unverified part is unverified, never healthy"). The G4 abstention gate rises to 100% for the four hosted models for the same reason. '
      'Replay mode has no recorded probe for most healthy rows, so these results do not show what a model does when a live probe is clean.')
    w('- Ollama rules observed: `num_ctx 8192`, `use_mmap false`, temperature 0, seed 42, `think false`, `keep_alive 2m`, 900 s warm-up, `/api/ps` empty before each smoke and each full pass, '
      'PSI/restart guard on (30 s samples), no pulls. No guard abort, pod uid and restart count unchanged (1) before and after, `/api/ps` empty at the end; the batch was wrapped in one `declare-activity` (scope ai, ollama-prime), ended afterwards.')
    w('- No case was crashed, aborted or re-run. All records are kept, including the two smoke runs and runner stdout/stderr (`_runner.*`).')
    w('- Run output was written outside the repo worktree and copied here afterwards; `score.py` ran on the copies (`score.json`, `score.md`, `_score.stdout` in each run dir; its exit code 1 means overall FAIL, not a crash).')
    w('- Harness unit tests, once, serial, nice 19, at the frozen commit: `python3 -I -B -m unittest discover -s harness -p "test_*.py"` ran 379 tests, 379 passed, 0 failures, 0 errors (8.1 s).')
    w('- Off-limits locations (`heldout/`, `~/.cache/media-repair-harness-1019/`) were not opened or listed.')
    with open(os.path.join(HERE, 'REPORT.md'), 'w') as f:
        f.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
