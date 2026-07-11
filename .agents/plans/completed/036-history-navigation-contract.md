# PLAN-036: Browser back/forward = screen navigation (the history contract)

- **Status:** ✅ COMPLETED 2026-07-11 — shipped in **v0.43.1** (fix PR **#206**, release PR **#207**).
  Image `ghcr.io/thaynes43/haynesnetwork:v0.43.1` built + cosign-signed by CI; haynes-ops HelmRelease
  bumped v0.43.0→v0.43.1 (`71655484`, forward-only). Flux GitOps rollout in flight. Opus builder,
  Fable (main session) reviews the result.

## As-built (2026-07-11)

**Root cause confirmed & fixed.** Every `?tab=`-driven hub switched tabs with `router.replace`, so a
tab switch rewrote the current history entry and Back left the app screen. Fix: route **screen-level
tab switches through `router.push`** (keeping `{ scroll: false }`), so each tab visit is a history
entry — Back restores the prior tab WITH the URL-synced filter state its entry carried (refinement
edits still replace-in-place within that entry), Forward re-applies.

**Six `selectTab` sites converted to push** (screen switches): Library kind tabs
(`library-client.tsx`), Bulletin Feed/Messages (`bulletin-client.tsx`), Metrics sub-tabs
(`metrics-client.tsx`), Trash tabs incl. the Overview jump-to-kind cards (`trash-client.tsx`),
Trash-settings tabs (`trash-settings-client.tsx`), Ledger tabs (`ledger-client.tsx`).

**Left as `router.replace` (unchanged):** refinements — Library/Ledger/Trash `patchParams`
(filter chips, sort, debounced search, pagination/infinite-scroll), the Bulletin Feed `?src`/`?media`
segs, the Ledger Runs `?kind=` filter; and canonicalizing redirects — Metrics + Trash-settings
bare/unknown-`?tab` normalization effects and the retired Trash `?tab=batches` fold (a redirect must
not mint a history entry). D-09 search-contract semantics unchanged except the tab dimension.

**No visual change; ADR-015 untouched; deep links + tab-switch scroll behaviour preserved.**

**Docs:** DESIGN-004 gains **D-19** (the history-navigation contract) + a top-block amendment note.
No new ADR / PRD / migration / glossary change.

**Tests:** new `apps/web/e2e/history-navigation.spec.ts` — reproduced the defect first (pre-fix: Back
landed on `/`, the dashboard, for all four hubs), then asserts the contract green: Library
TV→Movies→Back⇒TV (filter `genre=Drama` intact)→Forward⇒Movies, plus back-restores-tab for Bulletin
(Feed↔Messages), Metrics (Overview↔Apps), Trash (Movies↔TV). Full bar green locally:
`pnpm lint` (0 errors) · `lint:css` · `typecheck` · `test` (all packages) · `build` + the spec (4/4).
CI required checks (lint-and-typecheck · test · build) green on #206 and #207.

**Deploy note:** the Siderolabs-Omni K8s API was unreachable from the build host at deploy time
(known intermittent kubectl outage); the image bump was pushed to `haynes-ops` main and Flux
reconciles it cluster-side. Public `/api/health` = 200; live rollout-to-v0.43.1 confirmation deferred
to when the Omni API path returns (`flux reconcile helmrelease haynesnetwork -n frontend`,
`kubectl -n frontend get deploy haynesnetwork -o jsonpath='{...image}'`).
- **Owner report:** back/forward navigation doesn't behave like screens. In Library, switching
  TV → Movies then pressing Back should return to TV — not to whatever page preceded the app.
- **Root cause (recon 2026-07-11):** app screens use `router.replace` near-universally
  (15 replace vs 1 push in `apps/web/app/(app)` + components) — tab/sub-view switches rewrite
  the URL without creating history entries.
- **Relates:** D-09 search contract (URL-synced filters — its REPLACE semantics for
  refinements are correct and must survive), DESIGN-004 (UI shell — gains the contract),
  PLAN-029 (future Library views overhaul must inherit this contract; noted there at scoping).

## The contract (ruled by coordinator, owner-authorized dispatch)

1. **Screen-level view changes are HISTORY ENTRIES (`router.push`):** Library kind tabs
   (Movies/TV/Music/Peloton/YouTube/Books/Audiobooks/Comics/My Fixes), Bulletin Feed/Messages,
   Metrics sub-tabs, Trash tabs, and any other tabbed screen switch. Back restores the prior
   tab WITH the filter state its URL carried; Forward re-applies.
2. **Refinements stay REPLACE (no history spam):** filter chips, sort, search text, pagination/
   infinite scroll, in-place expansions. D-09 semantics unchanged except the tab dimension.
3. **No visual change.** Deep links keep working; scroll behavior on tab switch stays as today;
   ADR-015 untouched.

## Verification bar

- Reproduce FIRST (Playwright: tab switch → `page.goBack()` exits the app page) — then the same
  script proves the fix: Library TV→Movies→Back⇒TV (filters intact)→Forward⇒Movies; one
  assertion each for Bulletin + Metrics + Trash. Existing D-09/search tests stay green.
- Docs: DESIGN-004 gains the history-contract D-item in the same PR (no new ADR; no migration).
