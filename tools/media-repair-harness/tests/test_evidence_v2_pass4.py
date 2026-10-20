"""Evidence format v2, fourth fix pass (Astra 6 and the re-review 4 of 3ffd3ece): per-element classification, filenames, split indices, the decoder_warning class, allow-list
corrections (with generated in-memory zipfile / zlib / expat exceptions), one page without retrieval text, bit depth as a maximum, EPUB execution order, the alert share and
the header refusal.  Counterexample next to control throughout."""
import io
import itertools
import json
import unittest
import xml.etree.ElementTree as ET
import zipfile

import ev2h
import th
from ev2h import analysis, derive_one, obs, probe_out, decode_out
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from test_evidence_v2_core import live_audiobook, book_file
from test_evidence_v2_pass3 import big_book

MOOV = '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found'


def live_decode(errors, state='errors'):
    return {'tool': 'decode', 'mode': 'live', 'status': 'ok', 'coverage': {'verified': ['v'], 'not_verified': []},
            'output': {'duration_s': 10.0, 'segments': [{'at_s': 0.0, 'window_s': 4, 'decoded_s': 4.0, 'state': state, 'errors': errors}], 'full': None}}


def live_audio(problems):
    return {'tool': 'audio', 'mode': 'live', 'status': 'ok', 'coverage': {'verified': ['v'], 'not_verified': []},
            'output': {'duration_s': 10.0, 'streams': [{'index': 0, 'segments': [{'at_s': 0.0, 'state': 'errors', 'problems': problems}]}], 'findings': []}}


class PerElementClassification(unittest.TestCase):
    """Astra 4: the messages of a collector's array are never joined before classification; the order of the array cannot change the verdict."""

    ELEMENTS = ('Permission denied', MOOV, 'something nobody has classified')

    def verdicts(self, make, tool):
        out = set()
        for perm in itertools.permutations(self.ELEMENTS):
            d = derive_one(obs('t1', tool, 'ok', make(list(perm)), backend='live'))
            out.add((d.integrity, tuple(sorted((f['kind'], f['known_defect']) for f in d.findings)), tuple(sorted(x['text'] + '|' + x['class'] for x in d.diagnostics))))
        return out

    def test_decode_array_order_does_not_change_the_verdict(self):
        got = self.verdicts(live_decode, 'decode_sample')
        self.assertEqual(len(got), 1, got)
        self.assertEqual(next(iter(got))[0], 'damaged')

    def test_audiobook_array_order_does_not_change_the_verdict(self):
        got = self.verdicts(lambda errs: live_audiobook([book_file(errors=errs, state='errors')]), 'audiobook_inspect')
        self.assertEqual(len(got), 1, got)
        self.assertEqual(next(iter(got))[0], 'damaged')

    def test_audio_array_order_does_not_change_the_verdict(self):
        got = self.verdicts(live_audio, 'audio_sample')
        self.assertEqual(len(got), 1, got)
        self.assertEqual(next(iter(got))[0], 'damaged')

    def test_without_a_damage_line_no_order_makes_damage(self):
        for make, tool in ((live_decode, 'decode_sample'), (live_audio, 'audio_sample')):
            for perm in itertools.permutations(('Permission denied', 'something nobody has classified')):
                d = derive_one(obs('t1', tool, 'ok', make(list(perm)), backend='live'))
                self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings]), ('unknown', [False]), perm)

    def test_an_unclassified_first_line_does_not_hide_the_second(self):
        d = derive_one(obs('t1', 'decode_sample', 'ok', live_decode(['Unknown-sized element at 0x0 inside parent with finite size', MOOV]), backend='live'))
        self.assertEqual(d.integrity, 'damaged')
        self.assertEqual([x['class'] for x in d.diagnostics], ['unclassified', 'damage'])


