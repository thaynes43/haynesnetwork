"""#161 acceptance (pilot plan v3.2 section 3.6), tool and runner level: subtitle_sample, fail-closed receipts, identity binding, the stop option, raw write
attempts and legacy byte identity.  Fake runners only; no model call, no cluster, no media."""
import hashlib
import json
import re
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
        s = H.FakeSampler(default=H.answer(stdout=cut, quota_exhausted=True, bytes_read=RE.QUOTA_BYTES))
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
        moved = {'size': 1001, 'mtime_ns': 9, 'dev': 64, 'ino': 77}
        p = self.assert_fatal_stop([H.answer(identity={'expected': H.IDENT, 'start': moved, 'end': None, 'start_ok': False, 'end_ok': None, 'same_file': None},
                                             exit_code='error', error='identity mismatch at start; nothing was read', stdout=b'', source_unchanged=None, bytes_read=0)],
                                   'identity_mismatch', 2, first=True)
        self.assertEqual(p['remote_evidence']['receipts'][0]['outcome'], 'ok')
        self.assertEqual(len([t for t in p['turns'] if 'usage' in t]), 2)     # the model was not called after the failure

    def test_end_identity_change_is_fatal(self):
        moved = {'size': 1000, 'mtime_ns': 6, 'dev': 64, 'ino': 77}
        self.assert_fatal_stop([H.answer(identity={'expected': H.IDENT, 'start': H.IDENT, 'end': moved, 'start_ok': True, 'end_ok': False, 'same_file': True}, source_unchanged=False)],
                               'identity_mismatch', 1)

    def test_source_unchanged_false_is_fatal(self):
        """An unbound operation (the driver's G1 stat) whose file changed during it: source_changed.  (A bound one is an identity mismatch, above.)"""
        moved = {'size': 1000, 'mtime_ns': 6, 'dev': 64, 'ino': 77}
        b = RE.Binding(host=RE.HostState(), root='/a')
        step = H.answer(ident=None, identity={'expected': None, 'start': H.IDENT, 'end': moved, 'start_ok': None, 'end_ok': None, 'same_file': True},
                        source_unchanged=False)
        with self.assertRaises(RE.FatalOperation) as cm:
            RE.run_operation(H.FakeSampler([step]), 'ns', 'deploy/x', 'app', 'stat', '/a/b.mkv', b, bind_identity=False)
        self.assertEqual(cm.exception.kind, 'source_changed')

    def test_missing_receipt_is_fatal(self):
        for script in ([H.raw(0, H.SRT, b'')], [H.raw(0, H.SRT, b'Traceback (most recent call last):\n  boom\n')]):
            self.assert_fatal_stop(script, 'missing_receipt', 1)
        self.assert_fatal_stop([H.raw(137, b'', b'')], 'exec_failed', 1)        # a non-zero exec exit is fatal before any receipt is read

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

    def test_the_experimental_claude_schema_mode_is_refused(self):
        """Rebase onto #1035: schema mode re-runs a case through its own guard with a fixed argument set, which would drop the remote options."""
        with self.assertRaises(SystemExit) as cm:
            R.main(['--suite', 's', '--adapter', 'claude', '--model', 'm', '--out', tempfile.mkdtemp() + '/o', '--prompt', 'v7', '--evidence-format', 'v3.1-format',
                    '--tools-behavior', 'v3-remote-1', '--claude-schema', 'json-schema-1', '--experimental-claude-schema'])
        self.assertIn('refused with --claude-schema', str(cm.exception))
        ad = A.ScriptedAdapter('m', [])
        ad.schema_mode = 'json-schema-1'
        with self.assertRaises(ValueError):
            R.run_case(H.remote_case(), 'sha', ad, '.', tempfile.mkdtemp(), runner=H.FakeSampler(), which=th.NO_BINARIES, tools_behavior='v3-remote-1', **H.V31)

    def test_option_combinations_are_refused(self):
        with self.assertRaises(ValueError):
            R.check_remote_options(None, None, True)
        with self.assertRaises(ValueError):
            R.check_remote_options('v3', 'v3-remote-1')
        with self.assertRaises(ValueError):
            R.check_remote_options('v3.1-format', 'v3-remote-1', evidence_mode='live')
        R.check_remote_options('v3.1-format', 'v3-remote-1', True)


