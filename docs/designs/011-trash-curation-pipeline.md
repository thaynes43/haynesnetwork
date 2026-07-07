# DESIGN-011: Trash curation pipeline — state machine, Leaving Soon, sweep, and wire contracts

- **Status:** Accepted
- **Date:** 2026-07-07
- **Author:** Fable 5 (autonomous run, PLAN-012)
- **Implements:** ADR-025 (curation pipeline). Extends DESIGN-010 (Trash/Maintainerr — D-02 REST
  mapping, D-05 guardian, D-08 wire contracts). Relates ADR-014/015 (confirm + no-reorient),
  ADR-019 (poster proxy).

This design is the contract the **Trash curation UX** (a Fable follow-up) wires against. The backend
vertical (schema, domain, API, sweep) ships here; the poster-wall page + admin settings surface land
as a follow-up UX change on the same branch.

---

## D-01 — The batch state machine (ADR-025 C-01)

```mermaid
stateDiagram-v2
    [*] --> admin_review : createBatchFromPending (gate ON)
    [*] --> draft : createBatchFromPending (skip-gate ON)
    draft --> leaving_soon : skip-gate auto-promote (gate_skipped=true, system)
    admin_review --> leaving_soon : greenlightBatch (sets window + Leaving Soon collection)
    admin_review --> cancelled : cancelBatch
    draft --> cancelled : cancelBatch
    leaving_soon --> cancelled : cancelBatch (releases collection)
    leaving_soon --> deleted : sweepExpiredBatches (window expired)
    deleted --> [*]
    cancelled --> [*]
```

**Invariants.** Only `leaving_soon` expires; it is reached ONLY by `greenlightBatch` OR the audited
skip-gate path. Every transition is a guarded `UPDATE … WHERE state = <from>` (a lost race →
`TrashBatchStateError`/CONFLICT) with a `trash_batch_transition` ledger event in the SAME tx. At most
one OPEN (`draft|admin_review|leaving_soon`) batch per media kind (partial unique index).

### Transition table

| From → To | Trigger (domain) | Actor gate | Audit written (same-tx) | External Maintainerr write (protective-first) |
|---|---|---|---|---|
| — → `admin_review` | `createBatchFromPending` (gate on) | `manage_batches` | `trash_batch_transition` `{to:'admin_review',itemCount}` | none |
| — → `draft` → `leaving_soon` | `createBatchFromPending` (skip-gate on) | `manage_batches` (system-attributed promote) | two events; second `{gateSkipped:true}` | create Leaving Soon collection |
| `admin_review` → `leaving_soon` | `greenlightBatch` | `manage_batches` | `trash_batch_transition` `{windowDays,expiresAt,collectionId}` | create Leaving Soon collection |
| open → `cancelled` | `cancelBatch` | `manage_batches` | `trash_batch_transition` `{to:'cancelled'}` | `removeCollection` (if any) |
| `leaving_soon` → `deleted` | `sweepExpiredBatches` | system / `manage_batches` (Expire now) | per-item `trash_expedited` + batch `trash_batch_transition` `{counts}` | per-item `collections/media/handle` |
| item `pending` ⇄ `saved` | `setBatchItemSaved` | `admin_review`⇒`manage_batches`; `leaving_soon`⇒`save_leaving_soon` | `trash_batch_saves` + `trash_excluded` | `addExclusion`/`removeExclusion` + collection `remove`/`add` |

---

## D-02 — Data model (migration 0017)

- **`trash_batches`** — `id`, `media_kind` (`movie|tv` CHECK), `state` (CHECK), `window_days`,
  `gate_skipped`, `greenlit_at`/`by`, `expires_at`, `maintainerr_collection_id`, `created_at`/`by`,
  `cancelled_at`, `deleted_at`. Partial unique index `one_open_per_kind`.
