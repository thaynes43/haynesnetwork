"""#213: the read-only series scan driver (scripts/series_scan.py) and the truth-free scan case rules (scan_suite.py), offline.

The 'pod' is this machine running the REAL mrh-sampler-2 on a synthetic library (rem_h.LocalPod, with fake ffprobe/ffmpeg); the model is the scripted
adapter and the harness is run.main in-process.  Nothing contacts a cluster, Ollama, a GPU or the network.  Every path, series and title is made up."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import rem_h as H
import th
from media_repair_harness import run as R
from media_repair_harness import scan_suite as SS
from media_repair_harness import score_compat

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
spec = importlib.util.spec_from_file_location('series_scan', COMPONENT / 'scripts' / 'series_scan.py')
S = importlib.util.module_from_spec(spec)
sys.modules['series_scan'] = S
spec.loader.exec_module(S)

SHOW = 'Example Show (2001)'
PILOT = '%s - S01E01 - Pilot.mkv' % SHOW
TWINS = '%s - S01E02-E03 - Twins.mkv' % SHOW
ODD = 'odd name.mkv'
S2 = '%s - S02E01 - Return.mp4' % SHOW
ALL_NAMES = (PILOT, TWINS, ODD, S2)


def quiet(fn, *a, **kw):
    err, out = io.StringIO(), io.StringIO()
    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
        r = fn(*a, **kw)
    return r, out.getvalue(), err.getvalue()


class Lib(unittest.TestCase):
    """A synthetic library: <tmp>/mnt/tv/Example Show (2001)/{Season 1, Season 2}, sidecars and noise beside the videos."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp, ignore_errors=True))
        self.root = self.tmp / 'mnt'
        self.series = self.root / 'tv' / SHOW
        s1, s2 = self.series / 'Season 1', self.series / 'Season 2'
        H.media_file(s1 / PILOT, size=21000)
        H.media_file(s1 / TWINS, size=22000)
        H.media_file(s1 / ODD, size=23000, probe_fail=True)
        H.media_file(s2 / S2, size=24000)
        (s1 / ('%s - S01E01 - Pilot.en.srt' % SHOW)).write_text('1\n00:00:01,000 --> 00:00:02,000\nnot read\n')
        (s1 / ('%s - S01E02-E03 - Twins.ass' % SHOW)).write_text('[Script Info]\n')
        (s1 / 'tvshow.nfo').write_text('x')
        self.priv = self.tmp / 'priv'
        self.pod = H.LocalPod()

    def argv(self, *extra, season=1):
        a = ['discover', '--target', 'media/bazarr/app', '--root', str(self.root), '--series-dir', str(self.series), '--out', str(self.priv), '--allow-in-git']
        if season is not None:
            a += ['--season', str(season)]
        return a + list(extra)

    def discover(self, *extra, season=1, pod=None):
        code, out, err = quiet(S.main, self.argv(*extra, season=season), runner=pod or self.pod)
        return code

    def disc(self):
        return json.loads((self.priv / 'discovery.json').read_text(encoding='utf-8'))

    def build(self, out=None):
        out = out or self.priv
        code, _o, _e = quiet(S.main, ['build', '--discovery', str(self.priv / 'discovery.json'), '--out', str(out), '--allow-in-git'])
        self.assertEqual(code, 0)
        return Path(out) / 'suite'


def edit_receipt(r, **over):
    rec = json.loads(r.stderr.decode().splitlines()[-1])
    rec.update(over)
    return H.Completed(r.returncode, r.stdout, json.dumps(rec).encode())


class Names(unittest.TestCase):
    def test_single_episode(self):
        p = S.parse_name(PILOT)
        self.assertEqual((p['series'], p['year'], p['season'], p['episode'], p['episode_end'], p['episode_title']), ('Example Show', 2001, 1, 1, None, 'Pilot'))

    def test_double_episode_forms(self):
        for name in (TWINS, '%s - S01E02E03 - Twins.mkv' % SHOW):
            p = S.parse_name(name)
            self.assertEqual((p['season'], p['episode'], p['episode_end'], p['episode_title']), (1, 2, 3, 'Twins'), name)

    def test_unparsable_names(self):
        for name in (ODD, 'Example Show - S01E01 - Pilot.mkv', '%s - S01E03-E02 - Backwards.mkv' % SHOW, '%s - S01E01 - Pilot.nfo' % SHOW,
                     '%s - S01E01.mkv' % SHOW, ''):
            self.assertIsNone(S.parse_name(name), name)

    def test_title_with_dashes_and_brackets_is_kept_whole(self):
        p = S.parse_name('%s - S10E100 - A - B [WEBDL-1080p].mkv' % SHOW)
        self.assertEqual((p['season'], p['episode'], p['episode_title']), (10, 100, 'A - B [WEBDL-1080p]'))

    def test_case_ids_are_stable_and_non_identifying(self):
        path = '/data/tv/Example Show/Season 1/%s' % PILOT
        cid = S.case_id(path, S.parse_name(PILOT))
        self.assertEqual(cid, 'scan-s01e001-' + hashlib.sha256(path.encode()).hexdigest()[:8])
        self.assertEqual(cid, S.case_id(path, S.parse_name(PILOT)))
        self.assertNotIn('Example', cid)
        self.assertEqual(S.case_id('/x/' + ODD, None), 'scan-unparsed-' + hashlib.sha256(('/x/' + ODD).encode()).hexdigest()[:8])


