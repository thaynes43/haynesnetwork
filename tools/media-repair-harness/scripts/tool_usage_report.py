#!/usr/bin/env python3
"""Offline per-tool usage report (OpenProject #207): which harness tools the models call, which they ignore, which are never offered, and how the
outcomes line up.  CORRELATION ONLY.

Reads recorded run directories (one JSON per case, plus score.json and manifest.json) and the public dev suites they ran on.  No model, no GPU, no
network, no subprocess, no media: it only reads JSON and writes a Markdown and a JSON report.  The output is deterministic (sorted, no timestamps, no
absolute paths other than what the caller passed).

    python3 tools/media-repair-harness/scripts/tool_usage_report.py \\
        --runs-root tools/media-repair-harness/runs/dev-c4 [--runs-root ...] \\
        --suite-dir .agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1 --suite-dir .agents/context/media-repair-harness-2026-10-19/suite \\
        --out-md tools/media-repair-harness/docs/tool-usage-report.md --out-json tools/media-repair-harness/docs/tool-usage-report.json

Definitions (every count is a count of per-case record files in the named run directory):
  offered       the tool is in the suite case's `tools_available` (the run's own capability list is checked against it).
  pre-supplied  the suite case carries evidence of that tool's type and the record's `evidence_shown` lists it: the model saw that output before
                any call.  `prior_record` is pre-supplied only (it is not a callable tool).
  called        the model requested the tool and it was offered.  A request for a tool that was NOT offered is counted apart
                (`called_not_offered`; the harness answers `unavailable`).  A `page` continuation counts under the tool it continues
                (`page_continuations`), never as a new call.
  cited         the decision's `evidence_refs` names the pre-supplied evidence (eN) or the call (tN); a `.fN` / `.cN` suffix is dropped.
  correct       the evaluator's `correct` in score.json (class accepted AND action supported; harness/score.py `case_facts`), read, not recomputed.

A run directory is a PRIMARY run when its name does not end in `-restored`.  `<name>-restored` is the same model replies with the decision
guards undone (`mrh-guard --restore`); it is paired to its primary and used only where labelled.  A run whose manifest carries `aborted`, or with
fewer records than planned, is PARTIAL and is kept out of pooled numbers.

Stdlib only, Python >= 3.11."""
import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

CASE_LISTS = ('called_cases', 'pre_supplied_cases', 'cited_cases', 'offered_cases')
TOOL_ORDER = ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'audiobook_inspect', 'arr_lookup',
              'subtitle_sample')   # protocol.TOOLS (8), then the opt-in #161 tool (tests pin both lists against the package)
PRE_ONLY = ('prior_record',)       # evidence types a case can carry that are not callable tools
CLASS_ORDER = ('identity_mismatch', 'corrupt_file', 'decoder_incompatible', 'metadata_naming', 'order_edition_ambiguity', 'insufficient_evidence',
               'healthy')
STATUSES = ('ok', 'partial', 'error', 'timeout', 'unavailable')
NON_RECORD = ('manifest.json', 'score.json', 'run_summary.json')
MIN_PY = (3, 11)


# ----------------------------------------------------------------------------------------------- loading

