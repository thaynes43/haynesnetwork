#!/usr/bin/env python3
"""Stage R driver (#161; pilot plan v3.2 sections 3.5 and 4.1 to 4.4): ONE process that runs G0b (discovery), G1 (identity), G2 (triage) and the final
check serially, and owns every stop.

Every remote operation, including the ones outside the harness (`list`, `stat`, `probe`, the final `stat`), goes through mrh-sampler-2 under the same rules
(remote_evidence.run_operation): a missing or malformed receipt, a changed hostname, an identity mismatch, `source_unchanged: false`, an outer timeout or a failed
exec is fatal.  After any fatal path the driver starts NO further operation and NO further target, records the reason and exits 3.

  G0b  `kubectl get deploy` (read-only) -> exactly one volume mount of the exec container whose mountPath matches the registered regex (else stop);
       `list <mount> --prefix <series prefix>` -> exactly one directory; `list <series dir>` -> each registered season regex matches exactly one directory;
       `list` each season directory.  Every listing must be complete (fewer than 500 matching entries, no timeout), else discovery stops before any media
       read.  A target is located only by exactly one listed entry: its recorded basename and bytes, or (no basename recorded) its bytes and its marker in
       the name; the basename found is then recorded as `discovered`.  No unique match drops the target.  The resolved manifest is written (and committed by
       the optional hook) BEFORE any media byte is read; the filled case files go through the leak guard.
  G1   per target, serially: `stat` (it must match the manifest bytes and the listing's mtime_ns, else the target is dropped; it sets the identity: size,
       mtime_ns, head and tail hashes) and `probe` bound to that identity.  Early stop (exit 4, no model call): no target of an early-stop role (registered,
       e.g. the offenders) has a text subtitle stream.
  G2   per target, serially: the G1 probe is put into the case as initial evidence, the filled case goes through the leak guard again, then one harness run
       (`--tools-behavior v3-remote-1 --stop-on-receipt-failure`, the per-target wall and the remaining cost cap), every sampler operation bound to the G1
       identity and host.  WRITE-CONTROL (a write attempt on a non-offender) stops Stage R after that case.  Then the final `stat`, bound to the identity: any
       difference from G1 (size, mtime_ns, head or tail hash) marks the already-recorded result INVALID, which is a stop.
  Pod health (optional, on by default): the exec pod's UID, its container restartCount and readiness, and that the pod name is the bound hostname, read with
       `kubectl get pods` before and after each target; a change or a failed read stops Stage R.

Deadlines and caps (remote_evidence): 25 s in the sampler, 60 s per operation, 600 s per target, 2 h for all of Stage R, $10 in total.

Usage: stage_r_driver.py --registration G0A.json --out DIR [--commit-repo DIR] [--no-pod-health]
The registration names everything case-specific (exec target, mount rule, series prefix, season rules, targets, case templates, harness arguments); this
script contains no target, title or id.  Exit: 0 every phase ran, 3 a stop, 4 the registered early stop, 2 a bad registration.
"""
import argparse
import copy
import datetime
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))

from media_repair_harness import leakguard  # noqa: E402
from media_repair_harness import protocol as P  # noqa: E402
from media_repair_harness import remote_evidence as RE  # noqa: E402
from media_repair_harness import run as R  # noqa: E402
from media_repair_harness import stage_r as SR  # noqa: E402
from media_repair_harness import tools as T  # noqa: E402

REGISTRATION_VERSION = 'stage-r-1'
OWNED_FLAGS = ('--suite', '--cases', '--out', '--scratch', '--tools-behavior', '--stop-on-receipt-failure', '--max-wall-s', '--max-total-cost-usd',
               '--no-spend-limit', '--evidence', '--split')
EXIT_OK, EXIT_BAD, EXIT_STOP, EXIT_EARLY = 0, 2, 3, 4


class Stop(Exception):
    def __init__(self, phase, kind, detail, target=None):
        super().__init__('%s %s: %s' % (phase, kind, detail))
        self.phase, self.kind, self.detail, self.target = phase, kind, detail, target


