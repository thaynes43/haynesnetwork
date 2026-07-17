// DESIGN-025 D-08 (books detail-page parity) — seed the History the movie-anatomy detail page shows:
// a couple of audited book-Fix rows (the `book_fix_requests` trail) on a book + an audiobook, and a
// system PAIRING request anchored on the book (so its "History" section renders). Runs as a tsx
// subprocess from the capture harness AFTER startStack, through the sanctioned @hnet/db client (the
// DATABASE_URL env the stack exports) — a capture-only seed, never shipped state.
//
//   DATABASE_URL=… tsx e2e/support/seed-books-detail-history.ts
import { writeFileSync } from 'node:fs';
import { db, bookFixRequests, bookRequests, booksItems, users } from '@hnet/db';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

async function main(): Promise<void> {
  const now = Date.now();
  // The walls are a few thousand rows (ADR-046) — fetch and match in JS (no drizzle-orm import needed
  // from apps/web; the tables + client come from @hnet/db, the seed-wanted-movie precedent).
  const allRows = await db
    .select({ id: booksItems.id, source: booksItems.source, externalId: booksItems.externalId })
    .from(booksItems);
  const idOf = (source: string, ext: string): string => {
    const row = allRows.find((r) => r.source === source && r.externalId === ext);
    if (!row) throw new Error(`seed-books-detail-history: no books_items for ${source}/${ext}`);
    return row.id;
  };
  const book = idOf('kavita', '102'); // Shakespeare's Landlord (Books wall)
  const audio = idOf('audiobookshelf', 'ab50001'); // A Christmas Carol (Audiobooks wall)
  const comic = idOf('kavita', '201'); // Amazing Spider-Man (Comics wall)

  // Write the three detail-page ids for the capture harness (argv[2] = output path), if requested.
  const idsPath = process.argv[2];
  if (idsPath) writeFileSync(idsPath, JSON.stringify({ book, audio, comic }));

  const [requester] = await db
    .insert(users)
    .values({ email: 'libby@example.test', displayName: 'Libby Reader' })
    .returning({ id: users.id });

  await db.insert(bookFixRequests).values([
    {
      requesterId: requester!.id,
      booksItemId: book,
      source: 'kavita',
      externalId: '102',
      mediaKind: 'book',
      titleSnapshot: "Shakespeare's Landlord",
      route: 'lazylibrarian',
      reason: 'bad_quality',
      status: 'completed',
      completedAt: new Date(now - 90 * MIN),
      createdAt: new Date(now - 3 * HOUR),
    },
    {
      requesterId: requester!.id,
      booksItemId: book,
      source: 'kavita',
      externalId: '102',
      mediaKind: 'book',
      titleSnapshot: "Shakespeare's Landlord",
      route: 'lazylibrarian',
      reason: 'wrong_edition',
      status: 'search_triggered',
      createdAt: new Date(now - 25 * MIN),
    },
    {
      requesterId: requester!.id,
      booksItemId: audio,
      source: 'audiobookshelf',
      externalId: 'ab50001',
      mediaKind: 'audiobook',
      titleSnapshot: 'A Christmas Carol',
      route: 'lazylibrarian',
      reason: 'corrupt_file',
      status: 'pending',
      createdAt: new Date(now - 6 * MIN),
    },
  ]);

  // A system PAIRING request anchored on the book — the "History" (request lifecycle) section.
  await db.insert(bookRequests).values({
    origin: 'pairing',
    pairingBooksItemId: book,
    title: "Shakespeare's Landlord",
    author: 'Charlaine Harris',
    ebookStatus: 'landed',
    audioStatus: 'wanted',
    createdAt: new Date(now - 5 * HOUR),
  });

  console.log('[seed-books-detail-history] seeded fixes + pairing request for book + audiobook');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[seed-books-detail-history] failed:', err);
    process.exit(1);
  });
