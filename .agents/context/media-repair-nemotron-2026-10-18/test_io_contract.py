import json,unittest
from pathlib import Path
import io_startup,run_text
ROOT=Path(__file__).resolve().parent
class IOContracts(unittest.TestCase):
 def test_explicit_clean_cache_correction_only(self):
  r=json.loads((ROOT/'io-preflight.json').read_text())['resources']
  self.assertFalse(run_text.healthy(r,idle=True));self.assertTrue(io_startup.idle(r))
  r['extra']=r['extra'].replace('file_dirty 0','file_dirty 4096');self.assertFalse(io_startup.idle(r))
 def test_semantic_protocol_and_hard_limits_unchanged(self):
  old=json.loads((ROOT/'p1-protocol.json').read_text());new=json.loads((ROOT/'p2-protocol.json').read_text())
  for k in ['models','options','stops','documentary_system','av_system','documentary_schema','av_schema','case_count','case_timeout_seconds']:self.assertEqual(old[k],new[k],k)
  self.assertEqual(new['prior_requests'],2);self.assertEqual(new['startup_timeout_seconds'],1200)
if __name__=='__main__':unittest.main()
