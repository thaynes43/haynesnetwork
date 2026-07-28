// ADR-079 / DESIGN-004 D-25 (PLAN-064) — the front-page uptime badge: a compact
// two-segment shields pill (muted "Uptime" label + toned value segment with status dot,
// the 30d percentage, and a small window qualifier). Like PhaseChip, this ships
// STRUCTURE only — every color comes from the app's stylesheet via the
// `uptime-badge--<state>` classes, themed by the token palette; no hex ever lives here
// (CLAUDE.md rule 2).
//
// ADR-015 (hard rule 9) is designed in, not bolted on:
// - the percent span reserves tabular-numeral width (`uptime-badge__pct`, min-width in ch
//   via the app stylesheet), so 100% ⇄ 99.98% never moves the window qualifier;
// - a state change swaps class/text only — same pill anatomy in all three states (label
//   segment + value segment holding dot + text); nothing is interactive, and the state is
//   fixed at SSR (no client fetch), so nothing can reflow mid-view.
//
// The three states are HONEST (ADR-079 C-02): `up` / `down` render the measured 30d
// ratio; `unmeasured` says so in plain words — the badge never fakes green and never
// hides. Copy follows the owner rules: friendly, concise, no em-dashes, no time-grounding.

/** The tRPC `metrics.uptime` payload, structurally (no @hnet/api dependency). */
export interface UptimeBadgeData {
  measured: boolean;
  up: boolean | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
}

export type UptimeBadgeState = 'up' | 'down' | 'unmeasured';

export interface UptimeBadgeProps {
  data: UptimeBadgeData;
  className?: string;
}

/**
 * Format a Gatus ratio 0..1 as a display percentage: two decimals with trailing zeros
 * trimmed (0.999783 → "99.98%", 0.9 → "90%", 1 → "100%"). Out-of-range/non-finite input
 * never reaches here in production (the client schema clamps 0..1) but clamps defensively.
 */
export function formatUptimePercent(ratio: number): string {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return `${(clamped * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Resolve the badge state from the snapshot (unmeasured wins over any partial data). */
export function uptimeBadgeState(data: UptimeBadgeData): UptimeBadgeState {
  if (!data.measured || data.up === null || data.uptime30d === null) return 'unmeasured';
  return data.up ? 'up' : 'down';
}

/** The native-tooltip text: the windows we have, oldest-window last; plain words otherwise. */
export function uptimeBadgeTitle(data: UptimeBadgeData): string {
  if (uptimeBadgeState(data) === 'unmeasured') {
    return 'Uptime is unmeasured while the status service is unreachable';
  }
  const parts: string[] = [];
  if (data.uptime24h !== null) parts.push(`24h ${formatUptimePercent(data.uptime24h)}`);
  if (data.uptime7d !== null) parts.push(`7d ${formatUptimePercent(data.uptime7d)}`);
  parts.push(`30d ${formatUptimePercent(data.uptime30d!)}`);
  return `Uptime: ${parts.join(' · ')}`;
}

/**
 * The Home uptime pill. Always renders (unlike the play scoreboard's render-nothing rule —
 * D-25: hiding the badge would hide a measurement-plane outage). SSR-only content: no
 * client fetch, no live region, no interaction.
 */
export function UptimeBadge({ data, className }: UptimeBadgeProps) {
  const state = uptimeBadgeState(data);
  return (
    <span
      className={['uptime-badge', `uptime-badge--${state}`, className].filter(Boolean).join(' ')}
      data-state={state}
      data-testid="uptime-badge"
      title={uptimeBadgeTitle(data)}
    >
      <span className="uptime-badge__label">Uptime</span>
      <span className="uptime-badge__value">
        <span className="uptime-badge__dot" aria-hidden="true" />
        {state === 'unmeasured' ? (
          <span className="uptime-badge__pct">unmeasured</span>
        ) : (
          <>
            <span className="uptime-badge__pct">{formatUptimePercent(data.uptime30d!)}</span>
            <span className="uptime-badge__window">30d</span>
          </>
        )}
      </span>
    </span>
  );
}
