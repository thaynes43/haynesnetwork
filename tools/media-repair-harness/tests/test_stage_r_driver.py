"""#161: the Stage R driver (scripts/stage_r_driver.py), offline.  The 'pod' is this machine running the REAL mrh-sampler-2 on a synthetic library
(rem_h.LocalPod); the model is a scripted adapter; the harness is run.main in-process.  Every driver stop is shown to start no further operation or target,
and to leave a terminal state.  All names, seasons, markers and sizes are synthetic."""
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import rem_h as H
import th
from media_repair_harness import run as R

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('stage_r_driver', HERE.parent / 'scripts' / 'stage_r_driver.py')
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)
spec2 = importlib.util.spec_from_file_location('stage_r_report', HERE.parent / 'scripts' / 'stage_r_report.py')
REP = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(REP)

PREFIX = 'Sample Series (2001)'
FILES = {'o1': ('Season 07', '%s - S07E19 - Alpha.mkv' % PREFIX, 21000), 'v1': ('Season 07', '%s - S07E04 - Beta.mkv' % PREFIX, 22000),
         'h1': ('Season 07', '%s - S07E11 - Gamma.mkv' % PREFIX, 23000), 'v2': ('Season 12', '%s - S12E02 - Delta.mkv' % PREFIX, 24000)}
