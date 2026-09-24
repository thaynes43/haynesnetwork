// Shared fixtures for the @hnet/oauth unit tests (pure — no database).
import { vi, type MockInstance } from 'vitest';
import { s256Challenge } from '../src/crypto';

export const ENV = { BETTER_AUTH_URL: 'https://haynesnetwork.com' };
export const RESOURCE = 'https://haynesnetwork.com/mcp';
export const NOW = new Date('2026-09-23T20:00:00Z');
/** RFC 7636 Appendix B. */
export const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

export function pkcePair(verifier = 'v'.repeat(43)): { verifier: string; challenge: string } {
  return { verifier, challenge: s256Challenge(verifier) };
}

/** Capture `console.log` lines (the `[auth]` sink) for the duration of a test. */
export function captureLogs(): { lines: string[]; spy: MockInstance } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, spy };
}

export const secondsAfter = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
