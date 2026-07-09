# ADR-035: Trash candidate read-model in Postgres (snapshot-backed walls)

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Tom Haynes

## Context and problem statement

The Trash Movies/TV walls, the Overview counts, and the Start-a-batch preview were READ-THROUGH:
every tRPC call re-derived the pending set from Maintainerr's collection API. PR #139 (paginated
wall + page-scoped exclusion reads) fixed the 776-serial-exclusion N+1, but the owner reported the
tabs STILL "take forever" on v0.25.0. A live profile (2026-07-09, 742 movie candidates) found:

- `GET /api/collections/media/:id/content/:page` costs **~0.4–5.8 s PER CALL in-cluster**
  regardless of page size — Maintainerr's per-call overhead dominates. At `size=50` the 742-item
  collection is **15 serial calls ≈ 6–9 s**; one `size=750` call answers in **~0.16 s** (warm).
- One tab load fires up to FOUR concurrent full crawls (`trash.pending`, `trash.pendingCandidates`,
  `trash.overview` × 2 kinds) — the 8 s in-process memo has no in-flight dedup, so concurrent
  cold requests each crawl, competing on the same Maintainerr instance.
- The client's `httpBatchLink` resolves a whole query flight together, so even a DB-fast batch
  wall waited for the slowest crawl in its flight: measured **first wall tile 9.1 s**
  (`trash.pending` cold: 6.1–9.2 s isolated; page-scoped exclusion GETs are a non-issue at ~2 ms
  in-cluster).

The wall is a browsing surface over a deletion pipeline with week-long windows — it does not need
second-level freshness, but it must paint instantly and stay honest about its age.

## Decision drivers

- First wall paint < 2 s warm; a cold rebuild must never block the paint path in production.
- Every safety property intact: destructive flows keep reading LIVE Maintainerr through the
  guarded seams; protection state on visible tiles stays real-time.
- Multiple consumers (web pod, sync CronJobs) and pod restarts — an in-process cache cannot serve
  them; Postgres already anchors everything else.
- dev/e2e determinism: a stub-state change must be visible on the next read (the lesson that
  shaped the prod-only page memo).

## Considered options

1. **Materialize the candidate set into Postgres** (chosen) — sync CronJobs + on-demand refresh
   rebuild a `trash_candidates` snapshot; walls/Overview/preview serve from PG.
2. Hot in-memory cache with warmup — rejected: per-pod (restarts lose it), invisible to the
   CronJob consumers, and no honest cross-consumer staleness story.
3. Faster read-through only (big pages + parallel collections + in-flight dedup) — necessary but
   not sufficient: still ~0.5–6 s cold on the paint path, still a Maintainerr fan-out per visit.

## Decision outcome

Chosen option: **Postgres read-model, plus the faster crawl for every remaining live path** —
because the profile shows the crawl itself is the cost, and only a cross-process store serves the
walls, the Overview, and the CronJobs from one honest snapshot.

- **Tables:** `trash_candidates` (per-kind flat rows: collection id/title/deleteAfterDays,
  maintainerr id, tmdb/tvdb ids, size, verbatim addDate, crawl `ord`) + `trash_candidates_state`
  (per-kind `refreshed_at`, count, bytes). Migration `0027`. Maintainerr-owned facts only — the
  ledger/metadata join stays at read time so titles/tags/watch/requester facets track the media
  sync, not the candidate refresh.
- **Single writer:** `packages/domain/src/trash-candidates.ts`
  (`refreshTrashCandidates` — advisory-locked snapshot-replace; `removeTrashCandidateRows` — the
  expedite/sweep read-model cleanup). Both tables join the no-direct-state-writes guard list.
- **Refresh cadence:** the `full`/`incremental` sync modes end with a skip-if-absent refresh step
  (incremental runs every 15 min); rule edits and an admin/manager "Refresh" affordance
  (`trash.refreshCandidates`, `manage_batches`-gated) trigger it on demand; expedite and the batch
  sweep drop their deleted ids immediately.
- **Freshness policy:** production serves the snapshot instantly and, past 20 min, refreshes in
  the BACKGROUND (deduped); only a never-refreshed install refreshes inline. Non-production
  (dev/e2e/vitest) refreshes INLINE on every read — read-through equivalence, same determinism
  rationale as the retired memo. The wall shows "candidates as of N min ago".
- **Crawl speedup (all callers):** `fetchMaintainerrPending` now pages at 500 with
  bounded-parallel collections (one ~0.16 s call per collection at household scale), and the
  preflight audit's four sub-reads run concurrently — the live safety paths (guardian, expedite,
  batch create, sweep, space-policy) get the same win without touching their semantics.

### Safety invariants (unchanged)

- The read-model is DISPLAY-ONLY. `expediteDeletion`, `createBatchFromPending`,
  `sweepExpiredBatches`, `guardRecentlyWatched`, and `resolvePendingTarget` still call
  `listTrashPending` / `fetchMaintainerrPending` LIVE and re-run the SAFE gate + guardian + live
  exclusion checks per run. Nothing is ever deleted from snapshot data.
- The paginated wall still cross-checks the VISIBLE PAGE's exclusions LIVE per request, so a save
  made anywhere shows Protected on the next paint.
- Exclusion writes (save/unsave) are unchanged; they never touch the snapshot (membership only
  changes when Maintainerr re-evaluates its rules).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: warm wall reads are Postgres-speed (measured ~15–30 ms server-side at 742 candidates; the request path makes zero Maintainerr collection calls). |
| C-02 | Good: the read-model also feeds Overview counts and the Start-a-batch preview — the per-visit Maintainerr fan-out is gone everywhere. |
| C-03 | Bad: candidates can be up to ~15 min stale in production (one sync tick). Accepted for a week-window deletion pipeline; mitigated by the honest "as of" line, the Refresh affordance, rule-edit triggers, and immediate expedite/sweep row removal. |
| C-04 | Bad: a new table pair + refresh plumbing to maintain; the snapshot can drift from Maintainerr between refreshes (only ever display-side — see the safety invariants). |
| C-05 | Exemption (documented): the read-model writers append NO ledger audit rows — the snapshot is derived, rebuildable state, not domain truth (hard rule 6 applies to guarded DOMAIN state; the guard test still confines the writes to `@hnet/domain`). |
| C-06 | Ops: the wall now renders during a Maintainerr outage (stale snapshot + SafetyBanner); the first-ever paint after `0027` needs one refresh (inline on first read, or the next incremental tick / a "Refresh" click). |

## More information

- Live profile + measurements: `.agents/context/` dated note 2026-07-09 (trash wall cold path);
  numbers reproduced in DESIGN-010's amendment.
- DESIGN-010 (Trash section) — amended 2026-07-09 with the snapshot read path and wire changes.
- ADR-023 (Trash orchestrators), ADR-025 (curation pipeline), ADR-033 (per-kind tabs), PR #139
  (pagination + page-scoped exclusions — the predecessor fix this supersedes on the read path).
