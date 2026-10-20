# VENDORED COPY, do not edit here.
# Source: .agents/context/media-repair-actual-epub-2026-10-18/epub.py (haynesnetwork repo, relative to the repo root)
# Source sha256: 9bba46ca885b0f234fd0e5c4ba772df115e0de66dc0fd3613b5db0c8eede9260
# Everything below the 'BEGIN VERBATIM' line is the source file byte for byte.  the VendoredEpub class in tests/test_packaging.py fails when the source still
# exists and differs from this copy.  To update, copy the source again and change the sha256 above.
# ---- BEGIN VERBATIM ----
"""Read-only bounded EPUB structure and body extraction. Never extracts archive paths."""
import hashlib,json,posixpath,sys,zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote,urlsplit
import xml.etree.ElementTree as E
class Text(HTMLParser):
 def __init__(self):super().__init__();self.parts=[]
 def handle_data(self,data):self.parts.append(data)
def inspect(path):
 raw=Path(path).read_bytes();assert len(raw)<=8*1024*1024
 with zipfile.ZipFile(path) as z:
  infos=z.infolist();assert len(infos)<2000 and sum(x.file_size for x in infos)<32*1024*1024
  assert len(z.namelist())==len(set(z.namelist())) and z.testzip() is None
  assert z.read('mimetype')==b'application/epub+zip'
  root=E.fromstring(z.read('META-INF/container.xml'));opf=next(x.attrib['full-path'] for x in root.iter() if x.tag.endswith('rootfile'))
  package=E.fromstring(z.read(opf));manifest={};missing=[]
  for x in package.iter():
   if x.tag.endswith('}item'):
    u=urlsplit(x.attrib['href']);assert not u.scheme and not u.netloc
    p=posixpath.normpath(posixpath.join(posixpath.dirname(opf),unquote(u.path)));assert not p.startswith('../')
    manifest[x.attrib['id']]=(p,x.attrib.get('media-type'))
    if p not in z.namelist():missing.append(p)
  assert not missing,missing
  spine=[]
  for x in package.iter():
   if x.tag.endswith('}itemref'):
    p,m=manifest[x.attrib['idref']];assert m=='application/xhtml+xml'
    E.fromstring(z.read(p));h=Text();h.feed(z.read(p).decode('utf-8-sig'));text=' '.join(' '.join(h.parts).split());assert text
    spine.append({'entry':p,'characters':len(text),'text':text})
  assert spine
  return {'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'zip_crc_ok':True,'manifest_items':len(manifest),'spine_items':len(spine),'opf':opf,'titles':[x.text for x in package.iter() if x.tag.endswith('}title')],'spine':spine}
if __name__=='__main__':
 d=inspect(sys.argv[1]);print(json.dumps(d,ensure_ascii=False,indent=2))
