"""Evidence format v2, third fix pass (Astra 5 and the re-review of 4328e342): live probe stderr, realistic live audiobooks at the page budget, the first message at every accepted
budget, trailing client restrictions, timeout wording, and the invariants that mutation testing showed were unguarded.  Counterexample next to control throughout."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import th
from ev2h import analysis, derive_one, obs, probe_out, tc, dec
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import run as R
from media_repair_harness import tools as T
from test_evidence_v2_core import live_audiobook, book_file, live_epub

ERR = '[mp3float @ 0x55d5c0a8e0c0] Error while decoding stream #0:0: Invalid data found when processing input'


def live_probe(stderr='', status='ok', streams=True):
    out = {'format': 'matroska,webm', 'duration_s': 60.0, 'bytes': 1000, 'streams': [{'index': 0, 'type': 'video', 'codec': 'h264'}] if streams else [], 'chapters': [], 'findings': []}
    return {'status': status, 'tool': 'probe', 'mode': 'live', 'coverage': {'verified': ['container and stream headers parse'], 'not_verified': ['stream contents']}, 'stderr': stderr, 'output': out}


class LiveProbeStderr(unittest.TestCase):
    """Opus P1-1: a live probe's stderr is classified by the same allow-list; `ok` with damage text is not clean."""

    def test_an_ok_live_probe_with_damage_on_stderr_is_not_clean_and_keeps_the_text(self):
        for text in ('[matroska,webm @ 0x55d5c0a8e0c0] File ended prematurely at pos. 123456 (0x1e240)', '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found'):
            d = derive_one(obs('t1', 'ffprobe', 'ok', live_probe(text), backend='live'))
            self.assertEqual((d.container, d.integrity), ('damaged', 'damaged'), text)
            self.assertEqual([(f['kind'], f['known_defect']) for f in d.findings], [('container_damage', True)])
            self.assertIn(text, json.dumps(EV2.item_facts(d)))
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['t1'], 'reason': 'r'}
        shown = [{'id': 't1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(live_probe('File ended prematurely'))}]
        self.assertIn('container_damage', DG.check_healthy_v3(healthy, shown, []))
        shown[0]['output'] = json.dumps(live_probe(''))                        # control: the same record without stderr is clean
        self.assertIsNone(DG.check_healthy_v3(healthy, shown, []))

    def test_unrecognised_probe_stderr_is_unknown_not_clean_and_not_damaged(self):
        d = derive_one(obs('t1', 'ffprobe', 'ok', live_probe('[matroska,webm @ 0x0] Unknown-sized element at 0x0 inside parent with finite size'), backend='live'))
        self.assertEqual((d.container, d.integrity, [(f['kind'], f['known_defect']) for f in d.findings]), ('unknown', 'unknown', [('probe_messages', False)]))
        self.assertTrue(d.diagnostics and d.diagnostics[0]['class'] == 'unclassified')
        d = derive_one(obs('t1', 'ffprobe', 'ok', live_probe(''), backend='live'))
        self.assertEqual((d.container, d.findings), ('clean', []))

    def test_audiobook_part_probe_stderr_is_classified_too(self):
        part = book_file()
        part['probe_stderr'] = '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found'
        d = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([part, book_file()]), backend='live'))
        self.assertEqual(d.integrity, 'damaged')
        self.assertEqual([f['location']['file'] for f in d.findings if f['known_defect']], ['part-1'])
        part['probe_stderr'] = 'some message nobody classified'
        d = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([part, book_file()]), backend='live'))
        self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings]), ('unknown', [False]))
        self.assertIn('some message nobody classified', json.dumps(EV2.item_facts(d)))
        d = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([book_file(), book_file()]), backend='live'))      # control
        self.assertEqual((d.integrity, d.findings), ('clean', []))
        rec = live_audiobook([book_file()])
        rec['stderr'] = '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found'                  # the record-level excerpt as well
        self.assertEqual(derive_one(obs('t1', 'audiobook_inspect', 'ok', rec, backend='live')).integrity, 'damaged')


def big_book(n_parts, segs=3, errs=3):
    files = []
    for n in range(1, n_parts + 1):
        files.append({'format': 'mp3', 'duration_s': 1800.0 + n, 'bytes': 30000000 + n, 'audio_streams': [{'codec': 'mp3', 'channels': 2, 'sample_rate': 44100}],
                      'tags': {'album': 'A Book', 'artist': 'An Author', 'title': 'Part %02d' % n, 'track': str(n)}, 'chapter_count': 0,
                      'decode': {'segments': [{'at_s': float(s * 600), 'decoded_s': 2.0, 'state': 'errors', 'exit_code': 0, 'error_lines': errs, 'errors': [ERR] * errs} for s in range(segs)]}})
    return {'tool': 'audiobook', 'mode': 'live', 'status': 'ok', 'coverage': {'verified': ['%d parts probed' % n_parts], 'not_verified': ['x']}, 'stderr': '',
            'output': {'parts': n_parts, 'parts_probed': n_parts, 'files': files, 'findings': ['x'], 'tag_consistency': {'consistent': True}}}


