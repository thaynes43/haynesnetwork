// DESIGN-044 D-01 — the CREATE route for the full-page collection builder: `/collections/new?tab=<mediaType>`.
// A universal surface (everyone signed in may add within the size cap; the layout already gated anonymous
// visitors, and every write is re-checked server-side). The media tab (read client-side from ?tab) seeds the
// provider binding + the builder-card set.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { CollectionBuilderClient } from '../builder-client';

export default async function NewCollectionPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  return <CollectionBuilderClient isAdmin={session.user.role.isAdmin} mode="create" />;
}
