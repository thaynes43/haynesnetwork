// ADR-079 / DESIGN-004 D-25 — the UptimeBadge anatomy + the pure helpers. The resting DOM
// is checked with react-dom/server (no DOM package needed, matching the repo convention);
// the live three-state journey is covered by the e2e suite (uptime-badge.spec.ts).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  UptimeBadge,
  formatUptimePercent,
  uptimeBadgeState,
  uptimeBadgeTitle,
  type UptimeBadgeData,
} from '../src/controls/UptimeBadge';

const UP: UptimeBadgeData = {
  measured: true,
  up: true,
  uptime24h: 1,
  uptime7d: 0.99913,
  uptime30d: 0.999783,
};
const DOWN: UptimeBadgeData = { ...UP, up: false };
const UNMEASURED: UptimeBadgeData = {
  measured: false,
  up: null,
  uptime24h: null,
  uptime7d: null,
  uptime30d: null,
};

describe('formatUptimePercent (two decimals, trailing zeros trimmed)', () => {
  it('formats the live-shaped ratios', () => {
    expect(formatUptimePercent(0.999783)).toBe('99.98%');
    expect(formatUptimePercent(0.99913)).toBe('99.91%');
    expect(formatUptimePercent(1)).toBe('100%');
    expect(formatUptimePercent(0.9)).toBe('90%');
    expect(formatUptimePercent(0)).toBe('0%');
  });

  it('clamps defensively (the client schema already forbids these)', () => {
    expect(formatUptimePercent(1.5)).toBe('100%');
    expect(formatUptimePercent(-1)).toBe('0%');
    expect(formatUptimePercent(Number.NaN)).toBe('0%');
  });
});

describe('uptimeBadgeState (unmeasured wins over any partial data)', () => {
  it('maps the three states', () => {
    expect(uptimeBadgeState(UP)).toBe('up');
    expect(uptimeBadgeState(DOWN)).toBe('down');
    expect(uptimeBadgeState(UNMEASURED)).toBe('unmeasured');
  });

  it('a half-honest snapshot (measured but missing headline fields) renders unmeasured', () => {
    expect(uptimeBadgeState({ ...UP, uptime30d: null })).toBe('unmeasured');
    expect(uptimeBadgeState({ ...UP, up: null })).toBe('unmeasured');
  });
});

describe('uptimeBadgeTitle (the 24h/7d/30d tooltip, degraded windows omitted)', () => {
  it('joins the windows it has', () => {
    expect(uptimeBadgeTitle(UP)).toBe('Uptime: 24h 100% · 7d 99.91% · 30d 99.98%');
    expect(uptimeBadgeTitle({ ...UP, uptime24h: null })).toBe('Uptime: 7d 99.91% · 30d 99.98%');
  });

  it('explains the unmeasured state in plain words (no em-dash, no fake numbers)', () => {
    const title = uptimeBadgeTitle(UNMEASURED);
    expect(title).toBe('Uptime is unmeasured while the status service is unreachable');
    expect(title).not.toContain('—');
    expect(title).not.toContain('%');
  });
});

describe('UptimeBadge (resting DOM — the shields-pill anatomy)', () => {
  it('up: accent state class, label, reserved percent span + 30d qualifier, tooltip', () => {
    const html = renderToStaticMarkup(<UptimeBadge data={UP} />);
    expect(html).toContain('uptime-badge--up');
    expect(html).toContain('data-state="up"');
    expect(html).toContain('data-testid="uptime-badge"');
    expect(html).toContain('>Uptime</span>');
    expect(html).toContain('uptime-badge__dot');
    // The ADR-015 reservation hangs off this class (min-width in ch, app.css).
    expect(html).toContain('<span class="uptime-badge__pct">99.98%</span>');
    expect(html).toContain('<span class="uptime-badge__window">30d</span>');
    expect(html).toContain('title="Uptime: 24h 100% · 7d 99.91% · 30d 99.98%"');
  });

  it('down: danger state class, SAME anatomy (percent + qualifier still render)', () => {
    const html = renderToStaticMarkup(<UptimeBadge data={DOWN} />);
    expect(html).toContain('uptime-badge--down');
    expect(html).toContain('data-state="down"');
    expect(html).toContain('<span class="uptime-badge__pct">99.98%</span>');
    expect(html).toContain('<span class="uptime-badge__window">30d</span>');
  });

  it('unmeasured: muted state class, "unmeasured" copy, no percent anywhere', () => {
    const html = renderToStaticMarkup(<UptimeBadge data={UNMEASURED} />);
    expect(html).toContain('uptime-badge--unmeasured');
    expect(html).toContain('data-state="unmeasured"');
    expect(html).toContain('<span class="uptime-badge__pct">unmeasured</span>');
    expect(html).not.toContain('%');
    expect(html).not.toContain('uptime-badge__window');
  });
});
