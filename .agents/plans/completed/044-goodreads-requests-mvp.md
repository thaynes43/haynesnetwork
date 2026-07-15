# PLAN-044: Goodreads requests MVP — Integrations tab, shelf sync, Missing + manual search

- **Status:** Completed — shipped v0.49.0 (#253) + the v0.50.x–v0.55.x owner-feedback arc; live sync proven on the owner's real account; OWNER RATIFIED 2026-07-15. The MVP of the
  **Integration Tab Saga (PLAN-043)**. One plan = one release.
- **Depends on:** nothing open (PLAN-029 shipped v0.47.0; the LL API pattern is proven; the
  Goodreads RSS mechanism is verified in `.agents/context/2026-07-11-books-list-sources-research.md`).

## Owner rulings (2026-07-13 — normative)

- **R1 accounts:** OWNER LINKS FIRST (he will create a Goodreads account and make shelves
  public); the sister and other members link after the screenshot review. Linking is per-user.
- **R2 flow: APP-SIDE END-TO-END.** Our `@hnet/sync` mode polls the public shelf RSS, our DB
  stores shelf state, matching/dedupe happens against our library mirror, and requests push to
  LazyLibrarian via the proven API pattern (GB-volume/ISBN → `addBook` → **`queueBook`
  (mandatory — addBook alone lands `Skipped`)** → `searchBook`). **NEVER write LL provider
  config** (Prowlarr fullSync owns it — OPS-013).
- **R3 gating: NONE — the *arr idiom.** Every shelf want not in the library becomes a
  **Missing** entry (like the *arr-backed libraries' wanted/missing), everything is queued
  Wanted in LL, **SAB/usenet rips through whatever it can immediately**, and MAM stays behind
  the PLAN-039 governor exactly as today. No approval gate, no admission cap (LL/GB API calls
  are still POLITELY PACED — the 58-item F-10 wave is the throughput precedent).
- **R4 scope: FULL** — linking + shelf sync + requests + request/Missing status + **coverage %**
  ("we have N% of your shelf") + **manual re-search** on Missing entries, all in this slice.
- **Both formats always:** every request queues ebook AND audiobook wants ("we grab both so
  it's one for all"). A format that never lands stays a per-format Missing entry (seeds saga
  point 5).

## Shape (db → domain → client → api → ui, the house vertical)

1. **DB (migrations: take next-free numbers at build — re-grep `packages/db` first; 0042–0044
   were consumed by PLAN-029):**
   - `user_integrations` — one row per (app user, provider); provider `'goodreads'` v1; stores
     the Goodreads user id / profile ref + link status + last-sync marker. Single-writer,
     audited, guard-listed.
   - `integration_shelf_items` — the synced RSS mirror: (integration, shelf, external book id,
     title, author, ISBN/GB keys when derivable, shelved-at). Sync-owned read-model,
     guard-listed.
   - `book_requests` — the request/Missing ledger: (source integration, shelf item, matched
     `books_items` id nullable, per-format status `ebook`/`audiobook` ×
     `requested|wanted|grabbed|landed|missing`, LL book id, timestamps). Sync-updated from LL
     status; single-writer, audited, guard-listed.
2. **Client:** a new confined **LazyLibrarian client** (read + a `/write` subpath import-confined
   to `packages/domain`, the `@hnet/arr`/`@hnet/plex` precedent) — reads: book status/wanted;
   writes: `addBook`/`queueBook`/`searchBook`. Plus a small Goodreads RSS fetcher (feedparser
   semantics; tolerate the feed's field sparseness; GB enrichment with MANDATORY retry/backoff).
3. **Domain:** `linkIntegration`/`unlinkIntegration` (audited); `syncGoodreadsShelves`
   single-writer (upsert shelf items, match against `books_items` by ISBN → title/author
   fallback, mint requests for unmatched wants, push to LL paced, reconcile LL statuses →
   request states, compute coverage); `requestManualSearch` (the confined `searchBook` write —
   the PLAN-041-anticipated acquisition write).
4. **Sync:** a `goodreads-sync` `@hnet/sync` mode (standalone like `books-sync`), future
   haynes-ops CronJob (hourly-class; RSS is cheap — LL pushes are what need pacing).
5. **API:** `integrations.link/unlink/status`, `integrations.shelf` (synced view + coverage),
   `integrations.requests` (the request/Missing wall), `integrations.search` (manual re-search),
   all session-gated + section-gated.
6. **UI — the Integrations tab:** new top-level nav entry gated by a NEW Section Permission
   **`integrations`** (`disabled` no-row default ⇒ **ships Admin-only**; owner opens per role
   after review — the `ytdlsub`/`books` precedent). Views: link card (enter profile URL/user id →
   validate RSS reachable → linked state); shelf summary + **coverage %**; the **requests/Missing
   wall** (poster-wall idiom where art exists via the cover proxy; per-format status chips;
   manual "Search again" via ConfirmButton-free plain action — it's non-destructive); ADR-015
   reflow-free; tokens-only; 320/390 portrait-safe.
7. **Docs-first artifacts authored IN the build PR** (assign next-free numbers at authoring —
   re-grep docs/adrs, docs/designs, the PRD, the glossary, migrations): an ADR (integration
   linking + app-side shelf sync + the confined LL write surface + the Missing model), a DESIGN
   (Integrations tab + requests/Missing UX), PRD R- rows, glossary T- terms (Integration, Shelf
   Sync, Book Request, Missing (books), Coverage), and the PLAN-043 saga cross-reference.
   Update `docs/domain-driven-design/001-ubiquitous-language.md` in the same change (hard rule).
8. **Tests:** RSS fetcher parsing (fixture feeds incl. sparse entries); match/dedupe (ISBN hit,
   title/author fallback, already-in-library); request minting + BOTH-format queue + `queueBook`
   requirement; LL status reconciliation → per-format Missing; coverage math; permission seams
   (disabled section ⇒ FORBIDDEN; unauth 401); pacing/backoff unit. **e2e:** stub Goodreads RSS
   server + stub LL endpoints in the hermetic stack (hard rule: every new external system gets a
   stub), spec covering link → sync → request wall → manual search.

## Hard constraints (mission-failure to violate)

- MAM gate/governor/Prowlarr indexer: LOOK, NEVER TOUCH. LL provider config: NEVER WRITE.
- GB retry/backoff on every call; LL API paced; `searchItem` is not a title search.
- No secrets introduced (public RSS; no OAuth). Nothing lands in git but code/docs.
- Live LL state: do not disturb existing Wanted entries (ToG bk1, Heir of Fire audio, KoA epub,
  F-09 corrupt three, the F-10 58-wave).
- ADR-046 stands: `books_items` stays a pure mirror — request/missing state lives in the new
  tables, NEVER bolted onto the mirror.

## Acceptance (live, against prod after deploy)

1. Owner links his real Goodreads account in the tab; sync pulls his public shelves.
2. Want-to-read items not in the library appear as requests queued in LL (both formats,
   Wanted, correct titles — spot-check ≥3), usenet searching immediately; MAM untouched
   (governor state unchanged).
3. Coverage % renders and is arithmetically right for his shelf.
4. A request with no grab shows per-format **Missing**; "Search again" fires a real LL
   `searchBook` and the action is audited.
5. Unauth/ungranted access: 401/FORBIDDEN; the tab is absent for non-admin roles.
6. Hermetic screenshots (desktop + 390, dark/light) captured for the owner review.

## Owner-side (needed before live acceptance, NOT before build)

- Create the Goodreads account, set shelves PUBLIC, populate a few Want-to-Read titles, and
  provide the profile URL/user id (in-session or via the linking UI at review).
