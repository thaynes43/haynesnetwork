// ADR-120 / DESIGN-014 D-16 — Dynamic Pace is a pure function of the disk, a free-space series,
// Trash's own recorded deletions, the save rate and the eligible pools. These tests do not boot
// a database. The setting-off path is in space-policy.test.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  DYNAMIC_PACE_CEILING_BYTES,
  DYNAMIC_PACE_FLOOR_BYTES,
  DYNAMIC_PACE_HORIZON_DAYS,
  addRecordedDeletions,
  dynamicPaceHorizonFitsWindow,
  explainDynamicPace,
  forecastFreeSpace,
  forecastQueryRange,
  readArrayFreeSpaceSamples,
  FORECAST_STEP_SECONDS,
  FORECAST_WINDOW_SECONDS,
  FREESPACE_SERIES_QUERY,
  resolveDynamicPace,
  samplesForStorageArray,
  splitPaceAsk,
  type FreeSpaceSample,
  type KindPool,
} from '../src/index';

const DAY = 86_400;
const START = 1_700_000_000;

/** 31 samples, 90 days, free bytes changing by `perDay` each day. The last sample is at START+90d. */
function series(perDay: number, base = 1_000_000_000): FreeSpaceSample[] {
  const out: FreeSpaceSample[] = [];
  for (let i = 0; i <= 30; i++) {
    out.push({ t: START + i * 3 * DAY, freeBytes: base + perDay * i * 3 });
  }
  return out;
}

const NOW = START + 90 * DAY;

function explain(over: {
  freeBytes?: number;
  totalBytes?: number;
  targetPct?: number;
  samples?: readonly FreeSpaceSample[];
  deletions?: { t: number; bytes: number }[];
  windowDays?: number;
  horizonDays?: number;
  floorBytes?: number;
  ceilingBytes?: number;
  saveRate?: number | null;
  pools?: readonly KindPool[];
}) {
  return explainDynamicPace({
    freeBytes: over.freeBytes ?? 100,
    totalBytes: over.totalBytes ?? 1_000,
    targetPct: over.targetPct ?? 80,
    samples: over.samples ?? series(-10),
    deletions: over.deletions ?? [],
    now: NOW,
    windowDays: over.windowDays ?? 7,
    horizonDays: over.horizonDays ?? 60,
    floorBytes: over.floorBytes ?? 1,
    ceilingBytes: over.ceilingBytes ?? 1_000_000,
    saveRate: over.saveRate === undefined ? null : over.saveRate,
    pools: over.pools ?? [{ mediaKind: 'movie', poolBytes: 1_000_000 }],
  });
}

describe('resolveDynamicPace', () => {
  it('ships off, with the measured horizon, floor and ceiling', () => {
    const pace = resolveDynamicPace(undefined);
    expect(pace.enabled).toBe(false);
    expect(pace.horizonDays).toBe(DYNAMIC_PACE_HORIZON_DAYS);
    expect(pace.horizonDays).toBe(30);
    expect(pace.observeOnly).toBe(false);
    expect(pace.movieMaxItems).toBe(50);
    expect(pace.floorBytes).toBe(DYNAMIC_PACE_FLOOR_BYTES);
    expect(pace.ceilingBytes).toBe(DYNAMIC_PACE_CEILING_BYTES);
    expect(resolveDynamicPace({ enabled: 'yes' }).enabled).toBe(false);
  });
});

describe('active bounds fail closed', () => {
  const valid = { enabled: true, horizonDays: 30, floorBytes: 1, ceilingBytes: 100 };
  it.each(['horizonDays', 'floorBytes', 'ceilingBytes'] as const)(
    'an unreadable %s disables sizing',
    (key) => {
      expect(resolveDynamicPace({ ...valid, [key]: 'unreadable' }).enabled).toBe(false);
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      expect(resolveDynamicPace(missing).enabled).toBe(false);
    },
  );
  it('refuses inverted or above-hard-ceiling bounds and preserves valid observation', () => {
    expect(resolveDynamicPace({ ...valid, floorBytes: 101 }).enabled).toBe(false);
    expect(
      resolveDynamicPace({ ...valid, ceilingBytes: DYNAMIC_PACE_CEILING_BYTES + 1 }).enabled,
    ).toBe(false);
    expect(resolveDynamicPace({ ...valid, observeOnly: true })).toMatchObject({
      enabled: false,
      observeOnly: true,
    });
  });
});

