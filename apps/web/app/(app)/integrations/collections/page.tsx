// ADR-072 / DESIGN-043 D-01/D-15 (PLAN-052 PR4a) — the collection manager MOVED to the first-class
// top-level /collections page. This old sub-section route now permanently redirects there so any deep
// link (a bookmark, a saved URL) survives the move.
import { redirect } from 'next/navigation';

export default function CollectionsManagerRedirect() {
  redirect('/collections');
}
