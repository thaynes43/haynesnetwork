// ADR-032 / DESIGN-004 D-16 — the /settings/trash route GATE (server-side, like every access
// rule: the client never receives markup it can't use). Trash SETTINGS (Maintainerr rules +
// the batch-pipeline knobs) are operator tooling, not a user-facing Trash surface, so they
// moved out of the /trash tabs to here — reached from the user menu, and gated at the Trash
// section EDIT level (admins implicitly pass — ADR-021 C-03; no new tables or enums, the
// existing section primitives are the whole gate). Below Edit renders the clean "not
// available" state, mirroring /trash and /ledger; the trash.* tRPC surface refuses the
// mutations server-side regardless (rule writes need section Edit + the edit_rules grant,
// the settings card is adminProcedure).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { TRASH_ACTIONS } from '@hnet/db';
import { TrashSettingsClient } from './trash-settings-client';

export default async function TrashSettingsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'trash');

  if (level !== 'edit') {
    return (
      <section className="card empty-state" data-testid="trash-settings-unavailable">
        <h1 className="page-title">Trash settings</h1>
        <p>Trash settings aren’t available on your account.</p>
        <p className="muted">
          Managing deletion rules and pipeline settings needs Trash access at the Edit level. If you
          think you should have it, ask an admin to update your role’s section access.
        </p>
        <p>
          <Link className="btn" href="/">
            Back to the dashboard
          </Link>
        </p>
      </section>
    );
  }

  // ADR-023 C-03 — admin implies every action with no rows; otherwise the session grants.
  const actions = role.isAdmin ? [...TRASH_ACTIONS] : (role.trashActions ?? []);
  return <TrashSettingsClient access={{ level, actions }} viewerIsAdmin={role.isAdmin} />;
}
