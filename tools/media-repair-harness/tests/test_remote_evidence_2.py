"""#213 acceptance: tools behaviour v3-remote-2 (remote_evidence_2.py, remote_quota.py, mrh-sampler-4) and the guarantee that v3-remote-1 and the earlier
samplers are unchanged.  The REAL mrh-sampler-4 runs locally over made-up sparse files with a fake ffmpeg (rem2_h.py); fake runners elsewhere.  No cluster, no model,
no network, no real media; every path, size and bitrate is made up."""
import copy
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import rem2_h as H2
import rem_h as H
import th
from media_repair_harness import adapters as A
from media_repair_harness import remote_evidence as RE
from media_repair_harness import remote_evidence_2 as R2
from media_repair_harness import remote_quota as RQ
from media_repair_harness import run as R
from media_repair_harness import tools as T

# the earlier samplers, byte for byte (mrh-sampler-1, -2, -3): nothing in #213 may change what a v3-remote-1 run (or any earlier behaviour) sends
SAMPLER_SHA256 = {'remote_sampler.py': '9c949e130f67ff76f7a0f7ba18343baebb53a17b295141c0e1470b04c252a3ad',
                  'remote_sampler_v2.py': '870f1f98979aeb42b199e4473a359ca107d6e7942cdb02f33e8b1fe8f899f885',
                  'remote_sampler_v3.py': '7ecc2f43fb5329050d8403fe2f25e119f27060eaaaaf7c912ab3638905e88d96'}
SRC = Path(RE.__file__).resolve().parent


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def probe_of(duration='100.0', bit_rate=None, streams=None, **fmt):
    f = {'format_name': 'matroska,webm'}
    if duration is not None:
        f['duration'] = duration
    if bit_rate is not None:
        f['bit_rate'] = bit_rate
    f.update(fmt)
    return {'format': f, 'streams': streams if streams is not None else [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'},
                                                                         {'index': 1, 'codec_type': 'audio', 'codec_name': 'dts'}]}


def plan(size=1_000_000_000, probe=None, window=4, selected=None):
    probe = probe or probe_of()
    return RQ.plan(size, probe, window, probe['streams'] if selected is None else selected)


