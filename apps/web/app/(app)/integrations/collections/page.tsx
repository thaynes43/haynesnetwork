// ADR-069 / DESIGN-042 D-01 (PLAN-052 — collection manager) — the Collections SUB-SECTION route gate
// (server-side, mirroring /integrations/goodreads): the (app) layout already bounced anonymous visitors;
// the caller's Integrations section LEVEL (session-carried, ADR-021) decides whether the manager renders.
// The finer manage/acquire capability is enforced by the collections.* tRPC surface (the overview query
// FORBIDs an ungranted caller) — the client renders the honest "not available" state on that.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { CollectionsClient } from './collections-client';

export default async function CollectionsManagerPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const level = effectiveSectionLevel(session.user.role, 'integrations');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="integrations-unavailable">
        <h1 className="page-title">Collections</h1>
        <p>Collections isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include this section. If you think it should, ask an admin to update your
          role’s section access.
        </p>
        <p>
          <Link className="btn" href="/integrations">
            Back to Integrations
          </Link>
        </p>
      </section>
    );
  }

  return <CollectionsClient />;
}
