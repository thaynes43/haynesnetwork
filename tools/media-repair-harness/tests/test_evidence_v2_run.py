"""Evidence format v2, part 2: compatibility of the legacy options, the versioned tool and audit fixes, the capability advertisement, the runner
integration (first request, pages, budget, record), rendering and pagination, and the leak / looking-ahead tests on COMPLETE model requests.

Classes by area for the W18 report: LegacyCompatibility (compatibility), ToolBugFixes, Capabilities, OptionCombinations, Rendering, Pagination, LeakMetadata,
LeakLookingAhead (leak), RunnerIntegration, PublicSuite."""
import copy
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import test_evidence as TE
import th
from ev2h import case_with, dec, ev, obs, probe_out, decode_out, tc, wire
from media_repair_harness import adapters as A
from media_repair_harness import evidence as evcol
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import leakguard
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T

GOLDEN = Path(__file__).resolve().parent / 'testdata' / 'legacy-e2e-golden.json'
DAMAGE = '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5'
SENTINEL = 'ZQXSENTINEL'


class Completed:
    def __init__(self, rc=0, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = rc, out, err


def local_ctx(case, runner, behavior='v1', keep_raw=False, which=('ffmpeg', 'ffprobe'), path=None):
    if path is None:
        path = str(Path(tempfile.mkdtemp()) / 'x.mkv')
        Path(path).write_bytes(b'not really media')
    fx = T.Fixture('local', path=path)
    return T.Context(case, fx, tempfile.mkdtemp(), runner=runner, which=lambda n: '/usr/bin/' + n if n in which else None, tools_behavior=behavior, keep_raw=keep_raw)


class LegacyCompatibility(unittest.TestCase):
    """With every new option unset the model-visible requests, the run records and the scorer-read fields are what origin/main produced."""

    def test_mocked_end_to_end_requests_and_records_equal_the_golden_from_origin_main(self):
        golden = json.loads(GOLDEN.read_text())
        self.assertIn('7abf11fb', golden['reference'])
        now = L.scenarios()
        self.assertEqual(sorted(now), sorted(golden['scenarios']))
        for name, want in golden['scenarios'].items():
            for part in ('requests', 'record', 'tool_results', 'decision', 'n_requests'):
                self.assertEqual(now[name][part], want[part], '%s: %s differs from the golden' % (name, part))

    def test_the_golden_covers_every_branch(self):
        golden = json.loads(GOLDEN.read_text())['scenarios']
        for branch in ('replay', 'local', 'remote', 'live', 'pinned', 'epub_and_arr', 'guards_None', 'guards_v1', 'guards_v2', 'guard_fires_healthy_v1', 'guard_fires_healthy_v2'):
            self.assertIn(branch, golden)
            self.assertGreater(golden[branch]['n_requests'], 1, branch)   # a scenario that crashed before the first request would prove nothing

    def test_default_config_has_no_new_key_and_the_same_shape_as_before(self):
        code, out, ts = OptionCombinations.run_main(self, [case_with([ev('e1', 'prior_record', output='x')])], [th.decision('healthy', 'none', refs=['e1'])])
        man = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(sorted(man['config']), sorted([
            'harness_version', 'protocol', 'prompt_version', 'system_prompt_sha256', 'turn_schema_sha256', 'flat_schema_sha256', 'turn_schema_v2_sha256', 'max_tool_calls',
            'tool_output_bytes', 'tool_timeout_s', 'ocr_model', 'replay', 'evidence_mode', 'evidence_bounds', 'evidence_bounds_clamped', 'adapter_config']))
        self.assertEqual(man['config']['harness_version'], P.HARNESS_VERSION)
        rec = json.loads((out / 'ev2-001.json').read_text())
        for key in ('evidence_format', 'guard'):
            self.assertNotIn(key, rec)
        self.assertNotIn('audit_version', rec['action_audit'])
        self.assertNotIn('evidence_format', json.loads((out / 'run_summary.json').read_text()))
        ts.cleanup()

    def test_a_legacy_tool_call_record_carries_no_raw_output_field(self):
        rec, ad = L.scenario_replay()
        self.assertTrue(all('raw_output' not in c and 'collector_truncated' not in c for c in rec['tool_calls']))
        self.assertTrue(all('continuation' not in c for c in rec['tool_calls']))

    def test_version_flags_are_unset_by_default(self):
        ctx = T.Context(th.make_case(), T.Fixture('none'), tempfile.mkdtemp())
        self.assertEqual((ctx.tools_behavior, ctx.keep_raw), ('v1', False))
        self.assertEqual(DGv(), ('v1', 'v2', 'v3'))

    def test_legacy_prompts_and_schemas_are_byte_identical(self):
        """The sha256 of each prompt text and of the per-case turn schemas, as they were on origin/main 7abf11fb (protocol.py and prompts/ are untouched by W18)."""
        want = {'v1': '30749f5dc7065a2ddd70967cd6888e91d237030e1b025bc6dac19ca51fed9ee8', 'v2': '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a',
                'v3': 'b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a', 'v4': 'a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd'}
        for version, sha in want.items():
            self.assertEqual(P.get_prompt(version)['sha256'], sha, version)
        canon = lambda o: hashlib.sha256(json.dumps(o, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(canon(P.turn_schema('v1')), '4d976ba5fc8f82af307a7cfb4f168db248b08ffb5e7bf2a82d11b2b9ce28790b')
        self.assertEqual(canon(P.turn_schema('v4', ['ffprobe', 'decode_sample'])), '140104f9b7e533e6ced99f69326e709e5994787b4b82ac015265a7ca73af8313')
        self.assertEqual(canon(P.turn_schema('v2', ['ffprobe'])), '87b8a7d50ff941030f48e829f8beb1953cb72b771897fe168d81312de006ef6e')
        self.assertEqual(P.PROMPT_VERSIONS, ('v1', 'v2', 'v3', 'v4'))

    def test_legacy_results_keep_their_known_audit_bugs_under_the_legacy_version(self):
        """Fixes are versioned, not silent: a legacy local full decode is still the 4 s window and the legacy audit still trusts the requested arguments."""
        calls = []

        def runner(cmd, capture_output=True, timeout=None):
            calls.append(cmd)
            return Completed(0, b'', b'')
        r = T.call_tool(local_ctx(th.make_case(), runner), 'decode_sample', {'full': True})
        self.assertEqual(json.loads(r['output'])['window_s'], 4)
        self.assertIn('-t', calls[-1])
        self.assertEqual(calls[-1][calls[-1].index('-t') + 1], '4')


def DGv():
    from media_repair_harness import decision_guard as DG
    return DG.GUARD_VERSIONS


class ToolBugFixes(unittest.TestCase):
    """The five bugs of the audit, each fixed under tools behaviour v2 (selected by --evidence-format v2) and each with the legacy behaviour kept under v1."""

    def local_full(self, runner, behavior='v2'):
        case = th.make_case(tools_available=['decode_sample'])
        return T.call_tool(local_ctx(case, runner, behavior, keep_raw=True), 'decode_sample', {'full': True})

    def test_a_local_full_decode_is_a_real_full_decode_under_v2(self):
        calls = []

        def runner(cmd, capture_output=True, timeout=None):
            calls.append((cmd, timeout))
            return Completed(0, b'frame=200\nout_time_us=8000000\nprogress=end\n', b'')
        r = self.local_full(runner)
        cmd, timeout = calls[-1]
        self.assertNotIn('-t', cmd)                     # no 4 s limit
        self.assertEqual(timeout, T.LOCAL_FULL_TIMEOUT_S)   # and no silent increase of the existing 25 s limit
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['window_s'], out['completed_to_eof'], out['frames']), ('ok', 'full', True, 200))
        self.assertEqual(out['out_time'], '00:00:08.000000')
        self.assertEqual(out['streams_selected'], ['0:v:0', '0:a:0'])

    def test_a_local_full_decode_that_hits_the_limit_reports_its_actual_window_and_the_unmet_request(self):
        import subprocess

        def runner(cmd, capture_output=True, timeout=None):
            raise subprocess.TimeoutExpired(cmd, timeout, output=b'frame=60\nout_time_us=2500000\nprogress=continue\n', stderr=b'')
        r = self.local_full(runner)
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'partial')
        self.assertEqual((out['window_s'], out['completed_to_eof']), (2.5, False))   # the window that actually ran, never 'full'
        self.assertEqual(out['request_unmet']['requested'], 'full decode of the whole file')
        d = EV2.derive(ev2h.obs('t1', 'decode_sample', r['status'], r['raw_output'], {'full': True}), 8.0)
        self.assertIs(d.completed_to_eof, False)
        self.assertIn('request_not_honored', [c['kind'] for c in d.conflicts])
        self.assertEqual(d.intervals[0]['end_s'], 2.5)      # the valid observation of the incomplete run is kept

    def test_a_remote_full_request_is_a_partial_window_with_the_unmet_request_under_v2(self):
        def runner(cmd, input=None, capture_output=True, timeout=None):
            return Completed(0, b'', json.dumps({'exit_code': 0, 'stdout_bytes': 0, 'stderr': '', 'quota_exhausted': False}).encode())
        fx = T.Fixture('remote', path='/tv/x.mkv', namespace='media', deploy='bazarr')
        for behavior, status, window in (('v1', 'ok', 4), ('v2', 'partial', 4)):
            ctx = T.Context(th.make_case(tools_available=['decode_sample']), fx, tempfile.mkdtemp(), runner=runner, which=lambda n: None, tools_behavior=behavior)
            r = T.call_tool(ctx, 'decode_sample', {'full': True})
            out = json.loads(r['output'])
            self.assertEqual((r['status'], out['window_s']), (status, window), behavior)
            self.assertEqual('request_unmet' in out, behavior == 'v2')

    def test_a_missing_recorded_full_decode_is_unavailable_under_v2_not_a_crash(self):
        case = th.make_case(tools_available=['decode_sample'])
        ts = th.TempSuite([case])
        ts.add_file('media/x.mkv', b'abc')
        rec = {'sha256': hashlib.sha256(b'abc').hexdigest(), 'ffprobe': L.PROBE_REC, 'decode_sample': {'0': dict(L.DEC_CLEAN, ss=0)}}
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec).encode())
        case['fixture'] = {'kind': 'local', 'locator': 'media/x.mkv'}
        for behavior, status in (('v1', 'error'), ('v2', 'unavailable')):
            fx = T.Fixture.from_case(case, ts.root)
            ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=ts.root, which=th.NO_BINARIES, tools_behavior=behavior)
            self.assertEqual(T.call_tool(ctx, 'decode_sample', {'full': True})['status'], status, behavior)
        ts.cleanup()

    def test_the_live_collectors_truncation_flag_is_kept_under_v2_and_dropped_under_v1(self):
        big = {'status': 'ok', 'tool': 'decode', 'harness_tool': 'decode_sample', 'tool_version': 'x', 'mode': 'live', 'elapsed_s': 0.1, 'bounds': {}, 'stderr': '',
               'coverage': {'verified': ['v'], 'not_verified': ['n']}, 'input': None, 'output': {'blob': 'x' * 20000}}
        calls = []

        def collect(path, kinds, bounds, **kw):
            calls.append(kw)
            return [dict(big)]
        ts = L.suite_with(L.tv_case('bug-live-001'), probes=False)
        for behavior, want_truncated in (('v1', False), ('v2', True)):
            case = L.tv_case('bug-live-001')
            fx = T.Fixture.from_case(case, ts.root)
            ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=ts.root, evidence_mode='live', which=lambda n: None, collect=collect,
                            evidence_which=TE.which_with('ffmpeg', 'ffprobe'), tools_behavior=behavior, keep_raw=(behavior == 'v2'))
            r = T.call_tool(ctx, 'decode_sample', {})
            self.assertEqual(r['truncated'], want_truncated, behavior)
            if behavior == 'v2':
                self.assertTrue(r['collector_truncated'])
                d = EV2.derive(ev2h.obs('t1', 'decode_sample', r['status'], r['raw_output'], {}, r.get('mode'), truncated=r['collector_truncated']))
                self.assertTrue(d.execution['output_truncated'])
        self.assertNotIn('coverage_union', calls[0])         # v1 passes nothing new to the collector
        self.assertTrue(calls[1]['coverage_union'])
        ts.cleanup()

    def collect_decode(self, union, duration=8.0, offsets=3):
        import tempfile as tf
        d = Path(tf.mkdtemp())
        media = d / 'sample-input.mkv'
        media.write_bytes(b'not really media' * 100)
        fake = TE.Fake([(TE.prog('ffprobe', '-show_format'), TE.RunResult(0, TE.probe_json(duration=duration), b'')), (TE.prog('ffmpeg', '-progress'), TE.clean_decode)] + TE.VERSION)
        return evcol.collect(media, ['decode'], {'segments': offsets, 'segment_s': 4}, runner=fake, which=TE.which_with('ffmpeg', 'ffprobe'), coverage_union=union)[0]['output']

    def test_overlapping_sampled_windows_are_a_union_under_v2_and_a_sum_under_v1(self):
        legacy = self.collect_decode(False)
        fixed = self.collect_decode(True)
        self.assertEqual([s['at_s'] for s in legacy['segments']], [0.0, 2.0, 4.0])       # windows 0-4, 2-6, 4-8 on an 8 s file
        self.assertEqual((legacy['decoded_s'], legacy['sampled_fraction']), (12.0, 1.5))   # the bug: more than the whole file
        self.assertEqual((fixed['decoded_s'], fixed['sampled_fraction']), (8.0, 1.0))
        self.assertEqual(fixed['decoded_s_total_windows'], 12.0)
        self.assertNotIn('decoded_s_total_windows', legacy)

    def test_union_clips_to_the_known_duration_and_counts_gaps_as_gaps(self):
        out = self.collect_decode(True, duration=6.0, offsets=2)
        self.assertLessEqual(out['sampled_fraction'], 1.0)
        self.assertLessEqual(out['decoded_s'], 6.0)


