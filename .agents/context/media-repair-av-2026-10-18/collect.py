"""Offline variant scoring/resource summaries via unchanged frozen assessor."""
import json
from pathlib import Path
import score
ROOT=Path(__file__).resolve().parent
truth={x['case_id']:x for x in json.loads((ROOT/'evaluator/truth.json').read_text())};cases={x['case_id']:x for x in json.loads((ROOT/'cases.json').read_text())};rows=[]
for variant in ['runs','runs-bounded']:
 for p in sorted((ROOT/variant).glob('*/a*.json')):
  d=json.loads(p.read_text());response=d.get('response') or {};raw=response.get('message',{}).get('content','')
  try:parsed=json.loads(raw)
  except ValueError:parsed=None
  result=score.assess(parsed,truth[d['case_id']],cases[d['case_id']]);gpu=[];ram=[]
  for name in ['before','after']:
   lines=d[name]['stdout'].splitlines();gpu.append(int(lines[1].split(',')[1].strip().split()[0]));ram.extend(int(x) for x in lines if x.isdigit())
  result.update(variant=variant,model=d['model'],case_id=d['case_id'],proposal=parsed,wall_seconds=d['receipt']['wall_seconds'],prompt_tokens=response.get('prompt_eval_count'),generated_tokens=response.get('eval_count'),done_reason=response.get('done_reason'),server_load_ns=response.get('load_duration'),server_prompt_ns=response.get('prompt_eval_duration'),server_eval_ns=response.get('eval_duration'),max_observed_gpu_mib=max(gpu),max_observed_cgroup_ram_bytes=max(ram));rows.append(result)
(ROOT/'variant-scores.json').write_text(json.dumps(rows,indent=2)+'\n')
for variant in ['runs','runs-bounded']:
 for model in ['qwen3.8:27b','muse-glimmer:30b']:
  rs=[r for r in rows if r['model']==model and r['variant']==variant]
  print(variant,model,'N',len(rs),'errors',sum(r['error'] for r in rs),'axes',{a:sum(r['axis_correct'].get(a,False) for r in rs) for a in score.AXES},'unsupported',[(r['case_id'],r['unsafe_or_unsupported']) for r in rs if r['unsafe_or_unsupported']])
