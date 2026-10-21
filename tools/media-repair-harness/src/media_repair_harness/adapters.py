"""Model adapters.  An adapter turns (system prompt, message list) into one Completion.

  ollama   Ollama Prime through kubectl exec; strict JSON schema in `format`; per-model stop tokens.
  claude   `claude -p --output-format json` with every tool, MCP server, setting source and slash command
           disabled, from an empty working directory, so the model can only answer through our protocol.
  codex    `codex exec --json` in a read-only sandbox from an empty directory, prompt on stdin.
  scripted canned replies (tests and dry runs).
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from . import ollama_transport as ot
from .protocol import TURN_SCHEMA


class AdapterError(Exception):
    """A single model call failed (transport, CLI error, timeout).  The runner records it and moves on.
    `usage` is the receipt the failed call itself reported (a CLI error payload carries tokens and a cost), `cost_usd` its cost, else None;
    `budget_exceeded` marks a CLI that stopped because the call's own `--max-budget-usd` was reached."""

    def __init__(self, message='', cost_usd=None, usage=None, budget_exceeded=False, evidence=None):
        super().__init__(message)
        self.usage = usage
        self.cost_usd = cost_usd if cost_usd is not None else ((usage or {}).get('cost_usd'))
        self.budget_exceeded = budget_exceeded
        # dev-c8 (claude-schema-1 only): what the failed call still showed -- raw_request, raw_response (untruncated) and meta (schema delivery, attempts);
        # the runner keeps it on the failed turn.  None for every other adapter, whose failed turns keep their earlier shape.
        self.evidence = evidence


class AbortRun(Exception):
    """The whole run must stop (e.g. someone else's model is resident on the GPU).  Never evict."""


class Completion:
    def __init__(self, text, raw_request, raw_response, response_model=None, usage=None, wall_s=0.0, load_s=0.0,
                 native=None, meta=None):
        self.text, self.raw_request, self.raw_response = text, raw_request, raw_response
        self.response_model, self.usage, self.wall_s, self.load_s = response_model, usage or {}, wall_s, load_s
        self.native, self.meta = native or {}, meta or {}

    def to_dict(self):
        return {'text': self.text, 'response_model': self.response_model, 'usage': self.usage,
                'wall_s': round(self.wall_s, 3), 'load_s': round(self.load_s, 3), 'native': self.native, 'meta': self.meta}


def render_transcript(messages):
    """Flatten a message list for the single-prompt CLIs."""
    parts = []
    for m in messages:
        label = 'CASE' if m['role'] == 'user' and not parts else ('YOUR PREVIOUS REPLY' if m['role'] == 'assistant' else 'HARNESS')
        parts.append('[%s]\n%s' % (label, m['content']))
    parts.append('[HARNESS]\nGive your next reply now: exactly one JSON object, nothing else.')
    return '\n\n'.join(parts)


class Adapter:
    name = 'base'
    cleanup_reserve_s = 0   # worst-case seconds `finish()` can take; a wall cap reserves it (dev-c5)
    runtime_version = None
    model_digest = None
    digest_na_reason = None

    def __init__(self, model):
        self.requested_model = model

    def preflight(self):
        return {}

    def before_case(self):
        pass

    def complete(self, system, messages, schema=None):
        raise NotImplementedError

    def finish(self):
        return {}

    def describe(self):
        return {'adapter': self.name, 'requested_model': self.requested_model, 'runtime_version': self.runtime_version,
                'model_digest': self.model_digest, 'model_digest_na_reason': self.digest_na_reason}

    def config(self):
        return {'adapter': self.name, 'model': self.requested_model}


STOPS = {'qwen': ['<|im_end|>'], 'muse': ['<|eot|>']}


def default_stop(model):
    for prefix, stop in STOPS.items():
        if model.lower().startswith(prefix):
            return list(stop)
    return []


