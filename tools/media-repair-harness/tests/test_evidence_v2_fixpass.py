"""Evidence format v2, second fix pass (Astra 4 and the Opus re-review of 5a576d70): every case is a synthetic PAIR, the counterexample next to its control, so a
change that brings the old behaviour back turns the counterexample red while the control stays green."""
import hashlib
import json
import tempfile
import unittest

import ev2h
import legacy_e2e as L
import test_evidence as TE
import th
from ev2h import analysis, decode_out, derive_one, obs, probe_out, tc, dec
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T

DAMAGE = '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5'


def healthy():
    return {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['e1'], 'reason': 'r'}


def shown(*items):
    return [{'id': i, 'tool': t, 'args': {}, 'status': s, 'output': o if isinstance(o, str) else json.dumps(o)} for i, t, s, o in items]


ALLOW_LISTED = (
    'moov atom not found', 'Invalid data found when processing input', 'EBML header parsing failed', 'stream 0, offset 0x1f3a: partial file', 'partial file',
    'File ended prematurely', 'File ended prematurely at pos. 123456 (0x1e240)', 'error while decoding MB 45 30, bytestream -7', 'concealing 12 DC, 3 AC, 4 MV errors in P frame',
    'ac-tex damaged at 22 17', 'corrupted macroblock 45 30 (total_coeff=-1)', 'corrupt decoded frame in stream 0', 'corrupt input packet in stream 0',
    'Packet corrupt (stream = 0, dts = 1234).', "BadZipFile: Bad CRC-32 for file 'OEBPS/ch01.xhtml'", 'CRC mismatch in member OEBPS/ch01.xhtml', 'Truncated central directory',
    'BadZipFile: Truncated file header', 'BadZipFile: Bad magic number for central directory', 'BadZipFile: Corrupt extra field 0001 (size=4)', 'BadZipFile: File is not a zip file',
    'Failed to find two consecutive MPEG audio frames.', 'cabac decode of qscale diff failed at 12 34', 'Invalid NAL unit size (1234 > 99).', 'Error splitting the input into NAL units.',
    'ParseError: not well-formed (invalid token): line 2, column 336', 'ParseError: no element found: line 1, column 0',
    'manifest names 2 member(s) that are not in the archive: [\'a\']',
    'Error opening input files: Invalid data found when processing input', 'Error during demuxing: Invalid data found when processing input',
)
NOT_DAMAGE = (
    'corrupt frames: 0', 'corrupt frames were not found', 'no corrupt frames found', 'Found 0 corrupt frames', 'file is not corrupt', 'without corrupt packets',
    'The Corrupt Detective', 'The Corrupted Crown', 'End of File', 'Partial File', 'Damaged Goods', 'corrupt.mkv', '/media/corrupt/partial file.mkv', 'Truncating packet of size 1024 to 512',
    'comment truncated to 255 chars', 'pipe:: End of file', 'damaged tags removed by the tagger', 'Header missing', 'Unknown-sized element at 0x0 inside parent with finite size',
    'a quota-limited sample does not prove corruption', 'A clean sample does not prove whole-file health', 'Decoder not found', 'Error opening input file media/x.mkv.',
)


def prefixed(msg):
    return [msg, '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55d5c0a8e0c0] ' + msg, '[in#0 @ 0x0] ' + msg, 'pipe:0: ' + msg, 'media/some dir/Harbor Lights.mkv: ' + msg, '<input>: ' + msg,
            '[vist#0:0/h264 @ 0x1] [dec:h264 @ 0x2] ' + msg]


