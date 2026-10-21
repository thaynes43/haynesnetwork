"""dev-c7 (WO-W22 with the AUDIT-ASTRA-26 amendments): prompt v7, evidence format v3.1-format, tools behaviour v3 (EPUB body excerpts), the rubric v3.2
clarification.  Synthetic, generic fixtures and scripted replies only; no model, no network, no dev-suite label.  Expected values are written by hand from the
synthetic inputs.  These tests show what the HARNESS shows and checks, never what a model would decide."""
import copy
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import ev2h
import th
from ev2h import tc
from media_repair_harness import epub_text as ET
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import evidence_v31 as EV31
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T
from media_repair_harness.experimental.contract_v3 import facts as FX
from media_repair_harness.experimental.contract_v3 import prereq as PQ
from media_repair_harness.experimental.contract_v3 import rubric as RB
from media_repair_harness.experimental.contract_v3 import rubric_v32 as RB32

# pins: prompts/v7.txt (file bytes and the assembled text the model is sent), the rubric v3.2 object and the frozen excerpt rules
V7_FILE_SHA256 = '0875cc586b18debb241cfb569b5387a4b5da71064726fc3610bed8776fdfe8f9'
V7_ASSEMBLED_SHA256 = '79a7fc73b855ccee6964c4752249477b070b79acebc3daf5c9c17a8a6b3eafb5'
RUBRIC_V32_SHA = '2af0b36e48c59233a4c5743f9a866958c56f7ce53e39aaa9f26eff7cc629a4c7'
EXCERPT_RULES_SHA = '42bd495a35615ac031e050aea30d2cc7e7aaf586ab28759b6148aac66d197a52'   # xhtml-body-text-1, frozen (no longer selected)

CONTAINER = ('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>'
             '<rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')


def xhtml(body, head='<title>Head Title</title>'):
    return '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head>%s</head><body>%s</body></html>' % (head, body)


def build_epub(path, items, title='Alpha Book', creator='A. Writer', nav=None, ncx=None, spine=None):
    """items: [(member name under OEBPS, xhtml text)]; spine: member order (default the item order); nav: [(label, href)] -> an EPUB 3 nav document;
    ncx: [(label, src)] -> an EPUB 2 NCX."""
    manifest, files = [], []
    for i, (name, text) in enumerate(items):
        manifest.append('<item id="i%d" href="%s" media-type="application/xhtml+xml"/>' % (i, name))
        files.append(('OEBPS/' + name, text))
    ids = {name: 'i%d' % i for i, (name, _t) in enumerate(items)}
    toc_attr = ''
    if nav is not None:
        links = ''.join('<li><a href="%s">%s</a></li>' % (h, l) for l, h in nav)
        files.append(('OEBPS/nav.xhtml', xhtml('<nav epub:type="toc"><ol>%s</ol></nav>' % links)))
        manifest.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    if ncx is not None:
        pts = ''.join('<navPoint id="p%d"><navLabel><text>%s</text></navLabel><content src="%s"/></navPoint>' % (i, l, s) for i, (l, s) in enumerate(ncx))
        files.append(('OEBPS/toc.ncx', '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>%s</navMap></ncx>' % pts))
        manifest.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        toc_attr = ' toc="ncx"'
    order = spine or [n for n, _t in items]
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>%s</dc:title><dc:creator>%s</dc:creator></metadata><manifest>%s</manifest><spine%s>%s</spine></package>'
           % (title, creator, ''.join(manifest), toc_attr, ''.join('<itemref idref="%s"/>' % ids[n] for n in order)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
        z.writestr('META-INF/container.xml', CONTAINER)
        z.writestr('OEBPS/c.opf', opf)
        for n, t in files:
            z.writestr(n, t)
    Path(path).write_bytes(buf.getvalue())
    return path


class Tmp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='mrh-w22-')

    def epub(self, items, name='q7z', **kw):      # (a fixture name is redacted from tool text by leakguard: keep it out of the body words)
        return build_epub(os.path.join(self.dir, name + '.epub'), items, **kw)

    def ctx(self, path, behavior='v3', kind='local', **kw):
        case = dict({'id': 'w22-x', 'tools_available': ['epub_inspect'], 'context': {}, 'evidence': []}, **kw)
        return T.Context(case, T.Fixture(kind, path=path), self.dir, tools_behavior=behavior)

    def call(self, path, args=None, **kw):
        r = T.call_tool(self.ctx(path, **kw), 'epub_inspect', args or {})
        return r, (json.loads(r['output']) if r['output'][:1] == '{' else r['output'])


