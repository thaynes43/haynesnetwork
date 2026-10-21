"""Stage R G0a pre-registration (OpenProject #160; runs/stage-r-pilot-1/): the registration digest, the six case template digests, the registered config
hash and the sampler sha256 are pinned; the Stage R driver accepts the registration as committed; and the committed leak-guard output and offline
validation (fake runners only: no model, no cluster, no media) reproduce byte for byte from this code.

These pins freeze G0a.  A change to the registration, a template, the harness configuration or the driver's behaviour fails here on purpose: it needs a
new G0a (pilot plan v3.2 section 4.4: a new attempt needs a new G0a and new approvals), never a silent re-pin."""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

import th
from media_repair_harness import remote_evidence as RE

RUN = th.COMPONENT / 'runs' / 'stage-r-pilot-1'
SCRIPTS = th.COMPONENT / 'scripts'


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


G = _load('stage_r_g0a')
D = G.D

REGISTRATION_SHA256 = 'd16c4a6fd9d6cd7b6a3eab99508b1dbfe47a8cbb304d5d89529c7e52240532d8'
CONFIG_HASH = 'ead303989e397a02a96aa504e872f1369c72328e9d4dae3922c26fe51a34be56'
SAMPLER_SHA256 = '870f1f98979aeb42b199e4473a359ca107d6e7942cdb02f33e8b1fe8f899f885'
TEMPLATE_SHA256 = {'s03e36': 'd03bbcf0936d0a6dbd0fadd868a3a37dc9329ef67dc8c4e4b5a637b05fcb6ce1',
                   's03e38': '154fcd065de78721f85f04bfd1309cdc828e2792644b3c6fca7a8571379ae62b',
                   's20e114': '6f5bbd20a6ea2819c738996c7a1ca888e18b95eae007ce97358d43bfed3e4a73',
                   's03e01': '62cef53e4f99a3117f3041c822253a1a63961c8991c33d883ec4b2130fe1c160',
                   's03e02': 'a1c93db0d5cdc9fdc74805b377fb3a25d94ae96877b5a0adc4d3b5f062b74d6e',
                   's03e08': '2ac70a81c2165fff6c0627c0829418cd1aa3eba6485721132c1f85974e3776aa'}
ROLES = {'s03e36': 'offender', 's03e38': 'offender', 's20e114': 'verified', 's03e01': 'verified', 's03e02': 'verified', 's03e08': 'held'}


class Pins(unittest.TestCase):
    def setUp(self):
        self.reg = G.load()

    def test_registration_digest(self):
        self.assertEqual(D.canonical_sha256(self.reg), REGISTRATION_SHA256)
        for name in ('leakguard-g0a.json', 'offline-validation.json'):
            self.assertEqual(json.loads((RUN / name).read_text())['registration_sha256'], REGISTRATION_SHA256, name)

    def test_template_digests(self):
        got = {k: hashlib.sha256((RUN / 'cases' / (k + '.json')).read_bytes()).hexdigest() for k in TEMPLATE_SHA256}
        self.assertEqual(got, TEMPLATE_SHA256)
        self.assertEqual({t['key']: t['case_template_sha256'] for t in self.reg['targets']}, TEMPLATE_SHA256)
        self.assertEqual(D.template_digests(self.reg, RUN), TEMPLATE_SHA256)            # what the driver records as case_templates_sha256
        self.assertEqual(sorted(p.name for p in (RUN / 'cases').iterdir()), sorted(k + '.json' for k in TEMPLATE_SHA256))

    def test_config_hash_and_sampler(self):
        self.assertEqual(G.config_hash(G.registered_config(self.reg)), CONFIG_HASH)
        self.assertEqual(self.reg['expected_config_hash']['first_g2_target'], CONFIG_HASH)
        self.assertEqual(RE.sampler_sha256(), SAMPLER_SHA256)
        self.assertEqual(self.reg['sampler']['sha256'], SAMPLER_SHA256)
        self.assertEqual(G.registered_config(self.reg)['remote_evidence']['sampler_sha256'], SAMPLER_SHA256)
        # a later target's config differs only in the cost remainder the driver passes
        later = G.registered_config(self.reg, remaining_usd=7.25)
        self.assertEqual(later['limits']['max_total_cost_usd'], 7.25)
        self.assertEqual(G._without_remainder(later), G._without_remainder(G.registered_config(self.reg)))


