// DESIGN-013 D-09 (story 819) — `forecastJumps`: the jumps in the history that the forecast's rate
// set aside, which the Storage page states beside the plot. Pure, no database. Proves:
//   • on the series recorded 2026-11-13 it names exactly the eight steps D-08 counted as jumps
//     (HaynesTower: two rises; music: three falls and three rises) with their plain byte totals;
//   • a perfectly regular series (deviation zero) does not name its rounding as a jump;
//   • a far step in which free space did not move that way (a slowdown) is not named;
//   • more far steps one way than the method sets aside there is reported as partly counted;
//   • with no projection (flat, too short) there is nothing to qualify.
import { describe, expect, it } from 'vitest';
import { forecastFreeSpace, FORECAST_STEP_SECONDS, FORECAST_TRIM_SHARE } from '@hnet/domain';
import { FORECAST_JUMP_DEVIATIONS, forecastJumps } from '../src/storage-forecast';
import type { TrendPoint } from '../src/storage-trend';

const GB = 1_000_000_000;
/** Tenths of a GB (1e9 bytes), the unit of the recorded series: bytes = tenths × 1e8. */
const TENTH = 100_000_000;
const RECORDED_AT = Date.parse('2026-11-12T00:00:00.000Z') / 1000;

/** The 3-day series the coordinator recorded 2026-11-13T16:36Z (D-08), oldest first, in tenths of a GB. */
const RECORDED_HT = [
  971709, 964877, 955346, 950960, 935237, 925151, 927166, 909636, 904467, 900046, 894423, 896047,
  889830, 886365, 879700, 868257, 864984, 854667, 856544, 844281, 847110, 839418, 829209, 820475,
  809325, 801983, 800667, 785002, 782770, 801383, 881408,
];
const RECORDED_MU = [
  1214118, 1213169, 1212888, 1209840, 1207060, 1205315, 1202635, 1202145, 1201366, 1201082, 1200751,
  1200219, 1199279, 1198476, 1198674, 1196101, 1205684, 1206496, 1204688, 1202451, 1200624, 1200007,
  1197603, 1197175, 1194347, 1206545, 1137950, 1099512, 1087678, 1087277, 1103788,
];

function recorded(tenths: readonly number[]): TrendPoint[] {
  return tenths.map((v, i) => ({
    t: RECORDED_AT - (tenths.length - 1 - i) * FORECAST_STEP_SECONDS,
    freeBytes: v * TENTH,
  }));
}

function jumpsOf(points: TrendPoint[]) {
  const forecast = forecastFreeSpace({ samples: points, targetFreeBytes: null, now: RECORDED_AT });
  return { forecast, jumps: forecastJumps(points, forecast) };
}

/** A series on the 3-day grid from per-step changes in GB, ending at `endGb`. */
function fromSteps(stepsGb: readonly number[], endGb: number): TrendPoint[] {
  const total = stepsGb.reduce((a, b) => a + b, 0);
  let level = endGb - total;
  const points: TrendPoint[] = [
    { t: RECORDED_AT - stepsGb.length * FORECAST_STEP_SECONDS, freeBytes: level * GB },
  ];
  stepsGb.forEach((step, i) => {
    level += step;
    points.push({
      t: RECORDED_AT - (stepsGb.length - 1 - i) * FORECAST_STEP_SECONDS,
      freeBytes: Math.round(level * GB),
    });
  });
  return points;
}

describe('forecastJumps — the recorded 2026-11-13 series', () => {
  it('HaynesTower: the two rises D-08 lists (+1861.3 and +8002.5 GB), nothing else', () => {
    const { forecast, jumps } = jumpsOf(recorded(RECORDED_HT));
    expect(forecast.rateBytesPerDay! / GB).toBeCloseTo(-212.24375, 5); // the D-08 hand calculation
    // 801383 − 782770 = 18613 tenths (+1861.3 GB); 881408 − 801383 = 80025 tenths (+8002.5 GB).
    expect(jumps).toEqual({
      rises: { count: 2, bytes: (18613 + 80025) * TENTH },
      falls: { count: 0, bytes: 0 },
      latestAt: RECORDED_AT,
      partlyCounted: false,
    });
    expect(jumps!.rises.bytes / GB).toBeCloseTo(9863.8, 6);
  });

  it('music: the three falls and three rises D-08 lists', () => {
    const { forecast, jumps } = jumpsOf(recorded(RECORDED_MU));
    expect(forecast.rateBytesPerDay! / GB).toBeCloseTo(-39.3, 6);
    // Falls −6859.5, −3843.8, −1183.4 GB = 11886.7; rises +958.3, +1219.8, +1651.1 GB = 3829.2.
    expect(jumps).toEqual({
      rises: { count: 3, bytes: (9583 + 12198 + 16511) * TENTH },
      falls: { count: 3, bytes: (68595 + 38438 + 11834) * TENTH },
      latestAt: RECORDED_AT,
      partlyCounted: false,
    });
    expect(jumps!.falls.bytes / GB).toBeCloseTo(11886.7, 6);
    expect(jumps!.rises.bytes / GB).toBeCloseTo(3829.2, 6);
  });
});

