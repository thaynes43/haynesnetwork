# DESIGN-048: Durable Trash save intent — schema, relink reconciler, honest badge

- **Status:** Draft
- **Last updated:** 2026-08-29
- **Satisfies:** PRD-001 R-79..R-87; governed by [ADR-086](../adrs/086-durable-trash-save-intent.md),
  amending [ADR-023](../adrs/023-trash-and-maintainerr.md); reuses
  [ADR-035](../adrs/035-trash-candidates-read-model.md)'s read model.

## Overview

A Save currently means "exclude Plex ratingKey X in Maintainerr". The ratingKey dies when a file is
replaced, Maintainerr's nightly `removeLeftoverExclusions()` collects the corpse, and the save is
gone with no error while a leftover `dnd` tag keeps the wall claiming otherwise
(`.agents/context/2026-08-29-trash-save-lapse-incident.md`).

This design makes a Save mean **"keep this title"**, held durably by the app against the *arr
identity, reconciled onto whatever key Plex is currently using, and stops the UI asserting
protection it cannot prove — **without changing a single keep-signal**.

Three things this design deliberately does **not** do: it does not strip stale `dnd` tags
(ADR-086 D-8, censused), it does not reclassify the batch wall's `protected` state (D-7, that is a
keep decision), and it does not relink a same-key lapse (D-4, that is a human un-exclusion).

## Detailed design

### D-01 — `trash_save_intents` (migration `0076`)

```sql
CREATE TABLE "trash_save_intents" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "media_item_id"        uuid NOT NULL REFERENCES "media_items"("id") ON DELETE CASCADE,
  "media_kind"           text NOT NULL,
  "maintainerr_media_id" text NOT NULL,          -- the key excluded at save/relink time
  "origin"               text NOT NULL,          -- 'user' | 'batch_save' | 'backfill'
  "saved_at"             timestamptz NOT NULL DEFAULT now(),
  "saved_by_user_id"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at"           timestamptz,
  "revoked_by_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "relink_count"         integer NOT NULL DEFAULT 0,
  "last_relinked_at"     timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trash_save_intents_media_kind_enum" CHECK ("media_kind" = ANY (ARRAY['movie','tv'])),
  CONSTRAINT "trash_save_intents_origin_enum"     CHECK ("origin" = ANY (ARRAY['user','batch_save','backfill']))
);
-- ADR-086 D-1: at most ONE unrevoked intent per media item. This is the invariant the
-- reconciler relies on; enforce it in the schema, not in the writer.
CREATE UNIQUE INDEX "trash_save_intents_one_open_per_item"
  ON "trash_save_intents" ("media_item_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "trash_save_intents_open_kind_idx"
  ON "trash_save_intents" ("media_kind") WHERE "revoked_at" IS NULL;
```

Journal: append `{ "idx": 75, "version": "7", "when": 1783903400000, "tag": "0076_trash_save_intents", "breakpoints": true }`.
**A `.sql` not listed in `meta/_journal.json` is silently skipped** — the house footgun.

`media_kind` is denormalised (derivable from `media_items.arr_kind`) so the reconciler's hot query
filters without joining. `maintainerr_media_id` is the *last key we successfully excluded*, updated
on every relink; it is the D-04 comparison basis, never an identity.

### D-02 — Writer contract (`packages/domain/src/trash-flow.ts`)

`saveExclusion` and `removeExclusion` remain the only entry points. Both keep ADR-023 C-05's
protective ordering (external call first, then the transaction).

**`saveExclusion` — the intent is written on BOTH paths.** Today the function returns early at
`:793-795` when Maintainerr already holds an exclusion, writing nothing. That early return is
exactly what a re-save after a lapse hits, so it must still **upsert the intent** (and still skip
the duplicate ledger row):

| Maintainerr state | exclusion POST | ledger row | intent |
|---|---|---|---|
| not excluded | yes | `trash_excluded` `save` | upsert open intent |
| already excluded (`alreadyExcluded`) | no | none (unchanged) | **upsert open intent** |
| POST fails / `code:0` | throws | none | none (nothing written) |

**`removeExclusion` — revokes even with nothing to un-exclude (ADR-086 D-3).** Today it returns
early at `:836-840` when no live exclusion exists — the lapsed state. Post-change, if an *unrevoked
intent* exists it must set `revoked_at` and write the `unsave` ledger row even on that path.
Without this the owner has no way to stop the reconciler, because both un-save affordances no-op on
a lapsed item.

