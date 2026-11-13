"""#213 third live finding: under tools behaviour v3-remote-2 the probe's input limit is ADAPTIVE and measured (remote_quota.py `adaptive-probe-1`), both in the model's
`ffprobe` tool and in the series-scan discovery probe.  Six x265 files failed the fixed 8 MiB probe with `quota_exhausted: true` and the model called them truncated.

The REAL mrh-sampler-4 (and, for discovery, mrh-sampler-2 for list and stat) runs locally over made-up sparse files with a fake ffprobe that reads the range server like the
real one: it needs `probe_need_bytes` of input before it can print its result, and when the input is cut it prints ffmpeg's own "Stream ends prematurely" lines and exits 1.
No cluster, no model, no network, no real media; every path and size is made up.  Small files only: the bytes a test reads are the sum of its attempts."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import rem2_h as H2
import rem_h as H
from media_repair_harness import remote_evidence_2 as R2
from media_repair_harness import remote_quota as RQ

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('series_scan', HERE.parent / 'scripts' / 'series_scan.py')
S = importlib.util.module_from_spec(spec)
sys.modules.setdefault('series_scan', S)
spec.loader.exec_module(S)

MIB = 1024 * 1024

FAKE_FFPROBE_NEED = '''#!%s
import json, sys, urllib.request
url = sys.argv[-1]
def get():
    return urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-'}), timeout=10)
resp = get()
head = resp.read(8192)
hdr = json.loads(head.split(b'\\n', 1)[0])
if hdr.get('probe_fail'):
    sys.stderr.write('Invalid data found when processing input\\n')
    sys.exit(1)
need, got, cut = int(hdr.get('probe_need_bytes', 0)), len(head), False
try:
    while got < need:
        chunk = resp.read(min(65536, need - got))
        if not chunk:
            raise EOFError
        got += len(chunk)
except Exception:
    cut = True
if cut:
    if hdr.get('reread'):
        try:
            get().read(1)         # a seek back to the start: every byte served counts against the limit again
        except Exception:
            pass
    sys.stderr.write('[http @ 0x1] Stream ends prematurely at %%d, should be %%s\\n[matroska,webm @ 0x2] Read error\\n' %% (got, hdr.get('size', '?')))
    sys.exit(1)
print(json.dumps(hdr['probe']))
'''


def pod():
    p = H2.pod()
    ff = p.bin / 'ffprobe'
    ff.write_text(FAKE_FFPROBE_NEED % sys.executable)
    ff.chmod(0o755)
    return p


def quiet(fn, *a, **kw):
    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **kw)


class Rig(H2.Rig):
    def __init__(self, test, size, need, max_operations=None, **hdr):
        super().__init__(test, size=size, probe_need_bytes=need, **hdr)
        self.pod = pod()
        self.ctx = H2.make_ctx(self.case, self.pod)
        self.ctx.remote_binding.max_operations = max_operations

    def probe(self):
        return self.call('ffprobe', {})

    def entries(self):
        return [e for e in self.ctx.remote_binding.receipts if e['mode'] == 'probe']

    def limits_in_argv(self):
        return [int(e['argv'][e['argv'].index('--input-quota-bytes') + 1]) for e in self.entries()]


class Sequence(unittest.TestCase):
    def test_a_250_mb_file_tries_8_16_32_64_128_mib_then_the_file_size(self):
        self.assertEqual(RQ.probe_limits(250_000_000), [8 * MIB, 16 * MIB, 32 * MIB, 64 * MIB, 128 * MIB, 250_000_000])

    def test_the_file_size_is_the_last_step_and_never_exceeded(self):
        for size in (9 * MIB, 16 * MIB, 16 * MIB + 1, 300_000_000, 4_726_000_000):
            limits = RQ.probe_limits(size)
            self.assertEqual(limits[-1], size, size)
            self.assertTrue(all(b <= size for b in limits), size)
            self.assertTrue(all(b == min(a * 2, size) for a, b in zip(limits, limits[1:])), size)

    def test_a_file_that_fits_the_floor_has_one_attempt(self):
        for size in (1, 5_000_000, 8 * MIB):
            self.assertEqual(RQ.probe_limits(size), [8 * MIB], size)
        self.assertEqual(RQ.probe_limits(None), [8 * MIB])

    def test_worst_case_is_the_sum_of_the_attempts_and_below_three_times_the_file(self):
        w = RQ.probe_worst_case(250_000_000)
        self.assertEqual((w['attempts'], w['bytes']), (6, sum(RQ.probe_limits(250_000_000))))
        self.assertEqual(w['bytes'], 510_046_848)
        self.assertAlmostEqual(w['ratio_to_file_size'], 2.0402, places=4)
        for size in (16 * MIB + 1, 256 * MIB + 1, 300_000_000, 4_726_000_000):
            self.assertLess(RQ.probe_worst_case(size)['ratio_to_file_size'], 3.0, size)
        self.assertEqual(RQ.probe_worst_case(4_726_000_000)['attempts'], 11)


def receipt(**over):
    r = {'exit_code': 1, 'bytes_read': 8 * MIB, 'quota_exhausted': True}
    r.update(over)
    return r


class Rule(unittest.TestCase):
    """The rule itself, over scripted attempts."""

    def run_rule(self, size, script):
        seen = []

        def attempt(limit):
            seen.append(limit)
            r, out = script[len(seen) - 1]
            return dict(r, bytes_read=min(r.get('bytes_read', limit), limit)), out
        retries = []
        rec, out, summary = RQ.adaptive_probe(size, attempt, before_retry=lambda: retries.append(1))
        return seen, rec, out, summary, retries

    OK = ({'exit_code': 0, 'bytes_read': 4 * MIB, 'quota_exhausted': False}, b'{"format": {}}')
    CUT = ({'exit_code': 1, 'bytes_read': 10 ** 12, 'quota_exhausted': True}, b'')

    def test_retries_only_after_a_failure_that_used_the_limit_up(self):
        seen, _r, _o, s, retries = self.run_rule(250_000_000, [self.CUT, self.CUT, self.OK])
        self.assertEqual(seen, [8 * MIB, 16 * MIB, 32 * MIB])
        self.assertEqual(len(retries), 2)
        self.assertEqual((s['final'], s['succeeded_quota_bytes'], s['total_bytes_read']), ('ok', 32 * MIB, 8 * MIB + 16 * MIB + 4 * MIB))
        self.assertEqual([a['outcome'] for a in s['attempts']], ['failed_quota_exhausted', 'failed_quota_exhausted', 'ok'])
        self.assertEqual([a['attempt'] for a in s['attempts']], [1, 2, 3])

    def test_a_failure_without_exhaustion_is_never_retried(self):
        seen, rec, _o, s, retries = self.run_rule(250_000_000, [({'exit_code': 1, 'bytes_read': 3 * MIB, 'quota_exhausted': False}, b'')])
        self.assertEqual((seen, retries, s['final'], s['succeeded_quota_bytes']), ([8 * MIB], [], 'failed', None))
        self.assertEqual(s['attempts'][0]['outcome'], 'failed')

    def test_a_success_is_never_retried_even_if_it_used_the_limit_up(self):
        seen, _r, _o, s, _x = self.run_rule(250_000_000, [({'exit_code': 0, 'bytes_read': 8 * MIB, 'quota_exhausted': True}, b'{"streams": []}')])
        self.assertEqual((seen, s['final']), ([8 * MIB], 'ok'))
        self.assertTrue(s['attempts'][0]['quota_exhausted'])

    def test_exit_0_without_a_json_object_counts_as_a_failed_probe(self):
        seen, _r, _o, s, _x = self.run_rule(20 * MIB, [({'exit_code': 0, 'bytes_read': 8 * MIB, 'quota_exhausted': True}, b'not json'), self.OK])
        self.assertEqual((seen, s['final']), ([8 * MIB, 16 * MIB], 'ok'))

    def test_the_last_step_at_the_file_size_failing_is_a_whole_file_finding(self):
        seen, _r, _o, s, _x = self.run_rule(20 * MIB, [self.CUT, self.CUT, self.CUT])
        self.assertEqual(seen, [8 * MIB, 16 * MIB, 20 * MIB])
        self.assertEqual((s['final'], s['succeeded_quota_bytes']), ('whole_file_unprobeable', None))
        self.assertTrue(s['attempts'][-1]['limit_is_file_size'])
        self.assertIn('could not be probed with the whole file readable', RQ.probe_note(s)['note'])

    def test_the_last_step_failing_without_exhaustion_stays_the_decoders(self):
        seen, _r, _o, s, _x = self.run_rule(20 * MIB, [self.CUT, self.CUT, ({'exit_code': 1, 'bytes_read': 20 * MIB, 'quota_exhausted': False}, b'')])
        self.assertEqual((seen[-1], s['final']), (20 * MIB, 'failed'))
        self.assertIn("ffprobe's own", RQ.probe_note(s)['note'])

    def test_one_clean_attempt_has_no_note(self):
        _s, _r, _o, s, _x = self.run_rule(250_000_000, [self.OK])
        self.assertIsNone(RQ.probe_note(s))

    def test_a_fatal_operation_ends_the_rule(self):
        class Fatal(Exception):
            pass

        def attempt(limit):
            raise Fatal()
        with self.assertRaises(Fatal):
            RQ.adaptive_probe(250_000_000, attempt)


class ModelTool(unittest.TestCase):
    """The model's `ffprobe` tool over the real mrh-sampler-4."""

    def test_the_probe_that_needs_more_than_8_mib_succeeds_after_doubling(self):
        rig = Rig(self, size=60_000_000, need=20_000_000, max_operations=6)
        res = rig.probe()
        self.assertEqual(res['status'], 'ok')
        out = json.loads(res['output'])
        self.assertIn('streams', out)
        self.assertEqual([a['input_limit_bytes'] for a in out['probe_read']['attempts']], [8 * MIB, 16 * MIB, 32 * MIB])
        self.assertEqual([a['stopped_by_input_limit'] for a in out['probe_read']['attempts']], [True, True, False])
        self.assertIn('not a sign of a truncated or damaged file', out['probe_read']['note'])
        self.assertEqual(rig.limits_in_argv(), [8 * MIB, 16 * MIB, 32 * MIB])
        # every attempt is its own receipt entry with the limit, the bytes read, whether it was used up, and the outcome
        got = [(e['probe_attempt']['attempt'], e['probe_attempt']['quota_bytes'], e['probe_attempt']['bytes_read'], e['probe_attempt']['quota_exhausted'],
                e['probe_attempt']['outcome']) for e in rig.entries()]
        self.assertEqual(got[:2], [(1, 8 * MIB, 8 * MIB, True, 'failed_quota_exhausted'), (2, 16 * MIB, 16 * MIB, True, 'failed_quota_exhausted')])
        self.assertEqual((got[2][0], got[2][1], got[2][3], got[2][4]), (3, 32 * MIB, False, 'ok'))
        self.assertGreaterEqual(got[2][2], 20_000_000)
        self.assertEqual([e['receipt']['input_quota_bytes'] for e in rig.entries()], [8 * MIB, 16 * MIB, 32 * MIB])
        # the record carries the summary: the attempts and the limit that succeeded
        summary = res['probe_read']
        self.assertEqual((summary['final'], summary['succeeded_quota_bytes']), ('ok', 32 * MIB))
        self.assertEqual(summary['total_bytes_read'], sum(e['receipt']['bytes_read'] for e in rig.entries()))
        self.assertLessEqual(summary['total_bytes_read'], summary['worst_case']['bytes'])

    def test_the_retries_of_one_probe_do_not_use_up_the_cases_other_operations(self):
        rig = Rig(self, size=60_000_000, need=20_000_000, max_operations=6)
        rig.probe()
        b = rig.ctx.remote_binding
        rec = b.record()
        self.assertEqual((b.operations, rec['operations'], rec['max_operations'], rec['probe_retries']), (3, 3, 6, 2))
        self.assertEqual(b.max_operations - b.operations, 6 - 1)         # five operations remain, as if the probe had been one
        self.assertEqual([e['n'] for e in b.receipts], [1, 2, 3])

    def test_a_single_clean_probe_is_exactly_what_it_was(self):
        rig = Rig(self, size=60_000_000, need=2_000_000, max_operations=6)
        res = rig.probe()
        self.assertEqual(res['status'], 'ok')
        self.assertNotIn('probe_read', json.loads(res['output']))             # nothing to tell the model ...
        self.assertEqual([a['quota_bytes'] for a in res['probe_read']['attempts']], [8 * MIB])        # ... but the record still names the attempt
        self.assertEqual(res['probe_read']['succeeded_quota_bytes'], 8 * MIB)
        self.assertEqual(rig.limits_in_argv(), [8 * MIB])
        self.assertEqual(rig.entries()[0]['probe_attempt']['outcome'], 'ok')
        self.assertNotIn('probe_retries', rig.ctx.remote_binding.record())

    def test_a_failure_without_exhaustion_is_the_decoders_and_is_not_retried(self):
        rig = Rig(self, size=60_000_000, need=0, probe_fail=True)
        res = rig.probe()
        self.assertEqual(res['status'], 'error')
        out = json.loads(res['output'])
        self.assertEqual(out, {'exit_code': 1, 'stderr': 'Invalid data found when processing input\n'})
        self.assertEqual(len(rig.entries()), 1)

    def test_a_file_that_cannot_be_probed_even_whole_says_so_and_never_says_truncated(self):
        size = 20 * MIB
        rig = Rig(self, size=size, need=size + 10 * MIB, reread=True)
        res = rig.probe()
        self.assertEqual(res['status'], 'error')
        self.assertEqual(rig.limits_in_argv(), [8 * MIB, 16 * MIB, size])
        out = json.loads(res['output'])
        self.assertIn('could not be probed with the whole file readable', out['probe_read']['note'])
        self.assertEqual(out['stderr'], '')                                    # the cut's messages are not shown ...
        self.assertNotIn('Stream ends prematurely at', res['output'])
        self.assertTrue(all(a['stopped_by_input_limit'] for a in out['probe_read']['attempts']))
        self.assertIn('prematurely', rig.entries()[-1]['receipt']['stderr'])     # ... but the receipt keeps them
        self.assertEqual(res['probe_read']['final'], 'whole_file_unprobeable')
        self.assertLessEqual(res['probe_read']['total_bytes_read'], sum(RQ.probe_limits(size)))

    def test_a_short_file_failing_at_its_size_without_exhaustion_keeps_the_decoders_error(self):
        size = 20 * MIB
        rig = Rig(self, size=size, need=size + 10 * MIB)               # no re-read: the last attempt reads the whole file and ends without using its limit up
        res = rig.probe()
        out = json.loads(res['output'])
        self.assertEqual(res['probe_read']['final'], 'failed')
        self.assertIn('Stream ends prematurely', out['stderr'])               # ffprobe's own text, because this attempt did not use its limit up
        self.assertIn("ffprobe's own", out['probe_read']['note'])
        self.assertEqual([a['stopped_by_input_limit'] for a in out['probe_read']['attempts']], [True, True, False])

    def test_the_typed_layer_keeps_the_note_and_does_not_call_a_cut_damage(self):
        from media_repair_harness import evidence_v2 as EV2
        size = 20 * MIB
        rig = Rig(self, size=size, need=size + 10 * MIB, reread=True)
        res = rig.probe()
        obs = EV2.make_observation('t1', 'ffprobe', {}, res['status'], res['output'], 'remote', 'tool')
        text = json.dumps(obs, sort_keys=True)
        self.assertIn('could not be probed with the whole file readable', text)
        self.assertNotIn('container_damage', text)

    def test_chapters_keep_the_8_mib_default(self):
        rig = Rig(self, size=60_000_000, need=20_000_000)
        receipt_, _out, err = R2.run_remote(rig.ctx, 'chapters')
        self.assertEqual((receipt_['input_quota_bytes'], len(rig.ctx.remote_binding.receipts)), (8 * MIB, 1))

    def test_the_run_config_names_the_probe_rule(self):
        self.assertEqual(R2.config()['probe_limit'], RQ.PROBE_PARAMETERS)
        self.assertEqual(RQ.PROBE_PARAMETERS['start_bytes'], 8 * MIB)


