// fix/plex-identity-mapping — the Plex identity resolver (id_token plex_* claims → admin override).
// The implementation lives in @hnet/domain (`packages/domain/src/plex-identity.ts`) since 2026-09-23:
// the ADR-053 Plex Account Map's resolution helpers are a DOMAIN seam, and its reconcile runs in the
// sync runner, which must not depend on Better Auth. Re-exported here unchanged so the session
// hydration (session-extension.ts) and every `@hnet/auth` consumer keep their import paths.
export {
  EMPTY_PLEX_IDENTITY,
  normalizePlexField,
  normalizePlexUserId,
  plexIdentityFromIdToken,
  resolvePlexIdentity,
  type PlexIdentity,
} from '@hnet/domain';
