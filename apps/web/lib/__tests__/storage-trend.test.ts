// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the free-space trend chart's pure geometry:
// round byte ticks on a zero-based axis, honest sparse UTC time ticks, gap-aware line paths (an
// exporter outage reads as a hole, never a confident bridge), the target free-bytes floor, the
// end-label collision nudge, and the "history begins …" retention honesty note.
import { describe, expect, it } from 'vitest';
import {
  niceByteDomain,
  trendGeometry,
  trendLegendValue,
  trendTimeTicks,
  TREND_WINDOW_OPTIONS,
} from '../storage-trend';
import type { StorageTrendSeries } from '../storage-trend';

const TB = 1_000_000_000_000;
const DAY = 86_400;
const H = 200; // the component's PLOT_H
const PAD = 6; // PLOT_TOP_PAD in lib/storage-trend.ts
const y = (v: number, yMin: number, yMax: number): number =>
  Math.round((PAD + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD - 1)) * 100) / 100;

function series(
  key: string,
  points: { t: number; freeBytes: number }[],
  target?: { totalBytes: number; targetPct: number },
): StorageTrendSeries {
  return {
    key,
    label: key === 'haynestower' ? 'HaynesTower' : 'Music (CephFS)',
    points,
    totalBytes: target?.totalBytes ?? null,
    targetPct: target?.targetPct ?? null,
    targetFreeBytes: target ? Math.round(target.totalBytes * (1 - target.targetPct / 100)) : null,
  };
}

describe('niceByteDomain — a FITTED axis on round ticks with an explicit baseline', () => {
  it('brackets data + target on round steps and labels the non-zero baseline', () => {
    // 106..130 TB (data + target floor) → 10 TB steps: baseline 100 TB, top 140 TB — the drain
    // reads at full plot height instead of being crushed against a zero axis.
    const d = niceByteDomain(106 * TB, 130 * TB);
    expect(d.yMin).toBe(100 * TB);
    expect(d.yMax).toBe(140 * TB);
    expect(d.ticks).toEqual([110 * TB, 120 * TB, 130 * TB, 140 * TB]);
    expect(d.baselineLabel).toBe('100 TB'); // truncation is honest — the baseline is named
  });

  it('spreads flat data so a steady line sits mid-plot; zero floors stay zero (unlabeled)', () => {
    const flat = niceByteDomain(130 * TB, 130 * TB);
    expect(flat.yMin).toBe(129 * TB);
    expect(flat.yMax).toBe(131 * TB);

    const nearZero = niceByteDomain(0, 4);
    expect(nearZero.yMin).toBe(0);
    expect(nearZero.baselineLabel).toBeNull();

    expect(niceByteDomain(0, 0)).toEqual({ yMin: 0, yMax: 1, ticks: [], baselineLabel: null });
  });
});

describe('trendTimeTicks — honest sparse UTC ticks', () => {
  it('a 30d window gets weekly midnight-aligned ticks, none hugging the edges', () => {
    const start = 100; // deliberately off-midnight — ticks must still align to UTC days
    const ticks = trendTimeTicks(start, start + 30 * DAY);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    for (const t of ticks) {
      expect(t.x).toBeGreaterThanOrEqual(4);
      expect(t.x).toBeLessThanOrEqual(96);
      expect(t.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/); // "Jan 8"
    }
  });

  it('adds a year suffix when the window crosses a year boundary', () => {
    const start = Date.UTC(2025, 11, 1) / 1000;
    const end = Date.UTC(2026, 0, 30) / 1000;
    const ticks = trendTimeTicks(start, end);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => /'2\d$/.test(t.label))).toBe(true);
  });
});

