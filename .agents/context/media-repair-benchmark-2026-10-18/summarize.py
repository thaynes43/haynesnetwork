"""Recompute aggregate model measurements from durable raw receipts, without calls."""
import json
from pathlib import Path
import bench


def summarize(path):
    if not path.exists():
        return {'status':'not_run','scores':None}
    run=json.loads((path/'run.json').read_text())
    rows=[json.loads(x) for x in (path/'raw.jsonl').read_text().splitlines()]
    latencies=[r['response']['wall_seconds'] for r in rows]
    gpu_used=[]
    cgroup_memory=[]
    native=[]
    for row in rows:
        body=row['response'].get('raw_body')
        if body:
            native.append(json.loads(body))
        for snapshot in (row['before'],row['after']):
            for line in snapshot['stdout'].splitlines():
                if line.startswith('GPU-'):
                    fields=line.split(',')
                    try:
                        gpu_used.append(int(fields[1].strip()))
                    except ValueError:
                        pass
                    break
            cgroup_memory.extend(int(line) for line in snapshot['stdout'].splitlines() if line.isdigit())
    repairs=json.loads((path/'fixture-repairs.json').read_text())
    return {'status':'complete' if run['stop'] is None and len(rows)==11 else 'partial_or_failed',
            'model':run['model'],'digest':run['digest'],'attempted':len(rows),'stop':run['stop'],
            'scores':bench.score(bench.load_cases(),{r['request_id']:r for r in rows}),
            'chat_wall_seconds_total':sum(latencies),'chat_wall_seconds_first':latencies[0] if latencies else None,
            'chat_wall_seconds_warm_mean':sum(latencies[1:])/len(latencies[1:]) if len(latencies)>1 else None,
            'prompt_tokens':sum(r.get('prompt_eval_count',0) for r in native),
            'generation_tokens':sum(r.get('eval_count',0) for r in native),
            'first_load_duration_ns':native[0].get('load_duration') if native else None,
            'max_observed_gpu_used_mib':max(gpu_used) if gpu_used else None,
            'max_observed_cgroup_memory_bytes':max(cgroup_memory) if cgroup_memory else None,
            'resource_sampling':'before_after_endpoints_not_peak_or_integrated_usage',
            'fixture_reference_repairs_correct':sum(r['correct'] for r in repairs),
            'all_original_fixture_bytes_preserved':all(r['original_preserved'] and r['active_copy_preserved'] for r in repairs),
            'actual_media_repair':'not_run', 'inference_api_cash_charge':'not_metered_local_endpoint'}


if __name__=='__main__':
    root=Path(__file__).resolve().parent
    summary={name:summarize(root/'models'/name) for name in ('qwen','muse')}
    bench.write_json(root/'model-summary.json',summary)
    print(json.dumps(summary,indent=2,sort_keys=True))
