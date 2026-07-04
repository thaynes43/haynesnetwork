# @hnet/sync

The *arr → ledger sync runner (DESIGN-005 D-14). This package is a **CronJob CLI**, not
a library the web app imports at request time: it fetches from Sonarr / Radarr / Lidarr /
Jellyseerr and lands the result in the media ledger.

**Direction is one-way by construction.** `@hnet/sync` imports only the `@hnet/arr` **read**
surface (`@hnet/arr/read`) and mutates the ledger **exclusively** through the `@hnet/domain`
single-writers (`upsertMediaItemsBatch`, `tombstoneMissingItems`, `ingestLedgerEvents`,
`backfillEventAttribution`, `completeFixRequests`, `startSyncRun`/`finishSyncRun`). It never
writes drizzle tables directly and never touches `@hnet/arr/write`. The only write-backs to
the *arrs are Fix / Restore / Force-Search, which live in `packages/domain` + `apps/web` —
not here (Hard Rule 4; ADR-008).

> DESIGN-005 D-18 places the CronJob runner in its **own** `@hnet/sync` package
> (`packages/sync/src/scripts/sync.ts`) so the CLI and orchestration stay out of the
> `@hnet/arr` read/write client library. This README is the module-level reference for it.

## Module map (`src/`)

| File | Role |
| --- | --- |
| `scripts/sync.ts` | CLI entry / CronJob command. Parses flags, builds clients, calls `runSync`, exits nonzero only on total failure. |
| `orchestrator.ts` | `runSync` — brackets each source in one `sync_runs` row (`startSyncRun`/`finishSyncRun`), isolates per-source failure, then runs the two post-steps. |
| `arr-full.ts` | `runArrFullSync` — unpaged item-list fetch → batched `upsertMediaItemsBatch` (500/tx) → tombstone pass behind the mass-tombstone guard. |
| `arr-incremental.ts` | `runArrIncrementalSync` — `/history/since` cursor poll (or a bounded newest-first paged bootstrap walk) → normalize → `ingestLedgerEvents`. |
| `seerr.ts` | `runSeerrSync` — paged `/request?sort=added` walk → request/user attribution → `ingestLedgerEvents` (`requested` events). |
| `adapt.ts` | `@hnet/arr` D-02 shapes → the `MediaItemSyncFields` the domain upsert consumes; resolves profile/tag ids to **name/label snapshots** (D-05 decision 3). |
| `normalize.ts` | `HISTORY_EVENT_NORMALIZATION` — the D-07 raw-eventType → ledger-type map; unmapped raw types are **dropped** (no event) but still advance the cursor. |
| `db-reads.ts` | Read-only lookups between writers (history cursor, `arr_item_id` → `media_items.id`, Seerr item match, email → user). Nothing here mutates. |
| `clients.ts` | `buildSyncClients` — per-source read-client construction from the D-18 env contract; `requireClient` narrows. Tests inject stubs. |
| `logger.ts` | JSON-lines console logger (one object per line for k8s log pipelines); `noopLogger` for tests. |
| `index.ts` | Barrel re-export of the above. |

## Run locally

Real CLI (confirmed in `src/scripts/sync.ts`):

```
tsx src/scripts/sync.ts --mode=full|incremental [--source=sonarr|radarr|lidarr|seerr] [--force-tombstones]
```

- `--mode=` is **required** (`full` or `incremental`; else exit 2 with usage).
- `--source=` limits the run to one source; repeatable; default is all four
  (`sonarr`, `radarr`, `lidarr`, `seerr`).
- `--force-tombstones` overrides the mass-tombstone guard (see below).
- `--help` / `-h` prints usage.

Via pnpm (the package `sync` script is `tsx src/scripts/sync.ts`):

```
pnpm --filter @hnet/sync sync -- --mode=incremental
pnpm --filter @hnet/sync sync -- --mode=full --source=radarr
```

**Prerequisites (D-18 env contract):**

- `DATABASE_URL` (required; the CLI exits 2 without it).
- Per requested source: `<SOURCE>_URL` + `<SOURCE>_API_KEY`
  (`SONARR_`/`RADARR_`/`LIDARR_`/`SEERR_`). URLs default to the in-cluster service DNS, so
  in-cluster you set only the API keys. Only the sources this run actually needs are built;
  a missing key for a requested source throws one `ArrConfigError` naming every absent
  variable (values are never echoed).

**Order dependency — full before incremental.** A full sync seeds/updates `media_items`.
Incremental ledger events (`ingestLedgerEvents`) resolve their `media_items` FK from those
rows; against an empty `media_items` they land with `media_item_id NULL`. So on a fresh DB,
run `--mode=full` first, then `--mode=incremental`. (In steady state the CronJobs cover this;
the full run at 04:30 keeps the item table current for the 15-minute incrementals.)

## Full vs incremental