class Discovery(unittest.TestCase):
    """series_scan discover: the per-file probe is adaptive under v3-remote-2 (the default) and the fixed 8 MiB under v3-remote-1."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp, ignore_errors=True))
        self.root = self.tmp / 'mnt'
        self.series = self.root / 'tv' / 'Example Show (2001)'
        s1 = self.series / 'Season 1'
        self.names = {'ok': 'Example Show (2001) - S01E01 - Fine.mkv', 'big': 'Example Show (2001) - S01E02 - Big Header.mkv',
                      'whole': 'Example Show (2001) - S01E03 - Never.mkv'}
        H2.sparse_media(s1 / self.names['ok'], 30 * MIB, probe_need_bytes=2_000_000)
        H2.sparse_media(s1 / self.names['big'], 40 * MIB, probe_need_bytes=12 * MIB)
        H2.sparse_media(s1 / self.names['whole'], 20 * MIB, probe_need_bytes=30 * MIB, reread=True)
        self.pod = pod()

    def discover(self, out, *extra):
        a = ['discover', '--target', 'media/bazarr/app', '--root', str(self.root), '--series-dir', str(self.series), '--out', str(out), '--allow-in-git', '--season', '1']
        return quiet(S.main, a + list(extra), runner=self.pod)

    def load(self, out):
        d = json.loads((out / 'discovery.json').read_text())
        return d, {Path(f['path']).name: f for f in d['files']}, json.loads((out / 'discovery-receipts.json').read_text())

    def test_v3_remote_2_probes_adaptively_and_records_every_attempt(self):
        out = self.tmp / 'o2'
        self.assertEqual(self.discover(out), 0)                                      # the default tools behaviour is v3-remote-2
        d, rows, ops = self.load(out)
        self.assertEqual((d['tools_behavior'], d['probe_limit']['rule']), ('v3-remote-2', 'adaptive-probe-1'))
        # a probe that needed no more than 8 MiB: one attempt, the evidence exactly the probe result
        ok = rows[self.names['ok']]
        self.assertEqual(ok['probe']['status'], 'ok')
        self.assertNotIn('probe_read', json.loads(ok['probe']['output']))
        self.assertEqual([a['quota_bytes'] for a in ok['probe_read']['attempts']], [8 * MIB])
        # a probe that needed 12 MiB: 8 MiB cut, 16 MiB succeeded, labelled as a read limit
        big = rows[self.names['big']]
        self.assertEqual(big['probe']['status'], 'ok')
        self.assertEqual([(a['quota_bytes'], a['quota_exhausted'], a['outcome']) for a in big['probe_read']['attempts']],
                         [(8 * MIB, True, 'failed_quota_exhausted'), (16 * MIB, False, 'ok')])
        self.assertEqual((big['probe_read']['final'], big['probe_read']['succeeded_quota_bytes']), ('ok', 16 * MIB))
        shown = json.loads(big['probe']['output'])
        self.assertIn('streams', shown)
        self.assertIn('a limit of the read', shown['probe_read']['note'])
        self.assertNotIn('Stream ends prematurely at', big['probe']['output'])
        # a file that cannot be probed with the whole file readable
        whole = rows[self.names['whole']]
        self.assertEqual(whole['probe']['status'], 'error')
        self.assertEqual(whole['probe_read']['final'], 'whole_file_unprobeable')
        self.assertEqual([a['quota_bytes'] for a in whole['probe_read']['attempts']], [8 * MIB, 16 * MIB, 20 * MIB])
        self.assertIn('could not be probed with the whole file readable', whole['probe']['output'])
        self.assertNotIn('Stream ends prematurely at', whole['probe']['output'])
        # discovery-receipts.json: one entry per attempt, each with its limit, bytes read, exhausted flag and outcome; the receipts keep the decoder's text
        probes = [o for o in ops if o['mode'] == 'probe']
        self.assertEqual(len(probes), 1 + 2 + 3)
        for o in probes:
            self.assertEqual(o['receipt']['receipt'], 'mrh-sampler-4')
            self.assertEqual(o['probe_attempt']['quota_bytes'], o['receipt']['input_quota_bytes'])
            self.assertEqual((o['probe_attempt']['bytes_read'], o['probe_attempt']['quota_exhausted']), (o['receipt']['bytes_read'], o['receipt']['quota_exhausted']))
            self.assertIn(o['probe_attempt']['outcome'], RQ.PROBE_OUTCOMES)
        self.assertTrue(any('prematurely' in o['receipt']['stderr'] for o in probes))
        self.assertEqual([o['receipt']['receipt'] for o in ops if o['mode'] in ('list', 'stat')], ['mrh-sampler-2'] * len([1 for o in ops if o['mode'] in ('list', 'stat')]))

    def test_v3_remote_1_keeps_the_fixed_8_mib_probe(self):
        out = self.tmp / 'o1'
        self.assertEqual(self.discover(out, '--tools-behavior', 'v3-remote-1'), 0)
        d, rows, ops = self.load(out)
        self.assertEqual(d['tools_behavior'], 'v3-remote-1')
        probes = [o for o in ops if o['mode'] == 'probe']
        self.assertEqual(len(probes), 3)
        self.assertTrue(all(o['receipt']['receipt'] == 'mrh-sampler-2' and 'probe_attempt' not in o for o in probes))
        big = rows[self.names['big']]
        self.assertEqual(big['probe']['status'], 'error')
        self.assertNotIn('probe_read', big)
        self.assertIn('Stream ends prematurely at', big['probe']['output'])

    def test_the_built_case_carries_the_labelled_probe_as_its_first_evidence(self):
        out = self.tmp / 'o3'
        self.assertEqual(self.discover(out), 0)
        code = quiet(S.main, ['build', '--discovery', str(out / 'discovery.json'), '--out', str(out), '--allow-in-git'])
        self.assertEqual(code, 0)
        cases = {json.loads(p.read_text())['context']['title']: json.loads(p.read_text()) for p in (out / 'suite' / 'cases').glob('*.json')}
        ev = cases['Example Show S01E02']['evidence'][0]
        self.assertEqual((ev['id'], ev['tool'], ev['status']), ('e1', 'ffprobe', 'ok'))
        self.assertIn('probe_read', json.loads(ev['output']))


if __name__ == '__main__':
    unittest.main()
