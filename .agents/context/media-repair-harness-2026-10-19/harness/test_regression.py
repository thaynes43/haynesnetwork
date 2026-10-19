"""Broad regression tests on the synthetic generic suite in testdata/regression (movie, TV, EPUB, audiobook).

Fake model replies only: these tests check what the HARNESS does with partial evidence, abstention, failed and timed-out tools,
healthy negatives and edition / order ambiguity (statuses, honest flags, audit, records), not what any model would decide."""
import json
import tempfile
import unittest
from pathlib import Path

import adapters as A
import run as R
import th

SUITE = Path(__file__).resolve().parent / 'testdata' / 'regression'


def load(cid):
    p = SUITE / 'cases' / (cid + '.json')
    return json.loads(p.read_text())


def go(cid, replies, prompt='v2'):
    case = load(cid)
    ad = A.ScriptedAdapter('scripted-1', replies)
    rec = R.run_case(case, 'sha', ad, SUITE, tempfile.mkdtemp(), prompt_version=prompt, run_id='reg', which=lambda n: None)
    rec.update(harness_git_sha='x', config_hash='h')
    return rec, ad


def call(tool, **args):
    return th.tool_call(tool, args)


ESC = th.decision('insufficient_evidence', 'escalate')


def statuses(rec):
    return [(c['tool'], c['status']) for c in rec['tool_calls']]


