// ADR-050 / DESIGN-012 D-12 (PLAN-034) — /bulletin/ticket/[id]: the ticket drill-in's server
// GATE (the /bulletin + /library/[id] pattern). The (app) layout already bounced anonymous
// visitors; here the caller's Bulletin section level + `messages` sub-view grant decide whether
// the detail client mounts at all (the tickets.* tRPC surface rejects them server-side too).
// The staff affordances (state transitions) ride the resolved `moderate` grant (AC-13 — the
// client renders only what the server would honor).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { BULLETIN_VIEW_DEFAULTS, MESSAGE_ACTIONS } from '@hnet/db';
import { TicketDetail } from './ticket-detail';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'bulletin');
  const views = role.isAdmin
    ? ['feed', 'messages']
    : (role.bulletinViews ?? [...BULLETIN_VIEW_DEFAULTS]);

  if (level === 'disabled' || !views.includes('messages')) {
    return (
      <section className="card empty-state" data-testid="ticket-unavailable">
        <h1 className="page-title">Helpdesk</h1>
        <p>This ticket isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include the Bulletin Helpdesk. If you think it should, ask an admin to
          update your role’s access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to the dashboard
          </Link>
        </p>
      </section>
    );
  }

  const actions = role.isAdmin ? [...MESSAGE_ACTIONS] : (role.messageActions ?? []);
  return <TicketDetail ticketId={id} actions={actions} />;
}
