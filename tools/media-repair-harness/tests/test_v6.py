"""dev-c6 tests (W21): prompt v6 (the one prompt that declares contract v3; turn protocol v3, valid only with `--evidence-format v3`), the refusal of every other
combination, the legacy byte identity of v1 to v5, a leak test over COMPLETE v6 + v3 requests of both public dev suites, and the offline byte and context
budget.  Scripted model replies only; no model, no network.  These tests check what the harness sends and that the prompt TEXT carries the contract and names
no case; whether a model follows the text is measured on the dev split (runs/dev-c6), not here."""
import hashlib
import itertools
import json
import re
import tempfile
import unittest
from pathlib import Path

import th
from media_repair_harness import adapters as A
from media_repair_harness import leakguard
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness.experimental.contract_v3 import rubric as RB
from test_v3 import need_both_suites, suite_cases, word

OLD_SHA = {'v1': '30749f5dc7065a2ddd70967cd6888e91d237030e1b025bc6dac19ca51fed9ee8', 'v2': '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a',
           'v3': 'b1fd9e8558396dc288c8b66443a3363f29496032f1e32a0590a1245469e8061a', 'v4': 'a2c3036e57d243a1c892b844a37796ec026e4ea449c4737bcbc3efd01591eedd',
           'v5': '0064e63389bae941508be01e10ab5ee607925105aeafa20dd3d81a00573bba26'}      # v5: the assembled sha256 dev-c5 measured
