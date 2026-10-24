"""Phone audit renderers. Text and embedded images only; no network and no child process."""

import html
import re
import struct
import zlib

PNG_SIG = b'\x89PNG\r\n\x1a\n'


def png_info(data):
    """Return width, height, and concatenated IDAT bytes for an 8-bit non-interlaced RGB PNG."""
    if not isinstance(data, (bytes, bytearray)) or not data.startswith(PNG_SIG):
        return None
    pos = 8
    width = height = None
    idat = []
    while pos + 8 <= len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        start = pos + 8
        end = start + length
        if end + 4 > len(data):
            return None
        chunk = data[start:end]
        if kind == b'IHDR':
            if length != 13:
                return None
            width, height, bit, color, comp, filt, inter = struct.unpack('>IIBBBBB', chunk)
            if bit != 8 or color != 2 or comp != 0 or filt != 0 or inter != 0:
                return None
        elif kind == b'IDAT':
            idat.append(chunk)
        elif kind == b'IEND':
            break
        pos = end + 4
    if width is None or not idat:
        return None
    return {'width': width, 'height': height, 'idat': b''.join(idat)}


def _md_escape(text):
    return (str(text)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('`', "'"))


def _fence(text):
    body = _md_escape(str(text).replace('\r\n', '\n'))
    return '````\n' + body + '\n````'


def _yn(value):
    return 'yes' if value else 'no'


def render_markdown(findings):
    lines = [
        '# Identity findings (offline)',
        '',
        '- Report version: %s' % _md_escape(findings['reportVersion']),
        '- Manifest version: %s' % _md_escape(findings['manifestVersion']),
        '- Recipe version: %s (not executed)' % _md_escape(findings['recipeVersion']),
        '- Sample: %s' % _md_escape(findings.get('sampleId') or ''),
        '- Input manifest sha256: %s' % _md_escape(findings.get('inputManifestSha256') or ''),
        '- Git sha: %s' % _md_escape(findings.get('gitSha') if findings.get('gitSha') else 'null'),
        '- Git sha reason: %s' % _md_escape(findings.get('gitShaReason') or ''),
        '- Media reads: %s' % findings.get('mediaReads'),
        '- Model calls: %s' % findings.get('modelCalls'),
        '- Network: %s' % findings.get('network'),
        '- Subprocess: %s' % findings.get('subprocess'),
        '- ASR: %s' % findings.get('asr'),
        '- OCR: %s' % findings.get('ocr'),
        '- calibratedProbability: null',
        '- %s' % _md_escape(findings.get('calibratedProbabilityReason') or ''),
        '',
        'Machine issue states are candidate, not-observed-in-sample, unknown, or tool-failed.',
        'Human dispositions are separate and are not an image-match result.',
        '',
    ]
    if findings.get('errors'):
        lines.append('## Manifest')
        lines.append('')
        for error in findings['errors']:
            lines.append('- %s' % _md_escape(error))
        lines.append('')
    lines.append('## Claims')
    lines.append('')
    for claim in findings.get('claims') or []:
        human = claim['humanDisposition']
        lines.append('### %s' % _md_escape(claim['id']))
        lines.append('')
        lines.append('- Kind: %s' % _md_escape(claim['kind']))
        lines.append('- Issue likelihood: %s' % _md_escape(claim['issueLikelihood']))
        lines.append('- Observation: %s' % _md_escape(claim['observationState']))
        lines.append('- Evidence grade: %s' % _md_escape(claim['evidenceGrade']))
        lines.append('- %s' % _md_escape(claim['evidenceGradeNote']))
        lines.append('- Basis: %s' % _md_escape(claim['basis']))
        lines.append('- calibratedProbability: null')
        lines.append('- Confirmed: %s' % _yn(human['confirmed']))
        lines.append('- Contradicted: %s' % _yn(human['contradicted']))
        lines.append('- Uncertain: %s' % _yn(human['uncertain']))
        lines.append('- Not reviewed: %s' % _yn(human['notReviewed']))
        lines.append('- Disposition applies: %s' % _yn(human.get('applies')))
        lines.append('- Reviewer: %s' % _md_escape(human.get('reviewer') or 'not recorded'))
        lines.append('- Reviewed at: %s' % _md_escape(human.get('reviewedAt') or 'not recorded'))
        lines.append('- Inspect: %s' % _md_escape(claim['inspect']))
        lines.append('')
        lines.append(_md_escape(claim['rationale']))
        lines.append('')
        if claim.get('alternatives'):
            lines.append('Alternatives:')
            lines.append('')
            for item in claim['alternatives']:
                lines.append('- %s' % _md_escape(item))
            lines.append('')
        evidence = claim.get('evidence') or {}
        if evidence.get('rawASSDialogue'):
            lines.append('Raw ASS dialogue:')
            lines.append('')
            lines.append(_fence(evidence['rawASSDialogue']))
            lines.append('')
        if evidence.get('preservedOther'):
            lines.append('Preserved non-title text: %s' % _md_escape(evidence['preservedOther']))
            lines.append('')
    lines.append('## Coverage')
    lines.append('')
    for item in findings.get('coverage') or []:
        lines.append('- %s' % _md_escape(item))
    lines.append('')
    execution = findings.get('execution') or {}
    lines.append('## Execution')
    lines.append('')
    lines.append('- Outcome: %s' % _md_escape(execution.get('outcome')))
    lines.append('- Exit code: %s' % execution.get('exitCode'))
    lines.append('- %s' % _md_escape(findings.get('sourceBytesReason') or ''))
    lines.append('')
    lines.append('## Resources')
    lines.append('')
    for collection in (findings.get('resources') or {}).get('collections') or []:
        lines.append('- %s: %s (clean EOF: %s, sourceBytes: null)' % (
            _md_escape(collection.get('forArtifact')),
            _md_escape(collection.get('outcome')),
            _yn(collection.get('cleanEof')),
        ))
    if not (findings.get('resources') or {}).get('collections'):
        lines.append('- No retained collection measurements.')
    lines.append('')
    return '\n'.join(lines)


