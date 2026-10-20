"""The corrected dev suite `dev-v1.1` (evaluator rulings 2026-10-20): validator, derivation from dev-v1, rule coverage, and a leak-guard sweep.

dev-v1 stays frozen; every v1.1 case is derived from it by `suite-dev-v1.1/build_v11.py`.  These tests need the public dev suites (a missing one SKIPS,
or FAILS when MRH_REQUIRE_SUITE=1, like the other suite tests).
"""
import copy
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path

from media_repair_harness import leakguard as L
from media_repair_harness import protocol as P
from media_repair_harness import run as R
from media_repair_harness import tools as T
import th

CTX = th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19'
V1 = th.SUITE
V11 = CTX / 'suite-dev-v1.1'
NO_BINARIES = lambda name: None
WRITE = {'blocklist_and_search', 'remap', 'rename', 'convert'}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def need():
    th.require_suite()
    if not (V11 / 'cases').is_dir():
        if th.os.environ.get('MRH_REQUIRE_SUITE') == '1':
            raise AssertionError('dev-v1.1 suite not found at %s' % V11)
        raise unittest.SkipTest('dev-v1.1 suite not found')


def cases(d):
    return {p.stem: json.loads(p.read_text()) for p in sorted((Path(d) / 'cases').glob('*.json'))}


