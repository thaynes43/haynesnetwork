"""Contract v3, second review (AUDIT-ASTRA-17 and the Opus review of PR #1026 at cb118c1c): one paired regression class per item.

Every test here failed at cb118c1c (checked by running this file against that commit's sources) and passes now; each pairs the failing input with
a control that must keep its earlier result.  Expected values are written by hand, or derived in the test from the raw observation, never taken
from the code under test.  No model call; synthetic, generic inputs (no case name, title or file name of the suites)."""
import copy
import json
import re
import unittest

import th
import test_contract_v3_prereq as P3
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness.experimental.contract_v3 import facts as FX
from media_repair_harness.experimental.contract_v3 import links as LK
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import rubric as RB
from media_repair_harness.experimental.contract_v3 import targets as TG

ob, ctx, arr, states = P3.ob, P3.ctx, P3.arr, P3.states
PROBE, DAMAGE, CLEAN = P3.PROBE, P3.DAMAGE, P3.CLEAN
GOOD_PROBE = dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Lamp'}),
                  streams=[{'index': 0, 'codec_type': 'video', 'codec_name': 'h264', 'pix_fmt': 'yuv420p', 'width': 640, 'height': 360},
                           {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}])
RUBRIC_V31_SHA256 = '597570b72580dd4542ffe54458a478c33e11fe53740cd60d49563287b968f1e4'      # rubric v3.1 (the amendment), pinned


def healthy_states(res):
    return states(res, 'diagnosis', 'healthy')


def audit_states(a):
    return {p['id']: p['state'] for p in a['prerequisites']}


class Item1HealthySufficiency(unittest.TestCase):
    def test_audio_levels_alone_never_satisfy_h1(self):
        audio = ob('e3', 'audio_sample', {'rms_dbfs': -20.1, 'peak_dbfs': -3.0, 'silent_fraction': 0.0, 'samples': 64000}, args={'at': 0})
        failed_probe = ob('e1', 'ffprobe', {'exit_code': 1, 'stderr': 'media/x.mkv: Permission denied'}, status='error')
        self.assertEqual(healthy_states(PQ.check([failed_probe, audio], ctx(), 'tv'))['D-OK-H1'], 'unmet')
        self.assertEqual(healthy_states(PQ.check([ob('e1', 'ffprobe', GOOD_PROBE), audio], ctx(), 'tv'))['D-OK-H1'], 'met')      # control

    def test_a_decode_window_alone_leaves_m1_and_h1_open(self):
        win = ob('e2', 'decode_sample', CLEAN, args={'ss': 0, 't': 4})
        res = PQ.check([win], ctx(), 'tv')
        self.assertEqual(({m['id']: m['state'] for m in res['material']}['M1'], healthy_states(res)['D-OK-H1']), ('met', 'unmet'))
        ok = PQ.check([ob('e1', 'ffprobe', GOOD_PROBE), win], ctx(), 'tv')
        self.assertEqual(({m['id']: m['state'] for m in ok['material']}['M1'], healthy_states(ok)['D-OK-H1']), ('unmet', 'met'))

    def test_an_established_decoder_incompatibility_excludes_healthy(self):
        client = ctx(client_profile={'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac', 'containers': ['matroska']})
        bad = PQ.check([ob('e1', 'ffprobe', dict(GOOD_PROBE, streams=PROBE['streams']))], client, 'tv')      # hevc 10-bit: unsupported, only stream of type
        self.assertEqual(states(bad, 'diagnosis', 'decoder_incompatible'), {'D-DEC-1': 'met', 'D-DEC-2': 'met'})
        self.assertEqual(healthy_states(bad)['D-OK-H5'], 'unmet')
        self.assertIn('unmet', healthy_states(bad).values())
        good = PQ.check([ob('e1', 'ffprobe', GOOD_PROBE)], client, 'tv')
        self.assertEqual(set(healthy_states(good).values()), {'met'})

    def test_an_ambiguous_stream_selection_keeps_healthy_unmet(self):
        client = ctx(client_profile={'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac', 'containers': ['matroska']})
        two_audio = dict(GOOD_PROBE, streams=GOOD_PROBE['streams'] + [{'index': 2, 'codec_type': 'audio', 'codec_name': 'ac3', 'channels': 6}])
        res = PQ.check([ob('e1', 'ffprobe', two_audio)], client, 'tv')
        self.assertEqual({m['id']: m['state'] for m in res['material']}['M8'], 'met')
        self.assertIn('unmet', healthy_states(res).values())
        self.assertEqual(set(healthy_states(PQ.check([ob('e1', 'ffprobe', GOOD_PROBE)], client, 'tv')).values()), {'met'})


