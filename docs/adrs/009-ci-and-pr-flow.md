# ADR-009: CI and PR flow — required checks, GATE A cutover, release-please

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

This is a solo-maintainer repo built largely by agents. It needs a gate that stops broken
code from reaching `main` (and therefore the cluster, ADR-006) without a second human to
review PRs — and it needs that gate *without* strangling the bootstrap phase, when the
scaffold, CI itself, and the first tests are still being assembled and a PR flow would
gate on checks that don't exist yet. Both sibling repos solved this identically: bootstrap
directly on `main`, then a one-time cutover to branch-protected PR flow once CI is real
(demo-console `.agents/plans/011-pr-flow-cutover.md` "GATE A"; todos-for-dues
`scripts/setup-branch-protection.sh`). PRD-001 R-65 requires the same shape here.

## Decision drivers

1. CI is the merge gate — there is no reviewer quorum to rely on (solo maintainer).
2. Bootstrap velocity first, then an irreversible ratchet to PR-only.
3. Required status check contexts must equal GitHub Actions **job keys** exactly; name
   drift silently deadlocks every PR (proven pitfall in both sibling repos).
4. Releases must be automated from commit history: versioning, changelog, and the image
   tag ADR-006 deploys.
5. Linear, squash-only history keeps `main` bisectable and release-please parsing clean.

## Considered options

- **Option A** — Two-stage: bootstrap direct-push, then GATE A flips on branch protection
  and PR-only flow, with named required checks + release-please + tag-triggered images.
- **Option B** — PR flow with branch protection from the very first commit.
- **Option C** — Direct-push to `main` indefinitely; CI advisory only.
- **Option D** — PR flow with a required human approval (review count ≥ 1).

## Decision outcome

Chosen option: **Option A** — the proven sibling pattern; B gates bootstrap on checks that
don't exist yet, C leaves the deployable branch unguarded forever, and D deadlocks a solo
maintainer who cannot approve their own PRs.

- **CI (GitHub Actions):** jobs named exactly **`lint-and-typecheck`**, **`test`**, and
  **`build`** — these job keys become the required status check contexts. A fourth **`e2e`**
  job (Playwright, ADR-010) runs on PRs but stays **advisory** until hardening.
- **Releases:** release-please runs on `main`, driven by conventional commits
  (`feat:`/`fix:`/`feat!:`); merging its release PR tags `v*`.
- **Images:** a `v*` tag triggers build + push of `ghcr.io/thaynes43/haynesnetwork`
  (the artifact ADR-006 deploys). The image job is deliberately **not** a required check —
  it only runs on tags, so requiring it would deadlock PR merges (rationale recorded in
  todos-for-dues `setup-branch-protection.sh`). Cosign signing is planned into this
  workflow before the cluster's Kyverno cosign policy moves from audit to enforce
  (ADR-006 C-04).
- **Stage 1 (bootstrap):** commits land directly on `main` while the scaffold and CI are
  assembled.
- **GATE A cutover:** once the scaffold exists and all three CI jobs are green on `main`,
  branch protection is applied via `gh api` and recorded in `.agents/plans/`:
  strict up-to-date-with-`main` required, required contexts exactly the three job names,
  squash-merge only with required linear history, **0 required reviews** (solo maintainer —
  CI is the gate), force pushes and deletions blocked. From that commit on, **all** work —
  agents included — lands through PRs.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: bootstrap proceeds at full speed; the gate arrives exactly when there is something real to gate on. |
| C-02 | Good: after GATE A nothing reaches `main` (and thus a `v*` tag and the cluster) without green lint/typecheck, tests, and build. |
| C-03 | Good: conventional commits give free versioning + changelog, and the release tag is the single trigger for the deployable image. |
| C-04 | Bad: no human review requirement — CI quality is the only bar. Mitigated by the docs-first process (plans carry validation docs) and by keeping `e2e` visibly red when it fails even while advisory. |
| C-05 | Bad: required-check names are load-bearing config; renaming a CI job without updating branch protection deadlocks all PRs. Mitigated by an idempotent setup script kept in-repo (sibling pattern). |
| C-06 | Neutral: `e2e` stays advisory until the suite is stable enough to require — flipping it later is a one-line protection change. |
| C-07 | Neutral: `enforce_admins` stays off as a break-glass path, matching the sibling repos. |

## More information

- PRD-001 R-65 (PR flow + required checks), R-66 (the e2e suite this flow runs).
- ADR-006 (what the `v*` image feeds; Kyverno signing consequence), ADR-010 (what `test`
  and `e2e` actually execute).
- Pattern donors: demo-console `.agents/plans/011-pr-flow-cutover.md` (GATE A mechanics,
  including proving the gate with a deliberately failing PR); todos-for-dues
  `scripts/setup-branch-protection.sh` and `.github/workflows/` (`ci.yml`, `e2e.yml`,
  `release-please.yml`).
- CLAUDE.md "Workflow" section documents the day-to-day flow this ADR fixes.