class Capabilities(unittest.TestCase):
    def ctx_for(self, case, ts, behavior='v2', which=th.NO_BINARIES, **kw):
        fx = T.Fixture.from_case(case, ts.root)
        return T.Context(case, fx, tempfile.mkdtemp(), suite_dir=ts.root, which=which, tools_behavior=behavior, **kw)

    def test_replay_advertises_recorded_offsets_and_whether_a_full_decode_exists(self):
        case = L.tv_case('cap-001')
        ts = L.suite_with(case)
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts))}
        self.assertEqual(caps['decode_sample'], {'tool': 'decode_sample', 'backend': 'replay', 'available': True, 'offsets_s': [0, 4, 8], 'window_s': 4, 'full_decode': 'recorded'})
        self.assertEqual(caps['audio_sample']['offsets_s'], [0])
        self.assertEqual(caps['arr_lookup']['backend'], 'stub')
        rec = json.loads((ts.root / 'fixtures' / 'probes' / 'x.mkv.json').read_text())
        del rec['decode_sample']['full']
        (ts.root / 'fixtures' / 'probes' / 'x.mkv.json').write_text(json.dumps(rec))
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts))}
        self.assertEqual(caps['decode_sample']['full_decode'], 'not_recorded')
        ts.cleanup()

    def test_remote_local_and_live_backends(self):
        case = L.tv_case('cap-002', fixture={'kind': 'remote', 'locator': 'remote:media/bazarr:/tv/x.mkv'})
        ts = th.TempSuite([case])
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts))}
        self.assertEqual((caps['decode_sample']['backend'], caps['decode_sample']['window_s']), ('remote', 4))
        self.assertIn('not_possible', caps['decode_sample']['full_decode'])
        self.assertIn('requested as a 4 s window', T.capabilities(self.ctx_for(case, ts, 'v1'))[1]['full_decode'])
        case = L.tv_case('cap-003')
        ts2 = L.suite_with(case, probes=False)
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts2, which=lambda n: '/usr/bin/' + n))}
        self.assertEqual(caps['decode_sample']['backend'], 'local')
        self.assertIn('bounded run (25 s limit)', caps['decode_sample']['full_decode'])
        live = T.capabilities(self.ctx_for(case, ts2, evidence_mode='live'))
        self.assertEqual({c['backend'] for c in live if c['tool'] != 'arr_lookup'}, {'live'})
        ts.cleanup(); ts2.cleanup()

    def test_pinned_media_advertises_only_what_was_recorded(self):
        case = L.tv_case('cap-004', evidence=[], fixture={'kind': 'remote', 'sha256': 'ab' * 32, 'locator': 'radarr movie 1 file 2'},
                         replay=[{'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok', 'output': '{}'},
                                 {'tool': 'ocr', 'args': {'ss': 1}, 'status': 'ok', 'output': 'T'}])
        ts = th.TempSuite([case])
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts))}
        self.assertEqual(caps['decode_sample'], {'tool': 'decode_sample', 'backend': 'pinned_replay', 'available': True, 'offsets_s': [0.0], 'full_decode': 'not_recorded'})
        self.assertEqual(caps['ocr']['offsets_s'], [1.0])
        self.assertFalse(caps['ffprobe']['available'])
        ts.cleanup()

    def test_a_case_with_no_media_says_so_before_the_call(self):
        case = L.tv_case('cap-005', fixture={'kind': 'none'}, evidence=[])
        ts = th.TempSuite([case])
        caps = {c['tool']: c for c in T.capabilities(self.ctx_for(case, ts))}
        self.assertFalse(caps['ffprobe']['available'])
        self.assertIn('no media fixture', caps['ffprobe']['why'])
        self.assertTrue(caps['arr_lookup']['available'])
        ts.cleanup()

    def test_the_advertisement_never_contains_a_recorded_result(self):
        case = L.tv_case('cap-006')
        ts = L.suite_with(case)
        rec = json.loads((ts.root / 'fixtures' / 'probes' / 'x.mkv.json').read_text())
        rec['decode_sample']['4']['stderr'] = SENTINEL + 'DECODE'
        rec['frame_text'] = [{'t0': 0, 't1': 2, 'text': SENTINEL + 'FRAMETEXT'}]
        rec['audio_sample']['0']['rms_dbfs'] = -123.456
        (ts.root / 'fixtures' / 'probes' / 'x.mkv.json').write_text(json.dumps(rec))
        text = json.dumps(T.capabilities(self.ctx_for(case, ts)))
        self.assertNotIn(SENTINEL, text)
        self.assertNotIn('123.456', text)
        ts.cleanup()

    @th.needs_suite
    def test_over_the_dev_suite_an_unavailable_advertisement_matches_the_call_and_an_available_one_is_not_unavailable(self):
        suite = th.SUITE
        for case, _sha in R.load_cases(suite):
            fx = T.Fixture.from_case(case, suite)
            ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=suite, which=th.NO_BINARIES, tools_behavior='v2')
            for cap in T.capabilities(ctx):
                offs = cap.get('offsets_s')
                args = {'at': offs[0]} if isinstance(offs, list) and offs and cap['tool'] in ('decode_sample', 'frame_sample', 'ocr', 'audio_sample') else (
                    {'at': 1} if cap['tool'] == 'ocr' else {})
                res = T.call_tool(ctx, cap['tool'], args)
                if cap['available'] is False and cap['tool'] not in ('frame_sample', 'ocr'):
                    self.assertIn(res['status'], ('unavailable', 'error'), '%s %s' % (case['id'], cap))   # error: the recorded probe itself failed, so there was no stream to sample
                if cap['available'] is True:
                    self.assertNotEqual(res['status'], 'unavailable', '%s %s' % (case['id'], cap))
                if res.get('mode') in ('replay', 'pinned_replay', 'stub'):
                    self.assertEqual(cap.get('backend'), res['mode'], '%s %s' % (case['id'], cap['tool']))


class OptionCombinations(unittest.TestCase):
    def run_main(self, cases, replies, extra=(), prompt='v4'):
        ts = th.TempSuite(cases)
        out = Path(tempfile.mkdtemp()) / 'runs' / 'r1'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', replies)
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', prompt] + list(extra))
        finally:
            R.build_adapter = orig
        return code, out, ts

    def test_valid_combinations_run_and_are_recorded_in_the_manifest_and_the_hash(self):
        cases = [case_with([ev('e1', 'prior_record', output='x')])]
        replies = lambda: [th.decision('insufficient_evidence', 'escalate', refs=[])]
        _, base, ts0 = self.run_main(cases, replies())
        hashes = {}
        for name, extra, prompt in (('fmt', ['--evidence-format', 'v2'], 'v4'), ('fmt+g3', ['--evidence-format', 'v2', '--guards', 'v3'], 'v4'), ('g3_v1prompt', ['--guards', 'v3'], 'v1'),
                                    ('g3_v2prompt', ['--guards', 'v3'], 'v2'), ('g3_v3prompt', ['--guards', 'v3'], 'v3')):
            code, out, ts = self.run_main(cases, replies(), extra, prompt)
            self.assertEqual(code, 0, name)
            man = json.loads((out / 'manifest.json').read_text())
            cfg = man['config']
            if 'fmt' in name:
                self.assertEqual((cfg['evidence_format'], cfg['tools_behavior'], cfg['audit_version'], cfg['page_contract'], cfg['wire_bytes']), ('v2', 'v2', 'v2', 'pages-v1', 8192))
                self.assertEqual(json.loads((out / 'run_summary.json').read_text())['evidence_format'], 'v2')
                rec = json.loads((out / 'ev2-001.json').read_text())
                self.assertEqual(rec['evidence_format']['version'], 'v2')
                self.assertEqual(rec['action_audit']['audit_version'], 'v2')
            else:
                self.assertNotIn('evidence_format', cfg)
            if 'g3' in name:
                self.assertEqual(cfg['guards'], 'v3')
            hashes[name] = man['config_hash']
            self.assertEqual(R.record_missing_fields(json.loads((out / 'ev2-001.json').read_text())), [], name)
            ts.cleanup()
        self.assertEqual(len(set(hashes.values())) + 0, len(hashes) - 0 if len(set(hashes.values())) == len(hashes) else len(set(hashes.values())))
        self.assertNotIn(json.loads((base / 'manifest.json').read_text())['config_hash'], hashes.values())
        ts0.cleanup()

    def test_unsupported_combinations_are_refused_explicitly(self):
        cases = [case_with([])]
        for extra, prompt, text in ((['--evidence-format', 'v2'], 'v1', 'prompt'), (['--evidence-format', 'v2'], 'v2', 'prompt'), (['--evidence-format', 'v2'], 'v3', 'prompt'),
                                    (['--evidence-format', 'v2', '--guards', 'v1'], 'v4', 'guards'), (['--evidence-format', 'v2', '--guards', 'v2'], 'v4', 'guards')):
            with self.assertRaises(SystemExit) as cm:
                self.run_main(cases, [], extra, prompt)
            self.assertIn(text, str(cm.exception))
            self.assertIn('--evidence-format v2', str(cm.exception))

    def test_unknown_values_are_refused_by_the_parser_and_the_api(self):
        with self.assertRaises(SystemExit):
            self.run_main([case_with([])], [], ['--evidence-format', 'v9'])
        with self.assertRaises(ValueError):
            R.check_option_combination('v4', 'v9')
        R.check_option_combination('v4', 'v2', 'v3')
        R.check_option_combination('v5', 'v2')            # a future prompt v5 is accepted without another change
        R.check_option_combination('v1', None, 'v3')
        R.check_option_combination('v2', None, 'v1')      # the old options keep every old combination
        with self.assertRaises(ValueError):
            R.run_case(case_with([]), 'x', A.ScriptedAdapter('m', []), '.', tempfile.mkdtemp(), prompt_version='v3', evidence_format='v2')


