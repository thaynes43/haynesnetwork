"""W27 (OpenProject #145 remainder and the PR #1031 review nits): evidence follow-ups, each under a new opt-in version beside the old one.

One class per item of the work order.  Every test named `*_diag3`, `*_live2` or `*_pages` fails at main 9702fa29 (the version it selects does not exist
there, or exists with the defect), and its paired control pins that the earlier version is unchanged.

  1  #145 (2)   diag-3: the cross-line `error reading header` rule reads every decorated form of the header line, not only the bracketed one
  2  #145 (3)   diag-3: an OSError at stage zip_open (offline EPUB inspector) is an execution failure unless a positive damage diagnostic says otherwise
  3  #145 (4)   live-2: a decode (and audio level) window keeps located damage (after start-up warnings or behind a long decoration) within live-1's budget
  4  #145 (5)   pagination (pages-v1, crash-only): a list that mixes strings and dicts no longer raises AttributeError once a dict element is split
  5  #1031      diag-3: the zip_crc execution check starts at the first ` in member ` separator wherever it is (linear; a 65k input stays under 50 ms)
  6  #1031      live-2: the live EPUB collector resolves manifest hrefs exactly as tools behaviour v4 (colon-named members are local; data:, urn:, mailto: are
                local members, so missing), so live and v4 replay agree
  7  #1031      the tools v4 / diagnostic rules pairing: v4 also pairs with diag-3; why it is not checked again at classification time is documented
                (tools.py), and the mismatch it would catch is pinned as conservative

Review additions (the independent Opus review of 45d6ca9e): EINVAL at zip_open keeps its reading (zipfile raises it on a damaged ZIP64 locator on some
Pythons); a line with several `error reading header` readings is classified the same under every PYTHONHASHSEED under diag-3; live-2 checks every manifest
item with an href, one without an id included, as tools v4 does.

Review round of f399cda0 (the coordinator's Opus review, AUDIT-ASTRA-48): live-2 keeps live-1's 3-line, 163-character window budget, classifies lines whole
before the cut and shows a hidden damage message in an elided form; the live-2 EPUB record cuts reported member names at 200 characters; present
`data:` / `urn:` / `mailto:` members are clean on both paths; only the kinds live-2 changes are stamped.  Each new `*_live2` test fails at f399cda0.
Review round of 8162e028 (AUDIT-ASTRA-52): the window budget is the BYTES live-1's own list takes in a tool result (CJK tails), a recognised reading is shown
behind '[...] ' when no fixed cut keeps it, and the EPUB names are cut and listed within byte budgets, the CRC branch included.  Each new or rewritten
`*_live2` test of that round fails at 8162e028.  Round of ffd9a029 (AUDIT-ASTRA-53): audiobook windows keep the deferred live-2 lines, a manifest
failure's final fields fit one byte budget, CRC evidence quotes the member name, and the omitted count comes from the whole list (each fails at ffd9a029).

Synthetic, generic fixtures only (no dev-suite case content).  No model call, no ffmpeg (fake runners), no network."""
import contextlib
import errno
import hashlib
import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import th
import test_contract_v3_baseline as B
import test_devc7 as D
import test_evidence as TE
import test_w25_bugfixes as W25
from media_repair_harness import audit as AU
from media_repair_harness import evidence as EVC
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import tools as T
from media_repair_harness.evidence import epubtool
from media_repair_harness.evidence.core import RunResult


def rules(version):
    """The diagnostic rules context (diag-3 is unknown at 9702fa29, where entering it raises ValueError: the test then fails on its own)."""
    return EV2.diagnostic_rules(version)


def obs(i, tool, status, out, args=None, backend=None):
    return EV2.make_observation(i, tool, args or {}, status, out if isinstance(out, str) else json.dumps(out), backend, 'tool')


def classes(lines):
    return [c for _l, c in EV2.classify_text(lines)]


# ------------------------------------------------------------------------------------------------------------- item 1
class HeaderLineDecoratedForms(unittest.TestCase):
    PAIRS = (('pipe:0: error reading header', 'pipe:0: Permission denied'),
             ('in#0: error reading header', '[in#0 @ 0x55d5c0a1b2c0] Input/output error'),
             ('movie.mkv: error reading header', 'movie.mkv: Permission denied'),
             ('/media/library/a b/movie.mp4: error reading header', 'Permission denied'),
             ('[mov,mp4,m4a @ 0x1] pipe:0: error reading header', '[mov,mp4,m4a @ 0x1] Operation not permitted'))

    def test_a_decorated_header_line_before_an_execution_error_is_execution_diag3(self):
        with rules('diag-3'):
            for pair in self.PAIRS:
                self.assertEqual(classes(list(pair)), ['execution', 'execution'], pair)
                self.assertEqual(EV2.strongest(EV2.classify_text(list(pair))), 'execution', pair)
            # the typed layer: a live decode window whose only messages are those two lines is no decoder warning
            seg = {'at_s': 0.0, 'window_s': 4, 'decoded_s': 4.0, 'state': 'errors', 'errors': list(self.PAIRS[0])}
            d = EV2.derive(obs('t1', 'decode_sample', 'ok', _live_decode([seg]), backend='live'))
            self.assertNotIn('decoder_warning', [f['kind'] for f in d.findings])
            self.assertEqual([x['class'] for x in d.diagnostics], ['execution', 'execution'])

    def test_several_header_readings_do_not_depend_on_the_hash_seed_diag3(self):
        import os
        import subprocess
        import sys
        code = ('from media_repair_harness import evidence_v2 as E\n'
                'with E.diagnostic_rules("diag-3"):\n'
                '    print(E.classify_line("a.mkv: error reading header: b.mkv: error reading header: Permission denied"))')
        got = set()
        for seed in ('0', '1', '2', '3', '4', '5'):
            env = dict(os.environ, PYTHONHASHSEED=seed, PYTHONPATH=str(Path(EV2.__file__).resolve().parents[1]), PYTHONDONTWRITEBYTECODE='1')      # the src under test
            got.add(subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True, check=True).stdout.strip())
        self.assertEqual(got, {'execution'})

    def test_other_neighbours_decide_nothing_diag3(self):
        with rules('diag-3'):
            self.assertEqual(classes(['pipe:0: error reading header', 'pipe:0: moov atom not found']), ['warning', 'damage'])   # a damage neighbour decides nothing
            self.assertEqual(classes(['pipe:0: error reading header']), ['warning'])                                             # alone: a warning
            self.assertEqual(classes(['pipe:0: error reading header', 'pipe:0: something else']), ['warning', None])
            self.assertEqual(classes(['pipe:0: error reading header: Permission denied']), ['execution'])                       # same-line rule, unchanged
            self.assertEqual(classes(['[mov @ 0x1] error reading header', 'Permission denied']), ['execution', 'execution'])     # bracketed form, as before

    def test_control_earlier_rules_are_unchanged(self):
        for version in ('diag-1', 'diag-2'):
            with rules(version):
                for pair in self.PAIRS[:4]:
                    self.assertEqual(classes(list(pair)), ['warning', 'execution'], (version, pair))        # the defect, kept under the earlier rules
                self.assertEqual(classes(['[mov @ 0x1] error reading header', 'Permission denied']), ['execution', 'execution'], version)   # bracketed form