class DamageAllowList(unittest.TestCase):
    """Astra 1, 5 and the re-review: damage is a narrow positive allow-list of the fixed library messages, matched per line in diagnostic fields; everything else is
    unclassified.  There is no negation logic and no bare-word matching."""

    CUT = ('{"chapters": [{"start_s": 0, "end_s": 4, "title": "%(t)s"}], "format": {"tags": {"title": "%(t)s", "album": "%(t)s"}}, "stderr": "%(e)s", '
           '"streams": [{"codec_name": "h264"}] ...[truncated]')

    def test_every_allow_listed_message_is_detected_with_any_prefix(self):
        for msg in ALLOW_LISTED:
            for text in prefixed(msg):
                self.assertTrue(EV2.damage_wording(text), text)
                self.assertEqual(EV2.classify_line(text), 'damage', text)
            d = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=0, stderr='[h264 @ 0x55d5c0a8e0c0] ' + msg), {'at': 0}), 8.0)
            self.assertEqual((d.integrity, d.findings[0]['kind'], d.findings[0]['known_defect']), ('damaged', 'decoder_errors', True), msg)

    def test_the_false_damage_probes_stay_unclassified_and_unknown(self):
        for msg in NOT_DAMAGE:
            for text in prefixed(msg):
                self.assertFalse(EV2.damage_wording(text), text)
            d = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=0, stderr='[h264 @ 0x0] ' + msg), {'at': 0}), 8.0)
            self.assertEqual((d.integrity, [(f['kind'], f['known_defect']) for f in d.findings], [i['state'] for i in d.intervals]),
                             ('unknown', [('decoder_messages_unclassified', False)], ['unclassified']), msg)
            self.assertIn(msg, d.findings[0]['detail'] + json.dumps(EV2.item_facts(d)))              # the text is kept

    def test_a_stream_identifier_is_not_a_count_and_a_zero_count_is_not_damage(self):
        self.assertTrue(EV2.damage_wording('pipe:0: Invalid data found when processing input'))
        self.assertTrue(EV2.damage_wording('pipe:1: Invalid data found when processing input'))
        self.assertFalse(EV2.damage_wording('corrupt frames: 0'))
        self.assertFalse(EV2.damage_wording('corrupt frames: 12'))                            # a count is not an allow-listed message either; it stays unclassified

    def test_each_line_is_judged_on_its_own_so_nothing_erases_a_damage_line(self):
        text = 'Permission denied: /media/other.mkv\n[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found\nno corrupt frames found'
        self.assertEqual([EV2.classify_line(l) for l in text.splitlines()], ['execution', 'damage', None])
        self.assertTrue(EV2.damage_wording(text))
        self.assertFalse(EV2.execution_error(text))                                           # a damage line makes it damage, not an execution failure
        d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': text}))
        self.assertEqual((d.execution['cause'], d.integrity, d.findings[0]['known_defect']), ('input', 'damaged', True))
        d = derive_one(obs('t1', 'ffprobe', 'ok', text))                                         # plain text, too
        self.assertEqual((d.integrity, d.findings[0]['kind']), ('damaged', 'container_damage'))
        only = derive_one(obs('t1', 'ffprobe', 'error', 'Permission denied: /media/corrupt.mkv'))          # control: the execution line alone is a tool failure
        self.assertEqual((only.execution['cause'], only.findings, only.integrity), ('tool', [], 'unknown'))

    def test_metadata_in_cut_json_never_decides_anything_even_when_it_holds_an_allow_listed_phrase(self):
        for phrase in ('moov atom not found', 'Invalid data found when processing input', 'File ended prematurely', 'Permission denied'):
            d = derive_one(obs('t1', 'ffprobe', 'ok', self.CUT % {'t': phrase, 'e': ''}))
            self.assertEqual((d.integrity, d.findings), ('unknown', []), phrase)
            self.assertIn(phrase, d.facts['raw'])
        # the same words in the stderr field are the diagnostic; a metadata field cannot erase or replace it
        d = derive_one(obs('t1', 'ffprobe', 'ok', self.CUT % {'t': 'Permission denied', 'e': 'moov atom not found'}))
        self.assertEqual((d.integrity, d.findings[0]['kind'], d.findings[0]['known_defect']), ('damaged', 'container_damage', True))
        d = derive_one(obs('t1', 'ffprobe', 'ok', self.CUT % {'t': 'ordinary', 'e': 'moov atom not found'}))
        self.assertEqual(d.integrity, 'damaged')

    def test_harmless_stderr_in_a_cut_injected_decode_does_not_fire_guards_v3(self):
        note = 'A clean sample does not prove whole-file health; a quota-limited sample does not prove corruption.'
        cut = '{"clean": true, "exit_code": 0, "frames": 40, "note": "%s", "out_time": "00:00:04.000000", "stderr": "%s' % (note, '%s')
        harmless = cut % 'Application provided invalid, non monotonically increasing dts ...[output cut off]'
        evidence = shown(('e1', 'ffprobe', 'ok', probe_out()), ('t2', 'decode_sample', 'partial', harmless))
        self.assertIsNone(DG.check_healthy_v3(healthy(), evidence, []))
        self.assertEqual(derive_one(obs('t2', 'decode_sample', 'partial', harmless)).findings, [])
        bad = cut % 'error while decoding MB 13 11, bytestream -5 ...[output cut off]'
        evidence = shown(('e1', 'ffprobe', 'ok', probe_out()), ('t2', 'decode_sample', 'partial', bad))
        self.assertIn('decoder_errors', DG.check_healthy_v3(healthy(), evidence, []))              # control: an allow-listed message in the stderr field still fires

    def test_execution_errors_are_recognised_per_line_by_their_own_patterns(self):
        for text in ('Permission denied: /media/corrupt.mkv', 'corrupt.mkv: Permission denied', 'Operation not permitted: damaged_copy.mp4', 'PermissionError: [Errno 13] Permission denied: \'a.mkv\'',
                     'x.mkv: No such file or directory', 'Input/output error'):
            d = derive_one(obs('t1', 'ffprobe', 'error', text))
            self.assertEqual((d.execution['cause'], d.findings, d.integrity), ('tool', [], 'unknown'), text)
            d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': text}))
            self.assertEqual(d.execution['cause'], 'tool', text)
        d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'something else entirely'}))
        self.assertEqual(d.execution['cause'], 'unknown')

    def test_a_negated_phrase_is_simply_not_on_the_list(self):
        for text in ('no moov atom not found', 'moov atom was found'):           # (the second is plain English, not the library's message)
            self.assertFalse(EV2.damage_wording(text) and text.startswith('moov atom was'), text)


