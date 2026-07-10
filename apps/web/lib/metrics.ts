// ADR-037 / DESIGN-016 — pure presentation helpers for the Metrics Overview (unit-tested; no React,
// no tokens — the meter TONE is a CSS class, the color lives in tokens.css).

export type MeterTone = 'ok' | 'warn' | 'danger' | 'muted';

/**
 * The meter tone by utilization %: null (unknown/unreachable) ⇒ muted; ≥ 90% ⇒ danger; ≥ 75% ⇒ warn;
 * else ok. Recolors the SAME geometry (ADR-028 --meter-tone seam) — never a layout change (ADR-015).
 */
export function meterTone(pct: number | null): MeterTone {
  if (pct === null) return 'muted';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/** Fill width (0..100) for a meter — 0 when the value is unknown; clamped so it never overflows. */
export function meterWidth(pct: number | null): number {
  if (pct === null) return 0;
  return Math.max(0, Math.min(pct, 100));
}

/** "11.6 Mbps" (server keeps one decimal) / "2.26 Gbps" for ≥ 1000 / "—" when unknown. */
export function formatMbps(mbps: number | null): string {
  if (mbps === null) return '—';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  return `${mbps} Mbps`;
}

/** "3.9%" or "—". */
export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

// DESIGN-018 — Apps sub-tab formatters (pure; the byte scale reuses lib/storage's formatCapacity).

/** "9,564" / "—" — an integer count with thousands separators (null-safe). */
export function formatCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** "18/hr" / "—" — an events-per-hour rate, rounded (sub-1 non-zero rates show "<1/hr"). */
export function formatPerHour(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 1) return '<1/hr';
  return `${Math.round(n)}/hr`;
}

/** "335 ms" / "—" — a millisecond latency, rounded. */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

// DESIGN-019 — Network sub-tab formatters + the WAN-history sparkline geometry (pure; no React, no hex).

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build an SVG polyline `points` string mapping `values` into a `width`×`height` box (the series min sits
 * on the bottom edge, the max on the top). Empty ⇒ `''` (the caller renders nothing); a single point ⇒ a
 * flat mid-line. Deterministic + unit-tested so the sparkline needs no snapshot. ADR-015: the box is a
 * fixed geometry — only the polyline path changes as data refreshes, never the layout around it.
 */
export function sparklinePolyline(values: number[], width: number, height: number): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return '';
  if (finite.length === 1) {
    const y = round2(height / 2);
    return `0,${y} ${round2(width)},${y}`;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const stepX = width / (finite.length - 1);
  return finite
    .map((v, i) => `${round2(i * stepX)},${round2(height - ((v - min) / span) * height)}`)
    .join(' ');
}
