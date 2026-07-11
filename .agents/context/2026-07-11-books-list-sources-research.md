# PLAN-032 — Book/audiobook/comic list sources: research + proposed v1 shape

- **Date:** 2026-07-11
- **Author:** research subagent (read-only cluster recon + web research). **No live config was
  changed; no grab was triggered; MyAnonaMouse was not touched in any way** (all MAM facts come
  from the existing research docs + public web sources, per the compliance contract in
  `2026-07-11-mam-rules-scrape.md`).
- **For:** `.agents/plans/032-books-list-automation.md` (owner rulings 2026-07-11: usenet-first
  via SABnzbd + MAM gap-fill, auto-grab gated by the PLAN-039 governor, sources = NYT + Goodreads
  + Amazon charts + in-app/Kavita curation + "find the best free-to-poll list APIs").
- **Normative basis / prior art:** OPS-013 (`docs/ops/013-mam-books-acquisition.md`),
  PLAN-023 as-built (`.agents/plans/completed/023-books-and-audiobooks.md` — the LL metadata-bug
  history), PLAN-039 (`.agents/plans/039-mam-compliance-governor.md`),
  `.agents/context/2026-07-10-books-stack-research.md`, `2026-07-10-book-trackers-research.md`.
- **Deployed build inspected (read-only):** `deploy/lazylibrarian` in ns `downloads`, image
  `docker.io/linuxserver/lazylibrarian:version-40a389ea`, source at
  `/app/lazylibrarian/lazylibrarian/`, config at `/config/config.ini`, log at
  `/config/log/lazylibrarian.log`.

---

## 0. TL;DR

- **LazyLibrarian already has a full native "wishlist" engine.** A wishlist is just an **RSS
  provider** whose HOST URL matches a known pattern; `search_wishlist()` runs every **2 h**,
  marks every list item **Wanted** (ebook and/or audiobook per a per-list `DLTYPES` flag) with a
  **`Requester = <list name>` attribution stamp**, then hands the wanted books to LL's **normal
  search** — which honours provider `dlpriority` (**usenet-first**) and therefore the PLAN-039
  governor **for free**. This is exactly the "if LL supports lists we just feed into that" the
  owner wants — for the sources LL fetches *robustly*.
- **But half of LL's list providers are brittle HTML scrapers** (NYT, Amazon, Barnes & Noble,
  Listopia, Publishers Weekly) and one (**Book Depository**) is scraping a site that **shut down
  in 2023**. Only **Goodreads shelf RSS**, **Hardcover reading-list sync** (native GraphQL,
  `hc.py`), and **MAM wishlist** are API/RSS-based and low-fragility.
- **The strongest *official, free* chart source is the NYT Books API** — it returns **rank +
  title + author + ISBN10/13** and has dedicated **Audio Fiction / Audio Nonfiction** lists.
  ISBN-keyed adds are far more reliable than LL's fuzzy title matching. LL's *own* NYT provider
  ignores the API and scrapes the web page instead.
- **Recommendation = hybrid** (details in §4): ship **LL-native now** for the robust feeds
  (Goodreads shelf RSS + Hardcover + MAM wishlist), and build a **small `@hnet/sync` "list mode"**
  that polls the **official NYT Books API** (+ optional Google Books/Hardcover rating enrichment
  for a quality floor) and pushes **ISBNs** into LL via its documented `addbookbyisbn` API — the
  durable Kometa-analog with app-side observability.
- **Honest blocker to flag (Q-06):** the metadata add-book path that *every* route depends on
  (`import_book`/`search_for`) is the one that was broken under OpenLibrary in this exact build.
  It is now switched to `BOOK_API = GoogleBooks` **with a key present in config**, but the fix is
  **configured-but-unproven for the list flow** — the log still shows a residual
  `'NoneType' object has no attribute 'get'` import error on 2026-07-10 (before the key was set),
  and no wishlist provider has ever run against the fixed config. A controlled owner-supervised
  single-list test must precede any bulk list.

---

## 1. Q1 — What our deployed LazyLibrarian build actually does with lists

### 1.1 The mechanism (verified in the pod)

