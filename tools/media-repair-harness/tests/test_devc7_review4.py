"""dev-c7 fourth review round (AUDIT-ASTRA-30 on PR #1028 at 92c7e098): leakguard-media-2 tried separators one at a time (none, or a space), so MIXED
separators rebuilt a protected value.  The media check is now separator-insensitive (alphanumerics only, case-folded, mapped back to element and offset;
boundaries checked at the original characters just outside the match).  Regressions fail at 92c7e098, on recorded e1 evidence and on a tool result alike;
the controls hold on both.  Synthetic EPUBs and scripted replies only; no model, no network."""
import json
import unittest

import test_devc7 as D
import test_devc7_review as RV
from ev2h import tc
from media_repair_harness import leakguard

xhtml, d3, epub_case, v7_run, call = D.xhtml, D.d3, RV.epub_case, RV.v7_run, RV.call


def book(titles, cid='w22t-case-01', fixture='q6plain', ref='zz-ref-q6', creators=None, body='<h1>Chapter</h1><p>ordinary words</p>'):
    """A case whose EPUB has one dc:title per element of `titles` (and dc:creator elements `creators`)."""
    case = epub_case([('a.xhtml', xhtml(body))], fixture, cid=cid, title='The Lamplighter')
    title = '</dc:title><dc:title>'.join(titles)
    creator = '</dc:creator><dc:creator>'.join(creators or ['A. Writer'])
    D.build_epub(case['fixture']['locator'], [('a.xhtml', xhtml(body))], title=title, creator=creator)
    case.update(family='lamplighter', provenance='new')
    case['truth'] = {'class': 'healthy', 'source': 'construction', 'ref': ref}
    return case


def live(case):
    rec, ad = v7_run(case, [tc('epub_inspect'), d3()])
    return rec.get('error'), ad


def recorded(case):
    _r, o = call(case)
    case = dict(case, evidence=[{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(o)}])
    rec, ad = v7_run(case, [d3()])
    return rec.get('error'), ad


class MixedSeparators(unittest.TestCase):
    def assert_refused(self, case, label):
        for how in (live, recorded):
            err, ad = how(case)
            self.assertIsNotNone(err, (label, how.__name__))                                       # at 92c7e098: delivered
            self.assertIn('leakguard-media-2', err['message'], (label, how.__name__))
            self.assertEqual(len(ad.full), 1 if how is live else 0, (label, how.__name__))       # the request carrying the media text was not sent

    def test_astra_probe_a_fixture_name_rebuilt_with_mixed_separators(self):
        self.assert_refused(book(['forbid', 'den', ' identity-42.epub'], fixture='forbidden-identity-42'), 'fixture name')

    def test_astra_probe_a_truth_reference_rebuilt_from_word_pieces(self):
        self.assert_refused(book(['the', 'plant', 'ed', 'title'], ref='the planted title'), 'truth reference')

    def test_arbitrary_separators_and_mixed_case(self):
        for titles in (['Forbidden_', 'IDENTITY.', '-42'], ['forbidden.identity_42'], ['FORBIDDEN', '‐identity', '·42'], ['for-bid', 'den iden', 'tity . 42']):
            self.assert_refused(book(titles, cid='forbidden-identity-42'), titles)

    def test_where_the_match_was_found_is_reported(self):
        err, _ad = live(book(['forbid', 'den', ' identity-42.epub'], fixture='forbidden-identity-42'))
        self.assertIn('dc_title[], elements 0-2', err['message'])
        self.assertNotIn('forbidden-identity-42', err['message'])                                  # the hidden value itself is never echoed


class Controls(unittest.TestCase):
    def test_non_adjacent_elements_are_not_joined(self):
        err, _ad = live(book(['forbid'], creators=['den-identity-42'], cid='forbidden-identity-42'))
        self.assertIsNone(err, err)                                                                 # two different fields
        err, _ad = live(book(['forbid', 'The Middle', 'den-identity-42'], cid='forbidden-identity-42'))
        self.assertIsNone(err, err)                                                                 # a non-matching element between

    def test_ordinary_prose_passes(self):
        err, _ad = live(book(['The Lamplighter'], body='<p>lamplighter knew it was new and healthy</p>'))
        self.assertIsNone(err, err)

    def test_a_value_inside_a_longer_word_passes_and_the_word_itself_is_refused(self):
        err, _ad = live(book(['Roses'], ref='planted', body='<p>the transplanted roses grew</p>'))
        self.assertIsNone(err, err)                                                                 # boundary-checked: "planted" inside "transplanted"
        err, _ad = live(book(['Roses'], ref='planted', body='<p>the roses were planted here</p>'))
        self.assertIsNotNone(err)                                                                   # the word itself (a 6+ letter truth reference)

    def test_whole_value_refusals_still_work(self):
        for titles in (['forbidden-identity-42'], ['see forbidden-identity-42 here']):
            err, _ad = live(book(titles, cid='forbidden-identity-42'))
            self.assertIsNotNone(err, titles)

    def test_the_reduction_maps_back_to_elements_and_offsets(self):
        self.assertEqual(leakguard.reduced_hits(['xx', 'forbid', 'den-iden', 'tity-42', 'yy'], 'forbidden-identity-42'), [(1, 3)])
        self.assertEqual(leakguard.reduced_hits(['xforbid', 'den-identity-42'], 'forbidden-identity-42'), [])     # 'x' joins it to a longer word
        self.assertEqual(leakguard.reduced_hits(['Straße 1'], 'strasse-1'), [(0, 0)])                         # case folding (ß -> ss)


if __name__ == '__main__':
    unittest.main()
