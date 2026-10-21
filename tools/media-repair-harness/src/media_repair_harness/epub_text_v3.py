"""Tools behaviour v3 (dev-c7): bounded, offset-addressed EPUB body excerpts with their locations, and the declared table of contents kept apart.

EXTRACTION RULES `xhtml-body-text-3` (dev-c7, second review round, AUDIT-ASTRA-28 item 2).  They are `xhtml-body-text-2` (`epub_text_v2.py`, kept frozen
and pinned, no longer selected) with one correction:
  4. SEMANTIC ATTRIBUTES ARE READ BY NAMESPACE, NOT BY PREFIX.  An attribute `P:type` is the EPUB structural-semantics attribute when the prefix P is bound,
     in scope, to the EPUB namespace http://www.idpf.org/2007/ops (`xmlns:ops="...ops"` makes `ops:type="toc"` the same as `epub:type="toc"`).  The
     conventional prefix `epub` is read as that namespace unless it is bound in scope to another one; any other prefix bound elsewhere, or unbound, is not.
     This applies to navigation regions in spine documents and to the declared table of contents.  `xhtml-body-text-2` matched only the spelling `epub:type`.
Points 1 to 3 below are `xhtml-body-text-2`'s supersession of `xhtml-body-text-1` (`epub_text.py`, frozen, not selected):
  1. NAVIGATION KEEPS ITS MEANING.  Character data inside a navigation region of a spine document (a `nav` element, or any element whose `epub:type`
     includes toc, landmarks, page-list, lot or loi, or whose `role` is doc-toc, doc-pagelist or navigation) is never body text, and a heading inside one
     is never an observed body heading.  The manifest navigation document is marked `navigation_document: true` in the index when it is in the spine;
     its text outside navigation regions is body text like any other.  Each index item reports `navigation_characters` (what was set apart as navigation).
  2. LOCAL NAMES.  Element names are compared by local name, so a namespace prefix (`x:body`, `h:p`) is read like the unprefixed XHTML element.
  3. THE DIGEST COVERS THE CODE.  `rules_digest()` is the sha256 of RULES together with this module's own source bytes, so any change to the extractor
     changes the pin (tests/test_devc7_review2.py), not only a change to RULES.
The TOC entry field is `text` (it was renamed from `label`, a forbidden output field, after the `-1` freeze, in a26b9c8b).

The rules as they now stand:

* Addressing.  Body text is read only from spine items, addressed by their SPINE POSITION `spine` (0-based, the OPF spine's reading order,
  as the vendored inspector lists it).  Every result names the item's archive MEMBER path (the manifest href resolved against the OPF
  directory, exactly as the inspector reports it).  A member outside the spine has no address.
* Text of one item.  The member's bytes are decoded as UTF-8 (a byte-order mark removed), as the inspector does, and parsed with the standard
  library `html.parser.HTMLParser(convert_charrefs=True)`.  Body text is the character data inside the `<body>` element only; data inside
  `head` (with its `title`), `script`, `style` and `template`, and inside a navigation region (point 1 above), is never body text.  The start and end tag of every element in `BLOCK_TAGS`
  (and `br`, `hr`) is a boundary.  Every run of Unicode whitespace (Python `\\s`) and every boundary becomes one U+0020 space between
  non-space text; leading and trailing spaces are removed.  Nothing else changes: no case folding, no Unicode normalisation, no entity left
  undecoded.  An item without a `<body>` element has empty body text.
* Offsets.  `offset` counts Unicode CODE POINTS of that item's body text (Python string indices), from 0.  An excerpt is the half-open range
  [offset, end); `end` = min(offset + length, characters).  `next_offset` is `end` while text remains after it, else null (continuation:
  call again with offset = next_offset).
* Headings.  Every `h1` to `h6` element inside the body is an OBSERVED heading: its level, the offset where its first character lands in the
  item's body text and its own text under the same rule.  A heading is an observation of the body; it is never a verdict on identity.
* Declared table of contents.  The EPUB 3 navigation document (the manifest item whose `properties` include `nav`; the `<nav>` whose
  `epub:type` includes `toc`; each `<a>`'s text and href), else the EPUB 2 NCX (the spine's `toc` attribute, else the manifest item of media
  type `application/x-dtbncx+xml`; each `navPoint`'s `navLabel/text` and `content@src`).  These labels are DECLARATIONS of the package, never
  body text, and are kept apart from it.  No navigation document: `declared_toc` is null.
* Limits.  `INDEX_ITEMS` spine items in the index (`items_total` gives the count; the rest stay addressable), `HEADINGS_PER_ITEM` headings per
  item (`headings_total` when more exist), `HEADING_CHARS` / `TOC_LABEL_CHARS` code points per heading or label (`clipped: true` when cut),
  `TOC_ENTRIES` entries.  The default call shows the first `DEFAULT_EXCERPT_CHARS` code points of the first `DEFAULT_EXCERPT_ITEMS` spine
  items: a FIXED default that reads no label, title, catalog value or annotation.  Any other range is read only by explicit arguments
  (`spine`, `offset`, `length`), `length` 1 to `MAX_EXCERPT_CHARS` (default `REQUEST_EXCERPT_CHARS`).
* Unavailable stays unavailable.  Text is read only from the EPUB file itself.  When the file cannot be read, nothing is reconstructed from
  titles, catalog data, recorded heads or annotations.
"""
import hashlib
import json
import posixpath
import re
import xml.etree.ElementTree as E
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