ROLES = {'o1': 'offender', 'v1': 'verified', 'h1': 'held', 'v2': 'verified'}
HARNESS = ['--adapter', 'scripted', '--model', 'scripted-model', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3']
CUE = th.tool_call('subtitle_sample', {'at': 60})
ALL = tuple(FILES)
# exec numbering: G0b lists 1-4 (root, series, Season 07, Season 12), G1 stat+probe 5-12, then per G2 target its tool calls and the final stat
G1_END = 12


def fake_commit(path):
    return {'commit': 'c0ffee', 'manifest_sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}


class Library:
    def __init__(self, probes=None, extra_mount=False, pad=0, headers=None):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.tv = self.tmp / 'mnt' / 'tv'
        series = self.tv / PREFIX
        for key, (season, name, size) in FILES.items():
            H.media_file(series / season / name, probe=(probes or {}).get(key, H.PROBE), size=size, **(headers or {}).get(key, {}))
        (self.tv / 'Another Series').mkdir()
        for i in range(pad):
            (series / 'Season 12' / ('pad-%03d.nfo' % i)).write_bytes(b'')
        mounts = [{'name': 'tv', 'mountPath': str(self.tv)}, {'name': 'config', 'mountPath': '/config'}]
        if extra_mount:
            mounts.append({'name': 'tv2', 'mountPath': str(self.tmp / 'other' / 'tv')})
        self.deploy = {'spec': {'selector': {'matchLabels': {'app': 'sampler'}}, 'template': {'spec': {'containers': [{'name': 'app', 'volumeMounts': mounts}]}}}}
        self.pods = {'items': [self.pod()]}
        self.harness_calls = []

    def pod(self, restarts=0, ready='True', uid='uid-1', name=None):
        return {'metadata': {'name': name or H.hostname(), 'uid': uid}, 'status': {'containerStatuses': [{'name': 'app', 'restartCount': restarts}],
                                                                                   'conditions': [{'type': 'Ready', 'status': ready}]}}

    def path(self, key):
        season, name, _size = FILES[key]
        return self.tv / PREFIX / season / name

    def registration(self, keys=ALL):
        targets = []
        for k in keys:
            season, name, size = FILES[k]
            t = {'key': k, 'role': ROLES[k], 'file_id': 100 + len(targets), 'bytes': size, 'season': 's07' if season == 'Season 07' else 's12',
                 'case': th.make_case(id='sr-' + k, media='tv', fixture={'kind': 'none'}, tools_available=list(H.TOOLS))}
            if k == 'v1':
                t['marker'] = 'S07E04'
            else:
                t['basename'] = name
            targets.append(t)
        return {'registration': 'stage-r-1', 'exec': {'namespace': 'media', 'deployment': 'sampler', 'container': 'app'},
                'discovery': {'mount_path_regex': '.*/tv', 'series_prefix': PREFIX, 'season_dirs': {'s07': 'Season 0?7', 's12': 'Season 12'}},
                'targets': targets, 'harness_args': list(HARNESS), 'early_stop_roles': ['offender'],
                'limits': {'target_wall_s': 600, 'stage_wall_s': 7200, 'total_cost_usd': 10.0}}

    def harness(self, pod, replies=None, after=None):
        replies = replies or {}

        def run(argv):
            key = Path(argv[argv.index('--suite') + 1]).parent.name
            script = self.tmp / ('script-%s.json' % key)
            default = [CUE, H.dec(refs=['t1.f1'])] if ROLES.get(key) == 'offender' else [H.dec('healthy', 'none')]
            script.write_text(json.dumps(replies.get(key, default)))
            self.harness_calls.append(key)
            rc = R.main(argv + ['--script', str(script)], runner=pod)
            return after(argv, rc) if after else rc
        return run

    def drive(self, pod=None, reg=None, replies=None, after=None, **kw):
        pod = pod or H.LocalPod()
        if pod.deploy is None:
            pod.deploy = self.deploy
        if pod.pods is None:
            pod.pods = self.pods
        kw.setdefault('commit', fake_commit)
        d = D.Driver(reg or self.registration(), self.tmp / 'out', runner=pod, harness=self.harness(pod, replies, after), **kw)
        code = d.run()
        self.reg = reg or self.registration()
        return code, d.state, pod

    def report(self, state, verdicts=()):
        return REP.evaluate(state, {'verdicts': list(verdicts)}, self.reg)


def exec_modes(state):
    return [o.get('mode') for o in state['operations'] if o.get('mode')]


def edit_receipt(r, **over):
    rec = json.loads(r.stderr.decode().splitlines()[-1])
    rec.update(over)
    return H.Completed(r.returncode, r.stdout, json.dumps(rec).encode())


def edit_listing(r, fn):
    """Edit a listing body; an edit that adds an entry keeps the counts consistent everywhere (fn returns True), so only the entry itself is wrong."""
    data = json.loads(r.stdout)
    mirror = fn(data)
    out = json.dumps(data).encode()
    rec = json.loads(r.stderr.decode().splitlines()[-1])
    rec['stdout_bytes'] = len(out)
    if mirror:
        rec['listing'].update(matching=data['matching'], scanned=data['scanned'])
    return H.Completed(0, out, json.dumps(rec).encode())


ACCEPT = [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'accepted'}]


class HappyPath(unittest.TestCase):
    def test_all_phases_run_and_a_cue_reaches_the_model(self):
        lib = Library()
        code, st, pod = lib.drive()
        self.assertEqual(code, 0, st.get('stop'))
        self.assertEqual((st['stop'], st['exit_code'], st['g0b_commit']), (None, 0, 'c0ffee'))
        self.assertEqual({k: v['driver_outcome'] for k, v in st['targets'].items()}, {k: 'recorded' for k in FILES})
        modes = exec_modes(st)
        self.assertEqual(modes[:4], ['list'] * 4)                       # discovery completes before any media byte is read
        self.assertNotIn('list', modes[4:])
        self.assertEqual(st['targets']['v1']['basename_source'], 'discovered')
        self.assertEqual(st['targets']['o1']['basename_source'], 'recorded')
        self.assertEqual(st['hostname'], H.hostname())
        for k in FILES:
            ops = [o for o in st['operations'] if o.get('target') == k and o.get('mode')]
            self.assertLessEqual(len(ops), 9)
            self.assertEqual([o['mode'] for o in ops][:2], ['stat', 'probe'])
            self.assertEqual(ops[-1]['mode'], 'stat')
            self.assertEqual(st['targets'][k]['final'], st['targets'][k]['identity'])
            self.assertEqual(set(st['targets'][k]['identity']), {'size', 'mtime_ns', 'dev', 'ino', 'head_1m_sha256', 'tail_1m_sha256'})
        self.assertEqual(len([r for r in st['pod_readings'] if r['phase'] == 'G1']), 8)          # before and after each G1 target
        rec = json.loads(Path(st['targets']['o1']['g2']['record']).read_text())
        self.assertEqual(rec['decision']['evidence_refs'], ['t1.f1'])
        self.assertEqual(rec['remote_evidence']['delivered_cue_ids'], ['t1.f1', 't1.f2'])
        cue_msg = json.loads(rec['turns'][1]['raw_request']['messages'][-1]['content'])
        self.assertEqual(cue_msg['output']['findings'][0]['id'], 't1.f1')
        case = json.loads((lib.tmp / 'out' / 'g2' / 'o1' / 'suite' / 'cases' / 'sr-o1.json').read_text())
        self.assertEqual(case['evidence'][0]['tool'], 'ffprobe')       # the G1 probe is the case's first evidence
        self.assertEqual(case['fixture']['allowed_root'], str(lib.tv))
        rep = lib.report(st, ACCEPT)
        self.assertEqual({t['target']: t['execution'] for t in rep['targets']}, {k: 'R' for k in FILES})
        self.assertEqual({t['target']: t['diagnosis'] for t in rep['targets']}, {'o1': 'PASS', 'v1': 'PASS', 'h1': 'FAIL', 'v2': 'PASS'})
        self.assertEqual(rep['stage_r']['result'], 'NOT_ACCEPTED')

    def test_accepted_run_matches_its_own_registration(self):
        lib = Library()
        code, st, _pod = lib.drive(replies={'h1': [H.dec('insufficient_evidence', 'escalate')]})
        self.assertEqual(code, 0)
        rep = lib.report(st, ACCEPT)
        self.assertEqual(rep['stage_r']['result'], 'ACCEPTED', rep['stage_r'])
        smaller = dict(lib.reg, targets=lib.reg['targets'][:3])      # a registration with a target the results lack is refused, not accepted
        with self.assertRaises(ValueError):
            REP.evaluate(st, {'verdicts': ACCEPT}, smaller)

    def test_unmatched_target_is_dropped_and_others_run(self):
        lib = Library()
        reg = lib.registration(keys=('o1', 'v2'))
        reg['targets'].append({'key': 'x9', 'role': 'verified', 'bytes': 1, 'season': 's07', 'marker': 'S07E99',
                               'case': th.make_case(id='sr-x9', media='tv', tools_available=list(H.TOOLS))})
        code, st, _pod = lib.drive(reg=reg)
        self.assertEqual(code, 0)
        self.assertEqual(st['targets']['x9']['driver_outcome'], 'dropped')
        self.assertNotIn('x9', lib.harness_calls)
        self.assertEqual(lib.report(st, ACCEPT)['stage_r']['result'], 'INCOMPLETE')

    def test_g1_drift_drops_the_target(self):
        lib = Library()
        p = lib.path('v2')

        def before(argv, n):
            if n == 5:          # the first G1 stat: the file changed after the listing
                st = os.stat(p)
                os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 10 ** 9))
        code, st, _pod = lib.drive(pod=H.LocalPod(before=before), reg=lib.registration(keys=('v2', 'o1')))
        self.assertEqual(code, 0)
        self.assertEqual(st['targets']['v2']['driver_outcome'], 'dropped')
        self.assertIn('G1', st['targets']['v2']['reason'])

    def test_g2_stream_comes_from_the_g1_probe(self):
        lib = Library()
        reg = lib.registration(keys=('o1',))
        other = {'format': H.PROBE['format'], 'streams': [{'index': 7, 'codec_type': 'subtitle', 'codec_name': 'ass'}]}
        reg['targets'][0]['case']['evidence'] = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(other)}]
        code, st, _pod = lib.drive(reg=reg)
        self.assertEqual(code, 0, st.get('stop'))
        sub = [o for o in st['operations'] if o.get('mode') == 'subtitle'][0]['argv']
        self.assertEqual(sub[sub.index('--stream') + 1], '3')


