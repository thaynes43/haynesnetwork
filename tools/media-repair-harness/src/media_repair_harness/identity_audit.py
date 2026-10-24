"""Phone audit renderers. Text and embedded images only; no network and no child process."""

import html
import re
import struct
import zlib

PNG_SIG = b'\x89PNG\r\n\x1a\n'
PAGE_W = 612
PAGE_H = 792
MARGIN = 48
FONT = 10
LEADING = 14
# Helvetica '@' is 1.015 em in the standard AFM. 1.02 em is the worst cp1252 advance used for wrapping.
GLYPH_EM = 1.02
EM = FONT * GLYPH_EM
PDF_NOTE = (
    'PDF encoding: WinAnsiEncoding (cp1252). Characters outside that set are written as '
    '<U+XXXX>. This is not the character itself. The HTML and the markdown keep the exact UTF-8 text.'
)


def png_header(data):
    """IHDR fields for a PNG with a positive size. invalid, truncated, or None otherwise."""
    if not isinstance(data, (bytes, bytearray)) or not data.startswith(PNG_SIG):
        return None
    # Signature (8) + length (4) + 'IHDR' (4) + 13 data bytes. Shorter input is not unpacked.
    if len(data) < 29:
        return 'truncated'
    try:
        length = struct.unpack('>I', data[8:12])[0]
        if data[12:16] != b'IHDR' or length != 13:
            return None
        width, height, bit, color, comp, filt, inter = struct.unpack('>IIBBBBB', data[16:29])
    except struct.error:
        return 'truncated'
    if width < 1 or height < 1:
        return 'invalid'
    return {
        'width': width,
        'height': height,
        'bit': bit,
        'color': color,
        'compression': comp,
        'filter': filt,
        'interlace': inter,
    }


def png_info(data):
    """Width, height, and IDAT bytes for an 8-bit non-interlaced RGB PNG with a positive size."""
    header = png_header(data)
    if not isinstance(header, dict):
        return None
    if header['bit'] != 8 or header['color'] != 2 or header['compression'] != 0 or header['filter'] != 0 or header['interlace'] != 0:
        return None
    pos = 8
    idat = []
    while pos + 8 <= len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        start = pos + 8
        end = start + length
        if end + 4 > len(data):
            return None
        chunk = data[start:end]
        if kind == b'IDAT':
            idat.append(chunk)
        elif kind == b'IEND':
            break
        pos = end + 4
    if not idat:
        return None
    return {'width': header['width'], 'height': header['height'], 'idat': b''.join(idat)}


def _pdf_plain(text):
    """Canonical PDF text for one inline field.

    A carriage return or line feed is a space in the drawing. findings.json keeps the
    original characters. There is no Markdown escaping and no unescaping of source text.
    """
    if text is None:
        return ''
    return str(text).replace('\r\n', '\n').replace('\r', '\n').replace('\n', ' ')


def _pdf_fence(text):
    """Multiline evidence for the PDF. Each source line is prefixed so it is not a report row."""
    body = '' if text is None else str(text).replace('\r\n', '\n').replace('\r', '\n')
    lines = ['| (raw evidence, not a report row)']
    for line in body.split('\n'):
        lines.append('| ' + line)
    return '\n'.join(lines)


def _md_escape(text):
    """Make untrusted text inert in Markdown, including link and image syntax."""
    body = str(text).replace('\r\n', '\n').replace('\r', '\n').replace('\n', ' ')
    body = (body
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('`', "'")
            .replace('!', '&#33;')
            .replace('[', '&#91;')
            .replace(']', '&#93;')
            .replace('(', '&#40;')
            .replace(')', '&#41;'))
    return body


def _fence(text):
    body = str(text).replace('\r\n', '\n').replace('\r', '\n').replace('`', "'")
    body = (body
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('!', '&#33;')
            .replace('[', '&#91;')
            .replace(']', '&#93;')
            .replace('(', '&#40;')
            .replace(')', '&#41;'))
    return '````\n' + body + '\n````'


def _yn(value):
    return 'yes' if value else 'no'