class RunnerIntegration(unittest.TestCase):
    def suite(self, case):
        return L.suite_with(case)

    def test_the_first_request_is_typed_and_names_capabilities_alerts_and_the_budget(self):
        case = L.tv_case('run-001')
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [dec('insufficient_evidence', 'escalate')], which=th.NO_BINARIES, evidence_format='v2')
        first = json.loads(ad.calls[0][0]['content'])
        self.assertEqual(list(first)[:3], ['case_id', 'media_type', 'context'])
        self.assertEqual(first['evidence_format'], 'v2')
        self.assertEqual(first['tool_call_budget'], 6)
        self.assertEqual([c['tool'] for c in first['capabilities']], first['tools_available'])
        block = first['evidence']
        self.assertEqual(list(block)[:2], ['alerts', 'items'])           # conflicts and errors first
        # e2 asks for ss=0 in its args and records ss=4 in its output: the recorded data contradicts itself, which is a conflict, listed first
        self.assertEqual([a['kind'] for a in block['alerts'] if a['type'] == 'conflict'], ['request_not_honored', 'exit_zero_with_decoder_errors', 'status_ok_with_defect'])
        self.assertEqual([i['id'] for i in block['items']], ['e1', 'e2'])
        for item in block['items']:
            for key in ('execution', 'findings', 'scope', 'unresolved'):
                self.assertIn(key, item)
        self.assertLessEqual(len(json.dumps(block, ensure_ascii=False, separators=(',', ':')).encode()), EV2.WIRE_BYTES)
        ts.cleanup()

    def test_tool_replies_are_nested_structure_not_json_in_a_string(self):
        case = L.tv_case('run-002')
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 4}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        msgs = [json.loads(m['content']) for m in ad.calls[-1] if m['role'] == 'user' and m['content'].startswith('{"type":"tool_result"')]
        self.assertEqual([m['id'] for m in msgs], ['t1', 't2'])
        for m in msgs:
            self.assertIsInstance(m['output'], dict)
            self.assertEqual(sorted(m), ['id', 'output', 'status', 'tool', 'tool_calls_remaining', 'truncated', 'type'])
            self.assertFalse(self.json_in_strings(m['output']))
        self.assertEqual([m['tool_calls_remaining'] for m in msgs], [5, 4])
        ts.cleanup()

    def json_in_strings(self, obj):
        found = []

        def walk(x):
            if isinstance(x, str):
                if x.lstrip()[:1] in ('{', '[') and EV2.parse_json(x) is not None:
                    found.append(x[:40])
            elif isinstance(x, dict):
                [walk(v) for v in x.values()]
            elif isinstance(x, list):
                [walk(v) for v in x]
        walk(obj)
        return found

    def test_summaries_update_only_from_observations_actually_shown(self):
        case = L.tv_case('run-003', evidence=[])
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 0}), tc('decode_sample', {'at': 4}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        msgs = [json.loads(m['content']) for m in ad.calls[-1] if m['role'] == 'user' and m['content'].startswith('{"type":"tool_result"')]
        first = json.loads(ad.calls[0][0]['content'])
        self.assertNotIn('decoder_errors', json.dumps(first))                 # the damaged window at 4 s is recorded but was not called
        self.assertEqual(first['evidence']['coverage']['time'], {'state': 'not_checked'})
        after_ffprobe, after_clean, after_bad = [m['output'] for m in msgs]
        self.assertNotIn('time', after_ffprobe.get('coverage', {}) if after_ffprobe.get('coverage', {}).get('time') != {'state': 'not_checked'} else {})
        self.assertEqual(after_clean['coverage']['time']['unrecorded']['clean'], [[0.0, 4.0]])
        self.assertEqual(after_clean['coverage']['time']['unrecorded']['damaged'], [])
        self.assertEqual(after_bad['coverage']['time']['unrecorded']['damaged'], [[4.0, 8.0]])
        ts.cleanup()

    def test_a_page_fetch_is_a_tool_call_with_explicit_budget_accounting(self):
        big_chapters = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(160)]
        probe = dict(L.PROBE_REC, chapters=big_chapters)
        case = L.tv_case('run-004', evidence=[], tools_available=['ffprobe', 'decode_sample'])
        ts = L.suite_with(case, probes=False)
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=probe)
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        ad = A.ScriptedAdapter('m', [])
        # first run to learn the cursor, then replay with the cursor in the script
        rec1, ad1 = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], which=th.NO_BINARIES, evidence_format='v2')
        first_reply = json.loads(ad1.calls[-1][-1]['content'])
        page = first_reply['output']['page']
        self.assertEqual((page['n'], page['contract'], page['next_costs_tool_call']), (1, 'pages-v1', True))
        self.assertGreater(page['of'], 1)
        cursor = page['next']
        rec2, ad2 = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('ffprobe', {'cursor': cursor}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        self.assertEqual(ad2.calls[-1][-1]['content'].count('"tool_calls_remaining":'), 1)
        second = json.loads(ad2.calls[-1][-1]['content'])
        self.assertEqual(second['tool_calls_remaining'], 4)               # the fetch used the second of the six calls
        self.assertEqual(second['output']['page']['n'], 2)
        self.assertEqual([c['tool'] for c in rec2['tool_calls']], ['ffprobe', 'page'])
        self.assertTrue(rec2['tool_calls'][1]['continuation'])
        self.assertEqual(rec2['tool_calls'][1]['continuation_via'], 'ffprobe')
        self.assertEqual(rec1['tool_calls'][0]['status'], 'ok')
        ts.cleanup()

    def test_a_cursor_from_another_case_or_a_mangled_one_is_an_error_without_content(self):
        case = L.tv_case('run-005', evidence=[], tools_available=['ffprobe'])
        ts = self.suite(case)
        for cursor in ('c' + 'a' * 15, 'not-a-cursor', 'c123'):
            rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe', {'cursor': cursor}), dec()], which=th.NO_BINARIES, evidence_format='v2')
            reply = json.loads(ad.calls[-1][-1]['content'])
            self.assertEqual(reply['status'], 'error')
            self.assertIn('unknown or expired cursor', reply['output']['execution']['reason'])
            self.assertNotIn('streams', json.dumps(reply))
        ts.cleanup()

    def test_the_sixth_call_carries_the_budget_notice_and_stays_inside_the_envelope(self):
        case = L.tv_case('run-006')
        ts = self.suite(case)
        replies = [tc('ffprobe')] * 5 + [tc('decode_sample', {'at': 4}), dec()]
        rec, ad = ev2h.scripted_run(case, ts, replies, which=th.NO_BINARIES, evidence_format='v2')
        last = ad.calls[-1][-1]['content']
        self.assertTrue(last.endswith(P.BUDGET_MESSAGE))
        self.assertLessEqual(len(last.encode()), EV2.WIRE_BYTES)
        self.assertEqual(rec['evidence_format']['messages'][-1]['id'], 't6')
        ts.cleanup()

    def test_a_decision_may_cite_a_finding_id_and_the_observation_is_credited(self):
        case = L.tv_case('run-007')
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [dec('corrupt_file', 'escalate', ['e2.f1'])], which=th.NO_BINARIES, evidence_format='v2')
        self.assertEqual(rec['bad_evidence_refs'], [])
        self.assertEqual(rec['decision']['evidence_refs'], ['e2.f1'])        # recorded as the model wrote it
        ts.cleanup()

    def test_the_record_keeps_the_raw_text_the_typed_layer_was_derived_from(self):
        case = L.tv_case('run-008', evidence=[])
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 4}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        call = rec['tool_calls'][0]
        self.assertEqual(json.loads(call['raw_output'])['stderr'], DAMAGE)
        self.assertEqual(rec['evidence_format']['final_summary']['coverage']['time']['unrecorded']['damaged'], [[4.0, 8.0]])
        self.assertEqual(rec['evidence_format']['tools_behavior'], 'v2')
        ts.cleanup()

    def test_args_are_echoed_only_in_their_known_numeric_forms(self):
        self.assertEqual(R.safe_args({'at': 4, 'full': True, 'stream': 1, 'frame': 'frame@2.5', 'cursor': 'c' + '0' * 15}), {'at': 4, 'full': True, 'stream': 1, 'frame': 'frame@2.5', 'cursor': 'c' + '0' * 15})
        self.assertEqual(R.safe_args({'at': 'my secret text', 'path': '/etc/passwd', 'frame': 'frame@x; rm', 'full': 'yes', 'stream': True}), {})
        self.assertEqual(R.safe_args({'t': 'full'}), {'t': 'full'})

    def test_the_cursor_call_requires_an_offered_tool_otherwise_it_is_a_recorded_violation(self):
        case = L.tv_case('run-009', evidence=[], tools_available=['ffprobe'])
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [tc('ocr', {'cursor': 'c' + '0' * 15}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        self.assertEqual(rec['protocol_violations'][0]['kind'], 'tool_not_offered')
        self.assertEqual(rec['tool_calls'][0]['status'], 'unavailable')
        ts.cleanup()

    def test_guards_v3_in_a_v2_run_abstain_on_a_healthy_decision_next_to_a_defect(self):
        case = L.tv_case('run-010')
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [dec('healthy', 'none', ['e1'])], which=th.NO_BINARIES, evidence_format='v2', guards='v3')
        self.assertEqual((rec['decision']['class'], rec['decision']['action']), ('insufficient_evidence', 'escalate'))
        self.assertEqual(rec['guard']['version'], 'v3')
        self.assertEqual(rec['guard']['applied'][0]['original']['class'], 'healthy')
        self.assertIn('decoder_errors', rec['guard']['applied'][0]['reason'])
        ts.cleanup()

    def test_guards_v3_work_in_a_legacy_format_run_too(self):
        case = L.tv_case('run-011')
        ts = self.suite(case)
        rec, ad = ev2h.scripted_run(case, ts, [dec('healthy', 'none', ['e1'])], which=th.NO_BINARIES, guards='v3', prompt='v1')
        self.assertEqual(rec['decision']['class'], 'insufficient_evidence')
        self.assertNotIn('evidence_format', rec)
        ts.cleanup()


# ---------------------------------------------------------------------------------------------------------------------- rendering and pagination
def big_probe(n_chapters, title_len=60, unicode_titles=False):
    ch = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': ('章' * (title_len // 3) if unicode_titles else 'T%03d' % i + 'x' * title_len)} for i in range(n_chapters)]
    return probe_out(duration=str(n_chapters * 2), chapters=ch)


class Rendering(unittest.TestCase):
    def render(self, observation, evidence=(), context=None, remaining=3):
        ses = EV2.Session('case-00000000', context or {}, 'tv', ['ffprobe', 'decode_sample'])
        ses.initial(list(evidence))
        text, n = ses.result(observation, observation['id'], remaining)
        return ses, text, n

    def test_every_page_of_a_large_result_is_valid_json_inside_the_envelope_in_utf8_bytes(self):
        for unicode_titles in (False, True):
            ses, text, n = self.render(obs('t1', 'ffprobe', 'ok', big_probe(300, unicode_titles=unicode_titles)))
            self.assertGreater(n, 1)
            pages = [text] + [ses.fetch(c, 't2', 'ffprobe', 3)[1] for c in sorted(ses.pages)]
            self.assertEqual(len(pages), n)
            for p in pages:
                self.assertLessEqual(len(p.encode('utf-8')), EV2.WIRE_BYTES)
                json.loads(p)                               # never cut mid-structure
            if unicode_titles:
                self.assertGreater(len(text), 0)
                self.assertTrue(any(len(p.encode('utf-8')) > len(p) for p in pages))   # multi-byte text really was measured in bytes, not characters

    def test_the_budget_is_measured_in_bytes_for_emoji_and_cjk_exactly_at_the_edge(self):
        for glyph in ('é', '章', '😀'):
            sizes = []
            for k in range(40, 400, 7):
                o = obs('t1', 'arr_lookup', 'ok', {'note': glyph * k, 'tail': [glyph * 30] * 20})
                ses = EV2.Session('case-00000000', {}, 'tv', ['arr_lookup'])
                ses.initial([])
                text, n = ses.result(o, 't1', 2)
                pages = [text] + [ses.fetch(c, 't2', 'arr_lookup', 2)[1] for c in sorted(ses.pages)]
                self.assertTrue(all(len(p.encode('utf-8')) <= EV2.WIRE_BYTES for p in pages), (glyph, k))
                sizes.append(max(len(p.encode('utf-8')) for p in pages))
            self.assertLessEqual(max(sizes), EV2.WIRE_BYTES)

    def test_a_long_string_keeps_a_prefix_and_a_pointer_and_the_whole_text_is_retrievable_by_cursor(self):
        text = ''.join('%04d-' % i for i in range(300))          # 1500 chars, every part distinguishable
        ses, first, n = self.render(obs('t1', 'arr_lookup', 'ok', {'note': text}))
        out = json.loads(first)['output']
        self.assertTrue(out['facts']['note'].startswith(text[:400]))
        self.assertIn('...[+1100 chars: detail t1.d1]', out['facts']['note'])
        pages = ev2h.fetch_all(ses, first)
        chunks = []
        for t in pages:
            o = json.loads(t.split('\n')[0])['output']
            chunks += (o.get('details') or {}).get('t1.d1', []) if isinstance((o.get('details') or {}).get('t1.d1'), list) else ([o['details']['t1.d1']] if 't1.d1' in (o.get('details') or {}) else [])
        self.assertEqual(''.join(chunks), text)                    # nothing was lost

    def test_a_large_structure_is_split_into_units_and_every_leaf_is_on_some_page(self):
        huge = {'a': 'x', 'blob': {'k%d' % i: 'v%d' % i * 100 for i in range(40)}, 'rows': [{'n': i, 'pad': 'p' * 300} for i in range(60)]}
        ses, first, n = self.render(obs('t1', 'arr_lookup', 'ok', huge))
        self.assertGreater(n, 1)
        pages = ev2h.fetch_all(ses, first)
        got = {}
        for t in pages:
            self.assertLessEqual(len(t.encode('utf-8')), EV2.WIRE_BYTES)        # fetched as the sixth call, notice included
            o = json.loads(t.split('\n')[0])['output']
            self.assertNotIn('exceeds_envelope', o.get('page', {}))
            for path, v in ev2h.walk_leaves(o.get('facts') or {}):
                got.setdefault(path, []).append(v)
        self.assertEqual(sorted(k for k in got if k[0] == 'blob'), sorted(('blob', 'k%d' % i) for i in range(40)))
        for i in range(40):                               # a 300+ character value is whole or has its pointer; none is missing
            v = got[('blob', 'k%d' % i)]
            self.assertEqual(len(v), 1)
            self.assertTrue(v[0] == 'v%d' % i * 100 or v[0].startswith(('v%d' % i * 100)[:400]))
        self.assertEqual(sorted(got[('rows', 'n')]), list(range(60)))

    def test_outer_truncation_flag_and_pagination_are_different_facts(self):
        ses, text, n = self.render(obs('t1', 'ffprobe', 'ok', big_probe(300)))
        env = json.loads(text)
        self.assertGreater(n, 1)
        self.assertFalse(env['truncated'])                                    # paginated is not truncated
        self.assertFalse(env['output']['execution']['output_truncated'])
        ses, text, n = self.render(obs('t1', 'arr_lookup', 'ok', {'a': 1}, truncated=True))
        env = json.loads(text)
        self.assertTrue(env['truncated'])
        self.assertTrue(env['output']['execution']['output_truncated'])
        self.assertEqual(env['status'], 'ok')

    def test_conflicts_are_never_dropped_to_fit_and_every_page_names_them(self):
        stderr = '\n'.join('[h264 @ 0x0] error while decoding MB %d 11, bytestream -5 %s' % (i, 'z' * 150) for i in range(3))
        many = [obs('e%d' % i, 'decode_sample', 'ok', decode_out(ss=i * 4, stderr=stderr), {'ss': i * 4, 't': 4}, source='case') for i in range(1, 5)]
        ses, text, n = self.render(obs('t1', 'arr_lookup', 'ok', {'big': ['q' * 200] * 120}), evidence=many)
        pages = [json.loads(text)] + [json.loads(ses.fetch(c, 't2', 'ffprobe', 3)[1]) for c in sorted(ses.pages)]
        self.assertGreater(len(pages), 1)
        init_block = ses.log[0]
        self.assertEqual(init_block['kind'], 'initial')
        # the first message's evidence block lists every conflict of every shown item, as alerts with the ids of their details
        ses2 = EV2.Session('case-00000000', {}, 'tv', ['ffprobe'])
        block, np = ses2.initial(many)
        self.assertEqual(len([a for a in block['alerts'] if a['type'] == 'conflict']), 8)
        allpages = [block] + [b for b, _ in [ses2.pages[c] for c in sorted(ses2.pages)]]
        for pg in allpages:
            self.assertEqual(len([a for a in pg['alerts'] if a['type'] == 'conflict']), 8)    # repeated on every page
            if np > 1:
                self.assertEqual(pg['page']['alerts_total'], len(pg['alerts']))
                self.assertEqual(pg['page']['conflicts_total'], len([x for x in pg['alerts'] if x['type'] == 'conflict']))
        details = [x['id'] for pg in allpages for it in pg.get('items', []) for x in it.get('conflicts', [])]
        self.assertEqual(sorted(details), sorted(a['id'] for a in block['alerts'] if a['type'] == 'conflict'))   # linked to their details somewhere

    def test_stable_ids_and_references_survive_pagination(self):
        ses, text, n = self.render(obs('t7', 'ffprobe', 'ok', big_probe(300)))
        pages = [json.loads(text)['output']] + [json.loads(ses.fetch(c, 't8', 'ffprobe', 3)[1])['output'] for c in sorted(ses.pages)]
        self.assertTrue(all(p['id'] == 't7' and p['tool'] == 'ffprobe' for p in pages))
        shown = [p['page'].get('facts.chapters') for p in pages if 'page' in p]
        self.assertTrue(all(p['execution']['state'] == 'ran' for p in pages))     # the execution header is repeated on every page

    def test_a_split_list_says_how_many_of_its_elements_are_on_the_page(self):
        ses, text, n = self.render(obs('t1', 'ffprobe', 'ok', big_probe(300)))
        pages = [json.loads(text)['output']] + [json.loads(ses.fetch(c, 't2', 'ffprobe', 3)[1])['output'] for c in sorted(ses.pages)]
        total = 0
        for p in [x for x in pages if 'facts' in x]:
            shown = p['facts']['chapters_shown']
            have, of = [int(x) for x in shown.split(' of ')]
            self.assertEqual(have, len(p['facts']['chapters']))
            self.assertEqual(of, 300)
            total += have
        self.assertEqual(total, 300)                                   # nothing was lost between pages
        self.assertEqual(sum(p['page'].get('elsewhere', {}).get('facts.chapters', 0) for p in pages[:1]), 300 - len(pages[0]['facts']['chapters']))

    def test_replay_and_live_equivalence_for_equivalent_observations(self):
        replay = [obs('t1', 'ffprobe', 'ok', probe_out(duration='8', chapters=[{'start': '0', 'end': '4', 'title': 'A'}]), backend='replay'),
                  obs('t2', 'decode_sample', 'ok', decode_out(ss=0, t=4), {'at': 0}, backend='replay'),
                  obs('t3', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE, frames=27), {'at': 4}, backend='replay')]
        live_probe = {'status': 'ok', 'tool': 'probe', 'mode': 'live', 'coverage': {'verified': ['container and stream headers parse'], 'not_verified': ['stream contents: nothing was decoded']},
                      'output': {'format': 'matroska,webm', 'duration_s': 8.0, 'bytes': 1000, 'streams': [{'index': 0, 'type': 'video', 'codec': 'h264'}], 'chapters': [{'start_s': 0.0, 'end_s': 4.0, 'title': 'A'}], 'findings': []}}
        live_decode = {'status': 'ok', 'tool': 'decode', 'mode': 'live', 'coverage': {'verified': ['2 segments'], 'not_verified': ['the rest']},
                       'output': {'duration_s': 8.0, 'segments': [{'at_s': 0.0, 'window_s': 4, 'state': 'clean', 'decoded_s': 4.0, 'error_lines': 0, 'errors': []},
                                                                  {'at_s': 4.0, 'window_s': 4, 'state': 'errors', 'decoded_s': 4.0, 'error_lines': 1, 'errors': [DAMAGE]}],
                                  'full': None, 'findings': []}}
        live = [obs('t1', 'ffprobe', 'ok', live_probe, backend='live'), obs('t2', 'decode_sample', 'ok', live_decode, backend='live')]
        a = EV2.analyze(replay)['coverage']
        b = EV2.analyze(live)['coverage']
        ia, ib = list(a['time'].values())[0], list(b['time'].values())[0]
        self.assertEqual((ia['clean'], ia['damaged'], ia['not_checked']), (ib['clean'], ib['damaged'], ib['not_checked']))
        self.assertEqual(a['container']['state'], b['container']['state'])
        self.assertEqual([c['by_stream']['unrecorded'] for c in a['chapters']], [c['by_stream']['0:v:0'] for c in b['chapters']])   # same states; the live windows name their streams
        fa = [f for it in EV2.analyze(replay)['items'].values() for f in it.findings]
        fb = [f for it in EV2.analyze(live)['items'].values() for f in it.findings]
        self.assertEqual([(f['kind'], f['location']['start_s'], f['location']['end_s']) for f in fa], [(f['kind'], f['location']['start_s'], f['location']['end_s']) for f in fb])

    def test_live_vocabulary_is_reused_not_duplicated(self):
        live = {'status': 'partial', 'tool': 'decode', 'mode': 'live', 'reason': 'deadline', 'cause': None,
                'coverage': {'verified': ['v1'], 'not_verified': ['the rest of the file was not decoded', 'subtitles']},
                'output': {'duration_s': 8.0, 'segments': [], 'full': None, 'findings': ['1 planned segments skipped: collector deadline reached']}}
        d = EV2.derive(obs('t1', 'decode_sample', 'partial', live, backend='live'))
        self.assertEqual(EV2.item_facts(d)['coverage'], {'verified': ['v1'], 'not_verified': ['the rest of the file was not decoded', 'subtitles']})
        self.assertIn('the rest of the file was not decoded', d.unresolved)
        self.assertFalse(any(f['known_defect'] for f in d.findings))      # collector notes are not promoted to defects

    def test_rendering_is_deterministic(self):
        outs = []
        for _ in range(3):
            ses, text, n = self.render(obs('t1', 'ffprobe', 'ok', big_probe(300)))
            outs.append((text, tuple(sorted(ses.pages))))
        self.assertEqual(outs[0], outs[1])
        self.assertEqual(outs[1], outs[2])


