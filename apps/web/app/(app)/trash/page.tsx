// ADR-023 / DESIGN-010 D-08 — the /trash route GATE (server-side, like every access rule: the
// client never receives markup it can't use). The (app) layout already bounced anonymous visitors
// to /login; here the caller's Trash section LEVEL (ADR-023 / ADR-021, session-carried) decides
// what renders: Disabled gets a clean "not available" state (never a raw 403 — the trash.* tRPC
// surface rejects them server-side too, AC-13); Read-Only and Edit reach the section.
//
// NOTE: the Trash UX (pending tables, Save shield, Expedite, Rules editor, Recently-Deleted,
// Activity) is the Fable UX follow-up (this change ships the BACKEND vertical + the route gate so
// the retired /admin/restore redirect has a live target). The placeholder below is intentionally
// minimal — the follow-up replaces it with the client built against the trash.* contracts.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';

export default async function TrashPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const level = effectiveSectionLevel(session.user.role, 'trash');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="trash-unavailable">
        <h1 className="page-title">Trash</h1>
        <p>Trash isn’t available on your account.</p>
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

  return (
    <section className="card" data-testid="trash-placeholder">
      <h1 className="page-title">Trash</h1>
      <p className="muted">
        The Trash section is being set up. The pending-deletion tables, Save, Expedite, Rules,
        Recently Deleted, and Activity land in the next update.
      </p>
    </section>
  );
}
