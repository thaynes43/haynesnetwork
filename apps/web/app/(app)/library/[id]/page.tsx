// DESIGN-005 D-17 — /library/[id]: server wrapper resolves the route param; the
// client component composes ledger.detail + ledger.events + the Fix dialog (D-15).
import { ItemDetail } from './item-detail';

export default async function LibraryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemDetail mediaItemId={id} />;
}
