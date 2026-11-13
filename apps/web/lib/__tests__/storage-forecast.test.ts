// DESIGN-013 D-09 (story 819) — the mapping from the `storage.forecast` read to what the Capacity
// Forecast draws and says: the two tiles and the sentence for every state (filling over and under
// the target, freeing up over and under it, no target, flat, each kind of too short, the read away),
// the notes that qualify a forecast (set-aside jumps, the read-with-care case, a stale level), the
// date and pace wording, and the plot's geometry (horizon from the data, marks, axis labels).
import { describe, expect, it } from 'vitest';
import {
  FORECAST_CAUTION,
  FORECAST_LEGEND,
  FORECAST_UNAVAILABLE,
  forecastCaption,
  forecastDateWords,
  forecastDayLabel,
  forecastPanel,
  forecastPanels,
  forecastPlot,
  forecastTimeTicks,
  jumpNote,
  jumpsOutweighPace,
  paceAmount,
} from '../storage-forecast';
import type { StorageForecastReport, StorageForecastSeries } from '../storage-forecast';

const GB = 1_000_000_000;
const TB = 1000 * GB;
const DAY = 86_400;
const H = 160; // the component's PLOT_H
const PAD = 6; // PLOT_TOP_PAD in lib/storage-forecast.ts

// The instant of the D-08 measurement: the 3-day grid's last sample is 40.6 hours before it.
const NOW = Date.parse('2026-11-13T16:36:00.000Z') / 1000;
const END = Date.parse('2026-11-12T00:00:00.000Z') / 1000;
const START = END - 90 * DAY;

const TOWER_TOTAL = 529.96 * TB;
const TOWER_FLOOR = Math.round(TOWER_TOTAL * 0.2); // an 80% target: 105.992 TB free

function report(series: StorageForecastSeries[]): StorageForecastReport {
  return {
    start: START,
    end: END,
    stepSeconds: 3 * DAY,
    now: NOW,
    minPoints: 13,
    minSpanSeconds: 36 * DAY,
    unavailable: false,
    series,
  };
}

/**
 * 31 samples on the read's grid that end at `endBytes`, having fallen `fallPerDay` bytes a day
 * (negative: free space rose).
 */
function line(endBytes: number, fallPerDay: number, count = 31) {
  return Array.from({ length: count }, (_, i) => ({
    t: END - (count - 1 - i) * 3 * DAY,
    freeBytes: endBytes + fallPerDay * (count - 1 - i) * 3,
  }));
}

function crossing(level: number, threshold: number, rate: number): number {
  return Math.round(NOW + ((threshold - level) / rate) * DAY);
}

function towerSeries(over: Partial<StorageForecastSeries> = {}): StorageForecastSeries {
  return {
    key: 'haynestower',
    label: 'HaynesTower',
    totalBytes: TOWER_TOTAL,
    targetPct: 80,
    targetFreeBytes: TOWER_FLOOR,
    points: [],
    jumps: null,
    forecast: {
      forecast: false,
      reason: 'too_short',
      direction: 'unknown',
      rateBytesPerDay: null,
      fullAt: null,
      targetAt: null,
      origin: null,
    },
    ...over,
  };
}

/** A forecast with a rate, from `level` at NOW, dated the way `forecastFreeSpace` dates it. */
function forecasting(
  level: number,
  rate: number,
  floor: number | null,
): StorageForecastSeries['forecast'] {
  const filling = rate < 0;
  return {
    forecast: true,
    reason: null,
    direction: filling ? 'filling' : 'draining',
    rateBytesPerDay: rate,
    fullAt: filling ? crossing(level, 0, rate) : null,
    targetAt:
      floor == null || (filling ? level <= floor : level >= floor)
        ? null
        : crossing(level, floor, rate),
    origin: { t: NOW, freeBytes: level },
  };
}