def _execution(findings):
    return findings.get('execution') or {}


def render_markdown(findings, plain=False):
    """Markdown for the text report. plain=True is the PDF's canonical text, not an unescape pass."""
    front, detail = _report_sections(findings, plain)
    return '\n'.join(front + detail)


def pdf_sections(findings):
    """Front text, then the detail text. The PDF does not search rendered text for this split."""
    front, detail = _report_sections(findings, plain=True)
    return '\n'.join(front), '\n'.join(detail)


def _report_sections(findings, plain=False):
    escape = _pdf_plain if plain else _md_escape
    fence = _pdf_fence if plain else _fence
    execution = _execution(findings)
    lines = [
        '# Identity findings (offline)',
        '',
        '## Outcome',
        '',
        '- Outcome: %s' % escape(execution.get('outcome')),
        '- Exit code: %s' % escape(execution.get('exitCode')),
        '- Validation ok: %s' % _yn((findings.get('validation') or {}).get('ok')),
        '- Media reads: %s' % findings.get('mediaReads'),
        '- Model calls: %s' % findings.get('modelCalls'),
        '- calibratedProbability: null',
        '- %s' % escape(findings.get('calibratedProbabilityReason') or ''),
        '',
    ]
    contradictions = (findings.get('validation') or {}).get('contradictions') or []
    lines.append('## Contradictions')
    lines.append('')
    if findings.get('errors'):
        for error in findings['errors']:
            lines.append('- Manifest: %s' % escape(error))
    if contradictions:
        for item in contradictions:
            lines.append('- %s' % escape(item))
    if not findings.get('errors') and not contradictions:
        lines.append('- None recorded.')
    lines.append('')
    lines.extend(_markdown_comparisons(findings, escape))
    lines.extend(_markdown_people(findings, escape))
    lines.extend(_markdown_frames(findings, escape))
    front = lines
    lines = ['## Detail', '']
    lines.append('- Report version: %s' % escape(findings.get('reportVersion')))
    lines.append('- Manifest version: %s' % escape(findings.get('manifestVersion')))
    lines.append('- Recipe version: %s (not executed)' % escape(findings.get('recipeVersion')))
    lines.append('- Sample: %s' % escape(findings.get('sampleId') or ''))
    lines.append('- Input manifest sha256: %s' % escape(findings.get('inputManifestSha256') or ''))
    lines.append('- Git sha: %s' % escape(findings.get('gitSha') if findings.get('gitSha') else 'null'))
    lines.append('- Git sha reason: %s' % escape(findings.get('gitShaReason') or ''))
    lines.append('- Network: %s' % findings.get('network'))
    lines.append('- Subprocess: %s' % findings.get('subprocess'))
    lines.append('- ASR: %s' % findings.get('asr'))
    lines.append('- OCR: %s' % findings.get('ocr'))
    lines.append('')
    lines.append('Machine issue states are candidate, not-observed-in-sample, unknown, or tool-failed.')
    lines.append('Human dispositions are separate and are not an image-match result.')
    lines.append('A folded title match is ambiguous. It does not prove the same title or the same episode.')
    lines.append('')
    lines.append('## Claims')
    lines.append('')
    for claim in findings.get('claims') or []:
        lines.extend(_markdown_claim(claim, escape, fence))
    lines.append('## Coverage')
    lines.append('')
    for item in findings.get('coverage') or []:
        lines.append('- %s' % escape(item))
    if not findings.get('coverage'):
        lines.append('- No coverage notes.')
    lines.append('')
    lines.append('## Resources')
    lines.append('')
    lines.append('- %s' % escape(findings.get('sourceBytesReason') or ''))
    for collection in (findings.get('resources') or {}).get('collections') or []:
        lines.append('- %s: %s (clean EOF: %s, sourceBytes: null, recordedSourceBytes: %s, elapsedSeconds: %s, peakRSSKiB: %s)' % (
            escape(collection.get('forArtifact')),
            escape(collection.get('outcome')),
            _yn(collection.get('cleanEof')),
            escape(collection.get('recordedSourceBytes')),
            escape(collection.get('elapsedSeconds')),
            escape(collection.get('peakRSSKiB')),
        ))
    if not (findings.get('resources') or {}).get('collections'):
        lines.append('- No retained collection measurements.')
    lines.append('')
    return front, lines


