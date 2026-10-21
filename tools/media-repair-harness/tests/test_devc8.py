"""dev-c8 (WO-W26 with the AUDIT-ASTRA-36 amendments): prompt v8, turn-v3.1 (the length-specific repair hint), the Claude reply-schema adapter mode
(claude-schema-1) and guards v4 (G-role).

Every fixture here is synthetic and generic (invented titles, ids and values; no suite case id, title or value).  These tests were written and frozen
before any dev-c7 what-if count was computed (A36 items 1 and 5); they do not depend on dev scores."""
import copy
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path

import ev2h
import th
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import leakguard
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import rubric as RB
from test_v3 import need_both_suites, suite_cases, word

V8_FILE_SHA256 = 'd1b921b6661c44ad9433c33d2455cba13c78988ecc7d9a5652047217a7e987a4'
V8_ASSEMBLED_SHA256 = '213c9d7d2b396d349b50ceb2ea377ad9385f06dd3ff4dbcc4e1bbe63ed4d8a5e'
V7_ASSEMBLED_SHA256 = P.get_prompt('v7')['sha256']      # pinned in test_devc7.py; repeated here only to show v8 left it alone


def v8():
    return P.get_prompt('v8')['text']


# ------------------------------------------------------------------------------------------------------------------------------ prompt v8
class PromptV8(unittest.TestCase):
    def test_registered_on_turn_v3_with_the_v31_repair_name_and_pinned(self):
        self.assertEqual(P.PROMPT_VERSIONS[-1], 'v8')
        self.assertEqual((P.protocol_of('v8'), R._turn_protocol('v8'), R._turn_protocol('v7')), ('v3', 'turn-v3.1', 'turn-v3'))
        self.assertIn('v8', P.STRICT_TOOL_SCHEMA)
        self.assertEqual(hashlib.sha256((th.COMPONENT / 'src' / 'media_repair_harness' / 'prompts' / 'v8.txt').read_bytes()).hexdigest(), V8_FILE_SHA256)
        self.assertEqual(P.get_prompt('v8')['sha256'], V8_ASSEMBLED_SHA256)
        self.assertEqual(P.get_prompt('v7')['sha256'], V7_ASSEMBLED_SHA256)
        self.assertEqual(P.turn_schema('v8', ['ffprobe']), P.turn_schema('v7', ['ffprobe']))       # the decision schema and validator are v3's

    def test_only_the_three_ordered_changes(self):
        v7 = P.get_prompt('v7')['text'].split('\n')
        new = v8().split('\n')
        added = [ln for ln in new if ln not in v7]
        removed = [ln for ln in v7 if ln not in new]
        # removed: the old M4, M7 and steps 3 to 6 (renumbered, one reworded for brevity); nothing else
        self.assertEqual(len(removed), 6, removed)
        self.assertTrue(all(ln.startswith(('M4 ', 'M7 ', '3. ', '4. ', '5. ', '6. ')) for ln in removed), removed)
        for ln in added:
            self.assertTrue(ln == '' or ln.startswith(('BREVITY', 'Lengths are counted', '- reason:', '- why:', 'Generic examples', 'healthy: "reason"',
                                                     'escalation: "reason"', 'permitted write: "reason"', 'why: "why"', 'M4 ', 'M7 ',
                                                     '3. ', '4. ', '5. ', '6. ', '7. ', '8. ')), ln)

    def test_brevity_is_operational_and_neutral(self):
        t = v8()
        for s in ('Aim lower: reason about 300 characters, why about 120', 'These targets are guidance, not extra rules',
                  'any reply within the hard limits is valid', 'escalating is as valid as leaving the item alone or proposing a write',
                  'any material limitation that affects the decision', 'Do not restate rules that are satisfied',
                  'counted in characters after JSON decoding', 'the unchecked scope of a healthy decision', 'where a claim comes from',
                  'a decisive contradiction'):
            self.assertIn(s, t)
        self.assertNotIn('one material limitation', t)
        self.assertNotIn('say in the reason what was and was not verified', t)
        self.assertIn('reason 1 to 400 characters', t)            # the hard limits are unchanged
        self.assertIn('"why":"<=200 chars"', t)

    def test_the_generic_examples_fit_the_soft_budgets(self):
        t = v8()
        reasons = re.findall(r'^(?:healthy|escalation|permitted write): "reason":"([^"]+)"$', t, re.M)
        whys = re.findall(r'^why: "why":"([^"]+)"$', t, re.M)
        self.assertEqual((len(reasons), len(whys)), (3, 1))
        for r in reasons:
            self.assertLessEqual(len(r), P.LENGTH_FIELDS['reason']['soft'], r)
        for w in whys:
            self.assertLessEqual(len(w), P.LENGTH_FIELDS['why']['soft'], w)
        self.assertIn('Escalating.', reasons[1])        # one example of each kind: healthy, escalation, a permitted write
        self.assertIn('Blocklist and search.', reasons[2])

    def test_decode_completion_runtime_and_edition_are_independent_comparisons(self):
        t = v8()
        v7 = P.get_prompt('v7')['text']
        old = 'M4 integrity: a signal pointing into the unchecked remainder: a container duration differing from the catalog runtime'
        self.assertIn(old, v7)
        self.assertNotIn(old, t)
        for s in ('separate check from decode completion (M3)', 'it never resolves a container-catalog disagreement, which stays material whatever the decode shows',
                  'several fitting candidates and no evidenced selection', 'An absent edition field alone is not this', 'one listed candidate leaves nothing to choose',
                  'A complete decode, or a runtime that fits several candidates, selects none of them', 'Resolving one never resolves another'):
            self.assertIn(s, t)
        self.assertIn('A successfully completed bounded window leaves an ordinary unchecked remainder, which alone is not material.', t)

    def test_action_roles_at_the_moment_of_response_and_q01_left_open(self):
        t = v8()
        for s in ('uncontradicted identity (nothing shown disagrees with the catalog) is not content-verified identity',
                  'rename needs the second', "a prior record's claim that is not report_content never verifies identity",
                  'case_item is never that record; case_item is the source only when context.arr.app is null', 'If a role is not filled, keep the class and escalate.',
                  'cited by its evidence id (an e or t id as shown), never by an id copied from a field of a record or of the context'):
            self.assertIn(s, t)
        q01 = 'The contract leaves open which of the two classes a remap belongs to; both are accepted.'
        self.assertEqual((t.count(q01), P.get_prompt('v7')['text'].count(q01)), (1, 1))
        low = t.lower()
        for phrase in ('wrong episode', 'wrong-episode', 'episode mapping', 'prefer escalat', 'when in doubt', 'safer to escalate', 'err on'):
            self.assertNotIn(phrase, low)

    def test_the_text_is_general(self):
        t = v8()
        low = t.lower()
        for token in ('injected', 'dev-c', 'dev-v', 'held-out', 'heldout', 'gates.md', 'score.py', 'truth', 'solvable', 'prompt v', 'label', 'adjudication',
                      'qwen', 'haiku', 'astra', 'opus'):
            self.assertNotIn(token, low, token)
        self.assertEqual(re.findall(r'\b[a-z]+-[a-z]+-\d{3}\b', t), [])
        self.assertEqual(re.findall(r'\b\w+\.(?:mkv|mp4|epub|m4b|mp3|avi)\b', t, re.I), [])
        numbers = set(re.findall(r'(?<![A-Za-z_.])\d+(?:\.\d+)?', t))
        v7_numbers = set(re.findall(r'(?<![A-Za-z_.])\d+(?:\.\d+)?', P.get_prompt('v7')['text']))
        self.assertEqual(numbers - v7_numbers, {'300', '120', '7', '8'}, sorted(numbers - v7_numbers))      # the two soft budgets and steps 7 and 8; the example times reuse v7's numbers

    @th.needs_suite
    def test_the_text_names_no_case_of_either_public_dev_suite_and_the_leak_guard_passes(self):
        t = v8()
        n = 0
        for d in need_both_suites():
            for c in suite_cases(d):
                n += 1
                leakguard.check_system(c, t)
                ctx = c.get('context') or {}
                tokens = [c['id'], re.sub(r'-\d+$', '', c['id']), c.get('family') or '', ((c.get('truth') or {}).get('ref') or ''), ctx.get('filename') or '']
                if ' ' in str(ctx.get('title') or ''):
                    tokens.append(str(ctx['title']))
                exp = ctx.get('expected') or {}
                for k in ('title', 'series', 'episode_title', 'author'):
                    if isinstance(exp.get(k), str) and ' ' in exp[k]:
                        tokens.append(exp[k])
                tokens.append(str(((c.get('fixture') or {}).get('locator')) or '').rsplit('/', 1)[-1])
                for tok in tokens:
                    if len(tok) >= 6:
                        self.assertIsNone(word(tok).search(t), (c['id'], tok))
        self.assertEqual(n, 146)

    def test_option_combinations(self):
        R.check_option_combination('v8', 'v3.1-format', None)
        R.check_option_combination('v8', 'v3.1-format', 'v3')
        R.check_option_combination('v8', 'v3.1-format', 'v4')
        R.check_option_combination('v7', 'v3.1-format', 'v4')
        for combo in (('v8', None, None), ('v8', 'v3', None), ('v8', 'v2', None), ('v6', 'v3', 'v4'), ('v4', None, 'v4'), ('v5', 'v2', 'v4'), ('v8', 'v3.1-format', 'v1')):
            with self.assertRaises(ValueError, msg=combo):
                R.check_option_combination(*combo)


