"""Create contrived private fixtures and separate model manifests from evaluator truth."""
import hashlib,json,shutil,zipfile,xml.etree.ElementTree as E
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-selection-1018')
PRIOR=Path('/home/dev/.cache/media-repair-actual-epub-1018')
def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 PRIVATE.mkdir(mode=0o700,exist_ok=False);(ROOT/'evaluator').mkdir(exist_ok=False)
 expected=['c28cec78ddba679ef46185ee88bf8cb6c00b893a689d3575890adac99787b5cc','e42c77b5aef6528277b16b4c2ed4a015391cf0821394001da497c6bbbc9099fa']
 for i in range(2):
  source=PRIOR/f'pristine-{i}.epub';assert sha(source)==expected[i];shutil.copyfile(source,PRIVATE/f'base-{i}.epub')
 # Deliberately misleading actual OPF, on a new derived fixture only. Body unchanged.
 with zipfile.ZipFile(PRIVATE/'base-0.epub') as zin,zipfile.ZipFile(PRIVATE/'derived-title.epub','w') as zout:
  for info in zin.infolist():
   raw=zin.read(info.filename)
   if info.filename=='content.opf':
    tree=E.fromstring(raw)
    for item in tree.iter():
     if item.tag.endswith('}title'):item.text='Anne of Green Gables'
    raw=E.tostring(tree,encoding='utf-8',xml_declaration=True)
   zout.writestr(info,raw)
 # Truncated correct-work ZIP: central directory removed; cannot be accepted.
 (PRIVATE/'derived-damage.epub').write_bytes((PRIVATE/'base-1.epub').read_bytes()[:2048])
 for p in PRIVATE.glob('*.epub'):p.chmod(0o400)
 arrangements=[('r01',[('v7','base-0.epub'),('k4','base-1.epub'),('n2','derived-damage.epub')]),('r02',[('h6','derived-damage.epub'),('q8','derived-title.epub'),('b3','base-1.epub')]),('r03',[('t5','derived-title.epub'),('a9','derived-damage.epub'),('j1','base-0.epub')])]
 visible=[];truth=[];mapping={}
 for case,entries in arrangements:
  visible.append({'case_id':case,'expected':{'title':'Anne of Green Gables','author':'L. M. Montgomery'},'candidate_ids':[i for i,_ in entries]})
  mapping[case]={i:str(PRIVATE/n) for i,n in entries}
  candidates={i:{'sha256':sha(PRIVATE/n),'actual_work':'Anne of Green Gables' if n=='base-1.epub' else 'Anne of Windy Poplars' if n in ('base-0.epub','derived-title.epub') else None,'structurally_valid':n!='derived-damage.epub','derived':n.startswith('derived-'),'construction':n} for i,n in entries}
  truth.append({'case_id':case,'valid_ids':[i for i,n in entries if n=='base-1.epub'],'candidates':candidates})
 write(ROOT/'cases.json',visible);write(ROOT/'evaluator/truth.json',truth);write(PRIVATE/'mapping.json',mapping)
 write(ROOT/'evaluator/provenance.json',{'prerequisite':'PR998 9ed8462d; independent primary-text proof in prior IDENTITY.md','arrangements':'All three contrived, not new historical cases','derived_title':'Wrong-work body and all entries preserved except title in content.opf; repackaged isolated copy only','derived_damage':'First2048 bytes of correct-work EPUB, central directory missing','original_pristine_hashes':expected,'mapping_sha256':sha(PRIVATE/'mapping.json'),'fixtures':{p.name:sha(p) for p in PRIVATE.glob('*.epub')}})
 write(ROOT/'schema.json',{'type':'object','properties':{'action':{'type':'string','enum':['inspect','select','abstain']},'candidate_id':{'type':'string'},'evidence':{'type':'array','items':{'type':'string'},'maxItems':12}},'required':['action','candidate_id','evidence'],'additionalProperties':False})
 write(ROOT/'protocol.json',{'system':'Choose an intact document containing the requested literary work from opaque candidates. You have the actual read-only inspect tool: return action inspect with candidate_id and evidence [] to inspect one candidate. The next user message gives real tool observations. Inspect candidates as needed, at most three inspections. Metadata can be misleading; actual narrative body matters, and a sequel is a different work. Require structural integrity and body evidence before selecting. Return action select with the candidate ID and evidence references such as o2.integrity and o2.body from returned observations. If none is an evidenced valid candidate, return action abstain, candidate_id empty string, and evidence references supporting rejection. Never invent IDs or observations. No filename/path or external tool access. Every response must follow the strict action schema. You have at most four turns, including final action; do not inspect on the final turn.','options':{'temperature':0,'seed':42,'num_ctx':8192,'num_predict':256},'stops':{'qwen3.8:27b':['<|im_end|>'],'muse-glimmer:30b':['<|eot|>']},'max_turns':4,'max_tools':3,'case_seconds':180,'remote_call_seconds':60,'think':False,'keep_alive':'2m'})
if __name__=='__main__':main()
