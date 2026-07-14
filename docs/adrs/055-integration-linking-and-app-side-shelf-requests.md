# ADR-055: Integration linking + app-side Goodreads shelf sync + confined LazyLibrarian requests

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** Tom Haynes

## Context and problem statement

PLAN-043 (the Integration Tab Saga) wants users to link external accounts and pull their read /
watched / wanted data into the FOSS estate. The MVP (PLAN-044) is **Goodreads → book/audiobook
requests + Missing**. The Goodreads API was retired in 2020; the durable, low-fragility access
path is **public per-shelf RSS** (verified in `.agents/context/2026-07-11-books-list-sources-research.md`
§0/§1). LazyLibrarian (LL) already has a native wishlist engine that ingests Goodreads RSS, but
its provider config is **owned by Prowlarr's fullSync** (OPS-013) — per-user RSS providers in LL
risk clobber. We need a design that (a) links per-user public shelves, (b) mirrors them app-side,
(c) matches against the library, (d) requests the gaps through LL's proven API, and (e) surfaces a
Missing view + coverage %, all without ever writing LL provider config or disturbing existing LL
Wanted entries / the MAM governor.

## Decision drivers

- **App-side end-to-end** (owner ruling R2): our sync polls RSS, our DB stores shelf state,
  matching/dedupe happens against our library mirror, requests push via the proven LL API pattern.
- **No new external write surface leaks** — the LL acquisition surface must be import-confined to
  `packages/domain`, exactly like `@hnet/arr/write` / `@hnet/plex/write`.
- **The *arr Missing idiom** (R3): every shelf want not in the library becomes a Missing entry,
  everything is queued Wanted in LL, usenet rips immediately, MAM stays behind the PLAN-039 governor.
- **No secrets** — public RSS, no OAuth. Linking = a profile URL / id.
- **ADR-046 stands**: `books_items` is a pure mirror; request/Missing state lives in NEW tables.
- **Comics are Kapowarr's domain, not LL's** (owner note 2026-07-13 — his real shelf holds Scott
  Pilgrim + Batman Zero Year alongside novels): a comic must NOT blind-fire into LazyLibrarian.

## Considered options

- **A. LL-native wishlist (config-only).** Cheapest, inherits usenet-first + the governor for free.
  **Against:** Prowlarr fullSync clobbers per-user LL RSS providers (OPS-013), no app-side
  observability, no per-user linking model, Goodreads RSS 100-item cap unmanaged. **Rejected** —
  the clobber risk is disqualifying and it can't be per-user.
- **B. App-side end-to-end (CHOSEN).** Our `goodreads-sync` mode polls each linked user's public
  shelf RSS, mirrors it, matches against `books_items`, mints requests, and pushes to LL via the
  confined write client (GB-volume → `addBook` → `queueBook` → `searchBook`). App owns the state,
  the coverage math, and the Missing view.
- **C. Hardcover / a second provider first.** Deferred — Goodreads is the owner's home (PLAN-043
  Q-01); the framework generalizes after MVP learnings.

## Decision outcome

Chosen option: **B (app-side end-to-end)** — because it is the only path that is per-user, avoids
the Prowlarr-fullSync clobber, gives us app-side observability + coverage, and keeps the LL write
surface confined and auditable.

**Shape:**

- Three new tables (migration 0045, all guard-listed single-writer): `user_integrations` (one row
  per (user, provider); link/unlink audited via `permission_audit`), `integration_shelf_items` (the
  synced shelf-RSS mirror; a rebuildable read-model, no audit — the `books_items` class),
  `book_requests` (the request/Missing ledger; per-format `ebook_status`/`audio_status` over
  requested|wanted|grabbed|landed|missing, `matched_books_item_id` nullable, `ll_book_id`,
  `unroutable_reason`; sync mint/reconcile unaudited, the manual re-search audited).
- A new confined client package **`@hnet/lazylibrarian`** — `./read` (getBook status) + `./write`
  (`addBook`/`queueBook`/`searchBook`), the `/write` subpath import-confined to `packages/domain`
  (the `@hnet/arr`/`@hnet/plex` precedent; the arr-write-import-guard extended for it). Plus a
  read-only **`@hnet/goodreads`** package (shelf-RSS fetch + vanity-URL resolve via redirect + Google
  Books enrichment with mandatory retry/backoff + comic classification).
- A new `goodreads-sync` `@hnet/sync` mode (standalone like `books-sync`; no `sync_runs` row — its
  trail is the integration tables), a future haynes-ops hourly-class CronJob.
- The domain orchestrator `syncGoodreadsIntegration` (the fix-flow discipline: external LL calls stay
  OUT of any DB transaction) + the audited `runManualBookSearch`.
- A new **`integrations` Section Permission** (`disabled` no-row default ⇒ ships Admin-only; the
  `ytdlsub`/`books` precedent) gating the new top-level Integrations tab.

**Matching + comics.** `books_items` carries no ISBN column, so library matching is normalized
title (+ author) — an honest MVP limitation (ISBN match against the mirror is a residual). Comics
count for **coverage** (they can be in the library) but are **parked out of the LL route**
(`unroutable_reason = 'comic'`, both formats Missing, never pushed): the classification signal is
the Google Books category "Comics & Graphic Novels" (or a matched library row of kind `comic`);
unreliable-from-RSS-alone is acceptable — absent a GB match we default to the LL route with the
caveat surfaced. This seeds the saga's book⇄audiobook pairing phase (and a future Kapowarr route).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: per-user public-shelf linking with NO secret and NO OAuth; a vanity URL resolves server-side to the numeric id by following the redirect. |
| C-02 | Good: the LL acquisition surface (`addBook`/`queueBook`/`searchBook`) is import-confined to `packages/domain`; no sync/api/web path can push a grab. `queueBook` is mandatory (addBook alone lands `Skipped`). |
| C-03 | Good: every request queues BOTH formats; the format that never lands stays a per-format Missing entry that supports the audited manual "Search again" — the *arr wanted/missing idiom (R3/R4). |
| C-04 | Good: the `integrations` Section Permission ships Admin-only (`disabled` default), so the owner links first, reviews screenshots, then opens it per role. |
| C-05 | Good: LL provider config is NEVER written; MAM stays behind the PLAN-039 governor; existing LL Wanted entries are undisturbed (the app only ever touches the books IT requested). |
| C-06 | Bad/residual: library matching is normalized-title (no ISBN column on `books_items`) — a future books-sync ISBN column enables the exact ISBN match the plan named. Comics are parked (no acquirer wired) until the saga pairing phase. |
| C-07 | Bad/residual: coverage % is over the synced want shelf only; the read/currently-reading shelves and the cross-provider coverage of saga point 3 are later phases. |

## More information

- PRD-001 R-178..R-184; DDD glossary T-161..T-165; DESIGN-028.
- PLAN-044 (`.agents/plans/044-goodreads-requests-mvp.md`), PLAN-043 saga master.
- Research: `.agents/context/2026-07-11-books-list-sources-research.md`,
  `.agents/context/2026-07-13-f10-english-audit.md` (the proven GB-volume → addBook → queueBook →
  searchBook pattern with 503 retry/backoff).
- Precedents: ADR-017 (`@hnet/plex/write` confinement), ADR-046 (`books_items` mirror), ADR-054
  (MAM governor — look, never touch).
