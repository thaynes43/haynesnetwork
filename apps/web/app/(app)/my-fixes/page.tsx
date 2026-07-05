// DESIGN-005 D-17 — /my-fixes relocated into the Library "My Fixes" sub-tab. This
// server redirect keeps old deep links alive.
import { redirect } from 'next/navigation';

export default function MyFixesPage() {
  redirect('/library?tab=my-fixes');
}
