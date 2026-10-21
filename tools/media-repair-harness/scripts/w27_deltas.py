#!/usr/bin/env python3
"""W27 (OpenProject #145 remainder, the PR #1031 nits): how the new versions change the public results, offline (no model call; the only tool runs are
the local epub_inspect {} package check and the stdlib live EPUB collector on the public suites' readable EPUB fixtures, read-only).

Configurations compared (each classified inside its own diagnostic rules):
  recorded  tools behaviour v3, diagnostic rules diag-1, checker rubric v3.1 (what every recorded configuration uses)
  w25       tools behaviour v4, diagnostic rules diag-2, checker rubric v3.3 (the W25 versions, docs/w25-deltas.json)
  w27       tools behaviour v4, diagnostic rules diag-3, checker rubric v3.3, live collector behaviour live-2 (W27)

For each case of both public dev suites, BLINDED (the checker sees the model-visible view only; no label is joined in sections 1 to 4):
  1. the typed verdict of every case-evidence observation (execution state and cause, integrity, container, package stages, findings), w25 -> w27 and
     recorded -> w27;
  2. the epub_inspect {} result of every case that offers it with a readable local fixture, and its typed verdict, w25 -> w27;
  3. the checker's prerequisite states over the case evidence, w25 -> w27;
  4. the live EPUB collector on the same fixtures, live-1 -> live-2 (record status, stage, validity, findings and the typed verdict under diag-3);
then, as the committed tools compute them:
  5. the v3.3 label-tension list (scripts/contract_v3_tension.py: the checker blinded, the labels joined afterwards) under diag-3 against the committed
     diag-2 list (docs/contract-v3-label-tension-v3.3.json);
  6. the uncalled-2 counts over the dev-c7 records (docs/contract-v3-uncalled-v2.json, read under the default diag-1) recomputed under diag-2 and diag-3.

Usage: w27_deltas.py [--out FILE]"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import evidence as EVC          # noqa: E402
from media_repair_harness import evidence_v2 as EV2      # noqa: E402
from media_repair_harness import evidence_v31 as EV31    # noqa: E402
from media_repair_harness import protocol as P           # noqa: E402
from media_repair_harness import run as RUN              # noqa: E402
from media_repair_harness import tools as T              # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq as PQ        # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq_v33 as PQ33  # noqa: E402
from media_repair_harness.experimental.contract_v3 import uncalled_v2 as UC2  # noqa: E402

REPO = COMPONENT.parents[1]
H = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
SUITES = {'suite-dev-v1': H / 'suite', 'suite-dev-v1.1': H / 'suite-dev-v1.1'}
CONFIGS = {'recorded': {'tools_behavior': 'v3', 'diagnostic_rules': 'diag-1', 'checker': PQ.RB.RUBRIC_V31_VERSION},
           'w25': {'tools_behavior': 'v4', 'diagnostic_rules': 'diag-2', 'checker': PQ33.RUBRIC_VERSION},
           'w27': {'tools_behavior': 'v4', 'diagnostic_rules': 'diag-3', 'checker': PQ33.RUBRIC_VERSION, 'live_behavior': 'live-2'}}


def _load(name):
    spec = importlib.util.spec_from_file_location(name + '_w27', HERE / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


W25 = _load('w25_deltas')       # verdict(), checker_states() and diff(), unchanged
verdict, checker_states, diff = W25.verdict, W25.checker_states, W25.diff


def _live_epub(path, behavior):
    rec = EVC.collect(str(path), ['epub'], live_behavior=behavior)[0]
    out = rec.get('output') or {}
    with EV2.diagnostic_rules('diag-3'):
        d = EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, rec['status'], EVC.to_tool_result(rec, cap=1 << 20)['output'], 'live', 'tool'))
    return dict(verdict(d), status=rec['status'], stage=out.get('stage'), valid=out.get('valid'),
                findings_what=sorted(f.get('what') for f in out.get('findings') or [] if isinstance(f, dict)))


def typed_and_checker():
    out = {}
    for sname, sdir in SUITES.items():
        rows = {'evidence_verdicts_w25_to_w27': [], 'evidence_verdicts_recorded_to_w27': [], 'epub_inspect_default_w25_to_w27': [], 'checker_w25_to_w27': [],
                'live_epub_live1_to_live2': []}
        counts = {'cases': 0, 'evidence_observations': 0, 'epub_default_calls': 0, 'live_epub_calls': 0}
        for n, p in enumerate(sorted((sdir / 'cases').glob('*.json'))):
            case = json.loads(p.read_text())
            counts['cases'] += 1
            view = P.case_view(case, [], case_alias='case-%08d' % n)
            fixture = T.Fixture.from_case(case, sdir)
            readable_epub = 'epub_inspect' in (case.get('tools_available') or []) and fixture.kind == 'local' and Path(fixture.path).is_file()
            ctxs = {}
            for tag, cfg in CONFIGS.items():
                with EV2.diagnostic_rules(cfg['diagnostic_rules']):
                    ctxs[tag] = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w27-'), suite_dir=sdir, which=lambda _n: None,
                                          tools_behavior=cfg['tools_behavior'], keep_raw=True)
            evidence = RUN.resolve_evidence_raw(case, sdir, ctxs['recorded'].redact, literal_epub=True)
            obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence]
            counts['evidence_observations'] += len(obs)
            got = {}
            for tag, cfg in CONFIGS.items():
                with EV2.diagnostic_rules(cfg['diagnostic_rules']):
                    an = EV31.analyze(obs, view['context'], view['media_type'])
                    chk = (PQ.check if tag == 'recorded' else PQ33.check)(obs, view['context'], view['media_type'], T.capabilities(ctxs[tag]))
                    got[tag] = ({o['id']: verdict(an['items'][o['id']]) for o in obs}, checker_states(chk))
                    if readable_epub and tag != 'recorded':
                        res = T.call_tool(ctxs[tag], 'epub_inspect', {})
                        o = EV2.make_observation('t1', 'epub_inspect', {}, res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool')
                        d = EV31.analyze(obs + [o], view['context'], view['media_type'])['items']['t1']
                        data = EV2.parse_json(res.get('raw_output', res['output'])) or {}
                        got[tag + '_call'] = dict(verdict(d), status=res['status'], stage=data.get('stage'), error=data.get('error'))
            for oid in got['w25'][0]:
                tool = next(o['tool'] for o in obs if o['id'] == oid)
                for key, a in (('evidence_verdicts_w25_to_w27', 'w25'), ('evidence_verdicts_recorded_to_w27', 'recorded')):
                    dv = diff(got[a][0][oid], got['w27'][0][oid])
                    if dv:
                        rows[key].append({'case': case['id'], 'observation': oid, 'tool': tool, 'changes': dv})
            if 'w25_call' in got:
                counts['epub_default_calls'] += 1
                dv = diff(got['w25_call'], got['w27_call'])
                if dv:
                    rows['epub_inspect_default_w25_to_w27'].append({'case': case['id'], 'changes': dv})
            dc = diff(got['w25'][1], got['w27'][1])
            if dc:
                rows['checker_w25_to_w27'].append({'case': case['id'], 'changes': dc})
            if readable_epub:
                counts['live_epub_calls'] += 1
                dv = diff(_live_epub(fixture.path, 'live-1'), _live_epub(fixture.path, 'live-2'))
                if dv:
                    rows['live_epub_live1_to_live2'].append({'case': case['id'], 'changes': dv})
        out[sname] = {'counts': counts, 'changed': {k: len(v) for k, v in rows.items()}, 'rows': rows}
        print('%s: %s; changed %s' % (sname, counts, out[sname]['changed']))
    return out


def tension():
    mod = _load('contract_v3_tension')
    tmp = Path(tempfile.mkdtemp(prefix='mrh-w27-'))
    with contextlib.redirect_stdout(io.StringIO()):
        mod.main(['--checker', 'v3.3', '--diagnostic-rules', 'diag-3', '--json', str(tmp / 't.json')])
    new = json.loads((tmp / 't.json').read_text())['listed']
    old = json.loads((COMPONENT / 'docs' / 'contract-v3-label-tension-v3.3.json').read_text())['listed']
    key = lambda rows: {r['id']: r['reason'] for r in rows}
    a, b = key(old), key(new)
    res = {'against': 'docs/contract-v3-label-tension-v3.3.json (checker prereq-v3.3, diag-2)', 'listed_diag2': len(old), 'listed_diag3': len(new),
           'added': sorted(set(b) - set(a)), 'removed': sorted(set(a) - set(b)), 'reason_changed': sorted(k for k in set(a) & set(b) if a[k] != b[k])}
    print('tension v3.3: diag-2 %d listed, diag-3 %d listed; added %s, removed %s, reason changed %s' % (len(old), len(new), res['added'], res['removed'], res['reason_changed']))
    return res


def uncalled():
    mod = _load('contract_v3_uncalled_v2')
    out = {'against': 'docs/contract-v3-uncalled-v2.json (default rules diag-1)', 'counter': UC2.COUNTER_VERSION, 'runs': {}}
    committed = json.loads((COMPONENT / 'docs' / 'contract-v3-uncalled-v2.json').read_text())['runs']
    for model, run in mod.RUNS.items():
        pairs = mod.pairs_of(run)
        base = committed[model][UC2.COUNTER_VERSION]
        row = {}
        for rules in ('diag-2', 'diag-3'):
            with EV2.diagnostic_rules(rules):
                s2 = json.loads(json.dumps(UC2.summarise(pairs, mod.SUITE)))
            row[rules] = {k: [base.get(k), s2.get(k)] for k in sorted(set(base) | set(s2)) if base.get(k) != s2.get(k)}
        out['runs'][model] = row
        print('uncalled-2 %s: changes from diag-1 under diag-2 %s, under diag-3 %s' % (model, sorted(row['diag-2']), sorted(row['diag-3'])))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    doc = {'configs': CONFIGS, 'note': 'blinded: sections suites (1 to 4) read model-visible inputs only; the tension list joins labels afterwards, as its committed tool does',
           'suites': typed_and_checker(), 'tension_v33': tension(), 'uncalled_v2': uncalled()}
    if a.out:
        Path(a.out).write_text(json.dumps(doc, indent=1, sort_keys=True) + '\n')
    return doc


if __name__ == '__main__':
    main()
