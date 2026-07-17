# PLAN-056: Books walls — Wanted items break sorting + a three-state Wanted selector

- **Status:** Completed (v0.68.0 live — server-composed honest sort + All·Only·Hide selector). Was: BUILT (2026-07-16, branch `fix/plan-056-wanted-sort` — local five-green gate; PR /
  deploy / live validation pending).
- **Owner report (verbatim-in-intent):** "There seems to be a problem sorting books. Wanted is
  always at the top for Books and Audiobooks in Library, likely Comics too but we have none
  Wanted yet. We have the 'Wanted Only' button but I'd also like to work in 'Hide Wanted'
  somehow to the selector."

## Shape

1. **Sort bug first (triage in-plan):** the composed Library-Wanted view (PLAN-045 / ADR-057 —
   wanted items composed into the Books/Audiobooks/Comics walls) appears to pin Wanted rows
   above library rows regardless of the active sort. Determine whether that is deliberate
   composition order or a sort-key artifact (wanted rows lacking the sorted field, e.g. null
   author/added-at sorting first) and make the walls sort the COMPOSED set honestly: a Wanted
   item participates in the chosen sort like any other card.
2. **Three-state Wanted selector:** the existing "Wanted only" control becomes All · Wanted
   only · Hide wanted (segmented or chip cycle — pick the idiom the wall already uses; ADR-015
   reflow rules; URL param refinement semantics per D-19, replace-in-place). Server-side
   filtering (the wall reads are server-authoritative).
3. Applies to Books, Audiobooks, AND Comics walls (the composition is shared).

## Triage finding (step 1 — recorded)

The pinning was **deliberate composition order, not a null-sort-key artifact**. DESIGN-029
amendment-1 ruled "Wanted items merge INLINE at the head of the flat book wall's item stream",
and `books-browser.tsx` implemented that literally: the client concatenated the whole
`books.wanted` overlay AHEAD of the `books.search` page ("Wanted cards lead the flat stream").
The overlay never participated in the active sort at all — `books.wanted` returns
newest-shelved-first and the wall prepended that list verbatim, regardless of `?sort=`.

## Built

1. **Honest sort participation (server-composed).** `books.search` gained a three-state `wanted`
   input (`all | only | hide`, default `all`) and, under `all`, composes the wanted overlay INTO
   the paged stream server-side: one SQL UNION of the item query and the bounded wanted list as a
   `VALUES` bind, both sides carrying the same per-sort key columns, ordered and offset-paged by
   Postgres (`kind: 'item' | 'wanted'` discriminated entries on the wire; the client concatenation
   is deleted). Sort-key mapping (`wantedPrimarySortValue`; DESIGN-029 amendment 3 documents it):
   title/author from the request snapshot; the request's `created_at` for the Added sort (newly
   exposed on `WantedBookRequestView`); NULLS LAST for year/released/duration/pages (a want has no
   edition metadata); `position` never composes. The `added` sort gained a `sort_title` tiebreak
   on BOTH paths (one sync transaction stamps many rows — same-instant ties are real).
2. **The three-state selector.** All · Wanted only · Hide wanted on the wall's existing `.seg`
   idiom (zero new components; fixed labels, recolor-not-reflow — ADR-015). `?wanted=only|hide`,
   absent = All; replace-in-place (D-19); legacy `?wanted=1` reads as Wanted-only. Server-
   authoritative: `hide` excludes wanted rows inside `books.search` (never a client/CSS hide);
   `only` returns the query-narrowed wants alone, in the active sort. The D-09 honesty rule (a
   want answers only the text query; facets/letter/read-state/drills exclude it) is enforced
   server-side too. Applies to Books, Audiobooks, AND Comics (shared composition).
3. **Docs:** DESIGN-029 amendment 3 (supersedes amendment-1's head-of-stream placement + the
   two-state toggle; card anatomy/gating/detail-page flow stand). PRD: **no new R row** (the lean
   ruled in-kickoff) — a fix + a small UX refinement of the existing composed-Wanted surface
   (R-188..R-191), not a new requirement.
4. **Tests:** `packages/api/__tests__/books-wanted-sort.test.ts` (embedded PG) — a wanted
   'Aardvark Adventures' sorts FIRST under Title A–Z and NOT first under Pages (the pinning
   asserted GONE); author-snapshot + created_at participation; union-cursor paging without
   duplicate/dropped wants; the three states server-side (hide excludes / only exclusive / all
   both); the honesty rules. e2e `integrations.spec.ts` — the selector round-trip
   (`?wanted=only|hide` URL ↔ wall) + sorted-composition assertions.

## Open questions

- Q-01: default state stays "All" (current behavior minus the pinning)? (Lean: yes.) —
  **RESOLVED: yes.** Default = All; the URL param appears only for the two non-default states.
