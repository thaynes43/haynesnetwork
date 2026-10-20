"""Contract v3, fourth review (AUDIT-ASTRA-19 of PR #1026 at db4a21dc): rename episode markers and empty list-valued naming fields.

Every test here failed at db4a21dc (checked by running this file against that commit's sources) and passes now, each with its control.
Synthetic, generic inputs; no model call."""
import unittest

import test_contract_v3_prereq as P3
import test_contract_v3_review2 as R2
import test_contract_v3_review3 as R3
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import targets as TG

ob, ctx, arr, states = P3.ob, P3.ctx, P3.arr, P3.states
GOOD_PROBE, audit_states, healthy_states = R2.GOOD_PROBE, R2.audit_states, R2.healthy_states
CURRENT, RIGHT = R3.CURRENT, R3.RIGHT          # an evidenced S01E05 mislabel of S01E02


class Item1EveryMarkerMustMatch(unittest.TestCase):
    audit = R3.Blocker1RenameInventsNothing.audit

    def test_a_new_name_that_also_carries_the_wrong_marker_is_refused(self):
        for both in ('Alpha Show - S01E02 S01E05 - Lamp.mkv', 'Alpha Show - S01E05 S01E02 - Lamp.mkv', 'Alpha Show - S01E02 - Lamp S01E05.mkv',
                     'Alpha Show - S01E02 - 1x05 Lamp.mkv'):
            self.assertEqual(self.audit(CURRENT, both)['R-NEW'], 'unmet', both)
        self.assertEqual(set(self.audit(CURRENT, RIGHT).values()), {'met'})            # control: only the single right marker

    def test_a_contradicting_marker_is_a_disagreement_and_the_wrong_name_lends_no_marker(self):
        v = PQ.View([ob('e4', 'arr_lookup', arr(file={'relativePath': CURRENT}))], ctx(filename=CURRENT), 'tv')
        self.assertEqual(v.compare('declaration', 'file_name', 'Alpha Show - S01E02 S01E05 - Lamp.mkv').get('episode_number'), 'disagree')
        self.assertEqual(v.compare('declaration', 'file_name', RIGHT).get('episode_number'), 'agree')
        toks = TG.visible_tokens(v)
        self.assertNotIn('s01e05', toks)          # from the wrong current name and the record that links it
        self.assertIn('s01e02', toks)


class Item2EmptyListValuedNamingFields(unittest.TestCase):
    BOOK = staticmethod(R3.Blocker3EmptyNamingFields.BOOK)

    def epub(self, live=False, **kw):
        if live:
            out = dict({'valid': True, 'stages_passed': ['zip_open', 'zip_crc', 'opf_parse', 'manifest', 'spine'], 'findings': [], 'dc_title': 'Alpha Show',
                        'dc_creator': 'A. Writer'}, **kw)
            out = {k: v for k, v in out.items() if v != 'ABSENT'}
            return ob('t1', 'epub_inspect', {'tool': 'epub', 'status': 'ok', 'coverage': {'verified': ['spine'], 'not_verified': []}, 'output': out}, backend='live', source='tool')
        d = dict({'status': 'ok', 'spine_items': 2, 'entries': 5, 'dc_title': 'Alpha Show', 'dc_creator': 'A. Writer'}, **kw)
        return ob('e1', 'epub_inspect', {k: v for k, v in d.items() if v != 'ABSENT'})

    def naming(self, o, media):
        res = PQ.check([o], self.BOOK(), media)
        return states(res, 'diagnosis', 'metadata_naming')['D-NAME-1'], healthy_states(res)

    def assert_defect(self, o, media, label):
        name, healthy = self.naming(o, media)
        self.assertEqual(name, 'met', label)
        self.assertIn('unmet', healthy.values(), label)

    def assert_clean(self, o, media, label):
        name, healthy = self.naming(o, media)
        self.assertEqual(name, 'unmet', label)
        self.assertEqual(set(healthy.values()), {'met'}, label)

    def test_epub_title_and_creator_lists(self):
        for live in (False, True):
            for field in ('dc_title', 'dc_creator'):
                for empty in ([], ['']):
                    self.assert_defect(self.epub(live, **{field: empty}), 'epub', (live, field, empty))
                for kept in (None, 'ABSENT'):                        # null and absent are not empty
                    if field == 'dc_title' and kept == 'ABSENT':
                        continue                                       # (no title at all is checked by the title rules, not here)
                    name, _h = self.naming(self.epub(live, **{field: kept}), 'epub')
                    self.assertEqual(name, 'unmet', (live, field, kept))
            self.assert_clean(self.epub(live, dc_title=['Alpha Show'], dc_creator=['A. Writer']), 'epub', (live, 'lists'))
            self.assert_clean(self.epub(live), 'epub', (live, 'control'))

    def tagged(self, **tags):
        t = dict(R3.Blocker3EmptyNamingFields.BASE_TAGS)
        for k, val in tags.items():
            if val == 'ABSENT':
                t.pop(k)
            else:
                t[k] = val
        p = dict(GOOD_PROBE, streams=[GOOD_PROBE['streams'][1]], format=dict(GOOD_PROBE['format'], tags=t))
        return ob('e1', 'ffprobe', p)

    def test_audiobook_tags_including_list_values(self):
        for field in ('title', 'album', 'artist'):
            for empty in ([], [''], ''):
                self.assert_defect(self.tagged(**{field: empty}), 'audiobook', (field, empty))
            for kept in (None, 'ABSENT'):
                self.assertEqual(self.naming(self.tagged(**{field: kept}), 'audiobook')[0], 'unmet', (field, kept))
        self.assert_clean(self.tagged(title=['Alpha Show']), 'audiobook', 'list control')
        self.assert_clean(self.tagged(), 'audiobook', 'control')

    def test_live_audiobook_part_tags(self):
        def book(tags):
            part = {'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok', 'tags': tags}
            raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': ['probe'], 'not_verified': []}, 'output': {'parts': 1, 'parts_probed': 1, 'files': [part]}}
            return ob('t1', 'audiobook_inspect', raw, backend='live', source='tool')
        for field in ('title', 'album', 'artist'):
            for empty in ('', [], ['']):
                tags = dict(R3.Blocker3EmptyNamingFields.BASE_TAGS, **{field: empty})
                self.assertEqual(self.naming(book(tags), 'audiobook')[0], 'met', (field, empty))
            self.assertEqual(self.naming(book(dict(R3.Blocker3EmptyNamingFields.BASE_TAGS, **{field: None})), 'audiobook')[0], 'unmet', field)
        self.assertEqual(self.naming(book(dict(R3.Blocker3EmptyNamingFields.BASE_TAGS)), 'audiobook')[0], 'unmet')


if __name__ == '__main__':
    unittest.main()
