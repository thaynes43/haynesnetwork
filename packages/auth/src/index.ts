// @hnet/auth — Better Auth wired to Authentik OIDC (the sole sign-in method) per
// DESIGN-002; consumed by apps/web's catch-all route and DESIGN-003's tRPC context.
import { auth } from './config';
import { getSessionExtension, type SessionRole } from './hooks/session-extension';
import type { PlexIdentity } from './hooks/plex-identity';

export { auth, oidcEnabled, type Auth } from './config';
export { bootstrapAdminOnSignin } from './hooks/bootstrap-admin';
export {
  getSessionExtension,
  type SessionExtension,
  type SessionRole,
} from './hooks/session-extension';
export {
  resolvePlexIdentity,
  plexIdentityFromIdToken,
  normalizePlexField,
  EMPTY_PLEX_IDENTITY,
  type PlexIdentity,
} from './hooks/plex-identity';
export {
  authEnv,
  assertAuthEnv,
  parseBootstrapAdminEmails,
  DEFAULT_OIDC_DISCOVERY_URL,
  OIDC_PROVIDER_ID,
  type AuthEnv,
} from './env';
export {
  resolveSignOutRedirect,
  buildEndSessionUrl,
  parseEndSessionEndpoint,
  fetchEndSessionEndpoint,
  postLogoutRedirectUri,
  idTokenExpMs,
  isFreshIdToken,
  type EndSessionParams,
} from './logout';

type RawSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * The session-user shape DESIGN-003's tRPC context consumes. ADR-012: `role` is the
 * user's single role ({ id, name, isAdmin }), hydrated (users ⋈ roles) by
 * getSessionExtension; admin gating switches on `role.isAdmin`.
 */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: SessionRole;
  /**
   * fix/plex-identity-mapping — the caller's resolved REAL Plex identity (claim → admin override),
   * NOT the OIDC email. Both fields may be null (no claim, no override); the My Plex matcher then
   * falls back to `email`. Lets plex.myLibraries recognize the owner/friend even when the Authentik
   * email differs from the plex.tv account email.
   */
  plexIdentity: PlexIdentity;
}

/** A live server-side session: Better Auth's session row + the hydrated user. */
export interface Session {
  session: RawSession['session'];
  user: SessionUser;
}

/**
 * Donor pattern via auth.api.getSession, extended per DESIGN-002 D-06: Better Auth
 * resolves the DB-backed session from the request headers, then one users ⋈ roles read
 * grafts on role/displayName. Returns null for no/invalid session — and when the user row
 * has vanished (fail closed, DESIGN-003 D-01).
 */
export async function getServerSession(headers: Headers): Promise<Session | null> {
  const raw = await auth.api.getSession({ headers });
  if (!raw) return null;
  const extension = await getSessionExtension(raw.user.id);
  if (!extension) return null;
  return {
    session: raw.session,
    user: {
      id: raw.user.id,
      email: raw.user.email,
      displayName: extension.displayName,
      role: extension.role,
      plexIdentity: extension.plexIdentity,
    },
  };
}
