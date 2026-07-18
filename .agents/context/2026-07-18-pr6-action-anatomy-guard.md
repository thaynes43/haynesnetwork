# PR-6 — the `action-anatomy` drift guard (ADR-071 lock, the unification lane's final leg)

Date: 2026-07-18
Branch: `feat/action-action-guard` → `feat/action-anatomy-guard`
ADR: ADR-071 (unified media-action system) · DESIGN-004 D-24 · audit
`.agents/context/2026-07-17-media-action-ux-audit.md` (§4.4 the enforcement) · PR-4 note
`.agents/context/2026-07-18-pr4-wanted-activity-media-actions.md`

## What shipped

The unification lane's LAST leg: the code guard that makes the unified media-action doctrine
STRUCTURAL, not conventional (the ADR-058 card-anatomy pattern, applied to actions). Every detail
surface is already on-pattern (item-detail/ytdl-sub v0.76.0, books v0.77.0, wanted-detail +
activity #400, collections wanted tiles #385/#394), so the lock closes on a clean tree.

### Files

- `apps/web/lint/action-anatomy-guard.mjs` — the guard patterns (single source), exporting
  `actionAnatomyRestrictedSyntax` + the registry MIRROR lists (`CANONICAL_ACTION_LABELS`,
  `RETIRED_ACTION_LABELS`, `MEDIA_ACTION_KEYS`) + `ACTION_ANATOMY_MESSAGES`.
- `apps/web/eslint.config.mjs` — spreads `actionAnatomyRestrictedSyntax` into the SAME
  `no-restricted-syntax` override the card guard uses (a flat-config rule id is replaced, not
  merged, per matching file, so both selector sets must share one array) + ignores the guard's own
  test. Runs under `pnpm lint` → CI `lint-and-typecheck` (required), no ci.yml edit needed.
- `apps/web/lib/__tests__/action-system-guard.test.ts` — the executable proof (13 tests):
  per-rule violating fixtures fail with the actionable message; sanctioned `<MediaAction>` /
  `<ConsumeLink>` and legit non-action forms pass; registry-parity locks the mirror to
  `MEDIA_ACTIONS`; a repo walk asserts zero live violations. Runs in CI `test` (required).
- `docs/designs/004-ui-shell-and-dashboard.md` D-24 — updated to record the guard as LANDED with
  the as-built refinements. (ADR-071 is immutable/Accepted — the living design doc tracks the leg.)

## The four rules (what it catches)

- **R1** — a hand-rolled `<button>`/`<a class="btn">` whose visible text OR `aria-label` is a
  canonical registry action label (`Fix` / `Force Search` / `Retry import`, sourced from
  `MEDIA_ACTIONS`). → "render through @hnet/ui `<MediaAction action="…">`".
- **R2** — same, for a RETIRED label variant (`Fix this` / `Fix season` / `Force re-search` /
  `Force Search show|artist` / `Retry Import`) ADR-071 normalized away.
- **R3** — an unknown key on `<MediaAction action="literal">`, validated against
  `MEDIA_ACTION_TYPES` (negative-lookahead built from the key mirror).
- **R4** — a hand-rolled `.btn__ext` consume ↗ (string or template class); that chevron is owned
  solely by `<ConsumeLink>`. → "render consume links through `<ConsumeLink>`".

Anchoring on interactive `btn`-classed `<button>`/`<a>` (property-path `openingElement.name.name`

- a descendant `btn` className + the element's own direct text / aria-label) keeps the words in
  prose, headings, and caption spans out of scope ("anchor on interactive elements, not copy").

## Deliberate design decisions (why it's clean on main + false-positive-free)

- **No class-token ban.** The audit/ADR mention forbidding `.detail-head__play` /
  `.detail-head__actions` / `.action-slot`; those are shared `.detail-head` CSS SCAFFOLD, reused
  legitimately by the **bulletin ticket detail** (a support ticket is not media) and the **ADR-065
  books pairing-backfill affordance** (a collection/backfill CONFIG control — the same non-goal
  class as the puck). Banning them would false-fail on main. Cohesion is enforced via the LABEL
  vocabulary + registry KEY + the ConsumeLink ↗ anatomy instead (where drift is user-visible).
- **No `no-restricted-imports`.** `@hnet/ui`'s package `exports` map exposes only the barrel — deep
  imports of `packages/ui/src/actions/*` don't resolve, so the internals are sealed by the module
  boundary (stronger than a lint rule).
- **Registry as single source.** The guard's label/key lists are a MIRROR of `MEDIA_ACTIONS`,
  locked by the parity test — not a hand-maintained parallel. `consume` (per-app label, owned by
  `<ConsumeLink>`) and `notOnDisk` (the inert `.btn--missing` pill, also rendered by the shared
  `NotOnDiskButton`) are excluded from LABEL matching by design; consume is covered by R4.
- **EXPLICIT NON-GOAL (coordinator UX ruling):** the collections find-missing puck-toggle is a
  collection-scoped acquisition CONFIG control (acq-puck idiom), NOT a media action — not in
  `MEDIA_ACTIONS`, never flagged. Recorded in the guard header + D-24.

## Verification

`pnpm typecheck && pnpm lint && pnpm lint:css && pnpm test && pnpm build` all green. `apps/web`
tests 344 → 357 (+13 guard tests). Proof the guard FAILS on a regression: injecting a hand-rolled
`<button className="btn primary">Fix</button>` (+ a retired label, a bad `action` key, a raw
`.btn__ext`) into a real file makes `eslint` emit all four errors with the actionable messages;
removed after proving. Repo walk in the test confirms zero live violations on the current tree.

## Not touched (out of scope / boundary)

`packages/goodreads` + sync/cron (parallel agent, GB quota classification). No app behavior change,
no new component, no gating change. No release train.
