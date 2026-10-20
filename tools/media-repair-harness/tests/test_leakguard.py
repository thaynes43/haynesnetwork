"""Truth-leak protection: alias, redaction, guard, and a sweep over every case of the merged W3 suite (73)."""
import json
import tempfile
import unittest
from pathlib import Path

import adapters as A
import leakguard as L
import protocol as P
import run as R
import th
import tools as T

SUITE = th.HERE.parent / 'suite'
NO_BINARIES = lambda name: None


def suite_cases():
    return [c for c, _ in R.load_cases(SUITE)]


def leaky_case(**kw):
    c = th.make_case('tv-corrupt-003', 'corrupt_file', ('blocklist_and_search',), media='tv', family='hl-e02', provenance='new (see .agents/context/x@abc1234)',
                     fixture={'kind': 'local', 'sha256': None, 'bytes': 1, 'locator': 'fixtures/media/hl_e02_flip.mkv'})
    c['context']['filename'] = 'Harbor Lights - S01E02 - Lamp Oil.mkv'
    c.update(kw)
    return c


class Alias(unittest.TestCase):
    def test_alias_is_opaque_stable_per_run_and_differs_across_runs(self):
        a = L.alias('run-1', 'tv-corrupt-003')
        self.assertEqual(a, L.alias('run-1', 'tv-corrupt-003'))
        self.assertNotEqual(a, L.alias('run-2', 'tv-corrupt-003'))
        self.assertNotEqual(a, L.alias('run-1', 'tv-corrupt-004'))
        self.assertRegex(a, r'^case-[0-9a-f]{8}$')
        self.assertNotIn('corrupt', a)


class Redact(unittest.TestCase):
    def test_names_and_paths_become_the_case_filename(self):
        c = leaky_case()
        out = L.redact('media/hl_e02_flip.mkv: Invalid data; see fixtures/media/hl_e02_flip.mkv and hl_e02_flip', c)
        self.assertNotIn('flip', out)
        self.assertIn('Harbor Lights - S01E02 - Lamp Oil.mkv', out)

    def test_neutral_name_when_the_case_has_no_filename(self):
        c = leaky_case()
        del c['context']['filename']
        out = L.redact('Error opening input file media/hl_e02_flip.mkv.', c)
        self.assertEqual(out, 'Error opening input file input.mkv.')

    def test_absolute_extra_path_and_case_insensitive(self):
        c = leaky_case()
        del c['context']['filename']
        out = L.redact('open /home/dev/x/HL_E02_FLIP.MKV failed', c, ['/home/dev/x/hl_e02_flip.mkv'])
        self.assertNotIn('flip', out.lower())

    def test_unrelated_text_untouched(self):
        c = leaky_case()
        self.assertEqual(L.redact('a world of lr and flipping', c), 'a world of lr and flipping')


class Guard(unittest.TestCase):
    def kinds(self, text, case=None):
        return L.find_leaks(case or leaky_case(), text)

    def test_each_forbidden_token_kind(self):
        self.assertIn('case_id', self.kinds('see tv-corrupt-003 here'))
        self.assertIn('case_id_stem', self.kinds('a tv-corrupt file'))
        self.assertIn('family', self.kinds('family hl-e02 member'))
        self.assertIn('truth_class', self.kinds('this is a corrupt_file'))
        self.assertIn('supported_action', self.kinds('do blocklist_and_search'))
        self.assertIn('fixture_name', self.kinds('opening hl_e02_flip.mkv'))
        self.assertIn('fixture_stem', self.kinds('opening hl_e02_flip'))
        self.assertIn('provenance', self.kinds('from new (see .agents/context/x@abc1234)'))
        self.assertIn('provenance', self.kinds('path .agents/context/x@abc1234'))

    def test_no_false_positive_on_ordinary_words(self):
        c = leaky_case()
        c['family'] = 'anne'
        self.assertEqual(L.find_leaks(c, 'Anne of Green Gables, a world of flipping pages'), [])
        self.assertEqual(L.find_leaks(c, 'the anne-marie reference'), ['family'])   # boundary-aware, case-sensitive

    def test_check_messages_ignores_assistant_turns(self):
        c = leaky_case()
        L.check_messages(c, [{'role': 'assistant', 'content': 'tv-corrupt-003'}])
        with self.assertRaises(L.LeakError):
            L.check_messages(c, [{'role': 'user', 'content': 'x'}, {'role': 'user', 'content': 'tv-corrupt-003'}])

    def test_repair_prompt_may_list_the_generic_enumerations_but_nothing_case_specific(self):
        c = leaky_case()
        generic = L.REPAIR_PREFIX + " action must be one of ['none', 'escalate', 'blocklist_and_search', 'remap']; class must be one of ['corrupt_file', 'healthy']. Reply again."
        L.check_messages(c, [{'role': 'user', 'content': generic}])  # no LeakError
        with self.assertRaises(L.LeakError):
            L.check_messages(c, [{'role': 'user', 'content': L.REPAIR_PREFIX + ' tv-corrupt-003 is odd'}])
        with self.assertRaises(L.LeakError):  # an ordinary user message with the same enumeration is still a leak
            L.check_messages(c, [{'role': 'user', 'content': 'x'}, {'role': 'user', 'content': 'do blocklist_and_search'}])

    def test_leak_stops_the_case_before_the_model_is_called(self):
        c = leaky_case(fixture={'kind': 'none'})
        c['context']['notes_for_model'] = 'Please look at tv-corrupt-003'
        ad = A.ScriptedAdapter('m', [th.decision()])
        ts = th.TempSuite([c])
        self.addCleanup(ts.cleanup)
        rec = R.run_case(c, 'sha', ad, ts.root, tempfile.mkdtemp(), run_id='r')
        self.assertEqual(ad.calls, [])                        # nothing was sent
        self.assertEqual(rec['error']['kind'], 'harness_crash')  # a harness error, not a model miss
        self.assertTrue(rec['error']['leak_guard'])
        self.assertTrue(rec['forced'])
        self.assertNotIn('tv-corrupt-003', rec['error']['message'])

    def test_leak_in_a_tool_result_stops_the_next_request(self):
        c = leaky_case(fixture={'kind': 'none'})
        old = T.REGISTRY['arr_lookup']
        T.REGISTRY['arr_lookup'] = lambda args, ctx: T.ToolResult('ok', 'record for family hl-e02')
        try:
            ad = A.ScriptedAdapter('m', [th.tool_call('arr_lookup'), th.decision()])
            ts = th.TempSuite([c])
            self.addCleanup(ts.cleanup)
            rec = R.run_case(c, 'sha', ad, ts.root, tempfile.mkdtemp(), run_id='r')
        finally:
            T.REGISTRY['arr_lookup'] = old
        self.assertEqual(len(ad.calls), 1)                    # first request went out, the second was blocked
        self.assertTrue(rec['error']['leak_guard'])


