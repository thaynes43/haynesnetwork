"""#209: the opt-in `--evidence-handover none|askable` (handover-1) and its reachability table.  No model, no network, no ffmpeg: ScriptedAdapter and the
committed recordings of suite dev-v1.1."""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import adapters as A
from media_repair_harness import handover as HO
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T
import th

SUITE11 = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite-dev-v1.1'
sys.path.insert(0, str(th.COMPONENT / 'scripts'))
import must_ask_reachability as MR      # noqa: E402


def needs_suite11(obj):
    def check():
        if (SUITE11 / 'cases').is_dir():
            return
        if os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError('suite dev-v1.1 not found at %s; MRH_REQUIRE_SUITE=1 forbids skipping' % SUITE11)
        raise unittest.SkipTest('suite dev-v1.1 not found')
    if isinstance(obj, type):
        orig = obj.__dict__.get('setUpClass')

        def setUpClass(cls):
            check()
            if orig is not None:
                orig.__func__(cls)
        obj.setUpClass = classmethod(setUpClass)
        return obj

    def wrapper(*a, **kw):
        check()
        return obj(*a, **kw)
    wrapper.__name__ = obj.__name__
    return wrapper


FORMATS = {                    # name -> (prompt, evidence_format, guards)
    'legacy': ('v4', None, None),
    'v2': ('v5', 'v2', 'v3'),
    'v3': ('v6', 'v3', 'v3'),
    'v3.1': ('v7', 'v3.1-format', 'v3'),
}
CASES = {}


def case_of(cid):
    if not CASES:
        for c, s in R.load_cases(SUITE11):
            CASES[c['id']] = (c, s)
    return CASES[cid]


def scrub(o):
    """A record without its clocks."""
    if isinstance(o, dict):
        return {k: scrub(v) for k, v in o.items() if k not in ('wall', 'wall_s', 'started_at', 'load_s')}
    if isinstance(o, list):
        return [scrub(v) for v in o]
    return o


def run_one(cid, handover=None, calls=(), fmt='v3.1', decision=None, **kw):
    """-> (record, adapter).  `calls`: [(tool, args)] answered in order, then a decision."""
    case, sha = case_of(cid)
    prompt, evf, guards = FORMATS[fmt]
    replies = [json.dumps({'type': 'tool_call', 'tool': t, 'args': a, 'why': 'w'}) for t, a in calls]
    replies.append(json.dumps(decision or P.forced_decision_for(prompt, 'test')))
    adapter = A.ScriptedAdapter('m', replies)
    extra = {} if handover is None else {'evidence_handover': handover}
    rec = R.run_case(case, sha, adapter, SUITE11, tempfile.mkdtemp(), which=lambda n: None, run_id='r', prompt_version=prompt, evidence_format=evf, guards=guards, **extra, **kw)
    return rec, adapter


def first_message(adapter):
    return adapter.calls[0][0]['content']