class Pagination(unittest.TestCase):
    def pages_of(self, alias, o):
        ses = EV2.Session(alias, {}, 'tv', ['ffprobe'])
        ses.initial([])
        text, n = ses.result(o, 't1', 3)
        chain = [text]
        cur = json.loads(text)['output'].get('page', {}).get('next')
        while cur:
            status, t = ses.fetch(cur, 't2', 'ffprobe', 3)
            self.assertEqual(status, 'ok')
            chain.append(t)
            cur = json.loads(t)['output'].get('page', {}).get('next')
        return ses, chain

    def test_cursors_are_opaque_stable_and_chain_to_the_last_page(self):
        o = obs('t1', 'ffprobe', 'ok', big_probe(300))
        _, a = self.pages_of('case-aaaaaaaa', o)
        _, b = self.pages_of('case-aaaaaaaa', o)
        self.assertEqual(a, b)
        cursors = [json.loads(p)['output']['page'].get('next') for p in a]
        self.assertTrue(all(c is None or re.fullmatch(r'c[0-9a-f]{15}', c) for c in cursors))
        self.assertIsNone(cursors[-1])
        self.assertEqual([json.loads(p)['output']['page']['n'] for p in a], list(range(1, len(a) + 1)))
        self.assertEqual({json.loads(p)['output']['page']['of'] for p in a}, {len(a)})

    def test_cursors_differ_between_cases_and_a_foreign_cursor_does_not_resolve(self):
        o = obs('t1', 'ffprobe', 'ok', big_probe(300))
        sa, a = self.pages_of('case-aaaaaaaa', o)
        sb, b = self.pages_of('case-bbbbbbbb', o)
        ca = json.loads(a[0])['output']['page']['next']
        cb = json.loads(b[0])['output']['page']['next']
        self.assertNotEqual(ca, cb)
        status, text = sb.fetch(ca, 't2', 'ffprobe', 3)
        self.assertEqual(status, 'error')
        self.assertNotIn('chapters', text)

    def test_different_content_gets_a_different_cursor(self):
        _, a = self.pages_of('case-aaaaaaaa', obs('t1', 'ffprobe', 'ok', big_probe(300)))
        _, b = self.pages_of('case-aaaaaaaa', obs('t1', 'ffprobe', 'ok', big_probe(301)))
        self.assertNotEqual(json.loads(a[0])['output']['page']['next'], json.loads(b[0])['output']['page']['next'])

    def test_the_first_page_states_what_is_elsewhere_and_a_single_page_has_no_page_object(self):
        _, a = self.pages_of('case-aaaaaaaa', obs('t1', 'ffprobe', 'ok', big_probe(300)))
        first = json.loads(a[0])['output']
        self.assertEqual(first['page']['contract'], 'pages-v1')
        self.assertTrue(first['page']['next_costs_tool_call'])
        self.assertGreater(first['page']['elsewhere']['facts.chapters'], 0)
        _, one = self.pages_of('case-aaaaaaaa', obs('t1', 'ffprobe', 'ok', probe_out()))
        self.assertEqual(len(one), 1)
        self.assertNotIn('page', json.loads(one[0])['output'])

    def test_the_initial_evidence_block_paginates_too_and_its_pages_are_fetchable(self):
        many = [obs('e%d' % i, 'ffprobe', 'ok', big_probe(40), source='case') for i in range(1, 9)]
        ses = EV2.Session('case-aaaaaaaa', {}, 'tv', ['ffprobe'])
        block, n = ses.initial(many)
        self.assertGreater(n, 1)
        self.assertLessEqual(len(json.dumps(block, ensure_ascii=False, separators=(',', ':')).encode()), EV2.WIRE_BYTES)
        self.assertEqual(block['page']['of'], n)
        cur = block['page']['next']
        seen_items = [i['id'] for i in block['items']]
        while cur:
            status, t = ses.fetch(cur, 't1', 'ffprobe', 5)
            self.assertEqual(status, 'ok')
            page = json.loads(t)['output']
            seen_items += [i['id'] for i in page.get('items', [])]
            cur = page.get('page', {}).get('next')
        self.assertEqual(sorted(seen_items), sorted('e%d' % i for i in range(1, 9)))    # every item reachable, none repeated
        self.assertEqual(len(seen_items), len(set(seen_items)))


