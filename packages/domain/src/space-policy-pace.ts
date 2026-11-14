// ADR-120 / DESIGN-014 D-16 (story 820) — Dynamic Pace. How many bytes a Trash batch asks for,
// from the capacity gap and the intake. It never chooses titles: the existing guards still do.
//
// The switch ships off. While it is off, nothing in this file decides a batch.
//
// Intake is the Capacity Forecast (DESIGN-013 D-08) on a series that has this app's own recorded
// sweep deletions added back, so the rate is intake and not intake minus Trash. A level jump the
// forecast sets aside stays set aside. The live free-space reading is the level for the gap; it
// does not enter the rate.
import {
  TRASH_BATCH_OPEN_STATES,
  trashBatchItems,
  trashBatches,
  trashCandidates,
  type DbClient,
  type TrashMediaKind,
} from '@hnet/db';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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
import {
  bucketFlatPendingForMedia,
  hasMediaRequestTag,
  shapePendingItems,
  type FlatPending,
} from './trash-flow';
import { evaluateRegistryGate } from './watchlist-registry';

/**
 * The same PromQL the Storage page's free-space chart uses. One series, so the pace and the chart
 * read one history.
 */
export const FREESPACE_SERIES_QUERY =
  'max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})';

/**
 * Rolling time constant: coordinator's Q-13 decision (820 comment 8175), awaiting the owner.
 * ADR-124 / DESIGN-014 D-17. This is a policy choice, not a disk measurement or deadline.
 */
export const DYNAMIC_PACE_HORIZON_DAYS = 30;

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
export type DynamicPaceBlock =
  'too_short' | 'bad_bounds' | 'no_disk' | 'stale_series' | 'unknown_rate';

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
 * `chosenBytes` is the array ask after the floor, the ceiling and the pool.
 * The job replaces it with its actual selection when enabled sizing runs. It is 0 when
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
   * fills. Null when no rate can be measured; a flat forecast retains its measured rate.
   */
  rateBytesPerDay: number | null;
  /**
   * Bytes per day the library is filling. Null when the rate was not measured. 0 when the measured rate is draining.
   */
  intakeBytesPerDay: number | null;
  forecastReason: 'too_short' | 'flat' | null;
  windowDays: number;
  horizonDays: number;
  /** Intake across one save window. 0 when intake was not measured. */
  intakePerWindowBytes: number;
  /** The gap's share of one window. 0 when the array is not over target. */
  gapPerWindowBytes: number;
  /** Bytes that have to be deleted this window, before any safety/pool/selection cap. */
  requiredDeletedBytes: number;
  /** Required deletion over the rolling horizon, before any safety or pool cap. */
  horizonRequiredDeletedBytes: number;
  /** Horizon requirement minus the expected yield of the unposted pool. */
  horizonShortfallBytes: number;
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
    const matrix = await reader.queryRange(
      FREESPACE_SERIES_QUERY,
      range.start,
      range.end,
      range.step,
    );
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    return null;
  return value;
}

/** Measured current movie/TV title caps, replica SELECT 2026-11-14; D-17. */
export const DYNAMIC_PACE_MOVIE_MAX_ITEMS = 50;
export const DYNAMIC_PACE_TV_MAX_ITEMS = 5;

/**
 * Defaults are for an absent/off object. An active object with unreadable existing bounds reads
 * as off; never silently apply substituted bounds. New optional fields migrate valid old objects.
 */
export function resolveDynamicPace(
  raw: unknown,
  movieMaxItems = DYNAMIC_PACE_MOVIE_MAX_ITEMS,
): DynamicPaceConfig {
  const stored = (raw !== null && typeof raw === 'object' ? raw : {}) as Partial<DynamicPaceConfig>;
  const horizon = finiteInt(stored.horizonDays, 1, 3660);
  const floor = finiteInt(stored.floorBytes, 0, DYNAMIC_PACE_CEILING_BYTES);
  const ceiling = finiteInt(stored.ceilingBytes, 1, DYNAMIC_PACE_CEILING_BYTES);
  const titles = finiteInt(stored.movieMaxItems, 1, Number.MAX_SAFE_INTEGER);
  const valid =
    horizon !== null &&
    floor !== null &&
    ceiling !== null &&
    floor <= ceiling &&
    (stored.movieMaxItems === undefined || titles !== null) &&
    (stored.observeOnly === undefined || typeof stored.observeOnly === 'boolean');
  return {
    enabled: valid && stored.enabled === true && stored.observeOnly !== true,
    observeOnly: valid && stored.observeOnly === true,
    horizonDays: valid ? horizon : DYNAMIC_PACE_HORIZON_DAYS,
    floorBytes: valid ? floor : DYNAMIC_PACE_FLOOR_BYTES,
    ceilingBytes: valid ? ceiling : DYNAMIC_PACE_CEILING_BYTES,
    movieMaxItems: titles ?? movieMaxItems,
  };
}