Upsert semantics: `ON CONFLICT` against `trash_save_intents_one_open_per_item` → refresh
`maintainerr_media_id`, `updated_at` (never resurrect a revoked row; a re-save after a revoke
inserts a **new** row, preserving history).

Both writers stay inside `inTransaction`, co-writing the ledger row (hard rule 6). Add
`trash_save_intents` / `trashSaveIntents` to `packages/domain/__tests__/no-direct-state-writes.test.ts`
(INSERT + UPDATE families) with the prose block naming ADR-086 and the sole writer — and, per
ADR-086 D-14, close the pre-existing `pending_pool_refresh` / `pendingPoolRefresh` omission in the
same edit.

### D-03 — The relink reconciler (`packages/domain/src/trash-relink.ts`)

```
relinkSaveIntents({ db, maintainerr }) -> TrashRelinkReport
```

**Stage 1 — detect (pure SQL, zero Maintainerr calls).** Join open intents to `trash_candidates`:

```sql
SELECT i.id, i.media_item_id, i.maintainerr_media_id AS saved_key,
       tc.maintainerr_media_id AS pool_key, tc.media_kind
FROM trash_save_intents i
JOIN media_items mi ON mi.id = i.media_item_id
JOIN trash_candidates tc
  ON (mi.arr_kind = 'radarr' AND tc.media_kind = 'movie' AND tc.tmdb_id = mi.tmdb_id)
  OR (mi.arr_kind = 'sonarr' AND tc.media_kind = 'tv'    AND tc.tvdb_id = mi.tvdb_id)
WHERE i.revoked_at IS NULL
  AND tc.maintainerr_media_id IS NOT NULL          -- null ⇒ listed but unactionable, not a re-key
  AND tc.maintainerr_media_id IS DISTINCT FROM i.maintainerr_media_id;   -- ADR-086 D-4
```

The `IS DISTINCT FROM` clause **is** the same-key carve-out. Same-key rows are counted into
`sameKeyCensus` by a sibling query and never acted on.

**Stage 2 — verify live.** `fetchLiveExclusions(maintainerr, poolKeys)` over the (small) differing
set. Already excluded under the new key ⇒ no write, just refresh `maintainerr_media_id`
(a self-healed case).

**Stage 3 — relink.** Per survivor: `saveExclusion(..., reason: 'relink', maintainerrMediaId: poolKey)`
→ `POST /api/rules/exclusion`, ledger row `reason:'relink'`, intent updated
(`maintainerr_media_id = poolKey`, `relink_count += 1`, `last_relinked_at = now()`). Then
`schedulePoolRefresh` once per kind so Maintainerr drops the item on the debounced
`POST /api/rules/execute` (reuses the existing backstop, no new mechanism).

**Report:**
```ts
interface TrashRelinkReport {
  scanned: number; relinked: number; alreadyExcluded: number; failed: number;
  sameKeyCensus: number;      // ADR-086 D-4 — human un-exclusions, observed not acted on
  staleTagCensus: number;     // ADR-086 D-8 — dnd tag, no exclusion, no open intent
  unlinkedSaves: number;      // ADR-086 D-13 — saves with media_item_id null
  samples: Array<{ title: string; savedKey: string; poolKey: string }>;  // capped at 10
}
```

**Kill switch:** new `APP_SETTING_KEYS` entry `trash_relink_enabled` (bool, **default true** —
absent key ⇒ the documented default, T-80). Off ⇒ detect + census only, zero writes.

**Isolation:** wrapped exactly like `drainDuePoolRefreshes` (the *write* post-step) — try/catch,
logs, stores `relinkError`, never touches `totalFailure`.

### D-04 — Sync wiring (`packages/sync/src/orchestrator.ts`)

New post-step **after** `refreshTrashCandidates` and after `drainDuePoolRefreshes` (ordering is
load-bearing: reading a pre-refresh snapshot doubles the staleness bound — ADR-086 C-07). Gate on
`options.maintainerr !== undefined` (needs the **write** bundle). Add `relink?: TrashRelinkReport | null`
+ `relinkError?: string` to `SyncReport` and to the return object. Export from
`packages/domain/src/index.ts`.

**No new sync mode and no new CronJob** — it rides `incremental` (`*/15`) and `full`, where the
write-capable bundle is already built (`packages/sync/src/scripts/sync.ts:317-323`).

### D-05 — The honest badge (display only)

