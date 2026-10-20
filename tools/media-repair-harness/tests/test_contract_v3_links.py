"""Contract v3 capability links (WO-W20 item 2, A16 item 4) and the uncalled-check rule (item 5).

A link is a pure function of the visible observations, the advertised capabilities and static tool semantics.  The independence test builds
the REAL advertisement (`tools.capabilities`) from replay recordings whose uncalled results are swapped between clean, damaged and error, and
requires identical advertisements, links, order and availability."""
import hashlib
import inspect
import json
import tempfile
import unittest

import legacy_e2e as L
import th
from media_repair_harness import evidence_v2 as EV2
from media_repair_harness import tools as T
from media_repair_harness.experimental.contract_v3 import links as LK
from media_repair_harness.experimental.contract_v3 import uncalled as UC

CLEAN = {'exit_code': 0, 'frames': 40, 'out_time': '00:00:04.000000', 'stderr': '', 'ss': 4, 't': 4}
DAMAGED = {'exit_code': 0, 'frames': 27, 'out_time': '00:00:04.000000', 'stderr': '[h264 @ 0x0] error while decoding MB 13 11, bytestream -5', 'ss': 4, 't': 4}
ERROR = {'exit_code': 1, 'stderr': 'Permission denied'}


def advertised(variant):
    """The capability advertisement of the standard replay case with the UNCALLED windows 4, 8 and full set to `variant`."""
    case = L.tv_case('lnk-001', evidence=[])
    ts = L.suite_with(case, probes=False)
    rec = json.loads(json.dumps(L.REPLAY_FILE))
    rec['sha256'] = hashlib.sha256(b'not really media' * 50).hexdigest()
    for k in ('4', '8', 'full'):
        rec['decode_sample'][k] = dict(variant, ss=int(k) if k.isdigit() else 0)
    rec['frame_text'] = [{'t0': 0, 't1': 2, 'text': 'VARIANT %s' % variant.get('stderr', '')[:12]}]
    ts.add_file('fixtures/probes/x.mkv.json', json.dumps(rec).encode())
    fx = T.Fixture.from_case(case, ts.root)
    ctx = T.Context(case, fx, tempfile.mkdtemp(prefix='mrh-w20-'), suite_dir=ts.root, which=th.NO_BINARIES, tools_behavior='v2')
    caps = T.capabilities(ctx)
    ts.cleanup()
    return case, caps


def shown_probe():
    return [EV2.make_observation('e1', 'ffprobe', {}, 'ok', json.dumps(L.PROBE_REC), None, 'case'),
            EV2.make_observation('t1', 'decode_sample', {'at': 0}, 'ok', json.dumps(dict(CLEAN, ss=0)), 'replay', 'tool')]