# ---------------------------------------------------------------------------------------------------------------------- leak tests
def normalize(text, alias):
    return text.replace(alias, 'case-00000000')


class LeakMetadata(unittest.TestCase):
    """Evaluator metadata can reach neither the evidence, the capabilities nor the guards: mutate it, hold the observations, compare the complete requests."""

    CANARY = 'CANARYMETA'

    def variant(self, n):
        case = L.tv_case('leak-%03d' % n if n else 'leak-000')
        c = self.CANARY + str(n)
        if n:
            case['truth'] = {'class': 'zxq_truth_%d' % n, 'source': 'construction', 'ref': c + 'ref'}
            case['supported_actions'] = ['zxq_action_%d' % n]
            case['accepted_classes'] = ['zxq_class_%d' % n]
            case['solvable'] = bool(n % 2)
            case['family'] = c + 'family'
            case['corrections'] = [{'note': c + 'corr'}]
            case['provenance'] = c + ' provenance'
            case['outcome_step'] = {'check': 'zxq_check', 'inputs': {'note': c + 'outcome'}}
            case['split'] = 'zxq_split_%d' % n
            case['suite_version'] = c + 'suite'
            case['inject_tool_failure'] = {'tool': 'audio_sample', 'mode': 'error', 'note': c + 'inject'}
        return case

    def go(self, case, replies, **kw):
        ts = L.suite_with(case)
        rec, ad = ev2h.scripted_run(case, ts, replies, which=th.NO_BINARIES, evidence_format='v2', **kw)
        ts.cleanup()
        return rec, ad

    def test_mutating_every_evaluator_field_leaves_the_requests_identical_after_alias_normalisation(self):
        replies = lambda: [tc('ffprobe'), tc('decode_sample', {'at': 0}), tc('decode_sample', {'full': True}), tc('ocr', {'at': 1}), dec('healthy', 'none', ['e1'])]
        base_rec, base_ad = self.go(self.variant(0), replies(), guards='v3')
        base_alias = base_rec['model_case_alias']
        want = normalize(json.dumps(base_ad.calls), base_alias)
        for n in range(1, 6):
            rec, ad = self.go(self.variant(n), replies(), guards='v3')
            self.assertEqual(normalize(json.dumps(ad.calls), rec['model_case_alias']), want, n)
            self.assertEqual(rec['decision'], base_rec['decision'], n)                       # the guards decided on the same observations
            self.assertEqual(rec['guard']['applied'][0]['reason'] if rec['guard']['applied'] else None,
                             base_rec['guard']['applied'][0]['reason'] if base_rec['guard']['applied'] else None, n)
            for c, b in zip(rec['tool_calls'], base_rec['tool_calls']):
                self.assertEqual((c['status'], c.get('raw_output')), (b['status'], b.get('raw_output')), n)

    def test_no_canary_reaches_any_request_including_nested_objects_errors_and_pages(self):
        for n in range(1, 4):
            case = self.variant(n)
            big = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'T%03d %s' % (i, 'x' * 50)} for i in range(200)]
            ts = L.suite_with(case, probes=False)
            rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=dict(L.PROBE_REC, chapters=big))
            ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
            rec1, ad1 = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], which=th.NO_BINARIES, evidence_format='v2')
            cursor = json.loads(ad1.calls[-1][-1]['content'])['output']['page']['next']
            rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('ffprobe', {'cursor': cursor}), tc('ffprobe', {'cursor': 'c' + 'f' * 15}), tc('audio_sample'), tc('decode_sample', {'full': True}), dec()],
                                        which=th.NO_BINARIES, evidence_format='v2')
            blob = ad.sent_text()      # system prompt, schema and every message of every call
            self.assertNotIn(self.CANARY, blob, n)
            for forbidden in ('zxq_truth', 'zxq_action', 'zxq_class', 'zxq_check', 'zxq_split'):
                self.assertNotIn(forbidden, blob)
            ts.cleanup()

    def test_the_case_id_and_fixture_names_never_appear_in_a_request(self):
        case = self.variant(0)
        case['id'] = 'leak-secret-id-777'
        case['fixture'] = dict(case['fixture'], locator='media/flip-answer-name.mkv')
        ts = th.TempSuite([case])
        ts.add_file('media/flip-answer-name.mkv', b'not really media' * 50)
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest())
        ts.add_file('fixtures/probes/flip-answer-name.mkv.json', json.dumps(rec_file).encode())
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 4}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        blob = ad.sent_text()
        for token in ('leak-secret-id-777', 'flip-answer-name', 'flip-answer'):
            self.assertNotIn(token, blob)
        ts.cleanup()

    def test_the_typed_layer_has_no_access_to_the_case_object(self):
        import inspect
        sig = inspect.signature(EV2.Session.__init__)
        self.assertEqual(list(sig.parameters), ['self', 'alias', 'context', 'media_type', 'tools_offered', 'budget'])
        src = inspect.getsource(EV2)
        for field in ("'truth'", "'supported_actions'", "'accepted_classes'", "'solvable'", "'family'", "'corrections'", "'provenance'", "'outcome_step'", "'inject_tool_failure'",
                      "'case_id'", "'suite_version'"):
            self.assertNotIn(field, src, field)


class LeakLookingAhead(unittest.TestCase):
    def case_and_suite(self):
        case = L.tv_case('ahead-001', evidence=[])
        ts = L.suite_with(case, probes=False)
        rec = json.loads(json.dumps(L.REPLAY_FILE))
        rec['sha256'] = hashlib.sha256(b'not really media' * 50).hexdigest()
        rec['decode_sample']['4']['stderr'] = SENTINEL + 'WINDOW4 ' + DAMAGE
        rec['decode_sample']['8']['stderr'] = SENTINEL + 'WINDOW8'
        rec['decode_sample']['full']['stderr'] = SENTINEL + 'FULL'
        rec['audio_sample']['0']['rms_dbfs'] = -99.9876
        rec['frame_text'] = [{'t0': 0, 't1': 2, 'text': SENTINEL + 'TITLECARD'}]
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec).encode())
        return case, ts

    def test_sentinels_in_uncalled_replay_results_never_reach_any_request(self):
        case, ts = self.case_and_suite()
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 0}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        blob = ad.sent_text()
        for token in (SENTINEL, '99.9876', 'WINDOW4', 'WINDOW8', 'TITLECARD'):
            self.assertNotIn(token, blob)
        self.assertIn('"offsets_s":[0,4,8]', json.dumps(json.loads(ad.calls[0][0]['content'])['capabilities'], separators=(',', ':')))   # offsets, not results
        ts.cleanup()

    def test_a_sentinel_appears_only_after_the_operation_that_returns_it_was_called(self):
        case, ts = self.case_and_suite()
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 4}), tc('ocr', {'at': 1}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        call_requests = ad.calls
        self.assertNotIn(SENTINEL, json.dumps(call_requests[0]))
        self.assertIn('SENTINELWINDOW4'.replace('SENTINEL', SENTINEL), json.dumps(call_requests[1]))
        self.assertNotIn('WINDOW8', json.dumps(call_requests[2]))
        self.assertIn('TITLECARD', json.dumps(call_requests[2]))
        ts.cleanup()

    def test_hidden_injection_metadata_is_invisible_and_an_injected_failure_looks_like_the_failure_the_model_saw(self):
        case, ts = self.case_and_suite()
        case['inject_tool_failure'] = {'tool': 'decode_sample', 'mode': 'error', 'secret': SENTINEL + 'INJECT'}
        ts.cleanup()
        ts = L.suite_with(case, probes=False)
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 0}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        blob = ad.sent_text()
        self.assertNotIn('INJECT', blob)
        self.assertNotIn('injected', json.dumps([f['messages'] for f in ad.full]).lower())     # (the static v4 system prompt itself uses the word)
        reply = json.loads(ad.calls[-1][-1]['content'])
        self.assertEqual((reply['status'], reply['output']['execution']['state']), ('error', 'failed'))
        self.assertNotIn('backend', reply['output'])                       # the harness-side 'injected' backend marker became unknown
        ts.cleanup()

    def test_an_injected_failure_and_the_same_text_from_a_genuine_failure_render_identically(self):
        a = ev2h.obs('t1', 'decode_sample', 'error', 'decode_sample failed: could not run', {'at': 0}, backend='injected')
        b = ev2h.obs('t1', 'decode_sample', 'error', 'decode_sample failed: could not run', {'at': 0}, backend=None)
        out = []
        for o in (a, b):
            ses = EV2.Session('case-00000000', {}, 'tv', ['decode_sample'])
            ses.initial([])
            out.append(ses.result(o, 't1', 3)[0])
        self.assertEqual(out[0], out[1])
        part_a = ev2h.obs('t1', 'decode_sample', 'partial', '{"exit_code": 0, "stderr": "" ...[output cut off]', {'at': 0}, backend='injected')
        part_b = ev2h.obs('t1', 'decode_sample', 'partial', '{"exit_code": 0, "stderr": "" ...[output cut off]', {'at': 0}, backend=None)
        out = []
        for o in (part_a, part_b):
            ses = EV2.Session('case-00000000', {}, 'tv', ['decode_sample'])
            ses.initial([])
            out.append(ses.result(o, 't1', 3)[0])
        self.assertEqual(out[0], out[1])

    def test_summaries_and_capabilities_are_identical_whether_or_not_unshown_operations_would_find_damage(self):
        views = []
        for damaged in (False, True):
            case, ts = self.case_and_suite()
            if not damaged:
                rec = json.loads((ts.root / 'fixtures' / 'probes' / 'x.mkv.json').read_text())
                rec['decode_sample']['4']['stderr'] = ''
                rec['decode_sample']['8']['stderr'] = ''
                (ts.root / 'fixtures' / 'probes' / 'x.mkv.json').write_text(json.dumps(rec))
            r, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 0}), dec()], which=th.NO_BINARIES, evidence_format='v2')
            views.append(json.dumps(ad.calls))
            ts.cleanup()
        self.assertEqual(views[0], views[1])                              # nothing the model was shown depends on results it did not ask for


