#!/usr/bin/env python3
"""Stage R G0a (OpenProject #160; pilot plan v3.2 section 4.2 item 1): offline checks of the pre-registration in runs/stage-r-pilot-1/.

No model call, no cluster access, no media read.  Every runner is fake: `kubectl` is answered by SyntheticBazarr (an in-memory stand-in for
`kubectl get deploy|pods` and `kubectl exec ... python3 - <mode>` that writes mrh-sampler-2 receipts for a synthetic tree), the Claude adapter's
preflight and completion are replaced by a scripted stand-in (its configuration, and so the config hash, stay the registered ones), and the G0b manifest
commit is a fake hook.  A PATH tripwire puts stubs named kubectl, claude, ffprobe, ffmpeg, flux, pve, talosctl and omnictl first on PATH: any of them
running is recorded, and the result requires that none ran.

  stage_r_g0a.py config      the registered harness configuration of the first G2 target (the whole cost cap remains) and its config_hash
  stage_r_g0a.py leakguard   the six case templates, filled exactly as G0b fills them (synthetic locators), through the driver's leak guard, and a
                             label scan of each template file -> runs/stage-r-pilot-1/leakguard-g0a.json
  stage_r_g0a.py validate    the driver against fake runners with this registration: the happy path on a synthetic layout, the documented-layout gap
                             and every stop path -> runs/stage-r-pilot-1/offline-validation.json
  stage_r_g0a.py all         leakguard and validate

Every output is deterministic (no time, no temporary path), so tests/test_stage_r_pilot1.py re-runs it and compares it with the committed files.
"""
import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / 'src'))

from media_repair_harness import adapters as A  # noqa: E402
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import remote_evidence as RE  # noqa: E402
from media_repair_harness import run as R  # noqa: E402


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load('stage_r_driver')
REP = _load('stage_r_report')

RUN_DIR = COMPONENT / 'runs' / 'stage-r-pilot-1'
REGISTRATION = RUN_DIR / 'registration.json'
LEAKGUARD_OUT = RUN_DIR / 'leakguard-g0a.json'
VALIDATION_OUT = RUN_DIR / 'offline-validation.json'
TRIPWIRE_NAMES = ('kubectl', 'claude', 'ffprobe', 'ffmpeg', 'flux', 'pve', 'talosctl', 'omnictl')
HOST = 'bazarr-5c9d7f8b6-synth1'          # the synthetic pod name, which every synthetic receipt names as its hostname
POD_UID = 'synthetic-uid-0001'
FAKE_COST_USD = 0.05                       # what each scripted completion reports (the run's cost cap needs a reported cost)


# ------------------------------------------------------------------------------------------------------------------ the registration
def load(path=REGISTRATION):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def registration_digest(reg):
    return D.canonical_sha256(reg)


def harness_argv(reg, remaining_usd=None, case='CASE'):
    """The argv the driver gives the harness for one G2 target (stage_r_driver.Driver.g2, mirrored; `validate` checks the recorded config hashes against it)."""
    lim = dict(D.LIMIT_CEILINGS, **reg.get('limits', {}))
    remaining = float(lim['total_cost_usd']) if remaining_usd is None else remaining_usd
    return list(reg['harness_args']) + ['--suite', 'SUITE', '--cases', case, '--out', 'OUT', '--scratch', 'SCRATCH', '--evidence', 'replay',
                                        '--tools-behavior', RE.VERSION, '--stop-on-receipt-failure', '--max-wall-s', '%g' % float(lim['target_wall_s']),
                                        '--max-total-cost-usd', '%g' % remaining]


def registered_config(reg, remaining_usd=None):
    args = R.build_parser().parse_args(harness_argv(reg, remaining_usd))
    adapter = R.build_adapter(args)
    try:
        return R.run_config(args, adapter, {}, None)
    finally:
        adapter.finish()


def config_hash(config):
    return R.sha256_bytes(R.canonical(config).encode())


def template_dir():
    return REGISTRATION.parent


# ------------------------------------------------------------------------------------------------------------------ the synthetic pod
def fingerprint(node):
    seed = '%s|%s|%s' % (node['size'], node['mtime_ns'], node.get('content', ''))
    return {'head_1m_sha256': hashlib.sha256(('head|' + seed).encode()).hexdigest(), 'tail_1m_sha256': hashlib.sha256(('tail|' + seed).encode()).hexdigest()}


