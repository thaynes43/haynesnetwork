#!/usr/bin/env python3
"""Read-only series scan driver (OpenProject #213).

Turns every video file of ONE TV series folder on the media share into a truth-free harness case, runs the existing runner over those cases with the local
model, and aggregates a findings report.  Four subcommands, each a separate step with its own output, all under one PRIVATE directory (outside git):

  discover  list the series folder through the remote sampler (kubectl exec into the media pod: `list` for each season folder, `stat` and `probe` per
            video, every one bound to the file's identity) -> <out>/discovery.json
  build     discovery.json -> <out>/suite/ (cases/<id>.json + manifest.json): one truth-free case per file, split "scan", no model, no network
  run       prints (or with --execute runs) the runner command for Ollama Prime over the suite; resumable by batch
  report    <run dirs> + discovery.json -> <out>/report.md (private) and <out>/summary.json (counts only, safe to commit)

Nothing here writes to media, the catalog, *arr, Plex or the cluster: the sampler is read-only (`mrh-sampler-2`: O_NOFOLLOW opens, descriptor-confined
paths, fail-closed receipts) and `kubectl` is only ever called as `exec ... python3 - <sampler mode>`.  Sidecar subtitle files are listed by name and never
read.  Case ids are `scan-sSSeEEE-<8 hex of sha256(path)>`; case files, discovery and the report hold real library paths and titles, so --out refuses a
directory inside a git work tree.  See docs/series-scan.md.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shlex
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))


def _driver_v1():
    """The #161 Stage R driver module, loaded once under the name stage_r_driver_v2.py uses; its listing check and probe evidence are reused unchanged."""
    mod = sys.modules.get('stage_r_driver_v1')
    if mod is None:
        spec = importlib.util.spec_from_file_location('stage_r_driver_v1', HERE / 'stage_r_driver.py')
        mod = importlib.util.module_from_spec(spec)
        sys.modules['stage_r_driver_v1'] = mod
        spec.loader.exec_module(mod)
    return mod


D1 = _driver_v1()
RE, R, Stop = D1.RE, D1.R, D1.Stop

from media_repair_harness import leakguard  # noqa: E402
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import scan_suite as SS  # noqa: E402

DRIVER_VERSION = 'series-scan-1'
DISCOVERY_VERSION = 'series-scan-discovery-1'
VIDEO_EXT = ('.mkv', '.mp4', '.avi', '.m4v')
SUB_EXT = ('.srt', '.ass')
SEASON_DIR = re.compile(r'^(?:Season|Series)\s*0*(\d+)$', re.IGNORECASE)
TOLERATED_FILE_STOPS = ('identity_mismatch', 'source_changed')      # one file changed under us: that file is skipped and recorded, the scan goes on
DEFAULT_DISCOVER_WALL_S = 3600.0
EXIT_OK, EXIT_BAD, EXIT_STOP = 0, 2, 3

# ---------------------------------------------------------------------------------------------------------------------------------- run options
MODEL = 'qwen3.8:27b'
RUN_OPTIONS = ['--adapter', 'ollama', '--model', MODEL, '--num-ctx', '16384', '--context-policy', 'ctx16k-v1', '--gpu-fit-check', 'full-gpu-v2',
               '--keep-alive', '10m', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--evidence', 'replay',
               '--tools-behavior', 'v3-remote-1', '--tool-output-bytes', '8192', '--no-spend-limit']
BASE_WALL_S = 900          # a model load and warm-up
PER_CASE_WALL_S = 240      # six tool calls (each bounded at 60 s) and up to eight model turns
NOTES = ('A library file is attached to the entry below. From the evidence and tools, decide what is wrong with it, if anything, and which action the '
         'evidence supports.')
NO_ARR_NOTE = 'No Sonarr data is available for this file.'
UNPARSED_NOTE = ('The file name does not follow the "<Series> (<year>) - SxxEyy - <Title>" pattern, so no expected series, season, episode or title could be '
                 'read from it.')
DOUBLE_NOTE = 'The file name covers two consecutive episodes (episode_end is the last).'

NAME_RX = re.compile(r'^(?P<series>.+?) \((?P<year>\d{4})\) - S(?P<season>\d{1,2})E(?P<ep>\d{1,3})(?:-?E(?P<ep2>\d{1,3}))? - (?P<title>.+)$')


# ---------------------------------------------------------------------------------------------------------------------------------- small helpers
def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def dumps(obj):
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + '\n'


def write_text(path, text):
    Path(path).write_text(text, encoding='utf-8')


def inside_git(path):
    """True when `path` (existing or not) lies inside a git work tree: the private directory must not."""
    p = Path(path).expanduser().resolve()
    for q in [p] + list(p.parents):
        if (q / '.git').exists():
            return True
    return False


