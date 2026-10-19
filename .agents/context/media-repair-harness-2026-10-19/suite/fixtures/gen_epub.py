"""Deterministic generator for the synthetic EPUB fixtures of the dev-v1 suite. Stdlib only.

All works are fictional ("The Lantern Road" by Mira Tolland, "Salt and Cedar" by Jonas Weir); the prose is
original filler written for this suite. Re-running produces byte-identical files (fixed ZIP timestamps).
Usage: python3 gen_epub.py <outdir>
"""
import io, sys, zipfile
from pathlib import Path

LANTERN = [
    ("Chapter 1: Rain", "The rain came in off the water before the lamplighters had finished their rounds. "
     "Ada pulled her collar up and counted the lanterns along the road, one for every mile she had left to walk. "
     "By the third lantern she had stopped feeling her hands. By the seventh she had decided that the road, "
     "like most promises, was longer than it had been described. The innkeeper at the crossing had said it was "
     "a morning's walk. The innkeeper had not walked it in the rain, carrying a letter that was not hers to open."),
    ("Chapter 2: Salt", "At the salt works the pans lay flat and grey under the cloud. A man in a canvas coat "
     "raked the crystals into low ridges and did not look up when she asked for the harbour master. "
     "She asked again, and he pointed with the rake toward a shed that leaned like a tired animal. "
     "Inside, a stove ticked and a kettle said nothing. The letter, she found, had grown heavier in the damp."),
    ("Chapter 3: Lanterns", "The last lantern on the road was unlit. Ada stood under it a long while, "
     "then took the matches from her pocket, struck one on the third try, and held it to the wick. "
     "The flame caught, shivered, and steadied. Far out on the water a second light answered, "
     "and she understood that the road had never been about arriving. It had been about being seen."),
]
SALT = [
    ("Chapter 1: Tide Tables", "Jonas kept the tide tables in a drawer that stuck in wet weather, and in wet weather "
     "he opened it more often than was sensible. The numbers never changed their minds. That was their charm. "
     "The cedar boards of the quay creaked in a pattern he had learned like a language, and tonight the pattern "
     "said that somebody was walking where nobody should be."),
    ("Chapter 2: Cedar", "The boat builder's yard smelled of resin and old coffee. She worked with her sleeves rolled "
     "and her hair tied in a rag, shaping a rib from a single curved plank without once measuring it. "
     "He asked how she knew. She said the wood told her, and then, because he looked unconvinced, "
     "she said the wood told her a great deal when she kept quiet."),
    ("Chapter 3: Salt and Cedar", "They launched the boat at dawn with no ceremony beyond a bucket of seawater "
     "poured across the bow. It sat low and sure on the grey swell. Neither of them said what it was called. "
     "Both of them knew, and the knowledge sat between them like a third passenger."),
]
FRENCH = [
    ("Chapitre 1: La pluie", "La pluie est arrivée de la mer avant que les allumeurs de réverbères aient fini leur tournée. "
     "Ada a remonté son col et compté les lanternes le long de la route, une pour chaque mille qui lui restait à parcourir."),
    ("Chapitre 2: Le sel", "Aux salines, les bassins étaient plats et gris sous les nuages. Un homme en manteau de toile "
     "ratissait les cristaux en longues crêtes et ne leva pas les yeux quand elle demanda le maître du port."),
]
NOVELLA = [("The Lamplighter's Note", "A short story in one sitting. The lamplighter left a note on the last post, "
            "folded twice and weighted with a pebble. It said only: the road is yours now. Nobody ever learned who wrote it, "
            "though several people claimed the handwriting looked like their own.")]

FIXED = (2026, 10, 19, 0, 0, 0)

def xhtml(title, body):
    paras = "".join(f"<p>{p}</p>" for p in body.split("\n\n")) if "\n\n" in body else f"<p>{body}</p>"
    return ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>'
            f"<title>{title}</title></head><body><h1>{title}</h1>{paras}</body></html>\n").encode()