class DriverAcceptsTheRegistration(unittest.TestCase):
    def test_validates_and_constructs(self):
        reg = G.load()
        self.assertEqual(D.validate_registration(reg, RUN)[0], [])
        self.assertEqual(D.load_registration(RUN / 'registration.json'), reg)
        d = D.Driver(reg, RUN / 'never-written', runner=lambda *a, **k: None, harness=lambda argv: 0, commit=G.fake_commit, template_dir=RUN)
        self.assertEqual(d.state['registration_sha256'], REGISTRATION_SHA256)
        self.assertEqual(d.state['case_templates_sha256'], TEMPLATE_SHA256)
        self.assertFalse((RUN / 'never-written').exists())

    def test_g0a_contents(self):
        reg = G.load()
        self.assertEqual({t['key']: t['role'] for t in reg['targets']}, ROLES)
        self.assertEqual([t['key'] for t in reg['targets'] if t.get('marker')], ['s03e01', 's03e02'])
        self.assertEqual((reg['exec']['target'], reg['exec']['container'], reg['pod_resolution']['uid_recorded_at']), ('deploy/bazarr', 'app', 'G0b'))
        self.assertEqual(reg['discovery']['season_dirs'], {'s03': '^Season 0?3$', 's20': '^Season 20$'})
        self.assertEqual((reg['model'], reg['guards'], reg['tools_behavior'], reg['stop_on_receipt_failure']), ('claude-opus-5-5', 'v3', RE.VERSION, True))
        self.assertEqual(reg['early_stop_roles'], ['offender'])
        self.assertEqual(reg['limits'], {'target_wall_s': 600, 'stage_wall_s': 7200, 'total_cost_usd': 10.0, 'g2_operations': 6})
        self.assertEqual(reg['tools_available'], list(D.STAGE_R_TOOLS))

    def test_templates_carry_no_label(self):
        reg = G.load()
        for t in reg['targets']:
            case = json.loads((RUN / t['case_template']).read_text())
            for k in ('truth', 'supported_actions', 'solvable', 'family', 'provenance', 'fixture', 'role'):
                self.assertNotIn(k, case, t['key'])
            text = (RUN / t['case_template']).read_text().lower()
            for term in G.label_terms(reg, t['key']):
                self.assertNotIn(term.lower(), text, (t['key'], term))


class CommittedOutputsReproduce(unittest.TestCase):
    """The leak guard and the offline validation are re-run here (fake runners only, about a second) and must equal the committed files."""

    def test_leakguard_output(self):
        got = json.loads(json.dumps(G.leakguard(G.load()), sort_keys=True, ensure_ascii=False))
        self.assertEqual(got, json.loads((RUN / 'leakguard-g0a.json').read_text()))
        self.assertEqual(got['result'], 'pass')

    def test_offline_validation_output(self):
        got = json.loads(json.dumps(G.validate(G.load()), sort_keys=True, ensure_ascii=False))
        committed = json.loads((RUN / 'offline-validation.json').read_text())
        self.assertEqual(got, committed)
        self.assertEqual(got['result'], 'pass')
        self.assertEqual(got['registered_config_hash_first_target'], CONFIG_HASH)
        for s in got['scenarios']:
            self.assertEqual(s['real_operations']['path_tripwire_hits'], [], s['scenario'])
        gap = next(s for s in got['scenarios'] if s['scenario'] == 'gap_documented_layout')
        self.assertEqual((gap['sampler_exec_calls'], gap['exec_modes'], gap['stop']['kind']), (1, ['list'], 'discovery'))


if __name__ == '__main__':
    unittest.main()
