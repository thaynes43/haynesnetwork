// ADR-026 / DESIGN-012 D-08 — the /bulletin route GATE (server-side, like /trash: the client
// never receives markup it can't use). The (app) layout already bounced anonymous visitors to
// /login; here the caller's Bulletin section LEVEL (session-carried, ADR-021) decides what
// renders: Disabled gets a clean "not available" state (the communication.* tRPC surface
// rejects them server-side too); Read-Only and Edit get the client, with the effective
// fine-grained message-action grants resolved HERE (admin ⇒ both actions, no rows) and passed
// down so the client shows only affordances the server would honor (D-04).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { MESSAGE_ACTIONS } from '@hnet/db';
import { BulletinClient } from './bulletin-client';

export default async function BulletinPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'bulletin');

  if (level === 'disabled') {
    return (
      <section className="card empty-state" data-testid="bulletin-unavailable">
        <h1 className="page-title">Bulletin</h1>
        <p>Bulletin isn’t available on your account.</p>
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

  // ADR-026 C-04 — admin implies both actions with no rows; otherwise the session grants.
  const actions = role.isAdmin ? [...MESSAGE_ACTIONS] : (role.messageActions ?? []);
  return <BulletinClient access={{ level, actions }} viewerId={session.user.id} />;
}