def build(title, creators, chapters, lang="en", title_page=None, opf_override=None, store_chapters=True,
          missing_member=None, display_title=None):
    out = io.BytesIO()
    items = []
    if title_page:
        items.append(("titlepage", "titlepage.xhtml", "Title Page", title_page))
    for i, (ct, text) in enumerate(chapters, 1):
        items.append((f"c{i}", f"c{i}.xhtml", ct, text))
    with zipfile.ZipFile(out, "w") as z:
        def put(name, data, deflate):
            zi = zipfile.ZipInfo(name, FIXED)
            zi.compress_type = zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
        put("mimetype", b"application/epub+zip", False)
        put("META-INF/container.xml", b'<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            b'<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n', True)
        manifest = "".join(f'<item id="{i}" href="{h}" media-type="application/xhtml+xml"/>' for i, h, _, _ in items)
        spine = "".join(f'<itemref idref="{i}"/>' for i, _, _, _ in items)
        manifest += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        cr = "".join(f'<dc:creator>{c}</dc:creator>' for c in creators)
        opf = ('<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">'
               '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
               f'<dc:identifier id="uid">urn:uuid:00000000-0000-4000-8000-{abs(hash_title(title)) % 10**12:012d}</dc:identifier>'
               f'<dc:title>{title}</dc:title>{cr}<dc:language>{lang}</dc:language></metadata>'
               f'<manifest>{manifest}</manifest><spine>{spine}</spine></package>\n')
        if missing_member:
            opf = opf.replace("</manifest>", f'<item id="gone" href="{missing_member}" media-type="application/xhtml+xml"/></manifest>')
            opf = opf.replace("</spine>", '<itemref idref="gone"/></spine>')
        if opf_override:
            opf = opf_override(opf)
        put("OEBPS/content.opf", opf.encode(), True)
        toc = "".join(f'<li><a href="{h}">{t}</a></li>' for _, h, t, _ in items)
        put("OEBPS/nav.xhtml", ('<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>'
            f'<body><nav epub:type="toc"><ol>{toc}</ol></nav></body></html>\n').encode(), True)
        for i, h, t, text in items:
            put(f"OEBPS/{h}", xhtml(t, text), not store_chapters)
    return out.getvalue()

def hash_title(t):
    h = 0
    for ch in t:
        h = (h * 131 + ord(ch)) % (10**12)
    return h

def flip_crc_member(data, member="OEBPS/c2.xhtml"):
    """Flip one byte inside a STORED member's data so the ZIP structure stays valid but its CRC fails."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        info = z.getinfo(member)
    # local header: 30 bytes + name + extra
    pos = info.header_offset + 30 + len(info.filename.encode()) + 4  # extra length is 0 in our writer
    pos += 120
    b = bytearray(data)
    b[pos] ^= 0x20
    return bytes(b)

def main(outdir):
    out = Path(outdir); out.mkdir(parents=True, exist_ok=True)
    files = {}
    good = build("The Lantern Road", ["Mira Tolland"], LANTERN)
    files["lr_good.epub"] = good
    files["lr_series.epub"] = build("[Lantern Cycle, Book 1] The Lantern Road", ["Tolland, Mira"], LANTERN)
    files["lamplighter_short.epub"] = build("The Lamplighter's Note", ["Mira Tolland"], NOVELLA)
    files["lr_zip_trunc.epub"] = good[: len(good) * 60 // 100]
    files["lr_opf_broken.epub"] = build("The Lantern Road", ["Mira Tolland"], LANTERN,
                                        opf_override=lambda o: o.replace("</metadata>", "</metadata"))
    files["lr_crc.epub"] = flip_crc_member(good)
    files["lr_missing_member.epub"] = build("The Lantern Road", ["Mira Tolland"], LANTERN, missing_member="gone.xhtml")
    files["lr_wrongbody.epub"] = build("The Lantern Road", ["Mira Tolland"], SALT)
    files["lr_untitled.epub"] = build("Untitled", ["Unknown"], LANTERN,
                                      title_page="The Lantern Road. A novel by Mira Tolland. First edition.")
    files["lr_french.epub"] = build("La Route des Lanternes", ["Mira Tolland"], FRENCH, lang="fr")
    for name, data in files.items():
        (out / name).write_bytes(data)
    return files

if __name__ == "__main__":
    main(sys.argv[1])
