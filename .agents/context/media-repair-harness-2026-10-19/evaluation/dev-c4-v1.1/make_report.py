#!/usr/bin/env python3
"""Builds REPORT.md for the dev-c4 evaluator run on the corrected dev suite dev-v1.1 (scorer v1.1) from the run records, the
score.json files that the evaluator's harness/score.py wrote next to them, and the dev-c3 on dev-v1.1 score.json files in
../dev-c3-v1.1/runs.  Purely factual: nothing is re-scored here.  Usage: python3 -I -B make_report.py  (run from anywhere)."""
import collections
import glob
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(os.path.dirname(HERE))
RUNS = os.path.join(HERE, 'runs')
PREVRUNS = os.path.join(R, 'evaluation', 'dev-c3-v1.1', 'runs')
SUITE_CASES = os.path.join(R, 'suite-dev-v1.1', 'cases')
PROMPT_SHA = 'a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd'
PROMPT_FILE_SHA = '48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a'
FROZEN = 'f38f605b56083491273e391d345f0a05233a9f4e'
SCORE_SHA = '5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789'

MODELS = [  # (label, dev-c4 run id, dev-c3 on dev-v1.1 run id)
    ('claude-haiku-5-5', 'evaldevc4v11-claude-haiku-5-5-v4g2', 'evaldevc3v11-claude-haiku-5-5-v3'),
    ('claude-sonnet-5-5', 'evaldevc4v11-claude-sonnet-5-5-v4g2', 'evaldevc3v11-claude-sonnet-5-5-v3'),
    ('claude-opus-5-5', 'evaldevc4v11-claude-opus-5-5-v4g2', 'evaldevc3v11-claude-opus-5-5-v3'),
    ('gpt-6-luna', 'evaldevc4v11-gpt-6-luna-v4g2', 'evaldevc3v11-gpt-6-luna-v3'),
    ('qwen3.8:27b', 'evaldevc4v11-qwen3.8-27b-v4g2', 'evaldevc3v11-qwen3.8-27b-v3'),
    ('muse-glimmer:30b', 'evaldevc4v11-muse-glimmer-30b-v4g2', 'evaldevc3v11-muse-glimmer-30b-v3'),
]
CP1_DIGESTS = {'qwen3.8:27b': 'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813',
               'muse-glimmer:30b': 'de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1'}
WRITE_ACTIONS = ('blocklist_and_search', 'remap', 'rename', 'convert')
GATE_NAMES = ['G%d' % i for i in range(1, 11)]
CLASSES = ['corrupt_file', 'decoder_incompatible', 'identity_mismatch', 'metadata_naming', 'order_edition_ambiguity', 'healthy']
SHORT = {'claude-haiku-5-5': 'haiku', 'claude-sonnet-5-5': 'sonnet', 'claude-opus-5-5': 'opus', 'gpt-6-luna': 'luna', 'qwen3.8:27b': 'qwen', 'muse-glimmer:30b': 'muse'}


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


def pe_stats(rid):
    """Ollama only: max prompt_eval_count (as reported), max estimated prompt tokens, record-level context_check flag counts."""
    mx, mxcase, est, n = 0, None, 0, 0
    flagged, flagc, numctx, noctx = 0, collections.Counter(), set(), 0
    for r in records(rid):
        cc = r.get('context_check')
        if cc is None:
            noctx += 1
        else:
            numctx.add(cc.get('num_ctx'))
            fl = set(cc.get('flags') or [])
            if cc.get('truncated_suspected') or fl & {'prompt_at_context_limit', 'context_full_after_generation', 'estimated_prompt_exceeds_context'}:
                flagged += 1
            for f in fl:
                flagc[f] += 1
        for t in r['turns']:
            ctx = (t.get('meta') or {}).get('context') or {}
            pe = (t.get('native') or {}).get('prompt_eval_count')
            if pe is None:
                pe = ctx.get('prompt_tokens_reported')
            if pe is not None:
                n += 1
                if pe > mx:
                    mx, mxcase = pe, r['case_id']
            est = max(est, ctx.get('prompt_tokens_estimated') or 0)
    return mx, mxcase, est, n, flagged, flagc, sorted(numctx), noctx


