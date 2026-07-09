// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — pure geometry + presentation helpers for the
// native free-space trend chart on the Storage tab. All pure (unit-tested in
// __tests__/storage-trend.test.ts); the component stays a thin binding over trpc.storage.trend.
//
// Coordinate system (the reclaim-strip school, extended): the SVG draws in a NORMALIZED space —
// x in 0..100 (percent of whatever width the card has) and y in real pixels of the FIXED plot
// height — under `preserveAspectRatio="none"` + non-scaling strokes. Text never lives inside the
// SVG (it would stretch); labels are HTML positioned by the same (x%, ypx) numbers, so the chart
// is responsive with zero measurement code and no dependencies.
//
// Types come TYPE-ONLY from @hnet/api (erased at compile — the client bundle never sees the server
// package; the same rule as lib/storage.ts's @hnet/domain imports).
import type { StorageTrendReport, StorageTrendSeries, TrendWindow } from '@hnet/api';
import { formatCapacity } from './storage';

export type { StorageTrendReport, StorageTrendSeries, TrendWindow };

/** The window switcher's options — `label` is the seg button, `description` the caption suffix. */
export const TREND_WINDOW_OPTIONS: readonly {
  value: TrendWindow;
  label: string;
  description: string;
}[] = [
  { value: '7d', label: '7d', description: 'last 7 days' },
  { value: '30d', label: '30d', description: 'last 30 days' },
  { value: '90d', label: '90d', description: 'last 90 days' },
  { value: '365d', label: '1y', description: 'last year' },
];

export function trendWindowDescription(window: TrendWindow): string {
  return TREND_WINDOW_OPTIONS.find((o) => o.value === window)?.description ?? window;
}

/**
 * A FITTED y-domain on clean byte ticks: the axis brackets [min(data, target) … max(data)] with a
 * step from the {1, 2, 2.5, 5} × 10^n family, snapped outward to whole steps. Lines encode by
 * POSITION (not length), so a fitted baseline is the legible choice here — a zero-based axis on a
 * multi-hundred-TB array crushes a 10 TB drain into a flat line and buries the target floor. The
 * truncation is kept honest: gridlines carry round labels and a NON-ZERO baseline is explicitly
 * labeled (`baselineLabel`). Flat data still gets a ±5%-of-max spread so a steady line sits
 * mid-plot instead of on an axis edge. `ticks` excludes the baseline itself (that gridline IS the
 * canvas border, labeled separately).
 */
export function niceByteDomain(
  minBytes: number,
  maxBytes: number,
  targetCount = 4,
): { yMin: number; yMax: number; ticks: number[]; baselineLabel: string | null } {
  if (!(maxBytes > 0)) return { yMin: 0, yMax: 1, ticks: [], baselineLabel: null };
  const spread = Math.max(maxBytes - minBytes, maxBytes * 0.05);
  const lo = Math.max(minBytes - spread * 0.08, 0);
  const hi = maxBytes + spread * 0.08;
  const raw = (hi - lo) / targetCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  const step = candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1]!;
  const yMin = Math.max(Math.floor(lo / step) * step, 0);
  const yMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = yMin + step; v <= yMax + step / 1e6; v += step) ticks.push(v);
  return { yMin, yMax, ticks, baselineLabel: yMin > 0 ? formatCapacity(yMin) : null };
}

/** "112.4 TB" axis/legend capacity — formatCapacity, re-exported so the chart has ONE formatter. */
export const formatTrendBytes = formatCapacity;

const DAY_MS = 86_400_000;

/** A UTC "Jul 3" / "Jul 3 '26" tick label (year suffix only when the window crosses a year edge). */
function tickLabel(ms: number, withYear: boolean): string {
  const d = new Date(ms);
  const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return withYear ? `${base} '${String(d.getUTCFullYear() % 100).padStart(2, '0')}` : base;
}

/**
 * Honest, sparse x-ticks: UTC-midnight-aligned, at the smallest whole-day interval that yields
 * ≤ ~4 labels across the window, kept off the edges (labels are centered on their tick, so a tick
 * hugging 0%/100% would clip outside the card).
 */
