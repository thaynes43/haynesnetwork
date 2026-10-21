#!/usr/bin/env python3
"""W25 (OpenProject #156): how the new versions change the public typed verdicts, offline (no model call; the only tool run is the local epub_inspect {}
package check on the public suites' readable EPUB fixtures, read-only).

Old = what every recorded configuration uses (tools behaviour v3, diagnostic rules diag-1, checker rubric v3.1).
New = the W25 versions (tools behaviour v4, diagnostic rules diag-2, checker rubric v3.3, an amendment written after labels had been read).
For each case of both public dev suites it compares, BLINDED (the checker sees the model-visible view only; no label is joined here):

1. the typed verdict of every case-evidence observation (execution state and cause, integrity, container, package stages, defect findings);
2. the epub_inspect {} result of every case that offers it with a local fixture (status, stage, error) and its typed verdict;
3. the checker's prerequisite states over the case evidence (identity level, material uncertainty M1 to M9, every diagnosis and action prerequisite)
   and the prior-record kinds.

Usage: w25_deltas.py [--out FILE]"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import evidence_v2 as EV2      # noqa: E402
from media_repair_harness import evidence_v31 as EV31    # noqa: E402
from media_repair_harness import protocol as P           # noqa: E402
from media_repair_harness import run as RUN              # noqa: E402
from media_repair_harness import tools as T              # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq as PQ      # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq_v33 as PQ33   # noqa: E402
from media_repair_harness.experimental.contract_v3 import facts as FX       # noqa: E402

REPO = COMPONENT.parents[1]
H = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
SUITES = {'suite-dev-v1': H / 'suite', 'suite-dev-v1.1': H / 'suite-dev-v1.1'}
OLD = {'tools_behavior': 'v3', 'diagnostic_rules': 'diag-1', 'checker': PQ.RB.RUBRIC_V31_VERSION}
NEW = {'tools_behavior': 'v4', 'diagnostic_rules': 'diag-2', 'checker': PQ33.RUBRIC_VERSION}


def verdict(d):
    return {'state': d.execution['state'], 'cause': d.execution.get('cause'), 'integrity': d.integrity, 'container': d.container, 'package': d.package,
            'veto': bool(d.veto), 'defects': sorted(f['kind'] for f in d.findings if f['known_defect']),
            'findings': sorted(f['kind'] for f in d.findings)}


def checker_states(res):
    out = {'identity': res['identity']['level']}
    out.update({m['id']: m['state'] for m in res['material']})
    for cls, reqs in res['diagnosis'].items():
        for r in reqs:
            out['%s:%s' % (cls, r['id'])] = r['state']
    for action, spec in res['actions'].items():
        for r in spec['prerequisites']:
            out['%s:%s' % (action, r['id'])] = r['state']
    return out


def diff(a, b):
    return {k: [a.get(k), b.get(k)] for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    a = ap.parse_args(argv)
    out = {'old': OLD, 'new': NEW, 'note': 'blinded: model-visible inputs only; no label, truth or score is read by this script', 'suites': {}}
    for sname, sdir in SUITES.items():
        rows = {'evidence_verdicts': [], 'epub_inspect_default': [], 'checker': [], 'prior_record_kinds': []}
        counts = {'cases': 0, 'evidence_observations': 0, 'epub_default_calls': 0}
        for n, p in enumerate(sorted((sdir / 'cases').glob('*.json'))):
            case = json.loads(p.read_text())
            counts['cases'] += 1
            view = P.case_view(case, [], case_alias='case-%08d' % n)
            fixture = T.Fixture.from_case(case, sdir)
            ctxs = {}
            for ver in (OLD, NEW):
                with EV2.diagnostic_rules(ver['diagnostic_rules']):         # tools behaviour v4 is built under diag-2 only (tools.TOOLS_V4_DIAGNOSTIC_RULES)
                    ctxs[ver['tools_behavior']] = T.Context(case, fixture, tempfile.mkdtemp(prefix='mrh-w25-'), suite_dir=sdir, which=lambda _n: None,
                                                            tools_behavior=ver['tools_behavior'], keep_raw=True)
            evidence = RUN.resolve_evidence_raw(case, sdir, ctxs['v3'].redact, literal_epub=True)
            obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence]
            counts['evidence_observations'] += len(obs)
            got = {}
            for tag, ver in (('old', OLD), ('new', NEW)):
                with EV2.diagnostic_rules(ver['diagnostic_rules']):
                    an = EV31.analyze(obs, view['context'], view['media_type'])
                    chk = (PQ33.check if tag == 'new' else PQ.check)(obs, view['context'], view['media_type'], T.capabilities(ctxs[ver['tools_behavior']]))
                    got[tag] = ({o['id']: verdict(an['items'][o['id']]) for o in obs}, checker_states(chk))
                    if 'epub_inspect' in (case.get('tools_available') or []) and fixture.kind == 'local' and Path(fixture.path).is_file():
                        res = T.call_tool(ctxs[ver['tools_behavior']], 'epub_inspect', {})
                        o = EV2.make_observation('t1', 'epub_inspect', {}, res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool')
                        d = EV31.analyze(obs + [o], view['context'], view['media_type'])['items']['t1']
                        data = EV2.parse_json(res.get('raw_output', res['output'])) or {}
                        got[tag + '_call'] = dict(verdict(d), status=res['status'], stage=data.get('stage'), error=data.get('error'))
            for oid in got['old'][0]:
                dv = diff(got['old'][0][oid], got['new'][0][oid])
                if dv:
                    rows['evidence_verdicts'].append({'case': case['id'], 'observation': oid, 'tool': next(o['tool'] for o in obs if o['id'] == oid), 'changes': dv})
            if 'old_call' in got:
                counts['epub_default_calls'] += 1
                dv = diff(got['old_call'], got['new_call'])
                if dv:
                    rows['epub_inspect_default'].append({'case': case['id'], 'changes': dv})
            dc = diff(got['old'][1], got['new'][1])
            if dc:
                rows['checker'].append({'case': case['id'], 'changes': dc})
            for o in obs:
                if o['tool'] == 'prior_record':
                    f = EV2.parse_json(o['output']) or {}
                    old_k, new = FX.report_kind(f.get('evidence_method')), PQ33.report_typing(f.get('evidence_method'))
                    if old_k != new['kind']:
                        rows['prior_record_kinds'].append({'case': case['id'], 'observation': o['id'], 'method': f.get('evidence_method'), 'v3.1': old_k, 'v3.3': new['kind'],
                                                           'matched': new['matched']})
        out['suites'][sname] = {'counts': counts, 'changed': {k: len(v) for k, v in rows.items()}, 'rows': rows}
        print('%s: %s; changed %s' % (sname, counts, out['suites'][sname]['changed']))
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
