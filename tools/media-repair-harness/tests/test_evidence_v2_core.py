"""Evidence format v2, part 1: typed findings, the coverage matrix, the client comparison, the guards and the audit proof.

Expected values are written by hand from hand-written observations (independently specified synthetic data), not produced by the implementation and not taken
from any truth label.  Classes are named by area for the W18 report: TypedFindings, CoverageMatrix, ClientComparison, MetamorphicPairs, GuardsV3, AuditV2."""
import json
import unittest

import ev2h
from ev2h import analysis, decode_out, derive_one, obs, probe_out
from media_repair_harness import audit as AU
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2

DAMAGE = '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5'


class TypedFindings(unittest.TestCase):
    def test_status_ok_with_decoder_errors_is_a_defect_and_a_conflict_not_a_clean_result(self):
        d = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE, frames=27), {'at': 4}), 8.0)
        self.assertEqual(d.execution['state'], 'ran')
        self.assertEqual(d.execution['completion'], 'complete')
        self.assertEqual([f['kind'] for f in d.findings], ['decoder_errors'])
        self.assertTrue(d.findings[0]['known_defect'])
        self.assertEqual(d.findings[0]['location'], {'part': 'decode', 'start_s': 4.0, 'end_s': 8.0})
        self.assertEqual(sorted(c['kind'] for c in d.conflicts), ['exit_zero_with_decoder_errors', 'status_ok_with_defect'])
        self.assertEqual(d.integrity, 'damaged')

    def test_clean_window_is_clean_with_its_interval_and_no_finding(self):
        d = derive_one(obs('e1', 'decode_sample', 'ok', decode_out(), {'ss': 0, 't': 4}, source='case'), 8.0)
        self.assertEqual(d.findings, [])
        self.assertEqual(d.integrity, 'clean')
        self.assertEqual(d.intervals, [{'streams': ['unrecorded'], 'start_s': 0.0, 'end_s': 4.0, 'state': 'clean', 'basis': 'observed'}])

    def test_a_collection_failure_is_never_a_defect(self):
        for status, text in (('error', 'ffprobe failed: could not run'), ('timeout', 'decode_sample exceeded the 60 s tool timeout'),
                             ('unavailable', 'no recorded observation of decode_sample at 40 s for this item'), ('error', 'tool crashed: KeyError: x')):
            d = derive_one(obs('t1', 'decode_sample', status, text, {'at': 40}))
            self.assertEqual(d.findings, [], status)
            self.assertEqual(d.conflicts, [], status)
            self.assertNotEqual(d.integrity, 'damaged')
            self.assertEqual(d.execution['status'], status)
            self.assertIn(d.execution['state'], ('failed', 'timed_out', 'unavailable'))
            self.assertTrue(any('settled nothing' in u for u in d.unresolved), status)

    def test_failure_causes_use_the_collectors_vocabulary_and_unknown_stays_unknown(self):
        self.assertEqual(derive_one(obs('t1', 'ffprobe', 'error', 'ffprobe failed: could not run')).execution['cause'], 'tool')
        self.assertEqual(derive_one(obs('t1', 'ffprobe', 'error', 'bad arguments: at must be a number')).execution['cause'], 'tool')
        self.assertEqual(derive_one(obs('t1', 'ffprobe', 'error', 'something nobody has seen before')).execution['cause'], 'unknown')
        live = {'status': 'error', 'cause': 'input', 'reason': 'ffprobe exited 1: the container could not be read', 'coverage': {'verified': [], 'not_verified': ['everything']},
                'output': {}, 'tool': 'probe'}
        d = derive_one(obs('t1', 'ffprobe', 'error', live))
        self.assertEqual(d.execution['cause'], 'input')
        self.assertEqual(d.integrity, 'damaged')   # the collector itself says the INPUT is damaged
        live['cause'] = 'tool'
        d = derive_one(obs('t1', 'ffprobe', 'error', live))
        self.assertEqual(d.execution['cause'], 'tool')
        self.assertEqual(d.findings, [])

    def test_a_nonzero_exit_alone_is_not_corruption(self):
        d = derive_one(obs('e1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': ''}))
        self.assertEqual([(f['kind'], f['known_defect']) for f in d.findings], [('exit_nonzero_unclassified', False)])
        self.assertNotEqual(d.integrity, 'damaged')
        d = derive_one(obs('e1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'unrecognised complaint 42'}))
        self.assertFalse(d.findings[0]['known_defect'])
        self.assertIn('unrecognised complaint 42', d.findings[0]['detail'])   # stays raw

    def test_two_results_that_state_different_durations_contradict_each_other(self):
        a = analysis([obs('e1', 'ffprobe', 'ok', probe_out(duration='8.0')), obs('t1', 'ffprobe', 'ok', probe_out(duration='9.5'))])
        self.assertEqual([c['kind'] for c in a['items']['t1'].conflicts], ['duration_mismatch'])
        self.assertEqual(a['items']['e1'].conflicts, [])
        a = analysis([obs('e1', 'ffprobe', 'ok', probe_out(duration='8.0')), obs('t1', 'ffprobe', 'ok', probe_out(duration='8.4'))])   # within the rounding allowance
        self.assertEqual(a['items']['t1'].conflicts, [])

    def test_a_probe_that_reports_damage_in_its_own_words_is_a_known_defect(self):
        d = derive_one(obs('e1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'moov atom not found\nInvalid data found when processing input'}))
        self.assertEqual([(f['kind'], f['known_defect'], f['location']['part']) for f in d.findings], [('container_damage', True, 'container')])
        self.assertEqual(d.container, 'damaged')
        self.assertEqual(d.execution['cause'], 'input')

    def test_unknown_fields_are_neither_clean_nor_damaged(self):
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'bytes_read': 5}))
        self.assertEqual((d.findings, d.intervals), ([], []))
        self.assertEqual(d.integrity, 'unknown')
        self.assertTrue(any('do not say' in u for u in d.unresolved))
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'exit_code': 0, 'frames': 40}, {'ss': 0, 't': 4}))   # no stderr key at all
        self.assertEqual(d.integrity, 'unknown')
        self.assertEqual(d.intervals, [])

    def test_exit_zero_blank_stderr_but_zero_frames_checked_nothing(self):
        d = derive_one(obs('e1', 'decode_sample', 'ok', decode_out(ss=8, frames=0, out_time=None), {'ss': 8, 't': 4}), 8.046)
        self.assertEqual(d.intervals, [])
        self.assertEqual(d.integrity, 'unknown')
        self.assertTrue(any('no frames' in u for u in d.unresolved))

    def test_quota_and_timeout_prove_nothing_about_the_file(self):
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'bytes_read': 8388608, 'duration_limit_seconds': 4, 'exit_code': 0, 'quota_exhausted': True, 'stderr': ''},
                           {'ss': 0, 't': 4}))
        self.assertEqual((d.findings, d.intervals), ([], []))
        self.assertTrue(any('quota' in u for u in d.unresolved))
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'exit_code': 'timeout', 'stderr': ''}, {'at': 0}))
        self.assertEqual(d.intervals, [])
        self.assertNotEqual(d.integrity, 'damaged')

    def test_full_request_answered_with_a_window_is_a_conflict_and_not_a_completed_decode(self):
        out = {'at_s': 0, 'window_s': 4, 'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '', 'quota_exhausted': False, 'clean': True}
        d = derive_one(obs('t1', 'decode_sample', 'ok', out, {'full': True}), 8.0)
        self.assertEqual([c['kind'] for c in d.conflicts], ['request_not_honored'])
        self.assertIs(d.completed_to_eof, False)
        self.assertEqual(d.scope['requested'], {'window': 'full'})
        self.assertEqual(d.intervals[0]['end_s'], 4.0)
        self.assertTrue(any('whole file was not decoded' in u for u in d.unresolved))

    def test_a_recorded_full_decode_completes_only_on_a_decoded_span_that_reaches_the_known_duration(self):
        full = {'window_s': 'full', 'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': ''}
        d = derive_one(obs('e1', 'decode_sample', 'ok', full, {'full': True}, source='case'), 8.046)
        self.assertIs(d.completed_to_eof, True)
        self.assertEqual(d.intervals[0]['basis'], 'full_decode')
        d = derive_one(obs('e1', 'decode_sample', 'ok', dict(full, out_time='00:00:03.000000'), {'full': True}, source='case'), 8.046)
        self.assertIs(d.completed_to_eof, False)
        self.assertIn('decoded_span_shorter_than_duration', [c['kind'] for c in d.conflicts])
        d = derive_one(obs('e1', 'decode_sample', 'ok', dict(full, exit_code=1), {'full': True}, source='case'), 8.046)
        self.assertIs(d.completed_to_eof, False)
        # unknown duration: completion is unknown, never assumed (Astra 3, Opus 3)
        d = derive_one(obs('e1', 'decode_sample', 'ok', full, {'full': True}, source='case'), None)
        self.assertIsNone(d.completed_to_eof)
        # no decoded span: unknown
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'window_s': 'full', 'exit_code': 0, 'stderr': '', 'frames': 5}, {'full': True}, source='case'), 8.0)
        self.assertIsNone(d.completed_to_eof)
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'window_s': 'full', 'frames': 5, 'stderr': ''}, {'full': True}, source='case'), 8.0)   # no exit code recorded
        self.assertIsNone(d.completed_to_eof)

    def test_a_full_request_with_a_result_that_does_not_say_it_is_full_proves_nothing(self):
        """Astra 3 counterexample: full:true plus exit 0, empty stderr and selected streams, with no decoded span or EOF observation."""
        out = {'exit_code': 0, 'stderr': '', 'streams_selected': ['0:v:0', '0:a:0']}
        d = derive_one(obs('t1', 'decode_sample', 'ok', out, {'full': True}), 8.0)
        self.assertIsNone(d.completed_to_eof)
        self.assertEqual(d.intervals, [])
        self.assertEqual(d.integrity, 'unknown')
        # the same, as a tool's own `completed_to_eof: true` claim over a 10 s span of a 100 s file (Opus 3): the claim is checked and refused
        claim = {'window_s': 'full', 'exit_code': 0, 'frames': 250, 'out_time': '00:00:10.000000', 'stderr': '', 'completed_to_eof': True, 'streams_selected': ['0:v:0', '0:a:0']}
        d = derive_one(obs('t1', 'decode_sample', 'ok', claim, {'full': True}), 100.0)
        self.assertIs(d.completed_to_eof, False)
        d = derive_one(obs('t1', 'decode_sample', 'ok', claim, {'full': True}), None)
        self.assertIsNone(d.completed_to_eof)
        self.assertTrue(any('not shown to check it' in u for u in d.unresolved))

    def test_replay_serving_a_different_window_is_a_stated_conflict(self):
        out = decode_out(ss=4, frames=27, requested_at_s=6.0, note_window='replay serves the recorded window at ss=4 (recorded: [0, 4, 8])')
        d = derive_one(obs('t1', 'decode_sample', 'ok', out, {'at': 9}), 12.0)
        self.assertEqual([c['kind'] for c in d.conflicts], ['request_not_honored'])
        d = derive_one(obs('t1', 'decode_sample', 'ok', out, {'at': 6}), 12.0)   # 6 s falls inside the 4 s window served from 4 s: honored
        self.assertEqual(d.conflicts, [])

    def test_presentation_truncation_is_separate_from_collection_and_media_sampling(self):
        d = derive_one(obs('t1', 'arr_lookup', 'ok', {'a': 1}, truncated=True))
        self.assertTrue(d.execution['output_truncated'])
        self.assertEqual(d.execution['completion'], 'complete')
        self.assertTrue(any('cut before it reached the model' in u for u in d.unresolved))
        d = derive_one(obs('t1', 'decode_sample', 'partial', 'x ...[output cut off]', {'at': 0}))
        self.assertEqual((d.execution['state'], d.execution['completion'], d.execution['output_truncated']), ('ran', 'partial', False))

    def test_every_derived_fact_keeps_its_source_id(self):
        d = derive_one(obs('t7', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4}), 8.0)
        self.assertTrue(all(f['src'] == 't7' for f in d.findings))
        self.assertTrue(all(c['src'] == 't7' for c in d.conflicts))
        self.assertTrue(all(f['id'].startswith('t7.') for f in d.findings + d.conflicts))

    def test_epub_stage_matrix_follows_the_inspectors_own_stage_order(self):
        d = derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 9, 'entries': 7, 'error': 'ParseError: x', 'stage': 'opf_parse', 'status': 'error'}))
        self.assertEqual(d.package, {'zip_open': 'clean', 'zip_crc': 'clean', 'opf_parse': 'damaged', 'manifest': 'not_checked', 'spine': 'not_checked'})
        self.assertEqual([(f['kind'], f['location']['stage']) for f in d.findings], [('package_damage', 'opf_parse')])
        d = derive_one(obs('e1', 'epub_inspect', 'error', {'bytes': 9, 'error': 'weird', 'stage': 'brand_new_stage', 'status': 'error'}))
        self.assertEqual(set(d.package.values()), {'unknown'})
        self.assertFalse(d.findings[0]['known_defect'])
        d = derive_one(obs('e1', 'epub_inspect', 'ok', {'status': 'ok', 'bytes': 9, 'entries': 7, 'spine_items': 3, 'spine_heads': ['a b', 'c d'], 'dc_title': ['T']}))
        self.assertEqual(set(d.package.values()), {'clean'})
        self.assertTrue(any('only the first 2 of 3 spine items' in u for u in d.unresolved))

    def test_probe_facts_use_units_and_state_unknowns(self):
        d = derive_one(obs('e1', 'ffprobe', 'ok', probe_out(duration='8.046', chapters=[{'start': '0.000000', 'end': '2.000000', 'title': 'A'}])))
        self.assertEqual(d.duration_s, 8.046)
        self.assertEqual(d.facts['duration_s'], 8.046)
        self.assertEqual(d.facts['size_bytes'], 1000)
        self.assertEqual(d.facts['streams'][0]['bit_depth'], 8)
        self.assertEqual(d.facts['chapters'], [{'start_s': 0.0, 'end_s': 2.0, 'title': 'A'}])
        d = derive_one(obs('e1', 'ffprobe', 'ok', probe_out(duration=None)))
        self.assertIn('the container duration is not stated', d.unresolved)
        self.assertNotIn('duration_s', d.facts)