class FatalPaths(unittest.TestCase):
    """After any fatal path the driver starts no further operation and no further target, and the terminal state says so."""

    def stopped(self, lib, code, st, pod, kind, execs, harness_calls=(), exit_code=None):
        self.assertEqual(code, exit_code or D.EXIT_STOP, st.get('stop'))
        self.assertEqual((st['stop']['kind'], st['exit_code']), (kind, code))
        self.assertEqual(pod.execs, execs)
        self.assertEqual(lib.harness_calls, list(harness_calls))
        saved = json.loads((lib.tmp / 'out' / 'stage-r-state.json').read_text())
        self.assertEqual((saved['exit_code'], saved['stop']['kind']), (code, kind))
        self.assertEqual(lib.report(st)['stage_r']['result'], 'INCOMPLETE')

    def test_outer_timeout(self):
        lib = Library()
        code, st, pod = lib.drive(pod=H.LocalPod(before=lambda argv, n: subprocess.TimeoutExpired(argv, 60) if n == 7 else None))
        self.stopped(lib, code, st, pod, 'outer_timeout', 7)
        self.assertEqual(st['targets']['h1']['driver_outcome'], 'not_started')

    def test_nonzero_exec_exit(self):
        lib = Library()
        code, st, pod = lib.drive(pod=H.LocalPod(after=lambda argv, n, r: H.Completed(137, r.stdout, r.stderr) if n == 6 else r))
        self.stopped(lib, code, st, pod, 'exec_failed', 6)

    def test_missing_receipt(self):
        lib = Library()
        code, st, pod = lib.drive(pod=H.LocalPod(after=lambda argv, n, r: H.Completed(0, r.stdout, b'') if n == 2 else r))
        self.stopped(lib, code, st, pod, 'missing_receipt', 2)

    def test_malformed_receipt(self):
        lib = Library()
        code, st, pod = lib.drive(pod=H.LocalPod(after=lambda argv, n, r: edit_receipt(r, bytes_read=-1) if n == 5 else r))
        self.stopped(lib, code, st, pod, 'malformed_receipt', 5)

    def test_hostname_change(self):
        lib = Library()
        code, st, pod = lib.drive(pod=H.LocalPod(after=lambda argv, n, r: edit_receipt(r, hostname='another-pod') if n == 6 else r))
        self.stopped(lib, code, st, pod, 'hostname_changed', 6)

    def test_identity_change_inside_g2(self):
        lib = Library()
        p = lib.path('o1')
        code, st, pod = lib.drive(pod=H.LocalPod(before=lambda argv, n: p.write_bytes(p.read_bytes() + b'!') if n == G1_END + 1 else None))
        self.stopped(lib, code, st, pod, 'harness_stop', G1_END + 1, ['o1'])        # no final stat, no further target
        self.assertEqual((st['targets']['o1']['driver_outcome'], st['targets']['v1']['driver_outcome']), ('stopped', 'not_started'))
        partial = json.loads(Path(st['targets']['o1']['g2']['started_aborted']).read_text())
        self.assertEqual(partial['remote_evidence']['fatal']['kind'], 'identity_mismatch')
        rep = lib.report(st)
        self.assertEqual({t['target']: t['execution'] for t in rep['targets']}, {k: 'STOP' for k in FILES})

    def test_final_mismatch_of_content_marks_invalid(self):
        lib = Library()
        p = lib.path('o1')

        def before(argv, n):
            if n == G1_END + 2:             # o1's final stat: same size, mtime and inode, different last byte
                st = os.stat(p)
                with open(p, 'r+b') as f:
                    f.seek(-1, 2)
                    f.write(b'\x01')
                os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        code, st, pod = lib.drive(pod=H.LocalPod(before=before))
        self.stopped(lib, code, st, pod, 'final_mismatch', G1_END + 2, ['o1'])
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'invalid')
        self.assertEqual(lib.report(st)['targets'][0]['execution'], 'INVALID')

    def test_final_identity_mismatch_marks_invalid(self):
        lib = Library()
        p = lib.path('o1')
        code, st, pod = lib.drive(pod=H.LocalPod(before=lambda argv, n: p.write_bytes(p.read_bytes() + b'!') if n == G1_END + 2 else None))
        self.stopped(lib, code, st, pod, 'identity_mismatch', G1_END + 2, ['o1'])
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'invalid')

    def test_malformed_final_output(self):
        lib = Library()

        def after(argv, n, r):
            if n != G1_END + 2:
                return r
            out = b'["not a fingerprint"]'
            return H.Completed(0, out, json.dumps(dict(json.loads(r.stderr.decode().splitlines()[-1]), stdout_bytes=len(out))).encode())
        code, st, pod = lib.drive(pod=H.LocalPod(after=after))
        self.stopped(lib, code, st, pod, 'malformed_output', G1_END + 2, ['o1'])
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'stopped')

    def test_incomplete_listing_stops_discovery(self):
        lib = Library(pad=500)
        code, st, pod = lib.drive()
        self.stopped(lib, code, st, pod, 'incomplete_listing', 4)                     # Season 12 is the 4th listing
        self.assertNotIn('stat', exec_modes(st))

    def test_inconsistent_listings_stop_discovery(self):
        def entry(**kw):
            def fn(d):
                d['entries'].append(dict({'name': PREFIX + 'x', 'type': 'dir', 'size': 0, 'mtime_ns': 1, 'dev': 1, 'ino': 9}, **kw))
                d['matching'] += 1
                d['scanned'] += 1
                return True
            return fn
        edits = [lambda d: d.update(directory='/elsewhere'), lambda d: d.update(prefix=''), lambda d: d.update(scanned=-1), lambda d: d.update(matching=5),
                 lambda d: d['entries'][0].pop('type'), entry(name=PREFIX + '/../escape'), entry(name='..'), entry(name=PREFIX + 'a\nb'),
                 entry(name='Not the prefix'), entry(type='socket'), entry(size=-1)]
        for i, fn in enumerate(edits):
            lib = Library()
            code, st, pod = lib.drive(pod=H.LocalPod(after=lambda argv, n, r, fn=fn: edit_listing(r, fn) if n == 1 else r))
            self.stopped(lib, code, st, pod, 'malformed_listing', 1)

    def test_listing_with_a_non_utf8_name_stops(self):
        lib = Library()
        try:
            os.mkdir(os.path.join(os.fsencode(str(lib.tv)), os.fsencode(PREFIX) + b' \xff'))
        except OSError:
            self.skipTest('the filesystem refuses a non-UTF-8 name')
        code, st, pod = lib.drive()
        self.stopped(lib, code, st, pod, 'malformed_listing', 1)

    def test_mount_selection_needs_exactly_one_mount(self):
        lib = Library(extra_mount=True)
        code, st, pod = lib.drive()
        self.stopped(lib, code, st, pod, 'mount_selection', 0)

    def test_read_failed(self):
        lib = Library()
        pod = H.LocalPod()
        pod.deploy = None
        code, st, pod = lib.drive(pod=_NoDeploy(pod))
        self.stopped(lib, code, st, pod, 'read_failed', 0)

    def test_early_stop_without_an_offender_subtitle_stream(self):
        lib = Library(probes={'o1': H.PROBE_NO_TEXT})
        code, st, pod = lib.drive()
        self.stopped(lib, code, st, pod, 'early_stop', G1_END, exit_code=D.EXIT_EARLY)

    def test_write_control_stops_after_that_case(self):
        write = json.dumps({'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': [],
                            'source': {'ref': 'case_item'}, 'target': {'kind': 'rename_of_source', 'old_value': 'a', 'new_value': 'b'}})
        fenced = '```json\n' + H.dec('metadata_naming', 'rename') + '\n```'
        for reply in ([write], [fenced, H.dec('healthy', 'none')]):          # a valid write, and a rejected fenced one followed by a healthy decision
            lib = Library()
            code, st, pod = lib.drive(replies={'v1': reply})
            self.stopped(lib, code, st, pod, 'write_control', G1_END + 3, ['o1', 'v1'])      # v1's final check ran, nothing after it
            self.assertEqual(st['targets']['h1']['driver_outcome'], 'not_started')
            self.assertEqual(lib.report(st, ACCEPT)['stage_r']['write_control'], ['v1'])

    def test_record_with_a_fatal_operation_stops(self):
        lib = Library()

        def after(argv, rc):
            run_dir = Path(argv[argv.index('--out') + 1])
            for p in run_dir.glob('sr-*.json'):
                rec = json.loads(p.read_text())
                rec['remote_evidence']['fatal'] = {'kind': 'hostname_changed'}
                p.write_text(json.dumps(rec))
            return rc
        code, st, pod = lib.drive(after=after)
        self.stopped(lib, code, st, pod, 'harness_stop', G1_END + 1, ['o1'])

    def test_pod_health(self):
        cases = [  # (readings, stop phase, execs, harness calls)
            ([{'items': [Library().pod(ready='False')]}], 'G0b', 0, []),                              # unready at the baseline: nothing listed
            ([{'items': [Library().pod(name='someone-else')]}], 'G0b', 1, []),                        # the pod is not the receipt's host
            ([None, None, {'items': [Library().pod(restarts=1)]}], 'G1', 6, []),                      # a restart during G1 (after o1's stat and probe)
            ([None] * 10 + [{'items': [Library().pod(restarts=1)]}], 'G2', G1_END + 2, ['o1']),       # after the first G2 target
            ([None] * 16 + [{'items': [Library().pod(restarts=1)]}], 'G2', G1_END + 5, ['o1', 'v1', 'h1', 'v2'])]   # after the LAST target
        for readings, phase, execs, calls in cases:
            lib = Library()
            seq = iter([r or lib.pods for r in readings] + [lib.pods] * 40)
            code, st, pod = lib.drive(pod=H.LocalPod(pods=lambda: next(seq)))
            self.stopped(lib, code, st, pod, 'pod_health', execs, calls)
            self.assertEqual(st['stop']['phase'], phase)
        self.assertEqual(st['targets']['v2']['driver_outcome'], 'stopped')       # the target the last check no longer vouches for

    def test_leak_guard(self):
        import copy
        probe = copy.deepcopy(H.PROBE)
        probe['format']['tags'] = {'title': 'release of sr-o1 here'}
        lib = Library(probes={'o1': probe})
        code, st, pod = lib.drive()
        self.stopped(lib, code, st, pod, 'leak_guard', G1_END)

    def test_cost_cap(self):
        lib = Library()
        reg = lib.registration()
        reg['limits']['total_cost_usd'] = 0.5

        def after(argv, rc):
            man = Path(argv[argv.index('--out') + 1]) / 'manifest.json'
            m = json.loads(man.read_text())
            m['limits_state']['cost_usd'] = 0.5
            man.write_text(json.dumps(m))
            return rc
        code, st, pod = lib.drive(reg=reg, after=after)
        self.stopped(lib, code, st, pod, 'cost_cap', G1_END + 2, ['o1'])

    def test_stage_deadline(self):
        lib = Library()
        reg = lib.registration()
        reg['limits']['stage_wall_s'] = 900          # G2 needs 600 + 120 s per target: the second target does not fit after a slow first one
        t = [0.0]

        def clock():
            t[0] += 1.0 if lib.harness_calls == [] else 400.0
            return t[0]
        code, st, pod = lib.drive(reg=reg, clock=clock)
        self.stopped(lib, code, st, pod, 'stage_deadline', pod.execs, lib.harness_calls)
        self.assertEqual(st['targets']['h1']['driver_outcome'], 'not_started')

    def test_manifest_commit_is_mandatory_and_verified(self):
        lib = Library()
        with self.assertRaises(ValueError):
            D.Driver(lib.registration(), lib.tmp / 'out', runner=H.LocalPod(), harness=lambda argv: 0, commit=None)
        for hook in (lambda p: (_ for _ in ()).throw(RuntimeError('push refused')), lambda p: {'commit': 'c0ffee', 'manifest_sha256': '0' * 64},
                     lambda p: None):
            lib = Library()
            code, st, pod = lib.drive(commit=hook)
            self.stopped(lib, code, st, pod, 'manifest_commit', 4)                    # no media byte read
            self.assertNotIn('stat', exec_modes(st))

    def test_driver_error_is_a_recorded_stop(self):
        lib = Library()

        def boom(argv, rc):
            raise RuntimeError('unexpected')
        code, st, pod = lib.drive(after=boom)
        self.stopped(lib, code, st, pod, 'driver_error', G1_END + 1, ['o1'])
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'stopped')

    def test_skipped_pod_health_is_incomplete(self):
        lib = Library()
        code, st, _pod = lib.drive(pod_health=False, replies={'h1': [H.dec('insufficient_evidence', 'escalate')]})
        self.assertEqual(code, 0)
        rep = lib.report(st, ACCEPT)
        self.assertEqual(rep['stage_r']['result'], 'INCOMPLETE')

    def test_a_report_needs_a_terminal_state(self):
        lib = Library()
        code, st, _pod = lib.drive()
        st.pop('exit_code')
        with self.assertRaises(ValueError):
            lib.report(st)


