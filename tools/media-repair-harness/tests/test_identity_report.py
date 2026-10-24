"""Synthetic tests for the offline identity findings report. No retained media and no human labels."""

import contextlib
import hashlib
import io
import json
import re
import struct
import tempfile
import zlib
from pathlib import Path
from unittest import mock
import unittest

import argparse
import os

from media_repair_harness.identity_audit import (
    FONT, GLYPH_EM, MARGIN, PAGE_W, PDF_NOTE, markdown_has_unescaped_markup, png_info, render_pdf,
)
from media_repair_harness.identity_cue import AssError, classify_exact_style, parse_ass_dialogue, title_relation
from media_repair_harness.identity_recipe import classify_collection_exit, plan_exact_title_cue
from media_repair_harness.identity_report import _cli_int, build_offline, main

BIG_FILE = 2 ** 53 + 9
BIG_INO = 2 ** 53 + 17
SRC = Path(__file__).resolve().parents[1] / 'src' / 'media_repair_harness'


def png(red, green, blue):
    raw = b'\x00' + bytes((red, green, blue))
    compressed = zlib.compress(raw)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')


def dialogue(text, style='Episode titles', start='0:04:05.00', end='0:04:09.50'):
    return 'Dialogue: 0,%s,%s,%s,,0,0,0,,%s' % (start, end, style, text)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _write(root, relative, data):
    path = root.joinpath(*relative.split('/'))
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = data if isinstance(data, bytes) else data.encode()
    path.write_bytes(blob)
    return blob, _sha(blob)


def _flags(**chosen):
    flags = {'confirmed': False, 'contradicted': False, 'uncertain': False, 'notReviewed': False}
    flags.update(chosen)
    return flags