def load_registration(path):
    reg = json.loads(Path(path).read_text())
    errs = []
    if reg.get('registration') != REGISTRATION_VERSION:
        errs.append('registration must be %r' % REGISTRATION_VERSION)
    ex = reg.get('exec') or {}
    for k in ('namespace', 'deployment', 'container'):
        if not isinstance(ex.get(k), str) or not ex[k]:
            errs.append('exec.%s missing' % k)
    disc = reg.get('discovery') or {}
    if not isinstance(disc.get('mount_path_regex'), str) or not isinstance(disc.get('series_prefix'), str) or not disc.get('series_prefix'):
        errs.append('discovery.mount_path_regex and discovery.series_prefix are required')
    if not isinstance(disc.get('season_dirs'), dict) or not disc['season_dirs']:
        errs.append('discovery.season_dirs must map a season key to a regex')
    keys = set()
    for t in reg.get('targets') or []:
        if t.get('role') not in SR.ROLES:
            errs.append('target %r: role must be one of %s' % (t.get('key'), SR.ROLES))
        if not isinstance(t.get('bytes'), int) or t.get('season') not in (disc.get('season_dirs') or {}):
            errs.append('target %r: bytes (int) and a registered season are required' % t.get('key'))
        if bool(t.get('basename')) == bool(t.get('marker')):
            errs.append('target %r: exactly one of basename (recorded) or marker (discovered) is required' % t.get('key'))
        if t.get('key') in keys or not t.get('key'):
            errs.append('target keys must be unique and non-empty')
        keys.add(t.get('key'))
    if not reg.get('targets'):
        errs.append('no targets')
    # argparse accepts an unambiguous prefix of a long option (`--spl` for `--split`): any `--` item that is a prefix of an owned flag is refused too
    owned = [a for a in reg.get('harness_args') or [] if isinstance(a, str) and a.startswith('--') and any(f.startswith(a.split('=')[0]) for f in OWNED_FLAGS)]
    if owned:
        errs.append('harness_args may not set what the driver owns: %s' % owned)
    if errs:
        raise ValueError('; '.join(errs))
    reg.setdefault('limits', {})
    return reg