export function trendTimeTicks(
  startSec: number,
  endSec: number,
): { x: number; label: string }[] {
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;
  const span = endMs - startMs;
  if (!(span > 0)) return [];
  const windowDays = span / DAY_MS;
  const intervalDays = [1, 2, 7, 14, 30, 61, 91, 182].find((d) => windowDays / d <= 4.5) ?? 365;
  const withYear =
    new Date(startMs).getUTCFullYear() !== new Date(endMs).getUTCFullYear();

  const ticks: { x: number; label: string }[] = [];
  const firstMidnight = Math.ceil(startMs / DAY_MS) * DAY_MS;
  for (let t = firstMidnight; t <= endMs; t += intervalDays * DAY_MS) {
    const x = ((t - startMs) / span) * 100;
    if (x < 4 || x > 96) continue; // centered labels near an edge would clip the card
    ticks.push({ x: round2(x), label: tickLabel(t, withYear) });
  }
  return ticks;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface TrendSeriesGeometry {
  key: string;
  label: string;
  /** Gap-aware SVG path in (x%, ypx) space; null when the series has no points. */
  path: string | null;
  /** The last point — the end marker + direct label anchor. `labelY` is collision-nudged. */
  end: { x: number; y: number; labelY: number; freeBytes: number } | null;
}

export interface TrendGeometry {
  yMin: number;
  yMax: number;
  yTicks: { y: number; value: number; label: string }[];
  /** The explicit label of a NON-ZERO baseline (fitted-domain honesty); null when the axis
   *  starts at 0. Rendered inside the bottom-left corner of the plot. */
  baselineLabel: string | null;
  xTicks: { x: number; label: string }[];
  series: TrendSeriesGeometry[];
  /** The dashed free-bytes floor (the first array carrying a target — HaynesTower today). */
  target: { y: number; freeBytes: number; label: string } | null;
  /** Set when the data starts visibly after the window does (Prometheus retention) — the honest
   *  "history begins …" footnote. */
  historyBegins: string | null;
}

const PLOT_TOP_PAD = 6; // keeps the 2px stroke's crown + top gridline inside the plot

/**
 * The full chart geometry for one report. Returns null when there is nothing to draw (every
 * series empty) — the component renders its fixed-height empty/degraded note instead.
 */
export function trendGeometry(
  report: Pick<StorageTrendReport, 'start' | 'end' | 'stepSeconds' | 'series'>,
  height: number,
): TrendGeometry | null {
  const drawn = report.series.filter((s) => s.points.length > 0);
  if (drawn.length === 0) return null;

  const span = report.end - report.start;
  if (!(span > 0)) return null;

  const targetSeries = report.series.find((s) => s.targetFreeBytes != null) ?? null;
  const values = [
    ...report.series.flatMap((s) => s.points.map((p) => p.freeBytes)),
    ...(targetSeries ? [targetSeries.targetFreeBytes!] : []),
  ];
  const { yMin, yMax, ticks, baselineLabel } = niceByteDomain(
    Math.min(...values),
    Math.max(...values),
  );

  const x = (t: number): number => round2(((t - report.start) / span) * 100);
  const y = (v: number): number =>
    round2(PLOT_TOP_PAD + (1 - (v - yMin) / (yMax - yMin)) * (height - PLOT_TOP_PAD - 1));

  // Gap-aware line paths: a hole wider than 2.5 steps breaks the line (an exporter outage must
  // read as MISSING, never as a confident straight bridge). Lone samples paint as round-cap dots.
  const maxGap = report.stepSeconds * 2.5;
  const series: TrendSeriesGeometry[] = report.series.map((s) => {
    if (s.points.length === 0) return { key: s.key, label: s.label, path: null, end: null };
    let path = '';
    let prevT: number | null = null;
    let segmentLen = 0;
    for (const p of s.points) {
      const gap = prevT === null || p.t - prevT > maxGap;
      if (gap) {
        if (segmentLen === 1) path += ' h 0.01'; // zero-ish length + round cap ⇒ a visible dot
        path += `${path ? ' ' : ''}M ${x(p.t)} ${y(p.freeBytes)}`;
        segmentLen = 1;
      } else {
        path += ` L ${x(p.t)} ${y(p.freeBytes)}`;
        segmentLen += 1;
      }
      prevT = p.t;
    }
    if (segmentLen === 1) path += ' h 0.01';
    const last = s.points[s.points.length - 1]!;
    const endY = y(last.freeBytes);
    return {
      key: s.key,
      label: s.label,
      path,
      // The label floats 9px ABOVE the line so the (near-horizontal) series stroke never runs
      // through its own name — the dot stays on the data at `y`.
      end: { x: x(last.t), y: endY, labelY: endY - 9, freeBytes: last.freeBytes },
    };
  });

  // Direct end-labels: nudge apart vertically when two line-ends converge (min 18px gap), keeping
  // every label inside the plot. Two series today — pairwise is all that's needed.
  const labeled = series.filter((s) => s.end !== null);
  labeled.sort((a, b) => a.end!.labelY - b.end!.labelY);
  const MIN_GAP = 18;
  for (let i = 1; i < labeled.length; i++) {
    const prev = labeled[i - 1]!.end!;
    const cur = labeled[i]!.end!;
    if (cur.labelY - prev.labelY < MIN_GAP) cur.labelY = prev.labelY + MIN_GAP;
  }
  for (const s of labeled) {
    s.end!.labelY = Math.min(Math.max(s.end!.labelY, 10), height - 10);
  }

  // The retention honesty note: data that starts visibly after the window does gets named.
  const firstT = Math.min(...drawn.map((s) => s.points[0]!.t));
  const historyBegins =
    firstT - report.start > report.stepSeconds * 2
      ? tickLabel(firstT * 1000, false)
      : null;

  return {
    yMin,
    yMax,
    yTicks: ticks.map((v) => ({ y: y(v), value: v, label: formatCapacity(v) })),
    baselineLabel,
    xTicks: trendTimeTicks(report.start, report.end),
    series,
    target: targetSeries
      ? {
          y: y(targetSeries.targetFreeBytes!),
          freeBytes: targetSeries.targetFreeBytes!,
          label: `Target · ${formatCapacity(targetSeries.targetFreeBytes!)} free`,
        }
      : null,
    historyBegins,
  };
}

/** "HaynesTower · 112.4 TB free" — one legend entry's text (identity dot is the component's). */
export function trendLegendValue(series: StorageTrendSeries): string {
  const last = series.points[series.points.length - 1];
  if (!last) return `${series.label} · no history yet`;
  return `${series.label} · ${formatCapacity(last.freeBytes)} free`;
}
