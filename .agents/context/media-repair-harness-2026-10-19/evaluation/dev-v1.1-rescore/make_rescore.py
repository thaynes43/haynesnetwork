#!/usr/bin/env python3
"""Rescore the checkpoint 1 and dev-c2 DEV runs against the dev-v1.1 labels and write REPORT.md plus scores/*.json.

  python3 -I -B make_rescore.py          (from anywhere; stdlib plus the harness package on ../../../../tools/media-repair-harness/src)

Indicative only: no model was run.  The run records were produced on dev-v1 inputs; a case whose model-visible content differs in
dev-v1.1 is marked stale_context (the record answers a different question and needs a fresh run).  Nothing under baseline/ or
evaluation/dev-c2/ is modified, and nothing held out is read.
"""
import json
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = HERE.parent.parent
REPO = R.parents[2]
sys.path.insert(0, str(REPO / 'tools' / 'media-repair-harness' / 'src'))
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import score_compat  # noqa: E402

V1, V11 = R / 'suite', R / 'suite-dev-v1.1'
MODELS = [  # (label, checkpoint 1 run id, dev-c2 run id): the same pairs as evaluation/dev-c2/make_report.py
    ('claude-haiku-5-5', 'dev-v1-claude-haiku-5-5', 'evaldevc2-claude-haiku-5-5-v2'),
    ('claude-sonnet-5-5', 'dev-v1-claude-sonnet-5-5', 'evaldevc2-claude-sonnet-5-5-v2'),
    ('claude-opus-5-5', 'dev-v1-claude-opus-5-5', 'evaldevc2-claude-opus-5-5-v2'),
    ('gpt-6-luna', 'dev-v1-codex-gpt-6-luna', 'evaldevc2-gpt-6-luna-v2'),
    ('qwen3.8:27b', 'dev-v1-ollama-qwen3.8-27b', 'evaldevc2-qwen3.8-27b-v2'),
    ('muse-glimmer:30b', 'dev-v1-ollama-muse-glimmer-30b', 'evaldevc2-muse-glimmer-30b-v2'),
]
CP1, DEVC2 = R / 'baseline' / 'runs', R / 'evaluation' / 'dev-c2' / 'runs'
G = ['G%d' % i for i in range(1, 11)]


def load_cases(d):
    return {p.stem: json.loads(p.read_text()) for p in sorted((d / 'cases').glob('*.json'))}


def model_view(c):
    """Everything a model can see about a case (protocol.case_view, before the per-run alias and the evidence rendering)."""
    ctx = c.get('context', {})
    return {'media_type': c.get('media_type'), 'context': {k: ctx.get(k) for k in P.MODEL_CONTEXT_KEYS if k in ctx},
            'evidence': [(e['id'], e['tool'], e.get('args'), e.get('status'), e.get('output')) for e in c.get('evidence', [])],
            'tools_available': list(c.get('tools_available', []))}


def visible_causes(a, b):
    """Which rules changed what the model sees: -> sorted list of rule tags."""
    va, vb = model_view(a), model_view(b)
    out = set()
    if va['tools_available'] != vb['tools_available']:
        out.add('C5')
    ca, cb = dict(va['context']), dict(vb['context'])
    arr_a, arr_b = dict(ca.pop('arr', {}) or {}), dict(cb.pop('arr', {}) or {})
    if arr_a.pop('expected_toc', None) != arr_b.pop('expected_toc', None):
        out.add('C6-3')
    if arr_a != arr_b:
        out.add('C1')
    if ca.get('filename') != cb.get('filename'):
        out.add('C6-fn')
    if {k: v for k, v in ca.items() if k != 'filename'} != {k: v for k, v in cb.items() if k != 'filename'}:
        out.add('context-other')
    ea, eb = va['evidence'], vb['evidence']
    if ea != eb:
        out.add('C6-fn' if a['media_type'] in ('movie', 'tv') else 'C1')
    return sorted(out)