class Discovery(Lib):
    def test_discovers_one_season_with_sidecars_probe_and_host(self):
        self.assertEqual(self.discover(), 0)
        d = self.disc()
        self.assertTrue(d['complete'])
        self.assertEqual(d['discovery'], S.DISCOVERY_VERSION)
        self.assertEqual(d['expected_hostname'], H.hostname())
        self.assertEqual((d['namespace'], d['deployment'], d['container'], d['exec_target']), ('media', 'bazarr', 'app', 'deploy/bazarr'))
        self.assertEqual(d['allowed_root'], str(self.root))
        names = [f['basename'] for f in d['files']]
        self.assertEqual(sorted(names), sorted([PILOT, TWINS, ODD]))             # Season 2 is not scanned, nfo/srt/ass are not videos
        self.assertEqual(names, sorted(names, key=lambda n: str(self.series / 'Season 1' / n).encode()))
        by = {f['basename']: f for f in d['files']}
        for f in d['files']:
            st = Path(f['path']).stat()
            self.assertEqual(f['identity'], {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino})
            self.assertEqual(f['season_folder'], 'Season 1')
            self.assertEqual(len(f['head_1m_sha256']), 64)
        self.assertEqual(by[PILOT]['sidecar_subtitles'], ['%s - S01E01 - Pilot.en.srt' % SHOW])
        self.assertEqual(by[TWINS]['sidecar_subtitles'], ['%s - S01E02-E03 - Twins.ass' % SHOW])
        self.assertEqual(by[ODD]['sidecar_subtitles'], [])
        self.assertEqual(by[PILOT]['probe']['status'], 'ok')
        self.assertEqual(by[PILOT]['probe']['tool'], 'ffprobe')
        self.assertEqual(by[ODD]['probe']['status'], 'error')          # a failed probe is recorded as evidence, not dropped
        self.assertEqual(d['skipped'], [])

    def test_only_read_only_sampler_modes_and_no_sidecar_is_opened(self):
        self.discover()
        calls = [c for c in self.pod.calls]
        self.assertTrue(calls)
        for c in calls:
            self.assertEqual(c[:2], ['kubectl', '-n'])
            self.assertEqual(c[2:4], ['media', 'exec'])
            self.assertIn(c[c.index('-') + 1], ('list', 'stat', 'probe'))
            self.assertFalse(c[c.index('-') + 2].lower().endswith(('.srt', '.ass', '.nfo')))
        modes = [c[c.index('-') + 1] for c in calls]
        self.assertEqual(modes.count('list'), 2)                          # the series folder and Season 1
        self.assertEqual(modes.count('stat'), 3)
        self.assertEqual(modes.count('probe'), 3)

    def test_all_seasons_when_none_is_given(self):
        self.assertEqual(self.discover(season=None), 0)
        self.assertEqual(sorted(f['basename'] for f in self.disc()['files']), sorted(ALL_NAMES))
        self.assertEqual(sorted(self.disc()['season_folders']), ['Season 1', 'Season 2'])

    def test_no_probe_skips_the_probe_operation(self):
        self.assertEqual(self.discover('--no-probe'), 0)
        self.assertNotIn('probe', [c[c.index('-') + 1] for c in self.pod.calls])
        self.assertTrue(all(f['probe'] is None for f in self.disc()['files']))

    def test_a_truncated_listing_fails_closed(self):
        s1 = self.series / 'Season 1'
        for i in range(S.RE.LIST_CAP + 5):
            (s1 / ('pad-%03d.nfo' % i)).write_bytes(b'')
        self.assertEqual(self.discover(), 3)
        self.assertFalse((self.priv / 'discovery.json').exists())
        failed = json.loads((self.priv / 'discovery-failed.json').read_text())
        self.assertFalse(failed['complete'])
        self.assertEqual(failed['stop']['kind'], 'incomplete_listing')
        self.assertNotIn('stat', [c[c.index('-') + 1] for c in self.pod.calls])      # no media read follows an incomplete listing

    def test_a_missing_receipt_fails_closed_and_stops_everything(self):
        def drop_receipt(argv, n, done):
            return H.Completed(done.returncode, done.stdout, b'') if n == 3 else done
        pod = H.LocalPod(after=drop_receipt)
        self.assertEqual(self.discover(pod=pod), 3)
        self.assertFalse((self.priv / 'discovery.json').exists())
        self.assertEqual(json.loads((self.priv / 'discovery-failed.json').read_text())['stop']['kind'], 'missing_receipt')
        self.assertEqual(pod.execs, 3)                                      # nothing was invoked after the failed one

    def test_a_changed_hostname_fails_closed(self):
        pod = H.LocalPod(after=lambda argv, n, done: edit_receipt(done, hostname='some-other-pod') if n == 4 else done)
        self.assertEqual(self.discover(pod=pod), 3)
        self.assertEqual(json.loads((self.priv / 'discovery-failed.json').read_text())['stop']['kind'], 'hostname_changed')

    def test_a_file_that_changes_after_the_listing_is_skipped_and_recorded(self):
        target = self.series / 'Season 1' / TWINS
        state = {}

        def touch(argv, n):
            if argv[argv.index('-') + 1] == 'stat' and argv[argv.index('-') + 2] == str(target) and not state:
                state['done'] = True
                os.utime(target, ns=(1, 2))
        pod = H.LocalPod(before=touch)
        self.assertEqual(self.discover(pod=pod), 0)
        d = self.disc()
        self.assertEqual(sorted(f['basename'] for f in d['files']), sorted([PILOT, ODD]))
        self.assertEqual(len(d['skipped']), 1)
        self.assertTrue(d['skipped'][0]['path'].endswith(TWINS))

    def test_a_wall_cap_that_leaves_no_room_stops(self):
        self.assertEqual(self.discover('--max-wall-s', '30'), 3)
        self.assertEqual(json.loads((self.priv / 'discovery-failed.json').read_text())['stop']['kind'], 'discover_deadline')
        self.assertEqual(self.pod.execs, 0)

    def test_missing_season_folder_stops(self):
        self.assertEqual(self.discover(season=9), 3)
        self.assertEqual(json.loads((self.priv / 'discovery-failed.json').read_text())['stop']['kind'], 'discovery')

    def test_refuses_a_series_dir_outside_the_root(self):
        with self.assertRaises(SystemExit):
            quiet(S.main, ['discover', '--target', 'media/bazarr/app', '--root', str(self.root), '--series-dir', str(self.tmp / 'elsewhere'), '--out', str(self.priv),
                           '--allow-in-git'], runner=self.pod)
        self.assertEqual(self.pod.execs, 0)

    def test_refuses_an_unnormalised_path(self):
        with self.assertRaises(SystemExit):
            quiet(S.main, ['discover', '--target', 'media/bazarr/app', '--root', str(self.root), '--series-dir', str(self.series) + '/../x', '--out', str(self.priv),
                           '--allow-in-git'], runner=self.pod)

    def test_the_private_directory_must_be_outside_git(self):
        with self.assertRaises(SystemExit) as cm:
            S.private_dir(COMPONENT / 'zz-private-scan-test')
        self.assertIn('inside a git work tree', str(cm.exception))
        self.assertFalse((COMPONENT / 'zz-private-scan-test').exists())

    def test_does_not_overwrite_an_existing_discovery(self):
        self.assertEqual(self.discover(), 0)
        with self.assertRaises(SystemExit):
            self.discover()

    def test_target_forms(self):
        self.assertEqual(S.parse_target('media/bazarr'), {'namespace': 'media', 'deployment': 'bazarr', 'container': 'app'})
        self.assertEqual(S.parse_target('media/bazarr/main')['container'], 'main')
        for bad in ('bazarr', 'a/b/c/d', 'Media/Bazarr', 'a/b;c'):
            with self.assertRaises(SystemExit):
                S.parse_target(bad)


