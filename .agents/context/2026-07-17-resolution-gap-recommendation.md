# GB/LL RESOLUTION GAP — investigation + recommendation (owner ruling)

- **Date:** 2026-07-17
- **Author:** agent (read-only investigation; no production behavior changed, no acquisition run)
- **Decision asked of owner:** one yes to the recommended direction in §5.
- **TL;DR:** The measurable resolution gap is NOT the Libretto M3 path the PLAN-059 addendum
  spotlighted — it is the **format-pairing (`origin='pairing'`) path inside this repo**, and it is
  failing for a one-line reason: **the pairing GB resolve drops the anchor ISBN**. Goodreads (which
  passes ISBN) resolves 98/99 wants; pairing (which passes title-only) resolves 70/280. Fix = feed
  the ISBN the library already holds into the resolver that already knows how to use it.

---

## 1. The two resolution paths (and why only one is broken)

There are **three** acquisition mechanisms; two run through hnet's own hardened resolver, one does not.

| Path | Where resolution happens | Passes ISBN? | Uses v0.70.1 hardening? | Live result |
|---|---|---|---|---|
| **Goodreads shelf** (`origin='goodreads'`) | hnet, `packages/sync/src/goodreads.ts:129` → `guardedGbResolve` → `GoogleBooksClient.resolveVolume` | **Yes** (`{ isbn, title, author }`, goodreads.ts:132) | Yes | **98/99 resolved (99%)** |
| **Format pairing** (`origin='pairing'`) | hnet, `packages/domain/src/format-pairing.ts:548` → `guardedGbResolve` → same client | **No** (`{ title, author }` only — seam at format-pairing.ts:286) | Yes | **70/280 resolved (25%)** |
| **Libretto M3 recipes** (collections, ns `media`) | External Libretto service → LL `addBookByISBN` / `findBook` directly | Libretto has no GB key | No (never touches hnet code) | ~0 (separate concern, §4) |

The v0.70.1 fix-resolver hardening (pre-colon fallback, surname-token author guard, series-index
prefix strip, title-token coverage guard) lives in the **shared** resolver
`packages/goodreads/src/google-books.ts` (`resolveVolume`, lines 244-320). Both the Goodreads
acquisition path and the pairing acquisition path already call it through `guardedGbResolve`
(`packages/domain/src/gb-quota-breaker.ts`). **So the task's hypothesised cheap-win — "does
acquisition just need the v0.70.1 hardening ported to it?" — is answered: no. Acquisition already
has the hardening.** The real defect is narrower and cheaper.

### Why pairing resolves ~4x worse than Goodreads — the smoking gun

