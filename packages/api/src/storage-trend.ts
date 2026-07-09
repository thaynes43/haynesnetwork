// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the native free-space TREND read
// (`storage.trend`), replacing the LAN-only Grafana deep-link as the user-facing fill/drain surface.
//
// Two sources, combined per ADR-030's own facts:
//   • HISTORY — the exportarr `{radarr,sonarr,lidarr}_rootfolder_freespace_bytes` series in
//     Prometheus (the ONLY media-library disk history; C-02/C-06). freeSpace only — no total.
//   • TOTALS + TARGET — `getUtilization` (the *arr `/diskspace` totals + `space_targets`), so the
//     chart's threshold line agrees with the meters above it: targetFreeBytes is the space_targets
//     percent-USED ceiling converted to a FREE-bytes floor (total × (1 − target/100)).
//
// The exportarr `path` label is the ROOTFOLDER (`/data/haynestower/Media/Movies`), one level under
// the STORAGE_ARRAYS mount paths (`/data/haynestower`) — matching is prefix-aware both ways. Series
// group to the SAME physical arrays getUtilization surfaces (haynestower deduped radarr-first,
// sonarr fallback; music via either the mount or the rootfolder-label path), so chart and meters
// never disagree about what an "array" is.
//
// Resilient by construction: Prometheus down/misshapen ⇒ `unavailable: true` with empty series —
// the Storage tab degrades to a note, it never crashes (the C-03 posture, extended to the trend).
import {
  getUtilization,
  STORAGE_ARRAYS,
  type StorageArrayDescriptor,
  type StorageArrayUtilization,
  type UtilizationArrBundle,
} from '@hnet/domain';
import type { DbClient } from '@hnet/db';
import type { PrometheusRangeReader, PromMatrixSeries } from './prometheus';

/** The trend windows (trailing days). 30d is the default — long enough to read a fill trend,
 *  short enough that the axis stays legible on a phone. */
