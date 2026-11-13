// DESIGN-013 D-09 (story 819) — what the Capacity Forecast on the Storage tab draws and says, as
// pure functions of the `storage.forecast` read (unit-tested in __tests__/storage-forecast.test.ts).
// The component is a thin binding over them.
//
// Each media array is one panel: two fixed tiles (the space target, 100% full), one sentence (the
// pace, or why there is no forecast), a plot, and the notes that qualify it. The tiles keep the
// same two slots in every state, so a new target can change their words and never the layout
// (ADR-015).
//
// The plot shares the free-space trend's coordinate system (lib/storage-trend.ts): x is a percent
// of the width and y is pixels of a fixed height, so every label is HTML at the same numbers. Free
// space is drawn from zero, because zero is the level the forecast is about (100% used).
//
// Types come TYPE-ONLY from @hnet/api (erased at compile; the client bundle never sees the server).
import type { StorageForecastJumps, StorageForecastReport, StorageForecastSeries } from '@hnet/api';
import { formatCapacity } from './storage';

export type { StorageForecastJumps, StorageForecastReport, StorageForecastSeries };

const DAY = 86_400;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------

/** "Nov 12", or "Jan 5, 2027" when the year is not the current one. UTC, like the trend's axis. */
export function forecastDayLabel(atSec: number, nowSec: number): string {
  const at = new Date(atSec * 1000);
  const sameYear = at.getUTCFullYear() === new Date(nowSec * 1000).getUTCFullYear();
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/**
 * Dates this far out are printed to the day, the month, and beyond that the year. Estimated from
 * D-08's measured standard errors of the rate (18% and 29%): one standard error moves a date half
 * a month at 52 to 83 days out, and half a year at 631 to 1017 days out (D-09).
 */
const DAY_PRECISION_DAYS = 60;
const MONTH_PRECISION_DAYS = 2 * 365.25;
/** Past this a date says nothing a reader can use. */
const FAR_FUTURE_DAYS = 1000 * 365.25;

/**
 * A forecast date in words: the date, no finer than the forecast can support, and how far away it
 * is. The read carries no error band (D-08), so the precision steps down with distance instead:
 * a day inside 60 days, a month inside 2 years, a year beyond.
 */
export function forecastDateWords(atSec: number, nowSec: number): { date: string; away: string } {
  const days = (atSec - nowSec) / DAY;
  if (!(days < FAR_FUTURE_DAYS)) return { date: 'Far off', away: 'in more than 1,000 years' };
  const at = new Date(atSec * 1000);

  let date: string;
  if (days <= DAY_PRECISION_DAYS) date = forecastDayLabel(atSec, nowSec);
  else if (days <= MONTH_PRECISION_DAYS) {
    date = at.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  } else date = String(at.getUTCFullYear());

  let away: string;
  if (days < 1) away = 'in less than a day';
  else if (days < 14) {
    const n = Math.round(days);
    away = `in ${n} ${n === 1 ? 'day' : 'days'}`;
  } else if (days < 63) away = `in about ${Math.round(days / 7)} weeks`;
  else if (days / 30.44 < 24) away = `in about ${Math.round(days / 30.44)} months`;
  else away = `in about ${Math.round((days / 365.25) * 2) / 2} years`;
  return { date, away };
}

/**
 * A pace amount to two significant figures in the page's capacity units ("210 GB", "1.5 TB"). The
 * rate is good to about a fifth on the recorded series (D-08), so a third figure would be noise.
 */
export function paceAmount(bytes: number): string {
  const size = Math.abs(bytes);
  if (!Number.isFinite(size) || size < 1) return '0 B';
  const unit = 10 ** (Math.floor(Math.log10(size)) - 1);
  return formatCapacity(Math.round(size / unit) * unit);
}

export type ForecastTone = 'filling' | 'draining' | 'steady' | 'none';

/** The chip beside the array's name. The tone picks its colour; the word is never colour alone. */
export const FORECAST_CHIP: Record<ForecastTone, string> = {
  filling: 'Filling',
  draining: 'Freeing up',
  steady: 'Steady',
  none: 'No forecast',
};

export interface ForecastTile {
  label: string;
  /** The date, or the state when there is no date. */
  value: string;
  detail: string;
}

function toneOf(series: StorageForecastSeries): ForecastTone {
  const f = series.forecast;
  if (!f.forecast) return f.reason === 'flat' ? 'steady' : 'none';
  return f.direction === 'filling' ? 'filling' : 'draining';
}

function targetLabel(targetPct: number | null): string {
  return targetPct == null ? 'Target' : `Target (${targetPct}% used)`;
}

const FULL_LABEL = 'Full (100% used)';

function targetTile(series: StorageForecastSeries, now: number): ForecastTile {
  const label = targetLabel(series.targetPct);
  const f = series.forecast;
  if (series.targetPct == null) {
    return { label, value: 'Not set', detail: 'no space target for this array' };
  }
  if (series.targetFreeBytes == null || f.origin == null) {
    return { label, value: 'Unknown', detail: 'the array could not be read' };
  }
  if (f.forecast && f.targetAt != null) {
    const when = forecastDateWords(f.targetAt, now);
    return {
      label,
      value: when.date,
      detail: f.direction === 'filling' ? `over target ${when.away}` : `back under ${when.away}`,
    };
  }
  const spare = f.origin.freeBytes - series.targetFreeBytes;
  if (spare < 0) {
    const rising = f.forecast && f.direction === 'filling';
    return {
      label,
      value: 'Over now',
      detail: `by ${formatCapacity(-spare)}${rising ? ', and rising' : ''}`,
    };
  }
  if (spare === 0) return { label, value: 'At target', detail: 'no room to spare' };
  const growing = f.forecast && f.direction === 'draining';
  return {
    label,
    value: 'Under now',
    detail: `${formatCapacity(spare)} to spare${growing ? ', and growing' : ''}`,
  };
}

function fullTile(series: StorageForecastSeries, now: number): ForecastTile {
  const f = series.forecast;
  if (!f.forecast) {
    return f.reason === 'flat'
      ? { label: FULL_LABEL, value: 'No date', detail: 'holding steady' }
      : { label: FULL_LABEL, value: 'No date yet', detail: 'not enough history' };
  }
  if (f.direction !== 'filling') {
    return { label: FULL_LABEL, value: 'Not ahead', detail: 'space is freeing up' };
  }
  if (f.fullAt == null) return { label: FULL_LABEL, value: 'Now', detail: 'no free space left' };
  const when = forecastDateWords(f.fullAt, now);
  return { label: FULL_LABEL, value: when.date, detail: when.away };
}

function windowDays(report: Pick<StorageForecastReport, 'start' | 'end'>): number {
  return Math.round((report.end - report.start) / DAY);
}

/** The pace, or in plain words why there is no forecast. */
function sentenceOf(series: StorageForecastSeries, report: StorageForecastReport): string {
  const f = series.forecast;
  const window = windowDays(report);
  if (f.forecast && f.rateBytesPerDay != null) {
    const perDay = paceAmount(f.rateBytesPerDay);
    const perWeek = paceAmount(f.rateBytesPerDay * 7);
    return f.direction === 'filling'
      ? `Filling by about ${perDay} a day (${perWeek} a week).`
      : `Freeing up about ${perDay} a day (${perWeek} a week).`;
  }
  if (f.reason === 'flat') {
    return `No forecast: free space has not clearly risen or fallen over the last ${window} days, so there is no date to predict.`;
  }
  const points = series.points;
  if (points.length === 0 && f.origin == null) {
    return 'No forecast: there are no free-space readings for this array yet.';
  }
  const needDays = Math.round(report.minSpanSeconds / DAY);
  const haveDays =
    points.length < 2 ? 0 : Math.round((points[points.length - 1]!.t - points[0]!.t) / DAY);
  if (haveDays < needDays) {
    return `No forecast yet: it needs ${needDays} days of readings and this array has ${haveDays} so far.`;
  }
  return `No forecast yet: too many readings are missing from the last ${window} days (${points.length} of the ${report.minPoints} it needs).`;
}

/**
 * True when the jumps the rate set aside moved free space more than the rate itself did over the
 * window. The forecast still stands on the method's rate (D-08); the page says to read it with
 * care (D-09, the Q-03 case).
 */
export function jumpsOutweighPace(
  jumps: StorageForecastJumps,
  rateBytesPerDay: number,
  days: number,
): boolean {
  return Math.abs(jumps.rises.bytes - jumps.falls.bytes) > Math.abs(rateBytesPerDay) * days;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The set-aside jumps in plain words (D-09): what happened, what the projection did with it. */
export function jumpNote(jumps: StorageForecastJumps, days: number, now: number): string {
  const { rises, falls } = jumps;
  const latest = `just before ${forecastDayLabel(jumps.latestAt, now)}`;
  const total = rises.count + falls.count;

  let what: string;
  if (falls.count === 0) {
    what = `Free space jumped up by ${formatCapacity(rises.bytes)} in the last ${days} days (${
      rises.count === 1 ? `1 jump, ${latest}` : `${rises.count} jumps, the latest ${latest}`
    }).`;
  } else if (rises.count === 0) {
    what = `Free space dropped suddenly by ${formatCapacity(falls.bytes)} in the last ${days} days (${
      falls.count === 1 ? `1 drop, ${latest}` : `${falls.count} drops, the latest ${latest}`
    }).`;
  } else {
    what = `In the last ${days} days free space dropped suddenly by ${formatCapacity(falls.bytes)} (${plural(
      falls.count,
      'drop',
      'drops',
    )}) and jumped up by ${formatCapacity(rises.bytes)} (${plural(rises.count, 'jump', 'jumps')}), the latest ${latest}.`;
  }

  const treated = jumps.partlyCounted
    ? 'There were more of them than the projection sets aside, so some now count toward its pace.'
    : total === 1
      ? 'The projection treats it as a one-off: it moves the starting point, not the pace.'
      : 'The projection treats them as one-offs: they move the starting point, not the pace.';

  const net = rises.bytes - falls.bytes;
  const ifMore =
    net < 0
      ? ' If drops like these keep coming, the array will have less free space than projected.'
      : net > 0
        ? ' If jumps like these keep coming, the array will have more free space than projected.'
        : '';
  return `${what} ${treated}${ifMore}`;
}

export const FORECAST_CAUTION =
  'Read this forecast with care: sudden changes moved free space more than the steady pace did.';

// ---------------------------------------------------------------------------------------------------
// The plot
// ---------------------------------------------------------------------------------------------------

export interface ForecastXLabel {
  /** Percent of the plot width. */
  x: number;
  label: string;
  /** `event` is a forecast date under its mark, `today` the start of the projection. */
  kind: 'event' | 'today' | 'tick';
}

export interface ForecastPlot {
  yTicks: { y: number; label: string }[];
  /** The samples the rate was read from, then the level: gap-aware, like the trend's lines. */
  history: string | null;
  /** From the level, at the rate, to the last date the forecast gives. */
  projection: string | null;
  /** The level the projection starts from. */
  today: { x: number; y: number } | null;
  /** Where the projection meets the target floor and where it meets zero. */
  marks: { kind: 'target' | 'full'; x: number; y: number }[];
  /**
   * The dashed floor. `labelEnd` is where its label ends, in percent of the width: the right edge,
   * or a target mark that sits in the right half (the label stops short of it).
   */
  target: { y: number; label: string; labelEnd: number } | null;
  xLabels: ForecastXLabel[];
}

const PLOT_TOP_PAD = 6; // the trend's: keeps a 2px stroke's crown inside the plot
/**
 * The axis tops out this far above the highest value drawn. At the plot's 160px that leaves 22px
 * over a target floor that is the highest value, room for its label above the rule.
 */
const HEADROOM = 1.12;
/** Room right of the last mark, as a share of the drawn span, so its dot is never cut. */
const HORIZON_PAD = 0.06;
/** Half an axis label's width in px, from its length (10 to 11px text), so CSS can keep it inside the plot. */
export function forecastLabelHalfPx(label: string): number {
  return Math.ceil(label.length * 3.2) + 2;
}
/**
 * The narrowest plot the page draws: the card at the 390px phone width, less the byte-axis gutter
 * (measured, D-09). Whether two axis labels would touch is decided at this width, so what fits
 * here fits everywhere wider.
 */
const NARROWEST_PLOT_PX = 278;
/** The gap kept between two axis labels, in px at that width. */
const LABEL_GAP_PX = 8;

/**
 * Sparse calendar ticks for any span from days to centuries: the finest of day, month and year
 * steps that gives at most about four labels, on UTC boundaries, kept off the edges.
 */
export function forecastTimeTicks(
  startSec: number,
  endSec: number,
): { x: number; label: string }[] {
  const span = endSec - startSec;
  if (!(span > 0)) return [];
  const spanDays = span / DAY;
  const at = (ms: number): number => ((ms / 1000 - startSec) / span) * 100;
  const keep = (ticks: { x: number; label: string }[]) =>
    ticks.filter((t) => t.x >= 4 && t.x <= 96).map((t) => ({ x: round2(t.x), label: t.label }));

  const dayStep = [1, 2, 7, 14].find((d) => spanDays / d <= 4.5);
  if (dayStep !== undefined) {
    const ticks: { x: number; label: string }[] = [];
    const first = Math.ceil((startSec * 1000) / (DAY * 1000)) * DAY * 1000;
    for (let ms = first; ms <= endSec * 1000; ms += dayStep * DAY * 1000) {
      ticks.push({ x: at(ms), label: forecastDayLabel(ms / 1000, startSec) });
    }
    return keep(ticks);
  }

  const start = new Date(startSec * 1000);
  const monthStep = [1, 2, 3, 6].find((m) => spanDays / (30.44 * m) <= 4.5);
  if (monthStep !== undefined) {
    const ticks: { x: number; label: string }[] = [];
    let index = start.getUTCFullYear() * 12 + start.getUTCMonth();
    index = Math.ceil(index / monthStep) * monthStep;
    for (let i = 0; i < 12; i++, index += monthStep) {
      const ms = Date.UTC(Math.floor(index / 12), index % 12, 1);
      if (ms > endSec * 1000) break;
      const label = new Date(ms).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
      ticks.push({ x: at(ms), label });
    }
    return keep(ticks);
  }

  const yearStep = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(
    (y) => spanDays / (365.25 * y) <= 4.5,
  );
  if (yearStep === undefined) return [];
  const ticks: { x: number; label: string }[] = [];
  let year = Math.ceil(start.getUTCFullYear() / yearStep) * yearStep;
  for (let i = 0; i < 12; i++, year += yearStep) {
    const ms = Date.UTC(year, 0, 1);
    if (ms > endSec * 1000) break;
    ticks.push({ x: at(ms), label: String(year) });
  }
  return keep(ticks);
}

/** Round gridline values for a zero-based byte axis that tops out at `yMax`: two to five. */
function byteTicks(yMax: number): number[] {
  const raw = yMax / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((c) => c >= raw)!;
  const ticks: number[] = [];
  for (let v = step; v <= yMax; v += step) ticks.push(v);
  return ticks;
}

/**
 * The plot for one array, or null when there is nothing to draw (no projection and under two
 * readings). The horizon comes from the data: the plot always starts at the oldest sample and
 * ends a little after the last date the forecast gives, so the answer is on the chart whether it
 * is weeks or years away and the axis changes its units to suit. A rate with no date ahead
 * (space freeing up with no target to reach) is drawn as far forward as the history looks back.
 */
export function forecastPlot(
  series: StorageForecastSeries,
  report: Pick<StorageForecastReport, 'start' | 'end' | 'stepSeconds' | 'now'>,
  height: number,
): ForecastPlot | null {
  const f = series.forecast;
  const origin = f.origin;
  const floor = series.targetFreeBytes;

  const history = series.points.filter((p) => origin == null || p.t <= origin.t);
  if (origin && (history.length === 0 || origin.t > history[history.length - 1]!.t)) {
    history.push(origin);
  }

  // Where the projection ends: zero while filling, the target floor while freeing up below it.
  let end: { t: number; v: number } | null = null;
  if (f.forecast && f.rateBytesPerDay != null && origin) {
    if (f.direction === 'filling') {
      if (f.fullAt != null) end = { t: f.fullAt, v: 0 };
    } else if (f.targetAt != null && floor != null) {
      end = { t: f.targetAt, v: floor };
    } else {
      const window = report.end - report.start;
      let t = origin.t + window;
      let v = origin.freeBytes + f.rateBytesPerDay * (window / DAY);
      if (series.totalBytes != null && v > series.totalBytes) {
        v = series.totalBytes; // free space cannot pass the array's size
        t = origin.t + ((v - origin.freeBytes) / f.rateBytesPerDay) * DAY;
      }
      if (t > origin.t) end = { t, v };
    }
  }
  if (history.length < 2 && end === null) return null;

  const t0 = history[0]!.t;
  const tLast = end ? end.t : history[history.length - 1]!.t;
  if (!(tLast > t0)) return null;
  const t1 = tLast + HORIZON_PAD * (tLast - t0);

  const top = Math.max(...history.map((p) => p.freeBytes), end?.v ?? 0, floor ?? 0);
  if (!(top > 0)) return null;
  const yMax = top * HEADROOM;

  const x = (t: number): number => round2(((t - t0) / (t1 - t0)) * 100);
  const y = (v: number): number =>
    round2(PLOT_TOP_PAD + (1 - Math.max(v, 0) / yMax) * (height - PLOT_TOP_PAD - 1));

  // Gap-aware, as on the trend: a hole wider than 2.5 steps breaks the line.
  const maxGap = report.stepSeconds * 2.5;
  let path = '';
  let prevT: number | null = null;
  let segment = 0;
  for (const p of history) {
    if (prevT === null || p.t - prevT > maxGap) {
      if (segment === 1) path += ' h 0.01';
      path += `${path ? ' ' : ''}M ${x(p.t)} ${y(p.freeBytes)}`;
      segment = 1;
    } else {
      path += ` L ${x(p.t)} ${y(p.freeBytes)}`;
      segment += 1;
    }
    prevT = p.t;
  }
  if (segment === 1) path += ' h 0.01';

  const marks: ForecastPlot['marks'] = [];
  if (f.forecast && f.targetAt != null && floor != null) {
    marks.push({ kind: 'target', x: x(f.targetAt), y: y(floor) });
  }
  if (f.forecast && f.direction === 'filling' && f.fullAt != null) {
    marks.push({ kind: 'full', x: x(f.fullAt), y: y(0) });
  }

  // Axis labels, most important first: the last forecast date, the other one, today, then the
  // calendar. A label that would crowd one already placed is dropped.
  const events = [
    ...(f.forecast && f.direction === 'filling' && f.fullAt != null ? [f.fullAt] : []),
    ...(f.forecast && f.targetAt != null && floor != null ? [f.targetAt] : []),
  ].sort((a, b) => b - a);
  const candidates: ForecastXLabel[] = [
    ...events.map((t) => ({
      x: x(t),
      label: forecastDateWords(t, report.now).date,
      kind: 'event' as const,
    })),
    ...(origin
      ? [
          {
            x: x(origin.t),
            label: report.now - origin.t <= DAY ? 'Today' : forecastDayLabel(origin.t, report.now),
            kind: 'today' as const,
          },
        ]
      : []),
    ...forecastTimeTicks(t0, t1).map((t) => ({ ...t, kind: 'tick' as const })),
  ];
  // A label is centred on its x and pulled inside the plot's edges; two touch when their centres
  // are closer than their half-widths plus the gap, all taken at the narrowest plot.
  const half = (l: ForecastXLabel): number =>
    (forecastLabelHalfPx(l.label) / NARROWEST_PLOT_PX) * 100;
  const centre = (l: ForecastXLabel): number => Math.min(Math.max(l.x, half(l)), 100 - half(l));
  const gap = (LABEL_GAP_PX / NARROWEST_PLOT_PX) * 100;
  const xLabels: ForecastXLabel[] = [];
  for (const c of candidates) {
    // Calendar ticks are spaced by construction, so one only has to clear the dates and "Today".
    const rivals = c.kind === 'tick' ? xLabels.filter((p) => p.kind !== 'tick') : xLabels;
    if (rivals.every((p) => Math.abs(centre(p) - centre(c)) >= half(p) + half(c) + gap)) {
      xLabels.push(c);
    }
  }

  return {
    yTicks: byteTicks(yMax).map((v) => ({ y: y(v), label: formatCapacity(v) })),
    history: history.length >= 2 ? path : null,
    projection:
      end && origin ? `M ${x(origin.t)} ${y(origin.freeBytes)} L ${x(end.t)} ${y(end.v)}` : null,
    today: origin ? { x: x(origin.t), y: y(origin.freeBytes) } : null,
    marks,
    target:
      floor != null
        ? {
            y: y(floor),
            label: `Target · ${formatCapacity(floor)} free`,
            labelEnd: marks.find((m) => m.kind === 'target' && m.x > 50)?.x ?? 100,
          }
        : null,
    xLabels: xLabels.sort((a, b) => a.x - b.x),
  };
}

// ---------------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------------

export interface ForecastPanel {
  key: string;
  label: string;
  tone: ForecastTone;
  chip: string;
  target: ForecastTile;
  full: ForecastTile;
  /** The pace, or why there is no forecast. */
  sentence: string;
  /** True when the set-aside jumps outweigh the pace: the notes open with `FORECAST_CAUTION`. */
  caution: boolean;
  /** What qualifies this array's forecast, in order. */
  notes: string[];
  plot: ForecastPlot | null;
  /** What the plot's place says when there is nothing to draw. */
  emptyPlot: string;
  /** Everything above in one line, for a reader who cannot see the plot. */
  summary: string;
}

function summarise(label: string, sentence: string, target: ForecastTile, full: ForecastTile) {
  return `${label}. ${sentence} ${target.label}: ${target.value}, ${target.detail}. ${full.label}: ${full.value}, ${full.detail}.`;
}

/** One array of the read, as the panel that draws and says it. */
export function forecastPanel(
  series: StorageForecastSeries,
  report: StorageForecastReport,
  plotHeight: number,
): ForecastPanel {
  const f = series.forecast;
  const days = windowDays(report);
  const target = targetTile(series, report.now);
  const full = fullTile(series, report.now);
  const sentence = sentenceOf(series, report);

  const notes: string[] = [];
  const caution =
    series.jumps != null &&
    f.rateBytesPerDay != null &&
    jumpsOutweighPace(series.jumps, f.rateBytesPerDay, days);
  if (caution) notes.push(FORECAST_CAUTION);
  if (series.jumps) notes.push(jumpNote(series.jumps, days, report.now));
  if (f.origin && report.now - f.origin.t > DAY) {
    notes.push(
      `The starting point is the reading from ${forecastDayLabel(f.origin.t, report.now)}: the live free space could not be read.`,
    );
  }

  return {
    key: series.key,
    label: series.label,
    tone: toneOf(series),
    chip: FORECAST_CHIP[toneOf(series)],
    target,
    full,
    sentence,
    caution,
    notes,
    plot: forecastPlot(series, report, plotHeight),
    emptyPlot: 'Nothing to plot yet.',
    summary: summarise(series.label, sentence, target, full),
  };
}

export type ForecastLoadState =
  { kind: 'ready' } | { kind: 'loading' } | { kind: 'error'; message: string };

export const FORECAST_UNAVAILABLE =
  'Forecast unavailable: couldn’t reach Prometheus right now. The meters above still show live utilization.';

/** The array list the page already holds (`storage.utilization`), enough to keep a panel's place. */
export interface ForecastArrayRef {
  key: string;
  label: string;
  target: number | null;
}

function placeholderPanel(array: ForecastArrayRef, state: ForecastLoadState): ForecastPanel {
  const loading = state.kind === 'loading';
  const sentence = loading
    ? 'Loading forecast…'
    : state.kind === 'error'
      ? `Failed to load the forecast: ${state.message}`
      : FORECAST_UNAVAILABLE;
  const tile = (label: string): ForecastTile =>
    loading
      ? { label, value: '…', detail: 'loading' }
      : { label, value: 'No date', detail: 'forecast unavailable' };
  const target = tile(targetLabel(array.target));
  const full = tile(FULL_LABEL);
  return {
    key: array.key,
    label: array.label,
    tone: 'none',
    chip: loading ? '…' : FORECAST_CHIP.none,
    target,
    full,
    sentence,
    caution: false,
    notes: [],
    plot: null,
    emptyPlot: loading ? 'Loading forecast…' : 'No plot while the forecast is unavailable.',
    summary: `${array.label}. ${sentence}`,
  };
}

/**
 * The panels for every state of the read. With a forecast: one per array of the read. Without one
 * (loading, failed, Prometheus down): one per array the page already knows, in the same shape, so
 * the card keeps its geometry while the read is away (ADR-015).
 */
export function forecastPanels(
  report: StorageForecastReport | undefined,
  arrays: readonly ForecastArrayRef[],
  state: ForecastLoadState,
  plotHeight: number,
): ForecastPanel[] {
  if (report && !report.unavailable) {
    return report.series.map((series) => forecastPanel(series, report, plotHeight));
  }
  const why: ForecastLoadState = report?.unavailable ? { kind: 'ready' } : state;
  return arrays.map((array) => placeholderPanel(array, why));
}

/** The card's caption: what the projection is, and that it is one. */
export function forecastCaption(report: StorageForecastReport | undefined): string {
  const days = report ? windowDays(report) : 90;
  return `When each media array reaches its space target and when it is full, if free space keeps changing at the pace of the last ${days} days. An estimate, not a schedule.`;
}

/** How the pace is read, for the card's footnote (D-08's measured trade, in plain words). */
export const FORECAST_METHOD_NOTE =
  'The pace is the usual daily change in free space, with sudden jumps set aside, carried forward from today’s level. A real change of pace shows up slowly: about half of it after six weeks, all of it within three months.';

/** The card's key. Static, so nothing a reader does can change its wrapping (ADR-015). */
export const FORECAST_LEGEND: readonly { key: string; label: string }[] = [
  { key: 'history', label: 'Free space so far' },
  { key: 'today', label: 'Today' },
  { key: 'filling', label: 'Projection while filling' },
  { key: 'draining', label: 'Projection while freeing up' },
  { key: 'target', label: 'Space target' },
];
