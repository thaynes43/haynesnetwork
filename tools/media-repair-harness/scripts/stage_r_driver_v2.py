#!/usr/bin/env python3
"""Stage R driver `stage-r-driver-3` with registration `stage-r-2` (OpenProject #165; pilot plan v3.3).  Opt-in: the #161 driver (`stage_r_driver.py`,
`stage-r-driver-2`, registration `stage-r-1`) is unchanged, byte for byte, and this one reuses its operations, listings, pod checks, leak guard, final
check and stop bookkeeping.  It closes the five gaps the G0a pre-registration of Stage R pilot 1 found (#160):

  G-1  the library root.  `discovery.library_root` registers the library as path components below the selected mount (`["Media", "TV Shows"]`; each
       a safe component: no separator, traversal, NUL or control character).  G0b reads the mount from `get deploy` as before, builds
       `<mount>/<component>/...` and lists THAT directory directly with the series prefix: never the mount root or an intermediate folder.  Every
       listing stays descriptor-confined under the mount and must be complete with exactly one series match.  Four `list` calls in all, as before;
       a missing root is a recorded stop, as any failed listing is.
  G-2  the model tripwire.  After each G2 target the driver reads the #159 call journal (`calls.log` and the reply copies in the directory the
       registered path rule names, `$MRH_CALL_JOURNAL`): every call of that target must be paired (start and stdout-closed), match the record's turns
       one for one, report exactly the registered served model, and stay within the registered characters-per-token tripwire.  A violation, or a
       journal that cannot be read, is the recorded stop `model_tripwire`; no further target starts.
  G-3  coordinator loss.  Before each target the driver checks that its parent process is still the one that started it (os.getppid() unchanged and
       not 1); otherwise the recorded stop `coordinator_lost`.  In V2 a lost session pod kills the driver with it (every process of the pod dies);
       this check covers an ORPHANED driver, whose parent died while the pod lives on (it is re-parented, so its parent id changes).
  G-4  pre-run binding.  At start, before any operation: the harness commit (git HEAD of the tree this script runs from, with src/ and scripts/
       clean), the sampler sha256, the case-template digests and the config-hash basis (the harness config with its one per-target field,
       `limits.max_total_cost_usd`, excluded) must equal the registration; after each G2 run, the recorded config must differ from the registered
       basis in exactly that field, set to the remainder the driver passed.  Any mismatch is the recorded stop `binding_mismatch`.
  G-5  the A0 expiry.  `--approved-at <ISO-8601 UTC>` (Tom's approval) is required; the driver refuses to start once now is past approved-at plus the
       registered expiry (at most 8 h), and stops before any new target once it passes (`approval_expired`).

Usage: stage_r_driver_v2.py --registration G0A.json --out DIR --commit-repo DIR --approved-at 2026-10-22T09:00:00Z
Exit: 0 every phase ran, 3 a stop (a pre-run refusal included: it is recorded, with no operation started), 4 the registered early stop, 2 a bad
registration or command line.
"""
import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent


def _driver_v1():
    """The #161 driver module (stage_r_driver.py), loaded once; this driver subclasses it and never changes it."""
    mod = sys.modules.get('stage_r_driver_v1')
    if mod is None:
        spec = importlib.util.spec_from_file_location('stage_r_driver_v1', HERE / 'stage_r_driver.py')
        mod = importlib.util.module_from_spec(spec)
        sys.modules['stage_r_driver_v1'] = mod
        spec.loader.exec_module(mod)
    return mod


D1 = _driver_v1()
RE, R, SR = D1.RE, D1.R, D1.SR
Stop, EXIT_OK, EXIT_BAD, EXIT_STOP, EXIT_EARLY = D1.Stop, D1.EXIT_OK, D1.EXIT_BAD, D1.EXIT_STOP, D1.EXIT_EARLY

