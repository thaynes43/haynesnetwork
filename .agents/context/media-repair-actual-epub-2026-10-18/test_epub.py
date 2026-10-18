"""Serial structural rejection tests using tiny generated EPUBs, no library reads."""
import tempfile,unittest,zipfile
from pathlib import Path
import epub
class Structure(unittest.TestCase):
 def make(self,p,missing=False,bad_spine=False):
  with zipfile.ZipFile(p,'w') as z:
   z.writestr('mimetype','application/epub+zip')
   z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
   z.writestr('content.opf','<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="'+('missing' if bad_spine else 'one')+'"/></spine></package>')
   if not missing:z.writestr('body.xhtml','<html><body>Readable narrative.</body></html>')
 def test_valid(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.epub';self.make(p);self.assertEqual(epub.inspect(p)['spine_items'],1)
 def test_missing_manifest_target(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.epub';self.make(p,missing=True)
   with self.assertRaises(AssertionError):epub.inspect(p)
 def test_broken_spine(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.epub';self.make(p,bad_spine=True)
   with self.assertRaises(KeyError):epub.inspect(p)
 def test_corrupt_archive(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.epub';p.write_bytes(b'broken')
   with self.assertRaises(zipfile.BadZipFile):epub.inspect(p)
if __name__=='__main__':unittest.main()
