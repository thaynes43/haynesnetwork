"""Contract v3, fifth review (the Opus review of PR #1026 at 2355220b): a multi-part audiobook's part album and artist are compared with the
catalog (M5, M6); only a part's title, a chapter name, is exempt.  The regression failed at 2355220b and passes now; the control keeps a
well-tagged multi-part book healthy.  Synthetic, generic inputs; no model call."""
import unittest

import test_contract_v3_prereq as P3
import test_contract_v3_review2 as R2
import test_contract_v3_review3 as R3
from media_repair_harness.experimental.contract_v3 import prereq as PQ

ob, states, healthy_states = P3.ob, P3.states, R2.healthy_states
BOOK = R3.Blocker3EmptyNamingFields.BOOK


def book(album='Alpha Show', artist='A. Writer'):
    parts = [{'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok',
              'tags': {'title': 'Chapter %02d' % i, 'album': album, 'artist': artist}} for i in (1, 2, 3)]
    raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': ['probe'], 'not_verified': []}, 'output': {'parts': 3, 'parts_probed': 3, 'files': parts}}
    return PQ.check([ob('t1', 'audiobook_inspect', raw, backend='live', source='tool')], BOOK(), 'audiobook')


class PartAlbumAndArtistAreCompared(unittest.TestCase):
    def material(self, res):
        return {m['id']: m['state'] for m in res['material']}

    def test_every_part_naming_another_book_or_author_is_an_identity_and_naming_disagreement(self):
        for kw in ({'album': 'Some Other Book'}, {'artist': 'Some Other Person'}):
            res = book(**kw)
            self.assertEqual((self.material(res)['M5'], self.material(res)['M6']), ('met', 'met'), kw)
            self.assertEqual(states(res, 'diagnosis', 'metadata_naming')['D-NAME-1'], 'met', kw)
            self.assertIn('unmet', healthy_states(res).values(), kw)

    def test_control_a_well_tagged_book_with_distinct_chapter_titles_stays_healthy(self):
        res = book()
        self.assertEqual((self.material(res)['M5'], self.material(res)['M6']), ('unmet', 'unmet'))
        self.assertEqual(set(healthy_states(res).values()), {'met'})


if __name__ == '__main__':
    unittest.main()