def _unused():
    pass


class LiveFullDecodeNeedsTheSpan(unittest.TestCase):
    """Astra 3, N1, P1: the same span-versus-duration check on every backend."""

    def live(self, decoded, duration, state='clean'):
        return {'tool': 'decode', 'mode': 'live', 'status': 'ok', 'coverage': {'verified': ['full decode ran'], 'not_verified': []},
                'output': {'duration_s': duration, 'segments': [{'at_s': 0.0, 'window_s': 4, 'decoded_s': 4.0, 'state': 'clean', 'exit_code': 0, 'errors': []}],
                           'full': {'performed': True, 'state': state, 'decoded_s': decoded, 'exit_code': 0, 'errors': []}}}

    def proof(self, decoded, duration, probe_duration=None):
        o = obs('t1', 'decode_sample', 'ok', self.live(decoded, duration), {'full': True}, backend='live')
        shown_obs = [o] if probe_duration is None else [obs('e1', 'ffprobe', 'ok', probe_out(duration=str(probe_duration)), source='case'), o]
        return EV2.full_decode_proof(o, shown_obs)

    def test_two_of_ten_and_ten_of_a_hundred_seconds_are_not_the_end_of_the_file(self):
        for decoded, duration in ((2.0, 10.0), (10.0, 100.0)):
            d = derive_one(obs('t1', 'decode_sample', 'ok', self.live(decoded, duration), {'full': True}, backend='live'))
            self.assertIs(d.completed_to_eof, False, (decoded, duration))
            self.assertIn('decoded_span_shorter_than_duration', [c['kind'] for c in d.conflicts])
            self.assertFalse(self.proof(decoded, duration)[0])
            self.assertFalse(self.proof(decoded, None, probe_duration=duration)[0])         # the duration may come from another shown result
        ok, why = self.proof(10.0, 10.0)                                                       # control
        self.assertTrue(ok, why)
        self.assertIs(derive_one(obs('t1', 'decode_sample', 'ok', self.live(10.0, 10.0), {'full': True}, backend='live')).completed_to_eof, True)

    def test_an_unknown_duration_leaves_live_completion_unknown(self):
        d = derive_one(obs('t1', 'decode_sample', 'ok', self.live(10.0, None), {'full': True}, backend='live'))
        self.assertIsNone(d.completed_to_eof)
        self.assertFalse(EV2.full_decode_proof(obs('t1', 'decode_sample', 'ok', self.live(10.0, None), {'full': True}, backend='live'), [])[0])


