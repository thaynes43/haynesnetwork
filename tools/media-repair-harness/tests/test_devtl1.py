"""dev-tl1 pre-registration (OpenProject #208): the registered commands rebuild their pre-registered `config_hash` offline, through the runner's own `main()`
with the adapters' preflight stubbed (scripts/devtl1_config.py), and the frozen facts in runs/dev-tl1/manifest-template.json still hold.  No model, no GPU, no
network, no kubectl."""
import hashlib
import importlib.util
import json
import unittest

import th
from media_repair_harness import protocol as P
from media_repair_harness import run as R

RUNS = th.COMPONENT / 'runs'
TEMPLATE = RUNS / 'dev-tl1' / 'manifest-template.json'
DEVC7_QWEN_R2 = RUNS / 'dev-c7-qwen-r2' / 'devc7r2-qwen3.8-27b' / 'manifest.json'


def load_script():
    spec = importlib.util.spec_from_file_location('mrh_devtl1_config', th.COMPONENT / 'scripts' / 'devtl1_config.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@th.needs_suite
class RegisteredCommands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.D = load_script()
        cls.tpl = json.loads(TEMPLATE.read_text())
        cls.built = {rid: cls.D.config_hash(opts) for rid, opts in cls.D.REGISTERED.items()}

    def test_expected_config_hashes(self):
        self.assertEqual(sorted(self.built), sorted(self.tpl['runs']))
        for rid, (h, _cfg) in self.built.items():
            self.assertEqual(h, self.tpl['runs'][rid]['expected_config_hash'], rid)
            self.assertEqual(len(h), 64)
        self.assertEqual(len({h for h, _ in self.built.values()}), 4)

    def test_smoke_hash_and_its_only_difference(self):
        h, cfg = self.D.config_hash(self.D.SMOKE, self.D.TESTDATA)
        self.assertEqual(h, self.tpl['smoke']['expected_config_hash'])
        must = self.built['devtl1-muse-glimmer-30b-mustask'][1]
        self.assertEqual([k for k in sorted(set(cfg) | set(must)) if cfg.get(k) != must.get(k)], ['limits'])
        self.assertEqual((cfg['limits']['max_wall_s'], must['limits']['max_wall_s']), (300.0, 3600.0))

    def test_the_four_commands_differ_only_in_adapter_and_handover(self):
        for model in ('qwen3.8-27b', 'muse-glimmer-30b'):
            handed, ask = self.built['devtl1-%s-handed' % model][1], self.built['devtl1-%s-mustask' % model][1]
            self.assertNotIn('evidence_handover', handed)           # `full` keeps the config shape of every earlier run
            self.assertEqual(ask['evidence_handover'], {'mode': 'askable', 'serve': 'recorded-first', 'version': 'handover-1'})
            self.assertEqual([k for k in sorted(set(handed) | set(ask)) if handed.get(k) != ask.get(k)], ['evidence_handover'])
        q, m = self.built['devtl1-qwen3.8-27b-handed'][1], self.built['devtl1-muse-glimmer-30b-handed'][1]
        self.assertEqual([k for k in sorted(set(q) | set(m)) if q.get(k) != m.get(k)], ['adapter_config'])
        a = self.D.REGISTERED
        self.assertEqual(a['devtl1-qwen3.8-27b-mustask'], a['devtl1-qwen3.8-27b-handed'] + ['--evidence-handover', 'askable'])
        self.assertEqual(a['devtl1-muse-glimmer-30b-mustask'], a['devtl1-muse-glimmer-30b-handed'] + ['--evidence-handover', 'askable'])

    def test_shared_configuration_is_dev_c7s(self):
        for rid, (_h, cfg) in self.built.items():
            self.assertEqual((cfg['prompt_version'], cfg['evidence_format'], cfg['guards'], cfg['evidence_mode'], cfg['replay'], cfg['tool_output_bytes'],
                              cfg['wire_bytes'], cfg['spend_limit'], cfg['limits']['max_wall_s'], cfg['max_tool_calls']),
                             ('v7', 'v3.1-format', 'v3', 'replay', 'auto', 8192, 8192, 'uncapped', 3600.0, 6), rid)
            self.assertEqual(cfg['system_prompt_sha256'], self.tpl['prompt']['assembled_sha256'])
            for key, want in self.tpl['contract'].items():
                if key in cfg:
                    self.assertEqual(cfg[key], want, key)

    def test_qwen_handed_equals_the_dev_c7_qwen_config_but_for_version_and_cap(self):
        """The handed qwen arm is the dev-c7 qwen registration on today's code: only harness_version and the wall cap differ from what dev-c7-qwen-r2 recorded."""
        ref = json.loads(DEVC7_QWEN_R2.read_text())['config']
        cfg = self.built['devtl1-qwen3.8-27b-handed'][1]
        self.assertEqual([k for k in sorted(set(cfg) | set(ref)) if cfg.get(k) != ref.get(k)], ['harness_version', 'limits'])
        self.assertEqual((ref['harness_version'], cfg['harness_version'], ref['limits']['max_wall_s']), ('dev-c7', P.HARNESS_VERSION, 2700.0))
        self.assertEqual(cfg['adapter_config']['options']['num_ctx'], 16384)
        self.assertEqual(cfg['adapter_config']['gpu_fit_check'], 'full-gpu-v2')

    def test_muse_adapter_config(self):
        ad = self.built['devtl1-muse-glimmer-30b-mustask'][1]['adapter_config']
        self.assertEqual((ad['adapter'], ad['adapter_version'], ad['model'], ad['options'], ad['endpoint']['target'], ad['endpoint']['container']),
                         ('llamacpp', 'llamacpp-1', 'muse-glimmer-30b', {'cache_prompt': False, 'max_tokens': 640, 'seed': 42, 'temperature': 0},
                          'deploy/llama-server', 'app'))

    def test_the_runner_refuses_what_the_registration_does_not_use(self):
        """The offline build is the runner's real main(): a flag the llamacpp adapter does not take is refused with the runner's message."""
        with self.assertRaises(SystemExit):
            self.D.config_hash(self.D.MUSE + ['--num-ctx', '16384', '--context-policy', 'ctx16k-v1'] + self.D.COMMON)


class FrozenFacts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tpl = json.loads(TEMPLATE.read_text())

    def test_prompt_and_harness(self):
        self.assertEqual(self.tpl['harness_version'], P.HARNESS_VERSION)
        prompt = P.get_prompt('v7')
        self.assertEqual(prompt['sha256'], self.tpl['prompt']['assembled_sha256'])
        data = (th.COMPONENT / 'src' / 'media_repair_harness' / 'prompts' / 'v7.txt').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), self.tpl['prompt']['file_sha256'])

    @th.needs_suite
    def test_suite_and_cases(self):
        suite = th.REPO_ROOT / self.tpl['suite']['path']
        self.assertEqual(hashlib.sha256((suite / 'manifest.json').read_bytes()).hexdigest(), self.tpl['suite']['manifest_sha256'])
        cases = R.load_cases(str(suite), split='dev')
        ids = [c['id'] for c, _ in cases]
        self.assertEqual((len(ids), ids), (73, self.tpl['suite']['case_ids_in_order']))
        self.assertEqual(hashlib.sha256('\n'.join(ids).encode()).hexdigest(), self.tpl['suite']['case_order_sha256'])
        self.assertEqual(hashlib.sha256(json.dumps({c['id']: s for c, s in cases}, sort_keys=True).encode()).hexdigest(),
                         self.tpl['suite']['case_sha256_table_sha256'])

    def test_handover_counts_equal_the_reachability_table(self):
        reach = json.loads((th.COMPONENT / 'docs' / 'must-ask-reachability.json').read_text())
        h = self.tpl['handover']
        self.assertEqual(hashlib.sha256((th.COMPONENT / 'docs' / 'must-ask-reachability.json').read_bytes()).hexdigest(), h['reachability_json_sha256'])
        differ = [c for c in reach['cases'] if c['askable_withheld']]
        same = [c['case'] for c in reach['cases'] if not c['askable_withheld']]
        self.assertEqual((len(differ), len(same), len(reach['cases'])), (62, 11, 73))
        self.assertEqual((h['cases_where_the_arms_differ'], h['cases_identical_in_both_arms'], h['identical_case_ids']), (62, 11, same))
        self.assertEqual(sum(len(c['askable_withheld']) for c in differ), h['withheld_entries_in_differing_cases'])
        self.assertEqual(h['withheld_entries_in_differing_cases'], 162)
        self.assertEqual(h['entries_kept_in_first_message_in_must_ask'], 14)
        ident = sorted(c['case'] for c in differ if c['truth_class'] == 'identity_mismatch')
        self.assertEqual((ident, len(ident)), (h['identity_mismatch_cases_that_differ'], 9))
        self.assertEqual(h['all_cases_by_class']['identity_mismatch'], 14)
        self.assertEqual([c['case'] for c in differ if c['status'] == 'partially_reachable'], h['partially_reachable_cases'])
        # the 11 identical-input cases are exactly the ones that carry only a prior_record and offer no tool
        for c in reach['cases']:
            if c['case'] in same:
                self.assertEqual((c['tools_offered'], c['askable_kept']), ([], ['e1']), c['case'])

    def test_muse_benchmark_args_change_only_what_the_registration_says(self):
        m = self.tpl['muse_runtime']
        voice, bench = m['voice_args_at_registration'], m['benchmark_args']
        self.assertEqual(voice[voice.index('--ctx-size') + 1], '131072')
        self.assertEqual((bench[bench.index('--ctx-size') + 1], bench[bench.index('--parallel') + 1], bench[bench.index('--reasoning-budget') + 1]), ('16384', '1', '0'))
        self.assertNotIn('--reasoning-effort', bench)
        self.assertEqual(bench[bench.index('--alias') + 1], 'muse-glimmer-30b')
        self.assertEqual(voice[voice.index('-m') + 1], bench[bench.index('-m') + 1])
        strip = lambda args: [a for a in args if a not in ('131072', '16384', '--reasoning-effort', 'low', '--reasoning-budget', '0', '2', '1')]
        self.assertEqual(strip(voice), strip(bench))
        self.assertEqual(m['expected_props']['total_slots'], 1)
        self.assertEqual(m['expected_props']['default_generation_settings.n_ctx'], 16384)


if __name__ == '__main__':
    unittest.main()
