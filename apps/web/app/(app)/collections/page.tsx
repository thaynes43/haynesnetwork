// ADR-072 / DESIGN-043 D-01 (PLAN-052 PR4a) — the first-class /collections route. A UNIVERSAL surface
// (everyone signed in sees it, like /library): the (app) layout already bounced anonymous visitors to
// /login, so there is no section gate here. The finer capabilities (add/edit within the cap for everyone;
// delete + ticket approve + settings for admins) are enforced by the collections.* tRPC surface; the
// server-known `isAdmin` only decides which sub-nav tabs (Settings) and lenses (the admin ticket approve)
// render — the server re-checks every write regardless.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { CollectionsClient } from './collections-client';

export default async function CollectionsPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  return <CollectionsClient isAdmin={session.user.role.isAdmin} />;
}