class CoverageMatrix(unittest.TestCase):
    def cov(self, *os_, ctx=None):
        return analysis(list(os_), ctx)['coverage']

    def win(self, i, a, b, state='clean', stream_sel=None):
        out = decode_out(ss=a, t=b - a, out_time='00:00:%06.3f' % (b - a), frames=10, stderr=DAMAGE if state == 'damaged' else '')
        if stream_sel:
            out['streams_selected'] = stream_sel
        return obs(i, 'decode_sample', 'ok', out, {'at': a})

    def test_overlapping_adjacent_and_duplicate_windows_are_a_union_per_stream(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        c = self.cov(p, self.win('t1', 0, 4), self.win('t2', 2, 6), self.win('t3', 4, 8), self.win('t4', 4, 8))
        row = c['time']['unrecorded']
        self.assertEqual(row['clean'], [[0.0, 8.0]])
        self.assertEqual(row['not_checked'], [])
        self.assertEqual(row['checked_fraction'], 1.0)        # the union, not 4+4+4+4 = 2.0
        c = self.cov(p, self.win('t1', 0, 3), self.win('t2', 3, 6))   # adjacent merges
        self.assertEqual(c['time']['unrecorded']['clean'], [[0.0, 6.0]])
        self.assertEqual(c['time']['unrecorded']['not_checked'], [[6.0, 8.0]])
        c = self.cov(p, self.win('t1', 0, 2), self.win('t2', 5, 7))   # a gap stays a gap
        self.assertEqual(c['time']['unrecorded']['clean'], [[0.0, 2.0], [5.0, 7.0]])
        self.assertEqual(c['time']['unrecorded']['not_checked'], [[2.0, 5.0], [7.0, 8.0]])

    def test_streams_are_separate_by_their_stated_selection(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']), self.win('t2', 4, 8, stream_sel=['0:a:0']))
        self.assertEqual(sorted(c['time']), ['0:a:0', '0:v:0'])
        self.assertEqual(c['time']['0:v:0']['clean'], [[0.0, 4.0]])
        self.assertEqual(c['time']['0:a:0']['clean'], [[4.0, 8.0]])
        self.assertEqual(c['time']['0:v:0']['selection'], 'recorded')
        c = self.cov(p, self.win('t1', 0, 4), self.win('t2', 4, 8, stream_sel=['0:a:0']))   # an unrecorded selection is its own key
        self.assertEqual(sorted(c['time']), ['0:a:0', 'unrecorded'])
        # a window that names both streams counts for each of them; a later audio-only window adds to the audio row only
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0', '0:a:0']), self.win('t2', 4, 8, stream_sel=['0:a:0']))
        self.assertEqual(c['time']['0:v:0']['clean'], [[0.0, 4.0]])
        self.assertEqual(c['time']['0:a:0']['clean'], [[0.0, 8.0]])
        self.assertEqual(c['time']['0:v:0']['not_checked'], [[4.0, 8.0]])

    def test_unknown_duration_stays_unknown_and_is_not_invented(self):
        c = self.cov(self.win('t1', 0, 4))
        self.assertEqual(c['duration_s'], 'unknown')
        self.assertEqual(c['time']['unrecorded']['not_checked'], 'unknown')
        self.assertNotIn('checked_fraction', c['time']['unrecorded'])

    def test_windows_are_clipped_to_the_known_duration(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='6'))
        c = self.cov(p, self.win('t1', 4, 8))
        self.assertEqual(c['time']['unrecorded']['clean'], [[4.0, 6.0]])
        self.assertEqual(c['time']['unrecorded']['checked_fraction'], round(2 / 6, 3))

    def test_short_completion_and_timeout_cover_nothing(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        short = obs('t1', 'decode_sample', 'ok', decode_out(ss=8, frames=0, out_time=None), {'at': 8})
        timeout = obs('t2', 'decode_sample', 'ok', {'exit_code': 'timeout', 'stderr': ''}, {'at': 0})
        c = self.cov(p, short, timeout)
        self.assertEqual(c['time'], {'state': 'not_checked'})

    def test_clean_plus_damaged_in_both_orders_keeps_the_damage(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        clean, bad = self.win('t1', 0, 8), self.win('t2', 2, 4, 'damaged')
        a = self.cov(p, clean, bad)['time']['unrecorded']
        b = self.cov(p, bad, clean)['time']['unrecorded']
        self.assertEqual(a['damaged'], [[2.0, 4.0]])
        self.assertEqual(a['clean'], [[0.0, 2.0], [4.0, 8.0]])
        self.assertEqual({k: a[k] for k in ('damaged', 'clean', 'not_checked')}, {k: b[k] for k in ('damaged', 'clean', 'not_checked')})

    def test_adding_a_clean_observation_never_erases_unresolved_damage(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        bad = self.win('t1', 0, 4, 'damaged')
        before = self.cov(p, bad)['time']['unrecorded']['damaged']
        for extra in (self.win('t2', 0, 4), self.win('t3', 0, 8), self.win('t4', 1, 3)):
            self.assertEqual(self.cov(p, bad, extra)['time']['unrecorded']['damaged'], before)

    def test_order_independence_of_the_whole_matrix(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='9', chapters=[{'start': '0', 'end': '4.5', 'title': 'A'}, {'start': '4.5', 'end': '9', 'title': 'B'}]))
        ws = [self.win('t1', 0, 3), self.win('t2', 2, 5, 'damaged'), self.win('t3', 6, 9), self.win('t4', 0, 3)]
        base = json.dumps(self.cov(p, *ws, ctx=None)['time'], sort_keys=True)
        import itertools
        for perm in itertools.permutations(ws):
            self.assertEqual(json.dumps(self.cov(p, *perm)['time'], sort_keys=True), base)

    def test_chapters_get_a_state_from_the_windows_that_overlap_them(self):
        ch = [{'start': '0', 'end': '4', 'title': 'A'}, {'start': '4', 'end': '8', 'title': 'B'}, {'start': '8', 'end': '12', 'title': 'C'}, {'start': '12', 'end': '16', 'title': 'D'}]
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='16', chapters=ch))
        c = self.cov(p, self.win('t1', 0, 4), self.win('t2', 4, 6), self.win('t3', 9, 10, 'damaged'))
        states = {r['title']: r['by_stream'] for r in c['chapters']}
        self.assertEqual({t: v['unrecorded'] for t, v in states.items()}, {'A': 'clean', 'B': 'partly_checked', 'C': 'damaged', 'D': 'not_checked'})
        self.assertEqual({v['0:v:0'] for v in states.values()}, {'unknown'})     # the container's streams: which of them the unnamed windows covered is not recorded
        self.assertTrue(all('decode' not in r for r in c['chapters']))    # no combined label without a scope

    def test_chapter_coverage_is_per_stream_a_video_only_decode_leaves_the_audio_unchecked(self):
        """Astra 8 counterexample."""
        ch = [{'start': '0', 'end': '4', 'title': 'A'}, {'start': '4', 'end': '8', 'title': 'B'}]
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8', chapters=ch))
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']))
        rows = {r['title']: r['by_stream'] for r in c['chapters']}
        self.assertEqual(rows['A'], {'0:a:0': 'not_checked', '0:v:0': 'clean'})
        self.assertEqual(rows['B'], {'0:a:0': 'not_checked', '0:v:0': 'not_checked'})
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']), self.win('t2', 4, 8))        # an unrecorded window: the other stream is unknown, not unchecked
        self.assertEqual({r['title']: r['by_stream']['0:a:0'] for r in c['chapters']}, {'A': 'unknown', 'B': 'unknown'})
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']), self.win('t2', 0, 4, 'damaged', stream_sel=['0:a:0']))
        self.assertEqual({r['title']: r['by_stream'] for r in c['chapters']}['A'], {'0:a:0': 'damaged', '0:v:0': 'clean'})

    def test_streams_list_says_unknown_when_the_selection_is_not_recorded(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        c = self.cov(p, self.win('t1', 0, 4))
        self.assertEqual([r['decode'] for r in c['streams']], ['unknown', 'unknown'])
        c = self.cov(p)
        self.assertEqual([r['decode'] for r in c['streams']], ['not_checked', 'not_checked'])
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0', '0:a:0']))
        self.assertEqual([r['decode'] for r in c['streams']], ['checked_in_windows', 'checked_in_windows'])
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']))
        self.assertEqual([r['decode'] for r in c['streams']], ['checked_in_windows', 'not_checked'])
        c = self.cov(p, self.win('t1', 0, 4, stream_sel=['0:v:0']), self.win('t2', 4, 8))   # an unrecorded window leaves the other stream unknown, not unchecked
        self.assertEqual([r['decode'] for r in c['streams']], ['checked_in_windows', 'unknown'])

    def test_container_and_package_rows(self):
        self.assertEqual(self.cov()['container'], {'state': 'not_checked'})
        c = self.cov(obs('e1', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'moov atom not found'}))
        self.assertEqual(c['container']['state'], 'damaged')
        c = self.cov(obs('e1', 'ffprobe', 'error', 'ffprobe failed: could not run'))
        self.assertEqual(c['container']['state'], 'unknown')
        c = self.cov(obs('e1', 'epub_inspect', 'error', {'stage': 'zip_crc', 'error': 'bad', 'status': 'error'}))
        self.assertEqual(c['package']['stages']['zip_open'], 'clean')
        self.assertEqual(c['package']['stages']['zip_crc'], 'damaged')

    def test_probe_ok_with_stderr_text_is_not_called_clean(self):
        c = self.cov(obs('e1', 'ffprobe', 'ok', probe_out(stderr='some warning nobody classified')))
        self.assertEqual(c['container']['state'], 'unknown')


PROFILE = {'definition': 'defined test profile', 'containers': ['matroska,webm', 'mp4'], 'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac, up to 2 channels',
           'subtitles': 'disabled'}


def streams(vcodec='h264', pix='yuv420p', h=1080, w=1920, acodec='aac', ch=2, extra=()):
    return [{'index': 0, 'codec_type': 'video', 'codec_name': vcodec, 'pix_fmt': pix, 'width': w, 'height': h},
            {'index': 1, 'codec_type': 'audio', 'codec_name': acodec, 'channels': ch}] + list(extra)


class ClientComparison(unittest.TestCase):
    def compare(self, profile, **kw):
        fmt = kw.pop('fmt', 'matroska,webm')
        given = kw.pop('streams', None)
        a = analysis([obs('e1', 'ffprobe', 'ok', probe_out(fmt=fmt, streams=given if given is not None else streams(**kw)))], {'expected': {'client_profile': profile}} if profile else {})
        return a['client']

    def verdicts(self, client):
        return {r['field']: r['verdict'] for r in client['rows']}

    def test_prose_profile_is_read_by_its_fixed_grammar(self):
        v = self.verdicts(self.compare(PROFILE))
        self.assertEqual(v, {'container': 'supported', 'video_codec': 'supported', 'video_bit_depth': 'supported', 'video_pix_fmt': 'supported', 'video_height_px': 'supported',
                             'audio_codec': 'supported', 'audio_channels': 'supported'})

    def test_each_field_flips_on_its_own_and_incompatibility_is_not_damage(self):
        base = self.verdicts(self.compare(PROFILE))
        for kw, field in (({'vcodec': 'hevc'}, 'video_codec'), ({'pix': 'yuv420p10le'}, 'video_bit_depth'), ({'h': 2160}, 'video_height_px'), ({'acodec': 'eac3'}, 'audio_codec'),
                          ({'ch': 6}, 'audio_channels'), ({'fmt': 'avi'}, 'container')):
            c = self.compare(PROFILE, **kw)
            v = self.verdicts(c)
            self.assertEqual(v[field], 'unsupported', field)
            self.assertEqual({k: x for k, x in v.items() if k != field and not (field == 'video_codec' and k == 'video_bit_depth') and not (field == 'video_bit_depth' and k == 'video_pix_fmt')},
                             {k: x for k, x in base.items() if k != field and not (field == 'video_codec' and k == 'video_bit_depth') and not (field == 'video_bit_depth' and k == 'video_pix_fmt')}, field)
            self.assertNotIn('damage', json.dumps(c['summary']).replace('not damage', ''))
            self.assertEqual(c['summary']['unsupported'] >= 1, True)

    def test_a_ten_bit_profile_accepts_ten_bit_and_the_media_is_unchanged(self):
        wide = dict(PROFILE, video='h264 (8-bit or 10-bit) or hevc (8-bit or 10-bit), up to 1080p', audio='aac, ac3 or eac3, up to 6 channels')
        narrow = PROFILE
        v_wide = self.verdicts(self.compare(wide, vcodec='hevc', pix='yuv420p10le', acodec='eac3', ch=6))
        v_narrow = self.verdicts(self.compare(narrow, vcodec='hevc', pix='yuv420p10le', acodec='eac3', ch=6))
        self.assertTrue(all(x == 'supported' for x in v_wide.values()), v_wide)
        self.assertEqual(v_narrow['video_codec'], 'unsupported')
        self.assertEqual(v_narrow['audio_channels'], 'unsupported')

    def test_structured_profile(self):
        prof = {'containers': ['matroska,webm'], 'video_codec': 'h264', 'video_pix_fmt': 'yuv420p', 'max_width': 1920, 'max_height': 1080, 'audio_codecs': ['aac'], 'max_audio_channels': 2}
        v = self.verdicts(self.compare(prof, acodec='eac3', ch=6))
        self.assertEqual((v['audio_codec'], v['audio_channels'], v['video_codec']), ('unsupported', 'unsupported', 'supported'))

    def test_missing_stream_fields_are_unknown_not_inferred(self):
        v = self.verdicts(self.compare(PROFILE, streams=[{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac'}]))
        self.assertEqual(v['video_pix_fmt'], 'unknown')
        self.assertEqual(v['video_height_px'], 'unknown')
        self.assertEqual(v['audio_channels'], 'unknown')
        self.assertEqual(v['video_codec'], 'supported')
        c = self.compare(PROFILE, streams=[{'index': 0, 'codec_type': 'video'}, {'index': 1, 'codec_type': 'audio'}])
        self.assertEqual(self.verdicts(c)['video_codec'], 'unknown')
        self.assertFalse(c['summary']['complete'])

    def test_an_ambiguous_selection_cannot_support_an_overall_claim(self):
        c = self.compare(PROFILE, streams=streams(extra=[{'index': 2, 'codec_type': 'audio', 'codec_name': 'ac3', 'channels': 6}]))
        self.assertEqual(c['selection']['audio']['how'], 'ambiguous')
        self.assertEqual(c['selection']['audio']['streams'], [1, 2])
        self.assertEqual(c['summary']['selection'], 'ambiguous')
        self.assertFalse(c['summary']['complete'])
        self.assertEqual(sorted({r['stream'] for r in c['rows'] if r['field'].startswith('audio')}), [1, 2])   # every candidate is shown, none is picked

    def test_no_stated_client_means_no_comparison_and_none_is_inferred(self):
        self.assertIsNone(self.compare(None))
        a = analysis([obs('e1', 'ffprobe', 'ok', probe_out(streams=streams(vcodec='hevc', acodec='eac3', ch=8)))], {'title': 'a living-room TV client'})
        self.assertIsNone(a['client'])

    def test_profile_fields_that_are_not_read_are_listed_not_ignored(self):
        c = self.compare(dict(PROFILE, hdr='hdr10 only'))
        self.assertEqual(c['not_compared'], ['hdr'])
        c = self.compare({'containers': ['mp4'], 'video': 'something unusual', 'audio': 'whatever'})
        self.assertTrue(any(x.startswith('video: statement not read') for x in c['not_compared']))
        self.assertTrue(any(x.startswith('audio: statement not read') for x in c['not_compared']))
        self.assertFalse(c['summary']['complete'])

    def test_comparison_needs_stream_facts_first(self):
        a = analysis([obs('e1', 'arr_lookup', 'ok', {'a': 1})], {'client_profile': PROFILE})
        self.assertEqual(a['client']['summary']['complete'], False)
        self.assertEqual(a['client']['rows'], [])

    def test_recorded_selection_shape(self):
        out = {'streams': {'container': 'matroska,webm', 'selected_audio': {'channels': 6, 'codec_name': 'eac3', 'codec_type': 'audio'},
                           'video': {'codec_name': 'h264', 'codec_type': 'video', 'height': 1080, 'pix_fmt': 'yuv420p', 'width': 1920}}}
        a = analysis([obs('e1', 'ffprobe', 'ok', out, source='case')], {'client_profile': {'containers': ['matroska,webm'], 'video_codec': 'h264', 'audio_codecs': ['aac'],
                                                                                                 'max_audio_channels': 2}})
        self.assertEqual(a['client']['selection']['audio']['how'], 'recorded')
        self.assertEqual(self.verdicts(a['client'])['audio_codec'], 'unsupported')


class MetamorphicPairs(unittest.TestCase):
    """Pairs that change one thing and hold the rest, so no filename, title, id or duration can be what decides a derived fact."""

    def key(self, derived):
        return json.dumps({'findings': [{k: f[k] for k in ('kind', 'known_defect', 'location')} for f in derived.findings], 'int': derived.integrity,
                           'iv': [{k: v for k, v in i.items()} for i in derived.intervals], 'conf': [c['kind'] for c in derived.conflicts]}, sort_keys=True)

    def test_status_and_damage_vary_independently(self):
        rows = {}
        for status in ('ok', 'partial', 'error'):
            for stderr in ('', DAMAGE):
                d = derive_one(obs('t1', 'decode_sample', status, decode_out(stderr=stderr, frames=40), {'at': 0}), 8.0)
                rows[(status, bool(stderr))] = (d.integrity, bool(d.findings))
        # the defect follows the stderr text, whatever the status word says
        for status in ('ok', 'partial', 'error'):
            self.assertEqual(rows[(status, True)], ('damaged', True), status)
            self.assertEqual(rows[(status, False)][1], False, status)

    def test_scaling_the_fixture_duration_does_not_change_the_states(self):
        for scale in (1, 10, 100):
            p = obs('e1', 'ffprobe', 'ok', probe_out(duration=str(8 * scale)))
            w = obs('t1', 'decode_sample', 'ok', decode_out(ss=0, t=4 * scale, out_time='00:%02d:%02d.000000' % ((4 * scale) // 60, (4 * scale) % 60)), {'at': 0})
            row = analysis([p, w])['coverage']['time']['unrecorded']
            self.assertEqual(row['clean'], [[0.0, 4.0 * scale]])
            self.assertEqual(row['checked_fraction'], 0.5)

    def test_renaming_the_file_title_and_ids_changes_no_derived_fact(self):
        base = None
        for name, tid in (('a.mkv', 't1'), ('Totally Different Name S09E99.mkv', 't1'), ('zzz.mp4', 't1')):
            o = obs(tid, 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4})
            k = self.key(derive_one(o, 8.0))
            base = base or k
            self.assertEqual(k, base)
        a = self.key(derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4}), 8.0))
        b = self.key(derive_one(obs('t99', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4}), 8.0))
        self.assertEqual(a, b)

    def test_removing_a_field_turns_a_fact_into_unknown_never_into_clean_or_damaged(self):
        full = decode_out()
        for drop in ('exit_code', 'stderr'):
            partial = {k: v for k, v in full.items() if k != drop}
            d = derive_one(obs('e1', 'decode_sample', 'ok', partial, {'ss': 0, 't': 4}), 8.0)
            self.assertEqual(d.integrity, 'unknown', drop)
            self.assertEqual(d.findings, [], drop)

    def test_client_capability_varies_with_the_media_held_fixed(self):
        out = probe_out(streams=streams(vcodec='hevc', pix='yuv420p10le', acodec='eac3', ch=6))
        first = analysis([obs('e1', 'ffprobe', 'ok', out)], {'client_profile': PROFILE})
        second = analysis([obs('e1', 'ffprobe', 'ok', out)], {'client_profile': dict(PROFILE, video='hevc (10-bit), up to 4000p', audio='eac3, up to 8 channels')})
        v1 = {r['field']: r['verdict'] for r in first['client']['rows']}
        v2 = {r['field']: r['verdict'] for r in second['client']['rows']}
        self.assertEqual(v1['video_codec'], 'unsupported')
        self.assertEqual(v2['video_codec'], 'supported')
        self.assertEqual(v2['audio_channels'], 'supported')
        self.assertEqual(first['items']['e1'].facts, second['items']['e1'].facts)   # the evidence about the media did not move
        self.assertEqual(first['coverage'], second['coverage'])


class GuardsV3(unittest.TestCase):
    def healthy(self):
        return {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['e1'], 'reason': 'r'}

    def shown(self, *evs):
        return [{'id': i, 'tool': t, 'args': a, 'status': s, 'output': json.dumps(o) if not isinstance(o, str) else o} for i, t, s, o, a in evs]

    def test_an_ok_integrity_result_that_reports_a_defect_does_not_count_as_clean(self):
        shown = self.shown(('e1', 'decode_sample', 'ok', decode_out(stderr=DAMAGE, frames=27), {'ss': 0, 't': 4}))
        self.assertIsNone(DG.check_healthy(self.healthy(), shown, []))          # v1/v2: a presence check, unchanged
        reason = DG.check_healthy_v3(self.healthy(), shown, [])
        self.assertIn('decoder_errors', reason)
        self.assertIn('e1', reason)

    def test_a_defect_contradicts_healthy_even_next_to_clean_observations_in_either_order(self):
        clean = ('e1', 'ffprobe', 'ok', probe_out(), {})
        clean2 = ('e3', 'decode_sample', 'ok', decode_out(), {'ss': 0, 't': 4})
        bad = ('e2', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'ss': 4, 't': 4})
        for order in ((clean, clean2, bad), (bad, clean, clean2), (clean, bad, clean2)):
            self.assertIn('decoder_errors', DG.check_healthy_v3(self.healthy(), self.shown(*order), []))

    def test_a_damage_report_in_an_error_result_also_contradicts_healthy(self):
        shown = self.shown(('e1', 'ffprobe', 'ok', probe_out(), {}), ('e2', 'epub_inspect', 'error', {'stage': 'zip_crc', 'error': 'bad member', 'status': 'error'}, {}))
        self.assertIn('package_damage', DG.check_healthy_v3(self.healthy(), shown, []))

    def test_clean_results_pass_and_unknown_fields_support_nothing(self):
        self.assertIsNone(DG.check_healthy_v3(self.healthy(), self.shown(('e1', 'ffprobe', 'ok', probe_out(), {}), ('e2', 'decode_sample', 'ok', decode_out(), {'ss': 0, 't': 4})), []))
        unknown = self.shown(('e1', 'decode_sample', 'ok', {'bytes_read': 5}, {'ss': 0}))
        self.assertIn('no clean integrity result', DG.check_healthy_v3(self.healthy(), unknown, []))
        self.assertIsNone(DG.check_healthy(self.healthy(), unknown, []))   # the legacy presence check let it through

    def test_unclassified_errors_and_collection_failures_are_not_defects(self):
        shown = self.shown(('e1', 'ffprobe', 'ok', probe_out(), {}), ('e2', 'decode_sample', 'error', 'decode_sample failed: could not run', {}),
                           ('e3', 'ffprobe', 'error', {'exit_code': 1, 'stderr': 'unrecognised complaint'}, {}))
        self.assertIsNone(DG.check_healthy_v3(self.healthy(), shown, []))

    def test_tool_results_count_like_evidence_and_a_page_fetch_is_not_an_observation(self):
        calls = [{'id': 't1', 'tool': 'decode_sample', 'args': {'at': 4}, 'status': 'ok', 'output': json.dumps(decode_out(ss=4, stderr=DAMAGE)), 'mode': 'replay'},
                 {'id': 't2', 'tool': 'page', 'args': {}, 'status': 'ok', 'output': 'x', 'continuation': True}]
        self.assertIn('decoder_errors', DG.check_healthy_v3(self.healthy(), self.shown(('e1', 'ffprobe', 'ok', probe_out(), {})), calls))
        self.assertEqual([o['id'] for o in DG.shown_observations([], calls)], ['t1'])

    def test_only_healthy_none_is_touched_and_the_original_decision_is_kept(self):
        shown = self.shown(('e1', 'decode_sample', 'ok', decode_out(stderr=DAMAGE), {'ss': 0, 't': 4}))
        d = dict(self.healthy(), **{'class': 'corrupt_file', 'action': 'escalate'})
        self.assertIsNone(DG.check_healthy_v3(d, shown, []))
        final, rec = DG.apply({'context': {}, 'evidence': shown}, self.healthy(), [], shown, 'v4', version='v3')
        self.assertEqual((final['class'], final['action']), ('insufficient_evidence', 'escalate'))
        self.assertEqual(rec['applied'][0]['original'], self.healthy())
        self.assertEqual(rec['version'], 'v3')
        self.assertIn('guard G-healthy', final['reason'])

    def test_a_guard_can_only_abstain(self):
        shown = self.shown(('e1', 'decode_sample', 'ok', decode_out(stderr=DAMAGE), {'ss': 0, 't': 4}))
        final, rec = DG.apply({'context': {}, 'evidence': shown}, self.healthy(), [], shown, 'v4', version='v3')
        self.assertEqual((final['class'], final['action'], final['target']), ('insufficient_evidence', 'escalate', None))
        for v in ('v1', 'v2'):   # v1 and v2 stay unchanged
            final, rec = DG.apply({'context': {}, 'evidence': shown}, self.healthy(), [], shown, 'v4', version=v)
            self.assertEqual(final['class'], 'healthy')
            self.assertFalse(rec['final_changed'])

    def test_v3_keeps_the_v2_write_relaxations(self):
        case = {'context': {'arr': {'app': 'radarr', 'ids': {}}, 'client_profile': {'x': 1}, 'filename': 'a.mkv'}, 'evidence': []}
        d = {'type': 'decision', 'class': 'decoder_incompatible', 'action': 'convert', 'target': 'a.mkv', 'confidence': 0.8, 'evidence_refs': ['t1'], 'reason': 'r',
             'audit': {'target': 'a.mkv', 'preconditions': ['p'], 'readback': 'r', 'verify': 'v'}}
        calls = [{'id': 't1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': 'x'}]
        self.assertIn('full_decode_ok', DG.check_write(case, d, calls, 'v4', version='v1') or '')
        self.assertNotIn('full_decode_ok', DG.check_write(case, d, calls, 'v4', version='v3') or '')


class AuditV2(unittest.TestCase):
    def convert_case(self, evidence):
        case = ev2h.case_with(evidence=evidence, tools=('ffprobe', 'decode_sample'),
                              context={'title': 'T', 'filename': 'a.mkv', 'expected': {}, 'arr': {'app': 'radarr', 'ids': {}}, 'client_profile': {'x': 1}, 'notes_for_model': 'n'})
        return case

    def decision(self):
        return {'type': 'decision', 'class': 'decoder_incompatible', 'action': 'convert', 'target': 'a.mkv', 'confidence': 0.8, 'evidence_refs': ['e1', 'e2'], 'reason': 'r',
                'audit': {'target': 'a.mkv', 'preconditions': ['p'], 'readback': 'r', 'verify': 'v'}}

    def met(self, evidence, version):
        case = self.convert_case(evidence)
        a = AU.compute(case, self.decision(), [], prompt_version='v4', audit_version=version, shown=[ev2h.ev(**{'i': e['id'], 'tool': e['tool'], 'status': e['status'], 'output': e['output'], 'args': e['args']}) for e in evidence])
        return {c['id']: c['met'] for c in a['preconditions']}['full_decode_ok'], a

    def test_a_requested_full_decode_answered_with_a_clean_window_is_not_met_under_v2(self):
        window = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True},
                  'output': json.dumps({'at_s': 0, 'window_s': 4, 'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '', 'clean': True})}
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration='8'))}
        met_v1, _ = self.met([probe, window], 'v1')
        met_v2, a = self.met([probe, window], 'v2')
        self.assertTrue(met_v1)          # the bug, kept under the legacy version: the requested arguments were enough
        self.assertFalse(met_v2)
        self.assertEqual(a['audit_version'], 'v2')

    def test_observed_completion_with_a_clean_result_is_met(self):
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration='8.046'))}
        full = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True},
                'output': json.dumps({'window_s': 'full', 'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': '', 'streams_selected': ['0:v:0', '0:a:0']})}
        met, a = self.met([probe, full], 'v2')
        self.assertTrue(met)
        self.assertTrue([c for c in a['preconditions'] if c['id'] == 'full_decode_ok'][0]['met'])

    def test_completion_and_a_clean_result_without_a_recorded_stream_scope_is_not_met(self):
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration='8.046'))}
        full = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True}, 'output': json.dumps({'window_s': 'full', 'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': ''})}
        met, a = self.met([probe, full], 'v2')
        self.assertFalse(met)
        detail = [c for c in a['preconditions'] if c['id'] == 'full_decode_ok'][0]['detail']
        self.assertIn('which streams were decoded is not recorded', detail)

    def test_a_full_decode_with_errors_or_without_completion_proof_is_not_met(self):
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration='8.046'))}
        bad = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True}, 'output': json.dumps({'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': DAMAGE})}
        short = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True}, 'output': json.dumps({'exit_code': 0, 'frames': 10, 'out_time': '00:00:02.000000', 'stderr': ''})}
        noexit = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True}, 'output': json.dumps({'frames': 10, 'stderr': ''})}
        for e in (bad, short, noexit):
            self.assertFalse(self.met([probe, e], 'v2')[0])

    def test_partial_status_is_not_a_proof(self):
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration='8.046'))}
        part = {'id': 'e2', 'tool': 'decode_sample', 'status': 'partial', 'args': {'full': True}, 'output': json.dumps({'exit_code': 0, 'frames': 67, 'out_time': '00:00:08.000000', 'stderr': ''})}
        self.assertFalse(self.met([probe, part], 'v2')[0])

    def test_version_one_audit_gets_no_new_key(self):
        _, a = self.met([], 'v1')
        self.assertNotIn('audit_version', a)


