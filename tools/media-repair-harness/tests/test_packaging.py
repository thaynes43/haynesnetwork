"""Packaging contract: pinned versions and prompt digests, the vendored EPUB module, package data, suite-required behaviour and the
self-containment of the Job bundles.  No ffmpeg, no network."""
import base64
import hashlib
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import th
from media_repair_harness import protocol as P
from media_repair_harness import score_compat, vendored_epub

PKG = Path(P.__file__).resolve().parent
COMPONENT = th.COMPONENT

# Digests of what the model is sent, taken from the frozen dev-c2 candidate (e27f2385) before the move into the package.  The full
# replay-identity comparison lives in test_wiring.ReplayIdentity; these are the short, explicit pins.
HARNESS_VERSION = 'dev-c8'   # dev-c8 (WO-W26): prompt v8 / turn-v3.1, guards v4 and claude-schema-1 added; every earlier prompt, format and guard unchanged
PROMPT_SHA256 = {'v1': '30749f5dc7065a2ddd70967cd6888e91d237030e1b025bc6dac19ca51fed9ee8',
                 'v2': '351f40fd20e548b675b8678b62d56bda727976b20b2427fcb1fbdefa4138533a'}
GOLDEN_SHA256 = '8f4f17373e857c90509b4768f426b668b520683c8c353993028f771f8eb2e411'
PROMPT_FILE_SHA256 = {'v2.txt': 'b63a9e9b5558a1f1fbb94fcdd8624d1c3e46f8990a3af2d2a00c0a480521ec04'}
# dev-c3 added prompts/v3.txt (new text, same turn protocol as v2).  Pinned so a stray edit shows up; v1 and v2 above stay byte-identical.
V3_FILE_SHA256 = '6e53ac6e0964e6f427569ab1f4ef6e0b679f6877ec84af8cf7199d5cc4019d1e'
V4_FILE_SHA256 = '48bad0e41baa113df432545566a34d3bc0d01e2c5bd0f27fe0bcedb923c73a8a'   # dev-c4: prompts/v4.txt, the text measured in runs/dev-c4
V5_FILE_SHA256 = '4db2a64ccba83d2ae2fe3d6da9843369d49676019e39519a50464c8ad128e863'   # dev-c5: prompts/v5.txt, the text measured in runs/dev-c5 (frozen by its PREREGISTRATION.md)
# dev-c6: prompts/v6.txt (contract v3), pinned in tests/test_v6.py and frozen by runs/dev-c6/PREREGISTRATION.md; v1 to v5 are untouched
V3_SENT_SHA256 = 'b1fd9e855839'   # prefix of the sha256 the dev-c3 runs record as prompt.sha256 (prompt text sent, one trailing newline removed)


class Pinned(unittest.TestCase):
    def test_harness_version_is_unchanged(self):
        self.assertEqual(P.HARNESS_VERSION, HARNESS_VERSION)

    def test_model_visible_prompts_are_byte_identical_to_dev_c2(self):
        for v, want in PROMPT_SHA256.items():
            self.assertEqual(P.get_prompt(v)['sha256'], want, v)

    def test_prompt_resource_files_are_byte_identical_to_dev_c2(self):
        files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(P.PROMPT_DIR.iterdir()) if p.is_file()}
        v3 = files.pop('v3.txt')
        v4 = files.pop('v4.txt')
        v5 = files.pop('v5.txt')
        files.pop('v6.txt')     # dev-c6 (pinned in test_v6.py)
        files.pop('v7.txt')     # dev-c7 (pinned in test_devc7.py)
        files.pop('v8.txt')     # dev-c8 (pinned in test_devc8.py)
        self.assertEqual(files, PROMPT_FILE_SHA256)   # v2.txt (and v1, which lives in protocol.py) are the dev-c2 bytes
        self.assertEqual(v3, V3_FILE_SHA256)
        self.assertEqual(v4, V4_FILE_SHA256)   # dev-c4 added v4.txt; v1, v2 and v3 are untouched
        self.assertEqual(v5, V5_FILE_SHA256)   # dev-c5 added v5.txt; v1 to v4 are untouched
        self.assertTrue(P.get_prompt('v3')['sha256'].startswith(V3_SENT_SHA256))


class GoldenUnchanged(unittest.TestCase):
    def test_replay_identity_golden_is_the_unmodified_dev_c1_file(self):
        golden = th.TESTDATA / 'replay-identity-dev-c1.json'
        self.assertEqual(hashlib.sha256(golden.read_bytes()).hexdigest(), GOLDEN_SHA256)


