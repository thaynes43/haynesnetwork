"""Run wiring_smoke.py once as a CPU-limited batch Job in namespace dev, store its output, delete the Job.

    python3 launch_wiring_smoke.py --out <dir> [--image ghcr.io/home-operations/bazarr:1.6.2] [--cpu 1]

Same Job shape and limits as evidence/launch_smoke.py (cpu <= 2, memory 1Gi, no service account token, restricted pod security, 10 minute
deadline); the harness modules it needs travel in the Job spec as a base64 tarball (kept under the 128 KiB single-argument limit).
"""
import argparse
import base64
import io
import json
import subprocess
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import launch_smoke as L  # noqa: E402

BEGIN, END = '===MRH-WIRING-SMOKE-BEGIN===', '===MRH-WIRING-SMOKE-END==='
PACKAGE = HERE.parent / 'src' / 'media_repair_harness'
FILES = ['__init__.py', 'adapters.py', 'audit.py', 'gaps.py', 'guard.py', 'leakguard.py', 'outcomes.py', 'protocol.py', 'remote_sampler.py', 'ollama_transport.py', 'run.py',
         'tools.py', 'vendored_epub.py', 'prompts/v2.txt', 'evidence/__init__.py', 'evidence/core.py', 'evidence/avtools.py', 'evidence/epubtool.py']
SMOKE_FILES = ['live_smoke.py', 'wiring_smoke.py']


def bundle():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        norm = lambda ti: (setattr(ti, 'uid', 0), setattr(ti, 'gid', 0), setattr(ti, 'mtime', 0), ti)[3]
        for name in FILES:
            t.add(PACKAGE / name, arcname='media_repair_harness/' + name, filter=norm)
        for name in SMOKE_FILES:
            t.add(HERE / name, arcname='smoke/' + name, filter=norm)
    data = base64.b64encode(buf.getvalue()).decode()
    assert len(data) < 120000, 'bundle too large for one environment string: %d' % len(data)
    return data


BOOT = ("import base64,io,os,tarfile;"
        "tarfile.open(fileobj=io.BytesIO(base64.b64decode(os.environ['MRH_BUNDLE'])),mode='r:gz').extractall('/work');"
        "os.execvp('python3',['python3','/work/smoke/wiring_smoke.py'])")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--image', default='ghcr.io/home-operations/bazarr:1.6.2')
    ap.add_argument('--cpu', type=float, default=1)
    a = ap.parse_args()
    if a.cpu > 2:
        raise SystemExit('cpu limit above 2 refused')
    name = 'mrh-wiring-smoke-%d' % int(time.time())
    m = L.manifest(name, a.image, a.cpu)
    c = m['spec']['template']['spec']['containers'][0]
    c['command'] = ['python3', '-c', BOOT]
    c['env'] = [{'name': 'MRH_BUNDLE', 'value': bundle()}, {'name': 'TMPDIR', 'value': '/work'}]
    m['metadata']['labels']['app'] = m['spec']['template']['metadata']['labels']['app'] = 'mrh-wiring-smoke'
    L.kubectl('apply', '-f', '-', input=json.dumps(m))
    print('applied', name, file=sys.stderr)
    try:
        deadline = time.time() + 660
        status = None
        while time.time() < deadline:
            r = L.kubectl('get', 'job', name, '-o', 'jsonpath={.status.succeeded}/{.status.failed}', check=False)
            if r.stdout.startswith('1/') or r.stdout.endswith('/1'):
                status = r.stdout
                break
            time.sleep(5)
        print('job status (succeeded/failed):', status, file=sys.stderr)
        logs = L.kubectl('logs', 'job/' + name, '--tail=-1', check=False).stdout
        pod = L.kubectl('get', 'pods', '-l', 'job-name=' + name, '-o', 'jsonpath={.items[0].metadata.name}', check=False).stdout
        image_id = L.kubectl('get', 'pod', pod, '-o', 'jsonpath={.status.containerStatuses[0].imageID}', check=False).stdout if pod else ''
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        if BEGIN not in logs or END not in logs:
            (out / 'wiring-smoke-failed.log').write_text(logs[-4000:])
            raise SystemExit('no records in the Job log (tail saved to wiring-smoke-failed.log)')
        doc = json.loads(logs.split(BEGIN, 1)[1].split(END, 1)[0])
        doc['job'] = {'name': name, 'image': a.image, 'image_id': image_id, 'cpu_limit': a.cpu, 'memory_limit': '1Gi', 'namespace': L.NS}
        (out / 'wiring-smoke.json').write_text(json.dumps(doc, indent=1, sort_keys=True) + '\n')
        print('wrote', out / 'wiring-smoke.json', file=sys.stderr)
    finally:
        L.kubectl('delete', 'job', name, '--ignore-not-found', '--wait=false', check=False)
        print('deleted', name, file=sys.stderr)


if __name__ == '__main__':
    main()