def _markdown_comparisons(findings, escape=_md_escape):
    lines = ['## Compared titles', '']
    items = findings.get('items') or []
    if not items:
        lines.append('- No catalog labels were available.')
        lines.append('')
    for item in items:
        claim = item.get('catalogClaim') or {}
        echo = item.get('catalog') or {}
        lines.append('- %s file %s catalog label %s episode %s season %s agreement %s snapshot path %s' % (
            escape(item.get('alias')),
            escape(item.get('fileId')),
            escape(claim.get('title')),
            escape(claim.get('episodeCode')),
            escape(claim.get('seasonNumber')),
            escape(item.get('catalogAgreement')),
            escape(echo.get('relativePath') if isinstance(echo, dict) else None),
        ))
    lines.append('')
    any_pair = False
    for claim in findings.get('claims') or []:
        evidence = claim.get('evidence') or {}
        pairs = evidence.get('pairs') or []
        cues = evidence.get('cues') or []
        if not pairs and not evidence.get('text') and not cues:
            continue
        any_pair = True
        lines.append('### %s' % escape(claim.get('id')))
        lines.append('')
        lines.append('- Issue likelihood: %s' % escape(claim.get('issueLikelihood')))
        lines.append('- Evidence grade: %s' % escape(claim.get('evidenceGrade')))
        lines.append('- Title relation: %s' % escape(evidence.get('titleRelation') or evidence.get('ownCatalogRelation')))
        if evidence.get('text'):
            lines.append('- Cue text: %s' % escape(evidence.get('text')))
            lines.append('- Cue style: %s' % escape(evidence.get('style')))
            lines.append('- Cue start: %s' % escape(evidence.get('start')))
            lines.append('- Cue end: %s' % escape(evidence.get('end')))
            lines.append('- Stream index: %s' % escape(evidence.get('streamIndex')))
            lines.append('- Probe: %s' % escape(evidence.get('probe')))
            lines.append('- Receipt: %s' % escape(evidence.get('receipt')))
        for cue in cues:
            lines.append('- Cue %s: %s' % (escape(cue.get('artifactId')), escape(cue.get('text'))))
        for pair in pairs:
            lines.append('- Pair %s catalog %s versus cue %s (%s)' % (
                escape(pair.get('catalogAlias')),
                escape(pair.get('catalogTitle')),
                escape(pair.get('cueText')),
                escape(pair.get('titleRelation')),
            ))
            lines.append('  - Catalog file %s season %s' % (
                escape(pair.get('catalogFileId')),
                escape(pair.get('catalogSeason')),
            ))
            lines.append('  - Catalog fold: %s' % escape(', '.join(pair.get('catalogTransformations') or []) or 'none'))
            lines.append('  - Cue fold: %s' % escape(', '.join(pair.get('cueTransformations') or []) or 'none'))
            lines.append('  - Season labels are mismatch evidence: %s' % _yn(pair.get('seasonLabelsAreMismatchEvidence')))
        transforms = evidence.get('transformations') or {}
        if transforms:
            lines.append('- Own catalog fold: %s' % escape(', '.join(transforms.get('catalog') or []) or 'none'))
            lines.append('- Own cue fold: %s' % escape(', '.join(transforms.get('cue') or []) or 'none'))
        lines.append('')
    if not any_pair and items:
        lines.append('- No title pair was compared.')
        lines.append('')
    return lines