V5_FILE_SHA256 = '4db2a64ccba83d2ae2fe3d6da9843369d49676019e39519a50464c8ad128e863'
# prompts/v6.txt as amended by Amendment 1 of runs/dev-c6/PREREGISTRATION.md (file bytes) and the assembled text the model is sent (one trailing newline removed)
V6_FILE_SHA256 = '17f34466533792d423caa52c8d5239e9f33a707aa3ff250f2b4abc0d526b637c'
V6_SENT_SHA256 = 'f828f9ac0df6a92e03bd6b0368f1675193be0f295abdcd3d5c3415677ba0a126'
V1_TO_V5_SCHEMAS_SHA256 = '94234f18012a8f338d5f7f3eb11de15aa12e5773857287535e64a6dfd54e0465'   # computed on main 43ce9e9f
NUM_CTX = 8192
ESCALATE = {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': 'r', 'confidence': 0.0, 'evidence_refs': []}


class Capture(A.ScriptedAdapter):
    def __init__(self, model, replies):
        super().__init__(model, replies)
        self.sent = []

    def complete(self, system, messages, schema=None):
        self.sent.append({'system': system, 'messages': json.loads(json.dumps(messages)), 'schema': schema})
        return super().complete(system, messages, schema)


class PromptV6(unittest.TestCase):
    def setUp(self):
        self.v6 = P.get_prompt('v6')['text']

    def test_selectable_on_turn_protocol_v3_and_v1_to_v5_are_byte_identical(self):
        self.assertEqual(P.PROMPT_VERSIONS, ('v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'))     # dev-c7 added v7 (tests/test_devc7.py), dev-c8 v8 (tests/test_devc8.py)
        self.assertEqual(P.DEFAULT_PROMPT, 'v1')
        self.assertEqual([P.protocol_of(v) for v in P.PROMPT_VERSIONS], ['v1', 'v2', 'v2', 'v2', 'v2', 'v3', 'v3', 'v3'])
        for v, sha in OLD_SHA.items():
            self.assertEqual(P.get_prompt(v)['sha256'], sha, v)
        self.assertEqual(hashlib.sha256((P.PROMPT_DIR / 'v5.txt').read_bytes()).hexdigest(), V5_FILE_SHA256)
        self.assertEqual(hashlib.sha256((P.PROMPT_DIR / 'v6.txt').read_bytes()).hexdigest(), V6_FILE_SHA256)
        self.assertEqual(P.get_prompt('v6')['sha256'], V6_SENT_SHA256)
        self.assertEqual(P.HARNESS_VERSION, 'dev-c8')       # dev-c7 and dev-c8 moved it; v6 and its measured text are unchanged
        with self.assertRaises(ValueError):
            P.get_prompt('v9')      # dev-c8 added v8

    def test_the_v1_to_v5_turn_schemas_are_unchanged(self):
        # every v1 to v5 schema (both variants, four tool lists) hashes as on main 43ce9e9f, before dev-c6; v6 has its own
        out = {}
        for v in ('v1', 'v2', 'v3', 'v4', 'v5'):
            for tools in ([], None, ['ffprobe'], ['ffprobe', 'decode_sample', 'arr_lookup']):
                for flat in (False, True):
                    out['%s|%s|%s' % (v, json.dumps(tools), flat)] = hashlib.sha256(json.dumps(P.turn_schema(v, tools, flat=flat), sort_keys=True).encode()).hexdigest()
                    self.assertNotEqual(P.turn_schema('v6', tools, flat=flat), P.turn_schema(v, tools, flat=flat))
        self.assertEqual(hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest(), V1_TO_V5_SCHEMAS_SHA256)

    def test_defines_the_v3_fields_and_the_six_presence_states(self):
        for marker in ('presence', 'absent', 'null', 'empty', 'false', 'zero', 'populated', 'not_checked', 'unknown', 'open', 'open_ids', 'open_removed', 'open_total',
                       'available_check', 'already_shown_as', 'called_failed', 'sources', 'alerts', 'coverage', 'client_comparison', 'capabilities'):
            self.assertIn(marker, self.v6, marker)
        self.assertIn('An explicitly empty value is an observation; an absent one is not evidence of anything', self.v6)
        self.assertIn('evidence-to-action contract v3', self.v6)

    def test_states_the_healthy_sufficiency_rule_and_m1_to_m9(self):
        for h in ('H1', 'H2', 'H3', 'H4', 'H5'):
            self.assertIn(h + ':', self.v6, h)
        for m in range(1, 10):
            self.assertIn('M%d ' % m, self.v6, m)
        self.assertIn('An unchecked remainder alone is not material, and it is never clean', self.v6)
        self.assertIn('needs no full decode', self.v6)
        self.assertIn('positive content confirmation of identity is not required', self.v6)

    def test_amendment_1_naming_and_marker_rules_verbatim(self):
        # Astra 22 item 1 (rubric v3.1 A31-13 and the empty-list fixes; A31-12)
        self.assertIn("Compare each part's album and artist with the catalog. A part's title is a chapter name and is exempt from that comparison. "
                      "Explicit emptiness still matters for all naming fields, including empty lists and empty string elements.", self.v6)
        self.assertIn('Every asserted episode marker must match the target; an erroneous current marker cannot be reused.', self.v6)
        m5 = next(x for x in self.v6.splitlines() if x.startswith('M5 '))
        self.assertIn("a part's title is a chapter name and is exempt from the comparison", m5)

    def test_amendment_1_a_bounded_window_is_not_a_material_conflict(self):
        # Astra 22 item 2: only a FULL decode that ends short of the container is a completion conflict; a completed bounded window leaves an ordinary remainder
        self.assertNotIn('decoded span shorter', self.v6)
        self.assertIn('A full decode whose observed end falls short of the container duration creates a completion conflict.', self.v6)
        self.assertIn('A successfully completed bounded window leaves an ordinary unchecked remainder, which alone is not material.', self.v6)
        m4 = next(x for x in self.v6.splitlines() if x.startswith('M4 '))
        self.assertNotIn('decoded span', m4)

    def test_separates_diagnosis_from_action_prerequisites(self):
        self.assertIn('DIAGNOSIS PREREQUISITES', self.v6)
        self.assertIn('ACTION PREREQUISITES', self.v6)
        self.assertIn('A write needs the diagnosis prerequisites of its class AND its action prerequisites', self.v6)
        self.assertIn('when the class is established but a write\'s action prerequisites are not, keep the class and choose escalate', self.v6)
        self.assertIn('insufficient_evidence is for a diagnosis that is itself unresolved', self.v6)
        self.assertLess(self.v6.index('DIAGNOSIS PREREQUISITES'), self.v6.index('ACTION PREREQUISITES'))

    def test_source_binding_and_the_action_specific_targets(self):
        self.assertIn('Source binding only says which file the proposal is about; it is not evidence of what the file contains or that it is healthy', self.v6)
        self.assertIn('"case_item"', self.v6)
        for kind in ('release_of_source', 'destination_slot', 'rename_of_source', 'isolated_copy'):
            self.assertIn('"kind":"%s"' % kind, self.v6, kind)
        self.assertIn('"allocated_by":"executor"', self.v6)
        self.assertIn('a missing destination name is not a missing prerequisite, and never invent a path', self.v6)
        self.assertIn('Neither a clean full decode of the source nor a destination name is a prerequisite', self.v6)
        self.assertIn('old_value is the literal current name as shown', self.v6)
        self.assertIn('a missing field shows nothing', self.v6)
        # the targets in the text are exactly the frozen decision-v3 target kinds and keys
        from media_repair_harness.experimental.contract_v3 import targets as TG
        for action, (kind, fields) in TG.TARGET_KINDS.items():
            line = next(x for x in self.v6.splitlines() if x.startswith('- %s: {"kind":"%s"' % (action, kind)))
            for f in fields:
                self.assertIn('"%s"' % f, line, (action, f))

    def test_links_may_inspect_never_will_resolve_and_the_check_before_escalating(self):
        self.assertIn('"this tool may inspect this scope", never "it will resolve it"', self.v6)
        self.assertIn('says nothing about what the tool would find', self.v6)
        self.assertIn('including an offered check whose result is recorded (see capabilities), is one to consider while calls remain', self.v6)
        self.assertIn('it may or may not settle it', self.v6)

    def test_q01_is_left_open_and_abstention_is_stated_neutrally(self):
        self.assertIn('The contract leaves open which of the two classes a remap belongs to; both are accepted', self.v6)
        low = self.v6.lower()
        for phrase in ('wrong episode', 'wrong-episode', 'episode mapping', 'episode link', 'wrong item link', 'different episode', 'a wrong repair is worse',
                       'when in doubt', 'prefer escalat', 'escalate less', 'safer to escalate', 'err on'):
            self.assertNotIn(phrase, low, phrase)
        self.assertIn('Escalating, leaving the item alone and proposing a write are all decisions; choose the one the evidence supports', self.v6)

    def test_the_text_is_general_no_case_no_dev_numbers_no_internals(self):
        low = self.v6.lower()
        for token in ('injected', 'dev-c', 'dev-v', 'held-out', 'heldout', 'gates.md', 'g1', 'g2', 'g3', 'score.py', 'truth', 'solvable', 'v4 ', 'v5', 'prompt v',
                      'label', 'adjudication', 'qwen', 'haiku', 'astra'):
            self.assertNotIn(token, low, token)
        self.assertIsNone(re.search(r'\btension', low))
        self.assertEqual(re.findall(r'\b[a-z]+-[a-z]+-\d{3}\b', self.v6), [])
        self.assertEqual(re.findall(r'\b\w+\.(?:mkv|mp4|epub|m4b|mp3|avi)\b', self.v6, re.I), [])
        # every number is a protocol or rubric constant: the call budget, the page size, the enforced limits, the runtime tolerance, the placeholder confidence and rule numbers
        numbers = set(re.findall(r'(?<![A-Za-z_.])\d+(?:\.\d+)?', self.v6))
        self.assertEqual(numbers - set('0123456789') - {'8192', '200', '400', '16', '12', '0.0'}, set(), sorted(numbers))
        for f in RB.FORBIDDEN_FIELDS:
            self.assertNotIn('"%s"' % f, self.v6, f)

    def test_the_text_names_no_case_of_either_public_dev_suite_and_the_leak_guard_passes(self):
        n = 0
        for d in need_both_suites():
            for c in suite_cases(d):
                n += 1
                leakguard.check_system(c, self.v6)
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
                        self.assertIsNone(word(t).search(self.v6), (c['id'], t))
        self.assertEqual(n, 146)


class EveryOtherCombinationIsRefused(unittest.TestCase):
    """The whole matrix of prompt x evidence format x guards: exactly the combinations that existed before, plus v6 with format v3 and guards off or v3."""

    ALLOWED_BEFORE = {(p, None, g) for p in ('v1', 'v2', 'v3', 'v4') for g in (None, 'v1', 'v2', 'v3')} | {(p, 'v2', g) for p in ('v4', 'v5') for g in (None, 'v3')}
    ALLOWED_V3 = {('v6', 'v3', None), ('v6', 'v3', 'v3')}

    def test_the_matrix(self):
        allowed = set()
        for combo in itertools.product(P.PROMPT_VERSIONS, (None, 'v2', 'v3'), (None, 'v1', 'v2', 'v3')):
            try:
                R.check_option_combination(*combo)
            except ValueError:
                continue
            allowed.add(combo)
        self.assertEqual(allowed, self.ALLOWED_BEFORE | self.ALLOWED_V3)
        for fmt in ('v4', 'v1', 'legacy'):
            with self.assertRaises(ValueError):
                R.check_option_combination('v6', fmt)

    def test_the_messages_name_the_rule(self):
        with self.assertRaises(ValueError) as cm:
            R.check_option_combination('v5', 'v3')
        self.assertIn('contract v3', str(cm.exception))
        self.assertIn('v5 explains evidence format v2', str(cm.exception))
        for fmt in (None, 'v2'):
            with self.assertRaises(ValueError) as cm:
                R.check_option_combination('v6', fmt)
            self.assertIn('valid only with --evidence-format v3', str(cm.exception))
        with self.assertRaises(ValueError):
            R.check_option_combination('v6', 'v3', None, 2000)              # the page budget floor of pages-v1 applies
        R.check_option_combination('v6', 'v3', 'v3', 2560)

    def test_run_case_and_main_refuse_before_any_model_call(self):
        case = th.make_case(id='w21-r1')
        for pv, fmt in (('v6', None), ('v6', 'v2'), ('v5', 'v3'), ('v4', 'v3')):
            ad = A.ScriptedAdapter('m', [ESCALATE])
            with self.assertRaises(ValueError):
                R.run_case(case, 'x', ad, '.', tempfile.mkdtemp(), prompt_version=pv, evidence_format=fmt)
            self.assertEqual(ad.calls, [])
        ts = th.TempSuite([case])
        out = Path(tempfile.mkdtemp()) / 'r1'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('m', [ESCALATE])
        try:
            for argv in (['--prompt', 'v6'], ['--prompt', 'v6', '--evidence-format', 'v2'], ['--prompt', 'v5', '--evidence-format', 'v3'],
                         ['--prompt', 'v6', '--evidence-format', 'v3', '--guards', 'v2']):
                with self.assertRaises(SystemExit):
                    R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp()] + argv)
                self.assertFalse(out.exists())
        finally:
            R.build_adapter = orig
        ts.cleanup()


