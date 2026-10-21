"""dev-c7 second review round (AUDIT-ASTRA-28 and the Opus review of PR #1028 at b94d80f4): one paired regression per fix, each failing at b94d80f4.
Synthetic, generic EPUBs and scripted replies only; no model, no network, no dev-suite label or excerpt.

S1  leakguard-media-2: planted non-prose hidden values in media text are refused (truth class and action with `_`, case-id stems, hyphenated families, short
    ids, the truth-reference sentence, a case id split across two adjacent excerpts); harness-written text is never exempted because the media contains it;
    plain words in ordinary prose still pass; the legacy check is unchanged.
S2  recorded EPUB evidence (e1) is delivered as recorded (never rewritten into the display name) and goes through the same leak check.
S3  rule xhtml-body-text-3 resolves the namespace of semantic attributes (ops:type bound to the EPUB namespace is epub:type); -2 stays frozen.
S4  the size script has page-fetch trajectories and states the v7 context floor."""
import json
import os
import sys
import tempfile
import unittest

import ev2h
import th
import test_devc7 as D
import test_devc7_review as RV
from ev2h import tc
from media_repair_harness import leakguard
from media_repair_harness import run as R
from media_repair_harness import tools as T

xhtml, d3, epub_case, v7_run, call = D.xhtml, D.d3, RV.epub_case, RV.v7_run, RV.call


def planted(body, cid='w22s-guard-01', family='lamplighter', truth='healthy', ref='zz-ref-q9', provenance='new', actions=('none',)):
    case = epub_case([('a.xhtml', xhtml('<h1>The Lamplighter</h1><p>%s</p>' % body))], 'q8fixture', cid=cid, title='The Lamplighter')
    case.update(family=family, provenance=provenance, supported_actions=list(actions))
    case['truth'] = {'class': truth, 'source': 'construction', 'ref': ref}
    return case


