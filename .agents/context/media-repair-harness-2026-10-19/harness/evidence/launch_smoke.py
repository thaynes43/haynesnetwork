"""Run live_smoke.py once as a CPU-limited batch Job in namespace dev, store its records, delete the Job.

    python3 launch_smoke.py --out <testdata/live-smoke dir> [--image ghcr.io/home-operations/bazarr:1.6.2] [--cpu 1]

The Job image only has to supply python3 and ffmpeg/ffprobe (the Bazarr image does).  The package is shipped inside the Job spec as a
base64 tarball, so no ConfigMap is needed.  Limits: cpu <= 2, memory 1Gi, emptyDir scratch 2Gi, 10 minute deadline, no service account
token, restricted pod security.  Only `kubectl` verbs the dev-env operator role allows are used (apply/get/logs/delete of a Job).
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
BEGIN, END = '===MRH-EVIDENCE-SMOKE-BEGIN===', '===MRH-EVIDENCE-SMOKE-END==='
PACKAGE_FILES = ['__init__.py', 'core.py', 'avtools.py', 'epubtool.py', 'live_smoke.py']
NS = 'dev'


def bundle():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        for name in PACKAGE_FILES:
            t.add(HERE / name, arcname='evidence/' + name, filter=lambda ti: (setattr(ti, 'uid', 0), setattr(ti, 'gid', 0), setattr(ti, 'mtime', 0), ti)[3])
    return base64.b64encode(buf.getvalue()).decode()


BOOT = ("import base64,io,os,sys,tarfile;"
        "tarfile.open(fileobj=io.BytesIO(base64.b64decode(os.environ['MRH_BUNDLE'])),mode='r:gz').extractall('/work');"
        "os.execvp('python3',['python3','/work/evidence/live_smoke.py'])")


def manifest(name, image, cpu):
    return {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': name, 'namespace': NS, 'labels': {'app': 'mrh-evidence-smoke'}},
            'spec': {'ttlSecondsAfterFinished': 900, 'backoffLimit': 0, 'activeDeadlineSeconds': 600,
                     'template': {'metadata': {'labels': {'app': 'mrh-evidence-smoke'}},
                                  'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                                           'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'}},
                                           'containers': [{'name': 'smoke', 'image': image, 'command': ['python3', '-c', BOOT],
                                                           'env': [{'name': 'MRH_BUNDLE', 'value': bundle()}, {'name': 'TMPDIR', 'value': '/work'}],
                                                           'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                                                           'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'},
                                                                         'limits': {'cpu': str(cpu), 'memory': '1Gi', 'ephemeral-storage': '2Gi'}},
                                                           'volumeMounts': [{'name': 'work', 'mountPath': '/work'}]}],
                                           'volumes': [{'name': 'work', 'emptyDir': {'sizeLimit': '2Gi'}}]}}}}


def kubectl(*args, input=None, check=True):
    r = subprocess.run(['kubectl', '-n', NS] + list(args), input=input, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit('kubectl %s failed: %s' % (' '.join(args), r.stderr[-600:]))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--image', default='ghcr.io/home-operations/bazarr:1.6.2')
    ap.add_argument('--cpu', type=float, default=1)
    ap.add_argument('--keep-job', action='store_true')
    a = ap.parse_args()
    if a.cpu > 2:
        raise SystemExit('cpu limit above 2 refused')
    name = 'mrh-evidence-smoke-%d' % int(time.time())
    kubectl('apply', '-f', '-', input=json.dumps(manifest(name, a.image, a.cpu)))
    print('applied', name, file=sys.stderr)
    try:
        deadline = time.time() + 660
        status = None
        while time.time() < deadline:
            r = kubectl('get', 'job', name, '-o', 'jsonpath={.status.succeeded}/{.status.failed}', check=False)
            if r.stdout.startswith('1/') or r.stdout.endswith('/1'):
                status = r.stdout
                break
            time.sleep(5)
        print('job status (succeeded/failed):', status, file=sys.stderr)
        logs = kubectl('logs', 'job/' + name, '--tail=-1', check=False).stdout
        pod = kubectl('get', 'pods', '-l', 'job-name=' + name, '-o', 'jsonpath={.items[0].metadata.name}', check=False).stdout
        image_id = kubectl('get', 'pod', pod, '-o', 'jsonpath={.status.containerStatuses[0].imageID}', check=False).stdout if pod else ''
        if BEGIN not in logs or END not in logs:
            (Path(a.out).parent / 'smoke-failed.log').write_text(logs[-4000:])
            raise SystemExit('no records in the Job log (tail saved to smoke-failed.log)')
        doc = json.loads(logs.split(BEGIN, 1)[1].split(END, 1)[0])
        doc['job'] = {'name': name, 'image': a.image, 'image_id': image_id, 'cpu_limit': a.cpu, 'memory_limit': '1Gi', 'namespace': NS}
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        results = doc.pop('results')
        (out / 'RUN.json').write_text(json.dumps(doc, indent=1, sort_keys=True) + '\n')
        for label, recs in results.items():
            fname = label.replace('/', '').replace('#', '--') + '.records.json'
            (out / fname).write_text(json.dumps({'label': doc['label'], 'fixture': label, 'records': recs}, indent=1, sort_keys=True) + '\n')
        rows = ['| fixture | tool | status | cause | mode | what the record says |', '|---|---|---|---|---|---|']
        for label, recs in results.items():
            for r in recs:
                o = r.get('output') or {}
                note = '; '.join((o.get('findings') or []) if isinstance(o.get('findings'), list) and o.get('findings') and isinstance(o['findings'][0], str)
                                 else [f['what'] for f in o.get('findings', [])] if o.get('findings') else [])
                note = note or r.get('reason') or ''
                rows.append('| `%s` | %s | %s | %s | %s | %s |' % (label, r['tool'], r['status'], r.get('cause', ''), r['mode'], note.replace('|', '/')[:160]))
        head = ['# Live smoke records', '', doc['label'] + '.', '',
                'Image `%s` (`%s`), ffmpeg/ffprobe: %s. Python %s. Tesseract: %s.' % (a.image, doc['job']['image_id'], doc['ffmpeg'], doc['python'], doc['tesseract']),
                'Job limits: cpu %s, memory 1Gi, ephemeral 2Gi; the Job was deleted after the records were read. Fixtures are generated inside the Job and are not committed (names, sizes and sha256 are in `RUN.json`).' % a.cpu, '']
        (out / 'SUMMARY.md').write_text('\n'.join(head + rows) + '\n')
        print('wrote', len(results), 'record files to', out, file=sys.stderr)
    finally:
        if not a.keep_job:
            kubectl('delete', 'job', name, '--ignore-not-found', '--wait=false', check=False)
            print('deleted', name, file=sys.stderr)


if __name__ == '__main__':
    main()