class Amendment1Wiring(unittest.TestCase):
    """dev-c6 Amendment 1: an explicitly uncapped run (Astra 22 item 3), the codex timeout in the config hash and guard_cli refusing guards v1 / v2 on a v3 record (Opus P3)."""

    def args(self, *extra):
        import argparse
        ns = argparse.Namespace(adapter='claude', model='claude-haiku-5-5', effort=None, max_budget_usd=None, no_spend_limit=False, prompt='v6')
        for k, v in extra:
            setattr(ns, k, v)
        return ns

    def test_the_legacy_default_still_sends_the_two_dollar_per_call_flag(self):
        ad = R.build_adapter(self.args())
        self.assertEqual(ad.max_budget_usd, 2.0)
        argv = ad.argv('sys')
        self.assertEqual(argv[argv.index('--max-budget-usd') + 1], '2.0')
        self.assertEqual(ad.config()['max_budget_usd'], 2.0)
        ad = R.build_adapter(self.args(('max_budget_usd', 0.5)))
        self.assertEqual(ad.argv('sys')[ad.argv('sys').index('--max-budget-usd') + 1], '0.5')

    def test_no_spend_limit_omits_every_spend_flag_and_keeps_the_timeout(self):
        ad = R.build_adapter(self.args(('no_spend_limit', True)))
        self.assertIsNone(ad.max_budget_usd)
        argv = ad.argv('sys')
        self.assertNotIn('--max-budget-usd', argv)
        self.assertFalse([x for x in argv if 'budget' in x or 'cost' in x])
        self.assertEqual((ad.config()['max_budget_usd'], ad.config()['timeout_s']), (None, 240))

    def test_main_records_the_uncapped_setting_and_refuses_a_contradiction(self):
        case = th.make_case(id='w21-s1')
        ts = th.TempSuite([case])
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('m', [ESCALATE])
        try:
            out = Path(tempfile.mkdtemp()) / 'r-s1'
            R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                    '--prompt', 'v6', '--evidence-format', 'v3', '--guards', 'v3', '--no-spend-limit'])
            man = json.loads((out / 'manifest.json').read_text())
            self.assertEqual(man['config']['spend_limit'], 'uncapped')
            self.assertNotIn('limits', man['config'])
            out2 = Path(tempfile.mkdtemp()) / 'r-s2'
            R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out2), '--scratch', tempfile.mkdtemp(), '--prompt', 'v6', '--evidence-format', 'v3'])
            self.assertNotIn('spend_limit', json.loads((out2 / 'manifest.json').read_text())['config'])     # unset: the earlier config shape
            for extra in (['--max-budget-usd', '1'], ['--max-total-cost-usd', '1']):
                with self.assertRaises(SystemExit):
                    R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(Path(tempfile.mkdtemp()) / 'r'), '--prompt', 'v6',
                            '--evidence-format', 'v3', '--no-spend-limit'] + extra)
        finally:
            R.build_adapter = orig
        ts.cleanup()

    def test_the_codex_timeout_is_in_the_adapter_config(self):
        self.assertEqual(A.CodexAdapter('gpt-6-astra', effort='high').config()['timeout_s'], 300)
        self.assertIn('model_reasoning_effort="high"', ' '.join(A.CodexAdapter('gpt-6-astra', effort='high').argv()))

    def test_guard_cli_refuses_guards_v1_and_v2_on_a_v3_record(self):
        from media_repair_harness import guard_cli as GC
        case = th.make_case(id='w21-g1', evidence=[{'id': 'e1', 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': '{}'}], tools_available=[])
        ts = th.TempSuite([case])
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('m', [ESCALATE])
        out = Path(tempfile.mkdtemp()) / 'r-g1'
        try:
            R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', 'v6', '--evidence-format', 'v3', '--guards', 'v3'])
        finally:
            R.build_adapter = orig
        for v in ('v1', 'v2'):
            with self.assertRaises(SystemExit):
                GC.guard_run(out, ts.root, Path(tempfile.mkdtemp()) / ('g-' + v), version=v)
        GC.guard_run(out, ts.root, Path(tempfile.mkdtemp()) / 'g-v3', version='v3')
        GC.guard_run(out, ts.root, Path(tempfile.mkdtemp()) / 'g-restore', restore=True)
        ts.cleanup()


def run_v6(case, suite, replies, run_id='w21-leak'):
    ad = Capture('scripted-model', replies)
    rec = R.run_case(case, 'sha', ad, suite, tempfile.mkdtemp(prefix='mrh-w21-'), run_id=run_id, prompt_version='v6', evidence_format='v3', guards='v3',
                     replay='auto', which=th.NO_BINARIES, tool_output_bytes=NUM_CTX)
    return rec, ad


def first_available_call(first_message):
    """The first `available` link of the first message (what a model might call), as a tool-call reply; None when there is none."""
    body = json.loads(first_message)
    for it in body['evidence'].get('open') or []:
        for c in it['available_check']:
            if c['availability'] == 'available':
                return {'type': 'tool_call', 'tool': c['tool'], 'args': c['args'], 'why': 'w'}
    return None


class CompleteRequestsOfBothPublicSuites(unittest.TestCase):
    """Every case of dev-v1 and dev-v1.1 through the real runner under v6 + v3 (replay, no binaries): the first message, one call of the first available link and the
    decision.  Every request is checked by the leak guard (inside run_case: a LeakError is a harness crash, and none happened), and the complete sent text carries no
    hidden case field.  The 8192-byte budget holds for every message, and the first message plus the system prompt stays below the 8192-token context estimate."""

    @classmethod
    def setUpClass(cls):
        cls.rows = []
        for d in need_both_suites():
            for case in suite_cases(d):
                rec, ad = run_v6(case, d, [ESCALATE])
                call = first_available_call(ad.sent[0]['messages'][0]['content'])
                rec2, ad2 = (rec, ad) if call is None else run_v6(case, d, [call, ESCALATE])
                cls.rows.append((d, case, rec, ad, rec2, ad2, call))

    def test_no_request_leaks_a_hidden_case_field_and_nothing_crashed(self):
        self.assertEqual(len(self.rows), 146)
        calls = 0
        for d, case, rec, ad, rec2, ad2, call in self.rows:
            for r in (rec, rec2):
                self.assertIsNone(r.get('error'), (case['id'], r.get('error')))
            calls += call is not None
            text = json.dumps([s['messages'] for s in ad.sent + ad2.sent], ensure_ascii=False)
            self.assertNotIn(case['id'], text)
            for k in ('truth', 'supported_actions', 'solvable', 'accepted_classes', 'family', 'provenance', 'inject_tool_failure', 'outcome_step'):
                self.assertNotIn('"%s"' % k, text, (case['id'], k))
            ref = (case.get('truth') or {}).get('ref')
            if isinstance(ref, str) and len(ref) >= 6:
                self.assertNotIn(ref, text, case['id'])
            for f in RB.FORBIDDEN_FIELDS:
                self.assertNotIn('"%s":' % f, text, (case['id'], f))
            for s in ad.sent + ad2.sent:
                self.assertEqual(s['system'], P.get_prompt('v6')['text'])
        self.assertGreaterEqual(calls, 40)     # many cases offer an available link (48 of 146 when this was written): tool results under v3 are exercised too

    def test_every_message_fits_8192_bytes_and_the_first_message_fits_the_context_estimate(self):
        worst_est = 0
        for d, case, rec, ad, rec2, ad2, call in self.rows:
            for r in (rec, rec2):
                for m in r['evidence_format']['messages']:
                    sizes = m['bytes'] if isinstance(m['bytes'], list) else [m['bytes']]
                    self.assertTrue(all(b <= NUM_CTX for b in sizes), (case['id'], m))
            first = ad.sent[0]['messages'][0]['content']
            self.assertLessEqual(len(first.encode('utf-8')), NUM_CTX, case['id'])
            est = int((len(ad.sent[0]['system']) + len(first)) / 3.0)      # the Ollama adapter's pessimistic estimate (3 characters per token)
            worst_est = max(worst_est, est)
        self.assertLess(worst_est, NUM_CTX, worst_est)

    def test_the_decision_v3_escalate_is_first_try_valid_everywhere(self):
        for d, case, rec, ad, rec2, ad2, call in self.rows:
            self.assertTrue(rec['first_try_valid'], case['id'])
            self.assertEqual(rec['action_audit']['audit_version'], 'v3')


if __name__ == '__main__':
    unittest.main()
