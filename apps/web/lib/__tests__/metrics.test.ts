import { describe, expect, it } from 'vitest';
import {
  CAPACITY_MBPS_MAX,
  CAPACITY_MBPS_MIN,
  capacityOutOfRange,
  formatMbps,
  formatPct,
  meterPct,
  meterTone,
  meterWidth,
  sparklinePolyline,
} from '../metrics';

describe('meterTone', () => {
  it('is muted for unknown, and steps ok → warn (≥75) → danger (≥90)', () => {
    expect(meterTone(null)).toBe('muted');
    expect(meterTone(0)).toBe('ok');
    expect(meterTone(74.9)).toBe('ok');
    expect(meterTone(75)).toBe('warn');
    expect(meterTone(89.9)).toBe('warn');
    expect(meterTone(90)).toBe('danger');
    expect(meterTone(150)).toBe('danger');
  });
});

describe('meterWidth', () => {
  it('clamps to 0..100 and is 0 for unknown', () => {
    expect(meterWidth(null)).toBe(0);
    expect(meterWidth(-5)).toBe(0);
    expect(meterWidth(42.5)).toBe(42.5);
    expect(meterWidth(150)).toBe(100);
  });
});

describe('formatMbps', () => {
  it('formats Mbps, promotes ≥1000 to Gbps, em-dashes unknown', () => {
    expect(formatMbps(null)).toBe('—');
    expect(formatMbps(11.6)).toBe('11.6 Mbps');
    expect(formatMbps(300)).toBe('300 Mbps');
    expect(formatMbps(2256)).toBe('2.26 Gbps');
  });
});

describe('formatPct', () => {
  it('formats a percent or em-dash', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(3.9)).toBe('3.9%');
  });
});

// DESIGN-016 D-08 — the admin-only capacity editor's client helpers.
describe('capacityOutOfRange', () => {
  it('accepts whole Mbps inside [0, 1_000_000] and rejects everything else (mirrors the server zod)', () => {
    expect(CAPACITY_MBPS_MIN).toBe(0);
    expect(CAPACITY_MBPS_MAX).toBe(1_000_000);
    expect(capacityOutOfRange(0)).toBe(false);
    expect(capacityOutOfRange(300)).toBe(false);
    expect(capacityOutOfRange(2256)).toBe(false);
    expect(capacityOutOfRange(1_000_000)).toBe(false);
    // out of range / non-integer / non-finite all fail closed.
    expect(capacityOutOfRange(-1)).toBe(true);
    expect(capacityOutOfRange(1_000_001)).toBe(true);
    expect(capacityOutOfRange(300.5)).toBe(true);
    expect(capacityOutOfRange(Number.NaN)).toBe(true);
    expect(capacityOutOfRange(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('meterPct', () => {
  it('mirrors the server: usage/capacity·100 to one decimal, clamped ≥0, null on unknown/zero cap', () => {
    expect(meterPct(null, 300)).toBeNull();
    expect(meterPct(150, 0)).toBeNull();
    expect(meterPct(150, 300)).toBe(50);
    expect(meterPct(11.6, 300)).toBe(3.9); // 3.8666… → one decimal
    // an optimistic denominator change recomputes the fill exactly (300 → 600 halves the pct).
    expect(meterPct(150, 600)).toBe(25);
    expect(meterPct(-5, 300)).toBe(0); // clamped ≥ 0
  });
});

describe('sparklinePolyline', () => {
  it('is empty for no data, a flat mid-line for one point', () => {
    expect(sparklinePolyline([], 100, 20)).toBe('');
    expect(sparklinePolyline([5], 100, 20)).toBe('0,10 100,10');
    expect(sparklinePolyline([Number.NaN, Number.POSITIVE_INFINITY], 100, 20)).toBe('');
  });

  it('maps min→bottom and max→top across a fixed box', () => {
    // values 0,10,20 over width 100, height 20 → x at 0/50/100; y at bottom(20)/mid(10)/top(0).
    expect(sparklinePolyline([0, 10, 20], 100, 20)).toBe('0,20 50,10 100,0');
  });

  it('handles a flat series without dividing by zero', () => {
    expect(sparklinePolyline([7, 7, 7], 100, 20)).toBe('0,20 50,20 100,20');
  });
});
