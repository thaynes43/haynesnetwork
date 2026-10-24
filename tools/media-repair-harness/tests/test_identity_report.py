"""Synthetic tests for the offline identity findings report. No retained media and no human labels."""

import hashlib
import json
import struct
import zlib
from pathlib import Path
from unittest import mock
import unittest

from media_repair_harness.identity_audit import markdown_has_unescaped_markup, png_info
from media_repair_harness.identity_cue import AssError, classify_exact_style, parse_ass_dialogue, title_relation
from media_repair_harness.identity_recipe import classify_collection_exit, plan_exact_title_cue
from media_repair_harness.identity_report import build_offline, main

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


def dialogue(text, style='Episode titles', start='0:01:26.11', end='0:01:30.62'):
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
        'start': opts.get('start', '0:01:26.11'), 'end': opts.get('end', '0:01:30.62'),
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
        'lastObservedProcessIO': {'read_bytes': 0, 'rchar': 12},
        'elapsedSeconds': 0.147181,
        'cpuUserSeconds': 0.04,
        'cpuSystemSeconds': 0.09,
        'peakRSSKiB': 119652,
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


if __name__ == '__main__':
    unittest.main()
