# ADR-082: MAM governor — trend-aware dead band + DB-backed audited configuration

- **Status:** Accepted (owner ruling "harden first, then retune" 2026-07-28; authored under
  granted self-accept authority)
- **Date:** 2026-07-28
- **Deciders:** Tom Haynes (owner ruling) · authored by the coordinator

## Context and problem statement

ADR-077 gave the MAM gate hysteresis: pause at `unsatisfied ≥ edge` (edge = limit − buffer),
resume below a distinct floor, and a dead band between them that HOLDS the current state. The
07-25 incident showed the dead band's blind spot: **hysteresis held the gate OPEN through a
climb** (166 inside 160..179, rising +58 in one 15-minute interval), because "hold state" is
insensitive to direction. Measured single-interval bursts have grown every time: **+17 → +58 →
+84.** The current posture (edge 100 of the 200 cap) is safe against +84 but spends ~50% of the
rank allowance; the owner ruled: build the safety layer FIRST, only then discuss raising the
edge, and retune only on measured bursts.

Separately, every retune today is a haynes-ops env PR (`MAM_UNSATISFIED_LIMIT` / `_BUFFER` /
`_RESUME_FLOOR`) — slow, and the floor/limit invariants are validated only at governor runtime.
PLAN-040 (activated by the same ruling) wants the knobs in-app: DB-backed, audited, validated at
write time, with governor state visible where the owner already lives (/admin).

## Decision drivers

- **A rising count must be able to override the dead band** — the exact 07-25 hazard.
- **Flap resistance stays**: ADR-077's hysteresis exists because single-threshold gating
  violated the cap 15× in 3 days. The trend override must not reintroduce flapping.
- **Tuning is an owner act, not a release act** (the ADR-080 precedent): DB-backed, audited,
  no redeploy; invariants (`0 ≤ floor < edge < limit`, cap ≤ 200) enforced at WRITE time.
- **Zero-change deploy**: with no DB row, the governor resolves exactly today's env config.
- Retune-on-measured-evidence stays binding (the 17→58→84 growth rule).

## Considered options

1. Trend override only (env config stays) — halves the ruling; retunes stay PR-bound.
2. DB knobs only (no trend gate) — leaves the 07-25 hazard standing.
3. **Both, one release (PLAN-040): trend-aware dead band + DB-backed audited config +
   governor-state visibility** — chosen.

## Decision outcome

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Trend override:** when the gate is OPEN and `unsatisfied` sits in the dead band, a single-interval rise `current − previous ≥ trendPauseDelta` PAUSES the gate immediately (event `mam_gate_paused`, reason `trend`). Default `trendPauseDelta = 15` — below the smallest measured burst onset (+17), above sampling noise. The override only ever CLOSES the gate (fail-safe direction); resume still requires the floor, so no new flap mode exists (a trend pause cannot re-open until the count drains below the floor). |
| C-02 | **The previous sample is state, not inference:** the governor already persists gate state (`mam_gate_state`); it gains the last observed count + timestamp so the delta is computed against the PRIOR RUN's sample, surviving process restarts. A missing/stale previous sample (first run, gap > 2 intervals) disables the override for that tick — never a delta against ancient data. |
| C-03 | **Config moves to a DB-backed audited setting** (the `app_settings` single-writer pattern): `limit`, `buffer`, `resumeFloor`, `trendPauseDelta`, edited on /admin (Integrations/MAM surface, exact placement in the DESIGN), audit row in the same transaction (hard rule 6). **Resolution: DB row → env (today's values) → code defaults.** No row on deploy ⇒ exactly today's behavior. |
| C-04 | **Write-time validation enforces the invariants** ADR-077 validated only at runtime: `0 ≤ resumeFloor < edge`, `edge = limit − buffer > 0`, `limit ≤ 200` (the hard MAM cap), `trendPauseDelta ≥ 1`. An invalid combination is rejected at the API edge and the writer — it can never be stored, so the governor can never wedge on an unsatisfiable floor (the ADR-077 C-03 hazard class). |
| C-05 | **Governor-state visibility in /admin:** current gate state, unsatisfied count + last-sample delta, the resolved config (and WHERE each value resolved from: db/env/default), last N transitions with reasons (`edge`/`trend`/`floor`), last run time. Read-only surface; the knobs from C-03 sit beside it. |
| C-06 | **The env variables stay honored as the fallback tier** (no haynes-ops change required to ship this); they become dead once a DB row exists. Retiring them from haynes-ops is a later cleanup, never a prerequisite. |
| C-07 | Supersedes ADR-077's dead-band clause IN PART: "the dead band holds state" becomes "the dead band holds state UNLESS the trend override fires (C-01)". Everything else in ADR-077 (distinct floor, hysteresis rationale, the 200 cap) stands. ADR-077's status line gains a "Superseded in part by ADR-082 (dead-band trend override)" note; PRD/glossary numbers at authoring (re-grep; R-238+/T-235+ expected). |
| C-08 | Bad: the governor CronJob now reads config from the DB every tick (one small read — negligible), and a DB outage at tick time falls back to env/defaults for RESOLUTION only (the tick itself already requires the DB for state, so this changes nothing real). |

## More information

- Ruling record: `.agents/context/2026-07-28-owner-rulings-gate-and-mam.md` (Ruling 2).
  Plan of record: `.agents/plans/040-mam-governor-admin-tool.md` (activated 2026-07-28; this ADR
  resolves its open question — the trend gate RIDES PLAN-040, one release).
- Governs: `packages/domain/src/mam-governor.ts` (tick logic + state), the governor CronJob
  (haynes-ops env stays as fallback), the new config writer + /admin surface.
- Related: ADR-077 (+ its two amendments — the +58/+84 measurements), ADR-054 (the governor),
  ADR-080 (the DB-knob precedent), DESIGN-027 D-09 (hysteresis design — amend with the trend
  override + the admin surface in the implementing change).
- Retune protocol (unchanged, binding): edges move only on MEASURED bursts, never quiet windows;
  the invariant to reason with is `edge + worst_burst < limit`.
