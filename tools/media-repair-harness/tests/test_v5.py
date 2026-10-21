"""dev-c5 tests (W19): prompt v5 (new text on the v2 turn protocol, valid only with `--evidence-format v2`), the opt-in run caps, the synthetic PAIRED
regressions that the frozen measurement relies on, and the proof that the scoring layer is unchanged.  Fake model replies only (ScriptedAdapter), synthetic generic
fixtures; no model, no network.  What these tests check is what the HARNESS does and that the prompt TEXT carries the definitions and names no case; whether a
model follows the text is measured on the dev split (runs/dev-c5), not here."""
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import th
from ev2h import case_with, dec, ev, obs, probe_out, decode_out, tc
from media_repair_harness import adapters as A
from media_repair_harness import audit as AU
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import leakguard
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import score_compat
from test_v3 import need_both_suites, suite_cases, word

OLD_SHA = {'v1': '30749f5dc7065a2ddd70967cd6888e91d237030e1b025bc6dac19ca51fed9ee8', 'v2': '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a',
           'v3': 'b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a', 'v4': 'a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd'}
SCORE_PY_SHA256 = '5002f1d534535c2319602193a9fb561f0be914f29ea4bcc0fc840477d2eaa789'      # the evaluator's score.py (v1.1), as in the dev-c4 report
SCORE_COMPAT_SHA256 = '2bdabb592c4db3229270d5aac049bba32d25810f5acba85a10ab6a4958cebe4d'   # unchanged since dev-c4: dev-c5 adds no line to it
CTX = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
DAMAGE = '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5'
WARNING = '[h264 @ 0x0] non-existing PPS 0 referenced'
PROFILE = {'containers': ['matroska,webm'], 'video_codec': 'h264', 'video_pix_fmt': 'yuv420p', 'audio_codecs': ['aac'], 'max_audio_channels': 2}


def v5_run(case, replies, **kw):
    ts = th.TempSuite([case])
    kw = dict({'evidence_format': 'v2', 'guards': 'v3', 'which': th.NO_BINARIES}, **kw)
    rec, ad = ev2h.scripted_run(case, ts, replies, prompt='v5', **kw)
    ts.cleanup()
    return rec, ad


