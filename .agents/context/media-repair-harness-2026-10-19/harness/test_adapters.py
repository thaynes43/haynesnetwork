import json
import subprocess
import unittest

import adapters as A
import th

S = th.TESTDATA / 'samples'


class FakeOllama:
    """Fake of ollama_transport.api; records calls."""

    def __init__(self, residents=(), installed=('qwen3.8:27b',), chat_content=None, gen_error=None, chat_resp=None):
        self.residents, self.installed, self.calls = list(residents), installed, []
        self.chat_content, self.gen_error, self.chat_resp = chat_content, gen_error, chat_resp

    def __call__(self, path, payload=None, timeout=60):
        self.calls.append((path, payload))
        if path == '/api/version':
            return {'version': '0.40.6'}, {'exit_code': 0}
        if path == '/api/tags':
            return {'models': [{'name': n, 'digest': 'sha256:abc', 'details': {'quantization_level': 'Q4_K_M'}, 'size': 1} for n in self.installed]}, {'exit_code': 0}
        if path == '/api/ps':
            return {'models': [{'name': n} for n in self.residents]}, {'exit_code': 0}
        if path == '/api/generate':
            if payload.get('keep_alive') == 0:
                self.residents = []
                return {'done': True}, {'exit_code': 0}
            if self.gen_error:
                return None, {'exit_code': 'local_timeout'}
            self.residents = [payload['model']]
            return {'done': True, 'load_duration': 5_000_000_000}, {'exit_code': 0}
        if path == '/api/chat':
            if self.chat_resp is not None:
                return self.chat_resp
            return json.loads((S / 'ollama_chat_qwen.json').read_text()), {'exit_code': 0, 'http_status': 200}
        raise AssertionError(path)


def snapshot(procs=''):
    return lambda: {'compute_processes': procs, 'stdout': 'gpu'}


