"""Fixed generic read-only EPUB inspection over caller-supplied fixture allowlist."""
import sys,json,zipfile,xml.etree.ElementTree as E
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'media-repair-actual-epub-2026-10-18'))
import epub

def inspect_candidate(mapping,candidate_id,observation_id):
 if candidate_id not in mapping:return {'observation_id':observation_id,'candidate_id':candidate_id,'error':'unknown_candidate'}
 path=Path(mapping[candidate_id]);result={'observation_id':observation_id,'candidate_id':candidate_id}
 try:
  d=epub.inspect(path)
  with zipfile.ZipFile(path) as z:
   package=E.fromstring(z.read(d['opf']))
   metadata={'titles':d['titles'],'creators':[x.text for x in package.iter() if x.tag.endswith('}creator')]}
  narrative=[x['text'] for x in d['spine'] if x['characters']>5000]
  if not narrative:narrative=[x['text'] for x in d['spine']]
  result.update(integrity={'zip_crc':'pass','package_manifest_spine_xhtml':'pass','spine_items':d['spine_items']},metadata=metadata,body={'opening':' '.join(narrative[0].split()[:140]),'middle':' '.join(narrative[len(narrative)//2].split()[20:90]),'ending':' '.join(narrative[-1].split()[-70:])})
 except (AssertionError,ValueError,KeyError,zipfile.BadZipFile,E.ParseError,UnicodeError):
  result['integrity']={'zip_crc':'fail_or_unreadable','package_manifest_spine_xhtml':'unverified'}
 return result
