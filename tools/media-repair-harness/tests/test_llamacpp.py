"""#209: the llama-server adapter (`--adapter llamacpp`, llamacpp-1).  A fake transport only: no model, no cluster, no network, no real server.
The response shapes are those of llama.cpp's documented server API, not read from the running server."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from media_repair_harness import adapters as A
from media_repair_harness import llamacpp_adapter as LA
from media_repair_harness import llamacpp_transport as LT
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th

MODEL = 'muse-glimmer-30b'
PROPS = {'default_generation_settings': {'n_ctx': 65536, 'params': {'temperature': 0.8}}, 'total_slots': 2, 'model_alias': MODEL,
         'model_path': '/models/muse-glimmer-30b/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf', 'build_info': 'b11096-0123abc', 'chat_template': '{{ messages }}' * 50,
         'modalities': {'vision': False}}
MODELS = {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'owned_by': 'llamacpp', 'meta': {'n_ctx_train': 262144, 'n_params': 30532122624, 'size': 18000000000}}]}
OK = {'wall_seconds': 0.1, 'exit_code': 0, 'stderr': '', 'http_status': 200}


def completion(content='{"type":"tool_call","tool":"ffprobe","args":{},"why":"w"}', finish='stop', model=MODEL, **extra):
    msg = {'role': 'assistant', 'content': content}
    msg.update(extra.pop('message', {}))
    return dict({'id': 'chatcmpl-1', 'object': 'chat.completion', 'created': 1790000000, 'model': model, 'system_fingerprint': 'b11096-0123abc',
                 'choices': [{'index': 0, 'finish_reason': finish, 'message': msg}],
                 'usage': {'prompt_tokens': 1200, 'completion_tokens': 30, 'total_tokens': 1230},
                 'timings': {'prompt_n': 1200, 'prompt_ms': 800.0, 'predicted_n': 30, 'predicted_ms': 300.0, 'predicted_per_second': 100.0}}, **extra)


class FakeServer:
    """A scripted llama-server behind the transport's `api(path, payload, timeout)`."""

    def __init__(self, props=PROPS, models=MODELS, health=({'status': 'ok'}, 200), replies=()):
        self.props, self.models, self.health = props, models, health
        self.replies = list(replies)
        self.calls = []
        self.models_seq = []         # successive /v1/models bodies (the last repeats)

    def __call__(self, path, payload=None, timeout=60):
        self.calls.append((path, payload, timeout))
        if path == '/health':
            body, status = self.health
            return body, dict(OK, http_status=status)
        if path == '/props':
            return self.props, dict(OK) if self.props is not None else {'exit_code': 1, 'stderr': 'no'}
        if path == '/v1/models':
            body = self.models_seq.pop(0) if len(self.models_seq) > 1 else (self.models_seq[0] if self.models_seq else self.models)
            return body, dict(OK) if body is not None else {'exit_code': 1, 'stderr': 'no'}
        assert path == '/v1/chat/completions', path
        r = self.replies.pop(0)
        if isinstance(r, tuple):
            return r
        return r, dict(OK, raw_body=json.dumps(r))


def adapter(server=None, **kw):
    return LA.LlamaCppAdapter(MODEL, api=server or FakeServer(), **kw)


