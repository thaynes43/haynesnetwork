"""W25 (OpenProject #156): evidence and checker bug fixes, each under a new version, with the earlier version kept.

One class per item of the work order; every test named `test_*_v4`, `*_diag2`, `*_v33` or `*_uncalled2` fails at main 6ca16ae0 (the version it selects does not
exist there, or exists with the defect), and its paired control pins that the earlier version is unchanged.

  1  tools behaviour v4: an image-only spine document is not damage (replay and live agree); every spine document empty still is
  2  diagnostic rules diag-2: the open-tail zip patterns no longer read "<message> <name>: Permission denied" as damage; the trailing error is execution
  3  tools behaviour v4: a remote manifest href is not a missing archive member
  4  tools behaviour v4: the size-cap wording states the strict comparisons ("fewer than 2000 members", "less than 32 MiB")
  5  diagnostic rules diag-2: a zip_crc member name may hold colons, with execution precedence kept
  6  rubric v3.3 A33-1 (D32-1): a live part tag map that is explicitly {} is a naming defect
  7  rubric v3.3 A33-2 (D32-2): an ambiguous prior-record method (content words beside declaration or hash words) is report_unknown; every class is shown
  8  rubric v3.3 A33-3 (D32-3): the legacy spine heads establish no content identity in the checker
  9  counter uncalled-2: v3.1-format records, with the EPUB excerpt capability and unfetched pages; uncalled-1 unchanged

W25b (review fixes, the same versions): A37-1 a line break in a zip_crc member name keeps execution precedence; A37-2 / A37-3 uncalled-2 reads
explicit-excerpt lengths beyond the index and counts distinct served pages; Opus 1 an ambiguous prior record contests identity at declaration strength;
Opus 2 decorated execution errors and the manifest open-tail patterns; Opus 3 the v4 remote rule (http(s), network locations), colon-named members and an
all-remote spine; Opus 4 tools v4 refused outside diag-2; the nits (real CRC lines, honest tension versions, the v3.3 Markdown, prereq_v33.audit).

Synthetic, generic fixtures only (no dev-suite case content); the suite-backed classes read only the public dev suite and the committed runs.  No model call."""
import contextlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import th
import test_contract_v3_baseline as B
import test_devc7 as D
from media_repair_harness import evidence as EVC
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import evidence_v31 as EV31
from media_repair_harness import tools as T
from media_repair_harness.experimental.contract_v3 import facts as FX
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import rubric as RB
from media_repair_harness.experimental.contract_v3 import rubric_v32 as RB32
from media_repair_harness.experimental.contract_v3 import uncalled as UC1
try:        # the W25 versions; absent at 6ca16ae0, where the module still loads so that each regression test fails on its own
    from media_repair_harness.experimental.contract_v3 import prereq_v33 as PQ33
    from media_repair_harness.experimental.contract_v3 import rubric_v33 as RB33
    from media_repair_harness.experimental.contract_v3 import uncalled_v2 as UC2
except ImportError:
    PQ33 = RB33 = UC2 = None

RUBRIC_V33_SHA = '621c72f41135b6e15f0a1b8fe28ebd0383dae9ef46d62098a2301f70441ba540'      # W25b: A33-2 states the declaration-strength comparison
DOCS = th.COMPONENT / 'docs'
COVER = D.xhtml('<img src="cover.png" alt=""/>', head='')        # an image-only cover page: no character data at all
CHAPTER = D.xhtml('<h1>One</h1><p>The first chapter has ordinary words in it.</p>')


def epub_bytes(items, extra_manifest='', spine=None, members=()):
    """items: [(member under OEBPS, xhtml)]; extra_manifest: raw <item/> elements; members: extra (name, bytes) archive entries."""
    manifest = ''.join('<item id="i%d" href="%s" media-type="application/xhtml+xml"/>' % (i, n) for i, (n, _t) in enumerate(items)) + extra_manifest
    order = spine if spine is not None else ['i%d' % i for i in range(len(items))]
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>Alpha Book</dc:title><dc:creator>A. Writer</dc:creator></metadata><manifest>%s</manifest><spine>%s</spine></package>'
           % (manifest, ''.join('<itemref idref="%s"/>' % x for x in order)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
        z.writestr('META-INF/container.xml', D.CONTAINER)
        z.writestr('OEBPS/c.opf', opf)
        for n, t in items:
            z.writestr('OEBPS/' + n, t)
        for n, b in members:
            z.writestr(n, b)
    return buf.getvalue()


def pod_local_fixtures_missing():
    """True in a checkout without the public suite's pod-local EPUB fixtures (CI): results computed on the pod, where they exist, legitimately differ there
    (those cases advertise epub_inspect as unavailable), as docs/contract-v3.md section 13 says."""
    for p in (B.SUITE_V11 / 'cases').glob('epub-*.json'):
        fx = T.Fixture.from_case(json.loads(p.read_text()), B.SUITE_V11)
        if fx.kind == 'local' and not Path(fx.path).is_file():
            return True
    return False


class EpubCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='mrh-w25-')

    def write(self, data, name='q7z'):
        p = os.path.join(self.dir, name + '.epub')
        Path(p).write_bytes(data)
        return p

    def inspect(self, path, behavior):
        case = {'id': 'case-x', 'tools_available': ['epub_inspect'], 'media_type': 'epub'}
        with EV2.diagnostic_rules('diag-2' if behavior == 'v4' else 'diag-1'):        # tools behaviour v4 is built under diag-2 only (W25b)
            ctx = T.Context(case, T.Fixture('local', path), self.dir, tools_behavior=behavior)
        return T.tool_epub_inspect({}, ctx)

    def typed(self, res, rules):
        out = res.output if isinstance(res.output, str) else json.dumps(res.output)
        with EV2.diagnostic_rules(rules):
            return EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, res.status, out, 'local', 'tool'))

    def live(self, path):
        rec = EVC.collect(path, ['epub'])[0]
        return rec['status'], rec['output']


# ------------------------------------------------------------------------------------------------------------- item 1
class ImageOnlySpineDocument(EpubCase):
    def test_an_image_only_cover_is_not_damage_v4(self):
        path = self.write(epub_bytes([('cover.xhtml', COVER), ('ch1.xhtml', CHAPTER)]))
        res = self.inspect(path, 'v4')
        self.assertEqual(res.status, 'ok')
        self.assertEqual((res.output['spine_items'], res.output['spine_heads'][0]), (2, ''))
        self.assertGreater(res.output['spine_characters'], 0)
        d = self.typed(res, 'diag-2')
        self.assertEqual((d.integrity, [f['kind'] for f in d.findings if f['known_defect']]), ('clean', []))
        status, out = self.live(path)                         # the live collector calls the same file clean: the two paths agree
        self.assertEqual((status, out['valid']), ('ok', True))

    def test_every_spine_document_empty_is_still_damage_v4(self):
        path = self.write(epub_bytes([('cover.xhtml', COVER), ('back.xhtml', COVER)]))
        res = self.inspect(path, 'v4')
        self.assertEqual((res.status, res.output['stage'], res.output['error']), ('error', 'spine', 'AssertionError: the spine documents contain no text'))
        self.assertEqual(EV2.epub_failure('spine', res.output['error']), None)          # diag-1 never knew this v4 wording
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(EV2.epub_failure('spine', res.output['error']), 'damage')
        self.assertTrue(any(f['known_defect'] for f in self.typed(res, 'diag-2').findings))
        status, out = self.live(path)
        self.assertEqual((status, out['valid']), ('ok', False))     # live: "the parsed spine documents contain no text"

    def test_control_tools_v3_and_diag1_keep_the_earlier_behaviour(self):
        path = self.write(epub_bytes([('cover.xhtml', COVER), ('ch1.xhtml', CHAPTER)]))
        res = self.inspect(path, 'v3')
        self.assertEqual((res.status, res.output['error']), ('error', 'AssertionError: a spine document has no text'))
        self.assertEqual(EV2.epub_failure('spine', res.output['error']), 'damage')
        with EV2.diagnostic_rules('diag-2'):          # diag-2 no longer reads the v2 / v3 wording (one empty document) as damage
            self.assertIsNone(EV2.epub_failure('spine', res.output['error']))

    def test_a_package_the_vendored_inspector_accepts_is_unchanged_v4(self):
        path = self.write(epub_bytes([('ch1.xhtml', CHAPTER), ('ch2.xhtml', D.xhtml('<p>Second.</p>'))]))
        a, b = self.inspect(path, 'v3'), self.inspect(path, 'v4')
        self.assertEqual((a.status, a.output), (b.status, b.output))


