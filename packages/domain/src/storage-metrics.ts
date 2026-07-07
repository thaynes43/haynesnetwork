// ADR-030 / DESIGN-013 (PLAN-013 disk + reclaim metrics) — the metrics vertical.
//
// TWO reads, two sources of truth (the HYBRID decision, ADR-030):
//   1. getUtilization() — CURRENT disk utilization per physical media array, from the *arr
//      `GET /diskspace` read (the ONLY source carrying a `totalSpace`; C-03). Merged with the
//      per-server space_targets. Resilient: one *arr down ⇒ that array is marked `unavailable`,
//      never a thrown error (the surface degrades, it does not blank).
//   2. getReclaim() — reclaim ATTRIBUTION from Postgres deletion snapshots (`trash_batch_items`
//      deleted_* columns, the durable frozen dataset; C-01). Category × resolution, cumulative-by-day,
//      per-batch rollup (with the green-lighting admin), and a best-effort direct-expedite total from
//      `ledger_events` payloads (forward-captured; the 2 pre-capture historical expedites are excluded).
//
// The Grafana dashboard (exportarr freeSpace trend) is the fill/drain surface and is deep-linked, not
// embedded (C-02/C-04) — it is NOT sourced here. This module is the native-page contract.
import {
  trashBatchItems,
  trashBatches,
  ledgerEvents,
  users,
  PLEX_SERVER_SLUGS,
  type DbClient,
  type PlexServerSlug,
  type TrashMediaKind,
} from '@hnet/db';
import { and, count, desc, eq, gte, sql, sum } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { getAppSetting } from './app-settings';
import type { ArrClientBundle } from './arr-clients';
import type { ArrDiskSpace } from '@hnet/arr';

// ---------------------------------------------------------------------------------------------------
// Utilization (source of record = *arr GET /diskspace)
// ---------------------------------------------------------------------------------------------------

/**
 * DESIGN-013 §4 — the physical media arrays surfaced by the utilization read, and the slug→rootfolder
 * path map that reconciles the owner's per-server mental model with the physical mounts. Movies (Radarr)
 * and TV (Sonarr) SHARE one ~530 TB NFS array at `/data/haynestower`, so both are listed as sources and
 * deduped to one reading (the first reachable *arr wins — resilient to either being down). Music (Lidarr)
 * is a separate ~175 TB CephFS pool at `/data/cephfs-hdd`.
 *
 * `targetSlug` is which `space_targets` key draws this array's reference line. Only `haynestower` maps
 * to a surfaced physical array today; `haynesops`/`hayneskube` remain reserved space_targets slugs (the
 * in-cluster Plex servers on CephFS) whose per-server utilization is not yet split out here — the music
 * array carries no target by default (null).
 */
export interface StorageArrayDescriptor {
  key: string;
  label: string;
  targetSlug: PlexServerSlug | null;
  /**
   * Ordered sources; the first reachable *arr with a matching disk supplies the reading. `paths` is an
   * ordered list of candidate mount paths (first that matches a live diskspace element wins) — the
   * diskspace API reports the MOUNT (`/data/cephfs-hdd`) but the rootfolder label is `/data/media/music`,
   * so the music array lists both to stay correct whichever the live diskspace returns.
   */
  sources: { arr: 'radarr' | 'sonarr' | 'lidarr'; paths: string[] }[];
}

export const STORAGE_ARRAYS: StorageArrayDescriptor[] = [
  {
    key: 'haynestower',
    label: 'HaynesTower',
    targetSlug: 'haynestower',
    sources: [
      { arr: 'radarr', paths: ['/data/haynestower'] },
      { arr: 'sonarr', paths: ['/data/haynestower'] },
    ],
  },
  {
    key: 'cephfs',
    label: 'Music (CephFS)',
    targetSlug: null,
    sources: [{ arr: 'lidarr', paths: ['/data/cephfs-hdd', '/data/media/music'] }],
  },
];

