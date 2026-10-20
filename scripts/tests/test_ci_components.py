"""Routing and finalizer tests for scripts/ci-components.py (ADR-116). Stdlib only; runs locally and in CI as the
`ci-routing-tests` job that the required `test` context waits for.

    python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "ci-components.py"

_spec = importlib.util.spec_from_file_location("ci_components", SCRIPT)
cc = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["ci_components"] = cc  # dataclasses looks its module up here
_spec.loader.exec_module(cc)

H = ".agents/context/media-repair-harness-2026-10-19"
E = ".agents/context/media-repair-actual-epub-2026-10-18"


def probe(paths):
    """The real image rule, so these tests also pin the delegation to ci-code-paths.sh."""
    return cc.image_probe_factory()(paths)


def route(*paths):
    return cc.classify_paths(list(paths), probe)


def sel(d):
    return (d.site, d.harness)


class ClassifyPath(unittest.TestCase):
    def check(self, expected, *paths):
        for p in paths:
            with self.subTest(path=p):
                self.assertEqual(cc.classify_path(p), expected)

    def test_site(self):
        self.check(
            cc.SITE,
            "apps/web/app/(app)/library/page.tsx",
            "packages/domain/src/books/push.ts",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "Dockerfile",
            ".dockerignore",
            "eslint.config.mjs",
            "tsconfig.base.json",
            "release-please-config.json",
            ".agents/owed-checks.yaml",
            ".agents/books-census-holds.yaml",
            "scripts/lint-css-hex.mjs",
        )

    def test_harness(self):
        self.check(
            cc.HARNESS,
            "tools/media-repair-harness/src/mrh/tools.py",
            "tools/media-repair-harness/scripts/ci-test.sh",
            "tools/media-repair-harness/README.md",  # Markdown inside the component still selects it
            "tools/media-repair-harness/pyproject.toml",
            f"{H}/harness/tools.py",  # the old in-tree location (deletions and renames out of it)
            f"{H}/harness/CONTRACT.md",
            f"{H}/suite/dev/case-01.json",  # public suite and fixtures
            f"{H}/suite/fixtures/a.bin",
            f"{H}/GATES.md",
            f"{H}/RULINGS-v1.1.md",  # the evaluator's v1.1 rulings, read like GATES.md
            f"{H}/suite-dev-v1.1/README.md",  # the corrected dev suite is routed like suite/ (Markdown inside it included)
            f"{H}/suite-dev-v1.1/manifest.json",
            f"{H}/suite-dev-v1.1/cases/movie-corrupt-001.json",
            f"{H}/suite-dev-v1.1/build_v11.py",
            f"{E}/epub.py",  # the external source the harness imports
            f"{E}/freeze.json",  # JSON there is harness data, not site data
            f"{E}/README.md",
            "pyproject.toml",
            "requirements.txt",
            "requirements-dev.txt",
            "uv.lock",
            ".python-version",
            "setup.cfg",
        )

    def test_docs(self):
        self.check(
            cc.DOCS,
            "README.md",
            "CLAUDE.md",
            "docs/adrs/116-component-ci-routing-and-gating.md",
            "docs/ops/authentik-apply-seed/payloads/brand-c.json",
            ".agents/HANDOFF.md",
            ".agents/context/ll-library-audit/audit.py",
            ".agents/plans/.gitkeep",
            f"{H}/NOTES.md",  # a note in the harness context, not the suite, GATES.md or code
            f"{H}/RULINGS-v2.md",  # only the named rulings file is harness; another note is not
            f"{H}/suite-dev-v1.1-notes.md",  # a prefix ends at the directory boundary: this is a note, not the suite
            "packages/domain/README.md",
            "LICENSE",
        )

    def test_shared(self):
        self.check(
            cc.SHARED,
            ".github/workflows/ci.yml",
            ".github/workflows/claude.yml",
            ".github/CODEOWNERS",
            "scripts/ci-components.py",
            "scripts/ci-code-paths.sh",
            "scripts/e2e-gate-paths.sh",
            "scripts/tests/test_ci_components.py",
        )

    def test_unknown(self):
        self.check(
            cc.UNKNOWN,
            "Makefile",
            "tools/other-tool/run.sh",
            "tools/README",  # not Markdown, not the harness directory
            "scripts/new-thing.sh",
            ".vscode/settings.json",
            "../escape.txt",
            "/etc/passwd",
            "a\\b",
            "",
            "apps/../Makefile",
            "docs/../Makefile",
        )

    def test_boundaries(self):
        self.check(cc.UNKNOWN, "tools/media-repair-harnessx/a.py")  # a prefix ends at a directory boundary
        self.check(cc.SITE, "apps/web/requirements.txt")  # packaging rule is root-only
        self.check(cc.DOCS, "docsx/a.md")  # `.md` is docs wherever it sits
        self.check(cc.UNKNOWN, "docsx/a.ts")
        self.check(cc.SITE, "./package.json")  # leading ./ is normalised
        self.check(cc.UNKNOWN, "scripts/ci_helper.sh")  # `scripts/ci-` needs the dash


class Routing(unittest.TestCase):
    """The matrix from the work order: what each kind of change selects."""

    def test_site_only(self):
        d = route("apps/web/app/page.tsx", "packages/ui/src/button.tsx")
        self.assertEqual(sel(d), (True, False))

    def test_harness_only_python(self):
        d = route("tools/media-repair-harness/src/mrh/tools.py")
        self.assertEqual(sel(d), (False, True))
        self.assertFalse(d.image)

    def test_harness_only_json_is_not_site(self):
        # The old path-filter sent harness-only JSON to the site CI and Python to nothing.
        d = route(f"{H}/suite/dev/case-01.json", f"{E}/labels.json")
        self.assertEqual(sel(d), (False, True))

    def test_shared_workflow_edit_selects_everything(self):
        d = route(".github/workflows/ci.yml")
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.shared)
        self.assertTrue(d.image)  # ci.yml is an image input (ci-code-paths.sh --image)

    def test_shared_routing_script_selects_everything(self):
        d = route("scripts/ci-components.py")
        self.assertEqual(sel(d), (True, True))
        self.assertFalse(d.image)

    def test_public_fixture(self):
        self.assertEqual(sel(route(f"{H}/suite/fixtures/sample.bin")), (False, True))

    def test_gates_md(self):
        self.assertEqual(sel(route(f"{H}/GATES.md")), (False, True))

    def test_prompt_file(self):
        self.assertEqual(sel(route("tools/media-repair-harness/src/mrh/prompts/system.txt")), (False, True))
        self.assertEqual(sel(route(f"{H}/harness/prompts/system.txt")), (False, True))

    def test_epub_dependency(self):
        self.assertEqual(sel(route(f"{E}/epub.py")), (False, True))

    def test_docs_only(self):
        d = route("README.md", "docs/adrs/116-x.md", ".agents/HANDOFF.md")
        self.assertEqual(sel(d), (False, False))
        self.assertTrue(d.docs)
        self.assertFalse(d.degraded)

    def test_root_lockfile_is_site_not_harness(self):
        d = route("pnpm-lock.yaml")
        self.assertEqual(sel(d), (True, False))
        self.assertTrue(d.image)

    def test_pyproject_is_harness_not_site(self):
        self.assertEqual(sel(route("pyproject.toml")), (False, True))
        self.assertEqual(sel(route("requirements.txt")), (False, True))

    def test_mixed_site_and_harness(self):
        self.assertEqual(sel(route("apps/web/a.ts", "tools/media-repair-harness/x.py")), (True, True))

    def test_docs_do_not_hide_a_component(self):
        self.assertEqual(sel(route("README.md", "tools/media-repair-harness/x.py")), (False, True))

    def test_rename_across_components_lists_both_names(self):
        # Moving a harness file into the site (or out of it) lists the old and the new name: both components run.
        d = route(f"{H}/harness/tools.py", "packages/ui/src/tools.py")
        self.assertEqual(sel(d), (True, True))
        # The packaging move itself (old tree to tools/): harness only.
        d = route(f"{H}/harness/tools.py", "tools/media-repair-harness/src/mrh/tools.py")
        self.assertEqual(sel(d), (False, True))

    def test_deletion_still_selects(self):
        # A deletion is just a path in the list; classification never looks at the file system.
        self.assertEqual(sel(route("tools/media-repair-harness/src/mrh/removed.py")), (False, True))
        self.assertEqual(sel(route("packages/ui/src/removed.tsx")), (True, False))

    def test_unknown_path_selects_everything(self):
        d = route("Makefile")
        self.assertEqual(sel(d), (True, True))
        self.assertIn("unrecognised path", d.reason)

    def test_unknown_among_docs_selects_everything(self):
        self.assertEqual(sel(route("README.md", "Makefile")), (True, True))

    def test_empty_list_fails_closed(self):
        d = cc.classify_paths([], probe)
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)

    def test_too_many_paths_fails_closed(self):
        paths = [f"docs/{i}.md" for i in range(cc.MAX_FILES)]
        d = cc.classify_paths(paths, probe)
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)
        # one fewer is still decided by the paths
        self.assertEqual(sel(cc.classify_paths(paths[:-1], probe)), (False, False))

    def test_image_rule_is_delegated(self):
        self.assertTrue(route("Dockerfile").image)
        self.assertTrue(route("packages/newpkg/package.json").image)
        self.assertFalse(route("apps/web/app/page.tsx").image)

    def test_release_pr_runs_everything(self):
        d = cc.decide(base=None, head=None, paths_file=None, expected_count=None, head_ref="release-please--branches--main")
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.image)
        self.assertFalse(d.degraded)

    def test_no_listing_source_fails_closed(self):
        d = cc.decide(base=None, head=None, paths_file=None, expected_count=None, head_ref="feat/x")
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)


def run_git(cwd, *args):
    env = dict(
        os.environ,
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@example.invalid",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@example.invalid",
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_CONFIG_SYSTEM="/dev/null",
    )
    out = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True)
    return out.stdout.strip()


class GitListing(unittest.TestCase):
    """The file list comes from git: a throwaway repository, no network, no API."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        run_git(self.repo, "init", "-q", "-b", "main")
        self.put(f"{H}/harness/tools.py", "x = 1\n" * 40)
        self.put("packages/ui/a.ts", "export {}\n")
        self.put("README.md", "hi\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "base")
        self.base = run_git(self.repo, "rev-parse", "HEAD")
        run_git(self.repo, "checkout", "-q", "-b", "pr")

    def tearDown(self):
        self._tmp.cleanup()

    def put(self, rel, text):
        p = Path(self.repo, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, msg="change"):
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", msg)
        return run_git(self.repo, "rev-parse", "HEAD")

    def decide(self, head, **kw):
        return cc.decide(
            base=self.base,
            head=head,
            paths_file=None,
            expected_count=kw.pop("expected_count", None),
            head_ref="feat/x",
            cwd=self.repo,
            image_probe=probe,
            **kw,
        )

    def test_rename_lists_both_names_so_moving_out_of_a_component_counts(self):
        run_git(self.repo, "mv", f"{H}/harness/tools.py", "packages/ui/tools.py")
        head = self.commit()
        paths = cc.changed_paths_from_git(self.base, head, self.repo)
        self.assertEqual(sorted(paths), [f"{H}/harness/tools.py", "packages/ui/tools.py"])
        self.assertEqual(sel(self.decide(head)), (True, True))

    def test_rename_within_the_harness_packaging_move(self):
        Path(self.repo, "tools/media-repair-harness/src/mrh").mkdir(parents=True)
        run_git(self.repo, "mv", f"{H}/harness/tools.py", "tools/media-repair-harness/src/mrh/tools.py")
        head = self.commit()
        d = self.decide(head, expected_count=1)  # the API counts a rename once; git lists two paths
        self.assertEqual(sel(d), (False, True))
        self.assertFalse(d.degraded)

    def test_deletion(self):
        run_git(self.repo, "rm", "-q", f"{H}/harness/tools.py")
        head = self.commit()
        self.assertEqual(cc.changed_paths_from_git(self.base, head, self.repo), [f"{H}/harness/tools.py"])
        self.assertEqual(sel(self.decide(head)), (False, True))

    def test_docs_only_diff(self):
        self.put("README.md", "changed\n")
        head = self.commit()
        d = self.decide(head)
        self.assertEqual(sel(d), (False, False))
        self.assertFalse(d.degraded)

    def test_merge_base_diff_ignores_changes_made_on_the_base_branch_since(self):
        run_git(self.repo, "checkout", "-q", "main")
        self.put("packages/ui/only-on-main.ts", "export {}\n")
        main_head = self.commit("main moved")
        run_git(self.repo, "checkout", "-q", "pr")
        self.put("README.md", "pr change\n")
        head = self.commit()
        d = cc.decide(base=main_head, head=head, paths_file=None, expected_count=None, head_ref="x", cwd=self.repo, image_probe=probe)
        self.assertEqual(sel(d), (False, False))  # only README.md is the PR's own change

    def test_no_change_at_all_fails_closed(self):
        d = self.decide(self.base)
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)

    def test_unknown_commit_fails_closed(self):
        d = self.decide("0" * 40)
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)
        self.assertIn("could not classify", d.reason)

    def test_short_list_fails_closed(self):
        self.put("README.md", "x\n")
        head = self.commit()
        d = self.decide(head, expected_count=5)  # the PR says 5 files, git lists 1: the list is incomplete
        self.assertEqual(sel(d), (True, True))
        self.assertTrue(d.degraded)

    def test_not_a_repository_fails_closed(self):
        with tempfile.TemporaryDirectory() as empty:
            d = cc.decide(base="a" * 40, head="b" * 40, paths_file=None, expected_count=None, head_ref="x", cwd=empty)
        self.assertEqual(sel(d), (True, True))

    def test_paths_file_newline_and_nul(self):
        with tempfile.TemporaryDirectory() as t:
            nl = Path(t, "nl.txt")
            nl.write_text("README.md\ntools/media-repair-harness/x.py\n")
            nul = Path(t, "nul.txt")
            nul.write_bytes(b"README.md\0tools/media-repair-harness/x.py\0")
            for f in (nl, nul):
                d = cc.decide(base=None, head=None, paths_file=str(f), expected_count=None, head_ref="x", image_probe=probe)
                self.assertEqual(sel(d), (False, True), f)
            missing = cc.decide(base=None, head=None, paths_file=str(Path(t, "none")), expected_count=None, head_ref="x")
            self.assertEqual(sel(missing), (True, True))