# ------------------------------------------------------------------------------------------------------------- item 3
class RemoteManifestHref(EpubCase):
    REMOTE = '<item id="font" href="https://fonts.example.org/serif.woff2" media-type="font/woff2"/>'

    def test_a_remote_href_is_not_a_missing_member_v4(self):
        path = self.write(epub_bytes([('ch1.xhtml', CHAPTER)], extra_manifest=self.REMOTE))
        self.assertIsNone(T._epub_stage(path, remote_ok=True))
        res = self.inspect(path, 'v4')
        self.assertEqual(res.status, 'ok')
        self.assertEqual(res.output['spine_items'], 1)
        status, out = self.live(path)
        self.assertEqual((status, out['valid'], out['manifest_items']), ('ok', True, 2))

    def test_a_missing_local_member_is_still_reported_v4(self):
        path = self.write(epub_bytes([('ch1.xhtml', CHAPTER)], extra_manifest=self.REMOTE + '<item id="img" href="img/gone.png" media-type="image/png"/>'))
        res = self.inspect(path, 'v4')
        self.assertEqual((res.status, res.output['stage']), ('error', 'manifest'))
        self.assertIn('OEBPS/img/gone.png', res.output['error'])
        self.assertNotIn('serif', res.output['error'])

    def test_control_v3_keeps_the_earlier_check(self):
        path = self.write(epub_bytes([('ch1.xhtml', CHAPTER)], extra_manifest=self.REMOTE))
        self.assertEqual(T._epub_stage(path)[0], 'manifest')
        self.assertEqual(self.inspect(path, 'v3').output['stage'], 'manifest')


# ------------------------------------------------------------------------------------------------------------- item 4
class SizeCapWording(EpubCase):
    def members(self, n):
        return [('pad/%04d.txt' % i, b'') for i in range(n)]

    def test_the_wording_states_the_strict_comparisons_v4(self):
        many = epub_bytes([('ch1.xhtml', CHAPTER)], members=self.members(2000 - 4))      # 4 package entries + 1996 = 2000 members: over the strict cap
        res = self.inspect(self.write(many), 'v4')
        self.assertEqual(res.output['error'], 'AssertionError: ' + T.SIZE_CAP_V4)
        self.assertIn('fewer than 2000 members', T.SIZE_CAP_V4)
        self.assertIn('less than 32 MiB uncompressed', T.SIZE_CAP_V4)
        self.assertIn('at most 8 MiB', T.SIZE_CAP_V4)                 # the byte cap is `<=`: "at most" is right there
        for rules in EV2.DIAGNOSTIC_RULES:
            with EV2.diagnostic_rules(rules):
                self.assertEqual(EV2.epub_failure('spine', res.output['error']), 'execution')
        under = epub_bytes([('ch1.xhtml', CHAPTER)], members=self.members(2000 - 5))     # 1999 members pass
        self.assertEqual(self.inspect(self.write(under, 'q8z'), 'v4').status, 'ok')

    def test_control_v3_keeps_its_wording(self):
        many = epub_bytes([('ch1.xhtml', CHAPTER)], members=self.members(2000 - 4))
        self.assertEqual(self.inspect(self.write(many), 'v3').output['error'], 'AssertionError: ' + T.SIZE_CAP_V2)


# ------------------------------------------------------------------------------------------------------------- items 2 and 5
OPEN_TAIL = ('CRC mismatch in member OEBPS/a.xhtml', "Bad CRC-32 for file 'OEBPS/a.xhtml'", 'Corrupt extra field 0001 (size=4)')


class OpenTailZipPatterns(unittest.TestCase):
    def test_a_trailing_execution_error_is_execution_diag2(self):
        for msg in OPEN_TAIL + ('Corrupt zip64 extra field. File size not found.',):
            for tail in (': Permission denied', ': Input/output error', ': Stale file handle'):
                with EV2.diagnostic_rules('diag-2'):
                    self.assertEqual(EV2.classify_line(msg + tail), 'execution', msg + tail)
                    self.assertEqual(EV2.classify_line(msg), 'damage', msg)
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(EV2.classify_line('Corrupt extra field: Permission denied'), 'execution')
            self.assertIsNone(EV2.classify_line('Corrupt extra field whatever follows'))          # only the documented forms

    def test_it_cannot_support_a_write_diag2(self):
        out = {'status': 'error', 'stage': 'zip_crc', 'error': 'CRC mismatch in member OEBPS/a.xhtml: Permission denied'}
        o = EV2.make_observation('t1', 'epub_inspect', {}, 'error', json.dumps(out), 'local', 'tool')
        old = EV2.derive(o)
        with EV2.diagnostic_rules('diag-2'):
            new = EV2.derive(o)
        self.assertTrue(any(f['known_defect'] for f in old.findings))         # diag-1 (kept): read as damage, so it could support a write
        self.assertFalse(any(f['known_defect'] for f in new.findings))
        self.assertEqual(new.execution.get('cause'), 'tool')
        with EV2.diagnostic_rules('diag-2'):
            v = PQ33.View([o], {}, 'epub')
            self.assertEqual(PQ33.check_named(v, 'support_grade_defect')[0], 'unmet')

    def test_control_diag1_is_unchanged(self):
        for msg in OPEN_TAIL:
            self.assertEqual(EV2.classify_line(msg + ': Permission denied'), 'damage')
        self.assertEqual(EV2.active_diagnostic_rules(), 'diag-1')
        with self.assertRaises(ValueError):
            with EV2.diagnostic_rules('diag-9'):
                pass


class ColonsInMemberNames(unittest.TestCase):
    MINUS5 = 'error: Error -5 while decompressing data: incomplete or truncated stream in member %s'

    def test_a_colon_in_the_member_name_is_allowed_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for name in ('a:b.xhtml', 'Part 1: Intro.xhtml', 'x::y.xhtml'):
                self.assertEqual(EV2.epub_failure('zip_crc', self.MINUS5 % name), 'damage', name)
                self.assertEqual(EV2.epub_failure('zip_crc', "BadZipFile: Bad CRC-32 for file '%s' in member %s" % (name, name)), 'damage', name)

    def test_execution_precedence_is_kept_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(EV2.epub_failure('zip_crc', self.MINUS5 % 'a.xhtml: Permission denied'), 'execution')
            self.assertEqual(EV2.epub_failure('zip_crc', self.MINUS5 % 'a:b.xhtml: Input/output error'), 'execution')
            self.assertEqual(EV2.epub_failure('zip_crc', 'BadZipFile: File is not a zip file in member book.epub: Permission denied'), 'execution')
            self.assertEqual(EV2.epub_failure('zip_crc', 'error: Error -4 while decompressing data in member a:b.xhtml'), 'execution')

    def test_control_diag1_is_unchanged(self):
        self.assertIsNone(EV2.epub_failure('zip_crc', self.MINUS5 % 'a:b.xhtml'))
        self.assertEqual(EV2.epub_failure('zip_crc', self.MINUS5 % 'a.xhtml'), 'damage')