ALLOWED_NUM_CTX = (4096, 8192)  # 4096 is the proven-safe value (2026-10-19 retry); 8192 ran on Oct 18; nothing larger without a context policy
DEFAULT_NUM_CTX = 4096
WARMUP_TIMEOUT_S = 900          # a cold NFS load of a 17 GB model took 336 s on 2026-10-19; never time one out at 60 s
WARMUP_PROMPT = 'Reply with OK'
# dev-c7 measurement (WO-W23; Tom 2026-10-21: "raise qwen's context to num_ctx 16384" for that run only).  A context policy is versioned and opt-in
# (`--context-policy`): it is the ONLY way to send a num_ctx outside ALLOWED_NUM_CTX, it fixes that one value, and it adds two reported-count flags.
# Without it every option, flag, record field and config key is byte-identical to before.
CONTEXT_POLICIES = {
    'ctx16k-v1': {
        'num_ctx': 16384,
        'input_budget': 'num_ctx - num_predict (the output reserve)',
        'turn_flag': 'prompt_reaches_input_budget: reported prompt_eval_count >= num_ctx - num_predict',
        'case_flag': 'reported_prompt_did_not_grow: a later turn whose reported prompt_eval_count is not above the previous turn\'s reported '
                     'prompt_eval_count + eval_count (a later request carries the whole earlier one, its reply and a new message; Ollama drops '
                     'whole old messages when a chat prompt exceeds num_ctx, which can leave the count below the limit)',
    },
}
# dev-c7 measurement (WO-W23, GPU safety): versioned, opt-in (`--gpu-fit-check`).  After the warm-up, /api/ps must show the model this run loaded
# entirely in VRAM (size_vram == size); anything else unloads it and skips the run.  Without it the preflight makes exactly the calls it made before.
# full-gpu-v2 (dev-c7 Amendment 1, Opus P2): full-gpu-v1, and Prime is shared, so the model can be evicted between calls and reloaded partly onto the CPU.
# Every case call whose reported load_duration exceeds RELOAD_LOAD_S (or does not report one) counts as a reload and repeats the same /api/ps reading; a reload
# that is not 100% GPU aborts the run (the case is started-aborted, unscored), unloads what this run loaded and exits 3.  The largest per-call load_duration
# recorded by the dev-c6 and dev-c5 qwen runs is 3.3 ms.  full-gpu-v1 is unchanged (one reading after the warm-up).
GPU_FIT_CHECKS = ('full-gpu-v1', 'full-gpu-v2')
RELOAD_LOAD_S = 1.0


def ollama_options(overrides=None, context_policy=None):
    """The only request options this harness sends to Ollama Prime.  num_ctx is validated; use_mmap, temperature and seed
    cannot be overridden (the 2026-10-19 21:04 kill followed a request with the server default -c 32768 and mmap).
    A context policy (dev-c7) fixes num_ctx to its one value; without one, ALLOWED_NUM_CTX applies exactly as before."""
    o = dict({'num_predict': 384}, **(overrides or {}))
    num_ctx = o.get('num_ctx', DEFAULT_NUM_CTX)
    if context_policy is not None:
        if context_policy not in CONTEXT_POLICIES:
            raise ValueError('unknown context policy %r (known: %s)' % (context_policy, sorted(CONTEXT_POLICIES)))
        if num_ctx != CONTEXT_POLICIES[context_policy]['num_ctx']:
            raise ValueError('context policy %s requires num_ctx %d, got %r' % (context_policy, CONTEXT_POLICIES[context_policy]['num_ctx'], num_ctx))
    elif num_ctx not in ALLOWED_NUM_CTX:
        raise ValueError('num_ctx %r is not allowed on Ollama Prime (allowed: %s)' % (num_ctx, ALLOWED_NUM_CTX))
    o.update(num_ctx=num_ctx, use_mmap=False, temperature=0, seed=42)
    return o


def context_check(options, native, chars, context_policy=None):
    """Per-turn truncation record.  Ollama truncates an over-long prompt silently, so the turn is flagged here and the
    flags are summarised per case.  prompt_eval_count excludes tokens served from the prompt cache, so a character-based
    estimate (3 chars per token, deliberately pessimistic) is kept next to it.
    Under a context policy (dev-c7) the turn also carries the policy, its input budget (num_ctx - num_predict) and the flag
    `prompt_reaches_input_budget`; without one the record is byte-identical to before."""
    n = options['num_ctx']
    prompt, out = native.get('prompt_eval_count'), native.get('eval_count')
    est = int(chars / 3.0)
    flags = []
    if prompt is not None and prompt >= n - 8:
        flags.append('prompt_at_context_limit')
    if prompt is not None and out is not None and prompt + out >= n:
        flags.append('context_full_after_generation')
    if est >= n:
        flags.append('estimated_prompt_exceeds_context')
    if native.get('done_reason') == 'length':
        flags.append('output_hit_num_predict')
    extra = {}
    if context_policy is not None:
        budget = n - options['num_predict']
        if prompt is not None and prompt >= budget:
            flags.append('prompt_reaches_input_budget')
        extra = {'context_policy': context_policy, 'input_budget_tokens': budget}
    return dict({'num_ctx': n, 'prompt_tokens_reported': prompt, 'output_tokens': out, 'prompt_chars': chars,
                 'prompt_tokens_estimated': est, 'flags': flags, 'truncated_suspected': any(f != 'output_hit_num_predict' for f in flags)}, **extra)


