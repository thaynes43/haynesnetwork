# ADR-076: Format-agnostic book collections — Libretto multi-target recipes, recipe-id merge, and the Authors category

- **Status:** Accepted (owner rulings, remote-control session 2026-07-20: merge mechanism =
  "Libretto multi-target"; author depth = "curated canon"; scope = "Both, in parallel" with
  ADR-075)
- **Date:** 2026-07-20
- **Deciders:** Tom Haynes (rulings 2026-07-20, recorded in
  `.agents/context/2026-07-20-books-unification-rulings.md`) · drafted by Fable 5
- **Builds on / refines:** [ADR-064](064-mirrored-plex-collections-read-model.md) (mirror-only
  doctrine — INTACT: Libretto remains the external author, Kavita/ABS remain the sources of
  truth, the app still never authors), [ADR-066](066-books-collections-mirror.md) (the mirror
  tables, sync mode, and gating ALL STAND; this ADR **resolves its C-04/Q-02 deferral** — the
  owner has now "seen the mirror live" and ruled merge — and **retires its D-05 one-wall
  majority rule** for the book/audiobook axis, whose premise ADR-075 removes),
  [ADR-072](072-collections-direct-add.md) (manager/builder surface — gains multi-target),
  DESIGN-037 (D-02/D-07 amended: `targetLibrary` → `targets[]`), DESIGN-038 (D-05/D-11/D-12/
  D-13 amended). Sibling: [ADR-075](075-unified-books-wall.md). Nothing else is superseded.

## Context and problem statement

DESIGN-037 D-07 fixed "one recipe targets one library" and made "the same series in both
Kavita and ABS" two recipes — mirrored by ADR-066 C-04 as two honest source-scoped
collection cards. Live consequence (day-wrap 2026-07-20): five hand-kept audiobook twin
recipes duplicating Kavita-only franchises, drifting by hand-sync. The owner (2026-07-20):
it is odd to have different collections per format when a collection should span each media
format — and ruled the merge should live in **Libretto** (multi-target recipes), not as an
app-side patch over twin recipes.

Two adjacent gaps land in the same decision because they share the mechanism:

1. **Categories (DESIGN-038 Q-04 / D-12 L1):** book collection categories are agent-set SQL
   (L2) because Libretto never emitted the `cat=` marker token. A recipe that already writes
   its provenance marker should author its category too.
