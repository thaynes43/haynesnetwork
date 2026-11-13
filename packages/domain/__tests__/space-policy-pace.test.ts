// ADR-117 / DESIGN-014 D-15 — Dynamic Pace is a pure function of the disk, a free-space series,
// Trash's own recorded deletions, the save rate and the eligible pools. These tests do not boot
// a database. The setting-off path is in space-policy.test.ts.
import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_PACE_CEILING_BYTES,
  DYNAMIC_PACE_FLOOR_BYTES,
  DYNAMIC_PACE_HORIZON_DAYS,
  addRecordedDeletions,
  explainDynamicPace,
  forecastFreeSpace,
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
    expect(pace.horizonDays).toBe(60);
    expect(pace.floorBytes).toBe(DYNAMIC_PACE_FLOOR_BYTES);
    expect(pace.ceilingBytes).toBe(DYNAMIC_PACE_CEILING_BYTES);
    expect(resolveDynamicPace({ enabled: 'yes' }).enabled).toBe(false);
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

  it('under target keeps a steady pace equal to the intake and does not spend the surplus', () => {
    const paced = explain({ freeBytes: 300, samples: series(-10) });
    expect(paced.overTarget).toBe(false);
    expect(paced.gapBytes).toBe(0);
    expect(paced.surplusBytes).toBe(100);
    expect(paced.pace).toBe('steady');
    expect(paced.requiredDeletedBytes).toBeCloseTo(70, 6);
    expect(paced.chosenBytes).toBe(70);
  });

  it('a zero requirement is not lifted to the floor', () => {
    const paced = explain({ freeBytes: 300, samples: series(10), floorBytes: 500, ceilingBytes: 1_000 });
    expect(paced.pace).toBe('none');
    expect(paced.requiredDeletedBytes).toBe(0);
    expect(paced.chosenBytes).toBe(0);
  });

  it('a positive ask below the floor is raised to the floor', () => {
    const paced = explain({
      freeBytes: 300,
      samples: series(-1),
      floorBytes: 50,
      ceilingBytes: 1_000,
      pools: [{ mediaKind: 'movie', poolBytes: 1_000 }],
    });
    expect(paced.requiredDeletedBytes).toBeCloseTo(7, 6);
    expect(paced.chosenBytes).toBe(50);
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
    expect(paced.chosenBytes).toBe(70);
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

  it('a flat series omits intake and still closes a measured gap', () => {
    const paced = explain({ samples: series(0), floorBytes: 1, ceilingBytes: 1_000_000 });
    expect(paced.applicable).toBe(true);
    expect(paced.forecastReason).toBe('flat');
    expect(paced.intakeBytesPerDay).toBeNull();
    expect(paced.requiredDeletedBytes).toBeCloseTo((100 * 7) / 60, 6);
  });

  it('a series that is too short does not size a batch', () => {
    const paced = explain({ samples: series(-10).slice(0, 4) });
    expect(paced.applicable).toBe(false);
    expect(paced.inapplicable).toBe('too_short');
    expect(paced.chosenBytes).toBe(0);
    expect(paced.gapBytes).toBe(100);
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
          metric: { __name__: 'sonarr_rootfolder_freespace_bytes', path: '/data/haynestower/Media/TV Shows' },
          values: [[START, '1']],
        },
        {
          metric: { __name__: 'radarr_rootfolder_freespace_bytes', path: '/data/haynestower/Media/Movies' },
          values: [[START, '9']],
        },
      ],
      'haynestower',
    );
    expect(samples).toEqual([{ t: START, freeBytes: 9 }]);
  });
});