def context_summary(ctxs):
    """The per-case `context_check` of a record from its turns' context records (in order).  Without a context policy it is exactly the summary the
    runner always wrote.  Under a policy (dev-c7) it adds the policy, the input budget, the turns whose reported prompt did not grow and the case flag
    `reported_prompt_did_not_grow`, which also marks the case truncated_suspected."""
    out = {'num_ctx': ctxs[0]['num_ctx'], 'turns_checked': len(ctxs),
           'max_prompt_tokens_reported': max((c['prompt_tokens_reported'] or 0) for c in ctxs),
           'max_prompt_tokens_estimated': max(c['prompt_tokens_estimated'] for c in ctxs),
           'truncated_suspected': any(c['truncated_suspected'] for c in ctxs),
           'flags': sorted({f for c in ctxs for f in c['flags']})}
    policy = ctxs[0].get('context_policy')
    if policy is None:
        return out
    shrunk, prev = [], None
    for i, c in enumerate(ctxs):
        p, o = c.get('prompt_tokens_reported'), c.get('output_tokens')
        if prev is not None and p is not None and p <= prev[0] + (prev[1] or 0):
            shrunk.append(i)
        prev = (p, o) if p is not None else None
    out.update(context_policy=policy, input_budget_tokens=ctxs[0]['input_budget_tokens'], prompt_did_not_grow_turns=shrunk)
    if shrunk:
        out['flags'] = sorted(set(out['flags']) | {'reported_prompt_did_not_grow'})
        out['truncated_suspected'] = True
    return out


