# ADR-088: Watch history read-model — Plex progress plus the Tautulli event log, explicit Watch Marks, and a Plex write-back for "I already watched it"

- **Status:** Accepted (2026-09-23 — live as haynesnetwork v0.97.0: the `watch` sync, Title States, Watch Marks with the Plex write-back and undo, verified against the owner's servers)
- **Date:** 2026-09-23
- **Deciders:** Tom Haynes (owner request 2026-09-23; **owner ruling 2026-09-23**, asked on his phone:
  *"When you tell the Movie Room agent 'I already watched X', should it also mark X as watched in
  Plex?"* → **"Mark it in Plex too"**) · drafted by Opus 5.5
- **Relates:** ADR-053 (per-title, per-user watch state for the wall facets — left as is), ADR-029
  (the Server Owner), ADR-017 (the import-confined `@hnet/plex/write` surface, extended here),
  ADR-068 (the three-Tautulli env contract), ADR-087 (the MCP surface that serves this model),
  ADR-089 (recommendations built on it). Realized by DESIGN-049; built by PLAN-068.
  PRD-001 R-240..R-243.

## Context and problem statement

The Movie Room agent must answer *"what series haven't I finished?"* at episode grain, know what the
owner has ever watched so recommendations never repeat it, and accept corrections (*"I already
watched X"*). Nothing in the app can do that today. Live survey, 2026-09-23:

1. **The existing per-user model is per title and empty.** ADR-053's `user_media_watch` marks a
   series watched when any one episode is, covers only *arr-ledger titles, and has 0 rows in
   production because `ensurePlexUserIdMapping` has no caller (tracked separately, see More
   information).
2. **Nothing is stored per episode**, and the household Tautulli harvest re-reads at most the newest
   10,000 rows per instance. HaynesTower holds 45,037 rows since 2023-09-18, so everything before
   2026-03-28 is invisible to it.
3. **One account, three servers, sync on.** All three servers are owned by the owner's Plex account
   (manofoz, id 12874060), so the owner tokens read his own watch state. plex.tv view-state sync is
   enabled for the account: 940 of 944 shows present on both HaynesOps and HaynesTower agree, and
   shows watched only on HaynesOps read as watched on HaynesTower. Not synced: resume points,
   show-level `lastViewedAt`, and unmatched `local://` items (Hazbin Hotel is 16/16 on HaynesTower,
   0/16 on HaynesOps).
4. **Plex flags are current progress, not history.** Rick and Morty reads 28/106 in Plex although
   Tautulli records every episode of seasons 1–8; the show was reset for a rewatch. Maintainerr also
   deletes watched media, so rating keys go stale and Tautulli's `get_metadata` answers HTTP 400 for
   deleted items. The Tautulli row `guid` (`plex://episode/…`) is identical across servers.
5. **Noise.** Specials inflate `leafCount` (The Expanse is complete at 62 of 69 once season 0 is
   excluded). The owner account also carries the children's viewing (Bluey, Paw Patrol, Bubble
   Guppies) and one-episode tasters (Big Brother 1 of 1,012).
6. **History depth.** The owner's plays: HaynesTower 2023-09-18 → 2026-09-05 (1,329 episodes, 561
   movies), HaynesOps since 2026-07-04 when viewing moved there, HaynesKube music only.

## Decision drivers

- Episode-grain progress, correct across servers and rewatches.
- "Ever watched" must be complete and cheap to maintain: no row cap, no full re-reads.
- A correction must be explicit, attributable, reversible, and (by owner ruling) reach Plex.
- Voice reads come from Postgres in milliseconds; freshness is kept by sync, live revalidation of the
  answer, and write-through.
- Never damage the children's progress on the shared owner account.

## Considered options

1. **Widen ADR-053's `user_media_watch` to episode grain.** Rejected: it is keyed by app user and by
   ledger item, so titles no *arr manages vanish, and its per-title rows back the wall facets, which
   must not change shape.
2. **Answer live from Plex on every tool call.** Rejected: the owner has about 90 started shows; one
   `allLeaves` read each is seconds, beyond the voice budget.
3. **Tautulli events only.** Rejected: misses manual marks and anything watched before 2023-09, and
   cannot express a rewatch reset.
4. **Plex state only.** Rejected: flags reset on rewatch and disappear with deleted media, so
   recommendations would repeat watched titles.
5. **Plex current progress + the complete Tautulli event log + explicit Watch Marks** (chosen).

For the write-back: **ledger-only marks** were offered and declined by the owner; **writing every
server** is unnecessary under view-state sync and is kept only for unmatched items.

## Decision outcome

Chosen option: **5**, in BC-06 Watch Companion.

- **Watch Event log** (`watch_events`). Every Tautulli history row for a tracked account (v1: the
  Server Owner) on all three instances, ingested incrementally by `(instance, Tautulli row id)`,
  never capped and never re-read. Each event carries the item guid, the show's guid (resolved once
  per show key; a 400 falls back to the show title), season and episode numbers, percent complete,
  and Tautulli's own watched verdict (85% on all three instances).
