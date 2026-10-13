// ADR-111 C-02 / ADR-112 C-02, C-03 / DESIGN-055 D-10, D-12 (PLAN-077 P3) — /admin/seerr: every Seerr report, what the
// app did about it, and the staff note. Admin-only (the AdminLayout gate). The server wrapper hands the client the
// public origin, so the fix-it-yourself link reads https://haynesnetwork.com/r/seerr/<id> even when an admin is on the
// in-cluster route.
import { issuerOrigin } from '@hnet/oauth';
import { SeerrIssuesAdmin } from './seerr-issues-admin';

export const dynamic = 'force-dynamic';

export default function AdminSeerrIssuesPage() {
  return <SeerrIssuesAdmin linkOrigin={issuerOrigin()} />;
}