class PackageData(unittest.TestCase):
    def setUp(self):
        self.cfg = tomllib.loads((COMPONENT / 'pyproject.toml').read_text())

    def test_stdlib_only_and_python_floor(self):
        self.assertEqual(self.cfg['project']['dependencies'], [])
        self.assertEqual(self.cfg['project']['requires-python'], '>=3.11')

    def test_prompt_dir_is_inside_the_package_and_covered_by_package_data(self):
        self.assertEqual(P.PROMPT_DIR, PKG / 'prompts')
        patterns = self.cfg['tool']['setuptools']['package-data']['media_repair_harness']
        for f in P.PROMPT_DIR.iterdir():
            self.assertTrue(any(f.relative_to(PKG).match(pat) for pat in patterns), f.name)

    def test_remote_sampler_resource_is_a_package_module(self):
        from media_repair_harness import tools
        self.assertEqual(tools.REMOTE_SAMPLER, PKG / 'remote_sampler.py')
        self.assertTrue(tools.REMOTE_SAMPLER.is_file())

    def test_console_entry_points_resolve(self):
        import importlib
        for name, target in self.cfg['project']['scripts'].items():
            mod, func = target.split(':')
            self.assertTrue(callable(getattr(importlib.import_module(mod), func)), name)


class VendoredEpub(unittest.TestCase):
    """tools.py used to import .agents/context/media-repair-actual-epub-2026-10-18/epub.py by path; it is now vendored verbatim."""
    MARK = b'# ---- BEGIN VERBATIM ----\n'

    def vendored(self):
        return Path(vendored_epub.__file__).read_bytes()

    def split(self):
        data = self.vendored()
        head, sep, body = data.partition(self.MARK)
        self.assertTrue(sep, 'the verbatim marker is missing from the vendored copy')
        return head.decode(), body

    def test_header_names_the_source_and_its_sha256_and_matches_the_body(self):
        head, body = self.split()
        self.assertIn('.agents/context/media-repair-actual-epub-2026-10-18/epub.py', head)
        line = [l for l in head.splitlines() if l.startswith('# Source sha256: ')]
        self.assertEqual(len(line), 1)
        self.assertEqual(line[0].split(': ', 1)[1], hashlib.sha256(body).hexdigest(), 'header sha256 does not describe the vendored body')

    def test_vendored_copy_matches_the_source_while_the_source_exists(self):
        src = th.EPUB_SOURCE
        if not src.is_file():
            if os.environ.get('MRH_REQUIRE_SUITE') == '1':
                self.fail('EPUB source %s is missing and MRH_REQUIRE_SUITE=1 forbids skipping' % src)
            self.skipTest('EPUB source not present (%s)' % src)
        _, body = self.split()
        self.assertEqual(hashlib.sha256(src.read_bytes()).hexdigest(), hashlib.sha256(body).hexdigest(),
                         'epub.py and the vendored copy diverged: re-vendor it (copy the file, update the sha256 in the header)')
        self.assertEqual(src.read_bytes(), body)

    def test_divergence_check_would_fail_on_a_changed_copy(self):
        _, body = self.split()
        self.assertNotEqual(hashlib.sha256(body + b'\n# edit\n').hexdigest(), hashlib.sha256(body).hexdigest())

    def test_tools_uses_the_vendored_module_not_a_path(self):
        from media_repair_harness import tools
        self.assertIs(tools._epub_module(), vendored_epub)
        self.assertFalse(hasattr(tools, 'EPUB_MODULE'))

    def test_inspect_runs_on_a_testdata_epub(self):
        d = vendored_epub.inspect(th.TESTDATA / 'fixtures' / 'td-right.epub')
        self.assertTrue(d['zip_crc_ok'])
        self.assertGreater(d['spine_items'], 0)


