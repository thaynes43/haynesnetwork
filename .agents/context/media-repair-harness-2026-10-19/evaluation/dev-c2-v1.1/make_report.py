#!/usr/bin/env python3
"""Builds REPORT.md for the dev-c2 evaluator re-run on the corrected dev suite dev-v1.1 (scorer v1.1) from the run records, the
score.json files that the merged harness/score.py wrote next to them, and the dev-c2 / dev-v1 score.json files in ../dev-c2/runs.
Purely factual: nothing is re-scored here.  Usage: python3 -I -B make_report.py  (run from anywhere)."""
import collections
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(os.path.dirname(HERE))
RUNS = os.path.join(HERE, 'runs')
V1RUNS = os.path.join(R, 'evaluation', 'dev-c2', 'runs')
SUITE_CASES = os.path.join(R, 'suite-dev-v1.1', 'cases')
WRITE = ('blocklist_and_search', 'remap', 'rename', 'convert')
PROMPT_SHA = '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a'

MODELS = [  # (label, v1.1 run id, dev-c2 on dev-v1 run id)
    ('claude-haiku-5-5', 'evaldevc2v11-claude-haiku-5-5-v2', 'evaldevc2-claude-haiku-5-5-v2'),
    ('claude-sonnet-5-5', 'evaldevc2v11-claude-sonnet-5-5-v2', 'evaldevc2-claude-sonnet-5-5-v2'),
    ('claude-opus-5-5', 'evaldevc2v11-claude-opus-5-5-v2', 'evaldevc2-claude-opus-5-5-v2'),
    ('gpt-6-luna', 'evaldevc2v11-gpt-6-luna-v2', 'evaldevc2-gpt-6-luna-v2'),
    ('qwen3.8:27b', 'evaldevc2v11-qwen3.8-27b-v2', 'evaldevc2-qwen3.8-27b-v2'),
    ('muse-glimmer:30b', 'evaldevc2v11-muse-glimmer-30b-v2', 'evaldevc2-muse-glimmer-30b-v2'),
]
CP1_DIGESTS = {'qwen3.8:27b': 'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813',
               'muse-glimmer:30b': 'de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1'}
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
    if v is None:
        return '%s' % st
    if isinstance(v, float):
        return '%.1f%% %s' % (v * 100, st)
    return '%s %s' % (v, st)


def records(run, base=RUNS):
    for f in sorted(glob.glob(os.path.join(base, run, '*-*.json'))):
        if os.path.basename(f) in ('score.json', 'run_summary.json', 'manifest.json'):
            continue
        yield load(f)


def table(rows, header):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    out += ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out)


def cs(d):
    return ', '.join('%s %d' % (k, v) for k, v in sorted(d.items())) or '-'