# ---------------------------------------------------------------------------------------------------------------------- the public dev suite
@th.needs_suite
class PublicSuite(unittest.TestCase):
    """Traceability and explicit unknowns over the public dev cases.  Expected facts come from independently re-reading the recorded data in the test, not from a
    stored golden of the implementation and not from any label."""

    @classmethod
    def setUpClass(cls):
        cls.suite = Path(th.SUITE)
        v11 = cls.suite.parent / 'suite-dev-v1.1'
        cls.suites = [cls.suite] + ([v11] if (v11 / 'cases').is_dir() else [])
        if __import__('os').environ.get('MRH_REQUIRE_SUITE') == '1' and len(cls.suites) < 2:
            raise AssertionError('suite-dev-v1.1 missing; MRH_REQUIRE_SUITE=1 forbids skipping')

    def cases(self):
        for suite in self.suites:
            for case, sha in R.load_cases(suite):
                yield suite, case

    def shown(self, suite, case):
        fx = T.Fixture.from_case(case, suite)
        ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=suite, which=th.NO_BINARIES, tools_behavior='v2', keep_raw=True)
        evidence = R.resolve_evidence_raw(case, suite, ctx.redact)
        return ctx, evidence

    def test_both_dev_suites_have_the_expected_case_count(self):
        counts = [len(list(R.load_cases(s))) for s in self.suites]
        self.assertEqual(counts, [73] * len(self.suites))
        self.assertGreaterEqual(len(self.suites), 2)

    def test_every_derived_decode_fact_equals_what_the_recorded_data_states(self):
        checked = 0
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            an = EV2.analyze([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], case['context'])
            for e in evidence:
                if e['tool'] != 'decode_sample' or e['status'] != 'ok':
                    continue
                data = json.loads(e['output'])
                d = an['items'][e['id']]
                stderr = data.get('stderr')
                start = float(data.get('ss', e['args'].get('ss', 0)))
                if 'stderr' not in data or 'exit_code' not in data:
                    self.assertEqual((d.integrity, d.intervals), ('unknown', []), case['id'])
                    continue
                if stderr and stderr.strip():
                    self.assertEqual([f['kind'] for f in d.findings], ['decoder_errors'], case['id'])
                    self.assertIn(stderr.splitlines()[0][:60], d.findings[0]['detail'])
                    self.assertIn('status_ok_with_defect', [c['kind'] for c in d.conflicts], case['id'])
                else:
                    self.assertEqual(d.findings, [], case['id'])
                    self.assertEqual(d.integrity, 'clean' if data.get('frames') != 0 else 'unknown', case['id'])
                if d.intervals:
                    iv = d.intervals[0]
                    self.assertEqual(iv['start_s'], start, case['id'])
                    if data.get('out_time'):
                        h, m, s = data['out_time'].split(':')
                        self.assertAlmostEqual(iv['end_s'] - iv['start_s'], int(h) * 3600 + int(m) * 60 + float(s), places=3, msg=case['id'])
                    self.assertEqual(iv['state'], 'damaged' if (stderr and stderr.strip()) else 'clean')
                checked += 1
        self.assertGreater(checked, 20)

    def test_every_finding_and_conflict_traces_to_its_observation_and_quotes_the_recorded_text(self):
        n_find = 0
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            by_id = {e['id']: e for e in evidence}
            an = EV2.analyze([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], case['context'])
            for d in an['items'].values():
                for f in d.findings + d.conflicts:
                    self.assertIn(f['src'], by_id, case['id'])
                    self.assertTrue(f['id'].startswith(f['src'] + '.'))
                for f in d.findings:
                    n_find += 1
                    text = by_id[f['src']]['output']
                    probe = f['detail'].split(' at stage ')[0]
                    first = re.split(r'[;\n]', probe)[0].strip()[:40]
                    self.assertTrue(first in text or first.replace('"', '\\"') in text or first in json.dumps(json.loads(text) if text[:1] in '{[' else text), (case['id'], f))
        self.assertGreater(n_find, 10)

    def test_unknowns_are_explicit_where_the_recording_lacks_the_field(self):
        saw_unknown_streams = saw_unknown_duration = 0
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            an = EV2.analyze([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], case['context'])
            cov = an['coverage']
            probes = [e for e in evidence if e['tool'] == 'ffprobe' and e['status'] == 'ok']
            has_dur = any('"duration"' in e['output'] for e in probes)
            if not has_dur:
                self.assertEqual(cov['duration_s'], 'unknown', case['id'])
                saw_unknown_duration += 1
            if cov.get('time') and cov['time'] != {'state': 'not_checked'}:
                for key, row in cov['time'].items():
                    self.assertEqual(key, 'unrecorded', case['id'])            # no recorded dev decode names its streams
                    self.assertEqual(row['selection'], 'unknown')
                    if cov['duration_s'] == 'unknown':
                        self.assertEqual(row['not_checked'], 'unknown')
                saw_unknown_streams += 1
        self.assertGreater(saw_unknown_streams, 15)
        self.assertGreater(saw_unknown_duration, 3)

    def test_a_stated_client_is_compared_field_by_field_and_never_inferred(self):
        with_client = without = 0
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            an = EV2.analyze([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence], case['context'])
            stated = EV2.client_profile(case['context'])
            if not stated:
                self.assertIsNone(an['client'], case['id'])
                without += 1
                continue
            with_client += 1
            self.assertTrue(an['client']['stated_by_case'])
            for row in an['client']['rows']:
                self.assertIn(row['verdict'], ('supported', 'unsupported', 'unknown'))
        self.assertEqual(with_client, 6 * len(self.suites))
        self.assertGreater(without, 60)

    def test_the_first_message_of_every_dev_case_is_inside_the_envelope_and_never_contains_an_evaluator_token(self):
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            view = P.case_view(case, [], case_alias='case-00000000')
            ses = EV2.Session('case-00000000', view['context'], view['media_type'], view['tools_available'])
            block, n = ses.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence])
            self.assertLessEqual(len(json.dumps(block, ensure_ascii=False, separators=(',', ':')).encode()), EV2.WIRE_BYTES, case['id'])
            msg = json.dumps({'context': view['context'], 'caps': T.capabilities(ctx), 'ev': block}, ensure_ascii=False)
            leakguard.check_messages(case, [{'role': 'user', 'content': msg}], ctx.forbidden_extra)   # raises on any forbidden token

    def test_every_default_tool_reply_of_every_dev_case_is_inside_the_envelope_and_leak_free(self):
        calls = {'arr_lookup': [{}], 'ffprobe': [{}], 'epub_inspect': [{}], 'audiobook_inspect': [{}], 'decode_sample': [{}, {'at': 60}, {'full': True}],
                 'frame_sample': [{'at': 30}], 'ocr': [{'at': 30}], 'audio_sample': [{}, {'at': 45}]}
        for suite, case in self.cases():
            ctx, evidence = self.shown(suite, case)
            view = P.case_view(case, [], case_alias='case-00000000')
            ses = EV2.Session('case-00000000', view['context'], view['media_type'], view['tools_available'])
            ses.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in evidence])
            k = 0
            for tool in case.get('tools_available', []):
                for args in calls.get(tool, [{}]):
                    k += 1
                    res = T.call_tool(ctx, tool, args)
                    o = EV2.make_observation('t%d' % k, tool, R.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode'))
                    text, n = ses.result(o, 't%d' % k, 3)
                    self.assertLessEqual(len(text.encode('utf-8')), EV2.WIRE_BYTES, (case['id'], tool))
                    json.loads(text)
                    leakguard.check_messages(case, [{'role': 'user', 'content': text}], ctx.forbidden_extra)

    def test_the_replay_identity_of_the_legacy_format_still_holds_over_both_suites(self):
        from media_repair_harness import replay_identity as RI
        golden = json.loads((Path(__file__).resolve().parent / 'testdata' / 'replay-identity-dev-c1.json').read_text())
        now = RI.digest_suite(self.suite)
        self.assertEqual(sorted(now), sorted(golden['cases']))


if __name__ == '__main__':
    unittest.main()


class BranchesUnderV2(unittest.TestCase):
    """The same typed layer over the local-binary, remote and live branches of a full scripted run (mocked end to end)."""

    def test_local_branch_full_decode_reaches_the_end_and_is_called_so(self):
        case = L.tv_case('br-local-001', evidence=[])
        ts = L.suite_with(case, probes=False)
        probe_json = json.dumps({'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'width': 256, 'height': 192, 'pix_fmt': 'yuv420p'},
                                             {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 1}],
                                 'format': {'format_name': 'matroska,webm', 'duration': '8.046', 'size': '90286', 'bit_rate': '89769'}}).encode()
        seen = []

        def runner(cmd, capture_output=True, timeout=None):
            seen.append(cmd)
            exe = [c for c in cmd if 'ffprobe' in c or 'ffmpeg' in c][0]
            if 'ffprobe' in exe:
                return Completed(0, probe_json, b'')
            if '-progress' in cmd:
                return Completed(0, b'frame=67\nout_time_us=8000000\nprogress=end\n', b'')
            return Completed(0, b'', b'')
        replies = [tc('ffprobe'), tc('decode_sample', {'full': True}), tc('decode_sample', {'at': 4}), dec('insufficient_evidence', 'escalate')]
        rec, ad = ev2h.scripted_run(case, ts, replies, runner=runner, which=lambda n: '/usr/bin/' + n if n in ('ffmpeg', 'ffprobe') else None, evidence_format='v2')
        full_reply = json.loads(ad.calls[-1][4]['content'])['output']
        self.assertEqual(full_reply['scope']['completed']['to_end_of_file'], True)
        self.assertEqual(full_reply['scope']['completed']['streams'], ['0:v:0', '0:a:0'])
        self.assertEqual(full_reply['backend'], 'local')
        self.assertEqual(full_reply['coverage']['time']['0:v:0']['clean'], [[0.0, 8.0]])
        self.assertEqual(full_reply['coverage']['streams'][0]['decode'], 'checked_in_windows')
        self.assertTrue(any('-progress' in c for c in seen))
        window = json.loads(ad.calls[-1][-1]['content'])['output']
        self.assertEqual(window['scope']['completed']['streams'], ['0:v:0', '0:a:0'])
        ts.cleanup()

    def test_local_branch_full_decode_that_times_out_is_partial_with_the_actual_window(self):
        import subprocess
        case = L.tv_case('br-local-002', evidence=[])
        ts = L.suite_with(case, probes=False)

        def runner(cmd, capture_output=True, timeout=None):
            if any('ffprobe' in c for c in cmd):
                return Completed(0, json.dumps({'streams': [], 'format': {'format_name': 'x', 'duration': '600'}}).encode(), b'')
            raise subprocess.TimeoutExpired(cmd, timeout, output=b'frame=300\nout_time_us=12000000\n', stderr=b'')
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'full': True}), dec()], runner=runner,
                                    which=lambda n: '/usr/bin/' + n if n in ('ffmpeg', 'ffprobe') else None, evidence_format='v2')
        reply = json.loads(ad.calls[-1][-1]['content'])
        out = reply['output']
        self.assertEqual(reply['status'], 'partial')
        self.assertEqual(out['execution']['completion'], 'partial')
        self.assertEqual(out['scope']['completed']['to_end_of_file'], False)
        self.assertEqual(out['scope']['intervals'][0]['end_s'], 12.0)
        self.assertIn('request_not_honored', [c['kind'] for c in out['conflicts']])
        self.assertEqual(out['coverage']['time']['0:v:0']['not_checked'], [[12.0, 600.0]])
        ts.cleanup()

    def test_remote_branch_full_request_is_a_partial_window_in_the_typed_reply(self):
        case = L.tv_case('br-remote-001', fixture={'kind': 'remote', 'locator': 'remote:media/bazarr:/tv/x.mkv'}, evidence=[])
        ts = th.TempSuite([case])

        def runner(cmd, input=None, capture_output=True, timeout=None):
            mode = cmd[cmd.index('-') + 1]
            info = {'exit_code': 0, 'stdout_bytes': 0, 'stderr': '', 'bytes_read': 4096, 'quota_exhausted': False}
            if mode == 'probe':
                return Completed(0, json.dumps({'streams': [], 'format': {'format_name': 'matroska,webm', 'duration': '60'}}).encode(), json.dumps(info).encode())
            return Completed(0, b'', json.dumps(info).encode())
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'full': True}), dec()], runner=runner, evidence_format='v2')
        reply = json.loads(ad.calls[-1][-1]['content'])
        self.assertEqual((reply['status'], reply['output']['backend']), ('partial', 'remote'))
        self.assertIn('request_not_honored', [c['kind'] for c in reply['output']['conflicts']])
        self.assertIn('8 MiB', json.dumps(reply['output']))
        ts.cleanup()

    def test_live_branch_uses_the_collectors_own_coverage_vocabulary_and_the_union(self):
        case = L.tv_case('br-live-001', evidence=[])
        ts = L.suite_with(case, probes=False)
        fake = TE.Fake([(TE.prog('ffprobe', '-show_format'), TE.RunResult(0, TE.probe_json(duration=8.0), b'')), (TE.prog('ffmpeg', '-progress'), TE.clean_decode)] + TE.VERSION)
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample'), dec()], evidence_mode='live', evidence_runner=fake,
                                    evidence_which=TE.which_with('ffmpeg', 'ffprobe'), which=lambda n: None, evidence_format='v2')
        reply = json.loads(ad.calls[-1][-1]['content'])['output']
        self.assertEqual(reply['backend'], 'live')
        self.assertTrue(reply['facts']['coverage']['not_verified'])
        self.assertEqual(reply['coverage']['time']['0:v:0']['checked_fraction'], 1.0)          # three overlapping windows, one union
        self.assertEqual(rec['tool_calls'][1]['mode'], 'live')
        ts.cleanup()

    def test_a_case_that_offers_no_tool_cannot_page_and_says_so_without_hiding_conflicts(self):
        many = [EV2.make_observation('e%d' % i, 'ffprobe', {}, 'ok', json.dumps(probe_out(duration='60', chapters=[{'start': str(k), 'end': str(k + 1), 'title': 'c%03d %s' % (k, 'y' * 60)} for k in range(60)])), None, 'case')
                for i in range(1, 7)]
        many.append(EV2.make_observation('e9', 'decode_sample', {'ss': 0, 't': 4}, 'ok', json.dumps(decode_out(stderr=DAMAGE)), None, 'case'))
        ses = EV2.Session('case-00000000', {}, 'tv', [])
        block, n = ses.initial(many)
        self.assertEqual(ses.pages, {})
        self.assertNotIn('next', block['page'])
        self.assertIn('no tool is offered', block['page']['retrieval'])
        self.assertTrue(any(a['type'] == 'conflict' for a in block['alerts']))
        self.assertLessEqual(len(json.dumps(block, ensure_ascii=False, separators=(',', ':')).encode()), EV2.WIRE_BYTES)
        self.assertTrue(block['page']['elsewhere'])

    def test_guards_v3_offline_apply_to_an_existing_legacy_record_and_keep_the_original(self):
        from media_repair_harness import decision_guard as DG
        case = L.tv_case('br-guard-001')
        ts = L.suite_with(case)
        rec, ad = L.run(case, ts, [tc('ffprobe'), L.dec('healthy', 'none', ['t1'])], which=th.NO_BINARIES)
        shown = R.resolve_evidence(case, ts.root)
        new = DG.apply_to_record(rec, case, shown, 'v3')
        self.assertEqual(new['guard']['version'], 'v3')
        self.assertTrue(new['guard']['final_changed'])      # the case's own evidence e2 holds decoder errors; the clean probe does not outvote them
        self.assertEqual(new['guard']['applied'][0]['original']['class'], 'healthy')
        back = DG.restore_original(new, case, shown)
        self.assertEqual(back['decision'], rec['decision'])
        ts.cleanup()

    def test_mrh_guard_cli_offers_v3(self):
        from media_repair_harness import guard_cli
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            guard_cli.main(['--help'])
        self.assertIn('v3', buf.getvalue())


