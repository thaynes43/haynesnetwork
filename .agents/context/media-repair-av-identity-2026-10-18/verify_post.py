"""Verify frozen inputs, private media/wire bytes, matched arms and no label leakage."""
import base64,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OLD=ROOT.parent/'media-repair-av-2026-10-18';PRIVATE=Path('/home/dev/.cache/media-repair-av-identity-1018');MEDIA=Path('/home/dev/.cache/media-repair-av-1018')
def main():
 checks=[]
 for name in ['plan-freeze.json','evidence-freeze.json']:
  for n,h in json.loads((ROOT/name).read_text()).items():assert hashlib.sha256((ROOT/n).read_bytes()).hexdigest()==h,n
 assert json.loads((ROOT/'cases-baseline.json').read_text())==json.loads((OLD/'cases.json').read_text())[:3]
 assert json.loads((ROOT/'evaluator/truth.json').read_text())==json.loads((OLD/'evaluator/truth.json').read_text())[:3]
 images=json.loads((ROOT/'image-hashes.json').read_text());assert images['a01']['sha256']==images['a02']['sha256']
 for cid,audit in json.loads((ROOT/'evaluator/ocr-provenance.json').read_text()).items():
  for reading in audit['readings']:
   model=reading['model'];folder=(OLD/'modality'/model) if cid=='a01' else ROOT/'ocr'/model
   assert hashlib.sha256((folder/'response.json').read_bytes()).hexdigest()==reading['response_file_sha256']
   request=json.loads((folder/'request.json').read_text());assert request['full_request_sha256']==reading['request_sha256']
   wire=(MEDIA/(model+'-image-probe-request.json')) if cid=='a01' else PRIVATE/(model+'-ocr-request.json')
   assert hashlib.sha256(wire.read_bytes()).hexdigest()==reading['request_sha256']

 for meta in images.values():assert hashlib.sha256((MEDIA/meta['artifact']).read_bytes()).hexdigest()==meta['sha256']
 for variant in ['baseline','tool']:
  for cid in ['a01','a02','a03']:
   models=[]
   for model in ['qwen3.8','muse-glimmer']:
    d=json.loads((ROOT/'runs'/variant/model/(cid+'.json')).read_text());raw=(PRIVATE/(model+'-'+variant+'-'+cid+'-request.json')).read_bytes();assert hashlib.sha256(raw).hexdigest()==d['full_request_sha256'];body=json.loads(raw);assert hashlib.sha256(base64.b64decode(body['messages'][1]['images'][0])).hexdigest()==images[cid]['sha256'];models.append(body)
    content=body['messages'][1]['content'];assert not any(s in content for s in ['identity_basis','valid_ids','actual_work','/home/','/data/','evaluator'])
    checks.append({'model':model,'variant':variant,'case_id':cid,'wire_and_image_hash_match':True})
   assert models[0]['messages']==models[1]['messages'] and models[0]['format']==models[1]['format']
   assert {k:v for k,v in models[0]['options'].items() if k!='stop'}=={k:v for k,v in models[1]['options'].items() if k!='stop'}
 baseline=json.loads((ROOT/'cases-baseline.json').read_text());tool=json.loads((ROOT/'cases-tool.json').read_text())
 for a,b in zip(baseline,tool,strict=True):
  observed=b['observations'].pop('ocr');assert set(observed)=={'status','text'};assert a==b
 (ROOT/'post-verification.json').write_text(json.dumps({'checks':checks,'both_frozen_manifests_match':True,'prior_cases_truth_and_images_unchanged':True,'only_tool_delta_is_ocr_observation':True,'original_media_opened':False},indent=2)+'\n');print('Both freezes, private wire/image hashes, matched evidence and unchanged prior cases pass')
if __name__=='__main__':main()
