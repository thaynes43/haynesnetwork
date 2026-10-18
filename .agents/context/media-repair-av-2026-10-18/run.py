"""Four fixed actual-still diagnostic requests per model; private raw image bytes."""
import base64,hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent;PRIVATE=Path('/home/dev/.cache/media-repair-av-1018')
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'));import ollama_matrix as r
from modality import DIGESTS

def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def main():
 model=sys.argv[1];assert model in DIGESTS
 for name,h in json.loads((ROOT/'freeze.json').read_text()).items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==h,name
 protocol=json.loads((ROOT/'protocol.json').read_text());schema=json.loads((ROOT/'schema.json').read_text());images=json.loads((ROOT/'image-hashes.json').read_text());cases=json.loads((ROOT/'cases.json').read_text());folder=ROOT/'runs'/model.split(':')[0];folder.mkdir(parents=True,exist_ok=False)
 ps,pr=r.api('/api/ps');tags,tr=r.api('/api/tags');before=r.snapshot();write(folder/'preflight.json',dict(resources=before,residents=pr,tags=tr));assert ps is not None and not ps['models'] and not before['compute_processes'] and r.GPU in before['stdout'];assert int(before['stdout'].splitlines()[1].split(',')[2].strip().split()[0])>20000
 installed=next(x for x in tags['models'] if x['name']==model);assert installed['digest']==DIGESTS[model];write(folder/'provenance.json',r.verify_manifest(installed,folder))
 for case in cases:
  ps,_=r.api('/api/ps');assert ps is not None and all(x['name']==model for x in ps['models'])
  image=(PRIVATE/images[case['case_id']]['artifact']).read_bytes();assert hashlib.sha256(image).hexdigest()==images[case['case_id']]['sha256']
  body={'model':model,'stream':False,'think':False,'keep_alive':'2m','format':schema,'options':dict(protocol['options'],stop=protocol['stops'][model]),'messages':[{'role':'system','content':protocol['system']},{'role':'user','content':json.dumps(case,sort_keys=True),'images':[base64.b64encode(image).decode()]}]}
  encoded=json.dumps(body,separators=(',',':')).encode();(PRIVATE/(model.split(':')[0]+'-'+case['case_id']+'-request.json')).write_bytes(encoded)
  visible=json.loads(json.dumps(body));visible['messages'][1]['images']=[images[case['case_id']]]
  a=r.snapshot();response,receipt=r.api('/api/chat',body);b=r.snapshot();write(folder/(case['case_id']+'.json'),dict(case_id=case['case_id'],model=model,request_without_image_bytes=visible,full_request_sha256=hashlib.sha256(encoded).hexdigest(),response=response,receipt=receipt,before=a,after=b));assert response is not None and receipt.get('http_status')==200,'Uncertain request: stop without replay/eviction';print(model,case['case_id'],response.get('message',{}).get('content'),flush=True)
 unload,receipt=r.api('/api/generate',{'model':model,'keep_alive':0});write(folder/'unload.json',receipt);assert unload is not None
if __name__=='__main__':main()
