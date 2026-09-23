# PLAN-048: Activity / In-Flight — the pipeline made visible (all libraries)

- **Status:** Completed — shipped v0.53.0–v0.54.0 (#272/#273/#275, ADR-059/DESIGN-030: Library→Activity, all sources, role-gated failure actions); OWNER RATIFIED 2026-07-15. **Depended on PLAN-047** (the shared card
  system — 048's surfaces are built FROM it; "the code guarantees the UX doesn't drift").
  **One step never happened (found 2026-09-23, [issue #556](https://github.com/thaynes43/haynesnetwork/issues/556)):**
  the `activity-scan` CronJob was never added to haynes-ops, so the failure ledger is empty and the
  nightly digest has never reported an import failure. The app side is now fixed (ADR-090 — no
  per-failure push; each *arr queue read whole); the CronJob follows in haynes-ops once that ships in a
  release. See [Scheduling `activity-scan`](#scheduling-activity-scan-issue-556--what-happens-when-the-cronjob-lands).
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
   digest; NO push per-event (owner ruled in-app only for now). _(2026-09-23, ADR-090: the per-failure
   outbox row is retired — it went out on Pushover, against this ruling. The nightly digest reads the
   failure ledger directly.)_

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

## Scheduling `activity-scan` (issue #556) — what happens when the CronJob lands

`activity-scan` shipped in v0.53.0–v0.54.0, but its CronJob was never added to haynes-ops (both deploys
were one-line image bumps). So `activity_import_failures` has 0 rows, the nightly digest has never
listed an import failure, and failed Activity tiles never link to a detail page. Two app defects made it
unsafe to schedule, and both are fixed first (ADR-090, DESIGN-030 D-07a / D-08c):

- The scan enqueued one Pushover outbox row per new failure, which the drainer would have pushed as
  "Trash batch update" — about 267 pushes within about 40 minutes of the first run. It now writes only
  the ledger, and the Pushover renderer has no fallback that could mislabel a row.
- The *arr queue read stopped at one 200-record page. Sonarr's 212-item queue lost a different tail each
  run, so those failures flapped open and closed. The scan now reads each queue whole.

**The remaining step (haynes-ops, after this ships in a release):** add a `sync-activity-scan` CronJob to
`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`, shaped like `sync-queue-cleanup`:
command `tsx /sync/src/scripts/sync.ts --mode=activity-scan`; `envFrom` `haynesnetwork-secret` (it
already carries the LazyLibrarian, SABnzbd, *arr and Kapowarr keys); requests 25m / 128Mi, limit 512Mi;
`concurrencyPolicy: Forbid`, `backoffLimit: 1`, history 2/1; schedule `1,16,31,46 * * * *` (minutes no
other sync CronJob uses). Close #556 once it runs clean.

**What to expect once it runs:**

- **No push.** The first run writes the whole backlog to the ledger and enqueues nothing.
- **The first nightly digest is big.** The `sync-failure-digest` email (`5 21 * * *`) arrives with the
  subject "[haynesnetwork] N stuck imports need attention" and lists the oldest 20. N was about 267 at
  the 2026-09-23 count: Radarr 10, Sonarr 200 (of a 212-item queue; the scan now reads it whole, so up to
  212), Lidarr 57, books 0. Most of it is Sonarr's `importBlocked` pile, which the ADR-083 queue janitor is
  still only observing (census, L0 — PLAN-065). The same pile already appears in the digest's janitor
  section; from the first scan it is also listed as stuck imports. The count repeats every night until
  the pile is cleared, by the janitor's promotion or by hand. The owner should expect that email;
  triaging the Sonarr pile first is optional.
- **Failed Activity tiles link to their detail pages** (D-09), where admins get Retry import and Force
  re-search.
- **Verify after deploy:** the first Job logs `activity-scan evaluated` with `seen` and `opened` near the
  count above and `scannedSources` naming `books`, `arr` and `kapowarr`. The second run logs `opened: 0`
  and `resolved` near 0 (no flap). `notification_outbox` gains no `activity_import_failed` row, and the
  next digest subject carries the stuck-import count.