- **`trash_batch_items`** — `id`, `batch_id` (FK cascade), `maintainerr_media_id`, `collection_id`,
  `media_item_id` (nullable FK), snapshots `title/year/tmdb_id/tvdb_id/size_bytes/poster_source`,
  `state` (`pending|saved|deleted|skipped|protected` CHECK), `saved_by`/`saved_at`, `deleted_at`, +
  **deletion snapshot** `deleted_size_bytes/deleted_resolution/deleted_imdb_rating/deleted_tmdb_rating`
  (D-06). Unique `(batch_id, maintainerr_media_id)`.
- **`trash_batch_saves`** — `id`, `batch_item_id` (FK cascade), `user_id`, `action` (`save|unsave`
  CHECK), `created_at`. The tuning dataset (Q-07).
- **`app_settings`** — `key` PK (CHECK from `APP_SETTING_KEYS`), `value` jsonb, `updated_at`,
  `updated_by`. All four tables are on the `no-direct-state-writes` guard list.

---

## D-03 — Leaving Soon collection mechanics (ADR-025 C-04; Q-05 verified from source)

Re-verified against Maintainerr **v3.17.0** on **2026-07-07** (`Maintainerr/Maintainerr@v3.17.0`,
`apps/server/src/modules/collections/collections.controller.ts` — `createCollectionBodySchema` /
`collectionBaseShape`; `collection-worker.service.ts`; `@maintainerr/contracts`
`collections/servarr-action.ts` + `media-server/enums.ts`). The confined write methods live in
`@hnet/arr/write` (`MaintainerrWriteClient`). **The pre-2026-07-07 row was wrong on three points**
(numeric `type`, `arrAction:0`, `deleteAfterDays:null` — all corrected below); it never worked
against a live v3.17.0.

| Purpose | Method (base `/api`) | Body | Notes |
|---|---|---|---|
| Create Leaving Soon | `POST /collections` | `{ collection: { title, libraryId, type:'movie'\|'show', isActive:true, arrAction:4, manualCollection:false, visibleOnHome:true, visibleOnRecommended:true }, media:[{mediaServerId}] }` | **Returns NO body (void, HTTP 201)** — re-read the new id via `GET /collections` matching the exact `title` (idempotent: reuse if one already exists). `type` is `z.enum(MediaItemTypes)` — the STRING `'movie'`/`'show'` (a numeric code is **rejected 400**). `arrAction:4` = `ServarrAction.DO_NOTHING` — the collection worker's **ONLY** per-collection skip; any other value ages the collection. `visibleOn*` pushed to Plex Home+Recommended by `updateCollectionVisibility`. |
| Add rescued-back items | `POST /collections/add` | `{ collectionId, media:[{mediaServerId}], manual:true }` | un-save re-adds |
| Remove rescued items | `POST /collections/remove` | `{ collectionId, media:[{mediaServerId}] }` | save pulls out |
| Tear down | `POST /collections/removeCollection` | `{ collectionId }` | cancel |

`libraryId` is derived at green-light from the batch items' source rule collection (via
`GET /collections`). `type` = `'movie'` (movie) / `'show'` (tv). **We do NOT send `deleteAfterDays`:
it is `z.coerce.number().int().optional()`, so `null` coerces to `0` (`Number(null)`) — every member
would be instantly past its danger date, and with any `arrAction` other than DO_NOTHING the
estate-wide worker would delete the WHOLE collection on its next run. `arrAction:4` is the only lever
that stops aging.** The write is external-first (ADR-023 C-05); the pending derivation
(`fetchMaintainerrPending`) skips collections whose title is a Leaving-Soon name so our own manual
collections never re-enter the pending set nor mis-target the sweep's per-item handle.

---

## D-04 — The expiry sweep sequence (ADR-025 C-05)