SRT = ('1\n00:00:01,000 --> 00:00:03,000\nSynthetic cue one.\n\n2\n00:00:04,000 --> 00:00:06,000\nSynthetic cue two.\n\n')
PROBE_TEXT = {'format': {'format_name': 'matroska,webm', 'duration': '1380.0'},
              'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'tags': {'language': 'eng'}},
                          {'index': 2, 'codec_type': 'subtitle', 'codec_name': 'subrip', 'tags': {'language': 'eng'}}]}
PROBE_NO_TEXT = {'format': PROBE_TEXT['format'], 'streams': PROBE_TEXT['streams'][:2]}


class SyntheticBazarr:
    """`kubectl -n media get deploy bazarr`, `get pods -l ...` and `exec -i deploy/bazarr -c app -- python3 - <mode> <path> [opts]` over an in-memory tree.
    The deployment mirrors the GitOps definition of the app container's mounts (haynes-ops kubernetes/main/apps/media/bazarr/app/helmrelease.yaml):
    /config, /data/haynestower and /tmp.  `before(argv, n)` may change the tree or return an exception to raise; `after(argv, n, completed)` may replace
    the result.  `n` counts exec calls from 1.  Nothing here starts a process."""

    MOUNT = '/data/haynestower'

    def __init__(self, reg, layout='flat', probes=None, pad=0, before=None, after=None, pods=None):
        self.reg, self.before, self.after, self.pods_fn = reg, before, after, pods
        self.nodes, self.execs, self.gets, self.modes = {}, 0, 0, []
        self.series_root = {'flat': self.MOUNT, 'documented': self.MOUNT + '/Media/TV Shows'}[layout]
        self.dir(self.MOUNT)
        series = self.series_root + '/' + reg['discovery']['series_prefix']
        self.dir(self.series_root + '/Another Series (2001)')
        seasons = {'s03': series + '/Season 03', 's20': series + '/Season 20'}
        ino = 1000
        self.paths = {}
        for t in reg['targets']:
            name = t.get('basename') or '%s - %s - Synthetic Discovered Name [SYNTHETIC].mkv' % (reg['discovery']['series_prefix'], t['marker'])
            p = seasons[t['season']] + '/' + name
            ino += 1
            self.file(p, t['bytes'], ino, probe=(probes or {}).get(t['key'], PROBE_TEXT))
            self.paths[t['key']] = p
        # decoys: the same marker with other bytes, and another episode of each season, so a locator must match its bytes and its name
        self.file(seasons['s03'] + '/%s - S03E01 - Synthetic Older Copy [SYNTHETIC].mkv' % reg['discovery']['series_prefix'], 1158735496, 2001)
        self.file(seasons['s20'] + '/%s - S20E113 - Synthetic Neighbour [SYNTHETIC].mkv' % reg['discovery']['series_prefix'], 870235695, 2002)
        for i in range(pad):
            self.file(seasons['s03'] + '/pad-%03d.nfo' % i, 1, 3000 + i)

    def dir(self, path):
        parts = path.strip('/').split('/')
        for i in range(1, len(parts) + 1):
            self.nodes.setdefault('/' + '/'.join(parts[:i]), {'type': 'dir', 'size': 4096, 'mtime_ns': 1700000000000000000, 'dev': 64, 'ino': 10 + i})

    def file(self, path, size, ino, probe=None):
        self.dir(path.rsplit('/', 1)[0])
        self.nodes[path] = {'type': 'file', 'size': size, 'mtime_ns': 1760000000000000000 + ino, 'dev': 64, 'ino': ino, 'probe': probe or PROBE_TEXT, 'content': ''}

    def ident(self, node):
        return {k: node[k] for k in RE.IDENTITY_FIELDS}

    def deploy(self):
        return {'spec': {'selector': {'matchLabels': {'app.kubernetes.io/instance': 'bazarr', 'app.kubernetes.io/name': 'bazarr'}},
                         'template': {'spec': {'containers': [
                             {'name': 'app', 'volumeMounts': [{'name': 'config', 'mountPath': '/config'}, {'name': 'data-tower', 'mountPath': self.MOUNT},
                                                              {'name': 'tmp', 'mountPath': '/tmp'}]},
                             {'name': 'exportarr', 'volumeMounts': []}]}}}}

    @staticmethod
    def pod(restarts=0, ready='True', uid=POD_UID, name=HOST):
        return {'metadata': {'name': name, 'uid': uid}, 'status': {'containerStatuses': [{'name': 'app', 'restartCount': restarts}, {'name': 'exportarr', 'restartCount': 0}],
                                                                   'conditions': [{'type': 'Ready', 'status': ready}]}}

    def __call__(self, argv, input=None, capture_output=True, timeout=None, **kw):
        if argv[:1] != ['kubectl']:
            raise RuntimeError('SyntheticBazarr answers kubectl only, not %r' % argv[:1])
        if 'get' in argv:
            self.gets += 1
            what = argv[argv.index('get') + 1]
            body = self.deploy() if what == 'deploy' else (self.pods_fn() if self.pods_fn else {'items': [self.pod()]})
            return A_Completed(0, json.dumps(body).encode(), b'')
        self.execs += 1
        n = self.execs
        i = argv.index('-')
        mode, path, opts = argv[i + 1], argv[i + 2], argv[i + 3:]
        self.modes.append(mode)
        if self.before:
            r = self.before(argv, n, self)
            if isinstance(r, BaseException):
                raise r
        out = self.answer(mode, path, opts)
        return self.after(argv, n, out) if self.after else out

    @staticmethod
    def opt(opts, name, default=None):
        return opts[opts.index(name) + 1] if name in opts else default

    def answer(self, mode, path, opts):
        root = self.opt(opts, '--root')
        confined = bool(root) and (path == root or path.startswith(root.rstrip('/') + '/')) and os.path.normpath(path) == path
        r = {'receipt': RE.RECEIPT, 'mode': mode, 'hostname': HOST, 'exit_code': 0, 'error': None, 'stderr': '', 'quota_exhausted': False, 'requests': 0,
             'wall_seconds': 0.5, 'timed_out': False, 'source_unchanged': None, 'argv': None, 'confined': confined,
             'identity': {'expected': None, 'start': None, 'end': None, 'start_ok': None, 'end_ok': None, 'same_file': None}, 'bytes_read': 0}
        node = self.nodes.get(path)
        if mode == 'list':
            prefix = self.opt(opts, '--prefix', '')
            names = sorted(p.rsplit('/', 1)[1] for p in self.nodes if p.rsplit('/', 1)[0] == path and p != path)
            entries = [dict({k: self.nodes[path + '/' + nm][k] for k in ('size', 'mtime_ns', 'dev', 'ino')}, name=nm, type=self.nodes[path + '/' + nm]['type'])
                       for nm in names if nm.startswith(prefix)]
            complete = len(entries) < RE.LIST_CAP
            entries = entries[:RE.LIST_CAP]
            body = {'directory': path, 'prefix': prefix, 'complete': complete, 'matching': len(entries), 'scanned': len(names), 'entries': entries}
            r['listing'] = {'directory': path, 'prefix': prefix, 'complete': complete, 'matching': len(entries), 'scanned': len(names), 'cap': RE.LIST_CAP}
            out = json.dumps(body, ensure_ascii=False).encode()
        else:
            exp = None
            if '--expect-size' in opts:
                exp = {'size': int(self.opt(opts, '--expect-size')), 'mtime_ns': int(self.opt(opts, '--expect-mtime-ns')),
                       'dev': int(self.opt(opts, '--expect-dev')), 'ino': int(self.opt(opts, '--expect-ino'))}
            start = self.ident(node)
            end = self.ident(node)
            r['identity'] = {'expected': exp, 'start': start, 'end': end, 'start_ok': None if exp is None else start == exp,
                             'end_ok': None if exp is None else end == exp, 'same_file': True}
            r['source_unchanged'] = start == end
            if mode == 'stat':
                out = json.dumps(dict({'size': node['size'], 'mtime_ns': node['mtime_ns'], 'partial_fingerprint_only': True}, **fingerprint(node))).encode()
                r['bytes_read'] = min(node['size'], RE.STAT_BYTES_MAX)
            elif mode == 'probe':
                out = json.dumps(node['probe']).encode()
                r.update(bytes_read=65536, requests=3)
            elif mode == 'subtitle':
                out = SRT.encode()
                r.update(bytes_read=262144, requests=4)
            else:
                out = b''
                r.update(bytes_read=1048576, requests=2)
        r['stdout_bytes'] = len(out)
        return A_Completed(0, out, ('synthetic sampler\n' + json.dumps(r)).encode())


