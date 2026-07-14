# PLAN-048: Activity / In-Flight — the pipeline made visible (all libraries)

- **Status:** SCOPED — owner-ruled 2026-07-14 morning. **Depends on PLAN-047** (the shared card
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
