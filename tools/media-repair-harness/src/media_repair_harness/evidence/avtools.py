"""ffprobe / ffmpeg collectors: probe, decode, frames, audio, audiobook.  See README.md for the record shape."""
import hashlib
import json
import os
import re
import struct
from pathlib import Path

from .core import Deadline, make_record, tool_error, unavailable, used_bounds

AUDIO_EXT = ('.m4b', '.m4a', '.mp3', '.flac', '.ogg', '.opus', '.aac', '.wav', '.wma', '.mka', '.mp4')
PROBE_BOUNDS = ('timeout_s', 'max_stdout_bytes', 'max_stderr_bytes', 'stderr_excerpt_bytes')
DECODE_BOUNDS = PROBE_BOUNDS + ('deadline_s', 'segments', 'segment_s', 'max_segments', 'full_decode', 'full_max_bytes', 'full_timeout_s')
FRAME_BOUNDS = PROBE_BOUNDS + ('deadline_s', 'frames', 'frame_width', 'ocr', 'ocr_timeout_s', 'ocr_max_chars')
AUDIO_BOUNDS = PROBE_BOUNDS + ('deadline_s', 'segments', 'segment_s', 'max_segments', 'max_audio_streams', 'silence_noise_db', 'silence_min_s')
BOOK_BOUNDS = PROBE_BOUNDS + ('deadline_s', 'max_files', 'audiobook_segments', 'audiobook_segment_s', 'max_segments')

WHITELIST = ['-protocol_whitelist', 'file,pipe']  # input option: only local files and pipes, never concat:, http:, tcp: and friends


def _in(path):
    """Input arguments for ffmpeg/ffprobe: protocol whitelist, then `-i` and an ABSOLUTE path (so it cannot be read as an option or a protocol)."""
    return WHITELIST + ['-i', os.path.abspath(str(path))]


NEVER_PROVES = 'a clean sample does not prove whole-file health'


def _f(x, nd=3):
    try:
        return round(float(x), nd)
    except (TypeError, ValueError):
        return None


def _num(text):
    if text is None:
        return None
    t = text.strip().lower()
    if t in ('-inf', 'inf'):
        return float('-inf') if t.startswith('-') else float('inf')
    return _f(t, 2)


def _clip(s, n=200):
    s = ' '.join((s or '').split())
    return s if len(s) <= n else s[:n] + '...'


def _lines(b):
    return [l for l in (b.decode('utf-8', 'replace') if isinstance(b, bytes) else b).splitlines() if l.strip()]


LIVE1_ERROR_LINES = 3        # every behaviour keeps at most 3 diagnostic lines per window ...
LIVE_LINE_CHARS = 160        # ... each shown in at most 160 characters plus a 3-character cut marker (_clip): 163 characters
# live-2 keeps that budget exactly (at most 3 lines of at most 163 characters per window), so a live-2 window never holds more text than live-1's largest
_ELIDE_HEADS = (24, 48, 80)


def _shown_forms(line):
    """The ways a window may show one diagnostic line within the 163-character budget, live-1's own clip first (`_clip(line, 160)`, exactly): then the start
    and the end of the line with ' ... ' between them (the decoration a classifier strips stands at the start, the message at the end), then the end alone
    after '... '.  Every form is at most 163 characters."""
    t = ' '.join(line.split())
    if len(t) <= LIVE_LINE_CHARS:
        return [t]
    budget = LIVE_LINE_CHARS + 3
    return [t[:LIVE_LINE_CHARS] + '...'] + [t[:h] + ' ... ' + t[-(budget - h - 5):] for h in _ELIDE_HEADS] + ['... ' + t[-(budget - 4):]]


def kept_error_lines(lines):
    """Live collector behaviour live-2: -> the diagnostic lines a window keeps, from its COMPLETE (scrubbed, uncut) lines, within live-1's budget of 3 lines of
    at most 163 characters.  Each line is classified whole, before it is cut, by the diagnostic allow-list (evidence_v2.classify_line under `diag-1`, whose
    damage set contains every later rule set's; the typed layer classifies the kept text again under its own rules):

    * the first 3 lines are kept, as under live-1, each shown as live-1 shows it (`_clip(line, 160)`) unless the line is damage whole and that cut hides it:
      then it is shown in the first other form (_shown_forms) that still reads as damage;
    * only when none of those 3 shows damage, the first later line that is damage (and has such a form) takes the place of the third line.

    So located damage printed after start-up warnings, or behind a long decoration, stays recognisable, and a window holds no more text than live-1 allows.
    The count of every line (`error_lines`, `problem_lines`) is unchanged, so the record still says how many lines were not kept."""
    from .. import evidence_v2 as EV2       # (lazy: the typed layer's allow-lists; it imports nothing from the collectors)
    with EV2.diagnostic_rules('diag-1'):
        def show(line):
            forms = _shown_forms(line)
            if len(forms) > 1 and EV2.classify_line(line) == 'damage':
                for f in forms:
                    if EV2.classify_line(f) == 'damage':
                        return f, True
            return forms[0], EV2.classify_line(forms[0]) == 'damage'

        head = [show(l) for l in lines[:LIVE1_ERROR_LINES]]
        if len(lines) <= LIVE1_ERROR_LINES or any(d for _f, d in head):
            return [f for f, _d in head]
        seen = set(lines[:LIVE1_ERROR_LINES])
        for line in lines[LIVE1_ERROR_LINES:]:
            if line in seen:
                continue
            seen.add(line)
            if EV2.classify_line(line) == 'damage':
                shown, visible = show(line)
                if visible:
                    return [f for f, _d in head[:LIVE1_ERROR_LINES - 1]] + [shown]
        return [f for f, _d in head]


# ------------------------------------------------------------------ probe core (shared)

