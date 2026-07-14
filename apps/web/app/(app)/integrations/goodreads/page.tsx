// ADR-057 / DESIGN-029 (PLAN-045) — the Goodreads SUB-SECTION route gate (server-side, mirroring
// /integrations): the (app) layout already bounced anonymous visitors; the caller's Integrations
// section LEVEL (session-carried, ADR-021) decides what renders — Disabled gets the clean
// "not available" state (the integrations.* tRPC surface rejects them server-side too).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { GoodreadsClient } from './goodreads-client';

export default async function GoodreadsIntegrationPage() {
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

  return <GoodreadsClient />;
}