def main():
    S = {m[0]: load(os.path.join(RUNS, m[1], 'score.json')) for m in MODELS}
    V = {m[0]: load(os.path.join(PREVRUNS, m[2], 'score.json')) for m in MODELS}
    cases = {}
    for f in sorted(glob.glob(os.path.join(SUITE_CASES, '*.json'))):
        c = load(f)
        cases[c['id']] = c
    manifest = load(os.path.join(R, 'suite-dev-v1.1', 'manifest.json'))
    msha = hashlib.sha256(open(os.path.join(R, 'suite-dev-v1.1', 'manifest.json'), 'rb').read()).hexdigest()
    mods = [m[0] for m in MODELS]
    out = []
    w = out.append
    w('# dev-c4 evaluator run on the corrected dev suite dev-v1.1 (prompt v4, guards v2, replay evidence, scorer v1.1)\n')
    w('OpenProject #137 (haynes-media-repair). Worker W21. **DEV results only**: the 73 `dev-v1.1` cases are the corrected copy of the dev split that built and tuned the harness; nothing is held out, '
      'each model ran each case once. Purely factual; this file makes no recommendation about the held-out run. Harness code: the frozen dev-c4 commit `f38f605b56083491273e391d345f0a05233a9f4e` (unchanged). Scorer: the evaluator\'s '
      '`harness/score.py` (sha256 `%s`, byte-identical to the dev-c3 run\'s), loaded by path with the dev-c4 package\'s `protocol` and `run` modules; `GATES.md`, the suite and the scorer were not modified. '
      'The comparison value in every "dev-c4 / dev-c3" cell is dev-c3 (prompt v3, no guards, frozen `616e3bfc`) on the same suite dev-v1.1, from `../dev-c3-v1.1/runs/*/score.json`; the suite, scorer and gates are the same, '
      'the candidate (harness version, prompt v4 instead of v3, guards v2 on) is what differs. One sample per case and model, so a difference of a few cases is within run-to-run variation.\n' % SCORE_SHA)

    w('## 1. Identity\n')
    w('| Item | Value |\n|---|---|')
    w('| Candidate | `dev-c4`, frozen commit `f38f605b56083491273e391d345f0a05233a9f4e` (PR #1021), run from a clean detached worktree of that commit (`dirty: false` and `harness_git_sha` = that commit in every record) |')
    w('| Prompt v4 file sha256 | `%s` (verified before the runs) |' % PROMPT_FILE_SHA)
    w('| Assembled system prompt sha256 in every record | `%s` (%s) |' % (PROMPT_SHA, 'verified in all %d records' % sum(1 for m in MODELS for _ in records(m[1]))))
    w('| Run flags | `--suite suite-dev-v1.1 --split dev --prompt v4 --guards v2 --evidence replay` (Ollama: `--num-ctx 8192 --keep-alive 2m`), 73 cases, serial, `nice -n 19` |')
    w('| Suite | `%s`, derived from `%s`, `suite-dev-v1.1/manifest.json` sha256 `%s` |' % (manifest['suite_version'], manifest['derived_from'], msha))
    w('| Guards | `v2` in every run (`config.guards` in each manifest and `guard.version` in every record); decisions as recorded are the guarded ones |')
    w('| Tooling | see section 9 |')
    w('')
    rows = []
    for lab, rid, vid in MODELS:
        s = S[lab]
        recs = list(records(rid))
        pshas = sorted({r['prompt']['sha256'] for r in recs})
        vers = sorted({'%s %s' % (r['harness_version'], r['harness_git_sha'][:8]) for r in recs})
        digs = sorted({str(r['model_digest']) for r in recs})
        resp = sorted({m for r in recs for m in r['response_model_ids']})
        req = sorted({r['requested_model'] for r in recs})
        man = load(os.path.join(RUNS, rid, 'manifest.json'))
        if digs == ['None']:
            dig = 'none (hosted model)'
        else:
            dig = '`%s` (checkpoint 1: %s)' % (digs[0], 'identical' if CP1_DIGESTS.get(lab) == digs[0] else 'DIFFERENT: %s' % CP1_DIGESTS.get(lab))
        rows.append([lab, '`%s`' % rid, '`%s`' % s['config_hash'][:12] + ' (dev-c3 run `%s`)' % V[lab]['config_hash'][:12], ', '.join(resp) + (' (= requested)' if resp == req else ' (REQUESTED %s)' % ', '.join(req)), dig,
                     'ok' if pshas == [PROMPT_SHA] else 'MISMATCH', ', '.join(vers), len(recs), man['started_at'][:19]])
    w(table(rows, ['Model', 'Run id', 'config_hash', 'Response model id(s)', 'Digest', 'Prompt sha', 'Harness', 'Records', 'Started (UTC)']))
    w('\nThe config hash differs from the dev-c3 run of the same model because the prompt version and harness version are part of it. Full hashes are in each `runs/<id>/manifest.json`. '
      'Labelled 2-case smoke runs (`evaldevc4v11-smoke-*`: haiku, qwen, muse) preceded the first Claude pass and each Ollama pass; they are not scored.\n')

    w('## 2. Gates G1-G10: dev-c4 vs dev-c3, both on dev-v1.1\n')
    w('Each cell: dev-c4 (prompt v4, guards v2 applied, as recorded) / dev-c3 (prompt v3, no guards). Gate thresholds are those of `GATES.md` (unchanged). G3 additionally needs every class >= 2/3. Population: 13 negative controls, 12 insufficient_evidence cases.\n')
    hdr = ['Gate', 'Threshold'] + mods
    thr = {'G1': '0', 'G2': '100%', 'G3': '>=85%, classes >=2/3', 'G4': '>=90%', 'G5': '<=15%', 'G6': '>=90%', 'G7': '>=98%', 'G8': '100%', 'G9': '0 crashes, p95<=300 s', 'G10': '100%'}
    rows = []
    for g in GATE_NAMES:
        rows.append([g, thr[g]] + ['%s / %s' % (fmt_gate(gval(S[m], g)), fmt_gate(gval(V[m], g))) for m in mods])
    rows.append(['Overall', 'all pass'] + ['%s / %s' % (S[m]['overall'].upper(), V[m]['overall'].upper()) for m in mods])
    w(table(rows, hdr))
    w('')

    # ---- guards: the model's own decisions (offline `mrh-guard --restore`, no model call), hidden writes, guard escalates ----
    O = {m[0]: load(os.path.join(RUNS, m[1] + '-guardsoff', 'score.json')) for m in MODELS}

    def is_unsafe(c, d):
        """score.py case_facts' unsafe-write rule (score.py lines 102-108), applied to a decision d on case c; report-side re-statement, checked below against the guards-off G1 case lists."""
        truth, sup = c['truth']['class'], list(c.get('supported_actions', []))
        act, cls = d.get('action'), d.get('class')
        unsafe = act in WRITE_ACTIONS and (act not in sup or truth in ('healthy', 'insufficient_evidence'))
        explicit = bool(c.get('accepted_classes'))
        return unsafe or (explicit and cls in ('healthy', 'insufficient_evidence') and act in WRITE_ACTIONS)

    HID = {}      # model -> list of dict rows: every record whose guard changed a decision whose ORIGINAL action was a write
    CH = {}       # model -> list of (case id, rule(s), original dict, final dict, forced flag) for every changed decision
    for lab, rid, vid in MODELS:
        HID[lab], CH[lab] = [], []
        for r in records(rid):
            g = r.get('guard') or {}
            if not g.get('final_changed'):
                continue
            ap = g['applied']
            o = ap[0]['original']
            c = cases[r['case_id']]
            CH[lab].append((r['case_id'], [x['rule'] for x in ap], o, r['decision'], bool(r.get('forced'))))
            if o.get('action') in WRITE_ACTIONS:
                HID[lab].append({'case': r['case_id'], 'rule': ', '.join(x['rule'] for x in ap), 'orig': '%s/%s' % (o.get('class'), o.get('action')),
                                 'final': '%s/%s' % (r['decision'].get('class'), r['decision'].get('action')), 'unsafe': is_unsafe(c, o), 'truth': c['truth']['class']})
    # cross-check: hidden unsafe writes must equal the difference between the guards-off and the guarded G1 case lists
    for lab in mods:
        hu = sorted(x['case'] for x in HID[lab] if x['unsafe'])
        diff = sorted(set(gval(O[lab], 'G1')['detail']['cases']) - set(gval(S[lab], 'G1')['detail']['cases']))
        assert hu == diff, (lab, hu, diff)

    w('### 2a. G1 next to the guard-hidden writes\n')
    w('`score.py` reads only the final (guarded) `decision`, so a guard that turns a proposed write into an escalate also removes it from G1. This table puts G1 as scored, G1 on the model\'s own decisions (section 2b) and the count of writes the guards hid '
      '(records with `guard.final_changed` whose original action is a write) next to each other. *Hidden unsafe* = the original would be an unsafe write under score.py\'s rule (lines 102-108: a write outside the case\'s supported set, a write on a healthy or insufficient_evidence truth, '
      'or a write under a healthy / insufficient_evidence class on a case with `accepted_classes`); it is checked against the G1 case lists of the guards-off scoring (they agree for all six models).\n')
    rows = []
    for lab in mods:
        rows.append([lab, gval(S[lab], 'G1')['value'], gval(O[lab], 'G1')['value'], len(HID[lab]), sum(1 for x in HID[lab] if x['unsafe'])])
    w(table(rows, ['Model', 'G1, guarded system (as recorded)', 'G1, model\'s own decisions (guards off)', 'Hidden writes (guard changed an original write)', 'Hidden UNSAFE writes']))
    w('')
    w('#### Guard-hidden writes, every record\n')
    rows = []
    for lab in mods:
        for x in HID[lab]:
            rows.append([lab, x['case'], x['truth'], x['rule'], x['orig'], x['final'], 'yes' if x['unsafe'] else 'no'])
    w(table(rows, ['Model', 'Case', 'Truth class', 'Guard rule', 'Original class/action', 'Final (guarded) class/action', 'Original unsafe under score.py?']) if rows else '(none)')
    w('')

    w('### 2b. The model\'s own decisions (guards off, re-scored from a copy) vs dev-c3\n')
    w('Made offline from each recorded run with `mrh-guard --restore` (the model\'s original decisions put back into a COPY under `runs/<run id>-guardsoff/`; no model call; the recorded run is untouched) and scored with the same unchanged scorer. '
      'Section 2 is the configuration under test (guards v2 as recorded); this table is the SECONDARY diagnostic. Cell: dev-c4 model\'s own decisions / dev-c3 (prompt v3, no guards).\n')
    rows = []
    for g in GATE_NAMES:
        rows.append([g, thr[g]] + ['%s / %s' % (fmt_gate(gval(O[m], g)), fmt_gate(gval(V[m], g))) for m in mods])
    rows.append(['Overall', 'all pass'] + ['%s / %s' % (O[m]['overall'].upper(), V[m]['overall'].upper()) for m in mods])
    w(table(rows, hdr))
    w('')
    w('Guarded system / model\'s own decisions, side by side (the same data as sections 2 and 2b):\n')
    rows = []
    for g in GATE_NAMES:
        rows.append([g] + ['%s / %s' % (fmt_gate(gval(S[m], g)), fmt_gate(gval(O[m], g))) for m in mods])
    rows.append(['Overall'] + ['%s / %s' % (S[m]['overall'].upper(), O[m]['overall'].upper()) for m in mods])
    w(table(rows, ['Gate'] + mods))
    w('')
    rows = []
    for c in CLASSES:
        row = [c + ' (n %d)' % S[mods[0]]['metrics']['per_class_accuracy'].get(c, {}).get('n', 0)]
        for m in mods:
            a = S[m]['metrics']['per_class_accuracy'].get(c, {'correct': 0, 'n': 0})
            b = O[m]['metrics']['per_class_accuracy'].get(c, {'correct': 0, 'n': 0})
            row.append('%d / %d' % (a['correct'], b['correct']))
        rows.append(row)
    rows.append(['G1 case ids'] + ['%s / %s' % (', '.join(gval(S[m], 'G1')['detail']['cases']) or '(none)', ', '.join(gval(O[m], 'G1')['detail']['cases']) or '(none)') for m in mods])
    w(table(rows, ['Class correct (guarded / own decisions)'] + mods))
    w('')
    w('#### G8 with and without the guards\n')
    w('A guard-made escalate carries empty `evidence_refs`, so the scorer\'s G8 (does the decision cite a failed tool) can differ between the two scorings. Cases where `handled` differs:\n')
    for m in mods:
        da = {x['case_id']: x['handled'] for x in gval(S[m], 'G8')['detail']['cases']}
        db = {x['case_id']: x['handled'] for x in gval(O[m], 'G8')['detail']['cases']}
        dif = sorted(k for k in da if da[k] != db.get(k))
        w('- %s: %s' % (m, '; '.join('%s guarded %s, own decisions %s' % (k, 'handled' if da[k] else 'FAIL', 'handled' if db[k] else 'FAIL') for k in dif) or 'no case differs (G8 %s guarded, %s own decisions)' % (fmt_gate(gval(S[m], 'G8')), fmt_gate(gval(O[m], 'G8')))))
    w('')

    w('### 2c. Decisions changed by the guards (as recorded)\n')
    w('A guard can only turn a decision into `insufficient_evidence` / `escalate`; the model\'s own decision stays in the record\'s `guard.applied[].original`. A guard-made escalate is not a forced escalate: the `forced` flag stays false on them '
      '(counts below). `Original correct` = the original class was accepted and its action supported for that case; `final correct` the same for the guarded decision. A decision can be counted under more than one rule when two fire.\n')
    rows, byact_rows = [], []
    for lab, rid, vid in MODELS:
        by_rule, by_act, oc, fc = collections.Counter(), collections.Counter(), 0, 0
        for cid, rules, o, fin, forced in CH[lab]:
            c = cases[cid]
            acc = c.get('accepted_classes') or [c['truth']['class']]
            oc += 1 if (o.get('class') in acc and o.get('action') in c['supported_actions']) else 0
            fc += 1 if (fin.get('class') in acc and fin.get('action') in c['supported_actions']) else 0
            for rl in rules:
                by_rule[rl] += 1
                by_act[(rl, '%s/%s' % (o.get('class'), o.get('action')))] += 1
        fired = sum(len(r['guard']['applied']) for r in records(rid) if r.get('guard'))
        rows.append([lab, len(CH[lab]), fired, cs(by_rule), sum(1 for x in CH[lab] if x[4]), oc, fc, ', '.join(x[0] for x in CH[lab]) or '-'])
        byact_rows.append([lab, '; '.join('%s: %s %d' % (k[0], k[1], v) for k, v in sorted(by_act.items())) or '-'])
    w(table(rows, ['Model', 'Guard-made escalates (decisions changed)', 'Guard firings (applied)', 'By rule', 'Of which `forced`', 'Original correct', 'Final correct', 'Case ids']))
    w('\nBy rule and original `class/action`:\n')
    w(table(byact_rows, ['Model', 'Rule: original class/action count']))
    w('')
    w('#### In-sample note on G-healthy (G4 and G5)\n')
    w('The G-healthy rule (turns `healthy`/`none` into an escalate when no integrity check the model could see ran with status `ok`) was designed after the per-case dev results of earlier runs on this same dev suite. '
      'Its effect on G4 and G5 below is therefore **in-sample** and is not evidence of the same effect on cases the rule was not designed on. G-write is also derived from the dev audit rules.\n')
    rows = []
    for m in mods:
        rows.append([m, fmt_gate(gval(S[m], 'G4')), fmt_gate(gval(O[m], 'G4')), '%.1f%%' % (S[m]['metrics']['abstention']['false_on_solvable'] * 100), '%.1f%%' % (O[m]['metrics']['abstention']['false_on_solvable'] * 100),
                     sum(1 for x in CH[m] if 'G-healthy' in x[1]), sum(1 for x in CH[m] if 'G-write' in x[1])])
    w(table(rows, ['Model', 'G4 guarded', 'G4 own decisions', 'G5 guarded', 'G5 own decisions', 'G-healthy changes', 'G-write changes']))
    w('')
    w('### G1 and related counts\n')
    rows = []
    for lab, rid, vid in MODELS:
        s = S[lab]
        gc = s['g1_context']
        gcb = V[lab]['g1_context']
        m = s['metrics']
        rows.append([lab, gval(s, 'G1')['value'], gval(V[lab], 'G1')['value'], '%d / %d' % (gc['rejected_write_attempts']['count'], gcb['rejected_write_attempts']['count']), '%d / %d' % (gc['forced']['count'], gcb['forced']['count']),
                     gc['forced']['where_escalate_is_unsupported'] or '-', '%d / %d' % (m['schema']['repair_prompts'], V[lab]['metrics']['schema']['repair_prompts']), sum(1 for r in records(rid) if r['protocol_violations'])])
    w(table(rows, ['Model', 'G1 unsafe (dev-c4)', 'G1 (dev-c3)', 'Rejected write attempts (`g1_context`) dev-c4 / dev-c3', 'Forced escalates dev-c4 / dev-c3', 'Forced where escalate is unsupported (dev-c4)', 'Repair prompts dev-c4 / dev-c3', 'Cases with a protocol violation (dev-c4)']))
    w('\n*Rejected write attempts* = turns whose reply was a parseable write decision (`blocklist_and_search`, `remap`, `rename`, `convert`) that the strict validator rejected (`validation_errors` non-empty: '
      'missing or malformed audit, over-length audit fields, audit.target not equal to target). Replies that were not parseable JSON are not counted. *Forced* = no valid decision after the step budget or '
      'after a failed repair (`action=escalate, forced=true`). Both are read from `g1_context` in `score.json`; no gate reads them. dev-c4 case ids: ' +
      '; '.join('%s rejected [%s] forced [%s]' % (m, ', '.join(S[m]['g1_context']['rejected_write_attempts']['cases']) or '-', ', '.join(S[m]['g1_context']['forced']['cases']) or '-') for m in mods) + '.\n')

    w('### Rejected write attempts and forced escalates, from the records\' `write_rejection` field (dev-c4 only)\n')
    rows = []
    for lab, rid, vid in MODELS:
        att = collections.Counter()
        repaired, fa, tot, ncase = 0, 0, 0, 0
        for r in records(rid):
            wr = r.get('write_rejection') or {}
            n = wr.get('rejected_write_attempts', 0)
            tot += n
            ncase += 1 if n else 0
            repaired += 1 if wr.get('repaired_to_valid_decision') else 0
            fa += 1 if wr.get('forced_after_rejected_write') else 0
            for a in wr.get('attempts') or []:
                att[a.get('action')] += 1
        rows.append([lab, tot, ncase, repaired, fa, cs(att)])
    w(table(rows, ['Model', 'Rejected write attempts', 'Cases with one', 'Repaired to a valid decision', 'Forced after a rejected write', 'Rejected attempts by action']))
    w('\nThe field is record-only (CANDIDATE-dev-c3): a rejected write decision never became the decision. Its count should equal the scorer\'s `g1_context` count above.\n')

    w('### G1 unsafe cases (dev split, case ids)\n')
    rows = []
    for lab, rid, vid in MODELS:
        g1 = gval(S[lab], 'G1')['detail']['cases']
        b1 = gval(V[lab], 'G1')['detail']['cases']
        rows.append([lab, ', '.join(g1) or '(none)', ', '.join(b1) or '(none)'])
    w(table(rows, ['Model', 'dev-c4 on dev-v1.1', 'dev-c3 on dev-v1.1']))
    w('')

    w('## 3. Per-class and per-media-type correct counts (dev-c4 / dev-c3, both dev-v1.1)\n')
    w('A decision is correct when its class is in the case\'s accepted classes AND its action is in the supported set. `n` is the number of cases in the scorer\'s per-class population (solvable cases by truth class). '
      'The G3 per-class floor is 2/3; **bold** below marks a dev-c4 class under that floor.\n')
    rows = []
    for c in CLASSES:
        n1 = S[mods[0]]['metrics']['per_class_accuracy'].get(c, {}).get('n', 0)
        row = [c + ' (n %d)' % n1]
        for m in mods:
            a = S[m]['metrics']['per_class_accuracy'].get(c, {'correct': 0, 'n': 0})
            b = V[m]['metrics']['per_class_accuracy'].get(c, {'correct': 0})
            cell = '%d / %d' % (a['correct'], b['correct'])
            if a['n'] and a['correct'] * 3 < 2 * a['n']:
                cell = '**%s** (below 2/3)' % cell
            elif a['n']:
                cell += ' (>= 2/3)'
            row.append(cell)
        rows.append(row)
    rows.append(['insufficient_evidence (G4 abstention, share appropriate)'] + ['%.0f%% / %.0f%%' % (S[m]['metrics']['abstention']['appropriate_on_insufficient'] * 100, V[m]['metrics']['abstention']['appropriate_on_insufficient'] * 100) for m in mods])
    w(table(rows, ['Class'] + mods))
    w('')
    w('Classes below 2/3 per the scorer (`G3.detail.classes_below_2_of_3`), dev-c4: ' + '; '.join('%s %s' % (m, json.dumps(gval(S[m], 'G3')['detail']['classes_below_2_of_3'], sort_keys=True) if gval(S[m], 'G3')['detail']['classes_below_2_of_3'] else '(none)') for m in mods) + '.\n')
    rows = []
    for med in ['movie', 'tv', 'epub', 'audiobook']:
        row = [med]
        for m in mods:
            a = S[m]['metrics']['per_media_accuracy'][med]
            b = V[m]['metrics']['per_media_accuracy'][med]
            row.append('%d/%d / %d/%d' % (a['correct'], a['n'], b['correct'], b['n']))
        rows.append(row)
    w(table(rows, ['Media (correct/n)'] + mods))
    w('')
    rows = [['False diagnoses'] + ['%d / %d' % (S[m]['metrics']['false_diagnoses']['count'], V[m]['metrics']['false_diagnoses']['count']) for m in mods],
            ['False abstention on solvable (G5)'] + ['%.1f%% / %.1f%%' % (S[m]['metrics']['abstention']['false_on_solvable'] * 100, V[m]['metrics']['abstention']['false_on_solvable'] * 100) for m in mods],
            ['Escalate rate, all cases'] + ['%.1f%% / %.1f%%' % (S[m]['metrics']['abstention']['overall'] * 100, V[m]['metrics']['abstention']['overall'] * 100) for m in mods]]
    w(table(rows, ['Measure (dev-c4 / dev-c3)'] + mods))
    w('')
    w('False diagnosis case ids (dev-c4):\n')
    for m in mods:
        w('- %s: %s' % (m, ', '.join(S[m]['metrics']['false_diagnoses']['cases']) or '(none)'))
    w('')

    w('## 4. Decisions on the 13 negative controls and the 12 insufficient_evidence cases (dev-c4)\n')
    w('Cell = `class/action` of the final decision (`*` = forced). Accepted classes and supported actions are the suite\'s. A healthy decision is correct only with action `none`; on an insufficient_evidence truth the supported set is `escalate`.\n')
    dec = {m[0]: {r['case_id']: r for r in records(m[1])} for m in MODELS}
    dec2 = {m[0]: {r['case_id']: r for r in records(m[2], PREVRUNS)} for m in MODELS}

    def cell(lab, cid, d=dec):
        r = d[lab].get(cid)
        if r is None or not r.get('decision'):
            return '(no decision)'
        x = r['decision']
        return '%s/%s%s' % (x.get('class'), x.get('action'), '*' if r.get('forced') else '')
    for title, truth in (('Negative controls (truth healthy)', 'healthy'), ('insufficient_evidence cases', 'insufficient_evidence')):
        ids = sorted(cid for cid, c in cases.items() if c['truth']['class'] == truth)
        w('### %s (%d)\n' % (title, len(ids)))
        rows = []
        for cid in ids:
            c = cases[cid]
            rows.append([cid, ','.join(c.get('accepted_classes') or [c['truth']['class']]), ','.join(c['supported_actions'])] + [cell(m, cid) for m in mods])
        w(table(rows, ['Case', 'Accepted classes', 'Supported actions'] + [SHORT[m] for m in mods]))
        w('')
        if truth == 'healthy':
            for lbl, d in (('dev-c4', dec), ('dev-c3', dec2)):
                w('Left alone (action `none`, the G2 test), %s: ' % lbl + '; '.join('%s %d/%d' % (SHORT[m], sum(1 for cid in ids if (d[m].get(cid) or {}).get('decision', {}).get('action') == 'none'), len(ids)) for m in mods) + '.\n')
            w('Correct (class `healthy` and action `none`, the per-class count of section 3), dev-c4: ' + '; '.join('%s %d/%d' % (SHORT[m], sum(1 for cid in ids if (dec[m].get(cid) or {}).get('decision', {}).get('action') == 'none' and (dec[m].get(cid) or {}).get('decision', {}).get('class') == 'healthy'), len(ids)) for m in mods) + '.\n')
        else:
            for lbl, d in (('dev-c4', dec), ('dev-c3', dec2)):
                w('Escalated, %s: ' % lbl + '; '.join('%s %d/%d' % (SHORT[m], sum(1 for cid in ids if (d[m].get(cid) or {}).get('decision', {}).get('action') == 'escalate'), len(ids)) for m in mods) + '.\n')
            w('G4 detail from the scorer (`value` is the share of the %d G4 cases handled appropriately; it also counts order_edition_ambiguity cases): ' % gval(S[mods[0]], 'G4')['detail']['n'] + '; '.join('%s %s' % (SHORT[m], fmt_gate(gval(S[m], 'G4'))) for m in mods) + '.\n')
    other = sorted(cid for cid, c in cases.items() if c['truth']['class'] not in ('healthy', 'insufficient_evidence') and 'healthy' in (c.get('accepted_classes') or []))
    w('### Non-healthy truth that also accepts healthy (not negative controls)\n')
    rows = []
    for cid in other:
        c = cases[cid]
        rows.append([cid, c['truth']['class'], ','.join(c.get('accepted_classes')), ','.join(c['supported_actions'])] + [cell(m, cid) for m in mods])
    w(table(rows, ['Case', 'Truth', 'Accepted classes', 'Supported actions'] + [SHORT[m] for m in mods]))
    w('')

    w('### metadata_naming and decoder_incompatible cases (dev-c4 decisions; dev-c3 in brackets)\n')
    w('Cell = `class/action` (`*` = forced); a decision is correct when its class is accepted and its action is supported. `ok` / `X` marks that for dev-c4.\n')
    for truth in ('metadata_naming', 'decoder_incompatible'):
        ids = sorted(cid for cid, c in cases.items() if c['truth']['class'] == truth)
        w('#### Truth %s (%d cases)\n' % (truth, len(ids)))
        rows = []
        for cid in ids:
            c = cases[cid]
            row = [cid, ','.join(c.get('accepted_classes') or [c['truth']['class']]), ','.join(c['supported_actions'])]
            for m in mods:
                r = dec[m].get(cid)
                d = (r or {}).get('decision') or {}
                good = bool(d) and d.get('class') in (c.get('accepted_classes') or [c['truth']['class']]) and d.get('action') in c['supported_actions']
                row.append('%s %s [%s]' % (cell(m, cid), 'ok' if good else 'X', cell(m, cid, dec2)))
            rows.append(row)
        w(table(rows, ['Case', 'Accepted classes', 'Supported actions'] + [SHORT[m] for m in mods]))
        w('')
        cnt = []
        for m in mods:
            cc = collections.Counter(((dec[m].get(cid) or {}).get('decision') or {}).get('class') for cid in ids)
            cnt.append('%s: %s' % (SHORT[m], cs({str(k): v for k, v in cc.items()})))
        w('Decision classes, dev-c4: ' + '; '.join(cnt) + '.\n')

    w('## 5. Latency, usage and cost (dev-c4; dev-c3 in brackets)\n')
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
      '(Claude cache tokens are not in `input_tokens`). G9 p95 is the gate value in section 2.\n' % total)

    w('### Ollama prompt size (num_ctx 8192)\n')
    rows = []
    for lab, rid, vid in MODELS:
        if lab not in CP1_DIGESTS:
            continue
        mx, mxcase, est, n, flagged, flagc, numctx, noctx = pe_stats(rid)
        rows.append([lab, mx, mxcase, est, n, flagged, cs(flagc), ','.join(str(x) for x in numctx) or '-', noctx])
    w(table(rows, ['Model', 'Max `prompt_eval_count`', 'Case of the max', 'Max estimated prompt tokens', 'Turns with a reported count', 'Records with any `context_check` flag (truncated_suspected, prompt_at_context_limit, context_full_after_generation, estimated_prompt_exceeds_context)', 'Flag counts (records; `output_hit_num_predict` is not a truncation flag)', '`context_check.num_ctx`', 'Records without `context_check`']))
    w('\n`prompt_eval_count` is the count Ollama reports for each `/api/chat` request; it excludes tokens served from the prompt cache, so the harness also records a character-based estimate (`prompt_tokens_estimated`) and flags a turn `truncated_suspected` when either points at the window. '
      'The stop threshold was 8000 reported tokens against a window of 8192.\n')

    w('## 6. Tool calls: status and modes\n')
    w('`organic_failures` counts `error`, `timeout` and `partial` only, not `unavailable` (CONTRACT-v1.1 section 3); use `calls_by_status`.\n')
    rows = []
    for lab, rid, vid in MODELS:
        t = S[lab]['metrics']['tools']
        bt = V[lab]['metrics']['tools']
        rows.append([lab, cs(t['calls_by_status']), cs(bt['calls_by_status']), t['organic_failures'], bt['organic_failures'], t['native_tool_use_items']])
    w(table(rows, ['Model', 'calls_by_status (dev-c4)', 'calls_by_status (dev-c3)', 'organic_failures dev-c4', 'organic_failures dev-c3', 'Native tool use items (dev-c4)']))
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

    w('## 7. Schema validity (G7) and first-try failure modes\n')
    rows = []
    for lab, rid, vid in MODELS:
        fm = collections.Counter()
        for r in records(rid):
            for m in r['first_try'].get('failure_modes') or []:
                fm[m] += 1
        fm2 = collections.Counter()
        for r in records(vid, PREVRUNS):
            for m in r['first_try'].get('failure_modes') or []:
                fm2[m] += 1
        s = load(os.path.join(RUNS, rid, 'run_summary.json'))
        s2 = load(os.path.join(PREVRUNS, vid, 'run_summary.json'))
        rows.append([lab, '%d / %d' % (s['validity']['first_try_valid'], s2['validity']['first_try_valid']), '%d / %d' % (s['validity']['repaired'], s2['validity']['repaired']), '%d / %d' % (s['validity']['forced'], s2['validity']['forced']),
                     s['validity']['protocol_violations'], s['validity']['adapter_errors'], s['validity']['crashes'], cs(fm), cs(fm2)])
    w(table(rows, ['Model', 'First-try valid (of 73) dev-c4 / dev-c3', 'Repaired', 'Forced', 'Protocol violations dev-c4 (tool not offered)', 'Adapter errors', 'Crashes', 'First-try failure modes dev-c4 (record counts)', 'First-try failure modes dev-c3']))
    w('')
    w('### Injected failures (G8), dev-c4\n')
    rows = []
    for cid in ['audiobook-corrupt-003', 'epub-insuff-001', 'movie-corrupt-003', 'tv-identity-004', 'tv-insuff-002']:
        row = [cid]
        for lab, rid, vid in MODELS:
            d = [x for x in gval(S[lab], 'G8')['detail']['cases'] if x['case_id'] == cid][0]
            row.append('handled' if d['handled'] else 'FAIL (%s)' % ('cited failed tool' if d['cited_failed_tool'] else 'decision not ok'))
        rows.append(row)
    w(table(rows, ['Injected failure case (dev-v1.1)'] + mods))
    w('')
    w('G8 value dev-c4 / dev-c3: ' + '; '.join('%s %s / %s' % (SHORT[m], fmt_gate(gval(S[m], 'G8')), fmt_gate(gval(V[m], 'G8'))) for m in mods) + '.\n')

    w('## 8. Digests and run state\n')
    rows = []
    for lab, rid, vid in MODELS:
        man = load(os.path.join(RUNS, rid, 'manifest.json'))
        s = load(os.path.join(RUNS, rid, 'run_summary.json'))
        rows.append([lab, man.get('started_at', '')[:19], man.get('finished_at', man.get('ended_at', '')) or '', man.get('aborted'), (((man.get('finish') or {}).get('psi_guard') or {}).get('tripped') if lab in CP1_DIGESTS else 'n/a (hosted)'), len(list(records(rid))), s['validity']['crashes']])
    w(table(rows, ['Model', 'Started (UTC)', 'Finished (UTC)', 'Aborted', 'Guard tripped', 'Records', 'Crashes']))
    w('')

    notes = os.path.join(HERE, 'process_notes.md')
    w('## 9. Process notes\n')
    if os.path.exists(notes):
        w(open(notes).read().rstrip() + '\n')
    with open(os.path.join(HERE, 'REPORT.md'), 'w') as f:
        f.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main()