def _html_claim(claim):
    human = claim['humanDisposition']
    evidence = claim.get('evidence') or {}
    parts = [
        '<section class="claim">',
        '<h2>%s</h2>' % html.escape(claim['id'], quote=True),
        '<p><b>%s</b> · issue %s · observation %s · grade %s</p>' % (
            html.escape(claim['kind'], quote=True),
            html.escape(claim['issueLikelihood'], quote=True),
            html.escape(claim['observationState'], quote=True),
            html.escape(claim['evidenceGrade'], quote=True),
        ),
        '<ul>',
        '<li>Confirmed: %s</li>' % _yn(human['confirmed']),
        '<li>Contradicted: %s</li>' % _yn(human['contradicted']),
        '<li>Uncertain: %s</li>' % _yn(human['uncertain']),
        '<li>Not reviewed: %s</li>' % _yn(human['notReviewed']),
        '<li>Disposition applies: %s</li>' % _yn(human.get('applies')),
        '<li>Reviewer: %s</li>' % html.escape(str(human.get('reviewer') or 'not recorded'), quote=True),
        '<li>Reviewed at: %s</li>' % html.escape(str(human.get('reviewedAt') or 'not recorded'), quote=True),
        '<li>Inspect: %s</li>' % html.escape(claim['inspect'], quote=True),
        '</ul>',
        '<p>%s</p>' % html.escape(claim['rationale'], quote=True),
    ]
    if evidence.get('rawASSDialogue'):
        parts.append('<pre>%s</pre>' % html.escape(evidence['rawASSDialogue'], quote=True))
    if evidence.get('preservedOther'):
        parts.append('<p>Preserved non-title text: %s</p>' % html.escape(str(evidence['preservedOther']), quote=True))
    parts.append('</section>')
    return '\n'.join(parts)


def render_html(findings, images):
    figures = []
    for image in images:
        info = png_info(image['bytes'])
        if info is None:
            figures.append('<p>%s</p>' % html.escape(image['caption'] + ' (not an embeddable PNG)', quote=True))
            continue
        encoded = _b64(image['bytes'])
        figures.append(
            '<figure><img alt="%s" src="data:image/png;base64,%s"><figcaption>%s</figcaption></figure>' % (
                html.escape(image['caption'], quote=True),
                encoded,
                html.escape(image['caption'], quote=True),
            )
        )
    body = [
        '<!DOCTYPE html>',
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Identity findings</title>',
        '<style>',
        'body{font:1.125rem/1.45 sans-serif;margin:16px;max-width:40rem;}',
        'img{width:100%;height:auto;} figure{margin:0 0 1.5rem;}',
        'section{border-top:1px solid #444;padding-top:1rem;margin-top:1rem;}',
        'pre{white-space:pre-wrap;word-break:break-word;}',
        '</style></head><body>',
        '<h1>Identity findings</h1>',
        '<p>Offline report %s. Git %s. Media reads %s. Model calls %s. calibratedProbability is null.</p>' % (
            html.escape(str(findings.get('reportVersion')), quote=True),
            html.escape(str(findings.get('gitSha') or 'not supplied'), quote=True),
            html.escape(str(findings.get('mediaReads')), quote=True),
            html.escape(str(findings.get('modelCalls')), quote=True),
        ),
        '\n'.join(figures),
        '\n'.join(_html_claim(claim) for claim in findings.get('claims') or []),
        '</body></html>',
    ]
    return '\n'.join(body)