class FilenamesAndEnds(unittest.TestCase):
    """Astra 5: a file name that spells a library message is not that message; both ends of a message are anchored."""

    def test_a_file_named_like_a_damage_message_with_a_permission_error_is_an_execution_failure(self):
        for text in ('moov atom not found.mkv: Permission denied', 'File is not a zip file.epub: Permission denied', '/media/moov atom not found.mkv: Permission denied',
                     'Invalid data found when processing input.mp4: No such file or directory'):
            self.assertEqual(EV2.classify_line(text), 'execution', text)
            d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': text}))
            self.assertEqual((d.execution['cause'], d.integrity, [f['known_defect'] for f in d.findings]), ('tool', 'unknown', [False]), text)
        for text in ('moov atom not found.mkv: moov atom not found', 'x.mkv: File is not a zip file'):          # control: the same names with a real message after them
            self.assertEqual(EV2.classify_line(text), 'damage', text)

    def test_a_message_that_starts_a_longer_sentence_is_not_the_message(self):
        for text in ('moov atom not found in the cache directory', 'EBML header parsing failed twice, retrying', 'File is not a zip file.epub', 'partial file transfer finished'):
            self.assertIsNone(EV2.classify_line(text), text)
        for text in ('moov atom not found', 'moov atom not found.', 'File ended prematurely at pos. 123 (0x7b)', 'Bad CRC-32 for file \'a.xhtml\''):
            self.assertEqual(EV2.classify_line(text), 'damage', text)


class SplitIndexSurvivesSeveralSplits(unittest.TestCase):
    """Opus 1: every element keeps its own `_i` when several siblings are divided further."""

    @staticmethod
    def many_streams_book(n_parts=25, streams=60):
        book = big_book(n_parts)
        for k, f in enumerate(book['output']['files']):
            if k % 3 != 1:                                    # some parts are large and some are small: the large ones are divided, the small ones are not
                f['audio_streams'] = [{'codec': 'mp3', 'channels': 2, 'sample_rate': 44100 + i, 'bit_rate': 128000 + i} for i in range(streams)]
        return book

    def reconstruct(self, texts):
        files = {}
        for t in texts:
            o = json.loads(t.split('\n')[0])['output']
            for el in (o.get('facts') or {}).get('files', []):
                if '_i' not in el:
                    continue
                tgt = files.setdefault(el['_i'], {})
                for k, v in el.items():
                    if k == '_i' or k.endswith('_shown'):
                        continue
                    if isinstance(v, list):
                        tgt.setdefault(k, []).extend(v)
                    elif isinstance(v, dict) and isinstance(tgt.get(k), dict):
                        tgt[k].update(v)
                    else:
                        tgt[k] = v
        return files

    def test_a_25_part_book_at_4096_keeps_every_part_under_its_own_index(self):
        ses = EV2.Session('case-aaaaaaaa', {}, 'audiobook', ['audiobook_inspect', 'ffprobe'], budget=4096)
        ses.initial([])
        text, _n = ses.result(EV2.make_observation('t1', 'audiobook_inspect', {}, 'ok', json.dumps(self.many_streams_book()), 'live', 'tool'), 't1', 5)
        texts = ev2h.fetch_all(ses, text, tool='audiobook_inspect')
        self.assertTrue(all(len(t.encode('utf-8')) <= 4096 for t in texts))
        files = self.reconstruct(texts)
        divided = [i for i in range(25) if i % 3 != 1]
        self.assertTrue(all(i in files for i in divided))
        for i in divided:                                      # the divided parts: each under its own index, nothing merged into another
            self.assertEqual(files[i]['tags']['title'], 'Part %02d' % (i + 1), i)
            self.assertEqual(files[i]['duration_s'], 1800.0 + i + 1, i)
            self.assertEqual([s['sample_rate'] for s in files[i]['audio_streams']], [44100 + k for k in range(60)], i)

    def test_several_split_siblings_in_one_list_are_not_merged(self):
        records = [{'n': i, 'pad': {k: ('v%d' % i) * 90 for k in 'abcdefghijklmnop'}} for i in range(6)]
        units = [(('facts', 'records'), 'split', r) for r in records]
        header = {'id': 't1', 'tool': 'arr_lookup', 'alerts': [], 'page': None}
        env = lambda b: json.dumps({'output': b})
        pages = EV2.paginate(header, units, env, env, 'case-aaaaaaaa', 't1', budget=2600)
        got = {}
        for body, _c in pages:
            for el in body.get('facts', {}).get('records', []):
                if '_i' in el:
                    for k, v in el.items():
                        if isinstance(v, dict):
                            got.setdefault(el['_i'], {}).setdefault(k, {}).update(v)
                        elif k != '_i':
                            got.setdefault(el['_i'], {})[k] = v
        self.assertGreater(len(pages), 3)
        indexed = sorted(got)
        self.assertEqual(indexed, sorted(set(indexed)))
        for i in indexed:
            self.assertEqual(got[i]['n'], i, i)
            self.assertEqual(sorted(got[i]['pad']), list('abcdefghijklmnop'), i)


