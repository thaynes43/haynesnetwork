"""Tools behaviour `v3-remote-2` (#213): `v3-remote-1` plus a per-file input quota, a measured window, and an audio stream that cannot silently select the video.

Opt-in only (`--tools-behavior v3-remote-2`, valid with `--evidence-format v3.1-format`).  Every v3-remote-1 rule stands (fail-closed receipts, identity binding,
the 25 s sampler and 60 s outer deadlines, allowed root, read-only); `v3-remote-1`, `mrh-sampler-2` and `mrh-sampler-3` are unchanged and keep their hashes.  New:

1. The sampler is `mrh-sampler-4` (remote_sampler_v4.py).  For `decode_sample`, `audio_sample` and `subtitle_sample` the input quota is computed for THIS file
   (remote_quota.py: `ceil(window_s * bitrate_bps / 8 * margin) + overhead`, bitrate the largest of the measured values, floor 8 MiB, ceiling the file size).  A file
   whose size or duration is missing or unparsable gets no quota (`quota_basis: unavailable`) and nothing is run.  `frame_sample` gets the same quota from the same
   formula, for a lead-in window (FRAME_WINDOW_S, below), because a frame is found by seeking and decoding from the preceding keyframe, which a high-bitrate file can
   need more than 8 MiB for.  `probe` and `chapters` keep the 8 MiB default.
2. Every such call records `quota_bytes`, `quota_basis`, `quota_inputs`, the margin and the overhead, `bytes_read`, `quota_exhausted`, the requested window, the decoded
   output time (`out_time`, from ffmpeg's own progress) and `window_completed`.  A window that ran short is said so plainly in the result the model reads, and the
   result says that a shortfall of the read is not evidence of corruption.
3. `audio_sample {"at": s, "stream": n}`: `stream` is optional.  Omitted, the first audio stream (`0:a:0`) is read.  Given, it is the absolute stream index that ffprobe
   lists and must be an audio stream of the case's probe result; otherwise the call returns an error that names the audio stream indexes and runs nothing.
   `subtitle_sample {"at": s, "stream": n}` has the same check against the probe's text subtitle streams (omitted: the first one, as in v3-remote-1).

Nothing here reads a label, a truth field or a file name; every value comes from the stat identity, the case's probe result and the receipt.
"""
import json

from . import remote_evidence as RE
from . import remote_quota as RQ

VERSION = 'v3-remote-2'
BASE_TOOLS_BEHAVIOR = 'v3'
SAMPLER = RE.HERE / 'remote_sampler_v4.py'
RECEIPT = 'mrh-sampler-4'
DECODE_WINDOW_S = 4
AUDIO_WINDOW_S = 4
# frame_sample reads from the keyframe before `at` up to the frame, so the data it needs is one GOP, not a window.  The sampler's probe (remote_sampler_v4.py `probe`
# show_entries) does not list a GOP size or a keyframe interval, so none is measured here: the lead-in is the decode window, a STARTING VALUE like the margin.  It
# holds a GOP of up to 4 s at the file's own bitrate, and with the 2.0 margin up to 8 s.  The receipt measures whether it was enough (`frame_produced`).
FRAME_WINDOW_S = DECODE_WINDOW_S
FRAME_WINDOW_SOURCE = 'decode_window_starting_value'
FRAME_WINDOW_ROLE = 'keyframe_lead_in'
SUBTITLE_WINDOW_S = RE.SUBTITLE_WINDOW_S
WINDOWED_MODES = ('decode', 'audio', 'subtitle')
EXTRA_TOOLS = RE.EXTRA_TOOLS
RECEIPT_KEYS_2 = ('input_quota_bytes', 'window_s', 'progress')
OUT_TIME_MAX_S = 10 ** 7


def sampler_sha256():
    import hashlib
    return hashlib.sha256(SAMPLER.read_bytes()).hexdigest()


