# 2026-07-18 — Google Books quota drain: consumer inventory + alternatives (owner directive)

Mission: (A) find every consumer of the shared Google Books (GB) key, (B) evaluate alternative
metadata sources for OUR resolve paths, (C) recommend + ship the justified safe slice. The 07:00
UTC daily GB quota drains within ~30 min of reset and 210 pairing wants are starved; owner "never
had this with Readarr" and cannot raise the quota.

## PART A — consumers (evidence)

The GB key = field `GOOGLE_BOOKS_API_KEY` in the shared 1Password **`media-stack`** item. Two apps
mount it estate-wide:

| Consumer | Namespace | How it uses GB | Quota-aware? | Volume |
|---|---|---|---|---|
| **LazyLibrarian** | `downloads` | `config.ini [API] gb_api` + `book_api=GoogleBooks`; every `addBook` re-resolves the volume from GB, plus periodic author/book refresh | **NO** (no memory) | **Dominant — the drain** |
| haynesnetwork web (Fix fallback) | `frontend` | `guardedGbResolve` → volume id for LL `addBook` | Yes (ADR-067 breaker) | Low, on-demand |
| haynesnetwork `goodreads` CronJob (:41 hourly) | `frontend` | shelf enrichment, `isbn:`-first then title | Yes | Low |
| haynesnetwork `format-pairing` CronJob (:32 hourly) | `frontend` | pairing mint fallback, title+author | Yes | Low |

haynesnetwork pulls the key via `dataFrom: extract media-stack` (no dedicated `data[]` ref).

**Evidence of the drain (LL pod `lazylibrarian-6db7d4875d-g47dr`, timestamps EDT = UTC-4):**
- Continuous `gb.py:828 (API-GBRESULTS)` lines — "<title> added to the books database,
  Skipped/Skipped" — i.e. GB metadata resolves on every book LL touches.
- gb.py bursts at `:32` past the hour align **exactly** with our `format-pairing` CronJob (`:32`)
  pushing `addBook` — our push feeds LL, LL re-hits GB per book (a double-dip). The `addBook`
  GBRESULTS log undercounts real GB HTTP calls (each `addBook` = search + volume GET; author
  refresh pages many volumes).
- LL has **zero** quota memory, so it burns the shared per-project quota unthrottled — this is the
  "consumer outside the frontend/media namespaces": it lives in `downloads`.

**Not consumers (corrections):**
- **Libretto** — only external metadata host is `api.hardcover.app` (Hardcover GraphQL); ISBN work
  is local checksum math (`src/identifiers.ts`). The mission's "~16 GB calls" premise is wrong; it
  makes **zero** GB calls. No egress or code change needed there.
- **Readarr** — used `bookinfo.club` (Goodreads proxy), never GB. Explains "never had this problem."
  (Readarr is now retired upstream.)
- Kapowarr/Kavita/Calibre-web — no GB key mounted (only LL's externalsecret references it).

**Quota scope:** GB "Queries per day" is a **Google Cloud per-project** quota (project
`841331826441`), aggregated across all keys in the project. A second key in the SAME project adds
**no** headroom. Owner cannot raise it.

## PART B — alternatives for OUR paths

**What we need from GB:** a **Google Books volume id** — it is LL's `addBook` key
(`@hnet/lazylibrarian/write` `addBook&id=<gb volume id>`, because LL `book_api=GoogleBooks`), and
the comic-classification source. This is the coupling that defeats a source swap:

- **Open Library** (keyless, `/isbn/<isbn>.json` + `/search.json`, generous limits): strong ISBN
  coverage, verifies title/author, subjects usable for comic classification. **But** it returns OL
  work/edition ids, **not** GB volume ids → cannot feed LL `addBook`. Title-search fuzz is weaker
  than GB's `intitle:+inauthor:`.
- **Hardcover** (already used by Libretto's `hardcover_series` builder): series/identity, not a
  drop-in ISBN→GB-volume resolver; same "wrong id namespace" problem.
- **LL-direct** (let LL resolve by title/ISBN via `findBook`/`searchBook`): spends LL's **own** GB
  quota (same project) and bypasses our comic guard — no net win.
- **Readarr proxy**: retired / Goodreads-dead; not usable.

**The 27 ISBN-bearing vs 183 title-only wants — honest read:** pairing wants anchor on
`books_items` (Kavita/ABS mirror), which has **no ISBN column** — so the *pairing* path is 100%
title-only by construction and cannot benefit from an ISBN endpoint at all. ISBNs enter the estate
only via the **goodreads shelf** path (`integration_shelf_items.isbn` from RSS), where the resolve
already passes `isbn:` first to GB. So:
- The ISBN-bearing wants resolve BEST where they already do — a GB `isbn:` lookup (or an OL ISBN
  lookup for *verification*), but the pushable output still needs the GB volume id.
- The title-only pairing wants resolve BEST with GB's `intitle:+inauthor:` (OL title-search is
  weaker) — and, again, only GB yields the LL key.
- **Net:** no alternative source removes GB from any pushable path under the current
  `book_api=GoogleBooks` architecture. The starvation is architectural/config, not a source choice.

**Egress:** app namespaces (`frontend`/`downloads`/`media`) have **no** CiliumNetworkPolicy →
open egress → reaching `openlibrary.org` from the app needs **no** haynes-ops PR. Only the `dev-env`
pod + `upgrade-agent` are allowlist-restricted (this pod cannot reach `openlibrary.org`, confirmed
by a refused WebFetch — so OL probing must run from the app, not here).

## PART C — recommendation + what shipped

**Primary fix (owner action, config, NOT code — highest leverage):** decouple LazyLibrarian from
the shared key. Because the quota is per-project, give LL a GB key from a **separate GCP project**
(its own free daily quota) in `config.ini [API] gb_api`. This removes the dominant consumer from
our key while preserving the proven GB-volume-id `addBook` pipeline. LL config lives on the PVC
(via LL `writeCFG`), not git — so this is an owner UI/config action; the `media-stack`
ExternalSecret only transports the value. **Left OPEN for the owner** (needs GCP console + LL config
write; the read-only ops pod cannot do either, and a git ExternalSecret change would reference a
not-yet-existing 1Password field). Alternative: switch LL to `book_api=OpenLibrary`, but that breaks
the GB-volume-id coupling — a coordinated program, not tonight.

**Shipped (haynesnetwork PR — safe, in-scope, no new deps/egress, no release train):** widen the
`mintPairingWants` `llBookId` reuse index from `origin='goodreads'` to `origin IN
('goodreads','pairing')`. A pairing want whose same-work sibling (its format twin, or a shelf
request) already resolved a GB volume id now mints with **zero** GB calls — a genuine GB-avoidance
that keeps the pairing backlog draining on a quota-exhausted day. Same title-norm + author-agreement
contract; no comic/resolve-guard changes; +1 focused test. Design recorded as the DESIGN-039
amendment (D-14..D-17).

**NOT done (out of scope / not justified):** an Open Library ISBN-first leg in our resolve chain
(cannot yield the LL key; touches the comic guard = high blast radius for no root-cause fix);
routing pairing through LL-direct (spends LL's GB quota, loses the comic guard). Kometa/collections
+ /admin untouched. No migration needed.
