"""Unit tests for the evidence collectors.  No ffmpeg, no network: a fake runner stands in for every subprocess, and EPUBs are
built with zipfile.  Run: nice -n 19 python3 -m unittest discover -s <harness dir> -p 'test_*.py'  (this folder is a package)."""
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import evidence  # noqa: E402
from evidence import avtools, core  # noqa: E402
from evidence.core import RunResult  # noqa: E402

FFMPEG, FFPROBE, TESS = '/usr/bin/ffmpeg', '/usr/bin/ffprobe', '/usr/bin/tesseract'


def which_with(*names):
    return lambda n: '/usr/bin/' + n if n in names else None


class Fake:
    """Scripted runner.  rules = [(predicate(argv), RunResult | callable(argv) -> RunResult)], first match wins."""

    def __init__(self, rules, clock=None, step=0.0):
        self.rules, self.calls, self.clock, self.step = rules, [], clock, step

    def __call__(self, argv, *, timeout_s, max_stdout, max_stderr, cwd=None):
        self.calls.append((list(argv), timeout_s))
        if self.clock is not None:
            self.clock.t += self.step
        for match, result in self.rules:
            if match(argv):
                return result(argv) if callable(result) else result
        raise AssertionError('unscripted call: %r' % (argv,))


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def prog(name, *words):
    return lambda argv: os.path.basename(argv[0]) == name and all(w in argv for w in words)


VERSION = [(lambda a: len(a) == 2 and a[1] in ('-version', '--version') and 'ffmpeg' in a[0], RunResult(0, b'ffmpeg version 8.1.2 Copyright\nmore', b'')),
           (lambda a: len(a) == 2 and a[1] in ('-version', '--version') and 'ffprobe' in a[0], RunResult(0, b'ffprobe version 8.1.2 Copyright\nmore', b'')),
           (lambda a: len(a) == 2 and a[1] == '--version' and 'tesseract' in a[0], RunResult(0, b'', b'tesseract 5.3.0\n leptonica'))]


def probe_json(duration=20.0, video=True, audio=True, chapters=(), tags=None, lang='eng'):
    streams = []
    if video:
        streams.append({'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'width': 256, 'height': 192, 'pix_fmt': 'yuv420p'})
    if audio:
        s = {'index': 1 if video else 0, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 1, 'sample_rate': '22050', 'duration': str(duration)}
        if lang:
            s['tags'] = {'language': lang, 'title': 'Main'}
        streams.append(s)
    return json.dumps({'streams': streams, 'format': {'format_name': 'matroska,webm', 'duration': str(duration), 'size': '1000', 'bit_rate': '1', 'tags': tags or {'title': 'T'}},
                       'chapters': [{'start_time': str(a), 'end_time': str(b), 'tags': {'title': t}} for a, b, t in chapters]}).encode()


def progress(seconds=4.0, frames=40):
    return ('frame=%d\nout_time_us=%d\nprogress=end\n' % (frames, int(seconds * 1e6))).encode()


def clean_decode(argv):
    t = float(argv[argv.index('-t') + 1]) if '-t' in argv else 20.0
    return RunResult(0, progress(t), b'')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.media = self.dir / 'sample-input.mkv'
        self.media.write_bytes(b'not really media' * 100)

    def tearDown(self):
        self.tmp.cleanup()

    def run_kind(self, kind, rules, which=('ffmpeg', 'ffprobe'), bounds=None, path=None, **kw):
        fake = Fake(rules + VERSION, kw.pop('clock_obj', None), kw.pop('step', 0.0))
        recs = evidence.collect(path or self.media, [kind], bounds, runner=fake, which=which_with(*which), **kw)
        self.assertEqual(len(recs), 1)
        return recs[0], fake

    def shape(self, rec):
        for key in ('tool', 'harness_tool', 'tool_version', 'mode', 'status', 'coverage', 'bounds', 'stderr', 'elapsed_s', 'output', 'input'):
            self.assertIn(key, rec)
        self.assertIn(rec['status'], evidence.STATUSES)
        self.assertEqual(set(rec['coverage']), {'verified', 'not_verified'})
        self.assertIn(rec['mode'], ('live', 'replay'))
        return rec


class ProbeTests(Base):
    def test_ok(self):
        rec, fake = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(chapters=[(0, 10, 'A'), (10, 20, 'B')]), b''))])
        self.shape(rec)
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['mode'], 'live')
        self.assertEqual(rec['tool_version'], 'ffprobe version 8.1.2 Copyright')
        self.assertEqual(rec['output']['duration_s'], 20.0)
        self.assertEqual(rec['output']['chapter_count'], 2)
        self.assertEqual(rec['output']['streams'][1]['language'], 'eng')
        self.assertTrue(rec['coverage']['not_verified'])  # states what was not verified
        self.assertEqual(rec['input']['name'], 'sample-input.mkv')
        self.assertEqual(rec['bounds']['timeout_s'], 20)

    def test_no_shell_and_read_only_argv(self):
        rec, fake = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))])
        argv = [c[0] for c in fake.calls if '-show_format' in c[0]][0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[-1], str(self.media))
        self.assertNotIn('-y', argv)

    def test_corrupt_input_is_error_with_input_cause(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(1, b'', ('%s: Invalid data found when processing input\n' % self.media).encode()))])
        self.assertEqual(rec['status'], 'error')
        self.assertEqual(rec['cause'], 'input')
        self.assertEqual(rec['output']['exit_code'], 1)
        self.assertIn('Invalid data', rec['stderr'])
        self.assertNotIn(str(self.media), rec['stderr'])  # path scrubbed
        self.assertIn('<input>', rec['stderr'])

    def test_timeout(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(None, b'', b'', timed_out=True))])
        self.assertEqual(rec['status'], 'timeout')
        self.assertIn('exceeded', rec['reason'])

    def test_missing_binary_is_unavailable(self):
        rec, fake = self.run_kind('probe', [], which=())
        self.assertEqual(rec['status'], 'unavailable')
        self.assertIn('ffprobe not found', rec['reason'])
        self.assertEqual(fake.calls, [])
        self.assertEqual(rec['coverage']['verified'], [])

    def test_spawn_failure_is_tool_error(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(error='PermissionError: nope'))])
        self.assertEqual((rec['status'], rec['cause']), ('error', 'tool'))

    def test_partial_output_cap_hit(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, b'{"streams": [', b'', stdout_truncated=True))])
        self.assertEqual((rec['status'], rec['cause']), ('error', 'tool'))
        self.assertIn('cap', rec['reason'])

    def test_garbage_json(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, b'hello', b''))])
        self.assertEqual((rec['status'], rec['cause']), ('error', 'tool'))

    def test_empty_container_is_finding_not_health(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, b'{"streams": [], "format": {}}', b''))])
        self.assertEqual(rec['status'], 'ok')
        self.assertIn('the container lists no streams', rec['output']['findings'])


