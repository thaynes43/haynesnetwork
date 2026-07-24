# PLAN-061: MAM governor resume hysteresis — a distinct resume floor + dead band

- **Status:** 🚧 **IN PROGRESS** (PR open; docs-first, code + tests green locally; NOT merged — the
  coordinator reviews the docs diff first). Docs of record:
  [ADR-077](../../docs/adrs/077-mam-governor-resume-hysteresis.md) (supersedes ADR-054 C-05),
  [DESIGN-027 D-09](../../docs/designs/027-mam-compliance-governor.md),
  [OPS-013 section 10](../../docs/ops/013-mam-books-acquisition.md), PRD-001 R-234, glossary T-228/T-229.
  Incident + audit: [`../context/2026-07-23-mam-gate-violation-audit.md`](../context/2026-07-23-mam-gate-violation-audit.md).
- **Number note:** the incident brief called this "041", but plan 041 is already taken
  (`041-library-fix-books-and-parity.md`) and plan numbers are stable and never reused (see this folder's
  README), so it takes the next free number, **061**.
- **Depends on:** PLAN-039 (the shipped governor). Independent of PLAN-040 (the DB-backed knob) — the resume
  floor resolves through the same `resolveGovernorConfig` seam, so PLAN-040 will pick it up for free.

## The problem

The governor shipped (PLAN-039) with a SINGLE gate threshold (`limit − buffer`). Pause and resume happened at
the same level, so a CLOSED gate reopened the instant the count dipped one below the threshold. On
2026-07-23 (UTC) that flapped into a real MAM violation: with the live 200/15 tuning (threshold 185), a resume
at 184 let LazyLibrarian's queued backlog fire about 100 MAM searches in 4 minutes, unsatisfied jumped
184 to 199 inside one 15-minute sample, MAM's hard 200 cap was crossed at 23:59:08, and the account earned an
"Attempted to Download Past Unsatisfied limit" violation with a roughly 26h download block. Loki shows the
flap 15 times in 3 days. The audit confirmed the count is accurate, actuation works both directions, and the
cadence is unbroken — the flaw is purely gate math: no resume hysteresis, and a 15-minute sample cannot see an
intra-interval burst that eats the whole 15-count buffer between two samples. Full write-up in the context
note linked above.

## Scope — the behavior spec

Add a resume floor distinct from the pause threshold, with a dead band that holds:

- **Pause rule unchanged:** an OPEN gate closes when `unsatisfied ≥ threshold` (`= limit − buffer`).
- **Resume rule new:** a CLOSED gate reopens only when `unsatisfied < resumeFloor`.
- **Dead band:** `resumeFloor ≤ unsatisfied < threshold` — the gate HOLDS its current state.
- **`resumeFloor` default derived:** `limit − 2×buffer`, clamped `0 ≤ floor < threshold` (live 200/15 gives
  170; the code default 20/5 gives 10). Env override `MAM_RESUME_FLOOR` (absolute count). Validate
  `0 ≤ floor < threshold`; on invalid or unparseable, fall back to the derived default and log one warning.
- **Unknown prior state (first sight, no `mam_gate_state` row) is treated as CLOSED** (reopening then
  requires `< floor`). Preserve the existing first-sight no-notification baseline.
- **Fail-closed on count errors is unchanged.**
- **`resumeFloor` in the per-run structured log line** (next to limit/buffer/threshold), the report, the
  outbox payload, and the config resolution.
- **Rationale for 170:** observed reopen bursts add +15 to +17 unsatisfied per 15-minute interval; the floor
  sits one full burst plus margin below the real 200 cap, so one post-resume burst peaks around 187 and the
  next sample re-closes.

No schema change: the floor is recoverable from the persisted `limit`/`buffer` (or the env override), so
`mam_gate_state` gains no column and there is no migration.

## Code (packages/domain — the single-writer)

- `mam-governor.ts`: `MamGovernorTuning` gains `resumeFloor`; `deriveResumeFloor()` +
  `resolveGovernorConfig()` resolve/validate `MAM_RESUME_FLOOR`; `computeDesiredGate()` takes the current
  gate state and applies the two-level rule; `evaluateMamGovernor()` threads the prior gate state (first
  sight ⇒ CLOSED) and carries `resumeFloor` into the report/payload; `MamGovernorReport` gains `resumeFloor`.
- `packages/sync/orchestrator.ts`: the per-run log line adds `resumeFloor`.
- `packages/sync/scripts/sync.ts`: `resolveGovernorConfig` is called with the CronJob logger as the warning
  sink for an invalid `MAM_RESUME_FLOOR`.
- `mam-clients.ts` / `packages/downloads/config.ts`: unchanged — `MAM_RESUME_FLOOR` is a TUNING knob read in
  `resolveGovernorConfig` alongside `MAM_UNSATISFIED_LIMIT`/`BUFFER`, not a client-env knob.

## Tests (packages/domain/__tests__/mam-governor.test.ts)

- Incident regression: closed gate, threshold 185, floor 170, count 184 stays closed, no `mam_gate_resumed`.
- Closed gate reopens at count 169 (below floor) with a resume event.
- Open gate stays open at 184 (dead band), closes at 185 with a pause event.
- Dead-band hold in both directions across consecutive evaluations (no event spam).
- Default floor derivation from limit/buffer; `MAM_RESUME_FLOOR` override honored; invalid env (floor ≥
  threshold, negative, garbage) falls back to the derived default (with a warning).
- Unknown prior state treated as CLOSED.
- Fail-closed path unchanged.

All five local gates green: `pnpm lint` (0 errors), `pnpm lint:css`, `pnpm typecheck`, `pnpm test`,
`pnpm build`.

## Rollout

1. **This repo:** branch → PR → required checks (`lint-and-typecheck`, `test`, `build`) green →
   squash-merge → release-please cuts a `feat` minor. DO NOT MERGE until the coordinator reviews the docs
   diff.
2. **haynes-ops (follow-up, gated):** the `mam-governor` CronJob is currently **suspended** (`suspend: true`)
   as the incident mitigation. Once the MAM download block expires (about 2026-07-25 02:23 UTC) AND this
   release is deployed, a single haynes-ops change bumps the `haynesnetwork` image tag and removes
   `suspend: true` (see the context note's lift checklist). No `MAM_RESUME_FLOOR` env override is needed —
   the derived default (170 at 200/15) is the intended value.