/** One physical array's current utilization (or an `unavailable` placeholder when no source read). */
export interface StorageArrayUtilization {
  key: string;
  label: string;
  /** The matched diskspace mount path, or null when unavailable. */
  path: string | null;
  freeSpace: number | null;
  totalSpace: number | null;
  /** Percent USED, one decimal (`(1 - free/total) * 100`); null when unavailable or total is 0. */
  usedPct: number | null;
  /** The percent-used ceiling from space_targets for this array's server, or null (no target set). */
  target: number | null;
  /** True when NO source *arr could be read for this array (partial result — do not crash, C-03). */
  unavailable: boolean;
}

/**
 * Pick the diskspace element for a wanted mount path: exact match first, else the longest disk whose
 * path CONTAINS the wanted path (the mount the folder lives under), else a disk under the wanted path.
 * The live diskspace API returns the mount root (`/data/haynestower`) so exact match is the common case.
 */
function matchDiskOne(disks: ArrDiskSpace[], wanted: string): ArrDiskSpace | undefined {
  const exact = disks.find((d) => d.path === wanted);
  if (exact) return exact;
  const containing = disks
    .filter((d) => wanted.startsWith(d.path.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.path.length - a.path.length);
  if (containing[0]) return containing[0];
  return disks.find((d) => d.path.startsWith(wanted));
}

/** First candidate path that matches a live disk (candidates are tried in order). */
function matchDisk(disks: ArrDiskSpace[], candidates: string[]): ArrDiskSpace | undefined {
  for (const wanted of candidates) {
    const hit = matchDiskOne(disks, wanted);
    if (hit) return hit;
  }
  return undefined;
}

const roundPct = (used: number): number => Math.round(used * 10) / 10;

/**
 * Current disk utilization per media array — the native page's utilization card. Reads each needed
 * *arr's `/diskspace` ONCE (guarded individually so one outage never throws), merges the space_targets,
 * and dedupes the shared HaynesTower array to a single reading. Returns one row per STORAGE_ARRAYS entry.
 */
export async function getUtilization(input: {
  db?: DbClient;
  arr: ArrClientBundle;
}): Promise<StorageArrayUtilization[]> {
  const targets = await getAppSetting(input.db, 'space_targets');

  // Read each kind's diskspace at most once, failing soft to null (that kind's disks are then unknown).
  const kinds = Array.from(new Set(STORAGE_ARRAYS.flatMap((a) => a.sources.map((s) => s.arr))));
  const diskByKind = new Map<string, ArrDiskSpace[] | null>();
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        diskByKind.set(kind, await input.arr.read[kind].getDiskSpace());
      } catch {
        diskByKind.set(kind, null); // one *arr down ⇒ partial result, not a crash (C-03)
      }
    }),
  );

  return STORAGE_ARRAYS.map((desc) => {
    const target = desc.targetSlug ? (targets[desc.targetSlug] ?? null) : null;
    for (const source of desc.sources) {
      const disks = diskByKind.get(source.arr);
      if (!disks) continue;
      const disk = matchDisk(disks, source.paths);
      if (!disk) continue;
      const usedPct =
        disk.totalSpace > 0 ? roundPct((1 - disk.freeSpace / disk.totalSpace) * 100) : null;
      return {
        key: desc.key,
        label: desc.label,
        path: disk.path,
        freeSpace: disk.freeSpace,
        totalSpace: disk.totalSpace,
        usedPct,
        target,
        unavailable: false,
      };
    }
    return {
      key: desc.key,
      label: desc.label,
      path: null,
      freeSpace: null,
      totalSpace: null,
      usedPct: null,
      target,
      unavailable: true,
    };
  });
}

/** Convenience: the space_targets map plus the full slug set, for the admin targets editor. */
export function knownServerSlugs(): readonly PlexServerSlug[] {
  return PLEX_SERVER_SLUGS;
}

