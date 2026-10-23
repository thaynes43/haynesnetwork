"""#160: synthetic-only tests for the separate, trusted mrh-sampler-3 path."""
import copy
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import rem_h as H
from media_repair_harness import remote_evidence_quota as Q


def identity(path):
    st = os.stat(path)
    return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino}


class SamplerQuota(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.file = H.media_file(self.root / 'show' / 'item.mkv')
        self.pod = H.LocalPod()

    def binding(self, path=None):
        return {'expected_identity': identity(path or self.file), 'expected_hostname': socket.gethostname(), 'allowed_root': str(self.root)}

    def invoke_sampler(self, path=None, options=(), pod=None, expected=None):
        path, pod = path or self.file, pod or self.pod
        want = identity(path) if expected is None else expected
        argv = ['subtitle', str(path), '--at', '1', '--stream', '3', '--root', str(self.root)]
        if want is not None:
            argv += [str(v) for key in ('size', 'mtime_ns', 'dev', 'ino') for v in ('--expect-' + key.replace('_', '-'), want[key])]
        argv += [str(x) for x in options]
        env = dict(os.environ, PATH=str(pod.bin) + os.pathsep + os.environ.get('PATH', ''))
        done = subprocess.run([sys.executable, '-'] + argv, input=Q.SAMPLER.read_bytes(), capture_output=True, timeout=30, env=env)
        lines = [line for line in done.stderr.decode().splitlines() if line.strip()]
        return done, json.loads(lines[-1])

    def operation_argv(self, path=None, mode='subtitle'):
        path = path or self.file
        argv = ['kubectl', '-n', 'ns', 'exec', '-i', 'deploy/x', '-c', 'app', '--', 'python3', '-', mode, str(path)]
        return argv if mode == 'stat' else argv + ['--at', '1', '--stream', '3']

    def errors(self, receipt, quota=Q.DEFAULT_INPUT_QUOTA_BYTES, path=None):
        return Q.receipt_errors(receipt, 'subtitle', receipt['stdout_bytes'], quota, **self.binding(path))

    def test_valid_default_and_opt_in_16m_are_fully_bound(self):
        _done, default = self.invoke_sampler()
        self.assertEqual(default['input_quota_bytes'], Q.DEFAULT_INPUT_QUOTA_BYTES)
        self.assertEqual(self.errors(default), [])
        _done, opted = self.invoke_sampler(options=('--input-quota-bytes', Q.MAX_INPUT_QUOTA_BYTES))
        self.assertEqual(opted['input_quota_bytes'], Q.MAX_INPUT_QUOTA_BYTES)
        self.assertEqual(self.errors(opted, Q.MAX_INPUT_QUOTA_BYTES), [])
        self.assertTrue(self.errors(opted))
        receipt, _out = Q.run_operation(self.pod, self.operation_argv(), 'subtitle', Q.MAX_INPUT_QUOTA_BYTES, **self.binding())
        self.assertEqual(receipt['input_quota_bytes'], Q.MAX_INPUT_QUOTA_BYTES)

    def test_invalid_quota_and_parser_forms_refuse_before_source_open_or_runner(self):
        for value in ('not-an-int', 0, Q.MAX_INPUT_QUOTA_BYTES + 1, 12 * 1024 * 1024):
            _done, receipt = self.invoke_sampler(options=('--input-quota-bytes', value))
            self.assertEqual((receipt['exit_code'], receipt['bytes_read']), ('error', 0), value)
            self.assertIsNone(receipt['identity']['start'], value)
            self.assertIsNone(receipt['confined'], value)
        for options in (('--input', Q.DEFAULT_INPUT_QUOTA_BYTES), ('--', '--input-quota-bytes', Q.DEFAULT_INPUT_QUOTA_BYTES)):
            _done, receipt = self.invoke_sampler(options=options)
            self.assertEqual((receipt['exit_code'], receipt['bytes_read']), ('error', 0), options)
        calls = len(self.pod.calls)
        for argv in (self.operation_argv() + ['--input-quota-bytes'], self.operation_argv() + ['--input-quota-bytes=8388608'],
                     self.operation_argv() + ['--input'], self.operation_argv() + ['--']):
            with self.assertRaises(Q.InputQuotaError):
                Q.run_operation(self.pod, argv, 'subtitle', **self.binding())
        self.assertEqual(len(self.pod.calls), calls)

    def test_missing_or_invalid_binding_refuses_before_runner(self):
        calls = len(self.pod.calls)
        valid = self.binding()
        bad_bindings = ({}, {'expected_identity': dict(valid['expected_identity'], size=True),
                             'expected_hostname': socket.gethostname(), 'allowed_root': str(self.root)},
                        {'expected_identity': valid['expected_identity'], 'expected_hostname': 'bad host!', 'allowed_root': str(self.root)},
                        {'expected_identity': valid['expected_identity'], 'expected_hostname': socket.gethostname(), 'allowed_root': 'relative'},
                        {'expected_identity': valid['expected_identity'], 'expected_hostname': socket.gethostname(), 'allowed_root': str(self.root) + '\n'},
                        {'expected_identity': valid['expected_identity'], 'expected_hostname': socket.gethostname(), 'allowed_root': str(self.root) + '\0'})
        for binding in bad_bindings:
            with self.assertRaises(Q.InputQuotaError):
                Q.run_operation(self.pod, self.operation_argv(), 'subtitle', **binding)
        self.assertEqual(len(self.pod.calls), calls)

    def test_adapter_accepts_only_a_genuine_stat_null_argv_receipt(self):
        receipt, stdout = Q.run_operation(self.pod, self.operation_argv(mode='stat'), 'stat', **self.binding())
        self.assertIsNone(receipt['argv'])
        self.assertTrue(stdout)
        self.assertEqual(Q.receipt_errors(receipt, 'stat', len(stdout), **self.binding()), [])
        malformed = copy.deepcopy(receipt)
        malformed['argv'] = []
        self.assertIn('argv must be null for stat', Q.receipt_errors(malformed, 'stat', len(stdout), **self.binding()))

    def test_identity_mismatch_reads_zero_and_adapter_refuses(self):
        mismatch = dict(identity(self.file), size=identity(self.file)['size'] + 1)
        done, receipt = self.invoke_sampler(expected=mismatch)
        self.assertEqual(done.returncode, 0)
        self.assertEqual(receipt['bytes_read'], 0)
        self.assertIs(receipt['identity']['start_ok'], False)
        with self.assertRaisesRegex(Q.SamplerOperationError, 'terminal exit_code must be 0'):
            Q.run_operation(self.pod, self.operation_argv(), 'subtitle', expected_identity=mismatch,
                            expected_hostname=socket.gethostname(), allowed_root=str(self.root))

    def test_receipt_rejects_forgery_identity_terminal_and_malformed_forms(self):
        _done, receipt = self.invoke_sampler()
        forged = copy.deepcopy(receipt)
        forged['input_quota_bytes'] = Q.MAX_INPUT_QUOTA_BYTES
        self.assertTrue(self.errors(forged))
        oversized = copy.deepcopy(receipt)
        oversized['bytes_read'] = Q.DEFAULT_INPUT_QUOTA_BYTES + 1
        self.assertTrue(self.errors(oversized))
        mutations = (
            ('receipt', 'mrh-sampler-2'), ('mode', 'frame'), ('hostname', 'other-host'), ('exit_code', 'error'), ('exit_code', 1), ('error', 'failed'),
            ('timed_out', True), ('quota_exhausted', True), ('source_unchanged', False), ('confined', False),
            ('wall_seconds', float('inf')), ('bytes_read', True), ('requests', True), ('stdout_bytes', True), ('argv', ['ok', 1]),
        )
        for key, value in mutations:
            changed = copy.deepcopy(receipt)
            changed[key] = value
            self.assertTrue(self.errors(changed), key)
        for key in ('start_ok', 'end_ok', 'same_file'):
            changed = copy.deepcopy(receipt)
            changed['identity'][key] = False
            self.assertTrue(self.errors(changed), key)
        for key in ('expected', 'start', 'end'):
            changed = copy.deepcopy(receipt)
            changed['identity'][key] = dict(changed['identity'][key], size=changed['identity'][key]['size'] + 1)
            self.assertTrue(self.errors(changed), key)
        missing = copy.deepcopy(receipt)
        del missing['identity']
        self.assertTrue(self.errors(missing))
        self.assertTrue(Q.receipt_errors('not-a-receipt', 'subtitle', 0, **self.binding()))

    def test_runner_refuses_failure_with_a_real_receipt_line_and_stdout(self):
        done, receipt = self.invoke_sampler()

        def runner(changed):
            def invoke(*_args, **_kwargs):
                return subprocess.CompletedProcess([], 0, done.stdout, b'ffmpeg noise\n' + json.dumps(changed).encode() + b'\n')
            return invoke

        accepted, stdout = Q.run_operation(runner(receipt), self.operation_argv(), 'subtitle', **self.binding())
        self.assertEqual((accepted, stdout), (receipt, done.stdout))
        mutations = (
            (lambda r: r.update(exit_code='timeout', timed_out=True), 'terminal exit_code must be 0'),
            (lambda r: r.update(exit_code=1), 'terminal exit_code must be 0'),
            (lambda r: r.update(error='broken'), 'successful terminal receipt must not carry an error'),
            (lambda r: r['identity'].update(start_ok=False), 'identity.start_ok must be true'),
            (lambda r: r.update(confined=False), 'confined must be true'),
        )
        for mutation, message in mutations:
            changed = copy.deepcopy(receipt)
            mutation(changed)
            with self.assertRaisesRegex(Q.SamplerOperationError, message):
                Q.run_operation(runner(changed), self.operation_argv(), 'subtitle', **self.binding())
        def non_json(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 0, done.stdout, b'not json\n')
        with self.assertRaises(Q.SamplerOperationError):
            Q.run_operation(non_json, self.operation_argv(), 'subtitle', **self.binding())

    def test_adapter_invalid_quota_refuses_before_runner(self):
        calls = []

        def runner(*_args, **_kwargs):
            calls.append(True)
            raise AssertionError('the runner must not be called')

        for quota in (Q.MAX_INPUT_QUOTA_BYTES + 1, True, float(Q.DEFAULT_INPUT_QUOTA_BYTES), 12 * 1024 * 1024):
            with self.assertRaises(Q.InputQuotaError):
                Q.run_operation(runner, self.operation_argv(), 'subtitle', quota, **self.binding())
        self.assertEqual(calls, [])

    def test_identity_integer_bounds_are_exact(self):
        _done, receipt = self.invoke_sampler()
        boundary = {'size': Q.I64 - 1, 'mtime_ns': -Q.I64, 'dev': 2 * Q.I64 - 1, 'ino': 2 * Q.I64 - 1}
        bounded = copy.deepcopy(receipt)
        for name in ('expected', 'start', 'end'):
            bounded['identity'][name] = boundary
        self.assertEqual(Q.receipt_errors(bounded, 'subtitle', bounded['stdout_bytes'], expected_identity=boundary,
                                          expected_hostname=socket.gethostname(), allowed_root=str(self.root)), [])
        for field, value in (('size', Q.I64), ('mtime_ns', Q.I64), ('dev', 2 * Q.I64), ('ino', 2 * Q.I64)):
            invalid = copy.deepcopy(bounded)
            for name in ('expected', 'start', 'end'):
                invalid['identity'][name] = dict(boundary, **{field: value})
            expected = dict(boundary, **{field: value})
            self.assertTrue(Q.receipt_errors(invalid, 'subtitle', invalid['stdout_bytes'], expected_identity=expected,
                                             expected_hostname=socket.gethostname(), allowed_root=str(self.root)), field)

    def test_shared_aggregate_cap_covers_default_repeated_and_opted_overlapping_ranges(self):
        big = H.media_file(self.root / 'show' / 'large.mkv', size=Q.MAX_INPUT_QUOTA_BYTES + 4096)
        repeated = '''#!%s
import sys, urllib.request
url = sys.argv[sys.argv.index('-i') + 1]
for _ in range(10):
    try: urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-1048575'}), timeout=10).read()
    except Exception: pass
''' % sys.executable
        (self.pod.bin / 'ffmpeg').write_text(repeated)
        (self.pod.bin / 'ffmpeg').chmod(0o755)
        _done, default = self.invoke_sampler(path=big)
        self.assertEqual((default['bytes_read'], default['quota_exhausted']), (Q.DEFAULT_INPUT_QUOTA_BYTES, True))
        self.assertGreaterEqual(default['requests'], 2)
        overlapping = '''#!%s
import sys, threading, urllib.request
url = sys.argv[sys.argv.index('-i') + 1]
def read(r):
    try: urllib.request.urlopen(urllib.request.Request(url, headers={'Range': r}), timeout=10).read()
    except Exception: pass
threads = [threading.Thread(target=read, args=(r,)) for r in ('bytes=0-12582911', 'bytes=4194304-16777215')]
[t.start() for t in threads]
[t.join() for t in threads]
''' % sys.executable
        (self.pod.bin / 'ffmpeg').write_text(overlapping)
        _done, opted = self.invoke_sampler(path=big, options=('--input-quota-bytes', Q.MAX_INPUT_QUOTA_BYTES))
        self.assertEqual((opted['bytes_read'], opted['input_quota_bytes'], opted['quota_exhausted']),
                         (Q.MAX_INPUT_QUOTA_BYTES, Q.MAX_INPUT_QUOTA_BYTES, True))
        self.assertGreaterEqual(opted['requests'], 2)


if __name__ == '__main__':
    unittest.main()