def _live_decode(segments, duration=20.0):
    return {'tool': 'decode', 'harness_tool': 'decode_sample', 'mode': 'live', 'status': 'ok', 'coverage': {'verified': ['x'], 'not_verified': []},
            'stderr': '', 'output': {'duration_s': duration, 'segments': segments, 'full': None}}


# ------------------------------------------------------------------------------------------------------------- item 2
class OsErrorAtZipOpen(unittest.TestCase):
    ERRORS = ('OSError: [Errno 6] No such device or address', "OSError: [Errno 40] Too many levels of symbolic links: '/media/book.epub'",
              'OSError: [Errno 23] Too many open files in system', 'TimeoutError: [Errno 110] Connection timed out after 30 s', 'OSError: ')

    def derive(self, err, stage='zip_open'):
        return EV2.derive(obs('t1', 'epub_inspect', 'error', {'bytes': 0, 'sha256': 'x', 'status': 'error', 'stage': stage, 'error': err}))

    def test_a_failure_to_open_is_an_execution_failure_diag3(self):
        with rules('diag-3'):
            for err in self.ERRORS:
                self.assertEqual(EV2.epub_failure('zip_open', err), 'execution', err)
                d = self.derive(err)
                self.assertEqual((d.execution['cause'], d.integrity, d.package['zip_open']), ('tool', 'unknown', 'unknown'), err)
                self.assertEqual([(f['kind'], f['known_defect']) for f in d.findings], [('package_error_unclassified', False)], err)
                self.assertEqual(AU.typed_error_support([obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'zip_open', 'error': err})]), {'t1': False})

    def test_the_offline_inspector_end_to_end_diag3(self):
        with tempfile.TemporaryDirectory(prefix='mrh-w27-') as tmp:
            book = Path(tmp) / 'book.epub'
            book.write_bytes(b'PK')
            with mock.patch('zipfile.ZipFile', side_effect=OSError(errno.ENXIO, 'No such device or address')):
                staged = T._epub_stage(str(book), remote_ok=True)
            self.assertEqual(staged, ('zip_open', 'OSError: [Errno 6] No such device or address'))
            with rules('diag-3'):
                self.assertEqual(self.derive(staged[1]).execution['cause'], 'tool')

    def test_damage_other_types_and_other_stages_keep_their_reading_diag3(self):
        with rules('diag-3'):
            self.assertEqual(EV2.epub_failure('zip_open', 'BadZipFile: File is not a zip file'), 'damage')
            self.assertEqual(EV2.epub_failure('zip_open', 'OSError: File is not a zip file'), 'damage')        # a positive damage diagnostic says otherwise
            for err in ("KeyError: 'x'", 'EOFError: ', 'NotImplementedError: That compression method is not supported'):
                self.assertIsNone(EV2.epub_failure('zip_open', err), err)                                       # not an OSError: reading unchanged
            self.assertIsNone(EV2.epub_failure('zip_crc', 'OSError: [Errno 22] Invalid argument'))               # another stage: reading unchanged
            self.assertEqual(EV2.epub_failure('zip_open', 'PermissionError: [Errno 13] Permission denied'), 'execution')
            self.assertIsNone(EV2.epub_failure('zip_open', 'OSError: [Errno 22] Invalid argument'))           # EINVAL: zipfile's seek on a damaged archive

    def test_a_damaged_zip64_locator_is_never_an_execution_failure_diag3(self):
        """A 42-byte archive whose ZIP64 end-of-central-directory locator points before the start of the file: depending on the Python, zipfile says
        `BadZipFile: Corrupt zip64 end of central directory locator` (damage) or its seek raises `OSError: [Errno 22] Invalid argument` (left unclassified)."""
        import struct
        with tempfile.TemporaryDirectory(prefix='mrh-w27-') as tmp:
            book = Path(tmp) / 'book.epub'
            book.write_bytes(struct.pack('<4sLQL', b'PK\x06\x07', 0, 0, 1) + struct.pack('<4s4H2LH', b'PK\x05\x06', 0, 0, 0, 0, 0, 0, 0))
            stage, text = T._epub_stage(str(book), remote_ok=True)
            # this pod's Python words it as BadZipFile (damage), so the line above does not exercise EINVAL here; the Python that seeks raises the OSError below
            with mock.patch('zipfile.ZipFile', side_effect=OSError(errno.EINVAL, 'Invalid argument')):
                einval = T._epub_stage(str(book), remote_ok=True)
        self.assertEqual((stage, einval), ('zip_open', ('zip_open', 'OSError: [Errno 22] Invalid argument')))
        with rules('diag-3'):
            self.assertIn(EV2.epub_failure(stage, text), ('damage', None), text)
            self.assertIsNone(EV2.epub_failure(*einval))                               # either wording: never an execution failure
            d = EV2.derive(obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'zip_open', 'error': einval[1]}))
            self.assertEqual((d.execution['cause'], d.integrity), ('unknown', 'unknown'))

    def test_control_earlier_rules_are_unchanged(self):
        for version in ('diag-1', 'diag-2'):
            with rules(version):
                for err in self.ERRORS:
                    self.assertIsNone(EV2.epub_failure('zip_open', err), (version, err))
                    self.assertEqual(self.derive(err).execution['cause'], 'unknown', (version, err))


# ------------------------------------------------------------------------------------------------------------- item 3
WARN = '[h264 @ 0x55d5c0a1b2c0] non-existing PPS 0 referenced'
DAMAGE = ['[h264 @ 0x55d5c0a1b2c0] error while decoding MB %d 7, bytestream -5' % i for i in range(40)]


