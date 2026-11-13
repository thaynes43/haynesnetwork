// DESIGN-013 D-08 — Capacity Forecast. Rising (use filling), falling (use draining), flat, too
// short; level jumps up and down, one and several, at the start, the end and the middle of the
// window; a real change of rate; a newer level reading; and the free-space series recorded
// 2026-11-13, alone and continued past its rise. The recorded dates are the hand calculation in the
// test comments; D-08 records the same arithmetic.
import { describe, expect, it } from 'vitest';
import {
  FORECAST_MIN_POINTS,
  FORECAST_MIN_SPAN_SECONDS,
  forecastFreeSpace,
  type FreeSpaceSample,
} from '../src/storage-forecast';

const DAY = 86_400;
/** 1e9 bytes, the unit of the recorded series. */
const GB = 1_000_000_000;

function at(day: number, freeBytes: number, origin = 0): FreeSpaceSample {
  return { t: origin + day * DAY, freeBytes };
}

/** Every 3 days from day 0 through `lastDay`, free bytes `freeAt(day)`. */
function series(
  lastDay: number,
  freeAt: (day: number) => number,
  origin = 1_700_000_000,
): FreeSpaceSample[] {
  const out: FreeSpaceSample[] = [];
  for (let day = 0; day <= lastDay; day += 3) out.push(at(day, freeAt(day), origin));
  return out;
}

/**
 * 31 samples over 90 days (the read's window): free space starts at `start` and changes by
 * `perDay(i)` bytes per day across step `i` (0..29), plus `jump(i)` bytes landing inside step `i`.
 */
function stepped(
  start: number,
  perDay: (step: number) => number,
  jump: (step: number) => number = () => 0,
): FreeSpaceSample[] {
  const out: FreeSpaceSample[] = [at(0, start, 1_700_000_000)];
  let free = start;
  for (let step = 0; step < 30; step++) {
    free += perDay(step) * 3 + jump(step);
    out.push(at((step + 1) * 3, free, 1_700_000_000));
  }
  return out;
}

function forecastOf(samples: FreeSpaceSample[], targetFreeBytes: number | null = null) {
  return forecastFreeSpace({ samples, targetFreeBytes, now: samples[samples.length - 1]!.t });
}