@needs_suite11
class DefaultIsUnchanged(unittest.TestCase):
    def test_the_flag_defaults_to_full_and_full_adds_nothing_to_the_config(self):
        ap = R.build_parser()
        base = ['--suite', 'x', '--adapter', 'scripted', '--model', 'm', '--out', 'o', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3']
        absent, full = ap.parse_args(base), ap.parse_args(base + ['--evidence-handover', 'full'])
        self.assertEqual(absent.evidence_handover, 'full')
        adapter = A.ScriptedAdapter('m', [])
        c_absent, c_full = R.run_config(absent, adapter, {}, {}), R.run_config(full, adapter, {}, {})
        self.assertEqual(c_absent, c_full)
        self.assertNotIn('evidence_handover', c_absent)
        self.assertEqual(R.sha256_bytes(R.canonical(c_absent).encode()), R.sha256_bytes(R.canonical(c_full).encode()))
        none = R.run_config(ap.parse_args(base + ['--evidence-handover', 'none']), adapter, {}, {})
        self.assertEqual(none['evidence_handover'], {'mode': 'none', 'version': 'handover-1', 'serve': 'recorded-first'})
        self.assertNotEqual(R.sha256_bytes(R.canonical(none).encode()), R.sha256_bytes(R.canonical(c_absent).encode()))
        self.assertEqual({k: v for k, v in none.items() if k != 'evidence_handover'}, c_absent)

    def test_harness_version_and_tools_are_unchanged(self):
        self.assertEqual(P.HARNESS_VERSION, 'dev-c8')
        self.assertEqual(P.TOOLS, ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'audiobook_inspect', 'arr_lookup'))

    def test_a_full_run_is_the_same_run_with_or_without_the_keyword(self):
        for fmt in FORMATS:
            for cid, calls in (('movie-decoder-002', [('ffprobe', {}), ('decode_sample', {'at': 4})]), ('audiobook-corrupt-001', [])):
                a, ad_a = run_one(cid, None, calls, fmt)
                b, ad_b = run_one(cid, 'full', calls, fmt)
                self.assertEqual(scrub(a), scrub(b), (fmt, cid))
                self.assertEqual(ad_a.calls, ad_b.calls)
                self.assertNotIn('evidence_handover', a)
                self.assertTrue(a['evidence_shown'])

    def test_a_plain_call_does_not_use_the_recorded_layer_in_a_full_run(self):
        rec, _ = run_one('movie-decoder-002', None, [('ffprobe', {})])
        self.assertNotIn('served_from_record', rec['tool_calls'][0])


@needs_suite11
class MustAskFirstMessage(unittest.TestCase):
    def test_none_withholds_the_evidence_and_keeps_the_rest_of_the_view(self):
        for fmt in FORMATS:
            full, ad_f = run_one('movie-decoder-002', None, [], fmt)
            none, ad_n = run_one('movie-decoder-002', 'none', [], fmt)
            vf, vn = json.loads(first_message(ad_f)), json.loads(first_message(ad_n))
            for key in ('case_id', 'media_type', 'context', 'tools_available', 'tool_call_budget'):
                self.assertEqual(vf[key], vn[key], (fmt, key))
            self.assertEqual(vn['tools_available'], ['ffprobe', 'decode_sample', 'frame_sample', 'ocr', 'arr_lookup'])
            self.assertEqual(none['evidence_shown'], [])
            self.assertNotEqual(vf['evidence'], vn['evidence'])
            self.assertIn('142956', first_message(ad_f), fmt)            # the recorded ffprobe bit rate: in the handed message ...
            self.assertNotIn('142956', first_message(ad_n), fmt)         # ... and in no part of the must-ask one
            self.assertEqual(none['evidence_handover']['withheld'], ['e1', 'e2', 'e3'])
            self.assertEqual(none['evidence_handover']['shown'], [])
            self.assertEqual(none['evidence_handover']['never_asked_for'], ['e1', 'e2', 'e3'])
            self.assertEqual(none['fixture_hashes']['evidence_shown_sha256'], {})

    def test_the_context_boundary(self):
        """title, expected, arr ids and notes stay; arr_lookup (what the app's record says about the work) is evidence and goes."""
        case, _ = case_of('movie-decoder-002')
        _, ad = run_one('movie-decoder-002', 'none', [], 'legacy')
        view = json.loads(first_message(ad))
        self.assertEqual(view['context'], {k: case['context'][k] for k in P.MODEL_CONTEXT_KEYS if k in case['context']})
        self.assertEqual(view['evidence'], [])
        self.assertIn('arr', view['context'])

    def test_askable_keeps_what_no_call_can_return(self):
        # movie-decoder-001: ffprobe and decode_sample are offered, the prior_record is not a tool
        rec, ad = run_one('movie-decoder-001', 'askable', [], 'legacy')
        self.assertEqual(rec['evidence_shown'], ['e3'])
        self.assertEqual(rec['evidence_handover']['withheld'], ['e1', 'e2'])
        # a case that offers no tool is the same in both arms
        full, ad_f = run_one('audiobook-healthy-001', None, [], 'legacy')
        ask, ad_a = run_one('audiobook-healthy-001', 'askable', [], 'legacy')
        self.assertEqual(first_message(ad_f), first_message(ad_a))
        self.assertEqual(ask['evidence_handover']['withheld'], [])
        # an injected error shadows the recorded output, so it is not askable and stays in the message
        rec, _ = run_one('tv-insuff-002', 'askable', [], 'legacy')
        self.assertEqual(rec['evidence_handover']['withheld'], ['e1', 'e3'])
        self.assertIn('e2', rec['evidence_shown'])

    def test_none_withholds_an_entry_no_tool_can_return_and_askable_does_not(self):
        rec, _ = run_one('audiobook-healthy-001', 'none', [], 'v3.1')
        self.assertEqual(rec['evidence_handover']['withheld'], ['e1'])
        self.assertEqual(rec['evidence_handover']['withheld_tools'], {'e1': 'prior_record'})


