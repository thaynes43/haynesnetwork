"""Read-only evidence tools.  The model chooses a tool and numeric arguments only; the file always comes
from the case fixture, never from model arguments.  Every tool returns a ToolResult whose text is bounded
(8 KiB) and which finishes inside the tool timeout (60 s).

Reuse (see README provenance table):
  epub_inspect     -> .agents/context/media-repair-actual-epub-2026-10-18/epub.py (imported by path)
  remote ffprobe / decode / frame / audio -> remote_sampler.py, copied from media-repair-av-2026-10-18/sample_remote.py
  ocr              -> consensus rule of media-repair-av-identity-2026-10-18 (two readings, exact equality
                      after whitespace normalisation), prompt and schema from its ocr-config.json
  ollama transport -> ollama_transport.py
"""
import array
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import time
import wave
import io
import concurrent.futures
from pathlib import Path

from protocol import TOOL_OUTPUT_BYTES, TOOL_TIMEOUT_S

HERE = Path(__file__).resolve().parent
CONTEXT = HERE.parents[1]  # .agents/context
EPUB_MODULE = CONTEXT / 'media-repair-actual-epub-2026-10-18' / 'epub.py'
REMOTE_SAMPLER = HERE / 'remote_sampler.py'
OCR_PROMPT = ('Transcribe only readable text literally visible in this image. If there is no readable text, '
              'return an empty string. Do not name objects, infer the episode, or guess. Return only the schema object.')
OCR_SCHEMA = {'type': 'object', 'properties': {'visible_text': {'type': 'string', 'maxLength': 256}},
              'required': ['visible_text'], 'additionalProperties': False}


class ToolResult:
    def __init__(self, status, output, **extra):
        assert status in ('ok', 'partial', 'error', 'timeout')
        self.status, self.output, self.extra = status, output, extra

    def bounded(self):
        text = self.output if isinstance(self.output, str) else json.dumps(self.output, sort_keys=True, ensure_ascii=False)
        raw = text.encode('utf-8')
        truncated = len(raw) > TOOL_OUTPUT_BYTES
        if truncated:
            marker = ' ...[truncated]'
            text = raw[:TOOL_OUTPUT_BYTES - len(marker.encode())].decode('utf-8', errors='ignore') + marker
        return {'status': self.status, 'output': text, 'truncated': truncated, **self.extra}


class Fixture:
    """local: a file path.  remote: kubectl-exec target.  none: no media behind the case."""

    def __init__(self, kind, path=None, namespace=None, deploy=None, container='app', sha256=None):
        self.kind, self.path, self.namespace, self.deploy, self.container, self.sha256 = kind, path, namespace, deploy, container, sha256

    @classmethod
    def from_case(cls, case, suite_dir):
        fx = case.get('fixture') or {'kind': 'none'}
        kind = fx.get('kind', 'none')
        if kind == 'none':
            return cls('none')
        loc = fx.get('locator') or ''
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
            return {'kind': self.kind, 'verified': 'declared_only' if self.kind == 'remote' else 'n/a',
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


class Context:
    def __init__(self, case, fixture, scratch, runner=subprocess.run, which=shutil.which, ocr_backend=None,
                 sleep_ok=True):
        self.case, self.fixture, self.scratch = case, fixture, Path(scratch)
        self.runner, self.which, self.ocr_backend = runner, which, ocr_backend
        self.frames = {}  # name -> path
        self.scratch.mkdir(parents=True, exist_ok=True)


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
        return ToolResult('error', 'no media fixture behind this case; tool cannot run')
    if ctx.fixture.kind == 'local' and not Path(ctx.fixture.path).is_file():
        return ToolResult('error', 'fixture file missing')
    return None


def _probe(ctx, remote_mode, with_chapters):
    bad = _need_media(ctx)
    if bad:
        return bad
    if ctx.fixture.kind == 'remote':
        info, out, err = _run_remote(ctx, remote_mode)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err)
        if info and info.get('exit_code') not in (0, None):
            return ToolResult('error', {'ffprobe_exit': info.get('exit_code'), 'stderr': info.get('stderr', '')[:1500]})
        try:
            data = json.loads(out.decode())
        except ValueError:
            return ToolResult('error', 'ffprobe returned no JSON')
        return ToolResult('ok', data, source='remote')
    ffprobe = _local_bin(ctx, 'ffprobe')
    if not ffprobe:
        return ToolResult('error', 'ffprobe is not installed in this environment')
    entries = ('format=format_name,duration,size,bit_rate:format_tags:stream=index,codec_name,codec_type,'
               'profile,pix_fmt,width,height,channels,channel_layout,sample_rate,duration,bit_rate:stream_tags=language,title')
    argv = [ffprobe, '-v', 'error', '-threads', '1']
    if with_chapters:
        argv.append('-show_chapters')
    argv += ['-show_entries', entries, '-of', 'json', ctx.fixture.path]
    info, out = _run_local(ctx, argv)
    if info['exit_code'] == 'timeout':
        return ToolResult('timeout', 'ffprobe timed out')
    if info['exit_code'] != 0:
        # A damaged container is a finding, not a tool failure: report what ffprobe said.
        return ToolResult('ok', {'ffprobe_exit': info['exit_code'], 'stderr': info['stderr'][:1500]}, source='local')
    try:
        return ToolResult('ok', json.loads(out.decode()), source='local')
    except ValueError:
        return ToolResult('error', 'ffprobe returned no JSON')


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
               'chapters': [{'id': c.get('id'), 'start_s': _float(c.get('start_time')), 'end_s': _float(c.get('end_time')),
                             'title': (c.get('tags') or {}).get('title')} for c in chapters[:60]]}
    if len(chapters) > 60:
        summary['chapters_omitted'] = len(chapters) - 60
    return ToolResult('ok', summary, source=res.extra.get('source'))