# ---------------------------------------------------------------------------------------------------------------- versions
class Versions(unittest.TestCase):
    def test_harness_version_and_the_new_names(self):
        self.assertEqual(P.HARNESS_VERSION, 'dev-c7')
        self.assertEqual(EV31.FORMAT_VERSION, 'v3.1-format')       # never "v3.1": that is the rubric amendment
        self.assertNotEqual(EV31.FORMAT_VERSION, RB.RUBRIC_V31_VERSION)
        self.assertEqual((EV31.TOOLS_BEHAVIOR, EV31.RUBRIC_VERSION, EV31.CHECKER_RUBRIC), ('v3', 'contract-v3-rubric-3.2', 'contract-v3-rubric-3.1'))
        self.assertEqual(R.EVIDENCE_FORMATS, ('v2', 'v3', 'v3.1-format'))
        self.assertEqual(P.protocol_of('v7'), 'v3')

    def test_permitted_and_rejected_combinations(self):
        R.check_option_combination('v7', 'v3.1-format')
        R.check_option_combination('v7', 'v3.1-format', 'v3')
        R.check_option_combination('v7', 'v3.1-format', None, 2560)
        for pv, fmt, g in (('v7', 'v3', None), ('v7', 'v2', None), ('v7', None, None), ('v6', 'v3.1-format', None), ('v5', 'v3.1-format', None),
                           ('v4', 'v3.1-format', None), ('v1', 'v3.1-format', None), ('v7', 'v3.1-format', 'v1'), ('v7', 'v3.1-format', 'v2'), ('v7', 'v3.1', None)):
            with self.assertRaises(ValueError, msg=(pv, fmt, g)):
                R.check_option_combination(pv, fmt, g)
        with self.assertRaises(ValueError):
            R.check_option_combination('v7', 'v3.1-format', None, 100)
        # every earlier combination keeps its rule
        for pv, fmt, g in (('v6', 'v3', 'v3'), ('v6', 'v3', None), ('v5', 'v2', 'v3'), ('v4', 'v2', None), ('v4', None, 'v2'), ('v1', None, None)):
            R.check_option_combination(pv, fmt, g)
        for pv, fmt in (('v6', 'v2'), ('v6', None), ('v5', None), ('v5', 'v3'), ('v4', 'v3')):
            with self.assertRaises(ValueError):
                R.check_option_combination(pv, fmt)

    def test_v6_is_frozen_and_v7_is_pinned(self):
        prompts = th.COMPONENT / 'src' / 'media_repair_harness' / 'prompts'
        self.assertEqual(hashlib.sha256((prompts / 'v6.txt').read_bytes()).hexdigest(), '17f34466533792d423caa52c8d5239e9f33a707aa3ff250f2b4abc0d526b637c')
        self.assertEqual(hashlib.sha256((prompts / 'v7.txt').read_bytes()).hexdigest(), V7_FILE_SHA256)
        self.assertEqual(P.get_prompt('v7')['sha256'], V7_ASSEMBLED_SHA256)

    def test_rubric_objects_frozen_and_v32_pinned(self):
        self.assertEqual(RB32.sha256_v32(), RUBRIC_V32_SHA)
        self.assertEqual(RB32.EOF_TOLERANCE_S, EV2.EOF_TOLERANCE_S)            # no new tolerance value
        self.assertEqual(RB32.RUBRIC_V32['amends'], RB.RUBRIC_V31_VERSION)
        for k, v in RB.RUBRIC_V31.items():                                       # v3.2 adds clarifications and changes nothing of v3.1
            self.assertEqual(RB32.RUBRIC_V32[k], v, k) if k not in ('version', 'amends') else None
        self.assertEqual([c['id'] for c in RB32.CLARIFICATIONS_V32], ['C32-1', 'C32-2', 'C32-3', 'C32-4'])
        self.assertEqual([d['id'] for d in RB32.OPEN_DISAGREEMENTS_V32], ['D32-1', 'D32-2', 'D32-3'])
        doc = json.loads((th.COMPONENT / 'docs' / 'contract-v3-prerequisites-v3.2.json').read_text())
        self.assertEqual(doc, json.loads(RB32.canonical_json_v32()))

    def test_excerpt_rules_are_frozen_and_the_prompt_and_capability_state_them(self):
        self.assertEqual(ET.rules_digest(), EXCERPT_RULES_SHA)
        text = P.get_prompt('v7')['text']
        self.assertIn('the first %d code points of the first %d spine items' % (ET.DEFAULT_EXCERPT_CHARS, ET.DEFAULT_EXCERPT_ITEMS), text)
        self.assertIn('length 1 to %d, default %d' % (ET.MAX_EXCERPT_CHARS, ET.REQUEST_EXCERPT_CHARS), text)
        self.assertIn('1 to %d, default %d' % (ET.MAX_EXCERPT_CHARS, ET.REQUEST_EXCERPT_CHARS), T.EXCERPT_CAPABILITY['length'])

    def test_v7_states_the_typed_completion_rule_and_drops_the_unconditional_one(self):
        v6, v7 = P.get_prompt('v6')['text'], P.get_prompt('v7')['text']
        old = 'A full decode whose observed end falls short of the container duration creates a completion conflict.'
        self.assertIn(old, v6)
        self.assertNotIn(old, v7)
        for s in ('within 1 s', 'up to and including 1 s is not a conflict', 'above 1 s is the conflict decoded_span_shorter_than_duration',
                  'completion is unknown, not a conflict', 'never adds the remainder to what was checked', 'never certifies the whole file'):
            self.assertIn(s, v7)
        self.assertIn('container-level tag map (format.tags or tags) is explicitly empty ({}) is an explicitly empty naming surface', v7)
        self.assertIn('Its title, album and artist are absent, not each empty', v7)

    def test_a_v7_run_records_every_version(self):
        case = book_case(tempfile.mkdtemp(prefix='mrh-w22-'))
        ts = th.TempSuite([case])
        rec, _ad = ev2h.scripted_run(case, ts, [json.dumps(d3())], prompt='v7', evidence_format='v3.1-format', guards='v3', which=th.NO_BINARIES)
        ef = rec['evidence_format']
        self.assertEqual((rec['harness_version'], rec['prompt']['version'], rec['prompt']['protocol']), ('dev-c7', 'v7', 'turn-v3'))
        self.assertEqual((ef['version'], ef['tools_behavior'], ef['rubric'], ef['checker_rubric'], ef['excerpt_rule'], ef['protocol'], ef['decision_schema'], ef['audit_version']),
                         ('v3.1-format', 'v3', 'contract-v3-rubric-3.2', 'contract-v3-rubric-3.1', 'xhtml-body-text-3', 'turn-v3', 'decision-v3', 'v3'))
        self.assertEqual(ef['excerpt_rules_sha256'], EV31.ET.rules_digest())
        self.assertEqual(rec['action_audit']['checker_rubric'], 'contract-v3-rubric-3.1')


def d3(cls='insufficient_evidence', action='escalate', refs=()):
    return {'type': 'decision', 'class': cls, 'action': action, 'reason': 'r', 'confidence': 0.5, 'evidence_refs': list(refs)}


def book_case(directory, items=None, evidence=(), cid='w22-book', **kw):
    path = build_epub(os.path.join(directory, cid + '.epub'), items or [('a.xhtml', xhtml('<h1>Alpha Book</h1><p>%s</p>' % ('lorem ' * 120)))], **kw)
    case = ev2h.case_with(list(evidence), tools=('epub_inspect',), cid=cid, media='epub')
    case['context'].update(title='Alpha Book', filename='Alpha Book.epub', expected={'title': 'Alpha Book', 'author': 'A. Writer'})
    case['fixture'] = {'kind': 'local', 'locator': path}
    return case


# ---------------------------------------------------------------------------------------------------------------- decode tolerance
def _probe(duration='12.0'):
    fmt = {'format_name': 'matroska'}
    if duration is not None:
        fmt['duration'] = duration
    return {'exit_code': 0, 'stderr': '', 'format': fmt, 'streams': [{'index': 0, 'codec_type': 'video', 'codec_name': 'h264'}]}


