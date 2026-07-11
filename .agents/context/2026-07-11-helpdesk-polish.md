# Helpdesk (v0.44.0) owner review-pass polish tracker — 2026-07-11

Owner walkthrough findings on the live Helpdesk. Batch-dispatch when the owner says go
(agent type discussed first, standing rule). The BIG item from this pass is PLAN-038
(exact-episode/file ticket linking) — tracked as its own plan, not here.

## HP-01 — State filters: multi-select chips + active-by-default  [owner 2026-07-11]
- **Owner ask:** default the wall to OPEN + IN-PROGRESS only; Complete/Rejected are historical,
  visible on demand (and re-openable from there — reject-reopen already exists). Single-select
  sub-section chips aren't ideal — you want COMBINATIONS; "another UX element that lets you add
  or remove the state-based filters from one overall view."
- **Proposed shape (coordinator):** convert the state chips to MULTI-SELECT toggles in the
  Library filter-chip idiom — each chip adds/removes that state from the one wall; default
  selection = {Open, In progress}; an "All" affordance selects everything; live counts stay
  per chip; selection is a D-09 refinement (URL-synced, router.replace per D-19); per-user?
  NO — default resets each visit (historical states are a deliberate detour, not a preference).
  ADR-015-safe: chips recolor, wall content changes, controls never move.
- **Status:** ✅ DONE — shipped v0.44.1 (PR #214, squash-merged; release PR #213). Wall state chips
  are now MULTI-SELECT toggles (default {Open, In progress}; "All"; Complete/Rejected opt-in),
  URL-synced via repeated `?state=` params (router.replace, no per-user persistence). Server
  `communication.tickets.list` takes a validated `statuses` SET. DESIGN-012 D-11/D-12 amended in the
  fix PR. Tests: helpdesk e2e (default hides a Complete ticket + its chip count, add-Complete/
  remove-Open combination, URL restore) + communication unit test (state-SET union/empty/absent +
  enum validation). Deployed to prod via haynes-ops (image bump v0.44.0→v0.44.1, flux reconciled,
  rollout complete, /api/health 200). Owner screenshot of the default wall captured (desktop dark).

## (add further HP-NN items as the walkthrough continues)