/**
 * Settings edge (ADR-120). Saving a horizon shorter than the save window is refused.
 * The sizing formula also clamps `window / horizon` at 1, so a window lengthened after
 * a legal save cannot multiply one window's requirement by more than one.
 */
export function dynamicPaceHorizonFitsWindow(horizonDays: number, windowDays: number): boolean {
  return (
    Number.isInteger(horizonDays) &&
    Number.isInteger(windowDays) &&
    windowDays >= 1 &&
    horizonDays >= windowDays &&
    horizonDays <= 3660
  );
}

/**
 * The proposal filter, shared so the status snapshot and the live proposal count the same titles. ADR-117 /
 * DESIGN-052 D-29 — a title whose file on disk has no verified posted release name (the Release Name Check says
 * `unverified`) is never proposed and frees nothing: the sweep would keep it, so it is not in the pool either.
 * ADR-118 — a title tagged `mediarequests` is the same: the sweep would keep it, and no batch snapshots it.
 */
export function isPaceDeletable<
  T extends {
    maintainerrMediaId: string | null;
    saveIntent: boolean;
    protectedByTag: boolean;
    onWatchlist: boolean;
    ageGuard: string;
    arrTags?: readonly string[];
    releaseName?: string;
  },
>(item: T): item is T & { maintainerrMediaId: string } {
  return (
    item.maintainerrMediaId !== null &&
    !item.saveIntent &&
    !item.protectedByTag &&
    !item.onWatchlist &&
    item.ageGuard !== 'recent' &&
    !hasMediaRequestTag(item.arrTags) &&
    item.releaseName !== 'unverified'
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
    const order = clean
      .slice()
      .sort((a, b) => b.poolBytes - a.poolBytes || (a.mediaKind < b.mediaKind ? -1 : 1));
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
    horizonRequiredDeletedBytes: 0,
    horizonShortfallBytes: 0,
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
    input.ceilingBytes >= input.floorBytes &&
    input.ceilingBytes <= DYNAMIC_PACE_CEILING_BYTES;
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

  // The recorded series has a measured 3-day step (2026-11-13). Allow its alignment lag,
  // but no missing newest grid point. Do not invent a further grace interval (D-17).
  const usable = input.samples.filter(
    (s) => Number.isFinite(s.t) && Number.isFinite(s.freeBytes) && s.t <= input.now,
  );
  const adjusted = addRecordedDeletions(input.samples, input.deletions);
  const forecast = forecastFreeSpace({
    samples: adjusted,
    targetFreeBytes,
    now: input.now,
  });
  if (!forecast.forecast && forecast.reason !== 'flat') {
    return idle({ ...common, block: 'too_short', forecastReason: 'too_short' });
  }

  if (
    usable.length > 0 &&
    Math.max(...usable.map((s) => s.t)) < forecastQueryRange(input.now).end
  ) {
    return idle({ ...common, block: 'stale_series', forecastReason: null });
  }

  const rate = forecast.rateBytesPerDay;
  if (rate === null || !Number.isFinite(rate)) {
    return idle({ ...common, block: 'unknown_rate', forecastReason: forecast.reason });
  }
  const intakeBytesPerDay = Math.max(0, -rate);
  const saveOk = input.saveRate != null && input.saveRate >= 0 && input.saveRate < 1;
  const yieldRate = saveOk ? 1 - input.saveRate! : 1;
  // A window longer than the horizon must not ask for more than the horizon's requirement.
  const windowShare = Math.min(1, input.windowDays / input.horizonDays);
  const horizonRequiredDeletedBytes =
    input.targetPct >= 100
      ? 0
      : Math.max(0, targetFreeBytes - levelFreeBytes - rate * input.horizonDays);
  const requiredDeletedBytes = horizonRequiredDeletedBytes * windowShare;
  const unclampedBytes = requiredDeletedBytes <= 0 ? 0 : requiredDeletedBytes / yieldRate;
  const belowUnderTargetFloor = !overTarget && unclampedBytes < input.floorBytes;
  const ask =
    unclampedBytes <= 0 || belowUnderTargetFloor
      ? 0
      : Math.min(input.ceilingBytes, Math.max(input.floorBytes, Math.floor(unclampedBytes)));
  const available = Math.min(
    ask,
    input.pools.reduce((sum, pool) => sum + nonNegative(pool.poolBytes), 0),
  );
  const kinds = splitPaceAsk(!overTarget && available < input.floorBytes ? 0 : ask, input.pools);
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
    rateBytesPerDay: rate,
    intakeBytesPerDay,
    forecastReason: forecast.reason,
    windowDays: input.windowDays,
    horizonDays: input.horizonDays,
    intakePerWindowBytes: intakeBytesPerDay == null ? 0 : intakeBytesPerDay * input.windowDays,
    gapPerWindowBytes: overTarget ? gapBytes * windowShare : 0,
    requiredDeletedBytes,
    horizonRequiredDeletedBytes,
    horizonShortfallBytes: Math.max(0, horizonRequiredDeletedBytes - poolBytes * yieldRate),
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
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Current array-to-kind topology; music never supplies deletable Trash bytes. */
function measurementKinds(arrayKey: string): Array<'movie' | 'tv'> {
  const sources = STORAGE_ARRAYS.find((a) => a.key === arrayKey)?.sources ?? [];
  return [
    ...new Set(
      sources.flatMap((s) =>
        s.arr === 'radarr' ? ['movie' as const] : s.arr === 'sonarr' ? ['tv' as const] : [],
      ),
    ),
  ];
}

/** Open titles cannot supply another batch's pool. Include every item state of an open batch. */
export async function openPaceTitleIds(
  db: DbClient | undefined,
): Promise<Map<TrashMediaKind, Set<string>>> {
  const rows = await resolveDb(db)
    .select({ mediaKind: trashBatches.mediaKind, id: trashBatchItems.maintainerrMediaId })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatchItems.batchId, trashBatches.id))
    .where(inArray(trashBatches.state, [...TRASH_BATCH_OPEN_STATES]));
  const out = new Map<TrashMediaKind, Set<string>>();
  for (const row of rows) {
    if (!out.has(row.mediaKind)) out.set(row.mediaKind, new Set());
    out.get(row.mediaKind)!.add(row.id);
  }
  return out;
}

