"""Truth-free "scan" cases (OpenProject #213): the validator for them, and the refusal that keeps the scorer away from them.

A series scan (`scripts/series_scan.py`) turns real library files into harness cases that have NO ground truth: `truth` is null and `supported_actions` is
empty.  That is allowed ONLY for `split == "scan"`; every other split keeps the evaluator's rule (a truth class and at least one supported action), which is
checked by the evaluator-owned `suite.py`, not here.  Nothing in this module reads the evaluator's files, and nothing here is imported by the runner: the
runner never looks at `truth` or `supported_actions` for its decision (the leak guard reads them with `or {}` / `or []`).

The scorer is evaluator-owned and cannot be edited (and `score_compat.py` is hash-pinned), so the `mrh-score` console script is `score_main` here, which calls `refuse_scan_arguments` first: a run directory or a suite that
holds scan cases is refused with a clear message instead of a KeyError deep inside score.py.
"""
import json
from pathlib import Path

SPLIT = 'scan'
SUITE_VERSION = 'scan-v1'
SUITE_KIND = 'series-scan'
MEDIA_TYPE = 'tv'
REQUIRED = ('id', 'suite_version', 'split', 'media_type', 'family', 'truth', 'supported_actions', 'solvable', 'context', 'fixture', 'evidence',
            'tools_available')
# the remote-capable tools a scan case may offer (no arr_lookup: a scan has no Sonarr data; no ocr, no epub tools)
SCAN_TOOLS = ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'subtitle_sample')
# no `filename`: the real file name is a forbidden token of the leak guard (a remote fixture's basename), so the model sees the parsed `expected` fields only
CONTEXT_KEYS = ('title', 'expected', 'arr', 'notes_for_model')


class ScanRefused(SystemExit):
    """Raised (as a SystemExit with the message) when a scan case reaches the scorer."""


def is_scan_case(case):
    return isinstance(case, dict) and case.get('split') == SPLIT


def validate_scan_case(case):
    """-> list of error strings (empty = valid).  The rules of a truth-free case; it is NOT the evaluator's suite validator."""
    if not isinstance(case, dict):
        return ['the case is not an object']
    errs = ['missing key %r' % k for k in REQUIRED if k not in case]
    if errs:
        return errs
    if case['split'] != SPLIT:
        errs.append('split must be %r (a null truth is allowed only there), got %r' % (SPLIT, case['split']))
    if case['suite_version'] != SUITE_VERSION:
        errs.append('suite_version must be %r' % SUITE_VERSION)
    if case['truth'] is not None:
        errs.append('truth must be null: a scan case carries no ground truth')
    if case['supported_actions'] != []:
        errs.append('supported_actions must be []: a scan case supports no action')
    if case['media_type'] != MEDIA_TYPE:
        errs.append('media_type must be %r' % MEDIA_TYPE)
    if not isinstance(case['id'], str) or not case['id'].startswith('scan-'):
        errs.append('id must start with "scan-"')
    for extra in ('outcome_step', 'accepted_classes', 'inject_tool_failure', 'corrections'):
        if extra in case:
            errs.append('a scan case has no %r (scoring and injection fields)' % extra)
    tools = case['tools_available']
    if not isinstance(tools, list) or not tools or any(t not in SCAN_TOOLS for t in tools) or len(set(tools)) != len(tools):
        errs.append('tools_available must be distinct tools from %s' % (list(SCAN_TOOLS),))
    ctx = case['context']
    if not isinstance(ctx, dict) or not isinstance(ctx.get('expected'), dict) or ctx.get('arr') != {} or not ctx.get('notes_for_model'):
        errs.append('context needs expected{}, arr == {} (no Sonarr data) and notes_for_model')
    elif set(ctx) - set(CONTEXT_KEYS):
        errs.append('context has keys outside %s' % (list(CONTEXT_KEYS),))
    fx = case['fixture']
    if not (isinstance(fx, dict) and fx.get('kind') == 'remote' and str(fx.get('locator', '')).startswith('remote:')):
        errs.append('fixture must be a remote: locator')
    else:
        if not (isinstance(fx.get('allowed_root'), str) and fx['allowed_root'].startswith('/')):
            errs.append('fixture.allowed_root must be an absolute path')
        ident = fx.get('expected_identity')
        if not (isinstance(ident, dict) and all(isinstance(ident.get(k), int) and not isinstance(ident.get(k), bool) for k in ('size', 'mtime_ns', 'dev', 'ino'))):
            errs.append('fixture.expected_identity must hold integer size, mtime_ns, dev and ino')
        if not (isinstance(fx.get('expected_hostname'), str) and fx['expected_hostname']):
            errs.append('fixture.expected_hostname must be set')
    if not isinstance(case['evidence'], list):
        errs.append('evidence must be a list')
    return errs


def _suite_dir_of(path):
    p = Path(path)
    return p / 'cases' if (p / 'cases').is_dir() else p


def _cases_in(path):
    d = _suite_dir_of(path)
    if not d.is_dir():
        return
    for f in sorted(d.glob('*.json')):
        try:
            c = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(c, dict):
            yield c


def holds_scan_cases(suite):
    """True when the suite directory carries a series-scan manifest or any case with split == scan."""
    base = Path(suite)
    try:
        man = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
        if isinstance(man, dict) and man.get('kind') == SUITE_KIND:
            return True
    except (OSError, ValueError):
        pass
    return any(is_scan_case(c) for c in _cases_in(base))


def run_holds_scan_records(run_dir):
    """True when a run directory's records (or its manifest's suite) are scan cases."""
    base = Path(run_dir)
    if not base.is_dir():
        return False
    for f in sorted(base.glob('*.json')):
        if f.name in ('manifest.json', 'run_summary.json'):
            continue
        try:
            rec = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and rec.get('split') == SPLIT:
            return True
    try:
        man = json.loads((base / 'manifest.json').read_text(encoding='utf-8'))
        sd = man.get('suite_dir') if isinstance(man, dict) else None
        return bool(sd) and holds_scan_cases(sd)
    except (OSError, ValueError):
        return False


def refuse_scan_arguments(argv):
    """Called by `mrh-score` before the evaluator's scorer is loaded.  `argv` is score.py's command line (`run_dir --suite DIR [...]`).  Raises ScanRefused."""
    args = list(argv or [])
    suite = None
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--suite' and i + 1 < len(args):
            suite = args[i + 1]
            i += 2
            continue
        if a.startswith('--suite='):
            suite = a.split('=', 1)[1]
        elif not a.startswith('-'):
            positional.append(a)
        elif a in ('--only', '--out') and i + 1 < len(args):
            i += 1
        i += 1
    why = None
    if suite and holds_scan_cases(suite):
        why = 'the suite %s holds series-scan cases' % suite
    elif positional and run_holds_scan_records(positional[0]):
        why = 'the run directory %s holds series-scan records' % positional[0]
    if why:
        raise ScanRefused('refusing to score: %s. Scan cases are truth-free (truth null, no supported actions); a scan is never scored. '
                          'Use scripts/series_scan.py report instead.' % why)


def score_main(argv=None):
    """The `mrh-score` console entry point: refuse a scan suite or run, then hand over to the unchanged `score_compat.main` (the evaluator's scorer)."""
    import sys
    refuse_scan_arguments(sys.argv[1:] if argv is None else argv)
    from . import score_compat
    return score_compat.main(argv)
