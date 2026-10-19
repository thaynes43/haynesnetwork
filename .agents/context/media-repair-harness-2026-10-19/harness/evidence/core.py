"""Shared plumbing for the live evidence collectors: bounds, the subprocess runner, the record shape.

Everything here is stdlib.  No shell is ever used (argv lists only), every subprocess has a hard timeout,
its output is capped (RLIMIT_FSIZE on the temp files that receive it), the input is only ever opened read-only,
and scratch output goes to a temp dir that is removed when `collect` returns.  Nothing here writes to media.
"""
import copy
import hashlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

KINDS = ('probe', 'decode', 'frames', 'audio', 'epub', 'audiobook')
STATUSES = ('ok', 'partial', 'unavailable', 'error', 'timeout')
HARNESS_TOOL = {'probe': 'ffprobe', 'decode': 'decode_sample', 'frames': 'frame_sample', 'audio': 'audio_sample',
                'epub': 'epub_inspect', 'audiobook': 'audiobook_inspect'}
MIB = 1 << 20

# name -> (default, hard maximum).  A caller can lower a bound or raise it up to the hard maximum, never past it.
BOUND_SPEC = {
    'timeout_s': (20, 60),                 # one subprocess
    'deadline_s': (120, 600),              # all subprocesses of one collector
    'segments': (3, 8),                    # interior sampled segments (head and tail are always added)
    'segment_s': (4, 10),                  # length of one sampled segment
    'max_segments': (10, 12),              # head + tail + interior, after de-duplication
    'full_decode': (False, True),          # decode the whole file; only if the next two bounds allow it
    'full_max_bytes': (64 * MIB, 512 * MIB),
    'full_timeout_s': (60, 300),
    'frames': (3, 8),
    'frame_width': (640, 1280),
    'ocr': ('auto', None),                 # 'auto' | 'off'
    'ocr_timeout_s': (20, 60),
    'ocr_max_chars': (400, 2000),
    'max_audio_streams': (2, 4),
    'silence_noise_db': (-50, -30),
    'silence_min_s': (0.5, 5),
    'max_stdout_bytes': (4 * MIB, 16 * MIB),      # ffprobe JSON of a book with many chapters is large
    'max_frame_bytes': (8 * MIB, 32 * MIB),       # one PNG frame written by ffmpeg
    'max_stderr_bytes': (64 * 1024, 256 * 1024),
    'stderr_excerpt_bytes': (1500, 4000),
    'max_files': (50, 200),                # audiobook parts
    'audiobook_segments': (1, 4),          # interior segments per part (head and tail are added)
    'audiobook_segment_s': (3, 10),
    'epub_max_members': (5000, 20000),
    'epub_max_uncompressed_bytes': (128 * MIB, 1024 * MIB),
    'epub_max_member_bytes': (8 * MIB, 32 * MIB),
    'epub_max_opf_bytes': (2 * MIB, 8 * MIB),      # container.xml, the OPF and mimetype are read whole, so they get a tighter cap
    'epub_max_xhtml_docs': (200, 1000),
}


def resolve_bounds(user):
    """-> (bounds dict, clamped list).  Unknown keys and wrong types raise ValueError (a typo must not silently unbound)."""
    bounds = {k: v[0] for k, v in BOUND_SPEC.items()}
    clamped = []
    for key, val in (user or {}).items():
        if key not in BOUND_SPEC:
            raise ValueError('unknown bound %r' % key)
        default, hard = BOUND_SPEC[key]
        if key == 'ocr':
            if val not in ('auto', 'off'):
                raise ValueError("ocr must be 'auto' or 'off'")
        elif isinstance(default, bool):
            if not isinstance(val, bool):
                raise ValueError('%s must be a bool' % key)
            if val and not hard:
                val = False
        else:
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                raise ValueError('%s must be a number' % key)
            lo = BOUND_SPEC_MIN.get(key, 0)
            if val < lo:
                raise ValueError('%s must be >= %s' % (key, lo))
            if hard is not None and val > hard:
                clamped.append({'bound': key, 'requested': val, 'used': hard})
                val = hard
        bounds[key] = val
    return bounds, clamped


