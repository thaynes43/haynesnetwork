# ADR-015: No layout reorientation on interaction

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Tom Haynes

## Context and problem statement

Two interaction surfaces were shifting the page under the user's cursor:

1. **The inline two-step confirm** (ADR-014 `ConfirmButton`). The Delete button renders as
   `confirm-btn btn sm danger`. CSS specificity — not source order — decides which `min-width`
   wins: `.btn.sm` (specificity 0,2,0; `min-width: 34px`) OUTRANKS `.confirm-btn` (0,1,0;
   `min-width: 5rem`), so the 5rem reservation from ADR-014's D-13 never applied. The button
   sized to its content, so arming (relabel "Delete" → bold "Confirm?") widened the button and
   **reflowed the whole row** — the exact shift the width reservation was meant to prevent.

2. **The catalog reorder controls.** Reordering used a pair of `↑`/`↓` `.btn.sm` buttons in the
   Order column. When an entry reached the first or last position its up/down button disabled,
   which visually changed the control cluster, and the buttons are a poor fit for touch and
   keyboard-only reordering.

Both violate a principle we had followed implicitly but never written down: **the content a user
is acting on should not jump around because of that action.**

## Decision drivers

- Muscle memory and pointer accuracy: a control must not move out from under the cursor/finger
  the instant it is pressed.
- Accessibility: reorder must be operable by keyboard and announced to assistive tech, not
  mouse-drag-only.
- Token-only styling (CLAUDE.md hard rule 2); port the demo-console mechanism, not its look.
- No new runtime dependency for drag-and-drop.

## Considered options

- **Confirm width:** (a) shrink/re-layout on arm (status quo — reflows); (b) reserve width for
  the widest state with specificity-correct selectors + `white-space: nowrap`; (c) render both
  labels stacked and toggle visibility (heavier markup, still needs width reservation).
- **Reorder:** (a) keep `↑`/`↓` buttons; (b) native HTML5 drag-and-drop + keyboard arrow-move,
  dependency-free (demo-console `useReorderDnD`); (c) a drag-and-drop library (dnd-kit /
  react-dnd) — a dependency and bundle weight we don't need at household scale.

## Decision outcome

Chosen option: **the golden rule + (b) for both** — because it fixes the observed shifts at the
root and keeps us dependency-free and token-themed.

**Golden rule (CLAUDE.md hard rule 9):** page contents must not re-orient when a user interacts.
An interaction may change color/emphasis but must NOT reflow or reposition neighbors. The only
exceptions are deliberate in-place expansions (the catalog inline editor) and drag-and-drop
reordering.

**Confirm — reserve for the widest state, deepen color not layout.** `.btn.confirm-btn` (a
specificity-correct 0,2,0 selector that beats `.btn.sm`'s `min-width: 34px`) reserves
`min-width: 6.5rem` with `white-space: nowrap` and centered text, sized for the bold armed
"Confirm?" label so the resting→armed relabel never reflows. The armed state reads a shade or two
DEEPER rather than moving: a new `--color-danger-strong` token (darker than `--color-danger` in
both themes) drives the armed text/border and a `color-mix` background tint. Call sites keep
`className="btn sm danger"`; resting stays danger red, armed deepens to danger-strong.

**Catalog reorder — native HTML5 drag-and-drop + keyboard, no dependency.** The `↑`/`↓` buttons
are replaced by a whole-row native HTML5 drag-and-drop (dependency-free `@hnet/ui` `useReorderDnD`
hook over pure geometry helpers `computeDropIndex`/`resolveReorderIndex`). A grip glyph (`⠿`) is
the visual affordance AND the keyboard handle: focus it and ArrowUp/ArrowDown move the row, with
each move announced through an `aria-live` region. A zero-height accent drop indicator
(`box-shadow: inset` on the target row) marks the drop position without reflow. The drop commits
the FULL reordered id array to the unchanged `catalog.reorder` mutation, applied optimistically so
the drop feels instant and never snap-backs.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the confirm relabel no longer reflows its row — the specificity bug that defeated ADR-014's width reservation is fixed at the selector level, and the reservation is sized for the actual widest (armed) label. |
| C-02 | Good: reorder is now touch- and keyboard-operable and screen-reader-announced (`aria-live`), where the old `↑`/`↓` buttons were pointer-oriented and unannounced. |
| C-03 | Good: no new dependency — drag-and-drop is native HTML5 + a small pure hook ported from demo-console; the geometry helpers are DOM-free and unit-tested. |
| C-04 | Good: a new normative rule (hard rule 9) gives future UI a single principle to check against; in-place expansion and drag-reorder are the only sanctioned exceptions. |
| C-05 | Neutral: adds one token (`--color-danger-strong`) to the required-token contract in both themes; the tokenContract test must list it. |
| C-06 | Bad: native HTML5 drag-and-drop is awkward to exercise in Playwright (`dragTo` is flaky), so drag itself is not e2e-covered — the keyboard arrow-move path is the e2e target instead, and pointer drag relies on the unit-tested geometry. |

## More information

- Supersedes the presentational width claim in **DESIGN-004 D-13** (ADR-014): the `.confirm-btn
  { min-width: 5rem }` reservation is corrected here (specificity-correct `.btn.confirm-btn`,
  `6.5rem`, nowrap). ADR-014's two-step arm/auto-revert behavior otherwise stands.
- Cross-refs: **ADR-014** (inline two-step confirm), **DESIGN-004 D-14** (this decision's design
  detail), CLAUDE.md hard rule 9.
- Donor: `../demo-console` — the dependency-free `useReorderDnD` hook + geometry and the
  reserve-widest-state confirm sizing.
