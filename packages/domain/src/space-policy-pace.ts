// ADR-117 / DESIGN-014 D-15 (story 820) — Dynamic Pace. How many bytes a Trash batch asks for,
// from the capacity gap and the intake. It never chooses titles: the existing guards still do.
//
// The switch ships off. While it is off, nothing in this file decides a batch.
//
// Intake is the Capacity Forecast (DESIGN-013 D-08) on a series that has this app's own recorded
// sweep deletions added back, so the rate is intake and not intake minus Trash. A level jump the
// forecast sets aside stays set aside. The live free-space reading is the level for the gap; it
// does not enter the rate.
import { trashBatchItems, trashBatches, trashCandidates, type DbClient, type TrashMediaKind } from '@hnet/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { DynamicPaceConfig } from './app-settings';
import { resolveDb } from './db-client';
import type { DomainLogger } from './domain-logger';
import { STORAGE_ARRAYS } from './storage-metrics';
import {
  FORECAST_STEP_SECONDS,
  FORECAST_WINDOW_SECONDS,
  forecastFreeSpace,
  type FreeSpaceSample,
} from './storage-forecast';
import { bucketFlatPendingForMedia, shapePendingItems, type FlatPending } from './trash-flow';
import { evaluateRegistryGate } from './watchlist-registry';

/**
 * The same PromQL the Storage page's free-space chart uses. One series, so the pace and the chart
 * read one history.
 */
export const FREESPACE_SERIES_QUERY =
  'max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})';

/**
 * Horizon the owner set: back to the target within 60 days, not within one window.
 * This is the owner's bound (story 820), not a statistic of the disk.
 */
export const DYNAMIC_PACE_HORIZON_DAYS = 60;

/**
 * Floor on the byte ask. The smallest proposed-byte total of a completed HaynesTower batch in the
 * 90 days ending 2026-11-13T18:45:08Z, including the 19-item batch (130,604,353,957 bytes, closed
 * 2026-10-19). A higher floor would delete more, so the smaller observed total is the floor.
 */
export const DYNAMIC_PACE_FLOOR_BYTES = 130_604_353_957;

/**
 * Ceiling on the byte ask. The largest proposed-byte total of a completed HaynesTower batch in
 * that same window (3,591,025,375,575 bytes, 50 movies, closed 2026-11-06). The ceiling is one
 * number for the array, not one per kind.
 */
export const DYNAMIC_PACE_CEILING_BYTES = 3_591_025_375_575;

/** One sweep's recorded deletion. `t` is unix seconds. */
export interface RecordedDeletion {
  t: number;
  bytes: number;
}

export type DynamicPaceName = 'catch-up' | 'steady' | 'none';

/** Why a computed explanation is not allowed to size a batch. */
export type DynamicPaceBlock = 'too_short' | 'bad_bounds' | 'no_disk';

export interface KindPool {
  mediaKind: TrashMediaKind;
  poolBytes: number;
}

export interface DynamicPaceKindShare {
  mediaKind: TrashMediaKind;
  poolBytes: number;
  chosenBytes: number;
}

/**
 * The reasoning the status read returns. Byte fields are integers except the rates and the
 * expected deletion, which keep the fraction the yield implies.
 * `chosenBytes` is the array ask after the floor, the ceiling and the pool. It is 0 when
 * `applicable` is false, so a caller that forgets the flag asks for nothing.
 */
