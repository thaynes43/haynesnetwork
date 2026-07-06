// DESIGN-009 D-01 — the /ledger route gate (server-side, like every access rule: the client
// never receives markup it can't use). The (app) layout has already bounced anonymous
// visitors to /login; here the caller's Ledger section LEVEL (ADR-021, session-carried)
// decides what renders: Disabled gets a clean "not available" state — a friendly dead end,
// never a raw 403 (the tRPC surface rejects them anyway, server-authoritative — AC-13);
// Read-Only and Edit get the client browser, with the edit power flagged down the tree.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { LedgerClient } from './ledger-client';

export default async function LedgerPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const level = effectiveSectionLevel(session.user.role, 'ledger');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="ledger-unavailable">
        <h1 className="page-title">Ledger</h1>
        <p>The Ledger isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include this section. If you think it should, ask an admin to update
          your role’s section access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to the dashboard
          </Link>
        </p>
      </section>
    );
  }

  return <LedgerClient canEdit={level === 'edit'} />;
}