class OllamaAdapter(Adapter):
    name = 'ollama'
    # finish(): the unload (60 s + 5 s grace), /api/ps (60 s + 5 s) and two 15 s snapshot commands, plus the guard's last sample: 180 s is the reserve
    cleanup_reserve_s = 180

    def __init__(self, model, api=ot.api, snapshot=ot.snapshot, options=None, keep_alive='2m', stop=None,
                 schema=TURN_SCHEMA, schema_name='anyof', load_timeout=WARMUP_TIMEOUT_S, call_timeout=120, do_warmup=True,
                 guard=None, required_digest=None, context_policy=None, gpu_fit_check=None):
        super().__init__(model)
        self.required_digest = required_digest   # dev-c5: abort the run before any load when the installed digest differs
        if gpu_fit_check is not None and gpu_fit_check not in GPU_FIT_CHECKS:
            raise ValueError('unknown GPU fit check %r (known: %s)' % (gpu_fit_check, list(GPU_FIT_CHECKS)))
        if gpu_fit_check is not None and not do_warmup:
            raise ValueError('the GPU fit check reads /api/ps after the warm-up load; it cannot run without the warm-up')
        self.context_policy, self.gpu_fit_check = context_policy, gpu_fit_check    # dev-c7, both opt-in (None: everything as before)
        self.gpu_refits = []     # full-gpu-v2: every reload detected at a case call, with its /api/ps reading
        self.api, self.snapshot = api, snapshot
        self.options = ollama_options(options, context_policy)
        self.keep_alive, self.stop = keep_alive, default_stop(model) if stop is None else stop
        self.schema_name = schema_name
        self.schema, self.load_timeout, self.call_timeout, self.do_warmup = schema, load_timeout, call_timeout, do_warmup
        self.guard = guard  # a PsiGuard (None only in unit tests that do not exercise it)
        self.loaded_by_us = False
        self.model_info = {}
        self.last_preflight = {}  # kept even when preflight aborts, so the run manifest shows why

    def config(self):
        return {'adapter': self.name, 'model': self.requested_model, 'options': self.options, 'stop': self.stop,
                'think': False, 'keep_alive': self.keep_alive, 'stream': False, 'format': 'TURN_SCHEMA:' + self.schema_name,
                'warmup_timeout_s': self.load_timeout, 'call_timeout_s': self.call_timeout,
                **({'required_digest': self.required_digest} if self.required_digest else {}),
                **({'context_policy': self.context_policy} if self.context_policy else {}),      # dev-c7: only when set (so in the config hash)
                **({'gpu_fit_check': self.gpu_fit_check} if self.gpu_fit_check else {}),
                'psi_guard': ({'threshold': self.guard.threshold, 'interval_s': self.guard.interval, 'consecutive': self.guard.consecutive}
                              if self.guard else None)}

    def _cancel(self):
        return self.guard.cancel if self.guard else None

    def _call(self, path, payload=None, timeout=60):
        return self.api(path, payload, timeout=timeout, **({'cancel': self._cancel()} if self.guard else {}))

    def _residents(self):
        ps, receipt = self.api('/api/ps')
        if ps is None:
            raise AbortRun('cannot read /api/ps (%s); refusing to touch the GPU blind' % receipt.get('exit_code'))
        return [m.get('name') or m.get('model') for m in ps.get('models', [])]

    def _guard_trip(self):
        return self.guard.tripped if self.guard else None

    def preflight(self):
        ver, _ = self.api('/api/version')
        tags, tr = self.api('/api/tags')
        if tags is None:
            raise AbortRun('cannot read /api/tags: %s' % tr.get('exit_code'))
        residents = self._residents()
        snap = self.snapshot()
        report = self.last_preflight = {'residents_before': residents, 'resources_before': snap}
        if residents:
            # even our own tag: a model this run did not load is somebody else's (or a stale load) and is never reused or evicted
            raise AbortRun('GPU busy: model(s) %s resident before this batch started; /api/ps must be empty, not evicting' % residents)
        if snap.get('compute_processes'):
            raise AbortRun('GPU has an existing compute owner: %s' % snap['compute_processes'])
        installed = next((m for m in tags.get('models', []) if m.get('name') == self.requested_model), None)
        if not installed:
            raise AbortRun('model %s is not installed on Prime (this harness never pulls)' % self.requested_model)
        self.runtime_version = (ver or {}).get('version')
        self.model_digest = installed.get('digest')
        if self.required_digest and str(self.model_digest).removeprefix('sha256:') != str(self.required_digest).removeprefix('sha256:'):
            raise AbortRun('model digest differs from the frozen one: installed %s, required %s; nothing was loaded' % (self.model_digest, self.required_digest))
        self.model_info = {'details': installed.get('details'), 'size': installed.get('size')}
        if self.guard:
            self.guard.start()  # baseline pod identity + stall counter before the GPU is touched
            report['psi_baseline'] = self.guard.samples[-1]
            if self.guard.tripped:
                raise AbortRun('guard tripped before the load: %s' % self.guard.tripped)
        report.update(self.describe(), model_info=self.model_info, loaded_by_us=False)
        if self.do_warmup:
            self.loaded_by_us = True  # from here on a stop must unload it
            t = time.monotonic()
            resp, rc = self._call('/api/generate', {'model': self.requested_model, 'prompt': WARMUP_PROMPT, 'stream': False, 'think': False,
                                                    'keep_alive': self.keep_alive, 'options': dict(self.options, num_predict=256)},
                                  timeout=self.load_timeout)
            report['loaded_by_us'] = True
            report['warmup'] = {'wall_s': round(time.monotonic() - t, 3), 'ok': resp is not None and not resp.get('error'),
                                'load_duration_ns': (resp or {}).get('load_duration'), 'error': (resp or {}).get('error'),
                                'exit_code': rc.get('exit_code')}
            if self._guard_trip():
                raise AbortRun('guard tripped during the load: %s' % self._guard_trip())
            if resp is None or resp.get('error'):
                # a half-finished load may still be running: do not unload, do not replay
                self.loaded_by_us = False
                raise AbortRun('model load failed or timed out (%s); not retrying, not unloading' % (report['warmup']['error'] or rc.get('exit_code')))
            if self.gpu_fit_check:
                fit = report['gpu_fit'] = self._gpu_fit()
                if not fit['full_gpu']:
                    # loaded_by_us stays True: finish() unloads exactly the model this run loaded; nothing is retried or run partly on the CPU
                    raise AbortRun('gpu_fit_skip (%s): %s; unloading, not running any case' % (self.gpu_fit_check, fit['reason']))
        return report

    def _gpu_fit(self):
        """full-gpu-v1: one /api/ps read after the warm-up.  Full GPU means the model this run loaded is the only resident and its size_vram equals its
        size (Ollama's own '100% GPU'), with a reported context length (when the server reports one) not below the requested num_ctx.  Every other
        reading, an unreadable /api/ps or a missing field included, is NOT full GPU (fail closed)."""
        ps, rc = self.api('/api/ps')
        out = {'check': self.gpu_fit_check, 'requested_num_ctx': self.options['num_ctx'], 'full_gpu': False}
        if ps is None:
            return dict(out, reason='cannot read /api/ps (%s)' % rc.get('exit_code'))
        models = ps.get('models') or []
        out['residents'] = [m.get('name') or m.get('model') for m in models]
        ours = [m for m in models if (m.get('name') or m.get('model')) == self.requested_model]
        if len(ours) != 1 or len(models) != 1:
            return dict(out, reason='expected exactly this run\'s model resident, found %s' % out['residents'])
        m = ours[0]
        size, vram, ctx = m.get('size'), m.get('size_vram'), m.get('context_length')
        out.update(size=size, size_vram=vram, context_length=ctx)
        if not isinstance(size, int) or not isinstance(vram, int) or size <= 0:
            return dict(out, reason='/api/ps does not report size and size_vram for the model (size %r, size_vram %r)' % (size, vram))
        out['gpu_fraction'] = round(vram / size, 6)
        if vram != size:
            return dict(out, reason='%d of %d bytes in VRAM (%.2f%% GPU): part of the model is on the CPU' % (vram, size, 100.0 * vram / size))
        if ctx is not None and (not isinstance(ctx, int) or ctx < self.options['num_ctx']):
            return dict(out, reason='the loaded context length %r is below the requested num_ctx %d' % (ctx, self.options['num_ctx']))
        return dict(out, full_gpu=True, reason='100% GPU')

    def before_case(self):
        trip = self._guard_trip() or (self.guard.check() if self.guard else None)
        if trip:
            raise AbortRun('guard: %s' % trip)
        foreign = [r for r in self._residents() if r != self.requested_model]
        if foreign:
            raise AbortRun('resident_owner_changed_no_eviction: %s' % foreign)

    def complete(self, system, messages, schema=None):
        body = {'model': self.requested_model, 'stream': False, 'think': False, 'format': schema if schema is not None else self.schema,
                'keep_alive': self.keep_alive, 'options': dict(self.options, **({'stop': self.stop} if self.stop else {})),
                'messages': [{'role': 'system', 'content': system}] + messages}
        started = time.monotonic()
        resp, receipt = self._call('/api/chat', body, timeout=self.call_timeout)
        wall = time.monotonic() - started
        refit = None
        if self._guard_trip():
            # recorded as a failed case (forced escalate); the next before_case() aborts the batch
            raise AdapterError('request cancelled, PSI/restart guard tripped: %s' % self._guard_trip())
        if resp is None:
            raise AdapterError('ollama transport failure: %s' % json.dumps({k: receipt.get(k) for k in ('exit_code', 'http_status', 'stderr')})[:400])
        if resp.get('error'):
            raise AdapterError('ollama error: %s' % str(resp['error'])[:300])
        native = {k: resp.get(k) for k in ('total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration',
                                           'eval_count', 'eval_duration', 'done_reason', 'created_at')}
        usage = {'input_tokens': resp.get('prompt_eval_count'), 'output_tokens': resp.get('eval_count'), 'cost_usd': None}
        chars = len(system) + sum(len(m['content']) for m in messages)
        if self.gpu_fit_check == 'full-gpu-v2':
            refit = self._reload_check(native)
            if refit is not None and not refit['gpu_fit']['full_gpu']:
                ab = AbortRun('gpu_fit_abort (full-gpu-v2): the model was reloaded at a case call (load_duration %s ns) and is not 100%% GPU: %s; '
                              'unloading, not running further cases' % (native.get('load_duration'), refit['gpu_fit']['reason']))
                ab.failed_call = {'error': 'reloaded partly onto the CPU: %s' % refit['gpu_fit']['reason'], 'usage': usage, 'native': native, 'gpu_refit': refit,
                                  'failure_modes': ['gpu_reload_not_full_gpu']}
                raise ab
        return Completion((resp.get('message') or {}).get('content', ''), body, receipt, response_model=resp.get('model'),
                          usage=usage, wall_s=wall, load_s=(resp.get('load_duration') or 0) / 1e9, native=native,
                          meta=dict({'context': context_check(self.options, native, chars, self.context_policy)}, **({'gpu_refit': refit} if refit else {})))

    def _reload_check(self, native):
        """full-gpu-v2: a case call with load_duration above RELOAD_LOAD_S, or none reported, is a reload: read /api/ps again (the full-gpu-v1 rule)."""
        ld = native.get('load_duration')
        if isinstance(ld, (int, float)) and ld <= RELOAD_LOAD_S * 1e9:
            return None
        refit = {'load_duration_ns': ld, 'gpu_fit': self._gpu_fit()}
        self.gpu_refits.append(refit)
        return refit

    def finish(self):
        report = {'unloaded': False}
        try:
            if self.guard:
                self.guard.stop()
            if self.loaded_by_us:
                resp, rc = self.api('/api/generate', {'model': self.requested_model, 'keep_alive': 0, 'stream': False}, timeout=60)
                report.update(unloaded=resp is not None and not resp.get('error'), unload_response=resp)
            if self.gpu_fit_check == 'full-gpu-v2':
                report['gpu_refits'] = list(self.gpu_refits)
            ps, _ = self.api('/api/ps')
            report['residents_after'] = None if ps is None else [m.get('name') for m in ps.get('models', [])]
            report['resources_after'] = self.snapshot()
            if self.guard:
                self.guard.sample()  # one more reading after the unload
                report['psi_guard'] = dict(self.guard.summary(), samples_detail=self.guard.samples[-200:])
        except Exception as e:  # noqa: BLE001 - reporting only
            report['error'] = str(e)[:200]
        return report