@needs_suite11
class RecordedFirstReturn(unittest.TestCase):
    def test_a_call_returns_the_text_the_message_would_have_carried(self):
        calls = [('ffprobe', {}), ('decode_sample', {'full': True}), ('arr_lookup', {})]
        for fmt in FORMATS:
            full, _ = run_one('movie-decoder-002', None, [], fmt)
            none, _ = run_one('movie-decoder-002', 'none', calls, fmt)
            self.assertEqual([c['served_from_record'] for c in none['tool_calls']], ['e1', 'e2', 'e3'], fmt)
            handed = full['fixture_hashes']['evidence_shown_sha256']
            for c in none['tool_calls']:
                text = c['output'] if fmt == 'legacy' else c['raw_output']
                self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), handed[c['served_from_record']], (fmt, c['id']))
            self.assertEqual(none['evidence_handover']['obtained_by_call'], {'e1': 't1', 'e2': 't2', 'e3': 't3'})
            self.assertEqual(none['evidence_handover']['never_asked_for'], [])

    def test_a_call_that_matches_no_entry_goes_to_the_normal_tool(self):
        rec, _ = run_one('movie-decoder-002', 'none', [('decode_sample', {'at': 8})])
        call = rec['tool_calls'][0]
        self.assertNotIn('served_from_record', call)
        self.assertEqual(call['mode'], 'replay')
        self.assertEqual(rec['evidence_handover']['never_asked_for'], ['e1', 'e2', 'e3'])

    def test_ocr_by_time_and_by_frame(self):
        # movie-healthy-003 records the title card at 1.0 s
        rec, _ = run_one('movie-healthy-003', 'none', [('ocr', {'at': 1})], 'v3.1')
        self.assertEqual(rec['tool_calls'][0]['served_from_record'], 'e3')
        rec, _ = run_one('movie-healthy-003', 'none', [('frame_sample', {'at': 1}), ('ocr', {'frame': 'frame@1'})], 'v3.1')
        self.assertEqual(rec['tool_calls'][1]['served_from_record'], 'e3')
        rec, _ = run_one('movie-healthy-003', 'none', [('ocr', {'at': 7})], 'v3.1')
        self.assertNotIn('served_from_record', rec['tool_calls'][0])

    def test_the_injected_failure_is_not_overridden(self):
        rec, _ = run_one('tv-insuff-002', 'none', [('decode_sample', {'at': 0})])
        call = rec['tool_calls'][0]
        self.assertEqual(call['status'], 'error')
        self.assertNotIn('served_from_record', call)

    def test_epub_with_excerpt_arguments_is_a_different_request(self):
        case, _ = case_of('epub-healthy-003')
        self.assertIn('epub_inspect', case['tools_available'])
        plain, _ = run_one('epub-healthy-003', 'none', [('epub_inspect', {})])
        self.assertEqual(plain['tool_calls'][0]['served_from_record'], 'e1')
        asked, _ = run_one('epub-healthy-003', 'none', [('epub_inspect', {'spine': 0, 'offset': 0, 'length': 50})])
        self.assertNotIn('served_from_record', asked['tool_calls'][0])

    def test_a_tool_the_case_does_not_offer_is_still_a_violation(self):
        rec, _ = run_one('epub-healthy-003', 'none', [('ffprobe', {})])
        self.assertEqual(rec['tool_calls'][0]['status'], 'unavailable')
        self.assertTrue(rec['protocol_violations'])