describe('explainDynamicPace', () => {
  it('over target and falling: the window ask is the gap share plus the intake', () => {
    const paced = explain({ samples: series(-10) });
    expect(paced.applicable).toBe(true);
    expect(paced.overTarget).toBe(true);
    expect(paced.pace).toBe('catch-up');
    expect(paced.gapBytes).toBe(100);
    expect(paced.intakeBytesPerDay).toBeCloseTo(10, 6);
    expect(paced.requiredDeletedBytes).toBeGreaterThan(paced.gapPerWindowBytes);
    // gap 100, intake 10/day, 60 days: (100 + 600) * 7/60.
    expect(paced.requiredDeletedBytes).toBeCloseTo((700 * 7) / 60, 6);
  });

  it('over target and rising, but not enough to reach the floor: a smaller ask than the gap share', () => {
    const paced = explain({ samples: series(1) });
    expect(paced.overTarget).toBe(true);
    expect(paced.pace).toBe('catch-up');
    expect(paced.intakeBytesPerDay).toBe(0);
    expect(paced.rateBytesPerDay).toBeCloseTo(1, 6);
    expect(paced.requiredDeletedBytes).toBeGreaterThan(0);
    expect(paced.requiredDeletedBytes).toBeLessThan(paced.gapPerWindowBytes);
  });

  it('over target and rising fast enough to reach the floor inside the horizon: no batch', () => {
    const paced = explain({ samples: series(10), floorBytes: 500 });
    expect(paced.applicable).toBe(true);
    expect(paced.pace).toBe('none');
    expect(paced.requiredDeletedBytes).toBe(0);
    expect(paced.chosenBytes).toBe(0);
  });

  it('under target spends the surplus before asking to hold the target', () => {
    const paced = explain({ freeBytes: 300, samples: series(-10) });
    expect(paced.overTarget).toBe(false);
    expect(paced.gapBytes).toBe(0);
    expect(paced.surplusBytes).toBe(100);
    expect(paced.pace).toBe('steady');
    expect(paced.requiredDeletedBytes).toBeCloseTo((500 * 7) / 60, 6);
    expect(paced.chosenBytes).toBe(58);
  });

  it('a zero requirement is not lifted to the floor', () => {
    const paced = explain({
      freeBytes: 300,
      samples: series(10),
      floorBytes: 500,
      ceilingBytes: 1_000,
    });
    expect(paced.pace).toBe('none');
    expect(paced.requiredDeletedBytes).toBe(0);
    expect(paced.chosenBytes).toBe(0);
  });

  it('under target, a positive ask below the floor proposes nothing', () => {
    const paced = explain({
      freeBytes: 201,
      samples: series(-1),
      floorBytes: 50,
      ceilingBytes: 1_000,
      pools: [{ mediaKind: 'movie', poolBytes: 1_000 }],
    });
    expect(paced.requiredDeletedBytes).toBeCloseTo((59 * 7) / 60, 6);
    expect(paced.chosenBytes).toBe(0);
  });

  it('under target, a pool below the floor cannot post a smaller batch', () => {
    const paced = explain({
      freeBytes: 201,
      samples: series(-10),
      floorBytes: 50,
      pools: [{ mediaKind: 'movie', poolBytes: 40 }],
    });
    expect(paced.unclampedBytes).toBeGreaterThan(50);
    expect(paced.chosenBytes).toBe(0);
  });

  it('an empty pool chooses nothing and reports the whole requirement as a shortfall', () => {
    const paced = explain({ samples: series(-10), pools: [] });
    expect(paced.pace).toBe('catch-up');
    expect(paced.chosenBytes).toBe(0);
    expect(paced.poolBytes).toBe(0);
    expect(paced.shortfallBytes).toBeCloseTo(paced.requiredDeletedBytes, 6);
    expect(paced.poolShortfallBytes).toBe(Math.floor(paced.unclampedBytes));
  });

  it('a save-heavy rate inflates the ask until the ceiling, and the shortfall stays visible', () => {
    const paced = explain({
      samples: series(-10),
      saveRate: 0.8,
      floorBytes: 1,
      ceilingBytes: 100,
      pools: [{ mediaKind: 'movie', poolBytes: 10_000 }],
    });
    expect(paced.yieldRate).toBeCloseTo(0.2, 6);
    expect(paced.unclampedBytes).toBeGreaterThan(100);
    expect(paced.chosenBytes).toBe(100);
    expect(paced.expectedDeletedBytes).toBeCloseTo(20, 6);
    expect(paced.shortfallBytes).toBeGreaterThan(0);
  });

  it('a save rate of 1 does not inflate (nothing would be deleted)', () => {
    const paced = explain({ freeBytes: 300, samples: series(-10), saveRate: 1 });
    expect(paced.yieldRate).toBe(1);
    expect(paced.chosenBytes).toBe(58);
  });

  it('frequent deletions: adding them back makes the sized intake the true fill', () => {
    const trueRate = -1_000;
    const deletionBytes = 300;
    const observed = series(trueRate).map((sample, i) => ({
      t: sample.t,
      freeBytes: sample.freeBytes + i * deletionBytes,
    }));
    const deletions = observed.slice(1).map((sample) => ({ t: sample.t, bytes: deletionBytes }));
    const paced = explain({
      samples: observed,
      deletions,
      freeBytes: 100,
      pools: [{ mediaKind: 'movie', poolBytes: 1_000_000 }],
    });
    const unadjusted = forecastFreeSpace({
      samples: observed,
      targetFreeBytes: 200,
      now: NOW,
    });
    expect(paced.intakeBytesPerDay).toBeCloseTo(1_000, 6);
    expect(unadjusted.rateBytesPerDay).toBeCloseTo(-900, 6);
  });

  it('a level jump that is not a recorded deletion stays out of the intake', () => {
    const jumped = series(-1_000).map((sample, i) => ({
      t: sample.t,
      freeBytes: sample.freeBytes + (i >= 20 ? 1_000_000_000_000 : 0),
    }));
    const paced = explain({ samples: jumped, deletions: [] });
    expect(paced.intakeBytesPerDay).toBeCloseTo(1_000, 6);
    const raw = forecastFreeSpace({ samples: jumped, targetFreeBytes: 200, now: NOW });
    expect(raw.rateBytesPerDay).toBeCloseTo(-1_000, 6);
  });

  it('a flat series reports its measured zero intake and still closes a gap', () => {
    const paced = explain({ samples: series(0), floorBytes: 1, ceilingBytes: 1_000_000 });
    expect(paced.applicable).toBe(true);
    expect(paced.forecastReason).toBe('flat');
    expect(paced.intakeBytesPerDay).toBe(0);
    expect(paced.requiredDeletedBytes).toBeCloseTo((100 * 7) / 60, 6);
  });

  it('a series that is too short does not size a batch', () => {
    const paced = explain({ samples: series(-10).slice(0, 4) });
    expect(paced.applicable).toBe(false);
    expect(paced.inapplicable).toBe('too_short');
    expect(paced.chosenBytes).toBe(0);
    expect(paced.gapBytes).toBe(100);
  });

  it('clamps the window-to-horizon ratio at 1', () => {
    const longWindow = explain({ windowDays: 90, horizonDays: 60, samples: series(-10) });
    const ratioOne = explain({ windowDays: 60, horizonDays: 60, samples: series(-10) });
    // Same horizon and the same series: a 90-day window must not ask for 90/60 of the 60-day window.
    expect(longWindow.requiredDeletedBytes).toBeCloseTo(ratioOne.requiredDeletedBytes, 5);
    expect(longWindow.gapPerWindowBytes).toBeCloseTo(longWindow.gapBytes, 6);
    expect(longWindow.applicable).toBe(true);
  });

  it.each([
    { freeBytes: 900, targetPct: 80 },
    { freeBytes: 100, targetPct: 100 },
  ])('far under target or target 100 asks for nothing: %j', (input) => {
    const paced = explain({ ...input, samples: series(-1) });
    expect(paced.requiredDeletedBytes).toBe(0);
    expect(paced.chosenBytes).toBe(0);
  });

  it('reports horizon requirement and its shortfall before the ceiling', () => {
    const paced = explain({
      pools: [{ mediaKind: 'movie', poolBytes: 100 }],
      saveRate: 0.5,
      ceilingBytes: 10,
    });
    expect(paced.horizonRequiredDeletedBytes).toBeCloseTo(700, 6);
    expect(paced.horizonShortfallBytes).toBeCloseTo(650, 6);
    expect(paced.poolShortfallBytes).toBe(0);
  });

  it('a missing newest grid point is stale; normal step-alignment lag is allowed', () => {
    const fresh = explain({});
    expect(fresh.applicable).toBe(true);
    const paced = explain({ samples: series(-10).slice(0, -1) });
    expect(paced.applicable).toBe(false);
    expect(paced.inapplicable).toBe('stale_series');
    expect(paced.chosenBytes).toBe(0);
  });

  it('flat with a nonzero measured rate retains intake instead of silently omitting it', () => {
    // The middle half has variance large enough to include zero at two standard errors.
    let value = 1e9;
    const noisy = Array.from({ length: 31 }, (_, i) => {
      if (i > 0) value += (i % 2 === 0 ? 100 : -102) * 3;
      return { t: START + i * 3 * DAY, freeBytes: value };
    });
    const forecast = forecastFreeSpace({ samples: noisy, now: NOW, targetFreeBytes: 200 });
    expect(forecast.reason).toBe('flat');
    expect(forecast.rateBytesPerDay).toBeLessThan(0);
    const paced = explain({ samples: noisy });
    expect(paced.forecastReason).toBe('flat');
    expect(paced.rateBytesPerDay).toBe(forecast.rateBytesPerDay);
    expect(paced.intakeBytesPerDay).toBe(-forecast.rateBytesPerDay!);
    expect(paced.requiredDeletedBytes).toBeGreaterThan((100 * 7) / 60);
  });

  it('a ceiling below the floor does not size a batch', () => {
    const paced = explain({ ceilingBytes: 10, floorBytes: 20 });
    expect(paced.applicable).toBe(false);
    expect(paced.inapplicable).toBe('bad_bounds');
    expect(paced.chosenBytes).toBe(0);
  });

  it('two kinds share one ceiling, not two', () => {
    const paced = explain({
      freeBytes: 0,
      totalBytes: 10_000,
      targetPct: 50,
      samples: series(0),
      floorBytes: 1,
      ceilingBytes: 100,
      pools: [
        { mediaKind: 'movie', poolBytes: 1_000_000 },
        { mediaKind: 'tv', poolBytes: 1_000_000 },
      ],
    });
    expect(paced.chosenBytes).toBe(100);
    expect(paced.kinds.reduce((sum, kind) => sum + kind.chosenBytes, 0)).toBe(100);
    expect(paced.kinds.every((kind) => kind.chosenBytes <= kind.poolBytes)).toBe(true);
  });
});