# silence_noise_db is negative; everything else must be at least 0, and these need at least 1
BOUND_SPEC_MIN = {'timeout_s': 1, 'deadline_s': 1, 'segment_s': 1, 'max_segments': 2, 'frame_width': 16, 'full_timeout_s': 1,
                  'ocr_timeout_s': 1, 'max_stdout_bytes': 1024, 'max_stderr_bytes': 1024, 'stderr_excerpt_bytes': 100,
                  'max_files': 1, 'silence_noise_db': -120, 'silence_min_s': 0.05, 'audiobook_segment_s': 1,
                  'epub_max_members': 1, 'max_frame_bytes': 1024, 'epub_max_opf_bytes': 1024, 'epub_max_member_bytes': 1024, 'epub_max_uncompressed_bytes': 1024,
                  'max_audio_streams': 1, 'ocr_max_chars': 10}


class RunResult:
    """What a subprocess did.  `error` is set when it could not be started at all."""

    def __init__(self, returncode=None, stdout=b'', stderr=b'', timed_out=False, elapsed_s=0.0, stdout_truncated=False,
                 stderr_truncated=False, error=None, file_size_limit=False):
        self.file_size_limit = file_size_limit  # the child was killed by SIGXFSZ: it tried to write past the file-size cap
        self.returncode, self.stdout, self.stderr, self.timed_out = returncode, stdout, stderr, timed_out
        self.elapsed_s, self.stdout_truncated, self.stderr_truncated, self.error = elapsed_s, stdout_truncated, stderr_truncated, error


def subprocess_runner(argv, *, timeout_s, max_stdout, max_stderr, cwd=None, max_file=0):
    """Run argv (no shell) at nice 19, in its own process group, with a hard timeout and capped output.

    stdout and stderr go to temp files whose size is capped with RLIMIT_FSIZE (the child gets SIGXFSZ past the
    cap), so a runaway tool can neither fill the disk nor this process's memory."""
    import resource

    cap = max(max_stdout, max_stderr, max_file or 0) + 1
    env = dict(os.environ, OMP_THREAD_LIMIT='1', OMP_NUM_THREADS='1')  # tesseract (OpenMP) must not fan out over the node's cores

    def prepare():
        os.nice(19)
        resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)  # CPython ignores SIGXFSZ and children inherit that: restore it so the cap kills instead of failing writes with EFBIG

    started = time.monotonic()
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=cwd, shell=False, env=env,
                                    start_new_session=True, preexec_fn=prepare)
        except OSError as e:
            return RunResult(error='%s: %s' % (type(e).__name__, e), elapsed_s=time.monotonic() - started)
        timed_out = False
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()
            proc.wait()
        elapsed = time.monotonic() - started
        out.seek(0)
        err.seek(0)
        so, se = out.read(max_stdout + 1), err.read(max_stderr + 1)
    return RunResult(None if timed_out else proc.returncode, so[:max_stdout], se[:max_stderr], timed_out, elapsed,
                     len(so) > max_stdout, len(se) > max_stderr, file_size_limit=(not timed_out and proc.returncode == -signal.SIGXFSZ))


class Deadline:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock, self.end = clock, clock() + seconds

    def left(self):
        return self.end - self.clock()