class DecodeTests(Base):
    probe = (prog('ffprobe', '-show_format'), RunResult(0, probe_json(20.0), b''))

    def test_ok_samples_head_tail_and_spread(self):
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), clean_decode)])
        self.shape(rec)
        self.assertEqual(rec['status'], 'ok')
        segs = rec['output']['segments']
        ats = [s['at_s'] for s in segs]
        self.assertEqual(ats, [0.0, 5.0, 10.0, 16.0])  # head, interior (15 would overlap the tail and is dropped), tail = duration - segment_s
        self.assertTrue(rec['output']['clean'])
        self.assertEqual(rec['output']['segments_clean'], 4)
        self.assertTrue(any('does not prove whole-file health' in n for n in rec['coverage']['not_verified']))
        self.assertIsNone(rec['output']['full'])
        for argv, _t in fake.calls:
            if os.path.basename(argv[0]) == 'ffmpeg' and '-progress' in argv:
                self.assertEqual(argv[argv.index('-f') + 1:], ['null', '-'])  # nothing is written

    def test_decoder_errors_counted(self):
        def bad(argv):
            at = float(argv[argv.index('-ss') + 1])
            if at == 10.0:
                return RunResult(0, progress(4.0), b'[h264 @ 0x1] error while decoding MB 3 4\n[h264 @ 0x1] concealing 50 DC errors\n')
            return clean_decode(argv)
        rec, _ = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), bad)])
        self.assertEqual(rec['status'], 'ok')  # the collector finished; the finding is in the output
        self.assertFalse(rec['output']['clean'])
        self.assertEqual(rec['output']['segments_with_errors'], 1)
        self.assertEqual(rec['output']['decoder_error_lines'], 2)
        self.assertIn('error while decoding', rec['stderr'])
        self.assertTrue(rec['output']['findings'])

    def test_truncated_file_short_segments(self):
        def short(argv):
            at = float(argv[argv.index('-ss') + 1])
            return clean_decode(argv) if at < 8 else RunResult(0, progress(0.0, 0), b'')
        rec, _ = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), short)])
        self.assertGreaterEqual(rec['output']['segments_short'], 2)
        self.assertFalse(rec['output']['clean'])
        self.assertTrue(any('far less' in f for f in rec['output']['findings']))

    def test_one_segment_timeout_is_partial(self):
        def some(argv):
            return RunResult(None, b'', b'', timed_out=True) if float(argv[argv.index('-ss') + 1]) == 5.0 else clean_decode(argv)
        rec, _ = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), some)])
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(rec['output']['segments_timeout'], 1)
        self.assertIn('timed out', rec['reason'])

    def test_all_timeout(self):
        rec, _ = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), RunResult(None, b'', b'', timed_out=True))])
        self.assertEqual(rec['status'], 'timeout')

    def test_unreadable_container_is_partial_head_only(self):
        rec, _ = self.run_kind('decode', [(prog('ffprobe', '-show_format'), RunResult(1, b'', b'Invalid data\n')),
                                          (prog('ffmpeg', '-progress'), RunResult(1, b'', b'Invalid data found when processing input\n'))])
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(len(rec['output']['segments']), 1)
        self.assertEqual(rec['output']['segments'][0]['state'], 'errors')
        self.assertIn('duration unknown', rec['reason'])

    def test_missing_ffmpeg(self):
        rec, _ = self.run_kind('decode', [], which=('ffprobe',))
        self.assertEqual(rec['status'], 'unavailable')
        self.assertIn('ffmpeg not found', rec['reason'])

    def test_missing_ffprobe_still_samples_head_and_says_so(self):
        rec, _ = self.run_kind('decode', [(prog('ffmpeg', '-progress'), clean_decode)], which=('ffmpeg',))
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(len(rec['output']['segments']), 1)

    def test_deadline_skips_remaining_segments(self):
        clock = Clock()
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), clean_decode)], bounds={'deadline_s': 100},
                                  clock_obj=clock, step=40.0, clock=clock)
        self.assertEqual(rec['status'], 'partial')
        self.assertGreater(rec['output']['segments_skipped_deadline'], 0)
        self.assertIn('deadline', rec['reason'])

    def test_timeout_never_exceeds_deadline_left(self):
        clock = Clock()
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), clean_decode)], bounds={'deadline_s': 30, 'timeout_s': 20},
                                  clock_obj=clock, step=10.0, clock=clock)
        self.assertTrue(all(t <= 20 for _a, t in fake.calls))
        self.assertTrue(any(t < 20 for _a, t in fake.calls))

    def test_full_decode_refused_over_byte_cap(self):
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), clean_decode)], bounds={'full_decode': True, 'full_max_bytes': 1024})
        self.assertEqual(rec['status'], 'partial')
        self.assertFalse(rec['output']['full']['performed'])
        self.assertIn('full_max_bytes', rec['output']['full']['refused'])
        self.assertFalse(any('-ss' not in a and '-progress' in a for a, _t in fake.calls))  # no whole-file decode was run

    def test_full_decode_under_cap(self):
        def fullrun(argv):
            return RunResult(0, progress(20.0, 200), b'') if '-ss' not in argv else clean_decode(argv)
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), fullrun)], bounds={'full_decode': True, 'full_max_bytes': 10 ** 6})
        self.assertEqual(rec['status'], 'ok')
        self.assertTrue(rec['output']['full']['performed'])
        self.assertEqual(rec['output']['full']['state'], 'clean')
        full_calls = [(a, t) for a, t in fake.calls if '-progress' in a and '-ss' not in a]
        self.assertEqual(len(full_calls), 1)
        self.assertEqual(full_calls[0][1], 60)  # full_timeout_s

    def test_full_decode_timeout_is_partial(self):
        def fullrun(argv):
            return RunResult(None, progress(7.0, 70), b'', timed_out=True) if '-ss' not in argv else clean_decode(argv)
        rec, _ = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), fullrun)], bounds={'full_decode': True, 'full_max_bytes': 10 ** 6})
        self.assertEqual(rec['status'], 'partial')
        self.assertIn('full decode hit', rec['reason'])

    def test_bounds_clamped_and_unknown_rejected(self):
        rec, fake = self.run_kind('decode', [self.probe, (prog('ffmpeg', '-progress'), clean_decode)], bounds={'segments': 500, 'timeout_s': 9999})
        self.assertEqual(rec['bounds']['segments'], 8)
        self.assertEqual(rec['bounds']['timeout_s'], 60)
        self.assertEqual({c['bound'] for c in rec['bounds_clamped']}, {'segments', 'timeout_s'})
        self.assertLessEqual(len(rec['output']['segments']), 10)
        with self.assertRaises(ValueError):
            evidence.collect(self.media, ['decode'], {'segmnts': 3}, runner=Fake([]), which=which_with())
        with self.assertRaises(ValueError):
            evidence.collect(self.media, ['bogus'])

    def test_segment_offsets(self):
        self.assertEqual(avtools.segment_offsets(None, 3, 4, 10), [0.0])
        self.assertEqual(avtools.segment_offsets(3.0, 3, 4, 10), [0.0])
        offs = avtools.segment_offsets(100.0, 3, 4, 10)
        self.assertEqual(offs, [0.0, 25.0, 50.0, 75.0, 96.0])
        self.assertLessEqual(len(avtools.segment_offsets(1000.0, 8, 4, 4)), 4)


