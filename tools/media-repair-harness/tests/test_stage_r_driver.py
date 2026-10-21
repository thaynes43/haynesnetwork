"""#161: the Stage R driver (scripts/stage_r_driver.py), offline.  The 'pod' is this machine running the REAL mrh-sampler-2 on a synthetic library
(rem_h.LocalPod); the model is a scripted adapter; the harness is run.main in-process.  Each fatal path is shown to start no further operation or target."""
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

PREFIX = 'Show Name (1990)'
FILES = {'o1': ('Season 03', '%s - S03E10 - First.mkv' % PREFIX, 21000), 'v1': ('Season 03', '%s - S03E01 - Second.mkv' % PREFIX, 22000),
         'h1': ('Season 03', '%s - S03E08 - Third.mkv' % PREFIX, 23000), 'v2': ('Season 20', '%s - S20E05 - Fourth.mkv' % PREFIX, 24000)}
ROLES = {'o1': 'offender', 'v1': 'verified', 'h1': 'held', 'v2': 'verified'}
HARNESS = ['--adapter', 'scripted', '--model', 'scripted-model', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3']
CUE = th.tool_call('subtitle_sample', {'at': 60})


class Library:
    def __init__(self, probes=None, extra_mount=False, season_files=0):
        self.tmp = Path(tempfile.mkdtemp())
        self.tv = self.tmp / 'mnt' / 'tv'
        series = self.tv / PREFIX
        for key, (season, name, size) in FILES.items():
            H.media_file(series / season / name, probe=(probes or {}).get(key, H.PROBE), size=size)
        (self.tv / 'Another Show').mkdir()
        for i in range(season_files):
            (series / 'Season 20' / ('pad-%03d.nfo' % i)).write_bytes(b'')
        mounts = [{'name': 'tv', 'mountPath': str(self.tv)}, {'name': 'config', 'mountPath': '/config'}]
        if extra_mount:
            mounts.append({'name': 'tv2', 'mountPath': str(self.tmp / 'other' / 'tv')})
        self.deploy = {'spec': {'selector': {'matchLabels': {'app': 'sampler'}}, 'template': {'spec': {'containers': [{'name': 'app', 'volumeMounts': mounts}]}}}}
        self.pods = {'items': [self.pod()]}
        self.scripts = {}

    def pod(self, restarts=0, ready='True', uid='uid-1'):
        return {'metadata': {'name': H.hostname(), 'uid': uid}, 'status': {'containerStatuses': [{'name': 'app', 'restartCount': restarts}],
                                                                           'conditions': [{'type': 'Ready', 'status': ready}]}}

    def path(self, key):
        season, name, _size = FILES[key]
        return self.tv / PREFIX / season / name

    def registration(self, keys=('o1', 'v1', 'h1', 'v2'), extra_targets=()):
        targets = []
        for k in keys:
            season, name, size = FILES[k]
            t = {'key': k, 'role': ROLES[k], 'file_id': 100 + len(targets), 'bytes': size, 'season': 's3' if season == 'Season 03' else 's20',
                 'case': th.make_case(id='sr-' + k, media='tv', fixture={'kind': 'none'}, tools_available=list(H.TOOLS))}
            if k == 'v1':
                t['marker'] = 'S03E01'
            else:
                t['basename'] = name
            targets.append(t)
        targets += list(extra_targets)
        return {'registration': 'stage-r-1', 'exec': {'namespace': 'media', 'deployment': 'sampler', 'container': 'app'},
                'discovery': {'mount_path_regex': '/tv$', 'series_prefix': PREFIX, 'season_dirs': {'s3': '^Season 0?3$', 's20': '^Season 20$'}},
                'targets': targets, 'harness_args': list(HARNESS), 'early_stop_roles': ['offender'],
                'limits': {'target_wall_s': 600, 'stage_wall_s': 7200, 'total_cost_usd': 10.0}}

    def harness(self, pod, replies=None):
        replies = replies or {}

        def run(argv):
            key = Path(argv[argv.index('--suite') + 1]).parent.name
            script = self.tmp / ('script-%s.json' % key)
            default = [CUE, H.dec(refs=['t1.f1'])] if ROLES[key] == 'offender' else [H.dec('healthy', 'none')]
            script.write_text(json.dumps(replies.get(key, default)))
            self.harness_calls.append(key)
            return R.main(argv + ['--script', str(script)], runner=pod)
        self.harness_calls = []
        return run

    def drive(self, pod=None, reg=None, replies=None, **kw):
        pod = pod or H.LocalPod(self.deploy, self.pods)
        pod.deploy, pod.pods = self.deploy, pod.pods if pod.pods is not None else self.pods
        reg = reg or self.registration()
        out = self.tmp / 'out'
        d = D.Driver(reg, out, runner=pod, harness=self.harness(pod, replies), **kw)
        code = d.run()
        return code, d.state, pod


def exec_modes(state):
    return [o.get('mode') for o in state['operations'] if o.get('mode')]


class HappyPath(unittest.TestCase):
    def test_all_phases_run_and_a_cue_reaches_the_model(self):
        lib = Library()
        code, st, pod = lib.drive()
        self.assertEqual(code, 0, st.get('stop'))
        self.assertIsNone(st['stop'])
        self.assertEqual({k: v['driver_outcome'] for k, v in st['targets'].items()}, {k: 'recorded' for k in FILES})
        modes = exec_modes(st)
        self.assertEqual(modes[:4], ['list'] * 4)                       # discovery completes before any media byte is read
        self.assertNotIn('list', modes[4:])
        self.assertEqual(st['targets']['v1']['basename_source'], 'discovered')
        self.assertEqual(st['targets']['o1']['basename_source'], 'recorded')
        man = json.loads((lib.tmp / 'out' / 'g0b-manifest.json').read_text())
        self.assertEqual(len(man['targets']), 4)
        self.assertEqual(st['hostname'], H.hostname())
        for k in FILES:
            ops = [o for o in st['operations'] if o.get('target') == k and o.get('mode')]
            self.assertLessEqual(len(ops), 9)
            self.assertEqual([o['mode'] for o in ops][:2], ['stat', 'probe'])
            self.assertEqual(ops[-1]['mode'], 'stat')
            self.assertEqual(st['targets'][k]['final'], st['targets'][k]['identity'])
        rec = json.loads(Path(st['targets']['o1']['g2']['record']).read_text())
        self.assertEqual(rec['decision']['evidence_refs'], ['t1.f1'])
        self.assertEqual(rec['remote_evidence']['hostname'], H.hostname())
        cue_msg = json.loads(rec['turns'][1]['raw_request']['messages'][-1]['content'])
        self.assertEqual(cue_msg['output']['findings'][0]['id'], 't1.f1')
        self.assertEqual(cue_msg['output']['kinds']['provenance'], 'observed')
        case = json.loads((lib.tmp / 'out' / 'g2' / 'o1' / 'suite' / 'cases' / 'sr-o1.json').read_text())
        self.assertEqual(case['evidence'][-1]['tool'], 'ffprobe')       # the G1 probe is the case's initial evidence
        self.assertEqual(case['fixture']['expected_identity'], st['targets']['o1']['identity'])
        # the report over this run
        rep = REP.evaluate(st, {'verdicts': [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'accepted'}]})
        self.assertEqual({t['target']: t['execution'] for t in rep['targets']}, {k: 'R' for k in FILES})
        self.assertEqual({t['target']: t['diagnosis'] for t in rep['targets']}, {'o1': 'PASS', 'v1': 'PASS', 'h1': 'FAIL', 'v2': 'PASS'})
        self.assertEqual(rep['stage_r']['result'], 'NOT_ACCEPTED')

    def test_unmatched_target_is_dropped_and_others_run(self):
        lib = Library()
        reg = lib.registration(keys=('o1', 'v2'), extra_targets=[{'key': 'x9', 'role': 'verified', 'bytes': 1, 'season': 's3', 'marker': 'S03E99',
                                                                  'case': th.make_case(id='sr-x9', media='tv', tools_available=list(H.TOOLS))}])
        code, st, _pod = lib.drive(reg=reg)
        self.assertEqual(code, 0)
        self.assertEqual(st['targets']['x9']['driver_outcome'], 'dropped')
        self.assertNotIn('x9', lib.harness_calls)

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