def private_dir(path, allow_git=False):
    p = Path(path).expanduser()
    if inside_git(p) and not allow_git:
        raise SystemExit('refusing --out %s: it is inside a git work tree. The scan holds real library paths and titles; use a private directory outside git '
                         '(for example ~/media-scan-213).' % p)
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    return p


def video_ext(name):
    return os.path.splitext(name)[1].lower() in VIDEO_EXT


def parse_name(basename):
    """A Sonarr-style name -> {series, year, season, episode, episode_end, episode_title}; None when it does not follow the pattern."""
    stem, ext = os.path.splitext(basename)
    m = NAME_RX.match(stem)
    if not m or ext.lower() not in VIDEO_EXT:
        return None
    ep, ep2 = int(m.group('ep')), (int(m.group('ep2')) if m.group('ep2') else None)
    if ep2 is not None and ep2 <= ep:
        return None
    return {'series': m.group('series'), 'year': int(m.group('year')), 'season': int(m.group('season')), 'episode': ep, 'episode_end': ep2,
            'episode_title': m.group('title')}


def case_id(path, parsed):
    h = sha256_bytes(path.encode('utf-8'))[:8]
    if parsed is None:
        return 'scan-unparsed-%s' % h
    return 'scan-s%02de%03d-%s' % (parsed['season'], parsed['episode'], h)


def parse_target(target):
    parts = target.split('/')
    if len(parts) not in (2, 3) or not all(re.fullmatch(r'[a-z0-9]([-a-z0-9.]*[a-z0-9])?', x) for x in parts):
        raise SystemExit('--target must be <namespace>/<deployment>[/<container>], got %r' % target)
    return {'namespace': parts[0], 'deployment': parts[1], 'container': parts[2] if len(parts) == 3 else 'app'}


def clean_abs(path, what):
    ok = isinstance(path, str) and path.startswith('/') and '\n' not in path and '\0' not in path and os.path.normpath(path) == (path.rstrip('/') or '/')
    if not ok:
        raise SystemExit('%s must be an absolute, normalised path, got %r' % (what, path))
    return path.rstrip('/') or '/'


# ---------------------------------------------------------------------------------------------------------------------------------- discover
class Scanner:
    """The remote half of discovery.  `op` is the Stage R driver's (run_operation under the stop rules); `listing` is the Stage R driver's own listing check,
    called unchanged on this object (it only needs `op` and `dir_binding`)."""

    def __init__(self, target, root, runner, wall_s=DEFAULT_DISCOVER_WALL_S, clock=time.monotonic):
        self.ns, self.deployment, self.container = target['namespace'], target['deployment'], target['container']
        self.exec_target = 'deploy/' + self.deployment
        self.runner, self.wall_s, self.clock, self.started = runner, float(wall_s), clock, clock()
        self.host = RE.HostState()
        self.root = root
        self.dir_binding = RE.Binding(host=self.host, root=root)
        self.operations = []

    def need_time(self, phase):
        if self.clock() - self.started + RE.OUTER_DEADLINE_S > self.wall_s:
            raise Stop(phase, 'discover_deadline', 'the %.0f s discovery wall cap leaves no room for another %d s operation' % (self.wall_s, RE.OUTER_DEADLINE_S))

    def op(self, phase, binding, mode, path, opts=(), bind_identity=True, target=None):
        self.need_time(phase)
        n = len(binding.receipts)
        try:
            receipt, out = RE.run_operation(self.runner, self.ns, self.exec_target, self.container, mode, path, binding, opts, bind_identity=bind_identity)
        except RE.FatalOperation as e:
            self.operations += [{'phase': phase, 'mode': r['mode'], 'outcome': r['outcome'], 'receipt': r['receipt']} for r in binding.receipts[n:]]
            raise Stop(phase, e.kind, e.detail, target)
        self.operations += [{'phase': phase, 'mode': r['mode'], 'outcome': r['outcome'], 'receipt': r['receipt']} for r in binding.receipts[n:]]
        return receipt, out

    def listing(self, phase, path, prefix=''):
        return D1.Driver.listing(self, phase, path, prefix)

    def season_dirs(self, series_dir, season):
        top = self.listing('series', series_dir)
        found = []
        for e in top:
            if e['type'] != 'dir':
                continue
            m = SEASON_DIR.match(e['name'])
            n = int(m.group(1)) if m else (0 if e['name'].lower() == 'specials' else None)
            if n is not None:
                found.append((n, e['name']))
        if season is None:
            return sorted(found), top
        hit = [f for f in found if f[0] == season]
        if len(hit) != 1:
            raise Stop('series', 'discovery', '%d season folders match season %d, not exactly one' % (len(hit), season))
        return hit, top

    def stat_and_probe(self, path, listed, probe):
        """-> (row fragment, skipped reason or None).  The stat's start identity must equal the listing's; the probe is bound to it (G1 of the Stage R driver)."""
        b = RE.Binding(host=self.host, max_operations=2, root=self.root)
        receipt, out = self.op('stat', b, 'stat', path, bind_identity=False, target=path)
        start = receipt['identity']['start']
        if receipt['exit_code'] != 0 or start is None or start != listed:
            return None, 'the stat (exit %s) does not match the listing' % (receipt['exit_code'],)
        try:
            fp = json.loads(out)
        except ValueError:
            fp = None
        errs = D1.fingerprint_errors(fp)
        if not errs and (fp['size'], fp['mtime_ns']) != (start['size'], start['mtime_ns']):
            errs.append('the fingerprint disagrees with the receipt identity')
        if errs:
            raise Stop('stat', 'malformed_output', '; '.join(errs), path)
        frag = {'head_1m_sha256': fp['head_1m_sha256'], 'tail_1m_sha256': fp['tail_1m_sha256'], 'probe': None}
        if probe:
            b.identity = dict(start, head_1m_sha256=fp['head_1m_sha256'], tail_1m_sha256=fp['tail_1m_sha256'])
            receipt, out = self.op('probe', b, 'probe', path, ['--at', 0.0, '--stream', 0], target=path)
            frag['probe'] = D1.Driver.probe_evidence(receipt, out)
        return frag, None