def _markdown_people(findings, escape=_md_escape):
    lines = ['## Human dispositions', '']
    claims = findings.get('claims') or []
    if not claims:
        lines.append('- No human disposition was applied. A missing disposition is not a review.')
        lines.append('')
    for claim in claims:
        human = claim.get('humanDisposition') or {}
        lines.append('- %s: confirmed %s, contradicted %s, uncertain %s, not reviewed %s, applies %s (%s)' % (
            escape(claim.get('id')),
            _yn(human.get('confirmed')),
            _yn(human.get('contradicted')),
            _yn(human.get('uncertain')),
            _yn(human.get('notReviewed')),
            _yn(human.get('applies')),
            escape(human.get('appliesReason') or 'not recorded'),
        ))
        lines.append('  - Quote: %s' % escape(human.get('quote') or 'not recorded'))
        lines.append('  - Citation: %s' % escape(human.get('citation') or 'not recorded'))
        lines.append('  - Reviewer: %s' % escape(human.get('reviewer') or 'not recorded'))
        lines.append('  - Reviewed at: %s' % escape(human.get('reviewedAt') or 'not recorded'))
        for pin in human.get('pinCheck') or []:
            lines.append('  - Reviewed %s digest %s manifest %s disk %s match %s' % (
                escape(pin.get('id')),
                escape(pin.get('reviewed')),
                escape(pin.get('manifest')),
                escape(pin.get('diskStatus')),
                _yn(pin.get('match')),
            ))
    lines.append('')
    lines.append('## Cited notes')
    lines.append('')
    notes = findings.get('citedNotes') or []
    if not notes:
        lines.append('- None copied.')
    for note in notes:
        if isinstance(note, dict):
            lines.append('- %s (%s)' % (escape(note.get('text')), escape(note.get('basis'))))
        else:
            lines.append('- %s' % escape(note))
    lines.append('')
    return lines


def _markdown_frames(findings, escape=_md_escape):
    lines = ['## Retained frames', '']
    found = False
    for claim in findings.get('claims') or []:
        for frame in (claim.get('evidence') or {}).get('frames') or []:
            found = True
            lines.append('- %s file %s at %ss sha256 %s usable %s' % (
                escape(frame.get('alias')),
                escape(frame.get('fileId')),
                escape(frame.get('atSeconds')),
                escape(frame.get('sha256')),
                _yn(frame.get('usable')),
            ))
    if not found:
        lines.append('- No sampled frame was listed.')
    lines.append('')
    lines.append('The HTML file embeds a supported PNG directly. The PDF draws an 8-bit RGB PNG when the page can hold it and otherwise names the frame without inventing pixels.')
    lines.append('')
    return lines


def _markdown_claim(claim, escape=_md_escape, fence=_fence):
    human = claim.get('humanDisposition') or {}
    lines = [
        '### %s' % escape(claim.get('id')),
        '',
        '- Kind: %s' % escape(claim.get('kind')),
        '- Issue likelihood: %s' % escape(claim.get('issueLikelihood')),
        '- Observation: %s' % escape(claim.get('observationState')),
        '- Evidence grade: %s' % escape(claim.get('evidenceGrade')),
        '- %s' % escape(claim.get('evidenceGradeNote')),
        '- Basis: %s' % escape(claim.get('basis')),
        '- calibratedProbability: null',
        '- Disposition applies: %s (%s)' % (_yn(human.get('applies')), escape(human.get('appliesReason') or 'not recorded')),
        '- Inspect: %s' % escape(claim.get('inspect')),
        '',
        escape(claim.get('rationale')),
        '',
    ]
    for item in claim.get('alternatives') or []:
        lines.append('- Alternative: %s' % escape(item))
    if claim.get('alternatives'):
        lines.append('')
    evidence = claim.get('evidence') or {}
    if evidence.get('rawASSDialogue'):
        lines.append('Raw ASS dialogue:')
        lines.append('')
        lines.append(fence(evidence['rawASSDialogue']))
        lines.append('')
    if evidence.get('preservedOther'):
        lines.append('Preserved non-title text: %s' % escape(evidence['preservedOther']))
        lines.append('')
    return lines