def _jload(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        h.update(fh.read())
    return h.hexdigest()


def load_suite(suite_dir):
    """{version, dir, cases: {id: case}, sha256: {id: sha256 of the case file}} for one suite directory."""
    root = Path(suite_dir)
    cases, shas = {}, {}
    for f in sorted((root / 'cases').glob('*.json')):
        c = _jload(f)
        cases[c['id']] = c
        shas[c['id']] = _sha256(f)
    version = None
    mf = root / 'manifest.json'
    if mf.is_file():
        version = _jload(mf).get('suite_version')
    if version is None and cases:
        version = next(iter(cases.values())).get('suite_version')
    return {'version': version, 'dir': str(suite_dir), 'cases': cases, 'sha256': shas}


def _argv_opt(argv, key):
    if isinstance(argv, list) and key in argv:
        i = argv.index(key)
        if i + 1 < len(argv):
            return argv[i + 1]
    return None


def find_run_dirs(roots):
    """Run directories under the roots: a root that holds score.json is itself a run; otherwise each child that holds one.  Sorted by path."""
    found = []
    for root in roots:
        r = Path(root)
        if (r / 'score.json').is_file():
            found.append(r)
        elif r.is_dir():
            found.extend(sorted(p for p in r.iterdir() if p.is_dir() and (p / 'score.json').is_file()))
    return sorted(set(found), key=lambda p: str(p))


def load_run(run_dir):
    """One run directory: score.json, optional manifest.json, and every per-case record."""
    d = Path(run_dir)
    score = _jload(d / 'score.json')
    manifest = _jload(d / 'manifest.json') if (d / 'manifest.json').is_file() else {}
    records = {}
    for f in sorted(d.glob('*.json')):
        if f.name in NON_RECORD:
            continue
        r = _jload(f)
        if isinstance(r, dict) and r.get('case_id'):
            records[r['case_id']] = r
    return {'dir': d, 'name': d.name, 'group': d.parent.name, 'score': score, 'manifest': manifest, 'records': records}


def run_meta(run):
    score, manifest, records = run['score'], run['manifest'], run['records']
    argv = manifest.get('argv')
    first = next(iter(sorted(records.items())), (None, {}))[1]
    adapter = score.get('adapter') or manifest.get('adapter') or _argv_opt(argv, '--adapter')
    planned = score.get('cases_planned') or manifest.get('cases_planned') or len(manifest.get('case_ids') or []) or None
    aborted = manifest.get('aborted') or score.get('aborted') or None
    partial = bool(aborted) or (planned is not None and len(records) < planned)
    prompt = _argv_opt(argv, '--prompt') or (first.get('prompt') or {}).get('version')
    return {
        'model': score.get('requested_model') or first.get('requested_model'),
        'adapter': adapter,
        'role': 'local' if adapter == 'ollama' else 'frontier',
        'harness_version': first.get('harness_version'),
        'prompt': prompt,
        'evidence_format': _argv_opt(argv, '--evidence-format') or 'default',
        'guards': _argv_opt(argv, '--guards') or ((first.get('guard') or {}).get('version')) or 'off',
        'suite_version': first.get('suite_version'),
        'cases_planned': planned,
        'cases_recorded': len(records),
        'partial': partial,
        'aborted': aborted,
    }


# ----------------------------------------------------------------------------------------------- per-case facts

def _base_ref(ref):
    return str(ref).split('.', 1)[0]


def case_facts(case, rec, sc):
    """Everything the report needs about one scored case: per tool offered / pre-supplied / calls / statuses / citations, plus the outcome."""
    offered = set(case.get('tools_available') or [])
    shown = set(rec.get('evidence_shown') or [])
    pre = {}                                    # evidence id -> (tool, status)
    for e in case.get('evidence') or []:
        if e.get('id') in shown:
            pre[e['id']] = (e.get('tool'), e.get('status'))
    calls = {}                                  # call id -> (tool, status, offered?)
    per = {}

    def slot(tool):
        return per.setdefault(tool, {
            'offered': tool in offered, 'pre_supplied': 0, 'calls': 0, 'statuses': Counter(), 'page_continuations': 0, 'called_not_offered': 0,
            'cited_pre': False, 'cited_called': False, 'cited_non_ok': False})

    for t in offered:
        slot(t)
    for eid, (tool, _st) in pre.items():
        slot(tool)['pre_supplied'] += 1
    for c in rec.get('tool_calls') or []:
        tool = c.get('tool')
        if tool == 'page':
            via = c.get('continuation_via')
            if via:
                slot(via)['page_continuations'] += 1
                calls[c.get('id')] = (via, c.get('status'), via in offered)
            continue
        s = slot(tool)
        if tool not in offered:
            s['called_not_offered'] += 1
            calls[c.get('id')] = (tool, c.get('status'), False)
            continue
        s['calls'] += 1
        s['statuses'][c.get('status') or 'unknown'] += 1
        calls[c.get('id')] = (tool, c.get('status'), True)
    unresolved = []
    cited_not_offered = 0
    decision = rec.get('decision') or {}
    for ref in decision.get('evidence_refs') or []:
        b = _base_ref(ref)
        if b in pre:
            tool, st = pre[b]
            slot(tool)['cited_pre'] = True
            if st != 'ok':
                slot(tool)['cited_non_ok'] = True
        elif b in calls:
            tool, st, was_offered = calls[b]
            if not was_offered:
                cited_not_offered += 1
                continue
            slot(tool)['cited_called'] = True
            if st != 'ok':
                slot(tool)['cited_non_ok'] = True
        else:
            unresolved.append(str(ref))
    n_calls = sum(s['calls'] for s in per.values())
    return {
        'case_id': case['id'], 'media_type': case.get('media_type'), 'truth': sc.get('truth') or (case.get('truth') or {}).get('class'),
        'correct': bool(sc.get('correct')), 'decision_class': sc.get('class'), 'decision_action': sc.get('action'),
        'forced': bool(rec.get('forced')), 'protocol_violations': len(rec.get('protocol_violations') or []),
        'refs_to_failed_tools': len(rec.get('refs_to_failed_tools') or []), 'unresolved_refs': unresolved, 'cited_not_offered_refs': cited_not_offered,
        'n_calls': n_calls, 'tools': per,
    }


# ----------------------------------------------------------------------------------------------- aggregation

def _empty_tool():
    return {'cases_offered': 0, 'cases_pre_supplied': 0, 'cases_called': 0, 'cases_called_with_pre': 0, 'calls': 0, 'page_continuations': 0, 'called_not_offered_calls': 0,
            'statuses': Counter(), 'cases_cited_pre': 0, 'cases_cited_called': 0, 'cases_cited_any': 0, 'cases_cited_non_ok': 0,
            'offered_called': {'n': 0, 'correct': 0}, 'offered_not_called': {'n': 0, 'correct': 0},
            'available': {'n': 0, 'correct': 0}, 'cited': {'n': 0, 'correct': 0}, 'available_not_cited': {'n': 0, 'correct': 0},
            'called_cases': [], 'pre_supplied_cases': [], 'cited_cases': []}


def _bump(d, ok):
    d['n'] += 1
    d['correct'] += int(ok)


def aggregate(facts, with_case_lists=True):
    """Per tool counts over a list of case facts (one run, or a group)."""
    tools = {}
    for f in facts:
        for tool, s in f['tools'].items():
            t = tools.setdefault(tool, _empty_tool())
            ok = f['correct']
            called = s['calls'] > 0
            cited = s['cited_pre'] or s['cited_called']
            if s['offered']:
                t['cases_offered'] += 1
                (_bump(t['offered_called'], ok) if called else _bump(t['offered_not_called'], ok))
            if s['pre_supplied']:
                t['cases_pre_supplied'] += 1
                if with_case_lists:
                    t['pre_supplied_cases'].append(f['case_id'])
            if called:
                t['cases_called'] += 1
                if s['pre_supplied']:
                    t['cases_called_with_pre'] += 1
                if with_case_lists:
                    t['called_cases'].append(f['case_id'])
            t['calls'] += s['calls']
            t['page_continuations'] += s['page_continuations']
            t['called_not_offered_calls'] += s['called_not_offered']
            t['statuses'].update(s['statuses'])
            if s['cited_pre']:
                t['cases_cited_pre'] += 1
            if s['cited_called']:
                t['cases_cited_called'] += 1
            if cited:
                t['cases_cited_any'] += 1
                if with_case_lists:
                    t['cited_cases'].append(f['case_id'])
            if s['cited_non_ok']:
                t['cases_cited_non_ok'] += 1
            if s['offered'] or s['pre_supplied']:
                _bump(t['available'], ok)
                (_bump(t['cited'], ok) if cited else _bump(t['available_not_cited'], ok))
    for t in tools.values():
        t['statuses'] = {k: t['statuses'][k] for k in sorted(t['statuses'], key=lambda k: (STATUSES.index(k) if k in STATUSES else 99, k))}
    return {k: tools[k] for k in _ordered_tools(tools)}


def _ordered_tools(names):
    known = [t for t in TOOL_ORDER + PRE_ONLY if t in names]
    return known + sorted(n for n in names if n not in known)


def overall(facts):
    n = len(facts)
    zero = [f for f in facts if f['n_calls'] == 0]
    some = [f for f in facts if f['n_calls'] > 0]
    return {
        'n': n, 'correct': sum(f['correct'] for f in facts),
        'forced': sum(f['forced'] for f in facts), 'protocol_violations': sum(f['protocol_violations'] for f in facts),
        'refs_to_failed_tools': sum(f['refs_to_failed_tools'] for f in facts), 'unresolved_refs': sum(len(f['unresolved_refs']) for f in facts),
        'cases_zero_calls': {'n': len(zero), 'correct': sum(f['correct'] for f in zero)},
        'cases_some_calls': {'n': len(some), 'correct': sum(f['correct'] for f in some)},
        'total_calls': sum(f['n_calls'] for f in facts),
    }


def by_class(facts, media=None):
    out = {}
    classes = sorted({f['truth'] for f in facts if f['truth']}, key=lambda c: (CLASS_ORDER.index(c) if c in CLASS_ORDER else 99, c))
    for c in classes:
        sel = [f for f in facts if f['truth'] == c and (media is None or f['media_type'] == media)]
        if sel:
            out[c] = {'n': len(sel), 'correct': sum(f['correct'] for f in sel), 'overall': overall(sel), 'tools': aggregate(sel, with_case_lists=False)}
    return out


def _integrity(run, suite, cases_used):
    """Checks that the suite is the one the run ran on; recorded, never silently ignored."""
    sha_mismatch = [cid for cid in cases_used if run['records'][cid].get('case_sha256') != suite['sha256'].get(cid)]
    caps_mismatch = []
    for cid in cases_used:
        caps = (run['records'][cid].get('evidence') or {}).get('capabilities')
        if caps is None:
            continue
        rec_off = sorted(x['tool'] for x in caps if x.get('offered'))
        if rec_off != sorted(suite['cases'][cid].get('tools_available') or []):
            caps_mismatch.append(cid)
    return {'case_sha256_mismatch': sha_mismatch, 'record_capabilities_differ_from_suite': caps_mismatch}


def analyse_run(run, suites_by_version):
    meta = run_meta(run)
    suite = suites_by_version.get(meta['suite_version'])
    if suite is None:
        return {'dir': str(run['dir']), 'name': run['name'], 'group': run['group'], 'meta': meta, 'unavailable': 'no suite with version %r was given' % meta['suite_version']}
    scored = run['score'].get('cases') or {}
    used = sorted(c for c in run['records'] if c in scored and c in suite['cases'] and run['records'][c].get('decision'))
    skipped = sorted(set(run['records']) - set(used))
    facts = [case_facts(suite['cases'][c], run['records'][c], scored[c]) for c in used]
    out = {
        'dir': str(run['dir']), 'name': run['name'], 'group': run['group'], 'meta': meta, 'records_skipped': skipped,
        'integrity': _integrity(run, suite, used), 'overall': overall(facts), 'tools': aggregate(facts),
        'by_class': by_class(facts),
        'cases': {f['case_id']: {k: v for k, v in f.items() if k != 'tools'} | {'tools': {t: _case_tool(s) for t, s in f['tools'].items() if _interesting(s)}} for f in facts},
    }
    return out


def _interesting(s):
    return s['offered'] or s['pre_supplied'] or s['calls'] or s['called_not_offered'] or s['page_continuations']


def _case_tool(s):
    d = {'offered': s['offered'], 'pre_supplied': s['pre_supplied'], 'calls': s['calls'], 'statuses': dict(sorted(s['statuses'].items())),
         'cited': 'pre' if s['cited_pre'] and not s['cited_called'] else 'called' if s['cited_called'] and not s['cited_pre'] else 'both' if s['cited_pre'] else None}
    if s['page_continuations']:
        d['page_continuations'] = s['page_continuations']
    if s['called_not_offered']:
        d['called_not_offered'] = s['called_not_offered']
    return d


def strip_lists(tools):
    return {k: {a: b for a, b in t.items() if a not in CASE_LISTS} for k, t in tools.items()}


def _calls_signature(rec):
    return [(c.get('tool'), c.get('status'), json.dumps(c.get('args'), sort_keys=True)) for c in rec.get('tool_calls') or []]


def pooled(runs, key='tools'):
    """Sum the per-run tool counters (case lists are dropped: run-cases are not distinct cases)."""
    acc = {}
    for r in runs:
        for tool, t in r[key].items():
            a = acc.setdefault(tool, _empty_tool())
            for k, v in t.items():
                if k in CASE_LISTS:
                    continue
                if k == 'statuses':
                    for s, n in v.items():
                        a['statuses'][s] = a['statuses'].get(s, 0) + n
                elif isinstance(v, dict):
                    a[k]['n'] += v['n']
                    a[k]['correct'] += v['correct']
                else:
                    a[k] += v
    for a in acc.values():
        for k in CASE_LISTS:
            a.pop(k, None)
        a['statuses'] = dict(sorted(a['statuses'].items(), key=lambda kv: (STATUSES.index(kv[0]) if kv[0] in STATUSES else 99, kv[0])))
    return {k: acc[k] for k in _ordered_tools(acc)}


def pooled_class(runs):
    """Per class, per tool, summed over runs."""
    classes = {}
    for r in runs:
        for c, v in r['by_class'].items():
            classes.setdefault(c, []).append({'tools': v['tools'], 'n': v['n'], 'correct': v['correct']})
    out = {}
    for c in sorted(classes, key=lambda c: (CLASS_ORDER.index(c) if c in CLASS_ORDER else 99, c)):
        out[c] = {'n': sum(x['n'] for x in classes[c]), 'correct': sum(x['correct'] for x in classes[c]), 'tools': pooled(classes[c])}
    return out


# ----------------------------------------------------------------------------------------------- suites: offers and never-offered

def offer_matrix(suite, record_runs):
    """Per tool: cases offering it in the suite, cases carrying pre-supplied evidence of its type, and how often a scanned run offered, was
    requested or saw it."""
    n = len(suite['cases'])
    rows = {}
    for t in TOOL_ORDER + PRE_ONLY:
        rows[t] = {'cases_offering': 0, 'cases_pre_supplied': 0}
    for c in suite['cases'].values():
        for t in c.get('tools_available') or []:
            rows.setdefault(t, {'cases_offering': 0, 'cases_pre_supplied': 0})['cases_offering'] += 1
        for t in {e.get('tool') for e in c.get('evidence') or []}:
            rows.setdefault(t, {'cases_offering': 0, 'cases_pre_supplied': 0})['cases_pre_supplied'] += 1
    return {'suite_version': suite['version'], 'dir': suite['dir'], 'cases': n, 'tools': {k: rows[k] for k in _ordered_tools(rows)}}


def scan_runs_for_tool(run_dirs, tool):
    """Scan every record file of the given run directories for the tool (offered in a capability list, requested, or pre-supplied)."""
    seen = {'run_dirs_scanned': 0, 'records_scanned': 0, 'offered_in_capabilities': 0, 'requested': 0, 'mentioned_in_tools_available': 0}
    for d in run_dirs:
        seen['run_dirs_scanned'] += 1
        for f in sorted(Path(d).glob('*.json')):
            if f.name in NON_RECORD:
                continue
            try:
                r = _jload(f)
            except ValueError:
                continue
            if not isinstance(r, dict) or not r.get('case_id'):
                continue
            seen['records_scanned'] += 1
            for x in (r.get('evidence') or {}).get('capabilities') or []:
                if x.get('tool') == tool and x.get('offered'):
                    seen['offered_in_capabilities'] += 1
            seen['requested'] += sum(1 for c in r.get('tool_calls') or [] if c.get('tool') == tool)
            if tool in (r.get('tools_available') or []):
                seen['mentioned_in_tools_available'] += 1
    return seen


# ----------------------------------------------------------------------------------------------- driver

def build_report(run_dirs, suite_dirs, include_restored_pairs=True):
    suites = [load_suite(s) for s in suite_dirs]
    by_version = {}
    for s in suites:
        if s['version'] in by_version:
            raise SystemExit('two suites share the version %r' % s['version'])
        by_version[s['version']] = s
    loaded = {str(d): load_run(d) for d in run_dirs}
    primary_dirs = [d for d in run_dirs if not d.name.endswith('-restored')]
    restored_dirs = {str(d): d for d in run_dirs if d.name.endswith('-restored')}
    runs, skipped_restored = [], []
    for d in primary_dirs:
        a = analyse_run(loaded[str(d)], by_version)
        sib = restored_dirs.get(str(d.parent / (d.name + '-restored')))
        if sib is not None and 'unavailable' not in a:
            ra = analyse_run(loaded[str(sib)], by_version)
        if sib is not None and 'unavailable' not in a and 'unavailable' in ra:
            a['restored_unavailable'] = ra['unavailable']
        elif sib is not None and 'unavailable' not in a:
            differ = sorted(c for c in loaded[str(d)]['records'] if c in loaded[str(sib)]['records']
                          and _calls_signature(loaded[str(d)]['records'][c]) != _calls_signature(loaded[str(sib)]['records'][c]))
            a['restored'] = {'dir': str(sib), 'overall': ra['overall'], 'tools': strip_lists(ra['tools']), 'by_class': {c: {'n': v['n'], 'correct': v['correct']} for c, v in ra['by_class'].items()},
                             'tool_calls_differ_from_primary_in_cases': differ}
        runs.append(a)
    for k, d in sorted(restored_dirs.items()):
        if not any(r['dir'] == str(d.parent / d.name[:-len('-restored')]) for r in runs):
            skipped_restored.append(k)
    ok_runs = [r for r in runs if 'unavailable' not in r]
    never = {}
    all_dirs = [str(d) for d in run_dirs]
    for tool in TOOL_ORDER:
        per_suite = {}
        removed = {}
        for s in suites:
            per_suite[s['version']] = sum(1 for c in s['cases'].values() if tool in (c.get('tools_available') or []))
            removed[s['version']] = sum(1 for c in s['cases'].values() if any(tool in str(n) and 'removed' in str(n) for n in c.get('corrections') or []))
        never[tool] = {'cases_offering_by_suite': per_suite, 'removed_by_correction_by_suite': removed, 'scanned_runs': scan_runs_for_tool(all_dirs, tool)}
    return {
        'report': 'tool-usage-report-1',
        'suites': [offer_matrix(s, ok_runs) for s in suites],
        'runs': runs,
        'restored_dirs_without_primary': skipped_restored,
        'never_offered': never,
        'pooled': pool_groups(ok_runs),
    }


def pool_groups(runs):
    """Pooled by model over FULL (not partial) primary runs, split by role."""
    groups = {}
    for r in runs:
        if r['meta']['partial']:
            continue
        groups.setdefault((r['meta']['role'], r['meta']['model']), []).append(r)
    out = []
    for (role, model), rs in sorted(groups.items(), key=lambda kv: (kv[0][0] != 'local', str(kv[0][1]))):
        out.append({'role': role, 'model': model, 'runs': [r['group'] + '/' + r['name'] for r in rs], 'overall': overall_sum([r['overall'] for r in rs]),
                    'tools': pooled(rs), 'by_class': pooled_class(rs)})
    return out


def overall_sum(items):
    out = {}
    for it in items:
        for k, v in it.items():
            if isinstance(v, dict):
                d = out.setdefault(k, {'n': 0, 'correct': 0})
                d['n'] += v['n']
                d['correct'] += v['correct']
            else:
                out[k] = out.get(k, 0) + v
    return out




def paired_same_case(runs):
    """For each full primary run of one model: per tool, the cases where that model's runs DISAGREE on calling the offered tool; the correctness of the
    runs that called vs the runs that did not.  Same case, same model, different round (prompt, format, guards differ), so it holds case difficulty
    fixed and nothing else."""
    out = []
    by_model = {}
    for r in runs:
        if not r['meta']['partial']:
            by_model.setdefault((r['meta']['role'], r['meta']['model']), []).append(r)
    for (role, model), rs in sorted(by_model.items(), key=lambda kv: (kv[0][0] != 'local', str(kv[0][1]))):
        if len(rs) < 2:
            continue
        tools = {}
        for cid in sorted({c for r in rs for c in r['cases']}):
            per = [(r['cases'][cid], r) for r in rs if cid in r['cases']]
            names = sorted({t for cs, _r in per for t, x in cs['tools'].items() if x['offered']})
            for t in names:
                called = [cs['correct'] for cs, _r in per if cs['tools'].get(t, {}).get('offered') and cs['tools'][t]['calls'] > 0]
                notc = [cs['correct'] for cs, _r in per if cs['tools'].get(t, {}).get('offered') and cs['tools'][t]['calls'] == 0]
                if called and notc:
                    a = tools.setdefault(t, {'cases': 0, 'called_runs': {'n': 0, 'correct': 0}, 'not_called_runs': {'n': 0, 'correct': 0}, 'case_ids': []})
                    a['cases'] += 1
                    a['case_ids'].append(cid)
                    a['called_runs']['n'] += len(called)
                    a['called_runs']['correct'] += sum(called)
                    a['not_called_runs']['n'] += len(notc)
                    a['not_called_runs']['correct'] += sum(notc)
        out.append({'role': role, 'model': model, 'runs': [r['group'] + '/' + r['name'] for r in rs], 'tools': {k: tools[k] for k in _ordered_tools(tools)}})
    return out


def tv_identity_view(runs):
    """TV identity_mismatch cases (the Pokemon-series goal): per local/frontier full run, accuracy as-run and guards undone, and the per-case matrix."""
    out = []
    for r in runs:
        if r['meta']['partial']:
            continue
        rows = []
        for cid, c in r['cases'].items():
            if c['truth'] == 'identity_mismatch' and c['media_type'] == 'tv':
                rows.append({'case_id': cid, 'correct': c['correct'], 'decision_class': c['decision_class'], 'decision_action': c['decision_action'],
                             'tools': c['tools']})
        ia = r['by_class'].get('identity_mismatch')
        rest = (r.get('restored') or {}).get('by_class', {}).get('identity_mismatch')
        misses = [c for c in r['cases'].values() if c['truth'] == 'identity_mismatch' and not c['correct']]
        out.append({'run': r['group'] + '/' + r['name'], 'role': r['meta']['role'], 'model': r['meta']['model'],
                    'identity_all_media': {'n': ia['n'], 'correct': ia['correct']} if ia else None,
                    'identity_misses': {'n': len(misses), 'named_identity_mismatch_but_other_action': sum(1 for c in misses if c['decision_class'] == 'identity_mismatch'),
                                        'named_identity_mismatch_and_escalated': sum(1 for c in misses if c['decision_class'] == 'identity_mismatch' and c['decision_action'] == 'escalate'),
                                        'case_ids': sorted(c['case_id'] for c in misses)},
                    'identity_all_media_guards_undone': rest, 'tv_cases': rows})
    return out


# ----------------------------------------------------------------------------------------------- rendering

def pct(c, n):
    return 'n/a' if not n else '%d%%' % round(100.0 * c / n)


def frac(d):
    return '%d/%d' % (d['correct'], d['n']) if d and d['n'] else '-'


def frac_p(d):
    return '%s (%s)' % (frac(d), pct(d['correct'], d['n'])) if d and d['n'] else '-'


def statuses_text(st):
    return ', '.join('%s %d' % (k, v) for k, v in st.items()) if st else '-'


def table(head, rows):
    out = ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] * len(head)) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(str(x).replace('|', '/') for x in r) + ' |')
    return out


