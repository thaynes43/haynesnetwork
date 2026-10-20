"""Contract v3, third review (AUDIT-ASTRA-18 of PR #1026 at a391baa1): one paired regression class per blocker, plus the P3 presence pairs.

Every test here failed at a391baa1 (checked by running this file against that commit's sources) and passes now; each pairs the failing input with
a control.  Expected values are written by hand or derived in the test from the raw observation.  No model call; synthetic, generic inputs."""
import json
import unittest

import test_contract_v3_prereq as P3
import test_contract_v3_review2 as R2
from media_repair_harness.experimental.contract_v3 import facts as FX
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import targets as TG

ob, ctx, arr, states = P3.ob, P3.ctx, P3.arr, P3.states
PROBE, GOOD_PROBE = P3.PROBE, R2.GOOD_PROBE
audit_states, healthy_states, raw_expect = R2.audit_states, R2.healthy_states, R2.raw_expect
CURRENT = 'Alpha Show - S01E05 - Lamp.mkv'
RIGHT = 'Alpha Show - S01E02 - Lamp.mkv'


class Blocker1RenameInventsNothing(unittest.TestCase):
    def audit(self, old, new):
        d = {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e1'],
             'source': {'ref': 'e4'}, 'target': {'kind': 'rename_of_source', 'old_value': old, 'new_value': new}}
        obs = [ob('e1', 'ffprobe', GOOD_PROBE), ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E02 / LAMP'}), ob('e4', 'arr_lookup', arr(file={'relativePath': CURRENT}))]
        return audit_states(TG.audit_v3(d, obs, ctx(filename=CURRENT), 'tv'))

    def test_the_old_value_must_be_the_literal_current_name(self):
        for altered in ('alpha show - s01e05 - lamp.MKV', 'Alpha Show S01E05 Lamp.mkv', 'Alpha.Show.-.S01E05.-.Lamp.mkv'):
            self.assertEqual(self.audit(altered, RIGHT)['R-OLD'], 'unmet', altered)
        self.assertEqual(self.audit(CURRENT, RIGHT)['R-OLD'], 'met')

    def test_the_new_value_is_an_evidenced_basename(self):
        for invented in ('Some Invented Directory/' + RIGHT, '../' + RIGHT, 'Alpha Show - S01E02 - Lamp Remastered Edition.mkv', 'Alpha Show - S01E02 - Lamp.mp4', ' ' + RIGHT):
            self.assertEqual(self.audit(CURRENT, invented)['R-NEW'], 'unmet', invented)
        got = self.audit(CURRENT, RIGHT)
        self.assertEqual(set(got.values()), {'met'}, got)


class Blocker2IncompleteEvidence(unittest.TestCase):
    CLIENT = staticmethod(lambda: ctx(client_profile={'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac', 'containers': ['matroska']}))
    HEVC = dict(GOOD_PROBE, streams=PROBE['streams'])

    def convert(self, status):
        d = {'type': 'decision', 'class': 'decoder_incompatible', 'action': 'convert', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e1'],
             'source': {'ref': 'e4'}, 'target': {'kind': 'isolated_copy', 'allocated_by': 'executor'}}
        obs = [ob('e1', 'ffprobe', self.HEVC, status=status), ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}))]
        return audit_states(TG.audit_v3(d, obs, self.CLIENT(), 'tv'))

    def test_a_partial_probe_cannot_establish_incompatibility(self):
        part = self.convert('partial')
        self.assertEqual((part['D-DEC-2'], part['A-CNV-2']), ('unmet', 'unmet'))
        self.assertEqual(set(self.convert('ok').values()), {'met'})

    def test_an_incomplete_contradiction_blocks_healthy_without_supporting_a_write(self):
        partial_other = ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}, status='partial')
        res = PQ.check([ob('e1', 'ffprobe', GOOD_PROBE), partial_other], ctx(), 'tv')
        self.assertIn('unmet', healthy_states(res).values())
        self.assertEqual(states(res, 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'unmet'})        # it supports no identity write
        partial_same = ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E02 / LAMP'}, status='partial')
        self.assertEqual(set(healthy_states(PQ.check([ob('e1', 'ffprobe', GOOD_PROBE), partial_same], ctx(), 'tv')).values()), {'met'})

    def test_an_incomplete_unsupported_probe_is_material_for_a_stated_client(self):
        obs = [ob('e1', 'ffprobe', GOOD_PROBE), ob('e2', 'ffprobe', self.HEVC, status='partial')]
        res = PQ.check(obs, self.CLIENT(), 'tv')
        self.assertEqual({m['id']: m['state'] for m in res['material']}['M8'], 'met')
        self.assertEqual(states(res, 'diagnosis', 'decoder_incompatible')['D-DEC-2'], 'unmet')
        self.assertEqual(set(healthy_states(PQ.check(obs[:1], self.CLIENT(), 'tv')).values()), {'met'})


