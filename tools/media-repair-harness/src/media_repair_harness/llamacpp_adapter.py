"""llama.cpp `llama-server` adapter (#209, `--adapter llamacpp`, adapter version `llamacpp-1`).

The server owns the model: this adapter loads nothing, unloads nothing and warms nothing up.  It reads `/health`, `/props` and `/v1/models`, refuses to run
unless the model alias the server reports is the one requested, and sends one `POST /v1/chat/completions` per turn through `llamacpp_transport` (kubectl exec
into `deploy/llama-server` container `app` in namespace `ai`; no other target exists).

Request (llama.cpp's OpenAI-compatible chat endpoint): `model` (the alias), `messages` (the system prompt first), `stream` false, `temperature` 0, a fixed
`seed`, `max_tokens` (the same reply budget the Ollama adapter calls num_predict), `cache_prompt` false (no reuse of an earlier request's KV cache, so a rerun
sees the same prefill), `stop` strings per model family, and the per-turn schema as `response_format` `{"type": "json_schema", "json_schema": {"schema": ...}}`,
which the server turns into a grammar.  This is the same schema the Ollama adapter sends as `format`, built by `protocol.turn_schema`.

Recorded: the server's `/props` (the chat template as its sha256 and length) and `/v1/models` in the preflight; per turn the usage, llama.cpp's `timings`, the
finish reason, the response model id and whether the model returned `reasoning_content` (never used as the reply).

API shapes are from llama.cpp's documented server API; none was checked against the running server (no exec into a GPU pod in this story).  Each reading that
may differ in build b11096 is tolerant (a missing field is recorded as missing, never invented), and the alias check fails closed.
"""
import hashlib
import json
import time

from . import adapters as A
from .adapters import AbortRun, Adapter, AdapterError, Completion
from .protocol import TURN_SCHEMA

ADAPTER_VERSION = 'llamacpp-1'
SEED = 42
DEFAULT_CALL_TIMEOUT_S = 120
DEFAULT_NUM_PREDICT_V1, DEFAULT_NUM_PREDICT_V2 = 384, 640


def _default_api(*args, **kwargs):
    from . import llamacpp_transport as lt     # looked up at call time (a test patches `lt.api`), and imported only by a run that selects this adapter
    return lt.api(*args, **kwargs)


def response_format(schema, name='turn'):
    """The `response_format` of one turn: the schema the server compiles into a grammar."""
    return {'type': 'json_schema', 'json_schema': {'name': name, 'strict': True, 'schema': schema}}


def _models(body):
    """-> the list of model ids a `/v1/models` body names (OpenAI list shape), else None."""
    if not isinstance(body, dict) or not isinstance(body.get('data'), list):
        return None
    return [m.get('id') for m in body['data'] if isinstance(m, dict)]


def props_summary(props):
    """The server properties worth keeping next to a run: everything `/props` reported, with the chat template as its hash and length (it is several KiB)."""
    if not isinstance(props, dict):
        return None
    out = {}
    for k, v in props.items():
        if k == 'chat_template' and isinstance(v, str):
            out[k] = {'sha256': hashlib.sha256(v.encode()).hexdigest(), 'chars': len(v)}
        elif k == 'chat_template_caps':
            out[k] = v
        else:
            out[k] = v
    return out


def slot_n_ctx(props):
    """Context tokens of one slot (llama.cpp reports the per-slot size under default_generation_settings.n_ctx), else None."""
    gen = (props or {}).get('default_generation_settings')
    n = gen.get('n_ctx') if isinstance(gen, dict) else None
    return n if isinstance(n, int) and n > 0 else None


