"""OpenProject #207: the offline per-tool usage report (scripts/tool_usage_report.py) on SYNTHETIC records written in this test.

No model, no network, no subprocess, no media.  Every run directory, suite and record below is built in a temporary folder, so the expected numbers are
worked out by hand next to the data.  One extra test regenerates the committed report from the public suite and the committed run records (skipped when
they are absent, a failure under MRH_REQUIRE_SUITE=1 like the other suite-dependent tests) and compares it with docs/tool-usage-report.json.

Synthetic suite `syn-1` (4 cases):
  c-corrupt  truth corrupt_file   tv     offers ffprobe, decode_sample, arr_lookup   pre-supplied: ffprobe (error), arr_lookup (ok)
  c-ident    truth identity_mismatch tv  offers ffprobe, ocr, arr_lookup            pre-supplied: arr_lookup (ok), prior_record (ok)
  c-healthy  truth healthy        movie  offers ffprobe, decode_sample             pre-supplied: ffprobe (ok)
  c-epub     truth corrupt_file   epub   offers epub_inspect                        pre-supplied: none
"""
import ast
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
spec = importlib.util.spec_from_file_location('tool_usage_report', COMPONENT / 'scripts' / 'tool_usage_report.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

REPO = COMPONENT.parent.parent
ASSESS = REPO / '.agents' / 'context' / 'media-repair-harness-2026-10-19'


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, sort_keys=True), encoding='utf-8')


def ev(i, tool, status):
    return {'id': i, 'tool': tool, 'args': {}, 'status': status, 'output': '{}'}


SUITE_CASES = {
    'c-corrupt': {'truth': 'corrupt_file', 'media': 'tv', 'tools': ['ffprobe', 'decode_sample', 'arr_lookup'],
                  'evidence': [ev('e1', 'ffprobe', 'error'), ev('e2', 'arr_lookup', 'ok')]},
    'c-ident': {'truth': 'identity_mismatch', 'media': 'tv', 'tools': ['ffprobe', 'ocr', 'arr_lookup'],
                'evidence': [ev('e1', 'arr_lookup', 'ok'), ev('e2', 'prior_record', 'ok')]},
    'c-healthy': {'truth': 'healthy', 'media': 'movie', 'tools': ['ffprobe', 'decode_sample'], 'evidence': [ev('e1', 'ffprobe', 'ok')]},
    'c-epub': {'truth': 'corrupt_file', 'media': 'epub', 'tools': ['epub_inspect'], 'evidence': []},
}


def make_suite(root, version='syn-1'):
    root = Path(root)
    for cid, c in SUITE_CASES.items():
        write(root / 'cases' / (cid + '.json'), {'id': cid, 'suite_version': version, 'split': 'dev', 'media_type': c['media'], 'truth': {'class': c['truth']},
                                                  'supported_actions': ['none'], 'solvable': True, 'evidence': c['evidence'], 'tools_available': c['tools']})
    write(root / 'manifest.json', {'suite_version': version})
    return root


def sha_of(root, cid):
    return R._sha256(Path(root) / 'cases' / (cid + '.json'))


def call(i, tool, status, **extra):
    d = {'id': i, 'tool': tool, 'status': status, 'args': {}}
    d.update(extra)
    return d


def record(suite, cid, calls=(), refs=(), forced=False, violations=(), shown=None, version='syn-1', sha=None):
    c = SUITE_CASES[cid]
    shown = [e['id'] for e in c['evidence']] if shown is None else shown
    return {'case_id': cid, 'case_sha256': sha or sha_of(suite, cid), 'suite_version': version, 'requested_model': 'm', 'harness_version': 'h',
            'evidence_shown': shown, 'tool_calls': list(calls), 'decision': {'class': c['truth'], 'action': 'none', 'evidence_refs': list(refs)},
            'forced': forced, 'protocol_violations': list(violations), 'refs_to_failed_tools': [],
            'evidence': {'capabilities': [{'tool': t, 'offered': True} for t in c['tools']]}}


