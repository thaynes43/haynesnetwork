"""Read-only post-run hashes and independently parsed model-selected outputs."""
import hashlib,json,subprocess
from pathlib import Path
import evaluate
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-selection-1018')
PRIOR=Path('/home/dev/.cache/media-repair-actual-epub-1018')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 provenance=json.loads((ROOT/'evaluator/provenance.json').read_text());checks=[]
 for i,h in enumerate(provenance['original_pristine_hashes']):assert sha(PRIOR/f'pristine-{i}.epub')==h;checks.append({'prior_pristine':i,'sha256':h,'unchanged':True})
 for name,h in provenance['fixtures'].items():assert sha(PRIVATE/name)==h
 for source in json.loads((ROOT.parent/'media-repair-actual-epub-2026-10-18/sources.json').read_text()):
  code='import pathlib,hashlib,json,sys; p=pathlib.Path(sys.argv[1]);s=p.stat();assert s.st_size<=8388608;print(json.dumps(dict(bytes=s.st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),mtime_ns=s.st_mtime_ns)))'
  now=json.loads(subprocess.check_output(['kubectl','-n','downloads','exec','deploy/lazylibrarian','-c','app','--','python3','-c',code,source['source']],timeout=15));assert now==source['before'];checks.append({'source':source['source'],'after':now,'unchanged':True})
 for p in sorted((PRIVATE/'outputs').glob('*/*.epub')):
  result=evaluate.independent_document(p);assert result['expected_body'] and result['sha256']==provenance['original_pristine_hashes'][1];checks.append({'output':str(p.relative_to(PRIVATE)),**result})
 (ROOT/'post-verification.json').write_text(json.dumps({'checks':checks,'all_private_fixture_hashes_unchanged':True},indent=2)+'\n');print('Original/pristine/fixture hashes and independent selected outputs pass')
if __name__=='__main__':main()