# ------------------------------------------------------------------------------------------------------------------------------ turn-v3.1
def dec3(reason='r', cls='insufficient_evidence', action='escalate', **kw):
    d = {'type': 'decision', 'class': cls, 'action': action, 'reason': reason, 'confidence': 0.5, 'evidence_refs': []}
    d.update(kw)
    return d


def tcall(why='w', tool='arr_lookup'):
    return {'type': 'tool_call', 'tool': tool, 'why': why, 'args': {}}


def arr_case(cid='w26-arr'):
    case = ev2h.case_with([], tools=('arr_lookup',), cid=cid, media='tv')
    case['context'].update(title='Alpha Show', filename='Alpha Show - S01E02.mkv', expected={'series': 'Alpha Show', 'season': 1, 'episode': 2},
                           arr={'app': 'sonarr', 'ids': {'episodeFileId': 7}})
    return case


def run8(replies, prompt='v8', guards=None, case=None):
    case = case or arr_case()
    ts = th.TempSuite([case])
    return ev2h.scripted_run(case, ts, [r if isinstance(r, str) else json.dumps(r, ensure_ascii=False) for r in replies], prompt=prompt,
                             evidence_format='v3.1-format', guards=guards, which=th.NO_BINARIES)


class LengthBoundaries(unittest.TestCase):
    """Hard limits are counted on the DECODED string (code points), never on the reply bytes or the escape text."""

    def valid(self, obj):
        return P.validate_turn(obj, ['arr_lookup'], 'v8')

    def test_reason_400_401_and_why_200_201(self):
        self.assertEqual(self.valid(dec3('a' * 400)), ('decision', []))
        k, errs = self.valid(dec3('a' * 401))
        self.assertIsNone(k)
        self.assertTrue(P.length_only(dec3('a' * 401), 'v8', ['arr_lookup']))
        self.assertEqual(self.valid(tcall('w' * 200)), ('tool_call', []))
        self.assertIsNone(self.valid(tcall('w' * 201))[0])
        self.assertTrue(P.length_only(tcall('w' * 201), 'v8', ['arr_lookup']))
        self.assertEqual(P.length_failures(tcall('w' * 201)), [{'field': 'why', 'chars': 201, 'limit': 200, 'soft': 120}])

    def test_unicode_and_escapes_count_after_decoding(self):
        for unit in ('é', '€', '\U0001F600', '日'):
            for n, ok in ((400, True), (401, False)):
                obj, _e, _d = P.parse_reply(json.dumps(dec3(unit * n), ensure_ascii=False))
                self.assertEqual(self.valid(obj)[0] == 'decision', ok, (unit, n))
                esc, _e, _d = P.parse_reply(json.dumps(dec3(unit * n), ensure_ascii=True))      # \\u escapes (a surrogate pair for the emoji)
                self.assertEqual(len(esc['reason']), n)
                self.assertEqual(self.valid(esc)[0] == 'decision', ok, (unit, n, 'escaped'))
        text = json.dumps(dec3('x' * 398 + '\n\t'))
        self.assertGreater(len(text) - len(json.dumps(dec3(''))), 400)          # the reply text spells 402 characters ...
        self.assertEqual(self.valid(P.parse_reply(text)[0]), ('decision', []))  # ... the decoded reason has 400
        self.assertIsNone(self.valid(P.parse_reply(json.dumps(dec3('x' * 399 + '\n\t')))[0])[0])
        why, _e, _d = P.parse_reply(json.dumps(tcall('é' * 201), ensure_ascii=True))
        self.assertEqual(P.length_failures(why)[0]['chars'], 201)