def config():
    """What a run with this tools behaviour records in its config (and so in its config hash)."""
    return dict(RE.config(), version=VERSION, base_tools_behavior=BASE_TOOLS_BEHAVIOR, sampler=RECEIPT, sampler_sha256=sampler_sha256(),
                quota=dict(RQ.PARAMETERS), decode_window_s=DECODE_WINDOW_S, audio_window_s=AUDIO_WINDOW_S, frame_window_s=FRAME_WINDOW_S,
                frame_window_source=FRAME_WINDOW_SOURCE, subtitle_window_s=SUBTITLE_WINDOW_S,
                stream_selection='audio-default-first-1')


class Binding(RE.Binding):
    def record(self):
        return dict(super().record(), tools_behavior=VERSION, sampler=RECEIPT)


def binding_for_case(case, host, max_operations=None, time_left=None):
    """RE.binding_for_case with this behaviour's Binding (its record names v3-remote-2 and mrh-sampler-4)."""
    b = RE.binding_for_case(case, host, max_operations, time_left)
    out = Binding(b.identity, b.host, b.max_operations, b.root, b.time_left)
    out.fatal = b.fatal
    return out


# ------------------------------------------------------------------------------------------------------------------ the probe and its streams
def first_probe(evidence):
    """The parsed probe object ({"format": ..., "streams": [...]}) of the FIRST ok ffprobe result in the case evidence, or None.  Nothing is invoked."""
    for e in evidence or []:
        if e.get('tool') != 'ffprobe' or e.get('status') != 'ok':
            continue
        data = e.get('output')
        try:
            data = json.loads(data) if isinstance(data, str) else data
        except ValueError:
            return None
        if isinstance(data, dict) and isinstance(data.get('observation'), dict) and 'recorded_as' in data:
            data = data['observation']
        return data if isinstance(data, dict) and isinstance(data.get('streams'), list) else None
    return None


def stream_summary(stream):
    tags = stream.get('tags') if isinstance(stream.get('tags'), dict) else {}
    return {'index': stream.get('index'), 'codec': stream.get('codec_name'), 'language': tags.get('language')}


def audio_streams(probe):
    return RQ.streams_of_type(probe, 'audio')


def text_subtitle_streams(probe):
    return [s for s in RQ.streams_of_type(probe, 'subtitle') if s.get('codec_name') in RE.TEXT_SUBTITLE_CODECS]


def indexes(streams):
    return [s['index'] for s in streams]


def pick_stream(args, probe, kind):
    """-> (stream dict, how) or raises ValueError.  `kind` is 'audio' or 'subtitle'.  Omitted `stream`: the first audio stream (`0:a:0`) / the first text subtitle
    stream.  Given: the absolute probe index, which must be one of that kind's streams, or the error names the indexes that are."""
    streams = audio_streams(probe) if kind == 'audio' else text_subtitle_streams(probe)
    label = 'audio' if kind == 'audio' else 'text subtitle (%s)' % ', '.join(RE.TEXT_SUBTITLE_CODECS)
    if 'stream' not in args:
        if not streams:
            return None, 'none'
        return streams[0], 'first'
    raw = args['stream']
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not 0 <= raw <= 127 or float(raw) != int(raw):
        raise ValueError('stream must be an integer stream index from 0 to 127 (the index ffprobe lists)')
    want = int(raw)
    for s in streams:
        if s['index'] == want:
            return s, 'given'
    by_index = {s.get('index'): s for s in RQ.probe_parts(probe)[1]}
    if want in by_index:
        found = by_index[want]
        what = 'stream %d is a %s stream (%s)' % (want, found.get('codec_type'), found.get('codec_name'))
    else:
        what = 'stream %d is not in this file\'s probe result' % want
    have = ('The %s stream indexes of this file are %s.' % (label, indexes(streams))) if streams else 'This file\'s probe result lists no %s stream.' % label
    raise ValueError('%s_sample: %s, not %s %s stream. %s "stream" is the absolute stream index from ffprobe (omit it for the first %s stream). Nothing was run.'
                     % (kind, what, 'an' if kind == 'audio' else 'a', label, have, 'audio' if kind == 'audio' else 'text subtitle'))


