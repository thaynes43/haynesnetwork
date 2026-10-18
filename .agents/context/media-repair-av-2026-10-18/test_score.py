import unittest
from score import assess
class AxisScoring(unittest.TestCase):
 def setUp(self):
  self.case={'observations':{'decode':{'primary':{},'other':{}}}};self.truth={'identity':'abstain','decode':'pass','compatibility':'unsupported'}
 def test_axes_and_citations_independent(self):
  r=assess({'identity':'abstain','decode':'pass','compatibility':'unsupported','evidence':['frame','decode.primary','streams','client']},self.truth,self.case);self.assertTrue(all(r['axis_correct'].values()));self.assertTrue(r['evidence_axis_coverage']);self.assertEqual(r['unsafe_or_unsupported'],[])
 def test_unsupported_identity_and_compatibility_count_before_guard(self):
  r=assess({'identity':'match','decode':'pass','compatibility':'supported','evidence':['frame']},self.truth,self.case);self.assertEqual(r['unsafe_or_unsupported'],['identity:match','compatibility:supported']);self.assertFalse(r['evidence_axis_coverage'])
 def test_quota_failure_is_not_corruption_label(self):
  r=assess({'identity':'abstain','decode':'fail','compatibility':'unsupported','evidence':['decode.other']},self.truth,self.case);self.assertIn('decode:fail',r['unsafe_or_unsupported'])
 def test_malformed_response_is_error(self):
  self.assertTrue(assess(None,self.truth,self.case)['error']);self.assertTrue(assess({'identity':[],'decode':'pass','compatibility':'unsupported','evidence':[]},self.truth,self.case)['error'])
 def test_invented_evidence_does_not_resolve(self):
  r=assess({'identity':'abstain','decode':'pass','compatibility':'unsupported','evidence':['filename']},self.truth,self.case);self.assertFalse(r['evidence_resolves'])
if __name__=='__main__':unittest.main()
