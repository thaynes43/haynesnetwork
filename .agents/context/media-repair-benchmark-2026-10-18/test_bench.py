"""Targeted serial contract checks; no inference, media or external dependencies."""
import tempfile
from pathlib import Path
import unittest
import bench


class BenchmarkContract(unittest.TestCase):
    def test_detector_payload_has_no_evaluator_fields(self):
        cases = bench.load_cases()
        self.assertEqual(len({c['id'] for c in cases}),len(cases))
        groups = {split:{c['family'] for c in cases if c['split']==split} for split in ('development','held_out')}
        self.assertFalse(groups['development'] & groups['held_out'])
        for c in cases:
            self.assertEqual(set(bench.detector_payload(c)), {'request_id','evidence'})
            self.assertEqual(set(bench.detector_payload(c)['evidence']), {'kind','expected','observed'})
            self.assertIn(c['label'], ('match','mismatch'))
            self.assertTrue(c['source'].startswith('https://github.com/'))

    def test_missing_and_abstained_results_stay_in_denominator(self):
        cases = [{'id':'a','label':'mismatch'},{'id':'b','label':'match'},
                 {'id':'c','label':'mismatch'},{'id':'d','label':'match'}]
        result = bench.metrics(cases, {'a':{'decision':'abstain'},'b':{'decision':'mismatch'},'c':{'decision':'mismatch'}})
        self.assertEqual(result['accuracy'], .25)
        self.assertEqual(result['precision'], .5)
        self.assertEqual(result['recall'], .5)
        self.assertEqual(result['false_positive_rate'], .5)
        self.assertEqual(result['coverage'], .5)
        self.assertEqual(result['confusion']['errors'], 1)

    def test_incomplete_content_abstains(self):
        evidence = {'kind':'ebook','expected':{'title':'X'},'observed':{'catalog_title':'X'}}
        self.assertEqual(bench.detect(evidence, 'v1'), 'abstain')

    def test_absent_and_duplicate_repair_candidates_abstain_preserving_bytes(self):
        original_case = bench.load_cases()[0]
        for choices in ([], [original_case['candidates'][1], original_case['candidates'][1]]):
            case = dict(original_case, candidates=choices)
            with tempfile.TemporaryDirectory() as tmp:
                trace = bench.fixture_repair(case, 'mismatch', Path(tmp)/'case')
                self.assertEqual(trace['operation'], 'abstain')
                self.assertTrue(trace['original_preserved'] and trace['active_copy_preserved'])
                self.assertFalse(trace['correct'])

    def test_repair_oracle_is_independent_of_detector(self):
        case = dict(bench.load_cases()[0], expected_candidate='intentionally-wrong-oracle')
        with tempfile.TemporaryDirectory() as tmp:
            trace = bench.fixture_repair(case, 'mismatch', Path(tmp)/'case')
            self.assertEqual(trace['operation'], 'repoint')
            self.assertFalse(trace['correct'])


if __name__ == '__main__':
    unittest.main()