class Preflight(unittest.TestCase):
    def test_reads_health_models_and_props_and_records_them(self):
        server = FakeServer()
        a = adapter(server)
        report = a.preflight()
        self.assertEqual([c[0] for c in server.calls], ['/health', '/v1/models', '/props'])
        self.assertEqual(report['loaded_by_us'], False)
        self.assertEqual(report['models'], MODELS)
        self.assertEqual(report['props']['build_info'], 'b11096-0123abc')
        self.assertEqual(report['props']['default_generation_settings']['n_ctx'], 65536)
        self.assertEqual(report['props']['chat_template']['chars'], len(PROPS['chat_template']))
        self.assertEqual(len(report['props']['chat_template']['sha256']), 64)
        self.assertEqual(a.runtime_version, 'llama.cpp b11096-0123abc')
        self.assertIsNone(a.model_digest)
        self.assertIn('no weights digest', a.digest_na_reason)
        self.assertEqual(report['model_info']['n_ctx_per_slot'], 65536)
        self.assertEqual(report['model_info']['total_slots'], 2)
        self.assertEqual(report['model_info']['model_path'], PROPS['model_path'])
        self.assertEqual(report['requested_model'], MODEL)
        self.assertTrue(report['props_alias_checked'])

    def test_no_load_unload_or_warm_up_request_is_ever_sent(self):
        server = FakeServer(replies=[completion()])
        a = adapter(server)
        a.preflight()
        a.before_case()
        a.complete('sys', [{'role': 'user', 'content': 'hi'}])
        a.finish()
        self.assertEqual(sorted({c[0] for c in server.calls}), ['/health', '/props', '/v1/chat/completions', '/v1/models'])
        self.assertEqual(len([c for c in server.calls if c[0] == '/v1/chat/completions']), 1)       # the one turn, nothing before it
        self.assertEqual(a.finish()['unloaded'], False)

    def test_refuses_when_the_served_model_is_not_the_requested_one(self):
        other = dict(MODELS, data=[{'id': 'some-other-model'}])
        a = adapter(FakeServer(models=other))
        with self.assertRaises(A.AbortRun) as cm:
            a.preflight()
        self.assertIn('some-other-model', str(cm.exception))
        self.assertIn(MODEL, str(cm.exception))
        self.assertIn('models', a.last_preflight)         # the manifest shows why

    def test_refuses_when_props_names_another_alias(self):
        a = adapter(FakeServer(props=dict(PROPS, model_alias='swapped')))
        with self.assertRaises(A.AbortRun) as cm:
            a.preflight()
        self.assertIn('model_alias', str(cm.exception))

    def test_a_props_without_an_alias_relies_on_the_model_list(self):
        props = {k: v for k, v in PROPS.items() if k != 'model_alias'}
        a = adapter(FakeServer(props=props))
        self.assertFalse(a.preflight()['props_alias_checked'])

    def test_refuses_a_server_that_is_not_healthy(self):
        for health in (({'error': {'code': 503, 'message': 'Loading model'}}, 503), ({'status': 'loading'}, 200), (None, 200)):
            with self.assertRaises(A.AbortRun, msg=str(health)):
                adapter(FakeServer(health=health)).preflight()

    def test_refuses_when_the_model_list_or_props_cannot_be_read(self):
        s = FakeServer()
        s.models_seq = [None]
        with self.assertRaises(A.AbortRun):
            adapter(s).preflight()
        with self.assertRaises(A.AbortRun):
            adapter(FakeServer(props=None)).preflight()

    def test_a_server_swapped_between_cases_stops_the_run(self):
        s = FakeServer()
        s.models_seq = [MODELS, {'object': 'list', 'data': [{'id': 'other'}]}]
        a = adapter(s)
        a.preflight()
        with self.assertRaises(A.AbortRun) as cm:
            a.before_case()
        self.assertIn('resident_model_changed_no_swap', str(cm.exception))


