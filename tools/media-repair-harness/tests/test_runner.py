import json
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import adapters as A
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th


def run_one(case, replies, suite=None, **kw):
    ts = suite or th.TempSuite([case])
    scratch = tempfile.mkdtemp()
    ad = A.ScriptedAdapter('scripted-1', replies)
    rec = R.run_case(case, 'sha', ad, ts.root, scratch, **kw)
    return rec, ad, ts


class TurnProtocol(unittest.TestCase):
    def test_tool_then_decision(self):
        rec, ad, ts = run_one(th.make_case(), [th.tool_call('arr_lookup'), th.decision(refs=['t1'])])
        self.assertFalse(rec['forced'])
        self.assertTrue(rec['first_try_valid'])
        self.assertEqual(len(rec['tool_calls']), 1)
        self.assertEqual(rec['tool_calls'][0]['id'], 't1')
        self.assertEqual(rec['bad_evidence_refs'], [])
        self.assertFalse(rec['action_audit']['executed'])
        # the tool result reached the model in the next request
        self.assertIn('tool_result', ad.calls[1][-1]['content'])
        ts.cleanup()

    def test_one_repair_prompt_is_recorded_and_first_try_is_a_miss(self):
        rec, ad, ts = run_one(th.make_case(), ['not json at all', th.decision()])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertFalse(rec['first_try_valid'])
        self.assertFalse(rec['forced'])
        self.assertEqual(rec['decision']['action'], 'none')
        self.assertIn('rejected', ad.calls[1][-1]['content'])
        ts.cleanup()

    def test_second_invalid_reply_forces_escalate(self):
        rec, _, ts = run_one(th.make_case(), ['nope', {'type': 'decision', 'class': 'healthy', 'action': 'delete'}])
        self.assertTrue(rec['forced'])
        self.assertEqual((rec['decision']['class'], rec['decision']['action']), ('insufficient_evidence', 'escalate'))
        self.assertFalse(rec['first_try_valid'])
        ts.cleanup()

    def test_budget_exhaustion_forces_escalate(self):
        replies = [th.tool_call() for _ in range(7)]
        rec, ad, ts = run_one(th.make_case(), replies)
        self.assertEqual(len(rec['tool_calls']), 6)
        self.assertTrue(rec['forced'])
        self.assertIn('budget', rec['forced_reason'])
        self.assertEqual(rec['decision']['action'], 'escalate')
        self.assertIn('Tool budget exhausted', ad.calls[6][-1]['content'])  # told after the 6th result
        ts.cleanup()

    def test_six_calls_then_decision_is_fine(self):
        replies = [th.tool_call() for _ in range(6)] + [th.decision()]
        rec, _, ts = run_one(th.make_case(), replies)
        self.assertFalse(rec['forced'])
        self.assertEqual(len(rec['tool_calls']), 6)
        ts.cleanup()

    def test_unavailable_tool_is_a_repairable_miss(self):
        case = th.make_case(tools_available=['arr_lookup'])
        rec, _, ts = run_one(case, [th.tool_call('ffprobe'), th.decision()])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertEqual(rec['tool_calls'], [])
        ts.cleanup()

    def test_adapter_error_is_kept_as_failed_run_with_forced_escalate(self):
        rec, _, ts = run_one(th.make_case(), [A.AdapterError('timeout')])
        self.assertEqual(rec['error']['kind'], 'adapter_error')
        self.assertTrue(rec['forced'])
        self.assertEqual(rec['decision']['action'], 'escalate')
        self.assertIn('error', rec['turns'][0])
        ts.cleanup()

    def test_bad_and_failed_refs_are_recorded(self):
        case = th.make_case(inject_tool_failure={'tool': 'ffprobe', 'mode': 'error'})
        rec, _, ts = run_one(case, [th.tool_call('ffprobe'), th.decision(refs=['t1', 'e9'])])
        self.assertEqual(rec['bad_evidence_refs'], ['e9'])
        self.assertEqual(rec['refs_to_failed_tools'], ['t1'])
        ts.cleanup()

    def test_write_intent_is_audited_never_executed(self):
        rec, _, ts = run_one(th.make_case(truth='corrupt_file', supported=('blocklist_and_search',)),
                             [th.decision('corrupt_file', 'blocklist_and_search', target='rel-1')])
        a = rec['action_audit']
        self.assertTrue(a['write_intent'])
        self.assertFalse(a['executed'])
        self.assertEqual(a['intent']['target'], 'rel-1')
        ts.cleanup()


class InjectedFailures(unittest.TestCase):
    def test_error_and_timeout_modes(self):
        for mode, status in (('error', 'error'), ('timeout', 'timeout')):
            case = th.make_case(inject_tool_failure={'tool': 'arr_lookup', 'mode': mode})
            rec, ad, ts = run_one(case, [th.tool_call('arr_lookup'), th.decision('insufficient_evidence', 'escalate')])
            call = rec['tool_calls'][0]
            self.assertEqual(call['status'], status)
            self.assertTrue(call['injected'])
            self.assertTrue(call['injected'])
            self.assertNotIn('inject', call['output'].lower())  # the model must not be told the failure is synthetic
            self.assertIn(status, ad.calls[1][-1]['content'])
            ts.cleanup()

    def test_partial_mode_cuts_real_output(self):
        case = th.make_case(inject_tool_failure={'tool': 'arr_lookup', 'mode': 'partial'},
                            context={'title': 'T', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {'series': 1234567, 'episode': 7654321}}, 'notes_for_model': ''})
        rec, _, ts = run_one(case, [th.tool_call('arr_lookup'), th.decision('insufficient_evidence', 'escalate')])
        c = rec['tool_calls'][0]
        self.assertEqual(c['status'], 'partial')
        self.assertIn('cut off', c['output'])
        ts.cleanup()

    def test_other_tools_unaffected(self):
        case = th.make_case(inject_tool_failure={'tool': 'ffprobe', 'mode': 'error'})
        rec, _, ts = run_one(case, [th.tool_call('arr_lookup'), th.decision()])
        self.assertEqual(rec['tool_calls'][0]['status'], 'ok')
        ts.cleanup()


