import copy
import json
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import score_compat
import th

S = None   # the evaluator-owned score.py, loaded by explicit path (see score_compat)


def setUpModule():
    global S
    try:
        S = score_compat.load_score()
    except FileNotFoundError as e:
        if th.os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError('%s; MRH_REQUIRE_SUITE=1 forbids skipping' % e)
        raise th.unittest.SkipTest(str(e))


def build_cases():
    return [
        th.make_case('h1', 'healthy', ('none',)),
        th.make_case('h2', 'healthy', ('none',), media='tv'),
        th.make_case('c1', 'corrupt_file', ('blocklist_and_search', 'escalate'), media='movie',
                     outcome_step={'check': 'x', 'inputs': {}, 'expected': 'repaired'}),
        th.make_case('c2', 'corrupt_file', ('blocklist_and_search', 'escalate'), media='audiobook'),
        th.make_case('m1', 'identity_mismatch', ('blocklist_and_search', 'escalate')),
        th.make_case('m2', 'identity_mismatch', ('blocklist_and_search',), media='tv'),
        th.make_case('i1', 'insufficient_evidence', ('escalate',), solvable=False),
        th.make_case('j1', 'insufficient_evidence', ('escalate',), solvable=False, inject_tool_failure={'tool': 'ffprobe', 'mode': 'error'}),
    ]


GOOD = {'h1': ('healthy', 'none'), 'h2': ('healthy', 'none'), 'c1': ('corrupt_file', 'blocklist_and_search'),
        'c2': ('corrupt_file', 'blocklist_and_search'), 'm1': ('identity_mismatch', 'blocklist_and_search'),
        'm2': ('identity_mismatch', 'blocklist_and_search'), 'i1': ('insufficient_evidence', 'escalate'),
        'j1': ('insufficient_evidence', 'escalate')}


def record(case_id, cls, act, **kw):
    r = {'record_version': 1, 'case_id': case_id, 'case_sha256': 'abc', 'requested_model': 'm', 'response_model_ids': ['m'],
         'runtime_version': 'rt', 'model_digest': 'sha256:d', 'harness_git_sha': 'g', 'config_hash': 'c',
         'fixture': None, 'turns': [{'n': 1, 'raw_request': {'a': 1}, 'raw_response': 'x', 'wall_s': 1.0, 'usage': {}}],
         'tool_calls': [], 'repair_prompts': [], 'forced': False, 'first_try_valid': True, 'bad_evidence_refs': [], 'refs_to_failed_tools': [],
         'decision': {'type': 'decision', 'class': cls, 'action': act, 'target': None, 'confidence': 0.9, 'evidence_refs': [], 'reason': 'r'},
         'outcome': None, 'usage': {'input_tokens': 100, 'output_tokens': 20, 'cost_usd': 0.01},
         'wall': {'total_s': 5.0, 'load_s': 0.0, 'case_excl_load_s': 5.0}}
    if case_id == 'c1':
        r['outcome'] = {'check': 'x', 'expected': 'repaired', 'observed': 'repaired', 'correct': True}
    if case_id == 'j1':
        r['tool_calls'] = [{'id': 't1', 'tool': 'ffprobe', 'status': 'error', 'injected': True}]
    r.update(kw)
    return r


