"""Memory-pressure (PSI) and pod-restart guard for local-model batches on Ollama Prime.

Why: on 2026-10-19 Talos's userspace OOM controller SIGKILLed the whole ollama-prime pod cgroup about 60 s into a cold
NFS load of qwen3.8:27b (container memory PSI 66% then 89%).  The batch therefore watches the pod's memory pressure
the whole time it holds the GPU, not only between cases, and stops (cancelling the in-flight request and unloading)
when the pressure stays high or when the pod restarted under us.

Source of the number.  The order asked for the Prometheus rate
  rate(container_pressure_memory_stalled_seconds_total{namespace="ai",pod=~"ollama-prime.*",container!=""}[1m])
but Prometheus is not reachable from the dev-env pod (egress allowlist; verified 2026-10-19).  That metric is cadvisor's
export of the container cgroup's memory.pressure `full` total, so the guard reads the same counter directly
(`kubectl exec ... cat /sys/fs/cgroup/memory.pressure`, a file read) and computes the rate between consecutive samples
(a window of one sampling interval, 30 s by default: stricter than the 1 m rate).

Trip rules: rate > threshold (0.20 stalled seconds per second) for `consecutive` (2) samples in a row; the pod's uid,
container id or restart count differs from the first sample; or `max_blind` (3) samples in a row could not be read
(never run a load blind).  A trip sets `cancel` (an Event the transport polls to kill the in-flight request) and records
the reason; the adapter turns it into AbortRun and unloads the model it loaded.
"""
import json
import subprocess
import threading
import time

NAMESPACE = 'ai'
SELECTOR = 'app.kubernetes.io/name=ollama-prime'
DEPLOY = 'deploy/ollama-prime'
CONTAINER = 'app'
PRESSURE_FILE = '/sys/fs/cgroup/memory.pressure'


def parse_full_total_s(text):
    """memory.pressure -> cumulative `full` stall in seconds (the file reports microseconds)."""
    for line in text.splitlines():
        if line.startswith('full '):
            for part in line.split():
                if part.startswith('total='):
                    return int(part[6:]) / 1e6
    raise ValueError('no "full ... total=" line in memory.pressure')


def read_stall_kubectl(runner=subprocess.run):
    r = runner(['kubectl', '-n', NAMESPACE, 'exec', DEPLOY, '-c', CONTAINER, '--', 'cat', PRESSURE_FILE],
               capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError('memory.pressure read failed: %s' % r.stderr.strip()[:200])
    return parse_full_total_s(r.stdout)


def parse_pod_identity(text):
    items = json.loads(text).get('items', [])
    if len(items) != 1:
        raise ValueError('expected one ollama-prime pod, found %d' % len(items))
    pod = items[0]
    statuses = pod.get('status', {}).get('containerStatuses', [])
    app = next((c for c in statuses if c.get('name') == CONTAINER), None)
    if app is None:
        raise ValueError('no %s container status' % CONTAINER)
    return {'name': pod['metadata']['name'], 'uid': pod['metadata']['uid'], 'restarts': app.get('restartCount'),
            'container_id': app.get('containerID')}


def read_pod_kubectl(runner=subprocess.run):
    r = runner(['kubectl', '-n', NAMESPACE, 'get', 'pods', '-l', SELECTOR, '-o', 'json'], capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError('pod read failed: %s' % r.stderr.strip()[:200])
    return parse_pod_identity(r.stdout)


class PsiGuard:
    def __init__(self, read_stall=read_stall_kubectl, read_pod=read_pod_kubectl, interval=30.0, threshold=0.20,
                 consecutive=2, max_blind=3, clock=time.monotonic, cancel=None):
        assert interval <= 30.0, 'the order caps the sampling interval at 30 s'
        self.read_stall, self.read_pod, self.interval = read_stall, read_pod, interval
        self.threshold, self.consecutive, self.max_blind, self.clock = threshold, consecutive, max_blind, clock
        self.cancel = cancel or threading.Event()
        self.samples, self.tripped = [], None
        self.baseline_pod = None
        self._prev = None  # (t, stall)
        self._high = 0
        self._blind = 0
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.Lock()

    def _trip(self, reason):
        if not self.tripped:
            self.tripped = reason
        self.cancel.set()

    def sample(self):
        """Take one sample; returns the record.  Never raises."""
        now = self.clock()
        rec = {'t': round(now, 3), 'rate': None, 'stall_s': None, 'restarts': None}
        try:
            stall = self.read_stall()
            pod = self.read_pod()
        except Exception as e:  # noqa: BLE001 - a blind sample is data, not a crash
            rec['error'] = str(e)[:200]
            with self._lock:
                self._blind += 1
                self.samples.append(rec)
                if self._blind >= self.max_blind:
                    self._trip('guard blind for %d consecutive samples (%s)' % (self._blind, rec['error']))
            return rec
        rec.update(stall_s=round(stall, 6), restarts=pod['restarts'], pod=pod['name'])
        with self._lock:
            self._blind = 0
            if self.baseline_pod is None:
                self.baseline_pod = pod
            else:
                for key in ('uid', 'container_id', 'restarts'):
                    if pod[key] != self.baseline_pod[key]:
                        self._trip('ollama-prime pod changed under the run: %s %r -> %r' % (key, self.baseline_pod[key], pod[key]))
            if self._prev is not None and now > self._prev[0]:
                rate = max(0.0, (stall - self._prev[1]) / (now - self._prev[0]))
                rec['rate'] = round(rate, 5)
                self._high = self._high + 1 if rate > self.threshold else 0
                if self._high >= self.consecutive:
                    self._trip('memory PSI %.3f stalled s/s > %.2f for %d consecutive samples' % (rate, self.threshold, self._high))
            self._prev = (now, stall)
            self.samples.append(rec)
        return rec

    def check(self):
        """Take a fresh sample if the last one is older than the interval, then return the trip reason (or None)."""
        if self.tripped:
            return self.tripped
        if not self.samples or self.clock() - self.samples[-1]['t'] >= self.interval:
            self.sample()
        return self.tripped

    def _loop(self):
        while not self._stop.wait(self.interval):
            self.sample()
            if self.tripped:
                return

    def start(self):
        self.sample()  # baseline now, so a trip can never be missed before the first interval
        self._thread = threading.Thread(target=self._loop, name='psi-guard', daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def summary(self):
        rates = [s['rate'] for s in self.samples if s.get('rate') is not None]
        return {'samples': len(self.samples), 'blind_samples': sum(1 for s in self.samples if s.get('error')),
                'max_rate': max(rates) if rates else None, 'threshold': self.threshold, 'interval_s': self.interval,
                'consecutive': self.consecutive, 'tripped': self.tripped, 'baseline_pod': self.baseline_pod,
                'source': 'cgroup memory.pressure full total via kubectl exec (Prometheus unreachable from this pod)'}