# ------------------------------------------------------------------------------------------------------------------ receipts
def make_validator(quota_bytes, window_s):
    """The receipt check of one operation: RE.receipt_errors with the quota this call was given, plus mrh-sampler-4's own fields (the receipt name, the quota the
    sampler says it enforced, the window and the progress it reports)."""
    def validate(r, mode, stdout_len):
        errs = RE.receipt_errors(r, mode, stdout_len, quota_bytes=quota_bytes)
        if errs:
            return errs
        missing = [k for k in RECEIPT_KEYS_2 if k not in r]
        if missing:
            return ['receipt fields missing: %s' % missing]
        if r['receipt'] != RECEIPT:
            errs.append('the receipt is not an %s receipt' % RECEIPT)
        if r['input_quota_bytes'] != quota_bytes or type(r['input_quota_bytes']) is not int:
            errs.append('input_quota_bytes %r does not equal the quota this call was given (%d)' % (r['input_quota_bytes'], quota_bytes))
        if mode in WINDOWED_MODES:
            if not RE._num(r['window_s']) or r['window_s'] != window_s:
                errs.append('window_s %r does not equal the requested window %r' % (r['window_s'], window_s))
            prog = r['progress']
            if prog is not None:
                ok = (isinstance(prog, dict) and set(prog) == {'out_time_s', 'frames'}
                      and (prog['out_time_s'] is None or RE._num_in(prog['out_time_s'], 0, OUT_TIME_MAX_S))
                      and (prog['frames'] is None or RE._int_in(prog['frames'], 0, 10 ** 9)))
                if not ok:
                    errs.append('progress malformed')
        elif r['window_s'] is not None or r['progress'] is not None:
            errs.append('a %s operation carries no window or progress' % mode)
        return errs
    return validate


def measure(mode, window_s, quota, receipt):
    """The receipt-side record of one windowed call: the quota (rule, basis, inputs, parameters), what was read, the requested window, the decoded output time and
    whether the window completed.  Pure: the same receipt and quota give the same record."""
    if mode == 'frame':
        # a frame has no decoded window to measure: the measure is whether a frame came out.  The receipt knows an exit 0 with bytes on stdout; the tool, which sees
        # the bytes, confirms the PNG signature and replaces `frame_produced` in its own copy of this record and in the receipts entry.
        produced = None if receipt is None else (receipt['exit_code'] == 0 and receipt['stdout_bytes'] > 0)
        return dict(quota, bytes_read=None if receipt is None else receipt['bytes_read'], quota_exhausted=None if receipt is None else receipt['quota_exhausted'],
                    window_role=FRAME_WINDOW_ROLE, window_source=FRAME_WINDOW_SOURCE, frame_produced=produced,
                    window_measure='frame_produced' if receipt is not None else 'no_receipt')
    progress = (receipt or {}).get('progress') if isinstance((receipt or {}).get('progress'), dict) else {}
    out_time_s = progress.get('out_time_s')
    if receipt is None:
        completed, how = None, 'no_receipt'
    else:
        completed, how = RQ.window_check(mode, window_s, receipt['exit_code'], receipt['quota_exhausted'], receipt['timed_out'], out_time_s)
    return dict(quota, bytes_read=None if receipt is None else receipt['bytes_read'], quota_exhausted=None if receipt is None else receipt['quota_exhausted'],
                window_requested_s=window_s, out_time_s=out_time_s, out_time=RQ.clock(out_time_s), frames=progress.get('frames'), window_completed=completed,
                window_measure=how, window_tolerance_s=RQ.WINDOW_TOLERANCE_S)


