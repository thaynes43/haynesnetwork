// DESIGN-005 D-17 — /library/[id]: server wrapper resolves the route param; the
// client component composes ledger.detail + ledger.events + the Fix dialog (D-15).
// DESIGN-010 D-09 — the wrapper also resolves the caller's Trash access (section level +
// per-action grants, session-carried) so the detail view can mount the deletion-guard panel
// (the perma-save shield) for Movies/TV when the item is pending deletion. Music never gets
// a shield (R-87), and a Disabled-trash caller gets no panel at all (null access).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { TRASH_ACTIONS } from '@hnet/db';
import { ItemDetail, type ItemTrashAccess } from './item-detail';

export default async function LibraryItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // Read the back-link origin key SERVER-side (DESIGN-005 D-17) — passing it down avoids a
  // useSearchParams() CSR bailout on the detail page (which has no Suspense boundary).
  const fromParam = (await searchParams).from;
  const from = typeof fromParam === 'string' ? fromParam : null;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  const level = effectiveSectionLevel(role, 'trash');
  const trashAccess: ItemTrashAccess =
    level === 'disabled'
      ? null
      : { level, actions: role.isAdmin ? [...TRASH_ACTIONS] : (role.trashActions ?? []) };
  return <ItemDetail mediaItemId={id} trashAccess={trashAccess} from={from} />;
}
