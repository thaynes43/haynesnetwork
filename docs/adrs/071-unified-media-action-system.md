# ADR-071: The unified media-action system — one action vocabulary, cohesion enforced by code

- **Status:** Accepted
- **Date:** 2026-07-17
- **Deciders:** Tom Haynes (owner ratification 2026-07-17 of the media-action UX audit,
  `.agents/context/2026-07-17-media-action-ux-audit.md`: "the site must present exactly the same
  action/UX language for a given media action regardless of media type and the view it is seen in.
  It must be **impossible to mess up** — enforced by shared libraries/components, not by
  convention.")
- **Builds on:** ADR-058 (the shared CARD system — the exact "sealed family + guard" pattern this
  copies for ACTIONS), ADR-051 (registry-driven views — "config, not components"), ADR-014
  (inline two-step confirm), ADR-015 (no reorientation on interaction / reserved slots), ADR-028
  (arr action-feedback phase chips), ADR-007 (fix semantics), ADR-012 (unified role model),
  ADR-062 (books Fix). All STAND; this ADR governs *how the action controls are built and gated*,
  not what a Fix does.

## Context and problem statement

The card *faces* are unified-by-construction (ADR-058: a sealed card family + a lint guard). The
detail *pages and their action controls are not*. Every detail surface — movie/TV
(`item-detail`), book/audiobook/comic (`books-detail` + `book-fix-dialog`), wanted
(`wanted-detail`), activity-failure, ytdl-sub — hand-rolls its own hero, its own action row, and
its own copy of the "button ↔ live chip" reserved slot, with per-call string literals for
label/variant/gating. The audit found **24 discrepancies across 5 surfaces, 6 High**. The headline:
a movie shows a green primary **Fix** + an outline **Force Search**; a book shows an outline **Fix
this** (different label, different look) and **no Force Search at all**. Same intent, divergent
implementation — because nothing in the code forces them to agree.

Root causes: (1) no shared hero/action-row component; (2) action definitions are per-call string
literals, not data (there is no `MEDIA_ACTIONS` registry, unlike `LIBRARY_VIEW_REGISTRY` for
sorts/facets); (3) `@hnet/ui` sharing stops below the action layer (it ships `PhaseChip`,
`ConfirmButton` — but no `MediaAction`); (4) the on-disk→Fix / missing→Force-Search decision and
the gating rule live twice, and diverge in KIND (movies gate on on-disk state with NO role check;
books gate Fix on Admin-only role with no on-disk check).

## Decision drivers

- **Owner ruling:** ONE label `Fix` and ONE `Force Search` everywhere; code-guaranteed non-drift,
  not review discipline (a convention an agent can violate WILL be violated — the ADR-058 lesson).
- The consume link (Watch on Plex / Read in Kavita / Listen on ABS) is already consistent — make
  it a shared component too, so its ↗/target/rel can't drift.
- Gating must be ONE server-side rule for all media types, driven by per-role grants (the same
  grant model as collections `role_*_action_grants`) — this also delivers the long-pending books
  Fix/Force-Search role flip.
- The audit invariants stand: audit-in-same-transaction (hard rule 6), ConfirmButton-vs-Modal
  (hard rule 8), reserved-slot reflow-safety (hard rule 9 / ADR-015).

## Considered options

1. **A registry of action specs + a sealed `@hnet/ui` component set + a lint/executable guard**
   (chosen) — the ADR-058 card-system pattern, applied to actions.
2. Documentation + review discipline only — rejected: that is exactly the state the audit
   indicts; five copies already drifted.
3. One mega-component per detail page — rejected: the surfaces legitimately differ in data/layout;
   the shared seam is the *action controls + hero scaffold + gating*, not the whole page.

## Decision outcome

Chosen option: **the registry + sealed component set + code guard.**

### The canonical action vocabulary (owner-ratified)

- ONE label **`Fix`** everywhere (green **primary** pill). "Fix this" / "Fix season" are retired;
  a grain qualifier ("Fix · Season 2") is a component prop, never a forked label.
- ONE **`Force Search`** everywhere (**outline** pill) — including when it is a missing item's only
  action (the movie head's "primary if missing" special case is retired). "Force Search show /
  artist", "Search for ebook", "Force re-search" are retired → `Force Search` + a scope qualifier.
- On-disk item ⇒ **Fix + Force Search**; missing item ⇒ **Force Search only**. This becomes
  universal — **books gain a real on-disk Force Search** on the detail page (closing the headline
  asymmetry).
- The consume link stays per-app in LABEL only (it names the serving app — correct) and flows
  through one `<ConsumeLink>` so the pill + ↗ + `target=_blank` + `rel=noopener noreferrer` are
  identical everywhere.

### The registry (single source of truth)

`packages/ui/src/actions/action-registry.ts` — `MEDIA_ACTIONS`, keyed by `MediaActionType`
(`fix | forceSearch | consume | retryImport | notOnDisk`), each carrying the ONE `label` +
`variant` (`primary | outline`) + `destructive`. No call site types a label or a `btn` class
again — the analog of `LIBRARY_VIEW_REGISTRY`.

### The sealed component set (`@hnet/ui`, re-exported from the root barrel)

`MediaAction` (a surface names an action TYPE — the registry key — never a label; destructive specs
render through `ConfirmButton` per hard rule 8, non-destructive open their own Modal/dialog),
`MediaActionBar` (the ordered cluster; OWNS `.detail-head__actions`), `ConsumeLink`,
`ReservedActionSlot` (the ONE reflow-safe button↔chip slot, replacing the 5 copies; OWNS
`.action-slot`), and `MediaHero` (the `.detail-head` scaffold; OWNS `.detail-head__play`).
Structure only — every color is an app.css token (hard rule 2), the `PhaseChip`/`ConfirmButton`
precedent. The trpc polling that decides WHEN a slot shows its live chip stays in the app and is
passed to `ReservedActionSlot` as `live`.

### Gating — one role-governed grant helper for ALL media types

`canFix` / `canForceSearch` unify onto ONE server-side per-role grant model (the collections
`role_*_action_grants` pattern), replacing the split (movies: any authed / no role check; books:
Admin-only `canFix`). On-disk state is an INPUT to that helper, not a separate parallel rule. The
owner then grants books Fix/Force-Search to the roles he wants via `/admin`. Mutations keep writing
their audit row in the same transaction (hard rule 6). *(The server + `/admin` grant surface land
in a follow-on PR after the sibling's admin-force-search stopgap merges; this ADR fixes the target
model so the presentation and gating converge.)*

### Enforcement (make drift impossible — the ADR-058 pattern, for actions)

- **Lint:** `apps/web/lint/action-anatomy-guard.mjs` — `no-restricted-syntax` forbids a raw
  action `<button>` label (`Fix` / `Force Search` / `Force re-search` / `Retry import` / `Fix
  this`) in a `btn`-classed context, and forbids the `detail-head__play` / `detail-head__actions`
  class tokens, outside `@hnet/ui`; `no-restricted-imports` seals the action-package internals to
  the barrel. Runs in CI `lint-and-typecheck`.
- **Executable proof:** `apps/web/lib/__tests__/action-system-guard.test.ts` runs the guard over a
  violating fixture (a hand-rolled `<button className="btn primary">Fix</button>` — MUST fail) and
  the sanctioned `<MediaAction action="fix">` (MUST pass), plus a repo walk asserting zero live
  violations and a registry-parity assertion (one label/variant per verb). Runs in CI `test`.

### Consequences

| ID   | Consequence |
|------|-------------|
| C-01 | Good: a movie, a book, a comic, an episode, a wanted format render the identical Fix/Force-Search/consume BY CONSTRUCTION — they emit the same `<MediaAction>` off the same registry entry; the headline "book looks like a different app" drift is impossible, not discouraged. |
| C-02 | Good: books gain an on-disk Force Search and a green primary Fix — the owner-cited asymmetry closes. |
| C-03 | Good: gating is ONE role-governed rule for every media type; granting books Fix/Force-Search becomes a `/admin` toggle, and the movie "any authed" gap folds into the same helper. |
| C-04 | Good: the reserved-slot reflow-safety (hard rule 9) lives in ONE component instead of 5 hand-rolled copies that already disagreed on wording. |
| C-05 | Bad/accepted: the movie head's Force Search is no longer green when the item is missing (it is always outline now) — a deliberate, owner-ratified simplification for one estate-wide rule. |
| C-06 | Bad/accepted: changing an action now touches the registry + (maybe) the guard token list — deliberate friction at the drift seam (the ADR-058 C-05 trade). |
| C-07 | Neutral: the consume label stays per-app (it names the serving app) — that is correct variance, carried as a `<ConsumeLink label>` prop, not drift. |

## More information

- The audit: `.agents/context/2026-07-17-media-action-ux-audit.md` (the discrepancy matrix,
  the proposed registry + components, the PR sequence).
- DESIGN-004 D-24 — the normative component contract + slot semantics + the guard wiring.
- ADR-058 / DESIGN-004 D-21 — the CARD system this copies; the guard idiom
  (`packages/domain/__tests__/arr-write-import-guard.test.ts`).
- ADR-051 — `LIBRARY_VIEW_REGISTRY`, the "config not components" precedent.

## Companion note (2026-07-19, owner ruling) — the `presentation` LOOK variant (badge)

This note is ADDITIVE and consistent with the decision above (it does not alter it — the ADR stays
immutable). Owner live-review of the Movies collection drill asked for the Wanted-tile Force Search to
be "a badge with a magnifying glass in one of the corners we have not decorated already," and for the
same magnifier to fire a per-collection "Search Missing" from the all-collections grid.

The invariant this ADR protects — ONE label/variant/gating per verb, code-guaranteed — is preserved by
adding a `presentation` prop to the SAME `MediaAction` component rather than a new control:

- `presentation: 'pill' | 'badge'` selects only the LOOK, never the identity. `pill` (default) is the
  existing `.btn` pill; `badge` is an icon-only round `.action-badge` corner puck carrying an inline
  currentColor magnifier (the `@hnet/ui` app-icon idiom; the `.bwall-overlay` corner-puck geometry).
- Both looks render off the SAME `MEDIA_ACTIONS` row through the one component, emit the same
  `data-action-type`, and route the same `onFire`/dialog — so a movie Wanted badge, a TV Wanted badge,
  and a `/collections` Force Search pill cannot drift in verb or gating. `variant` (primary/outline)
  still comes from the registry; `presentation` is orthogonal (a Force Search badge is still the
  outline verb, just drawn as a puck).
- The **action-anatomy guard is unchanged and still passes**: the badge carries no visible action
  label and is not `.btn`-classed, and it is emitted by the sealed component (never hand-rolled), so
  R1–R4 do not fire. No registry key or label is added.

Consumers of the new look (2026-07-19): the movies/TV Wanted-tile Force Search (DESIGN-035 D-16 amend)
and the per-collection "Search Missing" badge on the all-collections grids + the drill-header pill
(DESIGN-043 D-01/D-02 amend). The collection-level bulk mutations (`ledger.forceSearchCollection` for
movies/TV, `collections.forceSearchCollection` for books/audiobooks) sit BEHIND that shared control;
gating is unchanged from each media type's existing per-item Force Search (no new grant for movies/TV;
the `force_search_book` grant for books) — consistent with this ADR's "gating is an INPUT, one rule
per media type" stance.