// ---------------------------------------------------------------------------------------------------
// Reclaim attribution (source of record = trash_batch_items deletion snapshots)
// ---------------------------------------------------------------------------------------------------

/** The windows the reclaim report supports (trailing days, or 'all' time). */
export const RECLAIM_WINDOWS = ['30d', '90d', '365d', 'all'] as const;
export type ReclaimWindow = (typeof RECLAIM_WINDOWS)[number];

const WINDOW_DAYS: Record<Exclude<ReclaimWindow, 'all'>, number> = {
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

/** Resolve a window to its inclusive lower-bound instant (null ⇒ all time). */
export function reclaimWindowSince(window: ReclaimWindow, now: Date = new Date()): Date | null {
  if (window === 'all') return null;
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS[window]);
  return since;
}

export interface ReclaimTotals {
  items: number;
  reclaimedBytes: number;
}

/** Reclaimed bytes for one (category, resolution) cell — the "3 × 4K = 90%" bang-for-buck view. */
export interface ReclaimByCategoryResolution {
  mediaKind: TrashMediaKind;
  resolution: string;
  items: number;
  reclaimedBytes: number;
}

/** A point on the cumulative reclaim curve (running total by UTC day). */
export interface ReclaimCumulativePoint {
  day: string; // YYYY-MM-DD (UTC)
  reclaimedBytes: number; // that day's reclaim
  cumulativeReclaimedBytes: number; // running total up to and including this day
}

/** One green-lit batch's reclaim rollup, attributed to the admin who authorized it (greenlit_by). */
export interface ReclaimBatchRollup {
  batchId: string;
  mediaKind: TrashMediaKind;
  greenlitBy: string | null;
  greenlitByName: string | null;
  items: number;
  reclaimedBytes: number;
  lastDeletedAt: string | null; // ISO-8601
}

export interface ReclaimReport {
  window: ReclaimWindow;
  since: string | null; // ISO-8601 lower bound, null for 'all'
  /** Batch-swept reclaim (the clean, frozen dataset — trash_batch_items). */
  totals: ReclaimTotals;
  byCategoryResolution: ReclaimByCategoryResolution[];
  cumulative: ReclaimCumulativePoint[];
  batches: ReclaimBatchRollup[];
  /**
   * Best-effort direct-expedite reclaim from `ledger_events` payloads (forward-captured size, C-01).
   * A SECOND-CLASS source: only expedites deleted AFTER the freeze landed carry size; the 2 pre-capture
   * historical expedites have no frozen size and are excluded (documented). Kept separate from `totals`.
   */
  expedited: ReclaimTotals;
}

const numify = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * The reclaim-attribution report over a window. All breakdowns except `expedited` come from the
 * durable batch-sweep deletion snapshots (`trash_batch_items` where state='deleted'); `expedited` is
 * the best-effort direct-expedite total from ledger payloads. Reads only — never writes.
 */