export interface DynamicPaceExplanation {
  applicable: boolean;
  inapplicable: DynamicPaceBlock | null;
  overTarget: boolean;
  pace: DynamicPaceName;
  /** Live free bytes the gap is measured from. */
  levelFreeBytes: number;
  targetFreeBytes: number;
  /** Bytes of free space still missing below the target floor. 0 when at or over the floor. */
  gapBytes: number;
  surplusBytes: number;
  /**
   * Change in free bytes per day after deletions are added back. Negative while the library
   * fills. Null when the series is too short. 0 when the forecast calls the rate flat.
   */
  rateBytesPerDay: number | null;
  /**
   * Bytes per day the library is filling. Null when the rate was not measured (too short or
   * flat). 0 when the measured rate is draining.
   */
  intakeBytesPerDay: number | null;
  forecastReason: 'too_short' | 'flat' | null;
  windowDays: number;
  horizonDays: number;
  /** Intake across one save window. 0 when intake was not measured. */
  intakePerWindowBytes: number;
  /** The gap's share of one window. 0 when the array is not over target. */
  gapPerWindowBytes: number;
  /** Bytes that have to be deleted this window. 0 when the pace is not applied. */
  requiredDeletedBytes: number;
  /** Saved bytes / (saved + deleted) over the forecast window. Null when nothing completed. */
  saveRate: number | null;
  /** Share of an asked byte we expect the sweep to actually delete. 1 when the save rate is unusable. */
  yieldRate: number;
  /** The ask before the floor, the ceiling and the pool. 0 when nothing is required. */
  unclampedBytes: number;
  floorBytes: number;
  ceilingBytes: number;
  chosenBytes: number;
  poolBytes: number;
  expectedDeletedBytes: number;
  /** Required deletion this window minus what the chosen ask is expected to delete. */
  shortfallBytes: number;
  /** Chosen ask the eligible pool could not cover. */
  poolShortfallBytes: number;
  kinds: DynamicPaceKindShare[];
}

const KIND_METRIC: Record<'radarr' | 'sonarr' | 'lidarr', string> = {
  radarr: 'radarr_rootfolder_freespace_bytes',
  sonarr: 'sonarr_rootfolder_freespace_bytes',
  lidarr: 'lidarr_rootfolder_freespace_bytes',
};

export interface FreeSpaceMatrixSeries {
  metric: { __name__?: string; path?: string };
  values: ReadonlyArray<readonly [number, string]>;
}

/** Rootfolder-vs-mount prefix match, either direction. Same rule as the Storage chart. */
function pathMatches(seriesPath: string, candidate: string): boolean {
  const c = candidate.replace(/\/+$/, '');
  const s = seriesPath.replace(/\/+$/, '');
  return s === c || s.startsWith(`${c}/`) || c.startsWith(`${s}/`);
}

/** The forecast window the Storage read uses, ending on a step boundary at or before `nowSec`. */
export function forecastQueryRange(nowSec: number): { start: number; end: number; step: number } {
  const end = Math.floor(nowSec / FORECAST_STEP_SECONDS) * FORECAST_STEP_SECONDS;
  const start = end - FORECAST_WINDOW_SECONDS;
  return { start, end, step: FORECAST_STEP_SECONDS };
}

/**
 * One array's free-space samples from the chart's matrix. The first *arr source that has a
 * matching series wins, which is Radarr then Sonarr for HaynesTower.
 */
export function samplesForStorageArray(
  matrix: readonly FreeSpaceMatrixSeries[],
  arrayKey: string,
): FreeSpaceSample[] {
  const desc = STORAGE_ARRAYS.find((a) => a.key === arrayKey);
  if (!desc) return [];
  for (const source of desc.sources) {
    const matched = matrix.filter(
      (s) =>
        s.metric.__name__ === KIND_METRIC[source.arr] &&
        typeof s.metric.path === 'string' &&
        source.paths.some((p) => pathMatches(s.metric.path!, p)),
    );
    if (matched.length === 0) continue;
    const byT = new Map<number, number>();
    for (const series of matched) {
      for (const [t, raw] of series.values) {
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        const prev = byT.get(t);
        if (prev === undefined || v > prev) byT.set(t, v);
      }
    }
    return Array.from(byT.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, freeBytes]) => ({ t, freeBytes }));
  }
  return [];
}

/**
 * Read one array's forecast samples. A failure or an empty matrix is null, which the policy
 * treats as "do not size" (today's caps).
 */