export const TREND_WINDOWS = ['7d', '30d', '90d', '365d'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

/**
 * Window → range/step. Steps are chosen so a full window carries ≤ ~185 points (payload + SVG
 * path budget) while staying on clean hour/day boundaries: 7d@1h=169, 30d@4h=181, 90d@12h=181,
 * 365d@48h=~183.
 */
export const TREND_WINDOW_SPECS: Record<TrendWindow, { seconds: number; stepSeconds: number }> = {
  '7d': { seconds: 7 * 86_400, stepSeconds: 3_600 },
  '30d': { seconds: 30 * 86_400, stepSeconds: 4 * 3_600 },
  '90d': { seconds: 90 * 86_400, stepSeconds: 12 * 3_600 },
  '365d': { seconds: 365 * 86_400, stepSeconds: 48 * 3_600 },
};

/**
 * One PromQL round-trip for all three kinds. `max by (__name__, path)` collapses pod-churn label
 * noise (restarts re-label `pod`/`instance`; the freespace reading itself is per-path) while
 * KEEPING the metric name + rootfolder path — exactly the two labels the array mapping needs.
 */
export const FREESPACE_TREND_QUERY =
  'max by (__name__, path) ({__name__=~"(radarr|sonarr|lidarr)_rootfolder_freespace_bytes"})';

const KIND_METRIC: Record<'radarr' | 'sonarr' | 'lidarr', string> = {
  radarr: 'radarr_rootfolder_freespace_bytes',
  sonarr: 'sonarr_rootfolder_freespace_bytes',
  lidarr: 'lidarr_rootfolder_freespace_bytes',
};

export interface TrendPoint {
  /** Unix SECONDS (step-aligned). */
  t: number;
  freeBytes: number;
}

export interface StorageTrendSeries {
  key: string;
  label: string;
  /** Ascending by t. May be EMPTY (no history yet) and may cover less than the window
   *  (Prometheus retention) — the chart draws what exists, honestly. */
  points: TrendPoint[];
  /** From the live diskspace read (getUtilization); null when that *arr is unreachable. */
  totalBytes: number | null;
  /** The space_targets percent-USED ceiling for this array, or null (no target set). */
  targetPct: number | null;
  /** The target as a FREE-bytes floor: totalBytes × (1 − targetPct/100). The chart's dashed line. */
  targetFreeBytes: number | null;
}

export interface StorageTrendReport {
  window: TrendWindow;
  stepSeconds: number;
  /** The queried range, unix seconds (end is step-aligned so close refetches share points). */
  start: number;
  end: number;
  /** True ⇒ Prometheus was unreachable/misshapen; `series` is empty and the UI degrades to a note. */
  unavailable: boolean;
  series: StorageTrendSeries[];
}

/** Rootfolder-vs-mount prefix match, either direction (exportarr paths sit UNDER the mount;
 *  the music candidates include the rootfolder label itself). */
function pathMatches(seriesPath: string, candidate: string): boolean {
  const c = candidate.replace(/\/+$/, '');
  const s = seriesPath.replace(/\/+$/, '');
  return s === c || s.startsWith(`${c}/`) || c.startsWith(`${s}/`);
}

/** Max-merge sample pairs from several matrix series (same array, several rootfolders) into one
 *  ascending point list, dropping non-finite values. */
function mergePoints(series: PromMatrixSeries[]): TrendPoint[] {
  const byT = new Map<number, number>();
  for (const s of series) {
    for (const [t, raw] of s.values) {
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

/**
 * Map the raw matrix onto the STORAGE_ARRAYS grouping, deduping shared arrays exactly like
 * getUtilization: sources are tried in order and the FIRST kind with a matching series supplies
 * the history (HaynesTower = radarr first, sonarr fallback), so either *arr exporter being down
 * never blanks the shared array. Pure — unit-tested without a server.
 */
export function mapTrendSeries(
  matrix: PromMatrixSeries[],
  utilization: StorageArrayUtilization[],
  arrays: StorageArrayDescriptor[] = STORAGE_ARRAYS,
): StorageTrendSeries[] {
  return arrays.map((desc) => {
    const util = utilization.find((u) => u.key === desc.key);
    const totalBytes = util?.totalSpace ?? null;
    const targetPct = util?.target ?? null;
    const targetFreeBytes =
      totalBytes != null && targetPct != null
        ? Math.round(totalBytes * (1 - targetPct / 100))
        : null;

    let points: TrendPoint[] = [];
    for (const source of desc.sources) {
      const matched = matrix.filter(
        (s) =>
          s.metric.__name__ === KIND_METRIC[source.arr] &&
          typeof s.metric.path === 'string' &&
          source.paths.some((p) => pathMatches(s.metric.path!, p)),
      );
      if (matched.length === 0) continue;
      points = mergePoints(matched);
      break; // first reachable source wins — the getUtilization dedupe, applied to history
    }

    return { key: desc.key, label: desc.label, points, totalBytes, targetPct, targetFreeBytes };
  });
}

/**
 * The `storage.trend` read: one Prometheus range query + the live utilization read (totals +
 * targets), combined per array. Prometheus failing ⇒ `unavailable: true`, NEVER a throw — the
 * Storage tab must keep rendering its meters when the trend source is down.
 */
export async function getStorageTrend(input: {
  db?: DbClient;
  arr: UtilizationArrBundle;
  prometheus: PrometheusRangeReader;
  window: TrendWindow;
  now?: Date;
}): Promise<StorageTrendReport> {
  const spec = TREND_WINDOW_SPECS[input.window];
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const end = Math.floor(nowSec / spec.stepSeconds) * spec.stepSeconds;
  const start = end - spec.seconds;

  const [utilization, matrix] = await Promise.all([
    getUtilization({ db: input.db, arr: input.arr }),
    input.prometheus
      .queryRange(FREESPACE_TREND_QUERY, start, end, spec.stepSeconds)
      .catch(() => null), // any failure ⇒ the degrade path
  ]);

  if (matrix === null) {
    return { window: input.window, stepSeconds: spec.stepSeconds, start, end, unavailable: true, series: [] };
  }
  return {
    window: input.window,
    stepSeconds: spec.stepSeconds,
    start,
    end,
    unavailable: false,
    series: mapTrendSeries(matrix, utilization),
  };
}