class OllamaAdapterTests(unittest.TestCase):
    def make(self, fake, **kw):
        return A.OllamaAdapter('qwen3.8:27b', api=fake, snapshot=snapshot(kw.pop('procs', '')), **kw)

    def test_stop_tokens_per_family(self):
        self.assertEqual(A.default_stop('qwen3.8:27b'), ['<|im_end|>'])
        self.assertEqual(A.default_stop('muse-glimmer:30b'), ['<|eot|>'])
        self.assertEqual(A.default_stop('nemotron-3.5-bolt:74b-a9b'), [])

    def test_preflight_records_digest_version_and_loads(self):
        fake = FakeOllama()
        ad = self.make(fake)
        rep = ad.preflight()
        self.assertEqual((ad.runtime_version, ad.model_digest), ('0.40.6', 'sha256:abc'))
        self.assertTrue(ad.loaded_by_us)
        self.assertEqual(rep['warmup']['load_duration_ns'], 5_000_000_000)
        self.assertEqual(rep['residents_before'], [])

    def test_foreign_resident_aborts_without_touching_it(self):
        fake = FakeOllama(residents=['someone-else:7b'])
        ad = self.make(fake)
        with self.assertRaises(A.AbortRun):
            ad.preflight()
        self.assertNotIn('/api/generate', [c[0] for c in fake.calls])  # no load, no unload

    def test_gpu_compute_owner_aborts(self):
        with self.assertRaises(A.AbortRun):
            self.make(FakeOllama(), procs='GPU-x, 123, python, 900 MiB').preflight()

    def test_missing_model_aborts_without_pull(self):
        fake = FakeOllama(installed=('other:1b',))
        with self.assertRaises(A.AbortRun):
            self.make(fake).preflight()
        self.assertFalse([c for c in fake.calls if c[0] in ('/api/pull',)])

    def test_owner_change_between_cases_aborts(self):
        fake = FakeOllama()
        ad = self.make(fake)
        ad.preflight()
        ad.before_case()
        fake.residents.append('intruder:1b')
        with self.assertRaises(A.AbortRun):
            ad.before_case()

    def test_chat_request_shape_and_parsing(self):
        fake = FakeOllama()
        ad = self.make(fake)
        ad.preflight()
        c = ad.complete('SYS', [{'role': 'user', 'content': 'hi'}])
        path, body = [x for x in fake.calls if x[0] == '/api/chat'][0]
        self.assertEqual(body['options']['stop'], ['<|im_end|>'])
        self.assertEqual((body['options']['temperature'], body['options']['seed']), (0, 42))
        self.assertIs(body['think'], False)
        self.assertEqual(body['messages'][0], {'role': 'system', 'content': 'SYS'})
        self.assertIn('anyOf', body['format'])
        self.assertEqual(c.response_model, 'qwen3.8:27b')
        self.assertEqual((c.usage['input_tokens'], c.usage['output_tokens']), (812, 61))
        self.assertEqual(c.native['eval_duration'], 3_700_000_000)
        self.assertAlmostEqual(c.load_s, 0.12)

    def test_transport_failure_is_adapter_error(self):
        fake = FakeOllama(chat_resp=(None, {'exit_code': 'local_timeout'}))
        ad = self.make(fake)
        ad.preflight()
        with self.assertRaises(A.AdapterError):
            ad.complete('s', [{'role': 'user', 'content': 'x'}])

    def test_finish_unloads_only_what_we_loaded(self):
        fake = FakeOllama()
        ad = self.make(fake)
        ad.preflight()
        rep = ad.finish()
        self.assertTrue(rep['unloaded'])
        self.assertEqual(rep['residents_after'], [])
        # a resident model before the batch (even our own tag) is refused, never reused or unloaded
        fake2 = FakeOllama(residents=['qwen3.8:27b'])
        ad2 = self.make(fake2)
        with self.assertRaises(A.AbortRun):
            ad2.preflight()
        self.assertFalse(ad2.loaded_by_us)
        ad2.finish()
        self.assertFalse([c for c in fake2.calls if c[0] == '/api/generate'])

    def test_requests_always_carry_the_proven_safe_options(self):
        fake = FakeOllama()
        ad = self.make(fake)
        ad.preflight()
        ad.complete('s', [{'role': 'user', 'content': 'x'}])
        for path, body in [c for c in fake.calls if c[0] in ('/api/generate', '/api/chat') and c[1].get('keep_alive') != 0]:
            o = body['options']
            self.assertEqual((o['num_ctx'], o['use_mmap'], o['temperature'], o['seed']), (4096, False, 0, 42), path)
            self.assertIs(body['think'], False)
            self.assertEqual((body['keep_alive'], body['stream']), ('2m', False))
        warm = [c for c in fake.calls if c[0] == '/api/generate'][0][1]
        self.assertEqual(warm['prompt'], 'Reply with OK')

    def test_options_cannot_weaken_or_enlarge(self):
        o = A.ollama_options({'use_mmap': True, 'temperature': 1, 'seed': 7, 'num_ctx': 8192})
        self.assertEqual((o['use_mmap'], o['temperature'], o['seed'], o['num_ctx']), (False, 0, 42, 8192))
        for bad in (32768, 16384, 2048):
            with self.assertRaises(ValueError):
                A.ollama_options({'num_ctx': bad})

    def test_warmup_timeout_is_900_and_chat_timeout_stays_configured(self):
        seen = []
        base = FakeOllama()

        def spy(path, payload=None, timeout=60):
            seen.append((path, timeout))
            return base(path, payload, timeout)
        ad = self.make(spy, call_timeout=77)
        ad.preflight()
        ad.complete('s', [{'role': 'user', 'content': 'x'}])
        self.assertIn(('/api/generate', 900), seen)
        self.assertIn(('/api/chat', 77), seen)

    def test_context_check_flags_truncation(self):
        o = A.ollama_options({})
        ok = A.context_check(o, {'prompt_eval_count': 1500, 'eval_count': 80, 'done_reason': 'stop'}, 4000)
        self.assertFalse(ok['truncated_suspected'])
        full = A.context_check(o, {'prompt_eval_count': 4090, 'eval_count': 80, 'done_reason': 'stop'}, 4000)
        self.assertTrue(full['truncated_suspected'])
        self.assertIn('prompt_at_context_limit', full['flags'])
        est = A.context_check(o, {'prompt_eval_count': 900, 'eval_count': 80}, 13000)  # cached prefix hides the real size
        self.assertIn('estimated_prompt_exceeds_context', est['flags'])
        cap = A.context_check(o, {'prompt_eval_count': 900, 'eval_count': 384, 'done_reason': 'length'}, 4000)
        self.assertFalse(cap['truncated_suspected'])
        self.assertIn('output_hit_num_predict', cap['flags'])

    def test_chat_completion_carries_context_check(self):
        fake = FakeOllama()
        ad = self.make(fake)
        ad.preflight()
        c = ad.complete('SYS', [{'role': 'user', 'content': 'hi'}])
        self.assertEqual(c.meta['context']['num_ctx'], 4096)
        self.assertEqual(c.meta['context']['prompt_tokens_reported'], 812)

    def test_aborted_preflight_keeps_what_it_saw(self):
        ad = self.make(FakeOllama(residents=['someone-else:7b']))
        with self.assertRaises(A.AbortRun):
            ad.preflight()
        self.assertEqual(ad.last_preflight['residents_before'], ['someone-else:7b'])

    def test_failed_load_does_not_unload_or_retry(self):
        fake = FakeOllama(gen_error=True)
        ad = self.make(fake)
        with self.assertRaises(A.AbortRun):
            ad.preflight()
        ad.finish()
        self.assertEqual(len([c for c in fake.calls if c[0] == '/api/generate']), 1)


class CodexTrimTests(unittest.TestCase):
    def test_argv_carries_the_token_trim_overrides(self):
        cmd = A.CodexAdapter('gpt-6-luna').argv()
        self.assertIn('features.shell_tool=false', cmd)
        self.assertIn('web_search="disabled"', cmd)
        self.assertEqual(cmd[-1], '-')
        self.assertEqual(cmd[cmd.index('-m') + 1], 'gpt-6-luna')


