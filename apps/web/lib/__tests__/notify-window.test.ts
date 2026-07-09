import { describe, expect, it } from 'vitest';
import {
  NOTIFY_TZ_OPTIONS,
  describeWindow,
  formatHour,
  isValidWindow,
  tzLabel,
} from '../notify-window';

describe('notify-window helpers (ADR-034 / DESIGN-015 D-06)', () => {
  it('formatHour renders a 12-hour clock (midnight/noon/evening)', () => {
    expect(formatHour(0)).toBe('12 AM');
    expect(formatHour(12)).toBe('12 PM');
    expect(formatHour(18)).toBe('6 PM');
    expect(formatHour(22)).toBe('10 PM');
    expect(formatHour(24)).toBe('12 AM'); // endHour 24 = midnight
  });

  it('isValidWindow requires whole hours in range with start < end', () => {
    expect(isValidWindow(18, 22)).toBe(true);
    expect(isValidWindow(0, 24)).toBe(true);
    expect(isValidWindow(22, 18)).toBe(false); // inverted
    expect(isValidWindow(18, 18)).toBe(false); // empty
    expect(isValidWindow(18.5, 22)).toBe(false); // fractional
    expect(isValidWindow(-1, 22)).toBe(false); // out of range
    expect(isValidWindow(18, 25)).toBe(false); // out of range
  });

  it('tzLabel prefers the option label, falls back to the raw name', () => {
    expect(tzLabel('America/New_York')).toContain('Eastern');
    expect(tzLabel('Pacific/Auckland')).toBe('Pacific/Auckland');
  });

  it('describeWindow renders the human summary', () => {
    expect(describeWindow({ startHour: 18, endHour: 22, tz: 'America/New_York' })).toBe(
      '6 PM – 10 PM · Eastern (America/New_York)',
    );
    // The all-day default reads honestly, not "12 AM – 12 AM".
    expect(describeWindow({ startHour: 0, endHour: 24, tz: 'America/New_York' })).toBe(
      'All day (no quiet hours) · Eastern (America/New_York)',
    );
  });

  it('every tz option is a real IANA zone Intl accepts', () => {
    for (const o of NOTIFY_TZ_OPTIONS) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: o.value })).not.toThrow();
    }
  });
});