describe('forecastDateWords — no finer than the forecast can support', () => {
  it('prints a day inside 60 days, a month inside 2 years, and only the year beyond', () => {
    expect(forecastDateWords(NOW + 20 * DAY, NOW).date).toBe('Dec 3');
    expect(forecastDateWords(NOW + 60 * DAY, NOW).date).toBe('Jan 12, 2027'); // the year, once it changes
    expect(forecastDateWords(NOW + 61 * DAY, NOW).date).toBe('Jan 2027');
    expect(forecastDateWords(NOW + 412.75 * DAY, NOW).date).toBe('Dec 2027');
    expect(forecastDateWords(NOW + 730 * DAY, NOW).date).toBe('Nov 2028');
    expect(forecastDateWords(NOW + 731 * DAY, NOW).date).toBe('2028');
    expect(forecastDateWords(NOW + 2808.6 * DAY, NOW).date).toBe('2034');
  });

  it('says how far away in days, weeks, months, then half-years', () => {
    const away = (days: number) => forecastDateWords(NOW + days * DAY, NOW).away;
    expect(away(0.4)).toBe('in less than a day');
    expect(away(1)).toBe('in 1 day');
    expect(away(13.4)).toBe('in 13 days');
    expect(away(14)).toBe('in about 2 weeks');
    expect(away(62)).toBe('in about 9 weeks');
    expect(away(63)).toBe('in about 2 months');
    expect(away(412.75)).toBe('in about 14 months');
    expect(away(729)).toBe('in about 24 months');
    expect(away(731)).toBe('in about 2 years');
    expect(away(2808.6)).toBe('in about 7.5 years');
  });

  it('does not print a date a thousand years out', () => {
    expect(forecastDateWords(NOW + 400_000 * DAY, NOW)).toEqual({
      date: 'Far off',
      away: 'in more than 1,000 years',
    });
  });

  it('labels a day in UTC, with the year only when it is not this one', () => {
    expect(forecastDayLabel(END, NOW)).toBe('Nov 12');
    expect(forecastDayLabel(NOW + 60 * DAY, NOW)).toBe('Jan 12, 2027');
  });
});

describe('paceAmount — two significant figures in the page’s capacity units', () => {
  it('rounds the D-08 rates and their weekly totals', () => {
    expect(paceAmount(-212.24375 * GB)).toBe('210 GB');
    expect(paceAmount(-212.24375 * GB * 7)).toBe('1.5 TB');
    expect(paceAmount(-39.3 * GB)).toBe('39 GB');
    expect(paceAmount(-39.3 * GB * 7)).toBe('280 GB');
    expect(paceAmount(150 * GB * 7)).toBe('1.1 TB');
    expect(paceAmount(0)).toBe('0 B');
  });
});