class DecoderWarningClass(unittest.TestCase):
    """Opus allow-list audit, Astra 6: messages healthy files also print are decoder_warning, not damage."""

    WARNINGS = ('Could not find codec parameters for stream 2 (Subtitle: hdmv_pgs_subtitle): unspecified size', 'non-existing PPS 0 referenced', 'missing picture in access unit with size 1234',
                'Element at 0x1f ending at 0x2f exceeds containing master element ending at 0x20', 'error reading header', 'Error while decoding stream #0:0: Invalid data found when processing input',
                'Decoding error: Invalid data found when processing input', 'Error parsing NAL unit #3.', 'Could not find ref with POC 12', 'channel element 0.0 is not allocated',
                'Input buffer exhausted before END element found', 'frame sync error', 'CRC error at PTS 12345')

    def test_each_warning_message_is_not_a_defect_not_clean_and_kept(self):
        for msg in self.WARNINGS:
            for text in ('[h264 @ 0x55d5c0a8e0c0] ' + msg, msg):
                self.assertEqual(EV2.classify_line(text), 'warning', text)
            d = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=0, stderr='[h264 @ 0x0] ' + msg), {'at': 0}), 8.0)
            self.assertEqual((d.integrity, [(f['kind'], f['known_defect']) for f in d.findings], [i['state'] for i in d.intervals]),
                             ('unknown', [('decoder_warning', False)], ['unclassified']), msg)
            self.assertIn(msg, json.dumps(EV2.item_facts(d)))                 # kept
            self.assertEqual([x['class'] for x in d.diagnostics], ['warning'])

    def test_a_warning_never_vetoes_healthy_alone_but_damage_still_does(self):
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['e1'], 'reason': 'r'}
        base = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe_out())}]
        warn = {'id': 't2', 'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok', 'output': json.dumps(decode_out(stderr='[h264 @ 0x0] non-existing PPS 0 referenced'))}
        self.assertIsNone(DG.check_healthy_v3(healthy, base + [warn], []))
        bad = dict(warn, output=json.dumps(decode_out(stderr='[h264 @ 0x0] non-existing PPS 0 referenced\n[h264 @ 0x0] error while decoding MB 1 2, bytestream -5')))
        self.assertIn('decoder_errors', DG.check_healthy_v3(healthy, base + [bad], []))
        # a warning is not clean either: with only a warning as the integrity evidence there is nothing to support healthy
        self.assertIn('no clean integrity result', DG.check_healthy_v3(healthy, [warn], []))

    def test_invalid_data_is_damage_for_open_and_demux_failures_and_a_warning_under_a_decode_wrapper(self):
        for text, want in (('Invalid data found when processing input', 'damage'), ('pipe:0: Invalid data found when processing input', 'damage'),
                           ('Error opening input files: Invalid data found when processing input', 'damage'), ('Error during demuxing: Invalid data found when processing input', 'damage'),
                           ('media/x.mp3: Invalid data found when processing input', 'damage'),
                           ('Error while decoding stream #0:0: Invalid data found when processing input', 'warning'),
                           ('[vist#0:0/h264 @ 0x1] [dec:h264 @ 0x2] Decoding error: Invalid data found when processing input', 'warning')):
            self.assertEqual(EV2.classify_line(text), want, text)

    def test_error_reading_header_is_decided_by_the_following_error_code_line(self):
        self.assertEqual([c for _l, c in EV2.classify_text(['error reading header'])], ['warning'])
        self.assertEqual([c for _l, c in EV2.classify_text(['error reading header', 'Input/output error'])], ['execution', 'execution'])
        self.assertEqual([c for _l, c in EV2.classify_text('error reading header\nInput/output error')], ['execution', 'execution'])
        self.assertEqual(EV2.classify_line('error reading header: Input/output error'), 'execution')
        self.assertEqual([c for _l, c in EV2.classify_text(['error reading header', 'moov atom not found'])], ['warning', 'damage'])
        d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'error reading header\nInput/output error'}))
        self.assertEqual((d.execution['cause'], d.findings, d.integrity), ('tool', [d.findings[0]] if d.findings else [], 'unknown'))
        self.assertFalse([f for f in d.findings if f['known_defect']])

    def test_a_probe_that_only_failed_to_find_codec_parameters_is_not_damaged(self):
        text = '[matroska,webm @ 0x1] Could not find codec parameters for stream 2 (Subtitle: hdmv_pgs_subtitle): unspecified size'
        d = derive_one(obs('t1', 'ffprobe', 'ok', probe_out(stderr=text)))
        self.assertEqual((d.container, d.integrity, [f['known_defect'] for f in d.findings]), ('unknown', 'unknown', [False]))
        d = derive_one(obs('t1', 'ffprobe', 'ok', probe_out(stderr='[matroska,webm @ 0x1] moov atom not found')))
        self.assertEqual((d.container, d.integrity), ('damaged', 'damaged'))


