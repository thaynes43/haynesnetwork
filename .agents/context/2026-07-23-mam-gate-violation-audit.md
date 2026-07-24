# 2026-07-23: MAM gate-violation audit + resume-hysteresis remediation

The MAM compliance governor issued a real MyAnonaMouse (MAM) violation overnight. This note is the
audit of what happened, the root cause, and the fix. The design of record is
[ADR-077](../../docs/adrs/077-mam-governor-resume-hysteresis.md) +
[DESIGN-027 D-09](../../docs/designs/027-mam-compliance-governor.md); the operator view is
[OPS-013 section 10](../../docs/ops/013-mam-books-acquisition.md); the plan is
[PLAN-061](../plans/061-mam-governor-resume-hysteresis.md). The compliance contract these rules serve is
[2026-07-11-mam-rules-scrape.md](2026-07-11-mam-rules-scrape.md).

## The violation

- **MAM message:** "Attempted to Download Past Unsatisfied limit" with a download block of about 26 hours.
- **Timestamp:** MAM server-side unsatisfied count crossed its hard 200 cap at **2026-07-23 23:59:08 UTC**.
- **Live tuning at the time:** `MAM_UNSATISFIED_LIMIT=200`, `MAM_UNSATISFIED_BUFFER=15` (Elite VIP), so the
  single gate threshold was `200 − 15 = 185`. Pause and resume shared that one level.

## What the governor saw (all UTC)

1. The unsatisfied count pinned at exactly **185** with the gate CLOSED for about four hours.
2. At **23:49** the count dipped to **184**. Because resume and pause were the same level, the gate reopened
   immediately.
3. LazyLibrarian's queued backlog fired about **100 MAM searches in 4 minutes** through Prowlarr the moment
   the indexer re-enabled.
4. Unsatisfied jumped **184 to 199 inside a single 15-minute sampling interval**.
5. MAM's own server-side count crossed the hard **200** cap at 23:59:08 and issued the violation + block.
6. The governor re-paused at **00:04** on seeing 199, but the damage was already done.

Loki history shows this exact flap **15 times in 3 days**: every resume at 180 to 184 re-flooded to 188 to
200 within one or two cycles, touching headroom 0 once on 2026-07-22 at 11:49.

## Audit findings (what is NOT broken)

- **Cron healthy.** The `mam-governor` CronJob cadence is unbroken; runs fire on schedule and complete.
- **Actuation verified both directions.** The Prowlarr indexer toggle works; the first MAM search landed
  **19 ms after re-enable**, and disable propagates to LazyLibrarian cleanly.
- **Count accurate.** All 353 torrents in the client are MAM torrents in category `books-mam`. There is no
  cross-seed and no second-client leakage, so the local unsatisfied count is a true reflection of the
  MAM-side count. The governor's count is not the problem.

## Root cause (two design gaps, both in the gate math)

1. **No resume hysteresis.** Pause and resume shared the single `limit − buffer` threshold, so the gate
   reopened the instant the count fell one below the pause line, with no margin to absorb a fresh reopen
   burst. The buffer only reserves slots for grabs already past Prowlarr's search at pause time; it does not
   also cover a reopen burst.
2. **A 15-minute sample cannot see an intra-interval burst.** A queued LazyLibrarian backlog consumes the
   entire 15-count buffer between two samples, so by the time the next sample fires the cap is already
   breached. The reopen burst adds +15 to +17 unsatisfied per 15-minute interval.

## Remediation

- **Code (this release, PLAN-061 / ADR-077 / DESIGN-027 D-09):** add a **resume floor** distinct from the
  pause threshold, plus a **dead band** between them where the gate holds.
  - Pause rule unchanged: an OPEN gate closes when `unsatisfied ≥ threshold` (185 live).
  - Resume rule new: a CLOSED gate reopens only when `unsatisfied < resumeFloor` (170 live).
  - Dead band `resumeFloor ≤ unsatisfied < threshold` (170 to 184 live): the gate HOLDS its current state.
  - `resumeFloor` defaults to `limit − 2×buffer` (200 − 30 = 170), overridable by `MAM_RESUME_FLOOR` (an
    absolute count, validated `0 ≤ floor < threshold`, else the derived default plus a warning).
  - First sight (no state row) is treated as CLOSED.
  - Rationale for 170: the observed reopen burst is +15 to +17 per interval, so seating the floor one full
    burst below the real 200 cap means one post-resume burst peaks around 185 to 187 and the next sample
    re-closes the gate before the cap is reached.
- **Cluster (haynes-ops, temporary, held until lift):** the `mam-governor` CronJob is **suspended**
  (`suspend: true`) so grabs do not flap while the download block is active and before this release deploys.
  With the gate held open by the suspend, the operator watches the cap manually in the interim (usenet keeps
  flowing regardless; MAM is the fallback).

## Lift checklist for the suspend

Lift only when BOTH conditions hold:

1. The MAM download block has **expired** (about **2026-07-25 02:23 UTC**, roughly 26 hours after the
   23:59:08 violation).
2. This release (the resume-hysteresis change) is **deployed** to staging.

Then, in the haynes-ops repo, a single follow-up change:

- Bump the `haynesnetwork` image tag to the released version.
- Remove `suspend: true` from the `mam-governor` CronJob block (or set it to `false`).
- Reconcile Flux and confirm the next scheduled run logs the new `resumeFloor` field and holds the gate in
  the dead band as expected.

No `MAM_RESUME_FLOOR` env override is needed: the derived default (170 at the live 200/15 tuning) is the
intended value, so the knob stays unset unless the owner later wants a different floor.
