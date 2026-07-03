// DESIGN-004 D-07 — time-of-day greeting, computed client-side. Pure so it's
// table-testable; the Greeting component feeds it the local hour after mount
// (hydration-safe: SSR renders the neutral fallback).

/** Neutral SSR/first-paint fallback before the client clock is known. */
export const GREETING_FALLBACK = 'Welcome';

/** `hour` is a local 0–23 clock hour (Date#getHours). */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}