def zip_exception(mutate):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('a.txt', 'hello world, hello world, hello world, ' * 40)
    raw = bytearray(buf.getvalue())
    mutate(raw)
    try:
        with zipfile.ZipFile(io.BytesIO(bytes(raw))) as z:
            z.read('a.txt')
    except Exception as e:  # noqa: BLE001
        return '%s: %s' % (type(e).__name__, str(e)[:200])
    return None


class AllowListCorrections(unittest.TestCase):
    """Astra 6/7 and Opus: sources, notes, generated exceptions."""

    def test_real_zipfile_zlib_and_expat_exceptions_are_classified_as_damage(self):
        def name_mismatch(raw):
            i = raw.find(b'a.txt')
            raw[i:i + 5] = b'z.txt'
        def zlib_garbage(raw):
            i = raw.find(b'a.txt') + 5
            raw[i + 3:i + 12] = b'\xff\xff\xff\xff\xff\xff\xff\xff\xff'
        def bad_magic(raw):
            j = raw.rfind(b'PK\x01\x02')
            raw[j:j + 4] = b'XXXX'
        def truncated(raw):
            del raw[-30:]
        got = {}
        for name, mut in (('name_mismatch', name_mismatch), ('zlib_garbage', zlib_garbage), ('bad_magic', bad_magic), ('truncated', truncated)):
            text = zip_exception(mut)
            self.assertIsNotNone(text, name)
            got[name] = (text, EV2.classify_line(text))
        self.assertEqual(got['name_mismatch'][1], 'damage', got['name_mismatch'])
        self.assertIn('differ', got['name_mismatch'][0])
        self.assertTrue(all(c == 'damage' for _t, c in got.values()), got)
        for xml in ('<a b="1" b="2"/>', '<a>&nbsp;</a>', '<x:a/>', '<a><b></a>', '<a>'):
            try:
                ET.fromstring(xml)
            except ET.ParseError as e:
                self.assertEqual(EV2.classify_line('ParseError: %s' % e), 'damage', (xml, str(e)))

    def test_an_unrelated_exception_text_is_not_damage(self):
        for text in ('KeyError: \'a.txt\'', 'RuntimeError: ZIP file is closed', 'ValueError: I/O operation on closed file', 'zipfile.BadZipFile: x'):
            self.assertIsNone(EV2.classify_line(text), text)

    def test_corrupt_decoded_frame_with_or_without_a_stream_index(self):
        for text in ('corrupt decoded frame in stream 0', 'corrupt decoded frame', '[vist#0:0/h264 @ 0x1] corrupt decoded frame'):
            self.assertEqual(EV2.classify_line(text), 'damage', text)

    def test_new_execution_errors(self):
        for text in ('Stale file handle', 'Transport endpoint is not connected', 'Connection timed out', 'x.mkv: Stale file handle', 'OSError: [Errno 110] Connection timed out'):
            self.assertEqual(EV2.classify_line(text), 'execution', text)

    def test_every_entry_has_a_source_and_the_log_level_notes_are_present(self):
        notes = {pat: note for pat, _src, note in EV2.DAMAGE_ALLOW_LIST}
        for pat, src, note in EV2.DAMAGE_ALLOW_LIST + EV2.WARNING_ALLOW_LIST:
            self.assertTrue(src, pat)
        for pat in (r'concealing \d+ DC, \d+ AC, \d+ MV errors in [IPBS] frame', r'corrupt input packet in stream \d+', r'Packet corrupt \(stream = \d+, dts = \S+\)'):
            self.assertIn('not emitted', notes[pat], pat)
        src = {pat: s for pat, s, _n in EV2.DAMAGE_ALLOW_LIST}
        self.assertEqual(src[r'Packet corrupt \(stream = \d+, dts = \S+\)'], 'libavformat/demux.c')


