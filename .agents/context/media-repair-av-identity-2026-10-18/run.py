"""Fixed paired baseline/tool calls; raw outputs only, never live remediation."""
import base64,hashlib,json,sys
from pathlib import Path
from ocr import DIGESTS,verify_plan
ROOT=Path(__file__).resolve().parent;PRIVATE=Path('/home/dev/.cache/media-repair-av-identity-1018');MEDIA=Path('/home/dev/.cache/media-repair-av-1018')
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'));import ollama_matrix as r

def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def main():
 model=sys.argv[1];assert model in DIGESTS;verify_plan()
 for n,h in json.loads((ROOT/'evidence-freeze.json').read_text()).items():assert hashlib.sha256((ROOT/n).read_bytes()).hexdigest()==h,n
 protocol=json.loads((ROOT/'protocol.json').read_text());schema=json.loads((ROOT/'schema.json').read_text());images=json.loads((ROOT/'image-hashes.json').read_text());modelout=ROOT/'runtime'/model.split(':')[0];modelout.mkdir(parents=True,exist_ok=False)
 tags,tr=r.api('/api/tags');ps,pr=r.api('/api/ps');snap=r.snapshot();write(modelout/'preflight.json',dict(tags=tr,residents=pr,resources=snap));assert ps is not None and not ps['models'] and not snap['compute_processes'] and r.GPU in snap['stdout'];assert int(snap['stdout'].splitlines()[1].split(',')[2].strip().split()[0])>20000
 installed=next(x for x in tags['models'] if x['name']==model);assert installed['digest']==DIGESTS[model];write(modelout/'provenance.json',r.verify_manifest(installed,modelout))
 for variant in ['baseline','tool']:
  folder=ROOT/'runs'/variant/model.split(':')[0];folder.mkdir(parents=True,exist_ok=False)
  for case in json.loads((ROOT/('cases-'+variant+'.json')).read_text()):
   ps,_=r.api('/api/ps');assert ps is not None and all(x['name']==model for x in ps['models']);meta=images[case['case_id']];image=(MEDIA/meta['artifact']).read_bytes();assert hashlib.sha256(image).hexdigest()==meta['sha256']
   body={'model':model,'stream':False,'think':False,'keep_alive':'2m','format':schema,'options':dict(protocol['options'],stop=protocol['stops'][model]),'messages':[{'role':'system','content':protocol['system']},{'role':'user','content':json.dumps(case,sort_keys=True),'images':[base64.b64encode(image).decode()]}]};wire=json.dumps(body,separators=(',',':')).encode();(PRIVATE/(model.split(':')[0]+'-'+variant+'-'+case['case_id']+'-request.json')).write_bytes(wire);visible=json.loads(json.dumps(body));visible['messages'][1]['images']=[meta]
   before=r.snapshot();response,receipt=r.api('/api/chat',body);after=r.snapshot();write(folder/(case['case_id']+'.json'),dict(model=model,variant=variant,case_id=case['case_id'],request_without_image_bytes=visible,full_request_sha256=hashlib.sha256(wire).hexdigest(),response=response,receipt=receipt,before=before,after=after));assert response is not None and receipt.get('http_status')==200,'Uncertain call: stop without replay/eviction';print(model,variant,case['case_id'],response.get('message',{}).get('content'),flush=True)
 unload,ur=r.api('/api/generate',{'model':model,'keep_alive':0});write(modelout/'unload.json',ur);assert unload is not None
if __name__=='__main__':main()