DRIVER_VERSION = 'stage-r-driver-3'
REGISTRATION_VERSION = 'stage-r-2'
APPROVAL_MAX_S = 8 * 3600                 # pilot plan section 6: A0 expires at most 8 hours after Tom's approval
APPROVAL_FUTURE_SKEW_S = 300              # an approval stamped more than this in the future is refused (a wrong clock or a wrong stamp)
JOURNAL_ENV = 'MRH_CALL_JOURNAL'          # the one journal path rule: the directory the #159 shim journals into
JOURNAL_SETTLE_S = 5.0                    # the shim writes `stdout-closed` after its tee ends: a closed call is awaited this long before it is unreadable
CHARS_BASES = ('sent', 'system_prompt')   # the tripwire's characters: everything the call sent (system prompt plus message), or the system prompt alone
EXCLUDED_CONFIG_FIELD = 'limits.max_total_cost_usd'
LIBRARY_ROOT_MAX = 8
HEX40 = re.compile(r'^[0-9a-f]{40}$')
HEX64 = D1.HEX64
JOURNAL_START = re.compile(r'^(\S+) start ([0-9A-Za-z._-]{1,80}) kind=(call|version) nargs=(\d+)$')
JOURNAL_CLOSED = re.compile(r'^(\S+) stdout-closed ([0-9A-Za-z._-]{1,80})$')


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def harness_argv(reg, case, suite, out, scratch, remaining, target_wall):
    """The argv one G2 harness run gets (the #161 driver's, unchanged): the registered harness arguments plus the flags the driver owns."""
    return list(reg.get('harness_args') or []) + ['--suite', str(suite), '--cases', case, '--out', str(out), '--scratch', str(scratch), '--evidence', 'replay',
                                                  '--tools-behavior', RE.VERSION, '--stop-on-receipt-failure', '--max-wall-s', '%g' % target_wall,
                                                  '--max-total-cost-usd', '%g' % remaining]


def config_of(argv):
    """The harness config (and so its config hash) one argv gives, rebuilt with the runner's own parser and run_config, as the harness records it."""
    args = R.build_parser().parse_args(argv)
    adapter = R.build_adapter(args)
    try:
        return R.run_config(args, adapter, {}, None)
    finally:
        adapter.finish()


def config_hash(config):
    return R.sha256_bytes(R.canonical(config).encode())


def config_basis(config):
    """-> (the sha256 of the config with `limits.max_total_cost_usd` excluded, that field's value).  Raises ValueError when the field is absent."""
    c = copy.deepcopy(config)
    lim = c.get('limits') if isinstance(c, dict) else None
    if not isinstance(lim, dict) or 'max_total_cost_usd' not in lim:
        raise ValueError('the config has no %s' % EXCLUDED_CONFIG_FIELD)
    value = lim.pop('max_total_cost_usd')
    return config_hash(c), value


def parse_utc(text):
    """An ISO-8601 UTC timestamp (`...Z` or `+00:00`) -> an aware datetime; anything else -> ValueError."""
    if not isinstance(text, str) or not text:
        raise ValueError('no timestamp')
    t = datetime.datetime.fromisoformat(text.replace('Z', '+00:00') if text.endswith('Z') else text)
    if t.tzinfo is None or t.utcoffset() != datetime.timedelta(0):
        raise ValueError('%r is not a UTC timestamp' % text)
    return t