def make_run(root, name, suite, records, correct, adapter='ollama', model='m', planned=None, aborted=None, prompt='v7'):
    d = Path(root) / name
    for r in records:
        write(d / (r['case_id'] + '.json'), r)
    sc = {cid: {'truth': SUITE_CASES[cid]['truth'], 'class': SUITE_CASES[cid]['truth'], 'action': 'none', 'correct': ok} for cid, ok in correct.items()}
    write(d / 'score.json', {'adapter': adapter, 'requested_model': model, 'cases': sc, 'cases_planned': planned or len(records)})
    mf = {'argv': ['--adapter', adapter, '--prompt', prompt, '--guards', 'v3']}
    if aborted:
        mf['aborted'] = aborted
    write(d / 'manifest.json', mf)
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.suite = make_suite(self.root / 'suite')

    def standard_records(self):
        s = self.suite
        return [
            # corrupt: called decode_sample (ok) and ffprobe (offered, pre-supplied too), cited pre ffprobe e1 and the call t1; one not-offered request
            record(s, 'c-corrupt', calls=[call('t1', 'decode_sample', 'ok'), call('t2', 'ffprobe', 'error'), call('t3', 'audio_sample', 'unavailable')],
                   refs=['e1.f1', 't1'], violations=[{'kind': 'tool_not_offered', 'call': 't3'}]),
            # identity: no call; cites arr_lookup e1 only
            record(s, 'c-ident', refs=['e1']),
            # healthy: no call, cites nothing
            record(s, 'c-healthy'),
            # epub: a call plus a page continuation, cited the call (a failed one)
            record(s, 'c-epub', calls=[call('t1', 'epub_inspect', 'error'), call('t2', 'page', 'ok', continuation_via='epub_inspect')], refs=['t1', 'u9']),
        ]


class CaseFacts(Base):
    def facts(self, cid, rec, ok=True):
        suite = R.load_suite(self.suite)
        return R.case_facts(suite['cases'][cid], rec, {'truth': SUITE_CASES[cid]['truth'], 'correct': ok, 'class': 'x', 'action': 'none'})

    def test_calls_offered_pre_supplied_and_not_offered_are_separated(self):
        f = self.facts('c-corrupt', self.standard_records()[0])
        t = f['tools']
        self.assertEqual((t['decode_sample']['offered'], t['decode_sample']['calls'], t['decode_sample']['pre_supplied']), (True, 1, 0))
        self.assertEqual((t['ffprobe']['offered'], t['ffprobe']['calls'], t['ffprobe']['pre_supplied']), (True, 1, 1))
        self.assertEqual((t['arr_lookup']['calls'], t['arr_lookup']['pre_supplied']), (0, 1))
        self.assertEqual((t['audio_sample']['offered'], t['audio_sample']['calls'], t['audio_sample']['called_not_offered']), (False, 0, 1))
        self.assertEqual(f['n_calls'], 2)                      # the not-offered request is not a call

    def test_citations_split_pre_supplied_and_called_and_drop_the_field_suffix(self):
        t = self.facts('c-corrupt', self.standard_records()[0])['tools']
        self.assertTrue(t['ffprobe']['cited_pre'])             # e1.f1 -> e1, the pre-supplied ffprobe output
        self.assertTrue(t['decode_sample']['cited_called'])    # t1
        self.assertFalse(t['arr_lookup']['cited_pre'] or t['arr_lookup']['cited_called'])
        self.assertTrue(t['ffprobe']['cited_non_ok'])          # the cited pre-supplied ffprobe status is error

    def test_a_cited_not_offered_request_is_counted_apart_and_an_unknown_ref_is_unresolved(self):
        rec = record(self.suite, 'c-corrupt', calls=[call('t1', 'audio_sample', 'unavailable')], refs=['t1', 'u2'])
        f = self.facts('c-corrupt', rec)
        self.assertEqual(f['cited_not_offered_refs'], 1)
        self.assertEqual(f['unresolved_refs'], ['u2'])
        self.assertFalse(any(s['cited_called'] for s in f['tools'].values()))

    def test_page_continuation_counts_under_its_tool_not_as_a_call(self):
        t = self.facts('c-epub', self.standard_records()[3])['tools']['epub_inspect']
        self.assertEqual((t['calls'], t['page_continuations']), (1, 1))
        self.assertEqual(dict(t['statuses']), {'error': 1})
        self.assertTrue(t['cited_called'] and t['cited_non_ok'])

    def test_pre_supplied_only_counts_what_the_record_says_was_shown(self):
        rec = record(self.suite, 'c-corrupt', shown=['e2'])
        t = self.facts('c-corrupt', rec)['tools']
        self.assertEqual(t['ffprobe']['pre_supplied'], 0)
        self.assertEqual(t['arr_lookup']['pre_supplied'], 1)

    def test_prior_record_is_pre_supplied_only(self):
        t = self.facts('c-ident', self.standard_records()[1])['tools']
        self.assertEqual((t['prior_record']['offered'], t['prior_record']['pre_supplied']), (False, 1))