class RepairV31(unittest.TestCase):
    def test_length_only_reason_gets_the_length_form(self):
        obj = dec3('b' * 437)
        _k, errs = P.validate_turn(obj, ['arr_lookup'], 'v8')
        modes = P.failure_modes_v31('v8', json.dumps(obj), obj, errs)
        self.assertIn(P.LENGTH_MODE, modes)
        text, info = P.repair_prompt_v31('; '.join(errs), modes, obj, 'v8', ['arr_lookup'])
        self.assertTrue(info['length_only'])
        for s in ('only for its length', 'reason has 437 characters', 'the limit is 400', 'aim for about 300', 'a short summary of the decisive evidence',
                  'any material limitation that affects the decision', 'do not restate rules that are satisfied'):
            self.assertIn(s, text)
        for s in ('escalate', 'healthy', 'none', 'keep the same', 'same decision', 'class'):
            self.assertNotIn(s, text.lower().replace('decisive', ''), s)      # the wording never steers the decision

    def test_length_only_on_a_write_decision_and_a_tool_call(self):
        write = dec3('c' * 455, cls='metadata_naming', action='rename', source={'ref': 'e3'},
                     target={'kind': 'rename_of_source', 'old_value': 'Old Name.mkv', 'new_value': 'New Name.mkv'})
        self.assertTrue(P.length_only(write, 'v8', ['arr_lookup']))
        call = tcall('d' * 217)
        text, info = P.repair_prompt_v31('why must be a string of at most 200 characters', ['length_limit'], call, 'v8', ['arr_lookup'])
        self.assertTrue(info['length_only'])
        self.assertIn('why has 217 characters; the limit is 200 (aim for about 120)', text)
        self.assertIn('a short summary of what the call should show', text)

    def test_mixed_length_and_semantic_errors_are_not_length_only(self):
        for bad in (dec3('e' * 450, cls='not_a_class'), dec3('e' * 450, action='rename'), dict(dec3('e' * 450), extra=1),
                    dec3('e' * 450, cls='metadata_naming', action='rename', source={'ref': 'e3'}, target={'kind': 'release_of_source', 'source_ref': 'e3'})):
            _k, errs = P.validate_turn(bad, ['arr_lookup'], 'v8')
            self.assertFalse(P.length_only(bad, 'v8', ['arr_lookup']), bad)
            modes = P.failure_modes_v31('v8', json.dumps(bad), bad, errs)
            text, info = P.repair_prompt_v31('; '.join(errs), modes, bad, 'v8', ['arr_lookup'])
            self.assertFalse(info['length_only'])
            self.assertTrue(text.startswith('Your last reply was rejected: '))
            self.assertIn('reason is at most 400 characters (aim for about 300)', text)
        _k, errs = P.validate_turn(dec3('', cls='nope'), ['arr_lookup'], 'v8')
        text, info = P.repair_prompt_v31('; '.join(errs), [], dec3('', cls='nope'), 'v8', ['arr_lookup'])
        self.assertEqual((info['length_only'], info['length_fields']), (False, []))
        self.assertEqual(text, P.repair_prompt('; '.join(errs), []))      # no length failure: exactly the turn-v3 repair prompt

    def test_a_v8_run_records_the_length_repair_and_the_unchanged_allowance(self):
        rec, ad = run8([dec3('f' * 420), dec3('short')])
        self.assertEqual((rec['prompt']['protocol'], rec['prompt']['repair_allowance']['per'], rec['prompt']['repair_allowance']['repair_prompts_max']), ('turn-v3.1', 'case', 1))
        self.assertEqual(len(rec['repair_prompts']), 1)
        rp = rec['repair_prompts'][0]
        self.assertEqual((rp['repair_protocol'], rp['length_only'], rp['length_fields'][0]['chars']), ('turn-v3.1', True, 420))
        self.assertIn('only for its length', rp['prompt'])
        self.assertEqual((rec['first_try_valid'], rec['forced'], rec['decision']['reason']), (False, False, 'short'))
        self.assertEqual(rec['turns'][0]['text'], json.dumps(dec3('f' * 420), ensure_ascii=False))      # the raw first try is kept, untruncated
        self.assertIn('length_limit', rec['turns'][0]['failure_modes'])
        self.assertIn('length_limit', rec['first_try']['failure_modes'])

    def test_an_overflow_after_the_cases_repair_is_used_is_forced_with_no_extra_allowance(self):
        rec, ad = run8([tcall('g' * 230), tcall('ok'), dec3('h' * 480)])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertTrue(rec['repair_prompts'][0]['length_only'])
        self.assertEqual(rec['repair_prompts'][0]['length_fields'][0]['field'], 'why')
        self.assertTrue(rec['forced'])
        self.assertTrue(rec['forced_reason'].startswith('invalid output after the one repair prompt'))
        self.assertEqual(len(rec['turns']), 3)
        self.assertEqual(rec['turns'][2]['text'], json.dumps(dec3('h' * 480), ensure_ascii=False))
        self.assertIn('length_limit', rec['turns'][2]['failure_modes'])
        self.assertEqual(len(ad.calls), 3)          # no fourth call: the allowance is per case

    def test_v7_keeps_its_repair_prompt_and_record_shape(self):
        rec, _ad = run8([dec3('f' * 420), dec3('short')], prompt='v7')
        rp = rec['repair_prompts'][0]
        self.assertNotIn('repair_protocol', rp)
        self.assertNotIn('repair_allowance', rec['prompt'])
        self.assertEqual(rp['prompt'], P.repair_prompt(rp['error'], rp['failure_modes']))
        self.assertNotIn('length_limit', rp['failure_modes'])
        self.assertEqual(rec['prompt']['protocol'], 'turn-v3')


# ------------------------------------------------------------------------------------------------------------------------------ Claude schema
def stream(*events):
    return '\n'.join(json.dumps(e) for e in events) + '\n'


INIT = {'type': 'system', 'subtype': 'init', 'tools': ['StructuredOutput'], 'model': 'claude-test-model', 'claude_code_version': '9.9.9'}


def attempt(i, payload):
    return {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'tu%d' % i, 'name': 'StructuredOutput', 'input': payload}]}}