@needs_suite11
class WhatTheModelWasShown(unittest.TestCase):
    """The audit, the guards and the reference check read the evidence the model was shown, not the case file."""

    def test_a_withheld_entry_is_not_an_unverified_part_until_a_call_returns_it(self):
        full, _ = run_one('audiobook-corrupt-001', None, [], 'v3.1')
        none, _ = run_one('audiobook-corrupt-001', 'none', [], 'v3.1')
        self.assertIn('e1', [p['id'] for p in full['unverified_parts']])        # the recorded ffprobe error is a part of the item that was not verified
        self.assertNotIn('e1', [p['id'] for p in none['unverified_parts']])
        asked, _ = run_one('audiobook-corrupt-001', 'none', [('ffprobe', {})], 'v3.1')
        self.assertIn('t1', [p['id'] for p in asked['unverified_parts']])

    def test_citing_a_withheld_entry_is_a_bad_reference(self):
        decision = dict(P.forced_decision_for('v7', 'x'), evidence_refs=['e1'])
        none, _ = run_one('movie-decoder-002', 'none', [], 'v3.1', decision=decision)
        self.assertEqual(none['bad_evidence_refs'], ['e1'])
        full, _ = run_one('movie-decoder-002', None, [], 'v3.1', decision=decision)
        self.assertEqual(full['bad_evidence_refs'], [])


class Refusals(unittest.TestCase):
    def test_incompatible_combinations_are_refused_before_a_model_call(self):
        ok = R.check_handover_options
        ok('full', 'live', 'v3-remote-1', True)           # full changes nothing, so nothing is refused
        ok('none', 'replay', None, False)
        ok('askable', 'replay', None, False)
        for args in (('none', 'live', None, False), ('askable', 'live', None, False), ('none', 'replay', 'v3-remote-1', False), ('none', 'replay', None, True), ('sometimes', 'replay', None, False)):
            with self.assertRaises(ValueError, msg=str(args)):
                ok(*args)

    def test_main_refuses_before_creating_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'run'
            base = ['--suite', str(SUITE11), '--adapter', 'scripted', '--model', 'm', '--script', '[]', '--out', str(out), '--prompt', 'v7', '--evidence-format', 'v3.1-format']
            for extra, text in ((['--evidence-handover', 'none', '--evidence', 'live'], 'replay only'),
                                (['--evidence-handover', 'none', '--tools-behavior', 'v3-remote-1'], 'refused with --tools-behavior'),
                                (['--evidence-handover', 'none', '--claude-schema', 'json-schema-1', '--experimental-claude-schema'], 'refused with --claude-schema')):
                with self.assertRaises(SystemExit) as cm:
                    R.main(base + extra)
                self.assertIn(text, str(cm.exception))
                self.assertFalse(out.exists())
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                R.build_parser().parse_args(base + ['--evidence-handover', 'sometimes'])

    @needs_suite11
    def test_run_case_refuses_the_experimental_claude_schema_mode(self):
        case, sha = case_of('movie-decoder-002')
        adapter = A.ScriptedAdapter('m', [])
        adapter.schema_mode = 'json-schema-1'
        with self.assertRaises(ValueError):
            R.run_case(case, sha, adapter, SUITE11, tempfile.mkdtemp(), evidence_handover='none')

    def test_handover_cannot_be_passed_positionally_past_the_checks(self):
        with self.assertRaises(TypeError):
            R.run_case({}, '', None, '.', '.', None, None, None, 'auto', '', None, 'v1', 'replay', None, None, None, None, None, None, 'none')