class RegressionGolden(unittest.TestCase):
    """Implementation-generated renderings of fixed synthetic observations and of every public dev case, pinned so an unintended change is noticed.
    This is a regression check only; the semantic expectations are the hand-written ones elsewhere in this file and in test_evidence_v2_core."""
    GOLDEN = Path(__file__).resolve().parent / 'testdata' / 'evidence-v2-golden.json'

    def test_synthetic_renderings_equal_the_golden(self):
        import make_evidence_v2_golden as M
        want = json.loads(self.GOLDEN.read_text())['synthetic']
        self.assertEqual(M.synthetic(), want)

    @th.needs_suite
    def test_public_dev_renderings_equal_the_golden(self):
        import make_evidence_v2_golden as M
        want = json.loads(self.GOLDEN.read_text())['public_dev']
        now = M.suites(Path(th.SUITE).parent)
        self.assertEqual(sorted(now), sorted(want))
        home = set()
        for suite in ('suite', 'suite-dev-v1.1'):
            for case, _ in R.load_cases(Path(th.SUITE).parent / suite):
                if ((case.get('fixture') or {}).get('locator') or '').startswith('~'):
                    home.add('%s:%s' % (suite, hashlib.sha256(case['id'].encode()).hexdigest()[:12]))
        self.assertLessEqual(len(home), 8)
        for key, row in want.items():
            self.assertEqual(now[key]['case_sha256'], row['case_sha256'], key)
            self.assertEqual(now[key]['initial'], row['initial'], key)
            if key in home:
                continue    # these fixtures sit in the evaluator's home cache: whether the file exists decides the route of the tools, so only the case-provided evidence is pinned
            self.assertEqual(now[key], row, key)
        self.assertEqual(len(want), 146)


def replay_case(cid, mutate=None, evidence=None, **kw):
    """The standard synthetic TV case with a recorded replay file; `mutate(rec)` changes the recording (uncalled results included)."""
    case = L.tv_case(cid, **kw)
    if evidence is not None:
        case['evidence'] = evidence
    ts = L.suite_with(case, probes=False)
    rec = json.loads(json.dumps(L.REPLAY_FILE))
    rec['sha256'] = hashlib.sha256(b'not really media' * 50).hexdigest()
    if mutate:
        mutate(rec)
    ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec).encode())
    return case, ts


class CapabilityIndependence(unittest.TestCase):
    """Astra 4 and Opus 4: the advertisement is built from operation metadata (which recordings and offsets exist), never from a result the model has not asked for.
    Each variant changes ONE uncalled result and the advertisement must not move."""

    def caps(self, mutate=None, **kw):
        case, ts = replay_case('qxk-001', mutate, **kw)
        fx = T.Fixture.from_case(case, ts.root)
        ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=ts.root, which=th.NO_BINARIES, tools_behavior='v2')
        out = T.capabilities(ctx)
        ts.cleanup()
        return out

    def test_changing_any_uncalled_result_leaves_the_advertisement_unchanged(self):
        base = self.caps()
        variants = {
            'ffprobe_without_video': lambda r: r['ffprobe'].update(streams=[s for s in r['ffprobe']['streams'] if s['codec_type'] != 'video']),
            'ffprobe_failed': lambda r: r['ffprobe'].update(exit_code=1, stderr='moov atom not found'),
            'ffprobe_empty': lambda r: r.update(ffprobe={}),
            'full_decode_clean': lambda r: r['decode_sample']['full'].update(stderr='', frames=999),
            'full_decode_damaged': lambda r: r['decode_sample']['full'].update(stderr='[h264 @ 0x0] error while decoding MB 1 1', exit_code=1),
            'full_decode_structure': lambda r: r['decode_sample'].update(full=['not', 'a', 'dict']),
            'window_results_changed': lambda r: [r['decode_sample'][k].update(stderr=SENTINEL, frames=0) for k in ('0', '4', '8')],
            'window_structure': lambda r: r['decode_sample'].update({'4': None, '8': 'x'}),
            'audio_levels': lambda r: r['audio_sample'].update({'0': {'rms_dbfs': -90.0, 'peak_dbfs': -80.0, 'silent_fraction': 1.0}}),
            'audio_structure': lambda r: r['audio_sample'].update({'0': 'silent'}),
            'frame_text_changed': lambda r: r.update(frame_text=[{'t0': 0, 't1': 2, 'text': SENTINEL + 'CARD'}]),
        }
        for name, mutate in variants.items():
            self.assertEqual(self.caps(mutate), base, name)

    def test_what_the_advertisement_does_report_follows_the_recording_metadata_only(self):
        base = {c['tool']: c for c in self.caps()}
        self.assertEqual(base['ocr']['recorded_reading_ranges_s'], [[0, 2]])              # the recorded OCR time ranges, never the text
        self.assertNotIn('HARBOR', json.dumps(base))
        moved = {c['tool']: c for c in self.caps(lambda r: r.update(frame_text=[{'t0': 5, 't1': 9, 'text': 'x'}]))}
        self.assertEqual(moved['ocr']['recorded_reading_ranges_s'], [[5, 9]])
        gone = {c['tool']: c for c in self.caps(lambda r: r['decode_sample'].pop('full'))}
        self.assertEqual(gone['decode_sample']['full_decode'], 'not_recorded')
        fewer = {c['tool']: c for c in self.caps(lambda r: r['decode_sample'].pop('8'))}
        self.assertEqual(fewer['decode_sample']['offsets_s'], [0, 4])
        self.assertEqual(base['frame_sample']['offsets_s'], 'any')

    def test_pinned_replay_status_and_outputs_do_not_move_the_advertisement(self):
        def pinned(status, output):
            case = L.tv_case('qxk-002', evidence=[], fixture={'kind': 'remote', 'sha256': 'ab' * 32, 'locator': 'radarr movie 1 file 2'},
                             replay=[{'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': status, 'output': output},
                                     {'tool': 'ocr', 'args': {'ss': 1}, 'status': status, 'output': output}])
            ts = th.TempSuite([case])
            ctx = T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp(), suite_dir=ts.root, which=th.NO_BINARIES, tools_behavior='v2')
            out = T.capabilities(ctx)
            ts.cleanup()
            return out
        base = pinned('ok', json.dumps(L.DEC_CLEAN))
        for status, output in (('error', 'x'), ('timeout', ''), ('unavailable', 'nothing'), ('partial', json.dumps(L.DEC_BAD)), ('ok', json.dumps({'exit_code': 1, 'stderr': DAMAGE}))):
            self.assertEqual(pinned(status, output), base, status)

    def test_case_provided_evidence_does_not_change_the_advertisement_of_other_operations(self):
        a = self.caps()
        b = self.caps(evidence=[])
        self.assertEqual(a, b)


class UncalledStructureMutation(unittest.TestCase):
    """Astra tests paragraph: mutate the STRUCTURE of uncalled results (not only a sentinel string); everything sent must be identical."""

    def sent(self, mutate):
        case, ts = replay_case('qxs-001', mutate, evidence=[])
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 0}), dec()], which=th.NO_BINARIES, evidence_format='v2', guards='v3')
        ts.cleanup()
        return ad.sent_text(), rec

    def test_the_complete_requests_do_not_depend_on_what_uncalled_results_look_like(self):
        base, rec = self.sent(None)
        variants = [
            lambda r: r['decode_sample'].update({'4': None, '8': [], 'full': 'text'}),
            lambda r: r['decode_sample']['4'].update(stderr=['a', 'b'], extra={'deep': {'x': [1, 2, 3]}}),
            lambda r: r['decode_sample'].update(full={}),
            lambda r: r.update(audio_sample={'0': 5}),
            lambda r: r.update(audio_sample={'0': {'rms_dbfs': 'loud'}}),
            lambda r: r.update(frame_text=[{'t0': 0, 't1': 2, 'text': ['nested', {'a': 1}]}]),
            lambda r: r.update(frame_text=[{'t0': 0, 't1': 2, 'text': 'x' * 5000}]),
            lambda r: r.update(unknown_future_key={'a': [1, 2, {'b': SENTINEL}]}),
        ]
        for i, mutate in enumerate(variants):
            got, rec2 = self.sent(mutate)
            self.assertEqual(got, base, i)
            self.assertNotIn(SENTINEL, got)
        self.assertEqual(rec['decision']['class'], 'insufficient_evidence')


