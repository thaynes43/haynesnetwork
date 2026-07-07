# PLAN-012: Trash curation pipeline — batches, poster review, Leaving Soon, windowed deletion

- **Status:** Draft <!-- Fable 5 flips Draft → Executing → Completed -->
- **Satisfies:** PRD-001 new **R-NN** block (indicative **R-88..R-96** — curation batches,
  admin poster review, Leaving Soon, user save window, expiry deletion, skip-gate, deletion
  snapshots); new **ADR-NN** (indicative **ADR-025** — batch lifecycle + human-curation gate +
  per-item batch deletion + save-data-as-tuning-record); new **DESIGN-NN** (indicative
  **DESIGN-011** — batch state machine, poster-grid UX, wire contracts, Maintainerr/Plex
  collection mechanics). Extends **ADR-023** (Trash/Maintainerr; C-03 action grants, C-04
  safety gate, C-05 write ordering, C-07/C-07a/C-07b guardian + per-item expedite) and
  **DESIGN-010** (D-02 REST mapping, D-05 guardian, D-08 wire contracts). Relates ADR-021
  (section levels), ADR-014/015 (confirm + no-reorient), ADR-019 (poster proxy), ADR-008/011
  (write confinement).
- **Depends on:** **PLAN-006 Completed** — including its 2026-07-06 test-rules addendum: the
  conservative non-deleting rule collections seeded there are this plan's first draft-batch
  input. Reuses 006's `@hnet/arr` Maintainerr client, `trash-flow.ts` guardian/expedite
  primitives, `role_trash_action_grants`, the webhook/Activity store, and the poster proxy.
- **TODO source:** owner vision 2026-07-06 (translated below).

> **ID reconciliation (Fable 5, do first):** all concrete numbers here (ADR-025, DESIGN-011,
> R-88.., migration 0017.., T-75..) are *indicative placeholders* per `.agents/plans/README.md`
> §Cross-plan reconciliation. Ceilings at authoring (2026-07-06): ADR-024 on `main` + ADR-023
> on the pending `feat/trash-section` branch, DESIGN-010, R-87, T-74, migration 0016 (branch).
> Re-grep after 006 merges and take the next free numbers. File:line anchors into
> `packages/domain/src/trash-flow.ts` etc. below are to `feat/trash-section` @ `791efaf`
> (pending merge) — re-anchor after the merge.

---

## Goal — the owner's vision (2026-07-06), translated

**Space is what matters:** keep HaynesTower below a configurable target (e.g. **80%**). But
rules are imperfect and junk snuck onto the server, so deletion is gated by **human curation**
with a phone-first visual flow:

1. **Rules propose** — Maintainerr rules (starting from 006's conservative test rules) produce
   collections of deletion candidates. A **batch** snapshots a proposed set.
2. **Admin reviews** — a poster-grid "proposed deletions" view: scroll on a phone, every poster
   carries an **X overlay**; tapping flips it to a **lock overlay** (saved/rescued). The admin
   perfects the batch. **Every save is data** for tuning the rules (PLAN-014 consumes it).
3. **Admin green-lights** → the batch becomes/joins **"Leaving Soon"**: a matching **Plex
   collection** appears (driven through Maintainerr) and **other users** — role-gated, most
   roles get it, participation heavily configurable per role — run the same save exercise
   within a **configurable time window** (start long, tighten later).
4. **Window expiry deletes the batch** — server-side, one item at a time, every 006 safety
   layer still applying.

Batches run on a **cadence** (e.g. one/week, ~a month from proposal to deletion) so users can
work ahead while save-data accumulates. Eventually hands-off: an audited **admin setting to
SKIP the admin gate** once the filters are trusted (graduation criteria are PLAN-014's).

Out of the vision but NOT this plan (owner: decisions after the core queue): disk-utilization /
reclaim metrics → **PLAN-013**; rules tuning toward the space target → **PLAN-014**. This plan
must, however, **record the data 013/014 need** (deletion snapshots, save events).

---

## Docs-first artifacts to author (same PR as behavior)

- **PRD-001** — new subsection under Trash & retention (next free R-NN block): batches as the
  deletion unit (Must); admin poster review with per-item save (Must); green-light gate — a
  batch never deletes without it unless the audited skip-gate setting is on (Must); Leaving
  Soon Plex collection visible to users (Must); role-gated user save window with configurable
  duration (Must); expiry deletion is per-item and guardian-checked (Must); every save/unsave
  and state transition durably recorded (Must); per-deleted-item size/resolution/category
  snapshots captured at deletion time (Must — PLAN-013 depends on it); batch cadence
  configurable (Should).
- **New ADR (indicative ADR-025), MADR 3.0, author AND ratify.** Decides: the batch state
  machine `draft → admin_review → leaving_soon → deleted | cancelled` and its invariants
  (below); **the admin gate is a hard precondition** with a single audited skip-gate escape;
  save-data is a first-class durable record (the rules-tuning input), not incidental UI state;
  batch deletion is a **server-side per-item loop** over 006's guardian + per-item handle
  (never Maintainerr's estate-wide handler — reaffirms ADR-023 C-07a); deletion snapshots are
  written in the same transaction as the item's deletion event; where the skip-gate/app
  settings live (Q-06).
- **New DESIGN (indicative DESIGN-011)** — D-NN sections for: the state machine + transition
  table (who may trigger what, which audit row each writes); the poster-grid UX (phone-first,
  overlay semantics, ADR-014/015 discipline); the batch/curation wire contracts (extending
  DESIGN-010 D-08); the Maintainerr/Plex collection mechanics chosen under Q-05; the expiry
  job; the snapshot schema.
- **Glossary (next free T-NN):** **Batch**, **Deletion Candidate (batched)**, **Save/Rescue**,
  **Leaving Soon**, **Save Window**, **Green-light**, **Skip-gate**, **Deletion Snapshot**,
  **Cadence**. Update DDD-002 BC-03 (batches are ledger-context state; the gate mutation is
  BC-02-audited like other permission-adjacent settings).

---

## Data model (`packages/db`) — batches become first-class

Migration (indicative **0017**), additive. All new tables join the `no-direct-state-writes`
guard list (every Drizzle + raw-SQL pattern), written only by `@hnet/domain` single-writers.

- **`trash_batches`** — `id`, `media` (`movie|tv` CHECK — batches never mix, mirroring the
  never-combined tabs), `status` (`TRASH_BATCH_STATUSES = ['draft','admin_review',
  'leaving_soon','deleted','cancelled'] as const` in `enums.ts` + CHECK), `created_by`,
  `created_at`, `greenlit_by`/`greenlit_at` (NULL until the gate; **also set, with
  `gate_skipped = true`, when the skip-gate path promotes** — the audit trail must show which),
  `window_days` (the configurable save window, copied from the default at promotion),
  `window_ends_at` (set at promotion), `maintainerr_collection_id` (the Leaving Soon collection
  it drives, per Q-05), `deleted_at`/`cancelled_at`, timestamps.
- **`trash_batch_items`** — `batch_id` FK cascade, `maintainerr_media_id`, `collection_id`,
  `media_item_id` (nullable — but see the guardian invariant: unresolved items can never be
  deleted), snapshot columns frozen at batch creation (`title`, `year`, `tmdb_id`/`tvdb_id`,
  `size_bytes`, `poster_source`), `state` (`TRASH_BATCH_ITEM_STATES = ['proposed','saved',
  'deleted','skipped'] as const` + CHECK), `saved_by`/`saved_at` (the CURRENT save holder),
  `deleted_at`, plus **deletion-snapshot columns written at deletion time**:
  `deleted_size_bytes`, `deleted_resolution` (the PLAN-004 `media_metadata` tier),
  `deleted_quality` (quality format string from the *arr file record — source per Q-08),
  `deleted_category` (`movie|tv`). PK `(batch_id, maintainerr_media_id)`.
- **Save/unsave history — every flip durably recorded (tuning data).** The item row carries
  only the current state; **each save AND unsave appends** a `ledger_events` row
  (`LEDGER_EVENT_TYPES += 'trash_batch_saved', 'trash_batch_unsaved'`, source `'maintainerr'`
  — reusing 006's extended enum, `enums.ts` on the 006 branch) with payload
  `{batchId, maintainerrMediaId, phase: 'admin_review'|'leaving_soon'}` and
  `requested_by_user_id` = the saver. PLAN-014 reads these joined to the item snapshots.
  (Q-07: dedicated `trash_save_events` table instead, if ledger-event querying proves clumsy —
  default is ledger events, no new table.)
- **Batch transitions audited** — every status change appends a `ledger_events` row
  (`LEDGER_EVENT_TYPES += 'trash_batch_transition'`, payload before/after + actor) in the same
  transaction as the status write; the **skip-gate setting flip** writes a `permission_audit`
  row (`PERMISSION_AUDIT_ACTIONS += 'update_trash_settings'`) — settings storage per Q-06.
- **`TRASH_ACTIONS` grows `'save_leaving_soon'`** (`packages/db/src/schema/enums.ts:196` on
  the 006 branch) — the role-gated user-participation action, granted via the existing
  `role_trash_action_grants` (ADR-023 C-03; a row IS the grant). Migration rebuilds the CHECK
  from the const list, the established pattern. Seeding for "most roles get it" per Q-04.

---

## Domain (`packages/domain`) — single-writers + orchestrators (new `trash-batches.ts`)

Mirror the `trash-flow.ts` discipline: guarded mutations in `inTransaction` with their audit/
ledger rows same-tx; external Maintainerr calls follow ADR-023 C-05 ordering; fresh-state
re-derivation before anything destructive.

- **`createBatch({ db, maintainerr, media, actorId })`** — snapshots the current pending set
  (via `listTrashPending`, `trash-flow.ts:285`) into a `draft` batch + items; refuses if an
  open (non-terminal) batch already exists for that media kind (one live batch per kind keeps
  the mental model simple — Q-01 revisits for cadence overlap).
- **`setBatchItemSaved({ batchId, maintainerrMediaId, saved, actorId, phase })`** — the ONE
  writer for both the admin exercise and the user exercise: flips item state
  `proposed ⇄ saved`, sets/clears `saved_by`/`saved_at`, appends the save/unsave ledger event
  — one tx. Phase-checked: admin flips require batch `admin_review` (or `leaving_soon` —
  admins may keep curating), user flips require `leaving_soon` AND the window not expired.
  Idempotent (saving a saved item is a no-op, no event).
- **`greenlightBatch({ batchId, actorId })`** — `admin_review → leaving_soon`: sets
  `greenlit_by/At`, computes `window_ends_at = now + window_days`, drives the **Leaving Soon
  collection** in Maintainerr/Plex (Q-05 mechanics), transition event same-tx. The Maintainerr
  write is protective-ordered (external first, then event — C-05: a crash must not leave a
  green-lit batch whose collection was never created).
- **`promoteDraft({ batchId, actorId })`** — `draft → admin_review` (may collapse into
  createBatch; kept explicit so a scheduled creator can stage drafts — Q-02).
- **`skipGateEnabled(db)` + `setTrashSetting(...)`** — reads/writes the skip-gate (and window/
  cadence defaults) in the app-settings store (Q-06), audited. When enabled,
  `createBatch`→auto-`greenlightBatch` composes with `actorId = null` system attribution and
  `gate_skipped = true` — **the audit trail always distinguishes a skipped gate from a human
  green-light**.
- **`expireBatch({ db, maintainerr, batchId, actorId })`** — the deletion. **This is the
  batch `expediteItems({ items[] })` the 006 review called for:** 006's UX review (2026-07-06)
  found `trash.expediteAll({ media })` (DESIGN-010 D-08) cannot honor a curated/filtered
  subset — it loops the whole pending set. `expireBatch` runs the **same server-side per-item
  loop over an explicit item list** instead:
  - Preconditions (fail closed, every one re-checked fresh): batch is `leaving_soon`;
    `window_ends_at` passed; the gate was given or audited-skipped (**a batch NEVER deletes if
    the admin gate was required and not given** — enforced by the state machine: only
    `leaving_soon` expires, and only `greenlightBatch`/the audited skip path reaches
    `leaving_soon`); `auditMaintainerr` (`trash-flow.ts:88`) returns SAFE (ADR-023 C-04).
  - Per item, in a loop (never `POST /collections/handle` — C-07a): items in state `saved` are
    **untouched** (and Maintainerr-excluded so its own cron can't take them — Q-03 decides
    permanent vs batch-scoped exclusion); each `proposed` item re-runs the guardian
    (`classifyGuardian`, `trash-flow.ts:566`) against FRESH pending data — `dnd` tag, recent
    cross-server watch, requester, unevaluable all still protect (C-07b); survivors delete via
    the intent-event-then-handle discipline (`expediteOneSurvivor` shape, `trash-flow.ts:705`)
    with the **deletion snapshot written in the same tx as the item's `deleted` state +
    `trash_expedited` event**; guardian-kept or failed items land `skipped` (skipped-vs-
    protected semantics preserved and reported, as D-08 requires the UX to surface).
  - Terminal: batch → `deleted` with per-item counts in the transition event payload.
- **`cancelBatch({ batchId, actorId })`** — any non-terminal state → `cancelled` (the abort
  lever; removes/releases the Leaving Soon collection per Q-05).
- **Invariants:** music never batchable (`arrKindForTrashMedia`, `trash-flow.ts:39` — reject at
  the orchestrator); an item with `media_item_id = NULL` (unknown to our ledger) is never
  deleted (C-07b fail-closed carries over — it lands `skipped`); no state skips the machine
  (e.g. `draft` can never reach `deleted`); every transition + save writes its event same-tx.

---

## Client / integration — Maintainerr + Plex collection mechanics

Extend the 006 `@hnet/arr` Maintainerr client (read + confined write) only as Q-05 requires.
**Verify the mechanics against the v3.17.0 source first** (the DESIGN-010 D-02 method — route
decorators + DTOs; no Swagger): candidates for "promote to Leaving Soon = a Plex-visible
collection users can browse":

- (a) **Maintainerr manual collection** — if v3.17.0 supports creating a `manualCollection`
  and adding media to it (endpoints NOT yet in D-02 — derive them), the green-light creates/
  fills one named per Q-09 and Maintainerr's own Plex sync makes it visible.
- (b) **Reuse the rule-produced collection** — flip its Plex-visibility flags; the batch then
  equals collection membership at snapshot time (drift between rule reruns and the frozen
  batch must be handled — items leaving the rule's match set).
- (c) **Drive the Plex collection directly** (Plex API) and keep Maintainerr purely as the
  deletion executor — most control, one more integration surface.

Record the choice + endpoint mapping as new DESIGN-011 D-NN rows (D-02 style). Exclusion
writes for saved items reuse `saveExclusion` (`trash-flow.ts:476`) — protective ordering and
in-band `code:0` fail-closed parsing (ADR-023 C-04a) already handled.

---

## API (`packages/api`) — extend `trashRouter`

All procedures compose the 006 gates (`sectionProcedure('trash', …)` +
`trashActionProcedure`), `mapDomainErrors`, movie|tv only:

- `trash.batches.list / get({ batchId })` — section `read_only`; a `leaving_soon` batch with
  an open window is visible to any role holding `save_leaving_soon` (the user exercise), plus
  read-only browse of past batches (counts, space reclaimed — PLAN-013's first native surface
  if it goes in-app).
- `trash.batches.create / promote / greenlight / cancel` — `adminProcedure` (batch lifecycle
  is admin-only; the skip-gate automates the same path with system attribution).
- `trash.batches.setItemSaved({ batchId, maintainerrMediaId, saved })` — phase-dependent gate:
  `admin_review` ⇒ admin; `leaving_soon` ⇒ `trashActionProcedure('save_leaving_soon')`.
- `trash.batches.expire({ batchId })` — `adminProcedure` for the manual trigger; the scheduled
  path (Q-02) calls the domain orchestrator directly from the job runner.
- `trash.settings.get / set` — `adminProcedure`; skip-gate + window/cadence defaults (Q-06).

---

## UI (`apps/web`) — the poster review (phone-first)

New Trash sub-nav entry **Batches** (alongside Rules · Movies · TV · Recently Deleted ·
Activity), visible per the same section gating.

- **Poster wall** — a responsive poster grid (portrait posters via the ADR-019 authed proxy;
  `posterUrl` already on `TrashPendingItem`, DESIGN-010 D-08) that scrolls one-handed on a
  phone. Each tile: poster, title/year/size caption, and a **state overlay** — **X** (will be
  deleted) or **lock** (saved). **Tap toggles X ⇄ lock in place**: the overlay swaps glyph and
  deepens color; the tile NEVER moves, resizes, or reflows neighbors (ADR-015 / hard rule 9 —
  the overlay occupies a fixed reserved corner/scrim). No per-tap confirm (a save is
  protective and reversible); the destructive moments are batch-level.
- **Running counts header** — sticky, fixed-height: `N deleting · M saved · X GB reclaimed`,
  updating as tiles flip (numbers change in place; no layout shift).
- **Batch-level actions** — **Green-light** is explanatory/multi-consequence → a **Modal**
  (ADR-014: what happens next, the window length, the Plex collection name). **Cancel batch**
  → `ConfirmButton` two-step. Manual **Expire now** (admin, mostly for validation) → Modal
  with the same skipped-vs-protected report surface the expedite endpoints return.
- **User (Leaving Soon) view** — the SAME poster wall, scoped by `save_leaving_soon`: users
  see the countdown (`window_ends_at`) and may flip X → lock (and back on their own saves —
  Q-03 scope); no lifecycle buttons. Empty/expired states are calm and read-only.
- **Admin settings surface** — skip-gate toggle + window/cadence defaults on the Trash admin
  area (or `/admin/roles` neighborhood — decide in DESIGN-011); flips audited.
- Glyph/overlay iconography: in-theme per DESIGN-006 (no borrowed look); screenshot the poster
  wall for owner approval before ship (owner memory: visual identity sign-off).

---

## Ops

- No new secrets (Maintainerr key/webhook secret shipped with 006). If Q-05 lands on (c),
  Plex token reuse comes from the existing plex config — names only, never values.
- **Expiry/cadence job** — if Q-02 chooses scheduling: a `@hnet/sync`-style job (batch-expiry
  sweep; optionally batch-creation on cadence) run by a cluster CronJob in haynes-ops next to
  the sync jobs; it only calls the domain orchestrators (all preconditions re-checked there).
  Manual-first default means this can ship disabled/absent.
- **e2e stub** — extend `apps/web/e2e/support/stub-maintainerr.ts` with whatever Q-05 adds
  (manual-collection endpoints or Plex-visibility flags) so the hermetic suite covers the full
  batch lifecycle including a stubbed expiry deletion.

---

## Open decisions (record as ADR-NN Q-NN)

- **Q-01 — Cadence + overlap:** manual-first "Create batch" button vs a weekly CronJob from
  day one; and whether a new batch may open while the prior one is still in its window
  (owner sketch: weekly batches, ~a month to deletion ⇒ overlap is eventually required —
  default: allow one batch per media kind per state, revisit after the first cycle).
- **Q-02 — Expiry trigger:** scheduled sweep vs admin-manual "Expire now" first. Default:
  manual-first for the first live cycle, then enable the sweep.
- **Q-03 — What happens to saved items:** permanent Maintainerr exclusion (they never
  reappear) vs batch-scoped rescue (re-eligible next batch, so repeated saves become stronger
  tuning signal). Also: may a user un-save only their OWN saves in the user phase, or any?
- **Q-04 — `save_leaving_soon` seeding:** which roles get it by default ("most users") —
  migration-seeded for Default + Family vs admin flips post-deploy. Owner call.
- **Q-05 — Leaving Soon collection mechanics:** Maintainerr manualCollection vs rule-collection
  Plex-visibility vs direct Plex API (see Client). Verify against v3.17.0 source; record the
  endpoint mapping.
- **Q-06 — App-settings storage:** a new `app_settings` key-value table (domain single-writer,
  `permission_audit` on flip) vs columns on an existing admin surface. Default: the small
  dedicated table — first consumer is the skip-gate; 013/014 add the space target and tuning
  knobs to the same store.
- **Q-07 — Save-event store:** `ledger_events` rows (default) vs a dedicated
  `trash_save_events` table for tuning-query ergonomics.
- **Q-08 — `deleted_quality` source:** the *arr file's quality format via the existing clients
  at deletion time vs extending the PLAN-004 harvest to keep quality on `media_metadata`.
- **Q-09 — Plex collection naming:** one rolling "Leaving Soon" collection vs per-batch names
  ("Leaving March 7"); owner preference at screenshot time.
- **Q-10 — Window defaults:** starting `window_days` (owner: start long — e.g. 21) and the
  floor when tightening later.

---

## Verification

### Unit / integration (Vitest, embedded PG16)
- State machine: every legal transition writes its event same-tx; every illegal one throws
  (`draft`→`deleted` impossible; expire refuses on un-greenlit, unexpired, or gate-required-
  not-given batches; skip-gate path records `gate_skipped` + system attribution).
- `setBatchItemSaved`: phase gating, idempotency, save/unsave events with correct
  actor/phase; window-expired user flips refused.
- `expireBatch`: saved items untouched; guardian-kept items land `skipped` (never deleted);
  survivors get intent-event-before-handle + same-tx snapshots (size/resolution/quality/
  category populated); unresolved (`media_item_id NULL`) items always `skipped`; NOT-SAFE
  audit ⇒ whole expiry refused.
- Guard tests stay green: new tables in `no-direct-state-writes`; `@hnet/arr/write`
  confinement unchanged.
- Merge gate: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`.

### e2e (Playwright, stub Maintainerr — hermetic)
- Full lifecycle: create draft from stub collections → poster wall renders → flip X⇄lock (tile
  does not move — reuse the resize/reflow assertions) → green-light Modal → user-phase save as
  a `save_leaving_soon` role → **stubbed expiry** deletes survivors only, skipped/saved
  reported → batch history shows counts. Role without the action sees read-only wall.

### LIVE on staging + real Maintainerr — **NON-DESTRUCTIVE**
1. **Create a draft batch from the 006 test-rule collections** (the seeded conservative junk).
2. **Admin save flow** on a phone-width viewport — flip several posters, counts update, no
   reflow.
3. **Green-light** → verify the **"Leaving Soon" Plex collection appears** on the real Plex
   server (per Q-05/Q-09) with the surviving items.
4. **User save flow** — a non-admin role holding `save_leaving_soon` rescues an item; the save
   event lands with their attribution; a role without the grant cannot.
5. **Expiry deletion is validated hermetically ONLY** (the e2e stub run above) — **or**, at
   the owner's explicit call at validation time, against a **single owner-sacrificed junk
   item**; never against the full batch. Re-read collections + disk afterwards and record the
   "nothing (else) deleted" confirmation, as 006 did.

---

## Definition of Done

- Docs-first artifacts authored same-PR (PRD block; ADR ratified Accepted; DESIGN with the
  state machine, wire contracts, and the verified Q-05 mechanics table; glossary terms).
- Merge gate + required checks green; squash-merged; deployed to staging.
- LIVE journeys 1–4 pass (5 hermetic or owner-sanctioned single item); Plex collection
  verified visible; save-data (ledger events + snapshots columns) verified queryable — the
  PLAN-013/014 contract exists in real rows.
- Plan marked Completed and `git mv`'d to `.agents/plans/completed/`.

---

## Out of scope

- Disk-utilization / reclaim metrics and their surface (PLAN-013) — this plan only RECORDS the
  snapshots they need.
- Rule tuning, the space-target policy loop, and skip-gate graduation criteria (PLAN-014) —
  this plan ships the skip-gate mechanism + audit, not the decision to flip it.
- Music — never batchable (R-87 stands).
- Replacing Maintainerr's rule engine or its scheduled deletion cron for non-batch flows
  (006's surfaces continue to exist unchanged).

---

## Rollback

- **Kill switch without deploy:** cancel open batches (releases/removes the Leaving Soon
  collection per Q-05) + the Trash section-level disable from 006 still gates everything.
- **Deploy:** revert the haynes-ops image tag + `flux reconcile`.
- **Data:** migration is additive (two tables + enum values + settings rows); down-migration
  drops them. Ledger events are append-only history — harmless to retain.
- **Safety posture:** deletion only ever happens inside `expireBatch` behind
  state-machine + gate + window + SAFE-audit + per-item guardian; a rollback mid-window
  leaves a `leaving_soon` batch inert (nothing expires without the app running the loop) and
  Maintainerr's own rules stay as conservative as 006 configured them.