describe('forecastFreeSpace', () => {
  it('use rising, still under the target: dates for the target floor and for 100%', () => {
    // Free falls by exactly 1e12 bytes/day from 100e12. Last day 39 → 61e12 free.
    // Floor 40e12 is still below that (under the used-percent target).
    const samples = series(39, (day) => 100e12 - day * 1e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: 40e12, now: last.t });
    expect(result.forecast).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.direction).toBe('filling');
    expect(result.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(result.targetAt).toBe(last.t + 21 * DAY); // (61e12 − 40e12) / 1e12
    expect(result.fullAt).toBe(last.t + 61 * DAY);
    expect(result.origin).toEqual(last); // with no newer level, the dates start from the last sample
  });

  it('use rising and already over the target: a 100% date and no target date', () => {
    const samples = series(39, (day) => 100e12 - day * 1e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: 80e12, now: last.t });
    expect(result.direction).toBe('filling');
    expect(result.fullAt).toBe(last.t + 61 * DAY);
    expect(result.targetAt).toBeNull();
  });

  it('an array with no target, use rising: the 100% date only', () => {
    const samples = series(39, (day) => 100e12 - day * 1e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: null, now: last.t });
    expect(result.fullAt).toBe(last.t + 61 * DAY);
    expect(result.targetAt).toBeNull();
  });

  it('use falling and over the target: the date free space climbs back to the floor, and no 100% date', () => {
    // Free rises by 1e12/day from 10e12. Last day 39 → 49e12, still under an 80e12 floor.
    const samples = series(39, (day) => 10e12 + day * 1e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: 80e12, now: last.t });
    expect(result.forecast).toBe(true);
    expect(result.direction).toBe('draining');
    expect(result.rateBytesPerDay).toBeCloseTo(1e12, -3);
    expect(result.targetAt).toBe(last.t + 31 * DAY); // (80e12 − 49e12) / 1e12
    expect(result.fullAt).toBeNull();
  });

  it('use falling and already under the target: a rate, and no date in front of the trend', () => {
    const samples = series(39, (day) => 50e12 + day * 1e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: 40e12, now: last.t });
    expect(result.forecast).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.direction).toBe('draining');
    expect(result.fullAt).toBeNull();
    expect(result.targetAt).toBeNull();
  });

  it('a flat series is no forecast, reason flat', () => {
    const samples = series(39, () => 50e12);
    const last = samples[samples.length - 1]!;
    const result = forecastFreeSpace({ samples, targetFreeBytes: 40e12, now: last.t });
    expect(result.forecast).toBe(false);
    expect(result.reason).toBe('flat');
    expect(result.direction).toBe('flat');
    expect(result.rateBytesPerDay).toBeCloseTo(0, 5);
    expect(result.fullAt).toBeNull();
    expect(result.targetAt).toBeNull();
  });

  it('a noisy series whose rate is within 2 standard errors of zero is flat; outside, it is a trend', () => {
    // Steps alternate between (d − 1e12) and (d + 1e12) bytes/day, 15 of each. The middle 16 of the
    // sorted steps are 8 of each, so the rate is d. Replacing the set-aside steps by the nearest
    // kept one leaves the same two values: sum of squares 30 × (1e12)², standard error
    // √(30 / (16 × 15)) × 1e12 = 0.3536e12, and the flat cut is 2 × that = 0.7071e12 bytes/day.
    const noisy = (d: number) => stepped(500e12, (step) => d + (step % 2 === 0 ? -1e12 : 1e12));

    const inside = forecastOf(noisy(0.5e12));
    expect(inside.forecast).toBe(false);
    expect(inside.reason).toBe('flat');
    expect(inside.direction).toBe('flat');
    expect(inside.rateBytesPerDay).toBeCloseTo(0.5e12, -3);
    expect(inside.fullAt).toBeNull();

    const outside = forecastOf(noisy(-1e12));
    expect(outside.forecast).toBe(true);
    expect(outside.direction).toBe('filling');
    expect(outside.rateBytesPerDay).toBeCloseTo(-1e12, -3);
  });

  it('a few points is no forecast, reason too_short, and still names the latest reading', () => {
    const samples = [at(0, 10e12), at(3, 9e12), at(6, 8e12)];
    const result = forecastFreeSpace({ samples, targetFreeBytes: 5e12, now: samples[2]!.t });
    expect(result).toMatchObject({
      forecast: false,
      reason: 'too_short',
      direction: 'unknown',
      rateBytesPerDay: null,
      fullAt: null,
      targetAt: null,
      origin: samples[2],
    });
    expect(forecastFreeSpace({ samples: [], targetFreeBytes: null, now: 0 }).origin).toBeNull();
  });

  it('needs 13 samples over 36 days: 12 steps, the fewest that set aside 3 at each end', () => {
    expect(FORECAST_MIN_POINTS).toBe(13);
    expect(FORECAST_MIN_SPAN_SECONDS).toBe(36 * DAY);
    const fill = (day: number) => 100e12 - day * 1e12;

    const twelve = series(33, fill); // 12 samples, 33 days
    expect(twelve).toHaveLength(12);
    expect(forecastOf(twelve).reason).toBe('too_short');

    const thirteen = series(36, fill); // 13 samples, 36 days
    expect(thirteen).toHaveLength(13);
    expect(forecastOf(thirteen).forecast).toBe(true);

    // Enough samples, too little time: 14 samples half a day apart cover 6.5 days.
    const dense = Array.from({ length: 14 }, (_, i) => at(i / 2, fill(i / 2), 1_700_000_000));
    expect(forecastOf(dense).reason).toBe('too_short');
  });

  it('a missing sample changes nothing: each step is a change per day', () => {
    const samples = series(90, (day) => 400e12 - day * 1e12);
    const gapped = samples.filter((_, i) => i !== 12 && i !== 13); // one step now spans 9 days
    const result = forecastOf(gapped);
    expect(result.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(result.fullAt).toBe(gapped[gapped.length - 1]!.t + 310 * DAY);
  });

  it('ignores a sample after now, and omits a crossing that is already past', () => {
    const samples = series(39, (day) => 100e12 - day * 1e12);
    const last = samples[samples.length - 1]!;
    const withFuture = [...samples, { t: last.t + 12 * DAY, freeBytes: 200e12 }];
    const held = forecastFreeSpace({ samples: withFuture, targetFreeBytes: null, now: last.t });
    expect(held.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(held.fullAt).toBe(last.t + 61 * DAY);

    const later = forecastFreeSpace({
      samples,
      targetFreeBytes: null,
      now: last.t + 200 * DAY,
    });
    expect(later.forecast).toBe(true);
    expect(later.fullAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Level jumps and a real change of rate, on series with no noise so every number is exact.
// 30 steps: 7 are set aside at each end of the sorted list and the middle 16 are averaged.
// ---------------------------------------------------------------------------------------------------

describe('forecastFreeSpace — level jumps anywhere in the window', () => {
  const FILL = -1e12; // bytes/day
  const fill = () => FILL;

  it('a jump up in the last step keeps the rate and starts from the new level', () => {
    const samples = stepped(400e12, fill, (step) => (step === 29 ? 20e12 : 0));
    const last = samples[samples.length - 1]!;
    expect(last.freeBytes).toBe(400e12 - 90e12 + 20e12);
    const result = forecastOf(samples);
    expect(result.direction).toBe('filling');
    expect(result.rateBytesPerDay).toBeCloseTo(FILL, -3);
    expect(result.fullAt).toBe(last.t + 330 * DAY);
    expect(result.origin).toEqual(last);
  });

  it('holds the same rate wherever one jump up sits: first step, middle, last step', () => {
    for (let where = 0; where < 30; where++) {
      const samples = stepped(400e12, fill, (step) => (step === where ? 20e12 : 0));
      const result = forecastOf(samples);
      expect(result.rateBytesPerDay).toBeCloseTo(FILL, -3);
      expect(result.fullAt).toBe(samples[samples.length - 1]!.t + 330 * DAY);
    }
  });

  it('a jump down keeps the rate: in one step, and spread over three', () => {
    for (let where = 0; where < 30; where++) {
      const samples = stepped(400e12, fill, (step) => (step === where ? -30e12 : 0));
      const result = forecastOf(samples);
      expect(result.rateBytesPerDay).toBeCloseTo(FILL, -3);
      expect(result.fullAt).toBe(samples[samples.length - 1]!.t + 280 * DAY);
    }
    // The shape of the recorded music fall: three consecutive steps, largest first.
    const spread = [-18e12, -9e12, -3e12];
    const samples = stepped(400e12, fill, (step) => spread[step - 14] ?? 0);
    const result = forecastOf(samples);
    expect(result.rateBytesPerDay).toBeCloseTo(FILL, -3);
    expect(result.fullAt).toBe(samples[samples.length - 1]!.t + 280 * DAY);
  });

  it('two jumps, one up and one down, keep the rate', () => {
    const samples = stepped(400e12, fill, (step) =>
      step === 9 ? 20e12 : step === 19 ? -50e12 : 0,
    );
    const result = forecastOf(samples);
    expect(result.rateBytesPerDay).toBeCloseTo(FILL, -3);
    expect(result.fullAt).toBe(samples[samples.length - 1]!.t + 280 * DAY);
  });

  it('seven jumps one way are set aside; the eighth reaches the rate', () => {
    // Jumps of +3e12 bytes on every fourth step. A jumped step is (−3e12 + 3e12) / 3 = 0 bytes/day.
    const jumped = (count: number) =>
      stepped(400e12, fill, (step) => (step % 4 === 1 && step < count * 4 ? 3e12 : 0));

    expect(forecastOf(jumped(7)).rateBytesPerDay).toBeCloseTo(FILL, -3);
    // Eight: one jumped step is inside the middle 16. (15 × −1e12 + 0) / 16 = −0.9375e12.
    const eight = forecastOf(jumped(8));
    expect(eight.forecast).toBe(true);
    expect(eight.rateBytesPerDay).toBeCloseTo(-0.9375e12, -3);
  });

  it('a jump the rate ignores still moves both dates, through the level', () => {
    const before = forecastOf(stepped(400e12, fill), 200e12);
    const after = forecastOf(
      stepped(400e12, fill, (step) => (step === 20 ? 40e12 : 0)),
      200e12,
    );
    expect(after.rateBytesPerDay).toBeCloseTo(before.rateBytesPerDay!, -3);
    expect(after.fullAt! - before.fullAt!).toBe(40 * DAY);
    expect(after.targetAt! - before.targetAt!).toBe(40 * DAY);
  });
});

describe('forecastFreeSpace — a real change of rate', () => {
  // The fill triples, from −1e12 to −3e12 bytes/day, for the last `m` of 30 steps. The new steps
  // are all below the old ones, so they fill the low end of the sorted list first.
  const changed = (m: number) => stepped(900e12, (step) => (step >= 30 - m ? -3e12 : -1e12));
  const rate = (m: number) => forecastOf(changed(m)).rateBytesPerDay!;

  it('holds a new rate for 7 samples, follows from the 8th, is halfway at the 15th and there at the 23rd', () => {
    for (let m = 0; m <= 7; m++) expect(rate(m)).toBeCloseTo(-1e12, -3);
    expect(rate(8)).toBeCloseTo(-1.125e12, -3); // (15 × −1e12 + 1 × −3e12) / 16
    expect(rate(15)).toBeCloseTo(-2e12, -3); // (8 × −1e12 + 8 × −3e12) / 16
    expect(rate(22)).toBeCloseTo(-2.875e12, -3); // (1 × −1e12 + 15 × −3e12) / 16
    for (let m = 23; m <= 30; m++) expect(rate(m)).toBeCloseTo(-3e12, -3);
  });

  it('moves toward the new rate with every sample from the 8th on, never away from it', () => {
    for (let m = 8; m <= 23; m++) expect(rate(m)).toBeLessThan(rate(m - 1));
  });

  it('a fill that turns into a drain: flat at the turn, then a date for the floor and no 100% date', () => {
    // Use falls by 2e12 bytes/day for the last `m` steps after rising by 1e12.
    const turned = (m: number) => stepped(100e12, (step) => (step >= 30 - m ? 2e12 : -1e12));

    const early = forecastOf(turned(7), 200e12);
    expect(early.direction).toBe('filling');
    expect(early.rateBytesPerDay).toBeCloseTo(-1e12, -3);

    // 12 new steps: 5 of the middle 16 are +2e12 and 11 are −1e12, a rate of −0.0625e12. Replacing
    // the set-aside steps leaves 12 at +2e12 and 18 at −1e12: sum of squares 64.8e24, standard
    // error √(64.8 / 240) × 1e12 = 0.52e12. The rate is inside 2 of those: flat.
    const turning = forecastOf(turned(12), 200e12);
    expect(turning.reason).toBe('flat');
    expect(turning.rateBytesPerDay).toBeCloseTo(-0.0625e12, -3);

    // 23 new steps: the middle 16 are all +2e12. Free space is 100e12 − 21e12 + 138e12 = 217e12,
    // above a 200e12 floor: no date. Against a 300e12 floor: (300e12 − 217e12) / 2e12 = 41.5 days.
    const late = forecastOf(turned(23), 300e12);
    expect(late.direction).toBe('draining');
    expect(late.rateBytesPerDay).toBeCloseTo(2e12, -3);
    expect(late.fullAt).toBeNull();
    expect(late.targetAt).toBe(late.origin!.t + 41.5 * DAY);
    expect(forecastOf(turned(23), 200e12).targetAt).toBeNull();
  });
});

describe('forecastFreeSpace — a newer level reading', () => {
  const samples = series(90, (day) => 400e12 - day * 1e12);
  const last = samples[samples.length - 1]!; // 310e12 free
  const now = last.t + 2 * DAY;

  it('measures both dates from the level and leaves the rate alone', () => {
    const level = { t: now, freeBytes: 300e12 };
    const result = forecastFreeSpace({ samples, targetFreeBytes: 250e12, now, level });
    expect(result.origin).toEqual(level);
    expect(result.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(result.fullAt).toBe(now + 300 * DAY);
    expect(result.targetAt).toBe(now + 50 * DAY);
  });

  it('a jump that has reached the level and no sample yet moves the dates and not the rate', () => {
    const level = { t: now, freeBytes: 350e12 };
    const result = forecastFreeSpace({ samples, targetFreeBytes: null, now, level });
    expect(result.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(result.fullAt).toBe(now + 350 * DAY);
  });

  it('falls back to the last sample when the level is missing, stale, in the future or not a number', () => {
    const unusable = [
      null,
      undefined,
      { t: last.t - DAY, freeBytes: 1e12 },
      { t: now + 1, freeBytes: 1e12 },
      { t: now, freeBytes: Number.NaN },
      { t: Number.NaN, freeBytes: 1e12 },
    ];
    for (const level of unusable) {
      const result = forecastFreeSpace({ samples, targetFreeBytes: null, now, level });
      expect(result.origin).toEqual(last);
      expect(result.fullAt).toBe(last.t + 310 * DAY);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Recorded series (coordinator, 2026-11-13T16:36Z). GB values are tenths, so × 1e8 is integer bytes.
// ---------------------------------------------------------------------------------------------------

/** Tenths of a GB (1e9 bytes). Bytes = tenths × 1e8. */
const TENTH_TO_BYTES = 100_000_000;
const RECORDED_AT = Date.parse('2026-11-12T00:00:00.000Z') / 1000;

const RECORDED_ROWS: { t: string; htTenths: number; muTenths: number }[] = [
  { t: '2026-08-14T00:00:00.000Z', htTenths: 971709, muTenths: 1214118 },
  { t: '2026-08-17T00:00:00.000Z', htTenths: 964877, muTenths: 1213169 },
  { t: '2026-08-20T00:00:00.000Z', htTenths: 955346, muTenths: 1212888 },
  { t: '2026-08-23T00:00:00.000Z', htTenths: 950960, muTenths: 1209840 },
  { t: '2026-08-26T00:00:00.000Z', htTenths: 935237, muTenths: 1207060 },
  { t: '2026-08-29T00:00:00.000Z', htTenths: 925151, muTenths: 1205315 },
  { t: '2026-09-01T00:00:00.000Z', htTenths: 927166, muTenths: 1202635 },
  { t: '2026-09-04T00:00:00.000Z', htTenths: 909636, muTenths: 1202145 },
  { t: '2026-09-07T00:00:00.000Z', htTenths: 904467, muTenths: 1201366 },
  { t: '2026-09-10T00:00:00.000Z', htTenths: 900046, muTenths: 1201082 },
  { t: '2026-09-13T00:00:00.000Z', htTenths: 894423, muTenths: 1200751 },
  { t: '2026-09-16T00:00:00.000Z', htTenths: 896047, muTenths: 1200219 },
  { t: '2026-09-19T00:00:00.000Z', htTenths: 889830, muTenths: 1199279 },
  { t: '2026-09-22T00:00:00.000Z', htTenths: 886365, muTenths: 1198476 },
  { t: '2026-09-25T00:00:00.000Z', htTenths: 879700, muTenths: 1198674 },
  { t: '2026-09-28T00:00:00.000Z', htTenths: 868257, muTenths: 1196101 },
  { t: '2026-10-01T00:00:00.000Z', htTenths: 864984, muTenths: 1205684 },
  { t: '2026-10-04T00:00:00.000Z', htTenths: 854667, muTenths: 1206496 },
  { t: '2026-10-07T00:00:00.000Z', htTenths: 856544, muTenths: 1204688 },
  { t: '2026-10-10T00:00:00.000Z', htTenths: 844281, muTenths: 1202451 },
  { t: '2026-10-13T00:00:00.000Z', htTenths: 847110, muTenths: 1200624 },
  { t: '2026-10-16T00:00:00.000Z', htTenths: 839418, muTenths: 1200007 },
  { t: '2026-10-19T00:00:00.000Z', htTenths: 829209, muTenths: 1197603 },
  { t: '2026-10-22T00:00:00.000Z', htTenths: 820475, muTenths: 1197175 },
  { t: '2026-10-25T00:00:00.000Z', htTenths: 809325, muTenths: 1194347 },
  { t: '2026-10-28T00:00:00.000Z', htTenths: 801983, muTenths: 1206545 },
  { t: '2026-10-31T00:00:00.000Z', htTenths: 800667, muTenths: 1137950 },
  { t: '2026-11-03T00:00:00.000Z', htTenths: 785002, muTenths: 1099512 },
  { t: '2026-11-06T00:00:00.000Z', htTenths: 782770, muTenths: 1087678 },
  { t: '2026-11-09T00:00:00.000Z', htTenths: 801383, muTenths: 1087277 },
  { t: '2026-11-12T00:00:00.000Z', htTenths: 881408, muTenths: 1103788 },
];

function recorded(which: 'ht' | 'mu'): FreeSpaceSample[] {
  return RECORDED_ROWS.map((row) => ({
    t: Date.parse(row.t) / 1000,
    freeBytes: (which === 'ht' ? row.htTenths : row.muTenths) * TENTH_TO_BYTES,
  }));
}

describe('forecastFreeSpace — recorded 2026-11-13 series', () => {
  // HaynesTower hand calculation (GB = 1e9 bytes; a step is one sample minus the one before, GB per
  // 3 days). The 30 steps, sorted:
  //   −1753.0 −1572.3 −1566.5 −1226.3 −1144.3 −1115.0 −1031.7            ← 7 set aside
  //   −1020.9 −1008.6 −953.1 −873.4 −769.2 −734.2 −683.2 −666.5
  //   −621.7 −562.3 −516.9 −442.1 −438.6 −346.5 −327.3 −223.2            ← the middle 16
  //   −131.6 +162.4 +187.7 +201.5 +282.9 +1861.3 +8002.5                 ← 7 set aside
  // The rise of 2026-11-06..12 is the last two, +1861.3 and +8002.5.
  //   Sum of the middle 16 = −10187.7 GB. Mean = −636.73125 GB per 3 days.
  //   Rate = −636.73125 / 3 = −212.24375 GB/day = −212243750000 bytes/day.
  // Days to 0 from 88140.8 GB = 88140.8 / 212.24375 = 415.281015342 days
  //   = 35880279.7256 s after 2026-11-12T00:00:00Z (unix 1794441600), which rounds to
  //   unix 1830321880 = 2028-01-01T06:44:40Z.
  // A floor of 100000 GB is above 88140.8, so the target is already crossed: targetAt is null.
  // A floor of 50000 GB is still ahead: (88140.8 − 50000) / 212.24375 = 179.702818104 days
  //   → unix 1809967923 = 2027-05-10T16:52:03Z.
  it('HaynesTower sets the rise aside and predicts 100% on 2028-01-01', () => {
    const over = forecastFreeSpace({
      samples: recorded('ht'),
      targetFreeBytes: 100_000 * GB,
      now: RECORDED_AT,
    });
    expect(over.forecast).toBe(true);
    expect(over.direction).toBe('filling');
    expect(over.reason).toBeNull();
    expect(over.rateBytesPerDay).toBeCloseTo(-212_243_750_000, -2);
    expect(over.fullAt).toBe(1_830_321_880);
    expect(new Date(over.fullAt! * 1000).toISOString()).toBe('2028-01-01T06:44:40.000Z');
    expect(over.targetAt).toBeNull();
    expect(over.origin).toEqual({ t: RECORDED_AT, freeBytes: 881_408 * TENTH_TO_BYTES });

    const under = forecastFreeSpace({
      samples: recorded('ht'),
      targetFreeBytes: 50_000 * GB,
      now: RECORDED_AT,
    });
    expect(under.rateBytesPerDay).toBeCloseTo(-212_243_750_000, -2);
    expect(under.fullAt).toBe(1_830_321_880);
    expect(under.targetAt).toBe(1_809_967_923);
    expect(new Date(under.targetAt! * 1000).toISOString()).toBe('2027-05-10T16:52:03.000Z');
  });

  // The same rate from the level measured at the 12-hour step on 2026-11-13T12:00Z, 87603.3 GB
  // (36 hours after the last 3-day sample, 537.5 GB lower).
  //   Days to 0 = 87603.3 / 212.24375 = 412.748549722 → unix 1830232675 = 2027-12-31T05:57:55Z.
  //   Days to a 50000 GB floor = 37603.3 / 212.24375 = 177.170352484 → unix 1809878718.
  it('HaynesTower measured from the level of 2026-11-13T12:00Z predicts 100% on 2027-12-31', () => {
    const now = RECORDED_AT + 36 * 3600;
    const level = { t: now, freeBytes: 876_033 * TENTH_TO_BYTES };
    const result = forecastFreeSpace({
      samples: recorded('ht'),
      targetFreeBytes: 50_000 * GB,
      now,
      level,
    });
    expect(result.rateBytesPerDay).toBeCloseTo(-212_243_750_000, -2);
    expect(result.origin).toEqual(level);
    expect(result.fullAt).toBe(1_830_232_675);
    expect(new Date(result.fullAt! * 1000).toISOString()).toBe('2027-12-31T05:57:55.000Z');
    expect(result.targetAt).toBe(1_809_878_718);
  });

  // Music hand calculation. The 30 steps, sorted (GB per 3 days):
  //   −6859.5 −3843.8 −1183.4 −304.8 −282.8 −278.0 −268.0                ← 7 set aside
  //   −257.3 −240.4 −223.7 −182.7 −180.8 −174.5 −94.9 −94.0
  //   −80.3 −77.9 −61.7 −53.2 −49.0 −42.8 −40.1 −33.1                    ← the middle 16
  //   −28.4 −28.1 +19.8 +81.2 +958.3 +1219.8 +1651.1                     ← 7 set aside
  // The fall of 2026-10-28..11-06 is the first three; three rises are the last three.
  //   Sum of the middle 16 = −1886.4 GB. Mean = −117.9 GB per 3 days. Rate = −39.3 GB/day.
  // Days to 0 from 110378.8 GB = 110378.8 / 39.3 = 2808.62086514 days
  //   → unix 2037106443 = 2034-07-21T14:54:03Z. No target is set, so there is no target date.
  it('the music array sets its fall and its rises aside and predicts 100% on 2034-07-21', () => {
    const result = forecastFreeSpace({
      samples: recorded('mu'),
      targetFreeBytes: null,
      now: RECORDED_AT,
    });
    expect(result.forecast).toBe(true);
    expect(result.direction).toBe('filling');
    expect(result.rateBytesPerDay).toBeCloseTo(-39_300_000_000, -2);
    expect(result.fullAt).toBe(2_037_106_443);
    expect(new Date(result.fullAt! * 1000).toISOString()).toBe('2034-07-21T14:54:03.000Z');
    expect(result.targetAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// The recorded HaynesTower series continued at its own pre-jump rate (the coordinator's defect table,
// story 834 comment 8018). Every later sample lies on one line from the 2026-11-12 level, so the true
// rate and the true 100% date never change. Only the age of the 2026-11-06..12 rise changes.
// ---------------------------------------------------------------------------------------------------

/** Least-squares rate of the 29 samples through 2026-11-06, before the rise: −172283/812 GB/day. */
const PRE_JUMP_RATE = (-172_283 / 812) * GB;
/**
 * One standard error of the rate on the recorded series, 38.2 GB/day or 18% (D-08: the formula
 * gives 38.18, and resampling the 12-hour history gives a spread of 37.8). A rate inside it cannot
 * be told from sampling noise; a rate outside it is wrong. The method this replaced reached
 * 170.1 GB/day, 4.5 of them.
 */
const RATE_TOLERANCE = 38.2 * GB;

/** The 90 days ending `steps` samples after 2026-11-12, as the read would query them. */
function continued(steps: number): FreeSpaceSample[] {
  const base = recorded('ht');
  const last = base[base.length - 1]!;
  const out = [...base];
  for (let i = 1; i <= steps; i++) {
    out.push({ t: last.t + i * 3 * DAY, freeBytes: last.freeBytes + PRE_JUMP_RATE * 3 * i });
  }
  const end = out[out.length - 1]!.t;
  return out.filter((sample) => sample.t >= end - 90 * DAY);
}

describe('forecastFreeSpace — the recorded rise as it ages through the window', () => {
  it('keeps the rate within one standard error at every sample for 180 days after the rise', () => {
    const offenders: { daysAfter: number; gbPerDay: number }[] = [];
    for (let steps = 0; steps <= 60; steps++) {
      const samples = continued(steps);
      const result = forecastFreeSpace({
        samples,
        targetFreeBytes: null,
        now: samples[samples.length - 1]!.t,
      });
      const rate = result.rateBytesPerDay ?? Number.NaN;
      if (!(Math.abs(rate - PRE_JUMP_RATE) <= RATE_TOLERANCE)) {
        offenders.push({ daysAfter: steps * 3, gbPerDay: Math.round((rate / GB) * 10) / 10 });
      }
    }
    expect(offenders).toEqual([]);
  });

  // The coordinator's rows, plus the two extremes (days 15 and 39). The true rate is −212.17 GB/day
  // and the true 100% day is 2028-01-01. What moves the rate is which recorded steps are still in
  // the window, not the rise: the worst row is 19.1 GB/day off (9.0%, half a standard error). From
  // day 51 the continued steps fill the middle 16 and the rate is exact.
  it('reports these rates and 100% days as the rise ages', () => {
    const expected: [daysAfter: number, gbPerDay: number, fullDay: string][] = [
      [0, -212.244, '2028-01-01'],
      [3, -211.271, '2028-01-03'],
      [6, -204.676, '2028-01-16'],
      [9, -208.799, '2028-01-07'],
      [15, -193.039, '2028-02-10'],
      [18, -201.65, '2028-01-22'],
      [30, -204.803, '2028-01-15'],
      [39, -217.595, '2027-12-23'],
      [42, -216.971, '2027-12-24'],
      [51, -212.171, '2028-01-01'],
      [66, -212.171, '2028-01-01'],
      [90, -212.171, '2028-01-01'],
      [180, -212.171, '2028-01-01'],
    ];
    for (const [daysAfter, gbPerDay, fullDay] of expected) {
      const samples = continued(daysAfter / 3);
      const result = forecastFreeSpace({
        samples,
        targetFreeBytes: null,
        now: samples[samples.length - 1]!.t,
      });
      expect(result.direction).toBe('filling');
      expect(result.rateBytesPerDay! / GB).toBeCloseTo(gbPerDay, 2);
      expect(new Date(result.fullAt! * 1000).toISOString().slice(0, 10)).toBe(fullDay);
    }
  });
});