def _html_claim(claim):
    human = claim.get('humanDisposition') or {}
    evidence = claim.get('evidence') or {}
    parts = [
        '<section class="claim">',
        '<h2>%s</h2>' % html.escape(str(claim.get('id')), quote=True),
        '<p><b>%s</b> · issue %s · observation %s · grade %s</p>' % (
            html.escape(str(claim.get('kind')), quote=True),
            html.escape(str(claim.get('issueLikelihood')), quote=True),
            html.escape(str(claim.get('observationState')), quote=True),
            html.escape(str(claim.get('evidenceGrade')), quote=True),
        ),
        '<ul>',
        '<li>Confirmed: %s</li>' % _yn(human.get('confirmed')),
        '<li>Contradicted: %s</li>' % _yn(human.get('contradicted')),
        '<li>Uncertain: %s</li>' % _yn(human.get('uncertain')),
        '<li>Not reviewed: %s</li>' % _yn(human.get('notReviewed')),
        '<li>Disposition applies: %s (%s)</li>' % (
            _yn(human.get('applies')),
            html.escape(str(human.get('appliesReason') or 'not recorded'), quote=True),
        ),
        '<li>Quote: %s</li>' % html.escape(str(human.get('quote') or 'not recorded'), quote=True),
        '<li>Citation: %s</li>' % html.escape(str(human.get('citation') or 'not recorded'), quote=True),
        '<li>Reviewer: %s</li>' % html.escape(str(human.get('reviewer') or 'not recorded'), quote=True),
        '<li>Reviewed at: %s</li>' % html.escape(str(human.get('reviewedAt') or 'not recorded'), quote=True),
        '<li>Inspect: %s</li>' % html.escape(str(claim.get('inspect') or ''), quote=True),
        '</ul>',
        '<p>%s</p>' % html.escape(str(claim.get('rationale') or ''), quote=True),
    ]
    if evidence.get('rawASSDialogue'):
        parts.append('<pre>%s</pre>' % html.escape(evidence['rawASSDialogue'], quote=True))
    if evidence.get('preservedOther'):
        parts.append('<p>Preserved non-title text: %s</p>' % html.escape(str(evidence['preservedOther']), quote=True))
    parts.append('</section>')
    return '\n'.join(parts)


