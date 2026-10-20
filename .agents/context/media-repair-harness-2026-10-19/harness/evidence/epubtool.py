"""EPUB structural collector (stdlib only: zipfile and xml.etree).  Read-only; nothing is extracted to disk.

Stages follow the suite's recorded evidence: zip_open, zip_crc, opf_parse, manifest.  A failure in one of these is
status `error` with cause `input` (the file is damaged; same convention as a failing ffprobe), or cause `tool` when the collector's own limit or the environment (a size cap, a permission error) stopped it.  Later problems
(spine, XHTML, mimetype) are findings inside an `ok` record with `valid: false`."""
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .core import make_record, used_bounds

EPUB_BOUNDS = ('stderr_excerpt_bytes', 'epub_max_members', 'epub_max_uncompressed_bytes', 'epub_max_member_bytes', 'epub_max_opf_bytes', 'epub_max_xhtml_docs')
XHTML_TYPES = ('application/xhtml+xml', 'text/html')
VERSION = 'python %s zipfile+xml.etree (stdlib)' % sys.version.split()[0]


def _local(tag):
    return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''


def _texts(pkg, name):
    return [(x.text or '').strip() for x in pkg.iter() if _local(x.tag) == name and (x.text or '').strip()]


class TooBig(Exception):
    pass


def _read(z, name, cap):
    """Read a member whole, but never more than `cap` bytes: the declared size is not trusted, the bytes actually inflated are counted."""
    info = z.getinfo(name)
    if info.file_size > cap:
        raise TooBig('member %s declares %d bytes, over the %d byte cap' % (name, info.file_size, cap))
    with z.open(info) as f:
        data = f.read(cap + 1)
    if len(data) > cap:
        raise TooBig('member %s inflates past the %d byte cap' % (name, cap))
    return data


def _cause(e):
    """Why a read failed: the collector's own cap or the environment (permissions, I/O) says nothing about the file (`tool`); a damaged archive does (`input`)."""
    return 'tool' if isinstance(e, (TooBig, OSError)) else 'input'


def _err(e):
    return '%s: %s' % (type(e).__name__, str(e)[:200])


def _resolve(base, href):
    parts = urlsplit(href)
    if parts.scheme or parts.netloc:
        return None  # remote resource, not in the archive
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(parts.path)))


