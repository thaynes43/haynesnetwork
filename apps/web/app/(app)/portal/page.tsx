// DESIGN-004 D-23 (owner-directed 2026-07-17) — PORTAL, the launcher screen: the app
// catalog grid exactly as the old dashboard rendered it (catalog.myApps via the tRPC server
// caller — never profile.me; whole-anchor tiles opening in a new tab; hrefs straight from
// the API, arbitrary admin-curated http(s) URLs — ADR-013), MINUS the three seeded direct
// Plex server cards (a display exclusion keyed on the seeded slugs — lib/portal.ts; the
// catalog rows stay admin-curated data, R-11), PLUS the full-width INVERTED link to the
// Plex WEB PLAYER at the top (Plex auth is plex.tv-only — no Authentik SSO flow exists —
// and app.plex.tv's server picker reaches every server the account can access).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { AppIcon } from '@hnet/ui';
import { getServerCaller } from '@/lib/trpc-server';
import { PLEX_WEB_PLAYER_URL, PORTAL_NAME, portalApps } from '@/lib/portal';

export default async function PortalPage() {
  // The (app) layout gates too; this re-check keeps the page self-sufficient (the
  // caller would otherwise throw UNAUTHORIZED before the layout redirect settles).
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');

  const caller = await getServerCaller();
  const apps = portalApps(await caller.catalog.myApps());

  return (
    <>
      <h1 className="page-title">{PORTAL_NAME}</h1>
      {/* D-23 — the Plex web-player entry: the inverted-tile idiom (the About tile's accent
          fill — hover deepens color only, ADR-015), full width above the perforated rule.
          External like the SSO tiles: new tab, no opener. */}
      <a
        href={PLEX_WEB_PLAYER_URL}
        className="tile tile--inverted tile--plex"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="portal-plex-link"
      >
        <span className="tile__top">
          <AppIcon icon="plex" className="tile__icon" width={28} height={28} />
          <span className="tile__ext" aria-hidden="true">
            ↗
          </span>
        </span>
        <span className="tile__name">
          Watch on Plex
          <span className="sr-only"> (opens in new tab)</span>
        </span>
        <span className="tile__desc">
          Opens the Plex web player with every server you have access to.
        </span>
      </a>
      <hr className="tile-rule" />
      {apps.length === 0 ? (
        <section className="card empty-state">
          <p>No apps yet. Ask your admin.</p>
        </section>
      ) : (
        <div className="tile-grid">
          {apps.map((app) => (
            <a
              key={app.id}
              className="tile"
              href={app.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="tile__top">
                <AppIcon icon={app.icon} className="tile__icon" width={28} height={28} />
                <span className="tile__ext" aria-hidden="true">
                  ↗
                </span>
              </span>
              <span className="tile__name">
                {app.name}
                <span className="sr-only"> (opens in new tab)</span>
              </span>
              {app.description ? <span className="tile__desc">{app.description}</span> : null}
            </a>
          ))}
        </div>
      )}
    </>
  );
}
