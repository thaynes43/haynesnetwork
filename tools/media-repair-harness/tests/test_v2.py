"""dev-c1 tests: prompt v2, first-try failure modes, protocol violations, honest first-try validity, leak guard on generic text,
action audit, run records and summary.  Fake model replies only (ScriptedAdapter); no model, no network."""
import json
import re
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import adapters as A
from media_repair_harness import audit as AU
from media_repair_harness import leakguard as L
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th

HERE = Path(__file__).resolve().parent
SUITE_CASES = th.SUITE / 'cases'
REGRESSION = HERE / 'testdata' / 'regression'


def audit_obj(target='rel-1', pre=('e1 shows a damaged archive',), readback='read the entry back', verify='the entry is gone from the queue'):
    return {'target': target, 'preconditions': list(pre), 'readback': readback, 'verify': verify}


def wdecision(cls='corrupt_file', action='blocklist_and_search', target='rel-1', refs=None, audit=True, **kw):
    d = th.decision(cls, action, refs=refs if refs is not None else ['e1'], target=target, **kw)
    if audit:
        d['audit'] = audit_obj(target) if audit is True else audit
    return d


def run_v2(case, replies, suite=None, **kw):
    ts = suite or th.TempSuite([case])
    ad = A.ScriptedAdapter('scripted-1', replies)
    kw.setdefault('which', th.NO_BINARIES)
    rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version='v2', run_id='r', **kw)
    return rec, ad, ts


