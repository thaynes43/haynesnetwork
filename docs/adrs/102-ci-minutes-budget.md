# ADR-102: CI spends runner minutes only where a change can break something

- **Status:** Accepted (2026-10-07; drafted and accepted by an agent under the Accept authority in
  `.agents/plans/README.md`, on the coordinator's work order after the owner's account ran out of its included
  Actions minutes)
- **Date:** 2026-10-07
- **Deciders:** Tom Haynes (owner; the minutes budget) · drafted by Opus 5.5
- **Supersedes in part:** [ADR-100](100-e2e-gates-the-book-pipeline.md): "`e2e` runs ... for a push to main" and
  "every other PR runs the same suite as `e2e-advisory`". The gate itself (`e2e-gate`, the pipeline paths, the
  release-please PR always gated, fail closed) stands unchanged.

## Context and problem statement

The owner's account used all 3,000 included Actions minutes seven days into the billing cycle, and this repo was the
largest consumer. Measured from 2026-10-01 to 2026-10-07 (every run's jobs, `started_at` to `completed_at`, each job
rounded up to a whole minute as GitHub bills it):

| Where the minutes went | Runs | Billed minutes | Share |
|------------------------|-----:|---------------:|------:|
| The Playwright suite, every mode (`e2e`, `e2e / e2e`, `e2e-advisory / e2e`) | 427 | 5,251 | 45% |
| CI `test` | 441 | 2,136 | 18% |
| CI `lint-and-typecheck` | 441 | 1,583 | 13% |
| CI `build-image` | 441 | 1,222 | 10% |
| CI `build` | 441 | 860 | 7% |
| Claude advisory review | 218 | 346 | 3% |
| release-please, the e2e `changes` and `e2e-gate` jobs, owed checks | | 353 | 3% |
| **Total** | 1,964 runs | **11,751** | |

| By trigger | Billed minutes |
|------------|---------------:|
| PR pushes: 90 on docs-only PRs (2,419), 105 on pipeline PRs (2,750), 21 on other code PRs (530), plus the Claude review | 5,699 |
| Pushes to main (127): CI 1,620, the suite 1,629, release-please 229 | 3,478 |
| Release PR updates (98): CI 1,281, the suite 1,279 | 2,560 |

Most of it bought nothing:

- **The Playwright suite ran on every PR**, about 14 minutes each: as `e2e / e2e` on a pipeline PR, as the advisory
  `e2e-advisory` on every other PR, docs-only and `.agents/`-only PRs included. Of the 100 PRs merged in the window
  besides release PRs, 45 changed no code at all.
- **It ran again on every push to main.** Branch protection is strict (ADR-009: up to date with `main` before
  merging), so the squash-merged tree is exactly the merge ref the PR's checks already passed. The push run re-tested
  a tree that had just passed, and the release PR then ran it a third time.
- **CI ran lint, typecheck, the unit tests, the build and the image build on docs-only PRs and on every push to main**,
  for the same reasons.
- **A docs-only merge reopened or updated the release PR**, because the `docs` changelog section is visible: that
  re-ran full CI and the gated suite on the release PR, and offered a release whose image is byte-identical
  (`.dockerignore` excludes `docs` and `.agents`). Release PR #809 (v0.109.4) is exactly that.
- **The advisory suite protected nothing in practice.** ADR-100 measured it: on 18 of 19 PRs it finished two to
  sixteen minutes after the merge. Nobody waits for an advisory check.

## Decision drivers

- No merge gate gets weaker: the four required contexts keep reporting on every PR, and nothing reaches a release
  without the suite passing on the release's tree.
- A required check that never reports deadlocks every PR (ADR-009 C-05), so a path filter must never skip a whole
  workflow that owns a required check.
- Spend a runner only where the change can break what the runner checks.

## Considered options

- **A. Workflow-level `paths-ignore` for docs.** Rejected: a workflow skipped by a path filter leaves its required
  checks pending forever, so every docs PR would deadlock.
- **B. A `changes` job, and required jobs that always run but no-op on docs PRs** (the `e2e-gate` pattern). Works,
  but each no-op job still takes a runner and is billed a whole minute: three minutes per docs PR for nothing.
- **C. A `changes` job, and required jobs skipped by their `if:` on docs PRs.** GitHub records a job skipped by its
  `if:` as a skipped check, and a skipped check satisfies a required status check. Costs nothing on a docs PR.
- For the advisory suite: **keep it on every non-pipeline code PR**, **make it opt-in by label**, or **drop it**.
- For main: **keep the push runs**, **replace them with a nightly run**, or **drop them**.

## Decision outcome

Chosen: **C**, the advisory suite **opt-in by label**, and **no runs on a push to main**, with these rules.