class PromptV5(unittest.TestCase):
    def setUp(self):
        self.v5 = P.get_prompt('v5')['text']

    def test_selectable_on_the_v2_turn_protocol_and_v1_to_v4_are_byte_identical(self):
        self.assertEqual(P.PROMPT_VERSIONS[:5], ('v1', 'v2', 'v3', 'v4', 'v5'))
        self.assertEqual(P.DEFAULT_PROMPT, 'v1')
        self.assertEqual(P.protocol_of('v5'), 'v2')
        for v, sha in OLD_SHA.items():
            self.assertEqual(P.get_prompt(v)['sha256'], sha, v)
        self.assertEqual(len({P.get_prompt(v)['sha256'] for v in P.PROMPT_VERSIONS[:5]}), 5)
        self.assertEqual(P.get_prompt('v5')['sha256'], hashlib.sha256(self.v5.encode()).hexdigest())
        self.assertEqual(P.HARNESS_VERSION, 'dev-c8')       # dev-c6, dev-c7 and dev-c8 moved it; v5 and its measured text are unchanged

    def test_the_per_case_schema_is_the_v4_one(self):
        for tools in ([], None, ['ffprobe'], ['ffprobe', 'decode_sample', 'arr_lookup']):
            for flat in (False, True):
                self.assertEqual(P.turn_schema('v5', tools, flat=flat), P.turn_schema('v4', tools, flat=flat))
        self.assertNotIn('tool_call', json.dumps(P.turn_schema('v5', [])))      # a case that offers no tool has no tool-call branch

    def test_keeps_the_reply_format_and_the_enforced_limits(self):
        for marker in ('REPLY FORMAT', 'CLASSES', 'ACTIONS', 'MANAGING APP', 'exactly ONE JSON object', 'at most 6 per case',
                       'Every decision object has all of the keys shown, including "target" and "confidence"',
                       'audit.target at most 200 characters; preconditions 1 to 6 strings of at most 160 characters each; readback and verify at most 240 characters each; reason at most 400 characters',
                       'copy it into audit.target character for character', 'If tools_available is empty, make no tool call'):
            self.assertIn(marker, self.v5, marker)
        v4 = P.get_prompt('v4')['text']
        # the schema paragraph is the v4 one, word for word
        start = v4.index('2. Final decision:')
        end = v4.index('CLASSES')
        self.assertIn(v4[start:end].replace('\n\n', '\n').strip().split('\n')[-1], self.v5)

    def test_defines_the_decisions_the_audit_asked_for(self):
        # AUDIT-ASTRA-8 item 1: the integrity boundary
        for text in ('Positive damage observations support corrupt_file', 'Clean observations support health only within their actual scope',
                     'Integrity alone does not establish identity or client compatibility', 'An unknown identity does not cancel corruption that is independently evidenced',
                     'clean results elsewhere never cancel positive damage'):
            self.assertIn(text, self.v5, text)
        # item 2: diagnosis versus action
        self.assertIn('keep the evidenced class and choose escalate; use insufficient_evidence only when the diagnosis itself is unresolved', self.v5)
        # item 3: the decisions, not just the field names
        for text in ('Whether it is enough is your judgement and nothing certifies it', 'There is no fixed coverage percentage and no rule that the whole file must be checked',
                     'A positive finding in a partly checked item is still a positive finding', 'Only the selected streams count',
                     'They certify nothing, and neither does the absence of a known_defect finding', 'names no place, so do not invent one',
                     'next is an opaque cursor', 'uses one of your 6 calls', 'Detail you have not seen is unseen', 'only ids that were actually shown to you',
                     'do not fetch every page', 'neither clean nor damaged', 'not_stated and not_compared fields were not compared'):
            self.assertIn(text, self.v5, text)
        # execution against integrity, partial against presentation truncation, requested against completed scope, provenance, capabilities
        for text in ('is separate from integrity', 'ok means the tool ran, never that the file is clean', 'A completed sample may have status ok, but its coverage stays bounded',
                     'is presentation, not truncation', 'Work from the completed scope', 'the catalog', 'declarations', 'content (what was observed',
                     'capabilities say, per offered tool'):
            self.assertIn(text, self.v5, text)

    def test_astra_12_items_1_to_3(self):
        # 1. a cause is a claim, damage is a known_defect finding; an error result supports a write only with a known_defect finding and a cause other than tool
        for text in ('A cause is the collector\'s claim about why it failed, not proof of damage', 'damage is a known_defect finding, never a cause alone',
                     'an execution cause alone is not damage', 'an error result that carries a known_defect finding and whose cause is other than tool', 'Action prerequisites still apply'):
            self.assertIn(text, self.v5, text)
        self.assertNotIn('a failure caused by the input', self.v5)
        self.assertNotIn('whose cause is input', self.v5)
        # 2. partial and timed-out results keep positive observations; unfinished checks stay unresolved; they cannot alone support a write; the contradicting sentences are gone
        for text in ('A partial or timed-out result can keep positive observations that bear on the diagnosis', 'what it did not finish stays unresolved',
                     'cannot support a write on its own'):
            self.assertIn(text, self.v5, text)
        self.assertNotIn('timeout or unavailable result taught nothing', self.v5)
        self.assertNotIn('A sample is partial', self.v5)
        # 3. page-origin semantics
        for text in ('A page fetch retrieves evidence that already exists; it does not rerun a check', 'The outer status ok of a page reply means only that the retrieval worked',
                     "read the origin's own execution inside it and cite the evidence ids", 'never upgrades their support'):
            self.assertIn(text, self.v5, text)

    def test_class_and_action_boundaries(self):
        convert = re.search(r'- convert:.*', self.v5).group(0)
        self.assertIn('The source need not decode cleanly in full', convert)
        self.assertIn('leaves the original untouched', convert)
        self.assertIn('Not a response to damage, names or identity', convert)
        self.assertIn('never the file name, a tag or a duration alone', self.v5)
        self.assertIn('Content verified as the expected work, with a wrong name, tag, title, number or mapping, is metadata_naming', self.v5)
        self.assertIn('Observed content that names a different work', self.v5)
        self.assertIn('Choose it whenever the evidence does not settle the class or the action', self.v5)

    def test_q01_is_not_settled_and_no_mapping_examples_are_taught(self):
        self.assertIn('If the evidence does not show which of the two applies, or the mapping is unclear, escalate', self.v5)
        low = self.v5.lower()
        for phrase in ('wrong episode', 'wrong-episode', 'episode mapping', 'episode link', 'wrong item link', 'different episode'):
            self.assertNotIn(phrase, low, phrase)
        self.assertNotIn('for example', re.search(r'metadata_naming:.*', self.v5).group(0))

    def test_the_text_is_general_no_case_no_dev_numbers_no_internals(self):
        low = self.v5.lower()
        for token in ('injected', 'dev-c', 'dev-v', 'held-out', 'heldout', 'gates.md', 'g1', 'g2', 'g3', 'score.py', 'truth', 'solvable', 'v4 ', 'prompt v'):
            self.assertNotIn(token, low, token)
        self.assertEqual(re.findall(r'\b[a-z]+-[a-z]+-\d{3}\b', self.v5), [])
        self.assertEqual(re.findall(r'\b\w+\.(?:mkv|mp4|epub|m4b|mp3|avi)\b', self.v5, re.I), [])
        # every number in the text is a protocol constant: the call budget, the page size, the audit limits, the placeholder confidence, the example ids and the rule numbers
        numbers = set(re.findall(r'(?<![A-Za-z_.])\d+(?:\.\d+)?', self.v5))
        self.assertEqual(numbers - set('0123456789') - {'8192', '200', '160', '240', '400', '0.0'}, set(), sorted(numbers))

    def test_the_text_names_no_case_of_either_public_dev_suite_and_the_leak_guard_passes(self):
        n = 0
        for d in need_both_suites():
            for c in suite_cases(d):
                n += 1
                leakguard.check_system(c, self.v5)
                ctx = c.get('context') or {}
                tokens = [c['id'], re.sub(r'-\d+$', '', c['id']), c.get('family') or '', ((c.get('truth') or {}).get('ref') or ''), ctx.get('filename') or '']
                if ' ' in str(ctx.get('title') or ''):
                    tokens.append(str(ctx['title']))
                exp = ctx.get('expected') or {}
                for k in ('title', 'series', 'episode_title', 'author'):
                    if isinstance(exp.get(k), str) and ' ' in exp[k]:
                        tokens.append(exp[k])
                tokens.append(Path(str(((c.get('fixture') or {}).get('locator')) or '')).name)
                for t in tokens:
                    if len(t) >= 6:
                        self.assertIsNone(word(t).search(self.v5), (c['id'], t))
        self.assertEqual(n, 146)

    def test_it_is_longer_than_v4_but_inside_what_an_8192_token_local_context_can_hold(self):
        # a local model sees system + conversation in num_ctx 8192 tokens; the pessimistic estimate the adapter flags with is 3 characters per token
        self.assertGreater(len(self.v5), len(P.get_prompt('v4')['text']))
        self.assertLess(len(self.v5) / 3.0, 5700)

    def test_every_dev_case_first_message_plus_the_prompt_fits_the_context_estimate(self):
        """The pre-registered context handling relies on this being rare: no first message of either public dev suite, with the v5 system prompt, reaches the 3-chars-per-token estimate of 8192."""
        worst = 0
        for d in need_both_suites():
            for case in suite_cases(d):
                ctx = None
                view = P.case_view(case, [], case_alias='case-00000000')
                import media_repair_harness.tools as T
                fx = T.Fixture.from_case(case, d)
                ctx = T.Context(case, fx, tempfile.mkdtemp(), suite_dir=d, which=th.NO_BINARIES, tools_behavior='v2')
                evidence = []
                for e in case.get('evidence', []):
                    evidence.append(EV2.make_observation(e['id'], e['tool'], e.get('args', {}), e.get('status', 'ok'), e.get('output'), None, 'case'))
                ses = EV2.Session('case-00000000', view['context'], view['media_type'], view['tools_available'])
                block, _n = ses.initial(evidence)
                msg = json.dumps({'case_id': 'case-00000000', 'media_type': view['media_type'], 'context': view['context'], 'tools_available': view['tools_available'],
                                  'tool_call_budget': 6, 'capabilities': T.capabilities(ctx), 'evidence_format': 'v2', 'evidence': block}, ensure_ascii=False, separators=(',', ':'))
                worst = max(worst, len(self.v5) + len(msg))
        self.assertLess(worst / 3.0, 8192, worst)