class RealisticAudiobooksDoNotCrash(unittest.TestCase):
    """Opus P1-2: a G9 crash (PageBudgetError) on a realistic live audiobook is a bug."""

    def render(self, n, budget=EV2.WIRE_BYTES):
        ses = EV2.Session('case-aaaaaaaa', {}, 'audiobook', ['audiobook_inspect', 'ffprobe'], budget=budget)
        ses.initial([])
        text, pages = ses.result(EV2.make_observation('t1', 'audiobook_inspect', {}, 'ok', json.dumps(big_book(n)), 'live', 'tool'), 't1', 5)
        return ses, ev2h.fetch_all(ses, text, tool='audiobook_inspect', remaining=0)

    def test_25_and_38_parts_each_with_errors_paginate_instead_of_crashing_and_every_page_fits(self):
        for n in (10, 25, 32, 38, 50):
            ses, texts = self.render(n)
            for t in texts:
                self.assertLessEqual(len(t.encode('utf-8')), EV2.WIRE_BYTES, (n, len(texts)))
                self.assertEqual(json.loads(t.split('\n')[0])['type'], 'tool_result')

    def test_nothing_is_lost_when_the_alerts_are_shortened(self):
        defects = 25 * 3        # one known defect per decode window
        ses, texts = self.render(25)
        ids = set()
        total = None
        for t in texts:
            o = json.loads(t.split('\n')[0])['output']
            for a in o['alerts']:
                if isinstance(a, dict) and a.get('id'):
                    ids.add(a['id'])
                elif isinstance(a, dict):
                    ids.update(a.get('first_ids', []))
                else:
                    ids.add(a.split(':')[1])
            ids.update(o.get('alert_ids', {}).get('defect:decoder_errors', []))
            total = o['page']['alerts_total'] if 'page' in o else total
        self.assertEqual(len({i for i in ids if '.f' in i}), defects)             # every defect id is reachable (in the alerts or in the retrievable id lists)
        self.assertGreaterEqual(total, defects)

    def test_the_budget_holds_at_4096_and_the_smallest_accepted_budget(self):
        for budget in (4096, EV2.MIN_WIRE_BYTES):
            for n in (3, 25):
                ses, texts = self.render(n, budget)
                self.assertTrue(all(len(t.encode('utf-8')) <= budget for t in texts), (budget, n))

    def test_a_header_that_cannot_fit_in_any_form_is_still_refused_never_sent(self):
        ses = EV2.Session('case-aaaaaaaa', {}, 'audiobook', ['audiobook_inspect'], budget=EV2.MIN_WIRE_BYTES)
        ses.initial([])
        huge_args = {'id': 'x' * 3000}
        with self.assertRaises(EV2.PageBudgetError):
            ses.result(EV2.make_observation('t' + 'x' * 3000, 'audiobook_inspect', huge_args, 'ok', '{}', 'live', 'tool'), 't1', 5)

    def test_without_tools_the_retrieval_text_is_inside_the_budget(self):
        for word in ('y', '漢'):
            for n in (40, 42, 44, 46):
                frame = {'case_id': 'case-aaaaaaaa', 'media_type': 'tv', 'context': {'title': 'x'}, 'tools_available': [], 'tool_call_budget': 6, 'capabilities': [], 'evidence_format': 'v2'}
                ses = EV2.Session('case-aaaaaaaa', {}, 'tv', [])
                chap = [{'start': str(i), 'end': str(i + 1), 'title': 'T%03d %s' % (i, word * 40)} for i in range(120)]
                pr = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'matroska,webm', 'duration': '600', 'size': '1'},
                      'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'pix_fmt': 'yuv420p'}], 'chapters': chap[:n * 2]}
                block, k = ses.initial([EV2.make_observation('e%d' % i, 'ffprobe', {}, 'ok', json.dumps(pr, ensure_ascii=False), None, 'case') for i in (1, 2, 3)], frame)
                self.assertLessEqual(EV2.nbytes(dict(frame, evidence=block)), EV2.WIRE_BYTES, (word, n))
                self.assertIn('no tool is offered', block['page']['retrieval'])
                self.assertNotIn('next', block['page'])


