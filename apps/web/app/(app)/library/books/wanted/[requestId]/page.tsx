// ADR-057 amendment (PLAN-047 — DESIGN-029 amendment-2, owner Wanted-parity ruling) —
// /library/books/wanted/[requestId]: the Movies/TV poster→detail parity page for a book_requests WANT.
// PR #261 (v0.50.1) delivered the unified wall anatomy; this page is the missing half — the poster now
// opens a DETAIL page with per-format Force-Search, exactly like the ledger Movies/TV detail.
//
// Server wrapper (the /library/books/[id] idiom): resolves the route param + the `?from=` back-link origin,
// and gates on `books` OR `integrations` (≥ read_only) — the page is reachable by whoever can see the card
// that links to it (the household Library-Wanted book cards are books-gated; the per-user Goodreads items
// wall is integrations-gated). A caller with NEITHER section is bounced to /library. The per-format
// Force-Search action keeps its own `integrations` + ownership gate inside `integrations.search`.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { WantedDetail } from './wanted-detail';

export default async function WantedRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { requestId } = await params;
  const fromParam = (await searchParams).from;
  const from = typeof fromParam === 'string' ? fromParam : null;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  const role = session.user.role;
  if (
    effectiveSectionLevel(role, 'books') === 'disabled' &&
    effectiveSectionLevel(role, 'integrations') === 'disabled'
  ) {
    redirect('/library');
  }
  return <WantedDetail requestId={requestId} from={from} />;
}
