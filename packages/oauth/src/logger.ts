// ADR-091 / DESIGN-050 D-06 — the structured `[auth]` event log (ported from cigar-journal
// `packages/oauth/src/logger.ts`). One line per step, `[auth] <event> {json}`, so grepping `[auth]` in Loki
// tells the whole story and the D-11 alerts can count events. NEVER logs a token, code, client secret or PKCE
// verifier: only ids, client ids, scopes, hosts and a masked FINGERPRINT — the first 6 characters of the
// SHA-256 hash (the port logged the token's own first and last 4 characters; a hash prefix correlates with the
// stored `token_hash` without revealing any of the credential).
import { hashToken } from './crypto';

export type AuthEventName =
  | 'client_registered'
  | 'authorize_started'
  | 'authorize_rejected'
  | 'consent_shown'
  | 'consent_granted'
  | 'consent_denied'
  | 'token_issued'
  | 'token_refreshed'
  | 'refresh_reuse_detected'
  // A REVOKED refresh token presented again — the expected aftermath of a Disconnect or a client revoke, not a
  // theft signal: logged quietly, never paged (DESIGN-050 D-11 pages on refresh_reuse_detected only).
  | 'refresh_rejected'
  | 'token_revoked'
  | 'code_replayed'
  | 'audience_mismatch'
  | 'rate_limited';

/** Emit one `[auth]` line (stdout — the pod log). */
export function authEvent(event: AuthEventName, data: Record<string, unknown> = {}): void {
  console.log(`[auth] ${event} ${JSON.stringify(data)}`);
}

/** A correlatable, non-reversible fingerprint of a credential: the first 6 hex characters of its SHA-256. */
export function fingerprint(secret: string): string {
  return hashToken(secret).slice(0, 6);
}

/** The host a redirect URI sends the browser to (logged and shown on the consent page); `?` if unparseable. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '?';
  }
}

/**
 * A client-supplied resource indicator as it may be logged (`audience_mismatch`): origin + path only (no query or
 * fragment), at most 120 characters, and any run of 20+ token-like characters masked — the value is the client's,
 * so it must not become a way to smuggle a credential-shaped string into the log.
 */
export function loggableResource(value: string): string {
  let shown: string;
  try {
    const u = new URL(value);
    shown = `${u.origin}${u.pathname}`;
  } catch {
    shown = value;
  }
  return shown.slice(0, 120).replace(/[A-Za-z0-9_-]{20,}/g, '…');
}
