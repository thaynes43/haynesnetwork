"""Copy only three existing frozen cases/truth/config; no original media reads."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent;OLD=ROOT.parent/'media-repair-av-2026-10-18'
def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def main():
 cases=json.loads((OLD/'cases.json').read_text())[:3];truth=json.loads((OLD/'evaluator/truth.json').read_text())[:3];assert [c['case_id'] for c in cases]==['a01','a02','a03']
 write(ROOT/'cases-baseline.json',cases);(ROOT/'evaluator').mkdir(exist_ok=False);write(ROOT/'evaluator/truth.json',truth)
 protocol=json.loads((OLD/'protocol.json').read_text());protocol['case_count']=3;write(ROOT/'protocol.json',protocol)
 schema=json.loads((OLD/'schema-bounded.json').read_text());schema['properties']['evidence']['items']['enum'].append('ocr');write(ROOT/'schema.json',schema)
 images=json.loads((OLD/'image-hashes.json').read_text());write(ROOT/'image-hashes.json',{c['case_id']:images[c['case_id']] for c in cases})
 write(ROOT/'ocr-config.json',{'new_case_id':'a03','prompt':'Transcribe only readable text literally visible in this image. If there is no readable text, return an empty string. Do not name objects, infer the episode, or guess. Return only the schema object.','schema':{'type':'object','properties':{'visible_text':{'type':'string','maxLength':256}},'required':['visible_text'],'additionalProperties':False},'options':{'temperature':0,'seed':42,'num_ctx':8192,'num_predict':128},'new_calls':2,'cached_title_calls':2,'consensus_rule':'exact equality after whitespace normalization, no title/target matching'})
 write(ROOT/'evaluator/provenance.json',{'source_commit':'e08460866f2bc971a0a8a30f1012607b63c5d016','case_selection':'Three prior development cases; movie omitted. a02 remains contrived requested-work swap; a03 insufficient exact-episode evidence. No new incident/media claim.','identity_labels':'Unchanged prior independent manual title-card/primary-reference labels, never derived from new model decisions.','ocr_limit':'Native-model OCR, with cached first-card transcriptions from both tested models; not an independent deterministic OCR engine. Consensus is not guaranteed truth.','prior_frame_hashes_sha256':hashlib.sha256((OLD/'image-hashes.json').read_bytes()).hexdigest()})
if __name__=='__main__':main()