class OnePageHasNoRetrievalText(unittest.TestCase):
    """Opus 2."""

    def frame(self):
        return {'case_id': 'case-aaaaaaaa', 'media_type': 'tv', 'context': {'title': 'x'}, 'tools_available': [], 'tool_call_budget': 6, 'capabilities': [], 'evidence_format': 'v2'}

    def test_a_first_message_that_fits_one_page_says_nothing_about_retrieval(self):
        block, n = EV2.Session('case-aaaaaaaa', {}, 'tv', []).initial([EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(probe_out()), None, 'case')], self.frame())
        self.assertEqual(n, 1)
        self.assertNotIn('page', block)
        self.assertNotIn('retrieval', json.dumps(block))
        chap = [{'start': str(i), 'end': str(i + 1), 'title': 'T%03d %s' % (i, 'y' * 50)} for i in range(200)]       # control: more than one page
        block, n = EV2.Session('case-aaaaaaaa', {}, 'tv', []).initial([EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(probe_out(chapters=chap)), None, 'case')], self.frame())
        self.assertIn('no tool is offered', block['page']['retrieval'])

    @th.needs_suite
    def test_no_public_case_without_tools_gets_the_sentence_unless_it_really_needs_it(self):
        from pathlib import Path
        from media_repair_harness import run as R, protocol as P, tools as T
        import tempfile
        base = Path(th.SUITE).parent
        seen = 0
        for suite in ('suite', 'suite-dev-v1.1'):
            sd = base / suite
            for case, _ in R.load_cases(sd):
                if case.get('tools_available'):
                    continue
                seen += 1
                ctx = T.Context(case, T.Fixture.from_case(case, sd), tempfile.mkdtemp(), suite_dir=sd, which=th.NO_BINARIES, tools_behavior='v2', keep_raw=True)
                view = P.case_view(case, [], case_alias='case-aaaaaaaa')
                ses = EV2.Session('case-aaaaaaaa', view['context'], view['media_type'], [])
                frame = {'case_id': view['case_id'], 'media_type': view['media_type'], 'context': view['context'], 'tools_available': [], 'tool_call_budget': 6, 'capabilities': T.capabilities(ctx),
                         'evidence_format': 'v2'}
                block, n = ses.initial([EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in R.resolve_evidence_raw(case, sd, ctx.redact)], frame)
                self.assertEqual(n, 1, case['id'])
                self.assertNotIn('retrieval', json.dumps(block), case['id'])
        self.assertGreaterEqual(seen, 20)