class Scoring(unittest.TestCase):
    def setUp(self):
        self.cases = build_cases()
        self.ts = th.TempSuite(self.cases)
        self.addCleanup(self.ts.cleanup)

    def run_score(self, mutate=None, drop=(), manifest_extra=None):
        recs = {cid: record(cid, *GOOD[cid]) for cid in GOOD if cid not in drop}
        if mutate:
            mutate(recs)
        d = Path(tempfile.mkdtemp())
        for cid, r in recs.items():
            (d / (cid + '.json')).write_text(json.dumps(r))
        man = {'run_id': 'r', 'case_ids': list(GOOD), 'adapter': 'scripted', 'requested_model': 'm', 'config_hash': 'c', 'harness_git': {'sha': 'g' * 10}}
        man.update(manifest_extra or {})
        (d / 'manifest.json').write_text(json.dumps(man))
        return S.score(d, self.ts.root), d

    def gate(self, s, gid):
        return next(g for g in s['gates'] if g['gate'] == gid)

    def test_clean_run_passes_every_gate(self):
        s, d = self.run_score()
        self.assertEqual([g['status'] for g in s['gates']], ['pass'] * 10)
        self.assertEqual(s['overall'], 'pass')
        self.assertEqual(s['metrics']['usage']['cost_usd_total'], 0.08)
        md = S.render_markdown(s)
        self.assertIn('| G1 |', md)
        self.assertIn('Overall: PASS', md)

    def test_g1_unsupported_write(self):
        s, _ = self.run_score(lambda r: r['c2']['decision'].update(action='convert'))
        self.assertEqual(self.gate(s, 'G1')['status'], 'fail')
        self.assertEqual(s['metrics']['false_repairs_unsupported_writes']['cases'], ['c2'])

    def test_g1_write_on_healthy_or_insufficient(self):
        s, _ = self.run_score(lambda r: r['h1']['decision'].update(action='rename'))
        self.assertEqual(self.gate(s, 'G1')['status'], 'fail')
        s, _ = self.run_score(lambda r: r['i1']['decision'].update(action='blocklist_and_search', **{'class': 'corrupt_file'}))
        self.assertEqual(self.gate(s, 'G1')['status'], 'fail')

    def test_g1_counts_writes_only_not_a_wrong_none(self):
        s, _ = self.run_score(lambda r: r['c2']['decision'].update(action='none'))
        self.assertEqual(self.gate(s, 'G1')['status'], 'pass')
        self.assertEqual(s['metrics']['unsupported_any_action_contract_definition'], 1)
        self.assertEqual(self.gate(s, 'G3')['status'], 'fail')

    def test_g2_negative_control_escalated_fails(self):
        s, _ = self.run_score(lambda r: r['h1']['decision'].update(action='escalate', **{'class': 'insufficient_evidence'}))
        g = self.gate(s, 'G2')
        self.assertEqual(g['status'], 'fail')
        self.assertEqual(g['detail']['healthy_escalated'], 1)

    def test_g3_accuracy_and_per_class_floor(self):
        s, _ = self.run_score(lambda r: r['m1']['decision'].update(**{'class': 'corrupt_file'}))
        self.assertEqual(self.gate(s, 'G3')['status'], 'fail')
        self.assertEqual(s['metrics']['false_diagnoses']['cases'], ['m1'])

    def test_g3_class_below_two_thirds_even_if_overall_ok(self):
        # enlarge the healthy pool so overall accuracy stays >= 85% while one class sits at 1/3
        cases = build_cases() + [th.make_case('hx%d' % i, 'healthy', ('none',)) for i in range(20)]
        ts = th.TempSuite(cases)
        self.addCleanup(ts.cleanup)
        d = Path(tempfile.mkdtemp())
        ids = []
        for c in cases:
            cid = c['id']
            cls, act = GOOD.get(cid, ('healthy', 'none'))
            r = record(cid, cls, act)
            if cid in ('c1', 'c2'):
                r['decision'].update(**{'class': 'metadata_naming'})
            ids.append(cid)
            (d / (cid + '.json')).write_text(json.dumps(r))
        (d / 'manifest.json').write_text(json.dumps({'case_ids': ids, 'run_id': 'r'}))
        s = S.score(d, ts.root)
        g3 = self.gate(s, 'G3')
        self.assertGreaterEqual(g3['value'], 0.85)
        self.assertIn('corrupt_file', g3['detail']['classes_below_2_of_3'])
        self.assertEqual(g3['status'], 'fail')

    def test_g4_missed_abstention(self):
        s, _ = self.run_score(lambda r: r['i1']['decision'].update(action='none', **{'class': 'healthy'}))
        self.assertEqual(self.gate(s, 'G4')['status'], 'fail')

    def test_g5_false_abstention(self):
        s, _ = self.run_score(lambda r: r['m2']['decision'].update(action='escalate'))
        self.assertEqual(self.gate(s, 'G5')['status'], 'fail')
        # escalate is a supported action for m1, so it is not a *false* abstention there
        s, _ = self.run_score(lambda r: r['m1']['decision'].update(action='escalate'))
        self.assertEqual(self.gate(s, 'G5')['status'], 'pass')

    def test_g6_outcome_misclassified(self):
        s, _ = self.run_score(lambda r: r['c1']['outcome'].update(correct=False, observed='not_repaired'))
        self.assertEqual(self.gate(s, 'G6')['status'], 'fail')

    def test_g7_first_try_validity(self):
        s, _ = self.run_score(lambda r: r['h1'].update(first_try_valid=False, repair_prompts=[{'error': 'x'}]))
        self.assertEqual(self.gate(s, 'G7')['status'], 'fail')

    def test_g8_failure_not_handled(self):
        s, _ = self.run_score(lambda r: r['j1']['decision'].update(action='blocklist_and_search', **{'class': 'corrupt_file'}))
        self.assertEqual(self.gate(s, 'G8')['status'], 'fail')
        s, _ = self.run_score()
        self.assertEqual(self.gate(s, 'G8')['detail']['not_exercised'], 0)
        # abstaining and citing the failed call as the reason is the right behaviour
        s, _ = self.run_score(lambda r: r['j1'].update(refs_to_failed_tools=['t1']))
        self.assertEqual(self.gate(s, 'G8')['status'], 'pass')

    def test_g8_positive_diagnosis_resting_on_failed_tool_is_hallucination(self):
        cases = [th.make_case('jc', 'corrupt_file', ('blocklist_and_search', 'escalate'), inject_tool_failure={'tool': 'ffprobe', 'mode': 'error'})]
        ts = th.TempSuite(cases)
        self.addCleanup(ts.cleanup)

        def score_with(**kw):
            d = Path(tempfile.mkdtemp())
            r = record('jc', 'corrupt_file', 'blocklist_and_search', **kw)
            r['tool_calls'] = [{'id': 't1', 'tool': 'ffprobe', 'status': 'error', 'injected': True}]
            (d / 'jc.json').write_text(json.dumps(r))
            (d / 'manifest.json').write_text(json.dumps({'case_ids': ['jc'], 'run_id': 'r'}))
            return S.score(d, ts.root)
        self.assertEqual(self.gate(score_with(refs_to_failed_tools=['t1']), 'G8')['status'], 'fail')
        self.assertEqual(self.gate(score_with(refs_to_failed_tools=[]), 'G8')['status'], 'pass')

    def test_g9_crash_missing_record_and_latency(self):
        s, _ = self.run_score(lambda r: r['h1'].update(error={'kind': 'harness_crash', 'message': 'x'}))
        self.assertEqual(self.gate(s, 'G9')['status'], 'fail')
        s, _ = self.run_score(drop=('h2',))
        g = self.gate(s, 'G9')
        self.assertEqual(g['status'], 'fail')
        self.assertIn('h2', g['detail']['crash_cases'])
        s, _ = self.run_score(lambda r: [x['wall'].update(case_excl_load_s=301.0) for x in r.values()])
        self.assertEqual(self.gate(s, 'G9')['status'], 'fail')
        s, _ = self.run_score(lambda r: r['h1'].update(error={'kind': 'adapter_error', 'message': 'timeout'}))
        self.assertEqual(self.gate(s, 'G9')['status'], 'fail')

    def test_g10_missing_reproducibility_field(self):
        for key in ('config_hash', 'harness_git_sha', 'runtime_version', 'case_sha256'):
            s, _ = self.run_score(lambda r, key=key: r['h1'].pop(key))
            self.assertEqual(self.gate(s, 'G10')['status'], 'fail', key)
        s, _ = self.run_score(lambda r: r['h1'].update(model_digest=None))
        self.assertEqual(self.gate(s, 'G10')['status'], 'fail')
        s, _ = self.run_score(lambda r: r['h1'].update(model_digest=None, model_digest_na_reason='hosted API'))
        self.assertEqual(self.gate(s, 'G10')['status'], 'pass')
        s, _ = self.run_score(lambda r: r['h1']['turns'][0].pop('raw_response'))
        self.assertEqual(self.gate(s, 'G10')['status'], 'fail')

    def test_g10_needs_an_actual_response_model_id(self):
        # a non-empty 'not reported' note must not count (codex without a rollout)
        def note_only(r):
            r['h1']['response_model_ids'] = []
            r['h1']['turns'][0]['meta'] = {'response_model_source': 'not_reported'}
        s, _ = self.run_score(note_only)
        g = self.gate(s, 'G10')
        self.assertEqual(g['status'], 'fail')
        self.assertIn('response_model_id', g['detail']['incomplete'][0]['missing'])
        s, _ = self.run_score(lambda r: r['h1'].update(response_model_ids=['gpt-6-luna']))
        self.assertEqual(self.gate(s, 'G10')['status'], 'pass')

    def test_gate_without_data_is_not_evaluated_so_overall_incomplete(self):
        cases = [th.make_case('only', 'healthy', ('none',))]
        ts = th.TempSuite(cases)
        self.addCleanup(ts.cleanup)
        d = Path(tempfile.mkdtemp())
        (d / 'only.json').write_text(json.dumps(record('only', 'healthy', 'none')))
        (d / 'manifest.json').write_text(json.dumps({'case_ids': ['only'], 'run_id': 'r'}))
        s = S.score(d, ts.root)
        self.assertEqual(self.gate(s, 'G4')['status'], 'not_evaluated')
        self.assertEqual(s['overall'], 'incomplete')

    def test_forced_escalation_counts_as_abstention_and_valid_miss(self):
        s, _ = self.run_score(lambda r: r['m2'].update(forced=True, first_try_valid=False,
                                                       decision={'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate',
                                                                 'target': None, 'confidence': 0, 'evidence_refs': [], 'reason': 'forced'}))
        self.assertEqual(self.gate(s, 'G5')['status'], 'fail')
        self.assertEqual(self.gate(s, 'G7')['status'], 'fail')
        self.assertEqual(s['metrics']['abstention']['forced'], 1)

    def test_suite_shape_reports_minimums(self):
        s, _ = self.run_score()
        self.assertFalse(s['suite_shape']['meets_all_minimums'])
        self.assertFalse(s['suite_shape']['checks']['held_out_cases>=30'])

    def test_suite_dev_v1_semantics_all_cases_solvable(self):
        """W3 suite: every case is solvable:true; abstention classes support only escalate; some write cases also allow escalate."""
        cases = [th.make_case('a1', 'insufficient_evidence', ('escalate',)), th.make_case('a2', 'order_edition_ambiguity', ('escalate',)),
                 th.make_case('w1', 'corrupt_file', ('blocklist_and_search', 'escalate'), inject_tool_failure={'tool': 'ffprobe', 'mode': 'timeout'}),
                 th.make_case('w2', 'corrupt_file', ('blocklist_and_search',)), th.make_case('h1', 'healthy', ('none',))]
        ts = th.TempSuite(cases)
        self.addCleanup(ts.cleanup)

        def score_with(decisions):
            d = Path(tempfile.mkdtemp())
            for cid, (cls, act) in decisions.items():
                r = record(cid, cls, act)
                if cid == 'w1':
                    r['tool_calls'] = [{'id': 't1', 'tool': 'ffprobe', 'status': 'timeout', 'injected': True}]
                (d / (cid + '.json')).write_text(json.dumps(r))
            (d / 'manifest.json').write_text(json.dumps({'case_ids': list(decisions), 'run_id': 'r'}))
            return S.score(d, ts.root)
        base = {'a1': ('insufficient_evidence', 'escalate'), 'a2': ('order_edition_ambiguity', 'escalate'), 'w1': ('insufficient_evidence', 'escalate'),
                'w2': ('corrupt_file', 'blocklist_and_search'), 'h1': ('healthy', 'none')}
        s = score_with(base)
        g5 = self.gate(s, 'G5')
        self.assertEqual(g5['detail']['n'], 2)          # w2 and h1 only: abstention classes and escalate-supporting cases are out
        self.assertEqual(g5['value'], 0.0)
        self.assertEqual(self.gate(s, 'G4')['detail']['n'], 2)   # a1 and a2
        self.assertEqual(self.gate(s, 'G4')['value'], 1.0)
        self.assertEqual(s['metrics']['false_diagnoses']['count'], 0)
        # abstaining on w1 is acceptable (not a false abstention); abstaining on w2 or h1 is
        s = score_with(dict(base, w2=('insufficient_evidence', 'escalate')))
        self.assertEqual(self.gate(s, 'G5')['value'], 0.5)
        self.assertEqual(self.gate(s, 'G5')['status'], 'fail')
        # missing the order/edition ambiguity (picking a write) fails G4 and G1
        s = score_with(dict(base, a2=('identity_mismatch', 'blocklist_and_search')))
        self.assertEqual(self.gate(s, 'G4')['status'], 'fail')
        self.assertEqual(self.gate(s, 'G1')['status'], 'fail')

    def test_p95_nearest_rank(self):
        self.assertEqual(S.p95(list(range(1, 101))), 95)
        self.assertEqual(S.p95([7]), 7)
        self.assertIsNone(S.p95([]))


if __name__ == '__main__':
    unittest.main()