class SuiteSweep(unittest.TestCase):
    """All 73 merged suite cases: the first request and every replay tool output pass the guard."""

    def context(self, case):
        return T.Context(case, T.Fixture.from_case(case, SUITE), tempfile.mkdtemp(), suite_dir=SUITE, which=NO_BINARIES)

    def test_suite_size(self):
        self.assertEqual(len(suite_cases()), 73)

    def test_first_request_is_clean_and_uses_the_alias(self):
        for c in suite_cases():
            ctx = self.context(c)
            ev = R.resolve_evidence(c, SUITE, ctx.redact)
            alias = L.alias('run-x', c['id'])
            text = json.dumps(P.case_view(c, ev, case_alias=alias), sort_keys=True, ensure_ascii=False)
            self.assertIn(alias, text)
            L.check_messages(c, [{'role': 'user', 'content': text}], ctx.forbidden_extra)   # raises on a leak

    def test_all_replay_tool_outputs_are_clean(self):
        calls = 0
        for c in suite_cases():
            ctx = self.context(c)
            for tool in c['tools_available']:
                for args in ({}, {'at': 0}, {'at': 4}, {'at': 9}, {'t': 'full'}, {'frame': 'frame@0'}):
                    r = T.call_tool(ctx, tool, args)
                    calls += 1
                    L.check_messages(c, [{'role': 'user', 'content': R.result_message('t1', tool, r, 5)}], ctx.forbidden_extra)
        self.assertGreater(calls, 1000)

    def test_guard_is_not_vacuous_raw_view_leaks_for_every_case(self):
        for c in suite_cases():
            raw = json.dumps(P.case_view(c, R.resolve_evidence(c, SUITE), case_alias=c['id']), sort_keys=True)   # what v1 sent
            with self.assertRaises(L.LeakError, msg=c['id']):
                L.check_messages(c, [{'role': 'user', 'content': raw}])

    def test_unredacted_replay_output_would_leak_for_fixture_cases(self):
        leaking = 0
        for c in suite_cases():
            if (c.get('fixture') or {}).get('kind') != 'local' or not c['fixture']['locator'].startswith('fixtures/media/'):
                continue
            ctx = self.context(c)
            ctx.redact = lambda t: t
            for tool in c['tools_available']:
                r = T.call_tool(ctx, tool, {'at': 0})
                if L.find_leaks(c, r['output'], ctx.forbidden_extra):
                    leaking += 1
        self.assertGreater(leaking, 10)   # redaction is doing real work

    def test_end_to_end_requests_never_contain_the_real_id_or_fixture_names(self):
        for cid in ('tv-corrupt-003', 'movie-corrupt-001', 'audiobook-corrupt-001', 'epub-corrupt-002', 'tv-healthy-004'):
            c = next(x for x in suite_cases() if x['id'] == cid)
            ad = A.ScriptedAdapter('m', [th.tool_call('ffprobe') if 'ffprobe' in c['tools_available'] else th.tool_call('epub_inspect'), th.decision()])
            rec = R.run_case(c, 'sha', ad, SUITE, tempfile.mkdtemp(), which=NO_BINARIES, run_id='run-x')
            sent = json.dumps(ad.calls)
            self.assertNotIn(cid, sent)
            self.assertNotIn(Path(c['fixture']['locator']).name, sent)
            self.assertEqual(rec['model_case_alias'], L.alias('run-x', cid))
            self.assertEqual(rec['case_id'], cid)           # the real id stays in the record only

    def test_system_prompt_names_no_case(self):
        for c in suite_cases():
            self.assertNotIn(c['id'], P.SYSTEM_PROMPT)


if __name__ == '__main__':
    unittest.main()
