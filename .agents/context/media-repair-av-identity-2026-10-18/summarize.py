"""Offline descriptive resources, coverage and safety summaries, no model execution."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
scores=json.loads((ROOT/'scores.json').read_text());rows=[]
for variant in ['baseline','tool']:
 for model in ['qwen3.8:27b','muse-glimmer:30b']:
  rs=[x for x in scores if x['variant']==variant and x['model']==model];gpu=[];ram=[];server=[];unexpected=[]
  for r in rs:
   d=json.loads((ROOT/'runs'/variant/model.split(':')[0]/(r['case_id']+'.json')).read_text())
   for k in ['before','after']:
    lines=d[k]['stdout'].splitlines();gpu.append(int(lines[1].split(',')[1].strip().split()[0]));ram.extend(int(x) for x in lines if x.isdigit())
   response=d['response'];server.append({k:response.get(k) for k in ['load_duration','prompt_eval_duration','eval_duration','done_reason']});unexpected.append(bool(response.get('message',{}).get('tool_calls')))
  row={'variant':variant,'model':model,'n':len(rs),'axis_correct':{a:sum(x['axis_correct'].get(a,False) for x in rs) for a in ['identity','decode','compatibility']},'identity_non_abstain':sum(x['identity_covered'] for x in rs),'identity_abstentions':sum('identity' in x['abstentions'] for x in rs),'false_mismatch_on_matched_control':sum(x['false_mismatch'] for x in rs),'matched_control_denominator':1,'unsupported_assertion_cases':sum(bool(x['unsupported_assertions']) for x in rs),'errors':sum(x['error'] for x in rs),'references_resolve':sum(x['references_resolve'] for x in rs),'citation_coverage':sum(x['citation_coverage'] for x in rs),'wall_seconds':[x['wall_seconds'] for x in rs],'prompt_tokens':sum(x['prompt_tokens'] for x in rs),'generated_tokens':sum(x['generated_tokens'] for x in rs),'max_observed_gpu_mib':max(gpu),'max_observed_cgroup_ram_bytes':max(ram),'server_timing':server,'native_tool_call_proposals':sum(unexpected)};rows.append(row)
(ROOT/'summary.json').write_text(json.dumps(rows,indent=2)+'\n')
for r in rows:print(r['model'],r['variant'],r['axis_correct'],'coverage',r['identity_non_abstain'],'FP',r['false_mismatch_on_matched_control'],'seconds',[round(x,3) for x in r['wall_seconds']],'tokens',r['prompt_tokens'],r['generated_tokens'],'GPU',r['max_observed_gpu_mib'],'RAM',r['max_observed_cgroup_ram_bytes'])