@needs_suite11
class MainRun(unittest.TestCase):
    def test_a_must_ask_run_records_its_setting_in_the_manifest_the_summary_and_the_record(self):
        replies = [{'type': 'tool_call', 'tool': 'ffprobe', 'args': {}, 'why': 'w'}, P.forced_decision_for('v7', 'x')]
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 's.json'
            script.write_text(json.dumps(replies))
            hashes = {}
            for name, extra in (('full', []), ('none', ['--evidence-handover', 'none'])):
                out = Path(tmp) / name
                code = R.main(['--suite', str(SUITE11), '--cases', 'movie-decoder-002', '--adapter', 'scripted', '--model', 'm', '--script', str(script), '--out', str(out),
                               '--scratch', str(Path(tmp) / 'scratch'), '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3'] + extra)
                self.assertFalse(code)
                manifest = json.loads((out / 'manifest.json').read_text())
                summary = json.loads((out / 'run_summary.json').read_text())
                rec = json.loads((out / 'movie-decoder-002.json').read_text())
                hashes[name] = manifest['config_hash']
                if name == 'full':
                    self.assertNotIn('evidence_handover', manifest['config'])
                    self.assertNotIn('evidence_handover', summary)
                    self.assertNotIn('evidence_handover', rec)
                else:
                    self.assertEqual(manifest['config']['evidence_handover']['mode'], 'none')
                    self.assertEqual(summary['evidence_handover']['version'], 'handover-1')
                    self.assertEqual(rec['evidence_handover']['obtained_by_call'], {'e1': 't1'})
                    self.assertEqual(rec['config_hash'], manifest['config_hash'])
            self.assertNotEqual(hashes['full'], hashes['none'])


@needs_suite11
class ReachabilityTable(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = MR.build(SUITE11)

    def test_the_committed_table_is_the_one_this_code_produces(self):
        self.assertEqual(MR.main(['--check']), 0)

    def test_every_reachable_entry_comes_back_identical_and_within_budget(self):
        s = self.doc['summary']
        self.assertEqual(s['cases'], 73)
        self.assertEqual(s['by_status'], {'fully_reachable': 59, 'partially_reachable': 3, 'unreachable': 11})
        self.assertEqual(s['withheld_entries'], 176)
        self.assertEqual(s['reachable_entries'], 162)
        self.assertEqual(s['unreachable_entries_by_reason'], {'injected_failure': 1, 'no_tool': 13})
        self.assertLessEqual(s['max_min_calls_with_all_pages'], P.MAX_TOOL_CALLS)
        self.assertEqual(s['cases_over_budget'], [])
        for c in self.doc['cases']:
            self.assertTrue(c['rerun_ok'], c['case'])
            for i in c['withheld']:
                if i.get('reachable'):
                    self.assertEqual(i['returns'], 'identical', (c['case'], i['id']))
                else:
                    self.assertIn(i['reason'], ('no_tool', 'injected_failure'), (c['case'], i['id']))

    def test_the_unreachable_cases_are_the_ones_with_no_tool(self):
        unreachable = sorted(c['case'] for c in self.doc['cases'] if c['status'] == 'unreachable')
        self.assertEqual(len(unreachable), 11)
        for c in self.doc['cases']:
            if c['status'] == 'unreachable':
                self.assertEqual(c['tools_offered'], [])
                self.assertEqual([i['tool'] for i in c['withheld']], ['prior_record'])
        self.assertEqual(sorted(c['case'] for c in self.doc['cases'] if c['status'] == 'partially_reachable'), ['movie-decoder-001', 'tv-insuff-001', 'tv-insuff-002'])

    def test_askable_leaves_the_unreachable_entries_in_the_message(self):
        self.assertEqual(self.doc['summary']['askable_kept_entries'], 14)
        self.assertEqual(self.doc['summary']['cases_unchanged_by_askable'], 11)


if __name__ == '__main__':
    unittest.main()