1. **Docs-only PRs skip the CI jobs.** `ci.yml`'s new `changes` job lists the PR's files and runs
   `scripts/ci-code-paths.sh`, an allow-list of docs-only paths with a `--self-test` that CI runs: Markdown at any
   depth, everything under `docs/`, everything under `.agents/` except its data files (`*.yaml`, `*.yml`, `*.json`,
   which the unit tests parse), `LICENSE`, the workspace file and `.gitkeep`. Anything else is code, so a new kind of
   file is checked by default. With no code path, `lint-and-typecheck`, `test`, `build` and `build-image` are skipped
   and report as skipped. If `changes` fails, they run (fail safe). The release-please PR always runs in full.
   `build-image` (not required) also skips a code PR that changes no image input (`ci-code-paths.sh --image`: the
   Dockerfile, `.dockerignore`, any `package.json`, the lockfile, the workspace file, `.npmrc`, Next's config, `ci.yml`):
   the Docker build fails where `pnpm build` passes only when those change, and the release PR, whose diff always
   includes `package.json`, still builds the image before every release.
2. **Nothing runs on a push to main**, neither CI nor the suite. Strict protection makes the merged tree the tested
   tree. The one exception is `warm-pnpm-cache`, on a push that changes `pnpm-lock.yaml`: a PR restores the pnpm
   store cached on `main` but never another PR's, so `main` needs one per lockfile. `owed-checks.yml` (hourly on
   `main`) installs only `@hnet/sync`'s tree, so it now caches under a key of its own and can never save that partial
   store under the key the CI jobs restore.
3. **No scheduled run replaces the push run**, because no guarantee rests on it. A red suite must never ship, and the
   release PR still runs the suite on `main`'s tree before every release (ADR-100 option B, unchanged); protection
   makes the release PR be up to date with `main` before it merges. `e2e.yml` gains `workflow_dispatch`, so
   `gh workflow run e2e.yml --ref main` checks `main` by hand when wanted.
4. **The advisory suite is opt-in.** `e2e-advisory.yml` runs the suite on a PR labelled `run-e2e`, on the label and on
   every later push while the label stays, and never blocks. Without the label the job's `if:` is false and no runner
   starts. Label a non-pipeline PR that changes something the suite drives (a page, a router) when you want the run
   before merging; a pipeline PR already runs it as the gate.
5. **A commit touching only `.agents/` and `docs/` never opens or updates the release PR** (`exclude-paths` in
   `release-please-config.json`). Such a commit cannot change the image, so the release PR has nothing to release
   for it, and it no longer re-runs the release PR's CI and suite. A docs commit that also touches code is listed in
   the changelog as before.
6. **Markdown never gates.** `scripts/e2e-gate-paths.sh` ignores `*.md`, so a README inside a pipeline package does
   not run the 14-minute suite.

Superseded runs were already cancelled (`concurrency` with `cancel-in-progress` on pull requests in `ci.yml`,
`e2e.yml` and the Claude review), and stay so; the opt-in advisory run has the same, at job level so a skipped run
never cancels a running suite. Pushes to main, releases and tags never cancel mid-publish.

Expected cost, from the same week's per-job averages (billed minutes):

| Change | Per push, before | Per push, after | After merge, before | After merge, after |
|--------|-----------------:|----------------:|--------------------:|-------------------:|
| Docs-only PR | 27 | about 5 (two `changes` jobs, `e2e-gate`, the Claude review) | 54 | 2 (release-please only) |
| Other code PR | 25 | about 15 (CI without the image build, unless an image input changed) | 54 | 28 (the release PR's CI and suite) |
| Pipeline PR | 26 | 26 (the gated suite stays) | 54 | 28 |
| Release PR update | 26 | 26 | | |

Replayed over the measured week that is about 5,300 billed minutes instead of 11,751. What remains is the gate
itself: the suite on pipeline PRs and on the release PR.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a docs-only PR costs about 5 billed minutes per push instead of 27, and about 2 after the merge instead of 54. |
| C-02 | Good: a merge no longer re-runs CI and the suite on `main`; the release PR is the post-merge run, as it already was. |
| C-03 | Good: no release PR, CI run or suite run for a docs-only merge, and no release of an identical image. |
| C-04 | Bad: a non-pipeline code PR no longer shows e2e results unless labelled `run-e2e`. A regression there now first shows on the release PR, where the red suite holds the release (ADR-100 option B) and someone must find the PR that broke it. Mitigated by the label, and by `workflow_dispatch` on any branch. |
| C-05 | Bad: the docs-only list is hand-kept, like the pipeline list (ADR-100 C-04). A new file that CI reads must not match it; the allow-list shape means a new kind of file is code by default, and the self-test lists examples. |
| C-06 | Neutral: three required checks show as "skipped" on a docs-only PR; branch protection accepts that as passing. Renaming any of them still deadlocks every PR (ADR-009 C-05, OPS-004 section 6). |
| C-07 | Neutral: `main` has no green check of its own after a merge; its tree's checks are the merged PR's, and the release PR's. |

## More information

ADR-009 (required checks, strict protection), ADR-100 and issue #742 (the gate), OPS-004 sections 1 and 6.
GitHub documents that a job skipped by its `if:` reports as passing for a required check, and that a workflow skipped
by a path filter leaves its checks pending ("Troubleshooting required status checks").
