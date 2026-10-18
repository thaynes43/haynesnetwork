"""Regression checks for observed ownership refusal and pre-output subset contract."""
import json
from pathlib import Path
import unittest
import io_startup,io_startup_local,io_startup_local_fixed
ROOT=Path(__file__).resolve().parent
class LocalContracts(unittest.TestCase):
 def test_successful_native_http_load_response_is_parsed(self):
  body=b'{"done":true,"done_reason":"load"}'
  response,receipt=io_startup_local_fixed.parse_http(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
  self.assertEqual(response['done_reason'],'load');self.assertEqual(receipt['http_status'],200)
 def test_captured_native_response_body_parses(self):
  raw=json.loads((ROOT/'local-daemon-cleanup.json').read_text())['unload']['raw_body'].encode()
  response,receipt=io_startup_local_fixed.parse_http(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(raw)).encode()+b'\r\n\r\n'+raw)
  self.assertTrue(response['done']);self.assertEqual(response['done_reason'],'unload')
 def test_gpu_pid_binds_to_exact_own_core(self):
  core='sha256-own-core'
  text='LOADER 14714\n/usr/lib/ollama/llama-server --model /models/blobs/'+core+' --threads 2\n'
  own,gpu=io_startup.ownership(text,'GPU-example, 14714, llama-server, 266 MiB\n',core)
  self.assertEqual(own,gpu)
  own,gpu=io_startup.ownership(text,'GPU-example, 99999, other, 266 MiB\n',core)
  self.assertTrue(gpu-own)
  own,gpu=io_startup.ownership(text,'GPU-example, 14714, llama-server, 266 MiB\n','sha256-other-core')
  self.assertTrue(gpu-own)
 def test_dirty_pages_are_charged_not_an_absolute_refusal(self):
  r=json.loads((ROOT/'local-prelaunch-refusal.json').read_text())['resources']
  self.assertFalse(io_startup.idle(r))
  self.assertTrue(io_startup_local.idle(r))
  r['extra']=r['extra'].replace('file_dirty 16384','file_dirty '+str(9*2**30))
  self.assertFalse(io_startup_local.idle(r))
 def test_subset_preserves_heldout_and_request_ceiling(self):
  p=json.loads((ROOT/'p3-protocol.json').read_text());old=json.loads((ROOT/'p1-protocol.json').read_text())
  for key in ['options','stops','documentary_system','av_system','documentary_schema','av_schema','case_timeout_seconds']:
   self.assertEqual(p[key],old[key],key)
  self.assertEqual(p['case_ids'],['c%02d'%i for i in range(1,11)]+['a01','a02','a03'])
  self.assertEqual(p['prior_requests']+3+3*len(p['case_ids']),46)
  self.assertEqual(p['execution_deadline_utc'],'2026-10-18T22:25:00+00:00')
if __name__=='__main__':unittest.main()