A "wishlist" is **not a separate feature** — it is an ordinary **RSS provider** (config array
`RSS`, written as `[RSS_N]` sections) whose `HOST` URL is recognised by
`config2.py:wishlist_type(host)` (L727). The classifier is pure URL-substring matching
("*Quite fragile, take care*" — its own docstring):

| `wishlist_type` returns | Trigger substring in HOST | Provider fn in `providers.py` | Fetch method |
|---|---|---|---|
| `goodreads` | `goodreads` + `list_rss` | `goodreads()` L1840 | **RSS** (`feedparser`) — reads Goodreads shelf RSS |
| `listopia` | `goodreads` + `/list/show/` or `/book/` | `listopia()` L1674 | **HTML scrape** (`<td class="number">` split) |
| `amazon` | `amazon` + `/charts` | `amazon()` L1186 | **HTML scrape** (BeautifulSoup `kc-rank-card-*`) |
| `ny_times` | `nytimes` + `best-sellers` | `ny_times()` L1129 | **HTML scrape** (microdata `itemProp="…"`) |
| `publishersweekly` | `publishersweekly` + `/pw/` | `publishersweekly()` L1247 | **HTML scrape** |
| `apps.npr.org` | `apps.npr.org` + `/best-books/` | `appsnprorg()` L1303 | **HTML scrape** |
| `penguinrandomhouse` | `penguinrandomhouse` | `penguinrandomhouse()` L1372 | **AJAX/JSON scrape** |
| `barnesandnoble` | `barnesandnoble` | `barnesandnoble()` L1450 | **HTML scrape** |
| `bookdepository` | `bookdepository` | `bookdepository()` L1510 | **HTML scrape — site DEAD (closed Apr 2023)** |
| `indigo` | `indigo` (chapters.indigo.ca) | `indigo()` L1586 | **JSON API scrape** |
| `myanonamouse` | RSS `LABEL` contains `mam`+`wish` | `mam()` | MAM JSON (site feature; **out of scope for automation**) |
| `rss` / `GEN` | generic | `rss()` / generic | generic RSS / generic |

Per-list config fields (from `configdefs.py` `RSS` array, L639): `NAME`, `DISPNAME`, `ENABLED`,
`HOST` (the list URL), `DLPRIORITY`, `DLTYPES` (default **`'E'`** = ebook-only), `LABEL`.
**Gotcha:** for the paginated scrapers (listopia/goodreads/publishersweekly) `DLPRIORITY` is
**repurposed as "max pages to fetch"**, not a download priority — a confusing overload to
document if we configure these by hand.

### 1.2 What it DOES with each list item (verified: `searchrss.py:search_wishlist` L128)

1. `iterate_over_wishlists()` fetches every enabled wishlist provider → a flat list of
   `{rss_title, rss_author, rss_bookid?, rss_isbn?, types}` dicts. **No rating/votes metadata is
   carried** — only title/author (+ Goodreads book_id or ISBN when the source provides it).
2. For each item: derive `ebook_status`/`audio_status` = `Wanted`/`Skipped` **from the per-list
   `DLTYPES`** (`'E'`→ebook wanted, `'A'`→audio wanted, `'E,A'`→both).
3. Resolve the book: try DB match by author/title; else `add_author_name_to_db()` then
   `search_for(isbn or title)` **via `BOOK_API` (= Google Books)**; on a fuzzy match above
   `MATCH_RATIO`, `import_book(bookid, ebook_status, audio_status, reason="Added from wishlist …")`.
4. Mark the book **`Status = Wanted`** (and/or `AudioStatus = Wanted`) and **append the list's
   display name to the book's `Requester` / `AudioRequester` column** — this is a real, queryable
   **provenance stamp** ("why is this here" = which list added it).
5. Hand the newly-wanted books to the **normal search path** (`search_book`/`dl_books`), which is
   the *same* engine OPS-013 describes — so list-driven wants **inherit usenet-first `dlpriority`
   ordering and the PLAN-039 governor at the Prowlarr seam**. **Verified:** the wishlist code does
   not bypass provider selection; it just sets `Status='Wanted'` and calls the shared searcher.
   Cadence: `WISHLIST_INTERVAL = 2 h`; the job **self-stops when no wishlist providers are set**
   (which is the current state — see §1.4).

