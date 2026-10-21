#!/usr/bin/env python3
"""Benchmark-passability report, policy `passability-3` (dev-c7, runs/dev-c7/PREREGISTRATION.md section 8 as amended by Amendment 1): `passability-1`
(scripts/passability.py, frozen and unchanged) applied to format v3.1-format records.  It supersedes `passability-2` (scripts/passability_v2.py, registered
at 5f71b6d3 and kept unchanged, never used for a measurement) after the pre-measurement review (AUDIT-ASTRA-32 items 1 to 3).  Offline: no model call; the
only tool work is the unchanged replay tools serving the recorded fixtures.

passability-1 reads a run the way format v3 / tools behaviour v2 presented it.  passability-3 changes exactly these things (every other rule, category,
constant, row and column of passability-1 is reused as it is, by loading the frozen script as an independent module instance and replacing these
functions in that instance; the passability-1 module itself is never modified):

  1. what the model was shown (S and fidelity): the case evidence is resolved as the v3.1 run resolved it (tools behaviour v3 context, EPUB evidence kept
     literal with only its locators aliased), then the run's tool results;
  2. what the checker reads: the observations typed as the v3.1 audit types them (an explicit excerpt is a reading, `epub_text`; the legacy spine heads
     are withheld, D32-3);
  3. exploration and witness: candidates are served by tools behaviour v3; an epub_inspect candidate is "already shown" only when a case-evidence result of
     the same call carries the SAME body view (`body` and `declared_toc`), so a recorded result with no, a null or an empty body never suppresses a
     materially different tools-v3 inspection (A32-3); links over the v3.1 analysis; a witness's page cost counted by the real v3.1-format session at the
     run's `wire_bytes`;
  4. fidelity: the source rendering is the v3.1-format renderer read back by the same parser as the delivered transcript; AND every deciding
     observation's transmitted statement `kinds` (with its provenance) and `report` (the prior-record method metadata) must arrive equal to the source
     rendering's, across the first message, results and fetched pages: missing or changed metadata is a presentation problem, metadata on a page that was
     not fetched is not obtained (A32-1);
  5. free-text identity: once BODY EVIDENCE (below) is among the observations, an `identity_disagreement` row (D-ID-1, A-BLK-4) that the checker reports
     `unmet` is reported `unknown`; it never becomes `met`;
  6. body-identity dependence (A32-2): when the label has an identity-sensitive class (healthy, metadata_naming, identity_mismatch, order_edition_ambiguity
     or insufficient_evidence: every class but corrupt_file and decoder_incompatible) and body evidence was shown or the case's tools-v3 `epub_inspect {}`
     serves it, a row computed as model error, not obtained (unfetched page), presentation problem, obtainable not obtained or evidence gap depends on
     body or excerpt identity that the checker does not read (C32-4): it is `undetermined (hand judgement)`, the computed category is kept beside it
     (`computed_category`), and score.py's and audit v3's verdicts stay in their own fields.  No label change is proposed.

BODY EVIDENCE (A32-3) is one of three states, never inferred from a key being present:
  `text`       nonempty text was delivered: a default or explicit excerpt, or an observed heading, with non-blank text;
  `available`  excerpt availability is positively evidenced: an indexed spine item that is not the navigation document with `characters` > 0;
  `none`       absent, null, empty or zero (`body: null`, `body: {}`, an empty index or excerpt list, blank text, zero characters).
Only `text` and `available` count.

Explicit EPUB excerpts are not explored (the v3.1 checker reads no excerpt); this is a disclosed coverage limit.  The script makes no hand judgement.  It
refuses a run that is not format v3.1-format.

Usage: passability_v3.py --run DIR --restored DIR --suite DIR [--tension FILE] [--out-json FILE]
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
_spec = importlib.util.spec_from_file_location('passability_v1_for_v3', BASE_SCRIPT)
B = importlib.util.module_from_spec(_spec)          # an INDEPENDENT instance of the frozen passability-1 script: `import passability` stays untouched
_spec.loader.exec_module(B)

POLICY_VERSION = 'passability-3'
FORMAT = EV31.FORMAT_VERSION
IDENTITY_SENSITIVE = ('healthy', 'metadata_naming', 'identity_mismatch', 'order_edition_ambiguity', 'insufficient_evidence')
BODY_RULE_CATEGORIES = ('model error', 'not obtained (unfetched page)', 'presentation problem', 'obtainable, not obtained', 'evidence gap')
POLICY = dict(B.POLICY, version=POLICY_VERSION, base_policy=B.POLICY_VERSION, supersedes='passability-2', evidence_format=FORMAT, tools_behavior=EV31.TOOLS_BEHAVIOR,
              changes=('passability-1 applied to format v3.1-format: (1) the case evidence resolved as the v3.1 run resolved it; (2) the checker reads the '
                       'observations typed as the v3.1 audit types them (an explicit excerpt is a reading; the legacy spine heads are withheld); (3) candidates '
                       'served by tools behaviour v3; an epub_inspect candidate is already shown only when a case-evidence result of the same call carries the '
                       'same body view; links over the v3.1 analysis; page cost by the v3.1-format session at the run\'s wire budget; (4) fidelity reads the '
                       'v3.1-format source rendering with the same parser as the delivered transcript and also requires every deciding observation\'s '
                       'statement kinds, provenance and report metadata to arrive as the source states them (missing or changed: presentation problem; on an '
                       'unfetched page: not obtained); (5) once body evidence (delivered nonempty text or positively evidenced excerpt availability) is among '
                       'the observations, an identity_disagreement row the checker reports unmet is reported unknown; (6) a row of an identity-sensitive '
                       'label whose case shows or serves body evidence, computed as model error, not obtained, presentation problem, obtainable not obtained '
                       'or evidence gap, is undetermined (hand judgement), the computed category kept beside it'),
              body_evidence=('text: nonempty delivered excerpt or heading text; available: an indexed non-navigation spine item with characters > 0; none: '
                             'absent, null, empty or zero; key presence alone is never body evidence'),
              limits=B.POLICY['limits'] + '; explicit EPUB excerpts are not explored (the v3.1 checker reads no excerpt, C32-4); body and excerpt identity '
                                           'is judged by hand, never computed')
STATE = {'budget': EV2.WIRE_BYTES}     # the run's recorded page budget (wire_bytes), set by report()


def v31_context(case, suite_dir):
    fx = T.Fixture.from_case(case, suite_dir)
    return T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w23-pass3-'), suite_dir=suite_dir, which=lambda _n: None, tools_behavior=EV31.TOOLS_BEHAVIOR, keep_raw=True)


def case_observations(case, suite_dir, ctx):
    return [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case')
            for e in RUN.resolve_evidence_raw(case, suite_dir, ctx.redact, literal_epub=True)]


def typed(observations):
    """What the v3.1 checker reads (evidence_v31.shown_observations' typing): excerpt -> reading, legacy heads withheld."""
    return [EV31.without_legacy_heads(EV31.internal(o)) for o in observations]


# ---------------------------------------------------------------------------------------------------------------- body evidence (A32-3)
def _nonblank(v):
    return isinstance(v, str) and v.strip() != ''


def body_evidence_of(data):
    """-> 'text' | 'available' | None for one epub_inspect payload (tools v3).  Key presence alone is never evidence."""
    if not isinstance(data, dict):
        return None
    ex = data.get('excerpt')
    if isinstance(ex, dict) and _nonblank(ex.get('text')):
        return 'text'
    body = data.get('body')
    if not isinstance(body, dict):
        return None
    index = body.get('index') if isinstance(body.get('index'), list) else []
    excerpts = body.get('excerpts') if isinstance(body.get('excerpts'), list) else []
    if any(isinstance(e, dict) and _nonblank(e.get('text')) for e in excerpts):
        return 'text'
    if any(isinstance(it, dict) and isinstance(it.get('headings'), list) and any(isinstance(h, dict) and _nonblank(h.get('text')) for h in it['headings'])
           for it in index):
        return 'text'
    if any(isinstance(it, dict) and not it.get('navigation_document') and isinstance(it.get('characters'), int) and not isinstance(it.get('characters'), bool)
           and it['characters'] > 0 for it in index):
        return 'available'
    return None


def body_evidence(observations):
    """The strongest body evidence among ok epub_inspect observations: 'text' > 'available' > None."""
    best = None
    for o in observations:
        if o.get('tool') == 'epub_inspect' and o.get('status') == 'ok':
            data, _n = EV2.unwrap(o)
            ev = body_evidence_of(data)
            if ev == 'text':
                return 'text'
            best = best or ev
    return best


def _body_view(obs):
    data, _n = EV2.unwrap(obs)
    data = data if isinstance(data, dict) else {}
    return EV2.canon({'body': data.get('body'), 'declared_toc': data.get('declared_toc')})


# ---------------------------------------------------------------------------------------------------------------- exploration
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
        """passability-1's serve, except for epub_inspect: it is "already shown" only when a case-evidence result of the same call has the same body view."""
        key = (tool, B.norm_args(args))
        if key in self.served or key in [u[0] for u in self.unserved]:
            return
        same_call = [o for o in self.base if LK._call_matches(o, tool, args)]
        if same_call and tool != 'epub_inspect':
            return                  # already shown as case evidence (passability-1)
        res = T.call_tool(self.ctx, tool, args)
        if res['status'] == 'unavailable':
            self.unserved.append((key, 'unavailable'))
            return
        oid = 'x%d' % (len(self.order) + 1)
        obs = EV2.make_observation(oid, tool, EV2.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool',
                                   bool(res.get('collector_truncated')))
        if same_call and any(_body_view(o) == _body_view(obs) for o in same_call):
            return                  # the same inspection, body view included: already shown
        self.served[key] = obs
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


FREE_TEXT = ('free-text identity: EPUB body evidence (delivered text or positively evidenced excerpt availability) is among the observations, and the v3.1 '
             'checker reads no body text (C32-4); judged, not computed')


def check(explorer, observations):
    """The frozen checker over the v3.1-typed observations, with change (5)."""
    res = PQ.check(typed(observations), explorer.view['context'], explorer.view['media_type'], explorer.caps)
    if body_evidence(observations):
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


# ---------------------------------------------------------------------------------------------------------------- fidelity (change 4)
META_KEYS = ('kinds', 'report')


def _reference(observations, view, caps):
    return EV31.render(observations, view['context'], view['media_type'], view['tools_available'], caps, budget=STATE['budget'], shadow=False)['reference']


def source_rendering(record, case, suite_dir):
    """-> (facts {id: set}, metadata {id: {'kinds': ..., 'report': ...}}, the v3.1 analysis, case-evidence ids), each observation rendered as the session
    rendered it (the case evidence alone for the first message; the evidence plus the results up to it for a result)."""
    view = P.case_view(case, [])
    caps = (record.get('evidence_format') or {}).get('capabilities') or []
    obs = shown_observations(record, case, suite_dir)
    base = [o for o in obs if o.get('source') == 'case']
    ids = {o['id'] for o in base}
    facts, meta = {}, {}

    def take(ref, want_ids):
        for t in FX.facts_from_body(ref):
            if t[0] in want_ids and t[7] in B.SECTIONS:
                facts.setdefault(t[0], set()).add(EV2.canon(list(t)))
        for key in META_KEYS:
            for oid, v in (ref.get(key) or {}).items():
                if oid in want_ids and v is not None:
                    meta.setdefault(oid, {})[key] = v
    take(_reference(base, view, caps), ids)
    prefix = list(base)
    for o in obs:
        if o.get('source') == 'case':
            continue
        prefix.append(o)
        take(_reference(prefix, view, caps), {o['id']})
    return facts, meta, EV31.analyze(obs, view['context'], view['media_type']), ids


def source_facts(record, case, suite_dir):
    facts, _meta, an, ids = source_rendering(record, case, suite_dir)
    return facts, an, ids


def delivered_meta(bodies):
    """-> {observation id: {'kinds': ..., 'report': ...}} as delivered: the first message's per-id maps, a result body's own keys (pages reassembled)."""
    out = {}
    for source, body in bodies:
        if source == 'evidence':
            for key in META_KEYS:
                vals = body.get(key)
                if isinstance(vals, dict):
                    for oid, v in vals.items():
                        if v is not None:
                            out.setdefault(oid, {})[key] = v
        else:
            oid = body.get('id') or source
            for key in META_KEYS:
                if body.get(key) is not None:
                    out.setdefault(oid, {})[key] = body[key]
    return out


base_fidelity = B.fidelity


def fidelity(record, rows, case, suite_dir):
    """passability-1's fidelity over the v3.1 source rendering, plus the metadata of every deciding observation (A32-1)."""
    res = base_fidelity(record, rows, case, suite_dir)
    _frame, srcs, bodies = B.delivered(record)
    got = delivered_meta(bodies)
    _facts, want, _an, base_ids = source_rendering(record, case, suite_dir)

    def unfetched(oid):
        s = srcs.get('evidence' if oid in base_ids else oid)
        return s is None or len(s['pages']) < s['of']
    deciding = {}
    for r in rows:
        if r['state'] != PQ.MET:
            continue
        for ref in r.get('refs') or []:
            m = B.OBS_REF.match(str(ref))
            if m:
                deciding.setdefault(m.group(1), r['id'])
    issues = []
    for oid in sorted(deciding):
        w, g = want.get(oid) or {}, got.get(oid) or {}
        diff = sorted(k for k in META_KEYS if EV2.canon(w.get(k)) != EV2.canon(g.get(k)))
        if diff:
            issues.append({'prerequisite': deciding[oid], 'ref': oid, 'why': 'the %s of %s not delivered as its source states it (statement kinds, provenance, report '
                           'method)' % (' and '.join(diff), oid), 'fields': diff, 'unfetched': unfetched(oid)})
    res = dict(res, issues=res['issues'] + issues, metadata_checked=sorted(deciding))
    res['ok'] = not res['issues']
    res['unfetched'] = any(i['unfetched'] for i in res['issues'])
    return res


# ---------------------------------------------------------------------------------------------------------------- classification (change 6)
base_classify = B.classify


def served_body_evidence(case, suite_dir):
    """Body evidence of the case's tools-v3 `epub_inspect {}` (offered and advertised), served by the unchanged replay tools; None when not offered."""
    if 'epub_inspect' not in (case.get('tools_available') or []):
        return None
    ctx = v31_context(case, suite_dir)
    cap = {c.get('tool'): c for c in T.capabilities(ctx) if isinstance(c, dict)}.get('epub_inspect')
    if cap is not None and cap.get('available') is False:
        return None
    res = T.call_tool(ctx, 'epub_inspect', {})
    if res['status'] != 'ok':
        return None
    obs = EV2.make_observation('x0', 'epub_inspect', {}, res['status'], res.get('raw_output', res['output']), res.get('mode'), 'tool')
    return body_evidence([obs])


def classify(case, rec, rec_restored, fact, fact_restored, suite_dir, tension=None):
    row = base_classify(case, rec, rec_restored, fact, fact_restored, suite_dir, tension)
    if row is None or row['category'] not in BODY_RULE_CATEGORIES:
        return row
    sensitive = [c for c in row['label']['accepted_classes'] if c in IDENTITY_SENSITIVE]
    shown = body_evidence(shown_observations(rec, case, suite_dir))
    served = served_body_evidence(case, suite_dir)
    row['body_evidence'] = {'shown': shown, 'served_by_epub_inspect': served}
    if sensitive and (shown or served):
        row.update(computed_category=row['category'], category='undetermined (hand judgement)',
                   basis='depends on body or excerpt identity outside checker coverage (label class %s; body evidence shown: %s, served: %s); computed: %s (%s)' % (
                       '/'.join(sensitive), shown or 'none', served or 'none', row['category'], row.get('basis')))
    return row


# install the v3.1 pieces into the independent instance (every other function of passability-1 is used as it is)
B.POLICY_VERSION, B.POLICY = POLICY_VERSION, POLICY
B.Explorer, B.check, B.pages_cost, B.shown_observations, B.source_facts, B.fidelity = Explorer, check, pages_cost, shown_observations, source_facts, fidelity
B.classify = classify
witness, load_records = B.witness, B.load_records


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