class Aggregation(Base):
    def build(self, correct=None):
        d = make_run(self.root / 'runs', 'r1', self.suite, self.standard_records(), correct or {'c-corrupt': True, 'c-ident': True, 'c-healthy': False, 'c-epub': True})
        run = R.load_run(d)
        return R.analyse_run(run, {'syn-1': R.load_suite(self.suite)})

    def test_per_tool_counts_and_correctness_splits(self):
        a = self.build()
        t = a['tools']
        self.assertEqual((t['ffprobe']['cases_offered'], t['ffprobe']['cases_pre_supplied'], t['ffprobe']['cases_called'], t['ffprobe']['calls']), (3, 2, 1, 1))
        self.assertEqual(t['ffprobe']['cases_called_with_pre'], 1)
        # ffprobe offered in corrupt (called, correct), ident (not called, correct), healthy (not called, wrong)
        self.assertEqual(t['ffprobe']['offered_called'], {'n': 1, 'correct': 1})
        self.assertEqual(t['ffprobe']['offered_not_called'], {'n': 2, 'correct': 1})
        self.assertEqual(t['decode_sample']['offered_called'], {'n': 1, 'correct': 1})
        self.assertEqual(t['decode_sample']['offered_not_called'], {'n': 1, 'correct': 0})
        self.assertEqual(dict(t['ffprobe']['statuses']), {'error': 1})
        # citations: ffprobe cited in corrupt only; the available universe is the 3 cases that offer or carry it
        self.assertEqual((t['ffprobe']['cases_cited_pre'], t['ffprobe']['cases_cited_called']), (1, 0))
        self.assertEqual(t['ffprobe']['cited'], {'n': 1, 'correct': 1})
        self.assertEqual(t['ffprobe']['available_not_cited'], {'n': 2, 'correct': 1})
        self.assertEqual(t['epub_inspect']['cases_cited_called'], 1)
        self.assertEqual(t['epub_inspect']['page_continuations'], 1)
        self.assertEqual(t['audio_sample']['called_not_offered_calls'], 1)
        self.assertEqual(t['audio_sample']['cases_offered'], 0)
        self.assertEqual(t['prior_record']['cases_pre_supplied'], 1)

    def test_tool_order_and_overall(self):
        a = self.build()
        names = list(a['tools'])
        self.assertLess(names.index('ffprobe'), names.index('decode_sample'))
        self.assertEqual(names[-1], 'prior_record')
        o = a['overall']
        self.assertEqual((o['n'], o['correct'], o['total_calls']), (4, 3, 3))
        self.assertEqual((o['cases_zero_calls'], o['cases_some_calls']), ({'n': 2, 'correct': 1}, {'n': 2, 'correct': 2}))

    def test_by_class_is_by_truth_and_media_filter_works(self):
        s = R.load_suite(self.suite)
        d = make_run(self.root / 'runs', 'r1', self.suite, self.standard_records(), {'c-corrupt': True, 'c-ident': False, 'c-healthy': True, 'c-epub': True})
        run = R.load_run(d)
        facts = [R.case_facts(s['cases'][c], run['records'][c], run['score']['cases'][c]) for c in sorted(run['records'])]
        bc = R.by_class(facts)
        self.assertEqual(list(bc), ['identity_mismatch', 'corrupt_file', 'healthy'])      # CLASS_ORDER, only classes present
        self.assertEqual((bc['corrupt_file']['n'], bc['corrupt_file']['correct']), (2, 2))
        self.assertEqual(bc['identity_mismatch']['tools']['arr_lookup']['offered_not_called'], {'n': 1, 'correct': 0})
        tv = R.by_class(facts, media='tv')
        self.assertEqual(tv['corrupt_file']['n'], 1)                                        # the epub corrupt case is filtered out

    def test_scorer_correct_flag_is_read_not_recomputed(self):
        a = self.build({'c-corrupt': False, 'c-ident': False, 'c-healthy': False, 'c-epub': False})
        self.assertEqual(a['overall']['correct'], 0)


