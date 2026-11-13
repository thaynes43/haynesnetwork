# DESIGN-013: Disk-utilization + reclaim-metrics vertical

- **Status:** Draft
- **Last updated:** 2026-11-13 (D-08 capacity forecast; its method corrected the same day; D-09 its plot)
- **Satisfies:** PRD-001 **R-108..R-111**; governed by **ADR-030** (HYBRID surface). Consumes ADR-025 /
  DESIGN-011 deletion snapshots, ADR-018 `media_metadata.resolution`, ADR-023 attribution. Grafana
  side recorded in **OPS-007**; glossary **T-95..T-97**, **T-332**, **T-337**.

## Overview

The **backend vertical** for the space story (PLAN-013): a native, admin-gated **Storage** tRPC
surface with two reads — **utilization** (current disk % per media array, from the *arr `GET
/diskspace` API) and **reclaim** attribution (from Postgres deletion snapshots) — plus **space-target**
get/set. The fill/drain **time-series** shipped first as a Grafana deep-link (ADR-030 C-04) and is
now **native** — `storage.trend` off in-cluster Prometheus (**D-07**, ADR-030 C-04 amendment
2026-07-09; the LAN-only deep-link demoted to a footnote). **D-08** (2026-11-13) adds the Capacity
Forecast on that same series: when each array's free space reaches its target floor and when it
reaches zero; **D-09** (2026-11-13) is its plot on the Storage tab. The native Storage page shipped as
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

### D-08 — Capacity Forecast (2026-11-13; method corrected the same day)

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
takes the samples, the free-byte target floor (`null` when the array has no target), the current
time as unix seconds and, optionally, a newer reading of the level. It does not read a clock.

**The read.** `storage.forecast` (adminProcedure, `packages/api/src/storage-forecast.ts`) runs the
D-07 PromQL once over **90 days at a 3-day step**, maps series with `mapTrendSeries` (the same
arrays, dedupe, and target floor as `storage.trend`), and calls `forecastFreeSpace` per array.
Prometheus down ⇒ `{ unavailable: true, series: [] }`, never a throw. The chart's own window
(7d/30d/90d/1y) does not change this window. Two readings feed each forecast:

- **The rate** comes from the history, on the step-aligned grid (close refetches share samples).
- **The level** the dates start from is the live `/diskspace` free space that the same call
  already reads for the totals, stamped `now`. The grid's last sample can be a whole step old: at
  the coordinator's read on 2026-11-13T16:36Z it was 2026-11-12T00:00Z, 40.6 hours back, and by
  2026-11-13T12:00Z HaynesTower had fallen 537.5 GB and the music array 4185.0 GB from it
  (measured, 12-hour series below). When the *arr cannot be read, the level is the last sample.

**Method.**

1. A **step** is the change in free bytes per day between two consecutive samples.
2. The **rate** is the **interquartile mean** of the steps: sort them, set aside a quarter
   (rounded down) at each end, and average the rest. The read's 31 samples give 30 steps: 7 are
   set aside at each end and the middle 16 are averaged. A level jump is one or a few steps far
   from the others, so it falls in a set-aside quarter wherever it sits in the window, up or down.
3. The **level** is the newer reading when the caller gives one, else the last sample. The level
   never enters the rate. A jump therefore moves both dates at once, through the level, and
   leaves the rate alone.
4. While free space is falling: a date for zero, and a date for the target floor when the level
   is still above that floor. While free space is rising and the level is below the floor: a date
   for the floor, and no date for zero. No target ⇒ the zero date only. A floor that is not
   ahead of the rate, and a crossing at or before `now`, are omitted. A sample after `now` is
   dropped.
5. **No forecast** is one of two things. *Too short*: fewer than **13** samples, or a span under
   **36 days**. *Flat*: the rate is within **2 standard errors** of zero. The standard error is
   Tukey and McLaughlin's for a trimmed mean: replace each set-aside step by the nearest kept one,
   take that list's sum of squares about its mean, divide by `h (h − 1)` where `h` is the number
   of kept steps, and take the square root.

**The defect this replaces.** The first method on this branch fitted a least-squares line over
the 90 days and, when the newest sample lay more than 4 standard deviations off the line through
the samples at least 6 days older, kept that older line's rate. That holds a jump only while the
jump is the newest sample. The coordinator continued the recorded HaynesTower series from its
2026-11-12 level at its own pre-jump rate (−212.17 GB/day, so the true rate and the true 100% day,
2028-01-01, never change) and read it 90 days back at each later sample. Rates are GB/day
(GB = 1e9 bytes); the day is when free space reaches 0.

| Days after 2026-11-12 | First method | its 100% day | This method | its 100% day |
| --------------------: | -----------: | ------------ | ----------: | ------------ |
| 0 | −212.2 | 2028-01-01 | −212.2 | 2028-01-01 |
| 3 | −205.6 | 2028-01-14 | −211.3 | 2028-01-03 |
| 6 | −179.5 | 2028-03-15 | −204.7 | 2028-01-16 |
| 9 | −127.2 | 2028-09-29 | −208.8 | 2028-01-07 |
| 18 | −85.3 | 2029-08-13 | −201.6 | 2028-01-22 |
| 30 | −54.6 | 2031-01-18 | −204.8 | 2028-01-15 |
| 42 | −42.4 | 2032-02-05 | −217.0 | 2027-12-24 |
| 66 | −80.3 | 2029-07-27 | −212.2 | 2028-01-01 |
| 90 | −212.2 | 2028-01-01 | −212.2 | 2028-01-01 |