def run_operation(runner, namespace, target, container, mode, path, binding, opts=(), bind_identity=True, quota=None, window_s=None):
    """RE.run_operation with the mrh-sampler-4 script and receipt check.  `quota` (a remote_quota.plan record with a quota) and `window_s` are for the windowed
    modes: they add the per-file quota to the argv, are checked against the receipt, and the measured record joins the receipts entry as `quota`."""
    quota_bytes = quota['quota_bytes'] if quota else RQ.FLOOR_BYTES
    extra = list(opts)
    if quota:
        extra += ['--input-quota-bytes', quota_bytes]
    return RE.run_operation(runner, namespace, target, container, mode, path, binding, extra, bind_identity, sampler=SAMPLER,
                            validate=make_validator(quota_bytes, window_s if mode in WINDOWED_MODES else None), receipt_name=RECEIPT,
                            entry_extra=(lambda receipt: {'quota': measure(mode, window_s, quota, receipt)}) if quota else None)


def run_for_ctx(ctx, mode, opts, quota=None, window_s=None):
    fx = ctx.fixture
    target = getattr(fx, 'exec_target', None) or 'deploy/' + fx.deploy
    return run_operation(ctx.runner, fx.namespace, target, fx.container, mode, fx.path, ctx.remote_binding, opts, quota=quota, window_s=window_s)


def run_remote(ctx, mode, at=0.0, stream=0):
    """tools._run_remote for the modes that keep the 8 MiB default (probe, chapters) -> (info, stdout, err)."""
    receipt, out = run_for_ctx(ctx, mode, ['--at', at, '--stream', int(stream)])
    if receipt['exit_code'] == 'timeout':
        return receipt, out, 'timeout'
    if receipt['exit_code'] == 'error':
        return receipt, out, 'error: %s' % (receipt.get('error') or 'the sampler could not run the operation')
    return receipt, out, None


# ------------------------------------------------------------------------------------------------------------------ the quota of one call
def plan_call(ctx, window_s, selected, frame=False):
    """-> the remote_quota record of this call.  The size is the stat identity the case binds; the rest comes from the case's probe result."""
    ident = getattr(ctx.remote_binding, 'identity', None) or {}
    record = RQ.plan(ident.get('size'), getattr(ctx, 'media_probe', None) or {}, window_s, selected)
    if frame:
        record.update(window_role=FRAME_WINDOW_ROLE, window_source=FRAME_WINDOW_SOURCE)      # frame_sample's window is a lead-in allowance, not a decoded window
    return record


def unavailable(tool, quota, mode='remote'):
    from . import tools as T
    return T.ToolResult('unavailable', '%s: quota_basis: unavailable. %s. Nothing was run and nothing was observed.' % (tool, quota['reason']), mode=mode, quota=quota)


def no_probe(tool):
    from . import tools as T
    return T.ToolResult('unavailable', '%s needs the probe result of this file (to choose a stream and to size the read from the file\'s own data); this case has none. '
                        'Nothing was run.' % tool, mode='remote')


def shortfall(m, window_s, what):
    """The plain-language note of a window that did not complete, or None.  A shortfall of the READ is never evidence about the file."""
    if m['window_completed'] is True:
        return None
    done = 'no decoded time was reported' if m['out_time_s'] is None else 'only %.2f s was decoded' % m['out_time_s']
    if m['quota_exhausted']:
        return ('the %s window ran short: %s of the requested %g s, because the sampler reached its per-file input limit of %d bytes (computed from this file\'s size and '
                'bitrate; %d bytes read). That is a limit of this read, not evidence that the file is corrupt.' % (what, done, window_s, m['quota_bytes'], m['bytes_read']))
    if m['window_completed'] is False:
        return ('the %s window ran short: %s of the requested %g s, and the sampler did not reach its input limit (%d of %d bytes read), so the window may run past the end of '
                'the file or the decoder stopped early. A short window is not by itself evidence that the file is corrupt.' % (what, done, window_s, m['bytes_read'], m['quota_bytes']))
    return 'whether the %s window completed is not known: %s. This is not evidence of corruption.' % (what, done)


def window_fields(m):
    return {'quota_bytes': m['quota_bytes'], 'bytes_read': m['bytes_read'], 'quota_exhausted': m['quota_exhausted'], 'window_completed': m['window_completed']}


