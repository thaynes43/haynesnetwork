"""dev-c7 review round (AUDIT-ASTRA-27 and the Opus review of PR #1028 at 3327a201): one paired regression per fix, each failing at 3327a201.  Synthetic,
generic EPUBs and scripted replies only; no model, no network, no dev-suite label or excerpt.

R1  text read from the media is never rewritten by redaction; locators are still aliased; continuation reconstructs the item exactly.
R2  leakguard-media-1 (format v3.1-format only): ordinary, truth-class and already-visible words in media text are not refused; true identifiers still are;
    the legacy check is unchanged.
R3  navigation regions and navigation documents inside the spine keep their navigation meaning, in the default view and in explicit excerpts.
R4  the legacy spine heads are labelled legacy_mixed and establish no content identity under v3.1-format; the unchanged checker still reads them (D32-3).
R5  a namespace-prefixed x:body is read; the size script sizes whole conversations with the output reserve.
R6  the -2 digest covers the extractor code; -1 stays frozen."""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import ev2h
import th
import test_devc7 as D
from ev2h import tc
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import evidence_v31 as EV31
from media_repair_harness import leakguard
from media_repair_harness import tools as T
from media_repair_harness.experimental.contract_v3 import prereq as PQ

xhtml, build_epub, d3 = D.xhtml, D.build_epub, D.d3
NAVX = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>%s</body></html>'


def call(case, args=None, behavior='v3'):
    ctx = T.Context(case, T.Fixture('local', path=case['fixture']['locator']), tempfile.mkdtemp(prefix='mrh-w22r-'), tools_behavior=behavior)
    r = T.call_tool(ctx, 'epub_inspect', args or {})
    return r, json.loads(r['output'])


def epub_case(items, name, cid='w22r-case', title='Some Title', filename='Expected Book.epub', **kw):
    d = tempfile.mkdtemp(prefix='mrh-w22r-')
    path = build_epub(os.path.join(d, name + '.epub'), items, **kw)
    case = ev2h.case_with([], tools=('epub_inspect',), cid=cid, media='epub')
    case['context'].update(title=title, filename=filename, expected={'title': title})
    case['fixture'] = {'kind': 'local', 'locator': path}
    return case


def v7_run(case, replies):
    ts = th.TempSuite([case])
    return ev2h.scripted_run(case, ts, [json.dumps(r) for r in replies], prompt='v7', evidence_format='v3.1-format', guards='v3', which=th.NO_BINARIES)


class R1RedactionNeverRewritesMediaText(unittest.TestCase):
    def test_a_body_word_that_collides_with_the_fixture_name_is_shown_as_read(self):
        case = epub_case([('Secret.xhtml', xhtml('<h1>Secret</h1>'))], 'Secret')
        _r, o = call(case)
        ex = o['body']['excerpts'][0]
        self.assertEqual((ex['text'], ex['end'], ex['item_characters']), ('Secret', 6, 6))           # at 3327a201: "Expected Book" with end 6
        self.assertEqual(o['body']['index'][0]['headings'][0]['text'], 'Secret')
        self.assertEqual(o['spine_heads'], ['Head Title Secret'])                                    # the legacy heads are media text too
        self.assertNotIn('Secret', ex['member'])                                                     # paired: a LOCATOR is still aliased
        _r, o = call(case, {'spine': 0})
        self.assertEqual(o['excerpt']['text'], 'Secret')
        _r, o2 = call(case, behavior='v2')                                                           # legacy control: v2 redacts the whole output, as before
        self.assertNotIn('Secret', json.dumps(o2))

    def test_continuation_reconstructs_an_item_full_of_colliding_words(self):
        words = ' '.join('Secret word%d' % i for i in range(400))
        case = epub_case([('a.xhtml', xhtml('<p>%s</p>' % words))], 'Secret')
        got, off = [], 0
        while off is not None:
            _r, o = call(case, {'spine': 0, 'offset': off, 'length': 1200})
            got.append(o['excerpt']['text'])
            off = o['excerpt']['next_offset']
        self.assertEqual(''.join(got), words)

    def test_the_genuine_identifier_is_refused_by_the_guard_not_rewritten(self):
        case = epub_case([('a.xhtml', xhtml('<h1>Secret</h1><p>text</p>'))], 'Secret')
        rec, ad = v7_run(case, [tc('epub_inspect'), d3()])
        self.assertEqual((rec['error']['kind'], rec['error']['leak_guard']), ('harness_crash', True))
        self.assertIn('fixture_stem', rec['error']['message'])
        self.assertIn('text read from the media', rec['error']['message'])
        self.assertEqual((len(rec['turns']), len(rec['tool_calls']), len(ad.full)), (1, 1, 1))   # the model answered turn 1; the tool-result request was not sent


