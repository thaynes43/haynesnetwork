# DESIGN-013: Disk-utilization + reclaim-metrics vertical

- **Status:** Draft
- **Last updated:** 2026-07-09 (D-07 native free-space trend — ADR-030 C-04 amendment)
- **Satisfies:** PRD-001 **R-108..R-111**; governed by **ADR-030** (HYBRID surface). Consumes ADR-025 /
  DESIGN-011 deletion snapshots, ADR-018 `media_metadata.resolution`, ADR-023 attribution. Grafana
  side recorded in **OPS-007**; glossary **T-95..T-97**.

## Overview

The **backend vertical** for the space story (PLAN-013): a native, admin-gated **Storage** tRPC
surface with two reads — **utilization** (current disk % per media array, from the *arr `GET
/diskspace` API) and **reclaim** attribution (from Postgres deletion snapshots) — plus **space-target**
get/set. The fill/drain **time-series** shipped first as a Grafana deep-link (ADR-030 C-04) and is
now **native** — `storage.trend` off in-cluster Prometheus (**D-07**, ADR-030 C-04 amendment
2026-07-09; the LAN-only deep-link demoted to a footnote). The native Storage page shipped as
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

## Open questions

- **Q-01 (resolved, ADR-030):** HYBRID — native reclaim + deep-linked Grafana trend.
- **Q-02:** whether to split `haynesops`/`hayneskube` (CephFS-backed in-cluster Plex) into their own
  utilization rows later, or keep music as one `cephfs` array. Deferred — no owner ask yet.
