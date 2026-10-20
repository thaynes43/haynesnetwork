"""Contract v3 prerequisites, source binding versus targets and versioning (WO-W20 items 3 and 4, A16 items 2, 5 and 6).

The checker receives blinded inputs (a neutral alias, no truth, no case name); expected states are written by hand from the raw observations.
Paired negatives everywhere: the same observation with the one value that matters changed."""
import copy
import json
import re
import unittest

import th
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import rubric as RB
from media_repair_harness.experimental.contract_v3 import targets as TG

RUBRIC_SHA256 = '9e89128a911806d0c41956acc8b6678686116b539a367d5d0a4faa43672d0309'           # frozen in commit 59e15d49, before any label was read
FROZEN_BLOCK_SHA256 = '4a9d92ea290625a37e47bad7019aa11caac0fb00ef7aa66980c4c1f4324891b8'


def ob(i, tool, out, status='ok', args=None, backend=None, source='case'):
    return EV2.make_observation(i, tool, args or {}, status, out if isinstance(out, str) else json.dumps(out), backend, source)


PROBE = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'matroska,webm', 'duration': '8.0', 'tags': {}},
         'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'hevc', 'pix_fmt': 'yuv420p10le', 'width': 640, 'height': 360},
                     {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2}]}
DAMAGE = {'exit_code': 0, 'frames': 27, 'out_time': '00:00:04.000000', 'stderr': '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5', 'ss': 4, 't': 4}
CLEAN = {'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '', 'ss': 0, 't': 4}


def ctx(**kw):
    c = {'title': 'Alpha Show S01E02', 'filename': 'Alpha Show - S01E02 - Lamp.mkv', 'expected': {'series': 'Alpha Show', 'season': 1, 'episode': 2, 'episode_title': 'Lamp', 'runtime_s': 8},
         'arr': {'app': 'sonarr', 'ids': {'episodeFileId': 7}}, 'notes_for_model': 'n'}
    c.update(kw)
    return c


def arr(file=None, episode=None, **kw):
    d = {'app': 'sonarr', 'series': 'Alpha Show'}
    if file is not None:
        d['file'] = file
    if episode is not None:
        d['episode'] = episode
    d.update(kw)
    return d


def states(res, section, key):
    return {r['id']: r['state'] for r in (res[section][key] if section == 'diagnosis' else res[section][key]['prerequisites'])}


class FrozenRubric(unittest.TestCase):
    def test_the_rubric_data_and_its_document_block_are_the_frozen_ones(self):
        self.assertEqual(RB.sha256(), RUBRIC_SHA256)
        doc = (th.COMPONENT / 'docs' / 'contract-v3.md').read_text(encoding='utf-8')
        m = re.search(r'<!-- BEGIN FROZEN RUBRIC contract-v3-rubric-1 -->\n(.*?)<!-- END FROZEN RUBRIC contract-v3-rubric-1 -->', doc, re.S)
        import hashlib
        self.assertEqual(hashlib.sha256(m.group(1).encode()).hexdigest(), FROZEN_BLOCK_SHA256)

    def test_the_machine_readable_table_is_the_rubric(self):
        doc = json.loads((th.COMPONENT / 'docs' / 'contract-v3-prerequisites.json').read_text(encoding='utf-8'))
        self.assertEqual(doc, json.loads(RB.canonical_json()))

    def test_no_full_decode_is_a_prerequisite_and_identity_never_comes_from_integrity(self):
        blob = json.dumps(RB.RUBRIC)
        for action, spec in RB.ACTIONS.items():
            self.assertNotIn('full_decode', json.dumps(spec['prerequisites']), action)
        for name in ('identity_disagreement', 'identity_agreement'):
            self.assertIn('integrity', RB.CHECKS[name]['never'])
            self.assertIn('declaration', RB.CHECKS[name]['never'])
            self.assertIn('report_hash', RB.CHECKS[name]['never'])
        self.assertIn('a destination name from the model', RB.ACTIONS['convert']['not_prerequisites'])
        self.assertNotIn('case_id', blob)

    def test_no_output_field_is_a_verdict(self):
        res = PQ.check([ob('e1', 'ffprobe', PROBE)], ctx(), 'tv')
        keys = set()

        def walk(v):
            if isinstance(v, dict):
                keys.update(v)
                for x in v.values():
                    walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
        walk(res)
        self.assertFalse(keys & set(RB.FORBIDDEN_FIELDS), keys & set(RB.FORBIDDEN_FIELDS))


class Integrity(unittest.TestCase):
    def test_located_damage_establishes_corrupt_and_its_support_grade_depends_on_execution(self):
        ok = PQ.check([ob('e1', 'decode_sample', DAMAGE, args={'ss': 4, 't': 4})], ctx(), 'tv')
        self.assertEqual(states(ok, 'diagnosis', 'corrupt_file'), {'D-COR-1': 'met'})
        self.assertEqual(states(ok, 'actions', 'blocklist_and_search')['A-BLK-3'], 'met')
        part = PQ.check([ob('e1', 'decode_sample', DAMAGE, status='partial', args={'ss': 4, 't': 4})], ctx(), 'tv')
        self.assertEqual(states(part, 'diagnosis', 'corrupt_file'), {'D-COR-1': 'met'})           # a partial result keeps its positive finding for the diagnosis
        self.assertEqual(states(part, 'actions', 'blocklist_and_search')['A-BLK-3'], 'unmet')     # but cannot support the write
        tool_fail = PQ.check([ob('e1', 'decode_sample', {'exit_code': 1, 'stderr': 'Permission denied'}, status='error')], ctx(), 'tv')
        self.assertEqual(states(tool_fail, 'diagnosis', 'corrupt_file'), {'D-COR-1': 'unmet'})
        warn = {'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '[h264 @ 0x0] non-existing PPS 0 referenced', 't': 4}
        w = PQ.check([ob('e1', 'decode_sample', warn)], ctx(), 'tv')
        self.assertEqual(states(w, 'diagnosis', 'corrupt_file'), {'D-COR-1': 'unmet'})
        uncls = dict(warn, stderr='something nobody classified')
        u = PQ.check([ob('e1', 'ffprobe', dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Lamp'}))), ob('e2', 'decode_sample', uncls)], ctx(), 'tv')
        self.assertEqual({m['id']: m['state'] for m in u['material']}['M2'], 'met')

    def test_healthy_needs_no_full_decode_and_never_treats_unchecked_as_clean(self):
        good_probe = dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Lamp'}))
        obs = [ob('e1', 'ffprobe', good_probe), ob('e2', 'decode_sample', CLEAN, args={'ss': 0, 't': 4})]
        res = PQ.check(obs, ctx(), 'tv')
        self.assertEqual(states(res, 'diagnosis', 'healthy'), {'D-OK-H1': 'met', 'D-OK-H2': 'met', 'D-OK-H3': 'met', 'D-OK-H4': 'met'})
        self.assertIn([4.0, 8.0], res and EV2.analyze(obs)['coverage']['time']['unrecorded']['not_checked'])   # the remainder stays listed as not checked
        long_ = PQ.check(obs, ctx(expected=dict(ctx()['expected'], runtime_s=60)), 'tv')                   # a signal into the remainder: runtime disagrees
        self.assertEqual(states(long_, 'diagnosis', 'healthy')['D-OK-H3'], 'unmet')
        none = PQ.check([ob('e1', 'ffprobe', 'ffprobe exceeded the 60 s tool timeout', status='timeout')], ctx(), 'tv')
        self.assertEqual(states(none, 'diagnosis', 'healthy')['D-OK-H1'], 'unmet')


class Identity(unittest.TestCase):
    def test_content_can_contradict_identity_but_tags_reported_hashes_and_clean_decodes_cannot(self):
        ocr_other = ob('e2', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'})
        res = PQ.check([ob('e1', 'decode_sample', CLEAN), ocr_other], ctx(), 'tv')
        self.assertEqual((res['identity']['level'], states(res, 'diagnosis', 'identity_mismatch')), ('contradicted_by_content', {'D-ID-1': 'met'}))
        ocr_same = ob('e2', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E02 / LAMP'})
        self.assertEqual(PQ.check([ocr_same], ctx(), 'tv')['identity']['level'], 'content_verified')
        tag_other = ob('e1', 'ffprobe', dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Totally Different Work'})))
        res2 = PQ.check([tag_other, ob('e2', 'decode_sample', CLEAN)], ctx(), 'audiobook')
        self.assertEqual((res2['identity']['level'], states(res2, 'diagnosis', 'identity_mismatch')), ('contested', {'D-ID-1': 'unmet'}))
        hash_rep = ob('e3', 'prior_record', {'evidence_method': 'reported duplicate MD5 of another book', 'observed': {'content_titles': ['Totally Different Work']}})
        self.assertEqual(states(PQ.check([hash_rep], ctx(), 'epub'), 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'unmet'})
        opf_rep = ob('e3', 'prior_record', {'evidence_method': 'EPUB OPF', 'observed': {'content_titles': ['Totally Different Work']}})
        self.assertEqual(states(PQ.check([opf_rep], ctx(), 'epub'), 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'unmet'})
        cards = ob('e3', 'prior_record', {'evidence_method': 'reported embedded subtitle opening cards', 'observed': {'content_titles': ['Totally Different Work']}})
        self.assertEqual(states(PQ.check([cards], ctx(), 'tv'), 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'met'})

    def test_a_fragment_of_a_catalog_name_is_not_agreement(self):
        for text in ('SHOW', 'THE', 'Part'):
            res = PQ.check([ob('e2', 'ocr', {'t_s': 1.0, 'text': text})], ctx(), 'tv')
            self.assertEqual(res['identity']['level'], 'uncontradicted', text)
        two = dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Show Lamp'}))
        c = ctx(expected={'title': 'The Alpha Show Lamp', 'runtime_s': 8})
        self.assertEqual([r['state'] for r in PQ.check([ob('e1', 'ffprobe', two)], c, 'audiobook')['identity']['comparisons'] if r['field'] == 'tag_title'], ['agree'])
        one = dict(PROBE, format=dict(PROBE['format'], tags={'title': 'Lamp'}))
        self.assertEqual([r['state'] for r in PQ.check([ob('e1', 'ffprobe', one)], c, 'audiobook')['identity']['comparisons'] if r['field'] == 'tag_title'], ['disagree'])

    def test_source_binding_reads_every_record_of_this_item(self):
        dest_first = [ob('e5', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E03 - Salt.mkv'}, episode={'season': 1, 'episode': 3})),
                      ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}, episode={'season': 1, 'episode': 2}))]
        for obs in (dest_first, list(reversed(dest_first))):
            self.assertEqual(states(PQ.check(obs, ctx(), 'tv'), 'actions', 'blocklist_and_search')['A-BLK-2'], 'met')
        self.assertEqual(states(PQ.check(dest_first[:1], ctx(), 'tv'), 'actions', 'blocklist_and_search')['A-BLK-2'], 'unknown')
        by_id = [ob('e4', 'arr_lookup', arr(file={'relativePath': 'renamed.mkv', 'id': 7}, episode={'season': 1, 'episode': 2}))]
        self.assertEqual(states(PQ.check(by_id, ctx(), 'tv'), 'actions', 'blocklist_and_search')['A-BLK-2'], 'met')

    def test_free_text_that_mentions_nothing_is_not_a_disagreement(self):
        res = PQ.check([ob('e2', 'ocr', {'t_s': 1.0, 'text': 'EXIT'})], ctx(), 'tv')
        self.assertEqual(res['identity']['level'], 'uncontradicted')
        self.assertEqual(states(res, 'diagnosis', 'identity_mismatch'), {'D-ID-1': 'unknown'})

    def test_consistent_identifier_and_title_substitution_and_permutation_change_no_state(self):
        obs = [ob('e1', 'ffprobe', PROBE), ob('e2', 'decode_sample', DAMAGE, args={'ss': 4, 't': 4}), ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}),
               ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}))]
        base = PQ.check(obs, ctx(), 'tv')

        def sub(text):
            return text.replace('Alpha Show', 'Qux Vale').replace('ALPHA SHOW', 'QUX VALE').replace('Lamp', 'Ember').replace('LAMP', 'EMBER')
        obs2 = [dict(o, output=sub(o['output'])) for o in obs]
        c2 = json.loads(sub(json.dumps(ctx())))
        self.assertEqual(PQ.check(obs2, c2, 'tv'), base)
        rev = list(reversed(obs))
        got = PQ.check(rev, ctx(), 'tv')
        self.assertEqual(got['diagnosis'], base['diagnosis'])
        self.assertEqual({k: [(p['id'], p['state']) for p in v['prerequisites']] for k, v in got['actions'].items()},
                         {k: [(p['id'], p['state']) for p in v['prerequisites']] for k, v in base['actions'].items()})


class NamingAndPresence(unittest.TestCase):
    def test_explicit_empty_tags_are_a_naming_defect_for_an_audiobook_and_absent_tags_are_not(self):
        empty = dict(PROBE, streams=[PROBE['streams'][1]], format=dict(PROBE['format'], tags={}))
        absent = dict(PROBE, streams=[PROBE['streams'][1]], format={k: v for k, v in PROBE['format'].items() if k != 'tags'})
        c = ctx(filename=None, title='Alpha Show', expected={'title': 'Alpha Show', 'author': 'A. Writer'}, arr={'app': 'lazylibrarian', 'ids': {}})
        self.assertEqual(states(PQ.check([ob('e1', 'ffprobe', empty)], c, 'audiobook'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'met')
        self.assertEqual(states(PQ.check([ob('e1', 'ffprobe', absent)], c, 'audiobook'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet')
        self.assertEqual(states(PQ.check([ob('e1', 'ffprobe', empty)], c, 'movie'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet')   # not a naming surface for a movie
        res = PQ.check([ob('e1', 'ffprobe', empty)], c, 'audiobook')
        self.assertEqual(states(res, 'diagnosis', 'metadata_naming'), {'D-NAME-1': 'met', 'D-NAME-2': 'met', 'D-NAME-3': 'met'})
        self.assertEqual(states(res, 'actions', 'rename')['A-REN-1'], 'unmet')        # the write needs content-verified identity; tags and chapters are not content

    def test_null_false_zero_are_not_empty(self):
        for value in (None, False, 0):
            p = dict(PROBE, format=dict(PROBE['format'], tags={'title': value}))
            self.assertEqual(states(PQ.check([ob('e1', 'ffprobe', p)], ctx(), 'audiobook'), 'diagnosis', 'metadata_naming')['D-NAME-1'], 'unmet', value)


class OrderingCandidates(unittest.TestCase):
    def test_two_listed_editions_count_only_when_the_observations_fit_both(self):
        eds = {'Long Cut': {'runtime_s': 12}, 'Short Cut': {'runtime_s': 8}}
        c = ctx(expected={'title': 'Alpha Show', 'runtime_s': 8})
        one = PQ.check([ob('e1', 'ffprobe', PROBE), ob('e2', 'arr_lookup', arr(editions=eds))], c, 'movie')         # 8 s: only the short cut fits
        self.assertEqual(states(one, 'diagnosis', 'order_edition_ambiguity')['D-ORD-1'], 'unmet')
        both = dict(eds, **{'Long Cut': {'runtime_s': 8.4}})
        two = PQ.check([ob('e1', 'ffprobe', PROBE), ob('e2', 'arr_lookup', arr(editions=both))], c, 'movie')
        self.assertEqual(states(two, 'diagnosis', 'order_edition_ambiguity'), {'D-ORD-1': 'met', 'D-ORD-2': 'met'})
        chosen = PQ.check([ob('e1', 'ffprobe', PROBE), ob('e2', 'arr_lookup', arr(editions=both, wanted_edition='Short Cut'))], c, 'movie')
        self.assertEqual(states(chosen, 'diagnosis', 'order_edition_ambiguity')['D-ORD-2'], 'unmet')


class SourceAndTargets(unittest.TestCase):
    def decision(self, action, cls, target, source='e4'):
        d = {'type': 'decision', 'class': cls, 'action': action, 'reason': 'r', 'confidence': 0.7, 'evidence_refs': ['e2']}
        if source is not None:
            d['source'] = {'ref': source}
        d['target'] = target
        return d

    def obs(self, file_rel='Alpha Show - S01E02 - Lamp.mkv'):
        return [ob('e2', 'decode_sample', DAMAGE, args={'ss': 4, 't': 4}), ob('e4', 'arr_lookup', arr(file={'relativePath': file_rel}))]

    def test_verified_source_and_missing_source_identity(self):
        d = self.decision('blocklist_and_search', 'corrupt_file', {'kind': 'release_of_source', 'source_ref': 'e4'})
        a = TG.audit_v3(d, self.obs(), ctx(), 'tv')
        self.assertEqual((a['schema_errors'], {p['id']: p['state'] for p in a['prerequisites']}),
                         ([], {'A-CLASS': 'met', 'A-BLK-1': 'met', 'A-BLK-2': 'met', 'A-BLK-3': 'met'}))
        other = TG.audit_v3(d, self.obs('Someone Else.mkv'), ctx(), 'tv')
        self.assertEqual({p['id']: p['state'] for p in other['prerequisites']}['A-BLK-2'], 'unmet')
        unknown = TG.audit_v3(d, self.obs()[:1], ctx(), 'tv')
        self.assertEqual({p['id']: p['state'] for p in unknown['prerequisites']}['A-BLK-2'], 'unknown')
        self.assertIn('source', ' '.join(TG.validate_decision_v3(self.decision('blocklist_and_search', 'corrupt_file', {'kind': 'release_of_source', 'source_ref': 'e4'}, source=None))))
        self.assertIs(a['executed'], False)

    def test_convert_names_no_destination_and_an_invented_one_is_refused(self):
        ok = self.decision('convert', 'decoder_incompatible', {'kind': 'isolated_copy', 'allocated_by': 'executor'})
        self.assertEqual(TG.validate_decision_v3(ok), [])
        invented = self.decision('convert', 'decoder_incompatible', {'kind': 'isolated_copy', 'allocated_by': 'executor', 'path': '/isolated/x.h264.mkv'})
        self.assertTrue(TG.validate_decision_v3(invented))
        named = self.decision('convert', 'decoder_incompatible', {'kind': 'isolated_copy', 'allocated_by': 'model'})
        self.assertTrue(any('executor' in e for e in TG.validate_decision_v3(named)))
        client = ctx(client_profile={'video': 'h264, 8-bit yuv420p, up to 1080p', 'audio': 'aac', 'containers': 'mkv'})
        a = TG.audit_v3(ok, [ob('e1', 'ffprobe', PROBE), ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}))], client, 'tv')
        got = {p['id']: p['state'] for p in a['prerequisites']}
        self.assertEqual(got, {'A-CLASS': 'met', 'A-CNV-0': 'met', 'A-CNV-1': 'met', 'A-CNV-2': 'met'})     # no destination, no full decode among them
        self.assertTrue(any('no-overwrite' in e['text'] for e in a['execution_prerequisites']))

    def test_remap_needs_an_evidenced_free_slot_and_an_occupied_one_is_still_refused(self):
        obs = [ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}), ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'})),
               ob('e5', 'arr_lookup', arr(file=None, episode={'season': 1, 'episode': 3, 'title': 'Salt'}, hasFile=False))]
        d = self.decision('remap', 'identity_mismatch', {'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e5'})
        got = {p['id']: p['state'] for p in TG.audit_v3(d, obs, ctx(), 'tv')['prerequisites']}
        self.assertEqual(got, {'A-CLASS': 'met', 'A-MAP-1': 'met', 'A-MAP-2': 'met', 'A-MAP-3': 'met', 'A-MAP-4': 'met'})
        occupied = copy.deepcopy(obs)
        occupied[2] = ob('e5', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E03 - Salt.mkv'}, episode={'season': 1, 'episode': 3, 'title': 'Salt'}))
        self.assertEqual({p['id']: p['state'] for p in TG.audit_v3(d, occupied, ctx(), 'tv')['prerequisites']}['A-MAP-4'], 'unmet')
        silent = copy.deepcopy(obs)
        silent[2] = ob('e5', 'arr_lookup', {'app': 'sonarr', 'episode': {'season': 1, 'episode': 3, 'title': 'Salt'}})
        self.assertEqual({p['id']: p['state'] for p in TG.audit_v3(d, silent, ctx(), 'tv')['prerequisites']}['A-MAP-4'], 'unknown')   # absent is not evidence

    def remap_obs(self, dest_file, order=None):
        src = ob('e4', 'arr_lookup', arr(file={'relativePath': 'Alpha Show - S01E02 - Lamp.mkv'}, episode={'season': 1, 'episode': 2, 'title': 'Lamp'}))
        dest = ob('e5', 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 3, 'title': 'Salt'}), file=dest_file))     # an explicit null file: no linked file
        other = ob('e6', 'arr_lookup', dict(arr(episode={'season': 1, 'episode': 9, 'title': 'Far'}), file=None))
        obs = [ob('e3', 'ocr', {'t_s': 1.0, 'text': 'ALPHA SHOW / S01E03 / SALT'}), src, dest, other]
        return [obs[i] for i in order] if order else obs

    def test_free_slot_reads_the_destination_record_whatever_the_order(self):
        d = self.decision('remap', 'identity_mismatch', {'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e5'})
        for order in (None, [0, 2, 1, 3], [3, 1, 2, 0], [2, 3, 0, 1]):
            got = {p['id']: p['state'] for p in TG.audit_v3(d, self.remap_obs(None, order), ctx(), 'tv')['prerequisites']}
            self.assertEqual((got['A-MAP-2'], got['A-MAP-3'], got['A-MAP-4']), ('met', 'met', 'met'), order)       # the source's own linked file is not the destination
            occ = {p['id']: p['state'] for p in TG.audit_v3(d, self.remap_obs({'relativePath': 'x.mkv'}, order), ctx(), 'tv')['prerequisites']}
            self.assertEqual(occ['A-MAP-4'], 'unmet', order)

    def test_without_a_catalog_episode_the_item_comes_from_the_record_of_this_file_in_any_order(self):
        c = ctx(expected={'series': 'Alpha Show', 'runtime_s': 8})          # the context names no season or episode
        d = self.decision('remap', 'identity_mismatch', {'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e5'})
        seen = set()
        for order in (None, [0, 2, 1, 3], [2, 1, 0, 3], [3, 2, 1, 0]):
            got = {p['id']: p['state'] for p in TG.audit_v3(d, self.remap_obs(None, order), c, 'tv')['prerequisites']}
            seen.add((got['A-MAP-2'], got['A-MAP-3'], got['A-MAP-4']))
        self.assertEqual(seen, {('met', 'met', 'met')})

    def test_a_free_record_of_another_item_cannot_stand_for_an_occupied_destination(self):
        d = self.decision('remap', 'identity_mismatch', {'kind': 'destination_slot', 'slot_ref': 'e5', 'slot_free_ref': 'e6'})
        got = {p['id']: p['state'] for p in TG.audit_v3(d, self.remap_obs({'relativePath': 'x.mkv'}), ctx(), 'tv')['prerequisites']}
        self.assertEqual(got['A-MAP-4'], 'unmet')
        wrong_cite = {p['id']: p['state'] for p in TG.audit_v3(d, self.remap_obs(None), ctx(), 'tv')['prerequisites']}
        self.assertEqual(wrong_cite['A-MAP-4'], 'unknown')          # the destination is free, but the proposal cites another record for it

    def test_rename_needs_old_and_new_values(self):
        self.assertTrue(TG.validate_decision_v3(self.decision('rename', 'metadata_naming', {'kind': 'rename_of_source', 'old_value': 'a.mkv', 'new_value': 'a.mkv'})))
        self.assertTrue(TG.validate_decision_v3(self.decision('rename', 'metadata_naming', {'kind': 'rename_of_source', 'old_value': 'a.mkv'})))
        self.assertEqual(TG.validate_decision_v3(self.decision('rename', 'metadata_naming', {'kind': 'rename_of_source', 'old_value': 'a.mkv', 'new_value': 'b.mkv'})), [])
        self.assertTrue(TG.validate_decision_v3({'type': 'decision', 'class': 'healthy', 'action': 'none', 'reason': 'r', 'confidence': 1, 'evidence_refs': [], 'target': {'kind': 'x'}}))


class Versions(unittest.TestCase):
    V3 = dict(evidence_format='v3', protocol='turn-v3', audit='v3', target_semantics='v3', schema='decision-v3')

    def test_unchanged_v5_with_the_v3_target_semantics_is_refused(self):
        with self.assertRaises(ValueError) as e:
            TG.check_contract_combination('v5', **self.V3)
        self.assertIn('v5', str(e.exception))
        for pv in ('v1', 'v2', 'v3', 'v4'):
            with self.assertRaises(ValueError):
                TG.check_contract_combination(pv, **self.V3)

    def test_v3_is_one_version_all_or_nothing(self):
        for k in self.V3:
            partial = {k: self.V3[k]}
            with self.assertRaises(ValueError):
                TG.check_contract_combination('v6-draft', declared=('v6-draft',), **partial)
        TG.check_contract_combination('v6-draft', declared=('v6-draft',), **self.V3)          # a prompt that declares v3: accepted
        with self.assertRaises(ValueError):
            TG.check_contract_combination('v6-draft', declared=('v6-draft',), guards='v3', **self.V3)

    def test_the_decision_schema_is_part_of_the_one_version(self):
        mixed = dict(self.V3, schema='decision-v2')
        with self.assertRaises(ValueError) as e:
            TG.check_contract_combination('v6-draft', declared=('v6-draft',), **mixed)
        self.assertIn('schema', str(e.exception))
        with self.assertRaises(ValueError):
            TG.check_contract_combination('v5', evidence_format='v2', guards='v3', schema='decision-v3')

    def test_without_v3_the_existing_rules_decide_unchanged(self):
        TG.check_contract_combination('v5', evidence_format='v2', guards='v3')
        TG.check_contract_combination('v4')
        with self.assertRaises(ValueError):
            TG.check_contract_combination('v5')                  # v5 still needs format v2
        with self.assertRaises(ValueError):
            TG.check_contract_combination('v3', evidence_format='v2')


if __name__ == '__main__':
    unittest.main()
