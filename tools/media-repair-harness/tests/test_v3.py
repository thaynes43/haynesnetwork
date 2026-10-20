"""dev-c3 tests: prompt v3 (new text on the unchanged v2 turn protocol), the managing-app value `lazylibrarian`, the record-only
`write_rejection` field, and the synthetic regression fixtures for the three v3 evidence rules.  Fake model replies only (ScriptedAdapter);
no model, no network.  What these tests can check is what the HARNESS does with the rules' evidence types and that the prompt TEXT carries
the rules and names no case; whether a model follows the text is measured by the evaluator, not here."""
import json
import os
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
from test_v2 import audit_obj, v2_case, wdecision

HERE = Path(__file__).resolve().parent
REGRESSION = HERE / 'testdata' / 'regression'
CTX = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
V11 = CTX / 'suite-dev-v1.1'


def need_both_suites():
    """dev-v1 and dev-v1.1.  A missing suite SKIPS, except under MRH_REQUIRE_SUITE=1 (CI), where it FAILS: 73 + 73 = 146 cases must be there."""
    th.require_suite()
    if not (V11 / 'cases').is_dir() or not any((V11 / 'cases').glob('*.json')):
        if os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError('dev-v1.1 suite not found at %s; MRH_REQUIRE_SUITE=1 forbids skipping' % V11)
        raise unittest.SkipTest('dev-v1.1 suite not found')
    return [th.SUITE, V11]


def load(cid):
    return json.loads((REGRESSION / 'cases' / (cid + '.json')).read_text())


def run_v3(cid_or_case, replies, prompt='v3'):
    case = load(cid_or_case) if isinstance(cid_or_case, str) else cid_or_case
    ad = A.ScriptedAdapter('scripted-1', replies)
    rec = R.run_case(case, 'sha', ad, REGRESSION if isinstance(cid_or_case, str) else Path(tempfile.mkdtemp()), tempfile.mkdtemp(),
                     prompt_version=prompt, run_id='r3', which=th.NO_BINARIES)
    rec.update(harness_git_sha='x', config_hash='h')
    return rec, ad


def call(tool, **args):
    return th.tool_call(tool, args)


def word(text):
    return re.compile(r'(?<![A-Za-z0-9])' + re.escape(text) + r'(?![A-Za-z0-9])', re.I)


def suite_cases(d):
    return [json.loads(p.read_text()) for p in sorted((Path(d) / 'cases').glob('*.json'))]


