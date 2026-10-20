import json
import subprocess
import threading
import unittest

from media_repair_harness import adapters as A
from media_repair_harness import guard as G
from media_repair_harness import ollama_transport as ot
import th
from media_repair_harness import tools as T
from test_adapters import FakeOllama, snapshot


POD = {'name': 'ollama-prime-x', 'uid': 'u1', 'restarts': 1, 'container_id': 'c1'}


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make_guard(stalls, pods=None, **kw):
    clock = Clock()
    stalls, pods = list(stalls), list(pods or [POD] * len(stalls))

    def read_stall():
        v = stalls.pop(0)
        if isinstance(v, Exception):
            raise v
        return v
    g = G.PsiGuard(read_stall=read_stall, read_pod=lambda: pods.pop(0), clock=clock, **kw)
    return g, clock


def step(g, clock, dt=30.0):
    clock.t += dt
    return g.sample()


class Parsing(unittest.TestCase):
    def test_full_total_is_microseconds(self):
        text = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=70000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=67112\n'
        self.assertAlmostEqual(G.parse_full_total_s(text), 0.067112)
        with self.assertRaises(ValueError):
            G.parse_full_total_s('some total=1\n')

    def test_pod_identity(self):
        raw = json.dumps({'items': [{'metadata': {'name': 'p', 'uid': 'u'}, 'status': {'containerStatuses': [
            {'name': 'app', 'restartCount': 1, 'containerID': 'containerd://x'}]}}]})
        self.assertEqual(G.parse_pod_identity(raw)['restarts'], 1)
        with self.assertRaises(ValueError):
            G.parse_pod_identity(json.dumps({'items': []}))


class Trip(unittest.TestCase):
    def test_quiet_run_does_not_trip(self):
        g, c = make_guard([0, 0.01, 0.02, 0.03])
        for _ in range(4):
            step(g, c)
        self.assertIsNone(g.tripped)
        self.assertFalse(g.cancel.is_set())
        self.assertLess(g.summary()['max_rate'], 0.01)

    def test_one_high_sample_is_tolerated_two_trip(self):
        g, c = make_guard([0, 12, 12.1, 24, 36])  # 0.4/s, ~0, 0.4/s, 0.4/s
        step(g, c)
        step(g, c)
        step(g, c)
        self.assertIsNone(g.tripped)  # high, low, resets the streak
        step(g, c)
        self.assertIsNone(g.tripped)
        step(g, c)
        self.assertIn('memory PSI', g.tripped)
        self.assertTrue(g.cancel.is_set())

    def test_exactly_threshold_does_not_count(self):
        g, c = make_guard([0, 6, 12, 18])  # 0.20/s each
        for _ in range(4):
            step(g, c)
        self.assertIsNone(g.tripped)

    def test_restart_count_change_trips(self):
        g, c = make_guard([0, 0], pods=[POD, dict(POD, restarts=2)])
        step(g, c)
        step(g, c)
        self.assertIn('restarts', g.tripped)

    def test_new_pod_uid_trips(self):
        g, c = make_guard([0, 0], pods=[POD, dict(POD, uid='u2')])
        step(g, c)
        step(g, c)
        self.assertIn('uid', g.tripped)

    def test_blind_samples_trip_after_three(self):
        e = RuntimeError('kubectl down')
        g, c = make_guard([0, e, e, e])
        for _ in range(4):
            step(g, c)
        self.assertIn('blind', g.tripped)

    def test_interval_is_capped_at_30s(self):
        with self.assertRaises(AssertionError):
            G.PsiGuard(interval=31)


class AdapterWithGuard(unittest.TestCase):
    def make(self, fake, guard, **kw):
        return A.OllamaAdapter('qwen3.8:27b', api=fake, snapshot=snapshot(''), guard=guard, **kw)

    def test_trip_before_case_aborts_and_unloads(self):
        g, c = make_guard([0, 0, 0], pods=[POD, POD, dict(POD, restarts=2)])
        fake = FakeOllama()

        def api(path, payload=None, timeout=60, cancel=None):
            return fake(path, payload, timeout)
        ad = self.make(api, g)
        ad.preflight()
        step(g, c)
        step(g, c)
        with self.assertRaises(A.AbortRun):
            ad.before_case()
        rep = ad.finish()
        self.assertTrue(rep['unloaded'])
        self.assertEqual(rep['psi_guard']['tripped'], g.tripped)

    def test_trip_during_chat_is_a_failed_case_not_a_lost_one(self):
        g, c = make_guard([0, 0, 0], pods=[POD, POD, dict(POD, restarts=2)])
        fake = FakeOllama()
        n = {'chat': 0}

        def api(path, payload=None, timeout=60, cancel=None):
            if path == '/api/chat':
                step(g, c)
                step(g, c)  # trips while the request is in flight
                return None, {'exit_code': 'cancelled'}
            return fake(path, payload, timeout)
        ad = self.make(api, g)
        ad.preflight()
        with self.assertRaises(A.AdapterError):
            ad.complete('s', [{'role': 'user', 'content': 'x'}])

    def test_trip_during_warmup_aborts_and_still_unloads(self):
        g, c = make_guard([0, 0, 0, 0], pods=[POD, POD, dict(POD, restarts=2), POD])
        fake = FakeOllama()

        def api(path, payload=None, timeout=60, cancel=None):
            if path == '/api/generate' and payload.get('keep_alive') != 0:
                step(g, c)
                step(g, c)
                return None, {'exit_code': 'cancelled'}
            return fake(path, payload, timeout)
        ad = self.make(api, g)
        with self.assertRaises(A.AbortRun):
            ad.preflight()
        self.assertTrue(ad.loaded_by_us)  # a guard stop unloads, unlike a timed-out load
        fake.residents = ['qwen3.8:27b']
        self.assertTrue(ad.finish()['unloaded'])

    def test_config_records_guard_and_limits(self):
        g, _ = make_guard([0])
        cfg = self.make(FakeOllama(), g).config()
        self.assertEqual(cfg['psi_guard']['threshold'], 0.20)
        self.assertEqual((cfg['warmup_timeout_s'], cfg['options']['use_mmap']), (900, False))


class Cancellable(unittest.TestCase):
    def test_cancel_kills_the_child(self):
        cancel = threading.Event()
        threading.Timer(0.5, cancel.set).start()
        with self.assertRaises(ot.CancelledByGuard):
            ot.run_cancellable(['sleep', '30'], b'', 60, cancel)

    def test_runs_to_completion_and_times_out(self):
        r = ot.run_cancellable(['cat'], b'hello', 10, threading.Event())
        self.assertEqual((r.returncode, r.stdout), (0, b'hello'))
        with self.assertRaises(subprocess.TimeoutExpired):
            ot.run_cancellable(['sleep', '30'], b'', 1, threading.Event())


class ToolOutputCap(unittest.TestCase):
    def test_lower_cap_bounds_and_marks_truncation(self):
        res = T.ToolResult('ok', 'x' * 5000).bounded(cap=1024)
        self.assertTrue(res['truncated'])
        self.assertLessEqual(len(res['output'].encode()), 1024)
        self.assertFalse(T.ToolResult('ok', 'x' * 500).bounded(cap=1024)['truncated'])


if __name__ == '__main__':
    unittest.main()