# ------------------------------------------------------------------------------------------------------------------ frame_sample
def frame_shortfall(m):
    """The plain-language note of a call that produced no frame, or None when a frame came out.  A shortfall of the READ is never evidence about the file."""
    if m['frame_produced']:
        return None
    if m['quota_exhausted']:
        return ('no frame was produced because the sampler reached its per-file input limit of %d bytes (computed from this file\'s size and bitrate for a %g s lead-in from '
                'the keyframe before the offset; %d bytes read). The decoder\'s own read errors are a result of that cut. That is a limit of this read, not evidence that '
                'the file is corrupt.' % (m['quota_bytes'], FRAME_WINDOW_S, m['bytes_read']))
    return None


def tool_frame_sample(args, ctx):
    """`frame_sample {"at": s}` on a remote file under v3-remote-2: one picture, with the input quota computed for this file (FRAME_WINDOW_S of its own bitrate)."""
    import hashlib
    import struct
    from . import tools as T
    at = T._at(args)
    name = 'frame@%g' % at
    probe = getattr(ctx, 'media_probe', None)
    if not probe:
        return no_probe('frame_sample')
    video = RQ.streams_of_type(probe, 'video')
    if not video:
        return T.ToolResult('error', {'note': 'no frame produced: the probe result of this file lists no video stream; nothing was run'}, mode='remote')
    q = plan_call(ctx, FRAME_WINDOW_S, video[:1], frame=True)
    if q['quota_bytes'] is None:
        return unavailable('frame_sample', q)
    receipt, png = run_for_ctx(ctx, 'frame', ['--at', at, '--stream', 0], q, FRAME_WINDOW_S)
    if receipt['exit_code'] == 'timeout':
        return T.ToolResult('timeout', 'timeout', mode='remote', quota=measure('frame', FRAME_WINDOW_S, q, receipt))
    if receipt['exit_code'] == 'error':
        return T.ToolResult('error', 'error: %s' % (receipt.get('error') or 'the sampler could not run the operation'), mode='remote')
    m = measure('frame', FRAME_WINDOW_S, q, receipt)
    m['frame_produced'] = bool(png.startswith(b'\x89PNG') and len(png) >= 24)
    ctx.remote_binding.receipts[-1]['quota'] = m          # the entry measure() wrote at run time had no PNG check; keep one record
    fields = {'quota_bytes': m['quota_bytes'], 'bytes_read': m['bytes_read'], 'quota_exhausted': m['quota_exhausted'], 'frame_produced': m['frame_produced']}
    if not m['frame_produced']:
        out = dict({'exit_code': receipt['exit_code'], 'note': 'no frame produced'}, **fields)
        if m['quota_exhausted']:
            out['scope_limit'] = frame_shortfall(m)       # the decoder's own messages are a limit of the read, not a finding about the file: not shown
            return T.ToolResult('partial', out, mode='remote', quota=m)
        out['stderr'] = (receipt.get('stderr') or '')[:1000]
        return T.ToolResult('error', out, mode='remote', quota=m)
    path = ctx.scratch / (hashlib.sha256(png).hexdigest()[:16] + '.png')
    path.write_bytes(png)         # scratch only, never inside the committed run directory
    ctx.frames[name] = str(path)
    ctx.frame_t[name] = at
    width, height = struct.unpack('>II', png[16:24])
    out = {'frame': name, 'width': width, 'height': height, 'bytes': len(png), 'sha256': hashlib.sha256(png).hexdigest(),
           'note': 'image kept in scratch; call ocr with this frame name to read text from it'}
    out.update(fields)
    return T.ToolResult('ok', out, mode='remote', quota=m)


# ------------------------------------------------------------------------------------------------------------------ decode_sample and audio_sample
def streams_label(selected):
    return ['0:v:0', '0:a:0'] if len(selected) > 1 else ['0:v:0']


