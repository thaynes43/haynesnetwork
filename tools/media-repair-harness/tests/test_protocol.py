import json
import unittest

import protocol as P

GOOD_DECISION = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'target': None, 'confidence': 0.9,
                 'evidence_refs': ['e1'], 'reason': 'fine'}
GOOD_CALL = {'type': 'tool_call', 'tool': 'ffprobe', 'args': {}, 'why': 'look'}


class ValidateTurn(unittest.TestCase):
    def test_good_turns(self):
        self.assertEqual(P.validate_turn(GOOD_DECISION), ('decision', []))
        self.assertEqual(P.validate_turn(GOOD_CALL, ['ffprobe']), ('tool_call', []))

    def test_decision_rejections(self):
        bad = [dict(GOOD_DECISION, **{'class': 'broken'}), dict(GOOD_DECISION, action='delete'), dict(GOOD_DECISION, confidence=1.5),
               dict(GOOD_DECISION, confidence=True), dict(GOOD_DECISION, evidence_refs='e1'), dict(GOOD_DECISION, reason='x' * 401),
               dict(GOOD_DECISION, target=5), dict(GOOD_DECISION, extra=1)]
        for obj in bad:
            kind, errs = P.validate_turn(obj)
            self.assertIsNone(kind, obj)
            self.assertTrue(errs)
        missing = {k: v for k, v in GOOD_DECISION.items() if k != 'target'}
        self.assertIsNone(P.validate_turn(missing)[0])

    def test_tool_call_rejections(self):
        self.assertIsNone(P.validate_turn(dict(GOOD_CALL, tool='rm'))[0])
        self.assertIsNone(P.validate_turn(GOOD_CALL, ['epub_inspect'])[0])  # not offered for this case
        self.assertIsNone(P.validate_turn(dict(GOOD_CALL, args=[]))[0])
        self.assertIsNone(P.validate_turn(dict(GOOD_CALL, why='w' * 201))[0])
        self.assertIsNone(P.validate_turn(dict(GOOD_CALL, path='/etc/passwd'))[0])

    def test_non_objects_and_unknown_type(self):
        self.assertIsNone(P.validate_turn([1])[0])
        self.assertIsNone(P.validate_turn({'type': 'thought'})[0])


class ParseReply(unittest.TestCase):
    def test_strict_json_only(self):
        obj, err, _ = P.parse_reply('  ' + json.dumps(GOOD_DECISION) + '\n')
        self.assertEqual(obj, GOOD_DECISION)
        self.assertIsNone(err)

    def test_prose_and_fences_are_misses(self):
        obj, err, diag = P.parse_reply('Here you go: ' + json.dumps(GOOD_DECISION))
        self.assertIsNone(obj)
        self.assertTrue(err)
        obj, err, diag = P.parse_reply('```json\n' + json.dumps(GOOD_DECISION) + '\n```')
        self.assertIsNone(obj)
        self.assertTrue(diag.get('fence_wrapped'))

    def test_empty_and_trailing_stop_token(self):
        self.assertIsNone(P.parse_reply('')[0])
        self.assertIsNone(P.parse_reply(json.dumps(GOOD_DECISION) + '<|eot|>')[0])  # the Muse serving failure


class Prompts(unittest.TestCase):
    def test_forced_decision_is_safe_and_valid(self):
        d = P.forced_decision('x' * 1000)
        self.assertEqual((d['action'], d['class']), ('escalate', 'insufficient_evidence'))
        self.assertEqual(P.validate_turn(d)[0], 'decision')

    def test_case_view_hides_truth_and_answer_keys(self):
        case = {'id': 'x', 'media_type': 'tv', 'truth': {'class': 'healthy'}, 'supported_actions': ['none'], 'solvable': True,
                'family': 'f', 'provenance': 'p', 'split': 'heldout', 'fixture': {'kind': 'local', 'locator': '/secret/path'},
                'inject_tool_failure': {'tool': 'ffprobe'}, 'outcome_step': {'check': 'c'},
                'context': {'title': 't', 'expected': {}, 'notes_for_model': 'n', 'internal': 'no'}, 'tools_available': ['ffprobe']}
        text = json.dumps(P.case_view(case, []))
        for leak in ('healthy', 'supported', 'solvable', 'family', 'provenance', 'heldout', 'secret', 'inject', 'outcome', 'internal'):
            self.assertNotIn(leak, text)

    def test_schema_is_bounded(self):
        self.assertEqual(P.DECISION_SCHEMA['properties']['reason']['maxLength'], 400)
        self.assertEqual(P.TOOL_CALL_SCHEMA['properties']['why']['maxLength'], 200)
        self.assertEqual(set(P.TURN_SCHEMA['anyOf'][1]['properties']['class']['enum']), set(P.CLASSES))


if __name__ == '__main__':
    unittest.main()