class UnknownStaysUnknown(unittest.TestCase):
    """Astra 1 and Opus 2, as synthetic pairs: each counterexample next to its control."""

    def test_unrecognised_decoder_text_is_not_a_defect_and_not_clean(self):
        for text in ('Decoder not found', '[in#0/matroska,webm @ 0x0] Unknown-sized element at 0x0 inside parent with finite size', 'something nobody has seen'):
            d = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=4, stderr=text), {'at': 4}), 8.0)
            self.assertEqual([(f['kind'], f['known_defect']) for f in d.findings], [('decoder_messages_unclassified', False)], text)
            self.assertEqual(d.conflicts, [], text)
            self.assertEqual(d.integrity, 'unknown', text)
            self.assertEqual([i['state'] for i in d.intervals], ['unclassified'], text)
        control = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=4, stderr=DAMAGE), {'at': 4}), 8.0)
        self.assertEqual((control.integrity, control.findings[0]['known_defect']), ('damaged', True))
        clean = derive_one(obs('t1', 'decode_sample', 'ok', decode_out(ss=4), {'at': 4}), 8.0)
        self.assertEqual(clean.integrity, 'clean')

    def test_an_unclassified_window_is_neither_clean_nor_damaged_in_the_matrix_and_never_erases_damage(self):
        p = obs('e1', 'ffprobe', 'ok', probe_out(duration='8'))
        clean = obs('t1', 'decode_sample', 'ok', decode_out(ss=0, t=8, out_time='00:00:08.000000'), {'at': 0})
        odd = obs('t2', 'decode_sample', 'ok', decode_out(ss=2, t=4, stderr='Decoder not found'), {'at': 2})
        bad = obs('t3', 'decode_sample', 'ok', decode_out(ss=3, t=2, stderr=DAMAGE, out_time='00:00:02.000000'), {'at': 3})
        row = analysis([p, clean, odd, bad])['coverage']['time']['unrecorded']
        self.assertEqual(row['damaged'], [[3.0, 5.0]])
        self.assertEqual(row['unclassified'], [[2.0, 3.0], [5.0, 6.0]])
        self.assertEqual(row['clean'], [[0.0, 2.0], [6.0, 8.0]])
        self.assertEqual(analysis([p, bad, odd, clean])['coverage']['time']['unrecorded'], row)           # order independent

    def test_an_empty_ok_probe_is_not_clean_and_does_not_support_healthy(self):
        for empty in ({}, {'format': {}}, {'streams': []}, {'exit_code': 0, 'stderr': '', 'streams': []}, ''):
            d = derive_one(obs('e1', 'ffprobe', 'ok', empty, source='case'))
            self.assertNotEqual(d.container, 'clean', empty)
            self.assertEqual(d.integrity, 'unknown', empty)
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['e1'], 'reason': 'r'}
        shown = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': '{}'}]
        self.assertIn('no clean integrity result', DG.check_healthy_v3(healthy, shown, []))
        shown = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe_out())}]
        self.assertIsNone(DG.check_healthy_v3(healthy, shown, []))      # control: a populated probe is a positive clean observation
        d = derive_one(obs('e1', 'ffprobe', 'ok', probe_out(streams=[])))
        self.assertEqual(d.integrity, 'unknown')                         # a container with no streams listed is not a positive observation either

    def test_a_decode_that_states_no_data_is_not_clean(self):
        for out in ({'exit_code': 0, 'stderr': ''}, {'exit_code': 0, 'stderr': '', 'frames': 0}):
            d = derive_one(obs('e1', 'decode_sample', 'ok', out, {'ss': 0, 't': 4}, source='case'), 8.0)
            self.assertNotEqual(d.integrity, 'clean', out)
        d = derive_one(obs('e1', 'decode_sample', 'ok', {'bytes_read': 4096, 'duration_limit_seconds': 4, 'exit_code': 0, 'quota_exhausted': False, 'stderr': ''}, {'ss': 0, 't': 4}, source='case'))
        self.assertEqual(d.integrity, 'clean')                           # control: bytes read are a positive observation

    def test_plain_text_integrity_output_keeps_its_text_and_only_explicit_damage_wording_is_a_defect(self):
        d = derive_one(obs('t1', 'ffprobe', 'ok', 'moov atom not found'))
        self.assertEqual((d.integrity, d.findings[0]['kind'], d.findings[0]['known_defect']), ('damaged', 'container_damage', True))
        self.assertEqual(d.facts, {'raw': 'moov atom not found'})
        d = derive_one(obs('t1', 'ffprobe', 'ok', 'a message nobody has classified'))
        self.assertEqual((d.integrity, d.findings, d.facts), ('unknown', [], {'raw': 'a message nobody has classified'}))
        cut = '{"exit_code": 0, "stderr": "[mov,mp4 @ 0x0] moov atom not fo ...[output cut off]'     # an injected partial: the text is shown, the structure is not
        d = derive_one(obs('t1', 'audiobook_inspect', 'partial', cut))
        self.assertEqual((d.integrity, d.facts), ('unknown', {'raw': cut}))
        self.assertTrue(any('plain text' in u for u in d.unresolved))
        d = derive_one(obs('t1', 'decode_sample', 'ok', 'Error while decoding stream #0:0: Invalid data found when processing input', {'at': 0}))
        self.assertEqual((d.integrity, d.findings[0]['kind']), ('damaged', 'decoder_errors'))