class _NoDeploy:
    """A runner whose `kubectl get deploy` fails."""

    def __init__(self, pod):
        self.pod, self.deploy, self.pods = pod, 1, 1

    def __call__(self, argv, **kw):
        if argv[:1] == ['kubectl'] and 'get' in argv:
            return H.Completed(1, b'', b'forbidden')
        return self.pod(argv, **kw)

    @property
    def execs(self):
        return self.pod.execs


class Registration(unittest.TestCase):
    def check_refused(self, reg, lib):
        p = lib.tmp / 'reg.json'
        p.write_text(json.dumps(reg))
        with self.assertRaises(ValueError):
            D.load_registration(p)
        with self.assertRaises(ValueError):
            D.Driver(reg, lib.tmp / 'out', runner=H.LocalPod(), harness=lambda argv: 0, commit=fake_commit)

    def test_registration_is_validated(self):
        lib = Library()
        for owned in (['--max-wall-s', '5'], ['--spl', 'other'], ['--tools-b=v3-remote-1'], ['--evid', 'live'], ['--no-spend']):
            reg = lib.registration()
            reg['harness_args'] = HARNESS + owned
            self.check_refused(reg, lib)
        bad = [lambda r: r.pop('early_stop_roles'), lambda r: r.update(early_stop_roles=[]), lambda r: r['targets'][0].update(key='../../escaped'),
               lambda r: r['targets'][0].update(key='a/b'), lambda r: r['targets'][0]['case'].update(id='../x'),
               lambda r: r['targets'][0]['case'].update(inject_tool_failure={'tool': 'subtitle_sample', 'mode': 'partial'}),
               lambda r: r['targets'][0].update(marker='S07E19'), lambda r: r['limits'].update(target_wall_s=float('inf')),
               lambda r: r['limits'].update(stage_wall_s=float('nan')), lambda r: r['limits'].update(total_cost_usd=11),
               lambda r: r['limits'].update(target_wall_s=0), lambda r: r['limits'].update(target_wall_s=True), lambda r: r['limits'].update(g2_operations=7),
               lambda r: r['limits'].update(speed=1), lambda r: r['discovery'].update(season_dirs={'s07': '('}), lambda r: r['exec'].update(namespace='Bad NS')]
        for fn in bad:
            reg = lib.registration()
            fn(reg)
            self.check_refused(reg, lib)
        reg = lib.registration()
        reg['harness_args'] = HARNESS + ['--max-budget-usd', '1', '--effort', 'xhigh']
        reg['limits'] = {'target_wall_s': 300, 'g2_operations': 4}
        p = lib.tmp / 'reg.json'
        p.write_text(json.dumps(reg))
        D.load_registration(p)                              # lower limits and the harness's own flags are accepted


if __name__ == '__main__':
    unittest.main()
