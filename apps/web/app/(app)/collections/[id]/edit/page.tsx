// DESIGN-044 D-01 — the EDIT route for the full-page collection builder: `/collections/<id>/edit`. The page
// opens pre-loaded with the recipe (the DESIGN-043 openEdit data, read authoritatively from the overview);
// the builder type + name are LOCKED (the DESIGN-042 D-05 identity rule — only the ref + options change). The
// tab (media type) rides on ?tab; a hand-authored Kometa collection carries ?hand=<file>. An unknown id lands
// on the page with a quiet "that collection could not be loaded" note, never an error modal (D-01).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { CollectionBuilderClient } from '../../builder-client';

export default async function EditCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const { id } = await params;
  return (
    <CollectionBuilderClient
      isAdmin={session.user.role.isAdmin}
      mode="edit"
      editId={decodeURIComponent(id)}
    />
  );
}
