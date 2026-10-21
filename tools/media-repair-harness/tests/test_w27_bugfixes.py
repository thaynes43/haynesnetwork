"""W27 (OpenProject #145 remainder and the PR #1031 review nits): evidence follow-ups, each under a new opt-in version beside the old one.

One class per item of the work order.  Every test named `*_diag3`, `*_live2` or `*_pages` fails at main 9702fa29 (the version it selects does not exist
there, or exists with the defect), and its paired control pins that the earlier version is unchanged.

  1  #145 (2)   diag-3: the cross-line `error reading header` rule reads every decorated form of the header line, not only the bracketed one
  2  #145 (3)   diag-3: an OSError at stage zip_open (offline EPUB inspector) is an execution failure unless a positive damage diagnostic says otherwise
  3  #145 (4)   live-2: a decode (and audio level) window keeps the damage lines printed after its first 3 diagnostic lines, bounded
  4  #145 (5)   pagination (pages-v1, crash-only): a list that mixes strings and dicts no longer raises AttributeError once a dict element is split
  5  #1031      diag-3: the zip_crc execution check starts at the first ` in member ` separator wherever it is (linear; a 65k input stays under 50 ms)
  6  #1031      live-2: the live EPUB collector resolves manifest hrefs exactly as tools behaviour v4 (colon-named members are local; data:, urn:, mailto: are
                local members, so missing), so live and v4 replay agree
  7  #1031      the tools v4 / diagnostic rules pairing: v4 also pairs with diag-3; why it is not checked again at classification time is documented
                (tools.py), and the mismatch it would catch is pinned as conservative

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
    ERRORS = ('OSError: [Errno 22] Invalid argument', "OSError: [Errno 40] Too many levels of symbolic links: '/media/book.epub'",
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
            with mock.patch('zipfile.ZipFile', side_effect=OSError(errno.EINVAL, 'Invalid argument')):
                staged = T._epub_stage(str(book), remote_ok=True)
            self.assertEqual(staged, ('zip_open', 'OSError: [Errno 22] Invalid argument'))
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

    def test_damage_after_startup_warnings_is_kept_and_read_live2(self):
        stderr = ('\n'.join([WARN] * 5 + ['[h264 @ 0x55d5c0a1b2c0] missing picture in access unit with size 12', DAMAGE[0], WARN, DAMAGE[1]]) + '\n').encode()
        rec = self.decode(stderr, 'live-2')
        seg = rec['output']['segments'][0]
        self.assertEqual(seg['errors'], [WARN] * 3 + DAMAGE[:2])
        self.assertEqual(seg['error_lines'], 9)                       # the count of every line is unchanged, so the record says what was not kept
        self.assertEqual(rec['collector_behavior'], 'live-2')
        d = self.typed(rec)
        self.assertEqual(d.integrity, 'damaged')
        self.assertTrue(any(f['kind'] == 'decoder_errors' and f['known_defect'] for f in d.findings))

    def test_the_kept_lines_are_bounded_live2(self):
        rec = self.decode(('\n'.join([WARN] * 3 + DAMAGE) + '\n').encode(), 'live-2')
        seg = rec['output']['segments'][0]
        self.assertEqual(seg['errors'], [WARN] * 3 + DAMAGE[:8])
        self.assertEqual(len(seg['errors']), 3 + EVC.avtools.LIVE2_DAMAGE_LINES)
        self.assertLessEqual(sum(len(x) for x in seg['errors']), 11 * 163)

    def test_the_audio_level_window_keeps_its_damage_live2(self):
        bad = TE.LEVELS + b''.join(b'[warning] [aac @ 0x3] channel element 0.1 is not allocated\n' for _ in range(4)) + b'[error] [mp3float @ 0x3] Invalid data found when processing input\n'
        rec, _ = self.run_kind('audio', [(TE.prog('ffprobe', '-show_format'), RunResult(0, TE.probe_json(20.0), b'')), (TE.prog('ffmpeg', '-af'), RunResult(0, b'', bad))],
                               clock=TE.Clock(), live_behavior='live-2')
        seg = rec['output']['streams'][0]['segments'][0]
        self.assertEqual(seg['problem_lines'], 5)
        self.assertEqual(seg['problems'][-1], '[mp3float @ 0x3] Invalid data found when processing input')
        self.assertEqual(len(seg['problems']), 4)

    def test_live1_is_the_default_and_unknown_names_are_refused_live2(self):
        stderr = ('\n'.join([WARN] * 5 + [DAMAGE[0]]) + '\n').encode()
        self.assertEqual(self.decode(stderr), self.decode(stderr, 'live-1'))
        with self.assertRaises(ValueError):
            EVC.collect(self.media, ['decode'], live_behavior='live-9')
        self.assertEqual(EVC.LIVE_BEHAVIORS, ('live-1', 'live-2'))
        self.assertEqual(EVC.DEFAULT_LIVE_BEHAVIOR, 'live-1')

    def test_control_live1_is_unchanged(self):
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