class S1MediaRule2(unittest.TestCase):
    def refused(self, case, replies=None):
        rec, _ad = v7_run(case, replies or [tc('epub_inspect'), d3()])
        return rec.get('error')

    def test_planted_non_prose_values_in_media_text_are_refused(self):
        for case in (planted('it was an identity_mismatch all along', truth='identity_mismatch'),
                     planted('then blocklist_and_search it', actions=('blocklist_and_search',)),
                     planted('the epub-identity shelf', cid='epub-identity-042'),
                     planted('a forbidden-identity note', cid='forbidden-identity-42'),
                     planted('from the lr-epub series', family='lr-epub'),
                     planted('see ab-1 here', cid='ab-1'),
                     planted('the planted title is wrong here, she said', ref='the planted title is wrong here')):
            err = self.refused(case)
            self.assertIsNotNone(err, case['id'])                                                     # at b94d80f4: delivered
            self.assertIn('leakguard-media-2', err['message'], case['id'])

    def test_an_id_split_across_two_adjacent_excerpts_is_reassembled_and_refused(self):
        body = 'words before forbidden-identity-42 and after'
        case = planted(body, cid='forbidden-identity-42')
        _r, o = call(case, {'spine': 0, 'offset': 0, 'length': 1})
        start = ('The Lamplighter ' + body).index('identity-42')
        replies = [tc('epub_inspect', {'spine': 0, 'offset': 0, 'length': start}), tc('epub_inspect', {'spine': 0, 'offset': start, 'length': 40}), d3()]
        rec, ad = v7_run(case, replies)
        self.assertEqual([c['status'] for c in rec['tool_calls']], ['ok', 'ok'])
        self.assertIsNotNone(rec.get('error'))                                                       # at b94d80f4: both excerpts reached the model
        self.assertEqual(len(ad.full), 2)                                                            # the request carrying the second half was not sent
        first = json.loads(ad.full[1]['messages'][-1]['content'].split('\n')[0])['output']['facts']['excerpt']['text']
        self.assertTrue(first.endswith('forbidden-'), first)                                         # each half alone names nothing
        whole, _r2 = self.refused(planted(body, cid='forbidden-identity-42'), [tc('epub_inspect', {'spine': 0}), d3()]), None
        self.assertIsNotNone(whole)                                                                  # control: one whole excerpt is refused too

    def test_harness_text_is_never_exempted_because_the_media_contains_it(self):
        case = planted('x')
        guard = [{'role': 'user', 'content': json.dumps({'open': [{'text': 'the item is healthy'}], 'facts': {'excerpt': {'text': ''}}})}]
        sources = [{'source': 't1', 'field': 'excerpt.text', 'group': 'excerpt.text', 'text': 'the item is healthy'}]
        with self.assertRaises(leakguard.LeakError):            # the shadow keeps the harness sentence; the identical media text does not exempt it
            leakguard.check_messages_media2(case, guard, sources)
        leakguard.check_messages_media2(case, [{'role': 'user', 'content': json.dumps({'facts': {'excerpt': {'text': ''}}})}], sources)   # control: media only

    def test_plain_words_in_ordinary_prose_still_pass_and_legacy_is_unchanged(self):
        case = planted('She knew the lamplighter was healthy and new to the town.')
        self.assertIsNone(self.refused(case, [tc('epub_inspect'), tc('epub_inspect', {'spine': 0}), d3()]))
        msg = [{'role': 'user', 'content': json.dumps({'facts': {'excerpt': {'text': 'She knew the lamplighter was healthy'}}})}]
        with self.assertRaises(leakguard.LeakError):
            leakguard.check_messages(case, msg)                 # the legacy check on the same message: unchanged, still refuses

    def test_the_rule_tokens(self):
        kinds = lambda c: {k for k, _rx, _p in leakguard.media_tokens_2(c)}
        self.assertEqual(kinds(planted('x')) & {'family', 'truth_class', 'provenance'}, set())       # plain words: not refused in media text
        self.assertIn('case_id_stem', kinds(planted('x')))                                           # w22s-guard is not prose
        self.assertTrue({'case_id', 'case_id_stem', 'family', 'truth_class', 'provenance'} <= kinds(planted('x', cid='lr-epub-007', family='lr-epub', truth='corrupt_file',
                                                                                                         provenance='reused from .agents/context/x')))
        self.assertTrue(leakguard.is_prose("the lamplighter's lamp") and not leakguard.is_prose('lr-epub') and not leakguard.is_prose('identity_mismatch'))


class S2RecordedEvidence(unittest.TestCase):
    def recorded_case(self, heading, name):
        case = epub_case([('a.xhtml', xhtml('<h1>%s</h1>' % heading))], name)
        _r, o = call(case)
        case['evidence'] = [{'id': 'e1', 'tool': 'epub_inspect', 'args': {}, 'status': 'ok', 'output': json.dumps(o)}]
        return case

    def test_recorded_epub_text_is_kept_as_recorded_and_checked(self):
        case = self.recorded_case('Secret', 'Secret')
        ts = th.TempSuite([case])
        shown = R.resolve_evidence_raw(case, ts.root, T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp()).redact, literal_epub=True)
        ex = json.loads(shown[0]['output'])['body']['excerpts'][0]
        self.assertEqual((ex['text'], ex['end']), ('Secret', 6))                                     # at b94d80f4: "Expected Book" with end 6
        legacy = R.resolve_evidence_raw(case, ts.root, T.Context(case, T.Fixture.from_case(case, ts.root), tempfile.mkdtemp()).redact)
        self.assertNotIn('Secret', legacy[0]['output'])                                              # every other format: whole-string redaction, unchanged
        rec, ad = v7_run(case, [d3()])
        self.assertIsNotNone(rec.get('error'))                                                       # the identifier in recorded media text is refused
        self.assertIn('leakguard-media-2', rec['error']['message'])
        self.assertEqual(ad.full, [])                                                                # before any model call

    def test_recorded_prose_is_delivered_as_recorded_with_recorded_provenance(self):
        case = self.recorded_case('Plain Heading', 'q8recorded')
        rec, ad = v7_run(case, [d3()])
        self.assertIsNone(rec.get('error'))
        body = json.loads(ad.full[0]['messages'][0]['content'])['evidence']
        self.assertEqual(body['facts']['e1']['body']['excerpts'][0]['text'], 'Plain Heading')
        self.assertEqual(body['kinds']['e1']['provenance'], 'recorded')