class Round1Receipts(unittest.TestCase):
    """Review round 1 of #1036 (Opus, f21f8f83): receipts that are valid JSON but wrong, a failed exec with a receipt, and an injected failure over a fatal.
    Each delivered cues as ok at f21f8f83."""

    def call(self, step, case=None):
        ctx = ctx_for(case or H.remote_case(), H.FakeSampler([step]))
        r = T.call_tool(ctx, 'subtitle_sample', {'at': 30})
        return r, ctx.remote_binding.fatal

    def assert_fatal(self, step, kind, case=None):
        r, fatal = self.call(step, case)
        self.assertEqual(r['status'], 'error')
        self.assertNotIn('Hello', str(r['output']))
        self.assertEqual((r['remote_fatal']['kind'], fatal['kind']), (kind, kind))

    def test_nonzero_exec_exit_with_a_valid_receipt_is_fatal(self):
        self.assert_fatal(lambda argv: H.Completed(1, H.FakeSampler.ok(argv).stdout, H.FakeSampler.ok(argv).stderr), 'exec_failed')

    def test_non_boolean_source_unchanged_is_malformed(self):
        for v in (0, 1, 'true'):
            self.assert_fatal(H.answer(source_unchanged=v), 'malformed_receipt')

    def test_missing_source_unchanged_never_delivers_cues(self):
        def step(argv):
            r = H.receipt('subtitle', H.SRT, exit_code='timeout', timed_out=True)
            r.pop('source_unchanged')
            return H.Completed(0, H.SRT, json.dumps(r).encode())
        self.assert_fatal(step, 'malformed_receipt')
        # present but null after an operation that read something: its end was not verified
        end_unknown = {'expected': H.IDENT, 'start': H.IDENT, 'end': None, 'start_ok': True, 'end_ok': None, 'same_file': None}
        self.assert_fatal(H.answer(exit_code='timeout', timed_out=True, source_unchanged=None, identity=end_unknown), 'identity_mismatch')

    def test_identity_values_must_be_integers(self):
        for bad in (dict(H.IDENT, size=1000.0), dict(H.IDENT, ino=True), dict(H.IDENT, mtime_ns='5'), {'size': 1000, 'mtime_ns': 5}, dict(H.IDENT, dev=-1)):
            self.assert_fatal(H.answer(identity={'expected': bad, 'start': bad, 'end': bad, 'start_ok': True, 'end_ok': True, 'same_file': True}),
                              'malformed_receipt')

    def test_every_field_is_typed_and_ranged(self):
        for over in (dict(wall_seconds=float('nan')), dict(wall_seconds=-1), dict(wall_seconds=1e9), dict(bytes_read=-5), dict(bytes_read=True),
                     dict(requests=None), dict(timed_out=0), dict(error=5), dict(hostname='pod a'), dict(quota_exhausted=True)):
            self.assert_fatal(H.answer(**over), 'malformed_receipt')
        def bad_argv(argv):
            r = H.receipt('subtitle', H.SRT, argv='nice')
            return H.Completed(0, H.SRT, json.dumps(r).encode())
        self.assert_fatal(bad_argv, 'malformed_receipt')
        for key in ('requests', 'error', 'argv', 'identity'):
            def step(argv, key=key):
                r = H.receipt('subtitle', H.SRT)
                r.pop(key)
                return H.Completed(0, H.SRT, json.dumps(r).encode())
            self.assert_fatal(step, 'malformed_receipt')

    def test_source_unchanged_must_agree_with_the_identities(self):
        moved = {'size': 2000, 'mtime_ns': 9, 'dev': 64, 'ino': 77}
        b = RE.Binding(host=RE.HostState(), root='/a')
        step = H.answer(ident=None, identity={'expected': None, 'start': H.IDENT, 'end': moved, 'start_ok': None, 'end_ok': None, 'same_file': True},
                        source_unchanged=True)
        with self.assertRaises(RE.FatalOperation) as cm:
            RE.run_operation(H.FakeSampler([step]), 'ns', 'deploy/x', 'app', 'stat', '/a/b.mkv', b, bind_identity=False)
        self.assertEqual(cm.exception.kind, 'malformed_receipt')
        # and the path naming another file (same_file false) is a change even when size and mtime agree
        self.assert_fatal(H.answer(identity=dict(H.receipt('subtitle')['identity'], same_file=False, end_ok=False), source_unchanged=False), 'identity_mismatch')

    def test_control_a_consistent_receipt_still_delivers(self):
        r, fatal = self.call(H.answer())
        self.assertEqual((r['status'], fatal), ('ok', None))

    def test_injected_partial_never_hides_a_fatal(self):
        r, fatal = self.call(H.answer(host='pod-b'), H.remote_case(inject_tool_failure={'tool': 'subtitle_sample', 'mode': 'partial'}))
        self.assertEqual((r['status'], r['remote_fatal']['kind'], fatal['kind']), ('error', 'hostname_changed', 'hostname_changed'))
        r, fatal = self.call(H.answer(), H.remote_case(inject_tool_failure={'tool': 'subtitle_sample', 'mode': 'partial'}))
        self.assertEqual((r['status'], fatal), ('partial', None))        # control: without a fatal the injection still applies


