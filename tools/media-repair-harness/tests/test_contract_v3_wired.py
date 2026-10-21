"""dev-c6 (WO-W21): contract v3 WIRED into the runner as one opt-in configuration (`--prompt v6 --evidence-format v3`, guards off or v3), end to end with scripted
models, plus synthetic PAIRED regressions.  Fake model replies only, synthetic generic fixtures; no model, no network.  The expected values are written by hand
from the synthetic inputs; what these tests show is what the HARNESS does with a v3 request and a decision-v3 reply, not what a model would do."""
import json
import tempfile
import unittest
from pathlib import Path

import ev2h
import legacy_e2e as L
import th
from ev2h import case_with, ev, probe_out, decode_out, tc
from media_repair_harness import adapters as A
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import evidence_v3 as EV3
from media_repair_harness import guard_cli as GC
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness.experimental.contract_v3 import facts as FX
from media_repair_harness.experimental.contract_v3 import rubric as RB


def d3(cls='insufficient_evidence', action='escalate', refs=(), source=None, target=None, reason='r'):
    """A decision-v3 reply: none / escalate carry neither source nor target; a write carries both."""
    d = {'type': 'decision', 'class': cls, 'action': action}
    if source is not None:
        d['source'] = {'ref': source}
    if target is not None:
        d['target'] = target
    d.update(reason=reason, confidence=0.7, evidence_refs=list(refs))
    return d


def v6_run(case, replies, ts=None, **kw):
    own = ts is None
    ts = ts or th.TempSuite([case])
    kw = dict({'evidence_format': 'v3', 'guards': 'v3', 'which': th.NO_BINARIES}, **kw)
    rec, ad = ev2h.scripted_run(case, ts, replies, prompt='v6', **kw)
    if own:
        ts.cleanup()
    return rec, ad


def first_body(ad):
    return json.loads(ad.full[0]['messages'][0]['content'])


def last_reply(ad):
    return json.loads(ad.full[-1]['messages'][-1]['content'].split('\n')[0])


def managed_case(cid='w21-001', filename='Show - S01E02 - Lamp.mkv', linked=None, evidence=(), tools=('ffprobe', 'decode_sample', 'arr_lookup'), file_id=4321, **kw):
    """A TV item managed by sonarr whose catalog record (e2) links `linked` (default: this file)."""
    ev_ = [ev('e1', 'ffprobe', output=probe_out())]
    ev_.append(ev('e2', 'arr_lookup', output={'app': 'sonarr', 'series': 'Show', 'episode': {'season': 1, 'episode': 2, 'title': 'Lamp', 'hasFile': True},
                                              'file': {'relativePath': linked or filename, 'id': file_id}}))
    ev_ += list(evidence)
    case = case_with(ev_, tools=tools, cid=cid, **kw)
    case['context'].update(title='Show', filename=filename, expected={'series': 'Show', 'season': 1, 'episode': 2, 'episode_title': 'Lamp', 'runtime_s': 8},
                           arr={'app': 'sonarr', 'ids': {'seriesId': 77, 'episodeFileId': 4321}})
    return case


