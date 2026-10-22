"""#165: the Stage R driver v2 (scripts/stage_r_driver_v2.py: `stage-r-driver-3`, registration `stage-r-2`), offline.  As for the #161 driver, the 'pod'
is this machine running the REAL mrh-sampler-2 on a synthetic library (rem_h.LocalPod), on the real layout SHAPE `<mount>/Media/TV Shows/<series>/Season
NN/...`; the model is a scripted adapter, the harness is run.main in-process, and a fake #159 call journal is written from each record the way the shim
writes it.  Git, the clock of the approval, and the parent process id are injected.  Every new check is shown to stop with no further operation or target.
All names, seasons, markers and sizes are synthetic."""
import datetime
import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import rem_h as H
import th
from media_repair_harness import remote_evidence as RE
from media_repair_harness import run as R

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('stage_r_driver_v2', HERE.parent / 'scripts' / 'stage_r_driver_v2.py')
V2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V2)
spec2 = importlib.util.spec_from_file_location('stage_r_report', HERE.parent / 'scripts' / 'stage_r_report.py')
REP = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(REP)

# the #161 driver as merged (a35e68a1): stage-r-driver-2 and registration stage-r-1 stay byte-identical
DRIVER_V1_SHA256 = '45514a8f17d2eba1e10fb731cd11cd0be30e454f59a9763b65c77dac75cf82b6'

PREFIX = 'Sample Series (2001)'
LIBRARY_ROOT = ['Media', 'TV Shows']
FILES = {'o1': ('Season 03', '%s - S03E36 - Alpha.mkv' % PREFIX, 21000), 'o2': ('Season 03', '%s - S03E38 - Beta.mkv' % PREFIX, 22000),
         'v1': ('Season 20', '%s - S20E14 - Gamma.mkv' % PREFIX, 23000), 'v2': ('Season 03', '%s - S03E01 - Delta.mkv' % PREFIX, 24000),
         'v3': ('Season 03', '%s - S03E02 - Epsilon.mkv' % PREFIX, 25000), 'h1': ('Season 03', '%s - S03E08 - Zeta.mkv' % PREFIX, 26000)}
ORDER = ('o1', 'o2', 'v1', 'v2', 'v3', 'h1')
ROLES = {'o1': 'offender', 'o2': 'offender', 'v1': 'verified', 'v2': 'verified', 'v3': 'verified', 'h1': 'held'}
MARKERS = {'v2': 'S03E01', 'v3': 'S03E02'}                # discovered basenames (bytes and a marker); the others are recorded basenames
HARNESS = ['--adapter', 'scripted', '--model', 'scripted-model', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3']
CUE = th.tool_call('subtitle_sample', {'at': 60})
COMMIT = R.git_info()['sha']        # the harness records its own HEAD; the fake pre-run git reports the same commit
APPROVED = datetime.datetime(2026, 10, 22, 9, 0, 0, tzinfo=datetime.timezone.utc)
PPID = 4242
G1_END = 16           # exec numbering: G0b lists 1-4, G1 stat+probe 5-16, then per G2 target its tool calls and the final stat
ACCEPT = [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'accepted'}, {'target': 'o2', 'cue': 't1.f1', 'verdict': 'accepted'}]