def live_audiobook(files, status='ok', parts=None, tags=None):
    out = {'parts': len(files), 'parts_probed': sum(1 for f in files if f.get('probe') in (None, 'ok')), 'ignored_non_audio_files': 0, 'total_duration_s': 20.0, 'files': files, 'findings': []}
    if tags is not None:
        out['tag_consistency'] = tags
    return {'status': status, 'tool': 'audiobook', 'mode': 'live', 'coverage': {'verified': ['chapters, durations and tags read from %d of %d part(s) via ffprobe' % (out['parts_probed'], out['parts'])],
                                                                                'not_verified': ['audio outside the sampled segments']}, 'output': out}


def book_file(errors=None, state='clean', tags=None, probe=None, **extra):
    seg = {'at_s': 0.0, 'state': state, 'decoded_s': 3.0, 'error_lines': len(errors or [])}
    if errors:
        seg['errors'] = errors
    f = {'name': 'part-01.m4b', 'bytes': 1000, 'format': 'mov,mp4,m4a,3gp,3g2,mj2', 'duration_s': 20.0, 'audio_streams': [{'index': 0, 'codec': 'aac', 'channels': 1}],
         'tags': tags or {'album': 'The Lantern Road', 'artist': 'Mira Tolland'}, 'chapter_count': 2,
         'chapters': [{'start_s': 0.0, 'end_s': 10.0, 'title': 'One'}, {'start_s': 10.0, 'end_s': 20.0, 'title': 'Two'}],
         'decode': {'segments_run': 1, 'segments': [seg]}}
    f.update(extra)
    if probe:
        f = {'name': 'part-01.m4b', 'bytes': 1000, 'probe': probe, 'probe_cause': 'input', 'probe_reason': 'ffprobe exited 1: the container could not be read'}
    return f