class OneVersionedConfiguration(unittest.TestCase):
    def test_a_v6_run_records_contract_v3_and_sends_v6_with_the_v3_presentation(self):
        rec, ad = v6_run(managed_case(), [d3()])
        self.assertEqual((rec['harness_version'], rec['prompt']['version'], rec['prompt']['protocol']), ('dev-c8', 'v6', 'turn-v3'))     # dev-c7 and dev-c8 moved the harness version; v6 and format v3 are unchanged
        self.assertEqual(ad.full[0]['system'], P.get_prompt('v6')['text'])
        ef = rec['evidence_format']
        self.assertEqual({k: ef[k] for k in EV3.CONTRACT}, EV3.CONTRACT)
        self.assertEqual((ef['version'], ef['audit_version'], ef['decision_schema'], ef['rubric']), ('v3', 'v3', 'decision-v3', RB.RUBRIC_V31_VERSION))
        self.assertEqual(rec['action_audit']['audit_version'], 'v3')
        body = first_body(ad)
        self.assertEqual(body['evidence_format'], 'v3')
        for key in ('alerts', 'open_total', 'items', 'facts', 'open', 'coverage'):
            self.assertIn(key, body['evidence'], key)
        self.assertNotIn('unresolved', json.dumps(body['evidence']['items']))       # no per-item caveat lists: one deduplicated open list
        rec.update(harness_git_sha='x', config_hash='h')
        self.assertEqual(R.record_missing_fields(rec), [])

    def test_the_first_message_is_the_frozen_prototype_rendering(self):
        case = managed_case()
        rec, ad = v6_run(case, [d3()])
        body = first_body(ad)
        caps = rec['evidence_format']['capabilities']
        shown = R.resolve_evidence_raw(case, '.')
        obs = [EV2.make_observation(e['id'], e['tool'], e['args'], e['status'], e['output'], None, 'case') for e in shown]
        frame = {k: body[k] for k in body if k != 'evidence'}
        r = FX.render(obs, body['context'], body['media_type'], body['tools_available'], caps, alias=body['case_id'], frame=frame)
        self.assertEqual(body['evidence'], r['pages'][0])

    def test_the_turn_schema_follows_the_decision_v3_shapes(self):
        sch = P.turn_schema('v6', ['ffprobe', 'arr_lookup'])
        kinds = [b['properties'].get('action', {}).get('enum') for b in sch['anyOf']]
        self.assertEqual(kinds, [None, ['none', 'escalate'], ['blocklist_and_search'], ['remap'], ['rename'], ['convert']])
        self.assertEqual(sch['anyOf'][0]['properties']['tool']['enum'], ['ffprobe', 'arr_lookup'])
        self.assertNotIn('target', sch['anyOf'][1]['properties'])
        self.assertEqual(sch['anyOf'][5]['properties']['target']['properties']['allocated_by'], {'enum': ['executor']})
        self.assertEqual(len(P.turn_schema('v6', [])['anyOf']), 5)                    # no tool offered: no tool-call branch
        self.assertEqual(P.turn_schema('v6', None, flat=True)['properties']['type']['enum'], ['decision'])
        rec, ad = v6_run(managed_case(), [d3()])
        self.assertIsNone(rec['prompt']['turn_schema_sha256'])                       # the scripted adapter is sent no schema (only Ollama is)

    def test_every_valid_decision_shape_passes_the_turn_validator_and_v2_shapes_do_not(self):
        good = [d3(), d3('healthy', 'none'),
                d3('corrupt_file', 'blocklist_and_search', source='e2', target={'kind': 'release_of_source', 'source_ref': 'e2'}),
                d3('metadata_naming', 'remap', source='e2', target={'kind': 'destination_slot', 'slot_ref': 't1', 'slot_free_ref': 't1'}),
                d3('metadata_naming', 'rename', source='e2', target={'kind': 'rename_of_source', 'old_value': 'a.mkv', 'new_value': 'b.mkv'}),
                d3('decoder_incompatible', 'convert', source='case_item', target={'kind': 'isolated_copy', 'allocated_by': 'executor'})]
        for d in good:
            self.assertEqual(P.validate_turn(d, ['ffprobe'], 'v6'), ('decision', []), d['action'])
        bad = [L.dec(),                                                                                  # a v2 escalate (target null) is refused under v3
               dict(L.dec('decoder_incompatible', 'convert', target='copy.mkv'), audit={'target': 'copy.mkv', 'preconditions': ['p'], 'readback': 'r', 'verify': 'v'}),
               d3('decoder_incompatible', 'convert', source='e1', target={'kind': 'isolated_copy', 'allocated_by': 'executor', 'path': '/x/copy.mkv'}),
               d3('decoder_incompatible', 'convert', source='e1', target={'kind': 'isolated_copy', 'allocated_by': 'model'}),
               d3('corrupt_file', 'blocklist_and_search', target={'kind': 'release_of_source', 'source_ref': 'e2'}),             # no source binding
               d3('corrupt_file', 'escalate', source='e2'),                                                                   # escalate carries no source
               d3('metadata_naming', 'rename', source='e2', target={'kind': 'rename_of_source', 'old_value': 'a', 'new_value': 'a'})]
        for d in bad:
            kind, errs = P.validate_turn(d, ['ffprobe'], 'v6')
            self.assertIsNone(kind, d)
            self.assertTrue(errs)
        # a tool call is validated exactly as in turn protocol v2
        self.assertEqual(P.validate_turn(tc('ffprobe'), ['ffprobe'], 'v6'), P.validate_turn(tc('ffprobe'), ['ffprobe'], 'v5'))
        self.assertEqual(P.validate_turn(tc('ocr'), ['ffprobe'], 'v6'), P.validate_turn(tc('ocr'), ['ffprobe'], 'v5'))

    def test_a_v2_shaped_reply_gets_the_one_repair_with_the_v3_hint_and_no_audit_hint(self):
        bad = dict(L.dec('decoder_incompatible', 'convert', target='copy.mkv'), audit={'target': 'copy.mkv', 'preconditions': ['p'], 'readback': 'r', 'verify': 'v'})
        rec, ad = v6_run(managed_case(), [bad, d3('decoder_incompatible', 'escalate')])
        self.assertEqual(len(rec['repair_prompts']), 1)
        self.assertIn('decision_v3_shape', rec['repair_prompts'][0]['failure_modes'])
        self.assertNotIn('audit', ' '.join(rec['repair_prompts'][0]['failure_modes']))
        self.assertIn('"source":{"ref"', rec['repair_prompts'][0]['prompt'])
        self.assertFalse(rec['first_try_valid'])
        self.assertEqual((rec['decision']['class'], rec['decision']['action'], rec['forced']), ('decoder_incompatible', 'escalate', False))
        self.assertEqual(rec['write_rejection']['rejected_write_attempts'], 1)

    def test_a_forced_decision_has_the_decision_v3_shape(self):
        rec, _ = v6_run(managed_case(), ['not json', 'still not json'])
        self.assertTrue(rec['forced'])
        self.assertNotIn('target', rec['decision'])
        self.assertEqual(EV3.validate_decision(rec['decision']), [])
        self.assertEqual(rec['action_audit']['execution_status'], 'no_write_proposed')