# ------------------------------------------------------------------------------------------------------------- items 6 to 8 (rubric v3.3)
class RubricV33(unittest.TestCase):
    def test_pins_and_frozen_rubrics(self):
        self.assertEqual(RB33.RUBRIC_V33_VERSION, 'contract-v3-rubric-3.3')
        self.assertEqual(RB33.sha256_v33(), RUBRIC_V33_SHA)
        self.assertEqual(RB32.sha256_v32(), D.RUBRIC_V32_SHA)                       # v3.2 unchanged
        self.assertEqual([a['resolves'] for a in RB33.AMENDMENTS_V33], ['D32-1', 'D32-2', 'D32-3'])
        self.assertEqual(json.loads((DOCS / 'contract-v3-prerequisites-v3.3.json').read_text()), json.loads(RB33.canonical_json_v33()))
        self.assertIn('after labels had been read', RB33.RUBRIC_V33['kind'])
        self.assertEqual(PQ.check([], {}, 'movie')['rubric'], RB.RUBRIC_V31_VERSION)        # the v3.1 checker still names v3.1
        self.assertEqual(PQ33.check([], {}, 'movie')['rubric'], RB33.RUBRIC_V33_VERSION)
        doc = (DOCS / 'contract-v3.md').read_text()
        self.assertTrue('## 17. Rubric amendment v3.3 (W25; written after labels had been read)' in doc)


class PartTagMapD321(unittest.TestCase):
    def naming(self, mod, o):
        return mod.check_named(mod.View([o], D.BOOK_CTX, 'audiobook'), 'naming_surface_defect')[:2]

    def test_an_empty_part_map_is_a_naming_defect_v33(self):
        good = {'title': 'Chapter 01', 'album': 'Book', 'artist': 'Ann Writer'}
        self.assertEqual(self.naming(PQ33, D._live_book([{}])), ('met', ['t1:files[0]:tags_empty']))
        self.assertEqual(self.naming(PQ33, D._live_book([good, {}, good])), ('met', ['t1:files[1]:tags_empty']))
        self.assertEqual(self.naming(PQ33, D._live_book([good, []])), ('met', ['t1:files[1]:tags_empty']))
        res = PQ33.check([D._live_book([good, {}])], D.BOOK_CTX, 'audiobook')
        self.assertEqual(next(m for m in res['material'] if m['id'] == 'M6')['state'], 'met')
        self.assertEqual(res['diagnosis']['metadata_naming'][0]['state'], 'met')

    def test_controls_nothing_is_synthesized_and_v31_is_unchanged(self):
        good = {'title': 'Chapter 01', 'album': 'Book', 'artist': 'Ann Writer'}
        for parts in ([None], ['ABSENT'], [False], [0], [good, good]):
            self.assertEqual(self.naming(PQ33, D._live_book(parts))[0], 'unmet', parts)
        for status in ('partial', 'error'):
            o = D._live_book([{}])
            self.assertEqual(self.naming(PQ33, dict(o, status=status))[0], 'unmet', status)
        self.assertEqual(self.naming(PQ, D._live_book([{}]))[0], 'unmet')                       # D32-1 as recorded, under v3.1
        refs = self.naming(PQ33, D._live_book([dict(good, album='')]))[1]
        self.assertEqual(refs, ['t1:files[0]:tag_album_empty'])                                # inside a populated map: A31-13 unchanged


class AmbiguousMethodD322(unittest.TestCase):
    def test_content_words_beside_declaration_or_hash_words_are_unknown_v33(self):
        for method in ('OPF metadata read', 'tags and the opening title cards', 'MD5 of the audio'):
            t = PQ33.report_typing(method)
            self.assertEqual((t['kind'], t['ambiguous'], t.get('statement_kind')), ('report_unknown', True, 'report_ambiguous'), method)
            self.assertIn('report_content', t['matched'])
            # W25b (Opus 1): the ambiguous report establishes no content, but its disagreement still contests identity, as under v3.1
            self.assertEqual(PQ33.View([D.prior(method)], D.CAT, 'epub').identity()[0], 'contested', method)
        rows = PQ33.check([D.prior('OPF metadata read')], D.CAT, 'epub')['reports']
        self.assertEqual([(r['ref'], r['kind'], r['matched'], r['v31_kind'], r['statement_kind']) for r in rows],
                         [('e1', 'report_unknown', ['report_declaration', 'report_content'], 'report_declaration', 'report_ambiguous')])

    def test_controls_single_class_and_hash_with_declaration_keep_the_frozen_order(self):
        for method, kind in (('OPF metadata', 'report_declaration'), ('OCR of the title cards', 'report_content'), ('md5 checksum', 'report_hash'),
                             ('OPF and a reported MD5 equality', 'report_hash'), ('no OCR performed', 'report_unknown'), ('manual review', 'report_unknown'),
                             (None, 'report_unknown')):
            self.assertEqual(PQ33.report_kind(method), kind, method)
            self.assertEqual(PQ33.report_kind(method), FX.report_kind(method), method)
        self.assertEqual(FX.report_kind('OPF metadata read'), 'report_declaration')             # v3.1 / v3.2 unchanged
        self.assertEqual(PQ.View([D.prior('OPF metadata read')], D.CAT, 'epub').identity()[0], 'contested')


class LegacyHeadsD323(unittest.TestCase):
    def epub_obs(self, heads):
        out = {'status': 'ok', 'opf': 'OEBPS/c.opf', 'dc_title': ['Alpha Book'], 'dc_creator': ['A. Writer'], 'spine_items': 2, 'spine_characters': 900,
               'spine_heads': heads}
        return D.ob('e1', 'epub_inspect', out, source='case')

    def test_spine_heads_establish_no_content_identity_v33(self):
        o = self.epub_obs(['Alpha Book Chapter One It was', 'more words here'])
        self.assertEqual(PQ.View([o], D.CAT, 'epub').identity()[0], 'content_verified')       # D32-3 under v3.1 (kept)
        self.assertEqual(PQ33.View([o], D.CAT, 'epub').identity()[0], 'uncontradicted')
        other = self.epub_obs(['Some unrelated words only', 'and more'])
        self.assertEqual(PQ.check_named(PQ.View([other], D.CAT, 'epub'), 'identity_disagreement')[0], 'unknown')
        self.assertEqual(PQ33.check_named(PQ33.View([other], D.CAT, 'epub'), 'identity_disagreement')[0], 'unmet')

    def test_control_other_content_and_declarations_are_kept(self):
        ocr = D.ob('t2', 'ocr', {'t_s': 1.0, 'text': 'Alpha Book', 'consensus': True}, source='tool')
        v = PQ33.View([self.epub_obs(['x']), ocr], D.CAT, 'epub')
        self.assertEqual(v.identity()[0], 'content_verified')
        self.assertEqual(sorted({(r['ref'], r['kind']) for r in v.identity()[1]}), [('context.filename', 'declaration'), ('e1', 'declaration'), ('t2', 'content')])


# ------------------------------------------------------------------------------------------------------------- item 9
def v31_record(calls=(), messages=None, caps=None):
    return {'evidence_format': {'version': 'v3.1-format', 'capabilities': caps if caps is not None else
                                [{'tool': 'epub_inspect', 'available': True, 'backend': 'local', 'excerpts': dict(T.EXCERPT_CAPABILITY)}],
                                'messages': messages or [{'id': 'evidence', 'kind': 'initial', 'pages': 1}]},
            'tool_calls': list(calls), 'evidence_shown': ['e1'], 'model_case_alias': 'case-00000001', 'decision': {'action': 'escalate'}}


def body_obs(oid, index, excerpts, source='tool'):
    out = {'status': 'ok', 'opf': 'OEBPS/c.opf', 'dc_title': ['Alpha Book'], 'spine_items': len(index), 'spine_characters': 1,
           'body': {'extraction': 'xhtml-body-text-3', 'items_total': len(index), 'index': index, 'excerpts': excerpts}}
    return D.ob(oid, 'epub_inspect', out, source=source)