@th.needs_suite
class WireFloor(unittest.TestCase):
    """The accepted minimum budget is the smallest where every public case of both dev suites provably fits its first message and its default replies."""

    @classmethod
    def setUpClass(cls):
        cls.base = Path(th.SUITE).parent
        cls.scratch = tempfile.mkdtemp()

    def calls(self, case, sd):
        ctx = T.Context(case, T.Fixture.from_case(case, sd), Path(self.scratch) / 'caps', suite_dir=sd, tools_behavior='v2', keep_raw=True)
        caps = {c['tool']: c for c in T.capabilities(ctx)}
        out = []
        for tool in case.get('tools_available') or []:
            out.append((tool, {}))
            offs = (caps.get(tool) or {}).get('offsets_s')
            if isinstance(offs, list):
                out += [(tool, {'at': o}) for o in offs]
            if tool == 'decode_sample':
                out.append((tool, {'full': True}))
        return out

    def errors_at(self, budget):
        errors = []
        biggest = 0
        for suite in ('suite', 'suite-dev-v1.1'):
            sd = self.base / suite
            for case, _sha in R.load_cases(sd):
                calls = self.calls(case, sd)
                for i in range(0, max(len(calls), 1), 6):
                    replies = [tc(t, a) for t, a in calls[i:i + 6]] + [dec('insufficient_evidence', 'escalate')]
                    ad = A.ScriptedAdapter('scripted', replies)
                    try:
                        rec = R.run_case(case, 'sha', ad, sd, self.scratch, run_id='floor', prompt_version='v4', evidence_format='v2', guards='v3', tool_output_bytes=budget)
                    except EV2.PageBudgetError as e:
                        errors.append((suite, case['id'], 'initial', str(e)[:60]))
                        continue
                    if (rec.get('error') or {}).get('kind') == 'harness_crash':
                        errors.append((suite, case['id'], 'in run', rec['error']['message'][:80]))
                    for m in ad.calls[-1] if ad.calls else []:
                        if m['role'] == 'user':
                            biggest = max(biggest, len(m['content'].encode('utf-8')))
        return errors, biggest

    def test_no_public_case_crashes_at_or_above_the_accepted_minimum(self):
        for budget in (EV2.MIN_WIRE_BYTES, 4096, EV2.WIRE_BYTES):
            errors, biggest = self.errors_at(budget)
            self.assertEqual(errors, [], budget)
            self.assertLessEqual(biggest, budget)

    def test_the_minimum_is_the_smallest_step_that_works_one_step_below_still_crashes_somewhere(self):
        from unittest import mock
        below = EV2.MIN_WIRE_BYTES - 256
        with mock.patch.object(EV2, 'MIN_WIRE_BYTES', 1024):          # (the runner would refuse the budget; this asks the pagination itself)
            errors, _ = self.errors_at(below)
        self.assertTrue([e for e in errors if 'cannot be made to fit' in e[3] or 'cannot be divided' in e[3]], 'one step below the floor nothing crashes: lower the floor')

    def test_the_runner_refuses_budgets_below_the_minimum(self):
        for bad in (EV2.MIN_WIRE_BYTES - 1, 2048, 1000, 9000):
            with self.assertRaises(ValueError):
                R.check_option_combination('v4', 'v2', None, bad)
        R.check_option_combination('v4', 'v2', None, EV2.MIN_WIRE_BYTES)


class ClientTrailingRestrictions(unittest.TestCase):
    """Astra 3, Opus P1-3: a restriction after `up to` is consumed (compared) or the clause is unread."""

    def verdicts(self, video):
        ss = [{'index': 0, 'codec_type': 'video', 'codec_name': 'hevc', 'pix_fmt': 'yuv420p10le', 'width': 1920, 'height': 1080}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]
        c = analysis([obs('e1', 'ffprobe', 'ok', probe_out(streams=ss))], {'client_profile': {'containers': ['matroska,webm'], 'video': video}})['client']
        return c, {r['field']: r['verdict'] for r in c['rows']}

    def test_depth_after_the_limit_is_compared_and_a_ten_bit_file_is_unsupported(self):
        for text in ('hevc up to 1080p, 8-bit', 'hevc up to 1080p 8-bit', 'hevc, up to 1080p, 8-bit'):
            c, v = self.verdicts(text)
            self.assertEqual((v['video_codec'], v['video_height_px'], v['video_bit_depth']), ('supported', 'supported', 'unsupported'), text)
            self.assertFalse(c['summary']['unsupported'] == 0)
        c, v = self.verdicts('hevc up to 1080p, 10-bit')                        # control: the same words with the file's depth
        self.assertEqual(v['video_bit_depth'], 'supported')
        self.assertTrue(c['summary']['complete'] or c['summary']['unknown'] == 0)

    def test_pixel_format_after_the_limit_belongs_to_the_codec_before_it(self):
        c, v = self.verdicts('hevc up to 1080p, yuv420p')
        self.assertEqual(v['video_pix_fmt'], 'unsupported')
        c, v = self.verdicts('hevc up to 1080p, yuv420p10le')
        self.assertEqual(v['video_pix_fmt'], 'supported')


