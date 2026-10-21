#!/usr/bin/env python3
"""Benchmark-passability report, policy `passability-2` (dev-c7, runs/dev-c7/PREREGISTRATION.md section 6): `passability-1` (scripts/passability.py,
frozen and unchanged, sha256 in the pre-registration) applied to format v3.1-format records.  Offline: no model call; the only tool work is the unchanged
replay tools serving the recorded fixtures.

passability-1 reads a run the way format v3 / tools behaviour v2 presented it.  A v3.1-format run differs in five places, and only these change here
(every rule, category, constant, row and column of passability-1 is reused as it is, by loading the frozen script as an independent module instance and
replacing exactly these functions in that instance; the passability-1 module itself is never modified):

  1. what the model was shown (S and fidelity): the case evidence is resolved as the v3.1 run resolved it (tools behaviour v3 context, EPUB evidence kept
     literal with only its locators aliased: `run.resolve_evidence_raw(..., literal_epub=True)`), then the run's tool results;
  2. what the checker reads: the observations typed as the v3.1 audit types them (`evidence_v31.internal`: an explicit EPUB excerpt is a reading,
     `epub_text`, never a package check; `evidence_v31.without_legacy_heads`: the legacy spine heads are withheld, D32-3);
  3. exploration and witness: candidates are served by tools behaviour v3 (what a C7 model would be served; a recorded case-evidence epub_inspect result
     without body text does not make the tools-v3 `epub_inspect {}` "already shown", since that call returns body text the recorded result lacks), links
     are computed over the v3.1 analysis, and a witness's page cost is counted by the real v3.1-format session at the run's page budget (`wire_bytes`);
  4. fidelity's source rendering: the v3.1-format renderer (`evidence_v31.render`) of the same observations, read back by the same parser
     (`facts.facts_from_body`) that reads the delivered transcript;
  5. free-text identity: once EPUB body text is among the observations, an `identity_disagreement` row (D-ID-1, A-BLK-4) that the checker reports
     `unmet` only because it reads no body text (C32-4) and no longer sees the legacy heads is reported `unknown`, as passability-1 reported free-text
     identity (its coverage limit "free-text identity stays unknown to the checker"); it never becomes `met`.

Explicit EPUB excerpts are not explored: the v3.1 checker reads no excerpt (contract section 16, C32-4), so an excerpt cannot meet a prerequisite; this
is added to the disclosed coverage limits.  The script makes no hand judgement.  It refuses a run that is not format v3.1-format.

Usage: passability_v2.py --run DIR --restored DIR --suite DIR [--tension FILE] [--out-json FILE]
"""
import argparse
import importlib.util
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
from media_repair_harness.experimental.contract_v3 import facts as FX       # noqa: E402
from media_repair_harness.experimental.contract_v3 import links as LK       # noqa: E402
from media_repair_harness.experimental.contract_v3 import prereq as PQ      # noqa: E402

BASE_SCRIPT = HERE / 'passability.py'
_spec = importlib.util.spec_from_file_location('passability_v1_for_v2', BASE_SCRIPT)
B = importlib.util.module_from_spec(_spec)          # an INDEPENDENT instance of the frozen passability-1 script: `import passability` stays untouched
_spec.loader.exec_module(B)

POLICY_VERSION = 'passability-2'
FORMAT = EV31.FORMAT_VERSION
POLICY = dict(B.POLICY, version=POLICY_VERSION, base_policy=B.POLICY_VERSION, evidence_format=FORMAT, tools_behavior=EV31.TOOLS_BEHAVIOR,
              changes=('passability-1 applied to format v3.1-format: (1) the case evidence resolved as the v3.1 run resolved it; (2) the checker reads the '
                       'observations typed as the v3.1 audit types them (an explicit excerpt is a reading; the legacy spine heads are withheld); (3) candidates '
                       'served by tools behaviour v3 (a recorded epub_inspect result without body text does not make epub_inspect {} already shown), links over the v3.1 analysis, page cost counted by the v3.1-format session at the run\'s wire budget; '
                       '(4) fidelity\'s source rendering is the v3.1-format renderer read back by the same parser as the delivered transcript; (5) once EPUB '
                       'body text is among the observations, an identity_disagreement row the checker reports unmet is reported unknown (free-text identity)'),
              limits=B.POLICY['limits'] + '; explicit EPUB excerpts are not explored (the v3.1 checker reads no excerpt, C32-4)')
STATE = {'budget': EV2.WIRE_BYTES}     # the run's recorded page budget (wire_bytes), set by report()