export async function readArrayFreeSpaceSamples(
  reader: {
    queryRange(
      query: string,
      startSec: number,
      endSec: number,
      stepSec: number,
    ): Promise<FreeSpaceMatrixSeries[]>;
  },
  arrayKey: string,
  nowSec: number,
): Promise<FreeSpaceSample[] | null> {
  try {
    const range = forecastQueryRange(nowSec);
    const matrix = await reader.queryRange(FREESPACE_SERIES_QUERY, range.start, range.end, range.step);
    const samples = samplesForStorageArray(matrix, arrayKey);
    return samples.length > 0 ? samples : null;
  } catch {
    return null;
  }
}

/**
 * Subtract recorded sweep bytes from every sample at or after the deletion, so a later free-space
 * reading is what it would have been had Trash not deleted. The live level is not a sample and
 * is not adjusted here.
 */
export function addRecordedDeletions(
  samples: readonly FreeSpaceSample[],
  deletions: readonly RecordedDeletion[],
): FreeSpaceSample[] {
  const events = deletions
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.bytes) && d.bytes > 0)
    .slice()
    .sort((a, b) => a.t - b.t);
  return samples.map((sample) => {
    let removed = 0;
    for (const event of events) {
      if (event.t > sample.t) break;
      removed += event.bytes;
    }
    return { t: sample.t, freeBytes: sample.freeBytes - removed };
  });
}

function finiteInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Fill a missing Dynamic Pace object with the measured defaults, switch off. A stored bound that
 * is not a safe integer is replaced by that default; the switch is on only when stored `enabled`
 * is exactly true. `ceiling < floor` is left for the explainer, which then refuses to size.
 */
export function resolveDynamicPace(raw: unknown): DynamicPaceConfig {
  const absent = raw === null || typeof raw !== 'object';
  const stored = (absent ? {} : raw) as Partial<DynamicPaceConfig>;
  return {
    enabled: stored.enabled === true,
    horizonDays: finiteInt(stored.horizonDays, 1, 3660) ?? DYNAMIC_PACE_HORIZON_DAYS,
    floorBytes:
      finiteInt(stored.floorBytes, 0, Number.MAX_SAFE_INTEGER) ?? DYNAMIC_PACE_FLOOR_BYTES,
    ceilingBytes:
      finiteInt(stored.ceilingBytes, 1, Number.MAX_SAFE_INTEGER) ?? DYNAMIC_PACE_CEILING_BYTES,
  };
}

/** The proposal filter, shared so the status snapshot and the live proposal count the same titles. */
export function isPaceDeletable<
  T extends {
    maintainerrMediaId: string | null;
    saveIntent: boolean;
    protectedByTag: boolean;
    onWatchlist: boolean;
    ageGuard: string;
  },