class DamageAfterWarningsLive2(TE.Base):
    probe = (TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(20.0), b''))

    def decode(self, stderr, behavior=None):
        def ffmpeg(argv):
            return RunResult(0, TE.progress(float(argv[argv.index('-t') + 1]) if '-t' in argv else 20.0), stderr)
        kw = {'live_behavior': behavior} if behavior else {}
        rec, _ = self.run_kind('decode', [self.probe, (TE.prog('ffmpeg', '-progress'), ffmpeg)], clock=TE.Clock(), bounds={'segments': 1}, **kw)
        return rec

    def typed(self, rec, version='diag-3'):
        with rules(version):
            return EV2.derive(obs('t1', 'decode_sample', rec['status'], EVC.to_tool_result(rec, cap=1 << 20)['output'], backend='live'))

    def decode_at(self, stderr, behavior, segments=1, duration=20.0):
        def ffmpeg(argv):
            return RunResult(0, TE.progress(float(argv[argv.index('-t') + 1]) if '-t' in argv else duration), stderr)
        probe = (TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(duration), b''))
        rec, _ = self.run_kind('decode', [probe, (TE.prog('ffmpeg', '-progress'), ffmpeg)], clock=TE.Clock(), bounds={'segments': segments}, live_behavior=behavior)
        return rec

    def typed_at(self, rec, cap):
        with rules('diag-3'):
            return EV2.derive(obs('t1', 'decode_sample', rec['status'], EVC.to_tool_result(rec, cap=cap)['output'], backend='live'))

    def jb(self, value):
        return len(json.dumps(value, ensure_ascii=False).encode('utf-8'))

    def test_damage_after_startup_warnings_is_kept_within_live1s_bytes_live2(self):
        stderr = ('\n'.join([WARN] * 5 + ['[h264 @ 0x55d5c0a1b2c0] missing picture in access unit with size 12', DAMAGE[0], WARN, DAMAGE[1]]) + '\n').encode()
        rec = self.decode(stderr, 'live-2')
        seg = rec['output']['segments'][0]
        self.assertEqual(seg['errors'], [WARN, DAMAGE[0]])                 # the whole damage line beside the first line: what fits live-1's 3 warnings' bytes
        self.assertLessEqual(self.jb(seg['errors']), self.jb([WARN] * 3))
        self.assertEqual(seg['error_lines'], 9)                            # the count of every line is unchanged, so the record says what was not kept
        self.assertEqual(rec['collector_behavior'], 'live-2')
        d = self.typed(rec)
        self.assertEqual(d.integrity, 'damaged')
        self.assertTrue(any(f['kind'] == 'decoder_errors' and f['known_defect'] for f in d.findings))

    def test_a_window_keeps_live1s_budget_live2(self):
        rec = self.decode(('\n'.join([WARN] * 3 + DAMAGE) + '\n').encode(), 'live-2')
        self.assertEqual(rec['output']['segments'][0]['errors'], [WARN, DAMAGE[0]])
        rec = self.decode(('\n'.join(DAMAGE) + '\n').encode(), 'live-2')
        self.assertEqual(rec['output']['segments'][0]['errors'], DAMAGE[:3])      # damage among the first 3: exactly live-1's lines, nothing added
        for line in ('x' * 400, '[h264 @ 0x1] ' + 'y' * 300 + ' error while decoding MB 3 7, bytestream -5', 'short line'):
            forms = EVC.avtools._shown_forms(line)
            self.assertEqual(forms[0], EVC.avtools._clip(line, 160))           # live-1's own cut comes first
            self.assertTrue(all(len(f) <= 163 for f in forms), line[:20])

    def test_a_damaged_record_stays_readable_under_the_8kib_cap_live2(self):
        """The review probe: 144 distinct damage lines in each of 10 windows.  live-2 keeps live-1's 3 lines, so the record fits the 8 KiB cap of tools behaviour
        v1 (the Context default) exactly as live-1's does, and stays damaged (f399cda0 added 8 lines per window, overflowed the cap and read as unknown)."""
        many = ['[h264 @ 0x55d5c0a1b2c0] error while decoding MB %d %d, bytestream -5' % (i, j) for j in range(12) for i in range(12)]
        stderr = ('\n'.join(many) + '\n').encode()
        one, two = self.decode_at(stderr, 'live-1', 8, 600.0), self.decode_at(stderr, 'live-2', 8, 600.0)
        self.assertEqual(two['output'], one['output'])
        for rec in (one, two):
            self.assertEqual((self.typed_at(rec, 8192).integrity, self.typed_at(rec, 1 << 20).integrity), ('damaged', 'damaged'))
        mixed = ('\n'.join([WARN] * 4 + many) + '\n').encode()            # warnings first: a damage line is shown within the same bytes
        rec, ref = self.decode_at(mixed, 'live-2', 8, 600.0), self.decode_at(mixed, 'live-1', 8, 600.0)
        self.assertLessEqual(len(EVC.to_tool_result(rec, cap=1 << 20)['output'].encode()), len(EVC.to_tool_result(ref, cap=1 << 20)['output'].encode()))
        self.assertEqual(self.typed_at(rec, 8192).integrity, 'damaged')

    def test_multibyte_tails_never_grow_the_record_live2(self):
        """AUDIT-ASTRA-52 item 1: the 163-character forms did not bound bytes; an elided form ending in a CJK path took up to three times live-1's ASCII cut,
        and ten such windows pushed a record that fits 8 KiB under live-1 past the cap (unknown).  live-2 now keeps each window within the bytes live-1's own
        list takes in a tool result, so the whole record never takes more bytes than live-1's, and the damage stays readable."""
        cjk = '[h264 @ 0x55d5c0a1b2c0] /media/library/' + 'a' * 100 + '/' + '\u5f71\u7247' * 30 + '.mkv: error while decoding MB 3 7, bytestream -5'
        with rules('diag-1'):
            self.assertEqual(EV2.classify_line(cjk), 'damage')
        for head in ([cjk, WARN, DAMAGE[0]], [cjk, WARN, WARN]):              # damage visible among live-1's lines, and damage only in the long line
            stderr = ('\n'.join(head) + '\n').encode()
            one, two = self.decode_at(stderr, 'live-1', 8, 600.0), self.decode_at(stderr, 'live-2', 8, 600.0)
            for a, b in zip(one['output']['segments'], two['output']['segments']):
                self.assertLessEqual(self.jb(b['errors']), self.jb(a['errors']))
            t1, t2 = (EVC.to_tool_result(r, cap=1 << 20)['output'] for r in (one, two))
            self.assertLessEqual(len(t2.encode()), len(t1.encode()))
            self.assertEqual(two['stderr'], one['stderr'])                       # the stderr excerpt is live-1's, byte for byte
            self.assertEqual(self.typed_at(two, 8192).integrity, 'damaged', head[2][:20])

    def test_a_long_decorated_damage_line_is_recognised_live2(self):
        """AUDIT-ASTRA-48: a damage line longer than the 160-character cut (here a long path in its decoration) is classified whole, before the cut, and shown in
        a form that still reads as damage, both after start-up warnings and among the first 3 lines."""
        long_line = '[h264 @ 0x1] /long/' + 'x' * 130 + '.mkv: error while decoding MB 3 7, bytestream -5'
        for lines in ([WARN] * 3 + [long_line], [long_line, WARN]):
            rec = self.decode(('\n'.join(lines) + '\n').encode(), 'live-2')
            errors = rec['output']['segments'][0]['errors']
            self.assertLessEqual(self.jb(errors), self.jb([EVC.avtools._clip(l, 160) for l in lines[:3]]))
            self.assertTrue(any(' ... ' in x or x.startswith(('... ', '[...] ')) for x in errors), errors)        # shown elided, the cut said
            self.assertEqual(self.typed(rec).integrity, 'damaged', lines[0][:20])

    def test_a_recognised_reading_survives_any_cut_position_live2(self):
        """AUDIT-ASTRA-52 item 3: a line that is damage whole only through a reading no fixed cut keeps ('[h264 @ 0x1] ' + 'Error opening input: ' * 7 +
        'moov atom not found') is shown as that reading behind the elision mark '[...] ', in decode and audio windows."""
        line = '[h264 @ 0x1] ' + 'Error opening input: ' * 7 + 'moov atom not found'
        with rules('diag-1'):
            self.assertEqual(EV2.classify_line(line), 'damage')
            self.assertFalse(any(EV2.classify_line(f) == 'damage' for f in EVC.avtools._shown_forms(line)))     # no fixed cut keeps it
        rec = self.decode(('\n'.join([WARN] * 3 + [line]) + '\n').encode(), 'live-2')
        self.assertIn('[...] moov atom not found', rec['output']['segments'][0]['errors'])
        self.assertEqual(self.typed(rec).integrity, 'damaged')
        warn = b'[warning] [aac @ 0x3] channel element 0.1 is not allocated\n'
        rec, _ = self.run_kind('audio', [(TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(20.0), b'')),
                                         (TE.prog('ffmpeg', '-af'), RunResult(0, b'', TE.LEVELS + warn * 3 + b'[error] ' + line.encode() + b'\n'))], clock=TE.Clock(), live_behavior='live-2')
        self.assertIn('[...] moov atom not found', rec['output']['streams'][0]['segments'][0]['problems'])
        with rules('diag-3'):
            d = EV2.derive(obs('t1', 'audio_sample', rec['status'], EVC.to_tool_result(rec, cap=1 << 20)['output'], backend='live'))
        self.assertEqual(d.integrity, 'damaged')

    def test_the_audio_level_window_keeps_its_damage_live2(self):
        warn = b'[warning] [aac @ 0x3] channel element 0.1 is not allocated\n'
        for dmg in (b'[error] [mp3float @ 0x3] Invalid data found when processing input\n', b'[error] [mp3float @ 0x3] /long/' + b'x' * 130 + b'.mp3: Invalid data found when processing input\n'):
            rec, _ = self.run_kind('audio', [(TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(20.0), b'')), (TE.prog('ffmpeg', '-af'), RunResult(0, b'', TE.LEVELS + warn * 4 + dmg))],
                                   clock=TE.Clock(), live_behavior='live-2')
            seg = rec['output']['streams'][0]['segments'][0]
            self.assertEqual(seg['problem_lines'], 5)
            self.assertLessEqual(len(seg['problems']), 3)
            self.assertTrue(seg['problems'][-1].endswith('Invalid data found when processing input'), seg['problems'][-1])
            self.assertLessEqual(self.jb(seg['problems']), self.jb(['[aac @ 0x3] channel element 0.1 is not allocated'] * 3))
            with rules('diag-3'):
                d = EV2.derive(obs('t1', 'audio_sample', rec['status'], EVC.to_tool_result(rec, cap=1 << 20)['output'], backend='live'))
            self.assertEqual(d.integrity, 'damaged')
            self.assertTrue(any(f['kind'] == 'audio_decode_errors' and f['known_defect'] for f in d.findings))

    def test_an_audiobook_part_keeps_its_live2_lines_live2(self):
        """Round 4 (the coordinator's Opus review, AUDIT-ASTRA-53 item 1): the audiobook collector copies each part's decode windows key by key, and the copy
        dropped the deferred live-2 lines before collect() swapped them in, so 3 warnings and then recognised damage read unknown (still stamped live-2)."""
        book = self.dir / 'book'
        book.mkdir()
        (book / 'part 1.m4b').write_bytes(b'part' * 50)
        stderr = ('\n'.join([WARN] * 3 + [DAMAGE[0]]) + '\n').encode()
        rules_ = [(TE.prog('ffprobe', '-show_format'), RunResult(0, TE.book_probe(), b'')), (TE.prog('ffmpeg', '-progress'), RunResult(0, TE.progress(3.0), stderr))]
        recs = {b: self.run_kind('audiobook', rules_, path=book, clock=TE.Clock(), live_behavior=b)[0] for b in ('live-1', 'live-2')}
        segs = recs['live-2']['output']['files'][0]['decode']['segments']
        self.assertTrue(segs and all(DAMAGE[0] in s['errors'] for s in segs), segs)
        self.assertNotIn('_errors_live2', json.dumps(recs['live-2']))
        self.assertEqual(recs['live-2']['stderr'], recs['live-1']['stderr'])                 # the excerpt is live-1's
        with rules('diag-3'):
            typed = {b: EV2.derive(obs('t1', 'audiobook_inspect', r['status'], EVC.to_tool_result(r, cap=8192)['output'], backend='live')).integrity for b, r in recs.items()}
        self.assertEqual(typed, {'live-1': 'unknown', 'live-2': 'damaged'})

    def test_only_the_collectors_live2_changes_are_stamped_live2(self):
        rec, _ = self.run_kind('probe', [(TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(20.0), b''))], clock=TE.Clock(), live_behavior='live-2')
        self.assertNotIn('collector_behavior', rec)
        self.assertEqual(EVC.core.LIVE2_KINDS, ('decode', 'audio', 'audiobook', 'epub'))

    def test_live1_is_the_default_and_unknown_names_are_refused_live2(self):
        stderr = ('\n'.join([WARN] * 5 + [DAMAGE[0]]) + '\n').encode()
        self.assertEqual(self.decode(stderr), self.decode(stderr, 'live-1'))
        with self.assertRaises(ValueError):
            EVC.collect(self.media, ['decode'], live_behavior='live-9')
        self.assertEqual(EVC.LIVE_BEHAVIORS, ('live-1', 'live-2'))
        self.assertEqual(EVC.DEFAULT_LIVE_BEHAVIOR, 'live-1')

    def test_control_live1_is_unchanged(self):
        long_line = '[h264 @ 0x1] /long/' + 'x' * 130 + '.mkv: error while decoding MB 3 7, bytestream -5'
        rec = self.decode(('\n'.join([long_line]) + '\n').encode())
        self.assertEqual(rec['output']['segments'][0]['errors'], [EVC.avtools._clip(long_line, 160)])     # live-1 cuts the message away ...
        self.assertEqual(self.typed(rec).integrity, 'unknown')                                            # ... and the window reads unknown, as before
        default = self.decode(('\n'.join([WARN] * 5 + [DAMAGE[0]]) + '\n').encode())
        self.assertNotIn('collector_behavior', default)
        self.assertEqual(default['output']['segments'][0]['errors'], [WARN] * 3)         # the defect, kept under live-1
        self.assertEqual(default['output']['segments'][0]['error_lines'], 6)
        self.assertEqual(self.typed(default, 'diag-2').integrity, 'unknown')