describe('forecastPanel — use rising', () => {
  // The state measured 2026-11-13: 87603.3 GB free under a 105.992 TB floor, −212.24375 GB/day.
  const LEVEL = 87_603.3 * GB;
  const RATE = -212.24375 * GB;
  const overTarget = towerSeries({
    points: line(88_140.8 * GB, 212.24375 * GB),
    forecast: forecasting(LEVEL, RATE, TOWER_FLOOR),
    jumps: {
      rises: { count: 2, bytes: 9_863.8 * GB },
      falls: { count: 0, bytes: 0 },
      latestAt: END,
      partlyCounted: false,
    },
  });

  it('over target: the 100% date only, and the target tile says how far over', () => {
    const panel = forecastPanel(overTarget, report([overTarget]), H);
    expect(panel.tone).toBe('filling');
    expect(panel.chip).toBe('Filling');
    // 87603.3 / 212.24375 = 412.75 days after 2026-11-13: 2027-12-31.
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: 'Dec 2027',
      detail: 'in about 14 months',
    });
    // 105.992 TB − 87.6033 TB = 18.3887 TB over.
    expect(panel.target).toEqual({
      label: 'Target (80% used)',
      value: 'Over now',
      detail: 'by 18.4 TB, and rising',
    });
    expect(panel.sentence).toBe('Filling by about 210 GB a day (1.5 TB a week).');
    expect(panel.summary).toBe(
      'HaynesTower. Filling by about 210 GB a day (1.5 TB a week). Target (80% used): Over now, by 18.4 TB, and rising. Full (100% used): Dec 2027, in about 14 months.',
    );
  });

  it('says a set-aside rise was treated as a one-off, without the read-with-care line', () => {
    const panel = forecastPanel(overTarget, report([overTarget]), H);
    // 9863.8 GB of rises against 212.24375 × 90 = 19101.9 GB of pace: the pace outweighs them.
    expect(panel.caution).toBe(false);
    expect(panel.notes).toEqual([
      'Free space jumped up by 9.9 TB in the last 90 days (2 jumps, the latest just before Nov 12). The projection treats them as one-offs: they move the starting point, not the pace. If jumps like these keep coming, the array will have more free space than projected.',
    ]);
  });

  it('over target: the plot marks zero only, under the dashed floor', () => {
    const plot = forecastPlot(overTarget, report([overTarget]), H)!;
    const fullAt = overTarget.forecast.fullAt!;
    const t1 = fullAt + 0.06 * (fullAt - START);
    const x = (t: number) => Math.round(((t - START) / (t1 - START)) * 10000) / 100;

    expect(plot.marks).toEqual([{ kind: 'full', x: x(fullAt), y: H - 1 }]);
    expect(plot.marks[0]!.x).toBeCloseTo(94.34, 1); // 1 / 1.06 of the width, whatever the dates
    expect(plot.today!.x).toBe(x(NOW));
    expect(plot.today!.x).toBeGreaterThan(15); // 91.7 days of history before 412.75 of projection
    expect(plot.today!.x).toBeLessThan(18);
    // The oldest sample (88140.8 + 212.24375 × 90 = 107242.7 GB) is the highest value drawn; the
    // axis tops out 12% above it, and the 105.992 TB floor sits just under it.
    const yMax = (88_140.8 + 212.24375 * 90) * GB * 1.12;
    expect(plot.target).toEqual({
      y: Math.round((PAD + (1 - TOWER_FLOOR / yMax) * (H - PAD - 1)) * 100) / 100,
      label: 'Target · 106 TB free',
      labelEnd: 100, // no mark on the floor: the label runs to the right edge
    });
    expect(plot.target!.y).toBeGreaterThanOrEqual(20); // room for the label above the rule
    expect(plot.today!.y).toBeGreaterThan(plot.target!.y); // today is below the floor: over target
    expect(plot.projection).toBe(
      `M ${plot.today!.x} ${plot.today!.y} L ${plot.marks[0]!.x} ${H - 1}`,
    );
    expect(plot.history).toMatch(/^M 0 [\d.]+ L /);
    // The history runs through the last sample to the level at now.
    expect(plot.history!.endsWith(`L ${plot.today!.x} ${plot.today!.y}`)).toBe(true);
    // Axis top 120.1 TB ⇒ 25 TB gridlines.
    expect(plot.yTicks.map((t) => t.label)).toEqual(['25 TB', '50 TB', '75 TB', '100 TB']);
    // The date sits under its mark; the calendar fills in around it where there is room.
    expect(plot.xLabels.find((l) => l.kind === 'event')).toEqual({
      x: x(fullAt),
      label: 'Dec 2027',
      kind: 'event',
    });
    expect(plot.xLabels.find((l) => l.kind === 'today')!.label).toBe('Today');
    expect(plot.xLabels.filter((l) => l.kind === 'tick').map((l) => l.label)).toEqual(['Jul 2027']);
  });

  it('under target: both dates, the target first', () => {
    const level = 112.4304 * TB;
    const under = towerSeries({
      points: line(level, 100 * GB),
      forecast: forecasting(level, -100 * GB, TOWER_FLOOR),
    });
    const panel = forecastPanel(under, report([under]), H);
    // (112.4304 − 105.992) TB / 100 GB = 64.38 days; 112.4304 TB / 100 GB = 1124.3 days.
    expect(panel.target).toEqual({
      label: 'Target (80% used)',
      value: 'Jan 2027',
      detail: 'over target in about 2 months',
    });
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: '2029',
      detail: 'in about 3 years',
    });
    expect(panel.sentence).toBe('Filling by about 100 GB a day (700 GB a week).');
    expect(panel.notes).toEqual([]);

    const plot = panel.plot!;
    expect(plot.marks.map((m) => m.kind)).toEqual(['target', 'full']);
    expect(plot.marks[0]!.y).toBe(plot.target!.y); // the first mark is on the dashed floor
    expect(plot.marks[1]!.y).toBe(H - 1);
    expect(plot.marks[0]!.x).toBeLessThan(plot.marks[1]!.x);
    // Today and the target date are 5% apart: the later date and the nearer one keep their labels,
    // "Today" gives way.
    expect(plot.xLabels.filter((l) => l.kind === 'event').map((l) => l.label)).toEqual([
      'Jan 2027',
      '2029',
    ]);
    expect(plot.xLabels.some((l) => l.kind === 'today')).toBe(false);
  });

  it('no target: the 100% forecast only', () => {
    // The music array as recorded: 110378.8 GB at −39.3 GB/day, three falls and three rises set aside.
    const level = 110_378.8 * GB;
    const music = towerSeries({
      key: 'cephfs',
      label: 'Music (CephFS)',
      totalBytes: 174.84 * TB,
      targetPct: null,
      targetFreeBytes: null,
      points: line(level, 39.3 * GB),
      forecast: forecasting(level, -39.3 * GB, null),
      jumps: {
        rises: { count: 3, bytes: 3_829.2 * GB },
        falls: { count: 3, bytes: 11_886.7 * GB },
        latestAt: END,
        partlyCounted: false,
      },
    });
    const panel = forecastPanel(music, report([music]), H);
    expect(panel.target).toEqual({
      label: 'Target',
      value: 'Not set',
      detail: 'no space target for this array',
    });
    // 110378.8 / 39.3 = 2808.6 days: 7.69 years, said as 7.5.
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: '2034',
      detail: 'in about 7.5 years',
    });
    expect(panel.sentence).toBe('Filling by about 39 GB a day (280 GB a week).');
    expect(panel.plot!.target).toBeNull();
    expect(panel.plot!.marks.map((m) => m.kind)).toEqual(['full']);
    // An eight-year axis counts in years.
    expect(panel.plot!.xLabels.filter((l) => l.kind === 'tick').map((l) => l.label)).toEqual([
      '2030',
      '2032',
    ]);

    // DESIGN-013 Q-03: the jumps (8057.5 GB net down) outweigh the pace (39.3 × 90 = 3537 GB), so
    // the forecast stands and is flagged to be read with care.
    expect(panel.caution).toBe(true);
    expect(panel.notes).toEqual([
      FORECAST_CAUTION,
      'In the last 90 days free space dropped suddenly by 11.9 TB (3 drops) and jumped up by 3.8 TB (3 jumps), the latest just before Nov 12. The projection treats them as one-offs: they move the starting point, not the pace. If drops like these keep coming, the array will have less free space than projected.',
    ]);
  });

  it('an array with nothing left says so instead of a date', () => {
    const fullNow = towerSeries({
      points: line(0, 50 * GB),
      forecast: { ...forecasting(0, -50 * GB, TOWER_FLOOR), fullAt: null },
    });
    const panel = forecastPanel(fullNow, report([fullNow]), H);
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: 'Now',
      detail: 'no free space left',
    });
    expect(panel.plot!.projection).toBeNull();
  });
});