- **Title State snapshot** (`watch_titles`). One row per (account, title), a title being a show or a
  movie identified by Plex guid plus tmdb/tvdb/imdb ids. For a show it holds the per-episode watched
  map from the owner's Plex state, united across the servers that hold the show, with specials
  excluded; from it come the aired-in-library count, the watched count, the next episode and the
  last-watched time. For a movie it holds watched and the resume percentage. The `watch` sync mode
  refreshes it every 15 minutes and re-reads only shows whose counts moved; a tool answer
  re-validates its own titles live within 400 ms; every mark writes through.
- **Semantics.** *Current progress* is Plex. *Ever watched* is Plex ∪ events ∪ `watched` marks,
  minus `not_mine` marks. A show is `in_progress`, `stalled` (untouched for 90 days), `caught_up`
  (nothing unwatched after the furthest watched episode, still running) or `finished`. Tasters and
  children's titles stay out of the owner's lists unless asked for. A show whose event history runs
  past its current Plex progress is flagged as a rewatch.
- **Watch Marks** (`watch_marks`). The owner's explicit statements: `watched` (a show, a season, an
  episode, everything up to an episode, or a movie), `not_interested` and `not_mine`. Each row keeps
  the before-state, meaning the exact Plex keys it flipped, so undo reverses precisely that. One
  single-writer in `@hnet/domain`; the mark rows are the audit trail.
- **Plex write-back (owner ruling).** A `watched` mark scrobbles the title on the preferred server
  that holds it (HaynesOps, else HaynesTower) and lets view-state sync carry it to the others;
  unmatched `local://` titles are written on every server that holds them. `@hnet/plex/write` gains
  `scrobble`/`unscrobble` and stays import-confined to `packages/domain` + `packages/plex` (ADR-017
  C-10). `not_interested` and `not_mine` **never write to Plex**: the children watch on the owner
  account, and un-marking would erase their progress.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: "unfinished" is answered at episode grain, specials excluded, across servers, with the next episode named. |
| C-02 | Good: the event log is complete back to each Tautulli's first row and grows incrementally; the 10k window no longer limits this model. |
| C-03 | Good: every correction is an explicit, attributed, reversible row; Plex is written only by an owner-issued `watched` mark. |
| C-04 | Risk/mitigated: a wrong title match would mark the wrong show in Plex. Mitigations: an ambiguous match asks instead of writing; every write reads back title and year; undo restores exactly the flipped keys. Plex's unscrobble clears resume points, so a partially watched episode comes back unwatched from the start. |
| C-05 | Neutral: freshness is 15 minutes, tightened by live revalidation of each answer and by write-through. |
| C-06 | Deferred: household persons (PRD Q-12). The model is keyed by Plex account id, so adding Kellie, Penelope or Jackson is data plus a person parameter, not a schema change. Managed users' Plex progress needs their own tokens, so they would start from the event log alone. |
| C-07 | Cost: four new tables on the `no-direct-state-writes` guard list, one sync mode and CronJob, and a bounded number of Plex reads per run. |
| C-08 | Neutral: ADR-053's `user_media_watch` and the household harvest are unchanged. Wiring ADR-053's map and lifting the household harvest's 10k window are separate fixes with their own risk (the Trash walls read the household numbers). |

## More information

- DESIGN-049 D-07..D-15 (tables, sync, semantics, marks, write-back); OPS-015.
- Evidence: the 2026-09-23 surveys summarized in PLAN-068 ("Evidence").
- Plex endpoints: `/:/scrobble` and `/:/unscrobble` with `identifier=com.plexapp.plugins.library`;
  `/library/metadata/<key>/allLeaves`; section `all?type=2&includeGuids=1`.
