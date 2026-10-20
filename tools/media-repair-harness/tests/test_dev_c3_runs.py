"""Consistency checks on the committed dev-c3 measurement runs (tools/media-repair-harness/runs/dev-c3/): the records are what the run summary and the
score say they are.  Data checks only; nothing here re-scores, calls a model or asserts a pass rate."""
import json
import unittest
from pathlib import Path

from media_repair_harness import protocol as P
import th

RUNS = th.COMPONENT / 'runs' / 'dev-c3'
V3_RUNS = ('devc3-v3a-haiku-5-5', 'devc3-v3b-haiku-5-5', 'devc3-v3c-haiku-5-5')
ALL_RUNS = ('devc3-base-haiku-5-5-v2',) + V3_RUNS


def records(run):
    return {p.stem: json.loads(p.read_text()) for p in sorted((RUNS / run).glob('*.json')) if p.name not in ('manifest.json', 'run_summary.json', 'score.json')}


class CommittedRuns(unittest.TestCase):
    def test_four_full_dev_runs_with_one_model_and_a_clean_tree(self):
        for run in ALL_RUNS:
            recs = records(run)
            self.assertEqual(len(recs), 73, run)
            summary = json.loads((RUNS / run / 'run_summary.json').read_text())
            self.assertEqual((summary['requested_model'], summary['response_model_ids']), ('claude-haiku-5-5', ['claude-haiku-5-5']), run)
            self.assertIs(summary['harness_git']['dirty'], False, run)     # every run started from a committed tree
            self.assertEqual((summary['records_written'], summary['cases_planned'], summary['aborted']), (73, 73, None), run)
            self.assertEqual(summary['writes_executed'], 0)
            for rec in recs.values():
                self.assertIs(rec['action_audit']['executed'], False)
                self.assertEqual(rec['requested_model'], 'claude-haiku-5-5')
                self.assertEqual(rec['response_model_ids'], ['claude-haiku-5-5'])
                self.assertEqual(rec['evidence_mode'], 'replay')

    def test_prompt_versions_and_digests_match_the_records(self):
        want = {'devc3-base-haiku-5-5-v2': ('v2', P.get_prompt('v2')['sha256']), 'devc3-v3c-haiku-5-5': ('v3', P.get_prompt('v3')['sha256'])}
        for run, (version, sha) in want.items():
            for rec in records(run).values():
                self.assertEqual((rec['prompt']['version'], rec['prompt']['sha256']), (version, sha), run)
        for run in V3_RUNS:
            for rec in records(run).values():
                self.assertEqual((rec['prompt']['version'], rec['prompt']['protocol']), ('v3', 'turn-v2'), run)
        # the two earlier v3 texts are kept next to the runs, and they are what those runs sent
        import hashlib
        for run, name in (('devc3-v3a-haiku-5-5', 'v3a.txt'), ('devc3-v3b-haiku-5-5', 'v3b.txt'), ('devc3-v3c-haiku-5-5', 'v3c-shipped-as-v3.txt')):
            text = (RUNS / 'prompts' / name).read_text(encoding='utf-8').rstrip('\n')
            sha = hashlib.sha256(text.encode()).hexdigest()
            self.assertEqual({r['prompt']['sha256'] for r in records(run).values()}, {sha}, run)
        self.assertEqual((RUNS / 'prompts' / 'v3c-shipped-as-v3.txt').read_bytes(), (P.PROMPT_DIR / 'v3.txt').read_bytes())

    def test_write_rejection_field_matches_the_scorers_g1_context(self):
        for run in V3_RUNS:
            score = json.loads((RUNS / run / 'score.json').read_text())
            want = sorted(score['g1_context']['rejected_write_attempts']['cases'])
            recs = records(run)
            got = sorted(cid for cid, r in recs.items() for _ in range(r['write_rejection']['rejected_write_attempts']))
            self.assertEqual(got, want, run)
            self.assertEqual(sorted(cid for cid, r in recs.items() if r['write_rejection']['forced_after_rejected_write']), [], run)

    def test_the_baseline_ran_the_unchanged_dev_c2_behaviour(self):
        for rec in records('devc3-base-haiku-5-5-v2').values():
            self.assertEqual(rec['harness_version'], 'dev-c2')
            self.assertNotIn('write_rejection', rec)    # the field arrived in dev-c3; the baseline is main as it was
        self.assertEqual(json.loads((RUNS / 'devc3-base-haiku-5-5-v2' / 'run_summary.json').read_text())['harness_git']['sha'][:8], '4a39d83c')


if __name__ == '__main__':
    unittest.main()
