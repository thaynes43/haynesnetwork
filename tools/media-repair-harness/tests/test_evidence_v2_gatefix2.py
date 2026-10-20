"""Gate fix, second round (OpenProject #148, re-reviews of 13aed22b): the 'in member' suffix is stripped only where the collector writes it, a collector's `input` cause never makes
a defect, the replay inspector's real damage is recognised again (generated broken EPUBs on the replay and the live paths), and recorded error results of the audio, frame and
audiobook tools keep their typed damage.  Counterexample next to control throughout."""
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import ev2h
import th
from ev2h import derive_one, obs
from media_repair_harness import audit as AU
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence as E
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import run as R
from media_repair_harness import tools as T
from test_evidence_v2_core import live_epub
from test_evidence_v2_gatefix import case_with, write_decision

SUFFIX_LINES = ('File is not a zip file in member book.epub: Permission denied', 'moov atom not found in member x.mkv: Permission denied',
                'error: Error -3 while decompressing data: invalid block type in member x.epub: Permission denied')


class MemberSuffixOnlyWhereTheCollectorWritesIt(unittest.TestCase):
    """Astra 1: a phrase 'in member' inside a file name is not the collector's suffix."""

    def test_a_file_name_with_the_phrase_and_a_permission_error_is_an_execution_failure_everywhere(self):
        for text in SUFFIX_LINES:
            self.assertEqual(EV2.classify_line(text), 'execution', text)
            self.assertEqual(EV2.epub_failure('zip_crc', text), 'execution', text)
            d = derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 9, 'error': text, 'stage': 'zip_crc', 'status': 'error'}))
            self.assertEqual((d.execution['cause'], d.integrity, any(f['known_defect'] for f in d.findings)), ('tool', 'unknown', False), text)

    def test_the_phrase_is_not_stripped_by_the_global_classifier_or_at_another_stage(self):
        self.assertIsNone(EV2.classify_line('File is not a zip file in member book.epub'))
        self.assertIsNone(EV2.epub_failure('opf_parse', 'error: Error -5 while decompressing data: incomplete or truncated stream in member x'))
        self.assertEqual(EV2.epub_failure('zip_crc', 'error: Error -5 while decompressing data: incomplete or truncated stream in member OEBPS/ch1.xhtml'), 'damage')     # control
        self.assertEqual(EV2.epub_failure('zip_crc', "BadZipFile: Bad CRC-32 for file 'a.xhtml' in member a b.xhtml"), 'damage')

    def test_a_structured_probe_error_with_such_a_file_name_does_not_support_a_write_under_guards_v3(self):
        out = json.dumps({'exit_code': 1, 'stderr': SUFFIX_LINES[0]})
        case = case_with(out, tool='ffprobe')
        final, rec = DG.apply(case, write_decision(['e1']), [], case['evidence'], 'v4', version='v3')
        self.assertTrue(rec['applied'] and 'cited_evidence_supports' in rec['applied'][0]['reason'])
        control = case_with(json.dumps({'exit_code': 1, 'stderr': 'File is not a zip file'}), tool='ffprobe')
        self.assertFalse(DG.apply(control, write_decision(['e1']), [], control['evidence'], 'v4', version='v3')[1]['applied'])


def live_record(error, stage, cause='input'):
    return live_epub(valid=False, status='error', cause=cause, stage=stage, error=error, passed=('zip_open',) if stage != 'zip_open' else ())