class QuotaPlan(unittest.TestCase):
    def test_container_average_wins_when_it_is_the_largest(self):
        p = plan(probe=probe_of(bit_rate='50000000'))
        self.assertEqual((p['quota_basis'], p['quota_inputs']['bitrate_bps']), ('container_average', 80_000_000))      # 1e9 bytes * 8 / 100 s
        self.assertEqual(p['quota_bytes'], 4 * 80_000_000 // 8 * 2 + RQ.OVERHEAD_BYTES)                                    # 80,000,000 + 6,048,576
        self.assertEqual(p['quota_bytes'], 86_048_576)

    def test_format_bit_rate_wins_when_it_is_the_largest(self):
        p = plan(probe=probe_of(bit_rate='90000000'))
        self.assertEqual((p['quota_basis'], p['quota_inputs']['bitrate_bps'], p['quota_inputs']['container_average_bps']), ('format_bit_rate', 90_000_000, 80_000_000))
        self.assertEqual(p['quota_bytes'], 90_000_000 + RQ.OVERHEAD_BYTES)

    def test_the_track_bps_sum_wins_when_it_is_the_largest(self):
        streams = [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'tags': {'BPS': '70000000'}},
                   {'index': 1, 'codec_type': 'audio', 'codec_name': 'dts', 'tags': {'BPS-eng': '30000000', 'language': 'eng'}}]
        p = plan(probe=probe_of(bit_rate='90000000', streams=streams))
        self.assertEqual(p['quota_basis'], 'track_bps_sum')
        i = p['quota_inputs']
        self.assertEqual((i['track_bps_sum'], i['bitrate_bps']), (100_000_000, 100_000_000))
        self.assertEqual(i['track_bps'], [{'stream': 0, 'tag': 'BPS', 'bps': 70_000_000}, {'stream': 1, 'tag': 'BPS-eng', 'bps': 30_000_000}])
        self.assertEqual(p['quota_bytes'], 100_000_000 + RQ.OVERHEAD_BYTES)

    def test_a_track_tag_counts_only_for_the_selected_streams_and_bps_beats_bps_eng(self):
        streams = [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'tags': {'BPS': '1000', 'BPS-eng': '999999999'}},
                   {'index': 1, 'codec_type': 'audio', 'codec_name': 'dts', 'tags': {'BPS': '5000000000'}}]
        p = plan(probe=probe_of(streams=streams), selected=streams[:1])
        self.assertEqual(p['quota_inputs']['track_bps'], [{'stream': 0, 'tag': 'BPS', 'bps': 1000}])      # the audio stream's huge tag is not read: it is not selected
        self.assertEqual(p['quota_basis'], 'container_average')
        self.assertEqual(p['quota_inputs']['tracks_without_bps'], [])

    def test_streams_without_a_tag_are_recorded_and_never_lower_the_rate(self):
        p = plan(probe=probe_of(streams=[{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'tags': {'BPS': '1000'}},
                                         {'index': 1, 'codec_type': 'audio', 'codec_name': 'dts'}]))
        self.assertEqual(p['quota_inputs']['tracks_without_bps'], [1])
        self.assertEqual(p['quota_basis'], 'container_average')

    def test_a_tie_goes_to_the_first_source(self):
        p = plan(probe=probe_of(bit_rate='80000000'))
        self.assertEqual(p['quota_basis'], 'container_average')

    def test_the_container_average_is_rounded_up_and_the_inputs_reproduce_the_quota(self):
        p = plan(size=1_000_000_001, probe=probe_of(duration='99.9'))
        i = p['quota_inputs']
        self.assertEqual(i['container_average_bps'], math.ceil(Fraction(1_000_000_001 * 8) / Fraction('99.9')))
        again = math.ceil(Fraction(p['window_s']) * i['bitrate_bps'] / 8 * Fraction(p['margin'])) + p['overhead_bytes']
        self.assertEqual(p['quota_bytes'], again)

    def test_a_missing_or_unparsable_duration_has_no_quota(self):
        for bad in (None, '', 'N/A', 'abc', '-5', '0', '1.2.3', float('nan'), float('inf'), True, [], {}):
            probe = probe_of(duration=bad) if bad is not None else probe_of(duration=None)
            p = plan(probe=probe)
            self.assertEqual((p['quota_basis'], p['quota_bytes']), ('unavailable', None), repr(bad))
            self.assertIn('duration', p['reason'])
        p = RQ.plan(1000, {}, 4, [])                      # no probe at all
        self.assertEqual((p['quota_basis'], p['quota_bytes']), ('unavailable', None))

    def test_a_missing_or_unusable_size_has_no_quota(self):
        for bad in (None, 0, -1, True, 1.5, '100', [1]):
            p = RQ.plan(bad, probe_of(), 4, [])
            self.assertEqual((p['quota_basis'], p['quota_bytes']), ('unavailable', None), repr(bad))
            self.assertIn('size', p['reason'])

    def test_an_unusable_bit_rate_is_ignored_not_guessed(self):
        for bad in ('N/A', '', '-1', '0', 'x'):
            p = plan(probe=probe_of(bit_rate=bad))
            self.assertEqual((p['quota_basis'], p['quota_inputs']['format_bit_rate_bps']), ('container_average', None), repr(bad))

    def test_the_floor_keeps_a_small_file_at_todays_8_mib(self):
        p = plan(size=100_000_000, probe=probe_of(duration='1000.0'))      # 0.8 Mbit/s
        self.assertEqual((p['quota_bytes'], p['clamped'], p['quota_basis']), (RQ.FLOOR_BYTES, 'floor', 'container_average'))
        self.assertLess(p['raw_bytes'], RQ.FLOOR_BYTES)
        tiny = plan(size=3_000_000, probe=probe_of(duration='100.0'))      # smaller than the floor itself
        self.assertEqual((tiny['quota_bytes'], tiny['clamped']), (RQ.FLOOR_BYTES, 'floor'))
        self.assertEqual(RQ.FLOOR_BYTES, 8 * 1024 * 1024)

    def test_the_quota_never_exceeds_the_file_size(self):
        p = plan(size=20_000_000, probe=probe_of(duration='1.0'))          # 160 Mbit/s for a 20 MB file
        self.assertEqual((p['quota_bytes'], p['clamped']), (20_000_000, 'file_size'))
        self.assertGreater(p['raw_bytes'], 20_000_000)

    def test_a_longer_window_gets_a_larger_quota(self):
        self.assertLess(plan(window=4)['quota_bytes'], plan(window=8)['quota_bytes'])

    def test_it_is_deterministic(self):
        a, b = plan(probe=probe_of(bit_rate='85000000')), plan(probe=probe_of(bit_rate='85000000'))
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertEqual(plan(size=1_234_567_891)['quota_bytes'], plan(size=1_234_567_891)['quota_bytes'])

    def test_margin_and_overhead_are_named_versioned_and_in_every_record(self):
        for p in (plan(), plan(probe=probe_of(duration=None)), plan(size=3_000_000)):
            self.assertEqual((p['quota_rule'], p['margin'], p['overhead_bytes'], p['floor_bytes']), ('dynamic-quota-1', '2.0', 6_048_576, RQ.FLOOR_BYTES))
        self.assertEqual(RQ.OVERHEAD_BYTES, RQ.PROBE_READ_BYTES + RQ.INDEX_ALLOWANCE_BYTES)
        self.assertEqual(RQ.PARAMETERS['starting_values'], ['margin', 'index_allowance_bytes', 'window_tolerance_s'])
        self.assertEqual(R2.config()['quota'], RQ.PARAMETERS)

    def test_the_probe_read_in_the_overhead_is_the_samplers_own_probesize(self):
        text = (SRC / 'remote_sampler_v4.py').read_text()
        self.assertIn("'-probesize', '%d'" % RQ.PROBE_READ_BYTES, text)


