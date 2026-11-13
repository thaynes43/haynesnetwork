# DESIGN-014: Space-driven batch policy (propose-only) + rules-tuning report

- **Status:** Accepted — **amended 2026-07-18 by [ADR-073](../adrs/073-autonomous-trash-cycle.md)**: the
  space policy now PROPOSES **AND PROMOTES** its batches straight to Leaving Soon (autonomous cycle, no
  admin-review gate, no cooldown). The cooldown knob (`cooldownDays`) is retired everywhere. See the
  **D-14** amendment below; the original D-01..D-09 text describes the pre-073 propose-only behavior.
  **Amended 2026-11-13 by [ADR-117](../adrs/117-dynamic-trash-pace.md)** (D-15): while Dynamic Pace is
  on, the byte ask comes from the gap and the intake. The switch ships off, and while it is off D-09
  and D-14 are unchanged.
- **Last updated:** 2026-11-13
- **Extended by:** [DESIGN-052](052-watchlist-protection-and-release-block.md) (ADR-093, 2026-09-26; in effect since 2026-09-28): the
  space policy's proposal leaves out a title on any read Plex watchlist (it takes no cap slot), and `minCandidates`
  counts deletable candidates only (DESIGN-052 D-08).
- **Author:** Fable 5 (autonomous run, PLAN-014); D-14 amendment by an Opus autonomous run
- **Implements:** [ADR-031](../adrs/031-space-driven-batch-policy.md),
  [ADR-073](../adrs/073-autonomous-trash-cycle.md),
  [ADR-117](../adrs/117-dynamic-trash-pace.md). Consumes ADR-030 / DESIGN-013
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

The original surfaces add no deletion path. D-15 changes how many bytes a batch asks for, behind a
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
- **Q-04 (open):** the HaynesTower free-space step of about +8.7 TB at the 2026-11-12 sample is not
  intake and not Trash. The forecast sets that one step aside. The cause is the owner's question.
  Recommendation: do not treat it as intake, which is what D-15 does.
- **Q-05 (open):** the save rate is not stationary. The last movie batch (swept 2026-11-13) saved
  about 34% of its bytes; the 90-day byte-weighted rate is 0.1195. Recommendation: keep the 90-day
  rate, which inflates the ask less, until the owner says the recent rate is the new one.
- **Q-06 (open):** whether the Maintainerr rules refill the eligible pool after a pace run empties
  it. The projection assumes they do not. Recommendation: judge the shortfall against the stock
  measured on 2026-11-13.
- **Q-07 (open):** whether guardian skips (about 5.0% of movie proposed bytes over those 90 days)
  should reduce the expected yield. Recommendation: no. The eligible pool already excludes the
  guards, and the next batch picks different titles. The projection's deleted figure is therefore
  slightly high, and the shortfall is not smaller than the number in D-15.
- **Q-08 (open):** whether the floor should ignore the pool-short 19-item batch and use the smallest
  full 50-item proposed total, 800,535,856,306 bytes (closed 2026-08-22). Recommendation: use the
  smaller observed total, 130,604,353,957 bytes, because a higher floor deletes more.

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

## D-15 — Amendment 2026-11-13 (ADR-117) — Dynamic Pace sizes the byte ask

The owner (2026-11-13): Trash recommendations should follow the capacity target. The live movie cap
is a static 50 titles per save window, minus whatever is saved. The batch should grow when the array
is falling behind and hold a steady pace when it is under the target. It does not have to be back on
target in one week. It should be able to get there in a month or two. Story 820's acceptance horizon
is 60 days.

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
(Prometheus, 2026-11-13T16:36Z, GB = 1e9 bytes) and the sweep bytes below: the unadjusted rate is
−212.244 GB/day (the published D-08 figure is −212.2). After the deletions are added back the rate
is −329.767 GB/day, so intake is 329.767 GB/day. The +8.7 TB step at 2026-11-12 stays in the series
and is set aside (Q-04). The sweep of 3,246,674,077,176 bytes at 2026-11-06T15:46:13Z is removed
from the step that contained it.

### How the batch is sized

`targetFree = round(total × (1 − targetPct/100))`, the same free-byte floor as the chart.
Over target means live free space is strictly below that floor. `gap = max(0, targetFree − free)`.

`windowDays` is `trash_default_window_days` at run time (7 on the live row, read 2026-11-13; the
code default when the key is unset is 21). `horizonDays` defaults to 60.

- **Over target.** Required deletion this window is
  `max(0, gap − rate × horizon) × (window / horizon)`. A library that is filling adds the intake
  for one window on top of the gap's share. A library that is draining reduces the requirement. If
  the trend already reaches the floor inside the horizon, the requirement is 0 and no batch is
  posted (`pace: 'none'`), even though `usedPct > target`. That is the smaller batch.
- **Under target, switch on.** The requirement is `max(0, −rate × window)`: match the intake, and
  do not spend the surplus. A drain, or an unmeasured intake, requires 0. This is the only place
  ADR-073 C-04 changes, and only while the pace applies. While the switch is off, under target is
  still `skipped_under_target`.
- **Save rate.** Byte-weighted over the same 90 days, movies and TV together, because they share
  the array: `saved size_bytes / (saved size_bytes + deleted deleted_size_bytes)` on completed
  batches. Skips are not in the ratio (Q-07). Null, or a rate outside `[0, 1)`, does not inflate
  (yield 1). Otherwise `unclamped = required / (1 − saveRate)`.
- **Floor and ceiling, on the ask.** A requirement of 0 stays 0: the floor does not force a batch.
  A positive ask is `min(ceiling, max(floor, floor(unclamped)))`, then limited by the eligible
  pool. `expectedDeleted = chosen × yield`. `shortfall = max(0, required − expected)`.
  `poolShortfall = max(0, ask − pool)`.