class FrameTests(Base):
    probe = (prog('ffprobe', '-show_format'), RunResult(0, probe_json(10.0), b''))
    PNG = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR' + (640).to_bytes(4, 'big') + (480).to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00' + b'x'

    def writer(self, variants=False):
        def run(argv):
            out = argv[-1]
            data = self.PNG + (os.path.basename(out).encode() if variants else b'')
            Path(out).write_bytes(data)
            return RunResult(0, b'', b'')
        return run

    def test_ok_without_tesseract_says_text_not_read(self):
        rec, _ = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), self.writer(True))])
        self.shape(rec)
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['output']['frames_ok'], 3)
        self.assertEqual(rec['output']['frames'][0]['width'], 640)
        self.assertEqual(rec['output']['ocr'], 'unavailable')
        self.assertEqual(rec['output']['frames'][0]['ocr']['state'], 'unavailable')
        self.assertTrue(any('tesseract not found' in n for n in rec['coverage']['not_verified']))
        self.assertEqual([f['at_s'] for f in rec['output']['frames']], [0.5, 5.0, 9.5])

    def test_ocr_when_tesseract_present(self):
        rec, fake = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), self.writer(True)),
                                             (prog('tesseract', 'stdout'), RunResult(0, b'HARBOR  LIGHTS\n\nS01E02\n', b''))], which=('ffmpeg', 'ffprobe', 'tesseract'))
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['output']['frames'][0]['ocr'], {'state': 'ok', 'text': 'HARBOR LIGHTS S01E02', 'truncated': False})
        self.assertIn('tesseract 5.3.0', rec['tool_version'])
        self.assertTrue(any('not ground truth' in n for n in rec['coverage']['not_verified']))

    def test_ocr_off(self):
        rec, fake = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), self.writer(True))], which=('ffmpeg', 'ffprobe', 'tesseract'), bounds={'ocr': 'off'})
        self.assertEqual(rec['output']['ocr'], 'off')
        self.assertFalse(any(os.path.basename(a[0]) == 'tesseract' for a, _t in fake.calls))

    def test_ocr_timeout_is_partial(self):
        rec, _ = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), self.writer(True)), (prog('tesseract', 'stdout'), RunResult(None, b'', b'', timed_out=True))],
                               which=('ffmpeg', 'ffprobe', 'tesseract'))
        self.assertEqual(rec['status'], 'partial')

    def test_identical_frames_flagged(self):
        rec, _ = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), self.writer(False))])
        self.assertEqual(rec['output']['distinct_frames'], 1)
        self.assertTrue(any('byte-identical' in f for f in rec['output']['findings']))

    def test_no_frame_produced_is_partial(self):
        rec, _ = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), RunResult(1, b'', b'Output file is empty, nothing was encoded\n'))])
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(rec['output']['frames_ok'], 0)
        self.assertIn('Output file is empty', rec['stderr'])

    def test_all_timeout(self):
        rec, _ = self.run_kind('frames', [self.probe, (prog('ffmpeg', '-frames:v'), RunResult(None, b'', b'', timed_out=True))])
        self.assertEqual(rec['status'], 'timeout')

    def test_audio_only_file_has_no_frames_by_construction(self):
        rec, fake = self.run_kind('frames', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(video=False), b''))])
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['output']['frames'], [])
        self.assertIn('no video stream', rec['output']['findings'][0])

    def test_missing_ffmpeg(self):
        rec, _ = self.run_kind('frames', [], which=())
        self.assertEqual(rec['status'], 'unavailable')


