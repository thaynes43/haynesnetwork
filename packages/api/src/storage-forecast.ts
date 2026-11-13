// DESIGN-013 D-08 (story 834) — the Storage forecast read (`storage.forecast`).
// Same array grouping and targets as `storage.trend`. The method itself is `forecastFreeSpace`
// in `@hnet/domain` (no I/O). Prometheus down ⇒ `unavailable: true`, never a throw.
//
// Two readings feed each array's forecast. The RATE comes from the Prometheus history, queried on
// the step-aligned grid so close refetches share samples. The LEVEL the dates start from is the
// live `/diskspace` free space this call already reads for the totals, stamped `now`: the last
// aligned sample can be up to one step (3 days) old. When that *arr is unreachable the level
// falls back to the last sample.
//
// DESIGN-013 D-09 (story 819) — what the plot needs beside the forecast: the samples the rate was
// read from (the history it draws), the jumps in them that the rate set aside (`forecastJumps`),
// the instant the forecast was made, and the method's two "too short" floors. The method and
// `forecastFreeSpace` are not changed by any of it.
import {
  forecastFreeSpace,
  getUtilization,
  FORECAST_MIN_POINTS,
  FORECAST_MIN_SPAN_SECONDS,
  FORECAST_STEP_SECONDS,
  FORECAST_TRIM_SHARE,
  FORECAST_WINDOW_SECONDS,
  type StorageForecast,
  type UtilizationArrBundle,
} from '@hnet/domain';
import type { DbClient } from '@hnet/db';
import type { PrometheusRangeReader } from './prometheus';
import { FREESPACE_TREND_QUERY, mapTrendSeries, type TrendPoint } from './storage-trend';

const DAY_SECONDS = 86_400;
/** A step this many scaled median deviations from the median step is far from the others (D-09). */
export const FORECAST_JUMP_DEVIATIONS = 3;
/** Scales a median absolute deviation to a standard deviation for normally spread steps. */
const MAD_SCALE = 1.4826;

/**
 * The jumps in the history that the rate set aside (D-09). A jump is a step far from the others
 * that moved the dates by a day or more. `bytes` is the plain change in free space across those
 * steps, the amount a reader sees on the chart.
 */
export interface StorageForecastJumps {
  /** Free space jumped up. */
  rises: { count: number; bytes: number };
  /** Free space dropped. */
  falls: { count: number; bytes: number };
  /** Unix seconds of the sample that ends the newest jump. */
  latestAt: number;
  /**
   * True when one direction holds more far steps than the method sets aside there, so some of
   * them are inside the rate (D-08, Q-05).
   */
  partlyCounted: boolean;
}

export interface StorageForecastSeries {
  key: string;
  label: string;
  totalBytes: number | null;
  targetPct: number | null;
  /** Free-byte floor, `totalBytes × (1 − targetPct/100)`, or null when no target or no total. */
  targetFreeBytes: number | null;
  forecast: StorageForecast;
  /** The samples the rate was read from, ascending, at `stepSeconds`. The plot's history. */
  points: TrendPoint[];
  /** Null when there is no projection to qualify, or no jump in the samples. */
  jumps: StorageForecastJumps | null;
}