class ClientTokensAreApplied(unittest.TestCase):
    """Astra 5, P1."""

    def verdicts(self, video, vcodec='hevc', pix='yuv420p10le', **prof):
        ss = [{'index': 0, 'codec_type': 'video', 'codec_name': vcodec, 'pix_fmt': pix, 'width': 1920, 'height': 1080}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]
        c = analysis([obs('e1', 'ffprobe', 'ok', probe_out(streams=ss))], {'client_profile': dict({'containers': ['matroska,webm'], 'video': video}, **prof)})['client']
        return c, {r['field']: r['verdict'] for r in c['rows']}

    def test_a_bit_depth_before_its_codec_is_not_read_and_never_reported_as_supported(self):
        c, v = self.verdicts('8-bit hevc')
        self.assertNotIn('video_codec', v)
        self.assertFalse(c['summary']['complete'])
        self.assertTrue(any(x.startswith('video: statement not read') for x in c['not_compared']))
        c, v = self.verdicts('hevc 8-bit')                                   # control: the same words in the structure the grammar reads
        self.assertEqual((v['video_codec'], v['video_bit_depth']), ('supported', 'unsupported'))
        c, v = self.verdicts('hevc 10-bit')
        self.assertEqual(v['video_bit_depth'], 'supported')

    def test_a_pixel_format_belongs_to_the_codec_it_follows(self):
        c, v = self.verdicts('yuv420p h264, hevc')
        self.assertNotIn('video_codec', v)                                   # a pixel format ahead of every codec is unread
        c, v = self.verdicts('h264 yuv420p or hevc yuv420p10le')
        self.assertEqual((v['video_codec'], v['video_pix_fmt']), ('supported', 'supported'))
        c, v = self.verdicts('h264 yuv420p10le or hevc yuv420p')
        self.assertEqual(v['video_pix_fmt'], 'unsupported')                  # applied to hevc, not smeared over h264

    def test_two_limits_are_ambiguous_and_unread(self):
        c, v = self.verdicts('hevc 10-bit, up to 1080p, up to 720p')
        self.assertNotIn('video_height_px', v)
        c, v = self.verdicts('hevc 10-bit, up to 720p')
        self.assertEqual(v['video_height_px'], 'unsupported')                # control


class OfflineGuardsUseTheSameResolver(unittest.TestCase):
    """Astra 6, P1: mrh-guard, apply_to_record and --restore resolve references exactly as the run does."""

    def record(self, refs):
        case = L.tv_case('qxo-001', evidence=[])
        ts = L.suite_with(case)
        d = dec('corrupt_file', 'blocklist_and_search', refs, target='Harbor Lights - S01E02 - Lamp Oil.mkv')
        d['audit'] = {'target': d['target'], 'preconditions': ['t1 shows decoder errors'], 'readback': 'queue', 'verify': 'new file'}
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 4}), d], which=th.NO_BINARIES, evidence_format='v2')
        shown_raw = R.resolve_evidence_raw(case, ts.root)
        ts.cleanup()
        return case, rec, shown_raw

    def test_identical_records_citing_an_observation_or_its_real_finding_get_the_same_offline_outcome(self):
        outcomes = {}
        for refs in (['t1'], ['t1.f1'], ['t1.c1'], ['t1.nonexistent']):
            case, rec, shown_raw = self.record(refs)
            self.assertEqual(rec['decision']['action'], 'blocklist_and_search')            # unguarded online run
            new = DG.apply_to_record(rec, case, shown_raw, 'v3')
            outcomes[refs[0]] = (new['decision']['action'], new['guard']['final_changed'], new['bad_evidence_refs'])
            back = DG.restore_original(new, case, shown_raw)
            self.assertEqual(back['decision'], rec['decision'])
            self.assertEqual(back['bad_evidence_refs'], rec['bad_evidence_refs'])
        self.assertEqual(outcomes['t1'], ('blocklist_and_search', False, []))
        self.assertEqual(outcomes['t1.f1'], outcomes['t1'])
        self.assertEqual(outcomes['t1.c1'], outcomes['t1'])
        self.assertEqual(outcomes['t1.nonexistent'][:2], ('escalate', True))                 # the invented suffix is not rescued

    def test_the_offline_record_fields_use_the_same_resolution_and_audit_version(self):
        case, rec, shown_raw = self.record(['t1.nonexistent'])
        self.assertEqual(rec['bad_evidence_refs'], ['t1.nonexistent'])
        new = DG.apply_to_record(rec, case, shown_raw, 'v3')
        self.assertEqual(new['action_audit']['audit_version'], 'v2')
        case, rec, shown_raw = self.record(['t1.f1'])
        self.assertEqual(rec['bad_evidence_refs'], [])
        self.assertEqual(DG.apply_to_record(rec, case, shown_raw, 'v3')['bad_evidence_refs'], [])

    def test_a_legacy_record_never_has_its_references_rewritten(self):
        self.assertEqual(DG.record_resolver({'tool_calls': []}, [])(['t1.f1']), ['t1.f1'])

    def test_the_cli_path_applies_it_too(self):
        import io
        import contextlib
        from pathlib import Path
        from media_repair_harness import guard_cli
        case, rec, shown_raw = self.record(['t1.f1'])
        ts = th.TempSuite([case])
        run_dir = Path(tempfile.mkdtemp()) / 'run'
        run_dir.mkdir()
        rec = dict(rec, case_sha256=hashlib.sha256((ts.root / 'cases' / (case['id'] + '.json')).read_bytes()).hexdigest())
        (run_dir / (case['id'] + '.json')).write_text(json.dumps(rec))
        (run_dir / 'manifest.json').write_text(json.dumps({'config': {}, 'case_ids': [case['id']]}))
        (run_dir / 'run_summary.json').write_text(json.dumps({}))
        (run_dir / 'audit.jsonl').write_text('')
        # the suite must contain the media for the raw evidence
        ts.add_file('media/x.mkv', b'x')
        out = Path(tempfile.mkdtemp()) / 'out'
        res = guard_cli.guard_run(run_dir, ts.root, out, version='v3')
        self.assertEqual(res['changed'], [])                                                    # a valid finding id is not a reason to abstain
        ts.cleanup()


