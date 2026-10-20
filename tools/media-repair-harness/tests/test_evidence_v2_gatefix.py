"""Gate fix (OpenProject #148) on the final delta of #1023: guards v3 / audit v2 take 'supports' from the typed execution state and positive damage findings, the EPUB
execution-versus-damage rules reach the real collector paths (live cause downgrade, the ' in member <name>' suffix, real stage names), pages_of is always a list and the
zlib -3 pattern rejects a file-name tail.  Every test pairs a bad case with a control."""
import json
import unittest

import ev2h
import legacy_e2e as L
import th
from ev2h import derive_one, obs, tc, dec
from media_repair_harness import audit as AU
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import run as R
from test_evidence_v2_core import live_epub

TARGET = 'Harbor Lights - S01E02 - Lamp Oil.mkv'
PAD = '\n'.join('Unknown-sized element at 0x%x inside parent with finite size' % (i * 17) for i in range(400))


def write_decision(refs):
    d = dec('corrupt_file', 'blocklist_and_search', refs, target=TARGET)
    d['audit'] = {'target': TARGET, 'preconditions': ['the evidence shows damage'], 'readback': 'queue', 'verify': 'new file'}
    return d


def epub_error(error, stage='zip_read'):
    return json.dumps({'bytes': 9, 'error': error, 'stage': stage, 'status': 'error'})


def case_with(output, status='error', tool='epub_inspect'):
    case = L.tv_case('qxg-001', evidence=[], tools_available=[tool], context={'title': 'Harbor Lights S01E02', 'filename': TARGET, 'expected': {'series': 'Harbor Lights'},
                                                                                       'arr': {'app': 'sonarr', 'ids': {'seriesId': 1}}, 'notes_for_model': 'n' * 3000})
    case['evidence'] = [{'id': 'e1', 'tool': tool, 'args': {}, 'status': status, 'output': output}]
    return case


