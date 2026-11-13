# DESIGN-014: Space-driven batch policy (propose-only) + rules-tuning report

- **Status:** Accepted — **amended 2026-07-18 by [ADR-073](../adrs/073-autonomous-trash-cycle.md)**: the
  space policy now PROPOSES **AND PROMOTES** its batches straight to Leaving Soon (autonomous cycle, no
  admin-review gate, no cooldown). The cooldown knob (`cooldownDays`) is retired everywhere. See the
  **D-14** amendment below; the original D-01..D-09 text describes the pre-073 propose-only behavior.
  **D-15 (2026-11-13, story 835)** specifies the TV rule body. The owner approved the four-clause
  rule that day (story 822, comment 7992) and, later the same day, added the votes floor (story 835,
  comment 8099). It is not applied to the live Maintainerr in that story. The same-day adversarial
  review's corrections C1–C6 are folded into D-15.
  **Amended 2026-11-13 by [ADR-120](../adrs/120-dynamic-trash-pace.md)** (D-16): while Dynamic Pace is
  on, the byte ask comes from the gap and the intake. The switch ships off, and while it is off D-09
  and D-14 are unchanged. The 2026-11-13 adversarial review's merge corrections are folded into D-16.
- **Last updated:** 2026-11-13 (D-16, story 820: Dynamic Pace review corrections; D-15 is the TV rule).
- **Extended by:** [DESIGN-052](052-watchlist-protection-and-release-block.md) (ADR-093, 2026-09-26; in effect since 2026-09-28): the
  space policy's proposal leaves out a title on any read Plex watchlist (it takes no cap slot), and `minCandidates`
  counts deletable candidates only (DESIGN-052 D-08).
- **Author:** Fable 5 (autonomous run, PLAN-014); D-14 amendment by an Opus autonomous run
- **Implements:** [ADR-031](../adrs/031-space-driven-batch-policy.md),
  [ADR-073](../adrs/073-autonomous-trash-cycle.md),
  [ADR-120](../adrs/120-dynamic-trash-pace.md). Consumes ADR-030 / DESIGN-013
  (`getUtilization`, `space_targets`, `STORAGE_ARRAYS`) and ADR-025 / DESIGN-011 (`createBatchFromPending`,
  `promoteToLeavingSoon`, `trash_batch_items`/`trash_batch_saves`, the sync-mode orchestrator pattern).
  Governs PRD **R-112..R-114**; glossary **T-98..T-99**. Migration **0022**.

## Overview

Two additive, read-mostly surfaces closing the PLAN-013 loop:

1. **A space policy** — a scheduled, opt-in, DEFAULT-OFF `space-policy` sync mode that reads utilization
   and, for an over-target array, PROPOSES a batch (`createBatchFromPending`). Since **ADR-073** it also
   **promotes** that batch straight to Leaving Soon (the save window opens immediately, no admin-review
   gate, no cooldown — D-14). It still never sweeps: only the windowed sweep reclaims (ADR-031 C-01).
2. **A rules-tuning report** (`trash.tuning`) — per-resolution / per-rating-band / per-collection
   rescue-vs-delete stats + skip-gate graduation readiness. Read-only; the owner tunes Maintainerr rules
   by hand (ADR-031 C-06).

The original surfaces add no deletion path. D-16 changes how many bytes a batch asks for, behind a
switch that ships off. The sweep is still the only delete.

## Detailed design

### D-01 — Data model + migration 0022 (three additive CHECK relaxes)

Migration 0022 mirrors the 0019/0020/0021 CHECK-rebuild pattern (drop + re-add from the const arrays):

- **`app_settings.key`** admits **`space_policy`** — the policy CONFIG jsonb (`AppSettingValueMap['space_policy']`
  = `SpacePolicy`), written through the audited `setAppSetting` single-writer (co-writes `update_app_setting`).
- **`ledger_events.event_type`** admits **`trash_space_policy`** — the batch-scoped proposal-WHY event.
- **`sync_runs.run_kind`** admits **`space-policy`** — the new mode (parity only; the mode writes no `sync_runs` row).

No new table, column, FK, or index. `SpacePolicy` shape (defaults in `APP_SETTING_DEFAULTS`, DEFAULT OFF):

```ts
interface SpacePolicyArrayConfig { enabled: boolean; cooldownDays?: number; minCandidates?: number }
interface SpacePolicy {
  enabled: boolean;          // default false — the global master switch
  cooldownDays: number;      // default 7  — don't re-propose a kind within N days of its last policy batch
  minCandidates: number;     // default 1  — don't propose unless ≥ N actionable pending
  perArray: Record<string, SpacePolicyArrayConfig>; // keyed by STORAGE_ARRAYS key; an entry OPTS IN
  targetBytesPerBatch?: number; // AMENDMENT 2026-07-08 — cap a proposed batch to a reclaim target
                                //   (largest-first, DESIGN-011 D-09b); absent ⇒ propose ALL candidates
}
// default: { enabled:false, cooldownDays:7, minCandidates:1, perArray:{} }  (targetBytesPerBatch absent)
```

> **Amendment 2026-07-08 (owner-directed) — `targetBytesPerBatch`.** An optional top-level jsonb key
> (no migration — a free-form value shape on the existing `space_policy` row; `getSpacePolicy`
> typeof-guards it, fail-safe to absent when non-numeric ≤ 0). When set, a policy proposal caps its
> batch to that many bytes, **largest-first**, by passing `targeting: { targetBytes, strategy:'largest' }`
> to `createBatchFromPending` (DESIGN-011 D-09b — the min-candidates gate still measures the full
> pending pool; the cap only trims what the proposed batch snapshots). `storage.policy.set` accepts it
> (`SpacePolicyInput` — `z.number().int().positive().optional()`, still `.strict()`).

`getSpacePolicy(db)` reads the row merged over the defaults (a partial/hand-edited jsonb can never leave a
required field undefined — fail-safe to OFF).

### D-02 — `evaluateSpacePolicy` (the `space-policy` mode body, ADR-031 C-01..C-04)

`evaluateSpacePolicy({ db, maintainerr, arr, actorId, now? })`:

1. Read `space_policy`. **Disabled ⇒ a cheap no-op** (don't even read utilization); returns
   `{ enabled:false, ranAt, proposedCount:0, arrays:[] }`.
2. Read `getUtilization({ db, arr })` (ADR-030 — resilient; a downed *arr ⇒ that array `unavailable`).
3. For each array row: it is a proposal candidate only when **opted in** (`perArray.<key>.enabled`),
   **reachable**, has a **target**, and is **over** it (`usedPct > target`). Otherwise the array appears in
   the report with `proposals: []`.
4. For each candidate array, for each **backing kind** (`trashKindsForArray` off `STORAGE_ARRAYS.sources`:
   `haynestower`→`[movie, tv]`, `cephfs`→`[]`), run the per-kind gate:
   - **open batch for the kind?** → `skipped_open_batch` (one-open-per-kind; graceful).
   - **cooldown?** last `trash_space_policy` event for the kind + `cooldownDays` still in the future →
     `skipped_cooldown`.
   - **pending count** (one `listTrashPending` read) < `minCandidates` → `skipped_min_candidates` (or
     `skipped_empty` at 0).
   - else **propose**: `createBatchFromPending` (the ordinary path; catches `TrashBatchOpenError` race →
     `skipped_open_batch`, `TrashBatchEmptyError` → `skipped_empty`). On success, write the
     `trash_space_policy` ledger event + the `space_policy` notification (D-04).

Never throws for a per-kind failure (records `outcome:'error'`); throws only if the utilization/settings
reads themselves fail. The **`arr` param is the minimal `UtilizationArrBundle`** (`{ read: {sonarr,radarr,lidarr:
{getDiskSpace}} }`) — a full `ArrClientBundle` satisfies it, and the sync mode passes a bazarr-free
diskspace-only bundle (no confined write surface, no `BAZARR_API_KEY`).

**Correction 2026-10-30 (OpenProject #296):** the minimum-candidate count and its byte total exclude
open Save intents, alongside protective tags, watchlisted titles and recent Age Guard dates. A Save
awaiting Maintainerr enforcement must not satisfy the minimum for a batch that cannot include it
(ADR-099 D-4). This changes the proposal accounting only; the batch builder and deletion guardian
already honor the same Save.

The returned `SpacePolicyReport` carries per-array `{ key, label, usedPct, target, overTarget, enabled,
unavailable, proposals[] }`, each proposal `{ mediaKind, outcome, batchId, gateSkipped, candidateCount,
candidateBytes, cooldownUntil, reason }`, outcomes one of `proposed | skipped_open_batch | skipped_cooldown
| skipped_min_candidates | skipped_empty | error`.

### D-03 — `getSpacePolicyStatus` (the card's status read — ledger-derived)

`getSpacePolicyStatus({ db, now? })` is a pure DB read (no *arr read — the live over/under readout is the
`storage.utilization` the page already loads): `{ policy, lastProposalAt, kinds: [{ mediaKind, hasOpenBatch,
lastProposal, cooldownDays, nextEligibleAt }], recentProposals[] }` off the `trash_space_policy` events +
open-batch state. `nextEligibleAt = lastProposal + cooldownDays` (null ⇒ eligible now). "Last run" is
deliberately NOT persisted (the CronJob log is the run record, like the sweep — ADR-031 negative note).

### D-04 — Proposal audit writes (ADR-031 C-04)

Per proposal (after the batch exists durably):
- **`trash_space_policy` ledger event** — `source: 'maintainerr'`, `mediaItemId: null`, payload
  `{ batchId, mediaKind, array, arrayLabel, usedPct, target, candidateCount, candidateBytes, gateSkipped }`.
  The durable WHY + the marker the tuning report joins on to identify policy batches.
- **`space_policy` notification** via `recordNotification` — `source: 'trash'`, `type: 'space_policy'`,
  a title/body naming the array/%/target/candidate count. Surfaces in Trash Activity + the Bulletin Feed.

### D-05 — Rules-tuning report (`getTuningReport`, ADR-031 C-06)

`getTuningReport({ db, now? })` aggregates every **candidate item** (`trash_batch_items.state ∈
{saved, deleted, skipped}` — `protected`/`pending` excluded) joined to its batch + `media_metadata`:

```ts
interface TuningStats { proposed; rescued; deleted; skipped; saveRatePct: number|null }  // saveRatePct = rescued/(rescued+deleted)*100
interface TuningReport {
  overall: TuningStats;
  byResolution: TuningCell[];   // COALESCE(deleted_resolution, media_metadata.resolution, 'unknown'), proposed desc
  byRatingBand: TuningCell[];   // ratingBand(COALESCE(deleted_imdb_rating, media_metadata.imdb_rating)): 8.0+ / 7.0–7.9 / 5.0–6.9 / <5.0 / unknown
  byCollection: TuningCell[];   // Q-02 collection-grain (trash_batch_items.collection_id)
  graduation: GraduationReadiness;
}
```

`rescued` = items that ended `saved` (a human rescue = a labelled false positive); `deleted` = swept;
`skipped` = guardian-kept (excluded from the save-rate ratio, reported alongside). The frozen `deleted_*`
wins for swept items; live `media_metadata` fills saved/skipped items. This is NET by construction — the
report keys off each item's FINAL `state`, never the raw `trash_batch_saves` flip log, so a title that
was saved then un-saved then swept counts as `deleted` (never `rescued`); the save-rate is churn-immune.

**Graduation readiness** (`GRADUATION_THRESHOLDS = { minCompletedBatches:3, maxSaveRatePct:10, maxRestores:0 }`,
ADR-031 C-05): over the most recent **completed** (`state='deleted'`) **policy-proposed** batches (those
with a `trash_space_policy` event), `{ completedPolicyBatches, recent[], aggregate: TuningStats,
restoresOfSwept, meetsCriteria }`. `restoresOfSwept` counts `trash_restored` events whose media item was
`deleted` by a recent policy batch (a guardian near-miss). `meetsCriteria` = enough batches AND aggregate
save-rate ≤ 10% AND 0 restores.

### D-06 — tRPC surface (all adminProcedure)

| Procedure | Kind | Input | Returns |
|-----------|------|-------|---------|
| `storage.policy.get` | query | — | `SpacePolicy` (defaults merged) |
| `storage.policy.status` | query | — | `SpacePolicyStatus` |
| `storage.policy.set` | mutation | the whole `SpacePolicy` (`.strict()`, bounds) | `{ changed, before, after }` (audited `update_app_setting`) |
| `trash.tuning` | query | — | `TuningReport` |

`policy.set` replaces the whole value (the UI sends the merged object, like the targets editor).

### D-07 — UI (`/admin/storage` — the "Space policy" card; ADR-014/015, DESIGN-006)

A light card under the utilization arrays (no new page):
- **Global enable** — a two-step `ConfirmButton` to turn ON (explanatory: proposes for review, never
  deletes); a plain button to turn OFF (mirrors the Trash skip-gate ceremony). DEFAULT OFF.
- **Per-array (HaynesTower)** — an opt-in/opt-out button + a cooldown-days editor.
- **Status line** — last proposal + per-kind cooldown next-eligible (live over/under is on the array card
  above).
- **Rules tuning + graduation block** — the rescue-rate tables (by resolution + rating band) with an
  empty-state, and the skip-gate graduation-readiness verdict against the suggested bar.
Reflow-free (ADR-015): armed states deepen color, never move neighbors. Pure helpers in
`apps/web/lib/space-policy.ts` (unit-tested).

### D-08 — Ops (the CronJob — NOT committed to haynes-ops here)

The owner deploys the manifest. The `space-policy` sync mode runs
`tsx /sync/src/scripts/sync.ts --mode=space-policy` (no `--source`; the app image deploys the sync
subtree flattened at `/sync`, exactly like the other CronJobs), needing `DATABASE_URL`,
`SONARR_URL`/`SONARR_API_KEY` (+ `RADARR_`/`LIDARR_`), and `MAINTAINERR_URL`/`MAINTAINERR_API_KEY` —
all supplied by the existing `haynesnetwork-secret` External Secret (with the optional
`haynesnetwork-webhook`) via `envFrom`, same as `sync-trash-batch-sweep`. It is a no-op unless
`space_policy.enabled` is on. It is a new **bjw-s app-template `type: cronjob` controller** under
`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` — mirror the existing
`sync-trash-batch-sweep` block, shipped `suspend: true` so the owner arms it by unsuspending once the
first run is validated:

```yaml
# spec.values.controllers.space-policy — mirrors sync-trash-batch-sweep (see helmrelease.yaml).
    space-policy:
      type: cronjob
      pod:
        restartPolicy: Never
      cronjob:
        schedule: "17 * * * *"        # hourly-ish, offset off the sweep
        suspend: true                 # owner arms it by unsuspending once the first run is validated
        backoffLimit: 1
        concurrencyPolicy: Forbid
        failedJobsHistory: 2
        successfulJobsHistory: 1
      containers:
        main:
          image: *mainImage
          command:
            - tsx
            - /sync/src/scripts/sync.ts
            - --mode=space-policy
          envFrom:
            - secretRef:
                name: haynesnetwork-secret
            - secretRef:
                name: haynesnetwork-webhook
                optional: true
          resources:
            requests:
              cpu: 25m
              memory: 128Mi
            limits:
              memory: 512Mi
```

Exit 0 with a report unless the evaluation itself errored (then exit 1 → retry). Writes no `sync_runs`
row (its audit trail is the `trash_space_policy` events + `space_policy` notifications + the proposed
batches' own transitions).

## Test strategy

Hermetic (embedded PG16 + fetch-stubbed *arr `/diskspace` + fetch-stubbed Maintainerr):
`evaluateSpacePolicy` matrix (over/under target, disabled, per-array off, open-batch skip, cooldown,
min-candidates, empty), the `trash_space_policy` event + `space_policy` notification writes, the
skip-gate pass-through, the `setAppSetting('space_policy')` audit, `getSpacePolicyStatus`; `getTuningReport`
math (resolution/rating-band/save-rate) + the graduation calc (met / blocked-by-restore / not-enough-batches).
Sync: `runSync` `space-policy` mode wiring (report shape, requires both bundles, no `sync_runs` row). Web:
`lib/space-policy.ts` pure helpers. e2e: the policy card toggle ceremony + the tuning empty-state / graduation render.

## Open questions

- **Q-01 (resolved, ADR-031 C-05):** graduation thresholds — ≥3 batches, ≤10% save-rate, 0 restores.
- **Q-02 (resolved, ADR-031 C-06):** rule attribution — collection-grain; rule-group-exact is a future map.
- **Q-03 (resolved, ADR-031 C-06):** no auto-tuning — the report is human-driven.
- **Q-04 (open, D-15):** the TV group's stored name is still "hnet — unwatched low-value TV".
  Maintainerr creates a Plex collection with the group's name once the pool has a member. Measured
  this correction session (`GET /api/rules`, 2026-11-13, before the 19:21:34Z Sonarr read): the movie
  collection's `mediaServerId` is 98837, and the TV collection's `mediaServerId` is null (collection
  id 3). After an apply that leaves a member, "unwatched" would be shown on HaynesOps for shows that
  may have been watched. Recommendation: do not rename in this story; story 823 puts the name to the
  owner before the apply. Coordinator comment 8099 (2026-11-13T18:55Z) carries Q-04 to that gate and
  does not ask it here. A rename is not part of either 2026-11-13 ruling. It is not a collection wipe
  (the running image wipes only on `dataType`, `manualCollection`, `manualCollectionName`, or
  `libraryId`).
- **Q-05 (resolved, 2026-11-13T18:55Z, story 835 comment 8099):** an unrated show must not count as
  "rating below 6.0". The owner's answer was "Add the votes floor". D-15's fifth clause is that floor.
- **Q-06 (open, carried to story 823):** is a list-added, never-requested show fair game, as the
  ruling already includes it? Star Wars Resistance (tvdb 351575) is one of the three expected
  collection members. The adversarial review (2026-11-13, 18:32Z–18:50Z) measured a list add on
  2026-11-04 (Sonarr tag `pmm-added`) and 35 files still downloading, and 267 of 373 ended,
  unrequested HaynesOps shows carrying `pmm-added`. Recommendation: yes, no change now; record it
  for the larger-pool design. Comment 8099 carries this to the 823 gate and does not ask it here.
- **Q-07 (open, D-16):** the HaynesTower free-space step of about +8.7 TB at the 2026-11-12 sample
  is not intake and not Trash. The adversarial review of 2026-11-13 timed a rise of 8,851 GB between
  14:00 and 16:00 UTC on 2026-11-11, with no deletion recorded by the app. The forecast sets that one
  step aside. Recommendation: leave it set aside, which is what D-16 does.
- **Q-08 (open, D-16):** the save rate is not stationary. The last movie batch (swept 2026-11-13)
  saved about 34% of its bytes; the 90-day byte-weighted rate is 0.119480. Recommendation: keep the
  90-day rate, which inflates the ask less, until the owner says the recent rate is the new one.
- **Q-09 (open, D-16):** whether the Maintainerr rules refill the eligible pool after a pace run
  empties it. The corrected projection assumes they do not. The review (2026-11-13) found no stored
  history of pool membership. From the current snapshot it estimated that refill adds about 1.2 TB
  to the 60-day deletions, which would put the shortfall near 55.2 TB. Recommendation: judge the
  56.419 TB shortfall against the stock measured on 2026-11-13.
- **Q-10 (open, D-16):** whether guardian skips (about 5.0% of movie proposed bytes over those 90
  days) should reduce the expected yield. The review measured a yield of 0.8334 when skips are
  counted, and 0.790 since the 2026-10-30 rule load (the last batch 0.641). Recommendation: no. The
  eligible pool already excludes the guards, and the next batch picks different titles. The
  projection uses yield 0.880520.
- **Q-11 (open, D-16):** whether the floor should ignore the pool-short 19-item batch and use the
  smallest full 50-item proposed total, 800,535,856,306 bytes (closed 2026-08-22). Recommendation:
  use the smaller observed total, 130,604,353,957 bytes, because a higher floor deletes more.
- **Q-12 (open, D-16; the review's Q-R01):** under target, what is the steady pace? The story asked
  for a steady maintenance pace. The code asks for the intake over one window, the same amount at
  any level under the target, and at a target of 100 percent. Recommendation (the review,
  2026-11-13): post nothing until the trend would cross the target inside the horizon, then only
  what holds the target. The formula the review recommends is
  `max(0, (targetFree − free) − rate × horizon) × min(1, window / horizon)`.
- **Q-13 (open, D-16; the review's Q-R02):** is the horizon a deadline or a time constant? The
  shipped horizon is a rolling time constant. At the default ceiling, with an unlimited pool, the
  review's simulation leaves a 39.4 TB gap at day 60 and reaches the target after about a year.
  With no ceiling the 60-day horizon leaves 19.8 TB at day 60 and 6.4 TB at day 120. A 30-day
  horizon leaves 8.2 TB at day 60; 21 days leaves 3.9 TB. Those figures are the review's simulation
  of 2026-11-13 (intake 329.8 GB/day, yield 0.8805). This correction did not re-run it.
  Recommendation: keep the rolling rule, call it a time constant, and set it to 21 to 30 days so
  that 60 days closes most of the gap.
- **Q-14 (open, D-16; the review's Q-R03):** what is the largest batch acceptable in one 7-day
  window, in bytes and in titles? The code's ceiling is 3,591,025,375,575 bytes and there is no
  title cap. On today's pool the review counted a first batch of 155 titles (3.604 TB) and a second
  of 229. Recommendation: keep 3.59 TB until story 823, add a title cap, and decide both against
  the pool that exists then.
- **Q-15 (open, D-16; the review's Q-R04):** does TV keep its 5-title cap while the pace is on? The
  code drops `maxItems` when the pace applies. The review's example: a 20 TB TV pool beside today's
  movies would take 2.59 TB of a 3.59 TB ask, worst-rated first. Recommendation: yes, keep the
  5-title cap until story 835 decides.

Pace questions start at Q-07. Main's D-15 already holds Q-04, Q-05 and Q-06. The review numbered
its four questions Q-R01 to Q-R04. This change assigns them Q-12 to Q-15, after this change's own
Q-07 to Q-11. The coordinator's intake (story 820, comment 8175, 2026-11-13T20:15Z) states the
review's recommendation for Q-12 and Q-15, a 30-day horizon for Q-13, and leaves Q-14 to story 823.
Those stay open for the owner.

## D-09 — Amendment 2026-07-09 (owner-directed, build A) — modes + per-kind caps, relocated config

Three owner changes to the space policy, layered on the propose-only core (still NEVER deletes):

### D-09a — Proposal `mode`

`space_policy.mode: 'over-target' | 'continuous'` (default `'over-target'`).

- **`over-target`** (unchanged behavior): propose for a per-array-enabled array only when its `usedPct`
  is over its `space_targets` ceiling AND no open batch for the backing kind.
- **`continuous`**: propose for a per-array-enabled kind whenever there are ≥ `minCandidates` candidates,
  the cooldown has elapsed, and no batch is open — **the disk target is NOT required.** Utilization is
  still read (getUtilization) so the report/notification can cite `usedPct`, but a null/under-target read
  no longer blocks. The per-array **opt-in still gates** continuous mode (turning the policy on can never
  surprise-propose on an array you forgot — ADR-031 safety valve preserved).

`evaluateSpacePolicy` branches the array-level gate on `mode`; everything downstream (idempotence,
cooldown, min-candidates, the ledger event + notification, the skip-gate pass-through) is identical.

### D-09b — Per-kind composition caps (`perKind`) — absorbs the retired `targetBytesPerBatch`

```ts
perKind: {
  movie: { maxItems: { enabled, value }, targetBytes: { enabled, value } },
  tv:    { maxItems: { enabled, value }, targetBytes: { enabled, value } },
}
```

Each cap is independently enable-checkboxed; both combine — the greedy fill stops at the **first cap
hit** (`selectBatchCandidates`, DESIGN-011 D-09b). Policy batches take the **worst-rated first** (the
owner default — trim the least-loved titles; `strategy: 'worst-rated'`). Applied in **BOTH** modes via
`buildKindTargeting`, and the same per-kind caps **pre-fill the manual "Start a batch" picker** (which
gains a matching size + item-count cap pair). `effectiveKindTargeting` typeof-guards every field
(fail-safe per ADR-031): a non-boolean `enabled` reads OFF, a non-finite/≤0 `value` drops the cap.

**Migration (graceful, no SQL):** the retired flat `targetBytesPerBatch` key is read by `getSpacePolicy`
as a **movie + tv `targetBytes` cap** (`enabled: true`, that value). Once a real `perKind` object is
stored it is authoritative and the legacy key is ignored. Zod `SpacePolicyInput` is `.strict()` and now
carries `mode` + `perKind` (drops `targetBytesPerBatch`); audited through `setAppSetting`.

### D-09c — Config relocated to Trash SETTINGS (`/settings/trash`)

The mode select, per-kind cap rows, and `minCandidates` + `cooldownDays` are surfaced on
**`/settings/trash`** (the "Batch policy" section), not `/admin/storage` (the fuller IA reshuffle is a
follow-up). The whole page is ONE form with a **single green Save at the bottom** (the save-window
inline Save is absorbed; each changed app-setting is still written/audited individually). The Admin
gate stays a **separate immediate action**, its ConfirmButton ceremony unchanged, but re-labelled to the
ACTION on the gate itself: **"Disable"** when the gate is ON, **"Enable"** when it is OFF. The
`/admin/storage` "Space policy" card (enable + per-array opt-in) is untouched and still round-trips the
whole object (its merges preserve `mode`/`perKind`).

## D-10 — Amendment 2026-07-09 (owner-directed, build D) — per-kind `strategy` + the shared ranking

The batch-selection ranking `selectBatchCandidates` used (worst-rated / largest) is now the **single
seam** `compareByStrategy` in `packages/domain/src/trash-strategy.ts`, shared with the pending walls'
"Next up" default sort (DESIGN-010 D-13) so a wall's top is exactly the front of the next batch's pick.

`SpacePolicyKindCaps` gains an optional `strategy?: 'worst-rated' | 'largest'`. `activeBatchStrategy(policy,
kind)` resolves it fail-safe to the owner default `worst-rated` when unset/garbage. `buildKindTargeting`
now reads that resolver instead of the hard-coded `'worst-rated'` — **behaviour-preserving** (an unset
strategy still yields `worst-rated`), but the policy pick and the wall order now share one configurable
source. `getSpacePolicy`/`resolvePerKind` preserve a valid stored per-kind strategy (jsonb; no migration).

## D-14 — Amendment 2026-07-18 (ADR-073) — the AUTONOMOUS cycle: promote-on-propose, no cooldown, self-heal

Owner ruling (2026-07-18): the Trash cycle must run **unattended for eternity** — reclaim → the next
batch promotes immediately (no cooldown, no admin-review gate before it goes up) → 7-day save window →
reclaim → …. The prod symptom (2026-07-18): a swept batch left the next policy batch stuck in
`admin_review` forever (nobody green-lit it), so the save window never opened. This amendment supersedes
the propose-only parts of D-01..D-03 and D-07/D-09c.

- **Promote-on-propose (supersedes D-02 step 4).** `createBatchFromPending` gains an `autoPromote` flag;
  the `space-policy` mode always passes it. A proposed batch is driven straight `draft → leaving_soon`
  (`promoteToLeavingSoon`, the same path the skip-gate used) with `gate_skipped=true` + system
  attribution (`created_by`/`greenlit_by` null), REGARDLESS of the global `trash_skip_admin_gate`. Still
  never sweeps; only the windowed sweep deletes. The `batch_created` + `batch_leaving_soon`(+reminder /
  final-warning) outbox pushes both fire same-tx as before.
- **No cooldown (supersedes D-01 `cooldownDays`, D-02 step "cooldown?", D-03 `nextEligibleAt`).**
  `cooldownDays` is removed from `SpacePolicyArrayConfig`, `SpacePolicy`, the defaults, `effectiveArrayPolicy`,
  the API `SpacePolicyInput`, both admin cards, `lib/space-policy` (`effectiveCooldownDays`/`nextEligibleLabel`),
  and `SpacePolicyKindStatus` (`cooldownDays`/`nextEligibleAt`). Pacing is one-open-per-kind + the save
  window alone. A stale `cooldownDays` key on an old stored jsonb row is ignored on read — **no migration**.
- **Self-heal (new — idempotent convergence).** Each run, for each opted-in array's kinds, a SYSTEM batch
  (`created_by IS NULL`) a prior run left stuck in `draft`/`admin_review` is promoted to `leaving_soon`
  (`promoteOpenPolicyBatch`) — independent of the over/under-target gate, so a mid-cycle death (or a batch
  from before this change) always converges on the next tick. A healthy `leaving_soon` batch is left alone
  (its window is running); a MANUAL batch (`created_by` set) is never auto-promoted. New outcomes:
  `promoted` (self-healed) and `skipped_under_target` (over-target mode, under target); `skipped_cooldown`
  and the `cooldownUntil` field are gone.
- **UI (supersedes D-07/D-09c).** The "Cooldown" editor is removed from BOTH the General "Batch policy"
  card and the Storage "Space policy" card; the copy no longer says "for admin review — the admin gate
  stays the human check" (it now posts to Leaving Soon on its own). The continuous-mode label drops
  "+ cooldown". `minCandidates` + `mode` + per-kind caps remain.
- **Graduation (D-05 / ADR-031 C-05) is now advisory.** The autonomous engine no longer depends on
  `trash_skip_admin_gate`; the readiness block is informational for MANUAL green-lighting only.

Tests: `packages/domain/__tests__/space-policy.test.ts` proves auto-promote to `leaving_soon`, the
**self-heal of a stuck `admin_review` system batch** (the reproduced prod stall → `promoted`), that a
MANUAL admin_review batch is left untouched, and that a healthy `leaving_soon` batch is not duplicated.

## D-15 — TV rule body (owner rulings 2026-11-13, story 835)

The ruling recorded on story 822 (comment 7992) adopts the recommendation in
[`.agents/context/2026-11-13-tv-trash-audit.md`](../../.agents/context/2026-11-13-tv-trash-audit.md).
Story 835's written scope still lists those four clauses. A later ruling on story 835 (comment 8099,
2026-11-13T18:55Z) answers the adversarial review's Q-05 with "Add the votes floor" and adds the fifth
clause below. This section follows that later ruling. It is not applied here. Applying it is story
823. The movie rule is unchanged. The pool stays whole-show. The cap, the ranking, the Age Guard, the
watchlist keep, Saves, the `dnd` tag and the `mediarequests` exclusion are unchanged.

No new glossary term. The pool, the Age Guard (T-273) and the aging invariant (T-105) keep their names.
The votes floor is the movie rule's existing clause, not a new term. No superseding ADR.
[ADR-036](../adrs/036-maintainerr-aging-invariant.md) does not read rule predicates, and replacing the
added-date clause does not make `auditMaintainerr` refuse the pool. The check is below. That audit
still does not read predicates; a predicate check in it is a dependency of story 823, not a change
in this story.

Evidence for the live reads, the image comparator, and the shows that pass the predicates:
[`.agents/context/2026-11-13-tv-trash-rule-correction.md`](../../.agents/context/2026-11-13-tv-trash-rule-correction.md).

### The body

Group id **2**, `dataType` `"show"`, `libraryId` `"2"` (both strings, as `GET /api/rules` returns them),
`useRules` true, `isActive` true. Collection id **3**, type `show`, `deleteAfterDays` **9999**,
`arrAction` **0**, `listExclusions` true, `forceSeerr` true, `manualCollection` false. Section **0**
only. The first clause's `operator` is null. Each later clause's `operator` is `0` (`AND`).

Maintainerr 3.32.0 (`commitTag` `latest-e6327bb`). Property ids are from `GET /api/rules/constants`
for media type show (`MediaType.SHOW` = 2). Comparator ids are the image's `RulePossibility`, which
matches the action numbers on the live clauses. The constants payload lists possibility numbers and
does not name them. `BIGGER` is `0` in the running image's
`packages/contracts/dist/rules/constants.js` (read 2026-11-13, this correction). Property 20's
possibility list is `[0, 1, 2, 3, 18, 19]`, so `0` is a legal action on `ratingVotes`. Number tests
are strict: `BIGGER` is `val1 > val2` and `SMALLER` is `val1 < val2` (`doRuleAction` in
`rule.comparator.service.js`, same read). `BEFORE` on a date property whose custom value is a number
of seconds is `value <= now - seconds`.

A null or undefined value does not pass. For an AND clause the comparator drops the show without
comparing (`firstVal != null` is required). The first clause, whose operator is null, adds a show
only when the comparison is true, so a missing value is not added. That is not the unrated case.
Sonarr reports an unrated show as rating `0` with `0` votes, not null. `0` is present, and `0 < 6.0`
is true, so an unrated show passes the rating clause. The votes clause then drops it, because `0` is
not greater than `99`. The getter is `showResponse.ratings?.value ?? null` and
`showResponse.ratings?.votes ?? null` (`sonarr-getter.service.js`, same read).

The rating, votes and tag clauses stay Sonarr properties. `ended`, `firstAirDate` and `seasons` are
the only Sonarr properties `tryMetadataFallback` will answer when Sonarr has no series id; `rating`,
`ratingVotes` and `tags` are not in that set. For a show Sonarr does not track, `ended` can come from
the metadata provider. The adversarial review (2026-11-13, 18:32Z–18:50Z) measured 31 HaynesOps shows
with no Sonarr match in the 15:00Z run. Those three Sonarr clauses are what keep that class out.

| # | Application | Property | Action | `customVal` |
| --- | --- | --- | --- | --- |
| 1 | Sonarr `2` | `19` `rating`, "Show rating (IMDb) (scale 0-10)", number | `SMALLER` `1` | `{ "ruleTypeId": 0, "value": "6.0" }` |
| 2 | Sonarr `2` | `20` `ratingVotes`, "Show rating (IMDb) vote count", number | `BIGGER` `0` | `{ "ruleTypeId": 0, "value": "99" }` |
| 3 | Sonarr `2` | `2` `tags`, "[list] Tags (show)", text list | `NOT_CONTAINS` `9` | `{ "ruleTypeId": 2, "value": "mediarequests" }` |
| 4 | Sonarr `2` | `7` `ended`, "Show ended", boolean | `EQUALS` `2` | `{ "ruleTypeId": 3, "value": "1" }` |
| 5 | Plex `0` | `27` `sw_lastEpisodeAiredAt`, "Last episode aired at", date | `BEFORE` `5` | `{ "ruleTypeId": 0, "value": "15552000" }` |

Clause 1 is the live row 1 (id 156) and clause 3 is the live row 3 (id 158), values unchanged. Clause
2 is the movie rule's floor on the show property: movie group 1's live votes clause, read this
session from `GET /api/rules` before 19:21:34Z, is action `0`, `firstVal` `[1, 19]`,
`customVal` `{ "ruleTypeId": 0, "value": "99" }` (Radarr property 19). The show property is Sonarr
`20`, not `19`. A count of exactly 99 does not pass. The order is the one a cut-short write must
leave: rating, then votes, then tags, then ended, then aired. `updateRules` deletes every rule row
for the group and inserts one at a time, with no transaction around that loop
(`rules.service.js`, read 2026-11-13). A write that stops leaves a prefix of this list.

Removed, and not stored as an inactive clause: Plex property `17` `sw_amountOfViews` ("Total views")
`SMALLER` `1`. That clause reads HaynesOps only.

There is no Sonarr property for "last episode aired". The nearest Sonarr dates are `firstAirDate`
(id 4) and the booleans `seriesFinale` (id 17) and `ended` (id 7). The air-date clause uses the Plex
property whose human name is "Last episode aired at". Do not substitute a Sonarr date.

Why these `ruleTypeId`s, from the running image (not from the property's type key alone):

- `ended` is boolean (type key `3`). `validateRule` accepts a custom value only when its `ruleTypeId`
  equals that key, except the date/number and text-list/text cases below. The Sonarr getter returns
  `1` or `0`, not a boolean. `EQUALS` then uses strict `===`. `ruleTypeId` 3 coerces the custom value
  with `+value`, so the value must be the string `"1"`. `"true"` becomes `NaN` and matches nothing.
  The UI writes `"1"` for a boolean custom value unless the value is already `"0"`.
- `sw_lastEpisodeAiredAt` is a date. The live added-date clause, and the seconds path in the
  comparator, use `ruleTypeId` **0** (`NUMBER`) with action `BEFORE`. The comparator then sets the
  right-hand side to `now - seconds` and `BEFORE` keeps a left-hand side at or before that instant.
  `15552000` is `180 * 86400`. A date `ruleTypeId` of 1 with the same digits is a timestamp in 1970,
  not "180 days ago". Copy the live added-date encoding and change only `firstVal` from `[0, 0]` to
  `[0, 27]`.
- `rating` stays the live clause: type key and `ruleTypeId` are both 0, value `"6.0"`. `SMALLER` is
  `<`, so a rating of 6.0 does not pass. The getter reads Sonarr `ratings.value`. The ledger stores
  that same number in `media_metadata.tmdb_rating`. An unrated show's `0` passes this clause; the
  votes clause is what excludes it.
- `ratingVotes` uses the same number encoding as the movie votes clause and as `rating`: type key and
  `ruleTypeId` are both 0, value `"99"`, action `BIGGER` (`0`). The getter reads Sonarr
  `ratings.votes`.
- `tags` stays the live clause. The property type is text list (key 4). `validateRule` also accepts
  `ruleTypeId` 2 (`TEXT`) on a text list, which is what the live clause stores. `NOT_CONTAINS` is the
  negation of `includes`. `doRuleAction` lowercases both string sides, and the string elements of an
  array, before it compares (same file, read 2026-11-13). The stored value stays `mediarequests`. A
  different case would still match. The earlier claim that the custom string is not lowercased was
  wrong; it does not change this label.

`sw_lastEpisodeAiredAt` is not "the show's last episode aired". The Plex getter
(`plex-getter.service.js`, `case 'sw_lastEpisodeAiredAt'`, read 2026-11-13) loads the show's children
on the one Plex server Maintainerr is configured with (HaynesOps), sorts those seasons by `index`,
takes the last season, sorts that season's episodes by `index`, and reads the last episode's
`originallyAvailableAt`. Plex lists only what HaynesOps holds. The date is the last episode, by
number, of the highest-numbered season on that server. It is not the maximum air date across
episodes, and it is not Sonarr's finale.

That differs from the true finale in both directions:

- The highest-numbered season on disk can be older than the finale. An ended show whose final season
  is not on HaynesOps is tested on that older date and can pass while its real finale is recent. The
  adversarial review measured 30 of 661 ended HaynesOps shows with a higher-numbered season in Sonarr
  and no files, and 13 ended shows with a finale inside 180 days. None of those was below 6.0 and
  untagged on that read (2026-11-13, 18:32Z–18:50Z). A Plex date earlier than the true finale admits
  a show.
- A Plex date that is null, or later than the Sonarr stand-in used in the projection, drops a show
  the projection keeps. A null date fails the clause.

Specials are season index 0. The sort takes the highest index, so a special is not the episode under
test when HaynesOps holds any higher-numbered season. The review measured a Muppets Now special dated
2025-03-06; that date is not the one this clause reads. The season property
`sw_seasonLastEpisodeAiredAt` (Plex id 29) is not used.

The Sonarr stand-in in the evidence note is `previousAiring`. The review's closer stand-in (the last
episode with a file, in the highest season that has files) also passes all ten. Neither is a Plex
read. Story 823's collection read is the check.

The stored description replaces the current one. The name stays (Q-04). Description, 629 characters:

```text
Show-level candidates on HOps TV Shows. A show passes only when its Sonarr rating is below 6.0, its Sonarr rating votes are greater than 99, its Sonarr tags do not contain mediarequests, Sonarr says it has ended, and the last episode HaynesOps Plex holds, in its highest-numbered season, aired at least 180 days ago. Plays are not a Maintainerr predicate. The app still keeps a show with a household view in the last 30 days, and it still applies the cap, the Age Guard, the watchlist, Saves and the dnd tag. This collection does not delete on its own: arrAction 0 and deleteAfterDays 9999, with listExclusions and forceSeerr on.
```

Plays are not a Maintainerr predicate. The app's guardian still keeps a show whose household
`last_viewed_at` is inside `RECENTLY_WATCHED_WINDOW_DAYS` (30) via `classifyGuardian`
(`packages/domain/src/trash-flow.ts`). The description says so. It does not say plays are absent
from every keep.

Decoded rules, in order. `upsertTrashRule` sends this shape (no `ruleJson`, no old ids):

```json
[
  {
    "operator": null,
    "action": 1,
    "firstVal": [2, 19],
    "customVal": { "ruleTypeId": 0, "value": "6.0" },
    "section": 0
  },
  {
    "operator": 0,
    "action": 0,
    "firstVal": [2, 20],
    "customVal": { "ruleTypeId": 0, "value": "99" },
    "section": 0
  },
  {
    "operator": 0,
    "action": 9,
    "firstVal": [2, 2],
    "customVal": { "ruleTypeId": 2, "value": "mediarequests" },
    "section": 0
  },
  {
    "operator": 0,
    "action": 2,
    "firstVal": [2, 7],
    "customVal": { "ruleTypeId": 3, "value": "1" },
    "section": 0
  },
  {
    "operator": 0,
    "action": 5,
    "firstVal": [0, 27],
    "customVal": { "ruleTypeId": 0, "value": "15552000" },
    "section": 0
  }
]
```

### What the cap still does

`app_settings.space_policy`, read 2026-11-13 17:49:20Z from replica `postgres16-11`, TV
`maxItems` 5 enabled, `targetBytes` disabled, no `strategy` key, `minCandidates` 1, mode
`over-target`, `updated_at` 2026-10-30 11:07:46-04. An absent strategy resolves to `worst-rated`
(`activeBatchStrategy` in `packages/domain/src/app-settings.ts`). This story does not write that row.

`selectBatchCandidates` drops an open Save, a `dnd` tag, a watchlisted title and an Age Guard
`recent` title **before** it counts to 5. The cap does not choose five of the raw pool and then
discover that four of them are kept. With three shows left after `dnd` and the watchlist, and all
three still inside the Age Guard, the cap's deletable input is empty until those dates clear. Once
they clear, three is under five, so the cap drops none of them.

### Aging invariant

`evaluateAgingInvariants` (`packages/domain/src/trash-flow.ts`) refuses an active rule pool when
`deleteAfterDays` is below `AGING_HORIZON_MIN_DAYS` (3650), `arrAction` is not 0, `listExclusions`
is not true, or (for a non-episode pool) `forceSeerr` is not true. It does not read `rules[]`.
`auditMaintainerr` folds those violations into `safe`. `sweepExpiredBatches` refuses the sweep when
`safe` is false. Replacing the added-date clause leaves every field that function reads as it is
(measured on group 2's collection: `deleteAfterDays` 9999, `arrAction` 0, `listExclusions` true,
`forceSeerr` true, type `show`). The audit will not refuse the pool for this predicate change.
ADR-036 stays Accepted and is not edited. No superseding ADR.

`ruleGroupDrift` compares the same flags and not the predicates. After the day of the apply, nothing
in the sweep re-reads the five clauses. Story 823 depends on a predicate check in that audit before
the new body is left in place across later days. This story does not write that check.

The Age Guard is a separate check. It still uses the newest of a download import and any server's
Plex added date, 180 times 86,400,000 ms (`judgeAge`). D-15 does not change the function. Removing
the TV date-added clause removes what the guard's own comment relies on for a title with no Plex
match (`packages/domain/src/trash-age-guard.ts`: a title no Plex library is matched to is judged on
its imports alone, "the Maintainerr rule's own HaynesOps date-added clause still applies to it").
`judgeAge` returns `clear` when there is no `media_plex_matches` row and no download import inside
180 days. For TV, after this body is applied, that comment is no longer true. The movie added-date
clause stays, and it is still that cover for a movie. DESIGN-010 no longer calls the Age Guard the
guarantee for this case. DESIGN-052 D-26's "the rules stay" sentence is narrowed: the movie
added-date clause stays; the TV predicates are this section; the guard stays in the app and does not
replace the removed TV date-added clause.

The adversarial review measured, on 2026-11-13 (18:32Z–18:50Z), that this bites nothing in today's
pools: 0 of 524 movie candidates and 0 of the ten shows below have no Plex match. It matters more
once story 836 lands: that review measured 339 of 661 ended HaynesOps shows with no download import
inside 180 days. The code question for 836, already passed on by the coordinator (comment 8099), is
that a pool member with no Plex match should be `unknown`, not `clear`. This story does not change
`judgeAge`.

### Apply and read back

The writer is `upsertTrashRule` (`packages/domain/src/trash-flow.ts`). It can express every clause.
A rule in the payload is a decoded `RuleDto` (`operator`, `action`, `firstVal`, `customVal`,
`section`). The writer does not strip those fields. No code change in this story.

The entry point is `trash.saveRule` (`packages/api/src/routers/trash.ts`). It calls `upsertTrashRule`
and then `triggerCandidateRefresh`, which re-reads the candidate snapshot. It does not itself call
`POST /api/rules/execute`. The 2026-10-30 movie apply used `upsertTrashRule` and then armed
`requestPoolRefreshAfterSave`, which the incremental sync turned into that POST
(`packages/domain/src/pool-refresh.ts`). This apply does not arm that refresh. A one-off script in
the app pod is the other way the 2026-10-30 change was reached; either way the payload is the one
below, and the writer is `upsertTrashRule`.

The payload carries numeric `id: 2`. `upsertTrashRule` treats any other id, including a missing id
or a string, as a create (`typeof decoded.id === 'number'` is the update test) and POSTs a second
TV group. Do not omit it.

The update path:

1. `GET /api/rules`, find group 2. The first PUT is allowed only when that live body is the
   pre-image below. If it is not, stop. Do not finish a prefix by appending the missing clauses.
   The only PUT onto a body other than the pre-image is the put-back of the pre-image itself, after
   a failed read-back of this write, or when the live body is a prefix of these five clauses.
2. Build the PUT from that group. Change only `description` and `rules` (the five objects above).
   Copy `dataType`, `libraryId`, `name`, `useRules`, `isActive`, `notifications`,
   `ruleHandlerCronSchedule` and `collection` verbatim, and set `id` to the number `2`. `libraryId`
   stays the string `"2"`. `dataType` stays the string `"show"`. `manualCollection` stays false and
   `manualCollectionName` stays the empty string the GET returned. The running image wipes the
   collection's media and its specific exclusions when any of those four differ.
3. `buildRuleGroupUpdate` lifts top-level flags the payload omits (`arrAction`, `listExclusions`,
   `forceSeerr`, the server ids, and the rest of `RULE_GROUP_TOP_LEVEL_FIELDS`) from the live
   collection, and refuses `useRules: false` while `rules` is non-empty. Send `useRules: true`.
4. `PUT /api/rules` through that writer. The image deletes every rule row for the group, then
   inserts one row per payload rule. New ids are assigned. Membership is not wiped by that delete.
   Do not call rule test, rule execute, or collection handle.
5. Read back **straight after** the PUT, before any handler run. `ruleGroupDrift` compares
   `arrAction`, `listExclusions`, `forceSeerr`, `tagInArr`, the Radarr and Sonarr server ids, and
   `collection.deleteAfterDays` only. A successful `upsertTrashRule` is not a predicate read-back.
   The predicate read-back is the fresh `GET` in the next list.

Predicate read-back, same `GET /api/rules`, immediately after the PUT:

- Group 2: `description` equals the 629-character text above, `name` unchanged, `dataType`
  `"show"`, `libraryId` `"2"`, `useRules` true, `isActive` true, `id` 2.
- Collection id still **3**. `collection.description` equals the same text (the adversarial review
  found Maintainerr writes the group description there; this session's GET showed both lengths
  equal, 748, on the live pre-image).
  `deleteAfterDays` 9999, `arrAction` 0, `listExclusions` true, `forceSeerr` true,
  `manualCollection` false, `type` `show`, `sonarrSettingsId` 1.
- Exactly five rules, section 0, in the order above. For each: `operator`, `action`, `firstVal`,
  `customVal.ruleTypeId`, `customVal.value` (string), and no `lastVal`. Ignore the new row ids.
- Group 1's five movie clauses are the movie pre-image below. If they are not, the TV write is
  treated as failed even when group 2 matches.
- Exclusion count still **360**, the count at `GET /api/rules/exclusion?rulegroupId=2` on
  2026-11-13T19:24:49Z (all `ruleGroupId` null; 8 of type `show`). A lower count, or the loss of one
  of the seven `dnd` shows' HaynesOps rating keys listed in the evidence note, is a stop. A higher
  count is a new exclusion and is explained, not a put-back by itself.
- No `trash_batches` row with `media_kind = 'tv'` and `created_at` between the PUT and this
  read-back.

If any of that differs, PUT the saved pre-image back through the same writer (numeric `id: 2`,
decoded rules, original description, same verbatim flags) and read it back the same way. If the
rollback also differs, disarm group 2 and stop.

"Do not sweep" is not an action. The sweep and the space policy are CronJobs. The handler is not
held by skipping them. The adversarial review's Loki read (2026-11-13, last 24 hours) showed the TV
group running four times: three on the 8-hour schedule and one at 15:00Z. A pending-item Save can
also ask for `POST /api/rules/execute` through `pool-refresh.ts`. The lever is to disarm group 2
through the same writer (`isActive: false`, numeric `id: 2`). The executor skips an inactive group
(`executeForRuleGroups`: "is not active. Skipping rule execution."). `createOrUpdateGroup` writes
that flag on the rule group, not on the collection row. `fetchMaintainerrPending` keeps collections
whose own `isActive` is true, so a disarm stops the next handler run and does not by itself empty a
collection a handler has already filled. Disarm before any handler run when the read-back fails.
The put-back of the pre-image is still required.

Before the handler is allowed to build the collection, the read-back above has matched. The Age
Guard still holds a show whose newest download import or Plex added date is inside 180 days. The
three expected members below are in that window; the dates are in the evidence note. Nothing in
this section deletes a file. `auditMaintainerr` being `safe` is the flag check only. It is not the
predicate check story 823 depends on.

### Pre-image (measured this session; re-read before any PUT)

Group 2, four clauses, from `GET /api/rules` on 2026-11-13. Ids 156–159 are what that GET returned.
A later GET that does not match this body, including the description, is a stop, not a thing to overwrite.

Description, 748 characters:

```text
hnet production junk rule (Sonarr / HOps TV Shows). Candidates = IMDb show rating < 6.0 AND never watched on HOps Plex (total episode views 0) AND NOT Sonarr-tagged mediarequests AND Plex date added older than 180 days (age guard added 2026-09-14 by owner ruling). Non-deleting rule collection: arrAction=0 (SAFE-audited baseline) + deleteAfterDays=9999 (ADR-036 aging invariant) — the app batch pipeline + guardian own deletion. listExclusions=true (2026-09-14, owner ruling): the delete also writes the Sonarr import-list exclusion so Kometa list runs cannot silently re-add a trashed series; Seerr and direct adds bypass that list. Requester + cross-server watch protection enforced by the app guardian. dnd tag/exclusion whitelists saved items.
```

| # | id | `operator` | `action` | `firstVal` | `customVal` |
| --- | ---: | --- | ---: | --- | --- |
| 1 | 156 | null | 1 `SMALLER` | `[2, 19]` rating | `{ "ruleTypeId": 0, "value": "6.0" }` |
| 2 | 157 | 0 | 1 `SMALLER` | `[0, 17]` total views | `{ "ruleTypeId": 0, "value": "1" }` |
| 3 | 158 | 0 | 9 `NOT_CONTAINS` | `[2, 2]` tags | `{ "ruleTypeId": 2, "value": "mediarequests" }` |
| 4 | 159 | 0 | 5 `BEFORE` | `[0, 0]` date added | `{ "ruleTypeId": 0, "value": "15552000" }` |

Group 1, movie, from the same kind of `GET /api/rules` on 2026-11-13 during this correction, before
the 19:21:34Z Sonarr read. Collection id 1, `mediaServerId` 98837, `isActive` true. Description
length 872; the text is not copied here. Clauses:

| # | id | `operator` | `action` | `firstVal` | `customVal` |
| --- | ---: | --- | ---: | --- | --- |
| 1 | 160 | null | 1 `SMALLER` | `[1, 16]` rating | `{ "ruleTypeId": 0, "value": "6.5" }` |
| 2 | 161 | 0 | 0 `BIGGER` | `[1, 19]` votes | `{ "ruleTypeId": 0, "value": "99" }` |
| 3 | 162 | 0 | 1 `SMALLER` | `[0, 5]` total views | `{ "ruleTypeId": 0, "value": "1" }` |
| 4 | 163 | 0 | 9 `NOT_CONTAINS` | `[1, 2]` tags | `{ "ruleTypeId": 2, "value": "mediarequests" }` |
| 5 | 164 | 0 | 5 `BEFORE` | `[0, 0]` date added | `{ "ruleTypeId": 0, "value": "15552000" }` |

A later GET that does not match these five clauses is a stop for the TV write.

### Shows that pass the predicates

Not a Maintainerr evaluation, and not the collection Maintainerr will hold. The ten are the shows
that pass the predicates on the Sonarr stand-in. Clock of the recompute **2026-11-13T19:21:34Z**.
"180 days" is `previousAiring <= clock - 15552000s` (cutoff 2026-05-17T19:21:34Z). Universe: the
953 live Sonarr series on HaynesOps library section `2` (replica `postgres16-11`,
2026-11-13T19:20:38Z, still 953 distinct tvdb). Full table: the evidence note.

With the fifth clause the same ten shows pass, **412,648,319,552 bytes** (0.413 TB at bytes/10^12).
Lowest vote count among them is 1,276 (Total DramaRama). Nothing in the ten changed from the
17:49:20Z four-predicate projection or from the audit. After `dnd` (tag id 27) and the watchlist,
the same three shows and **55,304,752,845 bytes** (0.055 TB). The watchlist re-read at
2026-11-13T19:24:02Z is still 201 distinct show tvdb ids, and of the ten only Mickey Mouse Clubhouse
is listed.

A cut-short write leaves a prefix. Sizes are shows in the 953, air date by the Sonarr stand-in.
The adversarial review measured the old body order (ended, aired, rating, tags) as 661 shows
(126.7 TB), then 648, 32, and 10. It measured rating-then-tag, without a votes clause, as 54 shows
(7.8 TB), then 12, 10, and 10. This correction recomputed the instructed order (rating, votes, tags,
ended, aired) at 19:21:34Z:

| Prefix | Shows | Bytes |
| --- | ---: | ---: |
| Rating below 6.0 | 54 | 7,838,701,560,290 |
| And votes greater than 99 | 51 | 7,626,460,152,772 |
| And no `mediarequests` tag | 12 | 838,724,127,581 |
| And ended | 10 | 412,648,319,552 |
| And aired at or before the cutoff | 10 | 412,648,319,552 |

The votes clause removes 3 of the 54 (212,241,407,518 bytes). Two are unrated (rating 0, votes 0):
Condor (tvdb 342107, 95,093,226,610 bytes) and Nightmare Tenants, Slum Landlords (tvdb 297091,
89,873,803,876 bytes). The third is 90 Day: The Last Resort Between The Sheets (tvdb 457446, rating
5.9, 56 votes, 27,274,377,032 bytes), which is not ended. All three carry `mediarequests`, so the
tag prefix stays 12 and the ten stay 10. The two-clause prefix is 51 shows, larger than the
review's rating-then-tag prefix of 12, because the votes floor removes only those three. The order
still puts votes immediately after rating, so a prefix that has not reached the tag already
excludes an unrated show.

### Expected collection, for story 823

After the handler runs, the collection is expected to hold three shows: Star Wars Resistance
(tvdb 351575), Muppets Now (368781), and Tales of the Walking Dead (411314). The other seven that
pass the predicates are excluded by Maintainerr's global exclusions, matched on the HaynesOps
rating key (evidence note): Total DramaRama, The Acolyte, Ironheart, She-Hulk: Attorney at Law,
Willow, Secret Invasion, and Mickey Mouse Clubhouse. An eighth global show exclusion is The
Baldwins (tvdb 459465), which is not one of the ten.

Story 823's rules, before any other action on the collection:

- Any member outside those three is a stop and a put-back of the pre-image, then the same read-back.
  Disarm if that put-back does not match.
- A missing one of the three is explained per show before anything else. Do not put the rule back
  merely because one is missing, until that show has an explanation.
- Every collection member has a dated HaynesOps row in `media_plex_matches`, else stop. At
  2026-11-13T19:24:02Z each of the ten has one dated row on HaynesOps section `2`.
- The three are a projection until 823 reads the collection. Plex `originallyAvailableAt` was not
  read. A Plex date that is null or later than `previousAiring` drops a show this projection keeps.
  A Plex date earlier than the true finale can admit one, as the air-date section says.

## D-16 — Amendment 2026-11-13 (ADR-120) — Dynamic Pace sizes the byte ask

The owner (2026-11-13) asked for Trash recommendations that follow the capacity target. The live
movie cap is a static 50 titles per save window, minus whatever is saved. The batch should grow
when the array is falling behind and hold a steady pace when it is under the target. The owner
asked that the return not have to happen in one week, and that the pace be capable of reaching the
target in a month or two. The shipped defaults do not do that. What they do is under "What the
defaults can do" below. Story 820's acceptance horizon is 60 days: the projection returns the array
to 75 percent, or it names the pool shortfall. It names the shortfall.

An earlier draft of this section was numbered D-15. Main already holds D-15 for the TV rule. This
decision is D-16, and its decision record is ADR-120.

This amendment changes **how many bytes** a policy batch asks for. It does not change which titles
are eligible. Watchlist, Age Guard, Save, the request tag, `dnd`, the Release Block and the Title
Exclusion are untouched. The batch is still built by `selectBatchCandidates`. The one title that
crosses the ask is still included. The policy still never sweeps.

The switch is `space_policy.dynamicPace.enabled`. It ships **off**. `getSpacePolicy` fills a missing
object with `enabled: false` and the bounds below. A non-boolean `enabled` reads as off. While the
switch is off, `evaluateSpacePolicy` does not read Prometheus and the per-kind caps and the
over-target gate behave as they do today (`packages/domain/__tests__/space-policy.test.ts`). There
is no migration: the object lives in the existing audited `space_policy` jsonb. The next save of the
existing Trash settings card round-trips it and persists the defaults with the switch off. This
change does not write the live row.

The adversarial review of 2026-11-13 (PR 1071, reads between 19:55Z and 20:40Z) is the source of the
corrected projection and of the default-capability figures below. This correction did not re-query
the replica or Prometheus.

### How intake is measured

`forecastFreeSpace` (DESIGN-013 D-08) is called on a copy of the chart's series
(`FREESPACE_SERIES_QUERY`, 90 days, 3-day step) after `addRecordedDeletions`: each sample at or
after a recorded sweep has that sweep's `deleted_size_bytes` subtracted. The step is then the
observed free-space change minus the Trash that happened inside it, so the rate is intake and not
intake minus Trash. The interquartile mean still sets a level jump aside. The live `/diskspace`
reading is the level for the gap and does not enter the rate.

Only completed batches (`trash_batches.state = 'deleted'`, `deleted_at` inside the 90-day window)
are added back, summed from items in state `deleted`. Direct expedites in that window with scope
`item` or `all` and a `sizeBytes` payload were 0 rows on 2026-11-13, so they are not added back.

A series that is too short (D-08: under 13 samples or a span under 36 days) does not size a batch.
Today's caps remain. A rate the forecast calls flat is treated as no measured intake: the gap is
still closed, and the intake term is omitted. A missing series (Prometheus down, empty matrix, or
the reader throws) also keeps today's caps.

Measured 2026-11-13 by running `explainDynamicPace` on the coordinator's HaynesTower series
(Prometheus, 2026-11-13T16:36Z, GB = 1e9 bytes) and the sweep bytes in the evidence note: the
unadjusted rate is −212.244 GB/day (the published D-08 figure is −212.2). After the deletions are
added back the rate is −329.767 GB/day, so intake is 329.767 GB/day. The review re-derived 329.770
GB/day (275 to 385 at two standard errors). The +8.7 TB step stays in the series and is set aside
(Q-07). The sweep of 3,246,674,077,176 bytes at 2026-11-06T15:46:13Z is removed from the step that
contained it.

The review corrected the window start. Ninety days before the 2026-11-13T18:43Z reading is
2026-08-15T18:43Z, not 2026-08-14. The same 13 batches fall inside the corrected window, so the
floor, the ceiling and the save rate below are unchanged.

### How the batch is sized

`targetFree = round(total × (1 − targetPct/100))`, the same free-byte floor as the chart.
Over target means live free space is strictly below that floor. `gap = max(0, targetFree − free)`.

`windowDays` is `trash_default_window_days` at run time (7 on the live row, read 2026-11-13; the
code default when the key is unset is 21). `horizonDays` defaults to 60.

- **Over target.** Required deletion this window is
  `max(0, gap − rate × horizon) × min(1, window / horizon)`. The ratio is clamped at 1 (the review's
  M4): a window longer than the horizon asks for the horizon's requirement once, not for
  `window / horizon` of it. A library that is filling adds the intake for the horizon, scaled by
  that ratio. A library that is draining reduces the requirement. If the trend already reaches the
  floor inside the horizon, the requirement is 0 and no batch is posted (`pace: 'none'`), even
  though `usedPct > target`.
- **Settings edge.** `storage.policy.set` refuses a horizon shorter than the current
  `trash_default_window_days` (`dynamicPaceHorizonFitsWindow`). A horizon equal to the window is
  allowed. The shipped default horizon is 60, which is longer than the live window of 7 and the
  code default of 21. A window lengthened after that save is still covered by the clamp. The window
  setter itself is unchanged.
- **Under target, switch on.** The code's requirement is `max(0, −rate × window)`: match the intake,
  the same amount at any level under the target and at a target of 100 percent, and do not spend
  the surplus. A drain, or an unmeasured intake, requires 0. This is the behavior the code has. It
  is Q-12, an open question for the owner. While the switch is off, under target is still
  `skipped_under_target`.
- **Save rate.** Byte-weighted over the same 90 days, movies and TV together, because they share
  the array: `saved size_bytes / (saved size_bytes + deleted deleted_size_bytes)` on completed
  batches. Skips are not in the ratio (Q-10). Null, or a rate outside `[0, 1)`, does not inflate
  (yield 1). Otherwise `unclamped = required / (1 − saveRate)`.
- **Floor and ceiling, on the ask.** A requirement of 0 stays 0: the floor does not force a batch.
  A positive ask is `min(ceiling, max(floor, floor(unclamped)))`, then limited by the eligible
  pool. `expectedDeleted = chosen × yield`. `shortfall = max(0, required − expected)`.
  `poolShortfall = max(0, ask − pool)`. The shortfall on the status read is this one-window figure.
  The horizon shortfall is finding 5, still open.
- **One ceiling for the array.** The ask is split across movie and TV in proportion to eligible
  bytes, largest pool first for the remainder, and no kind is asked for more than its pool. A kind
  with a 0 ask is not proposed (`skipped_pace`). While the pace applies, the code does not also
  apply the per-kind `maxItems` and `targetBytes` caps. The kind's strategy is kept. Dropping those
  caps, and the missing title cap, are Q-14 and Q-15.
- **Not applicable** (ceiling below the floor, no disk, too short, no series, or the preload
  throws): today's caps and today's gate. `chosenBytes` on that explanation is 0.

Eligible bytes are the same titles the proposal already keeps: a Maintainerr id, not a save, not
`dnd`, not on the watchlist, and not age-recent. The proposal reads that set live. The status read
uses the candidate snapshot, which lags, and says so (`poolSource: 'snapshot'`). The snapshot does
not feed the proposal. A title already in an open batch stays in the Maintainerr collection, so the
status read still counts it (finding 5). The projection below leaves those titles out of the pool
that is not yet posted.

### Defaults, from the measurements

| Bound | Value | Where it comes from |
| --- | --- | --- |
| Horizon | 60 days | Story 820's acceptance window. Not a disk statistic. What this horizon does is Q-13. |
| Floor | 130,604,353,957 bytes | Smallest proposed-byte total of a completed HaynesTower batch in the review's corrected window (90 days before 2026-11-13T18:43Z, so on or after 2026-08-15T18:43Z). That batch closed 2026-10-19 with 19 movies. The smallest full 50-item total in the same window was 800,535,856,306 (2026-08-22). The smaller number is the floor (Q-11). |
| Ceiling | 3,591,025,375,575 bytes | Largest proposed-byte total in that window: 50 movies, closed 2026-11-06, deleted 3,246,674,077,176 bytes. It is the code's safety bound. Whether it is the right batch size is Q-14. |
| Save rate | measured at run time | Not a stored default. On 2026-11-13T18:43:26Z, the same 13 completed batches: saved 1,897,158,268,845 bytes, deleted 13,609,206,491,654 (movies) + 372,082,386,455 (the one TV batch). Rate 0.119480. |

A stored bound that is not a safe integer is replaced by the default above. `ceiling < floor` after
that does not size a batch.

### What the defaults can do

The review simulated the formula with an unlimited pool, intake 329.8 GB a day and yield 0.8805.
This correction did not re-run that simulation. At the default ceiling, the gap at day 60 is
39.4 TB and the target is reached after about a year (the review's net progress is 0.85 TB a week
against a 43.4 TB gap). With no ceiling, the rolling 60-day horizon still leaves 19.8 TB at day 60
and 6.4 TB at day 120, because the horizon restarts every window: it is a time constant, not a
deadline. A 30-day horizon leaves 8.2 TB at day 60; 21 days leaves 3.9 TB.

The first required ask on the live disk is 8.37 TB (the review). The ceiling is 3.59 TB. That
ceiling is the single largest batch ever posted. It is a safety bound. If the rules deliver a
larger pool, the ceiling and the horizon are the limit. Q-13 and Q-14 ask the owner to rule them.

### What the read returns, and the card

`storage.policy.status` adds `pace`. Each batchable array gets the explanation: gap, intake (null
when it was not measured), required deletion this window, chosen size, shortfall, and the fields
around them (`DynamicPaceExplanation`). `applied` is true only when the switch is on and an array
could be sized. Prometheus or the disk failing leaves `pace` null and the existing card still loads.

The card is not changed. Showing those figures on the existing status block (`data-testid="policy-status"`)
needs a Fable worker: the current block is "Last proposal" plus one line per kind, and adding the
reasoning would be a new layout. That page work is the follow-up. Story 820's scope asked for the
card to show the reasoning. This change returns the fields and leaves the layout, which is the
follow-up the original order allowed when a new layout was required.

### Projection (not a forecast the app stores)

Labelled a projection. The figures are the adversarial review's measurement and projection of
2026-11-13. TB is 1e12 bytes. The method is the first projection's method with the open batch
removed from the pool that is not yet posted.

Rule for the central figures, checked in this correction on 2026-11-13
(`python3`, exact integer arithmetic, not a new live read):

- The review reproduced the first pool: 524 snapshot titles, 60 age-recent, 35 watchlisted, 5 both,
  434 eligible, 7,677,954,075,421 bytes. Of those, 50 titles and 1,881,676,268,710 bytes are the
  open `leaving_soon` batch. A posted title stays in the Maintainerr collection, so the first note
  was wrong to say the open batch was outside the eligible pool.
- Eligible pool not yet posted = 434 − 50 = 384 titles, and
  7,677,954,075,421 − 1,881,676,268,710 = 5,796,277,806,711 bytes = 5.796 TB.
- Deleted in 60 days = yield 0.880520 × (5,796,277,806,711 + 1,881,676,268,710) =
  6,760,592,122,490 bytes = 6.761 TB. The open batch is counted once, inside that sum.
- Required deletion over 60 days stays the first projection's 63.180 TB (gap 43.394 TB plus intake
  over 60 days, 19.786 TB). This correction did not remeasure that requirement. The review used it.
- Shortfall = 63.180 − 6.761 = 56.419 TB.
- Day-60 free space is the review's stated 76.07 TB. This correction did not re-simulate the week
  path that produces it. Used percent = 1 − 76.07 / 529.959 = 85.65% at two decimals. 529.959 TB is
  the review's rounding of the measured total 529,958,515,245,056 bytes.
- The ceiling is 3,591,025,375,575 bytes = 3.591 TB. The remainder of the not-yet-posted pool is
  5,796,277,806,711 − 3,591,025,375,575 = 2,205,252,431,136 bytes = 2.205 TB. Day 7 (2026-11-20)
  posts 3.591 TB. Day 14 (2026-11-27) posts the last 2.205 TB. Those bytes delete on 2026-12-04.
  The pool is used up by the batch posted on 2026-11-27.

HaynesTower does not return to 75% within 60 days. The array is at 85.65 percent at day 60.

With today's pool the pace deletes 0.04 TB more by day 60 than today's cap. The review's comparison
is today's fixed cap at 6.72 TB and Dynamic Pace at 6.76 TB (6.76 − 6.72 = 0.04). The precise pace
total above is 6.761 TB. The 6.72 TB cap figure is the review's; this correction did not recompute
the eight-batch cap path. The pace empties the eligible list in two batches (155 and 229 titles)
instead of eight.

The review's table of the most and least favourable readings, cited as printed on 2026-11-13. This
correction did not re-derive the rows other than the central one. The central row's 6.76 TB,
56.4 TB and 85.6% are that table's rounding of 6.761 TB, 56.419 TB and 85.65%.

| Reading | Deleted in 60 days | Shortfall | Used at day 60 |
| --- | --- | --- | --- |
| Most favourable: intake 294 GB/day (last 27 days before the jump), nothing saved, every snapshot title becomes eligible, refill | 11.48 TB | 49.6 TB | 84.4% |
| Corrected central | 6.76 TB | 56.4 TB | 85.6% |
| Least favourable: intake 394 GB/day (first 30 days), last batch's yield 0.641 | 4.92 TB | 62.1 TB | 86.7% |
| Least favourable, and the 8.85 TB jump reverses | 4.92 TB | 70.9 TB | 88.4% |

Q-09: the central shortfall assumes the rules do not refill the pool. The review's refill estimate
is about 1.2 TB more deleted, shortfall about 55.2 TB.

### Open questions, and work required before the switch

Q-07 to Q-15 are in the open-questions list above. Q-12, Q-13, Q-14 and Q-15 are the review's
questions for the owner. The code's under-target pace, the dropped per-kind caps, and the ceiling
and the horizon are those questions. They are not owner rulings.

The review's findings 5 to 10 are work required before the switch may be turned on. This change
does not build them.

1. **Finding 5.** The status read has no open-batch filter, so the pool is overstated by about one
   batch (1.88 TB of 7.68 TB on the review's day). `poolShortfallBytes` is the one-window ask after
   the ceiling. The horizon requirement is `gap + intake × horizon`, and its shortfall is that
   requirement against `pool × yield`.
2. **Finding 6.** Per-kind caps are dropped and nothing bounds the title count (Q-14, Q-15). The
   review's first batch on today's pool is 155 titles (3.604 TB) and the second is 229.
3. **Finding 7.** The reasoning that sized a real batch is not stored. `skipped_pace` writes
   nothing. A fall back to today's caps shows only as `pace: null` in a pod log. The status read
   can say `applied: true` while the job fell back.
4. **Finding 8.** Under target, the floor raises a small steady ask. The review's example: 1 GB a
   day of intake requires 7 GB and the ask is 130.6 GB.
5. **Finding 9.** A rate the forecast calls flat drops the intake term, reports `catch-up`, and
   computes the shortfall without intake.
6. **Finding 10.** Deletions are read from `now − 90 days` while the series can start up to 3 days
   earlier. There is no staleness check. The ceiling is not a hard cap: the crossing title is
   added (3.604 against 3.591 TB on the review's day). Recorded deletions and the save rate are not
   scoped to an array. `enabled: true` with an unreadable bound runs at the default bounds. The
   status read queries Prometheus, the three *arrs and the full snapshot on every load, switch on
   or off.

The review also requires, before the switch: owner rulings on Q-12 to Q-15 and code changed to
match; an observe-only step that records the ask while today's caps still build the batch (nothing
has shown that the CronJob pod can read Prometheus); stories 838, 843 and 844 done; and a
non-Claude review if a Fable worker makes those later corrections. The first batch after switch-on,
on the pool the review measured, would be about 155 titles (3.6 TB) against today's 50, and the
eligible list would be posted within two weeks.

Finding 4, the unclamped ratio, is the code change in this correction: the clamp, the settings-edge
refusal, and a test for each.

Tests: `packages/domain/__tests__/space-policy-pace.test.ts` (over target and falling, over target
and rising, the drain that closes the gap, under target, the floor not lifting a zero, an empty
pool, a save-heavy ceiling, frequent deletions whose sized intake is the true fill, a level jump
that is not intake, a flat series, a too-short series, a ceiling below the floor, the ratio clamped
at 1, a horizon shorter than the window refused, one ceiling shared by both kinds).
`space-policy.test.ts` proves the switch off equals today's `maxItems`, a missing or too-short
series keeps that cap, the switch on replaces it, under target proposes only when the pace has
intake, a closing drain posts nothing, and an open batch still holds the slot.