class Item2EmptyNotCheckedList(unittest.TestCase):
    CAPS = [{'tool': 'decode_sample', 'available': True, 'offsets_s': [0, 4, 8], 'window_s': 4, 'full_decode': 'recorded'}]

    def test_an_explicitly_empty_list_gives_no_window_candidate_and_a_missing_one_the_whole_file(self):
        empty = {'id': 'u1', 'scope': {'type': 'decode_interval', 'intervals': []}, 'sources': []}
        missing = {'id': 'u2', 'scope': {'type': 'decode_interval'}, 'sources': []}
        self.assertEqual([c['args'] for c in LK.links_for(empty, self.CAPS, [], ['decode_sample'])], [{'full': True}])
        self.assertEqual([c['args'] for c in LK.links_for(missing, self.CAPS, [], ['decode_sample'])], [{'at': 0}, {'at': 4}, {'at': 8}, {'full': True}])

    def test_a_fully_windowed_probe_item_gets_no_window_candidate(self):
        probe8 = dict(GOOD_PROBE, format=dict(GOOD_PROBE['format'], duration='8.0'))
        obs = [ob('e1', 'ffprobe', probe8), ob('e2', 'decode_sample', dict(CLEAN, ss=0), args={'ss': 0, 't': 4}),
               ob('e3', 'decode_sample', dict(CLEAN, ss=4), args={'ss': 4, 't': 4})]
        an = EV2.analyze(obs, {}, 'tv')
        items = LK.attach_links(LK.open_items(an, 'tv'), self.CAPS, obs, ['decode_sample'])
        win = [c for it in items for c in it['available_check'] if 'at' in c['args'] and c['availability'] == 'available']
        self.assertEqual(win, [])             # the coverage lists nothing unchecked: no window is an uncalled candidate


class Item3TargetsBoundToQualifyingFacts(unittest.TestCase):
    def blk(self, ref):
        return {'type': 'decision', 'class': 'corrupt_file', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e2'],
                'source': {'ref': ref}, 'target': {'kind': 'release_of_source', 'source_ref': ref}}

    def obs(self):
        return [ob('e2', 'decode_sample', DAMAGE, args={'ss': 4, 't': 4}), ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}))]

    def test_the_damage_observation_cannot_also_be_the_source_binding(self):
        bad = audit_states(TG.audit_v3(self.blk('e2'), self.obs(), ctx(), 'tv'))
        self.assertEqual(bad['R-SRC'], 'unmet')
        good = audit_states(TG.audit_v3(self.blk('e4'), self.obs(), ctx(), 'tv'))
        self.assertEqual(set(good.values()), {'met'})

    def rename(self, old, new):
        return {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e1'],
                'source': {'ref': 'e4'}, 'target': {'kind': 'rename_of_source', 'old_value': old, 'new_value': new}}

    def naming_obs(self, clean=True):
        o = [ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E02 / LAMP'}), ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E05 - Lamp.mkv'}))]
        if clean:
            o.insert(0, ob('e1', 'ffprobe', GOOD_PROBE))
        return o

    def test_a_content_observation_cannot_fill_a_slot_role(self):
        obs = [ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}),
               ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}, episode={'season': 1, 'episode': 2})),
               ob('e5', 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 3}), file=None))]
        d = {'type': 'decision', 'class': 'identity_mismatch', 'action': 'remap', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e3'],
             'source': {'ref': 'e4'}, 'target': {'kind': 'destination_slot', 'slot_ref': 'e3', 'slot_free_ref': 'e5'}}
        self.assertEqual(audit_states(TG.audit_v3(d, obs, ctx(), 'tv'))['R-SLOT'], 'unmet')       # the OCR result is not a destination record
        both_content = dict(d, target={'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e3'})
        self.assertEqual(audit_states(TG.audit_v3(both_content, obs, ctx(), 'tv'))['R-SLOT'], 'unmet')
        good = dict(d, target={'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e5'})
        self.assertEqual(set(audit_states(TG.audit_v3(good, obs, ctx(), 'tv')).values()), {'met'})

    def test_rename_values_must_match_visible_facts(self):
        c = ctx(filename='Alpha Show - S01E05 - Lamp.mkv')
        unseen = audit_states(TG.audit_v3(self.rename('never-shown.mkv', 'also-invented.mkv'), self.naming_obs(), c, 'tv'))
        self.assertEqual((unseen['R-OLD'], unseen['R-NEW']), ('unmet', 'unmet'))
        seen = audit_states(TG.audit_v3(self.rename('Alpha Show - S01E05 - Lamp.mkv', 'Alpha Show - S01E02 - Lamp.mkv'), self.naming_obs(), c, 'tv'))
        self.assertEqual((seen['R-OLD'], seen['R-NEW']), ('met', 'met'))
        self.assertEqual(set(seen.values()), {'met'})

    def test_a_write_needs_its_diagnosis_too(self):
        c = ctx(filename='Alpha Show - S01E05 - Lamp.mkv')
        no_clean = audit_states(TG.audit_v3(self.rename('Alpha Show - S01E05 - Lamp.mkv', 'Alpha Show - S01E02 - Lamp.mkv'), self.naming_obs(clean=False), c, 'tv'))
        self.assertEqual(no_clean['D-NAME-2'], 'unmet')


