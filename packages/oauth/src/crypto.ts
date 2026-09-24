// ADR-091 / DESIGN-050 D-03 — token material and PKCE primitives (ported from cigar-journal
// `packages/oauth/src/crypto.ts`). Tokens, codes and client secrets are 32 random bytes in base64url, opaque,
// and only their SHA-256 hex digest is ever persisted — a database read never yields a usable credential (and
// the schema CHECKs refuse anything that is not 64 hex characters).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A URL-safe, high-entropy opaque token (access / refresh / code / client secret): 32 bytes, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** The public client handle issued at DCR: 16 random bytes as 32 lowercase hex characters. */
export function randomClientId(): string {
  return randomBytes(16).toString('hex');
}

/** SHA-256 hex — the at-rest form of every token, code and client secret. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** PKCE S256 challenge for a verifier: BASE64URL(SHA-256(verifier)) (RFC 7636 §4.2). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Constant-time string equality. Both sides are hashed first, so the comparison runs over two equal-length
 * digests whatever the inputs are — neither the content nor the LENGTH of the expected value leaks through
 * timing (the port compared raw strings and returned early on a length mismatch).
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

/** PKCE S256 verification (RFC 7636 §4.6), constant-time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  return safeEqual(s256Challenge(verifier), challenge);
}