export interface StorageForecastReport {
  /** Queried range of the history, unix seconds. `end` is step-aligned, so it can trail `now`. */
  start: number;
  end: number;
  stepSeconds: number;
  /** Unix seconds the forecast was made at: "today" on the plot and in its words. */
  now: number;
  /** The method's floors for a forecast (D-08), so the page can say what "too short" lacks. */
  minPoints: number;
  minSpanSeconds: number;
  /** True ⇒ Prometheus was unreachable or misshapen; `series` is empty. */
  unavailable: boolean;
  series: StorageForecastSeries[];
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The jumps in `points` that `forecast`'s rate set aside (D-09). Pure.
 *
 * A step (change in free bytes per day between two consecutive samples, as in D-08) is FAR when it
 * lies more than `FORECAST_JUMP_DEVIATIONS` scaled median deviations from the median step, the
 * measure D-08 used to count the jumps in the recorded series (largest ordinary step 1.96, smallest
 * jump 4.42). Far steps are the extreme ones on their side, so the method's trim sets them aside
 * while there are no more of them than it trims there. A far step is NAMED as a jump when free
 * space really moved that way (a rise is above the median and positive, a fall below it and
 * negative) and its departure from the usual step is at least one day of the rate, which is a day
 * on the forecast dates, the finest the page prints. That last test also keeps a perfectly regular
 * series, whose deviation is zero, from naming its rounding as a jump.
 *
 * `points` are `mapTrendSeries`'s: finite, one per timestamp, ascending, none after `now`, so they
 * are the samples `forecastFreeSpace` kept.
 */
export function forecastJumps(
  points: readonly TrendPoint[],
  forecast: Pick<StorageForecast, 'forecast' | 'rateBytesPerDay'>,
): StorageForecastJumps | null {
  const rate = forecast.rateBytesPerDay;
  if (!forecast.forecast || rate === null || points.length < 3) return null;

  const steps: { t: number; change: number; days: number; perDay: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const days = (points[i]!.t - points[i - 1]!.t) / DAY_SECONDS;
    const change = points[i]!.freeBytes - points[i - 1]!.freeBytes;
    steps.push({ t: points[i]!.t, change, days, perDay: change / days });
  }
  const usual = median(steps.map((s) => s.perDay).sort((a, b) => a - b));
  const scale =
    MAD_SCALE * median(steps.map((s) => Math.abs(s.perDay - usual)).sort((a, b) => a - b));
  const far = steps.filter((s) => Math.abs(s.perDay - usual) > FORECAST_JUMP_DEVIATIONS * scale);

  const oneDayOfRate = Math.abs(rate);
  const moved = (s: (typeof steps)[number]): boolean =>
    Math.abs((s.perDay - usual) * s.days) >= oneDayOfRate;
  const rises = far.filter((s) => s.perDay > usual && s.change > 0 && moved(s));
  const falls = far.filter((s) => s.perDay < usual && s.change < 0 && moved(s));
  if (rises.length === 0 && falls.length === 0) return null;

  const setAsideEachEnd = Math.floor(steps.length * FORECAST_TRIM_SHARE);
  const sum = (list: typeof steps): number => list.reduce((acc, s) => acc + Math.abs(s.change), 0);
  return {
    rises: { count: rises.length, bytes: sum(rises) },
    falls: { count: falls.length, bytes: sum(falls) },
    latestAt: Math.max(...rises.map((s) => s.t), ...falls.map((s) => s.t)),
    partlyCounted:
      far.filter((s) => s.perDay > usual).length > setAsideEachEnd ||
      far.filter((s) => s.perDay < usual).length > setAsideEachEnd,
  };
}

/**
 * `storage.forecast`: one Prometheus range query over the D-08 window, plus the live utilization
 * read (totals, targets and the current free space), then `forecastFreeSpace` per array.
 * Prometheus failing ⇒ `unavailable`, never a throw — the Storage tab keeps rendering.
 */
export async function getStorageForecast(input: {
  db?: DbClient;
  arr: UtilizationArrBundle;
  prometheus: PrometheusRangeReader;
  now?: Date;
}): Promise<StorageForecastReport> {
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const end = Math.floor(nowSec / FORECAST_STEP_SECONDS) * FORECAST_STEP_SECONDS;
  const start = end - FORECAST_WINDOW_SECONDS;

  const [utilization, matrix] = await Promise.all([
    getUtilization({ db: input.db, arr: input.arr }),
    input.prometheus
      .queryRange(FREESPACE_TREND_QUERY, start, end, FORECAST_STEP_SECONDS)
      .catch(() => null),
  ]);

  const frame = {
    start,
    end,
    stepSeconds: FORECAST_STEP_SECONDS,
    now: nowSec,
    minPoints: FORECAST_MIN_POINTS,
    minSpanSeconds: FORECAST_MIN_SPAN_SECONDS,
  };
  if (matrix === null) return { ...frame, unavailable: true, series: [] };

  return {
    ...frame,
    unavailable: false,
    series: mapTrendSeries(matrix, utilization).map((series) => {
      const liveFree = utilization.find((u) => u.key === series.key)?.freeSpace ?? null;
      const forecast = forecastFreeSpace({
        samples: series.points,
        targetFreeBytes: series.targetFreeBytes,
        now: nowSec,
        level: liveFree === null ? null : { t: nowSec, freeBytes: liveFree },
      });
      return {
        key: series.key,
        label: series.label,
        totalBytes: series.totalBytes,
        targetPct: series.targetPct,
        targetFreeBytes: series.targetFreeBytes,
        forecast,
        points: series.points,
        jumps: forecastJumps(series.points, forecast),
      };
    }),
  };
}