def discover(args, runner=subprocess.run, clock=time.monotonic):
    out = private_dir(args.out, getattr(args, 'allow_in_git', False))
    target = parse_target(args.target)
    root = clean_abs(args.root, '--root')
    series_dir = clean_abs(args.series_dir, '--series-dir')
    if not series_dir.startswith(root.rstrip('/') + '/'):
        raise SystemExit('--series-dir %s is not below --root %s' % (series_dir, root))
    if (out / 'discovery.json').exists():
        raise SystemExit('refusing to overwrite %s; move it away first' % (out / 'discovery.json'))
    sc = Scanner(target, root, runner, args.max_wall_s, clock)
    rows, skipped, listings, seasons_found = [], [], [], []
    try:
        seasons, _top = sc.season_dirs(series_dir, args.season)
        dirs = [(n, name, series_dir + '/' + name) for n, name in seasons]
        if args.season is None:
            dirs.append((None, '', series_dir))         # video files directly in the series folder
        for n, name, path in dirs:
            entries = sc.listing('list', path) if path != series_dir else _top
            listings.append({'directory_name': name, 'entries': len(entries)})
            names = {e['name'] for e in entries}
            for e in entries:
                if not video_ext(e['name']):
                    continue
                full = path + '/' + e['name']
                if e['type'] != 'file':
                    skipped.append({'path': full, 'reason': 'a video-named entry that is not a regular file (%s)' % e['type']})
                    continue
                stem = os.path.splitext(e['name'])[0]
                side = sorted(x for x in names if x.startswith(stem + '.') and os.path.splitext(x)[1].lower() in SUB_EXT)
                rows.append({'path': full, 'basename': e['name'], 'season_folder': name, 'season_number': n,
                             'identity': {k: e[k] for k in RE.IDENTITY_FIELDS}, 'sidecar_subtitles': side})
            if name:
                seasons_found.append(name)
        rows.sort(key=lambda r: r['path'].encode('utf-8'))
        kept = []
        for i, row in enumerate(rows, 1):
            try:
                frag, why = sc.stat_and_probe(row['path'], row['identity'], not args.no_probe)
            except Stop as s:
                if s.kind in TOLERATED_FILE_STOPS:
                    skipped.append({'path': row['path'], 'reason': 'changed while scanning (%s)' % s.kind})
                    continue
                raise
            if why:
                skipped.append({'path': row['path'], 'reason': why})
                continue
            kept.append(dict(row, **frag))
            print('discover: %d/%d files checked' % (i, len(rows)), file=sys.stderr)
        if not kept:
            raise Stop('series', 'discovery', 'no video file was found and verified under %s' % series_dir)
    except Stop as s:
        failed = {'driver': DRIVER_VERSION, 'complete': False, 'stop': {'phase': s.phase, 'kind': s.kind, 'detail': s.detail}, 'files_collected': len(rows),
                  'operations': sc.operations}
        write_text(out / 'discovery-failed.json', dumps(failed))
        print('discover STOPPED (%s: %s); nothing usable was written: see %s' % (s.kind, s.detail, out / 'discovery-failed.json'), file=sys.stderr)
        return EXIT_STOP
    disc = {'discovery': DISCOVERY_VERSION, 'driver': DRIVER_VERSION, 'complete': True,
            'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'target': args.target, 'namespace': target['namespace'], 'deployment': target['deployment'], 'container': target['container'],
            'exec_target': sc.exec_target, 'allowed_root': root, 'series_dir': series_dir, 'season_filter': args.season,
            'expected_hostname': sc.host.hostname, 'probe': not args.no_probe, 'list_cap': RE.LIST_CAP, 'season_folders': seasons_found,
            'files': kept, 'skipped': skipped, 'operation_count': len(sc.operations)}
    write_text(out / 'discovery.json', dumps(disc))
    write_text(out / 'discovery-receipts.json', dumps(sc.operations))
    print('discover: %d files, %d skipped, host bound; wrote %s' % (len(kept), len(skipped), out / 'discovery.json'))
    return EXIT_OK


