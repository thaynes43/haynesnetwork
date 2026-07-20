# 2026-07-20 — GB first budgeted day: VERIFIED HELD (the quota saga's proof day)

Closes the watch armed in [[2026-07-19-gb-quota-monitor-watch]]; fix stack + root cause in
[[2026-07-19-gb-quota-resolved]]. In-cluster verification ran ~12:44 UTC via an Opus dispatch
(read-only kubectl + a created-then-deleted psql probe job `gb-quota-probe-verify`).

## Verdicts (all four success criteria PASS)

- **(a) Daily breaker HELD** — `gb_quota_state` at 12:44: `exhausted_until=NULL, tripped_at=NULL`,
  last written 09:32 UTC (a clear, not a trip). Zero daily-signature 429s ("Queries per day" /
  `dailyLimitExceeded`) in any log all day. The 07-19 baseline (daily trip at 08:32 UTC, ~1.5h
  after reset) did NOT recur — today's 08:32 pairing run minted 25 with `skippedQuota:0`.
- **(b) Pairing minting real resolves** — 24–25 minted EVERY hourly run (07:32 → 12:32), 265 GB
  calls spent of the 700 budget. `candidates:1538, paired:331` steady; revived 20→59 and
  reconciled 37→121 climbing run-over-run.
- **(c) Cohort draining** — inferred (no direct unresolved counter in logs): sustained at-cap
  minting + rising revived/reconciled. At ~25 mints/run the frozen 2026-07-10 cohort (~216)
  drains within the day, as projected in the resolved note.
- **(d) Goodreads enriching + budget-skipping gracefully** — enriched until `used:201` of the 200
  slice (09:43), then `skippedBudget:100` cleanly at 10:41 and 11:41. `synced:2/2, failed:0,
  transientBlips:0` every run. The book-fix that parked while the breaker was briefly open
  (07:41, 08:42) SELF-HEALED to completion at 09:43 — the v0.88.2 behavior working live.

## Deploy state

Pod `haynesnetwork-main` + both sync CronJobs (`sync-format-pairing`, `sync-goodreads`) all on
**v0.88.2**, healthy, 0 restarts. Budget env verified on both jobs:
`GB_DAILY_CALL_BUDGET_PAIRING=700 / GOODREADS=200 / BOOKFIX=100`.

## gb_call_budget row (quota_day 2026-07-20, read ~12:40 UTC)

| consumer | spent / budget |
|---|---|
| pairing | 265 / 700 |
| goodreads | 201 / 200 (fully spent, by design; the +1 overshoot is benign) |
| bookfix | 1 / 100 |

## Benign anomalies (no action)

- **Three per-minute burst 429s** right after the reset (07:32 pairing, 07:41 + 08:42 goodreads),
  each a clean 2-minute cool-off (`retryAfter` = trip + exactly 2min), all self-cleared by 09:32.
  This is the breaker working as designed, not the failure mode. Pairing's `skippedQuota:1365` at
  07:32 is ONE run-level latch event (the first trip short-circuits the rest of that run's GB
  cohort — `packages/domain/src/format-pairing.ts` ~600–636), not 1365 failures; it still minted
  24 first.
- **~33 transient GB 503 `backendFailed`s** across pairing runs — these ARE the `unmintable`
  counts (2/4/6/5/10/6 per run); honest rethrows, retried next run. Not quota-related.
- Non-benign error sweep (excluding the 503s): EMPTY. No LL-push failures, DB errors, or panics.

## What remains open on this thread

1. **Full-day confirmation** lands at the next 07:00 UTC reset — the only theoretical late-day
   risk is retry amplification (logical worst case 700+200+100 = 1,000 = exactly the per-key cap;
   503 retries can push PHYSICAL calls past it). The shared breaker backstops it. An end-of-day
   check (~23:05 UTC) is armed as a session-only cron — re-arm via CronCreate if the session died:
   read the newest pairing+goodreads job logs for a daily trip / `skippedQuota`, and confirm
   pairing hit `skippedBudget` after ~700 spend (projected ~22:30 UTC).
2. **Retry-amplification cap** (optional follow-up from the resolved note): cap goodreads
   `getText` retries so logical ≈ physical. Not urgent.
3. If all-day holds: nothing further — the budgeter runs unattended and the saga is CLOSED.
