// ADR-023 / DESIGN-010 D-07 — Maintainerr webhook receiver hardening (pure, dependency-free helpers so
// they unit-test without a stack). The receiver is session-unauthenticated + shared-secret-gated and,
// though in-cluster today, still hardens defensively: a constant-time secret compare, a body-size cap,
// validation to a KNOWN shape, capped stored strings, and stripping of arbitrary / prototype-polluting
// keys — never persisting unbounded caller JSON. (Hand-rolled validation — apps/web carries no zod.)
import { createHash, timingSafeEqual } from 'node:crypto';

/** Reject bodies larger than this (bytes) BEFORE parsing — an unauthenticated endpoint must not buffer
 *  or persist unbounded input. ~64KB is far above any real Maintainerr webhook template. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const MAX_TYPE_LEN = 200;
const MAX_TITLE_LEN = 500;
const MAX_BODY_LEN = 4_000;

/**
 * Constant-time shared-secret comparison. Both sides are SHA-256 hashed first, which (a) yields
 * equal-length 32-byte buffers so `timingSafeEqual` never throws on a length mismatch and (b) leaks
 * neither the secret nor its length through timing — a plain `===` (or an early length check) is
 * timing-observable. An empty/absent provided (or expected) secret is always a mismatch.
 */
export function secretsMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The KNOWN top-level string fields (Maintainerr's Overseerr-style webhook template). Reading ONLY
 *  these — never iterating the caller's keys — is what strips arbitrary + `__proto__`/`constructor`
 *  pollution: an unknown or prototype key is simply never looked up or persisted. */
const KNOWN_STRING_KEYS = [
  'notification_type',
  'type',
  'event',
  'subject',
  'title',
  'message',
  'body',
] as const;

export interface ParsedWebhook {
  type: string;
  title: string;
  body: string;
  /** Sanitized, bounded subset (only known keys, each capped) — never the raw unbounded body. */
  payload: Record<string, unknown>;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Coerce a known field to a capped string, or undefined when absent / not a scalar. */
function stringish(value: unknown, max: number): string | undefined {
  if (typeof value === 'string') return cap(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return cap(String(value), max);
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate + sanitize a parsed JSON body to the known shape. Returns null when the body is not an
 * object (the caller rejects with 400). Derives type/title/body from the tolerant Overseerr-style key
 * set (capped), and persists ONLY the sanitized known fields (capped) — not arbitrary JSON, and never
 * a prototype-polluting key.
 */
export function parseMaintainerrWebhook(raw: unknown): ParsedWebhook | null {
  if (!isPlainObject(raw)) return null;

  const known: Record<string, string> = {};
  for (const key of KNOWN_STRING_KEYS) {
    const value = stringish(raw[key], MAX_BODY_LEN);
    if (value !== undefined) known[key] = value;
  }
  const mediaTitle = isPlainObject(raw.media) ? stringish(raw.media.title, MAX_TITLE_LEN) : undefined;

  const type = cap(known.notification_type ?? known.type ?? known.event ?? 'event', MAX_TYPE_LEN);
  const title = cap(
    known.subject ?? known.title ?? mediaTitle ?? 'Maintainerr notification',
    MAX_TITLE_LEN,
  );
  const body = cap(known.message ?? known.body ?? '', MAX_BODY_LEN);

  const payload: Record<string, unknown> = { ...known };
  if (mediaTitle !== undefined) payload.media = { title: mediaTitle };

  return { type, title, body, payload };
}
