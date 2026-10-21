"""#161 acceptance (pilot plan v3.2 section 3.6), tool and runner level: subtitle_sample, fail-closed receipts, identity binding, the stop option, raw write
attempts and legacy byte identity.  Fake runners only; no model call, no cluster, no media."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import rem_h as H
import th
from media_repair_harness import adapters as A
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import leakguard
from media_repair_harness import protocol as P
from media_repair_harness import remote_evidence as RE
from media_repair_harness import run as R
from media_repair_harness import tools as T

# mrh-sampler-1 as merged (7db2ec48): every earlier tools behaviour still sends exactly these bytes
SAMPLER_V1_SHA256 = '9c949e130f67ff76f7a0f7ba18343baebb53a17b295141c0e1470b04c252a3ad'


def run(case, replies, runner, stop=True, **kw):
    ad = A.ScriptedAdapter('scripted-model', replies)
    args = dict(H.V31, tools_behavior='v3-remote-1', stop_on_receipt_failure=stop)
    args.update(kw)
    rec = R.run_case(case, 'sha', ad, '.', tempfile.mkdtemp(), runner=runner, which=th.NO_BINARIES, run_id='run-x', **args)
    return rec, ad


def ctx_for(case, runner, binding=None):
    fx = T.Fixture.from_case(case, '.')
    ctx = T.Context(case, fx, tempfile.mkdtemp(), runner=runner, which=th.NO_BINARIES, tools_behavior='v3-remote-1',
                    remote_binding=binding or RE.binding_for_case(case, RE.HostState()))
    ctx.subtitle_stream = RE.select_subtitle_stream([dict(e, output=e['output']) for e in case['evidence']])
    return ctx


class EndToEnd(unittest.TestCase):
    def test_scripted_model_free_run_delivers_a_citable_cue_with_content_provenance(self):
        sampler = H.FakeSampler()
        rec, ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 600}), H.dec(refs=['t1.f2'])], sampler)
        self.assertNotIn('error', rec)
        last = ad.calls[-1][-1]
        self.assertEqual(last['role'], 'user')
        msg = json.loads(last['content'])
        self.assertEqual((msg['tool'], msg['status']), ('subtitle_sample', 'ok'))
        cues = [f for f in msg['output']['findings'] if f['kind'] == 'subtitle_cue']
        self.assertEqual([c['id'] for c in cues], ['t1.f1', 't1.f2'])
        self.assertEqual(cues[1]['detail'], 'We meet at the lighthouse.')        # tags removed, lines joined, text otherwise as read
        self.assertEqual(cues[1]['location'], {'stream': 3, 'start_s': 604.0, 'end_s': 606.0, 'cue': 2})
        self.assertEqual(msg['output']['kinds'], {'provenance': 'observed', 'fields': {'cues': 'content'}})
        self.assertEqual(msg['output']['facts']['stream'], {'index': 3, 'codec': 'subrip', 'language': 'eng'})
        # the stream came from the case's probe (the first TEXT stream, not the bitmap one); one sampler call, bound to the identity
        self.assertEqual(len(sampler.calls), 1)
        argv = sampler.calls[0]
        self.assertEqual(argv[argv.index('--stream') + 1], '3')
        self.assertEqual(argv[argv.index('--expect-size') + 1:argv.index('--expect-size') + 4], ['1000', '--expect-mtime-ns', '5'])
        self.assertEqual(rec['decision']['evidence_refs'], ['t1.f2'])
        self.assertEqual(rec['bad_evidence_refs'], [])
        re_rec = rec['remote_evidence']
        self.assertEqual((re_rec['hostname'], re_rec['operations'], re_rec['fatal']), ('pod-a', 1, None))
        self.assertEqual(rec['tool_calls'][0]['receipts'][0]['receipt']['hostname'], 'pod-a')
        self.assertNotIn('receipt', last['content'])            # receipts are record-only

    def test_cue_text_goes_through_the_leak_guard(self):
        srt = b'1\n00:00:01,000 --> 00:00:02,000\nthis is rx-leak-1 speaking\n\n'
        rec, ad = run(H.remote_case(id='rx-leak-1'), [th.tool_call('subtitle_sample', {'at': 5}), H.dec()], H.FakeSampler(default=H.answer(stdout=srt)))
        self.assertEqual(rec['error']['kind'], 'harness_crash')
        self.assertTrue(rec['error']['leak_guard'])
        self.assertEqual(len(ad.calls), 1)       # the message carrying the cue was never sent


class SubtitleTool(unittest.TestCase):
    def call(self, case, runner, args=None):
        return T.call_tool(ctx_for(case, runner), 'subtitle_sample', {'at': 30} if args is None else args)

    def test_absent_stream_is_unavailable_and_runs_nothing(self):
        for probe in (H.PROBE_NO_TEXT, None):
            s = H.FakeSampler()
            r = self.call(H.remote_case(probe=probe), s)
            self.assertEqual(r['status'], 'unavailable')
            self.assertEqual(s.calls, [])
            self.assertIn('no text subtitle stream', r['output'])

    def test_capability_says_unavailable_without_a_text_stream(self):
        case = H.remote_case(probe=H.PROBE_NO_TEXT)
        cap = T.capability(ctx_for(case, H.FakeSampler()), 'subtitle_sample')
        self.assertFalse(cap['available'])
        cap = T.capability(ctx_for(H.remote_case(), H.FakeSampler()), 'subtitle_sample')
        self.assertTrue(cap['available'])
        self.assertEqual(cap['stream']['index'], 3)

    def test_empty_window_is_unavailable_never_content(self):
        r = self.call(H.remote_case(), H.FakeSampler(default=H.answer(stdout=b'')))
        self.assertEqual(r['status'], 'unavailable')
        self.assertIn('held no subtitle cue', r['output'])
        d = EV2.derive(EV2.make_observation('t1', 'subtitle_sample', {'at': 30}, r['status'], r['output'], 'remote'))
        self.assertEqual(d.findings, [])

    def test_malformed_srt_is_an_execution_failure(self):
        for bad in (b'garbage without timing\n', b'1\n00:00:01 -> 00:00:02\nx\n\n', b'\xff\xfe\x00bad'):
            r = self.call(H.remote_case(), H.FakeSampler(default=H.answer(stdout=bad)))
            self.assertEqual(r['status'], 'error')
            d = EV2.derive(EV2.make_observation('t1', 'subtitle_sample', {'at': 30}, r['status'], r['output'], 'remote'))
            self.assertEqual((d.execution['state'], d.execution['cause']), ('failed', 'tool'))
            self.assertEqual(d.findings, [])

    def test_failed_extraction_is_an_error_without_cues(self):
        r = self.call(H.remote_case(), H.FakeSampler(default=H.answer(stdout=b'', exit_code=1, stderr='Stream map matches no streams')))
        self.assertEqual(r['status'], 'error')
        self.assertNotIn('cues', r['output'])

    def test_quota_is_a_scope_limit_not_a_failure(self):
        cut = H.SRT + b'3\n00:00:07,0'
        s = H.FakeSampler(default=H.answer(stdout=cut, quota_exhausted=True))
        r = self.call(H.remote_case(), s)
        self.assertEqual(r['status'], 'partial')
        out = json.loads(r['output'])
        self.assertEqual(out['cue_count'], 2)
        self.assertIn('quota', out['scope_limit'])
        self.assertNotIn('remote_fatal', r)

    def test_internal_timeout_with_a_receipt_is_a_scope_limit_and_the_next_call_runs(self):
        case = H.remote_case()
        s = H.FakeSampler([H.answer(stdout=b'', exit_code='timeout', timed_out=True)])
        ctx = ctx_for(case, s)
        r1 = T.call_tool(ctx, 'subtitle_sample', {'at': 30})
        self.assertEqual(r1['status'], 'timeout')
        self.assertNotIn('remote_fatal', r1)
        r2 = T.call_tool(ctx, 'subtitle_sample', {'at': 60})
        self.assertEqual(r2['status'], 'ok')
        self.assertEqual(len(s.calls), 2)

    def test_model_cannot_choose_the_stream(self):
        r = self.call(H.remote_case(), H.FakeSampler(), {'at': 3, 'stream': 1})
        self.assertEqual(r['status'], 'error')
        self.assertIn('bad arguments', r['output'])

    def test_srt_parser_rules(self):
        cues, err = RE.parse_srt(b'\xef\xbb\xbf1\r\n00:00:00,500 --> 00:00:01,000\r\n<b>A</b>\r\n\r\n2\n00:00:02.000 --> 00:00:03.000\n{\\i1}\n\n')
        self.assertIsNone(err)
        self.assertEqual(cues, [{'start': 0.5, 'end': 1.0, 'text': 'A'}])      # the tag-only cue is dropped
        self.assertEqual(RE.parse_srt(b'1\n00:00:00,500 --> 00:00:01,000\nA\n\n2\n00:0', cut=True)[0][0]['text'], 'A')
        self.assertIsNotNone(RE.parse_srt(b'1\n00:00:00,500 --> 00:00:01,000\nA\n\n2\n00:0', cut=False)[1])


class FailClosed(unittest.TestCase):
    """Each fatal path makes the result failed (cause tool), discards the output, and with the stop option ends the run with no further invocation."""

    def assert_fatal_stop(self, script, kind, calls_expected, first=None):
        replies = ([th.tool_call('subtitle_sample', {'at': 10})] if first else []) + [th.tool_call('subtitle_sample', {'at': 20}), H.dec(), H.dec()]
        s = H.FakeSampler(([H.answer()] if first else []) + script)
        with self.assertRaises(R.RemoteStop) as cm:
            run(H.remote_case(), replies, s)
        partial = cm.exception.partial
        self.assertEqual(partial['status'], 'started_aborted')
        self.assertEqual(len(s.calls), calls_expected)               # nothing after the failed operation
        self.assertEqual(partial['remote_evidence']['fatal']['kind'], kind)
        last = partial['tool_calls'][-1]
        self.assertEqual((last['status'], last['remote_fatal']['kind']), ('error', kind))
        self.assertNotIn('Hello', last['output'])                     # the output of a failed operation is never used
        self.assertEqual(len(partial['remote_evidence']['receipts']), calls_expected)
        return partial

    def test_identity_change_between_two_successful_calls_stops_the_run(self):
        moved = {'size': 1001, 'mtime_ns': 9}
        p = self.assert_fatal_stop([H.answer(identity={'expected': H.IDENT, 'start': moved, 'end': moved, 'start_ok': False, 'end_ok': False},
                                             exit_code='error', error='identity mismatch at start; nothing was read', stdout=b'')],
                                   'identity_mismatch', 2, first=True)
        self.assertEqual(p['remote_evidence']['receipts'][0]['outcome'], 'ok')
        self.assertEqual(len([t for t in p['turns'] if 'usage' in t]), 2)     # the model was not called after the failure

    def test_end_identity_change_is_fatal(self):
        moved = {'size': 1000, 'mtime_ns': 6}
        self.assert_fatal_stop([H.answer(identity={'expected': H.IDENT, 'start': H.IDENT, 'end': moved, 'start_ok': True, 'end_ok': False}, source_unchanged=False)],
                               'identity_mismatch', 1)

    def test_source_unchanged_false_is_fatal(self):
        self.assert_fatal_stop([H.answer(source_unchanged=False)], 'source_changed', 1)

    def test_missing_receipt_is_fatal(self):
        for script in ([H.raw(0, H.SRT, b'')], [H.raw(0, H.SRT, b'Traceback (most recent call last):\n  boom\n')], [H.raw(137, b'', b'')]):
            self.assert_fatal_stop(script, 'missing_receipt', 1)

    def test_malformed_receipts_are_fatal(self):
        bad = [H.answer(hostname=''), H.answer(stdout_bytes=3), H.answer(exit_code='weird'), H.answer(identity=None), H.answer(mode='decode'),
               H.answer(quota_exhausted='no'), H.answer(exit_code='timeout'), H.answer(source_unchanged=None)]
        for step in bad:
            self.assert_fatal_stop([step], 'malformed_receipt', 1)

    def test_hostname_change_is_fatal(self):
        self.assert_fatal_stop([H.answer(host='pod-b')], 'hostname_changed', 2, first=True)

    def test_outer_timeout_and_failed_exec_are_fatal(self):
        self.assert_fatal_stop([H.outer_timeout], 'outer_timeout', 1)
        self.assert_fatal_stop([lambda argv: OSError('kubectl: not found')], 'exec_failed', 1)

    def test_missing_expected_identity_invokes_nothing(self):
        s = H.FakeSampler()
        with self.assertRaises(R.RemoteStop) as cm:
            run(H.remote_case(ident=None), [th.tool_call('subtitle_sample', {'at': 20}), H.dec()], s)
        self.assertEqual(s.calls, [])
        self.assertEqual(cm.exception.partial['remote_evidence']['fatal']['kind'], 'no_expected_identity')

    def test_every_remote_tool_is_bound(self):
        """ffprobe and decode_sample go through the same receipts and binding."""
        for tool, args in (('ffprobe', {}), ('decode_sample', {'at': 4})):
            s = H.FakeSampler([H.answer(host='pod-z')])
            with self.assertRaises(R.RemoteStop):
                run(H.remote_case(), [th.tool_call(tool, args), H.dec()], s)
            self.assertIn('--expect-size', s.calls[0])

    def test_without_the_stop_option_the_result_fails_and_nothing_further_is_invoked(self):
        s = H.FakeSampler([H.answer(host='pod-b')])
        rec, ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 20}), th.tool_call('subtitle_sample', {'at': 40}), H.dec(cls='insufficient_evidence')],
                      s, stop=False)
        self.assertEqual(len(s.calls), 1)
        self.assertEqual([c['status'] for c in rec['tool_calls']], ['error', 'error'])
        self.assertEqual(rec['tool_calls'][1]['remote_fatal']['kind'], 'stopped')
        self.assertEqual(rec['remote_evidence']['fatal']['kind'], 'hostname_changed')
        msg = json.loads(ad.calls[1][-1]['content'])
        self.assertEqual(msg['output']['execution']['cause'], 'tool')

    def test_main_stops_the_run_and_later_cases_never_start(self):
        tmp = Path(tempfile.mkdtemp())
        suite = th.TempSuite([H.remote_case(id='rx-a'), H.remote_case(id='rx-b')])
        script = tmp / 'script.json'
        script.write_text(json.dumps([th.tool_call('subtitle_sample', {'at': 20}), H.dec(), H.dec(), H.dec()]))
        s = H.FakeSampler([H.answer(host='pod-b')])
        rc = R.main(['--suite', str(suite.root), '--adapter', 'scripted', '--model', 'scripted-model', '--script', str(script), '--out', str(tmp / 'run'),
                     '--scratch', str(tmp / 'scratch'), '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3',
                     '--tools-behavior', 'v3-remote-1', '--stop-on-receipt-failure'], runner=s)
        self.assertEqual(rc, 3)
        man = json.loads((tmp / 'run' / 'manifest.json').read_text())
        self.assertEqual((man['started_aborted'], man['never_started'], man['records_written']), (['rx-a'], ['rx-b'], []))
        self.assertIn('hostname_changed', man['aborted'])
        self.assertEqual(len(s.calls), 1)
        self.assertEqual(man['config']['tools_behavior'], 'v3-remote-1')
        self.assertTrue(man['config']['stop_on_receipt_failure'])
        self.assertEqual(man['config']['remote_evidence']['sampler_sha256'], hashlib.sha256(RE.SAMPLER.read_bytes()).hexdigest())
        partial = json.loads((tmp / 'run' / 'started-aborted' / 'rx-a.json').read_text())
        self.assertEqual(partial['remote_evidence']['receipts'][0]['fatal']['kind'], 'hostname_changed')
        suite.cleanup()

    def test_option_combinations_are_refused(self):
        with self.assertRaises(ValueError):
            R.check_remote_options(None, None, True)
        with self.assertRaises(ValueError):
            R.check_remote_options('v3', 'v3-remote-1')
        with self.assertRaises(ValueError):
            R.check_remote_options('v3.1-format', 'v3-remote-1', evidence_mode='live')
        R.check_remote_options('v3.1-format', 'v3-remote-1', True)


class WriteAttempts(unittest.TestCase):
    def test_raw_write_attempts_are_recorded_when_rejected_or_forced(self):
        bad_write = json.dumps({'type': 'decision', 'class': 'identity_mismatch', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.9,
                                'evidence_refs': ['e1']})        # no source / target: decision-v3 rejects it
        rec, _ad = run(H.remote_case(), [bad_write, bad_write], H.FakeSampler())
        self.assertTrue(rec['forced'])
        self.assertEqual([a['action'] for a in rec['write_rejection']['attempts']], ['blocklist_and_search', 'blocklist_and_search'])
        from media_repair_harness import stage_r as SR
        sources = [a['source'] for a in SR.write_attempts(rec)]
        self.assertEqual(sources.count('rejected_by_validation'), 2)
        self.assertEqual(sources.count('raw_reply'), 2)

    def test_write_attempts_survive_a_stop(self):
        bad_write = json.dumps({'type': 'decision', 'class': 'identity_mismatch', 'action': 'rename', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': []})
        s = H.FakeSampler([H.answer(host='pod-b')])
        with self.assertRaises(R.RemoteStop) as cm:
            run(H.remote_case(), [bad_write, th.tool_call('subtitle_sample', {'at': 20}), H.dec()], s)
        partial = cm.exception.partial
        self.assertEqual(partial['write_rejection']['attempts'][0]['action'], 'rename')


class LegacyIdentity(unittest.TestCase):
    def test_sampler_v1_is_byte_identical(self):
        self.assertEqual(hashlib.sha256(T.REMOTE_SAMPLER.read_bytes()).hexdigest(), SAMPLER_V1_SHA256)

    def test_shared_tables_are_unchanged(self):
        self.assertEqual(P.TOOLS, ('ffprobe', 'decode_sample', 'frame_sample', 'audio_sample', 'ocr', 'epub_inspect', 'audiobook_inspect', 'arr_lookup'))
        self.assertNotIn('subtitle_sample', T.REGISTRY)
        self.assertNotIn('subtitle_sample', leakguard.WRITE_ACTIONS)

    def test_earlier_configurations_send_sampler_v1_and_record_nothing_new(self):
        """The same remote case without the option: mrh-sampler-1 on stdin, no expected identity, no receipts, no remote_evidence field, and a
        subtitle_sample call is a not-offered tool shown as unknown_tool."""
        calls = []

        def runner(argv, input=None, **kw):
            calls.append((argv, input))
            return H.Completed(0, b'', json.dumps({'exit_code': 0, 'stderr': '', 'quota_exhausted': False}).encode())
        ad = A.ScriptedAdapter('m', [th.tool_call('decode_sample', {'at': 4}), th.tool_call('subtitle_sample', {'at': 4}), H.dec()])
        rec = R.run_case(H.remote_case(), 'sha', ad, '.', tempfile.mkdtemp(), runner=runner, which=th.NO_BINARIES, run_id='run-x', **H.V31)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], T.REMOTE_SAMPLER.read_bytes())
        self.assertNotIn('--expect-size', calls[0][0])
        self.assertNotIn('remote_evidence', rec)
        self.assertNotIn('receipts', rec['tool_calls'][0])
        self.assertEqual(rec['tool_calls'][1]['status'], 'unavailable')
        self.assertEqual(json.loads(ad.calls[2][-1]['content'])['tool'], 'unknown_tool')

    def test_config_is_unchanged_without_the_options(self):
        argv = ['--suite', 's', '--adapter', 'scripted', '--model', 'm', '--out', 'o', '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3']
        args = R.build_parser().parse_args(argv)
        ad = A.ScriptedAdapter('m', [])
        cfg = R.run_config(args, ad, {}, {})
        self.assertNotIn('remote_evidence', cfg)
        self.assertNotIn('stop_on_receipt_failure', cfg)
        self.assertEqual(cfg['tools_behavior'], 'v3')
        cfg2 = R.run_config(R.build_parser().parse_args(argv + ['--tools-behavior', 'v3-remote-1']), ad, {}, {})
        self.assertEqual(cfg2['tools_behavior'], 'v3-remote-1')
        self.assertEqual(dict({k: v for k, v in cfg2.items() if k != 'remote_evidence'}, tools_behavior='v3'), cfg)


if __name__ == '__main__':
    unittest.main()
