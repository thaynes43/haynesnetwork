"""Consistency checks on the committed dev-c4 runs (tools/media-repair-harness/runs/dev-c4/): the records are what their run summaries say, every record
carries the guard field, the final decision is the guard's when it fired and the model's original is kept, and the prompt text is the shipped v4.
Data checks only; nothing here re-scores, calls a model or asserts a pass rate."""
import json
import unittest

from media_repair_harness import protocol as P
import th

RUNS = th.COMPONENT / 'runs' / 'dev-c4'
FRESH = {'devc4-v4g-haiku-5-5': 'claude-haiku-5-5', 'devc4-v4g-qwen3.8-27b': 'qwen3.8:27b', 'devc4-v4g-muse-glimmer-30b': 'muse-glimmer:30b'}


def records(run):
    return [json.loads(p.read_text()) for p in sorted((RUNS / run).glob('*-*-*.json'))]


class CommittedRuns(unittest.TestCase):
    def test_fresh_runs_are_73_clean_guarded_v4_records(self):
        for run, model in FRESH.items():
            recs = records(run)
            summary = json.loads((RUNS / run / 'run_summary.json').read_text())
            self.assertEqual(len(recs), 73, run)
            self.assertEqual((summary['requested_model'], summary['response_model_ids'], summary['aborted']), (model, [model], None), run)
            self.assertIs(summary['harness_git']['dirty'], False, run)
            self.assertEqual(summary['writes_executed'], 0)
            self.assertEqual(summary['prompt'], {'version': 'v4', 'sha256': P.get_prompt('v4')['sha256']}, run)    # the shipped text is the measured text
            changed = 0
            for r in recs:
                self.assertEqual((r['harness_version'], r['prompt']['version'], r['prompt']['protocol']), ('dev-c4', 'v4', 'turn-v2'), run)
                self.assertIs(r['action_audit']['executed'], False)
                g = r['guard']
                self.assertEqual(g['version'], 'v1')
                self.assertEqual(g['final_changed'], bool(g['applied']))
                if g['final_changed']:
                    changed += 1
                    self.assertEqual((r['decision']['class'], r['decision']['action']), ('insufficient_evidence', 'escalate'))
                    self.assertIn('guard ' + g['applied'][0]['rule'], r['decision']['reason'])
                    self.assertNotEqual(g['applied'][0]['original']['action'] + g['applied'][0]['original']['class'], 'escalateinsufficient_evidence')
                    self.assertFalse(r['forced'])
            self.assertEqual(summary['guards']['decisions_changed'], changed, run)

    def test_the_muse_tool_not_offered_violations_are_gone_with_the_exact_schema(self):
        self.assertEqual(sum(len(r['protocol_violations']) for r in records('devc4-v4g-muse-glimmer-30b')), 0)

    def test_unguarded_scores_are_the_same_runs_scored_without_guards(self):
        for run, model in FRESH.items():
            tag = run.replace('devc4-v4g-', '')
            s = json.loads((RUNS / 'unguarded-scores' / (tag + '.score.json')).read_text())
            guarded = json.loads((RUNS / run / 'score.json').read_text())
            self.assertEqual((s['requested_model'], s['cases_recorded']), (model, 73))
            self.assertEqual(sorted(s['cases']), sorted(guarded['cases']))


if __name__ == '__main__':
    unittest.main()