class WindowCheck(unittest.TestCase):
    def test_decode_and_audio_are_measured_by_the_decoded_output_time(self):
        for mode in ('decode', 'audio'):
            self.assertEqual(RQ.window_check(mode, 4, 0, False, False, 4.0), (True, 'out_time'))
            self.assertEqual(RQ.window_check(mode, 4, 0, False, False, 3.75), (True, 'out_time'))       # within the tolerance
            self.assertEqual(RQ.window_check(mode, 4, 0, False, False, 4.3), (True, 'out_time'))
            self.assertEqual(RQ.window_check(mode, 4, 0, True, False, 3.5), (False, 'out_time'))
            self.assertEqual(RQ.window_check(mode, 4, 0, False, False, 0.0), (False, 'out_time'))
            for unknown in (None, float('nan'), 'x', True):
                self.assertEqual(RQ.window_check(mode, 4, 0, False, False, unknown), (None, 'out_time_unavailable'))

    def test_a_sparse_subtitle_stream_is_complete_only_when_the_read_was_not_cut(self):
        self.assertEqual(RQ.window_check('subtitle', 8, 0, False, False, None), (True, 'read_not_cut'))
        self.assertEqual(RQ.window_check('subtitle', 8, 0, True, False, 7.9), (False, 'read_not_cut'))
        self.assertEqual(RQ.window_check('subtitle', 8, 'timeout', False, True, 7.9), (False, 'read_not_cut'))
        self.assertEqual(RQ.window_check('subtitle', 8, 1, False, False, 8.0), (False, 'read_not_cut'))

    def test_clock_format(self):
        self.assertEqual(RQ.clock(4.0), '00:00:04.000000')
        self.assertEqual(RQ.clock(3725.5), '01:02:05.500000')
        self.assertIsNone(RQ.clock(None))
        self.assertIsNone(RQ.clock(float('nan')))