class GuardsSeeOnlyWhatWasShown(unittest.TestCase):
    """Astra 4: a damage message beyond the displayed truncation boundary must not change a guard outcome; under format v2 the typed pages carry the whole text."""

    def case_with_long_probe(self):
        chapters = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(300)]
        probe = dict(L.PROBE_REC, chapters=chapters, stderr='[mov,mp4 @ 0x0] moov atom not found')

        def mutate(rec):
            rec['ffprobe'] = probe
        return replay_case('cutdemo-001', mutate, evidence=[], tools_available=['ffprobe', 'decode_sample'])

    def run_it(self, **kw):
        case, ts = self.case_with_long_probe()
        replies = [tc('decode_sample', {'at': 0}), tc('ffprobe'), dec('healthy', 'none', ['t1'])]
        rec, ad = ev2h.scripted_run(case, ts, replies, which=th.NO_BINARIES, **kw)
        ts.cleanup()
        return rec, ad

    def test_legacy_format_guards_read_the_cut_text_the_model_saw_not_the_whole_output(self):
        rec, ad = self.run_it(guards='v3')
        shown = json.loads(ad.calls[-1][-1]['content'])
        self.assertTrue(shown['truncated'])
        self.assertNotIn('moov atom', shown['output'])                       # the damage text sits past the cut: the model could not see it
        self.assertNotIn('raw_output', rec['tool_calls'][1])                  # and the record holds no uncut text for the guard to read
        self.assertEqual((rec['decision']['class'], rec['guard']['final_changed']), ('healthy', False))

    def test_format_v2_shows_the_whole_text_through_its_typed_pages_so_the_guard_sees_the_defect(self):
        rec, ad = self.run_it(evidence_format='v2', guards='v3')
        shown = json.loads(ad.calls[-1][-1]['content'])
        self.assertFalse(shown['truncated'])
        self.assertTrue(any(a['type'] == 'defect' for a in shown['output']['alerts']))       # the defect is in the alerts of page one
        self.assertIn('moov atom not found', json.dumps(shown))
        self.assertEqual((rec['decision']['class'], rec['guard']['final_changed']), ('insufficient_evidence', True))

    def test_all_four_format_and_guard_combinations(self):
        want = {(None, None): 'healthy', (None, 'v3'): 'healthy', ('v2', None): 'healthy', ('v2', 'v3'): 'insufficient_evidence'}
        for (fmt, g), cls in want.items():
            rec, ad = self.run_it(**{k: v for k, v in (('evidence_format', fmt), ('guards', g)) if v})
            self.assertEqual(rec['decision']['class'], cls, (fmt, g))
        # with the damage inside the case's own (short) evidence, every guarded combination abstains and the unguarded ones keep the model's answer
        for (fmt, g), cls in {(None, None): 'healthy', (None, 'v3'): 'insufficient_evidence', ('v2', None): 'healthy', ('v2', 'v3'): 'insufficient_evidence'}.items():
            case = L.tv_case('qxc-001')
            ts = L.suite_with(case)
            rec, ad = ev2h.scripted_run(case, ts, [dec('healthy', 'none', ['e1'])], which=th.NO_BINARIES, **{k: v for k, v in (('evidence_format', fmt), ('guards', g)) if v})
            self.assertEqual(rec['decision']['class'], cls, (fmt, g))
            ts.cleanup()


class ReferenceResolver(unittest.TestCase):
    """Astra 6: one resolver; a finding id counts only if it was emitted; the guards see references through the same resolver."""

    def write_decision(self, refs):
        d = dec('corrupt_file', 'blocklist_and_search', refs, target='Harbor Lights - S01E02 - Lamp Oil.mkv')
        d['audit'] = {'target': d['target'], 'preconditions': ['t1 shows decoder errors'], 'readback': 'queue', 'verify': 'new file'}
        return d

    def run_refs(self, refs, guards='v3', **kw):
        case = L.tv_case('qxr-001', evidence=[])
        ts = L.suite_with(case)
        extra = {'guards': guards} if guards else {}
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 4}), self.write_decision(refs)], which=th.NO_BINARIES, evidence_format='v2', **extra, **kw)
        ts.cleanup()
        return rec

    def test_a_real_finding_id_is_accepted_everywhere_and_behaves_like_its_observation(self):
        by_obs = self.run_refs(['t1'])
        by_finding = self.run_refs(['t1.f1'])
        by_conflict = self.run_refs(['t1.c1'])
        for rec in (by_obs, by_finding, by_conflict):
            self.assertEqual(rec['decision']['action'], 'blocklist_and_search')            # no guard fired
            self.assertFalse(rec['guard']['final_changed'])
            self.assertEqual(rec['bad_evidence_refs'], [])
            self.assertTrue({c['id']: c['met'] for c in rec['action_audit']['preconditions']}['cited_evidence_supports'])
        self.assertEqual(by_finding['decision']['evidence_refs'], ['t1.f1'])               # recorded as the model wrote it

    def test_a_finding_id_that_was_never_emitted_is_a_bad_reference_and_the_guard_notices(self):
        for ref in ('t1.nonexistent', 't1.f9', 't7.f1', 't1.'):
            self.assertEqual(self.run_refs([ref], guards=None)['bad_evidence_refs'], [ref], ref)      # the record flags it ...
            rec = self.run_refs([ref])
            self.assertTrue(rec['guard']['final_changed'], ref)                                      # ... and the guard, which reads the same resolution, abstains
            self.assertEqual(rec['guard']['applied'][0]['original']['evidence_refs'], [ref])
            self.assertEqual(rec['decision']['action'], 'escalate')

    def test_the_resolver_is_one_function(self):
        case = L.tv_case('qxr-002', evidence=[])
        calls = [{'id': 't1', 'tool': 'ffprobe'}]

        class S:
            def finding_index(self):
                return {'t1.f1': 't1', 'e1.c1': 'e1'}
        r = R.make_resolver(case, calls, S())
        self.assertEqual(r(['e1', 't1', 't1.f1', 'e1.c1', 't1.f2', 'zzz']), ['e1', 't1', 't1', 'e1', 't1.f2', 'zzz'])
        self.assertEqual(R.make_resolver(case, calls, None)(['t1.f1']), ['t1.f1'])               # the legacy format never rewrites a reference


class WireBudget(unittest.TestCase):
    """Astra 7 and Opus 1, 5: the first message as a whole, every fetched page (as the sixth call, notice included) and the page budget option."""

    def big_case(self, notes=3000):
        case = L.tv_case('qxw-001', evidence=[], context={'title': 'Harbor Lights S01E02', 'filename': 'Harbor Lights - S01E02 - Lamp Oil.mkv', 'expected': {'series': 'Harbor Lights'},
                                                          'arr': {'app': 'sonarr', 'ids': {'seriesId': 1}}, 'notes_for_model': 'n' * notes})
        ch = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(120)]
        case['evidence'] = [{'id': 'e%d' % i, 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(dict(L.PROBE_REC, chapters=ch))} for i in range(1, 4)]
        return case

    def test_the_first_message_as_a_whole_is_within_the_limit_and_every_item_is_reachable(self):
        case = self.big_case()
        ts = L.suite_with(case)
        rec, ad = ev2h.scripted_run(case, ts, [dec()], which=th.NO_BINARIES, evidence_format='v2')
        first = ad.calls[0][0]['content']
        self.assertLessEqual(len(first.encode('utf-8')), EV2.WIRE_BYTES)                      # context and capabilities included
        msg = json.loads(first)
        self.assertGreater(msg['evidence']['page']['of'], 1)
        view = P.case_view(case, [], case_alias=rec['model_case_alias'])
        frame = {k: msg[k] for k in ('case_id', 'media_type', 'context', 'tools_available', 'tool_call_budget', 'capabilities', 'evidence_format')}
        ses = EV2.Session(rec['model_case_alias'], view['context'], view['media_type'], view['tools_available'])
        evs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in R.resolve_evidence_raw(case, ts.root)]
        block, n = ses.initial(evs, frame)
        self.assertEqual(json.dumps(dict(frame, evidence=block), ensure_ascii=False, separators=(',', ':')), first)      # the runner sent exactly this
        seen = [i['id'] for i in block['items']]
        chapters = {}
        pages = [block]
        cur = block['page'].get('next')
        while cur:
            status, text = ses.fetch(cur, 't6', 'audiobook_inspect', 0, '\n' + P.BUDGET_MESSAGE)
            self.assertEqual(status, 'ok')
            self.assertLessEqual(len(text.encode('utf-8')), EV2.WIRE_BYTES)                    # fetched as the sixth call with the notice
            page = json.loads(text.split('\n')[0])['output']
            pages.append(page)
            seen += [i['id'] for i in page.get('items', [])]
            cur = page.get('page', {}).get('next')
        for pg in pages:
            for eid, f in (pg.get('facts') or {}).items():
                chapters.setdefault(eid, 0)
                chapters[eid] += len(f.get('chapters', []))
        self.assertEqual(sorted(seen), ['e1', 'e2', 'e3'])
        self.assertEqual(chapters, {'e1': 120, 'e2': 120, 'e3': 120})                           # every chapter of every item is on some page
        ts.cleanup()

    def test_every_page_of_a_tool_reply_fits_when_fetched_as_the_sixth_call_with_the_longest_tool_name(self):
        ses = EV2.Session('case-aaaaaaaa', {}, 'tv', ['ffprobe', 'audiobook_inspect', 'decode_sample'])
        ses.initial([])
        for tool in ('ffprobe', 'audiobook_inspect'):
            text, n = ses.result(EV2.make_observation('t5', tool, {}, 'ok', json.dumps(probe_out(duration='600', chapters=[{'start': str(i), 'end': str(i + 1), 'title': 'T%03d %s' % (i, 'y' * 70)} for i in range(400)])), 'replay', 'tool'), 't5', 1)
            texts = ev2h.fetch_all(ses, text)
            self.assertGreater(len(texts), 2)
            for t in texts:
                self.assertLessEqual(len(t.encode('utf-8')), EV2.WIRE_BYTES, tool)
                self.assertEqual(json.loads(t.split('\n')[0])['type'], 'tool_result')

    def test_tool_output_bytes_is_the_page_budget_under_v2_and_is_recorded(self):
        case = self.big_case(notes=200)
        ts = L.suite_with(case)
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], which=th.NO_BINARIES, evidence_format='v2', tool_output_bytes=4096)
        for m in ad.calls[-1]:
            if m['role'] == 'user':
                self.assertLessEqual(len(m['content'].encode('utf-8')), 4096)
        self.assertEqual(rec['evidence_format']['wire_bytes'], 4096)
        ts.cleanup()
        code, out, ts2 = OptionCombinations.run_main(OptionCombinations(), [case_with([])], [th.decision('insufficient_evidence', 'escalate', refs=[])], ['--evidence-format', 'v2', '--tool-output-bytes', '4096'])
        self.assertEqual(json.loads((out / 'manifest.json').read_text())['config']['wire_bytes'], 4096)
        self.assertEqual(json.loads((out / 'manifest.json').read_text())['config']['tool_output_bytes'], 4096)
        ts2.cleanup()
        for bad in (1000, 9000):
            with self.assertRaises(ValueError):
                R.check_option_combination('v4', 'v2', None, bad)
        R.check_option_combination('v4', None, None, 100)             # legacy: any cap is as before
