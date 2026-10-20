"""Regression tests for the independent review of PR #1009 (findings 1, 2, 4, 5)."""
import hashlib
import json
import tempfile
import unittest

from media_repair_harness import adapters as A
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th
from media_repair_harness import tools as T
from test_adapters import FakeOllama, snapshot
from test_v2 import audit_obj, run_v2


def canon_sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


class OrdinaryWordTitles(unittest.TestCase):
    """Finding 1: a title that is an ordinary protocol word must not crash the case (check_system does not look at titles)."""

    TITLES = ('Identity', 'Evidence', 'Release', 'Search', 'Target', 'Format', 'Healthy', 'Partial', 'Edition', 'Damage', 'Proposal')

    def test_one_word_titles_run_normally_on_v1_and_v2(self):
        for title in self.TITLES:
            for prompt in ('v1', 'v2'):
                case = th.make_case('plain-case', context={'title': title, 'expected': {}, 'arr': {'app': None, 'ids': {}}, 'notes_for_model': 'n'})
                ts = th.TempSuite([case])
                rec = R.run_case(case, 'sha', A.ScriptedAdapter('m', [th.decision()]), ts.root, tempfile.mkdtemp(), prompt_version=prompt, run_id='r')
                self.assertNotIn('error', rec, (title, prompt))
                self.assertFalse(rec['forced'], (title, prompt))
                self.assertTrue(rec['first_try_valid'], (title, prompt))
                ts.cleanup()

    def test_case_ids_file_names_and_provenance_are_still_checked(self):
        from media_repair_harness import leakguard as L
        case = th.make_case('movie-corrupt-001', provenance='new (a long synthetic provenance text)')
        case['fixture'] = {'kind': 'local', 'locator': 'media/hidden_name.mkv'}
        for leak in ('movie-corrupt-001', 'movie-corrupt', 'hidden_name.mkv', 'new (a long synthetic provenance text)'):
            with self.assertRaises(L.LeakError, msg=leak):
                L.check_system(case, 'Generic prompt. ' + leak)
        L.check_system(case, P.get_prompt('v2')['text'])


class OcrReplayNote(unittest.TestCase):
    """Finding 2: the suite author's construction note stays in the record; the model sees only what the call returned (as in v1)."""

    def test_construction_note_is_record_only(self):
        case = th.make_case(tools_available=['ocr'])
        ctx = T.Context(case, T.Fixture('none'), tempfile.mkdtemp())
        ctx.replay_rec = {'frame_text': 'no text visible in any sampled frame (construction: plain background)'}
        res = T._ocr_replay(ctx, 1.0)
        d = res.bounded(ctx.redact)
        self.assertEqual(d['status'], 'ok')
        self.assertNotIn('construction', d['output'])
        self.assertNotIn('recorded_note', d['output'])
        self.assertEqual(json.loads(d['output']), {'t_s': 1.0, 'text': '', 'consensus': True, 'note': json.loads(d['output'])['note']})
        self.assertIn('construction', d['recorded_note'])   # kept in the run record (tool_calls[] carries ToolResult extras)
        msg = R.result_message('t1', 'ocr', d, 5)
        self.assertNotIn('construction', msg)
        self.assertNotIn('recorded_note', msg)

    def test_list_frame_text_output_is_unchanged(self):
        case = th.make_case(tools_available=['ocr'])
        ctx = T.Context(case, T.Fixture('none'), tempfile.mkdtemp())
        ctx.replay_rec = {'frame_text': [{'t0': 0, 't1': 4, 'text': 'TITLE CARD'}]}
        d = T._ocr_replay(ctx, 1.0).bounded()
        self.assertEqual(json.loads(d['output'])['text'], 'TITLE CARD')
        self.assertNotIn('recorded_note', d)