class UncalledCounterV2(unittest.TestCase):
    INDEX = [{'spine': 0, 'member': 'OEBPS/a.xhtml', 'characters': 200, 'headings': []}, {'spine': 1, 'member': 'OEBPS/b.xhtml', 'characters': 900, 'headings': []},
             {'spine': 2, 'member': 'OEBPS/c.xhtml', 'characters': 0, 'headings': []}, {'spine': 3, 'member': 'OEBPS/d.xhtml', 'characters': 50, 'headings': []}]
    EXCERPTS = [{'spine': 0, 'offset': 0, 'end': 200}, {'spine': 1, 'offset': 0, 'end': 280}, {'spine': 2, 'offset': 0, 'end': 0}]

    def caps(self):
        return v31_record()['evidence_format']['capabilities']

    def test_excerpt_candidates_from_the_shown_body_view_uncalled2(self):
        got = UC2.excerpt_candidates([body_obs('t1', self.INDEX, self.EXCERPTS)], self.caps(), ['epub_inspect'])
        self.assertEqual([c['args'] for c in got], [{'spine': 1, 'offset': 280}, {'spine': 3, 'offset': 0}])
        explicit = EV31.internal(D.ob('t2', 'epub_inspect', {'extraction': 'xhtml-body-text-3', 'excerpt': {'spine': 1, 'offset': 280, 'end': 900, 'text': 'w'}}))
        got = UC2.excerpt_candidates([body_obs('t1', self.INDEX, self.EXCERPTS), explicit], self.caps(), ['epub_inspect'])
        self.assertEqual([c['args'] for c in got], [{'spine': 3, 'offset': 0}])

    def test_the_default_call_is_the_candidate_until_a_body_view_is_shown_uncalled2(self):
        recorded = D.ob('e1', 'epub_inspect', {'status': 'ok', 'opf': 'OEBPS/c.opf', 'spine_items': 3, 'spine_heads': ['a']}, source='case')
        got = UC2.excerpt_candidates([recorded], self.caps(), ['epub_inspect'])
        self.assertEqual([(c['args'], c['scope']) for c in got], [({}, 'epub_body_index')])
        failed = D.ob('t1', 'epub_inspect', {'status': 'error', 'stage': 'zip_crc', 'error': 'x'}, status='error')
        self.assertEqual(UC2.excerpt_candidates([recorded, failed], self.caps(), ['epub_inspect'], {'t1': {}}), [])
        no_excerpts = [{'tool': 'epub_inspect', 'available': True, 'excerpts': 'not_available (only a recorded observation of this item exists)'}]
        self.assertEqual(UC2.excerpt_candidates([recorded], no_excerpts, ['epub_inspect']), [])

    def test_unfetched_pages_are_candidates_uncalled2(self):
        rec = v31_record(calls=[{'id': 't1', 'tool': 'epub_inspect', 'args': {}}],
                         messages=[{'id': 'evidence', 'kind': 'initial', 'pages': 2}, {'id': 't1', 'kind': 'result', 'pages': 3}])
        self.assertEqual([c['args'] for c in UC2.page_candidates(rec)], [{'of': 'evidence', 'page': 2}, {'of': 't1', 'page': 2}, {'of': 't1', 'page': 3}])
        rec['tool_calls'].append({'id': 't2', 'tool': 'page', 'continuation': True, 'pages_of': ['t1'], 'args': {'cursor': 'c'}})
        rec['tool_calls'].append({'id': 't3', 'tool': 'page', 'continuation': True, 'pages_of': ['e1'], 'args': {'cursor': 'd'}})
        self.assertEqual([c['args'] for c in UC2.page_candidates(rec)], [{'of': 't1', 'page': 3}])

    def test_only_v31_format_records_and_uncalled1_is_unchanged(self):
        with self.assertRaises(ValueError):
            UC2.summarise([(dict(v31_record(), evidence_format={'version': 'v3'}), {})], th.TESTDATA)
        self.assertEqual(UC2.COUNTER_VERSION, 'uncalled-2')
        self.assertFalse(hasattr(UC1, 'COUNTER_VERSION'))          # uncalled-1 is the unchanged dev-c6 module


