# PLAN-032: List-driven book/audiobook/comic automation — "Kometa/Spotify-lists for books"

- **Status:** Intake (owner 2026-07-11, spitball — needs scoping session). NOT dispatched.
- **Owner vision:** the same pattern as Spotify playlists → Lidarr and Kometa charts → Radarr/
  Sonarr, but for the book layer: curated/external lists drive what gets wanted + grabbed
  automatically, instead of one-at-a-time manual adds.
- **Relates:** PLAN-031 (MAM gives the grab depth this needs), PLAN-023 stack (LazyLibrarian =
  the *arr here; Kapowarr for comics), PLAN-033 (user requests feed the same wanted pipeline),
  PLAN-029 collections (a list that becomes a logical collection is the natural join).

## Raw material (recon before scoping)

- **LazyLibrarian native automation:** author-follow (auto-want new releases by followed
  authors), series completion (want the rest of a series you have book 1 of), Goodreads/
  OpenLibrary sync surfaces — inventory what our deployed LL build actually supports reliably
  (its OpenLibrary metadata bug already bit us once — PLAN-023).
- **List sources to evaluate:** Goodreads shelves/lists (owner account?), NYT/bestseller
  charts, Amazon charts, StoryGraph, Hardcover.app API, award lists (Hugo/Nebula/Booker),
  Kavita reading lists as a SOURCE (owner curates in-app → list drives acquisition).
- **Comics:** Kapowarr has no list ecosystem — likely "complete the volumes of series I have"
  (its own feature) + manual; scope honestly.

## Open questions (owner)

- **Q-01:** which list sources first? (Goodreads is the obvious Kometa-analog; does the owner
  have/want a Goodreads or Hardcover account as the curation home, or should curation live
  IN-APP — a wanted-list UI — with external charts as optional extras?)
- **Q-02:** where does the sync logic live — LL's native features where they work, vs a small
  `@hnet/sync` mode (list → LL wanted-API) like the Kometa pattern, vs waiting for the
  PLAN-025-style service question to settle?
- **Q-03:** auto-grab or propose-only? (Kometa-analog = auto; trash-policy-analog = draft for
  approval. MAM ratio/unsatisfied caps argue for a throttled queue either way — compliance
  contract in `2026-07-11-mam-rules-scrape.md`.)
- **Q-04:** audiobook/ebook pairing — when a list names a book, want ebook, audiobook, or both?
- **Q-05:** does list membership surface in the Library UI (chart badge / "why is this here",
  like Kometa collections do in Plex) — ties into PLAN-029 collections?

## Out of scope until scoped

Everything. No LL config changes, no new sync modes.