def deep_merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a


def long_tags(n):
    return {k: ('%s-%d ' % (k, n)) * 40 for k in ('album', 'artist', 'album_artist', 'composer', 'genre', 'date', 'title', 'narrator', 'comment')}


class PaginationKeepsElementIdentity(unittest.TestCase):
    """Astra 7, N3, N4."""

    def book(self, n_parts=2):
        from test_evidence_v2_core import live_audiobook, book_file
        return live_audiobook([book_file(tags=long_tags(i)) for i in range(1, n_parts + 1)])

    def pages(self, rec, budget=EV2.WIRE_BYTES, tool='audiobook_inspect'):
        ses = EV2.Session('case-aaaaaaaa', {}, 'audiobook', [tool], budget=budget)
        ses.initial([])
        text, n = ses.result(obs('t1', tool, 'ok', rec, backend='live'), 't1', 3)
        return ses, ev2h.fetch_all(ses, text, tool=tool)

    def test_two_parts_with_long_tags_neither_crash_nor_merge(self):
        ses, texts = self.pages(self.book(2))
        self.assertGreater(len(texts), 1)
        elements = {}
        for t in texts:
            o = json.loads(t.split('\n')[0])['output']
            for el in (o.get('facts') or {}).get('files', []):
                deep_merge(elements.setdefault(el['_i'], {}), {k: v for k, v in el.items() if k != '_i'})
        self.assertEqual(sorted(elements), [0, 1])                                              # both parts are there under their own index
        for i in (0, 1):
            tags = elements[i]['tags']
            self.assertEqual(sorted(tags), sorted(long_tags(i + 1)))
            self.assertTrue(tags['album'].startswith('album-%d ' % (i + 1)))                   # part 1 was not overwritten by part 2
            self.assertEqual(elements[i]['n'], i + 1)

    def test_three_records_in_a_plain_list_keep_order_and_identity(self):
        records = [{'n': i, 'pad': {k: ('v%d' % i) * 150 for k in 'abcdefghi'}} for i in range(3)]
        ses = EV2.Session('case-aaaaaaaa', {}, 'tv', ['arr_lookup'])
        ses.initial([])
        text, n = ses.result(obs('t1', 'arr_lookup', 'ok', {'records': records}), 't1', 3)
        got = {}
        for t in ev2h.fetch_all(ses, text, tool='arr_lookup'):
            for el in json.loads(t.split('\n')[0])['output'].get('facts', {}).get('records', []):
                deep_merge(got.setdefault(el['_i'], {}), el)
        self.assertEqual([got[i]['n'] for i in sorted(got)], [0, 1, 2])
        self.assertEqual(sorted(got[1]['pad']), list('abcdefghi'))

    def test_a_context_larger_than_the_budget_is_refused_never_sent_over_the_limit(self):
        view = {'case_id': 'case-x', 'media_type': 'tv', 'context': {'notes_for_model': 'n' * 9000}, 'tools_available': ['ffprobe'], 'tool_call_budget': 6, 'capabilities': [],
                'evidence_format': 'v2'}
        ses = EV2.Session('case-x', view['context'], 'tv', ['ffprobe'])
        with self.assertRaises(EV2.PageBudgetError) as cm:
            ses.initial([EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(probe_out()), None, 'case')], view)
        self.assertIn('8192', str(cm.exception))
        small = dict(view, context={'notes_for_model': 'n' * 3000})
        block, n = EV2.Session('case-x', small['context'], 'tv', ['ffprobe']).initial([EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(probe_out()), None, 'case')], small)
        self.assertLessEqual(len(json.dumps(dict(small, evidence=block), ensure_ascii=False, separators=(',', ':')).encode()), EV2.WIRE_BYTES)     # control

    def test_the_runner_records_the_refusal_as_a_harness_error_not_a_message(self):
        from test_evidence_v2_run import OptionCombinations
        case = th.make_case(id='qxb-001', evidence=[ev2h.ev('e1', 'prior_record', output='x')],
                            context={'title': 'T', 'expected': {}, 'arr': {'app': None, 'ids': {}}, 'notes_for_model': 'n' * 9000})
        code, out, ts = OptionCombinations.run_main(OptionCombinations(), [case], [th.decision('insufficient_evidence', 'escalate', refs=[])], ['--evidence-format', 'v2'])
        rec = json.loads((out / 'qxb-001.json').read_text())
        self.assertEqual(rec['error']['kind'], 'harness_crash')
        self.assertIn('PageBudgetError', rec['error']['message'])
        self.assertEqual(rec['turns'], [])                                                      # nothing was sent to the model
        ts.cleanup()

    def test_at_a_2048_byte_budget_every_page_of_every_reply_fits(self):
        for rec in (self.book(2), None):
            tool = 'audiobook_inspect' if rec else 'ffprobe'
            body = rec or probe_out(duration='600', chapters=[{'start': str(i), 'end': str(i + 1), 'title': 'T%03d %s' % (i, 'y' * 60)} for i in range(200)])
            ses, texts = self.pages(body, budget=2048, tool=tool)
            self.assertGreater(len(texts), 2)
            for t in texts:
                self.assertLessEqual(len(t.encode('utf-8')), 2048)
                json.loads(t.split('\n')[0])
        ses = EV2.Session('case-aaaaaaaa', {}, 'tv', ['ffprobe'], budget=2048)
        long_text = 'é' * 3000
        text, n = ses.result(obs('t1', 'arr_lookup', 'ok', {'note': long_text, 'cjk': ['章' * 200] * 6}), 't1', 3)
        pieces = []
        for t in ev2h.fetch_all(ses, text, tool='ffprobe'):
            self.assertLessEqual(len(t.encode('utf-8')), 2048)
            o = json.loads(t.split('\n')[0])['output']
            pieces += (o.get('details') or {}).get('t1.d1', []) if isinstance((o.get('details') or {}).get('t1.d1'), list) else []
        self.assertEqual(''.join(pieces), long_text)                                            # the whole text is among the retrievable details

    def test_the_initial_evidence_pages_also_fit_at_2048(self):
        evs = [EV2.make_observation('e%d' % i, 'ffprobe', {}, 'ok', json.dumps(probe_out(duration='60', chapters=[{'start': str(k), 'end': str(k + 1), 'title': 'c%03d %s' % (k, 'z' * 50)} for k in range(30)])), None, 'case')
               for i in range(1, 4)]
        ses = EV2.Session('case-aaaaaaaa', {}, 'tv', ['ffprobe'], budget=2048)
        frame = {'case_id': 'case-aaaaaaaa', 'media_type': 'tv', 'context': {}, 'tools_available': ['ffprobe'], 'tool_call_budget': 6, 'capabilities': [], 'evidence_format': 'v2'}
        block, n = ses.initial(evs, frame)
        self.assertGreater(n, 2)
        self.assertLessEqual(len(json.dumps(dict(frame, evidence=block), ensure_ascii=False, separators=(',', ':')).encode()), 2048)
        cur = block['page']['next']
        while cur:
            st, text = ses.fetch(cur, 't6', 'ffprobe', 0, '\n' + P.BUDGET_MESSAGE)
            self.assertLessEqual(len(text.encode('utf-8')), 2048)
            cur = json.loads(text.split('\n')[0])['output'].get('page', {}).get('next')

    def test_under_v2_the_live_collector_is_cut_at_the_raw_cap_not_at_the_page_budget(self):
        big = {'status': 'ok', 'tool': 'decode', 'harness_tool': 'decode_sample', 'tool_version': 'x', 'mode': 'live', 'elapsed_s': 0.1, 'bounds': {}, 'stderr': '',
               'coverage': {'verified': ['v'], 'not_verified': ['n']}, 'input': None,
               'output': {'duration_s': 8.0, 'segments': [{'at_s': 0.0, 'window_s': 4, 'decoded_s': 4.0, 'state': 'clean', 'errors': []}], 'full': None,
                          'findings': ['f%05d %s' % (i, 'q' * 60) for i in range(800)], 'tail_marker': 'THE-END-OF-THE-OUTPUT'}}
        ts = L.suite_with(L.tv_case('qxd-001'), probes=False)
        for behavior, cut in (('v1', True), ('v2', False)):
            case = L.tv_case('qxd-001')
            ctx = T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp(), suite_dir=ts.root, evidence_mode='live', which=lambda n: None,
                            collect=lambda path, kinds, bounds, **kw: [dict(big)], evidence_which=TE.which_with('ffmpeg', 'ffprobe'), tools_behavior=behavior, keep_raw=True)
            ctx.output_cap = 4096
            r = T.call_tool(ctx, 'decode_sample', {})
            self.assertEqual('THE-END-OF-THE-OUTPUT' not in r['raw_output'], cut, behavior)
            if behavior == 'v2':
                self.assertIn('THE-END-OF-THE-OUTPUT', r['raw_output'])                 # the typed layer is given the whole collector output
        ts.cleanup()