- **One ceiling for the array.** The ask is split across movie and TV in proportion to eligible
  bytes, largest pool first for the remainder, and no kind is asked for more than its pool. A kind
  with a 0 ask is not proposed (`skipped_pace`). The per-kind `maxItems` and `targetBytes` caps are
  not also applied. The kind's strategy is kept.
- **Not applicable** (ceiling below the floor, no disk, too short, no series, or the preload
  throws): today's caps and today's gate. `chosenBytes` on that explanation is 0.

Eligible bytes are the same titles the proposal already keeps: a Maintainerr id, not a save, not
`dnd`, not on the watchlist, and not age-recent. The proposal reads that set live. The status read
uses the candidate snapshot, which lags, and says so (`poolSource: 'snapshot'`). The snapshot does
not feed the proposal.

### Defaults, from the measurements

| Bound | Value | Where it comes from |
| --- | --- | --- |
| Horizon | 60 days | The owner's bound and story 820's acceptance window. Not a disk statistic. |
| Floor | 130,604,353,957 bytes | Smallest proposed-byte total of a completed HaynesTower batch with `deleted_at` on or after 2026-08-14, measured 2026-11-13T18:45:08Z. That batch closed 2026-10-19 with 19 movies. The smallest full 50-item total in the same window was 800,535,856,306 (2026-08-22). The smaller number is the floor (Q-08). |
| Ceiling | 3,591,025,375,575 bytes | Largest proposed-byte total in that window: 50 movies, closed 2026-11-06, deleted 3,246,674,077,176 bytes. |
| Save rate | measured at run time | Not a stored default. On 2026-11-13T18:43:26Z, completed batches since 2026-08-14: saved 1,897,158,268,845 bytes, deleted 13,609,206,491,654 (movies) + 372,082,386,455 (the one TV batch). Rate 0.119480. |

A stored bound that is not a safe integer is replaced by the default above. `ceiling < floor` after
that does not size a batch.

### What the read returns, and the card

`storage.policy.status` adds `pace`. Each batchable array gets the explanation: gap, intake (null
when it was not measured), required deletion this window, chosen size, shortfall, and the fields
around them (`DynamicPaceExplanation`). `applied` is true only when the switch is on and an array
could be sized. Prometheus or the disk failing leaves `pace` null and the existing card still loads.

The card is not changed. Showing those figures on the existing status block (`data-testid="policy-status"`)
needs a Fable worker: the current block is "Last proposal" plus one line per kind, and adding the
reasoning would be a new layout. That page work is the follow-up.

### Projection (not a forecast the app stores)

Labelled a projection. It holds the measured intake fixed, applies the 90-day yield to the open
batch as well as the pool, and posts a new batch only when the previous one has been swept (one
open batch per kind). Day 0 is the disk reading 2026-11-13T18:43Z. The open movie batch
(1,881,676,268,710 proposed bytes, 0 saved at that reading, expires 2026-11-20T17:17Z) deletes on
the day-7 step. The first dynamic batch can be posted then and deletes one window later. TB below
is 1e12 bytes. The code's first-window ask on these inputs is the ceiling, 3.591 TB, all of it movies.

HaynesTower does **not** return to 75% within 60 days. Required deletion over 60 days, if intake
continues, is 63.180 TB. The eligible movie pool (7.678 TB) plus the open batch, at the measured
yield, delete 8.417 TB. The shortfall is **54.762 TB** of free space still missing at day 60
(free 77.727 TB, used 85.333%). The pool is fully committed on the batch posted at day 21
(2026-12-04) and those bytes delete at day 28 (2026-12-11). After that the measured stock is gone
and use climbs, because intake continues (19.786 TB over 60 days) and deletions stop. Raising the
ceiling does not change the day-60 total: the pool, not the ceiling, is the limit. Q-06: this
assumes the rules do not refill the pool. Q-07: skips are not in the yield, so this shortfall is
not a high estimate.

| Day | UTC | Posted TB | Deleted that step TB | Free TB | Used % | Gap TB | Pool left TB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 2026-11-13 | — | — | 89.096 | 83.188 | 43.394 | 7.678 |
| 7 | 2026-11-20 | 3.591 | 1.657 | 88.444 | 83.311 | 44.045 | 4.087 |
| 14 | 2026-11-27 | 3.591 | 3.162 | 89.298 | 83.150 | 43.192 | 0.496 |
| 21 | 2026-12-04 | 0.496 | 3.162 | 90.152 | 82.989 | 42.338 | 0 |
| 28 | 2026-12-11 | 0 | 0.437 | 88.280 | 83.342 | 44.210 | 0 |
| 60 | 2027-01-12 | 0 | 0 | 77.727 | 85.333 | 54.762 | 0 |

Every cell is that formula rounded to 3 decimals. The 0.496 TB step is the remainder of the
7.678 TB pool. The day-60 gap equals the 54.762 TB shortfall.

Tests: `packages/domain/__tests__/space-policy-pace.test.ts` (over target and falling, over target
and rising, the drain that closes the gap, under target, the floor not lifting a zero, an empty
pool, a save-heavy ceiling, frequent deletions whose sized intake is the true fill, a level jump
that is not intake, a flat series, a too-short series, a ceiling below the floor, one ceiling
shared by both kinds). `space-policy.test.ts` proves the switch off equals today's `maxItems`, a
missing or too-short series keeps that cap, the switch on replaces it, under target proposes only
when the pace has intake, a closing drain posts nothing, and an open batch still holds the slot.