CLAUDE_FLAGS = ['--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
                '--setting-sources', '', '--no-session-persistence']


# dev-c8: reply-schema delivery for the Claude CLI (opt-in adapter version claude-schema-1; `schema_mode=None` is the legacy adapter, byte for byte).
# Advertised by the pinned CLI's `--help` (`--json-schema <schema>`, print mode) and documented (headless mode, Agent SDK structured outputs): the CLI adds a
# `StructuredOutput` tool whose input is the reply, validates it client-side and RE-PROMPTS on a mismatch until it is valid or the run ends with
# `error_max_structured_output_retries`; the `json` envelope then carries only the final `structured_output`.  To keep the model's first try and grant no extra
# repair, this mode reads the `stream-json` event stream and takes the FIRST StructuredOutput attempt as the reply; later CLI-internal attempts and the CLI's own
# validation results are recorded (turns[].meta.schema) and never used.  Whether the CLI registered the tool is read from its init event, not assumed.
CLAUDE_SCHEMA_ADAPTER_VERSION = 'claude-schema-1'
STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'


class ClaudeAdapter(Adapter):
    name = 'claude'
    digest_na_reason = 'hosted API model: no weights digest; the response model id is recorded instead'

    def __init__(self, model, effort=None, max_budget_usd=2.0, timeout=240, runner=subprocess.run, schema_mode=None):
        super().__init__(model)
        self.effort, self.max_budget_usd, self.timeout, self.runner = effort, max_budget_usd, timeout, runner
        self.workdir = tempfile.mkdtemp(prefix='mrh-claude-')
        if schema_mode is not None and schema_mode != 'json-schema-1':
            raise ValueError('unknown claude schema mode %r (known: json-schema-1)' % (schema_mode,))
        self.schema_mode = schema_mode
        if schema_mode is not None:
            self.schema_name = 'flat'      # the runner builds the flat per-case turn schema (one object type at the top level) for this mode

    def config(self):
        c = {'adapter': self.name, 'model': self.requested_model, 'effort': self.effort, 'flags': CLAUDE_FLAGS,
             'output_format': 'json', 'max_budget_usd': self.max_budget_usd, 'timeout_s': self.timeout}
        if self.schema_mode is not None:      # only in schema mode: the legacy config (and config hash) keeps its shape
            c.update(adapter_version=CLAUDE_SCHEMA_ADAPTER_VERSION, schema_mode=self.schema_mode, output_format='stream-json', schema_variant='flat',
                     reply_from='first StructuredOutput attempt (CLI-internal retries recorded, never used)')
        return c

    def preflight(self):
        if not shutil.which('claude'):
            raise AbortRun('claude CLI not found')
        v = self.runner(['claude', '--version'], capture_output=True, text=True, timeout=30)
        self.runtime_version = v.stdout.strip()
        return self.describe()

    def argv(self, system):
        # max_budget_usd None (dev-c6, `--no-spend-limit`): no spend-limit flag at all; usage accounting and the timeout stay.  The default (2.0) is unchanged.
        cmd = ['claude', '-p', '--model', self.requested_model, '--output-format', 'json', '--system-prompt', system] + \
              (['--max-budget-usd', str(self.max_budget_usd)] if self.max_budget_usd is not None else []) + CLAUDE_FLAGS
        if self.effort:
            cmd += ['--effort', self.effort]
        return cmd

    def argv_schema(self, system, schema):
        """claude-schema-1: the legacy argv with `--output-format stream-json --verbose` (the event stream shows every StructuredOutput attempt) and
        `--json-schema <the per-case flat turn schema>`."""
        cmd = self.argv(system)
        i = cmd.index('--output-format')
        cmd[i + 1] = 'stream-json'
        return cmd[:i + 2] + ['--verbose', '--json-schema', json.dumps(schema, separators=(',', ':'), sort_keys=True)] + cmd[i + 2:]

    def complete(self, system, messages, schema=None):
        prompt = render_transcript(messages)
        schema_mode = self.schema_mode is not None and schema is not None
        cmd = self.argv_schema(system, schema) if schema_mode else self.argv(system)
        started = time.monotonic()
        try:
            r = self.runner(cmd, input=prompt.encode(), capture_output=True, timeout=self.timeout, cwd=self.workdir)
        except subprocess.TimeoutExpired as te:
            if not schema_mode:
                raise AdapterError('claude CLI timed out after %d s' % self.timeout)
            from . import claude_schema
            raise claude_schema.timeout_error(self, te, cmd, system, prompt, schema, time.monotonic() - started)
        wall = time.monotonic() - started
        raw = r.stdout.decode(errors='replace')
        req = {'argv': cmd[:cmd.index('--system-prompt')] + ['--system-prompt', '<system>'] + cmd[cmd.index('--system-prompt') + 2:],
               'system_prompt': system, 'prompt': prompt}
        if schema_mode:
            req['json_schema_sha256'] = _sha256_text(json.dumps(schema, separators=(',', ':'), sort_keys=True))
            return parse_claude_stream(raw, r.stderr.decode(errors='replace'), r.returncode, req, wall, self.schema_mode)
        return parse_claude(raw, r.stderr.decode(errors='replace'), r.returncode, req, wall)

    def finish(self):
        shutil.rmtree(self.workdir, ignore_errors=True)
        return {}


