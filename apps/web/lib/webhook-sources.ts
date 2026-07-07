// ADR-023 / DESIGN-010 D-07 + ADR-026 / DESIGN-012 D-02/D-03 — the generic, secured webhook
// ingest layer (pure, dependency-free helpers so they unit-test without a stack). ONE receiver
// (`POST /api/webhooks/[source]`, source ∈ NOTIFICATION_SOURCES) with a PER-SOURCE shared secret
// and a PER-SOURCE payload parser that normalizes each service's webhook template into the common
// `ParsedNotification` the @hnet/domain `recordNotification` single-writer ingests.
//
// The receiver is session-UNAUTHENTICATED (the source services can't hold a session) + SHARED-
// SECRET-GATED and, though in-cluster today, still hardens defensively: a constant-time secret
// compare, a body-size cap, validation to a KNOWN shape, capped stored strings, and stripping of
// arbitrary / prototype-polluting keys — never persisting unbounded caller JSON. (Hand-rolled
// validation — apps/web carries no zod.)
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The INBOUND webhook sources — the subset of NOTIFICATION_SOURCES that a `POST /api/webhooks/<source>`
 * receiver accepts. Excludes app-internal sources like 'trash' (the app writes its own Trash deletion
 * Activity events directly via @hnet/domain — there is no inbound webhook for them, so they have no
 * secret env var and no parser).
 */
export const WEBHOOK_SOURCES = ['maintainerr', 'seerr', 'tautulli'] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

/** Reject bodies larger than this (bytes) BEFORE parsing — an unauthenticated endpoint must not
 *  buffer or persist unbounded input. ~64KB is far above any real webhook template. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const MAX_TYPE_LEN = 200;
const MAX_TITLE_LEN = 500;
const MAX_BODY_LEN = 4_000;
const MAX_EMAIL_LEN = 320;
const MAX_EVENT_ID_LEN = 200;

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

/**
 * Read the request body enforcing MAX_WEBHOOK_BODY_BYTES WITHOUT ever buffering more than the cap:
 * a declared oversize Content-Length is rejected up front (cheap), and the stream itself is read
 * chunk-by-chunk with a hard byte cap (chunked/lying senders can't sidestep the header check).
 * Returns the UTF-8 text, or null when the cap is exceeded (the caller responds 413).
 */
