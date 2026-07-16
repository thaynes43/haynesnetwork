// ADR-063 / DESIGN-034 D-03 — the /about help page: session-gated like every (app) route but
// otherwise UNGATED (no section permission — ADR-063 C-04, every logged-in member sees it).
// The content is static server TSX (about-content.tsx); the ONE dynamic read on the page
// (D-06) is the live Trash save-window default, read straight through the @hnet/domain
// app-settings helper (the same direct-domain-read idiom as the webhook route — a pure read,
// lazy default db client).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { getAppSetting } from '@hnet/domain';
import { AboutContent } from './about-content';

export default async function AboutPage() {
  // The (app) layout gates too; this re-check keeps the page self-sufficient (dashboard idiom).
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');

  const trashWindowDays = await getAppSetting(undefined, 'trash_default_window_days');
  return <AboutContent trashWindowDays={trashWindowDays} />;
}
