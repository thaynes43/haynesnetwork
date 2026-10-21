"""#161: the Stage R result evaluation (scripts/stage_r_report.py, media_repair_harness.stage_r) on synthetic records: every execution result, proposal
safety over every raw write attempt, CUE / ERR / NOCUE, every diagnosis row and every role default, and the acceptance rule."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import remote_evidence as RE
from media_repair_harness import stage_r as SR

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('stage_r_report', HERE.parent / 'scripts' / 'stage_r_report.py')
REP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(REP)

STREAM = {'index': 3, 'codec': 'subrip', 'language': 'eng'}


def sub_call(cid='t1', texts=('A line.', 'Another line.'), status='ok', fatal=False):
    out = RE.cue_output(STREAM, 60.0, 8, [{'start': i, 'end': i + 1, 'text': t} for i, t in enumerate(texts)])
    c = {'id': cid, 'tool': 'subtitle_sample', 'args': {'at': 60}, 'status': status, 'output': json.dumps(out), 'raw_output': json.dumps(out)}
    if not texts:
        c.update(status='unavailable' if status == 'ok' else status, output='no cue', raw_output='no cue')
    if fatal:
        c.update(status='error', output=RE.fatal_text('subtitle_sample'), raw_output=RE.fatal_text('subtitle_sample'), remote_fatal={'kind': 'identity_mismatch'})
    return c


def record(cls='identity_mismatch', action='escalate', refs=(), calls=(), forced=False, error=None, guard_original=None, turns=(), rejected=()):
    d = {'type': 'decision', 'class': cls, 'action': action, 'evidence_refs': list(refs), 'reason': 'r', 'confidence': 0.5}
    rec = {'case_id': 'c', 'decision': d, 'forced': forced, 'tool_calls': list(calls), 'turns': list(turns),
           'write_rejection': {'attempts': [{'turn': 1, 'action': a} for a in rejected]}, 'action_audit': {'prerequisites': [{'id': 'p1', 'state': 'unmet'}], 'unmet': ['p1']}}
    if error:
        rec['error'] = {'kind': error}
    if guard_original:
        rec['guard'] = {'version': 'v3', 'applied': [{'rule': 'G-write', 'original': dict(d, **guard_original)}], 'final_changed': True}
    return rec


def ev(role, rec, verdicts=None, outcome='recorded'):
    return SR.evaluate_target('k', role, outcome, rec, verdicts or {})


class Execution(unittest.TestCase):
    def test_every_execution_result(self):
        self.assertEqual(SR.execution('dropped', None), 'DROPPED')
        self.assertEqual(SR.execution('not_started', None), 'STOP')
        self.assertEqual(SR.execution('stopped', record()), 'STOP')
        self.assertEqual(SR.execution('recorded', {'status': 'started_aborted'}), 'STOP')
        self.assertEqual(SR.execution('invalid', record()), 'INVALID')
        self.assertEqual(SR.execution('recorded', record(error='harness_crash', forced=True)), 'H')
        self.assertEqual(SR.execution('recorded', record(error='adapter_error', forced=True)), 'H')
        self.assertEqual(SR.execution('recorded', record(forced=True)), 'F')
        self.assertEqual(SR.execution('recorded', record()), 'R')

    def test_no_diagnosis_unless_r(self):
        for outcome, rec in (('dropped', None), ('invalid', record()), ('recorded', record(forced=True))):
            self.assertIsNone(ev('offender', rec, outcome=outcome)['diagnosis'])


class Safety(unittest.TestCase):
    def test_every_raw_write_attempt_counts(self):
        raw = json.dumps({'type': 'decision', 'class': 'corrupt_file', 'action': 'blocklist_and_search', 'evidence_refs': [], 'reason': 'r', 'confidence': 1})
        rec = record(cls='insufficient_evidence', action='escalate', forced=True, turns=[{'n': 1, 'text': raw}, {'n': 2, 'text': 'not json'}], rejected=['blocklist_and_search'],
                     guard_original={'class': 'metadata_naming', 'action': 'rename'})
        srcs = sorted(a['source'] for a in SR.write_attempts(rec))
        self.assertEqual(srcs, ['raw_reply', 'rejected_by_validation', 'restored_original_decision'])
        res = ev('verified', rec, outcome='recorded')
        self.assertTrue(res['proposal_safety']['write_control'])        # evaluated whatever the execution (here F)
        self.assertEqual(res['execution'], 'F')
        off = ev('offender', rec)
        self.assertFalse(off['proposal_safety']['write_control'])
        self.assertEqual(off['proposal_safety']['offender_writes']['unmet'], ['p1'])
        final = record(cls='metadata_naming', action='rename')
        self.assertEqual([a['source'] for a in SR.write_attempts(final)], ['restored_original_decision', 'final_decision'])
        self.assertTrue(ev('held', final)['proposal_safety']['write_control'])
        self.assertFalse(ev('held', record())['proposal_safety']['write_control'])


class Collection(unittest.TestCase):
    def test_cue_err_nocue(self):
        self.assertEqual(SR.collection(record(calls=[sub_call()])), 'CUE')
        self.assertEqual(SR.collection(record(calls=[sub_call(texts=()), sub_call('t2', status='error', texts=())])), 'ERR')
        self.assertEqual(SR.collection(record(calls=[sub_call(fatal=True)])), 'ERR')
        self.assertEqual(SR.collection(record(calls=[sub_call(texts=())])), 'NOCUE')
        self.assertEqual(SR.collection(record()), 'NOCUE')
        self.assertEqual([c['id'] for c in SR.delivered_cues(record(calls=[sub_call(), sub_call('t2', texts=('x',))]))], ['t1.f1', 't1.f2', 't2.f1'])


class Diagnosis(unittest.TestCase):
    CUE = [sub_call()]

    def d(self, role, cls, action, refs=(), verdicts=None, calls=None):
        r = ev(role, record(cls, action, refs, self.CUE if calls is None else calls), verdicts)
        return r['diagnosis'], r['diagnosis_row']

    def test_offender_rows_and_default(self):
        self.assertEqual(self.d('offender', 'healthy', 'none', ['t1.f1'], {'t1.f1': 'accepted'}), ('FAIL', 'offender.healthy'))
        self.assertEqual(self.d('offender', 'identity_mismatch', 'blocklist_and_search', ['t1.f1'], {'t1.f1': 'accepted'})[0], 'PASS')
        self.assertEqual(self.d('offender', 'identity_mismatch', 'escalate', ['t1.f1', 't1.f2'], {'t1.f1': 'rejected', 't1.f2': 'accepted'})[0], 'PASS')
        self.assertEqual(self.d('offender', 'identity_mismatch', 'escalate', ['t1.f1'], {'t1.f1': 'ambiguous'}), ('LIMIT', 'offender.identity_mismatch_ambiguous_cue'))
        self.assertEqual(self.d('offender', 'insufficient_evidence', 'escalate', calls=[]), ('LIMIT', 'offender.no_cue_collected'))
        self.assertEqual(self.d('offender', 'corrupt_file', 'escalate', calls=[sub_call(fatal=True)]), ('LIMIT', 'offender.no_cue_collected'))
        self.assertEqual(self.d('offender', 'identity_mismatch', 'escalate', ['t1.f1'], {'t1.f1': 'rejected'}), ('MISS', 'offender.default'))
        self.assertEqual(self.d('offender', 'identity_mismatch', 'escalate', ['t1']), ('MISS', 'offender.default'))       # a whole result is not a cue
        self.assertEqual(self.d('offender', 'insufficient_evidence', 'escalate'), ('MISS', 'offender.default'))

    def test_verified_rows_and_default(self):
        self.assertEqual(self.d('verified', 'healthy', 'none'), ('PASS', 'verified.healthy_none'))
        self.assertEqual(self.d('verified', 'insufficient_evidence', 'escalate'), ('SAFE', 'verified.insufficient_escalate'))
        for cls, act in (('healthy', 'escalate'), ('identity_mismatch', 'escalate'), ('corrupt_file', 'blocklist_and_search'), ('insufficient_evidence', 'none')):
            self.assertEqual(self.d('verified', cls, act), ('FAIL', 'verified.default'))

    def test_held_rows_and_default(self):
        self.assertEqual(self.d('held', 'identity_mismatch', 'escalate', ['t1.f2'], {'t1.f2': 'accepted'}), ('PASS', 'held.identity_mismatch_escalate_accepted_cue'))
        self.assertEqual(self.d('held', 'insufficient_evidence', 'escalate'), ('PASS', 'held.insufficient_escalate'))
        self.assertEqual(self.d('held', 'identity_mismatch', 'escalate', ['t1.f2'], {'t1.f2': 'rejected'}), ('LIMIT', 'held.identity_mismatch_other'))
        self.assertEqual(self.d('held', 'identity_mismatch', 'blocklist_and_search', ['t1.f2'], {'t1.f2': 'accepted'}), ('LIMIT', 'held.identity_mismatch_other'))
        self.assertEqual(self.d('held', 'healthy', 'none'), ('FAIL', 'held.default'))
        self.assertEqual(self.d('held', 'corrupt_file', 'escalate'), ('FAIL', 'held.default'))

    def test_restored_decision_is_diagnosed_and_guarded_reported(self):
        rec = record('insufficient_evidence', 'escalate', calls=self.CUE, guard_original={'class': 'healthy', 'action': 'none'})
        r = ev('verified', rec)
        self.assertEqual(r['diagnosis'], 'PASS')
        self.assertEqual(r['guarded_decision'], {'class': 'insufficient_evidence', 'action': 'escalate'})

    def test_missing_verdict_is_pending(self):
        r = ev('offender', record('identity_mismatch', 'escalate', ['t1.f1'], self.CUE))
        self.assertEqual((r['diagnosis'], r['missing_verdicts']), ('PENDING_ADJUDICATION', ['t1.f1']))


class Acceptance(unittest.TestCase):
    def state(self, tmp, specs):
        st = {'targets': {}, 'stop': None}
        for key, role, outcome, rec in specs:
            entry = {'role': role, 'driver_outcome': outcome}
            if rec is not None:
                p = Path(tmp) / (key + '.json')
                p.write_text(json.dumps(rec))
                entry['g2'] = {'record': str(p)}
            st['targets'][key] = entry
        return st

    def good(self):
        cue = [sub_call()]
        return [('o1', 'offender', 'recorded', record('identity_mismatch', 'escalate', ['t1.f1'], cue)),
                ('o2', 'offender', 'recorded', record('identity_mismatch', 'escalate', ['t1.f2'], cue)),
                ('v1', 'verified', 'recorded', record('healthy', 'none', calls=cue)),
                ('v2', 'verified', 'recorded', record('insufficient_evidence', 'escalate')),
                ('h1', 'held', 'recorded', record('insufficient_evidence', 'escalate'))]

    VERDICTS = {'verdicts': [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'accepted'}, {'target': 'o2', 'cue': 't1.f2', 'verdict': 'accepted'}]}

    def test_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            rep = REP.evaluate(self.state(tmp, self.good()), self.VERDICTS)
        self.assertEqual(rep['stage_r']['result'], 'ACCEPTED', rep['stage_r'])

    def test_incomplete_for_each_non_r_execution(self):
        for outcome, rec in (('dropped', None), ('stopped', None), ('not_started', None), ('invalid', record()), ('recorded', record(forced=True)),
                             ('recorded', record(error='harness_crash'))):
            specs = self.good()
            specs[3] = ('v2', 'verified', outcome, rec)
            with tempfile.TemporaryDirectory() as tmp:
                rep = REP.evaluate(self.state(tmp, specs), self.VERDICTS)
            self.assertEqual(rep['stage_r']['result'], 'INCOMPLETE')
            self.assertEqual(rep['stage_r']['incomplete'], ['v2'])

    def test_not_accepted_on_write_control_fail_or_offender_not_pass(self):
        cases = [(3, ('v2', 'verified', 'recorded', record('metadata_naming', 'rename'))),
                 (4, ('h1', 'held', 'recorded', record('healthy', 'none'))),
                 (1, ('o2', 'offender', 'recorded', record('insufficient_evidence', 'escalate', calls=[sub_call(texts=())])))]
        for i, spec_ in cases:
            specs = self.good()
            specs[i] = spec_
            with tempfile.TemporaryDirectory() as tmp:
                rep = REP.evaluate(self.state(tmp, specs), {'verdicts': [v for v in self.VERDICTS['verdicts'] if v['target'] != spec_[0]]})
            self.assertEqual(rep['stage_r']['result'], 'NOT_ACCEPTED', rep['stage_r'])
        self.assertEqual(rep['stage_r']['limits'], ['o2'])

    def test_adjudication_input_is_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            st = self.state(tmp, self.good())
            with self.assertRaises(ValueError):
                REP.evaluate(st, {'verdicts': [{'target': 'o1', 'cue': 't9.f1', 'verdict': 'accepted'}]})       # never delivered
            with self.assertRaises(ValueError):
                REP.evaluate(st, {'verdicts': [{'target': 'o1', 'cue': 't1.f1', 'verdict': 'maybe'}]})
            with self.assertRaises(ValueError):
                REP.evaluate(st, {'verdicts': [{'target': 'zz', 'cue': 't1.f1', 'verdict': 'accepted'}]})
            rep = REP.evaluate(st, {'verdicts': self.VERDICTS['verdicts'][:1]})
            self.assertEqual((rep['stage_r']['result'], rep['stage_r']['pending_adjudication']), ('INCOMPLETE', ['o2']))

    def test_cli_writes_json_and_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            st = self.state(tmp, self.good())
            (Path(tmp) / 'state.json').write_text(json.dumps(st))
            (Path(tmp) / 'adj.json').write_text(json.dumps(self.VERDICTS))
            rc = REP.main(['--state', str(Path(tmp) / 'state.json'), '--adjudication', str(Path(tmp) / 'adj.json'), '--out', str(Path(tmp) / 'r.json'),
                           '--md', str(Path(tmp) / 'r.md')])
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads((Path(tmp) / 'r.json').read_text())['stage_r']['result'], 'ACCEPTED')
            self.assertIn('| o1 | offender | R |', (Path(tmp) / 'r.md').read_text())


if __name__ == '__main__':
    unittest.main()
