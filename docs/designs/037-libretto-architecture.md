# DESIGN-037: Libretto — the books collection-manager app ("Kometa for books")

- **Status:** Draft (owner-review artifact — Libretto's own ADR train starts in the Libretto
  repo once the owner ratifies this shape; the hnet-side integration ADRs arrive with
  PLAN-051/052). **AMENDED 2026-07-16 eve: Libretto is FULLY STATELESS, Kometa-style (owner
  ruling — supersedes the same-day SQLite amendment; see D-01/D-03 and Q-03).**
- **Last updated:** 2026-07-16, **AMENDED 2026-07-20 (ADR-076 — multi-target recipes):** the Recipe noun's
  `targetLibrary` becomes **`targets[]`** (1..N; back-compat normalize to a one-entry array; a new optional
  `category` field), one recipe materializes into EVERY target, `missing[]` + the `/collections` read-back
  tag the target, and the provenance marker may carry `|cat=<Category>` (activating DESIGN-038 D-12's L1
  path). See the dated notes in D-02/D-03/D-07/D-09/D-10. **AMENDED 2026-10-06 (issue #759):** D-04's title fallback
  also finds a book Kavita files inside a series, the same book held twice, and a title carrying series decoration.
  **AMENDED 2026-10-06 (issues #771, #777):** D-04 gains member title aliases (`variables.titleAliases`); D-05's
  `hardcover_series` members carry their authors; D-09's acquisition is author-guarded. **AMENDED 2026-10-06
  (thaynes43/libretto#25, #26):** D-04's Kavita series detail refreshes after a scan and within 12 hours; D-09's
  acquisition never queues a book in a language not acquired (English here) or a format LazyLibrarian already holds.
- **Satisfies:** the PLAN-043 saga phase "Books collection-manager app" (owner rulings
  2026-07-16, recorded in `.agents/plans/043-integration-tab-saga.md` and restated in
  PLAN-054); governed by **ADR-064** (mirrored-only doctrine — external software is always the
  collections source of truth; Libretto IS that external software for books) and the
  **provider-parity contract** (research §6 / PLAN-052 R2).
- **Foundation:** `.agents/context/2026-07-16-kometa-integration-research.md` — cited
  throughout as "research §N" rather than restated. UNVERIFIED flags from that doc carry
  forward here unchanged.
- **Companions:** DESIGN-035/PLAN-037 (the Plex collections mirror whose pattern PLAN-051
  reuses for books), DESIGN-036/ADR-065 (format pairing — the matching lesson + the mint-cap
  precedent), ADR-055 (confined LL write chain), ADR-054 + OPS-013 (MAM governor + Prowlarr
  owns LL provider config), PLAN-052 (the hnet UI that binds to this contract).

## Overview

Libretto is a **standalone, public-repo, headless Node/TS service** that does for
Kavita/Audiobookshelf what Kometa does for Plex: recipes describe collections built from
external list sources (Hardcover series positions, NYT bestseller lists, Wikidata awards,
static ID lists), a reconciler materializes them **into** Kavita and ABS (which stay the
sources of truth per ADR-064), and items a recipe wants but the library lacks become a
**missing report** that optionally drives LazyLibrarian wants — the acquisition leg. It is
valuable to anyone running Kavita/ABS/LazyLibrarian with no haynesnetwork at all;
haynesnetwork integrates ONLY through the provider-parity contract (research §6), and its
PLAN-051 mirror displays Libretto-written collections with zero site changes.

Kometa's idiom is kept **literally, not just in shape** (owner ruling 2026-07-16 eve:
"Kometa has no database... it just reads its YAML and searches its sources... Stateless"):
recipes are **YAML config files** and Libretto keeps **no database at all** — the targets,
LazyLibrarian, and the config volume are the only stores (D-03). What makes Libretto an APP
rather than a batch job is everything else: a resident service with a real API, a reconciler,
schedules that trigger, and a run monitor — and the one Kometa pain our deployment documents
(config self-rewrite, research §4) stays designed out: Libretto NEVER rewrites its own files.
KISS throughout: v1 is one small builder set, two write targets, one acquisition path, and a
minimal built-in UI for config CRUD + run monitoring.

## Detailed design

### D-01 — Service shape: headless API-first app, recipes as YAML config files — AMENDED (stateless ruling)

One Node/TS service (zod for every schema; no ORM — there is no database, D-03) exposing a
REST API plus a minimal built-in web UI served from the same container. **Recipes are YAML
files in a `recipes/` directory on the config volume** — the Kometa idiom kept literally,
with the one Kometa pain our deployment documents (research §4: config self-rewrite, the
PVC seed/rewrite hybrid, git edits not reaching the pod) designed out:

- **Libretto NEVER rewrites its own config.** Recipe files change only on an explicit save
  through the API/UI (`upsertRecipe` = validate first, then write the file) or by hand —
  which makes the recipes dir **git-able for GitOps users**, and makes the Kometa provider
  (one managed YAML file, git-PR-delivered) and Libretto MORE symmetric under PLAN-052.
- **Connection config = environment/secrets only** (target URLs + API keys, source API keys,
  LL URL + key, the config/cache volume path, Libretto API keys). Nothing secret in recipe
  files; nothing behavioral in env beyond caps/toggles.
- Schedules **trigger** runs (in-process cron, D-11) — a deliberate delta from Kometa, whose
  schedules only gate an already-running batch (research §1).

### D-02 — Domain model (the §6 contract verbatim)

Four aggregates — these are the CONTRACT shapes; where each one is stored (or recomputed)
is D-03's stateless mapping. The Recipe field set is the provider-parity contract's noun,
verbatim (research §6.2), so the hnet form and any future provider render the same shape:

- **Recipe** `{ id, targetLibrary, name (namespaced), builder { type, ref }, variables
  { syncMode, ordered, acquisitionEnabled, tag, schedule }, enabled }`
  - `targetLibrary` — a configured target: `{ server: kavita|abs, libraryId }`.
  - **AMENDED 2026-07-20 (ADR-076 C-01):** `targetLibrary` → **`targets[]`** — an array of 1..N configured
    targets `{ server: kavita|abs, libraryId }` (practical v1: one Kavita + one ABS). One recipe declares
    ALL its targets and Libretto materializes the collection into EACH; the app merges the mirrored twins by
    recipe id (ADR-076 C-03). **Back-compat:** a single `targetLibrary` is accepted and normalized to a
    one-entry `targets[]`, so the 45 live recipe YAMLs stay valid; the API emits `targets[]` (an additive
    provider-parity change). A new OPTIONAL **`category`** field feeds the marker's `cat=` token (D-03
    amendment) — recipe-authored collection categories (DESIGN-038 D-12 L1). hnet's `@hnet/libretto` schemas
    + the builder form follow the noun.
  - `builder.type` — one of the v1 set (D-05); `builder.ref` — the source reference (a
    Hardcover series id, an NYT list slug, a Wikidata award QID, a static ID list).
  - `variables.syncMode` — `append | sync` (D-08); `variables.ordered` — whether the produced
    collection carries source order (drives target mapping, D-07);
  - `variables.acquisitionEnabled` — the `radarr_add_missing` analog (default **false**;
    D-09); `variables.tag` — provenance label written into target metadata where the target
    supports it; `variables.schedule` — cron expression or `manual`.
- **Collection** — a collection Libretto **produced**: `{ recipeId, targetLibrary,
  targetCollectionId, targetKind (kavita_collection | kavita_reading_list | abs_collection),
  name, items[] (ordered — position is first-class, research §5) }`. Not stored: **read back
  from the targets**, ownership recovered via the D-03 provenance marker. **AMENDED 2026-07-20
  (ADR-076 C-02):** a multi-target recipe produces ONE Collection PER target, so `GET /collections`
  returns N entries for it, each still carrying its own `targetLibrary` — that per-target tag is how hnet
  knows which server a mirrored twin came from before it merges them by `recipeId` (D-10 amendment).
- **Run** — first-class run records: `{ id, scope (all | recipeId), trigger (cron | api |
  ui), startedAt, finishedAt, status (running | ok | warn | error), counts (per-recipe:
  matched, written, added, removed, missing, acquired), log excerpt }` — served from the
  D-03 run-state file (+ structured logs for depth).
- **MissingReport** — per-recipe `missing[]`: works the builder demanded that no library item
  matched, `{ recipeId, work identity (title, author, identifiers), resolution (open |
  pushed | landed | unmintable), llBookId? }` — **recomputed each run**; resolution comes
  from querying LazyLibrarian, not from a Libretto ledger (D-03/D-09). The acquisition leg's
  input (D-09) and the contract's `missing[]` read (D-10).

### D-03 — Persistence: NONE — the targets are the state store (AMENDED, final)

**Owner ruling (2026-07-16 eve, resolves Q-03 finally — superseding the same-day SQLite
amendment): Libretto is FULLY STATELESS, Kometa-style.** "Kometa has no database... it just
reads its YAML and searches its sources." Every piece of state either lives where it already
has a home or is recomputable:

- **Recipes = YAML files** on the config volume (D-01). No recipe rows anywhere.
- **Produced collections = the targets themselves.** Ownership is RECOVERED, not stored: a
  **provenance marker (the recipe id) embedded in the collection's description field** lets
  every run re-identify what Libretto manages. ABS collections have a description field;
  **Kavita's writable description exposure on collections/reading lists is UNVERIFIED — an
  explicit M1 spike item (PLAN-054)**; fallback if Kavita can't carry the marker = a tiny
  sidecar ownership JSON on the config volume (still no DB).
  - **AMENDED 2026-07-20 (ADR-076 C-02):** the marker MAY carry an optional category —
    `[libretto:<recipeId>|cat=<Category>]` — when the recipe sets `category` (D-02 amendment). Every
    target's produced collection carries the SAME marker (one shared identity across the twins — the merge
    key, ADR-076 C-03). The `cat=` token is what activates DESIGN-038 D-12's **L1** path: hnet's
    `deriveBooksCollectionCategory` parses it at sync and the recipe-authored category flows into the books
    collection mirror (the COALESCE rule — source wins). Libretto stays generic: `cat=` is plain marker
    text, nothing haynesnetwork-specific.