class PromptV3(unittest.TestCase):
    def setUp(self):
        self.v2 = P.get_prompt('v2')['text']
        self.v3 = P.get_prompt('v3')['text']

    def test_v3_is_selectable_and_the_default_does_not_move(self):
        self.assertIn('v3', P.PROMPT_VERSIONS)
        self.assertEqual(P.DEFAULT_PROMPT, 'v1')
        p = P.get_prompt('v3')
        self.assertEqual((p['version'], p['sha256'] == P.get_prompt('v3')['sha256']), ('v3', True))
        self.assertNotEqual(p['sha256'], P.get_prompt('v2')['sha256'])
        self.assertNotEqual(p['sha256'], P.get_prompt('v1')['sha256'])
        with self.assertRaises(ValueError):
            P.get_prompt('v6')

    def test_v3_speaks_the_v2_turn_protocol(self):
        self.assertEqual([P.protocol_of(v) for v in ('v1', 'v2', 'v3')], ['v1', 'v2', 'v2'])
        with self.assertRaises(ValueError):
            P.protocol_of('v9')
        self.assertEqual(P.turn_schema('v3', ['ffprobe']), P.turn_schema('v2', ['ffprobe']))
        w = wdecision()
        self.assertEqual(P.validate_turn(w, None, 'v3'), P.validate_turn(w, None, 'v2'))
        self.assertEqual(P.validate_turn(wdecision(audit=False), None, 'v3')[0], None)   # a write without its audit is rejected
        self.assertEqual(P.validate_turn(dict(th.decision(), audit=audit_obj()), None, 'v3')[0], None)   # an audit on none is rejected, not tolerated

    def test_reply_format_and_vocabulary_are_the_v2_ones(self):
        section = lambda t, a, b: t[t.index(a):t.index(b)]
        self.assertEqual(section(self.v3, 'CLASSES (', 'ACTIONS ('), section(self.v2, 'CLASSES (', 'ACTIONS ('))   # the class definitions are v2's, byte for byte
        self.assertEqual(self.v3[:self.v3.index('2. Final decision')].split('Results are bounded')[0], self.v2[:self.v2.index('2. Final decision')].split('Results are bounded')[0])
        for tok in P.CLASSES + P.ACTIONS + P.TOOLS:
            self.assertIn(tok, self.v3)

    def test_the_protocol_limits_are_stated_as_the_validator_enforces_them(self):
        # v2 stated only the 400-character reason; first-try rejections on the dev baseline were audit and reason length overruns
        for stated in ('audit.target at most 200 characters', 'preconditions 1 to 6 strings of at most 160 characters each',
                       'readback and verify at most 240 characters each', 'reason at most 400 characters', 'If tools_available is empty, make no tool call'):
            self.assertIn(stated, self.v3, stated)
        long_audit = audit_obj(pre=('x' * 161,))
        self.assertIsNone(P.validate_turn(wdecision(audit=long_audit), None, 'v3')[0])
        self.assertEqual(P.validate_turn(wdecision(audit=audit_obj(pre=('x' * 160,) * 6, readback='y' * 240, verify='z' * 240)), None, 'v3')[0], 'decision')
        self.assertIsNone(P.validate_turn(wdecision(audit=audit_obj(verify='z' * 241)), None, 'v3')[0])

    def test_the_three_rules_and_the_managing_apps_are_in_the_text(self):
        for marker in ('Whole-item clean evidence is healthy', 'Evidence in hand counts', 'Identity comes from content', 'Bad copy with a managing app',
                       'Escalate only for a real, named gap',
                       'MANAGING APP (context.arr.app)', 'sonarr', 'radarr', 'lazylibrarian', 'fail this grab and search the format again'):
            self.assertIn(marker, self.v3, marker)
        # the safety rules of v2 are still there
        for marker in ('never healthy', 'Never cite a result as support', 'A sample is partial', 'A write action needs positive evidence'):
            self.assertIn(marker, self.v3, marker)

    def test_rules_are_phrased_by_evidence_type(self):
        # evidence vocabulary is present ...
        for marker in ('full-file decode', 'damage in the file itself', 'unverified', 'no managing app is named'):
            self.assertIn(marker, self.v3, marker)
        # ... and nothing reads like a per-case instruction (a quoted title, an id-shaped token, a file name)
        self.assertEqual(re.findall(r'\b[a-z]+-[a-z]+-\d{3}\b', self.v3), [])
        self.assertEqual(re.findall(r'\b\w+\.(?:mkv|mp4|epub|m4b|mp3|avi)\b', self.v3, re.I), [])
        self.assertNotIn('"', self.v3.split('EVIDENCE RULES')[1])   # no quoted example strings in the rules

    def test_the_text_names_no_case_of_either_dev_suite(self):
        dirs = need_both_suites()
        n = 0
        for d in dirs:
            for c in suite_cases(d):
                n += 1
                L.check_system(c, self.v3)   # the harness' own guard: case id, id stem, fixture names, provenance
                cid = c['id']
                tokens = [cid, re.sub(r'-\d+$', '', cid), c.get('family') or '', ((c.get('truth') or {}).get('ref') or '')]
                ctx = c.get('context') or {}
                tokens += [ctx.get('filename') or '']
                title = str(ctx.get('title') or '')
                if ' ' in title:   # a one-word title is an ordinary word; a real title has spaces
                    tokens.append(title)
                tokens += [Path(str(((c.get('fixture') or {}).get('locator')) or '')).name]
                for t in tokens:
                    if len(t) >= 6:
                        self.assertIsNone(word(t).search(self.v3), (cid, t))
        self.assertEqual(n, 146)   # 73 dev-v1 + 73 dev-v1.1

    def test_no_dev_only_ruling_is_restated_and_the_general_qualifiers_are_there(self):
        # RULINGS-v1.1 C3 is case-specific and dev-only: its series-prefix clause must not be in the shipped text
        for gone in ('series prefix', 'naming at most', 'subtitle, article'):
            self.assertNotIn(gone, self.v3, gone)
        # rule 2 is qualified: clean integrity evidence never outweighs disagreeing content or identity evidence
        self.assertIn('Clean integrity evidence never outweighs content evidence', self.v3)
        self.assertIn('the item is not healthy on integrity alone, and rule 4 applies', self.v3)
        # a result that did not run to completion is not support, not even as a mention
        for marker in ('must not be listed in evidence_refs as support', 'leave its id out of evidence_refs'):
            self.assertIn(marker, self.v3, marker)

    def test_a_v3_record_says_so(self):
        rec, ad = run_v3('rg-v3-ebook-healthy-001', [call('epub_inspect'), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual((rec['prompt']['version'], rec['prompt']['protocol']), ('v3', 'turn-v2'))
        self.assertEqual(rec['prompt']['sha256'], P.get_prompt('v3')['sha256'])
        self.assertEqual(rec['harness_version'], 'dev-c5')
        self.assertEqual(ad.calls[0][0]['role'], 'user')
        self.assertEqual(R.record_missing_fields(rec), [])

    def test_v3_keeps_the_v2_protocol_behaviours(self):
        # a tool outside tools_available is a protocol violation answered with `unavailable`, not a repair prompt
        rec, _ = run_v3('rg-movie-limited-001', [call('decode_sample', full=True), th.decision('insufficient_evidence', 'escalate')])
        self.assertEqual(rec['protocol_violations'][0]['kind'], 'tool_not_offered')
        self.assertEqual(rec['repair_prompts'], [])
        # a write needs its audit: the first reply is rejected, the repair carries it
        case = v2_case()
        rec, _ = run_v3(case, [wdecision(audit=False), wdecision()])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertEqual(rec['decision']['action'], 'blocklist_and_search')
        self.assertFalse(rec['first_try_valid'])

    def test_v1_and_v2_runs_are_untouched_by_the_new_field_logic(self):
        rec, _ = run_v3('rg-movie-healthy-001', [call('ffprobe'), th.decision('healthy', 'none', refs=['t1'])], prompt='v2')
        self.assertEqual((rec['prompt']['version'], rec['prompt']['protocol']), ('v2', 'turn-v2'))
        rec1, _ = run_v3('rg-movie-healthy-001', [th.decision('healthy', 'none', refs=['e1'])], prompt='v1')
        self.assertEqual((rec1['prompt']['version'], rec1['prompt']['protocol']), ('v1', 'turn-v1'))


class ManagingAppLazyLibrarian(unittest.TestCase):
    def ctx_case(self, app, ids=None):
        return v2_case(context={'title': 'Some Book', 'expected': {}, 'arr': {'app': app, 'ids': ids or {'bookId': 'll-990001', 'format': 'ebook'}}, 'notes_for_model': 'n'})

    def met(self, case, decision, **kw):
        a = AU.compute(case, decision, [], prompt_version='v3', **kw)
        return {c['id']: c['met'] for c in a['preconditions']}, a

    def test_lazylibrarian_is_a_managing_app(self):
        self.assertIn('lazylibrarian', AU.ARR_APPS)
        self.assertEqual(set(AU.ARR_APPS) - {'lazylibrarian'}, {'sonarr', 'radarr', 'lidarr', 'readarr', 'bookshelf'})   # nothing was dropped

    def test_arr_app_present_is_met_for_a_book_write(self):
        for action, cls in (('blocklist_and_search', 'corrupt_file'), ('remap', 'identity_mismatch')):
            got, a = self.met(self.ctx_case('lazylibrarian'), wdecision(cls, action, target='ll-990001'))
            self.assertTrue(got['arr_app_present'], (action, got))
        self.assertNotIn('arr_app_present', self.met(self.ctx_case('lazylibrarian'), wdecision('metadata_naming', 'rename', target='ll-990001'))[0])   # rename never needed an app

    def test_no_app_still_fails_the_precondition(self):
        for app in (None, '', 'someotherapp'):
            got, a = self.met(self.ctx_case(app), wdecision(target='ll-990001'))
            self.assertFalse(got['arr_app_present'], app)
            self.assertTrue(a['preconditions_unmet'])

    def test_a_claim_naming_an_app_the_context_does_not_have_is_flagged(self):
        d = wdecision(target='ll-990001', audit=audit_obj('ll-990001', pre=('lazylibrarian manages this book',)))
        got, a = self.met(self.ctx_case('sonarr'), d)
        self.assertIn('claim:lazylibrarian_not_in_context', a['unmet'])
        got, a = self.met(self.ctx_case('lazylibrarian'), d)
        self.assertNotIn('claim:lazylibrarian_not_in_context', a['unmet'])

    def test_the_format_word_is_not_an_identifier(self):
        case = self.ctx_case('lazylibrarian', {'bookId': 'll-990001', 'format': 'audiobook', 'note': 'fictional ids'})
        ids, _, _ = AU.item_identifiers(case)
        self.assertEqual([v for k, v in ids if k == 'id'], ['ll 990001'])      # the format word and the note are not identifiers
        status, _ = AU.target_identity(case, 'the audiobook')
        self.assertNotEqual(status, 'identified')
        status, _ = AU.target_identity(case, 'ebook')
        self.assertNotEqual(status, 'identified')
        self.assertEqual(AU.target_identity(case, 'll-990001')[0], 'identified')   # the real id still identifies
        # the other id keys keep working (series / episode / movie ids are not touched by the skip list)
        tv = v2_case(context={'title': 'Some Show', 'expected': {}, 'arr': {'app': 'sonarr', 'ids': {'seriesId': 880001, 'episodeFileId': 880203}}, 'notes_for_model': 'n'})
        self.assertEqual(AU.target_identity(tv, 'file 880203')[0], 'identified')

    def test_the_v11_suite_uses_only_app_values_the_harness_knows(self):
        need_both_suites()
        apps = {((c.get('context') or {}).get('arr') or {}).get('app') for c in suite_cases(V11)}
        self.assertIn('lazylibrarian', apps)
        self.assertEqual({a for a in apps if a and a not in AU.ARR_APPS}, set())

    def test_end_to_end_on_a_synthetic_book_with_lazylibrarian(self):
        d = wdecision('corrupt_file', 'blocklist_and_search', target='The Lantern Ledger', refs=['t1'],
                      audit=audit_obj('The Lantern Ledger', pre=('t1: epub_inspect reports an unreadable archive',)))
        rec, _ = run_v3('rg-v3-ebook-badcopy-001', [call('epub_inspect'), d])
        got = {c['id']: c['met'] for c in rec['action_audit']['preconditions']}
        self.assertTrue(got['arr_app_present'] and got['cited_evidence_supports'] and got['no_failed_tool_cited'], got)
        self.assertEqual(rec['action_audit']['execution_status'], 'proposed_not_executed')
        self.assertIs(rec['action_audit']['executed'], False)


class WriteRejectionField(unittest.TestCase):
    """Record only, next to G1: a rejected write decision, and the forced escalate when its repair also fails."""

    def go(self, replies, prompt='v3'):
        rec, _ = run_v3(v2_case(), replies, prompt=prompt)
        return rec

    def test_rejected_write_then_valid_repair(self):
        rec = self.go([wdecision(audit=False), wdecision()])
        w = rec['write_rejection']
        self.assertEqual((w['rejected_write_attempts'], w['forced_after_rejected_write'], w['repaired_to_valid_decision']), (1, False, True))
        self.assertEqual((w['attempts'][0]['turn'], w['attempts'][0]['action']), (1, 'blocklist_and_search'))
        self.assertTrue(w['attempts'][0]['errors'])
        self.assertFalse(rec['forced'])

    def test_rejected_write_and_the_repair_also_fails_is_a_visible_forced_escalate(self):
        rec = self.go([wdecision(audit=False), wdecision(audit=False)])
        w = rec['write_rejection']
        self.assertEqual((w['rejected_write_attempts'], w['forced_after_rejected_write'], w['repaired_to_valid_decision']), (2, True, False))
        self.assertTrue(rec['forced'])
        self.assertEqual((rec['decision']['class'], rec['decision']['action']), ('insufficient_evidence', 'escalate'))
        self.assertTrue(rec['forced_reason'].startswith(R.FORCED_AFTER_REPAIR))

    def test_rejected_write_then_unparseable_repair_is_also_visible(self):
        rec = self.go([wdecision(audit=False), 'not json at all'])
        self.assertEqual((rec['write_rejection']['rejected_write_attempts'], rec['write_rejection']['forced_after_rejected_write']), (1, True))

    def test_other_forced_endings_are_not_attributed_to_a_write(self):
        rec = self.go(['not json', 'still not json'])
        self.assertEqual((rec['forced'], rec['write_rejection']['rejected_write_attempts'], rec['write_rejection']['forced_after_rejected_write']), (True, 0, False))
        # a rejected NON-write (an audit on escalate) is not a write rejection
        rec = self.go([dict(th.decision('insufficient_evidence', 'escalate'), audit=audit_obj()), th.decision('insufficient_evidence', 'escalate')])
        self.assertEqual(rec['write_rejection']['rejected_write_attempts'], 0)
        self.assertEqual(len(rec['repair_prompts']), 1)

    def test_valid_runs_have_the_field_empty(self):
        w = self.go([wdecision()])['write_rejection']
        self.assertEqual((w['rejected_write_attempts'], w['attempts'], w['forced_after_rejected_write'], w['repaired_to_valid_decision']), (0, [], False, False))

    def test_v2_records_it_too_and_the_field_is_required(self):
        rec = self.go([wdecision(audit=False), wdecision(audit=False)], prompt='v2')
        self.assertTrue(rec['write_rejection']['forced_after_rejected_write'])
        self.assertEqual(R.record_missing_fields(rec), [])
        broken = {k: v for k, v in rec.items() if k != 'write_rejection'}
        self.assertIn('write_rejection', R.record_missing_fields(broken))

    def test_crash_records_carry_it(self):
        case = th.make_case()
        rec = R.crash_record(case, 'sha', A.ScriptedAdapter('m', []), RuntimeError('boom'), prompt_version='v3')
        self.assertEqual(rec['write_rejection']['rejected_write_attempts'], 0)
        self.assertEqual(rec['prompt']['protocol'], 'turn-v2')
        mini = R._minimal_crash_record(case, 'sha', A.ScriptedAdapter('m', []), RuntimeError('boom'), 'v3', 'replay', RuntimeError('second'))
        self.assertEqual(mini['write_rejection']['rejected_write_attempts'], 0)
        self.assertEqual(mini['prompt']['protocol'], 'turn-v2')

    def test_the_count_matches_the_evaluator_scorers_definition(self):
        # score.py counts turns whose text parses to a write decision and whose validation_errors is non-empty
        rec = self.go([wdecision(audit=False), wdecision(audit=False)])
        scored = 0
        for t in rec['turns']:
            if t.get('validation_errors'):
                o = json.loads(t['text'])
                scored += bool(o.get('type') == 'decision' and o.get('action') in P.WRITE_ACTIONS)
        self.assertEqual(scored, rec['write_rejection']['rejected_write_attempts'])

    def test_summary_counts_it(self):
        recs = [run_v3(v2_case(id='c%d' % i), [wdecision(audit=False), wdecision(audit=False)])[0] for i in (1, 2)]
        manifest = {'run_id': 'x', 'case_ids': ['c1', 'c2'], 'aborted': None, 'harness_git': {}, 'config_hash': 'h', 'requested_model': 'm',
                    'config': {'prompt_version': 'v3', 'system_prompt_sha256': 's', 'evidence_mode': 'replay'}}
        s = R.summarize_run(recs, manifest)
        self.assertEqual((s['validity']['rejected_write_attempts'], s['validity']['forced_after_rejected_write'], s['validity']['forced']), (4, 2, 2))
        self.assertEqual(s['writes_executed'], 0)


class RuleFixtures(unittest.TestCase):
    """The synthetic fixtures for the three evidence rules: they hold the evidence TYPE each rule is phrased by (no case from any suite)."""

    def case(self, cid):
        return load(cid)

    def test_every_fixture_is_generic_and_named_for_its_rule(self):
        ids = sorted(p.stem for p in (REGRESSION / 'cases').glob('rg-v3-*.json'))
        self.assertEqual(len(ids), 6)
        for cid in ids:
            c = self.case(cid)
            self.assertEqual(c['suite_version'], 'harness-regression-v1')
            self.assertIn('synthetic', c['provenance'])
            self.assertRegex(c['truth']['ref'], r'^rule [ABC]: ')
            self.assertEqual(c['context'].get('filename'), None)

    def test_rule_a_healthy_with_whole_item_clean_evidence(self):
        rec, _ = run_v3('rg-v3-ebook-healthy-001', [call('epub_inspect'), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual([(c['tool'], c['status']) for c in rec['tool_calls']], [('epub_inspect', 'ok')])
        self.assertEqual((rec['unverified_parts'], rec['decision_flags']), ([], []))
        self.assertTrue(rec['first_try_valid'])
        rec, _ = run_v3('rg-v3-audiobook-healthy-001', [call('audiobook_inspect'), th.decision('healthy', 'none', refs=['t1'])])
        self.assertEqual([(c['tool'], c['status']) for c in rec['tool_calls']], [('audiobook_inspect', 'ok')])
        self.assertEqual((rec['unverified_parts'], rec['decision_flags']), ([], []))
        self.assertIn('"parts_read": 3', rec['tool_calls'][0]['output'])   # the whole item was read: every part

    def test_rule_a_healthy_is_unflagged_where_an_escalate_would_be_an_unneeded_abstention(self):
        c = self.case('rg-v3-audiobook-healthy-001')
        self.assertEqual((c['truth']['class'], c['supported_actions']), ('healthy', ['none']))   # a model that escalates here misses

    def test_rule_b_bad_copy_with_a_managing_app(self):
        for cid, app, tool_replies in (('rg-v3-movie-badcopy-001', 'radarr', []), ('rg-v3-ebook-badcopy-001', 'lazylibrarian', [call('epub_inspect')])):
            c = self.case(cid)
            self.assertEqual(c['context']['arr']['app'], app)
            self.assertIn('blocklist_and_search', c['supported_actions'])
            ref = 'e2' if tool_replies == [] else 't1'
            d = wdecision('corrupt_file', 'blocklist_and_search', target='The Lantern Ledger' if tool_replies else 'Example Movie Five', refs=[ref],
                          audit=audit_obj('The Lantern Ledger' if tool_replies else 'Example Movie Five', pre=('%s: the tool reported damage in the file' % ref,)))
            rec, _ = run_v3(cid, tool_replies + [d])
            got = {x['id']: x['met'] for x in rec['action_audit']['preconditions']}
            self.assertTrue(got['arr_app_present'], (cid, got))
            self.assertTrue(got['cited_evidence_supports'] and got['no_failed_tool_cited'], (cid, got))   # a damage finding is usable support
            self.assertEqual(rec['action_audit']['execution_status'], 'proposed_not_executed')
            self.assertIs(rec['action_audit']['executed'], False)

    def test_rule_c_real_gaps(self):
        # no managing app for a needed write: the write's precondition is unmet, escalate is the supported answer
        c = self.case('rg-v3-movie-noapp-001')
        self.assertEqual((c['context']['arr']['app'], c['supported_actions']), (None, ['escalate']))
        d = wdecision('corrupt_file', 'blocklist_and_search', target='Example Movie Six', refs=['e2'],
                      audit=audit_obj('Example Movie Six', pre=('e2: the tool reported damage',)))
        rec, _ = run_v3('rg-v3-movie-noapp-001', [d])
        got = {x['id']: x['met'] for x in rec['action_audit']['preconditions']}
        self.assertFalse(got['arr_app_present'])
        self.assertTrue(rec['action_audit']['preconditions_unmet'])
        # conflicting identity evidence: the tags agree, the duration does not
        c = self.case('rg-v3-audiobook-conflict-001')
        self.assertEqual(c['supported_actions'], ['escalate'])
        rec, _ = run_v3('rg-v3-audiobook-conflict-001', [call('audiobook_inspect'), th.decision('insufficient_evidence', 'escalate', refs=['t1'])])
        out = json.loads(rec['tool_calls'][0]['output'])['observation']
        self.assertEqual(out['tags']['title'], 'Example Audiobook Five')
        self.assertLess(out['duration_s'], c['context']['expected']['duration_s'])
        self.assertEqual(rec['decision_flags'], [])

    def test_no_model_visible_field_names_a_rule_or_an_answer(self):
        for p in sorted((REGRESSION / 'cases').glob('rg-v3-*.json')):
            c = json.loads(p.read_text())
            shown = json.dumps({'context': c['context'], 'evidence': c['evidence']}, sort_keys=True)
            self.assertNotRegex(shown, r'rule [ABC]')
            self.assertNotIn(c['truth']['ref'], shown)


if __name__ == '__main__':
    unittest.main()
