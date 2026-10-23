"""#160: synthetic-only quota contract tests for the separate mrh-sampler-3 path."""
import json
import os
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

    def operation_argv(self, path=None):
        path = path or self.file
        want = identity(path)
        return (['kubectl', '-n', 'ns', 'exec', '-i', 'deploy/x', '-c', 'app', '--', 'python3', '-', 'subtitle', str(path), '--at', '1', '--stream', '3',
                 '--root', str(self.root)] +
                [str(v) for key in ('size', 'mtime_ns', 'dev', 'ino') for v in ('--expect-' + key.replace('_', '-'), want[key])])

    def test_default_is_8m_and_explicit_16m_is_recorded_and_trusted(self):
        _done, legacy = self.invoke_sampler()
        self.assertEqual(legacy['input_quota_bytes'], Q.DEFAULT_INPUT_QUOTA_BYTES)
        self.assertEqual(Q.receipt_errors(legacy, 'subtitle', legacy['stdout_bytes']), [])
        _done, opted = self.invoke_sampler(options=Q.sampler_options(Q.MAX_INPUT_QUOTA_BYTES))
        self.assertEqual(opted['input_quota_bytes'], Q.MAX_INPUT_QUOTA_BYTES)
        self.assertEqual(Q.receipt_errors(opted, 'subtitle', opted['stdout_bytes'], Q.MAX_INPUT_QUOTA_BYTES), [])
        self.assertTrue(Q.receipt_errors(opted, 'subtitle', opted['stdout_bytes'], Q.DEFAULT_INPUT_QUOTA_BYTES))
        receipt, _out = Q.run_operation(self.pod, self.operation_argv(), 'subtitle', Q.MAX_INPUT_QUOTA_BYTES)
        self.assertEqual(receipt['input_quota_bytes'], Q.MAX_INPUT_QUOTA_BYTES)

    def test_invalid_quota_values_refuse_before_the_source_is_read(self):
        for value in ('not-an-int', 0, Q.MAX_INPUT_QUOTA_BYTES + 1, 12 * 1024 * 1024):
            _done, receipt = self.invoke_sampler(options=('--input-quota-bytes', value))
            self.assertEqual((receipt['exit_code'], receipt['bytes_read']), ('error', 0), value)
            self.assertTrue(receipt['error'].startswith('bad arguments:'), value)
        for value in (None, True, 12 * 1024 * 1024):
            with self.assertRaises(Q.InputQuotaError):
                Q.expected_input_quota_bytes(value)
        calls = len(self.pod.calls)
        with self.assertRaises(Q.InputQuotaError):
            Q.run_operation(self.pod, self.operation_argv(), 'subtitle', 12 * 1024 * 1024)
        self.assertEqual(len(self.pod.calls), calls)       # caller configuration is refused before any exec/source read

    def test_start_identity_mismatch_reads_no_bytes(self):
        wrong = dict(identity(self.file), size=self.file.stat().st_size + 1)
        _done, receipt = self.invoke_sampler(expected=wrong)
        self.assertEqual((receipt['identity']['start_ok'], receipt['bytes_read']), (False, 0))

    def test_shared_aggregate_cap_covers_overlapping_concurrent_ranges(self):
        """Concurrent HTTP requests share one counter; neither request gets its own cap."""
        big = H.media_file(self.root / 'show' / 'large.mkv', size=Q.MAX_INPUT_QUOTA_BYTES + 4096)
        program = '''#!%s
import sys, threading, urllib.request
url = sys.argv[sys.argv.index('-i') + 1]
def read(r):
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers={'Range': r}), timeout=10).read()
    except Exception:
        pass
threads = [threading.Thread(target=read, args=(r,)) for r in ('bytes=0-12582911', 'bytes=4194304-16777215')]
[t.start() for t in threads]
[t.join() for t in threads]
''' % sys.executable
        (self.pod.bin / 'ffmpeg').write_text(program)
        (self.pod.bin / 'ffmpeg').chmod(0o755)
        _done, receipt = self.invoke_sampler(path=big, options=Q.sampler_options(Q.MAX_INPUT_QUOTA_BYTES))
        self.assertEqual((receipt['bytes_read'], receipt['input_quota_bytes'], receipt['quota_exhausted']),
                         (Q.MAX_INPUT_QUOTA_BYTES, Q.MAX_INPUT_QUOTA_BYTES, True))
        self.assertGreaterEqual(receipt['requests'], 2)

    def test_forged_receipt_cannot_authorize_a_larger_budget(self):
        _done, receipt = self.invoke_sampler(options=Q.sampler_options(Q.MAX_INPUT_QUOTA_BYTES))
        self.assertEqual(Q.receipt_errors(receipt, 'subtitle', receipt['stdout_bytes'], Q.MAX_INPUT_QUOTA_BYTES), [])
        receipt['input_quota_bytes'] = Q.MAX_INPUT_QUOTA_BYTES
        self.assertIn('trusted expected quota', Q.receipt_errors(receipt, 'subtitle', receipt['stdout_bytes'], Q.DEFAULT_INPUT_QUOTA_BYTES)[0])


if __name__ == '__main__':
    unittest.main()