class Suite11(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        need()
        cls.sv = load_module('suite_v11', V11 / 'suite.py')
        cls.build = load_module('build_v11', V11 / 'build_v11.py')
        cls.v1, cls.v11 = cases(V1), cases(V11)

    def test_validate_passes_with_no_errors(self):
        errors, _, good, _ = self.sv.validate(V11)
        self.assertEqual(errors, [])
        self.assertEqual(len(good), 73)
        self.assertEqual(self.sv.VERSION, 'dev-v1.1')

    def test_cases_are_exactly_what_the_builder_derives_from_dev_v1(self):
        _, out, _ = self.build.build()
        for cid, c in out.items():
            self.assertEqual((V11 / 'cases' / (cid + '.json')).read_text(), self.build.dumps(c), cid)
        self.assertEqual(sorted(out), sorted(self.v11))

    def test_dev_v1_is_untouched_and_ids_match(self):
        self.assertEqual(sorted(self.v1), sorted(self.v11))
        self.assertTrue(all(c['suite_version'] == 'dev-v1' for c in self.v1.values()))
        self.assertTrue(all(c['suite_version'] == 'dev-v1.1' for c in self.v11.values()))

    def test_fixtures_are_byte_identical_to_dev_v1(self):
        self.assertTrue((V11 / 'fixtures').is_symlink() and (V11 / 'fixtures').resolve() == (V1 / 'fixtures').resolve())
        m1, m11 = json.loads((V1 / 'manifest.json').read_text()), json.loads((V11 / 'manifest.json').read_text())
        self.assertEqual(m1['fixtures'], m11['fixtures'])
        self.assertEqual(m1['external_fixtures'], m11['external_fixtures'])
        for cid, c in self.v11.items():
            for k in ('id', 'split', 'media_type', 'family', 'solvable', 'fixture', 'provenance', 'inject_tool_failure', 'outcome_step'):
                self.assertEqual(c.get(k), self.v1[cid].get(k), (cid, k))

    def test_every_difference_is_explained_by_a_correction(self):
        by_attr = {
            'truth': ('C2', 'C3', 'C6-2'),
            'supported_actions': ('C2', 'C3', 'C6-2', 'C6-4', 'C6-5', 'C6-7', 'C6-8', 'C6-11'),
            'accepted_classes': ('C3', 'C6-11', 'C6-12', 'C6-13'),
            'tools_available': ('C5',),
            'evidence': ('C1', 'C6-fn'),
        }
        for cid, c in self.v11.items():
            a = self.v1[cid]
            have = {x.split(':')[0] for x in c.get('corrections', [])}
            for attr, rules in by_attr.items():
                if a.get(attr) != c.get(attr):
                    self.assertTrue(have & set(rules), (cid, attr, sorted(have)))
            ca, cb = copy.deepcopy(a['context']), copy.deepcopy(c['context'])
            if ca.get('filename') != cb.get('filename'):
                self.assertIn('C6-fn', have, cid)
            arr_a, arr_b = ca.pop('arr'), cb.pop('arr')
            if arr_a != arr_b:
                self.assertTrue(have & {'C1', 'C6-3'}, cid)
            ca.pop('filename', None), cb.pop('filename', None)
            self.assertEqual(ca, cb, 'context other than arr and filename must not change: ' + cid)

    def test_rule_counts(self):
        n = {}
        for c in self.v11.values():
            for x in c.get('corrections', []):
                n[x.split(':')[0]] = n.get(x.split(':')[0], 0) + 1
        self.assertEqual({k: n[k] for k in ('C1', 'C2', 'C3', 'C5')}, {'C1': 36, 'C2': 6, 'C3': 1, 'C5': 45})
        self.assertEqual(sum(1 for c in self.v1.values() if 'audio_sample' in c['tools_available']), 45)

    def test_shape_and_labels(self):
        k = {}
        for c in self.v11.values():
            k[c['truth']['class']] = k.get(c['truth']['class'], 0) + 1
        self.assertEqual(k, {'identity_mismatch': 14, 'corrupt_file': 21, 'decoder_incompatible': 5, 'metadata_naming': 5, 'order_edition_ambiguity': 3,
                             'insufficient_evidence': 12, 'healthy': 13})
        for cid in ('audiobook-healthy-001', 'epub-healthy-001', 'epub-healthy-002', 'movie-healthy-001', 'movie-healthy-002', 'tv-healthy-001'):
            c = self.v11[cid]
            self.assertEqual((c['truth']['class'], c['truth']['source'], c['supported_actions']), ('insufficient_evidence', 'human_adjudication', ['escalate']), cid)
        c = self.v11['epub-healthy-005']
        self.assertEqual((c['truth']['class'], c['accepted_classes'], c['supported_actions']), ('metadata_naming', ['metadata_naming', 'healthy'], ['rename', 'none', 'escalate']))
        for cid, acc in (('audiobook-order-001', ['order_edition_ambiguity', 'healthy']), ('audiobook-insuff-001', ['insufficient_evidence', 'metadata_naming']),
                         ('movie-insuff-001', ['insufficient_evidence', 'order_edition_ambiguity'])):
            self.assertEqual(self.v11[cid]['accepted_classes'], acc)
        self.assertEqual(self.v11['tv-identity-001']['supported_actions'], ['blocklist_and_search', 'escalate'])   # remap is not supported (C6-8)
        self.assertEqual(self.v11['epub-insuff-002']['truth']['class'], 'identity_mismatch')
        # a healthy truth never carries tools-free, identity-record-only evidence (C2), and only healthy truths are negative controls
        for c in self.v11.values():
            if c['truth']['class'] == 'healthy':
                self.assertTrue(c['tools_available'] and any(e['tool'] != 'prior_record' for e in c['evidence']), c['id'])

    def test_managing_app_and_no_readarr(self):
        for cid, c in self.v11.items():
            app = c['context']['arr']['app']
            if c['media_type'] in ('epub', 'audiobook'):
                self.assertEqual(app, 'lazylibrarian', cid)
            if set(c['supported_actions']) & WRITE:
                self.assertIsNotNone(app, cid)
            visible = json.dumps([c['context'], c['evidence'], c['tools_available']], ensure_ascii=False).lower()
            self.assertNotIn('readarr', visible, cid)
            self.assertNotIn('audio_sample', c['tools_available'])
        self.assertEqual(self.v11['movie-identity-001']['context']['arr']['app'], 'radarr')
        self.assertEqual(self.v11['tv-identity-001']['context']['arr']['app'], 'sonarr')
        self.assertEqual(self.v11['epub-identity-005']['context']['arr']['expected_toc'], ['Chapter 1: Rain', 'Chapter 2: Salt', 'Chapter 3: Lanterns'])

    def test_filename_change_keeps_the_arr_record_consistent_and_bytes_unchanged(self):
        changed = [cid for cid, c in self.v11.items() if c['context'].get('filename') != self.v1[cid]['context'].get('filename')]
        self.assertEqual(len(changed), 12)
        for cid in changed:
            c = self.v11[cid]
            self.assertIn(c['truth']['class'], ('corrupt_file', 'decoder_incompatible', 'identity_mismatch'))
            rp = [m for e in c['evidence'] if e['tool'] == 'arr_lookup' for m in re.findall(r'"relativePath":"([^"]*)"', e['output'])]
            if rp:
                self.assertEqual(rp, [c['context']['filename']], cid)

    def test_leak_guard_sweep_over_the_corrected_cases(self):
        """The corrected cases leak nothing new: first request and every replay tool output pass the guard (the dev-v1 sweep is in test_leakguard)."""
        calls = 0
        for c in self.v11.values():
            ctx = T.Context(c, T.Fixture.from_case(c, V11), tempfile.mkdtemp(), suite_dir=V11, which=NO_BINARIES)
            ev = R.resolve_evidence(c, V11, ctx.redact)
            text = json.dumps(P.case_view(c, ev, case_alias=L.alias('run-x', c['id'])), sort_keys=True, ensure_ascii=False)
            L.check_messages(c, [{'role': 'user', 'content': text}], ctx.forbidden_extra)
            for tool in c['tools_available']:
                for args in ({}, {'at': 0}, {'at': 4}, {'t': 'full'}):
                    r = T.call_tool(ctx, tool, args)
                    calls += 1
                    L.check_messages(c, [{'role': 'user', 'content': R.result_message('t1', tool, r, 5)}], ctx.forbidden_extra)
        self.assertGreater(calls, 500)

    def test_audio_sample_is_not_offered_anywhere_and_would_have_been_unavailable(self):
        c = self.v1['movie-healthy-003']
        ctx = T.Context(c, T.Fixture.from_case(c, V1), tempfile.mkdtemp(), suite_dir=V1, which=NO_BINARIES)
        r = T.call_tool(ctx, 'audio_sample', {'at': 0})
        self.assertEqual(r['status'], 'unavailable')                 # why C5 removes the offer


class ValidatorNegatives(unittest.TestCase):
    """The v1.1 validator rejects each thing the rulings forbid."""

    @classmethod
    def setUpClass(cls):
        need()
        cls.sv = load_module('suite_v11n', V11 / 'suite.py')
        cls.v11 = cases(V11)

    def errors(self, c):
        errs, notes = [], []
        self.sv.check_case(V11, Path(c['id'] + '.json'), c, errs, notes)
        return errs

    def test_baseline_cases_have_no_errors(self):
        for c in self.v11.values():
            self.assertEqual(self.errors(c), [], c['id'])

    def test_healthy_with_no_tools_and_only_an_identity_record(self):
        c = copy.deepcopy(self.v11['movie-healthy-001'])
        c['truth'] = {'class': 'healthy', 'source': 'human_adjudication', 'ref': 'x' * 30}
        c['supported_actions'] = ['none']
        self.assertTrue(any('C2' in e for e in self.errors(c)))

    def test_audio_sample_without_recorded_data(self):
        c = copy.deepcopy(self.v11['movie-corrupt-001'])
        c['tools_available'].append('audio_sample')
        self.assertTrue(any('C5' in e for e in self.errors(c)))

    def test_readarr_like_and_wrong_app(self):
        c = copy.deepcopy(self.v11['epub-corrupt-001'])
        c['evidence'][1]['args']['app'] = 'readarr-like'
        self.assertTrue(any('readarr' in e for e in self.errors(c)))
        c = copy.deepcopy(self.v11['epub-corrupt-001'])
        c['context']['arr']['app'] = None
        self.assertTrue(any('lazylibrarian' in e for e in self.errors(c)))
        c = copy.deepcopy(self.v11['movie-identity-001'])
        c['context']['arr']['app'] = None
        self.assertTrue(any('needs context.arr.app' in e for e in self.errors(c)))

    def test_accepted_classes_and_corrections_shape(self):
        c = copy.deepcopy(self.v11['audiobook-order-001'])
        c['accepted_classes'] = ['healthy']
        self.assertTrue(any('accepted_classes' in e for e in self.errors(c)))
        c = copy.deepcopy(self.v11['audiobook-order-001'])
        c['supported_actions'] = ['escalate', 'none']
        c['accepted_classes'] = ['order_edition_ambiguity']
        self.assertTrue(any("'none' cannot be combined" in e for e in self.errors(c)))
        c = copy.deepcopy(self.v11['audiobook-order-001'])
        c['corrections'] = ['no rule id here']
        self.assertTrue(any('corrections' in e for e in self.errors(c)))


if __name__ == '__main__':
    unittest.main()