### 1.3 Quality levers beyond lists (author-follow + series completion)

Inventoried in `configdefs.py`:

- **Author-follow:** `ADD_AUTHOR` (on), `NEWAUTHOR_STATUS`/`NEWAUTHOR_AUDIO` (default `Skipped`),
  `NEWAUTHOR_BOOKS` (0), and `NEWBOOK_STATUS` (default `Skipped`) — set the last to `Wanted` and a
  followed author's *new* releases auto-become wanted. Native Goodreads-follow toggles exist too:
  `GR_FOLLOW` / `GR_FOLLOWNEW` (default off; depend on the retired Goodreads OAuth — treat as
  unreliable, see §2).
- **Series completion:** `ADD_SERIES` (on), `NEWSERIES_STATUS` (default `Paused`),
  `SERIESUPDATE_INTERVAL`, `NO_SINGLE_BOOK_SERIES`, `NO_NONINTEGER_SERIES`, `SERIES_TAB` — "own
  book 1, want the rest of the series" is supported; leave `NEWSERIES_STATUS=Paused` so it stages
  rather than floods, and promote deliberately.

These are the "no junk / complete what I care about" levers that pair well with charts: charts
seed breadth; author-follow + series-completion deepen the things the library already values.

### 1.4 Current live state (read-only observations)

- **Metadata source already switched:** `config.ini` has `book_api = GoogleBooks` **and** a
  populated `gb_api` key. So the PLAN-023 OpenLibrary metadata bug's documented fix
  ("set `BOOK_API=GoogleBooks` + a Google Books key") **is applied in config**.
