// DESIGN-013 D-08 — Capacity Forecast. Rising (use filling), falling (use draining), flat, too
// short, a step change, and the free-space series recorded 2026-11-13. The recorded dates are the
// hand calculation in the test comments; D-08 records the same arithmetic.
import { describe, expect, it } from 'vitest';
import { forecastFreeSpace, type FreeSpaceSample } from '../src/storage-forecast';

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

  it('fewer than 8 points is no forecast, reason too_short', () => {
    const samples = [at(0, 10e12), at(3, 9e12), at(6, 8e12)];
    const result = forecastFreeSpace({ samples, targetFreeBytes: 5e12, now: samples[2]!.t });
    expect(result).toMatchObject({
      forecast: false,
      reason: 'too_short',
      direction: 'unknown',
      rateBytesPerDay: null,
      fullAt: null,
      targetAt: null,
    });
  });

  it('a step in the last six days keeps the earlier rate and starts from the new level', () => {
    // Perfect fill of 1e12 bytes/day, then the last two samples (day 36 and 39) jump +20e12.
    // The prefix through day 33 is that line (residual σ = 0), so any departure is a step.
    // Last free bytes = 61e12 + 20e12. Days to 0 at the old rate = 81.
    const samples = series(39, (day) => 100e12 - day * 1e12);
    const origin = samples[0]!.t;
    const stepped = samples.map((sample) => {
      const day = (sample.t - origin) / DAY;
      return day >= 36 ? { ...sample, freeBytes: sample.freeBytes + 20e12 } : sample;
    });
    const last = stepped[stepped.length - 1]!;
    const result = forecastFreeSpace({ samples: stepped, targetFreeBytes: null, now: last.t });
    expect(result.direction).toBe('filling');
    expect(result.rateBytesPerDay).toBeCloseTo(-1e12, -3);
    expect(result.fullAt).toBe(last.t + 81 * DAY);
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
  // HaynesTower hand calculation (bytes = GB × 1e9; GB below are the recorded tenths ÷ 10).
  //
  // Step hold: the last sample is 2026-11-12, so the prefix is t ≤ 2026-11-06 (29 samples,
  // x = 0, 3, …, 84 days from 2026-08-14).
  //   mean x = 42 exactly.
  //   Sxx = Σ(x − 42)² = 18270 exactly (x = 3k, k = 0..28, Σ(k−14)² = 2030, ×9).
  //   y in tenths of a GB sums to 25395652; mean y = 87571.2137931035 GB.
  //   Sxy = Σ(x − 42)(y − mean y) = −3876367.5 GB·day exactly.
  //   slope = Sxy / Sxx = −3876367.5 / 18270 = −172283/812 = −212.17118226600985 GB/day
  //         = −212171182266.00986 bytes/day.
  // The 2026-11-12 sample (88140.8 GB) lies 10753.8 GB above that line, 18.83 residual
  // standard deviations (σ = 571.142758 GB), so the hold keeps this slope.
  // Days to 0 from 88140.8 GB = 88140.8 / 212.17118226600985 = 415.423051606949 days
  //   = 35892551.65884 s after 2026-11-12T00:00:00Z, which rounds to 2028-01-01T10:09:12Z.
  // A floor of 100000 GB is above 88140.8, so the target is already crossed: targetAt is null.
  // A floor of 50000 GB is still ahead: (88140.8 − 50000) / 212.17118226600985
  //   = 179.764280863463 days → 2027-05-10T18:20:34Z.
  it('HaynesTower holds the pre-step rate and predicts 100% on 2028-01-01', () => {
    const over = forecastFreeSpace({
      samples: recorded('ht'),
      targetFreeBytes: 100_000 * GB,
      now: RECORDED_AT,
    });
    expect(over.forecast).toBe(true);
    expect(over.direction).toBe('filling');
    expect(over.reason).toBeNull();
    expect(over.rateBytesPerDay).toBeCloseTo(-212_171_182_266.00986, -6);
    expect(over.fullAt).toBe(1_830_334_152);
    expect(new Date(over.fullAt! * 1000).toISOString()).toBe('2028-01-01T10:09:12.000Z');
    expect(over.targetAt).toBeNull();

    const under = forecastFreeSpace({
      samples: recorded('ht'),
      targetFreeBytes: 50_000 * GB,
      now: RECORDED_AT,
    });
    expect(under.rateBytesPerDay).toBeCloseTo(-212_171_182_266.00986, -6);
    expect(under.fullAt).toBe(1_830_334_152);
    expect(under.targetAt).toBe(1_809_973_234);
    expect(new Date(under.targetAt! * 1000).toISOString()).toBe('2027-05-10T18:20:34.000Z');
  });

  // Music hand calculation. The 2026-11-12 sample is 2.21σ from the line fitted through
  // 2026-11-06, under the 4σ hold, so the slope is the full 31-point fit.
  //   x = 0, 3, …, 90 days from 2026-08-14. mean x = 45. Sxx = 22320 exactly.
  //   Sxy = −2164976.1 GB·day. slope = −2164976.1 / 22320 = −2405529/24800
  //        = −96.9971370967742 GB/day = −96997137096.7742 bytes/day.
  // Days to 0 from 110378.8 GB = 110378.8 / 96.9971370967742 = 1137.95935945898 days
  //   = 98319688.657 s after 2026-11-12T00:00:00Z → 2029-12-23T23:01:29Z.
  // No target is set, so there is no target date.
  it('the music array uses the full-window rate and predicts 100% on 2029-12-23', () => {
    const result = forecastFreeSpace({
      samples: recorded('mu'),
      targetFreeBytes: null,
      now: RECORDED_AT,
    });
    expect(result.forecast).toBe(true);
    expect(result.direction).toBe('filling');
    expect(result.rateBytesPerDay).toBeCloseTo(-96_997_137_096.7742, -6);
    expect(result.fullAt).toBe(1_892_761_289);
    expect(new Date(result.fullAt! * 1000).toISOString()).toBe('2029-12-23T23:01:29.000Z');
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
 * One standard error of the rate on the recorded series, 38.2 GB/day (D-08). A rate inside it cannot
 * be told from sampling noise; a rate outside it is wrong.
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
});
