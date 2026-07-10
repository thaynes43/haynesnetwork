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