class Runs(Base):
    def test_partial_run_is_flagged_and_kept_out_of_the_pool(self):
        s = self.suite
        full = make_run(self.root / 'runs', 'full', s, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        part = make_run(self.root / 'runs', 'part', s, self.standard_records()[:1], {'c-corrupt': True}, planned=4, aborted='gpu blind')
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        meta = {r['name']: r['meta'] for r in rep['runs']}
        self.assertFalse(meta['full']['partial'])
        self.assertTrue(meta['part']['partial'])
        self.assertEqual(meta['part']['aborted'], 'gpu blind')
        self.assertEqual(len(rep['pooled']), 1)
        self.assertEqual(rep['pooled'][0]['runs'], ['runs/full'])
        self.assertEqual(rep['pooled'][0]['overall']['n'], 4)
        del full, part

    def test_restored_run_is_paired_not_double_counted_and_labelled(self):
        s = self.suite
        make_run(self.root / 'runs', 'r1', s, self.standard_records(), {'c-corrupt': True, 'c-ident': True, 'c-healthy': False, 'c-epub': True})
        make_run(self.root / 'runs', 'r1-restored', s, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        self.assertEqual([r['name'] for r in rep['runs']], ['r1'])
        rs = rep['runs'][0]['restored']
        self.assertEqual(rs['overall']['correct'], 4)
        self.assertEqual(rep['runs'][0]['overall']['correct'], 3)
        self.assertEqual(rs['tool_calls_differ_from_primary_in_cases'], [])
        self.assertNotIn('called_cases', rs['tools']['ffprobe'])
        self.assertEqual(rep['pooled'][0]['overall']['n'], 4)

    def test_restored_with_different_calls_is_reported(self):
        s = self.suite
        make_run(self.root / 'runs', 'r1', s, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        other = self.standard_records()
        other[1] = record(s, 'c-ident', calls=[call('t1', 'ocr', 'ok')])
        make_run(self.root / 'runs', 'r1-restored', s, other, dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        self.assertEqual(rep['runs'][0]['restored']['tool_calls_differ_from_primary_in_cases'], ['c-ident'])

    def test_restored_without_primary_is_listed(self):
        make_run(self.root / 'runs', 'lonely-restored', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        self.assertEqual(rep['runs'], [])
        self.assertEqual(len(rep['restored_dirs_without_primary']), 1)

    def test_integrity_flags_a_changed_case_file_and_a_capability_mismatch(self):
        s = self.suite
        recs = self.standard_records()
        recs[0]['case_sha256'] = '0' * 64
        recs[1]['evidence']['capabilities'] = [{'tool': 'ffprobe', 'offered': True}]
        make_run(self.root / 'runs', 'r1', s, recs, dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        integ = rep['runs'][0]['integrity']
        self.assertEqual(integ['case_sha256_mismatch'], ['c-corrupt'])
        self.assertEqual(integ['record_capabilities_differ_from_suite'], ['c-ident'])

    def test_a_run_on_an_unknown_suite_is_unavailable_not_a_crash(self):
        recs = [record(self.suite, c, version='other-9') for c in SUITE_CASES]
        make_run(self.root / 'runs', 'r1', self.suite, recs, dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        self.assertIn('unavailable', rep['runs'][0])
        R.finish_report(rep)                                   # still renders
        self.assertEqual(rep['pooled'], [])

    def test_run_roots_accept_a_run_dir_or_a_folder_and_ignore_dirs_without_score(self):
        make_run(self.root / 'runs', 'a', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        (self.root / 'runs' / 'notes').mkdir()
        (self.root / 'runs' / 'notes' / 'x.json').write_text('{}')
        self.assertEqual([p.name for p in R.find_run_dirs([self.root / 'runs'])], ['a'])
        self.assertEqual([p.name for p in R.find_run_dirs([self.root / 'runs' / 'a'])], ['a'])

    def test_role_comes_from_the_adapter(self):
        make_run(self.root / 'runs', 'loc', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True), adapter='ollama', model='qwen')
        make_run(self.root / 'runs', 'fro', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True), adapter='claude', model='haiku')
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        roles = {r['name']: r['meta']['role'] for r in rep['runs']}
        self.assertEqual(roles, {'fro': 'frontier', 'loc': 'local'})
        self.assertEqual([g['role'] for g in rep['pooled']], ['local', 'frontier'])


class SuitesAndNeverOffered(Base):
    def test_offer_matrix_and_never_offered(self):
        make_run(self.root / 'runs', 'r1', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        rep = R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite])
        m = rep['suites'][0]['tools']
        self.assertEqual((m['ffprobe']['cases_offering'], m['ffprobe']['cases_pre_supplied']), (3, 2))
        self.assertEqual((m['audio_sample']['cases_offering'], m['subtitle_sample']['cases_offering']), (0, 0))
        self.assertEqual(m['prior_record'], {'cases_offering': 0, 'cases_pre_supplied': 1})
        n = rep['never_offered']
        self.assertEqual(n['audio_sample']['scanned_runs']['requested'], 1)           # the not-offered request in c-corrupt
        self.assertEqual(n['audio_sample']['scanned_runs']['offered_in_capabilities'], 0)
        self.assertEqual(n['subtitle_sample']['scanned_runs']['requested'], 0)
        self.assertGreater(n['ffprobe']['scanned_runs']['offered_in_capabilities'], 0)

    def test_two_suites_with_one_version_are_refused(self):
        other = make_suite(self.root / 'suite2')
        make_run(self.root / 'runs', 'r1', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True))
        with self.assertRaises(SystemExit):
            R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite, other])

    def test_known_tools_match_the_package(self):
        import sys
        sys.path.insert(0, str(COMPONENT / 'src'))
        from media_repair_harness import protocol, remote_evidence
        self.assertEqual(tuple(R.TOOL_ORDER[:8]), tuple(protocol.TOOLS))
        self.assertEqual(set(R.TOOL_ORDER[:8]), set(protocol.TOOLS))
        self.assertEqual(R.TOOL_ORDER[8:], tuple(remote_evidence.EXTRA_TOOLS))
        self.assertEqual(set(R.CLASS_ORDER), set(protocol.CLASSES))


class Pairing(Base):
    def test_same_case_comparison_uses_only_cases_where_runs_disagree(self):
        s = self.suite
        a = self.standard_records()                                          # c-corrupt: decode_sample called; c-healthy: decode_sample offered, not called
        b = self.standard_records()
        b[0] = record(s, 'c-corrupt', refs=['e1'])                            # run b does not call decode_sample on c-corrupt
        make_run(self.root / 'runs', 'a', s, a, {'c-corrupt': True, 'c-ident': True, 'c-healthy': True, 'c-epub': True}, model='qwen')
        make_run(self.root / 'runs', 'b', s, b, {'c-corrupt': False, 'c-ident': True, 'c-healthy': True, 'c-epub': True}, model='qwen')
        rep = R.finish_report(R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite]))
        p = rep['paired'][0]['tools']
        self.assertEqual(p['decode_sample']['cases'], 1)
        self.assertEqual(p['decode_sample']['called_runs'], {'n': 1, 'correct': 1})
        self.assertEqual(p['decode_sample']['not_called_runs'], {'n': 1, 'correct': 0})
        self.assertNotIn('epub_inspect', p)                                   # both runs called it