- **Acquisition state lives in LazyLibrarian** — hard rule 4 applied to books: LL already
  tracks wants and stamps list provenance in its `Requester` column (research recon,
  PLAN-032). Libretto queries LL for want status instead of keeping a `missing_items`
  ledger; the missing report is recomputed each run (D-09).
- **Run history = structured logs + a rotating last-runs JSON file** on the volume (the
  `getRun` read serves from it). Shallower than a DB-backed history — acceptable v1, noted
  honestly; deep history is the logs.
- **Identifier cache = a disk cache dir with TTL** (D-04) — losable and rebuildable, a
  cache, not state. Attempt-pacing recency for the acquisition cap rides the run-state file
  (D-09).

No database, no ORM, no migrations. Tests run against a temp config dir + stub servers.

### D-04 — Identifier resolution: IDs first, never title/author fuzz alone

The PLAN-050 lesson is normative (ADR-065 C-c: conservative title+author matching honestly
misses edition variants; identifier-backed matching is the upgrade path — Libretto starts
there). Every builder emits **works keyed by identifiers**, and matching walks a chain:

1. **Source-side identity:** builders return whatever IDs the source carries — NYT gives
   ISBN10/13; Hardcover gives its book id + ISBNs; Wikidata gives QIDs with OLID/ISBN claims;
   static lists are entered AS identifiers. **Open Library is the glue backbone** (no-key
   reads; OLID/ISBN/LCCN crosswalk) and **Wikidata** fills gaps (research §5). Resolved
   edges land in the TTL'd disk cache dir (D-03 — rebuildable, valuable under source rate
   limits).