def v31_context(case, suite_dir):
    fx = T.Fixture.from_case(case, suite_dir)
    return T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w23-pass-'), suite_dir=suite_dir, which=lambda _n: None, tools_behavior=EV31.TOOLS_BEHAVIOR, keep_raw=True)


def case_observations(case, suite_dir, ctx):
    return [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case')
            for e in RUN.resolve_evidence_raw(case, suite_dir, ctx.redact, literal_epub=True)]


def typed(observations):
    """What the v3.1 checker reads (evidence_v31.shown_observations' typing): excerpt -> reading, legacy heads withheld."""
    return [EV31.without_legacy_heads(EV31.internal(o)) for o in observations]


class Explorer(B.Explorer):
    """passability-1's explorer with the v3.1 presentation: tools behaviour v3, case evidence as the v3.1 run resolved it, links over the v3.1 analysis."""

    def __init__(self, case, suite_dir):           # noqa: super().__init__ is replaced on purpose (another tools behaviour)
        self.case, self.suite_dir = case, suite_dir
        self.ctx = v31_context(case, suite_dir)
        self.base = case_observations(case, suite_dir, self.ctx)
        self.view = P.case_view(case, [], case_alias='case-00000000')
        self.caps = T.capabilities(self.ctx)
        self.served, self.order, self.unserved = {}, [], []

    def serve(self, tool, args):
        """passability-1's serve, with one difference: a recorded case-evidence epub_inspect result WITHOUT body text (made by an earlier tools behaviour)
        does not make the tools-v3 call "already shown", because the tools-v3 result carries body text the recorded one lacks.  Everything else as v1."""
        key = (tool, B.norm_args(args))
        if key in self.served or key in [u[0] for u in self.unserved]:
            return
        if any(LK._call_matches(o, tool, args) and not (tool == 'epub_inspect' and not has_body_text([o])) for o in self.base):
            return                  # already shown as case evidence
        res = T.call_tool(self.ctx, tool, args)
        if res['status'] == 'unavailable':
            self.unserved.append((key, 'unavailable'))
            return
        oid = 'x%d' % (len(self.order) + 1)
        self.served[key] = EV2.make_observation(oid, tool, EV2.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool',
                                                bool(res.get('collector_truncated')))
        self.order.append(key)

    def revealed(self, observations):
        an = EV31.analyze(observations, self.view['context'], self.view['media_type'])
        items = LK.attach_links(LK.open_items(an, self.view['media_type']), self.caps, [EV31.internal(o) for o in observations],
                                self.case.get('tools_available'), self.view['media_type'])
        out = [(c['tool'], c['args']) for it in items for c in it['available_check'] if c['availability'] == 'available']
        for o in observations:
            if o['tool'] == 'frame_sample':
                d = EV2.parse_json(o.get('output'))
                if isinstance(d, dict) and isinstance(d.get('frame'), str):
                    out.append(('ocr', {'frame': d['frame']}))
        return out


FREE_TEXT = 'free-text identity: EPUB body text was shown or is excerpt-addressable, and the v3.1 checker reads no body text (C32-4); judged, not computed'


def has_body_text(observations):
    """An ok tools-v3 epub_inspect result carrying body text (`body`, the index and default excerpts, or one explicit `excerpt`)."""
    for o in observations:
        if o.get('tool') == 'epub_inspect' and o.get('status') == 'ok':
            data, _n = EV2.unwrap(o)
            if isinstance(data, dict) and ('body' in data or 'excerpt' in data):
                return True
    return False


def check(explorer, observations):
    """The frozen checker over the v3.1-typed observations.  Change (5): once EPUB body text is among the observations, an identity_disagreement row the
    checker reports `unmet` (it has no content observation: the legacy heads are withheld and excerpts are not read) is reported `unknown` instead, as
    passability-1 reported free-text identity; it never becomes `met`."""
    res = PQ.check(typed(observations), explorer.view['context'], explorer.view['media_type'], explorer.caps)
    if has_body_text(observations):
        rows = [r for rs in res['diagnosis'].values() for r in rs] + [r for a in res['actions'].values() for r in a['prerequisites']]
        for r in rows:
            if r.get('check') == 'identity_disagreement' and r['state'] == PQ.UNMET:
                r.update(state=PQ.UNKNOWN, detail=FREE_TEXT)
    return res


