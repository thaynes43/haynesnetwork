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

// DESIGN-016 D-08 — the admin-editable WAN capacity denominators. These bounds MIRROR the server zod
// input on `metrics.capacity.set{Upload,Download}` (`z.number().int().min(0).max(1_000_000)`) so the
// inline editor rejects the same values the mutation would, client-side, before a round trip.
export const CAPACITY_MBPS_MIN = 0;
export const CAPACITY_MBPS_MAX = 1_000_000;

/** True when `mbps` is NOT a whole number inside [0, 1_000_000] — the client mirror of the server bound. */
export function capacityOutOfRange(mbps: number): boolean {
  return !Number.isInteger(mbps) || mbps < CAPACITY_MBPS_MIN || mbps > CAPACITY_MBPS_MAX;
}

/**
 * usage/capacity·100, one decimal, clamped ≥ 0; null when usage is unknown or capacity ≤ 0. A pure MIRROR
 * of `@hnet/metrics` `meterPct` so an OPTIMISTIC capacity edit recomputes the meter fill EXACTLY the way
 * the server will on reconcile — no flash of a stale-denominator fill (ADR-015: recolor/resize the same
 * geometry in place, never reflow the neighbors).
 */
export function meterPct(usageMbps: number | null, capacityMbps: number): number | null {
  if (usageMbps === null || capacityMbps <= 0) return null;
  return Math.round(Math.max(0, (usageMbps / capacityMbps) * 100) * 10) / 10;
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

// DESIGN-020 — Hardware sub-tab formatters (pure; null-safe).

/** "12,540 h" / "—" — power-on hours with thousands separators. */
export function formatHours(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return '—';
  return `${Math.round(h).toLocaleString('en-US')} h`;
}

// DESIGN-022 — AI usage sub-tab formatter (pure; null-safe). "how long" from summed ms.

/** A compact duration ("1h 5m" / "2m 30s" / "45s" / "0s" / "—") from milliseconds. */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** A friendly uptime ("12d 4h" / "3h" / "—") from seconds. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
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
