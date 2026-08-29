# ADR-086: Durable Trash save intent — relink on re-key, and an honest protected badge

- **Status:** Proposed
- **Date:** 2026-08-29
- **Deciders:** Tom Haynes (owner ruling 2026-08-29, AskUserQuestion: "fix both halves")
- **Amends:** [ADR-023](023-trash-and-maintainerr.md) — the ownership of exclusion *intent* (narrow,
  see D-2) and C-07's `dnd` tag as a protection *claim* (D-5). ADR-023 stays Accepted and unedited.

## Context and problem statement

A Trash **Save** writes a Maintainerr exclusion keyed on the **Plex ratingKey**
(`mediaServerId`) and a `trash_excluded` ledger row (ADR-023 C-05). The ratingKey is **not a
durable identity**: when Radarr/Sonarr replaces a title's file (an ordinary quality upgrade — the
title is never removed from the *arr), Plex **can** retire the old item and mint a new one with a
new key. It usually updates in place, but not always. Maintainerr's nightly Rule Maintenance then runs
`removeLeftoverExclusions()`, which deletes every exclusion whose ratingKey is no longer present on
the media server — so **the owner's save is silently erased** and the title re-enters the deletion
pool on the next rule run.

The paired `dnd` un-tag cannot complete on that path (it resolves the *arr item *from* the
nonexistent ratingKey, and the `collection_media` fallback row is gone too), so the **`dnd` tag is
left behind**. The wall reads that tag as `protectedByTag` and paints the tile with the **inert
`check` glyph** — it looks protected, it is not, and the owner cannot tap it to re-save.

Verified live 2026-08-29 (full evidence chain, ruled-out alternatives, and reproduction commands:
`.agents/context/2026-08-29-trash-save-lapse-incident.md`):

- One realised case, **Green Lantern**: saved 07-11 on key `95267`, file replaced 08-05, Plex
  re-keyed to `102261`, exclusion pruned, back in the pool 08-06 wearing a stale `dnd` tag.
  Re-protected by hand during the investigation (exclusion 388, verified off the wall).
- The other **107 of 108** saved items are correctly excluded and out of the pools — the save
  mechanism itself is sound, and so are the pool-removal, rule-execute backstop, read-model and
  aging-invariant paths (all positively exonerated in the note).
- **The trigger is an ordinary quality upgrade, not a delete-and-re-add** (sharpened 2026-08-29
  after an owner question). Green Lantern went Remux-1080p → WEBDL-2160p with `movieId 2974`
  constant and `deleted_from_arr_at` still NULL — Radarr replaced the file in place and Plex
  re-keyed the item anyway. Estate-wide since 07-01: **11,700 `file_deleted` vs 255 `item_removed`,
  and 11,645 of the file-deletes are followed by an import within 15 minutes** (99.5% upgrades).
- Exposure is **ongoing but conditional**: an upgrade does not usually break a save (Plex normally
  updates in place). **15 saved titles were upgraded after being saved; exactly 1 lapsed.** The
  hazard is that when Plex *does* re-key, the loss is silent — not that every upgrade loses a save.

Nothing is at risk of deletion today — the stale tag itself still forces a keep at every decision
point (`trash-flow.ts:886` `classifyGuardian`, `trash-batches.ts:531` batch snapshot state,
`:1307` the sweep-time re-check) and the pools stay defused by ADR-036. The hazard is the
**inverse** case: a title the owner believes is saved, whose accidental protection later gets
cleaned up. Protection is resting on a leftover tag instead of on the system of record.

This is the first fact that breaks a premise of **ADR-023**. Its driver 1 holds that "the
*arrs/Maintainerr own the truth", and exclusions were left read-through on that basis. Maintainerr
owns the *enforcement*; it demonstrably does not own a *durable* record of the owner's intent,
because it garbage-collects that record against an ephemeral key.

## Decision drivers

- **A save is a promise to the household.** It must survive a file upgrade. Silent lapse is the
  worst failure mode: no error, no notification, and a UI that actively asserts the opposite.
- **The UI must never claim protection it cannot prove** (ADR-023 C-07c already applied this
  reasoning to the expedite confirm; the wall was left behind).
- **Fail-safe direction only.** `protectedByTag` is also a *keep* signal. Making the badge honest
  must not turn a kept item into a deletable one.
- **Never fight a deliberate human action.** A reconciler that re-asserts protection a person
  intentionally removed is a worse bug than the one being fixed.