# ------------------------------------------------------------------------------------------------------------- item 4
class MixedListPagination(unittest.TestCase):
    EL = {'k%d' % i: 'v' * 60 for i in range(10)}       # one unit, but larger than the room a 700-byte page leaves
    HDR = {'id': 't1', 'alerts': [], 'page': None, 'execution': {'state': 'ran'}}

    def pages(self, order):
        units = [(('facts', 'reports'), 'split', x) for x in order]
        return EV2.paginate(self.HDR, units, EV2.canon, EV2.canon, 'case-aaaaaaaa', 't1', budget=700)

    def test_a_mixed_list_splits_a_dict_without_error_pages(self):
        order = ['first string', self.EL, 'last string']
        pages = self.pages(order)
        self.assertGreater(len(pages), 1)
        self.assertTrue(all(len(EV2.canon(b).encode()) <= 700 for b, _c in pages))
        strings, pieces = [], {}
        for body, _c in pages:
            for e in body['facts']['reports']:
                if isinstance(e, dict):
                    pieces.setdefault(e['_i'], {}).update({k: v for k, v in e.items() if k != '_i'})
                else:
                    strings.append(e)
        self.assertEqual(strings, ['first string', 'last string'])              # every plain element once, in order
        self.assertEqual(pieces, {1: self.EL})                                    # the split element is whole again, at its own index

    def test_control_lists_that_never_raised_page_exactly_as_before(self):
        digest = lambda pages: hashlib.sha256(EV2.canon([[b, c] for b, c in pages]).encode()).hexdigest()
        # computed with the 9702fa29 module: a dict before a string, dicts only, strings only
        self.assertEqual(digest(self.pages([self.EL, 'a string'])), 'bcc943b3a8ab7f5dc37cadb15f40d533b8d834858fe64bb225c03e3c6bea5c7b')
        self.assertEqual(digest(self.pages([self.EL, dict(self.EL, z='w')])), '37076982fb7b4477a87a919bc9689b0aa0545bd2496a3f52bbdfae9f2dc873ac')
        self.assertEqual(digest(self.pages(['s%d' % i * 40 for i in range(30)])), '03efa0b74dfa911589bbae7712ee2ce356db63973caff413f90f0a8957c51c7d')