export async function readWebhookBodyCapped(
  req: Request,
  cap: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The per-source env var holding that source's webhook shared secret (fail-closed if unset). */
export const WEBHOOK_SECRET_ENV: Record<WebhookSource, string> = {
  maintainerr: 'MAINTAINERR_WEBHOOK_SECRET',
  seerr: 'SEERR_WEBHOOK_SECRET',
  tautulli: 'TAUTULLI_WEBHOOK_SECRET',
};

/**
 * The normalized event a per-source parser produces — the `recordNotification` input (minus db +
 * source). The optional attribution fields let ingest resolve `actor_user_id` (requesterEmail) and
 * `media_item_id` (tmdb/tvdb + media type), and `sourceEventId` drives idempotent dedupe.
 */
export interface ParsedNotification {
  type: string;
  title: string;
  body: string;
  occurredAt?: Date;
  sourceEventId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  mediaType?: 'movie' | 'tv' | null;
  requesterEmail?: string | null;
  /** Sanitized, bounded subset (only known keys, each capped) — never the raw unbounded body. */
  payload: Record<string, unknown>;
}

// Kept as an alias for the pre-ADR-026 Maintainerr parser return type (its unit test imports it).
export type ParsedWebhook = ParsedNotification;

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Coerce a known field to a capped string, or undefined when absent / not a scalar. */
function stringish(value: unknown, max: number): string | undefined {
  if (typeof value === 'string') return cap(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return cap(String(value), max);
  return undefined;
}

/** Coerce a webhook id field to a finite integer (Overseerr templates numbers AS strings). */
function intish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map an absent / empty string to undefined (Overseerr templates unset fields as ""). */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Maintainerr (source #1, PLAN-006) — the Overseerr-style webhook template Maintainerr POSTs.
// Behavior preserved exactly (its unit test is the contract); ADR-026 additionally lifts any
// media ids it carries so a Maintainerr event can link to a ledger item too (best-effort).
// ---------------------------------------------------------------------------

const KNOWN_STRING_KEYS = [
  'notification_type',
  'type',
  'event',
  'subject',
  'title',
  'message',
  'body',
] as const;

/**
 * Validate + sanitize a parsed Maintainerr JSON body to the known shape. Returns null when the body
 * is not an object (the caller rejects with 400). Derives type/title/body from the tolerant
 * Overseerr-style key set (capped), and persists ONLY the sanitized known fields.
 */
export function parseMaintainerrWebhook(raw: unknown): ParsedNotification | null {
  if (!isPlainObject(raw)) return null;

  const known: Record<string, string> = {};
  for (const key of KNOWN_STRING_KEYS) {
    const value = stringish(raw[key], MAX_BODY_LEN);
    if (value !== undefined) known[key] = value;
  }
  const media = isPlainObject(raw.media) ? raw.media : undefined;
  const mediaTitle = media ? stringish(media.title, MAX_TITLE_LEN) : undefined;

  const type = cap(known.notification_type ?? known.type ?? known.event ?? 'event', MAX_TYPE_LEN);
  const title = cap(
    known.subject ?? known.title ?? mediaTitle ?? 'Maintainerr notification',
    MAX_TITLE_LEN,
  );
  const body = cap(known.message ?? known.body ?? '', MAX_BODY_LEN);

  const payload: Record<string, unknown> = { ...known };
  if (mediaTitle !== undefined) payload.media = { title: mediaTitle };

  return {
    type,
    title,
    body,
    tmdbId: media ? intish(media.tmdbId ?? media.tmdb_id) : null,
    tvdbId: media ? intish(media.tvdbId ?? media.tvdb_id) : null,
    mediaType: normalizeMediaType(media ? stringish(media.media_type, 32) : undefined),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Seerr / Overseerr — the DEFAULT webhook JSON template (verified against sct/overseerr
// develop: src/.../NotificationsWebhook + server/lib/notifications/agents/webhook.ts). The
// `{{media}}` / `{{request}}` keys resolve to `media` / `request` objects at send time; ids are
// templated AS strings, empty when absent. One canonical source name 'seerr' covers both apps.
// ---------------------------------------------------------------------------

export function parseSeerrWebhook(raw: unknown): ParsedNotification | null {
  if (!isPlainObject(raw)) return null;
  const media = isPlainObject(raw.media) ? raw.media : undefined;
  const request = isPlainObject(raw.request) ? raw.request : undefined;
  const issue = isPlainObject(raw.issue) ? raw.issue : undefined;
  const comment = isPlainObject(raw.comment) ? raw.comment : undefined;

  const notificationType = stringish(raw.notification_type, MAX_TYPE_LEN);
  const event = stringish(raw.event, MAX_TYPE_LEN);
  const subject = stringish(raw.subject, MAX_TITLE_LEN);
  const message = stringish(raw.message, MAX_BODY_LEN);

  const type = cap(notificationType ?? event ?? 'seerr_event', MAX_TYPE_LEN);
  const title = cap(subject ?? 'Seerr notification', MAX_TITLE_LEN);
  const body = cap(message ?? event ?? '', MAX_BODY_LEN);

  // Attribution: requester (request) → issue reporter → commenter, first present wins.
  const email =
    (request ? nonEmpty(stringish(request.requestedBy_email, MAX_EMAIL_LEN)) : undefined) ??
    (issue ? nonEmpty(stringish(issue.reportedBy_email, MAX_EMAIL_LEN)) : undefined) ??
    (comment ? nonEmpty(stringish(comment.commentedBy_email, MAX_EMAIL_LEN)) : undefined) ??
    null;

  // Dedupe: `<notification_type>:<request_id>` so each distinct lifecycle event of a request is
  // one row, but exact re-delivery is a no-op. Absent request id ⇒ null (always insert).
  const requestId = request ? stringish(request.request_id, MAX_EVENT_ID_LEN) : undefined;
  const sourceEventId = requestId ? cap(`${type}:${requestId}`, MAX_EVENT_ID_LEN) : null;

  const tmdbId = media ? intish(media.tmdbId ?? media.tmdb_id) : null;
  const tvdbId = media ? intish(media.tvdbId ?? media.tvdb_id) : null;
  const mediaType = normalizeMediaType(media ? stringish(media.media_type, 32) : undefined);

  const payload: Record<string, unknown> = {};
  if (notificationType !== undefined) payload.notification_type = notificationType;
  if (event !== undefined) payload.event = event;
  if (subject !== undefined) payload.subject = subject;
  if (message !== undefined) payload.message = message;
  if (media) {
    payload.media = {
      media_type: mediaType,
      tmdbId,
      tvdbId,
      status: stringish(media.status, 64) ?? null,
    };
  }
  if (request) {
    payload.request = {
      request_id: requestId ?? null,
      requestedBy_email: email,
      requestedBy_username: stringish(request.requestedBy_username, 200) ?? null,
    };
  }

  return { type, title, body, sourceEventId, tmdbId, tvdbId, mediaType, requesterEmail: email, payload };
}

// ---------------------------------------------------------------------------
// Tautulli — the notification-agent body is FULLY user-templated, so we DESIGN the canonical JSON
// we configure Tautulli to POST (see DESIGN-012 D-02 deploy section). We control the field names,
// so the parser reads them directly. Attribution is best-effort via the Plex account email.
// ---------------------------------------------------------------------------

export function parseTautulliWebhook(raw: unknown): ParsedNotification | null {
  if (!isPlainObject(raw)) return null;

  const eventType = stringish(raw.event_type, MAX_TYPE_LEN) ?? stringish(raw.action, MAX_TYPE_LEN);
  const subject = stringish(raw.subject, MAX_TITLE_LEN) ?? stringish(raw.title, MAX_TITLE_LEN);
  const message = stringish(raw.message, MAX_BODY_LEN);

  const type = cap(eventType ?? 'tautulli_event', MAX_TYPE_LEN);
  const title = cap(subject ?? 'Tautulli notification', MAX_TITLE_LEN);
  const body = cap(message ?? '', MAX_BODY_LEN);

  const email = nonEmpty(stringish(raw.user_email, MAX_EMAIL_LEN)) ?? null;
  const tmdbId = intish(raw.tmdb_id);
  const tvdbId = intish(raw.tvdb_id);
  const mediaType = normalizeMediaType(stringish(raw.media_type, 32));
  const rawEventId = stringish(raw.source_event_id, MAX_EVENT_ID_LEN);
  const sourceEventId = rawEventId && rawEventId.length > 0 ? rawEventId : null;

  const payload: Record<string, unknown> = {};
  if (eventType !== undefined) payload.event_type = eventType;
  if (subject !== undefined) payload.subject = subject;
  if (message !== undefined) payload.message = message;
  const user = stringish(raw.user, 200);
  if (user !== undefined) payload.user = user;
  if (email !== null) payload.user_email = email;
  if (tmdbId !== null) payload.tmdb_id = tmdbId;
  if (tvdbId !== null) payload.tvdb_id = tvdbId;
  if (mediaType !== null) payload.media_type = mediaType;

  return { type, title, body, sourceEventId, tmdbId, tvdbId, mediaType, requesterEmail: email, payload };
}

/** Normalize a source's media-type string to the ledger's 'movie'|'tv' hint (null ⇒ probe by id). */
function normalizeMediaType(value: string | undefined): 'movie' | 'tv' | null {
  if (value === undefined) return null;
  const v = value.toLowerCase();
  if (v === 'movie') return 'movie';
  if (v === 'tv' || v === 'show' || v === 'season' || v === 'episode' || v === 'series') return 'tv';
  return null;
}

/** Dispatch to the per-source parser (inbound webhook sources only). */
export function parserForSource(
  source: WebhookSource,
): (raw: unknown) => ParsedNotification | null {
  switch (source) {
    case 'maintainerr':
      return parseMaintainerrWebhook;
    case 'seerr':
      return parseSeerrWebhook;
    case 'tautulli':
      return parseTautulliWebhook;
  }
}