- **The *arrs are the source of truth** (hard rule 4) — the app already holds the durable identity
  (`media_items.tmdb_id` / `tvdb_id`); it simply never used it for exclusions.

## Considered options

**For the durable intent:**

1. **Derive "currently saved" from `ledger_events` history** — last `trash_excluded` row per
   `media_item_id` wins. Zero new schema. **Provably lossy:** `saveExclusion` returns early on
   `alreadyExcluded` and writes **no** event (`trash-flow.ts:793-795`), and `removeExclusion` does
   the same when nothing is excluded (`:836-840`). It is also unindexed (no index on `payload`),
   and its discriminators (`action`, `reason`) live in untyped jsonb, so a replay must correctly
   distinguish user saves from `watch_guardian` auto-protections or it silently promotes a
   time-scoped auto-keep into an eternal one.
2. **An explicit `trash_save_intents` table** (chosen) — single-writer, revocable, indexable.
3. **Re-apply exclusions from the *arr `dnd` tag** — treat the tag as the durable intent.
4. **Patch or fork Maintainerr** so the pruner relinks instead of deleting — foreclosed by
   ADR-078's stock-image driver.

**For the badge:**

5. **Keep the inert `check` for a tag-only item** (status quo) — dishonest and unactionable.
6. **Tag-only items render as ordinary saveable tiles** (chosen), with the tag as information.
7. **Drop `protectedByTag` everywhere**, including the guardian — rejected outright, it weakens a
   safety keep.

## Decision outcome

Chosen: **2 + 6** — the app owns a durable, revocable save intent and reconciles it onto whatever
key the title currently carries; the wall stops asserting protection it cannot prove, while every
keep-signal is left exactly as it is.

- **D-1 — `trash_save_intents` is the durable record of a save.** Keyed on `media_item_id` (the
  *arr identity, stable across re-keys), carrying the `mediaServerId` observed at save time,
  `saved_at`/`saved_by_user_id`, and a `revoked_at` that an un-save sets. **At most one unrevoked
  intent per media item.** Written only by a `@hnet/domain` single-writer, in the **same
  transaction** as the `trash_excluded` ledger row it records (hard rule 6), and added to the
  no-direct-state-writes guard list. Chose this over option 1 because that log is demonstrably
  incomplete, unindexed, and replay-ambiguous; the ledger stays the audit trail, not the state
  index. Chose it over option 3 because the tag is Maintainerr-managed, lossy on exactly this
  path, and cannot express revocation. **The intent row must be written even on the
  `alreadyExcluded` early-return path** — that is exactly the case a re-save after a lapse hits.

- **D-2 — Amends ADR-023 narrowly.** Exclusions remain read-through and Maintainerr remains the
  enforcement system of record. The app now additionally owns the **intent** behind an exclusion.
  Nothing else changes: no mirror of the pending set, no mirror of deletion history.

- **D-3 — Un-save revokes the intent even when there is nothing to un-exclude.** `removeExclusion`
  currently early-returns when no live exclusion exists (`trash-flow.ts:836-840`) — which is
  precisely the lapsed state. Post-ADR it must still revoke an unrevoked intent (and write the
  `unsave` ledger row) in that case. Without this the owner would have **no way to stop** the
  reconciler re-protecting a title they no longer want, since the only un-save affordances would
  no-op. This is the property that makes D-1's "revocable" true in the flow that matters most.

- **D-4 — A relink reconciler runs as a sync post-step, and only on a *changed key*.** For every
  unrevoked intent whose media item currently appears in a trash pool under a `mediaServerId`
  **that differs from the intent's recorded key** and is not live-excluded, it re-applies the
  exclusion on the current key, updates the intent, and writes a `trash_excluded` ledger row with
  `reason: 'relink'` (never `'user'` — attribution stays honest).
  **The same-key case is deliberately excluded**: an item pooled under the key we already excluded,
  with the exclusion gone, is essentially only reachable by a human removing it in Maintainerr's own
  UI. Re-applying there would fight a deliberate action, and it is outside what the owner ruled on.
  Those are reported through D-7's census instead. The reconciler is idempotent, rides the existing
  **`incremental` post-step** (`*/15`, write-capable bundle already wired) so there is **no new sync
  mode and no new CronJob**, and is isolated exactly like **`drainDuePoolRefreshes`** (the *write*
  post-step; `refreshTrashCandidates` is read-only and is the wrong twin) — a Maintainerr outage
  logs and never fails the run. It must run **after** the candidate refresh in the same tick, or its
  staleness bound doubles. Detection is a pure SQL join of intents against `trash_candidates` on
  `(arr_kind, tmdb_id|tvdb_id)`, costing zero Maintainerr calls; only the small differing set is
  live-verified, because `GET /rules/exclusion` is a per-id read with no list-all form.