class R2MediaLeakRule(unittest.TestCase):
    def guarded_case(self, body, cid='w22r-guard-01'):
        case = epub_case([('a.xhtml', xhtml('<h1>The Lamplighter</h1><p>%s</p>' % body))], 'q9fixture', cid=cid, title='The Lamplighter')
        case['family'] = 'lamplighter'
        case['truth'] = {'class': 'healthy', 'source': 'construction', 'ref': 'zz-ref-q9'}
        case['provenance'] = 'new'
        return case

    def test_ordinary_truth_class_and_visible_words_in_media_text_are_not_refused(self):
        case = self.guarded_case('She knew the lamplighter was healthy and new to the town.')
        rec, _ad = v7_run(case, [tc('epub_inspect'), tc('epub_inspect', {'spine': 0}), d3()])
        self.assertIsNone(rec.get('error'), rec.get('error'))                                      # at 3327a201: LeakError (family, truth_class, provenance)
        self.assertEqual(len(rec['tool_calls']), 2)

    def test_true_identifiers_in_media_text_are_still_refused(self):
        for body, kind in (('see w22r-guard-01 here', 'case_id'), ('from suite/fixtures/q9fixture.epub', 'fixture_name'),
                           ('copied from media/lib/book@host.example', 'provenance_path')):
            case = self.guarded_case(body)
            if kind == 'provenance_path':
                case['provenance'] = 'reused from media/lib/book@host.example'
            rec, _ad = v7_run(case, [tc('epub_inspect'), d3()])
            self.assertIsNotNone(rec.get('error'), kind)
            self.assertIn(kind, rec['error']['message'], kind)

    def test_short_tokens_are_word_bounded_and_skipped_like_check_system(self):
        case = self.guarded_case('x')
        kinds = [k for k, _rx in leakguard.media_tokens(dict(case, id='ab-1'))]
        self.assertNotIn('case_id', kinds)                                                             # shorter than SYSTEM_MIN_LEN
        rx = dict(leakguard.media_tokens(case))['fixture_stem']
        self.assertIsNone(rx.search('xq9fixturez'))
        self.assertIsNotNone(rx.search('a q9fixture b'))

    def test_harness_text_keeps_the_legacy_check_and_the_legacy_guard_is_unchanged(self):
        case = self.guarded_case('plain words')
        msg = [{'role': 'user', 'content': json.dumps({'open': [{'text': 'the item is healthy'}], 'facts': {'excerpt': {'text': 'plain words'}}})}]
        with self.assertRaises(leakguard.LeakError):            # harness-written text with a truth-class word: still refused
            leakguard.check_messages_media(case, msg, ['plain words'])
        media_only = [{'role': 'user', 'content': json.dumps({'facts': {'excerpt': {'text': 'the lamplighter was healthy'}}})}]
        leakguard.check_messages_media(case, media_only, ['the lamplighter was healthy'])        # media text: not refused
        with self.assertRaises(leakguard.LeakError):            # the legacy check on the same message: unchanged, still refuses
            leakguard.check_messages(case, media_only)