class CollectorCauseNeverMakesADefect(unittest.TestCase):
    """Astra 2 / Opus: live and replay agree for the same text; only recognised damage is a defect."""

    UNCLASSIFIED = ('error: Error -2 while decompressing data: inconsistent stream state in member OEBPS/ch1.xhtml', 'RuntimeError: ZIP file is closed',
                    'something nobody has classified')

    def verdict(self, d):
        return (d.integrity, any(f['known_defect'] for f in d.findings))

    def test_unclassified_text_reads_unknown_on_the_live_and_the_replay_path_alike(self):
        for text in self.UNCLASSIFIED:
            for stage in ('zip_crc', 'opf_parse'):
                live = derive_one(obs('t1', 'epub_inspect', 'error', live_record(text, stage), backend='live'))
                replay = derive_one(obs('t1', 'epub_inspect', 'error', {'bytes': 9, 'error': text, 'stage': stage, 'status': 'error'}))
                self.assertEqual(self.verdict(live), ('unknown', False), (text, stage))
                self.assertEqual(self.verdict(live), self.verdict(replay), (text, stage))
                self.assertEqual(live.package[stage], 'unknown')

    def test_recognised_damage_reads_damaged_on_both_paths(self):
        for text, stage in (('BadZipFile: File is not a zip file', 'zip_open'), ("BadZipFile: Bad CRC-32 for file 'a.xhtml' in member a.xhtml", 'zip_crc'),
                            ('package document: ParseError: mismatched tag: line 3, column 5', 'opf_parse'), ("manifest names 1 member(s) that are not in the archive: ['b.xhtml']", 'manifest')):
            live = derive_one(obs('t1', 'epub_inspect', 'error', live_record(text, stage), backend='live'))
            replay = derive_one(obs('t1', 'epub_inspect', 'error', {'bytes': 9, 'error': text, 'stage': stage, 'status': 'error'}))
            self.assertEqual((self.verdict(live), self.verdict(replay)), (('damaged', True), ('damaged', True)), text)

    def test_other_live_collectors_make_no_defect_from_the_cause_alone(self):
        for tool, kind in (('ffprobe', 'probe'), ('decode_sample', 'decode'), ('audio_sample', 'audio')):
            rec = {'status': 'error', 'cause': 'input', 'reason': 'the input could not be read', 'tool': kind, 'coverage': {'verified': [], 'not_verified': ['everything']}, 'output': {}}
            d = derive_one(obs('t1', tool, 'error', rec, backend='live'))
            self.assertEqual((d.integrity, any(f['known_defect'] for f in d.findings), d.execution['cause']), ('unknown', False, 'input'), tool)
            rec2 = dict(rec, stderr='[mov,mp4 @ 0x0] moov atom not found')
            d2 = derive_one(obs('t1', tool, 'error', rec2, backend='live'))
            if tool == 'ffprobe':
                self.assertEqual(d2.integrity, 'damaged')

    def test_a_live_unclassified_cause_input_error_does_not_support_a_write_under_guards_v3(self):
        rec = live_record('RuntimeError: ZIP file is closed', 'opf_parse')
        case = case_with(json.dumps(rec))
        self.assertTrue(DG.apply(case, write_decision(['e1']), [], case['evidence'], 'v4', version='v3')[1]['applied'])
        rec = live_record('container.xml names OEBPS/c.opf, which is not in the archive', 'opf_parse')           # control: recognised damage
        case = case_with(json.dumps(rec))
        self.assertFalse(DG.apply(case, write_decision(['e1']), [], case['evidence'], 'v4', version='v3')[1]['applied'])


CONTAINER = ('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>'
             '<rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>hello there reader</p></body></html>'


def opf(items='<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>', spine='<itemref idref="a"/>'):
    return ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>'
            '<manifest>%s</manifest><spine>%s</spine></package>' % (items, spine))


def members(has_mt=True, mt='application/epub+zip', has_c=True, container=CONTAINER, has_opf=True, opf_text=None, xhtml=XHTML, extra=()):
    out = []
    if has_mt:
        out.append(('mimetype', mt))
    if has_c:
        out.append(('META-INF/container.xml', container))
    if has_opf:
        out.append(('OEBPS/c.opf', opf_text if opf_text is not None else opf()))
    out.append(('OEBPS/a.xhtml', xhtml))
    return out + list(extra)


def write_epub(directory, name, mem):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for n, data in mem:
            z.writestr(zipfile.ZipInfo(n) if n == 'mimetype' else n, data, zipfile.ZIP_STORED if n == 'mimetype' else zipfile.ZIP_DEFLATED)
    path = os.path.join(directory, name + '.epub')
    Path(path).write_bytes(buf.getvalue())
    return path


EMPTY_ROOTFILES = '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles/></container>'
BROKEN = {
    'no_container_xml': members(has_c=False),
    'container_names_a_missing_opf': members(has_opf=False),
    'container_without_rootfile': members(container=EMPTY_ROOTFILES),
    'spine_idref_not_in_manifest': members(opf_text=opf(spine='<itemref idref="zzz"/>')),
    'mimetype_wrong': members(mt='application/zip'),
    'mimetype_missing': members(has_mt=False),
    'spine_document_without_text': members(xhtml='<html xmlns="http://www.w3.org/1999/xhtml"><body></body></html>'),
    'empty_spine': members(opf_text=opf(spine='')),
    'opf_malformed': members(opf_text='<package><manifest>'),
    'manifest_names_a_missing_member': members(opf_text=opf(items='<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>')),
    'spine_document_malformed': members(xhtml='<html><body><p>x</body></html>'),
}