- **No wishlist providers configured yet.** `config.ini` has only `[Newznab_0..3]` (usenet) +
  `[Torznab_0]` (MAM) + an inert `[Torznab_1]` stub — **no `[RSS_*]` sections**. List automation
  is greenfield config-wise; the `search_wishlist` job is currently self-stopped ("No wishlists
  are set").
- **Provider priority (live):** Newznab `dlpriority` 42/45/50/50; **MAM `[Torznab_0]` currently
  `dlpriority = 26`** — usenet still outranks MAM (26 < 42), so **usenet-first holds**. NOTE this
  differs from OPS-013 §5, which documents MAM at `dlpriority = 0`; the live value is 26. Not a
  problem (still below all usenet), but flag the doc drift.
- **Metadata-path health is UNPROVEN for the list flow (the important caveat).** The log's newest
  import attempt (2026-07-10 12:41, *before* the Google Books key was set at ~13:23 — the log
  literally records `WARNING: No GoogleBooks API key, check config [gb.py:692]`) still threw
  `AttributeError: 'NoneType' object has no attribute 'get'` in `manual_import.py`. No list has
  run against the now-fixed config. **Both** candidate architectures (native wishlist *and* a
  sync-mode `addbookbyisbn` push) funnel through the same `search_for`/`import_book` resolver, so
  this risk is architecture-independent and must be closed by a supervised test (Q-06).

---

## 2. Q2 — Free-to-poll external list sources (official APIs)

**Verdict up front:** the **NYT Books API** is the best official free chart source (rank + ISBN +
audio lists); **Hardcover** is the best *curated-list + rating* GraphQL source and is **already
natively supported by LL**; **Open Library** and **Google Books** are best as free *enrichment /
quality-floor* sources rather than as chart sources; **Goodreads** survives only as **shelf RSS**
(100-item cap) + **Listopia scraping**; **StoryGraph, Audible, and comics** have **no usable
official list API**.

| Source | Official API? | Free? | Auth | Rate limit | Gives a *ranked list*? | Quality metadata exposed | LL-native? | Verdict for us |
|---|---|---|---|---|---|---|---|---|
| **NYT Books API** | **Yes** (`/svc/books/v3/lists/*`) | **Yes** | free key | **1,000/day**, ~5/min (6 s between calls) | **Yes** — `names.json` catalog of ~50 lists; `current/{list}.json` returns `rank`, `title`, `author`, `isbn10/13` | rank + weeks-on-list (curation *is* the floor); **has Audio Fiction/Nonfiction lists** | No (LL *scrapes* the web page, ignoring the API) | **Wire first via sync-mode** — official, ISBN-keyed, audio-capable |
| **Hardcover.app** | **Yes** (GraphQL `v1/graphql`) | **Yes** (free tier) | user token (expires yearly, resets Jan 1) | **60/min**, 30 s query timeout | **Yes** — user Lists + book fields; trending via app | book `rating`, `ratings_count`, `users_count` | **Yes** — native `hc.py` reading-list sync (`hc_sync`, 48 h) | **Wire early via LL-native** if owner curates on Hardcover; also a rating-floor enrichment source |
| **Open Library** | **Yes** (Search + Subjects + `/trending/*`) | **Yes** | **none** (polite UA + cache) | soft; be considerate | **Trending** endpoint + subject lists | `ratings_average`, `ratings_count`, `readinglog_count`, `want_to_read_count` | No | **Enrichment / quality-floor + a free "trending" list**; no key = attractive |
| **Google Books** | Yes (`volumes`) | Yes | key (**already in 1Password + now in LL**) | ~**1,000/day** default (raisable) | **No** ("charts" is not exposed; search only) | **`averageRating`, `ratingsCount`** per volume | Used internally as `BOOK_API` metadata | **Quality-floor enrichment + the metadata resolver**, not a chart source |
| **Goodreads** | **Retired 2020** | — | — | — | **Shelf RSS** (`/review/list_rss/{uid}?shelf=…`, **last 100 only**) + **Listopia** (scrape) | none in RSS | **Yes** — `goodreads` (RSS) + `listopia` (scrape) providers | **Owner-curation home via shelf RSS** (LL-native, robust); Listopia = fragile extra |
| **StoryGraph** | **No public API** (roadmap "long-term") | — | — | — | No — only unofficial scrapers | (n/a) | No | **Skip** — no compliant polling path |
| **Audible / audiobook charts** | **No official public API** | — | — | — | Charts exist on-page only (scrape); **Amazon "Best Sellers: Audible" zgbs** is scrape-only | none | No | **Skip as a source** — use **NYT Audio lists** for audiobook popularity instead |
| **Amazon Charts** | **No API** (LL scrapes `/charts`) | — | — | — | On-page only, markup-fragile | none | Yes (scrape) | **Low priority** — fragile; NYT covers the same "popular now" need officially |
| **ComicVine** | Yes (metadata) | Yes | free key (**owner has one per PLAN-023 TODO**) | rate-limited (~200/resource/hr) | **No popularity/bestseller endpoint** — metadata only | none | Used by Kapowarr for volume metadata | **Not a list source** — comics have no list ecosystem (see §5/Q for comics) |

### 2.1 Notes that decide the picks

- **NYT is the marquee source and it is *not* what LL scrapes.** LL's `ny_times()` parses the
  HTML best-seller page and yields **title+author only** (no ISBN, no rank fidelity), so it's both
  fragile *and* lower-quality than the official API which hands us **ISBN10/13 + rank**. ISBN is
  the single best matching key for LL (`addbookbyisbn` exists — §4.2). NYT also has **Audio
  Fiction / Audio Nonfiction** lists → the only clean *official* audiobook-popularity signal we
  found (Audible has no API).
- **Hardcover is the modern Goodreads-API replacement** and, uniquely, **LL already speaks it**
  (`hc.py` is a real GraphQL client with reading-list sync, 55 req/min self-throttle). If the
  owner is willing to curate a Hardcover list, that path is *config + a token*, no new code, and
  it carries ratings for a floor.
- **Google Books + Open Library are enrichment, not charts.** Neither exposes a bestseller list,
  but both expose **rating/vote counts for free** — exactly what a Kometa-style numeric quality
  floor needs. Google Books is already the LL metadata backend; Open Library needs no key.
- **Goodreads still works, narrowly.** Shelf RSS is live in 2025 but **caps at the last 100
  books** per shelf and the API is gone — fine for a hand-curated "want" shelf, not for large
  charts. Listopia (the "best of all time" lists the owner named) has **no RSS** — LL scrapes it,
  with all the fragility that implies.

---

## 3. Q3 — Quality-floor strategy ("top rated / popular now / NYT — no junk")

Two complementary mechanisms:

1. **Source selection = the primary floor (works today, zero numeric filtering).** NYT
   bestsellers, Hardcover curated lists, and Goodreads "Best of…" shelves are *already* curated —
   pointing at them yields quality by construction. This is the only floor LL-native supports,
   because **the wishlist pipeline carries no rating metadata** (§1.2) — you take the whole list.
   Choose lists whose editorial identity *is* the floor (NYT Fiction, NYT Audio, a Hardcover
   "top-rated SF" list, an owner "5-star" Goodreads shelf).
2. **Numeric floor = a sync-mode enrichment gate (the Kometa vote-count analog).** For a true
   "≥ N ratings and ≥ X stars" cutoff, the `@hnet/sync` list mode enriches each candidate ISBN
   before pushing it to LL:
   - **Google Books** `volumes` → `averageRating` + `ratingsCount`.
   - **Open Library** → `ratings_average` + `ratings_count` + `readinglog_count`
     (`want_to_read_count` is a good "popular now" proxy).
   - **Hardcover** → `rating` + `ratings_count` + `users_count`.
   Drop anything below the threshold, then push the survivors. Recommended starting floor (owner
   to tune): keep if `ratingsCount ≥ 50 && averageRating ≥ 3.8` OR present on any NYT list
   (NYT membership overrides the numeric gate — an editorial list is trustworthy even for a fresh
   release with few ratings). **Bonus:** LL's own `addonebookbyisbn` already sorts candidate
   matches by `bookrate_count` internally, so a rating-aware selection is congruent with LL's
   grain.

Net: **v1 leans on source selection** (ships immediately); **the numeric floor rides in with the
sync-mode** for the sources where junk is a real risk (broad "trending"/subject feeds).

---

## 4. Q4 — Architecture recommendation

### 4.1 Options weighed

- **A. LL-native only (config + a monitor).** Cheapest; native governor/usenet-first respect;
  free author-follow + series levers; Hardcover + Goodreads-RSS + MAM-wishlist are robust.
  **Against:** the NYT/Amazon/B&N/Listopia providers are HTML scrapers (silent breakage; Book
  Depository already dead); **no numeric quality floor** (no rating metadata in the pipeline);
  weak observability (LL log + the `Requester` column only); Goodreads RSS 100-item cap; and it
  still rides the unproven Google-Books add path with no app-side visibility when it fails.
- **B. `@hnet/sync` list mode only (external official API → LL `addbookbyisbn`), the Kometa
  pattern.** Robust official APIs; **we** own the quality floor + batching + observability
  (existing sync-run/ledger infra + Pushover outbox); ISBN-keyed adds beat fuzzy title matching;
  testable in-repo (PG16 + vitest); fits the estate's proven `sync-books`/`ai-usage-sync`
  standalone pattern. **Against:** new ADR/DESIGN/migration lift; throws away LL's *good* native
  bits (Hardcover sync, Goodreads-shelf RSS, author-follow) that need no code.
- **C. Hybrid (RECOMMENDED).** Use each tool where it is strong.

### 4.2 Recommended v1 = Hybrid

**Track 1 — LL-native, config-only, ship first (the robust feeds).**
Add `[RSS_*]` wishlist providers for the **RSS/API-backed** sources only:
- **Goodreads shelf RSS** — the owner's hand-curated "want" shelf (`/review/list_rss/{uid}?shelf=…`),
  `DLTYPES` per intent (see Q-04).
- **Hardcover reading list** — enable `hc_sync` with an owner token if the owner curates on
  Hardcover (native `hc.py`, 48 h).
- (Optional) **MAM wishlist** feed — only the documented feed, no extra automation.
These inherit usenet-first + the governor automatically and stamp `Requester` for provenance.
**Do NOT** wire LL's NYT/Amazon/B&N/Listopia/Book-Depository scrapers — they are fragile and, for
NYT, strictly worse than Track 2.

**Track 2 — a small `@hnet/sync` "list mode" for the official chart APIs (the durable core).**
A standalone sync step (CronJob, ~daily) that:
1. Polls the **official NYT Books API** (free key in 1Password) for a configured set of lists
   (start: *Combined Print & E-Book Fiction*, *Combined Print & E-Book Nonfiction*; add *Audio
   Fiction/Nonfiction* if audiobooks are in scope) → each item has **ISBN + rank + author/title**.
2. (Optional) applies the **numeric quality floor** (§3) via Google Books / Open Library ratings.
3. Pushes survivors into LL via its documented **`addbookbyisbn`** command (`api.py` L2336 —
   accepts a comma-separated ISBN batch, resolves via `search_for`, adds the best match) + marks
   wanted; LL's normal search + the governor take it from there.
4. Records what it added (source list, rank, ISBN, LL result) to the app's existing sync/ledger
   surface + a **Pushover** summary — the observability Track 1 lacks.
This makes the app the **system of record for "what a list added and why"**, keeps official-API
robustness, and reuses `@hnet/sync`'s established shape. It is the piece that becomes the
"Kometa-for-books" the owner pictured.

**Governor interaction (verified, not assumed):** both tracks end at LL's shared searcher, which
selects providers by `dlpriority` (usenet 42–50 ≫ MAM 26) and is gated by the PLAN-039
indexer-pause governor. So **auto-grab is safe by construction** — usenet absorbs the bulk; MAM
fallback self-throttles at the unsatisfied cap. Recommend a **first-run batch cap** anyway (LL
will mark a whole list Wanted at once; usenet has no cap but be gentle) — cap the sync-mode's
per-run ISBN push (e.g. 25) until the metadata path is proven (Q-06).

**Comics:** honestly, **no list ecosystem exists.** ComicVine is metadata-only (no
popularity/bestseller endpoint); there is no comics NYT/Hardcover analog. Use **Kapowarr's own
volume-completion** ("finish the volumes of series I have") + manual adds. Scope comics *out* of
list-automation v1; document the volume-completion lever only.

**Sequencing:** Track 1 is a same-night config change (post-Q-06 test); Track 2 is its own
ADR → DESIGN → plan → code cycle. Ship Track 1 first to get value immediately, build Track 2 as
the durable backbone.

---

## 5. Q5 — Kavita reading lists as an acquisition source (honest sketch, not a design)

Feasible but a **later increment**, not v1:

- Kavita exposes reading lists over its **REST API** (`/api/ReadingList/*` — `lists`, list items
  with series/volume/chapter refs). The repo already has a **read-only `@hnet/books` Kavita
  client** (from PLAN-023's books-ledger sync), so authenticated reads are a solved problem.
- **Shape:** designate one Kavita reading list (e.g. **"Want"**) as an acquisition source; the
  Track-2 sync step reads its items, resolves each to an ISBN/author-title, and feeds the *same*
  `addbookbyisbn` push path as NYT. Owner curates visually in Kavita → it becomes a wanted list.
- **Honest caveats:** (a) Kavita reading-list items reference **series/volumes Kavita already
  knows**, i.e. things largely *in the library already* — great for "get the audiobook of an ebook
  I have" or "complete this series", **weaker for net-new discovery** (you can't add a book Kavita
  has never seen to a Kavita reading list). (b) ISBN resolution from a Kavita series is lossy
  (Kavita's metadata may lack ISBNs) → expect fuzzy title/author matching, the least reliable LL
  path. (c) This is really the **in-app curation** answer to Q-01 and overlaps PLAN-029
  collections / the parked PLAN-033 requests — worth unifying later, not forking now.
- **Recommendation:** note it as the **in-app curation source** that Track 2 can add once the
  external-API path is proven; do not build it in v1.

---

## 6. Owner decisions (reuse plan Q-ids where they map)

- **Q-01 (sources first):** RECOMMEND — **NYT Books API** (official, Track 2) as the marquee
  chart + **one owner-curated home**: a **Goodreads "want" shelf** (RSS, Track 1, no account
  friction beyond making it public) *or* a **Hardcover list** (native `hc_sync`, richer, needs a
  token). **Owner: pick the curation home** (Goodreads shelf vs Hardcover). Amazon/B&N/Listopia
  scrapers deliberately deferred as fragile.
- **Q-02 (where the logic lives):** RECOMMEND — **hybrid** (§4.2): LL-native for robust RSS/API
  feeds, a `@hnet/sync` list mode for NYT official API + quality floor + observability.
- **Q-03 (auto-grab vs propose):** RULED = auto-grab + PLAN-039 governor. Confirmed compatible
  (both tracks route through governed search). **Add:** cap the first-run batch until Q-06 clears.
- **Q-04 (ebook / audiobook / both) — ANALYSIS + owner decision needed:** LL controls this
  **per-list** via `DLTYPES` (`'E'` default / `'A'` / `'E,A'`), and Track 2 controls it per NYT
  list. RECOMMEND: **charts default ebook-only** (`'E'`) — cheaper/faster on usenet and the ebook
  is what most "top lists" are about; **opt audiobooks in per-list** for audio-oriented sources
  (NYT **Audio Fiction/Nonfiction** → `'A'`; a "want the audiobook too" shelf → `'E,A'`). Wanting
  **both** for every chart item roughly doubles grabs and MAM pressure — do it selectively.
  **Owner: confirm the default and which lists get audio.**
- **Q-05 (surface in Library UI):** LL already stamps `Requester = <list>` on each book (provenance
  exists); surfacing a "why is this here" chart badge ties into **PLAN-029 collections** — defer to
  that plan.
- **Q-06 (NEW — metadata-path proof, BLOCKING):** the Google Books add-book path is
  configured-but-unproven for the list flow (§1.4). **Before any bulk list**, run one supervised
  test: add a single small known-good list (or a handful of ISBNs via `addbookbyisbn`) and confirm
  clean `import_book` + Wanted + grab with **no `NoneType`/OpenLibrary errors** in
  `/config/log/lazylibrarian.log`. If it still errors, pin a newer LL build before proceeding.
- **Q-07 (NEW — Goodreads RSS 100-item cap):** acceptable for a curated "want" shelf; if the owner
  wants a *large* Goodreads list, it must come via Track 2 (paginated) or Hardcover, not shelf RSS.

---

## Sources

- **Cluster (read-only, `haynes-ops` / ns `downloads`):** `deploy/lazylibrarian`
  `/app/lazylibrarian/lazylibrarian/{providers.py,searchrss.py,config2.py,configdefs.py,api.py,hc.py,grsync.py}`,
  `/config/config.ini`, `/config/log/lazylibrarian.log`.
- NYT Books API spec (endpoints, key, 1,000/day, rank+ISBN): https://github.com/nytimes/public_api_specs/blob/master/books_api/books_api.md · https://developer.nytimes.com/docs/books-product/1/overview
- Hardcover API (GraphQL, free, 60/min, token expiry, Lists): https://docs.hardcover.app/api/getting-started/ · https://docs.hardcover.app/api/graphql/schemas/lists/ · https://www.emgoto.com/hardcover-book-api/
- Open Library (free, no key, Search/Subjects/Trending, ratings): https://openlibrary.org/dev/docs/api/search · https://openlibrary.org/developers/api · https://openlibrary.org/trending/now
- Google Books API (key, quota, averageRating/ratingsCount): https://developers.google.com/books/docs/v1/using · https://developers.google.com/books/docs/v1/reference/volumes
- StoryGraph (no public API): https://roadmap.thestorygraph.com/features/posts/an-api · https://github.com/ym496/storygraph-api
- Goodreads (API retired 2020; shelf RSS live, 100-item cap): https://www.jordankatzen.com/posts/notes/goodreads-rss/ · https://help.goodreads.com/s/question/0D58V00007PT3EnSAL/what-is-my-rss · https://www.goodreads.com/topic/show/2164751-shelf-rss-feed-behavior-for-shelfsize-100
- Audible / audiobook charts (no official API; scrape/Amazon zgbs): https://www.audible.com/charts · https://audible.readthedocs.io/en/latest/misc/external_api.html
- ComicVine (metadata API, free key, no popularity list): https://comicvine.gamespot.com/api/
- Book Depository closure (LL provider dead): widely reported April 2023 (site retired by Amazon).
- MAM compliance facts: `2026-07-11-mam-rules-scrape.md` + `2026-07-10-book-trackers-research.md` (no live MAM access performed for this doc).
</content>
