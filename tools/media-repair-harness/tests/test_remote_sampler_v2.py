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
    return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns}


class RealSampler(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.file = H.media_file(self.root / 'show' / 'item.mkv')
        self.pod = H.LocalPod()

    def test_stat_fingerprint_and_receipt(self):
        b = RE.Binding(host=RE.HostState())
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
        b = RE.Binding(identity=ident(self.file), host=RE.HostState())
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
        b = RE.Binding(identity=ident(self.file), host=RE.HostState())
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
        b = RE.Binding(host=RE.HostState())
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
        b = RE.Binding(host=RE.HostState())
        receipt, out = op(self.pod, 'stat', self.root / 'nope.mkv', b, bind=False)
        self.assertEqual((receipt['exit_code'], out), ('error', b''))
        self.assertIn('FileNotFoundError', receipt['error'])

    def test_bad_arguments_still_end_with_a_receipt(self):
        b = RE.Binding(host=RE.HostState())
        receipt, out = op(self.pod, 'subtitle', self.file, b, ['--window', 50], bind=False)
        self.assertEqual((receipt['exit_code'], receipt['error']), ('error', 'bad arguments'))


if __name__ == '__main__':
    unittest.main()