def probe_file(ctx, path, deadline):
    """ffprobe one file -> {'state': ok|error|timeout|unavailable, 'data': parsed JSON, 'rc', 'stderr', 'reason', 'cause', 'elapsed_s'}.
    Cached per path for the life of the collect() call."""
    key = ('probe', str(path))
    if key in ctx.cache:
        return ctx.cache[key]
    exe = ctx.binary('ffprobe')
    if not exe:
        res = {'state': 'unavailable', 'reason': 'ffprobe not found on PATH', 'data': None, 'stderr': '', 'elapsed_s': 0.0}
    else:
        argv = [exe, '-v', 'error', '-threads', '1', '-probesize', '5000000', '-analyzeduration', '2000000',
                '-show_format', '-show_streams', '-show_chapters', '-of', 'json'] + _in(path)
        r = ctx.run(argv, deadline=deadline)
        stderr = ctx.excerpt(r.stderr)
        if r.error:
            res = {'state': 'error', 'cause': 'tool', 'reason': 'could not start ffprobe: %s' % ctx.scrub(r.error), 'data': None,
                   'stderr': '', 'elapsed_s': r.elapsed_s}
        elif r.file_size_limit or r.stdout_truncated:  # before the exit code: a SIGXFSZ kill is the collector's cap, not a damaged file
            res = {'state': 'error', 'cause': 'tool', 'rc': r.returncode,
                   'reason': 'ffprobe output hit the %d byte cap (max_stdout_bytes); the file was not judged' % ctx.bounds['max_stdout_bytes'],
                   'data': None, 'stderr': stderr, 'elapsed_s': r.elapsed_s}
        elif r.timed_out:
            res = {'state': 'timeout', 'reason': 'ffprobe exceeded %ss' % ctx.bounds['timeout_s'], 'data': None, 'stderr': stderr, 'elapsed_s': r.elapsed_s}
        elif r.returncode != 0:
            res = {'state': 'error', 'cause': 'input', 'rc': r.returncode, 'reason': 'ffprobe exited %s: the container could not be read' % r.returncode,
                   'data': None, 'stderr': stderr, 'elapsed_s': r.elapsed_s}
        else:
            try:
                data = json.loads(r.stdout.decode('utf-8', 'replace'))
                if not isinstance(data, dict):
                    raise ValueError('not an object')
                res = {'state': 'ok', 'rc': 0, 'data': data, 'stderr': stderr, 'elapsed_s': r.elapsed_s}
            except ValueError:
                res = {'state': 'error', 'cause': 'tool', 'reason': 'ffprobe printed no parsable JSON', 'data': None, 'stderr': stderr, 'elapsed_s': r.elapsed_s}
    ctx.cache[key] = res
    return res


def condense(data):
    fmt = data.get('format') or {}
    tags = {k.lower(): _clip(str(v), 200) for k, v in (fmt.get('tags') or {}).items()}
    streams = []
    for s in (data.get('streams') or [])[:32]:
        t = s.get('tags') or {}
        item = {'index': s.get('index'), 'type': s.get('codec_type'), 'codec': s.get('codec_name'), 'profile': s.get('profile'),
                'pix_fmt': s.get('pix_fmt'), 'width': s.get('width'), 'height': s.get('height'), 'channels': s.get('channels'),
                'channel_layout': s.get('channel_layout'), 'sample_rate': s.get('sample_rate'), 'duration_s': _f(s.get('duration')),
                'bit_rate': s.get('bit_rate'), 'language': t.get('language') or t.get('LANGUAGE'),
                'title': _clip(t.get('title') or t.get('TITLE'), 120) or None}
        streams.append({k: v for k, v in item.items() if v is not None})
    chapters = []
    for c in (data.get('chapters') or []):  # all of them: the findings need the whole list, only the output is cut
        ct = c.get('tags') or {}
        chapters.append({'start_s': _f(c.get('start_time')), 'end_s': _f(c.get('end_time')), 'title': _clip(ct.get('title') or ct.get('TITLE'), 120) or None})
    return {'format': fmt.get('format_name'), 'duration_s': _f(fmt.get('duration')), 'bytes': _f(fmt.get('size'), 0),
            'bit_rate': fmt.get('bit_rate'), 'tags': tags, 'streams': streams, 'stream_count': len(data.get('streams') or []),
            'chapter_count': len(data.get('chapters') or []), 'chapters': chapters}


def _duration(p):
    return _f(((p.get('data') or {}).get('format') or {}).get('duration')) if p.get('state') == 'ok' else None


def _stream_types(p):
    return [s.get('codec_type') for s in ((p.get('data') or {}).get('streams') or [])] if p.get('state') == 'ok' else None


# ------------------------------------------------------------------ probe

def collect_probe(ctx, started):
    deadline = Deadline(ctx.bounds['deadline_s'], ctx.clock)
    b = used_bounds(ctx, PROBE_BOUNDS)
    if not ctx.binary('ffprobe'):
        return unavailable('probe', ctx, started, 'ffprobe', ['container, streams, duration and tags'])
    p = probe_file(ctx, ctx.path, deadline)
    ver = ctx.version('ffprobe')
    not_verified = ['stream contents: nothing was decoded', 'stream changes beyond the first ~5 MB analysed (probesize 5000000)']
    if p['state'] == 'ok':
        out = condense(p['data'])
        if len(out['chapters']) > 200:
            out['chapters_omitted'] = len(out['chapters']) - 200
            out['chapters'] = out['chapters'][:200]
        findings = []
        if not out['streams']:
            findings.append('the container lists no streams')
        if out['duration_s'] is None:
            findings.append('no container duration reported')
        if p['stderr']:
            findings.append('ffprobe wrote warnings to stderr')
        out['findings'] = findings
        return make_record('probe', 'live', 'ok', ctx, started, version=ver, bounds_used=b, stderr=p['stderr'], output=out,
                           coverage={'verified': ['container and stream headers parse', 'stream list, duration, tags, chapters as declared by the container'],
                                     'not_verified': not_verified})
    status = {'timeout': 'timeout', 'unavailable': 'unavailable'}.get(p['state'], 'error')
    return make_record('probe', 'live', status, ctx, started, version=ver, bounds_used=b, stderr=p['stderr'], reason=p.get('reason'), cause=p.get('cause'),
                       output={'exit_code': p.get('rc')} if p.get('rc') is not None else {},
                       coverage={'verified': [], 'not_verified': ['container, streams, duration and tags (ffprobe %s)' % p['state']] + not_verified})


