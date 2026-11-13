# DESIGN-013: Disk-utilization + reclaim-metrics vertical

- **Status:** Draft
- **Last updated:** 2026-11-13 (D-08 capacity forecast)
- **Satisfies:** PRD-001 **R-108..R-111**; governed by **ADR-030** (HYBRID surface). Consumes ADR-025 /
  DESIGN-011 deletion snapshots, ADR-018 `media_metadata.resolution`, ADR-023 attribution. Grafana
  side recorded in **OPS-007**; glossary **T-95..T-97**, **T-332**.

## Overview

The **backend vertical** for the space story (PLAN-013): a native, admin-gated **Storage** tRPC
surface with two reads — **utilization** (current disk % per media array, from the *arr `GET
/diskspace` API) and **reclaim** attribution (from Postgres deletion snapshots) — plus **space-target**
get/set. The fill/drain **time-series** shipped first as a Grafana deep-link (ADR-030 C-04) and is
now **native** — `storage.trend` off in-cluster Prometheus (**D-07**, ADR-030 C-04 amendment
2026-07-09; the LAN-only deep-link demoted to a footnote). **D-08** (2026-11-13) adds the Capacity
Forecast on that same series: when each array's free space reaches its target floor and when it
reaches zero. The native Storage page shipped as
**`/admin/storage`** (same branch, Fable UX pass 2026-07-07) against the D-02/D-03/D-05 wire
contracts below, and later moved onto the `/settings/trash` Storage tab (IA reshuffle, build B).

## Detailed design

### D-01 — Data model + migration 0021 (additive)

- **`app_settings` new key `space_targets`** (ADR-030 C-05). jsonb, keyed by `plex_servers.slug` →
  percent-used ceiling; default `{}` ("no target set"). `AppSettingValueMap['space_targets']` =
  `SpaceTargets = Partial<Record<PlexServerSlug, number>>`. Written through the audited `setAppSetting`
  single-writer (co-writes `update_app_setting`). Migration **0021** drops + re-adds the
  `app_settings_key_enum` CHECK with the full list incl. `'space_targets'` (mirrors 0019's `motd`).
- **`trash_batch_items` partial index** `(state, deleted_at) WHERE state='deleted'`
  (`trash_batch_items_deleted_at_idx`) — serves the reclaim window scans without bloating the hot
  pending path. Additive, non-blocking.
- **No new table for expedite forward-capture** — the frozen `{sizeBytes, resolution, imdbRating,
tmdbRating}` ride existing jsonb payloads (the `trash_expedited` ledger event + the deletion-audit
  notification).

### D-02 — Utilization read (source of record = *arr `GET /diskspace`)

`@hnet/arr/read` gains `getDiskSpace()` on the shared read base (`GET /diskspace`, Lidarr on `/api/v1`),
parsing the BC-03 subset:

```ts
// packages/arr/src/schemas/common.ts
export const diskSpaceSchema = z.object({
  path: z.string(),
  label: z.string().optional(),
  freeSpace: z.number(),
  totalSpace: z.number(), // the field /rootfolder lacks — the reason diskspace is the source of record
});
export type ArrDiskSpace = z.infer<typeof diskSpaceSchema>;
```

`@hnet/domain` `getUtilization({ db, arr })` reads each needed *arr's `/diskspace` **once** (guarded
individually — one outage ⇒ that array is `unavailable`, never a throw), merges `space_targets`, and
dedupes the shared HaynesTower array. Returns one row per physical array:

```ts
export interface StorageArrayUtilization {
  key: string; // 'haynestower' | 'cephfs'
  label: string; // 'HaynesTower' | 'Music (CephFS)'
  path: string | null; // matched diskspace mount, null when unavailable
  freeSpace: number | null;
  totalSpace: number | null;
  usedPct: number | null; // (1 - free/total) * 100, one decimal
  target: number | null; // percent-used ceiling from space_targets, or null
  unavailable: boolean; // true when no source *arr could be read
}
```

### D-03 — Reclaim read (source of record = `trash_batch_items` deletion snapshots)

`getReclaim({ db, window })`, window ∈ `RECLAIM_WINDOWS = ['30d','90d','365d','all']` (default `'90d'`).
All breakdowns except `expedited` come from batch-swept `trash_batch_items` where `state='deleted'`
over the window (`deleted_at >= now - window`); `expedited` is the best-effort direct-expedite total
from `ledger_events` payloads (ADR-030 C-01b).

