# ADR-077: MAM compliance governor — resume hysteresis (a distinct resume floor below the pause threshold)

- **Status:** Accepted (owner ruling 2026-07-24: proceed with the hysteresis hardening)
- **Date:** 2026-07-23 · **Amended 2026-07-25** (owner-directed in-place edit) — the burst magnitude
  C-02 derives the resume floor from was measured wrong by a factor of ~3. See
  [Amendment 2026-07-25](#amendment-2026-07-25--the-burst-basis-was-wrong) before tuning anything.
- **Deciders:** Tom Haynes (owner) · executed by an autonomous run
- **Supersedes:** [ADR-054](054-mam-compliance-governor.md) consequence **C-05** (the buffer as the ONLY
  anti-flap / cap-safety margin, with pause and resume sharing the single `limit − buffer` threshold).
  ADR-054 C-01 (durable Prowlarr seam), C-02 (zero MAM API surface), C-03 (fail-closed), C-04 (smart-alerts
  shape + confined write), C-06 (fullSync coupling), and C-07 (the `resolveGovernorConfig` tuning seam) all
  **stand** — the seam, the counting, the fail-closed posture, and the config seam are unchanged.
- **Relates:** [DESIGN-027](../designs/027-mam-compliance-governor.md) D-09 (the rule table + default
  derivation + validation), [ADR-034](034-pushover-batch-notifications.md) (the same-tx transition outbox),
  PRD-001 R-174/R-234, glossary T-228/T-229, OPS-013 §10. Realized in `packages/domain/mam-governor.ts`
  (`computeDesiredGate` + `resolveGovernorConfig`).

## Context and problem statement

ADR-054 shipped the governor with a **single gate threshold**: `threshold = limit − buffer`. An OPEN gate
closes at/above the threshold; a CLOSED gate reopens the instant the count drops back below the same
threshold. C-05 named the buffer as the ONLY anti-flap / cap-safety margin.

On 2026-07-22/23 (all UTC) that single threshold produced a compliance violation. With the live Elite VIP
tuning (`limit 200`, `buffer 15` ⇒ threshold 185), the unsatisfied count pinned at 185 with the gate closed
for four hours, then dipped to 184 at 23:49. Resume and pause being the same level, the gate reopened at once.
LazyLibrarian's queued backlog immediately fired ~100 MyAnonaMouse searches in four minutes through Prowlarr;
unsatisfied jumped 184 → 199 inside a single 15-minute sampling interval; MAM's server-side count crossed its
hard 200 cap at 23:59:08 and issued an "Attempted to Download Past Unsatisfied limit" violation with a
download block of ~26 hours. The governor re-paused at 00:04 seeing 199. Loki shows this flap 15 times in
three days — every resume at 180–184 re-flooded to 188–200 within one or two cycles, touching headroom 0 once
on 07-22 11:49. The audit (`.agents/context/2026-07-23-mam-gate-violation-audit.md`) confirmed the count is
accurate (all 353 client torrents are `books-mam` MAM torrents, no cross-seed leakage), actuation works both
directions (first MAM search 19 ms after re-enable), and the cadence is unbroken. The flaw is purely design:
(1) no resume hysteresis, and (2) a 15-minute sample cannot see an intra-interval burst that consumes the
entire 15-count buffer between two samples.

## Decision drivers

1. **A resume must not immediately re-breach.** The reopen level must sit far enough below the hard cap that
   one post-resume burst peaks under the cap and the next sample re-closes — the buffer alone (which only
   covers grabs already past Prowlarr's search at pause time) cannot also absorb a fresh reopen burst.
2. **Keep every ADR-054 invariant.** Same durable Prowlarr seam, zero MAM API surface, fail-closed on count
   error, one config seam. This is a gate-math change only.
3. **Derive a safe default, allow an override.** The floor must have a sensible default from the existing
   knobs and an absolute-count env override, validated so a mis-set value can never wedge the gate.
4. **No new schema.** The floor is fully recoverable from `limit`/`buffer` (or the env override); it needs no
   `mam_gate_state` column and no migration.

## Decision outcome

Add a **resume floor** distinct from (and strictly below) the pause threshold, with a **dead band** between
them in which the gate holds its current state.

| ID | Consequence |
|----|-------------|
| C-01 | **Two-level gate (supersedes ADR-054 C-05).** Pause and resume no longer share one threshold. An OPEN gate closes when `unsatisfied ≥ threshold` (`= limit − buffer`); a CLOSED gate reopens only when `unsatisfied < resumeFloor`. In the **dead band** `resumeFloor ≤ unsatisfied < threshold` the gate **HOLDS** its prior state. The buffer keeps its ADR-054 role (slots reserved for grabs already past Prowlarr's search when we pause); the resume floor is the SECOND, independent margin that stops a reopen from re-flooding. `computeDesiredGate` takes the current gate state as input to decide the hold. |
| C-02 | **Derived default `resumeFloor = limit − 2×buffer`, clamped `0 ≤ floor < threshold`.** ⚠ **The burst figure this consequence was derived from is WRONG — see the [2026-07-25 amendment](#amendment-2026-07-25--the-burst-basis-was-wrong); a +58 single-interval burst was observed. The `limit − 2×buffer` FORM stands, but it is only as safe as the buffer, which must be ≥ the true worst-case burst.** *(Original text, retained for the record: "Observed reopen bursts add +15..+17 unsatisfied per 15-minute interval, so the floor sits one full burst below the pause threshold: for the live 200/15 tuning the floor is 170, so a reopen burst peaks around 185–187 (under the hard 200 cap) and the next sample re-closes.")* The code default 20/5 yields floor 10. The clamp guarantees the floor is never ≥ threshold (which would collapse back to the single-threshold flap) nor negative. |
| C-03 | **Env override `MAM_RESUME_FLOOR` (absolute unsatisfied count), validated.** A valid override is `0 ≤ floor < threshold`; anything else (out of range, negative, unparseable) falls back to the derived default and logs one warning. It resolves through the SAME `resolveGovernorConfig` seam as `MAM_UNSATISFIED_LIMIT`/`BUFFER` (ADR-054 C-07 unchanged), so PLAN-040's future DB-backed override covers it too. |
| C-04 | **First sight is treated as CLOSED.** With no `mam_gate_state` row the gate is conservatively CLOSED, so reopening requires `unsatisfied < resumeFloor` — a fresh deploy in the dead band does not open. The ADR-054 first-sight baseline behavior (record state, page nothing) is preserved: the first run still enqueues no transition notification. |
| C-05 | **Fail-closed and the transition/stuck audit are unchanged.** A failed count still yields a closed gate regardless of the prior state; the same-tx `mam_gate_paused`/`mam_gate_resumed`/`mam_gate_stuck` outbox coupling (ADR-034 C-01) is untouched. The per-run structured log line and the report/payload now also carry `resumeFloor` alongside `limit`/`buffer`/`threshold`. No schema change — the floor is derived from persisted `limit`/`buffer` (or the env override). |

## Consequences

- **Positive:** the 15-times-in-three-days flap is eliminated by construction — a resume at 184 (dead band)
  can no longer happen; reopening waits for the count to fall a full burst below the cap, so a single reopen
  burst cannot cross the hard limit, and the incident's exact sequence (184 → resume → 199 → violation) is now
  a covered regression test. Every ADR-054 compliance invariant is preserved (seam, zero MAM surface,
  fail-closed, config seam). No migration, no new operator surface.
- **Negative / trade-offs:** the gate now stays paused longer on the way down (through the whole dead band),
  so MAM throughput is slightly lower near the cap — accepted, because the cap is a hard compliance limit and
  usenet keeps flowing throughout. The dead band widens with the buffer; an operator who sets a very large
  buffer relative to the limit gets a floor clamped toward 0 (still safe, just a wider hold).
- **Follow-ups:** ~~the temporary `haynes-ops` CronJob suspend applied during the incident is lifted once the
  MAM download block expires (~2026-07-25 02:23 UTC) AND this release is deployed (PLAN-061 rollout).~~
  **DONE** — block expired 02:23, v0.90.0 deployed, suspend lifted by haynes-ops #2233 (merged 2026-07-25
  04:28 UTC). PLAN-040 will surface `resumeFloor` in the DB-backed admin setting behind the same
  `resolveGovernorConfig` seam.

## Amendment 2026-07-25 — the burst basis was wrong

**In-place amendment, owner-directed** (the normal process for an Accepted ADR is a superseding ADR; the
owner ruled to edit this one directly). The two-level gate mechanism is unchanged and worked exactly as
specified. What was wrong is the **empirical input** C-02 sizes the margin from.

Within two hours of the un-freeze, the post-freeze backlog drain produced this (all UTC, 15-minute samples):

| time | unsatisfied | delta |
|------|-------------|-------|
| 04:49 | 90 | gate reopened (`mam_gate_resumed`) |
| 05:34 | 90 | flat — nothing snatched yet |
| 05:49 | 108 | +18 |
| 06:04 | **166** | **+58 in one interval** |

**+58 against a documented worst case of +17.** At the then-live 200/20 tuning (pause edge 180) a burst
that size caught at 179 lands near **237** — past the hard 200 cap and into a repeat of the exact violation
this ADR exists to prevent.

Two lessons, the second more important than the first:

1. **The buffer must be ≥ the true worst-case single-interval burst, not the observed-so-far burst.** Both
   the 15 and the 20 were fitted to the largest number seen at the time, which is a floor on the true worst
   case, never an estimate of it. `MAM_UNSATISFIED_BUFFER` is now **50** (pause edge 150, resume floor 100),
   deliberately conservative while the surge drains — see haynes-ops #2256.
2. **The dead band can hold the gate OPEN into a rising count.** C-01 specifies the hold as symmetric, and
   at 166 the count sat inside 160..179, so the gate held OPEN with no pause scheduled — hysteresis working
   as designed, in the dangerous direction. The hold is only safe while one interval's climb cannot cross
   the cap from the top of the band. **Open design question (owner):** should a rising trend across samples
   override the dead-band hold, making the hold asymmetric (sticky when falling, yielding when rising)?

Live response, 2026-07-25: the gate was closed out-of-band by a one-off `--mode=mam-governor` run at
buffer 50 (06:06 UTC — `mam_gate_paused`, `actuated: true`, at unsatisfied 169), then haynes-ops #2256
merged and reconciled so the cron could not reopen at the stale floor of 160. Verified steady at 06:19 and
06:34: `gateOpen false`, `indexerEnabled false`, `actuated false`, count flat at 169.

**Do not treat 50 as a considered answer.** It is a safe placeholder chosen under time pressure during a
live climb. The +58 followed a multi-day freeze, so it is plausibly a backlog artifact rather than
steady-state behavior — but that is a hypothesis, not a measurement. Retune only against bursts measured
after the surge has drained, and amend this section with the number rather than the anecdote.

## References

- Supersedes ADR-054 C-05 (C-01..C-04, C-06, C-07 stand). Reuses ADR-034 (same-tx outbox). No migration
  (the floor derives from the persisted `limit`/`buffer`, or `MAM_RESUME_FLOOR`; a value ≥ threshold is
  rejected to the derived default). Incident + audit: `.agents/context/2026-07-23-mam-gate-violation-audit.md`.
  Implemented in `@hnet/domain` (`mam-governor.ts` — `computeDesiredGate`, `deriveResumeFloor`,
  `resolveGovernorConfig`); logged in `@hnet/sync` (`orchestrator.ts`). Design of record: DESIGN-027 D-09.