class RealBrokenEpubsOnBothPaths(unittest.TestCase):
    """Opus P1 / Astra 3: every real broken EPUB reads damaged on the replay inspector and on the live collector; healthy ones (a 9 MiB one included) do not."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = cls.tmp.name

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def replay(self, path, behavior='v2'):
        ctx = type('C', (), {'tools_behavior': behavior, 'fixture': type('F', (), {'kind': 'local', 'path': path})()})()
        r = T.tool_epub_inspect({}, ctx)
        out = r.output if isinstance(r.output, str) else json.dumps(r.output)
        return r, EV2.derive(EV2.make_observation('e1', 'epub_inspect', {}, r.status, out, None, 'case'))

    def live(self, path):
        scratch = tempfile.mkdtemp(dir=self.dir)
        rec = E.collect(path, kinds=['epub'], scratch_dir=scratch)[0]
        return rec, EV2.derive(EV2.make_observation('t1', 'epub_inspect', {}, rec['status'], json.dumps(rec), 'live', 'tool'))

    def test_every_broken_package_reads_damaged_on_the_replay_and_the_live_path(self):
        for name, mem in BROKEN.items():
            path = write_epub(self.dir, name, mem)
            _r, dr = self.replay(path)
            _l, dl = self.live(path)
            self.assertEqual((dr.integrity, any(f['known_defect'] for f in dr.findings)), ('damaged', True), ('replay', name, [f['detail'] for f in dr.findings]))
            self.assertEqual((dl.integrity, any(f['known_defect'] for f in dl.findings) or bool(dl.veto)), ('damaged', True), ('live', name))

    def test_a_healthy_package_is_clean_on_both_paths(self):
        path = write_epub(self.dir, 'healthy', members())
        self.assertEqual(self.replay(path)[1].integrity, 'clean')
        self.assertEqual(self.live(path)[1].integrity, 'clean')

    def test_a_healthy_9_mib_package_is_never_damage(self):
        path = write_epub(self.dir, 'big', members(extra=[('OEBPS/blob.bin', os.urandom(9 * 1024 * 1024))]))
        self.assertGreater(os.path.getsize(path), 8 * 1024 * 1024)
        r, dr = self.replay(path)
        self.assertEqual(r.output['error'].startswith('AssertionError: harness size cap exceeded'), True)
        self.assertEqual((dr.integrity, any(f['known_defect'] for f in dr.findings), dr.execution['cause']), ('unknown', False, 'tool'))
        _l, dl = self.live(path)
        self.assertFalse(any(f['known_defect'] for f in dl.findings))
        self.assertNotEqual(dl.integrity, 'damaged')

    def test_the_wording_is_versioned_legacy_tools_behaviour_is_byte_identical(self):
        path = write_epub(self.dir, 'legacy', BROKEN['empty_spine'])
        self.assertEqual(self.replay(path, 'v1')[0].output['error'], 'AssertionError: ')
        self.assertEqual(self.replay(path, 'v2')[0].output['error'], 'AssertionError: the spine is empty')

    def test_arbitrary_key_errors_and_stages_are_not_damage(self):
        for stage, err in (('opf_parse', "KeyError: 'href'"), ('manifest', "KeyError: 'zzz'"), ('zip_open', "KeyError: 'x'"), ('spine', 'KeyError: 3'), ('spine', 'AssertionError: '),
                           ('spine', 'AssertionError: an unrecognised check of the inspector failed'), ('opf_parse', "KeyError: \"There is no item named 'x'\"")):
            self.assertIsNone(EV2.epub_failure(stage, err), (stage, err))
        self.assertEqual(EV2.epub_failure('spine', "KeyError: 'zzz'"), 'damage')                                              # controls
        self.assertEqual(EV2.epub_failure('opf_parse', "KeyError: \"There is no item named 'META-INF/container.xml' in the archive\""), 'damage')
        self.assertEqual(EV2.epub_failure('opf_parse', 'StopIteration: '), 'damage')


ERROR_RECORD = {'exit_code': 1, 'stderr': '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found\nmedia/The Lantern Road.m4b: Invalid data found when processing input'}


class RecordedErrorsOfTheOtherToolsKeepTheirDamage(unittest.TestCase):
    """Opus P2: audio_sample, frame_sample and audiobook_inspect errors with recognised damage on stderr are typed defects (and so keep their support)."""

    def test_recognised_stderr_is_a_known_defect_for_each_tool(self):
        for tool, kind, integrity in (('audio_sample', 'audio_decode_errors', 'damaged'), ('audiobook_inspect', 'container_damage', 'damaged'), ('frame_sample', 'tool_error_damage', 'not_integrity')):
            d = derive_one(obs('e1', tool, 'error', dict(ERROR_RECORD, note='no output produced')))
            self.assertEqual(([(f['kind'], f['known_defect']) for f in d.findings], d.integrity), ([(kind, True)], integrity), tool)

    def test_execution_and_unclassified_stderr_make_no_defect(self):
        for stderr in ('media/x.m4b: Permission denied', 'something nobody has classified'):
            for tool in ('audio_sample', 'audiobook_inspect', 'frame_sample'):
                d = derive_one(obs('e1', tool, 'error', {'exit_code': 1, 'stderr': stderr}))
                self.assertFalse(any(f['known_defect'] for f in d.findings), (tool, stderr))
                self.assertNotEqual(d.integrity, 'damaged')

    def test_a_write_citing_such_a_result_is_accepted_under_guards_v3_and_a_permission_error_is_not(self):
        for tool in ('audio_sample', 'frame_sample', 'audiobook_inspect'):
            case = case_with(json.dumps(ERROR_RECORD), tool=tool)
            self.assertFalse(DG.apply(case, write_decision(['e1']), [], case['evidence'], 'v4', version='v3')[1]['applied'], tool)
            bad = case_with(json.dumps({'exit_code': 1, 'stderr': 'media/x.m4b: Permission denied'}), tool=tool)
            self.assertTrue(DG.apply(bad, write_decision(['e1']), [], bad['evidence'], 'v4', version='v3')[1]['applied'], tool)

    CALLS = {'arr_lookup': [{}], 'ffprobe': [{}], 'epub_inspect': [{}], 'audiobook_inspect': [{}], 'decode_sample': [{}, {'at': 60}, {'full': True}], 'frame_sample': [{'at': 30}],
             'ocr': [{'at': 30}], 'audio_sample': [{}, {'at': 45}]}

    @th.needs_suite
    def test_across_every_public_error_result_a_lost_support_is_an_execution_failure_or_unclassified(self):
        counts = {'error_results': 0, 'shape_support': 0, 'typed_support': 0, 'lost': 0, 'gained': 0, 'lost_with_damage': 0}
        for name in ('suite', 'suite-dev-v1.1'):
            suite = Path(th.SUITE).parent / name
            for case, _s in R.load_cases(suite):
                fx = T.Fixture.from_case(case, suite)
                ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=suite, which=th.NO_BINARIES, tools_behavior='v2', keep_raw=True)
                observations = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in R.resolve_evidence_raw(case, suite, ctx.redact)]
                k = 0
                for tool in case.get('tools_available', []):
                    for args in self.CALLS.get(tool, [{}]):
                        k += 1
                        res = T.call_tool(ctx, tool, args)
                        observations.append(EV2.make_observation('t%d' % k, tool, R.safe_args(args), res['status'], res.get('raw_output', res['output']), res.get('mode')))
                typed = AU.typed_error_support(observations)
                for o in observations:
                    if o['status'] != 'error':
                        continue
                    shape = AU.usable_as_support('error', o['output'])
                    counts['error_results'] += 1
                    counts['shape_support'] += shape
                    counts['typed_support'] += typed[o['id']]
                    if shape and not typed[o['id']]:
                        counts['lost'] += 1
                        data = json.loads(o['output']) if isinstance(o['output'], str) and o['output'].lstrip()[:1] == '{' else {}
                        texts = [str(data.get(k2)) for k2 in ('stderr', 'error') if data.get(k2)]
                        if texts and EV2.damage_wording(texts):
                            counts['lost_with_damage'] += 1
                    if typed[o['id']] and not shape:
                        counts['gained'] += 1
        self.assertEqual(counts['lost_with_damage'], 0, counts)
        self.assertEqual(counts['gained'], 0, counts)
        self.assertGreater(counts['error_results'], 80, counts)
        print('\nsupport comparison over the public suites:', counts)


if __name__ == '__main__':
    unittest.main()