/**
 * Byte-weighted save rate over completed batches whose sweep fell inside the forecast window.
 * Skips are not in the ratio. Null when nothing was saved or deleted (no inflation).
 */
export async function measureTrashYield(
  db: DbClient | undefined,
  now: Date,
  arrayKey = 'haynestower',
): Promise<number | null> {
  const kinds = measurementKinds(arrayKey);
  if (kinds.length === 0) return null;
  const since = new Date(now.getTime() - FORECAST_WINDOW_SECONDS * 1000);
  const [row] = await resolveDb(db)
    .select({
      saved: sql<string>`coalesce(sum(${trashBatchItems.sizeBytes}) filter (where ${trashBatchItems.state} = 'saved'), 0)::text`,
      deleted: sql<string>`coalesce(sum(${trashBatchItems.deletedSizeBytes}) filter (where ${trashBatchItems.state} = 'deleted'), 0)::text`,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatchItems.batchId, trashBatches.id))
    .where(
      and(
        eq(trashBatches.state, 'deleted'),
        gte(trashBatches.deletedAt, since),
        lte(trashBatches.deletedAt, now),
        inArray(trashBatches.mediaKind, kinds),
      ),
    );
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
  arrayKey = 'haynestower',
  seriesStart = forecastQueryRange(Math.floor(now.getTime() / 1000)).start,
): Promise<RecordedDeletion[]> {
  const kinds = measurementKinds(arrayKey);
  if (kinds.length === 0) return [];
  const since = new Date(seriesStart * 1000);
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
        lte(trashBatches.deletedAt, now),
        inArray(trashBatches.mediaKind, kinds),
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
  const posted = await openPaceTitleIds(db);
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
      if (
        !isPaceDeletable(item) ||
        item.maintainerrMediaId == null ||
        posted.get(mediaKind)?.has(item.maintainerrMediaId)
      )
        continue;
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
