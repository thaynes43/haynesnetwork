"""Offline identity findings report.

The default command reads a versioned manifest, checks artifact hashes, and writes
findings. It does not start a child process, open a socket, or call a model.
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from media_repair_harness.identity_audit import png_info, render_html, render_markdown, render_pdf
from media_repair_harness.identity_cue import AssError, classify_exact_style, parse_ass_dialogue, title_relation
from media_repair_harness.identity_recipe import (
    RECIPE_VERSION,
    RecipeError,
    classify_collection_exit,
    plan_exact_title_cue,
)

REPORT_VERSION = 'identity-report-1'
MANIFEST_VERSION = 'identity-sample-1'
PROBABILITY_REASON = 'One retained example does not support a calibrated probability.'
GRADE_NOTE = 'Ordinal heuristic for this sample only. Not a probability, precision, or recall.'
SOURCE_REASON = 'Unknown. A process counter, including 0, is not a source or NFS byte total.'
OPEN_ALTERNATIVES = [
    'Reused or recap footage can share a sampled scene without the files being the same episode.',
    'Subtitles can be misassigned to the wrong file.',
    'A catalog label and an embedded cue can disagree either way.',
]
INSPECT = {
    'sampled-scene-relationship': 'Inspect the retained frames named by this claim. This report does not decide that they match.',
    'literal-embedded-title': 'Inspect the raw cue and the catalog label. Title truth is separate from any scene verdict.',
    'catalog-title-disagreement': 'Inspect which claim is wrong. Reused footage and misassigned subtitles both stay open.',
    'full-episode-identity': 'Whole-episode identity is open. One sampled scene and one cue do not decide it.',
    'item-health': 'Inspect health separately. A distinct sampled comparison does not determine health, and missing evidence is not a health determination.',
}


class ManifestError(Exception):
    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__('\n'.join(self.errors))


def _reject_constant(value):
    raise ValueError('non-finite number')


def _int(value, name, errors, minimum=0):
    if type(value) is not int:
        errors.append('%s must be an integer' % name)
        return None
    if value < minimum:
        errors.append('%s must be >= %d' % (name, minimum))
        return None
    return value


def _str(value, name, errors):
    if type(value) is not str or value == '':
        errors.append('%s must be a nonempty string' % name)
        return None
    return value


def _sha(value, name, errors):
    if type(value) is not str or len(value) != 64 or any(char not in '0123456789abcdef' for char in value):
        errors.append('%s must be a lowercase sha256' % name)
        return None
    return value


def _keys(obj, required, optional, where, errors):
    if type(obj) is not dict:
        errors.append('%s must be an object' % where)
        return False
    missing = [key for key in required if key not in obj]
    extra = sorted(key for key in obj if key not in required and key not in optional)
    if missing:
        errors.append('%s missing %s' % (where, ', '.join(missing)))
    if extra:
        errors.append('%s has unknown keys %s' % (where, ', '.join(extra)))
    return not missing and not extra


def _id(value, name, errors):
    text = _str(value, name, errors)
    if text is not None and (':' in text or '/' in text or '\n' in text):
        errors.append('%s must not contain a colon, slash, or newline' % name)
        return None
    return text


def parse_manifest(document):
    """Validate schema and return a cleaned manifest. Evidence bytes are not read here."""
    errors = []
    if type(document) is not dict:
        raise ManifestError(['manifest must be an object'])
    _keys(
        document,
        ('version', 'sampleId', 'items', 'artifacts', 'comparisons', 'dispositions', 'catalogSnapshot'),
        ('citedNotes', 'provenance'),
        'manifest',
        errors,
    )
    if document.get('version') != MANIFEST_VERSION:
        errors.append('version must be %s' % MANIFEST_VERSION)
    sample_id = document.get('sampleId')
    if type(sample_id) is not str or sample_id == '' or '\n' in sample_id:
        errors.append('sampleId must be a single-line nonempty string')
    items = _items(document.get('items'), errors)
    artifacts = _artifacts(document.get('artifacts'), errors)
    comparisons = _comparisons(document.get('comparisons'), errors)
    notes = _notes(document.get('citedNotes', []), errors)
    git_sha = _provenance(document.get('provenance', {}), errors)
    _link_artifacts(items, artifacts, comparisons, errors)
    dispositions = _dispositions(document.get('dispositions'), items, comparisons, errors)
    catalog = _catalog_ref(document.get('catalogSnapshot'), errors)
    if errors:
        raise ManifestError(errors)
    return {
        'sampleId': sample_id,
        'items': items,
        'artifacts': artifacts,
        'comparisons': comparisons,
        'dispositions': dispositions,
        'citedNotes': notes,
        'gitSha': git_sha,
        'catalog': catalog,
    }


def _items(value, errors):
    if type(value) is not list or not value:
        errors.append('items must be a nonempty list')
        return []
    items = []
    seen = set()
    files = set()
    for index, raw in enumerate(value):
        where = 'items[%d]' % index
        if not _keys(raw, ('id', 'alias', 'fileId', 'binding', 'catalogClaim'), (), where, errors):
            continue
        item_id = _id(raw.get('id'), where + '.id', errors)
        alias = _str(raw.get('alias'), where + '.alias', errors)
        file_id = _int(raw.get('fileId'), where + '.fileId', errors)
        binding = _binding(raw.get('binding'), where + '.binding', errors)
        claim = _catalog_claim(raw.get('catalogClaim'), where + '.catalogClaim', errors)
        if item_id is None or binding is None or claim is None:
            continue
        if item_id in seen:
            errors.append('duplicate item id %s' % item_id)
        if file_id in files:
            errors.append('duplicate fileId %s' % file_id)
        seen.add(item_id)
        files.add(file_id)
        items.append({
            'id': item_id, 'alias': alias, 'fileId': file_id, 'binding': binding, 'catalogClaim': claim,
        })
    return items


def _binding(value, where, errors):
    if not _keys(value, ('dev', 'ino', 'mtimeNs', 'size'), (), where, errors):
        return None
    parsed = {
        'dev': _int(value.get('dev'), where + '.dev', errors),
        'ino': _int(value.get('ino'), where + '.ino', errors),
        'mtimeNs': _int(value.get('mtimeNs'), where + '.mtimeNs', errors),
        'size': _int(value.get('size'), where + '.size', errors),
    }
    if any(item is None for item in parsed.values()):
        return None
    return parsed


def _catalog_claim(value, where, errors):
    if not _keys(value, ('seriesTitle', 'seasonNumber', 'title'), ('episodeCode',), where, errors):
        return None
    title = _str(value.get('title'), where + '.title', errors)
    series = _str(value.get('seriesTitle'), where + '.seriesTitle', errors)
    season = _int(value.get('seasonNumber'), where + '.seasonNumber', errors)
    episode = value.get('episodeCode')
    if episode is not None and (type(episode) is not str or episode == ''):
        errors.append('%s.episodeCode must be a nonempty string when present' % where)
        episode = None
    if title is None or series is None or season is None:
        return None
    return {'seriesTitle': series, 'seasonNumber': season, 'title': title, 'episodeCode': episode}


def _artifacts(value, errors):
    if type(value) is not list:
        errors.append('artifacts must be a list')
        return []
    artifacts = []
    seen = set()
    for index, raw in enumerate(value):
        where = 'artifacts[%d]' % index
        if type(raw) is not dict or 'role' not in raw:
            errors.append('%s needs a role' % where)
            continue
        role = raw.get('role')
        if role == 'sampled-frame':
            required = ('id', 'itemId', 'role', 'path', 'sha256', 'atSeconds')
            optional = ('receiptId',)
        elif role == 'embedded-title-cue':
            required = ('id', 'itemId', 'role', 'path', 'sha256', 'expectedStyle')
            optional = ('probeId', 'receiptId')
        elif role == 'probe-metadata':
            required = ('id', 'itemId', 'role', 'path', 'sha256')
            optional = ()
        elif role == 'collection-receipt':
            required = ('id', 'itemId', 'role', 'path', 'sha256', 'forArtifact')
            optional = ()
        else:
            errors.append('%s has unknown role' % where)
            continue
        if not _keys(raw, required, optional, where, errors):
            continue
        artifact_id = _id(raw.get('id'), where + '.id', errors)
        item_id = _id(raw.get('itemId'), where + '.itemId', errors)
        path = _relative_text(raw.get('path'), where + '.path', errors)
        digest = _sha(raw.get('sha256'), where + '.sha256', errors)
        if artifact_id is None or path is None or digest is None:
            continue
        if artifact_id in seen:
            errors.append('duplicate artifact id %s' % artifact_id)
        seen.add(artifact_id)
        cleaned = {
            'id': artifact_id, 'itemId': item_id, 'role': role, 'path': path, 'sha256': digest,
        }
        if role == 'sampled-frame':
            cleaned['atSeconds'] = _int(raw.get('atSeconds'), where + '.atSeconds', errors)
            cleaned['receiptId'] = _optional_id(raw, 'receiptId', where, errors)
        elif role == 'embedded-title-cue':
            cleaned['expectedStyle'] = _str(raw.get('expectedStyle'), where + '.expectedStyle', errors)
            cleaned['probeId'] = _optional_id(raw, 'probeId', where, errors)
            cleaned['receiptId'] = _optional_id(raw, 'receiptId', where, errors)
        elif role == 'collection-receipt':
            cleaned['forArtifact'] = _id(raw.get('forArtifact'), where + '.forArtifact', errors)
        artifacts.append(cleaned)
    return artifacts


def _optional_id(raw, key, where, errors):
    if key not in raw or raw[key] is None:
        return None
    return _id(raw.get(key), where + '.' + key, errors)


def _comparisons(value, errors):
    if type(value) is not list:
        errors.append('comparisons must be a list')
        return []
    comparisons = []
    seen = set()
    for index, raw in enumerate(value):
        where = 'comparisons[%d]' % index
        if not _keys(raw, ('id', 'kind', 'frameIds'), ('distinctFrom',), where, errors):
            continue
        comparison_id = _id(raw.get('id'), where + '.id', errors)
        kind = raw.get('kind')
        if kind not in ('same-scene', 'distinct-scene'):
            errors.append('%s.kind must be same-scene or distinct-scene' % where)
        frames = _id_list(raw.get('frameIds'), where + '.frameIds', errors)
        distinct = _id_list(raw.get('distinctFrom', []), where + '.distinctFrom', errors)
        if kind == 'same-scene' and type(frames) is list and len(frames) < 2:
            errors.append('%s needs at least two frames' % where)
        if kind == 'distinct-scene' and type(frames) is list and len(frames) < 1:
            errors.append('%s needs a frame' % where)
        if comparison_id is None:
            continue
        if comparison_id in seen:
            errors.append('duplicate comparison id %s' % comparison_id)
        seen.add(comparison_id)
        comparisons.append({'id': comparison_id, 'kind': kind, 'frameIds': frames, 'distinctFrom': distinct})
    return comparisons


def _id_list(value, name, errors):
    if type(value) is not list:
        errors.append('%s must be a list' % name)
        return []
    cleaned = []
    for index, item in enumerate(value):
        cleaned.append(_id(item, '%s[%d]' % (name, index), errors))
    return cleaned


def _notes(value, errors):
    if type(value) is not list:
        errors.append('citedNotes must be a list')
        return []
    notes = []
    for index, raw in enumerate(value):
        where = 'citedNotes[%d]' % index
        if not _keys(raw, ('text', 'basis'), (), where, errors):
            continue
        text = _str(raw.get('text'), where + '.text', errors)
        basis = _str(raw.get('basis'), where + '.basis', errors)
        if text is not None and basis is not None:
            notes.append({'text': text, 'basis': basis})
    return notes


def _provenance(value, errors):
    if value is None:
        return None
    if not _keys(value, (), ('gitSha',), 'provenance', errors):
        return None
    if 'gitSha' not in value or value.get('gitSha') is None:
        return None
    git = value.get('gitSha')
    if type(git) is not str or (
        len(git) not in (40, 64) or any(char not in '0123456789abcdef' for char in git)
    ):
        errors.append('provenance.gitSha must be null or lowercase hex')
        return None
    return git


def _catalog_ref(value, errors):
    if not _keys(value, ('path', 'sha256'), (), 'catalogSnapshot', errors):
        return None
    path = _relative_text(value.get('path'), 'catalogSnapshot.path', errors)
    digest = _sha(value.get('sha256'), 'catalogSnapshot.sha256', errors)
    if path is None or digest is None:
        return None
    return {'path': path, 'sha256': digest}


def _link_artifacts(items, artifacts, comparisons, errors):
    item_ids = {item['id'] for item in items}
    by_id = {}
    for artifact in artifacts:
        if artifact['id'] in by_id:
            continue
        by_id[artifact['id']] = artifact
        if artifact.get('itemId') not in item_ids:
            errors.append('artifact %s names an unknown item' % artifact['id'])
    for artifact in artifacts:
        if artifact['role'] == 'collection-receipt':
            target = by_id.get(artifact.get('forArtifact'))
            if target is None or target['role'] not in ('sampled-frame', 'embedded-title-cue'):
                errors.append('receipt %s does not name a frame or cue' % artifact['id'])
            elif target.get('itemId') != artifact.get('itemId'):
                errors.append('receipt %s is bound to a different item than its artifact' % artifact['id'])
        if artifact['role'] == 'embedded-title-cue' and artifact.get('probeId'):
            probe = by_id.get(artifact['probeId'])
            if probe is None or probe['role'] != 'probe-metadata' or probe.get('itemId') != artifact.get('itemId'):
                errors.append('cue %s names a probe that is not that item\'s probe-metadata' % artifact['id'])
        if artifact.get('receiptId'):
            receipt = by_id.get(artifact['receiptId'])
            if receipt is None or receipt['role'] != 'collection-receipt' or receipt.get('forArtifact') != artifact['id']:
                errors.append('artifact %s receiptId does not point back at it' % artifact['id'])
    for comparison in comparisons:
        for key in ('frameIds', 'distinctFrom'):
            for frame_id in comparison.get(key) or []:
                frame = by_id.get(frame_id)
                if frame is None or frame['role'] != 'sampled-frame':
                    errors.append('comparison %s names a frame that is not a sampled-frame' % comparison['id'])


def _expected_claim_ids(items, comparisons):
    claim_ids = set()
    for comparison in comparisons:
        claim_ids.add('scene:' + comparison['id'])
        if comparison['kind'] == 'same-scene':
            claim_ids.add('catalog-title-disagreement:' + comparison['id'])
    for item in items:
        claim_ids.add('embedded-title:' + item['id'])
        claim_ids.add('full-episode:' + item['id'])
        claim_ids.add('health:' + item['id'])
    return claim_ids


def _dispositions(value, items, comparisons, errors):
    if type(value) is not dict:
        errors.append('dispositions must be an object')
        return {}
    allowed = _expected_claim_ids(items, comparisons)
    cleaned = {}
    flags = ('confirmed', 'contradicted', 'uncertain', 'notReviewed')
    for key, raw in value.items():
        if key not in allowed:
            errors.append('disposition %s does not match a claim' % key)
            continue
        if not _keys(raw, flags, ('reviewer', 'reviewedAt', 'citation', 'quote', 'inspect'), 'dispositions.%s' % key, errors):
            continue
        parsed = {}
        for flag in flags:
            if type(raw.get(flag)) is not bool:
                errors.append('dispositions.%s.%s must be a boolean' % (key, flag))
            parsed[flag] = raw.get(flag) is True
        if sum(parsed.values()) != 1:
            errors.append('dispositions.%s must set exactly one of confirmed, contradicted, uncertain, notReviewed' % key)
        for field in ('reviewer', 'reviewedAt', 'citation', 'quote', 'inspect'):
            if field in raw and raw[field] is not None and type(raw[field]) is not str:
                errors.append('dispositions.%s.%s must be a string or null' % (key, field))
            parsed[field] = raw.get(field)
        parsed['conflict'] = False
        parsed['applies'] = True
        cleaned[key] = parsed
    return cleaned


def _relative_text(value, name, errors):
    text = _str(value, name, errors)
    if text is None:
        return None
    if text.startswith(('/', '\\')) or '\\' in text or any(part in ('', '.', '..') for part in text.split('/')):
        errors.append('%s must stay inside the evidence root' % name)
        return None
    return text


def _exit_inputs(document):
    """A missing deliberate-stop flag was not claimed. It is not a clean-EOF rewrite of exit 255."""
    if 'deliberateStopAfterCue' not in document:
        deliberate = False
    else:
        deliberate = document.get('deliberateStopAfterCue')
    stderr = document.get('stderr') if type(document.get('stderr')) is str else None
    return document.get('exitCode'), deliberate, stderr


def _relative(root, relative, errors):
    if type(relative) is not str or relative == '' or relative.startswith(('/', '\\')) or '\\' in relative:
        errors.append('path must be relative: %s' % relative)
        return None
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts):
        errors.append('path leaves the evidence root: %s' % relative)
        return None
    candidate = root.joinpath(*parts)
    try:
        root_real = root.resolve()
        real = candidate.resolve()
    except (OSError, RuntimeError):
        errors.append('unreadable: %s' % relative)
        return None
    if real != root_real and root_real not in real.parents:
        errors.append('path leaves the evidence root: %s' % relative)
        return None
    return candidate


def _unreadable(digest, relative, note):
    return {'status': 'unreadable', 'data': None, 'sha256': digest, 'path': relative, 'bytes': None, 'note': note}


def _read_checked(root, relative, digest):
    errors = []
    path = _relative(root, relative, errors)
    if path is None:
        note = errors[0] if errors else 'unreadable'
        if note.startswith('unreadable'):
            return _unreadable(digest, relative, note)
        return {'status': 'malformed', 'data': None, 'sha256': digest, 'path': relative, 'note': note, 'bytes': None}
    try:
        is_file = path.is_file()
    except (OSError, RuntimeError):
        return _unreadable(digest, relative, 'unreadable: %s' % relative)
    if not is_file:
        return {'status': 'missing', 'data': None, 'sha256': digest, 'path': relative, 'bytes': None}
    try:
        data = path.read_bytes()
    except (OSError, RuntimeError):
        return _unreadable(digest, relative, 'unreadable: %s' % relative)
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        return {'status': 'drift', 'data': None, 'sha256': digest, 'path': relative, 'bytes': len(data)}
    return {'status': 'match', 'data': data, 'sha256': digest, 'path': relative, 'bytes': len(data)}


def _load_json(data):
    try:
        return json.loads(data.decode('utf-8'), parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError, ValueError):
        return None


def _finite(value):
    if type(value) is bool or type(value) not in (int, float):
        return None
    if type(value) is float and value != value or value in (float('inf'), float('-inf')):
        return None
    return value


def _identity_block(value, binding):
    if type(value) is not dict:
        return False
    return (
        type(value.get('dev')) is int and value.get('dev') == binding['dev']
        and type(value.get('ino')) is int and value.get('ino') == binding['ino']
        and type(value.get('mtime_ns')) is int and value.get('mtime_ns') == binding['mtimeNs']
        and type(value.get('size')) is int and value.get('size') == binding['size']
    )


def _human(dispositions, claim_id, applies):
    base = dispositions.get(claim_id)
    if base is None:
        base = {
            'confirmed': False, 'contradicted': False, 'uncertain': False, 'notReviewed': True,
            'conflict': False, 'reviewer': None, 'reviewedAt': None, 'citation': None, 'quote': None,
            'inspect': None,
        }
    copied = dict(base)
    copied['applies'] = bool(applies) and not copied.get('conflict')
    return copied


def _make_claim(claim_id, kind, issue, observation, grade, basis, rationale, human, evidence, alternatives, subjects):
    inspect = human.get('inspect') or INSPECT[kind]
    return {
        'id': claim_id,
        'kind': kind,
        'subjects': subjects,
        'issueLikelihood': issue,
        'observationState': observation,
        'evidenceGrade': grade,
        'evidenceGradeNote': GRADE_NOTE,
        'calibratedProbability': None,
        'calibratedProbabilityReason': PROBABILITY_REASON,
        'basis': basis,
        'rationale': rationale,
        'alternatives': list(alternatives),
        'inspect': inspect,
        'humanDisposition': {key: human[key] for key in (
            'confirmed', 'contradicted', 'uncertain', 'notReviewed', 'conflict', 'applies',
            'reviewer', 'reviewedAt', 'citation', 'quote',
        )},
        'evidence': evidence,
    }


def _subject(item):
    return {'alias': item['alias'], 'fileId': item['fileId'], 'itemId': item['id']}


def assess(parsed, evidence_root):
    """Build findings from a cleaned manifest and the evidence directory."""
    root = Path(evidence_root)
    contradictions = []
    blobs = {}
    catalog_blob = _read_checked(root, parsed['catalog']['path'], parsed['catalog']['sha256'])
    blobs['catalog'] = catalog_blob
    if catalog_blob['status'] != 'match':
        contradictions.append('catalog snapshot is %s' % catalog_blob['status'])
    for artifact in parsed['artifacts']:
        blobs[artifact['id']] = _read_checked(root, artifact['path'], artifact['sha256'])
        if blobs[artifact['id']]['status'] != 'match':
            contradictions.append('artifact %s is %s' % (artifact['id'], blobs[artifact['id']]['status']))
    items = {item['id']: item for item in parsed['items']}
    artifacts = {artifact['id']: artifact for artifact in parsed['artifacts']}
    catalog_state = _catalog_state(parsed['items'], catalog_blob, contradictions)
    cue_state = {}
    for artifact in parsed['artifacts']:
        if artifact['role'] == 'embedded-title-cue':
            cue_state[artifact['id']] = _cue_state(artifact, blobs, artifacts, items, contradictions)
    _collapse_item_cues(cue_state, artifacts, contradictions)
    frame_state = {}
    for artifact in parsed['artifacts']:
        if artifact['role'] == 'sampled-frame':
            frame_state[artifact['id']] = _frame_state(artifact, blobs, artifacts, items, contradictions)
    collections = _collections(parsed['artifacts'], blobs, artifacts, items, frame_state, cue_state)
    claims = []
    claims.extend(_scene_claims(parsed, items, artifacts, frame_state, blobs))
    claims.extend(_title_claims(parsed, items, artifacts, cue_state, catalog_state))
    claims.extend(_disagreement_claims(parsed, items, artifacts, frame_state, cue_state, catalog_state))
    claims.extend(_episode_claims(parsed, items))
    claims.extend(_health_claims(parsed, items, artifacts, frame_state))
    plans = _plans(cue_state)
    incomplete = bool(contradictions)
    git = parsed['gitSha']
    return {
        'reportVersion': REPORT_VERSION,
        'manifestVersion': MANIFEST_VERSION,
        'recipeVersion': RECIPE_VERSION,
        'recipeExecuted': False,
        'sampleId': parsed['sampleId'],
        'mode': 'offline',
        'mediaReads': 0,
        'modelCalls': 0,
        'network': False,
        'subprocess': False,
        'asr': False,
        'ocr': False,
        'gitSha': git,
        'gitShaReason': (
            'copied from the manifest; not read from git by this command'
            if git else 'not supplied; offline report does not invoke git'
        ),
        'calibratedProbability': None,
        'calibratedProbabilityReason': PROBABILITY_REASON,
        'sourceBytes': None,
        'sourceBytesReason': SOURCE_REASON,
        'citedNotes': parsed['citedNotes'],
        'items': [_item_echo(item, catalog_state.get(item['id'])) for item in parsed['items']],
        'validation': {
            'ok': not incomplete,
            'artifacts': [_artifact_row('catalog', parsed['catalog']['path'], catalog_blob)] + [
                _artifact_row(artifact['id'], artifact['path'], blobs[artifact['id']])
                for artifact in parsed['artifacts']
            ],
            'contradictions': contradictions,
        },
        'claims': claims,
        'usableFrameIds': [frame_id for frame_id, state in frame_state.items() if state['usable']],
        'recipePlans': plans,
        'resources': {'collections': collections},
        'coverage': _coverage(parsed),
        'execution': {
            'outcome': 'evidence-incomplete' if incomplete else 'validated',
            'exitCode': 3 if incomplete else 0,
        },
        'errors': [],
    }


def _artifact_row(artifact_id, path, blob):
    return {
        'id': artifact_id,
        'path': path,
        'sha256': blob['sha256'],
        'status': blob['status'],
        'bytes': blob.get('bytes'),
    }


def _item_echo(item, catalog):
    return {
        'id': item['id'],
        'alias': item['alias'],
        'fileId': item['fileId'],
        'binding': dict(item['binding']),
        'catalogClaim': dict(item['catalogClaim']),
        'catalogAgreement': None if catalog is None else catalog['agreement'],
        'catalog': None if catalog is None else catalog['echo'],
    }


def _catalog_state(items, blob, contradictions):
    state = {}
    document = _load_json(blob['data']) if blob['status'] == 'match' else None
    parsed = _catalog_document(document) if document is not None else None
    if blob['status'] == 'match' and parsed is None:
        contradictions.append('catalog snapshot JSON is malformed')
    for item in items:
        if parsed is None:
            state[item['id']] = {'agreement': 'unknown', 'echo': None, 'reasons': ['catalog snapshot is not usable']}
            continue
        series_title, rows = parsed
        row = rows.get(item['fileId'])
        if row is None:
            contradictions.append('catalog snapshot has no file %s' % item['fileId'])
            state[item['id']] = {'agreement': 'unknown', 'echo': None, 'reasons': ['file id is not in the snapshot']}
            continue
        agreement, reasons, path, episodes = _agree(item, series_title, row)
        if agreement != 'consistent':
            contradictions.append('catalog claim for %s is contradictory' % item['id'])
        state[item['id']] = {
            'agreement': agreement,
            'reasons': reasons,
            'echo': {
                'seriesTitle': series_title,
                'seasonNumber': row.get('seasonNumber') if type(row.get('seasonNumber')) is int else None,
                'relativePath': path,
                'size': row.get('size') if type(row.get('size')) is int else None,
                'episodes': episodes,
            },
        }
    return state


def _catalog_document(document):
    if type(document) is not dict:
        return None
    series = document.get('series')
    files = document.get('files')
    if type(series) is not dict or type(series.get('title')) is not str or type(files) is not list:
        return None
    rows = {}
    for row in files:
        if type(row) is not dict or type(row.get('id')) is not int:
            return None
        if row['id'] in rows:
            return None
        rows[row['id']] = row
    return series['title'], rows


def _agree(item, series_title, row):
    reasons = []
    claim = item['catalogClaim']
    path = row.get('relativePath')
    if series_title != claim['seriesTitle']:
        reasons.append('series title differs from the snapshot')
    if row.get('seasonNumber') != claim['seasonNumber']:
        reasons.append('season number differs from the snapshot')
    if type(path) is not str or claim['title'] not in path:
        reasons.append('catalog title is not in the snapshot relative path')
    if claim.get('episodeCode') and (type(path) is not str or claim['episodeCode'] not in path):
        reasons.append('episode code is not in the snapshot relative path')
    if type(row.get('size')) is not int or row.get('size') != item['binding']['size']:
        reasons.append('snapshot size differs from the binding')
    if 'episodes' not in row:
        episodes = 'missing'
        reasons.append('episodes field is absent')
    else:
        episodes = row.get('episodes')
        if episodes is not None and type(episodes) is not int:
            reasons.append('episodes field is not an integer or null')
            episodes = 'malformed'
    agreement = 'consistent' if not reasons else 'contradictory'
    return agreement, reasons, path if type(path) is str else None, episodes


def _cue_state(artifact, blobs, artifacts, items, contradictions):
    blob = blobs[artifact['id']]
    result = {
        'artifact': artifact,
        'applied': False,
        'observation': 'unknown',
        'text': None,
        'event': None,
        'preserved': None,
        'probe': 'unchecked',
        'receipt': 'unchecked',
        'rationale': 'The cue artifact was not usable.',
        'streamIndex': None,
        'expectedStyle': artifact['expectedStyle'],
    }
    if blob['status'] != 'match':
        result['observation'] = 'unknown'
        result['rationale'] = 'The cue artifact is %s, so it was not read.' % blob['status']
        return result
    document = _load_json(blob['data'])
    if type(document) is not dict:
        contradictions.append('cue %s is not a JSON object' % artifact['id'])
        result['rationale'] = 'The cue file is not a JSON object.'
        return result
    event, problem = _event_from_cue(document, artifact['expectedStyle'])
    if problem == 'contradictory':
        contradictions.append('cue %s raw dialogue contradicts its structured fields' % artifact['id'])
        result['rationale'] = 'The raw ASS dialogue does not agree with the structured cue fields.'
        result['preserved'] = document.get('text') if type(document.get('text')) is str else None
        return result
    if problem == 'malformed':
        contradictions.append('cue %s is malformed' % artifact['id'])
        result['rationale'] = 'The cue dialogue line is malformed.'
        return result
    kind = classify_exact_style(event, artifact['expectedStyle'])
    result['event'] = event
    result['streamIndex'] = event.get('streamIndex')
    if kind == 'other-style':
        result['observation'] = 'not-observed-in-sample'
        result['preserved'] = event['text']
        result['rationale'] = (
            'The dialogue style is not the allowlisted exact style. That cue is unavailable, not wrong content.'
        )
        return result
    if kind == 'empty':
        result['observation'] = 'not-observed-in-sample'
        result['rationale'] = 'The exact style was present and its text was empty. Empty text is not a content judgement.'
        return result
    if document.get('codec') != 'ass':
        result['observation'] = 'unknown'
        result['rationale'] = (
            'The exact-style ASS method does not apply to codec %s. That is unavailable, not wrong content.'
            % document.get('codec')
        )
        return result
    probe_problem = _probe_problem(artifact, document, blobs, artifacts)
    if probe_problem == 'unchecked':
        result['probe'] = 'unchecked'
    elif probe_problem:
        contradictions.append('cue %s probe is %s' % (artifact['id'], probe_problem))
        result['observation'] = 'unknown'
        result['rationale'] = 'Retained probe metadata does not confirm the cue stream (%s).' % probe_problem
        result['preserved'] = event['text']
        return result
    else:
        result['probe'] = 'consistent'
    receipt_problem = _receipt_problem(artifact, blobs, artifacts, items[artifact['itemId']], len(blob['data']))
    result['receipt'] = 'unchecked' if receipt_problem == 'unchecked' else ('consistent' if receipt_problem is None else receipt_problem)
    if receipt_problem not in (None, 'unchecked'):
        if receipt_problem == 'tool-failed':
            result['observation'] = 'tool-failed'
            result['rationale'] = 'The collection receipt is an unexpected exit, so the cue text is not used.'
        else:
            contradictions.append('cue %s receipt is %s' % (artifact['id'], receipt_problem))
            result['observation'] = 'unknown'
            result['rationale'] = 'The collection receipt does not confirm this cue (%s).' % receipt_problem
        result['preserved'] = event['text']
        return result
    result['applied'] = True
    result['observation'] = 'observed'
    result['text'] = event['text']
    result['rationale'] = 'An exact-style nonempty cue was read from the retained artifact.'
    return result


def _event_from_cue(document, expected_style):
    required = ('streamIndex', 'codec', 'language', 'trackTitle', 'start', 'end', 'style', 'text', 'rawASSDialogue')
    if any(key not in document for key in required):
        return None, 'malformed'
    if type(document.get('streamIndex')) is not int or document.get('streamIndex') < 0:
        return None, 'malformed'
    if any(type(document.get(key)) is not str for key in ('codec', 'language', 'trackTitle', 'start', 'end', 'style', 'text', 'rawASSDialogue')):
        return None, 'malformed'
    try:
        event = parse_ass_dialogue(document['rawASSDialogue'])
    except AssError:
        return None, 'malformed'
    if event is None:
        return None, 'malformed'
    if (
        event['style'] != document['style']
        or event['start'] != document['start']
        or event['end'] != document['end']
        or event['text'] != document['text']
    ):
        return None, 'contradictory'
    event = dict(event)
    event['streamIndex'] = document['streamIndex']
    event['codec'] = document['codec']
    event['language'] = document['language']
    event['trackTitle'] = document['trackTitle']
    event['expectedStyle'] = expected_style
    return event, None


def _probe_problem(artifact, document, blobs, artifacts):
    probe_id = artifact.get('probeId')
    if not probe_id:
        return 'unchecked'
    blob = blobs.get(probe_id)
    if blob is None or blob['status'] != 'match':
        return 'missing'
    probe = _load_json(blob['data'])
    streams = probe.get('streams') if type(probe) is dict else None
    if type(streams) is not list:
        return 'malformed'
    found = [stream for stream in streams if type(stream) is dict and stream.get('index') == document['streamIndex']]
    if len(found) != 1:
        return 'missing-stream'
    stream = found[0]
    if stream.get('codec_type') != 'subtitle':
        return 'not-subtitle'
    if stream.get('codec_name') != document['codec']:
        return 'codec'
    tags = stream.get('tags') if type(stream.get('tags')) is dict else {}
    if tags.get('language') != document['language'] or tags.get('title') != document['trackTitle']:
        return 'track'
    if document['codec'] != 'ass':
        return 'not-ass'
    return None


def _receipt_for(artifact, artifacts):
    if artifact.get('receiptId'):
        return artifacts.get(artifact['receiptId'])
    for candidate in artifacts.values():
        if candidate['role'] == 'collection-receipt' and candidate.get('forArtifact') == artifact['id']:
            return candidate
    return None


def _receipt_problem(artifact, blobs, artifacts, item, artifact_bytes):
    receipt = _receipt_for(artifact, artifacts)
    if receipt is None:
        return 'unchecked'
    blob = blobs.get(receipt['id'])
    if blob is None or blob['status'] != 'match':
        return 'missing'
    document = _load_json(blob['data'])
    if type(document) is not dict:
        return 'malformed'
    if not _identity_block(document.get('startIdentity'), item['binding']):
        return 'identity'
    if not _identity_block(document.get('endIdentity'), item['binding']):
        return 'identity'
    if 'endPathIdentity' in document and not _identity_block(document.get('endPathIdentity'), item['binding']):
        return 'identity'
    if 'expectedIdentity' in document and not _identity_block(document.get('expectedIdentity'), item['binding']):
        return 'identity'
    if document.get('sourceUnchanged') is not True:
        return 'source-changed'
    if 'sha256' in document and document.get('sha256') != artifact['sha256']:
        return 'output-hash'
    if 'outputBytes' in document and document.get('outputBytes') != artifact_bytes:
        return 'output-size'
    classified = classify_collection_exit(*_exit_inputs(document))
    if classified['toolFailed']:
        return 'tool-failed'
    return None


def _collapse_item_cues(cue_state, artifacts, contradictions):
    by_item = {}
    for cue_id, state in cue_state.items():
        by_item.setdefault(artifacts[cue_id]['itemId'], []).append(cue_id)
    for cue_ids in by_item.values():
        applied = [cue_id for cue_id in cue_ids if cue_state[cue_id]['applied']]
        texts = {cue_state[cue_id]['text'] for cue_id in applied}
        if len(texts) > 1:
            relations = []
            values = list(texts)
            for left, right in zip(values, values[1:]):
                relations.append(title_relation(left, right)[0])
            if any(relation == 'different' for relation in relations):
                contradictions.append('contradictory exact-style cues on one item')
                for cue_id in applied:
                    cue_state[cue_id]['applied'] = False
                    cue_state[cue_id]['observation'] = 'unknown'
                    cue_state[cue_id]['text'] = None
                    cue_state[cue_id]['rationale'] = 'Exact-style cues on this item contradict each other, so none is used.'


def _frame_state(artifact, blobs, artifacts, items, contradictions):
    blob = blobs[artifact['id']]
    if blob['status'] != 'match':
        return {'usable': False, 'reason': blob['status']}
    receipt = _receipt_for(artifact, artifacts)
    if receipt is None:
        return {'usable': True, 'reason': 'hash-matched, no receipt'}
    problem = _receipt_problem(artifact, blobs, artifacts, items[artifact['itemId']], len(blob['data']))
    if problem == 'unchecked':
        return {'usable': True, 'reason': 'hash-matched'}
    if problem == 'tool-failed':
        return {'usable': False, 'reason': 'tool-failed'}
    if problem:
        contradictions.append('frame %s receipt is %s' % (artifact['id'], problem))
        return {'usable': False, 'reason': problem}
    document = _load_json(blobs[receipt['id']]['data'])
    if 'width' in document or 'height' in document:
        info = png_info(blob['data'])
        if (
            info is None
            or type(document.get('width')) is not int
            or type(document.get('height')) is not int
            or info['width'] != document['width']
            or info['height'] != document['height']
        ):
            contradictions.append('frame %s dimensions contradict the receipt' % artifact['id'])
            return {'usable': False, 'reason': 'dimensions'}
    return {'usable': True, 'reason': 'hash-matched receipt'}


def _collections(artifact_list, blobs, artifacts, items, frame_state, cue_state):
    rows = []
    for artifact in artifact_list:
        if artifact['role'] != 'collection-receipt':
            continue
        blob = blobs[artifact['id']]
        row = {
            'artifactId': artifact['id'],
            'forArtifact': artifact['forArtifact'],
            'hashStatus': blob['status'],
            'outcome': 'unknown',
            'cleanEof': False,
            'toolFailed': False,
            'applied': False,
            'elapsedSeconds': None,
            'cpuUserSeconds': None,
            'cpuSystemSeconds': None,
            'peakRSSKiB': None,
            'sourceBytes': None,
            'recordedSourceBytes': None,
            'sourceBytesReason': SOURCE_REASON,
            'historicalHostname': None,
            'historicalArgv': None,
            'note': 'Receipt bytes were not used.' if blob['status'] != 'match' else '',
        }
        if blob['status'] != 'match':
            rows.append(row)
            continue
        document = _load_json(blob['data'])
        if type(document) is not dict:
            row['note'] = 'Receipt JSON was malformed.'
            rows.append(row)
            continue
        classified = classify_collection_exit(*_exit_inputs(document))
        row['outcome'] = classified['outcome']
        row['cleanEof'] = classified['cleanEof']
        row['toolFailed'] = classified['toolFailed']
        row['note'] = classified['note']
        row['elapsedSeconds'] = _finite(document.get('elapsedSeconds'))
        row['cpuUserSeconds'] = _finite(document.get('cpuUserSeconds'))
        row['cpuSystemSeconds'] = _finite(document.get('cpuSystemSeconds'))
        peak = document.get('peakRSSKiB')
        row['peakRSSKiB'] = peak if type(peak) is int and peak >= 0 else None
        recorded = document.get('sourceBytes')
        if type(recorded) in (str, int) or recorded is None:
            row['recordedSourceBytes'] = recorded
        if type(document.get('hostname')) is str:
            row['historicalHostname'] = document['hostname']
        argv = document.get('argv')
        if type(argv) is list and all(type(part) is str for part in argv):
            row['historicalArgv'] = argv
        target = artifacts.get(artifact['forArtifact'])
        target_state_ok = False
        if target and target['role'] == 'sampled-frame':
            target_state_ok = frame_state.get(target['id'], {}).get('usable') and frame_state[target['id']]['reason'] == 'hash-matched receipt'
        if target and target['role'] == 'embedded-title-cue':
            target_state_ok = cue_state.get(target['id'], {}).get('receipt') == 'consistent' and cue_state[target['id']].get('applied')
        row['applied'] = bool(target_state_ok and not classified['toolFailed'])
        rows.append(row)
    return rows


def _scene_claims(parsed, items, artifacts, frame_state, blobs):
    claims = []
    for comparison in parsed['comparisons']:
        frames = []
        usable = True
        subjects = []
        for frame_id in comparison['frameIds']:
            artifact = artifacts[frame_id]
            item = items[artifact['itemId']]
            state = frame_state[frame_id]
            usable = usable and state['usable']
            frames.append({
                'artifactId': frame_id,
                'alias': item['alias'],
                'fileId': item['fileId'],
                'atSeconds': artifact['atSeconds'],
                'sha256': blobs[frame_id]['sha256'],
                'usable': state['usable'],
            })
            subjects.append(_subject(item))
        claim_id = 'scene:' + comparison['id']
        human = _human(parsed['dispositions'], claim_id, usable)
        if comparison['kind'] == 'distinct-scene':
            rationale = (
                'The disposition cites a distinct sampled comparison. This report did not compare the images. '
                'A distinct sampled comparison is not a health determination.'
            )
        else:
            rationale = 'The disposition is a cited input about the sampled frames. This report did not compare the images.'
        if not usable:
            rationale = 'One or more frames were missing, drifted, or contradicted, so the disposition is not applied to these bytes. ' + rationale
        grade = 'cited' if usable and human['applies'] and (human['confirmed'] or human['contradicted']) else 'unknown'
        claims.append(_make_claim(
            claim_id, 'sampled-scene-relationship', 'unknown',
            'not-observed-in-sample' if usable else 'unknown',
            grade, 'cited' if grade == 'cited' else 'observed', rationale, human,
            {'frames': frames, 'algorithmicMatch': False, 'kind': comparison['kind']},
            OPEN_ALTERNATIVES, subjects,
        ))
    return claims


def _title_claims(parsed, items, artifacts, cue_state, catalog_state):
    claims = []
    for item in parsed['items']:
        cues = [state for cue_id, state in cue_state.items() if artifacts[cue_id]['itemId'] == item['id']]
        claim_id = 'embedded-title:' + item['id']
        catalog = catalog_state.get(item['id'])
        if not cues:
            human = _human(parsed['dispositions'], claim_id, True)
            claims.append(_make_claim(
                claim_id, 'literal-embedded-title', 'unknown', 'not-observed-in-sample', 'unknown', 'observed',
                'No exact-style cue artifact was named for this item. Absence is not wrong content and is not health.',
                human, {'cueArtifact': None}, OPEN_ALTERNATIVES, [_subject(item)],
            ))
            continue
        state = next((item for item in cues if item['applied']), cues[0])
        applied = state['applied']
        human = _human(parsed['dispositions'], claim_id, state['observation'] != 'unknown' or applied)
        if not applied and state['observation'] == 'tool-failed':
            human = _human(parsed['dispositions'], claim_id, False)
        relation = 'unknown'
        steps = []
        if applied and catalog and catalog['agreement'] == 'consistent':
            relation, left_steps, right_steps = title_relation(item['catalogClaim']['title'], state['text'])
            steps = {'catalog': left_steps, 'cue': right_steps}
        issue = 'unknown'
        grade = 'unknown'
        if state['observation'] == 'tool-failed':
            issue, grade = 'tool-failed', 'tool-failed'
        elif state['observation'] == 'not-observed-in-sample':
            issue, grade = 'not-observed-in-sample', 'observed'
        elif applied and relation == 'different':
            issue, grade = 'candidate', 'candidate'
        elif applied and relation in ('same', 'ambiguous'):
            issue, grade = 'not-observed-in-sample', 'observed'
        elif applied:
            issue, grade = 'unknown', 'observed'
        evidence = {
            'applied': applied,
            'style': None if state['event'] is None else state['event']['style'],
            'expectedStyle': state.get('expectedStyle'),
            'text': state['text'],
            'start': None if state['event'] is None else state['event']['start'],
            'end': None if state['event'] is None else state['event']['end'],
            'streamIndex': state['streamIndex'],
            'rawASSDialogue': None if state['event'] is None else state['event']['raw'],
            'preservedOther': state['preserved'],
            'ownCatalogRelation': relation,
            'transformations': steps,
            'probe': state['probe'],
            'receipt': state['receipt'],
            'wholeEpisode': False,
        }
        rationale = state['rationale']
        if relation == 'ambiguous':
            rationale += ' The item catalog label and the cue are punctuation-ambiguous, which is not an automatic mismatch.'
        elif relation == 'different':
            rationale += ' The item catalog label and the cue differ after conservative normalization.'
        rationale += ' The cue is title evidence for the sampled text, not a whole-episode identification.'
        claims.append(_make_claim(
            claim_id, 'literal-embedded-title', issue, state['observation'], grade,
            'observed', rationale, human, evidence, OPEN_ALTERNATIVES, [_subject(item)],
        ))
    return claims


def _applied_cues_for(item_ids, cue_state, artifacts):
    found = []
    for cue_id, state in cue_state.items():
        if artifacts[cue_id]['itemId'] in item_ids and state['applied']:
            found.append((cue_id, state))
    return found


def _disagreement_claims(parsed, items, artifacts, frame_state, cue_state, catalog_state):
    claims = []
    for comparison in parsed['comparisons']:
        if comparison['kind'] != 'same-scene':
            continue
        claim_id = 'catalog-title-disagreement:' + comparison['id']
        frame_items = []
        frames_ok = True
        for frame_id in comparison['frameIds']:
            artifact = artifacts[frame_id]
            frame_items.append(items[artifact['itemId']])
            frames_ok = frames_ok and frame_state[frame_id]['usable']
        unique = []
        for item in frame_items:
            if item['id'] not in {existing['id'] for existing in unique}:
                unique.append(item)
        scene_human = _human(parsed['dispositions'], 'scene:' + comparison['id'], frames_ok)
        confirmed = bool(scene_human['applies'] and scene_human['confirmed'])
        item_ids = {item['id'] for item in unique}
        applied = _applied_cues_for(item_ids, cue_state, artifacts)
        tool_failed = any(
            cue_state[cue_id]['observation'] == 'tool-failed' and artifacts[cue_id]['itemId'] in item_ids
            for cue_id in cue_state
        )
        issue, grade, observation, rationale, evidence = _disagreement_decision(
            unique, applied, confirmed, frames_ok, tool_failed, catalog_state, artifacts,
        )
        human = _human(parsed['dispositions'], claim_id, issue == 'candidate' or observation == 'not-observed-in-sample')
        if not frames_ok or tool_failed:
            human = _human(parsed['dispositions'], claim_id, False)
        claims.append(_make_claim(
            claim_id, 'catalog-title-disagreement', issue, observation, grade, 'mixed',
            rationale, human, evidence, OPEN_ALTERNATIVES, [_subject(item) for item in unique],
        ))
    return claims


def _disagreement_decision(unique, applied, confirmed, frames_ok, tool_failed, catalog_state, artifacts):
    evidence = {
        'sceneConfirmed': confirmed,
        'seasonLabelsAreMismatchEvidence': False,
        'titleRelation': 'unknown',
    }
    if not frames_ok:
        return 'unknown', 'unknown', 'unknown', 'A frame in this comparison was not usable, so no title candidate is drawn.', evidence
    if tool_failed and not applied:
        return 'tool-failed', 'tool-failed', 'tool-failed', 'A linked collection failed, so the title candidate is not drawn.', evidence
    if len({item['id'] for item in unique}) < 2:
        return 'unknown', 'unknown', 'unknown', 'The comparison does not link two items.', evidence
    if len(applied) > 1:
        texts = [state['text'] for _, state in applied]
        relation = title_relation(texts[0], texts[1])[0]
        evidence['titleRelation'] = relation
        if relation == 'different':
            return 'unknown', 'unknown', 'unknown', 'Exact-style cues in the comparison contradict each other.', evidence
    if len(applied) == 0:
        return (
            'unknown', 'unknown', 'not-observed-in-sample',
            'No validated exact-style cue was in this comparison. Missing cue evidence is not wrong content.',
            evidence,
        )
    cue_id, state = applied[0]
    cue_item = artifacts[cue_id]['itemId']
    others = [item for item in unique if item['id'] != cue_item]
    relations = []
    for other in others:
        catalog = catalog_state.get(other['id'])
        cue_catalog = catalog_state.get(cue_item)
        if catalog is None or catalog['agreement'] != 'consistent' or cue_catalog is None or cue_catalog['agreement'] != 'consistent':
            evidence['titleRelation'] = 'unknown'
            return 'unknown', 'unknown', 'unknown', 'A catalog claim in this comparison is not consistent with the snapshot.', evidence
        relation, left_steps, right_steps = title_relation(other['catalogClaim']['title'], state['text'])
        relations.append((other, relation, left_steps, right_steps, catalog, cue_catalog))
    if any(relation == 'different' for _, relation, *_rest in relations):
        evidence['titleRelation'] = 'different'
        evidence['pairs'] = [_pair(other, relation, left, right, catalog, cue_catalog, state) for other, relation, left, right, catalog, cue_catalog in relations]
        seasons = {item['catalogClaim']['seasonNumber'] for item in unique}
        season_note = ''
        if len(seasons) > 1:
            season_note = ' Season numbers differ and are not mismatch evidence.'
        if not confirmed:
            return (
                'unknown', 'unknown', 'observed',
                'The catalog label and the cue differ, and the sampled-scene link is not a confirmed disposition, so this is not a mismatch candidate.' + season_note,
                evidence,
            )
        probe_ok = state['probe'] == 'consistent'
        receipt_ok = state['receipt'] == 'consistent'
        if probe_ok and receipt_ok:
            grade = 'strong-candidate'
            why = 'A confirmed sampled-scene link, one validated exact-style cue, a differing catalog label, and consistent retained probe and receipt support a candidate.'
        else:
            grade = 'candidate'
            why = 'The linked catalog label differs from the validated cue. The candidate is not strong because probe or receipt confirmation is incomplete.'
        return 'candidate', grade, 'observed', why + season_note + ' This does not identify the whole episode.', evidence
    if relations and all(relation in ('same', 'ambiguous') for _, relation, *_rest in relations):
        evidence['titleRelation'] = relations[0][1]
        evidence['pairs'] = [_pair(*row, state) for row in relations]
        if relations[0][1] == 'ambiguous':
            why = 'After recorded punctuation and spacing normalization the titles are alternate forms, not an automatic mismatch.'
        else:
            why = 'The catalog label and the cue text agree. No title disagreement was observed in this comparison.'
        if len({item['catalogClaim']['seasonNumber'] for item in unique}) > 1:
            why += ' Season numbers differ and are not mismatch evidence.'
        return 'not-observed-in-sample', 'observed', 'observed', why, evidence
    evidence['titleRelation'] = 'unknown'
    return 'unknown', 'unknown', 'unknown', 'The title relation could not be decided.', evidence


def _pair(other, relation, left_steps, right_steps, catalog, cue_catalog, state):
    return {
        'catalogAlias': other['alias'],
        'catalogTitle': other['catalogClaim']['title'],
        'catalogTransformations': left_steps,
        'cueText': state['text'],
        'cueTransformations': right_steps,
        'titleRelation': relation,
        'catalogSeason': catalog['echo']['seasonNumber'],
        'cueItemSeason': cue_catalog['echo']['seasonNumber'],
        'seasonLabelsAreMismatchEvidence': False,
    }


def _episode_claims(parsed, items):
    claims = []
    for item in parsed['items']:
        claim_id = 'full-episode:' + item['id']
        human = _human(parsed['dispositions'], claim_id, True)
        claims.append(_make_claim(
            claim_id, 'full-episode-identity', 'unknown', 'unknown', 'unknown', 'inferred',
            'A sampled scene and an embedded cue do not identify the whole file. Whole-episode identity stays unresolved.',
            human, {'resolved': False}, OPEN_ALTERNATIVES, [_subject(item)],
        ))
    return claims


def _health_claims(parsed, items, artifacts, frame_state):
    claims = []
    distinct_ids = set()
    for comparison in parsed['comparisons']:
        if comparison['kind'] != 'distinct-scene':
            continue
        if all(frame_state[frame_id]['usable'] for frame_id in comparison['frameIds']):
            for frame_id in comparison['frameIds']:
                distinct_ids.add(artifacts[frame_id]['itemId'])
    for item in parsed['items']:
        distinct = item['id'] in distinct_ids
        if distinct:
            rationale = (
                'This item is part of a distinct sampled comparison. That is not a health determination. '
                'Missing evidence is not a health determination.'
            )
        else:
            rationale = 'Item health was not determined. Missing evidence is not a health determination.'
        claim_id = 'health:' + item['id']
        human = _human(parsed['dispositions'], claim_id, True)
        claims.append(_make_claim(
            claim_id, 'item-health', 'unknown', 'unknown', 'unknown', 'observed', rationale, human,
            {'healthDetermined': False, 'distinctSampledComparison': distinct},
            ['No health evidence was in this sample.'], [_subject(item)],
        ))
    return claims


def _plans(cue_state):
    plans = []
    for cue_id, state in cue_state.items():
        event = state.get('event')
        if event is None or type(event.get('streamIndex')) is not int:
            continue
        style = event.get('expectedStyle')
        try:
            plan = plan_exact_title_cue(event['streamIndex'], style)
        except RecipeError:
            continue
        plan['cueArtifact'] = cue_id
        plan['executed'] = False
        plans.append(plan)
    return plans


def _coverage(parsed):
    lines = [
        'No perceptual comparison was computed.',
        'No ASR, OCR, or model interpretation was run.',
        'Whole-episode identity is unresolved for every item.',
        'Item health is unresolved. A distinct sampled comparison is not a health determination, and missing evidence is not a health determination.',
        'Source byte totals are unknown.',
        'Local season numbers are not mismatch evidence.',
        'Cited notes were copied and were not rechecked over the network.',
        'The recipe plan was not executed.',
    ]
    if not parsed['citedNotes']:
        lines.append('No external page was named or fetched.')
    return lines


def _shell_findings(errors, input_sha):
    return {
        'reportVersion': REPORT_VERSION,
        'manifestVersion': MANIFEST_VERSION,
        'recipeVersion': RECIPE_VERSION,
        'recipeExecuted': False,
        'sampleId': None,
        'inputManifestSha256': input_sha,
        'mode': 'offline',
        'mediaReads': 0,
        'modelCalls': 0,
        'network': False,
        'subprocess': False,
        'asr': False,
        'ocr': False,
        'gitSha': None,
        'gitShaReason': 'not read; the manifest was not usable',
        'calibratedProbability': None,
        'calibratedProbabilityReason': PROBABILITY_REASON,
        'sourceBytes': None,
        'sourceBytesReason': SOURCE_REASON,
        'errors': errors,
        'claims': [],
        'coverage': [],
        'citedNotes': [],
        'items': [],
        'recipePlans': [],
        'validation': {'ok': False, 'artifacts': [], 'contradictions': []},
        'resources': {'collections': []},
        'execution': {'outcome': 'manifest-invalid', 'exitCode': 2},
    }


def _dump(document):
    return json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + '\n'


def _images(parsed, usable_ids, blobs):
    aliases = {item['id']: item for item in parsed['items']}
    usable = set(usable_ids)
    images = []
    for artifact in parsed['artifacts']:
        if artifact['role'] != 'sampled-frame':
            continue
        blob = blobs.get(artifact['id'])
        if blob is None or blob['status'] != 'match' or blob['data'] is None:
            continue
        if artifact['id'] not in usable:
            continue
        if png_info(blob['data']) is None:
            continue
        item = aliases[artifact['itemId']]
        images.append({
            'bytes': blob['data'],
            'caption': '%s file %s at %ss sha256 %s' % (
                item['alias'], item['fileId'], artifact['atSeconds'], artifact['sha256'],
            ),
        })
    return images


def build_offline(manifest_bytes, evidence_root):
    """Return findings, markdown, html, pdf, and the normalized manifest. Reads no media source."""
    input_sha = hashlib.sha256(manifest_bytes).hexdigest()
    try:
        document = json.loads(manifest_bytes.decode('utf-8'), parse_constant=_reject_constant)
        parsed = parse_manifest(document)
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        findings = _shell_findings(['manifest is not UTF-8 JSON (%s)' % type(exc).__name__], input_sha)
        return findings, render_markdown(findings), render_html(findings, []), render_pdf(render_markdown(findings), []), None
    except ManifestError as exc:
        findings = _shell_findings(exc.errors, input_sha)
        return findings, render_markdown(findings), render_html(findings, []), render_pdf(render_markdown(findings), []), None
    root = Path(evidence_root)
    blobs = {'catalog': _read_checked(root, parsed['catalog']['path'], parsed['catalog']['sha256'])}
    for artifact in parsed['artifacts']:
        blobs[artifact['id']] = _read_checked(root, artifact['path'], artifact['sha256'])
    findings = assess(parsed, root)
    findings['inputManifestSha256'] = input_sha
    markdown = render_markdown(findings)
    images = _images(parsed, findings.get('usableFrameIds') or [], blobs)
    return findings, markdown, render_html(findings, images), render_pdf(markdown, images), _dump(parsed)


def write_run(manifest_bytes, evidence_root, out_dir):
    """Write a new run directory. Refuses an existing path. Returns the process exit code."""
    out = Path(out_dir)
    if out.exists() or out.is_symlink():
        print('refusing existing output path', file=sys.stderr)
        return 2
    if not out.parent.is_dir():
        print('output parent does not exist', file=sys.stderr)
        return 2
    temporary = out.parent / ('.%s.partial' % out.name)
    if temporary.exists():
        print('refusing leftover partial output', file=sys.stderr)
        return 2
    findings, markdown, html, pdf, normalized = build_offline(manifest_bytes, evidence_root)
    temporary.mkdir()
    try:
        (temporary / 'findings.json').write_text(_dump(findings), encoding='utf-8')
        (temporary / 'report.md').write_text(markdown, encoding='utf-8')
        (temporary / 'audit.html').write_text(html, encoding='utf-8')
        (temporary / 'audit.pdf').write_bytes(pdf)
        if normalized is not None:
            (temporary / 'manifest.json').write_text(normalized, encoding='utf-8')
        else:
            (temporary / 'manifest.json').write_text(_dump({'version': MANIFEST_VERSION, 'rejected': True}), encoding='utf-8')
        temporary.rename(out)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return findings['execution']['exitCode']


def _plan_main(args):
    try:
        plan = plan_exact_title_cue(args.stream_index, args.style)
    except RecipeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    sys.stdout.write(_dump(plan))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='identity_report')
    commands = parser.add_subparsers(dest='command', required=True)
    offline = commands.add_parser('offline')
    offline.add_argument('--manifest', required=True)
    offline.add_argument('--evidence-root', required=True)
    offline.add_argument('--out', required=True)
    plan = commands.add_parser('plan-recipe')
    plan.add_argument('--stream-index', required=True, type=_cli_int)
    plan.add_argument('--style', required=True)
    args = parser.parse_args(argv)
    if args.command == 'plan-recipe':
        return _plan_main(args)
    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print('manifest is not a file', file=sys.stderr)
        return 2
    return write_run(manifest_path.read_bytes(), args.evidence_root, args.out)


def _cli_int(value):
    if type(value) is not str or not value or any(char not in '0123456789' for char in value):
        raise argparse.ArgumentTypeError('expected a non-negative integer')
    return int(value)


if __name__ == '__main__':
    sys.exit(main())