class Round1Runner(unittest.TestCase):
    """Review round 1 of #1036 at the runner: legacy gating of subtitle evidence, delivery, the target deadline, per-attempt audits, SRT timestamps, and
    every tool-level fatal kind stopping with no further invocation."""

    SUB = {'stream': {'index': 3, 'codec': 'subrip'}, 'window': {'at_s': 0, 'window_s': 8}, 'cues': [{'cue': 1, 'start_s': 1, 'end_s': 2, 'text': 'The id is %s.'}]}

    def initial_subtitle_case(self, cid, **kw):
        sub = json.loads(json.dumps(self.SUB))
        sub['cues'][0]['text'] %= cid
        return dict(H.remote_case(id=cid, **kw), evidence=H.remote_case()['evidence'] + [{'id': 'e2', 'tool': 'subtitle_sample', 'status': 'ok', 'args': {},
                                                                                             'output': json.dumps(sub)}])

    def test_legacy_initial_subtitle_evidence_is_guarded_as_before(self):
        """Astra 14: with NO new option a case whose evidence names subtitle_sample is read exactly as on the base (a record; the legacy check reads it)."""
        case = self.initial_subtitle_case('hidden-legacy-7')
        case['fixture'] = {'kind': 'none'}
        ad = A.ScriptedAdapter('m', [H.dec('insufficient_evidence')])
        rec = R.run_case(case, 'sha', ad, '.', tempfile.mkdtemp(), which=th.NO_BINARIES, run_id='x', **H.V31)
        self.assertEqual((len(ad.calls), rec['error']['kind'], rec['error']['leak_guard']), (0, 'harness_crash', True))
        self.assertNotIn('remote_evidence', rec)

    def test_initial_subtitle_evidence_is_a_media_source_under_the_option(self):
        rec, ad = run(self.initial_subtitle_case('hidden-remote-7'), [H.dec('insufficient_evidence')], H.FakeSampler())
        self.assertEqual((len(ad.calls), rec['error']['kind'], rec['error']['leak_guard']), (0, 'harness_crash', True))

    def test_only_cues_actually_sent_are_delivered(self):
        """Opus 6 / Astra 7: 40 cues, the first page shows some; a guessed id of an unfetched page is not delivered; a guard-blocked message delivers none."""
        srt = b''.join(b'%d\n00:00:%02d,000 --> 00:00:%02d,500\n%s\n\n' % (i + 1, i, i, (b'word%02d ' % i) * 40) for i in range(40))
        rec, ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 60}), H.dec(refs=['t1.f30'])], H.FakeSampler(default=H.answer(stdout=srt)))
        delivered = rec['remote_evidence']['delivered_cue_ids']
        shown = set(re.findall(r'"(t1\.f\d+)"', ad.calls[1][-1]['content']))
        self.assertEqual(set(delivered), shown)
        self.assertTrue(0 < len(delivered) < 40)
        self.assertNotIn('t1.f30', delivered)
        from media_repair_harness import stage_r as SR
        self.assertNotIn('t1.f30', [c['id'] for c in SR.delivered_cues(rec)])
        leak = b'1\n00:00:01,000 --> 00:00:02,000\nthis is rx-leak-2 speaking\n\n'
        rec, _ad = run(H.remote_case(id='rx-leak-2'), [th.tool_call('subtitle_sample', {'at': 5}), H.dec()], H.FakeSampler(default=H.answer(stdout=leak)))
        self.assertEqual(rec['remote_evidence']['delivered_cue_ids'], [])

    def test_operations_start_only_inside_the_target_deadline(self):
        """Astra 11: an operation whose 60 s outer deadline does not fit the time left of the target stops the run without an invocation."""
        s = H.FakeSampler()
        with self.assertRaises(R.RemoteStop) as cm:
            run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 5}), H.dec()], s, remote_time_left=lambda: 59.0)
        self.assertEqual((s.calls, cm.exception.partial['remote_evidence']['fatal']['kind']), ([], 'target_deadline'))
        rec, _ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 5}), H.dec()], H.FakeSampler(), remote_time_left=lambda: 61.0)
        self.assertIsNone(rec['remote_evidence']['fatal'])       # control
        tmp = Path(tempfile.mkdtemp())
        suite = th.TempSuite([H.remote_case(id='rx-d')])
        script = tmp / 'script.json'
        script.write_text(json.dumps([th.tool_call('subtitle_sample', {'at': 20}), H.dec()]))
        s = H.FakeSampler()
        rc = R.main(['--suite', str(suite.root), '--adapter', 'scripted', '--model', 'm', '--script', str(script), '--out', str(tmp / 'run'), '--scratch', str(tmp / 's'),
                     '--prompt', 'v7', '--evidence-format', 'v3.1-format', '--guards', 'v3', '--tools-behavior', 'v3-remote-1', '--stop-on-receipt-failure',
                     '--max-wall-s', '50'], runner=s)
        self.assertEqual((rc, s.calls), (3, []))
        suite.cleanup()

    def test_each_raw_write_attempt_is_audited_on_its_own(self):
        """Astra 15: two rejected writes and a forced escalate: each attempt carries its own schema failure, never null; a valid offender write is audited
        against the evidence before its turn."""
        bad = json.dumps({'type': 'decision', 'class': 'identity_mismatch', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': ['e1']})
        rec, _ad = run(H.remote_case(), [bad, '```json\n' + bad + '\n```'], H.FakeSampler())
        atts = rec['remote_evidence']['write_attempts']
        self.assertEqual([(a['turn'], a['parse'], a['audit']['state']) for a in atts], [(1, 'strict', 'schema_failure'), (2, 'lenient', 'schema_failure')])
        self.assertTrue(all(a['audit']['errors'] for a in atts))
        good = json.dumps({'type': 'decision', 'class': 'identity_mismatch', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.9,
                           'evidence_refs': ['t1.f1'], 'source': {'ref': 'case_item'}, 'target': {'kind': 'release_of_source', 'source_ref': 't1'}})
        rec, _ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 5}), good], H.FakeSampler())
        a = rec['remote_evidence']['write_attempts'][0]
        self.assertEqual((a['turn'], a['audit']['state'], a['audit']['evidence_before_turn']), (2, 'audited', ['e1', 't1']))
        self.assertIsInstance(a['audit']['prerequisites'], list)

    def test_srt_timestamps_are_validated(self):
        """Astra 17: an impossible or reversed timing line is malformed (no cue); a cut final cue is marked truncated."""
        for bad in (b'1\n99:99:99,000 --> 00:00:00,000\nx\n\n', b'1\n00:00:05,000 --> 00:00:04,000\nx\n\n', b'1\n00:61:00,000 --> 00:62:00,000\nx\n\n'):
            cues, problem = RE.parse_srt(bad)
            self.assertEqual(cues, [])
            self.assertIsNotNone(problem)
            r = T.call_tool(ctx_for(H.remote_case(), H.FakeSampler(default=H.answer(stdout=bad))), 'subtitle_sample', {'at': 1})
            self.assertEqual(r['status'], 'error')
        cues, problem = RE.parse_srt(b'1\n00:00:01,000 --> 00:00:02,000\nThe name was half', cut=True)
        self.assertEqual((problem, cues[0].get('truncated')), (None, True))
        cues, _p = RE.parse_srt(b'1\n00:00:01,000 --> 00:00:02,000\nWhole.\n\n', cut=True)
        self.assertNotIn('truncated', cues[0])

    def fatal_without_invocation(self, case, kind, step=None, calls=0):
        s = H.FakeSampler([step] if step else [])
        with self.assertRaises(R.RemoteStop) as cm:
            run(case, [th.tool_call('subtitle_sample', {'at': 5}), th.tool_call('subtitle_sample', {'at': 9}), H.dec()], s)
        self.assertEqual((len(s.calls), cm.exception.partial['remote_evidence']['fatal']['kind']), (calls, kind))
        self.assertEqual(len([t for t in cm.exception.partial['turns'] if 'usage' in t]), 1 + (1 if calls and kind == 'operation_cap' else 0))

    def test_every_tool_fatal_kind_stops_with_nothing_further(self):
        case = H.remote_case()
        case['fixture'].pop('allowed_root')
        self.fatal_without_invocation(case, 'no_allowed_root')
        self.fatal_without_invocation(H.remote_case(ident=None), 'no_expected_identity')
        capped = H.remote_case()
        capped['fixture']['max_operations'] = 1
        self.fatal_without_invocation(capped, 'operation_cap', H.answer(), calls=1)
        self.fatal_without_invocation(H.remote_case(), 'not_confined', H.answer(confined=False, exit_code='error', stdout=b'', source_unchanged=None,
                                                                                   identity=dict(H.receipt('x')['identity'], start=None, end=None, start_ok=None,
                                                                                                 end_ok=None, same_file=None), bytes_read=0), calls=1)
        self.fatal_without_invocation(H.remote_case(), 'not_confined', H.answer(confined=None), calls=1)


