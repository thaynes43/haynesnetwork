"""passability-2 (dev-c7, WO-W23): the frozen passability-1 analysis applied to format v3.1-format runs (scripts/passability_v2.py).  passability-1 itself is
loaded unchanged and never modified; passability-2 replaces exactly five pieces in an independent instance.  These tests show (a) isolation, (b) every
category is still reachable under v3.1-format, (c) each v3.1 change, and (d) the control: a scripted (no model) C7 replay of the dev-c6 gpt-6-astra decisions
gets, row by row, the categories passability-1 computed for that run.  Scripted replies and replay fixtures only; no model, no network."""
import copy
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import test_devc7 as D7
import test_passability as T1
import th
from ev2h import tc
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import evidence_v31 as EV31
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T
from media_repair_harness.experimental.contract_v3 import prereq as PQ

SPEC = importlib.util.spec_from_file_location('mrh_passability_v2', th.COMPONENT / 'scripts' / 'passability_v2.py')
P2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P2)
SCORE = T1.SCORE
PASSABILITY_1_SHA256 = '253e4d4c86cf603c9b128d05f01a6b021ac9329838c68549468b137fc3ab330e'     # dev-c6 Amendment 2, frozen
d3, labelled, PROBE, DAMAGE, BINDING, ARR, BLOCK = T1.d3, T1.labelled, T1.PROBE, T1.DAMAGE, T1.BINDING, T1.ARR, T1.BLOCK


def run_and_classify(case, replies, tension=None, tamper=None, restored=True, budget=None, **kw):
    ts = L.suite_with(case)
    if budget:
        kw['tool_output_bytes'] = budget
    rec, _ad = ev2h.scripted_run(case, ts, replies, prompt='v7', evidence_format='v3.1-format', guards='v3', which=th.NO_BINARIES, **kw)
    if tamper:
        rec = tamper(copy.deepcopy(rec))
    shown = R.resolve_evidence_raw(case, ts.root)
    rec_r = DG.restore_original(rec, case, shown) if (rec.get('guard') or {}).get('final_changed') and restored else rec
    old = P2.STATE['budget']
    P2.STATE['budget'] = budget or EV2.WIRE_BYTES
    try:
        row = P2.classify(case, rec, rec_r, SCORE.case_facts(case, rec), SCORE.case_facts(case, rec_r), ts.root, tension)
    finally:
        P2.STATE['budget'] = old
    ts.cleanup()
    return row, rec


class Isolation(unittest.TestCase):
    def test_passability_1_is_loaded_unchanged_and_never_modified(self):
        self.assertEqual(hashlib.sha256((th.COMPONENT / 'scripts' / 'passability.py').read_bytes()).hexdigest(), PASSABILITY_1_SHA256)
        self.assertIsNot(P2.B, T1.PS)
        self.assertEqual((T1.PS.POLICY_VERSION, T1.PS.POLICY['version']), ('passability-1', 'passability-1'))
        self.assertIsNot(T1.PS.check, P2.check)
        self.assertIsNot(T1.PS.Explorer, P2.Explorer)
        self.assertIs(T1.PS.source_facts.__module__, T1.PS.__name__)
        self.assertEqual((P2.POLICY_VERSION, P2.POLICY['version'], P2.POLICY['base_policy']), ('passability-2', 'passability-2', 'passability-1'))
        self.assertEqual((P2.B.MAX_CALLS, P2.B.MAX_EVALUATIONS, P2.B.MAX_ROUNDS), (6, 5000, 3))
        self.assertIs(P2.B.check, P2.check)
        self.assertIs(P2.B.source_facts, P2.source_facts)

    def test_report_refuses_a_run_that_is_not_v31_format(self):
        d = Path(tempfile.mkdtemp())
        (d / 'manifest.json').write_text(json.dumps({'config': {'evidence_format': 'v3', 'wire_bytes': 8192}}))
        with self.assertRaises(SystemExit):
            P2.report(d, d, str(d))


