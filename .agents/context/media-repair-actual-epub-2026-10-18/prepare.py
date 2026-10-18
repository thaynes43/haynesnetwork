"""Freeze two body-evidence requests before inference; no filenames in requests."""
import hashlib,json,re
from pathlib import Path
import epub
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-actual-epub-1018')
def write(p,d):p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
def evidence(path):
 d=epub.inspect(path);first=next(x['text'] for x in d['spine'] if x['characters']>5000)
 # Remove repeated running header: retain narrative chapter/letter heading onward.
 first=re.split(r'(?=\(Letter from|CHAPTER I\.)',first,maxsplit=1)[-1]
 return {'opening_body_excerpt':' '.join(first.split()[:140])}
def main():
 requests=[{'expected':{'title':'Anne of Green Gables','author':'L. M. Montgomery'},'document':evidence(PRIVATE/f'pristine-{i}.epub')} for i in range(2)]
 write(ROOT/'requests.json',requests)
 write(ROOT/'labels.json',[{'row':0,'expected_decision':'mismatch','actual_work':'Anne of Windy Poplars'},{'row':1,'expected_decision':'match','actual_work':'Anne of Green Gables'}])
 checks=[]
 for i in range(2):
  d=epub.inspect(PRIVATE/f'pristine-{i}.epub');checks.append({k:v for k,v in d.items() if k!='spine'})
 write(ROOT/'structure-before.json',checks)
 schema={'type':'object','properties':{'decision':{'type':'string','enum':['match','mismatch','abstain']}},'required':['decision'],'additionalProperties':False}
 write(ROOT/'schema.json',schema)
 protocol={'system':'Decide whether the supplied document body belongs to the expected literary work. A sequel by the same author is a different work. Judge actual narrative content, not a shared character alone. An omnibus containing the expected work can match. If evidence is insufficient, abstain. Return only the schema object.','options':{'temperature':0,'seed':42,'num_ctx':4096,'num_predict':256},'stops':{'qwen3.8:27b':['<|im_end|>'],'muse-glimmer:30b':['<|eot|>']},'think':False,'keep_alive':'2m','stream':False}
 write(ROOT/'protocol.json',protocol)
 names=['requests.json','labels.json','schema.json','protocol.json','epub.py','prepare.py']
 write(ROOT/'freeze.json',{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names})
if __name__=='__main__':main()