class BitDepthIsAMaximum(unittest.TestCase):
    """Opus 3."""

    def verdict(self, video, pix):
        ss = [{'index': 0, 'codec_type': 'video', 'codec_name': 'hevc', 'pix_fmt': pix, 'width': 1920, 'height': 1080}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]
        c = analysis([obs('e1', 'ffprobe', 'ok', probe_out(streams=ss))], {'client_profile': {'containers': ['matroska,webm'], 'video': video}})['client']
        return {r['field']: r['verdict'] for r in c['rows']}.get('video_bit_depth')

    def test_a_stated_depth_supports_everything_up_to_it_and_rejects_more(self):
        for text in ('hevc 10-bit', 'hevc up to 1080p, 10-bit', 'hevc, up to 1080p, 10-bit'):
            self.assertEqual(self.verdict(text, 'yuv420p'), 'supported', text)             # 8-bit file
            self.assertEqual(self.verdict(text, 'yuv420p10le'), 'supported', text)
            self.assertEqual(self.verdict(text, 'yuv420p12le'), 'unsupported', text)       # 12-bit file
        self.assertEqual(self.verdict('hevc 8-bit', 'yuv420p10le'), 'unsupported')           # control: an 8-bit client still rejects 10-bit
        self.assertEqual(self.verdict('hevc 8-bit or 10-bit', 'yuv420p'), 'supported')


class EpubExecutionBeforeStage(unittest.TestCase):
    """Opus 4."""

    def test_a_permission_error_at_zip_open_is_an_execution_failure_not_package_damage(self):
        for err in ("PermissionError: [Errno 13] Permission denied: '/media/book.epub'", 'OSError: [Errno 5] Input/output error'):
            d = derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 0, 'error': err, 'stage': 'zip_open', 'status': 'error'}))
            self.assertEqual(d.execution['cause'], 'tool', err)
            self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings]), ('unknown', [False]), err)
            self.assertEqual(d.package['zip_open'], 'unknown')
        d = derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 9, 'error': 'BadZipFile: File is not a zip file', 'stage': 'zip_open', 'status': 'error'}))      # control
        self.assertEqual((d.execution['cause'], d.integrity, d.package['zip_open']), ('input', 'damaged', 'damaged'))


