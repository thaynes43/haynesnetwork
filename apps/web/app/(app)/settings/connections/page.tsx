// ADR-091 C-10 / DESIGN-050 D-08 / D-14 — /settings/connections, "Connected apps": every signed-in user's
// self-service view of the apps they allowed to use their watch history (the settings menu shows it to everyone);
// an admin additionally sees every user's connections, with a user column. Read server-side through the
// @hnet/domain `listConnectedApps` read (one row per client with a live refresh family or an unexpired access
// token); Disconnect is a server action (./actions.ts).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { listConnectedApps } from '@hnet/domain';
import { connectionRows } from '@/lib/connections';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connected apps — haynesnetwork' };

export default async function ConnectionsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the (app) layout already gates
  const admin = session.user.role.isAdmin;
  const apps = await listConnectedApps({ userId: admin ? null : session.user.id });
  const rows = connectionRows(apps, { withUser: admin });

  return (
    <section className="card conn-page" data-testid="connections-page">
      <h1 className="page-title">Connected apps</h1>
      <p className="conn-page__lead">
        Apps you have allowed to use your watch history. Disconnecting stops an app at its next
        request.
      </p>
      <ConnectionsClient rows={rows} />
    </section>
  );
}
