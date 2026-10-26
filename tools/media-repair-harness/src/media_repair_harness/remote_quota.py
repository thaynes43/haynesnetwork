"""The per-file input quota of tools behaviour `v3-remote-2` (#213): computed from the file's OWN measured data, never from a guessed global number.

The sampler reads the media over a loopback range server and stops after a fixed number of bytes (the input quota).  A fixed 8 MiB is below what a 4 s window
of a high-bitrate file needs (a 28 Mbit/s Blu-ray remux holds about 14 MB in 4 s), so the window never decoded.  Here the quota is derived per call:

    quota_bytes = ceil(window_s * bitrate_bps / 8 * margin) + overhead_bytes        (then raised to the floor, and lowered to the file size)

`bitrate_bps` is the LARGEST of the measured values available for THIS file: the container average (`size_bytes * 8 / duration_s`, from the file's stat
identity and its probe), the probe's `format.bit_rate`, and the sum of the Matroska per-track `BPS` / `BPS-eng` tags of the streams the call reads.  The source
that won and every input are recorded.  A file whose size or duration is missing or unparsable gets NO quota: `quota_basis: unavailable`, and the caller runs
nothing.

`margin` and `overhead_bytes` are named, versioned parameters (PARAMETERS) recorded in every receipt.  They are STARTING VALUES, not known truths: the receipt of
every call measures whether the window completed (`window_completed`, from the decoded output time the sampler records), so a quota that is still too small shows
up as a measured shortfall.  Nothing here is read from a label, a truth field or a file name; every value comes from the stat identity and the probe.

Exact arithmetic (fractions) and integer inputs make the result deterministic: the same inputs always give the same quota, and the recorded inputs reproduce it.
"""
import math
from fractions import Fraction

QUOTA_RULE = 'dynamic-quota-1'
FLOOR_BYTES = 8 * 1024 * 1024         # what every earlier sampler reads at most: a small file never gets less than today
MARGIN = '2.0'                        # STARTING VALUE: the peak 4 s of a variable-bitrate file can hold more than its average; checked by window_completed
PROBE_READ_BYTES = 5000000            # the sampler's own `-probesize 5000000` (remote_sampler_v4.py argv): ffmpeg may read this much before it seeks
INDEX_ALLOWANCE_BYTES = 1048576       # STARTING VALUE for the container header, seek index and the read back to a keyframe; the container metadata of a probe
                                      # (ffprobe) does not give these sizes, so it is not measurable here; checked by window_completed
OVERHEAD_BYTES = PROBE_READ_BYTES + INDEX_ALLOWANCE_BYTES
WINDOW_TOLERANCE_S = 0.25             # STARTING VALUE: a decoded output time within this of the requested window counts as the window completed
TRACK_BPS_TAGS = ('BPS', 'BPS-eng')   # Matroska per-track statistics tags, in order of preference
SOURCES = ('container_average', 'format_bit_rate', 'track_bps_sum')       # tie-break order when two sources give the same rate
UNAVAILABLE = 'unavailable'

PARAMETERS = {'rule': QUOTA_RULE, 'formula': 'ceil(window_s * bitrate_bps / 8 * margin) + overhead_bytes, then max(floor, min(that, size_bytes))',
              'margin': MARGIN, 'overhead_bytes': OVERHEAD_BYTES,
              'overhead_parts': {'probe_read_bytes': PROBE_READ_BYTES, 'index_allowance_bytes': INDEX_ALLOWANCE_BYTES},
              'floor_bytes': FLOOR_BYTES, 'window_tolerance_s': WINDOW_TOLERANCE_S, 'bitrate_sources': list(SOURCES),
              'track_bps_tags': list(TRACK_BPS_TAGS), 'starting_values': ['margin', 'index_allowance_bytes', 'window_tolerance_s']}


def positive_number(value):
    """-> an exact positive Fraction from an int, a finite float or a plain decimal string (ffprobe prints numbers as strings); None otherwise.  A bool, a
    negative or zero value, NaN, infinity and text that is not a plain decimal are all None."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        if isinstance(value, float):
            if not math.isfinite(value):
                return None
            number = Fraction(value)
        elif isinstance(value, int):
            number = Fraction(value)
        elif isinstance(value, str):
            text = value.strip()
            if not text or not all(c.isdigit() or c == '.' for c in text) or text.count('.') > 1 or text in ('.',):
                return None
            number = Fraction(text)
        else:
            return None
    except (ValueError, ZeroDivisionError, OverflowError):
        return None
    return number if number > 0 else None


def _ceil_int(fraction):
    return int(math.ceil(fraction))


def probe_parts(probe):
    """-> (format dict, streams list) of a parsed probe object ({"format": {...}, "streams": [...]}); empty when it is not one."""
    fmt = probe.get('format') if isinstance(probe, dict) and isinstance(probe.get('format'), dict) else {}
    streams = probe.get('streams') if isinstance(probe, dict) and isinstance(probe.get('streams'), list) else []
    return fmt, [s for s in streams if isinstance(s, dict)]


def stream_index(stream):
    idx = stream.get('index')
    return idx if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < 128 else None


def streams_of_type(probe, codec_type):
    """The streams of one type in the order the probe lists them (the order ffmpeg numbers `0:v:n`, `0:a:n`)."""
    return [s for s in probe_parts(probe)[1] if s.get('codec_type') == codec_type and stream_index(s) is not None]


def track_bps(stream):
    """-> (bps int, tag name) from a stream's Matroska `BPS` / `BPS-eng` tag, or (None, None)."""
    tags = stream.get('tags') if isinstance(stream.get('tags'), dict) else {}
    lowered = {str(k).upper(): v for k, v in tags.items()}
    for name in TRACK_BPS_TAGS:
        value = positive_number(lowered.get(name.upper()))
        if value is not None:
            return _ceil_int(value), name
    return None, None