class WritesAndTheV3Audit(unittest.TestCase):
    """The v3 audit is a record of prerequisite states with the references that decided them; it never changes a decision (guards v3 alone may)."""

    def prereq(self, rec):
        return {p['id']: p['state'] for p in rec['action_audit']['prerequisites']}

    def test_convert_with_an_executor_allocated_copy_and_no_destination_name(self):
        streams = [{'index': 0, 'codec_type': 'video', 'codec_name': 'hevc', 'pix_fmt': 'yuv420p10le', 'width': 640, 'height': 480},
                   {'index': 1, 'codec_type': 'audio', 'codec_name': 'aac', 'channels': 2, 'sample_rate': '48000'}]
        case = managed_case(cid='w21-cnv', evidence=[])
        case['evidence'][0] = ev('e1', 'ffprobe', output=probe_out(streams=streams))
        case['context']['client_profile'] = {'containers': ['matroska,webm'], 'video_codec': 'h264', 'video_pix_fmt': 'yuv420p', 'audio_codecs': ['aac'], 'max_audio_channels': 2}
        rec, _ = v6_run(case, [d3('decoder_incompatible', 'convert', refs=['e1'], source='e2', target={'kind': 'isolated_copy', 'allocated_by': 'executor'})])
        self.assertEqual((rec['decision']['action'], rec['guard']['final_changed']), ('convert', False))
        st = self.prereq(rec)
        for pid in ('A-CLASS', 'D-DEC-1', 'D-DEC-2', 'A-CNV-0', 'A-CNV-1', 'A-CNV-2', 'R-SRC'):
            self.assertEqual(st[pid], 'met', pid)
        self.assertEqual(rec['action_audit']['unmet'], [])
        self.assertIn('the executor allocates and names the isolated copy', [x['text'] for x in rec['action_audit']['execution_prerequisites']])
        self.assertEqual({x['checked_by'] for x in rec['action_audit']['execution_prerequisites']}, {'executor'})
        self.assertEqual((rec['action_audit']['executed'], rec['action_audit']['execution_status']), (False, 'proposed_not_executed'))

    def test_source_binding_is_read_from_the_record_of_this_file(self):
        dmg = ev('e3', 'decode_sample', output=decode_out(ss=0, t=4, stderr=L.DEC_BAD['stderr']), args={'ss': 0, 't': 4})
        write = lambda: [d3('corrupt_file', 'blocklist_and_search', refs=['e3'], source='e2', target={'kind': 'release_of_source', 'source_ref': 'e2'})]
        bound, _ = v6_run(managed_case(cid='w21-b1', evidence=[dmg]), write())
        other, _ = v6_run(managed_case(cid='w21-b2', linked='Other - S01E09.mkv', file_id=9999, evidence=[dmg]), write())
        self.assertEqual((self.prereq(bound)['A-BLK-2'], self.prereq(bound)['R-SRC'], self.prereq(bound)['A-BLK-3']), ('met', 'met', 'met'))
        self.assertEqual((self.prereq(other)['A-BLK-2'], self.prereq(other)['R-SRC']), ('unmet', 'unmet'))
        # the audit is a record: neither decision is changed by it (guards v3 read evidence_refs, not the source binding)
        self.assertEqual((bound['decision']['action'], other['decision']['action']), ('blocklist_and_search', 'blocklist_and_search'))
        cited_damage_as_source, _ = v6_run(managed_case(cid='w21-b3', evidence=[dmg]),
                                           [d3('corrupt_file', 'blocklist_and_search', refs=['e3'], source='e3', target={'kind': 'release_of_source', 'source_ref': 'e3'})])
        self.assertEqual(self.prereq(cited_damage_as_source)['R-SRC'], 'unmet')       # the damage observation does not bind the source

    def test_rename_old_value_is_the_literal_current_name(self):
        ocr = ev('e3', 'ocr', output={'text': 'SHOW  S01E02  LAMP'}, args={'at': 1})
        case = managed_case(cid='w21-ren', filename='Show - S01E05 - Lamp.mkv', evidence=[ocr])
        exact = [d3('metadata_naming', 'rename', refs=['e1', 'e3'], source='e2',
                    target={'kind': 'rename_of_source', 'old_value': 'Show - S01E05 - Lamp.mkv', 'new_value': 'Show - S01E02 - Lamp.mkv'})]
        altered = [d3('metadata_naming', 'rename', refs=['e1', 'e3'], source='e2',
                      target={'kind': 'rename_of_source', 'old_value': 'show - s01e05 - lamp.mkv', 'new_value': 'Show - S01E02 - Lamp.mkv'})]
        a, _ = v6_run(case, exact)
        b, _ = v6_run(case, altered)
        self.assertEqual(self.prereq(a)['R-OLD'], 'met')
        self.assertEqual(self.prereq(b)['R-OLD'], 'unmet')

    def test_a_guard_escalation_under_v3_has_no_target_and_keeps_the_original(self):
        case = case_with([ev('e1', 'ffprobe', output=probe_out())], tools=('ffprobe',), cid='w21-g1')
        rec, _ = v6_run(case, [d3('corrupt_file', 'blocklist_and_search', refs=[], source='case_item', target={'kind': 'release_of_source', 'source_ref': 'case_item'})])
        self.assertTrue(rec['guard']['final_changed'])
        self.assertEqual(rec['guard']['applied'][0]['rule'], 'G-write')
        self.assertEqual((rec['decision']['class'], rec['decision']['action']), ('insufficient_evidence', 'escalate'))
        self.assertNotIn('target', rec['decision'])
        self.assertEqual(EV3.validate_decision(rec['decision']), [])
        self.assertEqual(rec['guard']['applied'][0]['original']['source'], {'ref': 'case_item'})

    def test_guards_v3_g_healthy_applies_unchanged(self):
        dmg = [ev('e1', 'ffprobe', output=probe_out()), ev('e2', 'decode_sample', output=decode_out(ss=4, t=4, stderr=L.DEC_BAD['stderr']), args={'ss': 4, 't': 4})]
        rec, _ = v6_run(case_with(dmg, cid='w21-g2'), [d3('healthy', 'none', refs=['e1'])])
        self.assertEqual((rec['decision']['action'], rec['guard']['applied'][0]['rule']), ('escalate', 'G-healthy'))
        off, _ = v6_run(case_with(dmg, cid='w21-g3'), [d3('healthy', 'none', refs=['e1'])], guards=None)
        self.assertEqual(off['decision']['action'], 'none')
        self.assertNotIn('guard', off)