describe('forecastPanel — use falling', () => {
  it('over target: the date it is back under, and no 100% date', () => {
    const level = 87.6 * TB;
    const draining = towerSeries({
      points: line(level, -150 * GB),
      forecast: forecasting(level, 150 * GB, TOWER_FLOOR),
    });
    const panel = forecastPanel(draining, report([draining]), H);
    expect(panel.tone).toBe('draining');
    expect(panel.chip).toBe('Freeing up');
    // (105.992 − 87.6) TB / 150 GB = 122.6 days after 2026-11-13: 2027-03-16.
    expect(panel.target).toEqual({
      label: 'Target (80% used)',
      value: 'Mar 2027',
      detail: 'back under in about 4 months',
    });
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: 'Not ahead',
      detail: 'space is freeing up',
    });
    expect(panel.sentence).toBe('Freeing up about 150 GB a day (1.1 TB a week).');

    // The projection rises to the dashed floor and stops there.
    const plot = panel.plot!;
    expect(plot.marks).toEqual([{ kind: 'target', x: expect.any(Number), y: plot.target!.y }]);
    expect(plot.projection!.endsWith(`L ${plot.marks[0]!.x} ${plot.target!.y}`)).toBe(true);
    expect(plot.target!.labelEnd).toBe(plot.marks[0]!.x); // the floor's label stops short of the mark
    expect(plot.today!.y).toBeGreaterThan(plot.target!.y); // today is below the floor on screen
    expect(plot.xLabels.filter((l) => l.kind === 'event').map((l) => l.label)).toEqual([
      'Mar 2027',
    ]);
  });

  it('already under target: a pace, no date, and a projection as long as the history', () => {
    const level = 112.4304 * TB;
    const draining = towerSeries({
      points: line(level, -150 * GB),
      forecast: forecasting(level, 150 * GB, TOWER_FLOOR),
    });
    const panel = forecastPanel(draining, report([draining]), H);
    // 112.4304 − 105.992 = 6.4384 TB above the floor.
    expect(panel.target).toEqual({
      label: 'Target (80% used)',
      value: 'Under now',
      detail: '6.4 TB to spare, and growing',
    });
    expect(panel.full.value).toBe('Not ahead');
    const plot = panel.plot!;
    expect(plot.marks).toEqual([]);
    expect(plot.xLabels.some((l) => l.kind === 'event')).toBe(false);
    // 90 days back and 90 days forward of the level: today sits just left of the middle.
    const t1 = NOW + 90 * DAY + 0.06 * (NOW + 90 * DAY - START);
    expect(plot.today!.x).toBe(Math.round(((NOW - START) / (t1 - START)) * 10000) / 100);
    expect(plot.projection).not.toBeNull();
  });

  it('no target: nothing to reach, so only the pace', () => {
    const level = 130.45 * TB;
    const music = towerSeries({
      key: 'cephfs',
      label: 'Music (CephFS)',
      totalBytes: 174.84 * TB,
      targetPct: null,
      targetFreeBytes: null,
      points: line(level, -40 * GB),
      forecast: forecasting(level, 40 * GB, null),
    });
    const panel = forecastPanel(music, report([music]), H);
    expect(panel.target.value).toBe('Not set');
    expect(panel.full).toMatchObject({ value: 'Not ahead', detail: 'space is freeing up' });
    expect(panel.sentence).toBe('Freeing up about 40 GB a day (280 GB a week).');
  });

  it('never draws free space past the size of the array', () => {
    const total = 100 * TB;
    const level = 99 * TB;
    const nearlyEmpty = towerSeries({
      totalBytes: total,
      targetPct: null,
      targetFreeBytes: null,
      points: line(level, -100 * GB),
      forecast: forecasting(level, 100 * GB, null),
    });
    const plot = forecastPlot(nearlyEmpty, report([nearlyEmpty]), H)!;
    // 1 TB of room at 100 GB a day: the line stops after 10 days, at the array's size.
    const stopAt = NOW + 10 * DAY;
    const t1 = stopAt + 0.06 * (stopAt - START);
    const x = Math.round(((stopAt - START) / (t1 - START)) * 10000) / 100;
    const y = Math.round((PAD + (1 - 1 / 1.12) * (H - PAD - 1)) * 100) / 100;
    expect(plot.projection, 'the projection').toMatch(new RegExp(` L ${x} ${y}$`));
  });
});

