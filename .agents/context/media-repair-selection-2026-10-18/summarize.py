"""Offline descriptive latency/resource summary; frozen evaluator remains unchanged."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
rows=[]
for p in sorted((ROOT/'runs').glob('*/r*/trace.json')):
 d=json.loads(p.read_text());gpu=[];ram=[]
 for turn in d['turns']:
  for key in ('before','after'):
   lines=turn[key]['stdout'].splitlines();gpu.append(int(lines[1].split(',')[1].strip().split()[0]))
   # cgroup memory.current follows the compute-app CSV block; find first scalar.
   ram.extend(int(line) for line in lines if line.isdigit())
 rows.append({'model':d['model'],'case_id':d['case_id'],'case_wall_seconds':d['wall_seconds'],'chat_wall_seconds':[t['receipt']['wall_seconds'] for t in d['turns']],'max_observed_gpu_mib':max(gpu),'max_observed_cgroup_ram_bytes':max(ram),'prompt_tokens':sum(t['response'].get('prompt_eval_count',0) for t in d['turns']),'generated_tokens':sum(t['response'].get('eval_count',0) for t in d['turns']),'server_load_ns':sum(t['response'].get('load_duration',0) for t in d['turns']),'server_prompt_ns':sum(t['response'].get('prompt_eval_duration',0) for t in d['turns']),'server_eval_ns':sum(t['response'].get('eval_duration',0) for t in d['turns'])})
(ROOT/'resource-summary.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows,indent=2))
