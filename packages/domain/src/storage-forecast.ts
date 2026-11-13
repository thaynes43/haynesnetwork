// DESIGN-013 D-08 (story 834) — Capacity Forecast. One pure function of a free-space series, the
// array's free-bytes target floor, the current time and, when the caller holds one, a newer reading
// of the level. No I/O and no clock read.
//
// It lives in `@hnet/domain` so `packages/api` (which already depends on this package) and
// `space-policy.ts` (story 820) can both call it. Putting it in `@hnet/api` would cycle when
// story 820 imports it; `@hnet/metrics` is the Prometheus client, and this function does not do I/O.
//
// Method (D-08, measured on the series recorded 2026-11-13). A step is the change in free bytes per
// day between two consecutive samples. The rate is the interquartile mean of the steps: sort them,
// set aside a quarter (rounded down) at each end, average the rest. A level jump is one or a few
// steps far from the others, so it lands in a set-aside quarter wherever it sits in the window, up
// or down. The cost is on the other side: a new rate far outside the old steps is also set aside
// until more than a quarter of the steps carry it (D-08 states that trade and the measurements).
//
// The level the dates start from is the caller's newer reading when there is one, else the last
// sample. Too few samples, or a rate within 2 standard errors of zero, is "no forecast".
const DAY_SECONDS = 86_400;

/** Window the Storage forecast read queries: the longest whole window inside Prometheus retention. */
export const FORECAST_WINDOW_SECONDS = 90 * DAY_SECONDS;
/**
 * Sample step of that read. The step is part of the method: the same history read at 12 hours
 * gives a different rate (D-08), so a caller passes samples at this step.
 */
export const FORECAST_STEP_SECONDS = 3 * DAY_SECONDS;
/** Share of the steps set aside at each end of the sorted list. */
export const FORECAST_TRIM_SHARE = 0.25;
/**
 * Fewer samples than this, or a shorter span, is `too_short`. 13 samples are 12 steps, the fewest
 * that set aside 3 at each end, and 3 is the widest jump in the recorded series (D-08).
 */
export const FORECAST_MIN_POINTS = 13;
export const FORECAST_MIN_SPAN_SECONDS = 36 * DAY_SECONDS;
/** |rate| at or under this many standard errors is `flat`. */
export const FORECAST_FLAT_SIGMAS = 2;

/** One free-space reading. `t` is unix seconds. */
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
  /** Null when the series is too short to give a rate. */
  rateBytesPerDay: number | null;
  /** Unix seconds, or null. */
  fullAt: number | null;
  /** Unix seconds, or null. */
  targetAt: number | null;
  /**
   * The reading the dates are measured from: the caller's newer `level` when it gave one, else the
   * last sample. The projection is the line through this point at `rateBytesPerDay`. Null only when
   * there is no reading at all.
   */
  origin: FreeSpaceSample | null;
}

function noForecast(
  reason: StorageForecastReason,
  rate: number | null,
  origin: FreeSpaceSample | null,
): StorageForecast {
  return {
    forecast: false,
    reason,
    direction: reason === 'flat' ? 'flat' : 'unknown',
    rateBytesPerDay: rate,
    fullAt: null,
    targetAt: null,
    origin,
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

/**
 * The newer of the last sample and the caller's level reading. A level that is not finite, is
 * after `now`, or is older than the last sample is ignored.
 */
function pickOrigin(
  points: readonly FreeSpaceSample[],
  level: FreeSpaceSample | null | undefined,
  now: number,
): FreeSpaceSample | null {
  const last = points.length > 0 ? points[points.length - 1]! : null;
  if (
    level != null &&
    Number.isFinite(level.t) &&
    Number.isFinite(level.freeBytes) &&
    level.t <= now &&
    (last === null || level.t >= last.t)
  ) {
    return { t: level.t, freeBytes: level.freeBytes };
  }
  return last;
}

/** Change in free bytes per day between each pair of consecutive samples. */
function stepsPerDay(points: readonly FreeSpaceSample[]): number[] {
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const days = (points[i]!.t - points[i - 1]!.t) / DAY_SECONDS;
    steps.push((points[i]!.freeBytes - points[i - 1]!.freeBytes) / days);
  }
  return steps;
}

/**
 * Interquartile mean of the steps and its standard error. With `g = floor(n × 0.25)` steps set
 * aside at each end of the sorted list, the rate is the mean of the `h = n − 2g` left. The
 * standard error is Tukey and McLaughlin's for a trimmed mean: each set-aside step is replaced by
 * the nearest kept one, and the sum of squares of that list about its mean is divided by
 * `h (h − 1)`. `steps` has at least 2 entries.
 */
function interquartileMean(steps: readonly number[]): { rate: number; standardError: number } {
  const sorted = [...steps].sort((a, b) => a - b);
  const n = sorted.length;
  const g = Math.floor(n * FORECAST_TRIM_SHARE);
  const h = n - 2 * g;
  const lowest = sorted[g]!;
  const highest = sorted[n - g - 1]!;

  let kept = 0;
  let replaced = 0;
  for (let i = 0; i < n; i++) {
    if (i >= g && i < n - g) kept += sorted[i]!;
    replaced += i < g ? lowest : i >= n - g ? highest : sorted[i]!;
  }
  const replacedMean = replaced / n;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const value = i < g ? lowest : i >= n - g ? highest : sorted[i]!;
    squares += (value - replacedMean) * (value - replacedMean);
  }
  return { rate: kept / h, standardError: Math.sqrt(squares / (h * (h - 1))) };
}

/**
 * Forecast when this free-space series reaches its target floor and when it reaches 0.
 * `now` is unix seconds. The function does not read the clock.
 */
export function forecastFreeSpace(input: {
  /** The history the rate is read from, at `FORECAST_STEP_SECONDS` spacing. */
  samples: readonly FreeSpaceSample[];
  /** Free-byte floor for the space target. Null when the array has no target. */
  targetFreeBytes: number | null;
  now: number;
  /**
   * A reading newer than the last sample, such as the live free space. The dates start from it.
   * It never enters the rate.
   */
  level?: FreeSpaceSample | null;
}): StorageForecast {
  const points = cleanSamples(input.samples, input.now);
  const origin = pickOrigin(points, input.level, input.now);
  if (origin === null || !longEnough(points)) return noForecast('too_short', null, origin);

  const { rate, standardError } = interquartileMean(stepsPerDay(points));
  if (!Number.isFinite(rate) || !Number.isFinite(standardError)) {
    return noForecast('flat', null, origin);
  }
  if (Math.abs(rate) <= FORECAST_FLAT_SIGMAS * standardError) {
    return noForecast('flat', rate, origin);
  }

  const direction: StorageForecastDirection = rate < 0 ? 'filling' : 'draining';
  const crossing = (threshold: number): number | null => {
    const days = (threshold - origin.freeBytes) / rate;
    if (!(days > 0)) return null;
    const at = origin.t + days * DAY_SECONDS;
    const rounded = Math.round(at);
    if (!(at > input.now) || rounded <= input.now) return null;
    return rounded;
  };

  // 100% is ahead only while free space is still falling and some remains.
  const fullAt = rate < 0 && origin.freeBytes > 0 ? crossing(0) : null;
  const target =
    input.targetFreeBytes != null && Number.isFinite(input.targetFreeBytes)
      ? input.targetFreeBytes
      : null;
  return {
    forecast: true,
    reason: null,
    direction,
    rateBytesPerDay: rate,
    fullAt,
    targetAt: target == null ? null : crossing(target),
    origin,
  };
}
