"""Build identical target-agnostic OCR observations from byte-bound raw readings."""
import hashlib,json
from pathlib import Path
from tools import consensus
ROOT=Path(__file__).resolve().parent;OLD=ROOT.parent/'media-repair-av-2026-10-18';MEDIA=Path('/home/dev/.cache/media-repair-av-1018')
def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def main():
 images=json.loads((ROOT/'image-hashes.json').read_text());observations={};audit={}
 for cid in ['a01','a03']:
  meta=images[cid];assert hashlib.sha256((MEDIA/meta['artifact']).read_bytes()).hexdigest()==meta['sha256'];readings=[];receipts=[]
  for model in ['qwen3.8','muse-glimmer']:
   folder=(OLD/'modality'/model) if cid=='a01' else (ROOT/'ocr'/model)
   request=json.loads((folder/'request.json').read_text());message=request['request_without_image_bytes']['messages'][0];assert message['images'][0]['sha256']==meta['sha256']
   response=json.loads((folder/'response.json').read_text());parsed=json.loads(response['response']['message']['content']);assert set(parsed)=={'visible_text'} and isinstance(parsed['visible_text'],str)
   readings.append({'image_sha256':meta['sha256'],'text':parsed['visible_text']});receipts.append({'origin':'cached_PR1000' if cid=='a01' else 'new_transcription_only','model':model,'request_sha256':request['full_request_sha256'],'response_file_sha256':hashlib.sha256((folder/'response.json').read_bytes()).hexdigest(),'raw_text':parsed['visible_text']})
  observations[cid]=consensus(readings);audit[cid]={'image_sha256':meta['sha256'],'readings':receipts}
 observations['a02']=dict(observations['a01']) # same actual image, no requested-work comparison.
 cases=json.loads((ROOT/'cases-baseline.json').read_text())
 for c in cases:c['observations']['ocr']=observations[c['case_id']]
 write(ROOT/'cases-tool.json',cases);write(ROOT/'evaluator/ocr-provenance.json',audit);write(ROOT/'ocr-observations.json',observations)
if __name__=='__main__':main()