def checked(i, error):
    return {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tu%d' % i, 'is_error': error,
                                                    'content': 'Output does not match required schema' if error else 'Structured output provided successfully'}]}}


def result(structured=None, subtype='success', text='', cost=0.01, **kw):
    r = {'type': 'result', 'subtype': subtype, 'is_error': subtype != 'success', 'result': text, 'num_turns': 2, 'duration_ms': 10,
         'usage': {'input_tokens': 100, 'output_tokens': 20, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 5},
         'total_cost_usd': cost, 'modelUsage': {'claude-test-model': {}}}
    if structured is not None:
        r['structured_output'] = structured
    r.update(kw)
    return r


class FakeProc:
    def __init__(self, out, rc=0, err=''):
        self.stdout, self.returncode, self.stderr = out.encode(), rc, err.encode()


class FakeRunner:
    def __init__(self, outs, version='2.1.296 (Claude Code)'):
        self.outs, self.cmds, self.version = list(outs), [], version

    def __call__(self, cmd, **kw):
        self.cmds.append(cmd)
        if cmd[:2] == ['claude', '--version']:
            class V:
                stdout = self.version + '\n'
            return V()
        return FakeProc(self.outs.pop(0))


class ClaudeSchema(unittest.TestCase):
    SCHEMA = P.turn_schema('v8', ['arr_lookup'], flat=True)

    def test_the_legacy_adapter_is_unchanged(self):
        fr = FakeRunner([json.dumps(result(text=json.dumps(dec3('ok'))))])
        ad = A.ClaudeAdapter('claude-test-model', runner=fr)
        self.assertNotIn('schema_name', vars(ad))
        self.assertEqual(set(ad.config()), {'adapter', 'model', 'effort', 'flags', 'output_format', 'max_budget_usd', 'timeout_s'})
        comp = ad.complete('SYS', [{'role': 'user', 'content': 'x'}], schema=self.SCHEMA)
        self.assertNotIn('--json-schema', fr.cmds[0])
        self.assertEqual(fr.cmds[0][fr.cmds[0].index('--output-format') + 1], 'json')
        self.assertEqual(comp.text, json.dumps(dec3('ok')))

    def test_schema_forwarding_and_the_first_attempt_is_the_reply(self):
        first, second = dec3('i' * 450), dec3('short')
        fr = FakeRunner([stream(INIT, attempt(1, first), checked(1, True), attempt(2, second), checked(2, False), result(structured=second))])
        ad = A.ClaudeAdapter('claude-test-model', runner=fr, schema_mode='json-schema-1')
        comp = ad.complete('SYS', [{'role': 'user', 'content': 'x'}], schema=self.SCHEMA)
        cmd = fr.cmds[0]
        self.assertEqual(cmd[cmd.index('--output-format') + 1], 'stream-json')
        self.assertIn('--verbose', cmd)
        self.assertEqual(json.loads(cmd[cmd.index('--json-schema') + 1]), self.SCHEMA)
        for f in A.CLAUDE_FLAGS:
            self.assertIn(f, cmd)
        self.assertEqual(comp.raw_request['argv'][comp.raw_request['argv'].index('--system-prompt') + 1], '<system>')
        self.assertEqual(json.loads(comp.text), first)              # the model's FIRST try, not the CLI-repaired one
        s = comp.meta['schema']
        self.assertEqual((s['flag_sent'], s['tool_registered'], s['attempts'], s['cli_internal_retries'], s['reply_source'], s['cli_version_reported']),
                         (True, True, 2, 1, 'first_structured_output_attempt', '9.9.9'))
        self.assertEqual([c['is_error'] for c in s['cli_validation']], [True, False])
        self.assertEqual(s['structured_output'], second)
        self.assertEqual(comp.raw_response, fr.outs[0] if fr.outs else comp.raw_response)
        self.assertEqual((comp.usage['input_tokens'], comp.usage['output_tokens'], comp.usage['cache_read_input_tokens'], comp.usage['cost_usd']), (100, 20, 5, 0.01))
        self.assertEqual(comp.response_model, 'claude-test-model')
        self.assertEqual(ad.config()['adapter_version'], 'claude-schema-1')

    def test_exhausted_cli_retries_still_return_the_first_attempt(self):
        first = dec3('j' * 500)
        fr = FakeRunner([stream(INIT, attempt(1, first), checked(1, True), attempt(2, first), checked(2, True), result(subtype='error_max_structured_output_retries'))])
        comp = A.ClaudeAdapter('m', runner=fr, schema_mode='json-schema-1').complete('S', [{'role': 'user', 'content': 'x'}], schema=self.SCHEMA)
        self.assertEqual((json.loads(comp.text), comp.native['subtype'], comp.meta['schema']['result_subtype']), (first, 'error_max_structured_output_retries',
                                                                                                                  'error_max_structured_output_retries'))

    def test_missing_and_malformed_output(self):
        ad = A.ClaudeAdapter('m', runner=FakeRunner([stream(INIT, result(text=''))]), schema_mode='json-schema-1')
        comp = ad.complete('S', [{'role': 'user', 'content': 'x'}], schema=self.SCHEMA)
        self.assertEqual((comp.text, comp.meta['schema']['reply_source'], comp.meta['schema']['structured_output_present']), ('', 'none', False))
        ad = A.ClaudeAdapter('m', runner=FakeRunner([stream(INIT, result(text='{"type":"decision"}'))]), schema_mode='json-schema-1')
        self.assertEqual(ad.complete('S', [], schema=self.SCHEMA).meta['schema']['reply_source'], 'result_text')
        for bad in ('not json\n', stream(INIT), '', stream(INIT, result(subtype='error_during_execution'))):
            ad = A.ClaudeAdapter('m', runner=FakeRunner([bad]), schema_mode='json-schema-1')
            with self.assertRaises(A.AdapterError, msg=bad[:40]):
                ad.complete('S', [], schema=self.SCHEMA)
        try:
            A.ClaudeAdapter('m', runner=FakeRunner([stream(INIT, result(subtype='error_max_budget_usd', cost=0.5))]), schema_mode='json-schema-1').complete('S', [], schema=self.SCHEMA)
        except A.AdapterError as e:
            self.assertEqual((e.budget_exceeded, e.cost_usd), (True, 0.5))          # the failed call keeps its receipt

    def test_a_schema_the_cli_did_not_register_stops_the_run(self):
        init = dict(INIT, tools=[])
        with self.assertRaises(A.AbortRun) as cm:
            A.ClaudeAdapter('m', runner=FakeRunner([stream(init, result(text=json.dumps(dec3('x'))))]), schema_mode='json-schema-1').complete('S', [], schema=self.SCHEMA)
        self.assertEqual(cm.exception.failed_call['failure_modes'], ['adapter_error', 'schema_not_registered'])

    def run_claude(self, outs, case=None):
        case = case or arr_case()
        ts = th.TempSuite([case])
        fr = FakeRunner(outs)
        ad = A.ClaudeAdapter('claude-test-model', runner=fr, schema_mode='json-schema-1')
        ad.preflight = lambda: None
        ad.runtime_version = '2.1.296 (Claude Code)'
        rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), run_id='w26', prompt_version='v8', evidence_format='v3.1-format', which=th.NO_BINARIES)
        return rec, fr

    def test_the_record_is_truthful_about_delivery_the_version_and_first_try(self):
        bad, good = dec3('k' * 420), dec3('short')
        rec, fr = self.run_claude([stream(INIT, attempt(1, bad), checked(1, True), attempt(2, good), checked(2, False), result(structured=good)),
                                   stream(INIT, attempt(1, good), checked(1, False), result(structured=good))])
        pr = rec['prompt']
        flat = P.turn_schema('v8', ['arr_lookup'], flat=True)
        self.assertEqual((pr['schema_sent'], pr['schema_mode'], pr['turn_schema_sha256']), (True, 'json-schema-1', R.sha256_bytes(R.canonical(flat).encode())))
        self.assertEqual(rec['runtime_version'], '2.1.296 (Claude Code)')
        self.assertEqual(len(rec['repair_prompts']), 1)                 # the CLI's own retry granted nothing: the harness saw the first try and repaired once
        self.assertFalse(rec['first_try_valid'])
        self.assertEqual(json.loads(rec['turns'][0]['text']), bad)
        self.assertEqual(rec['decision']['reason'], 'short')
        self.assertEqual([d['attempts'] for d in pr['schema_delivery_per_turn']], [2, 1])
        rec2, _ = self.run_claude([stream(dict(INIT, tools=None), result(text=json.dumps(good)))])
        self.assertFalse(rec2['prompt']['schema_sent'])          # no init tool list: delivery unconfirmed, recorded as not sent

    def test_the_cli_documents_the_flag(self):
        doc = (th.COMPONENT / 'docs' / 'dev-c8.md').read_text(encoding='utf-8')
        for s in ('--json-schema', 'StructuredOutput', 'error_max_structured_output_retries', 'claude-schema-1', 'advertised'):
            self.assertIn(s, doc)


