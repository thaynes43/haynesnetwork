"""Contract v3 (WO-W20) baseline identity: the experimental prototypes change nothing that exists.

* No production module imports `media_repair_harness.experimental` except `evidence_v3`, the one module that wires contract v3 into the runner (dev-c6); the runner
  imports it only for a run that selects `--evidence-format v3` (with `--prompt v6`), so every other configuration never loads the prototypes.
* The committed baseline manifests are pinned byte for byte (dev-c5 both views, dev-c4 fresh runs).
* dev-c5, re-rendered offline: every recorded case is re-run through the UNCHANGED runner with the model's recorded replies played back (no model
  call); every request sent (system text, the user messages, the Ollama schema) equals the recorded raw request, and the decision, guard outcome,
  reference resolution and action audit equal the record.  This compares rendered requests, resolution and guard outcomes, not archived files.
* dev-c4 (the 221 committed records and the evaluator's 880 public dev-c4-v1.1 records = 1101): the guards re-applied offline (or the restore,
  for a restored view) reproduce each record's guard field and decision.
Serial, offline, no binaries (`which` finds nothing), no network."""
import ast
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import th
from media_repair_harness import adapters as A
from media_repair_harness import decision_guard as DG
from media_repair_harness import run as R

SRC = th.COMPONENT / 'src' / 'media_repair_harness'
RUNS = th.COMPONENT / 'runs'
H = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
SUITE_V11 = H / 'suite-dev-v1.1'
EVAL_DEV_C4 = H / 'evaluation' / 'dev-c4-v1.1' / 'runs'
MANIFESTS = {
    'dev-c5/devc5-b-haiku-5-5/manifest.json': '364df98324a5c91ad0cc134085bb279d173c9ab1b70ba7f87c124fcbcbbf198b',
    'dev-c5/devc5-b-haiku-5-5-restored/manifest.json': '735ab51888a0b356980cfff8fbfd6cd5f81748d794a484b600a263501480215c',
    'dev-c5/devc5-b-qwen3.8-27b/manifest.json': 'ecc8a61a1309191b1210e9c80754775df7192e295da3624440deaf18d44e66b2',
    'dev-c5/devc5-b-qwen3.8-27b-restored/manifest.json': '982cbd1fdc03372196a880df0b3e68c540e240e82c4fb5fe1c85b5d75d27de1c',
    'dev-c4/devc4-v4g-haiku-5-5/manifest.json': '4f9f5c3ad45d90680fe0507a772b2b715f5faccbae017bcb858442910ef3f16d',
    'dev-c4/devc4-v4g-muse-glimmer-30b/manifest.json': '54f61f2eb6755d406caec0aa8778724019fdf3bda799214462cba1d5197c3c8b',
    'dev-c4/devc4-v4g-qwen3.8-27b/manifest.json': '72aa1c62a9bd3af0cc49065bdb57e330a746b4e28f01b8b15dc2e99755d729f6',
}
DEV_C5 = ('devc5-b-haiku-5-5', 'devc5-b-qwen3.8-27b')


def need_v11():
    if not (SUITE_V11 / 'cases').is_dir():
        import os
        msg = 'public dev suite v1.1 not found at %s' % SUITE_V11
        if os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError(msg)
        raise unittest.SkipTest(msg)


def load_case(case_id, sha):
    raw = (SUITE_V11 / 'cases' / (case_id + '.json')).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == sha, case_id
    return json.loads(raw)


class Replay(A.ScriptedAdapter):
    """Plays the recorded replies back and keeps everything it was sent."""

    def __init__(self, model, replies):
        super().__init__(model, replies)
        self.sent = []

    def complete(self, system, messages, schema=None):
        self.sent.append({'system': system, 'messages': json.loads(json.dumps(messages)), 'schema': json.loads(json.dumps(schema)) if schema is not None else None})
        return super().complete(system, messages, schema)


WIRING_MODULE = 'evidence_v3.py'     # dev-c6: the one production module that imports the contract-v3 modules


class NoProductionImport(unittest.TestCase):
    def test_no_module_outside_experimental_imports_it(self):
        for p in sorted(SRC.rglob('*.py')):
            if 'experimental' in p.parts or p.name == WIRING_MODULE:
                continue
            tree = ast.parse(p.read_text())
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [(node.module or '')] + [a.name for a in node.names]
                self.assertFalse(any('experimental' in n for n in names), p.name)

    def test_label_tension_notes_are_never_a_renderer_input(self):
        for p in sorted(SRC.rglob('*.py')):
            text = p.read_text()
            self.assertNotIn('label-tension', text, p.name)
            self.assertNotIn('label_tension', text, p.name)
        for p in sorted((SRC / 'experimental' / 'contract_v3').glob('*.py')):
            text = p.read_text()
            self.assertNotIn('open(', text.replace('_open(', ''), p.name)     # the prototypes read no file: their inputs are arguments

    def test_the_runner_offers_v3_only_as_contract_v3_with_prompt_v6(self):
        # dev-c6 replaced `test_the_runner_offers_no_v3_option`: format v3 is now selectable, but only as one version with prompt v6
        self.assertEqual(R.EVIDENCE_FORMATS, ('v2', 'v3'))
        for pv in ('v1', 'v2', 'v3', 'v4', 'v5'):
            with self.assertRaises(ValueError):
                R.check_option_combination(pv, 'v3')
        R.check_option_combination('v6', 'v3')

    def test_a_run_without_format_v3_never_imports_the_prototypes(self):
        import subprocess
        import sys
        code = ('import sys, media_repair_harness.run as r, media_repair_harness.guard_cli, media_repair_harness.score_compat; '
                'print(sorted(m for m in sys.modules if "experimental" in m or m.endswith("evidence_v3")))')
        out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, env=dict(__import__('os').environ, PYTHONPATH=str(SRC.parent)))
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), '[]')


