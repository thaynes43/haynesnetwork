# ADR-099: A Trash Save is recorded first; the Maintainerr exclusion follows it

- **Status:** Accepted (2026-10-03; the owner's requirement stated as a ruling, implemented by an agent, Accept
  authority per `.agents/plans/README.md`)
- **Date:** 2026-10-03
- **Deciders:** Tom Haynes (owner requirement, 2026-10-03: "if someone clicks save it's saved forever"; losing a
  save is a bug, not a trade-off) · drafted by Opus 5.5
- **Supersedes in part:** [ADR-023](023-trash-and-maintainerr.md) C-05 (the Maintainerr-first write ordering, for a
  person's Save only) and [ADR-086](086-durable-trash-save-intent.md) D-4 (the relink's same-key carve-out). Both
  ADRs stand otherwise.
- **Builds on:** [ADR-096](096-trash-walls-show-only-confirmed-saves.md) (a wall tile flips only on the server's
  answer). Closes [#642](https://github.com/thaynes43/haynesnetwork/issues/642).

## Context and problem statement

A Trash Save wrote the Maintainerr exclusion first and recorded the Save only after Maintainerr answered (ADR-023
C-05, DESIGN-010 D-05), with the shared 30 s `@hnet/arr` timeout. Maintainerr holds exclusion writes while it runs
its scheduled rules (00:00, 08:00 and 16:00 local, about five minutes each), so a Save tapped in that window could
wait past 30 s and fail. One did: at 00:02:24 EDT on 2026-10-03 the owner saved *How Stella Got Her Groove Back*
on the Movies Leaving Soon wall during the TV rule run, the request answered 502 after 30.04 s, and nothing was
recorded (#642, the timeline in ADR-096). ADR-096 made the wall honest about it ("Not saved"); the Save was still
lost, and the batch would have deleted the title.

A Save could also be lost later, silently. A Maintainerr exclusion is keyed on the Plex ratingKey, which a file
replacement can change; Maintainerr's nightly maintenance then prunes the dangling exclusion (ADR-086). ADR-086's
reconciler re-applies it on a changed key, but deliberately not on the same key, and the protection that every
deletion path actually checked was the exclusion (or the stale `dnd` tag it leaves), not the app's own record.

The owner's requirement: if someone clicks Save, it is saved forever.

## Decision drivers

- **A Save is durable the moment the server receives it.** No other system's availability may decide whether it
  happened.
- **The app's record is the protection.** Maintainerr enforces it; it is not the only thing standing between a
  saved title and a delete.
- **Forever means across batches and across Maintainerr's own housekeeping.** A saved title never re-enters a
  batch, and an exclusion Maintainerr loses is put back.
- **Un-save stays deliberate.** The explicit two-step release (ADR-014) is the one way a Save ends, and it removes
  both the record and the exclusion.
- **Hard rule 6:** the Save and its audit rows are written in one transaction.

## Considered options

1. **A longer timeout** (about 90 s, under the edge proxy's 100 s). Still loses a Save whenever Maintainerr is down
   or slower than the new limit, and holds the busy ring for up to 90 s.
2. **Refuse fast while Maintainerr runs its rules** ("try again in a few minutes"). Honest, but the Save is still not
   made; the owner ruled that out.
3. **Move Maintainerr's schedule** away from the family's evenings. Shrinks the window, never closes it, and does
   nothing for a Maintainerr outage or the nightly prune.
4. **Record the Save first and enforce it afterwards** (chosen). The app's record is written before Maintainerr is
   called; Maintainerr is asked under a short deadline; a recurring keeper finishes and maintains the exclusion.

## Decision outcome

Chosen: **option 4**.

- **D-1. Record first.** A person's Save writes, in ONE transaction and before any Maintainerr call: the batch row
  flip to `saved` with its `trash_batch_saves` row (batch wall), or the matching open-batch row flip (pending wall
  and library shield, DESIGN-011 D-07 (d)); the `trash_excluded` ledger row (`action: 'save'`, `reason` `batch_save`
  or `user`, the actor as `requested_by_user_id`), written only when the title has no open intent yet; and the save
  intent (ADR-086) with `exclusion_confirmed_at = NULL`. When it commits, the title is saved. This replaces the
  Maintainerr-first ordering for a person's Save, on every surface.
- **D-2. The intent carries its enforcement state.** `trash_save_intents.exclusion_confirmed_at` is when Maintainerr
  was last read back holding the exclusion on `maintainerr_media_id`; NULL means recorded and not yet applied.
  `apply_attempts`, `last_apply_attempt_at` and `last_apply_error` count failures since the last confirmation. Every
  existing intent was opened after its exclusion was written, so migration 0088 stamps them confirmed.
- **D-3. Enforce now, briefly; the keeper finishes it.** After the commit the Save asks Maintainerr for the global
  exclusion (written, then read back) and pulls the poster out of the Leaving-Soon collection, all within
  `SAVE_ENFORCE_DEADLINE_MS` (8 s), and then answers success either way (`exclusion: 'applied' | 'pending'` on the
  result). Nothing new is sent after the deadline passes. The **save keeper** (`keepTrashSaves`) runs on the
  incremental sync's 15-minute tick, after the candidate refresh, and applies every pending intent, oldest first,
  on the key the title has in a Trash pool now (else the key it was saved on). A call that misses its 20 s budget
  means Maintainerr is busy: the keeper stops that stage for the tick. A Maintainerr error on one title is recorded
  on its intent and the stage moves on. An intent revoked while its exclusion was being written gets the exclusion
  taken back off.
- **D-4. The app's record is authoritative protection.** `TrashPendingItem.saveIntent` (an open intent for the
  title) is the guardian's first keep, reason `saved`, ahead of the tag, the watch guardian and the watchlist. So
  the sweep keeps such a row (`keep_reason 'saved'`), Expedite (one item or all) counts it protected, and the
  previews show it (`ExpediteVerdict 'protected_saved'`, mirrored in the client's `previewGuardian`). Both deletion
  paths also re-read the intent at the last moment: the sweep's guarded claim requires no open intent in the same
  statement, and Expedite checks it just before each delete. None of this waits on Maintainerr.
- **D-5. Lost exclusions are put back, on any key.** The keeper's second stage is ADR-086's reconciler without the
  same-key carve-out: a saved title (confirmed intent) back in a Trash pool without a live exclusion gets it
  re-applied, `reason: 'relink'` under a new key, `reason: 'reapply'` under the same one. ADR-086 D-4 kept its hands
  off the same-key case to avoid fighting a person who removed the exclusion in Maintainerr's own UI; the owner's
  requirement makes the app's un-save the release, so that carve-out is superseded. The kill switch
  (`trash_relink_enabled`) still governs this stage only; it never gates a fresh Save's first application, and no
  deletion path depends on it (D-4).
- **D-6. Leaving Soon is tidied.** The keeper's third stage removes, from every open Leaving-Soon collection, the
  members whose batch row is `saved` or whose title has an open intent. It never adds a member.
- **D-7. A Save outlives its batch.** Batch creation leaves out every title with an open intent, targeted or not,
  whether or not Maintainerr still pools it. A saved title never re-enters a later batch.
- **D-8. Un-save is unchanged and removes both.** The explicit two-step release removes the live exclusion and
  revokes the intent (ADR-086 D-3 already revokes when no exclusion is left, which covers a Save still pending).
  A revoked intent is never applied or re-applied.
- **D-9. System protections keep the old order, and stay out of the intent table.** The watch guardian's
  auto-protection (inside a destructive flow that must protect before it deletes), the keeper's own writes, a scoped
  exclusion, and a Save on a title with no ledger identity (unknown to the ledger, or not Radarr/Sonarr) still write
  Maintainerr first. A `watch_guardian` exclusion no longer opens a save intent: it used to open a `user` intent,
  against ADR-086 D-10, which D-4 would now make permanent. (Zero such exclusions exist.) A title with no ledger
  identity cannot be deleted by any app path either, because the guardian keeps what it cannot evaluate.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a Save made while Maintainerr runs its rules, or while it is down, is saved; the tap answers within about 8 s instead of failing at 30 s. |
| C-02 | Good: the sweep, Expedite and batch creation read the app's own record, so a saved title cannot be deleted or proposed again whatever Maintainerr's state, including the re-key prune ADR-086 found. |
| C-03 | Good: an exclusion Maintainerr loses is re-applied within one keeper tick of the title reappearing in a pool, and audited (`relink` / `reapply`). |
| C-04 | Neutral: between the Save and the keeper's tick (at most about 15 minutes, longer if Maintainerr stays busy) the title can still sit in Maintainerr's pool and in the Plex "Leaving Soon" collection. Nothing deletes it in that time (D-4), and the walls show it saved. |
| C-05 | Bad: a person who removes an exclusion in Maintainerr's own UI is overridden at the next tick. The app's un-save is the release now; this is the owner's requirement, recorded here so it is not mistaken for a bug. |
| C-06 | Neutral: the `trash_excluded` save row now records the Save (the decision and who made it) rather than a completed Maintainerr write; whether Maintainerr holds the exclusion is `exclusion_confirmed_at`. |
| C-07 | Ops: the incremental run logs `trash save keeper` whenever a Save is pending (pending, applied, still pending, busy, samples). A Save that stays pending across many ticks shows its `apply_attempts` and `last_apply_error` on the intent row. |

## More information

- The incident, timeline and the wall half of the fix: [ADR-096](096-trash-walls-show-only-confirmed-saves.md),
  issue #642. The lost Save was replayed through the deployed domain writer on 2026-10-03 (recorded in #642's PR).
- Design: [DESIGN-010](../designs/010-trash-and-maintainerr.md) D-05 amendment 2026-10-03,
  [DESIGN-011](../designs/011-trash-curation-pipeline.md) D-04, D-05 and D-07 amendments 2026-10-03,
  [DESIGN-048](../designs/048-durable-trash-save-intent.md) amendment 2026-10-03.
- Glossary: amends **T-70** Exclusion / Whitelist / Save, **T-241** Save Intent and **T-242** Relink; adds
  **T-277** Save Keeper.
- Code: `packages/domain/src/trash-save-enforcement.ts` (the deadline and the apply), `trash-save-keeper.ts` (the
  keeper), `trash-flow.ts` (`saveExclusion` record-first path, `classifyGuardian`), `trash-batches.ts`
  (`setBatchItemSaved` record-first branch, batch creation, the sweep's claim, `tidySavedFromLeavingSoon`),
  migration `0088_trash_save_record_first.sql`.