def parse_claude(raw, stderr, returncode, req, wall):
    try:
        d = json.loads(raw)
    except ValueError:
        raise AdapterError('claude CLI returned non-JSON (exit %s): %s' % (returncode, (raw or stderr)[:300]))
    u = d.get('usage') or {}
    if d.get('is_error') or d.get('subtype', 'success') != 'success':
        receipt = {'input_tokens': u.get('input_tokens'), 'output_tokens': u.get('output_tokens'), 'cost_usd': d.get('total_cost_usd')}
        raise AdapterError('claude CLI error: %s' % json.dumps({k: d.get(k) for k in ('subtype', 'api_error_status', 'result', 'terminal_reason')})[:400],
                           usage=receipt, budget_exceeded=d.get('subtype') == 'error_max_budget_usd')
    models = list((d.get('modelUsage') or {}).keys())
    usage = {'input_tokens': u.get('input_tokens'), 'output_tokens': u.get('output_tokens'),
             'cache_creation_input_tokens': u.get('cache_creation_input_tokens'), 'cache_read_input_tokens': u.get('cache_read_input_tokens'),
             'cost_usd': d.get('total_cost_usd')}
    return Completion(d.get('result') or '', req, raw, response_model=models[0] if len(models) == 1 else (models or None),
                      usage=usage, wall_s=wall, native={'duration_ms': d.get('duration_ms'), 'duration_api_ms': d.get('duration_api_ms'),
                                                        'num_turns': d.get('num_turns'), 'stop_reason': d.get('stop_reason'),
                                                        'permission_denials': d.get('permission_denials')},
                      meta={'model_usage': d.get('modelUsage')})