class SuiteShape(unittest.TestCase):
    def test_covers_every_media_type_and_scenario(self):
        cases = [json.loads(p.read_text()) for p in sorted((SUITE / 'cases').glob('*.json'))]
        self.assertEqual({c['media_type'] for c in cases}, {'movie', 'tv', 'epub', 'audiobook'})
        truths = {c['truth']['class'] for c in cases}
        self.assertEqual(truths, {'healthy', 'insufficient_evidence', 'order_edition_ambiguity', 'corrupt_file'})
        self.assertTrue(any(c.get('inject_tool_failure', {}).get('mode') == 'timeout' for c in cases))
        self.assertTrue(any(c.get('inject_tool_failure', {}).get('mode') == 'error' for c in cases))
        self.assertTrue(any(c.get('inject_tool_failure', {}).get('mode') == 'partial' for c in cases))
        for c in cases:
            self.assertEqual(c['suite_version'], 'harness-regression-v1')

    def test_generated_files_match_the_generator(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('make_regression', SUITE.parent / 'make_regression.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        generated = {c['id']: c for c in mod.cases()}
        on_disk = {p.stem: json.loads(p.read_text()) for p in (SUITE / 'cases').glob('*.json')}
        self.assertEqual(generated, on_disk)   # regenerate with testdata/make_regression.py after editing it


class HealthyNegatives(unittest.TestCase):
    def test_movie_healthy_with_whole_file_evidence_is_not_flagged(self):
        rec, _ = go('rg-movie-healthy-001', [call('ffprobe'), call('decode_sample', full=True), th.decision('healthy', 'none', refs=['t1', 't2'])])
        self.assertEqual(statuses(rec), [('ffprobe', 'ok'), ('decode_sample', 'ok')])
        self.assertEqual({c['mode'] for c in rec['tool_calls']}, {'pinned_replay'})   # recorded observation, labelled replay
        self.assertEqual((rec['unverified_parts'], rec['decision_flags']), ([], []))
        self.assertTrue(rec['first_try_valid'])
        self.assertEqual(R.record_missing_fields(rec), [])

    def test_epub_healthy_runs_the_real_tool(self):
        rec, _ = go('rg-epub-healthy-001', [call('epub_inspect'), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual(statuses(rec), [('epub_inspect', 'ok')])
        self.assertIn('Lantern', rec['tool_calls'][0]['output'])
        self.assertEqual(rec['decision_flags'], [])
        self.assertEqual(rec['fixture']['verified'], True)

    def test_audiobook_healthy_from_a_recorded_observation(self):
        rec, _ = go('rg-audiobook-healthy-001', [call('audiobook_inspect'), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual(statuses(rec), [('audiobook_inspect', 'ok')])
        self.assertEqual(rec['tool_calls'][0]['mode'], 'pinned_replay')
        self.assertEqual(rec['decision_flags'], [])


class PartialEvidence(unittest.TestCase):
    def test_a_window_is_available_but_the_whole_file_is_not(self):
        rec, _ = go('rg-movie-partial-001', [call('decode_sample', at=0), call('decode_sample', full=True), ESC])
        self.assertEqual(statuses(rec), [('decode_sample', 'ok'), ('decode_sample', 'unavailable')])
        self.assertIn('whole file', rec['tool_calls'][1]['output'])
        self.assertEqual([p['id'] for p in rec['unverified_parts']], ['t2'])
        self.assertEqual(rec['decision_flags'], [])   # abstained: nothing to flag

    def test_healthy_on_unverified_whole_file_is_flagged_never_rewritten(self):
        rec, _ = go('rg-movie-partial-001', [call('decode_sample', at=0), call('decode_sample', full=True), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual(rec['decision']['action'], 'none')
        self.assertEqual(rec['decision_flags'], ['healthy_with_unverified_parts', 'none_with_unverified_parts'])
        self.assertFalse(rec['forced'])

    def test_an_unrecorded_window_is_unavailable_not_an_empty_success(self):
        rec, _ = go('rg-movie-partial-001', [call('decode_sample', at=60), ESC])
        self.assertEqual(statuses(rec), [('decode_sample', 'unavailable')])
        self.assertIn('0', rec['tool_calls'][0]['output'])   # says where recordings exist

    def test_tool_not_offered_is_a_protocol_violation_and_the_item_stays_unverified(self):
        rec, _ = go('rg-movie-limited-001', [call('decode_sample', full=True), ESC])
        self.assertEqual(statuses(rec), [('decode_sample', 'unavailable')])
        self.assertEqual(rec['protocol_violations'][0]['kind'], 'tool_not_offered')
        self.assertFalse(rec['first_try_valid'])
        self.assertEqual(rec['repair_prompts'], [])
        self.assertTrue(rec['final_decision_valid'])

    def test_a_failed_precollected_probe_is_unverified(self):
        rec, _ = go('rg-tv-failed-probe-001', [call('decode_sample', at=0), th.decision('healthy', 'none', refs=['e1'])])
        self.assertEqual([(p['id'], p['source'], p['status']) for p in rec['unverified_parts']], [('e1', 'evidence', 'error')])
        self.assertIn('healthy_with_unverified_parts', rec['decision_flags'])
        self.assertEqual(rec['refs_to_non_ok_tools'], ['e1'])


class FailedAndTimedOutTools(unittest.TestCase):
    def test_timeout_is_recorded_and_unverified(self):
        rec, ad = go('rg-tv-timeout-001', [call('decode_sample', at=0), ESC])
        c = rec['tool_calls'][0]
        self.assertEqual((c['status'], c['injected'], c['mode']), ('timeout', True, 'injected'))
        self.assertNotIn('inject', c['output'].lower())
        self.assertIn('timeout', ad.calls[1][-1]['content'])
        self.assertEqual([p['status'] for p in rec['unverified_parts']], ['timeout'])
        self.assertEqual(rec['refs_to_failed_tools'], [])

    def test_healthy_after_a_timeout_is_flagged(self):
        rec, _ = go('rg-tv-timeout-001', [call('decode_sample', at=0), th.decision('healthy', 'none', refs=['t1', 'e1'])])
        self.assertIn('healthy_with_unverified_parts', rec['decision_flags'])
        self.assertEqual(rec['refs_to_failed_tools'], ['t1'])

    def test_error_is_a_failed_tool(self):
        rec, _ = go('rg-audiobook-failed-001', [call('audiobook_inspect'), ESC])
        c = rec['tool_calls'][0]
        self.assertEqual((c['status'], c['injected']), ('error', True))
        self.assertEqual(rec['decision']['class'], 'insufficient_evidence')

    def test_partial_cuts_real_output_and_is_unverified(self):
        rec, _ = go('rg-audiobook-partial-001', [call('audiobook_inspect'), ESC])
        c = rec['tool_calls'][0]
        self.assertEqual(c['status'], 'partial')
        self.assertIn('cut off', c['output'])
        self.assertEqual([p['status'] for p in rec['unverified_parts']], ['partial'])

    def test_a_write_citing_a_timed_out_tool_is_unmet(self):
        d = th.decision('corrupt_file', 'blocklist_and_search', refs=['t1'], target='Example Show')
        d['audit'] = {'target': 'Example Show', 'preconditions': ['t1 shows damage'], 'readback': 'read the queue', 'verify': 'entry blocklisted'}
        rec, _ = go('rg-tv-timeout-001', [call('decode_sample', at=0), d])
        a = rec['action_audit']
        self.assertEqual(a['execution_status'], 'proposed_not_executed')
        self.assertIn('no_failed_tool_cited', a['unmet'])
        self.assertIs(a['executed'], False)


class CorruptFinding(unittest.TestCase):
    def test_a_damage_finding_from_a_working_tool_is_citable_support(self):
        rec, _ = go('rg-epub-corrupt-001', [call('epub_inspect'), ESC])
        self.assertEqual(rec['tool_calls'][0]['status'], 'error')   # the tool ran and reported the damaged archive
        self.assertIn('zip_open', rec['tool_calls'][0]['output'])
        self.assertEqual(rec['unverified_parts'][0]['status'], 'error')   # conservative: flagged next to a healthy decision

    def test_audit_for_a_corrupt_proposal_on_the_finding(self):
        d = th.decision('corrupt_file', 'blocklist_and_search', refs=['t1'], target='The Lantern Ledger')
        d['audit'] = {'target': 'The Lantern Ledger', 'preconditions': ['t1: epub_inspect reports an unreadable archive'], 'readback': 'read the queue entry back',
                      'verify': 'the release shows as blocklisted'}
        rec, _ = go('rg-epub-corrupt-001', [call('epub_inspect'), d])
        a = rec['action_audit']
        self.assertEqual(a['execution_status'], 'proposed_not_executed')
        self.assertIs(a['executed'], False)
        got = {c['id']: c['met'] for c in a['preconditions']}
        self.assertTrue(got['no_failed_tool_cited'] and got['cited_evidence_supports'] and got['arr_app_present'], got)
        self.assertEqual(rec['outcome']['observed'], 'not_repaired')   # the post-state check; nothing was written
        self.assertTrue(rec['outcome']['correct'])


class AbstentionAndAmbiguity(unittest.TestCase):
    def test_order_ambiguity_escalates(self):
        d = th.decision('order_edition_ambiguity', 'escalate', refs=['e2'])
        rec, _ = go('rg-tv-order-001', [call('ffprobe'), d])
        self.assertEqual((rec['decision']['class'], rec['decision']['action']), ('order_edition_ambiguity', 'escalate'))
        self.assertEqual(rec['action_audit']['execution_status'], 'no_write_proposed')
        self.assertTrue(rec['first_try_valid'])

    def test_a_write_on_an_ambiguous_case_is_a_flagged_proposal_only(self):
        d = th.decision('identity_mismatch', 'remap', refs=['e2'], target='Example Show')
        d['audit'] = {'target': 'Example Show', 'preconditions': ['e2 matches another episode'], 'readback': 'read the link', 'verify': 'link shows the new episode'}
        rec, _ = go('rg-tv-order-001', [d])
        a = rec['action_audit']
        self.assertEqual(a['execution_status'], 'proposed_not_executed')
        self.assertIn('target_slot_stated_free', a['unmet'])   # no claim that the slot is free
        self.assertIs(a['executed'], False)

    def test_edition_ambiguity_on_a_good_epub(self):
        rec, _ = go('rg-epub-edition-001', [call('epub_inspect'), th.decision('order_edition_ambiguity', 'escalate', refs=['t1'])])
        self.assertEqual(statuses(rec), [('epub_inspect', 'ok')])
        self.assertEqual(rec['decision']['action'], 'escalate')

    def test_prompt_v1_still_runs_every_case(self):
        for p in sorted((SUITE / 'cases').glob('*.json')):
            rec, _ = go(p.stem, [ESC], prompt='v1')
            self.assertEqual(rec['prompt']['version'], 'v1')
            self.assertNotIn('error', rec)


class EverySyntheticCase(unittest.TestCase):
    def test_each_case_runs_to_a_complete_unexecuted_record_on_both_prompts(self):
        for p in sorted((SUITE / 'cases').glob('*.json')):
            for prompt in ('v1', 'v2'):
                rec, _ = go(p.stem, [ESC], prompt=prompt)
                self.assertEqual(R.record_missing_fields(rec), [], p.stem)
                self.assertIs(rec['action_audit']['executed'], False)
                self.assertNotIn('error', rec, p.stem)

    def test_run_through_main_leaves_a_complete_run_directory(self):
        out = Path(tempfile.mkdtemp()) / 'r'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', [ESC] * 12)
        try:
            code = R.main(['--suite', str(SUITE), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v2', '--replay', 'auto'])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 0)
        s = json.loads((out / 'run_summary.json').read_text())
        self.assertEqual((s['records_written'], s['cases_planned']), (12, 12))
        self.assertTrue(s['records_complete'], s['incomplete_records'])
        self.assertEqual(s['validity']['crashes'], 0)
        self.assertEqual(s['validity']['first_try_valid'], 12)
        self.assertEqual(len((out / 'audit.jsonl').read_text().splitlines()), 12)


if __name__ == '__main__':
    unittest.main()