class S3NamespaceResolvedNavigation(unittest.TestCase):
    DOC = ('<html xmlns="http://www.w3.org/1999/xhtml" %s><head><title>H</title></head><body><h1>Story</h1><section %s="toc"><h2>Declared Chapter</h2>'
           '<p>Declared Chapter</p></section><p>Narrative.</p></body></html>')

    def text(self, decl, attr, name):
        _r, o = call(epub_case([('a.xhtml', self.DOC % (decl, attr))], name))
        return o['body']['excerpts'][0]['text'], [h['text'] for h in o['body']['index'][0]['headings']]

    def test_a_bound_ops_prefix_is_the_epub_namespace(self):
        self.assertEqual(self.text('xmlns:ops="http://www.idpf.org/2007/ops"', 'ops:type', 'q8a'), ('Story Narrative.', ['Story']))   # at b94d80f4: Declared Chapter
        self.assertEqual(self.text('xmlns:epub="http://www.idpf.org/2007/ops"', 'epub:type', 'q8b'), ('Story Narrative.', ['Story']))  # paired: the same document
        self.assertIn('Declared Chapter', self.text('xmlns:ops="urn:other"', 'ops:type', 'q8d')[0])                                     # another namespace: not navigation
        self.assertIn('Declared Chapter', self.text('xmlns:epub="urn:other"', 'epub:type', 'q8e')[0])                                   # epub bound elsewhere: not either

    def test_rule_3_is_selected_and_pinned_and_rule_2_stays_frozen(self):
        from media_repair_harness import epub_text_v2 as E2
        from media_repair_harness import epub_text_v3 as E3
        self.assertEqual((E3.RULE_ID, E3.rules_digest()), ('xhtml-body-text-3', RULE3_SHA))
        self.assertEqual((E2.RULE_ID, E2.rules_digest()), ('xhtml-body-text-2', RV.RULE2_SHA))
        self.assertEqual(T._epub_text().RULE_ID, 'xhtml-body-text-3')


class S4SizingTrajectories(unittest.TestCase):
    def test_page_fetch_trajectories_and_the_context_floor(self):
        sys.path.insert(0, str(th.COMPONENT / 'scripts'))
        import devc7_sizes as S                                                                     # at b94d80f4: no page-fetch trajectory
        case = epub_case([('c%d.xhtml' % i, xhtml('<h2>Part %d</h2><p>%s</p>' % (i, 'word ' * 400))) for i in range(30)], 'q8pages')
        ts = th.TempSuite([case])
        plain, n_plain, _e = S.conversation(case, ts.root, 2560, [{}])
        fetched, n_fetched, err = S.conversation(case, ts.root, 2560, [{}], S.FetchAllPages)
        self.assertIsNone(err)
        self.assertGreater(n_fetched, n_plain)                                                       # the pages of the default result were fetched by cursor
        self.assertGreater(fetched, plain)
        floor = len(D.P.get_prompt('v7')['text']) // 3 + S.OUTPUT_RESERVE_TOKENS
        self.assertGreater(floor, 7000)                                                              # about 7,140: v7 cannot fit a local 8192 context with any tool result


RULE3_SHA = 'f7bc75e2330ab888b9d3e48fd37860bd410e41b218ef345547da3d0f64b7b7d1'   # xhtml-body-text-3: RULES plus the module source

if __name__ == '__main__':
    unittest.main()