def _float(x):
    try:
        return round(float(x), 3)
    except (TypeError, ValueError):
        return None


def tool_decode_sample(args, ctx):
    at = _num(args, 'at', 0, 0, 86400 * 4)
    bad = _need_media(ctx)
    if bad:
        return bad
    if ctx.fixture.kind == 'remote':
        info, out, err = _run_remote(ctx, 'decode', at=at)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err)
    else:
        ffmpeg = _local_bin(ctx, 'ffmpeg')
        if not ffmpeg:
            return ToolResult('error', 'ffmpeg is not installed in this environment')
        info, out = _run_local(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                     '-t', '4', '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-f', 'null', '-'])
        if info['exit_code'] == 'timeout':
            return ToolResult('timeout', 'decode timed out after 25 s')
    info = info or {}
    result = {'at_s': at, 'window_s': 4, 'exit_code': info.get('exit_code'), 'stderr': (info.get('stderr') or '')[:1500],
              'quota_exhausted': bool(info.get('quota_exhausted')), 'clean': info.get('exit_code') == 0 and not (info.get('stderr') or '').strip() and not info.get('quota_exhausted')}
    result['note'] = 'A clean sample does not prove whole-file health; a quota-limited sample does not prove corruption.'
    return ToolResult('ok', result)


def tool_frame_sample(args, ctx):
    at = _num(args, 'at', 0, 0, 86400 * 4)
    bad = _need_media(ctx)
    if bad:
        return bad
    if ctx.fixture.kind == 'remote':
        info, png, err = _run_remote(ctx, 'frame', at=at)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err)
    else:
        ffmpeg = _local_bin(ctx, 'ffmpeg')
        if not ffmpeg:
            return ToolResult('error', 'ffmpeg is not installed in this environment')
        info, png = _run_local(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                     '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
        if info['exit_code'] == 'timeout':
            return ToolResult('timeout', 'frame extraction timed out')
    if not png.startswith(b'\x89PNG'):
        return ToolResult('error', {'exit_code': (info or {}).get('exit_code'), 'stderr': ((info or {}).get('stderr') or '')[:1000], 'note': 'no frame produced'})
    name = 'frame@%g' % at
    path = ctx.scratch / (hashlib.sha256(png).hexdigest()[:16] + '.png')
    path.write_bytes(png)  # scratch only, never inside the committed run directory
    ctx.frames[name] = str(path)
    width, height = struct.unpack('>II', png[16:24])
    return ToolResult('ok', {'frame': name, 'width': width, 'height': height, 'bytes': len(png),
                             'sha256': hashlib.sha256(png).hexdigest(),
                             'note': 'image kept in scratch; call ocr with this frame name to read text from it'})


def tool_audio_sample(args, ctx):
    at = _num(args, 'at', 0, 0, 86400 * 4)
    stream = int(_num(args, 'stream', 0, 0, 127))
    bad = _need_media(ctx)
    if bad:
        return bad
    if ctx.fixture.kind == 'remote':
        info, wav, err = _run_remote(ctx, 'audio', at=at, stream=stream)
        if err:
            return ToolResult('timeout' if err == 'timeout' else 'error', err)
    else:
        ffmpeg = _local_bin(ctx, 'ffmpeg')
        if not ffmpeg:
            return ToolResult('error', 'ffmpeg is not installed in this environment')
        info, wav = _run_local(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(at), '-i', ctx.fixture.path,
                                     '-t', '4', '-map', '0:%d' % stream, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'])
        if info['exit_code'] == 'timeout':
            return ToolResult('timeout', 'audio extraction timed out')
    stats = wav_stats(wav)
    if stats is None:
        return ToolResult('error', {'exit_code': (info or {}).get('exit_code'), 'stderr': ((info or {}).get('stderr') or '')[:1000], 'note': 'no audio produced'})
    stats.update(at_s=at, stream=stream, note='signal statistics only; no speech recognition was run')
    return ToolResult('ok', stats)


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
    if name is None and 'at' in args:
        fr = tool_frame_sample({'at': args['at']}, ctx)
        if fr.status != 'ok':
            return fr
        name = fr.output['frame']
    if name not in ctx.frames:
        return ToolResult('error', 'unknown frame %r; call frame_sample first (known: %s)' % (name, sorted(ctx.frames)))
    if ctx.ocr_backend is None:
        return ToolResult('error', 'no OCR backend configured for this run (tesseract is not installed; pass --ocr-model)')
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
                             'note': 'model-generated OCR; two readings must match exactly to be consensus. Not independent ground truth.'})


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
        spec = importlib.util.spec_from_file_location('mrh_epub', EPUB_MODULE)
        _epub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_epub)
    return _epub


