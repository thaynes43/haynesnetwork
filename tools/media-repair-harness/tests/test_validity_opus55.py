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

    def test_amendment1_ceiling_reproduces(self):
        suite = th.require_suite().parent / 'suite-dev-v1.1'
        import importlib.util
        spec = importlib.util.spec_from_file_location('validity_ceiling', SCRIPTS / 'validity_ceiling.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'ceiling-a1.json'
            mod.main(['--suite', str(suite), '--predictions', str(VAL / 'predictions-a1.json'), '--out-json', str(out)])
            got = json.loads(out.read_text())
        want = json.loads((VAL / 'ceiling-a1.json').read_text())
        got.pop('score_py'), want.pop('score_py')
        self.assertEqual(got, want)
        g = want['views']['contract']['gates']
        self.assertEqual((g['G3']['value'], g['G4']['value'], g['G5']['value']), (round(35 / 61, 4), round(13 / 15, 4), round(20 / 49, 4)))
        self.assertEqual(len(want['never_correct_under_contract']), 26)
        # the robust bound: the 11 book-corruption cases alone, escalated with their class, keep G3 <= 50/61 and G5 >= 11/49
        book_c = [c for c, x in want['per_case'].items() if x['truth'] == 'corrupt_file' and c.split('-')[0] in ('audiobook', 'epub')
                  and 'escalate' not in x['supported']]
        self.assertEqual(len(book_c), 11)
        self.assertTrue(all(c in want['never_correct_under_contract'] for c in book_c))

    def test_frozen_original_predictions_unchanged(self):
        self.assertEqual(hashlib.sha256((VAL / 'predictions.json').read_bytes()).hexdigest(),
                         '86b4424a47bd1df658ff90d620ec6738bfd61cebb8a9de7a135eef3a37b67668')
        self.assertEqual(hashlib.sha256((VAL / 'predictions-a1.json').read_bytes()).hexdigest(),
                         '0cfb5d74b52da6eb69abd4793feb439cd414c1c2b9adfc9f7984a8adb74ef260')

    def test_amendment2_ceiling_reproduces(self):
        suite = th.require_suite().parent / 'suite-dev-v1.1'
        import importlib.util
        spec = importlib.util.spec_from_file_location('validity_ceiling', SCRIPTS / 'validity_ceiling.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'ceiling-a2.json'
            mod.main(['--suite', str(suite), '--predictions', str(VAL / 'predictions-a2.json'), '--out-json', str(out)])
            got = json.loads(out.read_text())
        want = json.loads((VAL / 'ceiling-a2.json').read_text())
        got.pop('score_py'), want.pop('score_py')
        self.assertEqual(got, want)
        never = want['never_correct_under_contract']
        self.assertEqual((len(never), sum(want['per_case'][c]['truth'] != 'insufficient_evidence' for c in never)), (26, 24))
        self.assertEqual(json.loads((VAL / 'predictions-a2.json').read_text())['cases']['tv-identity-004']['alt'], [])

    def test_predictions_cover_every_case_once(self):
        suite = th.require_suite().parent / 'suite-dev-v1.1'
        ids = sorted(c['id'] for c, _ in R.load_cases(str(suite)))
        for name in ('predictions.json', 'predictions-a1.json', 'predictions-a2.json'):
            pred = json.loads((VAL / name).read_text())['cases']
            self.assertEqual(sorted(pred), ids, name)
            for cid, p in pred.items():
                self.assertIn(p['status'], ('established', 'ambiguous', 'exploration'), cid)
                self.assertEqual(len(p['cf']), 2, cid)
                keys = set(p.get('requires', {}))
                self.assertTrue(keys <= {'cf'} | {'alt%d' % i for i in range(len(p['alt']))}, (name, cid, keys))


class RenderEquivalence(unittest.TestCase):
    """Pre-go check (Amendment 1, from the Opus pre-measurement review): the real ClaudeAdapter, driven offline by a fake runner (no CLI, no model),
    sends every case's system prompt and first message byte-identical to the dev-c7 Haiku run's turn 0, apart from the run-derived case alias, and an
    argv equal to Haiku's apart from the model id.  A case whose pod-local fixture is absent is skipped (CI runners lack the four EPUBs)."""

    def test_first_messages_equal_haiku(self):
        from media_repair_harness import adapters as A
        suite = str(th.require_suite().parent / 'suite-dev-v1.1')
        haiku = RUNS / 'dev-c7' / 'devc7-haiku-5-5'
        seen = {}

        class Proc:
            def __init__(self, out):
                self.stdout, self.stderr, self.returncode = out, b'', 0

        def runner(cmd, input=None, **kw):
            seen['cmd'] = cmd
            dec = {'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'reason': 'offline render check', 'confidence': 0.5,
                   'evidence_refs': ['e1']}
            return Proc(json.dumps({'type': 'result', 'subtype': 'success', 'result': json.dumps(dec), 'usage': {}, 'modelUsage': {'fake': {}}}).encode())

        ad = A.ClaudeAdapter('claude-opus-5-5', effort=None, max_budget_usd=None, timeout=240, runner=runner)
        same, skipped = 0, []
        with tempfile.TemporaryDirectory() as scratch:
            for case, sha in R.load_cases(suite):
                loc = str((case.get('fixture') or {}).get('path') or (case.get('fixture') or {}).get('locator') or '')
                if loc.startswith('~/') and not Path(loc).expanduser().exists():
                    skipped.append(case['id'])
                    continue
                h = json.loads((haiku / (case['id'] + '.json')).read_text())
                rec = R.run_case(case, sha, ad, suite, scratch, run_id=h['run_id'], tool_output_bytes=8192, prompt_version='v7', evidence_mode='replay',
                                 guards='v3', evidence_format='v3.1-format', replay='auto')
                self.assertEqual(rec['turns'][0]['raw_request']['prompt'], h['turns'][0]['raw_request']['prompt'], case['id'])
                self.assertEqual(rec['turns'][0]['raw_request']['system_prompt'], h['turns'][0]['raw_request']['system_prompt'], case['id'])
                same += 1
        ad.finish()
        import os
        self.assertGreaterEqual(same, 73 if os.environ.get('MRH_VALIDITY_REQUIRE_ALL') == '1' else 69)   # Amendment 2: 73/73 in the run pod
        self.assertEqual(same + len(skipped), 73)
        cmd = list(seen['cmd'])
        hargv = h['turns'][0]['raw_request']['argv']
        cmd[cmd.index('--system-prompt') + 1] = '<system>'
        self.assertEqual([x if x != 'claude-opus-5-5' else 'claude-haiku-5-5' for x in cmd], hargv)


class CallJournalShim(unittest.TestCase):
    """Amendment 1: the pass-through claude shim leaves stdin bytes, stdout, stderr and the exit status unchanged and journals start/end."""
    SHA = '8b54299d0005b981ce4cf4578f22511712b6af3f7ed392cdcfde856f3c414b59'   # Amendment 2: exec, so a timeout kill reaches the CLI

    def test_pinned_and_transparent(self):
        import os
        import subprocess
        shim = SCRIPTS / 'claude_call_journal.sh'
        self.assertEqual(hashlib.sha256(shim.read_bytes()).hexdigest(), self.SHA)
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / 'fake'
            fake.write_text('#!/bin/bash\ncat; echo "args:$#" >&2; exit 7\n')
            fake.chmod(0o755)
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MRH_CLAUDE_REAL': str(fake), 'MRH_CALL_JOURNAL': str(Path(d) / 'j')}
            r = subprocess.run(['bash', str(shim), '-p', '--model', 'x'], input=b'a\x00b\nc', capture_output=True, env=env)
            self.assertEqual((r.returncode, r.stdout, r.stderr), (7, b'a\x00b\nc', b'args:3\n'))
            import time
            for _ in range(50):          # the journal's close line is written by the tee side after stdout closes
                log = (Path(d) / 'j' / 'calls.log').read_text().splitlines()
                if len(log) == 2:
                    break
                time.sleep(0.05)
            self.assertEqual([x.split()[1] for x in log], ['start', 'stdout-closed'])
            outs = list((Path(d) / 'j').glob('out-*.json'))
            self.assertEqual(len(outs), 1)
            self.assertEqual(outs[0].read_bytes(), b'a\x00b\nc')

    def test_timeout_kill_reaches_the_cli(self):
        """The runner kills the process it started on timeout; with exec that process IS the CLI, so no orphaned call keeps running."""
        import os
        import subprocess
        import time
        shim = SCRIPTS / 'claude_call_journal.sh'
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / 'marker'
            slow = Path(d) / 'slow'
            slow.write_text('#!/usr/bin/env python3\nimport time, pathlib\ntime.sleep(2)\npathlib.Path(%r).write_text("late")\n' % str(marker))
            slow.chmod(0o755)
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MRH_CLAUDE_REAL': str(slow), 'MRH_CALL_JOURNAL': str(Path(d) / 'j')}
            with self.assertRaises(subprocess.TimeoutExpired):
                subprocess.run(['bash', str(shim)], input=b'', capture_output=True, env=env, timeout=0.5)
            time.sleep(2.5)
            self.assertFalse(marker.exists())


class Blinding(unittest.TestCase):
    def test_src_never_names_the_answer_material(self):
        for f in (th.COMPONENT / 'src').rglob('*'):
            if f.is_file() and f.suffix in ('.py', '.txt', '.json'):
                text = f.read_text(errors='replace')
                for token in ('predictions.json', 'dev-validity-opus55', 'validity-walkthrough', 'DEVELOPMENT-KNOWLEDGE'):
                    self.assertNotIn(token, text, '%s names %s' % (f, token))


if __name__ == '__main__':
    unittest.main()
