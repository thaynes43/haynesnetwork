# DESIGN-014: Space-driven batch policy (propose-only) + rules-tuning report

- **Status:** Accepted — **amended 2026-07-18 by [ADR-073](../adrs/073-autonomous-trash-cycle.md)**: the
  space policy now PROPOSES **AND PROMOTES** its batches straight to Leaving Soon (autonomous cycle, no
  admin-review gate, no cooldown). The cooldown knob (`cooldownDays`) is retired everywhere. See the
  **D-14** amendment below; the original D-01..D-09 text describes the pre-073 propose-only behavior.
- **Last updated:** 2026-07-18
- **Author:** Fable 5 (autonomous run, PLAN-014); D-14 amendment by an Opus autonomous run
- **Implements:** [ADR-031](../adrs/031-space-driven-batch-policy.md),
  [ADR-073](../adrs/073-autonomous-trash-cycle.md). Consumes ADR-030 / DESIGN-013
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

No deletion behavior changes; no new deletion code path exists.

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