class Outputs(Base):
    def run_cli(self, name='out'):
        make_run(self.root / 'runs', 'loc', self.suite, self.standard_records(), {'c-corrupt': True, 'c-ident': True, 'c-healthy': False, 'c-epub': True}, adapter='ollama', model='qwen')
        make_run(self.root / 'runs', 'loc-restored', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True), adapter='ollama', model='qwen')
        make_run(self.root / 'runs', 'fro', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True), adapter='claude', model='haiku')
        md, js = self.root / (name + '.md'), self.root / (name + '.json')
        rc = R.main(['--runs-root', str(self.root / 'runs'), '--suite-dir', str(self.suite), '--out-md', str(md), '--out-json', str(js)])
        self.assertEqual(rc, 0)
        return md.read_text(encoding='utf-8'), js.read_text(encoding='utf-8')

    def test_cli_writes_both_files_with_the_command_summary_and_caveats(self):
        md, js = self.run_cli()
        self.assertIn('tool_usage_report.py', md.split('## Summary')[0])
        self.assertIn('--runs-root', md.split('## Summary')[0])
        summary = md.split('## Summary')[1].split('## Caveats')[0].strip().splitlines()
        self.assertTrue(1 <= len([ln for ln in summary if ln.strip()]) <= 12)
        for needle in ('Caveats', 'Replay evidence', 'dev-tuned', 'No causal claim', 'one pass', 'Which tools a case offers'):
            self.assertIn(needle.lower(), md.lower())
        for section in ('## 1. Runs covered', '## 2.', '## 3. Local models', '## 4. Frontier', '## 5. Pooled', '## 6. By class', '## 7. identity_mismatch', '## 8. Fields'):
            self.assertIn(section, md)
        d = json.loads(js)
        self.assertEqual(d['report'], 'tool-usage-report-1')
        self.assertEqual({r['name'] for r in d['runs']}, {'loc', 'fro'})                # the restored dir is not a run of its own
        self.assertIn('c-corrupt', d['runs'][0]['cases'])
        self.assertEqual(d['runs'][0]['cases']['c-corrupt']['calls']['decode_sample']['calls'], 1)
        self.assertEqual(d['runs'][0]['cases']['c-corrupt']['requested_not_offered'], {'audio_sample': 1})

    def test_output_is_deterministic(self):
        md1, js1 = self.run_cli('one')
        md2, js2 = R.Path(self.root / 'one.md').read_text(), R.Path(self.root / 'one.json').read_text()
        R.main(['--runs-root', str(self.root / 'runs'), '--suite-dir', str(self.suite), '--out-md', str(self.root / 'two.md'), '--out-json', str(self.root / 'two.json')])
        # the command line differs only in the output names; everything else is byte-identical
        a = (self.root / 'two.md').read_text().replace('two.', 'one.')
        self.assertEqual(a, md2)
        self.assertEqual((self.root / 'two.json').read_text().replace('two.', 'one.'), js2)

    def test_summary_has_no_local_section_message_without_local_runs(self):
        make_run(self.root / 'runs', 'fro', self.suite, self.standard_records(), dict.fromkeys(SUITE_CASES, True), adapter='claude', model='haiku')
        rep = R.finish_report(R.build_report(R.find_run_dirs([self.root / 'runs']), [self.suite]))
        self.assertEqual(len(rep['summary']), 1)
        self.assertIn('No full local-model run', rep['summary'][0])

    def test_script_has_no_network_process_or_model_imports(self):
        tree = ast.parse((COMPONENT / 'scripts' / 'tool_usage_report.py').read_text(encoding='utf-8'))
        banned = {'socket', 'subprocess', 'urllib', 'http', 'requests', 'ssl', 'asyncio', 'multiprocessing', 'ftplib', 'smtplib', 'ctypes'}
        imported = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                imported.update(a.name.split('.')[0] for a in n.names)
            elif isinstance(n, ast.ImportFrom):
                imported.add((n.module or '').split('.')[0])
        self.assertFalse(imported & banned, imported & banned)
        self.assertFalse({'os', 'shutil'} & imported)          # no environment, no process, no file moves
        src = (COMPONENT / 'scripts' / 'tool_usage_report.py').read_text(encoding='utf-8')
        for word in ('os.system', 'Popen', 'urlopen', 'cache/media-repair-harness'):
            self.assertNotIn(word, src, word)


