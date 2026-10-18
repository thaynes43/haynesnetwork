"""Target-agnostic OCR consensus over actual-byte-bound observations, no identity rules."""
import re

def consensus(readings):
 if len(readings)!=2 or len({r['image_sha256'] for r in readings})!=1:raise ValueError('Two observations of identical image bytes required')
 texts=[]
 for r in readings:
  if not isinstance(r['text'],str) or len(r['text'])>256:raise ValueError('Bounded OCR text required')
  texts.append(re.sub(r'\s+',' ',r['text']).strip())
 return {'status':'agreement' if texts[0]==texts[1] else 'unresolved','text':texts[0] if texts[0]==texts[1] else ''}