class LlamaCppAdapter(Adapter):
    name = 'llamacpp'
    cleanup_reserve_s = 0           # finish() makes one read-only request; there is no unload to reserve time for
    digest_na_reason = 'llama-server reports no weights digest: the alias, model path, size and parameter count are recorded in the preflight'

    def __init__(self, model, api=None, num_predict=DEFAULT_NUM_PREDICT_V2, stop=None, schema=TURN_SCHEMA, schema_name='anyof', call_timeout=DEFAULT_CALL_TIMEOUT_S):
        super().__init__(model)
        self.api = api or _default_api
        self.num_predict = int(num_predict)
        self.stop = A.default_stop(model) if stop is None else list(stop)
        self.schema, self.schema_name, self.call_timeout = schema, schema_name, call_timeout
        self.options = {'temperature': 0, 'seed': SEED, 'max_tokens': self.num_predict, 'cache_prompt': False}
        self.n_ctx = None
        self.model_info = {}
        self.last_preflight = {}      # kept even when the preflight aborts, so the manifest shows why

    def config(self):
        return {'adapter': self.name, 'adapter_version': ADAPTER_VERSION, 'model': self.requested_model,
                'endpoint': {'namespace': 'ai', 'target': 'deploy/llama-server', 'container': 'app', 'port': 8080, 'path': '/v1/chat/completions'},
                'options': self.options, 'stop': self.stop, 'stream': False, 'format': 'response_format json_schema:' + self.schema_name,
                'call_timeout_s': self.call_timeout}

    # ------------------------------------------------------------------------------------------------ the server's identity
    def _read(self, path):
        body, receipt = self.api(path)
        return body, receipt

    def _served_model(self):
        """-> (ids the server serves, receipt).  AbortRun when /v1/models cannot be read."""
        body, receipt = self._read('/v1/models')
        ids = _models(body)
        if ids is None:
            raise AbortRun('cannot read /v1/models (%s); refusing to run against a server whose model is unknown' % (receipt.get('exit_code') if receipt.get('exit_code') else 'http %s' % receipt.get('http_status')))
        return ids, body

    def preflight(self):
        report = self.last_preflight = {'adapter_version': ADAPTER_VERSION, 'loaded_by_us': False}
        health, hr = self._read('/health')
        report['health'] = {'http_status': hr.get('http_status'), 'body': health, 'exit_code': hr.get('exit_code')}
        if hr.get('http_status') != 200 or not isinstance(health, dict) or health.get('status') != 'ok':
            raise AbortRun('llama-server /health is not ok (%s): %s; nothing was sent' % (
                hr.get('exit_code') if hr.get('exit_code') else 'http %s' % hr.get('http_status'), json.dumps(health)[:200] if health is not None else (hr.get('stderr') or '')[:200]))
        ids, models = self._served_model()
        report['models'] = models
        if self.requested_model not in ids:
            raise AbortRun('llama-server serves %s, not the requested model alias %r; this harness never loads or swaps a model' % (ids, self.requested_model))
        props, pr = self._read('/props')
        report['props'] = props_summary(props)
        if not isinstance(props, dict):
            raise AbortRun('cannot read /props (%s); refusing to run against a server whose properties are unknown' % (pr.get('exit_code') if pr.get('exit_code') else 'http %s' % pr.get('http_status')))
        alias = props.get('model_alias')
        if alias is not None and alias != self.requested_model:
            raise AbortRun('llama-server /props reports model_alias %r, not the requested %r' % (alias, self.requested_model))
        report['props_alias_checked'] = alias is not None
        self.runtime_version = ('llama.cpp %s' % props['build_info']) if props.get('build_info') else None
        self.n_ctx = slot_n_ctx(props)
        entry = next((m for m in models.get('data', []) if isinstance(m, dict) and m.get('id') == self.requested_model), {})
        self.model_info = {'alias': self.requested_model, 'model_path': props.get('model_path'), 'build_info': props.get('build_info'), 'total_slots': props.get('total_slots'),
                           'n_ctx_per_slot': self.n_ctx, 'meta': entry.get('meta')}
        report.update(self.describe(), model_info=self.model_info)
        return report

    def before_case(self):
        """The server owns the model and may be swapped between cases: the model the next case runs on must still be the requested one."""
        ids, _ = self._served_model()
        if self.requested_model not in ids:
            raise AbortRun('resident_model_changed_no_swap: llama-server now serves %s, not %r' % (ids, self.requested_model))

    # ------------------------------------------------------------------------------------------------ one turn
    def complete(self, system, messages, schema=None):
        body = dict(self.options, model=self.requested_model, stream=False, messages=[{'role': 'system', 'content': system}] + messages,
                    response_format=response_format(schema if schema is not None else self.schema))
        if self.stop:
            body['stop'] = list(self.stop)
        started = time.monotonic()
        resp, receipt = self.api('/v1/chat/completions', body, timeout=self.call_timeout)
        wall = time.monotonic() - started
        if resp is None:
            raise AdapterError('llama-server transport failure: %s' % json.dumps({k: receipt.get(k) for k in ('exit_code', 'http_status', 'stderr')})[:400])
        if isinstance(resp.get('error'), (dict, str)):
            err = resp['error']
            raise AdapterError('llama-server error: %s' % (json.dumps(err) if isinstance(err, dict) else str(err))[:300])
        choices = resp.get('choices')
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise AdapterError('llama-server returned no choice: %s' % json.dumps(resp)[:300])
        choice = choices[0]
        message = choice.get('message') if isinstance(choice.get('message'), dict) else {}
        content = message.get('content')
        text = content if isinstance(content, str) else ''
        reasoning = message.get('reasoning_content')
        usage_in = resp.get('usage') if isinstance(resp.get('usage'), dict) else {}
        usage = {'input_tokens': usage_in.get('prompt_tokens'), 'output_tokens': usage_in.get('completion_tokens'), 'cost_usd': None}
        timings = resp.get('timings') if isinstance(resp.get('timings'), dict) else None
        native = {'finish_reason': choice.get('finish_reason'), 'id': resp.get('id'), 'created': resp.get('created'), 'system_fingerprint': resp.get('system_fingerprint'),
                  'timings': timings, 'content_is_string': isinstance(content, str),
                  'reasoning_content_chars': len(reasoning) if isinstance(reasoning, str) else 0}
        meta = {}
        if self.n_ctx:
            # the Ollama context record, fed with llama.cpp's counts (llama-server rejects an over-long prompt instead of cutting it, so a flag here means "near the limit")
            ctx_native = {'prompt_eval_count': usage['input_tokens'], 'eval_count': usage['output_tokens'],
                          'done_reason': 'length' if choice.get('finish_reason') == 'length' else choice.get('finish_reason')}
            chars = len(system) + sum(len(m['content']) for m in messages)
            meta['context'] = A.context_check({'num_ctx': self.n_ctx, 'num_predict': self.num_predict}, ctx_native, chars)
        return Completion(text, body, receipt, response_model=resp.get('model'), usage=usage, wall_s=wall, load_s=0.0, native=native, meta=meta)

    def finish(self):
        report = {'server_owned_model': True, 'loaded_by_us': False, 'unloaded': False,
                  'note': 'llama-server owns the model: this run loaded, unloaded and warmed up nothing'}
        try:
            ids, _ = self._served_model()
            report['models_after'] = ids
        except Exception as e:  # noqa: BLE001 - reporting only
            report['error'] = str(e)[:200]
        return report
