// DESIGN-013 D-08 (story 834) — the Storage forecast read (`storage.forecast`).
// Same array grouping and targets as `storage.trend`. The fit itself is `forecastFreeSpace`
// in `@hnet/domain` (no I/O). Prometheus down ⇒ `unavailable: true`, never a throw.
import {
  forecastFreeSpace,
  getUtilization,
  FORECAST_STEP_SECONDS,
  FORECAST_WINDOW_SECONDS,
  type StorageForecast,
  type UtilizationArrBundle,
} from '@hnet/domain';
import type { DbClient } from '@hnet/db';
import type { PrometheusRangeReader } from './prometheus';
import { FREESPACE_TREND_QUERY, mapTrendSeries } from './storage-trend';

export interface StorageForecastSeries {
  key: string;
  label: string;
  totalBytes: number | null;
  targetPct: number | null;
  /** Free-byte floor, `totalBytes × (1 − targetPct/100)`, or null when no target or no total. */
  targetFreeBytes: number | null;
  forecast: StorageForecast;
}

export interface StorageForecastReport {
  /** Queried range, unix seconds. `end` is step-aligned. */
  start: number;
  end: number;
  stepSeconds: number;
  /** True ⇒ Prometheus was unreachable or misshapen; `series` is empty. */
  unavailable: boolean;
  series: StorageForecastSeries[];
}

/**
 * `storage.forecast`: one Prometheus range query over the D-08 window, plus the live utilization
 * read (totals + targets), then `forecastFreeSpace` per array. Prometheus failing ⇒ `unavailable`,
 * never a throw — the Storage tab keeps rendering.
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

  if (matrix === null) {
    return { start, end, stepSeconds: FORECAST_STEP_SECONDS, unavailable: true, series: [] };
  }

  return {
    start,
    end,
    stepSeconds: FORECAST_STEP_SECONDS,
    unavailable: false,
    series: mapTrendSeries(matrix, utilization).map((series) => ({
      key: series.key,
      label: series.label,
      totalBytes: series.totalBytes,
      targetPct: series.targetPct,
      targetFreeBytes: series.targetFreeBytes,
      forecast: forecastFreeSpace({
        samples: series.points,
        targetFreeBytes: series.targetFreeBytes,
        now: nowSec,
      }),
    })),
  };
}