# ---------------------------------------------------------------------------------------------------------------------------------- build
def load_discovery(path):
    p = Path(path)
    try:
        d = json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        raise SystemExit('cannot read discovery %s: %s' % (p, e))
    if not (isinstance(d, dict) and d.get('discovery') == DISCOVERY_VERSION and d.get('complete') is True and isinstance(d.get('files'), list)):
        raise SystemExit('%s is not a complete %s file (a truncated or failed discovery is never built)' % (p, DISCOVERY_VERSION))
    if not d.get('expected_hostname'):
        raise SystemExit('%s binds no hostname' % p)
    return d


def make_case(disc, row):
    parsed = parse_name(row['basename'])
    notes = [NOTES, NO_ARR_NOTE]
    if parsed is None:
        expected = {'series': None, 'season': None, 'episode': None, 'episode_title': None}
        title = 'Library file (unparsed name)'
        notes.append(UNPARSED_NOTE)
    else:
        expected = {'series': parsed['series'], 'season': parsed['season'], 'episode': parsed['episode'], 'episode_title': parsed['episode_title']}
        title = '%s S%02dE%02d' % (parsed['series'], parsed['season'], parsed['episode'])
        if parsed['episode_end'] is not None:
            expected['episode_end'] = parsed['episode_end']
            notes.append(DOUBLE_NOTE)
    fx = {'kind': 'remote', 'locator': 'remote:%s/%s/%s:%s' % (disc['namespace'], disc['deployment'], disc['container'], row['path']),
          'exec_target': disc['exec_target'], 'max_operations': P.MAX_TOOL_CALLS, 'allowed_root': disc['allowed_root'],
          'expected_identity': dict(row['identity'], head_1m_sha256=row.get('head_1m_sha256'), tail_1m_sha256=row.get('tail_1m_sha256')),
          'expected_hostname': disc['expected_hostname']}
    evidence = [dict(row['probe'], id='e1')] if row.get('probe') else []
    case = {'id': case_id(row['path'], parsed), 'suite_version': SS.SUITE_VERSION, 'split': SS.SPLIT, 'media_type': SS.MEDIA_TYPE, 'family': 'scan',
            'truth': None, 'supported_actions': [], 'solvable': None,
            'context': {'title': title, 'expected': expected, 'arr': {}, 'notes_for_model': ' '.join(notes)},
            'fixture': fx, 'evidence': evidence, 'tools_available': list(SS.SCAN_TOOLS),
            'scan': {'season_folder': row['season_folder'], 'name_parse': 'sonarr' if parsed else 'unparsed', 'sidecar_subtitles': len(row.get('sidecar_subtitles') or [])}}
    return case


def leak_hits(case, suite_dir):
    """The model-visible view of the case (context, tools, every evidence output after redaction) through the leak guard, as the Stage R driver does."""
    path = case['fixture']['locator'].split(':', 2)[2]
    evidence = R.resolve_evidence_raw(case, str(suite_dir), lambda text: leakguard.redact(text, case, [path]))
    view = json.dumps(P.case_view(case, evidence), ensure_ascii=False, sort_keys=True)
    return leakguard.find_leaks(case, view, [path])


def build(args):
    disc_path = Path(args.discovery)
    disc = load_discovery(disc_path)
    out = private_dir(args.out, getattr(args, 'allow_in_git', False))
    suite = out / 'suite'
    if suite.exists() and any(suite.iterdir()):
        raise SystemExit('refusing to reuse a non-empty suite directory %s; remove it to rebuild' % suite)
    cases, seen = [], {}
    for row in sorted(disc['files'], key=lambda r: r['path'].encode('utf-8')):
        case = make_case(disc, row)
        if case['id'] in seen:
            raise SystemExit('case id collision on %s: %s and %s' % (case['id'], seen[case['id']], row['path']))
        seen[case['id']] = row['path']
        errs = SS.validate_scan_case(case)
        if errs:
            raise SystemExit('case %s is not a valid scan case: %s' % (case['id'], '; '.join(errs)))
        cases.append(case)
    cases.sort(key=lambda c: c['id'])
    (suite / 'cases').mkdir(parents=True, exist_ok=True)
    manifest_rows = []
    for case in cases:
        hits = leak_hits(case, suite)
        if hits:
            raise SystemExit('the leak guard flags case %s: forbidden token kinds %s; nothing was built' % (case['id'], hits))
    for case in cases:
        raw = dumps(case).encode('utf-8')
        (suite / 'cases' / (case['id'] + '.json')).write_bytes(raw)
        manifest_rows.append({'id': case['id'], 'file': 'cases/%s.json' % case['id'], 'sha256': sha256_bytes(raw), 'split': SS.SPLIT,
                              'name_parse': case['scan']['name_parse'], 'season': case['context']['expected']['season'], 'episode': case['context']['expected']['episode']})
    manifest = {'suite_version': SS.SUITE_VERSION, 'kind': SS.SUITE_KIND, 'split': SS.SPLIT, 'truth': None,
                'discovery_sha256': sha256_bytes(disc_path.read_bytes()), 'target': disc['target'], 'case_count': len(cases), 'cases': manifest_rows,
                'note': 'truth-free cases of a read-only series scan; never scored (mrh-score refuses them)'}
    write_text(suite / 'manifest.json', dumps(manifest))
    unparsed = sum(1 for c in cases if c['scan']['name_parse'] == 'unparsed')
    print('build: %d cases (%d with an unparsed name) in %s' % (len(cases), unparsed, suite))
    return EXIT_OK


