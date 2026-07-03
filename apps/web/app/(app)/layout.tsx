// DESIGN-004 D-05/D-11 — the authed app frame: server-side session gate (anonymous →
// /login, no tRPC round-trip) + the chrome column (56px topbar, flex:none; <main>
// flex:1 min-height:0 overflow:auto — content scrolls internally, the page never
// scrolls).
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { TopBar } from '@/components/top-bar';
import { protectedRouteRedirect } from '@/lib/route-gate';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(await headers());
  const dest = protectedRouteRedirect(session?.user ?? null);
  if (dest !== null || session === null) redirect(dest ?? '/login');
  const { displayName, email, role } = session.user;

  return (
    <div className="app">
      <TopBar user={{ displayName, email, role }} />
      <main>{children}</main>
    </div>
  );
}
