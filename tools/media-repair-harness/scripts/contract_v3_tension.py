#!/usr/bin/env python3
"""Neutral label-tension list for the evaluator (contract v3, WO-W20 item 4; A16 item 5).  Offline: no model call, no tool run.

Step 1, BLINDED: for every public dev case the frozen checker (experimental/contract_v3/prereq.py, rubric frozen in 59e15d49) receives only the
model-visible view: a neutral alias, the context the model sees, the media type, the case evidence and the advertised capabilities.  It never
receives the case id, truth, supported actions, accepted classes, solvability, family or provenance.
Step 2, unblinded: the label's class (and accepted alternatives) and its supported actions are joined, and a case is listed only when a
prerequisite the label needs is not met by the case evidence AND no evidence of an accepted kind is obtainable from an offered, advertised tool
(or, for a context-only prerequisite, the context does not state it).  Output: id and reason only.  Labels are not changed and the contract is
not weakened; this file is never an input of any renderer.  Usage: contract_v3_tension.py [--json FILE] [--md FILE] [--checker v3.1|v3.3] [--diagnostic-rules diag-1|diag-2]

Defaults (checker v3.1, diagnostic rules diag-1) reproduce docs/contract-v3-label-tension.{json,md} byte for byte.  `--checker v3.3` (W25) runs the
rubric v3.3 checker (prereq_v33.py, an amendment written AFTER labels had been read) and types prior records by its rule; `--diagnostic-rules diag-2`
classifies diagnostics with the W25 corrections."""
import argparse
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))
from media_repair_harness import evidence_v2 as EV2   # noqa: E402
from media_repair_harness import protocol as P       # noqa: E402
from media_repair_harness import run as RUN          # noqa: E402
from media_repair_harness import tools as T          # noqa: E402
from media_repair_harness.experimental.contract_v3 import facts as FX     # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq as PQ    # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq_v33 as PQ33    # noqa: E402
from media_repair_harness.experimental.contract_v3 import rubric as RB    # noqa: E402

REPO = COMPONENT.parents[1]
SUITE = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
CONTEXT_ONLY = ('stated_client', 'managed_app', 'old_value')
REMOVABLE_BY_MORE = {'M1': ('integrity',), 'M5': ('content', 'report_content'), 'M9': ()}


def blinded(case, n):
    """The checker's inputs, and nothing else."""
    fx = T.Fixture.from_case(case, SUITE)
    ctx = T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w20-'), suite_dir=SUITE, which=lambda _n: None, tools_behavior='v2', keep_raw=True)
    alias = 'case-%08d' % n
    view = P.case_view(case, [], case_alias=alias)
    obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in RUN.resolve_evidence_raw(case, SUITE, ctx.redact)]
    caps = T.capabilities(ctx)
    return {'observations': obs, 'context': view['context'], 'media_type': view['media_type'], 'tools': view['tools_available'], 'capabilities': caps}


def obtainable_kinds(b, report_kind=FX.report_kind):
    kinds = set()
    for o in b['observations']:
        d = EV2.derive(o)
        if d.execution['state'] == 'ran':
            if o['tool'] in RB.TOOL_SEMANTICS:
                kinds.update(RB.TOOL_SEMANTICS[o['tool']]['kinds'])
            if o['tool'] == 'prior_record':
                kinds.add(report_kind((d.facts or {}).get('evidence_method') if isinstance(d.facts, dict) else None))
    for c in b['capabilities']:
        if c.get('tool') in b['tools'] and c.get('available') is True and c['tool'] in RB.TOOL_SEMANTICS:
            k = set(RB.TOOL_SEMANTICS[c['tool']]['kinds'])
            if c['tool'] == 'ocr' and not c.get('recorded_reading_ranges_s'):
                k.discard('content')
            kinds |= k
    return kinds


def needed_kinds(check):
    if check == 'identity_level':
        return ('content', 'report_content')
    if check in ('H1', 'positively_clean'):
        return ('integrity',)
    spec = RB.CHECKS.get(check)
    return tuple(spec['kinds']) if spec else ()