def validate_registration(reg, template_dir=None):
    """-> (errors, templates).  Every stage-r-1 rule (the #161 validator, run on the same registration), plus the stage-r-2 fields."""
    if not isinstance(reg, dict):
        return ['the registration is not a JSON object'], {}
    errs, templates = D1.validate_registration(dict(reg, registration=D1.REGISTRATION_VERSION), template_dir)
    if reg.get('registration') != REGISTRATION_VERSION:
        errs.insert(0, 'registration must be %r' % REGISTRATION_VERSION)
    disc = reg.get('discovery') or {}
    root = disc.get('library_root')
    if not (isinstance(root, list) and len(root) <= LIBRARY_ROOT_MAX and all(isinstance(c, str) and D1.safe_name(c) for c in root)):
        errs.append('discovery.library_root must be a list of at most %d safe path components below the mount (no separator, traversal, NUL or control '
                    'character)' % LIBRARY_ROOT_MAX)
    mj = reg.get('model_journal')
    if not isinstance(mj, dict):
        errs.append('model_journal is required (the #159 call journal and tripwire)')
        mj = {}
    if mj.get('path_rule') != {'env': JOURNAL_ENV}:
        errs.append('model_journal.path_rule must be {"env": "%s"} (the directory the call-journal shim writes)' % JOURNAL_ENV)
    tw = mj.get('tripwire') if isinstance(mj.get('tripwire'), dict) else {}
    if set(tw) != {'chars_basis', 'divisor', 'slack_tokens'} or tw.get('chars_basis') not in CHARS_BASES \
            or not (_num(tw.get('divisor')) and tw['divisor'] > 0) or not (_num(tw.get('slack_tokens')) and tw['slack_tokens'] >= 0):
        errs.append('model_journal.tripwire must be {chars_basis: %s, divisor: > 0, slack_tokens: >= 0} (the limit is chars / divisor + slack_tokens)'
                    % ' or '.join(CHARS_BASES))
    model = None
    try:
        model = R.build_parser().parse_args(harness_argv(reg, 'CASE', 'SUITE', 'OUT', 'SCRATCH', 1.0, 1.0)).model
    except SystemExit:
        errs.append('harness_args do not parse with the harness parser')
    if not (isinstance(mj.get('served_model'), str) and mj['served_model'] and mj['served_model'] == model):
        errs.append('model_journal.served_model must be the model the harness arguments request (%r)' % (model,))
    b = reg.get('binding')
    if not isinstance(b, dict):
        errs.append('binding is required (harness commit, sampler sha256, case template digests, config-hash basis)')
        b = {}
    if set(b) != {'harness_commit', 'sampler_sha256', 'case_templates_sha256', 'config_hash_basis_sha256', 'config_hash_excluded_field'}:
        errs.append('binding must hold exactly harness_commit, sampler_sha256, case_templates_sha256, config_hash_basis_sha256 and '
                    'config_hash_excluded_field')
    if not (isinstance(b.get('harness_commit'), str) and HEX40.match(b['harness_commit'])):
        errs.append('binding.harness_commit must be a full 40-character commit id')
    for k in ('sampler_sha256', 'config_hash_basis_sha256'):
        if not (isinstance(b.get(k), str) and HEX64.match(b[k])):
            errs.append('binding.%s must be sha256 hex' % k)
    if b.get('config_hash_excluded_field') != EXCLUDED_CONFIG_FIELD:
        errs.append('binding.config_hash_excluded_field must be %r (the one per-target config field)' % EXCLUDED_CONFIG_FIELD)
    digests = b.get('case_templates_sha256')
    keys = [t.get('key') for t in reg.get('targets') or [] if isinstance(t, dict)]
    if not (isinstance(digests, dict) and sorted(digests) == sorted(keys)
            and all(isinstance(v, str) and (v == 'inline' or HEX64.match(v)) for v in digests.values())):
        errs.append('binding.case_templates_sha256 must give every target key its template sha256 (or "inline")')
    ap = reg.get('approval')
    if not (isinstance(ap, dict) and set(ap) == {'expiry_s'} and _num(ap.get('expiry_s')) and 0 < ap['expiry_s'] <= APPROVAL_MAX_S):
        errs.append('approval must be {expiry_s: a number above 0 and at most %d} (pilot plan section 6: A0 expires at most 8 hours after approval)'
                    % APPROVAL_MAX_S)
    return errs, templates


def load_registration(path):
    reg = json.loads(Path(path).read_text())
    errs, _templates = validate_registration(reg, Path(path).resolve().parent)
    if errs:
        raise ValueError('; '.join(errs))
    return reg


def _chars_sent(turn, basis):
    """The characters one recorded call sent (`sent`: system prompt plus the rendered message; `system_prompt`: the system prompt), or None when the
    record keeps no request for it.  Both request shapes are read: the claude adapter's (system_prompt, prompt) and the scripted adapter's."""
    req = turn.get('raw_request') if isinstance(turn, dict) else None
    if not isinstance(req, dict):
        return None
    if isinstance(req.get('system_prompt'), str) and isinstance(req.get('prompt'), str):
        system, message = req['system_prompt'], req['prompt']
    elif isinstance(req.get('system'), str) and isinstance(req.get('messages'), list):
        system, message = req['system'], R.A.render_transcript(req['messages'])
    else:
        return None
    return len(system) if basis == 'system_prompt' else len(system) + len(message)


