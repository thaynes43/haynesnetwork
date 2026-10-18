"""Shared startup separation preserves semantic inputs and historical failure."""
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parent
class P1Contracts(unittest.TestCase):
 def test_only_startup_metadata_changes(self):
  old=json.loads((ROOT/'text-protocol.json').read_text());new=json.loads((ROOT/'p1-protocol.json').read_text())
  for key in old:
   if key!='frozen_at':self.assertEqual(old[key],new[key],key)
  self.assertEqual(new['case_timeout_seconds'],60);self.assertEqual(new['startup_timeout_seconds'],300)
  self.assertEqual(new['max_total_requests_including_P0'],1+3+42)
 def test_original_failure_preserved_and_not_answer(self):
  row=json.loads((ROOT/'text-runs/nemotron-3.5-bolt/c01.json').read_text())
  self.assertEqual(row['receipt']['exit_code'],124);self.assertIsNone(row['response'])
  self.assertEqual(row['request']['options']['num_thread'],2)
if __name__=='__main__':unittest.main()
