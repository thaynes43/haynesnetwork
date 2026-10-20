"""dev-c4 tests: prompt v4 (new text on the v2 turn protocol), the exact tool-enum schema for cases that offer no tool (v4 only), and the opt-in
decision guards (`--guards v1`, `mrh-guard`).  Fake model replies only (ScriptedAdapter), synthetic generic fixtures; no model, no network.
What these tests check is what the HARNESS does and that the prompt TEXT carries the rules and names no case; whether a model follows the text
is measured on the dev split, not here."""
import copy
import json
import re
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import adapters as A
from media_repair_harness import audit as AU
from media_repair_harness import decision_guard as DG
from media_repair_harness import guard_cli
from media_repair_harness import leakguard as L
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th
from test_v2 import audit_obj, wdecision
from test_v3 import need_both_suites, suite_cases, word


def ev(i, tool, status='ok', output='x', **kw):
    return dict({'id': i, 'tool': tool, 'args': {}, 'status': status, 'output': output}, **kw)


def case_with(evidence, tools=(), app=None, truth='healthy', supported=('none',), **kw):
    ctx = {'title': 'Some Item', 'filename': 'item-file.bin', 'expected': {}, 'arr': {'app': app, 'ids': {'releaseId': 'rel-1234'}}, 'notes_for_model': 'n'}
    return th.make_case('g1', truth=truth, supported=supported, evidence=list(evidence), tools_available=list(tools), context=ctx, **kw)


def shown(case):
    return [dict(e, truncated=False) for e in case['evidence']]


def call(i, tool, status='ok', output='x', **kw):
    return dict({'id': i, 'turn': 1, 'tool': tool, 'args': {}, 'why': 'w', 'status': status, 'output': output}, **kw)


def run_case(case, replies, prompt='v4', **kw):
    ts = th.TempSuite([case])
    ad = A.ScriptedAdapter('scripted-1', replies)
    rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version=prompt, run_id='r4', which=th.NO_BINARIES, **kw)
    rec.update(harness_git_sha='x', config_hash='h')
    return rec, ts


class PromptV4(unittest.TestCase):
    def setUp(self):
        self.v3 = P.get_prompt('v3')['text']
        self.v4 = P.get_prompt('v4')['text']

    def test_selectable_and_nothing_else_moves(self):
        self.assertIn('v4', P.PROMPT_VERSIONS)
        self.assertEqual(P.DEFAULT_PROMPT, 'v1')
        self.assertEqual([P.protocol_of(v) for v in ('v1', 'v2', 'v3', 'v4')], ['v1', 'v2', 'v2', 'v2'])
        self.assertEqual(len({P.get_prompt(v)['sha256'] for v in ('v1', 'v2', 'v3', 'v4')}), 4)
        with self.assertRaises(ValueError):
            P.get_prompt('v5')

    def test_is_shorter_than_v3_and_keeps_the_reply_format(self):
        self.assertLess(len(self.v4), len(self.v3))
        for marker in ('REPLY FORMAT', 'CLASSES', 'ACTIONS', 'EVIDENCE RULES', 'MANAGING APP', 'exactly ONE JSON object', 'at most 6 per case'):
            self.assertIn(marker, self.v4, marker)
        # the decision always carries target (Opus first-try wrong_keys on dev-c3)
        self.assertIn('Every decision object has all of the keys shown, including "target"', self.v4)

    def test_review_risks_are_addressed_in_the_text(self):
        # 1. integrity evidence speaks only to corrupt_file; decoder and naming classes need their own evidence
        self.assertIn('Integrity evidence (probe, decode, package or stream checks) speaks only to corrupt_file', self.v4)
        self.assertIn('does not rule out decoder_incompatible', self.v4)
        self.assertIn('metadata_naming', self.v4.split('EVIDENCE RULES')[1].split('2. Healthy')[0])
        # 2. a different work is identity_mismatch; the right work with a wrong name, tag or mapping is metadata_naming (rename or remap); unclear: escalate
        self.assertIn('Different work or mislabelled copy', self.v4)
        self.assertIn('rename for name or tag text, remap for a wrong item link', self.v4)
        self.assertIn('If the evidence does not show which of the two applies, escalate', self.v4)
        # C2 healthy boundary, stated neutrally
        for marker in ('even when some are partial', 'A capability that is unavailable (nothing ran) is not a finding',
                       'no integrity check ran with status ok', 'insufficient_evidence with escalate'):
            self.assertIn(marker, self.v4, marker)

    def test_no_anti_escalation_wording(self):
        for gone in ('Escalate only', 'escalate only', 'is a miss', 'no named gap', 'Without a named gap', 'a person then repeats', 'wrong repair is worse'):
            self.assertNotIn(gone, self.v4, gone)
        self.assertIn('whenever the evidence does not settle the class or the supported action', self.v4)

    def test_the_text_names_no_case_of_either_dev_suite(self):
        n = 0
        for d in need_both_suites():
            for c in suite_cases(d):
                n += 1
                L.check_system(c, self.v4)
                ctx = c.get('context') or {}
                tokens = [c['id'], re.sub(r'-\d+$', '', c['id']), c.get('family') or '', ((c.get('truth') or {}).get('ref') or ''), ctx.get('filename') or '']
                if ' ' in str(ctx.get('title') or ''):
                    tokens.append(str(ctx['title']))
                tokens.append(Path(str(((c.get('fixture') or {}).get('locator')) or '')).name)
                for t in tokens:
                    if len(t) >= 6:
                        self.assertIsNone(word(t).search(self.v4), (c['id'], t))
        self.assertEqual(n, 146)
        self.assertEqual(re.findall(r'\b[a-z]+-[a-z]+-\d{3}\b', self.v4), [])
        self.assertEqual(re.findall(r'\b\w+\.(?:mkv|mp4|epub|m4b|mp3|avi)\b', self.v4, re.I), [])

    def test_v4_validates_with_the_v2_protocol_and_remap_may_name_metadata_naming(self):
        d = wdecision(cls='metadata_naming', action='remap', target='rel-1')
        self.assertEqual(P.validate_turn(d, None, 'v4')[0], 'decision')
        case = case_with([ev('e1', 'arr_lookup')], app='sonarr')
        out_v3 = AU.compute(case, d, [], prompt_version='v3')
        out_v4 = AU.compute(case, d, [], prompt_version='v4')
        self.assertIn('class_matches_action', out_v3['unmet'])      # v1 to v3 tables are unchanged
        self.assertNotIn('class_matches_action', out_v4['unmet'])


