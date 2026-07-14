// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — /library/activity/[failureId]: the import-failure
// DETAIL page (the #264 wanted-detail idiom). Server wrapper: resolves the route param + the `?from=`
// back-link origin. The Activity tab is always-on, so any authed user can REACH this URL; the PER-FAILURE
// section gate (a book failure needs `books ≥ read_only`) is enforced server-side in `activity.failure`
// (FORBIDDEN → the client shows an unavailable note), and the retry-import / force-research ACTIONS keep
// their own `activityActionProcedure` (admin OR role grant) gate. Defense in depth: bounce an unauth'd
// request to /login (the layout already gates).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { ActivityFailureDetail } from './activity-failure-detail';

export default async function ActivityFailurePage({
  params,
  searchParams,
}: {
  params: Promise<{ failureId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { failureId } = await params;
  const fromParam = (await searchParams).from;
  const from = typeof fromParam === 'string' ? fromParam : null;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login');
  return <ActivityFailureDetail failureId={failureId} from={from} />;
}
