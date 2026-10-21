"""Validity demonstration (#159): the registered blinded Opus 5.5 command rebuilds its pre-registered config_hash offline and differs from the registered
dev-c7 Haiku command only in the model id; the frozen validity ceiling (contract-faithful predictions scored by the unchanged score.py) reproduces; and
nothing under src/ can reach the predictions or the walkthrough (they are never model or harness input).  No model, no network."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import th
from media_repair_harness import run as R

RUNS = th.COMPONENT / 'runs'
VAL = RUNS / 'dev-validity-opus55'
SCRIPTS = th.COMPONENT / 'scripts'


def config_for(argv, suite):
    argv = [suite if x == '$SUITE' else x.replace('$OUT', '/tmp/out') for x in argv]
    args = R.build_parser().parse_args(argv)
    return R.run_config(args, R.build_adapter(args), {}, None)


class RegisteredOpusCommand(unittest.TestCase):
    def test_expected_config_hash_and_only_model_differs(self):
        suite = str(th.require_suite().parent / 'suite-dev-v1.1')
        tpl = json.loads((VAL / 'manifest-template.json').read_text())
        opus = config_for(tpl['argv'], suite)
        self.assertEqual(R.sha256_bytes(R.canonical(opus).encode()), tpl['expected_config_hash'])
        haiku_argv = json.loads((RUNS / 'dev-c7' / 'manifest-template.json').read_text())['runs']['haiku']['argv']
        haiku = config_for(haiku_argv, suite)
        self.assertEqual(R.sha256_bytes(R.canonical(haiku).encode()), tpl['haiku_reference']['expected_config_hash'])
        self.assertEqual(haiku['adapter_config'].pop('model'), 'claude-haiku-5-5')
        self.assertEqual(opus['adapter_config'].pop('model'), 'claude-opus-5-5')
        self.assertEqual(haiku, opus)
        self.assertEqual(opus['system_prompt_sha256'], tpl['system_prompt_sha256'])


class FrozenCeiling(unittest.TestCase):
    def test_ceiling_reproduces(self):
        suite = th.require_suite().parent / 'suite-dev-v1.1'
        import importlib.util
        spec = importlib.util.spec_from_file_location('validity_ceiling', SCRIPTS / 'validity_ceiling.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'ceiling.json'
            mod.main(['--suite', str(suite), '--predictions', str(VAL / 'predictions.json'), '--out-json', str(out)])
            got = json.loads(out.read_text())
        want = json.loads((VAL / 'ceiling.json').read_text())
        got.pop('score_py'), want.pop('score_py')        # an absolute path, checkout-dependent
        self.assertEqual(got, want)
        g = want['views']['contract']['gates']
        self.assertEqual((g['G3']['value'], g['G3']['pass'], g['G5']['value'], g['G5']['pass']), (round(38 / 61, 4), False, round(21 / 49, 4), False))
        self.assertTrue(all(v['pass'] for v in want['views']['label']['gates'].values()))
        self.assertEqual(len(want['never_correct_under_contract']), 22)

    def test_predictions_cover_every_case_once(self):
        suite = th.require_suite().parent / 'suite-dev-v1.1'
        ids = sorted(c['id'] for c, _ in R.load_cases(str(suite)))
        pred = json.loads((VAL / 'predictions.json').read_text())['cases']
        self.assertEqual(sorted(pred), ids)
        for cid, p in pred.items():
            self.assertIn(p['status'], ('established', 'ambiguous', 'exploration'), cid)
            self.assertEqual(len(p['cf']), 2, cid)


class Blinding(unittest.TestCase):
    def test_src_never_names_the_answer_material(self):
        for f in (th.COMPONENT / 'src').rglob('*'):
            if f.is_file() and f.suffix in ('.py', '.txt', '.json'):
                text = f.read_text(errors='replace')
                for token in ('predictions.json', 'dev-validity-opus55', 'validity-walkthrough', 'DEVELOPMENT-KNOWLEDGE'):
                    self.assertNotIn(token, text, '%s names %s' % (f, token))


if __name__ == '__main__':
    unittest.main()