# ------------------------------------------------------------------------------------------------------------- item 5
class ZipCrcSeparatorAnywhere(unittest.TestCase):
    ORDER_EXAMPLE = 'error: Error -3 while decompressing data: invalid block type\n' + 330 * 'x' + ' in member a: Permission denied'

    def test_the_first_separator_beyond_320_characters_keeps_execution_precedence_diag3(self):
        with rules('diag-3'):
            self.assertEqual(EV2.epub_failure('zip_crc', self.ORDER_EXAMPLE), 'execution')
            d = EV2.derive(obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'zip_crc', 'error': self.ORDER_EXAMPLE}))
            self.assertEqual((d.execution['cause'], d.integrity), ('tool', 'unknown'))
            self.assertFalse(any(f['known_defect'] for f in d.findings))
            self.assertEqual(AU.typed_error_support([obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'zip_crc', 'error': self.ORDER_EXAMPLE})]), {'t1': False})

    def test_a_65k_input_stays_linear_diag3(self):
        texts = ('error: Error -3 while decompressing data: invalid block type\n' + 65000 * 'x' + ' in member a: Permission denied',
                 'x' * 400 + ' in member ' * 5900 + 'a: Permission denied',
                 'BadZipFile: ' + 'y' * 330 + ' in member ' + 'a\n' * 32000 + 'b: Permission denied')
        with rules('diag-3'):
            for text in texts:
                t0 = time.perf_counter()
                got = EV2.epub_failure('zip_crc', text)
                self.assertLess(time.perf_counter() - t0, 0.05, repr(text[:30]))
                self.assertEqual(got, 'execution', repr(text[:30]))

    def test_control_diag2_is_unchanged(self):
        with rules('diag-2'):
            self.assertEqual(EV2.epub_failure('zip_crc', self.ORDER_EXAMPLE), 'damage')          # the defect, kept under diag-2

    def test_names_within_the_head_read_as_under_diag2_diag3(self):
        for text in ('CRC mismatch in member a:b.xhtml', 'CRC mismatch in member a.xhtml: Permission denied', "BadZipFile: Bad CRC-32 for file 'a.xhtml' in member a.xhtml",
                     'error: Error -3 while decompressing data: invalid block type in member a.xhtml', 'CRC mismatch in member a\nPermission denied',
                     'error: Error -3 while decompressing data: invalid block type\n' + 330 * 'x' + ' in member a.xhtml'):
            with rules('diag-2'):
                old = EV2.epub_failure('zip_crc', text)
            with rules('diag-3'):
                self.assertEqual(EV2.epub_failure('zip_crc', text), old, text[:60])


# ------------------------------------------------------------------------------------------------------------- item 6
def _epub(path, items, extra_manifest=''):
    """items: [(href, member name or None when absent from the archive, xhtml text)]; every item is in the spine."""
    manifest = ''.join('<item id="i%d" href="%s" media-type="application/xhtml+xml"/>' % (i, h) for i, (h, _m, _t) in enumerate(items)) + extra_manifest
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>Alpha Book</dc:title><dc:identifier id="b">x-1</dc:identifier></metadata><manifest>%s</manifest><spine>%s</spine></package>'
           % (manifest, ''.join('<itemref idref="i%d"/>' % i for i in range(len(items)))))
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
        z.writestr('META-INF/container.xml', D.CONTAINER)
        z.writestr('OEBPS/c.opf', opf)
        for _h, member, text in items:
            if member is not None:
                z.writestr('OEBPS/' + member, text)
    return path


CHAPTER = D.xhtml('<h1>One</h1><p>The first chapter has ordinary words in it.</p>')
EMPTY = D.xhtml('', head='')
MALFORMED = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>broken</body></html>'
COLON = 'Part1:Intro.xhtml'


