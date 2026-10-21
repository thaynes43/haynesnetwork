"""dev-c7 measurement plumbing (WO-W23): the two versioned, opt-in runner flags `--context-policy ctx16k-v1` (num_ctx 16384 for the qwen run only, Tom
2026-10-21, with reported-count context flags) and `--gpu-fit-check full-gpu-v1` (after the warm-up, /api/ps must show the model 100% in VRAM, else it is
unloaded and the run stops before any case), and the proof that without them every legacy, dev-c6 and dev-c7 command is byte-identical: the recorded
dev-c6 configs, per-turn context records and per-case context summaries are rebuilt exactly.  Fake Ollama API and scripted replies only; no model, no
network, no GPU."""
import argparse
import glob
import json
import tempfile
import unittest
from pathlib import Path

import th
from media_repair_harness import adapters as A
from media_repair_harness import run as R

RUNS = th.COMPONENT / 'runs'
DEVC6 = RUNS / 'dev-c6'
QWEN_RUNS = [DEVC6 / 'devc6-qwen3.8-27b', RUNS / 'dev-c5' / 'devc5-b-qwen3.8-27b']
SIZE = 17741872154          # the installed qwen3.8:27b blob size recorded by dev-c6 (/api/tags)
ESCALATE = {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': 'r', 'confidence': 0.0, 'evidence_refs': []}


def records(run_dir):
    return [json.loads(Path(p).read_text()) for p in sorted(glob.glob(str(run_dir / '*-*-[0-9]*.json')))]


class FakeOllama:
    """Fake of ollama_transport.api with a configurable /api/ps after the load."""

    def __init__(self, ps_after=None, ps_unreadable=False, installed=('qwen3.8:27b',), chat_loads=None, ps_after_reload=None):
        self.calls, self.resident, self.installed = [], [], installed
        self.ps_after, self.ps_unreadable = ps_after, ps_unreadable
        self.chat_loads = list(chat_loads or [])      # load_duration (ns) reported by each /api/chat in turn; 'omit' leaves it out; default 2 ms
        self.ps_after_reload, self.reloaded = ps_after_reload, False

    def __call__(self, path, payload=None, timeout=60, **_kw):
        self.calls.append((path, payload))
        if path == '/api/version':
            return {'version': '0.40.6'}, {'exit_code': 0}
        if path == '/api/tags':
            return {'models': [{'name': n, 'digest': 'sha256:abc', 'details': {}, 'size': SIZE} for n in self.installed]}, {'exit_code': 0}
        if path == '/api/ps':
            if not self.resident:
                return {'models': []}, {'exit_code': 0}
            if self.ps_unreadable:
                return None, {'exit_code': 'local_timeout'}
            if self.reloaded and self.ps_after_reload is not None:
                return {'models': self.ps_after_reload}, {'exit_code': 0}
            return {'models': self.ps_after if self.ps_after is not None else [{'name': m, 'size': SIZE, 'size_vram': SIZE} for m in self.resident]}, {'exit_code': 0}
        if path == '/api/generate':
            if payload.get('keep_alive') == 0:
                self.resident = []
                return {'done': True}, {'exit_code': 0}
            self.resident = [payload['model']]
            return {'done': True, 'load_duration': 5_000_000_000}, {'exit_code': 0}
        if path == '/api/chat':
            n = len(json.dumps(payload['messages']))
            load = self.chat_loads.pop(0) if self.chat_loads else 2_000_000
            if load != 'omit' and load > 1e9:
                self.reloaded = True
            resp = {'model': payload['model'], 'message': {'content': json.dumps(ESCALATE)}, 'prompt_eval_count': n // 4, 'eval_count': 30, 'done_reason': 'stop'}
            if load != 'omit':
                resp['load_duration'] = load
            return resp, {'exit_code': 0}
        raise AssertionError(path)


def snapshot():
    return {'stdout': 'GPU, 1 MiB', 'compute_processes': '', 'exit_code': 0}


def adapter(fake, **kw):
    return A.OllamaAdapter('qwen3.8:27b', api=fake, snapshot=snapshot, guard=None, **kw)


def ps_row(**kw):
    return [dict({'name': 'qwen3.8:27b', 'size': SIZE, 'size_vram': SIZE, 'context_length': 16384}, **kw)]


class LegacyByteIdentity(unittest.TestCase):
    """Without the new flags nothing changes: recorded dev-c6 configs, context records and summaries are rebuilt exactly."""

    def test_dev_c6_registered_commands_rebuild_their_recorded_config(self):
        for run in ('devc6-qwen3.8-27b', 'devc6-haiku-5-5', 'devc6-gpt-6-astra'):
            man = json.loads((DEVC6 / run / 'manifest.json').read_text())
            args = R.build_parser().parse_args(man['argv'])
            self.assertIsNone(args.context_policy)
            self.assertIsNone(args.gpu_fit_check)
            ad = R.build_adapter(args)
            got = R.run_config(args, ad, {}, None)
            want = dict(man['config'])
            # the only recorded difference is the harness version string (dev-c6 then, dev-c7 on this tree); every other key and value is equal
            self.assertEqual(want.pop('harness_version'), 'dev-c6')
            self.assertEqual(got.pop('harness_version'), 'dev-c7')
            if run.startswith('devc6-qwen'):
                self.assertEqual(got['adapter_config'], want['adapter_config'])
            else:   # hosted adapters: the CLI version is read at preflight, not in the config
                self.assertEqual(got['adapter_config'], want['adapter_config'], run)
            self.assertEqual(R.canonical(got), R.canonical(want), run)

    def test_recorded_turn_context_records_are_rebuilt_byte_for_byte(self):
        n = 0
        for run in QWEN_RUNS:
            opts = json.loads((run / 'manifest.json').read_text())['config']['adapter_config']['options']
            for rec in records(run):
                ctxs = []
                for t in rec['turns']:
                    c = (t.get('meta') or {}).get('context')
                    if not c:
                        continue
                    self.assertEqual(A.context_check(opts, t['native'], c['prompt_chars']), c)
                    ctxs.append(c)
                    n += 1
                if ctxs:
                    self.assertEqual(A.context_summary(ctxs), rec['context_check'], rec['case_id'])
        self.assertGreater(n, 150)

    def test_options_without_a_policy_are_unchanged_and_16384_is_refused(self):
        self.assertEqual(A.ollama_options({'num_ctx': 8192, 'num_predict': 640}),
                         {'num_ctx': 8192, 'num_predict': 640, 'use_mmap': False, 'temperature': 0, 'seed': 42})
        self.assertEqual(A.ollama_options({})['num_ctx'], 4096)
        for bad in (16384, 32768, 2048):
            with self.assertRaises(ValueError):
                A.ollama_options({'num_ctx': bad})

    def test_preflight_without_the_check_makes_exactly_the_earlier_calls(self):
        fake = FakeOllama()
        ad = adapter(fake, options={'num_ctx': 8192, 'num_predict': 640})
        rep = ad.preflight()
        self.assertEqual([c[0] for c in fake.calls], ['/api/version', '/api/tags', '/api/ps', '/api/generate'])
        self.assertNotIn('gpu_fit', rep)
        cfg = ad.config()
        self.assertNotIn('context_policy', cfg)
        self.assertNotIn('gpu_fit_check', cfg)
        comp = ad.complete('s', [{'role': 'user', 'content': 'x'}])
        self.assertNotIn('context_policy', comp.meta['context'])
        self.assertNotIn('prompt_reaches_input_budget', comp.meta['context']['flags'])


class ContextPolicy(unittest.TestCase):

    def opts(self):
        return A.ollama_options({'num_ctx': 16384, 'num_predict': 640}, 'ctx16k-v1')

    def test_the_policy_fixes_16384_and_nothing_else(self):
        self.assertEqual(self.opts(), {'num_ctx': 16384, 'num_predict': 640, 'use_mmap': False, 'temperature': 0, 'seed': 42})
        for bad in (8192, 4096, 32768):
            with self.assertRaises(ValueError):
                A.ollama_options({'num_ctx': bad}, 'ctx16k-v1')
        with self.assertRaises(ValueError):
            A.ollama_options({'num_ctx': 16384}, 'ctx32k-v1')
        # the mmap, temperature and seed rules still cannot be weakened
        o = A.ollama_options({'num_ctx': 16384, 'use_mmap': True, 'temperature': 1, 'seed': 7}, 'ctx16k-v1')
        self.assertEqual((o['use_mmap'], o['temperature'], o['seed']), (False, 0, 42))

    def test_the_turn_flag_is_at_num_ctx_minus_the_output_reserve(self):
        o = self.opts()
        below = A.context_check(o, {'prompt_eval_count': 15743, 'eval_count': 40, 'done_reason': 'stop'}, 40000, 'ctx16k-v1')
        at = A.context_check(o, {'prompt_eval_count': 15744, 'eval_count': 40, 'done_reason': 'stop'}, 40000, 'ctx16k-v1')
        self.assertEqual(below['flags'], [])
        self.assertFalse(below['truncated_suspected'])
        self.assertEqual(at['flags'], ['prompt_reaches_input_budget'])
        self.assertTrue(at['truncated_suspected'])
        self.assertEqual((at['context_policy'], at['input_budget_tokens'], at['num_ctx']), ('ctx16k-v1', 15744, 16384))
        est = A.context_check(o, {'prompt_eval_count': 9000, 'eval_count': 40, 'done_reason': 'stop'}, 3 * 16384, 'ctx16k-v1')
        self.assertEqual(est['flags'], ['estimated_prompt_exceeds_context'])      # the estimate stays a separate, secondary flag
        none = A.context_check(o, {'prompt_eval_count': None, 'eval_count': None}, 10, 'ctx16k-v1')
        self.assertEqual(none['flags'], [])

    def turn(self, p, out=40):
        return A.context_check(self.opts(), {'prompt_eval_count': p, 'eval_count': out, 'done_reason': 'stop'}, 1000, 'ctx16k-v1')

    def test_a_case_whose_reported_prompt_does_not_grow_is_flagged(self):
        grow = A.context_summary([self.turn(5000), self.turn(5041), self.turn(6000)])
        self.assertEqual((grow['prompt_did_not_grow_turns'], grow['flags'], grow['truncated_suspected']), ([], [], False))
        same = A.context_summary([self.turn(5000), self.turn(5040)])           # not above prompt + reply: something was dropped
        self.assertEqual(same['prompt_did_not_grow_turns'], [1])
        self.assertEqual(same['flags'], ['reported_prompt_did_not_grow'])
        self.assertTrue(same['truncated_suspected'])
        drop = A.context_summary([self.turn(12000), self.turn(15000), self.turn(9000)])     # Ollama dropped old messages: below the limit, still caught
        self.assertEqual(drop['prompt_did_not_grow_turns'], [2])
        gap = A.context_summary([self.turn(5000), self.turn(None), self.turn(100)])          # a turn with no count breaks the chain, never guesses
        self.assertEqual(gap['prompt_did_not_grow_turns'], [])
        self.assertEqual((gap['context_policy'], gap['input_budget_tokens']), ('ctx16k-v1', 15744))

    def test_recorded_qwen_counts_always_grew(self):
        """The growth rule against the recorded counts of the dev-c6 and dev-c5 qwen runs (no truncation there: largest prompt 7068 of 8192)."""
        pairs = 0
        for run in QWEN_RUNS:
            for rec in records(run):
                ctxs = [dict(t['meta']['context'], context_policy='ctx16k-v1', input_budget_tokens=15744) for t in rec['turns'] if (t.get('meta') or {}).get('context')]
                if ctxs:
                    self.assertEqual(A.context_summary(ctxs)['prompt_did_not_grow_turns'], [], rec['case_id'])
                    pairs += len(ctxs) - 1
        self.assertGreater(pairs, 80)

    def test_requests_carry_16384_and_the_config_records_the_policy(self):
        fake = FakeOllama()
        ad = adapter(fake, options={'num_ctx': 16384, 'num_predict': 640}, context_policy='ctx16k-v1')
        ad.preflight()
        comp = ad.complete('s', [{'role': 'user', 'content': 'x'}])
        chat = [c[1] for c in fake.calls if c[0] == '/api/chat'][0]
        warm = [c[1] for c in fake.calls if c[0] == '/api/generate'][0]
        self.assertEqual((chat['options']['num_ctx'], warm['options']['num_ctx'], warm['options']['num_predict']), (16384, 16384, 256))
        self.assertEqual(comp.meta['context']['context_policy'], 'ctx16k-v1')
        self.assertEqual(ad.config()['context_policy'], 'ctx16k-v1')
        self.assertEqual(ad.config()['options']['num_ctx'], 16384)


    def test_a_repair_turn_is_caught_by_the_reported_count_flags(self):
        """Amendment 1, Opus P3 (text only; a supporting test, not a regression): the sizing has no repair turn.  A repair adds the invalid reply (up to
        640 tokens) and a repair message; if that pushes a prompt over the input budget the turn flag fires, and a repair turn is never a false
        did-not-grow."""
        o = self.opts()
        t1 = A.context_check(o, {'prompt_eval_count': 15200, 'eval_count': 640, 'done_reason': 'length'}, 40000, 'ctx16k-v1')
        t2 = A.context_check(o, {'prompt_eval_count': 15900, 'eval_count': 80, 'done_reason': 'stop'}, 42000, 'ctx16k-v1')
        self.assertEqual(t2['flags'], ['prompt_reaches_input_budget'])
        summ = A.context_summary([t1, t2])
        self.assertEqual(summ['prompt_did_not_grow_turns'], [])
        self.assertIn('prompt_reaches_input_budget', summ['flags'])

class GpuFitCheck(unittest.TestCase):

    def make(self, fake, **kw):
        return adapter(fake, options={'num_ctx': 16384, 'num_predict': 640}, context_policy='ctx16k-v1', gpu_fit_check='full-gpu-v1', **kw)

    def test_full_gpu_proceeds_with_one_extra_ps_read(self):
        fake = FakeOllama(ps_after=ps_row())
        ad = self.make(fake)
        rep = ad.preflight()
        self.assertEqual([c[0] for c in fake.calls], ['/api/version', '/api/tags', '/api/ps', '/api/generate', '/api/ps'])
        fit = rep['gpu_fit']
        self.assertTrue(fit['full_gpu'])
        self.assertEqual((fit['size'], fit['size_vram'], fit['gpu_fraction'], fit['context_length'], fit['check']), (SIZE, SIZE, 1.0, 16384, 'full-gpu-v1'))
        self.assertEqual(ad.config()['gpu_fit_check'], 'full-gpu-v1')
        self.assertTrue(self.make(FakeOllama(ps_after=[{'name': 'qwen3.8:27b', 'size': SIZE, 'size_vram': SIZE}])).preflight()['gpu_fit']['full_gpu'])   # no context field

    def assert_skip(self, fake, why):
        ad = self.make(fake)
        with self.assertRaises(A.AbortRun) as cm:
            ad.preflight()
        self.assertIn('gpu_fit_skip', str(cm.exception))
        self.assertIn(why, ad.last_preflight['gpu_fit']['reason'])
        self.assertFalse(ad.last_preflight['gpu_fit']['full_gpu'])
        self.assertTrue(ad.loaded_by_us)                       # this run loaded it, so the cleanup must unload it
        fin = ad.finish()
        self.assertTrue(fin['unloaded'])
        self.assertIn(('/api/generate', {'model': 'qwen3.8:27b', 'keep_alive': 0, 'stream': False}), fake.calls)
        self.assertEqual(fake.resident, [])
        self.assertFalse([c for c in fake.calls if c[0] == '/api/chat'])        # no case call

    def test_any_cpu_offload_or_unreadable_state_skips_and_unloads(self):
        self.assert_skip(FakeOllama(ps_after=ps_row(size_vram=SIZE - 1)), 'part of the model is on the CPU')
        self.assert_skip(FakeOllama(ps_after=ps_row(size_vram=0)), 'part of the model is on the CPU')
        self.assert_skip(FakeOllama(ps_after=ps_row(size_vram=None)), 'does not report size and size_vram')
        self.assert_skip(FakeOllama(ps_unreadable=True), 'cannot read /api/ps')
        self.assert_skip(FakeOllama(ps_after=ps_row() + [{'name': 'other:7b', 'size': 1, 'size_vram': 1}]), 'expected exactly this run')
        self.assert_skip(FakeOllama(ps_after=[]), 'expected exactly this run')
        self.assert_skip(FakeOllama(ps_after=ps_row(context_length=8192)), 'below the requested num_ctx')

    def test_the_check_needs_the_warm_up_and_a_known_version(self):
        with self.assertRaises(ValueError):
            self.make(FakeOllama(), do_warmup=False)
        with self.assertRaises(ValueError):
            adapter(FakeOllama(), options={'num_ctx': 8192}, gpu_fit_check='full-gpu-v9')

    def test_main_records_the_skip_and_runs_no_case(self):
        case = th.make_case(id='w23-g1')
        ts = th.TempSuite([case])
        fake = FakeOllama(ps_after=ps_row(size_vram=SIZE // 2))
        orig = R.build_adapter
        R.build_adapter = lambda args: adapter(fake, options={'num_ctx': args.num_ctx, 'num_predict': 640}, context_policy=args.context_policy,
                                               gpu_fit_check=args.gpu_fit_check)
        try:
            out = Path(tempfile.mkdtemp()) / 'r-g1'
            code = R.main(['--suite', str(ts.root), '--adapter', 'ollama', '--model', 'qwen3.8:27b', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--num-ctx', '16384', '--context-policy', 'ctx16k-v1',
                           '--gpu-fit-check', 'full-gpu-v1', '--max-wall-s', '2700', '--no-spend-limit'])
        finally:
            R.build_adapter = orig
        man = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(code, 3)
        self.assertIn('gpu_fit_skip', man['aborted'])
        self.assertEqual(man['preflight']['gpu_fit']['gpu_fraction'], 0.5)
        self.assertTrue(man['finish']['unloaded'])
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), ([], [], ['w23-g1']))
        self.assertEqual(man['config']['adapter_config']['context_policy'], 'ctx16k-v1')
        ts.cleanup()



class GpuFitReloads(unittest.TestCase):
    """Amendment 1, Opus P2: full-gpu-v2 re-reads /api/ps whenever a case call reports a reload (load_duration above 1 s, or none); each test fails at 5f71b6d3,
    where full-gpu-v2 does not exist and the check ran only once."""

    def make(self, fake, check='full-gpu-v2'):
        return adapter(fake, options={'num_ctx': 16384, 'num_predict': 640}, context_policy='ctx16k-v1', gpu_fit_check=check)

    def chat(self, ad):
        return ad.complete('s', [{'role': 'user', 'content': 'x'}])

    def test_a_reload_partly_on_the_cpu_aborts_and_unloads(self):
        fake = FakeOllama(ps_after=ps_row(), chat_loads=[2_000_000, 7_000_000_000], ps_after_reload=ps_row(size_vram=SIZE - 4096))
        ad = self.make(fake)
        ad.preflight()
        first = self.chat(ad)
        self.assertNotIn('gpu_refit', first.meta)                         # 2 ms: no reload, no extra read
        self.assertEqual(sum(1 for c in fake.calls if c[0] == '/api/ps'), 2)
        with self.assertRaises(A.AbortRun) as cm:
            self.chat(ad)
        self.assertIn('gpu_fit_abort (full-gpu-v2)', str(cm.exception))
        fc = cm.exception.failed_call
        self.assertEqual((fc['failure_modes'], fc['gpu_refit']['load_duration_ns'], fc['gpu_refit']['gpu_fit']['full_gpu']), (['gpu_reload_not_full_gpu'], 7_000_000_000, False))
        self.assertTrue(ad.finish()['unloaded'])
        self.assertEqual(fake.resident, [])
        self.assertEqual(len(ad.gpu_refits), 1)

    def test_a_reload_fully_on_the_gpu_continues_and_is_recorded(self):
        fake = FakeOllama(ps_after=ps_row(), chat_loads=[3_000_000_000], ps_after_reload=ps_row())
        ad = self.make(fake)
        ad.preflight()
        comp = self.chat(ad)
        self.assertTrue(comp.meta['gpu_refit']['gpu_fit']['full_gpu'])
        self.assertEqual(ad.finish()['gpu_refits'][0]['load_duration_ns'], 3_000_000_000)

    def test_a_call_that_reports_no_load_duration_is_checked(self):
        fake = FakeOllama(ps_after=ps_row(), chat_loads=['omit'], ps_after_reload=ps_row(size_vram=0))
        ad = self.make(fake)
        ad.preflight()
        fake.reloaded = True
        with self.assertRaises(A.AbortRun):
            self.chat(ad)

    def test_the_boundary_is_one_second_and_v1_never_rereads(self):
        fake = FakeOllama(ps_after=ps_row(), chat_loads=[1_000_000_000], ps_after_reload=ps_row(size_vram=0))
        ad = self.make(fake)
        ad.preflight()
        self.assertNotIn('gpu_refit', self.chat(ad).meta)                 # exactly 1 s is not above 1 s
        fake = FakeOllama(ps_after=ps_row(), chat_loads=[9_000_000_000], ps_after_reload=ps_row(size_vram=0))
        ad = self.make(fake, 'full-gpu-v1')                               # v1 unchanged: one reading after the warm-up, none at a call
        ad.preflight()
        comp = self.chat(ad)
        self.assertNotIn('gpu_refit', comp.meta)
        self.assertEqual(sum(1 for c in fake.calls if c[0] == '/api/ps'), 2)
        self.assertNotIn('gpu_refits', ad.finish())

    def test_main_keeps_the_case_started_aborted_and_exits_3(self):
        cases = [th.make_case(id='w23-r1'), th.make_case(id='w23-r2')]
        ts = th.TempSuite(cases)
        fake = FakeOllama(ps_after=ps_row(), chat_loads=[2_000_000, 8_000_000_000], ps_after_reload=ps_row(size_vram=SIZE // 3))
        orig = R.build_adapter
        R.build_adapter = lambda args: adapter(fake, options={'num_ctx': args.num_ctx, 'num_predict': 640}, context_policy=args.context_policy,
                                               gpu_fit_check=args.gpu_fit_check)
        try:
            out = Path(tempfile.mkdtemp()) / 'r-r1'
            code = R.main(['--suite', str(ts.root), '--adapter', 'ollama', '--model', 'qwen3.8:27b', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--num-ctx', '16384', '--context-policy', 'ctx16k-v1',
                           '--gpu-fit-check', 'full-gpu-v2', '--max-wall-s', '2700', '--no-spend-limit'])
        finally:
            R.build_adapter = orig
            ts.cleanup()
        man = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(code, 3)
        self.assertIn('gpu_fit_abort', man['aborted'])
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), (['w23-r1'], ['w23-r2'], []))
        part = json.loads((out / 'started-aborted' / 'w23-r2.json').read_text())
        self.assertEqual(part['turns'][-1]['failure_modes'], ['gpu_reload_not_full_gpu'])
        self.assertFalse(part['turns'][-1]['gpu_refit']['gpu_fit']['full_gpu'])
        self.assertTrue(man['finish']['unloaded'])
        self.assertEqual(len(man['finish']['gpu_refits']), 1)
        self.assertEqual(man['config']['adapter_config']['gpu_fit_check'], 'full-gpu-v2')

class CommandLine(unittest.TestCase):

    def run_main(self, *extra, adapter='scripted'):
        case = th.make_case(id='w23-c1')
        ts = th.TempSuite([case])
        script = Path(tempfile.mkdtemp()) / 's.json'
        script.write_text(json.dumps([json.dumps(ESCALATE)]))
        try:
            return R.main(['--suite', str(ts.root), '--adapter', adapter, '--model', 'm', '--out', str(Path(tempfile.mkdtemp()) / 'r'), '--script', str(script),
                           '--scratch', tempfile.mkdtemp(), '--prompt', 'v7', '--evidence-format', 'v3.1-format'] + list(extra))
        finally:
            ts.cleanup()

    def test_contradictions_are_refused_before_anything_runs(self):
        for extra, adapter_name in ((['--num-ctx', '16384'], 'ollama'), (['--context-policy', 'ctx16k-v1'], 'ollama'),
                                    (['--context-policy', 'ctx16k-v1', '--num-ctx', '8192'], 'ollama'),
                                    (['--context-policy', 'ctx16k-v1', '--num-ctx', '16384'], 'claude'),
                                    (['--gpu-fit-check', 'full-gpu-v1'], 'codex'),
                                    (['--context-policy', 'ctx16k-v1', '--num-ctx', '16384', '--gpu-fit-check', 'full-gpu-v1', '--no-warmup'], 'ollama')):
            with self.assertRaises(SystemExit, msg=str(extra)):
                self.run_main(*extra, adapter=adapter_name)
        with self.assertRaises(SystemExit):
            R.build_parser().parse_args(['--suite', 'x', '--adapter', 'ollama', '--model', 'm', '--out', 'o', '--num-ctx', '12000'])

    def test_the_registered_qwen_command_parses_to_the_policy(self):
        args = R.build_parser().parse_args(['--adapter', 'ollama', '--model', 'qwen3.8:27b', '--suite', 'S', '--split', 'dev', '--prompt', 'v7',
                                            '--evidence-format', 'v3.1-format', '--guards', 'v3', '--evidence', 'replay', '--num-ctx', '16384',
                                            '--context-policy', 'ctx16k-v1', '--gpu-fit-check', 'full-gpu-v1', '--tool-output-bytes', '8192',
                                            '--keep-alive', '2m', '--max-wall-s', '2700', '--require-digest', 'abc', '--no-spend-limit', '--out', 'O'])
        ad = R.build_adapter(args)
        cfg = ad.config()
        self.assertEqual((cfg['options']['num_ctx'], cfg['options']['num_predict'], cfg['context_policy'], cfg['gpu_fit_check'], cfg['warmup_timeout_s'],
                          cfg['call_timeout_s'], cfg['keep_alive'], cfg['think'], cfg['options']['use_mmap']),
                         (16384, 640, 'ctx16k-v1', 'full-gpu-v1', 900, 120, '2m', False, False))
        self.assertEqual(ad.cleanup_reserve_s, 180)
        conf = R.run_config(args, ad, {}, None)
        self.assertEqual((conf['tool_output_bytes'], conf['wire_bytes'], conf['evidence_format'], conf['spend_limit'], conf['limits']),
                         (8192, 8192, 'v3.1-format', 'uncapped', {'max_total_cost_usd': None, 'max_wall_s': 2700.0}))



class OfflineEvidence(unittest.TestCase):
    """The committed offline GPU-fit estimate is what the script computes from the recorded dev-c6 metadata (no Ollama call)."""

    def test_gpu_fit_offline_json_is_reproducible(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('mrh_devc7_gpu_fit', th.COMPONENT / 'scripts' / 'devc7_gpu_fit.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = Path(tempfile.mkdtemp()) / 'fit.json'
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--out', str(out)])
        self.assertEqual(out.read_text(), (RUNS / 'dev-c7' / 'gpu-fit-offline.json').read_text())
        fit = json.loads(out.read_text())
        self.assertTrue(fit['estimate']['assumed_layout']['fits'])
        self.assertEqual(fit['num_ctx'], 16384)


class RegisteredCommands(unittest.TestCase):
    """The three registered dev-c7 commands (runs/dev-c7/manifest-template.json) rebuild their pre-registered config_hash offline: a change to anything the
    config records (code, prompt, flags) fails here and needs a numbered amendment."""

    def test_expected_config_hashes(self):
        tpl = json.loads((RUNS / 'dev-c7' / 'manifest-template.json').read_text())
        for name, run in tpl['runs'].items():
            args = R.build_parser().parse_args(run['argv'])
            cfg = R.run_config(args, R.build_adapter(args), {}, None)
            self.assertEqual(R.sha256_bytes(R.canonical(cfg).encode()), run['expected_config_hash'], name)
        self.assertEqual(tpl['order'], ['qwen', 'haiku', 'astra'])

if __name__ == '__main__':
    unittest.main()
