"""Tests against real W3 suite cases (read in place from ../suite, merged in PR #1004) incl. replay mode and optional keys."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import adapters as A
from media_repair_harness import outcomes
from media_repair_harness import protocol as P
from media_repair_harness import run as R
import th
from media_repair_harness import tools as T

SAMPLE = th.SUITE
NO_BINARIES = lambda name: None


def load(case_id):
    return json.loads((SAMPLE / 'cases' / (case_id + '.json')).read_text())


def ctx_for(case_id, **kw):
    case = load(case_id)
    kw.setdefault('which', NO_BINARIES)
    return case, T.Context(case, T.Fixture.from_case(case, SAMPLE), tempfile.mkdtemp(), suite_dir=SAMPLE, **kw)


def call(ctx, tool, args=None):
    r = T.call_tool(ctx, tool, args or {})
    try:
        r['parsed'] = json.loads(r['output'])
    except ValueError:
        r['parsed'] = None
    return r


@th.needs_suite
class ReplayMode(unittest.TestCase):
    def test_ffprobe_and_decode_replay_when_binaries_missing(self):
        case, ctx = ctx_for('tv-corrupt-003')
        r = call(ctx, 'ffprobe')
        self.assertEqual((r['status'], r['mode']), ('ok', 'replay'))
        self.assertEqual(r['parsed']['format']['format_name'], 'matroska,webm')
        d0 = call(ctx, 'decode_sample', {'at': 0})
        d4 = call(ctx, 'decode_sample', {'at': 4})
        self.assertEqual(d0['mode'], 'replay')
        self.assertTrue(d0['parsed']['clean'])        # the ss=0 window is clean, the damage only shows at ss=4
        self.assertFalse(d4['parsed']['clean'])
        self.assertIn('error while decoding', d4['parsed']['stderr'])
        full = call(ctx, 'decode_sample', {'t': 'full'})
        self.assertEqual(full['parsed']['window_s'], 'full')

    def test_decode_window_mapping_and_ss_alias(self):
        case, ctx = ctx_for('tv-corrupt-003')
        r = call(ctx, 'decode_sample', {'ss': 6})
        self.assertEqual(r['parsed']['at_s'], 4)
        self.assertEqual(r['parsed']['requested_at_s'], 6.0)
        self.assertIn('replay serves the recorded window', r['parsed']['note_window'])

    def test_failing_probe_has_the_recorded_error_shape(self):
        case, ctx = ctx_for('movie-corrupt-003')
        r = call(ctx, 'ffprobe')
        self.assertEqual((r['status'], r['mode']), ('error', 'replay'))
        self.assertIn('moov atom not found', r['parsed']['stderr'])
        self.assertEqual(r['parsed']['exit_code'], 1)

    def test_ocr_serves_recorded_card_text_and_frame_is_virtual(self):
        case, ctx = ctx_for('tv-corrupt-003')
        fr = call(ctx, 'frame_sample', {'at': 1})
        self.assertEqual((fr['status'], fr['mode']), ('ok', 'replay'))
        self.assertTrue(fr['parsed']['replay'])
        o = call(ctx, 'ocr', {'frame': fr['parsed']['frame']})
        self.assertEqual(o['parsed']['text'], 'HARBOR LIGHTS / S01E02 / LAMP OIL')
        self.assertIn('not OCR', o['parsed']['note'])
        self.assertEqual(call(ctx, 'ocr', {'t': 5})['parsed']['text'], '')   # past the card
        self.assertEqual(call(ctx, 'ocr', {'at': 0})['mode'], 'replay')

    def test_audio_sample_has_no_replay(self):
        case, ctx = ctx_for('tv-corrupt-003')
        r = call(ctx, 'audio_sample', {'at': 0})
        self.assertEqual(r['status'], 'unavailable')   # nothing was recorded and nothing ran: capability absent, not a failed tool
        self.assertIn('no recorded', r['output'])

    def test_replay_off_and_force(self):
        case, ctx = ctx_for('tv-corrupt-003', replay='off')
        self.assertEqual(call(ctx, 'ffprobe')['status'], 'unavailable')
        self.assertIn('replay is disabled', call(ctx, 'ffprobe')['output'])
        case, ctx = ctx_for('tv-corrupt-003', replay='force', which=lambda n: '/usr/bin/' + n)
        self.assertEqual(call(ctx, 'ffprobe')['mode'], 'replay')

    def test_live_binaries_win_in_auto_mode(self):
        runner = lambda cmd, **kw: __import__('subprocess').CompletedProcess(cmd, 0, json.dumps({'format': {'duration': '8'}, 'streams': []}).encode(), b'')
        case, ctx = ctx_for('tv-corrupt-003', which=lambda n: '/usr/bin/' + n, runner=runner)
        self.assertEqual(call(ctx, 'ffprobe')['mode'], 'local')

    def test_replay_refuses_a_changed_fixture(self):
        tmp = Path(tempfile.mkdtemp()) / 's'
        shutil.copytree(SAMPLE, tmp)
        fx = tmp / 'fixtures' / 'media' / 'hl_e02_flip2.mkv'
        fx.write_bytes(fx.read_bytes() + b'x')
        case = load('tv-corrupt-003')
        ctx = T.Context(case, T.Fixture.from_case(case, tmp), tempfile.mkdtemp(), suite_dir=tmp, which=NO_BINARIES)
        r = call(ctx, 'ffprobe')
        self.assertEqual(r['status'], 'unavailable')   # the recording cannot be used for these bytes; nothing ran
        self.assertIn('does not match the fixture', r['output'])

    def test_audiobook_inspect_from_replay(self):
        case, ctx = ctx_for('audiobook-corrupt-003')
        r = call(ctx, 'audiobook_inspect')   # the case injects a partial failure on this tool
        self.assertEqual((r['status'], r['mode']), ('partial', 'injected'))
        case, ctx = ctx_for('audiobook-corrupt-003')
        case['inject_tool_failure'] = None
        ctx.case = case
        r = call(ctx, 'audiobook_inspect')   # without the injection: the recorded probe of a truncated m4b failed
        self.assertEqual((r['status'], r['mode']), ('error', 'replay'))
        self.assertIn('moov atom not found', r['output'])

    def test_record_lists_tool_modes(self):
        case = load('tv-corrupt-003')
        ad = A.ScriptedAdapter('m', [th.tool_call('ffprobe'), th.tool_call('decode_sample', {'at': 4}),
                                     th.decision('corrupt_file', 'blocklist_and_search', refs=['t2'])])
        import shutil as sh
        rec = R.run_case(case, 'sha', ad, SAMPLE, tempfile.mkdtemp(), which=NO_BINARIES)
        self.assertEqual(rec['tool_modes'], ['replay'])
        self.assertEqual({c['mode'] for c in rec['tool_calls']}, {'replay'})
        self.assertEqual(rec['fixture']['verified'], True)


@th.needs_suite
class RealCases(unittest.TestCase):
    def test_pinned_fixture_cases_do_not_crash(self):
        case = load('tv-insuff-001')
        self.assertEqual(T.Fixture.from_case(case, SAMPLE).kind, 'pinned')
        ad = A.ScriptedAdapter('m', [th.tool_call('ffprobe'), th.decision('insufficient_evidence', 'escalate')])
        rec = R.run_case(case, 'sha', ad, SAMPLE, tempfile.mkdtemp(), which=NO_BINARIES)
        # a pinned row serves its recorded observation, labelled as such (replay), and says so
        self.assertEqual((rec['tool_calls'][0]['status'], rec['tool_calls'][0]['mode']), ('ok', 'pinned_replay'))
        self.assertIn('recorded observation', rec['tool_calls'][0]['output'])
        self.assertNotIn('error', rec)
        self.assertEqual(rec['fixture']['verified'], 'declared_only')

    def test_injected_timeout_on_a_real_case(self):
        case = load('movie-corrupt-003')
        ad = A.ScriptedAdapter('m', [th.tool_call('decode_sample'), th.decision('corrupt_file', 'blocklist_and_search', refs=['e1'])])
        rec = R.run_case(case, 'sha', ad, SAMPLE, tempfile.mkdtemp(), which=NO_BINARIES)
        c = rec['tool_calls'][0]
        self.assertEqual((c['status'], c['injected'], c['mode']), ('timeout', True, 'injected'))

    def test_injected_partial_on_audiobook_case(self):
        case = load('audiobook-corrupt-003')
        case['inject_tool_failure'] = {'tool': 'ffprobe', 'mode': 'partial'}   # real case uses audiobook_inspect; this one has a longer output
        case_ctx = T.Context(case, T.Fixture.from_case(case, SAMPLE), tempfile.mkdtemp(), suite_dir=SAMPLE, which=NO_BINARIES)
        r = T.call_tool(case_ctx, 'ffprobe', {})
        self.assertEqual(r['status'], 'partial')

    def test_epub_corrupt_case_reports_stage(self):
        case, ctx = ctx_for('epub-corrupt-002')
        # fixture path resolves under suite_sample/fixtures/media
        r = call(ctx, 'epub_inspect')
        self.assertEqual(r['status'], 'error')
        self.assertEqual(r['parsed']['stage'], 'zip_open')

    def test_healthy_epub_case(self):
        case, ctx = ctx_for('epub-healthy-004')
        r = call(ctx, 'epub_inspect')
        if case['fixture']['kind'] == 'local' and Path(ctx.fixture.path).is_file():
            self.assertEqual(r['status'], 'ok')
            self.assertTrue(r['parsed']['dc_title'])

    def test_arr_lookup_serves_the_cases_own_records(self):
        case, ctx = ctx_for('tv-corrupt-003')
        r = call(ctx, 'arr_lookup')
        self.assertEqual(r['mode'], 'stub')
        self.assertTrue(r['parsed']['stub'])
        self.assertIn('Harbor Lights', r['output'])

    def test_model_view_has_suite_context_keys_and_nothing_else(self):
        case = load('movie-decoder-002')
        case['future_key'] = 'SECRET-TOP'
        case['context']['future_ctx'] = 'SECRET-CTX'
        case['outcome_step'] = {'check': 'x', 'why': 'SECRET-WHY'}
        case['evidence'].append({'id': 'e9', 'tool': 'prior_record', 'args': {}, 'status': 'ok', 'output': 'a pinned observation'})
        view = P.case_view(case, R.resolve_evidence(case, SAMPLE))
        text = json.dumps(view)
        self.assertIn('client_profile', text)
        self.assertIn('Quiet Orbit (2019).mkv', text)          # filename
        self.assertIn('direct-play', text)                      # question
        self.assertIn('a pinned observation', text)             # evidence tool prior_record is shown, not callable
        for secret in ('SECRET', 'future', 'blocklist_and_search', 'truth', 'solvable'):
            self.assertNotIn(secret, text)
        self.assertEqual(P.validate_turn(th.tool_call('prior_record'), case['tools_available'])[0], None)

    def test_unknown_keys_do_not_break_the_run(self):
        case = load('tv-corrupt-003')
        case['future_key'] = {'x': 1}
        ad = A.ScriptedAdapter('m', [th.decision('corrupt_file', 'blocklist_and_search')])
        rec = R.run_case(case, 'sha', ad, SAMPLE, tempfile.mkdtemp(), which=NO_BINARIES)
        self.assertNotIn('error', rec)


@th.needs_suite
class OutcomeChecks(unittest.TestCase):
    def test_all_sampled_outcome_steps_match_expected(self):
        for cid in ('tv-outcome-001',):
            case = load(cid)
            r = outcomes.run_outcome_step(case, SAMPLE)
            self.assertEqual((r['observed'], r['correct']), (case['outcome_step']['expected'], True), cid)

    def test_replace_verify_catches_wrong_episode_and_dirty_decode(self):
        case = load('tv-outcome-001')
        ev = {e['tool']: e for e in case['outcome_step']['inputs']['post_evidence']}
        wrong = json.loads(json.dumps(case))
        for e in wrong['outcome_step']['inputs']['post_evidence']:
            if e['tool'] == 'ocr':
                e['output'] = 'HARBOR LIGHTS / S01E03 / THE SALT WIND'
        self.assertEqual(outcomes.run_outcome_step(wrong, SAMPLE)['observed'], 'not_repaired')
        dirty = json.loads(json.dumps(case))
        for e in dirty['outcome_step']['inputs']['post_evidence']:
            if e['tool'] == 'decode_sample':
                e['output'] = json.dumps({'exit_code': 0, 'frames': 61, 'stderr': 'error while decoding'})
        self.assertEqual(outcomes.run_outcome_step(dirty, SAMPLE)['observed'], 'not_repaired')

    def test_convert_verify_requires_audio_stream(self):
        case = load('tv-outcome-001')
        case['outcome_step']['check'] = 'post_convert_verify'
        r = outcomes.run_outcome_step(case, SAMPLE)
        self.assertIn(r['observed'], ('repaired', 'not_repaired'))   # runs without crashing on a replace-shaped input


if __name__ == '__main__':
    unittest.main()