# ---------------------------------------------------------------------------------------------------------------------------------- run
def batch_dirs(run_root):
    root = Path(run_root)
    return sorted(p for p in root.glob('batch-*') if p.is_dir()) if root.is_dir() else []


def record_files(run_dir):
    return sorted(f for f in Path(run_dir).glob('*.json') if f.name not in ('manifest.json', 'run_summary.json'))


def done_ids(run_root, retry_errors=False):
    """Case ids that already have a record in some batch.  With retry_errors a record whose `error` is set (a harness crash or an adapter error) is not done."""
    done = set()
    for b in batch_dirs(run_root):
        for f in record_files(b):
            try:
                rec = json.loads(f.read_text(encoding='utf-8'))
            except ValueError:
                continue
            if not isinstance(rec, dict) or 'case_id' not in rec:
                continue
            if retry_errors and rec.get('error'):
                continue
            done.add(rec['case_id'])
    return done


def suite_case_ids(suite):
    man = json.loads((Path(suite) / 'manifest.json').read_text(encoding='utf-8'))
    if not (isinstance(man, dict) and man.get('kind') == SS.SUITE_KIND):
        raise SystemExit('%s is not a series-scan suite' % suite)
    return [c['id'] for c in man['cases']]


def wall_cap(n, base_s=BASE_WALL_S, per_case_s=PER_CASE_WALL_S):
    return int(base_s + per_case_s * n)


def runner_options(args, pending, batch_out, scratch):
    opts = list(RUN_OPTIONS)
    opts[opts.index('--model') + 1] = args.model
    opts += ['--max-wall-s', str(args.max_wall_s if args.max_wall_s else wall_cap(len(pending), args.base_wall_s, args.per_case_wall_s)), '--split', SS.SPLIT]
    if args.stop_on_receipt_failure:
        opts.append('--stop-on-receipt-failure')
    if args.require_digest:
        opts += ['--require-digest', args.require_digest]
    return opts + ['--suite', str(args.suite), '--cases', ','.join(pending), '--out', str(batch_out), '--scratch', str(scratch)]


def offline_check(opts, suite):
    """The runner's own option checks, offline: its main() with every adapter's preflight stubbed (the dev-tl1 approach).  -> (ok, message)."""
    spec = importlib.util.spec_from_file_location('devtl1_config', HERE / 'devtl1_config.py')
    cfg = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cfg)
    flags = ('--suite', '--out', '--scratch')
    base, skip = [], False
    for x in opts:
        if skip:
            skip = False
            continue
        if x in flags:
            skip = True
            continue
        base.append(x)
    try:
        h, config = cfg.config_hash(base, suite)
    except SystemExit as e:
        return False, 'the runner refuses this combination: %s' % (e.code,)
    except Exception as e:  # noqa: BLE001
        return False, 'the offline check failed: %s: %s' % (type(e).__name__, e)
    return True, 'the runner accepts this combination (config_hash %s, tools behaviour %s)' % (h, config.get('tools_behavior'))


def execute(cmd, env):
    """The one place a model run is started (tests replace it)."""
    return subprocess.run(cmd, env=env).returncode


def run(args):
    suite = Path(args.suite)
    out = private_dir(args.out, getattr(args, 'allow_in_git', False))
    ids = suite_case_ids(suite)
    done = done_ids(out, args.retry_errors)
    pending = [i for i in ids if i not in done]
    if args.limit is not None:
        pending = pending[:args.limit]
    if not pending:
        print('run: nothing to run (%d of %d cases already have a record in %s)' % (len(done & set(ids)), len(ids), out))
        return EXIT_OK
    n = len(batch_dirs(out)) + 1
    batch_out = out / ('batch-%03d' % n)
    scratch = out / 'scratch' / ('batch-%03d' % n)
    opts = runner_options(args, pending, batch_out, scratch)
    cmd = [sys.executable, '-m', 'media_repair_harness.run'] + opts
    ok, msg = offline_check(opts, suite)
    print('run: %d pending of %d cases (%d done); batch %s' % (len(pending), len(ids), len(done & set(ids)), batch_out.name))
    print('run: ' + msg)
    if not ok:
        return EXIT_BAD
    cap = int(opts[opts.index('--max-wall-s') + 1])
    print('run: wall cap %d s (%.1f h) for the batch' % (cap, cap / 3600))
    print('run: command (PYTHONPATH=%s):' % (COMPONENT / 'src'))
    print('  ' + shlex.join(cmd))
    if not args.execute:
        print('run: not executed (add --execute to run it). Re-running the same command later resumes: cases with a record are skipped.')
        return EXIT_OK
    batch_out.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONPATH=str(COMPONENT / 'src') + (os.pathsep + os.environ['PYTHONPATH'] if os.environ.get('PYTHONPATH') else ''))
    code = execute(cmd, env)
    print('run: the runner exited %d%s' % (code, ' (aborted or stopped: re-run to resume with the remaining cases)' if code else ''))
    return code