class SamplerV4(unittest.TestCase):
    """The real remote_sampler_v4.py, run locally (fake ffmpeg / ffprobe first on PATH)."""

    def setUp(self):
        self.rig = H2.Rig(self, size=30_000_000, need_bytes=100)
        self.pod = self.rig.pod

    def invoke(self, mode='decode', options=(), path=None):
        path = path or self.rig.path
        want = H2.identity(path)
        argv = [mode, str(path), '--at', '1', '--root', str(self.rig.root)]
        argv += [str(v) for key in ('size', 'mtime_ns', 'dev', 'ino') for v in ('--expect-' + key.replace('_', '-'), want[key])]
        argv += [str(x) for x in options]
        env = dict(os.environ, PATH=str(self.pod.bin) + os.pathsep + os.environ.get('PATH', ''))
        done = subprocess.run([sys.executable, '-'] + argv, input=R2.SAMPLER.read_bytes(), capture_output=True, timeout=30, env=env)
        lines = [ln for ln in done.stderr.decode().splitlines() if ln.strip()]
        return done, json.loads(lines[-1])

    def test_the_default_is_8_mib_and_any_integer_from_the_floor_is_enforced_and_recorded(self):
        _d, default = self.invoke()
        self.assertEqual((default['receipt'], default['input_quota_bytes'], default['exit_code']), ('mrh-sampler-4', 8_388_608, 0))
        _d, big = self.invoke(options=('--input-quota-bytes', 22_048_576))
        self.assertEqual((big['input_quota_bytes'], big['exit_code']), (22_048_576, 0))

    def test_a_quota_below_the_floor_or_above_the_sanity_bound_is_refused_before_the_source_is_opened(self):
        for value in (8_388_607, 0, -1, 2 ** 40 + 1, 'many'):
            _d, r = self.invoke(options=('--input-quota-bytes', value))
            self.assertEqual((r['exit_code'], r['bytes_read']), ('error', 0), value)
            self.assertIsNone(r['identity']['start'], value)

    def test_the_quota_is_a_hard_limit_on_the_bytes_read(self):
        rig = H2.Rig(self, size=60_000_000, need_bytes=50_000_000)
        self.rig, self.pod = rig, rig.pod
        _d, r = self.invoke(options=('--input-quota-bytes', 12_000_000))
        self.assertEqual((r['bytes_read'], r['quota_exhausted']), (12_000_000, True))
        _d, r = self.invoke(options=('--input-quota-bytes', 55_000_000))
        self.assertEqual((r['bytes_read'] >= 50_000_000, r['bytes_read'] <= 55_000_000, r['quota_exhausted']), (True, True, False))

    def test_decode_audio_and_subtitle_report_the_window_and_what_ffmpeg_wrote(self):
        for mode, extra in (('decode', ()), ('audio', ('--stream', 1)), ('subtitle', ('--stream', 3))):
            _d, r = self.invoke(mode, ('--window', 4) + extra)
            self.assertEqual((r['window_s'], r['progress']), (4.0, {'out_time_s': 4.0, 'frames': 96}), mode)

    def test_a_report_ffmpeg_did_not_give_stays_null(self):
        rig = H2.Rig(self, size=30_000_000, need_bytes=100, no_progress=True)
        self.rig, self.pod = rig, rig.pod
        _d, r = self.invoke('decode', ('--window', 4))
        self.assertEqual(r['progress'], {'out_time_s': None, 'frames': None})

    def test_probe_keeps_mrh_sampler_3s_argv_and_carries_no_window(self):
        _d, r = self.invoke('probe')
        self.assertEqual((r['window_s'], r['progress'], r['input_quota_bytes']), (None, None, 8_388_608))
        self.assertNotIn('-progress', r['argv'])

    def test_audio_first_maps_0_a_0_and_an_explicit_stream_maps_that_absolute_index(self):
        _d, r = self.invoke('audio', ('--window', 4, '--audio-first'))
        self.assertEqual(r['argv'][r['argv'].index('-map') + 1], '0:a:0')
        _d, r = self.invoke('audio', ('--window', 4, '--stream', 4))
        self.assertEqual(r['argv'][r['argv'].index('-map') + 1], '0:4')
        _d, r = self.invoke('decode', ('--audio-first',))
        self.assertEqual((r['exit_code'], r['bytes_read']), ('error', 0))

    def test_progress_never_reaches_stdout_and_the_payload_is_intact(self):
        d, r = self.invoke('audio', ('--window', 4, '--audio-first'))
        self.assertTrue(d.stdout.startswith(b'RIFF'))
        self.assertEqual(r['stdout_bytes'], len(d.stdout))
        self.assertNotIn('out_time', d.stdout[:200].decode('latin-1'))

    def test_the_other_limits_are_unchanged(self):
        text = R2.SAMPLER.read_text()
        for needle in ('LIMIT_S = 25', 'END_RESERVE_S = 2', "'nice', '-n', '19'", "'-threads', '1'", 'O_NOFOLLOW', "'-protocol_whitelist', 'http,tcp'"):
            self.assertIn(needle, text)
        self.assertEqual(R2.RE.SAMPLER_TIMEOUT_S, 25)
        self.assertEqual(R2.RE.OUTER_DEADLINE_S, 60)

    def test_the_earlier_samplers_and_the_v1_config_are_byte_identical(self):
        for name, want in SAMPLER_SHA256.items():
            self.assertEqual(sha(SRC / name), want, name)
        cfg = RE.config()
        self.assertEqual((cfg['version'], cfg['sampler'], cfg['sampler_sha256']), ('v3-remote-1', 'mrh-sampler-2', SAMPLER_SHA256['remote_sampler_v2.py']))
        self.assertNotIn('quota', cfg)
        self.assertNotEqual(R2.sampler_sha256(), RE.sampler_sha256())