RULE_ID = 'xhtml-body-text-3'
UNITS = 'unicode code points of one spine item\'s body text'
BLOCK_TAGS = ('address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
              'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
              'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br', 'hr')
SKIP_TAGS = ('head', 'script', 'style', 'template')
HEADING_TAGS = ('h1', 'h2', 'h3', 'h4', 'h5', 'h6')
NAV_EPUB_TYPES = ('toc', 'landmarks', 'page-list', 'lot', 'loi')
NAV_ROLES = ('doc-toc', 'doc-pagelist', 'navigation')
EPUB_NS = 'http://www.idpf.org/2007/ops'
INDEX_ITEMS = 24
HEADINGS_PER_ITEM = 6
HEADING_CHARS = 120
TOC_ENTRIES = 24
TOC_LABEL_CHARS = 120
DEFAULT_EXCERPT_ITEMS = 3
DEFAULT_EXCERPT_CHARS = 280
REQUEST_EXCERPT_CHARS = 600
MAX_EXCERPT_CHARS = 1200
EXCERPT_ARGS = ('spine', 'offset', 'length')
RULES = {'rule': RULE_ID, 'units': UNITS, 'block_tags': list(BLOCK_TAGS), 'skip_tags': list(SKIP_TAGS), 'heading_tags': list(HEADING_TAGS),
         'whitespace': 'python \\s runs and boundaries -> one U+0020 between text; strip', 'decode': 'utf-8-sig strict', 'parser': 'html.parser convert_charrefs',
         'limits': {'index_items': INDEX_ITEMS, 'headings_per_item': HEADINGS_PER_ITEM, 'heading_chars': HEADING_CHARS, 'toc_entries': TOC_ENTRIES,
                    'toc_label_chars': TOC_LABEL_CHARS, 'default_excerpt_items': DEFAULT_EXCERPT_ITEMS, 'default_excerpt_chars': DEFAULT_EXCERPT_CHARS,
                    'request_excerpt_chars': REQUEST_EXCERPT_CHARS, 'max_excerpt_chars': MAX_EXCERPT_CHARS},
         'toc': 'epub3 nav (properties nav, epub:type toc) else epub2 ncx (spine toc, else media type application/x-dtbncx+xml); declarations',
         'default': 'first default_excerpt_chars code points of the first default_excerpt_items spine items; label independent',
         'navigation': {'elements': ['nav'], 'epub_type': list(NAV_EPUB_TYPES), 'role': list(NAV_ROLES), 'meaning': 'navigation, never body text or observed headings'},
         'names': 'compared by local name (a namespace prefix is ignored)',
         'semantic_attributes': 'P:type is the EPUB type when P is bound in scope to %s; an unbound epub prefix is that namespace' % EPUB_NS}


def rules_digest():
    """sha256 of RULES and of this module's source bytes: a change to the extractor code changes the pin, not only a change to RULES."""
    from pathlib import Path
    h = hashlib.sha256(json.dumps(RULES, sort_keys=True, separators=(',', ':')).encode())
    h.update(b'\0')
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()


def _local(tag):
    return tag.rsplit(':', 1)[-1]


def _bindings(scope, attrs):
    """The namespace prefixes in scope for one element: the enclosing scope plus its own xmlns:P declarations."""
    out = dict(scope)
    for k, v in attrs:
        if k.startswith('xmlns:'):
            out[k[6:]] = v or ''
    return out


