// ADR-068 / DESIGN-040 D-05/D-07/D-08 — pure helpers for the estate play scoreboard (no
// React, no tokens — the lib/metrics.ts precedent). The badge MODEL lives here so the
// server component is a bare mapper and the ordering/formatting/absence rules are unit-
// tested without a render.

/** Structural mirror of `@hnet/metrics` EstatePlayTotals — the tRPC payload satisfies it. */
export interface ScoreboardTotals {
  moviePlays: number;
  episodePlays: number;
  trackPlays: number;
  hoursWatched: number;
  unavailable: boolean;
}

export interface ScoreboardBadge {
  label: string;
  value: string;
}

/**
 * D-08 — compact play counts, the GitHub-shields register: `< 1000` verbatim; thousands and
 * millions as one-decimal `k`/`M` with a trailing `.0` trimmed (25238 → "25.2k", 3449 →
 * "3.4k", 999951 → "1M"). Negative/non-finite inputs (never expected — the aggregator
 * clamps) render "0".
 */
export function formatPlays(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  for (const [unit, divisor] of [
    ['M', 1_000_000],
    ['k', 1_000],
  ] as const) {
    const scaled = Math.round((n / divisor) * 10) / 10;
    if (scaled >= 1000) continue; // 999,951 rounds to 1000.0k ⇒ promote to 1M
    if (n >= divisor) return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit}`;
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`;
}

/**
 * D-06/D-07 — the ordered badge model (Movies · TV episodes · Music · Hours watched), or
 * `null` when the aggregate is unavailable — the component renders NOTHING then (no empty
 * chrome; the greeting sits directly above the About tile as before).
 */
export function scoreboardBadges(totals: ScoreboardTotals): ScoreboardBadge[] | null {
  if (totals.unavailable) return null;
  return [
    { label: 'Movies', value: formatPlays(totals.moviePlays) },
    { label: 'TV episodes', value: formatPlays(totals.episodePlays) },
    { label: 'Music', value: formatPlays(totals.trackPlays) },
    { label: 'Hours watched', value: formatPlays(totals.hoursWatched) },
  ];
}
