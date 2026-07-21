# ADR-075: Unified Books wall — one library over both formats, format as a facet

- **Status:** Accepted (owner rulings, remote-control session 2026-07-20: scope "Both, in
  parallel" — unify the walls AND make collections format-agnostic; Accept authority per the
  plan-loop precedent, ADR-065 style)
- **Date:** 2026-07-20
- **Deciders:** Tom Haynes (rulings 2026-07-20, recorded in
  `.agents/context/2026-07-20-books-unification-rulings.md`) · drafted by Fable 5
- **Builds on / refines:** [ADR-046](046-books-library-ledger-source.md) (the `books_items`
  mirror, `books` section gate, cover proxy — ALL STAND untouched; only the C-06 wall
  taxonomy is refined, the same way R-221's detail page refined C-06's "no in-app detail
  page"), [ADR-065](065-book-audiobook-format-pairing.md) (the pair cache becomes the JOIN
  powering this wall — STANDS), [ADR-051](051-library-views-and-sort-filter-registries.md)
  (C-01 "a registry-row edit, never a new component" is how the merge lands),
  [ADR-052](052-per-user-library-preferences.md) (per-wall preferences — one wall key
  retires), [ADR-053](053-per-user-watch-read-state-attribution.md) (ABS-only read state —
  the honest gap survives as a data-gated facet), [ADR-057](057-integrations-hub-all-shelves-composed-wanted.md)
  (composed Wanted — the pairing-tile composition changes here). Sibling:
  [ADR-076](076-format-agnostic-collections.md) (the collections leg of the same rulings).
  Nothing is superseded.

## Context and problem statement

The Library renders books as three sibling walls — Books (Kavita ebooks), Audiobooks (ABS),
Comics — split by `books_items.media_kind`. That split predates the estate's format
doctrine. Since then:

- **Acquisition is already format-agnostic.** Every want queues BOTH formats in
  LazyLibrarian (PRD R-180, owner ruling "both formats always"), and ADR-065 auto-mints the
  missing format for every single-format library title, estate-wide, paced.
- **The pair truth is persisted.** `books_format_pairs` declares which Kavita `book` row and
  ABS `audiobook` row are the same title; the walls already render a work-level coverage
  badge ("Ebook + Audio / Ebook only / Audio only", T-185); the detail page already renders
  both consume buttons for a pair.
- **The walls converge toward duplicates.** Live 2026-07-20: ~331 paired works render on
  BOTH walls; ~1,538 singletons render on one — and every pairing-want landing moves a title
  from the second set to the first. The end state of the doctrine is every work on both
  walls twice.

The owner asked (2026-07-20) whether ebooks and audiobooks should be one "Books" library
with a format filter, and ratified the recommendation to unify. Splitting was the honest v1
when no cross-format truth existed; with ADR-065 shipped, the split walls now hide the
coverage story the estate is actively paying (GB budget, MAM spend) to complete.

## Decision drivers

- **The work is the unit the estate already operates on** — wants, pairing, coverage badges,
  and the both-formats doctrine all treat "the title" as primary and format as an attribute.
- **Duplication grows daily** by design (ADR-065 C-06); a split presentation ages badly.
- **One place to see coverage** — "Ebook only, audio in flight" is the actionable state; two
  walls split it across tabs.
- **Registry seam** (ADR-051 C-01): the merge is registry rows + one read-model change, not
  new components; the unified-media-action doctrine (ADR-071) keeps action language shared.
- **Comics do not pair** (ADR-065 C-08) and acquire via Kapowarr — no reason to disturb them.
- **Mirror purity** (ADR-046): presentation-only change; rows stay per `(source,
  external_id)`, sync untouched.

## Considered options

1. **Keep the split walls** (status quo). Rejected: the duplication and split coverage story
   worsen monotonically as pairing wants land; the walls become near-mirror images.
2. **One Books wall, pair-collapsed work cards, format as a facet** (chosen).
3. **One wall by simple interleave (no collapse)** — union the rows, keep two cards per
   paired work. Rejected: the paired half of the estate double-renders on the very wall
   meant to unify it, and a format facet over duplicate cards miscounts works.

