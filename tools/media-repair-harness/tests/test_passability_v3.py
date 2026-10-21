"""passability-3 (dev-c7 Amendment 1; AUDIT-ASTRA-32 items 1 to 3): scripts/passability_v3.py.  Each regression is PAIRED: the same check is run on
passability-3 (it holds) and on passability-2, the analysis registered at 5f71b6d3 (it fails there).  Plus every category reachable, isolation, and the control
replay of the dev-c6 gpt-6-astra decisions under C7.  Scripted replies and replay fixtures only; no model, no network."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import test_devc7 as D7
import test_passability as T1
import th
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import protocol as P
from media_repair_harness import run as R


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, th.COMPONENT / 'scripts' / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


P3 = _load('mrh_passability_v3', 'passability_v3.py')
P2 = _load('mrh_passability_v2_at_5f71b6d3', 'passability_v2.py')          # the analysis registered at 5f71b6d3, unchanged
SCORE = T1.SCORE
d3, labelled, PROBE, DAMAGE, BINDING = T1.d3, T1.labelled, T1.PROBE, T1.DAMAGE, T1.BINDING
REPORT = {'id': 'e1', 'tool': 'prior_record', 'args': {}, 'status': 'ok',
          'output': json.dumps({'evidence_method': 'reported embedded subtitle opening cards', 'observed': {'content_titles': ['Totally Different Work']}})}


def scripted(case, ts, replies, **kw):
    rec, _ad = ev2h.scripted_run(case, ts, [json.dumps(r) if isinstance(r, dict) else r for r in replies], prompt='v7', evidence_format='v3.1-format',
                                 guards='v3', which=th.NO_BINARIES, **kw)
    return rec


def classify(mod, case, ts, rec, restored=True):
    shown = R.resolve_evidence_raw(case, ts.root)
    rec_r = DG.restore_original(rec, case, shown) if (rec.get('guard') or {}).get('final_changed') and restored else rec
    return mod.classify(case, rec, rec_r, SCORE.case_facts(case, rec), SCORE.case_facts(case, rec_r), ts.root)


def first_message_edit(fn):
    def t(rec):
        for turn in rec['turns']:
            msgs = (turn.get('raw_request') or {}).get('messages')
            if msgs:
                body = json.loads(msgs[0]['content'])
                fn(body['evidence'])
                msgs[0] = dict(msgs[0], content=json.dumps(body, separators=(',', ':')))
        return rec
    return t


class Paired(unittest.TestCase):
    """Run a check on passability-3 (must hold) and on passability-2 at 5f71b6d3 (must fail)."""

    def paired(self, check):
        check(P3)
        with self.assertRaises(AssertionError):
            check(P2)


class A32Item1FidelityMetadata(Paired):
    """AUDIT-ASTRA-32 item 1: fidelity covers the deciding observation's statement kinds, provenance and report-method metadata."""

    def setUp(self):
        self.case = labelled('p3-101', 'identity_mismatch', ['escalate'], [REPORT, BINDING], tools=())
        self.ts = L.suite_with(self.case)
        self.rec = scripted(self.case, self.ts, [d3('insufficient_evidence', 'escalate', ['e1'])])

    def tearDown(self):
        self.ts.cleanup()

    def test_the_untampered_transcript_is_a_model_error_on_both(self):
        first = json.loads(self.rec['turns'][0]['raw_request']['messages'][0]['content'])['evidence']
        self.assertEqual(first['kinds']['e1'], {'provenance': 'reported', 'fields': {'observed': 'report_content'}})
        for mod in (P3, P2):
            row = classify(mod, self.case, self.ts, self.rec)
            self.assertEqual(row['category'], 'model error', mod.POLICY_VERSION)
        self.assertEqual(classify(P3, self.case, self.ts, self.rec)['fidelity']['metadata_checked'], ['e1'])

    def test_deleted_kinds_and_report_are_a_presentation_problem(self):
        rec = first_message_edit(lambda ev: (ev.pop('kinds'), ev.pop('report')))(copy.deepcopy(self.rec))

        def check(mod):
            row = classify(mod, self.case, self.ts, rec)
            self.assertEqual(row['category'], 'presentation problem')
            self.assertEqual(row['fidelity']['issues'][0]['fields'], ['kinds', 'report'])
        self.paired(check)

    def test_reported_content_turned_declaration_and_a_changed_method_are_a_presentation_problem(self):
        def edit(ev):
            ev['kinds']['e1']['fields']['observed'] = 'report_declaration'
            ev['report']['e1']['method'] = 'EPUB OPF'
        rec = first_message_edit(edit)(copy.deepcopy(self.rec))
        self.paired(lambda mod: self.assertEqual(classify(mod, self.case, self.ts, rec)['category'], 'presentation problem'))

    def test_metadata_on_a_page_that_was_not_fetched_is_not_obtained(self):
        def edit(ev):                          # the metadata sits on page 2 of 2, which the model never fetched
            ev.pop('kinds')
            ev.pop('report')
            ev['page'] = {'n': 1, 'of': 2, 'next': 'zz'}
        rec = first_message_edit(edit)(copy.deepcopy(self.rec))
        self.paired(lambda mod: self.assertEqual(classify(mod, self.case, self.ts, rec)['category'], 'not obtained (unfetched page)'))

    def test_a_tool_result_s_deleted_kinds_fail_fidelity(self):
        """The metadata of a deciding tool RESULT (an epub_inspect result's kinds) is checked the same way."""
        d = tempfile.mkdtemp(prefix='mrh-w23-p3-')
        case = D7.book_case(d, items=[('a.xhtml', D7.xhtml('<h1>Alpha Book</h1><p>%s</p>' % ('lorem ' * 50)))], cid='p3-102')
        case['truth'] = {'class': 'healthy', 'source': 'construction', 'ref': 'zq'}
        case['supported_actions'] = ['none']
        ts = th.TempSuite([case])
        rec = scripted(case, ts, [ev2h.tc('epub_inspect'), d3('insufficient_evidence', 'escalate', ['t1'])])
        self.assertIn('kinds', P3.delivered_meta(P3.B.delivered(rec)[2]).get('t1') or {})

        def drop_result_kinds(r):
            for turn in r['turns']:
                msgs = (turn.get('raw_request') or {}).get('messages') or []
                for i, m in enumerate(msgs):
                    head, sep, tail = m['content'].partition('\n')
                    try:
                        obj = json.loads(head)
                    except ValueError:
                        continue
                    if m['role'] == 'user' and isinstance(obj, dict) and obj.get('type') == 'tool_result':
                        obj['output'].pop('kinds', None)
                        msgs[i] = dict(m, content=json.dumps(obj, separators=(',', ':')) + sep + tail)
            return r
        bad = drop_result_kinds(copy.deepcopy(rec))

        def check(mod):
            fid = classify(mod, case, ts, bad)['fidelity']
            self.assertFalse(fid['ok'])
            self.assertEqual([(i['ref'], i.get('fields')) for i in fid['issues']], [('t1', ['kinds'])])
        self.paired(check)
        self.assertTrue(classify(P3, case, ts, rec)['fidelity']['ok'])          # untampered: delivered as the source states it
        ts.cleanup()