# ---------------------------------------------------------------------------------------------------------------------------------- report
def leaf_runs(path):
    p = Path(path)
    if (p / 'manifest.json').is_file():
        return [p]
    return [b for b in batch_dirs(p) if (b / 'manifest.json').is_file()] or [p]


def load_runs(paths):
    """-> (records by case id; the later run dir wins), manifests, started-aborted partials."""
    records, manifests, partials = {}, [], []
    for given in paths:
        for leaf in leaf_runs(given):
            try:
                manifests.append(json.loads((leaf / 'manifest.json').read_text(encoding='utf-8')))
            except (OSError, ValueError):
                manifests.append({'unreadable': True})
            for f in record_files(leaf):
                try:
                    rec = json.loads(f.read_text(encoding='utf-8'))
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get('case_id') and rec.get('record_version'):
                    records[rec['case_id']] = rec
            for f in sorted((leaf / 'started-aborted').glob('*.json')) if (leaf / 'started-aborted').is_dir() else []:
                try:
                    partials.append(json.loads(f.read_text(encoding='utf-8')))
                except ValueError:
                    pass
    return records, manifests, partials


def planned(disc):
    """case id -> discovery row, by the same id rule as build."""
    return {case_id(r['path'], parse_name(r['basename'])): r for r in disc['files']}


def tool_summary(rec):
    calls = [c for c in rec.get('tool_calls') or [] if isinstance(c, dict) and c.get('tool') and not c.get('pages_of')]
    called = [(c['tool'], c.get('status')) for c in calls]
    failed = []
    for c in calls:
        fatal = (c.get('remote_fatal') or {}).get('kind') if isinstance(c.get('remote_fatal'), dict) else None
        if c.get('status') not in ('ok', 'partial') or fatal:
            text = c.get('output') if isinstance(c.get('output'), str) else json.dumps(c.get('output'), ensure_ascii=False)
            failed.append({'tool': c['tool'], 'status': c.get('status'), 'fatal': fatal, 'excerpt': ' '.join((text or '').split())[:200]})
    return called, failed


def one_line(text, n=400):
    return ' '.join(str(text or '').split())[:n]


def row_of(cid, rec, drow):
    d = rec.get('decision') if isinstance(rec.get('decision'), dict) else None
    called, failed = tool_summary(rec)
    parsed = parse_name(drow['basename']) if drow else None
    return {'case_id': cid, 'basename': drow['basename'] if drow else None, 'season': parsed['season'] if parsed else None,
            'episode': parsed['episode'] if parsed else None,
            'class': d.get('class') if d else None, 'action': d.get('action') if d else None, 'confidence': d.get('confidence') if d else None,
            'reason': one_line(d.get('reason')) if d else None, 'called': called, 'failed': failed, 'forced': bool(rec.get('forced')),
            'forced_reason': rec.get('forced_reason'), 'repairs': len(rec.get('repair_prompts') or []), 'first_try_valid': rec.get('first_try_valid'),
            'error': (rec.get('error') or {}).get('kind'), 'wall_s': (rec.get('wall') or {}).get('total_s')}