class A_Completed:
    def __init__(self, rc, out=b'', err=b''):
        self.returncode, self.stdout, self.stderr = rc, out, err


# ------------------------------------------------------------------------------------------------------------------ the scripted model and the tripwire
def tool_call(tool, args, why='Check the file.'):
    return json.dumps({'type': 'tool_call', 'tool': tool, 'args': args, 'why': why})


def decision(cls, action, refs=(), reason='Scripted offline reply.'):
    return json.dumps({'type': 'decision', 'class': cls, 'action': action, 'reason': reason, 'confidence': 0.5, 'evidence_refs': list(refs)})


# role-neutral: every target gets the same two replies (one subtitle read, then an escalation citing the first cue), so the validation encodes no
# expected answer
DEFAULT_REPLIES = (tool_call('subtitle_sample', {'at': 60}), decision('insufficient_evidence', 'escalate', ['t1.f1']))


class ScriptedClaude:
    """Replaces ClaudeAdapter.preflight and .complete (never the CLI): the adapter's config, and so the config hash, are the registered ones."""

    def __init__(self, cost=FAKE_COST_USD, interrupt_at=None):
        self.queue, self.calls, self.cost, self.interrupt_at = [], 0, cost, interrupt_at

    def preflight(self, adapter):
        adapter.runtime_version = 'offline-scripted (no CLI)'
        return adapter.describe()

    def complete(self, adapter, system, messages, schema=None):
        self.calls += 1
        if self.interrupt_at is not None and self.calls == self.interrupt_at:
            raise KeyboardInterrupt('the #159 tripwire watcher interrupts the driver (simulated)')
        if not self.queue:
            raise A.AdapterError('scripted replies exhausted')
        text = self.queue.pop(0)
        return A.Completion(text, {'argv': ['claude', '-p', '<offline>'], 'system_prompt': system, 'prompt': A.render_transcript(messages)}, text,
                            response_model='claude-opus-5-5', usage={'input_tokens': 9000, 'output_tokens': 200, 'cache_creation_input_tokens': 0,
                                                                     'cache_read_input_tokens': 0, 'cost_usd': self.cost}, wall_s=0.0)

    @contextlib.contextmanager
    def installed(self):
        me = self
        with mock.patch.object(A.ClaudeAdapter, 'preflight', lambda adapter: me.preflight(adapter)), \
                mock.patch.object(A.ClaudeAdapter, 'complete', lambda adapter, system, messages, schema=None: me.complete(adapter, system, messages, schema)):
            yield me