>(item: T): item is T & { maintainerrMediaId: string } {
  return (
    item.maintainerrMediaId !== null &&
    !item.saveIntent &&
    !item.protectedByTag &&
    !item.onWatchlist &&
    item.ageGuard !== 'recent'
  );
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Split `ask` across kinds in proportion to their eligible bytes. The largest pool takes the
 * remainder, and no kind is asked for more than it has. Kinds are returned in the caller's order.
 */
export function splitPaceAsk(ask: number, pools: readonly KindPool[]): DynamicPaceKindShare[] {
  const clean = pools.map((pool) => ({
    mediaKind: pool.mediaKind,
    poolBytes: nonNegative(pool.poolBytes),
  }));
  const chosen = new Map<TrashMediaKind, number>();
  for (const pool of clean) chosen.set(pool.mediaKind, 0);
  const total = clean.reduce((sum, pool) => sum + pool.poolBytes, 0);
  const capped = Math.min(nonNegative(ask), total);
  if (capped > 0 && total > 0) {
    const order = clean.slice().sort((a, b) => b.poolBytes - a.poolBytes || (a.mediaKind < b.mediaKind ? -1 : 1));
    let given = 0;
    for (const pool of order) {
      const share = Math.min(pool.poolBytes, Math.floor((capped * pool.poolBytes) / total));
      chosen.set(pool.mediaKind, share);
      given += share;
    }
    let leftover = capped - given;
    for (const pool of order) {
      if (leftover <= 0) break;
      const room = pool.poolBytes - (chosen.get(pool.mediaKind) ?? 0);
      const add = Math.min(room, leftover);
      chosen.set(pool.mediaKind, (chosen.get(pool.mediaKind) ?? 0) + add);
      leftover -= add;
    }
  }
  return clean.map((pool) => ({
    mediaKind: pool.mediaKind,
    poolBytes: pool.poolBytes,
    chosenBytes: chosen.get(pool.mediaKind) ?? 0,
  }));
}

function idle(input: {
  block: DynamicPaceBlock;
  overTarget: boolean;
  levelFreeBytes: number;
  targetFreeBytes: number;
  gapBytes: number;
  surplusBytes: number;
  forecastReason: 'too_short' | 'flat' | null;
  windowDays: number;
  horizonDays: number;
  floorBytes: number;
  ceilingBytes: number;
  saveRate: number | null;
  pools: readonly KindPool[];
}): DynamicPaceExplanation {
  const kinds = splitPaceAsk(0, input.pools);
  return {
    applicable: false,
    inapplicable: input.block,
    overTarget: input.overTarget,
    pace: 'none',
    levelFreeBytes: input.levelFreeBytes,
    targetFreeBytes: input.targetFreeBytes,
    gapBytes: input.gapBytes,
    surplusBytes: input.surplusBytes,
    rateBytesPerDay: null,
    intakeBytesPerDay: null,
    forecastReason: input.forecastReason,
    windowDays: input.windowDays,
    horizonDays: input.horizonDays,
    intakePerWindowBytes: 0,
    gapPerWindowBytes: 0,
    requiredDeletedBytes: 0,
    saveRate: input.saveRate,
    yieldRate: 1,
    unclampedBytes: 0,
    floorBytes: input.floorBytes,
    ceilingBytes: input.ceilingBytes,
    chosenBytes: 0,
    poolBytes: kinds.reduce((sum, kind) => sum + kind.poolBytes, 0),
    expectedDeletedBytes: 0,
    shortfallBytes: 0,
    poolShortfallBytes: 0,
    kinds,
  };
}

/**
 * Size one array's byte ask. Pure: the caller supplies the disk, the series, the recorded
 * deletions, the save rate and the per-kind pools.
 */
export function explainDynamicPace(input: {
  freeBytes: number;
  totalBytes: number;
  targetPct: number;
  samples: readonly FreeSpaceSample[];
  deletions: readonly RecordedDeletion[];
  /** Unix seconds. Samples after this are ignored by the forecast. */
  now: number;
  windowDays: number;
  horizonDays: number;
  floorBytes: number;
  ceilingBytes: number;
  saveRate: number | null;
  pools: readonly KindPool[];
}): DynamicPaceExplanation {
  const diskOk =
    Number.isFinite(input.freeBytes) &&
    Number.isFinite(input.totalBytes) &&
    input.totalBytes > 0 &&
    Number.isFinite(input.targetPct);
  const boundsOk =
    Number.isInteger(input.horizonDays) &&
    input.horizonDays >= 1 &&
    Number.isInteger(input.windowDays) &&
    input.windowDays >= 1 &&
    Number.isInteger(input.floorBytes) &&
    input.floorBytes >= 0 &&
    Number.isInteger(input.ceilingBytes) &&
    input.ceilingBytes >= 1 &&
    input.ceilingBytes >= input.floorBytes;
  const targetFreeBytes = diskOk ? Math.round(input.totalBytes * (1 - input.targetPct / 100)) : 0;
  const levelFreeBytes = diskOk ? input.freeBytes : 0;
  const gapBytes = diskOk ? Math.max(0, targetFreeBytes - levelFreeBytes) : 0;
  const surplusBytes = diskOk ? Math.max(0, levelFreeBytes - targetFreeBytes) : 0;
  const overTarget = diskOk && levelFreeBytes < targetFreeBytes;
  const common = {
    overTarget,
    levelFreeBytes,
    targetFreeBytes,
    gapBytes,
    surplusBytes,
    windowDays: input.windowDays,
    horizonDays: input.horizonDays,
    floorBytes: input.floorBytes,
    ceilingBytes: input.ceilingBytes,
    saveRate: input.saveRate,
    pools: input.pools,
  };
  if (!diskOk) return idle({ ...common, block: 'no_disk', forecastReason: null });
  if (!boundsOk) return idle({ ...common, block: 'bad_bounds', forecastReason: null });

  const adjusted = addRecordedDeletions(input.samples, input.deletions);
  const forecast = forecastFreeSpace({
    samples: adjusted,
    targetFreeBytes,
    now: input.now,
  });
  if (!forecast.forecast && forecast.reason !== 'flat') {
    return idle({ ...common, block: 'too_short', forecastReason: 'too_short' });
  }

  const rateKnown = forecast.forecast && forecast.rateBytesPerDay != null && Number.isFinite(forecast.rateBytesPerDay);
  const rate = rateKnown ? forecast.rateBytesPerDay! : 0;
  const intakeBytesPerDay = rateKnown ? (rate < 0 ? -rate : 0) : null;
  const saveOk = input.saveRate != null && input.saveRate >= 0 && input.saveRate < 1;
  const yieldRate = saveOk ? 1 - input.saveRate! : 1;
  const requiredDeletedBytes = overTarget
    ? Math.max(0, gapBytes - rate * input.horizonDays) * (input.windowDays / input.horizonDays)
    : Math.max(0, -rate * input.windowDays);
  const unclampedBytes = requiredDeletedBytes <= 0 ? 0 : requiredDeletedBytes / yieldRate;
  const ask =
    unclampedBytes <= 0
      ? 0
      : Math.min(input.ceilingBytes, Math.max(input.floorBytes, Math.floor(unclampedBytes)));
  const kinds = splitPaceAsk(ask, input.pools);
  const poolBytes = kinds.reduce((sum, kind) => sum + kind.poolBytes, 0);
  const chosenBytes = kinds.reduce((sum, kind) => sum + kind.chosenBytes, 0);
  const expectedDeletedBytes = chosenBytes * yieldRate;
  return {
    applicable: true,
    inapplicable: null,
    overTarget,
    pace: requiredDeletedBytes <= 0 ? 'none' : overTarget ? 'catch-up' : 'steady',
    levelFreeBytes,
    targetFreeBytes,
    gapBytes,
    surplusBytes,
    rateBytesPerDay: rateKnown ? rate : 0,
    intakeBytesPerDay,
    forecastReason: forecast.reason,
    windowDays: input.windowDays,
    horizonDays: input.horizonDays,
    intakePerWindowBytes: intakeBytesPerDay == null ? 0 : intakeBytesPerDay * input.windowDays,
    gapPerWindowBytes: overTarget ? (gapBytes * input.windowDays) / input.horizonDays : 0,
    requiredDeletedBytes,
    saveRate: input.saveRate,
    yieldRate,
    unclampedBytes,
    floorBytes: input.floorBytes,
    ceilingBytes: input.ceilingBytes,
    chosenBytes,
    poolBytes,
    expectedDeletedBytes,
    shortfallBytes: Math.max(0, requiredDeletedBytes - expectedDeletedBytes),
    poolShortfallBytes: Math.max(0, ask - poolBytes),
    kinds,
  };
}

const SILENT: DomainLogger = { info() {}, warn() {}, error() {} };

function asBytes(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Byte-weighted save rate over completed batches whose sweep fell inside the forecast window.
 * Skips are not in the ratio. Null when nothing was saved or deleted (no inflation).
 */
export async function measureTrashYield(db: DbClient | undefined, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - FORECAST_WINDOW_SECONDS * 1000);
  const [row] = await resolveDb(db)
    .select({
      saved: sql<string>`coalesce(sum(${trashBatchItems.sizeBytes}) filter (where ${trashBatchItems.state} = 'saved'), 0)::text`,
      deleted: sql<string>`coalesce(sum(${trashBatchItems.deletedSizeBytes}) filter (where ${trashBatchItems.state} = 'deleted'), 0)::text`,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatchItems.batchId, trashBatches.id))
    .where(and(eq(trashBatches.state, 'deleted'), gte(trashBatches.deletedAt, since)));
  const saved = asBytes(row?.saved);
  const deleted = asBytes(row?.deleted);
  const denom = saved + deleted;
  if (denom <= 0) return null;
  return saved / denom;
}

/** Sweep deletions inside the forecast window, one row per completed batch, at `deleted_at`. */
export async function recordedSweepDeletions(
  db: DbClient | undefined,
  now: Date,
): Promise<RecordedDeletion[]> {
  const since = new Date(now.getTime() - FORECAST_WINDOW_SECONDS * 1000);
  const rows = await resolveDb(db)
    .select({
      deletedAt: trashBatches.deletedAt,
      bytes: sql<string>`coalesce(sum(${trashBatchItems.deletedSizeBytes}), 0)::text`,
    })
    .from(trashBatches)
    .innerJoin(trashBatchItems, eq(trashBatchItems.batchId, trashBatches.id))
    .where(
      and(
        eq(trashBatches.state, 'deleted'),
        gte(trashBatches.deletedAt, since),
        eq(trashBatchItems.state, 'deleted'),
      ),
    )
    .groupBy(trashBatches.id, trashBatches.deletedAt);
  const out: RecordedDeletion[] = [];
  for (const row of rows) {
    if (row.deletedAt == null) continue;
    const bytes = asBytes(row.bytes);
    if (bytes <= 0) continue;
    out.push({ t: Math.floor(row.deletedAt.getTime() / 1000), bytes });
  }
  return out;
}

/**
 * Eligible bytes in the candidate snapshot, per kind. This is the status read's pool. It lags the
 * live Maintainerr set the proposal uses, and it never feeds a delete. A title the proposal
 * filter would drop (save, `dnd`, watchlist, recent) is not counted. Duplicate Maintainerr ids
 * keep the larger size.
 */
export async function measureDeletableSnapshotPools(
  db: DbClient | undefined,
  now: Date,
): Promise<KindPool[]> {
  const watchlist = await evaluateRegistryGate({ db, purpose: 'propose', now, logger: SILENT });
  const rows = await resolveDb(db).select().from(trashCandidates);
  const flat: FlatPending[] = rows.map((row) => ({
    collectionId: row.collectionId,
    collectionTitle: row.collectionTitle,
    deleteAfterDays: row.deleteAfterDays,
    collectionKind: row.mediaKind,
    maintainerrMediaId: row.maintainerrMediaId,
    tmdbId: row.tmdbId,
    tvdbId: row.tvdbId,
    sizeBytes: row.sizeBytes,
    addDate: row.addDate,
    plexGuid: row.plexGuid,
    ruleEvaluationFailed: row.ruleEvaluationFailed,
  }));
  const pools: KindPool[] = [];
  for (const mediaKind of ['movie', 'tv'] as const) {
    const shaped = await shapePendingItems({
      db,
      media: mediaKind,
      flat: bucketFlatPendingForMedia(flat, mediaKind),
      watchlist,
    });
    const byId = new Map<string, number>();
    for (const item of shaped.items) {
      if (!isPaceDeletable(item) || item.maintainerrMediaId == null) continue;
      const size = item.sizeBytes ?? 0;
      const prev = byId.get(item.maintainerrMediaId);
      if (prev === undefined || size > prev) byId.set(item.maintainerrMediaId, size);
    }
    let poolBytes = 0;
    for (const size of byId.values()) poolBytes += size;
    pools.push({ mediaKind, poolBytes });
  }
  return pools;
}
