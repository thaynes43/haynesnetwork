# ADR-061: Ticket media precision — a LOCATOR on the ticket, not a new id space

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Tom Haynes (owner rulings Q-01..Q-03 locked 2026-07-11, PLAN-038; build slot owner-directed 2026-07-15)

## Context and problem statement

Tickets link a whole `media_items` title (ADR-050); the owner wants them to point at the exact
episode/track when that's what needs attention ("we rely on human prose to identify the item"),
while whole-show/season tickets stay first-class. TV/Music/Peloton/YouTube each reach the
individual item differently (PLAN-030 `ledger.children` for *arr children; ADR-041 ratingKeys for
live-Plex; books have no `media_items` row at all). The observed symptom: "Rick and Morty S1"
finds nothing because search is title-level only.

## Decision drivers

- Q-02 (owner): EVERY level of ANY hierarchy is a valid ticket subject; leaf art inherits the
  nearest parent when absent. Q-01: category-aware nudging (playback-class categories push to a
  leaf; Missing keeps whole-scope natural). Q-03: no retrofit — existing tickets are seed data.
- The ticket must stay renderable YEARS later without a live *arr read (children move/renumber).
- Don't mint a second media-id space; don't parse "S1" out of query text (plan v1 rule).

## Considered options

1. **A LOCATOR on `tickets`** — nullable columns (`target_kind`, `target_child_id`,
   `target_season`, `target_episode`, `target_label`) qualifying the existing `media_item_id`.
2. A `ticket_targets` join table to a new normalized child-entity table.
3. Free-text required fields per category (the pre-ruling strawman).

## Decision outcome

Chosen option: **1 — the locator** (the `fix_requests` grain precedent): one ticket targets one
place; the columns are nullable so a bare title link stays exactly what it is today.

- **C-01** `target_kind` ∈ `season | episode | album | track` (text+CHECK; NULL = the whole
  title). `target_child_id` = the *arr child id (sonarr episodeId / lidarr albumId / trackId);
  `target_season`/`target_episode` carry the human numbers; **`target_label` snapshots the
  display label** ("S06E02 · Rich") at file time — the detail page never needs a live child read.
- **C-02** **Leaf-or-scope is REQUIRED for hierarchical kinds** (sonarr/lidarr): the filer picks
  a leaf OR an explicit scope chip ("Entire show" / "Season N" / "Entire artist" / "Album");
  submit blocks on an accidental default. Movies (radarr) stay 1:1 as today. Q-01 nudging is
  presentation (which drill opens expanded), never a validation difference.
- **C-03** Art inheritance (Q-02): episode tiles use the PLAN-030 Plex episode-still when
  available, else the parent poster; album/track tiles use the parent poster (tracks have no art).
- **C-04** **ytdlsub + books linking is DEFERRED** — they need identity paths (`media_items` has
  no row for either; ADR-041 ratingKeys / `books_items` ids are foreign id spaces). The locator
  columns deliberately leave room (`target_kind` is text+CHECK — extendable); a `Q-04` saga item
  records it. v1 ships the *arr kinds where the pain was observed.
- **C-05** Q-03: migration 0051 **deletes all existing tickets** (owner-ruled seed data;
  replies/events cascade). No interim dual-render code.
- **C-06** Bad: `target_label` can go stale if the *arr renames an episode — accepted (it names
  what the filer saw, which is the point of a ticket).
- **C-07** New `@hnet/arr` read surface: lidarr `listTracks(albumId)` (track drill — Q-02 ruled
  track-level music; today's deepest read is albums).

## More information

PRD R-199..R-201. DESIGN-032 (the vertical). PLAN-038 (rulings verbatim). PLAN-030
`ledger.children` / `listMediaChildren` (the TV path this extends), ADR-047 (every child read
stays behind the access gate), ADR-015 (the drill expands IN PLACE — the deliberate-expansion
exception), ADR-058 (ticket wall card anatomy unchanged — the locator renders in the existing
caption/badge slots).
