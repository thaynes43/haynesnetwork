"""dev-c7 qwen re-registered pass (WO-W24, OpenProject #155): the registered command of runs/dev-c7-qwen-r2/manifest-template.json.

It is the dev-c7 qwen command with only the run id, the output directory and the worktree paths changed.  These tests pin that: the expected
config_hash is rebuilt offline and equals the dev-c7 qwen one, the argv differs from dev-c7's only in path values, and the registered command,
built with a stubbed Ollama transport, runs end to end with Ollama 0.40.7 reported.  A digest mismatch skips before anything is loaded, and a
replaced ollama-prime pod aborts the pass.  Fake transports and synthetic cases only: no model, no Ollama endpoint, no network, no GPU."""
import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

import th
from media_repair_harness import protocol as P
from test_devc7_measure import registered_harness_version
from media_repair_harness import guard as G
from media_repair_harness import run as R

RUNS = th.COMPONENT / 'runs'
R2 = RUNS / 'dev-c7-qwen-r2'
DEVC7 = RUNS / 'dev-c7'
H = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
EXPECTED_CONFIG_HASH = '612a2325ee32f06e5cf44afa896047485cbf450b7d712b629ddbabebddbb34de'   # equal to dev-c7 qwen: the config records no path, run id or runtime
DIGEST = 'aaee06c39dcf2437cde036998d960e1fc1494b8191be7cc9657d01e509097813'
SIZE = 17741872154
ESCALATE = {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': 'r', 'confidence': 0.0, 'evidence_refs': []}
PATH_FLAGS = ('--suite', '--out', '--scratch')


def template():
    return json.loads((R2 / 'manifest-template.json').read_text())


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class FakePrime:
    """A stub of ollama_transport.api for the 0.40.7 server: version, tags with the registered digest, /api/ps, warm-up, chat and unload."""

    def __init__(self, digest=DIGEST, version='0.40.7'):
        self.calls, self.resident, self.digest, self.version = [], [], digest, version

    def __call__(self, path, payload=None, timeout=60, **_kw):
        self.calls.append((path, payload))
        if path == '/api/version':
            return {'version': self.version}, {'exit_code': 0}
        if path == '/api/tags':
            return {'models': [{'name': 'qwen3.8:27b', 'digest': self.digest, 'details': {'family': 'qwen35'}, 'size': SIZE}]}, {'exit_code': 0}
        if path == '/api/ps':
            return {'models': [{'name': m, 'size': SIZE, 'size_vram': SIZE, 'context_length': 16384} for m in self.resident]}, {'exit_code': 0}
        if path == '/api/generate':
            if payload.get('keep_alive') == 0:
                self.resident = []
                return {'done': True}, {'exit_code': 0}
            self.resident = [payload['model']]
            return {'done': True, 'load_duration': 5_000_000_000}, {'exit_code': 0}
        if path == '/api/chat':
            return ({'model': payload['model'], 'message': {'content': json.dumps(ESCALATE)}, 'prompt_eval_count': 900, 'eval_count': 30,
                     'done_reason': 'stop', 'load_duration': 1_000_000}, {'exit_code': 0})
        raise AssertionError(path)


class Clock:
    """A guard clock that moves 31 s per reading, so every before_case takes a fresh pod sample (the real interval is 30 s)."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 31.0
        return self.t


def stub_guard(pods=None):
    """The registered PsiGuard (same threshold, interval and count, so the same adapter config) reading fake pod state instead of kubectl."""
    seq = list(pods or [])
    last = {'name': 'ollama-prime-x', 'uid': 'u1', 'container_id': 'c1', 'restarts': 0}

    def read_pod():
        nonlocal last
        if seq:
            last = seq.pop(0)
        return last
    return G.PsiGuard(read_stall=lambda: 0.0, read_pod=read_pod, clock=Clock() if pods else __import__('time').monotonic)


def registered_argv(suite, out, scratch):
    argv = list(template()['run']['argv'])
    for flag, value in zip(PATH_FLAGS, (suite, out, scratch)):
        argv[argv.index(flag) + 1] = str(value)
    return argv


def run_stubbed(fake, guard, n_cases=2):
    """Run the registered command through run.main with the real build_adapter, then swap only the transport, the GPU snapshot and the guard's
    readers for stubs (none of them is in the adapter config)."""
    ts = th.TempSuite([th.make_case(id='w24-c%d' % i) for i in range(1, n_cases + 1)])
    out = Path(tempfile.mkdtemp()) / 'devc7r2-qwen3.8-27b'
    orig = R.build_adapter

    def build(args):
        ad = orig(args)
        ad.api, ad.snapshot, ad.guard = fake, (lambda: {'stdout': 'GPU, 1 MiB', 'compute_processes': '', 'exit_code': 0}), guard
        return ad
    R.build_adapter = build
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), registered_harness_version('dev-c7'):
            code = R.main(registered_argv(ts.root, out, tempfile.mkdtemp()))
    finally:
        R.build_adapter = orig
        ts.cleanup()
    return code, json.loads((out / 'manifest.json').read_text())


class RegisteredCommand(unittest.TestCase):

    def test_expected_config_hash_is_rebuilt_offline_and_equals_dev_c7_qwen(self):
        tpl = template()
        args = R.build_parser().parse_args(tpl['run']['argv'])
        with registered_harness_version('dev-c7'):        # dev-c8: registered under dev-c7; only that label moved (the rest is compared below)
            cfg = R.run_config(args, R.build_adapter(args), {}, None)
        now = R.run_config(args, R.build_adapter(args), {}, None)
        self.assertEqual(now.pop('harness_version'), P.HARNESS_VERSION)
        self.assertEqual(now, {k: v for k, v in cfg.items() if k != 'harness_version'})
        got = R.sha256_bytes(R.canonical(cfg).encode())
        self.assertEqual(got, EXPECTED_CONFIG_HASH)
        self.assertEqual(tpl['run']['expected_config_hash'], EXPECTED_CONFIG_HASH)
        self.assertEqual(json.loads((DEVC7 / 'manifest-template.json').read_text())['runs']['qwen']['expected_config_hash'], EXPECTED_CONFIG_HASH)
        self.assertEqual(json.loads((DEVC7 / 'devc7-qwen3.8-27b' / 'manifest.json').read_text())['config_hash'], EXPECTED_CONFIG_HASH)
        self.assertEqual(cfg['adapter_config']['required_digest'], DIGEST)
        self.assertEqual((cfg['adapter_config']['context_policy'], cfg['adapter_config']['gpu_fit_check'], cfg['adapter_config']['options']['num_ctx']),
                         ('ctx16k-v1', 'full-gpu-v2', 16384))
        self.assertEqual((cfg['spend_limit'], cfg['limits'], cfg['harness_version'], cfg['evidence_format'], cfg['prompt_version']),
                         ('uncapped', {'max_total_cost_usd': None, 'max_wall_s': 2700.0}, 'dev-c7', 'v3.1-format', 'v7'))

    def test_argv_differs_from_dev_c7_qwen_only_in_path_values(self):
        new = template()['run']['argv']
        old = json.loads((DEVC7 / 'manifest-template.json').read_text())['runs']['qwen']['argv']
        self.assertEqual(len(new), len(old))
        changed = {new[i - 1] for i, (a, b) in enumerate(zip(new, old)) if a != b}
        self.assertEqual(changed, set(PATH_FLAGS))
        self.assertEqual(Path(new[new.index('--out') + 1]).name, 'devc7r2-qwen3.8-27b')
        self.assertEqual(Path(new[new.index('--out') + 1]).name, template()['run']['run_id'])
        self.assertTrue(new[new.index('--suite') + 1].endswith('/.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1'))
        self.assertNotIn('--max-budget-usd', new)
        self.assertNotIn('--max-total-cost-usd', new)

    def test_the_stubbed_registered_command_runs_end_to_end_on_0_40_7(self):
        fake = FakePrime()
        code, man = run_stubbed(fake, stub_guard())
        self.assertEqual(code, 0)
        self.assertIsNone(man['aborted'])
        self.assertEqual(man['config_hash'], EXPECTED_CONFIG_HASH)
        self.assertEqual((man['runtime_version'], man['model_digest'], man['run_id']), ('0.40.7', DIGEST, 'devc7r2-qwen3.8-27b'))
        self.assertTrue(man['preflight']['gpu_fit']['full_gpu'])
        self.assertEqual(man['preflight']['residents_before'], [])
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), (['w24-c1', 'w24-c2'], [], []))
        self.assertTrue(man['finish']['unloaded'])
        self.assertEqual(man['finish']['gpu_refits'], [])
        warm = [p for c, p in fake.calls if c == '/api/generate' and p.get('keep_alive') != 0]
        chats = [p for c, p in fake.calls if c == '/api/chat']
        self.assertEqual(len(warm), 1)
        self.assertEqual({(p['options']['num_ctx'], p['options']['num_predict'], p['options']['temperature'], p['options']['seed'], p['options']['use_mmap'],
                           p['keep_alive'], p['think']) for p in chats}, {(16384, 640, 0, 42, False, '2m', False)})
        self.assertEqual(fake.resident, [])                     # unloads only what it loaded, and nothing is left resident

    def test_a_digest_mismatch_skips_before_anything_is_loaded(self):
        fake = FakePrime(digest='sha256:' + '0' * 64)
        code, man = run_stubbed(fake, stub_guard())
        self.assertEqual(code, 3)
        self.assertIn('model digest differs from the frozen one', man['aborted'])
        self.assertEqual([c for c, _ in fake.calls if c in ('/api/generate', '/api/chat')], [])
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), ([], [], ['w24-c1', 'w24-c2']))

    def test_a_replaced_ollama_pod_aborts_the_pass_and_nothing_is_rerun(self):
        a = {'name': 'ollama-prime-a', 'uid': 'u1', 'container_id': 'c1', 'restarts': 0}
        b = {'name': 'ollama-prime-b', 'uid': 'u2', 'container_id': 'c2', 'restarts': 0}
        fake = FakePrime()
        code, man = run_stubbed(fake, stub_guard([a, a, b]), n_cases=3)
        self.assertEqual(code, 3)
        self.assertIn('ollama-prime pod changed under the run', man['aborted'])
        self.assertEqual((man['records_written'], man['started_aborted'], man['never_started']), (['w24-c1'], [], ['w24-c2', 'w24-c3']))
        self.assertEqual(sum(1 for c, p in fake.calls if c == '/api/generate' and p.get('keep_alive') != 0), 1)    # one load, no second attempt


class FrozenInputs(unittest.TestCase):
    """The frozen values the registration restates still hold at this tree, and the 5-case partial dev-c7 qwen run is unchanged."""

    def test_pinned_file_hashes(self):
        tpl = template()
        for rel, want in tpl['pinned_files_sha256'].items():
            path = th.REPO_ROOT / rel
            if rel.startswith('.agents/') and not path.exists() and os.environ.get('MRH_REQUIRE_SUITE') != '1':
                continue
            self.assertEqual(sha256_file(path), want, rel)
        self.assertEqual(tpl['prompt']['file_sha256'], tpl['pinned_files_sha256']['tools/media-repair-harness/src/media_repair_harness/prompts/v7.txt'])

    def test_partial_dev_c7_run_stays_in_the_record_unchanged(self):
        part = template()['partial_dev_c7_qwen_run']
        for rel, want in part['files_sha256'].items():
            self.assertEqual(sha256_file(th.REPO_ROOT / rel), want, rel)
        man = json.loads((DEVC7 / 'devc7-qwen3.8-27b' / 'manifest.json').read_text())
        self.assertEqual((len(man['records_written']), len(man['never_started']), man['runtime_version']), (5, 68, '0.40.6'))

    def test_case_order_and_table(self):
        suite = H / 'suite-dev-v1.1'
        if not (suite / 'cases').is_dir():
            if os.environ.get('MRH_REQUIRE_SUITE') == '1':
                self.fail('suite-dev-v1.1 missing; MRH_REQUIRE_SUITE=1 forbids skipping')
            self.skipTest('suite-dev-v1.1 not present')
        tpl = template()['suite']
        cases = R.load_cases(str(suite), split='dev')
        ids = [c['id'] for c, _ in cases]
        self.assertEqual(ids, tpl['case_ids_in_order'])
        self.assertEqual(hashlib.sha256('\n'.join(ids).encode()).hexdigest(), tpl['case_order_sha256'])
        self.assertEqual(hashlib.sha256(json.dumps({c['id']: s for c, s in cases}, sort_keys=True).encode()).hexdigest(), tpl['case_sha256_table_sha256'])
        self.assertEqual(sha256_file(suite / 'manifest.json'), tpl['manifest_sha256'])


if __name__ == '__main__':
    unittest.main()