class R3NavigationKeepsItsMeaning(unittest.TestCase):
    def test_nav_only_and_mixed_documents_in_the_spine(self):
        nav_doc = NAVX % '<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="b.xhtml">Chapter One</a></li></ol></nav>'
        mixed = xhtml('<h1>Real Story</h1><div role="doc-toc"><div><h2>Toc Head</h2></div><p>Toc entry</p></div><p>Narrative goes on.</p>'
                      '<section epub:type="landmarks"><a href="b.xhtml">Start</a></section><p>End.</p>')
        case = epub_case([('nav.xhtml', nav_doc), ('b.xhtml', mixed)], 'q9nav', nav=None)
        # put the nav document into the manifest as the navigation document and keep it in the spine
        path = case['fixture']['locator']
        import zipfile
        import io
        z = zipfile.ZipFile(path)
        files = {n: z.read(n) for n in z.namelist()}
        files['OEBPS/c.opf'] = files['OEBPS/c.opf'].replace(b'href="nav.xhtml" media-type="application/xhtml+xml"', b'href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as w:
            w.writestr(zipfile.ZipInfo('mimetype'), files.pop('mimetype'))
            for n, b in files.items():
                w.writestr(n, b)
        Path(path).write_bytes(buf.getvalue())
        _r, o = call(case)
        idx, ex = o['body']['index'], o['body']['excerpts']
        self.assertEqual((idx[0]['characters'], idx[0]['headings'], idx[0].get('navigation_document')), (0, [], True))
        self.assertGreater(idx[0]['navigation_characters'], 0)
        self.assertEqual(ex[0]['text'], '')                                                           # at 3327a201: "Contents Chapter One"
        self.assertEqual(ex[1]['text'], 'Real Story Narrative goes on. End.')
        self.assertEqual([h['text'] for h in idx[1]['headings']], ['Real Story'])                    # at 3327a201: "Toc Head" too
        self.assertEqual([e['text'] for e in o['declared_toc']['entries']], ['Chapter One'])         # the declaration is kept, as a declaration
        for args in ({'spine': 0}, {'spine': 1}):
            _r, o = call(case, args)
            self.assertNotIn('Chapter One', o['excerpt']['text'])
            self.assertNotIn('Toc', o['excerpt']['text'])
            self.assertNotIn('Start', o['excerpt']['text'])


class R4LegacyHeadsAreNotContent(unittest.TestCase):
    CAT = {'title': 'Expected Book', 'filename': 'Expected Book.epub', 'expected': {'title': 'Expected Book'}}

    def test_a_head_title_does_not_verify_identity_under_v31(self):
        case = epub_case([('a.xhtml', xhtml('<h1>Different Volume</h1><p>words</p>', head='<title>Expected Book</title>'))], 'q9heads', title='Expected Book')
        _r, o = call(case)
        self.assertEqual(o['spine_heads'], ['Expected Book Different Volume words'])
        obs = [EV2.make_observation('t1', 'epub_inspect', {}, 'ok', json.dumps(o), 'local', 'tool')]
        legacy = PQ.View(obs, self.CAT, 'epub').identity()[0]
        self.assertEqual(legacy, 'content_verified')                                                 # D32-3: the unchanged checker reads the head title as content
        tool_calls = [{'id': 't1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'raw_output': json.dumps(o), 'mode': 'local'}]
        v31 = PQ.View(EV31.shown_observations([], tool_calls), self.CAT, 'epub').identity()[0]
        self.assertNotEqual(v31, 'content_verified')                                                 # at 3327a201: content_verified
        r = EV31.render(obs, self.CAT, 'epub')['reference']
        self.assertEqual(r['kinds']['t1']['fields']['spine_heads'], 'legacy_mixed')                  # at 3327a201: content
        self.assertEqual(r['facts']['t1']['spine_heads'], ['Expected Book Different Volume words'])   # still shown as read


class R5PrefixedBodyAndConversationSizing(unittest.TestCase):
    def test_a_namespace_prefixed_body_is_read(self):
        doc = ('<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:head><x:title>H</x:title></x:head><x:body><x:h1>Prefixed Title</x:h1>'
               '<x:p>Body words</x:p></x:body></x:html>')
        case = epub_case([('a.xhtml', doc)], 'q9prefix')
        _r, o = call(case)
        self.assertEqual(o['body']['excerpts'][0]['text'], 'Prefixed Title Body words')            # at 3327a201: empty
        self.assertEqual(o['body']['index'][0]['headings'][0]['text'], 'Prefixed Title')

    def test_the_size_script_sizes_whole_conversations_with_the_output_reserve(self):
        sys.path.insert(0, str(th.COMPONENT / 'scripts'))
        import devc7_sizes as S                                                                     # at 3327a201: no conversation sizing
        case = epub_case([('a.xhtml', xhtml('<p>%s</p>' % ('word ' * 900)))], 'q9size')
        ts = th.TempSuite([case])
        one, n1, err1 = S.conversation(case, ts.root, 8192, [{}])
        more, n2, err2 = S.conversation(case, ts.root, 8192, [{}, {'spine': 0, 'offset': 0, 'length': 1200}])
        self.assertEqual((n1, n2, err1, err2), (2, 3, None, None))
        self.assertGreater(more, one)
        self.assertGreaterEqual(one, S.OUTPUT_RESERVE_TOKENS + len(D.P.get_prompt('v7')['text']) // 3)


class R6DigestCoversTheCode(unittest.TestCase):
    def test_the_rule_2_digest_is_rules_plus_source_and_rule_1_is_frozen(self):
        from media_repair_harness import epub_text as E1
        from media_repair_harness import epub_text_v2 as E2                                          # at 3327a201: no rule -2
        h = hashlib.sha256(json.dumps(E2.RULES, sort_keys=True, separators=(',', ':')).encode())
        h.update(b'\0')
        h.update(Path(E2.__file__).read_bytes())
        self.assertEqual(E2.rules_digest(), h.hexdigest())
        self.assertEqual(E2.rules_digest(), RULE2_SHA)
        self.assertEqual((E1.RULE_ID, E1.rules_digest()), ('xhtml-body-text-1', D.EXCERPT_RULES_SHA))
        self.assertEqual(E2.RULE_ID, 'xhtml-body-text-2')
        self.assertEqual(EV31.ET.RULE_ID, 'xhtml-body-text-2')
        for k in ('limits', 'block_tags', 'skip_tags', 'heading_tags'):
            self.assertEqual(E2.RULES[k], E1.RULES[k], k)                                            # the other rules are unchanged


RULE2_SHA = 'f27790846fe9615dcf163fef04a645ae0c73dcba678bc49fbcebba9396fc22c8'   # xhtml-body-text-2: RULES plus the module source

if __name__ == '__main__':
    unittest.main()