def plan(size_bytes, probe, window_s, selected):
    """The quota record of one call: `size_bytes` from the file's stat identity, `probe` the case's parsed probe object, `window_s` the requested window,
    `selected` the probe streams this call reads.  -> a dict that always carries `quota_basis` (the winning source, or 'unavailable'), `quota_bytes` (None when
    unavailable) and `quota_inputs` (every input), plus the parameters used."""
    fmt, _streams = probe_parts(probe)
    size = Fraction(size_bytes) if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes > 0 else None     # a stat size is an exact integer
    duration = positive_number(fmt.get('duration'))
    window = positive_number(window_s)
    inputs = {'size_bytes': size_bytes if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) else None,
              'duration_s': fmt.get('duration') if duration is not None else None, 'probe_size_bytes': fmt.get('size'),
              'selected_streams': [stream_index(s) for s in selected]}
    record = {'quota_rule': QUOTA_RULE, 'window_s': window_s, 'margin': MARGIN, 'overhead_bytes': OVERHEAD_BYTES, 'floor_bytes': FLOOR_BYTES,
              'quota_inputs': inputs, 'quota_basis': UNAVAILABLE, 'quota_bytes': None}
    if size is None:
        record['reason'] = 'the size of the file is not known (no stat identity size); no read limit is computed'
        return record
    if duration is None:
        record['reason'] = ('the duration of the file is missing or unparsable in its probe (format.duration %r); no read limit is computed' % (fmt.get('duration'),))
        return record
    if window is None:
        record['reason'] = 'the requested window %r is not a positive number' % (window_s,)
        return record
    container_average = _ceil_int(size * 8 / duration)
    format_bit_rate = positive_number(fmt.get('bit_rate'))
    format_bit_rate = None if format_bit_rate is None else _ceil_int(format_bit_rate)
    tracks, missing = [], []
    for stream in selected:
        bps, tag = track_bps(stream)
        if bps is None:
            missing.append(stream_index(stream))
        else:
            tracks.append({'stream': stream_index(stream), 'tag': tag, 'bps': bps})
    track_sum = sum(t['bps'] for t in tracks) if tracks else None
    candidates = {'container_average': container_average, 'format_bit_rate': format_bit_rate, 'track_bps_sum': track_sum}
    best = max(v for v in candidates.values() if v is not None)
    source = next(name for name in SOURCES if candidates[name] == best)
    inputs.update(container_average_bps=container_average, format_bit_rate_bps=format_bit_rate, track_bps=tracks, track_bps_sum=track_sum,
                  tracks_without_bps=missing, bitrate_bps=best)
    raw = _ceil_int(window * best / 8 * Fraction(MARGIN)) + OVERHEAD_BYTES
    quota = max(FLOOR_BYTES, min(raw, int(size)))
    if quota == FLOOR_BYTES and (raw < FLOOR_BYTES or int(size) < FLOOR_BYTES):
        clamped = 'floor'            # also a file smaller than the floor: the floor applies (it cannot read more than the file holds)
    elif raw > int(size):
        clamped = 'file_size'
    else:
        clamped = None
    record.update(quota_basis=source, quota_bytes=quota, raw_bytes=raw, clamped=clamped)
    return record


def window_check(mode, window_s, exit_code, quota_exhausted, timed_out, out_time_s):
    """-> (window_completed True/False/None, how it was measured).  decode and audio: the decoded output time the sampler recorded reaches the requested window
    within WINDOW_TOLERANCE_S (None when ffmpeg reported no output time: not measured, not guessed).  subtitle: a sparse stream's last cue time says nothing
    about how far the read got, so the window counts as completed only when the read itself ran to its end (exit 0, quota not exhausted, no timeout)."""
    if mode == 'subtitle':
        return (exit_code == 0 and quota_exhausted is False and timed_out is False), 'read_not_cut'
    if not isinstance(out_time_s, (int, float)) or isinstance(out_time_s, bool) or not math.isfinite(out_time_s):
        return None, 'out_time_unavailable'
    return out_time_s + WINDOW_TOLERANCE_S >= float(window_s), 'out_time'


def clock(seconds):
    """Seconds -> ffmpeg's HH:MM:SS.ffffff form (the typed layer reads a decode result's `out_time` in this form); None stays None."""
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(seconds) or seconds < 0:
        return None
    return '%02d:%02d:%09.6f' % (seconds // 3600, (seconds % 3600) // 60, seconds % 60)