@contextlib.contextmanager
def path_tripwire():
    """Stubs for every binary that could reach the cluster, a model or media, first on PATH; each records that it ran and exits 99."""
    tmp = Path(tempfile.mkdtemp(prefix='mrh-g0a-tripwire-'))
    log = tmp / 'ran.log'
    log.write_text('')
    for name in TRIPWIRE_NAMES:
        p = tmp / name
        p.write_text('#!/bin/sh\necho "%s $*" >> "%s"\nexit 99\n' % (name, log))
        p.chmod(0o755)
    old = os.environ.get('PATH', '')
    os.environ['PATH'] = str(tmp) + os.pathsep + old
    hits = []
    try:
        yield hits
    finally:
        os.environ['PATH'] = old
        hits.extend(ln for ln in log.read_text().splitlines() if ln.strip())
        shutil.rmtree(tmp, ignore_errors=True)


def fake_commit(path):
    return {'commit': 'offline-no-commit', 'manifest_sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}


# ------------------------------------------------------------------------------------------------------------------ leak guard (G0a)
LABEL_TERMS = ('offender', 'verified', 'held', 'replacement', 'correct copy', 'wrong content', 'wrong-content', 'mapping', 'proof', 'baseline', 'sameAs', 'Horizons',
               'completed-slot', 'role') + P.CLASSES + P.WRITE_ACTIONS


def label_terms(reg, key):
    """What must not be in a template: the role and class vocabulary, the baseline notes' words, and every OTHER target's slot and catalog title (the S20
    mappings name another slot's content; a template may name only its own slot)."""
    me = next(t for t in reg['targets'] if t['key'] == key)
    terms = list(LABEL_TERMS)
    for t in reg['targets']:
        if t['key'] != key:
            terms += [t['slot'], t['catalog_title']]
    for doc in {t['baseline_document'] for t in reg['targets']}:
        terms.append(Path(doc).name)
    return [x for x in dict.fromkeys(terms) if x and x != me['slot'] and x != me['catalog_title']]


def leakguard(reg):
    d = D.Driver(reg, Path(tempfile.mkdtemp(prefix='mrh-g0a-leak-')), runner=lambda *a, **k: None, harness=lambda argv: 0, commit=fake_commit,
                 template_dir=template_dir())
    d.mount = SyntheticBazarr.MOUNT
    series = '%s/%s' % (d.mount, reg['discovery']['series_prefix'])
    out = {'about': 'G0a leak guard (pilot plan section 4.2 item 1): each template filled as G0b fills it, with a SYNTHETIC locator (the recorded basename, '
                    'or for a marker target a placeholder name, since its basename is discovered at G0b), checked by the driver\'s own leak_check '
                    '(the legacy leak guard over the model-visible view: case id, fixture names and stems, truth, family, provenance); plus a label scan of '
                    'the template file (role and class words, the baseline notes\' words, every other target\'s slot and catalog title).  G0b and G2 '
                    'run the same leak guard again on the real fills.',
           'command': 'python3 tools/media-repair-harness/scripts/stage_r_g0a.py leakguard', 'registration_sha256': registration_digest(reg), 'templates': {}}
    ok = True
    for t in reg['targets']:
        name = t.get('basename') or '%s - %s - placeholder.mkv' % (reg['discovery']['series_prefix'], t['marker'])
        path = '%s/%s/%s' % (series, 'Season 03' if t['season'] == 's03' else 'Season 20', name)
        d.state['targets'][t['key']]['path'] = path
        case = d.fill(t, with_probe=False)
        try:
            d.leak_check('G0a', t, case)
            hits = []
        except D.Stop as e:
            hits = [e.detail]
        raw = (template_dir() / t['case_template']).read_text(encoding='utf-8')
        terms = label_terms(reg, t['key'])
        label_hits = sorted({x for x in terms if x.lower() in raw.lower()})
        view = json.dumps(P.case_view(case, R.resolve_evidence_raw(case, str(d.out))), ensure_ascii=False, sort_keys=True)
        out['templates'][t['key']] = {'file': t['case_template'], 'sha256': hashlib.sha256((template_dir() / t['case_template']).read_bytes()).hexdigest(),
                                      'case_id': case['id'], 'locator_used': 'recorded basename' if t.get('basename') else 'placeholder (marker target)',
                                      'model_visible_keys': sorted(json.loads(view)), 'leak_guard_hits': hits,
                                      'label_terms_checked': len(terms), 'label_hits': label_hits,
                                      'forbidden_fields_absent': sorted(k for k in ('truth', 'supported_actions', 'solvable', 'family', 'provenance', 'split', 'fixture',
                                                                                    'inject_tool_failure', 'outcome_step') if k not in json.loads(raw))}
        ok = ok and not hits and not label_hits
    shutil.rmtree(d.out, ignore_errors=True)
    out['result'] = 'pass' if ok else 'FAIL'
    return out


# ------------------------------------------------------------------------------------------------------------------ the offline validation
def summarise(name, about, code, d, pod, model, harness_runs, hits, reg, configs, extra=None):
    st = d.state
    rep_targets = None
    try:
        rep = REP.evaluate(json.loads(json.dumps(st, default=str)), {'verdicts': []}, reg, template_dir())
        rep_result = rep['stage_r']['result']
        rep_targets = {t['target']: {'execution': t['execution'], 'collection': t['collection'], 'diagnosis': t.get('diagnosis')} for t in rep['targets']}
    except ValueError as e:
        rep_result = 'refused: %s' % str(e)[:120]
    out = {'scenario': name, 'about': about, 'exit_code': code, 'state_exit_code': st.get('exit_code'),
           'stop': {k: st['stop'][k] for k in ('phase', 'kind', 'target')} if st.get('stop') else None,
           'kubectl_get_reads': pod.gets, 'sampler_exec_calls': pod.execs, 'exec_modes': pod.modes, 'harness_runs': harness_runs, 'model_calls': model.calls,
           'targets': {k: v['driver_outcome'] for k, v in st['targets'].items()}, 'report': rep_result, 'report_targets': rep_targets,
           'real_operations': {'path_tripwire_hits': hits, 'manifest_commit': 'fake hook (no git commit)'},
           'state_records_registration_sha256': st.get('registration_sha256') == registration_digest(reg),
           'state_records_template_digests': st.get('case_templates_sha256') == {t['key']: t['case_template_sha256'] for t in reg['targets']}}
    if configs:
        out['g2_config_hashes'] = configs
    if extra:
        out.update(extra)
    return out


def drive(reg, name, about, pod=None, replies=None, model=None, after_run=None, clock=None, commit=fake_commit, extra_fn=None):
    pod = pod or SyntheticBazarr(reg)
    model = model or ScriptedClaude()
    harness_runs, configs = [], {}
    out = Path(tempfile.mkdtemp(prefix='mrh-g0a-run-'))

    def harness(argv):
        key = Path(argv[argv.index('--suite') + 1]).parent.name
        harness_runs.append(key)
        model.queue[:] = list((replies or {}).get(key, DEFAULT_REPLIES))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):      # the runner's per-case lines
            rc = R.main(argv, runner=pod)
        man = D.Driver.read_json(Path(argv[argv.index('--out') + 1]) / 'manifest.json') or {}
        if man.get('config_hash'):
            configs[key] = {'config_hash': man['config_hash'], 'max_total_cost_usd': (man.get('config') or {}).get('limits', {}).get('max_total_cost_usd'),
                            'config_without_cost_remainder_equals_registered': _without_remainder(man.get('config')) == _without_remainder(registered_config(reg))}
        return after_run(argv, rc) if after_run else rc

    kw = {'clock': clock} if clock else {}
    with path_tripwire() as hits, model.installed():
        d = D.Driver(reg, out, runner=pod, harness=harness, commit=commit, template_dir=template_dir(), **kw)
        try:
            code = d.run()
        except KeyboardInterrupt:
            code = 'KeyboardInterrupt (propagated after the terminal state was written)'
    try:
        saved = json.loads((out / 'stage-r-state.json').read_text())
        extra = extra_fn(d, out, saved) if extra_fn else None
        return summarise(name, about, code, d, pod, model, harness_runs, hits, reg, configs, extra)
    finally:
        shutil.rmtree(out, ignore_errors=True)