def _shown(t):
    return t['cases_offered'] or t['cases_pre_supplied'] or t['calls'] or t['called_not_offered_calls'] or t['page_continuations']


TOOL_HEAD = ['tool', 'offered (cases)', 'pre-supplied evidence (cases)', 'called (cases / calls)', 'call results', 'cited: pre-supplied / called (cases)',
             'correct: offered and called', 'correct: offered, not called', 'correct: evidence cited vs not cited']


def tool_rows(tools):
    rows = []
    for tool, t in tools.items():
        if not _shown(t):
            continue
        extra = ''
        if t['called_not_offered_calls']:
            extra += ' (+%d requested while not offered)' % t['called_not_offered_calls']
        if t['page_continuations']:
            extra += ' (+%d page continuations)' % t['page_continuations']
        rows.append([tool, t['cases_offered'], t['cases_pre_supplied'], '%d / %d%s%s' % (t['cases_called'], t['calls'], (' (%d of those cases already had its output)' % t['cases_called_with_pre']) if t['cases_called_with_pre'] else '', extra), statuses_text(t['statuses']),
                     '%d / %d' % (t['cases_cited_pre'], t['cases_cited_called']), frac_p(t['offered_called']), frac_p(t['offered_not_called']),
                     '%s vs %s' % (frac_p(t['cited']), frac_p(t['available_not_cited']))])
    return rows