```ts
export interface ReclaimReport {
  window: ReclaimWindow;
  since: string | null; // ISO lower bound, null for 'all'
  totals: { items: number; reclaimedBytes: number };
  byCategoryResolution: {
    // the "3 × 4K = 90%" view, ordered by bytes desc
    mediaKind: 'movie' | 'tv';
    resolution: string; // deleted_resolution, or 'unknown'
    items: number;
    reclaimedBytes: number;
  }[];
  cumulative: {
    // running total by UTC day
    day: string; // YYYY-MM-DD
    reclaimedBytes: number; // that day
    cumulativeReclaimedBytes: number; // running
  }[];
  batches: {
    // per green-lit batch, attributed to the admin
    batchId: string;
    mediaKind: 'movie' | 'tv';
    greenlitBy: string | null;
    greenlitByName: string | null;
    items: number;
    reclaimedBytes: number;
    lastDeletedAt: string | null;
  }[];
  expedited: { items: number; reclaimedBytes: number }; // best-effort, direct-expedites only
}
```

**Exact SQL shapes** (drizzle): category × resolution = `GROUP BY trash_batches.media_kind,
coalesce(deleted_resolution,'unknown')`; per-day = `GROUP BY deleted_at::date` accumulated in JS;
per-batch = `GROUP BY batch_id, media_kind, greenlit_by, users.display_name LEFT JOIN users`; expedite =
`ledger_events WHERE event_type='trash_expedited' AND payload->>'scope' IN ('item','all') AND
payload->>'sizeBytes' IS NOT NULL`, summing `(payload->>'sizeBytes')::bigint`.

### D-04 — The slug → rootfolder-path map (the reconciliation)

