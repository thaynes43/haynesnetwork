# PLAN-038: Helpdesk ticket media precision — link tickets to the exact episode/file

- **Status:** Completed — shipped v0.60.0 (2026-07-15, #297; ADR-061 / DESIGN-032 / migration
  0051). The locator (nullable target_* + snapshotted label) + the compose leaf-or-scope drill
  (TV season→episode via ledger.children; music album→track via NEW lidarr listTracks +
  ledger.albumTracks, ADR-047-gated). Q-01 nudge = default focus only; Q-02 art inheritance;
  Q-03 executed (migration deleted the pre-locator tickets). ytdlsub/books targets deferred
  (DESIGN-032 Q-04). e2e drill journey green; LIVE-VALIDATED in prod (locator ticket c2a20a02,
  "safe to close"). Was: Intake (owner 2026-07-11).
- **Owner problem statement (verbatim-in-intent):** tickets should be able to point at the
  exact media item that needs attention — ideally 1:1 with files (an episode, a track) — not
  just the top-level title; otherwise we rely on human prose to identify the item. When the
  linked selection is NOT 1:1 with files (a show), either drill deeper or require the
  disambiguating fields. **Top-level tickets stay supported** (a whole show/season is a valid
  subject). Non-trivial because Peloton / YouTube / TV / Music each reach the individual item
  by a different path. Observed symptom: searching "Rick and Morty S1" in the linker returns
  "No matches" — the linked-title search only matches title-level items.
- **Relates:** PLAN-034/ADR-050 (the ticket domain + linked-title model this extends),
  PLAN-030 (`ledger.children` seasons/episodes + `episodeNumber` — the TV drill path),
  ADR-041/ADR-047 (ytdlsub detail/episodes reads + the per-item access gate — the
  Peloton/YouTube drill path; any child listing must respect the gate), ADR-051/DESIGN-026
  (the three-engine seam — the same per-kind asymmetry applies to ticket linking).

## Shape (coordinator sketch — pressure-test at scoping)

1. **Progressive drill-down in the compose linker:** search finds the TITLE (as today); if the
   kind is hierarchical, an inline drill appears — TV: season → episode; Music: album → track
   (verify ledger depth); Peloton/YouTube: season/duration → episode (live-Plex reads);
   Books/Audiobooks: already 1:1; Comics: series → volume/issue if Kavita exposes it.
2. **Leaf-or-scope rule instead of free-text requireds:** the filer either picks a leaf OR
   explicitly scopes the ticket ("entire show" / "entire season") — a deliberate choice chip,
   not an accidental default. That preserves top-level tickets while killing ambiguous ones.
3. **Media ref becomes a locator, not an id:** ticket rows store (kind, item id, optional
   child locator — season/episode numbers, album/track, ratingKey for ytdlsub) so the detail
   page can render the exact target (episode still/thumb where we have art) and staff can jump
   to it.
4. **Search stays title-first** ("Rick and Morty S1" → match the SHOW, then offer the S1 drill
   — don't try to parse season tokens out of query text in v1).

## Owner rulings (2026-07-11 — Q-01..Q-03 RESOLVED; scoped, awaiting build slot)

- **Q-01: CATEGORY-AWARE nudging.** Playback/Audio/Subtitles/Quality on a hierarchical title
  nudge hard toward a leaf; Missing keeps whole-show/season natural.
- **Q-02: TRACK-LEVEL music, with ART INHERITANCE + every-level ticketing as the UNIVERSAL
  paradigm:** any level of any hierarchy is a valid ticket subject (track/album/artist,
  episode/season/show, book/series, …). When the selected leaf has no art of its own (a song),
  the tile inherits the nearest parent's thumbnail (album → artist). Same rule everywhere.
- **Q-03: NO retrofit — delete the existing tickets at build time** (they're test/seed data;
  owner has no users yet). Any interim user tickets stay as high-level (show-level) links.

**Build slot:** after PLAN-031 MAM (owner priority order); picker UX is Fable-grade — post-reset.

## Out of scope

Free-text season/episode parsing in search; any new sync; Kavita per-issue drill if it needs
new client surface (check first, defer if so).