def tool_epub_inspect(args, ctx):
    if ctx.fixture.kind != 'local':
        return ToolResult('error', 'epub_inspect needs a local fixture' if ctx.fixture.kind == 'remote' else 'no media fixture behind this case; tool cannot run')
    path = ctx.fixture.path
    if not Path(path).is_file():
        return ToolResult('error', 'fixture file missing')
    raw = Path(path).read_bytes()
    base = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    try:
        d = _epub_module().inspect(path)
    except Exception as e:  # noqa: BLE001 - epub.py asserts on damage; damage is a finding
        return ToolResult('ok', dict(base, valid=False, problem='%s: %s' % (type(e).__name__, str(e)[:300])))
    excerpt = int(_num(args, 'excerpt_chars', 200, 0, 600))
    spine = d['spine']
    out = dict(base, valid=True, zip_crc_ok=d['zip_crc_ok'], opf=d['opf'], titles=d['titles'],
               manifest_items=d['manifest_items'], spine_items=d['spine_items'],
               spine=[{'entry': s['entry'], 'characters': s['characters'], 'excerpt': s['text'][:excerpt]} for s in spine[:12]])
    if len(spine) > 12:
        out['spine_omitted'] = len(spine) - 12
    return ToolResult('ok', out)


def tool_arr_lookup(args, ctx):
    """STUB.  The harness has no read-only Sonarr/Radarr path (keys are not in this pod and every write is
    confined to packages/domain).  Returns only the arr context the case itself carries."""
    arr = (ctx.case.get('context') or {}).get('arr')
    if not arr or not arr.get('app'):
        return ToolResult('ok', {'stub': True, 'arr': None, 'note': 'no arr record for this case'})
    return ToolResult('ok', {'stub': True, 'arr': arr, 'note': 'case-provided context only; no live arr call was made'})


REGISTRY = {'ffprobe': tool_ffprobe, 'decode_sample': tool_decode_sample, 'frame_sample': tool_frame_sample,
            'audio_sample': tool_audio_sample, 'ocr': tool_ocr, 'epub_inspect': tool_epub_inspect,
            'audiobook_inspect': tool_audiobook_inspect, 'arr_lookup': tool_arr_lookup}


def _failure(mode, tool, real_result):
    if mode == 'error':
        return ToolResult('error', 'injected failure: %s could not run (simulated tool error)' % tool, injected=True)
    if mode == 'timeout':
        return ToolResult('timeout', 'injected failure: %s exceeded the %d s tool timeout (simulated)' % (tool, TOOL_TIMEOUT_S), injected=True)
    if mode == 'partial':
        text = real_result.output if isinstance(real_result.output, str) else json.dumps(real_result.output, sort_keys=True, ensure_ascii=False)
        return ToolResult('partial', text[:max(1, len(text) // 2)] + ' ...[output cut off by injected partial failure]', injected=True)
    raise ValueError('unknown failure mode %r' % mode)


def call_tool(ctx, name, args):
    """Run one tool call; always returns a bounded dict {status, output, truncated, wall_s, ...}.  Never raises."""
    started = time.monotonic()
    inject = ctx.case.get('inject_tool_failure')
    if name not in REGISTRY or name not in ctx.case.get('tools_available', []):
        res = ToolResult('error', 'tool %r is not available for this case' % name)
    elif inject and inject.get('tool') == name and inject.get('mode', 'error') in ('error', 'timeout'):
        res = _failure(inject['mode'], name, None)  # nothing is run: the failure is the whole result
    else:
        def work():
            return REGISTRY[name](args, ctx)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        fut = pool.submit(work)
        try:
            res = fut.result(timeout=TOOL_TIMEOUT_S + 5)
        except concurrent.futures.TimeoutError:
            res = ToolResult('timeout', '%s exceeded the %d s tool timeout' % (name, TOOL_TIMEOUT_S))
        except ValueError as e:
            res = ToolResult('error', 'bad arguments: %s' % e)
        except Exception as e:  # noqa: BLE001 - tool boundary
            res = ToolResult('error', 'tool crashed: %s: %s' % (type(e).__name__, str(e)[:200]))
        finally:
            pool.shutdown(wait=False)
        if inject and inject.get('tool') == name:
            res = _failure(inject.get('mode', 'error'), name, res)
    out = res.bounded()
    out['wall_s'] = round(time.monotonic() - started, 3)
    return out