class Cli(unittest.TestCase):
    def run_cli(self, *args, env=None):
        return subprocess.run(
            ["python3", str(SCRIPT), *args], capture_output=True, text=True, cwd=REPO, env={**os.environ, **(env or {})}
        )

    def test_classify_writes_github_output(self):
        with tempfile.TemporaryDirectory() as t:
            paths = Path(t, "p.txt")
            paths.write_text("tools/media-repair-harness/x.py\n")
            out = Path(t, "out.txt")
            r = self.run_cli("classify", "--paths-file", str(paths), "--github-output", str(out))
            self.assertEqual(r.returncode, 0, r.stderr)
            lines = dict(l.split("=", 1) for l in out.read_text().splitlines())
            self.assertEqual((lines["site"], lines["harness"], lines["image"]), ("false", "true", "false"))

    def test_classify_failure_still_exits_zero_and_selects_everything(self):
        with tempfile.TemporaryDirectory() as t:
            out = Path(t, "out.txt")
            r = self.run_cli("classify", "--base", "0" * 40, "--head", "1" * 40, "--github-output", str(out))
            self.assertEqual(r.returncode, 0, r.stderr)
            lines = dict(l.split("=", 1) for l in out.read_text().splitlines())
            self.assertEqual((lines["site"], lines["harness"], lines["degraded"]), ("true", "true", "true"))