class TypedSupportForAnErrorResult(unittest.TestCase):
    """Astra 9, finding 1: an `error` result with a `stage` or `exit_code` key is not support by shape; only a typed positive damage finding is."""

    def check(self, output, version, refs=('e1',), tool='epub_inspect'):
        case = case_with(output, tool=tool)
        final, rec = DG.apply(case, write_decision(list(refs)), [], case['evidence'], 'v4', version=version)
        return rec['applied'][0]['reason'] if rec['applied'] else None

    def test_a_permission_failure_at_a_stage_does_not_support_a_write_under_guards_v3_only(self):
        out = epub_error('PermissionError: [Errno 13] Permission denied')
        self.assertIn('cited_evidence_supports', self.check(out, 'v3') or '')
        legacy = AU.compute(case_with(out), write_decision(['e1']), [], prompt_version='v4', v4_tables=True)
        self.assertTrue({c['id']: c['met'] for c in legacy['preconditions']}['cited_evidence_supports'])
        self.assertIsNone(self.check(out, 'v2'))
        self.assertIsNone(self.check(out, 'v1'))

    def test_a_positive_damage_finding_in_an_error_result_still_supports_and_so_does_an_exit_code_with_damage(self):
        for out, tool in ((epub_error('BadZipFile: File is not a zip file', 'zip_open'), 'epub_inspect'),
                          (json.dumps({'exit_code': 1, 'stderr': '[mov,mp4 @ 0x0] moov atom not found'}), 'ffprobe')):
            self.assertIsNone(self.check(out, 'v3', tool=tool), out)

    def test_an_unclassified_error_with_an_exit_code_or_a_stage_is_not_support_in_v3(self):
        for out, tool in ((json.dumps({'exit_code': 1, 'stderr': 'unrecognised complaint'}), 'ffprobe'), (epub_error('weird', 'zip_crc'), 'epub_inspect')):
            self.assertIn('cited_evidence_supports', self.check(out, 'v3', tool=tool) or '', out)
            self.assertIsNone(self.check(out, 'v2', tool=tool), out)

    def test_audit_v2_in_the_record_uses_the_same_support(self):
        out = epub_error('PermissionError: [Errno 13] Permission denied')
        case = case_with(out)
        v2 = AU.compute(case, write_decision(['e1']), [], prompt_version='v4', v4_tables=True, audit_version='v2', shown=case['evidence'])
        self.assertFalse({c['id']: c['met'] for c in v2['preconditions']}['cited_evidence_supports'])
        ok = case_with(epub_error('BadZipFile: File is not a zip file', 'zip_open'))
        good = AU.compute(ok, write_decision(['e1']), [], prompt_version='v4', v4_tables=True, audit_version='v2', shown=ok['evidence'])
        self.assertTrue({c['id']: c['met'] for c in good['preconditions']}['cited_evidence_supports'])

    def run_paged(self, error, guards='v3', stage='zip_read'):
        case = case_with(epub_error(error + '\n' + PAD, stage))
        ts = L.suite_with(case)
        _rec, ad = ev2h.scripted_run(case, ts, [dec()], which=th.NO_BINARIES, evidence_format='v2')
        cursor = json.loads(ad.calls[0][0]['content'])['evidence']['page']['next']
        extra = {'guards': guards} if guards else {}
        rec, _ad = ev2h.scripted_run(case, ts, [tc('epub_inspect', {'cursor': cursor}), write_decision(['t1'])], which=th.NO_BINARIES, evidence_format='v2', **extra)
        shown = R.resolve_evidence_raw(case, ts.root)
        ts.cleanup()
        return case, rec, shown

    def test_citing_the_page_of_a_padded_permission_failure_is_escalated_online_and_offline(self):
        _case, rec, _shown = self.run_paged('PermissionError: [Errno 13] Permission denied')
        self.assertEqual(rec['tool_calls'][0]['pages_of'], ['e1'])
        self.assertEqual(rec['decision']['action'], 'escalate')
        self.assertEqual(rec['guard']['applied'][0]['rule'], 'G-write')
        case, plain, shown = self.run_paged('PermissionError: [Errno 13] Permission denied', guards=None)
        self.assertEqual(plain['decision']['action'], 'blocklist_and_search')
        pre = {c['id']: c['met'] for c in plain['action_audit']['preconditions']}
        self.assertFalse(pre['cited_evidence_supports'])
        off = DG.apply_to_record(plain, case, shown, 'v3')
        self.assertEqual((off['decision']['action'], off['guard']['final_changed']), ('escalate', True))

    def test_the_page_of_a_padded_error_that_reports_real_damage_is_still_accepted(self):
        _case, rec, _shown = self.run_paged('BadZipFile: File is not a zip file', stage='zip_open')
        self.assertEqual(rec['decision']['action'], 'blocklist_and_search')
        self.assertFalse(rec['guard']['final_changed'])


class EpubReplayPathsWithTheMemberSuffix(unittest.TestCase):
    """Opus 2(b): the collector appends ' in member <name>'; real stage names, replay path."""

    def derive(self, error, stage='zip_crc'):
        return derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 9, 'entries': 7, 'error': error, 'stage': stage, 'status': 'error'}))

    def test_execution_failures_at_a_real_stage_with_the_suffix_are_not_damage(self):
        for err in ('error: Error -4 while decompressing data: insufficient memory in member OEBPS/ch1.xhtml', 'PermissionError: [Errno 13] Permission denied in member OEBPS/ch 1.xhtml',
                    'OSError: [Errno 5] Input/output error in member OEBPS/ch1.xhtml', 'MemoryError:  in member OEBPS/ch1.xhtml'):
            d = self.derive(err)
            self.assertEqual(d.execution['cause'], 'tool', err)
            self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings], d.package['zip_crc']), ('unknown', [False], 'unknown'), err)

    def test_unclassified_text_at_a_real_stage_is_not_turned_into_damage(self):
        for err in ('error: Error -2 while decompressing data: inconsistent stream state in member OEBPS/ch1.xhtml', 'something nobody has classified in member x'):
            d = self.derive(err)
            self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings], d.package['zip_crc']), ('unknown', [False], 'unknown'), err)

    def test_real_damage_with_the_suffix_stays_damage_whatever_the_name(self):
        for err in ('error: Error -5 while decompressing data: incomplete or truncated stream in member OEBPS/ch1.xhtml', "BadZipFile: Bad CRC-32 for file 'OEBPS/ch1.xhtml' in member OEBPS/ch1.xhtml",
                    'error: Error -3 while decompressing data: invalid block type in member a b.xhtml', 'CRC mismatch in member OEBPS/c2.xhtml'):
            d = self.derive(err)
            self.assertEqual((d.integrity, d.package['zip_crc'], [f['known_defect'] for f in d.findings]), ('damaged', 'damaged', [True]), err)

    def test_the_collector_prefixes_of_its_own_stage_messages_are_read(self):
        d = self.derive('container.xml: ParseError: mismatched tag: line 3, column 5', 'opf_parse')
        self.assertEqual((d.integrity, d.package['opf_parse']), ('damaged', 'damaged'))
        d = self.derive('package document: ParseError: not well-formed (invalid token): line 2, column 336', 'opf_parse')
        self.assertEqual(d.integrity, 'damaged')


