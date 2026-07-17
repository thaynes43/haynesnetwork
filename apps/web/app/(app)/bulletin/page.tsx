// ADR-050 / DESIGN-012 D-12 — the /bulletin route GATE (server-side, like /trash: the client
// never receives markup it can't use). The (app) layout already bounced anonymous visitors to
// /login; here the caller's Bulletin section LEVEL (session-carried, ADR-021) decides what
// renders: Disabled gets a clean "not available" state (the communication.* tRPC surface
// rejects them server-side too); Read-Only and Edit get the client, with the effective
// fine-grained action grants (create = post, transitions = moderate — PLAN-034) resolved HERE
// (admin ⇒ both, no rows) and passed down so the client shows only affordances the server
// would honor (D-04 / AC-13).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { BULLETIN_VIEWS, BULLETIN_VIEW_DEFAULTS, MESSAGE_ACTIONS } from '@hnet/db';
import { HELPDESK_NAME } from '@/lib/bulletin';
import { BulletinClient } from './bulletin-client';

export default async function BulletinPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'bulletin');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="bulletin-unavailable">
        <h1 className="page-title">{HELPDESK_NAME}</h1>
        <p>{HELPDESK_NAME} isn’t available on your account.</p>
        <p className="muted">
          Your role doesn’t include this section. If you think it should, ask an admin to update
          your role’s section access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to Home
          </Link>
        </p>
      </section>
    );
  }

  // ADR-026 C-04 — admin implies both actions with no rows; otherwise the session grants.
  const actions = role.isAdmin ? [...MESSAGE_ACTIONS] : (role.messageActions ?? []);
  // ADR-049 C-02 (PLAN-027) — the caller's granted Bulletin SUB-VIEWS: admin ⇒ both; else the
  // session-resolved set (already carrying the "no rows ⇒ both" default). The `messages` view
  // carries the HELPDESK since PLAN-034 (ADR-050 option H). The client renders only these
  // sub-tabs — a messages-only role (e.g. Default) sees NO Feed tab, and the feed endpoint
  // FORBIDs it server-side regardless. Defense in depth if the session lacks the field.
  const views = role.isAdmin
    ? [...BULLETIN_VIEWS]
    : (role.bulletinViews ?? [...BULLETIN_VIEW_DEFAULTS]);
  return <BulletinClient access={{ level, actions, views }} />;
}
