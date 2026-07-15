# DESIGN-032: Ticket media precision — the compose drill + the ticket locator

- **Status:** Draft
- **Last updated:** 2026-07-15
- **Satisfies:** PRD-001 R-199, R-200, R-201; governed by ADR-061 (locator), ADR-050 (tickets),
  ADR-047 (access gate), ADR-015 (reflow), ADR-058 (cards).

## Overview

The compose linker keeps its title-first search; picking a HIERARCHICAL title (sonarr/lidarr)
opens an in-place drill (ADR-015's deliberate-expansion exception): TV → season list → episode
list; Music → album list → track list. The filer must end on a leaf OR an explicit scope chip
(ADR-061 C-02). The chosen target persists as the ticket LOCATOR (nullable columns on `tickets`)
with a snapshotted `target_label`; detail + wall render the label in the existing card anatomy,
with Q-02 art inheritance (episode still where available, else parent poster).

## Detailed design

### D-01 — Schema (migration 0051)

`tickets` grows: `target_kind` text CHECK (`season|episode|album|track`, NULL = whole title),
`target_child_id` integer (sonarr episodeId / lidarr albumId / lidarr trackId), `target_season`
integer, `target_episode` integer, `target_label` text. All nullable; no index (ticket volume is
household-scale). **Q-03: the migration DELETES existing tickets** (seed data; replies/events
cascade). Consistency is enforced in the domain (D-03), not by CHECK gymnastics.

### D-02 — Reads (the drill sources)

- TV: existing `ledger.children` (PLAN-030) — episodes with `seasonNumber`/`episodeNumber`;
  the UI groups by season. Season scope needs no read beyond the grouping.
- Music: `ledger.children` (albums) + NEW `ledger.albumTracks({ mediaItemId, albumId })` →
  domain `listAlbumTracks` → NEW `@hnet/arr` lidarr `listTracks(albumId)` (GET `/api/v1/track?
  albumId=`), returning `{ trackId, trackNumber, title, hasFile }`, label `"05 · <title>"`.
  Same ADR-047 gate as `children` (`itemAccessById`).
- Movies: no drill (1:1 today). ytdlsub/books: deferred (ADR-061 C-04, Q-04).

### D-03 — Writes

`CreateTicketInput` gains `target?: { kind, childId?, season?, episode?, label }`.
`createTicket` validates: `target.kind` legal for the item's `arr_kind` (episode/season ⇔ sonarr,
album/track ⇔ lidarr), and requires `mediaItemId` when `target` is present; inserts the locator
columns. `communication.tickets.create` mirrors the shape (zod). The R-195/R-196 email payloads
gain `targetLabel` (rendered after the media title when present).

### D-04 — Compose UI (`bulletin-client.tsx`)

`MediaPick` grows the target. After picking a sonarr/lidarr title the picker chip row gains the
SCOPE CHIPS: `Entire show|artist` · `Season…|Album…` · `Episode…|Track…` (single-select pills —
constant-width, recolor-only). Q-01: for `playback|audio|subtitles|quality` the drill renders
OPEN at the deepest list; for `missing|other` it renders with "Entire …" preselected — the SAME
choices, different default focus; NO category changes validation. Drill lists are in-place
scrollable panels below the chip row (`max-height` + `overflow-y:auto` — the modal never grows;
ADR-015). Submit disables until a hierarchical pick has an explicit scope/leaf
(`ticket-create` button title explains why). Testids: `composer-scope-<kind>`,
`composer-drill-season-<n>`, `composer-drill-episode-<id>`, `composer-drill-album-<id>`,
`composer-drill-track-<id>`.

### D-05 — Render

Detail head: `target_label` renders under the media title (muted line, e.g. "S06E02 · Rich");
episode targets try `ledger.plexEpisodeArt` for the still, else the existing `MediaPoster`
(parent art — Q-02). Wall `TicketWallCard`: the label joins the existing caption row (no new
anatomy — ADR-058; the card gallery gains a locator-variant entry). The library deep link stays
title-level (`/library/<id>`), unchanged in v1.

### D-06 — Tests

Domain: locator validation matrix (legal/illegal kind pairs), create persists + email payload
label. API: create/list/detail roundtrip with locator; `albumTracks` gate (FORBIDDEN off-gate).
arr: `listTracks` client parse. e2e (advisory): admin files an episode-precise ticket via the
drill (search show → season → episode → create → detail shows the label), plus the blocked-submit
leaf-or-scope assertion. Migration: columns + CHECK + the Q-03 delete.

## Alternatives considered

Join-table target entity (over-normalized for one target per ticket); free-text disambiguators
(pre-ruling strawman, rejected by Q-01/Q-02); query-text season parsing (explicitly out of scope).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-04 | ytdlsub (ratingKey) + books (`books_items`) ticket identity paths | DEFERRED to the saga (ADR-061 C-04) — the locator leaves room. |
