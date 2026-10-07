# ADR-104: The advisory e2e suite runs on every code PR again

- **Status:** Accepted (2026-10-07; drafted and accepted by an agent under the Accept authority in
  `.agents/plans/README.md`, on the coordinator's work order carrying the owner's ruling)
- **Date:** 2026-10-07
- **Deciders:** owner ruling 2026-10-07 (billing: only private repos billed) · drafted by Sonnet 5.5
- **Supersedes in part:** [ADR-102](102-ci-minutes-budget.md) rule 4 only ("The advisory suite is opt-in") and its
  consequence C-04. Every other rule of ADR-102 stands.

## Context and problem statement

[ADR-102](102-ci-minutes-budget.md) cut CI because it assumed this repo's Actions minutes counted against the owner's
3,000 included minutes. They do not. haynesnetwork is a public repo on GitHub-hosted `ubuntu-latest` runners, which
GitHub does not bill, and the owner confirmed on his billing usage page that only his private repos were billed; those
now run on self-hosted runners, so there is no billing problem left. ADR-102's "11,751 billed minutes" were computed job
durations, not billed minutes. This repo only used the most runner time.

So the one ADR-102 change that cost coverage bought nothing: the advisory Playwright suite stopped running on
non-pipeline PRs unless someone labelled the PR `run-e2e`. A regression in a page or a router outside the gated
pipeline paths now first showed on the release PR (ADR-102 C-04). The other ADR-102 changes cost no coverage and still
cut wait and runner time, so they stay.

## Decision drivers

- Do not pay a coverage cost for a saving that does not exist.
- Keep ADR-100's gate (`e2e-gate`, the pipeline paths, the release PR always gated, fail closed) exactly as it is.
- Do not run the same 14-minute suite twice on one PR.
- Keep the label useful.

## Considered options

- **A. Restore ADR-100's advisory run on every PR, docs-only included.** Rejected: a docs-only PR cannot break what
  the suite drives, and the run only adds wait and runner load.
- **B. Run the advisory suite on every PR that changes a code path (`scripts/ci-code-paths.sh`), plus on `run-e2e`.**
  Chosen.
- **C. Leave the opt-in as it is.** Rejected: it keeps a coverage hole for a premise that was false.

## Decision outcome

Chosen: **B**, with these rules.

1. **The advisory suite runs on every PR that changes a code path and is not already gated.** `e2e-advisory.yml` gains a
   `changes` job that lists the PR's files and applies the two path rules the other workflows already use:
   `scripts/e2e-gate-paths.sh` (the pipeline paths) and `scripts/ci-code-paths.sh` (code at all). The suite runs when
   the PR changes a code path and no pipeline path. It never blocks a merge and is not a required check.
2. **No double run.** A pipeline PR and the release-please PR already run the full suite as `e2e / e2e` behind
   `e2e-gate`, so the advisory run skips them, labelled or not.
3. **The `run-e2e` label now means "force the advisory run".** It still runs the advisory suite on a PR that has no
   code path (a docs-only or `.agents/`-only PR), for example to run the suite on `main`'s code through that PR's merge
   tree. It is not needed on a code PR. Adding the label runs the suite on the label and on every later push while the
   label stays; adding any other label never re-runs it.
4. **Unchanged from ADR-102:** docs-only PRs skip lint, typecheck, test, build and the image build (reported as
   skipped, which satisfies branch protection); a push to main runs only release-please (plus `warm-pnpm-cache` and
   `owed-checks`, as now); `build-image` runs only on image inputs or the release PR; release-please ignores
   `.agents/`- and `docs/`-only commits; `e2e.yml` keeps `workflow_dispatch`; `e2e-gate` is untouched.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a regression in a page or router outside the pipeline paths shows on its own PR again, not first on the release PR. This replaces ADR-102 C-04. |
| C-02 | Good: ADR-102's docs-only skips, the empty push-to-main run and the image-build filter stay, so those PRs still wait less. |
| C-03 | Neutral: a code PR starts one more job (the advisory `changes` job, seconds) and the suite runs about 14 minutes after it. Nobody waits for it; it is advisory. |
| C-04 | Neutral: the advisory suite and the gate use the same two hand-kept path lists, so a new kind of file is code by default and a new pipeline path is added in `e2e-gate-paths.sh` only. |
| C-05 | Bad: the advisory run still finishes after most merges (ADR-100 measured two to sixteen minutes after). Its value is the red result a reviewer or the next agent sees, not a block. |

## More information

[ADR-100](100-e2e-gates-the-book-pipeline.md) (the gate), [ADR-102](102-ci-minutes-budget.md) (the cut this corrects in
part), [ADR-009](009-ci-and-pr-flow.md) (required checks). `.github/workflows/e2e-advisory.yml`,
`scripts/ci-code-paths.sh`, `scripts/e2e-gate-paths.sh`.