def run_label(r):
    return '%s/%s' % (r['group'], r['name'])


def _flagged_correlations(tools, min_n=10, min_gap=10.0):
    """Tools whose offered-and-called vs offered-not-called correctness differ by >= min_gap points with both sides >= min_n cases."""
    out = []
    for tool, t in tools.items():
        a, b = t['offered_called'], t['offered_not_called']
        if a['n'] >= min_n and b['n'] >= min_n:
            gap = 100.0 * a['correct'] / a['n'] - 100.0 * b['correct'] / b['n']
            if abs(gap) >= min_gap:
                out.append((tool, gap, a, b))
    return sorted(out, key=lambda x: x[1])


def _sign(x):
    return 1 if x > 0 else -1


def summary_lines(report):
    """The plain-English summary, built only from the computed numbers.  At most 12 lines; fixed sentence frames, data-driven lists."""
    loc = [g for g in report['pooled'] if g['role'] == 'local']
    fr = [g for g in report['pooled'] if g['role'] == 'frontier']
    if not loc:
        return ['No full local-model run was found in the given run roots; nothing to summarise.']
    agg = {}
    for g in loc:
        for tool, t in g['tools'].items():
            a = agg.setdefault(tool, {'offered': 0, 'called': 0, 'calls': 0, 'pre': 0, 'called_pre': 0, 'ok': 0, 'all': 0})
            a['offered'] += t['cases_offered']
            a['called'] += t['cases_called']
            a['calls'] += t['calls']
            a['pre'] += t['cases_pre_supplied']
            a['called_pre'] += t['cases_called_with_pre']
            a['ok'] += t['statuses'].get('ok', 0)
            a['all'] += sum(t['statuses'].values())
    L = []
    nruns = sum(len(g['runs']) for g in loc)
    ncase = sum(g['overall']['n'] for g in loc)
    versions = sorted({r['meta']['suite_version'] for r in report['runs'] if 'unavailable' not in r and r['meta']['role'] == 'local' and not r['meta']['partial']})
    partial = sorted(run_label(r) for r in report['runs'] if 'unavailable' not in r and r['meta']['partial'])
    L.append('Scope: %d full local-model runs (%s), %d cases scored in all, suite %s; %s. Correlation only.' % (
        nruns, ', '.join('%s x%d' % (g['model'], len(g['runs'])) for g in loc), ncase, ', '.join(map(str, versions)),
        ('partial runs left out of every pooled number: ' + ', '.join(partial)) if partial else 'no partial run'))
    offered = {k: a for k, a in agg.items() if a['offered']}
    used = sorted((k for k, a in offered.items() if a['calls']), key=lambda k: (-offered[k]['called'], k))
    for g in loc:
        gt = {k: t for k, t in g['tools'].items() if t['cases_offered']}
        gu = sorted((k for k, t in gt.items()), key=lambda k: (-gt[k]['cases_called'], k))
        L.append('%s (runs: %d) calls, as cases called of cases offering the tool, with total calls and the share of results with status ok: %s.%s' % (
            g['model'], len(g['runs']), '; '.join('%s %d of %d, %d calls, %s' % (
                k, gt[k]['cases_called'], gt[k]['cases_offered'], gt[k]['calls'], pct(gt[k]['statuses'].get('ok', 0), sum(gt[k]['statuses'].values())) if gt[k]['calls'] else 'no calls')
                for k in gu), ' An error status is often a real finding (a damaged file), not a tool fault.' if g is loc[0] else ''))
    call_only = sorted(k for k, a in offered.items() if a['pre'] == 0)
    mostly_pre = sorted(k for k, a in offered.items() if a['pre'] >= 0.9 * a['offered'])
    if call_only:
        L.append('Only reachable by asking (the case supplies no output of that type): ' + '; '.join(
            '%s called in %d of %d offering cases' % (k, offered[k]['called'], offered[k]['offered']) for k in call_only) + '.')
    if mostly_pre:
        L.append('Output already supplied up front in at least 90%% of the offering cases, so zero calls is not zero use: %s.' % '; '.join(
            '%s (supplied in %d of %d; still called in %d cases, %d of them with the output already shown)' % (
                k, offered[k]['pre'], offered[k]['offered'], offered[k]['called'], offered[k]['called_pre']) for k in mostly_pre))
    never = []
    for tool, v in report['never_offered'].items():
        sc = v['scanned_runs']
        if sc['offered_in_capabilities'] == 0:
            by = ', '.join('%d cases in %s' % (n, ver) for ver, n in sorted(v['cases_offering_by_suite'].items()))
            never.append('%s (offered in none of the %d records scanned, as-run and restored; suites offer it in: %s%s)' % (
                tool, sc['records_scanned'], by, ('; %d requests for it were answered unavailable' % sc['requested']) if sc['requested'] else ''))
    if never:
        L.append('Never offered in any scanned run: ' + '; '.join(never) + '.')
    flagged, signs = [], {}
    for g in loc:
        for tool, gap, a, b in _flagged_correlations(g['tools']):
            flagged.append('%s %s: correct %s when called vs %s when offered and not called' % (g['model'], tool, frac_p(a), frac_p(b)))
            signs.setdefault(tool, set()).add(_sign(gap))
    opp = sorted(t for t, sg in signs.items() if len(sg) > 1)
    L.append('Outcomes that go with use (correlation; a model may call because a case looks hard; flagged at a gap of 10 points or more with 10 or more cases each side): ' + (
        '; '.join(flagged) if flagged else 'none reached that bar') + ('. The two models point opposite ways for %s' % ', '.join(opp) if opp else '') + '.')
    for g in loc:
        tvs = [t for t in report['tv_identity'] if t['model'] == g['model'] and t['role'] == 'local']
        if tvs:
            ia = '; '.join('%s %s%s' % (t['run'].split('/')[0], frac(t['identity_all_media']),
                                        (' (%s with guards undone)' % frac(t['identity_all_media_guards_undone'])) if t['identity_all_media_guards_undone'] else '') for t in tvs)
            calls, pres, ncase = Counter(), Counter(), 0
            for t in tvs:
                for c in t['tv_cases']:
                    ncase += 1
                    for tool, x in c['tools'].items():
                        calls[tool] += x['calls']
                        pres[tool] += bool(x['pre_supplied'])
            miss = sum(t['identity_misses']['n'] for t in tvs)
            right = sum(t['identity_misses']['named_identity_mismatch_but_other_action'] for t in tvs)
            esc = sum(t['identity_misses']['named_identity_mismatch_and_escalated'] for t in tvs)
            nid = sorted({t['identity_all_media']['n'] for t in tvs if t['identity_all_media']})
            L.append('Wrong-episode/wrong-content (identity_mismatch, %s cases per run), %s correct by round: %s; misses in all: %d, of which %d named identity_mismatch but chose an unsupported action (%d escalated). On the %d tv identity run-cases it made %s; output was supplied up front for %s.' % (
                '/'.join(map(str, nid)), g['model'], ia, miss, right, esc, ncase, ', '.join('%d %s' % (n, k) for k, n in sorted(calls.items()) if n) or 'no calls',
                ', '.join('%s in %d' % (k, n) for k, n in sorted(pres.items()) if n) or 'no tool'))
    mixed = [k for k in used if k not in mostly_pre and k not in call_only]
    L.append('For the tool-lift run: the clean on/off arms are the call-only tools (%s)%s. For %s switching calls off leaves the supplied output in place, so an arm that also hides it '
             'is a separate, larger experiment to decide on purpose. audio_sample and subtitle_sample need fixtures with replay data before any arm.' % (
                 ', '.join(call_only) or 'none', ('; %s is supplied in only part of its cases (%s), so its arm mixes both effects' % (', '.join(mixed), ', '.join(
                     '%d of %d' % (offered[k]['pre'], offered[k]['offered']) for k in mixed))) if mixed else '', ', '.join(mostly_pre) or 'none'))
    if fr:
        parts = []
        for g in fr:
            fl = _flagged_correlations(g['tools'])
            parts.append('%s %d calls over %d full runs%s' % (g['model'], sum(t['calls'] for t in g['tools'].values()), len(g['runs']), (
                ' (flagged: ' + ', '.join('%s correct %s when called vs %s when not' % (tool, frac_p(a), frac_p(b)) for tool, _gap, a, b in fl) + '; mixes rounds, see caveats)') if fl else ''))
        L.append('Frontier models for comparison: ' + '; '.join(parts) + ' (section 4).')
    assert len(L) <= 12
    return L