class Built(Lib):
    """A library that has been discovered (every season); the base of the classes that work on a discovery."""

    def setUp(self):
        super().setUp()
        self.assertEqual(self.discover(season=None), 0)

    def cases(self, suite):
        return {p.stem: json.loads(p.read_text(encoding='utf-8')) for p in sorted((suite / 'cases').glob('*.json'))}


class Build(Built):
    def test_one_truth_free_case_per_file_with_a_manifest(self):
        suite = self.build()
        cases = self.cases(suite)
        self.assertEqual(len(cases), 4)
        man = json.loads((suite / 'manifest.json').read_text())
        self.assertEqual((man['kind'], man['split'], man['truth'], man['case_count']), ('series-scan', 'scan', None, 4))
        self.assertEqual([c['id'] for c in man['cases']], sorted(cases))
        for row in man['cases']:
            self.assertEqual(row['sha256'], hashlib.sha256((suite / row['file']).read_bytes()).hexdigest())
        d = self.disc()
        for c in cases.values():
            self.assertEqual(SS.validate_scan_case(c), [])
            self.assertEqual((c['split'], c['truth'], c['supported_actions'], c['media_type']), ('scan', None, [], 'tv'))
            self.assertEqual(c['tools_available'], ['ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'subtitle_sample'])
            self.assertEqual(c['context']['arr'], {})
            self.assertIn('No Sonarr data is available', c['context']['notes_for_model'])
            self.assertNotIn('filename', c['context'])
            fx = c['fixture']
            self.assertEqual((fx['kind'], fx['allowed_root'], fx['expected_hostname'], fx['exec_target']), ('remote', str(self.root), H.hostname(), 'deploy/bazarr'))
            self.assertTrue(fx['locator'].startswith('remote:media/bazarr/app:/'))
            path = fx['locator'].split(':', 2)[2]
            row = next(f for f in d['files'] if f['path'] == path)
            self.assertEqual({k: fx['expected_identity'][k] for k in ('size', 'mtime_ns', 'dev', 'ino')}, row['identity'])
            self.assertEqual(c['evidence'][0]['id'], 'e1')                  # the probe is the FIRST evidence (subtitle_sample takes its stream from it)
            self.assertEqual(c['evidence'][0]['tool'], 'ffprobe')
            self.assertEqual(c['id'], S.case_id(path, S.parse_name(row['basename'])))

    def test_expected_fields_from_the_name(self):
        cases = self.cases(self.build())
        by = {c['fixture']['locator'].rsplit('/', 1)[1]: c for c in cases.values()}
        self.assertEqual(by[PILOT]['context']['expected'], {'series': 'Example Show', 'season': 1, 'episode': 1, 'episode_title': 'Pilot'})
        self.assertEqual(by[PILOT]['context']['title'], 'Example Show S01E01')
        tw = by[TWINS]['context']
        self.assertEqual(tw['expected'], {'series': 'Example Show', 'season': 1, 'episode': 2, 'episode_end': 3, 'episode_title': 'Twins'})
        self.assertIn('two consecutive episodes', tw['notes_for_model'])
        odd = by[ODD]
        self.assertEqual(odd['context']['expected'], {'series': None, 'season': None, 'episode': None, 'episode_title': None})
        self.assertIn('does not follow', odd['context']['notes_for_model'])
        self.assertTrue(odd['id'].startswith('scan-unparsed-'))
        self.assertEqual(odd['scan']['name_parse'], 'unparsed')
        self.assertTrue(by[S2]['id'].startswith('scan-s02e001-'))

    def test_the_same_discovery_builds_byte_identical_cases(self):
        a = self.build(self.tmp / 'a')
        b = self.build(self.tmp / 'b')
        files = sorted(p.relative_to(a) for p in a.rglob('*.json'))
        self.assertEqual(files, sorted(p.relative_to(b) for p in b.rglob('*.json')))
        for f in files:
            self.assertEqual((a / f).read_bytes(), (b / f).read_bytes(), str(f))

    def test_no_probe_discovery_builds_cases_without_evidence(self):
        (self.priv / 'discovery.json').unlink()
        self.assertEqual(self.discover('--no-probe', season=None), 0)
        for c in self.cases(self.build(self.tmp / 'np')).values():
            self.assertEqual(c['evidence'], [])
            self.assertEqual(SS.validate_scan_case(c), [])

    def test_refuses_an_incomplete_discovery(self):
        d = self.disc()
        for bad in (dict(d, complete=False), dict(d, discovery='other'), dict(d, expected_hostname=None)):
            p = self.tmp / 'bad.json'
            p.write_text(json.dumps(bad))
            with self.assertRaises(SystemExit):
                quiet(S.main, ['build', '--discovery', str(p), '--out', str(self.tmp / 'bo'), '--allow-in-git'])
        self.assertFalse((self.tmp / 'bo' / 'suite' / 'cases').exists())

    def test_refuses_a_non_empty_suite_directory(self):
        self.build()
        with self.assertRaises(SystemExit):
            quiet(S.main, ['build', '--discovery', str(self.priv / 'discovery.json'), '--out', str(self.priv), '--allow-in-git'])

    def test_the_leak_guard_passes_every_built_case(self):
        suite = self.build()
        for c in self.cases(suite).values():
            self.assertEqual(S.leak_hits(c, suite), [])


class Validator(unittest.TestCase):
    def case(self, **over):
        c = {'id': 'scan-s01e001-aaaaaaaa', 'suite_version': SS.SUITE_VERSION, 'split': 'scan', 'media_type': 'tv', 'family': 'scan', 'truth': None, 'supported_actions': [],
             'solvable': None, 'context': {'title': 'T', 'expected': {}, 'arr': {}, 'notes_for_model': 'n'},
             'fixture': {'kind': 'remote', 'locator': 'remote:media/bazarr/app:/data/tv/Example Show/Season 1/x.mkv', 'allowed_root': '/data',
                         'expected_identity': {'size': 1, 'mtime_ns': 2, 'dev': 3, 'ino': 4}, 'expected_hostname': 'pod-a'},
             'evidence': [], 'tools_available': ['ffprobe', 'subtitle_sample']}
        c.update(over)
        return c

    def test_a_scan_case_is_valid(self):
        self.assertEqual(SS.validate_scan_case(self.case()), [])

    def test_a_null_truth_is_allowed_only_for_the_scan_split(self):
        for split in ('dev', 'heldout', 'train'):
            errs = SS.validate_scan_case(self.case(split=split))
            self.assertTrue(any('split must be' in e for e in errs), (split, errs))

    def test_a_truth_or_supported_actions_is_refused(self):
        self.assertTrue(SS.validate_scan_case(self.case(truth={'class': 'healthy', 'source': 'x', 'ref': 'y' * 20})))
        self.assertTrue(SS.validate_scan_case(self.case(supported_actions=['none'])))

    def test_other_shape_errors(self):
        for over in ({'tools_available': ['ffprobe', 'arr_lookup']}, {'tools_available': []}, {'media_type': 'movie'}, {'id': 'tv-001'},
                     {'outcome_step': {}}, {'inject_tool_failure': {'tool': 'ffprobe', 'mode': 'error'}},
                     {'context': {'title': 'T', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {}}, 'notes_for_model': 'n'}},
                     {'context': {'title': 'T', 'filename': 'x.mkv', 'expected': {}, 'arr': {}, 'notes_for_model': 'n'}},
                     {'fixture': {'kind': 'none'}}, {'suite_version': 'dev-v1.1'}):
            self.assertTrue(SS.validate_scan_case(self.case(**over)), over)
        c = self.case()
        del c['truth']
        self.assertTrue(SS.validate_scan_case(c))
        c = self.case()
        del c['fixture']['expected_hostname']
        self.assertTrue(SS.validate_scan_case(c))

    def test_the_helper_recognises_only_the_scan_split(self):
        self.assertTrue(SS.is_scan_case(self.case()))
        self.assertFalse(SS.is_scan_case(self.case(split='dev')))
        self.assertFalse(SS.is_scan_case(None))


class ScorerRefusal(Built):
    def run_dir(self):
        suite = self.build()
        ids = sorted(p.stem for p in (suite / 'cases').glob('*.json'))
        run = self.tmp / 'run1'
        run.mkdir()
        (run / 'manifest.json').write_text(json.dumps({'suite_dir': str(suite), 'case_ids': ids}))
        (run / (ids[0] + '.json')).write_text(json.dumps({'record_version': 1, 'case_id': ids[0], 'split': 'scan'}))
        return suite, run

    def test_the_mrh_score_entry_point_refuses_a_scan_suite(self):
        suite, run = self.run_dir()
        for argv in ([str(run), '--suite', str(suite)], ['--suite', str(suite), str(run)], [str(run), '--suite=%s' % suite]):
            with mock.patch.object(score_compat, 'main', side_effect=AssertionError('the scorer must not be reached')):
                with self.assertRaises(SS.ScanRefused) as cm:
                    SS.score_main(argv)
            self.assertIn('refusing to score', str(cm.exception))
            self.assertIn('truth-free', str(cm.exception))

    def test_the_entry_point_is_wired_and_hands_an_ordinary_run_to_the_scorer(self):
        import tomllib
        cfg = tomllib.loads((COMPONENT / 'pyproject.toml').read_text())
        self.assertEqual(cfg['project']['scripts']['mrh-score'], 'media_repair_harness.scan_suite:score_main')
        ts = th.TempSuite([th.make_case(id='c1')])
        self.addCleanup(ts.tmp.cleanup)
        with mock.patch.object(score_compat, 'main', return_value=0) as m:
            self.assertEqual(SS.score_main(['somewhere', '--suite', str(ts.root)]), 0)
        m.assert_called_once_with(['somewhere', '--suite', str(ts.root)])

    def test_a_run_directory_of_scan_records_is_refused_without_a_suite_match(self):
        _suite, run = self.run_dir()
        other = self.tmp / 'other-suite'
        (other / 'cases').mkdir(parents=True)
        with self.assertRaises(SS.ScanRefused) as cm:
            SS.refuse_scan_arguments([str(run), '--suite', str(other)])
        self.assertIn('scan records', str(cm.exception))

    def test_an_ordinary_suite_and_run_are_not_refused(self):
        ts = th.TempSuite([th.make_case(id='c1')])
        self.addCleanup(ts.tmp.cleanup)
        run = self.tmp / 'ordinary'
        run.mkdir()
        (run / 'c1.json').write_text(json.dumps({'record_version': 1, 'case_id': 'c1', 'split': 'dev'}))
        SS.refuse_scan_arguments([str(run), '--suite', str(ts.root)])             # does not raise
        SS.refuse_scan_arguments([])


class RunCommand(Built):
    def setUp(self):
        super().setUp()
        self.suite = self.build()
        self.ids = sorted(p.stem for p in (self.suite / 'cases').glob('*.json'))

    def run_cmd(self, *extra, out=None):
        code, stdout, _err = quiet(S.main, ['run', '--suite', str(self.suite), '--out', str(out or self.tmp / 'runs'), '--allow-in-git'] + list(extra))
        return code, stdout

    def command_of(self, stdout):
        line = [ln for ln in stdout.splitlines() if ln.startswith('  ')][0].strip()
        import shlex
        return shlex.split(line)

    def test_prints_the_runner_command_for_ollama_prime(self):
        code, out = self.run_cmd()
        self.assertEqual(code, 0)
        cmd = self.command_of(out)
        self.assertEqual(cmd[1:3], ['-m', 'media_repair_harness.run'])
        want = ['--adapter', 'ollama', '--model', 'qwen3.8:27b', '--num-ctx', '16384', '--context-policy', 'ctx16k-v1', '--gpu-fit-check', 'full-gpu-v2',
                '--keep-alive', '10m', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--evidence', 'replay',
                '--tools-behavior', 'v3-remote-1', '--tool-output-bytes', '8192', '--no-spend-limit']
        self.assertEqual(cmd[3:3 + len(want)], want)
        rest = cmd[3 + len(want):]
        self.assertEqual(rest[rest.index('--split') + 1], 'scan')
        self.assertEqual(rest[rest.index('--suite') + 1], str(self.suite))
        self.assertEqual(rest[rest.index('--cases') + 1].split(','), self.ids)
        self.assertEqual(rest[rest.index('--out') + 1], str(self.tmp / 'runs' / 'batch-001'))
        self.assertEqual(int(rest[rest.index('--max-wall-s') + 1]), S.BASE_WALL_S + S.PER_CASE_WALL_S * 4)
        self.assertNotIn('--stop-on-receipt-failure', cmd)
        self.assertIn('not executed', out)
        self.assertFalse((self.tmp / 'runs' / 'batch-001').exists())            # printing runs nothing

    def test_the_runner_accepts_the_combination_offline(self):
        code, out = self.run_cmd()
        self.assertIn('the runner accepts this combination', out)
        self.assertIn('tools behaviour v3-remote-1', out)
        ok, msg = S.offline_check(S.RUN_OPTIONS + ['--max-wall-s', '1000', '--split', 'scan', '--suite', str(self.suite), '--out', 'x', '--scratch', 'y'], self.suite)
        self.assertTrue(ok, msg)

    def test_the_offline_check_reports_the_runners_own_refusal(self):
        opts = [x for x in S.RUN_OPTIONS]
        i = opts.index('--evidence-format')
        del opts[i:i + 2]
        ok, msg = S.offline_check(opts + ['--split', 'scan'], self.suite)
        self.assertFalse(ok)
        self.assertIn('--prompt v7', msg)
        opts = list(S.RUN_OPTIONS)
        opts[opts.index('--evidence') + 1] = 'live'
        ok, msg = S.offline_check(opts + ['--split', 'scan'], self.suite)
        self.assertFalse(ok)
        self.assertIn('--evidence replay only', msg)

    def test_the_wall_cap_scales_with_the_pending_cases(self):
        self.assertEqual(S.wall_cap(0), S.BASE_WALL_S)
        self.assertEqual(S.wall_cap(82), S.BASE_WALL_S + 82 * S.PER_CASE_WALL_S)
        _c, out = self.run_cmd('--limit', '2')
        cmd = self.command_of(out)
        self.assertEqual(int(cmd[cmd.index('--max-wall-s') + 1]), S.wall_cap(2))
        _c, out = self.run_cmd('--max-wall-s', '777', '--stop-on-receipt-failure', '--require-digest', 'abc')
        cmd = self.command_of(out)
        self.assertEqual(cmd[cmd.index('--max-wall-s') + 1], '777')
        self.assertIn('--stop-on-receipt-failure', cmd)
        self.assertEqual(cmd[cmd.index('--require-digest') + 1], 'abc')

    def write_batch(self, root, name, ids, error_ids=()):
        b = Path(root) / name
        b.mkdir(parents=True)
        (b / 'manifest.json').write_text('{}')
        for i in ids:
            rec = {'record_version': 1, 'case_id': i}
            if i in error_ids:
                rec['error'] = {'kind': 'adapter_error'}
            (b / (i + '.json')).write_text(json.dumps(rec))

    def test_resume_skips_cases_that_already_have_a_record(self):
        runs = self.tmp / 'runs'
        self.write_batch(runs, 'batch-001', self.ids[:3])
        _c, out = self.run_cmd(out=runs)
        cmd = self.command_of(out)
        self.assertEqual(cmd[cmd.index('--cases') + 1], self.ids[3])
        self.assertEqual(cmd[cmd.index('--out') + 1], str(runs / 'batch-002'))
        self.assertIn('1 pending of 4 cases (3 done)', out)

    def test_resume_with_everything_done_runs_nothing(self):
        runs = self.tmp / 'runs'
        self.write_batch(runs, 'batch-001', self.ids)
        code, out = self.run_cmd(out=runs)
        self.assertEqual(code, 0)
        self.assertIn('nothing to run', out)
        self.assertNotIn('media_repair_harness.run', out)

    def test_retry_errors_reruns_a_record_that_errored(self):
        runs = self.tmp / 'runs'
        self.write_batch(runs, 'batch-001', self.ids, error_ids=[self.ids[1]])
        _c, out = self.run_cmd('--retry-errors', out=runs)
        cmd = self.command_of(out)
        self.assertEqual(cmd[cmd.index('--cases') + 1], self.ids[1])

    def test_limit_takes_the_first_pending_cases(self):
        _c, out = self.run_cmd('--limit', '2')
        cmd = self.command_of(out)
        self.assertEqual(cmd[cmd.index('--cases') + 1].split(','), self.ids[:2])

    def test_execute_runs_the_printed_command_and_nothing_else(self):
        seen = {}

        def fake_execute(cmd, env):
            seen.update(cmd=cmd, env=env)
            return 0
        with mock.patch.object(S, 'execute', fake_execute):
            code, out = self.run_cmd('--execute')
        self.assertEqual(code, 0)
        self.assertEqual(seen['cmd'], self.command_of(out))
        self.assertEqual(seen['env']['PYTHONPATH'].split(os.pathsep)[0], str(COMPONENT / 'src'))

    def test_the_real_execute_starts_one_process_with_that_environment(self):
        with mock.patch.object(S.subprocess, 'run', return_value=subprocess.CompletedProcess(['x'], 7)) as run:
            self.assertEqual(S.execute(['x', 'y'], {'A': 'b'}), 7)
        run.assert_called_once_with(['x', 'y'], env={'A': 'b'})

    def test_an_aborted_runner_exit_code_is_passed_back(self):
        with mock.patch.object(S, 'execute', lambda cmd, env: 3):
            code, out = self.run_cmd('--execute')
        self.assertEqual(code, 3)
        self.assertIn('re-run to resume', out)

    def test_a_non_scan_suite_is_refused(self):
        ts = th.TempSuite([th.make_case(id='c1')])
        self.addCleanup(ts.tmp.cleanup)
        (ts.root / 'manifest.json').write_text('{}')
        with self.assertRaises(SystemExit):
            quiet(S.main, ['run', '--suite', str(ts.root), '--out', str(self.tmp / 'r2'), '--allow-in-git'])


class EndToEnd(Built):
    """The built suite through the REAL runner (scripted model, real sampler on the synthetic library), then the report."""

    def run_batch(self, ids, replies, name='batch-001', root=None):
        root = Path(root or self.tmp / 'runs')
        script = self.tmp / ('script-%s.json' % name)
        script.write_text(json.dumps(replies))
        suite = self.tmp / 'priv' / 'suite'
        argv = ['--adapter', 'scripted', '--model', 'scripted-model', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--evidence', 'replay',
                '--tools-behavior', 'v3-remote-1', '--tool-output-bytes', '8192', '--no-spend-limit', '--split', 'scan', '--suite', str(suite),
                '--cases', ','.join(ids), '--out', str(root / name), '--scratch', str(self.tmp / 'scr'), '--script', str(script)]
        code, _o, _e = quiet(R.main, argv, runner=self.pod)
        return code, root

    def ids_by_name(self):
        suite = self.tmp / 'priv' / 'suite'
        out = {}
        for p in (suite / 'cases').glob('*.json'):
            c = json.loads(p.read_text())
            out[c['fixture']['locator'].rsplit('/', 1)[1]] = c['id']
        return out

    def test_scan_cases_run_through_the_runner_and_the_report_reads_them(self):
        self.build()
        ids = self.ids_by_name()
        code, root = self.run_batch([ids[PILOT]], [th.tool_call('ffprobe', {}), th.tool_call('subtitle_sample', {'at': 60}), H.dec('healthy', 'none')])
        self.assertEqual(code, 0)
        rec = json.loads((root / 'batch-001' / (ids[PILOT] + '.json')).read_text())
        self.assertEqual((rec['split'], rec['decision']['class'], rec['forced']), ('scan', 'healthy', False))
        self.assertEqual([(c['tool'], c['status']) for c in rec['tool_calls']], [('ffprobe', 'ok'), ('subtitle_sample', 'ok')])
        self.assertEqual(rec['remote_evidence']['fatal'], None)
        # a second batch: another case, with a non-healthy finding and a failed decode (the fake sampler has no decoder for a probe_fail file)
        code, _ = self.run_batch([ids[ODD]], [th.tool_call('decode_sample', {'ss': 0, 't': 4}), H.dec('corrupt_file', 'escalate', refs=['t1'])], 'batch-002')
        self.assertEqual(code, 0)
        out = self.tmp / 'priv' / 'report.md'
        c, stdout, _e = quiet(S.main, ['report', '--run', str(root), '--discovery', str(self.priv / 'discovery.json'), '--out', str(out), '--allow-in-git'])
        self.assertEqual(c, 0)
        text = out.read_text(encoding='utf-8')
        summary = json.loads((self.tmp / 'priv' / 'summary.json').read_text())
        self.assertEqual((summary['cases_planned'], summary['records'], summary['missing']), (4, 2, 2))
        self.assertEqual(summary['by_class'], {'corrupt_file': 1, 'healthy': 1})
        self.assertIn('## Non-healthy findings', text)
        self.assertIn(ODD, text)
        self.assertIn('## Missing', text)
        self.assertIn(TWINS, text)

    def test_a_scan_run_is_not_scoreable(self):
        self.build()
        ids = self.ids_by_name()
        _code, root = self.run_batch([ids[PILOT]], [H.dec('healthy', 'none')])
        with self.assertRaises(SS.ScanRefused):
            SS.score_main([str(root / 'batch-001'), '--suite', str(self.tmp / 'priv' / 'suite')])


def fake_record(cid, cls='healthy', action='none', calls=(), forced=False, error=None, wall=10.0, repairs=0, reason='fine'):
    tool_calls = []
    for i, (tool, status, extra) in enumerate(calls, 1):
        tool_calls.append(dict({'id': 't%d' % i, 'turn': i, 'tool': tool, 'status': status, 'output': 'out of %s' % tool}, **extra))
    rec = {'record_version': 1, 'case_id': cid, 'split': 'scan', 'decision': {'type': 'decision', 'class': cls, 'action': action, 'confidence': 0.8, 'reason': reason, 'evidence_refs': []},
           'forced': forced, 'forced_reason': 'x' if forced else None, 'repair_prompts': [{}] * repairs, 'first_try_valid': not repairs and not forced,
           'tool_calls': tool_calls, 'wall': {'total_s': wall}}
    if error:
        rec['error'] = {'kind': error}
    return rec


class Report(Lib):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.discover(season=None), 0)
        self.d = self.disc()
        self.ids = {Path(f['path']).name: S.case_id(f['path'], S.parse_name(f['basename'])) for f in self.d['files']}

    def write_run(self, name, recs, aborted=None, partial=None):
        run = self.tmp / 'runs' / name
        run.mkdir(parents=True)
        (run / 'manifest.json').write_text(json.dumps({'aborted': aborted, 'requested_model': 'qwen3.8:27b', 'config_hash': 'h' * 8}))
        for r in recs:
            (run / (r['case_id'] + '.json')).write_text(json.dumps(r))
        if partial:
            (run / 'started-aborted').mkdir()
            (run / 'started-aborted' / (partial + '.json')).write_text(json.dumps({'case_id': partial}))
        return run

    def report(self, *runs):
        out = self.tmp / 'priv' / 'report.md'
        args = ['report', '--discovery', str(self.priv / 'discovery.json'), '--out', str(out), '--allow-in-git']
        for r in runs:
            args += ['--run', str(r)]
        code, _o, _e = quiet(S.main, args)
        self.assertEqual(code, 0)
        return out.read_text(encoding='utf-8'), json.loads((self.tmp / 'priv' / 'summary.json').read_text())

    def test_aggregation_from_fake_records(self):
        i = self.ids
        recs = [fake_record(i[PILOT], calls=[('ffprobe', 'ok', {}), ('subtitle_sample', 'ok', {})]),
                fake_record(i[TWINS], 'corrupt_file', 'escalate', calls=[('ffprobe', 'ok', {}), ('decode_sample', 'timeout', {})], repairs=1, reason='decode stalls\nat 4 s'),
                fake_record(i[ODD], 'insufficient_evidence', 'escalate', forced=True, error='adapter_error',
                            calls=[('ffprobe', 'error', {'remote_fatal': {'kind': 'identity_mismatch'}}), ('frame_sample', 'unavailable', {})]),
                fake_record(i[S2], calls=[('ffprobe', 'ok', {})], wall=20.5)]
        text, s = self.report(self.write_run('batch-001', recs))
        self.assertEqual((s['cases_planned'], s['records'], s['missing'], s['non_healthy']), (4, 4, 0, 2))
        self.assertEqual(s['by_class'], {'corrupt_file': 1, 'healthy': 2, 'insufficient_evidence': 1})
        self.assertEqual(s['by_action'], {'escalate': 2, 'none': 2})
        self.assertEqual((s['forced'], s['repaired'], s['first_try_valid']), (1, 1, 2))
        self.assertEqual(s['record_errors'], {'adapter_error': 1})
        self.assertEqual(s['tool_failures'], 3)
        self.assertEqual(s['files_with_tool_failures'], 2)
        self.assertEqual(s['remote_fatal_by_kind'], {'identity_mismatch': 1})
        self.assertEqual(s['tool_calls_by_tool_status']['ffprobe'], {'error': 1, 'ok': 3})
        self.assertEqual(s['wall_s'], {'total': 50.5, 'median': 10.0, 'max': 20.5})
        self.assertEqual(s['models'], ['qwen3.8:27b'])
        self.assertIn('decode stalls at 4 s', text)                                     # a reason is one line
        self.assertIn('[fail-closed: identity_mismatch]', text)
        self.assertIn('decode_sample timeout', text)
        self.assertIn('forced (x)', text)
        # per-file order is by season then episode, the unparsed name last
        order = [text.index('| %s |' % n) for n in (PILOT, TWINS, S2, ODD)]
        self.assertEqual(order, sorted(order))

    def test_summary_json_holds_counts_only(self):
        i = self.ids
        recs = [fake_record(i[n], 'corrupt_file', 'escalate', calls=[('ffprobe', 'error', {})], reason='about %s' % n) for n in (PILOT, ODD)]
        _text, s = self.report(self.write_run('batch-001', recs))
        raw = json.dumps(s)
        for needle in (SHOW, 'Example', 'Pilot', 'Twins', 'odd name', '.mkv', '/', str(self.root)):
            self.assertNotIn(needle, raw.replace('series-scan-summary-1', '').replace('qwen3.8:27b', ''))
        for name in ALL_NAMES:
            self.assertNotIn(name, raw)

        def leaves(x):
            return [v for d in x.values() for v in (leaves(d) if isinstance(d, dict) else [d])]
        self.assertTrue(all(isinstance(v, (int, float, type(None), str, list)) for v in leaves(s)))

    def test_later_batches_override_earlier_records_and_partials_are_counted(self):
        i = self.ids
        first = self.write_run('batch-001', [fake_record(i[PILOT], 'corrupt_file', 'escalate', error='adapter_error'), fake_record(i[TWINS])], aborted='wall cap', partial=i[ODD])
        second = self.write_run('batch-002', [fake_record(i[PILOT])])
        _text, s = self.report(first.parent)                       # the run root of batches
        self.assertEqual((s['records'], s['by_class'], s['started_aborted'], s['runs'], s['aborted_runs']), (2, {'healthy': 2}, 1, 2, 1))
        self.assertEqual(s['missing'], 2)
        _text2, s2 = self.report(first, second)                      # or the batches given one by one
        self.assertEqual(s2['by_class'], {'healthy': 2})

    def test_a_record_of_another_scan_is_refused(self):
        run = self.write_run('batch-001', [fake_record('scan-s09e999-deadbeef')])
        with self.assertRaises(SystemExit):
            quiet(S.main, ['report', '--run', str(run), '--discovery', str(self.priv / 'discovery.json'), '--out', str(self.tmp / 'priv' / 'r.md'), '--allow-in-git'])

    def test_a_record_without_a_decision_is_a_non_healthy_row(self):
        rec = fake_record(self.ids[PILOT])
        rec['decision'] = None
        text, s = self.report(self.write_run('batch-001', [rec]))
        self.assertEqual(s['by_class'], {'no_decision': 1})
        self.assertEqual(s['non_healthy'], 1)

    def test_the_report_directory_must_be_outside_git(self):
        with self.assertRaises(SystemExit):
            quiet(S.main, ['report', '--run', str(self.tmp), '--discovery', str(self.priv / 'discovery.json'), '--out', str(COMPONENT / 'report-scan-test.md')])


class Untouched(unittest.TestCase):
    def test_the_stage_r_driver_module_is_the_one_loaded_unchanged(self):
        self.assertIs(S.D1, sys.modules['stage_r_driver_v1'])
        self.assertEqual(S.D1.REGISTRATION_VERSION, 'stage-r-1')

    def test_the_scan_split_is_not_a_split_of_the_evaluators_suite_tool(self):
        # the evaluator-owned suite.py (dev-v1.1) accepts split dev|heldout only, so it refuses a scan suite by design; we do not edit it
        p = COMPONENT.parents[1] / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1' / 'suite.py'
        if not p.is_file():
            self.skipTest('suite.py not present in this tree')
        self.assertIn('if c["split"] not in ("dev", "heldout")', p.read_text())


if __name__ == '__main__':
    unittest.main()