# ------------------------------------------------------------------------------------------------------------------------------ guards v4
PROBE = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'matroska,webm', 'duration': '8.0', 'tags': {}},
         'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'width': 640, 'height': 360}, {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]}
APROBE = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'mov,mp4,m4a', 'duration': '20.0', 'tags': {}}, 'chapters': [],
          'streams': [{'index': 0, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]}


def movie_case(filename='Beta Film.mkv', app='radarr', evidence=(), cid='w26-film'):
    case = ev2h.case_with(list(evidence), tools=('arr_lookup',), cid=cid, media='movie')
    case['context'].update(title='Alpha Film', filename=filename, expected={'title': 'Alpha Film', 'year': 2001, 'runtime_s': 8},
                           arr={'app': app, 'ids': {'movieFileId': 7} if app else {}})
    return case


def binding(filename='Beta Film.mkv', fid=7):
    return {'app': 'radarr', 'title': 'Alpha Film', 'year': 2001, 'file': {'relativePath': filename, 'id': fid}}


def rename(src, old='Beta Film.mkv', new='Alpha Film.mkv'):
    return {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'source': {'ref': src},
            'target': {'kind': 'rename_of_source', 'old_value': old, 'new_value': new}, 'reason': 'r', 'confidence': 0.6, 'evidence_refs': ['e1']}


def guard(case, decision, tool_calls=(), messages=None, version='v4'):
    shown = case['evidence']
    view = P.case_view(case, [])
    ctx = DG.v4_context(view['context'], view['media_type'], [], messages or [{'id': 'evidence', 'kind': 'initial', 'pages': 1}], list(tool_calls), 'v3.1-format')
    return DG.apply(case, decision, list(tool_calls), shown, 'v8', version=version, v4ctx=ctx if version == 'v4' else None)


def role(rec, pid):
    return next((c for c in rec.get('role_checks', []) if c['id'] == pid), None)


def ocr(i, text):
    return ev2h.ev(i, 'ocr', output={'t_s': 1.0, 'text': text})


class GuardV4Spec(unittest.TestCase):
    def test_the_frozen_specification(self):
        self.assertEqual(DG.GUARD_VERSIONS, ('v1', 'v2', 'v3', 'v4'))
        self.assertEqual(set(DG.V4_PREREQUISITES), {'A-REN-1', 'A-REN-0', 'A-BLK-2', 'A-MAP-2', 'A-CNV-0', 'A-BLK-1', 'A-MAP-1', 'R-SRC'})
        self.assertEqual(DG.V4_SPEC['not_enforced'], ('unknown', 'unrecognized', 'undelivered'))
        self.assertEqual(hashlib.sha256(json.dumps(DG.V4_SPEC, sort_keys=True).encode()).hexdigest(), V4_SPEC_SHA256)
        rubric_ids = {p['id'] for a in RB.ACTIONS.values() for p in a['prerequisites']} | {p['id'] for ps in RB.ROLE_PREREQUISITES.values() for p in ps}
        self.assertLessEqual(set(DG.V4_PREREQUISITES), rubric_ids)       # every frozen id is a rubric id; no new prerequisite is invented

    def test_v1_to_v3_records_keep_their_shape(self):
        case = movie_case(evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding())])
        for v in ('v1', 'v2', 'v3'):
            _f, rec = guard(case, rename('case_item'), version=v)
            self.assertEqual(set(rec), {'version', 'applied', 'final_changed'}, v)

    def test_inherited_v3_behaviour_is_unchanged(self):
        case = movie_case(evidence=[ocr('e2', 'ALPHA FILM')])          # no integrity check at all
        healthy = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'reason': 'r', 'confidence': 0.5, 'evidence_refs': ['e2']}
        f3, r3 = guard(case, healthy, version='v3')
        f4, r4 = guard(case, healthy)
        self.assertEqual((f3, r3['applied']), (f4, r4['applied']))
        self.assertEqual(r4['applied'][0]['rule'], 'G-healthy')
        self.assertEqual(r4['role_checks'], [])                          # v3 fired first; G-role was not consulted