class LinksCarryNoResult(unittest.TestCase):
    def links(self, caps, case):
        obs = shown_probe()
        an = EV2.analyze(obs, case['context'], case['media_type'])
        return LK.attach_links(LK.open_items(an, case['media_type']), caps, obs, case['tools_available'], case['media_type'])

    def test_swapping_uncalled_clean_damaged_error_changes_nothing(self):
        base_case, base_caps = advertised(CLEAN)
        base = self.links(base_caps, base_case)
        self.assertTrue(any(c['tool'] == 'decode_sample' and c['availability'] == 'available' for it in base for c in it['available_check']))
        for v in (DAMAGED, ERROR):
            case, caps = advertised(v)
            self.assertEqual(caps, base_caps)
            self.assertEqual(self.links(caps, case), base)

    def test_the_link_function_has_no_result_or_budget_input(self):
        self.assertEqual(list(inspect.signature(LK.links_for).parameters), ['item', 'capabilities', 'shown', 'tools_offered', 'media_type'])
        caps = [{'tool': 'decode_sample', 'available': True, 'offsets_s': [0, 4, 8], 'window_s': 4, 'full_decode': 'recorded', 'result': 'SECRET-CLEAN'}]
        it = {'id': 'u1', 'scope': {'type': 'decode_interval', 'intervals': [[4.0, 8.0]]}, 'sources': []}
        got = LK.links_for(it, caps, [], ['decode_sample'])
        self.assertNotIn('SECRET', json.dumps(got))
        for c in got:
            self.assertEqual(set(c), {'tool', 'args', 'scope', 'availability'})

    def test_offsets_follow_the_advertisement_never_a_result(self):
        caps = [{'tool': 'decode_sample', 'available': True, 'offsets_s': [12, 0, 4, 8], 'window_s': 4, 'full_decode': 'not_recorded'}]
        it = {'id': 'u1', 'scope': {'type': 'decode_interval', 'intervals': [[3.0, 9.0]]}, 'sources': []}
        got = LK.links_for(it, caps, [], ['decode_sample'])
        self.assertEqual([(c['args'], c['availability']) for c in got], [({'at': 0}, 'available'), ({'at': 4}, 'available'), ({'at': 8}, 'available'), ({'full': True}, 'unavailable')])
        caps_any = [{'tool': 'decode_sample', 'available': True, 'offsets_s': 'any', 'full_decode': 'on request, capped by size and time'}]
        self.assertEqual([c['args'] for c in LK.links_for(it, caps_any, [], ['decode_sample'])], [{'at': 3.0}, {'full': True}])

    def test_zero_many_unknown_called_and_called_failed(self):
        none = {'id': 'u1', 'scope': {'type': 'epub_body_beyond_heads'}, 'sources': []}
        self.assertEqual(LK.links_for(none, [{'tool': 'epub_inspect', 'available': True}], [], ['epub_inspect']), [])
        whole = {'id': 'u2', 'scope': {'type': 'whole_file_decode'}, 'sources': []}
        self.assertEqual(LK.links_for(whole, [], [], ['decode_sample'])[0]['availability'], 'unknown')       # offered, nothing advertised
        self.assertEqual(LK.links_for(whole, [{'tool': 'decode_sample', 'available': True}], [], [])[:1], [])   # not offered: no candidate
        failed = [EV2.make_observation('t1', 'decode_sample', {'full': True}, 'timeout', 'decode_sample exceeded the 60 s tool timeout', None, 'tool')]
        c = LK.links_for(whole, [{'tool': 'decode_sample', 'available': True, 'full_decode': 'recorded'}], failed, ['decode_sample'])[0]
        self.assertEqual((c['availability'], c['already_shown_as']), ('called_failed', ['t1']))
        ok = [EV2.make_observation('e2', 'decode_sample', {'t': 'full'}, 'ok', json.dumps(CLEAN), None, 'case')]
        self.assertEqual(LK.links_for(whole, [{'tool': 'decode_sample', 'available': True, 'full_decode': 'recorded'}], ok, ['decode_sample'])[0]['availability'], 'called')
        many = {'id': 'u3', 'scope': {'type': 'decode_interval', 'intervals': [[0.0, None]]}, 'sources': []}
        self.assertEqual(len(LK.links_for(many, [{'tool': 'decode_sample', 'available': True, 'offsets_s': [0, 4, 8], 'window_s': 4, 'full_decode': 'recorded'}], [], ['decode_sample'])), 4)

    def test_every_generated_unresolved_template_has_a_scope(self):
        texts = ['nothing was decoded: stream contents are unchecked by this result', 'which streams were decoded is not recorded',
                 'this result is a record or reading, not an integrity check', 'only the first 3 of 53 spine items are shown as text; the rest is checked for structure only',
                 'a full decode was requested; the result does not say whether it covers the whole file', 'this call settled nothing about the EPUB archive and package']
        self.assertEqual([LK.scope_type(t) for t in texts], ['decode_interval', 'stream_selection_of_window', 'statement_kind', 'epub_body_beyond_heads', 'whole_file_decode', 'repeat_of_call'])
        self.assertEqual(LK.scope_type('a sentence no template knows'), 'other')


class UncalledAtTheDecisionPrefix(unittest.TestCase):
    """The counted candidates respect arguments (advertised offsets), the remaining budget and earlier calls and failures."""

    def run_rec(self, calls, decision_action='escalate'):
        case = L.tv_case('unc-001', evidence=[{'id': 'e1', 'tool': 'ffprobe', 'args': {}, 'status': 'ok', 'output': json.dumps(L.PROBE_REC)}])
        ts = L.suite_with(case)
        caps = [{'tool': 'ffprobe', 'available': True}, {'tool': 'decode_sample', 'available': True, 'offsets_s': [0, 4, 8], 'window_s': 4, 'full_decode': 'recorded'}]
        rec = {'model_case_alias': 'case-00000001', 'tool_calls': calls, 'decision': {'action': decision_action}, 'evidence_format': {'capabilities': caps}}
        out = UC.callable_candidates(rec, case, ts.root)
        ts.cleanup()
        return out

    def call(self, i, args, status='ok', out=None):
        return {'id': 't%d' % i, 'tool': 'decode_sample', 'args': args, 'status': status, 'output': json.dumps(out or dict(CLEAN, ss=args.get('at', 0)))}

    def test_counts_only_valid_uncalled_candidates_with_budget(self):
        _items, counted, rem = self.run_rec([])
        self.assertEqual((rem, sorted(json.dumps(c['args'], sort_keys=True) for c in counted)), (6, ['{"at": 0}', '{"at": 4}', '{"at": 8}', '{"full": true}']))
        _items, counted, _rem = self.run_rec([self.call(1, {'at': 0}), self.call(2, {'full': True}, 'timeout', {'stderr': 'x'})])
        self.assertEqual(sorted(json.dumps(c['args'], sort_keys=True) for c in counted), ['{"at": 4}', '{"at": 8}'])    # neither the made call nor the failed one
        six = [self.call(i, {'at': 0}) for i in range(1, 7)]
        self.assertEqual(self.run_rec(six)[1:], ([], 0))       # no budget left: nothing counts

    def test_a_page_fetch_uses_budget_but_is_not_an_observation(self):
        page = {'id': 't1', 'tool': 'page', 'continuation': True, 'args': {'cursor': 'c' + '0' * 15}, 'status': 'ok', 'output': '{}'}
        _items, counted, rem = self.run_rec([page])
        self.assertEqual((rem, len(counted)), (5, 4))


if __name__ == '__main__':
    unittest.main()