def _html_front(findings):
    execution = _execution(findings)
    validation = findings.get('validation') or {}
    parts = [
        '<h1>Identity findings</h1>',
        '<p>Outcome %s. Exit %s. Validation ok: %s. Media reads %s. Model calls %s. calibratedProbability is null.</p>' % (
            html.escape(str(execution.get('outcome')), quote=True),
            html.escape(str(execution.get('exitCode')), quote=True),
            _yn(validation.get('ok')),
            html.escape(str(findings.get('mediaReads')), quote=True),
            html.escape(str(findings.get('modelCalls')), quote=True),
        ),
        '<h2>Contradictions</h2>',
        '<ul>',
    ]
    rows = list(findings.get('errors') or []) + list(validation.get('contradictions') or [])
    if not rows:
        parts.append('<li>None recorded.</li>')
    for row in rows:
        parts.append('<li>%s</li>' % html.escape(str(row), quote=True))
    parts.append('</ul>')
    parts.append('<h2>Compared titles</h2><ul>')
    for item in findings.get('items') or []:
        claim = item.get('catalogClaim') or {}
        echo = item.get('catalog') if isinstance(item.get('catalog'), dict) else {}
        reasons = item.get('catalogReasons') or []
        parts.append('<li>%s file %s label %s episode %s season %s agreement %s path %s reasons %s</li>' % (
            html.escape(str(item.get('alias')), quote=True),
            html.escape(str(item.get('fileId')), quote=True),
            html.escape(str(claim.get('title')), quote=True),
            html.escape(str(claim.get('episodeCode')), quote=True),
            html.escape(str(claim.get('seasonNumber')), quote=True),
            html.escape(str(item.get('catalogAgreement')), quote=True),
            html.escape(str(echo.get('relativePath')), quote=True),
            html.escape('; '.join(str(reason) for reason in reasons) or 'none', quote=True),
        ))
    if not findings.get('items'):
        parts.append('<li>No catalog labels were available.</li>')
    parts.append('</ul>')
    for claim in findings.get('claims') or []:
        evidence = claim.get('evidence') or {}
        if not evidence.get('pairs') and not evidence.get('text'):
            continue
        parts.append('<h3>%s</h3>' % html.escape(str(claim.get('id')), quote=True))
        parts.append('<p>Issue %s. Grade %s. Relation %s.</p>' % (
            html.escape(str(claim.get('issueLikelihood')), quote=True),
            html.escape(str(claim.get('evidenceGrade')), quote=True),
            html.escape(str(evidence.get('titleRelation') or evidence.get('ownCatalogRelation')), quote=True),
        ))
        if evidence.get('text'):
            transforms = evidence.get('transformations') or {}
            parts.append('<p>Cue on item %s: %s from %s to %s. Probe %s. Receipt %s. Catalog fold %s. Cue fold %s.</p>' % (
                html.escape(str((claim.get('subjects') or [{}])[0].get('itemId')), quote=True),
                html.escape(str(evidence.get('text')), quote=True),
                html.escape(str(evidence.get('start')), quote=True),
                html.escape(str(evidence.get('end')), quote=True),
                html.escape(str(evidence.get('probe')), quote=True),
                html.escape(str(evidence.get('receipt')), quote=True),
                html.escape(', '.join(transforms.get('catalog') or []) or 'none', quote=True),
                html.escape(', '.join(transforms.get('cue') or []) or 'none', quote=True),
            ))
        for pair in evidence.get('pairs') or []:
            parts.append('<p>%s catalog “%s” versus cue item %s “%s” (%s). Catalog fold %s. Cue fold %s. File %s.</p>' % (
                html.escape(str(pair.get('catalogAlias')), quote=True),
                html.escape(str(pair.get('catalogTitle')), quote=True),
                html.escape(str(pair.get('cueItemId')), quote=True),
                html.escape(str(pair.get('cueText')), quote=True),
                html.escape(str(pair.get('titleRelation')), quote=True),
                html.escape(', '.join(pair.get('catalogTransformations') or []) or 'none', quote=True),
                html.escape(', '.join(pair.get('cueTransformations') or []) or 'none', quote=True),
                html.escape(str(pair.get('catalogFileId')), quote=True),
            ))
    parts.append('<h2>Human dispositions and cited notes</h2><ul>')
    for claim in findings.get('claims') or []:
        human = claim.get('humanDisposition') or {}
        parts.append('<li>%s applies %s (%s). Quote: %s Citation: %s</li>' % (
            html.escape(str(claim.get('id')), quote=True),
            _yn(human.get('applies')),
            html.escape(str(human.get('appliesReason') or 'not recorded'), quote=True),
            html.escape(str(human.get('quote') or 'not recorded'), quote=True),
            html.escape(str(human.get('citation') or 'not recorded'), quote=True),
        ))
        for pin in human.get('pinCheck') or []:
            parts.append('<li>Pin %s reviewed %s manifest %s disk %s match %s</li>' % (
                html.escape(str(pin.get('id')), quote=True),
                html.escape(str(pin.get('reviewed')), quote=True),
                html.escape(str(pin.get('manifest')), quote=True),
                html.escape(str(pin.get('diskStatus')), quote=True),
                _yn(pin.get('match')),
            ))
    parts.append('</ul><h2>Collections</h2><ul>')
    collections = (findings.get('resources') or {}).get('collections') or []
    if not collections:
        parts.append('<li>No retained collection measurements.</li>')
    for collection in collections:
        parts.append('<li>%s outcome %s clean EOF %s exit %s stderr %s sourceBytes null</li>' % (
            html.escape(str(collection.get('forArtifact')), quote=True),
            html.escape(str(collection.get('outcome')), quote=True),
            _yn(collection.get('cleanEof')),
            html.escape(str(collection.get('exitCode')), quote=True),
            html.escape(str(collection.get('stderr') or 'not recorded'), quote=True),
        ))
    parts.append('</ul><h2>Cited notes</h2><ul>')
    for note in findings.get('citedNotes') or []:
        if isinstance(note, dict):
            parts.append('<li>Note: %s (%s)</li>' % (
                html.escape(str(note.get('text')), quote=True),
                html.escape(str(note.get('basis')), quote=True),
            ))
    if not findings.get('claims') and not findings.get('citedNotes'):
        parts.append('<li>No human disposition was applied.</li>')
    parts.append('</ul>')
    return '\n'.join(parts)