class Request(unittest.TestCase):
    def sent(self, **kw):
        server = FakeServer(replies=[completion()])
        a = adapter(server, **kw)
        a.preflight()
        schema = P.turn_schema('v7', ['ffprobe', 'decode_sample'])
        a.complete('SYSTEM', [{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'r'}, {'role': 'user', 'content': 'second'}], schema=schema)
        path, body, timeout = server.calls[-1]
        self.assertEqual(path, '/v1/chat/completions')
        return body, schema, timeout

    def test_the_chat_completion_is_deterministic_and_constrained(self):
        body, schema, timeout = self.sent()
        self.assertEqual(body['model'], MODEL)
        self.assertEqual(body['temperature'], 0)
        self.assertEqual(body['seed'], 42)
        self.assertIs(body['stream'], False)
        self.assertIs(body['cache_prompt'], False)
        self.assertEqual(body['max_tokens'], 640)
        self.assertEqual(body['messages'][0], {'role': 'system', 'content': 'SYSTEM'})
        self.assertEqual([m['role'] for m in body['messages']], ['system', 'user', 'assistant', 'user'])
        self.assertEqual(body['response_format'], {'type': 'json_schema', 'json_schema': {'name': 'turn', 'strict': True, 'schema': schema}})
        self.assertEqual(body['stop'], ['<|eot|>'])             # the muse family stop token, as for Ollama
        self.assertEqual(timeout, 120)

    def test_other_families_and_an_explicit_stop(self):
        a = LA.LlamaCppAdapter('qwen3.8-27b', api=FakeServer())
        self.assertEqual(a.stop, ['<|im_end|>'])
        self.assertEqual(LA.LlamaCppAdapter('other-model', api=FakeServer()).stop, [])
        self.assertEqual(LA.LlamaCppAdapter('other-model', api=FakeServer(), stop=['x']).stop, ['x'])
        server = FakeServer(replies=[completion()])
        b = LA.LlamaCppAdapter('other-model', api=server)
        b.complete('s', [{'role': 'user', 'content': 'u'}])
        self.assertNotIn('stop', server.calls[-1][1])

    def test_the_default_schema_is_the_adapters_own_when_none_is_passed(self):
        server = FakeServer(replies=[completion()])
        a = adapter(server)
        a.complete('s', [{'role': 'user', 'content': 'u'}])
        self.assertEqual(server.calls[-1][1]['response_format']['json_schema']['schema'], P.TURN_SCHEMA)

    def test_the_config_names_everything_that_shapes_a_reply(self):
        c = adapter().config()
        self.assertEqual(c['adapter'], 'llamacpp')
        self.assertEqual(c['adapter_version'], 'llamacpp-1')
        self.assertEqual(c['endpoint'], {'namespace': 'ai', 'target': 'deploy/llama-server', 'container': 'app', 'port': 8080, 'path': '/v1/chat/completions'})
        self.assertEqual(c['options'], {'temperature': 0, 'seed': 42, 'max_tokens': 640, 'cache_prompt': False})
        self.assertEqual(c['format'], 'response_format json_schema:anyof')
        self.assertEqual(adapter(num_predict=384).config()['options']['max_tokens'], 384)
        self.assertEqual(json.loads(json.dumps(c)), c)         # the config hash is taken over canonical JSON

    def test_the_turn_schemas_use_only_keywords_llama_cpp_compiles_to_a_grammar(self):
        """UNVERIFIED against the server; this pins the keyword set the schemas use to the documented json-schema-to-grammar subset."""
        supported = {'type', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'anyOf', 'oneOf', 'const', 'additionalProperties',
                     'pattern', 'minimum', 'maximum', 'description', 'title', 'default', '$schema'}
        used = set()

        def walk(node):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k in ('properties', 'required', 'enum', 'const'):
                        if k == 'properties':
                            for sub in v.values():
                                walk(sub)
                        continue
                    used.add(k)
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        for version in ('v1', 'v4', 'v7'):
            for flat in (False, True):
                walk(P.turn_schema(version, ['ffprobe', 'decode_sample', 'arr_lookup'], flat=flat))
        walk(P.TURN_SCHEMA)
        walk(P.FLAT_TURN_SCHEMA)
        self.assertLessEqual(used, supported, sorted(used - supported))


class Reply(unittest.TestCase):
    def test_a_completion_is_read_into_the_harness_shape(self):
        server = FakeServer(replies=[completion(message={'reasoning_content': 'because'})])
        a = adapter(server)
        a.preflight()
        comp = a.complete('s', [{'role': 'user', 'content': 'u'}])
        self.assertEqual(comp.text, '{"type":"tool_call","tool":"ffprobe","args":{},"why":"w"}')
        self.assertEqual(comp.response_model, MODEL)
        self.assertEqual(comp.usage, {'input_tokens': 1200, 'output_tokens': 30, 'cost_usd': None})
        self.assertEqual(comp.native['finish_reason'], 'stop')
        self.assertEqual(comp.native['timings']['predicted_per_second'], 100.0)
        self.assertEqual(comp.native['reasoning_content_chars'], len('because'))
        self.assertEqual(comp.load_s, 0.0)
        self.assertEqual(comp.raw_request['model'], MODEL)
        self.assertEqual(comp.meta['context']['num_ctx'], 65536)
        self.assertFalse(comp.meta['context']['truncated_suspected'])
        json.dumps(comp.to_dict())

    def test_a_length_stop_is_flagged_in_the_context_record(self):
        server = FakeServer(replies=[completion(content='{"type":"dec', finish='length')])
        a = adapter(server)
        a.preflight()
        comp = a.complete('s', [{'role': 'user', 'content': 'u'}])
        self.assertEqual(comp.native['finish_reason'], 'length')
        self.assertIn('output_hit_num_predict', comp.meta['context']['flags'])

    def test_a_null_content_is_an_empty_reply_not_a_crash(self):
        comp = adapter(FakeServer(replies=[completion(content=None, message={'content': None})])).complete('s', [{'role': 'user', 'content': 'u'}])
        self.assertEqual(comp.text, '')
        self.assertFalse(comp.native['content_is_string'])

    def test_failures_are_adapter_errors(self):
        for reply, text in (((None, {'exit_code': 1, 'stderr': 'bash: no such file'}), 'transport failure'),
                            (({'error': {'code': 400, 'message': 'exceed_context_size_error', 'type': 'exceed_context_size_error'}}, dict(OK, http_status=400)), 'llama-server error'),
                            (({'choices': []}, dict(OK)), 'no choice'),
                            (({'object': 'chat.completion'}, dict(OK)), 'no choice')):
            with self.assertRaises(A.AdapterError, msg=text) as cm:
                adapter(FakeServer(replies=[reply])).complete('s', [{'role': 'user', 'content': 'u'}])
            self.assertIn(text, str(cm.exception))