**Amended at build time (2026-08-29): no new wire field is needed.** The design called for adding
`exclusionVerified`, but `protectedByExclusion` **already is** exactly that field — it is populated
in `listTrashPendingPage` from the page-scoped `fetchLiveExclusions` cross-check
(`trash-candidates.ts:509-517`), it carries only the live-exclusion verdict, and **no server-side
keep reads it**. So ADR-086 D-6's "provably display-only" property holds as-is, and adding a second
field carrying the same fact would be duplication, not safety.

The tri-state (`boolean | null`) has no producer today: `listTrashPendingPage` calls
`fetchLiveExclusions` unconditionally and it fails closed. **If the ADR-035 C-06 follow-up recorded
in PLAN-067 ever lands** (render the wall from the snapshot during a Maintainerr outage), the
tri-state becomes necessary to honour D-12's conservative fallback — do not drop that requirement
along with the field.

**`apps/web/lib/trash.ts` `pendingWallGlyph`** — the `||` at `:166` narrows:

```ts
if (override === 'saved') return 'shield';
// ADR-086 D-5: only a LIVE exclusion earns the inert check. A bare `dnd` tag is a keep-signal,
// not a protection claim — it can outlive its exclusion (the re-key lapse), and an inert check
// on a lapsed item is both a lie and a dead end (the owner cannot tap to re-save).
if (override !== 'unsaved' && item.protectedByExclusion) return 'check';
return 'trash';
```

`pendingWallTappable` is **unchanged** — narrowing the glyph is sufficient to restore tappability.

**`apps/web/components/trash-shield.tsx:333-352`** — the same `||` narrows identically, so a lapsed
item no longer reads *Protected* on `/library/[id]` while reading *slated* on the wall.

**`apps/web/components/pending-wall.tsx:65`** — tooltip copy for a tag-only item becomes
informational ("carries the dnd tag" as a note, not "Protected — …").

**`previewGuardian` is untouched.** It is the documented mirror of `classifyGuardian`
(ADR-023 C-07b) and the confirm modal must keep predicting what the server will actually skip.

### D-06 — Reconciling the three preview copies (ADR-086 D-11)

`partitionPendingForExpedite` (`trash-candidates.ts:421`) still counts `requesters.length > 0` as
`protected`; `classifyGuardian` **deletes** requester items (owner ruling 2026-07-09). The client
`previewGuardian` was updated then, the server mirror was not — and `trash-client.tsx:276` consumes
the *server* preview, so the Expedite-all confirm understates what will be deleted. Zero pool items
carry requesters today, so this is latent.

Fix: drop the requester branch from `partitionPendingForExpedite` so all three agree, and collapse
them onto one shared derivation. This is the point of the change: adding D-05's new rule to one of
three copies would repeat the exact drift that caused this.

**Amended at build time (2026-08-29) — the client mirror cannot literally re-export.** `apps/web/lib/*`
never imports `@hnet/domain` *values*: that drags drizzle/pg into the browser bundle (the rule is
stated at `lib/media.ts:117`, `lib/library-views.ts:2-6`, `lib/space-policy.ts:4`), and
`@hnet/domain` exposes a single `"."` export. A true re-export would need a new pure subpath plus
moving guardian code out of `trash-flow.ts` — the file PLAN-067's invariants pin by line number.

So the shape is: **the two SERVER copies collapse into one** (`classifyForExpedite` in
`trash-flow.ts`, which `partitionPendingForExpedite` now calls — structurally undriftable), and the
remaining client mirror `previewGuardian` is pinned by a **parity test over the full input matrix**,
the same arrangement `lib/library-views.ts` already uses. `classifyGuardian`'s body is byte-identical;
only its parameter type widens to a structural `Pick` of the three fields it reads, which is a
zero-runtime change.

### D-07 — Backfill (one-off, in `0076`)

```sql
INSERT INTO trash_save_intents (media_item_id, media_kind, maintainerr_media_id, origin, saved_at, saved_by_user_id)
SELECT DISTINCT ON (le.media_item_id)
       le.media_item_id,
       CASE WHEN mi.arr_kind = 'radarr' THEN 'movie' ELSE 'tv' END,
       le.payload->>'maintainerrMediaId', 'backfill', le.occurred_at, le.requested_by_user_id
FROM ledger_events le
JOIN media_items mi ON mi.id = le.media_item_id
WHERE le.event_type = 'trash_excluded' AND le.media_item_id IS NOT NULL
ORDER BY le.media_item_id, le.occurred_at DESC;
-- then keep only rows whose LATEST event was a user-originated save
```

