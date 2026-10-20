"""dev-c6 Amendment 1 (Astra 22 items 4 to 6): the benchmark-passability classification (`scripts/passability.py`) on synthetic cases, records made by the real
runner under v6 + v3 with scripted replies, and the unchanged scorer's per-case facts.  Every category is reachable; the label-tension membership is an independent
annotation; a score-correct write with an unmet audit prerequisite is a row; an uncalled link alone never makes a model error; a witness counts page fetches.
Synthetic, generic fixtures only; no model call."""
import copy
import hashlib
import importlib.util
import json
import unittest

import ev2h
import legacy_e2e as L
import th
from ev2h import ev, tc
from media_repair_harness import decision_guard as DG
from media_repair_harness import run as R
from media_repair_harness import score_compat

SPEC = importlib.util.spec_from_file_location('mrh_passability', th.COMPONENT / 'scripts' / 'passability.py')
PS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PS)
SCORE = score_compat.load_score()
FILENAME = 'Harbor Lights - S01E02 - Lamp Oil.mkv'
ARR = {'app': 'sonarr', 'series': 'Harbor Lights', 'episode': {'season': 1, 'episode': 2, 'title': 'Lamp Oil', 'hasFile': True},
       'file': {'relativePath': FILENAME, 'id': 990202}}