class UncalledCounterV2OnDevC7(unittest.TestCase):
    """The committed docs/contract-v3-uncalled-v2.json is what the script writes now (uncalled-2 over dev-c7, uncalled-1 beside it)."""

    @classmethod
    def setUpClass(cls):
        B.need_v11()

    def test_the_committed_counts_reproduce(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('uncalled_v2_script', th.COMPONENT / 'scripts' / 'contract_v3_uncalled_v2.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if pod_local_fixtures_missing():
            self.skipTest('a pod-local EPUB fixture is not in this checkout: the resolved case evidence differs here')
        out = Path(tempfile.mkdtemp(prefix='mrh-w25-')) / 'u.json'
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--out', str(out)])
        self.assertEqual(out.read_text(), (DOCS / 'contract-v3-uncalled-v2.json').read_text())


# ------------------------------------------------------------------------------------------------------------- earlier results stay reproducible
class EarlierVersionsUnchanged(unittest.TestCase):
    def test_defaults_select_every_earlier_version(self):
        self.assertEqual((EV2.active_diagnostic_rules(), EV2.DEFAULT_DIAGNOSTIC_RULES), ('diag-1', 'diag-1'))
        self.assertEqual(T.TOOLS_BEHAVIORS, ('v1', 'v2', 'v3', 'v4'))
        self.assertEqual(EV31.TOOLS_BEHAVIOR, 'v3')                      # format v3.1-format still selects tools behaviour v3 ...
        self.assertEqual(EV31.CHECKER_RUBRIC, RB.RUBRIC_V31_VERSION)     # ... and the v3.1 checker
        self.assertEqual(EV2._DAMAGE_RXS, [__import__('re').compile(r'(?:%s)%s' % (p, EV2._TAIL)) for p, _s, _n in EV2.DAMAGE_ALLOW_LIST
                                            if not p.startswith('Invalid data found')])

    def test_the_v31_tension_list_reproduces(self):
        B.need_v11()       # (the list does not depend on the pod-local fixtures: it reproduces without them too)
        import importlib.util
        spec = importlib.util.spec_from_file_location('tension_script', th.COMPONENT / 'scripts' / 'contract_v3_tension.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        tmp = Path(tempfile.mkdtemp(prefix='mrh-w25-'))
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--json', str(tmp / 't.json'), '--md', str(tmp / 't.md')])
        self.assertEqual((tmp / 't.json').read_bytes(), (DOCS / 'contract-v3-label-tension.json').read_bytes())
        self.assertEqual((tmp / 't.md').read_bytes(), (DOCS / 'contract-v3-label-tension.md').read_bytes())
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--checker', 'v3.3', '--diagnostic-rules', 'diag-2', '--json', str(tmp / 't3.json'), '--md', str(tmp / 't3.md')])
        self.assertEqual((tmp / 't3.json').read_bytes(), (DOCS / 'contract-v3-label-tension-v3.3.json').read_bytes())
        self.assertEqual((tmp / 't3.md').read_bytes(), (DOCS / 'contract-v3-label-tension-v3.3.md').read_bytes())       # W25b nit: the Markdown too
        self.assertEqual([r['id'] for r in json.loads((tmp / 't3.json').read_text())['listed']],
                         [r['id'] for r in json.loads((tmp / 't.json').read_text())['listed']])

    def test_committed_scores_rescore_identically(self):
        B.need_v11()
        from media_repair_harness import score_compat
        S = score_compat.load_score()
        n = 0
        for root in ('dev-c4', 'dev-c5', 'dev-c6', 'dev-c7', 'dev-c7-qwen-r2'):
            for run in sorted(p.parent for p in (B.RUNS / root).glob('*/score.json')):
                now = S.score(run, B.SUITE_V11)
                self.assertEqual(json.dumps(now, sort_keys=True), json.dumps(json.loads((run / 'score.json').read_text()), sort_keys=True), run.name)
                n += 1
        self.assertEqual(n, 21)


class DevC7ReRendered(unittest.TestCase):
    """dev-c7 stays byte-identical through the tools.py change (the v3 checks now read `_v3plus`): every committed dev-c7 base-run record (prompt v7, format
    v3.1-format, guards v3; the restored views share their transcripts) is re-run OFFLINE with the recorded replies played back (no model call), and every
    request, the decision, guard outcome, reference resolution, action audit (the v3.1 checker), tool calls and the format record equal the record.  A case
    whose fixture is not in this checkout (a pod-local cache) is skipped as unavailable coverage, as in tests/test_devc7_replay.py."""
    # the aborted 5-case qwen first pass ends in a GPU-fit abort that only the Ollama adapter produces; its records are pinned by tests/test_devc7_qwen_r2.py
    RUNS = (('dev-c7', 'devc7-gpt-6-astra', 73), ('dev-c7', 'devc7-haiku-5-5', 73), ('dev-c7-qwen-r2', 'devc7r2-qwen3.8-27b', 73))

    @classmethod
    def setUpClass(cls):
        B.need_v11()

    def test_requests_decisions_guards_audit_and_records_are_reproduced(self):
        from media_repair_harness import adapters as A
        from media_repair_harness import run as R
        n_req = n_rec = skipped = 0
        for root, run, size in self.RUNS:
            records = sorted((B.RUNS / root / run).glob('*-*-*.json'))
            self.assertEqual(len(records), size, run)
            for p in records:
                rec = json.loads(p.read_text())
                self.assertEqual((rec['prompt']['version'], rec['evidence_format']['version']), ('v7', 'v3.1-format'), p.name)
                case = B.load_case(rec['case_id'], rec['case_sha256'])
                locator = str((case.get('fixture') or {}).get('locator') or '')
                if 'media-repair-harness-1019' in locator or T.Fixture.from_case(case, B.SUITE_V11).verify_local() != rec['fixture']:
                    skipped += 1
                    continue
                n_rec += 1
                ad = B.Replay(rec['requested_model'], [t['text'] for t in rec['turns']])
                new = R.run_case(case, rec['case_sha256'], ad, B.SUITE_V11, tempfile.mkdtemp(prefix='mrh-w25-'), run_id=rec['run_id'], prompt_version='v7',
                                 evidence_format='v3.1-format', guards='v3', replay='auto', which=th.NO_BINARIES, tool_output_bytes=8192)
                self.assertEqual(len(ad.sent), len(rec['turns']), p.name)
                for sent, turn in zip(ad.sent, rec['turns']):
                    raw = turn['raw_request']
                    if 'messages' in raw:
                        self.assertEqual([{'role': 'system', 'content': sent['system']}] + sent['messages'], raw['messages'], p.name)
                        self.assertEqual(sent['schema'], raw['format'], p.name)
                    elif 'system_prompt' in raw:
                        self.assertEqual(sent['system'], raw['system_prompt'], p.name)
                        self.assertEqual(A.render_transcript(sent['messages']), raw['prompt'], p.name)
                    else:
                        self.assertEqual(sent['system'] + '\n\n---\n\n' + A.render_transcript(sent['messages']), raw['prompt'], p.name)
                    n_req += 1
                for key in ('decision', 'guard', 'bad_evidence_refs', 'refs_to_failed_tools', 'refs_to_non_ok_tools', 'decision_flags', 'unverified_parts', 'forced'):
                    self.assertEqual(new.get(key), rec.get(key), (p.name, key))
                self.assertEqual(new['action_audit'], rec['action_audit'], p.name)
                for key in ('capabilities', 'messages', 'final_summary', 'wire_bytes', 'audit_version', 'tools_behavior', 'rubric', 'checker_rubric', 'version'):
                    self.assertEqual(new['evidence_format'].get(key), rec['evidence_format'].get(key), (p.name, key))
                strip = lambda calls: [{k: v for k, v in c.items() if k != 'wall_s'} for c in calls]
                self.assertEqual(strip(new['tool_calls']), strip(rec['tool_calls']), p.name)
        self.assertEqual(n_rec + skipped, 219)
        self.assertGreaterEqual(n_rec, 207, (n_rec, skipped))
        print('\ndev-c7 replay: %d records re-rendered, %d requests equal, %d unavailable here (pod-local fixtures)' % (n_rec, n_req, skipped))


class DeltasReproduce(unittest.TestCase):
    """docs/w25-deltas.json (the public typed-verdict deltas reported in the PR and in docs/contract-v3.md section 17) is what the script writes now."""

    def test_the_committed_deltas_reproduce(self):
        B.need_v11()
        if pod_local_fixtures_missing():
            self.skipTest('a pod-local EPUB fixture is not in this checkout: the epub_inspect {} results legitimately differ here')
        import importlib.util
        spec = importlib.util.spec_from_file_location('w25_deltas_script', th.COMPONENT / 'scripts' / 'w25_deltas.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = Path(tempfile.mkdtemp(prefix='mrh-w25-')) / 'd.json'
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--out', str(out)])
        self.assertEqual(out.read_text(), (DOCS / 'w25-deltas.json').read_text())
        doc = json.loads(out.read_text())
        for suite in doc['suites'].values():
            self.assertEqual(suite['changed'], {'checker': 9, 'epub_inspect_default': 0, 'evidence_verdicts': 0, 'prior_record_kinds': 0})


class PassabilityReproduces(unittest.TestCase):
    """The committed passability outputs (dev-c6 passability-1, dev-c7 passability-3) are what the unchanged scripts write on this tree."""

    @classmethod
    def setUpClass(cls):
        B.need_v11()

    def run_script(self, name, root, run):
        import importlib.util
        spec = importlib.util.spec_from_file_location(name.replace('.py', '') + '_w25', th.COMPONENT / 'scripts' / name)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = Path(tempfile.mkdtemp(prefix='mrh-w25-')) / 'p.json'
        d = B.RUNS / root
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--run', str(d / run), '--restored', str(d / (run + '-restored')), '--suite', str(B.SUITE_V11), '--out-json', str(out)])
        return out.read_bytes()

    def test_dev_c6_and_dev_c7(self):
        if pod_local_fixtures_missing():
            self.skipTest('a pod-local EPUB fixture is not in this checkout: the exploration result legitimately differs here')
        self.assertEqual(self.run_script('passability.py', 'dev-c6', 'devc6-gpt-6-astra'), (B.RUNS / 'dev-c6' / 'passability.json').read_bytes())
        self.assertEqual(self.run_script('passability_v3.py', 'dev-c7', 'devc7-gpt-6-astra'), (B.RUNS / 'dev-c7' / 'passability.json').read_bytes())


# ------------------------------------------------------------------------------------------------------------- W25b: review fixes (AUDIT-ASTRA-37, the Opus review)
class NewlineInMemberNameA37(unittest.TestCase):
    """A37-1: the zip_crc member suffix is recognised on the whole text before it is split into lines, so a line break in the name cannot hide a trailing
    execution error (which diag-1, kept, reads as damage)."""
    TEXTS = ('CRC mismatch in member a\nb.epub: Permission denied', "BadZipFile: Bad CRC-32 for file 'a\\nb.epub: Permission denied' in member a\nb.epub: Permission denied",
             'CRC mismatch in member a\r\nb.xhtml: [Errno 5] Input/output error', 'CRC mismatch in member a\nPermission denied')

    def test_a_newline_in_the_name_keeps_execution_precedence_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for text in self.TEXTS:
                self.assertEqual(EV2.epub_failure('zip_crc', text), 'execution', repr(text))
            o = EV2.make_observation('t1', 'epub_inspect', {}, 'error', json.dumps({'status': 'error', 'stage': 'zip_crc', 'error': self.TEXTS[0]}), 'local', 'tool')
            d = EV2.derive(o)
            self.assertEqual((d.execution.get('cause'), [f['kind'] for f in d.findings if f['known_defect']]), ('tool', []))
            self.assertEqual(PQ33.check_named(PQ33.View([o], {}, 'epub'), 'support_grade_defect')[0], 'unmet')
            live = {'source': 'live', 'kind': 'epub', 'status': 'error', 'cause': 'input', 'reason': 'zip_crc: x', 'output': {'valid': False, 'stage': 'zip_crc',
                    'error': self.TEXTS[1]}, 'coverage': {'verified': [], 'not_verified': []}}
            d = EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, 'error', json.dumps(live), 'live', 'tool'))
            self.assertEqual((d.execution.get('cause'), [f['kind'] for f in d.findings if f['known_defect']]), ('tool', []))

    def test_control_a_newline_name_without_an_execution_tail_is_damage_and_diag1_is_unchanged(self):
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(EV2.epub_failure('zip_crc', 'CRC mismatch in member a\nb.xhtml'), 'damage')
        self.assertEqual(EV2.epub_failure('zip_crc', self.TEXTS[0]), 'damage')          # diag-1 as recorded


class RealCrcLinesDiag2(unittest.TestCase):
    """W25b nit: the real CRC lines of both collectors classify under diag-2 whatever the member name holds (a colon, ' in member ', a leading space, a
    line break, a name whose quoted form the live collector cut at 200 characters)."""
    NAMES = ('OEBPS/a.xhtml', 'OEBPS/a:b.xhtml', 'OEBPS/a in member b.xhtml', ' a.xhtml', 'OEBPS/a\nb.xhtml', 'OEBPS/' + 'x' * 190 + '.xhtml', "OEBPS/it's.xhtml")

    @staticmethod
    def live(name):        # evidence/epubtool.py: '%s in member %s' % (_err(e), i.filename), _err = type name + str(e)[:200]
        return 'BadZipFile: %s in member %s' % (('Bad CRC-32 for file %r' % name)[:200], name)

    def test_both_collectors_crc_lines_are_damage_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for name in self.NAMES:
                self.assertEqual(EV2.epub_failure('zip_crc', 'CRC mismatch in member %s' % name), 'damage', repr(name))     # tools._epub_stage
                self.assertEqual(EV2.epub_failure('zip_crc', self.live(name)), 'damage', repr(name))
                self.assertEqual(EV2.epub_failure('zip_crc', self.live(name) + ': Permission denied'), 'execution', repr(name))

    def test_control_execution_messages_with_a_suffix_stay_execution_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for text in ("PermissionError: [Errno 13] Permission denied: 'a.xhtml' in member a.xhtml", 'OSError: [Errno 5] Input/output error in member a in member b.xhtml'):
                self.assertEqual(EV2.epub_failure('zip_crc', text), 'execution', text)


class DecoratedExecutionErrorsOpus2(unittest.TestCase):
    """Opus 2: the classifier's own decoration (`<Name>Error: `, `[Errno N] `) in front of an execution message after an open-tail message, and the three
    open-tail manifest patterns, under diag-2."""
    TAILS = (": PermissionError: [Errno 13] Permission denied: 'a.xhtml'", ': [Errno 13] Permission denied', ': MemoryError: Invalid data found when processing input',
             ': OSError: [Errno 5] Input/output error')
    MANIFEST = ("manifest names 1 member(s) that are not in the archive: ['OEBPS/a.xhtml']", "manifest names members that are not in the archive: ['OEBPS/a.xhtml']",
                'manifest references missing member(s): OEBPS/a.xhtml')

    def test_decorated_execution_errors_are_execution_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for msg in OPEN_TAIL + self.MANIFEST:
                for tail in self.TAILS + (': Permission denied',):
                    self.assertEqual(EV2.classify_line(msg + tail), 'execution', msg + tail)
                self.assertEqual(EV2.classify_line(msg), 'damage', msg)
            self.assertEqual(EV2.classify_line('Bad CRC-32 for file: MemoryError: Invalid data found when processing input'), 'execution')
            self.assertEqual(EV2.epub_failure('zip_crc', 'CRC mismatch in member a.xhtml' + self.TAILS[0]), 'execution')
            self.assertEqual(EV2.epub_failure('manifest', self.MANIFEST[0] + ': Permission denied'), 'execution')

    def test_control_diag1_still_reads_them_as_damage(self):
        for msg in self.MANIFEST:
            self.assertEqual(EV2.classify_line(msg + ': Permission denied'), 'damage')
        self.assertEqual(EV2.classify_line('CRC mismatch in member a.xhtml' + self.TAILS[1]), 'damage')


class RemoteAndColonHrefsOpus3(EpubCase):
    """Opus 3: under tools v4 only http(s) URLs and network locations are remote; a colon-named member is local; an all-remote spine is not "the spine
    is empty" (the live collector reports it valid), so replay and live agree."""

    def typed_live(self, path):
        rec = EVC.collect(path, ['epub'])[0]
        with EV2.diagnostic_rules('diag-2'):
            return EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, rec['status'], json.dumps(rec), 'live', 'tool')).integrity

    def test_the_remote_rule_v4(self):
        for href, remote in (('https://example.org/a.xhtml', True), ('HTTP://example.org/a', True), ('//cdn.example.org/f.woff2', True), ('ftp://host/x', True),
                             ('Part1:Intro.xhtml', False), ('urn:x', False), ('a.xhtml#frag', False), ('../x.xhtml', False)):
            self.assertEqual(T.remote_href_v4(href), remote, href)
        self.assertEqual(T.local_href_v4('OEBPS/c.opf', 'Part1:Intro.xhtml'), 'OEBPS/Part1:Intro.xhtml')
        self.assertEqual(T.local_href_v4('OEBPS/c.opf', 'Text/a%20b.xhtml#x'), 'OEBPS/Text/a b.xhtml')

    def test_a_colon_named_spine_document_is_local_v4(self):
        path = self.write(epub_bytes([('Part1:Intro.xhtml', CHAPTER)]))
        self.assertIsNone(T._epub_stage(path, remote_ok=True))
        res = self.inspect(path, 'v4')
        self.assertEqual(res.status, 'ok', res.output)
        self.assertEqual(res.output['spine_items'], 1)
        self.assertGreater(res.output['spine_characters'], 0)
        self.assertEqual(self.typed(res, 'diag-2').integrity, 'clean')
        self.assertEqual(self.typed_live(path), 'clean')

    def test_an_all_remote_spine_has_its_own_wording_v4(self):
        remote = '<item id="r" href="https://example.org/ch.xhtml" media-type="application/xhtml+xml"/>'
        path = self.write(epub_bytes([('ch1.xhtml', CHAPTER)], extra_manifest=remote, spine=['r']))
        res = self.inspect(path, 'v4')
        self.assertEqual(res.status, 'ok', res.output)
        self.assertEqual((res.output['spine_items'], res.output.get('remote_spine_items'), res.output.get('spine_note')), (0, 1, getattr(T, 'ALL_REMOTE_V4', 'x')))
        self.assertNotIn('the spine is empty', json.dumps(res.output))
        self.assertEqual(self.typed(res, 'diag-2').integrity, 'clean')
        status, out = self.live(path)
        self.assertEqual((status, out['valid']), ('ok', True))
        self.assertEqual(self.typed_live(path), 'clean')                     # replay and live agree
        mixed = self.write(epub_bytes([('ch1.xhtml', CHAPTER)], extra_manifest=remote, spine=['i0', 'r']), 'q9z')
        got = self.inspect(mixed, 'v4').output
        self.assertEqual((got['spine_items'], got['remote_spine_items'], 'spine_note' in got), (1, 1, False))

    def test_control_v3_keeps_the_earlier_reading(self):
        path = self.write(epub_bytes([('Part1:Intro.xhtml', CHAPTER)]))
        self.assertEqual(T._epub_stage(path), ('manifest', "manifest names members that are not in the archive: ['OEBPS/Intro.xhtml']"))
        self.assertEqual(self.inspect(path, 'v3').output['stage'], 'manifest')


