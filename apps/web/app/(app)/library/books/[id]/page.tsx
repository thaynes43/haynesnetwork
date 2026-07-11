// ADR-047 / DESIGN-025 (PLAN-028) — /library/books/[id]: the in-app Books/Audiobooks/Comics DETAIL page
// (owner UX ruling 2026-07-11 — the poster now opens this instead of jumping straight out). Server wrapper:
// resolves the route param + the `?from=` back-link origin, and gates on the `books` section (a Disabled
// caller is bounced to /library — the same server-authoritative gate the walls + the books.detail tRPC use).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@hnet/auth';
import { effectiveSectionLevel } from '@hnet/api';
import { BooksDetail } from './books-detail';

export default async function BooksItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const fromParam = (await searchParams).from;
  const from = typeof fromParam === 'string' ? fromParam : null;
  const session = await getServerSession(await headers());
  if (!session) redirect('/login'); // defense in depth — the layout already gates
  if (effectiveSectionLevel(session.user.role, 'books') === 'disabled') redirect('/library');
  return <BooksDetail id={id} from={from} />;
}