class Blocker3EmptyNamingFields(unittest.TestCase):
    BOOK = staticmethod(lambda: ctx(filename=None, title='Alpha Show', expected={'title': 'Alpha Show', 'author': 'A. Writer'}, arr={'app': 'lazylibrarian', 'ids': {}}))
    BASE_TAGS = {'title': 'Alpha Show', 'album': 'Alpha Show', 'artist': 'A. Writer'}

    def book(self, **tags):
        t = dict(self.BASE_TAGS)
        for k, v in tags.items():
            if v == 'ABSENT':
                t.pop(k)
            else:
                t[k] = v
        p = dict(GOOD_PROBE, streams=[GOOD_PROBE['streams'][1]], format=dict(GOOD_PROBE['format'], tags=t))
        return PQ.check([ob('e1', 'ffprobe', p)], self.BOOK(), 'audiobook')

    def test_an_empty_audiobook_naming_tag_is_a_naming_defect_and_not_healthy(self):
        for field in ('title', 'album', 'artist'):
            res = self.book(**{field: ''})
            self.assertEqual(states(res, 'diagnosis', 'metadata_naming')['D-NAME-1'], 'met', field)
            self.assertIn('unmet', healthy_states(res).values(), field)
            for kept in (None, 'ABSENT'):                 # null and absent stay distinct from empty: not a naming defect
                self.assertEqual(states(self.book(**{field: kept}), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet', (field, kept))
        self.assertEqual(set(healthy_states(self.book()).values()), {'met'})

    def test_an_empty_epub_creator_is_a_naming_defect(self):
        epub = lambda **kw: ob('e1', 'epub_inspect', dict({'status': 'ok', 'spine_items': 2, 'entries': 5, 'dc_title': 'Alpha Show', 'dc_creator': 'A. Writer'}, **kw))
        res = PQ.check([epub(dc_creator='')], self.BOOK(), 'epub')
        self.assertEqual(states(res, 'diagnosis', 'metadata_naming')['D-NAME-1'], 'met')
        self.assertIn('unmet', healthy_states(res).values())
        self.assertEqual(states(PQ.check([epub(dc_creator=None)], self.BOOK(), 'epub'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet')
        self.assertEqual(set(healthy_states(PQ.check([epub()], self.BOOK(), 'epub')).values()), {'met'})


class P3PresenceCoverage(unittest.TestCase):
    def rendered(self, o, media):
        r = FX.render([o], {}, media, [o['tool']], [])
        return r['reference']['facts'].get(o['id'], {}), (r['reference'].get('presence') or {}).get(o['id'], {})

    def test_a_null_decode_out_time_is_kept_distinct_from_a_missing_one(self):
        seen = {}
        for name, raw in (('missing', {'exit_code': 0, 'frames': 0, 'stderr': ''}), ('null', {'exit_code': 0, 'frames': 0, 'stderr': '', 'out_time': None})):
            facts, presence = self.rendered(ob('e1', 'decode_sample', raw, args={'at': 8}), 'tv')
            present, value = raw_expect(raw, ('out_time',))
            self.assertEqual(('decoded_s' in facts, facts.get('decoded_s')), (present, value), name)
            self.assertEqual(presence.get('decoded_s'), 'null' if present else None, name)
            seen[name] = json.dumps([facts, presence], sort_keys=True)
        self.assertNotEqual(seen['missing'], seen['null'])

    def test_nested_live_part_chapters_empty_and_missing_render_differently(self):
        seen = {}
        for name, chapters in (('missing', 'ABSENT'), ('empty', []), ('null', None)):
            part = {'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok', 'tags': {'title': 'x'}}
            if chapters != 'ABSENT':
                part['chapters'] = chapters
            raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': [], 'not_verified': []}, 'output': {'parts': 1, 'parts_probed': 1, 'files': [part]}}
            facts, presence = self.rendered(ob('t1', 'audiobook_inspect', raw, backend='live', source='tool'), 'audiobook')
            present, value = raw_expect(raw, ('output', 'files', 0, 'chapters'))
            el = facts['files'][0]
            self.assertEqual(('chapters' in el, el.get('chapters')), (present, value), name)
            seen[name] = json.dumps([facts, presence], sort_keys=True)
        self.assertEqual(len(set(seen.values())), 3)


if __name__ == '__main__':
    unittest.main()
