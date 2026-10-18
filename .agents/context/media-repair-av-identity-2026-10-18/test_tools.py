import unittest
from tools import consensus
from score import assess
class Contracts(unittest.TestCase):
 def test_target_agnostic_whitespace_consensus(self):
  self.assertEqual(consensus([{'image_sha256':'x','text':'A\nB!'}, {'image_sha256':'x','text':'A B!'}]),{'status':'agreement','text':'A B!'})
 def test_disagreement_does_not_invent_title(self):
  self.assertEqual(consensus([{'image_sha256':'x','text':'First'}, {'image_sha256':'x','text':'Second'}]),{'status':'unresolved','text':''})
 def test_empty_readings_are_not_identity_conclusion(self):
  self.assertEqual(consensus([{'image_sha256':'x','text':''}, {'image_sha256':'x','text':' '}]),{'status':'agreement','text':''})
 def test_mixed_source_bytes_refused(self):
  with self.assertRaises(ValueError):consensus([{'image_sha256':'x','text':'A'},{'image_sha256':'y','text':'A'}])
 def test_false_positive_counted_without_guard(self):
  truth={'identity':'match','decode':'pass','compatibility':'supported'};case={'observations':{'decode':{'primary':{}}}}
  r=assess({'identity':'mismatch','decode':'pass','compatibility':'supported','evidence':['frame','decode.primary','streams','client']},truth,case);self.assertTrue(r['false_mismatch']);self.assertIn('identity:mismatch',r['unsupported_assertions'])
 def test_ocr_citation_requires_actual_observation(self):
  truth={'identity':'abstain','decode':'pass','compatibility':'supported'};case={'observations':{'decode':{'primary':{}}}};proposal={'identity':'abstain','decode':'pass','compatibility':'supported','evidence':['ocr','decode.primary','streams','client']}
  self.assertFalse(assess(proposal,truth,case)['references_resolve']);case['observations']['ocr']={'text':''};self.assertTrue(assess(proposal,truth,case)['references_resolve'])
if __name__=='__main__':unittest.main()