class Item4ProvenanceAndStatusEligibility(unittest.TestCase):
    def test_negated_methods_stay_unknown(self):
        for method in ('no OCR performed', 'OCR unavailable', 'subtitle text could not be read'):
            rep = ob('e3', 'prior_record', {'evidence_method': method, 'observed': {'content_titles': ['Totally Different Work']}})
            self.assertEqual(FX.report_kind(method), 'report_unknown', method)
            self.assertEqual(states(PQ.check([rep], ctx(), 'tv'), 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'unmet'}, method)
        positive = ob('e3', 'prior_record', {'evidence_method': 'reported embedded subtitle opening cards', 'observed': {'content_titles': ['Totally Different Work']}})
        self.assertEqual(states(PQ.check([positive], ctx(), 'tv'), 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'met'})

    def test_partial_ocr_supports_no_rename(self):
        for status, want in (('partial', 'unmet'), ('ok', 'met')):
            o = ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E02 / LAMP'}, status=status)
            self.assertEqual(states(PQ.check([o], ctx(), 'tv'), 'actions', 'rename')['A-REN-1'], want, status)

    def test_incomplete_catalog_records_support_no_source_binding(self):
        rec = arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'})
        for status, want in (('partial', 'unknown'), ('error', 'unknown'), ('timeout', 'unknown'), ('ok', 'met')):
            o = ob('e4', 'arr_lookup', rec, status=status)
            self.assertEqual(states(PQ.check([o], ctx(), 'tv'), 'actions', 'blocklist_and_search')['A-BLK-2'], want, status)


class Item5ConflictingDestinations(unittest.TestCase):
    def obs(self, free_id, occupied_id):
        return [ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}),
                ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}, episode={'season': 1, 'episode': 2})),
                ob(free_id, 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 3}), file=None)),
                ob(occupied_id, 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 3}), file={'relativePath': 'Alpha Show - S01E03 - Salt.mkv'}))]

    def test_free_and_occupied_records_leave_the_slot_unresolved_under_any_numbering(self):
        for free_id, occ_id in (('e5', 'e6'), ('e6', 'e5'), ('e9', 'e10'), ('e10', 'e9')):
            got = states(PQ.check(self.obs(free_id, occ_id), ctx(), 'tv'), 'actions', 'remap')
            self.assertEqual(got['A-MAP-4'], 'unknown', (free_id, occ_id))
        o = self.obs('e5', 'e6')                     # control: agreeing records establish the free slot
        o[3] = ob('e6', 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 3}), hasFile=False))
        self.assertEqual(states(PQ.check(o, ctx(), 'tv'), 'actions', 'remap')['A-MAP-4'], 'met')


