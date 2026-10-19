"""Review of PR #1009, round 2: a write target is `met` (computed) only when it identifies the case's own item."""
import json
import unittest

import audit as AU
import th

TV = th.make_case('tv-x', media='tv', context={
    'title': 'Example Show S01E03', 'filename': 'Example Show - S01E03 - The Long Night.mkv',
    'expected': {'series': 'Example Show', 'season': 1, 'episode': 3, 'episode_title': 'The Long Night'},
    'arr': {'app': 'sonarr', 'ids': {'seriesId': 880001, 'episodeId': 880103, 'episodeFileId': 880203, 'note': 'fictional ids'}}, 'notes_for_model': 'n'},
    evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': 'audio stream high profile; sonarr library path /tv/Example Show/Season 01 holds the file'}])
MOVIE = th.make_case('mv-x', media='movie', context={
    'title': 'Quiet Harbor (2019)', 'filename': 'Quiet Harbor (2019).mkv', 'expected': {'title': 'Quiet Harbor', 'year': 2019},
    'arr': {'app': 'radarr', 'ids': {'movieId': 770301, 'movieFileId': 770401}}, 'notes_for_model': 'n'})
BOOK = th.make_case('bk-x', media='epub', context={
    'title': 'The Lantern Ledger', 'expected': {'title': 'The Lantern Ledger', 'edition': 'revised'}, 'arr': {'app': 'bookshelf', 'ids': {}}, 'notes_for_model': 'n'})


def ident(case, target):
    return AU.target_identity(case, target)[0]


class TargetMustIdentifyTheItem(unittest.TestCase):
    def test_exact_file_name_and_path_are_identified(self):
        self.assertEqual(ident(TV, 'Example Show - S01E03 - The Long Night.mkv'), 'identified')
        self.assertEqual(ident(TV, '/tv/Example Show/Season 01/Example Show - S01E03 - The Long Night.mkv'), 'identified')
        self.assertEqual(ident(MOVIE, 'Quiet Harbor (2019).mkv'), 'identified')

    def test_exact_item_is_identified(self):
        self.assertEqual(ident(TV, 'Example Show S01E03'), 'identified')                 # title with season and episode
        self.assertEqual(ident(TV, 'Example Show season 1 episode 3'), 'identified')
        self.assertEqual(ident(TV, 'Example Show 1x03'), 'identified')
        self.assertEqual(ident(TV, 'episodeFileId 880203'), 'identified')                # linked item id
        self.assertEqual(ident(TV, '880103'), 'identified')
        self.assertEqual(ident(MOVIE, 'Quiet Harbor (2019)'), 'identified')              # a movie's title is its item
        self.assertEqual(ident(MOVIE, 'movieFileId 770401'), 'identified')
        self.assertEqual(ident(BOOK, 'The Lantern Ledger'), 'identified')
        self.assertEqual(ident(BOOK, 'The Lantern Ledger (revised edition)'), 'identified')

    def test_broad_scope_is_not_met_even_when_it_names_the_item(self):
        for t in ('every file in the sonarr library', 'all files', 'the whole library', 'entire series', 'all indexers',
                  'Example Show', 'Example Show season 1', 'Example Show series', 'all episodes of Example Show',
                  'Example Show - S01E03 - The Long Night.mkv and every other file in the library',
                  'Example Show S01E03 across the sonarr library'):
            self.assertNotEqual(ident(TV, t), 'identified', t)
        self.assertEqual(ident(TV, 'every file in the sonarr library'), 'broad')
        self.assertEqual(ident(TV, 'Example Show S01E03 across the sonarr library'), 'broad')
        self.assertNotEqual(ident(MOVIE, 'the whole radarr library including Quiet Harbor (2019)'), 'identified')
        self.assertNotEqual(ident(BOOK, 'every edition of The Lantern Ledger'), 'identified')

    def test_app_names_and_generic_words_are_not_identifiers(self):
        for t in ('sonarr', 'Sonarr', 'radarr', 'bookshelf', 'audio', 'high', 'video', 'h264', 'file', 'the release', 'episode', 'season 1',
                  'movie', '3', '1234', 'unknown'):
            for case in (TV, MOVIE, BOOK):
                self.assertNotEqual(ident(case, t), 'identified', (t, case['id']))

    def test_text_that_only_appears_in_tool_output_is_unverifiable_not_met(self):
        # 'audio stream high profile' is inside the free evidence text of TV; a short generic 'audio' / 'high' is just unidentified
        self.assertEqual(AU.target_identity(TV, 'audio stream high profile')[0], 'unidentified')
        self.assertTrue(AU.target_in_text(TV, 'audio stream high profile'))
        self.assertFalse(AU.target_in_text(TV, 'audio'))
        self.assertFalse(AU.target_in_text(TV, 'high'))
        self.assertFalse(AU.target_in_context(TV, 'audio stream high profile'))

    def test_the_precondition_is_met_computed_only_for_an_identified_target(self):
        def check(case, target):
            d = th.decision('metadata_naming', 'rename', refs=['e1'], target=target)
            d['audit'] = {'target': target, 'preconditions': ['e1 ok'], 'readback': 'read back the name', 'verify': 'rename back to the original name if wrong'}
            a = AU.compute(case, d, [])
            return [c for c in a['preconditions'] if c['id'] == 'target_in_context'][0], a
        c, a = check(TV, 'Example Show - S01E03 - The Long Night.mkv')
        self.assertEqual((c['met'], c['basis']), (True, 'computed'))
        self.assertNotIn('target_in_context', a['unmet'])
        for t in ('every file in the sonarr library', 'sonarr', 'audio'):
            c, a = check(TV, t)
            self.assertEqual((c['met'], c['basis']), (False, 'computed'), t)
            self.assertIn('target_in_context', a['unmet'])
        self.assertIn('broader scope', check(TV, 'every file in the sonarr library')[0]['detail'])
        c, a = check(TV, 'audio stream high profile')
        self.assertEqual((c['met'], c['basis']), (False, 'claim_text'))   # unverifiable: appears only in free evidence text
        self.assertIn('target_in_context', a['unmet'])
        self.assertIs(a['executed'], False)


if __name__ == '__main__':
    unittest.main()
