// DESIGN-013 D-08 (story 834) — Capacity Forecast. One pure function of a free-space series, the
// array's free-bytes target floor, and the current time. No I/O and no clock read.
//
// It lives in `@hnet/domain` so `packages/api` (which already depends on this package) and
// `space-policy.ts` (story 820) can both call it. Putting it in `@hnet/api` would cycle when
// story 820 imports it; `@hnet/metrics` is the Prometheus client, and this function does not do I/O.
//
// Method, measured on the 2026-11-13 90-day series (D-08): ordinary least squares of free bytes on
// time, over the samples the caller passes (the read asks for 90 days at a 3-day step). When the
// latest sample is more than 4 residual standard deviations off the line fitted to the samples at
// least 6 days earlier, that earlier line supplies the rate and the latest sample supplies the
// level. A series of fewer than 8 points, or shorter than 21 days, is too short. A slope within
// 2 standard errors of zero is flat. Both are "no forecast".
const DAY_SECONDS = 86_400;

/** Fit window the Storage forecast read queries. The 90-day span is the one D-08 selects. */
export const FORECAST_WINDOW_SECONDS = 90 * DAY_SECONDS;
/** Sample step of that read. Matches the 3-day series the method was measured on. */
export const FORECAST_STEP_SECONDS = 3 * DAY_SECONDS;
/** Fewer points than this, or a shorter span, is `too_short`. */
export const FORECAST_MIN_POINTS = 8;
export const FORECAST_MIN_SPAN_SECONDS = 21 * DAY_SECONDS;
/** Samples newer than this are left out of the slope when the latest sample is a step. */
export const FORECAST_STEP_HOLD_SECONDS = 6 * DAY_SECONDS;
/** Latest-sample residual, in prefix standard deviations, above which the step hold applies. */
export const FORECAST_STEP_SIGMAS = 4;
/** |slope| at or under this many standard errors is `flat`. */
export const FORECAST_FLAT_SIGMAS = 2;

/** One free-space sample. `t` is unix seconds. */
export interface FreeSpaceSample {
  t: number;
  freeBytes: number;
}

export type StorageForecastDirection = 'filling' | 'draining' | 'flat' | 'unknown';
export type StorageForecastReason = 'too_short' | 'flat';

/**
 * One array's forecast. `rateBytesPerDay` is the change in FREE bytes per day: negative when use
 * is rising (`filling`), positive when use is falling (`draining`). `fullAt` is when free bytes
 * reach 0 (100% used). `targetAt` is when they reach `targetFreeBytes`. Either date is null when
 * that level is not ahead of the trend. `forecast` is false only for `too_short` and `flat`.
 */
export interface StorageForecast {
  forecast: boolean;
  reason: StorageForecastReason | null;
  direction: StorageForecastDirection;
  /** Null when the series is too short to fit. */
  rateBytesPerDay: number | null;
  /** Unix seconds, or null. */
  fullAt: number | null;
  /** Unix seconds, or null. */
  targetAt: number | null;
}

interface LineFit {
  /** Free bytes per day. */
  slope: number;
  /** Free bytes at unix day 0 (`t / 86400 = 0`). */
  intercept: number;
  /** Residual standard deviation, bytes. */
  sigma: number;
  /** Standard error of the slope, bytes per day. */
  seSlope: number;
}

function noForecast(reason: StorageForecastReason, rate: number | null): StorageForecast {
  return {
    forecast: false,
    reason,
    direction: reason === 'flat' ? 'flat' : 'unknown',
    rateBytesPerDay: rate,
    fullAt: null,
    targetAt: null,
  };
}

/** Finite samples at or before `now`, one per timestamp, keeping the larger free-byte reading. */
function cleanSamples(samples: readonly FreeSpaceSample[], now: number): FreeSpaceSample[] {
  const byT = new Map<number, number>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.freeBytes)) continue;
    if (sample.t > now) continue;
    const prev = byT.get(sample.t);
    if (prev === undefined || sample.freeBytes > prev) byT.set(sample.t, sample.freeBytes);
  }
  return Array.from(byT.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, freeBytes]) => ({ t, freeBytes }));
}

function longEnough(points: readonly FreeSpaceSample[]): boolean {
  if (points.length < FORECAST_MIN_POINTS) return false;
  const span = points[points.length - 1]!.t - points[0]!.t;
  return span >= FORECAST_MIN_SPAN_SECONDS;
}

/** Ordinary least squares of free bytes on unix days. `points` has at least 3 samples. */
function fitLine(points: readonly FreeSpaceSample[]): LineFit {
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  const xs: number[] = new Array(n);
  const ys: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = points[i]!.t / DAY_SECONDS;
    const y = points[i]!.freeBytes;
    xs[i] = x;
    ys[i] = y;
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const residual = ys[i]! - (intercept + slope * xs[i]!);
    sse += residual * residual;
  }
  const variance = sse / (n - 2);
  return {
    slope,
    intercept,
    sigma: Math.sqrt(variance),
    seSlope: Math.sqrt(variance / sxx),
  };
}

/**
 * Forecast when this free-space series reaches its target floor and when it reaches 0.
 * `now` is unix seconds. The function does not read the clock.
 */
export function forecastFreeSpace(input: {
  samples: readonly FreeSpaceSample[];
  /** Free-byte floor for the space target. Null when the array has no target. */
  targetFreeBytes: number | null;
  now: number;
}): StorageForecast {
  const points = cleanSamples(input.samples, input.now);
  if (!longEnough(points)) return noForecast('too_short', null);

  const last = points[points.length - 1]!;
  const full = fitLine(points);
  const holdBefore = last.t - FORECAST_STEP_HOLD_SECONDS;
  const prefix = points.filter((p) => p.t <= holdBefore);
  let chosen = full;
  if (longEnough(prefix)) {
    const earlier = fitLine(prefix);
    const predicted = earlier.intercept + earlier.slope * (last.t / DAY_SECONDS);
    const residual = last.freeBytes - predicted;
    const step =
      earlier.sigma === 0
        ? residual !== 0
        : Math.abs(residual) > FORECAST_STEP_SIGMAS * earlier.sigma;
    if (step) chosen = earlier;
  }

  if (!Number.isFinite(chosen.slope) || !Number.isFinite(chosen.seSlope)) {
    return noForecast('flat', null);
  }
  if (Math.abs(chosen.slope) <= FORECAST_FLAT_SIGMAS * chosen.seSlope) {
    return noForecast('flat', chosen.slope);
  }

  const direction: StorageForecastDirection = chosen.slope < 0 ? 'filling' : 'draining';
  const crossing = (threshold: number): number | null => {
    const days = (threshold - last.freeBytes) / chosen.slope;
    if (!(days > 0)) return null;
    const at = last.t + days * DAY_SECONDS;
    const rounded = Math.round(at);
    if (!(at > input.now) || rounded <= input.now) return null;
    return rounded;
  };

  // 100% is ahead only while free space is still falling and some remains.
  const fullAt = chosen.slope < 0 && last.freeBytes > 0 ? crossing(0) : null;
  const target =
    input.targetFreeBytes != null && Number.isFinite(input.targetFreeBytes)
      ? input.targetFreeBytes
      : null;
  return {
    forecast: true,
    reason: null,
    direction,
    rateBytesPerDay: chosen.slope,
    fullAt,
    targetAt: target == null ? null : crossing(target),
  };
}
