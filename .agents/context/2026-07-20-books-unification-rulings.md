# 2026-07-20 — Books format unification: owner rulings (remote-control session)

The owner opened a discussion on how the app handles books vs audiobooks ("we always search
for both — is one Books library right, or splitting?"), plus format-spanning collections,
famous-author collections, and Movies-style category filtering for books collections.
Fable presented the live picture and a recommendation; the owner ruled each fork one at a
time over remote control. Recorded here as the rulings of record for ADR-075 / ADR-076.

## The picture presented (live numbers)

- Acquisition already format-agnostic: every want queues both formats (R-180); ADR-065
  auto-mints the missing format estate-wide, paced by the GB budget.
- Overlap 2026-07-20: ~331 works paired in both formats, ~1,538 singletons (≈993 ebook-only
  + ≈533 audio-only at the 07-17 snapshot) — and the doctrine pushes overlap up daily, so
  the split walls converge toward rendering the same titles twice.
- Collections: one recipe per library (DESIGN-037 D-07) ⇒ five hand-kept audiobook twin
  recipes; the app mirrors them as two source-scoped cards (ADR-066 C-04 / DESIGN-038 Q-02,
  deferred "until the owner sees the mirror live" — that moment arrived).

## Rulings

| # | Fork | Ruling |
|---|------|--------|
| R1 | Collections merge mechanism | **Libretto multi-target recipes** (one recipe declares both Kavita + ABS targets; app merges mirrored twins by recipe id) — over app-side-only merge and over keep-per-format. Also activates recipe-authored categories (`cat=` marker, resolves DESIGN-038 Q-04's category half). |
| R2 | Famous-author collection depth | **Curated canon** (~10–20 signature works per author) — over full bibliography (new builder, hundreds of wants per author) and over owned-only (no acquisition pull). |
| R3 | Scope | **Both, in parallel** — unify the Books+Audiobooks walls into one Books library with a format filter (ADR-075) AND make collections format-agnostic (ADR-076). Owner asked for the recommendation explicitly and ratified it; noted the two streams split cleanly (hnet vs Libretto) for parallel Opus agents. |
| R4 | Workforce | **Opus agents as the main workforce** for implementation; Fable holds the architecture/design voice and UX review (standing division of labor). |

Fable design calls riding the rulings (not owner rulings; owner reviews shipped UX):
- Format filter = three-state seg All · Ebook · Audiobook (the owner's proposed multi-select
  collapses to exactly these states with two formats; seg matches the Wanted-filter grammar).
- Paired card anchors on the ebook row; pairing wants fold into the anchor card (no
  double-render on the unified wall).
- Author recipes ship `acquisitionEnabled: true` (paced by shipped caps + governor + GB
  budget), reversible per recipe in the manager.

## Artifacts of this session

- ADR-075 (unified Books wall), ADR-076 (format-agnostic collections + Authors) — Accepted.
- PRD/design/glossary amendments (same PR).
- `.agents/plans/060-books-format-unification.md` — the two implementation streams + the
  curated author canon appendix.
