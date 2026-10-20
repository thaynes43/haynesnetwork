"""Read-only evidence tools.  The model chooses a tool and numeric arguments only; the file always comes
from the case fixture, never from model arguments.  Every tool returns a ToolResult whose text is bounded
(8 KiB) and which finishes inside the tool timeout (60 s).

Reuse (see README provenance table):
  epub_inspect     -> vendored_epub.py, a verbatim copy of .agents/context/media-repair-actual-epub-2026-10-18/epub.py (provenance header inside)
  remote ffprobe / decode / frame / audio -> remote_sampler.py, copied from media-repair-av-2026-10-18/sample_remote.py
  ocr              -> consensus rule of media-repair-av-identity-2026-10-18 (two readings, exact equality
                      after whitespace normalisation), prompt and schema from its ocr-config.json
  ollama transport -> ollama_transport.py
"""
import array
import base64
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import time
import wave
import io
import concurrent.futures
import threading

from pathlib import Path

from . import evidence as evcol
from . import leakguard
from .protocol import TOOL_OUTPUT_BYTES, TOOL_TIMEOUT_S

HERE = Path(__file__).resolve().parent
REMOTE_SAMPLER = HERE / 'remote_sampler.py'
OCR_PROMPT = ('Transcribe only readable text literally visible in this image. If there is no readable text, '
              'return an empty string. Do not name objects, infer the episode, or guess. Return only the schema object.')
OCR_SCHEMA = {'type': 'object', 'properties': {'visible_text': {'type': 'string', 'maxLength': 256}},
              'required': ['visible_text'], 'additionalProperties': False}


# Status semantics (dev-c1), one rule for every tool:
#   ok           the tool ran and returned the whole answer
#   partial      the tool ran and returned a cut or incomplete answer
#   error        the tool RAN (or its input was validated) and failed: a non-zero exit, a crash, bad arguments, a damaged file reported
#                by the tool itself.  A finding about the media is an `error` result of a working tool.
#   timeout      the tool ran and did not finish in time
#   unavailable  the CAPABILITY is absent: the tool is not offered for the case, the binary, backend or fixture is missing, no
#                recording exists to replay, or the recorded data cannot be used.  Nothing ran, so nothing was learned.
# `unavailable` is never an empty success, and like error/timeout/partial it leaves the checked part UNVERIFIED (never healthy).
STATUSES = ('ok', 'partial', 'error', 'timeout', 'unavailable')
RAW_OUTPUT_CAP = 1 << 20   # the largest uncut tool text kept for the typed layer


class ToolResult:
    def __init__(self, status, output, **extra):
        assert status in STATUSES
        self.status, self.output, self.extra = status, output, extra

    def bounded(self, redactor=None, cap=None, keep_raw=False):
        text = self.output if isinstance(self.output, str) else json.dumps(self.output, sort_keys=True, ensure_ascii=False)
        if redactor:
            text = redactor(text)  # fixture names encode the answer; redact before bounding
        raw = text.encode('utf-8')
        limit = cap or TOOL_OUTPUT_BYTES
        truncated = len(raw) > limit or bool(self.extra.get('collector_truncated'))   # collector_truncated: tools behaviour v2 only
        full_text = text
        if len(raw) > limit:
            marker = ' ...[truncated]'
            text = raw[:limit - len(marker.encode())].decode('utf-8', errors='ignore') + marker
        out = {'status': self.status, 'output': text, 'truncated': truncated, **self.extra}
        if keep_raw:   # evidence format v2 / guards v3: the whole redacted text, for the typed layer and the audit (record field, never sent as is)
            out['raw_output'] = full_text if len(full_text.encode('utf-8')) <= RAW_OUTPUT_CAP else full_text.encode('utf-8')[:RAW_OUTPUT_CAP].decode('utf-8', errors='ignore')
        return out