describe('forecastPanel — no forecast says why', () => {
  it('flat: holding steady, with the history still drawn', () => {
    const level = 130.45 * TB;
    const flat = towerSeries({
      key: 'cephfs',
      label: 'Music (CephFS)',
      targetPct: null,
      targetFreeBytes: null,
      points: line(level, 0),
      forecast: {
        forecast: false,
        reason: 'flat',
        direction: 'flat',
        rateBytesPerDay: 0,
        fullAt: null,
        targetAt: null,
        origin: { t: NOW, freeBytes: level },
      },
    });
    const panel = forecastPanel(flat, report([flat]), H);
    expect(panel.tone).toBe('steady');
    expect(panel.chip).toBe('Steady');
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: 'No date',
      detail: 'holding steady',
    });
    expect(panel.sentence).toBe(
      'No forecast: free space has not clearly risen or fallen over the last 90 days, so there is no date to predict.',
    );
    expect(panel.plot!.projection).toBeNull();
    expect(panel.plot!.history).not.toBeNull();
    expect(panel.plot!.marks).toEqual([]);
    expect(panel.plot!.today!.x).toBeCloseTo(94.34, 1); // the history fills the plot
  });

  it('flat with a target: the tile still says which side of it the array is on', () => {
    const forecast = {
      forecast: false,
      reason: 'flat' as const,
      direction: 'flat' as const,
      rateBytesPerDay: 0,
      fullAt: null,
      targetAt: null,
    };
    const over = towerSeries({
      points: line(100 * TB, 0),
      forecast: { ...forecast, origin: { t: NOW, freeBytes: 100 * TB } },
    });
    expect(forecastPanel(over, report([over]), H).target).toMatchObject({
      value: 'Over now',
      detail: 'by 6 TB',
    });
    const under = towerSeries({
      points: line(110 * TB, 0),
      forecast: { ...forecast, origin: { t: NOW, freeBytes: 110 * TB } },
    });
    expect(forecastPanel(under, report([under]), H).target).toMatchObject({
      value: 'Under now',
      detail: '4 TB to spare',
    });
    const at = towerSeries({
      points: line(TOWER_FLOOR, 0),
      forecast: { ...forecast, origin: { t: NOW, freeBytes: TOWER_FLOOR } },
    });
    expect(forecastPanel(at, report([at]), H).target).toMatchObject({ value: 'At target' });
  });

  it('too short: how many days it has against the days it needs', () => {
    const level = 112.4304 * TB;
    const young = towerSeries({
      points: line(level, 80 * GB, 8), // 8 samples: 21 days
      forecast: { ...towerSeries().forecast, origin: { t: NOW, freeBytes: level } },
    });
    const panel = forecastPanel(young, report([young]), H);
    expect(panel.tone).toBe('none');
    expect(panel.chip).toBe('No forecast');
    expect(panel.sentence).toBe(
      'No forecast yet: it needs 36 days of readings and this array has 21 so far.',
    );
    expect(panel.full).toEqual({
      label: 'Full (100% used)',
      value: 'No date yet',
      detail: 'not enough history',
    });
    expect(panel.target).toMatchObject({ value: 'Under now', detail: '6.4 TB to spare' });
    expect(panel.plot!.history).not.toBeNull(); // what history there is, is drawn
    expect(panel.plot!.projection).toBeNull();
  });

  it('too short: enough days with too many readings missing', () => {
    const gappy = line(112.4304 * TB, 80 * GB).filter((_, i) => i % 3 === 0 || i === 29); // 12 of 31
    expect(gappy).toHaveLength(12);
    const series = towerSeries({
      points: gappy,
      forecast: { ...towerSeries().forecast, origin: { t: NOW, freeBytes: 112.4304 * TB } },
    });
    expect(forecastPanel(series, report([series]), H).sentence).toBe(
      'No forecast yet: too many readings are missing from the last 90 days (12 of the 13 it needs).',
    );
  });

  it('too short: no reading at all, and a level with no history', () => {
    const none = towerSeries();
    const blank = forecastPanel(none, report([none]), H);
    expect(blank.sentence).toBe(
      'No forecast: there are no free-space readings for this array yet.',
    );
    expect(blank.target).toMatchObject({ value: 'Unknown', detail: 'the array could not be read' });
    expect(blank.plot).toBeNull();
    expect(blank.emptyPlot).toBe('Nothing to plot yet.');

    const levelOnly = towerSeries({
      forecast: { ...towerSeries().forecast, origin: { t: NOW, freeBytes: 112.4304 * TB } },
    });
    const panel = forecastPanel(levelOnly, report([levelOnly]), H);
    expect(panel.sentence).toBe(
      'No forecast yet: it needs 36 days of readings and this array has 0 so far.',
    );
    expect(panel.plot).toBeNull(); // one reading is not a line
  });
});