2. **Library-side identity:** match target items by identifier where the target exposes one —
   ABS item metadata carries `isbn`/`asin` fields; Kavita's identifier exposure per
   series/chapter is **UNVERIFIED** and must be probed in the MVP spike.
3. **Fallback, flagged:** where a library item carries no identifier, apply the ADR-065
   conservative matcher (full-title pairing key + author agreement, full token equality) —
   never looser fuzz — and flag `matchedVia: title_author` in the run report (per-recipe
   counts + log) so the honesty survives into reads. No match ⇒ the work goes to the
   MissingReport; nothing is fabricated.

> **Amendment 2026-10-06 (issue #759 — held books the library files differently).** Members the library held kept
> reading missing, so the app kept them as Wanted tiles (DESIGN-038 D-13). A read-only replay of the live library found
> three shapes the step 3 fallback could not see, now matched in Libretto (`src/matching/title.ts`, `src/core/match.ts`,
> `src/target/kavita.ts`), each as conservative as before:
>
> - **A book inside a Kavita series.** Kavita files an epub that names its series as a volume of that series, so the
>   series name ("Outlander") hid the book ("Written in My Own Heart's Blood", volume 8). The same
>   `/api/Series/volumes` call that carries chapter ISBNs carries each chapter's own title, so a Kavita item now lists
>   the books it holds, each also as "<series>: <title>" ("Mistborn: The Final Empire"). These book titles are a second
>   tier: they are looked up only for a title no item carries as its own, so no work moves off the item it already
>   matched. Each book of a series is its own claim, so one series can hold several members. Series grain (comics)
>   still matches series names only.
> - **The same book held twice.** An epub and a pdf Kavita filed as two series, or an import and a re-download in
>   Audiobookshelf, made a title ambiguous, and ambiguity is refused. They are now one book when every pair of copies
>   names agreeing authors (or Kavita chapter writers), or their files share a folder, and no copy carries a volume number
>   the others do not ("Dune (Part 1)" and "Dune (Part 2)" are halves). Kavita writers only ever verify copies; they never
>   veto a match, because epub credits are often partial.
> - **A decorated title.** For a title the library carries nowhere, the two sides are compared with series decoration
>   taken off: a position prefix ("Expanse 03 - Abaddon's Gate"), a subtitle that names a volume or the form ("Caliban's
>   War: The Expanse, Book 2", "Children of Anguish and Anarchy: Legacy of Orisha 3", "The Lost Metal--A Mistborn
>   Novel"), or the work's own series name ("Artificial Condition--The Murderbot Diaries", "Bridgerton: An Offer from a
>   Gentleman"; `hardcover_series` works now carry `series`). A subtitle that carries the book is never dropped
>   ("Mistborn: The Final Empire", "The Duke and I: The 2nd Epilogue"), nor one that names another thing (a graphic
>   novel, a companion, an epilogue, a bundle). The volume a decoration names must agree with the work's series position
>   (the #693 / #739 Volume Check lesson: another volume never satisfies a member), and two members of one list that
>   share a stripped title at different volumes take nothing by it.
>
> Still no fuzz: a library title that differs in words ("The World of Divergent" for "The World of Divergent: The Path
> to Allegiant") stays an honest miss. The replay, old matcher against new over all 75 recipes and every target, flipped
> 52 members from missing to held, each hand-checked as the right book and volume, flipped none the other way, and took
> no member out of any collection. Libretto PR https://github.com/thaynes43/libretto/pull/21.

> **Amendment 2026-10-06 (issue #777, coordinator ruling: member title aliases).** Seven held books carry a title that
> differs from the member's in words, which no safe rule can pair (dropping a subtitle that carries the book is how
> "Mistborn: Secret History" would take "Mistborn"). A recipe now names such a pairing itself, in the spirit of Kometa's
> per-collection overrides: `variables.titleAliases` maps a member's title, as the builder lists it, to the other titles
> a library item carries for that same book. The rules (`src/core/match.ts`, `recipeMatchOptions`):
>
> - An alias is an exact title (the step 3 noise stripping, nothing else), tried only for a member whose own title the
>   library carries nowhere (an own title that was refused as ambiguous, author-vetoed or taken stays refused), before
>   the decorated pass, through the same guards: an ambiguous title is refused, disjoint authors veto it, and an item
>   another member took stays taken. The alias key is compared like a title, so case and punctuation never miss one.
> - Aliases apply with `titleFallback: false` too (a person confirmed each one), at work grain only. A match through one
>   is flagged `matchedVia: 'alias'` and counted in `matchedByTitle`. The reconciler and the missing endpoint read their
>   options from one function, so the two can never disagree.
> - A person writes one only after checking the library item by hand: the same work and volume, in English. Never
>   another volume, and never another edition that is not the member's own text (a box set, a graphic adaptation).
> - Where the library's own title is plainly wrong (garbled, or a wrong subtitle), the library metadata is fixed instead,
>   through Kavita's or Audiobookshelf's API, and locked so a rescan keeps it. Kavita's API cannot rename a series (its
>   name comes from the file); its chapter title and sort name can be set and locked, and Libretto reads chapter titles
>   as the books an item holds.
> - The app never edits aliases, and Libretto's PUT replaces the whole recipe, so every app write carries them through:
>   the find-missing toggle re-PUTs the recipe as read (now with its `targets`, `category`, `titleFallback` and
>   `titleAliases`, so a two-target recipe stays two-target), and an edit from the collections form keeps the recipe's
>   `titleFallback` and `titleAliases` (`collections-manager.ts`).
>
> The seven (each checked against the file: OPF or pdf metadata, its ISBN against the member's Hardcover identifiers,
> and its text or running time):
>
> | Recipe | Member | Library item | Evidence |
> |---|---|---|---|
> | `divergent` | The World of Divergent: The Path to Allegiant | Kavita "The World of Divergent" | the epub's title page reads the full title, ISBN 9780062300805 is the member's |
> | `divergent` | Free Four: Tobias Tells the Divergent Knife-Throwing Scene | Kavita "Free Four: Tobias Tells the Story" | ISBN 9780062237422 is the member's; the publisher's later title for the same story |
> | `the-murderbot-diaries` | Rapport: Friendship, Solidarity, Communion, Empathy | Kavita "Rapport" | the OPF carries both title parts; Kavita reads the first |
> | `all-souls` | The World of All Souls: A Complete Guide to A Discovery of Witches, Shadow of Night and The Book of Life | Kavita "The World of All Souls" | Penguin 2018, the guide itself |
> | `bridgerton` | On the Way to the Wedding | Kavita "On the Way to the Wedding with 2nd Epilogue" | ISBN 9780062424167 is one of the member's editions: the novel with its epilogue appended |
> | `discworld` | The Last Hero | Kavita "The Last Hero: A Discworld Fable" | the illustrated Gollancz edition (ISBN 9780575068858, the member's). Its pdf title said "(Graphic Novel)", a wrong subtitle: the chapter title and sort name are corrected in Kavita and locked (a rescan kept them). Kavita's API cannot rename a series, so the alias names the book title |
> | `trials-of-apollo-audiobooks` | Camp Half-Blood Confidential | Audiobookshelf "From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide to the Demigod Training Camp" | the publisher's full title; 3 h 23 min, the companion book's length |
>
> The member "On the Way to the Wedding: 2nd Epilogue" stays missing: the standalone epilogue is its own member. The
> replay, the deployed matcher against the new one over all 75 recipes and every target on one dump of the live libraries:
> with no aliases nothing changes; with the seven aliases (and The Last Hero's corrected chapter title) exactly those seven
> members flip from missing to held, none flips back and none moves to another item. Libretto PR
> https://github.com/thaynes43/libretto/pull/23.

**AMENDED 2026-10-06 (https://github.com/thaynes43/libretto/issues/25, a Kavita metadata edit reaches the matcher the
same day).** The Kavita library-side identity (each series' chapter ISBNs, book titles, writers and folders, one
`volumes` call per series) was cached for 7 days under the series id and page count. A metadata edit made in Kavita (a
chapter title fixed and locked, writers corrected) moves no field of the series listing, so the matcher kept the old
title until the entry expired: The Last Hero's corrected title, which its member title alias above relies on, would have
read missing for a week. The cache now holds one entry per series, reused only while the series' page count, last folder
scan and last chapter added are unchanged, and for at most 12 hours. An edit followed by a scan of the series ("Scan
Series") is seen at the next listing; an edit with no scan is seen within 12 hours. A full refresh is about 1,800 calls
of about 3 ms of Kavita time each (measured 2026-10-06). Expired cache files are pruned at boot and daily. Libretto PR
https://github.com/thaynes43/libretto/pull/28.

### D-05 — Builders v1 (small, source-viability-ranked per research §5)

| type | ref | emits | notes |
|---|---|---|---|
| `static_ids` | inline identifier list | ordered works | the tracer builder + the manual-curation idiom (Kometa's ID-builder analog); no external dependency |
| `hardcover_series` | Hardcover series id | works ordered by series **position** | **the flagship: "complete the series I started"** — Hardcover GraphQL, Bearer, 60/min; token expiry UNVERIFIED (Q-02) |
| `nyt_list` | NYT list slug | ranked works with ISBNs | official NYT Books API; rate limit UNVERIFIED (~500/day vs 1000) |
| `wikidata_award` | award QID | works (year-ordered) | SPARQL P166; Hugo/Nebula/Booker home |

Series-completion semantics (the flagship): for each series the recipe references (v1:
explicit series refs; a later builder can auto-discover "series I own part of" from the
target libraries), emit ALL positions in order; positions the library holds become ordered
membership, positions it lacks become missing[] — acquisition then "drives content in"
(the saga phrase). Format coverage awareness leans on the shipped PLAN-050 pairing idea:
holding EITHER format counts as held v1; per-format completion is a later variable.
**Goodreads shelf RSS is seed-only** (research §5: API dead, RSS last-100 cap): an import
command that materializes a `static_ids` recipe, never a live builder. Deferred builder
ideas (Open Library lists, `wikidata_series`) stay out of v1 — KISS.

**AMENDED 2026-07-20 (comics grain shipped — libretto PR #11, live sha-7f042bd):** a fourth
live builder **`hardcover_comics`** takes an **array** of Hardcover series refs and matches at
**SERIES grain**: the Hardcover series *name* pairs against the target's series names through
the same conservative noise-stripped TitleIndex (D-04 philosophy; `matchedVia: 'series'`), and
the membership unit is the matched series. Rationale: Kavita comics libraries store one series
per comic run (volumes as chapters), so work-grain matching provably hits 0 (live 2026-07-20:
Scott Pilgrim 0/9, Invincible 0/137). `ordered: false` ⇒ a Kavita **collection** of the matched
series — the v1 sweet spot is multi-series "universe" collections (live proof: Invincible
Universe = Invincible + Guarding the Globe). Hardcover-global volume-interleaved reading lists
are deferred (`ordered: true` falls back to per-series-concatenated order). `acquisitionEnabled:
true` is a schema validation **error** for this builder — comics acquisition is Kapowarr-side
and out of Libretto's scope. Cache namespace `hardcover:comic-series:v1`. (Doc-drift honesty
note: of the original v1 table, `wikidata_award` was never built — the live builders are
`static_ids`, `hardcover_series`, `nyt_list`, `hardcover_comics`.)

**AMENDED 2026-10-06 (issue #771, `hardcover_series` members carry their authors).** A `hardcover_series` member carried
no author (the depth-3 cap left no room for the `contributions` relation), so its resolve ran on the title alone and
took another author's book: "Gray Dawn" (Walter Mosley) resolved to Stewart Edward White's *The Gray Dawn*, "Shift"
(Hugh Howey) to Stephen King's *Night Shift*, and LazyLibrarian downloaded both. The series query now reads each book's
`cached_contributors`, a jsonb scalar that fits the cap, and the works carry the Author credits (never an illustrator,
narrator, editor or translator) as `credits`. They name the member: the missing endpoint reports them as its `authors`,
so the app's want carries an author and its resolve runs author-guarded. They guard acquisition (D-09). They do not
guard the library match (D-04): a library's own author data is too uneven to veto with (Kavita filed the anthology *The
End is Nigh* under "Veronica Roth (1)"), so no collection changes. Cache key `hardcover:series-works:v5`. Libretto PR
https://github.com/thaynes43/libretto/pull/24.

### D-06 — Write targets and per-recipe target mapping

Verified API surfaces (research §5, from source):

- **Kavita** (Plugin auth, apiKey→JWT): Collections = `POST /api/Collection/update`,
  `/update-for-series`, `/update-series`, `DELETE` — **UNORDERED**. Reading lists =
  `/api/ReadingList/create`, `update-by-*`, **`update-position`** (explicit arbitrary order)
  + CBL import/export. Membership unit: series.
- **ABS** (Bearer): `/api/collections` CRUD + `/book` + `/batch/add|remove` — **ORDERED**
  (`collectionBook.order`; PATCH takes a `books[]` array; exact batch body fields
  UNVERIFIED). Membership unit: library item. Playlists are user-personal — out of scope v1.

**D-07 — Target-mapping rule (per recipe, derived not asked):** `variables.ordered` picks the
target kind — on a Kavita library, `ordered: true` ⇒ **reading list** (positions via
update-position), `ordered: false` ⇒ **collection**; on ABS, both map to an ABS collection
(natively ordered; unordered recipes just write source order without maintaining it). ~~One
recipe targets one library; "the same series in both Kavita and ABS" is two recipes v1
(matching PLAN-051 Q-02's two-honest-collections lean).~~ **SUPERSEDED 2026-07-20 (ADR-076 C-01):** a recipe
declares **`targets[]`** (1..N) and Libretto applies the SAME builder output to EACH target — "the same
series in both Kavita and ABS" is now ONE two-target recipe, and the app merges the mirrored twins by recipe
id (ADR-076 C-03). The **per-target kind mapping is UNCHANGED** (the rule above): on a Kavita target
`ordered: true` ⇒ reading list / `ordered: false` ⇒ collection; on an ABS target both map to an ABS
collection. Multi-target only adds the loop over targets; each target maps exactly as before.

### D-08 — Ownership, sync_mode, and deletion (the Kometa safety contract, made structural)

- **Ownership is by the recovered provenance marker, not by name.** Libretto only ever
  mutates collections carrying the D-03 description-embedded recipe id (or, on a target that
  can't carry it, listed in the sidecar ownership JSON). Each run re-reads the targets and
  rebuilds the managed set — nothing to drift, nothing to migrate. Name namespacing (a
  configurable display prefix, default `"Libretto: "`, plus `variables.tag` where the target
  supports labels) is for human clarity — collision cannot cause cross-writes as it can in
  Kometa, where collections key by title (research §1.1).
- **`sync_mode: sync`** — the run reconciles the produced collection's full membership and
  order to the builder output (adds, removes, repositions). **`append`** — adds only, never
  removes, positions appended at the end. Per-API: ABS sync is one PATCH of the full ordered
  `books[]` array; Kavita reading-list sync is create/delete of items + `update-position`
  passes; Kavita collection sync is the update-series membership calls.
- **Recipe deletion orphans by default, deletes only explicitly.** Kometa's orphan semantics
  on managed-entry removal are UNVERIFIED (research §1.4) — Libretto makes the choice
  explicit: `DELETE /recipes/:id` removes the YAML file; the produced collection survives in
  the target with its stale marker, and read-back reports it as **orphaned** (marker present,
  no recipe) until someone cleans it up. `?deleteCollection=true` also deletes it in the
  target. No `minimum_items` auto-delete magic: a 0-match run flags the run `warn` and
  leaves the collection alone (honesty over magic).

### D-09 — The acquisition leg: missing[] → LazyLibrarian, confined and paced

The `radarr_add_missing` analog, per-recipe via `variables.acquisitionEnabled` (default
**false**; the 2026-07-10 theatrical-window flood is the standing cautionary tale, research
§3):

- **A confined LL write module** — the ADR-055 discipline transplanted as a Libretto-side
  module: the only LL writes anywhere in the codebase are `addBook → queueBook →
  searchBook` behind one module boundary (lint-enforced import confinement, as
  `@hnet/lazylibrarian/write` is), with the proven 250ms pacer. `queueBook` after `addBook`
  (addBook alone lands `Skipped`) — the shipped hnet lesson rides along.
- **NEVER LL provider config.** Prowlarr fullSync **owns** LL provider configuration
  (OPS-013) — Libretto has no code path that touches it, pinned by a test asserting the
  acquisition path calls nothing beyond the three writes (the ADR-065 C-08 pattern).
- **The MAM governor is structurally untouched:** it sits at the Prowlarr seam (ADR-054);
  Libretto's wants enter LL like any other want and drain usenet-first by LL `dlpriority`.
- **LL is the acquisition ledger (hard rule 4 applied to books).** Libretto keeps no want
  state: each run recomputes the missing report and queries LL for what is already
  wanted/landed — LL's own want tracking + `Requester` provenance column (the research-recon
  fact from its native list engine) are the record. Whether `Requester` is settable on the
  API add path is UNVERIFIED — probe in M4; if not, provenance rides the marker + logs.
- **Paced, capped, honest:** per run, at most `ACQUISITION_CAP_PER_RUN` (default **25**,
  env-tunable — the PLAN-050 mint-cap precedent, ADR-065 C-06) missing items are pushed,
  oldest-first, retries least-recently-attempted first — the recency rotation persists in
  the D-03 run-state file, not a DB. Unresolvable identities simply reappear in the next
  recomputed report as `unmintable` and retry with backoff-by-recency; nothing is fabricated
  (the DESIGN-036 D-05 discipline). Items that later appear in the library reconcile
  `landed` by recomputation.

**AMENDED 2026-07-20 (ADR-076 C-05 — per-target `missing[]`).** With multi-target recipes the missing report
resolves **per target**: each `missing[]` entry carries the target it is missing FROM (a work held in the
Kavita target but absent from the ABS target is missing only from ABS). The acquisition confinement is
UNCHANGED — LL grabs both formats for any want anyway (hnet R-180), so per-target adds no LL surface; it
sharpens the report hnet reads. hnet's collection-wants pass mints one want per (work, format) with the
format source-derived per target (kavita ⇒ ebook, abs ⇒ audiobook) and the merged drill dedupes tiles on
`collection_member_ref` (DESIGN-038 D-13 amendment); the one-active-want-per-(work, format) invariant across
origins (collection vs pairing) is PLAN-060 edge E-1.

**AMENDED 2026-10-06 (issue #771, an author-guarded acquisition).** Acquisition's LazyLibrarian title match now reads
LazyLibrarian's `AuthorName` and the work's authors (or, for a `hardcover_series` member, its credits, D-05), so a
same-titled book by another author is never driven for a member; its resolve is told the member's first author. A book
or work with no author is judged on its title, as before. The app's own force-search applies the same rule to its
collection wants (DESIGN-028 amendment of this date, the Author Check).

**AMENDED 2026-10-06 (https://github.com/thaynes43/libretto/issues/26, the language and held checks).** A Discworld
apply queued the French "Drame de troll" for the member "Troll Bridge" (it matched through a French ISBN in the Hardcover
member's identifiers) and re-queued "The Last Hero", which LazyLibrarian held as files under a `Skipped` status. Two
checks now gate every acquisition write:

- **Language.** Acquisition only queues or adds a book in an allowed language: Libretto's
  `LIBRETTO_ACQUISITION_LANGUAGES`, a generic list of language codes, default `en` (the estate's English-only rule, the
  English Edition, DDD-001 T-282). The language is LazyLibrarian's own `BookLang` for a book it already has and the
  Google Books volume's `language` for a new one, read with the app's three classes (`en`, `eng`, `en-*` and `English`
  are English; blank, `Unknown`, `und` and `xxx` are unknown and allowed, as the app's pairing allows them). A
  LazyLibrarian row in another language is never a match, even on an exact ISBN, and its ISBN is not used to add the
  work; the resolve broker treats a volume in another language as a miss, so an ISBN hit on a translation falls through
  to the title leg, and when only other-language editions turn up there is no `addBookByISBN` fallback.
- **Held.** A format counts as held when LazyLibrarian's status reads `Open` or `Have`, or when it carries an import
  date or file for it (`BookLibrary` / `AudioLibrary`, `BookFile` / `AudioFile`), the same signals as the app's own push
  guard (`llFormatAlreadyHeld`). A held format is never queued.

Libretto PR https://github.com/thaynes43/libretto/pull/27.

### D-10 — API surface: the five contract nouns as REST

REST + zod-validated JSON (OpenAPI generated from the zod schemas) rather than tRPC: the
consumers include non-TS standalone users, and hnet's tRPC router (PLAN-052) wraps this API
behind its provider discriminator anyway. Base `/api/v1`, all under D-12 auth:

| Contract noun (research §6) | Endpoints |
|---|---|
| listRecipes / upsertRecipe / deleteRecipe | `GET/POST /recipes`, `GET/PUT/DELETE /recipes/:id` (`?deleteCollection=true` per D-08) |
| validate(recipe \| set) → issues[] | `POST /validate` (body: recipe draft or `{all: true}`) — schema + ref resolution + target reachability, mutating nothing |
| apply(scope) → runId; getRun | `POST /apply` `{ scope: all \| recipeId }` → `{ runId }`; `GET /runs/:id`, `GET /runs` |
| listProducedCollections | `GET /collections` (+ `GET /collections/:id/items` — ordered membership) |
| per-recipe missing[] | `GET /recipes/:id/missing` |

Plus discovery + liveness: `GET /builders` (types + zod param schemas — drives both UIs'
forms), `GET /targets` (configured libraries + reachability), `GET /health` (unauthenticated
liveness; D-14).

The contract survives the storage swap unchanged — `upsertRecipe` is now a validated YAML
write, `listProducedCollections` a target read-back, `getRun` a run-file read — evidence the
contract was drawn at the right altitude: hnet (PLAN-052) binds to the nouns and never sees
where they live.

**AMENDED 2026-07-20 (ADR-076 C-02 — target-tagged read-back).** A multi-target recipe produces ONE
collection per target, so `GET /collections` (`listProducedCollections`) returns one entry per (recipe,
target), each TAGGING its `targetLibrary` `{ server, libraryId }` (the Collection noun already carries it,
D-02). hnet's mirror keys the twins by the shared recipe id (from the `[libretto:<recipeId>]` marker) and
merges them into one card (ADR-076 C-03); the per-target tag is how a reader knows which server each twin
came from. Additive — no endpoint shape change beyond the array now carrying N entries for a multi-target
recipe.

### D-11 — Scheduler: in-process cron

One in-process cron loop (croner-class library): each enabled recipe's
`variables.schedule` (cron expression | `manual`) enqueues an apply; runs serialize through
a single worker queue (no concurrent writes to one target — Kometa's `concurrencyPolicy:
Forbid` instinct, in-process). Missed ticks on restart are skipped, not replayed (next tick
catches up — recipes are reconcilers, not event logs). No external job system v1.

### D-12 — AuthN: API keys first, OIDC later

`Authorization: Bearer <key>` checked against `LIBRETTO_API_KEYS` (env, comma-separated —
ESO-friendly; richer key management is a later feature). hnet holds one key as its
provider credential; the built-in UI prompts for a key once and keeps it client-side. OIDC
(Authentik for us, generic OIDC for standalone users) is explicitly later — the contract
surface doesn't change, only the authenticator.

### D-13 — Built-in UI: config CRUD + run monitor, nothing more

A minimal SPA served by the service itself (no separate deployment): **Recipes** (list +
form generated from `GET /builders` param schemas; saving = validate first, then write the
YAML file — the ONLY way Libretto ever touches its own config, D-01), **Runs** (history +
polling detail with per-recipe counts and the missing report, from the run-state file),
**Status** (targets/sources reachability). No walls, no browsing, no user management, no theming ambitions — the rich UX
lives in hnet (PLAN-052) and in the targets themselves. This bound is the KISS ruling made
structural.

### D-14 — Deployment + observability

- **ONE container + ONE small config/cache volume — the Kometa shape exactly** (D-03: the
  volume holds `recipes/`, the run-state file, the identifier cache dir, and the sidecar
  ownership JSON if the Kavita fallback is needed). Image `ghcr.io/thaynes43/libretto`; same
  release train idiom as hnet: conventional commits, release-please, image on `v*` tags.
- **haynes-ops HelmRelease sketch** (`kubernetes/main/apps/media/libretto/`): bjw-s
  app-template, one Deployment (the scheduler is in-process — no CronJobs, unlike Kometa's
  three, research §4), a small PVC for the config/cache volume, ExternalSecrets from the
  1Password `HaynesKube` vault (Kavita/ABS/LL keys exist there today; Hardcover/NYT keys are
  Q-02), internal ingress `libretto.haynesops.com`, egress allowlist for `api.hardcover.app`,
  `api.nytimes.com`, `openlibrary.org`, `query.wikidata.org`. No DB service of any kind.
- **Observability v1:** structured logs (pino), `GET /health` (liveness + config-volume
  writability), run history from the run-state file as the primary run-state surface (the
  contract's noun 4). Prometheus `/metrics` is explicitly later; alerting rides "no
  successful run in N hours" via the existing log/uptime stack until then.

### D-15 — Non-goals v1 (explicit)

- **No Goodreads scraping** — RSS import is seed-only (D-05); no Listopia, no page scraping.
- **No recommendations / predictions** — that is saga pt 2, parked, and it is hnet-side.
- **No multi-user personalization** — recipes are estate-level; ABS playlists (user-personal)
  and per-user anything are out.
- **No writing to LL provider config** (D-09 — structural, not aspirational).
- **No overlays / poster art / metadata operations** — Kometa's other half is out of scope
  entirely.
- **No comics v1** — Kavita comics libraries are not targeted until a viable comics list
  source exists (the PLAN-032 comics-mandate hunt; ADR-065 C-08 kept comics out of pairing
  for the same honesty). **SUPERSEDED 2026-07-20:** the blocker turned out to be membership
  GRAIN, not source viability (Hardcover has comic series fine) — comics shipped as the
  series-grain `hardcover_comics` builder (D-05 amendment), grouping-only (acquisition
  remains structurally excluded).

## Alternatives considered

- **In-app (an hnet package) instead of a standalone service** — rejected by owner ruling
  (2026-07-11 escalation of PLAN-032, reaffirmed 2026-07-16): standalone-valuable to
  non-hnet users, own repo/release train; hnet stays a mirror + contract consumer (ADR-064).
- **A database for recipes/state** — rejected by owner ruling, in two same-day steps kept
  visible for the record: the original draft chose Postgres 16 (the hnet idiom); the owner
  first amended to SQLite ("Kometa is super lightweight"), then ruled the deeper point the
  same evening: **fully stateless, Kometa-style** — YAML recipes + target read-back + LL as
  the acquisition ledger (D-01/D-03). The research §5.4 "DB recipes + reconciler" lean is
  superseded on the storage half; its reconciler/app half stands. What survives of the
  original anti-YAML argument is the self-rewrite ban, not the file format.
- **tRPC as the public API** — rejected for the public surface (TS-only consumers); kept as
  hnet's client-side idiom wrapping this REST contract.
- **Title/author matching as the primary matcher** — rejected; ADR-065 C-c is the recorded
  lesson. Identifiers first; the conservative matcher only as a flagged fallback (D-04).
- **External job runner / CronJobs for scheduling** — rejected v1 (KISS): in-process cron +
  a serialized worker queue suffices for one estate; the run model doesn't preclude moving
  later.

## Test strategy

The hnet discipline travels: Vitest + a temp config dir per test (no DB harness — there is
no DB), stub servers for Kavita/ABS/LL/Hardcover/NYT/Open Library/Wikidata in the
`@hnet/test-utils` idiom. Highest-value suites: identifier-chain resolution (disk-cache
hits, glue fallbacks, honest no-match ⇒ missing), the flagship series builder (positions →
ordered membership + missing split), sync_mode reconcile per target kind
(add/remove/reposition; append never removes), ownership recovery (marker parse from
descriptions; sidecar fallback; never mutates a collection without a recovered marker;
delete-vs-orphan), statelessness itself (kill the volume's cache + run file ⇒ next run
converges to the same target state), acquisition pacing (cap honored, oldest-first,
recency rotation surviving via the run-state file, three-writes-only confinement pin), and
contract-surface schema tests (the five nouns' zod schemas are the compatibility promise
hnet binds to).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Repo license for the public repo — MIT (ecosystem default) vs AGPL (self-hosted-tool protective)? Owner call before the repo is created. | **RESOLVED (owner 2026-07-16): AGPL-3.0.** |
| Q-02 | Source API key provisioning: owner creates the Hardcover account + token (expiry behavior UNVERIFIED) and the NYT Books API key (rate limit UNVERIFIED); both land in 1Password `HaynesKube`. | Instructions delivered 2026-07-16 (env contract: HARDCOVER_TOKEN, NYT_API_KEY; 1P item `libretto` in HaynesKube); owner provisioning. |
| Q-03 | Does Libretto share hnet's Postgres cluster (new database, one less StatefulSet) or get its own instance in its namespace (isolation, standalone-shaped)? | **RESOLVED, twice (both kept for the record): owner 2026-07-16 day — no Postgres, SQLite on the app volume; owner 2026-07-16 eve, FINAL — FULLY STATELESS, no database at all ("Kometa has no database... Stateless. Why are we stateful?"); D-01/D-03 amended accordingly.** |
| Q-04 | Public repo home + name check: `github.com/thaynes43/libretto` (name availability on GHCR/npm unchecked). | **RESOLVED (owner 2026-07-16): name works; repo created by the owner at github.com/thaynes43/libretto (bot cannot create user repos); AGPL-3.0.** |

## Appendix A — the hnet binding sequence (the doctrine payoff)

How the two queued hnet plans consume Libretto with no bespoke coupling:

1. **PLAN-052 (provider registry).** hnet's collection-manager surface registers provider
   `libretto` next to `kometa`: base URL (`libretto.haynesops.com` internal ingress) + API
   key from ESO. The provider adapter maps the R2 nouns 1:1 onto D-10's endpoints —
   recipes CRUD, validate, apply/run-state, produced collections, missing[] — with **no
   translation layer**, because Libretto implements the contract natively from day one
   (owner ruling). The recipe form renders from `GET /builders` param schemas; Kometa stays
   the constrained git-PR provider beside it (PLAN-052's own write path). Acquisition
   toggling (`variables.acquisitionEnabled`) is role-gated in hnet exactly like the
   `radarr_add_missing` knob class.
2. **PLAN-051 (books collections mirror) — zero changes.** Libretto writes real collections
   and reading lists INTO Kavita/ABS (D-06). PLAN-051's mirror syncs whatever exists in
   those servers, exactly as PLAN-037 mirrors Plex — so every Libretto-produced collection
   appears on the hnet Books/Audiobooks walls **without any Libretto-aware code in the
   mirror**. That is ADR-064's doctrine paying off: the site never needed to know who
   authored a collection.
3. **Managed vs unmanaged flagging (contract noun 6).** Where the hnet UI wants to
   distinguish "Libretto-managed" from hand-curated collections (badges, PLAN-052's
   read-only context), it joins the mirror's target-side collection IDs against
   `GET /collections` — read-only, hnet-side, still zero mirror-schema changes.
4. **Sequence:** Libretto MVP live against the estate (PLAN-054 M6) → PLAN-051 mirror ships
   independently (its quick win is hand-curated collections; Libretto's arrivals are free) →
   PLAN-052 registry binds Kometa + Libretto behind one UI. 051 and Libretto have no
   ordering dependency on each other — that independence is the design working.
