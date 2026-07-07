// ADR-030 / DESIGN-013 D-05 (PLAN-013) — pure presentation helpers for /admin/storage: capacity
// formatting, the meter's severity tone against the space target, reclaim copy, the bang-for-buck
// share math, and the cumulative-strip step geometry. All pure (unit-tested in __tests__/storage.ts);
// the page component stays a thin binding over trpc.storage.*.
//
// Types come TYPE-ONLY from @hnet/domain (erased at compile time — the client bundle never sees the
// domain package or its pg dependency; same rule as the motd page's @hnet/db/schema note).
import type {
  ReclaimCumulativePoint,
  ReclaimTotals,
  ReclaimWindow,
  StorageArrayUtilization,
} from '@hnet/domain';
import { formatBytes } from './media';

export type { ReclaimWindow, StorageArrayUtilization };

/** The window switcher's options — `label` is the seg button, `description` the headline suffix. */
export const RECLAIM_WINDOW_OPTIONS: readonly {
  value: ReclaimWindow;
  label: string;
  description: string;
}[] = [
  { value: '30d', label: '30d', description: 'last 30 days' },
  { value: '90d', label: '90d', description: 'last 90 days' },
  { value: '365d', label: '1y', description: 'last year' },
  { value: 'all', label: 'All', description: 'all time' },
];

export function windowDescription(window: ReclaimWindow): string {
  return RECLAIM_WINDOW_OPTIONS.find((o) => o.value === window)?.description ?? window;
}

/** The space_targets slugs the targets editor may write (mirrors the router's SpaceTargetsInput). */
export type SpaceTargetSlug = 'haynestower' | 'haynesops' | 'hayneskube';

/**
 * Which utilization array carries which space_targets slug — the editable seam of the targets
 * editor. A CLIENT-SAFE mirror of `STORAGE_ARRAYS[].targetSlug` (DESIGN-013 D-04): importing the
 * @hnet/domain VALUE into a client component would drag pg into the browser bundle, so the map is
 * restated here. Arrays absent from this map (the CephFS music pool — `haynesops`/`hayneskube`
 * remain reserved slugs per D-04) render "no target" and are not editable.
 */
export const ARRAY_TARGET_SLUGS: Readonly<Record<string, SpaceTargetSlug>> = {
  haynestower: 'haynestower',
};

/**
 * Disk capacity in DECIMAL (SI) units — the convention disk vendors and the *arr UIs use, and the
 * owner's cross-check framing ("112.4 TB free of 530 TB", ADR-030). One decimal, trailing ".0"
 * dropped. Deliberately distinct from `formatBytes` (1024-based), which keeps formatting RECLAIM
 * sizes so they agree with the Trash pages' "frees 3.0 GB" copy for the same rows.
 */
export function formatCapacity(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/** The meter's severity tone. `muted` = unavailable/unknown. */
export type UtilizationTone = 'ok' | 'warn' | 'danger' | 'muted';

/**
 * Severity against the target: past the ceiling ⇒ danger; within 5 points ⇒ warn (the "approaching"
 * tone the owner asked for). Without a target, absolute guardrails (85/95) keep a filling array from
 * ever looking calm just because nobody set a ceiling.
 */
export function utilizationTone(usedPct: number | null, target: number | null): UtilizationTone {
  if (usedPct == null) return 'muted';
  if (target != null) {
    if (usedPct >= target) return 'danger';
    if (usedPct >= target - 5) return 'warn';
    return 'ok';
  }
  if (usedPct >= 95) return 'danger';
  if (usedPct >= 85) return 'warn';
  return 'ok';
}

/** "78.8% used · 112.4 TB free of 530 TB" — the card's stat line (null when unavailable). */
export function utilizationSummary(u: StorageArrayUtilization): string | null {
  if (u.usedPct == null || u.freeSpace == null || u.totalSpace == null) return null;
  return `${u.usedPct}% used · ${formatCapacity(u.freeSpace)} free of ${formatCapacity(u.totalSpace)}`;
}

/** "Reclaimed 1.2 TB across 15 items" (binary units — agrees with the Trash pages' sizes). */
export function reclaimHeadline(totals: ReclaimTotals): string {
  return `Reclaimed ${formatBytes(totals.reclaimedBytes)} across ${totals.items} item${
    totals.items === 1 ? '' : 's'
  }`;
}

/** Share of the window's total reclaim, for the bar width + "(62%)" label. Whole percent. */
export function sharePct(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.round((bytes / totalBytes) * 100);
}

/** "Movies · 2160p" / "TV · unknown" — one bang-for-buck row's identity. */
export function categoryResolutionLabel(mediaKind: 'movie' | 'tv', resolution: string): string {
  return `${mediaKind === 'movie' ? 'Movies' : 'TV'} · ${resolution}`;
}

/**
 * Step-after geometry for the cumulative strip (inline SVG, viewBox `0 0 width height`,
 * `preserveAspectRatio="none"` — step lines survive non-uniform scaling; the stroke wears
 * `vector-effect="non-scaling-stroke"`). A synthetic zero-point one day before the first data day
 * anchors the climb at the baseline, so even a single swept day reads as a step from 0 — never a
 * flat line implying the total predates the window. Returns null when there is nothing to draw.
 */
export function cumulativeStepGeometry(
  points: readonly ReclaimCumulativePoint[],
  width: number,
  height: number,
  /** Today (YYYY-MM-DD, UTC) — extends the x-domain so the final total holds to "now". */
  today?: string,
): { line: string; area: string; startDay: string } | null {
  if (points.length === 0) return null;
  const DAY_MS = 86_400_000;
  const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
  const x0Ms = toMs(points[0]!.day) - DAY_MS;
  const lastMs = toMs(points[points.length - 1]!.day);
  const x1Ms = today ? Math.max(lastMs, toMs(today)) : lastMs;
  const spanMs = Math.max(x1Ms - x0Ms, DAY_MS);
  // The honest left-axis label: the domain STARTS at the synthetic zero day, not the first sweep.
  const startDay = new Date(x0Ms).toISOString().slice(0, 10);
  const max = points[points.length - 1]!.cumulativeReclaimedBytes;
  if (!(max > 0)) return null;
  const pad = 2; // keeps the 2px stroke's crown inside the viewBox
  const x = (ms: number): number => ((ms - x0Ms) / spanMs) * width;
  const y = (v: number): number => pad + (1 - v / max) * (height - 2 * pad);
  const r2 = (n: number): number => Math.round(n * 100) / 100;

  let line = `M ${r2(x(x0Ms))} ${r2(y(0))}`;
  for (const p of points) {
    line += ` H ${r2(x(toMs(p.day)))} V ${r2(y(p.cumulativeReclaimedBytes))}`;
  }
  // Hold the final total to the right edge so the strip ends at "now", not at the last sweep.
  line += ` H ${width}`;
  const area = `${line} V ${r2(y(0))} Z`;
  return { line, area, startDay };
}