describe('forecastPanel — a level that is not live', () => {
  it('names the day of the reading the projection starts from', () => {
    // The *arr could not be read: the level is the last aligned sample, 40.6 hours before now.
    const level = 120 * TB;
    const stale = towerSeries({
      totalBytes: null,
      targetFreeBytes: null,
      points: line(level, 1000 * GB),
      forecast: {
        forecast: true,
        reason: null,
        direction: 'filling',
        rateBytesPerDay: -1000 * GB,
        fullAt: END + 120 * DAY,
        targetAt: null,
        origin: { t: END, freeBytes: level },
      },
    });
    const panel = forecastPanel(stale, report([stale]), H);
    expect(panel.notes).toEqual([
      'The starting point is the reading from Nov 12: the live free space could not be read.',
    ]);
    expect(panel.target).toMatchObject({ value: 'Unknown' }); // a target, and no size to place it
    expect(panel.plot!.xLabels.find((l) => l.kind === 'today')!.label).toBe('Nov 12');
    // The last sample is the level: the history does not repeat it.
    expect(panel.plot!.history!.match(/L /g)).toHaveLength(30);
  });
});

describe('jumpNote — what was set aside, in plain words', () => {
  it('one rise, one fall, and more than the method sets aside', () => {
    const base = {
      rises: { count: 0, bytes: 0 },
      falls: { count: 0, bytes: 0 },
      latestAt: END - 30 * DAY,
      partlyCounted: false,
    };
    expect(jumpNote({ ...base, rises: { count: 1, bytes: 4 * TB } }, 90, NOW)).toBe(
      'Free space jumped up by 4 TB in the last 90 days (1 jump, just before Oct 13). The projection treats it as a one-off: it moves the starting point, not the pace. If jumps like these keep coming, the array will have more free space than projected.',
    );
    expect(jumpNote({ ...base, falls: { count: 2, bytes: 6.5 * TB } }, 90, NOW)).toBe(
      'Free space dropped suddenly by 6.5 TB in the last 90 days (2 drops, the latest just before Oct 13). The projection treats them as one-offs: they move the starting point, not the pace. If drops like these keep coming, the array will have less free space than projected.',
    );
    expect(
      jumpNote({ ...base, rises: { count: 8, bytes: 21.1 * TB }, partlyCounted: true }, 90, NOW),
    ).toBe(
      'Free space jumped up by 21.1 TB in the last 90 days (8 jumps, the latest just before Oct 13). There were more of them than the projection sets aside, so some now count toward its pace. If jumps like these keep coming, the array will have more free space than projected.',
    );
  });

  it('jumpsOutweighPace compares the net jump with the pace over the window', () => {
    const jumps = {
      rises: { count: 1, bytes: 10 * TB },
      falls: { count: 1, bytes: 4 * TB },
      latestAt: END,
      partlyCounted: false,
    };
    expect(jumpsOutweighPace(jumps, -60 * GB, 90)).toBe(true); // 6 TB net against 5.4 TB
    expect(jumpsOutweighPace(jumps, -70 * GB, 90)).toBe(false); // 6 TB net against 6.3 TB
  });
});