class Tools(unittest.TestCase):
    def rig(self, **kw):
        return H2.Rig(self, **kw)

    # ---- decode_sample
    def test_a_completed_window_records_the_quota_the_basis_the_bytes_and_the_decoded_time(self):
        rig = self.rig(need_bytes=15_000_000)
        r = rig.call('decode_sample', {'at': 10})
        self.assertEqual(r['status'], 'ok')
        out = json.loads(r['output'])
        self.assertEqual((out['window_completed'], out['quota_exhausted'], out['clean'], out['out_time'], out['window_s']), (True, False, True, '00:00:04.000000', 4))
        self.assertEqual(out['streams_selected'], ['0:v:0', '0:a:0'])
        self.assertEqual((out['quota_bytes'], out['frames']), (22_048_576, 96))
        self.assertNotIn('scope_limit', out)
        q = rig.last_entry()['quota']
        self.assertEqual((q['quota_basis'], q['quota_bytes'], q['margin'], q['overhead_bytes'], q['quota_exhausted']),
                         ('container_average', 22_048_576, '2.0', 6_048_576, False))
        self.assertTrue(15_000_000 <= q['bytes_read'] <= 22_048_576)                       # the fake read the 15 MB its decode needs (the server serves in chunks)
        self.assertEqual((q['window_requested_s'], q['out_time_s'], q['out_time'], q['window_completed'], q['window_measure']), (4, 4.0, '00:00:04.000000', True, 'out_time'))
        self.assertEqual(q['quota_inputs']['bitrate_bps'], 16_000_000)
        self.assertEqual(r['quota'], q)                                                       # the same record on the call
        self.assertEqual(rig.last_entry()['receipt']['input_quota_bytes'], 22_048_576)
        argv = rig.last_entry()['argv']
        self.assertEqual(argv[argv.index('--input-quota-bytes') + 1], '22048576')

    def test_a_window_that_ran_short_of_the_quota_is_measured_and_said_plainly(self):
        rig = self.rig(need_bytes=60_000_000)                                                   # the decode wants more than the computed quota of 22,048,576
        r = rig.call('decode_sample', {'at': 10})
        self.assertEqual(r['status'], 'partial')
        out = json.loads(r['output'])
        self.assertEqual((out['window_completed'], out['quota_exhausted'], out['clean'], out['bytes_read']), (False, True, False, 22_048_576))
        self.assertIn('per-file input limit of 22048576 bytes', out['scope_limit'])
        self.assertIn('not evidence that the file is corrupt', out['scope_limit'])
        self.assertIn('only 1.47 s was decoded of the requested 4 s', out['scope_limit'])
        self.assertIn('quota-limited sample does not prove corruption', out['note'])
        q = rig.last_entry()['quota']
        self.assertEqual((q['window_completed'], q['quota_exhausted'], q['bytes_read']), (False, True, 22_048_576))
        self.assertAlmostEqual(q['out_time_s'], 1.468, places=2)

    def test_a_short_window_without_the_quota_is_measured_and_not_blamed_on_it(self):
        rig = self.rig(need_bytes=10_000_000, out_time=2.0)
        out = json.loads(rig.call('decode_sample', {'at': 10})['output'])
        self.assertEqual((out['window_completed'], out['quota_exhausted']), (False, False))
        self.assertIn('did not reach its input limit', out['scope_limit'])
        self.assertIn('not by itself evidence that the file is corrupt', out['scope_limit'])

    def test_an_unreported_decoded_time_leaves_the_window_unmeasured_not_guessed(self):
        rig = self.rig(need_bytes=10_000_000, no_progress=True)
        r = rig.call('decode_sample', {'at': 10})
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['window_completed'], out['clean'], out['out_time']), ('partial', None, False, None))
        self.assertIn('not known', out['scope_limit'])
        self.assertEqual(rig.last_entry()['quota']['window_measure'], 'out_time_unavailable')

    def test_a_file_without_a_duration_gets_no_quota_and_nothing_runs(self):
        rig = self.rig(probe=dict(H2.PROBE2, format={'format_name': 'matroska,webm'}))
        r = rig.call('decode_sample', {'at': 10})
        self.assertEqual(r['status'], 'unavailable')
        self.assertIn('quota_basis: unavailable', r['output'])
        self.assertIn('Nothing was run', r['output'])
        self.assertEqual((r['quota']['quota_basis'], r['quota']['quota_bytes']), ('unavailable', None))
        self.assertEqual((rig.pod.execs, r['receipts']), (0, []))

    def test_a_case_without_a_probe_runs_nothing(self):
        rig = self.rig(probe=None)
        for tool, args in (('decode_sample', {'at': 1}), ('audio_sample', {'at': 1}), ('subtitle_sample', {'at': 1})):
            r = rig.call(tool, args)
            self.assertEqual(r['status'], 'unavailable', tool)
        self.assertEqual(rig.pod.execs, 0)

    def test_a_small_file_keeps_the_8_mib_floor(self):
        rig = self.rig(size=5_000_000, need_bytes=1000)
        rig.call('decode_sample', {'at': 0})
        q = rig.last_entry()['quota']
        self.assertEqual((q['quota_bytes'], q['clamped']), (8_388_608, 'floor'))

    def test_a_full_decode_request_is_a_window_and_says_so(self):
        rig = self.rig(need_bytes=15_000_000)
        r = rig.call('decode_sample', {'full': True})
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['at_s'], out['completed_to_eof']), ('partial', 0.0, False))
        self.assertIn('per-file input limit', out['request_unmet']['reason'])

    # ---- audio_sample
    def test_audio_defaults_to_the_first_audio_stream(self):
        rig = self.rig(need_bytes=15_000_000)
        r = rig.call('audio_sample', {'at': 10})
        self.assertEqual(r['status'], 'ok')
        out = json.loads(r['output'])
        self.assertEqual((out['stream'], out['stream_selection'], out['window_completed'], out['quota_bytes']), (1, 'the first audio stream (0:a:0)', True, 22_048_576))
        entry = rig.last_entry()
        self.assertIn('--audio-first', entry['argv'])
        self.assertNotIn('--stream', entry['argv'])
        ffargv = entry['receipt']['argv']
        self.assertEqual(ffargv[ffargv.index('-map') + 1], '0:a:0')
        self.assertEqual((entry['quota']['quota_inputs']['selected_streams'], entry['quota']['quota_basis']), ([1], 'container_average'))

    def test_an_audio_stream_index_is_the_absolute_ffprobe_index(self):
        rig = self.rig(need_bytes=15_000_000)
        out = json.loads(rig.call('audio_sample', {'at': 10, 'stream': 4})['output'])
        self.assertEqual((out['stream'], out['stream_selection']), (4, 'the stream index given'))
        entry = rig.last_entry()
        self.assertEqual(entry['argv'][entry['argv'].index('--stream') + 1], '4')
        self.assertNotIn('--audio-first', entry['argv'])
        ffargv = entry['receipt']['argv']
        self.assertEqual(ffargv[ffargv.index('-map') + 1], '0:4')

    def test_a_stream_that_is_not_audio_is_refused_by_name_without_running_ffmpeg(self):
        rig = self.rig()
        for index, what in ((0, 'stream 0 is a video stream (h264)'), (2, 'stream 2 is a subtitle stream (hdmv_pgs_subtitle)'),
                            (99, 'stream 99 is not in this file\'s probe result')):
            r = rig.call('audio_sample', {'at': 10, 'stream': index})
            self.assertEqual(r['status'], 'error', index)
            self.assertTrue(r['output'].startswith('bad arguments: audio_sample: '), r['output'])
            self.assertIn(what, r['output'])
            self.assertIn('The audio stream indexes of this file are [1, 4]', r['output'])
            self.assertIn('Nothing was run', r['output'])
        self.assertEqual((rig.pod.execs, rig.ctx.remote_binding.receipts, rig.ctx.remote_binding.operations), (0, [], 0))

    def test_a_malformed_stream_is_a_bad_argument(self):
        rig = self.rig()
        for bad in (1.5, '1', True, -1, 128, None):
            r = rig.call('audio_sample', {'at': 1, 'stream': bad})
            self.assertEqual(r['status'], 'error', repr(bad))
        self.assertEqual(rig.pod.execs, 0)

    def test_a_file_with_no_audio_stream_runs_nothing(self):
        probe = dict(H2.PROBE2, streams=[s for s in H2.PROBE2['streams'] if s['codec_type'] != 'audio'])
        rig = self.rig(probe=probe)
        r = rig.call('audio_sample', {'at': 1})
        self.assertEqual(r['status'], 'unavailable')
        self.assertIn('lists no audio stream', r['output'])
        self.assertEqual(rig.pod.execs, 0)
        r = rig.call('audio_sample', {'at': 1, 'stream': 1})
        self.assertEqual(r['status'], 'error')
        self.assertIn('lists no audio stream', r['output'])

    def test_an_audio_window_cut_by_the_quota_is_partial_and_says_so(self):
        rig = self.rig(need_bytes=60_000_000)
        r = rig.call('audio_sample', {'at': 10})
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['window_completed'], out['quota_exhausted']), ('partial', False, True))
        self.assertIn('not evidence that the file is corrupt', out['scope_limit'])
        self.assertLess(out['duration_s'], 4)

    def test_no_audio_after_a_quota_cut_is_not_a_defect_of_the_file(self):
        rig = self.rig(need_bytes=60_000_000, out_time=0)
        r = rig.call('audio_sample', {'at': 10})
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['note'], out['quota_exhausted']), ('partial', 'no audio produced', True))
        self.assertNotIn('stderr', out)                                                         # the decoder's read errors are a limit of the read
        self.assertIn('not evidence that the file is corrupt', out['scope_limit'])

    def test_no_audio_without_a_quota_cut_is_an_error_with_the_decoders_text(self):
        rig = self.rig(need_bytes=100, out_time=0)
        r = rig.call('audio_sample', {'at': 10})
        self.assertEqual(r['status'], 'error')
        self.assertIn('stderr', json.loads(r['output']))

    # ---- subtitle_sample
    def test_subtitle_defaults_to_the_first_text_stream_and_records_the_window(self):
        rig = self.rig(need_bytes=100)
        r = rig.call('subtitle_sample', {'at': 30})
        self.assertEqual(r['status'], 'ok')
        out = json.loads(r['output'])
        self.assertEqual((out['stream'], out['window_completed'], out['cue_count']), ({'index': 3, 'codec': 'subrip', 'language': 'eng'}, True, 2))
        q = rig.last_entry()['quota']
        self.assertEqual((q['window_requested_s'], q['window_measure'], q['window_completed']), (8, 'read_not_cut', True))
        self.assertEqual(q['quota_inputs']['selected_streams'], [3])
        self.assertEqual(q['quota_bytes'], 8 * 16_000_000 // 8 * 2 + 6_048_576)

    def test_a_subtitle_stream_must_be_a_text_subtitle_stream_of_the_probe(self):
        rig = self.rig(need_bytes=100)
        for index, what in ((0, 'stream 0 is a video stream (h264)'), (2, 'stream 2 is a subtitle stream (hdmv_pgs_subtitle)'), (1, 'stream 1 is a audio stream (dts)')):
            r = rig.call('subtitle_sample', {'at': 30, 'stream': index})
            self.assertEqual(r['status'], 'error', index)
            self.assertIn(what, r['output'])
            self.assertIn('text subtitle (subrip, ass, ssa, mov_text) stream indexes of this file are [3]', r['output'])
            self.assertIn('Nothing was run', r['output'])
        self.assertEqual(rig.pod.execs, 0)
        ok = rig.call('subtitle_sample', {'at': 30, 'stream': 3})
        self.assertEqual(ok['status'], 'ok')
        entry = rig.last_entry()
        self.assertEqual(entry['argv'][entry['argv'].index('--stream') + 1], '3')

    def test_a_subtitle_read_cut_by_the_quota_is_partial_and_not_blamed_on_the_file(self):
        rig = self.rig(need_bytes=300_000_000)
        r = rig.call('subtitle_sample', {'at': 30})
        out = json.loads(r['output'])
        self.assertEqual((r['status'], out['window_completed'], out['quota_exhausted']), ('partial', False, True))
        self.assertIn('per-file input limit', out['scope_limit'])
        self.assertIn('not evidence that the file is corrupt', out['scope_limit'])

    def test_subtitle_still_takes_only_at_and_stream(self):
        rig = self.rig(need_bytes=100)
        r = rig.call('subtitle_sample', {'at': 30, 'window': 3})
        self.assertEqual(r['status'], 'error')
        self.assertEqual(rig.pod.execs, 0)

    # ---- what the model is told
    def test_the_advertised_tool_descriptions_say_how_the_stream_and_the_read_limit_work(self):
        rig = self.rig()
        caps = {c['tool']: c for c in T.capabilities(rig.ctx)}
        audio = caps['audio_sample']
        self.assertIn('Omitted, the first audio stream (0:a:0) is read', audio['args'])
        self.assertIn('ABSOLUTE stream index', audio['args'])
        self.assertIn('[1, 4]', audio['args'])
        self.assertEqual((audio['available'], audio['input_limit_bytes']), (True, 22_048_576))
        self.assertEqual(caps['decode_sample']['input_limit_bytes'], 22_048_576)
        self.assertIn('not a fixed number', caps['decode_sample']['input_limit'])
        self.assertIn('[3]', caps['subtitle_sample']['args'])
        self.assertEqual(caps['subtitle_sample']['input_limit_bytes'], 8 * 16_000_000 // 8 * 2 + 6_048_576)

    def test_an_unavailable_quota_is_advertised_as_unavailable(self):
        rig = self.rig(probe=dict(H2.PROBE2, format={'format_name': 'matroska,webm'}))
        caps = {c['tool']: c for c in T.capabilities(rig.ctx)}
        for tool in ('decode_sample', 'audio_sample', 'subtitle_sample'):
            self.assertFalse(caps[tool]['available'], tool)
            self.assertIn('quota_basis: unavailable', caps[tool]['why'])

    def test_v3_remote_1_is_unchanged_it_keeps_the_fixed_quota_and_the_old_stream_default(self):
        case = H.remote_case(tools=['ffprobe', 'decode_sample', 'audio_sample', 'subtitle_sample'])
        sampler = H.FakeSampler()
        fx = T.Fixture.from_case(case, '.')
        ctx = T.Context(case, fx, tempfile.mkdtemp(), runner=sampler, which=th.NO_BINARIES, tools_behavior='v3-remote-1',
                        remote_binding=RE.binding_for_case(case, RE.HostState()))
        ctx.subtitle_stream = RE.select_subtitle_stream(case['evidence'])
        T.call_tool(ctx, 'audio_sample', {'at': 5})
        argv = sampler.calls[0]
        self.assertEqual(argv[argv.index('--stream') + 1], '0')
        self.assertNotIn('--audio-first', argv)
        self.assertNotIn('--input-quota-bytes', argv)
        self.assertFalse(any('quota' in e for e in ctx.remote_binding.receipts))


class Runner(unittest.TestCase):
    def test_the_option_check_accepts_v3_remote_2_with_the_same_companions_as_v3_remote_1(self):
        for behaviour in ('v3-remote-1', 'v3-remote-2'):
            R.check_remote_options('v3.1-format', behaviour, False, 'replay')
            with self.assertRaises(ValueError):
                R.check_remote_options('v2', behaviour, False, 'replay')
            with self.assertRaises(ValueError):
                R.check_remote_options('v3.1-format', behaviour, False, 'live')
        R.check_remote_options('v3.1-format', 'v3-remote-2', True, 'replay')            # --stop-on-receipt-failure
        with self.assertRaises(ValueError):
            R.check_remote_options('v3.1-format', 'v3-remote-3', False, 'replay')
        self.assertEqual(T.REMOTE_TOOLS_BEHAVIORS, ('v3-remote-1', 'v3-remote-2'))

    def run_case(self, rig, replies, **kw):
        ad = A.ScriptedAdapter('scripted-model', replies)
        args = dict(H.V31, tools_behavior='v3-remote-2', stop_on_receipt_failure=True)
        args.update(kw)
        rec = R.run_case(rig.case, 'sha', ad, '.', tempfile.mkdtemp(), runner=rig.pod, which=th.NO_BINARIES, run_id='run-x', **args)
        return rec, ad

    def test_a_scripted_run_records_the_v3_remote_2_receipts_and_the_model_sees_the_note(self):
        rig = H2.Rig(self, need_bytes=60_000_000)                                      # the decode wants more than its quota
        rec, ad = self.run_case(rig, [th.tool_call('decode_sample', {'at': 10}), th.tool_call('audio_sample', {'at': 10}), H.dec('healthy', 'none', refs=[])])
        self.assertNotIn('error', rec)
        rem = rec['remote_evidence']
        self.assertEqual((rem['tools_behavior'], rem['sampler'], rem['fatal']), ('v3-remote-2', 'mrh-sampler-4', None))
        self.assertEqual([(c['tool'], c['status']) for c in rec['tool_calls']], [('decode_sample', 'partial'), ('audio_sample', 'partial')])
        self.assertEqual([e['quota']['window_completed'] for e in rem['receipts']], [False, False])
        self.assertEqual([e['quota']['quota_exhausted'] for e in rem['receipts']], [True, True])
        seen = json.dumps(ad.calls[1:])                                                # what the model was sent after its first tool call
        for needle in ('not evidence that the file is corrupt', 'per-file input limit of 22048576 bytes', 'window_completed', 'quota_bytes'):
            self.assertTrue(needle in seen, needle)
        self.assertTrue(len(rig.pod.calls) == 2)

    def test_the_config_hash_tells_v3_remote_2_from_v3_remote_1(self):
        c1, c2 = RE.config(), R2.config()
        self.assertNotEqual(json.dumps(c1, sort_keys=True), json.dumps(c2, sort_keys=True))
        self.assertEqual((c2['version'], c2['sampler'], c2['quota']['margin'], c2['quota']['overhead_bytes']), ('v3-remote-2', 'mrh-sampler-4', '2.0', 6_048_576))
        self.assertEqual(c2['sampler_sha256'], sha(R2.SAMPLER))

    def test_a_remote_2_run_without_a_remote_fixture_still_has_no_binding(self):
        case = th.make_case(id='n1', media='tv', truth='healthy', tools_available=['ffprobe'])
        ad = A.ScriptedAdapter('scripted-model', [H.dec('healthy', 'none')])
        rec = R.run_case(case, 'sha', ad, '.', tempfile.mkdtemp(), which=th.NO_BINARIES, run_id='run-x', **dict(H.V31, tools_behavior='v3-remote-2'))
        self.assertEqual(rec['remote_evidence']['receipts'], [])


if __name__ == '__main__':
    unittest.main()