def _without_remainder(config):
    c = copy.deepcopy(config or {})
    (c.get('limits') or {}).pop('max_total_cost_usd', None)
    return c


def scenarios(reg):
    keys = [t['key'] for t in reg['targets']]
    roles = {t['key']: t['role'] for t in reg['targets']}
    first, offenders = keys[0], [k for k in keys if roles[k] == 'offender']
    non_offender = next(k for k in keys if roles[k] == 'verified')
    g1_end = 4 + 2 * len(keys)          # G0b lists 1-4, then one stat and one probe per target

    def happy_extra(d, out, saved):
        rec = json.loads(Path(saved['targets'][first]['g2']['record']).read_text())
        case = json.loads((out / 'g2' / first / 'suite' / 'cases' / (d.templates[first]['id'] + '.json')).read_text())
        man = json.loads((out / 'g0b-manifest.json').read_text())
        return {'g0b_manifest': [{k: m.get(k) for k in ('key', 'role', 'basename_source', 'provenance')} for m in man['targets']],
                'pod_baseline_recorded_at_g0b': {k: saved['pod'][k] for k in ('name', 'uid', 'restart_count')},
                'first_target': {'first_evidence_tool': case['evidence'][0]['tool'], 'fixture_kind': case['fixture']['kind'],
                                 'delivered_cue_ids': rec['remote_evidence']['delivered_cue_ids'], 'decision_evidence_refs': rec['decision']['evidence_refs'],
                                 'operations_per_file_max': max(len([o for o in saved['operations'] if o.get('target') == k and o.get('mode')]) for k in keys)}}

    def change_mtime(key, at_exec):
        def before(argv, n, pod):
            if n == at_exec:
                pod.nodes[pod.paths[key]]['mtime_ns'] += 10 ** 9
        return before

    def change_content(key, at_exec):
        def before(argv, n, pod):
            if n == at_exec:
                pod.nodes[pod.paths[key]]['content'] = 'changed'
        return before

    def edit_receipt(at_exec, **over):
        def after(argv, n, r):
            if n != at_exec:
                return r
            rec = json.loads(r.stderr.decode().splitlines()[-1])
            rec.update(over)
            return A_Completed(r.returncode, r.stdout, json.dumps(rec).encode())
        return after

    seq_restart = {'n': 0}

    def pods_restart_after_first_target():
        seq_restart['n'] += 1
        pod = SyntheticBazarr.pod(restarts=1 if seq_restart['n'] > 2 + 2 * len(keys) + 1 else 0)
        return {'items': [pod]}

    t = {'now': 0.0}

    def slow_clock():
        t['now'] += 1.0
        return t['now']

    def slow_harness(argv, rc):
        t['now'] += 3000.0
        return rc

    write = decision('metadata_naming', 'rename')
    out = [
        ('happy_path_synthetic_flat_layout',
         'The registration as committed, on a SYNTHETIC layout with the series directly under the mount (what the driver assumes): every phase runs, a cue '
         'reaches the model with a citable id, every target ends recorded.  Role-neutral scripted replies, so the diagnoses carry no expected answer.',
         dict(extra_fn=happy_extra)),
        ('gap_documented_layout',
         'The layout the GitOps mounts and the 2026-10-18 receipts document: the library is /data/haynestower/Media/TV Shows, a subdirectory of the only '
         'matching mount.  The driver lists the mount with the series prefix, finds no series directory and stops before any media read (the gap).',
         dict(pod=SyntheticBazarr(reg, layout='documented'))),
        ('incomplete_listing', 'A season directory with 500 or more matching entries: the listing is incomplete and discovery stops before any media read.',
         dict(pod=SyntheticBazarr(reg, pad=500))),
        ('missing_receipt', 'The second listing returns no receipt line: fatal, nothing further starts.',
         dict(pod=SyntheticBazarr(reg, after=lambda argv, n, r: A_Completed(0, r.stdout, b'') if n == 2 else r))),
        ('manifest_commit_failure', 'The G0b manifest commit hook fails: Stage R stops before any media byte is read.',
         dict(commit=lambda p: (_ for _ in ()).throw(RuntimeError('commit refused')))),
        ('g1_drift_drops_a_target', 'A target changes between its listing and its G1 stat: it is DROPPED and the others go on; Stage R is INCOMPLETE.',
         dict(pod=SyntheticBazarr(reg, before=change_mtime(keys[2], 9)))),
        ('hostname_change_in_g1', 'A G1 receipt names another host: fatal, nothing further starts.',
         dict(pod=SyntheticBazarr(reg, after=edit_receipt(6, hostname='another-pod')))),
        ('outer_timeout_in_g1', 'The 60 s outer deadline of a G1 operation expires (no receipt): fatal, nothing further starts.',
         dict(pod=SyntheticBazarr(reg, before=lambda argv, n, pod: subprocess.TimeoutExpired(argv, RE.OUTER_DEADLINE_S) if n == 8 else None))),
        ('early_stop_no_offender_text_subtitle', 'Neither offender has a text subtitle stream: the registered early stop (exit 4) before G2, no model call.',
         dict(pod=SyntheticBazarr(reg, probes={k: PROBE_NO_TEXT for k in offenders}))),
        ('identity_change_inside_g2', 'The first target changes between G1 and its first G2 sampler operation: the harness run stops (started_aborted) and the '
                                      'driver starts nothing further.',
         dict(pod=SyntheticBazarr(reg, before=change_mtime(first, g1_end + 1)))),
        ('leak_guard_on_the_filled_case', 'The G1 probe of the first target carries its case id in a container tag: the G2 leak guard stops Stage R before any '
                                          'harness run.',
         dict(pod=SyntheticBazarr(reg, probes={first: dict(PROBE_TEXT, format=dict(PROBE_TEXT['format'], tags={'title': 'x %s x' % json.loads(
             (template_dir() / reg['targets'][0]['case_template']).read_text())['id']}))}))),
        ('write_control_on_a_non_offender', 'A rename reply on a verified target (rejected by validation), then a healthy decision: WRITE-CONTROL, Stage R '
                                            'stops when that case returns, before its final stat.',
         dict(replies={non_offender: (write, decision('healthy', 'none'))})),
        ('write_analysis_unresolved', 'An over-budget reply on a verified target: the write analysis is unresolved, a stop before the final stat.',
         dict(replies={non_offender: (' ' * (RE.REPLY_MAX_CHARS + 1), decision('healthy', 'none'))})),
        ('final_fingerprint_mismatch', 'The first target\'s content changes before its final stat (same size, mtime and inode): INVALID, which is a stop.',
         dict(pod=SyntheticBazarr(reg, before=change_content(first, g1_end + 2)))),
        ('pod_restart_between_targets', 'The Bazarr pod reports a container restart after the first G2 target: a pod-health stop.',
         dict(pod=SyntheticBazarr(reg, pods=pods_restart_after_first_target))),
        ('cost_cap', 'Each scripted call reports $5: the first target spends the $10 cap, so the driver starts no second target.',
         dict(model=ScriptedClaude(cost=5.0))),
        ('stage_deadline', 'A slow first target leaves too little of the 2 h Stage R deadline for the next target plus two operations: a stop.',
         dict(clock=slow_clock, after_run=slow_harness)),
        ('tripwire_interrupt', 'The #159 tripwire trips at the first model call; the watcher interrupts the driver (KeyboardInterrupt).  The driver writes its '
                               'terminal state (exit code 3) and starts nothing further; the stop reason is not in the state (a declared gap).',
         dict(model=ScriptedClaude(interrupt_at=1))),
    ]
    return out


