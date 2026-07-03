// DESIGN-004 D-07 — dashboard: catalog.myApps via the tRPC server caller (never
// profile.me for tiles — one source of truth), greeting, auto-fill tile grid,
// empty state. Tiles are whole-anchor targets opening in a new tab; hrefs come
// straight from the API and are already guaranteed https://*.haynesnetwork.com
// (R-14 enforced at write time) — the UI never constructs URLs.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { AppIcon } from '@hnet/ui';
import { getServerCaller } from '@/lib/trpc-server';
import { Greeting } from './greeting';

export default async function DashboardPage() {
  // The (app) layout gates too; this re-check keeps the page self-sufficient (the
  // caller would otherwise throw UNAUTHORIZED before the layout redirect settles).
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');

  const caller = await getServerCaller();
  const apps = await caller.catalog.myApps();

  return (
    <>
      <Greeting displayName={session.user.displayName} />
      {apps.length === 0 ? (
        <section className="card empty-state">
          <p>No apps yet — ask your admin.</p>
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
