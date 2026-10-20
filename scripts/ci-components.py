#!/usr/bin/env python3
"""Component CI routing and the fail-closed finalizer (ADR-116). Stdlib only, Python 3.11 compatible.

Two subcommands:

  classify   Which components does this pull request touch?  Lists the changed files from GIT (the merge-base diff
             with renames reported as a delete plus an add, so BOTH names are listed), maps each path to a
             component and writes `site=`, `harness=` and `image=` (and informational `docs=`, `shared=`) to
             $GITHUB_OUTPUT. Anything it cannot decide selects EVERY component: a failed or incomplete diff, an
             empty diff, a path no rule names, too many files, a crash. It never answers "nothing" by accident.

  finalize   The decision behind the required `test` context: given the `changes` result, the selection and each
             component job's result, exit 0 only when every SELECTED job succeeded. A selected job that failed,
             was cancelled or was skipped is red; an unselected job may be skipped.

Components:
  site     apps/*, packages/*, root Node manifests and lockfile, Dockerfile and site configs, `.agents` data files
           the site unit tests parse.
  harness  tools/media-repair-harness/**, the public suites (suite/ and suite-dev-v1.1/), GATES.md and RULINGS-v1.1.md
           of the harness context, the EPUB source it imports, the old in-tree harness location, root Python
           packaging files.
  docs     Markdown and other docs paths that no CI job reads (selects nothing).
  shared   CI workflows and the routing scripts and their tests: selects EVERY component.
  unknown  not named by any rule: selects every component (fail closed).

`--self-test` is not needed here: scripts/tests/test_ci_components.py holds the examples and runs in CI
(job `ci-routing-tests`, which the required `test` context waits for).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent

# --- the component rules ------------------------------------------------------------------------------------------

HARNESS_CONTEXT = ".agents/context/media-repair-harness-2026-10-19/"
EPUB_CONTEXT = ".agents/context/media-repair-actual-epub-2026-10-18/"
HARNESS_DIR = "tools/media-repair-harness/"

# Files at the repository root that package or pin the harness's Python side. Root only: a requirements.txt inside
# apps/ belongs to the site.
PYTHON_ROOT_FILES = (
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "MANIFEST.in",
    ".python-version",
    "uv.lock",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock",
)
PYTHON_ROOT_GLOBS = ("requirements*.txt", "constraints*.txt")

# Root files the site's lint, typecheck, tests, build or image read.
SITE_ROOT_FILES = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.base.json",
    "eslint.config.mjs",
    ".prettierrc",
    ".prettierignore",
    ".gitignore",
    "Dockerfile",
    ".dockerignore",
    ".env.example",
    "release-please-config.json",
    ".release-please-manifest.json",
    "scripts/lint-css-hex.mjs",
)

SHARED_PREFIXES = (".github/", "scripts/ci-", "scripts/tests/")
SHARED_FILES = ("scripts/e2e-gate-paths.sh",)

DOCS_ROOT_FILES = ("LICENSE", "haynesnetwork.code-workspace")

DATA_SUFFIXES = (".yaml", ".yml", ".json")

# Job ids (ci.yml) that must succeed for a selected component. `test` itself is the finalizer.
SITE_JOBS = ("lint-and-typecheck", "site-test", "build")
HARNESS_JOBS = ("harness-test",)
ALWAYS_JOBS = ("ci-routing-tests",)

MAX_FILES = 3000  # parity with the files-API limit the older workflows guarded against; past it, run everything

SITE, HARNESS, DOCS, SHARED, UNKNOWN = "site", "harness", "docs", "shared", "unknown"


def classify_path(raw: str) -> str:
    """Map one repository-relative path to site, harness, docs, shared or unknown."""
    path = raw[2:] if raw.startswith("./") else raw
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or any(ord(ch) < 32 for ch in path)
        or ".." in path.split("/")
    ):
        return UNKNOWN
    name = path.rsplit("/", 1)[-1]

    # 1. Routing and CI infrastructure selects everything.
    if path.startswith(SHARED_PREFIXES) or path in SHARED_FILES:
        return SHARED

    # 2. The harness: its own directory, the old in-tree location, its public suites (suite/, suite-dev-v1.1/), GATES.md, RULINGS-v1.1.md and the EPUB source it imports.
    if path.startswith(HARNESS_DIR) or path.startswith(EPUB_CONTEXT):
        return HARNESS
    if path.startswith(HARNESS_CONTEXT):
        rest = path[len(HARNESS_CONTEXT):]
        in_code_or_suite = rest.startswith(("harness/", "suite/", "suite-dev-v1.1/"))
        # The rulings that define the v1.1 suite are read like GATES.md: a change to them is a change to what the harness is judged on.
        if rest in ("GATES.md", "RULINGS-v1.1.md") or in_code_or_suite or not path.endswith(".md"):
            return HARNESS
        return DOCS  # notes and reports in the context folder affect nothing
    if "/" not in path and (name in PYTHON_ROOT_FILES or any(fnmatch.fnmatchcase(name, g) for g in PYTHON_ROOT_GLOBS)):
        return HARNESS

    # 3. Markdown anywhere is docs (ESLint, tsc and the tests never read it; ci-code-paths.sh agrees).
    if path.endswith(".md"):
        return DOCS

    # 4. `.agents` data files are read by the site unit tests; every other `.agents` file is a note.
    if path.startswith(".agents/"):
        return SITE if path.endswith(DATA_SUFFIXES) else DOCS
    if path.startswith("docs/"):
        return DOCS
    if path in DOCS_ROOT_FILES or name == ".gitkeep":
        return DOCS

    # 5. The site.
    if path.startswith(("apps/", "packages/")) or path in SITE_ROOT_FILES:
        return SITE

    return UNKNOWN


@dataclass
class Decision:
    site: bool
    harness: bool
    image: bool
    docs: bool = False
    shared: bool = False
    degraded: bool = False
    reason: str = ""
    classified: list[tuple[str, str]] = field(default_factory=list)

    def outputs(self) -> dict[str, str]:
        def flag(v: bool) -> str:
            return "true" if v else "false"

        return {
            "site": flag(self.site),
            "harness": flag(self.harness),
            "image": flag(self.image),
            "docs": flag(self.docs),
            "shared": flag(self.shared),
            "degraded": flag(self.degraded),
            "reason": safe_text(self.reason),
        }


def safe_text(value: str, limit: int = 300) -> str:
    """Free text that is safe on one `key=value` line of $GITHUB_OUTPUT and in workflow-command output: no raw
    newline, carriage return or other control character survives (json escaping), and it is length-bounded. A changed
    file can be NAMED anything, so no path may reach an output file or a log line unescaped."""
    text = json.dumps(value, ensure_ascii=True)[1:-1]
    return text if len(text) <= limit else text[:limit] + "...(truncated)"


def select_all(reason: str, degraded: bool = True) -> Decision:
    return Decision(site=True, harness=True, image=True, degraded=degraded, reason=reason)


def classify_paths(paths: list[str], image_probe=None) -> Decision:
    """Decide the selection for a list of changed paths (both names of a rename, deletions included)."""
    paths = [p for p in paths if p]
    if not paths:
        return select_all("empty changed-file list: cannot prove nothing changed")
    if len(paths) >= MAX_FILES:
        return select_all(f"{len(paths)} changed paths, at or past the {MAX_FILES} limit: list may be partial")
    tagged = [(p, classify_path(p)) for p in paths]
    tags = {t for _, t in tagged}
    unknown = [p for p, t in tagged if t == UNKNOWN]
    shared = [p for p, t in tagged if t == SHARED]
    if unknown or shared:
        what = f"shared infrastructure ({shared[0]!r})" if shared else f"unrecognised path ({unknown[0]!r})"
        image = image_probe(paths) if (image_probe and shared and not unknown) else True
        d = select_all(f"{what}: every component runs", degraded=False)
        d.image = image
        d.shared = bool(shared)
        d.docs = DOCS in tags
        d.classified = tagged
        return d
    d = Decision(
        site=SITE in tags,
        harness=HARNESS in tags,
        image=bool(image_probe(paths)) if image_probe else True,
        docs=DOCS in tags,
        classified=tagged,
    )
    d.reason = "only docs paths changed" if not (d.site or d.harness) else "selected by changed paths"
    return d


# --- listing the changed files from git ---------------------------------------------------------------------------


class ListingError(Exception):
    pass


def git(args: list[str], cwd: str | None = None) -> bytes:
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise ListingError(f"git {' '.join(args[:3])} failed ({proc.returncode}): {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def changed_paths_from_git(base: str, head: str, cwd: str | None = None) -> list[str]:
    """Merge-base diff `base...head`. `--no-renames` reports a rename as a delete of the old path plus an add of the
    new one, so a file moved OUT of a component still selects that component. NUL-separated: no quoting surprises."""
    for rev in (base, head):
        git(["cat-file", "-e", f"{rev}^{{commit}}"], cwd)
    git(["merge-base", base, head], cwd)  # fails on a shallow clone with no common ancestor
    out = git(["diff", "--name-only", "-z", "--no-renames", f"{base}...{head}"], cwd)
    return [p.decode("utf-8", errors="surrogateescape") for p in out.split(b"\0") if p]


def image_probe_factory(script: Path = HERE / "ci-code-paths.sh"):
    """Whether the Docker image inputs changed: delegate to the existing rule so there is one source of truth."""

    def probe(paths: list[str]) -> bool:
        proc = subprocess.run(
            ["bash", str(script), "--image"],
            input="\n".join(paths) + "\n",
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return True
        if proc.returncode == 10:
            return False
        return True  # a crash is never read as "no image input changed"

    return probe


def decide(
    *,
    base: str | None,
    head: str | None,
    paths_file: str | None,
    expected_count: int | None,
    head_ref: str,
    cwd: str | None = None,
    image_probe=None,
) -> Decision:
    try:
        if head_ref.startswith("release-please--"):
            return select_all("release PR: everything runs", degraded=False)
        if base and head:
            paths = changed_paths_from_git(base, head, cwd)
        elif paths_file:
            raw = Path(paths_file).read_bytes()
            sep = b"\0" if b"\0" in raw else b"\n"
            paths = [p.decode("utf-8", errors="surrogateescape") for p in raw.split(sep) if p]
        else:
            return select_all("no way to list the changed files (no --base/--head or --paths-file)")
        # The API counts a rename once; git (without rename detection) lists it twice. Fewer paths than the PR
        # reports means the list is incomplete (shallow checkout, partial fetch).
        if expected_count is not None and len(set(paths)) < expected_count:
            return select_all(f"git lists {len(set(paths))} paths but the PR reports {expected_count} changed files")
        return classify_paths(sorted(set(paths)), image_probe)
    except Exception as exc:  # noqa: BLE001 - every failure mode must fail closed
        return select_all(f"could not classify ({type(exc).__name__}: {exc})")


# --- the finalizer -----------------------------------------------------------------------------------------------


def is_selected(flag: str) -> bool:
    """Only the exact string `false` deselects; `true`, empty (`changes` failed) and anything else select."""
    return flag != "false"


def finalize(changes: str, site: str, harness: str, results: dict[str, str]) -> list[str]:
    """Return the problems (empty list = the required `test` context passes)."""
    problems: list[str] = []
    if changes != "success":
        problems.append(f"changes job is '{changes}': cannot tell which components were selected")
    groups = (
        ("site", is_selected(site), SITE_JOBS),
        ("harness", is_selected(harness), HARNESS_JOBS),
    )
    for component, selected, jobs in groups:
        for job in jobs:
            result = results.get(job, "missing")
            if selected and result != "success":
                problems.append(f"{component} is selected but job '{job}' is '{result}'")
            elif not selected and result not in ("success", "skipped"):
                problems.append(f"{component} is not selected but job '{job}' is '{result}'")
    for job in ALWAYS_JOBS:
        result = results.get(job, "missing")
        if result != "success":
            problems.append(f"job '{job}' is '{result}' (it always runs)")
    return problems


# --- command line ------------------------------------------------------------------------------------------------


SELECTION_KEYS = ("site", "harness", "image", "docs", "shared", "degraded")


def output_lines(decision: Decision) -> list[str]:
    """One `key=value` line per output. The selection keys are written only as the literals true/false, and the one
    free-text key is escaped, so no line can start another key (output injection through a file name)."""
    out = decision.outputs()
    for key in SELECTION_KEYS:
        if out[key] not in ("true", "false"):
            raise ValueError(f"output {key} is not a literal true/false")
    lines = [f"{k}={v}" for k, v in out.items()]
    if len(lines) != len(out) or any(("\n" in l or "\r" in l) for l in lines):
        raise ValueError("an output line contains a line break")
    return lines


def write_outputs(decision: Decision, github_output: str | None) -> None:
    lines = output_lines(decision)
    if github_output:
        with open(github_output, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")


def cmd_classify(args: argparse.Namespace) -> int:
    decision = decide(
        base=args.base,
        head=args.head,
        paths_file=args.paths_file,
        expected_count=args.expected_count,
        head_ref=args.head_ref or "",
        image_probe=image_probe_factory(),
    )
    for path, tag in decision.classified:
        print(f"{tag:8} {path!r}")
    print("---")
    for line in output_lines(decision):
        print(line)
    if decision.degraded:
        print(f"::warning::component classification fell back to everything: {safe_text(decision.reason)}")
    write_outputs(decision, args.github_output)
    return 0


def cmd_finalize(args: argparse.Namespace) -> int:
    results = {}
    for item in args.result:
        name, _, value = item.partition("=")
        results[name] = value
    print(f"changes={args.changes} site={args.site} harness={args.harness}")
    for name in (*SITE_JOBS, *HARNESS_JOBS, *ALWAYS_JOBS):
        print(f"  {name}: {results.get(name, 'missing')}")
    problems = finalize(args.changes, args.site, args.harness, results)
    for p in problems:
        print(f"::error::{p}")
    if problems:
        return 1
    print("Every selected component is green.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("classify", help="map the PR's changed files to components")
    c.add_argument("--base", help="base commit (merge-base diff base...head)")
    c.add_argument("--head", help="head commit")
    c.add_argument("--paths-file", help="changed paths, newline or NUL separated (tests, local use)")
    c.add_argument("--expected-count", type=int, help="the PR's changed_files; fewer listed paths = incomplete")
    c.add_argument("--head-ref", default="", help="PR head branch (release-please--* selects everything)")
    c.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    c.set_defaults(func=cmd_classify)

    f = sub.add_parser("finalize", help="the required `test` context: green only if every selected job is")
    f.add_argument("--changes", required=True, help="needs.changes.result")
    f.add_argument("--site", default="", help="needs.changes.outputs.site")
    f.add_argument("--harness", default="", help="needs.changes.outputs.harness")
    f.add_argument("--result", action="append", default=[], metavar="JOB=RESULT")
    f.set_defaults(func=cmd_finalize)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