class A32Item2BodyIdentity(Paired):
    """AUDIT-ASTRA-32 item 2: a passability verdict that depends on body or excerpt identity the checker does not read is undetermined, healthy and naming
    labels included; the scorer's and the audit's verdicts stay in their own fields."""

    def book(self, body_html, truth='healthy', supported=('none',), cid='p3-201'):
        d = tempfile.mkdtemp(prefix='mrh-w23-p3-')
        case = D7.book_case(d, items=[('a.xhtml', D7.xhtml(body_html))], cid=cid)
        case['truth'] = {'class': truth, 'source': 'construction', 'ref': 'zq'}
        case['supported_actions'] = list(supported)
        return case, th.TempSuite([case])

    def test_a_collected_other_book_title_page_under_a_healthy_label_is_undetermined(self):
        case, ts = self.book('<h1>Other Book</h1><p>%s</p>' % ('lorem ' * 120))
        rec = scripted(case, ts, [ev2h.tc('epub_inspect'), d3('insufficient_evidence', 'escalate', ['t1'])])

        def check(mod):
            row = classify(mod, case, ts, rec)
            self.assertEqual(row['category'], 'undetermined (hand judgement)')
            self.assertEqual(row['computed_category'], 'model error')
            self.assertEqual(row['body_evidence'], {'shown': 'text', 'served_by_epub_inspect': 'text'})
            self.assertEqual(row['scorer']['guarded'], {'correct': False, 'unsafe_write': False})      # kept as score.py says
        self.paired(check)
        ts.cleanup()

    def test_body_evidence_that_is_only_served_also_counts_and_a_body_less_book_does_not(self):
        case, ts = self.book('<h1>Other Book</h1><p>%s</p>' % ('lorem ' * 120), cid='p3-202')
        rec = scripted(case, ts, [d3('insufficient_evidence', 'escalate', [])])      # the model never looked
        row = classify(P3, case, ts, rec)
        if row['category'] != 'undetermined (hand judgement)' or row.get('body_evidence') is None:
            self.fail(row)
        self.assertEqual(row['body_evidence']['served_by_epub_inspect'], 'text')
        ts.cleanup()
        case, ts = self.book('', cid='p3-203')                                  # no body text at all: nothing to judge, the computed category stands
        rec = scripted(case, ts, [ev2h.tc('epub_inspect'), d3('insufficient_evidence', 'escalate', ['t1'])])
        row = classify(P3, case, ts, rec)
        self.assertEqual(row['category'], 'model error', row)
        self.assertEqual(row['body_evidence'], {'shown': None, 'served_by_epub_inspect': None})
        ts.cleanup()

    def test_an_integrity_label_does_not_depend_on_body_identity(self):
        row, _ = T1.run_and_classify(labelled('p3-204', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])])
        self.assertEqual(row['category'], 'model error')              # passability-1 control on a non-EPUB case
        case = labelled('p3-205', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        ts = L.suite_with(case)
        rec = scripted(case, ts, [d3('corrupt_file', 'escalate', ['e2'])])
        self.assertEqual(classify(P3, case, ts, rec)['category'], 'model error')
        ts.cleanup()


def epub_evidence(body, oid='e1'):
    out = {'status': 'ok', 'spine_items': 1, 'title': 'Alpha Book', 'creator': 'A. Writer', 'opf': {'title': 'Alpha Book'}}
    if body != 'ABSENT':
        out['body'] = body
    return {'id': oid, 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(out)}


class A32Item3PresenceIsNotText(Paired):
    """AUDIT-ASTRA-32 item 3: delivered nonempty text, positively evidenced excerpt availability and absent / null / empty text are three different things."""

    def identity_case(self, body, cid):
        case = ev2h.case_with([epub_evidence(body)], tools=(), cid=cid, media='epub')
        case['context'].update(title='Alpha Book', filename='Alpha Book.epub', expected={'title': 'Alpha Book', 'author': 'A. Writer'})
        case['truth'] = {'class': 'identity_mismatch', 'source': 'construction', 'ref': 'zq'}
        case['supported_actions'] = ['escalate']
        return case

    def test_null_empty_or_blank_body_keys_leave_an_identity_evidence_gap(self):
        empties = [None, {}, {'index': [], 'excerpts': []}, {'index': [{'spine': 0, 'member': 'a', 'characters': 0, 'headings': [{'text': ' '}]}],
                                                              'excerpts': [{'text': '', 'spine': 0}]}]
        for i, body in enumerate(empties):
            case = self.identity_case(body, 'p3-30%d' % i)
            ts = th.TempSuite([case])
            rec = scripted(case, ts, [d3('insufficient_evidence', 'escalate', ['e1'])])
            self.paired(lambda mod: self.assertEqual(classify(mod, case, ts, rec)['category'], 'evidence gap', body))
            ts.cleanup()

    def test_the_three_states(self):
        self.assertEqual(P3.body_evidence_of({'excerpt': {'text': 'words'}}), 'text')
        self.assertEqual(P3.body_evidence_of({'body': {'index': [{'characters': 9, 'headings': []}], 'excerpts': []}}), 'available')
        self.assertIsNone(P3.body_evidence_of({'body': {'index': [{'characters': 9, 'navigation_document': True, 'headings': []}]}}))
        for empty in ({'excerpt': {'text': '   '}}, {'excerpt': None}, {'body': None}, {'body': []}, {'body': {}}, {'body': {'index': None, 'excerpts': None}},
                      {'body': {'index': [{'characters': True}]}}, {}):
            self.assertIsNone(P3.body_evidence_of(empty), empty)
        case = self.identity_case({'index': [{'spine': 0, 'member': 'a', 'characters': 400, 'headings': []}], 'excerpts': []}, 'p3-310')
        ts = th.TempSuite([case])
        rec = scripted(case, ts, [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(classify(P3, case, ts, rec)['category'], 'undetermined (hand judgement)')     # positively evidenced availability counts
        ts.cleanup()

    def test_a_recorded_null_body_does_not_suppress_a_real_tools_v3_inspection(self):
        d = tempfile.mkdtemp(prefix='mrh-w23-p3-')
        case = D7.book_case(d, evidence=[epub_evidence(None)], cid='p3-320')

        def check(mod):
            ex = mod.Explorer(case, d)
            ex.serve('epub_inspect', {})
            self.assertEqual([k[0] for k in ex.order], ['epub_inspect'])
            self.assertEqual(P3.body_evidence([ex.served[ex.order[0]]]), 'text')
        self.paired(check)
        ex = P3.Explorer(case, d)                                          # control: a base that already carries the same body view is already shown
        ex.serve('epub_inspect', {})
        served = ex.served[ex.order[0]]
        ex2 = P3.Explorer(case, d)
        ex2.base = [dict(served, id='e1', source='case')]
        ex2.serve('epub_inspect', {})
        self.assertEqual(ex2.order, [])


class EveryCategoryAndIsolation(unittest.TestCase):
    def test_policy_isolation_and_constants(self):
        self.assertEqual((P3.POLICY_VERSION, P3.POLICY['base_policy'], P3.POLICY['supersedes']), ('passability-3', 'passability-1', 'passability-2'))
        self.assertEqual((T1.PS.POLICY_VERSION, P2.POLICY_VERSION), ('passability-1', 'passability-2'))
        self.assertIsNot(P3.B, T1.PS)
        self.assertIsNot(P3.B, P2.B)
        self.assertIs(P3.B.classify, P3.classify)
        self.assertEqual((P3.B.MAX_CALLS, P3.B.MAX_EVALUATIONS, P3.B.MAX_ROUNDS), (6, 5000, 3))

    def run_row(self, case, replies, **kw):
        ts = L.suite_with(case)
        budget = kw.pop('budget', None)
        if budget:
            kw['tool_output_bytes'] = budget
        rec = scripted(case, ts, replies, **kw)
        old = P3.STATE['budget']
        P3.STATE['budget'] = budget or EV2.WIRE_BYTES
        try:
            return classify(P3, case, ts, rec), rec
        finally:
            P3.STATE['budget'] = old
            ts.cleanup()

    def test_every_category_is_reachable(self):
        cat = lambda case, replies, **kw: self.run_row(case, replies, **kw)[0]['category']      # noqa: E731
        self.assertEqual(cat(labelled('p3-001', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])]), 'model error')
        self.assertEqual(cat(labelled('p3-002', 'corrupt_file', ['blocklist_and_search'], [T1.PAGED_PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])],
                             budget=4096), 'not obtained (unfetched page)')
        self.assertEqual(cat(labelled('p3-004', 'corrupt_file', ['blocklist_and_search'], [PROBE, BINDING]), [d3('insufficient_evidence', 'escalate', ['e1'])]),
                         'obtainable, not obtained')
        decl = {'id': 'e1', 'tool': 'prior_record', 'args': {}, 'status': 'ok', 'output': json.dumps({'evidence_method': 'container tags', 'observed': {'title': 'Another Show'}})}
        self.assertEqual(cat(labelled('p3-005', 'identity_mismatch', ['blocklist_and_search'], [decl, BINDING], tools=()), [d3('insufficient_evidence', 'escalate', ['e1'])]),
                         'evidence gap')
        untagged = dict(PROBE, output=json.dumps(dict(L.PROBE_REC, format={k: v for k, v in L.PROBE_REC['format'].items() if k != 'tags'})))
        self.assertEqual(cat(labelled('p3-006', 'healthy', ['none'], [untagged, {'id': 'e2', 'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok',
                                                                              'output': json.dumps(dict(L.DEC_CLEAN, ss=0))}], tools=(), question='Does the last scene play?'),
                             [d3('insufficient_evidence', 'escalate', ['e1'])]), 'undetermined (hand judgement)')
        self.assertEqual(cat(labelled('p3-007', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), ['not json', 'still not json']), 'non-model failure')
        arr_only = {'id': 'e1', 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(T1.ARR)}
        self.assertEqual(cat(labelled('p3-008', 'healthy', ['none'], [arr_only], tools=()), [d3('healthy', 'none', ['e1'])]), 'guard change')
        self.assertEqual(cat(labelled('p3-009', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]),
                             [d3('corrupt_file', 'blocklist_and_search', ['e2'], source='e2', target={'kind': 'release_of_source', 'source_ref': 'e2'})]),
                         'score-correct write with unmet or unknown prerequisites')
        row, _ = self.run_row(labelled('p3-010', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])])
        self.assertEqual(row['category'], 'model error')
        tampered = T1.strip_ids('e2.f1', 'e2')
        case = labelled('p3-011', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        ts = L.suite_with(case)
        rec = tampered(copy.deepcopy(scripted(case, ts, [d3('corrupt_file', 'escalate', ['e2'])])))
        self.assertEqual(classify(P3, case, ts, rec)['category'], 'presentation problem')
        ts.cleanup()

    def test_report_refuses_a_run_that_is_not_v31_format(self):
        d = Path(tempfile.mkdtemp())
        (d / 'manifest.json').write_text(json.dumps({'config': {'evidence_format': 'v3', 'wire_bytes': 8192}}))
        with self.assertRaises(SystemExit):
            P3.report(d, d, str(d))


def available_here(src_dir, suite):
    """Case ids whose fixture resolves in this checkout as it did on the pod that made the dev-c6 run (test_devc7_replay's rule): the 4 pod-local EPUB
    fixtures outside git are unavailable coverage on a CI checkout, where the tools-v3 inspection legitimately differs, and are left out of the comparison."""
    from media_repair_harness import tools as T
    ok = set()
    cases = {c['id']: c for c, _ in R.load_cases(str(suite))}
    for p in sorted(Path(src_dir).glob('*-*-[0-9]*.json')):
        rec = json.loads(p.read_text())
        if T.Fixture.from_case(cases[rec['case_id']], R.suite_root(str(suite))).verify_local() == rec['fixture']:
            ok.add(rec['case_id'])
    return ok


@th.needs_suite
class Control(unittest.TestCase):
    """The scripted (no model) C7 replay of the dev-c6 gpt-6-astra decisions: passability-3 gives every row passability-1's dev-c6 category except the rows
    the body-identity rule (change 6) makes undetermined, which are listed here with their computed category."""

    BODY_RULE_CHANGES = {'epub-naming-001': 'evidence gap'}       # metadata_naming label; body text shown and served by epub_inspect {}

    def test_the_dev_c6_astra_decisions_get_the_same_categories_except_the_listed_body_rule_rows(self):
        suite = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
        src = th.COMPONENT / 'runs' / 'dev-c6' / 'devc6-gpt-6-astra'
        plans = {}
        for p in sorted(src.glob('*-*-[0-9]*.json')):
            r = json.loads(p.read_text())
            g = r.get('guard') or {}
            dec = g['applied'][0]['original'] if g.get('applied') else r['decision']
            calls = [json.dumps({'type': 'tool_call', 'tool': c['tool'], 'why': 'w', 'args': c.get('args') or {}}) for c in r.get('tool_calls') or []
                     if not c.get('continuation') and c.get('tool') in P.TOOLS]
            plans[r['case_id']] = calls + [json.dumps(dict(dec, type='decision'))]

        class Dispatch(A.ScriptedAdapter):
            def __init__(self):
                super().__init__('scripted-replay', [])
                self.queue = sorted(plans)

            def before_case(self):
                cid = self.queue.pop(0)
                self.replies = list(plans[cid]) + [plans[cid][-1]] * 3
        root = Path(tempfile.mkdtemp(prefix='mrh-w23-ctl3-'))
        orig = R.build_adapter
        R.build_adapter = lambda args: Dispatch()
        try:
            code = R.main(['--suite', str(suite), '--adapter', 'scripted', '--model', 'scripted-replay', '--split', 'dev', '--prompt', 'v7', '--evidence-format',
                           'v3.1-format', '--guards', 'v3', '--evidence', 'replay', '--no-spend-limit', '--out', str(root / 'run'), '--scratch', str(root / 'scratch')])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 0)
        from media_repair_harness import guard_cli
        guard_cli.guard_run(root / 'run', str(suite), root / 'restored', restore=True)
        out = P3.report(root / 'run', root / 'restored', str(suite))
        here = available_here(src, suite)
        self.assertGreaterEqual(len(here), 69)                          # at most the 4 pod-local fixture cases are unavailable here
        want = {r['case']: r['category'] for r in json.loads((th.COMPONENT / 'runs' / 'dev-c6' / 'passability.json').read_text())['rows'] if r['case'] in here}
        got = {r['case']: r['category'] for r in out['rows'] if r['case'] in here}
        changed = {c: want[c] for c in want if got.get(c) != want[c]}
        self.assertEqual(set(got), set(want))
        self.assertEqual(changed, {c: v for c, v in self.BODY_RULE_CHANGES.items() if c in here})
        rows = {r['case']: r for r in out['rows']}
        for c, computed in self.BODY_RULE_CHANGES.items():
            self.assertEqual((rows[c]['category'], rows[c]['computed_category']), ('undetermined (hand judgement)', computed))
        self.assertEqual(out['policy']['version'], 'passability-3')


if __name__ == '__main__':
    unittest.main()