def epub_types(attrs, scope):
    """The tokens of every attribute P:type whose prefix P is bound in `scope` to the EPUB namespace (an unbound `epub` prefix counts as bound to it)."""
    out = []
    for k, v in attrs:
        if ':' in k and k.rsplit(':', 1)[1] == 'type' and not k.startswith('xmlns:'):
            prefix = k.rsplit(':', 1)[0]
            ns = scope.get(prefix, EPUB_NS if prefix == 'epub' else None)
            if ns == EPUB_NS:
                out += (v or '').split()
    return out


def _is_nav(tag, attrs, scope=None):
    a = dict(attrs)
    if _local(tag) == 'nav':
        return True
    types = epub_types(attrs, _bindings(scope or {}, attrs))
    roles = (a.get('role') or '').split()
    return any(t in NAV_EPUB_TYPES for t in types) or any(r in NAV_ROLES for r in roles)


class _Scoped(HTMLParser):
    """Namespace-prefix scope per open element (a stack); a void or self-closed element declares only for itself."""

    def reset(self):
        super().reset()
        self.ns = [({}, None)]

    def scope(self):
        return self.ns[-1][0]

    def push(self, tag, attrs):
        self.ns.append((_bindings(self.scope(), attrs), _local(tag)))

    def pop(self, tag):
        name = _local(tag)
        for j in range(len(self.ns) - 1, 0, -1):
            if self.ns[j][1] == name:
                del self.ns[j:]
                return


class _Normaliser:
    """Builds one item's body text incrementally, so a heading's offset is known where its first character lands."""

    def __init__(self):
        self.out, self.n, self.pending = [], 0, False

    def boundary(self):
        self.pending = True

    def data(self, text):
        """-> offset of the first character emitted by this call, or None when it emitted nothing."""
        first = None
        for tok in re.split(r'(\s+)', text):
            if not tok:
                continue
            if tok.isspace() or re.fullmatch(r'\s+', tok):
                self.pending = True
                continue
            if self.pending and self.n:
                self.out.append(' ')
                self.n += 1
            self.pending = False
            if first is None:
                first = self.n
            self.out.append(tok)
            self.n += len(tok)
        return first

    def text(self):
        return ''.join(self.out)


def _norm(text):
    nz = _Normaliser()
    nz.data(text)
    return nz.text()


class _Body(_Scoped):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nz = _Normaliser()
        self.in_body = 0
        self.skip = 0
        self.headings = []          # [{'level', 'offset', 'parts'}] in document order
        self.open_h = []            # indexes into self.headings of the headings being read
        self.nav = []               # open navigation regions: [local name of the element that started it, its open count] (a stack)
        self.nav_chars = 0          # characters of data set apart as navigation (whitespace-collapsed)

    def handle_starttag(self, tag, attrs):
        scope = self.scope()
        self.push(tag, attrs)
        if _is_nav(tag, attrs, scope) and self.in_body:
            self.nav.append([_local(tag), 1])
        elif self.nav and _local(tag) == self.nav[-1][0]:
            self.nav[-1][1] += 1         # a nested element of the same name inside the region
        tag = _local(tag)
        if tag == 'body':
            self.in_body += 1
        if tag in SKIP_TAGS:
            self.skip += 1
        if tag in BLOCK_TAGS:
            self.nz.boundary()
            for i in self.open_h:
                self.headings[i]['parts'].append(' ')
        if tag in HEADING_TAGS and self.in_body and not self.skip and not self.nav:
            self.headings.append({'level': int(tag[1]), 'offset': None, 'parts': []})
            self.open_h.append(len(self.headings) - 1)

    def handle_startendtag(self, tag, attrs):
        if _local(tag) in BLOCK_TAGS:
            self.nz.boundary()
            for i in self.open_h:
                self.headings[i]['parts'].append(' ')

    def handle_endtag(self, tag):
        self.pop(tag)
        tag = _local(tag)
        if self.nav and tag == self.nav[-1][0]:
            self.nav[-1][1] -= 1
            if not self.nav[-1][1]:
                self.nav.pop()
                self.nz.boundary()
        if tag in HEADING_TAGS and self.open_h:
            for j in range(len(self.open_h) - 1, -1, -1):
                if self.headings[self.open_h[j]]['level'] == int(tag[1]):
                    del self.open_h[j:]
                    break
        if tag in BLOCK_TAGS:
            self.nz.boundary()
            for i in self.open_h:
                self.headings[i]['parts'].append(' ')
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        if tag == 'body' and self.in_body:
            self.in_body -= 1

    def handle_data(self, data):
        if not self.in_body or self.skip:
            return
        if self.nav:
            self.nav_chars += len(' '.join(data.split()))
            return
        first = self.nz.data(data)
        for i in self.open_h:
            h = self.headings[i]
            if h['offset'] is None and first is not None:
                h['offset'] = first
            h['parts'].append(data)