def tool_decode_sample(args, ctx):
    """`decode_sample {"at": s}` on a remote file under v3-remote-2: a 4 s window of the first video and first audio stream, with the per-file quota."""
    from . import tools as T
    at = T._at(args)
    probe = getattr(ctx, 'media_probe', None)
    if not probe:
        return no_probe('decode_sample')
    video, audio = RQ.streams_of_type(probe, 'video'), audio_streams(probe)
    if not video:
        return T.ToolResult('unavailable', 'decode_sample: the probe result of this file lists no video stream; nothing was run', mode='remote')
    selected = video[:1] + audio[:1]
    q = plan_call(ctx, DECODE_WINDOW_S, selected)
    if q['quota_bytes'] is None:
        return unavailable('decode_sample', q)
    receipt, _out = run_for_ctx(ctx, 'decode', ['--at', at, '--window', DECODE_WINDOW_S], q, DECODE_WINDOW_S)
    if receipt['exit_code'] == 'timeout':
        return T.ToolResult('timeout', 'timeout', mode='remote', quota=measure('decode', DECODE_WINDOW_S, q, receipt))
    if receipt['exit_code'] == 'error':
        return T.ToolResult('error', 'error: %s' % (receipt.get('error') or 'the sampler could not run the operation'), mode='remote')
    m = measure('decode', DECODE_WINDOW_S, q, receipt)
    full = T._is_full(args)
    info = {'exit_code': receipt['exit_code'], 'stderr': receipt.get('stderr') or '', 'frames': m['frames'], 'out_time': m['out_time'],
            'quota_exhausted': receipt['quota_exhausted']}
    extra = dict(window_fields(m), streams_selected=streams_label(selected))
    if full:
        at = 0.0
        extra.update(requested='full', completed_to_eof=False,
                     request_unmet={'requested': 'full decode of the whole file', 'completed': 'a %d s window at 0 s' % DECODE_WINDOW_S,
                                    'reason': 'the remote sampler reads a bounded window under a per-file input limit and runs 25 s'})
    note = shortfall(m, DECODE_WINDOW_S, 'decode')
    if note:
        extra['scope_limit'] = note
    verdict = T._decode_verdict(at, DECODE_WINDOW_S, info, extra)
    verdict['clean'] = bool(verdict['clean'] and m['window_completed'] is True)
    return T.ToolResult('ok' if m['window_completed'] is True and not full else 'partial', verdict, mode='remote', quota=m)


def tool_audio_sample(args, ctx):
    """`audio_sample {"at": s, "stream": n}` on a remote file under v3-remote-2: `stream` optional (the first audio stream), else the absolute probe index of an audio
    stream, checked before anything runs."""
    from . import tools as T
    at = T._at(args)
    probe = getattr(ctx, 'media_probe', None)
    if not probe:
        return no_probe('audio_sample')
    stream, how = pick_stream(args, probe, 'audio')       # a wrong index raises ValueError: 'bad arguments', nothing run
    if stream is None:
        return T.ToolResult('unavailable', 'audio_sample: the probe result of this file lists no audio stream; nothing was run', mode='remote')
    q = plan_call(ctx, AUDIO_WINDOW_S, [stream])
    if q['quota_bytes'] is None:
        return unavailable('audio_sample', q)
    opts = ['--at', at, '--window', AUDIO_WINDOW_S] + (['--audio-first'] if how == 'first' else ['--stream', stream['index']])
    receipt, wav = run_for_ctx(ctx, 'audio', opts, q, AUDIO_WINDOW_S)
    if receipt['exit_code'] == 'timeout':
        return T.ToolResult('timeout', 'timeout', mode='remote', quota=measure('audio', AUDIO_WINDOW_S, q, receipt))
    if receipt['exit_code'] == 'error':
        return T.ToolResult('error', 'error: %s' % (receipt.get('error') or 'the sampler could not run the operation'), mode='remote')
    m = measure('audio', AUDIO_WINDOW_S, q, receipt)
    note = shortfall(m, AUDIO_WINDOW_S, 'audio')
    chosen = {'index': stream['index'], 'selection': 'the first audio stream (0:a:0)' if how == 'first' else 'the stream index given'}
    stats = T.wav_stats(wav)
    if stats is None:
        out = {'exit_code': receipt['exit_code'], 'note': 'no audio produced', 'stream': stream['index']}
        out.update(window_fields(m))
        if m['quota_exhausted']:
            # the read was cut: the decoder's own messages about it are a limit of the read, not a finding about the file
            out['scope_limit'] = note
            return T.ToolResult('partial', out, mode='remote', quota=m)
        out['stderr'] = (receipt.get('stderr') or '')[:1000]
        return T.ToolResult('error', out, mode='remote', quota=m)
    stats.update(at_s=at, stream=stream['index'], stream_selection=chosen['selection'], window_s=AUDIO_WINDOW_S, out_time=m['out_time'],
                 note='signal statistics only; no speech recognition was run', **window_fields(m))
    if note:
        stats['scope_limit'] = note
    return T.ToolResult('ok' if m['window_completed'] is True else 'partial', stats, mode='remote', quota=m)


