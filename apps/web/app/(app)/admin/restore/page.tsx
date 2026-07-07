// ADR-023 / DESIGN-010 D-08 — the admin Restore page is RETIRED as a destination: its Recently-
// Deleted + Restore capability re-homes into the Trash section (Restore reuses the same
// executeRestore path via trash.restoreDeleted; restoreRouter stays callable and untouched). Any
// hit on /admin/restore now redirects to /trash (the plan retires the nav item + redirects; the
// diff/re-add UI re-home into Ledger is PLAN-005's scope, out of PLAN-006).
import { redirect } from 'next/navigation';

export default function AdminRestorePage(): never {
  redirect('/trash');
}