The filter must be applied to the **latest** event per item (a `DISTINCT ON` over the ordered set),
keeping `action = 'save'` **and** `reason IN ('user','batch_save')`. `reason = 'watch_guardian'` is a
deliberately time-scoped auto-protection and must never become an eternal intent (ADR-086 D-10).
Measured 2026-08-29: **108 rows (97 `user` + 11 `batch_save`), 20 revoked, zero `watch_guardian`** —
so the filter changes no number today and is a forward guard. `arr_kind = 'lidarr'` cannot occur
(ADR-023 C-06) but the `CASE` must not silently mint `'tv'` for it — filter it out explicitly.

Green Lantern needs no special case: its latest event is the 07-11 `save`, so it backfills with the
**old** key `95267`. The reconciler's first tick sees pool key ≠ saved key and self-corrects to
`102261` — which is also the design's first live proof.

## Alternatives considered

- **Derive current-save state from `ledger_events`** — rejected in ADR-086 (lossy on both idempotent
  early-returns, unindexed, replay-ambiguous between `user` and `watch_guardian`).
- **Change what `shapePendingItems` puts in `protectedByTag`** — rejected: that one field feeds both
  the badge and every keep-signal, so the change could not be shown to be display-only. The separate
  wire field makes ADR-086 D-6 provable.
- **A dedicated `relink` sync mode + CronJob** — rejected: the `incremental` post-step already has
  the write bundle and a 15-minute cadence; a new CronJob is pure ceremony (`activity-scan` is
  precedent for a mode that exists without a schedule, not for adding one).
- **Strip stale `dnd` tags in the same pass** — deferred to the D-8 census; removing a protective
  tag is the one hard-to-reverse action here and needs an owner ruling backed by real counts.

## Test strategy

**Unit (`packages/domain/__tests__/`)**
- `trash-relink.test.ts` (new) — the full lapse repro using the existing stub primitives:
  save → `state.exclusions.delete(key)` (the nightly purge) → mutate the `StubItem`'s
  `mediaServerId` to a new key with `tmdbId` unchanged → `refreshTrashCandidates` → assert exactly
  one relink onto the new key, one `trash_excluded` `reason:'relink'` row, `relink_count = 1`.
- **Same-key is NOT relinked** (ADR-086 D-4): delete the exclusion without re-keying ⇒ zero writes,
  `sameKeyCensus = 1`.
- **Revoked intents are never resurrected**, and **un-save revokes with no live exclusion**
  (ADR-086 D-3) — the regression test for the hole that would make the reconciler unstoppable.
- Kill switch off ⇒ census only, zero Maintainerr writes.
- Outage ⇒ report carries `relinkError`, `totalFailure` stays false.
- Add `purgeDanglingExclusions(state)` to `maintainerr-stub.ts` beside the existing
  `purgeRuleLessCollections`, mirroring `removeLeftoverExclusions` so "a night passed" is one call.

**Unit (`apps/web/lib/__tests__/trash.test.ts:104-187`)** — revise the two glyph assertions:
`protectedByTag: true` alone now yields `'trash'` and **is tappable**; `protectedByExclusion: true`
still yields the inert `'check'`. Add the lapsed-item case (tag true, exclusion false).

**E2E (`apps/web/e2e/trash.spec.ts`)** — the repro is expressible with the existing stub controls:
`STUB_MAINT_RUNNER_ID` (`ms-880002`, the dnd-tagged fixture) → `_stub/exclude` then
`{excluded:false}` → `_stub/remove-pending` + `_stub/add-pending` under a new `mediaServerId` with
`tmdbId: 880002` → assert the tile is no longer an inert `check` and `trash-toggle` is present
(mirror of the existing `:404-414` assertion, inverted).

**Guard** — `no-direct-state-writes.test.ts` must fail if the new table is written outside
`@hnet/domain`; assert the `pending_pool_refresh` entry too.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should the D-8 stale-tag census graduate to actually stripping `dnd` tags once counts are known? | (open — deliberately deferred; needs an owner ruling backed by the census, not a guess) |
| Q-03 | During the lapse window, `/library/[id]` now offers **Save** rather than Un-save (the item honestly reads as slated), so revoking the intent takes Save → Un-save instead of one click. Worth a dedicated "stop keeping this" affordance? | (open — low urgency: the window is ≤ one incremental tick before the reconciler relinks and the normal Un-save returns, and the server still refuses to delete a tag-protected item throughout) |
| Q-02 | Should a relink notify the owner (Bulletin/Pushover), or is the ledger row + digest enough? | (open — leaning ledger-only; Pushover audit notifications were REJECTED for ADR-084's analogous case on 2026-08-20, so the precedent says no) |