class RefusedWithTheLegacyFormat(unittest.TestCase):
    def test_check_option_combination(self):
        for guards in (None, 'v1', 'v2', 'v3'):
            with self.assertRaises(ValueError) as cm:
                R.check_option_combination('v5', None, guards)
            self.assertIn('valid only with --evidence-format v2', str(cm.exception))
        R.check_option_combination('v5', 'v2')
        R.check_option_combination('v5', 'v2', 'v3')
        with self.assertRaises(ValueError):
            R.check_option_combination('v5', 'v2', 'v2')       # the existing guard-version rule still applies
        for v in ('v1', 'v2', 'v3', 'v4'):                      # nothing earlier changed
            R.check_option_combination(v, None)
            R.check_option_combination(v, None, 'v3')
        R.check_option_combination('v4', 'v2')
        with self.assertRaises(ValueError):
            R.check_option_combination('v3', 'v2')

    def test_run_case_and_main_refuse_it_before_any_model_call(self):
        case = case_with([])
        ad = A.ScriptedAdapter('m', [dec()])
        with self.assertRaises(ValueError):
            R.run_case(case, 'x', ad, '.', tempfile.mkdtemp(), prompt_version='v5')
        self.assertEqual(ad.calls, [])
        ts = th.TempSuite([case])
        out = Path(tempfile.mkdtemp()) / 'r1'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('m', [dec()])
        try:
            with self.assertRaises(SystemExit) as cm:
                R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', 'v5'])
            self.assertIn('--evidence-format v2', str(cm.exception))
            self.assertFalse(out.exists())
        finally:
            R.build_adapter = orig
        ts.cleanup()

    def test_a_v5_run_records_the_prompt_and_the_format_and_uses_the_v4_audit_tables(self):
        case = case_with([ev('e1', 'arr_lookup', output='x')])
        rec, ad = v5_run(case, [dec('insufficient_evidence', 'escalate')])
        self.assertEqual((rec['harness_version'], rec['prompt']['version'], rec['prompt']['protocol']), ('dev-c8', 'v5', 'turn-v2'))
        self.assertEqual(rec['prompt']['sha256'], P.get_prompt('v5')['sha256'])
        self.assertEqual(ad.full[0]['system'], P.get_prompt('v5')['text'])
        self.assertEqual((rec['evidence_format']['version'], rec['action_audit']['audit_version']), ('v2', 'v2'))
        rec.update(harness_git_sha='x', config_hash='h')
        self.assertEqual(R.record_missing_fields(rec), [])
        d = th.decision('metadata_naming', 'remap', target='x')
        self.assertEqual(P.validate_turn(dict(d, target='rel-1', audit={'target': 'rel-1', 'preconditions': ['p'], 'readback': 'r', 'verify': 'v'}), None, 'v5')[0], 'decision')
        out = AU.compute(case_with([ev('e1', 'arr_lookup')]), d, [], prompt_version='v5')
        self.assertNotIn('class_matches_action', out['unmet'])          # v5 reads the same class table as v4
        self.assertIn('class_matches_action', AU.compute(case_with([ev('e1', 'arr_lookup')]), d, [], prompt_version='v3')['unmet'])


