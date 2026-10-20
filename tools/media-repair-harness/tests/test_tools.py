import io
import json
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from media_repair_harness import protocol as P
import th
from media_repair_harness import tools as T

FIX = th.TESTDATA / 'fixtures'


def ctx_for(case, fixture, **kw):
    kw.setdefault('which', th.NO_BINARIES)
    return T.Context(case, fixture, tempfile.mkdtemp(), **kw)


def local_fixture(path):
    return T.Fixture('local', path=str(path))


class Completed:
    def __init__(self, rc=0, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = rc, out, err


class EpubInspect(unittest.TestCase):
    def test_valid_epub(self):
        c = th.make_case()
        r = T.call_tool(ctx_for(c, local_fixture(FIX / 'td-right.epub')), 'epub_inspect', {})
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(out['status'], 'ok')
        self.assertEqual(out['dc_title'], ['The Lantern Ledger'])
        self.assertEqual(out['dc_creator'], ['Ines Varga'])
        self.assertEqual(out['dc_language'], ['en'])
        self.assertEqual(len(out['spine_heads']), 2)

    def test_truncated_epub_is_reported_in_the_suites_recorded_shape(self):
        r = T.call_tool(ctx_for(th.make_case(), local_fixture(FIX / 'td-corrupt.epub')), 'epub_inspect', {})
        out = json.loads(r['output'])
        self.assertEqual(r['status'], 'error')  # same convention as the suite's recorded epub_inspect evidence
        self.assertEqual((out['status'], out['stage']), ('error', 'zip_open'))
        self.assertIn('BadZipFile', out['error'])

    def test_no_fixture_is_unavailable(self):
        r = T.call_tool(ctx_for(th.make_case(), T.Fixture('none')), 'epub_inspect', {})
        self.assertEqual(r['status'], 'unavailable')   # no media behind the case: the capability is absent, nothing ran

    def test_model_cannot_choose_a_path(self):
        r = T.call_tool(ctx_for(th.make_case(), local_fixture(FIX / 'td-right.epub')), 'epub_inspect', {'path': '/etc/passwd'})
        self.assertIn('Lantern', r['output'])  # the argument is ignored; the fixture is read


class DispatchAndBounds(unittest.TestCase):
    def test_unknown_or_unoffered_tool(self):
        c = th.make_case(tools_available=['arr_lookup'])
        ctx = ctx_for(c, T.Fixture('none'))
        # absent capability = unavailable, and the call is flagged as a protocol violation for the runner to record
        for name in ('ffprobe', 'shell'):
            r = T.call_tool(ctx, name, {})
            self.assertEqual((r['status'], r['protocol_violation']), ('unavailable', 'tool_not_offered'))
        self.assertNotIn('shell', T.call_tool(ctx, 'shell', {})['output'])   # a model-chosen name is never echoed back

    def test_output_is_capped_at_8kib(self):
        big = {'app': 'sonarr', 'ids': {'x': 'y' * 20000}}
        c = th.make_case(context={'title': 't', 'expected': {}, 'arr': big, 'notes_for_model': ''})
        r = T.call_tool(ctx_for(c, T.Fixture('none')), 'arr_lookup', {})
        self.assertTrue(r['truncated'])
        self.assertLessEqual(len(r['output'].encode()), P.TOOL_OUTPUT_BYTES)

    def test_arr_lookup_is_a_stub(self):
        r = T.call_tool(ctx_for(th.make_case(), T.Fixture('none')), 'arr_lookup', {})
        self.assertIn('"stub": true', r['output'])

    def test_bad_arguments_are_reported(self):
        c = th.make_case(tools_available=['decode_sample'])
        r = T.call_tool(ctx_for(c, local_fixture(FIX / 'td-right.epub')), 'decode_sample', {'at': 'soon'})
        self.assertEqual(r['status'], 'error')
        self.assertIn('bad arguments', r['output'])

    def test_tool_crash_is_contained(self):
        def boom(args, ctx):
            raise RuntimeError('kaboom')
        old = T.REGISTRY['arr_lookup']
        T.REGISTRY['arr_lookup'] = boom
        try:
            r = T.call_tool(ctx_for(th.make_case(), T.Fixture('none')), 'arr_lookup', {})
        finally:
            T.REGISTRY['arr_lookup'] = old
        self.assertEqual(r['status'], 'error')
        self.assertIn('kaboom', r['output'])


class MediaTools(unittest.TestCase):
    def test_ffprobe_missing_locally(self):
        c = th.make_case()
        ctx = ctx_for(c, local_fixture(FIX / 'td-right.epub'), which=lambda name: None)
        r = T.call_tool(ctx, 'ffprobe', {})
        self.assertEqual(r['status'], 'unavailable')   # the binary is absent: nothing ran
        self.assertIn('not installed', r['output'])

    def test_ffprobe_local_with_fake_binary_runs_niced(self):
        seen = []

        def runner(cmd, **kw):
            seen.append(cmd)
            return Completed(0, json.dumps({'format': {'duration': '10.0'}, 'streams': []}).encode())
        ctx = ctx_for(th.make_case(), local_fixture(FIX / 'td-right.epub'), runner=runner, which=lambda n: '/usr/bin/' + n)
        r = T.call_tool(ctx, 'ffprobe', {})
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(seen[0][:3], ['nice', '-n', '19'])
        self.assertIn('-threads', seen[0])
        self.assertEqual(seen[0][-1], str(FIX / 'td-right.epub'))

    def test_ffprobe_failure_exit_has_the_recorded_shape(self):
        runner = lambda cmd, **kw: Completed(1, b'', b'moov atom not found')
        ctx = ctx_for(th.make_case(), local_fixture(FIX / 'td-right.epub'), runner=runner, which=lambda n: '/x/' + n)
        r = T.call_tool(ctx, 'ffprobe', {})
        self.assertEqual(r['status'], 'error')
        self.assertEqual(json.loads(r['output'])['exit_code'], 1)
        self.assertEqual(r['mode'], 'local')

    def test_local_timeout_maps_to_timeout_status(self):
        def runner(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 25)
        ctx = ctx_for(th.make_case(), local_fixture(FIX / 'td-right.epub'), runner=runner, which=lambda n: '/x/' + n)
        self.assertEqual(T.call_tool(ctx, 'ffprobe', {})['status'], 'timeout')
        self.assertEqual(T.call_tool(ctx, 'decode_sample', {'at': 1})['status'], 'timeout')

    def test_remote_decode_builds_kubectl_exec_with_stdin_script(self):
        calls = []

        def runner(cmd, **kw):
            calls.append((cmd, kw))
            return Completed(0, b'', json.dumps({'exit_code': 0, 'stderr': '', 'quota_exhausted': False}).encode())
        fx = T.Fixture.from_case(th.make_case(fixture={'kind': 'remote', 'locator': 'remote:media/bazarr:/tv/x.mkv'}), '.')
        self.assertEqual((fx.namespace, fx.deploy, fx.path), ('media', 'bazarr', '/tv/x.mkv'))
        r = T.call_tool(ctx_for(th.make_case(), fx, runner=runner), 'decode_sample', {'at': 62})
        d = json.loads(r['output'])
        self.assertTrue(d['clean'])
        cmd, kw = calls[0]
        self.assertEqual(cmd[:6], ['kubectl', '-n', 'media', 'exec', '-i', 'deploy/bazarr'])
        self.assertIn('decode', cmd)
        self.assertIn(b'8388608', kw['input'])  # the vendored bounded sampler travels on stdin

    def test_decode_not_clean_when_stderr_or_quota(self):
        def runner(cmd, **kw):
            return Completed(0, b'', json.dumps({'exit_code': 0, 'stderr': 'error while decoding', 'quota_exhausted': False}).encode())
        fx = T.Fixture('remote', path='/x', namespace='media', deploy='bazarr')
        d = json.loads(T.call_tool(ctx_for(th.make_case(), fx, runner=runner), 'decode_sample', {'at': 0})['output'])
        self.assertFalse(d['clean'])

    def test_audiobook_inspect_summarises_chapters(self):
        probe = {'format': {'format_name': 'mov,mp4', 'duration': '7200.5', 'tags': {'title': 'Book'}},
                 'streams': [{'index': 0, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}],
                 'chapters': [{'id': 0, 'start_time': '0.0', 'end_time': '60.0', 'tags': {'title': 'Ch 1'}}]}
        runner = lambda cmd, **kw: Completed(0, json.dumps(probe).encode())
        ctx = ctx_for(th.make_case(media='audiobook'), local_fixture(FIX / 'td-right.epub'), runner=runner, which=lambda n: '/x/' + n)
        out = json.loads(T.call_tool(ctx, 'audiobook_inspect', {})['output'])
        self.assertEqual(out['chapter_count'], 1)
        self.assertEqual(out['duration_s'], 7200.5)
        self.assertEqual(out['chapters'][0]['title'], 'Ch 1')

    def test_frame_sample_keeps_image_in_scratch_and_reports_hash(self):
        png = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 640, 360) + b'\x00' * 20
        runner = lambda cmd, **kw: Completed(0, png)
        scratch = tempfile.mkdtemp()
        ctx = T.Context(th.make_case(), local_fixture(FIX / 'td-right.epub'), scratch, runner=runner, which=lambda n: '/x/' + n)
        r = T.call_tool(ctx, 'frame_sample', {'at': 12})
        out = json.loads(r['output'])
        self.assertEqual((out['width'], out['height'], out['frame']), (640, 360, 'frame@12'))
        self.assertTrue(Path(ctx.frames['frame@12']).exists())
        self.assertTrue(str(ctx.frames['frame@12']).startswith(scratch))

    def test_ocr_consensus_and_missing_backend(self):
        png = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 8, 8) + b'\x00' * 20
        runner = lambda cmd, **kw: Completed(0, png)
        mk = lambda backend: T.Context(th.make_case(), local_fixture(FIX / 'td-right.epub'), tempfile.mkdtemp(), runner=runner,
                                       which=lambda n: '/x/' + n, ocr_backend=backend)
        r = T.call_tool(mk(None), 'ocr', {'at': 1})
        self.assertEqual(r['status'], 'unavailable')
        self.assertIn('no OCR backend', r['output'])
        same = json.loads(T.call_tool(mk(lambda b: ' Hello  World '), 'ocr', {'at': 1})['output'])
        self.assertTrue(same['consensus'])
        self.assertEqual(same['text'], 'Hello World')
        seq = iter(['alpha', 'beta'])
        diff = json.loads(T.call_tool(mk(lambda b: next(seq)), 'ocr', {'at': 1})['output'])
        self.assertFalse(diff['consensus'])
        self.assertEqual(diff['text'], '')

    def test_wav_stats(self):
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack('<%dh' % 16000, *([0] * 8000 + [8000] * 8000)))
        s = T.wav_stats(buf.getvalue())
        self.assertAlmostEqual(s['duration_s'], 1.0, places=2)
        self.assertGreater(s['silent_fraction'], 0.4)
        self.assertIsNone(T.wav_stats(b'not a wav'))


class Fixtures(unittest.TestCase):
    def test_local_hash_verification(self):
        import hashlib
        good = hashlib.sha256((FIX / 'td-right.epub').read_bytes()).hexdigest()
        fx = T.Fixture.from_case(th.make_case(fixture={'kind': 'local', 'locator': str(FIX / 'td-right.epub'), 'sha256': good}), '.')
        self.assertTrue(fx.verify_local()['verified'])
        fx = T.Fixture.from_case(th.make_case(fixture={'kind': 'local', 'locator': str(FIX / 'td-right.epub'), 'sha256': '0' * 64}), '.')
        self.assertFalse(fx.verify_local()['verified'])

    def test_bad_remote_locator(self):
        with self.assertRaises(ValueError):
            T.Fixture.from_case(th.make_case(fixture={'kind': 'remote', 'locator': 'remote:oops'}), '.')


if __name__ == '__main__':
    unittest.main()
