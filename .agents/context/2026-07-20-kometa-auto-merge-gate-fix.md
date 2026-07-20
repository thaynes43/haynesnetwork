# 2026-07-20 — Kometa collection auto-merge gate: false-negative fix

**Scope:** `packages/haynesops`, the collections domain writer seam (`packages/domain/kometa-collections.ts`),
DESIGN-042 D-10. PR `fix/kometa-auto-merge-gate`. Ships code + tests + docs together. Does NOT drive the
release train — the coordinator sequences release/deploy.

## What today's first live write proved (PR4b canary, haynes-ops #2170/#2171)

The Kometa collection write path is functionally correct end-to-end, but the auto-merge gate was **inert**:
every eligible within-cap grouping-only add degraded to a human merge, and the add mutation blocked ~135s.

Two live false-negatives, same cause:

- `HaynesopsReadClient.getChecksConclusion` rolled up **EVERY** check-run on the PR head. A haynes-ops PR
  head carries the full Flux Local matrix (~7 runs, main+edge) + Diff Scope + the one Kometa validate check.
- `waitForChecks` was hard-bounded at 20×6s = 120s and the router passed no override.
- Live, twice: the **`Kometa Validate Managed Files - Success` check was green on the FIRST poll**, all
  app-side conditions held (capAsserted, not-materialization, findMissing=false, managedFileOnly), but the
  Flux Local matrix was still `in_progress` at t=120s → rolled-up conclusion `pending` → `checksGreen=false`
  → `merged:false, autoMergeBlockedReason:"validation gate not green"`. Minutes later everything was green
  and both PRs were `mergeable: clean`. A pure timing/scope false-negative.
- Secondary: the write blocked ~135s synchronously (the full poll) — a 2+ minute UI spin per add.

## Prereq findings (read-only, from the dev-env pod)

- **Branch protection.** The dev-bot token cannot read `/branches/main/protection` (403 — scoped App token).
  Via the readable rulesets + `/rules/branches/main`: the **"Main" ruleset** has `pull_request`
  (`required_approving_review_count: 0`, squash allowed), `deletion`, `non_fast_forward` — and **no
  `required_status_checks`**. Classic branch protection (unreadable here) supplies the required checks: the
  live PR heads + Renovate's working native auto-merge show the required set is the **Flux Local matrix +
  Diff Scope** ("- Success" roll-up jobs).
- **The Kometa validate check is NOT a required status check** and cannot be one: its workflow
  (`kometa-validate-managed.yaml`) is **path-filtered** to the two managed-include files, so on any other PR
  it never reports — a required check that never reports would permanently block it. Proven live: Renovate PR
  #2132 is `mergeable_state: clean` with **no Kometa check** on its head.
- **Repo allows auto-merge** (`allow_auto_merge: true`, squash allowed) — Renovate uses native auto-merge
  routinely. So native auto-merge is mechanically available.
- **Token identity.** The app signs PRs with `HAYNESOPS_WRITE_TOKEN` (config.ts), **not** the dev-bot token.
  That secret is an ExternalSecret/1Password value not present in this pod (and, per the ⚠ in config.ts, not
  yet provisioned in-cluster), so its ability to arm native auto-merge is **unknowable from here**.

## Decision: app-enforced named gate, deferred out of the request path — NOT native auto-merge

The task's preferred shape (arm GitHub native auto-merge, let branch protection enforce the gate) rests on
the premise that main's required checks include the Kometa validate gate. **That premise is false** — the
gate is a path-filtered, non-required check, so native auto-merge would merge on Flux Local/Diff Scope
**without** the validate gate green. That cannot faithfully implement D-10. (And the app token's arming
capability is unverifiable here anyway.) So the app stays the gate enforcer. Per the task's own fallback
instruction, this is the correct branch.

## The fix

1. **Scope the gate to ONE named check.** `getChecksConclusion(ref, { requiredCheckName })` rolls up ONLY the
   named validate check; every sibling (Flux Local, Diff Scope) is ignored. Absent-but-expected → `pending`
   (never `success` — the safe default). Directly kills the false-negative. Name is config
   (`HAYNESOPS_KOMETA_CHECK_NAME`, default `Kometa Validate Managed Files - Success`).
2. **Arm + return immediately.** The add mutation opens the PR, proves the three compile/PR-time conditions
   (within-cap, grouping-only, managed-file-only), then makes ONE scoped gate check: already green → merge
   in-request; already red → leave for a human; **not settled → ARM a deferred (background) wait on the named
   gate that squash-merges the instant it goes green.** No user click blocks on the poll again.
3. **Honest degrade.** The deferred merge self-catches and never throws to the request path; a gate that
   fails/times out, a merge that errors, or a pod restart that loses the in-process task all leave the PR
   OPEN for a human (the pre-existing safe default). `evaluateKometaAutoMerge` is now the pure 3-condition
   **eligibility** policy (the runtime CI gate moved out of it, enforced separately by the scoped check).

The collection row's async state spine (drafting → PR opened → merged (auto|human) → run → mirrored) is
unchanged; `collections-sync` still reconciles the produced collection to `live` by title (Q-05).

## Follow-ups (not in this PR)

- The deferred merge is an **in-process** background task (fire-and-forget seam, default). A pod restart
  mid-wait loses it → the PR stays open for a human. No cron backstop was added (Q-05 keeps collections-sync
  out of the PR-merge business). If the "auto" guarantee needs to survive restarts, a small reconcile pass
  over `listOpenManagedPrs` (already on the read client) is the natural home — a future increment.
- `HAYNESOPS_WRITE_TOKEN` is still not provisioned in-cluster (config.ts ⚠). The write path can't run live
  until it is — orthogonal to this fix.
