"""Same native protocol through accepted temporary loopback Ollama0.40.6."""
import json,subprocess,time,http.client
from ollama_matrix import PREFIX,SocketBytes

def api_local(path, payload=None):
    assert path in ('/api/tags','/api/ps','/api/show','/api/chat','/api/generate')
    body = json.dumps(payload, separators=(',',':')).encode() if payload is not None else b''
    method = 'POST' if payload is not None else 'GET'
    # Only fixed protocol strings and numeric length enter shell code. Fixture data
    # travel on stdin and are printed literally, never evaluated or stored remotely.
    script = ("body=$(cat); exec 3<>/dev/tcp/127.0.0.1/11435; "
              "printf '%s\\r\\n' '"+method+' '+path+" HTTP/1.1' 'Host: localhost' "
              "'Content-Type: application/json' 'Connection: close' "
              "'Content-Length: "+str(len(body))+"' '' >&3; "
              "printf '%s' \"$body\" >&3; cat <&3")
    started = time.monotonic()
    try:
        run = subprocess.run(PREFIX[:4]+['-i']+PREFIX[4:]+['timeout','60','bash','-c',script],
                             input=body, capture_output=True, timeout=65)
    except subprocess.TimeoutExpired as error:
        return None, {'wall_seconds':time.monotonic()-started,'exit_code':'local_timeout',
                      'stderr':(error.stderr or b'').decode(errors='replace'),
                      'partial_http':(error.stdout or b'').decode(errors='replace')}
    receipt = {'wall_seconds':time.monotonic()-started,'exit_code':run.returncode,
               'stderr':run.stderr.decode(errors='replace')}
    if run.returncode:
        receipt['partial_http'] = run.stdout.decode(errors='replace')
        return None, receipt
    try:
        response = http.client.HTTPResponse(SocketBytes(run.stdout))
        response.begin()
        raw = response.read().decode()
    except (http.client.HTTPException, ValueError) as error:
        receipt.update(parse_error=str(error),partial_http=run.stdout.decode(errors='replace'))
        return None, receipt
    receipt.update(http_status=response.status, raw_body=raw)
    try:
        return json.loads(raw), receipt
    except ValueError:
        return None, receipt