- **D-5 — A bare `dnd` tag no longer renders as protection.** `pendingWallGlyph`
  (`apps/web/lib/trash.ts:166`) and the `/library` guard panel
  (`apps/web/components/trash-shield.tsx:333-352`) both read
  `protectedByTag || protectedByExclusion` — that `||` is the bug site, in both places, and a
  lapsed item currently reads *slated* on the wall and *Protected* on its own detail page. They
  yield the inert `check` only for a **live exclusion**; a tag-only item renders as an ordinary
  saveable tile, with the tag surfaced as information rather than as a claim (the
  `pending-wall.tsx:65` tooltip copy included). `previewGuardian` is **left alone**: it is a
  documented mirror of `classifyGuardian` (ADR-023 C-07b), so the confirm modal keeps telling the
  truth about what the server will skip.

- **D-6 — The keep-signals are untouched, and structurally so.** The fix does **not** change what
  `shapePendingItems` puts in `protectedByTag` — that field feeds both halves. It adds a
  **separate wire field** carrying the live-exclusion verdict, consumed **only** by the display
  sites in D-5. `trash-flow.ts:886`, `trash-batches.ts:414`/`:531`/`:1307` keep reading the
  untouched field, so every keep is provably unchanged rather than merely intended to be. This ADR
  changes what the UI **asserts** and what it **permits**, never what the server **keeps**.