def fmt(g):
    if g['status'] == 'not_evaluated':
        return 'n/a'
    v, st = g['value'], g['status'].upper()
    if g['gate'] == 'G9':
        return '%d crash, p95 %.1f s %s' % (v['crashes'], v['p95_s'], st)
    if g['gate'] == 'G1':
        return '%d %s' % (v, st)
    if isinstance(v, float):
        return '%.1f%% %s' % (v * 100, st)
    return '%s %s' % (v, st)


def table(rows, header):
    return '\n'.join(['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)] + ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows])


def attr_rows(v1, v11):
    """Per-attribute differences between v1 and v1.1 case files: [(case, rule, attribute, before, after)]."""
    rows = []
    cands = OrderedDict([
        ('truth.class', ['C2', 'C3', 'C6-2']), ('truth.source', ['C2', 'C6-2']),
        ('supported_actions', ['C2', 'C3', 'C6-2', 'C6-4', 'C6-5', 'C6-7', 'C6-8', 'C6-11']),
        ('accepted_classes', ['C3', 'C6-11', 'C6-12', 'C6-13']), ('arr', ['C1']), ('arr.expected_toc', ['C6-3']),
        ('arr_lookup', ['C1']), ('arr_lookup path', ['C6-fn']), ('filename', ['C6-fn']), ('tools_available', ['C5']),
    ])

    def rule(cid, attr, c):
        have = [x.split(':')[0] for x in c.get('corrections', [])]
        for r in cands[attr]:
            if r in have:
                return r
        return '?'
    for cid in sorted(v11):
        a, b = v1[cid], v11[cid]
        sets = [('truth.class', a['truth']['class'], b['truth']['class']), ('truth.source', a['truth']['source'], b['truth']['source']),
                ('supported_actions', a['supported_actions'], b['supported_actions']), ('accepted_classes', a.get('accepted_classes', '(default)'), b.get('accepted_classes', '(default)')),
                ('filename', a['context'].get('filename'), b['context'].get('filename')), ('tools_available', a['tools_available'], b['tools_available'])]
        arr_a, arr_b = dict(a['context']['arr']), dict(b['context']['arr'])
        toc = (arr_a.pop('expected_toc', None), arr_b.pop('expected_toc', None))
        sets += [('arr', arr_a.get('app'), arr_b.get('app')), ('arr.expected_toc', toc[0], toc[1])]
        ea = [e for e in a['evidence'] if e['tool'] == 'arr_lookup']
        eb = [e for e in b['evidence'] if e['tool'] == 'arr_lookup']
        if ea != eb:
            if a['media_type'] in ('epub', 'audiobook'):
                sets.append(('arr_lookup', [e['args'].get('app') for e in ea], [e['args'].get('app') for e in eb]))
            else:
                rp = lambda es: [m for e in es for m in re.findall(r'"relativePath":"([^"]*)"', e['output'])]
                sets.append(('arr_lookup path', 'relativePath ' + ', '.join(rp(ea)), 'relativePath ' + ', '.join(rp(eb))))
        for attr, x, y in sets:
            if x != y:
                rows.append((cid, rule(cid, attr, b), attr, x, y))
    return rows


def main():
    mod = score_compat.load_score()
    v1, v11 = load_cases(V1), load_cases(V11)
    assert set(v1) == set(v11)
    causes = {cid: visible_causes(v1[cid], v11[cid]) for cid in v11}
    stale = sorted(cid for cid, c in causes.items() if c)
    fresh = sorted(cid for cid, c in causes.items() if not c)
    c5_only = sorted(cid for cid, c in causes.items() if c == ['C5'])
    cause_count = Counter(x for c in causes.values() for x in c)
    (HERE / 'scores').mkdir(exist_ok=True)

    results = {}   # (label, which) -> {'all':, 'fresh':, 'c5only':, 'v1': committed score.json, 'src': record dir}
    for lab, cp1, c2 in MODELS:
        for which, base in (('cp1', CP1 / cp1), ('devc2', DEVC2 / c2)):
            recs = {p.stem for p in base.glob('*.json') if p.name not in ('manifest.json', 'score.json')}
            full = mod.score(base, V11)
            called_audio = {i for i in recs if any(c['tool'] == 'audio_sample' for c in json.loads((base / (i + '.json')).read_text()).get('tool_calls', []))}
            c5_unaffected = [i for i in c5_only if i not in called_audio]
            results[(lab, which)] = {
                'all': full, 'fresh': mod.score(base, V11, only=fresh), 'c5only': mod.score(base, V11, only=sorted(set(fresh) | set(c5_unaffected))),
                'v1': json.loads((base / 'score.json').read_text()), 'c5_unaffected': c5_unaffected,
                'audio_called': sorted(called_audio & set(c5_only)), 'run_id': base.name}
            (HERE / 'scores' / (base.name + '.v1.1.json')).write_text(json.dumps(full, indent=1, sort_keys=True) + '\n')

    out = []
    w = out.append
    w('# dev-v1.1 rescore of the checkpoint 1 and dev-c2 dev runs (indicative)\n')
    w('OpenProject #137 (haynes-media-repair). **DEV results only**; no model was run, and nothing held out was read. Purely factual. '
      'Inputs: the committed run records under `baseline/runs/` and `evaluation/dev-c2/runs/`, the suite `suite-dev-v1.1/` (derived from dev-v1 by '
      '`suite-dev-v1.1/build_v11.py`) and `harness/score.py` v1.1 (`score(run_dir, suite, only=ids)`). dev-v1, its runs and its scores are unchanged '
      '(`harness/score.py` reproduces every committed `score.json` exactly, see the PR). Regenerate: `python3 -I -B evaluation/dev-v1.1-rescore/make_rescore.py`.\n')
    w('**Read this first.** The run records answer the dev-v1 questions. Under C1, C5 and the C6 context changes the model-visible input of most cases is different in '
      'dev-v1.1, so a record on a `stale_context` case says what the model did on the old input, scored against the new labels. Only a fresh run answers the new case. '
      'The checkpoint 1 runs used prompt v1 and the dev-c2 runs prompt v2 (different harness candidates); the two column sets are not directly comparable.\n')

    w('## 1. Suite shape, dev-v1 to dev-v1.1\n')
    def shape(cs):
        k = Counter(c['truth']['class'] for c in cs.values())
        return k
    k1, k11 = shape(v1), shape(v11)
    classes = ['identity_mismatch', 'corrupt_file', 'decoder_incompatible', 'metadata_naming', 'order_edition_ambiguity', 'insufficient_evidence', 'healthy']
    w(table([[k, k1[k], k11[k]] for k in classes] + [['**total**', len(v1), len(v11)],
                                                       ['negative controls (truth healthy)', k1['healthy'], k11['healthy']],
                                                       ['cases that also accept healthy (not negative controls)', 0, sum('healthy' in c.get('accepted_classes', []) and c['truth']['class'] != 'healthy' for c in v11.values())],
                                                       ['abstention cases (insufficient_evidence + order_edition_ambiguity)', k1['insufficient_evidence'] + k1['order_edition_ambiguity'], k11['insufficient_evidence'] + k11['order_edition_ambiguity']]],
              ['truth.class', 'dev-v1', 'dev-v1.1']) + '\n')
    ck = Counter()
    for c in v11.values():
        for x in c.get('corrections', []):
            ck[x.split(':')[0]] += 1
    w('Changed cases per rule (a case can carry several): ' + ', '.join('%s %d' % (k, ck[k]) for k in sorted(ck, key=lambda s: (s[:2], len(s), s))) + '.\n')

    w('## 2. Stale context\n')
    w('A case is `stale_context` when what a model sees (media type, `context` keys shown to it, pre-collected evidence, `tools_available`) differs from dev-v1. '
      'Causes (a case can have several): ' + ', '.join('%s %d' % (k, v) for k, v in sorted(cause_count.items())) + '.\n')
    w('- **stale_context: %d of %d cases.**' % (len(stale), len(v11)))
    w('- **Unchanged context: %d cases** (`%s`). Their labels may still have changed (C2 relabels three of them), and their records are valid for the new label.' % (len(fresh), '`, `'.join(fresh)))
    w('- Stale only because of C5 (`audio_sample` removed from `tools_available`, nothing else): %d cases. Per run, those on which the model never called `audio_sample` '
      'form the extra "C5-only, tool not called" column in section 4 (still indicative: the offered tool list differs).\n' % len(c5_only))

    w('## 3. Gates under dev-v1.1 labels, over all 73 cases (`stale_context` cases included)\n')
    for which, title in (('cp1', 'Checkpoint 1 runs (prompt v1)'), ('devc2', 'dev-c2 runs (prompt v2)')):
        w('### %s\n' % title)
        rows = []
        for gid in G:
            rows.append([gid] + [fmt(next(x for x in results[(lab, which)]['all']['gates'] if x['gate'] == gid)) + ' *(v1: %s)*' % fmt(next(x for x in results[(lab, which)]['v1']['gates'] if x['gate'] == gid)) for lab, _, _ in MODELS])
        rows.append(['Overall'] + ['%s *(v1: %s)*' % (results[(lab, which)]['all']['overall'].upper(), results[(lab, which)]['v1']['overall'].upper()) for lab, _, _ in MODELS])
        w(table(rows, ['Gate'] + [m[0] for m in MODELS]) + '\n')
        flips = []
        for lab, _, _ in MODELS:
            a, b = results[(lab, which)]['v1']['cases'], results[(lab, which)]['all']['cases']
            flips.append([lab, sum(a[i]['correct'] != b[i]['correct'] for i in a), sum((not a[i]['correct']) and b[i]['correct'] for i in a),
                          sum(a[i]['correct'] and not b[i]['correct'] for i in a), sum(a[i]['unsafe_write'] != b[i]['unsafe_write'] for i in a)])
        w(table(flips, ['Model', 'cases whose OK flag changed v1 to v1.1', 'wrong to right', 'right to wrong', 'cases whose unsafe-write flag changed']) + '\n')
        g1c = [[lab, results[(lab, which)]['all']['g1_context']['unsafe_writes']['count'], results[(lab, which)]['all']['g1_context']['rejected_write_attempts']['count'],
                results[(lab, which)]['all']['g1_context']['forced']['count']] for lab, _, _ in MODELS]
        w('G1 context (report only, scorer v1.1):\n\n' + table(g1c, ['Model', 'G1 unsafe writes', 'rejected write attempts', 'forced escalates']) + '\n')

    w('## 4. Gates over unchanged-context cases only (%d cases: `%s`)\n' % (len(fresh), '`, `'.join(fresh)))
    w('Three cases are a thin base: a gate that has nothing to measure on them is `n/a`, and a percentage is a handful of decisions. The second table adds the cases that are stale '
      'only through C5 where the run never called `audio_sample` (%s cases per run at most). This second set is an additional, looser reading and is labelled as such.\n' % len(c5_only))
    for which, title in (('cp1', 'Checkpoint 1 runs'), ('devc2', 'dev-c2 runs')):
        for key, sub in (('fresh', 'unchanged context only'), ('c5only', 'unchanged context plus C5-only cases where `audio_sample` was not called')):
            w('### %s, %s\n' % (title, sub))
            rows = []
            for gid in G:
                rows.append([gid] + [fmt(next(x for x in results[(lab, which)][key]['gates'] if x['gate'] == gid)) for lab, _, _ in MODELS])
            rows.append(['cases scored'] + [results[(lab, which)][key]['cases_recorded'] for lab, _, _ in MODELS])
            w(table(rows, ['Gate'] + [m[0] for m in MODELS]) + '\n')

    w('## 5. Per-rule change table (dev-v1 to dev-v1.1)\n')
    rows = attr_rows(v1, v11)
    bulk = {}
    single = []
    for cid, rule, attr, x, y in rows:
        if rule in ('C1', 'C5') or (rule == 'C6-fn' and attr == 'arr_lookup path'):
            bulk.setdefault((rule, attr, json.dumps(x, ensure_ascii=False), json.dumps(y, ensure_ascii=False)), []).append(cid)
        else:
            single.append((cid, rule, attr, x, y))
    key = lambda r: (r[1][:2], len(r[1]), r[1], r[0])
    w('Rows for the bulk rules (C1, C5, and the C6-fn path echo) are grouped by identical before and after; every other row is one case.\n')
    out_rows = []
    for (rule, attr, x, y), ids in sorted(bulk.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        out_rows.append([', '.join('`%s`' % i for i in ids) + ' (%d)' % len(ids), rule, attr, '`%s`' % x, '`%s`' % y])
    for cid, rule, attr, x, y in sorted(single, key=key):
        out_rows.append(['`%s`' % cid, rule, attr, '`%s`' % json.dumps(x, ensure_ascii=False), '`%s`' % json.dumps(y, ensure_ascii=False)])
    w(table(out_rows, ['Case id', 'Rule', 'Attribute', 'Before', 'After']) + '\n')
    w('Also changed in every `epub` and `audiobook` case by C1: `context.arr.ids` (synthetic `bookId`, `format`) and the `arr_lookup` evidence (`args.app`, and the `app` field of the record text: '
      '`readarr-like` or `audiobook-metadata` became `lazylibrarian`). `context.arr` of `movie-identity-001` and `tv-identity-001` gained synthetic ids. '
      'Every case file differs from dev-v1 in `suite_version` and in a `corrections` list.\n')

    w('## 6. Rulings recorded as not applied or not needing a suite change\n')
    w('- **C6-1** `tv-insuff-002`: label sound, no change by ruling (the primary regression for "unverified segments never mean healthy").')
    w('- **C6-9** `tv-identity-002`: not applied. The ruling asks for replay of the pinned row\'s OCR. The only recorded on-screen reading of that row is `e3` (62 s, "Happy Hot Diggity Dog Holiday!"), '
      'and the dev-c2 tool layer already serves it through `ocr {t: 62}` and `frame_sample {at: 62}` then `ocr {frame}` (records of opus, gpt-6-luna and qwen3.8 in `evaluation/dev-c2/runs/`). '
      'No other OCR observation of that file exists in the repository, so there is no further data to add; the follow-ups that returned `unavailable` asked for times nothing was recorded at. '
      'Writing a reading for an unobserved time would invent evidence.')
    w('- **C6-10** `audiobook-naming-001`: no suite change by ruling (the harness prompt v2 taxonomy fixes it).')
    w('- **C6-g1 / C6-rr** (cross-cutting): the G1 accepted-class rule is in the scorer. Review of the four naming cases (`tv-naming-001`, `movie-naming-001`, `epub-naming-001`, `audiobook-naming-001`): '
      'in each the file is already in its right slot or entry and only a name or a tag is wrong, so `rename` is the only write that fixes it and `remap` stays unsupported; no supported set changed.')
    w('- **C6-g8** (cross-cutting): the G8 rule (fail only on citing a failed tool\'s evidence id as support, or a non-abstain class only that tool could show) is not changed in the scorer. '
      'The existing `refs_to_failed_tools` test already passes a decision that merely mentions a failure; the second clause needs a per-case note of which diagnosis only the failed tool could show, and no such data exists. '
      'The injected-`partial` gap is recorded in `harness/CONTRACT-v1.1.md`, not changed.')
    w('- **C6-fn** (filename bias): applied to %d defective cases (listed above). `tv-identity-003`, `tv-identity-004` (the name carries the content\'s episode title), `epub-identity-005` (already author-title style) and all naming, order and insufficient-evidence cases keep their name, '
      'because there the name is evidence or is the defect.' % sum(1 for r in rows if r[1] == 'C6-fn' and r[2] == 'filename'))
    (HERE / 'REPORT.md').write_text('\n'.join(out) + '\n')
    print('REPORT.md written; stale %d, fresh %d, c5-only %d' % (len(stale), len(fresh), len(c5_only)))


if __name__ == '__main__':
    main()