def validate(reg):
    results = []
    for name, about, kw in scenarios(reg):
        results.append(drive(reg, name, about, **kw))
    cfg = registered_config(reg)
    return {'about': 'Offline validation of the G0a registration (pilot plan section 4.2 item 1, WO-W29 deliverable 4): the driver loads and validates this '
                     'registration, then runs against FAKE runners only (SyntheticBazarr for kubectl, a scripted stand-in for the Claude adapter, a fake '
                     'manifest commit) under a PATH tripwire.  No model call, no cluster access, no media read.',
            'command': 'python3 tools/media-repair-harness/scripts/stage_r_g0a.py validate',
            'registration_sha256': registration_digest(reg),
            'registration_validates': D.validate_registration(reg, template_dir())[0] == [],
            'registered_config_hash_first_target': config_hash(cfg),
            'scenarios': results,
            'result': 'pass' if all(_scenario_ok(r) for r in results) else 'FAIL'}


EXPECT = {  # scenario -> (exit code, stop kind or None, harness runs allowed)
    'happy_path_synthetic_flat_layout': (0, None),
    'gap_documented_layout': (3, 'discovery'),
    'incomplete_listing': (3, 'incomplete_listing'),
    'missing_receipt': (3, 'missing_receipt'),
    'manifest_commit_failure': (3, 'manifest_commit'),
    'g1_drift_drops_a_target': (0, None),
    'hostname_change_in_g1': (3, 'hostname_changed'),
    'outer_timeout_in_g1': (3, 'outer_timeout'),
    'early_stop_no_offender_text_subtitle': (4, 'early_stop'),
    'identity_change_inside_g2': (3, 'harness_stop'),
    'leak_guard_on_the_filled_case': (3, 'leak_guard'),
    'write_control_on_a_non_offender': (3, 'write_control'),
    'write_analysis_unresolved': (3, 'write_analysis_unresolved'),
    'final_fingerprint_mismatch': (3, 'final_mismatch'),
    'pod_restart_between_targets': (3, 'pod_health'),
    'cost_cap': (3, 'cost_cap'),
    'stage_deadline': (3, 'stage_deadline'),
    'tripwire_interrupt': ('KeyboardInterrupt (propagated after the terminal state was written)', None),
}


