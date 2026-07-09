# 2026-07-09 — Trash wall cold path: live profile + ADR-035 read-model (perf/trash-wall-cold-path)

Owner report: Trash → Movies/TV STILL "take forever" on v0.25.0 (after PR #139's pagination +
page-scoped exclusion checks). This note records the LIVE profile that pinned the real cost, and
the before/after measurements for the ADR-035 fix.

## Live profile (haynesnetwork.com, v0.25.0, 742 movie / 13 tv candidates)

Isolated-cold tRPC timings (unbatched GETs, 12 s gaps to outlive the 8 s memo; hnet-e2e admin):

| endpoint | cold | notes |
|---|---|---|
| `trash.pending` movie p1 | **9 247 ms / 6 140 ms** (two runs) | the wall's first page |
| `trash.pendingCandidates` movie | 3 445 ms | fires in parallel on the tab (admin) |
| `trash.pending` tv p1 | 1 900 ms | |
| `trash.status` (audit) | 1 677 ms | 5 serial Maintainerr reads |
| `trash.overview` | 134 ms | open batches existed ⇒ DB path |
| warm p1 / p2 (memo) | 491 / 40 ms | page-scoped exclusion reads are cheap |
| tab burst (5 concurrent) | **7 194 ms wall-clock** | pending + candidates both crawl |
| browser first wall tile (`/trash?tab=movies`) | **9 114 ms** | httpBatchLink gates the flight on the slowest call — even the DB-fast batch wall waited |

Maintainerr API measured in-cluster (exec from the app pod):

| call | time |
|---|---|
| `GET /api/collections` | 43 ms |
| `GET .../content/1?size=50` | **5 811 ms** (cold Maintainerr; ~0.4–1 s warm — per tunnel runs) |
| `GET .../content/1?size=750` (all 742) | **163 ms** |
| `GET /api/rules/exclusion?mediaServerId=…` | 2 ms |

Root cause: Maintainerr's PER-CALL cost dominates its content API — 742 items at size=50 is 15
serial expensive calls (~6–9 s per crawl), and one tab load fired up to FOUR concurrent crawls
(`pending`, `pendingCandidates`, `overview`×2 kinds; the 8 s memo has no in-flight dedup). The
page-scoped exclusion N+1 (#139's fix) was already a non-issue at ~2 ms/read in-cluster.

## Fix (ADR-035 / DESIGN-010 D-11)

Postgres read-model `trash_candidates` (+ `_state`), migration 0027 — refreshed by the
full/incremental sync post-step, rule-edit triggers, and a manage-gated `trash.refreshCandidates`;
expedite/sweep drop deleted ids immediately. Walls/candidates/Overview serve from PG; ledger join +
visible-page exclusion checks stay live. Prod: serve-stale instantly + background refresh past
20 min ("candidates as of N min ago" + Refresh in the counts bar). Non-prod: inline refresh per
read (read-through determinism for dev/e2e/vitest). Also: `fetchMaintainerrPending` pages at 500
with bounded-parallel collections (all LIVE safety paths get the same win) and the audit's four
sub-reads run concurrently.

## Before/after (hermetic bench, 742+13 items, live-measured latency model: content 600 ms/call +
0.2 ms/item, collections 40 ms, exclusions 3 ms — `packages/domain` bench, embedded PG16)

| measurement | BEFORE (v0.25.0 path) | AFTER (snapshot) |
|---|---|---|
| one cold materialization crawl | **9 827 ms** (16 serial content calls) | n/a on request path |
| `trash.pending` p1 (incl. 50 live exclusion checks) | ≥ crawl (6.1–9.2 s live) | **46 ms** |
| `trash.pending` p1 warm / p2 | 491 / 40 ms (8 s memo) | 35 / 34 ms (no memo needed) |
| `trash.pendingCandidates` | 3 445 ms live | **9 ms** |
| Overview per-kind count | crawl ×2 serial | **1 ms** (state row) |
| snapshot rebuild (background/cron) | — | **1 444 ms** modeled (3 content calls); ~0.5 s live warm Maintainerr |

Targets: first wall paint < 2 s warm ✓ (page ~50 ms; the flight is now bounded by the audit,
~0.5 s after its parallelization) · cold refresh < 5 s in background ✓ (1.4 s modeled; the one
cold-Maintainerr outlier call ~5.8 s can stretch a background refresh, never the paint).

Ship notes: no CronJob manifest change (the shared secret already carries `MAINTAINERR_API_KEY`;
the post-step is skip-if-absent). First paint after deploy does ONE inline refresh (or wait one
incremental tick). Live re-measure after deploy: repeat the isolated-cold curl of `trash.pending`
p1 + a `/trash?tab=movies` first-tile trace.
