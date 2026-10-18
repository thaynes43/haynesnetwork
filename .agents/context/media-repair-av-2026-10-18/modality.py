"""Two explicit actual-image acceptance probes; no native video/audio claim."""
import base64,hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent;PRIVATE=Path('/home/dev/.cache/media-repair-av-1018')
sys.path.insert(0,str(ROOT.parent/'media-repair-benchmark-2026-10-18'));import ollama_matrix as r
DIGESTS={'qwen3.8:27b':'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813','muse-glimmer:30b':'de878ce33ad81d060001db1469a02eebe4d86f0ad58cfe52dc062fdcbe4464c1'}
def write(p,d):p.write_text(json.dumps(d,indent=2)+'\n')
def main():
 model=sys.argv[1];assert model in DIGESTS;folder=ROOT/'modality'/model.split(':')[0];folder.mkdir(parents=True,exist_ok=False)
 tags,tr=r.api('/api/tags');ps,rr=r.api('/api/ps');before=r.snapshot();write(folder/'preflight.json',dict(tags=tr,residents=rr,resources=before));assert ps is not None and not ps['models'] and not before['compute_processes'] and r.GPU in before['stdout']
 installed=next(x for x in tags['models'] if x['name']==model);assert installed['digest']==DIGESTS[model];write(folder/'provenance.json',r.verify_manifest(installed,folder))
 raw=(PRIVATE/'m-frame-62-0.bin').read_bytes();body={'model':model,'stream':False,'think':False,'keep_alive':'2m','format':{'type':'object','properties':{'visible_text':{'type':'string'}},'required':['visible_text'],'additionalProperties':False},'options':{'temperature':0,'seed':42,'num_ctx':8192,'num_predict':128,'stop':['<|im_end|>'] if model.startswith('qwen') else ['<|eot|>']},'messages':[{'role':'user','content':'Transcribe the visible title text in this image. Return the schema object only.','images':[base64.b64encode(raw).decode()]}]}
 encoded=json.dumps(body,separators=(',',':')).encode();(PRIVATE/(model.split(':')[0]+'-image-probe-request.json')).write_bytes(encoded)
 visible=json.loads(json.dumps(body));visible['messages'][0]['images']=[{'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'private_artifact':'m-frame-62-0.bin'}]
 write(folder/'request.json',{'request_without_image_bytes':visible,'full_request_sha256':hashlib.sha256(encoded).hexdigest()})
 response,receipt=r.api('/api/chat',body);after=r.snapshot();write(folder/'response.json',dict(response=response,receipt=receipt,after=after));print(model,response.get('message',{}).get('content') if response else receipt,flush=True)
 assert response is not None,'Uncertain transport; no eviction or replay'
 unload,ur=r.api('/api/generate',{'model':model,'keep_alive':0});write(folder/'unload.json',ur);assert unload is not None
if __name__=='__main__':main()