class Transport(unittest.TestCase):
    def run_api(self, path, payload=None, stdout=b'', returncode=0, timeout=60):
        seen = {}

        def runner(cmd, input=None, capture_output=None, timeout=None):
            seen.update(cmd=cmd, input=input, timeout=timeout)
            return subprocess.CompletedProcess(cmd, returncode, stdout, b'')
        got = LT.api(path, payload, timeout=timeout, runner=runner)
        return got, seen

    def test_the_only_target_is_the_llama_server_container_in_ai(self):
        self.assertEqual((LT.NAMESPACE, LT.TARGET, LT.CONTAINER, LT.PORT), ('ai', 'deploy/llama-server', 'app', 8080))
        http = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"status":"ok"}'
        (body, receipt), seen = self.run_api('/health', stdout=http)
        self.assertEqual(seen['cmd'][:9], ['kubectl', '-n', 'ai', 'exec', '-i', 'deploy/llama-server', '-c', 'app', '--'])
        self.assertEqual(seen['cmd'][9:12], ['timeout', '60', 'bash'])
        self.assertEqual(sum(1 for part in seen['cmd'] if part.startswith('deploy/')), 1)
        self.assertEqual(body, {'status': 'ok'})
        self.assertEqual(receipt['http_status'], 200)
        script = seen['cmd'][-1]
        self.assertIn('/dev/tcp/127.0.0.1/8080', script)
        self.assertIn('GET /health HTTP/1.1', script)
        self.assertIn('Content-Length: 0', script)

    def test_a_chat_completion_travels_on_stdin_and_never_in_the_script(self):
        payload = {'model': MODEL, 'messages': [{'role': 'user', 'content': "it's \"quoted\" $(rm -rf /)"}]}
        resp = json.dumps(completion()).encode()
        http = b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(resp)).encode() + b'\r\n\r\n' + resp
        (body, receipt), seen = self.run_api('/v1/chat/completions', payload, stdout=http, timeout=120)
        self.assertEqual(json.loads(seen['input']), payload)
        script = seen['cmd'][-1]
        self.assertNotIn('rm -rf', script)
        self.assertIn('POST /v1/chat/completions HTTP/1.1', script)
        self.assertIn('Content-Length: %d' % len(seen['input']), script)
        self.assertEqual(seen['timeout'], 125)
        self.assertEqual(body['choices'][0]['message']['role'], 'assistant')

    def test_a_chunked_response_and_an_error_status_are_parsed(self):
        chunk = b'{"error":{"code":503,"message":"Loading model"}}'
        http = b'HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n' + format(len(chunk), 'x').encode() + b'\r\n' + chunk + b'\r\n0\r\n\r\n'
        (body, receipt), _ = self.run_api('/health', stdout=http)
        self.assertEqual(receipt['http_status'], 503)
        self.assertEqual(body['error']['code'], 503)

    def test_transport_trouble_never_raises(self):
        (body, receipt), _ = self.run_api('/health', stdout=b'partial', returncode=126)
        self.assertIsNone(body)
        self.assertEqual(receipt['exit_code'], 126)
        (body, receipt), _ = self.run_api('/health', stdout=b'not http at all')
        self.assertIsNone(body)
        self.assertIn('parse_error', receipt)

        def timing_out(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 5)

        def missing(cmd, **kw):
            raise OSError('kubectl not found')
        self.assertEqual(LT.api('/health', runner=timing_out)[1]['exit_code'], 'local_timeout')
        self.assertEqual(LT.api('/health', runner=missing)[1]['exit_code'], 'spawn_error')

    def test_only_the_documented_paths_can_be_sent(self):
        for path in ('/slots', '/models', '/completion', '/v1/embeddings', '/props?x=1', ''):
            with self.assertRaises(AssertionError, msg=path):
                LT.api(path, runner=lambda *a, **k: None)
        with self.assertRaises(AssertionError):
            LT.api('/health', timeout=0, runner=lambda *a, **k: None)


