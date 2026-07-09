# ADR-025: Trash curation pipeline — batches, human-curation gate, Leaving Soon, windowed deletion

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner) · authored AND ratified by Fable 5 (autonomous run, PLAN-012
  KICKOFF mandate + the 2026-07-07 rulings resolving the plan's open decisions)

## Context and problem statement

PLAN-012 turns the read-through Trash section (ADR-023 / DESIGN-010) into a **curation pipeline**.
The owner's vision (2026-07-06): space is what matters (keep HaynesTower below a target), but rules
are imperfect, so deletion is gated by **human curation** with a phone-first visual flow — rules
propose, an admin reviews a poster wall (each poster carries an X→lock toggle), green-lighting
publishes a Plex **"Leaving Soon"** collection where role-gated users run the same rescue exercise
within a configurable window, and window expiry deletes the survivors server-side, one item at a
time, with every ADR-023 safety layer still applying. Batches run on a cadence; eventually an
audited setting can SKIP the admin gate once the filters are trusted. This plan must also RECORD the
data PLAN-013 (reclaim metrics) and PLAN-014 (rule tuning) need — deletion snapshots + save events.

This ADR records the binding decisions and resolves the plan's open questions (Q-01..Q-10).

## Decision drivers

1. **The admin gate is a hard precondition** — a batch never deletes without a human green-light,
   unless a single audited skip-gate setting is on (the owner's load-bearing safety instruction).
2. **Reuse ADR-023's safety machine, don't re-implement** — deletion is the existing per-item
   guarded loop (live exclusions + the watch/requester/tag/unevaluable guardian + the SAFE preflight
   audit), never Maintainerr's unscopeable estate-wide handler (reaffirms C-07a).
3. **Maintainerr is still the deletion system of record** (CLAUDE.md hard rule 4); the Leaving-Soon
   collection is driven THROUGH Maintainerr, not a parallel Plex integration.
4. **Save-data is a first-class durable record** — the rules-tuning input (PLAN-014), not incidental
   UI state.
5. Consistency with the existing entitlement + write-confinement discipline (const-array enums,
   single-writer + same-tx audit, session-carried gating, import-confined mutating clients).

## Decision

- **C-01 — The batch state machine + its invariants.** A **batch** (`trash_batches`) is the deletion
  unit: a frozen snapshot of the current pending set for ONE media kind (`movie`|`tv`; never mixed;
  music never batchable — R-87). States `draft → admin_review → leaving_soon → deleted | cancelled`
  (`TRASH_BATCH_STATES`, CHECK). **Invariant:** only `leaving_soon` expires, and it is reached ONLY
  by `greenlightBatch` OR the audited skip-gate path — so a batch never deletes without the gate.
  Every transition is a guarded `UPDATE … WHERE state = <from>` (a concurrent transition loses the
  race → `TrashBatchStateError`) with a `trash_batch_transition` ledger event same-tx. **At most one
  OPEN (draft/admin_review/leaving_soon) batch per media kind** — enforced by a partial unique index.

- **C-02 — Manual batch creation v1 (Q-01).** `createBatchFromPending(mediaKind)` snapshots the live
  pending set (via `listTrashPending`) into a new batch's `trash_batch_items` (title/ids/size/poster
  frozen). Admin action; scheduled/cadence creation is future (the `draft` state + `promoteToLeavingSoon`
  factoring leave room for it). Items with no Maintainerr id are unactionable and dropped; a
  tag-protected (`dnd`) item is snapshotted `protected` (never a delete candidate). No pending items ⇒
  `TrashBatchEmptyError`.

- **C-03 — A Save is PERMANENT protection + a tuning record (Q-03, Q-07).** `setBatchItemSaved` is the
  ONE writer for both exercises: a save establishes the Maintainerr GLOBAL exclusion FIRST (external,
  protective ordering — reusing `saveExclusion`), pulls the item out of the Leaving-Soon collection,
  flips the item to `saved`, and appends a `trash_batch_saves` row (the dedicated tuning dataset) +
  the `trash_excluded` ledger event. No re-eligibility v1 (the exclusion persists). Un-save reverses
  all three (records `unsave`). Idempotent. Phase-gated: `admin_review` ⇒ admin (`manage_batches`);
  `leaving_soon` ⇒ the `save_leaving_soon` grant AND the window open.

- **C-04 — Leaving Soon = a manual Maintainerr collection (Q-05, Q-09).** Verified from the
  Maintainerr **v3.17.0** source (`apps/server/src/modules/collections/collections.controller.ts` +
  `collections.service.ts`): `POST /api/collections` creates a standalone collection seeded with
  specific Plex items (`{ collection, media: [{ mediaServerId }] }`); `visibleOnHome` +
  `visibleOnRecommended` are pushed to Plex (`updateCollectionVisibility`) so it surfaces on Plex Home
  + Recommended; `deleteAfterDays: null` so Maintainerr NEVER ages/auto-deletes it (our sweep owns
  deletion — reaffirms C-07a). `greenlightBatch` creates a **rolling per-kind** collection ("Leaving
  Soon — Movies" / "— TV", Q-09), stores its id on `trash_batches.maintainerr_collection_id`, and adds
  `/collections/add` (un-save) / `/collections/remove` (save) / `/collections/removeCollection`
  (cancel). The collection write is external-first (ADR-023 C-05: a crash must not leave a green-lit
  batch whose collection was never created). The confined write methods live in `@hnet/arr/write`.

  > **Correction (2026-07-07, pre-ship adversarial review) — the create contract above was wrong on
  > three points; re-verified against the v3.17.0 source (`collections.controller.ts`
  > `collectionBaseShape`, `collection-worker.service.ts`, `@maintainerr/contracts`):**
  > 1. `type` is `z.enum(MediaItemTypes)` — the STRING `'movie'`/`'show'`, NOT a numeric `1|2` (a
  >    number is rejected 400).
  > 2. **`deleteAfterDays: null` does NOT disable aging.** The field is `z.coerce.number().int()`, so
  >    `null` coerces to `0` (`Number(null)`) — every member is instantly past its danger date. We omit
  >    it entirely.
  > 3. The collection is created with **`arrAction: 4` (`ServarrAction.DO_NOTHING`)** — the aging
  >    worker's ONLY per-collection skip (`if (arrAction === ServarrAction.DO_NOTHING) return false`).
  >    This, not `deleteAfterDays`, is what keeps Maintainerr's estate-wide worker from deleting the
  >    whole Leaving-Soon collection; the windowed sweep owns deletion (reaffirms C-07a). Had the batch
  >    shipped with `arrAction: 0` + `deleteAfterDays: null`, green-light would have handed Maintainerr
  >    a collection it deletes wholesale on the next worker run — the safety claim inverts.
  >
  > Also: `POST /api/collections` returns **no body** (void, HTTP 201), so the id is re-read via
  > `GET /api/collections` by exact title (idempotent — reuse if present). And
  > `fetchMaintainerrPending` now skips collections titled like our Leaving-Soon collections so they
  > never re-enter the pending set (v3.17.0 GET /collections returns manual collections too).

- **C-05 — Windowed deletion = the `trash-batch-sweep` sync mode (Q-02).** `sweepExpiredBatches` acts
  ONLY on `leaving_soon` batches whose `expires_at` has passed. It re-runs the SAFE preflight audit
  once up front (fail closed — the whole sweep refuses on an unsafe install) and then, per batch, the
  existing per-item guarded loop over FRESH pending data: LIVE Maintainerr exclusions + the guardian
  (`dnd`/recently-watched/requester/unevaluable) re-run at sweep time; each cold survivor deletes via
  `POST /api/collections/media/handle` (never `/collections/handle`), with the `trash_expedited`
  intent event + `deleted` state + deletion snapshot committed same-tx BEFORE the per-item handle;
  guardian-kept / stale / live-excluded items land `skipped`; the batch closes `deleted` with per-item
  counts. It runs as a scheduled `@hnet/sync` mode (`SYNC_RUN_KINDS += 'trash-batch-sweep'`; hourly
  CronJob at deploy) and the admin "Expire now" trigger (`trash.batches.expire`) calls the same
  orchestrator for one batch. The sweep's audit trail is the ledger + batch rows (never a `sync_runs`
  row — it touches no *arr source, exactly like expedite).

  > **Errata (2026-07-08, owner-directed) — the manual "Expire now" gains an AUDITED admin override.**
  > The owner found the save window too tight and asked for a way to *"force the batch to be deleted and
  > allow a new batch to be created"* early. `sweepExpiredBatches` gains a `forceOverride` flag honored
  > **only** on the manual `batchId` path (`trash.batches.expire`, still `manage_batches`-gated — a
  > member without the grant can never force). It bypasses **only** the `expires_at <= now` gate for a
  > `leaving_soon` batch; **every other safety layer of this C-05 is unchanged** (the per-item guarded
  > loop, the guardian keeps, LIVE exclusions, saved items untouched, the F3 breaker, the Q-08 deletion
  > snapshots, the swept push). The override is **audited**: the batch-close `trash_batch_transition`
  > event and the `batch_swept` push carry `forcedEarly: true` + `forcedBy: <actorId>` (true only when
  > the window was genuinely still open). A forced sweep closes the batch terminal, freeing the kind's
  > one-open slot. UI: DESIGN-011 D-09a (DANGER Modal + typed confirmation). Also 2026-07-08:
  > `createBatchFromPending` gains optional reclaim targeting (DESIGN-011 D-09b) — an additive param,
  > default-all, no change to this ADR's snapshot semantics.

  > **Errata (2026-07-09, owner-directed, build B) — requested items start saved, and the sweep guardian
  > honors an explicit human un-save override.** Requester-carrying items must never be inert protected
  > shields. `createBatchFromPending` now snapshots a non-tag-protected requester item **`saved`** with
  > `saved_reason='requested'`, `saved_by=NULL`, and **no Maintainerr exclusion** (the guardian is the real
  > keep — auto-creating exclusions would mass-mutate Maintainerr; migration 0026 adds `saved_reason` +
  > `requested_override`). Such a system save is **un-savable by any holder of save rights for the phase**
  > (the D-05 ownership gate governs human rescues only). Un-saving one sets the sticky `requested_override`
  > flag (audited: a `trash_excluded` event flagged `overrodeRequested:true`). At sweep, `classifyGuardian`
  > still keeps a requester item **unless** `requested_override` is set — the override defeats **only** the
  > requester keep (dnd/watched/unevaluable keeps are unchanged): **requested + never-unsaved → kept;
  > requested + explicitly-unsaved → deleted.** UI + wall glyphs: DESIGN-011 D-11.

- **C-06 — Settings live in a generic `app_settings` store (Q-06).** A small audited key→jsonb table
  (`key` CHECK from `APP_SETTING_KEYS`, `value`, `updated_at`, `updated_by`) written ONLY by the
  `setAppSetting` single-writer, which co-writes an `update_app_setting` permission_audit row same-tx
  (a new CHECK value). Absent key ⇒ the documented default (fail-safe). Keys now:
  `trash_skip_admin_gate` (bool, default false), `trash_default_window_days` (int, default 21, Q-10).
  Generic + reusable — PLAN-010 (MOTD) and PLAN-013/014 (space target, tuning knobs) add keys here.

- **C-07 — The skip-gate is an audited escape hatch (Q-05 gate).** When `trash_skip_admin_gate` is on,
  `createBatchFromPending` auto-green-lights straight `draft → leaving_soon` with `gate_skipped = true`
  and system attribution — the audit trail always distinguishes a skipped gate from a human
  green-light. This plan ships the MECHANISM + audit; the DECISION to flip it (graduation criteria) is
  PLAN-014.

  > **Correction (2026-07-07, pre-ship review):** the skip-gate promotion is attributed to the
  > **creating admin** (`greenlit_by = actorId`, the batch's `created_by`), NOT a null/"system" actor —
  > the promotion transition and `trash_batch_transition` event both carry that admin id alongside
  > `gate_skipped = true`. The audit still distinguishes a skipped gate from a manual green-light (the
  > `gate_skipped` flag), but the actor is the admin who triggered the create, not "system".

- **C-08 — Deletion snapshots + roles (Q-08, Q-04).** On sweep-delete, `{ size, resolution, imdb/tmdb
  rating }` are frozen into `trash_batch_items.deleted_*` in the same tx as the item's `deleted` state
  (title/ids ride the creation snapshot; media kind = the batch) — the durable metrics source
  PLAN-013 reads. `TRASH_ACTIONS` grows two grants (`role_trash_action_grants`, migration 0017 CHECK
  rebuild): `save_leaving_soon` (the windowed user rescue) and `manage_batches` (the admin batch
  lifecycle). **Neither is seeded** (Q-04) — admins grant them per role via the existing
  `/admin/roles` grid; Admin implies both.

## Consequences

- **Positive:** the human gate is a structural invariant, not a convention; deletion reuses the whole
  ADR-023 safety machine unchanged; the Leaving-Soon collection is real Plex UX driven through the
  system of record; save-events + deletion-snapshots give PLAN-013/014 real rows to consume; the
  `app_settings` store is a reusable primitive; the sweep is a plain scheduled job re-checking every
  precondition, so a rollback mid-window leaves a `leaving_soon` batch inert.
- **Negative / trade-offs:** manual creation v1 (no cadence automation yet); the Leaving-Soon
  collection endpoints are verified from source but validated live only non-destructively (the exact
  `POST /api/collections` response id extraction is a permissive parse); a lost-response per-item
  handle is treated intent-first (item marked `deleted`, Maintainerr reconciles) — the same trade-off
  as expedite; the sweep records no `sync_runs` row (accepted — the ledger is richer).
- **Follow-ups:** the poster-wall UX (Fable follow-up); cadence/scheduled creation, space-target
  policy + skip-gate graduation (PLAN-014); reclaim metrics surface (PLAN-013).

## Open questions resolved

| Q | Decision |
|---|----------|
| Q-01 Cadence/overlap | Manual "Create batch" v1; one OPEN batch per kind (partial unique index). Scheduled creation future. |
| Q-02 Expiry trigger | Scheduled `trash-batch-sweep` sync mode (hourly CronJob) + admin "Expire now"; both call `sweepExpiredBatches`. |
| Q-03 Saved items | Permanent Maintainerr exclusion + `saved` state (leaves the batch) + `trash_batch_saves` row; no re-eligibility v1. |
| Q-04 Role seeding | `save_leaving_soon` + `manage_batches` are new grants, NOT seeded; admins grant per role. |
| Q-05 Leaving Soon | Manual Maintainerr collection (`POST /api/collections`, verified v3.17.0) with `visibleOnHome`/`visibleOnRecommended` and **`arrAction: 4` (DO_NOTHING)** to disable aging (see C-04 Correction 2026-07-07 — `deleteAfterDays: null` does NOT, it coerces to `0`). |
| Q-06 Settings store | New generic `app_settings` key/value table + audited `setAppSetting`. |
| Q-07 Save events | Dedicated `trash_batch_saves` table (tuning dataset) + the `trash_excluded` ledger event. |
| Q-08 Snapshots | `trash_batch_items.deleted_*` (size/resolution/ratings) frozen at sweep-delete, same tx. |
| Q-09 Naming | Rolling "Leaving Soon — Movies" / "— TV" per media kind. |
| Q-10 Window | `window_days` per batch, default 21 (`trash_default_window_days`), set at green-light. |

## References

- Extends ADR-023 (Trash/Maintainerr — C-03 action grants, C-04 SAFE gate, C-05 write ordering,
  C-07/C-07a/C-07b guardian + per-item expedite) and DESIGN-010 (D-02 REST mapping, D-05 guardian,
  D-08 wire contracts). Relates ADR-021 (section levels), ADR-014/015 (confirm + no-reorient),
  ADR-019 (poster proxy), ADR-008/011 (write confinement). Implemented by DESIGN-011. Migration 0017.
