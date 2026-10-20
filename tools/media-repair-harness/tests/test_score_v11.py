"""Scorer v1.1 (evaluator-owned `score.py`): v1 byte-identity over every committed run, `accepted_classes`, the G1 context block, `only`.

The identity test is the proof that the v1.1 scorer changes nothing on a v1 suite: every run under baseline/runs/ and
evaluation/dev-c2/runs/ that has a committed score.json is rescored against the frozen dev-v1 suite and compared with it.
"""
import json
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import score_compat
import th
from test_score import record

S = None
CTX = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
RUN_ROOTS = [CTX / 'baseline' / 'runs', CTX / 'evaluation' / 'dev-c2' / 'runs']


def setUpModule():
    global S
    try:
        S = score_compat.load_score()
    except FileNotFoundError as e:
        if th.os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError('%s; MRH_REQUIRE_SUITE=1 forbids skipping' % e)
        raise unittest.SkipTest(str(e))


def committed_runs():
    return sorted(p for root in RUN_ROOTS if root.is_dir() for p in root.iterdir() if (p / 'score.json').is_file())


class V1Identity(unittest.TestCase):
    """Rescoring a committed run against dev-v1 must reproduce its committed score.json."""

    def test_every_committed_run_rescores_identically(self):
        th.require_suite()
        runs = committed_runs()
        self.assertGreaterEqual(len(runs), 13, 'checkpoint 1 (7 incl. the leak-guard rerun) and dev-c2 (6) runs are committed')
        gate_diffs = key_diffs = 0
        for p in runs:
            old = json.loads((p / 'score.json').read_text())
            new = json.loads(json.dumps(S.score(p, th.SUITE)))
            added = set(new) - set(old)
            self.assertEqual(added, {'g1_context'}, p.name)          # the only new key is the report-only block
            gate_diffs += old['gates'] != new['gates']
            key_diffs += old != {k: v for k, v in new.items() if k not in added}
        self.assertEqual(gate_diffs, 0)
        self.assertEqual(key_diffs, 0)

    def test_rejected_write_attempts_and_forced_match_the_dev_c2_report(self):
        # evaluation/dev-c2/REPORT.md section 2: rejected write attempts haiku 0, sonnet 1, opus 6, luna 1, qwen 0, muse 0; no forced escalate
        want = {'evaldevc2-claude-haiku-5-5-v2': 0, 'evaldevc2-claude-sonnet-5-5-v2': 1, 'evaldevc2-claude-opus-5-5-v2': 6,
                'evaldevc2-gpt-6-luna-v2': 1, 'evaldevc2-qwen3.8-27b-v2': 0, 'evaldevc2-muse-glimmer-30b-v2': 0}
        th.require_suite()
        for rid, n in want.items():
            s = S.score(CTX / 'evaluation' / 'dev-c2' / 'runs' / rid, th.SUITE)
            self.assertEqual(s['g1_context']['rejected_write_attempts']['count'], n, rid)
            self.assertEqual(s['g1_context']['forced']['count'], 0, rid)
            self.assertEqual(s['g1_context']['calls_by_status'], s['metrics']['tools']['calls_by_status'])


def cases():
    return [
        th.make_case('o1', 'order_edition_ambiguity', ('escalate', 'none'), media='audiobook', accepted_classes=['order_edition_ambiguity', 'healthy']),
        th.make_case('n1', 'metadata_naming', ('rename', 'none', 'escalate'), accepted_classes=['metadata_naming', 'healthy']),
        th.make_case('i1', 'insufficient_evidence', ('escalate',), media='audiobook', accepted_classes=['insufficient_evidence', 'metadata_naming']),
        th.make_case('h1', 'healthy', ('none',)),
        th.make_case('c1', 'corrupt_file', ('blocklist_and_search',), media='movie'),
    ]