def v2_case(**kw):
    kw.setdefault('evidence', [{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': 'archive damaged: rel-1 cannot be read'}])
    kw.setdefault('context', {'title': 'Some Book', 'expected': {}, 'arr': {'app': 'bookshelf', 'ids': {'releaseId': 'rel-1'}}, 'notes_for_model': 'n'})
    return th.make_case(truth='corrupt_file', supported=('blocklist_and_search', 'escalate'), **kw)


def words(text):
    return re.compile(r'(?<![A-Za-z0-9])' + re.escape(text) + r'(?![A-Za-z0-9])', re.I)


class PromptV2(unittest.TestCase):
    def test_version_and_sha256(self):
        p = P.get_prompt('v2')
        self.assertEqual(p['version'], 'v2')
        import hashlib
        self.assertEqual(p['sha256'], hashlib.sha256(p['text'].encode()).hexdigest())
        self.assertNotEqual(p['sha256'], P.get_prompt('v1')['sha256'])
        self.assertEqual(P.get_prompt('v2')['sha256'], p['sha256'])   # stable
        rec, _, ts = run_v2(th.make_case(), [th.decision()])
        self.assertEqual((rec['prompt']['version'], rec['prompt']['sha256']), ('v2', p['sha256']))
        self.assertEqual(rec['harness_version'], 'dev-c8')
        ts.cleanup()

    def test_every_class_and_action_is_defined_by_its_change_and_prerequisites(self):
        text = P.get_prompt('v2')['text']
        for name in P.CLASSES + P.ACTIONS:
            self.assertRegex(text, r'(?m)^- %s: ' % name, name)
        rename = re.search(r'(?m)^- rename: (.*)$', text).group(1)
        remap = re.search(r'(?m)^- remap: (.*)$', text).group(1)
        # rename changes the name only, needs verified identity, and can be undone; remap changes the link and needs a free target slot
        for needle in ('name', 'same item', 'verified identity', 'rename'):
            self.assertIn(needle, rename)
        for needle in ('linked', 'free', 'Read back'):
            self.assertIn(needle, remap)
        self.assertIn('unverified', text)
        self.assertIn('never healthy', text)
        self.assertIn('escalate', text)

    def test_prompt_states_the_status_meanings(self):
        text = P.get_prompt('v2')['text']
        for st in ('ok', 'partial', 'error', 'timeout', 'unavailable'):
            self.assertRegex(text, r'(?m)^- %s: ' % st)

    @th.needs_suite
    def test_prompt_contains_no_suite_ids_titles_or_filenames(self):
        text = P.get_prompt('v2')['text']
        n = 0
        for f in sorted(SUITE_CASES.glob('*.json')):
            c = json.loads(f.read_text())
            tokens = {c['id'], re.sub(r'-\d+$', '', c['id']), c.get('family')}
            ctx = c.get('context') or {}
            tokens |= {ctx.get('title'), ctx.get('filename'), Path(str((c.get('fixture') or {}).get('locator') or '')).name}
            for tok in sorted(t for t in tokens if t and len(t) >= 4):
                self.assertIsNone(words(tok).search(text), 'prompt v2 contains %r from %s' % (tok, f.name))
            n += 1
        self.assertGreaterEqual(n, 60)
        for f in sorted((REGRESSION / 'cases').glob('*.json')):
            c = json.loads(f.read_text())
            for tok in (c['id'], (c['context'] or {}).get('title')):
                self.assertIsNone(words(tok).search(text), tok)

    @th.needs_suite
    def test_check_system_passes_the_prompt_for_every_case_and_catches_a_tailored_one(self):
        text = P.get_prompt('v2')['text']
        paths = sorted(SUITE_CASES.glob('*.json')) + sorted((REGRESSION / 'cases').glob('*.json'))
        for f in paths:
            c = json.loads(f.read_text())
            L.check_system(c, text)   # generic class / action / schema definitions never trip the guard
        c = json.loads(paths[0].read_text())
        for bad in (c['id'], Path(str(c['fixture'].get('locator') or 'x.bin')).name):
            if bad and len(bad) >= L.SYSTEM_MIN_LEN:
                with self.assertRaises(L.LeakError):
                    L.check_system(c, text + '\nExample: ' + bad)

    def test_a_tailored_system_prompt_is_a_harness_error_not_a_model_miss(self):
        case = th.make_case('secret-case-001')
        ad = A.ScriptedAdapter('m', [th.decision()])
        ts = th.TempSuite([case])
        orig = P.get_prompt
        P.get_prompt = lambda v='v2': dict(orig(v), text=orig(v)['text'] + ' see secret-case-001')
        try:
            rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version='v2', run_id='r', which=th.NO_BINARIES)
        finally:
            P.get_prompt = orig
        self.assertEqual(rec['error']['kind'], 'harness_crash')
        self.assertTrue(rec['error']['leak_guard'])
        self.assertTrue(rec['forced'])
        self.assertEqual(ad.calls, [])   # nothing was sent
        ts.cleanup()


class StructuredOutput(unittest.TestCase):
    def test_single_value_enums_and_per_case_tool_enum(self):
        s = P.turn_schema('v2', ['ffprobe', 'arr_lookup'])
        tc, nowrite, write = s['anyOf']
        self.assertEqual(tc['properties']['tool']['enum'], ['ffprobe', 'arr_lookup'])
        self.assertEqual(tc['properties']['type']['enum'], ['tool_call'])
        self.assertEqual(nowrite['properties']['action']['enum'], ['none', 'escalate'])
        self.assertEqual(write['properties']['action']['enum'], list(P.WRITE_ACTIONS))
        self.assertIn('audit', write['required'])
        self.assertNotIn('audit', nowrite['properties'])
        for sub in (tc, nowrite, write):
            self.assertFalse(sub['additionalProperties'])
            self.assertEqual(sub['required'][0], 'type')

    def test_flat_fallback_keeps_the_enums(self):
        f = P.turn_schema('v2', ['ffprobe'], flat=True)
        self.assertEqual(f['properties']['tool']['enum'], ['ffprobe'])
        self.assertEqual(f['properties']['action']['enum'], list(P.ACTIONS))
        self.assertEqual(f['required'], ['type'])

    def test_the_runner_hands_the_v2_schema_to_the_adapter(self):
        seen = {}

        class Spy(A.ScriptedAdapter):
            def complete(self, system, messages, schema=None):
                seen['schema'] = schema
                return super().complete(system, messages, schema)
        case = th.make_case(tools_available=['arr_lookup'])
        ts = th.TempSuite([case])
        R.run_case(case, 'sha', Spy('m', [th.decision()]), ts.root, tempfile.mkdtemp(), prompt_version='v2', run_id='r', which=th.NO_BINARIES)
        self.assertEqual(seen['schema']['anyOf'][0]['properties']['tool']['enum'], ['arr_lookup'])
        ts.cleanup()

    def test_v2_system_prompt_is_the_one_sent(self):
        rec, ad, ts = run_v2(th.make_case(), [th.decision()])
        self.assertEqual(rec['turns'][0]['raw_request']['system'], P.get_prompt('v2')['text'])
        ts.cleanup()


class FirstTryFailureModes(unittest.TestCase):
    """The recorded first-try failures, each as a general case."""

    def assert_miss_then_valid(self, bad_reply, mode, case=None):
        rec, ad, ts = run_v2(case or th.make_case(), [bad_reply, th.decision()])
        self.assertFalse(rec['first_try_valid'])
        self.assertFalse(rec['first_try']['valid'])
        self.assertFalse(rec['first_try']['first_reply_valid'])
        self.assertIn(mode, rec['first_try']['failure_modes'])
        self.assertIn(mode, rec['turns'][0]['failure_modes'])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertIn(mode, rec['repair_prompts'][0]['failure_modes'])
        # the repaired reply is a separately recorded later attempt and never rescues the first try
        self.assertEqual([t['attempt'] for t in rec['turns']], ['first', 'repair'])
        self.assertTrue(rec['turns'][1]['reply_valid'])
        self.assertFalse(rec['forced'])
        self.assertTrue(rec['final_decision_valid'])
        self.assertTrue(rec['first_try']['valid_after_repair'])
        self.assertNotIn('error', rec)   # no crash, in particular no leak-guard false positive on the generic repair prompt
        self.assertIn('Your last reply was rejected', ad.calls[1][-1]['content'])
        ts.cleanup()
        return rec, ad

    def test_compound_action_string(self):
        for combined in ('remap and rename', 'remap+rename', 'rename, remap', 'blocklist_and_search then convert'):
            rec, ad = self.assert_miss_then_valid(th.decision('metadata_naming', 'none', action=combined) if False else dict(th.decision(), action=combined), 'compound_action')
            self.assertIn('ONE value', ad.calls[1][-1]['content'])

    def test_unknown_single_action_is_not_called_compound(self):
        rec, _ = self.assert_miss_then_valid(dict(th.decision(), action='delete'), 'unknown_action')
        self.assertNotIn('compound_action', rec['first_try']['failure_modes'])

    def test_stray_comma_quote_close(self):
        text = json.dumps(th.decision())
        stray = text[:-1] + ',"}'     # ..."reason": "r","}   (the string is closed, then a stray quote opens a key)
        self.assertIsNone(P.parse_reply(stray)[0])
        rec, ad = self.assert_miss_then_valid(stray, 'stray_comma_quote_close')
        self.assertIn('one double-quote character', ad.calls[1][-1]['content'])
        self.assertNotIn('single quote', ad.calls[1][-1]['content'])
        self.assertEqual(rec['turns'][0]['diagnostics']['salvageable_by'], ['stray_comma_quote_close'])   # diagnostics only: never accepted

    def test_missing_type_key(self):
        d = th.tool_call('arr_lookup')
        del d['type']
        rec, ad = self.assert_miss_then_valid(d, 'missing_type')
        self.assertIn('"type"', ad.calls[1][-1]['content'])
        d2 = th.decision()
        del d2['type']
        self.assert_miss_then_valid(d2, 'missing_type')

    def test_keys_copied_from_the_tool_result_envelope(self):
        bad = dict(th.decision(), tool_calls_remaining=5, status='ok')
        rec, ad = self.assert_miss_then_valid(bad, 'envelope_keys_copied')
        self.assertIn('Do not copy fields', ad.calls[1][-1]['content'].replace('do not copy fields', 'Do not copy fields'))
        rec, _ = self.assert_miss_then_valid(dict(type='tool_result', id='t1', tool='arr_lookup', status='ok', output='x', tool_calls_remaining=3), 'echoed_tool_result')

    def test_fence_and_prose_are_misses_with_a_mode(self):
        self.assert_miss_then_valid('```json\n' + json.dumps(th.decision()) + '\n```', 'fence_wrapped')
        self.assert_miss_then_valid('Sure: ' + json.dumps(th.decision()), 'prose_around_object')

    def test_write_action_without_audit(self):
        d = wdecision(audit=False)
        rec, _ = self.assert_miss_then_valid(d, 'audit_missing', case=v2_case())

    def test_second_invalid_reply_is_forced_and_still_not_first_try(self):
        rec, _, ts = run_v2(th.make_case(), ['nope', dict(th.decision(), action='remap and rename')])
        self.assertTrue(rec['forced'])
        self.assertFalse(rec['first_try_valid'])
        self.assertFalse(rec['final_decision_valid'])
        self.assertFalse(rec['first_try']['valid_after_repair'])
        ts.cleanup()

    def test_adapter_error_is_not_first_try_valid(self):
        rec, _, ts = run_v2(th.make_case(), [A.AdapterError('timeout')])
        self.assertFalse(rec['first_try_valid'])
        self.assertEqual(rec['turns'][0]['failure_modes'], ['adapter_error'])
        self.assertEqual(rec['error']['kind'], 'adapter_error')
        ts.cleanup()

    def test_clean_run_is_first_try_valid(self):
        rec, _, ts = run_v2(th.make_case(), [th.tool_call('arr_lookup'), th.decision(refs=['t1'])])
        self.assertTrue(rec['first_try_valid'])
        self.assertEqual(rec['first_try']['failure_modes'], [])
        self.assertEqual([t['attempt'] for t in rec['turns']], ['first', 'first'])
        ts.cleanup()


class ProtocolViolations(unittest.TestCase):
    def test_tool_outside_tools_available_is_recorded_and_answered_not_repaired(self):
        case = th.make_case(tools_available=['arr_lookup'])
        rec, ad, ts = run_v2(case, [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        self.assertEqual(rec['repair_prompts'], [])
        self.assertNotIn('error', rec)
        call = rec['tool_calls'][0]
        self.assertEqual((call['status'], call['protocol_violation']), ('unavailable', 'tool_not_offered'))
        self.assertEqual(rec['protocol_violations'][0]['kind'], 'tool_not_offered')
        self.assertEqual(rec['turns'][0]['failure_modes'], ['tool_not_offered'])
        reply = json.loads(ad.calls[1][-1]['content'])
        self.assertEqual((reply['type'], reply['status']), ('tool_result', 'unavailable'))
        self.assertIn('arr_lookup', reply['output'])      # tells the model what is offered
        self.assertFalse(rec['first_try_valid'])          # a violation is not a clean first try
        self.assertTrue(rec['final_decision_valid'])
        self.assertFalse(rec['forced'])
        self.assertEqual(R.record_missing_fields(dict(rec, harness_git_sha='x', config_hash='h')), [])
        ts.cleanup()

    def test_a_violation_uses_up_one_of_the_six_calls(self):
        case = th.make_case(tools_available=['arr_lookup'])
        rec, _, ts = run_v2(case, [th.tool_call('ffprobe') for _ in range(7)])
        self.assertEqual(len(rec['tool_calls']), 6)
        self.assertTrue(rec['forced'])
        self.assertEqual(len(rec['protocol_violations']), 6)
        ts.cleanup()

    def test_unknown_tool_names_are_violations_and_never_echoed(self):
        # a tool name that is also a class / action label must not trip the leak guard (generic words, model-chosen)
        case = th.make_case(truth='metadata_naming', supported=('rename',), tools_available=['arr_lookup'])
        for name in ('rename', 'metadata_naming', 'shell', 'rm -rf /'):
            bad = dict(th.tool_call('arr_lookup'), tool=name)
            rec, ad, ts = run_v2(case, [bad, th.decision('insufficient_evidence', 'escalate')])
            self.assertNotIn('error', rec, name)
            self.assertEqual(rec['protocol_violations'][0]['kind'], 'tool_not_offered')
            self.assertNotIn(name, ad.calls[1][-1]['content'])
            ts.cleanup()

    def test_v1_keeps_its_checkpoint_1_behavior(self):
        case = th.make_case(tools_available=['arr_lookup'])
        ts = th.TempSuite([case])
        ad = A.ScriptedAdapter('m', [th.tool_call('ffprobe'), th.decision()])
        rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), which=th.NO_BINARIES)
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertEqual(rec['tool_calls'], [])
        ts.cleanup()


class LeakGuardGenericText(unittest.TestCase):
    def test_repair_prompt_listing_classes_and_actions_never_trips_the_guard(self):
        case = th.make_case(truth='identity_mismatch', supported=('remap', 'rename', 'blocklist_and_search', 'convert'))
        err = 'action must be exactly one of %s (one value, never a combination); class must be one of %s' % (list(P.ACTIONS), list(P.CLASSES))
        msgs = [{'role': 'user', 'content': '{}'}, {'role': 'assistant', 'content': 'x'},
                {'role': 'user', 'content': P.repair_prompt(err, ['compound_action', 'missing_type', 'stray_comma_quote_close'])}]
        L.check_messages(case, msgs, [])   # no raise

    def test_case_specific_tokens_in_a_repair_prompt_are_still_caught(self):
        case = th.make_case('movie-corrupt-001', family='fam-x')
        for leak in ('movie-corrupt-001', 'movie-corrupt', 'fam-x'):
            msgs = [{'role': 'user', 'content': P.repair_prompt('bad ' + leak)}]
            with self.assertRaises(L.LeakError):
                L.check_messages(case, msgs, [])

    def test_case_specific_tokens_in_tool_output_and_labels_in_case_text_are_still_caught(self):
        case = th.make_case('tv-secret-003', truth='corrupt_file', supported=('blocklist_and_search',))
        case['fixture'] = {'kind': 'local', 'locator': 'media/ep_flip.mkv'}
        for text in ('ep_flip.mkv failed', 'case tv-secret-003', 'class corrupt_file', 'do blocklist_and_search'):
            with self.assertRaises(L.LeakError, msg=text):
                L.check_messages(case, [{'role': 'user', 'content': '{"type":"tool_result","output":"%s"}' % text}], [])

    def test_a_repair_run_on_a_case_whose_labels_equal_the_generic_words_does_not_crash(self):
        case = th.make_case(truth='metadata_naming', supported=('rename',))
        rec, _, ts = run_v2(case, [dict(th.decision(), action='rename and remap'), th.decision('insufficient_evidence', 'escalate')])
        self.assertNotIn('error', rec)
        self.assertFalse(rec['forced'])
        ts.cleanup()


class ActionAudit(unittest.TestCase):
    def test_every_write_proposal_has_an_audit_object_and_is_never_executed(self):
        for cls, action in (('corrupt_file', 'blocklist_and_search'), ('identity_mismatch', 'remap'), ('metadata_naming', 'rename'), ('decoder_incompatible', 'convert')):
            case = v2_case(context={'title': 'Some Book', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {}}, 'client_profile': 'a small player', 'notes_for_model': 'n'})
            d = wdecision(cls, action, target='rel-1', audit=audit_obj('rel-1', ('e1: the slot is free', 'e1: keep the original name, rename back if needed'),
                                                                       'read the entry back', 'the original stays untouched'))
            rec, _, ts = run_v2(case, [d])
            a = rec['action_audit']
            self.assertEqual(a['execution_status'], 'proposed_not_executed', action)
            self.assertIs(a['executed'], False)
            self.assertTrue(a['write_intent'])
            self.assertEqual((a['intent']['action'], a['target']), (action, 'rel-1'))
            self.assertEqual(a['readback_plan'], 'read the entry back')
            self.assertEqual(a['verification_plan'], 'the original stays untouched')
            self.assertEqual(a['audit']['target'], 'rel-1')
            self.assertTrue(a['preconditions'])
            for c in a['preconditions']:
                self.assertEqual(set(c), {'id', 'met', 'basis', 'detail'})
                self.assertIsInstance(c['met'], bool)
                self.assertIn(c['basis'], ('computed', 'claim_text'))
            ts.cleanup()

    def test_preconditions_are_computed_met_and_unmet(self):
        case = v2_case()
        rec, _, ts = run_v2(case, [wdecision()])
        a = rec['action_audit']
        got = {c['id']: c['met'] for c in a['preconditions']}
        self.assertTrue(all(got.values()), got)
        self.assertFalse(a['preconditions_unmet'])
        self.assertEqual(a['unmet'], [])
        ts.cleanup()
        # no *arr in the context, wrong class for the action, unknown target, uncited evidence
        case = v2_case(context={'title': 'Some Book', 'expected': {}, 'arr': {'app': None, 'ids': {}}, 'notes_for_model': 'n'})
        rec, _, ts = run_v2(case, [wdecision('metadata_naming', 'blocklist_and_search', target='zzz-nothing-like-this', refs=[],
                                             audit=audit_obj('zzz-nothing-like-this', ('sonarr has the series',)))])
        a = rec['action_audit']
        self.assertTrue(a['preconditions_unmet'])
        for need in ('class_matches_action', 'target_in_context', 'positive_evidence_cited', 'arr_app_present', 'claim:sonarr_not_in_context'):
            self.assertIn(need, a['unmet'])
        self.assertIs(a['executed'], False)
        ts.cleanup()

    def test_a_failed_tool_cited_as_support_is_unmet_but_a_reported_finding_is_not(self):
        case = v2_case(tools_available=['epub_inspect'], inject_tool_failure={'tool': 'epub_inspect', 'mode': 'timeout'})
        rec, _, ts = run_v2(case, [th.tool_call('epub_inspect'), wdecision(refs=['t1'])])
        self.assertEqual(rec['tool_calls'][0]['status'], 'timeout')
        self.assertIn('no_failed_tool_cited', rec['action_audit']['unmet'])
        self.assertIn('cited_evidence_supports', rec['action_audit']['unmet'])
        ts.cleanup()
        self.assertFalse(AU.usable_as_support('timeout', 'x'))
        self.assertFalse(AU.usable_as_support('partial', 'x'))
        self.assertFalse(AU.usable_as_support('unavailable', 'x'))
        self.assertFalse(AU.usable_as_support('error', 'ffprobe failed: could not run'))
        self.assertFalse(AU.usable_as_support('error', json.dumps({'exit_code': 1}), injected=True))
        self.assertTrue(AU.usable_as_support('error', json.dumps({'exit_code': 1, 'stderr': 'moov atom not found'})))
        self.assertTrue(AU.usable_as_support('error', json.dumps({'status': 'error', 'stage': 'zip_open'})))
        self.assertTrue(AU.usable_as_support('ok', 'anything'))

    def test_claims_the_harness_cannot_check_are_labelled_as_claims(self):
        case = v2_case(context={'title': 'Some Book', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {}}, 'notes_for_model': 'n'})
        rec, _, ts = run_v2(case, [wdecision('identity_mismatch', 'remap', audit=audit_obj('rel-1', ('e1 matches the other episode',)))])
        slot = [c for c in rec['action_audit']['preconditions'] if c['id'] == 'target_slot_stated_free'][0]
        self.assertFalse(slot['met'])
        self.assertEqual(slot['basis'], 'claim_text')
        ts.cleanup()
        rec, _, ts = run_v2(case, [wdecision('identity_mismatch', 'remap', audit=audit_obj('rel-1', ('e1: the target slot is free',)))])
        slot = [c for c in rec['action_audit']['preconditions'] if c['id'] == 'target_slot_stated_free'][0]
        self.assertTrue(slot['met'])
        self.assertEqual(slot['basis'], 'claim_text')   # met = the claim was made, not that it is true
        self.assertIn('nothing in the case can confirm', slot['detail'])
        ts.cleanup()

    def test_no_write_gets_no_write_status(self):
        for d in (th.decision(), th.decision('insufficient_evidence', 'escalate')):
            rec, _, ts = run_v2(th.make_case(), [d])
            a = rec['action_audit']
            self.assertEqual((a['execution_status'], a['executed'], a['write_intent'], a['preconditions']), ('no_write_proposed', False, False, []))
            ts.cleanup()

    def test_audit_target_must_equal_target_in_v2(self):
        case = v2_case()
        rec, _, ts = run_v2(case, [wdecision(audit=audit_obj('some-other-release')), wdecision()])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertIn('audit.target', rec['repair_prompts'][0]['error'])
        ts.cleanup()

    def test_validate_turn_v2_audit_shape(self):
        ok = wdecision()
        self.assertEqual(P.validate_turn(ok, None, 'v2'), ('decision', []))
        for bad in (dict(ok, audit={'target': 'rel-1'}), dict(ok, audit='text'), dict(ok, audit=dict(audit_obj(), preconditions=[])),
                    dict(ok, audit=dict(audit_obj(), preconditions=['x'] * 7)), dict(ok, audit=dict(audit_obj(), extra=1))):
            self.assertIsNone(P.validate_turn(bad, None, 'v2')[0])
        self.assertEqual(P.validate_turn(dict(th.decision(), target=None), None, 'v2')[0], 'decision')

    def test_unverified_parts_and_healthy_flag(self):
        case = th.make_case(inject_tool_failure={'tool': 'ffprobe', 'mode': 'timeout'},
                            evidence=[{'id': 'e1', 'tool': 'decode_sample', 'args': {}, 'status': 'partial', 'output': 'cut'}])
        rec, _, ts = run_v2(case, [th.tool_call('ffprobe'), th.decision('healthy', 'none', refs=[])])
        self.assertEqual({(p['id'], p['status']) for p in rec['unverified_parts']}, {('t1', 'timeout'), ('e1', 'partial')})
        self.assertEqual(rec['decision_flags'], ['healthy_with_unverified_parts', 'none_with_unverified_parts'])
        self.assertEqual(rec['decision']['class'], 'healthy')   # flagged, never rewritten
        ts.cleanup()
        rec, _, ts = run_v2(case, [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        self.assertEqual(rec['decision_flags'], [])
        ts.cleanup()


class RecordsAndSummary(unittest.TestCase):
    def run_main(self, replies, cases, extra=()):
        ts = th.TempSuite(cases)
        out = Path(tempfile.mkdtemp()) / 'runs' / 'r1'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('scripted-1', replies)   # replies may hold exceptions
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'scripted-1', '--out', str(out),
                           '--scratch', tempfile.mkdtemp(), '--prompt', 'v2'] + list(extra))
        finally:
            R.build_adapter = orig
        return code, out, ts

    def test_record_carries_every_required_field(self):
        code, out, ts = self.run_main([th.tool_call('arr_lookup'), th.decision(refs=['t1'])], [th.make_case('a')])
        self.assertEqual(code, 0)
        rec = json.loads((out / 'a.json').read_text())
        self.assertEqual(R.record_missing_fields(rec), [])
        manifest = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(rec['harness_version'], 'dev-c8')
        self.assertEqual(manifest['harness_version'], 'dev-c8')
        self.assertEqual(manifest['config']['harness_version'], 'dev-c8')
        self.assertEqual(rec['config_hash'], manifest['config_hash'])
        self.assertEqual(rec['harness_git_sha'], manifest['harness_git']['sha'])
        self.assertEqual(manifest['config']['system_prompt_sha256'], rec['prompt']['sha256'])
        self.assertEqual((rec['prompt']['turn_schema_sha256'], rec['prompt']['schema_sent']), (None, False))   # scripted sends no schema
        self.assertIn('fixture', rec['fixture_hashes'])
        self.assertEqual(rec['response_model_ids'], ['scripted-1'])
        self.assertIn('input_tokens', rec['usage'])
        self.assertIn('total_s', rec['wall'])
        ts.cleanup()

    def test_incomplete_records_are_reported_not_hidden(self):
        code, out, ts = self.run_main([th.decision()], [th.make_case('a')])
        rec = json.loads((out / 'a.json').read_text())
        for k in ('harness_version', 'prompt', 'fixture_hashes', 'config_hash'):
            broken = {x: v for x, v in rec.items() if x != k}
            self.assertIn(k, R.record_missing_fields(broken))
        self.assertIn('prompt.sha256', R.record_missing_fields(dict(rec, prompt={'version': 'v2'})))
        ts.cleanup()

    def test_failed_runs_are_preserved_and_summarised(self):
        bad = th.make_case('bad', fixture={'kind': 'remote', 'locator': 'remote:not-a-valid-locator'})
        code, out, ts = self.run_main([A.AdapterError('boom'), th.decision()], [th.make_case('adapter-fail'), bad, th.make_case('good')])
        self.assertEqual(code, 0)
        self.assertEqual({p.name for p in out.glob('*.json')} - {'manifest.json', 'run_summary.json'}, {'adapter-fail.json', 'bad.json', 'good.json'})
        s = json.loads((out / 'run_summary.json').read_text())
        self.assertEqual(s['harness_version'], 'dev-c8')
        self.assertEqual(s['records_written'], 3)
        self.assertEqual(s['validity']['adapter_errors'], 1)
        self.assertEqual(s['validity']['crashes'], 1)
        self.assertEqual(s['validity']['first_try_valid'], 1)
        self.assertEqual(s['writes_executed'], 0)
        self.assertEqual(s['prompt']['version'], 'v2')
        self.assertTrue(s['prompt']['sha256'])
        self.assertTrue(s['records_complete'], s['incomplete_records'])
        self.assertNotIn('pass_rate', json.dumps(s))   # validity and completeness only
        ts.cleanup()

    def test_nothing_in_a_record_or_summary_claims_a_repair_happened(self):
        case = v2_case(id='a-write')
        code, out, ts = self.run_main([wdecision(), th.decision('insufficient_evidence', 'escalate')], [case, th.make_case('b')])
        claim = re.compile(r'\b(was|were|been|is|has been|successfully)\s+(repaired|renamed|remapped|converted|blocklisted|fixed|applied|executed|replaced)\b', re.I)
        for f in list(out.glob('*.json')) + [out / 'audit.jsonl']:
            text = f.read_text()
            self.assertIsNone(claim.search(text), f.name)
        for line in (out / 'audit.jsonl').read_text().splitlines():
            row = json.loads(line)
            self.assertIs(row['executed'], False)
            self.assertIn(row['execution_status'], ('proposed_not_executed', 'no_write_proposed'))
        rec = json.loads((out / (case['id'] + '.json')).read_text())
        self.assertEqual(rec['action_audit']['execution_status'], 'proposed_not_executed')
        self.assertIn('never executes a write', rec['action_audit']['note'])
        s = json.loads((out / 'run_summary.json').read_text())
        self.assertIn('executed no write', s['statement'])
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