class Driver:
    def __init__(self, registration, out, runner=subprocess.run, harness=None, clock=time.monotonic, commit=None, pod_health=True, template_dir=None):
        self.reg, self.out, self.runner, self.clock, self.commit, self.pod_health = registration, Path(out), runner, clock, commit, pod_health
        self.harness = harness or (lambda argv: R.main(argv, runner=self.runner))
        self.template_dir = Path(template_dir) if template_dir else None
        ex = registration['exec']
        self.ns, self.container = ex['namespace'], ex['container']
        self.target = ex.get('target') or 'deploy/' + ex['deployment']
        lim = registration['limits']
        self.target_wall = float(lim.get('target_wall_s', RE.TARGET_WALL_S))
        self.stage_wall = float(lim.get('stage_wall_s', RE.STAGE_WALL_S))
        self.total_cost = float(lim.get('total_cost_usd', RE.TOTAL_COST_USD))
        self.g2_ops = int(lim.get('g2_operations', P.MAX_TOOL_CALLS))
        self.host = RE.HostState()
        self.dir_binding = RE.Binding(host=self.host)      # list operations (directories): receipt and host rules, no file identity
        self.started = None
        self.cost = 0.0
        self.state = {'driver': 'stage-r-driver-1', 'registration_sha256': None, 'started_at': None, 'phases': [], 'operations': [], 'targets': {},
                      'stop': None, 'early_stop': None, 'pod': None, 'cost_usd': 0.0, 'remote_evidence': RE.config()}
        for t in registration['targets']:
            self.state['targets'][t['key']] = {'role': t['role'], 'driver_outcome': 'not_started', 'reason': None}

    # ---------------------------------------------------------------------------------------------------------- bookkeeping
    def save(self):
        self.state['elapsed_s'] = round(self.elapsed(), 3)
        self.state['cost_usd'] = round(self.cost, 6)
        self.state['hostname'] = self.host.hostname
        (self.out / 'stage-r-state.json').write_text(json.dumps(self.state, indent=2, sort_keys=True, ensure_ascii=False, default=str) + '\n')

    def elapsed(self):
        return 0.0 if self.started is None else self.clock() - self.started

    def need_time(self, phase, seconds, target=None):
        if self.elapsed() + seconds > self.stage_wall:
            raise Stop(phase, 'stage_deadline', '%.0f s of the %.0f s Stage R deadline used; %.0f s more do not fit' % (self.elapsed(), self.stage_wall, seconds), target)

    def op(self, phase, binding, mode, path, opts=(), bind_identity=True, target=None):
        """One sampler operation under the stop rules; every one is logged with its argv and receipt."""
        self.need_time(phase, RE.OUTER_DEADLINE_S, target)
        n = len(binding.receipts)
        try:
            receipt, out = RE.run_operation(self.runner, self.ns, self.target, self.container, mode, path, binding, opts, bind_identity=bind_identity)
        except RE.FatalOperation as e:
            self.state['operations'] += [dict(r, phase=phase, target=target) for r in binding.receipts[n:]]
            self.save()
            raise Stop(phase, e.kind, e.detail, target)
        self.state['operations'] += [dict(r, phase=phase, target=target) for r in binding.receipts[n:]]
        self.save()
        return receipt, out

    def kubectl_json(self, phase, argv, target=None):
        self.need_time(phase, RE.OUTER_DEADLINE_S, target)
        cmd = ['kubectl', '-n', self.ns] + argv + ['-o', 'json']
        try:
            r = self.runner(cmd, capture_output=True, timeout=RE.OUTER_DEADLINE_S)
        except (subprocess.TimeoutExpired, OSError) as e:
            raise Stop(phase, 'read_failed', '%s: %s' % (' '.join(cmd), type(e).__name__), target)
        self.state['operations'].append({'phase': phase, 'target': target, 'argv': cmd, 'kind': 'read_only_get', 'returncode': r.returncode})
        if r.returncode != 0:
            raise Stop(phase, 'read_failed', '%s exited %s' % (' '.join(cmd), r.returncode), target)
        try:
            return json.loads(r.stdout)
        except ValueError:
            raise Stop(phase, 'read_failed', '%s returned no JSON' % ' '.join(cmd), target)

    # ---------------------------------------------------------------------------------------------------------- pod health
    def pod_reading(self, phase, deploy, target=None):
        sel = ((deploy.get('spec') or {}).get('selector') or {}).get('matchLabels') or {}
        if not sel:
            raise Stop(phase, 'pod_health', 'the deployment has no matchLabels selector', target)
        pods = self.kubectl_json(phase, ['get', 'pods', '-l', ','.join('%s=%s' % kv for kv in sorted(sel.items()))], target).get('items') or []
        if len(pods) != 1:
            raise Stop(phase, 'pod_health', '%d pods match the deployment selector, not exactly one' % len(pods), target)
        pod = pods[0]
        cs = [c for c in (pod.get('status') or {}).get('containerStatuses') or [] if c.get('name') == self.container]
        ready = any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in (pod.get('status') or {}).get('conditions') or [])
        return {'name': (pod.get('metadata') or {}).get('name'), 'uid': (pod.get('metadata') or {}).get('uid'),
                'restart_count': cs[0].get('restartCount') if cs else None, 'ready': ready}

    def check_pod(self, phase, target=None):
        if not self.pod_health:
            return
        now = self.pod_reading(phase, self.deploy, target)
        base = self.state['pod']
        self.state.setdefault('pod_readings', []).append(dict(now, phase=phase, target=target))
        if not now['ready'] or now['uid'] != base['uid'] or now['restart_count'] != base['restart_count'] or now['name'] != base['name']:
            raise Stop(phase, 'pod_health', 'pod changed or unready: baseline %s, now %s' % (base, now), target)
        if self.host.hostname is not None and now['name'] != self.host.hostname:
            raise Stop(phase, 'pod_health', 'the pod name %r is not the bound hostname %r' % (now['name'], self.host.hostname), target)

    # ---------------------------------------------------------------------------------------------------------- G0b
    def listing(self, phase, path, prefix=''):
        receipt, out = self.op(phase, self.dir_binding, 'list', path, ['--prefix', prefix] if prefix else [], bind_identity=False)
        try:
            data = json.loads(out)
        except ValueError:
            data = None
        complete = (receipt.get('exit_code') == 0 and not receipt.get('timed_out') and receipt['listing'].get('complete') is True
                    and isinstance(data, dict) and data.get('complete') is True and isinstance(data.get('entries'), list)
                    and len(data['entries']) == receipt['listing']['matching'] and receipt['listing']['matching'] < RE.LIST_CAP)
        if not complete:
            raise Stop(phase, 'incomplete_listing', 'the listing of a directory is not complete (exit %s, %s); no media read follows'
                       % (receipt.get('exit_code'), receipt.get('listing')))
        return data['entries']

    def g0b(self):
        disc = self.reg['discovery']
        self.state['phases'].append({'phase': 'G0b', 'at': self.elapsed()})
        self.deploy = self.kubectl_json('G0b', ['get', 'deploy', self.reg['exec']['deployment']])
        containers = [c for c in ((self.deploy.get('spec') or {}).get('template') or {}).get('spec', {}).get('containers', []) if c.get('name') == self.container]
        mounts = [m for c in containers for m in c.get('volumeMounts') or [] if re.search(disc['mount_path_regex'], m.get('mountPath') or '')]
        if len(mounts) != 1:
            raise Stop('G0b', 'mount_selection', '%d volume mounts of container %r match the registered rule, not exactly one' % (len(mounts), self.container))
        root = mounts[0]['mountPath'].rstrip('/') or '/'
        self.state['mount'] = root
        if self.pod_health:
            self.state['pod'] = self.pod_reading('G0b', self.deploy)
        series = [e for e in self.listing('G0b', root, disc['series_prefix']) if e['type'] == 'dir']
        if len(series) != 1:
            raise Stop('G0b', 'discovery', '%d directories match the series prefix, not exactly one' % len(series))
        series_dir = root + '/' + series[0]['name']
        top = [e for e in self.listing('G0b', series_dir) if e['type'] == 'dir']
        seasons = {}
        for key, rx in sorted(disc['season_dirs'].items()):
            hit = [e for e in top if re.search(rx, e['name'])]
            if len(hit) != 1:
                raise Stop('G0b', 'discovery', 'season rule %r matches %d directories, not exactly one' % (key, len(hit)))
            seasons[key] = series_dir + '/' + hit[0]['name']
        listed = {key: self.listing('G0b', path) for key, path in sorted(seasons.items())}
        manifest = []
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            files = [e for e in listed[t['season']] if e['type'] == 'file' and e['size'] == t['bytes']]
            hit = [e for e in files if e['name'] == t['basename']] if t.get('basename') else [e for e in files if t['marker'] in e['name']]
            if len(hit) != 1:
                st.update(driver_outcome='dropped', reason='G0b: %d listed entries match the locator rule, not exactly one' % len(hit))
                manifest.append({'key': t['key'], 'dropped': st['reason']})
                continue
            e = hit[0]
            st.update(path=seasons[t['season']] + '/' + e['name'], listed={'size': e['size'], 'mtime_ns': e['mtime_ns']},
                      basename=e['name'], basename_source='recorded' if t.get('basename') else 'discovered')
            manifest.append({'key': t['key'], 'role': t['role'], 'file_id': t.get('file_id'), 'bytes': t['bytes'], 'locator': self.locator(st['path']),
                             'basename': e['name'], 'basename_source': st['basename_source'], 'listed_mtime_ns': e['mtime_ns'],
                             'provenance': 'listed at G0b'})
        path = self.out / 'g0b-manifest.json'
        path.write_text(json.dumps({'hostname': self.host.hostname, 'mount': root, 'targets': manifest}, indent=2, sort_keys=True, ensure_ascii=False) + '\n')
        self.state['g0b_manifest_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        for t in self.reg['targets']:
            if self.state['targets'][t['key']]['driver_outcome'] != 'dropped':
                self.leak_check('G0b', t, self.fill(t, with_probe=False))
        self.save()
        if self.commit is not None:
            try:
                self.state['g0b_commit'] = self.commit(path)
            except Exception as e:  # noqa: BLE001 - a manifest that is not committed must not be followed by a media read
                raise Stop('G0b', 'manifest_commit', '%s: %s' % (type(e).__name__, e))
        self.save()

    def locator(self, path):
        return 'remote:%s/%s/%s:%s' % (self.ns, self.reg['exec']['deployment'], self.container, path)

    # ---------------------------------------------------------------------------------------------------------- G1
    def g1(self):
        self.state['phases'].append({'phase': 'G1', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            b = RE.Binding(host=self.host, max_operations=2)
            receipt, out = self.op('G1', b, 'stat', st['path'], bind_identity=False, target=t['key'])
            fp = None
            try:
                fp = json.loads(out) if receipt['exit_code'] == 0 else None
            except ValueError:
                fp = None
            if not isinstance(fp, dict) or fp.get('size') != t['bytes'] or fp.get('mtime_ns') != st['listed']['mtime_ns']:
                st.update(driver_outcome='dropped', reason='G1: the stat (%s) does not match the manifest bytes and the listed mtime_ns' % (
                    {k: (fp or {}).get(k) for k in ('size', 'mtime_ns')} if fp else 'exit %s' % receipt.get('exit_code')))
                self.save()
                continue
            st['identity'] = {k: fp[k] for k in ('size', 'mtime_ns', 'head_1m_sha256', 'tail_1m_sha256')}
            b.identity = dict(st['identity'])
            receipt, out = self.op('G1', b, 'probe', st['path'], ['--at', 0.0, '--stream', 0], target=t['key'])
            st['probe'] = self.probe_evidence(receipt, out)
            st['subtitle_stream'] = RE.select_subtitle_stream([dict(st['probe'], id='probe')])
            st['g1_operations'] = b.operations
            self.save()
        roles = self.reg.get('early_stop_roles') or []
        if roles and not any(s.get('subtitle_stream') for k, s in self.state['targets'].items() if s['role'] in roles and s['driver_outcome'] != 'dropped'):
            self.state['early_stop'] = 'no target of role %s has a text subtitle stream: Stage R stops before G2 and no model call is made' % roles
            raise Stop('G1', 'early_stop', self.state['early_stop'])

    @staticmethod
    def probe_evidence(receipt, out):
        if receipt['exit_code'] == 'timeout':
            return {'tool': 'ffprobe', 'args': {}, 'status': 'timeout', 'output': 'ffprobe timed out inside the sampler'}
        if receipt['exit_code'] != 0:
            return {'tool': 'ffprobe', 'args': {}, 'status': 'error', 'output': json.dumps({'exit_code': receipt['exit_code'], 'stderr': (receipt.get('stderr') or '')[:1500]})}
        try:
            return {'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(T._condense(json.loads(out.decode())), sort_keys=True, ensure_ascii=False)}
        except ValueError:
            return {'tool': 'ffprobe', 'args': {}, 'status': 'error', 'output': 'ffprobe returned no JSON'}

    # ---------------------------------------------------------------------------------------------------------- G2 and the final check
    def template(self, t):
        base = self.template_dir or Path('.')
        return json.loads((base / t['case_template']).read_text()) if isinstance(t.get('case_template'), str) else copy.deepcopy(t['case'])

    def fill(self, t, with_probe=True):
        st = self.state['targets'][t['key']]
        case = self.template(t)
        fx = {'kind': 'remote', 'locator': self.locator(st['path']), 'exec_target': self.target, 'max_operations': self.g2_ops}
        if st.get('identity'):
            fx['expected_identity'] = dict(st['identity'])
        if self.host.hostname:
            fx['expected_hostname'] = self.host.hostname
        case['fixture'] = fx
        if with_probe and st.get('probe'):
            ids = {e.get('id') for e in case.get('evidence') or []}
            n = 1
            while 'e%d' % n in ids:
                n += 1
            # FIRST: subtitle_sample takes its stream from the first ok probe of the case evidence, which must be this file's G1 probe
            case['evidence'] = [dict(st['probe'], id='e%d' % n)] + list(case.get('evidence') or [])
        return case

    def leak_check(self, phase, t, case):
        """The model-visible view of a filled case (context, tools, every evidence output after redaction) through the leak guard."""
        evidence = R.resolve_evidence_raw(case, str(self.out), lambda text: leakguard.redact(text, case, [self.state['targets'][t['key']]['path']]))
        view = json.dumps(P.case_view(case, evidence), ensure_ascii=False, sort_keys=True)
        hits = leakguard.find_leaks(case, view, [self.state['targets'][t['key']]['path']])
        if hits:
            raise Stop(phase, 'leak_guard', 'the filled case of target %s carries forbidden token kinds %s' % (t['key'], sorted({h[0] if isinstance(h, tuple) else h for h in hits})), t['key'])

    def g2(self):
        self.state['phases'].append({'phase': 'G2', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            self.need_time('G2', self.target_wall + 2 * RE.OUTER_DEADLINE_S, t['key'])
            remaining = self.total_cost - self.cost
            if remaining <= 0:
                raise Stop('G2', 'cost_cap', 'the $%.2f Stage R cost cap is used' % self.total_cost, t['key'])
            self.check_pod('G2', t['key'])
            case = self.fill(t)
            stream = RE.select_subtitle_stream(case['evidence'])
            want = st.get('subtitle_stream')
            if (stream or {}).get('index') != (want or {}).get('index') or (stream or {}).get('codec') != (want or {}).get('codec'):
                raise Stop('G2', 'stream_mismatch', 'the filled case would select subtitle stream %s, the G1 probe names %s' % (stream, want), t['key'])
            self.leak_check('G2', t, case)
            suite = self.out / 'g2' / t['key'] / 'suite'
            (suite / 'cases').mkdir(parents=True, exist_ok=True)
            (suite / 'cases' / (case['id'] + '.json')).write_text(json.dumps(case, indent=2, sort_keys=True, ensure_ascii=False) + '\n')
            run_dir = self.out / 'g2' / t['key'] / 'run'
            argv = list(self.reg.get('harness_args') or []) + ['--suite', str(suite), '--cases', case['id'], '--out', str(run_dir),
                                                               '--scratch', str(self.out / 'g2' / t['key'] / 'scratch'), '--evidence', 'replay',
                                                               '--tools-behavior', RE.VERSION, '--stop-on-receipt-failure',
                                                               '--max-wall-s', '%g' % self.target_wall, '--max-total-cost-usd', '%g' % remaining]
            st.update(driver_outcome='started', g2={'argv': argv, 'run_dir': str(run_dir)})
            self.save()
            try:
                rc = self.harness(argv)
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else 2
            manifest = self.read_json(run_dir / 'manifest.json') or {}
            self.cost += float((manifest.get('limits_state') or {}).get('cost_usd') or 0.0)
            record = self.read_json(run_dir / (case['id'] + '.json'))
            partial = self.read_json(run_dir / 'started-aborted' / (case['id'] + '.json'))
            st['g2'].update(rc=rc, aborted=manifest.get('aborted'), record=str(run_dir / (case['id'] + '.json')) if record else None,
                            started_aborted=str(run_dir / 'started-aborted' / (case['id'] + '.json')) if partial else None)
            self.copy_receipts(t['key'], record or partial)
            if partial is not None or record is None or rc != 0 or manifest.get('aborted'):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the harness run did not record the case normally (rc %s, aborted %r)' % (rc, manifest.get('aborted')), t['key'])
            ops = (record.get('remote_evidence') or {}).get('operations', 0)
            if ops > self.g2_ops or (record.get('remote_evidence') or {}).get('hostname') not in (None, self.host.hostname):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'binding', 'the run reports %s operations on host %r' % (ops, (record.get('remote_evidence') or {}).get('hostname')), t['key'])
            st['driver_outcome'] = 'recorded'
            safety = SR.proposal_safety(t['role'], record)
            st['write_attempts'] = safety['attempts']
            self.final_check(t)
            if safety['write_control']:
                raise Stop('G2', 'write_control', 'a write attempt on a non-offender target (%s)' % [a['action'] for a in safety['attempts']], t['key'])
            self.check_pod('G2', t['key'])
            self.save()

    def final_check(self, t):
        st = self.state['targets'][t['key']]
        b = RE.Binding(identity=st['identity'], host=self.host, max_operations=1)
        try:
            receipt, out = self.op('final', b, 'stat', st['path'], target=t['key'])
        except Stop as e:
            if e.kind == 'identity_mismatch':
                st.update(driver_outcome='invalid', reason='final: %s' % e.detail)
            else:
                st.update(driver_outcome='stopped', reason='final: %s %s' % (e.kind, e.detail))
            raise
        try:
            fp = json.loads(out) if receipt['exit_code'] == 0 else None
        except ValueError:
            fp = None
        now = {k: (fp or {}).get(k) for k in ('size', 'mtime_ns', 'head_1m_sha256', 'tail_1m_sha256')}
        st['final'] = now
        if now != st['identity']:
            st.update(driver_outcome='invalid', reason='final: the fingerprint %s differs from G1 %s' % (now, st['identity']))
            raise Stop('final', 'final_mismatch', st['reason'], t['key'])

    def copy_receipts(self, key, rec):
        for r in ((rec or {}).get('remote_evidence') or {}).get('receipts') or []:
            self.state['operations'].append(dict(r, phase='G2', target=key))

    @staticmethod
    def read_json(p):
        try:
            return json.loads(Path(p).read_text())
        except (OSError, ValueError):
            return None

    # ---------------------------------------------------------------------------------------------------------- the whole run
    def run(self):
        self.out.mkdir(parents=True, exist_ok=True)
        self.started = self.clock()
        self.state['started_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.state['registration_sha256'] = hashlib.sha256(json.dumps(self.reg, sort_keys=True).encode()).hexdigest()
        self.save()
        code = EXIT_OK
        try:
            self.g0b()
            self.g1()
            self.g2()
        except Stop as e:
            self.state['stop'] = {'phase': e.phase, 'kind': e.kind, 'detail': e.detail, 'target': e.target}
            for st in self.state['targets'].values():
                if st['driver_outcome'] == 'started':
                    st['driver_outcome'] = 'stopped'       # a target whose harness run the stop cut short
                if st['driver_outcome'] in ('stopped', 'not_started'):
                    st['reason'] = st['reason'] or '%s: %s %s' % ('stopped' if st['driver_outcome'] == 'stopped' else 'never started after the stop', e.phase, e.kind)
            code = EXIT_EARLY if e.kind == 'early_stop' else EXIT_STOP
        self.state['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.state['exit_code'] = code
        self.save()
        return code


def git_committer(repo):
    def commit(path):
        rel = str(Path(path).resolve().relative_to(Path(repo).resolve()))
        subprocess.run(['git', '-C', str(repo), 'add', rel], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'stage-r: G0b manifest (%s)' % rel], check=True, capture_output=True)
        return subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
    return commit


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--registration', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--commit-repo', help='commit the G0b manifest in this git checkout before any media read (the manifest must be under it)')
    ap.add_argument('--no-pod-health', action='store_true', help='skip the driver\'s own read-only pod checks (the coordinator then does them)')
    args = ap.parse_args(argv)
    try:
        reg = load_registration(args.registration)
    except (OSError, ValueError) as e:
        print('bad registration: %s' % e, file=sys.stderr)
        return EXIT_BAD
    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        print('refusing a non-empty --out (a stopped run is never replaced): %s' % out, file=sys.stderr)
        return EXIT_BAD
    d = Driver(reg, out, commit=git_committer(args.commit_repo) if args.commit_repo else None, pod_health=not args.no_pod_health,
               template_dir=Path(args.registration).resolve().parent)
    code = d.run()
    if d.state['stop']:
        print('STOP: %(phase)s %(kind)s: %(detail)s' % d.state['stop'], file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
