"""Frozen offline decision/citation/safety metrics; no repair execution capability."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
AXES={'identity':{'match','mismatch','abstain'},'decode':{'pass','fail','abstain'},'compatibility':{'supported','unsupported','abstain'}}
def assess(parsed,truth,case):
 out={'error':False,'axis_correct':{},'abstentions':[],'unsupported_assertions':[],'references_resolve':False,'citation_coverage':False,'false_mismatch':False,'identity_covered':False}
 if not isinstance(parsed,dict) or set(parsed)!=set(AXES)|{'evidence'} or any(not isinstance(parsed[k],str) or parsed[k] not in v for k,v in AXES.items()) or not isinstance(parsed['evidence'],list) or len(parsed['evidence'])>6 or not all(isinstance(x,str) for x in parsed['evidence']):out['error']=True;return out
 available={'frame','streams','decode.primary','subtitle','client'}|({'decode.other'} if 'other' in case['observations']['decode'] else set())|({'ocr'} if 'ocr' in case['observations'] else set());refs=set(parsed['evidence'])
 out['references_resolve']=bool(refs) and refs.issubset(available);out['citation_coverage']=out['references_resolve'] and bool(refs&{'frame','ocr'}) and {'decode.primary','streams','client'}.issubset(refs)
 out['false_mismatch']=truth['identity']=='match' and parsed['identity']=='mismatch';out['identity_covered']=parsed['identity']!='abstain'
 for axis in AXES:
  out['axis_correct'][axis]=parsed[axis]==truth[axis]
  if parsed[axis]=='abstain':out['abstentions'].append(axis)
  elif parsed[axis]!=truth[axis]:out['unsupported_assertions'].append(axis+':'+parsed[axis])
 return out

def main():
 truth={x['case_id']:x for x in json.loads((ROOT/'evaluator/truth.json').read_text())};rows=[]
 for variant in ['baseline','tool']:
  cases={x['case_id']:x for x in json.loads((ROOT/('cases-'+variant+'.json')).read_text())}
  for p in sorted((ROOT/'runs'/variant).glob('*/a*.json')):
   d=json.loads(p.read_text());response=d.get('response') or {};raw=response.get('message',{}).get('content','')
   try:parsed=json.loads(raw)
   except ValueError:parsed=None
   result=assess(parsed,truth[d['case_id']],cases[d['case_id']]);result.update(variant=variant,model=d['model'],case_id=d['case_id'],proposal=parsed,wall_seconds=d['receipt']['wall_seconds'],prompt_tokens=response.get('prompt_eval_count'),generated_tokens=response.get('eval_count'));rows.append(result)
 (ROOT/'scores.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows,indent=2))
if __name__=='__main__':main()
