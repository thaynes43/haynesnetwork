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
        <Link href="/admin/catalog">Catalog</Link>
        <Link href="/admin/tags">Tags</Link>
      </nav>
      {children}
    </div>
  );
}