# ------------------------------------------------------------------------------------------------------------------ subtitle_sample
def tool_subtitle_sample(args, ctx):
    """`subtitle_sample {"at": s, "stream": n}` under v3-remote-2: v3-remote-1's tool with the per-file quota and the same stream check as audio_sample."""
    from . import tools as T
    extra = sorted(set(args or {}) - {'at', 'ss', 't', 'stream'})
    if extra:
        raise ValueError('subtitle_sample takes {"at": seconds} and optionally {"stream": n} only (unexpected %s)' % extra)
    at = T._at(args or {})
    probe = getattr(ctx, 'media_probe', None)
    if not probe:
        return T.ToolResult('unavailable', 'subtitle_sample needs the probe result of this file (to choose a stream and to size the read from the file\'s own data); this '
                            'case has none. Nothing was run and no subtitle text was observed.', mode='remote')
    picked, how = pick_stream(args or {}, probe, 'subtitle')
    if picked is None:
        return T.ToolResult('unavailable', 'no text subtitle stream (%s) is listed in the probe result of this case; nothing was run and no subtitle text was observed'
                            % ', '.join(RE.TEXT_SUBTITLE_CODECS))
    stream = stream_summary(picked)
    bad = T._need_media(ctx)
    if bad:
        return bad
    window = SUBTITLE_WINDOW_S
    q = plan_call(ctx, window, [picked])
    if q['quota_bytes'] is None:
        return unavailable('subtitle_sample', q)
    receipt, data = run_for_ctx(ctx, 'subtitle', ['--at', at, '--stream', stream['index'], '--window', window], q, window)
    m = measure('subtitle', window, q, receipt)
    ec, timed_out, quota_hit = receipt['exit_code'], receipt['timed_out'], receipt['quota_exhausted']
    if receipt.get('error') or ec not in (0, 'timeout'):
        return T.ToolResult('error', {'exit_code': ec, 'stderr': ((receipt.get('stderr') or receipt.get('error') or '')[:1500]),
                                      'note': 'the subtitle extraction failed; no cue was delivered'}, mode='remote', quota=m)
    cues, problem = RE.parse_srt(data or b'', cut=timed_out or quota_hit)
    if problem:
        return T.ToolResult('error', 'subtitle_sample failed: could not run (the subtitle output could not be read as SRT: %s); no cue was delivered' % problem,
                            mode='remote', quota=m)
    scope = None
    if timed_out:
        scope = 'the sampler stopped at its %d s limit: only the cues before that point were read' % RE.SAMPLER_TIMEOUT_S
    elif quota_hit:
        scope = ('the sampler reached its per-file input limit of %d bytes (computed from this file\'s size and bitrate): only the cues before that point were read. '
                 'That is a limit of this read, not evidence that the file is corrupt' % m['quota_bytes'])
    if not cues:
        what = 'the sampled window %g-%g s of stream %d (%s) held no subtitle cue' % (at, at + window, stream['index'], stream['codec'])
        if timed_out:
            return T.ToolResult('timeout', '%s before the sampler stopped at its %d s limit; no subtitle text was observed' % (what, RE.SAMPLER_TIMEOUT_S), mode='remote', quota=m)
        return T.ToolResult('unavailable', '%s%s; no subtitle text was observed' % (what, ' before the per-file input limit of %d bytes was reached' % m['quota_bytes']
                                                                                       if quota_hit else ''), mode='remote', ran=True, quota=m)
    status = 'timeout' if timed_out else ('partial' if quota_hit or len(cues) > RE.MAX_CUES else 'ok')
    out = RE.cue_output({'index': stream['index'], 'codec': stream['codec'], 'language': stream.get('language')}, at, window, cues, scope)
    out.update(window_fields(m))
    return T.ToolResult(status, out, mode='remote', quota=m)