def live_epub(valid=True, findings=(), stage=None, error=None, status='ok', cause=None, passed=('zip_open', 'zip_crc', 'opf_parse', 'manifest', 'spine')):
    out = {'valid': valid, 'stages_passed': list(passed), 'findings': list(findings), 'entries': 7, 'opf': 'OEBPS/content.opf', 'dc_title': ['The Lantern Road'],
           'dc_creator': ['Mira Tolland'], 'dc_language': ['en'], 'dc_identifier': ['urn:x'], 'epub_version': '3.0', 'spine_items': 3, 'spine_characters': 900}
    if stage:
        out.update(stage=stage, error=error)
    rec = {'status': status, 'tool': 'epub', 'mode': 'live', 'coverage': {'verified': ['container.xml parses'], 'not_verified': ['reading quality']}, 'output': out}
    if cause:
        rec['cause'] = cause
    return rec


class LiveBookSchemas(unittest.TestCase):
    """Astra 2: the actual live book collector schemas keep their facts and their explicit damage."""

    def test_audiobook_with_recognised_decoder_errors_is_damaged_not_clean(self):
        rec = live_audiobook([book_file(errors=[DAMAGE], state='errors')])
        d = derive_one(obs('t1', 'audiobook_inspect', 'ok', rec, backend='live'))
        self.assertEqual(d.integrity, 'damaged')
        self.assertEqual([(f['kind'], f['known_defect'], f['location']['file']) for f in d.findings], [('decoder_errors', True, 'part-1')])
        clean = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([book_file()]), backend='live'))
        self.assertEqual((clean.integrity, clean.findings), ('clean', []))             # control
        odd = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([book_file(errors=['Decoder not found'], state='errors')]), backend='live'))
        self.assertEqual((odd.integrity, [f['known_defect'] for f in odd.findings]), ('unknown', [False]))
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['t1'], 'reason': 'r'}
        shown = lambda rec_: [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe_out())},
                              {'id': 't9', 'tool': 'audiobook_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(rec_)}]
        self.assertIn('decoder_errors', DG.check_healthy_v3(healthy, shown(rec), []))
        self.assertIsNone(DG.check_healthy_v3(healthy, shown(live_audiobook([book_file()])), []))

    def test_audiobook_facts_survive_and_decode_windows_are_per_part(self):
        rec = live_audiobook([book_file(), book_file(errors=[DAMAGE], state='errors')], tags={'consistent': False, 'inconsistent': {'album': {'A': ['part-01.m4b']}}})
        d = derive_one(obs('t1', 'audiobook_inspect', 'ok', rec, backend='live'))
        self.assertEqual(d.facts['parts'], 2)
        self.assertEqual(d.facts['files'][0]['tags'], {'album': 'The Lantern Road', 'artist': 'Mira Tolland'})
        self.assertEqual(d.facts['files'][0]['audio_streams'], [{'index': 0, 'codec': 'aac', 'channels': 1}])
        self.assertEqual([c['title'] for c in d.facts['chapters'] if c['part'] == 1], ['One', 'Two'])
        self.assertEqual(d.facts['tag_consistent'], False)
        self.assertIn('tags_differ_across_parts', [f['kind'] for f in d.findings])
        cov = analysis([obs('t1', 'audiobook_inspect', 'ok', rec, backend='live')])['coverage']
        self.assertEqual([(r['n'], r['clean'], r.get('damaged')) for r in cov['parts']], [(1, [[0.0, 3.0]], None), (2, [], [[0.0, 3.0]])])
        self.assertEqual(cov['time'], {'state': 'not_checked'})             # part windows are not put on one timeline

    def test_an_unreadable_part_is_a_defect_only_when_the_collector_says_the_input_is_at_fault(self):
        rec = live_audiobook([book_file(), book_file(probe='error')])
        d = derive_one(obs('t1', 'audiobook_inspect', 'partial', rec, backend='live'))
        self.assertEqual((d.integrity, d.findings[0]['kind'], d.findings[0]['known_defect']), ('damaged', 'part_unreadable', True))
        rec['output']['files'][1]['probe_cause'] = 'tool'
        d = derive_one(obs('t1', 'audiobook_inspect', 'partial', rec, backend='live'))
        self.assertEqual((d.integrity, d.findings[0]['kind'], d.findings[0]['known_defect']), ('unknown', 'part_probe_failed', False))

    def test_epub_valid_false_vetoes_healthy_alongside_a_clean_probe(self):
        rec = live_epub(valid=False, findings=[{'severity': 'warning', 'what': 'mimetype is not the first archive member'}])
        d = derive_one(obs('t1', 'epub_inspect', 'ok', rec, backend='live'))
        self.assertIsNotNone(d.veto)
        self.assertNotEqual(d.integrity, 'clean')
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9, 'evidence_refs': ['e1'], 'reason': 'r'}
        shown = [{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(probe_out())},
                 {'id': 't1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(rec)}]
        self.assertIn('package_invalid', DG.check_healthy_v3(healthy, shown, []))
        shown[1]['output'] = json.dumps(live_epub())                    # control: valid
        self.assertIsNone(DG.check_healthy_v3(healthy, shown, []))

    def test_epub_dc_metadata_and_explicit_damage_are_preserved(self):
        d = derive_one(obs('t1', 'epub_inspect', 'ok', live_epub(), backend='live'))
        self.assertEqual((d.facts['title'], d.facts['creator'], d.facts['language'], d.facts['identifier']), (['The Lantern Road'], ['Mira Tolland'], ['en'], ['urn:x']))
        self.assertEqual((d.integrity, set(d.package.values())), ('clean', {'clean'}))
        rec = live_epub(valid=False, findings=[{'severity': 'damage', 'what': 'the spine lists no items'}, {'severity': 'warning', 'what': 'no dc:identifier'}])
        d = derive_one(obs('t1', 'epub_inspect', 'ok', rec, backend='live'))
        self.assertEqual([(f['kind'], f['known_defect']) for f in d.findings if f['kind'] != 'package_invalid'], [('package_damage', True), ('package_warning', False)])
        self.assertEqual(d.integrity, 'damaged')
        rec = live_epub(valid=False, status='error', cause='input', stage='opf_parse', error='ParseError: x', passed=('zip_open', 'zip_crc'))
        d = derive_one(obs('t1', 'epub_inspect', 'error', rec, backend='live'))
        self.assertEqual(d.package, {'zip_open': 'clean', 'zip_crc': 'clean', 'opf_parse': 'damaged', 'manifest': 'not_checked', 'spine': 'not_checked'})
        self.assertEqual(d.integrity, 'damaged')
        rec = live_epub(valid=False, status='error', cause='tool', stage='zip_open', error='archive has 9000 members', passed=())
        d = derive_one(obs('t1', 'epub_inspect', 'error', rec, backend='live'))
        self.assertEqual((d.integrity, d.findings[0]['known_defect']), ('unknown', False))   # the collector's own cap is not damage ...
        self.assertIsNotNone(d.veto)                                                            # ... but valid:false still stops a healthy decision

    def test_replay_and_live_equivalence_for_the_actual_book_schemas(self):
        replay_epub = {'status': 'ok', 'bytes': 3301, 'sha256': 'x', 'opf': 'OEBPS/content.opf', 'dc_title': ['The Lantern Road'], 'dc_creator': ['Mira Tolland'], 'dc_language': ['en'],
                       'dc_identifier': ['urn:x'], 'entries': 7, 'spine_items': 3, 'spine_characters': 900, 'spine_heads': ['a b c']}
        a = derive_one(obs('t1', 'epub_inspect', 'ok', replay_epub, backend='local'))
        b = derive_one(obs('t1', 'epub_inspect', 'ok', live_epub(), backend='live'))
        for k in ('title', 'creator', 'language', 'identifier', 'entries', 'opf', 'spine_items', 'spine_characters'):
            self.assertEqual(a.facts[k], b.facts[k], k)
        self.assertEqual((a.integrity, a.package), (b.integrity, b.package))
        rd = {'status': 'error', 'bytes': 9, 'entries': 7, 'error': 'ParseError: x', 'stage': 'opf_parse'}
        a = derive_one(obs('t1', 'epub_inspect', 'error', rd, backend='local'))
        b = derive_one(obs('t1', 'epub_inspect', 'error', live_epub(valid=False, status='error', cause='input', stage='opf_parse', error='ParseError: x', passed=('zip_open', 'zip_crc')), backend='live'))
        self.assertEqual((a.integrity, a.package, [(f['kind'], f['known_defect'], f['location']['stage']) for f in a.findings]),
                         (b.integrity, b.package, [(f['kind'], f['known_defect'], f['location']['stage']) for f in b.findings if f['kind'] == 'package_damage']))
        replay_book = {'format': 'mov,mp4,m4a,3gp,3g2,mj2', 'duration_s': 20.0, 'bit_rate': '1', 'tags': {'album': 'The Lantern Road'}, 'audio_streams': [{'index': 0, 'codec_name': 'aac', 'channels': 1}],
                       'chapter_count': 2, 'chapters': [{'start_s': 0.0, 'end_s': 10.0, 'title': 'One'}, {'start_s': 10.0, 'end_s': 20.0, 'title': 'Two'}]}
        a = derive_one(obs('t1', 'audiobook_inspect', 'ok', replay_book, backend='replay'))
        b = derive_one(obs('t1', 'audiobook_inspect', 'ok', live_audiobook([book_file(tags={'album': 'The Lantern Road'})]), backend='live'))
        self.assertEqual(a.facts['chapter_count'] if 'chapter_count' in a.facts else None, 2)
        self.assertEqual([(c['title'], c['start_s'], c['end_s']) for c in a.facts['chapters']], [(c['title'], c['start_s'], c['end_s']) for c in b.facts['chapters']])
        self.assertEqual(a.facts['tags'], b.facts['files'][0]['tags'])
        self.assertEqual((a.integrity, a.container), (b.integrity, b.container))


class RequestedFullNotProof(unittest.TestCase):
    """Astra 3 as an audit pair."""

    def met(self, output, duration='8.046'):
        probe = {'id': 'e1', 'tool': 'ffprobe', 'status': 'ok', 'args': {}, 'output': json.dumps(probe_out(duration=duration))}
        full = {'id': 'e2', 'tool': 'decode_sample', 'status': 'ok', 'args': {'full': True}, 'output': json.dumps(output)}
        return AuditV2().met([probe, full], 'v2')[0]

    def test_exit_zero_empty_stderr_and_selected_streams_without_a_span_is_not_proof(self):
        self.assertFalse(self.met({'exit_code': 0, 'stderr': '', 'streams_selected': ['0:v:0', '0:a:0']}))
        self.assertFalse(self.met({'window_s': 'full', 'exit_code': 0, 'stderr': '', 'completed_to_eof': True, 'streams_selected': ['0:v:0', '0:a:0']}))      # a bare claim
        self.assertTrue(self.met({'window_s': 'full', 'exit_code': 0, 'stderr': '', 'frames': 67, 'out_time': '00:00:08.000000', 'streams_selected': ['0:v:0', '0:a:0']}))   # control
        self.assertFalse(self.met({'window_s': 'full', 'exit_code': 0, 'stderr': '', 'frames': 67, 'out_time': '00:00:08.000000', 'streams_selected': ['0:v:0', '0:a:0']}, duration='100'))


class Robustness(unittest.TestCase):
    """Malformed recorded or live data yields no typed fact and no exception: the layer never guesses and never stops a run."""
    OUTS = ['', 'null', '[]', '123', '"str"', '{}', '{"exit_code":"x"}', '{"stderr":123}', '{"stderr":["a"]}', '{"streams":"x"}', '{"streams":[1,2]}', '{"streams":{"video":1}}',
            '{"format":5}', '{"format":{"duration":"x"}}', '{"chapters":[1,{"start":"a"}]}', '{"frames":"x","out_time":{}}', '{"exit_code":0,"stderr":"","frames":-1,"out_time":"99:99:99"}',
            '{"status":"error","stage":5}', '{"stage":["a"]}', '{"coverage":{"verified":"x","not_verified":3},"output":{"segments":[1,2,{"at_s":"q"}]},"status":"ok"}',
            '{"coverage":{"verified":[],"not_verified":[]},"output":5}', '{"observation":5,"recorded_as":"x"}', '{"chapter_count":"x","chapters":5}',
            '{"exit_code":0,"stderr":"x","ss":"a"}', 'x' * 20000, '{"a":' * 50 + '1' + '}' * 50, '{"window_s":"full","exit_code":0,"stderr":""}']

    def test_no_shape_raises_and_none_is_read_as_clean_or_damaged(self):
        import itertools
        tools = ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'audiobook_inspect', 'arr_lookup', 'prior_record', 'unknown_tool')
        for tool, status, out, args in itertools.product(tools, ('ok', 'partial', 'error', 'timeout', 'unavailable'), self.OUTS, ({}, {'at': 4}, {'full': True})):
            o = obs('t1', tool, status, out, args)
            d = EV2.derive(o)
            self.assertIsNotNone(d.execution)
            ses = EV2.Session('case-0', {'client_profile': {'video': 'h264'}}, 'tv', [tool])
            ses.initial([o])
            text, n = ses.result(obs('t2', tool, status, out, args), 't2', 3)
            json.loads(text)
            if n == 1:
                self.assertLessEqual(len(text.encode()), EV2.WIRE_BYTES)

    def test_an_unreadable_shape_is_reported_as_such(self):
        d = EV2.derive(obs('t1', 'decode_sample', 'ok', {'exit_code': 0, 'stderr': '', 'out_time': {'x': 1}}, {'at': 0}))
        self.assertIn(d.integrity, ('unknown', 'clean'))
        d = EV2.derive(obs('t1', 'ffprobe', 'ok', '{"coverage":{"verified":"x","not_verified":3},"output":{"segments":[1,2,{"at_s":"q"}]},"status":"ok"}'))
        self.assertEqual(d.integrity, 'unknown')
        self.assertTrue(any('shape this layer does not read' in u for u in d.unresolved))
        self.assertIn('raw', d.facts)


if __name__ == '__main__':
    unittest.main()
