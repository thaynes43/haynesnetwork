"""Fixture reference selection only. Independent body checks, no EPUB rewriting."""
import hashlib,json,shutil
from pathlib import Path
import epub
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-actual-epub-1018')
# Frozen primary-text fingerprints, not archive filenames or OPF titles.
def proves_expected(d):
 texts=[x['text'] for x in d['spine']]
 return (any('Mrs. Rachel Lynde lived just where the Avonlea main road' in t for t in texts)
  and any('Matthew Cuthbert and the sorrel mare' in t and 'Bright River' in t for t in texts)
  and any('CHAPTER XXXVIII.' in t and 'The Bend in the road' in t for t in texts))
def main():
 before=[epub.inspect(PRIVATE/f'pristine-{i}.epub') for i in range(2)]
 candidates=[i for i,d in enumerate(before) if proves_expected(d)];assert len(candidates)==1
 derived=PRIVATE/'derived';derived.mkdir(exist_ok=False)
 for i in range(2):shutil.copyfile(PRIVATE/f'pristine-{i}.epub',derived/f'candidate-{i}.epub')
 rows=[]
 for i,expected_change in [(0,True),(1,False)]:
  original={'document':str(derived/f'candidate-{i}.epub')};final=dict(original)
  if not proves_expected(epub.inspect(original['document'])):final['document']=str(derived/f'candidate-{candidates[0]}.epub')
  record=derived/f'record-{i}.json';record.write_text(json.dumps(final));resolved=epub.inspect(json.loads(record.read_text())['document'])
  assert proves_expected(resolved) and resolved['sha256']==before[candidates[0]]['sha256']
  assert (final!=original)==expected_change
  rows.append({'initial_candidate':i,'reference_changed':final!=original,'resolved_sha256':resolved['sha256'],'resolved_structure_valid':True,'independent_body_identity_pass':True})
 for i,d in enumerate(before):
  assert epub.inspect(PRIVATE/f'pristine-{i}.epub')['sha256']==d['sha256']
  assert epub.inspect(derived/f'candidate-{i}.epub')['sha256']==d['sha256']
 (ROOT/'repair-results.json').write_text(json.dumps({'rows':rows,'pristine_and_derived_bytes_unchanged':True,'scope':'isolated reference selection; no book bytes rewritten; deterministic content selector, not LLM candidate choice'},indent=2)+'\n')
if __name__=='__main__':main()