export async function getReclaim(input: {
  db?: DbClient;
  window: ReclaimWindow;
  now?: Date;
}): Promise<ReclaimReport> {
  const executor = resolveDb(input.db);
  const since = reclaimWindowSince(input.window, input.now);
  const sinceIso = since ? since.toISOString() : null;

  const deletedFilter = since
    ? and(eq(trashBatchItems.state, 'deleted'), gte(trashBatchItems.deletedAt, since))
    : eq(trashBatchItems.state, 'deleted');

  // Totals (batch-swept).
  const [totalsRow] = await executor
    .select({
      items: count(),
      reclaimedBytes: sum(trashBatchItems.deletedSizeBytes),
    })
    .from(trashBatchItems)
    .where(deletedFilter);

  // Category × resolution (join the parent batch for media_kind; null resolution ⇒ 'unknown').
  const catResRows = await executor
    .select({
      mediaKind: trashBatches.mediaKind,
      resolution: sql<string>`coalesce(${trashBatchItems.deletedResolution}, 'unknown')`,
      items: count(),
      reclaimedBytes: sum(trashBatchItems.deletedSizeBytes),
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .where(deletedFilter)
    .groupBy(trashBatches.mediaKind, sql`coalesce(${trashBatchItems.deletedResolution}, 'unknown')`)
    .orderBy(desc(sum(trashBatchItems.deletedSizeBytes)));

  // Per-day reclaim (UTC), accumulated into the cumulative curve in JS.
  const dayExpr = sql<string>`to_char((${trashBatchItems.deletedAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`;
  const perDayRows = await executor
    .select({ day: dayExpr, reclaimedBytes: sum(trashBatchItems.deletedSizeBytes) })
    .from(trashBatchItems)
    .where(deletedFilter)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  // Per-batch rollup, attributed to the green-lighting admin (greenlit_by → users.displayName).
  const batchRows = await executor
    .select({
      batchId: trashBatchItems.batchId,
      mediaKind: trashBatches.mediaKind,
      greenlitBy: trashBatches.greenlitBy,
      greenlitByName: users.displayName,
      items: count(),
      reclaimedBytes: sum(trashBatchItems.deletedSizeBytes),
      lastDeletedAt: sql<string | null>`max(${trashBatchItems.deletedAt})`,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .leftJoin(users, eq(users.id, trashBatches.greenlitBy))
    .where(deletedFilter)
    .groupBy(
      trashBatchItems.batchId,
      trashBatches.mediaKind,
      trashBatches.greenlitBy,
      users.displayName,
    )
    .orderBy(desc(sum(trashBatchItems.deletedSizeBytes)));

  // Best-effort direct-expedite reclaim: trash_expedited ledger events whose payload carries a frozen
  // sizeBytes (forward-capture). Scope 'batch' events are the sweep (already counted in totals) — only
  // the direct 'item'/'all' expedites are folded here. Pre-capture events (no payload sizeBytes) drop out.
  const expediteFilter = and(
    eq(ledgerEvents.eventType, 'trash_expedited'),
    sql`${ledgerEvents.payload}->>'scope' in ('item','all')`,
    sql`(${ledgerEvents.payload}->>'sizeBytes') is not null`,
    since ? gte(ledgerEvents.occurredAt, since) : undefined,
  );
  const [expediteRow] = await executor
    .select({
      items: count(),
      reclaimedBytes: sql<string | null>`sum((${ledgerEvents.payload}->>'sizeBytes')::bigint)`,
    })
    .from(ledgerEvents)
    .where(expediteFilter);

  let running = 0;
  const cumulative: ReclaimCumulativePoint[] = perDayRows.map((r) => {
    const dayBytes = numify(r.reclaimedBytes);
    running += dayBytes;
    return { day: r.day, reclaimedBytes: dayBytes, cumulativeReclaimedBytes: running };
  });

  return {
    window: input.window,
    since: sinceIso,
    totals: {
      items: numify(totalsRow?.items),
      reclaimedBytes: numify(totalsRow?.reclaimedBytes),
    },
    byCategoryResolution: catResRows.map((r) => ({
      mediaKind: r.mediaKind,
      resolution: r.resolution,
      items: numify(r.items),
      reclaimedBytes: numify(r.reclaimedBytes),
    })),
    cumulative,
    batches: batchRows.map((r) => ({
      batchId: r.batchId,
      mediaKind: r.mediaKind,
      greenlitBy: r.greenlitBy,
      greenlitByName: r.greenlitByName,
      items: numify(r.items),
      reclaimedBytes: numify(r.reclaimedBytes),
      lastDeletedAt: r.lastDeletedAt ? new Date(r.lastDeletedAt).toISOString() : null,
    })),
    expedited: {
      items: numify(expediteRow?.items),
      reclaimedBytes: numify(expediteRow?.reclaimedBytes),
    },
  };
}