class Committed(unittest.TestCase):
    """The committed report is what the committed command produces from the committed records (needs the public suites)."""

    def test_committed_json_reproduces(self):
        committed = COMPONENT / 'docs' / 'tool-usage-report.json'
        suites = [ASSESS / 'suite-dev-v1.1', ASSESS / 'suite']
        if not committed.is_file() or not all(s.is_dir() for s in suites):
            if os.environ.get('MRH_REQUIRE_SUITE') == '1':
                self.fail('the committed report or a public suite is missing')
            self.skipTest('committed report or public suites absent')
        want = json.loads(committed.read_text(encoding='utf-8'))
        cmd = want['command']
        # recover the arguments from the recorded command: it is the exact command line that was run from the repo root
        toks = cmd.replace('\\\n', ' ').split()
        args = []
        for i, t in enumerate(toks):
            if t in ('--runs-root', '--suite-dir'):
                args += [t, toks[i + 1]]
        self.assertTrue(args)
        with tempfile.TemporaryDirectory() as tmp:
            md, js = Path(tmp) / 'r.md', Path(tmp) / 'r.json'
            # the recorded paths are repo relative, so the report must be produced from the repo root with the same relative arguments
            old = os.getcwd()
            os.chdir(REPO)
            try:
                R.main(args + ['--out-md', str(md), '--out-json', str(js)])
            finally:
                os.chdir(old)
            got = json.loads(js.read_text(encoding='utf-8'))
        got.pop('command')
        want.pop('command')
        self.assertEqual(got, want)


if __name__ == '__main__':
    unittest.main()
