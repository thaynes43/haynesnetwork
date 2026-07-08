// ADR-023 / DESIGN-010 D-09 — the /trash route GATE (server-side, like every access rule: the
// client never receives markup it can't use). The (app) layout already bounced anonymous
// visitors to /login; here the caller's Trash section LEVEL (ADR-023 / ADR-021, session-carried)
// decides what renders: Disabled gets a clean "not available" state (never a raw 403 — the
// trash.* tRPC surface rejects them server-side too, AC-16); Read-Only and Edit get the client,
// with the effective per-action grants resolved HERE (admin ⇒ all actions, no rows) and passed
// down so the client shows only affordances the server would honor.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel, effectiveTrashActions } from '@hnet/api';
import { TRASH_ACTIONS } from '@hnet/db';
import { TrashClient } from './trash-client';

export default async function TrashPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'trash');

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

  // ADR-023 C-03 — admin implies every action with no rows; otherwise the session grants, expanded
  // with the computed implication (ADR-025 errata — `save_exclude` ⇒ `save_leaving_soon`) so the
  // Leaving-Soon rescue wall lights up for global-Save holders exactly as the server would honor.
  const actions = role.isAdmin ? [...TRASH_ACTIONS] : effectiveTrashActions(role.trashActions ?? []);
  return (
    <TrashClient
      access={{ level, actions }}
      viewerId={session.user.id}
      viewerIsAdmin={role.isAdmin}
    />
  );
}