class SchemaHashRecordsWhatWasSent(unittest.TestCase):
    """Finding 4."""

    def ollama_run(self, prompt, **kw):
        content = json.dumps(th.decision())
        fake = FakeOllama(chat_resp=({'message': {'content': content}, 'model': 'qwen3.8:27b'}, {'exit_code': 0, 'http_status': 200}))
        ad = A.OllamaAdapter('qwen3.8:27b', api=fake, snapshot=snapshot(), do_warmup=False, **kw)
        case = th.make_case(tools_available=['arr_lookup'])
        ts = th.TempSuite([case])
        rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version=prompt, run_id='r')
        sent = fake.calls[-1][1]['format']
        ts.cleanup()
        return rec, sent

    def test_ollama_v1_anyof_and_flat(self):
        rec, sent = self.ollama_run('v1')
        self.assertEqual((rec['prompt']['turn_schema_sha256'], rec['prompt']['schema_sent']), (canon_sha(sent), True))
        self.assertEqual(sent, P.TURN_SCHEMA)
        rec, sent = self.ollama_run('v1', schema=P.FLAT_TURN_SCHEMA, schema_name='flat')
        self.assertEqual(rec['prompt']['turn_schema_sha256'], canon_sha(sent))
        self.assertEqual(sent, P.FLAT_TURN_SCHEMA)
        self.assertNotEqual(rec['prompt']['turn_schema_sha256'], canon_sha(P.TURN_SCHEMA))

    def test_ollama_v2_records_the_per_case_schema_actually_sent(self):
        rec, sent = self.ollama_run('v2')
        self.assertEqual(sent['anyOf'][0]['properties']['tool']['enum'], ['arr_lookup'])
        self.assertEqual(rec['prompt']['turn_schema_sha256'], canon_sha(sent))
        rec, sent = self.ollama_run('v2', schema_name='flat')
        self.assertEqual(rec['prompt']['turn_schema_sha256'], canon_sha(sent))

    def test_adapters_without_a_schema_channel_record_none(self):
        for name in ('claude', 'codex', 'scripted'):
            for prompt in ('v1', 'v2'):
                ad = A.ScriptedAdapter('m', [th.decision()])
                ad.name = name
                case = th.make_case()
                ts = th.TempSuite([case])
                rec = R.run_case(case, 'sha', ad, ts.root, tempfile.mkdtemp(), prompt_version=prompt, run_id='r')
                self.assertEqual((rec['prompt']['turn_schema_sha256'], rec['prompt']['schema_sent']), (None, False), (name, prompt))
                ts.cleanup()


class RepairHintAndAuditOnNoWrite(unittest.TestCase):
    """Finding 5."""

    def test_stray_close_hint_means_one_double_quote_character(self):
        hint = P.REPAIR_HINTS['stray_comma_quote_close']
        self.assertIn('one double-quote character', hint)
        self.assertNotIn('single quote', hint)

    def test_audit_on_none_or_escalate_is_invalid_in_v2(self):
        for action, cls in (('none', 'healthy'), ('escalate', 'insufficient_evidence')):
            d = th.decision(cls, action, audit=audit_obj())
            kind, errs = P.validate_turn(d, None, 'v2')
            self.assertIsNone(kind, action)
            self.assertTrue(any('audit is only for a write action' in e for e in errs), errs)
            self.assertEqual(P.validate_turn(th.decision(cls, action), None, 'v2')[0], 'decision')
            rec, _, ts = run_v2(th.make_case(), [d, th.decision(cls, action)])
            self.assertFalse(rec['first_try_valid'])          # a first try that carried an audit on a non-write is invalid
            self.assertEqual(len(rec['repair_prompts']), 1)
            self.assertNotIn('error', rec)
            ts.cleanup()
        # the Ollama no-write schema already forbids it
        nowrite = P.turn_schema('v2', ['arr_lookup'])['anyOf'][1]
        self.assertNotIn('audit', nowrite['properties'])
        self.assertFalse(nowrite['additionalProperties'])

    def test_write_with_audit_still_valid(self):
        d = th.decision('corrupt_file', 'blocklist_and_search', target='rel-1', audit=audit_obj('rel-1'))
        self.assertEqual(P.validate_turn(d, None, 'v2')[0], 'decision')


if __name__ == '__main__':
    unittest.main()
