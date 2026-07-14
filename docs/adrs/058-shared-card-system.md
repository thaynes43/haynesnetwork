# ADR-058: The shared card system — one typed card family, cohesion enforced by code

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** Tom Haynes (owner ruling 2026-07-14 morning — PLAN-047: "our base library card is
  shared everywhere, even Helpdesk tickets, and then is extended for different types of media and
  extended further for advanced use cases. **I want the code to guarantee the UX doesn't drift as
  we build.**")
- **Builds on:** ADR-019 (poster proxy + reserved 2:3 box), ADR-041 (progressive reveal), ADR-046
  (books walls), ADR-050 (Helpdesk twall), ADR-033 (unified trash-wall glyphs), ADR-057 (composed
  Wanted + the Goodreads items wall), ADR-015 (reflow-free) — all STAND; this ADR governs *where
  their card markup may live*, not what it looks like.

## Context and problem statement

The estate's walls converged on one card grammar — the Movies wall anatomy: a reserved 2:3 art box
over a caption of title (year) · optional muted subtitle · ONE compact badge row, with state pucks
confined to reserved corners on the Trash/Helpdesk tiles. But the grammar lived in **per-surface
JSX**: every wall re-typed the same `media-card poster-card` / `bwall-*` / `twall-*` markup. That
made the anatomy *conventional*, not *structural* — and PLAN-045 proved the failure mode: an agent
shipped a "Wanted strip" (bordered section, chip stacks, "for <requester>" lines, per-card "Search
again" buttons) that looked nothing like the rest of the Library, because nothing in the code
prevented inventing card markup. #261/#264 consolidated the caption (`PosterCardBody`); this ADR
finishes the job as a SYSTEM with teeth.

## Decision drivers

- **Owner ruling (PLAN-047):** one base card shared everywhere — Helpdesk tickets included —
  extended per media type, extended further for advanced cases; **code-guaranteed** non-drift.
- Agents build most UI here; a convention an agent can violate WILL eventually be violated
  (PLAN-045). The guard must fail CI, not rely on review.
- Pixel-neutrality: the refit must not change what ships (the walls were owner-accepted).
- ADR-015 / hard rule 9 stand: reserved slots, recolor-not-reflow.

## Considered options

1. **A typed card family in a sealed package + lint guard + a gallery drift gate** (chosen).
2. Documentation + review discipline only (a DESIGN doc "one card anatomy" rule) — rejected: that
   is exactly what PLAN-045 had, and it drifted.
3. One literal component for ALL walls (force twall/bwall onto the poster-card classes) — rejected
   for this pass: it changes shipped DOM/CSS for zero visual gain and risks regressions; the
   family instead OWNS each grammar in one place, and a future class unification (if ever) is a
   package-internal refactor.

## Decision outcome

Chosen option: **the sealed card family + code guards.**

**The family** lives in `apps/web/components/cards/` (the "card package") and is consumed ONLY
through its barrel `@/components/cards`:

- `BaseCard` — the canonical poster-idiom anatomy. Every slot is a **typed prop**: `art` (a union:
  2:3 poster box with KindIcon fallback, or the group-art ladder), `title`/`year`/`subtitle`,
  `badges` (ONE row, hard-capped at `MAX_CARD_BADGES = 3`), typed flavor/focus/testid/data knobs.
  **No children passthrough** — a surface cannot bolt stacks, requester lines, or buttons onto a
  card face.
- Extensions by composition, never copy: `MediaCard` (Movies/TV/Music/Peloton/YouTube),
  `BookCard` (Books/Audiobooks/Comics + the composed Wanted tiles), `GroupCard` (author/genre
  aggregates), `RequestCard` (Goodreads items; pre-mint = same anatomy, non-interactive).
- The corner-puck grammars are family members with their own typed slots: `TicketCard` (Helpdesk
  twall tile — state puck top-right, poster or `TicketCategoryTile` art) and `TrashCard` (bwall
  tile — state/action toggle top-right, `/library` nav puck top-left, ONE meta row whose only
  extras are the person/eye chips).
- The wall containers + skeletons are package-owned too: `PosterGrid(+Skeleton)`,
  `TicketWall(+Skeleton)`, `TrashWall(+Skeleton)`; `MediaPoster` (detail-head hero art) and the
  bare `PosterBox` placeholder are the only art primitives exported.

**The guards** (the "no other code path" idiom of ADR-008/ADR-017, applied to markup):

- **Lint:** `apps/web/lint/card-anatomy-guard.mjs` wires `no-restricted-syntax` +
  `no-restricted-imports` over every `app/**`, `components/**`, `lib/**` file outside
  `components/cards/`: the anatomy class tokens (`media-card`, `poster-card`, `poster-grid`,
  `poster-box`, `bwall-*`, `twall-*`, `pwall-*`, `glyph-tile`, `group-card`, …) are forbidden in
  string AND template literals, and deep imports of the package internals are forbidden (barrel
  only). Runs in CI's `lint-and-typecheck`.
- **Executable proof:** `apps/web/lib/__tests__/card-system-guard.test.ts` runs the exact guard
  config over violating fixtures (the PLAN-045 strip reconstructed) — they MUST fail — and the
  sanctioned form — it MUST pass — plus an import-confinement walk. Runs in CI's `test`.
- **The gallery drift gate:** `/e2e/card-gallery` (a dev-only harness route, 404 in production)
  renders EVERY variant in every state over inline fixtures; `apps/web/e2e/card-gallery.spec.ts`
  structurally asserts each tile's anatomy (one art box, one caption, ONE badge row ≤ 3, pucks
  only in reserved corners, no buttons on card faces) and always emits full-page captures
  (dark/light × desktop/390) — the standing visual reference for owner review and agent briefs.

**Extending the family** (the sanctioned path): add a typed variant/prop in the package, render it
in the gallery, assert it in the spec — same change. PLAN-048's activity/in-flight states extend
these components, never fork them.

### Consequences

| ID   | Consequence |
|------|-------------|
| C-01 | Good: card anatomy is structural — a surface literally cannot hand-roll a wall card (lint error in CI), so the PLAN-045 class of drift is impossible, not just discouraged. |
| C-02 | Good: the refit is behavior/pixel-neutral — the family emits the exact pre-refit classes and DOM, verified per wall by before/after captures and the existing wall e2e specs. |
| C-03 | Good: the badge row is capped in code (`MAX_CARD_BADGES = 3`, one row) — badge stacks can't return. |
| C-04 | Good: the gallery is a permanent, hermetic reference sheet; future agents are briefed against captures that CI keeps honest. |
| C-05 | Bad/accepted: adding a genuinely new card variant now requires touching the package + gallery + spec (three files) instead of one — deliberate friction at the drift seam. |
| C-06 | Bad/accepted: the guard's token list must grow if new anatomy classes are ever introduced inside the package; the gallery spec is the backstop while the list catches up. |
| C-07 | Neutral: `media-card__badges` deliberately stays page-level (the detail-head badge-row idiom) — detail heads are not wall cards; locking them buys nothing and would churn five detail pages. |
| C-08 | Neutral: e2e specs/support keep selecting by the anatomy classes (they are out of the guard's scope on purpose — tests must see the DOM). |

## More information

- PLAN-047 (`.agents/plans/047-shared-card-system.md`) — the owner's words + the dispatch shape.
- DESIGN-004 D-21 — the normative component contract + slot semantics (amendment carried there).
- DESIGN-029 (the PLAN-045 incident + the corrected Wanted anatomy this system generalizes).
- The guard idiom: `packages/domain/__tests__/arr-write-import-guard.test.ts` (ADR-008/ADR-017).