Over all 61 samples from day 0 to day 180 the first method is off by up to 170.1 GB/day (80%).
This method is off by up to 19.1 GB/day (9.0%, at day 15: −193.0, 100% on 2028-02-10) and its
earliest day is 2027-12-23 (day 39). What still moves it is which recorded steps remain in the
window, not the rise. From day 51 the continued steps fill the middle 16 and the rate is exact.

**Evidence.** Every number below was computed on 2026-11-13 by
`.agents/context/2026-11-13-834-forecast-candidates.mjs` (no dependency, seeded, prints the same
tables on every run) from two measurements: the 3-day series the coordinator recorded at
2026-11-13T16:36Z, and the same two arrays at a 12-hour step, read by this session the same day
through the Grafana MCP server (queries and range in the script and in the evidence note
`.agents/context/2026-11-13-834-storage-forecast.md`). Prometheus returned nothing older than
2026-08-07T12:00Z, 98 days back.

Candidates. A: least squares over 90 days. B: the first method. C: Theil-Sen on the levels.
D: the median step. E: the mean of the steps after setting aside 10%, 20%, 25% or 33% at each
end. F: the mean of the steps that lie within 3 scaled median deviations of the median step (a
step's distance from the median step, divided by 1.4826 times the median such distance).
G: least squares after removing those flagged steps from the levels.

| Candidate | HaynesTower, as of 2026-11-12 | Music, as of 2026-11-12 | Worst error on the continued series |
| --------- | ----------------------------- | ----------------------- | ----------------------------------: |
| A | −186.5 → 2028-02-27 | −97.0 → 2029-12-23 | 170.1 (80.2%) |
| B (first method) | −212.2 → 2028-01-01 | −97.0 → 2029-12-23 | 170.1 (80.2%) |
| C | −207.7 → 2028-01-10 | −33.8 → 2035-10-18 | 138.1 (65.1%) |
| D | −214.7 → 2027-12-27 | −29.0 → 2037-04-07 | 2.5 (1.2%) |
| E 10% | −198.4 → 2028-01-30 | −41.3 → 2034-03-05 | 29.4 (13.9%) |
| E 20% | −210.2 → 2028-01-05 | −40.4 → 2034-05-04 | 19.2 (9.1%) |
| **E 25% (chosen)** | **−212.2 → 2028-01-01** | **−39.3 → 2034-07-21** | **19.1 (9.0%)** |
| E 33% | −210.3 → 2028-01-05 | −35.0 → 2035-07-04 | 12.4 (5.9%) |
| F | −224.9 → 2027-12-08 | −41.3 → 2034-03-05 | 17.8 (8.4%) |
| G | −213.7 → 2027-12-29 | −37.9 → 2034-11-01 | 16.8 (7.9%) |

The continued series has no noise after 2026-11-12, which flatters D: its exact steps sit at the
middle of the order, where the median reads them alone. So the candidates were also compared
under the measured noise. The 12-hour HaynesTower series before its two large rises
(2026-08-07T12:00Z to 2026-10-30T12:00Z, 12 whole weeks) was resampled in weekly blocks: each of
4000 replicates draws 13 of those weeks, is read at the 3-day step, and has a known true rate,
−252.1 GB/day. The table is the root-mean-square error against that rate, GB/day. These are
estimates from resampling, not measurements of the future.

| Candidate | No jump | The recorded rise (+1861.3, +8002.5 GB), placed anywhere | The recorded music fall (−6859.5, −3843.8, −1183.4 GB), placed anywhere | Both |
| --------- | ------: | ------: | ------: | ------: |
| Plain mean, (last − first) / days | 41.1 | 116.5 | 137.3 | 45.3 |
| A | 44.8 | 126.8 | 153.7 | 80.9 |
| B (first method) | 45.0 | 126.2 | 153.2 | 84.9 |
| C | 45.1 | 98.4 | 122.3 | 64.7 |
| D | 48.6 | 54.2 | 52.3 | 50.3 |
| E 10% | 39.7 | 51.0 | 53.0 | 42.6 |
| E 20% | 38.1 | 48.1 | 44.2 | 39.4 |
| **E 25% (chosen)** | **38.4** | **47.3** | **43.1** | **38.9** |
| E 33% | 42.1 | 48.3 | 44.8 | 41.9 |
| F | 42.2 | 46.3 | 44.8 | 45.0 |
| G | 44.2 | 48.5 | 47.5 | 47.4 |

Even with no jump, 90 days of this history give the rate to about 40 GB/day: the fill is not
steady. That is the floor every candidate sits on. A, B and C are two to four times worse once a
jump is in the window. D holds jumps and is the noisiest of the rest. E at 20% or 25%, F and G
cannot be told apart by this table.

Following a real change of rate: the percent of the change the rate reports after `m` of the 30
steps are at the new rate.

| Case | m = 4 | 7 | 8 | 10 | 15 | 20 | 23 | 30 |
| ---- | ----: | -: | -: | -: | -: | -: | -: | -: |
| No noise, new rate far outside the old steps: plain mean | 13 | 23 | 27 | 33 | 50 | 67 | 77 | 100 |
| — D, and F | 0 | 0 | 0 | 0 | 50 | 100 | 100 | 100 |
| — E 20% | 0 | 6 | 11 | 22 | 50 | 78 | 94 | 100 |
| — **E 25% (chosen)** | **0** | **0** | **6** | **19** | **50** | **81** | **100** | **100** |
| — E 33% | 0 | 0 | 0 | 0 | 50 | 100 | 100 | 100 |
| Measured noise, the fill doubles (−252 GB/day more): chosen | 11 | 21 | 24 | 31 | 50 | 68 | 78 | 100 |
| Measured noise, the fill stops (+252 GB/day): chosen | 11 | 21 | 25 | 32 | 51 | 68 | 79 | 100 |
| Measured noise, +1000 GB/day: chosen | 4 | 9 | 14 | 23 | 49 | 75 | 89 | 100 |

**Why the interquartile mean.** It holds its rate through the recorded rise at every age (first
table), it is as quiet as anything measured (third table), and it follows a change of rate
gradually: D and F report nothing of a far change until half the window carries it and then
report all of it within three samples. F and G also need two more numbers, a cut and a scale
taken from the same contaminated steps, and their answer depends on whether a step lands just
inside or just outside the cut. The interquartile mean has one number, the share set aside, and
that number says the same thing in both directions.

**The trade.** Setting aside 7 of 30 steps at each end is what ignores a jump, and it is also
what delays a real change. A new rate that is far outside the old steps is held for 7 samples
(21 days), starts to count on the 8th (24 days), is half reported on the 15th (45 days) and
fully on the 23rd (69 days). A new rate inside the usual spread of the steps, such as the fill
doubling or stopping on HaynesTower, is not set aside: it is followed from the first sample in
proportion to how much of the window carries it, 50% at 45 days, the same as a plain 90-day mean.
In the other direction, up to 7 jump steps one way are ignored. The recorded series hold 2
(HaynesTower, up) and 3 down plus 3 up (music), counting steps more than 3 scaled median
deviations from the median step; the largest ordinary step is 1.96 and the smallest of those
eight is 4.42. A quarter is twice the worst measured, plus one. 20% gives the same errors and
6 steps. 33% holds a far change three samples longer; it is closer on the continued series
(5.9%) and noisier under resampling (42.1 against 38.4 GB/day with no jump).

**Where each number comes from.**

- **90-day window.** Prometheus keeps 98 days (measured above). Shorter windows are noisier and
  set aside fewer steps. Root-mean-square error of this method, same resampling, GB/day:

  | Samples (days) | Set aside at each end | No jump | With the rise | With the music fall |
  | -------------- | --------------------: | ------: | ------: | ------: |
  | 8 (21) | 1 | 81.7 | 196.3 | 392.4 |
  | 11 (30) | 2 | 66.4 | 110.2 | 157.9 |
  | 12 (33) | 2 | 63.3 | 101.5 | 145.1 |
  | 13 (36) | 3 | 60.5 | 86.7 | 123.3 |
  | 16 (45) | 3 | 56.1 | 84.3 | 88.5 |
  | 21 (60) | 5 | 46.7 | 62.8 | 63.1 |
  | 31 (90) | 7 | 37.9 | 47.9 | 43.4 |

- **Too short: 13 samples, 36 days.** The widest jump in the recorded series is the music fall,
  3 steps. 13 samples are 12 steps, the fewest that set aside 3 at each end. The first method's
  floor (8 samples, 21 days) sets aside 1 and is off by 196 to 392 GB/day with a recorded jump in
  it. At 13 samples the error with a jump is still 87 to 123 GB/day: a forecast that young is
  rough, and it firms up as the window fills.
- **3-day step.** The step is part of the method. Read at other steps, the measured series to
  2026-11-12 gives HaynesTower −259.8 (12 hours), −265.8 (1 day), **−212.2 (3 days)**, −234.1
  (7 days), and music −44.2, −45.6, **−39.3**, −37.1. Under resampling (true rate −252.1):

  | Step | Steps in 90 days | Mean rate | Error, no jump | Error, one 9863.8 GB rise |
  | ---- | ---------------: | --------: | -------------: | ------------------------: |
  | 12 hours | 180 | −275.6 | 38.8 | 37.6 |
  | 1 day | 90 | −269.7 | 36.2 | 34.6 |
  | **3 days** | **30** | **−241.1** | **37.1** | **40.9** |
  | 7 days | 12 | −231.5 | 46.7 | 54.8 |

  The cause of the spread in the mean is visible at 12 hours: HaynesTower free space rises by 428
  to 1209 GB eleven times, nine of them about a week apart from 2026-08-16 to 2026-10-12. At 12
  hours and 1 day those rises are set aside and the rate is the fill between them, 7% to 9% above
  the true net rate. At 3 days most of them sit inside ordinary steps and the rate comes out 4%
  under it. 7 days is the noisiest. 12 hours, 1 day and 3 days are within the noise of each other
  (1 day is 6.3 GB/day better with a rise in the window, 0.9 with none). The 3-day step stays
  because the recorded series, the defect table and every other number here were measured at it,
  and nothing measured argues for moving. A caller passes samples at this step.
- **Flat at 2 standard errors.** No recorded array is flat, so the cut cannot be measured on
  one. Measured instead: HaynesTower's rate is 5.56 standard errors from zero (38.18 GB/day) and
  the music array's 3.49 (11.25 GB/day). With the HaynesTower noise re-centred on zero, 8.0% of
  30-step replicates are called a trend at 2 standard errors, 3.5% at 2.5 and 2.1% at 3. The cut
  stays at 2, the value the first method used. The formula's standard error agrees with the
  spread of the resampled rate (37.4 against 37.8 GB/day).

**Limits.**

- **The rate is good to about one standard error**, 38 GB/day or 18% on HaynesTower. Carried to
  the date, 88140.8 GB at 212.24 ± 38.18 GB/day is 2027-10-29 to 2028-04-01 around 2028-01-01
  (an estimate: the rate moved one standard error each way). Independent readings of the same
  fill sit inside that band or near it: −224.9 GB/day is the plain mean from 2026-08-14 to
  2026-11-06, and the intake inventory (`.agents/context/2026-11-13-intake-inventory.md`) puts
  the *arr file history's net write at about 22.3 TB in 92 days, about 242 GB/day.
- **Deletion in a few large batches does not turn the direction.** Up to 7 rising steps are set
  aside whatever their size, so they move the level and both dates and leave the rate and
  `filling` as they were. The 8th enters the mean of 16, and from there deletions are partly
  inside the rate. See Q-05.
- **The music array's fall is being held as a jump.** At 12 hours it is not one instant: free
  space fell from 119434.7 GB on 2026-10-25T00:00Z to 106193.8 GB on 2026-11-13T12:00Z, −679.0
  GB/day against −27.5 GB/day over the 72 days before, with a rise of 8044.1 GB at the
  2026-11-11T00:00Z sample.
  Three of its steps are in the recorded window. Five more like them, 15 days, are needed before
  the eighth starts to count. If −679.0 GB/day is the new rate, 106193.8 GB lasts 156 days, to
  about April 2027, not to 2034 (an estimate, by division). See Q-03.
- **The level and the history are two readings of one filesystem**, by the same assumption
  D-07 makes when it draws the `/diskspace` total against this series. This session could not
  read `/diskspace` to compare them. See Q-06.
- **A missing sample** makes one longer step, still a change per day. Many missing samples leave
  too few steps and the answer is too short.

**Hand calculation the tests lock** (GB = 1e9 bytes; a step is one sample minus the one before,
in GB per 3 days).

HaynesTower, the 30 steps of the recorded series, sorted:

- set aside: −1753.0, −1572.3, −1566.5, −1226.3, −1144.3, −1115.0, −1031.7
- middle 16: −1020.9, −1008.6, −953.1, −873.4, −769.2, −734.2, −683.2, −666.5, −621.7, −562.3,
  −516.9, −442.1, −438.6, −346.5, −327.3, −223.2
- set aside: −131.6, +162.4, +187.7, +201.5, +282.9, **+1861.3, +8002.5** (the rise)

The middle 16 sum to −10187.7 GB. Mean −636.73125 GB per 3 days. Rate = −636.73125 / 3 =
**−212.24375 GB/day**. Days from 88140.8 GB to 0 = 88140.8 / 212.24375 = 415.281015342 =
35880279.7256 s after 2026-11-12T00:00:00Z (unix 1794441600), which rounds to unix 1830321880,
**2028-01-01T06:44:40Z**. A floor of 50000 GB: (88140.8 − 50000) / 212.24375 = 179.702818104 days
→ 2027-05-10T16:52:03Z. From the level measured on 2026-11-13T12:00Z, 87603.3 GB: 87603.3 /
212.24375 = 412.748549722 days → 2027-12-31T05:57:55Z.

Music, sorted:

- set aside: **−6859.5, −3843.8, −1183.4** (the fall), −304.8, −282.8, −278.0, −268.0
- middle 16: −257.3, −240.4, −223.7, −182.7, −180.8, −174.5, −94.9, −94.0, −80.3, −77.9, −61.7,
  −53.2, −49.0, −42.8, −40.1, −33.1
- set aside: −28.4, −28.1, +19.8, +81.2, **+958.3, +1219.8, +1651.1** (three rises)

The middle 16 sum to −1886.4 GB. Mean −117.9 GB per 3 days. Rate = **−39.3 GB/day**. Days from
110378.8 GB to 0 = 110378.8 / 39.3 = 2808.62086514 → unix 2037106443, **2034-07-21T14:54:03Z**.

**Output, per array.** `direction` (`filling` when the rate is negative, `draining` when it is
positive), `rateBytesPerDay`, `fullAt` and `targetAt` as unix seconds, `forecast: false` with
`reason: 'too_short' | 'flat'` when there is no forecast, and **`origin`**, the reading
(`{ t, freeBytes }`) the dates are measured from: the chart draws the projection from that point
at that rate. A draining array that is already above its floor has a rate and no date. That is a
forecast of the rate. No forecast is only too short or flat.

**What changed from the first method's interface.** The result's fields and names are kept and
`origin` is added. The input gains the optional `level`. Two exported constants changed value
because the method needs it: `FORECAST_MIN_POINTS` 8 → 13 and `FORECAST_MIN_SPAN_SECONDS` 21 → 36
days. `FORECAST_TRIM_SHARE` (0.25) is new. `FORECAST_STEP_HOLD_SECONDS` and `FORECAST_STEP_SIGMAS`
belonged to the first method and are removed.

### D-09 — The Capacity Forecast plot (2026-11-13, story 819)

A card, **Capacity forecast**, on the Storage tab above **Free-space trend**: one panel per media
array of the D-08 read, each saying and drawing when the array reaches its space target and when
it is full. Component `apps/web/app/(app)/settings/trash/capacity-forecast.tsx`; everything it
says and draws is the pure mapping in `apps/web/lib/storage-forecast.ts`. **ADR-030 is
unchanged**: free bytes and the target as a free-byte floor, never a percent trend (C-06); no
charting library. The method and `forecastFreeSpace` (D-08) are unchanged.

**What the read gained.** The plot needs four things D-08's read did not return, so
`storage.forecast` now also carries:

- `now` — the instant the forecast was made. It is "today" on the plot and the start of every
  "in about …".
- per array `points` — the samples the rate was read from (the 3-day grid, up to 31). They are
  the history the plot draws and what the jump note below is read from.
- per array `jumps` — the Forecast Jumps (T-337) the rate set aside, or null. Rule below.
- `minPoints` and `minSpanSeconds` — the method's two floors (13 samples, 36 days), so the page
  can say what a too-short history lacks without restating the method's numbers.

**The words.** They come first, for a reader who will not read a chart; the plot holds nothing
that is not also in them. Each panel has a chip, two tiles that are present in every state, and
one sentence. `{date}` and `{away}` are the date wording below; `X` is a capacity
(`formatCapacity`, the page's decimal units).

| State of the array | Chip | Tile "Target (N% used)" | Tile "Full (100% used)" | Sentence |
| --- | --- | --- | --- | --- |
| Use rising, under target | Filling | `{date}` / over target `{away}` | `{date}` / `{away}` | Filling by about X a day (X a week). |
| Use rising, over target | Filling | Over now / by X, and rising | `{date}` / `{away}` | as above |
| Use rising, nothing left | Filling | as its side of the target | Now / no free space left | as above |
| Use falling, over target | Freeing up | `{date}` / back under `{away}` | Not ahead / space is freeing up | Freeing up about X a day (X a week). |
| Use falling, under target | Freeing up | Under now / X to spare, and growing | Not ahead / space is freeing up | as above |
| No target (any direction) | by direction | tile "Target": Not set / no space target for this array | by direction | by direction |
| No forecast: flat | Steady | Over now / by X · Under now / X to spare · At target / no room to spare | No date / holding steady | No forecast: free space has not clearly risen or fallen over the last 90 days, so there is no date to predict. |
| No forecast: too few days | No forecast | as flat | No date yet / not enough history | No forecast yet: it needs 36 days of readings and this array has N so far. |
| No forecast: readings missing | No forecast | as flat | No date yet / not enough history | No forecast yet: too many readings are missing from the last 90 days (N of the 13 it needs). |
| No reading at all | No forecast | Unknown / the array could not be read | No date yet / not enough history | No forecast: there are no free-space readings for this array yet. |
| Prometheus down (`unavailable`) | No forecast | No date / forecast unavailable | No date / forecast unavailable | Forecast unavailable: couldn’t reach Prometheus right now. The meters above still show live utilization. |
| The read failed | No forecast | No date / forecast unavailable | No date / forecast unavailable | Failed to load the forecast: `{message}` |
| Loading | … | … / loading | … / loading | Loading forecast… |

A target with no array size to place it (the *arr unreachable) reads "Unknown / the array could
not be read". The 90, 36 and 13 are the read's own values, not copies in the page.

**Date wording.** The read carries no error band (D-08: the function does not return the standard
error), so the page states a date no finer than the forecast supports and steps the precision
down with distance:

- up to 60 days away: the day ("Dec 3", "Jan 12, 2027" once the year changes);
- up to 2 years: the month ("Dec 2027");
- beyond: the year ("2034"); a date over 1,000 years off is "Far off".
- `{away}`: in less than a day; in N days (under 14); in about N weeks (under 63 days); in about
  N months (under 24 months); in about N years, to the half year.

The two cuts are estimates from D-08's measured standard errors of the rate, 18% (HaynesTower)
and 29% (music), each carried to the date by division: one standard error moves a date about half
a month (15 days) when it is 83 days away at 18% and 52 days at 29%, and about half a year (183
days) when it is 1014 days away at 18% and 630 at 29%. 60 days and 2 years (730 days) sit between
each pair. They are not measured limits. A pace is printed to two significant figures ("about
210 GB a day") for the same reason. Dates are UTC, as on the trend's axis.

**The plot.** The trend chart's school (D-07): dependency-free inline SVG, x in percent of the
width and y in pixels of a fixed 160px height, every label HTML at the same numbers, nothing
behind a pointer. It draws:

- **free space so far** — the read's samples and then the level, in the muted ink, gap-aware as on
  the trend;
- **the projection** — one straight line from the level (`origin`) at the rate, to zero while use
  is rising, to the target floor while use is falling below it;
- **the target** — the trend's own dashed rule and "Target · X free" label (dashes still mean a
  threshold and nothing else);
- **marks** — a dot where the projection meets the target floor and one where it meets zero, with
  the date under each mark in the axis band; today's level is a dot in text ink;
- **the byte axis from zero**, because zero is the level the forecast is about; the baseline is
  labelled "0 · full". (The trend's axis is fitted, because its job is the shape of the history.)
  The axis has a gutter of its own, 46px: with a horizon of years today sits at the plot's left
  edge, where ticks laid over the plot would cover it.

**Horizon.** Decided from the data, not fixed. The plot starts at the oldest sample and ends 6%
of that span after the last date the forecast gives, so the answer is on the chart whether it is
weeks or years away, and the history it stands on is always drawn at its true share of the width
(a nine-year projection from 90 days of history looks as thin as it is). The calendar ticks
change unit with the span: days (1, 2, 7 or 14 apart), months (1, 2, 3 or 6), years (1, 2, 5, 10
and on), the finest that gives at most 4.5 labels. A rate with no date ahead (use falling with
no target to reach) is drawn as far forward as the history looks back, and never past the
array's size. No forecast draws the history alone; under two readings there is no plot and the
place says "Nothing to plot yet."

**Axis labels.** In order of importance: the last forecast date, the other one, "Today" (the
reading's day when the level is not live), then the calendar. A label that would touch one
already placed is not drawn. Whether two touch is decided at the narrowest plot the page draws,
278px (measured 2026-11-13 in the local stack at a 390px viewport: `getBoundingClientRect` of the
plot area), with a label taken as 6.4px a character plus 4px (measured labels were 4.75 to 6.49px
a character) and an 8px gap. What fits there fits at every wider width.

**Colour.** The projection, its marks and the chip's dot wear the direction: `--color-danger`
while use is rising, `--color-accent` while it is falling, the two tones the meter above already
uses for over and under target (the owner's wording: green for a downward trend, red for upward,
"same colors we use on the page now"). Text stays in text tokens. The direction is never colour
alone: the chip says "Filling" or "Freeing up", the tiles say it in words, the line itself runs
down or up, and the card's key names both. Checked 2026-11-13 with the dataviz validator
(`validate_palette.js`, the two tones against each theme's `--color-surface`): colour-vision
separation ΔE 10.1 dark and 17.8 light (target 8), normal-vision 31.3 and 33.9 (floor 15); the
accent's contrast on the light surface is 2.29:1, under 3:1, which is why the words carry every
reading; the accent's lightness is outside the validator's dark band (0.727 against 0.48 to
0.67). Both are properties of the brand token the trend line already uses, kept on the owner's
instruction.

**Forecast Jump (T-337), the display rule.** D-08's method sets aside a jump in the level; the
page says so where one is in the window. `forecastJumps` (`packages/api/src/storage-forecast.ts`,
pure) reads the same samples:

1. A step (D-08) is **far** when it lies more than 3 scaled median deviations from the median
   step (a deviation is the step's distance from the median step; the scale is 1.4826 times the
   median deviation). This is the measure D-08 counted jumps with: on the recorded series the
   largest ordinary step is 1.96 and the smallest jump 4.42.
2. A far step is **named** when free space really moved that way (a rise is above the median and
   positive, a fall below it and negative) and its departure from the median step is at least one
   day of the rate. One day of rate is one day on the dates, the finest the page prints; the test
   also stops a perfectly regular series, whose deviation is zero, from naming its rounding.
3. Far steps are the extreme ones on their side, so the method's trim holds them while there are
   no more of them than it sets aside there (`floor(steps × 0.25)`, 7 of 30). More than that on
   one side is `partlyCounted`: some are inside the rate (D-08, Q-05).
4. `bytes` is the plain change in free space across the named steps, the amount a reader sees on
   the chart. No projection (flat, too short) means nothing to qualify, and `jumps` is null.

On the recorded series this names exactly the eight steps D-08 lists (tested): HaynesTower two
rises, 9863.8 GB; music three falls, 11886.7 GB, and three rises, 3829.2 GB. The note under the
plot reads, for example: "Free space jumped up by 9.9 TB in the last 90 days (2 jumps, the latest
just before Nov 12). The projection treats them as one-offs: they move the starting point, not
the pace. If jumps like these keep coming, the array will have more free space than projected."
A fall reads "dropped suddenly by … (N drops …)" and ends "… less free space than projected."
When partly counted, the middle sentence is "There were more of them than the projection sets
aside, so some now count toward its pace."

**The music array (Q-03), decided for the page.** The page shows the method's forecast for it,
unchanged, and qualifies it. When the named jumps moved free space more than the rate did over
the window (net jump bytes greater than rate × 90 days), the notes open with: "Read this
forecast with care: sudden changes moved free space more than the steady pace did." On the
recorded series that is true of the music array (8057.5 GB net down against 39.3 × 90 = 3537 GB)
and not of HaynesTower (9863.8 GB against 212.24 × 90 = 19102 GB). Why this and not something
else: the method is not this story's to change; a second date "at the recent pace" needs a second
rate, and choosing one is the method (D-08 removed exactly the defect of counting a jump as
trend); hiding the forecast needs a threshold nobody has measured. The comparison used here has
no tunable number: it asks which moved the level more over the window, the jumps or the pace.
Whether the array should show a date at all while its refill runs is the owner's call (Q-07).

**Other limits the page states.** The caption: "When each media array reaches its space target
and when it is full, if free space keeps changing at the pace of the last 90 days. An estimate,
not a schedule." The footnote: "The pace is the usual daily change in free space, with sudden
jumps set aside, carried forward from today’s level. A real change of pace shows up slowly: about
half of it after six weeks, all of it within three months." (D-08's measured trade: 50% of a
change after 15 of 30 steps, 45 days; all of it by the 30th, 90 days.) When the level is not live
(the *arr could not be read, so the dates start from the last sample): "The starting point is the
reading from Nov 12: the live free space could not be read."

**ADR-015.** The card has no control of its own. What a reader can do to it is save a target on
the meter above: the save now also refetches `storage.forecast`, and the panel swaps its words
and marks in place. Every state has the same two tiles, each with one value line and two reserved
lines of detail, and the plot region is 160px in every state (plot, history only, nothing to
plot, loading, unavailable). While the read is away the card keeps one panel per array the page
already knows from `storage.utilization`. The card's key is static text. Measured 2026-11-13 in
the local stack: the four tiles are 88px high at 360, 390 and 1280px viewports, and the page has
no sideways scroll at 360 or 390px (`scrollWidth` equals `innerWidth`).

**Not done here.** The trend chart is untouched: after a target is saved its own dashed line
still refreshes only on reload, as before (Q-09). No error band is drawn (Q-08).

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
rising under and over the target, use falling over and under the target, no target, flat (a level
series, and a noisy one on each side of the 2-standard-error cut), too short (the 13-sample and
36-day floors), a missing sample, a sample after `now`, and a crossing already past `now`. Level
jumps on a noise-free series: one jump up at each of the 30 positions, one jump down at each, a
fall spread over three steps, two jumps in opposite directions, and seven jumps one way set aside
while the eighth reaches the rate. A real change of rate: held for 7 samples, 1/16 of it on the
8th, half on the 15th, all of it on the 23rd; and a fill that turns into a drain. A newer level
reading: the dates start from it, the rate does not move, and an unusable one falls back to the
last sample. The recorded 2026-11-13 series is a fixture whose HaynesTower and music dates equal
the hand calculation above. The same series continued for 180 days at its pre-jump rate is the
defect's reproduction: the rate must stay within one standard error (38.2 GB/day) of −212.17
GB/day at every sample, and thirteen rows are locked to their values (the nine in the table above
and days 15, 39, 51 and 180). The first method fails that test from day 9 to day 84. The router read
(`packages/api/__tests__/storage-trend.test.ts`) — admin gate, the 90-day / 3-day query, the same
array grouping and target floor, the level taken from the live `/diskspace` reading at `now`, the
fall back to the last aligned sample when the *arr cannot be read, and `unavailable` when
Prometheus is down (including when every *arr read fails too). No e2e change: the chart is a later
story.

**D-09 additions:** the mapping from the read to what is said and drawn
(`apps/web/lib/__tests__/storage-forecast.test.ts`) — every row of the D-09 table (use rising
under and over target and with nothing left, use falling over and under target, no target in
both directions, flat on each side of a target, each kind of too short, no reading, Prometheus
down, loading, a failed read), the date and pace wording at each cut, the jump note in its three
forms and the read-with-care comparison on both recorded arrays, a level that is not live, and
the plot: the horizon, the marks, the projection ending on zero or on the floor, a rise capped at
the array's size, the axis units from days to centuries and which labels give way. The jump rule
(`packages/api/__tests__/storage-forecast-jumps.test.ts`, no database) — the recorded series
names exactly D-08's eight steps with their byte totals; a regular series with a one-byte wobble
names nothing; a jump under one day of the rate, and a far step that only slowed the fill, are
not named; eight rises against seven set aside is partly counted; flat and too short give null.
The router read (`packages/api/__tests__/storage-trend.test.ts`) — `now`, the samples, the two
floors, and a jump named beside the forecast it was set aside from. e2e (`storage.spec.ts`) — the
card sits above the trend; HaynesTower's two dates, pace, projection and both marks, and the
music array's "no forecast" with its reason, off the default stub; a saved target moves the
forecast in place while the trend card below does not move; the stub Prometheus's scripted
free-space fixtures (`{ freespace: 'recorded' | 'draining' | 'short' }`, default `'steady'`) for
the named jumps and the read-with-care line, use falling under and over target, and a 21-day
history; Prometheus down keeps the panels; the card fits a 390px phone.

## Open questions

- **Q-01 (resolved, ADR-030):** HYBRID — native reclaim + deep-linked Grafana trend.
- **Q-02:** whether to split `haynesops`/`hayneskube` (CephFS-backed in-cluster Plex) into their own
  utilization rows later, or keep music as one `cephfs` array. Deferred — no owner ask yet.
- **Q-03 (open, restated 2026-11-13):** is the music array's fall since 2026-10-25 a new rate or
  a one-off? Measured at 12 hours it is 13240.9 GB in 19.5 days, −679.0 GB/day against −27.5
  GB/day before, and it had not stopped at the last sample read (2026-11-13T12:00Z). The method
  holds it as a jump and reports −39.3 GB/day; it starts to follow after five more such steps.
  This array is the CephFS pool, which holds more than music, so the cause may be outside the
  libraries. Recommendation: keep the method as it is, because the rule that would follow this
  fall sooner (setting aside fewer steps) is the rule that lets a jump into the rate; find what
  is writing to the pool; and have the chart draw the level, so the fall is visible while the
  rate holds. **For the page (D-09, 2026-11-13):** the plot draws the level and the history, names
  the three falls and three rises it set aside, and opens the array's notes with a
  read-with-care line because those jumps outweigh its pace. Whether the fall is a new rate, and
  what is writing to the pool, stay open; so does whether the page should show this array a date
  at all (Q-07).
- **Q-04 (answered 2026-11-13):** the step. The first method was measured only at 3 days. This
  change measured 12 hours, 1 day, 3 days and 7 days (D-08, "Where each number comes from").
  12 hours, 1 day and 3 days are within the noise of each other and 7 days is worse. The 3-day
  step stays.
- **Q-05 (open, for stories 819 and 820):** what deletions do to the rate. Up to 7 rising steps
  in the window are set aside whatever their size; from the 8th they enter the mean of 16. So
  deletion in a few large batches (7 or fewer in 90 days, one every 13 days or rarer) moves the
  level and both dates and leaves the rate and `filling` as they were: each batch pushes the 100%
  day out and no target date appears. Deletion that touches more steps than that is partly inside
  the rate. The eleven weekly-sized rises measured on HaynesTower are the visible reason its
  3-day rate (−212.2 GB/day) is lower than the fill between them (−259.8 at the 12-hour step).
  For the chart (819): story 834's "when over target and falling" shows only when rising steps
  outweigh falling ones in the middle 16. Recommendation: accept that, and draw the level and the
  line from `origin`, so a batch shows as the level stepping up. **Done in D-09:** the plot draws
  the history and the level, a batch that is set aside is named in the note under the plot, and
  more batches than the method sets aside are said to count toward the pace. For the Trash pace (820): once
  its own batches are frequent, this rate is no longer purely the fill it must offset.
  Recommendation: pass the function a series with its own recorded deletions added back (free
  space minus the cumulative bytes of the deletion snapshots). That makes the rate the fill by
  construction and still sets every other jump aside. Counting a jump as trend is the defect this
  change removes.
- **Q-06 (open):** the level is the *arr's `/diskspace` free space and the history is the
  exportarr root-folder series. D-07 already treats them as one filesystem. This session had no
  way to read `/diskspace` and did not compare them. Recommendation: compare the Storage page's
  meter with the trend chart's last point once. If they differ by more than a day's fill (212 GB
  on HaynesTower), take the level from a Prometheus instant query instead.
- **Q-07 (open, for the owner; D-09):** should an array whose set-aside jumps outweigh its pace
  show a date at all? Today that is the music array: the method reports full in 2034 at
  −39.3 GB/day while free space fell 13240.9 GB in 19.5 days (Q-03). As built, the page shows the
  date with "Read this forecast with care" above the jump note. The alternatives are to show no
  date for such an array ("No forecast: free space is moving in jumps") until the jumps leave the
  window, or to add a second date at the recent pace. Recommendation: keep it as built. Hiding
  the date needs a rule for when to hide it, and a second date needs a second rate; both belong
  with the method (Q-03), not the page.
- **Q-08 (open; D-09):** an error band. The page steps a date's precision down with distance
  because the read does not carry the rate's standard error (D-08). With it, the plot could draw
  the range and the tile could say "Oct 2027 to Apr 2028". Recommendation: a follow-up story adds
  the standard error to `forecastFreeSpace`'s result (the function is outside story 819) and the
  band to the plot.
- **Q-09 (open; D-09):** after a target is saved, the forecast refetches and the trend chart
  does not, so until a reload the trend's dashed line can show the old target under a forecast
  that shows the new one. The trend's behaviour was outside story 819. Recommendation: refetch
  `storage.trend` on the same save, after checking that its legend cannot rewrap (its target entry
  changes length with the value, which is why this change left it alone).
