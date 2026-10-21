"""Helpers for the #161 tests (tools behaviour v3-remote-1): synthetic remote cases, receipts and a fake sampler runner.  No suite data, no real media."""
import json
import subprocess

import th
from media_repair_harness import remote_evidence as RE

IDENT = {'size': 1000, 'mtime_ns': 5, 'dev': 64, 'ino': 77}
SRT = b"1\n00:00:01,000 --> 00:00:03,500\nHello there, <i>Professor</i>.\n\n2\n00:00:04,000 --> 00:00:06,000\n{\\an8}We meet at the\nlighthouse.\n\n"
PROBE = {'format': {'format_name': 'matroska,webm', 'duration': '1300.0'},
         'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac'},
                     {'index': 2, 'codec_type': 'subtitle', 'codec_name': 'hdmv_pgs_subtitle'},
                     {'index': 3, 'codec_type': 'subtitle', 'codec_name': 'subrip', 'tags': {'language': 'eng'}}]}
PROBE_NO_TEXT = {'format': PROBE['format'], 'streams': PROBE['streams'][:3]}
TOOLS = ['ffprobe', 'decode_sample', 'subtitle_sample', 'arr_lookup']
V31 = dict(prompt_version='v7', evidence_format='v3.1-format', guards='v3')


class Completed:
    def __init__(self, rc, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = rc, out, err


def receipt(mode_, stdout=b'', host='pod-a', ident=IDENT, **over):
    r = {'receipt': RE.RECEIPT, 'mode': mode_, 'hostname': host, 'exit_code': 0, 'error': None, 'stdout_bytes': len(stdout), 'stderr': '',
         'bytes_read': 4096, 'quota_exhausted': False, 'requests': 1, 'wall_seconds': 1.5, 'timed_out': False, 'source_unchanged': True,
         'identity': {'expected': ident, 'start': ident, 'end': ident, 'start_ok': True if ident else None, 'end_ok': True if ident else None, 'same_file': True},
         'argv': ['nice'], 'confined': True}
    r.update(over)
    return r


def mode_of(argv):
    return argv[argv.index('-') + 1]


class FakeSampler:
    """A runner standing in for `kubectl exec ... python3 - <mode>`: `script` is a list of callables (argv -> Completed or an exception to raise), used
    in order; when it runs out, `default(argv)` answers.  Every invocation is recorded in `calls`."""

    def __init__(self, script=(), default=None):
        self.script, self.calls = list(script), []
        self.default = default or self.ok

    @staticmethod
    def ok(argv, stdout=None, **over):
        mode = mode_of(argv)
        out = stdout if stdout is not None else {'subtitle': SRT, 'probe': json.dumps(PROBE).encode(), 'decode': b''}.get(mode, b'')
        return Completed(0, out, ('ffmpeg noise\n' + json.dumps(receipt(mode, out, **over))).encode())

    def __call__(self, argv, input=None, capture_output=True, timeout=None):
        self.calls.append(argv)
        step = self.script.pop(0) if self.script else self.default
        r = step(argv)
        if isinstance(r, BaseException):
            raise r
        return r


def answer(**over):
    return lambda argv: FakeSampler.ok(argv, **over)


def raw(rc, out, err):
    return lambda argv: Completed(rc, out, err)


def outer_timeout(argv):
    return subprocess.TimeoutExpired(argv, RE.OUTER_DEADLINE_S)


def remote_case(id='rx-1', probe=PROBE, ident=IDENT, host='pod-a', tools=TOOLS, **extra):
    fx = {'kind': 'remote', 'locator': 'remote:media/sampler/app:/lib/show/item.mkv', 'allowed_root': '/lib'}
    if ident is not None:
        fx['expected_identity'] = ident
    if host is not None:
        fx['expected_hostname'] = host
    ev = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe)}] if probe is not None else []
    return th.make_case(id=id, media='tv', truth='healthy', fixture=fx, evidence=ev, tools_available=list(tools), **extra)


def dec(cls='identity_mismatch', action='escalate', refs=()):
    return json.dumps({'type': 'decision', 'class': cls, 'action': action, 'reason': 'r', 'confidence': 0.7, 'evidence_refs': list(refs)})


# ---------------------------------------------------------------------------------------------------------------- the REAL mrh-sampler-2, run locally
import os  # noqa: E402
import socket  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

FAKE_FFPROBE = '''#!%s
import json, sys, urllib.request
data = urllib.request.urlopen(urllib.request.Request(sys.argv[-1], headers={'Range': 'bytes=0-8191'}), timeout=5).read()
hdr = json.loads(data.split(b'\\n', 1)[0])
if hdr.get('probe_fail'):
    sys.stderr.write('Invalid data found when processing input\\n')
    sys.exit(1)
print(json.dumps(hdr['probe']))
'''
FAKE_FFMPEG = '''#!%s
import json, sys, urllib.request
a = sys.argv
url, fmt = a[a.index('-i') + 1], a[a.index('-f') + 1]
data = urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-8191'}), timeout=5).read()
hdr = json.loads(data.split(b'\\n', 1)[0])
if hdr.get('sleep'):
    import time
    time.sleep(hdr['sleep'])
if fmt == 'srt':
    sys.stdout.write(hdr.get('srt', ''))
'''


def fake_bin():
    d = Path(tempfile.mkdtemp()) / 'bin'
    d.mkdir()
    for name, text in (('ffprobe', FAKE_FFPROBE), ('ffmpeg', FAKE_FFMPEG)):
        p = d / name
        p.write_text(text % sys.executable)
        p.chmod(0o755)
    return d


def media_file(path, probe=PROBE, srt=SRT.decode(), size=20000, **hdr):
    """A synthetic 'media' file: one JSON header line the fake ffprobe / ffmpeg read through the sampler's range server, padded to `size` bytes.
    `probe_fail=True` makes the fake ffprobe fail; `sleep=s` makes the fake ffmpeg sleep first."""
    head = (json.dumps(dict({'probe': probe, 'srt': srt}, **hdr)) + '\n').encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(head + b'\0' * max(0, size - len(head)))
    return path


class LocalPod:
    """A runner for which `kubectl exec ... python3 - <mode> <path> ...` runs the REAL mrh-sampler-2 on this machine (the paths are local), with fake
    ffprobe / ffmpeg first on PATH; `kubectl get deploy|pods` answer from `deploy` / `pods`.  `before(argv, n)` may change files or raise; `after(argv, n,
    completed)` may replace the result (a tampered receipt).  `n` counts exec calls from 1."""

    def __init__(self, deploy=None, pods=None, before=None, after=None):
        self.bin, self.deploy, self.pods, self.before, self.after = fake_bin(), deploy, pods, before, after
        self.calls, self.execs = [], 0

    def __call__(self, argv, input=None, capture_output=True, timeout=None, **kw):
        self.calls.append(argv)
        if argv[:1] == ['kubectl'] and 'get' in argv:
            what = argv[argv.index('get') + 1]
            body = self.deploy if what == 'deploy' else (self.pods() if callable(self.pods) else self.pods)
            return Completed(0 if body is not None else 1, json.dumps(body).encode() if body is not None else b'', b'')
        self.execs += 1
        n = self.execs
        if self.before:
            r = self.before(argv, n)
            if isinstance(r, BaseException):
                raise r
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ.get('PATH', ''))
        i = argv.index('-')
        import subprocess as sp
        done = sp.run([sys.executable, '-'] + argv[i + 1:], input=input, capture_output=True, timeout=timeout, env=env)
        out = Completed(done.returncode, done.stdout, done.stderr)
        return self.after(argv, n, out) if self.after else out


def hostname():
    return socket.gethostname()
