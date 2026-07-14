# PLAN-045: Integrations hub + Goodreads library-idiom redesign (owner-directed, 2026-07-14 ~00:55)

- **Status:** ACTIONABLE — owner spec'd verbally at the v0.49.0 live acceptance (with screenshot),
  then left for the night ("if you have questions ask away otherwise I'm heading off"). The three
  coordinator assumptions below were stated back to him in-session; confirm/adjust in the morning.
- **Depends on:** PLAN-044 (v0.49.0, live) + its owner-feedback fix PR (`fix/integrations-link-ux`
  — input theming, sync-on-link, never-synced state, comic classifier, ConfirmButton unlink) —
  **build ON TOP of that merge**.
- **Saga:** PLAN-043 phase "integration framework" pulled forward + the first slice of phase
  "content syncing" (all-shelves visibility).

## Owner spec (near-verbatim)

1. The v0.49.0 Integrations screen is "sloppy and doesn't follow our common theme across
   Library, Trash, Bulletin Tickets etc" — it must adopt the estate's design language.
2. Even with one integration, **Goodreads is a SUB-SECTION under the Integrations page** — not
   one flat page for all integrations.
3. **Shelf items import as Library items:** a Goodreads book we don't have appears as **Wanted
   in the Library like Movies and TV**; a book we do have "we see normally".
4. The Goodreads sub-section has **a main page with the stats** and **an items page with the
   same look and feel as Library items**, filtered by shelf: **to-read · currently-reading ·
   read · did-not-finish**.
5. Those shelf filters behave **like the Helpdesk ticket state chips**: an **All** that selects
   all four, or any combination multi-selected.

## Coordinator assumptions (stated to owner in-session; confirm at morning review)

- **A1 — requests stay to-read-only.** The other three shelves sync for display/coverage/
  retention ("what they read that we don't have"), but do NOT push LL wants and do NOT mint
  Library-Wanted tiles. Library-Wanted = to-read-sourced requests (per the no-gate Missing
  ruling in PLAN-044 R3).
- **A2 — composition, not mirror pollution.** `books_items` stays a pure Kavita/ABS mirror
  (ADR-046 hard rule). The Library walls surface Wanted via a UNION/overlay of the
  `book_requests` read-model — a new ADR (or ADR-055 amendment) records the composed-wanted
  model, mirroring how the *arr ledger shows monitored-but-missing.
- **A3 — "did-not-finish" is not a Goodreads default shelf.** Sync tolerates absent shelves
  (fetch configured shelves; 404/empty ⇒ shelf simply has no items); the DNF chip is
  populated-value-gated like every empty facet in the estate.

## Shape

1. **All-shelves sync (data):** extend the Goodreads RSS fetch + `integration_shelf_items` sync
   to `to-read`, `currently-reading`, `read`, `did-not-finish` (shelf column already exists).
   Read-model additions for per-shelf counts + the not-on-disk retention view. Request minting
   logic UNCHANGED (to-read only, per A1). Coverage: per-shelf + overall (the stats page shows
   both; the headline stays want-shelf coverage unless the owner redefines it).
2. **Integrations HUB (`/integrations`):** provider cards (Goodreads today; the saga's future
   providers slot in) following the estate's hub idiom — house tab/nav semantics (D-19:
   sub-navigation PUSHES), token cards, ADR-015 reflow-free. The link/unlink card moves INTO
   the Goodreads sub-section.
3. **Goodreads sub-section:** `/integrations/goodreads` (or `?tab=` per the house hub pattern —
   design decides, citing the Metrics/Trash precedent): **(a) main/stats page** — link state +
   the fixed link card, per-shelf counts, coverage, last-sync, request/Missing summary tiles
   (the Trash-Overview idiom); **(b) items page** — a REAL library wall: `MediaPoster` grid
   with covers where matched (cover proxy) + designed fallback tiles, the shared filter/sort
   engine, and the **shelf chips (All + multi-select combinations, counts — the Helpdesk
   state-chip idiom, `TICKET_TRANSITIONS`-era chips as the visual reference)**. Per-item state
   badges ride the poster (Have it / Wanted per format / parked-comic), the ADR-015 corner-puck
   idiom.
4. **Library-Wanted composition:** Books/Audiobooks (and Comics for parked/unroutable) walls
   gain to-read-sourced **Wanted** tiles + a Wanted facet/state filter like Movies/TV — composed
   from `book_requests` (A2), gated identically to the wall's section, deep-linking to the
   request detail/actions in the Goodreads sub-section. Registry entries (ADR-051 seam) extend
   accordingly.
5. **Requests & Missing wall** from v0.49.0 folds INTO the sub-section (its cards restyled to
   the poster idiom — the current text-tile look is the "sloppy" complaint).
6. **Docs:** new ADR (composed-wanted model + hub/sub-section structure) or ADR-055 amendment —
   next-free numbers at authoring; DESIGN-028 superseding amendment for the hub/sub-section/
   chips UX; PRD/glossary rows for Shelf, Shelf Chip semantics, Library-Wanted (books); PLAN-043
   phase-map tick.
7. **Tests:** all-shelves sync fixtures (incl. absent-DNF), per-shelf counts/coverage, chip
   multi-select semantics (All ⇄ combinations — mirror the Helpdesk spec), Library-Wanted
   composition under the ADR-047 access gate (a withheld library's wanted tiles hidden too),
   e2e hub → sub-section → items-wall journey + screenshots (desktop + 390, dark/light).

## Constraints

- Everything rides the existing section permission (`integrations` — Admin-only until rollout);
  the Library-Wanted tiles ride the BOOKS section gating (they're library state) — **flag at
  review** (Q-01 below).
- Hard rules stand: tokens-only, ADR-015, ConfirmButton for destructive, single-writer + audit,
  mirror purity (A2), governor/LL-config untouchables, GB retry/backoff, queueBook-after-addBook.
- Fable agent build (major new UX — the standing delegation lean); owner ruled the LOOK gets
  screenshot review as always.

## Open questions (morning; none block the build)

- **Q-01:** Library-Wanted tiles visibility — books-section gating (any member who sees Books
  sees household wanted tiles) vs integrations-gated while rollout is admin-only? Built per
  books-section gating with the tiles clearly badged; flip is one gate if ruled otherwise.
- **Q-02:** should the stats page headline coverage stay want-shelf-only or become all-shelves?
  (Built: headline = want shelf, per-shelf breakdown below.)
- **Q-03 (from the fix agent's classifier finding):** the already-pushed live comic want in LL —
  remove or leave? (One Wanted row; harmless meanwhile.)