class V4PairingOpus4(unittest.TestCase):
    """Opus 4: tools behaviour v4 is refused at configuration time unless the diagnostic rules are diag-2 (diag-1 stays byte-identical and does not know
    the v4 wording, so an all-empty book would be unclassified there)."""

    def ctx(self, behavior):
        return T.Context({'id': 'case-x', 'tools_available': ['epub_inspect'], 'media_type': 'epub'}, T.Fixture('none', None), tempfile.mkdtemp(prefix='mrh-w25-'),
                         tools_behavior=behavior)

    def test_v4_is_refused_outside_diag2_v4(self):
        with self.assertRaises(ValueError):
            self.ctx('v4')
        with EV2.diagnostic_rules('diag-1'):
            with self.assertRaises(ValueError):
                self.ctx('v4')
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(self.ctx('v4').tools_behavior, 'v4')
        self.assertEqual(T.TOOLS_V4_DIAGNOSTIC_RULES, 'diag-2')

    def test_control_earlier_behaviours_build_under_either_rules(self):
        for rules in EV2.DIAGNOSTIC_RULES:
            with EV2.diagnostic_rules(rules):
                for b in ('v1', 'v2', 'v3'):
                    self.assertEqual(self.ctx(b).tools_behavior, b)


class AmbiguousReportContestsOpus1(unittest.TestCase):
    """Opus 1: an ambiguous prior record (content words beside declaration or hash words) establishes no content under v3.3, but a disagreement still
    contests identity and makes M5 present, as the same report does under v3.1 (report_declaration / report_hash)."""
    EPUB = {'status': 'ok', 'opf': 'OEBPS/c.opf', 'dc_title': ['Alpha Book'], 'dc_creator': ['A. Writer'], 'spine_items': 3, 'spine_characters': 900, 'entries': 6}

    def states(self, mod, method, titles=('Completely Different Novel',)):
        obs = [D.ob('e2', 'epub_inspect', self.EPUB, source='case'), D.prior(method, titles, oid='e1')]
        r = mod.check(obs, D.CAT, 'epub')
        return (r['identity']['level'], next(m['state'] for m in r['material'] if m['id'] == 'M5'),
                {x['id']: x['state'] for x in r['diagnosis']['healthy']}, {x['id']: x['state'] for x in r['diagnosis']['metadata_naming']})

    def test_an_ambiguous_report_still_contests_identity_v33(self):
        for method in ('OPF metadata read', 'MD5 of the audio', 'tags and the opening title cards'):
            new, old = self.states(PQ33, method), self.states(PQ, method)
            self.assertEqual(new[:2], ('contested', 'met'), method)
            self.assertEqual(new, old, method)                                  # the v3.1 effect of a declaration-strength report, exactly
            self.assertEqual((new[2]['D-OK-H3'], new[2]['D-OK-H4']), ('unmet', 'unmet'), method)

    def test_control_an_ambiguous_report_establishes_no_content(self):
        self.assertEqual(self.states(PQ33, 'OPF metadata read', ('Alpha Book',))[0], 'uncontradicted')            # agreement is declared_agree only
        self.assertEqual(self.states(PQ33, 'OCR of the title cards', ('Alpha Book',))[0], 'content_verified')     # a content report does verify
        self.assertEqual(self.states(PQ33, 'no OCR performed', ('Completely Different Novel',))[0], 'uncontradicted')      # negated: reports nothing