class ClaudeAdapterTests(unittest.TestCase):
    def test_parse_recorded_output(self):
        raw = (S / 'claude_haiku_5_5.json').read_text()
        c = A.parse_claude(raw, '', 0, {'argv': []}, 1.5)
        self.assertEqual(c.text, '{"ok":true}')
        self.assertEqual(c.response_model, 'claude-haiku-5-5')
        self.assertEqual(c.usage['cost_usd'], 0.0001253)
        self.assertEqual((c.usage['input_tokens'], c.usage['output_tokens'], c.usage['cache_creation_input_tokens']), (2, 9, 603))

    def test_error_results_raise(self):
        with self.assertRaises(A.AdapterError):
            A.parse_claude((S / 'claude_error.json').read_text(), '', 1, {}, 0.1)
        with self.assertRaises(A.AdapterError):
            A.parse_claude('not json', 'boom', 1, {}, 0.1)

    def test_argv_disables_everything(self):
        ad = A.ClaudeAdapter('claude-haiku-5-5', effort='low')
        cmd = ad.argv('SYS')
        self.assertEqual(cmd[:6], ['claude', '-p', '--model', 'claude-haiku-5-5', '--output-format', 'json'])
        for flag in ('--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[cmd.index('--tools') + 1], '')
        self.assertEqual(cmd[cmd.index('--setting-sources') + 1], '')
        self.assertEqual(cmd[cmd.index('--effort') + 1], 'low')
        ad.finish()

    def test_complete_uses_runner_and_hides_system_prompt_in_argv_record(self):
        raw = (S / 'claude_haiku_5_5.json').read_text().encode()
        seen = {}

        def runner(cmd, **kw):
            seen.update(cmd=cmd, kw=kw)
            return subprocess.CompletedProcess(cmd, 0, raw, b'')
        ad = A.ClaudeAdapter('claude-haiku-5-5', runner=runner)
        c = ad.complete('SECRET SYSTEM', [{'role': 'user', 'content': 'case'}])
        self.assertIn(b'case', seen['kw']['input'])
        self.assertIn('<system>', c.raw_request['argv'])
        self.assertNotIn('SECRET SYSTEM', c.raw_request['argv'])
        self.assertEqual(c.raw_request['system_prompt'], 'SECRET SYSTEM')
        ad.finish()

    def test_timeout_is_adapter_error(self):
        def runner(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 1)
        ad = A.ClaudeAdapter('m', runner=runner)
        with self.assertRaises(A.AdapterError):
            ad.complete('s', [{'role': 'user', 'content': 'x'}])
        ad.finish()


class CodexAdapterTests(unittest.TestCase):
    def test_parse_recorded_event_stream(self):
        raw = (S / 'codex_gpt_6_luna.jsonl').read_text()
        c = A.parse_codex(raw, 0, {}, 3.0)
        self.assertEqual(c.text, '{"ok":true}')
        self.assertEqual((c.usage['input_tokens'], c.usage['output_tokens'], c.usage['cached_input_tokens']), (27068, 9, 11648))
        self.assertIsNone(c.usage['cost_usd'])  # codex reports tokens, not cost
        self.assertEqual(c.meta['native_tool_items'], ['command_execution'])  # a protocol violation worth recording
        self.assertIsNone(c.response_model)
        self.assertEqual(c.meta['response_model_source'], 'not_reported')
        old = A._rollout_model
        A._rollout_model = lambda thread: 'gpt-6-luna'
        try:
            c = A.parse_codex(raw, 0, {}, 3.0)
        finally:
            A._rollout_model = old
        self.assertEqual((c.response_model, c.meta['response_model_source']), ('gpt-6-luna', 'rollout'))

    def test_no_message_is_adapter_error(self):
        with self.assertRaises(A.AdapterError):
            A.parse_codex('{"type":"turn.failed","error":{"message":"model not found"}}\n', 1, {}, 1.0)

    def test_argv_is_read_only_stdin(self):
        ad = A.CodexAdapter('gpt-6-luna')
        cmd = ad.argv()
        self.assertEqual(cmd[:2], ['codex', 'exec'])
        self.assertEqual(cmd[cmd.index('-s') + 1], 'read-only')
        for flag in ('--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules'):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[-1], '-')
        ad.finish()
        self.assertNotIn('--ephemeral', A.CodexAdapter('gpt-6-luna').argv())   # default keeps the rollout so the model id is recorded
        self.assertIn('--ephemeral', A.CodexAdapter('gpt-6-luna', record_session=False).argv())


class Transcript(unittest.TestCase):
    def test_render_transcript_labels_roles(self):
        t = A.render_transcript([{'role': 'user', 'content': 'CASEJSON'}, {'role': 'assistant', 'content': 'REPLY'}, {'role': 'user', 'content': 'RESULT'}])
        self.assertLess(t.index('[CASE]'), t.index('[YOUR PREVIOUS REPLY]'))
        self.assertIn('[HARNESS]\nRESULT', t)
        self.assertTrue(t.rstrip().endswith('nothing else.'))


if __name__ == '__main__':
    unittest.main()
