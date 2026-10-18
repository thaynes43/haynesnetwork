"""Recompute aggregate model measurements from durable raw receipts, without calls."""
import json
from pathlib import Path
import bench


def summarize(path):
    if not path.exists():
        return {'status':'not_run','scores':None}
    run=json.loads((path/'run.json').read_text())
    cases=[c for c in bench.load_cases() if c['id'] in run.get('evaluation_cases',[x['id'] for x in bench.load_cases()])]
    rows=[json.loads(x) for x in (path/'raw.jsonl').read_text().splitlines()]
    latencies=[r['response']['wall_seconds'] for r in rows]
    gpu_used=[]
    cgroup_memory=[]
    native=[]
    server_cpu_usec=0
    for row in rows:
        body=row['response'].get('raw_body')
        if body:
            native.append(json.loads(body))
        cpu = lambda snapshot: next((int(line.split()[1]) for line in snapshot['stdout'].splitlines() if line.startswith('usage_usec ')), None)
        first,last=cpu(row['before']),cpu(row['after'])
        if first is not None and last is not None:server_cpu_usec += last-first
        for snapshot in (row['before'],row['after']):
            for line in snapshot['stdout'].splitlines():
                if line.startswith('GPU-'):
                    fields=line.split(',')
                    try:
                        gpu_used.append(int(fields[1].strip().split()[0]))
                    except ValueError:
                        pass
                    break
            cgroup_memory.extend(int(line) for line in snapshot['stdout'].splitlines() if line.isdigit())
    repairs=json.loads((path/'fixture-repairs.json').read_text())
    labels={c['id']:c['label'] for c in bench.load_cases()}
    return {'status':'complete' if run['stop'] is None and len(rows)==len(cases) else 'partial_or_failed',
            'model':run['model'],'digest':run['digest'],'attempted':len(rows),'stop':run['stop'],
            'scores':bench.score(cases,{r['request_id']:r for r in rows}),
            'chat_wall_seconds_total':sum(latencies),'chat_wall_seconds_first':latencies[0] if latencies else None,
            'chat_wall_seconds_warm_mean':sum(latencies[1:])/len(latencies[1:]) if len(latencies)>1 else None,
            'prompt_tokens':sum(r.get('prompt_eval_count',0) for r in native),
            'generation_tokens':sum(r.get('eval_count',0) for r in native),
            'first_load_duration_ns':native[0].get('load_duration') if native else None,
            'server_total_duration_ns':sum(r.get('total_duration',0) for r in native),
            'server_prompt_eval_duration_ns':sum(r.get('prompt_eval_duration',0) for r in native),
            'server_generation_duration_ns':sum(r.get('eval_duration',0) for r in native),
            'max_observed_gpu_used_mib':max(gpu_used) if gpu_used else None,
            'max_observed_cgroup_memory_bytes':max(cgroup_memory) if cgroup_memory else None,
            'server_cpu_seconds_during_calls':server_cpu_usec/1_000_000,
            'resource_sampling':'memory_before_after_endpoints_not_peak; CPU_cgroup_deltas_include_probe_overhead',
            'fixture_reference_repairs_correct':sum(r['correct'] for r in repairs),
            'positive_reference_repairs_correct':sum(r['correct'] for r in repairs if labels[r['request_id']]=='mismatch'),
            'control_references_correctly_unchanged':sum(r['correct'] for r in repairs if labels[r['request_id']]=='match'),
            'unnecessary_control_reference_changes':sum(r['operation']=='repoint' for r in repairs if labels[r['request_id']]=='match'),
            'all_original_fixture_bytes_preserved':all(r['original_preserved'] and r['active_copy_preserved'] for r in repairs),
            'actual_media_repair':'not_run', 'inference_api_cash_charge':'not_metered_local_endpoint'}


if __name__=='__main__':
    root=Path(__file__).resolve().parent
    summary={name:summarize(root/'models'/name) for name in ('qwen','muse','qwen-assisted','muse-assisted','muse-corrected','muse-serving-full')}
    bench.write_json(root/'model-summary.json',summary)
    print(json.dumps(summary,indent=2,sort_keys=True))