# ------------------------------------------------------------------ decode

def segment_offsets(duration, interior, seg_s, max_segments):
    """Head, tail and `interior` evenly spread offsets.  Unknown duration -> head only."""
    if not duration or duration <= 0:
        return [0.0]
    tail = max(0.0, round(duration - seg_s, 3))
    if tail <= 0:
        return [0.0]
    inner = sorted({round(min(duration * i / (interior + 1), tail), 3) for i in range(1, int(interior) + 1)})
    keep = [0.0]
    for o in inner:  # an interior segment that would mostly overlap head or tail is dropped; head and tail always stay
        if o - keep[-1] >= seg_s / 2 and tail - o >= seg_s / 2:
            keep.append(o)
    if len(keep) + 1 > max_segments:  # thin the interior
        mid = keep[1:]
        step = len(mid) / float(max_segments - 2)
        keep = [0.0] + [mid[int(i * step)] for i in range(max(0, max_segments - 2))]
    return keep + [tail]


def _progress(stdout):
    """frame count and decoded seconds from `-progress pipe:1`."""
    frames = decoded = None
    for line in _lines(stdout):
        k, _, v = line.partition('=')
        v = v.strip()
        if k == 'frame' and v.isdigit():
            frames = int(v)
        elif k == 'out_time_us' and v.lstrip('-').isdigit():
            decoded = int(v) / 1e6
        elif k == 'out_time_ms' and decoded is None and v.lstrip('-').isdigit():
            decoded = int(v) / 1e6
    return frames, decoded


def decode_window(ctx, path, at, window, deadline, audio_only=False, timeout_s=None):
    """One bounded decode of `window` seconds at `at` (None = the whole file) to the null muxer."""
    argv = [ctx.binary('ffmpeg'), '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-threads', '1']
    if at is not None:
        argv += ['-ss', '%g' % at]
    argv += _in(path)
    if window is not None:
        argv += ['-t', '%g' % window]
    argv += (['-map', '0:a:0', '-vn'] if audio_only else ['-map', '0:v:0?', '-map', '0:a:0?']) + ['-sn', '-dn', '-f', 'null', '-']
    r = ctx.run(argv, timeout_s=timeout_s, deadline=deadline)
    seg = {'at_s': at, 'window_s': window, 'elapsed_s': round(r.elapsed_s, 3)}
    if r.error:
        seg.update(state='spawn_error', error=ctx.scrub(r.error))
        return seg
    errs = [_clip(ctx.scrub(l), 160) for l in _lines(r.stderr)]
    frames, decoded = _progress(r.stdout)
    seg.update(exit_code=r.returncode, frames=frames, decoded_s=_f(decoded), error_lines=len(errs),
               errors=kept_error_lines([ctx.scrub(l) for l in _lines(r.stderr)]) if getattr(ctx, 'live_behavior', 'live-1') == 'live-2' else errs[:3])
    if r.file_size_limit:
        seg['state'] = 'output_cap'  # the collector's own output cap killed ffmpeg: says nothing about the file
    elif r.timed_out:
        seg['state'] = 'timeout'
    elif r.returncode != 0 or errs:
        seg['state'] = 'errors'
    else:
        seg['state'] = 'clean'
    return seg


def sample_decode(ctx, path, duration, interior, seg_s, max_segments, deadline, audio_only=False):
    segs, skipped = [], 0
    for off in segment_offsets(duration, interior, seg_s, max_segments):
        if deadline.left() <= 0.5:
            skipped += 1
            continue
        s = decode_window(ctx, path, off, seg_s, deadline, audio_only)
        expected = min(seg_s, duration - off) if duration else seg_s
        s['expected_s'] = _f(expected)
        if s['state'] == 'clean' and expected >= 0.5 and (s.get('decoded_s') or 0) < 0.5 * expected:
            s['state'] = 'short'  # exit 0 and no messages, but little or nothing came out (seek past the real end, empty stream)
        segs.append(s)
    return segs, skipped


def _union_s(segs, duration):
    """Seconds covered by the union of the decoded windows [at_s, at_s + decoded_s], clipped to the known duration (overlaps counted once)."""
    spans = sorted((s['at_s'] or 0.0, (s['at_s'] or 0.0) + (s.get('decoded_s') or 0.0)) for s in segs if s.get('at_s') is not None or s.get('decoded_s'))
    total, end = 0.0, None
    for a, b in spans:
        if duration:
            a, b = min(a, duration), min(b, duration)
        if b <= a:
            continue
        if end is None or a > end:
            total += b - a
            end = b
        elif b > end:
            total += b - end
            end = b
    return total


def _decode_summary(segs, skipped, duration, union=False):
    count = lambda st: sum(1 for s in segs if s['state'] == st)
    decoded = sum((s.get('decoded_s') or 0) for s in segs)
    covered = _union_s(segs, duration) if union else decoded
    out = {'segments_planned': len(segs) + skipped, 'segments_run': len(segs), 'segments_skipped_deadline': skipped,
           'segments_clean': count('clean'), 'segments_with_errors': count('errors'), 'segments_short': count('short'),
           'segments_timeout': count('timeout'), 'segments_spawn_error': count('spawn_error'), 'segments_output_cap': count('output_cap'),
           'decoder_error_lines': sum(s.get('error_lines', 0) for s in segs), 'decoded_s': _f(covered),
           'sampled_fraction': _f(covered / duration, 3) if duration else None, 'segments': segs}
    if union:
        out['decoded_s_total_windows'] = _f(decoded)   # the sum of the windows' own decoded time, overlaps included
    out['clean'] = bool(segs) and count('clean') == len(segs)
    return out