class RunnerWiring(unittest.TestCase):
    def parse(self, *extra):
        return R.build_parser().parse_args(['--suite', 'x', '--adapter', 'llamacpp', '--model', MODEL, '--out', 'o'] + list(extra))

    def test_the_adapter_is_selectable_and_built_from_the_runner_options(self):
        a = R.build_adapter(self.parse('--prompt', 'v7', '--evidence-format', 'v3.1-format'))
        self.assertIsInstance(a, LA.LlamaCppAdapter)
        self.assertEqual(a.options['max_tokens'], 640)
        self.assertEqual(a.stop, ['<|eot|>'])
        b = R.build_adapter(self.parse('--prompt', 'v1', '--num-predict', '900', '--ollama-schema', 'flat', '--stop', 'x,y'))
        self.assertEqual((b.options['max_tokens'], b.stop, b.schema_name, b.schema), (900, ['x', 'y'], 'flat', P.FLAT_TURN_SCHEMA))
        self.assertEqual(R.build_adapter(self.parse('--prompt', 'v1')).options['max_tokens'], 384)

    def test_ollama_only_options_are_refused_with_this_adapter(self):
        with tempfile.TemporaryDirectory() as tmp:
            for extra in (['--num-ctx', '8192'], ['--keep-alive', '10m'], ['--no-warmup'], ['--require-digest', 'abc'], ['--context-policy', 'ctx16k-v1', '--num-ctx', '16384'], ['--gpu-fit-check', 'full-gpu-v1']):
                out = Path(tmp) / 'run'
                with self.assertRaises(SystemExit, msg=str(extra)):
                    R.main(['--suite', str(th.SUITE), '--adapter', 'llamacpp', '--model', MODEL, '--out', str(out)] + extra)
                self.assertFalse(out.exists())

    @th.needs_suite
    def test_a_full_run_through_the_runner_records_the_server_and_the_schema(self):
        case = sorted((th.SUITE / 'cases').glob('*.json'))[0]
        cid = json.loads(case.read_text())['id']
        server = FakeServer(replies=[completion(content=json.dumps(P.forced_decision_for('v4', 'x')))])
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(LT, 'api', server):
            out = Path(tmp) / 'run'
            code = R.main(['--suite', str(th.SUITE), '--cases', cid, '--adapter', 'llamacpp', '--model', MODEL, '--out', str(out), '--scratch', str(Path(tmp) / 's'), '--prompt', 'v4'])
            self.assertFalse(code)
            manifest = json.loads((out / 'manifest.json').read_text())
            rec = json.loads((out / (cid + '.json')).read_text())
        self.assertEqual(manifest['requested_model'], MODEL)
        self.assertEqual(manifest['runtime_version'], 'llama.cpp b11096-0123abc')
        self.assertEqual(manifest['preflight']['props']['total_slots'], 2)
        self.assertEqual(manifest['preflight']['models']['data'][0]['id'], MODEL)
        self.assertEqual(manifest['finish']['unloaded'], False)
        self.assertEqual(manifest['config']['adapter_config']['adapter'], 'llamacpp')
        self.assertEqual(rec['response_model_ids'], [MODEL])
        self.assertEqual(rec['runtime_version'], 'llama.cpp b11096-0123abc')
        self.assertTrue(rec['prompt']['schema_sent'])
        self.assertEqual(rec['usage']['input_tokens'], 1200)
        self.assertEqual(rec['context_check']['num_ctx'], 65536)
        self.assertEqual(rec['turns'][0]['raw_request']['response_format']['json_schema']['schema'], json.loads(json.dumps(rec['turns'][0]['raw_request']['response_format']['json_schema']['schema'])))
        self.assertFalse(rec['forced'])
        chat = [c for c in server.calls if c[0] == '/v1/chat/completions']
        self.assertEqual(len(chat), 1)
        self.assertEqual(R.record_missing_fields(rec), [])


if __name__ == '__main__':
    unittest.main()