class GuardV4Controls(unittest.TestCase):
    """Positive controls (must be intercepted) and score-correct / contract-correct writes (must not be)."""

    def test_first_positive_control_managed_rename_on_uncontradicted_identity_with_case_item(self):
        case = ev2h.case_with([ev2h.ev('e1', 'ffprobe', output=APROBE)], tools=('arr_lookup',), cid='w26-book', media='audiobook')
        case['context'].update(title='Quiet Harbour', filename='Quiet Harbour.m4b', expected={'title': 'Quiet Harbour', 'author': 'N. Author'},
                               arr={'app': 'lazylibrarian', 'ids': {}})
        d = rename('case_item', old='Quiet Harbour.m4b', new='Quiet Harbour - N. Author.m4b')
        final, rec = guard(case, d)
        self.assertEqual((final['action'], rec['applied'][0]['rule']), ('escalate', 'G-role'))
        self.assertEqual((role(rec, 'A-REN-1')['audit_state'], role(rec, 'A-REN-1')['v4_status']), ('unmet', 'enforced'))
        self.assertIn('missing', role(rec, 'A-REN-1')['detail'])
        self.assertEqual((role(rec, 'R-SRC')['v4_status'], role(rec, 'A-REN-0')['v4_status']), ('unknown', 'unknown'))     # unknown stays unknown
        self.assertEqual(rec['applied'][0]['original'], d)

    def test_second_positive_control_bound_rename_title_content_agrees_declared_year_disagrees(self):
        case = movie_case(filename='Alpha Film (1999).mkv', evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA FILM'),
                                                                      ev2h.ev('e3', 'arr_lookup', output=binding('Alpha Film (1999).mkv'))])
        lvl = PQ.View(DG._v4_obs({'format': 'v3.1-format'}, case['evidence'], []), P.case_view(case, [])['context'], 'movie', []).identity()
        self.assertEqual((lvl[0], lvl[2]['title'], lvl[2]['year']), ('contested', 'verified', 'contested'))
        final, rec = guard(case, rename('e3', old='Alpha Film (1999).mkv', new='Alpha Film (2001).mkv'))
        self.assertEqual((final['action'], rec['applied'][0]['rule']), ('escalate', 'G-role'))
        self.assertEqual(role(rec, 'A-REN-1')['v4_status'], 'enforced')
        self.assertEqual((role(rec, 'R-SRC')['v4_status'], role(rec, 'A-REN-0')['v4_status']), ('met', 'met'))

    def test_a_score_correct_write_with_every_prerequisite_met_is_left_alone(self):
        case = movie_case(evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding())])
        d = rename('e3')
        final, rec = guard(case, d)
        self.assertEqual((final, rec['applied']), (d, []))
        self.assertEqual({c['id']: c['v4_status'] for c in rec['role_checks']}, {'A-REN-0': 'met', 'A-REN-1': 'met', 'R-SRC': 'met'})

    def test_a_contract_correct_unmanaged_rename_is_left_alone(self):
        case = movie_case(app=None, evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA FILM')])
        d = rename('case_item')
        final, rec = guard(case, d)
        self.assertEqual((final, rec['applied']), (d, []))

    def test_unknown_only_prerequisites_never_fire(self):
        case = movie_case(evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA FILM')])        # managed, no record states the linked file
        for src in ('case_item', 'e1', 'e2'):
            final, rec = guard(case, rename(src))
            st = {c['id']: (c['audit_state'], c['v4_status']) for c in rec['role_checks']}
            self.assertEqual(st['A-REN-0'], ('unknown', 'unknown'), src)
            self.assertEqual(st['R-SRC'], ('unknown', 'unknown'), src)
            self.assertEqual(rec['applied'], [], src)          # a documented limit: with no binding record shown a wrong source role stays unknown


class GuardV4Semantics(unittest.TestCase):
    def base(self, *extra, filename='Beta Film.mkv', app='radarr'):
        return movie_case(filename=filename, app=app, evidence=[ev2h.ev('e1', 'ffprobe', output=PROBE)] + list(extra))

    def test_semantic_recognition_false_negative_is_not_enforced(self):
        case = self.base(ocr('e2', 'EXIT'), ev2h.ev('e3', 'arr_lookup', output=binding()))       # content the comparator cannot match to the catalog
        final, rec = guard(case, rename('e3'))
        self.assertEqual((role(rec, 'A-REN-1')['audit_state'], role(rec, 'A-REN-1')['v4_status']), ('unmet', 'unrecognized'))
        self.assertEqual(rec['applied'], [])
        case2 = self.base(ocr('e2', 'EXIT'), ocr('e4', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding()))
        self.assertEqual(role(guard(case2, rename('e3'))[1], 'A-REN-1')['v4_status'], 'met')

    def test_content_versus_declaration_controls(self):
        tagged = dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Alpha Film'}))
        decl = movie_case(evidence=[ev2h.ev('e1', 'ffprobe', output=tagged), ev2h.ev('e3', 'arr_lookup', output=binding())])
        _f, rec = guard(decl, rename('e3'))
        self.assertEqual((role(rec, 'A-REN-1')['v4_status'], rec['applied'][0]['rule']), ('enforced', 'G-role'))   # a tag that agrees is a declaration
        opf = ev2h.ev('e4', 'prior_record', output={'evidence_method': 'package metadata (OPF)', 'observed': {'content_titles': ['Alpha Film']}})
        _f, rec = guard(self.base(opf, ev2h.ev('e3', 'arr_lookup', output=binding())), rename('e3'))
        self.assertEqual(role(rec, 'A-REN-1')['v4_status'], 'enforced')          # a prior record's declaration claim is never promoted to content
        cards = ev2h.ev('e4', 'prior_record', output={'evidence_method': 'reported embedded subtitle opening cards', 'observed': {'content_titles': ['Alpha Film']}})
        _f, rec = guard(self.base(cards, ev2h.ev('e3', 'arr_lookup', output=binding())), rename('e3'))
        self.assertEqual(role(rec, 'A-REN-1')['v4_status'], 'met')               # report_content is content by the frozen checker's rule (not by v4)

    def test_contradictory_evidence(self):
        case = ev2h.case_with([ev2h.ev('e1', 'ffprobe', output=PROBE), ocr('e2', 'ALPHA SHOW / S01E02 / LAMP'), ocr('e4', 'ALPHA SHOW / S01E03 / SALT'),
                               ev2h.ev('e3', 'arr_lookup', output={'app': 'sonarr', 'series': 'Alpha Show', 'episode': {'season': 1, 'episode': 2, 'title': 'Lamp'},
                                                                   'file': {'relativePath': 'alpha show 1x2.mkv', 'id': 7}})], tools=('arr_lookup',), cid='w26-ep', media='tv')
        case['context'].update(title='Alpha Show S01E02', filename='alpha show 1x2.mkv', expected={'series': 'Alpha Show', 'season': 1, 'episode': 2, 'episode_title': 'Lamp'},
                               arr={'app': 'sonarr', 'ids': {'episodeFileId': 7}})
        d = rename('e3', old='alpha show 1x2.mkv', new='Alpha Show - S01E02 - Lamp.mkv')
        _f, rec = guard(case, d)
        self.assertEqual((role(rec, 'A-REN-1')['v4_status'], rec['applied'][0]['rule']), ('enforced', 'G-role'))
        self.assertIn('content disagrees', role(rec, 'A-REN-1')['detail'])
        case['evidence'] = [e for e in case['evidence'] if e['id'] != 'e4']        # the same item without the disagreeing reading: content-verified, left alone
        self.assertEqual(guard(case, d)[1]['applied'], [])

    def test_a_contradiction_the_comparator_cannot_read_is_a_documented_limit(self):
        # a second on-screen title that is simply another name matches no catalog value, so the frozen checker keeps identity content-verified and v4 does not
        # fire: G-role is only as complete as the checker's comparator (a recognition false negative in the other direction, recorded in docs/dev-c8.md)
        case = self.base(ocr('e2', 'ALPHA FILM'), ocr('e4', 'GAMMA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding()))
        self.assertEqual(role(guard(case, rename('e3'))[1], 'A-REN-1')['v4_status'], 'met')

    def test_synthetic_source_role_substitutions(self):
        bound = (ocr('e2', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding()))
        for src, want in (('e3', 'met'), ('case_item', 'enforced'), ('e1', 'enforced'), ('e2', 'enforced'), ('t9', 'enforced')):
            _f, rec = guard(self.base(*bound), rename(src))
            self.assertEqual(role(rec, 'R-SRC')['v4_status'], want, src)
            self.assertEqual(bool(rec['applied']), want == 'enforced', src)
        self.assertIn('no result with that id was shown', role(guard(self.base(*bound), rename('t9'))[1], 'R-SRC')['detail'])
        unmanaged = self.base(ocr('e2', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding()), app=None)
        for src, want in (('case_item', 'met'), ('e3', 'enforced')):
            self.assertEqual(role(guard(unmanaged, rename(src))[1], 'R-SRC')['v4_status'], want, src)
        other = self.base(ocr('e2', 'ALPHA FILM'), ev2h.ev('e3', 'arr_lookup', output=binding('Another Film.mkv', fid=99)))
        _f, rec = guard(other, rename('e3'))
        self.assertEqual((role(rec, 'A-REN-0')['v4_status'], role(rec, 'R-SRC')['v4_status']), ('enforced', 'enforced'))   # the record links another file

    def test_page_origin_and_uncalled_result_swaps(self):
        case = self.base(ocr('e2', 'ALPHA FILM'))
        call = {'id': 't1', 'turn': 1, 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(binding()), 'raw_output': json.dumps(binding()), 'mode': 'stub'}
        page = {'id': 't2', 'turn': 2, 'tool': 'page', 'args': {'cursor': 'p2'}, 'status': 'ok', 'output': '{}', 'continuation': True, 'pages_of': 't1', 'mode': 'pages'}
        _f, rec = guard(case, rename('t2'), tool_calls=[call, page])
        self.assertEqual(role(rec, 'R-SRC')['v4_status'], 'met')                   # a page of the binding record stands for that record
        _f, rec = guard(case, rename('t2'), tool_calls=[call])
        self.assertEqual(role(rec, 'R-SRC')['v4_status'], 'enforced')              # no such page was delivered
        _f, rec = guard(case, rename('t1'), tool_calls=[])
        self.assertEqual(role(rec, 'R-SRC')['v4_status'], 'unknown')               # the record was never called: the guard does not read it
        case['uncalled_results'] = [binding()]                                     # an uncalled result anywhere in the case changes nothing
        self.assertEqual(guard(case, rename('t1'))[1], guard(self.base(ocr('e2', 'ALPHA FILM')), rename('t1'))[1])

    def test_only_delivered_pages_are_evaluated(self):
        case = self.base(ocr('e2', 'ALPHA FILM'))
        other = {'id': 't1', 'turn': 1, 'tool': 'arr_lookup', 'args': {}, 'status': 'ok', 'output': json.dumps(binding('Another Film.mkv', 99)),
                 'raw_output': json.dumps(binding('Another Film.mkv', 99)), 'mode': 'stub'}
        two_pages = [{'id': 'evidence', 'kind': 'initial', 'pages': 1}, {'id': 't1', 'kind': 'result', 'pages': 2}]
        _f, rec = guard(case, rename('t1'), tool_calls=[other], messages=two_pages)
        self.assertEqual((role(rec, 'A-REN-0')['v4_status'], rec['applied']), ('undelivered', []))
        page = {'id': 't2', 'turn': 2, 'tool': 'page', 'args': {'cursor': 'p2'}, 'status': 'ok', 'output': '{}', 'continuation': True, 'pages_of': 't1'}
        _f, rec = guard(case, rename('t1'), tool_calls=[other, page], messages=two_pages)
        self.assertEqual(role(rec, 'A-REN-0')['v4_status'], 'enforced')
        self.assertEqual(DG.undelivered_ids([{'id': 'evidence', 'kind': 'initial', 'pages': 2}], [], ['e1', 'e2']), {'e1', 'e2'})

    def test_a_non_write_or_a_v2_decision_is_never_role_checked(self):
        case = self.base(ocr('e2', 'ALPHA FILM'))
        esc = {'type': 'decision', 'class': 'metadata_naming', 'action': 'escalate', 'reason': 'r', 'confidence': 0.5, 'evidence_refs': []}
        self.assertEqual(guard(case, esc)[1]['role_checks'], [])
        self.assertEqual(DG.check_role_v4(dict(rename('e3'), source=None), {'format': 'v3.1-format'}, case['evidence'], []), (None, []))


class EditionAndRuntimeControls(unittest.TestCase):
    """The frozen checker behaviour v8 now states in words: decode completion, the catalog runtime and the edition choice are separate comparisons."""

    def m(self, obs, context, media='movie'):
        return {x['id']: x['state'] for x in PQ.check(obs, context, media)['material']}

    def obs(self, duration, *more):
        p = dict(PROBE, format=dict(PROBE['format'], duration=str(duration)))
        return [EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(p), None, 'case')] + list(more)

    def test_a_full_decode_that_completes_leaves_the_catalog_runtime_conflict_material(self):
        full = EV2.make_observation('t1', 'decode_sample', {'full': True}, 'ok', json.dumps({'exit_code': 0, 'frames': 400, 'out_time': '00:00:16.000000', 'stderr': '',
                                                                                            'ss': 0, 't': 16, 'full': True}), None, 'tool')
        ctx = {'title': 'Alpha Film', 'expected': {'title': 'Alpha Film', 'runtime_s': 8}, 'arr': {'app': None}}
        for dur in (16.046, 12.0, 30.0):
            self.assertEqual(self.m(self.obs(dur, full), ctx)['M4'], 'met', dur)
            self.assertEqual(self.m(self.obs(dur), ctx)['M4'], 'met', dur)
        self.assertEqual(self.m(self.obs(8.3, full), ctx)['M4'], 'unmet')          # within the larger of 1 s and 5 %

    def test_single_and_multiple_edition_controls(self):
        ctx = {'title': 'Alpha Film', 'expected': {'title': 'Alpha Film'}, 'arr': {'app': None}}

        def rec(editions, **kw):
            return EV2.make_observation('e2', 'arr_lookup', {}, 'ok', json.dumps(dict({'app': 'radarr', 'editions': editions}, **kw)), None, 'case')
        one = [{'name': 'Standard', 'runtime_s': 8}]
        two = [{'name': 'Standard', 'runtime_s': 8}, {'name': 'Extended', 'runtime_s': 8.2}]
        self.assertEqual(self.m(self.obs(8.0, rec(one)), ctx)['M7'], 'unmet')                          # one candidate: nothing to choose
        self.assertEqual(self.m(self.obs(8.0, rec(two)), ctx)['M7'], 'met')                            # two fitting, no selection
        self.assertEqual(self.m(self.obs(8.0, rec([{'name': 'Standard', 'runtime_s': 8}, {'name': 'Extended', 'runtime_s': 30}])), ctx)['M7'], 'unmet')   # only one fits
        sel = dict(ctx, expected={'title': 'Alpha Film', 'edition': 'Extended'})
        self.assertEqual(self.m(self.obs(8.0, rec(two)), sel)['M7'], 'unmet')                          # a case-supplied choice settles it
        self.assertEqual(self.m(self.obs(8.0), ctx)['M7'], 'unmet')                                    # no edition field at all is not edition uncertainty


class GuardV4Online(unittest.TestCase):
    def test_a_v8_run_with_guards_v4_records_the_role_checks(self):
        d = {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'source': {'ref': 'case_item'},
             'target': {'kind': 'rename_of_source', 'old_value': 'Alpha Show - S01E02.mkv', 'new_value': 'Alpha Show - S01E02 - Lamp.mkv'},
             'reason': 'r', 'confidence': 0.5, 'evidence_refs': []}
        rec, _ad = run8([d], guards='v4')
        g = rec['guard']
        self.assertEqual(g['version'], 'v4')
        self.assertIn('role_checks', g)
        self.assertTrue(g['final_changed'])
        self.assertEqual(g['applied'][0]['original'], d)
        self.assertEqual(rec['decision']['action'], 'escalate')
        rec3, _ad = run8([d], guards='v3')
        self.assertNotIn('role_checks', rec3['guard'])


class GuardV4WhatIf(unittest.TestCase):
    """The committed shadow records reproduce byte for byte from the recorded runs, the frozen spec and the archived score facts (no model, no rescoring)."""

    RUNS = ('runs/dev-c7/devc7-gpt-6-astra', 'runs/dev-c7/devc7-haiku-5-5', 'runs/dev-c7/devc7-qwen3.8-27b', 'runs/dev-c7-qwen-r2/devc7r2-qwen3.8-27b')

    @th.needs_suite
    def test_the_shadow_records_reproduce(self):
        import subprocess
        import sys
        suite = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
        if not (suite / 'cases').is_dir():
            th.require_suite()
            self.skipTest('suite-dev-v1.1 not present')
        out = Path(tempfile.mkdtemp(prefix='mrh-w26-whatif-'))
        subprocess.run([sys.executable, str(th.COMPONENT / 'scripts' / 'guards_v4_whatif.py'), '--suite', str(suite), '--out', str(out)] +
                       [str(th.COMPONENT / r) for r in self.RUNS], check=True, capture_output=True)
        committed = th.COMPONENT / 'runs' / 'dev-c8-guards-v4-whatif'
        got = sorted(p.relative_to(out) for p in out.rglob('*') if p.is_file())
        self.assertEqual(got, sorted(p.relative_to(committed) for p in committed.rglob('*') if p.is_file()))
        for rel in got:
            self.assertEqual((out / rel).read_bytes(), (committed / rel).read_bytes(), str(rel))

    def test_the_accounting_is_kept_apart(self):
        s = json.loads((th.COMPONENT / 'runs' / 'dev-c8-guards-v4-whatif' / 'summary.json').read_text())
        self.assertEqual(s['guards_v4_spec_sha256'], V4_SPEC_SHA256)
        self.assertEqual([r['run'] for r in s['runs']], ['devc7-gpt-6-astra', 'devc7-haiku-5-5', 'devc7-qwen3.8-27b', 'devc7r2-qwen3.8-27b'])   # qwen-r2 apart from the run it aborted
        for r in s['runs']:
            self.assertEqual(r['v3_replay_mismatches'], [], r['run'])
            self.assertEqual(r['audit_fidelity_differences'], {}, r['run'])
            for k in ('original_unsafe_proposals_unchanged', 'newly_intercepted_by_v4', 'newly_intercepted_score_correct_writes'):
                self.assertIn(k, r)


V4_SPEC_SHA256 = '13652ea81fe43b2658a26e791df8b0ded33d5c4e69b48e7d7de68a9a4a22c87d'

if __name__ == '__main__':
    unittest.main()