def aggregate(rows, planned_ids, manifests, partials):
    by_class, by_action, tool_status, errors, fatal_kinds = {}, {}, {}, {}, {}
    for r in rows:
        k = r['class'] or 'no_decision'
        by_class[k] = by_class.get(k, 0) + 1
        a = r['action'] or 'no_decision'
        by_action[a] = by_action.get(a, 0) + 1
        for tool, st in r['called']:
            tool_status.setdefault(tool, {})
            tool_status[tool][st] = tool_status[tool].get(st, 0) + 1
        if r['error']:
            errors[r['error']] = errors.get(r['error'], 0) + 1
        for f in r['failed']:
            if f['fatal']:
                fatal_kinds[f['fatal']] = fatal_kinds.get(f['fatal'], 0) + 1
    walls = sorted(r['wall_s'] for r in rows if isinstance(r['wall_s'], (int, float)))
    have = {r['case_id'] for r in rows}
    aborted = [m.get('aborted') for m in manifests if m.get('aborted')]
    return {'summary_version': 'series-scan-summary-1', 'cases_planned': len(planned_ids), 'records': len(rows), 'missing': len(set(planned_ids) - have),
            'started_aborted': len(partials), 'by_class': dict(sorted(by_class.items())), 'by_action': dict(sorted(by_action.items())),
            'non_healthy': sum(1 for r in rows if r['class'] != 'healthy'), 'forced': sum(1 for r in rows if r['forced']),
            'repaired': sum(1 for r in rows if r['repairs']), 'first_try_valid': sum(1 for r in rows if r['first_try_valid']),
            'record_errors': dict(sorted(errors.items())), 'tool_calls_by_tool_status': {t: dict(sorted(s.items())) for t, s in sorted(tool_status.items())},
            'tool_failures': sum(len(r['failed']) for r in rows), 'files_with_tool_failures': sum(1 for r in rows if r['failed']),
            'remote_fatal_by_kind': dict(sorted(fatal_kinds.items())),
            'wall_s': {'total': round(sum(walls), 1), 'median': round(statistics.median(walls), 1) if walls else None, 'max': walls[-1] if walls else None},
            'runs': len(manifests), 'aborted_runs': len(aborted),
            'models': sorted({m.get('requested_model') for m in manifests if m.get('requested_model')}),
            'config_hashes': sorted({m.get('config_hash') for m in manifests if m.get('config_hash')})}


def render(summary, rows, planned_map, missing, aborted, source_note):
    L = ['# Series scan report', '', source_note, '',
         'Private: this file names real library files. Do not commit it. `summary.json` holds counts only.', '',
         '## Totals', '',
         '- planned cases: %d; records: %d; missing (never ran): %d; started-aborted: %d' % (summary['cases_planned'], summary['records'], summary['missing'],
                                                                                         summary['started_aborted']),
         '- forced decisions: %d; cases needing a repair prompt: %d; first-try valid: %d' % (summary['forced'], summary['repaired'], summary['first_try_valid']),
         '- cases with a tool failure: %d (%d failed calls); record errors: %s' % (summary['files_with_tool_failures'], summary['tool_failures'], summary['record_errors'] or 'none'),
         '- wall seconds: total %s, median %s, max %s' % (summary['wall_s']['total'], summary['wall_s']['median'], summary['wall_s']['max']), '',
         '### By class', '', '| class | files |', '|---|---|']
    L += ['| %s | %d |' % (k, v) for k, v in summary['by_class'].items()]
    L += ['', '### By action', '', '| action | files |', '|---|---|'] + ['| %s | %d |' % (k, v) for k, v in summary['by_action'].items()]
    L += ['', '### Tool calls by status', '', '| tool | statuses |', '|---|---|']
    L += ['| %s | %s |' % (t, ', '.join('%s %d' % kv for kv in s.items())) for t, s in summary['tool_calls_by_tool_status'].items()]
    if aborted:
        L += ['', '### Aborted runs', ''] + ['- %s' % one_line(a, 300) for a in aborted]
    ordered = sorted(rows, key=lambda r: (r['season'] is None, r['season'] or 0, r['episode'] is None, r['episode'] or 0, r['case_id']))
    L += ['', '## Non-healthy findings', '']
    bad = [r for r in ordered if r['class'] != 'healthy']
    if not bad:
        L.append('None: every record decided `healthy`.')
    for r in bad:
        L += ['- S%s E%s `%s` (%s): **%s / %s**, confidence %s%s. %s' % (
            '--' if r['season'] is None else '%02d' % r['season'], '--' if r['episode'] is None else '%03d' % r['episode'], r['basename'], r['case_id'],
            r['class'], r['action'], r['confidence'], ', forced (%s)' % r['forced_reason'] if r['forced'] else '', r['reason'] or ('record error: %s' % r['error'] if r['error'] else ''))]
    L += ['', '## Tool failures', '']
    fails = [r for r in ordered if r['failed']]
    if not fails:
        L.append('None.')
    for r in fails:
        for f in r['failed']:
            L.append('- `%s` (%s): %s %s%s %s' % (r['basename'], r['case_id'], f['tool'], f['status'], ' [fail-closed: %s]' % f['fatal'] if f['fatal'] else '', f['excerpt']))
    L += ['', '## Missing', '']
    if not missing:
        L.append('None: every planned case has a record.')
    for cid in sorted(missing):
        L.append('- `%s` (%s)' % (planned_map[cid]['basename'], cid))
    L += ['', '## Per file', '',
          '| S | E | file | class | action | conf | tools (status) | failed | forced | repairs | wall s |', '|---|---|---|---|---|---|---|---|---|---|---|']
    for r in ordered:
        L.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            r['season'] if r['season'] is not None else '', r['episode'] if r['episode'] is not None else '', (r['basename'] or r['case_id']).replace('|', '\\|'),
            r['class'], r['action'], r['confidence'], ', '.join('%s %s' % tc for tc in r['called']) or '-',
            ', '.join('%s %s' % (f['tool'], f['status']) for f in r['failed']) or '-', 'yes' if r['forced'] else '', r['repairs'] or '', r['wall_s']))
    return '\n'.join(L) + '\n'