class ToolResultsAndPages(unittest.TestCase):
    """A tool result under v3: the observation with its facts and presence, the open items that are new or changed, the ids no longer open, stable ids."""

    def test_a_result_shows_the_delta_of_open_items_with_stable_ids_and_the_called_link(self):
        case = L.tv_case('w21-t1', evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(L.PROBE_REC)}],
                         tools_available=['ffprobe', 'decode_sample', 'arr_lookup'])
        ts = L.suite_with(case)
        rec, ad = v6_run(case, [tc('decode_sample', {'full': True}), d3()], ts=ts)
        first = first_body(ad)['evidence']
        before = {it['id']: it for it in first['open']}
        reply = last_reply(ad)
        out = reply['output']
        self.assertEqual((reply['id'], reply['tool'], reply['status']), ('t1', 'decode_sample', 'ok'))
        self.assertIn('open_total', out)
        self.assertNotIn('unresolved', out)
        # the full decode is now shown: every link that offers it reads `called`, by the shown id (it was `available` before)
        self.assertTrue(any(c['args'] == {'full': True} and c['availability'] == 'available' for it in first['open'] for c in it['available_check']))
        called = [c for it in out.get('open', []) for c in it['available_check'] if c['args'] == {'full': True}]
        self.assertTrue(called and all(c['availability'] == 'called' and c['already_shown_as'] == ['t1'] for c in called), out.get('open'))
        # ids: an item whose text and scope did not change keeps its id; a replaced one is listed in open_removed
        shown_now = {it['id'] for it in out.get('open', [])}
        for i in out.get('open_removed', []):
            self.assertIn(i, before)
            self.assertNotIn(i, shown_now)
        kept = [i for i in before if i not in out.get('open_removed', [])]
        self.assertEqual(out['open_total'], len(kept) + len([i for i in shown_now if i not in before]))
        self.assertIn('open_ids', out)
        final_open = rec['evidence_format']['final_summary']['open']
        self.assertEqual(len(final_open), out['open_total'])
        ts.cleanup()

    def test_a_long_result_is_paginated_and_a_fetch_costs_a_call(self):
        big = [{'start': str(i * 2), 'end': str(i * 2 + 2), 'title': 'Chapter %03d %s' % (i, 'x' * 40)} for i in range(160)]
        case = L.tv_case('w21-t2', evidence=[], tools_available=['ffprobe', 'decode_sample'])
        ts = L.suite_with(case, probes=False)
        import hashlib
        rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), ffprobe=dict(L.PROBE_REC, chapters=big))
        ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
        _, ad0 = v6_run(case, [tc('ffprobe'), d3()], ts=ts)
        page = last_reply(ad0)['output']['page']
        self.assertGreater(page['of'], 1)
        rec, ad = v6_run(case, [tc('ffprobe'), tc('ffprobe', {'cursor': page['next']}), d3()], ts=ts)
        self.assertEqual([c['tool'] for c in rec['tool_calls']], ['ffprobe', 'page'])
        self.assertEqual(last_reply(ad)['tool_calls_remaining'], 4)
        for m in rec['evidence_format']['messages']:
            for b in m.get('bytes') if isinstance(m.get('bytes'), list) else [m.get('bytes')]:
                self.assertLessEqual(b, 8192)
        ts.cleanup()