def render_html(findings, images):
    figures = ['<h2>Retained frames</h2>']
    if not images:
        figures.append('<p>No sampled frame was embedded.</p>')
    for image in images:
        caption = image.get('caption') or ''
        status = image.get('png')
        if status == 'invalid':
            figures.append('<p>%s Rendering unavailable: the PNG dimensions are not positive. No pixels were invented.</p>' % html.escape(caption, quote=True))
            continue
        if status not in ('rgb', 'other'):
            figures.append('<p>%s Rendering unavailable: not a PNG. The sha256 in the caption is the retained digest. No pixels were invented.</p>' % html.escape(caption, quote=True))
            continue
        encoded = _b64(image['bytes'])
        figures.append(
            '<figure><img alt="%s" src="data:image/png;base64,%s"><figcaption>%s</figcaption></figure>' % (
                html.escape(caption, quote=True),
                encoded,
                html.escape(caption, quote=True),
            )
        )
    body = [
        '<!DOCTYPE html>',
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">',
        '<title>Identity findings</title>',
        '<style>',
        'body{font:1.125rem/1.45 sans-serif;margin:16px;max-width:40rem;}',
        'img{width:100%;height:auto;} figure{margin:0 0 1.5rem;}',
        'section{border-top:1px solid #444;padding-top:1rem;margin-top:1rem;}',
        'pre{white-space:pre-wrap;word-break:break-word;}',
        'li,figcaption,p{overflow-wrap:anywhere;}',
        '</style></head><body>',
        _html_front(findings),
        '\n'.join(figures),
        '<p>Git %s. Offline report %s.</p>' % (
            html.escape(str(findings.get('gitSha') or 'not supplied'), quote=True),
            html.escape(str(findings.get('reportVersion')), quote=True),
        ),
        '\n'.join(_html_claim(claim) for claim in findings.get('claims') or []),
        '</body></html>',
    ]
    return '\n'.join(body)


def _b64(data):
    import base64
    return base64.standard_b64encode(data).decode('ascii')


def _pdf_expanded(text, replaced):
    """Visible WinAnsi text. Characters outside cp1252 are already <U+XXXX> before wrapping."""
    pieces = []
    for char in str(text):
        try:
            char.encode('cp1252')
        except UnicodeEncodeError:
            pieces.append('<U+%04X>' % ord(char))
            replaced.append(char)
            continue
        pieces.append(char)
    return ''.join(pieces)


def _pdf_literal(text, replaced):
    expanded = _pdf_expanded(text, replaced)
    raw = expanded.encode('cp1252').replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)')
    return b'(' + raw + b')'