- **D-7 — The batch wall's `protected` state is deferred, deliberately.** `trash-batches.ts:531`
  snapshots a tag-only item as `'protected'`, which the batch wall renders as an inert check — the
  same dishonest badge in a second wall. It is **not** changed here, because that state is a *keep
  decision* (it removes the item from the batch's delete set), not merely a claim; making it
  "honest" would reclassify a kept item as deletable, which D-6 forbids. The batch badge is
  therefore conservative-but-stale rather than dangerous. The honest improvement available there is
  to *label* it distinctly ("protected by tag") without reclassifying it — folded into DESIGN-048.

- **D-8 — Stale tags are censused, not swept.** A `dnd` tag with no live exclusion and no unrevoked
  intent is reported (count + sample) by the reconciler, not stripped, alongside the D-4 same-key
  cases. Removing a protective tag is the one irreversible-ish action in this area and it gets its
  own owner ruling if the census shows it matters.

- **D-9 — It ships enforcing, not census-first.** ADR-083's census-first ladder targets
  *destructive* automation acting on unobserved classification inputs. This reconciler's inputs are
  the app's own records, its action is protective, idempotent and audited, and — with D-4's
  same-key carve-out — it only ever re-asserts an intent the owner explicitly expressed about a
  title that demonstrably moved. Withholding it is the risk-bearing choice, and ADR-083's own
  owner ruling warns that observe-only never graduates. It carries an app-settings kill switch and
  logs every relink. Recorded here so the deviation is deliberate and reviewable.

- **D-10 — The backfill is user-originated saves only.** Seed one intent per `media_item_id` whose
  **latest** `trash_excluded` event is a `save` **with `reason` in (`user`, `batch_save`)**.
  `reason: 'watch_guardian'` saves are deliberately time-scoped auto-protections and must never
  become eternal intents. Measured 2026-08-29: **108 intents (97 `user` + 11 `batch_save`), 20
  revoked, and zero `watch_guardian` saves exist** — so the filter changes no number today and is a
  forward guard. Green Lantern's latest event is its 07-11 `save`, so it backfills correctly even
  though this session's hand-repair wrote no ledger row.

- **D-11 — Three drifting preview copies are reconciled.** `partitionPendingForExpedite`
  (`trash-candidates.ts:421`) still counts `requesters.length > 0` as `protected`, but
  `classifyGuardian` **deletes** requester items (owner ruling 2026-07-09 — requested is
  informational). The client `previewGuardian` was updated in 2026-07; the server mirror was not,
  and `trash-client.tsx:276` consumes the *server* preview — so the Expedite-all confirm
  **understates what will be deleted**. Zero pool items currently carry requesters, so this is
  latent, not live. It is fixed here because adding D-5's new rule to only one of three copies
  would repeat the exact drift that caused it; DESIGN-048 collapses them onto one shared
  derivation.

- **D-12 — Unverifiable exclusion state stays conservative.** When the live exclusion read is
  unavailable (Maintainerr outage — ADR-035 C-06 still renders the wall from the snapshot), the
  tile keeps the inert `check` rather than flipping to "slated". Saves are already gated on
  `reachable`, so no tile is tappable in that window and there is no action to mislead; claiming
  "unprotected" would be the more alarming lie. The existing unreachable banner carries the caveat.

- **D-13 — Unlinkable saves are out of scope, honestly.** A save on an item unknown to our ledger
  writes `media_item_id = null` and has no durable identity to relink. The reconciler counts them
  so the gap is visible rather than implied. Measured: **zero** of 205 `trash_excluded` events have
  ever been unlinked, so this is theoretical today.

- **D-14 — Two guard-list gaps close in the same change.** `pending_pool_refresh` /
  `pendingPoolRefresh` is absent from `no-direct-state-writes.test.ts` despite its schema comment
  claiming a single writer. Adding the new table is the natural moment to close that, so the claim
  and the enforcement agree.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a save survives file replacement — the promise the Trash UI has been making since ADR-023 is finally true. |
| C-02 | Good: the wall stops asserting protection it cannot prove, and a lapsed item becomes re-saveable instead of an inert dead tile. |
| C-03 | Good: relinks are audited (`reason: 'relink'`), so a lapse-and-recovery is legible after the fact instead of silent in both directions. |
| C-04 | Good: no Maintainerr fork or patch; the estate stays on the stock image (haynes-ops `media/maintainerr`). |
| C-05 | Good: D-11 closes a latent consent bug in the Expedite-all confirm that predates this work. |
| C-06 | Neutral: one new table + a reconciler post-step to maintain. Detection is a pure SQL join (zero Maintainerr calls); added upstream cost is proportional to lapses, not to the intent set. |
| C-07 | Bad: intent and enforcement can disagree between ticks (one incremental tick, 15 min, given D-4's ordering). Bounded and fail-safe — the stale tag and the defused pool horizon both keep the item alive in that window. |
| C-08 | Bad: saves made before this ADR have no intent row; they are backfilled once (D-10). Null-linked saves (D-13) are unrecoverable by construction, though none exist. |
| C-09 | Bad: the D-4 same-key carve-out means a human-removed exclusion is **not** re-applied even when an intent exists. That is deliberate (never fight a person) but it does leave one lapse shape uncovered until the D-8 census says whether it happens. |
| C-10 | Ops: the reconciler will not re-protect an item the owner deliberately un-saved — revocation is explicit (D-3), not inferred from a missing exclusion. This is what stops it fighting the owner. |

## More information

- Evidence, ruled-out alternatives, reproduction commands:
  `.agents/context/2026-08-29-trash-save-lapse-incident.md`.
- Maintainerr **v3.25.0** sources read off the running pod: `rule-maintenance.service.js`
  (`removeLeftoverExclusions`), `item-presence.util.js` (conservative missing-detection — a
  media-server outage does **not** wipe exclusions), `rules.service.js` (`removeExclusion` →
  `syncExclusionTag('remove', …)`), `servarr-tag.service.js` + `metadata.service.js` (why the
  un-tag cannot resolve).
- Glossary: adds **save intent** and **relink** to
  `docs/domain-driven-design/001-ubiquitous-language.md`, extends the `trash_excluded` `reason`
  vocabulary with `relink`, and amends **T-70** (Exclusion / Whitelist / Save) — which is also
  stale on requesters since the 2026-07-09 ruling (see D-11).
- Relates to [ADR-035](035-trash-candidates-read-model.md) (the read model the reconciler joins
  against), [ADR-036](036-maintainerr-aging-invariant.md) (why nothing was deleted meanwhile),
  [ADR-078](078-leaving-soon-rule-group-shell.md) (the previous Maintainerr-lifecycle correction),
  [ADR-083](083-arr-queue-janitor-census-first.md) (the census-first doctrine D-9 departs from),
  and [ADR-084](084-trash-delete-arr-writeback.md) (the adjacent re-download-loop write-back).
- Implemented by DESIGN-048 / PLAN-067.
