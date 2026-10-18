"""Independent source hash/structure/body read-back, without repair predicates."""
import hashlib,json,subprocess,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent
PRIVATE=Path('/home/dev/.cache/media-repair-actual-epub-1018')
def main():
 checks=[]
 for source in json.loads((ROOT/'sources.json').read_text()):
  code='import pathlib,hashlib,json,sys; p=pathlib.Path(sys.argv[1]);s=p.stat();assert s.st_size<=8388608;print(json.dumps(dict(bytes=s.st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),mtime_ns=s.st_mtime_ns)))'
  now=json.loads(subprocess.check_output(['kubectl','-n','downloads','exec','lazylibrarian-565f8b89b9-htmcq','-c','app','--','python3','-c',code,source['source']],timeout=15));assert now==source['before'];checks.append(dict(source=source['source'],after_repair=now,unchanged=True))
 for i in range(2):
  record=json.loads((PRIVATE/f'derived/record-{i}.json').read_text());p=Path(record['document'])
  with zipfile.ZipFile(p) as z:
   assert z.testzip() is None
   doc=ET.fromstring(z.read('content.opf'));items={x.attrib['id']:x.attrib['href'] for x in doc.iter() if x.tag.endswith('}item')};texts=[' '.join(ET.fromstring(z.read(items[x.attrib['idref']])).itertext()) for x in doc.iter() if x.tag.endswith('}itemref')];body=' '.join(texts)
   assert 'Mrs. Rachel Lynde lived just where the Avonlea main road' in body and 'Matthew Cuthbert and the sorrel mare' in body and 'CHAPTER XXXVIII.' in body and 'Principal of Summerside High School' not in body
  checks.append(dict(row=i,independent_xml_readback=True,ordered_spine_items=len(texts),resolved_sha256=hashlib.sha256(p.read_bytes()).hexdigest(),work='Anne of Green Gables',crc_ok=True))
 (ROOT/'independent-after.json').write_text(json.dumps(checks,indent=2)+'\n');print('Original sources unchanged; both resolved EPUBs independently pass')
if __name__=='__main__':main()