class Driver(D1.Driver):
    """stage-r-driver-3.  Every phase of the #161 driver, with G0b's library root, the pre-run binding and approval, and the per-target coordinator,
    approval and model-journal checks."""

    def __init__(self, registration, out, runner=subprocess.run, harness=None, clock=time.monotonic, commit=None, pod_health=True, template_dir=None,
                 approved_at=None, now=None, getppid=os.getppid, git=subprocess.run, environ=None, sleep=time.sleep):
        errs, _t = validate_registration(registration, template_dir)
        if errs:
            raise ValueError('; '.join(errs))
        super().__init__(dict(registration, registration=D1.REGISTRATION_VERSION), out, runner=runner, harness=harness, clock=clock, commit=commit,
                         pod_health=pod_health, template_dir=template_dir)
        self.reg = registration
        self.template_dir = template_dir
        self.approved_at_text = approved_at
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.getppid, self.git, self.sleep = getppid, git, sleep
        self.environ = os.environ if environ is None else environ
        self.start_ppid = getppid()
        self.approval_deadline = None
        mj = registration['model_journal']
        self.served_model, self.tripwire = mj['served_model'], dict(mj['tripwire'])
        self.state.update(driver=DRIVER_VERSION, registration=REGISTRATION_VERSION, registration_sha256=D1.canonical_sha256(registration),
                          approval={'approved_at': approved_at, 'expiry_s': registration['approval']['expiry_s'], 'expires_at': None},
                          coordinator={'start_ppid': self.start_ppid, 'checks': 0},
                          model_journal={'path_rule': dict(mj['path_rule']), 'served_model': self.served_model, 'tripwire': self.tripwire,
                                         'directory': None},
                          binding={'registered': copy.deepcopy(registration['binding']), 'checked': None})

    # ---------------------------------------------------------------------------------------------------------- the whole run
    def run(self):
        code = EXIT_STOP
        try:
            self.out.mkdir(parents=True, exist_ok=True)
            self.started = self.clock()
            self.state['started_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.save()
            self.prerun()
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

    # ---------------------------------------------------------------------------------------------------------- P0: before any operation
    def prerun(self):
        """Phase P0, before any operation (the first `get deploy` consumes the approvals): the approval window, the coordinator, the journal rule and the
        binding.  Each failure is a recorded stop; nothing has run."""
        self.phase = 'P0'
        self.state['phases'].append({'phase': 'P0', 'at': self.elapsed()})
        self.check_approval('P0')
        self.check_coordinator('P0')
        jdir = self.environ.get(JOURNAL_ENV)
        if not (isinstance(jdir, str) and jdir.startswith('/') and os.path.normpath(jdir) == jdir and '\n' not in jdir):
            raise Stop('P0', 'model_tripwire', 'the journal path rule {"env": "%s"} gives no absolute directory (%r): the tripwire cannot be applied'
                       % (JOURNAL_ENV, jdir))
        self.journal = Path(jdir)
        self.state['model_journal']['directory'] = jdir
        self.state['binding']['checked'] = got = self.binding_now()
        bad = sorted(k for k, v in got.items() if k != 'tree_clean' and v != self.reg['binding'][k]) + ([] if got['tree_clean'] is True else ['tree_clean'])
        self.save()
        if bad:
            raise Stop('P0', 'binding_mismatch', 'the registration binds %s, the driver found %s' % (
                {k: self.reg['binding'].get(k, True) for k in bad}, {k: got[k] for k in bad}))

    def binding_now(self):
        """What the registration binds, read from the tree this driver runs from."""
        out = {'config_hash_excluded_field': EXCLUDED_CONFIG_FIELD}
        try:
            head = self.git(['git', '-C', str(COMPONENT), 'rev-parse', 'HEAD'], capture_output=True, text=True)
            status = self.git(['git', '-C', str(COMPONENT), 'status', '--porcelain', '--', 'src', 'scripts'], capture_output=True, text=True)
            out['harness_commit'] = head.stdout.strip() if head.returncode == 0 else None
            out['tree_clean'] = status.returncode == 0 and status.stdout.strip() == ''
        except Exception as e:  # noqa: BLE001 - a commit that cannot be read is not the registered one
            out['harness_commit'], out['tree_clean'] = 'unreadable (%s)' % type(e).__name__, False
        out['sampler_sha256'] = RE.sampler_sha256()
        out['case_templates_sha256'] = D1.template_digests(self.reg, self.template_dir)
        try:
            argv = harness_argv(self.reg, 'CASE', 'SUITE', 'OUT', 'SCRATCH', self.total_cost - self.cost, self.target_wall)
            out['config_hash_basis_sha256'] = config_basis(config_of(argv))[0]
        except (Exception, SystemExit) as e:  # noqa: BLE001 - a config that cannot be rebuilt is not the registered one
            out['config_hash_basis_sha256'] = 'unbuildable (%s: %s)' % (type(e).__name__, str(e)[:120])
        return out

    # ---------------------------------------------------------------------------------------------------------- before each target
    def check_approval(self, phase, target=None):
        ap = self.state['approval']
        try:
            at = parse_utc(self.approved_at_text)
        except (TypeError, ValueError) as e:
            kind = 'approval_missing' if not self.approved_at_text else 'approval_invalid'
            raise Stop(phase, kind, 'stage-r-driver-3 needs --approved-at, the ISO-8601 UTC time of the A0 approval (%s)' % e, target)
        deadline = at + datetime.timedelta(seconds=float(ap['expiry_s']))
        ap['expires_at'] = deadline.isoformat()
        now = self.now()
        ap['last_checked'] = now.isoformat()
        if at > now + datetime.timedelta(seconds=APPROVAL_FUTURE_SKEW_S):
            raise Stop(phase, 'approval_invalid', 'the approval time %s is in the future (now %s)' % (at.isoformat(), now.isoformat()), target)
        if now > deadline:
            raise Stop(phase, 'approval_expired', 'A0 expired at %s (approved %s, expiry %s s); now %s' % (
                deadline.isoformat(), at.isoformat(), ap['expiry_s'], now.isoformat()), target)

    def check_coordinator(self, phase, target=None):
        ppid = self.getppid()
        self.state['coordinator']['checks'] += 1
        self.state['coordinator']['last_ppid'] = ppid
        if ppid == 1 or ppid != self.start_ppid:
            raise Stop(phase, 'coordinator_lost', 'the parent process is %s, not the %s that started the driver: the coordinator session is gone'
                       % (ppid, self.start_ppid), target)

    def before_target(self, phase, key):
        self.check_coordinator(phase, key)
        self.check_approval(phase, key)

    # ---------------------------------------------------------------------------------------------------------- G0b: the registered library root
    def library_root(self, mount):
        return (mount.rstrip('/') + ''.join('/' + c for c in self.reg['discovery']['library_root'])) or '/'

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
        mount = mounts[0]['mountPath']
        if mount != '/' and mount.endswith('/'):
            mount = mount.rstrip('/')
        if not (mount.startswith('/') and os.path.normpath(mount) == mount and '\n' not in mount and '\0' not in mount):
            raise Stop('G0b', 'mount_selection', 'the mount path %r is not an absolute normalised path' % mount)
        self.mount = self.state['mount'] = mount
        self.dir_binding = RE.Binding(host=self.host, root=mount)          # every listing stays confined under the MOUNT
        root = self.state['library_root'] = self.library_root(mount)
        if self.pod_health:
            self.state['pod'] = self.pod_reading('G0b')
        try:
            # the registered library root is listed DIRECTLY (never the mount root or an intermediate folder): list call 1 of 4
            series = [e for e in self.listing('G0b', root, disc['series_prefix']) if e['type'] == 'dir']
        except Stop as e:
            raise Stop('G0b', e.kind, 'the registered library root %s: %s' % (root, e.detail))
        if self.pod_health and self.state['pod']['name'] != self.host.hostname:
            raise Stop('G0b', 'pod_health', 'the pod name %r is not the hostname %r the first receipt binds' % (self.state['pod']['name'], self.host.hostname))
        if len(series) != 1:
            raise Stop('G0b', 'discovery', '%d directories under the library root %s match the series prefix, not exactly one' % (len(series), root))
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
        path.write_text(json.dumps({'hostname': self.host.hostname, 'mount': mount, 'library_root': root, 'targets': manifest}, indent=2, sort_keys=True,
                                   ensure_ascii=False) + '\n')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.state['g0b_manifest_sha256'] = digest
        for t in self.reg['targets']:
            if self.state['targets'][t['key']]['driver_outcome'] != 'dropped':
                self.leak_check('G0b', t, self.fill(t, with_probe=False))
        self.save()
        try:
            got = self.commit(path)
        except Exception as e:  # noqa: BLE001 - a manifest that is not committed must not be followed by a media read
            raise Stop('G0b', 'manifest_commit', '%s: %s' % (type(e).__name__, e))
        if not (isinstance(got, dict) and isinstance(got.get('commit'), str) and got['commit'] and got.get('manifest_sha256') == digest):
            raise Stop('G0b', 'manifest_commit', 'the commit hook did not confirm a commit holding the manifest (got %r, manifest %s)' % (got, digest))
        self.state['g0b_commit'] = got['commit']
        self.save()

    # ---------------------------------------------------------------------------------------------------------- G1 (the #161 phase, with the before-target checks)
    def g1(self):
        self.phase = 'G1'
        self.state['phases'].append({'phase': 'G1', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            self.current = t['key']
            self.before_target('G1', t['key'])
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
            errs = D1.fingerprint_errors(fp)
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

    # ---------------------------------------------------------------------------------------------------------- G2 (the #161 phase, with the journal and binding checks)
    def g2(self):
        self.phase = 'G2'
        self.state['phases'].append({'phase': 'G2', 'at': self.elapsed()})
        for t in self.reg['targets']:
            st = self.state['targets'][t['key']]
            if st['driver_outcome'] == 'dropped':
                continue
            self.current = t['key']
            self.before_target('G2', t['key'])
            self.need_time('G2', self.target_wall + 2 * RE.OUTER_DEADLINE_S + JOURNAL_SETTLE_S, t['key'])
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
            argv = harness_argv(self.reg, case['id'], suite, run_dir, base / 'scratch', remaining, self.target_wall)
            offset = self.journal_offset()
            if offset is None:
                raise Stop('G2', 'model_tripwire', 'the call journal cannot be read before the target starts: its calls could not be told apart', t['key'])
            st.update(driver_outcome='started', g2={'argv': argv, 'run_dir': str(run_dir), 'journal_offset': offset})
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
            # G-2: the call journal of this target, read before any other verdict on it
            journal = st['model_journal'] = self.journal_check(offset, record if isinstance(record, dict) else partial)
            self.save()
            if journal['violations']:
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'model_tripwire', 'the call journal shows %s' % '; '.join(journal['violations'])[:600], t['key'])
            if partial is not None or not isinstance(record, dict) or rc != 0 or manifest.get('aborted'):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the harness run did not record the case normally (rc %s, aborted %r)' % (rc, manifest.get('aborted')), t['key'])
            if journal['unreadable']:
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'model_tripwire', 'the call journal cannot be read for this target: %s' % '; '.join(journal['unreadable'])[:600], t['key'])
            # G-4: the recorded config differs from the registered basis in exactly the remaining-cap field
            drift = self.config_drift(manifest, remaining)
            st['binding'] = {'config_hash': manifest.get('config_hash'), 'max_total_cost_usd': ((manifest.get('config') or {}).get('limits') or {}).get('max_total_cost_usd'),
                             'drift': drift}
            if drift:
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'binding_mismatch', 'the harness run is not the registered one: %s' % '; '.join(drift), t['key'])
            if (record.get('error') or {}).get('kind') == 'harness_crash':
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_crash', 'the case record is a harness crash: %s' % str((record.get('error') or {}).get('message'))[:300], t['key'])
            if not isinstance(record.get('remote_evidence'), dict):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the case record has no remote_evidence field', t['key'])
            remote = record['remote_evidence']
            if remote.get('fatal'):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'harness_stop', 'the record holds a fatal operation: %s' % remote['fatal'], t['key'])
            ops = remote.get('operations', 0)
            if not D1._int(ops) or ops > self.g2_ops or remote.get('hostname') not in (None, self.host.hostname):
                st['driver_outcome'] = 'stopped'
                raise Stop('G2', 'binding', 'the run reports %r operations on host %r' % (ops, remote.get('hostname')), t['key'])
            st['driver_outcome'] = 'recorded'
            safety = SR.proposal_safety(t['role'], record)
            st['write_attempts'] = safety['attempts']
            if safety['write_control']:
                st.update(driver_outcome='stopped', reason='WRITE-CONTROL: a write attempt on a non-offender target; no final check was started')
                raise Stop('G2', 'write_control', 'a write attempt on a non-offender target (%s)' % [a['action'] for a in safety['attempts']], t['key'])
            if safety['unresolved']:
                st.update(driver_outcome='stopped', write_analysis_unresolved=safety['unresolved'],
                          reason='write analysis unresolved; no final check was started')
                raise Stop('G2', 'write_analysis_unresolved', 'the write analysis of %s could not be completed: %s'
                           % (['turn %s' % u.get('turn') for u in safety['unresolved']], [u.get('reason') for u in safety['unresolved']][:3]), t['key'])
            self.final_check(t)
            self.check_pod('G2', t['key'])
            self.save()
        self.current = None

    def config_drift(self, manifest, remaining):
        """The ways a G2 run's recorded config differs from the registration other than its remaining-cap field ([] when it is the registered run)."""
        cfg = manifest.get('config')
        if not isinstance(cfg, dict):
            return ['the run manifest holds no config']
        out = []
        if manifest.get('config_hash') != config_hash(cfg):
            out.append('the recorded config_hash is not the hash of the recorded config')
        try:
            basis, cap = config_basis(cfg)
        except ValueError as e:
            return out + [str(e)]
        if basis != self.reg['binding']['config_hash_basis_sha256']:
            out.append('the config basis %s is not the registered %s' % (basis, self.reg['binding']['config_hash_basis_sha256']))
        if not (_num(cap) and cap == float('%g' % remaining)):
            out.append('%s is %r, not the remainder %g the driver passed' % (EXCLUDED_CONFIG_FIELD, cap, remaining))
        sha = (manifest.get('harness_git') or {}).get('sha')
        if sha != self.reg['binding']['harness_commit']:
            out.append('the harness ran at commit %r, not the registered %s' % (sha, self.reg['binding']['harness_commit']))
        return out

    # ---------------------------------------------------------------------------------------------------------- G-2: the #159 call journal
    def journal_offset(self):
        try:
            return (self.journal / 'calls.log').stat().st_size
        except FileNotFoundError:
            return 0
        except OSError:
            return None

    def journal_lines(self, offset):
        """-> (lines appended since `offset`, problem or None)."""
        if offset is None:
            return [], 'calls.log could not be read before the target'
        try:
            with open(self.journal / 'calls.log', 'rb') as f:
                f.seek(offset)
                data = f.read()
        except FileNotFoundError:
            return [], None
        except OSError as e:
            return [], 'calls.log cannot be read (%s)' % type(e).__name__
        try:
            return data.decode('utf-8').splitlines(), None
        except UnicodeDecodeError:
            return [], 'calls.log is not UTF-8'

    def journal_check(self, offset, record):
        """The calls one G2 target made, from the journal, checked against its record and the registered tripwire -> {calls, violations, unreadable}."""
        turns = list((record or {}).get('turns') or []) if isinstance(record, dict) else None
        for attempt in range(int(JOURNAL_SETTLE_S / 0.1) + 1):      # bounded polls (never the run clock: a test clock may stand still)
            lines, problem = self.journal_lines(offset)
            starts, closed, malformed = [], set(), []
            for ln in lines:
                m, c = JOURNAL_START.match(ln), JOURNAL_CLOSED.match(ln)
                if m:
                    starts.append((m.group(2), m.group(3)))
                elif c:
                    closed.add(c.group(2))
                else:
                    malformed.append(ln[:80])
            calls = [i for i, kind in starts if kind == 'call']
            settled = all(i in closed for i, _k in starts) and (turns is None or len(calls) >= len(turns))
            if problem or settled or attempt == int(JOURNAL_SETTLE_S / 0.1):
                break
            self.sleep(0.1)
        out = {'calls': [], 'violations': [], 'unreadable': []}
        if problem:
            out['unreadable'].append(problem)
            return out
        if malformed:
            out['unreadable'].append('calls.log holds lines that are no journal record: %s' % malformed[:3])
        for i, _k in starts:
            if i not in closed:
                out['unreadable'].append('call %s has no stdout-closed record' % i)
        if turns is None:
            out['unreadable'].append('the target left no record to pair the journal with')
            turns = []
        if len(calls) != len(turns):
            out['unreadable'].append('the journal shows %d calls, the record %d model turns' % (len(calls), len(turns)))
        tw = self.tripwire
        for n, (cid, turn) in enumerate(zip(calls, turns), start=1):
            item = {'call': cid, 'turn': turn.get('n', n)}
            try:
                reply = json.loads((self.journal / ('out-%s.json' % cid)).read_text(encoding='utf-8'))
            except (OSError, ValueError, UnicodeDecodeError) as e:
                out['unreadable'].append('the reply copy of call %s cannot be read (%s)' % (cid, type(e).__name__))
                out['calls'].append(dict(item, verdict='unreadable'))
                continue
            if not isinstance(reply, dict):
                out['unreadable'].append('the reply copy of call %s is not a JSON object' % cid)
                out['calls'].append(dict(item, verdict='unreadable'))
                continue
            ok = not reply.get('is_error') and reply.get('subtype', 'success') == 'success'
            served = sorted((reply.get('modelUsage') or {}).keys()) if isinstance(reply.get('modelUsage') or {}, dict) else None
            usage = reply.get('usage') if isinstance(reply.get('usage'), dict) else {}
            parts = [usage.get(k) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')]
            tokens = sum(parts) if all(D1._int(p) and p >= 0 for p in parts) else None
            chars = _chars_sent(turn, tw['chars_basis'])
            item.update(served_models=served, tokens_in_total=tokens, chars=chars, ok=ok)
            if not ok:
                if isinstance(turn.get('raw_request'), dict):
                    out['unreadable'].append('call %s failed in the journal but the record holds its reply' % cid)
                item['verdict'] = 'unverified (a failed call)'
                out['calls'].append(item)
                continue
            if chars is None or tokens is None:
                out['unreadable'].append('call %s: %s' % (cid, 'the record keeps no request for it' if chars is None else 'its reply copy has no token usage'))
                item['verdict'] = 'unreadable'
                out['calls'].append(item)
                continue
            limit = chars / float(tw['divisor']) + float(tw['slack_tokens'])
            item.update(limit=round(limit, 1), chars_per_token=round(chars / tokens, 3) if tokens else None)
            bad = []
            if served != [self.served_model]:
                bad.append('call %s (turn %s) served %s, not exactly %r' % (cid, item['turn'], served, self.served_model))
            if tokens > limit:
                bad.append('call %s (turn %s) took %d input tokens for %d characters, over the tripwire limit %.1f' % (cid, item['turn'], tokens, chars, limit))
            item['verdict'] = 'violation' if bad else 'ok'
            out['violations'] += bad
            out['calls'].append(item)
        return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--registration', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--commit-repo', required=True, help='the git checkout the G0b manifest is committed in before any media read (--out must be under it)')
    ap.add_argument('--approved-at', required=True, help="Tom's A0 approval time, ISO-8601 UTC (2026-10-22T09:00:00Z); required: without it the driver refuses to start")
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
    d = Driver(reg, out, commit=D1.git_committer(args.commit_repo), template_dir=Path(args.registration).resolve().parent, approved_at=args.approved_at)
    code = d.run()
    if d.state['stop']:
        print('STOP: %(phase)s %(kind)s: %(detail)s' % d.state['stop'], file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
