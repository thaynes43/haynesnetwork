// ADR-091 / DESIGN-050 D-02 / D-05 — `GET /oauth/authorize`, the authorization endpoint. A page rather than a
// route handler so its one non-redirect answer — the D-14 bad-request card — renders with the app's theme tokens
// (hard rule 2); everything else is a server redirect before anything renders (`lib/oauth/authorize.ts`).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { handleAuthorize } from '@/lib/oauth/authorize';
import { BadRequestCard } from '../oauth-message';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect an app — haynesnetwork', robots: { index: false } };

type Search = Record<string, string | string[] | undefined>;

/** Next's parsed query back to URLSearchParams, repeated keys kept (a repeat is refused, RFC 6749 §3.1). */
export function toSearchParams(search: Search): URLSearchParams {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
      q.append(key, v);
  }
  return q;
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const outcome = await handleAuthorize({
    query: toSearchParams(await searchParams),
    headers: await headers(),
  });
  if (outcome.kind === 'redirect') redirect(outcome.location);
  return <BadRequestCard />;
}
