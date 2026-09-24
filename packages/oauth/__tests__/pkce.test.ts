// ADR-091 / DESIGN-050 D-06 — PKCE S256 (RFC 7636) and the constant-time comparison every secret check uses.
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on node:crypto's timingSafeEqual while keeping the real implementation (ESM namespaces cannot be spied on
// directly, so the module is mocked with a pass-through).
const timingSafeEqual = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqual.calls += 1;
      return real.timingSafeEqual(a, b);
    },
  };
});

const { hashToken, randomClientId, randomToken, s256Challenge, safeEqual, verifyPkceS256 } =
  await import('../src/crypto');
const { RFC_CHALLENGE, RFC_VERIFIER } = await import('./helpers');

afterEach(() => {
  timingSafeEqual.calls = 0;
});

describe('D-06 — PKCE S256', () => {
  it('matches RFC 7636 Appendix B', () => {
    expect(s256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('refuses a wrong verifier, the challenge itself (plain), and an empty one', () => {
    expect(verifyPkceS256(`${RFC_VERIFIER}x`, RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256(RFC_CHALLENGE, RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256('', RFC_CHALLENGE)).toBe(false);
  });

  it('compares in constant time — through timingSafeEqual, over equal-length digests, even for unequal lengths', () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    expect(timingSafeEqual.calls).toBe(1);
    // A length mismatch must not short-circuit (that would leak the expected length): it still reaches
    // timingSafeEqual, which would throw on unequal buffers — so both sides are digested first.
    expect(safeEqual('a', 'a much longer string')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual.calls).toBe(3);
    expect(safeEqual('same', 'same')).toBe(true);
  });
});

describe('D-03 — token material', () => {
  it('tokens are 32 random bytes in base64url; client ids 32 hex; hashes SHA-256 hex', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(randomClientId()).toMatch(/^[0-9a-f]{32}$/);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('never repeats (a thousand draws)', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomToken()));
    expect(seen.size).toBe(1000);
  });
});