**Full** (`arr-full.ts`) fetches the *arr's entire item list (series/movies/artists +
quality-profile and tag lookups), adapts each to the D-05 field set, and upserts in batches
of `UPSERT_BATCH_SIZE` (500) per transaction. The domain upsert re-matches on external id, so
an *arr that reassigns internal ids does **not** duplicate rows. It then runs the tombstone
pass: items present in the ledger but absent from the *arr are **tombstoned, never deleted**
(sets `deleted_from_arr_at`, writes a `deleted` ledger event with `payload.kind = 'item_removed'`).

The tombstone pass sits behind the **mass-tombstone guard** (`@hnet/domain`
`tombstoneMissingItems`, `SYNC_TOMBSTONE_GUARD_PCT = 20`, `SYNC_TOMBSTONE_GUARD_MIN_ROWS = 10`):
if the missing set is **> 20% of live rows AND > 10 rows**, it throws
`MassTombstoneAbortedError` and writes **nothing** — a wiped/fresh *arr looks exactly like a
mass deletion, and blindly tombstoning would corrupt the ledger Restore depends on (R-50). The
orchestrator records that source's run as `aborted`.

**Incremental** (`arr-incremental.ts`) polls *arr history. With a stored cursor it calls
`GET /history/since?date=<cursor>`; a cursor-less first run walks the paged `GET /history`
feed newest-first, bounded to `MAX_HISTORY_PAGES` (100) so a deep history can't wedge the job.
Records are normalized per the D-07 map (`normalize.ts`) — unmapped raw eventTypes produce no
event. `ingestLedgerEvents` inserts the events **and advances `sync_state.history_cursor` in
the same transaction**; a failure before that commit leaves the cursor untouched, and the
`(source, source_event_id)` dedupe index makes the inevitable re-fetch overlap a no-op. The
cursor advances to the max source timestamp over **everything fetched** (dropped types
included) so dropped records aren't re-fetched forever.

**Seerr** (`seerr.ts`) is cursor-driven in both modes (it has no item list). It walks
`GET /request?sort=added` newest-first until the cursor, matches each request to a
`media_items` row (movie → radarr by tmdb; tv → sonarr by tvdb, fallback tmdb) and the
requester to an app user by **case-insensitive email only** (Q-01 — `plexUsername` is recorded
as a payload suggestion, never auto-linked), and ingests `requested` events. Requests that
precede the *arr add land with `media_item_id NULL` and are re-linked later by the backfill
post-step.

**Post-steps** run once per `runSync`, after all sources, and are idempotent:

- `backfillEventAttribution` — re-links Seerr events whose item/user has since appeared.
- `completeFixRequests` — closes fix requests whose replacement import was just ingested
  (ADR-007 C-06).

**Failure isolation (D-14).** Each source is bracketed in its own `sync_runs` row and its
failure is caught, recorded (`failed`, or `aborted` for the guard), logged, and the run
continues to the next source — one *arr being down never masks the sources that synced. The
CLI exits `1` only when **every** requested source failed/aborted (`totalFailure`), `2` on a
usage/config error, `0` otherwise (with a per-source report in the final log line).

## Production

Two CronJobs are already live (defined in the sibling `haynes-ops` repo,
`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`), both running
`tsx /sync/src/scripts/sync.ts` from the `/sync` subtree of the single GHCR image,
`concurrencyPolicy: Forbid`, `backoffLimit: 1`, sharing the app's ExternalSecret-fed env:

- `sync-incremental` — schedule `*/15 * * * *`, `--mode=incremental`.
- `sync-full` — schedule `30 4 * * *` (04:30), `--mode=full`.

**On-call: recovering from a mass-tombstone abort.** When a full run logs
`sync run aborted (mass-tombstone guard)` and `sync_runs` shows `aborted`, the *arr looked
like it had lost >20% of its catalog. **First confirm the *arr is genuinely healthy** (its
library really shrank — not a restore-in-progress, wiped config, or unmounted storage). Only
then run a one-off forced pass so the tombstones (and their `deleted` events) are written:

```
tsx /sync/src/scripts/sync.ts --mode=full --source=<sonarr|radarr|lidarr> --force-tombstones
```

There is no admin UI for this yet — it is a manual `kubectl` one-off (e.g. a `kubectl create
job --from=cronjob/...` with the args overridden, or an exec in a debug pod). Scope it to the
affected `--source` so a healthy *arr isn't force-tombstoned alongside it.

## Tests

`packages/sync/__tests__/` (Vitest, embedded PG16 via `@hnet/test-utils` — Postgres only, no
Docker): `full-sync.test.ts` (upsert + tombstone guard), `incremental-sync.test.ts` (cursor +
dedupe + bootstrap bound), `seerr-sync.test.ts` (attribution + backfill), `normalize.test.ts`
(the D-07 map). Run with `pnpm --filter @hnet/sync test`.