def _sha256_text(s):
    import hashlib
    return hashlib.sha256(s.encode()).hexdigest()


def parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode='json-schema-1'):
    """claude-schema-1's stream parser (claude_schema.py; loaded only in schema mode)."""
    from . import claude_schema
    return claude_schema.parse_claude_stream(raw, stderr, returncode, req, wall, schema_mode)


CODEX_FLAGS = ['--json', '-s', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']
# Codex's own tool definitions cost about 5k tokens per turn that this protocol never uses (the model answers in JSON and the
# harness runs our tools).  Measured 2026-10-19 with gpt-6-luna on a one-line prompt: 27.1k input tokens with the flags above,
# 22.2k with these overrides (web search, shell, apps, browser/computer use, multi-agent, plugins, image generation, ... off).
# Disabling the shell tool also means the model cannot run anything natively.  The rest (about 22k) is Codex's fixed system prompt.
CODEX_TRIM_FEATURES = ['multi_agent', 'image_generation', 'plugins', 'skill_search', 'goals', 'hooks', 'sleep_tool', 'view_image',
                       'unified_exec', 'shell_tool', 'write_stdin_approval', 'tool_suggest', 'worktrees', 'remote_plugin', 'apps',
                       'browser_use', 'computer_use']
CODEX_TRIM = ['-c', 'web_search="disabled"'] + [x for f in CODEX_TRIM_FEATURES for x in ('-c', 'features.%s=false' % f)]
NATIVE_TOOL_ITEMS = ('command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'collab_tool_call')


class CodexAdapter(Adapter):
    name = 'codex'
    digest_na_reason = 'hosted API model: no weights digest; usage is taken from the event stream'

    def __init__(self, model, effort=None, timeout=300, record_session=True, runner=subprocess.run):
        super().__init__(model)
        self.effort, self.timeout, self.record_session, self.runner = effort, timeout, record_session, runner
        self.workdir = tempfile.mkdtemp(prefix='mrh-codex-')

    def config(self):
        return {'adapter': self.name, 'model': self.requested_model, 'effort': self.effort, 'flags': CODEX_FLAGS,
                'trim': CODEX_TRIM, 'ephemeral': not self.record_session, 'timeout_s': self.timeout}

    def preflight(self):
        if not shutil.which('codex'):
            raise AbortRun('codex CLI not found')
        v = self.runner(['codex', '--version'], capture_output=True, text=True, timeout=30)
        self.runtime_version = v.stdout.strip()
        return self.describe()

    def argv(self):
        cmd = ['codex', 'exec'] + CODEX_FLAGS + CODEX_TRIM + ['-m', self.requested_model, '-C', self.workdir]
        if not self.record_session:
            cmd.append('--ephemeral')
        if self.effort:
            cmd += ['-c', 'model_reasoning_effort="%s"' % self.effort]
        return cmd + ['-']

    def complete(self, system, messages, schema=None):
        prompt = system + '\n\n---\n\n' + render_transcript(messages)
        cmd = self.argv()
        started = time.monotonic()
        try:
            r = self.runner(cmd, input=prompt.encode(), capture_output=True, timeout=self.timeout)
        except subprocess.TimeoutExpired:
            raise AdapterError('codex CLI timed out after %d s' % self.timeout)
        wall = time.monotonic() - started
        raw = r.stdout.decode(errors='replace')
        return parse_codex(raw, r.returncode, {'argv': cmd, 'prompt': prompt}, wall, record_session=self.record_session)

    def finish(self):
        shutil.rmtree(self.workdir, ignore_errors=True)
        return {}


def _rollout_model(thread_id):
    root = Path(os.path.expanduser('~/.codex/sessions'))
    for f in root.glob('*/*/*/rollout-*%s.jsonl' % thread_id):
        for line in f.read_text(errors='replace').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            payload = e.get('payload') if isinstance(e, dict) else None
            if isinstance(payload, dict) and payload.get('model'):
                return payload['model']
    return None


def parse_codex(raw, returncode, req, wall, record_session=True):
    text, usage, native_tools, errors, thread = None, {}, [], [], None
    for line in raw.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get('type')
        if t == 'thread.started':
            thread = e.get('thread_id')
        elif t == 'item.completed':
            item = e.get('item') or {}
            if item.get('type') == 'agent_message':
                text = item.get('text')
            elif item.get('type') in NATIVE_TOOL_ITEMS:
                native_tools.append(item.get('type'))
        elif t == 'turn.completed':
            u = e.get('usage') or {}
            usage = {'input_tokens': u.get('input_tokens'), 'cached_input_tokens': u.get('cached_input_tokens'),
                     'output_tokens': u.get('output_tokens'), 'reasoning_output_tokens': u.get('reasoning_output_tokens'),
                     'cost_usd': None}
        elif t in ('turn.failed', 'error'):
            errors.append(e.get('error') or e.get('message') or e)
    if text is None:
        raise AdapterError('codex produced no agent message (exit %s): %s' % (returncode, json.dumps(errors)[:300] or raw[:300]))
    model = _rollout_model(thread) if (record_session and thread) else None
    return Completion(text, req, raw, response_model=model, usage=usage, wall_s=wall,
                      meta={'thread_id': thread, 'native_tool_items': native_tools,
                            'response_model_source': 'rollout' if model else 'not_reported'})


class ScriptedAdapter(Adapter):
    """Canned replies, one per call (a string, or an Exception instance to raise)."""
    name = 'scripted'
    digest_na_reason = 'scripted test adapter'

    def __init__(self, model, replies):
        super().__init__(model)
        self.replies = list(replies)
        self.runtime_version = 'scripted-1'
        self.calls = []

    def complete(self, system, messages, schema=None):
        self.calls.append(json.loads(json.dumps(messages)))
        if not self.replies:
            raise AdapterError('scripted adapter ran out of replies')
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        text = r if isinstance(r, str) else json.dumps(r)
        return Completion(text, {'system': system, 'messages': messages}, text, response_model=self.requested_model,
                          usage={'input_tokens': 10, 'output_tokens': 5, 'cost_usd': 0.0}, wall_s=0.01)
