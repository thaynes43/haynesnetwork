# 2026-07-19 — GB quota watch: monitoring the first clean day under the call-budgeter

> **WATCH CLOSED (2026-07-20):** the first budgeted day HELD — all four success criteria passed,
> verified in-cluster ~12:44 UTC. Do NOT re-arm the checks below; the only residual is the
> end-of-day confirmation described in [[2026-07-20-gb-first-budgeted-day-verified]].

> **CORRECTION / SUPERSEDED (later 07-19):** the "~100/day cap" premise below is WRONG. GCP console
> confirmed a genuine 1,000/day quota that was SHARED (and saturated) by three consumers on one key.
> Root cause + the fix (key split + budget raise to 700/200/100) are in [[2026-07-19-gb-quota-resolved]].

Owner handed the app off for the weekend (usage resets Monday 07-20) and asked to **monitor the
Google Books quota to see if it resolves**, noting the daily reset around 07:00 UTC. This note is the
durable resume point for that watch — the in-session cron reminders that drive it are session-only and
die with the tmux session, so if you are a fresh session reading this, re-arm the checks below.

## Where the GB quota saga stands

The saga's **final layer shipped as v0.88.0 (#433)** — a per-consumer daily **call-budgeter**
(`gb_call_budget`, migration 0070). Full design + evidence: `2026-07-19-gb-call-budget-machine.md`
and `2026-07-18-gb-call-budget.md` in this folder; DESIGN-039 D-20a..D-24.

Measured reality: the shared GB key's effective cap is **~100 calls/day** (the modern low default, not
the legacy 1000), reset at **07:00 UTC**. The budgeter splits that: `PAIRING=60 / GOODREADS=25 /
BOOKFIX=15` legs/day (bookfix metered but never blocked — reserved headroom for interactive Fix). A
spent slice `skippedBudget`s WITHOUT tripping the shared breaker. Pairing now drains **oldest+ISBN-first**
so the frozen 2026-07-10 cohort (216 unresolved / 28 ISBN-bearing at handoff) drains front-to-back —
projected ~6–7 days.

## Why today (07-19) proves nothing

v0.88.0 only reached the cluster at **~11:43 UTC on 07-19**, but the daily quota had already been blown
by the OLD un-budgeted behavior earlier the same day — `gb_quota_state` tripped `daily` at **08:32 UTC**,
`exhausted_until 2026-07-20T07:00:00Z`. So for the rest of 07-19 every GB consumer correctly
`skippedQuota` (breaker open, cap preserved) and `skippedBudget:0` (budgeter never had to act). Deploy is
confirmed: pod `haynesnetwork-main` + all sync jobs on `v0.88.0`, flux HR Ready.

## THE ACTUAL TEST — Mon 07-20 07:00 UTC reset (the first clean budgeted day)

Baseline to beat: on 07-19 the breaker re-tripped only ~1.5h after reset (08:32 UTC). Under the budgeter
it should NOT.

Two checks are armed as session-only crons (recreate with CronCreate if the session died):
- **~08:18 UTC / 04:18 EDT** — post first pairing (07:32) + goodreads (07:41) runs.
- **~14:07 UTC / 10:07 EDT** — midday, did the breaker hold all day.

What to read (read-only `kubectl logs -n frontend` on the newest `haynesnetwork-sync-format-pairing`
and `-sync-goodreads` pods):
- **SUCCESS** = daily breaker NOT tripped; pairing `minted > 0` (real GB resolves from the ISBN-first
  cohort); unresolved count trending down from 216; goodreads enriches its slice then `skippedBudget`s.
- **FAILURE** = daily breaker trips `daily` again → the real cap is below ~100 or the per-consumer
  budgets overshoot. Pull the `gb_call_budget` row (read-only psql: image
  `ghcr.io/cloudnative-pg/postgresql:16.4-34`, `envFrom haynesnetwork-secret`, ns frontend, delete
  after) to see which consumer overshot, then propose a budget-tightening env change via haynes-ops.

If the cap holds and the cohort drains: the **GB quota saga is RESOLVED** (budgeter works unattended) —
say so plainly to the owner and fold this into the next HANDOFF top block.

## Housekeeping flag (not GB)

The old task worktree `/home/dev/work/haynesnetwork-0717-133132` (branch `docs/day-wrap-0718`) carries a
large pile of UNCOMMITTED changes from the previous agent (collections builder client, e2e captures,
loose screenshots). It is disposable — anything there not committed/merged is lost work per the
backlog-to-main rule. Left untouched by this watch; reconcile or discard deliberately, don't let
`agent-run` cleanup silently eat it.