# ------------------------------------------------------------------------------------------------------------------ what the model is told before it calls
def capability(ctx, cap, name):
    """The advertisement of decode_sample / audio_sample / subtitle_sample for a remote file under v3-remote-2 (from the fixture and the probe result only)."""
    probe = getattr(ctx, 'media_probe', None)
    cap.update(backend='remote', available=True)
    if name == 'decode_sample':
        cap.update(window_s=DECODE_WINDOW_S, full_decode='not_possible (the remote sampler reads a bounded window under a per-file input limit and runs 25 s)')
        selected = (RQ.streams_of_type(probe, 'video')[:1] + audio_streams(probe)[:1]) if probe else []
    elif name == 'frame_sample':
        video = RQ.streams_of_type(probe, 'video') if probe else []
        cap.update(offsets_s='any', window_s=FRAME_WINDOW_S, window_role=FRAME_WINDOW_ROLE,
                   note='a frame is found by seeking and decoding from the keyframe before the offset; the input limit below is sized for a %g s lead-in at this file\'s '
                        'own bitrate (a starting value: the probe lists no keyframe interval). A call that produces no frame because it reached that limit says so, and '
                        'that is not evidence of corruption' % FRAME_WINDOW_S)
        selected = video[:1]
        if probe and not video:
            cap.update(available=False, why='the probe result of this item lists no video stream')
    elif name == 'audio_sample':
        streams = audio_streams(probe) if probe else []
        cap.update(window_s=AUDIO_WINDOW_S, offsets_s='any',
                   args='{"at": seconds, "stream": n}: "stream" is optional. Omitted, the first audio stream (0:a:0) is read. Given, it is the ABSOLUTE stream index that ffprobe '
                        'lists and must be an audio stream; a wrong index returns an error that names the audio stream indexes, and nothing is run. Audio stream indexes of this '
                        'file: %s' % (indexes(streams) or 'none (its probe result lists no audio stream)'),
                   audio_streams=[stream_summary(s) for s in streams])
        selected = streams[:1]
        if probe and not streams:
            cap.update(available=False, why='the probe result of this item lists no audio stream')
    else:
        streams = text_subtitle_streams(probe) if probe else []
        cap.update(args='{"at": seconds, "stream": n}: %d s window from that offset. "stream" is optional: omitted, the first text subtitle stream (%s) of the probe result; given, it is the '
                        'ABSOLUTE stream index ffprobe lists and must be a text subtitle stream (indexes: %s), else an error names them and nothing is run'
                        % (SUBTITLE_WINDOW_S, ', '.join(RE.TEXT_SUBTITLE_CODECS), indexes(streams) or 'none'), window_s=SUBTITLE_WINDOW_S, offsets_s='any',
                   stream_candidates=[stream_summary(s) for s in streams])
        selected = streams[:1]
        if probe and not streams:
            cap.update(backend=None, available=False, why='the probe result of this item lists no text subtitle stream')
    if not probe:
        cap.update(available=False, why='the case has no probe result to choose a stream from and to size the read from')
        return cap
    if cap.get('available') and selected:
        q = plan_call(ctx, cap['window_s'], selected)
        if q['quota_bytes'] is None:
            cap.update(available=False, why='quota_basis: unavailable (%s)' % q['reason'])
        else:
            cap['input_limit_bytes'] = q['quota_bytes']
            cap['input_limit'] = 'computed for this file from its size and bitrate (%s), not a fixed number' % q['quota_basis']
    return cap