CAVEATS = [
    'One pass per model and round: a single sample, so a difference of a few cases is noise.',
    'The dev suite is dev-tuned: its fixtures and the harness were shaped against these cases. This says nothing about held-out or production media.',
    'Replay evidence: tool output was recorded earlier and played back. A model that calls a tool gets the recorded result, not a live one.',
    'Prompt, evidence format, guards and tool behaviour changed between rounds (columns in section 1), so runs are not repeats of one setup.',
    'Which tools a case offers depends on its media type, and models call more when a case looks hard, so called-vs-not-called correctness is confounded by difficulty and class.',
    'The decision guards (G-healthy, G-write) can overturn a decision depending on which checks ran. The primary runs are as-run (guards on). Guards-undone figures come from the paired `-restored` runs and are labelled as such.',
    'No causal claim, no readiness claim, no claim about held-out performance.',
]


def render_md(report, command, summary):
    L = ['# Per-tool usage report (OpenProject #207)', '', 'Reproduce (from the repository root; stdlib only, no model, no network):', '', '```', command, '```', '',
         '## Summary', '']
    for s in summary:
        L.append('- ' + s)
    L += ['', '## Caveats (read before any number below)', '']
    for c in CAVEATS:
        L.append('- ' + c)
    runs = [r for r in report['runs'] if 'unavailable' not in r]
    L += ['', '## 1. Runs covered', '', 'Counts below are counts of per-case record files in the named directory (`tools/media-repair-harness/runs/...`). `restored` is the paired `<run>-restored` directory, if one exists.', '']
    rows = []
    for r in runs:
        m, o = r['meta'], r['overall']
        rs = r.get('restored')
        rows.append([run_label(r), m['role'], m['model'], m['harness_version'], 'prompt %s, format %s, guards %s' % (m['prompt'], m['evidence_format'], m['guards']),
                     ('PARTIAL %d of %s (%s)' % (m['cases_recorded'], m['cases_planned'], m['aborted'])) if m['partial'] else str(o['n']), '%d/%d' % (o['correct'], o['n']),
                     ('%d/%d' % (rs['overall']['correct'], rs['overall']['n'])) if rs else ('restored run unavailable: %s' % r['restored_unavailable']) if r.get('restored_unavailable') else 'no restored run', o['forced'], o['protocol_violations'],
                     '%d / %d' % (o['cases_zero_calls']['n'], o['cases_some_calls']['n'])])
    L += table(['run', 'role', 'model', 'harness', 'configuration', 'cases', 'correct (as run)', 'correct (guards undone)', 'forced', 'protocol violations', 'cases with zero / some calls'], rows)
    bad = [run_label(r) for r in report['runs'] if 'unavailable' in r]
    if bad:
        L += ['', 'Runs with no matching suite (unavailable): ' + ', '.join(bad)]
    integ = [run_label(r) for r in runs if r['integrity']['case_sha256_mismatch'] or r['integrity']['record_capabilities_differ_from_suite']]
    L += ['', 'Integrity: every record\'s `case_sha256` equals the sha256 of the suite case file, and every record\'s own capability list equals the suite `tools_available`' +
          (' (exceptions: %s).' % ', '.join(integ) if integ else ' in all %d primary runs.' % len(runs))]
    no_rest = [run_label(r) for r in runs if 'restored' not in r]
    L += ['', 'Restored runs: %s. Primary runs with no restored sibling (their guards-undone figure is unavailable): %s.' % (
        'used only in the "guards undone" columns' + ((' (restored dirs with no primary: %s)' % ', '.join(report['restored_dirs_without_primary'])) if report['restored_dirs_without_primary'] else ''),
        ', '.join(no_rest) or 'none')]

    L += ['', '## 2. What each suite offers, and tools never offered', '']
    for s in report['suites']:
        L += ['**Suite %s** (%d cases, `%s`)' % (s['suite_version'], s['cases'], s['dir']), '']
        L += table(['tool or evidence type', 'cases offering it (tools_available)', 'cases carrying pre-supplied evidence of that type'],
                   [[k, v['cases_offering'], v['cases_pre_supplied']] for k, v in s['tools'].items()])
        L.append('')
    L += ['**Offers and requests per tool across every scanned record (as-run and restored); zero in the offer column is a tool never offered**', '']
    rows = []
    for tool, v in report['never_offered'].items():
        sc = v['scanned_runs']
        rows.append([tool, ', '.join('%s: %d' % kv for kv in v['cases_offering_by_suite'].items()), sc['offered_in_capabilities'], sc['requested'], sc['records_scanned']])
    L += table(['tool', 'cases offering it, by suite', 'records whose capability list offered it', 'requests for it by a model', 'records scanned'], rows)
    L += ['', 'Reading, from the numbers above:'] + ['- ' + x for x in never_reading(report)] + ['']

    for title, role in (('3. Local models: per run, per tool', 'local'), ('4. Frontier comparison: per run, per tool', 'frontier')):
        L += ['## ' + title, '']
        if role == 'frontier':
            L += ['Same columns as section 3. Frontier models are the Haiku 5.5 and gpt-6-astra runs; they are here for comparison, not as a target.', '']
        for r in runs:
            if r['meta']['role'] != role:
                continue
            m = r['meta']
            L += ['### %s%s' % (run_label(r), ' (PARTIAL: %d of %s cases, aborted: %s)' % (m['cases_recorded'], m['cases_planned'], m['aborted']) if m['partial'] else ''), '',
                  '%s, prompt %s, format %s, guards %s; %d cases scored, %d correct as run%s; %d calls in total, %d forced, %d protocol violations.' % (
                      m['model'], m['prompt'], m['evidence_format'], m['guards'], r['overall']['n'], r['overall']['correct'],
                      (', %d correct with guards undone' % r['restored']['overall']['correct']) if 'restored' in r else '', r['overall']['total_calls'], r['overall']['forced'],
                      r['overall']['protocol_violations']), '']
            L += table(TOOL_HEAD, tool_rows(r['tools']))
            L.append('')

    L += ['## 5. Pooled per model (full runs only; run-cases are not independent samples)', '']
    for g in report['pooled']:
        L += ['### %s (%s): %s' % (g['model'], g['role'], ', '.join(g['runs'])), '']
        L += table(TOOL_HEAD, tool_rows(g['tools']))
        L.append('')
    L += ['### Same case, same model, different round', '',
          'Only cases where that model\'s runs disagree on calling an offered tool. Holds case difficulty fixed; the round (prompt, format, guards) still differs between the runs, and rounds differ in overall accuracy, so this is still a correlation.', '']
    for p in report['paired']:
        if not p['tools']:
            continue
        L += ['**%s (%s)**' % (p['model'], p['role']), '']
        L += table(['tool', 'cases where runs disagree', 'runs that called: correct', 'runs that did not call: correct'],
                   [[k, v['cases'], frac_p(v['called_runs']), frac_p(v['not_called_runs'])] for k, v in p['tools'].items()])
        L.append('')

    L += ['## 6. By class (local models, pooled over full runs)', '', 'Class is the case\'s truth class. Columns: cases offering the tool, cases with pre-supplied evidence of its type, cases where it was called (calls), '
          'correct when offered and called, correct when offered and not called.', '']
    for g in report['pooled']:
        if g['role'] != 'local':
            continue
        for c, v in g['by_class'].items():
            L += ['### %s: %s (%d run-cases, %d correct as run)%s' % (g['model'], c, v['n'], v['correct'], ' <- identity_mismatch, see section 7' if c == 'identity_mismatch' else ''), '']
            L += table(['tool', 'offered', 'pre-supplied', 'called (cases / calls)', 'correct: called', 'correct: not called'],
                       [[t, x['cases_offered'], x['cases_pre_supplied'], '%d / %d' % (x['cases_called'], x['calls']), frac_p(x['offered_called']), frac_p(x['offered_not_called'])]
                        for t, x in v['tools'].items() if _shown(x)])
            L.append('')

    L += ['## 7. identity_mismatch: wrong-episode and wrong-content files', '',
          'The owner\'s goal is a local model scanning a whole TV series for such files. The suite has %s tv identity cases (`tv-identity-*`); the table lists every full run.' % (
              next((len([c for c in t['tv_cases']]) for t in report['tv_identity'] if t['tv_cases']), 0)), '']
    L += table(['run', 'model', 'identity_mismatch cases correct, all media (as run)', 'guards undone', 'misses that named identity_mismatch but chose another action'],
               [[t['run'], t['model'], frac_p(t['identity_all_media']), frac_p(t['identity_all_media_guards_undone']) if t['identity_all_media_guards_undone'] else 'no restored run',
                 '%d of %d' % (t['identity_misses']['named_identity_mismatch_but_other_action'], t['identity_misses']['n'])]
                for t in report['tv_identity'] if t['role'] == 'local'])
    L += ['', 'Per tv identity case (local runs). Each cell is `pre-supplied evidence of the type / calls made` and a star when the final decision cited it; `-` means the case does not offer the tool and carries none.', '']
    names = [t for t in TOOL_ORDER + PRE_ONLY if any(t in c['tools'] for tv in report['tv_identity'] if tv['role'] == 'local' for c in tv['tv_cases'])]
    rows = []
    for tv in report['tv_identity']:
        if tv['role'] != 'local':
            continue
        for c in tv['tv_cases']:
            cells = []
            for t in names:
                x = c['tools'].get(t)
                cells.append('-' if not x or not (x['offered'] or x['pre_supplied']) else '%d/%d%s' % (x['pre_supplied'], x['calls'], '*' if x['cited'] else ''))
            rows.append([tv['run'], c['case_id'], 'yes' if c['correct'] else 'NO', '%s/%s' % (c['decision_class'], c['decision_action'])] + cells)
    L += table(['run', 'case', 'correct', 'decision class/action'] + names, rows)
    L += ['', 'Pooled over local runs, identity_mismatch only (all media):', '']
    for g in report['pooled']:
        if g['role'] == 'local' and 'identity_mismatch' in g['by_class']:
            v = g['by_class']['identity_mismatch']
            L += ['**%s**: %d run-cases, %d correct as run.' % (g['model'], v['n'], v['correct']), '']
            L += table(['tool', 'offered', 'pre-supplied', 'called (cases / calls)', 'correct: called', 'correct: not called'],
                       [[t, x['cases_offered'], x['cases_pre_supplied'], '%d / %d' % (x['cases_called'], x['calls']), frac_p(x['offered_called']), frac_p(x['offered_not_called'])]
                        for t, x in v['tools'].items() if _shown(x)])
            L.append('')

    L += ['## 8. Fields the records could not support', '']
    for u in report['unavailable_fields']:
        L.append('- ' + u)
    L.append('')
    return '\n'.join(L)


