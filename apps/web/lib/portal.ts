// DESIGN-004 D-23 (owner-directed 2026-07-17) — the HOME/PORTAL split. The Portal is the
// launcher screen (/portal): the role-gated app catalog grid moved off `/` (now the calm
// Home screen) plus the inverted Plex web-player link at the top.
//
// PORTAL_NAME is the D-22 HELPDESK_NAME idiom: the ratified nav label lives in ONE constant
// so the top-bar entry and any future heading/back-link copy can never drift.

/** The ratified top-nav label for the launcher screen (route `/portal`). */
export const PORTAL_NAME = 'Portal';

/**
 * The Plex WEB PLAYER (app.plex.tv) — the one Plex entry point the Portal offers. Plex auth
 * is plex.tv-only (no Authentik SSO flow exists — DESIGN-041 classifies the Plex cards
 * N/A-by-design), and the web player's own server picker reaches every server the account
 * can access, so one link replaces the three direct-server cards with nothing lost.
 */
export const PLEX_WEB_PLAYER_URL = 'https://app.plex.tv';

/**
 * The three direct Plex SERVER cards the Portal does not render (owner spec 2026-07-17:
 * "there is no value in linking to the direct servers because we cannot do an Authentik
 * SSO flow for Plex"). Keyed on the SEEDED slugs (migration 0002) — a pure display
 * exclusion: the catalog rows stay admin-curated data (R-11), `/admin/catalog` still lists
 * them, and an admin can add different cards (any other slug) freely. Deleting the rows in
 * /admin/catalog makes this set a no-op.
 */
export const PORTAL_HIDDEN_SLUGS: ReadonlySet<string> = new Set(['plex', 'k8plex', 'plexops']);

/** Filters the caller's effective apps down to the set the Portal grid renders. */
export function portalApps<T extends { slug: string }>(apps: readonly T[]): T[] {
  return apps.filter((app) => !PORTAL_HIDDEN_SLUGS.has(app.slug));
}