class PageAndExcerptCoverageA37(unittest.TestCase):
    """A37-2 and A37-3: uncalled-2 reads explicit-excerpt lengths beyond the index (partial, complete and failed reads told apart) and counts the
    distinct pages actually served."""

    def caps(self):
        return v31_record()['evidence_format']['capabilities']

    def unindexed(self):
        o = body_obs('t1', [{'spine': i, 'member': 'm%d' % i, 'characters': 0, 'headings': []} for i in range(24)], [])
        d = json.loads(o['output'])
        d['body']['items_total'] = 25
        return dict(o, output=json.dumps(d))

    def excerpt(self, oid, offset, end, n=1800, **kw):
        ex = dict({'spine': 24, 'member': 'm24', 'offset': offset, 'end': end, 'item_characters': n, 'text': 'a' * (end - offset),
                   'next_offset': end if end < n else None}, **kw)
        return EV31.internal(D.ob(oid, 'epub_inspect', {'extraction': 'xhtml-body-text-3', 'excerpt': ex}))

    def test_a_partial_read_beyond_the_index_leaves_a_candidate_uncalled2(self):
        got = UC2.excerpt_candidates([self.unindexed(), self.excerpt('t2', 0, 600)], self.caps(), ['epub_inspect'])
        self.assertEqual([(c['args'], c['read']) for c in got], [({'spine': 24, 'offset': 600}, 'partial')])
        done = UC2.excerpt_candidates([self.unindexed(), self.excerpt('t2', 0, 600), self.excerpt('t3', 600, 1800)], self.caps(), ['epub_inspect'])
        self.assertEqual(done, [])                                                             # complete: [0, 1800) covered
        failed = D.ob('t3', 'epub_inspect', {'status': 'error'}, status='error')
        self.assertEqual(UC2.excerpt_candidates([self.unindexed(), self.excerpt('t2', 0, 600), failed], self.caps(), ['epub_inspect'],
                                                {'t3': {'spine': 24, 'offset': 600}}), [])      # the failed request is not repeated
        unstated = self.excerpt('t2', 0, 600)
        unstated = dict(unstated, output=json.dumps({'extraction': 'xhtml-body-text-3', 'excerpt': {'spine': 24, 'offset': 0, 'end': 600, 'text': 'a'}}))
        self.assertEqual([c['args'] for c in UC2.excerpt_candidates([self.unindexed(), unstated], self.caps(), ['epub_inspect'])], [{'spine': 24, 'offset': 600}])

    def test_a_page_fetched_twice_counts_once_uncalled2(self):
        def fetch(oid, n, out=None, of=('t1',)):
            page = EV2.tool_envelope(oid, 'epub_inspect', 'ok', False, {'page': {'contract': 'pages-v1', 'source': 't1', 'n': n, 'of': 5}}, 3)
            return {'id': oid, 'tool': 'page', 'continuation': True, 'pages_of': list(of), 'args': {'cursor': 'c%s' % oid}, 'status': 'ok',
                    'output': page if out is None else out}
        msgs = [{'id': 'evidence', 'kind': 'initial', 'pages': 1}, {'id': 't1', 'kind': 'result', 'pages': 5}]
        rec = v31_record(calls=[{'id': 't1', 'tool': 'epub_inspect', 'args': {}}, fetch('t2', 2), fetch('t3', 2)], messages=msgs)
        self.assertEqual([c['args']['page'] for c in UC2.page_candidates(rec)], [3, 4, 5])
        rec['tool_calls'].append(fetch('t4', None, out='(not a page object)'))           # a valid cursor whose page is not readable: the next unserved page
        self.assertEqual([c['args']['page'] for c in UC2.page_candidates(rec)], [4, 5])
        bad = {'id': 't5', 'tool': 'page', 'continuation': True, 'args': {'cursor': 'zz'}, 'status': 'error', 'output': '{"type":"tool_result"}'}
        rec['tool_calls'].append(bad)                                                      # an unknown cursor served nothing
        self.assertEqual([c['args']['page'] for c in UC2.page_candidates(rec)], [4, 5])