def never_reading(report):
    out = []
    runs = [r for r in report['runs'] if 'unavailable' not in r]
    used = Counter(r['meta']['suite_version'] for r in runs)
    out.append('The scanned primary runs used suite version(s): %s.' % ', '.join('%s (%d runs)' % kv for kv in sorted(used.items(), key=lambda kv: str(kv[0]))))
    for tool, v in report['never_offered'].items():
        sc = v['scanned_runs']
        if sc['offered_in_capabilities']:
            continue
        by = v['cases_offering_by_suite']
        txt = '`%s` was offered in no scanned record. Cases offering it: %s.' % (tool, ', '.join('%s %d' % kv for kv in sorted(by.items())))
        used_with = [ver for ver, n in by.items() if n and ver in used]
        if any(by.values()) and not used_with:
            txt += ' No scanned run used a suite that offers it.'
        rem = {ver: n for ver, n in v.get('removed_by_correction_by_suite', {}).items() if n}
        if rem:
            txt += ' %s.' % '; '.join('%d cases of suite %s carry a correction note saying it was removed from tools_available' % (n, ver) for ver, n in sorted(rem.items()))
        if sc['requested']:
            txt += ' A model asked for it %d times; the harness answered `unavailable` because the case did not offer it.' % sc['requested']
        if tool == 'subtitle_sample':
            txt += ' It is the opt-in tool of tools behaviour `v3-remote-1` (#161, README), reachable only in a run configured for it; no scanned run was.'
        out.append(txt)
    return out


