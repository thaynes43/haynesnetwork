"""Ollama Prime transport: HTTP to the pod's own 127.0.0.1:11434 through `kubectl exec`.

Provenance: vendored and generalised from
  .agents/context/media-repair-benchmark-2026-10-18/ollama_matrix.py  (api, SocketBytes, snapshot)
  .agents/context/media-repair-nemotron-2026-10-18/local_api.py        (same protocol, other port)
(merged in PR #997 / #1002).  Changes: target is `deploy/ollama-prime` (pod names are ephemeral),
the per-call timeout is a parameter (model loads need longer than 60 s), `/api/version` is allowed,
and the kubectl prefix can be replaced for tests.  Stdlib only.  The FQDN / ClusterIP of the Service is
not reachable from the dev-env pod (egress policy); this is the authorised path.
"""
import datetime
import http.client
import io
import json
import subprocess
import time

NAMESPACE = 'ai'
TARGET = 'deploy/ollama-prime'
CONTAINER = 'app'
GPU = 'GPU-6ff9702a-1b2c-6094-5a85-00aa1924c55a'
ALLOWED = ('/api/tags', '/api/ps', '/api/show', '/api/chat', '/api/generate', '/api/version')


class SocketBytes:
    def __init__(self, data):
        self.data = data

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.data)


def prefix(interactive=False):
    cmd = ['kubectl', '-n', NAMESPACE, 'exec']
    if interactive:
        cmd.append('-i')
    return cmd + [TARGET, '-c', CONTAINER, '--']


def run_cancellable(cmd, body, timeout, cancel):
    """subprocess.run(input=body, capture_output=True, timeout=timeout) that also stops when `cancel` (a threading.Event) is set.
    Killing the local kubectl closes the exec stream, which closes the remote socket, so Ollama sees the client go away."""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout
    pending = body
    while True:
        try:
            out, err = proc.communicate(input=pending, timeout=1)
            return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
        except subprocess.TimeoutExpired:
            pending = None  # stdin was written by the first communicate(); never write twice
            if cancel.is_set() or time.monotonic() >= deadline:
                proc.kill()
                out, err = proc.communicate()
                if cancel.is_set():
                    raise CancelledByGuard(out, err)
                raise subprocess.TimeoutExpired(cmd, timeout, output=out, stderr=err)


class CancelledByGuard(Exception):
    def __init__(self, out=b'', err=b''):
        super().__init__('cancelled by guard')
        self.stdout, self.stderr = out, err


def api(path, payload=None, timeout=60, runner=subprocess.run, cancel=None):
    """Return (parsed_json_or_None, receipt).  Never raises on transport trouble.
    `cancel` (a threading.Event) lets the PSI guard kill an in-flight request; the receipt then says `cancelled`."""
    assert path in ALLOWED, path
    assert isinstance(timeout, int) and 1 <= timeout <= 900
    body = json.dumps(payload, separators=(',', ':')).encode() if payload is not None else b''
    method = 'POST' if payload is not None else 'GET'
    # Only fixed protocol strings and a numeric length enter the remote shell; the payload travels
    # on stdin and is printed literally, never evaluated or stored remotely.
    script = ("body=$(cat); exec 3<>/dev/tcp/127.0.0.1/11434; "
              "printf '%s\\r\\n' '" + method + ' ' + path + " HTTP/1.1' 'Host: localhost' "
              "'Content-Type: application/json' 'Connection: close' "
              "'Content-Length: " + str(len(body)) + "' '' >&3; "
              "printf '%s' \"$body\" >&3; cat <&3")
    started = time.monotonic()
    cmd = prefix(True) + ['timeout', str(timeout), 'bash', '-c', script]
    try:
        if cancel is not None:
            run = run_cancellable(cmd, body, timeout + 5, cancel)
        else:
            run = runner(cmd, input=body, capture_output=True, timeout=timeout + 5)
    except CancelledByGuard as error:
        return None, {'wall_seconds': time.monotonic() - started, 'exit_code': 'cancelled',
                      'stderr': (error.stderr or b'').decode(errors='replace'),
                      'partial_http': (error.stdout or b'').decode(errors='replace')}
    except subprocess.TimeoutExpired as error:
        return None, {'wall_seconds': time.monotonic() - started, 'exit_code': 'local_timeout',
                      'stderr': (error.stderr or b'').decode(errors='replace'),
                      'partial_http': (error.stdout or b'').decode(errors='replace')}
    except OSError as error:
        return None, {'wall_seconds': time.monotonic() - started, 'exit_code': 'spawn_error',
                      'stderr': str(error)}
    receipt = {'wall_seconds': time.monotonic() - started, 'exit_code': run.returncode,
               'stderr': run.stderr.decode(errors='replace')}
    if run.returncode:
        receipt['partial_http'] = run.stdout.decode(errors='replace')
        return None, receipt
    try:
        response = http.client.HTTPResponse(SocketBytes(run.stdout))
        response.begin()
        raw = response.read().decode()
    except (http.client.HTTPException, ValueError) as error:
        receipt.update(parse_error=str(error), partial_http=run.stdout.decode(errors='replace'))
        return None, receipt
    receipt.update(http_status=response.status, raw_body=raw)
    try:
        return json.loads(raw), receipt
    except ValueError:
        return None, receipt


def snapshot(runner=subprocess.run):
    """GPU / cgroup snapshot as in ollama_matrix.snapshot (read-only)."""
    cmd = ('nvidia-smi --query-gpu=uuid,memory.used,memory.free,utilization.gpu --format=csv; '
           'cat /sys/fs/cgroup/memory.current; head -3 /proc/meminfo')
    try:
        result = runner(prefix() + ['sh', '-c', cmd], capture_output=True, text=True, timeout=15)
        processes = runner(prefix() + ['nvidia-smi', '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
                                       '--format=csv,noheader'], capture_output=True, text=True, timeout=15)
    except (subprocess.TimeoutExpired, OSError) as error:
        return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'error': str(error),
                'compute_query_exit': 'error', 'compute_processes': '', 'stdout': ''}
    return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'compute_processes': processes.stdout.strip(), 'compute_query_exit': processes.returncode,
            'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