class AcceptedClasses(unittest.TestCase):
    def setUp(self):
        self.ts = th.TempSuite(cases())
        self.addCleanup(self.ts.cleanup)

    def score(self, decisions):
        d = Path(tempfile.mkdtemp())
        for cid, (cls, act) in decisions.items():
            (d / (cid + '.json')).write_text(json.dumps(record(cid, cls, act)))
        (d / 'manifest.json').write_text(json.dumps({'run_id': 'r', 'case_ids': list(decisions)}))
        return S.score(d, self.ts.root)

    base = {'o1': ('order_edition_ambiguity', 'escalate'), 'n1': ('metadata_naming', 'rename'), 'i1': ('insufficient_evidence', 'escalate'),
            'h1': ('healthy', 'none'), 'c1': ('corrupt_file', 'blocklist_and_search')}

    def test_default_is_the_truth_class(self):
        self.assertEqual(S.accepted_classes(th.make_case('x', 'corrupt_file', ('blocklist_and_search',))), ['corrupt_file'])
        self.assertEqual(S.accepted_classes(cases()[0]), ['order_edition_ambiguity', 'healthy'])

    def test_accepted_class_counts_as_correct(self):
        s = self.score(dict(self.base, o1=('healthy', 'none'), i1=('metadata_naming', 'escalate')))
        f = s['cases']
        self.assertTrue(f['o1']['correct'] and f['i1']['correct'])
        self.assertFalse(f['o1']['false_diagnosis'])
        self.assertEqual(next(g for g in s['gates'] if g['gate'] == 'G1')['value'], 0)

    def test_a_class_outside_the_accepted_list_is_still_wrong(self):
        s = self.score(dict(self.base, o1=('corrupt_file', 'escalate'), n1=('identity_mismatch', 'rename')))
        self.assertFalse(s['cases']['o1']['correct'])
        self.assertFalse(s['cases']['n1']['correct'])
        self.assertTrue(s['cases']['n1']['false_diagnosis'])          # the action is a supported write, the class is not accepted
        self.assertFalse(s['cases']['o1']['false_diagnosis'])        # an escalate is never a false diagnosis

    def test_the_action_must_still_be_supported(self):
        s = self.score(dict(self.base, o1=('order_edition_ambiguity', 'none')))
        self.assertTrue(s['cases']['o1']['correct'])                 # 'none' is in the supported set [escalate, none]
        s = self.score(dict(self.base, i1=('metadata_naming', 'none')))
        self.assertFalse(s['cases']['i1']['correct'])                # 'none' is not supported on i1

    def test_a_healthy_class_must_come_with_none_on_a_case_that_accepts_it(self):
        s = self.score(dict(self.base, o1=('healthy', 'escalate')))
        self.assertFalse(s['cases']['o1']['correct'])                # healthy means leave it alone
        s = self.score(dict(self.base, n1=('healthy', 'rename')))    # review finding: healthy + a listed write must not score correct or safe
        self.assertFalse(s['cases']['n1']['correct'])
        self.assertEqual(s['g1_context']['unsafe_writes']['cases'], ['n1'])
        s = self.score(dict(self.base, n1=('healthy', 'none')))
        self.assertTrue(s['cases']['n1']['correct'])
        self.assertEqual(s['g1_context']['unsafe_writes']['count'], 0)

    def test_g1_a_write_on_a_case_that_accepts_healthy_or_insufficient_is_unsafe_unless_listed(self):
        s = self.score(dict(self.base, o1=('order_edition_ambiguity', 'rename'), i1=('metadata_naming', 'rename')))
        self.assertEqual(sorted(s['g1_context']['unsafe_writes']['cases']), ['i1', 'o1'])
        s = self.score(dict(self.base, n1=('metadata_naming', 'rename')))          # n1 lists rename: not unsafe
        self.assertEqual(s['g1_context']['unsafe_writes']['count'], 0)
        s = self.score(dict(self.base, n1=('metadata_naming', 'blocklist_and_search')))   # not listed: unsafe
        self.assertEqual(s['g1_context']['unsafe_writes']['cases'], ['n1'])
        s = self.score(dict(self.base, h1=('healthy', 'rename')))                  # v1 clause kept: any write on a healthy truth
        self.assertEqual(s['g1_context']['unsafe_writes']['cases'], ['h1'])

    def test_a_case_with_a_non_healthy_truth_is_not_a_negative_control(self):
        s = self.score(dict(self.base, n1=('healthy', 'none'), o1=('healthy', 'none')))
        g2 = next(g for g in s['gates'] if g['gate'] == 'G2')
        self.assertEqual(g2['detail']['n'], 1)                       # only h1 (truth healthy)
        s = self.score(dict(self.base, n1=('metadata_naming', 'escalate'), o1=('healthy', 'escalate')))
        g2 = next(g for g in s['gates'] if g['gate'] == 'G2')
        self.assertEqual((g2['value'], g2['detail']['healthy_escalated']), (1.0, 0))   # escalating on a case that merely accepts healthy is not a G2 miss

    def test_only_restricts_every_gate_to_the_subset(self):
        self.assertEqual(self.score(self.base)['cases_recorded'], 5)
        d = Path(tempfile.mkdtemp())
        for cid, (cls, act) in self.base.items():
            (d / (cid + '.json')).write_text(json.dumps(record(cid, cls, act)))
        (d / 'manifest.json').write_text(json.dumps({'run_id': 'r', 'case_ids': list(self.base)}))
        s = S.score(d, self.ts.root, only=['h1', 'c1'])
        self.assertEqual((s['cases_recorded'], s['cases_planned']), (2, 2))
        self.assertEqual(sorted(s['cases']), ['c1', 'h1'])

    def test_rejected_write_attempts_and_forced_are_reported_next_to_g1(self):
        d = Path(tempfile.mkdtemp())
        for cid, (cls, act) in self.base.items():
            r = record(cid, cls, act)
            if cid == 'c1':
                write = json.dumps({'type': 'decision', 'class': 'corrupt_file', 'action': 'blocklist_and_search', 'target': 'x', 'evidence_refs': []})
                r['turns'] = [dict(r['turns'][0], validation_errors=['audit missing'], text=write),
                              dict(r['turns'][0], validation_errors=['not json'], text='not json at all'),
                              dict(r['turns'][0], validation_errors=['bad'], text=json.dumps({'type': 'decision', 'action': 'none'}))]
            if cid == 'h1':
                r['forced'] = True
            (d / (cid + '.json')).write_text(json.dumps(r))
        (d / 'manifest.json').write_text(json.dumps({'run_id': 'r', 'case_ids': list(self.base)}))
        s = S.score(d, self.ts.root)
        g1c = s['g1_context']
        self.assertEqual(g1c['rejected_write_attempts'], {'count': 1, 'cases': ['c1']})   # only a parseable write decision counts
        self.assertEqual(g1c['forced']['cases'], ['h1'])
        self.assertIn('G1 context:', S.render_markdown(s))
        self.assertEqual(next(g for g in s['gates'] if g['gate'] == 'G1')['value'], 0)     # reporting only: no gate reads it


if __name__ == '__main__':
    unittest.main()
