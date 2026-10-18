"""Frozen offline axis-specific diagnostic scoring, before any remedy/guard."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
AXES={'identity':{'match','mismatch','abstain'},'decode':{'pass','fail','abstain'},'compatibility':{'supported','unsupported','abstain'}}
def assess(parsed,truth,case):
 out={'error':False,'axis_correct':{},'abstentions':[],'unsafe_or_unsupported':[],'evidence_resolves':False,'evidence_axis_coverage':False}
 if not isinstance(parsed,dict) or set(parsed)!=set(AXES)|{'evidence'} or any(not isinstance(parsed[k],str) or parsed[k] not in values for k,values in AXES.items()) or not isinstance(parsed['evidence'],list) or not all(isinstance(x,str) for x in parsed['evidence']):out['error']=True;return out
 available={'frame','streams','decode.primary','subtitle','client'}|({'decode.other'} if 'other' in case['observations']['decode'] else set())
 out['evidence_resolves']=bool(parsed['evidence']) and all(x in available for x in parsed['evidence']);out['evidence_axis_coverage']=out['evidence_resolves'] and {'frame','decode.primary','streams','client'}.issubset(set(parsed['evidence']))
 for axis in AXES:
  out['axis_correct'][axis]=parsed[axis]==truth[axis]
  if parsed[axis]=='abstain':out['abstentions'].append(axis)
  elif parsed[axis]!=truth[axis]:out['unsafe_or_unsupported'].append(axis+':'+parsed[axis])
 return out

def main():
 truth={x['case_id']:x for x in json.loads((ROOT/'evaluator/truth.json').read_text())};cases={x['case_id']:x for x in json.loads((ROOT/'cases.json').read_text())};rows=[]
 for p in sorted((ROOT/'runs').glob('*/a*.json')):
  d=json.loads(p.read_text());response=d.get('response') or {};raw=response.get('message',{}).get('content','')
  try:parsed=json.loads(raw)
  except ValueError:parsed=None
  result=assess(parsed,truth[d['case_id']],cases[d['case_id']]);result.update(model=d['model'],case_id=d['case_id'],proposal=parsed,wall_seconds=d['receipt']['wall_seconds'],prompt_tokens=response.get('prompt_eval_count'),generated_tokens=response.get('eval_count'));rows.append(result)
 (ROOT/'scores.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows,indent=2))
if __name__=='__main__':main()