class RunCaps(unittest.TestCase):
    """`--max-total-cost-usd` and `--max-wall-s`: opt-in and ENFORCED (remaining budget before each call, one absolute deadline), a started case is never lost,
    nothing silently becomes "not run".  Fake clocks and scripted costs only."""

    class Clock:
        def __init__(self):
            self.t = 0.0

        def __call__(self):
            return self.t

    class Costed(A.ScriptedAdapter):
        """A scripted model whose every call reports `cost` dollars, takes `step` fake seconds and has a call timeout of `timeout` (as a real adapter has)."""

        def __init__(self, replies, cost, clock=None, step=0.0, timeout=120, preflight_s=0.0, budget=None, finish_s=0.0, reserve=0):
            super().__init__('m', replies)
            self.cost, self.clock, self.step, self.call_timeout, self.preflight_s = cost, clock, step, timeout, preflight_s
            self.finish_s, self.cleanup_reserve_s = finish_s, reserve
            self.budgets = []
            if budget is not None:
                self.max_budget_usd = budget

        def preflight(self):
            if self.clock:
                self.clock.t += self.preflight_s
            return {}

        def finish(self):
            if self.clock:
                self.clock.t += self.finish_s       # the unload, status and snapshot calls of a real adapter
            return {}

        def complete(self, system, messages, schema=None):
            self.budgets.append(getattr(self, 'max_budget_usd', None))
            c = super().complete(system, messages, schema)
            c.usage = dict(c.usage, cost_usd=self.cost)
            if self.clock:
                self.clock.t += self.step
            return c

    def run_main(self, cases, adapter, extra=(), clock=None):
        ts = th.TempSuite(cases)
        out = Path(tempfile.mkdtemp()) / 'runs' / 'r1'
        orig, orig_limits = R.build_adapter, R.RunLimits
        R.build_adapter = lambda args: adapter
        if clock is not None:
            class Limits(orig_limits):
                def __init__(self, *a, **kw):
                    super().__init__(*a, clock=clock, **kw)
            R.RunLimits = Limits
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', 'v4'] + list(extra))
        finally:
            R.build_adapter, R.RunLimits = orig, orig_limits
        ts.cleanup()
        return code, out

    def cases(self, n):
        return [case_with([ev('e1', 'arr_lookup', output='x')], cid='cap-%03d' % i) for i in range(1, n + 1)]

    def manifest(self, out):
        return json.loads((out / 'manifest.json').read_text())

    def test_no_caps_no_new_key_no_behaviour_change(self):
        code, out = self.run_main(self.cases(3), self.Costed([dec()] * 3, 0.01))
        man = self.manifest(out)
        self.assertEqual(code, 0)
        self.assertNotIn('limits', man['config'])
        self.assertNotIn('limits_state', man)
        self.assertEqual((len(man['records_written']), man['started_aborted'], man['never_started']), (3, [], []))
        self.assertFalse((out / 'started-aborted').exists())

    def test_cost_probe_two_calls_of_35_cents_under_a_60_cent_cap_never_reaches_70_cents(self):
        code, out = self.run_main(self.cases(4), self.Costed([dec()] * 4, 0.35), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertEqual(man['config']['limits'], {'max_total_cost_usd': 0.6, 'max_wall_s': None})
        self.assertEqual(man['records_written'], ['cap-001'])
        self.assertEqual((man['started_aborted'], man['never_started']), ([], ['cap-002', 'cap-003', 'cap-004']))     # nothing silently dropped: every case is in exactly one list
        self.assertLessEqual(man['limits_state']['cost_usd'], 0.60)
        self.assertIn('cost cap reached', man['aborted'])
        self.assertEqual(man['limits_state']['stopped'], man['aborted'])

    def test_a_case_stopped_in_the_middle_is_persisted_with_its_turns_usage_and_reason(self):
        ad = self.Costed([tc('arr_lookup'), tc('arr_lookup'), tc('arr_lookup'), dec()], 0.20)
        code, out = self.run_main(self.cases(2), ad, ['--max-total-cost-usd', '0.50'])
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), ([], ['cap-001'], ['cap-002']))
        part = json.loads((out / 'started-aborted' / 'cap-001.json').read_text())
        self.assertEqual((part['status'], part['scored']), ('started_aborted', False))
        self.assertIn('cost cap reached before a model call', part['abort_reason'])
        self.assertEqual(len(part['turns']), 2)
        self.assertEqual(len(part['tool_calls']), 2)
        self.assertAlmostEqual(part['usage']['cost_usd'], 0.40)
        self.assertEqual(part['usage']['model_calls'], 2)
        summary = json.loads((out / 'run_summary.json').read_text())
        self.assertAlmostEqual(summary['cost_usd'], 0.40)                                           # the partial's spend is in the summary
        self.assertEqual((summary['started_aborted'], summary['never_started'], summary['records_written']), (['cap-001'], ['cap-002'], 0))
        self.assertFalse((out / 'cap-001.json').exists())                                           # not a scored record: the scorer reads only <case>.json in the run directory

    def test_the_cost_of_a_failed_call_counts_and_a_missing_cost_stops_the_run(self):
        class Failing(self.Costed):
            def complete(self, system, messages, schema=None):
                self.calls.append(messages)
                raise A.AdapterError('claude CLI error: {}', cost_usd=self.cost)
        code, out = self.run_main(self.cases(3), Failing([], 0.40), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual(man['records_written'], ['cap-001'])            # the failed call was recorded as a forced escalate; its $0.40 left 0.20 < 0.40
        self.assertAlmostEqual(man['limits_state']['cost_usd'], 0.40)
        self.assertEqual(code, 3)
        code, out = self.run_main(self.cases(3), self.Costed([dec()] * 3, None), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertIn('the spend cannot be metered', man['aborted'])
        self.assertEqual((man['records_written'], man['never_started']), (['cap-001'], ['cap-002', 'cap-003']))   # the call that reported no cost is kept; the run stops after it
        self.assertEqual(man['limits_state']['cost_unreported'], 'a call reported no cost')

    def test_a_failed_calls_tokens_and_cost_are_kept_in_the_record_the_totals_and_the_summary(self):
        class Failing(self.Costed):
            def complete(self, system, messages, schema=None):
                self.calls.append(messages)
                raise A.AdapterError('claude CLI error: {}', usage={'input_tokens': 123, 'output_tokens': 7, 'cost_usd': 0.40})
        code, out = self.run_main(self.cases(1), Failing([], 0.0), ['--max-total-cost-usd', '0.60'])
        rec = json.loads((out / 'cap-001.json').read_text())
        self.assertEqual((rec['usage']['input_tokens'], rec['usage']['output_tokens'], rec['usage']['cost_usd'], rec['usage']['cost_reported']), (123, 7, 0.40, True))
        self.assertEqual(rec['turns'][0]['usage'], {'input_tokens': 123, 'output_tokens': 7, 'cost_usd': 0.40})
        summary = json.loads((out / 'run_summary.json').read_text())
        self.assertAlmostEqual(summary['cost_usd'], 0.40)
        self.assertEqual(self.manifest(out)['limits_state']['cost_usd'], 0.4)
        # the same receipt through the real parser
        try:
            A.parse_claude(json.dumps({'is_error': True, 'subtype': 'error_during_execution', 'total_cost_usd': 0.40, 'usage': {'input_tokens': 123, 'output_tokens': 7}}), '', 1, {}, 0.1)
        except A.AdapterError as e:
            self.assertEqual((e.usage, e.cost_usd, e.budget_exceeded), ({'input_tokens': 123, 'output_tokens': 7, 'cost_usd': 0.40}, 0.40, False))

    def test_the_receipt_of_a_failed_call_counts_toward_the_run_total_across_cases(self):
        class Fail2(self.Costed):
            def complete(self, system, messages, schema=None):
                self.calls.append(messages)
                if len(self.calls) == 1:
                    raise A.AdapterError('claude CLI error: {}', usage={'input_tokens': 50, 'output_tokens': 2, 'cost_usd': 0.30})
                return super().complete(system, messages, schema)
        # a failed first call forces the case to escalate; use two cases: the second is cut by the cap and its partial must carry usage
        code, out = self.run_main(self.cases(3), Fail2([dec()] * 3, 0.20), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertAlmostEqual(man['limits_state']['cost_usd'], 0.5)
        self.assertEqual(man['records_written'], ['cap-001', 'cap-002'])
        self.assertEqual(json.loads((out / 'run_summary.json').read_text())['cost_usd'], 0.5)

    def test_the_cli_stopping_at_the_lowered_budget_is_a_cost_cap_abort_not_a_forced_escalate(self):
        class OverBudget(self.Costed):
            def complete(self, system, messages, schema=None):
                self.calls.append(messages)
                raise A.AdapterError('claude CLI error: {"subtype": "error_max_budget_usd"}', usage={'input_tokens': 900, 'output_tokens': 11, 'cost_usd': 0.35}, budget_exceeded=True)
        code, out = self.run_main(self.cases(2), OverBudget([], 0.0), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), ([], ['cap-001'], ['cap-002']))
        self.assertIn('cost cap reached by a call', man['aborted'])
        part = json.loads((out / 'started-aborted' / 'cap-001.json').read_text())
        self.assertEqual((part['usage']['input_tokens'], part['usage']['cost_usd']), (900, 0.35))
        self.assertIn('cost_cap_budget_exceeded', part['turns'][0]['failure_modes'])
        self.assertFalse((out / 'cap-001.json').exists())
        self.assertAlmostEqual(self.manifest(out)['limits_state']['cost_usd'], 0.35)
        # without a cap the same error stays an ordinary adapter error: a recorded, forced case
        code, out = self.run_main(self.cases(1), OverBudget([], 0.0))
        self.assertEqual(code, 0)
        self.assertTrue(json.loads((out / 'cap-001.json').read_text())['forced'])

    def test_the_final_call_cannot_overshoot_or_go_unmetered_without_a_flag(self):
        code, out = self.run_main(self.cases(1), self.Costed([dec()], 0.70), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual((code, man['records_written']), (3, ['cap-001']))                      # the case is a scored record AND the run is flagged
        self.assertEqual([v['kind'] for v in man['limit_violations']], ['cost_cap_exceeded'])
        self.assertIn('cost_cap_exceeded', man['aborted'])
        self.assertEqual(json.loads((out / 'run_summary.json').read_text())['limit_violations'][0]['kind'], 'cost_cap_exceeded')
        code, out = self.run_main(self.cases(1), self.Costed([dec()], None), ['--max-total-cost-usd', '0.60'])
        man = self.manifest(out)
        self.assertEqual((code, [v['kind'] for v in man['limit_violations']]), (3, ['cost_unreported']))
        self.assertTrue(man['aborted'].startswith('cost_unreported'))

    def test_wall_probe_fifteen_119_second_calls_plus_a_110_second_cleanup_stay_inside_1800(self):
        clock = self.Clock()
        ad = self.Costed([dec()] * 40, 0.0, clock, step=119.0, timeout=120, finish_s=110.0, reserve=180)      # unload 50 s + status 50 s + snapshot 10 s
        code, out = self.run_main(self.cases(30), ad, ['--max-wall-s', '1800'], clock)
        man = self.manifest(out)
        st = man['limits_state']
        self.assertEqual(code, 3)
        self.assertIn('wall-time cap reached', man['aborted'])
        self.assertEqual(man['limit_violations'], [])
        self.assertLessEqual(st['elapsed_after_cleanup_s'], 1800.0)
        self.assertEqual(len(man['records_written']), 13)                  # a call starts only while elapsed + 120 s timeout + 180 s cleanup reserve < 1800
        self.assertEqual(len(man['records_written']) + len(man['started_aborted']) + len(man['never_started']), 30)

    def test_wall_probe_a_cleanup_that_runs_over_is_a_flagged_violation_not_success(self):
        clock = self.Clock()
        ad = self.Costed([dec()] * 40, 0.0, clock, step=119.0, timeout=120, finish_s=400.0, reserve=180)
        code, out = self.run_main(self.cases(30), ad, ['--max-wall-s', '1800'], clock)
        man = self.manifest(out)
        self.assertEqual(code, 3)
        self.assertEqual([v['kind'] for v in man['limit_violations']], ['wall_cap_exceeded'])
        self.assertGreater(man['limits_state']['elapsed_after_cleanup_s'], 1800.0)
        self.assertIn('wall_cap_exceeded', man['aborted'])

    def test_a_claude_call_gets_the_remaining_budget_as_its_own_cli_budget(self):
        ad = self.Costed([tc('arr_lookup'), dec()], 0.10, budget=2.0)
        code, out = self.run_main(self.cases(1), ad, ['--max-total-cost-usd', '0.60'])
        self.assertEqual(code, 0)
        self.assertEqual([round(b, 2) for b in ad.budgets], [0.60, 0.50])
        self.assertEqual(ad.max_budget_usd, 0.50)       # lowered per call; the configured 2.0 stays in the recorded adapter config only

    def test_wall_probe_the_deadline_covers_preflight_and_no_call_runs_past_it(self):
        clock = self.Clock()
        ad = self.Costed([dec()] * 40, 0.0, clock, step=120.0, timeout=120, preflight_s=900.0)
        code, out = self.run_main(self.cases(30), ad, ['--max-wall-s', '1800'], clock)
        man = self.manifest(out)
        st = man['limits_state']
        self.assertEqual(code, 3)
        self.assertIn('wall-time cap reached', man['aborted'])
        self.assertLessEqual(st['elapsed_s'], 1800.0)                    # the 900 s preflight is inside the deadline; the last call that was started could still finish in time
        self.assertLessEqual(st['elapsed_after_cleanup_s'], 1800.0)
        self.assertEqual(len(man['records_written']), 7)                 # 900 + 7 x 120 = 1740; another call would end at 1860
        self.assertEqual(len(man['records_written']) + len(man['started_aborted']) + len(man['never_started']), 30)

    def test_wall_probe_a_slow_preflight_alone_can_use_the_whole_budget(self):
        clock = self.Clock()
        ad = self.Costed([dec()] * 3, 0.0, clock, step=1.0, timeout=120, preflight_s=1790.0)
        code, out = self.run_main(self.cases(3), ad, ['--max-wall-s', '1800'], clock)
        man = self.manifest(out)
        self.assertEqual((code, man['records_written'], len(man['never_started'])), (3, [], 3))

    def test_the_caps_are_part_of_the_config_hash(self):
        _, a = self.run_main(self.cases(1), self.Costed([dec()], 0.0))
        _, b = self.run_main(self.cases(1), self.Costed([dec()], 0.0), ['--max-total-cost-usd', '0.60', '--max-wall-s', '1800'])
        self.assertNotEqual(self.manifest(a)['config_hash'], self.manifest(b)['config_hash'])

    def test_the_claude_timeout_is_in_the_adapter_config_and_the_hash(self):
        a, b = A.ClaudeAdapter('claude-haiku-5-5', timeout=240), A.ClaudeAdapter('claude-haiku-5-5', timeout=60)
        self.assertEqual(a.config()['timeout_s'], 240)
        self.assertNotEqual(R.canonical(a.config()), R.canonical(b.config()))
        a.finish(), b.finish()
        err = None
        try:
            A.parse_claude(json.dumps({'is_error': True, 'subtype': 'error_max_budget_usd', 'total_cost_usd': 0.05}), '', 1, {}, 0.1)
        except A.AdapterError as e:
            err = e
        self.assertEqual(err.cost_usd, 0.05)


class DigestEnforcement(unittest.TestCase):
    def test_a_different_digest_aborts_before_anything_is_loaded(self):
        import test_adapters as TA
        fake = TA.FakeOllama()
        ad = A.OllamaAdapter('qwen3.8:27b', api=fake, snapshot=TA.snapshot(), required_digest='f' * 64)
        with self.assertRaises(A.AbortRun) as cm:
            ad.preflight()
        self.assertIn('digest differs', str(cm.exception))
        self.assertNotIn('/api/generate', [c[0] for c in fake.calls])
        self.assertFalse(ad.loaded_by_us)

    def test_the_frozen_digest_passes_with_or_without_the_sha256_prefix_and_is_in_the_config(self):
        import test_adapters as TA
        for want in ('abc', 'sha256:abc'):
            ad = A.OllamaAdapter('qwen3.8:27b', api=TA.FakeOllama(), snapshot=TA.snapshot(), required_digest=want)
            self.assertEqual(ad.preflight()['loaded_by_us'], True)
            self.assertEqual(ad.config()['required_digest'], want)
        self.assertNotIn('required_digest', A.OllamaAdapter('qwen3.8:27b', api=TA.FakeOllama(), snapshot=TA.snapshot()).config())


class PairedRegressions(unittest.TestCase):
    """Synthetic PAIRS: two inputs that differ in exactly one fact, run through the real runner with prompt v5, evidence format v2 and guards v3 and a scripted model that
    always answers healthy.  The expected values are written by hand; they show what the evidence layer and the guard do with the one fact, not what a model does."""

    HEALTHY = dec('healthy', 'none', refs=['e1', 'e2', 'e3'])

    def window_case(self, stderr_at_4, cid='pair-001'):
        evidence = [ev('e1', 'ffprobe', output=probe_out(duration='8.0')),
                    ev('e2', 'decode_sample', output=decode_out(ss=0, t=4), args={'ss': 0, 't': 4}),
                    ev('e3', 'decode_sample', output=decode_out(ss=4, t=4, stderr=stderr_at_4, out_time='00:00:04.000000'), args={'ss': 4, 't': 4})]
        return case_with(evidence, cid=cid)

    def test_pair_a_decoder_warning_versus_damage(self):
        warn_rec, warn_ad = v5_run(self.window_case(WARNING), [self.HEALTHY])
        dmg_rec, dmg_ad = v5_run(self.window_case(DAMAGE, 'pair-002'), [self.HEALTHY])
        warn_first = json.loads(warn_ad.calls[0][0]['content'])['evidence']
        dmg_first = json.loads(dmg_ad.calls[0][0]['content'])['evidence']
        warn_f = [f for it in warn_first['items'] for f in it['findings']]
        dmg_f = [f for it in dmg_first['items'] for f in it['findings']]
        self.assertEqual([(f['kind'], f['known_defect']) for f in warn_f], [('decoder_warning', False)])
        self.assertEqual([(f['kind'], f['known_defect']) for f in dmg_f], [('decoder_errors', True)])
        self.assertEqual([a['type'] for a in warn_first['alerts']], [])                  # a warning raises no alert, only damage does
        self.assertEqual([(a['type'], a['kind']) for a in dmg_first['alerts'] if a['type'] == 'defect'], [('defect', 'decoder_errors')])
        warn_iv = [iv['state'] for it in warn_first['items'] for iv in it['scope'].get('intervals', [])]
        self.assertNotIn('damaged', warn_iv)
        self.assertEqual(dmg_first['coverage']['time']['unrecorded']['damaged'], [[4.0, 8.0]])
        # the guard: a warning leaves the (clean) healthy answer alone; damage turns it into an escalation and keeps the original
        self.assertEqual((warn_rec['decision']['class'], warn_rec['decision']['action'], warn_rec['guard']['final_changed']), ('healthy', 'none', False))
        self.assertEqual((dmg_rec['decision']['class'], dmg_rec['decision']['action'], dmg_rec['guard']['final_changed']), ('insufficient_evidence', 'escalate', True))
        self.assertEqual(dmg_rec['guard']['applied'][0]['original']['class'], 'healthy')
        self.assertIn('e3', dmg_rec['decision']['reason'])

    def test_pair_a_clean_results_elsewhere_do_not_cancel_damage_in_either_order(self):
        a = self.window_case(DAMAGE)
        b = self.window_case(DAMAGE, 'pair-003')
        b['evidence'] = list(reversed(b['evidence']))
        for case in (a, b):
            rec, _ = v5_run(case, [dec('healthy', 'none', refs=[e['id'] for e in case['evidence']])])
            self.assertEqual((rec['decision']['class'], rec['guard']['final_changed']), ('insufficient_evidence', True), case['id'])

    def test_pair_b_selected_streams_decide_the_client_comparison(self):
        def comparison(streams):
            a = ev2h.analysis([obs('e1', 'ffprobe', 'ok', probe_out(streams=streams))], {'client_profile': PROFILE})
            return a['client']
        video = {'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'pix_fmt': 'yuv420p', 'width': 640, 'height': 480}
        aac = {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'profile': 'LC', 'channels': 2, 'sample_rate': '48000'}
        eac3 = {'index': 1, 'codec_type': 'audio', 'codec_name': 'eac3', 'channels': 6, 'sample_rate': '48000'}
        commentary = {'index': 2, 'codec_type': 'audio', 'codec_name': 'eac3', 'channels': 6, 'sample_rate': '48000'}
        one = comparison([video, aac])
        self.assertEqual((one['summary']['unsupported'], one['summary']['complete']), (0, True))
        self.assertEqual(one['selection']['audio']['how'], 'only_stream_of_type')
        flipped = comparison([video, eac3])                        # the only difference is the one audio stream
        self.assertEqual([r['field'] for r in flipped['rows'] if r['verdict'] == 'unsupported'], ['audio_codec', 'audio_channels'])
        two = comparison([video, aac, commentary])                  # a second audio stream and no recorded selection: no overall claim, never a guess
        self.assertEqual(two['selection']['audio']['how'], 'ambiguous')
        self.assertFalse(two['summary']['complete'])
        self.assertEqual(two['summary']['selection'], 'ambiguous')
        def recorded(audio):
            return ev2h.analysis([obs('e1', 'ffprobe', 'ok', {'streams': {'container': 'matroska,webm', 'video': {'codec_type': 'video', 'codec_name': 'h264', 'pix_fmt': 'yuv420p', 'width': 640, 'height': 480},
                                                                       'selected_audio': audio}})], {'client_profile': PROFILE})['client']
        ok, bad = recorded({'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}), recorded({'codec_type': 'audio', 'codec_name': 'eac3', 'channels': 6})
        self.assertEqual(ok['selection']['audio']['how'], 'recorded')
        self.assertEqual((ok['summary']['unsupported'], bad['summary']['unsupported']), (0, 2))     # the recorded selected stream alone flips the verdict

    def test_pair_c_unknown_versus_clean(self):
        def integrity(tool, output, **kw):
            return ev2h.analysis([obs('e1', tool, 'ok', output, **kw)], {})['items']['e1'].integrity
        self.assertEqual(integrity('ffprobe', probe_out()), 'clean')
        self.assertEqual(integrity('ffprobe', {}), 'unknown')                                  # an empty answer is not a clean probe
        self.assertEqual(integrity('decode_sample', decode_out()), 'clean')
        self.assertEqual(integrity('decode_sample', {'exit_code': 0}), 'unknown')              # exit 0 alone certifies nothing
        self.assertEqual(integrity('decode_sample', decode_out(stderr=WARNING)), 'unknown')    # a warning is neither clean nor damaged
        self.assertEqual(integrity('decode_sample', decode_out(stderr='some message nobody classified')), 'unknown')
        self.assertEqual(integrity('decode_sample', decode_out(stderr=DAMAGE)), 'damaged')
        # through the runner: with only unknown integrity evidence a healthy answer is turned into an escalation; with a clean probe it stands
        unknown_case = case_with([ev('e1', 'ffprobe', output={}), ev('e2', 'decode_sample', output=decode_out(stderr=WARNING))], cid='pair-004')
        clean_case = case_with([ev('e1', 'ffprobe', output=probe_out()), ev('e2', 'decode_sample', output=decode_out(stderr=WARNING))], cid='pair-005')
        unknown_rec, _ = v5_run(unknown_case, [dec('healthy', 'none', refs=['e1', 'e2'])])
        clean_rec, _ = v5_run(clean_case, [dec('healthy', 'none', refs=['e1', 'e2'])])
        self.assertEqual((unknown_rec['decision']['class'], unknown_rec['guard']['final_changed']), ('insufficient_evidence', True))
        self.assertEqual((clean_rec['decision']['class'], clean_rec['guard']['final_changed']), ('healthy', False))

    def test_pair_d_citations_resolve_only_to_emitted_ids(self):
        case = case_with([], tools=('ffprobe', 'decode_sample'), cid='pair-006')
        bad = '[in#0/matroska,webm @ 0x0] File ended prematurely'
        ts = th.TempSuite([case])
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(),
                        decode_sample=dict(L.REPLAY_FILE['decode_sample'], **{'4': dict(L.DEC_BAD, stderr=bad)}))
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        ts.add_file('media/x.mkv', b'not really media' * 50)
        case['fixture'] = {'kind': 'local', 'locator': 'media/x.mkv', 'sha256': hashlib.sha256(b'not really media' * 50).hexdigest()}
        (ts.root / 'cases' / (case['id'] + '.json')).write_text(json.dumps(case))
        script = lambda ref: [tc('decode_sample', {'at': 4}), dec('corrupt_file', 'escalate', refs=[ref])]
        ok_rec, ok_ad = ev2h.scripted_run(case, ts, script('t1'), prompt='v5', evidence_format='v2', guards='v3', which=th.NO_BINARIES)
        reply = json.loads(ok_ad.calls[-1][-1]['content'])['output']
        emitted = [f['id'] for f in reply['findings']] if 'findings' in reply else []
        self.assertTrue(emitted and emitted[0].startswith('t1.f'), reply.keys())
        f_rec, _ = ev2h.scripted_run(case, ts, script(emitted[0]), prompt='v5', evidence_format='v2', guards='v3', which=th.NO_BINARIES)
        n_rec, _ = ev2h.scripted_run(case, ts, script('t1.f99'), prompt='v5', evidence_format='v2', guards='v3', which=th.NO_BINARIES)
        known = {'t1'}
        resolve = EV2.reference_resolver(known, {emitted[0]: 't1'})
        self.assertEqual(resolve([emitted[0]]), ['t1'])                  # an emitted finding id stands for its observation
        self.assertEqual(resolve(['t1.f99']), ['t1.f99'])                # one that was never emitted stays a bad reference
        self.assertEqual(f_rec['decision']['evidence_refs'], [emitted[0]])      # the decision is stored as written
        self.assertEqual(n_rec['decision']['evidence_refs'], ['t1.f99'])
        ts.cleanup()

    def test_pair_d_a_page_fetch_costs_a_call_and_an_unread_page_is_unseen(self):
        big = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(160)]
        case = L.tv_case('pair-007', evidence=[], tools_available=['ffprobe', 'decode_sample'])
        ts = L.suite_with(case, probes=False)
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=dict(L.PROBE_REC, chapters=big))
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        _, ad0 = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], prompt='v5', evidence_format='v2', which=th.NO_BINARIES)
        page = json.loads(ad0.calls[-1][-1]['content'])['output']['page']
        self.assertGreater(page['of'], 1)
        self.assertTrue(page['next_costs_tool_call'])
        rec1, ad1 = ev2h.scripted_run(case, ts, [tc('ffprobe'), dec()], prompt='v5', evidence_format='v2', which=th.NO_BINARIES)
        rec2, ad2 = ev2h.scripted_run(case, ts, [tc('ffprobe'), tc('ffprobe', {'cursor': page['next']}), dec()], prompt='v5', evidence_format='v2', which=th.NO_BINARIES)
        self.assertEqual(json.loads(ad1.calls[-1][-1]['content'])['tool_calls_remaining'], 5)
        self.assertEqual(json.loads(ad2.calls[-1][-1]['content'])['tool_calls_remaining'], 4)          # the fetch used a call of the six
        self.assertEqual([c['tool'] for c in rec2['tool_calls']], ['ffprobe', 'page'])
        self.assertTrue(rec2['tool_calls'][1]['continuation'])
        # a model that fetches nothing sees the split marker and a count of what is elsewhere, never the rest as if it were absent
        first = json.loads(ad1.calls[-1][-1]['content'])['output']
        self.assertTrue(any(k.endswith('_shown') or k == 'elsewhere' for k in json.dumps(first).split('"')) or 'elsewhere' in first['page'])
        ts.cleanup()


class ScoringIsUnchanged(unittest.TestCase):
    """dev-c5 changes no scoring semantics: the evaluator's score.py and the compatibility layer are byte-identical to the dev-c4 ones, and a committed dev-c4 run rescored on
    this tree (the new protocol and run modules are what score.py imports) reproduces its committed score.json exactly."""

    def test_the_scorer_and_the_compatibility_layer_are_byte_identical(self):
        self.assertEqual(hashlib.sha256(score_compat.score_path().read_bytes()).hexdigest(), SCORE_PY_SHA256)
        self.assertEqual(hashlib.sha256(Path(score_compat.__file__).read_bytes()).hexdigest(), SCORE_COMPAT_SHA256)

    def test_committed_dev_c4_runs_rescore_identically(self):
        need_both_suites()
        S = score_compat.load_score()
        runs = th.COMPONENT / 'runs' / 'dev-c4'
        for run in ('devc4-v4g-haiku-5-5', 'devc4-v4g-qwen3.8-27b'):
            now = S.score(runs / run, CTX / 'suite-dev-v1.1')
            old = json.loads((runs / run / 'score.json').read_text())
            self.assertEqual(json.dumps(now, sort_keys=True), json.dumps(old, sort_keys=True), run)


if __name__ == '__main__':
    unittest.main()