def tensions_for(res, kinds, label_class, accepted, supported):
    out = []
    writes = [a for a in supported if a in P.WRITE_ACTIONS]
    escalate_ok = 'escalate' in supported or 'insufficient_evidence' in accepted

    def blocked(p):
        if p['state'] == PQ.MET:
            return None
        c = p['check']
        if c in CONTEXT_ONLY:
            return '%s (%s): the case context does not state it' % (p['id'], c)
        need = needed_kinds(c)
        if need and not (set(need) & kinds):
            return '%s (%s): needs %s evidence; none is in the case and no offered tool yields it' % (p['id'], c, ' or '.join(need))
        return None
    for cls in accepted:
        if cls in ('insufficient_evidence',):
            return []
    reasons = []
    for cls in accepted:
        rs = []
        if cls == 'healthy':
            for m in res['material']:
                if m['state'] != PQ.MET:
                    continue
                rem = REMOVABLE_BY_MORE.get(m['id'])
                if rem is not None and (not rem or set(rem) & kinds):
                    continue
                rs.append('healthy needs no material uncertainty; the case evidence shows %s' % m['id'])
            h1 = next(p for p in res['diagnosis']['healthy'] if p['id'] == 'D-OK-H1')
            r = blocked(dict(h1, check='H1'))
            if r:
                rs.append(r)
        elif cls in res['diagnosis']:
            for p in res['diagnosis'][cls]:
                r = blocked(p)
                if r:
                    rs.append(r)
        reasons.append((cls, rs))
    if any(not rs for _c, rs in reasons):
        diag_reasons = []
    else:
        diag_reasons = ['label class %s: %s' % (c, '; '.join(rs)) for c, rs in reasons]
    out += diag_reasons
    if writes and not escalate_ok:
        per = []
        for a in writes:
            rs = [blocked(p) for p in res['actions'][a]['prerequisites'] if not p.get('when_class') or p['when_class'] == label_class]
            per.append((a, [r for r in rs if r]))
        if all(rs for _a, rs in per):
            out += ['supported %s only: %s' % (a, '; '.join(rs)) for a, rs in per]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--json')
    ap.add_argument('--md')
    ap.add_argument('--checker', choices=('v3.1', 'v3.3'), default='v3.1')
    ap.add_argument('--diagnostic-rules', choices=EV2.DIAGNOSTIC_RULES, default=EV2.DEFAULT_DIAGNOSTIC_RULES)
    a = ap.parse_args(argv)
    with EV2.diagnostic_rules(a.diagnostic_rules):
        return _main(a)


def _main(a):
    checker = PQ33.check if a.checker == 'v3.3' else PQ.check
    kind_of = PQ33.report_kind if a.checker == 'v3.3' else FX.report_kind
    rubric = PQ33.RUBRIC_VERSION if a.checker == 'v3.3' else RB.RUBRIC_VERSION
    rows = []
    cases = [(p, json.loads(p.read_text())) for p in sorted((SUITE / 'cases').glob('*.json'))]
    # step 1, blinded: the checker sees aliases only
    results = []
    for n, (_p, case) in enumerate(cases):
        b = blinded(case, n)
        res = checker(b['observations'], b['context'], b['media_type'], b['capabilities'])
        results.append((res, obtainable_kinds(b, kind_of)))
    # step 2, unblinded
    for (_p, case), (res, kinds) in zip(cases, results):
        label = case['truth']['class']
        accepted = [label] + [c for c in case.get('accepted_classes') or [] if c != label]
        t = tensions_for(res, kinds, label, accepted, case.get('supported_actions') or [])
        if t:
            rows.append({'id': case['id'], 'reason': ' | '.join(t)})
    print('%d of %d public dev cases listed' % (len(rows), len(cases)))
    for r in rows:
        print('-', r['id'], ':', r['reason'])
    if a.json:
        doc = {'rubric': rubric, 'suite': 'suite-dev-v1.1', 'cases': len(cases), 'listed': rows}
        if a.checker != 'v3.1' or a.diagnostic_rules != EV2.DEFAULT_DIAGNOSTIC_RULES:
            doc.update(checker=PQ33.CHECKER_VERSION if a.checker == 'v3.3' else 'prereq-v3.1', diagnostic_rules=a.diagnostic_rules,
                       note='rubric v3.3 is an amendment written after the labels had been read (docs/contract-v3.md section 17)')
        Path(a.json).write_text(json.dumps(doc, indent=1) + '\n')
    if a.md:
        frozen = 'frozen before any label was read' if a.checker == 'v3.1' else 'an amendment written AFTER the labels had been read; diagnostic rules %s' % a.diagnostic_rules
        lines = ['# Contract v3: neutral label-tension observations (for the evaluator)', '',
                 'Generated by `scripts/contract_v3_tension.py` with rubric `%s` (%s). The checker ran on blinded inputs; the labels were joined afterwards. '
                 'A case is listed only when a prerequisite its label needs is unmet on the case evidence and no evidence of an accepted kind is obtainable from an offered tool. '
                 'These are observations, not proposed label changes, and the contract is not weakened to remove them. No renderer, prompt or model reads this file.' % (rubric, frozen), '',
                 '%d of %d public dev cases.' % (len(rows), len(cases)), '', '| Case | Reason |', '|---|---|']
        lines += ['| %s | %s |' % (r['id'], r['reason'].replace('|', '/')) for r in rows]
        Path(a.md).write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
