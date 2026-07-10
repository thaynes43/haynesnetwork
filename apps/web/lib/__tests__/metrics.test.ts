import { describe, expect, it } from 'vitest';
import { formatMbps, formatPct, meterTone, meterWidth } from '../metrics';

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
