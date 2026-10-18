"""Two new transcription-only calls on one existing image; cached card readings separate."""
import base64,hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OLD=ROOT.parent/'media-repair-av-2026-10-18';PRIVATE=Path('/home/dev/.cache/media-repair-av-identity-1018');MEDIA=Path('/home/dev/.cache/media-repair-av-1018')
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'));import ollama_matrix as r
sys.path.insert(0,str(OLD));from modality import DIGESTS

def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def verify_plan():
 for n,h in json.loads((ROOT/'plan-freeze.json').read_text()).items():assert hashlib.sha256((ROOT/n).read_bytes()).hexdigest()==h,n

def main():
 model=sys.argv[1];assert model in DIGESTS;verify_plan();config=json.loads((ROOT/'ocr-config.json').read_text());images=json.loads((ROOT/'image-hashes.json').read_text());meta=images[config['new_case_id']];raw=(MEDIA/meta['artifact']).read_bytes();assert hashlib.sha256(raw).hexdigest()==meta['sha256'];out=ROOT/'ocr'/model.split(':')[0];out.mkdir(parents=True,exist_ok=False)
 tags,tr=r.api('/api/tags');ps,pr=r.api('/api/ps');snap=r.snapshot();write(out/'preflight.json',dict(tags=tr,residents=pr,resources=snap));assert ps is not None and not ps['models'] and not snap['compute_processes'] and r.GPU in snap['stdout'];assert int(snap['stdout'].splitlines()[1].split(',')[2].strip().split()[0])>20000
 installed=next(x for x in tags['models'] if x['name']==model);assert installed['digest']==DIGESTS[model] and installed['details']['quantization_level']=='Q4_K_M';write(out/'provenance.json',r.verify_manifest(installed,out));show,sr=r.api('/api/show',{'model':model});write(out/'show.json',sr);assert show and 'vision' in show['capabilities']
 protocol=json.loads((ROOT/'protocol.json').read_text());body={'model':model,'stream':False,'think':False,'keep_alive':'2m','format':config['schema'],'options':dict(config['options'],stop=protocol['stops'][model]),'messages':[{'role':'user','content':config['prompt'],'images':[base64.b64encode(raw).decode()]}]};wire=json.dumps(body,separators=(',',':')).encode();(PRIVATE/(model.split(':')[0]+'-ocr-request.json')).write_bytes(wire);visible=json.loads(json.dumps(body));visible['messages'][0]['images']=[meta]
 write(out/'request.json',{'request_without_image_bytes':visible,'full_request_sha256':hashlib.sha256(wire).hexdigest()});response,receipt=r.api('/api/chat',body);write(out/'response.json',dict(response=response,receipt=receipt,after=r.snapshot()));assert response is not None,'Uncertain call: stop without replay/eviction';print(model,response.get('message',{}).get('content'),flush=True)
 unload,ur=r.api('/api/generate',{'model':model,'keep_alive':0});write(out/'unload.json',ur);assert unload is not None
if __name__=='__main__':main()
