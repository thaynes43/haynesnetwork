"""Offline strict scoring of preserved model outputs; never runs inference."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def main():
 labels=json.loads((ROOT/'labels.json').read_text());scores=[]
 for variant in ['models','models-increment']:
  for model in ['qwen3.8','muse-glimmer']:
   rows=json.loads((ROOT/variant/model/'raw.json').read_text());result={'variant':variant,'model':model,'TP':0,'TN':0,'FP':0,'FN':0,'abstentions':0,'errors':0,'rows':[]}
   for row,label in zip(rows,labels,strict=True):
    try:
     parsed=json.loads(row['response']['message']['content']);assert set(parsed)=={'decision'} and parsed['decision'] in ('match','mismatch','abstain');decision=parsed['decision']
    except (ValueError,KeyError,TypeError,AssertionError):decision='error'
    bucket='errors' if decision=='error' else 'abstentions' if decision=='abstain' else ('TP' if label['expected_decision']=='mismatch' else 'FP') if decision=='mismatch' else ('TN' if label['expected_decision']=='match' else 'FN');result[bucket]+=1
    response=row['response'];result['rows'].append(dict(row=row['row'],decision=decision,wall_seconds=row['receipt']['wall_seconds'],prompt_tokens=response.get('prompt_eval_count'),generated_tokens=response.get('eval_count'),load_ns=response.get('load_duration'),prompt_ns=response.get('prompt_eval_duration'),eval_ns=response.get('eval_duration')))
   result['max_observed_gpu_mib']=max(int(r[t]['stdout'].splitlines()[1].split(',')[1].strip().split()[0]) for r in rows for t in ('before','after'))
   scores.append(result)
 (ROOT/'scores.json').write_text(json.dumps(scores,indent=2)+'\n');print(json.dumps(scores,indent=2))
if __name__=='__main__':main()