class AlertShareAndHeaderRefusal(unittest.TestCase):
    """Opus 5 and the mutation gap."""

    def book_pages(self, n, budget):
        ses = EV2.Session('case-aaaaaaaa', {}, 'audiobook', ['audiobook_inspect', 'ffprobe'], budget=budget)
        ses.initial([])
        text, pages = ses.result(EV2.make_observation('t1', 'audiobook_inspect', {}, 'ok', json.dumps(big_book(n)), 'live', 'tool'), 't1', 5)
        return ev2h.fetch_all(ses, text, tool='audiobook_inspect')

    def test_the_full_alerts_take_at_most_a_quarter_of_any_page_and_the_rest_stays_retrievable(self):
        for budget in (8192, 4096):
            texts = self.book_pages(25, budget)
            self.assertGreater(len(texts), 1)
            for t in texts:
                alerts = json.loads(t.split('\n')[0])['output']['alerts']
                self.assertLessEqual(EV2.nbytes(alerts), budget // 4, (budget, EV2.nbytes(alerts)))
            ids = set()
            for t in texts:
                o = json.loads(t.split('\n')[0])['output']
                for a in o['alerts']:
                    ids.update(a.get('first_ids', [a.get('id')]) if isinstance(a, dict) else [a.split(':')[1]])
                for lst in (o.get('alert_ids') or {}).values():
                    ids.update(lst)
            self.assertEqual(len({i for i in ids if i and '.f' in i}), 75, budget)

    def test_a_header_that_cannot_fit_is_refused_even_with_no_units_at_all(self):
        header = {'id': 'x' * 3000, 'tool': 'ffprobe', 'alerts': [], 'page': None}
        env = lambda b: json.dumps({'output': b})
        with self.assertRaises(EV2.PageBudgetError):
            EV2.paginate(header, [], env, env, 'case-aaaaaaaa', 't1', budget=2560)
        small = dict(header, id='t1')
        pages = EV2.paginate(small, [], env, env, 'case-aaaaaaaa', 't1', budget=2560)           # control
        self.assertEqual(len(pages), 1)


if __name__ == '__main__':
    unittest.main()


def zlib_exception(data):
    import zlib
    try:
        zlib.decompress(data)
    except zlib.error as e:
        return 'zlib.error: %s' % e
    return None


class ZlibOnlyDataErrorsAreDamage(unittest.TestCase):
    """Astra 7: only zlib data errors (-3) and its truncated-stream text are damage; memory is an execution failure; other codes are unclassified."""

    def test_real_zlib_data_errors_and_truncation_are_damage(self):
        import zlib
        good = zlib.compress(b'hello world' * 100)
        for data in (b'\x78\x9c\xff\xff\xff\xff', b'xxxxxxxx', good[:20]):
            text = zlib_exception(data)
            self.assertIsNotNone(text)
            self.assertEqual(EV2.classify_line(text), 'damage', text)
        for text in ('Error -3 while decompressing data: invalid distance too far back', 'Error -3 while decompressing data: incorrect header check',
                     'Error -5 while decompressing data: incomplete or truncated stream'):
            self.assertEqual(EV2.classify_line(text), 'damage', text)

    def test_memory_is_an_execution_failure_and_other_codes_are_not_damage(self):
        self.assertEqual(EV2.classify_line('Error -4 while decompressing data: insufficient memory'), 'execution')
        self.assertEqual(EV2.classify_line('zlib.error: Error -4 while decompressing data: insufficient memory'), 'execution')
        for text in ('Error -2 while decompressing data: inconsistent stream state', 'Error -5 while decompressing data', 'Error -5 while decompressing data: something else',
                     'Error -1 while decompressing data: unknown'):
            self.assertIsNone(EV2.classify_line(text), text)
        for text, cause, integrity in (('Error -4 while decompressing data: insufficient memory', 'tool', 'unknown'), ('Error -2 while decompressing data: inconsistent stream state', None, 'unknown')):
            d = derive_one(obs('t1', 'epub_inspect', 'error', {'bytes': 9, 'error': 'zlib.error: ' + text, 'stage': 'zip_read', 'status': 'error'}))
            self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings]), (integrity, [False]), text)
            if cause:
                self.assertEqual(d.execution['cause'], cause, text)


class AudioWarningKindMatchesDecode(unittest.TestCase):
    def test_a_classified_warning_in_audio_is_a_decoder_warning_and_other_text_stays_unclassified(self):
        w = derive_one(obs('t1', 'audio_sample', 'ok', live_audio(['[h264 @ 0x1] non-existing PPS 0 referenced']), backend='live'))
        self.assertEqual(([f['kind'] for f in w.findings], w.integrity), (['decoder_warning'], 'unknown'))
        u = derive_one(obs('t1', 'audio_sample', 'ok', live_audio(['something nobody has classified']), backend='live'))
        self.assertEqual(([f['kind'] for f in u.findings], u.integrity), (['audio_messages_unclassified'], 'unknown'))
