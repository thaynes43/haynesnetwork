# ADR-078: Leaving Soon as a Maintainerr rule-group shell — purge-proof record + dangling-id self-heal

- **Status:** Accepted (owner directive 2026-07-28: fix the duplicate "Leaving Soon" collections autonomously)
- **Date:** 2026-07-28
- **Deciders:** Tom Haynes (owner) · executed by an autonomous run
- **Supersedes:** [ADR-025](025-trash-curation-pipeline.md) consequence **C-04**'s TRANSPORT (the bare
  `POST /api/collections` manual-collection create). C-04's INTENT — a rolling, Plex-Home-visible,
  `arrAction: DO_NOTHING` Leaving-Soon collection whose deletions only the app's windowed sweep may
  perform — **stands unchanged**, as do all other ADR-025 consequences (state machine, sweep, guardian,
  Q-05/Q-09 answers as amended here).

## Context and problem statement

The owner's Plex Home showed **four identical "Leaving Soon — Movies" rows** (2026-07-28 report).
Investigation of the live estate found four duplicate Plex collection objects with that title
(ratingKeys 98724 / 98887 / 99586 / 100233, created 07-07 / 07-11 / 07-18 / 07-25 — one per batch
cycle), three of them empty shells that still rendered full rows because Plex resolves collection
membership as a title tag shared across same-title objects.

Root cause, verified against the running Maintainerr v3.19.0 and its source:

1. **Maintainerr nightly purges rule-less collection records.** `RuleMaintenanceService`
   (cron `20 4 * * *`) runs `removeCollectionsWithoutRule()`: every collection record with **no rule
   group** is deleted via a raw repository delete — **no log line, no Plex-side cleanup**
   (`apps/server/src/modules/rules/tasks/rule-maintenance.service.ts`). ADR-025 C-04's
   `POST /api/collections` create produces exactly such a record, so the app's Leaving-Soon record
   survived at most one night. Confirmed in the live logs: the worker counted the record at
   26/07 00:00 ("3 total (isActive), 1 skipped (Do Nothing)") and it was gone by 12:00, with only
   "[RuleMaintenanceService] Starting maintenance" at 04:20 in between.
2. **Each weekly cycle then re-created the collection as a NEW Plex object.** The drive's
   idempotency check reads Maintainerr's collection list by title; the record being purged nightly
   made every promote a "create". The bare-collection create path calls Plex's collection create
   **unconditionally** (`createCollectionWithChildren`, `empty=false`), minting a duplicate Plex
   object each cycle and promoting it to Home/Recommended — the four rows.
3. **Mid-window saves silently broke.** The live movie batch (`1680f30c…`, promoted 07-25) pointed
   at purged record id 21; a member's save on 07-26 16:41 hit Maintainerr's tolerant
   `Collection with id 21 not found, skipping removal` — the app recorded the rescue but the item
   stayed on the Plex wall.

The three orphaned Plex objects were deleted operationally on 2026-07-28 (via the Maintainerr
media-server proxy), leaving 98724 as the single rolling collection. This ADR is the code contract
that stops the factory from restarting.

## Decision drivers

- The record must survive Maintainerr's nightly maintenance **as configured upstream** — patching or
  forking Maintainerr is out of scope; the estate runs the stock image (haynes-ops `media/maintainerr`).
- No new Plex duplicate objects, ever — recreation must adopt the existing same-title collection.
- A vanished record must not silently disable saves mid-window (fail closed is the repo posture, but
  a save is a user rescue — it must HEAL, not refuse).
- Keep the ADR-025 safety invariants: `arrAction: DO_NOTHING(4)` is the only aging opt-out
  (`deleteAfterDays` cannot disable aging on the zod route); the windowed sweep stays the only
  deletion path.

## Considered options

1. **Rule-group SHELL via `POST /api/rules`** (`useRules: false`, zero rules) — the record gets a rule
   group, so `removeCollectionsWithoutRule` spares it. This is how Maintainerr's own UI creates every
   collection; a rule-less record is upstream-invalid by construction.
2. Keep `POST /api/collections` + re-verify/re-create per interaction — treats the symptom, keeps
   minting Plex duplicates (the create path is the duplicate factory), leaves saves broken overnight.
3. Nightly app-side "re-adopt" cron matched to Maintainerr's 04:20 — a timing race by design.
4. Upstream patch/issue to exempt API-created collections from the purge — worth filing, but the
   estate cannot wait on an upstream release train.

