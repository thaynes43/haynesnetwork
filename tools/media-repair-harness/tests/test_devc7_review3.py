"""dev-c7 third review round (AUDIT-ASTRA-29 on PR #1028 at 276ce87c): leakguard-media-2 checked each element and each ADJACENT PAIR of a list, never a
contiguous run of three or more, so a protected value split into three parts reached the model.  Now every contiguous run of every ordered source group is
checked (a list field, the declared TOC entries, one item's headings).  The regressions fail at 276ce87c; the controls (the whole value, two elements,
non-contiguous parts, ordinary prose) hold on both.  Synthetic EPUBs and scripted replies only; no model, no network."""
import json
import unittest

import test_devc7 as D
import test_devc7_review as RV
from ev2h import tc
from media_repair_harness import leakguard

xhtml, d3, epub_case, v7_run = D.xhtml, D.d3, RV.epub_case, RV.v7_run
CID = 'forbidden-identity-42'


def titled(parts, toc=None, cid=CID):
    """An EPUB whose OPF has one dc:title per part (in order), optionally a navigation document whose TOC entries are `toc`."""
    title = '</dc:title><dc:title>'.join(parts)
    nav = [(t, 'a.xhtml') for t in toc] if toc else None
    case = epub_case([('a.xhtml', xhtml('<h1>Chapter</h1><p>ordinary words</p>'))], 'q7runs', cid=cid, title='The Lamplighter', nav=nav)
    case.update(family='lamplighter', provenance='new')
    case['truth'] = {'class': 'healthy', 'source': 'construction', 'ref': 'zz-ref-q7'}
    return case, title


def run(parts, toc=None):
    case, title = titled(parts, toc)
    # rebuild the fixture with the parts as separate dc:title elements
    path = case['fixture']['locator']
    D.build_epub(path, [('a.xhtml', xhtml('<h1>Chapter</h1><p>ordinary words</p>'))], title=title,
                 nav=[(t, 'a.xhtml') for t in toc] if toc else None)
    rec, ad = v7_run(case, [tc('epub_inspect'), d3()])
    return rec, ad


class ContiguousRunsAreChecked(unittest.TestCase):
    def test_a_value_split_into_three_or_more_list_elements_is_refused(self):
        for parts in (['forbid', 'den-iden', 'tity-42'], ['for', 'bid', 'den-', 'identity', '-42']):
            rec, ad = run(parts)
            self.assertIsNotNone(rec.get('error'), parts)                                          # at 276ce87c: delivered
            self.assertIn('leakguard-media-2', rec['error']['message'], parts)
            self.assertEqual(len(ad.full), 1, parts)                                               # the request carrying the result was not sent

    def test_a_value_split_across_three_declared_toc_entries_is_refused(self):
        rec, _ad = run(['The Lamplighter'], toc=['forbid', 'den-iden', 'tity-42'])
        self.assertIsNotNone(rec.get('error'))                                                     # at 276ce87c: each entry was its own group
        self.assertIn('leakguard-media-2', rec['error']['message'])

    def test_controls_whole_value_two_elements_non_contiguous_parts_and_prose(self):
        rec, _ad = run([CID])
        self.assertIsNotNone(rec.get('error'))                                                     # the whole value: refused (both versions)
        rec, _ad = run(['forbidden-', 'identity-42'])
        self.assertIsNotNone(rec.get('error'))                                                     # two elements: refused (both versions)
        rec, _ad = run(['forbid', 'The Middle', 'den-identity-42'])
        self.assertIsNone(rec.get('error'), rec.get('error'))                                      # parts that are not contiguous do not join
        rec, _ad = run(['The', 'Lamplighter', 'knew', 'she was healthy and new'])
        self.assertIsNone(rec.get('error'), rec.get('error'))                                      # ordinary prose passes

    def test_the_run_search_keeps_word_boundaries_at_the_run_ends(self):
        # (round 4 replaced the uniform-separator run search by the separator-insensitive leakguard.reduced_hits; the same boundary cases hold)
        self.assertTrue(leakguard.reduced_hits(['a', 'b-1', '2'], 'ab-12'))
        self.assertFalse(leakguard.reduced_hits(['xa', 'b-1', '2'], 'ab-12'))                       # 'x' joins the run's first element: not the value
        self.assertFalse(leakguard.reduced_hits(['a', 'b-1', '23'], 'ab-12'))
        self.assertTrue(leakguard.reduced_hits(['the planted', 'title'], 'the planted title'))
        self.assertEqual(leakguard.group_runs([{'source': 't1', 'group': 'dc_title[]', 'text': 'x'}, {'source': 't1', 'group': 'dc_title[]', 'text': 'y'}]),
                         {('t1', 'dc_title[]'): ['x', 'y']})

if __name__ == '__main__':
    unittest.main()