`GoogleBooksClient.resolveVolume` tries `isbn:<isbn>` **first** (google-books.ts:249-253, "the most
reliable key"), then falls back to the fuzzy `intitle:+inauthor:` leg. The ISBN leg is exact and
skips every title-normalization hazard.

- Goodreads RSS carries an ISBN per item → the reliable leg fires → 99% resolution.
- Pairing anchors library items whose **titles are file-derived and messy** ("Expanse 05 - Nemesis
  Games", "Wheel of Time [09]: Winter's Heart", "Lily Bard #05 - Shakespeare's Counselor", "The
  Summer I Turned Pretty [Summer, Book 1]"), and the pairing resolver seam (`PairingGbResolver`,
  format-pairing.ts:286) has **no `isbn` field at all** — `mintPairingWants` never selects
  `books_items.isbn` (query at format-pairing.ts:457-464) and passes only `{ title, author }` to
  `guardedGbResolve` (line 550). The reliable ISBN leg **can never fire for pairing**, so every
  pairing want is decided by the fuzzy title leg against a file-title. Hence 25%.

`books_items.isbn` **exists and is populated** for ABS audiobooks (schema line 97: "isbn: ABS
`media.metadata.isbn`"; Kavita ebooks are null by design). The data is sitting in the row, unused.

---

## 2. Size of the prize (live frontend-ns DB, read-only Job, 2026-07-17)

Book/audio wants (`comic_status IS NULL`) in `book_requests`:

| Origin | Resolved (`ll_book_id` set) | Unresolved (`ll_book_id` NULL) | Resolution |
|---|---|---|---|
| goodreads | 98 | 1 (a magazine) | 99% |
| **pairing** | **70** | **210** | **25%** |

**The entire resolution gap is the 210 stuck pairing wants.** Breakdown by anchor:

| Anchor kind | Anchor has ISBN? | Unresolved | (Resolved, for contrast) |
|---|---|---|---|
| audiobook (wants ebook) | **yes** | **27** | 8 |
| audiobook (wants ebook) | no | 49 | 16 |
| book (wants audiobook) | no (Kavita ⇒ null ISBN) | 134 | 46 |

- **27 stuck wants have a valid anchor ISBN that is simply not being passed** — these are the
  immediate flip (77% of ISBN-bearing audiobook anchors are stuck despite holding an ISBN — e.g.
  "Parable of the Sower" 9781538765494, "Phantoms"/Koontz 9780425181102, "The Singularity Trap"
  9781680680881 — all clean titles with valid ISBNs, unresolved only because the ISBN never reaches
  the resolver).
- **183 stuck wants have no ISBN** (49 audiobook + 134 book). Kavita ebooks carry null ISBN by
  design, so the book-anchored 134 need the **title-normalization** lever, not ISBN.
- **Backlog behind the gap:** 1,526 unpaired candidates total (993 book + 533 audiobook) vs only 280
  pairing wants minted so far. The mint is capped at `PAIRING_MINT_CAP_PER_RUN=25`/run (hourly), so
  it is early in draining — but of what it HAS attempted, 3-in-4 fail. Resolution quality, not pace,
  is the binding constraint, and it compounds: a low hit-rate wastes the scarce GB quota (§3) on
  doomed fuzzy queries.

### GB quota is currently exhausted (and this is a recurring daily ceiling)

`gb_quota_state`: `exhausted_until = 2026-07-18T07:00:00Z`, tripped **2026-07-17T08:41 UTC** on a
daily 429. **The reset is 07:00 UTC** (schema comment `gb-quota-state.ts:8`, `GB_DAILY_RESET_UTC_HOUR`)
— not ET. So right now every GB-requiring resolve is being skipped (`skippedQuota`); pairing runs
reuse-only until 07:00 UTC tomorrow. With a 1,526-item backlog plus Goodreads plus book-fix all
drawing on one daily GB quota that already empties before 09:00 UTC, **quota is a systemic ceiling** —
and ISBN-first resolution is also the cheapest way to relieve it (an `isbn:` hit is one call; a title
miss burns two-to-three calls per want on the fallback + fetchVolume confirm).

---

## 3. PLAN-059 addendum — the three candidate directions (Libretto M3 path)

The addendum's three directions all concern the **Libretto** path (§4 below), which is a distinct,
smaller, cross-repo problem. Summarized with tradeoffs:

- **(a) hnet-side resolve broker.** hnet holds the estate GB key and resolves ISBN→volume-id
  reliably; expose an endpoint Libretto calls to get a resolved LL volume id.
  *Pro:* reuses the exact hardened+ISBN-first resolver; closes the gap deterministically.
  *Con:* weakens Libretto's design independence; needs a Libretto-side change (media-repo, cross-repo).
- **(b) enrich the Hardcover builder to emit GB-indexed edition ISBNs.** Make Libretto hand LL ISBNs
  GB actually indexes. *Pro:* keeps Libretto independent. *Con:* fragile (chasing GB's index
  coverage per edition); does nothing for the in-repo pairing gap.
- **(c) accept GB-indexed-only + daily retry.** Do nothing; let new titles resolve as GB indexes
  them. *Pro:* zero work. *Con:* leaves the prize on the floor indefinitely; new NYT ISBNs may never
  cleanly index.

Direction **(a)** is the right long-term Libretto answer because it is the same principle as the
pairing fix (hnet owns reliable ISBN→volume-id resolution). But Libretto is not where the measurable
prize is.

---

## 4. Why Libretto is the smaller/secondary concern

Libretto M3 runs as an external service (ns `media`); hnet only drives it via REST
(`upsertRecipe`/`applyScope`/`getRun` — `packages/libretto/src/{read,write}.ts`). Its per-book
resolution happens **inside Libretto against LL directly**, with no GB key, so it produces collections
in the media namespace and **never writes `book_requests`**. Its "~0 resolves" is real but (i) unmeasured
in our ledger, (ii) lower volume than the 210-want pairing gap, and (iii) blocked on a cross-repo
Libretto change. It should follow the pairing fix, not precede it.

---

## 5. RECOMMENDATION — one yes

**Adopt "hnet ISBN-first resolution," applied first to the in-repo pairing path (the measurable
210-want prize), and later exposed as the resolve-broker endpoint for Libretto (the addendum's
direction (a)).** Concretely, ship the pairing fix now as one PR in this repo; treat Libretto
direction (a) as the sequenced follow-up (separate PR, media-repo coordination).

### PR-1 — pairing ISBN + title-normalization fix (this repo, one PR)

**Win 1 (cheap, high-impact — pass the anchor ISBN).**
- `packages/domain/src/format-pairing.ts`:
  - `mintPairingWants` candidate query (lines 457-466): add `isbn: booksItems.isbn`.
  - `PairableItem` (lines 53-59): add `isbn: string | null`.
  - `PairingGbResolver` seam (line 286): widen to `resolveVolume({ isbn?, title, author? })`.
  - `guardedGbResolve` call (lines 548-552): pass `isbn: item.isbn` in the query.
  - No new GB calls on the happy path — an ISBN hit *replaces* the fuzzy leg and is one call.
- **Expected immediate effect:** the 27 ISBN-bearing stuck wants flip; every future
  audiobook-anchored want resolves via the reliable leg. Also cuts GB quota burn per want.

**Win 2 (medium — normalize library file-titles).**
- `packages/goodreads/src/google-books.ts` `gbQueryTitle` (lines 88-95): extend to strip
  leading `SeriesName NN - ` / `[NN]` / `#NN` prefixes and trailing `[...]` brackets (today it only
  strips trailing `(...)` and a leading bare-numeric `NN - `). This is the **shared** query
  de-noiser, so it also lifts the Goodreads and book-fix paths.
- **Guard rails already present:** the title-token coverage guard (`gbResolveTitleMatches`, 60%)
  and surname author guard (`gbAuthorsMatch`) both run on the fuzzy leg, so more-aggressive stripping
  cannot mint a wrong-work volume — a bad strip fails the coverage/author guard and returns null (an
  honest gap), never a wrong book. Keep bare-numeric and slash-date titles untouched (existing carve-out).
- **Expected effect:** meaningfully raises the 183 no-ISBN wants' hit rate (esp. the 134
  book-anchored), which have no other lever.

**Optional Win 3 (cheap, follow-on) — backfill Kavita ISBNs.** The book-anchored 134 are stuck
largely because Kavita ISBN is skipped in the mirror (schema note line 91: "the heavier
series-detail call we skip → null"). Fetching Kavita ISBNs in the books-sync would give Win 1 a
second, larger population. Larger change (touches `@hnet/sync` + an extra Kavita call per item) —
propose as a separate ticket, not part of PR-1.

**Test strategy (PR-1):**
- Unit (`packages/domain/__tests__/format-pairing.test.ts`): a pairing want whose anchor has an ISBN
  resolves via the injected resolver's `isbn:` branch (assert the resolver received `isbn`); a
  null-ISBN anchor still falls back to title+author (no regression).
- Unit (`packages/goodreads/__tests__/google-books.test.ts`): `gbQueryTitle` cases —
  "Expanse 05 - Nemesis Games" → "Nemesis Games", "Wheel of Time [09]: Winter's Heart" →
  "Winter's Heart", "The Summer I Turned Pretty [Summer, Book 1]" → "The Summer I Turned Pretty";
  and negative-guard cases ("1984", "11/22/63" untouched).
- Offline throughout (injected `resolveVolume` seam — ADR-010), Postgres via test-utils; no live GB.
- **Verification before merge:** dry-run the format-pairing mode against a seeded stack and confirm
  the ISBN-bearing fixtures resolve; then on staging, watch one `haynesnetwork-sync-format-pairing`
  run's `minted`/`pushed`/`unmintable` deltas (do NOT run acquisition from this investigation).

**Risk:** Low. Win 1 is additive (ISBN is tried before, and independent of, the existing title leg —
strictly more resolves, never fewer). Win 2 is guarded by the existing coverage + author guards, so
its downside is a *missed* resolve (honest null), never a wrong-work push. Both are behind the same
paced, capped, idempotent mint that is already live. GB quota is respected by the existing breaker;
Win 1 *reduces* quota pressure.

### Sequenced follow-up — Libretto direction (a) (separate PR, media-repo)

Once PR-1 proves the hnet ISBN-first resolver in production, expose it as a small internal endpoint
(`resolve ISBN|title+author → LL volume id`) that Libretto calls in place of its keyless
`addBookByISBN`/`findBook`. Same resolver, same hardening, same ISBN-first behavior — this is the
addendum's direction (a), and it becomes low-risk because the resolver is already battle-proven by
the pairing fix. Leave (b) and (c) unadopted.

---

## 6. Files cited

- `packages/goodreads/src/google-books.ts` — shared resolver; `resolveVolume` (244-320, ISBN-first
  249-253), `gbQueryTitle` (88-95), guards `gbResolveTitleMatches` (135-144) / `gbAuthorsMatch` (102-112).
- `packages/domain/src/format-pairing.ts` — pairing mint; ISBN-less seam `PairingGbResolver` (286),
  candidate query (457-466), resolve call (546-561).
- `packages/sync/src/goodreads.ts` — Goodreads path passing ISBN (129-133) — the contrast.
- `packages/domain/src/goodreads-sync.ts` — the LL push chain (addBook→queueBook→searchBook).
- `packages/db/src/schema/books-items.ts` — `isbn` column (97) + Kavita-null note (90-91).
- `packages/db/src/schema/book-requests.ts` — `ll_book_id` (70), `origin` (55), pairing keys.
- `packages/db/src/schema/gb-quota-state.ts` — quota breaker; 07:00 UTC reset (8).
- `packages/domain/src/book-fix.ts` — fix path sharing `guardedGbResolve` (342, 488) + item-author-at-execute (285-296).
</content>