class Ctx:
    """Everything a collector needs for one collect() call.  Not shared between calls."""

    def __init__(self, path, bounds, runner, which, scratch, clock=time.monotonic):
        self.path, self.bounds, self.runner, self.which, self.scratch, self.clock = str(path), bounds, runner, which, Path(scratch), clock
        self.versions, self.cache = {}, {}
        self.names = {self.path, os.path.basename(self.path)}
        self._n = 0

    def add_name(self, path):
        self.names |= {str(path), os.path.basename(str(path))}

    def run(self, argv, timeout_s=None, deadline=None, max_file=0):
        """-> RunResult.  The timeout never exceeds the time left on the collector's deadline."""
        t = float(timeout_s or self.bounds['timeout_s'])
        if deadline is not None:
            t = min(t, max(0.1, deadline.left()))
        self._n += 1
        return self.runner(argv, timeout_s=t, max_stdout=int(self.bounds['max_stdout_bytes']),
                           max_stderr=int(self.bounds['max_stderr_bytes']), cwd=str(self.scratch), max_file=int(max_file))

    def binary(self, name):
        return self.which(name)

    def version(self, name):
        """First line of `<name> -version`, cached; None if it cannot be read."""
        if name in self.versions:
            return self.versions[name]
        exe = self.which(name)
        ver = None
        if exe:
            flag = '--version' if name == 'tesseract' else '-version'
            r = self.runner([exe, flag], timeout_s=10, max_stdout=8192, max_stderr=8192, cwd=str(self.scratch), max_file=0)
            text = (r.stdout + r.stderr).decode('utf-8', 'replace').strip()
            ver = text.splitlines()[0][:160] if text and not r.error and not r.timed_out else None
        self.versions[name] = ver
        return ver

    def scrub(self, text):
        """Replace the input path with <input> so tool output never carries the file name."""
        if not isinstance(text, str):
            return text
        for p in sorted(self.names, key=len, reverse=True):
            if p:
                text = text.replace(p, '<input>')
        return text

    def excerpt(self, *chunks):
        limit = int(self.bounds['stderr_excerpt_bytes'])
        text = self.scrub('\n'.join(c.decode('utf-8', 'replace') if isinstance(c, bytes) else c for c in chunks if c).strip())
        raw = text.encode('utf-8')
        if len(raw) <= limit:
            return text
        return raw[:limit].decode('utf-8', 'ignore') + ' ...[excerpt cut, %d bytes total]' % len(raw)


def fingerprint(path, window=MIB):
    """Size plus head and tail window hashes.  Partial by design: the whole file is never hashed."""
    p = Path(path)
    if not p.is_file():
        return None
    size = p.stat().st_size
    with open(p, 'rb') as f:
        head = f.read(min(window, size))
        f.seek(max(0, size - window))
        tail = f.read(window)
    return {'name': p.name, 'bytes': size, 'head_1m_sha256': hashlib.sha256(head).hexdigest(),
            'tail_1m_sha256': hashlib.sha256(tail).hexdigest(), 'partial_fingerprint_only': True}


def _sig(fp):
    if fp is None:
        return None
    items = fp.get('files') if fp.get('kind') == 'files' else [fp]
    return [(x.get('bytes'), x.get('head_1m_sha256'), x.get('tail_1m_sha256')) for x in items or []]


def make_record(tool, mode, status, ctx, started, *, version=None, coverage=None, output=None, stderr='', reason=None,
                cause=None, bounds_used=None):
    """The record every collector returns.  `cause` ('input' | 'tool') says why an `error` happened: the input
    is damaged (a finding) or the collector/binary could not do its job."""
    assert status in STATUSES, status
    cov = coverage or {}
    rec = {'tool': tool, 'harness_tool': HARNESS_TOOL[tool], 'tool_version': version, 'mode': mode, 'status': status,
           'coverage': {'verified': list(cov.get('verified', [])), 'not_verified': list(cov.get('not_verified', []))},
           'bounds': bounds_used if bounds_used is not None else {}, 'stderr': stderr or '',
           'elapsed_s': round(ctx.clock() - started, 3), 'output': output if output is not None else {}}
    if reason:
        rec['reason'] = reason
    if cause:
        rec['cause'] = cause
    return rec


def used_bounds(ctx, keys):
    return {k: ctx.bounds[k] for k in keys}


def unavailable(tool, ctx, started, binary, not_verified):
    return make_record(tool, 'live', 'unavailable', ctx, started, reason='%s not found on PATH' % binary,
                       coverage={'verified': [], 'not_verified': not_verified})