class Fixture:
    """local: a file path.  remote: kubectl-exec target.  pinned: real media known only from a recorded observation.  none: no media."""

    def __init__(self, kind, path=None, namespace=None, deploy=None, container='app', sha256=None):
        self.kind, self.path, self.namespace, self.deploy, self.container, self.sha256 = kind, path, namespace, deploy, container, sha256

    @classmethod
    def from_case(cls, case, suite_dir):
        fx = case.get('fixture') or {'kind': 'none'}
        kind = fx.get('kind', 'none')
        if kind == 'none':
            return cls('none')
        loc = fx.get('locator') or ''
        if kind == 'remote' and not loc.startswith('remote:'):
            # real library media recorded only as a pinned historical observation (the suite's reused rows)
            return cls('pinned', sha256=fx.get('sha256'))
        if kind == 'remote':
            # remote:<namespace>/<deployment>[/<container>]:<absolute path>
            head, _, path = loc.removeprefix('remote:').partition(':')
            parts = head.split('/')
            if len(parts) < 2 or not path.startswith('/'):
                raise ValueError('remote locator must be remote:<ns>/<deploy>[/<container>]:<abs path>')
            return cls('remote', path=path, namespace=parts[0], deploy=parts[1],
                       container=parts[2] if len(parts) > 2 else 'app', sha256=fx.get('sha256'))
        p = Path(os.path.expanduser(loc))
        if not p.is_absolute():
            p = Path(suite_dir) / p
        return cls('local', path=str(p), sha256=fx.get('sha256'))

    def verify_local(self):
        """-> dict recorded in the run: actual sha256 and whether it matches the declared one."""
        if self.kind != 'local':
            return {'kind': self.kind, 'verified': 'declared_only' if self.kind in ('remote', 'pinned') else 'n/a',
                    'declared_sha256': self.sha256}
        p = Path(self.path)
        if not p.is_file():
            return {'kind': 'local', 'verified': False, 'declared_sha256': self.sha256, 'error': 'file missing'}
        h = hashlib.sha256()
        with open(p, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        return {'kind': 'local', 'actual_sha256': h.hexdigest(), 'declared_sha256': self.sha256,
                'verified': (self.sha256 is None or h.hexdigest() == self.sha256), 'bytes': p.stat().st_size}


# Evidence modes (dev-c2).  `replay` (default) is the tool layer of dev-c1 unchanged: recorded probe results, recorded observations of pinned
# media, case-provided records, and the local ffprobe/ffmpeg route when those binaries exist.  `live` runs the bounded read-only collectors
# of `evidence/` on the case's own local media file; a case without a local media path that exists gets `unavailable` with the reason.
EVIDENCE_MODES = ('replay', 'live')
TOOLS_BEHAVIORS = ('v1', 'v2')
# harness tool -> collector kind of `evidence/` (frame_sample and ocr share the `frames` collector; the model never sees a picture either way)
LIVE_KINDS = {'ffprobe': 'probe', 'decode_sample': 'decode', 'frame_sample': 'frames', 'ocr': 'frames', 'audio_sample': 'audio',
              'epub_inspect': 'epub', 'audiobook_inspect': 'audiobook'}
# the collector finishes by itself inside the tool timeout, so a slow file is reported `partial`, not killed from outside
LIVE_DEADLINE_S = TOOL_TIMEOUT_S - 15


class Context:
    def __init__(self, case, fixture, scratch, runner=subprocess.run, which=shutil.which, ocr_backend=None,
                 suite_dir=None, replay='auto', evidence_mode='replay', collect=None, evidence_runner=None, evidence_which=None,
                 evidence_bounds=None, tools_behavior='v1', keep_raw=False):
        assert replay in ('auto', 'off', 'force')
        assert evidence_mode in EVIDENCE_MODES, evidence_mode
        assert tools_behavior in TOOLS_BEHAVIORS, tools_behavior
        self.evidence_mode = evidence_mode
        # tools behaviour (W18): v1 is every earlier harness version byte for byte; v2 (selected by `--evidence-format v2`) fixes the audit's tool bugs:
        # a full decode is a real full decode or says what window it actually ran (never a 4 s window reported as full), the collector's truncation
        # flag survives, and sampled coverage is the union of the windows.
        self.tools_behavior = tools_behavior
        self.keep_raw = keep_raw   # attach the uncut redacted text to each tool result (record field `raw_output`)
        # live-mode seams: `collect` replaces evidence.collect, `evidence_runner` / `evidence_which` are the collectors' own runner and which
        self.collect, self.evidence_runner, self.evidence_which = collect, evidence_runner, evidence_which
        self.evidence_bounds = dict(evidence_bounds or {})
        self.case, self.fixture, self.scratch = case, fixture, Path(scratch)
        self.runner, self.which, self.ocr_backend = runner, which, ocr_backend
        self.suite_dir, self.replay, self.replay_rec = suite_dir, replay, None
        self.output_cap = None  # per-run cap on one tool result (None = protocol default)
        extra = [fixture.path] if getattr(fixture, 'path', None) else []
        self._redact_extra = extra
        self.name_map = []     # live folder items: [(name, neutral replacement)] for every file and folder name under the item
        self.cancel, self.live_thread = None, None   # live mode: set by call_tool so an outer timeout can stop the collector's child
        self.forbidden_extra = extra
        self.frames, self.frame_t = {}, {}  # name -> path (None = virtual replay frame), name -> seconds
        self.scratch.mkdir(parents=True, exist_ok=True)


def _redact(self, text):
    """Fixture path / name redaction (leakguard), after the neutral names for the files and folders under a folder item (live mode)."""
    if isinstance(text, str):
        for name, repl in self.name_map:
            for form in ({name, json.dumps(name, ensure_ascii=False)[1:-1]}):
                text = re.sub(r'(?<![A-Za-z0-9])' + re.escape(form) + r'(?![A-Za-z0-9])', lambda m: repl, text)
    return leakguard.redact(text, self.case, self._redact_extra)


Context.redact = _redact


def _num(args, key, default, lo, hi):
    v = args.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise ValueError('%s must be a number in [%s, %s]' % (key, lo, hi))
    return float(v)


def _run_remote(ctx, mode, at=0.0, stream=0):
    fx = ctx.fixture
    cmd = ['kubectl', '-n', fx.namespace, 'exec', '-i', 'deploy/' + fx.deploy, '-c', fx.container, '--',
           'python3', '-', mode, fx.path, '--at', str(at), '--stream', str(int(stream))]
    try:
        r = ctx.runner(cmd, input=REMOTE_SAMPLER.read_bytes(), capture_output=True, timeout=TOOL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, b'', 'timeout'
    except OSError as e:
        return None, b'', 'error: %s' % e
    stderr = r.stderr.decode(errors='replace').strip().splitlines()
    info = None
    if stderr:
        try:
            info = json.loads(stderr[-1])
        except ValueError:
            info = {'exit_code': r.returncode, 'stderr': '\n'.join(stderr)[-2000:]}
    elif r.returncode:
        info = {'exit_code': r.returncode, 'stderr': ''}
    return info, r.stdout, None


def _local_bin(ctx, name):
    return ctx.which(name)


def _run_local(ctx, argv, timeout=25):
    cmd = ['nice', '-n', '19'] + argv
    try:
        r = ctx.runner(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return {'exit_code': 'timeout', 'stderr': (e.stderr or b'').decode(errors='replace')[:2000]}, (e.stdout or b'')
    return {'exit_code': r.returncode, 'stderr': r.stderr.decode(errors='replace')[:2000]}, r.stdout


def _need_media(ctx):
    if ctx.fixture.kind == 'none':
        return ToolResult('unavailable', 'no media fixture behind this case; the tool cannot run')
    if ctx.fixture.kind == 'local' and not Path(ctx.fixture.path).is_file():
        return ToolResult('unavailable', 'fixture file missing; the tool cannot run')
    return None


# ---- case-level replay for pinned real-media rows ---------------------------------------------------------------------
# A pinned row is real library media known only from a recorded observation.  A tool call on it returns what was recorded
# (the case's optional `replay` list, then its pre-collected evidence of the same tool) when the call matches, and an explicit
# `unavailable` result otherwise.  Nothing is ever invented, and a recorded failure stays a failure.
TIMED_TOOLS = ('decode_sample', 'frame_sample', 'audio_sample', 'ocr')


def _evidence_output(ctx, e):
    out, status = e.get('output'), e.get('status', 'ok')
    if isinstance(out, dict) and 'ref' in out:
        p = Path(out['ref'])
        p = p if p.is_absolute() else Path(ctx.suite_dir or '.') / p
        try:
            data = p.read_bytes()
        except OSError:
            return 'evidence file missing', 'unavailable'
        if out.get('sha256') and hashlib.sha256(data).hexdigest() != out['sha256']:
            return 'evidence file failed its integrity check (hash mismatch); its content is not shown', 'unavailable'
        out = data.decode('utf-8', errors='replace')
    if not isinstance(out, str):
        out = json.dumps(out, sort_keys=True, ensure_ascii=False)
    try:
        out = json.loads(out) if out.lstrip()[:1] in '{[' else out
    except ValueError:
        pass
    return out, (status if status in STATUSES else 'ok')


def _recorded(ctx, tool):
    """-> [(source id, entry)]: the case's recorded observations of `tool`."""
    found = [('replay', r) for r in (ctx.case.get('replay') or []) if isinstance(r, dict) and r.get('tool') == tool]
    found += [(e.get('id'), e) for e in ctx.case.get('evidence', []) if e.get('tool') == tool]
    return found


def _entry_time(entry):
    a = entry.get('args') or {}
    try:
        return _at(a)
    except ValueError:
        return None


def _recorded_times(ctx, tool):
    return sorted({_entry_time(e) for _, e in _recorded(ctx, tool) if not _is_full(e.get('args') or {}) and _entry_time(e) is not None})


def _pinned_note(source):
    return 'recorded observation (%s) of the real media; the media itself is not reachable, so nothing new was collected' % source


def _pinned_unavailable(tool, ctx, what=''):
    times = _recorded_times(ctx, tool) if tool in TIMED_TOOLS else []
    hint = (' (recorded at: %s s)' % ', '.join('%g' % t for t in times)) if times else ''
    return ToolResult('unavailable', 'no recorded observation of %s%s for this item%s; the media is not reachable and nothing was run' % (tool, (' ' + what) if what else '', hint), mode='pinned_replay')


def _pinned(tool, args, ctx):
    """Serve a tool call on a pinned row from the case's recorded observations."""
    recs = _recorded(ctx, tool)
    if tool in TIMED_TOOLS:
        if tool == 'frame_sample':
            at = _at(args)
            if not any(_entry_time(e) == at for _, e in _recorded(ctx, 'ocr')):
                return ToolResult('unavailable', 'no recorded observation of a frame at %g s for this item (recorded text readings at: %s); the media is not reachable and nothing was run' % (at, ', '.join('%g' % t for t in _recorded_times(ctx, 'ocr')) or 'none'), mode='pinned_replay')
            name = 'frame@%g' % at
            ctx.frames[name], ctx.frame_t[name] = None, at
            return ToolResult('ok', {'frame': name, 'replay': True, 'note': 'no image is available; call ocr with this frame to read the recorded on-screen text'}, mode='pinned_replay')
        if tool == 'ocr':
            name = args.get('frame')
            if name is not None:
                if name not in ctx.frames:
                    return ToolResult('error', 'unknown frame %r; call frame_sample first (known: %s)' % (name, sorted(ctx.frames)))
                at = ctx.frame_t[name]
            else:
                at = _at(args)
        else:
            at = _at(args)
        full = _is_full(args)
        hit = [(src, e) for src, e in recs if (_is_full(e.get('args') or {}) if full else (not _is_full(e.get('args') or {}) and _entry_time(e) == at))]
        if not hit:
            return _pinned_unavailable(tool, ctx, 'for the whole file' if full else 'at %g s' % at)
        src, e = hit[0]
        out, status = _evidence_output(ctx, e)
        if tool == 'ocr':
            out = {'t_s': at, 'text': out if isinstance(out, str) else json.dumps(out, sort_keys=True), 'consensus': True, 'recorded_as': src, 'note': _pinned_note(src)}
        else:
            out = {'observation': out, 'recorded_as': src, 'note': _pinned_note(src)}
        return ToolResult(status, out, mode='pinned_replay')
    if not recs:
        return _pinned_unavailable(tool, ctx)
    src, e = recs[0]
    out, status = _evidence_output(ctx, e)
    return ToolResult(status, {'observation': out, 'recorded_as': src, 'note': _pinned_note(src)}, mode='pinned_replay')


def _replay_record(ctx):
    """The recorded probe results for a local fixture (suite/fixtures/probes/<name>.json).
    -> (record, None, None) or (None, reason, 'unavailable'): nothing recorded, or the recording does not match the fixture bytes (unusable data)."""
    if ctx.fixture.kind != 'local' or ctx.suite_dir is None:
        return None, 'no replay file applies', 'unavailable'
    p = Path(ctx.suite_dir) / 'fixtures' / 'probes' / (Path(ctx.fixture.path).name + '.json')
    if not p.is_file():
        return None, 'no recorded replay for this item', 'unavailable'
    rec = json.loads(p.read_text())
    actual = hashlib.sha256(Path(ctx.fixture.path).read_bytes()).hexdigest()
    if rec.get('sha256') and rec['sha256'] != actual:
        return None, 'replay file does not match the fixture bytes (fixture changed since it was recorded)', 'unavailable'
    return rec, None, None


def _backend(ctx, binary):
    """'remote' | 'local' | 'replay' | ToolResult(error).  Replay only when the local binary is missing (or forced)."""
    bad = _need_media(ctx)
    if bad:
        return bad
    if ctx.fixture.kind == 'remote':
        return 'remote'
    if ctx.replay != 'force' and ctx.which(binary):
        return 'local'
    if ctx.replay == 'off':
        return ToolResult('unavailable', '%s is not installed in this environment and replay is disabled' % binary)
    rec, err, status = _replay_record(ctx)
    if rec is None:
        return ToolResult(status, '%s is not installed in this environment and %s' % (binary, err))
    ctx.replay_rec = rec
    return 'replay'


def _condense(d):
    """ffprobe -of json -> the condensed shape used by the suite's recorded evidence."""
    out = dict(d)
    ch = d.get('chapters')
    if ch and 'start_time' in (ch[0] if ch else {}):
        out['chapters'] = [{'start': c.get('start_time'), 'end': c.get('end_time'), 'title': (c.get('tags') or {}).get('title')} for c in ch]
    out.setdefault('exit_code', 0)
    out.setdefault('stderr', '')
    return out


def _probe(ctx, remote_mode, with_chapters):
    be = _backend(ctx, 'ffprobe')
    if isinstance(be, ToolResult):
        return be
    if be == 'replay':
        d = ctx.replay_rec['ffprobe']
        if d.get('exit_code') not in (0, None):
            return ToolResult('error', {'exit_code': d.get('exit_code'), 'stderr': d.get('stderr', '')}, mode='replay')
        return ToolResult('ok', d, mode='replay')
    if be == 'remote':
        info, out, err = _run_remote(ctx, remote_mode)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err, mode='remote')
        if info and info.get('exit_code') not in (0, None):
            return ToolResult('error', {'exit_code': info.get('exit_code'), 'stderr': (info.get('stderr') or '')[:1500]}, mode='remote')
        try:
            return ToolResult('ok', _condense(json.loads(out.decode())), mode='remote')
        except ValueError:
            return ToolResult('error', 'ffprobe returned no JSON', mode='remote')
    entries = ('format=format_name,duration,size,bit_rate:format_tags:stream=index,codec_name,codec_type,'
               'profile,pix_fmt,width,height,channels,channel_layout,sample_rate,duration,bit_rate:stream_tags=language,title')
    argv = [ctx.which('ffprobe'), '-v', 'error', '-threads', '1']
    if with_chapters:
        argv.append('-show_chapters')
    argv += ['-show_entries', entries, '-of', 'json', ctx.fixture.path]
    info, out = _run_local(ctx, argv)
    if info['exit_code'] == 'timeout':
        return ToolResult('timeout', 'ffprobe timed out', mode='local')
    if info['exit_code'] != 0:
        # a damaged container is a finding; same shape as the suite's recorded evidence (status error)
        return ToolResult('error', {'exit_code': info['exit_code'], 'stderr': info['stderr'][:1500]}, mode='local')
    try:
        return ToolResult('ok', _condense(json.loads(out.decode())), mode='local')
    except ValueError:
        return ToolResult('error', 'ffprobe returned no JSON', mode='local')


def tool_ffprobe(args, ctx):
    return _probe(ctx, 'probe', False)


def tool_audiobook_inspect(args, ctx):
    res = _probe(ctx, 'chapters', True)
    if res.status != 'ok' or not isinstance(res.output, dict) or 'format' not in res.output:
        return res
    d = res.output
    fmt = d.get('format', {})
    chapters = d.get('chapters', [])
    audio = [s for s in d.get('streams', []) if s.get('codec_type') == 'audio']
    summary = {'format': fmt.get('format_name'), 'duration_s': _float(fmt.get('duration')), 'bit_rate': fmt.get('bit_rate'),
               'tags': fmt.get('tags', {}), 'audio_streams': [{k: s.get(k) for k in ('index', 'codec_name', 'channels', 'sample_rate', 'duration')} for s in audio],
               'chapter_count': len(chapters),
               'chapters': [{'start_s': _float(c.get('start')), 'end_s': _float(c.get('end')), 'title': c.get('title')} for c in chapters[:60]]}
    if len(chapters) > 60:
        summary['chapters_omitted'] = len(chapters) - 60
    return ToolResult('ok', summary, mode=res.extra.get('mode'))


def _float(x):
    try:
        return round(float(x), 3)
    except (TypeError, ValueError):
        return None


def _at(args):
    """Seconds argument: `at`, with `ss` / `t` accepted as aliases (the suite's recorded evidence uses them)."""
    for key in ('at', 'ss', 't'):
        if key in args and args[key] != 'full':
            return _num(args, key, 0, 0, 86400 * 4)
    return 0.0


def _is_full(args):
    return args.get('full') is True or args.get('t') == 'full'


def _decode_verdict(at, window, info, extra=None):
    stderr = (info.get('stderr') or '')
    result = {'at_s': at, 'window_s': window, 'exit_code': info.get('exit_code'), 'frames': info.get('frames'), 'out_time': info.get('out_time'),
              'stderr': stderr[:1500], 'quota_exhausted': bool(info.get('quota_exhausted')),
              'clean': info.get('exit_code') == 0 and not stderr.strip() and not info.get('quota_exhausted')}
    result.update(extra or {})
    result['note'] = 'A clean sample does not prove whole-file health; a quota-limited sample does not prove corruption.'
    return result


def _progress_seconds(stdout):
    """Decoded seconds and frame count from `ffmpeg -progress pipe:1` text (bytes or str); (None, None) when absent."""
    text = stdout.decode('utf-8', 'replace') if isinstance(stdout, (bytes, bytearray)) else (stdout or '')
    secs = frames = None
    for line in text.splitlines():
        k, _, v = line.partition('=')
        v = v.strip()
        if k == 'out_time_us' and v.lstrip('-').isdigit():
            secs = int(v) / 1e6
        elif k == 'frame' and v.isdigit():
            frames = int(v)
    return secs, frames


V2_STREAMS = ['0:v:0', '0:a:0']   # what the local decode maps (first video and first audio stream)


def _decode_full_local(ctx):
    """Tools behaviour v2: a real full decode of the first video and first audio stream, inside the existing 25 s limit.  It either reaches the
    end of the file (`completed_to_eof` true, window `full`) or says what it did cover and what was requested (status partial, the actual window)."""
    argv = [ctx.which('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-i', ctx.fixture.path, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
            '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']
    info, out = _run_local(ctx, argv, timeout=LOCAL_FULL_TIMEOUT_S)
    secs, frames = _progress_seconds(out)
    out_time = None if secs is None else '%02d:%02d:%09.6f' % (secs // 3600, (secs % 3600) // 60, secs % 60)
    rec = {'exit_code': info['exit_code'], 'stderr': info.get('stderr', ''), 'frames': frames, 'out_time': out_time}
    if info['exit_code'] == 'timeout':
        verdict = _decode_verdict(0, round(secs or 0.0, 3), rec, {'requested': 'full', 'completed_to_eof': False, 'streams_selected': list(V2_STREAMS),
                                                                    'request_unmet': {'requested': 'full decode of the whole file', 'completed': 'the first %.1f s' % (secs or 0.0),
                                                                                      'reason': 'the %d s local decode limit was reached' % LOCAL_FULL_TIMEOUT_S}})
        return ToolResult('partial', verdict, mode='local')
    verdict = _decode_verdict(0, 'full', rec, {'completed_to_eof': info['exit_code'] == 0, 'streams_selected': list(V2_STREAMS)})
    return ToolResult('ok', verdict, mode='local')


LOCAL_FULL_TIMEOUT_S = 25   # unchanged limit of the local decode; a full request never raises it


def tool_decode_sample(args, ctx):
    at = _at(args)
    be = _backend(ctx, 'ffmpeg')
    if isinstance(be, ToolResult):
        return be
    v2 = ctx.tools_behavior == 'v2'
    if be == 'replay':
        rec = ctx.replay_rec['decode_sample']
        if _is_full(args):
            if v2 and 'full' not in rec:
                return ToolResult('unavailable', 'no recorded full decode for this item; nothing was run', mode='replay')
            return ToolResult('ok', _decode_verdict(0, 'full', rec['full']), mode='replay')
        keys = sorted(int(k) for k in rec if k.isdigit())
        k = max([x for x in keys if x <= at] or keys[:1])
        extra = {} if k == int(at) and at == int(at) else {'requested_at_s': at, 'note_window': 'replay serves the recorded window at ss=%d (recorded: %s)' % (k, keys)}
        return ToolResult('ok', _decode_verdict(k, rec[str(k)].get('t', 4), rec[str(k)], extra), mode='replay')
    if be == 'remote':
        if v2 and _is_full(args):
            # the remote sampler reads at most 8 MiB and runs 25 s: a whole-file decode is not possible there.  Run the window it can run and say so.
            info, out, err = _run_remote(ctx, 'decode', at=0.0)
            if err:
                return ToolResult('timeout' if err == 'timeout' else 'error', err, mode='remote')
            return ToolResult('partial', _decode_verdict(0.0, 4, info or {}, {'requested': 'full', 'completed_to_eof': False, 'streams_selected': ['0:v:0', '0:a:0'],
                                                                              'request_unmet': {'requested': 'full decode of the whole file', 'completed': 'a 4 s window at 0 s',
                                                                                                'reason': 'the remote sampler reads at most 8 MiB and runs 25 s'}}), mode='remote')
        info, out, err = _run_remote(ctx, 'decode', at=at)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err, mode='remote')
        return ToolResult('ok', _decode_verdict(at, 4, info or {}, {'streams_selected': ['0:v:0', '0:a:0']} if v2 else None), mode='remote')
    if v2 and _is_full(args):
        return _decode_full_local(ctx)
    info, out = _run_local(ctx, [ctx.which('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                 '-t', '4', '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-f', 'null', '-'])
    if info['exit_code'] == 'timeout':
        return ToolResult('timeout', 'decode timed out after 25 s', mode='local')
    return ToolResult('ok', _decode_verdict(at, 4, info, {'streams_selected': list(V2_STREAMS)} if v2 else None), mode='local')


def tool_frame_sample(args, ctx):
    at = _at(args)
    be = _backend(ctx, 'ffmpeg')
    if isinstance(be, ToolResult):
        return be
    name = 'frame@%g' % at
    if be == 'replay':
        pr = ctx.replay_rec.get('ffprobe', {})
        if pr.get('exit_code') not in (0, None):
            return ToolResult('error', {'exit_code': pr.get('exit_code'), 'stderr': pr.get('stderr', '')[:1000], 'note': 'no frame produced'}, mode='replay')
        if not any(x.get('codec_type') == 'video' for x in pr.get('streams', [])):
            return ToolResult('error', {'note': 'no frame produced: the file has no video stream'}, mode='replay')
        # no image is recorded; a virtual frame lets `ocr` serve the recorded title-card text
        ctx.frames[name] = None
        ctx.frame_t[name] = at
        return ToolResult('ok', {'frame': name, 'replay': True, 'note': 'no image is available in replay mode; call ocr with this frame to read the recorded on-screen text'}, mode='replay')
    if be == 'remote':
        info, png, err = _run_remote(ctx, 'frame', at=at)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err, mode='remote')
    else:
        info, png = _run_local(ctx, [ctx.which('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                     '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
        if info['exit_code'] == 'timeout':
            return ToolResult('timeout', 'frame extraction timed out', mode='local')
    if not png.startswith(b'\x89PNG'):
        return ToolResult('error', {'exit_code': (info or {}).get('exit_code'), 'stderr': ((info or {}).get('stderr') or '')[:1000], 'note': 'no frame produced'}, mode=be)
    path = ctx.scratch / (hashlib.sha256(png).hexdigest()[:16] + '.png')
    path.write_bytes(png)  # scratch only, never inside the committed run directory
    ctx.frames[name] = str(path)
    ctx.frame_t[name] = at
    width, height = struct.unpack('>II', png[16:24])
    return ToolResult('ok', {'frame': name, 'width': width, 'height': height, 'bytes': len(png), 'sha256': hashlib.sha256(png).hexdigest(),
                             'note': 'image kept in scratch; call ocr with this frame name to read text from it'}, mode=be)


def tool_audio_sample(args, ctx):
    at = _at(args)
    stream = int(_num(args, 'stream', 0, 0, 127))
    be = _backend(ctx, 'ffmpeg')
    if isinstance(be, ToolResult):
        return be
    if be == 'replay':
        return _audio_replay(ctx, at, stream)
    if be == 'remote':
        info, wav, err = _run_remote(ctx, 'audio', at=at, stream=stream)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err, mode='remote')
    else:
        info, wav = _run_local(ctx, [ctx.which('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                     '-t', '4', '-map', '0:%d' % stream, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'])
        if info['exit_code'] == 'timeout':
            return ToolResult('timeout', 'audio extraction timed out', mode='local')
    stats = wav_stats(wav)
    if stats is None:
        return ToolResult('error', {'exit_code': (info or {}).get('exit_code'), 'stderr': ((info or {}).get('stderr') or '')[:1000], 'note': 'no audio produced'}, mode=be)
    stats.update(at_s=at, stream=stream, note='signal statistics only; no speech recognition was run')
    return ToolResult('ok', stats, mode=be)


def _audio_replay(ctx, at, stream):
    """Recorded audio levels (probes/<fixture>.json `audio_sample`: {"<ss>": {rms_dbfs, peak_dbfs, silent_fraction, ...}}), else `unavailable`."""
    pr = ctx.replay_rec.get('ffprobe', {})
    if pr.get('exit_code') not in (0, None):
        return ToolResult('error', {'exit_code': pr.get('exit_code'), 'stderr': pr.get('stderr', '')[:1000], 'note': 'no audio produced'}, mode='replay')
    if pr.get('streams') is not None and not any(x.get('codec_type') == 'audio' for x in pr['streams']):
        return ToolResult('error', {'note': 'no audio produced: the file has no audio stream'}, mode='replay')
    rec = ctx.replay_rec.get('audio_sample')
    keys = sorted(int(k) for k in rec if str(k).isdigit()) if isinstance(rec, dict) else []
    if not keys:
        return ToolResult('unavailable', 'no recorded audio levels for this item (audio_sample was not recorded for it); nothing was run', mode='replay')
    k = max([x for x in keys if x <= at] or keys[:1])
    out = dict(rec[str(k)], at_s=float(k), stream=stream, note='replay: recorded signal statistics for the 4 s window at ss=%d; no speech recognition was run' % k)
    if k != at:
        out['requested_at_s'] = at
    return ToolResult('ok', out, mode='replay')


def wav_stats(data):
    """Level statistics of a 16-bit PCM WAV (stdlib).  None if it is not decodable audio."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getsampwidth() != 2:
                return None
            frames = w.readframes(w.getnframes())
            rate, ch = w.getframerate(), w.getnchannels()
    except (wave.Error, EOFError):
        return None
    samples = array.array('h')
    samples.frombytes(frames[:len(frames) // 2 * 2])
    n = len(samples)
    if not n:
        return {'samples': 0, 'duration_s': 0.0, 'rms_dbfs': None, 'peak_dbfs': None, 'silent_fraction': None}
    import math
    peak = max(abs(x) for x in samples)
    rms = math.sqrt(sum(x * x for x in samples) / n)
    win = max(1, rate // 10 * ch)
    silent = total = 0
    for i in range(0, n, win):
        chunk = samples[i:i + win]
        r = math.sqrt(sum(x * x for x in chunk) / len(chunk))
        total += 1
        silent += 1 if r < 32768 * 10 ** (-60 / 20) else 0
    db = lambda v: None if v <= 0 else round(20 * math.log10(v / 32768), 1)
    return {'samples': n, 'sample_rate': rate, 'duration_s': round(n / (rate * ch), 3), 'rms_dbfs': db(rms),
            'peak_dbfs': db(peak), 'silent_fraction': round(silent / total, 3)}


def tool_ocr(args, ctx):
    name = args.get('frame')
    if name is None and any(k in args for k in ('at', 't', 'ss')):
        # replay needs no frame; live paths take one first
        be = _backend(ctx, 'ffmpeg')
        if be == 'replay':
            return _ocr_replay(ctx, _at(args))
        fr = tool_frame_sample({'at': _at(args)}, ctx)
        if fr.status != 'ok':
            return fr
        name = fr.output['frame']
    if name not in ctx.frames:
        return ToolResult('error', 'unknown frame %r; call frame_sample first (known: %s)' % (name, sorted(ctx.frames)))
    if ctx.frames[name] is None:  # virtual replay frame
        be = _backend(ctx, 'ffmpeg')
        return _ocr_replay(ctx, ctx.frame_t[name]) if be == 'replay' else be
    if ctx.ocr_backend is None:
        return ToolResult('unavailable', 'no OCR backend configured for this run (tesseract is not installed; the harness needs --ocr-model); nothing was run')
    png = Path(ctx.frames[name]).read_bytes()
    readings = []
    for _ in range(2):
        try:
            readings.append(ctx.ocr_backend(png))
        except Exception as e:  # noqa: BLE001 - tool boundary: report, never crash the run
            return ToolResult('error', 'OCR backend failed: %s' % str(e)[:200])
    norm = [' '.join(r.split()) for r in readings]
    return ToolResult('ok', {'frame': name, 'readings': norm, 'consensus': norm[0] == norm[1],
                             'text': norm[0] if norm[0] == norm[1] else '',
                             'note': 'model-generated OCR; two readings must match exactly to be consensus. Not independent ground truth.'}, mode='live')


def _ocr_replay(ctx, t):
    rec = getattr(ctx, 'replay_rec', None)
    if rec is None:
        rec, err, status = _replay_record(ctx)
        if rec is None:
            return ToolResult(status, err)
        ctx.replay_rec = rec
    if 'frame_text' not in rec:
        return ToolResult('unavailable', 'no recorded on-screen text for this item; nothing was run', mode='replay')
    ft = rec['frame_text']
    text = next((e['text'] for e in ft if e['t0'] <= t < e['t1']), '') if isinstance(ft, list) else ''  # a string means no text was drawn
    note = 'replay: the on-screen text known from how the fixture was generated (not OCR, not a model reading); empty means no text at that time'
    out = {'t_s': t, 'text': text, 'consensus': True, 'note': note}
    # The suite author's construction note for a string frame_text stays in the run record only (ToolResult extra); the
    # model-visible output is what the call returned, as in v1.
    extra = {'recorded_note': ft} if isinstance(ft, str) else {}
    return ToolResult('ok', out, mode='replay', **extra)


def ollama_ocr_backend(model, api):
    """OCR through a vision-capable Ollama model (same prompt/schema as the av-identity increment)."""
    def run(png):
        body = {'model': model, 'stream': False, 'think': False, 'keep_alive': '2m', 'format': OCR_SCHEMA,
                'options': {'temperature': 0, 'seed': 42, 'num_ctx': 8192, 'num_predict': 128},
                'messages': [{'role': 'user', 'content': OCR_PROMPT, 'images': [base64.b64encode(png).decode()]}]}
        resp, receipt = api('/api/chat', body, timeout=120)
        if resp is None or resp.get('error'):
            raise RuntimeError((resp or {}).get('error') or receipt.get('exit_code'))
        return json.loads(resp['message']['content']).get('visible_text', '')
    return run


_epub = None


def _epub_module():
    global _epub
    if _epub is None:
        from . import vendored_epub
        _epub = vendored_epub
    return _epub


def _epub_stage(path):
    """Where does this EPUB break?  -> (stage, message) or None.  Stages follow the suite's recorded evidence:
    zip_open, zip_crc, opf_parse, manifest."""
    import posixpath
    import xml.etree.ElementTree as E
    import zipfile
    from urllib.parse import unquote, urlsplit
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:  # noqa: BLE001
        return 'zip_open', '%s: %s' % (type(e).__name__, str(e)[:200])
    with z:
        try:
            bad = z.testzip()
        except Exception as e:  # noqa: BLE001 - e.g. a truncated member
            return 'zip_crc', '%s: %s' % (type(e).__name__, str(e)[:200])
        if bad:
            return 'zip_crc', 'CRC mismatch in member %s' % bad
        try:
            root = E.fromstring(z.read('META-INF/container.xml'))
            opf = next(x.attrib['full-path'] for x in root.iter() if x.tag.endswith('rootfile'))
            package = E.fromstring(z.read(opf))
        except Exception as e:  # noqa: BLE001
            return 'opf_parse', '%s: %s' % (type(e).__name__, str(e)[:200])
        names = set(z.namelist())
        missing = []
        for x in package.iter():
            if x.tag.endswith('}item') and 'href' in x.attrib:
                p = posixpath.normpath(posixpath.join(posixpath.dirname(opf), unquote(urlsplit(x.attrib['href']).path)))
                if p not in names:
                    missing.append(p)
        if missing:
            return 'manifest', 'manifest names members that are not in the archive: %s' % missing[:5]
    return None


def tool_epub_inspect(args, ctx):
    if ctx.fixture.kind != 'local':
        return ToolResult('unavailable', 'no media fixture behind this case; the tool cannot run' if ctx.fixture.kind == 'none' else 'epub_inspect needs a local fixture; none is reachable for this case')
    path = ctx.fixture.path
    if not Path(path).is_file():
        return ToolResult('unavailable', 'fixture file missing; the tool cannot run')
    raw = Path(path).read_bytes()
    base = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    staged = _epub_stage(path)
    d = None
    if staged is None:
        try:
            d = _epub_module().inspect(path)
        except Exception as e:  # noqa: BLE001 - epub.py asserts on structural problems it checks itself
            staged = ('spine', '%s: %s' % (type(e).__name__, str(e)[:200]))
    if staged:
        # damage is a finding about the file, in the suite's recorded shape (status error)
        return ToolResult('error', dict(base, status='error', stage=staged[0], error=staged[1]))
    fields = _opf_fields(path, d['opf'])
    heads = [' '.join(s['text'].split()[:6]) for s in d['spine'][:3]]
    return ToolResult('ok', dict(base, status='ok', opf=d['opf'], dc_title=d['titles'], dc_creator=fields.get('creators', []),
                                 dc_language=fields.get('languages', []), dc_identifier=fields.get('identifiers', []),
                                 entries=_entry_count(path), spine_items=d['spine_items'], spine_characters=sum(s['characters'] for s in d['spine']),
                                 spine_heads=heads))


def _entry_count(path):
    import zipfile
    with zipfile.ZipFile(path) as z:
        return len(z.namelist())


def _opf_fields(path, opf):
    """Creators, languages and identifiers from the OPF (epub.py only reports titles)."""
    import zipfile
    import xml.etree.ElementTree as E
    try:
        with zipfile.ZipFile(path) as z:
            pkg = E.fromstring(z.read(opf))
    except Exception:  # noqa: BLE001 - epub.inspect already vouched for the OPF; stay defensive
        return {}
    pick = lambda name: [(x.text or '').strip() for x in pkg.iter() if x.tag.endswith('}' + name) and (x.text or '').strip()]
    return {'creators': pick('creator'), 'languages': pick('language'), 'identifiers': pick('identifier')}


def tool_arr_lookup(args, ctx):
    """STUB.  The harness has no read-only Sonarr/Radarr path (keys are not in this pod and every write is
    confined to packages/domain).  Serves only records the case itself carries: its pre-collected arr_lookup
    evidence, else context.arr."""
    recorded = [e for e in ctx.case.get('evidence', []) if e.get('tool') == 'arr_lookup']
    if recorded:
        outs = []
        for e in recorded:
            o = e.get('output')
            outs.append({'args': e.get('args'), 'record': o if isinstance(o, str) else json.dumps(o, sort_keys=True)})
        return ToolResult('ok', {'stub': True, 'records': outs, 'note': 'case-provided records only; no live arr call was made'}, mode='stub')
    arr = (ctx.case.get('context') or {}).get('arr')
    if not arr or not arr.get('app'):
        return ToolResult('ok', {'stub': True, 'arr': None, 'note': 'no arr record for this case'}, mode='stub')
    return ToolResult('ok', {'stub': True, 'arr': arr, 'note': 'case-provided context only; no live arr call was made'}, mode='stub')


# ---- live evidence mode (dev-c2) ----------------------------------------------------------------------------------------
def _live_unavailable(ctx, why):
    return ToolResult('unavailable', why + '; live evidence was not collected and nothing ran', mode='live', live_ran=False)


def _live_gate(tool, ctx):
    """None when live collection may run for this case, else the `unavailable` ToolResult (with the reason)."""
    kind = ctx.fixture.kind
    if kind == 'none':
        return _live_unavailable(ctx, 'no media fixture behind this case')
    if kind == 'pinned':
        return _live_unavailable(ctx, 'this case holds only a recorded observation of real library media; no local media path exists')
    if kind == 'remote':
        return _live_unavailable(ctx, 'the media is on a remote host; live collection needs a local media path')
    path = Path(ctx.fixture.path)
    if not path.exists():
        return _live_unavailable(ctx, 'the case names a local media path that does not exist')
    if tool != 'audiobook_inspect' and not path.is_file():
        return _live_unavailable(ctx, '%s needs one media file; the case path is not a regular file' % tool)
    return None


def _live_name_map(path):
    """Neutral names for every file and folder under a folder item, so no part name (it can encode the answer, or hold a class word) reaches
    the model: relative paths first, then folder names, then file names and stems.  -> [(name, replacement)] longest first."""
    root = Path(path)
    if not root.is_dir():
        return []
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        files += [Path(dirpath) / n for n in sorted(filenames)]
        if len(files) >= 1000:
            break
    pairs, dirs = {}, {}
    for i, f in enumerate(files[:1000], 1):
        repl = 'part-%02d%s' % (i, f.suffix)
        rel = f.relative_to(root)
        pairs[rel.as_posix()] = repl
        pairs[f.name] = repl
        if len(f.stem) >= 4 and not f.stem.isdigit():
            pairs[f.stem] = 'part-%02d' % i
        for d in rel.parts[:-1]:
            dirs.setdefault(d, 'folder-%02d' % (len(dirs) + 1))
    pairs.update(dirs)
    return sorted(pairs.items(), key=lambda kv: (-len(kv[0]), kv[0]))


def _live_bounds(tool, args, ctx):
    """-> (bounds for evidence.collect, args that were accepted but have no effect in live mode, bounds the harness cut)."""
    bounds = {'deadline_s': LIVE_DEADLINE_S}
    bounds.update(ctx.evidence_bounds)
    cut = []
    # the collector must end inside the tool timeout (the outer limit): a larger deadline is cut to it and said so
    if bounds['deadline_s'] > LIVE_DEADLINE_S:
        cut.append({'bound': 'deadline_s', 'requested': bounds['deadline_s'], 'used': LIVE_DEADLINE_S, 'by': 'harness tool timeout'})
        bounds['deadline_s'] = LIVE_DEADLINE_S
    ignored = []
    if tool in ('decode_sample', 'frame_sample', 'audio_sample', 'ocr'):
        for key in ('at', 'ss', 't'):
            if key in args and args[key] != 'full':
                _num(args, key, 0, 0, 86400 * 4)       # same argument check as replay: a bad number is a bad-arguments error
                ignored.append(key)
    if tool == 'audio_sample' and 'stream' in args:
        _num(args, 'stream', 0, 0, 127)
        ignored.append('stream')
    if tool == 'ocr' and 'frame' in args:
        ignored.append('frame')
    if tool == 'decode_sample':
        if _is_full(args):
            bounds['full_decode'] = True
    if tool == 'frame_sample':
        bounds['ocr'] = 'off'
    if tool == 'ocr':
        bounds['ocr'] = 'auto'
    return bounds, ignored, cut


def _sampled_offsets(obj, found=None):
    """Every `at_s` in a collector output (the windows or frames it actually sampled), sorted."""
    found = set() if found is None else found
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == 'at_s' and isinstance(v, (int, float)) and not isinstance(v, bool):
                found.add(round(float(v), 3))
            else:
                _sampled_offsets(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _sampled_offsets(v, found)
    return sorted(found)


def _unmet_requests(tool, args, ignored, rec):
    """Requests the live collector did not honor: [{arg, requested, sampled_at_s?, reason}].  A requested offset that falls inside a window the
    collector happened to sample is honored; anything else is not."""
    out = []
    sampled = _sampled_offsets(rec.get('output') or {})
    width = 0.5 if tool in ('frame_sample', 'ocr') else float((rec.get('bounds') or {}).get('segment_s') or 4)
    for key in ('at', 'ss', 't'):
        if key in ignored and key in args:
            at = float(args[key])
            if not any(s <= at < s + width for s in sampled):
                out.append({'arg': key, 'requested': at, 'sampled_at_s': sampled[:12]})
    if 'stream' in ignored and int(args.get('stream', 0)) != 0:
        out.append({'arg': 'stream', 'requested': int(args['stream'])})
    if 'frame' in ignored:
        out.append({'arg': 'frame', 'requested': 'a frame from an earlier call'})
    return out


def _request_note(unmet):
    """Generic text for the model: what was requested, that live collection did not honor it, and what was sampled instead."""
    parts = []
    for u in unmet:
        if u['arg'] in ('at', 'ss', 't'):
            where = ('; sampled instead at (seconds): %s' % ', '.join('%g' % s for s in u['sampled_at_s'])) if u.get('sampled_at_s') else '; no window was sampled'
            parts.append('the requested offset %g s was not honored (live collection chooses its own sample windows)%s' % (u['requested'], where))
        elif u['arg'] == 'stream':
            parts.append('the requested audio stream %s was not honored (live collection examines the first audio streams in order)' % u['requested'])
        else:
            parts.append('the requested frame name was not used (live collection keeps no frames between calls)')
    return '; '.join(parts)


def _live_extra(rec, ignored, unmet=(), cut=()):
    fp = rec.get('input') or {}
    if fp.get('kind') == 'files':   # per-part size and hashes, no names (a part name can encode the answer)
        fp = {'kind': 'files', 'count': fp.get('count'), 'partial_fingerprint_only': True,
              'files': [{k: v for k, v in f.items() if k != 'name'} for f in (fp.get('files') or [])]}
    else:
        fp = {k: v for k, v in fp.items() if k != 'name'}   # a file name can encode the answer; the sizes and hashes stay
    extra = {'evidence': {'kind': rec['tool'], 'status': rec['status'], 'coverage': rec['coverage'], 'reason': rec.get('reason'),
                          'cause': rec.get('cause'), 'tool_version': rec.get('tool_version'), 'bounds': rec.get('bounds'),
                          'bounds_clamped': rec.get('bounds_clamped'), 'input': fp, 'elapsed_s': rec.get('elapsed_s')}}
    if ignored:
        extra['args_ignored'] = ignored
    if unmet:
        extra['request_unmet'] = list(unmet)
    return extra


def live_tool(tool, args, ctx):
    """One live collection for `tool` on the case's local media file -> ToolResult.  Read-only; the file never comes from the model."""
    bad = _live_gate(tool, ctx)
    if bad:
        return bad
    bounds, ignored, cut = _live_bounds(tool, args, ctx)
    ctx.name_map = _live_name_map(ctx.fixture.path)
    ctx.live_thread = threading.get_ident()
    collect = ctx.collect or evcol.collect
    kw = {'coverage_union': True} if ctx.tools_behavior == 'v2' else {}
    recs = collect(ctx.fixture.path, [LIVE_KINDS[tool]], bounds, runner=ctx.evidence_runner, which=ctx.evidence_which, scratch_dir=ctx.scratch, cancel=ctx.cancel, **kw)
    rec = dict(recs[0])
    if cut:
        rec['bounds_clamped'] = list(rec.get('bounds_clamped') or []) + cut
    out_ = rec.get('output') or {}
    if tool == 'ocr' and rec['status'] in ('ok', 'partial') and isinstance(out_, dict) and out_.get('ocr') == 'unavailable':
        # the frames decoded, but reading text is what `ocr` is for and no OCR engine exists here: the capability is absent
        rec.update(status='unavailable', reason='no OCR engine is installed (tesseract not found on PATH); the on-screen text was not read'
                   + ('' if recs[0]['status'] == 'ok' else '; the frame collection was also partial'))
    unmet = _unmet_requests(tool, args, ignored, rec) if rec['status'] != 'unavailable' or tool == 'ocr' else []
    if unmet:
        rec['request_note'] = _request_note(unmet)
    tr = evcol.to_tool_result(rec, cap=ctx.output_cap or TOOL_OUTPUT_BYTES)
    extra = _live_extra(rec, ignored, unmet, cut)
    if ctx.tools_behavior == 'v2' and tr.get('truncated'):
        extra['collector_truncated'] = True   # the collector cut its own output; bounded() keeps that fact instead of recomputing it from the length
    return ToolResult(tr['status'], tr['output'], mode=tr['mode'], live_ran=rec['mode'] == 'live', **extra)


# ---- capability advertisement (evidence format v2) ----------------------------------------------------------------------
# What replay can actually return, before a tool is called: the backend, whether the call can run at all, the recorded offsets and whether a
# whole-file decode exists.  It reads no recorded RESULT (only which offsets / entries exist), so it cannot show a finding or the outcome of an
# operation that was not called.  It mirrors `_backend` without running anything.
def capability(ctx, name):
    cap = {'tool': name}
    live = ctx.evidence_mode == 'live' and name in LIVE_KINDS
    if name == 'arr_lookup':
        cap.update(backend='stub', available=True, note='case-provided records only')
        return cap
    if live:
        bad = _live_gate(name, ctx)
        cap['backend'] = 'live'
        if bad is not None:
            cap.update(available=False, why=bad.output)
            return cap
        cap['available'] = True
        if name in TIMED_TOOLS:
            cap['offsets_s'] = 'chosen by the collector; a requested offset is checked and not used'
        if name == 'decode_sample':
            cap['full_decode'] = 'on request, capped by size and time'
        return cap
    if ctx.fixture.kind == 'pinned':
        cap['backend'] = 'pinned_replay'
        recs = _recorded(ctx, name)
        if name == 'frame_sample':
            times = _recorded_times(ctx, 'ocr')
            cap.update(available=bool(times), offsets_s=times)
        elif name == 'ocr':
            times = _recorded_times(ctx, 'ocr')
            cap.update(available=bool(times), offsets_s=times)
        elif name in TIMED_TOOLS:
            times = _recorded_times(ctx, name)
            cap.update(available=bool(recs), offsets_s=times)
            if name == 'decode_sample':
                cap['full_decode'] = 'recorded' if any(_is_full(e.get('args') or {}) for _, e in recs) else 'not_recorded'
        else:
            cap['available'] = bool(recs)
        return cap
    bad = _need_media(ctx)
    if bad is not None:
        cap.update(backend=None, available=False, why=bad.output)
        return cap
    if name == 'epub_inspect':
        cap.update(backend='local', available=ctx.fixture.kind == 'local')
        return cap
    binary = 'ffprobe' if name in ('ffprobe', 'audiobook_inspect') else 'ffmpeg'
    if ctx.fixture.kind == 'remote':
        cap.update(backend='remote', available=True)
        if name == 'decode_sample':
            cap.update(window_s=4, full_decode='not_possible (the remote sampler reads at most 8 MiB and runs 25 s)' if ctx.tools_behavior == 'v2' else 'requested as a 4 s window')
        return cap
    if ctx.replay != 'force' and ctx.which(binary):
        cap.update(backend='local', available=True)
        if name == 'decode_sample':
            cap.update(window_s=4, full_decode='bounded run (%d s limit)' % LOCAL_FULL_TIMEOUT_S if ctx.tools_behavior == 'v2' else 'requested as a 4 s window')
        return cap
    cap['backend'] = 'replay'
    if ctx.replay == 'off':
        cap.update(available=False, why='%s is not installed in this environment and replay is disabled' % binary)
        return cap
    rec, err, _status = _replay_record(ctx)
    if rec is None:
        cap.update(available=False, why=err)
        return cap
    cap['available'] = True
    if name == 'decode_sample':
        dec = rec.get('decode_sample') or {}
        cap.update(offsets_s=sorted(int(k) for k in dec if str(k).isdigit()), window_s=4, full_decode='recorded' if 'full' in dec else 'not_recorded')
    elif name == 'audio_sample':
        aud = rec.get('audio_sample')
        offs = sorted(int(k) for k in aud if str(k).isdigit()) if isinstance(aud, dict) else []
        cap.update(available=bool(offs), offsets_s=offs)
        if not offs:
            cap['why'] = 'not recorded for this item'
    elif name == 'frame_sample':
        # independent operation metadata only: the recording exists.  Whether it holds a video stream is a property of an uncalled ffprobe RESULT and is not read here.
        cap.update(offsets_s='any', note='a frame exists only if the file has a video stream; that is known when the tool is called')
    elif name == 'ocr':
        ft = rec.get('frame_text')
        ranges = [[e.get('t0'), e.get('t1')] for e in ft if isinstance(e, dict)] if isinstance(ft, list) else []
        # the time ranges that have a recorded reading (metadata of the recording), never the text; an offset outside them returns an empty reading
        cap.update(available='frame_text' in rec, offsets_s='any', recorded_reading_ranges_s=ranges)
    return cap


def capabilities(ctx):
    """One advertisement per OFFERED tool, in the order the case lists them."""
    return [capability(ctx, name) for name in (ctx.case.get('tools_available') or []) if name in REGISTRY]


REGISTRY = {'ffprobe': tool_ffprobe, 'decode_sample': tool_decode_sample, 'frame_sample': tool_frame_sample,
            'audio_sample': tool_audio_sample, 'ocr': tool_ocr, 'epub_inspect': tool_epub_inspect,
            'audiobook_inspect': tool_audiobook_inspect, 'arr_lookup': tool_arr_lookup}


def _failure(mode, tool, real_result):
    if mode == 'error':
        return ToolResult('error', '%s failed: could not run' % tool, injected=True, mode='injected')
    if mode == 'timeout':
        return ToolResult('timeout', '%s exceeded the %d s tool timeout' % (tool, TOOL_TIMEOUT_S), injected=True, mode='injected')
    if mode == 'partial':
        text = real_result.output if isinstance(real_result.output, str) else json.dumps(real_result.output, sort_keys=True, ensure_ascii=False)
        return ToolResult('partial', text[:max(1, len(text) // 2)] + ' ...[output cut off]', injected=True, mode='injected')
    raise ValueError('unknown failure mode %r' % mode)


def _stop_collector(ctx, fut):
    """The outer tool timeout fired on a live collection: stop it so the next call starts alone (runs stay serial).  No further subprocess
    is started (cancel), the one running is killed with its process group, and the collector thread is given a moment to return."""
    ctx.cancel.set()
    for _ in range(50):   # the thread may not have started its child yet, or may start one between two checks
        if ctx.live_thread is not None:
            evcol.kill_active(ctx.live_thread)
        try:
            fut.result(timeout=0.1)
            return
        except concurrent.futures.TimeoutError:
            continue
        except Exception:  # noqa: BLE001 - whatever the collector raised after being stopped is not the run's concern
            return


def call_tool(ctx, name, args):
    """Run one tool call; always returns a bounded dict {status, output, truncated, wall_s, ...}.  Never raises."""
    started = time.monotonic()
    inject = ctx.case.get('inject_tool_failure')
    offered = ctx.case.get('tools_available') or []
    if name not in REGISTRY or name not in offered:
        # the capability is absent for this case: `unavailable`, and the call itself is a protocol violation (recorded by the runner)
        res = ToolResult('unavailable', 'tool %s is not offered for this case; nothing ran. Offered: %s' % (repr(name) if name in REGISTRY else 'requested', ', '.join(offered) or 'none'),
                         protocol_violation='tool_not_offered')
    elif inject and inject.get('tool') == name and inject.get('mode', 'error') in ('error', 'timeout'):
        res = _failure(inject['mode'], name, None)  # nothing is run: the failure is the whole result
    else:
        def work():
            if ctx.evidence_mode == 'live' and name in LIVE_KINDS:
                return live_tool(name, args, ctx)
            if ctx.fixture.kind == 'pinned' and name != 'arr_lookup':
                return _pinned(name, args, ctx)
            return REGISTRY[name](args, ctx)
        ctx.cancel = threading.Event() if ctx.evidence_mode == 'live' else None
        ctx.live_thread = None
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        fut = pool.submit(work)
        try:
            res = fut.result(timeout=TOOL_TIMEOUT_S + 5)
        except concurrent.futures.TimeoutError:
            res = ToolResult('timeout', '%s exceeded the %d s tool timeout' % (name, TOOL_TIMEOUT_S))
            if ctx.cancel is not None:
                _stop_collector(ctx, fut)
        except ValueError as e:
            res = ToolResult('error', 'bad arguments: %s' % e)
        except Exception as e:  # noqa: BLE001 - tool boundary
            res = ToolResult('error', 'tool crashed: %s: %s' % (type(e).__name__, str(e)[:200]))
        finally:
            pool.shutdown(wait=False)
        if inject and inject.get('tool') == name:
            res = _failure(inject.get('mode', 'error'), name, res)
    out = res.bounded(ctx.redact, cap=ctx.output_cap, keep_raw=True) if ctx.keep_raw else res.bounded(ctx.redact, cap=ctx.output_cap)
    out['evidence_mode'] = ctx.evidence_mode   # record only; result_message (what the model sees) never carries it
    out['wall_s'] = round(time.monotonic() - started, 3)
    return out
