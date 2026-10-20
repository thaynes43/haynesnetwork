# ADR-116: CI routes by component, and the required `test` context gates the harness

- **Status:** Proposed (2026-10-19; drafted by Sonnet 5.5 worker W15 for the media repair harness packaging follow-up,
  for the coordinator and the owner to accept)
- **Date:** 2026-10-19
- **Deciders:** Tom Haynes (approved the harness directory, independent deterministic CI, separate site checks and
  shared-dependency routing). Drafted by Sonnet 5.5.
- **Amends:** [ADR-102](102-ci-minutes-budget.md) rule 1 (which paths skip the CI jobs). Builds on
  [ADR-009](009-ci-and-pr-flow.md) C-05 (a required check that never reports deadlocks every PR) and the
  `e2e-gate` finalizer of [ADR-100](100-e2e-gates-the-book-pipeline.md), which stand unchanged.

## Context and problem statement

The media repair harness (stdlib Python 3.11, 379 deterministic test methods) is moving out of
`.agents/context/media-repair-harness-2026-10-19/harness` into its own component, `tools/media-repair-harness/`. It needs
its own deterministic CI. The current routing cannot do that safely:

- `scripts/ci-code-paths.sh` decides "code or docs" for the site only. It calls `.agents` Python, text and fixtures
  docs, but `.agents` JSON and YAML code. A harness-only change to a JSON fixture therefore runs the whole site CI,
  and a harness-only change to Python skips every check. Nothing ever runs the Python tests.
- The harness imports `.agents/context/media-repair-actual-epub-2026-10-18/epub.py` and reads the public suite. A path
  filter that names only the harness directory would miss both.
- The required contexts are `lint-and-typecheck`, `test`, `build` and `e2e-gate`. Branch protection is out of scope
  here, so a new harness job that is not one of them would be advisory: a red harness would still merge.

## Decision drivers

- A harness change runs the harness tests and not the site's; a site change the reverse; a change to shared CI
  infrastructure runs both.
- The harness is gated under the protection that exists today.
- A routing mistake must fail closed: never "nothing ran, so it is green".
- Required contexts keep their exact names and report on every PR (no top-level path filter on a required workflow).
- The harness stays out of the site image, and PR CI never runs a model or GPU benchmark, Ollama, a live service,
  real media or an ffmpeg Job.

## Considered options

- **A. A separate harness workflow with its own path filter.** Rejected: a path-filtered workflow does not report when
  skipped, and it would not be a required context, so it neither deadlocks nor gates. Both are wrong.
- **B. A new required context `harness-test`.** Rejected here: it needs a repository settings change, which this
  follow-up does not make. Worth doing later; the finalizer below then simply becomes redundant for it.
- **C. Compose the existing required `test` context as an always-reporting, fail-closed finalizer over the site tests,
  the harness tests and the routing tests (the `e2e-gate` pattern).** Chosen.

## Decision outcome

Chosen: **C**, with these rules.

1. **Components.** `scripts/ci-components.py classify` maps every changed path to one of:
   `site` (`apps/*`, `packages/*`, the root Node manifests, lockfile and workspace file, `Dockerfile`, `.dockerignore`,
   the lint, TypeScript and release-please configs, `.agents` data files the unit tests parse), `harness`
   (`tools/media-repair-harness/**`, the old in-tree location, the public suite and `GATES.md` of the harness context,
   the EPUB source under `media-repair-actual-epub-2026-10-18/`, and root Python packaging files: `pyproject.toml`,
   `requirements*.txt`, `uv.lock` and similar), `docs` (Markdown, `docs/`, `.agents` notes: selects nothing) and
   `shared` (`.github/**`, `scripts/ci-*`, `scripts/e2e-gate-paths.sh`, `scripts/tests/**`: selects every component).
   A path no rule names is `unknown` and also selects every component. Packaging files are root-only, so an
   `apps/web/requirements.txt` belongs to the site.
2. **The file list comes from git.** The `changes` job checks out the full history and lists the merge-base diff
   (`git diff --name-only -z --no-renames base...head`). Without rename detection a rename is a delete plus an add, so
   both the old and the new path are listed and moving a file out of a component still selects it; a deletion is a
   path like any other. The paginated files API is no longer used by `ci.yml`.