`space_targets` is keyed by **Plex-server slug** (the owner's mental model — "HaynesTower < 80%"), but
the media arrays are physical mounts. `STORAGE_ARRAYS` (in `storage-metrics.ts`) is the documented map:

| Array `key`   | Label          | `targetSlug`  | diskspace mount path(s)                                      | *arr source(s)                                       | Live (2026-07-07)         |
| ------------- | -------------- | ------------- | ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------- |
| `haynestower` | HaynesTower    | `haynestower` | `/data/haynestower`                                          | Radarr (movies) + Sonarr (TV) **share it** — deduped | 529.96 TB, **78.8% used** |
| `cephfs`      | Music (CephFS) | `null`        | `/data/cephfs-hdd` (or rootfolder label `/data/media/music`) | Lidarr                                               | 174.84 TB, 25.4% used     |

Only `haynestower` maps to a surfaced array today. `haynesops`/`hayneskube` remain **reserved**
`space_targets` slugs (the in-cluster Plex servers on CephFS) whose per-server utilization is not yet
split out; the music array therefore carries **no target by default**. Movies + TV share ONE ~530 TB
NFS array, so the reading survives either Radarr **or** Sonarr being down (first reachable source wins).

### D-05 — tRPC surface + the admin page contract (input for the Fable UX agent)

`storage` router, **all adminProcedure for v1** (ADR-030 — operational data; a future
section-permission if it ever goes member-facing):

| Procedure             | Kind     | Input                                                                          | Returns                        |
| --------------------- | -------- | ------------------------------------------------------------------------------ | ------------------------------ |
| `storage.utilization` | query    | —                                                                              | `StorageArrayUtilization[]`    |
| `storage.trend`       | query    | `{ window?: '7d'\|'30d'\|'90d'\|'365d' }` (default `'30d'`) — D-07            | `StorageTrendReport`           |
| `storage.forecast`    | query    | — (the fit window is the method's, D-08)                                      | `StorageForecastReport`        |
| `storage.reclaim`     | query    | `{ window?: '30d'\|'90d'\|'365d'\|'all' }` (default `'90d'`)                   | `ReclaimReport`                |
| `storage.targets.get` | query    | —                                                                              | `SpaceTargets` (defaults `{}`) |
| `storage.targets.set` | mutation | `{ targets: { haynestower?, haynesops?, hayneskube?: 0..100 } }` (`.strict()`) | `{ changed, before, after }`   |

**Page contract — realized as `/admin/storage`** (a "Storage" admin sub-nav section: the whole
surface is adminProcedure-gated, so it lives beside Users/Catalog/Roles, not under Trash; DESIGN-006
identity, DESIGN-004 primitives, ADR-015 no-reorient). Presentation conventions the page pinned:
**capacity** renders in decimal/SI units (`formatCapacity` — the disk-vendor and *arr convention,
matching ADR-030's "112.4 TB free of 530 TB" cross-check) while **reclaim** sizes keep the binary
`formatBytes` the Trash pages use for the same rows; the meter tone deepens ok → warn (within 5
points of target) → danger (at/past target), with 85/95 absolute guardrails when no target is set.

- **Utilization card** — one row per `StorageArrayUtilization`: a labelled meter of `usedPct` with the
  `target` drawn as a threshold marker (color deepens past target — never reflow, ADR-015); show
  free/total in TB. An `unavailable` array renders a muted "couldn't reach {label}" state, not an error.
- **Reclaim view** — a window switcher (30d/90d/365d/all) driving `storage.reclaim`; the headline
  `totals.reclaimedBytes`; a category × resolution breakdown (the bang-for-buck bars, `byCategoryResolution`
  is pre-sorted bytes-desc); the `cumulative` curve; a per-batch table attributed to `greenlitByName`.
  **Empty-state is first-class** — reclaim starts empty and accrues from sweeps (it is normal to show 0).
  `expedited` is a small "+ N direct expedites (best-effort)" footnote, not folded into `totals`.
- **Targets editor** — a small admin form (`targets.get`/`targets.set`) of per-server percent ceilings.
- **Grafana deep-link card** — *(retired 2026-07-09, replaced by the D-07 native trend chart)* — was
  a link-out (NOT an iframe, ADR-030 C-04) to `https://grafana.haynesops.com/d/media-storage-utilization`
  (uid `media-storage-utilization`, Media folder). That URL is LAN-only; it survives as a muted
  one-line footnote under the chart ("Full infra dashboards: Grafana (LAN only)").

### D-07 — Native free-space trend (ADR-030 C-04 amendment, 2026-07-09)

The fill/drain time-series, **in-app** (the Grafana deep-link was LAN-only — dead for the mobile
audience the drivers prioritized; owner-greenlit replacement):

- **Prometheus read client** (`packages/api/src/prometheus.ts` — deliberately NOT in @hnet/arr's
  write-guarded space): `queryRange(query, start, end, step)` against `PROMETHEUS_URL`, which
  **defaults in code** to the in-cluster service
  `http://prometheus-operated.observability.svc.cluster.local:9090` (verified against the haynes-ops
  Grafana datasource) — the haynesnetwork helmrelease needs **no new env line**; setting
  `PROMETHEUS_URL` under `app.env` overrides it if the service ever moves. Zod-validates the
  `query_range` matrix subset. Injection mirrors the *arr/Plex bundles (`ctx.prometheus` in tests,
  env singleton in prod via `resolvePrometheusReader`).
- **`storage.trend`** (adminProcedure, `packages/api/src/storage-trend.ts`): input
  `{ window: '7d'|'30d'|'90d'|'365d' }` (default `30d`; steps 1h/4h/12h/48h keep every window ≤ ~185
  points). ONE PromQL round-trip — `max by (__name__, path)
  ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})` (the `max by` collapses
  pod-churn labels) — mapped onto the **same `STORAGE_ARRAYS` grouping as `getUtilization`** (the
  exportarr `path` label is the ROOTFOLDER under the D-04 mount, so matching is prefix-aware;
  HaynesTower dedupes radarr-first with sonarr fallback; multi-rootfolder sources max-merge).
  Returns per-array `{ key, label, points: [{t, freeBytes}], totalBytes, targetPct,
  targetFreeBytes }` — `targetFreeBytes = totalBytes × (1 − targetPct/100)`, the space target
  re-expressed as the free-bytes floor (the C-06 framing: free-bytes + target line, never a %
  trend). Prometheus down ⇒ `{ unavailable: true, series: [] }`, **never a throw** (C-03 posture).
- **The chart** (`freespace-trend.tsx` + pure geometry in `apps/web/lib/storage-trend.ts`):
  dependency-free inline SVG in the reclaim-strip school — a normalized (x = % width, y = px of the
  fixed 200px plot) space under `preserveAspectRatio="none"` + non-scaling strokes, with ALL text as
  HTML sharing the same coordinates (responsive, no measurement code). One 2px line per array
  (tokens only: accent = HaynesTower, progress = Music), the target as a **dashed** labeled floor
  (dashes reserved for thresholds; gridlines are solid hairlines), a FITTED byte axis on round
  ticks bracketing data + target (lines encode by position — a zero axis on a ~500 TB array
  crushes a 10 TB drain flat; the non-zero baseline is explicitly labeled for honesty),
  sparse UTC date ticks, gap-aware paths (an exporter outage reads as a hole), a "history
  begins …" note when retention undercuts the window, direct end-labels + a current-values legend
  (hover-free, mobile-first), and a 7d/30d/90d/1y seg. ADR-015: every state (chart / loading /
  degraded / no-history) shares one fixed-height region; window switches dim + swap in place.
- **Placement:** replaces the Grafana deep-link card on the Storage tab; the old dashboard URL
  survives as the muted footnote (Grafana stays the LAN power tool — OPS-007 unchanged).

### D-08 — Capacity Forecast (2026-11-13)

When each array's free space will reach its target floor, and when it will reach zero, from the
same exportarr free-space history D-07 already reads. The chart that draws this is a later story;
this decision is the function and the read. **ADR-030 is unchanged.** The history stays the
exportarr series in Prometheus (no second store, option 2 of ADR-030 stays rejected). The forecast
consumes free bytes plus the existing free-byte floor (`targetFreeBytes`). It does not add a
percent trend (C-06).

**Where the function lives.** `forecastFreeSpace` in `packages/domain/src/storage-forecast.ts`,
exported from `@hnet/domain`. `@hnet/api` already depends on `@hnet/domain`, and story 820 calls
the same function from `packages/domain/src/space-policy.ts`. A home in `@hnet/api` would cycle
when that call lands. `@hnet/metrics` is the Prometheus client; this function does no I/O. It
takes the samples, the free-byte target floor (`null` when the array has no target), and the
current time as unix seconds. It does not read a clock.

**The read.** `storage.forecast` (adminProcedure, `packages/api/src/storage-forecast.ts`) runs the
D-07 PromQL once over **90 days at a 3-day step**, maps series with `mapTrendSeries` (the same
arrays, dedupe, and target floor as `storage.trend`), and calls `forecastFreeSpace` per array.
Prometheus down ⇒ `{ unavailable: true, series: [] }`, never a throw. The chart's own window
(7d/30d/90d/1y) does not change this fit.

**Chosen method.** Ordinary least squares of free bytes on time. The rate is free bytes per day
(negative while the array is filling). The level the dates start from is the latest sample. When
that sample lies more than **4 residual standard deviations** off the line fitted to the samples
**at least 6 days earlier**, the rate is that earlier line and the level is still the latest
sample (a step hold). Fewer than **8** points, or a span under **21 days**, is too short. A slope
within **2** standard errors of zero is flat. Too short and flat are no forecast.

While free space is falling: a date for zero, and a date for the target floor when the latest
sample is still above that floor. While free space is rising and the latest sample is below the
floor: a date for the floor, and no date for zero. No target ⇒ the zero date only. A floor that
is not ahead of the slope, and a crossing at or before `now`, are omitted. A sample after `now`
is dropped before the fit.

**Why these cuts.** The numbers below were computed 2026-11-13 from the series the coordinator
recorded the same day (Prometheus, 90 days, 3-day step, GB = 1e9 bytes). Ordinary least squares,
float64. They are not a fresh Prometheus query. Slopes are GB/day. Every 100% date is anchored at
the 2026-11-12 sample (HaynesTower 88140.8 GB, music 110378.8 GB) and is the UTC day free space
would reach 0.

HaynesTower:

| Window | Last six days in the slope | Slope | 100% date |
| ------ | -------------------------- | ----: | --------- |
| 90d | included | −186.51 | 2028-02-27 |
| 90d | excluded (the step hold) | −212.17 | 2028-01-01 |
| 60d | included | −161.84 | 2028-05-09 |
| 60d | excluded | −217.19 | 2027-12-22 |
| 30d | included, least squares | −60.48 (0.63 se) | the flat rule would refuse it (a raw extension lands on 2030-11-08) |
| 30d | included, first and last sample only | +114.33 | no 100% date |
| 30d | excluded | −275.66 | 2027-09-27 |
| 90d | Theil-Sen, last six days included | −207.67 | 2028-01-10 |

The 30-day window cannot carry the step. Least squares over those 30 days is 0.63 standard
errors from zero. The first-to-last slope is +114.33 GB/day, so there is no 100% date; against a
scenario floor of 100000 GB (above the latest sample, so the array counts as over target) that
positive slope would date the floor at 2027-02-23. That is the wrong reading of a series that
fell for 84 days and then rose. The 100000 GB floor is a scenario input for that comparison. It
is not a measured live target.

The 90-day and 60-day rates agree once the last six days are out of the slope (−212.17 and
−217.19). The 90-day window is the whole recorded history. On the prefix through 2026-11-06, the
first 14 samples (2026-08-14 through 2026-09-22) slope at −228.57 GB/day and the next 15
(2026-09-25 through 2026-11-06) slope at −228.28 GB/day. One line through all 29 is −212.17
GB/day, residual σ = 571.14 GB. A 24-day slice at the end of that prefix is −275.66 GB/day. The
long line is the historical rate; the short slice is a faster patch.

The step hold is how the last six days are treated. The 2026-11-12 HaynesTower sample is 10753.8 GB
above the 29-point line, **18.83σ**. The largest in-sample standardized residual of that prefix
is **1.86**. Four standard deviations sits between those two. Including the six days moves the
90-day slope from −212.17 to −186.51 and the date from 2028-01-01 to 2028-02-27. The level stays
the latest sample: the prefix line at 2026-11-12 is 77387.0 GB, and the measured free space is
88140.8 GB. Dates start from the measured level.

Theil-Sen on the full HaynesTower series lands on 2028-01-10, close to the hold. On the music
array the same estimator dates 100% at 2035-10-18, against a least-squares date of 2029-12-23.
The music level shift on 2026-10-31 is still a minority of the pairwise slopes, so Theil-Sen
treats twelve days of a new level as if it were not the rate. The hold is only for a break in
the last six days. Least squares, not the first-to-last slope: that slope on the full 90 days is
−100.33 GB/day and dates 100% at 2029-04-08, because it has only the stepped last sample to go
on, and it has no residual with which to see the step.

Music, same anchor rule. The 2026-11-12 sample is **2.21σ** from the line through 2026-11-06
(prefix in-sample maximum 3.03σ), so the hold does not apply and the slope is the full 31-point
fit.

| Window | Last six days in the slope | Slope | 100% date |
| ------ | -------------------------- | ----: | --------- |
| 90d | included (chosen) | −97.00 | 2029-12-23 |
| 90d | excluded | −72.11 | 2031-01-20 |
| 30d | included | −459.58 | 2027-07-10 |
| 90d | Theil-Sen, included | −33.84 | 2035-10-18 |

The flat cut is 2 standard errors. The HaynesTower prefix slope is 50.2 se; the music full-window
slope is 5.13 se; the 30-day HaynesTower window with the step included is 0.63 se. The too-short
floor is the shortest slice measured on the HaynesTower prefix that still has 8 samples: 21 days
(slope −271.56 GB/day, 16.8 se). The 15-day slice of that prefix has 6 samples. Twenty-one days is
the refusal floor. The fit window stays 90 days.

**Hand calculation the tests lock** (GB = 1e9 bytes).

HaynesTower prefix, x = 0, 3, …, 84 days from 2026-08-14, n = 29. Mean x = 42. Sxx = 18270
(x = 3k for k = 0..28, Σ(k−14)² = 2030, times 9). The free-space values in tenths of a GB sum to
25395652, so mean y = 87571.2137931035 GB. Sxy = −3876367.5 GB·day. Slope = −3876367.5 / 18270
= −172283/812 = **−212.17118226600985 GB/day**. The 2026-11-12 residual is +10753.802956 GB =
18.83σ. Days from 88140.8 GB to 0 = 88140.8 / 212.17118226600985 = 415.423051606949 days =
35892551.65884 s after 2026-11-12T00:00:00Z, which rounds to **2028-01-01T10:09:12Z**.

Music, full window, x = 0, 3, …, 90, n = 31. Mean x = 45. Sxx = 22320. Sxy = −2164976.1 GB·day.
Slope = −2164976.1 / 22320 = −2405529/24800 = **−96.9971370967742 GB/day**. Days from 110378.8 GB
to 0 = 1137.95935945898 = 98319688.657 s after 2026-11-12T00:00:00Z, which rounds to
**2029-12-23T23:01:29Z**.

**Output, per array.** `direction` (`filling` when the rate is negative, `draining` when it is
positive), `rateBytesPerDay`, `fullAt` and `targetAt` as unix seconds, and `forecast: false` with
`reason: 'too_short' | 'flat'` when there is no forecast. A draining array that is already above
its floor has a rate and no date. That is a forecast of the rate. No forecast is only too short
or flat.

### D-06 — Expedite forward-capture (reclaim data quality)

The direct-Expedite path (`expediteOneSurvivor`) now freezes `{sizeBytes, resolution, imdbRating,
tmdbRating}` — carried from the same pending row the guardian evaluated — into BOTH the `trash_expedited`
ledger payload AND the deletion-audit notification payload (the batch sweep already froze these on
`trash_batch_items`; it now mirrors them into the notification too). No new table/migration. This makes
future direct-expedites reclaim-attributable; the 2 pre-capture historical expedites stay excluded.

## Test strategy

Hermetic (embedded PG16 + fetch-stubbed *arr): utilization merge (targets + partial-failure + dedupe),
reclaim SQL over seeded snapshots (category/resolution/cumulative math exact + window filter + expedite
union), the expedite-freeze regression (proves the frozen payloads), the zod diskspace subset, and
router admin-gating. e2e: a `/diskspace` stub route (both arrays) + a `space_targets` seed so the UX
agent has live utilization + a target line (reclaim starts empty, production-faithful).
`storage.spec.ts` covers the page: both arrays' % + tick against the stub numbers, the targets
editor round-trip (optimistic + persisted + reflow-free), the reclaim empty state + window
switcher, and a 390×844 viewport-fit spot check. Pure helpers
(`apps/web/lib/storage.ts`: capacity/tone/share/step-geometry) are unit-tested.

**D-07 additions:** hermetic (`packages/api/__tests__/storage-trend.test.ts`) — the client's
query_range URL/zod contract + failure throws, the window→step budget, the paths→arrays mapping
(dedupe, fallback, max-merge, rootfolder-under-mount), the target free-bytes math, and the
`unavailable` degrade at both the domain and router layer (member FORBIDDEN too). Chart geometry
(`apps/web/lib/__tests__/storage-trend.test.ts`) — round byte ticks, honest UTC time ticks,
gap-breaking, end-label collision nudge, `history begins`. e2e — a stub Prometheus
(`e2e/support/stub-prometheus.ts`, scriptable `/_stub/state` ok⇄down) joins the default stack env:
the chart renders both lines + the dashed 106 TB target + the values legend, the window seg
redrives `storage.trend` reflow-free, Prometheus-down shows the degrade note while the meters keep
working, and the Grafana footnote stays a link (never an iframe).

**D-08 additions:** the pure function (`packages/domain/__tests__/storage-forecast.test.ts`) — use
rising under and over the target, use falling over and under the target, no target, flat, too
short, a last-six-days step, a sample after `now`, and a crossing already past `now`. The recorded
2026-11-13 series is a fixture whose HaynesTower and music dates equal the hand calculation above.
The router read (`packages/api/__tests__/storage-trend.test.ts`) — admin gate, the 90-day / 3-day
query, the same array grouping and target floor, and `unavailable` when Prometheus is down
(including when every *arr read fails too). No e2e change: the chart is a later story.

## Open questions

- **Q-01 (resolved, ADR-030):** HYBRID — native reclaim + deep-linked Grafana trend.
- **Q-02:** whether to split `haynesops`/`hayneskube` (CephFS-backed in-cluster Plex) into their own
  utilization rows later, or keep music as one `cephfs` array. Deferred — no owner ask yet.
- **Q-03 (open):** the music array's free space fell 6859.5 GB between the 2026-10-28 and
  2026-10-31 samples of the recorded series, twelve days before the last sample. The 6-day step
  hold leaves that drop inside the 90-day slope. Recommendation: leave it there. The hold was set
  from the last six days, which are the samples that reverse HaynesTower. A longer hold would
  also drop the music samples after 2026-10-31, and this story does not establish the cause.
- **Q-04 (open):** the fit was measured on a 3-day step, and the read uses that step. The chart's
  12-hour samples were not compared. Recommendation: keep the 3-day step. An estimate of the
  effect of a finer step, residual σ divided by the HaynesTower prefix slope, is 571.14 / 212.17
  ≈ 2.7 days on that date. That is residual/slope, not a second measurement.