LEVELS = (b'[info] [Parsed_silencedetect_1 @ 0x1] silence_start: 1.5\n[info] [Parsed_silencedetect_1 @ 0x1] silence_end: 3.5 | silence_duration: 2\n'
          b'[info] [Parsed_volumedetect_0 @ 0x2] mean_volume: -23.4 dB\n[info] [Parsed_volumedetect_0 @ 0x2] max_volume: -3.1 dB\n')


class AudioTests(Base):
    probe = (prog('ffprobe', '-show_format'), RunResult(0, probe_json(20.0, lang='eng'), b''))

    def test_ok_levels_silence_and_language(self):
        rec, _ = self.run_kind('audio', [self.probe, (prog('ffmpeg', '-af'), RunResult(0, b'', LEVELS))])
        self.shape(rec)
        self.assertEqual(rec['status'], 'ok')
        st = rec['output']['streams'][0]
        self.assertEqual(st['language'], 'eng')
        seg = st['segments'][0]
        self.assertEqual((seg['mean_db'], seg['max_db'], seg['silent_s']), (-23.4, -3.1, 2.0))
        self.assertEqual(seg['silent_fraction'], 0.5)
        self.assertEqual(seg['state'], 'ok')
        self.assertTrue(any('speech' in n for n in rec['coverage']['not_verified']))

    def test_near_silent_and_missing_language_flagged(self):
        silent = b'[info] [Parsed_volumedetect_0 @ 0x2] mean_volume: -91.0 dB\n[info] [Parsed_volumedetect_0 @ 0x2] max_volume: -80.0 dB\n[info] silence_start: 0\n'
        rec, _ = self.run_kind('audio', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(20.0, lang=None), b'')), (prog('ffmpeg', '-af'), RunResult(0, b'', silent))])
        self.assertEqual(rec['output']['streams'][0]['segments'][0]['state'], 'near_silent')
        self.assertTrue(any('no language tag' in f for f in rec['output']['findings']))
        self.assertTrue(any('not normal' in f for f in rec['output']['findings']))

    def test_errors_in_stream(self):
        bad = LEVELS + b'[error] [mp3float @ 0x3] Header missing\n'
        rec, _ = self.run_kind('audio', [self.probe, (prog('ffmpeg', '-af'), RunResult(0, b'', bad))])
        self.assertEqual(rec['output']['streams'][0]['segments'][0]['state'], 'errors')
        self.assertIn('Header missing', rec['stderr'])

    def test_no_samples(self):
        rec, _ = self.run_kind('audio', [self.probe, (prog('ffmpeg', '-af'), RunResult(0, b'', b'[info] nothing\n'))])
        self.assertEqual(rec['output']['streams'][0]['segments'][0]['state'], 'no_audio')

    def test_timeout_and_partial(self):
        rec, _ = self.run_kind('audio', [self.probe, (prog('ffmpeg', '-af'), RunResult(None, b'', b'', timed_out=True))])
        self.assertEqual(rec['status'], 'timeout')

        def some(argv):
            return RunResult(None, b'', b'', timed_out=True) if float(argv[argv.index('-ss') + 1]) == 0.0 else RunResult(0, b'', LEVELS)
        rec, _ = self.run_kind('audio', [self.probe, (prog('ffmpeg', '-af'), some)])
        self.assertEqual(rec['status'], 'partial')

    def test_no_audio_stream(self):
        rec, _ = self.run_kind('audio', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(audio=False), b''))])
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['output']['streams'], [])

    def test_unreadable_container_blind_sample_partial(self):
        rec, _ = self.run_kind('audio', [(prog('ffprobe', '-show_format'), RunResult(1, b'', b'Invalid data\n')), (prog('ffmpeg', '-af'), RunResult(0, b'', LEVELS))])
        self.assertEqual(rec['status'], 'partial')
        self.assertIn('blindly', rec['reason'])

    def test_missing_ffmpeg(self):
        rec, _ = self.run_kind('audio', [], which=('ffprobe',))
        self.assertEqual(rec['status'], 'unavailable')

    def test_parse_levels_unterminated_silence_runs_to_window_end(self):
        lv, problems = avtools.parse_levels('[info] silence_start: 1\n[info] mean_volume: -inf dB\n', 4.0)
        self.assertEqual(lv['silent_s'], 3.0)
        self.assertEqual(lv['mean_db'], float('-inf'))
        self.assertEqual(problems, [])


def book_probe(album='The Book', artist='A. Author', track='1/2', dur=10.0, chapters=((0, 5, 'One'), (5, 10, 'Two')), title='Part'):
    return probe_json(dur, video=False, tags={'album': album, 'artist': artist, 'track': track, 'title': title}, chapters=chapters)