class Item6IdentityAttributes(unittest.TestCase):
    def epub(self, **kw):
        d = {'status': 'ok', 'spine_items': 2, 'entries': 5, 'dc_title': 'Alpha Show', 'dc_creator': 'A. Writer', 'dc_language': 'en'}
        d.update(kw)
        return ob('e1', 'epub_inspect', d)

    BOOK = staticmethod(lambda: ctx(filename=None, title='Alpha Show', expected={'title': 'Alpha Show', 'author': 'A. Writer', 'language': 'en'},
                                    arr={'app': 'lazylibrarian', 'ids': {}}))

    def level(self, o, c=None):
        return PQ.check(o if isinstance(o, list) else [o], c or self.BOOK(), 'epub')['identity']['level']

    def test_list_valued_titles_and_creators_and_language_are_compared(self):
        self.assertEqual(self.level(self.epub(dc_title=['Wrong Book'])), 'contested')
        self.assertEqual(self.level(self.epub(dc_creator=['Other Person'])), 'contested')
        self.assertEqual(self.level(self.epub(dc_language='fr')), 'contested')
        self.assertEqual(self.level(self.epub(dc_language='fre')), 'contested')
        for ok in (self.epub(), self.epub(dc_title=['Alpha Show']), self.epub(dc_language='eng')):
            self.assertEqual(self.level(ok), 'uncontradicted')

    def test_a_matching_title_does_not_erase_a_year_disagreement(self):
        c = ctx(filename='Alpha Show (2011).mkv', title='Alpha Show (2019)', expected={'title': 'Alpha Show', 'year': 2019, 'runtime_s': 8}, arr={'app': 'radarr', 'ids': {}})
        ocr = ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW'})
        self.assertEqual(PQ.check([ocr], c, 'movie')['identity']['level'], 'contested')
        c2 = copy.deepcopy(c)
        c2['filename'] = 'Alpha Show (2019).mkv'
        self.assertEqual(PQ.check([ocr], c2, 'movie')['identity']['level'], 'content_verified')

    def test_a_file_name_naming_no_title_is_not_a_title_disagreement(self):
        c = ctx(filename='as.s01e02.1080p.web.h264-grp.mkv')         # an abbreviated release name: it names no title, and its marker agrees
        self.assertEqual(PQ.check([ob('e1', 'ffprobe', GOOD_PROBE)], c, 'tv')['identity']['level'], 'uncontradicted')
        typed = dict(GOOD_PROBE, format=dict(GOOD_PROBE['format'], tags={'title': 'Some Other Programme'}))
        self.assertEqual(PQ.check([ob('e1', 'ffprobe', typed)], c, 'tv')['identity']['level'], 'contested')       # a typed title field can disagree

    def test_null_is_not_empty(self):
        self.assertEqual(states(PQ.check([self.epub(dc_title=None)], self.BOOK(), 'epub'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet')
        self.assertEqual(states(PQ.check([self.epub(dc_title='')], self.BOOK(), 'epub'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'met')

    def test_a_choice_that_names_no_listed_candidate_does_not_settle(self):
        eds = {'Long Cut': {'runtime_s': 8.4}, 'Short Cut': {'runtime_s': 8}}
        c = ctx(expected={'title': 'Alpha Show', 'runtime_s': 8})
        m7 = lambda rec: {m['id']: m['state'] for m in PQ.check([ob('e1', 'ffprobe', PROBE), ob('e2', 'arr_lookup', rec)], c, 'movie')['material']}['M7']
        self.assertEqual(m7(arr(editions=eds, wanted_edition='Nonexistent Cut')), 'met')
        self.assertEqual(m7(arr(editions=eds, wanted_edition='Short Cut')), 'unmet')


def raw_expect(raw, path):
    """Independent of the code under test: (present?, value) of `path` in a raw JSON object."""
    cur = raw
    for k in path:
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        elif isinstance(cur, list) and isinstance(k, int) and k < len(cur):
            cur = cur[k]
        else:
            return False, None
    return True, cur


class Item7EmptyValuesRendered(unittest.TestCase):
    def rendered(self, o, media='tv'):
        r = FX.render([o], {}, media, [o['tool']], [])
        return r['reference']['facts'].get(o['id'], {}), (r['reference'].get('presence') or {}).get(o['id'], {})

    def test_audio_rms_missing_and_null_render_differently_as_the_raw_data_says(self):
        rendered = {}
        for name, raw in (('missing', {'peak_dbfs': -3.0, 'silent_fraction': 0.0, 'samples': 64000}), ('null', {'rms_dbfs': None, 'peak_dbfs': -3.0, 'silent_fraction': 0.0, 'samples': 64000})):
            facts, presence = self.rendered(ob('e1', 'audio_sample', raw, args={'at': 0}))
            present, value = raw_expect(raw, ('rms_dbfs',))
            self.assertEqual(('rms_dbfs' in facts, facts.get('rms_dbfs')), (present, value), name)
            self.assertEqual(presence.get('rms_dbfs'), 'null' if present and value is None else None, name)
            rendered[name] = json.dumps([facts, presence], sort_keys=True)
        self.assertNotEqual(rendered['missing'], rendered['null'])

    def test_live_audiobook_part_tags_missing_and_empty_render_differently_as_the_raw_data_says(self):
        rendered = {}
        for name, tags in (('missing', None), ('empty', {}), ('null', 'NULL')):
            part = {'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok'}
            if tags is not None:
                part['tags'] = None if tags == 'NULL' else tags
            raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': ['probe'], 'not_verified': []},
                   'output': {'parts': 1, 'parts_probed': 1, 'files': [part]}}
            facts, presence = self.rendered(ob('t1', 'audiobook_inspect', raw, backend='live', source='tool'), 'audiobook')
            present, value = raw_expect(raw, ('output', 'files', 0, 'tags'))
            el = facts['files'][0]
            self.assertEqual(('tags' in el, el.get('tags')), (present, value), name)
            rendered[name] = json.dumps([facts, presence], sort_keys=True)
        self.assertEqual(len(set(rendered.values())), 3)

    def test_v2_facts_stay_a_sub_multiset(self):
        raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': [], 'not_verified': []},
               'output': {'parts': 1, 'parts_probed': 1, 'files': [{'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok', 'tags': {}}]}}
        o = [ob('t1', 'audiobook_inspect', raw, backend='live', source='tool')]
        v2, _ = FX.canonical_facts(o, {}, 'audiobook', 'v2')
        v3, _ = FX.canonical_facts(o, {}, 'audiobook', 'v3')
        rest = list(v3)
        for f in v2:
            rest.remove(f)
        self.assertEqual([(f[8], f[9]) for f in rest], [('files[0].tags', 'empty')])


class Item8MalformedDecisions(unittest.TestCase):
    BASE = {'type': 'decision', 'class': 'corrupt_file', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e2'],
            'source': {'ref': 'e4'}, 'target': {'kind': 'release_of_source', 'source_ref': 'e4'}}

    def test_malformed_fields_are_refused_without_raising_and_before_resolution(self):
        bad = [('source', {'ref': ['e4']}), ('source', {'ref': {'x': 1}}), ('confidence', 'high'), ('confidence', 2.0), ('confidence', True),
               ('reason', 'x' * 401), ('reason', 5), ('evidence_refs', ['e1', 5]), ('evidence_refs', 'e1'), ('class', ['corrupt_file']),
               ('target', {'kind': 'release_of_source', 'source_ref': ['e4']})]
        obs = Item3TargetsBoundToQualifyingFacts().obs()
        for key, val in bad:
            d = dict(self.BASE, **{key: val})
            self.assertTrue(TG.validate_decision_v3(d), (key, val))
            a = TG.audit_v3(d, obs, ctx(), 'tv')
            self.assertTrue(a['schema_errors'], (key, val))
            self.assertNotIn('references', a, (key, val))
            self.assertNotIn('prerequisites', a, (key, val))
        self.assertEqual(TG.validate_decision_v3(self.BASE), [])
        self.assertIn('prerequisites', TG.audit_v3(self.BASE, obs, ctx(), 'tv'))


class Item9PageOnlyReconstruction(unittest.TestCase):
    def test_omitted_veto_alerts_make_the_reconstruction_fail(self):
        live = {'tool': 'epub', 'status': 'ok', 'coverage': {'verified': ['zip_open'], 'not_verified': []},
                'output': {'valid': False, 'stages_passed': ['zip_open'], 'findings': []}}
        obs = [ob('t1', 'epub_inspect', live, backend='live', source='tool')]
        r = FX.render(obs, {}, 'epub', ['epub_inspect'], [])
        self.assertTrue(any(a.get('type') == 'collector_verdict' for a in r['pages'][0]['alerts']))
        self.assertEqual(FX.facts_from_body(FX.reassemble(r['pages'])), r['facts'])                     # control: the pages hold everything
        stripped = copy.deepcopy(r['pages'])
        for p in stripped:
            p['alerts'] = [a for a in p['alerts'] if a.get('type') != 'collector_verdict']
        self.assertNotEqual(FX.facts_from_body(FX.reassemble(stripped)), r['facts'])
        no_item_veto = copy.deepcopy(r['pages'])
        for p in no_item_veto:
            for it in p.get('items') or []:
                it.pop('veto', None)
        self.assertNotEqual(FX.facts_from_body(FX.reassemble(no_item_veto)), r['facts'])

    def test_the_oracle_takes_the_pages_only(self):
        import inspect
        self.assertEqual(list(inspect.signature(FX.facts_from_body).parameters), ['body'])


class Item10RubricVersioning(unittest.TestCase):
    def test_v30_is_unchanged_and_v31_is_a_separate_versioned_amendment(self):
        self.assertEqual(RB.sha256(), P3.RUBRIC_SHA256)
        self.assertEqual(RB.RUBRIC['version'], 'contract-v3-rubric-1')
        self.assertEqual((RB.RUBRIC_V31['version'], RB.RUBRIC_V31['amends']), ('contract-v3-rubric-3.1', 'contract-v3-rubric-1'))
        self.assertEqual(RB.sha256_v31(), RUBRIC_V31_SHA256)
        table = json.loads((th.COMPONENT / 'docs' / 'contract-v3-prerequisites-v3.1.json').read_text(encoding='utf-8'))
        self.assertEqual(table, json.loads(RB.canonical_json_v31()))
        doc = (th.COMPONENT / 'docs' / 'contract-v3.md').read_text(encoding='utf-8')
        sec = doc.split('## 14. Rubric amendment v3.1', 1)
        self.assertEqual(len(sec), 2)
        for a in RB.AMENDMENTS_V31:
            self.assertIn(a['id'], sec[1])
        self.assertIn('after labels had been read', sec[1])
        self.assertIn('covers the rubric only', doc)

    @unittest.skipUnless((P3.th.REPO_ROOT / '.agents/context/media-repair-harness-2026-10-19/suite-dev-v1.1/cases').is_dir() or __import__('os').environ.get('MRH_REQUIRE_SUITE') == '1', 'suite')
    def test_no_public_case_title_in_the_prototype_sources(self):
        suite = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1' / 'cases'
        titles = set()
        for p in sorted(suite.glob('*.json')):
            c = json.loads(p.read_text())
            exp = (c.get('context') or {}).get('expected') or {}
            for v in (exp.get('title'), exp.get('series'), exp.get('episode_title')):
                if isinstance(v, str) and len(v) >= 6:
                    titles.add(re.sub(r'^(?:the|a|an) ', '', v.lower()))
        self.assertTrue(titles)
        from pathlib import Path
        src = Path(PQ.__file__).resolve().parent         # the sources actually imported
        for f in sorted(src.glob('*.py')):
            text = f.read_text().lower()
            for t in titles:
                self.assertNotIn(t, text, (f.name, t))


if __name__ == '__main__':
    unittest.main()