def build(root, **opts):
    """A two-item synthetic sample. Defaults are a confirmed scene plus a differing exact-style cue."""
    root = Path(root)
    title_a = opts.get('title_a', 'North Pier')
    title_b = opts.get('title_b', 'Glass Orchard')
    cue_text = opts.get('cue_text', 'Zzyzx Plateau')
    style = opts.get('style', 'Episode titles')
    expected = opts.get('expected_style', 'Episode titles')
    season_a = opts.get('season_a', 1)
    season_b = opts.get('season_b', 9)
    episode_a = opts.get('episode_a', 'S01E01')
    episode_b = opts.get('episode_b', 'S09E02')
    file_a = opts.get('file_a', BIG_FILE)
    file_b = opts.get('file_b', BIG_FILE + 2)
    ino_a = opts.get('ino_a', BIG_INO)
    ino_b = opts.get('ino_b', BIG_INO + 2)
    size_a = opts.get('size_a', 100)
    size_b = opts.get('size_b', 101)
    stream = opts.get('stream', 2)
    language = opts.get('language', 'eng')
    track = opts.get('track', 'Default')
    codec = opts.get('codec', 'ass')
    raw = opts.get('raw', dialogue(cue_text, style))
    cue = {
        'streamIndex': stream, 'codec': codec, 'language': language, 'trackTitle': track,
        'start': opts.get('start', '0:04:05.00'), 'end': opts.get('end', '0:04:09.50'),
        'style': style, 'text': cue_text, 'rawASSDialogue': raw,
    }
    cue_bytes = (json.dumps(cue, ensure_ascii=False, indent=2) + '\n').encode()
    frame_a, frame_b = png(10, 20, 30), png(40, 50, 60)
    catalog = {
        'series': {'title': 'Example Show', 'extra': True},
        'files': [
            {'id': file_a, 'seasonNumber': season_a, 'relativePath': 'Season %d/Example - %s - %s.mkv' % (season_a, episode_a, title_a), 'size': size_a, 'episodes': None, 'note': 'synthetic'},
            {'id': file_b, 'seasonNumber': season_b, 'relativePath': 'Season %d/Example - %s - %s.mkv' % (season_b, episode_b, title_b), 'size': size_b, 'episodes': None},
        ],
    }
    probe = {'streams': [
        {'index': 0, 'codec_type': 'video', 'codec_name': 'h264'},
        {'index': 2, 'codec_type': 'subtitle', 'codec_name': 'ass', 'tags': {'language': 'eng', 'title': 'Default'}},
        {'index': 3, 'codec_type': 'subtitle', 'codec_name': 'ass', 'tags': {'language': 'enm', 'title': 'Other'}},
    ]}
    written = {}
    written['catalog.json'] = _write(root, 'catalog.json', json.dumps(catalog))
    written['cue.json'] = _write(root, 'cue.json', cue_bytes)
    written['frame-a.png'] = _write(root, 'frame-a.png', frame_a)
    written['frame-b.png'] = _write(root, 'frame-b.png', frame_b)
    written['probe.json'] = _write(root, 'probe.json', json.dumps(probe))
    binding_b = {'dev': 7, 'ino': ino_b, 'mtimeNs': 2 ** 53 + 21, 'size': size_b}

    def ident(binding):
        return {'dev': binding['dev'], 'ino': binding['ino'], 'mtime_ns': binding['mtimeNs'], 'size': binding['size']}

    receipt = {
        'exitCode': opts.get('exit_code', 255),
        'deliberateStopAfterCue': opts.get('deliberate', True),
        'stderr': opts.get('stderr', 'Broken pipe\n'),
        'sourceUnchanged': opts.get('source_unchanged', True),
        'startIdentity': ident(binding_b),
        'endIdentity': ident(binding_b),
        'endPathIdentity': ident(binding_b),
        'sourceBytes': opts.get('source_bytes', 'Unknown'),
        'lastObservedProcessIO': {'read_bytes': 0, 'rchar': 128},
        'elapsedSeconds': 2.5,
        'cpuUserSeconds': 0.2,
        'cpuSystemSeconds': 0.3,
        'peakRSSKiB': 4096,
        'sha256': written['cue.json'][1],
        'outputBytes': len(written['cue.json'][0]),
        'argv': ['nice', '-n', '19', 'ffmpeg', '-i', '/proc/self/fd/3', '-map', '0:%d' % stream],
        'hostname': 'synthetic-host',
    }
    if 'deliberate' in opts and opts['deliberate'] is None:
        del receipt['deliberateStopAfterCue']
    written['receipt.json'] = _write(root, 'receipt.json', json.dumps(receipt))
    artifacts = [
        {'id': 'frame-a', 'itemId': 'a', 'role': 'sampled-frame', 'path': 'frame-a.png', 'sha256': written['frame-a.png'][1], 'atSeconds': 200},
        {'id': 'frame-b', 'itemId': 'b', 'role': 'sampled-frame', 'path': 'frame-b.png', 'sha256': written['frame-b.png'][1], 'atSeconds': 200},
    ]
    if opts.get('with_cue', True):
        cue_artifact = {
            'id': 'cue-b', 'itemId': 'b', 'role': 'embedded-title-cue', 'path': 'cue.json',
            'sha256': written['cue.json'][1], 'expectedStyle': expected,
        }
        if opts.get('with_probe', True):
            cue_artifact['probeId'] = 'probe-b'
        if opts.get('with_receipt', True):
            cue_artifact['receiptId'] = 'receipt-b'
        artifacts.append(cue_artifact)
    if opts.get('with_probe', True):
        artifacts.append({'id': 'probe-b', 'itemId': 'b', 'role': 'probe-metadata', 'path': 'probe.json', 'sha256': written['probe.json'][1]})
    if opts.get('with_receipt', True):
        artifacts.append({
            'id': 'receipt-b', 'itemId': 'b', 'role': 'collection-receipt', 'path': 'receipt.json',
            'sha256': written['receipt.json'][1], 'forArtifact': 'cue-b',
        })
    if not opts.get('with_frames', True):
        artifacts = [artifact for artifact in artifacts if artifact['role'] != 'sampled-frame']
    manifest = {
        'version': 'identity-sample-1',
        'sampleId': opts.get('sample_id', 'synthetic-sample'),
        'items': [
            {
                'id': 'a', 'alias': 'A', 'fileId': file_a,
                'binding': {'dev': 7, 'ino': ino_a, 'mtimeNs': 2 ** 53 + 23, 'size': size_a},
                'catalogClaim': {'seriesTitle': 'Example Show', 'seasonNumber': season_a, 'title': title_a, 'episodeCode': episode_a},
            },
            {
                'id': 'b', 'alias': 'B', 'fileId': file_b, 'binding': binding_b,
                'catalogClaim': {'seriesTitle': 'Example Show', 'seasonNumber': season_b, 'title': title_b, 'episodeCode': episode_b},
            },
        ],
        'artifacts': artifacts,
        'comparisons': opts.get('comparisons', [{'id': 'ab', 'kind': 'same-scene', 'frameIds': ['frame-a', 'frame-b']}]),
        'dispositions': opts.get('dispositions', {'scene:ab': dict(_flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z', citation='synthetic-message', quote='same sample', inspect='Look at the two frames.')}),
        'catalogSnapshot': {'path': 'catalog.json', 'sha256': written['catalog.json'][1]},
        'citedNotes': opts.get('notes', [{'text': 'An indexed page was named earlier and is not fetched.', 'basis': 'citation'}]),
        'provenance': {'gitSha': opts.get('git', 'a' * 40)},
    }
    if opts.get('drop_provenance'):
        del manifest['provenance']
    by_artifact = {artifact['id']: artifact for artifact in artifacts}
    for comparison in manifest['comparisons']:
        key = 'scene:' + comparison['id']
        disposition = manifest['dispositions'].get(key)
        if not isinstance(disposition, dict) or 'reviewedArtifacts' in disposition:
            continue
        frame_ids = [frame_id for frame_id in comparison.get('frameIds') or [] if frame_id in by_artifact]
        if frame_ids:
            disposition['reviewedArtifacts'] = {frame_id: by_artifact[frame_id]['sha256'] for frame_id in frame_ids}
    return json.dumps(manifest).encode(), root, manifest, written


def run(root, manifest_bytes):
    return build_offline(manifest_bytes, root)


def claim(findings, claim_id):
    return next(item for item in findings['claims'] if item['id'] == claim_id)


def walk_probabilities(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'calibratedProbability':
                yield item
            else:
                yield from walk_probabilities(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_probabilities(item)


class CueAndRecipe(unittest.TestCase):
    def test_overrides_commas_unicode_and_times(self):
        raw = dialogue('Hello, 北埠{\\fsp1}!', 'Episode titles').replace('Hello, 北埠{\\fsp1}!', '{=0}Hello, 北埠{\\fsp1}!')
        # The replacement above is brittle if the text is not a suffix. Build the line directly.
        raw = 'Dialogue: 0,0:00:01.50,0:00:02.00,Episode titles,,0,0,0,,{=0}Hello, 北埠{\\fsp1}!'
        event = parse_ass_dialogue(raw)
        self.assertEqual(event['text'], 'Hello, 北埠!')
        self.assertEqual(event['start'], '0:00:01.50')
        self.assertEqual(classify_exact_style(event, 'Episode titles'), 'exact')
        self.assertEqual(classify_exact_style(event, 'Episode titles extra'), 'other-style')
        self.assertEqual(classify_exact_style(parse_ass_dialogue(dialogue('', 'Episode titles')), 'Episode titles'), 'empty')
        self.assertEqual(classify_exact_style(parse_ass_dialogue(dialogue('Episode: Zzyzx', 'Logo Sub-title')), 'Episode titles'), 'other-style')
        with self.assertRaises(AssError):
            parse_ass_dialogue(dialogue('Zzyzx', start='0:01:60.00'))
        with self.assertRaises(AssError):
            parse_ass_dialogue('Dialogue: 0,0:00:01.00,0:00:02.00,Episode titles')

    def test_arbitrary_title_is_not_filtered_and_punctuation_is_not_a_mismatch(self):
        event = parse_ass_dialogue(dialogue('Zzyzx Plateau'))
        self.assertEqual(classify_exact_style(event, 'Episode titles'), 'exact')
        self.assertEqual(title_relation('North Pier!', 'North Pier')[0], 'ambiguous')
        self.assertEqual(title_relation('North—Pier', 'North Pier')[0], 'ambiguous')
        self.assertEqual(title_relation('North Pier', 'Glass Orchard')[0], 'different')
        self.assertEqual(title_relation('North Pier', 'north pier')[0], 'ambiguous')
        self.assertEqual(title_relation("Jack's Return", 'Jack\u2019s Return')[0], 'ambiguous')
        self.assertEqual(title_relation('Hello, World', 'Hello World')[0], 'ambiguous')
        self.assertEqual(title_relation('Wait...', 'Wait\u2026')[0], 'ambiguous')
        self.assertEqual(title_relation('"Quoted"', '\u201cQuoted\u201d')[0], 'ambiguous')
        self.assertEqual(title_relation('Caf\u00e9', 'Cafe\u0301')[0], 'ambiguous')
        self.assertEqual(title_relation('\uff2e\uff4f\uff52\uff54\uff48', 'North')[0], 'ambiguous')
        self.assertNotEqual(title_relation("Jack's Return", 'Jack\u2019s Return')[0], 'same')
        hard = parse_ass_dialogue('Dialogue: 0,0:04:05.00,0:04:09.50,Episode titles,,0,0,0,,North\\hPier')
        self.assertEqual(hard['text'], 'North Pier')
        self.assertEqual(title_relation(hard['text'], 'North Pier')[0], 'same')
        drawn = parse_ass_dialogue('Dialogue: 0,0:04:05.00,0:04:09.50,Episode titles,,0,0,0,,{\\p1}m 0 0 l 1 1')
        self.assertEqual(drawn['text'], '')
        self.assertEqual(classify_exact_style(drawn, 'Episode titles'), 'empty')
        kept = parse_ass_dialogue('Dialogue: 0,0:04:05.00,0:04:09.50,Episode titles,,0,0,0,,Title{\\p1}m 0 0{\\p0} Tail')
        self.assertEqual(kept['text'], 'Title Tail')
        self.assertEqual(classify_exact_style(parse_ass_dialogue(dialogue('Zzyzx Plateau')), 'Episode titles'), 'exact')

    def test_exit_255_is_not_relabeled_and_an_unexpected_exit_fails(self):
        stopped = classify_collection_exit(255, True, 'muxer: Broken pipe')
        self.assertEqual(stopped['outcome'], 'deliberate-post-cue-stop')
        self.assertFalse(stopped['cleanEof'])
        self.assertFalse(stopped['toolFailed'])
        unexpected = classify_collection_exit(255, False, 'Broken pipe')
        self.assertEqual(unexpected['outcome'], 'unexpected-exit')
        self.assertTrue(unexpected['toolFailed'])
        self.assertTrue(classify_collection_exit(1, False, '')['toolFailed'])
        self.assertEqual(classify_collection_exit(0, False, '')['outcome'], 'clean-exit')
        self.assertTrue(classify_collection_exit(255, True, 'broken pipe')['toolFailed'])

    def test_plan_is_allowlisted_and_starts_nothing(self):
        plan = plan_exact_title_cue(2 ** 53 + 3, 'Night banner')
        self.assertFalse(plan['executed'])
        self.assertIsNone(plan['hostname'])
        self.assertIsNone(plan['sourceBytes'])
        self.assertIn('0:%d' % (2 ** 53 + 3), plan['argv'])
        self.assertIn('-ignore_readorder', plan['argv'])
        self.assertEqual(plan['argv'].count('ffmpeg'), 1)
        self.assertNotIn('bazarr', json.dumps(plan))
        with self.assertRaises(Exception):
            plan_exact_title_cue(True, 'Episode titles')
        with self.assertRaises(Exception):
            plan_exact_title_cue(2, '')


class Report(unittest.TestCase):
    def _case(self, **opts):
        import tempfile
        handle = tempfile.TemporaryDirectory()
        self.addCleanup(handle.cleanup)
        return build(handle.name, **opts) + (handle,)

    def test_retained_shape_round_trip_and_candidate_limits(self):
        manifest_bytes, root, _manifest, _written, _handle = self._case()
        findings, markdown, html, pdf, _normalized = run(root, manifest_bytes)
        self.assertEqual(findings['execution']['exitCode'], 0)
        self.assertEqual(findings['mediaReads'], 0)
        self.assertEqual(findings['modelCalls'], 0)
        self.assertFalse(findings['subprocess'])
        self.assertFalse(findings['network'])
        self.assertIsNone(findings['sourceBytes'])
        self.assertTrue(all(item is None for item in walk_probabilities(findings)))
        self.assertNotIn('%', markdown)
        text = json.dumps(findings)
        self.assertIn(str(BIG_FILE), text)
        self.assertIn(str(BIG_INO), text)
        self.assertNotIn('e+', text.lower())
        item_b = next(item for item in findings['items'] if item['id'] == 'b')
        self.assertEqual(item_b['binding']['ino'], BIG_INO + 2)
        self.assertIsInstance(item_b['fileId'], int)
        scene = claim(findings, 'scene:ab')
        self.assertTrue(scene['humanDisposition']['confirmed'])
        self.assertFalse(scene['humanDisposition']['contradicted'])
        self.assertFalse(scene['evidence']['algorithmicMatch'])
        disagreement = claim(findings, 'catalog-title-disagreement:ab')
        self.assertEqual(disagreement['issueLikelihood'], 'candidate')
        self.assertEqual(disagreement['evidenceGrade'], 'strong-candidate')
        self.assertFalse(disagreement['humanDisposition']['confirmed'])
        self.assertTrue(disagreement['humanDisposition']['notReviewed'])
        self.assertIn('not mismatch evidence', disagreement['rationale'])
        self.assertFalse(disagreement['evidence']['seasonLabelsAreMismatchEvidence'])
        self.assertIn('Zzyzx Plateau', disagreement['evidence']['pairs'][0]['cueText'])
        title = claim(findings, 'embedded-title:b')
        self.assertEqual(title['evidence']['text'], 'Zzyzx Plateau')
        self.assertFalse(title['evidence']['wholeEpisode'])
        self.assertEqual(claim(findings, 'full-episode:a')['issueLikelihood'], 'unknown')
        for item in findings['claims']:
            if item['kind'] == 'item-health':
                self.assertEqual(item['issueLikelihood'], 'unknown')
                self.assertFalse(item['evidence']['healthDetermined'])
        collection = findings['resources']['collections'][0]
        self.assertEqual(collection['outcome'], 'deliberate-post-cue-stop')
        self.assertFalse(collection['cleanEof'])
        self.assertIsNone(collection['sourceBytes'])
        self.assertEqual(collection['recordedSourceBytes'], 'Unknown')
        self.assertEqual(findings['recipePlans'][0]['executed'], False)
        self.assertIn('data:image/png;base64,', html)
        self.assertIn('Git %s' % ('a' * 40), html)
        self.assertTrue(pdf.startswith(b'%PDF-1.4'))
        self.assertNotIn('<script>', html)
        self.assertFalse(markdown_has_unescaped_markup(markdown))

    def test_named_stream_index_is_not_the_first_subtitle(self):
        manifest_bytes, root, *_rest = self._case(stream=3, language='enm', track='Other')
        findings, *_more = run(root, manifest_bytes)
        self.assertEqual(findings['execution']['exitCode'], 0)
        self.assertEqual(claim(findings, 'embedded-title:b')['evidence']['streamIndex'], 3)
        self.assertEqual(claim(findings, 'catalog-title-disagreement:ab')['evidenceGrade'], 'strong-candidate')
        manifest_bytes, root, *_rest = self._case(stream=3, language='eng', track='Default')
        findings, *_more = run(root, manifest_bytes)
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertNotEqual(claim(findings, 'catalog-title-disagreement:ab')['issueLikelihood'], 'candidate')

    def test_punctuation_and_season_numbers_are_not_an_automatic_mismatch(self):
        manifest_bytes, root, *_rest = self._case(title_a='North Pier!', cue_text='North Pier', title_b='North Pier')
        findings, markdown, *_more = run(root, manifest_bytes)
        disagreement = claim(findings, 'catalog-title-disagreement:ab')
        self.assertEqual(disagreement['issueLikelihood'], 'not-observed-in-sample')
        self.assertIn('not an automatic mismatch', disagreement['rationale'])
        self.assertIn('not mismatch evidence', disagreement['rationale'])
        self.assertNotIn('%', markdown)

    def test_distinct_sample_is_not_health(self):
        manifest_bytes, root, *_rest = self._case(
            comparisons=[{'id': 'c', 'kind': 'distinct-scene', 'frameIds': ['frame-b']}],
            dispositions={'scene:c': _flags(confirmed=True)},
            with_cue=False, with_probe=False, with_receipt=False,
        )
        findings, markdown, *_more = run(root, manifest_bytes)
        health = claim(findings, 'health:b')
        self.assertTrue(health['evidence']['distinctSampledComparison'])
        self.assertFalse(health['evidence']['healthDetermined'])
        self.assertEqual(health['issueLikelihood'], 'unknown')
        self.assertIn('not a health determination', health['rationale'])
        self.assertNotRegex(markdown, r'\bis healthy\b')
        self.assertNotIn('catalog-title-disagreement:c', [item['id'] for item in findings['claims']])

    def test_generic_suffix_and_empty_styles_are_unavailable(self):
        for style, text, phrase in (
            ('Logo Sub-title', 'Episode: Zzyzx', 'unavailable, not wrong content'),
            ('Episode titles extra', 'Zzyzx', 'unavailable, not wrong content'),
            ('Episode titles', '', 'not a content judgement'),
        ):
            raw = dialogue(text, style) if text != '' else dialogue('', style)
            manifest_bytes, root, *_rest = self._case(style=style, cue_text=text, raw=raw, with_probe=False, with_receipt=False)
            findings, *_more = run(root, manifest_bytes)
            title = claim(findings, 'embedded-title:b')
            self.assertNotEqual(title['issueLikelihood'], 'candidate', style)
            self.assertIn(phrase, title['rationale'])
            if text and style != 'Episode titles':
                self.assertEqual(title['evidence']['preservedOther'], text)

    def test_unexpected_exit_does_not_use_the_cue(self):
        manifest_bytes, root, *_rest = self._case(exit_code=1, deliberate=False, stderr='failed', source_bytes=0)
        findings, markdown, *_more = run(root, manifest_bytes)
        self.assertEqual(claim(findings, 'embedded-title:b')['issueLikelihood'], 'tool-failed')
        self.assertEqual(claim(findings, 'catalog-title-disagreement:ab')['issueLikelihood'], 'tool-failed')
        collection = findings['resources']['collections'][0]
        self.assertEqual(collection['outcome'], 'unexpected-exit')
        self.assertIsNone(collection['sourceBytes'])
        self.assertEqual(collection['recordedSourceBytes'], 0)
        self.assertIn('sourceBytes: null', markdown)

    def test_contradictory_raw_line_is_unknown(self):
        manifest_bytes, root, *_rest = self._case(cue_text='Goodbye', raw=dialogue('Hello'))
        findings, *_more = run(root, manifest_bytes)
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertEqual(claim(findings, 'embedded-title:b')['issueLikelihood'], 'unknown')
        self.assertNotEqual(claim(findings, 'catalog-title-disagreement:ab')['issueLikelihood'], 'candidate')

    def test_drift_and_missing_are_not_substituted(self):
        manifest_bytes, root, manifest, written, _handle = self._case()
        document = json.loads(manifest_bytes)
        document['artifacts'][2]['sha256'] = '0' * 64
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertNotIn('Zzyzx Plateau', json.dumps(findings['claims']))
        document = json.loads(manifest_bytes)
        document['artifacts'][2]['path'] = 'missing-cue.json'
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertEqual(claim(findings, 'embedded-title:b')['observationState'], 'unknown')
        self.assertNotIn('Zzyzx', json.dumps(findings['claims']))

    def test_unreadable_artifact_is_a_contradiction(self):
        manifest_bytes, root, *_rest = self._case()
        (root / 'loop').symlink_to('loop')
        document = json.loads(manifest_bytes)
        document['artifacts'][2]['path'] = 'loop'
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertTrue(any('unreadable' in row for row in findings['validation']['contradictions']))
        self.assertNotIn('Zzyzx', json.dumps(findings['claims']))
        self.assertNotIn('Traceback', json.dumps(findings))

        document = json.loads(manifest_bytes)
        real = Path.read_bytes

        def denied(self):
            if self.name == 'cue.json':
                raise PermissionError(13, 'Permission denied')
            return real(self)

        with mock.patch.object(Path, 'read_bytes', denied):
            findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertTrue(any('unreadable' in row for row in findings['validation']['contradictions']))
        self.assertNotIn('Zzyzx', json.dumps(findings['claims']))

    def test_malformed_manifest_exits_2(self):
        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        document['items'][0]['fileId'] = 1.0
        document['items'][0]['binding']['ino'] = True
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 2)
        self.assertTrue(findings['errors'])
        findings, *_more = run(root, b'{')
        self.assertEqual(findings['execution']['exitCode'], 2)
        document = json.loads(manifest_bytes)
        document['artifacts'][0]['path'] = '../outside.png'
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 2)

    def test_escaping_provenance_and_no_runtime_calls(self):
        hostile = '</div><script>alert(1)</script>'
        manifest_bytes, root, *_rest = self._case(cue_text=hostile, raw=dialogue(hostile), drop_provenance=True)
        findings, markdown, html, pdf, _normalized = run(root, manifest_bytes)
        self.assertIsNone(findings['gitSha'])
        self.assertIn('does not invoke git', findings['gitShaReason'])
        self.assertNotIn('<script>', html)
        self.assertNotIn('<script>', markdown)
        self.assertIn('&lt;script&gt;', html)
        self.assertFalse(markdown_has_unescaped_markup(markdown))
        self.assertTrue(pdf.startswith(b'%PDF-1.4'))
        info = png_info(png(1, 2, 3))
        self.assertEqual(zlib.decompress(info['idat']), b'\x00' + bytes((1, 2, 3)))

    def test_report_is_pure_and_does_not_call_out(self):
        manifest_bytes, root, *_rest = self._case()
        with mock.patch('subprocess.run', side_effect=AssertionError('subprocess')), \
                mock.patch('subprocess.Popen', side_effect=AssertionError('popen')), \
                mock.patch('socket.socket', side_effect=AssertionError('socket')), \
                mock.patch('urllib.request.urlopen', side_effect=AssertionError('url')):
            first = run(root, manifest_bytes)
            second = run(root, manifest_bytes)
        self.assertEqual(first[0], second[0])
        self.assertEqual(first[1], second[1])
        self.assertEqual(first[2], second[2])
        self.assertEqual(first[3], second[3])

    def test_sources_stay_offline(self):
        for name in ('identity_report.py', 'identity_audit.py', 'identity_cue.py', 'identity_recipe.py'):
            text = (SRC / name).read_text(encoding='utf-8')
            self.assertNotIn('import subprocess', text, name)
            self.assertNotIn('import socket', text, name)
            self.assertNotIn('urllib', text, name)
            self.assertNotIn('haynestower', text, name)
            self.assertNotIn('bazarr', text, name)

    def test_command_writes_a_run_and_refuses_a_second_one(self):
        import tempfile
        handle = tempfile.TemporaryDirectory()
        self.addCleanup(handle.cleanup)
        manifest_bytes, root, *_rest = build(Path(handle.name) / 'evidence')
        manifest_path = Path(handle.name) / 'manifest.json'
        manifest_path.write_bytes(manifest_bytes)
        out = Path(handle.name) / 'run'
        with mock.patch('subprocess.run', side_effect=AssertionError('subprocess')):
            code = main(['offline', '--manifest', str(manifest_path), '--evidence-root', str(root), '--out', str(out)])
        self.assertEqual(code, 0)
        self.assertTrue((out / 'findings.json').is_file())
        self.assertTrue((out / 'audit.html').is_file())
        self.assertTrue((out / 'audit.pdf').is_file())
        self.assertEqual(main(['offline', '--manifest', str(manifest_path), '--evidence-root', str(root), '--out', str(out)]), 2)
        plan_code = main(['plan-recipe', '--stream-index', str(2 ** 53 + 3), '--style', 'Night banner'])
        self.assertEqual(plan_code, 0)
        mode_dir = os.stat(out).st_mode & 0o777
        mode_file = os.stat(out / 'findings.json').st_mode & 0o777
        self.assertEqual(mode_dir, 0o700)
        self.assertEqual(mode_file, 0o600)
        self.assertEqual(_cli_int('9007199254740993'), 9007199254740993)
        for bad in ('２', '٣', '-1', '1.5', 'True'):
            with self.assertRaises(argparse.ArgumentTypeError):
                _cli_int(bad)

    def test_typography_is_ambiguous_and_the_audit_shows_the_pair(self):
        manifest_bytes, root, *_rest = self._case(
            title_a="Jack's Return", title_b="Jack's Return", cue_text='Jack\u2019s Return',
            raw=dialogue('Jack\u2019s Return'),
        )
        findings, markdown, html, pdf, _normalized = run(root, manifest_bytes)
        disagreement = claim(findings, 'catalog-title-disagreement:ab')
        self.assertEqual(disagreement['issueLikelihood'], 'not-observed-in-sample')
        self.assertNotEqual(disagreement['evidenceGrade'], 'strong-candidate')
        self.assertEqual(disagreement['evidence']['titleRelation'], 'ambiguous')
        self.assertIn("Jack&#x27;s Return", html)
        self.assertIn('Jack\u2019s Return', html)
        self.assertIn('punctuation-and-symbols-to-space', html)
        self.assertIn('Outcome: validated', markdown)
        self.assertIn('Exit code: 0', markdown)
        self.assertIn('same sample', html)
        self.assertIn('synthetic-message', html)
        self.assertIn('An indexed page was named earlier', html)
        self.assertIn(str(BIG_FILE), html)
        self.assertIn('Content-Security-Policy', html)
        self.assertIn(b'%%EOF', pdf)
        self.assertEqual(pdf.splitlines()[-1], b'%%EOF')
        self.assertIn(b'/Encoding /WinAnsiEncoding', pdf)
        self.assertNotIn('%', markdown)

    def test_replaced_bytes_do_not_keep_an_old_disposition(self):
        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        replacement = png(7, 8, 9)
        (root / 'frame-b.png').write_bytes(replacement)
        digest = hashlib.sha256(replacement).hexdigest()
        for artifact in document['artifacts']:
            if artifact['id'] == 'frame-b':
                artifact['sha256'] = digest
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 0)
        scene = claim(findings, 'scene:ab')
        self.assertTrue(scene['humanDisposition']['confirmed'])
        self.assertFalse(scene['humanDisposition']['applies'])
        self.assertEqual(scene['humanDisposition']['appliesReason'], 'unpinned-or-digest-mismatch')
        self.assertNotEqual(claim(findings, 'catalog-title-disagreement:ab')['evidenceGrade'], 'strong-candidate')

    def test_health_and_loose_artifact_types_are_not_confirmation(self):
        manifest_bytes, root, *_rest = self._case(dispositions={
            'scene:ab': dict(_flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z', citation='synthetic-message', quote='same sample'),
            'health:b': dict(_flags(confirmed=True), reviewer='Auditor', quote='called healthy', citation='not-a-health-review'),
            'full-episode:b': dict(_flags(confirmed=True), reviewer='Auditor', quote='called the episode', citation='not-an-episode-review'),
        })
        findings, markdown, html, *_more = run(root, manifest_bytes)
        health = claim(findings, 'health:b')
        episode = claim(findings, 'full-episode:b')
        self.assertFalse(health['humanDisposition']['applies'])
        self.assertFalse(episode['humanDisposition']['applies'])
        self.assertEqual(health['humanDisposition']['appliesReason'], 'undefined-proposition')
        self.assertFalse(health['evidence']['healthDetermined'])
        self.assertIn('does not define this proposition', health['rationale'])
        self.assertIn('does not define this proposition', episode['rationale'])
        self.assertNotRegex(markdown, r'\bis healthy\b')
        self.assertIn('called healthy', html)

        document = json.loads(manifest_bytes)
        catalog = json.loads((root / 'catalog.json').read_text())
        catalog['files'][0]['seasonNumber'] = True
        blob = json.dumps(catalog).encode()
        (root / 'catalog.json').write_bytes(blob)
        document['catalogSnapshot']['sha256'] = hashlib.sha256(blob).hexdigest()
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertNotEqual(claim(findings, 'catalog-title-disagreement:ab')['evidenceGrade'], 'strong-candidate')

        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        probe = json.loads((root / 'probe.json').read_text())
        probe['streams'][1]['index'] = True
        blob = json.dumps(probe).encode()
        (root / 'probe.json').write_bytes(blob)
        for artifact in document['artifacts']:
            if artifact['id'] == 'probe-b':
                artifact['sha256'] = hashlib.sha256(blob).hexdigest()
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertNotEqual(claim(findings, 'embedded-title:b')['evidence']['probe'], 'consistent')

        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        receipt = json.loads((root / 'receipt.json').read_text())
        receipt['outputBytes'] = 12.0
        blob = json.dumps(receipt).encode()
        (root / 'receipt.json').write_bytes(blob)
        for artifact in document['artifacts']:
            if artifact['id'] == 'receipt-b':
                artifact['sha256'] = hashlib.sha256(blob).hexdigest()
        findings, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertNotEqual(claim(findings, 'catalog-title-disagreement:ab')['issueLikelihood'], 'candidate')

    def test_pdf_encoding_layout_and_non_rgb_fallback(self):
        pdf = render_pdf('Caf\u00e9 \u2013 Jack\u2019s \u5317', [])
        self.assertEqual(pdf.splitlines()[-1], b'%%EOF')
        self.assertIn(b'/Encoding /WinAnsiEncoding', pdf)
        self.assertIn('Caf\u00e9'.encode('cp1252'), pdf)
        self.assertIn(b'<U+5317>', pdf)
        self.assertIn(PDF_NOTE.encode('cp1252', errors='replace')[:20], pdf)
        raw = b''.join(b'\x00' + (b'\x11\x22\x33' * 200) for _ in range(800))
        compressed = zlib.compress(raw)
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
        tall = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 200, 800, 8, 2, 0, 0, 0)) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')
        pdf = render_pdf('caption', [{'bytes': tall, 'caption': 'W' * 90, 'png': 'rgb'}])
        self.assertEqual(pdf.splitlines()[-1], b'%%EOF')
        placed = [line for line in pdf.splitlines() if line.startswith(b'q ')]
        self.assertTrue(placed)
        parts = placed[0].split()
        draw_w = float(parts[1])
        draw_h = float(parts[4])
        origin_x = float(parts[5])
        origin_y = float(parts[6])
        self.assertGreaterEqual(origin_x, 0)
        self.assertGreaterEqual(origin_y, 0)
        self.assertLessEqual(origin_x + draw_w, 612)
        self.assertLessEqual(origin_y + draw_h, 792)
        xref = pdf.rfind(b'\nxref\n')
        self.assertGreater(xref, 0)
        header = pdf[xref + 1:].splitlines()[1]
        count = int(header.split()[1])
        self.assertGreater(count, 3)
        self.assertIn(b'/Root ', pdf)

        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        rgba = chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
        rgba_png = b'\x89PNG\r\n\x1a\n' + rgba + chunk(b'IDAT', zlib.compress(b'\x00\x01\x02\x03\x04')) + chunk(b'IEND', b'')
        (root / 'frame-a.png').write_bytes(rgba_png)
        digest = hashlib.sha256(rgba_png).hexdigest()
        for artifact in document['artifacts']:
            if artifact['id'] == 'frame-a':
                artifact['sha256'] = digest
        document['dispositions']['scene:ab']['reviewedArtifacts']['frame-a'] = digest
        findings, _markdown, html, pdf, _normalized = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 0)
        self.assertIn('data:image/png;base64,', html)
        self.assertIn(b'Rendering unavailable in this PDF', pdf)

    def test_malformed_inputs_exit_without_a_traceback(self):
        import tempfile
        handle = tempfile.TemporaryDirectory()
        self.addCleanup(handle.cleanup)
        manifest_bytes, root, *_rest = build(Path(handle.name) / 'evidence')
        root = Path(root)

        def invoke(document, label):
            path = Path(handle.name) / ('manifest-%s.json' % label)
            payload = json.dumps(document).encode()
            path.write_bytes(payload)
            out = Path(handle.name) / ('out-%s' % label)
            code = main(['offline', '--manifest', str(path), '--evidence-root', str(root), '--out', str(out)])
            self.assertNotEqual(code, 1, label)
            self.assertTrue((out / 'audit.html').is_file(), label)
            text = (out / 'audit.html').read_text(encoding='utf-8')
            self.assertIn('Exit', text, label)
            self.assertNotIn('Traceback', text, label)
            return code, text

        document = json.loads(manifest_bytes)
        document['artifacts'][0]['path'] = 'frame-a\x00.png'
        code, text = invoke(document, 'nul')
        self.assertEqual(code, 2)
        self.assertIn('NUL', text)

        document = json.loads(manifest_bytes)
        document['sampleId'] = 'synthetic\ud83d'
        code, text = invoke(document, 'surrogate')
        self.assertEqual(code, 2)
        self.assertIn('surrogate', text.lower())

        document = json.loads(manifest_bytes)
        cue = json.loads((root / 'cue.json').read_text())
        cue['text'] = 'Zzyzx\ud83d'
        cue['rawASSDialogue'] = dialogue('Zzyzx\ud83d')
        blob = json.dumps(cue).encode()
        (root / 'cue.json').write_bytes(blob)
        for artifact in document['artifacts']:
            if artifact['id'] == 'cue-b':
                artifact['sha256'] = hashlib.sha256(blob).hexdigest()
        path = Path(handle.name) / 'manifest-cue.json'
        path.write_bytes(json.dumps(document).encode())
        out = Path(handle.name) / 'out-cue'
        code = main(['offline', '--manifest', str(path), '--evidence-root', str(root), '--out', str(out)])
        self.assertEqual(code, 3)
        self.assertIn('surrogate', (out / 'audit.html').read_text(encoding='utf-8').lower())
        self.assertNotIn('\ud83d', (out / 'findings.json').read_text(encoding='utf-8'))

        zero = struct.pack('>I', 13) + b'IHDR' + struct.pack('>IIBBBBB', 0, 1, 8, 2, 0, 0, 0)
        zero += struct.pack('>I', zlib.crc32(b'IHDR' + struct.pack('>IIBBBBB', 0, 1, 8, 2, 0, 0, 0)) & 0xffffffff)
        zero_png = b'\x89PNG\r\n\x1a\n' + zero + struct.pack('>I', 0) + b'IEND' + struct.pack('>I', zlib.crc32(b'IEND') & 0xffffffff)
        (root / 'frame-a.png').write_bytes(zero_png)
        document = json.loads(manifest_bytes)
        digest = hashlib.sha256(zero_png).hexdigest()
        for artifact in document['artifacts']:
            if artifact['id'] == 'frame-a':
                artifact['sha256'] = digest
        document['dispositions']['scene:ab']['reviewedArtifacts']['frame-a'] = digest
        path = Path(handle.name) / 'manifest-zero.json'
        path.write_bytes(json.dumps(document).encode())
        out = Path(handle.name) / 'out-zero'
        code = main(['offline', '--manifest', str(path), '--evidence-root', str(root), '--out', str(out)])
        self.assertEqual(code, 3)
        self.assertIn('PNG is invalid', (out / 'audit.html').read_text(encoding='utf-8'))

        hidden = Path(handle.name) / 'hidden.json'
        hidden.write_bytes(manifest_bytes)
        os.chmod(hidden, 0)
        out = Path(handle.name) / 'out-hidden'
        code = main(['offline', '--manifest', str(hidden), '--evidence-root', str(root), '--out', str(out)])
        self.assertEqual(code, 2)
        self.assertIn('unreadable', (out / 'audit.html').read_text(encoding='utf-8').lower())

        out = Path(handle.name) / 'out-partial'
        os.symlink('missing-target', Path(handle.name) / '.out-partial.partial')
        code = main(['offline', '--manifest', str(Path(handle.name) / 'manifest-nul.json'), '--evidence-root', str(root), '--out', str(out)])
        self.assertEqual(code, 2)

    def test_markdown_image_syntax_is_inert(self):
        hostile = 'Next time ![b](https://example.invalid/beacon.png)\n[x](https://example.invalid/a)'
        manifest_bytes, root, *_rest = self._case(
            style='Logo Sub-title', cue_text=hostile, raw=dialogue(hostile, 'Logo Sub-title'),
            with_probe=False, with_receipt=False,
        )
        _findings, markdown, html, *_more = run(root, manifest_bytes)
        self.assertNotIn('![', markdown)
        self.assertNotIn('](https://', markdown)
        self.assertNotIn('\n[x]', markdown)
        self.assertFalse(markdown_has_unescaped_markup(markdown))
        self.assertNotIn('src="http', html)
        self.assertIn('example.invalid', html)

    def test_punctuation_elision_is_ambiguous_and_not_a_strong_mismatch(self):
        pairs = (
            ("Jack's", 'Jacks'),
            ('Jacks', "Jack's"),
            ('Spider-Man Returns', 'Spiderman Returns'),
            ('M*A*S*H Night', 'MASH Night'),
            ('North Pier', 'NorthPier'),
            ("Don't", 'Dont'),
        )
        for left, right in pairs:
            relation, left_steps, right_steps = title_relation(left, right)
            self.assertEqual(relation, 'ambiguous', '%s / %s' % (left, right))
            self.assertIn('drop-non-alphanumeric', left_steps + right_steps)
        self.assertEqual(title_relation('North Pier', 'Zzyzx Plateau')[0], 'different')
        self.assertEqual(title_relation('Part 1', 'Part 2')[0], 'different')
        self.assertEqual(title_relation('Law & Order', 'Law and Order')[0], 'different')
        self.assertEqual(title_relation('Caf\u00e9', 'Cafe')[0], 'different')

        manifest_bytes, root, *_rest = self._case(
            title_a="Jack's Return", title_b="Jack's Return", cue_text='Jacks Return',
        )
        findings, markdown, html, *_more = run(root, manifest_bytes)
        disagreement = claim(findings, 'catalog-title-disagreement:ab')
        pair = disagreement['evidence']['pairs'][0]
        self.assertEqual(pair['titleRelation'], 'ambiguous')
        self.assertNotEqual(disagreement['evidenceGrade'], 'strong-candidate')
        self.assertEqual(claim(findings, 'embedded-title:b')['evidence']['ownCatalogRelation'], 'ambiguous')
        self.assertIn("Jack's Return", pair['catalogTitle'])
        self.assertIn('Jacks Return', pair['cueText'])
        self.assertIn('drop-non-alphanumeric', pair['catalogTransformations'] + pair['cueTransformations'])
        self.assertIn('cue item b', html)
        self.assertNotIn('Additional cue', markdown)

        manifest_bytes, root, *_rest = self._case(title_a='Part 1', title_b='Part 2', cue_text='Part 2')
        findings, *_more = run(root, manifest_bytes)
        disagreement = claim(findings, 'catalog-title-disagreement:ab')
        self.assertEqual(disagreement['evidence']['titleRelation'], 'different')
        self.assertEqual(disagreement['evidenceGrade'], 'strong-candidate')
        self.assertEqual(claim(findings, 'health:a')['issueLikelihood'], 'unknown')
        self.assertEqual(claim(findings, 'full-episode:b')['issueLikelihood'], 'unknown')

    def test_ambiguous_comparison_can_apply_when_pins_match(self):
        manifest_bytes, root, _manifest, written, _handle = self._case(title_a="Jack's", title_b="Jack's", cue_text='Jacks')
        document = json.loads(manifest_bytes)
        document['dispositions']['catalog-title-disagreement:ab'] = dict(
            _flags(confirmed=True),
            reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z', citation='synthetic-message', quote='folded words',
            reviewedArtifacts={
                'frame-a': written['frame-a.png'][1],
                'frame-b': written['frame-b.png'][1],
                'cue-b': written['cue.json'][1],
            },
        )
        findings, _markdown, html, *_more = run(root, json.dumps(document).encode())
        human = claim(findings, 'catalog-title-disagreement:ab')['humanDisposition']
        self.assertEqual(claim(findings, 'catalog-title-disagreement:ab')['issueLikelihood'], 'not-observed-in-sample')
        self.assertTrue(human['applies'])
        self.assertEqual(human['appliesReason'], 'pinned-evidence-matches')
        self.assertIn('Pin frame-a', html)
        self.assertIn('deliberate-post-cue-stop', html)
        self.assertIn('Broken pipe', html)
        self.assertIn('exit 255', html)

    def test_catalog_reasons_and_snapshot_path_are_in_the_audit(self):
        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        catalog = json.loads((root / 'catalog.json').read_text())
        catalog['files'][0]['relativePath'] = 'Season 1/Example - S01E01 - Other.mkv'
        blob = json.dumps(catalog).encode()
        (root / 'catalog.json').write_bytes(blob)
        document['catalogSnapshot']['sha256'] = hashlib.sha256(blob).hexdigest()
        findings, _markdown, html, *_more = run(root, json.dumps(document).encode())
        self.assertEqual(findings['execution']['exitCode'], 3)
        self.assertIn('catalog title is not in the snapshot relative path', html)
        self.assertIn('Season 1/Example - S01E01 - Other.mkv', html)

    def test_cjk_and_wide_glyphs_stay_inside_the_pdf_content_box(self):
        def widest(pdf):
            width = 0
            for literal in re.findall(rb'\((?:\\.|[^\\)])*\)', pdf):
                inner = literal[1:-1]
                out = bytearray()
                index = 0
                while index < len(inner):
                    if inner[index:index + 1] == b'\\' and index + 1 < len(inner):
                        out.append(inner[index + 1])
                        index += 2
                    else:
                        out.append(inner[index])
                        index += 1
                width = max(width, len(out))
            return width

        for text in ('\u5317' * 36, '@' * 51):
            pdf = render_pdf(text, [])
            self.assertEqual(pdf.splitlines()[-1], b'%%EOF')
            self.assertLessEqual(MARGIN + widest(pdf) * FONT * GLYPH_EM, PAGE_W - MARGIN)
        self.assertIn(b'<U+5317>', render_pdf('\u5317' * 36, []))

    def test_pdf_fallback_runs_when_rendering_raises(self):
        manifest_bytes, root, *_rest = self._case()
        real = render_pdf
        calls = {'n': 0}

        def boom(markdown, images):
            calls['n'] += 1
            if calls['n'] == 1:
                raise zlib.error('bad')
            return real(markdown, images)

        with mock.patch('media_repair_harness.identity_report.render_pdf', boom):
            findings, _markdown, html, pdf, _normalized = run(root, manifest_bytes)
        self.assertGreaterEqual(calls['n'], 2)
        self.assertIn(b'PDF rendering failed closed', pdf)
        self.assertIn('PDF rendering failed closed', html)
        self.assertIn('PDF rendering failed closed', ' '.join(findings['errors']))

    def test_cli_refuses_bad_output_and_reports_unusable_content(self):
        manifest_bytes, root, *_rest = self._case()
        source = (root / 'frame-a.png').read_bytes()

        def invoke(payload, name, evidence=None):
            handle = tempfile.TemporaryDirectory()
            path = Path(handle.name) / 'manifest.json'
            path.write_bytes(payload)
            out = Path(handle.name) / name
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = main(['offline', '--manifest', str(path), '--evidence-root', str(evidence or root), '--out', str(out)])
            text = stderr.getvalue()
            self.assertNotIn('Traceback', text)
            return code, out, text, handle

        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

        bad = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
        bad += chunk(b'IDAT', b'\nendstream') + chunk(b'IEND', b'')
        (root / 'frame-a.png').write_bytes(bad)
        document = json.loads(manifest_bytes)
        digest = hashlib.sha256(bad).hexdigest()
        for artifact in document['artifacts']:
            if artifact['id'] == 'frame-a':
                artifact['sha256'] = digest
        document['dispositions']['scene:ab']['reviewedArtifacts']['frame-a'] = digest
        code, out, _text, handle = invoke(json.dumps(document).encode(), 'bad-zlib')
        self.assertEqual(code, 0)
        self.assertIn(b'not be inflated', (out / 'audit.pdf').read_bytes())
        self.assertTrue((out / 'audit.html').is_file())
        handle.cleanup()
        self.assertEqual((root / 'frame-a.png').read_bytes(), bad)

        for length, label in ((24, 'png24'), (28, 'png28')):
            short = b'\x89PNG\r\n\x1a\n' + b'\x00' * (length - 8)
            (root / 'frame-a.png').write_bytes(short)
            document = json.loads(manifest_bytes)
            digest = hashlib.sha256(short).hexdigest()
            for artifact in document['artifacts']:
                if artifact['id'] == 'frame-a':
                    artifact['sha256'] = digest
            document['dispositions']['scene:ab']['reviewedArtifacts']['frame-a'] = digest
            code, out, _text, handle = invoke(json.dumps(document).encode(), label)
            self.assertEqual(code, 3)
            report = (out / 'audit.html').read_text(encoding='utf-8')
            self.assertIn('truncated', report)
            handle.cleanup()
            self.assertEqual((root / 'frame-a.png').read_bytes(), short)

        (root / 'frame-a.png').write_bytes(source)
        base = Path(tempfile.mkdtemp())
        manifest_path = base / 'manifest.json'
        manifest_path.write_bytes(manifest_bytes)
        parent = base / 'ro'
        parent.mkdir()
        try:
            os.chmod(parent, 0o500)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = main([
                    'offline', '--manifest', str(manifest_path), '--evidence-root', str(root),
                    '--out', str(parent / 'run'),
                ])
            self.assertEqual(code, 2)
            self.assertNotIn('Traceback', stderr.getvalue())
            self.assertFalse((parent / 'run').exists())
        finally:
            os.chmod(parent, 0o700)
            parent.rmdir()
            manifest_path.unlink()
            base.rmdir()

        nested_root = tempfile.TemporaryDirectory()
        real_manifest = Path(nested_root.name) / 'manifest.json'
        real_manifest.write_bytes(manifest_bytes)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = main([
                'offline', '--manifest', str(real_manifest), '--evidence-root', str(root),
                '--out', str(Path(nested_root.name) / ('a' * 250)),
            ])
        self.assertEqual(code, 2)
        self.assertNotIn('Traceback', stderr.getvalue())
        nested_root.cleanup()

        deep = ('[' * 2000) + '0' + (']' * 2000)
        code, out, _text, handle = invoke(deep.encode(), 'nested-manifest')
        self.assertEqual(code, 2)
        self.assertIn('RecursionError', (out / 'audit.html').read_text(encoding='utf-8'))
        handle.cleanup()

        document = json.loads(manifest_bytes)
        cue_blob = deep.encode()
        (root / 'cue.json').write_bytes(cue_blob)
        for artifact in document['artifacts']:
            if artifact['id'] == 'cue-b':
                artifact['sha256'] = hashlib.sha256(cue_blob).hexdigest()
        code, out, _text, handle = invoke(json.dumps(document).encode(), 'nested-cue')
        self.assertEqual(code, 3)
        report = (out / 'findings.json').read_text(encoding='utf-8')
        self.assertIn('not a JSON object', report)
        self.assertLess(len(report), 200000)
        handle.cleanup()

        document = json.loads(manifest_bytes)
        (root / 'catalog.json').write_bytes(cue_blob)
        document['catalogSnapshot']['sha256'] = hashlib.sha256(cue_blob).hexdigest()
        code, out, _text, handle = invoke(json.dumps(document).encode(), 'nested-catalog')
        self.assertEqual(code, 3)
        self.assertIn('malformed', (out / 'audit.html').read_text(encoding='utf-8'))
        handle.cleanup()

        document = json.loads(manifest_bytes)
        document['items'][0]['catalogClaim']['episodeCode'] = 'S01E01\x00'
        code, out, _text, handle = invoke(json.dumps(document).encode(), 'nul-episode')
        self.assertEqual(code, 2)
        self.assertIn('NUL', (out / 'audit.html').read_text(encoding='utf-8'))
        self.assertNotIn('\x00', (out / 'audit.html').read_text(encoding='utf-8'))
        handle.cleanup()

        document = json.loads(manifest_bytes)
        document['dispositions']['scene:ab']['quote'] = 'same\x00sample'
        code, out, _text, handle = invoke(json.dumps(document).encode(), 'nul-quote')
        self.assertEqual(code, 2)
        self.assertIn('NUL', (out / 'audit.html').read_text(encoding='utf-8'))
        handle.cleanup()
        self.assertEqual((root / 'frame-a.png').read_bytes(), source)

    def test_pdf_shows_source_text_and_markdown_stays_escaped(self):
        cue = 'North [Pier] (Dock) & \\q `night` Caf\u00e9 \u2013 \u5317 <script>alert(1)</script> &#33; &amp;'
        quote = 'Say "Hot!" & `more` &#33;'
        manifest_bytes, root, *_rest = self._case(
            title_a='Hot Matches!',
            title_b='Keep &#33; &amp; literal',
            cue_text=cue,
            raw=dialogue(cue),
            dispositions={
                'scene:ab': dict(
                    _flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z',
                    citation='synthetic-message', quote=quote, inspect='Look at the two frames.',
                ),
            },
        )
        findings, markdown, html, pdf, _normalized = run(root, manifest_bytes)
        self.assertEqual(findings['execution']['exitCode'], 0)
        self.assertEqual(pdf.splitlines()[-1], b'%%EOF')
        self.assertIn(b'/Encoding /WinAnsiEncoding', pdf)
        visible = _pdf_visible(pdf)
        self.assertIn('Hot Matches!', visible)
        self.assertNotIn('Hot Matches&#33;', visible)
        self.assertIn('Keep &#33; &amp; literal', visible)
        self.assertIn('(Dock)', visible)
        self.assertIn('[Pier]', visible)
        self.assertNotIn('&#40;', visible)
        self.assertNotIn('&#91;', visible)
        self.assertIn('`night`', visible)
        self.assertIn('<script>alert(1)</script>', visible)
        self.assertIn(quote, visible)
        self.assertIn('Caf\u00e9', visible)
        self.assertIn('\u2013', visible)
        self.assertIn('<U+5317>', visible)
        self.assertLessEqual(MARGIN + _pdf_widest(pdf) * FONT * GLYPH_EM, PAGE_W - MARGIN)
        self.assertIn('Hot Matches&#33;', markdown)
        self.assertIn('&#40;Dock&#41;', markdown)
        self.assertIn('&#91;Pier&#93;', markdown)
        self.assertIn("'night'", markdown)
        self.assertNotIn('`night`', markdown)
        self.assertNotIn('<script>', markdown)
        self.assertFalse(markdown_has_unescaped_markup(markdown))
        self.assertIn('&lt;script&gt;', html)
        self.assertNotIn('<script>', html)
        self.assertIn("default-src 'none'", html)
        self.assertEqual(json.loads((root / 'cue.json').read_text())['text'], cue)
        self.assertIn('overflow-wrap:anywhere', html)

    def _offline(self, root, payload, name):
        path = Path(root) / ('manifest-%s.json' % name)
        path.write_bytes(payload if isinstance(payload, bytes) else payload.encode())
        out = Path(root) / ('out-%s' % name)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = main(['offline', '--manifest', str(path), '--evidence-root', str(root), '--out', str(out)])
        text = stderr.getvalue()
        self.assertNotIn('Traceback', text)
        return code, out

    def test_deep_hash_matched_json_is_exit_3_with_a_report(self):
        nested = ('[' * 600) + '0' + (']' * 600)
        deeper = ('[' * 2000) + '0' + (']' * 2000)

        def plant(root, document, artifact_id, blob):
            for artifact in document['artifacts']:
                if artifact['id'] == artifact_id:
                    target = Path(root) / artifact['path']
                    before = target.read_bytes()
                    target.write_bytes(blob)
                    artifact['sha256'] = hashlib.sha256(blob).hexdigest()
                    return target, before
            raise AssertionError(artifact_id)

        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        for artifact_id, label in (
            ('cue-b', 'cue'), ('probe-b', 'probe'), ('receipt-b', 'receipt'),
        ):
            fresh = json.loads(manifest_bytes)
            target, before = plant(root, fresh, artifact_id, nested.encode())
            code, out = self._offline(root, json.dumps(fresh), 'deep-%s' % label)
            self.assertEqual(code, 3, label)
            report = (out / 'audit.html').read_text(encoding='utf-8')
            self.assertTrue(report)
            self.assertLess(len((out / 'findings.json').read_text(encoding='utf-8')), 200000)
            self.assertEqual(target.read_bytes(), nested.encode())
            target.write_bytes(before)

        catalog_path = Path(root) / 'catalog.json'
        original_catalog = catalog_path.read_bytes()
        catalog_path.write_bytes(nested.encode())
        fresh = json.loads(manifest_bytes)
        fresh['catalogSnapshot']['sha256'] = hashlib.sha256(nested.encode()).hexdigest()
        code, out = self._offline(root, json.dumps(fresh), 'deep-catalog')
        self.assertEqual(code, 3)
        self.assertIn('malformed', (out / 'audit.html').read_text(encoding='utf-8'))
        self.assertEqual(catalog_path.read_bytes(), nested.encode())
        catalog_path.write_bytes(original_catalog)

        code, out = self._offline(root, deeper, 'deep-manifest')
        self.assertEqual(code, 2)
        self.assertTrue((out / 'audit.html').is_file())
        code, out = self._offline(root, nested, 'parsed-manifest')
        self.assertEqual(code, 2)
        self.assertIn('manifest must be an object', (out / 'audit.html').read_text(encoding='utf-8'))

    def test_pins_follow_bytes_on_disk_and_a_disagreement_needs_a_cue(self):
        manifest_bytes, root, _manifest, written, _handle = self._case()
        document = json.loads(manifest_bytes)
        frame = png(7, 8, 9)
        frame_sha = hashlib.sha256(frame).hexdigest()
        (Path(root) / 'frame-c.png').write_bytes(frame)
        document['artifacts'].append({
            'id': 'frame-c', 'itemId': 'b', 'role': 'sampled-frame',
            'path': 'frame-c.png', 'sha256': frame_sha, 'atSeconds': 260,
        })
        document['comparisons'][0]['distinctFrom'] = ['frame-c']
        document['dispositions']['scene:ab']['reviewedArtifacts']['frame-c'] = frame_sha
        document['dispositions']['scene:ab']['quote'] = 'same sample'
        (Path(root) / 'frame-c.png').write_bytes(b'drifted-bytes')
        code, out = self._offline(root, json.dumps(document), 'distinct-drift')
        self.assertEqual(code, 3)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'scene:ab')['humanDisposition']
        self.assertFalse(human['applies'])
        self.assertEqual(human['quote'], 'same sample')
        pin = next(row for row in human['pinCheck'] if row['id'] == 'frame-c')
        self.assertEqual(pin['diskStatus'], 'drift')
        self.assertFalse(pin['match'])
        self.assertEqual(pin['reviewed'], frame_sha)
        self.assertIn('disk drift', (out / 'audit.html').read_text(encoding='utf-8'))
        self.assertEqual((Path(root) / 'frame-c.png').read_bytes(), b'drifted-bytes')

        manifest_bytes, root, *_rest = self._case()
        document = json.loads(manifest_bytes)
        cue_sha = next(item['sha256'] for item in document['artifacts'] if item['id'] == 'cue-b')
        document['dispositions']['scene:ab']['reviewedArtifacts']['cue-b'] = cue_sha
        document['dispositions']['scene:ab']['quote'] = 'same sample'
        cue_path = Path(root) / 'cue.json'
        original_cue = cue_path.read_bytes()
        cue_path.unlink()
        code, out = self._offline(root, json.dumps(document), 'missing-pin')
        self.assertEqual(code, 3)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'scene:ab')['humanDisposition']
        self.assertFalse(human['applies'])
        self.assertEqual(human['quote'], 'same sample')
        pin = next(row for row in human['pinCheck'] if row['id'] == 'cue-b')
        self.assertEqual(pin['diskStatus'], 'missing')
        self.assertFalse(pin['match'])
        self.assertFalse(cue_path.exists())
        cue_path.write_bytes(original_cue)

        manifest_bytes, root, *_rest = self._case(title_a="Jack's", title_b="Jack's", cue_text='Jacks')
        document = json.loads(manifest_bytes)
        pins = {
            'frame-a': next(item['sha256'] for item in document['artifacts'] if item['id'] == 'frame-a'),
            'frame-b': next(item['sha256'] for item in document['artifacts'] if item['id'] == 'frame-b'),
            'cue-b': next(item['sha256'] for item in document['artifacts'] if item['id'] == 'cue-b'),
        }
        document['dispositions']['catalog-title-disagreement:ab'] = dict(
            _flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z',
            citation='synthetic-message', quote='folded words', reviewedArtifacts=dict(pins),
        )
        (Path(root) / 'cue.json').write_bytes(b'{"not":"the cue"}\n')
        code, out = self._offline(root, json.dumps(document), 'cue-drift')
        self.assertEqual(code, 3)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'catalog-title-disagreement:ab')['humanDisposition']
        self.assertFalse(human['applies'])
        self.assertEqual(human['quote'], 'folded words')
        pin = next(row for row in human['pinCheck'] if row['id'] == 'cue-b')
        self.assertEqual(pin['diskStatus'], 'drift')
        self.assertEqual(pin['manifest'], pins['cue-b'])
        self.assertFalse(pin['match'])

        manifest_bytes, root, _manifest, written, _handle = self._case(
            with_cue=False, with_probe=False, with_receipt=False,
        )
        document = json.loads(manifest_bytes)
        document['dispositions']['catalog-title-disagreement:ab'] = dict(
            _flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z',
            citation='synthetic-message', quote='no cue here',
            reviewedArtifacts={
                'frame-a': written['frame-a.png'][1],
                'frame-b': written['frame-b.png'][1],
            },
        )
        code, out = self._offline(root, json.dumps(document), 'absent-cue')
        self.assertEqual(code, 0)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'catalog-title-disagreement:ab')['humanDisposition']
        self.assertFalse(human['applies'])
        self.assertEqual(human['appliesReason'], 'evidence-unusable')
        self.assertEqual(human['quote'], 'no cue here')

        raw = dialogue('North Pier', 'Logo Sub-title')
        manifest_bytes, root, _manifest, written, _handle = self._case(
            style='Logo Sub-title', cue_text='North Pier', raw=raw, title_a='North Pier', title_b='North Pier',
        )
        document = json.loads(manifest_bytes)
        document['dispositions']['catalog-title-disagreement:ab'] = dict(
            _flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z',
            citation='synthetic-message', quote='other style',
            reviewedArtifacts={
                'frame-a': written['frame-a.png'][1],
                'frame-b': written['frame-b.png'][1],
                'cue-b': written['cue.json'][1],
            },
        )
        code, out = self._offline(root, json.dumps(document), 'other-style')
        self.assertEqual(code, 0)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'catalog-title-disagreement:ab')['humanDisposition']
        self.assertFalse(human['applies'])
        self.assertEqual(human['quote'], 'other style')

        manifest_bytes, root, _manifest, written, _handle = self._case(
            title_a='North Pier', title_b='North Pier', cue_text='North Pier',
        )
        document = json.loads(manifest_bytes)
        document['dispositions']['catalog-title-disagreement:ab'] = dict(
            _flags(confirmed=True), reviewer='Auditor', reviewedAt='2026-01-02T03:04:05Z',
            citation='synthetic-message', quote='same words',
            reviewedArtifacts={
                'frame-a': written['frame-a.png'][1],
                'frame-b': written['frame-b.png'][1],
                'cue-b': written['cue.json'][1],
            },
        )
        code, out = self._offline(root, json.dumps(document), 'same-cue')
        self.assertEqual(code, 0)
        findings = json.loads((out / 'findings.json').read_text())
        human = claim(findings, 'catalog-title-disagreement:ab')['humanDisposition']
        self.assertTrue(human['applies'])
        self.assertEqual(human['appliesReason'], 'pinned-evidence-matches')
        self.assertEqual(claim(findings, 'catalog-title-disagreement:ab')['evidence']['titleRelation'], 'same')
        self.assertEqual(claim(findings, 'health:a')['issueLikelihood'], 'unknown')


def _pdf_visible(pdf):
    parts = []
    for literal in re.findall(rb'\((?:\\.|[^\\)])*\)', pdf):
        inner = literal[1:-1]
        out = bytearray()
        index = 0
        while index < len(inner):
            if inner[index:index + 1] == b'\\' and index + 1 < len(inner):
                out.append(inner[index + 1])
                index += 2
            else:
                out.append(inner[index])
                index += 1
        parts.append(out.decode('cp1252'))
    return ''.join(parts)


def _pdf_widest(pdf):
    width = 0
    for literal in re.findall(rb'\((?:\\.|[^\\)])*\)', pdf):
        inner = literal[1:-1]
        count = 0
        index = 0
        while index < len(inner):
            if inner[index:index + 1] == b'\\' and index + 1 < len(inner):
                count += 1
                index += 2
            else:
                count += 1
                index += 1
        width = max(width, count)
    return width


if __name__ == '__main__':
    unittest.main()
