import { describe, expect, it } from 'vitest';
import { GREETING_FALLBACK, greetingForHour } from '../greeting';

describe('greetingForHour (DESIGN-004 D-07)', () => {
  it.each([
    [0, 'Good evening'],
    [4, 'Good evening'],
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [23, 'Good evening'],
  ])('hour %i → %s', (hour, expected) => {
    expect(greetingForHour(hour)).toBe(expected);
  });

  it('ships a neutral SSR fallback', () => {
    expect(GREETING_FALLBACK).toBe('Welcome');
  });
});
