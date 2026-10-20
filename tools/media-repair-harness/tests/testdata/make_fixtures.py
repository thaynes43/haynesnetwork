#!/usr/bin/env python3
"""Deterministic synthetic EPUB fixtures for the harness' own tests (original text, no third-party content).
Writes fixtures/*.epub and prints their sha256 so cases can pin them."""
import hashlib
import io
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent / 'fixtures'

STORIES = {
    'ledger': ('The Lantern Ledger', 'Ines Varga',
               ['A clerk in a harbour town keeps a ledger of lantern oil, and one night the numbers stop adding up.',
                'She follows the missing barrels to the old lighthouse, where the keeper has been selling oil to smugglers.']),
    'orchard': ('The Orchard Cartographer', 'Tomas Reyes',
                ['A mapmaker is hired to chart an orchard that rearranges itself every autumn.',
                 'He learns the trees move to follow the beekeeper, and the map becomes a record of her walks.']),
}


def epub_bytes(key):
    title, author, paras = STORIES[key]
    opf = ('<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test:%s</dc:identifier>'
           '<dc:title>%s</dc:title><dc:creator>%s</dc:creator><dc:language>en</dc:language></metadata>'
           '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>'
           '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>') % (key, title, author)
    container = ('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                 '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        def add(name, data, comp=zipfile.ZIP_DEFLATED):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = comp
            z.writestr(zi, data)
        add('mimetype', 'application/epub+zip', zipfile.ZIP_STORED)
        add('META-INF/container.xml', container)
        add('OEBPS/content.opf', opf)
        for i, p in enumerate(paras, 1):
            add('OEBPS/c%d.xhtml' % i, '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter %d</h1><p>%s</p></body></html>' % (i, p))
    return buf.getvalue()


def main():
    OUT.mkdir(exist_ok=True)
    files = {'td-right.epub': epub_bytes('ledger'), 'td-wrong.epub': epub_bytes('orchard')}
    files['td-corrupt.epub'] = files['td-right.epub'][:len(files['td-right.epub']) * 6 // 10]  # truncated archive
    for name, data in files.items():
        (OUT / name).write_bytes(data)
        print(name, len(data), hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    sys.exit(main())