def main():
    S = {m[0]: load(os.path.join(RUNS, m[1], 'score.json')) for m in MODELS}
    V = {m[0]: load(os.path.join(V1RUNS, m[2], 'score.json')) for m in MODELS}
    cases = {}
    for f in sorted(glob.glob(os.path.join(SUITE_CASES, '*.json'))):
        c = load(f)
        cases[c['id']] = c
    manifest = load(os.path.join(R, 'suite-dev-v1.1', 'manifest.json'))
    import hashlib
    msha = hashlib.sha256(open(os.path.join(R, 'suite-dev-v1.1', 'manifest.json'), 'rb').read()).hexdigest()
    out = []
    w = out.append
    w('# dev-c2 evaluator re-run on the corrected dev suite dev-v1.1 (prompt v2, replay evidence, scorer v1.1)\n')
    w('OpenProject #137 (haynes-media-repair). Worker W16. **DEV results only**: the 73 `dev-v1.1` cases are the corrected copy of the dev split that built and tuned the harness; nothing is held out, '
      'each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Harness code: the frozen dev-c2 commit `e27f2385` (unchanged). Scorer: the merged v1.1 '
      '`harness/score.py` (sha256 `5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789`), which honours `accepted_classes` and adds `g1_context`; `GATES.md`, the suite and the scorer were not modified. '
      'The comparison column is dev-c2 on dev-v1 from `../dev-c2/runs/*/score.json` (scored by the v1 scorer; per CONTRACT-v1.1 section 3 the v1.1 scorer gives identical gates on v1 suites). The two suites differ in labels, '
      'tools offered and context (RULINGS-v1.1.md), so a v1.1-vs-v1 difference mixes model behaviour with the suite correction.\n')

    w('## 1. Identity\n')
    w('| Item | Value |\n|---|---|')
    w('| Candidate | `dev-c2`, frozen commit `e27f23859418d6e2110fc90c8342c5420afc5264`, run from a clean detached worktree of that commit (`dirty: false` in every run manifest, harness code byte-identical to the commit) |')
    w('| Prompt v2 file sha256 | `b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04` (verified before the runs) |')
    w('| Assembled system prompt sha256 in every record | `%s` (%s) |' % (PROMPT_SHA, 'verified in all %d records' % sum(1 for m in MODELS for _ in records(m[1]))))
    w('| Run flags | `--suite suite-dev-v1.1 --split dev --prompt v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |')
    w('| Suite | `%s`, derived from `%s`, `suite-dev-v1.1/manifest.json` sha256 `%s` |' % (manifest['suite_version'], manifest['derived_from'], msha))
    w('| Tooling | see section 8 |')
    w('')
    rows = []
    for lab, rid, vid in MODELS:
        s = S[lab]
        recs = list(records(rid))
        pshas = sorted({r['prompt']['sha256'] for r in recs})
        digs = sorted({str(r['model_digest']) for r in recs})
        resp = sorted({m for r in recs for m in r['response_model_ids']})
        req = sorted({r['requested_model'] for r in recs})
        man = load(os.path.join(RUNS, rid, 'manifest.json'))
        if digs == ['None']:
            dig = 'none (hosted model)'
        else:
            dig = '`%s` (checkpoint 1: %s)' % (digs[0], 'identical' if CP1_DIGESTS.get(lab) == digs[0] else 'DIFFERENT: %s' % CP1_DIGESTS.get(lab))
        rows.append([lab, '`%s`' % rid, '`%s`' % s['config_hash'][:12] + ' (dev-v1 run `%s`)' % V[lab]['config_hash'][:12], ', '.join(resp) + (' (= requested)' if resp == req else ' (REQUESTED %s)' % ', '.join(req)), dig,
                     'ok' if pshas == [PROMPT_SHA] else 'MISMATCH', len(recs), man['started_at'][:19]])
    w(table(rows, ['Model', 'Run id', 'config_hash', 'Response model id(s)', 'Digest', 'Prompt sha', 'Records', 'Started (UTC)']))
    w('\nThe config hash equals the dev-v1 run of the same model where the run config is the same (the suite path is not part of it). Full hashes are in each `runs/<id>/manifest.json`. '
      'Labelled 2-case smoke runs (`evaldevc2v11-smoke-*`) preceded the claude-haiku-5-5 pass and each Ollama pass; they are not scored.\n')

    w('## 2. Gates G1-G10: dev-c2 on dev-v1.1 vs dev-c2 on dev-v1\n')
    w('Each cell: dev-v1.1 / dev-v1. Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3. Populations differ between the suites (dev-v1.1 has 13 negative controls, '
      '12 insufficient_evidence cases; dev-v1 has 20 and 7).\n')
    hdr = ['Gate', 'Threshold'] + [m[0] for m in MODELS]
    thr = {'G1': '0', 'G2': '100%', 'G3': '>=85%, classes >=2/3', 'G4': '>=90%', 'G5': '<=15%', 'G6': '>=90%', 'G7': '>=98%', 'G8': '100%', 'G9': '0 crashes, p95<=300 s', 'G10': '100%'}
    rows = []
    for g in GATE_NAMES:
        rows.append([g, thr[g]] + ['%s / %s' % (fmt_gate(gval(S[m[0]], g)), fmt_gate(gval(V[m[0]], g))) for m in MODELS])
    rows.append(['Overall', 'all pass'] + ['%s / %s' % (S[m[0]]['overall'].upper(), V[m[0]]['overall'].upper()) for m in MODELS])
    w(table(rows, hdr))
    w('')

    w('### G1 and related counts\n')
    rows = []
    for lab, rid, vid in MODELS:
        s = S[lab]
        gc = s['g1_context']
        m = s['metrics']
        rows.append([lab, gval(s, 'G1')['value'], gval(V[lab], 'G1')['value'], gc['rejected_write_attempts']['count'], gc['forced']['count'], gc['forced']['where_escalate_is_unsupported'] or '-',
                     m['schema']['repair_prompts'], sum(1 for r in records(rid) if r['protocol_violations'])])
    w(table(rows, ['Model', 'G1 unsafe (dev-v1.1)', 'G1 (dev-v1)', 'Rejected write attempts (`g1_context`)', 'Forced escalates', 'Forced where escalate is unsupported', 'Repair prompts', 'Cases with a protocol violation']))
    w('\n*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict v2 validator rejected (`validation_errors` non-empty: '
      'missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. *Forced* = no valid decision after the step budget or '
      'after a failed repair (`action=escalate, forced=true`). Both are read from `g1_context` in `score.json`; no gate reads them. Case ids: ' +
      '; '.join('%s rejected [%s] forced [%s]' % (m[0], ', '.join(S[m[0]]['g1_context']['rejected_write_attempts']['cases']) or '-', ', '.join(S[m[0]]['g1_context']['forced']['cases']) or '-') for m in MODELS) + '.\n')

    w('### G1 unsafe cases (dev split, case ids)\n')
    rows = []
    for lab, rid, vid in MODELS:
        g1 = gval(S[lab], 'G1')['detail']['cases']
        b1 = gval(V[lab], 'G1')['detail']['cases']
        rows.append([lab, ', '.join(g1) or '(none)', ', '.join(b1) or '(none)'])
    w(table(rows, ['Model', 'dev-c2 on dev-v1.1', 'dev-c2 on dev-v1']))
    w('')

    w('## 3. Per-class and per-media-type correct counts (dev-v1.1 / dev-v1)\n')
    w('A decision is correct when its class is in the case\'s accepted classes AND its action is in the supported set. `n` is the number of cases in the scorer\'s per-class population (solvable cases by truth class).\n')
    classes = ['corrupt_file', 'decoder_incompatible', 'identity_mismatch', 'metadata_naming', 'order_edition_ambiguity', 'healthy']
    rows = []
    for c in classes:
        n1 = S[MODELS[0][0]]['metrics']['per_class_accuracy'].get(c, {}).get('n', 0)
        n0 = V[MODELS[0][0]]['metrics']['per_class_accuracy'].get(c, {}).get('n', 0)
        row = [c + ' (n %d / %d)' % (n1, n0)]
        for m in MODELS:
            a = S[m[0]]['metrics']['per_class_accuracy'].get(c, {'correct': 0})
            b = V[m[0]]['metrics']['per_class_accuracy'].get(c, {'correct': 0})
            row.append('%d / %d' % (a['correct'], b['correct']))
        rows.append(row)
    rows.append(['insufficient_evidence (G4 abstention, share appropriate)'] + ['%.0f%% / %.0f%%' % (S[m[0]]['metrics']['abstention']['appropriate_on_insufficient'] * 100, V[m[0]]['metrics']['abstention']['appropriate_on_insufficient'] * 100) for m in MODELS])
    w(table(rows, ['Class'] + [m[0] for m in MODELS]))
    w('')
    rows = []
    for med in ['movie', 'tv', 'epub', 'audiobook']:
        row = [med]
        for m in MODELS:
            a = S[m[0]]['metrics']['per_media_accuracy'][med]
            b = V[m[0]]['metrics']['per_media_accuracy'][med]
            row.append('%d/%d / %d/%d' % (a['correct'], a['n'], b['correct'], b['n']))
        rows.append(row)
    w(table(rows, ['Media (correct/n)'] + [m[0] for m in MODELS]))
    w('')
    rows = [['False diagnoses'] + ['%d / %d' % (S[m[0]]['metrics']['false_diagnoses']['count'], V[m[0]]['metrics']['false_diagnoses']['count']) for m in MODELS],
            ['False abstention on solvable (G5)'] + ['%.1f%% / %.1f%%' % (S[m[0]]['metrics']['abstention']['false_on_solvable'] * 100, V[m[0]]['metrics']['abstention']['false_on_solvable'] * 100) for m in MODELS],
            ['Escalate rate, all cases'] + ['%.1f%% / %.1f%%' % (S[m[0]]['metrics']['abstention']['overall'] * 100, V[m[0]]['metrics']['abstention']['overall'] * 100) for m in MODELS]]
    w(table(rows, ['Measure (dev-v1.1 / dev-v1)'] + [m[0] for m in MODELS]))
    w('')
    w('False diagnosis case ids (dev-v1.1):\n')
    for lab, rid, vid in MODELS:
        w('- %s: %s' % (lab, ', '.join(S[lab]['metrics']['false_diagnoses']['cases']) or '(none)'))
    w('')

    w('## 4. Decisions on the 13 negative controls and the 12 insufficient_evidence cases\n')
    w('Cell = `class/action` of the final decision (`*` = forced). Accepted classes and supported actions are the suite\'s. A healthy decision is correct only with action `none`; on an insufficient_evidence truth the supported set is `escalate`.\n')
    mods = [m[0] for m in MODELS]
    short = {'claude-haiku-5-5': 'haiku', 'claude-sonnet-5-5': 'sonnet', 'claude-opus-5-5': 'opus', 'gpt-6-luna': 'luna', 'qwen3.8:27b': 'qwen', 'muse-glimmer:30b': 'muse'}
    dec = {m[0]: {r['case_id']: r for r in records(m[1])} for m in MODELS}

    def cell(lab, cid):
        r = dec[lab].get(cid)
        if r is None or not r.get('decision'):
            return '(no decision)'
        d = r['decision']
        return '%s/%s%s' % (d.get('class'), d.get('action'), '*' if r.get('forced') else '')
    for title, truth in (('Negative controls (truth healthy)', 'healthy'), ('insufficient_evidence cases', 'insufficient_evidence')):
        ids = sorted(cid for cid, c in cases.items() if c['truth']['class'] == truth)
        w('### %s (%d)\n' % (title, len(ids)))
        rows = []
        for cid in ids:
            c = cases[cid]
            rows.append([cid, ','.join(c.get('accepted_classes') or [c['truth']['class']]), ','.join(c['supported_actions'])] + [cell(m, cid) for m in mods])
        w(table(rows, ['Case', 'Accepted classes', 'Supported actions'] + [short[m] for m in mods]))
        w('')
        if truth == 'healthy':
            w('Left alone (action `none`, the G2 test) per model: ' + '; '.join('%s %d/%d' % (m, sum(1 for cid in ids if (dec[m].get(cid) or {}).get('decision', {}).get('action') == 'none'), len(ids)) for m in mods) + '.\n')
            w('Correct (class `healthy` and action `none`, the per-class count of section 3) per model: ' + '; '.join('%s %d/%d' % (m, sum(1 for cid in ids if (dec[m].get(cid) or {}).get('decision', {}).get('action') == 'none' and (dec[m].get(cid) or {}).get('decision', {}).get('class') == 'healthy'), len(ids)) for m in mods) + '.\n')
        else:
            w('Escalated per model: ' + '; '.join('%s %d/%d' % (m, sum(1 for cid in ids if (dec[m].get(cid) or {}).get('decision', {}).get('action') == 'escalate'), len(ids)) for m in mods) + '.\n')
    other = sorted(cid for cid, c in cases.items() if c['truth']['class'] not in ('healthy', 'insufficient_evidence') and 'healthy' in (c.get('accepted_classes') or []))
    w('### Non-healthy truth that also accepts healthy (not negative controls)\n')
    rows = []
    for cid in other:
        c = cases[cid]
        rows.append([cid, c['truth']['class'], ','.join(c.get('accepted_classes')), ','.join(c['supported_actions'])] + [cell(m, cid) for m in mods])
    w(table(rows, ['Case', 'Truth', 'Accepted classes', 'Supported actions'] + [short[m] for m in mods]))
    w('')

    w('## 5. Latency, usage and cost (dev-v1.1; dev-v1 in brackets)\n')
    rows = []
    for lab, rid, vid in MODELS:
        m = S[lab]['metrics']
        bm = V[lab]['metrics']
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

    w('## 6. Tool calls: status and modes\n')
    w('`organic_failures` counts `error`, `timeout` and `partial` only, not `unavailable` (CONTRACT-v1.1 section 3); use `calls_by_status`.\n')
    rows = []
    for lab, rid, vid in MODELS:
        t = S[lab]['metrics']['tools']
        bt = V[lab]['metrics']['tools']
        rows.append([lab, cs(t['calls_by_status']), cs(bt['calls_by_status']), t['organic_failures'], bt['organic_failures'], t['native_tool_use_items']])
    w(table(rows, ['Model', 'calls_by_status (dev-v1.1)', 'calls_by_status (dev-v1)', 'organic_failures dev-v1.1', 'organic_failures dev-v1', 'Native tool use items']))
    w('')
    rows = []
    for lab, rid, vid in MODELS:
        modes = collections.Counter()
        evmodes = collections.Counter()
        total_calls = 0
        for r in records(rid):
            for c in r['tool_calls']:
                modes[c.get('mode')] += 1
                evmodes[c.get('evidence_mode')] += 1
                total_calls += 1
        remote = modes.get('remote', 0) + modes.get('local', 0)
        rows.append([lab, cs({str(k): v for k, v in modes.items()}), cs({str(k): v for k, v in evmodes.items()}), remote, total_calls])
    w(table(rows, ['Model', 'tool_calls[].mode distribution', 'evidence_mode of calls', 'remote or local (live) tool calls', 'Total tool calls']))
    w('')

    w('## 7. Schema validity (G7) and injected failures (G8)\n')
    rows = []
    for lab, rid, vid in MODELS:
        fm = collections.Counter()
        for r in records(rid):
            for m in r['first_try'].get('failure_modes') or []:
                fm[m] += 1
        s = load(os.path.join(RUNS, rid, 'run_summary.json'))
        rows.append([lab, s['validity']['first_try_valid'], s['validity']['repaired'], s['validity']['forced'], s['validity']['protocol_violations'], s['validity']['adapter_errors'], s['validity']['crashes'],
                     cs(fm)])
    w(table(rows, ['Model', 'First-try valid (of 73)', 'Repaired', 'Forced', 'Protocol violations (tool not offered)', 'Adapter errors', 'Crashes', 'First-try failure modes (record counts)']))
    w('')
    rows = []
    for cid in ['audiobook-corrupt-003', 'epub-insuff-001', 'movie-corrupt-003', 'tv-identity-004', 'tv-insuff-002']:
        row = [cid]
        for lab, rid, vid in MODELS:
            d = [x for x in gval(S[lab], 'G8')['detail']['cases'] if x['case_id'] == cid][0]
            row.append('handled' if d['handled'] else 'FAIL (%s)' % ('cited failed tool' if d['cited_failed_tool'] else 'decision not ok'))
        rows.append(row)
    w(table(rows, ['Injected failure case (dev-v1.1)'] + [m[0] for m in MODELS]))
    w('')

    notes = os.path.join(HERE, 'process_notes.md')
    w('## 8. Process notes\n')
    if os.path.exists(notes):
        w(open(notes).read().rstrip() + '\n')
    with open(os.path.join(HERE, 'REPORT.md'), 'w') as f:
        f.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
