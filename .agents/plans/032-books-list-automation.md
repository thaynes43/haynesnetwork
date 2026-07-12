# PLAN-032: List-driven book/audiobook/comic automation — "Kometa/Spotify-lists for books"

- **Status:** **ESCALATED TO THE BOOKS AUTOMATION SAGA (owner ruling 2026-07-11 late-eve)** —
  research done (#221 + the "Proposed v1 shape" below), but the ARCHITECTURE outgrew a quick
  ratify: the owner leans to a **separate application** ("a clean split between front and back
  end, then an API between it and the UI for config and monitoring") — the same *arr-shaped-
  service instinct as PLAN-025 Q-01. To be "baked out in a Saga later"; explicitly NOT tonight
  (budget). **Late rulings that reshape v1:**
  - The owner has **NO Goodreads or Hardcover account** and doesn't want an external curation
    home — the research's Track-1 (LL-native feeds) is **moot for v1**; Track-2's concepts
    (official APIs, ISBN-keyed adds, quality floor, **retry/backoff around Google Books** — the
    Q-06 root cause found live 2026-07-11: GB serves intermittent 503 "backendFailed" bursts
    and LL's json_request fetches once with no retry, so a burst reads as "book not found")
    feed the saga design.
  - **Goal restated (owner verbatim-in-intent):** "lists that update on their own and drive all
    three — EBooks, Audiobooks, and Comics. Think about how my TV/Movies flow in — most things
    people want are there because of Kometa and Lidarr lists… We need to fill that gap." Lists
    are the CONTENT DRIVER; requests (the 033 survey) are the human overlay.
  - **Comics mandate:** no list ecosystem exists (ComicVine is metadata-only) — the saga must
    hunt for any pollable comics popularity source or design curated-seed lists honestly.
- Original scoping rulings (2026-07-11 eve), kept for the record:
  - **Goal restated:** keep MAM seeding strong but pull content **through SABnzbd/usenet as fast
    as possible** to fill the book/comic/ebook library; lists exist to find *quality* content
    ("top rated of all time", "popular now", NYT) — not junk.
  - **Q-01 sources:** NYT bestsellers + Goodreads lists/shelves + Amazon charts + in-app/Kavita
    curation ALL in scope, **plus a research mandate: find the best free-to-poll list APIs**
    (note: the official Goodreads API was retired in 2020 — LL scrapes Listopia; verify what
    still works).
  - **Q-02 leaning:** if LazyLibrarian's native list providers work reliably, "we are just
    feeding into that" — prefer LL-native over building a sync mode; research must inventory
    what our deployed LL build actually supports.
  - **Q-03 RULED: auto-grab + the PLAN-039 governor** (usenet takes the bulk now that provider
    priority is actually usenet-first — see OPS-013 correction 2026-07-11; the governor gates
    MAM fallback at the unsatisfied cap).
  - **PLAN-033 (requests) is PARKED** (owner: too large for now; evaluate existing solutions
    before any in-app build) — 032 does NOT depend on it.
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

## Proposed v1 shape (research outcome — owner review pending)

Full findings + source matrix + citations: `.agents/context/2026-07-11-books-list-sources-research.md`
(read-only recon of the live LazyLibrarian pod + web research; **no config changed, no grab
triggered, MAM untouched**).

### What the research established (headlines)

- **LL already has a native list engine.** A "wishlist" is just an RSS provider whose URL matches
  a pattern; `search_wishlist()` (every 2 h) marks each item **Wanted** (ebook and/or audiobook
  per a per-list `DLTYPES` flag), stamps the book's `Requester` column with the list name
  (provenance), and feeds LL's **normal search** — so list wants **inherit usenet-first
  `dlpriority` + the PLAN-039 governor automatically** (verified in the pod, not assumed).
- **But LL's NYT / Amazon / B&N / Listopia / Publishers-Weekly providers are HTML scrapers**, and
  its **Book Depository** provider scrapes a site that closed in 2023. Only **Goodreads shelf
  RSS**, **Hardcover reading-list sync** (native `hc.py` GraphQL), and **MAM wishlist** are
  robust (RSS/API-backed).
- **The best official free chart source is the NYT Books API** — free key, 1,000/day, returns
  **rank + author + title + ISBN10/13** and has dedicated **Audio Fiction/Nonfiction** lists.
  LL's own NYT provider *ignores* the API and scrapes the page (worse + fragile). Google Books
  (key already in 1P + in LL) and Open Library are free **rating/vote-count** sources for a
  numeric quality floor; **StoryGraph, Audible, and comics have no usable official list API**.
- **Metadata-path caveat (blocking):** the add-book resolver (`import_book`/`search_for`) that
  *every* route depends on is the one PLAN-023 saw broken under OpenLibrary. It is now switched to
  `BOOK_API=GoogleBooks` with a key present in config, **but unproven for the list flow** (a
  residual `NoneType` import error is in the log from before the key was set; no list has run
  since). Must be closed by a supervised test before any bulk list.

### Recommended architecture — HYBRID (two tracks)

- **Track 1 — LL-native, config-only, ship first.** Wire `[RSS_*]` wishlist providers for the
  *robust* sources only: an owner-curated **Goodreads "want" shelf** (RSS) and/or a **Hardcover
  list** (`hc_sync`), optionally the MAM wishlist. Free bonus levers: **author-follow**
  (`NEWBOOK_STATUS=Wanted` for followed authors) + **series-completion** (`ADD_SERIES`). Do **not**
  wire LL's fragile NYT/Amazon/Listopia scrapers.
- **Track 2 — a small `@hnet/sync` "list mode" (the durable Kometa-analog).** Poll the **official
  NYT Books API** (+ optional Google Books/Open Library rating floor), then push **ISBNs** into LL
  via its documented `addbookbyisbn` API (`api.py`), and record what was added (source/rank/ISBN/
  result) to the app's sync/ledger surface + Pushover. This replaces LL's fragile NYT scraper with
  a robust official-API path and gives the observability Track 1 lacks. Its own ADR→DESIGN→plan
  cycle.
- **Comics:** no list ecosystem exists (ComicVine = metadata only). Use **Kapowarr
  volume-completion** + manual; scope comics **out** of list-automation v1.

### First sources to wire (in order)

1. **Goodreads "want" shelf via RSS** (Track 1) — owner-curation home, LL-native, robust, ships
   tonight (post Q-06 test). Cap: last 100 items (Q-07).
2. **NYT Books API** (Track 2) — marquee official chart, ISBN-keyed, audio-capable; the backbone.
3. **Hardcover list** (Track 1, native `hc_sync`) — if the owner prefers Hardcover as the curation
   home over Goodreads (richer, needs a token).

### Open owner decisions (reusing this plan's Q-ids)

- **Q-01 (sources first):** RECOMMEND NYT Books API (Track 2) + one owner-curation home — **owner
  to pick Goodreads shelf vs Hardcover list**. Amazon/B&N/Listopia deferred (fragile scrapers).
- **Q-02 (where logic lives):** RECOMMEND **hybrid** — LL-native for robust RSS/API feeds, a
  `@hnet/sync` list mode for the NYT official API + quality floor + observability.
- **Q-03 (auto-grab):** RULED auto-grab + PLAN-039 governor; confirmed compatible. Add a first-run
  **batch cap** until Q-06 clears.
- **Q-04 (ebook / audio / both):** LL controls this **per-list** via `DLTYPES`. RECOMMEND charts
  **default ebook-only**; opt audiobooks in per-list (NYT Audio lists → audio). **Owner to confirm
  the default + which lists get audio.** (Wanting both for every item ~doubles grabs + MAM
  pressure.)
- **Q-05 (surface in Library UI):** `Requester` provenance already exists in LL; a chart badge /
  "why is this here" ties into **PLAN-029 collections** — defer there.
- **Q-06 (NEW — metadata-path proof, BLOCKING):** run one supervised single-list/ISBN test and
  confirm clean `import_book` + Wanted + grab with no `NoneType`/OpenLibrary errors before any bulk
  list; if it still errors, pin a newer LL build.
- **Q-07 (NEW — Goodreads RSS 100-item cap):** fine for a curated shelf; larger Goodreads lists
  must come via Track 2 (paginated) or Hardcover, not shelf RSS.