class FatalPaths(unittest.TestCase):
    """After any fatal path the driver starts no further operation and no further target."""

    def assert_stopped(self, code, st, pod, kind, execs, harness_calls=None, lib=None):
        self.assertEqual(code, D.EXIT_STOP, st.get('stop'))
        self.assertEqual(st['stop']['kind'], kind)
        self.assertEqual(pod.execs, execs)
        if harness_calls is not None:
            self.assertEqual(lib.harness_calls, harness_calls)

    def test_outer_timeout(self):
        lib = Library()
        pod = H.LocalPod(before=lambda argv, n: subprocess.TimeoutExpired(argv, 60) if n == 7 else None)     # target 2's G1 stat
        code, st, pod = lib.drive(pod=pod)
        self.assert_stopped(code, st, pod, 'outer_timeout', 7, [], lib)
        self.assertEqual(st['targets']['h1']['driver_outcome'], 'not_started')

    def test_missing_receipt(self):
        lib = Library()
        pod = H.LocalPod(after=lambda argv, n, r: H.Completed(0, r.stdout, b'') if n == 2 else r)
        code, st, pod = lib.drive(pod=pod)
        self.assert_stopped(code, st, pod, 'missing_receipt', 2, [], lib)

    def test_malformed_receipt(self):
        lib = Library()

        def after(argv, n, r):
            if n != 5:
                return r
            lines = r.stderr.decode().splitlines()
            rec = json.loads(lines[-1])
            rec.pop('bytes_read')
            return H.Completed(0, r.stdout, (json.dumps(rec) + '\n').encode())
        code, st, pod = lib.drive(pod=H.LocalPod(after=after))
        self.assert_stopped(code, st, pod, 'malformed_receipt', 5, [], lib)

    def test_hostname_change(self):
        lib = Library()

        def after(argv, n, r):
            if n != 6:
                return r
            rec = json.loads(r.stderr.decode().splitlines()[-1])
            rec['hostname'] = 'another-pod'
            return H.Completed(0, r.stdout, json.dumps(rec).encode())
        code, st, pod = lib.drive(pod=H.LocalPod(after=after))
        self.assert_stopped(code, st, pod, 'hostname_changed', 6, [], lib)

    def test_identity_change_inside_g2(self):
        lib = Library()
        p = lib.path('o1')

        def before(argv, n):
            if n == 13:             # 4 lists + 4 x (stat, probe): the first G2 operation, on o1
                p.write_bytes(p.read_bytes() + b'!')
        code, st, pod = lib.drive(pod=H.LocalPod(before=before))
        self.assertEqual(code, D.EXIT_STOP)
        self.assertEqual(st['stop']['kind'], 'harness_stop')
        self.assertEqual(pod.execs, 13)                         # no final stat, no further target
        self.assertEqual(lib.harness_calls, ['o1'])
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'stopped')
        self.assertEqual(st['targets']['v1']['driver_outcome'], 'not_started')
        partial = json.loads(Path(st['targets']['o1']['g2']['started_aborted']).read_text())
        self.assertEqual(partial['remote_evidence']['fatal']['kind'], 'identity_mismatch')
        rep = REP.evaluate(st, {'verdicts': []})
        self.assertEqual({t['target']: t['execution'] for t in rep['targets']}, {k: 'STOP' for k in FILES})
        self.assertEqual(rep['stage_r']['result'], 'INCOMPLETE')

    def test_final_mismatch_of_content_marks_invalid(self):
        lib = Library()
        p = lib.path('o1')

        def before(argv, n):
            if n == 14:             # o1's final stat: same size and mtime, different first bytes
                st = os.stat(p)
                data = bytearray(p.read_bytes())
                data[-1] = 1
                p.write_bytes(bytes(data))
                os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        code, st, pod = lib.drive(pod=H.LocalPod(before=before))
        self.assert_stopped(code, st, pod, 'final_mismatch', 14, ['o1'], lib)
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'invalid')
        rep = REP.evaluate(st, {'verdicts': []})
        self.assertEqual(rep['targets'][0]['execution'], 'INVALID')

    def test_final_identity_mismatch_marks_invalid(self):
        lib = Library()
        p = lib.path('o1')
        code, st, pod = lib.drive(pod=H.LocalPod(before=lambda argv, n: p.write_bytes(p.read_bytes() + b'!') if n == 14 else None))
        self.assert_stopped(code, st, pod, 'identity_mismatch', 14, ['o1'], lib)
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'invalid')

    def test_incomplete_listing_stops_discovery(self):
        lib = Library(season_files=500)
        code, st, pod = lib.drive()
        self.assert_stopped(code, st, pod, 'incomplete_listing', 3, [], lib)       # the series root, the series, then Season 20 (sorted keys)
        self.assertNotIn('stat', exec_modes(st))

    def test_mount_selection_needs_exactly_one_mount(self):
        lib = Library(extra_mount=True)
        code, st, pod = lib.drive()
        self.assert_stopped(code, st, pod, 'mount_selection', 0, [], lib)

    def test_early_stop_without_an_offender_subtitle_stream(self):
        lib = Library(probes={'o1': H.PROBE_NO_TEXT})
        code, st, pod = lib.drive()
        self.assertEqual(code, D.EXIT_EARLY)
        self.assertEqual(lib.harness_calls, [])                 # no model call
        self.assertEqual(pod.execs, 12)

    def test_write_control_stops_after_that_case(self):
        lib = Library()
        write = json.dumps({'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': [],
                            'source': {'ref': 'case_item'}, 'target': {'kind': 'rename_of_source', 'old_value': 'a', 'new_value': 'b'}})
        code, st, pod = lib.drive(replies={'v1': [write]})
        self.assert_stopped(code, st, pod, 'write_control', 15, ['o1', 'v1'], lib)          # v1's final check ran, nothing after it
        self.assertEqual(st['targets']['h1']['driver_outcome'], 'not_started')
        rep = REP.evaluate(st, {'verdicts': [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'accepted'}]})
        self.assertEqual(rep['stage_r']['write_control'], ['v1'])

    def test_pod_restart_between_targets_stops(self):
        lib = Library()
        readings = iter([lib.pods, lib.pods, lib.pods, {'items': [lib.pod(restarts=1)]}])     # G0b baseline, before o1, after o1, before v1
        pod = H.LocalPod(lib.deploy, lambda: next(readings))
        d = D.Driver(lib.registration(), lib.tmp / 'out', runner=pod, harness=lib.harness(pod))
        code = d.run()
        self.assertEqual(code, D.EXIT_STOP)
        self.assertEqual(d.state['stop']['kind'], 'pod_health')
        self.assertEqual(lib.harness_calls, ['o1'])

    def test_registration_is_validated(self):
        lib = Library()
        reg = lib.registration()
        reg['harness_args'] = HARNESS + ['--max-wall-s', '5']
        p = lib.tmp / 'reg.json'
        p.write_text(json.dumps(reg))
        with self.assertRaises(ValueError):
            D.load_registration(p)
        reg = lib.registration()
        reg['targets'][0]['marker'] = 'S03E10'
        p.write_text(json.dumps(reg))
        with self.assertRaises(ValueError):
            D.load_registration(p)


if __name__ == '__main__':
    unittest.main()