class PairedRegressions(unittest.TestCase):
    """Two inputs that differ in exactly one fact, through the real runner under v6 + v3."""

    def test_pair_explicit_empty_tags_versus_absent_tags(self):
        empty = dict(L.PROBE_REC, format=dict(L.PROBE_REC['format'], tags={}))
        absent = dict(L.PROBE_REC, format={k: v for k, v in L.PROBE_REC['format'].items() if k != 'tags'})
        _, a = v6_run(case_with([ev('e1', 'ffprobe', output=empty)], cid='w21-p1'), [d3()])
        _, b = v6_run(case_with([ev('e1', 'ffprobe', output=absent)], cid='w21-p2'), [d3()])
        ea, eb = first_body(a)['evidence'], first_body(b)['evidence']
        self.assertEqual(ea['facts']['e1']['tags'], {})
        self.assertEqual(ea['presence']['e1']['tags'], 'empty')
        self.assertNotIn('tags', eb['facts']['e1'])
        self.assertNotIn('tags', (eb.get('presence') or {}).get('e1', {}))

    def test_pair_links_do_not_depend_on_an_uncalled_result(self):
        """The same case with a clean and a damaged recording of a window nobody called: the first message (links included) is byte-identical."""
        import hashlib
        texts = []
        for stderr in ('', L.DEC_BAD['stderr']):
            case = L.tv_case('w21-p3', evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(L.PROBE_REC)}],
                             tools_available=['ffprobe', 'decode_sample'])
            ts = L.suite_with(case, probes=False)
            dec4 = dict(L.DEC_BAD, stderr=stderr)
            rec_file = dict(L.REPLAY_FILE, sha256=hashlib.sha256(b'not really media' * 50).hexdigest(), decode_sample=dict(L.REPLAY_FILE['decode_sample'], **{'4': dec4}))
            ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec_file).encode())
            _, ad = v6_run(case, [d3()], ts=ts)
            texts.append(ad.full[0]['messages'][0]['content'])
            ts.cleanup()
        self.assertEqual(texts[0], texts[1])
        self.assertIn('available_check', texts[0])

    def test_pair_clean_container_versus_none_for_healthy(self):
        clean = case_with([ev('e1', 'ffprobe', output=probe_out())], cid='w21-p4')
        none_ = case_with([ev('e1', 'arr_lookup', output={'app': None, 'title': 'T'})], cid='w21-p5')
        a, _ = v6_run(clean, [d3('healthy', 'none', refs=['e1'])])
        b, _ = v6_run(none_, [d3('healthy', 'none', refs=['e1'])])
        self.assertEqual((a['decision']['action'], a['guard']['final_changed']), ('none', False))
        self.assertEqual((b['decision']['action'], b['guard']['final_changed']), ('escalate', True))

    def test_pair_convert_without_a_name_versus_with_an_invented_path(self):
        ok = d3('decoder_incompatible', 'convert', refs=['e1'], source='case_item', target={'kind': 'isolated_copy', 'allocated_by': 'executor'})
        bad = d3('decoder_incompatible', 'convert', refs=['e1'], source='case_item', target={'kind': 'isolated_copy', 'allocated_by': 'executor', 'name': 'copy.mkv'})
        client = {'containers': ['matroska,webm'], 'video_codec': 'hevc', 'audio_codecs': ['aac'], 'max_audio_channels': 2}
        cases = [case_with([ev('e1', 'ffprobe', output=probe_out())], cid=c) for c in ('w21-p6', 'w21-p7')]
        for c in cases:
            c['context']['client_profile'] = client
        a, _ = v6_run(cases[0], [ok])
        b, _ = v6_run(cases[1], [bad, bad])
        self.assertTrue(a['first_try_valid'])
        self.assertEqual(a['decision']['action'], 'convert')
        self.assertTrue(b['forced'])        # refused twice: the invented name never becomes a decision