3. **Fail closed.** The classifier selects every component when the diff cannot be computed (a missing commit, no
   merge base, a shallow clone), when the list is empty, when it holds fewer paths than the PR reports
   (`changed_files`), when it reaches 3000 paths, on any unexpected error, and on the release-please PR. If the script
   cannot run at all, `changes` is red, the component jobs run (their guard is `!= 'false'`) and `test` is red.
4. **Jobs.** `ci.yml` keeps `lint-and-typecheck` and `build` and renames the site's unit-test job to `site-test`. New:
   `harness-test` (Python 3.11, `MRH_REQUIRE_SUITE=1 bash tools/media-repair-harness/scripts/ci-test.sh`, when the
   harness is selected) and `ci-routing-tests` (always: `python3 -m unittest discover -s scripts/tests`).
5. **`test` is the finalizer.** The required context `test` is now a job with `if: always()` that needs `changes`,
   `lint-and-typecheck`, `site-test`, `build`, `harness-test` and `ci-routing-tests`, and runs
   `ci-components.py finalize`. It is green only when `changes` succeeded and every job of every selected component
   succeeded. A selected job that failed, was cancelled or was skipped is red. An unselected component's job may be
   skipped; one that ran and failed or was cancelled is still red. `ci-routing-tests` must always succeed. Because
   `test` also waits on `lint-and-typecheck` and `build`, an unexpected skip of either is caught here although their
   own contexts, skipped, would satisfy protection by themselves.
6. **Unchanged.** The names `lint-and-typecheck`, `test`, `build` and `e2e-gate`; `e2e.yml`, `e2e-gate-paths.sh` and
   the gate's semantics; `build-image` (advisory; its inputs still come from `ci-code-paths.sh --image`);
   `e2e-advisory.yml`. `ci-code-paths.sh` keeps its site rule and now also calls the harness paths not-site, so the
   advisory Playwright suite does not run for a harness-only PR. `ci-components.py` is the authority for `ci.yml`;
   a routing test checks the two agree.
7. **The harness stays out of the site image.** The Dockerfile copies named paths only; `.dockerignore` now lists
   `tools/media-repair-harness`; release-please excludes it, like `.agents` and `docs`, so a harness commit does not
   open a release PR for a byte-identical image. Tests pin all three, and that `pnpm-workspace.yaml` does not include
   `tools`.
8. **No heavy work in PR CI.** The harness job runs only the deterministic stdlib tests; a test asserts the workflow
   names no Ollama, ffmpeg, GPU or benchmark step. Synthetic ffmpeg smoke jobs and model benchmarks stay separate
   Jobs outside PRs.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a harness-only PR runs only the harness tests, a site-only PR only the site checks, and a docs-only PR neither; the harness is gated by the required `test` context without touching branch protection. |
| C-02 | Good: the routing rules and the finalizer have 70+ stdlib tests that run in CI before `test` can pass, including a throwaway-git-repository test for renames, deletions, a stale base and an incomplete list. |
| C-03 | Good: a routing mistake fails closed (every component runs) instead of skipping checks. |
| C-04 | Bad: `test` now takes one extra runner on every PR, including docs-only PRs where it used to be skipped (it reports success instead of skipped), and it finishes after the slowest site job. ADR-104 established that public-repo minutes are not billed. |
| C-05 | Bad: `lint-and-typecheck` and `build` still report on their own; an unexpected skip of one is caught only through `test`, because protection treats a skipped context as passing. A repository settings change (later) can require `harness-test` directly. |
| C-06 | Bad: two path rules now exist (`ci-components.py` for `ci.yml`, `ci-code-paths.sh` for `e2e-advisory.yml` and `--image`). A routing test compares them on a fixed sample; it is not a proof for every path. |
| C-07 | Bad: `harness-test` calls `tools/media-repair-harness/scripts/ci-test.sh`, which the packaging change creates. Until both land together the job fails; merge them as one change. |

## More information

- Routing rules and tests: `scripts/ci-components.py`, `scripts/tests/test_ci_components.py`.
- Workflow: `.github/workflows/ci.yml`. Docs: `CLAUDE.md` (Workflow), `README.md` (CI table), `docs/ops/003-local-verification.md`.