class StrictToolSchema(unittest.TestCase):
    def branches(self, schema):
        return [b['properties']['type']['enum'][0] for b in schema['anyOf']]

    def test_v2_and_v3_keep_the_dev_c3_behaviour_for_an_empty_tools_list(self):
        for v in ('v2', 'v3'):
            s = P.turn_schema(v, [])
            self.assertEqual(self.branches(s), ['tool_call', 'decision', 'decision'], v)
            self.assertEqual(s['anyOf'][0]['properties']['tool']['enum'], list(P.TOOLS), v)   # the fallback that let a model call any tool
        self.assertEqual(P.turn_schema('v3', []), P.turn_schema('v2', []))

    def test_v4_offers_no_tool_call_when_no_tool_is_offered(self):
        s = P.turn_schema('v4', [])
        self.assertEqual(self.branches(s), ['decision', 'decision'])
        self.assertNotIn('tool_call', json.dumps(s))
        f = P.turn_schema('v4', [], flat=True)
        self.assertEqual(f['properties']['type']['enum'], ['decision'])
        for k in ('tool', 'why', 'args'):
            self.assertNotIn(k, f['properties'])

    def test_v4_is_unchanged_when_tools_are_offered(self):
        for tools in (['ffprobe', 'arr_lookup'],):
            self.assertEqual(P.turn_schema('v4', tools), P.turn_schema('v3', tools))
            self.assertEqual(P.turn_schema('v4', tools, flat=True), P.turn_schema('v3', tools, flat=True))
        self.assertEqual(P.turn_schema('v4', ['ffprobe'])['anyOf'][0]['properties']['tool']['enum'], ['ffprobe'])

    def test_v4_treats_a_missing_tools_available_like_an_empty_list_and_v2_v3_do_not(self):
        self.assertEqual(P.turn_schema('v4', None), P.turn_schema('v4', []))
        self.assertEqual(P.turn_schema('v4', None, flat=True), P.turn_schema('v4', [], flat=True))
        for v in ('v2', 'v3'):
            self.assertEqual(self.branches(P.turn_schema(v, None)), ['tool_call', 'decision', 'decision'], v)    # byte-identical to dev-c3
            self.assertEqual(P.turn_schema(v, None), P.turn_schema('v2', None))
        case = case_with([ev('e1', 'arr_lookup')])
        del case['tools_available']
        self.assertNotIn('tool_call', json.dumps(P.turn_schema('v4', case.get('tools_available'))))

    def test_a_v4_record_hashes_the_exact_schema_and_a_tool_call_is_still_a_recorded_violation(self):
        case = case_with([ev('e1', 'arr_lookup')], tools=[])
        class OllamaLike(A.ScriptedAdapter):
            name = 'ollama'
        ts = th.TempSuite([case])
        ad = OllamaLike('scripted-1', [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version='v4', run_id='r4', which=th.NO_BINARIES)
        want = R.sha256_bytes(R.canonical(P.turn_schema('v4', [])).encode())
        self.assertEqual((rec['prompt']['turn_schema_sha256'], rec['prompt']['schema_sent']), (want, True))
        self.assertEqual([v['kind'] for v in rec['protocol_violations']], ['tool_not_offered'])   # a hosted model can still do it; the record says so
        self.assertFalse(rec['first_try_valid'])
        ts.cleanup()


class GuardHealthy(unittest.TestCase):
    H = th.decision('healthy', 'none', refs=['e1'])

    def fires(self, evidence, calls=()):
        case = case_with(evidence)
        return DG.check_healthy(self.H, shown(case), list(calls))

    def test_fires_without_any_integrity_check(self):
        self.assertIsNotNone(self.fires([ev('e1', 'prior_record')]))
        self.assertIsNotNone(self.fires([ev('e1', 'arr_lookup'), ev('e2', 'ocr')]))
        self.assertIsNotNone(self.fires([]))
        self.assertIn('none was offered or run', self.fires([]))

    def test_identity_and_title_records_are_not_integrity_checks(self):
        for tool in ('arr_lookup', 'ocr', 'prior_record', 'frame_sample'):
            self.assertIsNotNone(self.fires([ev('e1', tool)]), tool)
            self.assertIsNotNone(self.fires([], [call('t1', tool)]), tool)

    def test_never_fires_with_one_ok_integrity_check_of_each_type(self):
        for tool in DG.INTEGRITY_TOOLS:
            self.assertIsNone(self.fires([ev('e1', tool)]), tool)               # case-provided evidence counts
            self.assertIsNone(self.fires([], [call('t1', tool)]), tool)         # a tool result counts
        self.assertEqual(set(DG.INTEGRITY_TOOLS), {'ffprobe', 'decode_sample', 'audio_sample', 'epub_inspect', 'audiobook_inspect'})

    def test_partial_but_representative_checks_keep_healthy(self):
        # one ok probe next to failed, timed out, partial, unavailable and injected results: at least one ok check exists
        evidence = [ev('e1', 'ffprobe'), ev('e2', 'decode_sample', 'partial'), ev('e3', 'epub_inspect', 'unavailable'), ev('e4', 'audio_sample', 'error')]
        calls = [call('t1', 'decode_sample', 'timeout', injected=True), call('t2', 'audiobook_inspect', 'unavailable')]
        self.assertIsNone(self.fires(evidence, calls))

    def test_failed_timeout_partial_unavailable_and_injected_results_do_not_count(self):
        for status in ('error', 'timeout', 'partial', 'unavailable'):
            self.assertIsNotNone(self.fires([ev('e1', 'ffprobe', status)]), status)
            self.assertIsNotNone(self.fires([], [call('t1', 'decode_sample', status)]), status)
        for status in ('error', 'timeout', 'partial'):      # an injected failure is shown to the model as one of these; the guard reads only that status
            self.assertIsNotNone(self.fires([], [call('t1', 'decode_sample', status, injected=True)]), status)
        self.assertTrue(all('injected' not in s for s in DG.sources([], [call('t1', 'ffprobe', 'error', injected=True)])))
        reason = self.fires([ev('e1', 'ffprobe', 'error'), ev('e2', 'epub_inspect', 'timeout')])
        self.assertIn('ffprobe:error', reason)
        self.assertIn('epub_inspect:timeout', reason)

    def test_only_healthy_none_is_touched(self):
        case = case_with([ev('e1', 'prior_record')])
        for d in (th.decision('insufficient_evidence', 'escalate'), th.decision('healthy', 'escalate'), th.decision('corrupt_file', 'escalate'),
                  th.decision('metadata_naming', 'none')):
            self.assertIsNone(DG.check_healthy(d, shown(case), []))


class GuardWrite(unittest.TestCase):
    def check(self, case, decision, calls=(), pv='v4'):
        return DG.check_write(case, decision, list(calls), pv)

    def good_case(self, **kw):
        return case_with([ev('e1', 'epub_inspect', output='archive damaged: rel-1234 cannot be read')], app='bookshelf', truth='corrupt_file',
                         supported=('blocklist_and_search',), **kw)

    def good(self, **kw):
        return wdecision(**dict({'target': 'item-file.bin', 'refs': ['e1']}, **kw))

    def test_a_supported_write_passes(self):
        self.assertIsNone(self.check(self.good_case(), self.good()))

    def test_no_managing_app_fires(self):
        case = self.good_case()
        case['context']['arr']['app'] = None
        self.assertIn('arr_app_present', self.check(case, self.good()))

    def test_no_cited_evidence_or_only_a_non_ok_result_fires(self):
        case = case_with([ev('e1', 'epub_inspect', 'partial'), ev('e2', 'arr_lookup')], app='bookshelf', truth='corrupt_file', supported=('blocklist_and_search',))
        self.assertIn('cited_evidence_supports', self.check(case, self.good(refs=[])))
        self.assertIn('cited_evidence_supports', self.check(case, self.good(refs=['e1'])))
        self.assertIsNone(self.check(case, self.good(refs=['e2'])))

    def test_a_damage_report_from_a_tool_that_ran_is_support(self):
        dmg = json.dumps({'exit_code': 1, 'stderr': 'moov atom not found'})
        case = case_with([ev('e1', 'ffprobe', 'error', dmg)], app='radarr', truth='corrupt_file', supported=('blocklist_and_search',))
        self.assertIsNone(self.check(case, self.good()))

    def test_class_must_match_the_action(self):
        self.assertIn('class_matches_action', self.check(self.good_case(), wdecision(cls='healthy', target='item-file.bin')))

    def test_claim_text_checks_are_never_acted_on(self):
        # remap's "slot is free" and rename's "way back" rest on the model's own audit text: the audit marks them claim_text, the guard ignores them
        case = case_with([ev('e1', 'ocr', output='other content')], app='sonarr', truth='identity_mismatch', supported=('remap',))
        d = wdecision(cls='identity_mismatch', action='remap', target='item-file.bin', refs=['e1'], audit=audit_obj('item-file.bin', pre=('e1 shows the content',)))
        audit = AU.compute(case, d, [], prompt_version='v4')
        self.assertTrue(any(c['basis'] == 'claim_text' and not c['met'] for c in audit['preconditions']))
        self.assertIsNone(self.check(case, d))

    def test_the_text_matching_target_check_is_not_acted_on(self):
        case = self.good_case()
        d = self.good(target='release rel-1234 in series 77 of the show')
        d['audit']['target'] = d['target']
        audit = AU.compute(case, d, [], prompt_version='v4')
        self.assertFalse(next(c for c in audit['preconditions'] if c['id'] == 'target_in_context')['met'])
        self.assertIsNone(self.check(case, d))

    def test_convert_needs_the_nested_client_profile_and_a_full_decode(self):
        d = wdecision(cls='decoder_incompatible', action='convert', target='item-file.bin', refs=['e1'],
                      audit=audit_obj('item-file.bin', pre=('e1 clean decode',), readback='the copy', verify='the original is untouched, a copy was made'))
        case = case_with([ev('e1', 'decode_sample', output='ok')], app='radarr', truth='decoder_incompatible', supported=('convert',))
        case['context']['expected'] = {'client_profile': {'video_codec': 'h264'}}
        self.assertIn('full_decode_ok', self.check(case, d))
        self.assertNotIn('client_profile_present', self.check(case, d))      # the profile is found under expected
        case['evidence'][0]['args'] = {'full': True}
        self.assertIsNone(self.check(case, d))
        del case['context']['expected']['client_profile']
        self.assertIn('client_profile_present', self.check(case, d))

    def test_v2_ignores_full_decode_for_convert_and_a_failed_citation_next_to_valid_support(self):
        d = wdecision(cls='decoder_incompatible', action='convert', target='item-file.bin', refs=['e1'],
                      audit=audit_obj('item-file.bin', pre=('e1 clean decode',), readback='the copy', verify='the original is untouched, a copy was made'))
        case = case_with([ev('e1', 'decode_sample', output='ok')], app='radarr', truth='decoder_incompatible', supported=('convert',))
        case['context']['expected'] = {'client_profile': {'video_codec': 'h264'}}
        self.assertIn('full_decode_ok', DG.check_write(case, d, [], 'v4', version='v1'))
        self.assertIsNone(DG.check_write(case, d, [], 'v4', version='v2'))
        # a failed tool cited next to a valid support: v1 fires on no_failed_tool_cited, v2 does not; a failed tool alone still fires under both
        case = case_with([ev('e1', 'epub_inspect', output='archive damaged'), ev('e2', 'ffprobe', 'timeout')], app='bookshelf', truth='corrupt_file', supported=('blocklist_and_search',))
        both = self.good(refs=['e1', 'e2'])
        self.assertIn('no_failed_tool_cited', DG.check_write(case, both, [], 'v4', version='v1'))
        self.assertIsNone(DG.check_write(case, both, [], 'v4', version='v2'))
        alone = self.good(refs=['e2'])
        self.assertIn('cited_evidence_supports', DG.check_write(case, alone, [], 'v4', version='v1'))
        self.assertIn('cited_evidence_supports', DG.check_write(case, alone, [], 'v4', version='v2'))
        # v2 keeps every other computed check
        case['context']['arr']['app'] = None
        self.assertIn('arr_app_present', DG.check_write(case, self.good(refs=['e1']), [], 'v4', version='v2'))
        with self.assertRaises(ValueError):
            DG.apply(case, d, [], [], 'v4', version='v9')

    def test_non_writes_are_not_touched(self):
        for d in (th.decision('insufficient_evidence', 'escalate'), th.decision('healthy', 'none')):
            self.assertIsNone(self.check(self.good_case(), d))


class ApplyAndRecord(unittest.TestCase):
    def test_apply_keeps_the_original_and_names_the_guard(self):
        case = case_with([ev('e1', 'prior_record')])
        orig = th.decision('healthy', 'none', refs=['e1'], reason='looks fine')
        keep = copy.deepcopy(orig)
        final, g = DG.apply(case, orig, [], shown(case), 'v4')
        self.assertEqual(orig, keep)                                   # the input is never modified
        self.assertEqual((final['class'], final['action'], final['target']), ('insufficient_evidence', 'escalate', None))
        self.assertIn('guard G-healthy', final['reason'])
        self.assertLessEqual(len(final['reason']), 400)
        self.assertEqual((g['version'], g['final_changed'], len(g['applied'])), ('v1', True, 1))
        self.assertEqual((g['applied'][0]['rule'], g['applied'][0]['original']), ('G-healthy', keep))
        self.assertTrue(g['applied'][0]['reason'])

    def test_no_guard_fires_on_an_abstention_or_a_clean_healthy_item(self):
        case = case_with([ev('e1', 'ffprobe')])
        for d in (th.decision('healthy', 'none', refs=['e1']), th.decision('insufficient_evidence', 'escalate')):
            final, g = DG.apply(case, d, [], shown(case), 'v4')
            self.assertIs(final, d)
            self.assertEqual(g, {'version': 'v1', 'applied': [], 'final_changed': False})

    def test_a_guard_can_only_produce_an_escalation(self):
        # across a sweep of decisions and evidence, a changed final decision is always insufficient_evidence / escalate with no write and no audit
        evs = ([], [ev('e1', 'prior_record')], [ev('e1', 'ffprobe', 'error')], [ev('e1', 'ffprobe')])
        for evidence in evs:
            case = case_with(evidence, app=None)
            for cls in P.CLASSES:
                for act in P.ACTIONS:
                    d = wdecision(cls=cls, action=act, target='item-file.bin', refs=['e1']) if act in P.WRITE_ACTIONS else th.decision(cls, act, refs=['e1'])
                    final, g = DG.apply(case, d, [], shown(case), 'v4')
                    if g['final_changed']:
                        self.assertEqual((final['class'], final['action'], final['target'], final['evidence_refs']), ('insufficient_evidence', 'escalate', None, []))
                        self.assertNotIn('audit', final)
                    else:
                        self.assertIs(final, d)


def rec_for_compare(rec):
    """A record with the run-time fields (clock, wall time) removed so two runs of the same replies can be compared byte for byte."""
    rec = copy.deepcopy(rec)
    rec.pop('started_at', None)
    rec['wall'] = None
    for t in rec['turns']:
        t.pop('wall_s', None)
        t.pop('load_s', None)
    rec['tool_calls'] = [{k: v for k, v in c.items() if k != 'wall_s'} for c in rec['tool_calls']]
    return json.dumps(rec, sort_keys=True)


class GuardsOffAndOn(unittest.TestCase):
    def cases(self):
        healthy_no_check = case_with([ev('e1', 'prior_record', output='tags: Some Item')], app='sonarr')
        return healthy_no_check

    def test_guards_off_is_byte_identical_and_adds_no_key(self):
        case = self.cases()
        replies = [th.decision('healthy', 'none', refs=['e1'])]
        a, ts1 = run_case(case, replies)
        b, ts2 = run_case(case, replies, guards=None)
        self.assertNotIn('guard', a)
        self.assertEqual(rec_for_compare(a), rec_for_compare(b))
        self.assertEqual((a['decision']['class'], a['decision']['action']), ('healthy', 'none'))
        ts1.cleanup(); ts2.cleanup()

    def test_guards_off_record_has_the_same_fields_as_a_committed_dev_c3_record(self):
        committed = sorted((th.COMPONENT / 'runs' / 'dev-c3' / 'devc3-v3d-haiku-5-5').glob('*-*-*.json'))
        if not committed:
            self.skipTest('committed dev-c3 runs not present')
        want = set(json.loads(committed[0].read_text()))
        got, ts = run_case(self.cases(), [th.decision('healthy', 'none', refs=['e1'])], prompt='v3')
        self.assertEqual(set(got) | {'run_id'}, want)   # main() adds run_id; run_case does not
        ts.cleanup()

    def test_guards_on_changes_only_the_fields_derived_from_the_decision(self):
        case = self.cases()
        replies = [th.decision('healthy', 'none', refs=['e1'])]
        off, ts1 = run_case(case, replies)
        on, ts2 = run_case(case, replies, guards='v1')
        self.assertEqual(on['guard']['final_changed'], True)
        self.assertEqual(on['guard']['applied'][0]['original'], off['decision'])
        self.assertEqual((on['decision']['class'], on['decision']['action']), ('insufficient_evidence', 'escalate'))
        self.assertFalse(on['forced'])                 # forced keeps its meaning: the harness forced it after a failed repair
        self.assertTrue(on['final_decision_valid'])
        self.assertTrue(on['first_try_valid'])
        same = {k for k in on if k not in ('guard', 'decision', 'action_audit', 'decision_flags', 'evidence', 'started_at', 'wall', 'turns', 'tool_calls',
                                          'refs_to_non_ok_tools', 'bad_evidence_refs', 'refs_to_failed_tools', 'write_rejection')}
        for k in same:
            self.assertEqual(json.dumps(on[k], sort_keys=True), json.dumps(off[k], sort_keys=True), k)
        self.assertEqual(on['action_audit']['execution_status'], 'no_write_proposed')
        self.assertEqual(off['decision_flags'], ['healthy_with_unverified_parts', 'none_with_unverified_parts'] if off['unverified_parts'] else [])
        ts1.cleanup(); ts2.cleanup()

    def test_guards_on_with_nothing_to_fire_equals_off_plus_the_guard_field(self):
        case = case_with([ev('e1', 'ffprobe')])
        replies = [th.decision('healthy', 'none', refs=['e1'])]
        off, ts1 = run_case(case, replies)
        on, ts2 = run_case(case, replies, guards='v1')
        self.assertEqual(on['guard'], {'version': 'v1', 'applied': [], 'final_changed': False})
        on.pop('guard')
        self.assertEqual(rec_for_compare(on), rec_for_compare(off))
        ts1.cleanup(); ts2.cleanup()

    def test_a_guarded_write_becomes_an_escalation_with_the_original_kept(self):
        case = case_with([ev('e1', 'epub_inspect', 'partial')], app='bookshelf', truth='corrupt_file', supported=('blocklist_and_search',))
        replies = [wdecision(target='item-file.bin', refs=['e1'])]
        on, ts = run_case(case, replies, guards='v1')
        self.assertEqual(on['guard']['applied'][0]['rule'], 'G-write')
        self.assertEqual(on['guard']['applied'][0]['original']['action'], 'blocklist_and_search')
        self.assertEqual(on['decision']['action'], 'escalate')
        self.assertEqual(on['action_audit']['execution_status'], 'no_write_proposed')
        self.assertFalse(on['action_audit']['executed'])
        self.assertEqual(on['write_rejection']['rejected_write_attempts'], 0)
        ts.cleanup()

    def test_restore_original_is_the_inverse_view(self):
        case = self.cases()
        off, ts1 = run_case(case, [th.decision('healthy', 'none', refs=['e1'])])
        on, ts2 = run_case(case, [th.decision('healthy', 'none', refs=['e1'])], guards='v1')
        back = DG.restore_original(on, case, R.resolve_evidence(case, ts2.root))
        for k in ('decision', 'action_audit', 'decision_flags', 'refs_to_non_ok_tools', 'bad_evidence_refs', 'evidence'):
            self.assertEqual(json.dumps(back[k], sort_keys=True), json.dumps(off[k], sort_keys=True), k)
        self.assertTrue(back['guard']['restored'])
        with self.assertRaises(ValueError):
            DG.restore_original(off, case, [])
        ts1.cleanup(); ts2.cleanup()

    def test_in_run_and_offline_guards_agree(self):
        case = self.cases()
        replies = [th.decision('healthy', 'none', refs=['e1'])]
        off, ts1 = run_case(case, replies)
        on, ts2 = run_case(case, replies, guards='v1')
        offline = DG.apply_to_record(off, case, R.resolve_evidence(case, ts1.root))
        for k in ('guard', 'decision', 'action_audit', 'decision_flags', 'bad_evidence_refs', 'refs_to_failed_tools', 'refs_to_non_ok_tools', 'evidence'):
            self.assertEqual(json.dumps(on[k], sort_keys=True), json.dumps(offline[k], sort_keys=True), k)
        # a guarded record is re-based on the model's own decision: guarding twice equals guarding once, and another version can be applied
        again = DG.apply_to_record(offline, case, R.resolve_evidence(case, ts1.root))
        self.assertEqual(json.dumps(again, sort_keys=True), json.dumps(offline, sort_keys=True))
        v2 = DG.apply_to_record(offline, case, R.resolve_evidence(case, ts1.root), 'v2')
        self.assertEqual(v2['guard']['version'], 'v2')
        self.assertEqual(v2['guard']['applied'][0]['original'], off['decision'])
        ts1.cleanup(); ts2.cleanup()


class MainAndTool(unittest.TestCase):
    def run_main(self, cases, replies, extra=()):
        ts = th.TempSuite(cases)
        out = Path(tempfile.mkdtemp()) / 'runs' / 'r1'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', replies)
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v4'] + list(extra))
        finally:
            R.build_adapter = orig
        return code, out, ts

    def test_flag_default_off_config_and_summary(self):
        cases = [case_with([ev('e1', 'prior_record')])]
        replies = [th.decision('healthy', 'none', refs=['e1'])]
        code, off, ts = self.run_main(cases, replies)
        self.assertEqual(code, 0)
        man_off = json.loads((off / 'manifest.json').read_text())
        self.assertNotIn('guards', man_off['config'])                  # a run without guards keeps the same config shape (and hash inputs)
        self.assertNotIn('guards', json.loads((off / 'run_summary.json').read_text()))
        self.assertNotIn('guard', json.loads((off / 'g1.json').read_text()))
        code, on, ts2 = self.run_main(cases, replies, ['--guards', 'v1'])
        man_on = json.loads((on / 'manifest.json').read_text())
        self.assertEqual(man_on['config']['guards'], 'v1')
        self.assertNotEqual(man_on['config_hash'], man_off['config_hash'])
        s = json.loads((on / 'run_summary.json').read_text())
        self.assertEqual(s['guards'], {'version': 'v1', 'applied_by_rule': {'G-healthy': 1}, 'decisions_changed': 1})
        self.assertEqual(R.record_missing_fields(json.loads((on / 'g1.json').read_text())), [])
        ts.cleanup(); ts2.cleanup()

    def test_mrh_guard_refuses_a_record_whose_case_hash_differs_from_the_suite_case(self):
        cases = [case_with([ev('e1', 'prior_record')])]
        code, run, ts = self.run_main(cases, [th.decision('healthy', 'none', refs=['e1'])])
        rec = json.loads((run / 'g1.json').read_text())
        self.assertEqual(rec['case_sha256'], R.sha256_bytes((ts.root / 'cases' / 'g1.json').read_bytes()))   # the real run recorded the suite file's hash
        guard_cli.guard_run(run, ts.root, Path(tempfile.mkdtemp()) / 'ok')
        for bad in ('0' * 64, None):
            tampered = Path(tempfile.mkdtemp()) / 'run'
            tampered.mkdir()
            (tampered / 'manifest.json').write_text((run / 'manifest.json').read_text())
            rec2 = dict(rec, case_sha256=bad)
            if bad is None:
                rec2.pop('case_sha256')
            (tampered / 'g1.json').write_text(json.dumps(rec2))
            with self.assertRaises(SystemExit) as cm:
                guard_cli.guard_run(tampered, ts.root, Path(tempfile.mkdtemp()) / 'out')
            self.assertIn('case_sha256', str(cm.exception))
        ts.cleanup()

    def test_restore_does_not_carry_the_source_guard_metadata(self):
        cases = [case_with([ev('e1', 'prior_record')]), dict(case_with([ev('e1', 'ffprobe')]), id='g2')]
        replies = [th.decision('healthy', 'none', refs=['e1']), th.decision('healthy', 'none', refs=['e1'])]
        code, run, ts = self.run_main(cases, replies, ['--guards', 'v1'])
        src_summary = json.loads((run / 'run_summary.json').read_text())
        self.assertEqual(src_summary['guards']['decisions_changed'], 1)
        self.assertEqual(json.loads((run / 'manifest.json').read_text())['config']['guards'], 'v1')
        out = Path(tempfile.mkdtemp()) / 'restored'
        guard_cli.guard_run(run, ts.root, out, restore=True)
        # the restored copies hold the model's own decisions: no stale "1 decision changed" and no stale guard setting
        self.assertEqual(json.loads((out / 'run_summary.json').read_text())['guards'], {'version': None, 'restored_from': 'v1', 'decisions_changed': 0})
        man = json.loads((out / 'manifest.json').read_text())
        self.assertNotIn('guards', man['config'])
        self.assertEqual((man['guard_whatif']['guards'], man['guard_whatif']['source_guards'], man['guard_whatif']['restore']), (None, 'v1', True))
        g1 = json.loads((out / 'g1.json').read_text())
        self.assertEqual(g1['decision']['action'], 'none')
        self.assertTrue(g1['guard']['restored'])
        self.assertEqual(json.loads((run / 'manifest.json').read_text())['config']['guards'], 'v1')      # the source is untouched
        # re-guarding a guarded run with another version records that version, not the source's
        out2 = Path(tempfile.mkdtemp()) / 'reguarded'
        guard_cli.guard_run(run, ts.root, out2, version='v2')
        self.assertEqual(json.loads((out2 / 'manifest.json').read_text())['config']['guards'], 'v2')
        self.assertEqual(json.loads((out2 / 'run_summary.json').read_text())['guards']['version'], 'v2')
        # a run that never had guards gets no invented block on restore
        code, plain, ts2 = self.run_main(cases[:1], replies[:1])
        self.assertRaises(ValueError, guard_cli.guard_run, plain, ts2.root, Path(tempfile.mkdtemp()) / 'x', True)    # nothing to restore: no guard field
        ts.cleanup(); ts2.cleanup()

    def test_guards_v2_is_selectable_in_run_and_recorded(self):
        cases = [case_with([ev('e1', 'prior_record')])]
        code, on, ts = self.run_main(cases, [th.decision('healthy', 'none', refs=['e1'])], ['--guards', 'v2'])
        self.assertEqual(json.loads((on / 'manifest.json').read_text())['config']['guards'], 'v2')
        self.assertEqual(json.loads((on / 'g1.json').read_text())['guard']['version'], 'v2')
        self.assertEqual(json.loads((on / 'run_summary.json').read_text())['guards']['version'], 'v2')
        ts.cleanup()

    def test_mrh_guard_copies_never_modifies_and_the_copy_scores(self):
        cases = [case_with([ev('e1', 'prior_record')]), dict(case_with([ev('e1', 'ffprobe')]), id='g2')]
        replies = [th.decision('healthy', 'none', refs=['e1']), th.decision('healthy', 'none', refs=['e1'])]
        code, run, ts = self.run_main(cases, replies)
        before = {p.name: p.read_bytes() for p in run.iterdir()}
        out = Path(tempfile.mkdtemp()) / 'guarded'
        res = guard_cli.guard_run(run, ts.root, out)
        self.assertEqual({p.name: p.read_bytes() for p in run.iterdir()}, before)      # the source run is untouched
        self.assertEqual((res['records'], [c['case_id'] for c in res['changed']], res['by_rule']), (2, ['g1'], {'G-healthy': 1}))
        g1 = json.loads((out / 'g1.json').read_text())
        self.assertEqual(g1['decision']['action'], 'escalate')
        self.assertEqual(g1['guard']['applied'][0]['original']['action'], 'none')
        self.assertEqual(json.loads((out / 'g2.json').read_text())['guard']['final_changed'], False)
        man = json.loads((out / 'manifest.json').read_text())
        self.assertEqual((man['guard_whatif']['offline'], man['guard_whatif']['model_calls']), (True, 0))
        self.assertEqual(json.loads((out / 'run_summary.json').read_text())['guards']['decisions_changed'], 1)
        self.assertEqual(len((out / 'audit.jsonl').read_text().splitlines()), 2)
        with self.assertRaises(SystemExit):
            guard_cli.guard_run(run, ts.root, out)                                      # a non-empty output directory is refused
        # the unchanged evaluator scorer reads the copy
        score = __import__('media_repair_harness.score_compat', fromlist=['x'])
        try:
            sc = score.load_score().score
        except FileNotFoundError:
            sc = None
        if sc is not None:
            s = sc(out, ts.root)
            self.assertEqual(s['cases']['g1']['action'], 'escalate')
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