def _scenario_ok(r):
    code, kind = EXPECT[r['scenario']]
    ok = r['exit_code'] == code and ((r['stop'] or {}).get('kind') == kind) and not r['real_operations']['path_tripwire_hits']
    ok = ok and r['state_records_registration_sha256'] and r['state_records_template_digests']
    if r['scenario'] == 'happy_path_synthetic_flat_layout':
        ok = ok and r['report'] == 'NOT_ACCEPTED' and set(r['targets'].values()) == {'recorded'}
    elif r['scenario'] == 'tripwire_interrupt':
        ok = ok and r['state_exit_code'] == 3
    else:
        ok = ok and r['report'] == 'INCOMPLETE'
    return ok


def write(path, data):
    Path(path).write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf-8')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('what', choices=('config', 'leakguard', 'validate', 'all'))
    ap.add_argument('--registration', default=str(REGISTRATION))
    ap.add_argument('--check', action='store_true', help='compare with the committed output instead of writing it')
    args = ap.parse_args(argv)
    reg = load(args.registration)
    errs, _t = D.validate_registration(reg, Path(args.registration).resolve().parent)
    if errs:
        print('the driver refuses the registration: %s' % '; '.join(errs), file=sys.stderr)
        return 2
    if args.what == 'config':
        cfg = registered_config(reg)
        print(json.dumps({'registration_sha256': registration_digest(reg), 'config_hash': config_hash(cfg), 'config': cfg}, indent=2, sort_keys=True,
                         ensure_ascii=False))
        return 0
    status = 0
    for what, path, fn in (('leakguard', LEAKGUARD_OUT, leakguard), ('validate', VALIDATION_OUT, validate)):
        if args.what not in (what, 'all'):
            continue
        data = fn(reg)
        if args.check:
            same = json.loads(Path(path).read_text(encoding='utf-8')) == json.loads(json.dumps(data, sort_keys=True, ensure_ascii=False))
            print('%s: %s, %s' % (what, data['result'], 'matches the committed file' if same else 'DIFFERS from the committed file'))
            status = status or (0 if same and data['result'] == 'pass' else 1)
        else:
            write(path, data)
            print('%s: %s -> %s' % (what, data['result'], path))
            status = status or (0 if data['result'] == 'pass' else 1)
    return status


if __name__ == '__main__':
    sys.exit(main())