class TensionVersionsStatedNit(unittest.TestCase):
    """W25b nit: a non-default tension run names its checker, the rubric that checker applies and its diagnostic rules (contract_v3_tension.py)."""

    def test_a_non_default_run_states_its_versions(self):
        B.need_v11()
        import importlib.util
        spec = importlib.util.spec_from_file_location('tension_script_b', th.COMPONENT / 'scripts' / 'contract_v3_tension.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        tmp = Path(tempfile.mkdtemp(prefix='mrh-w25-'))
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--diagnostic-rules', 'diag-2', '--json', str(tmp / 't.json'), '--md', str(tmp / 't.md')])
        doc = json.loads((tmp / 't.json').read_text())
        self.assertEqual((doc['rubric'], doc['checker'], doc['diagnostic_rules']), (RB.RUBRIC_V31_VERSION, 'prereq-v3.1', 'diag-2'))
        self.assertNotIn('v3.3', doc['note'])
        md = (tmp / 't.md').read_text()
        self.assertNotIn('frozen before any label was read', md)
        self.assertIn('`diag-2`', md)
        self.assertIn('`prereq-v3.1`', md)


class AuditV33Nit(unittest.TestCase):
    """W25b nit: prereq_v33.audit is targets.audit_v3 with the v3.3 checker (schema first; a non-write proposes nothing; a write lists the diagnosis,
    action and role prerequisites)."""
    HEADS = {'status': 'ok', 'opf': 'OEBPS/c.opf', 'dc_title': ['Alpha Book'], 'dc_creator': ['A. Writer'], 'spine_items': 2, 'spine_characters': 900,
             'spine_heads': ['Some unrelated words only', 'and more']}

    def decision(self, **kw):
        d = {'type': 'decision', 'class': 'identity_mismatch', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e1'],
             'source': {'ref': 'e1'}, 'target': {'kind': 'release_of_source', 'source_ref': 'e1'}}
        d.update(kw)
        return d

    def test_audit_with_the_v33_checker(self):
        from media_repair_harness.experimental.contract_v3 import targets as TG
        obs = [D.ob('e1', 'epub_inspect', self.HEADS, source='case')]
        new, old = PQ33.audit(self.decision(), obs, D.CAT, 'epub'), TG.audit_v3(self.decision(), obs, D.CAT, 'epub')
        self.assertEqual((new['checker'], new['rubric'], new['executed'], new['execution_status']), ('prereq-v3.3', RB33.RUBRIC_V33_VERSION, False, 'proposed_not_executed'))
        st = lambda a: {p['id']: p['state'] for p in a['prerequisites']}
        self.assertEqual({k for k in st(new)}, {k for k in st(old)})
        self.assertEqual((st(old)['D-ID-1'], st(new)['D-ID-1']), ('unknown', 'unmet'))            # A33-3: the legacy heads are not content
        self.assertEqual({k: v for k, v in st(new).items() if k not in ('D-ID-1', 'A-BLK-4')}, {k: v for k, v in st(old).items() if k not in ('D-ID-1', 'A-BLK-4')})
        self.assertEqual(new['references'], old['references'])
        self.assertEqual(PQ33.audit(self.decision(action='escalate', source=None), obs, D.CAT, 'epub')['execution_status'], 'refused_invalid_decision')
        plain = {k: v for k, v in self.decision(action='escalate', **{'class': 'insufficient_evidence'}).items() if k not in ('source', 'target')}
        self.assertEqual(PQ33.audit(plain, obs, D.CAT, 'epub')['execution_status'], 'no_write_proposed')


# ------------------------------------------------------------------------------------------------------------- W25b round 2 (AUDIT-ASTRA-40, the Opus review of 8ca60f94)
class ManifestPrecedenceA40(unittest.TestCase):
    """AUDIT-ASTRA-40 item 1: under diag-2 the execution suffix of the COMPLETE diagnostic is recognised before it is clipped to 1,000 characters or split
    into lines, so neither can turn an open-tail manifest message that ends in an execution error into write-supporting damage."""
    LONG = 'manifest references missing member(s): ' + 'a' * 1020 + ': PermissionError: [Errno 13] Permission denied'
    SPLIT = 'manifest references missing member(s): a\nb.epub: Permission denied'

    def typed(self, error, stage='manifest'):
        o = EV2.make_observation('t1', 'epub_inspect', {}, 'error', json.dumps({'status': 'error', 'stage': stage, 'error': error}), 'local', 'tool')
        d = EV2.derive(o)
        return (d.execution.get('cause'), [f['kind'] for f in d.findings if f['known_defect']], PQ33.check_named(PQ33.View([o], {}, 'epub'), 'support_grade_defect')[0])

    def test_clipped_or_split_manifest_errors_keep_execution_precedence_diag2(self):
        with EV2.diagnostic_rules('diag-2'):
            for error in (self.LONG, self.SPLIT, 'manifest names 2 member(s) that are not in the archive: ' + 'b' * 1200 + ': Permission denied',
                          "CRC mismatch in member " + 'c' * 1100 + ": [Errno 5] Input/output error"):
                self.assertEqual(self.typed(error, 'zip_crc' if error.startswith('CRC') else 'manifest'), ('tool', [], 'unmet'), error[:60])
            self.assertEqual(EV2.classify_line(self.LONG), 'execution')
            live = {'source': 'live', 'kind': 'epub', 'status': 'error', 'cause': 'input', 'reason': 'manifest: x', 'output': {'valid': False, 'stage': 'manifest',
                    'error': self.SPLIT}, 'coverage': {'verified': [], 'not_verified': []}}
            d = EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, 'error', json.dumps(live), 'live', 'tool'))
            self.assertEqual((d.execution.get('cause'), [f['kind'] for f in d.findings if f['known_defect']]), ('tool', []))

    def test_control_long_manifest_damage_without_an_execution_tail_and_diag1(self):
        with EV2.diagnostic_rules('diag-2'):
            self.assertEqual(self.typed('manifest references missing member(s): ' + 'a' * 1020)[1], ['package_damage'])
            self.assertEqual(self.typed("manifest names 1 member(s) that are not in the archive: ['OEBPS/a.xhtml']")[1], ['package_damage'])
        self.assertEqual(self.typed(self.SPLIT)[1], ['package_damage'])          # diag-1 as recorded


class LinearTailCheckOpusR2(unittest.TestCase):
    """The Opus review of 8ca60f94: the diag-2 end-anchored execution check and the zip_crc readings stay linear and small on adversarial member names
    (one call per input, no loops over large inputs)."""

    def test_adversarial_names_classify_fast_and_small_diag2(self):
        import time
        with EV2.diagnostic_rules('diag-2'):
            for text in ('CRC mismatch in member a' + '\n' * 20000 + 'x', 'CRC mismatch in member a' + '\n' * 65000 + 'x',
                         'CRC mismatch in member ' + ' in member ' * 5900 + 'x', 'CRC mismatch in member a:' + ' ' * 65000 + 'x',
                         'manifest references missing member(s): ' + 'a\n' * 32000 + 'b.epub: Permission denied'):
                t0 = time.perf_counter()
                EV2.epub_failure('manifest' if text.startswith('manifest') else 'zip_crc', text)
                self.assertLess(time.perf_counter() - t0, 1.0, repr(text[:30]))
        readings = EV2._zip_crc_readings('CRC mismatch in member ' + ' in member ' * 200 + 'x')       # bounded: messages only, the name is an index
        self.assertLessEqual(len(readings), EV2._READINGS_MAX)
        self.assertTrue(all(isinstance(r[1], int) and len(r[0]) <= EV2._READING_HEAD_MAX for r in readings))

    def test_the_linear_check_is_the_regex_answer(self):
        import re
        rx = re.compile(EV2._ENDS_IN_EXEC)
        for text in ('a: Permission denied', 'a:Permission denied', 'a\nPermission denied', 'a: [Errno 13] Permission denied', 'a: PermissionError: [Errno 13] Permission denied: x',
                     'a: MemoryError: x', 'a: MemoryError:', 'a: Permission denied:', 'a: Permission denied: x\ny', 'a: Permission denied:\nx', 'a: Permission denied.  \n',
                     'a: Error -4 while decompressing data: insufficient memory', 'a \x1c Is a directory, b', 'a: [Errno x] Permission denied', 'Permission denied',
                     ': : : x', 'a:' + ' ' * 50 + 'Permission denied', 'a: Bad file descriptor', 'a]: [Errno 7] Connection refused; c'):
            for lo in (0, 1, 3):
                self.assertEqual(EV2._ends_in_exec(text, lo), rx.search(text[lo:]) is not None, (text, lo))


if __name__ == '__main__':
    unittest.main()