def fake_commit(path):
    return {'commit': 'c0ffee', 'manifest_sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}


class Git:
    """A fake `git` for the pre-run binding: HEAD and the porcelain status of src/ and scripts/."""

    def __init__(self, head=COMMIT, status='', rc=0):
        self.head, self.status, self.rc, self.calls = head, status, rc, []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        if 'rev-parse' in argv:
            return H.Completed(self.rc, self.head + '\n', '')
        return H.Completed(self.rc, self.status, '')


class Journal:
    """Writes the #159 shim's journal for one harness run, from its record: a version call, then per model turn `start`, the reply copy and
    `stdout-closed`.  `opts` changes what a target's journal shows (served models, token counts, a missing close or reply copy ...)."""

    def __init__(self, root):
        self.dir = root
        self.dir.mkdir(parents=True, exist_ok=True)
        self.n = 0

    def line(self, text):
        with open(self.dir / 'calls.log', 'a', encoding='utf-8') as f:
            f.write('2026-10-22T09:00:00.000000000Z ' + text + '\n')

    def call_id(self):
        self.n += 1
        return '20261022T090000%09d-%d' % (self.n, 4000 + self.n)

    def write(self, record, opts):
        cid = self.call_id()
        self.line('start %s kind=version nargs=1' % cid)
        self.line('stdout-closed %s' % cid)
        turns = list((record or {}).get('turns') or [])
        if opts.get('calls_delta'):
            turns = turns[:len(turns) + opts['calls_delta']] if opts['calls_delta'] < 0 else turns + turns[:opts['calls_delta']]
        for turn in turns:
            cid = self.call_id()
            self.line('start %s kind=call nargs=27' % cid)
            chars = V2._chars_sent(turn, 'sent') or 1000
            tokens = opts.get('tokens', lambda c: c // 3)(chars)
            ok = isinstance(turn.get('raw_request'), dict)
            reply = {'type': 'result', 'subtype': 'success' if ok else 'error_during_execution', 'is_error': not ok, 'result': turn.get('text') or '',
                     'usage': {'input_tokens': 120, 'cache_creation_input_tokens': max(0, tokens - 120), 'cache_read_input_tokens': 0, 'output_tokens': 40},
                     'modelUsage': {m: {'inputTokens': 120} for m in opts.get('served', ['scripted-model'])}}
            if not opts.get('no_reply'):
                (self.dir / ('out-%s.json' % cid)).write_text(opts.get('reply_text') or json.dumps(reply))
            if not opts.get('no_close'):
                self.line('stdout-closed %s' % cid)
        if opts.get('garbage'):
            with open(self.dir / 'calls.log', 'ab') as f:
                f.write(opts['garbage'])


class Library:
    def __init__(self, layout=True, probes=None):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.mount = self.tmp / 'data' / 'tower'
        self.root = self.mount.joinpath(*LIBRARY_ROOT)
        series = self.root / PREFIX
        for key, (season, name, size) in FILES.items():
            H.media_file(series / season / name, probe=(probes or {}).get(key, H.PROBE), size=size)
        (self.root / 'Another Series').mkdir()
        (self.mount / 'Media' / 'Movies' / PREFIX).mkdir(parents=True)          # decoys: the mount root and the intermediate folders are never listed
        (self.mount / PREFIX / 'Season 03').mkdir(parents=True)
        mounts = [{'name': 'config', 'mountPath': '/config'}, {'name': 'tmp', 'mountPath': '/tmp'}, {'name': 'data', 'mountPath': str(self.mount)}]
        self.deploy = {'spec': {'selector': {'matchLabels': {'app': 'sampler'}}, 'template': {'spec': {'containers': [{'name': 'app', 'volumeMounts': mounts}]}}}}
        self.pods = {'items': [{'metadata': {'name': H.hostname(), 'uid': 'uid-1'},
                                'status': {'containerStatuses': [{'name': 'app', 'restartCount': 0}], 'conditions': [{'type': 'Ready', 'status': 'True'}]}}]}
        self.script = self.tmp / 'empty-script.json'
        self.script.write_text('[]')
        self.journal = Journal(self.tmp / 'journal')
        self.harness_calls = []

    def harness_args(self):
        return HARNESS + ['--script', str(self.script)]      # the per-target script the harness wrapper adds replaces this one (argparse takes the last)

    def registration(self, **over):
        targets = []
        for k in ORDER:
            season, name, size = FILES[k]
            t = {'key': k, 'role': ROLES[k], 'file_id': 500 + len(targets), 'bytes': size, 'season': 's03' if season == 'Season 03' else 's20',
                 'case': th.make_case(id='sr-' + k, media='tv', fixture={'kind': 'none'}, tools_available=list(H.TOOLS))}
            if k in MARKERS:
                t['marker'] = MARKERS[k]
            else:
                t['basename'] = name
            targets.append(t)
        reg = {'registration': 'stage-r-2', 'exec': {'namespace': 'media', 'deployment': 'sampler', 'container': 'app'},
               'discovery': {'mount_path_regex': '.*/tower', 'library_root': list(LIBRARY_ROOT), 'series_prefix': PREFIX,
                             'season_dirs': {'s03': 'Season 0?3', 's20': 'Season 20'}},
               'targets': targets, 'harness_args': self.harness_args(), 'early_stop_roles': ['offender'],
               'limits': {'target_wall_s': 600, 'stage_wall_s': 7200, 'total_cost_usd': 10.0},
               'model_journal': {'path_rule': {'env': 'MRH_CALL_JOURNAL'}, 'served_model': 'scripted-model',
                                 'tripwire': {'chars_basis': 'sent', 'divisor': 2.0, 'slack_tokens': 5000}},
               'approval': {'expiry_s': 28800}}
        reg['binding'] = {'harness_commit': COMMIT, 'sampler_sha256': RE.sampler_sha256(), 'case_templates_sha256': {k: 'inline' for k in ORDER},
                          'config_hash_basis_sha256': registered_basis(reg), 'config_hash_excluded_field': 'limits.max_total_cost_usd'}
        for k, v in over.items():
            reg[k] = v
        return reg

    def harness(self, pod, replies=None, journal=None, after=None):
        replies, journal = replies or {}, journal or {}

        def run(argv):
            key = Path(argv[argv.index('--suite') + 1]).parent.name
            script = self.tmp / ('script-%s.json' % key)
            default = {'offender': [CUE, H.dec(refs=['t1.f1'])], 'held': [H.dec('insufficient_evidence', 'escalate')]}.get(ROLES.get(key),
                                                                                                                [H.dec('healthy', 'none')])
            script.write_text(json.dumps(replies.get(key, default)))
            self.harness_calls.append(key)
            rc = R.main(argv + ['--script', str(script)], runner=pod)
            run_dir, cid = Path(argv[argv.index('--out') + 1]), argv[argv.index('--cases') + 1]
            rec = read(run_dir / (cid + '.json')) or read(run_dir / 'started-aborted' / (cid + '.json'))
            self.journal.write(rec, journal.get(key, {}))
            return after(argv, rc, key) if after else rc
        return run

    def driver(self, pod=None, reg=None, replies=None, journal=None, after=None, **kw):
        pod = pod or H.LocalPod()
        if pod.deploy is None:
            pod.deploy = self.deploy
        if pod.pods is None:
            pod.pods = self.pods
        kw.setdefault('commit', fake_commit)
        kw.setdefault('approved_at', '2026-10-22T09:00:00Z')
        kw.setdefault('now', lambda: APPROVED + datetime.timedelta(hours=1))
        kw.setdefault('getppid', lambda: PPID)
        kw.setdefault('git', Git())
        kw.setdefault('environ', {'MRH_CALL_JOURNAL': str(self.journal.dir)})
        kw.setdefault('sleep', lambda s: None)
        self.reg = reg or self.registration()
        return V2.Driver(self.reg, self.tmp / 'out', runner=pod, harness=self.harness(pod, replies, journal, after), **kw), pod

    def drive(self, **kw):
        d, pod = self.driver(**kw)
        code = d.run()
        return code, d.state, pod

    def report(self, state, verdicts=()):
        return REP.evaluate(state, {'verdicts': list(verdicts)}, self.reg)


def read(p):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return None


def registered_basis(reg):
    lim = dict(V2.D1.LIMIT_CEILINGS, **reg['limits'])
    argv = V2.harness_argv(reg, 'CASE', 'SUITE', 'OUT', 'SCRATCH', float(lim['total_cost_usd']), float(lim['target_wall_s']))
    return V2.config_basis(V2.config_of(argv))[0]


def lists(state):
    return [o for o in state['operations'] if o.get('mode') == 'list']


def list_dir(op):
    argv = op['argv']
    return argv[argv.index('list') + 1]


class Base(unittest.TestCase):
    def assert_no_operation(self, code, st, pod, kind, phase='P0'):
        """A pre-run stop: recorded, exit 3, and nothing ran -- no kubectl read, no exec, no harness."""
        self.assertEqual((code, st['stop']['phase'], st['stop']['kind']), (V2.EXIT_STOP, phase, kind), st['stop'])
        self.assertEqual((pod.calls, st['operations']), ([], []))
        self.assertTrue(all(t['driver_outcome'] == 'not_started' for t in st['targets'].values()))

    def assert_stopped_at(self, lib, code, st, pod, kind, key, harness, execs):
        self.assertEqual((code, st['stop']['kind'], st['stop']['target']), (V2.EXIT_STOP, kind, key), st['stop'])
        self.assertEqual((lib.harness_calls, pod.execs), (harness, execs))
        self.assertNotIn('final', st['targets'][key])
        later = ORDER[ORDER.index(key) + 1:]
        self.assertEqual([st['targets'][k]['driver_outcome'] for k in later], ['not_started'] * len(later))
        self.assertEqual(lib.report(st, [v for v in ACCEPT if v['target'] in harness and v['target'] != key])['stage_r']['result'], 'INCOMPLETE')


class HappyPath(Base):
    def test_a_full_run_on_the_real_layout_shape(self):
        """G-1 and every new check passing: four `list` calls, the first of the registered library root itself; every target recorded with its
        journal verified and its config bound; the report is ACCEPTED."""
        lib = Library()
        code, st, pod = lib.drive()
        self.assertEqual((code, st['stop']), (0, None))
        self.assertEqual((st['driver'], st['registration']), ('stage-r-driver-3', 'stage-r-2'))
        ls = lists(st)
        series = str(lib.root / PREFIX)
        self.assertEqual([list_dir(o) for o in ls], [str(lib.root), series, series + '/Season 03', series + '/Season 20'])
        self.assertEqual(ls[0]['argv'][ls[0]['argv'].index('--prefix') + 1], PREFIX)
        self.assertEqual((st['mount'], st['library_root']), (str(lib.mount), str(lib.root)))
        self.assertEqual(json.loads((lib.tmp / 'out' / 'g0b-manifest.json').read_text())['library_root'], str(lib.root))
        self.assertEqual([st['targets'][k]['driver_outcome'] for k in ORDER], ['recorded'] * 6)
        self.assertEqual(st['targets']['v2']['basename_source'], 'discovered')
        for k in ORDER:
            mj = st['targets'][k]['model_journal']
            self.assertEqual((mj['violations'], mj['unreadable']), ([], []), k)
            self.assertTrue(mj['calls'] and all(c['verdict'] == 'ok' and c['served_models'] == ['scripted-model'] for c in mj['calls']), k)
            self.assertEqual(st['targets'][k]['binding']['drift'], [], k)
        self.assertEqual(st['binding']['checked']['harness_commit'], COMMIT)
        self.assertEqual(st['coordinator']['checks'], 1 + 6 + 6)              # P0, then before each G1 and each G2 target
        self.assertEqual(lib.report(st, ACCEPT)['stage_r']['result'], 'ACCEPTED')

    def test_per_target_hashes_differ_only_by_the_remaining_cap(self):
        """G-4: each target's recorded config hash differs (the remaining cost cap falls), and its basis, the config with that one field excluded, is
        the registered one every time."""
        lib = Library()

        def spend(argv, rc, key):
            p = Path(argv[argv.index('--out') + 1]) / 'manifest.json'
            m = json.loads(p.read_text())
            m['limits_state'] = dict(m.get('limits_state') or {}, cost_usd=1.25)
            p.write_text(json.dumps(m))
            return rc
        code, st, _pod = lib.drive(after=spend)
        self.assertEqual((code, st['stop']), (0, None))
        caps = [st['targets'][k]['binding']['max_total_cost_usd'] for k in ORDER]
        self.assertEqual(caps, [10.0, 8.75, 7.5, 6.25, 5.0, 3.75])
        self.assertEqual(len({st['targets'][k]['binding']['config_hash'] for k in ORDER}), 6)
        self.assertTrue(all(st['targets'][k]['binding']['drift'] == [] for k in ORDER))


class LibraryRoot(Base):
    def test_a_missing_library_root_is_a_recorded_stop(self):
        """G-1: no `<mount>/Media/TV Shows`: the first listing fails, a recorded stop naming the root; no further operation (no stat), no target."""
        lib = Library()
        shutil.rmtree(lib.root)
        code, st, pod = lib.drive()
        self.assertEqual((code, st['stop']['phase']), (V2.EXIT_STOP, 'G0b'))
        self.assertIn('the registered library root %s' % lib.root, st['stop']['detail'])
        self.assertEqual((pod.execs, lib.harness_calls, [o.get('mode') for o in st['operations'] if o.get('mode')]), (1, [], ['list']))

    def test_the_mount_root_is_never_listed(self):
        """The decoy series directly under the mount (where the #161 driver would look) is never seen: only the registered root is listed."""
        lib = Library()
        code, st, _pod = lib.drive()
        self.assertEqual(code, 0)
        dirs = [list_dir(o) for o in lists(st)]
        self.assertNotIn(str(lib.mount), dirs)
        self.assertNotIn(str(lib.mount / 'Media'), dirs)

    def test_a_root_that_leaves_the_mount_is_refused(self):
        """Confinement is still under the MOUNT: a library root that is a symlink out of it is a fatal listing, with no further operation."""
        lib = Library()
        outside = lib.tmp / 'outside'
        lib.root.rename(outside)
        lib.root.symlink_to(outside, target_is_directory=True)
        code, st, pod = lib.drive()
        self.assertEqual((code, st['stop']['phase']), (V2.EXIT_STOP, 'G0b'))
        self.assertEqual((pod.execs, lib.harness_calls), (1, []))

    def test_library_root_components_are_validated(self):
        lib = Library()
        for bad in (['Media/TV Shows'], ['..'], ['Media', '.'], ['a\x00b'], ['a\nb'], 'Media/TV Shows', [''], [3], ['x'] * 9):
            reg = lib.registration()
            reg['discovery']['library_root'] = bad
            errs, _t = V2.validate_registration(reg)
            self.assertTrue(any('library_root' in e for e in errs), bad)
            with self.assertRaises(ValueError):
                V2.Driver(reg, lib.tmp / 'out', commit=fake_commit)


class ModelTripwire(Base):
    def test_a_tripwire_breach_stops(self):
        """G-2: v1's call used more input tokens than characters / 2.0 + 5000: model_tripwire before its final stat, no later target."""
        lib = Library()
        code, st, pod = lib.drive(journal={'v1': {'tokens': lambda chars: chars // 2 + 5001}})
        self.assert_stopped_at(lib, code, st, pod, 'model_tripwire', 'v1', ['o1', 'o2', 'v1'], G1_END + 4)
        self.assertEqual(st['targets']['v1']['model_journal']['calls'][0]['verdict'], 'violation')
        self.assertIn('over the tripwire limit', st['stop']['detail'])

    def test_a_served_model_deviation_stops(self):
        for served in (['other-model'], ['scripted-model', 'other-model'], []):
            lib = Library()
            code, st, pod = lib.drive(journal={'o2': {'served': served}})
            self.assert_stopped_at(lib, code, st, pod, 'model_tripwire', 'o2', ['o1', 'o2'], G1_END + 3)
            self.assertIn('not exactly', st['stop']['detail'])

    def test_an_unreadable_journal_stops(self):
        """G-2: no stdout-closed, no reply copy, a reply copy that is not JSON, fewer or more calls than turns, a line that is no journal record, or
        bytes that are not UTF-8 -- each the recorded stop model_tripwire for that target, before its final stat."""
        for label, opts, needle in (('no close', {'no_close': True}, 'no stdout-closed'), ('no reply', {'no_reply': True}, 'reply copy'),
                                    ('not json', {'reply_text': 'not json'}, 'reply copy'), ('fewer calls', {'calls_delta': -1}, 'model turns'),
                                    ('more calls', {'calls_delta': 1}, 'model turns'), ('garbage', {'garbage': b'nonsense line\n'}, 'no journal record'),
                                    ('not utf-8', {'garbage': b'\xff\xfe\n'}, 'not UTF-8')):
            lib = Library()
            code, st, pod = lib.drive(journal={'v1': opts})
            self.assert_stopped_at(lib, code, st, pod, 'model_tripwire', 'v1', ['o1', 'o2', 'v1'], G1_END + 4)
            self.assertIn(needle, st['stop']['detail'], label)

    def test_a_journal_that_cannot_be_read_before_a_target_stops_it_unstarted(self):
        """The journal position must be read before a target's harness run (so its calls can be told apart): if it cannot be, the target never
        starts -- no harness run, no model call."""
        lib = Library()
        d, pod = lib.driver()
        d.journal_offset = lambda: None
        code = d.run()
        st = d.state
        self.assertEqual((code, st['stop']['kind'], st['stop']['target']), (V2.EXIT_STOP, 'model_tripwire', 'o1'))
        self.assertEqual((lib.harness_calls, pod.execs), ([], G1_END))
        self.assertEqual(st['targets']['o1']['driver_outcome'], 'not_started')

    def test_a_journal_rule_without_a_directory_is_a_prerun_stop(self):
        for env in ({}, {'MRH_CALL_JOURNAL': 'relative/dir'}, {'MRH_CALL_JOURNAL': '/a/../b'}):
            lib = Library()
            code, st, pod = lib.drive(environ=env)
            self.assert_no_operation(code, st, pod, 'model_tripwire')

    def test_the_tripwire_fields_are_validated(self):
        lib = Library()
        for mj in ({'path_rule': {'env': 'OTHER'}}, {'served_model': 'claude-opus-5-5'}, {'tripwire': {'chars_basis': 'all', 'divisor': 2.0, 'slack_tokens': 5000}},
                   {'tripwire': {'chars_basis': 'sent', 'divisor': 0, 'slack_tokens': 5000}}, {'tripwire': {'chars_basis': 'sent', 'divisor': 2.0}}):
            reg = lib.registration()
            reg['model_journal'] = dict(reg['model_journal'], **mj)
            self.assertTrue(V2.validate_registration(reg)[0], mj)


class Coordinator(Base):
    def test_an_orphaned_driver_stops_before_its_next_target(self):
        """G-3: the coordinator dies during o1 (the driver is re-parented: to 1, or to a subreaper): coordinator_lost before o2 starts."""
        for orphan in (1, 777):
            lib = Library()
            ppid = {'now': PPID}

            def lose(argv, rc, key, ppid=ppid, orphan=orphan):
                ppid['now'] = orphan
                return rc
            code, st, pod = lib.drive(getppid=lambda: ppid['now'], after=lose)
            self.assertEqual((code, st['stop']['kind'], st['stop']['target']), (V2.EXIT_STOP, 'coordinator_lost', 'o2'))
            self.assertEqual((lib.harness_calls, pod.execs), (['o1'], G1_END + 2))         # o1 completed with its final stat; nothing after it
            self.assertEqual(st['targets']['o1']['driver_outcome'], 'recorded')
            self.assertEqual([st['targets'][k]['driver_outcome'] for k in ORDER[1:]], ['not_started'] * 5)

    def test_an_orphan_at_start_is_a_prerun_stop(self):
        lib = Library()
        code, st, pod = lib.drive(getppid=lambda: 1)
        self.assert_no_operation(code, st, pod, 'coordinator_lost')


class Binding(Base):
    def test_each_binding_mismatch_is_a_prerun_stop(self):
        """G-4: the harness commit, a dirty src/ or scripts/, an unreadable git, the sampler sha256, a template digest and the config basis: each a
        recorded stop before any operation."""
        lib = Library()
        good = lib.registration()
        cases = [('commit', {}, Git(head='cd' * 20)), ('dirty tree', {}, Git(status=' M src/media_repair_harness/run.py\n')),
                 ('git fails', {}, Git(rc=128)), ('sampler', {'sampler_sha256': '0' * 64}, Git()),
                 ('template', {'case_templates_sha256': dict(good['binding']['case_templates_sha256'], o1='1' * 64)}, Git()),
                 ('config basis', {'config_hash_basis_sha256': '2' * 64}, Git())]
        for label, change, git in cases:
            lib = Library()
            reg = lib.registration()
            reg['binding'] = dict(reg['binding'], **change)
            code, st, pod = lib.drive(reg=reg, git=git)
            self.assert_no_operation(code, st, pod, 'binding_mismatch')
            self.assertIn('the registration binds', st['stop']['detail'], label)

    def test_the_config_basis_is_rebuilt_from_the_registered_arguments(self):
        """A registration whose harness arguments changed after its basis was computed is refused before any operation."""
        lib = Library()
        reg = lib.registration()
        reg['harness_args'] = reg['harness_args'] + ['--tool-output-bytes', '4096']
        code, st, pod = lib.drive(reg=reg)
        self.assert_no_operation(code, st, pod, 'binding_mismatch')
        self.assertIn('config_hash_basis_sha256', st['stop']['detail'])

    def test_a_recorded_config_that_drifts_stops_the_target(self):
        """G-4 after each run: a recorded config that differs from the basis in any field but the remaining cap, a cap that is not the remainder passed,
        or another harness commit: binding_mismatch before the final stat, no later target."""
        def tamper(edit):
            def after(argv, rc, key):
                if key != 'v1':
                    return rc
                p = Path(argv[argv.index('--out') + 1]) / 'manifest.json'
                m = json.loads(p.read_text())
                edit(m)
                m['config_hash'] = R.sha256_bytes(R.canonical(m['config']).encode())
                p.write_text(json.dumps(m))
                return rc
            return after
        for label, edit, needle in (('a field', lambda m: m['config'].update(prompt_version='v8'), 'config basis'),
                                    ('the cap', lambda m: m['config']['limits'].update(max_total_cost_usd=3.0), 'not the remainder'),
                                    ('the commit', lambda m: m['harness_git'].update(sha='cd' * 20), 'harness ran at commit')):
            lib = Library()
            code, st, pod = lib.drive(after=tamper(edit))
            self.assert_stopped_at(lib, code, st, pod, 'binding_mismatch', 'v1', ['o1', 'o2', 'v1'], G1_END + 4)
            self.assertIn(needle, st['stop']['detail'], label)

    def test_the_binding_fields_are_validated(self):
        lib = Library()
        for change in ({'harness_commit': 'abc'}, {'sampler_sha256': 'x'}, {'config_hash_excluded_field': 'limits'},
                       {'case_templates_sha256': {'o1': 'inline'}}, {'extra': 1}):
            reg = lib.registration()
            reg['binding'] = dict(reg['binding'], **change)
            self.assertTrue(V2.validate_registration(reg)[0], change)


class Approval(Base):
    def test_a_missing_invalid_future_or_expired_approval_refuses_to_start(self):
        for label, approved, now, kind in (
                ('missing', None, APPROVED, 'approval_missing'), ('not ISO-8601', 'yesterday', APPROVED, 'approval_invalid'),
                ('not UTC', '2026-10-22T11:00:00+02:00', APPROVED, 'approval_invalid'), ('naive', '2026-10-22T09:00:00', APPROVED, 'approval_invalid'),
                ('future', '2026-10-22T10:00:00Z', APPROVED, 'approval_invalid'),
                ('expired', '2026-10-22T09:00:00Z', APPROVED + datetime.timedelta(hours=8, seconds=1), 'approval_expired')):
            lib = Library()
            code, st, pod = lib.drive(approved_at=approved, now=lambda now=now: now)
            self.assert_no_operation(code, st, pod, kind)

    def test_the_expiry_stops_before_the_next_target(self):
        """G-5: the registered expiry (here 2 h) passes during v1: approval_expired before v2 starts, with no further operation."""
        lib = Library()
        reg = lib.registration(approval={'expiry_s': 7200})
        clock = {'now': APPROVED + datetime.timedelta(minutes=30)}

        def late(argv, rc, key):
            if key == 'v1':
                clock['now'] = APPROVED + datetime.timedelta(hours=2, seconds=1)
            return rc
        code, st, pod = lib.drive(reg=reg, now=lambda: clock['now'], after=late)
        self.assertEqual((code, st['stop']['kind'], st['stop']['target']), (V2.EXIT_STOP, 'approval_expired', 'v2'))
        self.assertEqual((lib.harness_calls, pod.execs), (['o1', 'o2', 'v1'], G1_END + 5))
        self.assertEqual(st['targets']['v1']['driver_outcome'], 'recorded')
        self.assertEqual([st['targets'][k]['driver_outcome'] for k in ('v2', 'v3', 'h1')], ['not_started'] * 3)
        self.assertEqual(st['approval']['expires_at'], '2026-10-22T11:00:00+00:00')

    def test_the_expiry_is_at_most_eight_hours(self):
        lib = Library()
        for ap in ({'expiry_s': 28801}, {'expiry_s': 0}, {}, {'expiry_s': 3600, 'extra': 1}):
            reg = lib.registration(approval=ap)
            self.assertTrue(any('approval' in e for e in V2.validate_registration(reg)[0]), ap)

    def test_the_command_line_requires_the_approval(self):
        lib = Library()
        p = lib.tmp / 'reg.json'
        p.write_text(json.dumps(lib.registration()))
        with self.assertRaises(SystemExit) as cm:
            V2.main(['--registration', str(p), '--out', str(lib.tmp / 'o'), '--commit-repo', str(lib.tmp)])
        self.assertEqual(cm.exception.code, 2)


class Versions(unittest.TestCase):
    def test_the_161_driver_is_byte_identical(self):
        self.assertEqual(hashlib.sha256((HERE.parent / 'scripts' / 'stage_r_driver.py').read_bytes()).hexdigest(), DRIVER_V1_SHA256)

    def test_the_161_driver_cannot_find_the_series_on_this_layout(self):
        """The gap G-1 closes: the #161 driver, given the same library as a stage-r-1 registration, lists the mount root and stops at discovery
        after one listing (the G0a pre-registration's `gap_documented_layout`)."""
        lib = Library()
        shutil.rmtree(lib.mount / PREFIX)          # without the decoy: the real layout has no series directly under the mount
        reg = lib.registration()
        for k in ('model_journal', 'binding', 'approval'):
            reg.pop(k)
        reg['discovery'].pop('library_root')
        reg['registration'] = 'stage-r-1'
        pod = H.LocalPod(deploy=lib.deploy, pods=lib.pods)
        d = V2.D1.Driver(reg, lib.tmp / 'out1', runner=pod, harness=lib.harness(pod), commit=fake_commit)
        self.assertEqual(d.run(), V2.EXIT_STOP)
        self.assertEqual((d.state['stop']['phase'], d.state['stop']['kind'], pod.execs), ('G0b', 'discovery', 1))
        self.assertEqual(list_dir(lists(d.state)[0]), str(lib.mount))

    def test_each_driver_takes_only_its_own_registration(self):
        lib = Library()
        reg2 = lib.registration()
        self.assertIn("registration must be 'stage-r-1'", V2.D1.validate_registration(reg2)[0])
        reg1 = dict(reg2, registration='stage-r-1')
        self.assertIn("registration must be 'stage-r-2'", V2.validate_registration(reg1)[0])
        self.assertEqual(V2.validate_registration(reg2)[0], [])


if __name__ == '__main__':
    unittest.main()