def collect_decode(ctx, started):
    deadline = Deadline(ctx.bounds['deadline_s'], ctx.clock)
    b = used_bounds(ctx, DECODE_BOUNDS)
    if not ctx.binary('ffmpeg'):
        return unavailable('decode', ctx, started, 'ffmpeg', ['decoding of any sampled segment'])
    ver = ctx.version('ffmpeg')
    p = probe_file(ctx, ctx.path, deadline)
    duration = _duration(p)
    seg_s = ctx.bounds['segment_s']
    segs, skipped = sample_decode(ctx, ctx.path, duration, ctx.bounds['segments'], seg_s, int(ctx.bounds['max_segments']), deadline)
    out = _decode_summary(segs, skipped, duration, ctx.coverage_union)
    out['duration_s'] = duration
    findings, partial_reasons = [], []
    if duration is None:
        partial_reasons.append('duration unknown (%s): only the head was sampled' % (p.get('reason') or 'ffprobe gave none'))
    if skipped:
        partial_reasons.append('%d planned segments skipped: collector deadline reached' % skipped)
    if out['segments_timeout']:
        partial_reasons.append('%d segments timed out' % out['segments_timeout'])
    if out['segments_output_cap']:
        partial_reasons.append('%d segments hit the collector output cap (a tool limit; the file was not judged for them)' % out['segments_output_cap'])
    if segs and out['segments_spawn_error'] == len(segs):
        return tool_error('decode', ctx, started, 'ffmpeg could not be started: %s' % segs[0].get('error'), version=ver, bounds_used=b)
    if out['segments_with_errors']:
        findings.append('%d of %d sampled segments produced decoder errors' % (out['segments_with_errors'], len(segs)))
    if out['segments_short']:
        findings.append('%d segments decoded far less than their window (seek past the real end, or an empty stream)' % out['segments_short'])
    pct = ' (%.0f%% of the duration)' % (100 * out['sampled_fraction']) if out['sampled_fraction'] is not None else ''
    verified = ['%d segment(s) of up to %gs decoded (head, tail and %d spread offsets); %.1fs decoded%s' % (
        len(segs), seg_s, int(ctx.bounds['segments']), out['decoded_s'] or 0, pct)]
    not_verified = ['the rest of the file was not decoded; ' + NEVER_PROVES, 'subtitle and data streams were not decoded']
    full = None
    if ctx.bounds['full_decode']:  # explicit opt-in, under byte and time caps
        size = Path(ctx.path).stat().st_size
        if size > ctx.bounds['full_max_bytes']:
            full = {'performed': False, 'refused': 'file is %d bytes, over the full_max_bytes cap of %d' % (size, ctx.bounds['full_max_bytes'])}
            partial_reasons.append('full decode requested but refused: ' + full['refused'])
        else:
            fs = decode_window(ctx, ctx.path, None, None, deadline, timeout_s=ctx.bounds['full_timeout_s'])
            full = dict(fs, performed=True)
            if fs['state'] == 'timeout':
                partial_reasons.append('full decode hit the %ss cap after %.1fs of media' % (ctx.bounds['full_timeout_s'], fs.get('decoded_s') or 0))
            elif fs['state'] == 'spawn_error':
                partial_reasons.append('full decode could not start')
            else:
                verified.append('full decode of the first video and first audio stream ran to the end (%s)' % fs['state'])
                not_verified = ['other video and audio streams, subtitles and data streams were not decoded']
                if fs['state'] == 'errors':
                    findings.append('full decode produced %d error line(s)' % fs.get('error_lines', 0))
    out['full'] = full
    out['findings'] = findings
    not_verified += partial_reasons
    stderr = ctx.excerpt(*['\n'.join(s['errors']) for s in segs if s.get('errors')][:3])
    if segs and all(s['state'] == 'timeout' for s in segs):
        status = 'timeout'
    elif partial_reasons:
        status = 'partial'
    else:
        status = 'ok'
    return make_record('decode', 'live', status, ctx, started, version=ver, bounds_used=b, output=out, stderr=stderr,
                       reason='; '.join(partial_reasons) or None, coverage={'verified': verified, 'not_verified': not_verified})


# ------------------------------------------------------------------ frames (+ OCR)

def frame_offsets(duration, n):
    if not duration or duration <= 0:
        return [0.0]
    lo, hi = min(0.5, duration / 2), max(duration - 0.5, 0.0)
    if n <= 1 or hi <= lo:
        return [round(lo, 3)]
    return [round(lo + (hi - lo) * i / (n - 1), 3) for i in range(int(n))]


