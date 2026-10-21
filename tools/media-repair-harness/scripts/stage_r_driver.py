#!/usr/bin/env python3
"""Stage R driver (#161; pilot plan v3.2 sections 3.5 and 4.1 to 4.4): ONE process that runs G0b (discovery), G1 (identity), G2 (triage) and the final
check serially, and owns every stop.

Every remote operation, including the ones outside the harness (`list`, `stat`, `probe`, the final `stat`), goes through mrh-sampler-2 under the same rules
(remote_evidence.run_operation): a non-zero exec exit, a missing or malformed receipt, a changed hostname, an identity mismatch (size, mtime_ns, device,
inode), `source_unchanged: false`, a path not confined under the mount, an outer timeout or a failed exec is fatal.  After any fatal path, and after any
unexpected error (recorded as a `driver_error` stop), the driver starts NO further operation and NO further target, records the reason and exits 3.  The
terminal state (`exit_code`) is always written.

  G0b  `kubectl get deploy` (read-only) -> exactly one volume mount of the exec container whose mountPath FULLY matches the registered rule (else stop); the
       exec pod's baseline health (exactly one pod, ready, its restartCount) is validated at once (section 4.4), and its name must be the hostname the first
       receipt binds; `list <mount> --prefix <series prefix>` -> exactly one directory; `list <series dir>` -> each registered season rule fully matches
       exactly one directory; `list` each season directory.  Every listing must be complete and consistent (the directory and prefix asked for, equal
       counts in the receipt and the body, `scanned` at least `matching`, a valid entry for every name, no separator, traversal or control name), else
       discovery stops before any media read.  A target is located only by exactly one listed regular file: its recorded basename and bytes, or (no basename
       recorded) its bytes and its marker in the name, then recorded as `discovered`.  No unique match drops the target.  The resolved manifest is written
       and COMMITTED (section 4.2.3, mandatory; the commit is verified to hold the manifest's bytes) before any media byte is read; the filled case files go
       through the leak guard.
  G1   per target, serially, inside the pod checks: `stat` (its start identity must match the listing and its fingerprint the manifest bytes, else the target
       is dropped; it sets the identity: size, mtime_ns, device, inode, head and tail hashes) and `probe` bound to that identity.  The early stop (section
       4.2.4, a REQUIRED registration field): no target of an early-stop role has a text subtitle stream -> exit 4, no model call.
  G2   per target, serially, inside the pod checks: the G1 probe is the case's FIRST evidence (subtitle_sample takes its stream from it), the filled case
       goes through the leak guard again, then one harness run (`--tools-behavior v3-remote-1 --stop-on-receipt-failure`, the per-target wall, which also
       bounds every operation, and the remaining cost cap).  A run that did not record the case normally, or whose record holds a fatal operation, stops
       Stage R.  WRITE-CONTROL (any raw write attempt on a non-offender, whatever its validity) stops Stage R after that case.  Then the final `stat`, bound
       to the identity: any difference from G1 marks the already-recorded result INVALID, which is a stop.

Registered limits (a registration may lower them, never raise them): 25 s per sampler invocation, 60 s per operation, 600 s per target, 2 h for Stage R,
$10 in total, 6 G2 operations per target.

Usage: stage_r_driver.py --registration G0A.json --out DIR --commit-repo DIR
The registration names everything case-specific (exec target, mount rule, series prefix, season rules, targets, case templates, harness arguments); this
script contains no target, title or id.  Exit: 0 every phase ran, 3 a stop, 4 the registered early stop, 2 a bad registration.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
import os
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
# the registered ceilings (pilot plan section 3.4): a registration may lower a limit, never raise it, and every value is finite and positive
LIMIT_CEILINGS = {'target_wall_s': RE.TARGET_WALL_S, 'stage_wall_s': RE.STAGE_WALL_S, 'total_cost_usd': RE.TOTAL_COST_USD, 'g2_operations': P.MAX_TOOL_CALLS}
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')        # target keys and case ids: one safe path component
K8S_NAME = re.compile(r'^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$')
EXEC_TARGET = re.compile(r'^(deploy|pod)/[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$')
ENTRY_KEYS = {'name', 'type', 'size', 'mtime_ns', 'dev', 'ino'}
ENTRY_TYPES = ('dir', 'file', 'symlink', 'other')
FP_KEYS = {'size', 'mtime_ns', 'head_1m_sha256', 'tail_1m_sha256', 'partial_fingerprint_only'}
HEX64 = re.compile(r'^[0-9a-f]{64}$')


class Stop(Exception):
    def __init__(self, phase, kind, detail, target=None):
        super().__init__('%s %s: %s' % (phase, kind, detail))
        self.phase, self.kind, self.detail, self.target = phase, kind, detail, target


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def safe_name(n):
    """A listed name that may name a directory or file in this run: a non-empty str, valid UTF-8, no separator, NUL, control character or traversal."""
    if not isinstance(n, str) or not n or n in ('.', '..') or '/' in n or any(ord(c) < 32 or ord(c) == 127 for c in n):
        return False
    try:
        n.encode('utf-8')
    except UnicodeEncodeError:
        return False
    return True


def canonical_sha256(registration):
    return hashlib.sha256(json.dumps(registration, sort_keys=True).encode()).hexdigest()


def validate_registration(reg, template_dir=None):
    """-> (errors, templates by target key).  Everything a run depends on is checked before anything starts; nothing is defaulted silently."""
    errs, templates = [], {}
    if not isinstance(reg, dict):
        return ['the registration is not a JSON object'], templates
    if reg.get('registration') != REGISTRATION_VERSION:
        errs.append('registration must be %r' % REGISTRATION_VERSION)
    ex = reg.get('exec') or {}
    for k in ('namespace', 'deployment', 'container'):
        if not (isinstance(ex.get(k), str) and K8S_NAME.match(ex[k])):
            errs.append('exec.%s missing or not a valid name' % k)
    if 'target' in ex and not (isinstance(ex['target'], str) and EXEC_TARGET.match(ex['target'])):
        errs.append('exec.target must be deploy/<name> or pod/<name>')
    disc = reg.get('discovery') or {}
    for k in ('mount_path_regex', 'series_prefix'):
        if not (isinstance(disc.get(k), str) and disc[k]):
            errs.append('discovery.%s is required' % k)
    rules = disc.get('season_dirs')
    if not isinstance(rules, dict) or not rules:
        errs.append('discovery.season_dirs must map a season key to a rule')
        rules = {}
    for rx in [disc.get('mount_path_regex')] + list(rules.values()):
        try:
            re.compile(rx if isinstance(rx, str) else '')
        except re.error as e:
            errs.append('a discovery rule does not compile: %s' % e)
    if isinstance(disc.get('series_prefix'), str) and not safe_name(disc['series_prefix']):
        errs.append('discovery.series_prefix must be a safe name prefix')
    roles = reg.get('early_stop_roles')
    if not (isinstance(roles, list) and roles and all(r in SR.ROLES for r in roles)):
        errs.append('early_stop_roles is required (pilot plan section 4.2.4): a non-empty list of roles from %s' % (SR.ROLES,))
    lim = reg.get('limits', {})
    if not isinstance(lim, dict):
        errs.append('limits must be an object')
        lim = {}
    for k, v in lim.items():
        if k not in LIMIT_CEILINGS:
            errs.append('unknown limit %r' % k)
        elif k == 'g2_operations' and not (_int(v) and 1 <= v <= LIMIT_CEILINGS[k]):
            errs.append('limits.g2_operations must be an integer from 1 to %d' % LIMIT_CEILINGS[k])
        elif k != 'g2_operations' and not (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 < v <= LIMIT_CEILINGS[k]):
            errs.append('limits.%s must be a finite number above 0 and at most the registered %s' % (k, LIMIT_CEILINGS[k]))
    keys, case_ids = set(), set()
    targets = reg.get('targets')
    if not isinstance(targets, list) or not targets:
        errs.append('no targets')
        targets = []
    for t in targets:
        if not isinstance(t, dict):
            errs.append('a target is not an object')
            continue
        key = t.get('key')
        if not (isinstance(key, str) and SAFE_ID.match(key)) or key in keys:
            errs.append('target key %r must be unique and a safe path component' % (key,))
        keys.add(key)
        if t.get('role') not in SR.ROLES:
            errs.append('target %r: role must be one of %s' % (key, SR.ROLES))
        if not (_int(t.get('bytes')) and t['bytes'] > 0) or t.get('season') not in rules:
            errs.append('target %r: bytes (a positive integer) and a registered season are required' % (key,))
        if bool(t.get('basename')) == bool(t.get('marker')):
            errs.append('target %r: exactly one of basename (recorded) or marker (discovered) is required' % (key,))
        if t.get('basename') is not None and not safe_name(t['basename']):
            errs.append('target %r: the basename must be a safe name' % (key,))
        case = None
        if isinstance(t.get('case_template'), str):
            rel = Path(t['case_template'])
            base = Path(template_dir) if template_dir else Path('.')
            if rel.is_absolute() or '..' in rel.parts:
                errs.append('target %r: case_template must be a relative path under the registration' % (key,))
            else:
                try:
                    case = json.loads((base / rel).read_text())
                except (OSError, ValueError) as e:
                    errs.append('target %r: case_template unreadable (%s)' % (key, type(e).__name__))
        elif isinstance(t.get('case'), dict):
            case = copy.deepcopy(t['case'])
        else:
            errs.append('target %r: a case or case_template is required' % (key,))
        if isinstance(case, dict):
            cid = case.get('id')
            if not (isinstance(cid, str) and SAFE_ID.match(cid)) or cid in case_ids:
                errs.append('target %r: the case id %r must be unique and a safe path component' % (key, cid))
            case_ids.add(cid)
            if 'inject_tool_failure' in case:
                errs.append('target %r: a Stage R case may not inject a tool failure' % (key,))
            templates[key] = case
        elif case is not None:
            errs.append('target %r: the case is not an object' % (key,))
    # argparse accepts an unambiguous prefix of a long option (`--spl` for `--split`): any `--` item that is a prefix of an owned flag is refused too
    hargs = reg.get('harness_args') or []
    if not isinstance(hargs, list) or not all(isinstance(a, str) for a in hargs):
        errs.append('harness_args must be a list of strings')
        hargs = []
    owned = [a for a in hargs if a.startswith('--') and any(f.startswith(a.split('=')[0]) for f in OWNED_FLAGS)]
    if owned:
        errs.append('harness_args may not set what the driver owns: %s' % owned)
    return errs, templates


def load_registration(path):
    reg = json.loads(Path(path).read_text())
    errs, _templates = validate_registration(reg, Path(path).resolve().parent)
    if errs:
        raise ValueError('; '.join(errs))
    return reg


def fingerprint_errors(fp):
    if not isinstance(fp, dict) or set(fp) != FP_KEYS:
        return ['the fingerprint is not {%s}' % ', '.join(sorted(FP_KEYS))]
    errs = []
    if not (_int(fp['size']) and fp['size'] >= 0 and _int(fp['mtime_ns'])):
        errs.append('the fingerprint size and mtime_ns must be integers')
    if not all(isinstance(fp[k], str) and HEX64.match(fp[k]) for k in ('head_1m_sha256', 'tail_1m_sha256')):
        errs.append('the fingerprint hashes must be sha256 hex')
    if fp['partial_fingerprint_only'] is not True:
        errs.append('partial_fingerprint_only must be true')
    return errs


class Driver:
    def __init__(self, registration, out, runner=subprocess.run, harness=None, clock=time.monotonic, commit=None, pod_health=True, template_dir=None):
        errs, self.templates = validate_registration(registration, template_dir)
        if errs:
            raise ValueError('; '.join(errs))
        if commit is None:
            raise ValueError('a G0b manifest commit hook is required (pilot plan section 4.2.3: committed before any media byte is read)')
        self.reg, self.out, self.runner, self.clock, self.commit, self.pod_health = registration, Path(out), runner, clock, commit, pod_health
        self.harness = harness or (lambda argv: R.main(argv, runner=self.runner))
        ex = registration['exec']
        self.ns, self.container = ex['namespace'], ex['container']
        self.target = ex.get('target') or 'deploy/' + ex['deployment']
        lim = dict(LIMIT_CEILINGS, **registration.get('limits', {}))
        self.target_wall, self.stage_wall, self.total_cost = float(lim['target_wall_s']), float(lim['stage_wall_s']), float(lim['total_cost_usd'])
        self.g2_ops = int(lim['g2_operations'])
        self.host = RE.HostState()
        self.mount = None
        self.dir_binding = None
        self.started = None
        self.cost = 0.0
        self.phase, self.current = 'init', None
        self.state = {'driver': 'stage-r-driver-2', 'registration_sha256': canonical_sha256(registration), 'started_at': None, 'phases': [], 'operations': [],
                      'targets': {}, 'stop': None, 'early_stop': None, 'pod': None, 'cost_usd': 0.0, 'remote_evidence': RE.config(),
                      'limits': {'target_wall_s': self.target_wall, 'stage_wall_s': self.stage_wall, 'total_cost_usd': self.total_cost, 'g2_operations': self.g2_ops},
                      'skipped': [] if pod_health else ['pod_health (pilot plan section 4.4)']}
        for t in registration['targets']:
            self.state['targets'][t['key']] = {'role': t['role'], 'driver_outcome': 'not_started', 'reason': None}

    # ---------------------------------------------------------------------------------------------------------- bookkeeping
    def save(self):
        self.state['elapsed_s'] = round(self.elapsed(), 3)
        self.state['cost_usd'] = round(self.cost, 6)
        self.state['hostname'] = self.host.hostname
        try:
            text = json.dumps(self.state, indent=2, sort_keys=True, ensure_ascii=False, default=str) + '\n'
            text.encode('utf-8')
        except (UnicodeEncodeError, ValueError):
            text = json.dumps(self.state, indent=2, sort_keys=True, ensure_ascii=True, default=str) + '\n'
        (self.out / 'stage-r-state.json').write_text(text, encoding='utf-8')

    def elapsed(self):
        return 0.0 if self.started is None else self.clock() - self.started

    def need_time(self, phase, seconds, target=None):
        if not (isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0):
            raise Stop(phase, 'driver_error', 'an invalid time reservation %r' % (seconds,), target)
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
        except Exception as e:  # noqa: BLE001 - a read that did not complete is a failed read
            raise Stop(phase, 'read_failed', '%s: %s' % (' '.join(cmd), type(e).__name__), target)
        self.state['operations'].append({'phase': phase, 'target': target, 'argv': cmd, 'kind': 'read_only_get', 'returncode': r.returncode})
        if r.returncode != 0:
            raise Stop(phase, 'read_failed', '%s exited %s' % (' '.join(cmd), r.returncode), target)
        try:
            data = json.loads(r.stdout)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise Stop(phase, 'read_failed', '%s returned no JSON object' % ' '.join(cmd), target)
        return data

    def path_under_out(self, *parts):
        p = self.out.joinpath(*parts)
        if not p.resolve().is_relative_to(self.out.resolve()):
            raise Stop(self.phase, 'driver_error', 'an artifact path leaves --out: %s' % p, self.current)
        return p

    # ---------------------------------------------------------------------------------------------------------- pod health (section 4.4)
    def pod_reading(self, phase, target=None):
        sel = ((self.deploy.get('spec') or {}).get('selector') or {}).get('matchLabels') or {}
        if not isinstance(sel, dict) or not sel:
            raise Stop(phase, 'pod_health', 'the deployment has no matchLabels selector', target)
        pods = self.kubectl_json(phase, ['get', 'pods', '-l', ','.join('%s=%s' % kv for kv in sorted(sel.items()))], target).get('items')
        if not isinstance(pods, list) or len(pods) != 1 or not isinstance(pods[0], dict):
            raise Stop(phase, 'pod_health', '%s pods match the deployment selector, not exactly one' % (len(pods) if isinstance(pods, list) else 'no list of'), target)
        pod = pods[0]
        meta, status = pod.get('metadata') or {}, pod.get('status') or {}
        cs = [c for c in status.get('containerStatuses') or [] if isinstance(c, dict) and c.get('name') == self.container]
        ready = any(isinstance(c, dict) and c.get('type') == 'Ready' and c.get('status') == 'True' for c in status.get('conditions') or [])
        reading = {'name': meta.get('name'), 'uid': meta.get('uid'), 'restart_count': cs[0].get('restartCount') if len(cs) == 1 else None, 'ready': ready}
        if not (isinstance(reading['name'], str) and reading['name'] and isinstance(reading['uid'], str) and reading['uid']
                and _int(reading['restart_count']) and reading['restart_count'] >= 0):
            raise Stop(phase, 'pod_health', 'the pod reading is incomplete: %s' % reading, target)
        if not ready:
            raise Stop(phase, 'pod_health', 'the exec pod is not ready: %s' % reading, target)
        return reading

    def check_pod(self, phase, target=None):
        if not self.pod_health:
            return
        now = self.pod_reading(phase, target)
        base = self.state['pod']
        self.state.setdefault('pod_readings', []).append(dict(now, phase=phase, target=target))
        if now['uid'] != base['uid'] or now['restart_count'] != base['restart_count'] or now['name'] != base['name']:
            raise Stop(phase, 'pod_health', 'the exec pod changed: baseline %s, now %s' % (base, now), target)
        if self.host.hostname is not None and now['name'] != self.host.hostname:
            raise Stop(phase, 'pod_health', 'the pod name %r is not the bound hostname %r' % (now['name'], self.host.hostname), target)

    # ---------------------------------------------------------------------------------------------------------- G0b
    def listing(self, phase, path, prefix=''):
        receipt, out = self.op(phase, self.dir_binding, 'list', path, ['--prefix', prefix] if prefix else [], bind_identity=False)
        lst = receipt.get('listing') or {}
        if receipt['exit_code'] != 0 or receipt['timed_out'] or lst.get('complete') is not True:
            raise Stop(phase, 'incomplete_listing', 'the listing of a directory is not complete (exit %s, %s); no media read follows' % (receipt['exit_code'], lst))
        try:
            data = json.loads(out)
        except ValueError:
            data = None
        problems = []
        if not isinstance(data, dict) or set(data) != {'directory', 'prefix', 'complete', 'matching', 'scanned', 'entries'} or not isinstance(data.get('entries'), list):
            problems.append('the listing body is not the listing object')
        else:
            entries = data['entries']
            if (data['directory'], data['prefix'], lst.get('directory'), lst.get('prefix')) != (path, prefix, path, prefix):
                problems.append('the listing names another directory or prefix than was asked')
            if data['complete'] is not True:
                problems.append('the body says the listing is incomplete')
            if not (_int(data['matching']) and _int(data['scanned']) and data['matching'] == lst['matching'] == len(entries)
                    and data['scanned'] == lst['scanned'] and 0 <= data['matching'] <= data['scanned'] and data['matching'] < RE.LIST_CAP):
                problems.append('the listing counts are inconsistent (receipt %s, body matching %r scanned %r, %d entries)' % (
                    lst, data.get('matching'), data.get('scanned'), len(entries)))
            names = set()
            for e in entries:
                if not (isinstance(e, dict) and set(e) == ENTRY_KEYS and safe_name(e['name']) and e['name'].startswith(prefix) and e['type'] in ENTRY_TYPES
                        and _int(e['size']) and e['size'] >= 0 and _int(e['mtime_ns']) and _int(e['dev']) and e['dev'] >= 0 and _int(e['ino']) and e['ino'] >= 0
                        and e['name'] not in names):
                    problems.append('a listed entry is malformed, unsafe, outside the prefix or repeated: %r' % (e if not isinstance(e, dict) else {k: e.get(k) for k in ('name', 'type')},))
                    break
                names.add(e['name'])
        if problems:
            raise Stop(phase, 'malformed_listing', '; '.join(problems)[:600])
        return data['entries']

    def g0b(self):
        self.phase = 'G0b'
        disc = self.reg['discovery']
        self.state['phases'].append({'phase': 'G0b', 'at': self.elapsed()})
        self.deploy = self.kubectl_json('G0b', ['get', 'deploy', self.reg['exec']['deployment']])
        containers = [c for c in (((self.deploy.get('spec') or {}).get('template') or {}).get('spec') or {}).get('containers') or []
                      if isinstance(c, dict) and c.get('name') == self.container]
        mounts = [m for c in containers for m in c.get('volumeMounts') or []
                  if isinstance(m, dict) and isinstance(m.get('mountPath'), str) and re.fullmatch(disc['mount_path_regex'], m['mountPath'])]
        if len(mounts) != 1:
            raise Stop('G0b', 'mount_selection', '%d volume mounts of container %r match the registered rule, not exactly one' % (len(mounts), self.container))
        root = mounts[0]['mountPath']
        if root != '/' and root.endswith('/'):
            root = root.rstrip('/')
        if not (root.startswith('/') and os.path.normpath(root) == root and '\n' not in root and '\0' not in root):
            raise Stop('G0b', 'mount_selection', 'the mount path %r is not an absolute normalised path' % root)
        self.mount = self.state['mount'] = root
        self.dir_binding = RE.Binding(host=self.host, root=root)
        if self.pod_health:
            self.state['pod'] = self.pod_reading('G0b')          # validated at once: exactly one pod, ready, a restart count
        series = [e for e in self.listing('G0b', root, disc['series_prefix']) if e['type'] == 'dir']
        if self.pod_health and self.state['pod']['name'] != self.host.hostname:
            raise Stop('G0b', 'pod_health', 'the pod name %r is not the hostname %r the first receipt binds' % (self.state['pod']['name'], self.host.hostname))
        if len(series) != 1:
            raise Stop('G0b', 'discovery', '%d directories match the series prefix, not exactly one' % len(series))
        series_dir = root.rstrip('/') + '/' + series[0]['name']
        top = [e for e in self.listing('G0b', series_dir) if e['type'] == 'dir']
        seasons = {}
        for key, rx in sorted(disc['season_dirs'].items()):
            hit = [e for e in top if re.fullmatch(rx, e['name'])]
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
            st.update(path=seasons[t['season']] + '/' + e['name'], listed={k: e[k] for k in RE.IDENTITY_FIELDS},
                      basename=e['name'], basename_source='recorded' if t.get('basename') else 'discovered')
            manifest.append({'key': t['key'], 'role': t['role'], 'file_id': t.get('file_id'), 'bytes': t['bytes'], 'locator': self.locator(st['path']),
                             'basename': e['name'], 'basename_source': st['basename_source'], 'listed': st['listed'], 'provenance': 'listed at G0b'})
        path = self.path_under_out('g0b-manifest.json')
        path.write_text(json.dumps({'hostname': self.host.hostname, 'mount': root, 'targets': manifest}, indent=2, sort_keys=True, ensure_ascii=False) + '\n')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.state['g0b_manifest_sha256'] = digest
        for t in self.reg['targets']:
            if self.state['targets'][t['key']]['driver_outcome'] != 'dropped':
                self.leak_check('G0b', t, self.fill(t, with_probe=False))
        self.save()
        # the manifest is committed, and the commit verified to hold exactly these bytes, before any media byte is read (section 4.2.3)
        try:
            got = self.commit(path)
        except Exception as e:  # noqa: BLE001 - a manifest that is not committed must not be followed by a media read
            raise Stop('G0b', 'manifest_commit', '%s: %s' % (type(e).__name__, e))
        if not (isinstance(got, dict) and isinstance(got.get('commit'), str) and got['commit'] and got.get('manifest_sha256') == digest):
            raise Stop('G0b', 'manifest_commit', 'the commit hook did not confirm a commit holding the manifest (got %r, manifest %s)' % (got, digest))
        self.state['g0b_commit'] = got['commit']
        self.save()

    def locator(self, path):
        return 'remote:%s/%s/%s:%s' % (self.ns, self.reg['exec']['deployment'], self.container, path)

    # ---------------------------------------------------------------------------------------------------------- G1
    def g1(self):
        self.phase = 'G1'
        self.state['phases'].append({'phase': 'G1', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            self.current = t['key']
            self.check_pod('G1', t['key'])
            b = RE.Binding(host=self.host, max_operations=2, root=self.mount)
            receipt, out = self.op('G1', b, 'stat', st['path'], bind_identity=False, target=t['key'])
            start = receipt['identity']['start']
            if receipt['exit_code'] != 0 or start is None or start != st['listed'] or start['size'] != t['bytes']:
                st.update(driver_outcome='dropped', reason='G1: the stat (exit %s, start identity %s) does not match the listing %s and the manifest bytes' % (
                    receipt['exit_code'], start, st['listed']))
                self.save()
                self.check_pod('G1', t['key'])
                continue
            try:
                fp = json.loads(out)
            except ValueError:
                fp = None
            errs = fingerprint_errors(fp)
            if not errs and (fp['size'], fp['mtime_ns']) != (start['size'], start['mtime_ns']):
                errs.append('the fingerprint %s disagrees with the receipt identity %s' % ({k: fp[k] for k in ('size', 'mtime_ns')}, start))
            if errs:
                raise Stop('G1', 'malformed_output', '; '.join(errs), t['key'])
            st['identity'] = dict(start, head_1m_sha256=fp['head_1m_sha256'], tail_1m_sha256=fp['tail_1m_sha256'])
            b.identity = dict(st['identity'])
            receipt, out = self.op('G1', b, 'probe', st['path'], ['--at', 0.0, '--stream', 0], target=t['key'])
            st['probe'] = self.probe_evidence(receipt, out)
            st['subtitle_stream'] = RE.select_subtitle_stream([dict(st['probe'], id='probe')])
            st['g1_operations'] = b.operations
            self.save()
            self.check_pod('G1', t['key'])
        self.current = None
        roles = self.reg['early_stop_roles']
        if not any(s.get('subtitle_stream') for k, s in self.state['targets'].items() if s['role'] in roles and s['driver_outcome'] != 'dropped'):
            self.state['early_stop'] = 'no target of role %s has a text subtitle stream: Stage R stops before G2 and no model call is made' % roles
            raise Stop('G1', 'early_stop', self.state['early_stop'])

    @staticmethod
    def probe_evidence(receipt, out):
        if receipt['exit_code'] == 'timeout':
            return {'tool': 'ffprobe', 'args': {}, 'status': 'timeout', 'output': 'ffprobe timed out inside the sampler'}
        if receipt['exit_code'] != 0:
            return {'tool': 'ffprobe', 'args': {}, 'status': 'error', 'output': json.dumps({'exit_code': receipt['exit_code'], 'stderr': (receipt.get('stderr') or '')[:1500]})}
        try:
            data = json.loads(out.decode())
            if not isinstance(data, dict):
                raise ValueError('not an object')
            return {'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(T._condense(data), sort_keys=True, ensure_ascii=False)}
        except ValueError:
            return {'tool': 'ffprobe', 'args': {}, 'status': 'error', 'output': 'ffprobe returned no JSON object'}

    # ---------------------------------------------------------------------------------------------------------- G2 and the final check
    def fill(self, t, with_probe=True):
        st = self.state['targets'][t['key']]
        case = copy.deepcopy(self.templates[t['key']])
        fx = {'kind': 'remote', 'locator': self.locator(st['path']), 'exec_target': self.target, 'max_operations': self.g2_ops, 'allowed_root': self.mount}
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
        path = self.state['targets'][t['key']]['path']
        evidence = R.resolve_evidence_raw(case, str(self.out), lambda text: leakguard.redact(text, case, [path]))
        view = json.dumps(P.case_view(case, evidence), ensure_ascii=False, sort_keys=True)
        hits = leakguard.find_leaks(case, view, [path])
        if hits:
            raise Stop(phase, 'leak_guard', 'the filled case of target %s carries forbidden token kinds %s' % (t['key'], sorted(hits)), t['key'])

    def g2(self):
        self.phase = 'G2'
        self.state['phases'].append({'phase': 'G2', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            self.current = t['key']
            self.need_time('G2', self.target_wall + 2 * RE.OUTER_DEADLINE_S, t['key'])
            remaining = self.total_cost - self.cost
            if not remaining > 0:
                raise Stop('G2', 'cost_cap', 'the $%.2f Stage R cost cap is used ($%.4f spent)' % (self.total_cost, self.cost), t['key'])
            self.check_pod('G2', t['key'])
            case = self.fill(t)
            stream = RE.select_subtitle_stream(case['evidence'])
            want = st.get('subtitle_stream')
            if (stream or {}).get('index') != (want or {}).get('index') or (stream or {}).get('codec') != (want or {}).get('codec'):
                raise Stop('G2', 'stream_mismatch', 'the filled case would select subtitle stream %s, the G1 probe names %s' % (stream, want), t['key'])
            self.leak_check('G2', t, case)
            base = self.path_under_out('g2', t['key'])
            suite = base / 'suite'
            (suite / 'cases').mkdir(parents=True, exist_ok=True)
            self.path_under_out('g2', t['key'], 'suite', 'cases', case['id'] + '.json').write_text(json.dumps(case, indent=2, sort_keys=True, ensure_ascii=False) + '\n')
            run_dir = base / 'run'
            argv = list(self.reg.get('harness_args') or []) + ['--suite', str(suite), '--cases', case['id'], '--out', str(run_dir),
                                                               '--scratch', str(base / 'scratch'), '--evidence', 'replay',
                                                               '--tools-behavior', RE.VERSION, '--stop-on-receipt-failure',
                                                               '--max-wall-s', '%g' % self.target_wall, '--max-total-cost-usd', '%g' % remaining]
            st.update(driver_outcome='started', g2={'argv': argv, 'run_dir': str(run_dir)})
            self.save()
            try:
                rc = self.harness(argv)
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else 2
            manifest = self.read_json(run_dir / 'manifest.json') or {}
            spent = (manifest.get('limits_state') or {}).get('cost_usd')
            if isinstance(spent, (int, float)) and not isinstance(spent, bool) and math.isfinite(spent) and spent >= 0:
                self.cost += float(spent)
            elif manifest:
                self.cost = self.total_cost          # an unmetered run: nothing remains (fail closed)
            record = self.read_json(run_dir / (case['id'] + '.json'))
            partial = self.read_json(run_dir / 'started-aborted' / (case['id'] + '.json'))
            st['g2'].update(rc=rc, aborted=manifest.get('aborted'), record=str(run_dir / (case['id'] + '.json')) if record else None,
                            started_aborted=str(run_dir / 'started-aborted' / (case['id'] + '.json')) if partial else None)
            self.copy_receipts(t['key'], record or partial)
            if partial is not None or not isinstance(record, dict) or rc != 0 or manifest.get('aborted'):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the harness run did not record the case normally (rc %s, aborted %r)' % (rc, manifest.get('aborted')), t['key'])
            remote = record.get('remote_evidence') if isinstance(record.get('remote_evidence'), dict) else {}
            if remote.get('fatal'):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the record holds a fatal operation: %s' % remote['fatal'], t['key'])
            ops = remote.get('operations', 0)
            if not _int(ops) or ops > self.g2_ops or remote.get('hostname') not in (None, self.host.hostname):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'binding', 'the run reports %r operations on host %r' % (ops, remote.get('hostname')), t['key'])
            st['driver_outcome'] = 'recorded'
            safety = SR.proposal_safety(t['role'], record)
            st['write_attempts'] = safety['attempts']
            self.final_check(t)
            if safety['write_control']:
                raise Stop('G2', 'write_control', 'a write attempt on a non-offender target (%s)' % [a['action'] for a in safety['attempts']], t['key'])
            self.check_pod('G2', t['key'])
            self.save()
        self.current = None

    def final_check(self, t):
        st = self.state['targets'][t['key']]
        b = RE.Binding(identity=st['identity'], host=self.host, max_operations=1, root=self.mount)
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
        errs = fingerprint_errors(fp)
        if errs:
            st.update(driver_outcome='stopped', reason='final: %s' % '; '.join(errs))
            raise Stop('final', 'malformed_output', st['reason'], t['key'])
        now = dict(receipt['identity']['end'], head_1m_sha256=fp['head_1m_sha256'], tail_1m_sha256=fp['tail_1m_sha256'])
        st['final'] = now
        if now != st['identity'] or (fp['size'], fp['mtime_ns']) != (st['identity']['size'], st['identity']['mtime_ns']):
            st.update(driver_outcome='invalid', reason='final: the fingerprint %s differs from G1 %s' % (now, st['identity']))
            raise Stop('final', 'final_mismatch', st['reason'], t['key'])

    def copy_receipts(self, key, rec):
        rem = (rec or {}).get('remote_evidence') if isinstance(rec, dict) else None
        for r in (rem or {}).get('receipts') or []:
            self.state['operations'].append(dict(r, phase='G2', target=key))

    @staticmethod
    def read_json(p):
        try:
            return json.loads(Path(p).read_text())
        except (OSError, ValueError):
            return None

    # ---------------------------------------------------------------------------------------------------------- the whole run
    def _stopped(self, phase, kind, detail, target):
        self.state['stop'] = {'phase': phase, 'kind': kind, 'detail': detail, 'target': target}
        for key, st in self.state['targets'].items():
            if st['driver_outcome'] == 'started' or (key == target and st['driver_outcome'] == 'recorded' and kind != 'write_control'):
                st['driver_outcome'] = 'stopped'        # the target the stop cut short, or whose recorded result the stop no longer vouches for
            if st['driver_outcome'] in ('stopped', 'not_started'):
                st['reason'] = st['reason'] or '%s: %s %s' % ('stopped' if st['driver_outcome'] == 'stopped' else 'never started after the stop', phase, kind)

    def run(self):
        code = EXIT_STOP
        try:
            self.out.mkdir(parents=True, exist_ok=True)
            self.started = self.clock()
            self.state['started_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.save()
            self.g0b()
            self.g1()
            self.g2()
            code = EXIT_OK
        except Stop as e:
            self._stopped(e.phase, e.kind, e.detail, e.target)
            code = EXIT_EARLY if e.kind == 'early_stop' else EXIT_STOP
        except Exception as e:  # noqa: BLE001 - every unexpected error is a recorded stop, never a crash without a terminal state
            self._stopped(self.phase, 'driver_error', '%s: %s' % (type(e).__name__, str(e)[:300]), self.current)
            code = EXIT_STOP
        finally:
            self.state['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.state['exit_code'] = code
            try:
                self.save()
            except Exception:  # noqa: BLE001 - the out directory itself is unusable: nothing more can be recorded
                pass
        return code


def git_committer(repo):
    """Commit the manifest in `repo` and confirm the commit holds exactly its bytes -> {commit, manifest_sha256}."""
    def commit(path):
        rel = str(Path(path).resolve().relative_to(Path(repo).resolve()))
        subprocess.run(['git', '-C', str(repo), 'add', '--', rel], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'stage-r: G0b manifest (%s)' % rel, '--', rel], check=True, capture_output=True)
        sha = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        held = subprocess.run(['git', '-C', str(repo), 'show', '%s:%s' % (sha, rel)], check=True, capture_output=True).stdout
        return {'commit': sha, 'manifest_sha256': hashlib.sha256(held).hexdigest()}
    return commit


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--registration', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--commit-repo', required=True, help='the git checkout the G0b manifest is committed in before any media read (--out must be under it)')
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
    d = Driver(reg, out, commit=git_committer(args.commit_repo), template_dir=Path(args.registration).resolve().parent)
    code = d.run()
    if d.state['stop']:
        print('STOP: %(phase)s %(kind)s: %(detail)s' % d.state['stop'], file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