def tool_error(tool, ctx, started, reason, **kw):
    return make_record(tool, 'live', 'error', ctx, started, reason=reason, cause='tool', **kw)


def to_tool_result(rec, cap=8192):
    """A record in the harness' tool-result shape ({status, output text, truncated, mode, wall_s, ...}).

    The harness' ToolResult knows ok|partial|error|timeout only, so `unavailable` is delivered as `error`
    with `evidence_status: "unavailable"` kept beside it (nothing is relabelled healthy).

    The text is one JSON object whose keys are in priority order: status, reason, cause, replay_note, bounds_clamped,
    coverage, stderr and the rest first, `output` last.  When the text exceeds `cap`, `output` is the part that is cut
    (it becomes a string ending in a marker), so a reader never loses the status, the reason or what was not verified."""
    status = rec['status']
    order = ('status', 'reason', 'cause', 'mode', 'tool', 'tool_version', 'replay_note', 'recorded_from', 'bounds_clamped', 'coverage',
             'stderr', 'bounds', 'elapsed_s')
    body = {k: rec[k] for k in order if k in rec}
    dump = lambda d: json.dumps(d, ensure_ascii=False)
    output = rec.get('output', {})
    truncated = False
    if len((dump(dict(body, output=output))).encode('utf-8')) > cap:
        truncated = True
        marker = ' ...[output truncated]'
        if len(dump(dict(body, output=marker)).encode('utf-8')) > cap:  # the head alone is too big: trim the long fields
            body['stderr'] = (body.get('stderr') or '')[:300]
            cov = dict(body.get('coverage', {}))
            cov['not_verified'] = list(cov.get('not_verified', []))[:8]
            cov['verified'] = list(cov.get('verified', []))[:4]
            body['coverage'] = cov
            body['bounds'] = {}
        full = dump(output).encode('utf-8')
        room = cap - len(dump(dict(body, output='')).encode('utf-8')) - len(marker.encode()) - 8
        while True:  # the cut text is JSON-escaped once more when embedded, so shrink until the whole object fits
            output = full[:max(0, room)].decode('utf-8', 'ignore') + marker
            excess = len(dump(dict(body, output=output)).encode('utf-8')) - cap
            if excess <= 0 or room <= 0:
                break
            room -= excess + 4
    text = dump(dict(body, output=output))
    out = {'status': 'error' if status == 'unavailable' else status, 'output': text, 'truncated': truncated,
           'mode': rec['mode'], 'wall_s': rec['elapsed_s'], 'tool': rec['tool'], 'evidence_status': status}
    if rec.get('tool_version'):
        out['tool_version'] = rec['tool_version']
    return out


def as_replay(rec, current_fp):
    """A recorded record served as `replay`.  If the input no longer matches the recording's fingerprint the replay
    is refused (`unavailable`), and so is a recording with no fingerprint at all: a recording of another file, or one that
    cannot say which file it is about, is not evidence about this one."""
    out = copy.deepcopy(rec)
    recorded_fp = rec.get('input')
    out['recorded_from'] = {'mode': rec.get('mode'), 'elapsed_s': rec.get('elapsed_s'), 'tool_version': rec.get('tool_version')}
    out['mode'] = 'replay'
    out['replay_note'] = 'served from a recording; nothing was run now'
    refuse = None
    if recorded_fp is None:
        refuse = 'recording has no input fingerprint; it cannot be shown to describe this input, so it is not served'
    elif current_fp is None or _sig(recorded_fp) != _sig(current_fp):
        refuse = 'the recording does not match this input (size or head/tail hash differs); not served'
    if refuse:
        out['status'] = 'unavailable'
        out['reason'] = refuse
        out['coverage'] = {'verified': [], 'not_verified': ['everything: no matching recording of this input']}
        out['output'] = {}
        out.pop('cause', None)
    return out