def _png_size(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        return struct.unpack('>II', data[16:24])
    return None


def _ocr(ctx, exe, png, deadline):
    r = ctx.run([exe, str(png), 'stdout', '--psm', '6'], timeout_s=ctx.bounds['ocr_timeout_s'], deadline=deadline)
    if r.error:
        return {'state': 'error', 'error': ctx.scrub(r.error)}
    if r.timed_out:
        return {'state': 'timeout'}
    if r.returncode != 0:
        return {'state': 'error', 'exit_code': r.returncode, 'stderr': ctx.excerpt(r.stderr)}
    text = ' '.join(r.stdout.decode('utf-8', 'replace').split())
    cap = int(ctx.bounds['ocr_max_chars'])
    return {'state': 'ok' if text else 'empty', 'text': text[:cap], 'truncated': len(text) > cap}


def collect_frames(ctx, started):
    deadline = Deadline(ctx.bounds['deadline_s'], ctx.clock)
    b = used_bounds(ctx, FRAME_BOUNDS)
    if not ctx.binary('ffmpeg'):
        return unavailable('frames', ctx, started, 'ffmpeg', ['sampled frames', 'on-screen text'])
    ver = ctx.version('ffmpeg')
    p = probe_file(ctx, ctx.path, deadline)
    duration, types = _duration(p), _stream_types(p)
    partial_reasons, findings = [], []
    if duration is None:
        partial_reasons.append('duration unknown (%s): one frame near the head only' % (p.get('reason') or 'ffprobe gave none'))
    if types is not None and 'video' not in types:
        return make_record('frames', 'live', 'ok', ctx, started, version=ver, bounds_used=b,
                           output={'duration_s': duration, 'frames': [], 'findings': ['the container has no video stream']},
                           coverage={'verified': ['stream list: no video stream, so no frame exists to sample'], 'not_verified': []})
    ocr_exe = None if ctx.bounds['ocr'] == 'off' else ctx.binary('tesseract')
    ocr_ver = ctx.version('tesseract') if ocr_exe else None
    frames, errs = [], []
    for i, off in enumerate(frame_offsets(duration, ctx.bounds['frames'])):
        if deadline.left() <= 0.5:
            partial_reasons.append('frames from offset %g on skipped: collector deadline reached' % off)
            break
        png = ctx.scratch / ('frame_%02d.png' % i)
        argv = [ctx.binary('ffmpeg'), '-nostdin', '-v', 'error', '-threads', '1', '-ss', '%g' % off] + _in(ctx.path) + [
                '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=%d:-2' % ctx.bounds['frame_width'], '-y', str(png)]
        r = ctx.run(argv, deadline=deadline, max_file=ctx.bounds['max_frame_bytes'])
        fr = {'at_s': off}
        if r.error:
            fr.update(state='spawn_error', error=ctx.scrub(r.error))
        elif r.file_size_limit:
            fr.update(state='output_cap', note='ffmpeg was killed at the max_frame_bytes cap (%d); a tool limit, not a verdict on the file' % ctx.bounds['max_frame_bytes'])
        elif r.timed_out:
            fr['state'] = 'timeout'
        else:
            data = png.read_bytes() if png.is_file() else b''
            size = _png_size(data)
            elines = _lines(r.stderr)
            if size is None:
                fr.update(state='no_frame', exit_code=r.returncode)
            else:
                # a frame that came out while ffmpeg exited non-zero or printed errors is not a clean frame
                fr.update(state='ok' if r.returncode == 0 and not elines else 'errors', width=size[0], height=size[1], bytes=len(data),
                          sha256=hashlib.sha256(data).hexdigest())
            if r.returncode != 0:
                fr['exit_code'] = r.returncode
            if elines:
                fr['error_lines'] = len(elines)
                fr['errors'] = [_clip(ctx.scrub(l), 160) for l in elines[:3]]
                errs.append(r.stderr)
        if fr['state'] == 'errors':
            findings.append('frame at %gs decoded but ffmpeg exited %s with %d error line(s)' % (off, r.returncode, len(elines)))
            partial_reasons.append('frame at %gs: produced with decoder errors' % off)
        elif fr['state'] != 'ok':
            partial_reasons.append('frame at %gs: %s' % (off, fr['state']))
        elif ocr_exe:
            fr['ocr'] = _ocr(ctx, ocr_exe, png, deadline)
            if fr['ocr']['state'] in ('error', 'timeout'):
                partial_reasons.append('OCR of the frame at %gs: %s' % (off, fr['ocr']['state']))
        elif ctx.bounds['ocr'] != 'off':
            fr['ocr'] = {'state': 'unavailable', 'reason': 'tesseract not found on PATH'}
        frames.append(fr)
        if png.is_file():
            png.unlink()  # scratch is removed anyway; keep it small while sampling
    ok_frames = [f for f in frames if f['state'] == 'ok']
    hashes = [f['sha256'] for f in frames if f.get('sha256')]
    if len(hashes) >= 2 and len(set(hashes)) == 1:
        findings.append('all sampled frames are byte-identical (a frozen or placeholder picture is possible)')
    out = {'duration_s': duration, 'frames': frames, 'frames_ok': len(ok_frames), 'frames_with_errors': sum(1 for f in frames if f['state'] == 'errors'), 'distinct_frames': len(set(hashes)), 'findings': findings,
           'ocr': ('tesseract' if ocr_exe else ('off' if ctx.bounds['ocr'] == 'off' else 'unavailable'))}
    verified = ['%d frame(s) decoded at spread offsets (scaled to width %d); pictures not kept' % (len(ok_frames), ctx.bounds['frame_width'])]
    not_verified = ['frames between the sampled offsets', 'whether any frame is the right picture: only decodability and text were looked at']
    if ocr_exe:
        verified.append('OCR run with %s on each decoded frame' % (ocr_ver or 'tesseract'))
        not_verified.append('OCR is a reading, not ground truth: no consensus or second engine was used')
    else:
        not_verified.append('on-screen text was not read (%s)' % ('OCR off' if ctx.bounds['ocr'] == 'off' else 'tesseract not found on PATH'))
    not_verified += partial_reasons
    version = ('%s; %s' % (ver, ocr_ver) if ocr_ver else ver)
    if frames and all(f['state'] == 'timeout' for f in frames):
        status = 'timeout'  # (an all-output_cap run falls through to partial below)
    elif frames and all(f['state'] == 'spawn_error' for f in frames):
        return tool_error('frames', ctx, started, 'ffmpeg could not be started', version=ver, bounds_used=b)
    else:
        status = 'partial' if partial_reasons else 'ok'
    return make_record('frames', 'live', status, ctx, started, version=version, bounds_used=b, output=out, stderr=ctx.excerpt(*errs[:3]),
                       reason='; '.join(partial_reasons) or None, coverage={'verified': verified, 'not_verified': not_verified})


# ------------------------------------------------------------------ audio levels and silence

_MEAN = re.compile(r'mean_volume:\s*(-?inf|-?[\d.]+)\s*dB')
_MAX = re.compile(r'max_volume:\s*(-?inf|-?[\d.]+)\s*dB')
_SIL_START = re.compile(r'silence_start:\s*(-?[\d.]+)')
_SIL_END = re.compile(r'silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*(-?[\d.]+)')
_LEVEL = re.compile(r'\[(warning|error|fatal|panic)\]\s*(.*)')  # `[error] msg` and `[aac @ 0x..] [error] msg` both occur


def parse_levels(stderr_text, window):
    """volumedetect and silencedetect lines (ffmpeg `-v level+info`) -> levels, silence, and warning/error lines."""
    mean = mx = None
    silent = 0.0
    open_start = None
    n_sil = 0
    problems = []
    for line in stderr_text.splitlines():
        m = _MEAN.search(line)
        if m:
            mean = _num(m.group(1))
        m = _MAX.search(line)
        if m:
            mx = _num(m.group(1))
        m = _SIL_START.search(line)
        if m:
            open_start = float(m.group(1))
        m = _SIL_END.search(line)
        if m:
            silent += max(0.0, float(m.group(2)))
            n_sil += 1
            open_start = None
        m = _LEVEL.search(line)
        if m:
            problems.append(m.group(2))
    if open_start is not None and window:
        silent += max(0.0, window - open_start)
        n_sil += 1
    return {'mean_db': mean, 'max_db': mx, 'silent_s': round(silent, 3), 'silence_runs': n_sil}, problems


def collect_audio(ctx, started):
    deadline = Deadline(ctx.bounds['deadline_s'], ctx.clock)
    b = used_bounds(ctx, AUDIO_BOUNDS)
    if not ctx.binary('ffmpeg'):
        return unavailable('audio', ctx, started, 'ffmpeg', ['per-segment levels and silence', 'audio stream language tags'])
    ver = ctx.version('ffmpeg')
    p = probe_file(ctx, ctx.path, deadline)
    duration = _duration(p)
    partial_reasons, findings = [], []
    streams = []
    if p['state'] == 'ok':
        for s in condense(p['data'])['streams']:
            if s.get('type') == 'audio':
                streams.append({k: s.get(k) for k in ('index', 'codec', 'channels', 'sample_rate', 'language', 'title') if s.get(k) is not None})
    else:
        partial_reasons.append('ffprobe %s (%s): audio streams and language tags unknown, stream 0:a:0 sampled blindly' % (p['state'], p.get('reason')))
        streams = [{'blind': True}]
    if not streams:
        return make_record('audio', 'live', 'ok', ctx, started, version=ver, bounds_used=b,
                           output={'duration_s': duration, 'streams': [], 'findings': ['the container has no audio stream']},
                           coverage={'verified': ['stream list: no audio stream'], 'not_verified': []})
    total_streams = len(streams)
    streams = streams[:int(ctx.bounds['max_audio_streams'])]
    if total_streams > len(streams):
        partial_reasons.append('%d audio streams not sampled (max_audio_streams %d)' % (total_streams - len(streams), len(streams)))
    seg_s = ctx.bounds['segment_s']
    offsets = segment_offsets(duration, ctx.bounds['segments'], seg_s, int(ctx.bounds['max_segments']))
    if duration is None:
        partial_reasons.append('duration unknown: only the head was sampled')
    results, errs, timeouts, skipped, caps = [], [], 0, 0, 0
    for st in streams:
        item = dict(st)
        item['segments'] = []
        if not st.get('blind') and not st.get('language'):
            findings.append('audio stream %s has no language tag' % st.get('index', '?'))
        mapspec = '0:%d' % st['index'] if st.get('index') is not None else '0:a:0'
        for off in offsets:
            if deadline.left() <= 0.5:
                skipped += 1
                continue
            argv = [ctx.binary('ffmpeg'), '-nostdin', '-hide_banner', '-v', 'level+info', '-nostats', '-threads', '1', '-ss', '%g' % off] + _in(ctx.path) + [
                    '-t', '%g' % seg_s, '-map', mapspec, '-vn', '-af',
                    'volumedetect,silencedetect=noise=%gdB:d=%g' % (ctx.bounds['silence_noise_db'], ctx.bounds['silence_min_s']), '-f', 'null', '-']
            r = ctx.run(argv, deadline=deadline)
            seg = {'at_s': off, 'elapsed_s': round(r.elapsed_s, 3)}
            window = min(seg_s, duration - off) if duration else seg_s
            if r.error:
                seg.update(state='spawn_error', error=ctx.scrub(r.error))
            elif r.file_size_limit:
                seg['state'] = 'output_cap'
                caps += 1
            elif r.timed_out:
                seg['state'] = 'timeout'
                timeouts += 1
            else:
                lv, problems = parse_levels(r.stderr.decode('utf-8', 'replace'), window)
                seg.update(lv)
                seg['window_s'] = _f(window)
                seg['silent_fraction'] = _f(lv['silent_s'] / window, 3) if window else None
                seg['exit_code'] = r.returncode
                seg['problem_lines'] = len(problems)
                if problems:
                    seg['problems'] = (kept_error_lines([ctx.scrub(x) for x in problems]) if getattr(ctx, 'live_behavior', 'live-1') == 'live-2'
                                       else [_clip(ctx.scrub(x), 160) for x in problems[:3]])
                    errs.extend(problems[:3])
                if r.returncode != 0 or problems:
                    seg['state'] = 'errors'
                elif lv['mean_db'] is None:
                    seg['state'] = 'no_audio'  # volumedetect saw no samples
                elif lv['mean_db'] <= -60 or (seg['silent_fraction'] is not None and seg['silent_fraction'] >= 0.9):
                    seg['state'] = 'near_silent'
                else:
                    seg['state'] = 'ok'
            item['segments'].append(seg)
        bad = [s['state'] for s in item['segments'] if s['state'] != 'ok']
        if bad:
            findings.append('audio stream %s: %d of %d segments not normal (%s)' % (st.get('index', '?'), len(bad), len(item['segments']), ', '.join(sorted(set(bad)))))
        results.append(item)
    if skipped:
        partial_reasons.append('%d planned segments skipped: collector deadline reached' % skipped)
    if timeouts:
        partial_reasons.append('%d segments timed out' % timeouts)
    if caps:
        partial_reasons.append('%d segments hit the collector output cap (a tool limit, not a verdict on the file)' % caps)
    out = {'duration_s': duration, 'streams': results, 'silence_threshold_db': ctx.bounds['silence_noise_db'], 'silence_min_s': ctx.bounds['silence_min_s'], 'findings': findings}
    n_seg = sum(len(s['segments']) for s in results)
    verified = ['%d segment(s) of up to %gs decoded across %d audio stream(s): mean and max level, silence runs of at least %gs below %gdB' % (
        n_seg, seg_s, len(results), ctx.bounds['silence_min_s'], ctx.bounds['silence_noise_db'])]
    if p['state'] == 'ok':
        verified.append('language and title tags read from the container')
    not_verified = ['audio between the sampled segments', 'speech content: levels only, no speech recognition', 'whether the language tag matches the spoken language']
    all_timeout = bool(n_seg) and all(s['state'] == 'timeout' for r_ in results for s in r_['segments'])
    status = 'timeout' if all_timeout else ('partial' if partial_reasons else 'ok')
    return make_record('audio', 'live', status, ctx, started, version=ver, bounds_used=b, output=out, stderr=ctx.excerpt(*errs[:3]),
                       reason='; '.join(partial_reasons) or None, coverage={'verified': verified, 'not_verified': not_verified + partial_reasons})


# ------------------------------------------------------------------ audiobook

def _natural(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', name)]


def audiobook_parts(inputs, max_files):
    """-> (paths, ignored count, count over the cap).  `inputs` are Paths (files, or one directory)."""
    if len(inputs) == 1 and inputs[0].is_dir():
        entries = [p for p in inputs[0].iterdir() if p.is_file()]
        files = sorted([p for p in entries if p.suffix.lower() in AUDIO_EXT], key=lambda p: _natural(p.name))
        ignored = len(entries) - len(files)
    else:
        files, ignored = list(inputs), 0
    return files[:max_files], ignored, max(0, len(files) - max_files)


def chapter_findings(chapters, duration):
    f = []
    if not chapters:
        return f
    if (chapters[0]['start_s'] or 0) > 1.0:
        f.append('first chapter starts at %.1fs, not at the beginning' % chapters[0]['start_s'])
    for a, c in zip(chapters, chapters[1:]):
        if a['end_s'] is None or c['start_s'] is None:
            continue
        if c['start_s'] - a['end_s'] > 0.5:
            f.append('gap of %.1fs before the chapter starting at %.1fs' % (c['start_s'] - a['end_s'], c['start_s']))
        elif a['end_s'] - c['start_s'] > 0.5:
            f.append('chapters overlap by %.1fs at %.1fs' % (a['end_s'] - c['start_s'], c['start_s']))
    last = chapters[-1]['end_s']
    if duration and last is not None:
        if last > duration + 1.0:
            f.append('last chapter ends at %.1fs, after the %.1fs file duration' % (last, duration))
        elif duration - last > 5.0:
            f.append('chapters stop %.1fs before the end of the file' % (duration - last))
    titles = [c['title'] for c in chapters]
    if any(not t for t in titles):
        f.append('%d chapter(s) have no title' % sum(1 for t in titles if not t))
    named = [t for t in titles if t]
    if len(named) != len(set(named)):
        f.append('duplicate chapter titles')
    return f


CONSISTENCY_KEYS = ('album', 'artist', 'album_artist', 'composer', 'genre', 'date')


def tag_consistency(parts, total_parts=None):
    """parts: [(name, tags dict)].  Reports tags that differ or are missing in some parts, and track-number problems."""
    total_parts = total_parts or len(parts)
    inconsistent, missing = {}, {}
    for key in CONSISTENCY_KEYS:
        vals = {n: t.get(key) for n, t in parts}
        present = {n: v for n, v in vals.items() if v is not None}
        if not present:
            continue
        distinct = sorted(set(present.values()))
        if len(distinct) > 1:
            inconsistent[key] = {v: [n for n, x in present.items() if x == v] for v in distinct}
        absent = [n for n, v in vals.items() if v is None]
        if absent:
            missing[key] = absent
    tracks = {}
    for n, t in parts:
        m = re.match(r'^\s*(\d+)\s*(?:/\s*(\d+))?', t.get('track', '') or '')
        if m:
            tracks[n] = (int(m.group(1)), int(m.group(2)) if m.group(2) else None)
    track_issue, track_note = None, None
    totals = {v[1] for v in tracks.values() if v[1]}
    if len(totals) > 1:
        track_issue = 'parts disagree on the track total: %s' % sorted(totals)
    if tracks and len(tracks) == len(parts) == total_parts:
        nums = sorted(v[0] for v in tracks.values())
        if nums != list(range(1, total_parts + 1)):
            track_issue = track_issue or 'track numbers %s are not 1..%d' % (nums, total_parts)
        elif totals and totals != {total_parts} and len(totals) == 1:
            track_issue = 'track total %s does not match the %d parts found' % (sorted(totals)[0], total_parts)
    elif tracks:
        track_note = 'numbering and total were not checked against the part count: %d of %d parts have a readable track tag' % (len(tracks), total_parts)
    return {'consistent': not inconsistent and not missing and not track_issue, 'inconsistent': inconsistent, 'missing_in': missing,
            'track_issue': track_issue, 'track_note': track_note, 'checked_keys': list(CONSISTENCY_KEYS)}


def collect_audiobook(ctx, started, inputs):
    deadline = Deadline(ctx.bounds['deadline_s'], ctx.clock)
    b = used_bounds(ctx, BOOK_BOUNDS)
    if not ctx.binary('ffprobe'):
        return unavailable('audiobook', ctx, started, 'ffprobe', ['chapters, durations, tags', 'sampled decode of each part'])
    parts, ignored, over = audiobook_parts(inputs, int(ctx.bounds['max_files']))
    if not parts:
        return make_record('audiobook', 'live', 'error', ctx, started, bounds_used=b, cause='input', reason='no audio files found',
                           coverage={'verified': ['folder listing'], 'not_verified': ['everything else']})
    have_ffmpeg = bool(ctx.binary('ffmpeg'))
    for p_ in parts:
        ctx.add_name(str(p_))
    files, partial_reasons, findings, tag_sets, errs = [], [], [], [], []
    total, probed = 0.0, 0
    keep_tags = CONSISTENCY_KEYS + ('title', 'track', 'disc', 'narrator', 'comment')
    for part in parts:
        entry = {'name': part.name, 'bytes': part.stat().st_size}
        if deadline.left() <= 0.5:
            entry.update(probe='skipped', probe_reason='collector deadline reached before this part')
            findings.append('%s: not examined (collector deadline reached)' % part.name)
            partial_reasons.append('%s: not examined, collector deadline reached' % part.name)
            files.append(entry)
            continue
        pr = probe_file(ctx, str(part), deadline)
        if pr['state'] != 'ok':
            entry.update(probe=pr['state'], probe_cause=pr.get('cause'), probe_reason=pr.get('reason'), probe_stderr=pr.get('stderr'))
            findings.append('%s: ffprobe %s (%s)' % (part.name, pr['state'], pr.get('reason')))
            # a part nobody could read means the book was not fully verified, whatever the reason
            partial_reasons.append('%s: could not be read (ffprobe %s)' % (part.name, pr['state']))
            if pr.get('stderr'):
                errs.append(pr['stderr'])
            files.append(entry)
            continue
        probed += 1
        c = condense(pr['data'])
        dur = c['duration_s']
        total += dur or 0
        audio = [s for s in c['streams'] if s.get('type') == 'audio']
        entry.update(format=c['format'], duration_s=dur,
                     audio_streams=[{k: s.get(k) for k in ('index', 'codec', 'channels', 'sample_rate', 'language') if s.get(k) is not None} for s in audio],
                     tags={k: v for k, v in c['tags'].items() if k in keep_tags}, chapter_count=c['chapter_count'], chapters=c['chapters'][:60])
        if c['chapter_count'] > 60:
            entry['chapters_omitted'] = c['chapter_count'] - 60
        if not audio:
            findings.append('%s: no audio stream' % part.name)
        cf = chapter_findings(c['chapters'], dur)
        if cf:
            entry['chapter_findings'] = cf
            findings += ['%s: %s' % (part.name, x) for x in cf]
        if have_ffmpeg and audio:
            segs, skipped = sample_decode(ctx, str(part), dur, ctx.bounds['audiobook_segments'], ctx.bounds['audiobook_segment_s'],
                                          int(ctx.bounds['max_segments']), deadline, audio_only=True)
            ds = _decode_summary(segs, skipped, dur, ctx.coverage_union)
            entry['decode'] = {k: ds[k] for k in ('segments_run', 'segments_clean', 'segments_with_errors', 'segments_short', 'segments_timeout', 'segments_output_cap',
                                                  'decoder_error_lines', 'decoded_s', 'clean')}
            entry['decode']['segments'] = [{k: s.get(k) for k in ('at_s', 'state', 'decoded_s', 'error_lines', 'errors') if s.get(k) is not None} for s in segs]
            if skipped:
                partial_reasons.append('%s: %d decode segments skipped (deadline)' % (part.name, skipped))
            if ds['segments_timeout']:
                partial_reasons.append('%s: %d decode segments timed out' % (part.name, ds['segments_timeout']))
            if ds['segments_output_cap']:
                partial_reasons.append('%s: %d decode segments hit the collector output cap' % (part.name, ds['segments_output_cap']))
            if not ds['clean']:
                findings.append('%s: sampled decode not clean (%d with errors, %d short, %d timed out)' % (
                    part.name, ds['segments_with_errors'], ds['segments_short'], ds['segments_timeout']))
            for s in segs:
                errs += s.get('errors', [])
        tag_sets.append((part.name, c['tags']))
        files.append(entry)
    if over:
        partial_reasons.append('%d further audio files not examined (max_files %d)' % (over, ctx.bounds['max_files']))
    if not have_ffmpeg:
        partial_reasons.append('ffmpeg not found on PATH: parts were not decoded')
    out = {'parts': len(parts), 'parts_probed': probed, 'ignored_non_audio_files': ignored, 'total_duration_s': _f(total), 'files': files, 'findings': findings}
    if len(tag_sets) >= 2:
        out['tag_consistency'] = tag_consistency(tag_sets, len(parts))
        if not out['tag_consistency']['consistent']:
            findings.append('tags differ or are missing across parts')
    verified = ['chapters, durations and tags read from %d of %d part(s) via ffprobe' % (probed, len(parts))]
    not_verified = ['audio outside the sampled segments', 'whether the chapter titles or tags describe the right book']
    if have_ffmpeg:
        verified.append('head, tail and %d spread segment(s) of up to %gs decoded per part' % (int(ctx.bounds['audiobook_segments']), ctx.bounds['audiobook_segment_s']))
    if len(tag_sets) >= 2:
        verified.append('tag consistency compared across parts (%s)' % ', '.join(CONSISTENCY_KEYS))
    else:
        not_verified.append('cross-part tag consistency: only one part readable')
    if ignored:
        not_verified.append('%d non-audio file(s) in the folder were ignored' % ignored)
    if probed == 0:
        first = files[0] if files else {}
        states = {f.get('probe') for f in files}
        cov = {'verified': [], 'not_verified': ['chapters, durations, tags and decode: nothing was readable'] + not_verified}
        if states <= {'timeout', 'skipped'}:  # time ran out; nothing says the parts are damaged
            return make_record('audiobook', 'live', 'timeout', ctx, started, version=ctx.version('ffprobe'), bounds_used=b, output=out,
                               reason='no part was examined: ffprobe timed out or the collector deadline was reached (%s)' % first.get('probe_reason'),
                               stderr=ctx.excerpt(first.get('probe_stderr') or ''), coverage=cov)
        cause = 'input' if any(f.get('probe_cause') == 'input' for f in files) else 'tool'
        return make_record('audiobook', 'live', 'error', ctx, started, version=ctx.version('ffprobe'), bounds_used=b, output=out, cause=cause,
                           reason='no part could be read by ffprobe: %s' % first.get('probe_reason'), stderr=ctx.excerpt(first.get('probe_stderr') or ''), coverage=cov)
    version = ctx.version('ffprobe')
    if have_ffmpeg and ctx.version('ffmpeg'):
        version = '%s; %s' % (version, ctx.version('ffmpeg'))
    status = 'partial' if partial_reasons else 'ok'
    return make_record('audiobook', 'live', status, ctx, started, version=version, bounds_used=b, output=out, stderr=ctx.excerpt(*errs[:3]),
                       reason='; '.join(partial_reasons) or None, coverage={'verified': verified, 'not_verified': not_verified + partial_reasons})
