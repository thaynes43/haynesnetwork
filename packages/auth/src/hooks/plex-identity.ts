// fix/plex-identity-mapping — resolve a signed-in user's REAL Plex identity, which is NOT the
// OIDC email. When a pre-existing Authentik user is LINKED to the Authentik Plex source, the OIDC
// id_token still carries the Authentik user's email (e.g. admin@haynesnetwork.com), not the plex.tv
// account email (e.g. manofoz@gmail.com). Email-matching in My Plex therefore structurally misses
// the owner (and any user whose two emails differ). This module derives the Plex identity from,
// in order: the id_token's plex_email / plex_username CLAIM (surfaced by an Authentik property
// mapping off the source connection), then the admin-set users.plex_email / plex_username OVERRIDE.
// When neither is present the identity is empty and the caller falls back to the app email — the
// pre-fix behavior, so nothing regresses for accounts whose emails already agree.

/** The caller's resolved Plex account identity. Fields are trimmed + lowercased, or null. */
export interface PlexIdentity {
  /**
   * fix/plex-numeric-id — the plex.tv NUMERIC user id (e.g. "12874060") from the id_token
   * `plex_user_id` claim (an Authentik provider scope mapping reads it off the user's Plex source
   * connection). This is the strongest, immutable identity and the ONE the owner's token reliably
   * carries (his plex_email/username are absent); the My Plex matcher checks it FIRST. null when
   * the caller did not sign in through the Plex source. Claim-only — there is no override column.
   */
  userId: string | null;
  /** plex.tv account email (from the claim or the admin override), lowercased — or null. */
  email: string | null;
  /** plex.tv account username (from the claim or the admin override), lowercased — or null. */
  username: string | null;
}

/** The empty identity — the matcher then falls back to the caller's app/OIDC email. */
export const EMPTY_PLEX_IDENTITY: PlexIdentity = { userId: null, email: null, username: null };

/** Normalize an identity field: trim + lowercase; empty/non-string → null. */
export function normalizePlexField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * fix/plex-numeric-id — normalize the `plex_user_id` claim to the string form the plex.tv account
 * / friend `id` uses (the read client coerces both to `String`). A finite number or a non-blank
 * string → its trimmed string; anything else (blank, null, object) → null. NOT lowercased (ids are
 * digits, and the comparison must be exact).
 */
export function normalizePlexUserId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

/**
 * Decode the `plex_user_id` / `plex_email` / `plex_username` claims from an OIDC id_token (a JWT).
 * The token was already signature-verified by Better Auth at sign-in and now lives in our own
 * `account` row, so we decode the payload segment WITHOUT re-verifying — this is an identity HINT
 * for share display, never an authorization decision. Tolerant by design: a missing/malformed
 * token, non-JWT string, or absent claims all yield the empty identity (the caller then falls back
 * to the override/email).
 */
export function plexIdentityFromIdToken(idToken: string | null | undefined): PlexIdentity {
  if (!idToken || typeof idToken !== 'string') return { ...EMPTY_PLEX_IDENTITY };
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) return { ...EMPTY_PLEX_IDENTITY };
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    return {
      userId: normalizePlexUserId(claims.plex_user_id),
      email: normalizePlexField(claims.plex_email),
      username: normalizePlexField(claims.plex_username),
    };
  } catch {
    return { ...EMPTY_PLEX_IDENTITY };
  }
}

/**
 * Resolve the caller's Plex identity, per-field: the id_token CLAIM wins when present (the user
 * authenticated through the Authentik Plex source, so it is authoritative and current), otherwise
 * the admin-set OVERRIDE column. Per-field precedence means a claim carrying only the username
 * still picks up an override email, and vice-versa. The NUMERIC `userId` is claim-only (Authentik
 * holds it reliably — no override column). Empty fields fall through to the app email in the
 * matcher (packages/api plex router).
 */
export function resolvePlexIdentity(args: {
  idToken?: string | null;
  overrideEmail?: string | null;
  overrideUsername?: string | null;
}): PlexIdentity {
  const claim = plexIdentityFromIdToken(args.idToken);
  return {
    userId: claim.userId,
    email: claim.email ?? normalizePlexField(args.overrideEmail),
    username: claim.username ?? normalizePlexField(args.overrideUsername),
  };
}