## Decision outcome

Chosen option: **1 — the rule-group shell**, implemented in `@hnet/domain` `trash-batches.ts`
(`driveLeavingSoonCollection` + new `healBatchLeavingSoonCollection`), verified against the
Maintainerr **v3.19.0** source (2026-07-28):

- **Create** goes through `POST /api/rules` (RulesDto): `useRules: false`, `rules: []`,
  `arrAction: 4`, `dataType: 'movie'|'show'`, `isActive: true`, collection settings
  `{ visibleOnHome: true, visibleOnRecommended: true, manualCollection: false, deleteAfterDays: null }`.
  `setRules` creates the collection **empty** (`empty=true` — no Plex object minted at create);
  the id is re-read from `GET /api/collections` by exact title (setRules returns only a ReturnStatus).
  `deleteAfterDays: null` survives verbatim on this path (internal call, no `z.coerce`) — and is
  irrelevant anyway because DO_NOTHING is the worker's only per-collection skip (ADR-025 C-04
  correction stands).
- **The Plex object is linked, not minted, on first member add**: v3.19.0's add flow /
  `checkAutomaticMediaServerLink` looks up the library's existing collection **by title and adopts
  it** (pushing the Home/Recommended visibility) and only creates one when none exists. Recreation
  after any future record loss therefore re-attaches to the SAME rolling Plex collection — no
  duplicates.
- **Membership is reconciled, not just topped up**: the drive converges the collection to exactly
  the batch's pending set (add missing + remove stale), and a clean sweep close clears the rolling
  collection so skipped leftovers do not linger on the wall between batches.
- **Self-heal (`healBatchLeavingSoonCollection`)**: when a `leaving_soon` batch's stored id is
  missing from `GET /api/collections`, re-drive (reuse-by-title or fresh shell), reconcile
  membership to the CURRENT pending set, re-point `trash_batches.maintainerr_collection_id` in a
  guarded tx, and write a `trash_batch_transition` ledger event
  (`leaving_soon → leaving_soon`, `extra.healedCollection`). Wired **heal-before-write** into
  save / un-save / un-protect, and opportunistically into the hourly space-policy tick (an outage
  during the tick's heal never fails the tick).
- **Teardown tears down the GROUP**: `cancelBatch` resolves the shell via `GET /api/rules`
  (`collection.id` match) and calls `DELETE /api/rules/:id` — Maintainerr's cascade deletes group +
  record + Plex object together. A record with no resolvable group (legacy) falls back to the old
  `POST /api/collections/removeCollection`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the Leaving-Soon record survives the nightly maintenance — the weekly duplicate-collection factory is closed at its root. |
| C-02 | Good: any future record loss (including a human delete in Maintainerr's UI) self-heals within the hour (space-policy tick) or at the next user save, with an audited ledger event. |
| C-03 | Good: Plex-side, the rolling collection is now genuinely rolling — one object per media kind, adopted by title across record generations; membership converges to the batch's pending set. |
| C-04 | Neutral: the shell appears in Maintainerr's rules UI as an inactive-rules ("use rules" off) group named "Leaving Soon — …". Its hourly executor visit only runs the convergent media-server sync (rule evaluation is gated on `useRules`). |
| C-05 | Bad: the contract now leans on v3.19.0's `setRules` + adoption-by-title behavior — a Maintainerr major upgrade must re-verify both (the stubs encode the contracts loudly; see the F4–F7 + space-policy heal tests). |
| C-06 | Bad: saves/un-saves pay one extra `GET /api/collections` (the heal's liveness probe) per action — negligible at household scale. |

## More information

- Incident + evidence chain: `.agents/context/2026-07-28-leaving-soon-duplicates-incident.md`.
- DESIGN-011 **D-03** amended in place (REST mechanics table) — the design of record for the pipeline.
- Verified sources: `maintainerr/maintainerr@v3.19.0` `rule-maintenance.service.ts`
  (`removeCollectionsWithoutRule`), `rules.service.ts` (`setRules`, `deleteRuleGroup` cascade),
  `collections.service.ts` (`createCollection` `empty` semantics, `checkAutomaticMediaServerLink`
  adoption, add-flow create-if-missing + visibility push, `removeFromCollectionInternal` tolerant
  skip), `rule-executor.service.ts` (`useRules` gate, unconditional media-server sync).
- Q-05/Q-09 (ADR-025) remain answered as before, with transport amended by this ADR.