class UncalledCountReadsV3Records(unittest.TestCase):
    def test_the_decision_prefix_counter_reads_a_v3_record(self):
        from media_repair_harness.experimental.contract_v3 import uncalled as UC
        case = L.tv_case('w21-u1', evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(L.PROBE_REC)}],
                         tools_available=['ffprobe', 'decode_sample'])
        ts = L.suite_with(case)
        rec, _ = v6_run(case, [tc('decode_sample', {'at': 0}), d3()], ts=ts)
        out = UC.summarise([(rec, case)], ts.root)
        self.assertEqual((out['decisions'], out['escalations']), (1, 1))
        self.assertEqual(out['escalations_with_uncalled_available_check'], 1)          # windows at 4 and 8 and the full decode were still available
        self.assertNotIn({'at': 0}, [c['args'] for c in UC.callable_candidates(rec, case, ts.root)[1]])
        ts.cleanup()


class OfflineRestoreAndMain(unittest.TestCase):
    def test_main_writes_a_contract_v3_manifest_and_the_restore_scores_the_original(self):
        case = case_with([ev('e1', 'ffprobe', output=probe_out()), ev('e2', 'decode_sample', output=decode_out(ss=4, t=4, stderr=L.DEC_BAD['stderr']), args={'ss': 4, 't': 4})],
                         cid='w21-m1')
        ts = th.TempSuite([case])
        out = Path(tempfile.mkdtemp()) / 'r-v3'
        orig = R.build_adapter
        R.build_adapter = lambda args: A.ScriptedAdapter('m', [d3('healthy', 'none', refs=['e1'])])
        try:
            code = R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(),
                           '--prompt', 'v6', '--evidence-format', 'v3', '--guards', 'v3', '--replay', 'auto'])
        finally:
            R.build_adapter = orig
        self.assertEqual(code, 0)
        man = json.loads((out / 'manifest.json').read_text())
        cfg = man['config']
        self.assertEqual({k: cfg[k] for k in EV3.CONTRACT}, EV3.CONTRACT)
        self.assertEqual((cfg['prompt_version'], cfg['protocol'], cfg['guards'], cfg['harness_version']), ('v6', 'turn-v3', 'v3', 'dev-c8'))
        rec = json.loads((out / 'w21-m1.json').read_text())
        self.assertEqual((rec['decision']['action'], rec['guard']['final_changed']), ('escalate', True))
        restored = Path(tempfile.mkdtemp()) / 'r-v3-restored'
        GC.guard_run(out, ts.root, restored, restore=True)
        back = json.loads((restored / 'w21-m1.json').read_text())
        self.assertEqual((back['decision']['class'], back['decision']['action']), ('healthy', 'none'))
        self.assertEqual(back['action_audit']['audit_version'], 'v3')
        self.assertTrue(back['guard']['restored'])
        ts.cleanup()

    def test_the_config_hash_tells_v3_from_v2(self):
        hashes = {}
        case = case_with([ev('e1', 'ffprobe', output=probe_out())], cid='w21-m2')
        ts = th.TempSuite([case])
        for pv, fmt in (('v6', 'v3'), ('v5', 'v2')):
            out = Path(tempfile.mkdtemp()) / ('r-' + fmt)
            orig = R.build_adapter
            R.build_adapter = lambda args, pv=pv: A.ScriptedAdapter('m', [d3() if pv == 'v6' else L.dec()])
            try:
                R.main(['--suite', str(ts.root), '--adapter', 'scripted', '--model', 'm', '--out', str(out), '--scratch', tempfile.mkdtemp(), '--prompt', pv, '--evidence-format', fmt])
            finally:
                R.build_adapter = orig
            hashes[fmt] = json.loads((out / 'manifest.json').read_text())['config_hash']
        self.assertNotEqual(hashes['v3'], hashes['v2'])
        ts.cleanup()


if __name__ == '__main__':
    unittest.main()