def unavailable_fields(report):
    runs = [r for r in report['runs'] if 'unavailable' not in r]
    no_rest = [run_label(r) for r in runs if 'restored' not in r]
    partial = [run_label(r) for r in runs if r['meta']['partial']]
    out = [
        'Whether a result was actually used by the model beyond being cited: the records hold the cited refs, not the reasoning, so "cited" is the only usefulness signal here.',
        'Per-tool wall time and cost: not computed (records carry per-turn time and usage, not a per-tool split that this report attributes).',
        'Guards-undone figures: unavailable for %s (no `-restored` sibling in the given roots).' % (', '.join(no_rest) or 'no run'),
    ]
    if partial:
        out.append('Partial runs (%s) are listed and flagged but kept out of every pooled number and the summary.' % ', '.join(
            '%s: %d of %s cases, aborted: %s' % (run_label(r), r['meta']['cases_recorded'], r['meta']['cases_planned'], r['meta']['aborted']) for r in runs if r['meta']['partial']))
    unav = [run_label(r) for r in report['runs'] if 'unavailable' in r]
    if unav:
        out.append('Runs whose suite version matches no given suite are not analysed: %s.' % ', '.join(unav))
    out.append('Held-out cases and runs outside the given roots are not read.')
    return out


def to_jsonable(o):
    if isinstance(o, Counter):
        return dict(o)
    if isinstance(o, dict):
        return {str(k): to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(x) for x in o]
    return o