class RequireSuite(unittest.TestCase):
    def test_missing_suite_skips_by_default_and_fails_when_required(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.object(th, 'SUITE', Path(t)):
            with mock.patch.dict(os.environ, {'MRH_REQUIRE_SUITE': ''}):
                with self.assertRaises(unittest.SkipTest):
                    th.require_suite()
            with mock.patch.dict(os.environ, {'MRH_REQUIRE_SUITE': '1'}):
                with self.assertRaises(AssertionError):
                    th.require_suite()

    def test_present_suite_passes_either_way(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.object(th, 'SUITE', Path(t)):
            (Path(t) / 'cases').mkdir()
            (Path(t) / 'cases' / 'x.json').write_text('{}')
            with mock.patch.dict(os.environ, {'MRH_REQUIRE_SUITE': '1'}):
                self.assertEqual(th.require_suite(), Path(t))

    def test_decorator_applies_to_methods_and_classes(self):
        calls = []

        @th.needs_suite
        def method():
            calls.append(1)

        with tempfile.TemporaryDirectory() as t, mock.patch.object(th, 'SUITE', Path(t)), mock.patch.dict(os.environ, {'MRH_REQUIRE_SUITE': '1'}):
            with self.assertRaises(AssertionError):
                method()

            @th.needs_suite
            class C(unittest.TestCase):
                def test_x(self):
                    pass
            with self.assertRaises(AssertionError):
                C.setUpClass()
        self.assertEqual(calls, [])

    def test_default_suite_location_is_repo_relative(self):
        self.assertEqual(th.DEFAULT_SUITE, th.REPO_ROOT / '.agents' / 'context' / 'media-repair-harness-2026-10-19' / 'suite')


class ScorerByPath(unittest.TestCase):
    def test_env_override_wins(self):
        with mock.patch.dict(os.environ, {'MRH_SCORE_PY': '/x/score.py'}):
            self.assertEqual(score_compat.score_path(), Path('/x/score.py'))

    def test_loading_leaves_no_global_aliases_behind(self):
        before = ('protocol' in sys.modules, 'run' in sys.modules, list(sys.path))
        try:
            score_compat.load_score()
        except FileNotFoundError:
            self.skipTest('score.py not present in this tree')
        self.assertEqual(('protocol' in sys.modules, 'run' in sys.modules, list(sys.path)), before)


class JobBundles(unittest.TestCase):
    """The bundles shipped inside the live-smoke Job specs must carry everything the smoke scripts import (checked without ffmpeg)."""

    def extract(self, bundle):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        tarfile.open(fileobj=io.BytesIO(base64.b64decode(bundle)), mode='r:*').extractall(tmp.name)
        return Path(tmp.name)

    def run_py(self, root, code, cwd=None):
        env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        r = subprocess.run([sys.executable, '-I', '-c', code], cwd=str(cwd or root), env=dict(env, PYTHONPATH=str(root)), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        return r.stdout

    def test_evidence_smoke_bundle_imports_standalone(self):
        sys.path.insert(0, str(COMPONENT / 'smoke'))
        try:
            import launch_smoke
            root = self.extract(launch_smoke.bundle())
        finally:
            sys.path.remove(str(COMPONENT / 'smoke'))
        self.run_py(root, "import sys; sys.path.insert(0, 'smoke'); import live_smoke; assert live_smoke.evidence.collect")

    def test_wiring_smoke_bundle_imports_standalone_and_stays_under_the_env_limit(self):
        sys.path.insert(0, str(COMPONENT / 'smoke'))
        try:
            import launch_wiring_smoke
            data = launch_wiring_smoke.bundle()
            root = self.extract(data)
        finally:
            sys.path.remove(str(COMPONENT / 'smoke'))
        self.assertEqual(launch_wiring_smoke.MAX_ARG_STRLEN, 131072)   # the real Linux single-string limit
        # the package outgrew one environment string when evidence_v2 joined it: the bundle now travels in parts, each under the limit, that join to the whole
        parts = launch_wiring_smoke.bundle_parts(data)
        self.assertGreaterEqual(len(parts), 1)
        self.assertEqual(''.join(parts), data)
        for part in parts:
            self.assertLess(len(part), launch_wiring_smoke.MAX_ARG_STRLEN - 4096)
        self.assertIn('evidence_v2.py', launch_wiring_smoke.FILES)
        self.assertLessEqual(len(data), launch_wiring_smoke.TOTAL_LIMIT)      # the apply annotation limit is 262144 bytes
        self.assertLessEqual(launch_wiring_smoke.TOTAL_LIMIT, 240000)
        import base64 as b64
        self.assertEqual(b64.b64decode(data)[:2], b'\x1f\x8b')                # gzip: no lzma dependency in the Job image
        self.run_py(root, "import sys; sys.path.insert(0, 'smoke'); import wiring_smoke; assert wiring_smoke.R.main; assert wiring_smoke.LS.evidence")


class OutOfTreeImport(unittest.TestCase):
    def test_importing_from_a_directory_outside_the_checkout_with_only_pythonpath_set(self):
        with tempfile.TemporaryDirectory() as cwd:
            env = dict(os.environ, PYTHONPATH=str(COMPONENT / 'src'), PYTHONDONTWRITEBYTECODE='1')
            code = "import media_repair_harness.run as r, media_repair_harness.protocol as p; print(p.HARNESS_VERSION, p.get_prompt('v2')['sha256'])"
            out = subprocess.run([sys.executable, '-c', code], cwd=cwd, env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr[-1500:])
            self.assertEqual(out.stdout.split(), [HARNESS_VERSION, PROMPT_SHA256['v2']])


if __name__ == '__main__':
    unittest.main()