def body_text(xhtml_bytes, with_nav=False):
    """-> (text, headings) of one spine member under rule xhtml-body-text-2 (with_nav: also the navigation characters set apart).
    headings: [{'level', 'offset', 'text'}] (an empty heading keeps offset None); a heading inside a navigation region is never one."""
    p = _Body()
    p.feed(xhtml_bytes.decode('utf-8-sig'))
    p.close()
    heads = [{'level': h['level'], 'offset': h['offset'], 'text': _norm(''.join(h['parts']))} for h in p.headings]
    return (p.nz.text(), heads, p.nav_chars) if with_nav else (p.nz.text(), heads)


def _clip(text, n):
    return (text, False) if len(text) <= n else (text[:n], True)


def _spine_members(path, d):
    """The spine items in reading order as the vendored inspector lists them: [member path]."""
    return [s['entry'] for s in d['spine']]


def _resolve(base_member, href):
    u = urlsplit(href)
    return posixpath.normpath(posixpath.join(posixpath.dirname(base_member), unquote(u.path))) if u.path else base_member, (u.fragment or None)


def declared_toc(path, opf):
    """The package's declared table of contents (nav, else NCX) -> {'source', 'document', 'entries', 'entries_total'} or None; never body text."""
    with zipfile.ZipFile(path) as z:
        pkg = E.fromstring(z.read(opf))
        manifest = {}
        for x in pkg.iter():
            if x.tag.endswith('}item') and 'href' in x.attrib:
                member = posixpath.normpath(posixpath.join(posixpath.dirname(opf), unquote(urlsplit(x.attrib['href']).path)))
                manifest[x.attrib.get('id')] = (member, x.attrib.get('media-type'), (x.attrib.get('properties') or '').split())
        nav = next((m for m, _t, props in manifest.values() if 'nav' in props), None)
        entries = []
        source = None
        if nav is not None:
            source = 'nav'
            entries = _nav_entries(z.read(nav).decode('utf-8-sig'), nav)
            doc = nav
        else:
            spine = next((x for x in pkg.iter() if x.tag.endswith('}spine')), None)
            ncx_id = spine.attrib.get('toc') if spine is not None else None
            ncx = manifest.get(ncx_id, (None,))[0] if ncx_id else None
            if ncx is None:
                ncx = next((m for m, t, _p in manifest.values() if t == 'application/x-dtbncx+xml'), None)
            if ncx is None:
                return None
            source, doc = 'ncx', ncx
            root = E.fromstring(z.read(ncx))
            for np_ in root.iter():
                if np_.tag.endswith('}navPoint'):
                    label = next((t for t in np_.iter() if t.tag.endswith('}text')), None)
                    content = next((c for c in np_ if c.tag.endswith('}content')), None)
                    member, frag = _resolve(ncx, content.attrib.get('src', '')) if content is not None else (None, None)
                    entries.append((_norm(''.join(label.itertext())) if label is not None else '', member, frag))
    out = []
    for label, member, frag in entries[:TOC_ENTRIES]:
        text, cut = _clip(label, TOC_LABEL_CHARS)
        e = {'text': text, 'member': member}       # (never `label`: a forbidden output field of the rubric)
        if frag:
            e['fragment'] = frag
        if cut:
            e['clipped'] = True
        out.append(e)
    res = {'source': source, 'document': doc, 'entries': out}
    if len(entries) > TOC_ENTRIES:
        res['entries_total'] = len(entries)
    return res


class _Nav(_Scoped):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.depth, self.toc_depth, self.a, self.entries = base, 0, None, None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        scope = _bindings(self.scope(), attrs)
        self.push(tag, attrs)
        tag = _local(tag)
        if tag == 'nav':
            self.depth += 1
            if self.toc_depth is None and 'toc' in epub_types(attrs, scope):
                self.toc_depth = self.depth
        if tag == 'a' and self.toc_depth is not None:
            self.a = [a.get('href') or '', []]

    def handle_endtag(self, tag):
        self.pop(tag)
        tag = _local(tag)
        if tag == 'a' and self.a is not None:
            member, frag = _resolve(self.base, self.a[0])
            self.entries.append((_norm(''.join(self.a[1])), member, frag))
            self.a = None
        if tag == 'nav':
            if self.toc_depth == self.depth:
                self.toc_depth = None
            self.depth -= 1

    def handle_data(self, data):
        if self.a is not None:
            self.a[1].append(data)