class LiveResolverParityLive2(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mrh-w27-')
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def live(self, path, behavior=None, version='diag-3'):
        rec = EVC.collect(str(path), ['epub'], **({'live_behavior': behavior} if behavior else {}))[0]
        with rules(version):
            return rec, EV2.derive(obs('t1', 'epub_inspect', rec['status'], EVC.to_tool_result(rec, cap=1 << 20)['output'], backend='live'))

    def replay_v4(self, path, version='diag-3'):
        with rules(version):
            ctx = T.Context({'id': 'case-x', 'tools_available': ['epub_inspect'], 'media_type': 'epub'}, T.Fixture('local', str(path)), str(self.dir / 'scratch'),
                            tools_behavior='v4')
            res = T.tool_epub_inspect({}, ctx)
            out = res.output if isinstance(res.output, str) else json.dumps(res.output)
            return EV2.derive(obs('t1', 'epub_inspect', res.status, out))

    def books(self):
        yield 'empty', _epub(self.dir / 'empty.epub', [(COLON, COLON, EMPTY)])
        yield 'malformed', _epub(self.dir / 'malformed.epub', [(COLON, COLON, MALFORMED)])
        yield 'absent', _epub(self.dir / 'absent.epub', [(COLON, None, '')])
        for scheme, href in (('data', 'data:text/html,%3Cp%3Ex%3C/p%3E'), ('urn', 'urn:isbn:9780000000000'), ('mailto', 'mailto:someone@example.org')):
            yield scheme, _epub(self.dir / ('%s.epub' % scheme), [('ch1.xhtml', 'ch1.xhtml', CHAPTER)],
                                extra_manifest='<item id="x" href="%s" media-type="text/plain"/>' % href)

    def test_live_and_v4_replay_agree_on_colon_names_and_non_web_schemes_live2(self):
        for name, path in self.books():
            rec, live = self.live(path, 'live-2')
            replay = self.replay_v4(path)
            self.assertEqual((live.integrity, replay.integrity), ('damaged', 'damaged'), name)
            self.assertTrue(any(f['known_defect'] for f in live.findings), name)
            if name in ('absent', 'data', 'urn', 'mailto'):
                self.assertEqual((rec['output']['stage'], live.package['manifest'], replay.package['manifest']), ('manifest', 'damaged', 'damaged'), name)

    def test_a_long_missing_href_keeps_the_failed_stage_under_the_caps_live2(self):
        """The review probe: a missing `data:` href of 5 KB (at the 8 KiB cap) or 400 KB (at the 1 MiB cap) was copied whole into the error, the reason and
        manifest_missing; the cap then cut the output and the typed layer lost the stage (unknown live, damaged on v4 replay).  live-2 cuts every reported name
        at 200 characters."""
        for n, cap in ((5000, 8192), (400000, 1 << 20)):
            path = _epub(self.dir / ('long%d.epub' % n), [('ch1.xhtml', 'ch1.xhtml', CHAPTER)],
                         extra_manifest='<item id="x" href="data:text/plain;base64,%s" media-type="text/plain"/>' % ('A' * n))
            rec = EVC.collect(str(path), ['epub'], live_behavior='live-2')[0]
            tr = EVC.to_tool_result(rec, cap=cap)
            self.assertFalse(tr['truncated'], n)
            self.assertTrue(all(len(m) <= 200 + 20 for m in rec['output']['manifest_missing']))
            self.assertLess(len(rec['output']['error']), 400)
            with rules('diag-3'):
                live = EV2.derive(obs('t1', 'epub_inspect', rec['status'], tr['output'], backend='live'))
            self.assertEqual((live.integrity, live.package['manifest'], self.replay_v4(path).integrity), ('damaged', 'damaged', 'damaged'), n)

    def test_many_long_multibyte_names_keep_the_failed_stage_at_8kib_live2(self):
        """AUDIT-ASTRA-52 item 2: five absent `data:` hrefs of 250 CJK characters each took 10,088 bytes although each name was cut at 200 characters, and the
        8 KiB cap lost the manifest stage.  live-2 cuts each name at 200 BYTES and lists the names within a byte budget, with the number left out."""
        extra = ''.join('<item id="x%d" href="data:text/plain,%s%d" media-type="text/plain"/>' % (k, '\u5f71' * 250, k) for k in range(5))
        path = _epub(self.dir / 'cjk.epub', [('ch1.xhtml', 'ch1.xhtml', CHAPTER)], extra_manifest=extra)
        rec = EVC.collect(str(path), ['epub'], live_behavior='live-2')[0]
        tr = EVC.to_tool_result(rec, cap=8192)
        self.assertFalse(tr['truncated'])
        out = rec['output']
        jb = lambda v: len(json.dumps(v, ensure_ascii=False).encode())
        self.assertLessEqual(jb(out['error']) + jb(rec['reason']) + jb(out['manifest_missing']), 2400 + 6)      # (round 4: FAILURE_FIELDS_BYTES_LIVE2)
        self.assertEqual(out['manifest_missing_omitted'] + len(out['manifest_missing']), 5)
        self.assertIn('more)', out['error'])
        with rules('diag-3'):
            live = EV2.derive(obs('t1', 'epub_inspect', rec['status'], tr['output'], backend='live'))
        self.assertEqual((live.integrity, live.package['manifest']), ('damaged', 'damaged'))

    def test_escape_heavy_names_keep_the_final_fields_in_budget_live2(self):
        """AUDIT-ASTRA-53 item 2: the list budget did not count the list's expansion in the message (Python's list form writes DEL as `\\x7f`, which JSON
        escapes again): 20 absent names with %7F runs and a 1,004-character OPF name gave an 8,196-byte result and read unknown at 8 KiB.  live-2 budgets
        the FINAL fields (error, reason, manifest_missing) as a tool result writes them."""
        opf_name = 'OEBPS/' + 'o' * 993 + '.opf'
        items = ''.join('<item id="x%d" href="x%d%s.xhtml" media-type="application/xhtml+xml"/>' % (k, k, '%7F' * 60) for k in range(20))
        opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
               '<dc:title>Alpha Book</dc:title><dc:identifier id="b">x-1</dc:identifier></metadata><manifest><item id="i0" href="ch1.xhtml" media-type="application/xhtml+xml"/>%s'
               '</manifest><spine><itemref idref="i0"/></spine></package>' % items)
        path = self.dir / 'escapes.epub'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
            z.writestr('META-INF/container.xml', D.CONTAINER.replace('OEBPS/c.opf', opf_name))
            z.writestr(opf_name, opf)
            z.writestr('OEBPS/ch1.xhtml', CHAPTER)
        rec = EVC.collect(str(path), ['epub'], live_behavior='live-2')[0]
        out = rec['output']
        tr = EVC.to_tool_result(rec, cap=8192)
        self.assertFalse(tr['truncated'])
        jb = lambda v: len(json.dumps(v, ensure_ascii=False).encode())
        self.assertLessEqual(jb(out['error']) + jb(rec['reason']) + jb(out['manifest_missing']), 2400 + 6)       # FAILURE_FIELDS_BYTES_LIVE2
        self.assertEqual(out['manifest_missing_omitted'] + len(out['manifest_missing']), 20)
        for version in ('diag-1', 'diag-2', 'diag-3'):
            with rules(version):
                live = EV2.derive(obs('t1', 'epub_inspect', rec['status'], tr['output'], backend='live'))
            self.assertEqual((live.integrity, live.package['manifest']), ('damaged', 'damaged'), version)

    def test_the_omitted_count_comes_from_the_whole_list_live2(self):
        """AUDIT-ASTRA-53 item 4: twenty short missing names list ten and say '(+10 more)'; manifest_missing_omitted counts them too."""
        extra = ''.join('<item id="x%d" href="gone%d.xhtml" media-type="application/xhtml+xml"/>' % (k, k) for k in range(20))
        rec = EVC.collect(str(_epub(self.dir / 'twenty.epub', [('ch1.xhtml', 'ch1.xhtml', CHAPTER)], extra_manifest=extra)), ['epub'], live_behavior='live-2')[0]
        out = rec['output']
        self.assertEqual((len(out['manifest_missing']), out.get('manifest_missing_omitted')), (10, 10))
        self.assertTrue(out['error'].endswith('(+10 more)'), out['error'][-30:])

    def test_crc_evidence_reads_the_same_whatever_the_name_says_live2(self):
        """Round 4 (the Opus review, AUDIT-ASTRA-53 item 3): a cut member name could add or remove an execution tail ('OEBPS/' + 300 x + ': Permission denied'
        read damage after the cut, execution under live-1; 'a' * 181 + ': Permission denied' + 'z' * 40 + '.xhtml' read execution after the cut, damage
        before).  live-2 writes a genuine CRC failure as 'BadZipFile: CRC mismatch in member "<quoted name>"': the quote, the backslash, ':' and every line
        break or control character are escaped inside the quotes, so the evidence is damage under every rule set, whatever the name."""
        names = ('OEBPS/' + 'x' * 300 + ': Permission denied', 'a' * 181 + ': Permission denied' + 'z' * 40 + '.xhtml', 'a.xhtml: Permission denied',
                 'q"\\: [Errno 13] Permission denied\n\u2028b: Input/output error', 'OEBPS/' + '\u4e66' * 150 + '.xhtml')
        for k, member in enumerate(names):
            path = self.dir / ('crcq%d.epub' % k)
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
                z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
                z.writestr('META-INF/container.xml', D.CONTAINER)
                z.writestr(member, 'hello world body text')
            raw = bytearray(path.read_bytes())
            raw[raw.find(b'hello world')] ^= 0xFF
            path.write_bytes(bytes(raw))
            rec = EVC.collect(str(path), ['epub'], live_behavior='live-2')[0]
            err = rec['output']['error']
            self.assertTrue(err.startswith('BadZipFile: CRC mismatch in member "') and err.endswith('"'), err[:60])
            self.assertNotIn(':', err[len('BadZipFile: CRC mismatch in member '):])
            self.assertLessEqual(len(json.dumps(err, ensure_ascii=False).encode()), 300)
            for version in ('diag-1', 'diag-2', 'diag-3'):
                with rules(version):
                    self.assertEqual(EV2.epub_failure('zip_crc', err), 'damage', (version, member[-24:]))
                    live = EV2.derive(obs('t1', 'epub_inspect', rec['status'], EVC.to_tool_result(rec, cap=8192)['output'], backend='live'))
                self.assertEqual((live.integrity, live.execution['cause']), ('damaged', 'input'), (version, member[-24:]))

    def test_a_crc_failure_in_a_long_member_name_keeps_its_stage_live2(self):
        """AUDIT-ASTRA-52 item 2: the zip_crc branch reported the whole member name (a 10,000-character name: 10,854 bytes even at cap=8192, unknown).
        live-2 cuts it; zipfile's `Bad CRC-32 for file '<name>'` is written in the harness's allow-listed CRC wording with the name quoted (round 4)."""
        name = 'OEBPS/' + 'n' * 10000 + '.xhtml'
        path = _epub(self.dir / 'crc.epub', [('ch1.xhtml', 'ch1.xhtml', CHAPTER)])
        with zipfile.ZipFile(path, 'a') as z:
            z.writestr(zipfile.ZipInfo(name), b'MARKER-CONTENT-0123456789')
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b'MARKER-CONTENT-0123456789', b'MARKER-CONTENT-9876543210'))      # same size, wrong CRC
        rec = EVC.collect(str(path), ['epub'], live_behavior='live-2')[0]
        self.assertEqual(rec['output']['stage'], 'zip_crc')
        self.assertTrue(rec['output']['error'].startswith('BadZipFile: CRC mismatch in member "OEBPS/nnn'), rec['output']['error'][:80])
        tr = EVC.to_tool_result(rec, cap=8192)
        self.assertLessEqual(len(tr['output'].encode()), 8192)
        for version in ('diag-1', 'diag-2', 'diag-3'):
            with rules(version):
                live = EV2.derive(obs('t1', 'epub_inspect', rec['status'], tr['output'], backend='live'))
            self.assertEqual((live.integrity, live.package['zip_crc']), ('damaged', 'damaged'), version)
        one = EVC.collect(str(path), ['epub'])[0]                                     # live-1, unchanged: zipfile's own message and the whole name
        self.assertTrue(one['output']['error'].startswith("BadZipFile: Bad CRC-32 for file 'OEBPS/nnn"))
        self.assertTrue(one['output']['error'].endswith(name))

    def test_present_non_web_scheme_members_are_clean_on_both_paths_live2(self):
        """AUDIT-ASTRA-48 item 2: a `data:`, `urn:` or `mailto:` href is damage only when the member it resolves to is absent; an archive may hold that literal
        name, and then both paths read the package as clean."""
        for scheme, href in (('data', 'data:text/html,hello'), ('urn', 'urn:isbn:9780000000000'), ('mailto', 'mailto:someone@example.org')):
            path = self.dir / ('present-%s.epub' % scheme)
            _epub(path, [('ch1.xhtml', 'ch1.xhtml', CHAPTER)], extra_manifest='<item id="x" href="%s" media-type="text/plain"/>' % href)
            with zipfile.ZipFile(path, 'a') as z:
                z.writestr('OEBPS/' + href, 'plain text')
            rec, live = self.live(path, 'live-2')
            self.assertEqual((rec['status'], rec['output']['valid'], live.integrity, self.replay_v4(path).integrity), ('ok', True, 'clean', 'clean'), scheme)

    def test_an_item_without_an_id_is_checked_as_on_v4_replay_live2(self):
        path = _epub(self.dir / 'idless.epub', [('ch1.xhtml', 'ch1.xhtml', CHAPTER)], extra_manifest='<item href="Part1:gone.xhtml" media-type="application/xhtml+xml"/>')
        rec, live = self.live(path, 'live-2')
        self.assertEqual((rec['output']['stage'], live.integrity, self.replay_v4(path).integrity), ('manifest', 'damaged', 'damaged'))
        rec1, live1 = self.live(path, version='diag-2')
        self.assertEqual((rec1['status'], live1.integrity), ('ok', 'clean'))          # live-1 checks only items with an id, as before

    def test_the_resolver_is_tools_v4s_live2(self):
        for href in (COLON, 'ch1.xhtml', 'Text/ch%201.xhtml#p2', '../x.xhtml', 'data:text/plain,abc', 'urn:isbn:1', 'mailto:a@b.c', 'http://example.org/a.xhtml',
                     'HTTPS://example.org/a', '//cdn.example.org/font.woff', 'ftp://host/x', 'file:///etc/x', 'a:b:c.xhtml', '', '?q=1', 'C:/books/x.xhtml'):
            want = None if T.remote_href_v4(href) else T.local_href_v4('OEBPS/c.opf', href)
            self.assertEqual(epubtool._resolve_live2('OEBPS/c.opf', href), want, href)

    def test_web_hrefs_stay_remote_and_a_present_colon_member_is_read_live2(self):
        remote = _epub(self.dir / 'remote.epub', [('ch1.xhtml', 'ch1.xhtml', CHAPTER)],
                       extra_manifest='<item id="r" href="https://example.org/font.woff" media-type="font/woff"/><item id="s" href="//cdn.example.org/a.css" media-type="text/css"/>')
        rec, live = self.live(remote, 'live-2')
        self.assertEqual((rec['status'], rec['output']['valid'], live.integrity), ('ok', True, 'clean'))
        ok = _epub(self.dir / 'ok.epub', [(COLON, COLON, CHAPTER)])
        rec, live = self.live(ok, 'live-2')
        self.assertEqual((rec['output']['valid'], rec['output']['xhtml']['parsed_ok'], live.integrity), (True, 1, 'clean'))
        self.assertEqual(self.replay_v4(ok).integrity, 'clean')

    def test_control_live1_is_unchanged(self):
        for name, path in self.books():
            rec, live = self.live(path, version='diag-2')
            self.assertEqual((rec['status'], rec['output']['valid'], live.integrity), ('ok', True, 'clean'), name)     # the divergence, kept under live-1
            self.assertNotIn('collector_behavior', rec)
            if name in ('absent', 'data', 'urn', 'mailto'):
                self.assertEqual(self.replay_v4(path, 'diag-2').integrity, 'damaged', name)                            # v4 replay, as before

    def test_the_harness_passes_live2_to_the_collector_live2(self):
        seen = []

        def fake_collect(path, kinds, bounds, **kw):
            seen.append(kw.get('live_behavior'))
            return EVC.collect(path, kinds, bounds, **kw)
        path = _epub(self.dir / 'empty.epub', [(COLON, COLON, EMPTY)])
        for behavior in ('live-1', 'live-2'):
            ctx = T.Context({'id': 'case-x', 'tools_available': ['epub_inspect'], 'media_type': 'epub'}, T.Fixture('local', str(path)), str(self.dir / 'scratch'),
                            evidence_mode='live', collect=fake_collect, tools_behavior='v3', live_behavior=behavior)
            res = T.live_tool('epub_inspect', {}, ctx)
            self.assertEqual(res.extra['evidence'].get('collector_behavior'), None if behavior == 'live-1' else 'live-2')
        self.assertEqual(seen, [None, 'live-2'])         # live-1 makes exactly the earlier call (no new keyword)


