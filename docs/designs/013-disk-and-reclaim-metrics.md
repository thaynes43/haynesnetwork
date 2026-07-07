# DESIGN-013: Disk-utilization + reclaim-metrics vertical

- **Status:** Draft
- **Last updated:** 2026-07-07
- **Satisfies:** PRD-001 **R-108..R-111**; governed by **ADR-030** (HYBRID surface). Consumes ADR-025 /
  DESIGN-011 deletion snapshots, ADR-018 `media_metadata.resolution`, ADR-023 attribution. Grafana
  side recorded in **OPS-007**; glossary **T-95..T-97**.

## Overview

The **backend vertical** for the space story (PLAN-013): a native, admin-gated **Storage** tRPC
surface with two reads — **utilization** (current disk % per media array, from the *arr `GET
/diskspace` API) and **reclaim** attribution (from Postgres deletion snapshots) — plus **space-target**
get/set. The fill/drain **time-series** is Grafana, **deep-linked** (ADR-030 C-04), not sourced here.
The native Storage page shipped as **`/admin/storage`** (same branch, Fable UX pass 2026-07-07)
against the D-02/D-03/D-05 wire contracts below.

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
- **Grafana deep-link card** — a link-out (NOT an iframe, ADR-030 C-04) to the fill/drain trend:
  `https://grafana.haynesops.com/d/media-storage-utilization` (uid `media-storage-utilization`, Media
  folder; opens behind the same Authentik SSO). Label it "Free-space trend (Grafana)".

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
switcher, the Grafana deep-link (no iframe), and a 390×844 viewport-fit spot check. Pure helpers
(`apps/web/lib/storage.ts`: capacity/tone/share/step-geometry) are unit-tested.

## Open questions

- **Q-01 (resolved, ADR-030):** HYBRID — native reclaim + deep-linked Grafana trend.
- **Q-02:** whether to split `haynesops`/`hayneskube` (CephFS-backed in-cluster Plex) into their own
  utilization rows later, or keep music as one `cephfs` array. Deferred — no owner ask yet.
