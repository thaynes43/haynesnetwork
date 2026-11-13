"""#213: frame_sample under tools behaviour v3-remote-2 takes the per-file input quota (second live finding: the fixed 8 MiB gave `no frame produced` on 28 Mbit/s files).
The REAL mrh-sampler-4 runs locally over made-up sparse files with a fake ffmpeg (rem2_h.py).  No cluster, no model, no network, no real media."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import rem2_h as H2
import rem_h as H
import th
from media_repair_harness import remote_evidence as RE
from media_repair_harness import remote_evidence_2 as R2
from media_repair_harness import tools as T

SAMPLER_4_SHA256 = 'de074d234dcf909bfd42fda027dff69d8d2aac6e1c7b1b37ab7bc6f0a1fa9233'
COMPONENT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('series_scan', COMPONENT / 'scripts' / 'series_scan.py')
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
QUOTA = 4 * 16_000_000 // 8 * 2 + 6_048_576          # the 200 MB / 100 s rig: 16 Mbit/s container average, 4 s lead-in, margin 2.0


class FrameQuota(unittest.TestCase):
    def rig(self, **kw):
        return H2.Rig(self, **kw)

    def test_a_frame_that_needs_more_than_8_mib_is_produced_under_the_computed_quota(self):
        rig = self.rig(need_bytes=15_000_000)                         # one GOP of high-bitrate video: more than the old fixed 8 MiB
        r = rig.call('frame_sample', {'at': 120})
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'ok')
        self.assertEqual((out['frame'], out['width'], out['height']), ('frame@120', 640, 360))
        self.assertEqual((out['quota_bytes'], out['quota_exhausted'], out['frame_produced']), (QUOTA, False, True))
        self.assertGreater(out['bytes_read'], 8_388_608)
        self.assertIn('frame@120', rig.ctx.frames)
        q = rig.last_entry()['quota']
        self.assertEqual((q['quota_basis'], q['quota_bytes'], q['bytes_read'] > 8_388_608, q['quota_exhausted'], q['frame_produced']), ('container_average', QUOTA, True, False, True))
        self.assertEqual((q['window_s'], q['window_role'], q['window_source'], q['window_measure']), (4, 'keyframe_lead_in', 'decode_window_starting_value', 'frame_produced'))
        self.assertEqual((q['margin'], q['overhead_bytes'], q['quota_inputs']['selected_streams']), ('2.0', 6_048_576, [0]))
        self.assertEqual(r['quota'], q)
        self.assertEqual(rig.last_entry()['receipt']['input_quota_bytes'], QUOTA)
        argv = rig.last_entry()['argv']
        self.assertEqual((argv[argv.index('--input-quota-bytes') + 1], argv[argv.index('-') + 1]), (str(QUOTA), 'frame'))

    def test_the_same_read_at_the_old_fixed_8_mib_is_the_failure_the_live_check_saw(self):
        rig = self.rig(need_bytes=15_000_000)
        want = H2.identity(rig.path)
        argv = ['frame', str(rig.path), '--at', '120', '--root', str(rig.root)]
        argv += [str(v) for key in ('size', 'mtime_ns', 'dev', 'ino') for v in ('--expect-' + key.replace('_', '-'), want[key])]
        env = dict(os.environ, PATH=str(rig.pod.bin) + os.pathsep + os.environ.get('PATH', ''))
        done = subprocess.run([sys.executable, '-'] + argv, input=R2.SAMPLER.read_bytes(), capture_output=True, timeout=30, env=env)      # no --input-quota-bytes: 8 MiB
        receipt = json.loads(done.stderr.decode().strip().splitlines()[-1])
        self.assertEqual((receipt['exit_code'], receipt['quota_exhausted'], receipt['bytes_read'], done.stdout), (0, True, 8_388_608, b''))

    def test_a_frame_cut_by_the_quota_is_partial_says_so_and_is_not_blamed_on_the_file(self):
        rig = self.rig(need_bytes=60_000_000)
        r = rig.call('frame_sample', {'at': 60})
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'partial')
        self.assertEqual((out['note'], out['frame_produced'], out['quota_exhausted'], out['bytes_read'], out['quota_bytes']), ('no frame produced', False, True, QUOTA, QUOTA))
        self.assertIn('per-file input limit of %d bytes' % QUOTA, out['scope_limit'])
        self.assertIn('4 s lead-in', out['scope_limit'])
        self.assertIn('not evidence that the file is corrupt', out['scope_limit'])
        self.assertNotIn('stderr', out)                               # the decoder's read errors are a result of the cut
        self.assertNotIn('frame@60', rig.ctx.frames)
        q = rig.last_entry()['quota']
        self.assertEqual((q['frame_produced'], q['quota_exhausted'], q['bytes_read']), (False, True, QUOTA))

    def test_no_frame_without_a_quota_cut_is_an_error_with_the_decoders_text(self):
        rig = self.rig(need_bytes=100, no_frame=True)
        r = rig.call('frame_sample', {'at': 5})
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'error')
        self.assertEqual((out['note'], out['frame_produced'], out['quota_exhausted']), ('no frame produced', False, False))
        self.assertIn('stderr', out)
        self.assertNotIn('scope_limit', out)
        self.assertFalse(rig.last_entry()['quota']['frame_produced'])

    def test_a_file_without_a_duration_or_without_a_probe_runs_nothing(self):
        rig = self.rig(probe=dict(H2.PROBE2, format={'format_name': 'matroska,webm'}))
        r = rig.call('frame_sample', {'at': 5})
        self.assertEqual(r['status'], 'unavailable')
        self.assertIn('quota_basis: unavailable', r['output'])
        self.assertEqual((rig.pod.execs, r['receipts']), (0, []))
        rig = self.rig(probe=None)
        self.assertEqual(rig.call('frame_sample', {'at': 5})['status'], 'unavailable')
        self.assertEqual(rig.pod.execs, 0)

    def test_a_probe_without_a_video_stream_runs_nothing(self):
        rig = self.rig(probe={'format': H2.PROBE2['format'], 'streams': [s for s in H2.PROBE2['streams'] if s['codec_type'] != 'video']})
        r = rig.call('frame_sample', {'at': 5})
        self.assertEqual(r['status'], 'error')
        self.assertIn('no video stream', r['output'])
        self.assertEqual(rig.pod.execs, 0)

    def test_a_small_file_keeps_the_8_mib_floor_and_the_quota_never_exceeds_the_file(self):
        rig = self.rig(size=5_000_000, need_bytes=1000)
        rig.call('frame_sample', {'at': 0})
        q = rig.last_entry()['quota']
        self.assertEqual((q['quota_bytes'], q['clamped'], q['frame_produced']), (8_388_608, 'floor', True))

    def test_the_quota_is_sized_by_the_video_stream_alone(self):
        probe = dict(H2.PROBE2, streams=[dict(H2.PROBE2['streams'][0], tags={'BPS': '40000000'})] + H2.PROBE2['streams'][1:])
        rig = self.rig(probe=probe, need_bytes=1000)
        rig.call('frame_sample', {'at': 0})
        q = rig.last_entry()['quota']
        self.assertEqual((q['quota_basis'], q['quota_inputs']['selected_streams'], q['quota_inputs']['track_bps_sum']), ('track_bps_sum', [0], 40_000_000))
        self.assertEqual(q['quota_bytes'], 4 * 40_000_000 // 8 * 2 + 6_048_576)

    def test_the_capability_advertises_the_computed_limit_and_says_the_window_is_a_starting_value(self):
        rig = self.rig()
        cap = {c['tool']: c for c in T.capabilities(rig.ctx)}['frame_sample']
        self.assertEqual((cap['available'], cap['input_limit_bytes'], cap['window_s']), (True, QUOTA, 4))
        self.assertIn('not a fixed number', cap['input_limit'])
        self.assertIn('starting value', cap['note'])
        self.assertIn('not evidence of corruption', cap['note'])
        rig = self.rig(probe=dict(H2.PROBE2, format={'format_name': 'matroska,webm'}))
        cap = {c['tool']: c for c in T.capabilities(rig.ctx)}['frame_sample']
        self.assertFalse(cap['available'])
        self.assertIn('quota_basis: unavailable', cap['why'])

    def test_the_run_config_records_the_frame_window_and_its_source(self):
        cfg = R2.config()
        self.assertEqual((cfg['frame_window_s'], cfg['frame_window_source']), (4, 'decode_window_starting_value'))

    def test_the_sampler_and_v3_remote_1_are_unchanged_and_v3_remote_1_keeps_the_fixed_frame_quota(self):
        self.assertEqual(R2.sampler_sha256(), SAMPLER_4_SHA256)
        case = H.remote_case(tools=['ffprobe', 'frame_sample'])
        sampler = H.FakeSampler()
        fx = T.Fixture.from_case(case, '.')
        ctx = T.Context(case, fx, tempfile.mkdtemp(), runner=sampler, which=th.NO_BINARIES, tools_behavior='v3-remote-1',
                        remote_binding=RE.binding_for_case(case, RE.HostState()))
        T.call_tool(ctx, 'frame_sample', {'at': 5})
        self.assertNotIn('--input-quota-bytes', sampler.calls[0])
        self.assertFalse(any('quota' in e for e in ctx.remote_binding.receipts))

    def test_the_scan_report_counts_a_frame_call_as_a_windowed_read_under_v3_remote_2_only(self):
        for need, want in ((15_000_000, 'ok'), (60_000_000, 'short:quota')):
            rig = self.rig(need_bytes=need)
            r = rig.call('frame_sample', {'at': 30})
            rec = {'tool_calls': [dict(r, tool='frame_sample', id='t1')]}
            self.assertEqual(S.window_calls(rec), [('frame_sample', want)], need)
        rig = self.rig(need_bytes=100, no_frame=True)
        rec = {'tool_calls': [dict(rig.call('frame_sample', {'at': 30}), tool='frame_sample', id='t1')]}
        self.assertEqual(S.window_calls(rec), [('frame_sample', 'short')])
        v1 = {'tool_calls': [{'tool': 'frame_sample', 'id': 't1', 'receipts': [{'mode': 'frame', 'outcome': 'ok', 'receipt': {'quota_exhausted': True}}]}]}
        self.assertEqual(S.window_calls(v1), [])


if __name__ == '__main__':
    unittest.main()