PROBE = {'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(L.PROBE_REC)}
DAMAGE = {'id': 'e2', 'tool': 'decode_sample', 'args': {'ss': 4, 't': 4}, 'status': 'ok', 'output': json.dumps(L.DEC_BAD)}
BINDING = {'id': 'e3', 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(ARR)}


def d3(cls='insufficient_evidence', action='escalate', refs=(), source=None, target=None):
    d = {'type': 'decision', 'class': cls, 'action': action}
    if source:
        d['source'] = {'ref': source}
    if target:
        d['target'] = target
    d.update(reason='r', confidence=0.5, evidence_refs=list(refs))
    return d


def labelled(cid, truth, supported, evidence, tools=('ffprobe', 'decode_sample', 'arr_lookup'), **ctx):
    case = L.tv_case(cid, evidence=evidence, tools_available=list(tools))
    case['truth'] = {'class': truth, 'source': 'construction', 'ref': 'zq-%s' % cid}
    case['supported_actions'] = list(supported)
    case['context'].update(ctx)
    return case


def run_and_classify(case, replies, tension=None, tamper=None, restored=True):
    ts = L.suite_with(case)
    rec, _ad = ev2h.scripted_run(case, ts, replies, prompt='v6', evidence_format='v3', guards='v3', which=th.NO_BINARIES)
    if tamper:
        rec = tamper(copy.deepcopy(rec))
    shown = R.resolve_evidence_raw(case, ts.root)
    rec_r = DG.restore_original(rec, case, shown) if (rec.get('guard') or {}).get('final_changed') and restored else rec
    row = PS.classify(case, rec, rec_r, SCORE.case_facts(case, rec), SCORE.case_facts(case, rec_r), ts.root, tension)
    ts.cleanup()
    return row, rec


def strip_ids(*ids):
    def t(rec):
        for turn in rec['turns']:
            raw = json.dumps(turn.get('raw_request'))
            for i in ids:
                raw = raw.replace('\\"id\\":\\"%s\\"' % i, '\\"id\\":\\"zz\\"')
            turn['raw_request'] = json.loads(raw)
        return rec
    return t


BLOCK = {'kind': 'release_of_source', 'source_ref': 'e3'}


class EveryCategoryIsReachable(unittest.TestCase):
    def test_model_error_needs_the_label_met_on_what_was_shown_and_a_faithful_transcript(self):
        case = labelled('ps-001', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, rec = run_and_classify(case, [d3('corrupt_file', 'escalate', ['e2'])])
        self.assertEqual(row['category'], 'model error', row)
        self.assertTrue(row['fidelity']['ok'])
        self.assertEqual(row['S'][0]['state'], 'met')

    def test_presentation_problem_when_a_deciding_reference_is_not_in_the_sent_transcript(self):
        case = labelled('ps-002', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, _ = run_and_classify(case, [d3('corrupt_file', 'escalate', ['e2'])], tamper=strip_ids('e2.f1', 'e2'))
        self.assertEqual(row['category'], 'presentation problem', row)
        self.assertTrue(row['fidelity']['missing'])

    def test_not_obtained_when_the_deciding_reference_was_on_an_unfetched_page(self):
        def t(rec):
            rec = strip_ids('e2.f1', 'e2')(rec)
            rec['evidence_format']['messages'][0]['pages'] = 2
            return rec
        case = labelled('ps-003', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, _ = run_and_classify(case, [d3('corrupt_file', 'escalate', ['e2'])], tamper=t)
        self.assertEqual(row['category'], 'not obtained (unfetched page)', row)

    def test_obtainable_not_obtained_needs_a_witness_within_six_calls_not_just_an_uncalled_link(self):
        case = labelled('ps-004', 'corrupt_file', ['blocklist_and_search'], [PROBE, BINDING])        # the damaged window at 4 s is recorded but not shown
        row, _ = run_and_classify(case, [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'obtainable, not obtained', row)
        self.assertTrue(row['witness']['found'])
        self.assertLessEqual(row['witness']['cost'], 6)
        self.assertIn({'tool': 'decode_sample', 'args': {'at': 4}}, row['witness']['calls'])

    def test_evidence_gap_when_no_offered_operation_can_meet_the_label(self):
        decl = {'id': 'e1', 'tool': 'prior_record', 'args': {}, 'status': 'ok',
                'output': json.dumps({'evidence_method': 'container tags', 'observed': {'title': 'Another Show'}})}
        case = labelled('ps-005', 'identity_mismatch', ['blocklist_and_search'], [decl, BINDING], tools=())
        row, _ = run_and_classify(case, [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'evidence gap', row)
        self.assertFalse(row['witness']['found'])

    def test_undetermined_when_a_relevant_prerequisite_is_unknown_to_the_checker(self):
        untagged = dict(PROBE, output=json.dumps(dict(L.PROBE_REC, format={k: v for k, v in L.PROBE_REC['format'].items() if k != 'tags'})))
        case = labelled('ps-006', 'healthy', ['none'], [untagged, {'id': 'e2', 'tool': 'decode_sample', 'args': {'ss': 0, 't': 4}, 'status': 'ok',
                                                                  'output': json.dumps(dict(L.DEC_CLEAN, ss=0))}], tools=(), question='Does the last scene play?')
        row, _ = run_and_classify(case, [d3('insufficient_evidence', 'escalate', ['e1'])])
        self.assertEqual(row['category'], 'undetermined (hand judgement)', row)

    def test_a_forced_decision_is_a_non_model_failure(self):
        case = labelled('ps-007', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, rec = run_and_classify(case, ['not json', 'still not json'])
        self.assertTrue(rec['forced'])
        self.assertEqual(row['category'], 'non-model failure')

    def test_a_guard_only_change_is_attributed_to_the_guard(self):
        arr_only = {'id': 'e1', 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(ARR)}
        case = labelled('ps-008', 'healthy', ['none'], [arr_only], tools=())
        row, rec = run_and_classify(case, [d3('healthy', 'none', ['e1'])])
        self.assertTrue(rec['guard']['final_changed'])
        self.assertEqual(row['category'], 'guard change', row)
        self.assertEqual((row['scorer']['guarded']['correct'], row['scorer']['restored']['correct']), (False, True))

    def test_a_score_correct_write_with_an_unmet_prerequisite_is_a_row(self):
        case = labelled('ps-009', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        # the damage observation cited as the source binding: score.py marks it correct, audit v3 says R-SRC unmet
        row, rec = run_and_classify(case, [d3('corrupt_file', 'blocklist_and_search', ['e2'], source='e2', target={'kind': 'release_of_source', 'source_ref': 'e2'})])
        self.assertTrue(row['scorer']['guarded']['correct'])
        self.assertEqual(row['category'], 'score-correct write with unmet or unknown prerequisites')
        self.assertIn('R-SRC', [p['id'] for p in row['audit_v3_not_met']['guarded']])
        ok_row, _ = run_and_classify(case, [d3('corrupt_file', 'blocklist_and_search', ['e2'], source='e3', target=BLOCK)])
        self.assertIsNone(ok_row)          # every prerequisite met and score-correct: not a row

    def test_tension_membership_is_an_independent_annotation(self):
        case = labelled('ps-010', 'corrupt_file', ['blocklist_and_search'], [PROBE, DAMAGE, BINDING])
        row, _ = run_and_classify(case, [d3('corrupt_file', 'escalate', ['e2'])], tension={'ps-010': 'a frozen reason'})
        self.assertEqual(row['label_tension_list'], {'member': True, 'reason': 'a frozen reason'})
        self.assertEqual(row['category'], 'model error')                  # the annotation does not pre-empt the category


class ThePolicy(unittest.TestCase):
    def test_advertised_operations_follow_the_advertisement_in_a_fixed_order(self):
        case = {'tools_available': ['ffprobe', 'decode_sample', 'frame_sample', 'ocr', 'arr_lookup', 'epub_inspect']}
        caps = [{'tool': 'ffprobe', 'available': True}, {'tool': 'decode_sample', 'available': True, 'offsets_s': [0, 4], 'full_decode': 'recorded'},
                {'tool': 'frame_sample', 'available': True, 'offsets_s': 'any'}, {'tool': 'ocr', 'available': True, 'offsets_s': 'any', 'recorded_reading_ranges_s': [[10, 12]]},
                {'tool': 'arr_lookup', 'available': True}, {'tool': 'epub_inspect', 'available': False}]
        self.assertEqual(PS.advertised_operations(case, caps), [('ffprobe', {}), ('decode_sample', {'at': 0}), ('decode_sample', {'at': 4}), ('decode_sample', {'full': True}),
                                                                ('frame_sample', {'at': 0.0}), ('frame_sample', {'at': 10.0}), ('ocr', {'at': 0.0}), ('ocr', {'at': 10.0}),
                                                                ('arr_lookup', {})])

    def test_a_witness_counts_page_fetches(self):
        big = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(160)]
        case = labelled('ps-011', 'corrupt_file', ['blocklist_and_search'], [BINDING], tools=('ffprobe', 'decode_sample'))
        ts = L.suite_with(case, probes=False)
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=dict(L.PROBE_REC, chapters=big))
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        ex = PS.Explorer(case, ts.root)
        ex.explore()
        probe = [ex.served[k] for k in ex.order if k[0] == 'ffprobe']
        self.assertEqual(len(probe), 1)
        self.assertGreater(PS.pages_cost(ex, probe), 1)                  # one call plus the pages its paginated result needs
        ts.cleanup()

    def test_newly_revealed_candidates_are_served(self):
        frame_case = labelled('ps-012', 'healthy', ['none'], [PROBE], tools=('frame_sample', 'ocr'))
        ts = L.suite_with(frame_case)
        ex = PS.Explorer(frame_case, ts.root)
        out = ex.explore()
        tools = [(s['tool'], s['args']) for s in out['served']]
        frames = [a for t, a in tools if t == 'ocr' and 'frame' in a]
        self.assertTrue(frames, tools)                                        # an ocr of the frame a served frame_sample returned
        ts.cleanup()

    def test_the_policy_is_frozen(self):
        self.assertEqual((PS.POLICY_VERSION, PS.MAX_CALLS, PS.MAX_EVALUATIONS, PS.MAX_ROUNDS), ('passability-1', 6, 5000, 3))


if __name__ == '__main__':
    unittest.main()