describe('forecastJumps — the rule', () => {
  it('uses the D-08 measure (3 scaled median deviations) and the method’s own trim share', () => {
    expect(FORECAST_JUMP_DEVIATIONS).toBe(3);
    expect(Math.floor(30 * FORECAST_TRIM_SHARE)).toBe(7);
  });

  it('a perfectly regular series names nothing, even when rounding wobbles a step by a byte', () => {
    const steady = fromSteps(Array<number>(30).fill(-250), 100_000);
    expect(jumpsOf(steady).jumps).toBeNull();

    // More than half the steps identical ⇒ the deviation is zero and every other step is "far".
    // A 2-byte wobble is far below one day of the rate, so it is not a jump.
    const wobbly = steady.map((p, i) => (i % 5 === 0 ? { ...p, freeBytes: p.freeBytes + 1 } : p));
    const { forecast, jumps } = jumpsOf(wobbly);
    expect(forecast.forecast).toBe(true);
    expect(jumps).toBeNull();
  });

  it('one jump up on a regular fill is named with its plain change and its date', () => {
    const steps = Array<number>(30).fill(-250);
    steps[20] = 4000; // one clean-up: free space rises 4000 GB in one step
    const points = fromSteps(steps, 100_000);
    const { forecast, jumps } = jumpsOf(points);
    expect(forecast.rateBytesPerDay! / GB).toBeCloseTo(-250 / 3, 6); // the jump is not in the rate
    expect(jumps).toEqual({
      rises: { count: 1, bytes: 4000 * GB },
      falls: { count: 0, bytes: 0 },
      latestAt: points[21]!.t,
      partlyCounted: false,
    });
  });

  it('a jump smaller than one day of the rate is not named', () => {
    const steps = Array<number>(30).fill(-300); // 100 GB a day
    steps[10] = -390; // 90 GB past the usual step: under one day of the rate
    expect(jumpsOf(fromSteps(steps, 100_000)).jumps).toBeNull();
    steps[10] = -420; // 120 GB past the usual step: more than one day of the rate
    expect(jumpsOf(fromSteps(steps, 100_000)).jumps).toMatchObject({
      falls: { count: 1, bytes: 420 * GB },
      rises: { count: 0, bytes: 0 },
    });
  });

  it('a far step in which free space did not rise (the fill only slowed) is not named', () => {
    const steps = Array<number>(30).fill(-600);
    steps[12] = -100; // far above the usual step, and still a fall
    expect(jumpsOf(fromSteps(steps, 100_000)).jumps).toBeNull();
  });

  it('more rises than the method sets aside are reported as partly counted', () => {
    const steps = Array<number>(30).fill(-600);
    for (const i of [1, 4, 8, 12, 16, 20, 24]) steps[i] = 3000; // seven rises: all set aside
    steps[28] = 100; // an eighth, smaller rise: the method sets aside seven, so this one is in the rate
    const { forecast, jumps } = jumpsOf(fromSteps(steps, 100_000));
    // Middle 16 = fifteen × −600 and the +100: −8900 / 16 / 3 = −185.4 GB/day, not −200.
    expect(forecast.rateBytesPerDay! / GB).toBeCloseTo(-8900 / 16 / 3, 6);
    expect(jumps).toMatchObject({
      rises: { count: 8, bytes: (7 * 3000 + 100) * GB },
      partlyCounted: true,
    });

    steps[28] = -600; // seven: all set aside
    const seven = jumpsOf(fromSteps(steps, 100_000));
    expect(seven.forecast.rateBytesPerDay! / GB).toBeCloseTo(-200, 6);
    expect(seven.jumps).toMatchObject({ rises: { count: 7 }, partlyCounted: false });
  });

  it('says nothing when there is no projection to qualify', () => {
    const short = fromSteps([-250, 4000, -250], 100_000);
    const tooShort = jumpsOf(short);
    expect(tooShort.forecast).toMatchObject({ forecast: false, reason: 'too_short' });
    expect(tooShort.jumps).toBeNull();

    // Noisy and level: the rate is inside two standard errors of zero.
    const flatSteps: number[] = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 300 : -300));
    flatSteps[9] = 5000;
    const flat = jumpsOf(fromSteps(flatSteps, 100_000));
    expect(flat.forecast).toMatchObject({ forecast: false, reason: 'flat' });
    expect(flat.jumps).toBeNull();
  });
});
