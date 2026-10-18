"""Bounded model-requested tool loop. No truth enters requests or tool responses."""
import argparse,hashlib,json,sys,time
from pathlib import Path
import tools,evaluate
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-selection-1018')
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'))
import ollama_matrix as runtime
DIGESTS={'qwen3.8:27b':'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813','muse-glimmer:30b':'de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1'}
def write(path,data):path.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
def verify_freeze():
 for name,h in json.loads((ROOT/'freeze.json').read_text()).items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h,name
 provenance=json.loads((ROOT/'evaluator/provenance.json').read_text())
 assert hashlib.sha256((PRIVATE/'mapping.json').read_bytes()).hexdigest()==provenance['mapping_sha256']
 for name,h in provenance['fixtures'].items():assert hashlib.sha256((PRIVATE/name).read_bytes()).hexdigest()==h

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--model',choices=list(DIGESTS),required=True);args=parser.parse_args();verify_freeze()
 protocol=json.loads((ROOT/'protocol.json').read_text());schema=json.loads((ROOT/'schema.json').read_text());cases=json.loads((ROOT/'cases.json').read_text());mapping=json.loads((PRIVATE/'mapping.json').read_text())
 out=ROOT/'runs'/args.model.split(':')[0];out.mkdir(parents=True,exist_ok=False)
 tags,tr=runtime.api('/api/tags');res,rr=runtime.api('/api/ps');before=runtime.snapshot();write(out/'preflight.json',dict(tags=tr,residents=rr,resources=before))
 assert tags and res is not None and not res.get('models');assert before['compute_query_exit']==0 and not before['compute_processes'] and runtime.GPU in before['stdout']
 assert int(before['stdout'].splitlines()[1].split(',')[2].strip().split()[0])>20000
 installed=next(x for x in tags['models'] if x['name']==args.model);assert installed['digest']==DIGESTS[args.model] and installed['details']['quantization_level']=='Q4_K_M'
 write(out/'provenance.json',runtime.verify_manifest(installed,out));shown,sr=runtime.api('/api/show',{'model':args.model});write(out/'show.json',sr);assert shown
 for case in cases:
  folder=out/case['case_id'];folder.mkdir();start=time.monotonic();trace={'case_id':case['case_id'],'model':args.model,'turns':[],'observations':[],'final':None}
  messages=[{'role':'system','content':protocol['system']},{'role':'user','content':json.dumps(case,sort_keys=True)}]
  for turn in range(protocol['max_turns']):
   # Reserve remote+transport timeout so an additional call cannot exceed case cap.
   if time.monotonic()-start>protocol['case_seconds']-65:trace['stop_reason']='case_time_cap';break
   res,_=runtime.api('/api/ps');assert res is not None and all(x['name']==args.model for x in res.get('models',[]))
   request={'model':args.model,'stream':False,'think':False,'keep_alive':protocol['keep_alive'],'format':schema,'options':dict(protocol['options'],stop=protocol['stops'][args.model]),'messages':list(messages)}
   snap_before=runtime.snapshot();response,receipt=runtime.api('/api/chat',request);snap_after=runtime.snapshot()
   trace['turns'].append(dict(request=request,response=response,receipt=receipt,before=snap_before,after=snap_after));trace['wall_seconds']=time.monotonic()-start;write(folder/'trace.json',trace)
   if response is None or receipt.get('http_status')!=200:raise RuntimeError('Uncertain model call; stop without unloading/replay')
   raw=response.get('message',{}).get('content','')
   try:
    action=json.loads(raw);assert isinstance(action,dict) and set(action)=={'action','candidate_id','evidence'} and isinstance(action['candidate_id'],str) and isinstance(action['evidence'],list) and all(isinstance(e,str) for e in action['evidence'])
   except (ValueError,AssertionError):trace['stop_reason']='protocol_error';break
   if action['action'] in ('select','abstain'):trace['final']=action;break
   if action['action']!='inspect':trace['stop_reason']='unknown_action';break
   if len(trace['observations'])>=protocol['max_tools']:trace['stop_reason']='tool_budget_exhausted';break
   observation=tools.inspect_candidate(mapping[case['case_id']],action['candidate_id'],'o'+str(len(trace['observations'])+1));trace['observations'].append(observation)
   messages.extend([{'role':'assistant','content':raw},{'role':'user','content':json.dumps({'tool_result':observation,'turns_remaining':protocol['max_turns']-turn-1},sort_keys=True)}])
  trace['wall_seconds']=time.monotonic()-start
  if trace['final'] is None:trace.setdefault('stop_reason','turn_budget_exhausted')
  write(folder/'trace.json',trace) # Preserve proposal before evaluator and guard.
  truth=next(x for x in json.loads((ROOT/'evaluator/truth.json').read_text()) if x['case_id']==case['case_id'])
  result=evaluate.assess(trace['final'],trace['observations'],truth);trace['assessment']=result
  trace['execution']=evaluate.execute_fixture(result,mapping[case['case_id']],PRIVATE/'outputs'/args.model.split(':')[0]/(case['case_id']+'.epub'));write(folder/'trace.json',trace)
  print(args.model,case['case_id'],trace['final'],result['unsafe_categories'],trace['execution']['status'],flush=True)
 unload,ur=runtime.api('/api/generate',{'model':args.model,'keep_alive':0});write(out/'unload.json',ur);assert unload is not None
 verify_freeze();write(out/'after.json',runtime.snapshot())
if __name__=='__main__':main()