def collect_epub(ctx, started):
    b = used_bounds(ctx, EPUB_BOUNDS)
    path = Path(ctx.path)
    out = {'valid': None, 'stages_passed': [], 'findings': []}
    cov_ok = []
    not_verified = ['reading quality, typography and rendering: no reader was run', 'DRM or encryption: not looked for beyond a missing-member check',
                    'whether the content is the right book: only the declared metadata and structure were read']

    def fail(stage, msg, partial_cov=None, cause='input'):
        out.update(valid=False, stage=stage, error=msg)
        return make_record('epub', 'live', 'error', ctx, started, version=VERSION, bounds_used=b, output=out, cause=cause,
                           reason='%s: %s' % (stage, msg), stderr='',
                           coverage={'verified': (partial_cov or []) + ['the check stopped at stage %s' % stage],
                                     'not_verified': ['stages after %s were not reached' % stage] + not_verified})

    try:
        z = zipfile.ZipFile(path)  # opened read-only
    except Exception as e:  # noqa: BLE001 - BadZipFile, OSError, anything the zip layer raises
        return fail('zip_open', _err(e), cause=_cause(e))
    with z:
        infos = z.infolist()
        out['entries'] = len(infos)
        if len(infos) > b['epub_max_members']:
            return fail('zip_open', 'archive has %d members, over the epub_max_members cap of %d; not read (the collector\'s own limit, not a finding about the file)' % (len(infos), b['epub_max_members']), cause='tool')
        declared = sum(i.file_size for i in infos)
        out['uncompressed_bytes_declared'] = declared
        partial = []
        # --- zip_crc: stream every member through the CRC check, within the byte cap
        read_total, checked, crc_fail, crc_cause = 0, 0, None, 'input'
        for i in infos:
            if i.is_dir():
                checked += 1
                continue
            if read_total + i.file_size > b['epub_max_uncompressed_bytes']:
                partial.append('CRC check stopped after %d of %d members: the %d byte cap on uncompressed data would be exceeded' % (
                    checked, len(infos), b['epub_max_uncompressed_bytes']))
                break
            try:
                with z.open(i) as f:
                    n = 0
                    while True:
                        chunk = f.read(1 << 16)
                        if not chunk:
                            break
                        n += len(chunk)
                        if n > i.file_size + 1024:  # lying header: more data than declared
                            raise zipfile.BadZipFile('member %s inflates past its declared size' % i.filename)
                read_total += n
                checked += 1
            except Exception as e:  # noqa: BLE001 - Bad CRC-32, truncated member, unsupported compression
                crc_fail = '%s in member %s' % (_err(e), i.filename)
                crc_cause = _cause(e)
                break
        out['crc_members_checked'] = checked
        if crc_fail:
            return fail('zip_crc', crc_fail, ['central directory readable (%d members)' % len(infos)], cause=crc_cause)
        out['stages_passed'] = ['zip_open', 'zip_crc']
        cov_ok.append('zip central directory read; CRC-32 verified for %d of %d member(s)' % (checked, len(infos)))
        # --- mimetype
        names = [i.filename for i in infos]
        mt = {'present': 'mimetype' in names, 'first_entry': bool(names) and names[0] == 'mimetype'}
        if mt['present']:
            info = z.getinfo('mimetype')
            mt['stored_uncompressed'] = info.compress_type == zipfile.ZIP_STORED
            try:
                mt['content'] = _read(z, 'mimetype', 64).decode('ascii', 'replace').strip()
            except TooBig:
                mt['content'] = '(over 64 bytes)'
        out['mimetype'] = mt
        if not mt['present']:
            out['findings'].append({'severity': 'damage', 'what': 'no mimetype member'})
        else:
            if mt['content'] != 'application/epub+zip':
                out['findings'].append({'severity': 'damage', 'what': 'mimetype content is %r, not application/epub+zip' % mt['content']})
            if not mt['first_entry']:
                out['findings'].append({'severity': 'warning', 'what': 'mimetype is not the first archive member (strict readers refuse this)'})
            if not mt.get('stored_uncompressed'):
                out['findings'].append({'severity': 'warning', 'what': 'mimetype member is compressed (strict readers refuse this)'})
        if 'META-INF/encryption.xml' in names:
            out['findings'].append({'severity': 'warning', 'what': 'META-INF/encryption.xml is present: content may be encrypted or font-obfuscated; it was not examined'})
        # --- container.xml -> OPF
        try:
            raw_c = _read(z, 'META-INF/container.xml', b['epub_max_opf_bytes'])
            if b'<!ENTITY' in raw_c:
                return fail('opf_parse', 'container.xml has entity declarations; not parsed (the collector refuses them)', cov_ok, cause='tool')
            root = ET.fromstring(raw_c)
            rootfiles = [x for x in root.iter() if _local(x.tag) == 'rootfile']
            opf = rootfiles[0].attrib['full-path']
        except Exception as e:  # noqa: BLE001
            return fail('opf_parse', 'container.xml: %s' % _err(e), cov_ok, cause=_cause(e))
        out['opf'] = opf
        if opf not in names:
            return fail('opf_parse', 'container.xml names %s, which is not in the archive' % opf, cov_ok)
        try:
            raw_o = _read(z, opf, b['epub_max_opf_bytes'])
            if b'<!ENTITY' in raw_o:
                return fail('opf_parse', 'the package document has entity declarations; not parsed (the collector refuses them)', cov_ok, cause='tool')
            pkg = ET.fromstring(raw_o)
        except Exception as e:  # noqa: BLE001
            return fail('opf_parse', 'package document: %s' % _err(e), cov_ok, cause=_cause(e))
        out['stages_passed'].append('opf_parse')
        cov_ok.append('container.xml and the package document (OPF) parse')
        out.update(dc_title=_texts(pkg, 'title'), dc_creator=_texts(pkg, 'creator'), dc_language=_texts(pkg, 'language'), dc_identifier=_texts(pkg, 'identifier'))
        if not out['dc_title']:
            out['findings'].append({'severity': 'warning', 'what': 'no dc:title'})
        if not out['dc_identifier']:
            out['findings'].append({'severity': 'warning', 'what': 'no dc:identifier'})
        out['epub_version'] = pkg.attrib.get('version')
        # --- manifest
        manifest = {}
        for x in pkg.iter():
            if _local(x.tag) == 'item' and 'id' in x.attrib and 'href' in x.attrib:
                manifest[x.attrib['id']] = (x.attrib['href'], x.attrib.get('media-type', ''))
        nameset = set(names)
        missing = []
        for href, _t in manifest.values():
            target = _resolve(opf, href)
            if target is not None and target not in nameset:
                missing.append(target)
        out['manifest_items'] = len(manifest)
        if missing:
            out['manifest_missing'] = missing[:10]
            return fail('manifest', 'manifest names %d member(s) that are not in the archive: %s' % (len(missing), missing[:5]), cov_ok)
        out['stages_passed'].append('manifest')
        cov_ok.append('all %d manifest item(s) exist in the archive' % len(manifest))
        # --- spine
        itemrefs = [x.attrib.get('idref') for x in pkg.iter() if _local(x.tag) == 'itemref']
        out['spine_items'] = len(itemrefs)
        unresolved = [r for r in itemrefs if r not in manifest]
        if not itemrefs:
            out['findings'].append({'severity': 'damage', 'what': 'the spine lists no items'})
        if unresolved:
            out['findings'].append({'severity': 'damage', 'what': 'spine idref(s) not in the manifest: %s' % unresolved[:5]})
        docs = []
        for r in itemrefs:
            if r in manifest:
                href, mtype = manifest[r]
                target = _resolve(opf, href)
                if target:
                    docs.append((target, mtype))
        # --- XHTML parse of spine documents, within the caps
        parsed, failed, skipped_big, skipped_entity, chars = 0, [], 0, 0, 0
        todo = docs[:b['epub_max_xhtml_docs']]
        for target, mtype in todo:
            info = z.getinfo(target)
            if info.file_size > b['epub_max_member_bytes']:
                skipped_big += 1
                continue
            try:
                raw = _read(z, target, b['epub_max_member_bytes'])
            except TooBig:
                skipped_big += 1
                continue
            except Exception as e:  # noqa: BLE001 - e.g. a member the zip layer cannot inflate
                failed.append({'member': target, 'error': _err(e)})
                continue
            if b'<!ENTITY' in raw:
                skipped_entity += 1  # internal entity declarations are not expanded here
                continue
            try:
                tree = ET.fromstring(raw)
                parsed += 1
                chars += sum(len((t or '').strip()) for t in tree.itertext())
            except ET.ParseError as e:
                failed.append({'member': target, 'error': _err(e)})
        out['xhtml'] = {'spine_documents': len(docs), 'parsed_ok': parsed, 'parse_failed': failed[:10], 'parse_failed_count': len(failed),
                        'skipped_over_size_cap': skipped_big, 'skipped_entity_declarations': skipped_entity,
                        'skipped_over_doc_cap': max(0, len(docs) - len(todo))}
        out['spine_characters'] = chars
        if failed:
            out['findings'].append({'severity': 'damage', 'what': '%d spine document(s) are not well-formed XML (first: %s)' % (len(failed), failed[0]['member'])})
        if parsed and chars == 0:
            out['findings'].append({'severity': 'damage', 'what': 'the parsed spine documents contain no text'})
        cov_ok.append('%d of %d spine document(s) parsed as XML; %d characters of text seen' % (parsed, len(docs), chars))
        for k, msg in (('skipped_over_size_cap', 'spine document(s) over the epub_max_member_bytes cap were not parsed'),
                       ('skipped_entity_declarations', 'spine document(s) with entity declarations were not parsed'),
                       ('skipped_over_doc_cap', 'spine document(s) beyond the epub_max_xhtml_docs cap were not parsed')):
            if out['xhtml'][k]:
                partial.append('%d %s' % (out['xhtml'][k], msg))
        damage = [f for f in out['findings'] if f['severity'] == 'damage']
        out['valid'] = not damage
        out['stages_passed'].append('spine')
    status = 'partial' if partial else 'ok'
    return make_record('epub', 'live', status, ctx, started, version=VERSION, bounds_used=b, output=out, stderr='',
                       reason='; '.join(partial) or None, coverage={'verified': cov_ok, 'not_verified': not_verified + partial})