class PinnedManifests(unittest.TestCase):
    def test_baseline_manifests_are_byte_identical(self):
        for rel, sha in MANIFESTS.items():
            self.assertEqual(hashlib.sha256((RUNS / rel).read_bytes()).hexdigest(), sha, rel)

    def test_dev_c5_failed_result_is_kept(self):
        for run in DEV_C5:
            score = json.loads((RUNS / 'dev-c5' / run / 'score.json').read_text())
            self.assertIn('overall', json.dumps(score).lower())
            self.assertEqual(len(list((RUNS / 'dev-c5' / run).glob('*-*-*.json'))), 73, run)


class DevC5ReRendered(unittest.TestCase):
    """Every dev-c5 request, re-rendered offline by the unchanged code, equals the recorded raw request; the guard outcome and resolution agree."""

    @classmethod
    def setUpClass(cls):
        need_v11()

    def rerun(self, rec):
        case = load_case(rec['case_id'], rec['case_sha256'])
        ad = Replay(rec['requested_model'], [t['text'] for t in rec['turns']])
        new = R.run_case(case, rec['case_sha256'], ad, SUITE_V11, tempfile.mkdtemp(prefix='mrh-w20-'), run_id=rec['run_id'], prompt_version='v5',
                         evidence_format='v2', guards='v3', replay='auto', which=th.NO_BINARIES, tool_output_bytes=8192)
        return new, ad

    def test_requests_decisions_guards_and_resolution_are_reproduced(self):
        from media_repair_harness import tools as T
        n_req = n_rec = skipped = 0
        for run in DEV_C5:
            for p in sorted((RUNS / 'dev-c5' / run).glob('*-*-*.json')):
                rec = json.loads(p.read_text())
                case = load_case(rec['case_id'], rec['case_sha256'])
                if T.Fixture.from_case(case, SUITE_V11).verify_local() != rec['fixture']:
                    skipped += 1        # a fixture outside git (a pod-local cache) is not in this checkout: the advertisement legitimately differs here
                    continue
                n_rec += 1
                new, ad = self.rerun(rec)
                self.assertEqual(len(ad.sent), len(rec['turns']), p.name)
                for sent, turn in zip(ad.sent, rec['turns']):
                    raw = turn['raw_request']
                    if 'prompt' in raw:          # the claude CLI: one flattened transcript
                        self.assertEqual(sent['system'], raw['system_prompt'], p.name)
                        self.assertEqual(A.render_transcript(sent['messages']), raw['prompt'], p.name)
                    else:                        # ollama: system + messages + the per-case schema
                        self.assertEqual([{'role': 'system', 'content': sent['system']}] + sent['messages'], raw['messages'], p.name)
                        self.assertEqual(sent['schema'], raw['format'], p.name)
                    n_req += 1
                for key in ('decision', 'guard', 'bad_evidence_refs', 'refs_to_failed_tools', 'refs_to_non_ok_tools', 'decision_flags', 'unverified_parts', 'forced'):
                    self.assertEqual(new.get(key), rec.get(key), (p.name, key))
                aa_new, aa_rec = dict(new['action_audit']), dict(rec['action_audit'])
                self.assertEqual(aa_new, aa_rec, p.name)
                for key in ('capabilities', 'messages', 'final_summary', 'wire_bytes', 'audit_version', 'tools_behavior'):
                    self.assertEqual(new['evidence_format'][key], rec['evidence_format'][key], (p.name, key))
                strip = lambda calls: [{k: v for k, v in c.items() if k != 'wall_s'} for c in calls]
                self.assertEqual(strip(new['tool_calls']), strip(rec['tool_calls']), p.name)
        self.assertEqual(n_rec + skipped, 146)
        self.assertGreaterEqual(n_rec, 120, (n_rec, skipped))    # every record whose fixture this checkout has (all 146 on the pod that recorded them)
        self.assertGreater(n_req, n_rec)


class DevC4GuardOutcomes(unittest.TestCase):
    """1101 dev-c4 records: re-applying the record's own guard version offline (or restoring, for a restored view) reproduces it."""

    @classmethod
    def setUpClass(cls):
        need_v11()

    def records(self):
        dirs = sorted((RUNS / 'dev-c4').glob('devc4-v4g-*')) + sorted(EVAL_DEV_C4.glob('evaldevc4v11-*'))
        for d in dirs:
            for p in sorted(d.glob('*-*-*.json')):
                yield d.name, p, json.loads(p.read_text())

    def test_guard_outcomes_are_reproduced(self):
        n = 0
        for run, p, rec in self.records():
            case = load_case(rec['case_id'], rec['case_sha256'])
            shown = R.resolve_evidence(case, SUITE_V11)
            g = rec.get('guard')
            self.assertIsNotNone(g, p)
            if g.get('restored'):
                again = DG.restore_original(rec, case, shown)
            else:
                again = DG.apply_to_record(rec, case, shown, g['version'])
            self.assertEqual(again['decision'], rec['decision'], (run, p.name))
            self.assertEqual(again['guard'], rec['guard'], (run, p.name))
            self.assertEqual(again['action_audit'], rec['action_audit'], (run, p.name))
            n += 1
        self.assertEqual(n, 1101)


if __name__ == '__main__':
    unittest.main()