2. **The Authors program:** the owner wants famous-author collections (Isaac Asimov et al.)
   filterable by a Movies-style category chip ("Authors") — a program, not a one-off, and
   inherently format-agnostic (an author's canon spans ebook and audio).

## Decision drivers

- **Owner ruling: multi-target over app-side merge** — twin recipes drift; one recipe is one
  intent. And over keep-split: the per-format twin cards are the ratified oddity.
- **ADR-064 doctrine must survive untouched** — servers stay sources of truth; Libretto
  stays the author; the app stays a mirror. Multi-target changes WHERE Libretto writes,
  never WHO authors.
- **The merge key already exists:** `books_collections.libretto_recipe_id` (migration 0068,
  D-13) is captured on every Libretto-managed mirror row — twins already share it.
- **Bounded acquisition:** owner ruling "curated canon" (~10–20 signature works per author)
  over full bibliographies (hundreds of wants per prolific author) and over owned-only
  (sparse shelves, no pull). Wants stay paced by the shipped caps + GB budget machinery.
- **Open category vocabulary** (T-186): "Authors" must be a value, not an enum/migration.
- **Libretto stays generic** ("Kometa for books"): multi-target and marker categories are
  generally useful to any Kavita+ABS estate — nothing haynesnetwork-specific leaks in.

## Considered options

1. **Libretto multi-target recipes + app merge by recipe id** (chosen — owner ruling).
2. **App-side merge only** (twin recipes linked by pairing data/name family). Rejected:
   twins stay hand-authored in duplicate and drift; the app fabricates a link the author
   never declared.
3. **Keep per-format collections.** Rejected by the ruling; the deferral (ADR-066 C-04)
   existed precisely to be revisited once the owner saw the mirror live.

## Decision outcome

Chosen option: **1** — one recipe declares its targets; Libretto materializes per server;
the app merges the mirrored twins by recipe id into one card on the unified Books wall.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Recipe noun: `targetLibrary` → `targets[]`** (1..N configured targets; practical v1: one Kavita + one ABS entry). Per-target kind mapping is D-07 unchanged (`ordered: true` ⇒ Kavita reading list / ABS collection; `ordered: false` ⇒ Kavita collection / ABS collection). Back-compat: a single `targetLibrary` is accepted and normalized to a one-entry `targets[]`, so the 45 live recipe YAMLs stay valid; the API emits `targets[]` and the provider-parity contract change is additive. hnet's `@hnet/libretto` schemas + the builder form follow. |
| C-02 | **Materialization per target, one shared marker.** Each produced collection carries the SAME `[libretto:<recipeId>\|cat=<Category>]` marker — activating the D-12 **L1** path: categories are now RECIPE-AUTHORED (a `category` recipe field), flow through the existing `deriveBooksCollectionCategory` parse, and win over prior values per the shipped COALESCE rule. Agent-set L2 remains the fallback for markerless hand collections (e.g. Kavita-native Event lists). This resolves DESIGN-038 Q-04's category half; builder-level provenance display stays deferred. |
| C-03 | **The app merges by recipe id.** `books_collections` rows sharing a non-null `libretto_recipe_id` render as ONE collection card on the unified Books wall: members union at WORK grain (pair-collapse via `books_format_pairs`, the ADR-075 C-02 join), per-member format coverage badges, count = distinct works. Ordered recipes keep positions (both targets carry the same builder order; the union dedupes a paired work to its position). Markerless/hand collections merge nothing — they stay single-source cards (the app never fabricates a link — mirror honesty). |
| C-04 | **The wall-mapping rule shrinks to a comic partition.** ADR-066's three-way majority rule retires with the Audiobooks wall: a collection whose resolved live members are majority `comic` surfaces on Comics; otherwise it surfaces on the unified Books wall; ties go to Books. Comics collections (`hardcover_comics`, Kapowarr domain) are untouched by multi-target acquisition semantics (D-05 amendment stands: comics acquisition remains a schema error). |
| C-05 | **Missing/wants become per (work, format) across targets.** Libretto's `missing[]` gains per-target resolution (which target lacks the work); hnet's collection-wants pass keeps minting `origin='collection'` wants with format source-derived per target (kavita ⇒ ebook, abs ⇒ audiobook) and the merged drill DEDUPES tiles on `collection_member_ref` — one Wanted tile per work, per-format statuses on its detail (the shipped wanted-detail already renders per-format). Implementation MUST assert one active want per (work, format) across origins (collection vs pairing) via the existing reuse-before-resolve + ref keys — plan 060 edge E-1. |
| C-06 | **The Authors category program.** Seeded famous-author recipes: `static_ids` builders (curated canon, ~10–20 signature works each — owner ruling; no new builder needed v1), `targets` = both servers, `category: Authors`, `ordered: false`. The category chip row (shipped, dynamic) grows an "Authors" chip wherever such a collection is present; the hint order pins **Authors** after Universe and Sequels. The seeded spread + per-author canon lists live in plan 060's appendix; recipes are one YAML each — pruning/extending is a recipe edit, never a schema or app change. A `hardcover_author` full-bibliography builder is explicitly NOT v1 (rejected depth ruling). |
| C-07 | (Cost/accepted) Author-canon `static_ids` refs must be curated to identifiers (the D-04 chain: Hardcover/ISBN/OLID); title-only entries fall to the flagged conservative matcher. Acquisition for author recipes defaults ON (`acquisitionEnabled: true`, paced by the shipped 25/run cap + MAM governor + GB budget) — the estate "drive content in" posture; the owner can flip any recipe's toggle in the manager (role-gated knob, Appendix A idiom). Recorded as a lean, reversible per-recipe. |
| C-08 | (Cost/accepted) Until Libretto ships multi-target, the five live twins stay twins; the migration path is mechanical (collapse each twin pair into one two-target recipe, keep the Kavita recipe id as the survivor so mirror history and `libretto_recipe_id` joins stay stable; the orphaned ABS twin's collection is deleted via the existing `?deleteCollection=true`). |

## More information

- Realized by: DESIGN-037 amendment (D-02 Recipe noun, D-07 multi-target mapping, D-09/D-10
  missing[] per-target), DESIGN-038 amendment (D-05 partition rule, D-11/D-12 marker `cat=`,
  D-13 merged-drill dedupe), DESIGN-043/044 (manager/builder form follows the noun). PRD
  R-215..R-217 amended + new requirements authored with this ADR; glossary T-186..T-190
  updated.
- Implementation: `.agents/plans/060-books-format-unification.md` — Stream B (Libretto,
  short PR per cross-repo hygiene) + Stream A (hnet merge reads). Libretto's own repo
  carries its docs via README + PR description; THIS design of record governs
  (CLAUDE.md hard rule 10).
- Owner rulings recorded in `.agents/context/2026-07-20-books-unification-rulings.md`.