describe('dynamicPaceHorizonFitsWindow', () => {
  it('refuses a horizon shorter than the save window', () => {
    expect(dynamicPaceHorizonFitsWindow(60, 7)).toBe(true);
    expect(dynamicPaceHorizonFitsWindow(7, 7)).toBe(true);
    expect(dynamicPaceHorizonFitsWindow(1, 7)).toBe(false);
    expect(dynamicPaceHorizonFitsWindow(60, 90)).toBe(false);
    expect(dynamicPaceHorizonFitsWindow(3661, 7)).toBe(false);
  });
});

describe('splitPaceAsk', () => {
  it('gives the leftover byte to the largest pool and never asks a kind for more than it has', () => {
    const shares = splitPaceAsk(2, [
      { mediaKind: 'movie', poolBytes: 3 },
      { mediaKind: 'tv', poolBytes: 1 },
    ]);
    expect(shares.find((kind) => kind.mediaKind === 'movie')!.chosenBytes).toBe(2);
    expect(shares.find((kind) => kind.mediaKind === 'tv')!.chosenBytes).toBe(0);
  });
});

describe('addRecordedDeletions', () => {
  it('subtracts a deletion from samples at or after it', () => {
    const adjusted = addRecordedDeletions(
      [
        { t: 0, freeBytes: 100 },
        { t: 10, freeBytes: 100 },
      ],
      [{ t: 5, bytes: 40 }],
    );
    expect(adjusted).toEqual([
      { t: 0, freeBytes: 100 },
      { t: 10, freeBytes: 60 },
    ]);
  });
});