describe('trendGeometry — the chart in (x%, ypx) space', () => {
  const step = 4 * 3_600;
  const end = 30 * DAY;
  const tower = series(
    'haynestower',
    [
      { t: 0, freeBytes: 120 * TB },
      { t: end / 2, freeBytes: 116 * TB },
      { t: end, freeBytes: 112 * TB },
    ],
    { totalBytes: 530 * TB, targetPct: 80 }, // ⇒ 106 TB free floor
  );
  const music = series('cephfs', [{ t: end, freeBytes: 130 * TB }]);

  it('returns null when nothing is drawable (empty series ⇒ the note states, not a blank chart)', () => {
    expect(trendGeometry({ start: 0, end, stepSeconds: step, series: [] }, H)).toBeNull();
    expect(
      trendGeometry({ start: 0, end, stepSeconds: step, series: [series('haynestower', [])] }, H),
    ).toBeNull();
  });

  it('maps points, target floor, and fitted round ticks onto the fixed-height plot', () => {
    // Points here sit half-a-window apart, so the "step" for THIS pure-geometry case is end/2 —
    // consecutive samples must read as adjacent (the gap-breaker has its own test below).
    const g = trendGeometry({ start: 0, end, stepSeconds: end / 2, series: [tower, music] }, H)!;
    // Fitted domain over [106 TB target … 130 TB max] ⇒ 100–140 TB on 10 TB gridlines.
    expect(g.yMin).toBe(100 * TB);
    expect(g.yMax).toBe(140 * TB);
    expect(g.yTicks.map((t) => t.label)).toEqual(['110 TB', '120 TB', '130 TB', '140 TB']);
    expect(g.baselineLabel).toBe('100 TB');

    const towerG = g.series.find((s) => s.key === 'haynestower')!;
    expect(towerG.path).toBe(
      `M 0 ${y(120 * TB, g.yMin, g.yMax)} L 50 ${y(116 * TB, g.yMin, g.yMax)} L 100 ${y(112 * TB, g.yMin, g.yMax)}`,
    );
    expect(towerG.end).toMatchObject({
      x: 100,
      y: y(112 * TB, g.yMin, g.yMax),
      freeBytes: 112 * TB,
    });

    // The dashed floor: 20% free of 530 TB = 106 TB, labeled.
    expect(g.target).toMatchObject({ y: y(106 * TB, g.yMin, g.yMax), freeBytes: 106 * TB });
    expect(g.target!.label).toBe('Target · 106 TB free');

    // Full-window data ⇒ no retention note.
    expect(g.historyBegins).toBeNull();
  });

  it('a lone sample paints as a dot (round-cap zero-length segment), and wide gaps break the line', () => {
    const g = trendGeometry({ start: 0, end, stepSeconds: step, series: [music] }, H)!;
    expect(g.series.find((s) => s.key === 'cephfs')!.path).toBe(
      `M 100 ${y(130 * TB, g.yMin, g.yMax)} h 0.01`,
    );

    const gappy = series('haynestower', [
      { t: 0, freeBytes: 120 * TB },
      { t: step, freeBytes: 119 * TB },
      { t: step * 5, freeBytes: 118 * TB }, // 4-step hole > the 2.5-step bridge limit
      { t: step * 6, freeBytes: 117 * TB },
    ]);
    const g2 = trendGeometry({ start: 0, end, stepSeconds: step, series: [gappy] }, H)!;
    const path = g2.series[0]!.path!;
    expect(path.match(/M /g)).toHaveLength(2); // two segments — the outage is a visible hole
  });

  it('nudges converging end-labels apart (≥18px) without moving the markers', () => {
    // Two arrays ending on the SAME value — the labels would sit exactly on top of each other.
    const a = series('haynestower', [{ t: end, freeBytes: 112 * TB }]);
    const b = series('cephfs', [{ t: end, freeBytes: 112 * TB }]);
    const g = trendGeometry({ start: 0, end, stepSeconds: step, series: [a, b] }, H)!;
    const [top, bottom] = [...g.series].sort((s1, s2) => s1.end!.labelY - s2.end!.labelY);
    expect(bottom!.end!.labelY - top!.end!.labelY).toBeGreaterThanOrEqual(18);
    // Markers stay on the data: the nudge moves labelY only, never the dot's y.
    expect(g.series.every((s) => s.end!.y === y(s.end!.freeBytes, g.yMin, g.yMax))).toBe(true);
  });

  it('names where history begins when Prometheus retention undercuts the window', () => {
    const late = series('haynestower', [
      { t: 10 * DAY, freeBytes: 120 * TB }, // epoch + 10d = 1970-01-11 UTC
      { t: end, freeBytes: 112 * TB },
    ]);
    const g = trendGeometry({ start: 0, end, stepSeconds: step, series: [late] }, H)!;
    expect(g.historyBegins).toBe('Jan 11');
  });
});

describe('legend + window options', () => {
  it('trendLegendValue reads the CURRENT (last) point, or says there is no history', () => {
    const s = series('haynestower', [
      { t: 0, freeBytes: 120 * TB },
      { t: 1, freeBytes: 112.43 * TB },
    ]);
    expect(trendLegendValue(s)).toBe('HaynesTower · 112.4 TB free');
    expect(trendLegendValue(series('cephfs', []))).toBe('Music (CephFS) · no history yet');
  });

  it('offers exactly the four server-side windows', () => {
    expect(TREND_WINDOW_OPTIONS.map((o) => o.value)).toEqual(['7d', '30d', '90d', '365d']);
    expect(TREND_WINDOW_OPTIONS.map((o) => o.label)).toEqual(['7d', '30d', '90d', '1y']);
  });
});