def pages_cost(explorer, results):
    """Calls plus every extra page of the first message and of each result, counted by the real v3.1-format session at the run's page budget."""
    ses = EV31.Session('case-00000000', explorer.view['context'], explorer.view['media_type'], explorer.view['tools_available'], explorer.caps, budget=STATE['budget'])
    frame = {'case_id': 'case-00000000', 'media_type': explorer.view['media_type'], 'context': explorer.view['context'], 'tools_available': explorer.view['tools_available'],
             'tool_call_budget': P.MAX_TOOL_CALLS, 'capabilities': explorer.caps, 'evidence_format': FORMAT}
    _b, n = ses.initial(list(explorer.base), frame)
    extra = n - 1
    for i, o in enumerate(results, 1):
        _t, n = ses.result(dict(o, id='t%d' % i), 't%d' % i, P.MAX_TOOL_CALLS - i)
        extra += n - 1
    return len(results) + extra


def shown_observations(record, case, suite_dir):
    """The observations shown before the decision, as the v3.1 run built them (untyped: the renderer and `check` type them)."""
    obs = case_observations(case, suite_dir, v31_context(case, suite_dir))
    for c in record.get('tool_calls') or []:
        if c.get('continuation') or c.get('tool') == 'page':
            continue
        tool = c['tool'] if c['tool'] in P.TOOLS else 'unknown_tool'
        obs.append(EV2.make_observation(c['id'], tool, EV2.safe_args(c.get('args')), c['status'], c.get('raw_output', c.get('output')), c.get('mode'), 'tool',
                                        c.get('collector_truncated')))
    return obs


def _rendered_facts(observations, view, caps):
    ref = EV31.render(observations, view['context'], view['media_type'], view['tools_available'], caps, budget=STATE['budget'], shadow=False)['reference']
    return FX.facts_from_body(ref)


def source_facts(record, case, suite_dir):
    """-> ({observation id: set of canonical facts as the v3.1 renderer states them}, the v3.1 analysis of everything shown, the case-evidence ids)."""
    view = P.case_view(case, [])
    caps = (record.get('evidence_format') or {}).get('capabilities') or []
    obs = shown_observations(record, case, suite_dir)
    base = [o for o in obs if o.get('source') == 'case']
    ids = {o['id'] for o in base}
    out = {}
    for t in _rendered_facts(base, view, caps):
        if t[0] in ids and t[7] in B.SECTIONS:
            out.setdefault(t[0], set()).add(EV2.canon(list(t)))
    prefix = list(base)
    for o in obs:
        if o.get('source') == 'case':
            continue
        prefix.append(o)
        for t in _rendered_facts(prefix, view, caps):
            if t[0] == o['id'] and t[7] in B.SECTIONS:
                out.setdefault(t[0], set()).add(EV2.canon(list(t)))
    return out, EV31.analyze(obs, view['context'], view['media_type']), ids


# install the four v3.1 pieces into the independent instance (every other function of passability-1 is used as it is)
B.POLICY_VERSION, B.POLICY = POLICY_VERSION, POLICY
B.Explorer, B.check, B.pages_cost, B.shown_observations, B.source_facts = Explorer, check, pages_cost, shown_observations, source_facts
classify, fidelity, witness, load_records = B.classify, B.fidelity, B.witness, B.load_records


def report(run_dir, restored_dir, suite, tension_path=None):
    man = json.loads((Path(run_dir) / 'manifest.json').read_text())
    cfg = man.get('config') or {}
    if cfg.get('evidence_format') != FORMAT:
        raise SystemExit('%s applies to format %s runs only; this run is %r (use passability.py, policy %s)' % (POLICY_VERSION, FORMAT, cfg.get('evidence_format'), B.POLICY_VERSION))
    STATE['budget'] = int(cfg.get('wire_bytes') or EV2.WIRE_BYTES)
    out = B.report(run_dir, restored_dir, suite, tension_path)
    out['policy'] = POLICY
    out['wire_bytes'] = STATE['budget']
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True)
    ap.add_argument('--restored', required=True)
    ap.add_argument('--suite', required=True)
    ap.add_argument('--tension', default=str(COMPONENT / 'docs' / 'contract-v3-label-tension.json'))
    ap.add_argument('--out-json')
    a = ap.parse_args(argv)
    out = report(a.run, a.restored, a.suite, a.tension)
    text = json.dumps(out, indent=1, ensure_ascii=False, default=str)
    if a.out_json:
        Path(a.out_json).write_text(text + '\n')
    print(json.dumps({'counts': out['counts'], 'rows': len(out['rows'])}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
