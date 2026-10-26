"""llama-server transport (#209): HTTP to the pod's own 127.0.0.1:8080 through `kubectl exec`, the way `ollama_transport` reaches Ollama Prime.

The target is fixed: namespace `ai`, `deploy/llama-server`, container `app` (read from `kubectl get deploy -n ai llama-server -o yaml`, 2026-10-26: one
container named `app`, `--port 8080`, `--alias muse-glimmer-30b`).  Nothing here takes a target from a caller, so a run cannot exec into any other pod.
The request travels over bash's `/dev/tcp` exactly as the Ollama transport does: it needs `bash`, `timeout`, `printf` and `cat` in the image and no HTTP
client (UNVERIFIED for the image `ghcr.io/ggml-org/llama.cpp:server-cuda-b11096`: this story does not exec into a GPU pod; the preflight reports a
transport failure by name and refuses the run).  Stdlib only.
"""
import http.client
import json
import subprocess
import time

from .ollama_transport import SocketBytes

NAMESPACE = 'ai'
TARGET = 'deploy/llama-server'
CONTAINER = 'app'
PORT = 8080
# the only paths this harness sends: the readiness probe, the server properties, the model list and the chat completion
ALLOWED = ('/health', '/props', '/v1/models', '/v1/chat/completions')


def prefix(interactive=False):
    cmd = ['kubectl', '-n', NAMESPACE, 'exec']
    if interactive:
        cmd.append('-i')
    return cmd + [TARGET, '-c', CONTAINER, '--']


def script(method, path, length):
    """The remote shell program.  Only fixed protocol strings and a numeric length enter it; the payload travels on stdin and is printed literally."""
    assert path in ALLOWED, path
    assert method in ('GET', 'POST'), method
    return ("body=$(cat); exec 3<>/dev/tcp/127.0.0.1/" + str(PORT) + "; "
            "printf '%s\\r\\n' '" + method + ' ' + path + " HTTP/1.1' 'Host: localhost' "
            "'Content-Type: application/json' 'Connection: close' "
            "'Content-Length: " + str(int(length)) + "' '' >&3; "
            "printf '%s' \"$body\" >&3; cat <&3")


def api(path, payload=None, timeout=60, runner=subprocess.run):
    """Return (parsed_json_or_None, receipt).  Never raises on transport trouble.  The receipt carries `http_status` and `raw_body` for a parsed HTTP response
    (a 503 while the model loads and a 4xx error body included), else the exit code and what was captured."""
    assert path in ALLOWED, path
    assert isinstance(timeout, int) and 1 <= timeout <= 900
    body = json.dumps(payload, separators=(',', ':')).encode() if payload is not None else b''
    method = 'POST' if payload is not None else 'GET'
    started = time.monotonic()
    cmd = prefix(True) + ['timeout', str(timeout), 'bash', '-c', script(method, path, len(body))]
    try:
        run = runner(cmd, input=body, capture_output=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired as error:
        return None, {'wall_seconds': time.monotonic() - started, 'exit_code': 'local_timeout', 'stderr': (error.stderr or b'').decode(errors='replace'),
                      'partial_http': (error.stdout or b'').decode(errors='replace')}
    except OSError as error:
        return None, {'wall_seconds': time.monotonic() - started, 'exit_code': 'spawn_error', 'stderr': str(error)}
    receipt = {'wall_seconds': time.monotonic() - started, 'exit_code': run.returncode, 'stderr': run.stderr.decode(errors='replace')}
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