```mermaid
sequenceDiagram
    participant Cron as CronJob (trash-batch-sweep)
    participant Dom as sweepExpiredBatches
    participant M as Maintainerr
    participant DB as Postgres
    Cron->>Dom: run (system actor)
    Dom->>M: auditMaintainerr (SAFE?)
    alt not SAFE
        Dom-->>Cron: throw MaintainerrUnsafeError (whole sweep refused)
    else SAFE
        Dom->>DB: find leaving_soon batches, expires_at <= now
        loop each expired batch
            Dom->>M: listTrashPending (FRESH) + getExclusions (LIVE)
            loop each still-pending item
                alt gone / live-excluded / guardian-keeps
                    Dom->>DB: item → skipped
                else cold + resolved (survivor)
                    Dom->>DB: tx { trash_expedited event + item deleted + snapshot }
                    Dom->>M: POST collections/media/handle (per item)
                end
            end
            Dom->>DB: tx { batch → deleted + trash_batch_transition counts }
        end
    end
```

Intent-first: the event + terminal state + snapshot commit BEFORE the per-item handle; a failed
handle is tolerated per-item (intent durable, Maintainerr reconciles) and never aborts the batch.

---

## D-05 — Wire contracts (tRPC `trash.batches.*` + `trash.settings.*`)

The UX agent wires against these. All compose the ADR-023 gates; errors ride `mapDomainErrors`
(`TRASH_BATCH_STATE`/`TRASH_BATCH_ALREADY_OPEN` → CONFLICT; `TRASH_BATCH_EMPTY` →
UNPROCESSABLE_CONTENT; `MAINTAINERR_UNSAFE` → PRECONDITION_FAILED).

```ts
// ---- reads (section read_only) ----
trash.batches.list        // in: { mediaKind?: 'movie'|'tv' } | undefined
// out: BatchSummary[]  — { id, mediaKind, state, windowDays, gateSkipped, greenlitAt, expiresAt,
//                          createdAt, deletedAt, cancelledAt,
//                          counts: { pending, saved, deleted, skipped, protected, total },
//                          reclaimedBytes }   (timestamps ISO strings)

trash.batches.get         // in: { batchId: uuid }
// out: BatchSummary & { items: BatchDetailItem[] }
//   BatchDetailItem = { id, maintainerrMediaId, mediaItemId, collectionId, title, year, tmdbId,
//                       tvdbId, sizeBytes, posterSource, state, savedBy, savedAt, posterUrl }
//   posterUrl: the ADR-019 authed proxy url (null when unresolved) — the poster-wall tile source.

trash.batches.saveStats   // in: { batchId: uuid }
// out: { batchId, totalSaves, totalUnsaves, netSaved,
//        byUser: [{ userId, displayName, saves, unsaves }] }

// ---- lifecycle (trashActionProcedure('manage_batches') — admin ⇒ ok) ----
trash.batches.create      // in: { mediaKind: 'movie'|'tv' }
// out: { batchId, state, mediaKind, itemCount, gateSkipped, expiresAt }

trash.batches.greenlight  // in: { batchId: uuid, windowDays?: 1..365 }
// out: { state:'leaving_soon', expiresAt, windowDays, collectionId }

trash.batches.cancel      // in: { batchId: uuid }               -> { state:'cancelled' }
trash.batches.expire      // in: { batchId: uuid }  (manual "Expire now")
// out: SweepReport = { batchesSwept, batches: [{ batchId, mediaKind, deletedCount, skippedCount,
//                       savedCount, protectedCount, handleErrors,
//                       raceSkipped,   // F2: items Saved mid-sweep (guarded write lost the race)
//                       aborted }] }   // F3: circuit breaker tripped ⇒ batch left leaving_soon to resume

// ---- per-item save (PHASE-dependent gate: read_only + action check in-resolver) ----
trash.batches.setItemSaved // in: { batchId: uuid, itemId: uuid, saved: boolean }
// gate: admin_review ⇒ manage_batches; leaving_soon ⇒ save_leaving_soon (else FORBIDDEN)
// out: { changed: boolean, state: TrashBatchItemState }
//   On an ACTIVE flip: changed:true, state 'saved' (save) | 'pending' (un-save). On an INERT flip
//   (redundant save, or the item is already 'protected'/'skipped'/'deleted'): changed:false and
//   state is the item's ACTUAL current state — so callers must accept the full item-state union.

// ---- settings (adminProcedure) ----
trash.settings.get         // -> { trash_skip_admin_gate: boolean, trash_default_window_days: number }
trash.settings.set         // in: { trashSkipAdminGate?: boolean, trashDefaultWindowDays?: 1..365 }
//                            -> the updated settings map
```