def _wrap(text, width_pt):
    limit = max(1, int(width_pt // EM))
    lines = []
    for paragraph in str(text).split('\n'):
        if paragraph == '':
            lines.append('')
            continue
        words = paragraph.split(' ')
        current = ''
        for word in words:
            while len(word) > limit:
                lines.append(word[:limit])
                word = word[limit:]
            trial = word if current == '' else current + ' ' + word
            if len(trial) <= limit:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def _fit_image(width, height, box_w, box_h):
    """Scale a portrait or landscape image into the content box. Never leaves the box."""
    if width < 1 or height < 1 or box_w < 1 or box_h < 1:
        return None
    scale = min(box_w / float(width), box_h / float(height))
    return width * scale, height * scale


def render_pdf(front, images, detail=''):
    """Draw the front block, then frames, then detail.

    Those sections are arguments. Untrusted text is not searched for a section heading.
    """
    replaced = []
    content_width = PAGE_W - 2 * MARGIN
    pages = []
    contents = []
    xobjects = []

    def add_text_pages(text):
        lines = _wrap(_pdf_expanded(text, replaced), content_width)
        for start in range(0, max(len(lines), 1), 46):
            chunk = lines[start:start + 46]
            commands = [b'BT /F1 10 Tf %d %d Td %d TL' % (MARGIN, PAGE_H - MARGIN - FONT, LEADING)]
            for line in chunk:
                commands.append(_pdf_literal(line, replaced) + b' Tj T*')
            commands.append(b'ET')
            contents.append(b'\n'.join(commands))
            pages.append({'images': []})

    def add_image(image):
        info = png_info(image.get('bytes') or b'')
        caption = _pdf_plain(image.get('caption') or '')
        if info is None:
            reason = image.get('png')
            if reason == 'invalid':
                label = 'Rendering unavailable: PNG dimensions are not positive.'
            elif reason == 'other':
                label = 'Rendering unavailable in this PDF: not an 8-bit non-interlaced RGB PNG. The HTML embeds the PNG bytes.'
            else:
                label = 'Rendering unavailable: not a PNG. No pixels were invented.'
            add_text_pages(caption + '\n' + label)
            return
        caption_lines = _wrap(_pdf_expanded(caption, replaced), content_width)[:4]
        caption_block = max(LEADING, len(caption_lines) * LEADING)
        box_h = PAGE_H - 2 * MARGIN - caption_block - LEADING
        fitted = _fit_image(info['width'], info['height'], content_width, box_h)
        if fitted is None:
            add_text_pages(caption + '\nRendering unavailable: the image does not fit the page.')
            return
        draw_w, draw_h = fitted
        stream = info['idat']
        if b'\nendstream' in stream or stream.endswith(b'endstream'):
            try:
                stream = zlib.compress(zlib.decompress(stream))
            except zlib.error:
                add_text_pages(caption + '\nRendering unavailable: the PNG image data could not be inflated.')
                return
        xobjects.append({'width': info['width'], 'height': info['height'], 'stream': stream})
        image_bottom = MARGIN
        commands = [
            b'BT /F1 10 Tf %d %d Td %d TL' % (MARGIN, PAGE_H - MARGIN - FONT, LEADING),
        ]
        for line in caption_lines:
            commands.append(_pdf_literal(line, replaced) + b' Tj T*')
        commands.append(b'ET')
        commands.append(b'q %s 0 0 %s %d %d cm /Im%s Do Q' % (
            _num(draw_w), _num(draw_h), MARGIN, image_bottom, str(len(xobjects)).encode(),
        ))
        contents.append(b'\n'.join(commands))
        pages.append({'images': [len(xobjects)]})

    add_text_pages(front)
    for image in images:
        add_image(image)
    if detail:
        add_text_pages(detail)
    if replaced:
        add_text_pages(PDF_NOTE)

    objects = []

    def add(body):
        objects.append(body)
        return len(objects)

    font_id = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    image_ids = []
    for spec in xobjects:
        image_ids.append(add(
            b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB '
            b'/BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 '
            b'/BitsPerComponent 8 /Columns %d >> /Length %d >>\nstream\n' % (
                spec['width'], spec['height'], spec['width'], len(spec['stream']),
            ) + spec['stream'] + b'\nendstream'
        ))
    content_ids = []
    for index, _page in enumerate(pages):
        content_ids.append(add(b'<< /Length %d >>\nstream\n' % len(contents[index]) + contents[index] + b'\nendstream'))
    page_ids = []
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


def _num(value):
    return ('%.2f' % value).encode('ascii')


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
    out += ('trailer<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n' % (
        len(objects) + 1, root, xref,
    )).encode()
    out += b'%%EOF'
    return bytes(out)


def markdown_has_unescaped_markup(text):
    """True when a raw HTML tag or a live Markdown image or link survived."""
    if re.search(r'<[A-Za-z!/]', text) is not None:
        return True
    if re.search(r'!\[[^\]]*\]\([^)]+\)', text) is not None:
        return True
    if re.search(r'\[[^\]]+\]\([^)]+\)', text) is not None:
        return True
    return False