def compact_cases(report):
    """JSON only: per case, what happened (offered tools are in the suite, not repeated)."""
    for r in report['runs']:
        if 'cases' not in r:
            continue
        out = {}
        for cid, c in r['cases'].items():
            tools = c['tools']
            out[cid] = {'truth': c['truth'], 'media_type': c['media_type'], 'correct': c['correct'], 'decision': '%s/%s' % (c['decision_class'], c['decision_action']),
                        'forced': c['forced'], 'protocol_violations': c['protocol_violations'],
                        'calls': {t: {'calls': x['calls'], 'statuses': x['statuses']} for t, x in tools.items() if x['calls']},
                        'requested_not_offered': {t: x['called_not_offered'] for t, x in tools.items() if x.get('called_not_offered')},
                        'pre_supplied': sorted(t for t, x in tools.items() if x['pre_supplied']),
                        'cited': {t: x['cited'] for t, x in tools.items() if x['cited']},
                        'unresolved_refs': c['unresolved_refs']}
        r['cases'] = out
        r['by_class'] = {c: {'n': v['n'], 'correct': v['correct'], 'tools': _slim_tools(v['tools'])} for c, v in r['by_class'].items()}
    for g in report['pooled']:
        g['by_class'] = {c: {'n': v['n'], 'correct': v['correct'], 'tools': _slim_tools(v['tools'])} for c, v in g['by_class'].items()}
    return report


def _slim_tools(tools):
    keep = ('cases_offered', 'cases_pre_supplied', 'cases_called', 'calls', 'offered_called', 'offered_not_called')
    return {t: {k: x[k] for k in keep} for t, x in tools.items() if x['cases_offered'] or x['cases_pre_supplied'] or x['calls']}


def finish_report(report):
    ok = [r for r in report['runs'] if 'unavailable' not in r]
    report['paired'] = paired_same_case(ok)
    report['tv_identity'] = tv_identity_view(ok)
    report['unavailable_fields'] = unavailable_fields(report)
    report['caveats'] = list(CAVEATS)
    report['summary'] = summary_lines(report)
    return report


def command_text(args):
    parts = ['python3 tools/media-repair-harness/scripts/tool_usage_report.py']
    parts += ['--runs-root ' + r for r in args.runs_root]
    parts += ['--suite-dir ' + s for s in args.suite_dir]
    parts += ['--out-md ' + args.out_md, '--out-json ' + args.out_json]
    return ' \\\n  '.join(parts)


def main(argv=None):
    if sys.version_info < MIN_PY:
        raise SystemExit('Python >= 3.11 required')
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--runs-root', action='append', required=True, help='a run directory, or a folder of run directories (repeatable)')
    ap.add_argument('--suite-dir', action='append', required=True, help='a public suite directory (repeatable)')
    ap.add_argument('--out-md', required=True)
    ap.add_argument('--out-json', required=True)
    args = ap.parse_args(argv)
    dirs = find_run_dirs(args.runs_root)
    if not dirs:
        raise SystemExit('no run directory with a score.json under the given roots')
    report = finish_report(build_report(dirs, args.suite_dir))
    report['command'] = command_text(args)
    md = render_md(report, report['command'], report['summary'])
    Path(args.out_md).write_text(md, encoding='utf-8')
    Path(args.out_json).write_text(json.dumps(to_jsonable(compact_cases(report)), separators=(',', ':'), sort_keys=False) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