# ------------------------------------------------------------------------------------------------------------- item 7
class V4PairingDiag3(unittest.TestCase):
    NO_TEXT = 'AssertionError: ' + T.NO_TEXT_V4

    def ctx(self):
        return T.Context({'id': 'case-x', 'tools_available': ['epub_inspect'], 'media_type': 'epub'}, T.Fixture('none', None), tempfile.mkdtemp(prefix='mrh-w27-'),
                         tools_behavior='v4')

    def derive(self):
        return EV2.derive(obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'spine', 'error': self.NO_TEXT}))

    def test_v4_pairs_with_diag3_diag3(self):
        with rules('diag-3'):
            self.assertEqual(self.ctx().tools_behavior, 'v4')
            self.assertEqual(EV2.epub_failure('spine', self.NO_TEXT), 'damage')
            self.assertEqual(self.derive().integrity, 'damaged')

    def test_control_the_documented_mismatch_is_conservative(self):
        for version in (None, 'diag-1'):
            with (rules(version) if version else contextlib.nullcontext()):
                with self.assertRaises(ValueError):
                    self.ctx()                                                       # still refused at build time
                d = self.derive()                                                    # classified anyway (documented: not refused here)
                self.assertEqual((d.integrity, [f['known_defect'] for f in d.findings]), ('unknown', [False]))
                self.assertEqual(AU.typed_error_support([obs('t1', 'epub_inspect', 'error', {'status': 'error', 'stage': 'spine', 'error': self.NO_TEXT})]), {'t1': False})
        with rules('diag-2'):
            self.assertEqual(self.ctx().tools_behavior, 'v4')
            self.assertEqual(self.derive().integrity, 'damaged')
        self.assertEqual(T.TOOLS_V4_DIAGNOSTIC_RULES, 'diag-2')
        self.assertEqual(T.TOOLS_BEHAVIORS, ('v1', 'v2', 'v3', 'v4'))
        self.assertEqual((EV2.DEFAULT_DIAGNOSTIC_RULES, EV2.active_diagnostic_rules()), ('diag-1', 'diag-1'))