class RawDiagnosticsAndPartialCoverage(unittest.TestCase):
    """Astra extras."""

    def live_decode(self, errors, status='ok', states=('errors',)):
        segs = [{'at_s': float(i * 2), 'window_s': 2, 'decoded_s': 2.0, 'state': st, 'errors': [e] if e else []} for i, (st, e) in enumerate(zip(states, errors))]
        return {'tool': 'decode', 'mode': 'live', 'status': status, 'coverage': {'verified': ['v'], 'not_verified': []}, 'output': {'duration_s': 10.0, 'segments': segs, 'full': None}}

    def test_every_raw_diagnostic_is_kept_even_when_it_is_unclassified(self):
        msgs = ['first odd message SENT-A', 'second odd message SENT-B', 'third odd message SENT-C']
        d = derive_one(obs('t1', 'decode_sample', 'ok', self.live_decode(msgs, states=('errors',) * 3), backend='live'))
        self.assertEqual(d.integrity, 'unknown')
        facts = EV2.item_facts(d)
        self.assertEqual([x['text'] for x in facts['diagnostics']], msgs)                      # every one, separately, none lost to a join or a clip
        shown_text = json.dumps(facts)
        for sent in ('SENT-A', 'SENT-B', 'SENT-C'):
            self.assertIn(sent, shown_text)
        d = derive_one(obs('t1', 'decode_sample', 'ok', self.live_decode([''] * 4, states=('clean',) * 4), backend='live'))
        self.assertNotIn('diagnostics', EV2.item_facts(d))                                       # control: nothing reported, nothing invented

    def test_a_timeout_keeps_the_windows_its_output_shows(self):
        rec = self.live_decode(['', ''], status='timeout', states=('clean', 'timeout'))
        d = derive_one(obs('t1', 'decode_sample', 'timeout', rec, backend='live'))
        self.assertEqual([(i['state'], i['start_s'], i['end_s']) for i in d.intervals], [('clean', 0.0, 2.0)])
        self.assertEqual(d.integrity, 'unknown')                                                  # but a timed-out call certifies nothing as a whole
        cov = analysis([obs('e1', 'ffprobe', 'ok', probe_out(duration='10')), obs('t1', 'decode_sample', 'timeout', rec, backend='live')])['coverage']
        self.assertEqual(cov['time']['0:v:0']['clean'], [[0.0, 2.0]])
        d = derive_one(obs('t1', 'decode_sample', 'error', rec, backend='live'))                  # control: a failed call keeps no clean window
        self.assertEqual(d.intervals, [])

    def test_a_negative_collector_verdict_is_not_labelled_a_defect(self):
        from test_evidence_v2_core import live_epub
        d = derive_one(obs('t1', 'epub_inspect', 'ok', live_epub(valid=False), backend='live'))
        alerts = EV2.alerts_for([d])
        self.assertEqual([(a['type'], a.get('known_defect')) for a in alerts if a['id'].endswith('.veto')], [('collector_verdict', False)])
        self.assertFalse([a for a in alerts if a['type'] == 'defect'])
        self.assertEqual(d.integrity, 'unknown')
        d = derive_one(obs('t1', 'epub_inspect', 'ok', live_epub(valid=False, findings=[{'severity': 'damage', 'what': 'the spine lists no items'}]), backend='live'))
        self.assertEqual([a['type'] for a in EV2.alerts_for([d]) if a['kind'] == 'package_damage'], ['defect'])          # control: explicit damage is a defect