## Decision outcome

Chosen option: **2 — one Books wall over `media_kind ∈ {book, audiobook}`, pair-collapsed,
with a three-state format facet.** Comics stay their own wall.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **The Audiobooks tab retires.** Library tab order becomes **Movies \| TV \| Music \| Peloton \| YouTube \| Books \| Comics \| Activity \| My Fixes** (My Fixes last, standing rule). The `books` Section-Permission gates Books + Comics exactly as before (T-138 wording updates; no permission migration). The `/collections` manager's Books/Audiobooks sub-tabs merge into one Books tab (ADR-076 C-03 renders merged recipes there once). |
| C-02 | **`books.search` returns WORK cards.** Live `book`/`audiobook` rows LEFT-JOIN `books_format_pairs`; a paired (book, audio) duo collapses to ONE card anchored on the **ebook row** (deterministic; matches the `BOOKS_MEDIA_KINDS` tie-break precedent) with the partner's metadata (narrator, duration, language, read state) carried for facets/sorts; the card links to the anchor's detail page, which already renders both consume buttons (ADR-065). Unpaired rows render as today with their coverage badge. Facet/sort counts are WORK counts. |
| C-03 | **Format is a three-state segmented control** — All · Ebook · Audiobook (`?format=`), availability semantics: "Ebook" = works holding an ebook (paired + ebook-only). With exactly two formats, a multi-select chip set's meaningful states collapse to these three, so the seg (the shipped Wanted-filter grammar) wins; revisit multi-select only if a third format ever exists. The old Books-wall `fmt` (epub/…) facet relabels to **File** and keeps its param. |
| C-04 | **Facets/sorts union with data-gating** (ADR-051 C-06 "no dead chip"): Author, Genre, Wanted are universal; Narrator, Series, Language, Length, Read gate on audio-carrying works (ADR-053's Kavita read-state gap stays honest); Pages and File gate on ebook-carrying works. Default view stays **grouped by Author** (both retiring walls already defaulted to it). |
| C-05 | **Pairing wants stop double-rendering.** On the unified wall a pairing want's anchor work ALREADY renders as a library card — so standalone pairing-want tiles retire; the anchor card's coverage badge carries the missing-format want state (wanted / in-flight), and the detail page keeps the pairing-want deep link + per-format force-search (ADR-065 C-05 unchanged). Goodreads-origin wants (no library anchor) keep their Wanted tiles. The Wanted seg filters over both forms. |
| C-06 | **Per-user preferences:** the `audiobooks` wall key retires; orphaned preference rows are dropped in the migration (users re-pick once — honest, cheap). ADR-052 mechanism otherwise unchanged. |
| C-07 | **URL compatibility:** the old Audiobooks tab/URL state redirects to Books with `format=audiobook` preselected; shared links keep meaning. Wall-level view/sort params ride unchanged (DESIGN-026 D-10 contract). |
| C-08 | (Cost/accepted) `books.search`'s collapse join is the one invasive read-model change (facet counts, pager, grouping all become work-grain). The conservative matcher (ADR-065 C-01) means some true pairs render as two cards until identifier-backed matching lands (DESIGN-036 Q-02 — unchanged, still the upgrade path); that is the same honesty the split walls had. |
| C-09 | (Cost/accepted) Mixed-format sorts are partial: Length sorts audio-carrying works, Pages sorts ebook-carrying works (NULLS LAST, the existing idiom) — honest, data-gated, no fabricated cross-format metric. |

## More information

- Realized by amendments to DESIGN-024 (wall + search contract), DESIGN-026 (registry rows,
  view levels), DESIGN-036 (pairing as the collapse join). PRD R-153/R-165/R-167/R-169/R-170
  amended; new requirements authored with this ADR. Glossary T-136/T-138/T-183/T-185 updated.
- Implementation: `.agents/plans/060-books-format-unification.md` (Stream A). Sibling
  ADR-076 covers the collections leg (Libretto multi-target + merged cards + Authors).
- Live numbers source: `.agents/context/2026-07-20-gb-first-budgeted-day-verified.md`
  (candidates 1538 / paired 331) over the ~2,200-row mirror (T-137).