def report(args):
    disc = load_discovery(args.discovery)
    out = Path(args.out)
    if inside_git(out.parent) and not getattr(args, 'allow_in_git', False):
        raise SystemExit('refusing --out %s: it is inside a git work tree (the report names real files). Use the private directory.' % out)
    out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    pmap = planned(disc)
    records, manifests, partials = load_runs(args.run)
    unknown = sorted(set(records) - set(pmap))
    if unknown:
        raise SystemExit('%d record(s) belong to no discovered file (wrong discovery or run directory): %s' % (len(unknown), ', '.join(unknown[:5])))
    rows = [row_of(cid, rec, pmap.get(cid)) for cid, rec in sorted(records.items())]
    summary = aggregate(rows, pmap, manifests, partials)
    missing = [c for c in pmap if c not in records]
    aborted = [m.get('aborted') for m in manifests if m.get('aborted')]
    note = 'Runs: %s. Model: %s.' % (', '.join(str(r) for r in args.run), ', '.join(summary['models']) or 'unknown')
    write_text(out, render(summary, rows, pmap, missing, aborted, note))
    write_text(out.with_name('summary.json'), dumps(summary))
    print('report: %d records of %d planned; wrote %s and %s' % (len(rows), len(pmap), out, out.with_name('summary.json')))
    return EXIT_OK


# ---------------------------------------------------------------------------------------------------------------------------------- command line
def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='command', required=True)
    d = sub.add_parser('discover', help='list and verify one series folder through the remote sampler -> discovery.json')
    d.add_argument('--target', required=True, help='<namespace>/<deployment>[/<container>], for example media/bazarr/app')
    d.add_argument('--root', required=True, help='the allowed root every path must stay under (the sampler --root)')
    d.add_argument('--series-dir', required=True, help='absolute path of the series folder, below --root')
    d.add_argument('--season', type=int, help='only this season folder (Season N); default every season folder and loose files')
    d.add_argument('--out', required=True, help='private output directory, outside git')
    d.add_argument('--no-probe', action='store_true', help='skip the per-file ffprobe (then subtitle_sample has no stream to use)')
    d.add_argument('--max-wall-s', type=float, default=DEFAULT_DISCOVER_WALL_S, help='discovery wall cap in seconds (default %(default)s)')
    d.add_argument('--allow-in-git', action='store_true', help='tests only')
    b = sub.add_parser('build', help='discovery.json -> a truth-free suite directory')
    b.add_argument('--discovery', required=True)
    b.add_argument('--out', required=True, help='private output directory; the suite is written to <out>/suite')
    b.add_argument('--allow-in-git', action='store_true', help='tests only')
    r = sub.add_parser('run', help='print (or with --execute run) the runner command over the suite; resumable by batch')
    r.add_argument('--suite', required=True)
    r.add_argument('--out', required=True, help='run directory root; each invocation writes <out>/batch-NNN')
    r.add_argument('--model', default=MODEL)
    r.add_argument('--limit', type=int, help='run only the first N cases that have no record yet')
    r.add_argument('--execute', action='store_true', help='actually run it (default: print the command only)')
    r.add_argument('--max-wall-s', type=int, help='override the wall cap (default %d + %d per pending case seconds)' % (BASE_WALL_S, PER_CASE_WALL_S))
    r.add_argument('--base-wall-s', type=int, default=BASE_WALL_S)
    r.add_argument('--per-case-wall-s', type=int, default=PER_CASE_WALL_S)
    r.add_argument('--stop-on-receipt-failure', action='store_true', help='stop the whole batch at the first fail-closed remote operation (default: that tool call fails, the scan goes on)')
    r.add_argument('--require-digest', help='abort unless the installed model digest equals this value')
    r.add_argument('--retry-errors', action='store_true', help='treat a record that carries an error (crash, adapter error) as not done')
    r.add_argument('--allow-in-git', action='store_true', help='tests only')
    p = sub.add_parser('report', help='aggregate run records into report.md (private) and summary.json (counts only)')
    p.add_argument('--run', action='append', required=True, help='a run directory (a runner out dir, or a series-scan run root of batch-NNN); repeatable')
    p.add_argument('--discovery', required=True)
    p.add_argument('--out', required=True, help='report.md path (summary.json is written next to it)')
    p.add_argument('--allow-in-git', action='store_true', help='tests only')
    return ap


def main(argv=None, runner=subprocess.run, clock=time.monotonic):
    args = build_parser().parse_args(argv)
    if args.command == 'discover':
        return discover(args, runner, clock)
    return {'build': build, 'run': run, 'report': report}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