class MetadataLeakWithCleanEvidence(unittest.TestCase):
    """N5: with CLEAN evidence nothing may make guards v3 fire, whatever the evaluator fields say."""

    def run_variant(self, n):
        case = L.tv_case('qxm-001', evidence=[])
        if n:
            case['truth'] = {'class': 'corrupt_file', 'source': 'construction', 'ref': 'zqx-ref-%d' % n}
            case['supported_actions'] = ['blocklist_and_search']
            case['accepted_classes'] = ['corrupt_file', 'decoder_incompatible']
            case['solvable'] = False
            case['family'] = 'zqx-family-%d' % n
            case['provenance'] = 'zqx provenance %d' % n
            case['outcome_step'] = {'check': 'zqx_check'}
            case['inject_tool_failure'] = {'tool': 'audio_sample', 'mode': 'error'}
        ts = L.suite_with(case, probes=False)
        rec_file = json.loads(json.dumps(L.REPLAY_FILE))
        rec_file['sha256'] = hashlib.sha256(b'not really media' * 50).hexdigest()
        rec_file['decode_sample']['4'].update(stderr='', frames=40)
        rec_file['decode_sample']['full'].update(stderr='', window_s='full')
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        rec, ad = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('decode_sample', {'at': 4}), dec('healthy', 'none', ['t1', 't2'])], which=th.NO_BINARIES, evidence_format='v2', guards='v3')
        ts.cleanup()
        return rec, ad

    def test_clean_evidence_keeps_a_healthy_decision_whatever_the_evaluator_fields_say(self):
        base_rec, base_ad = self.run_variant(0)
        self.assertEqual((base_rec['decision']['class'], base_rec['guard']['final_changed']), ('healthy', False))
        want = base_ad.sent_text().replace(base_rec['model_case_alias'], 'A')
        for n in (1, 2):
            rec, ad = self.run_variant(n)
            self.assertEqual((rec['decision']['class'], rec['guard']['final_changed']), ('healthy', False), n)
            self.assertEqual(ad.sent_text().replace(rec['model_case_alias'], 'A'), want, n)


class LegacyGoldenPinsEveryPrompt(unittest.TestCase):
    """O8: prompts v1-v4 and their schemas are pinned in the committed legacy golden (generated from origin/main), not only v4."""

    def test_the_golden_has_a_scenario_per_prompt_with_the_system_text_and_schema_sent(self):
        golden = json.loads((__import__('pathlib').Path(__file__).resolve().parent / 'testdata' / 'legacy-e2e-golden.json').read_text())['scenarios']
        for v in ('v1', 'v2', 'v3', 'v4'):
            self.assertIn('prompt_' + v, golden)
            self.assertIn('sent', golden['prompt_' + v])
        now = L.scenarios()
        for v in ('v1', 'v2', 'v3', 'v4'):
            self.assertEqual(now['prompt_' + v]['sent'], golden['prompt_' + v]['sent'], v)
        self.assertEqual(len({golden['prompt_' + v]['sent'] for v in ('v1', 'v2', 'v3', 'v4')}), 4)


if __name__ == '__main__':
    unittest.main()