class AudiobookTests(Base):
    def make_parts(self, n=2):
        d = self.dir / 'book'
        d.mkdir()
        names = ['part %d.m4b' % i for i in range(1, n + 1)] + ['cover.jpg']
        for nm in names:
            (d / nm).write_bytes(nm.encode() * 10)
        return d

    def rules(self, per_file):
        def probe(argv):
            name = os.path.basename(argv[-1])
            return per_file[name]
        return [(prog('ffprobe', '-show_format'), probe), (prog('ffmpeg', '-progress'), clean_decode)]

    def test_ok_two_parts(self):
        d = self.make_parts()
        per = {'part 1.m4b': RunResult(0, book_probe(track='1/2'), b''), 'part 2.m4b': RunResult(0, book_probe(track='2/2'), b'')}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=d)
        self.shape(rec)
        self.assertEqual(rec['status'], 'ok')
        o = rec['output']
        self.assertEqual((o['parts'], o['parts_probed'], o['ignored_non_audio_files'], o['total_duration_s']), (2, 2, 1, 20.0))
        self.assertTrue(o['tag_consistency']['consistent'])
        self.assertEqual(o['files'][0]['chapter_count'], 2)
        self.assertTrue(o['files'][0]['decode']['clean'])
        self.assertEqual(o['findings'], [])
        self.assertEqual(rec['input']['kind'], 'files')

    def test_natural_order(self):
        d = self.dir / 'b2'
        d.mkdir()
        for n in (10, 2, 1):
            (d / ('p%d.mp3' % n)).write_bytes(b'x' * n)
        parts, _i, _o = avtools.audiobook_parts([d], 50)
        self.assertEqual([p.name for p in parts], ['p1.mp3', 'p2.mp3', 'p10.mp3'])

    def test_tag_inconsistency_and_chapter_problems(self):
        d = self.make_parts()
        per = {'part 1.m4b': RunResult(0, book_probe(album='The Book', track='1/2'), b''),
               'part 2.m4b': RunResult(0, book_probe(album='Other Book', track='2/3', chapters=((0, 4, 'One'), (6, 9, 'One'))), b'')}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=d)
        tc = rec['output']['tag_consistency']
        self.assertFalse(tc['consistent'])
        self.assertIn('album', tc['inconsistent'])
        self.assertIn('disagree on the track total', tc['track_issue'])
        f = ' | '.join(rec['output']['findings'])
        self.assertIn('gap of 2.0s', f)
        self.assertIn('duplicate chapter titles', f)
        self.assertIn('tags differ', f)

    def test_one_broken_part_is_a_finding_and_decode_error_listed(self):
        d = self.make_parts()
        per = {'part 1.m4b': RunResult(0, book_probe(track='1/2'), b''), 'part 2.m4b': RunResult(1, b'', b'moov atom not found\n')}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=d)
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['output']['parts_probed'], 1)
        self.assertTrue(any('part 2.m4b: ffprobe error' in f for f in rec['output']['findings']))
        self.assertNotIn('tag_consistency', rec['output'])
        self.assertIn('moov atom not found', rec['stderr'])
        self.assertTrue(any('only one part' in n for n in rec['coverage']['not_verified']))

    def test_all_parts_unreadable_is_input_error(self):
        d = self.make_parts()
        per = {'part 1.m4b': RunResult(1, b'', b'moov atom not found\n'), 'part 2.m4b': RunResult(1, b'', b'moov atom not found\n')}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=d)
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))
        self.assertIn('moov atom', rec['stderr'])

    def test_decode_timeout_is_partial(self):
        d = self.make_parts(1)
        per = {'part 1.m4b': RunResult(0, book_probe(), b'')}
        rules = [(prog('ffprobe', '-show_format'), lambda a: per[os.path.basename(a[-1])]), (prog('ffmpeg', '-progress'), RunResult(None, b'', b'', timed_out=True))]
        rec, _ = self.run_kind('audiobook', rules, path=d)
        self.assertEqual(rec['status'], 'partial')
        self.assertFalse(rec['output']['files'][0]['decode']['clean'])

    def test_decode_errors_in_part(self):
        d = self.make_parts(1)
        per = {'part 1.m4b': RunResult(0, book_probe(), b'')}
        rules = [(prog('ffprobe', '-show_format'), lambda a: per[os.path.basename(a[-1])]),
                 (prog('ffmpeg', '-progress'), RunResult(0, progress(3.0), b'[aac @ 0x1] Number of bands exceeds limit\n'))]
        rec, _ = self.run_kind('audiobook', rules, path=d)
        self.assertEqual(rec['status'], 'ok')
        self.assertTrue(any('sampled decode not clean' in f for f in rec['output']['findings']))
        self.assertIn('Number of bands', rec['stderr'])

    def test_missing_ffprobe_unavailable_and_missing_ffmpeg_partial(self):
        d = self.make_parts(1)
        rec, _ = self.run_kind('audiobook', [], path=d, which=())
        self.assertEqual(rec['status'], 'unavailable')
        per = {'part 1.m4b': RunResult(0, book_probe(), b'')}
        rec, _ = self.run_kind('audiobook', [(prog('ffprobe', '-show_format'), lambda a: per[os.path.basename(a[-1])])], path=d, which=('ffprobe',))
        self.assertEqual(rec['status'], 'partial')
        self.assertIn('not decoded', rec['reason'])

    def test_max_files_cap_is_partial(self):
        d = self.make_parts(3)
        per = {'part %d.m4b' % i: RunResult(0, book_probe(track='%d/3' % i), b'') for i in (1, 2, 3)}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=d, bounds={'max_files': 2})
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(rec['output']['parts'], 2)
        self.assertIn('not examined', rec['reason'])

    def test_empty_folder_and_missing_path(self):
        d = self.dir / 'empty'
        d.mkdir()
        rec, _ = self.run_kind('audiobook', [], path=d)
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))
        rec, _ = self.run_kind('audiobook', [], path=self.dir / 'nope')
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))

    def test_explicit_file_list(self):
        d = self.make_parts()
        per = {'part 1.m4b': RunResult(0, book_probe(track='1/2'), b''), 'part 2.m4b': RunResult(0, book_probe(track='2/2'), b'')}
        rec, _ = self.run_kind('audiobook', self.rules(per), path=[d / 'part 1.m4b', d / 'part 2.m4b'])
        self.assertEqual(rec['output']['parts'], 2)

    def test_chapter_and_tag_helpers(self):
        ch = [{'start_s': 2.0, 'end_s': 5.0, 'title': 'A'}, {'start_s': 4.0, 'end_s': 12.0, 'title': None}]
        f = avtools.chapter_findings(ch, 10.0)
        self.assertTrue(any('not at the beginning' in x for x in f))
        self.assertTrue(any('overlap' in x for x in f))
        self.assertTrue(any('after the' in x for x in f))
        self.assertTrue(any('no title' in x for x in f))
        self.assertEqual(avtools.chapter_findings([], 10.0), [])
        tc = avtools.tag_consistency([('a', {'album': 'X', 'track': '1'}), ('b', {'track': '3'})])
        self.assertEqual(tc['missing_in'], {'album': ['b']})
        self.assertIn('not 1..2', tc['track_issue'])
        tc = avtools.tag_consistency([('a', {'track': '1/3'})], 3)
        self.assertIsNone(tc['track_issue'])
        self.assertIn('not checked', tc['track_note'])


