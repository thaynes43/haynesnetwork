# PR-4 — wanted-detail + activity-failure onto the shared media-action components (ADR-071)

Date: 2026-07-18
Branch: `refactor/wanted-activity-media-actions`
ADR: ADR-071 (unified media-action system) · DESIGN-004 D-24 · audit
`.agents/context/2026-07-17-media-action-ux-audit.md` (PR-4 leg of the migration sequence)

## What shipped

The unification lane's PR-4. Two detail surfaces that predate ADR-071 now render every
fix/force-search affordance through the shared `@hnet/ui` media-action components with registry
KEYS — a pure, pixel-invariant refactor (no new actions, no gating change).

### `wanted-detail.tsx` (books wanted / collection-origin wants)
- Hero `<section className="card detail-head">` → `<MediaHero>` (poster slot, title, typed
  `badges`, `meta`=author, `secondary`=the "Requested by" attribution chips). testId
  `wanted-detail-head` preserved.
- `FormatSearchSlot`: the hand-rolled `<button className="btn sm">Force Search</button>` →
  `<MediaAction action="forceSearch" size="sm" testId="format-search-btn">`; the local
  `<span className="action-slot action-slot--roll">` → `<ReservedActionSlot reserve="roll"
  testId="format-search" live=…>`. The trpc mutation/state machine (searching → fired / noop /
  failed chips) stays in the app and is passed as `live`. All testIds preserved
  (`format-search-btn`, `format-search`) so `integrations.spec.ts` is unaffected.
- **#394 collection-origin (ownerless) wants unregressed:** the `origin: 'collection'` →
  `isSystemWant` → `books.searchPairingWant` branch in `onFire` is byte-for-byte unchanged; the
  read-only copy branch still special-cases `pairing`/`collection`.

### `activity-failure-detail.tsx`
- Hero → `<MediaHero>` (badges typed; the non-muted `.detail-head__meta` failure reason + the muted
  explainer moved into the `secondary` slot verbatim, keeping `activity-failure-reason` testid and
  the exact markup). testId `activity-failure-head` preserved.
- Local `ActionSlot`: raw `<button className="btn sm">` → `<MediaAction action="retryImport|
  forceSearch" size="sm">`; `<span className="action-slot action-slot--roll">` →
  `<ReservedActionSlot reserve="roll" live=…>`. testIds `activity-retry` / `activity-retry-slot` /
  `activity-search` / `activity-search-slot` preserved (activity.spec.ts asserts them + the
  "Requested" fired chip, which is unchanged — the state machine stays local).
- Off-pattern label normalized (ADR-071 retires it): the search row label + button + the
  "Last action" history text `Force re-search` → `Force Search`. No e2e asserted the old string.

## Guard readiness
Both surfaces would now pass the not-yet-landed PR-6 `action-anatomy` guard: no raw
`Fix`/`Force Search`/`Retry import` label in a `btn`-classed button, and no hand-rolled
`detail-head__play` / `detail-head__actions` tokens (only `<MediaHero>`/`<MediaActionBar>` own
those). The guard itself is PR-6 (not this PR).

## Verification
`pnpm typecheck && pnpm lint && pnpm lint:css && pnpm build` green. `pnpm test`: `@hnet/ui`
(85) + `web` (344) + full `@hnet/api` (494) green — one embedded-Postgres boot flake
(`users.test.ts` hook timeout) cleared on isolated re-run. No unit-test additions: matches the
item-detail precedent (#381), whose refactor added zero app-level tests and relied on the shared
`action-system.test.tsx` + e2e.

## Not touched (out of scope)
`/collections`, `/admin`, sync/cron, item-detail / books-detail (already refactored), the
find-missing knob (parallel agent). No migration, no release train.
