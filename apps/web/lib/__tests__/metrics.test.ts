import { describe, expect, it } from 'vitest';
import { formatMbps, formatPct, meterTone, meterWidth, sparklinePolyline } from '../metrics';

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