# ------------------------------------------------------------------ EPUB (real zips, no runner)

CONTAINER = ('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
             '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
OPF = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
       '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Lantern Road</dc:title><dc:creator>Mira Tolland</dc:creator>'
       '<dc:language>en</dc:language><dc:identifier id="id">urn:uuid:1234</dc:identifier></metadata>'
       '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>'
       '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>%s</p></body></html>'


def make_epub(path, *, mimetype=True, mimetype_first=True, mimetype_content=b'application/epub+zip', container=CONTAINER, opf=OPF,
              chapters=None, extra=None, compress_mimetype=False):
    chapters = {'OEBPS/ch1.xhtml': XHTML % 'It was raining on the lantern road.', 'OEBPS/ch2.xhtml': XHTML % 'Salt and cedar.'} if chapters is None else chapters
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        def put_mime():
            z.writestr(zipfile.ZipInfo('mimetype'), mimetype_content, compress_type=zipfile.ZIP_DEFLATED if compress_mimetype else zipfile.ZIP_STORED)
        if mimetype and mimetype_first:
            put_mime()
        if container is not None:
            z.writestr('META-INF/container.xml', container)
        if opf is not None:
            z.writestr('OEBPS/content.opf', opf)
        for name, body in chapters.items():
            z.writestr(name, body)
        for name, body in (extra or {}).items():
            z.writestr(name, body)
        if mimetype and not mimetype_first:
            put_mime()


class EpubTests(Base):
    def epub(self, name='b.epub', **kw):
        p = self.dir / name
        make_epub(p, **kw)
        return p

    def collect(self, path, bounds=None):
        recs = evidence.collect(path, ['epub'], bounds, runner=Fake([]), which=which_with())
        return self.shape(recs[0])

    def test_good(self):
        rec = self.collect(self.epub())
        self.assertEqual(rec['status'], 'ok')
        o = rec['output']
        self.assertTrue(o['valid'])
        self.assertEqual((o['dc_title'], o['dc_creator'], o['dc_language']), (['The Lantern Road'], ['Mira Tolland'], ['en']))
        self.assertEqual(o['dc_identifier'], ['urn:uuid:1234'])
        self.assertEqual((o['spine_items'], o['xhtml']['parsed_ok'], o['xhtml']['parse_failed_count']), (2, 2, 0))
        self.assertEqual(o['stages_passed'], ['zip_open', 'zip_crc', 'opf_parse', 'manifest', 'spine'])
        self.assertEqual(o['findings'], [])
        self.assertTrue(o['mimetype']['first_entry'] and o['mimetype']['stored_uncompressed'])
        self.assertTrue(rec['coverage']['not_verified'])
        self.assertEqual(rec['mode'], 'live')
        self.assertIn('python', rec['tool_version'])

    def test_not_a_zip(self):
        p = self.dir / 'junk.epub'
        p.write_bytes(b'this is not a zip file at all')
        rec = self.collect(p)
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))
        self.assertEqual(rec['output']['stage'], 'zip_open')
        self.assertFalse(rec['output']['valid'])

    def test_truncated_zip(self):
        p = self.epub()
        data = p.read_bytes()
        t = self.dir / 'trunc.epub'
        t.write_bytes(data[:len(data) // 2])
        rec = self.collect(t)
        self.assertEqual((rec['status'], rec['output']['stage']), ('error', 'zip_open'))

    def test_crc_corruption(self):
        p = self.epub(chapters={'OEBPS/ch1.xhtml': XHTML % ('A' * 200), 'OEBPS/ch2.xhtml': XHTML % 'B'})
        with zipfile.ZipFile(p) as z:
            info = z.getinfo('OEBPS/ch1.xhtml')
        data = bytearray(p.read_bytes())
        # flip a byte inside ch1's compressed data (past its 30 byte local header + name)
        off = info.header_offset + 30 + len(info.filename) + 5
        data[off] ^= 0xFF
        c = self.dir / 'crc.epub'
        c.write_bytes(bytes(data))
        rec = self.collect(c)
        self.assertEqual((rec['status'], rec['cause'], rec['output']['stage']), ('error', 'input', 'zip_crc'))

    def test_bad_container_and_missing_opf(self):
        rec = self.collect(self.epub('c1.epub', container='<container><oops'))
        self.assertEqual(rec['output']['stage'], 'opf_parse')
        rec = self.collect(self.epub('c2.epub', container=CONTAINER.replace('content.opf', 'gone.opf')))
        self.assertEqual(rec['output']['stage'], 'opf_parse')
        self.assertIn('not in the archive', rec['reason'])
        rec = self.collect(self.epub('c3.epub', opf='<package><metadata'))
        self.assertEqual(rec['output']['stage'], 'opf_parse')

    def test_manifest_member_missing(self):
        rec = self.collect(self.epub('m.epub', chapters={'OEBPS/ch1.xhtml': XHTML % 'x'}))
        self.assertEqual((rec['status'], rec['output']['stage']), ('error', 'manifest'))
        self.assertEqual(rec['output']['manifest_missing'], ['OEBPS/ch2.xhtml'])

    def test_malformed_xhtml_is_valid_false_not_error(self):
        rec = self.collect(self.epub('x.epub', chapters={'OEBPS/ch1.xhtml': '<html><body><p>unclosed', 'OEBPS/ch2.xhtml': XHTML % 'ok'}))
        self.assertEqual(rec['status'], 'ok')
        self.assertFalse(rec['output']['valid'])
        self.assertEqual(rec['output']['xhtml']['parse_failed_count'], 1)
        self.assertEqual(rec['output']['xhtml']['parse_failed'][0]['member'], 'OEBPS/ch1.xhtml')

    def test_mimetype_problems(self):
        rec = self.collect(self.epub('n.epub', mimetype=False))
        self.assertFalse(rec['output']['valid'])
        self.assertTrue(any('no mimetype' in f['what'] for f in rec['output']['findings']))
        rec = self.collect(self.epub('w.epub', mimetype_content=b'text/plain'))
        self.assertFalse(rec['output']['valid'])
        rec = self.collect(self.epub('o.epub', mimetype_first=False, compress_mimetype=True))
        self.assertTrue(rec['output']['valid'])  # warnings only
        self.assertEqual({f['severity'] for f in rec['output']['findings']}, {'warning'})
        self.assertEqual(len(rec['output']['findings']), 2)

    def test_empty_spine_text_and_missing_idref(self):
        opf = OPF.replace('<itemref idref="c2"/>', '<itemref idref="zz"/>')
        rec = self.collect(self.epub('s.epub', opf=opf))
        self.assertFalse(rec['output']['valid'])
        self.assertTrue(any('not in the manifest' in f['what'] for f in rec['output']['findings']))

    def test_caps_make_it_partial(self):
        rec = self.collect(self.epub('p.epub'), {'epub_max_xhtml_docs': 1})
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(rec['output']['xhtml']['skipped_over_doc_cap'], 1)
        self.assertTrue(any('beyond the epub_max_xhtml_docs' in n for n in rec['coverage']['not_verified']))
        rec = self.collect(self.epub('q.epub'), {'epub_max_member_bytes': 1024, 'epub_max_uncompressed_bytes': 1024})
        self.assertEqual(rec['status'], 'partial')
        self.assertTrue(any('CRC check stopped' in n for n in rec['coverage']['not_verified']))

    def test_entity_declaration_not_expanded(self):
        bomb = '<?xml version="1.0"?><!DOCTYPE h [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&b;</p></body></html>'
        rec = self.collect(self.epub('e.epub', chapters={'OEBPS/ch1.xhtml': bomb, 'OEBPS/ch2.xhtml': XHTML % 'ok'}))
        self.assertEqual(rec['status'], 'partial')
        self.assertEqual(rec['output']['xhtml']['skipped_entity_declarations'], 1)

    def test_zip_member_count_cap(self):
        rec = self.collect(self.epub('z.epub'), {'epub_max_members': 3})
        self.assertEqual((rec['status'], rec['output']['stage']), ('error', 'zip_open'))

    def test_missing_file_and_directory(self):
        rec = self.collect(self.dir / 'absent.epub')
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))
        rec = self.collect(self.dir)
        self.assertEqual((rec['status'], rec['cause']), ('error', 'input'))

    def test_input_is_not_modified(self):
        p = self.epub()
        before = (p.read_bytes(), p.stat().st_mtime_ns)
        self.collect(p)
        self.assertEqual((p.read_bytes(), p.stat().st_mtime_ns), before)