class EveryCategoryIsReachableUnderV31(unittest.TestCase):
    def test_model_error(self):
        row, _ = run_and_classify(labelled('p2-001', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])])
        self.assertEqual(row['category'], 'model error', row)
        self.assertTrue(row['fidelity']['ok'])

    def test_presentation_problem(self):
        row, _ = run_and_classify(labelled('p2-002', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), [d3('corrupt_file', 'escalate', ['e2'])],
                                  tamper=T1.strip_ids('e2.f1', 'e2'))
        self.assertEqual(row['category'], 'presentation problem', row)

    def test_not_obtained_unfetched_page_counts_pages_at_the_run_budget(self):
        row, rec = run_and_classify(labelled('p2-003', 'corrupt_file', ['blocklist_and_search'], [T1.PAGED_PROBE, DAMAGE, BINDING]),
                                    [d3('corrupt_file', 'escalate', ['e2'])], budget=4096)
        self.assertGreaterEqual(json.loads(rec['turns'][0]['raw_request']['messages'][0]['content'])['evidence']['page']['of'], 5)
        self.assertEqual(row['category'], 'not obtained (unfetched page)', row.get('fidelity'))

    def test_obtainable_not_obtained(self):
        row, _ = run_and_classify(labelled('p2-004', 'corrupt_file', ['blocklist_and_search'], [PROBE, BINDING]), [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'obtainable, not obtained', row)
        self.assertIn({'tool': 'decode_sample', 'args': {'at': 4}}, row['witness']['calls'])

    def test_evidence_gap(self):
        decl = {'id': 'e1', 'tool': 'prior_record', 'args': {}, 'status': 'ok',
                'output': json.dumps({'evidence_method': 'container tags', 'observed': {'title': 'Another Show'}})}
        row, _ = run_and_classify(labelled('p2-005', 'identity_mismatch', ['blocklist_and_search'], [decl, BINDING], tools=()), [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'evidence gap', row)

    def test_undetermined(self):
        untagged = dict(PROBE, output=json.dumps(dict(L.PROBE_REC, format={k: v for k, v in L.PROBE_REC['format'].items() if k != 'tags'})))
        case = labelled('p2-006', 'healthy', ['none'], [untagged, {'id': 'e2', 'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok',
                                                                   'output': json.dumps(dict(L.DEC_CLEAN, ss=0))}], tools=(), question='Does the last scene play?')
        row, _ = run_and_classify(case, [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'undetermined (hand judgement)', row)

    def test_non_model_failure_guard_change_and_score_correct_write(self):
        row, rec = run_and_classify(labelled('p2-007', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING]), ['not json', 'still not json'])
        self.assertEqual((rec['forced'], row['category']), (True, 'non-model failure'))
        arr_only = {'id': 'e1', 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(ARR)}
        row, rec = run_and_classify(labelled('p2-008', 'healthy', ['none'], [arr_only], tools=()), [d3('healthy', 'none', ['e1'])])
        self.assertEqual((rec['guard']['final_changed'], row['category']), (True, 'guard change'))
        case = labelled('p2-009', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, _ = run_and_classify(case, [d3('corrupt_file', 'blocklist_and_search', ['e2'], source='e2', target={'kind': 'release_of_source', 'source_ref': 'e2'})])
        self.assertEqual(row['category'], 'score-correct write with unmet or unknown prerequisites')
        self.assertIsNone(run_and_classify(case, [d3('corrupt_file', 'blocklist_and_search', ['e2'], source='e3', target=BLOCK)])[0])


class TheV31Changes(D7.Tmp):
    def obs(self, heading='Beta Volume', title='Alpha Book'):
        p = self.epub([('a.xhtml', D7.xhtml('<h1>%s</h1><p>words</p>' % heading))], name='p2' + str(abs(hash((title, heading)))), title=title)
        _r, o = self.call(p)
        ex = self.call(p, {'spine': 0})[1]
        return D7.ob('t1', 'epub_inspect', o, backend='local'), D7.ob('t2', 'epub_inspect', ex, backend='local'), p

    def test_the_checker_reads_excerpts_as_readings_and_never_the_legacy_heads(self):
        inspect, excerpt, _p = self.obs()
        typed = P2.typed([inspect, excerpt])
        self.assertIn('spine_heads', json.loads(inspect['output']))
        self.assertNotIn('spine_heads', json.loads(typed[0]['output']))
        self.assertEqual((typed[0]['tool'], typed[1]['tool']), ('epub_inspect', 'epub_text'))
        self.assertEqual(typed, [EV31.without_legacy_heads(EV31.internal(o)) for o in (inspect, excerpt)])     # the v3.1 audit's own typing

    def test_free_text_identity_is_unknown_once_body_text_is_shown_and_never_met(self):
        inspect, excerpt, _path = self.obs()

        class Ex:
            view = {'context': D7.CAT, 'media_type': 'epub'}
            caps = []
        ids = lambda res: {r['id']: r['state'] for r in res['diagnosis']['identity_mismatch']}      # noqa: E731
        with_body = P2.check(Ex, [inspect, excerpt])
        self.assertEqual(ids(with_body)['D-ID-1'], PQ.UNKNOWN)
        self.assertEqual(ids(P2.check(Ex, [inspect]))['D-ID-1'], PQ.UNKNOWN)
        raw = PQ.check(P2.typed([inspect, excerpt]), D7.CAT, 'epub', [])
        self.assertEqual({r['id']: r['state'] for r in raw['diagnosis']['identity_mismatch']}['D-ID-1'], PQ.UNMET)     # the frozen checker itself: unmet
        legacy = dict(json.loads(inspect['output']))
        legacy.pop('body', None)
        legacy.pop('declared_toc', None)
        no_body = D7.ob('t1', 'epub_inspect', legacy, backend='local')
        self.assertEqual(ids(P2.check(Ex, [no_body]))['D-ID-1'], PQ.UNMET)                  # no body text: unchanged
        for res in (with_body, P2.check(Ex, [no_body])):
            self.assertNotIn(PQ.MET, [r['state'] for r in res['diagnosis']['identity_mismatch']])

    def test_a_recorded_inspect_without_body_text_does_not_hide_the_tools_v3_call(self):
        case = D7.book_case(self.dir, evidence=[{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok',
                                                 'output': json.dumps({'status': 'ok', 'spine_items': 1, 'title': 'Alpha Book', 'spine_heads': ['Alpha Book']})}])
        ex = P2.Explorer(case, self.dir)
        ex.serve('epub_inspect', {})
        self.assertEqual([k[0] for k in ex.order], ['epub_inspect'])
        self.assertTrue(P2.has_body_text([ex.served[ex.order[0]]]))
        v1 = T1.PS.Explorer(case, self.dir)
        v1.serve('epub_inspect', {})
        self.assertEqual(v1.order, [])                     # passability-1: "already shown"
        ex2 = P2.Explorer(case, self.dir)
        ex2.base = [ex.served[ex.order[0]]]                # a base result that already carries body text: already shown, as in v1
        ex2.serve('epub_inspect', {})
        self.assertEqual(ex2.order, [])

    def test_the_page_cost_is_counted_by_the_v31_session_at_the_run_budget(self):
        big = [('c%02d.xhtml' % i, D7.xhtml('<h2>Part %d heading words here</h2><p>%s</p>' % (i, 'lorem ipsum dolor ' * 40))) for i in range(24)]
        case = D7.book_case(self.dir, items=big, cid='p2-big')
        ex = P2.Explorer(case, self.dir)
        ex.serve('epub_inspect', {})
        res = [ex.served[k] for k in ex.order]
        costs = {}
        for b in (8192, 4096, 2560):
            P2.STATE['budget'] = b
            costs[b] = P2.pages_cost(ex, res)
        P2.STATE['budget'] = EV2.WIRE_BYTES
        self.assertLess(costs[8192], costs[2560])
        self.assertLessEqual(costs[8192], costs[4096])
        self.assertGreaterEqual(costs[8192], 1)


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
    """A scripted (no model) C7 run that replays the dev-c6 gpt-6-astra run's recorded tool calls and its model decisions under v7 + v3.1-format: passability-2
    gives every row the category passability-1 gave the dev-c6 run (runs/dev-c6/passability.json)."""

    def test_the_dev_c6_astra_decisions_get_the_same_categories(self):
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
        root = Path(tempfile.mkdtemp(prefix='mrh-w23-ctl-'))
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
        out = P2.report(root / 'run', root / 'restored', str(suite))
        here = available_here(src, suite)
        want = {r['case']: r['category'] for r in json.loads((th.COMPONENT / 'runs' / 'dev-c6' / 'passability.json').read_text())['rows'] if r['case'] in here}
        got = {r['case']: r['category'] for r in out['rows'] if r['case'] in here}
        self.assertGreaterEqual(len(here), 69)                          # at most the 4 pod-local fixture cases are unavailable here
        self.assertEqual(got, want)
        self.assertEqual((out['policy']['version'], out['wire_bytes']), ('passability-2', 8192))
        epub_rows = [r for r in out['rows'] if r['case'].startswith('epub-') and 'witness' in r and r['case'] in here]
        self.assertTrue(epub_rows)
        self.assertTrue(any(r['witness']['pool'] >= 1 for r in epub_rows))          # the tools-v3 epub_inspect {} is served (body text), unlike passability-1


if __name__ == '__main__':
    unittest.main()