GREEN = {"lint-and-typecheck": "success", "site-test": "success", "build": "success", "harness-test": "success", "ci-routing-tests": "success"}


def fin(site, harness, changes="success", **overrides):
    return cc.finalize(changes, site, harness, {**GREEN, **overrides})


class Finalizer(unittest.TestCase):
    def test_everything_selected_and_green(self):
        self.assertEqual(fin("true", "true"), [])

    def test_site_only_harness_skipped_passes(self):
        self.assertEqual(fin("true", "false", **{"harness-test": "skipped"}), [])

    def test_harness_only_site_skipped_passes(self):
        skipped = {"lint-and-typecheck": "skipped", "site-test": "skipped", "build": "skipped"}
        self.assertEqual(fin("false", "true", **skipped), [])

    def test_docs_only_all_skipped_passes(self):
        skipped = {k: "skipped" for k in ("lint-and-typecheck", "site-test", "build", "harness-test")}
        self.assertEqual(fin("false", "false", **skipped), [])

    def test_selected_job_failed(self):
        self.assertTrue(fin("true", "true", **{"harness-test": "failure"}))
        self.assertTrue(fin("true", "true", **{"site-test": "failure"}))

    def test_selected_job_cancelled(self):
        self.assertTrue(fin("true", "true", **{"harness-test": "cancelled"}))
        self.assertTrue(fin("true", "false", build="cancelled"))

    def test_selected_job_unexpectedly_skipped(self):
        self.assertTrue(fin("true", "true", **{"harness-test": "skipped"}))
        self.assertTrue(fin("true", "true", **{"lint-and-typecheck": "skipped"}))
        self.assertTrue(fin("true", "true", build="skipped"))

    def test_harness_is_gated_by_test_when_only_the_harness_is_selected(self):
        self.assertTrue(fin("false", "true", **{"lint-and-typecheck": "skipped", "site-test": "skipped", "build": "skipped", "harness-test": "failure"}))

    def test_unselected_job_that_ran_and_failed_is_still_red(self):
        self.assertTrue(fin("false", "true", **{"site-test": "failure"}))
        self.assertTrue(fin("true", "false", **{"harness-test": "cancelled"}))

    def test_unselected_job_that_ran_green_is_fine(self):
        self.assertEqual(fin("false", "true"), [])

    def test_changes_not_success_fails_closed(self):
        for changes in ("failure", "cancelled", "skipped", ""):
            with self.subTest(changes=changes):
                self.assertTrue(fin("true", "true", changes=changes))

    def test_changes_failed_with_empty_outputs_selects_everything(self):
        # `changes` failed so its outputs are empty: the empty string must read as "selected", and still fail.
        problems = fin("", "", changes="failure", **{"harness-test": "skipped"})
        self.assertTrue(any("harness-test" in p for p in problems))
        self.assertTrue(any("changes job" in p for p in problems))

    def test_routing_tests_must_always_succeed(self):
        for result in ("failure", "skipped", "cancelled", "missing"):
            with self.subTest(result=result):
                self.assertTrue(fin("false", "false", **{"ci-routing-tests": result}))

    def test_missing_result_is_not_success(self):
        r = dict(GREEN)
        del r["harness-test"]
        self.assertTrue(cc.finalize("success", "true", "true", r))

    def test_cli_exit_codes(self):
        base = [
            "python3", str(SCRIPT), "finalize", "--changes", "success", "--site", "false", "--harness", "true",
            "--result", "lint-and-typecheck=skipped", "--result", "site-test=skipped", "--result", "build=skipped",
            "--result", "ci-routing-tests=success",
        ]
        ok = subprocess.run([*base, "--result", "harness-test=success"], capture_output=True, text=True)
        bad = subprocess.run([*base, "--result", "harness-test=cancelled"], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.assertEqual(bad.returncode, 1, bad.stdout)


class OutputInjection(unittest.TestCase):
    """A changed file can be NAMED anything. No name may write, overwrite or end a $GITHUB_OUTPUT key (the last value
    of a key wins in GitHub's parser), and none may start a workflow command in the log."""

    NAMES = [
        "a\nsite=false\nharness=false\nz=",
        "a\rsite=false\rharness=false\r",
        "a\r\nsite=false\r\nharness=false",
        "x=y",
        "site=false",
        "harness=false",
        "a\n::set-output name=site::false",
        "a\n::stop-commands::tok\n",
        "weird\x00name",
    ]

    def run_classify(self, name):
        with tempfile.TemporaryDirectory() as t:
            paths = Path(t, "p.txt")
            # NUL-separated, the only format that can carry a newline inside a name
            paths.write_bytes(name.encode().replace(b"\0", b"") + b"\0")
            out = Path(t, "out.txt")
            r = subprocess.run(
                ["python3", str(SCRIPT), "classify", "--paths-file", str(paths), "--github-output", str(out)],
                capture_output=True, text=True, cwd=REPO,
            )
            return r, out.read_text()

    @staticmethod
    def parse(text):
        """GitHub's last-value-wins `key=value` lines (no heredoc delimiters are ever written)."""
        values, order = {}, []
        for line in text.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                values[key] = value
                order.append(key)
        return values, order

    def test_hostile_names_cannot_deselect_a_component(self):
        for name in self.NAMES:
            with self.subTest(name=name):
                r, text = self.run_classify(name)
                self.assertEqual(r.returncode, 0, r.stderr)
                values, order = self.parse(text)
                self.assertEqual((values["site"], values["harness"]), ("true", "true"))
                self.assertEqual(order, ["site", "harness", "image", "docs", "shared", "degraded", "reason"])
                self.assertEqual(len(text.splitlines()), 7)  # exactly one line per output, nothing extra
                self.assertNotIn("\r", text)

    def test_hostile_names_do_not_start_a_workflow_command_in_the_log(self):
        for name in self.NAMES:
            with self.subTest(name=name):
                r, _ = self.run_classify(name)
                for line in r.stdout.splitlines():
                    self.assertFalse(line.startswith("::") and not line.startswith("::warning::component"), line)
                self.assertNotIn("\r", r.stdout)

    def test_selection_keys_are_only_literals(self):
        d = cc.select_all("x\nsite=false")
        lines = cc.output_lines(d)
        self.assertEqual(lines[0:2], ["site=true", "harness=true"])
        self.assertEqual(len(lines), 7)
        d.site = "false\nharness=false"  # a corrupted decision still writes only literals
        self.assertEqual(cc.output_lines(d)[0:2], ["site=true", "harness=true"])
        d.outputs = lambda: {**cc.Decision.outputs(d), "site": "false\nharness=false"}  # a bug that bypassed flag()
        with self.assertRaises(ValueError):
            cc.output_lines(d)

    def test_safe_text_escapes_controls_and_bounds_length(self):
        t = cc.safe_text("a\nb\rc\x00d")
        self.assertNotRegex(t, r"[\x00-\x1f]")
        self.assertLess(len(cc.safe_text("x" * 5000)), 400)

    def test_unknown_path_with_newline_in_the_decision_reason(self):
        d = route("a\nsite=false\nharness=false")
        self.assertEqual(sel(d), (True, True))
        self.assertNotIn("\n", cc.output_lines(d)[-1])


class FinalizerSelectionValues(unittest.TestCase):
    def test_only_exact_false_deselects(self):
        skipped = {"lint-and-typecheck": "skipped", "site-test": "skipped", "build": "skipped"}
        self.assertEqual(fin("false", "true", **skipped), [])
        for value in ("False", "FALSE", " false", "false ", "false\n", "0", "no", "", "null", "tru", "true\nsite=false"):
            with self.subTest(value=repr(value)):
                # read as "selected", so the skipped site jobs are an unexpected skip: red
                self.assertTrue(fin(value, "true", **skipped))
        harness_skipped = {"harness-test": "skipped"}
        self.assertTrue(fin("true", "False", **harness_skipped))
        self.assertTrue(fin("true", "", **harness_skipped))
        self.assertEqual(fin("true", "false", **harness_skipped), [])


class WorkflowAgreement(unittest.TestCase):
    """The workflow and the script must agree: a renamed or forgotten job would silently fall out of the gate."""

    @classmethod
    def setUpClass(cls):
        cls.text = (REPO / ".github/workflows/ci.yml").read_text()
        jobs_part = cls.text.split("\njobs:\n", 1)[1]
        cls.jobs = set(re.findall(r"^  ([a-z][a-z0-9-]*):\s*$", jobs_part, re.M))

    def job_block(self, name):
        part = self.text.split(f"\n  {name}:\n", 1)[1]
        return re.split(r"\n  [a-z][a-z0-9-]*:\n", part, maxsplit=1)[0]

    def test_required_contexts_exist_under_their_exact_names(self):
        for name in ("lint-and-typecheck", "test", "build"):
            self.assertIn(name, self.jobs)
        e2e = (REPO / ".github/workflows/e2e.yml").read_text()
        self.assertRegex(e2e, r"(?m)^  e2e-gate:\s*$")

    def test_every_gated_job_exists(self):
        for job in (*cc.SITE_JOBS, *cc.HARNESS_JOBS, *cc.ALWAYS_JOBS):
            self.assertIn(job, self.jobs)

    def test_finalizer_needs_every_gated_job(self):
        block = self.job_block("test")
        m = re.search(r"needs:\s*\[([^\]]*)\]", block)
        self.assertIsNotNone(m)
        needs = {n.strip() for n in m.group(1).split(",")}
        self.assertEqual(needs, {"changes", *cc.SITE_JOBS, *cc.HARNESS_JOBS, *cc.ALWAYS_JOBS})
        self.assertIn("always()", block)
        self.assertIn("python3 scripts/ci-components.py finalize", block)
        for job in (*cc.SITE_JOBS, *cc.HARNESS_JOBS, *cc.ALWAYS_JOBS):
            self.assertIn(f"{job}=", block, f"finalizer does not pass {job}'s result")

    def test_finalizer_does_not_use_a_skip_condition(self):
        # `test` must report on every PR: no `needs.changes.outputs.* != 'false'` guard on the finalizer itself.
        block = self.job_block("test")
        if_line = re.search(r"\n    if: (.*)", block).group(1)
        self.assertNotIn("outputs", if_line)

    def test_no_top_level_path_filter_on_required_workflows(self):
        for wf in ("ci.yml", "e2e.yml"):
            head = (REPO / ".github/workflows" / wf).read_text().split("\njobs:\n", 1)[0]
            on_block = head.split("\non:\n", 1)[1]
            pr_part = on_block.split("push:", 1)[0]
            self.assertNotRegex(pr_part, r"paths(-ignore)?:", f"{wf} pull_request must not path-filter")

    def test_component_jobs_are_guarded_by_their_own_selection(self):
        for job, out in (("lint-and-typecheck", "site"), ("site-test", "site"), ("build", "site"), ("harness-test", "harness")):
            self.assertIn(f"needs.changes.outputs.{out} != 'false'", self.job_block(job), job)

    def test_harness_job_runs_the_entry_point_with_the_suite_required(self):
        block = self.job_block("harness-test")
        self.assertIn('python-version: "3.11"', block)
        self.assertIn('MRH_REQUIRE_SUITE: "1"', block)
        self.assertIn("bash tools/media-repair-harness/scripts/ci-test.sh", block)

    def test_no_heavy_jobs_in_pr_ci(self):
        text = "\n".join(l for l in self.text.lower().splitlines() if not l.strip().startswith("#"))
        for word in ("ollama", "ffmpeg", "nvidia", "gpu", "benchmark"):
            self.assertNotIn(word, text)

    def test_routing_tests_job_runs_these_tests(self):
        self.assertIn("unittest discover -s scripts/tests", self.job_block("ci-routing-tests"))


class SiteImage(unittest.TestCase):
    def test_dockerfile_never_copies_the_whole_context(self):
        for line in (REPO / "Dockerfile").read_text().splitlines():
            line = line.strip()
            if line.startswith("COPY ") and "--from" not in line:
                sources = line.split()[1:-1]
                for src in sources:
                    self.assertNotIn(src, (".", "./", "*"), line)
                    self.assertFalse(src.startswith(("tools", ".agents")), line)

    def test_dockerignore_keeps_the_harness_out(self):
        entries = {l.strip() for l in (REPO / ".dockerignore").read_text().splitlines()}
        self.assertIn("tools/media-repair-harness", entries)
        self.assertIn(".agents", entries)

    def test_release_please_ignores_the_harness(self):
        import json

        cfg = json.loads((REPO / "release-please-config.json").read_text())
        self.assertIn("tools/media-repair-harness", cfg["packages"]["."]["exclude-paths"])

    def test_pnpm_workspace_does_not_include_tools(self):
        text = (REPO / "pnpm-workspace.yaml").read_text()
        self.assertNotIn("tools", text)


class ExistingRules(unittest.TestCase):
    """The site rules keep their own self-tests; run them here so one failing routing file fails `test`."""

    def test_ci_code_paths_self_test(self):
        r = subprocess.run(["bash", str(REPO / "scripts/ci-code-paths.sh"), "--self-test"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_e2e_gate_paths_self_test(self):
        r = subprocess.run(["bash", str(REPO / "scripts/e2e-gate-paths.sh"), "--self-test"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_harness_paths_are_not_e2e_pipeline_paths(self):
        paths = f"tools/media-repair-harness/x.py\n{H}/suite/a.json\n{E}/epub.py\npyproject.toml\n"
        r = subprocess.run(["bash", str(REPO / "scripts/e2e-gate-paths.sh")], input=paths, capture_output=True, text=True)
        self.assertEqual(r.returncode, 10)

    def test_site_rule_and_classifier_agree_on_site_code(self):
        # ci-code-paths.sh (used by e2e-advisory.yml) must call a path code exactly when the classifier says site
        # (or shared/unknown, which select the site too).
        samples = [
            "apps/web/app/page.tsx", "packages/domain/src/a.ts", "package.json", "pnpm-lock.yaml", "Dockerfile",
            ".agents/owed-checks.yaml", "README.md", "docs/adrs/1.md", ".agents/HANDOFF.md",
            "tools/media-repair-harness/x.py", f"{H}/suite/a.json", f"{E}/freeze.json", "pyproject.toml",
            ".github/workflows/ci.yml", "scripts/ci-components.py",
        ]
        for p in samples:
            with self.subTest(path=p):
                r = subprocess.run(["bash", str(REPO / "scripts/ci-code-paths.sh")], input=p + "\n", capture_output=True, text=True)
                code = r.returncode == 0
                self.assertIn(r.returncode, (0, 10))
                self.assertEqual(code, cc.classify_path(p) in (cc.SITE, cc.SHARED, cc.UNKNOWN))


if __name__ == "__main__":
    unittest.main()
