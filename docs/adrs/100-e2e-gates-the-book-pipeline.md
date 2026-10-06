# ADR-100: The e2e suite gates changes to the book pipeline

- **Status:** Accepted (2026-10-06; the owner approved the safeguard on issue #742 after the books-rollout review,
  implemented by an agent, Accept authority per `.agents/plans/README.md`)
- **Date:** 2026-10-06
- **Deciders:** Tom Haynes (approved safeguard 2 of 4, review recommendation R-05) · drafted by Sonnet 5.5
- **Supersedes in part:** [ADR-009](009-ci-and-pr-flow.md) C-06 and [ADR-010](010-test-strategy.md) C-07 (e2e "stays
  advisory until hardening"), for the paths named below only. Both ADRs stand otherwise.
- **Closes:** [#742](https://github.com/thaynes43/haynesnetwork/issues/742). Evidence: finding W-06 and
  recommendation R-05 in `.agents/context/2026-10-06-books-rollout-adversarial-review.md`.

## Context and problem statement

`e2e` was advisory, and a red one did not stop anything. PR #675 changed the Goodreads push to skip `addBook` for a
held book and broke `apps/web/e2e/integrations.spec.ts:109`, the one spec that drives exactly that push. The suite
stayed red on the heads of #675, #676, #681, #698 and #701, six releases shipped (v0.106.0 to v0.107.2), and it was
fixed 24 hours later by #706. On 18 of the 19 fix PRs in the window the job finished two to sixteen minutes after the
merge, because PRs merged four to twenty-six minutes after opening and the suite takes about 15 minutes.

Making every PR wait 15 minutes for e2e would tax docs and UI work for no gain, and the suite had real flakes that a
hard gate would have turned into blocked merges. So the gate has to be narrow, and the suite has to be reliable first.

## Decision drivers

- A red suite must stop the train for the code the unit suites cannot see (the stubs drive the real push and sync path
  end to end).
- Docs, UI and unrelated PRs must not wait for it.
- A required check that never reports deadlocks every PR (ADR-009 C-05), so the gate must report on every PR.

## Considered options

- **A. A required `e2e-gate` job that mirrors e2e only when a pipeline path changed.**
- **B. e2e required on the release-please PR only.** Holds the release, not the fix; main stays red.
- **C. e2e required on every PR.** Every docs PR waits about 15 minutes.

## Decision outcome

Chosen option: **A plus B**, in `.github/workflows/e2e.yml`.

- `changes` lists the PR's files (a rename counts under both names) and runs `scripts/e2e-gate-paths.sh` over them.
  The pipeline paths are `packages/{domain,sync,arr,lazylibrarian,goodreads,books,kapowarr,downloads,libretto,db}`,
  `packages/test-utils`, the three tRPC routers the pipeline specs drive (`packages/api/src/routers/{integrations,books,book-fix}.ts`),
  `apps/web/e2e`, `apps/web/playwright.config.ts`, `apps/web/app/(app)/integrations` and the e2e workflow files
  themselves. The list lives in that one script, with a `--self-test` that CI runs.
- The release-please PR (head branch `release-please--*`) is always gated, whatever its files are (option B).
- `e2e` (the suite, from the reusable `e2e-suite.yml`) runs for a gated PR and for a push to main. Every other PR runs
  the same suite as `e2e-advisory`, which never blocks, so UI regressions stay visible as before.
- **`e2e-gate` is the required status-check context.** It always reports: it passes in seconds when the PR is not
  gated, mirrors `e2e` when it is, and fails closed (a `changes` failure, or any `e2e` result but success, is red).
  Branch protection requires `lint-and-typecheck`, `test`, `build` and `e2e-gate`.
- The advisory Claude review stays advisory and is not a required check, but a PR waits for it and reads it before
  merging (R-05, second half): the review job takes one to three minutes, and the review was the only check that
  completed before merge in the window.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a red e2e blocks a change to the pipeline packages and blocks the release PR, so it can no longer ride through releases. |
| C-02 | Good: docs, UI and other PRs pass the gate at once and keep the advisory e2e. |
| C-03 | Bad: a pipeline PR waits about 15 minutes for the suite, and a runner loss or a flake shows as a red gate to re-run (`gh run rerun --failed`). Mitigated by deterministic fixes for the two flakes found (hydration races in `signIn` and the storage target editor). |
| C-04 | Bad: the path list is a hand-kept approximation of "the pipeline". A new package on the book path must be added to `scripts/e2e-gate-paths.sh` (the self-test lists examples). |
| C-05 | Neutral: renaming the `e2e-gate` job deadlocks every PR until branch protection is updated (OPS-004 section 6). |

## More information

Issue #742; PR #706 and issue #702 (the red spec); ADR-009, ADR-010; OPS-004 section 6 for the protection call.