def _b64(data):
    import base64
    return base64.standard_b64encode(data).decode('ascii')


def _pdf_text(text):
    raw = str(text).encode('cp1252', errors='replace')
    return b'(' + raw.replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)') + b')'


def _wrap(text, width=90):
    lines = []
    for paragraph in str(text).split('\n'):
        if paragraph == '':
            lines.append('')
            continue
        words = paragraph.split(' ')
        current = ''
        for word in words:
            while len(word) > width:
                lines.append(word[:width])
                word = word[width:]
            trial = word if current == '' else current + ' ' + word
            if len(trial) <= width:
                current = trial
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def render_pdf(markdown, images):
    """A small text-and-PNG PDF. Characters outside cp1252 are replaced; the HTML keeps Unicode."""
    font_id = None
    pages = []
    contents = []
    xobjects = []

    def add_text_pages(text):
        lines = _wrap(text)
        for start in range(0, max(len(lines), 1), 42):
            chunk = lines[start:start + 42]
            commands = [b'BT /F1 10 Tf 48 740 Td 14 TL']
            for line in chunk:
                commands.append(_pdf_text(line) + b' Tj T*')
            commands.append(b'ET')
            contents.append(b'\n'.join(commands))
            pages.append({'images': []})

    add_text_pages(markdown)
    for image in images:
        info = png_info(image['bytes'])
        if info is None:
            add_text_pages(image['caption'] + '\n(not an embeddable PNG)')
            continue
        stream = info['idat']
        if b'\nendstream' in stream or stream.endswith(b'endstream'):
            stream = zlib.compress(zlib.decompress(stream))
        width = min(512, info['width'])
        scale = width / info['width']
        height = info['height'] * scale
        xobjects.append({
            'width': info['width'],
            'height': info['height'],
            'stream': stream,
        })
        caption = _wrap(image['caption'], 80)[:6]
        commands = [
            b'q %s 0 0 %s 50 180 cm /Im%s Do Q' % (
                ('%g' % width).encode(), ('%g' % height).encode(), str(len(xobjects)).encode(),
            ),
            b'BT /F1 10 Tf 50 740 Td 14 TL',
        ]
        for line in caption:
            commands.append(_pdf_text(line) + b' Tj T*')
        commands.append(b'ET')
        contents.append(b'\n'.join(commands))
        pages.append({'images': [len(xobjects)]})

    objects = []

    def add(body):
        objects.append(body)
        return len(objects)

    page_ids = []
    content_ids = []
    image_ids = []
    font_id = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for spec in xobjects:
        image_ids.append(add(
            b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB '
            b'/BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 '
            b'/BitsPerComponent 8 /Columns %d >> /Length %d >>\nstream\n' % (
                spec['width'], spec['height'], spec['width'], len(spec['stream']),
            ) + spec['stream'] + b'\nendstream'
        ))
    for index, page in enumerate(pages):
        content_ids.append(add(b'<< /Length %d >>\nstream\n' % len(contents[index]) + contents[index] + b'\nendstream'))
    for index, page in enumerate(pages):
        xobj = ' '.join('/Im%s %d 0 R' % (number, image_ids[number - 1]) for number in page['images'])
        resources = b'<< /Font << /F1 %d 0 R >>' % font_id
        if xobj:
            resources += (' /XObject << %s >>' % xobj).encode()
        resources += b' >>'
        page_ids.append(add(
            b'<< /Type /Page /Parent PAGES 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources %s >>' % (
                content_ids[index], resources,
            )
        ))
    kids = ' '.join('%d 0 R' % page_id for page_id in page_ids)
    pages_id = add(('<< /Type /Pages /Count %d /Kids [%s] >>' % (len(page_ids), kids)).encode())
    catalog_id = add(b'<< /Type /Catalog /Pages %d 0 R >>' % pages_id)
    built = list(objects)
    token = b'Parent PAGES 0 R'
    replacement = b'Parent %d 0 R' % pages_id
    for page_id in page_ids:
        built[page_id - 1] = built[page_id - 1].replace(token, replacement, 1)
    return _serialize(built, catalog_id)


def _serialize(objects, root):
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += ('%d 0 obj\n' % number).encode() + body + b'\nendobj\n'
    xref = len(out)
    out += ('xref\n0 %d\n' % (len(objects) + 1)).encode()
    out += b'0000000000 65535 f \n'
    for offset in offsets[1:]:
        out += ('%010d 00000 n \n' % offset).encode()
    out += ('trailer<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%EOF' % (
        len(objects) + 1, root, xref,
    )).encode()
    return bytes(out)


def markdown_has_unescaped_markup(text):
    """True when a raw HTML tag survived into the markdown body."""
    return re.search(r'<[A-Za-z!/]', text) is not None
