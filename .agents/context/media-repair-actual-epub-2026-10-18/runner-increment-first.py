"""Four serial calls only; installed models, no downloads, no foreign eviction."""
import hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'))
import ollama_matrix as m
EXPECTED={'qwen3.8:27b':'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813','muse-glimmer:30b':'de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1'}
def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def main():
 increment = sys.argv[1:]==["--increment"]
 if sys.argv[1:]:assert increment
 if increment:
  for name,h in json.loads((ROOT/"increment-freeze.json").read_text()).items():
   if name != "run_models.py":assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h
 for name,h in json.loads((ROOT/'freeze.json').read_text()).items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h
 protocol=json.loads((ROOT/'protocol.json').read_text());schema=json.loads((ROOT/'schema.json').read_text());requests=json.loads((ROOT/('requests-increment.json' if increment else 'requests.json')).read_text())
 out=ROOT/('models-increment' if increment else 'models');out.mkdir(exist_ok=False)
 for model,digest in EXPECTED.items():
  folder=out/model.split(':')[0];folder.mkdir()
  tags,tr=m.api('/api/tags');resident,rr=m.api('/api/ps');pre=m.snapshot();write(folder/'preflight.json',dict(tags=tr,resident=rr,resources=pre))
  assert resident is not None and not resident.get('models')
  assert pre['compute_query_exit']==0 and not pre['compute_processes'] and m.GPU in pre['stdout']
  assert int(pre['stdout'].splitlines()[1].split(',')[2].strip().split()[0])>20000
  installed=next(t for t in tags['models'] if t['name']==model);assert installed['digest']==digest and installed['details']['quantization_level']=='Q4_K_M'
  write(folder/'provenance.json',m.verify_manifest(installed,folder))
  shown,sr=m.api('/api/show',{'model':model});write(folder/'show.json',sr);assert shown
  rows=[]
  for i,request in enumerate(requests):
   residents,_=m.api('/api/ps');assert residents is not None and all(x['name']==model for x in residents.get('models',[]))
   body={'model':model,'stream':False,'think':False,'keep_alive':'2m','format':schema,'options':dict(protocol['options'],stop=protocol['stops'][model]),'messages':[{'role':'system','content':protocol['system']},{'role':'user','content':json.dumps(request,sort_keys=True)}]}
   before=m.snapshot();response,receipt=m.api('/api/chat',body);after=m.snapshot()
   row=dict(row=i,request=body,response=response,receipt=receipt,before=before,after=after);rows.append(row);write(folder/'raw.json',rows)
   assert response is not None and receipt['http_status']==200,'Uncertain request: stop without eviction'
   print(model,i,repr(response.get('message',{}).get('content')),round(receipt['wall_seconds'],3),flush=True)
  unload,ur=m.api('/api/generate',{'model':model,'keep_alive':0});write(folder/'unload.json',ur);assert unload is not None
 write(out/'final-resources.json',m.snapshot());final,fr=m.api('/api/ps');write(out/'final-residents.json',fr);assert final is not None and not final.get('models')
if __name__=='__main__':main()