---

## D-06 — Deletion snapshot schema (Q-08)

Written same-tx as `state='deleted'` at sweep time (PLAN-013's metrics source):
`deleted_size_bytes` (bigint), `deleted_resolution` (media_metadata tier), `deleted_imdb_rating`,
`deleted_tmdb_rating` (numeric). Title/tmdb/tvdb ride the creation snapshot; media type = the batch's
`media_kind`. `listBatches`/`getBatchDetail` expose `reclaimedBytes = Σ deleted_size_bytes`.

---

## D-07 — Poster-wall UX guidance (for the Fable follow-up; ADR-014/015)

- **Poster wall** — a responsive portrait-poster grid (`posterUrl` via the ADR-019 proxy) that
  scrolls one-handed. Each tile: poster, title/year/size caption, and a **state overlay** — **X**
  (`pending`, will be deleted) or **lock** (`saved`). `protected`/`skipped`/`deleted` render distinctly
  (already-safe / kept / gone). **Tap toggles X ⇄ lock in place** (`setItemSaved`) — the overlay swaps
  glyph + deepens color; the tile NEVER moves/reflows (hard rule 9 — reserved corner/scrim). No
  per-tap confirm (a save is protective + reversible).
- **Running counts header** — sticky, fixed-height: `N deleting · M saved · X GB reclaimed` from
  `counts` — numbers change in place, no layout shift.
- **Batch actions** — **Green-light** is explanatory/multi-consequence ⇒ a **Modal** (window length,
  the rolling collection name, what publishes to Plex). **Cancel** ⇒ `ConfirmButton` two-step.
  **Expire now** (admin) ⇒ Modal surfacing the deleted/skipped/protected report from `SweepReport`.
- **User (Leaving Soon) view** — the SAME wall scoped by `save_leaving_soon`: countdown to
  `expiresAt`, X→lock only; no lifecycle buttons; calm read-only when expired.
- **Admin settings** — skip-gate toggle + default window on the Trash admin area (`trash.settings.*`);
  flips are `update_app_setting`-audited.
- In-theme glyphs per DESIGN-006 (no borrowed look); screenshot the wall for owner approval before
  ship (owner memory: visual identity sign-off).

---

## D-08 — Ops (env + CronJob)

- **No new secrets.** The sweep drives Maintainerr with the existing `MAINTAINERR_URL` /
  `MAINTAINERR_API_KEY` (shipped with PLAN-006). The write client is built inside `@hnet/domain`
  (`maintainerrClientBundleFromEnv`) so `@hnet/arr/write` stays import-confined (ADR-008).
- **CronJob (haynes-ops, next to the sync jobs):** `tsx sync.ts --mode=trash-batch-sweep` — **hourly**
  at deploy. No `--source` (it drives Maintainerr, not an *arr). Needs `DATABASE_URL` +
  `MAINTAINERR_URL`/`MAINTAINERR_API_KEY`. Exit 1 (retry) when the sweep refuses on an unsafe install.
  Manual-first: the job can ship disabled and be enabled once the first cycle is validated.
- The sweep writes NO `sync_runs` row — its audit trail is `trash_batch_transition` + `trash_expedited`
  ledger events + the batch columns (richer than a sync row; consistent with expedite).

### Deploy-time checklist

1. Migration 0017 runs (migrator initContainer) — four tables + five CHECK rebuilds.
2. Add the hourly `trash-batch-sweep` CronJob manifest under
   `kubernetes/main/apps/frontend/haynesnetwork/` (mirror the existing sync CronJobs; add the
   Maintainerr env from the existing External Secret).
3. Grant `save_leaving_soon` / `manage_batches` to the intended roles via `/admin/roles` (not seeded).
4. Optionally set `trash_default_window_days` via `trash.settings.set`; leave `trash_skip_admin_gate`
   OFF until PLAN-014's graduation criteria.
