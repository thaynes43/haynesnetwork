# PLAN-048: Activity / In-Flight — the pipeline made visible (all libraries)

- **Status:** Completed — shipped v0.53.0–v0.54.0 (#272/#273/#275, ADR-059/DESIGN-030: Library→Activity, all sources, role-gated failure actions); OWNER RATIFIED 2026-07-15. **Depended on PLAN-047** (the shared card
  system — 048's surfaces are built FROM it; "the code guarantees the UX doesn't drift").
- **Motivating incident:** 42 completed usenet book downloads sat stranded and invisible (the
  SAB category/dir mismatch, fixed live 2026-07-14) — nothing in the app shows the stage
  between Wanted and On-shelf.
- **Owner rulings:** (R1) **Library → Activity tab + wall badges** — one cross-library Activity
  sub-tab (the Trash→Activity idiom) showing every item actively grabbing / downloading (with
  progress) / importing / import-FAILED, plus an "in flight" state on wall posters. (R2)
  **Import failures: in-app badge + detail page with failure reason + actions, ROLE-CONTROLLED**
  — Admin gets act (retry import / force re-search / deep-link downstream), everyone else
  read-only view of stuck media; action grants openable to roles later (rides the existing
  grants machinery). (R3) **All libraries, fan-out build:** after 047 lands, DIFFERENT OPUS
  subagents per source family — *arr queues (Radarr/Sonarr/Lidarr), books (LL + SAB), comics
  (Kapowarr) — each filling the same 047-based components and a common read-model contract.
- **Backlogged (owner-ordered):** post-SMTP (F-04) **nightly email digest to admins** of
  actions-needed (stuck imports, manual-intervention items) — file under PLAN-035's channel
  when SMTP lands.

## Shape (design phase enumerates the docs)

1. **Common read-model contract:** an `activity_items`-shaped read (live or synced — ADR
   decides) normalizing per-source queue/import states: (kind, title, source app, stage
   [searching|downloading %|importing|failed|completed], failure reason, actionable flags).
2. **Per-source adapters (the Opus fan-out):** *arr queue APIs (`queue`, `manualimport`), LL
   (wanted/snatched + postprocess state + SAB queue/history), Kapowarr (queue/tasks). Read-only
   except the ruled actions (retry import / re-search) — confined writes where they don't
   already exist.
3. **UI (built on PLAN-047 cards):** Library → Activity tab (cross-library list with stage
   chips + progress, Helpdesk-chip filters by kind/stage), wall-poster in-flight badge state,
   failure detail page (047 detail idiom) with role-gated actions.
4. **Notifications:** failure transitions ride the notification outbox (same-tx) for the future
   digest; NO push per-event (owner ruled in-app only for now).

## Open

- Q-01: live-poll vs synced read-model for queues (latency vs load) — ADR at design.
- Q-02: does "importing" for books need an LL postprocess hook or is dir-watch inference enough?

## Post-ship: CLICKABILITY + LIVE-PROGRESS pass (owner directive 2026-07-14)

After the fan-out landed, the owner ruled the Activity tiles must all CLICK THROUGH and must show live
progress "like when we click Fix, keep the UX consistent." Shipped (DESIGN-030 D-09 + D-10):

- **D-09 click-through everywhere:** the aggregator fills `href` for every item (failed → failure detail;
  *arr → ledger detail; book/comic want → Wanted detail), all `?from=activity`; the stage/kind filters moved
  to the URL so Back restores the tab + filters.
- **D-10 live progress (the Fix feel):** adaptive `activity.list` poll (2.5 s downloading / 5 s idle); the
  shared in-flight badge gained a pulsing dot + filling mini-meter (a typed-prop ADR-058 extension, the Fix
  `PhaseChip` vocabulary); a landed tile flashes before aging out; the failure + Wanted detail poll a new lean
  `activity.itemStatus` after a fire and walk the stage in a reserved slot; the books walls now wire
  `activity.wallStages` (`books.wanted` exposes the join keys). Hermetic parity harness at
  `/e2e/activity-progress` captures the side-by-side against the Fix reference.
