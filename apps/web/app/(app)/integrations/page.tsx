// ADR-055 / DESIGN-028 D-05 (PLAN-044) — the /integrations route GATE (server-side, like /metrics). The
// (app) layout already bounced anonymous visitors to /login; here the caller's Integrations section LEVEL
// (session-carried, ADR-021) decides what renders: Disabled gets a clean "not available" state (the
// integrations.* tRPC surface rejects them server-side too — ships Admin-only), Read-Only/Edit get the
// client.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { IntegrationsClient } from './integrations-client';

export default async function IntegrationsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const level = effectiveSectionLevel(session.user.role, 'integrations');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="integrations-unavailable">
        <h1 className="page-title">Integrations</h1>
        <p>Integrations isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include this section. If you think it should, ask an admin to update your
          role’s section access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to the dashboard
          </Link>
        </p>
      </section>
    );
  }

  return <IntegrationsClient />;
}