describe('samplesForStorageArray', () => {
  it('reads HaynesTower from the Radarr rootfolder, which sits under the mount', () => {
    const samples = samplesForStorageArray(
      [
        {
          metric: {
            __name__: 'sonarr_rootfolder_freespace_bytes',
            path: '/data/haynestower/Media/TV Shows',
          },
          values: [[START, '1']],
        },
        {
          metric: {
            __name__: 'radarr_rootfolder_freespace_bytes',
            path: '/data/haynestower/Media/Movies',
          },
          values: [[START, '9']],
        },
      ],
      'haynestower',
    );
    expect(samples).toEqual([{ t: START, freeBytes: 9 }]);
  });
});

describe('Prometheus range reader', () => {
  it('requests the exact step-aligned forecast range and the Storage query', async () => {
    const range = forecastQueryRange(NOW);
    expect(range.end).toBe(Math.floor(NOW / FORECAST_STEP_SECONDS) * FORECAST_STEP_SECONDS);
    expect(range.start).toBe(range.end - FORECAST_WINDOW_SECONDS);
    expect(range.step).toBe(3 * DAY);
    const queryRange = vi.fn().mockResolvedValue([
      {
        metric: {
          __name__: 'radarr_rootfolder_freespace_bytes',
          path: '/data/haynestower/Media/Movies',
        },
        values: [[range.end, '100']],
      },
    ]);
    expect(await readArrayFreeSpaceSamples({ queryRange }, 'haynestower', NOW)).toEqual([
      { t: range.end, freeBytes: 100 },
    ]);
    expect(queryRange).toHaveBeenCalledExactlyOnceWith(
      FREESPACE_SERIES_QUERY,
      range.start,
      range.end,
      range.step,
    );
  });
  it('empty and failed reads are unavailable, never a guessed series', async () => {
    expect(
      await readArrayFreeSpaceSamples({ queryRange: async () => [] }, 'haynestower', NOW),
    ).toBeNull();
    expect(
      await readArrayFreeSpaceSamples(
        {
          queryRange: async () => {
            throw new Error('down');
          },
        },
        'haynestower',
        NOW,
      ),
    ).toBeNull();
  });
});