# ------------------------------------------------------------------ records, replay, runner

class RecordTests(Base):
    def test_to_tool_result_maps_unavailable_to_error_and_keeps_status(self):
        rec, _ = self.run_kind('probe', [], which=())
        tr = core.to_tool_result(rec)
        self.assertEqual(tr['status'], 'error')
        self.assertEqual(tr['evidence_status'], 'unavailable')
        self.assertEqual(tr['mode'], 'live')
        self.assertFalse(tr['truncated'])
        self.assertIn('ffprobe not found', json.loads(tr['output'])['reason'])
        for k in ('wall_s', 'tool'):
            self.assertIn(k, tr)

    def test_to_tool_result_truncates(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(chapters=[(i, i + 1, 'Chapter %d' % i) for i in range(150)]), b''))])
        tr = core.to_tool_result(rec, cap=2000)
        self.assertTrue(tr['truncated'])
        self.assertLessEqual(len(tr['output'].encode()), 2000)
        self.assertTrue(tr['output'].endswith('...[truncated]'))
        self.assertEqual(tr['status'], 'ok')

    def test_replay_serves_matching_recording_labelled_replay(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))])
        replayed = evidence.collect(self.media, ['probe'], runner=Fake([]), which=which_with(), replay=[rec])[0]
        self.assertEqual(replayed['mode'], 'replay')
        self.assertEqual(replayed['status'], 'ok')
        self.assertEqual(replayed['recorded_from']['mode'], 'live')
        self.assertEqual(replayed['output'], rec['output'])

    def test_replay_refused_for_different_bytes(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))])
        other = self.dir / 'other.mkv'
        other.write_bytes(b'different bytes entirely')
        replayed = evidence.collect(other, ['probe'], runner=Fake([]), which=which_with(), replay=[rec])[0]
        self.assertEqual(replayed['status'], 'unavailable')
        self.assertEqual(replayed['mode'], 'replay')
        self.assertEqual(replayed['output'], {})
        self.assertIn('does not match', replayed['reason'])

    def test_replay_covers_only_recorded_kinds_and_runs_the_rest_live(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))])
        recs = evidence.collect(self.media, ['probe', 'decode'], runner=Fake([]), which=which_with(), replay={'probe': rec})
        self.assertEqual([r['mode'] for r in recs], ['replay', 'live'])
        self.assertEqual(recs[1]['status'], 'unavailable')

    def test_replay_file_roundtrip(self):
        rec, _ = self.run_kind('probe', [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))])
        f = self.dir / 'rec.json'
        f.write_text(json.dumps({'records': [rec]}))
        self.assertEqual(evidence.collect(self.media, ['probe'], runner=Fake([]), which=which_with(), replay=f)[0]['mode'], 'replay')

    def test_collector_crash_becomes_error_record(self):
        def boom(argv, **kw):
            raise RuntimeError('boom %s' % self.media)
        rec = evidence.collect(self.media, ['probe'], runner=boom, which=which_with('ffprobe'))[0]
        self.assertEqual((rec['status'], rec['cause']), ('error', 'tool'))
        self.assertIn('crashed', rec['reason'])
        self.assertNotIn(str(self.media), rec['reason'])

    def test_all_kinds_in_order_and_record_keys_stable(self):
        rules = [(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b'')), (prog('ffmpeg', '-progress'), clean_decode), (prog('ffmpeg', '-af'), RunResult(0, b'', LEVELS)),
                 (prog('ffmpeg', '-frames:v'), lambda a: (Path(a[-1]).write_bytes(FrameTests.PNG), RunResult(0, b'', b''))[1])]
        recs = evidence.collect(self.media, None, runner=Fake(rules + VERSION), which=which_with('ffmpeg', 'ffprobe'))
        self.assertEqual([r['tool'] for r in recs], list(evidence.KINDS))
        for r in recs:
            self.shape(r)
        self.assertEqual([r['status'] for r in recs][:4], ['ok'] * 4)
        self.assertEqual(recs[4]['cause'], 'input')  # a fake mkv is not an EPUB
        json.dumps(recs)  # serialisable

    def test_scratch_removed(self):
        scratch = self.dir / 'scr'
        scratch.mkdir()
        evidence.collect(self.media, ['probe'], runner=Fake([(prog('ffprobe', '-show_format'), RunResult(0, probe_json(), b''))] + VERSION),
                         which=which_with('ffprobe'), scratch_dir=scratch)
        self.assertEqual(list(scratch.iterdir()), [])