class EpubLivePathCauseDowngrade(unittest.TestCase):
    """Opus 2(a): the live collector calls every non-OSError `input`; an execution-failure text downgrades it."""

    def live(self, error, stage='zip_crc', cause='input'):
        return derive_one(obs('t1', 'epub_inspect', 'error', live_epub(valid=False, status='error', cause=cause, stage=stage, error=error, passed=('zip_open',)), backend='live'))

    def test_zlib_memory_and_memoryerror_are_execution_failures_not_a_damaged_book(self):
        for err in ('error: Error -4 while decompressing data: insufficient memory in member OEBPS/ch1.xhtml', 'MemoryError:  in member OEBPS/ch1.xhtml'):
            d = self.live(err)
            self.assertEqual(d.execution['cause'], 'tool', err)
            self.assertEqual((d.integrity, any(f['known_defect'] for f in d.findings), d.package['zip_crc']), ('unknown', False, 'unknown'), err)

    def test_input_causes_with_damage_or_unclassified_text_are_left_as_the_collector_said(self):
        for err in ("BadZipFile: Bad CRC-32 for file 'OEBPS/ch1.xhtml' in member OEBPS/ch1.xhtml", 'error: Error -5 while decompressing data: incomplete or truncated stream in member x'):
            d = self.live(err)
            self.assertEqual((d.execution['cause'], d.integrity), ('input', 'damaged'), err)
        d = self.live('error: Error -2 while decompressing data: inconsistent stream state in member x')
        self.assertEqual(d.execution['cause'], 'input')                                   # (the collector's own verdict; only an execution failure is downgraded)

    def test_the_collectors_own_output_format_is_unchanged(self):
        rec = live_epub(valid=False, status='error', cause='input', stage='zip_crc', error='MemoryError:  in member x', passed=('zip_open',))
        derive_one(obs('t1', 'epub_inspect', 'error', rec, backend='live'))
        self.assertEqual(rec['cause'], 'input')


class SmallItems(unittest.TestCase):
    def test_the_zlib_data_error_pattern_rejects_a_file_name_tail_with_a_permission_error(self):
        for text in ('Error -3 while decompressing data: book.epub: Permission denied', 'Error -3 while decompressing data: Permission denied', 'error: Error -3 while decompressing data: x.mkv: Permission denied'):
            self.assertNotEqual(EV2.classify_line(text), 'damage', text)
        for text in ('Error -3 while decompressing data: invalid block type', 'Error -3 while decompressing data: invalid distance too far back', 'Error -3 while decompressing data',
                     'error: Error -3 while decompressing data: incorrect header check', 'Error -3 while decompressing data: invalid literal/lengths set'):
            self.assertEqual(EV2.classify_line(text), 'damage', text)

    def test_pages_of_is_always_a_list(self):
        import legacy_e2e as L2
        import hashlib
        big = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(160)]
        case = L2.tv_case('run-004', evidence=[], tools_available=['ffprobe', 'decode_sample'])
        ts = L2.suite_with(case, probes=False)
        rec_file = dict(L2.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=dict(L2.PROBE_REC, chapters=big))
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        _rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], which=th.NO_BINARIES, evidence_format='v2')
        cursor = json.loads(ad.calls[-1][-1]['content'])['output']['page']['next']
        rec, _ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('ffprobe', {'cursor': cursor}), dec()], which=th.NO_BINARIES, evidence_format='v2')
        self.assertEqual(rec['tool_calls'][1]['pages_of'], ['t1'])
        self.assertEqual(EV2.page_origin_map(rec['tool_calls']), {'t2': ['t1']})
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
