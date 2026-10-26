"""Helpers for the #213 tests (tools behaviour v3-remote-2): the REAL mrh-sampler-4 run locally over made-up files, with a fake ffmpeg that reads the range server like
the real one and reports ffmpeg-style `-progress` on the descriptor the sampler gives it.  No suite data, no real media, no network, no ffmpeg binary."""
import json
import os
import sys
import tempfile
from pathlib import Path

import rem_h as H
import th
from media_repair_harness import remote_evidence_2 as R2
from media_repair_harness import tools as T

# A fake `ffmpeg`.  The file's first line is a JSON header the test chose: `need_bytes` is how many input bytes the "decode" wants before the window is done
# (a real decode of a window needs about window * bitrate), `out_time` fixes the decoded time instead, `no_progress` omits the progress report, `srt` is the subtitle
# text.  The fake reads the range server from byte 0 until it has `need_bytes` or the server ends the response (the sampler's quota); when the input is cut it prints
# what ffmpeg prints, decodes only the fraction it read, and still exits 0, as the real one did in the first live check.
FAKE_FFMPEG_2 = '''#!%s
import io, json, os, sys, urllib.request, wave
a = sys.argv
url, fmt = a[a.index('-i') + 1], a[a.index('-f') + 1]
fd = int(a[a.index('-progress') + 1].split(':')[1]) if '-progress' in a else None
window = float(a[a.index('-t') + 1]) if '-t' in a else 0.0
resp = urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-'}), timeout=10)
head = resp.read(8192)
hdr = json.loads(head.split(b'\\n', 1)[0])
need, got, cut = int(hdr.get('need_bytes', 0)), len(head), False
try:
    while got < need:
        chunk = resp.read(min(65536, need - got))
        if not chunk:
            raise EOFError
        got += len(chunk)
except Exception:
    cut = True
frac = 1.0 if not need else min(1.0, got / float(need))
out_time = float(hdr['out_time']) if 'out_time' in hdr else window * frac
if cut:
    sys.stderr.write('[http @ 0x1] Stream ends prematurely at %%d, should be %%s\\n[in#0/matroska,webm @ 0x2] Read error\\n' %% (got, hdr.get('size', '?')))
if fd is not None and not hdr.get('no_progress'):
    os.write(fd, ('frame=%%d\\nout_time_us=%%d\\nprogress=end\\n' %% (int(out_time * 24), int(out_time * 1e6))).encode())
if fmt == 'srt':
    sys.stdout.write(hdr.get('srt', ''))
elif fmt == 'wav' and out_time > 0:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b'\\x10\\x00\\xf0\\xff' * int(16000 * out_time / 2))
    sys.stdout.buffer.write(buf.getvalue())
'''

PROBE2 = {'format': {'format_name': 'matroska,webm', 'duration': '100.0', 'bit_rate': '1000000'},
          'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'},
                      {'index': 1, 'codec_type': 'audio', 'codec_name': 'dts', 'tags': {'language': 'eng'}},
                      {'index': 2, 'codec_type': 'subtitle', 'codec_name': 'hdmv_pgs_subtitle'},
                      {'index': 3, 'codec_type': 'subtitle', 'codec_name': 'subrip', 'tags': {'language': 'eng'}},
                      {'index': 4, 'codec_type': 'audio', 'codec_name': 'aac', 'tags': {'language': 'jpn'}}]}


def pod():
    """A LocalPod (the real sampler, run locally) whose ffmpeg is the progress-reporting fake above."""
    p = H.LocalPod()
    ff = p.bin / 'ffmpeg'
    ff.write_text(FAKE_FFMPEG_2 % sys.executable)
    ff.chmod(0o755)
    return p


def sparse_media(path, size, probe=PROBE2, **hdr):
    """A made-up media file of `size` bytes (sparse): the first line is the fake ffmpeg / ffprobe header."""
    head = (json.dumps(dict({'probe': probe, 'srt': H.SRT.decode(), 'size': size}, **hdr)) + '\n').encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(head)
        f.truncate(size)
    return path


def identity(path):
    st = os.stat(path)
    return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino}


def remote_case(path, root, probe=PROBE2, tools=('ffprobe', 'decode_sample', 'audio_sample', 'subtitle_sample', 'frame_sample'), id='r2-1'):
    fx = {'kind': 'remote', 'locator': 'remote:media/sampler/app:%s' % path, 'allowed_root': str(root), 'expected_identity': identity(path),
          'expected_hostname': H.hostname()}
    ev = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe)}] if probe is not None else []
    return th.make_case(id=id, media='tv', truth='healthy', fixture=fx, evidence=ev, tools_available=list(tools))


def make_ctx(case, runner, probe=PROBE2):
    """A v3-remote-2 Context over `case`, wired as the runner wires it (binding, subtitle stream, probe)."""
    fx = T.Fixture.from_case(case, '.')
    ctx = T.Context(case, fx, tempfile.mkdtemp(), runner=runner, which=th.NO_BINARIES, tools_behavior='v3-remote-2',
                    remote_binding=R2.binding_for_case(case, R2.RE.HostState()))
    ctx.subtitle_stream = R2.RE.select_subtitle_stream(case['evidence'])
    ctx.media_probe = R2.first_probe(case['evidence'])
    return ctx


class Rig:
    """One made-up remote file under a temp root, its case, a v3-remote-2 context and the pod."""

    def __init__(self, test, size=200_000_000, probe=PROBE2, **hdr):
        self.root = Path(tempfile.mkdtemp()).resolve()
        test.addCleanup(lambda: __import__('shutil').rmtree(self.root, ignore_errors=True))
        self.path = sparse_media(self.root / 'show' / 'item.mkv', size, probe, **hdr)
        self.pod = pod()
        self.case = remote_case(self.path, self.root, probe)
        self.ctx = make_ctx(self.case, self.pod, probe)

    def call(self, tool, args):
        from media_repair_harness import tools as T_
        return T_.call_tool(self.ctx, tool, args)

    def last_entry(self):
        return self.ctx.remote_binding.receipts[-1]