class RunnerTests(unittest.TestCase):
    """The real subprocess runner, with a tiny python child (no ffmpeg, no CPU load)."""

    def run_py(self, code, timeout=5, cap_out=1024, cap_err=1024):
        return core.subprocess_runner([sys.executable, '-c', code], timeout_s=timeout, max_stdout=cap_out, max_stderr=cap_err)

    def test_captures_and_exit_code(self):
        r = self.run_py("import sys; print('out'); sys.stderr.write('err'); sys.exit(3)")
        self.assertEqual((r.returncode, r.stdout.strip(), r.stderr, r.timed_out), (3, b'out', b'err', False))

    def test_no_shell_interpretation(self):
        r = core.subprocess_runner([sys.executable, '-c', 'import sys; print(sys.argv[1])', 'a; echo injected $HOME'], timeout_s=5, max_stdout=1024, max_stderr=1024)
        self.assertEqual(r.stdout.strip(), b'a; echo injected $HOME')

    def test_hard_timeout_kills(self):
        r = self.run_py('import time; time.sleep(30)', timeout=0.5)
        self.assertTrue(r.timed_out)
        self.assertIsNone(r.returncode)
        self.assertLess(r.elapsed_s, 5)

    def test_output_is_capped(self):
        r = self.run_py("import sys; sys.stdout.write('x' * 100000); sys.stdout.flush()", cap_out=2000)
        self.assertLessEqual(len(r.stdout), 2000)
        self.assertTrue(r.stdout_truncated)

    def test_spawn_error(self):
        r = core.subprocess_runner(['/nonexistent/binary'], timeout_s=2, max_stdout=10, max_stderr=10)
        self.assertIn('FileNotFoundError', r.error)


class BoundTests(unittest.TestCase):
    def test_defaults_and_validation(self):
        b, clamped = core.resolve_bounds(None)
        self.assertEqual((b['segments'], b['segment_s'], b['full_decode'], clamped), (3, 4, False, []))
        for bad in ({'segments': 'x'}, {'full_decode': 1}, {'ocr': 'maybe'}, {'timeout_s': 0}, {'segments': True}):
            with self.assertRaises(ValueError):
                core.resolve_bounds(bad)
        b, clamped = core.resolve_bounds({'timeout_s': 5, 'silence_noise_db': -40})
        self.assertEqual((b['timeout_s'], b['silence_noise_db'], clamped), (5, -40, []))
        b, clamped = core.resolve_bounds({'silence_noise_db': -10})
        self.assertEqual(b['silence_noise_db'], -30)
        self.assertEqual(clamped[0]['bound'], 'silence_noise_db')


if __name__ == '__main__':
    unittest.main()
