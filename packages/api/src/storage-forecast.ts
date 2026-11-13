// DESIGN-013 D-08 (story 834) — the Storage forecast read (`storage.forecast`).
// Same array grouping and targets as `storage.trend`. The method itself is `forecastFreeSpace`
// in `@hnet/domain` (no I/O). Prometheus down ⇒ `unavailable: true`, never a throw.
//
// Two readings feed each array's forecast. The RATE comes from the Prometheus history, queried on
// the step-aligned grid so close refetches share samples. The LEVEL the dates start from is the
// live `/diskspace` free space this call already reads for the totals, stamped `now`: the last
// aligned sample can be up to one step (3 days) old. When that *arr is unreachable the level
// falls back to the last sample.
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
  /** Queried range of the history, unix seconds. `end` is step-aligned, so it can trail `now`. */
  start: number;
  end: number;
  stepSeconds: number;
  /** True ⇒ Prometheus was unreachable or misshapen; `series` is empty. */
  unavailable: boolean;
  series: StorageForecastSeries[];
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

  if (matrix === null) {
    return { start, end, stepSeconds: FORECAST_STEP_SECONDS, unavailable: true, series: [] };
  }

  return {
    start,
    end,
    stepSeconds: FORECAST_STEP_SECONDS,
    unavailable: false,
    series: mapTrendSeries(matrix, utilization).map((series) => {
      const liveFree = utilization.find((u) => u.key === series.key)?.freeSpace ?? null;
      return {
        key: series.key,
        label: series.label,
        totalBytes: series.totalBytes,
        targetPct: series.targetPct,
        targetFreeBytes: series.targetFreeBytes,
        forecast: forecastFreeSpace({
          samples: series.points,
          targetFreeBytes: series.targetFreeBytes,
          now: nowSec,
          level: liveFree === null ? null : { t: nowSec, freeBytes: liveFree },
        }),
      };
    }),
  };
}