class TimeoutWording(unittest.TestCase):
    """Astra 8: the observed window and the unfinished remainder are told apart."""

    def rec(self):
        return {'tool': 'decode', 'mode': 'live', 'status': 'timeout', 'coverage': {'verified': ['v'], 'not_verified': []},
                'output': {'duration_s': 10.0, 'segments': [{'at_s': 0.0, 'window_s': 2, 'decoded_s': 2.0, 'state': 'clean', 'errors': []},
                                                            {'at_s': 4.0, 'window_s': 2, 'decoded_s': 0.0, 'state': 'timeout', 'errors': []}], 'full': None}}

    def test_a_timeout_that_showed_a_clean_window_does_not_say_it_settled_nothing(self):
        d = derive_one(obs('t1', 'decode_sample', 'timeout', self.rec(), backend='live'))
        text = ' | '.join(d.unresolved)
        self.assertNotIn('settled nothing', text)
        self.assertIn('0-2 s (clean)', text)
        self.assertIn('rest of what was requested was not completed', text)
        d = derive_one(obs('t1', 'decode_sample', 'timeout', 'decode_sample exceeded the 60 s tool timeout', {'at': 0}))          # control: nothing observed
        self.assertTrue(any('settled nothing' in u for u in d.unresolved))


class DamageNeverErasedAcrossSources(unittest.TestCase):
    """Mutation-surviving invariants (Opus P3)."""

    def test_cut_json_contributes_only_its_diagnostic_values_never_its_metadata(self):
        cut = ('{"chapters": [{"title": "moov atom not found"}], "format": {"tags": {"title": "Invalid data found when processing input"}}, "stderr": "first line\\nsecond line", '
               '"streams": [] ...[truncated]')
        self.assertEqual(EV2.diagnostic_fragments(cut), ['first line\nsecond line'])
        self.assertEqual(EV2.diagnostic_fragments('moov atom not found'), ['moov atom not found'])          # plain text is the tool's own message
        self.assertEqual(EV2.diagnostic_fragments('{"chapters": [{"title": "moov atom not found"}] ...[truncated]'), [])

    def test_the_execution_error_check_is_per_line_and_decides_the_cause(self):
        d = derive_one(obs('t1', 'ffprobe', 'error', 'Permission denied: /media/x.mkv'))
        self.assertEqual(d.execution['cause'], 'tool')
        d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'x.mkv: Permission denied'}))
        self.assertEqual(d.execution['cause'], 'tool')
        d = derive_one(obs('t1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'x.mkv: Permission denied\nmoov atom not found'}))
        self.assertEqual(d.execution['cause'], 'input')

    def test_restore_resolves_references_like_the_run_when_a_guard_had_fired(self):
        case = L.tv_case('qxp-001', evidence=[])
        ts = L.suite_with(case)
        healthy = dec('healthy', 'none', ['t1.f1'])
        rec, ad = ev2h.scripted_run(case, ts, [tc('decode_sample', {'at': 4}), healthy], which=th.NO_BINARIES, evidence_format='v2')
        raw = R.resolve_evidence_raw(case, ts.root)
        ts.cleanup()
        self.assertEqual(rec['bad_evidence_refs'], [])                                         # the unguarded run resolved t1.f1
        guarded = DG.apply_to_record(rec, case, raw, 'v3')
        self.assertTrue(guarded['guard']['final_changed'])                                      # the damage in t1 contradicts healthy
        back = DG.restore_original(guarded, case, raw)
        self.assertEqual(back['decision'], rec['decision'])
        self.assertEqual(back['bad_evidence_refs'], [])                                         # restored through the same resolver
        self.assertEqual(back['refs_to_non_ok_tools'], rec['refs_to_non_ok_tools'])
        self.assertEqual(back['action_audit'].get('audit_version'), 'v2')
        # control: an invented suffix is a bad reference after the round trip as well
        case2 = L.tv_case('qxp-002', evidence=[])
        ts2 = L.suite_with(case2)
        rec2, _ = ev2h.scripted_run(case2, ts2, [tc('decode_sample', {'at': 4}), dec('healthy', 'none', ['t1.nonexistent'])], which=th.NO_BINARIES, evidence_format='v2')
        raw2 = R.resolve_evidence_raw(case2, ts2.root)
        ts2.cleanup()
        back2 = DG.restore_original(DG.apply_to_record(rec2, case2, raw2, 'v3'), case2, raw2)
        self.assertEqual(back2['bad_evidence_refs'], ['t1.nonexistent'])


if __name__ == '__main__':
    unittest.main()
