// DESIGN-004 D-11 — /admin/* gate: server-side role check on top of the (app)
// session gate; non-Admin → redirect('/'). The client never sees admin markup it
// can't use. Also hosts the admin sub-nav (<nav> landmark, D-10).
import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { protectedRouteRedirect } from '@/lib/route-gate';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(await headers());
  const dest = protectedRouteRedirect(session?.user ?? null, { requireAdmin: true });
  if (dest) redirect(dest);

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin sections">
        <Link href="/admin">Users</Link>
        {/* ADR-045 / DESIGN-023 (PLAN-026) — the full Authentik directory (superset of Users). */}
        <Link href="/admin/users">Directory</Link>
        <Link href="/admin/catalog">Catalog</Link>
        <Link href="/admin/roles">Roles</Link>
        <Link href="/admin/fixes">Fixes</Link>
        {/* ADR-027 / DESIGN-004 D-15 (PLAN-010) — the dashboard Message-of-the-Day compose surface. */}
        <Link href="/admin/motd">MOTD</Link>
        {/* IA reshuffle (2026-07-09, build B) — the Storage nav item is retired: disk utilization +
            reclaim + policy moved into the tabbed Trash Settings hub (user menu → Trash settings →
            Storage/Reclaim). /admin/storage now redirects to /settings/trash?tab=storage. */}
        {/* ADR-023 / DESIGN-010 D-08 — the Restore nav item is retired: its capability re-homes
            into the Trash section's Recently-Deleted (and PLAN-005's Ledger). /admin/restore now
            redirects to /trash; restoreRouter stays callable. */}
      </nav>
      {children}
    </div>
  );
}