class EvidenceAndOutcome(unittest.TestCase):
    def test_evidence_ref_hash_checked_and_output_bounded(self):
        ts = th.TempSuite([])
        data = b'x' * 20000
        import hashlib
        ts.add_file('ev/big.txt', data)
        case = th.make_case(evidence=[
            {'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': {'ref': 'ev/big.txt', 'sha256': hashlib.sha256(data).hexdigest()}},
            {'id': 'e2', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': {'ref': 'ev/big.txt', 'sha256': '0' * 64}},
            {'id': 'e3', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': {'ref': 'ev/missing.txt', 'sha256': '0' * 64}}])
        shown = R.resolve_evidence(case, ts.root)
        self.assertTrue(shown[0]['truncated'])
        self.assertLessEqual(len(shown[0]['output'].encode()), P.TOOL_OUTPUT_BYTES)
        self.assertEqual(shown[1]['status'], 'unavailable')   # integrity failure: the content is withheld, not shown
        self.assertIn('mismatch', shown[1]['output'])
        self.assertNotIn('xxxx', shown[1]['output'])
        self.assertEqual(shown[2]['status'], 'unavailable')
        ts.cleanup()

    def test_outcome_step_runs_and_scores(self):
        case = th.make_case(fixture={'kind': 'none'}, outcome_step={'check': 'epub_title_is', 'expected': 'repaired',
                            'inputs': {'path': str(th.TESTDATA / 'fixtures' / 'td-right.epub'), 'title': 'The Lantern Ledger'}})
        rec, _, ts = run_one(case, [th.decision()])
        self.assertEqual(rec['outcome']['observed'], 'repaired')
        self.assertTrue(rec['outcome']['correct'])
        case['outcome_step']['expected'] = 'not_repaired'
        rec, _, ts2 = run_one(case, [th.decision()])
        self.assertFalse(rec['outcome']['correct'])
        case['outcome_step']['check'] = 'nonexistent'
        rec, _, ts3 = run_one(case, [th.decision()])
        self.assertEqual(rec['outcome']['observed'], 'error')
        for t in (ts, ts2, ts3):
            t.cleanup()

    def test_corrupt_epub_outcome_is_not_repaired(self):
        case = th.make_case(outcome_step={'check': 'epub_valid', 'expected': 'not_repaired',
                            'inputs': {'path': str(th.TESTDATA / 'fixtures' / 'td-corrupt.epub')}})
        rec, _, ts = run_one(case, [th.decision()])
        self.assertTrue(rec['outcome']['correct'])
        ts.cleanup()


class MainEndToEnd(unittest.TestCase):
    def run_main(self, replies, cases, extra=None):
        ts = th.TempSuite(cases)
        out = Path(tempfile.mkdtemp()) / 'runs' / 'r1'
        script = Path(tempfile.mkdtemp()) / 's.json'
        script.write_text(json.dumps(replies))
        code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--script', str(script),
                       '--scratch', tempfile.mkdtemp()] + (extra or []))
        return code, out, ts

    def test_writes_records_manifest_audit(self):
        code, out, ts = self.run_main([th.decision(), th.decision()], [th.make_case('a'), th.make_case('b')])
        self.assertEqual(code, 0)
        self.assertTrue((out / 'a.json').exists() and (out / 'b.json').exists())
        manifest = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(manifest['case_ids'], ['a', 'b'])
        self.assertTrue(manifest['config_hash'])
        self.assertEqual(len((out / 'audit.jsonl').read_text().splitlines()), 2)
        rec = json.loads((out / 'a.json').read_text())
        for k in ('requested_model', 'response_model_ids', 'runtime_version', 'harness_git_sha', 'config_hash', 'case_sha256', 'usage', 'wall', 'decision', 'forced'):
            self.assertIn(k, rec)
        ts.cleanup()

    def test_malformed_case_becomes_failed_record_and_run_continues(self):
        bad = th.make_case('bad', fixture={'kind': 'remote', 'locator': 'remote:not-a-valid-locator'})
        code, out, ts = self.run_main([th.decision()], [bad, th.make_case('good')])
        self.assertEqual(code, 0)
        rec = json.loads((out / 'bad.json').read_text())
        self.assertEqual(rec['error']['kind'], 'harness_crash')
        self.assertTrue(rec['forced'])
        self.assertTrue((out / 'good.json').exists())
        ts.cleanup()

    def test_refuses_to_overwrite_a_used_run_dir(self):
        code, out, ts = self.run_main([th.decision()], [th.make_case('a')])
        with self.assertRaises(SystemExit):
            R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--script', '/dev/null'])
        ts.cleanup()

    def test_abort_keeps_records_written_so_far(self):
        class Busy(A.ScriptedAdapter):
            n = 0

            def before_case(self):
                Busy.n += 1
                if Busy.n == 2:
                    raise A.AbortRun('resident_owner_changed_no_eviction')
        ts = th.TempSuite([th.make_case('a'), th.make_case('b')])
        out = Path(tempfile.mkdtemp()) / 'r'
        orig = R.build_adapter
        R.build_adapter = lambda args: Busy('m', [th.decision(), th.decision()])
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp()])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 3)
        self.assertTrue((out / 'a.json').exists())
        self.assertFalse((out / 'b.json').exists())
        self.assertIn('no_eviction', json.loads((out / 'manifest.json').read_text())['aborted'])
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
