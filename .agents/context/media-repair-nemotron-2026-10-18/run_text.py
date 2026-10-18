"""One frozen serial TEXT-only matrix. No pull, live media, repair, or retries."""
import datetime
import hashlib
import json
import re
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'media-repair-benchmark-2026-10-18'))
import ollama_matrix as runtime


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def resources():
    extra = subprocess.run(runtime.PREFIX + ['bash', '-c',
        'cat /sys/fs/cgroup/memory.stat /sys/fs/cgroup/memory.events; '
        'for f in /proc/[0-9]*/cmdline; do read -r comm < "${f%cmdline}comm" 2>/dev/null || continue; case "$comm" in llama-server|ollama) tr "\\0" " " < "$f"; printf "\\n";; esac; done'],
        capture_output=True, text=True, timeout=15)
    return dict(snapshot=runtime.snapshot(), extra=extra.stdout, extra_exit=extra.returncode)


def values(snapshot):
    output = snapshot['snapshot']['stdout'].splitlines()
    gpu = next(x.split(',') for x in output if x.startswith(runtime.GPU))
    used, free = (int(v.strip().split()[0]) for v in gpu[1:3])
    current = next(int(x) for x in output if x.isdigit())
    available = next(int(x.split()[1])*1024 for x in output if x.startswith('MemAvailable:')) if any(x.startswith('MemAvailable:') for x in output) else None
    # The legacy snapshot reads first3 meminfo lines, including MemAvailable.
    stats = {}
    for line in snapshot['extra'].splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            stats[parts[0]] = int(parts[1])
    return dict(gpu_used_mib=used, gpu_free_mib=free, cgroup_current=current,
                cgroup_noninactive=current-stats.get('inactive_file', 0), host_available=available,
                oom_kill=stats.get('oom_kill'), oom=stats.get('oom'))


def healthy(snapshot, idle=False):
    if snapshot['snapshot']['exit_code'] or snapshot['extra_exit']:
        return False
    v = values(snapshot)
    if v['host_available'] is None or v['oom_kill'] is None or v['oom'] is None or v['oom_kill'] or v['oom']:
        return False
    if idle:
        return (not snapshot['snapshot']['compute_processes'] and
                snapshot['snapshot']['compute_query_exit'] == 0 and
                v['gpu_free_mib'] >= 23000 and v['host_available'] >= 64*2**30 and
                v['cgroup_noninactive'] <= 8*2**30)
    return (v['gpu_used_mib'] <= 21500 and v['cgroup_noninactive'] <= 40*2**30
            and v['host_available'] >= 48*2**30)


def main():
    for name, digest in read(ROOT / 'text-freeze.json').items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
    import suites
    suites.verify(read(ROOT / 'suites.json'))
    protocol = read(ROOT / 'text-protocol.json')
    assert protocol['options']['num_thread'] == 2
    completion = read(ROOT / 'original-pull-completion.json')
    assert completion['status'] == 'original_server_pull_committed_after_client_timeout'
    assert completion['pull_invocations'] == 1 and not completion['second_pull_sent']
    assert read(ROOT / 'checksums.json')['verified_all_layers_and_config']
    out = ROOT / 'text-runs'
    out.mkdir(exist_ok=False)
    documentary = [json.loads(x) for x in (ROOT.parent / 'media-repair-benchmark-2026-10-18/results/requests.jsonl').read_text().splitlines()]
    av = read(ROOT / 'text-cases.json')
    cases = [('documentary', c['request_id'], c) for c in documentary] + [('av', c['case_id'], c) for c in av]
    assert len(cases) == 14
    total = 0
    for model in protocol['models']:
        tags, _ = runtime.api('/api/tags')
        resident, rr = runtime.api('/api/ps')
        before = resources()
        folder = out / model.split(':')[0]
        folder.mkdir()
        save(folder / 'preflight.json', dict(tags=tags, resident=resident, receipt=rr, resources=before))
        assert resident is not None and not resident['models'] and healthy(before, idle=True), 'Unsafe idle gate; no eviction'
        installed = next(m for m in tags['models'] if m['name'] == model)
        runtime.verify_manifest(installed, folder)
        if model.startswith('nemotron'):
            assert installed['digest'] == 'd6d3deeca27134af015d1ab4d57ee655dd6d624dbef4f5dfd18f4b54f76bb554'
        shown, shown_receipt = runtime.api('/api/show', {'model':model})
        save(folder / 'model.json', dict(installed=installed, show=shown, receipt=shown_receipt))
        for kind, cid, packet in cases:
            resident, _ = runtime.api('/api/ps')
            assert resident is not None and all(m['name'] == model for m in resident['models']), 'Owner changed'
            body = dict(model=model, stream=False, think=False, keep_alive=protocol['keep_alive'],
                        format=protocol[kind+'_schema' if kind == 'documentary' else 'av_schema'],
                        options=dict(protocol['options'], stop=protocol['stops'][model]),
                        messages=[dict(role='system', content=protocol[kind+'_system' if kind == 'documentary' else 'av_system']),
                                  dict(role='user', content=json.dumps(packet, sort_keys=True))])
            assert all('images' not in m for m in body['messages'])
            pre = resources()
            assert healthy(pre), 'Pre-request resource gate'
            response, receipt = runtime.api('/api/chat', body)
            total += 1
            after = resources()
            active, active_receipt = runtime.api('/api/ps')
            row = dict(model=model, kind=kind, case_id=cid, request=body,
                       response=response, receipt=receipt, before=pre, after=after,
                       observed=values(after), resident=active, resident_receipt=active_receipt, at=datetime.datetime.now(datetime.timezone.utc).isoformat())
            save(folder / (cid+'.json'), row)
            save(out / 'progress.json', dict(at=row['at'], calls=total, latest=model+'/'+cid))
            print(model, cid, receipt.get('http_status'), response.get('message') if response else None, flush=True)
            if response is None or receipt.get('http_status') != 200 or response.get('error'):
                save(out / 'stop.json', dict(reason='Transport_or_runtime_failure_no_retry', model=model, case_id=cid))
                return  # Uncertain transport: no replay/unload against active request.
            if not healthy(after) or (cid == 'c01' and not re.search(r'(?:^|\s)(?:-t|--threads)\s+2(?:\s|$)', after['extra'])):
                save(out / 'stop.json', dict(reason='Resource_or_thread_bound_stop', model=model, case_id=cid))
                runtime.api('/api/generate', {'model':model, 'keep_alive':0})
                return
        _, receipt = runtime.api('/api/generate', {'model':model, 'keep_alive':0})
        save(folder / 'unload.json', receipt)
        # Bounded idle observations; never retry a load or evict a retiring owner.
        for _ in range(6):
            time.sleep(2)
            resident, _ = runtime.api('/api/ps')
            idle = resources()
            if resident is not None and not resident['models'] and healthy(idle, idle=True):
                break
        save(folder / 'final-idle.json', dict(resident=resident, resources=idle))
        assert resident is not None and not resident['models'] and healthy(idle, idle=True), 'No idle transition'
    save(out / 'complete.json', dict(calls=total, condition='shared_text_only', models=protocol['models']))


if __name__ == '__main__':
    main()