def _full(decoded, **kw):
    d = {'at_s': 0, 'window_s': 'full', 'exit_code': 0, 'frames': 100, 'stderr': '', 'completed_to_eof': True}
    if decoded is not None:
        d['out_time'] = '%02d:%02d:%09.6f' % (decoded // 3600, (decoded % 3600) // 60, decoded % 60)
    d.update(kw)
    return d


def ob(i, tool, out, status='ok', args=None, backend=None, source='tool'):
    return EV2.make_observation(i, tool, args or {}, status, out if isinstance(out, str) else json.dumps(out), backend, source)


class DecodeTolerance(unittest.TestCase):
    def full(self, decoded, duration='12.0', status='ok', **kw):
        an = EV31.analyze([ob('e1', 'ffprobe', _probe(duration), source='case'), ob('t1', 'decode_sample', _full(decoded, **kw), status=status, args={'full': True})], {}, 'movie')
        return an['items']['t1'], an['coverage']

    def test_below_at_and_above_the_existing_one_second_tolerance(self):
        for decoded, complete, conflict in ((11.5, True, False), (11.001, True, False), (11.0, True, False), (10.999, False, True), (10.0, False, True)):
            d, cov = self.full(decoded)
            self.assertEqual(d.completed_to_eof, complete, decoded)
            self.assertEqual('decoded_span_shorter_than_duration' in [c['kind'] for c in d.conflicts], conflict, decoded)
            # the tolerance decides completion only: the checked interval stays the decoded span and the remainder stays not checked
            self.assertEqual(d.intervals[0]['end_s'], decoded, decoded)
            self.assertEqual(cov['time']['unrecorded']['not_checked'], [[decoded, 12.0]], decoded)

    def test_a_decode_reaching_the_duration_leaves_nothing_unchecked_control(self):
        d, cov = self.full(12.0)
        self.assertEqual((d.completed_to_eof, cov['time']['unrecorded']['not_checked']), (True, []))

    def test_unknown_duration_or_span_failed_partial_and_bounded_requests(self):
        d, _ = self.full(12.0, duration=None)
        self.assertEqual((d.completed_to_eof, d.scope['completed']['to_end_of_file'], d.conflicts), (None, 'unknown', []))
        d, _ = self.full(None, frames=None)
        self.assertEqual((d.completed_to_eof, d.conflicts), (None, []))
        d, _ = self.full(12.0, exit_code=1, stderr='x', status='error')
        self.assertEqual(d.completed_to_eof, False)
        d, _ = self.full(12.0, completed_to_eof=False)
        self.assertEqual(d.completed_to_eof, False)
        d, _ = self.full(4.0, window_s=4, status='partial', request_unmet={'requested': 'full decode', 'completed': '4 s', 'reason': 'limit'})
        self.assertEqual(d.completed_to_eof, False)
        self.assertIn('request_not_honored', [c['kind'] for c in d.conflicts])
        # a partial result's fields may show to_end_of_file true; it is incomplete and supports nothing (v7 and C32-1 say so)
        d, _ = self.full(12.0, status='partial')
        self.assertEqual((d.execution['status'], d.scope['completed']['to_end_of_file']), ('partial', True))
        v = PQ.View([ob('e1', 'ffprobe', _probe(), source='case'), ob('t1', 'decode_sample', _full(12.0), status='partial', args={'full': True})], {}, 'movie')
        self.assertFalse(v.complete(v.obs[1]))

    def test_other_material_conflicts_are_kept(self):
        d, _ = self.full(12.0, stderr='[h264 @ 0x0] error while decoding MB 3 4')
        self.assertTrue(d.findings)
        d, _ = self.full(10.5)
        self.assertEqual([c['kind'] for c in d.conflicts], ['decoded_span_shorter_than_duration'])


# ---------------------------------------------------------------------------------------------------------------- empty tags (checker unchanged)
BOOK_CTX = {'filename': 'Book.m4b', 'expected': {'title': 'Book', 'author': 'Ann Writer'}}


def _ab(tags='ABSENT'):
    d = {'format': 'mov,mp4,m4a', 'duration_s': 12.0, 'bit_rate': '1', 'chapter_count': 0, 'chapters': [],
         'audio_streams': [{'index': 0, 'codec_name': 'aac', 'channels': 2, 'sample_rate': '44100', 'duration': '12.0'}]}
    if tags != 'ABSENT':
        d['tags'] = tags
    return d


def _live_book(part_tags):
    parts = []
    for t in part_tags:
        p = {'format': 'mp4', 'duration_s': 10.0, 'audio_streams': [{'codec': 'aac'}], 'probe': 'ok'}
        if t != 'ABSENT':
            p['tags'] = t
        parts.append(p)
    raw = {'tool': 'audiobook', 'status': 'ok', 'coverage': {'verified': ['probe'], 'not_verified': []}, 'output': {'parts': len(parts), 'parts_probed': len(parts), 'files': parts}}
    return ob('t1', 'audiobook_inspect', raw, backend='live')


class EmptyTagMaps(unittest.TestCase):
    def naming(self, o, ctx=BOOK_CTX, media='audiobook'):
        return PQ.check_named(PQ.View([o], ctx, media), 'naming_surface_defect')[:2]

    def test_absent_null_empty_false_zero_and_populated_maps(self):
        good = {'title': 'Book', 'album': 'Book', 'artist': 'Ann Writer'}
        expect = [('ABSENT', 'unmet', []), (None, 'unmet', []), ({}, 'met', ['t1:tags_empty']), ([], 'met', ['t1:tags_empty']), (False, 'unmet', []),
                  (0, 'unmet', []), (good, 'unmet', []), ({'title': 'Book'}, 'unmet', [])]
        for tags, state, refs in expect:
            self.assertEqual(self.naming(ob('t1', 'audiobook_inspect', _ab(tags), backend='local')), (state, refs), tags)

    def test_children_of_a_populated_map_are_not_synthesized(self):
        base = {'title': 'Book', 'album': 'Book', 'artist': 'Ann Writer'}
        for child, state in (('', 'met'), ([], 'met'), ([''], 'met'), (None, 'unmet'), (False, 'unmet'), (0, 'unmet')):
            got = self.naming(ob('t1', 'audiobook_inspect', _ab(dict(base, title=child)), backend='local'))
            self.assertEqual(got[0], state, child)
            self.assertNotIn('t1:tags_empty', got[1], child)
        # an empty map never yields per-field empties: only the map itself is cited
        self.assertEqual(self.naming(ob('t1', 'audiobook_inspect', _ab({}), backend='local'))[1], ['t1:tags_empty'])

    def test_an_incomplete_result_shows_nothing(self):
        for status in ('partial', 'error', 'timeout'):
            self.assertEqual(self.naming(ob('t1', 'audiobook_inspect', _ab({}), status=status, backend='local'))[0], 'unmet', status)

    def test_ffprobe_container_map_and_the_movie_control(self):
        out = {'exit_code': 0, 'stderr': '', 'format': {'format_name': 'mov', 'duration': '12.0', 'tags': {}}, 'streams': [{'index': 0, 'codec_type': 'audio', 'codec_name': 'aac'}]}
        self.assertEqual(self.naming(ob('t1', 'ffprobe', out, backend='local')), ('met', ['t1:tags_empty']))
        movie_ctx = {'filename': 'Some Movie (2001).mkv', 'expected': {'title': 'Some Movie', 'year': 2001}}
        self.assertEqual(self.naming(ob('t1', 'ffprobe', out, backend='local'), movie_ctx, 'movie')[0], 'unmet')     # movie naming surface: the file name only

    def test_multi_part_controls_and_the_recorded_disagreement(self):
        good = {'title': 'Chapter 01', 'album': 'Book', 'artist': 'Ann Writer'}
        self.assertEqual(self.naming(_live_book([good, good]))[0], 'unmet')                       # control: a well-tagged multi-part book
        self.assertEqual(self.naming(_live_book([good, dict(good, album='')]))[0], 'met')          # an empty field inside a part map is a defect (A31-13)
        # D32-1: an explicitly empty PART map is not a naming defect for the unchanged checker, unlike a container-level {}; recorded, not resolved
        for parts in ([{}], [{}, {}, {}], [good, {}, good], [None], ['ABSENT']):
            self.assertEqual(self.naming(_live_book(parts))[0], 'unmet', parts)
        self.assertIn('files[i].tags == {}', RB32.OPEN_DISAGREEMENTS_V32[0]['finding'])

    def test_the_v31_presentation_shows_the_empty_map_with_its_presence(self):
        r = EV31.render([ob('e1', 'audiobook_inspect', _ab({}), source='case')], BOOK_CTX, 'audiobook')
        body = r['reference']
        self.assertEqual((body['facts']['e1']['tags'], body['presence']['e1']['tags']), ({}, 'empty'))
        r = EV31.render([ob('e1', 'audiobook_inspect', _ab(), source='case')], BOOK_CTX, 'audiobook')
        self.assertNotIn('tags', r['reference']['facts']['e1'])                                   # absent stays absent
        r = EV31.render([ob('e1', 'audiobook_inspect', _ab(None), source='case')], BOOK_CTX, 'audiobook')
        self.assertEqual(r['reference']['presence']['e1'].get('tags'), 'null')


# ---------------------------------------------------------------------------------------------------------------- excerpts (tools v3)
class Excerpts(Tmp):
    def test_v1_and_v2_ignore_arguments_and_are_unchanged(self):
        p = self.epub([('a.xhtml', xhtml('<p>one two</p>'))])
        r2, o2 = self.call(p, {'spine': 0}, behavior='v2')
        r1, o1 = self.call(p, {}, behavior='v1')
        self.assertEqual(o1, o2)
        self.assertNotIn('mode', r2)
        self.assertNotIn('body', o2)
        r3, o3 = self.call(p, {})
        self.assertEqual(r3['mode'], 'local')
        self.assertEqual({k: v for k, v in o3.items() if k not in ('body', 'declared_toc')}, o2)       # v3 = the v2 fields plus the body view

    def test_the_fixed_default_index_excerpts_and_declared_toc(self):
        items = [('c%d.xhtml' % i, xhtml('<h2>Part %d</h2><p>%s</p>' % (i, 'x' * (300 if i == 1 else 50)))) for i in range(5)]
        p = self.epub(items, nav=[('Declared One', 'c0.xhtml'), ('Declared Two', 'c1.xhtml#s')])
        _r, o = self.call(p)
        b = o['body']
        self.assertEqual((b['extraction'], b['items_total'], len(b['index']), len(b['excerpts'])), ('xhtml-body-text-3', 5, 5, 3))
        self.assertEqual([e['spine'] for e in b['excerpts']], [0, 1, 2])
        self.assertEqual(b['excerpts'][1]['end'], ET.DEFAULT_EXCERPT_CHARS)
        self.assertEqual(b['excerpts'][1]['next_offset'], ET.DEFAULT_EXCERPT_CHARS)
        self.assertIsNone(b['excerpts'][0]['next_offset'])
        self.assertEqual(b['index'][3]['headings'], [{'level': 2, 'offset': 0, 'text': 'Part 3'}])
        self.assertEqual(o['declared_toc'], {'source': 'nav', 'document': 'OEBPS/nav.xhtml',
                                             'entries': [{'text': 'Declared One', 'member': 'OEBPS/c0.xhtml'}, {'text': 'Declared Two', 'member': 'OEBPS/c1.xhtml', 'fragment': 's'}]})
        _r, o = self.call(self.epub(items, name='fx2', ncx=[('Nc One', 'c0.xhtml')]))
        self.assertEqual((o['declared_toc']['source'], o['declared_toc']['entries']), ('ncx', [{'text': 'Nc One', 'member': 'OEBPS/c0.xhtml'}]))
        _r, o = self.call(self.epub(items, name='fx3'))
        self.assertIsNone(o['declared_toc'])

    def test_body_text_rule_head_script_style_excluded_blocks_spaced_inline_joined(self):
        x = xhtml('<h1>T<span>he</span> Title</h1><script>var a=1;</script><style>p{}</style><p>Dr<b>op</b>  cap</p><p>next&amp;more</p><br/><p>end</p>',
                  head='<title>Not Body</title><style>q{}</style>')
        text, heads = ET.body_text(x.encode())
        self.assertEqual(text, 'The Title Drop cap next&more end')
        self.assertEqual(heads, [{'level': 1, 'offset': 0, 'text': 'The Title'}])
        self.assertEqual(ET.body_text(b'<html><head><title>x</title></head></html>'), ('', []))       # no body element: empty body text

    def test_truncation_boundaries_and_continuation(self):
        n = ET.DEFAULT_EXCERPT_CHARS
        for size, nxt in ((n - 1, None), (n, None), (n + 1, n)):
            _r, o = self.call(self.epub([('a.xhtml', xhtml('<p>%s</p>' % ('y' * size)))], name='b%d' % size))
            ex = o['body']['excerpts'][0]
            self.assertEqual((ex['end'], ex['next_offset'], len(ex['text'])), (min(size, n), nxt, min(size, n)), size)
        p = self.epub([('a.xhtml', xhtml('<p>%s</p>' % ' '.join('w%04d' % i for i in range(700))))], name='long')
        whole, _h = ET.body_text(zipfile.ZipFile(p).read('OEBPS/a.xhtml'))
        got, off = [], 0
        while off is not None:
            _r, o = self.call(p, {'spine': 0, 'offset': off, 'length': ET.MAX_EXCERPT_CHARS})
            got.append(o['excerpt']['text'])
            off = o['excerpt']['next_offset']
        self.assertEqual(''.join(got), whole)                                  # continuation reconstructs the item exactly
        _r, o = self.call(p, {'spine': 0, 'offset': len(whole)})
        self.assertEqual((o['excerpt']['text'], o['excerpt']['next_offset']), ('', None))   # at the end: explicitly empty
        for bad in ({'spine': 0, 'offset': len(whole) + 1}, {'spine': 1}, {'spine': 0, 'length': ET.MAX_EXCERPT_CHARS + 1}, {'spine': 0, 'length': 0},
                    {'offset': 3}, {'spine': -1}, {'spine': 0.5}, {'spine': True}, {'spine': 0, 'at': 4}):
            r, _o = self.call(p, bad)
            self.assertEqual(r['status'], 'error', bad)
            self.assertTrue(r['output'].startswith('bad arguments: '), bad)

    def test_unicode_offsets_are_code_points(self):
        body = '<h1>Ça va ☕</h1><p>été 日本語 😀 fin</p>'
        p = self.epub([('a.xhtml', xhtml(body))])
        text, heads = ET.body_text(zipfile.ZipFile(p).read('OEBPS/a.xhtml'))
        self.assertEqual(text, 'Ça va ☕ été 日本語 😀 fin')
        i = text.index('😀')
        _r, o = self.call(p, {'spine': 0, 'offset': i, 'length': 1})
        self.assertEqual(o['excerpt']['text'], '😀')
        _r, o = self.call(p, {'spine': 0, 'offset': text.index('日'), 'length': 3})
        self.assertEqual(o['excerpt']['text'], '日本語')
        self.assertEqual(heads[0], {'level': 1, 'offset': 0, 'text': 'Ça va ☕'})

    def test_reordered_chapters_follow_the_spine_and_the_declared_toc_stays_apart(self):
        items = [('one.xhtml', xhtml('<h1>Chapter One</h1>')), ('two.xhtml', xhtml('<h1>Chapter Two</h1>'))]
        nav = [('Chapter One', 'one.xhtml'), ('Chapter Two', 'two.xhtml')]
        _r, a = self.call(self.epub(items, name='fwd', nav=nav))
        _r, b = self.call(self.epub(items, name='rev', nav=nav, spine=['two.xhtml', 'one.xhtml']))
        self.assertEqual([i['headings'][0]['text'] for i in a['body']['index']], ['Chapter One', 'Chapter Two'])
        self.assertEqual([i['headings'][0]['text'] for i in b['body']['index']], ['Chapter Two', 'Chapter One'])
        self.assertEqual(a['declared_toc'], b['declared_toc'])                  # the declaration is shown as declared, never reconciled with the body
        for o in (a, b):
            self.assertFalse(set(json.dumps(o).lower().split('"')) & set(RB.FORBIDDEN_FIELDS))

    def test_dialogue_that_resembles_a_title_is_body_text_not_a_heading(self):
        _r, o = self.call(self.epub([('a.xhtml', xhtml('<h1>Alpha Book</h1><p>“Chapter Nine: The Other Book,” she said.</p>'))]))
        self.assertEqual(o['body']['index'][0]['headings'], [{'level': 1, 'offset': 0, 'text': 'Alpha Book'}])
        self.assertIn('“Chapter Nine: The Other Book,” she said.', o['body']['excerpts'][0]['text'])

    def test_absent_unavailable_and_failed_excerpts_never_reconstruct_text(self):
        p = self.epub([('a.xhtml', xhtml('<p>real body</p>'))])
        rec_case = {'replay': [], 'evidence': [{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': {'spine_heads': ['recorded head words'], 'dc_title': ['X']}}]}
        r, _o = self.call(None, {'spine': 0}, kind='pinned', **rec_case)
        self.assertEqual(r['status'], 'unavailable')
        self.assertNotIn('recorded head words', r['output'])
        r, _o = self.call(None, {'spine': 0}, kind='none')
        self.assertEqual(r['status'], 'unavailable')
        r, _o = self.call(os.path.join(self.dir, 'missing.epub'), {'spine': 0})
        self.assertEqual(r['status'], 'unavailable')
        ctx = self.ctx(p)
        ctx.evidence_mode = 'live'
        r = T.call_tool(ctx, 'epub_inspect', {'spine': 0})
        self.assertEqual(r['status'], 'unavailable')
        self.assertNotIn('real body', r['output'])
        bad = os.path.join(self.dir, 'damaged.epub')
        Path(bad).write_bytes(Path(p).read_bytes()[:200])
        r, o = self.call(bad, {'spine': 0})
        self.assertEqual((r['status'], o['status'], o['stage']), ('error', 'error', 'zip_open'))
        _r, o = self.call(self.epub([('a.xhtml', xhtml(''))], name='emptybody'))
        self.assertEqual((o['body']['index'][0]['characters'], o['body']['excerpts'][0]['text']), (0, ''))

    def test_excerpts_come_from_the_file_only_never_from_labels_or_the_catalog(self):
        p = self.epub([('a.xhtml', xhtml('<h1>Body Heading</h1><p>words</p>'))])
        base = {'id': 'w22-x', 'tools_available': ['epub_inspect'], 'evidence': []}
        outs = []
        for extra in ({'context': {}}, {'context': {'title': 'Zz Label', 'expected': {'title': 'Zz Label', 'toc': ['Zz Toc']}}, 'truth': {'class': 'identity_mismatch'},
                                        'supported_actions': ['blocklist_and_search'], 'notes': 'zq annotation'}):
            ctx = T.Context(dict(base, **extra), T.Fixture('local', path=p), self.dir, tools_behavior='v3')
            outs.append([T.call_tool(ctx, 'epub_inspect', a)['output'] for a in ({}, {'spine': 0, 'offset': 2})])
            self.assertEqual(T.capability(ctx, 'epub_inspect')['excerpts'], T.EXCERPT_CAPABILITY)
        self.assertEqual(outs[0], outs[1])

    def test_capabilities_say_when_excerpts_are_not_available(self):
        case = {'id': 'w22-x', 'tools_available': ['epub_inspect'], 'context': {}, 'evidence': [{'id': 'e1', 'tool': 'epub_inspect', 'output': {}}]}
        pinned = T.Context(case, T.Fixture('pinned'), self.dir, tools_behavior='v3')
        self.assertTrue(T.capability(pinned, 'epub_inspect')['excerpts'].startswith('not_available'))
        v2 = T.Context(case, T.Fixture('pinned'), self.dir, tools_behavior='v2')
        self.assertNotIn('excerpts', T.capability(v2, 'epub_inspect'))


# ---------------------------------------------------------------------------------------------------------------- statement kinds and prior records
def prior(method='ABSENT', titles=('Other Work',), oid='e1'):
    out = {'observed': {'content_titles': list(titles), 'catalog_title': 'Alpha Book'}}
    if method != 'ABSENT':
        out['evidence_method'] = method
    return ob(oid, 'prior_record', out, source='case')


CAT = {'title': 'Alpha Book', 'filename': 'Alpha Book.epub', 'expected': {'title': 'Alpha Book', 'author': 'A. Writer'}}


class PriorRecordProvenance(unittest.TestCase):
    def view(self, o):
        r = EV31.render([o], CAT, 'epub')['reference']
        return r['kinds']['e1'], r['report']['e1'], r['facts']['e1']

    def test_the_kind_comes_only_from_the_stated_method(self):
        for method, kind in (('OPF metadata', 'report_declaration'), ('OCR of the title cards', 'report_content'), ('md5 checksum', 'report_hash'),
                             ('no OCR performed', 'report_unknown'), ('OCR unavailable', 'report_unknown'), ('manual review', 'report_unknown'),
                             ('ABSENT', 'report_unknown'), (None, 'report_unknown'), ('', 'report_unknown'), ('OPF metadata read', 'report_declaration')):
            kinds, report, facts = self.view(prior(method))
            self.assertEqual((kinds['provenance'], kinds['fields'], report['kind']), ('reported', {'observed': kind}, kind), method)
            self.assertEqual(facts['observed'], {'content_titles': ['Other Work'], 'catalog_title': 'Alpha Book'}, method)     # values kept as stated
            if method == 'ABSENT':
                self.assertEqual((report['method_presence'], 'method' in report), ('absent', False))
            else:
                self.assertEqual(report['method'], method)
        _k, report, _f = self.view(prior('OPF metadata read'))
        self.assertEqual(report['matched'], ['report_declaration', 'report_content'])        # D32-2: the mixed method is shown, the frozen rule kept

    def test_paired_method_only_changes_move_the_checker_level_and_nothing_else(self):
        levels = {}
        for method in ('OCR of the title cards', 'OPF metadata', 'no OCR performed'):
            obs = [prior(method)]
            levels[method] = PQ.View(obs, CAT, 'epub').identity()[0]
        self.assertEqual(levels, {'OCR of the title cards': 'contradicted_by_content', 'OPF metadata': 'contested', 'no OCR performed': 'uncontradicted'})
        a = EV31.render([prior('OCR of the title cards')], CAT, 'epub')['reference']
        b = EV31.render([prior('OPF metadata')], CAT, 'epub')['reference']
        for k in ('items', 'alerts', 'open_total'):
            self.assertEqual(a[k], b[k], k)

    def test_reported_content_never_becomes_an_observation_of_this_run(self):
        kinds, _r, _f = self.view(prior('OCR of the title cards'))
        self.assertEqual(kinds['provenance'], 'reported')
        self.assertNotEqual(FX.provenance(prior('OCR of the title cards')), 'observed')


class ContradictoryMetadataAndBody(Tmp):
    def obs_pair(self, title, heading):
        p = self.epub([('a.xhtml', xhtml('<h1>%s</h1><p>words</p>' % heading))], name='m' + str(abs(hash((title, heading)))), title=title)
        _r, o = self.call(p)
        inspect = ob('t1', 'epub_inspect', o, backend='local')
        excerpt_out = self.call(p, {'spine': 0})[1]
        return [inspect, ob('t2', 'epub_inspect', excerpt_out, backend='local')]

    def test_body_headings_are_observations_never_an_automatic_verdict(self):
        # metadata agrees, body heading names another work: the checker is unchanged by the excerpt (judged, not computed)
        obs = self.obs_pair('Alpha Book', 'Beta Volume')
        with_ex = PQ.View([EV31.internal(o) for o in obs], CAT, 'epub').identity()[0]
        without = PQ.View([EV31.internal(obs[0])], CAT, 'epub').identity()[0]
        self.assertEqual(with_ex, without)
        r = EV31.render([o for o in obs], CAT, 'epub')['reference']
        self.assertEqual(r['kinds']['t1']['fields']['title'], 'declaration')
        self.assertEqual(r['kinds']['t1']['fields']['body'], 'content')
        self.assertEqual(r['kinds']['t2'], {'provenance': 'observed', 'fields': {'excerpt': 'content'}})
        self.assertFalse(set(json.dumps(r).split('"')) & set(RB.FORBIDDEN_FIELDS))
        # metadata disagrees, body agrees: the checker reads the v2 spine heads (content) as before, and the excerpt changes nothing
        obs = self.obs_pair('Beta Volume', 'Alpha Book')
        with_ex = PQ.View([EV31.internal(o) for o in obs], CAT, 'epub').identity()[0]
        self.assertEqual(with_ex, PQ.View([EV31.internal(obs[0])], CAT, 'epub').identity()[0])
        heads_only = dict(json.loads(obs[0]['output']), spine_heads=[])      # control: without the spine heads only the declaration speaks
        self.assertEqual(PQ.View([ob('t1', 'epub_inspect', heads_only, backend='local')], CAT, 'epub').identity()[0], 'contested')

    def test_an_explicit_excerpt_is_a_reading_never_a_package_check(self):
        obs = self.obs_pair('Alpha Book', 'Alpha Book')
        an = EV31.analyze([obs[1]], CAT, 'epub')
        d = an['items']['t2']
        self.assertEqual((d.obs['tool'], d.integrity, d.package, d.unresolved), ('epub_text', 'not_integrity', None, []))
        self.assertEqual(PQ.check_named(PQ.View([EV31.internal(obs[1])], CAT, 'epub'), 'positively_clean')[0], 'unmet')
        an = EV31.analyze([obs[0]], CAT, 'epub')
        self.assertIn(EV31.BODY_UNREAD, an['items']['t1'].unresolved)
        self.assertFalse([u for u in an['items']['t1'].unresolved if 'spine heads' in u])


# ---------------------------------------------------------------------------------------------------------------- runs: counterfactuals, leaks, pages, six calls
def epub_items(tail_text, head_count=3):
    """Spine items whose shown part (characters, headings, the first DEFAULT_EXCERPT_CHARS) is fixed and whose unshown tail varies."""
    fixed = 'aaaa ' * (ET.DEFAULT_EXCERPT_CHARS // 5)     # words, so the v2 six-word spine heads stay inside the fixed part
    return [('c%d.xhtml' % i, xhtml('<h1>Part %d</h1><p>%s%s</p>' % (i, fixed, tail_text if i == 1 else 'b' * len(tail_text)))) for i in range(head_count)]


class UncalledSwaps(unittest.TestCase):
    def run_pair(self, script, tails):
        out = []
        for tail in tails:
            d = tempfile.mkdtemp(prefix='mrh-w22-')
            case = book_case(d, items=epub_items(tail), cid='w22-swap')
            ts = th.TempSuite([case])
            rec, ad = ev2h.scripted_run(case, ts, [json.dumps(x) for x in script], prompt='v7', evidence_format='v3.1-format', guards='v3', which=th.NO_BINARIES)
            out.append((rec, ad))
        return out

    def test_every_prefix_is_identical_until_the_swapped_payload_is_called(self):
        same_len_tails = ('Q' * 400, 'R' * 400)            # the same characters and headings; different unshown text
        script = [tc('epub_inspect'), tc('epub_inspect', {'spine': 0, 'offset': 0, 'length': 5}), tc('epub_inspect', {'spine': 1, 'offset': ET.DEFAULT_EXCERPT_CHARS}), d3()]
        (ra, aa), (rb, ab) = self.run_pair(script, same_len_tails)
        self.assertEqual(len(aa.full), len(ab.full))
        for k in range(3):                                   # the requests before the third call's result are byte-identical
            self.assertEqual(aa.full[k], ab.full[k], k)
        self.assertNotEqual(aa.full[3], ab.full[3])          # control: the swapped tail is shown once it is called
        self.assertEqual(ra['evidence_format']['capabilities'], rb['evidence_format']['capabilities'])

    def test_the_first_message_does_not_read_the_epub(self):
        (ra, aa), (rb, ab) = self.run_pair([d3()], ('x' * 10, 'completely different body text'))
        self.assertEqual(aa.full[0], ab.full[0])


class LeaksPagesAndSixCalls(unittest.TestCase):
    def test_full_v7_requests_carry_no_label_provenance_or_case_identity(self):
        d = tempfile.mkdtemp(prefix='mrh-w22-')
        case = book_case(d, evidence=[{'id': 'e1', 'tool': 'prior_record', 'args': {}, 'status': 'ok',
                                       'output': json.dumps({'evidence_method': 'OPF metadata', 'observed': {'content_titles': ['Other']}})}])
        ts = th.TempSuite([case])
        rec, ad = ev2h.scripted_run(case, ts, [json.dumps(tc('epub_inspect')), json.dumps(tc('epub_inspect', {'spine': 0, 'offset': 10})), json.dumps(d3())],
                                    prompt='v7', evidence_format='v3.1-format', guards='v3', which=th.NO_BINARIES)
        self.assertIsNone(rec.get('error'))
        wire = json.dumps(ad.full, ensure_ascii=False)
        for s in ('zxq', case['id'], 'w22-book.epub', 'epub_text', 'provenance 71', 'truth'):
            self.assertNotIn(s, wire, s)

    def test_a_long_excerpt_is_paginated_and_the_page_fetch_costs_a_call(self):
        d = tempfile.mkdtemp(prefix='mrh-w22-')
        case = book_case(d, items=[('a.xhtml', xhtml('<p>%s</p>' % ('😀' * 1500)))])
        ts = th.TempSuite([case])
        rec, ad = ev2h.scripted_run(case, ts, [json.dumps(tc('epub_inspect', {'spine': 0, 'length': ET.MAX_EXCERPT_CHARS}))], prompt='v7', evidence_format='v3.1-format',
                                    which=th.NO_BINARIES, tool_output_bytes=2560)
        first = json.loads(ad.full[-1]['messages'][-1]['content'].split('\n')[0])
        page = first['output']['page']
        self.assertGreater(page['of'], 1)
        cursor = page['next']
        rec, ad = ev2h.scripted_run(case, ts, [json.dumps(tc('epub_inspect', {'spine': 0, 'length': ET.MAX_EXCERPT_CHARS})), json.dumps(tc('epub_inspect', {'cursor': cursor})),
                                               json.dumps(d3())], prompt='v7', evidence_format='v3.1-format', which=th.NO_BINARIES, tool_output_bytes=2560)
        self.assertEqual([c['tool'] for c in rec['tool_calls']], ['epub_inspect', 'page'])
        second = json.loads(ad.full[-1]['messages'][-1]['content'].split('\n')[0])
        self.assertEqual(second['tool_calls_remaining'], 4)
        for m in ad.full[-1]['messages']:
            if m['role'] == 'user':
                self.assertLessEqual(len(m['content'].split('\n')[0].encode()), 2560)

    def test_first_message_pagination_reconstructs_recorded_excerpts_with_their_provenance(self):
        rec_out = {'status': 'ok', 'spine_items': 2, 'dc_title': ['Alpha Book'], 'spine_heads': ['x'],
                   'body': {'extraction': ET.RULE_ID, 'items_total': 2, 'index': [{'spine': i, 'member': 'm%d' % i, 'characters': 900, 'headings': []} for i in range(2)],
                            'excerpts': [{'spine': i, 'member': 'm%d' % i, 'offset': 0, 'end': 280, 'item_characters': 900, 'text': 'ü' * 280, 'next_offset': 280} for i in range(2)]},
                   'declared_toc': None}
        obs = [ob('e1', 'epub_inspect', rec_out, source='case'), prior('OPF metadata', oid='e2')]
        for budget in (8192, 4096, 2560):
            r = EV31.render(obs, CAT, 'epub', ('epub_inspect',), budget=budget)
            self.assertEqual(FX.reassemble(r['pages']), r['reference'], budget)
            self.assertEqual(r['reference']['kinds']['e1']['provenance'], 'recorded')          # a recorded excerpt keeps its source provenance
            self.assertTrue(all(b <= budget for b in r['page_bytes']), (budget, r['page_bytes']))

    def test_six_call_accounting_with_excerpts(self):
        d = tempfile.mkdtemp(prefix='mrh-w22-')
        case = book_case(d)
        ts = th.TempSuite([case])
        calls = [tc('epub_inspect', {'spine': 0, 'offset': i * 10, 'length': 5}) for i in range(6)] + [tc('epub_inspect', {'spine': 0})]
        rec, ad = ev2h.scripted_run(case, ts, [json.dumps(x) for x in calls], prompt='v7', evidence_format='v3.1-format', which=th.NO_BINARIES)
        self.assertEqual(len(rec['tool_calls']), 6)
        self.assertTrue(rec['forced'])
        rem = [json.loads(m['content'].split('\n')[0])['tool_calls_remaining'] for m in ad.full[-1]['messages'][1:] if m['role'] == 'user']
        self.assertEqual(rem, [5, 4, 3, 2, 1, 0])
        self.assertIn(P.BUDGET_MESSAGE, ad.full[-1]['messages'][-1]['content'])


class CompleteV7RequestsOfBothPublicSuites(unittest.TestCase):
    """Every case of dev-v1 and dev-v1.1 through the real runner under v7 + v3.1-format (replay, no binaries): the first message and the decision, and for every
    case that offers epub_inspect also the default call and one explicit excerpt.  Every request passes the leak guard (a LeakError would be a harness crash),
    carries no hidden case field, and every message fits 8192 bytes.  The system-prompt-plus-first-message token estimate is RECORDED in docs/devc7-sizes.json,
    not asserted: v7 is 2.7 KB longer than v6 (a reported cost, see the CHANGELOG)."""

    @classmethod
    def setUpClass(cls):
        import test_v6 as V6
        cls.V6 = V6
        cls.rows = []
        for d in V6.need_both_suites():
            for case in V6.suite_cases(d):
                replies = [V6.ESCALATE]
                if 'epub_inspect' in (case.get('tools_available') or []):
                    replies = [json.dumps(tc('epub_inspect')), json.dumps(tc('epub_inspect', {'spine': 0, 'offset': 0, 'length': ET.MAX_EXCERPT_CHARS})), V6.ESCALATE]
                ad = V6.Capture('scripted-model', replies)
                rec = R.run_case(case, 'sha', ad, d, tempfile.mkdtemp(prefix='mrh-w22-'), run_id='w22-leak', prompt_version='v7', evidence_format='v3.1-format',
                                 guards='v3', replay='auto', which=th.NO_BINARIES, tool_output_bytes=8192)
                cls.rows.append((case, rec, ad))

    def test_no_request_leaks_a_hidden_case_field_and_nothing_crashed(self):
        self.assertEqual(len(self.rows), 146)
        epub_calls = 0
        fail_closed = []
        for case, rec, ad in self.rows:
            err = rec.get('error')
            if err is not None:
                # A refusal is a harness error kept in the denominators: the model answered the earlier turns (here its tool call), and the request that would
                # carry the tool result is not sent.  Under leakguard-media-1 only a true identifier in text read from the media is refused (none in the
                # public suites when this was written; at 3327a201 the legacy check refused 4 runs on a family word and on the provenance value "new").
                self.assertEqual((err['kind'], err['leak_guard']), ('harness_crash', True), case['id'])
                self.assertIn('epub_inspect', case.get('tools_available') or [], case['id'])
                self.assertIn('text read from the media', err['message'], case['id'])
                fail_closed.append(case['id'])
                continue
            text = json.dumps([s['messages'] for s in ad.sent], ensure_ascii=False)
            self.assertNotIn(case['id'], text)
            for k in ('truth', 'supported_actions', 'solvable', 'accepted_classes', 'family', 'provenance', 'inject_tool_failure', 'outcome_step'):
                self.assertNotIn('"%s"' % k, text, (case['id'], k))
            ref = (case.get('truth') or {}).get('ref')
            if isinstance(ref, str) and len(ref) >= 6:
                self.assertNotIn(ref, text, case['id'])
            for f in RB.FORBIDDEN_FIELDS:
                self.assertNotIn('"%s":' % f, text, (case['id'], f))
            self.assertNotIn('epub_text', text, case['id'])                  # the internal reading name never reaches the model
            for s_ in ad.sent:
                self.assertEqual(s_['system'], P.get_prompt('v7')['text'])
            for m in rec['evidence_format']['messages']:
                self.assertTrue(all(b <= 8192 for b in m['bytes']), (case['id'], m))
            epub_calls += sum(1 for c in rec['tool_calls'] if c['tool'] == 'epub_inspect')
        self.assertGreaterEqual(epub_calls, 34 - len(fail_closed))     # 17 epub_inspect cases per suite; a fail-closed run stops after its first call
        self.assertEqual(fail_closed, [])                               # under leakguard-media-1 (4 runs refused at 3327a201)
        print('\nv7 suite-wide: %d runs, %d fail closed on the leak guard (EPUB body text naming a hidden token)' % (len(self.rows), len(fail_closed)))


if __name__ == '__main__':
    unittest.main()
