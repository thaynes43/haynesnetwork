"""Live, bounded, read-only evidence collectors for the media repair harness (OpenProject #138).

    from media_repair_harness.evidence import collect, to_tool_result
    records = collect('/path/to/file.mkv', ['probe', 'decode'], {'segments': 2})

See tools/media-repair-harness/docs/evidence-collectors.md for the record shape, the bounds and the limits.  Wired into tools.py / run.py from harness dev-c2 as the
opt-in `--evidence live` mode; the collectors themselves know nothing about cases.
"""
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from .core import (BOUND_SPEC, HARNESS_TOOL, KINDS, STATUSES, Ctx, RunResult, as_replay, fingerprint, make_record, resolve_bounds,
                   subprocess_runner, to_tool_result, kill_active)
from . import avtools, epubtool

__all__ = ['collect', 'load_replay', 'to_tool_result', 'KINDS', 'STATUSES', 'BOUND_SPEC', 'RunResult', 'subprocess_runner', 'resolve_bounds', 'kill_active']


def load_replay(source):
    """A replay table {kind: record} from a records list, a {kind: record} dict, or a JSON file holding either."""
    if isinstance(source, (str, Path)):
        source = json.loads(Path(source).read_text())
    if isinstance(source, dict) and 'records' in source:
        source = source['records']
    if isinstance(source, dict):
        return dict(source)
    return {r['tool']: r for r in source}


def _inputs(path):
    """Absolute paths.  Subprocesses run with the scratch dir as cwd, so a relative path would point at the wrong place, and an
    absolute path can never be read by ffmpeg as an option (a name starting with '-') or as a protocol ('concat:', 'http:')."""
    if isinstance(path, (list, tuple)):
        return [Path(os.path.abspath(os.fspath(p))) for p in path]
    return [Path(os.path.abspath(os.fspath(path)))]


def _fingerprint(inputs, max_files):
    """Partial fingerprint (size, head and tail hashes) of a file, or of the parts of a multi-file input; None if nothing is readable."""
    if len(inputs) == 1 and inputs[0].is_file():
        return fingerprint(inputs[0])
    if len(inputs) == 1 and inputs[0].is_dir():
        files, _ign, _over = avtools.audiobook_parts(inputs, max_files)
    else:
        files = [p for p in inputs if p.is_file()][:max_files]
    if not files:
        return None
    prints = [fp for fp in (fingerprint(p) for p in files) if fp]   # an unreadable part has no fingerprint
    if not prints:
        return None
    return {'kind': 'files', 'count': len(prints), 'files': prints, 'partial_fingerprint_only': True}


def collect(path, kinds=None, bounds=None, *, runner=None, which=None, replay=None, scratch_dir=None, clock=time.monotonic, cancel=None, coverage_union=False):
    """Collect evidence about `path` and return one record per kind (order kept); never raises for a bad input.

    path     a file; for 'audiobook' also a folder of parts or a list of part files
    kinds    subset of KINDS (default all); an unknown kind raises ValueError
    bounds   overrides of core.BOUND_SPEC (clamped to the hard maxima; unknown names raise ValueError)
    runner   subprocess runner (tests inject a fake); which = shutil.which replacement
    replay   recorded records (see load_replay): kinds present there are served as mode `replay`, the rest run live
    cancel   a threading.Event; once set no further subprocess is started (the caller's own timeout fired)
    coverage_union   True (tools behaviour v2): `decoded_s` / `sampled_fraction` of a sampled decode are the union of the windows, so overlapping windows are not counted twice
    """
    kinds = list(kinds) if kinds else list(KINDS)
    for k in kinds:
        if k not in KINDS:
            raise ValueError('unknown evidence kind %r (known: %s)' % (k, ', '.join(KINDS)))
    resolved, clamped = resolve_bounds(bounds)
    table = load_replay(replay) if replay is not None else {}
    inputs = _inputs(path)
    fp = _fingerprint(inputs, int(resolved['max_files']))
    out = []
    with tempfile.TemporaryDirectory(prefix='mrh-evidence-', dir=scratch_dir) as scratch:
        ctx = Ctx(str(inputs[0]) if len(inputs) == 1 else str(inputs[0].parent), resolved, runner or subprocess_runner, which or shutil.which, scratch, clock, cancel, coverage_union)
        for p_ in inputs:
            ctx.add_name(str(p_))
        for kind in kinds:
            started = clock()
            if kind in table:
                rec = as_replay(table[kind], fp)
            else:
                rec = _run_one(kind, ctx, started, inputs)
            rec['input'] = fp
            if clamped:
                rec['bounds_clamped'] = clamped
            out.append(rec)
    return out


def _run_one(kind, ctx, started, inputs):
    try:
        if kind == 'audiobook':
            if not all(p.exists() for p in inputs):
                return make_record(kind, 'live', 'error', ctx, started, cause='input', reason='input does not exist',
                                   coverage={'verified': [], 'not_verified': ['everything: no input']})
            return avtools.collect_audiobook(ctx, started, inputs)
        if len(inputs) != 1 or not inputs[0].is_file():
            why = 'input does not exist' if not inputs[0].exists() else '%s takes one regular file' % kind
            return make_record(kind, 'live', 'error', ctx, started, cause='input', reason=why,
                               coverage={'verified': [], 'not_verified': ['everything: %s' % why]})
        fn = {'probe': avtools.collect_probe, 'decode': avtools.collect_decode, 'frames': avtools.collect_frames,
              'audio': avtools.collect_audio, 'epub': epubtool.collect_epub}[kind]
        return fn(ctx, started)
    except Exception as e:  # noqa: BLE001 - collector boundary: report, never crash the caller
        return make_record(kind, 'live', 'error', ctx, started, cause='tool', reason='collector crashed: %s: %s' % (type(e).__name__, ctx.scrub(str(e))[:200]),
                           coverage={'verified': [], 'not_verified': ['everything: the collector failed']})