# ------------------------------------------------------------------------------------------------------------- the public deltas
class W27DeltasReproduce(unittest.TestCase):
    """docs/w27-deltas.json (the public deltas reported in the PR and in docs/evidence-format-v2.md, last section) is what the script writes now."""

    def test_the_committed_deltas_reproduce(self):
        B.need_v11()
        if W25.pod_local_fixtures_missing():
            self.skipTest('a pod-local EPUB fixture is not in this checkout: the epub_inspect {} and live results legitimately differ here')
        import importlib.util
        spec = importlib.util.spec_from_file_location('w27_deltas_script', th.COMPONENT / 'scripts' / 'w27_deltas.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = Path(tempfile.mkdtemp(prefix='mrh-w27-')) / 'd.json'
        with contextlib.redirect_stdout(io.StringIO()):
            mod.main(['--out', str(out)])
        self.assertEqual(out.read_text(), (th.COMPONENT / 'docs' / 'w27-deltas.json').read_text())
        doc = json.loads(out.read_text())
        for suite in doc['suites'].values():
            self.assertEqual(set(suite['changed'].values()), {0})
        self.assertEqual((doc['tension_v33']['added'], doc['tension_v33']['removed'], doc['tension_v33']['reason_changed']), ([], [], []))
        self.assertTrue(all(not row[r] for row in doc['uncalled_v2']['runs'].values() for r in ('diag-2', 'diag-3')))


if __name__ == '__main__':
    unittest.main()
