"""#161: the REAL mrh-sampler-2 (remote_sampler_v2.py), run locally on synthetic files (fake ffprobe / ffmpeg that read the sampler's own range server).
Every result goes through remote_evidence.run_operation, the same receipt rules the harness and the driver apply.  No cluster, no media, no network."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

import rem_h as H
from media_repair_harness import remote_evidence as RE


def op(pod, mode, path, binding, opts=(), bind=True):
    return RE.run_operation(pod, 'ns', 'deploy/x', 'app', mode, str(path), binding, opts, bind_identity=bind)


def ident(p):
    st = os.stat(p)
    return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'dev': st.st_dev, 'ino': st.st_ino}


class RealSampler(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.file = H.media_file(self.root / 'show' / 'item.mkv')
        self.pod = H.LocalPod()

    def test_stat_fingerprint_and_receipt(self):
        b = RE.Binding(host=RE.HostState(), root=str(self.root))
        receipt, out = op(self.pod, 'stat', self.file, b, bind=False)
        fp = json.loads(out)
        data = self.file.read_bytes()
        self.assertEqual(fp['size'], len(data))
        self.assertEqual(fp['head_1m_sha256'], hashlib.sha256(data[:1 << 20]).hexdigest())
        self.assertEqual(fp['tail_1m_sha256'], hashlib.sha256(data[-(1 << 20):]).hexdigest())
        self.assertEqual((receipt['exit_code'], receipt['source_unchanged'], receipt['bytes_read']), (0, True, 2 * len(data)))
        self.assertEqual(receipt['hostname'], H.hostname())
        self.assertEqual(b.host.hostname, H.hostname())

    def test_bound_operations_check_identity_at_start_and_end(self):
        b = RE.Binding(identity=ident(self.file), host=RE.HostState(), root=str(self.root))
        receipt, _out = op(self.pod, 'stat', self.file, b)
        self.assertTrue(receipt['identity']['start_ok'] and receipt['identity']['end_ok'])
        receipt, out = op(self.pod, 'subtitle', self.file, b, ['--at', 30, '--stream', 3, '--window', 8])
        self.assertEqual(out, H.SRT)
        self.assertIn('-t', receipt['argv'])
        self.assertEqual(receipt['argv'][receipt['argv'].index('-t') + 1], '8')
        self.assertGreater(receipt['bytes_read'], 0)
        receipt, out = op(self.pod, 'probe', self.file, b, ['--at', 0, '--stream', 0])
        self.assertEqual(json.loads(out)['streams'][3]['codec_name'], 'subrip')

    def test_changed_file_fails_closed_without_reading(self):
        b = RE.Binding(identity=ident(self.file), host=RE.HostState(), root=str(self.root))
        self.file.write_bytes(self.file.read_bytes() + b'x')
        with self.assertRaises(RE.FatalOperation) as cm:
            op(self.pod, 'subtitle', self.file, b, ['--at', 30, '--stream', 3])
        self.assertEqual(cm.exception.kind, 'identity_mismatch')
        r = cm.exception.receipt
        self.assertEqual((r['identity']['start_ok'], r['bytes_read'], r['argv']), (False, 0, None))
        n = len(self.pod.calls)
        with self.assertRaises(RE.FatalOperation) as cm:
            op(self.pod, 'stat', self.file, b)
        self.assertEqual(cm.exception.kind, 'stopped')
        self.assertEqual(len(self.pod.calls), n)          # nothing further is invoked

    def test_list_scans_the_whole_directory_and_caps_only_matching_entries(self):
        d = self.root / 'lib'
        d.mkdir()
        for i in range(520):
            (d / ('other-%03d' % i)).write_bytes(b'')
        for i in range(3):
            (d / ('Wanted %d' % i)).mkdir()
        b = RE.Binding(host=RE.HostState(), root=str(self.root))
        receipt, out = op(self.pod, 'list', d, b, ['--prefix', 'Wanted'], bind=False)
        data = json.loads(out)
        self.assertTrue(data['complete'])
        self.assertEqual((data['matching'], data['scanned']), (3, 523))
        self.assertEqual([e['type'] for e in data['entries']], ['dir'] * 3)
        self.assertEqual(receipt['bytes_read'], 0)
        receipt, out = op(self.pod, 'list', d, b, [], bind=False)      # 523 entries match an empty prefix: the cap applies
        data = json.loads(out)
        self.assertFalse(data['complete'])
        self.assertFalse(receipt['listing']['complete'])
        self.assertEqual(len(data['entries']), RE.LIST_CAP)

    def test_missing_path_has_a_receipt_and_no_output(self):
        b = RE.Binding(host=RE.HostState(), root=str(self.root))
        receipt, out = op(self.pod, 'stat', self.root / 'nope.mkv', b, bind=False)
        self.assertEqual((receipt['exit_code'], out), ('error', b''))
        self.assertIn('FileNotFoundError', receipt['error'])

    def test_the_limit_covers_the_whole_invocation(self):
        """A slow operation is stopped by the sampler itself, inside one budget shared by the start stat, the operation and the end stat, and still ends with a
        receipt whose end identity was checked (run with the budget lowered to 3 s so the test stays short)."""
        import subprocess
        import sys
        import time
        slow = H.media_file(self.root / 'slow.mkv', sleep=30)
        text = RE.SAMPLER.read_text().replace('LIMIT_S = 25 ', 'LIMIT_S = 3 ', 1)
        self.assertIn('LIMIT_S = 3 ', text)
        env = dict(os.environ, PATH=str(self.pod.bin) + os.pathsep + os.environ.get('PATH', ''))
        t0 = time.monotonic()
        i = ident(slow)
        done = subprocess.run([sys.executable, '-', 'subtitle', str(slow), '--stream', '3', '--root', str(self.root)] +
                              [str(x) for k in ('size', 'mtime_ns', 'dev', 'ino') for x in ('--expect-' + k.replace('_', '-'), i[k])],
                              input=text.encode(), capture_output=True, timeout=20, env=env)
        wall = time.monotonic() - t0
        receipt, problem = RE.parse_receipt(done.stderr)
        self.assertIsNone(problem)
        self.assertEqual(RE.receipt_errors(receipt, 'subtitle', len(done.stdout)), [])
        self.assertEqual((receipt['exit_code'], receipt['timed_out']), ('timeout', True))
        self.assertTrue(receipt['identity']['end_ok'])
        self.assertLess(receipt['wall_seconds'], 3.5)
        self.assertLess(wall, 10)

    def test_a_path_replaced_during_the_operation_is_not_the_same_file(self):
        """Round 1: identity is bound to the opened file, not the path.  The path is replaced by another file of the same size and mtime while the
        operation runs: the receipt says same_file false, and the bound operation fails closed."""
        import shutil
        import threading
        slow = H.media_file(self.root / 'swap.mkv', sleep=1.5)
        twin = self.root / 'twin.mkv'
        shutil.copy2(slow, twin)
        orig = ident(slow)
        b = RE.Binding(identity=orig, host=RE.HostState(), root=str(self.root))
        timer = threading.Timer(0.6, lambda: os.replace(twin, slow))
        timer.start()
        try:
            with self.assertRaises(RE.FatalOperation) as cm:
                op(self.pod, 'subtitle', slow, b, ['--at', 1, '--stream', 3])
        finally:
            timer.join()
        r = cm.exception.receipt
        self.assertEqual((r['identity']['same_file'], r['source_unchanged'], r['identity']['end']), (False, False, orig))     # the opened file itself is unchanged
        self.assertNotEqual(ident(slow)['ino'], orig['ino'])
        self.assertEqual(cm.exception.kind, 'identity_mismatch')

    def test_ffmpeg_reads_only_the_loopback_server(self):
        b = RE.Binding(identity=ident(self.file), host=RE.HostState(), root=str(self.root))
        receipt, _out = op(self.pod, 'subtitle', self.file, b, ['--at', 1, '--stream', 3])
        argv = receipt['argv']
        self.assertEqual(argv[argv.index('-protocol_whitelist') + 1], 'http,tcp')
        self.assertLess(argv.index('-protocol_whitelist'), argv.index('-i'))

    def test_paths_must_be_confined_and_symlink_free(self):
        """Astra 3: the source is opened only under the allowed root, never through a symlink (any component) and never by a traversal path."""
        outside = Path(tempfile.mkdtemp()).resolve()
        H.media_file(outside / 'other.mkv')
        (self.root / 'link.mkv').symlink_to(self.file)
        (self.root / 'dirlink').symlink_to(self.file.parent)
        for path in (outside / 'other.mkv', self.root / 'link.mkv', self.root / 'dirlink' / self.file.name, str(self.file.parent) + '/../show/' + self.file.name):
            b = RE.Binding(host=RE.HostState(), root=str(self.root))
            with self.assertRaises(RE.FatalOperation) as cm:
                op(self.pod, 'stat', path, b, bind=False)
            self.assertEqual(cm.exception.kind, 'not_confined', path)
            self.assertEqual(cm.exception.receipt['bytes_read'], 0)
        b = RE.Binding(host=RE.HostState(), root=str(self.root))
        receipt, _out = op(self.pod, 'stat', self.file, b, bind=False)          # control: a confined real path
        self.assertTrue(receipt['confined'])
        self.assertEqual(set(receipt['identity']['start']), {'size', 'mtime_ns', 'dev', 'ino'})

    def test_bad_arguments_still_end_with_a_receipt(self):
        b = RE.Binding(host=RE.HostState(), root=str(self.root))
        receipt, out = op(self.pod, 'subtitle', self.file, b, ['--window', 50], bind=False)
        self.assertEqual((receipt['exit_code'], receipt['error']), ('error', 'bad arguments: out of range'))
        for bad in (['--at', 'soon'], ['--bogus', '1']):           # argparse errors end with a receipt too (round 1)
            receipt, out = op(self.pod, 'subtitle', self.file, b, bad, bind=False)
            self.assertEqual(receipt['exit_code'], 'error')
            self.assertTrue(receipt['error'].startswith('bad arguments: '))


if __name__ == '__main__':
    unittest.main()