def _nav_entries(text, base):
    p = _Nav(base)
    p.feed(text)
    p.close()
    return p.entries


def _item_index(i, member, text, heads, nav_chars=0, nav_doc=False):
    item = {'spine': i, 'member': member, 'characters': len(text)}
    if nav_doc:
        item['navigation_document'] = True
    if nav_chars:
        item['navigation_characters'] = nav_chars
    hs = []
    for h in heads[:HEADINGS_PER_ITEM]:
        t, cut = _clip(h['text'], HEADING_CHARS)
        e = {'level': h['level'], 'offset': h['offset'], 'text': t}
        if cut:
            e['clipped'] = True
        hs.append(e)
    item['headings'] = hs
    if len(heads) > HEADINGS_PER_ITEM:
        item['headings_total'] = len(heads)
    return item


def excerpt(i, member, text, offset, length):
    end = min(offset + length, len(text))
    return {'spine': i, 'member': member, 'offset': offset, 'end': end, 'item_characters': len(text), 'text': text[offset:end],
            'next_offset': end if end < len(text) else None}


def nav_document(path, opf):
    """The manifest navigation document (properties nav), or None."""
    with zipfile.ZipFile(path) as z:
        pkg = E.fromstring(z.read(opf))
    for x in pkg.iter():
        if x.tag.endswith('}item') and 'href' in x.attrib and 'nav' in (x.attrib.get('properties') or '').split():
            return posixpath.normpath(posixpath.join(posixpath.dirname(opf), unquote(urlsplit(x.attrib['href']).path)))
    return None


def read_items(path, d):
    """-> [(member, text, headings, navigation characters)] for every spine item, in spine order."""
    out = []
    with zipfile.ZipFile(path) as z:
        for member in _spine_members(path, d):
            text, heads, nav_chars = body_text(z.read(member), with_nav=True)
            out.append((member, text, heads, nav_chars))
    return out


def default_body(path, d):
    """The fixed default of `epub_inspect {}` under tools v3: the body index and the default excerpts, plus the declared table of contents."""
    items = read_items(path, d)
    try:
        nav = nav_document(path, d['opf'])
    except Exception:  # noqa: BLE001 - the inspector already parsed this OPF; stay defensive
        nav = None
    body = {'extraction': RULE_ID, 'units': UNITS, 'items_total': len(items),
            'index': [_item_index(i, m, t, h, nc, m == nav) for i, (m, t, h, nc) in enumerate(items[:INDEX_ITEMS])],
            'excerpts': [excerpt(i, m, t, 0, DEFAULT_EXCERPT_CHARS) for i, (m, t, _h, _nc) in enumerate(items[:DEFAULT_EXCERPT_ITEMS])]}
    try:
        toc = declared_toc(path, d['opf'])
    except Exception as e:  # noqa: BLE001 - an unreadable navigation document is reported, never reconstructed
        toc = {'error': 'the declared table of contents could not be read: %s' % type(e).__name__}
    return body, toc


def check_excerpt_args(args):
    """-> (spine, offset, length) of an explicit excerpt request, or raise ValueError (a bad-arguments error).  {} is the default call, not an excerpt."""
    extra = sorted(set(args) - set(EXCERPT_ARGS))
    if extra:
        raise ValueError('epub_inspect takes {} or {"spine": n, "offset": n, "length": n}; unexpected %s' % extra)
    if 'spine' not in args:
        raise ValueError('an excerpt request needs "spine" (a spine position from 0)')

    def integer(k, default, lo, hi):
        v = args.get(k, default)
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise ValueError('%s must be an integer in [%d, %d]' % (k, lo, hi))
        return v
    return integer('spine', None, 0, 9999), integer('offset', 0, 0, 10 ** 8), integer('length', REQUEST_EXCERPT_CHARS, 1, MAX_EXCERPT_CHARS)


def explicit_excerpt(path, d, spine, offset, length):
    members = _spine_members(path, d)
    if spine >= len(members):
        raise ValueError('spine %d is outside the spine (%d items, positions 0 to %d)' % (spine, len(members), len(members) - 1))
    with zipfile.ZipFile(path) as z:
        text, _heads = body_text(z.read(members[spine]))
    if offset > len(text):
        raise ValueError('offset %d is beyond the end of spine item %d (%d code points)' % (offset, spine, len(text)))
    return {'extraction': RULE_ID, 'units': UNITS, 'items_total': len(members), 'excerpt': excerpt(spine, members[spine], text, offset, length)}