describe('forecastTimeTicks — the axis changes its units with the span', () => {
  it('counts in days, then months, then years, never more than five labels', () => {
    const days = forecastTimeTicks(START, START + 30 * DAY);
    expect(days.map((t) => t.label)).toEqual(['Aug 21', 'Aug 28', 'Sep 4', 'Sep 11']);

    const months = forecastTimeTicks(START, START + 534 * DAY);
    expect(months.map((t) => t.label)).toEqual(['Jan 2027', 'Jul 2027', 'Jan 2028']);

    const years = forecastTimeTicks(START, START + 3074 * DAY);
    expect(years.map((t) => t.label)).toEqual(['2028', '2030', '2032', '2034']);

    const centuries = forecastTimeTicks(START, START + 300 * 365.25 * DAY);
    expect(centuries.map((t) => t.label)).toEqual(['2100', '2200', '2300']);

    for (const ticks of [days, months, years, centuries]) {
      expect(ticks.length).toBeLessThanOrEqual(5);
      for (const t of ticks) {
        expect(t.x).toBeGreaterThanOrEqual(4);
        expect(t.x).toBeLessThanOrEqual(96);
      }
    }
    expect(forecastTimeTicks(START, START)).toEqual([]);
  });
});

describe('forecastPanels — every state of the read keeps one panel per array', () => {
  const arrays = [
    { key: 'haynestower', label: 'HaynesTower', target: 80 },
    { key: 'cephfs', label: 'Music (CephFS)', target: null },
  ];

  it('Prometheus down: the same panels, saying the forecast is unavailable', () => {
    const down = { ...report([]), unavailable: true };
    const panels = forecastPanels(down, arrays, { kind: 'ready' }, H);
    expect(panels.map((p) => p.key)).toEqual(['haynestower', 'cephfs']);
    expect(panels[0]).toMatchObject({
      tone: 'none',
      chip: 'No forecast',
      sentence: FORECAST_UNAVAILABLE,
      target: { label: 'Target (80% used)', value: 'No date', detail: 'forecast unavailable' },
      full: { label: 'Full (100% used)', value: 'No date', detail: 'forecast unavailable' },
      plot: null,
      emptyPlot: 'No plot while the forecast is unavailable.',
      notes: [],
    });
    expect(panels[1]!.target.label).toBe('Target');
    expect(FORECAST_UNAVAILABLE).toBe(
      'Forecast unavailable: couldn’t reach Prometheus right now. The meters above still show live utilization.',
    );
  });

  it('loading and failed reads keep the panels too', () => {
    const loading = forecastPanels(undefined, arrays, { kind: 'loading' }, H);
    expect(loading[0]).toMatchObject({
      chip: '…',
      sentence: 'Loading forecast…',
      full: { value: '…', detail: 'loading' },
      emptyPlot: 'Loading forecast…',
    });
    const failed = forecastPanels(undefined, arrays, { kind: 'error', message: 'boom' }, H);
    expect(failed[1]).toMatchObject({
      chip: 'No forecast',
      sentence: 'Failed to load the forecast: boom',
      full: { value: 'No date', detail: 'forecast unavailable' },
    });
  });

  it('a refresh that fails keeps the last forecast and says it is old', () => {
    const tower = towerSeries({
      points: line(112.4304 * TB, 100 * GB),
      forecast: forecasting(112.4304 * TB, -100 * GB, TOWER_FLOOR),
    });
    const fresh = forecastPanels(report([tower]), arrays, { kind: 'ready' }, H)[0]!;
    const stale = forecastPanels(
      report([tower]),
      arrays,
      { kind: 'error', message: 'fetch failed.' },
      H,
    )[0]!;
    expect(fresh).toMatchObject({ stale: false, tone: 'filling', chip: 'Filling' });
    // The dates and the plot are the last read's; the chip, the tone and the sentence say so.
    expect(stale).toMatchObject({
      stale: true,
      tone: 'none',
      chip: 'Not refreshed',
      sentence:
        'Couldn’t refresh the forecast (fetch failed). The dates here are from the last read.',
      target: fresh.target,
      full: fresh.full,
      plot: fresh.plot,
    });
    expect(stale.summary).toContain('Couldn’t refresh the forecast (fetch failed).');
  });

  it('with a forecast the panels are the read’s arrays; with no array known there are none', () => {
    const tower = towerSeries({
      points: line(112.4304 * TB, 100 * GB),
      forecast: forecasting(112.4304 * TB, -100 * GB, TOWER_FLOOR),
    });
    expect(forecastPanels(report([tower]), [], { kind: 'ready' }, H).map((p) => p.key)).toEqual([
      'haynestower',
    ]);
    expect(forecastPanels(undefined, [], { kind: 'loading' }, H)).toEqual([]);
  });
});

describe('the card’s fixed words', () => {
  it('the caption names the window the read used', () => {
    expect(forecastCaption(report([]))).toBe(
      'When each media array reaches its space target and when it is full, if free space keeps changing at the pace of the last 90 days. An estimate, not a schedule.',
    );
    expect(forecastCaption(undefined)).toContain('the last 90 days');
  });

  it('the key names both directions, so the colours are never the only cue', () => {
    expect(FORECAST_LEGEND.map((e) => e.label)).toEqual([
      'Free space so far',
      'Today',
      'Projection while filling',
      'Projection while freeing up',
      'Space target',
    ]);
  });
});