class Round2(unittest.TestCase):
    """Review round 2 of #1036 (Opus re-review and AUDIT-ASTRA-62 candidates on c9500910)."""

    W = {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': []}

    def test_write_intent_rule_scans_every_reply_in_any_syntax(self):
        """Opus minor 1 / Astra A1: write-intent-2 finds a write action bound to an action-like key in any common syntax, whatever the reply parsed as."""
        hdec = {'type': 'decision', 'class': 'healthy', 'action': 'none', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': []}
        tool = {'type': 'tool_call', 'tool': 'ffprobe', 'args': {}, 'why': 'x'}
        found = {
            'bare json': json.dumps({'action': 'rename'}), 'misspelt type': json.dumps({'type': 'decison', 'action': 'rename'}),
            'tool call with action': json.dumps(dict(tool, action='rename')), 'python literal': str(self.W),
            'yaml-like': 'type: decision\naction: rename\nclass: metadata_naming', 'equals': 'action=convert', 'uppercase': json.dumps(dict(self.W, action='RENAME')),
            'nested alternative': json.dumps(dict(hdec, alternatives=[{'action': 'remap'}])),
            'unicode escape': '{"type":"decision","action":"\\u0072ename"}', 'multi-word spaced': "{'Action': 'Blocklist and Search'}",
            'list value': 'actions: [convert]', 'other action key': '"proposed_action": "remap"', 'fenced': '```json\n%s\n```' % json.dumps(self.W),
            'healthy then prose write': json.dumps(hdec) + '\nor: {"action": "rename"}'}
        for name, text in found.items():
            intent = RE.raw_write_intent(text)
            self.assertIsNotNone(intent, name)
            self.assertEqual(intent['rule'], 'write-intent-3')
        self.assertEqual(RE.raw_write_intent(found['multi-word spaced'])['action'], 'blocklist_and_search')
        for text in ('I would not rename this file.', 'action: none', json.dumps(hdec), json.dumps(tool), 'the action is rename', 'rename it? no.', '', None):
            self.assertIsNone(RE.raw_write_intent(text), text)

    def test_unparseable_writes_reach_write_control_end_to_end(self):
        """Opus p5 / Astra A1: a Python-literal, a YAML-like or a bare {"action": "rename"} reply, then a healthy decision: the attempt is recorded and is
        WRITE-CONTROL on a non-offender."""
        from media_repair_harness import stage_r as SR
        for reply in (str(self.W), 'type: decision\nclass: metadata_naming\naction: rename', json.dumps({'action': 'rename'})):
            rec, _ad = run(H.remote_case(), [reply, H.dec('healthy', 'none')], H.FakeSampler())
            self.assertEqual([a['action'] for a in rec['remote_evidence']['write_attempts']], ['rename'], reply)
            self.assertTrue(SR.proposal_safety('verified', rec)['write_control'])

    def test_cue_text_that_looks_like_an_id_is_never_delivery(self):
        """Astra A2: a cue whose text is another (unfetched) cue's id does not deliver that cue; delivery is read from the message structure."""
        from media_repair_harness import stage_r as SR
        lines = ''.join('%d\n00:00:01,000 --> 00:00:02,000\n%s\n\n' % (i, 't1.f40' if i == 1 else 'CUE%02d ' % i + 'word ' * 53) for i in range(1, 41))
        rec, ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 60}), H.dec(refs=['t1.f40'])], H.FakeSampler(default=H.answer(stdout=lines.encode())))
        self.assertIn('t1.f40', ad.calls[-1][-1]['content'])          # the id is in the text the model saw ...
        delivered = rec['remote_evidence']['delivered_cue_ids']
        self.assertNotIn('t1.f40', delivered)                         # ... but cue 40 was never delivered
        self.assertIn('t1.f1', delivered)
        res = SR.evaluate_target('o', 'offender', 'recorded', rec, {})
        self.assertEqual(res['diagnosis'], 'MISS')
        with self.assertRaises(ValueError):
            import importlib.util
            spec = importlib.util.spec_from_file_location('srr', Path(__file__).resolve().parent.parent / 'scripts' / 'stage_r_report.py')
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            reg = {'targets': [{'key': 'o', 'role': 'offender'}]}
            p = Path(tempfile.mkdtemp()) / 'o.json'
            p.write_text(json.dumps(rec))
            mod.evaluate({'targets': {'o': {'role': 'offender', 'driver_outcome': 'recorded', 'g2': {'record': str(p)}}}, 'exit_code': 0,
                          'registration_sha256': mod.registration_sha256(reg)}, {'verdicts': [{'target': 'o', 'cue': 't1.f40', 'verdict': 'accepted'}]}, reg)

    def test_a_failed_model_call_delivers_nothing(self):
        """Opus nit: a message counts as delivered only when the model call that carried it completed."""
        rec, _ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 60}), A.AdapterError('transport failed')], H.FakeSampler())
        self.assertTrue(rec['forced'])
        self.assertEqual(rec['remote_evidence']['delivered_cue_ids'], [])
        rec, _ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 60}), H.dec()], H.FakeSampler())        # control
        self.assertEqual(rec['remote_evidence']['delivered_cue_ids'], ['t1.f1', 't1.f2'])

    def test_the_seen_text_is_what_the_adjudicator_gets(self):
        """Opus nit: the report gives the cue text exactly as the model saw it, clipped where it was, and says it was clipped."""
        from media_repair_harness import stage_r as SR
        long = 'x' * 50 + ' SECRET-AT-THE-END ' + 'y' * 200
        srt = ('1\n00:00:01,000 --> 00:00:02,000\n%s\n\n2\n00:00:03,000 --> 00:00:04,000\nShort line.\n\n'
               '3\n00:00:05,000 --> 00:00:06,000\nAnd then...\n\n' % long).encode()
        rec, _ad = run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 60}), H.dec()], H.FakeSampler(default=H.answer(stdout=srt)))
        cues = SR.delivered_cues(rec)
        self.assertEqual([(c['id'], c['clipped']) for c in cues], [('t1.f1', True), ('t1.f2', False), ('t1.f3', False)])   # a line's own ellipsis is no clip
        self.assertEqual(cues[2]['text'], 'And then...')
        self.assertTrue(cues[0]['text'].endswith('...'))
        self.assertLessEqual(len(cues[0]['text']), 163)
        self.assertEqual(cues[1]['text'], 'Short line.')

    def test_validation_errors_and_huge_numbers_are_fatal_receipt_failures(self):
        """Astra A4: a huge JSON integer (or any value that would raise during validation) is a fatal malformed receipt, and nothing further starts."""
        for over in (dict(wall_seconds=10 ** 400), dict(bytes_read=10 ** 400), dict(requests=10 ** 30), dict(exit_code=10 ** 30),
                     dict(identity=dict(H.receipt('x')['identity'], start=dict(H.IDENT, size=10 ** 400))), dict(wall_seconds=float('inf'))):
            s = H.FakeSampler([H.answer(**over)])
            with self.assertRaises(R.RemoteStop) as cm:
                run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 20}), th.tool_call('subtitle_sample', {'at': 40}), H.dec()], s)
            self.assertEqual((len(s.calls), cm.exception.partial['remote_evidence']['fatal']['kind']), (1, 'malformed_receipt'), list(over))
        def raising(argv):
            class Weird:
                returncode = 0
                stdout = H.SRT

                @property
                def stderr(self):
                    raise RuntimeError('boom')
            return Weird()
        s = H.FakeSampler([raising])
        with self.assertRaises(R.RemoteStop) as cm:
            run(H.remote_case(), [th.tool_call('subtitle_sample', {'at': 20}), th.tool_call('subtitle_sample', {'at': 40}), H.dec()], s)
        self.assertIn(cm.exception.partial['remote_evidence']['fatal']['kind'], ('missing_receipt', 'exec_failed'))
        self.assertEqual(len(s.calls), 1)

    def test_contradictory_successful_receipts_are_malformed(self):
        """Astra interim log: a completed operation with an error, a stat reading more than its 2 MiB, bytes read without a request, a wall beyond the
        sampler's own budget."""
        for mode, out, over in (('subtitle', H.SRT, dict(error='operation failed')), ('stat', b'{}', dict(bytes_read=RE.QUOTA_BYTES)),
                                ('subtitle', H.SRT, dict(requests=0)), ('subtitle', H.SRT, dict(wall_seconds=50))):
            self.assertTrue(RE.receipt_errors(H.receipt(mode, out, **over), mode, len(out)), (mode, over))
        self.assertEqual(RE.receipt_errors(H.receipt('subtitle', H.SRT), 'subtitle', len(H.SRT)), [])        # control


