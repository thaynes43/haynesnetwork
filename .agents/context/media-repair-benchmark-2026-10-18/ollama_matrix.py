"""Explicitly authorized exact-model matrix via existing pod exec; no cluster writes.

Requires installed model, empty resident model set, expected GPU and corpus hash.
No download, service restart, global options change or foreign-model unload.
"""
import argparse
import datetime
import hashlib
import http.client
import io
import json
from pathlib import Path
import subprocess
import time
import bench

POD = 'ollama-prime-bc7bc7856-zgzjb'
GPU = 'GPU-6ff9702a-1b2c-6094-5a85-00aa1924c55a'
MODELS = ('qwen3.8:27b', 'muse-glimmer:30b')
CORPUS_SHA = '39fe6a985bea4c4ac31a6d497db132a846269f04c86381259ddaa56a023946a7'
PREFIX = ['kubectl','-n','ai','exec',POD,'-c','app','--']
OPTIONS = {'temperature':0, 'seed':42, 'num_ctx':4096, 'num_predict':256}


class SocketBytes:
    def __init__(self, data):
        self.data = data
    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.data)


def api(path, payload=None):
    assert path in ('/api/tags','/api/ps','/api/show','/api/chat','/api/generate')
    body = json.dumps(payload, separators=(',',':')).encode() if payload is not None else b''
    method = 'POST' if payload is not None else 'GET'
    # Only fixed protocol strings and numeric length enter shell code. Fixture data
    # travel on stdin and are printed literally, never evaluated or stored remotely.
    script = ("body=$(cat); exec 3<>/dev/tcp/127.0.0.1/11434; "
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


def snapshot():
    cmd = 'nvidia-smi --query-gpu=uuid,memory.used,memory.free,utilization.gpu --format=csv; nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv; cat /sys/fs/cgroup/memory.current; head -3 /proc/meminfo'
    result = subprocess.run(PREFIX+['sh','-c',cmd],capture_output=True,text=True,timeout=10)
    processes = subprocess.run(PREFIX+['nvidia-smi','--query-compute-apps=gpu_uuid,pid,process_name,used_memory','--format=csv,noheader'],capture_output=True,text=True,timeout=10)
    return {'compute_processes':processes.stdout.strip(), 'compute_query_exit':processes.returncode,
            'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',choices=MODELS,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args = parser.parse_args()
    assert bench.sha(bench.ROOT/'corpus.jsonl') == CORPUS_SHA, 'Frozen corpus changed'
    for path, expected_hash in json.loads((bench.ROOT/'protocol-hashes.json').read_text()).items():
        assert bench.sha(bench.ROOT/path) == expected_hash, 'Frozen protocol changed'
    frozen = {r['request_id']:r for r in (json.loads(line) for line in (bench.ROOT/'results/requests.jsonl').read_text().splitlines())}
    args.out.mkdir(parents=True,exist_ok=False)
    tags, tags_receipt = api('/api/tags')
    resident, resident_receipt = api('/api/ps')
    preflight = snapshot()
    bench.write_json(args.out/'preflight.json',{'tags':tags_receipt,'resident':resident_receipt,'resources':preflight})
    assert tags and resident is not None, 'API discovery failed'
    assert not resident.get('models'), 'Another model is resident; do not evict it'
    assert GPU in preflight['stdout'], 'Unexpected GPU'
    assert preflight['compute_query_exit']==0 and not preflight['compute_processes'], 'GPU has an existing compute owner'
    installed = next((m for m in tags['models'] if m['name']==args.model),None)
    assert installed, 'Exact model is not installed'
    name, tag = args.model.split(':')
    manifest = subprocess.run(PREFIX+['cat','/models/manifests/registry.ollama.ai/library/'+name+'/'+tag],
                              capture_output=True,check=True,timeout=10).stdout
    (args.out/'installed-manifest.json').write_bytes(manifest)
    assert 'sha256:'+hashlib.sha256(manifest).hexdigest() == installed['digest'], 'Installed manifest digest disagrees with API'
    shown, show_receipt = api('/api/show',{'model':args.model})
    assert shown and not shown.get('error'), 'Model details unavailable'
    bench.write_json(args.out/'model.json',{'installed':installed,'show':show_receipt,'options':OPTIONS,
                     'think':False,'format':'json','keep_alive':'2m','timeout_seconds':60})
    assert installed.get('details',{}).get('quantization_level') == 'Q4_K_M', 'Unexpected quantization'
    rows = []
    repairs = []
    stop = None
    for case in bench.load_cases():
        now_resident, _ = api('/api/ps')
        if now_resident is None or any(m['name'] != args.model for m in now_resident.get('models',[])):
            stop = 'resident_owner_changed_no_eviction'
            break
        visible = frozen[case['id']]
        assert visible == bench.detector_payload(case), 'Payload boundary changed'
        body = {'model':args.model,'stream':False,'think':False,'format':'json',
                'keep_alive':'2m','options':OPTIONS,
                'messages':[{'role':'system','content':(bench.ROOT/'prompt.txt').read_text()},
                            {'role':'user','content':json.dumps(visible,sort_keys=True)}]}
        before = snapshot()
        response, receipt = api('/api/chat',body)
        after = snapshot()
        raw = response.get('message',{}).get('content','') if response else ''
        try:
            parsed = json.loads(raw)
            decision = parsed.get('decision','error') if isinstance(parsed,dict) else 'error'
        except ValueError:
            decision = 'error'
        row = {'request_id':case['id'],'raw_response':raw,'decision':decision,
               'request':body,'response':receipt,'before':before,'after':after}
        rows.append(row)
        repairs.append({'request_id':case['id'], **bench.fixture_repair(case, decision, args.out/case['id'])})
        bench.write_json(args.out/'fixture-repairs.json',repairs)
        (args.out/'raw.jsonl').write_text(''.join(json.dumps(r,sort_keys=True)+'\n' for r in rows))
        print(json.dumps({'model':args.model,'request_id':case['id'],'decision':decision,
                          'wall_seconds':receipt['wall_seconds'],'error':response.get('error') if response else 'transport'}),flush=True)
        # A transport timeout can leave uncertain server work. Stop, do not retry or
        # unload while that request might still be running.
        if response is None or receipt.get('http_status') != 200 or response.get('error'):
            stop = 'transport_or_model_error_no_retry'
            break
    bench.write_json(args.out/'scores.json', bench.score(bench.load_cases(),{r['request_id']:r for r in rows}))
    bench.write_json(args.out/'run.json', {'model':args.model,'digest':installed['digest'],
                     'corpus_sha256':CORPUS_SHA,'attempted':len(rows),'stop':stop,
                     'model_triggered_reference_repair':{'correct':sum(r['correct'] for r in repairs),
                     'attempted':len(repairs),'oracle_candidate_selector':'deterministic_v1_evidence_tool',
                     'originals_preserved':all(r['original_preserved'] and r['active_copy_preserved'] for r in repairs),
                     'actual_media_repair':'not_run'}})
    # Only a model loaded by this successful matrix may be unloaded here.
    if stop is None:
        unloaded, unload_receipt = api('/api/generate',{'model':args.model,'keep_alive':0})
        bench.write_json(args.out/'unload.json', {'receipt':unload_receipt,'resources':snapshot()})
        print(json.dumps({'unloaded_own_model':args.model,'result':unloaded}),flush=True)


if __name__ == '__main__':
    main()
