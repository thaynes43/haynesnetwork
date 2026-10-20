"""dev-c2 tests: the opt-in live evidence mode, the replay-identity guarantee, `unavailable` as a first-class status, and the
capabilities / gaps record.  No ffmpeg, no network, no model: a fake collector runner (or a fake `collect`) stands in for the binaries
and ScriptedAdapter for the model."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import adapters as A
import audit as AU
import evidence
import gaps as GP
import leakguard
import protocol as P
import replay_identity as RI
import run as R
import th
import tools as T
from evidence import test_evidence as TE

HERE = Path(__file__).resolve().parent
SUITE = HERE.parent / 'suite'
GOLDEN = HERE / 'testdata' / 'replay-identity-dev-c1.json'
FIX = th.TESTDATA / 'fixtures'
NAME = 'flip-hevc-answer.mkv'   # a fixture name that encodes the answer, as the real suite's do


def media_case(**kw):
    kw.setdefault('fixture', {'kind': 'local', 'locator': 'media/' + NAME})
    kw.setdefault('media', 'tv')
    return th.make_case(id='wiring-001', **kw)


def make_suite(case, with_file=True):
    ts = th.TempSuite([case])
    if with_file:
        ts.add_file('media/' + NAME, b'not really media' * 100)
    return ts


def ctx_live(case, ts, runner=None, which=('ffmpeg', 'ffprobe'), collect=None, bounds=None, **kw):
    fx = T.Fixture.from_case(case, ts.root)
    return T.Context(case, fx, tempfile.mkdtemp(), suite_dir=ts.root, evidence_mode='live', which=lambda n: None, collect=collect,
                     evidence_runner=runner, evidence_which=TE.which_with(*which), evidence_bounds=bounds, **kw)


def fake(rules):
    return TE.Fake(list(rules) + TE.VERSION)


PROBE_OK = (TE.prog('ffprobe', '-show_format'), TE.RunResult(0, TE.probe_json(chapters=[(0, 10, 'A'), (10, 20, 'B')]), b''))


class ReplayIdentity(unittest.TestCase):
    """Replay is the default and must show the model exactly what dev-c1 showed: the digests below were computed from the dev-c1 tool
    layer (git 617e6ad4, before this wiring) over every dev-suite case, every offered tool and a fixed argument set."""

    def test_every_dev_suite_case_shows_the_model_what_dev_c1_showed(self):
        golden = json.loads(GOLDEN.read_text())
        now = RI.digest_suite(SUITE)
        self.assertEqual(sorted(now), sorted(golden['cases']), 'the suite changed: the golden must be regenerated from the reference code')
        for key, want in golden['cases'].items():
            self.assertEqual(now[key]['case_sha256'], want['case_sha256'], 'case file changed: ' + key)
            self.assertEqual(now[key]['view'], want['view'], 'case view differs: ' + key)
            self.assertEqual(now[key]['calls'], want['calls'], 'tool output differs: ' + key)
        self.assertEqual(len(now), 73)

    def test_explicit_replay_equals_the_default(self):
        case = th.make_case(fixture={'kind': 'none'})
        a, b = [], []
        for sink, kw in ((a, {}), (b, {'evidence_mode': 'replay'})):
            ad = A.ScriptedAdapter('s', [th.tool_call('arr_lookup'), th.decision('healthy', 'none')])
            R.run_case(case, 'sha', ad, tempfile.mkdtemp(), tempfile.mkdtemp(), run_id='r', prompt_version='v2', **kw)
            sink.append(ad.calls)
        self.assertEqual(a, b)

    def test_what_the_model_sees_has_no_mode_or_gap_fields(self):
        case = th.make_case(fixture={'kind': 'none'})
        ad = A.ScriptedAdapter('s', [th.tool_call('arr_lookup'), th.decision('healthy', 'none')])
        rec = R.run_case(case, 'sha', ad, tempfile.mkdtemp(), tempfile.mkdtemp(), run_id='r', prompt_version='v2')
        shown = json.dumps(ad.calls)
        for word in ('evidence_mode', 'gaps', 'capabilities', 'live_ran', 'args_ignored'):
            self.assertNotIn(word, shown)
        self.assertEqual(rec['evidence_mode'], 'replay')
        self.assertEqual(rec['tool_calls'][0]['evidence_mode'], 'replay')

    def test_replay_tool_results_still_say_how_they_were_served(self):
        case = media_case()
        ts = make_suite(case)
        ctx = T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp(), suite_dir=ts.root, which=lambda n: None)
        res = T.call_tool(ctx, 'ffprobe', {})
        self.assertEqual((res['status'], res['evidence_mode']), ('unavailable', 'replay'))   # nothing recorded for this item, nothing ran
        ts.cleanup()


class LiveGate(unittest.TestCase):
    def test_default_is_replay_and_never_calls_a_collector(self):
        case = media_case()
        ts = make_suite(case)
        called = []
        ctx = T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp(), suite_dir=ts.root, which=lambda n: None,
                        collect=lambda *a, **k: called.append(1))
        T.call_tool(ctx, 'ffprobe', {})
        self.assertEqual(called, [])
        ts.cleanup()

    def test_missing_path_is_unavailable_with_the_reason_and_runs_nothing(self):
        case = media_case()
        ts = make_suite(case, with_file=False)
        called = []
        ctx = ctx_live(case, ts, collect=lambda *a, **k: called.append(1))
        for tool in T.LIVE_KINDS:
            res = T.call_tool(ctx, tool, {})
            self.assertEqual(res['status'], 'unavailable', tool)
            self.assertIn('does not exist', res['output'])
            self.assertEqual((res['evidence_mode'], res['live_ran']), ('live', False))
            self.assertNotIn(NAME, res['output'])
        self.assertEqual(called, [])
        ts.cleanup()

    def test_no_fixture_pinned_and_remote_are_unavailable_in_live(self):
        for fx, word in (({'kind': 'none'}, 'no media fixture'), ({'kind': 'remote', 'locator': 'sonarr item 1', 'sha256': 'x' * 64}, 'recorded observation'),
                         ({'kind': 'remote', 'locator': 'remote:media/sonarr:/tv/x.mkv'}, 'remote host')):
            case = media_case(fixture=fx)
            ts = make_suite(case, with_file=False)
            called = []
            ctx = ctx_live(case, ts, collect=lambda *a, **k: called.append(1))
            res = T.call_tool(ctx, 'ffprobe', {})
            self.assertEqual(res['status'], 'unavailable')
            self.assertIn(word, res['output'])
            self.assertEqual(called, [])
            ts.cleanup()

    def test_a_directory_is_refused_for_single_file_tools_but_not_for_audiobooks(self):
        case = media_case(fixture={'kind': 'local', 'locator': 'media'})
        ts = make_suite(case)
        seen = []
        ctx = ctx_live(case, ts, collect=lambda path, kinds, bounds, **kw: seen.append(kinds) or [_rec('audiobook', 'ok')])
        self.assertEqual(T.call_tool(ctx, 'ffprobe', {})['status'], 'unavailable')
        self.assertEqual(T.call_tool(ctx, 'audiobook_inspect', {})['status'], 'ok')
        self.assertEqual(seen, [['audiobook']])
        ts.cleanup()

    def test_arr_lookup_is_not_media_and_is_unchanged_in_live(self):
        case = media_case()
        ts = make_suite(case, with_file=False)
        res = T.call_tool(ctx_live(case, ts), 'arr_lookup', {})
        self.assertEqual((res['status'], res['evidence_mode']), ('ok', 'live'))
        self.assertIn('"stub": true', res['output'])
        ts.cleanup()

    def test_an_injected_failure_still_replaces_the_result_without_running_the_collector(self):
        case = media_case(inject_tool_failure={'tool': 'ffprobe', 'mode': 'timeout'})
        ts = make_suite(case)
        called = []
        res = T.call_tool(ctx_live(case, ts, collect=lambda *a, **k: called.append(1)), 'ffprobe', {})
        self.assertEqual((res['status'], res['injected'], called), ('timeout', True, []))
        ts.cleanup()


def _rec(kind, status, mode='live', **kw):
    base = {'tool': kind, 'harness_tool': evidence.core.HARNESS_TOOL[kind], 'tool_version': 'fake 1', 'mode': mode, 'status': status,
            'coverage': {'verified': [], 'not_verified': []}, 'bounds': {}, 'stderr': '', 'elapsed_s': 0.01, 'output': {},
            'input': {'name': NAME, 'bytes': 1600, 'head_1m_sha256': 'a' * 64, 'tail_1m_sha256': 'b' * 64, 'partial_fingerprint_only': True}}
    base.update(kw)
    return base


class LiveCollection(unittest.TestCase):
    def setUp(self):
        self.case = media_case()
        self.ts = make_suite(self.case)

    def tearDown(self):
        self.ts.cleanup()

    def test_probe_ok_through_the_real_collector_and_a_fake_runner(self):
        f = fake([PROBE_OK])
        res = T.call_tool(ctx_live(self.case, self.ts, runner=f), 'ffprobe', {})
        self.assertEqual((res['status'], res['mode'], res['evidence_mode'], res['live_ran']), ('ok', 'live', 'live', True))
        body = json.loads(res['output'])
        self.assertEqual((body['status'], body['mode']), ('ok', 'live'))
        self.assertEqual(body['output']['chapter_count'], 2)
        self.assertTrue(body['coverage']['not_verified'])
        self.assertEqual(res['evidence']['kind'], 'probe')
        self.assertEqual(res['evidence']['coverage'], body['coverage'])

    def test_the_media_file_is_opened_read_only_and_never_changed(self):
        p = self.ts.root / 'media' / NAME
        before = (p.read_bytes(), p.stat().st_mtime_ns)
        f = fake([PROBE_OK])
        T.call_tool(ctx_live(self.case, self.ts, runner=f), 'ffprobe', {})
        self.assertEqual((p.read_bytes(), p.stat().st_mtime_ns), before)
        argv = [c[0] for c in f.calls if '-show_format' in c[0]][0]
        self.assertIsInstance(argv, list)
        self.assertTrue(argv[-1].startswith('/') and argv[-1].endswith(NAME))   # absolute path, from the fixture, never from args

    def test_the_model_cannot_choose_the_path(self):
        f = fake([PROBE_OK])
        T.call_tool(ctx_live(self.case, self.ts, runner=f), 'ffprobe', {'path': '/etc/passwd', 'file': '/etc/shadow'})
        self.assertTrue(all('/etc/' not in ' '.join(c[0]) for c in f.calls))

    def test_missing_binary_is_unavailable_not_error(self):
        res = T.call_tool(ctx_live(self.case, self.ts, runner=fake([]), which=()), 'ffprobe', {})
        self.assertEqual(res['status'], 'unavailable')
        self.assertNotIn('evidence_status', res)
        self.assertIn('ffprobe not found', json.loads(res['output'])['reason'])
        self.assertEqual(res['evidence']['status'], 'unavailable')

    def test_damaged_input_is_an_error_finding_with_cause_input(self):
        bad = TE.RunResult(1, b'', ('%s: Invalid data found when processing input\n' % (self.ts.root / 'media' / NAME)).encode())
        res = T.call_tool(ctx_live(self.case, self.ts, runner=fake([(TE.prog('ffprobe', '-show_format'), bad)])), 'ffprobe', {})
        self.assertEqual((res['status'], res['evidence']['cause']), ('error', 'input'))
        self.assertNotIn(NAME, res['output'])
        self.assertTrue(AU.usable_as_support(res['status'], res['output'], False, res['evidence']['cause']))   # a finding about the file
        self.assertFalse(AU.usable_as_support('error', 'collector crashed', False, 'tool'))                    # a tool failure is not

    def test_collector_timeout_is_a_timeout_result(self):
        slow = TE.RunResult(None, b'', b'', timed_out=True)
        res = T.call_tool(ctx_live(self.case, self.ts, runner=fake([(TE.prog('ffprobe', '-show_format'), slow)])), 'ffprobe', {})
        self.assertEqual(res['status'], 'timeout')
        self.assertIn('exceeded', json.loads(res['output'])['reason'])

    def test_a_hung_collector_hits_the_tool_timeout_without_blocking_the_run(self):
        def hang(*a, **k):
            time.sleep(1.5)
            return [_rec('probe', 'ok')]
        with mock.patch.object(T, 'TOOL_TIMEOUT_S', -4.9):   # call_tool waits TOOL_TIMEOUT_S + 5 s, so this makes the wait 0.1 s
            t0 = time.monotonic()
            res = T.call_tool(ctx_live(self.case, self.ts, collect=hang), 'ffprobe', {})
        self.assertEqual(res['status'], 'timeout')
        self.assertLess(time.monotonic() - t0, 1.4)

    def test_partial_collection_passes_through_with_what_was_not_verified(self):
        rec = _rec('decode', 'partial', reason='segment at 60s hit the deadline',
                   coverage={'verified': ['head decoded'], 'not_verified': ['segments after 60 s were not decoded', 'a clean sample does not prove whole-file health']})
        res = T.call_tool(ctx_live(self.case, self.ts, collect=lambda *a, **k: [rec]), 'decode_sample', {})
        self.assertEqual(res['status'], 'partial')
        self.assertIn('segments after 60 s', res['output'])
        self.assertEqual(res['evidence']['coverage']['not_verified'][0], 'segments after 60 s were not decoded')

    def test_no_path_or_fixture_name_reaches_the_model_and_the_leak_guard_passes(self):
        rec = _rec('audiobook', 'ok', stderr='error in %s' % NAME,
                   output={'files': [{'name': NAME, 'duration_s': 3.0}], 'note': 'part %s' % NAME})
        ctx = ctx_live(self.case, self.ts, collect=lambda *a, **k: [rec])
        res = T.call_tool(ctx, 'audiobook_inspect', {})
        self.assertNotIn(NAME, res['output'])
        self.assertNotIn(NAME, json.dumps(res['evidence']))       # the fingerprint keeps sizes and hashes, not the name
        self.assertNotIn('name', res['evidence']['input'])
        msg = R.result_message('t1', 'audiobook_inspect', res, 5)
        leakguard.check_messages(self.case, [{'role': 'user', 'content': msg}], ctx.forbidden_extra)   # raises LeakError on a leak

    def test_leak_guard_still_blocks_a_leaking_message(self):
        ctx = ctx_live(self.case, self.ts)
        with self.assertRaises(leakguard.LeakError):
            leakguard.check_messages(self.case, [{'role': 'user', 'content': 'the file is ' + NAME}], ctx.forbidden_extra)

    def test_arguments_map_onto_bounds_and_the_ones_with_no_effect_are_recorded(self):
        seen = []
        ctx = ctx_live(self.case, self.ts, bounds={'segments': 2}, collect=lambda path, kinds, bounds, **kw: seen.append((kinds, bounds)) or [_rec(kinds[0], 'ok')])
        res = T.call_tool(ctx, 'decode_sample', {'at': 60, 'full': True})
        self.assertEqual(seen[-1][0], ['decode'])
        self.assertTrue(seen[-1][1]['full_decode'])
        self.assertEqual(seen[-1][1]['segments'], 2)
        self.assertEqual(seen[-1][1]['deadline_s'], T.LIVE_DEADLINE_S)
        self.assertLess(T.LIVE_DEADLINE_S, P.TOOL_TIMEOUT_S)          # the collector ends before the tool timeout fires
        self.assertEqual(res['args_ignored'], ['at'])
        T.call_tool(ctx, 'frame_sample', {'at': 5})
        self.assertEqual((seen[-1][0], seen[-1][1]['ocr']), (['frames'], 'off'))
        T.call_tool(ctx, 'ocr', {'frame': 'frame@5'})
        self.assertEqual((seen[-1][0], seen[-1][1]['ocr']), (['frames'], 'auto'))
        T.call_tool(ctx, 'audio_sample', {'stream': 1})
        self.assertEqual(seen[-1][0], ['audio'])
        T.call_tool(ctx, 'epub_inspect', {})
        self.assertEqual(seen[-1][0], ['epub'])

    def test_ocr_without_an_ocr_engine_is_unavailable_but_the_frames_stay_visible(self):
        frames = _rec('frames', 'ok', output={'frames': [{'at_s': 0.5, 'state': 'ok', 'ocr': {'state': 'unavailable'}}], 'ocr': 'unavailable'},
                      coverage={'verified': ['1 frame decoded'], 'not_verified': ['on-screen text was not read (tesseract not found on PATH)']})
        ctx = ctx_live(self.case, self.ts, collect=lambda *a, **k: [frames])
        res = T.call_tool(ctx, 'ocr', {})
        self.assertEqual(res['status'], 'unavailable')
        self.assertIn('no OCR engine', json.loads(res['output'])['reason'])
        self.assertIn('1 frame decoded', res['output'])
        self.assertEqual(T.call_tool(ctx, 'frame_sample', {})['status'], 'ok')     # the frames tool itself answered
        with_text = _rec('frames', 'ok', output={'frames': [{'at_s': 0.5, 'state': 'ok', 'ocr': {'state': 'read', 'text': 'HELLO'}}], 'ocr': 'tesseract'})
        self.assertEqual(T.call_tool(ctx_live(self.case, self.ts, collect=lambda *a, **k: [with_text]), 'ocr', {})['status'], 'ok')

    def test_bad_arguments_are_still_bad_arguments(self):
        res = T.call_tool(ctx_live(self.case, self.ts, collect=lambda *a, **k: [_rec('decode', 'ok')]), 'decode_sample', {'at': 'soon'})
        self.assertEqual(res['status'], 'error')
        self.assertIn('bad arguments', res['output'])

    def test_output_stays_inside_the_cap_and_keeps_its_head(self):
        rec = _rec('probe', 'ok', coverage={'verified': ['v'], 'not_verified': ['n']}, output={'blob': 'x' * 30000})
        ctx = ctx_live(self.case, self.ts, collect=lambda *a, **k: [rec])
        res = T.call_tool(ctx, 'ffprobe', {})
        self.assertLessEqual(len(res['output'].encode()), P.TOOL_OUTPUT_BYTES)
        self.assertEqual(json.loads(res['output'])['status'], 'ok')    # still valid JSON: the output part is what was cut

    def test_real_epub_collector_on_a_real_file(self):
        case = media_case(fixture={'kind': 'local', 'locator': str(FIX / 'td-right.epub')}, media='epub')
        ctx = T.Context(case, T.Fixture.from_case(case, FIX), tempfile.mkdtemp(), evidence_mode='live', which=lambda n: None)
        res = T.call_tool(ctx, 'epub_inspect', {})
        self.assertEqual((res['status'], res['mode'], res['evidence_mode']), ('ok', 'live', 'live'))
        self.assertIn('The Lantern Ledger', res['output'])
        bad = media_case(fixture={'kind': 'local', 'locator': str(FIX / 'td-corrupt.epub')}, media='epub')
        res2 = T.call_tool(T.Context(bad, T.Fixture.from_case(bad, FIX), tempfile.mkdtemp(), evidence_mode='live', which=lambda n: None), 'epub_inspect', {})
        self.assertEqual((res2['status'], res2['evidence']['cause']), ('error', 'input'))


class UnavailableIsFirstClass(unittest.TestCase):
    def test_tool_result_and_evidence_agree_on_the_status_set(self):
        self.assertIn('unavailable', T.STATUSES)
        self.assertEqual(set(T.STATUSES), set(evidence.STATUSES))

    def test_to_tool_result_is_no_longer_relabelled(self):
        tr = evidence.to_tool_result(_rec('probe', 'unavailable', reason='ffprobe not found on PATH'))
        self.assertEqual(tr['status'], 'unavailable')
        self.assertNotIn('evidence_status', tr)
        for status in evidence.STATUSES:
            self.assertEqual(evidence.to_tool_result(_rec('probe', status))['status'], status)
        # and the harness ToolResult accepts it as it is
        self.assertEqual(T.ToolResult(tr['status'], tr['output']).bounded()['status'], 'unavailable')


class CapabilitiesAndGaps(unittest.TestCase):
    def call(self, id, tool, status, mode='live', output='', **kw):
        return dict({'id': id, 'tool': tool, 'status': status, 'evidence_mode': mode, 'output': output, 'args': {}}, **kw)

    def test_non_ok_results_become_gaps_that_name_the_tool_needed(self):
        case = th.make_case(tools_available=['ffprobe', 'decode_sample', 'audio_sample'])
        calls = [self.call('t1', 'ffprobe', 'unavailable', output='ffprobe is not installed in this environment', evidence={'reason': 'ffprobe not found on PATH', 'coverage': {'verified': [], 'not_verified': ['everything: no ffprobe']}}),
                 self.call('t2', 'decode_sample', 'partial', evidence={'reason': 'deadline', 'coverage': {'verified': ['head'], 'not_verified': ['tail window']}}),
                 self.call('t3', 'audio_sample', 'timeout', output='audio extraction timed out'),
                 self.call('t4', 'epub_inspect', 'unavailable', output='not offered', protocol_violation='tool_not_offered')]
        s = GP.evidence_summary(case, calls, 'live', {'evidence_refs': ['t2']}, live_kinds=T.LIVE_KINDS)
        by = {g['call']: g for g in s['gaps']}
        self.assertEqual((by['t1']['type'], by['t1']['needed_tool'], by['t1']['reason']), ('not_run', 'ffprobe', 'ffprobe not found on PATH'))
        self.assertEqual((by['t2']['type'], by['t2']['area']), ('incomplete', 'tail window'))
        self.assertEqual(by['t3']['type'], 'not_run')
        self.assertIn('not offered', by['t4']['needed_note'])
        self.assertEqual(s['gaps_cited'], [by['t2']['id']])
        offered = {c['tool']: c['offered'] for c in s['capabilities']}
        self.assertEqual((offered['ffprobe'], offered['epub_inspect']), (True, False))
        self.assertEqual(s['mode'], 'live')
        self.assertEqual([c for c in s['capabilities'] if c['tool'] == 'ffprobe'][0]['statuses'], {'unavailable': 1})

    def test_a_damage_finding_is_evidence_not_a_gap_and_an_ok_sample_keeps_its_standing_limits(self):
        case = th.make_case()
        found = self.call('t1', 'ffprobe', 'error', evidence={'cause': 'input', 'coverage': {'verified': [], 'not_verified': []}})
        ok = self.call('t2', 'decode_sample', 'ok', evidence={'coverage': {'verified': ['3 windows clean'], 'not_verified': ['a clean sample does not prove whole-file health']}})
        gaps = GP.evidence_summary(case, [found, ok], 'live')['gaps']
        self.assertEqual([(g['call'], g['type']) for g in gaps], [('t2', 'standing')])
        self.assertEqual(gaps[0]['needed_tool'], 'decode_sample')

    def test_replay_samples_carry_a_standing_gap_and_replay_damage_is_a_finding(self):
        case = th.make_case()
        s = GP.evidence_summary(case, [self.call('t1', 'decode_sample', 'ok', 'replay'),
                                       self.call('t2', 'epub_inspect', 'error', 'replay', output='{"stage": "zip_open", "error": "BadZipFile"}'),
                                       self.call('t3', 'decode_sample', 'ok', 'replay', args={'full': True})], 'replay')
        self.assertEqual([(g['call'], g['type']) for g in s['gaps']], [('t1', 'standing')])

    def test_summary_is_json_and_not_scored(self):
        s = GP.evidence_summary(th.make_case(), [], 'replay')
        json.dumps(s)
        self.assertEqual(s['gaps'], [])
        self.assertIn('not scored', s['note'])


class RunRecords(unittest.TestCase):
    def run_live(self, case, ts, replies, **kw):
        ad = A.ScriptedAdapter('s', replies)
        rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), run_id='r', prompt_version='v2', evidence_mode='live', **kw)
        return rec, ad

    def test_live_run_record_says_live_and_carries_gaps_an_escalation_can_cite(self):
        case = media_case(tools_available=['ffprobe', 'decode_sample', 'arr_lookup'])
        ts = make_suite(case)
        rec, ad = self.run_live(case, ts, [th.tool_call('ffprobe'), th.tool_call('decode_sample'),
                                           th.decision('insufficient_evidence', 'escalate', refs=['t2'], reason='decode was unavailable')],
                                evidence_runner=fake([]), evidence_which=TE.which_with())
        self.assertEqual(rec['evidence_mode'], 'live')
        self.assertEqual([c['evidence_mode'] for c in rec['tool_calls']], ['live', 'live'])
        self.assertEqual([c['status'] for c in rec['tool_calls']], ['unavailable', 'unavailable'])
        ev = rec['evidence']
        self.assertEqual(ev['mode'], 'live')
        self.assertEqual({g['call'] for g in ev['gaps']}, {'t1', 't2'})
        self.assertEqual(ev['gaps_cited'], [g['id'] for g in ev['gaps'] if g['call'] == 't2'])
        self.assertEqual(rec['unverified_parts'][0]['status'], 'unavailable')
        self.assertEqual(R.record_missing_fields(dict(rec, harness_git_sha='x', config_hash='h', run_id='r')), [])
        self.assertIs(rec['action_audit']['executed'], False)
        shown = json.dumps(ad.calls)
        last = json.loads(ad.calls[-1][-1]['content'])
        self.assertEqual((last['type'], last['status']), ('tool_result', 'unavailable'))
        self.assertNotIn('gaps', shown)
        ts.cleanup()

    def test_a_case_without_local_media_gets_unavailable_in_a_live_run(self):
        case = th.make_case(fixture={'kind': 'none'})
        ts = th.TempSuite([case])
        rec, _ = self.run_live(case, ts, [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        self.assertEqual(rec['tool_calls'][0]['status'], 'unavailable')
        self.assertIn('no media fixture', rec['tool_calls'][0]['output'])
        ts.cleanup()

    def test_main_writes_the_mode_to_manifest_summary_and_records(self):
        case = media_case(tools_available=['ffprobe'])
        ts = make_suite(case)
        out = Path(tempfile.mkdtemp()) / 'run'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v2', '--evidence', 'live', '--evidence-bounds', '{"segments": 2}'])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 0)
        man = json.loads((out / 'manifest.json').read_text())
        self.assertEqual((man['config']['evidence_mode'], man['config']['evidence_bounds']), ('live', {'segments': 2}))
        s = json.loads((out / 'run_summary.json').read_text())
        self.assertEqual((s['harness_version'], s['evidence_mode']), ('dev-c2', 'live'))
        self.assertEqual(s['evidence']['tool_calls_by_evidence_mode'], {'live': 1})
        self.assertTrue(s['records_complete'], s['incomplete_records'])
        rec = json.loads((out / (case['id'] + '.json')).read_text())
        self.assertEqual((rec['evidence_mode'], rec['harness_version']), ('live', 'dev-c2'))
        ts.cleanup()

    def test_default_main_run_is_replay_and_refuses_bounds_without_live(self):
        case = th.make_case(fixture={'kind': 'none'})
        ts = th.TempSuite([case])
        out = Path(tempfile.mkdtemp()) / 'run'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', [th.decision('healthy', 'none')])
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', 'v2'])
            self.assertEqual(json.loads((out / 'manifest.json').read_text())['config']['evidence_mode'], 'replay')
            with self.assertRaises(SystemExit):
                R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out.parent / 'run2'), '--evidence-bounds', '{"segments": 2}'])
            with self.assertRaises(SystemExit):   # an unknown bound is refused, never silently ignored
                R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out.parent / 'run3'), '--evidence', 'live', '--evidence-bounds', '{"nope": 1}'])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 0)
        ts.cleanup()

    def test_nothing_in_a_live_record_claims_a_repair(self):
        case = media_case(tools_available=['ffprobe'])
        ts = make_suite(case)
        rec, _ = self.run_live(case, ts, [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')], evidence_runner=fake([PROBE_OK]), evidence_which=TE.which_with('ffprobe', 'ffmpeg'))
        text = json.dumps(rec['evidence']).lower()
        for word in ('repaired', 'fixed', 'executed: true'):
            self.assertNotIn(word, text)
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