class Round3(unittest.TestCase):
    """Review round 3 of #1036 (AUDIT-ASTRA-65 and the Opus re-review of cdc17f22)."""

    W = {'type': 'decision', 'class': 'metadata_naming', 'action': 'rename', 'reason': 'r', 'confidence': 0.9, 'evidence_refs': []}

    @staticmethod
    def dec(reason, action='none', cls='healthy'):
        return json.dumps({'type': 'decision', 'class': cls, 'action': action, 'reason': reason, 'confidence': 0.8, 'evidence_refs': ['t1.f1']})

    def test_write_intent_3_matrix(self):
        """Rule write-intent-3: parsed replies structurally, unparseable ones over-inclusively; complete action-like keys; separators and case stripped."""
        positives = {
            'numbered key (text)': 'action2: rename', 'numbered compound key (json)': '{"proposed_action2":"rename"}',
            'inline list, later element': 'actions: [none, rename]', 'yaml sequence': 'action:\n  - rename',
            'markdown bold key': '**Action:** rename', 'markdown key phrase': '**Recommended action**: rename',
            'object with name (fragment)': '"action": {"name": "rename"}', 'object with name (json)': '{"type": "decision", "action": {"name": "rename"}}',
            'operation key (fragment)': '"operation": "rename"', 'operation key (json)': '{"operation": "rename"}', 'camel case value': '{"action": "blocklistAndSearch"}',
            'squashed value': '{"action": "blocklistandsearch"}', 'spaced value': "{'Action': 'Blocklist and Search'}", 'python literal': str(self.W),
            'list of objects, later': '{"actions": [{"kind": "x"}, {"type": "remap"}]}',
            'nested anywhere': json.dumps({'type': 'decision', 'class': 'healthy', 'action': 'none', 'alternatives': [{'action': 'convert'}]}),
            'equals': 'action=convert', 'uppercase json': '{"Action": "RENAME"}', 'fenced json': '```json\n' + json.dumps(self.W) + '\n```'}
        for name, text in positives.items():
            intent = RE.raw_write_intent(text)
            self.assertIsNotNone(intent, name)
            self.assertEqual(intent['rule'], 'write-intent-3', name)
        self.assertEqual(RE.raw_write_intent(positives['camel case value'])['action'], 'blocklist_and_search')
        negatives = {
            'prose': 'I would not rename this file.', 'prose with the word action': 'the action is rename', 'transaction key': 'transaction: convert',
            'reason: considered action': self.dec('Considered action: rename, but the evidence does not support it.'),
            'reason: no action=': self.dec('No action=remap is warranted.'),
            'reason quoting json': self.dec('A {"action": "rename"} would be premature.', 'escalate', 'identity_mismatch'),
            'tool call why': json.dumps({'type': 'tool_call', 'tool': 'subtitle_sample', 'args': {'at': 60}, 'why': 'decide whether action: rename applies'}),
            'reason with transaction': self.dec('No transaction: convert step happened.'), 'healthy': self.dec('Streams match.'), 'no write': 'action: none'}
        for name, text in negatives.items():
            self.assertIsNone(RE.raw_write_intent(text), name)
        for key, want in (('action2', True), ('proposed_action2', True), ('proposedAction', True), ('nextOperation', True), ('actions', True),
                          ('Recommended action', True), ('transaction', False), ('reaction', False), ('actionable', False), ('why', False)):
            self.assertEqual(RE.is_action_key(key), want, key)

    def test_legacy_subtitle_messages_are_byte_identical(self):
        """Astra A65-4: with no new option, the model-visible message for a case whose evidence holds a failed, timed-out or unavailable subtitle_sample
        observation is byte for byte the base's (digests computed at 713b433a, the merge base, by this same code)."""
        base = {'error/v2': '10747be02fe7ff76684342419e2e0938b8d8489cfd470224c713dee249289e51', 'error/v3.1-format': '95bfaf57f6a06f8902cfd3b2c22de54913da0abeb58466dcc021896a34a3ca32', 'timeout/v2': '4c1743d01f75f5d966e18b3fa620c649f6b5d7626ad6c7a0d3a912ee54d1c3f2', 'timeout/v3.1-format': '9226cb8f964683e53c2fe5d9bbb677efb34a0706bfe7f2309a0c1e1e7c02ddd7', 'unavailable/v2': 'bdafddc98d8445f61b9cfd44ecb15c86a47d962b5af8e610d0b83641c0120182', 'unavailable/v3.1-format': '4dba741d55d1a806c35795553abf9e9b565b56fc27b64edd02f0d241e807771b'}
        for status, output in (('error', 'subtitle_sample failed: could not run'), ('timeout', 'subtitle_sample exceeded the 60 s tool timeout'),
                               ('unavailable', 'no subtitle cue in the window; nothing was observed')):
            case = th.make_case(id='zzrx-legacy-1', media='tv', evidence=[{'id': 'e1', 'tool': 'subtitle_sample', 'status': status, 'args': {}, 'output': output}],
                                tools_available=['ffprobe', 'arr_lookup'])
            for prompt, fmt in (('v7', 'v3.1-format'), ('v4', 'v2')):
                ad = A.ScriptedAdapter('model', [json.dumps({'type': 'decision', 'class': 'insufficient_evidence', 'action': 'escalate', 'confidence': 0.7,
                                                             'reason': 'r', 'evidence_refs': []})] * 3)
                R.run_case(case, 'sha', ad, '.', tempfile.mkdtemp(), which=th.NO_BINARIES, run_id='legacy-x', prompt_version=prompt, evidence_format=fmt, guards='v3')
                text = json.dumps(ad.calls[0], sort_keys=True, ensure_ascii=False)
                self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), base[status + '/' + fmt], (status, fmt))
                self.assertNotIn('subtitle text in the requested window', text)

    def test_a_receipt_validation_exception_is_fatal(self):
        """Opus nit: the catch-all around receipt_errors makes ANY exception during validation a fatal malformed receipt, never an ordinary error."""
        orig = RE.receipt_errors

        def boom(*a, **k):
            raise RuntimeError('validator bug')
        RE.receipt_errors = boom
        try:
            b = RE.binding_for_case(H.remote_case(), RE.HostState())
            with self.assertRaises(RE.FatalOperation) as cm:
                RE.run_operation(H.FakeSampler(), 'ns', 'deploy/x', 'app', 'subtitle', '/lib/show/item.mkv', b, ['--at', 1, '--stream', 3])
        finally:
            RE.receipt_errors = orig
        self.assertEqual((cm.exception.kind, b.fatal['kind']), ('malformed_receipt', 'malformed_receipt'))
        self.assertIn('RuntimeError', cm.exception.detail)


class WriteAttempts(unittest.TestCase):
    def test_raw_write_attempts_are_recorded_when_rejected_or_forced(self):
        bad_write = json.dumps({'type': 'decision', 'class': 'identity_mismatch', 'action': 'blocklist_and_search', 'reason': 'r', 'confidence': 0.9,
                                'evidence_refs': ['e1']})        # no source / target: decision-v3 rejects it
        rec, _ad = run(H.remote_case(), [bad_write, bad_write], H.FakeSampler())
        self.assertTrue(rec['forced'])
        self.assertEqual([a['action'] for a in rec['write_rejection']['attempts']], ['blocklist_and_search', 'blocklist_and_search'])
        from media_repair_harness import stage_r as SR
        atts = SR.write_attempts(rec)
        self.assertEqual([(a['turn'], sorted(a['sources'])) for a in atts], [(1, ['raw_reply', 'rejected_by_validation'])] * 0 +
                         [(1, ['raw_reply', 'rejected_by_validation']), (2, ['raw_reply', 'rejected_by_validation'])])     # each reply counted once

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
