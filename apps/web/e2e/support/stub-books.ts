// ADR-046 / DESIGN-024 (PLAN-023) — the e2e/dev-local stub for BOTH book servers (Kavita + Audiobookshelf)
// in one HTTP server, routed by path (mirrors the *arr stubs). It answers the login exchanges, the library
// + series/item lists (with the Kavita `Pagination` total header), and the cover endpoints (a 1×1 PNG), so
// the `books-sync` mode + the /api/books/cover proxy exercise their real client → normalizer → writer path.
import { createServer, type Server } from 'node:http';

export const STUB_KAVITA_PASSWORD = 'stub-kavita-pass';
export const STUB_ABS_PASSWORD = 'stub-abs-pass';

export interface StubBooksServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** A 1×1 transparent PNG (the smallest valid cover the proxy can stream). */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

// PLAN-029 (DESIGN-026 D-01/D-04/D-08) — enough variety for the grouped-by-Author walls and the
// facet chips to demonstrate themselves hermetically: Kavita books span THREE author folders
// (Charlaine Harris ×3, Arthur Conan Doyle ×2, Various ×1) with mixed formats (epub/pdf) and page
// counts across the bucket boundaries; ABS audiobooks span three authors with narrator/series/
// language/duration variety. The books e2e + capture harnesses assert against THIS set.
// NOTE: the ABS ids are hex-shaped ('ab5000N') on purpose — the cover proxy's
// isValidBooksExternalId requires an ABS-uuid-ish id (the old 'abs-N' ids 404'd every cover).
const KAVITA_BOOKS = [
  { id: 101, name: 'The Penny Dreadfuls', sortName: 'Penny Dreadfuls', pages: 320, wordCount: 90000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Various', lowestFolderPath: '/data/EBooks/Various/The Penny Dreadfuls', coverImage: 'v1_c1.png', created: '2026-07-10T12:00:00', lastChapterAddedUtc: '2026-07-10T12:00:00' },
  { id: 102, name: "Shakespeare's Landlord", sortName: "Shakespeare's Landlord", pages: 210, wordCount: 53000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Charlaine Harris', lowestFolderPath: "/data/EBooks/Charlaine Harris/Shakespeare's Landlord", coverImage: 'v2_c2.png', created: '2026-07-09T12:00:00', lastChapterAddedUtc: '2026-07-09T12:00:00' },
  { id: 103, name: "Shakespeare's Champion", sortName: "Shakespeare's Champion", pages: 230, wordCount: 58000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Charlaine Harris', lowestFolderPath: "/data/EBooks/Charlaine Harris/Shakespeare's Champion", coverImage: 'v4_c4.png', created: '2026-07-07T12:00:00', lastChapterAddedUtc: '2026-07-07T12:00:00' },
  { id: 104, name: "Shakespeare's Christmas", sortName: "Shakespeare's Christmas", pages: 240, wordCount: 60000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Charlaine Harris', lowestFolderPath: "/data/EBooks/Charlaine Harris/Shakespeare's Christmas", coverImage: 'v5_c5.png', created: '2026-07-06T12:00:00', lastChapterAddedUtc: '2026-07-06T12:00:00' },
  { id: 105, name: 'A Study in Scarlet', sortName: 'Study in Scarlet, A', pages: 180, wordCount: 43000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Arthur Conan Doyle', lowestFolderPath: '/data/EBooks/Arthur Conan Doyle/A Study in Scarlet', coverImage: 'v6_c6.png', created: '2026-07-05T12:00:00', lastChapterAddedUtc: '2026-07-05T12:00:00' },
  { id: 106, name: 'The Sign of the Four', sortName: 'Sign of the Four, The', pages: 160, wordCount: 40000, format: 4, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Arthur Conan Doyle', lowestFolderPath: '/data/EBooks/Arthur Conan Doyle/The Sign of the Four', coverImage: 'v7_c7.png', created: '2026-07-04T12:00:00', lastChapterAddedUtc: '2026-07-04T12:00:00' },
];
const KAVITA_COMICS = [
  { id: 201, name: 'Amazing Spider-Man', sortName: 'Amazing Spider-Man', pages: 494, wordCount: 0, format: 1, libraryId: 2, libraryName: 'Comics', folderPath: '/data/Comics/Amazing Spider-Man', lowestFolderPath: '/data/Comics/Amazing Spider-Man', coverImage: 'v3_c3.png', created: '2026-07-08T12:00:00', lastChapterAddedUtc: '2026-07-08T12:00:00' },
  { id: 202, name: 'Paper Girls', sortName: 'Paper Girls', pages: 160, wordCount: 0, format: 1, libraryId: 2, libraryName: 'Comics', folderPath: '/data/Comics/Paper Girls', lowestFolderPath: '/data/Comics/Paper Girls', coverImage: 'v8_c8.png', created: '2026-07-03T12:00:00', lastChapterAddedUtc: '2026-07-03T12:00:00' },
];

// DESIGN-025 D-08 (detail-page parity) — the per-series Kavita metadata the enrichment call reads
// (`GET /api/Series/metadata?seriesId=`). Shapes mirror the live SeriesMetadataDto probed 2026-07-17:
// summary carries HTML (the sync strips it); genres/tags are {title}; publishers are {name}. Comics
// often carry sparse metadata (Spider-Man has genres, Paper Girls is empty → its About collapses).
const KAVITA_METADATA: Record<number, unknown> = {
  101: { summary: '<div><div class="blurb">A collection of Victorian serialized thrillers, cheaply printed and wildly popular.</div></div>', genres: [{ title: 'Horror' }, { title: 'Anthology' }], publishers: [{ name: 'Routledge' }], language: 'en', releaseYear: 1860 },
  102: { summary: '<div class="blurb">Lily Bard, a loner with a mysterious past, becomes the prime suspect when her landlord is murdered.</div>', genres: [{ title: 'Mystery' }, { title: 'Crime' }], publishers: [{ name: 'Penguin' }], language: 'en', releaseYear: 1996 },
  103: { summary: 'Lily Bard returns as tensions rise in the small town of Shakespeare.', genres: [{ title: 'Mystery' }], publishers: [{ name: 'Penguin' }], language: 'en', releaseYear: 1997 },
  104: { summary: 'A wedding brings old secrets to the surface in the third Lily Bard mystery.', genres: [{ title: 'Mystery' }], publishers: [{ name: 'Penguin' }], language: 'en', releaseYear: 1998 },
  105: { summary: '<p>Dr. Watson meets Sherlock Holmes, and together they investigate a baffling murder.</p>', genres: [{ title: 'Mystery' }, { title: 'Detective' }], publishers: [{ name: 'Ward Lock & Co' }], language: 'en', releaseYear: 1887 },
  106: { summary: 'Holmes and Watson take on a case of stolen treasure and a broken promise.', genres: [{ title: 'Mystery' }, { title: 'Detective' }], publishers: [{ name: 'Spencer Blackett' }], language: 'en', releaseYear: 1890 },
  201: { summary: '<div class="blurb">Peter Parker balances life as a teenager with great responsibility as the web-slinging hero.</div>', genres: [{ title: 'Superhero' }, { title: 'Action' }], publishers: [{ name: 'Marvel' }], language: 'en', releaseYear: 1963 },
  202: { summary: '', genres: [], publishers: [], language: 'en', releaseYear: 0 },
};
// DESIGN-025 D-08 (detail-page parity) — ABS enrichment (description/publisher/isbn/numAudioFiles)
// rides the list read INLINE (no extra call), so it lives right here on the items the sync pages.
const ABS_ITEMS = [
  { id: 'ab50001', libraryId: 'abs-lib', addedAt: 1783702399325, updatedAt: 1783702399325, mediaType: 'book', media: { metadata: { title: 'A Christmas Carol', titleIgnorePrefix: 'Christmas Carol, A', authorName: 'Charles Dickens', narratorName: 'Tim Curry', seriesName: '', genres: ['Audiobook', 'Classics'], publishedYear: 1843, language: 'English', description: 'A miserly old man is visited by three spirits on Christmas Eve and given a chance to change his fate.', publisher: 'Penguin Audio', isbn: '9780140620481' }, numTracks: 6, numAudioFiles: 6, numChapters: 6, duration: 12600, size: 90000000 } },
  { id: 'ab50002', libraryId: 'abs-lib', addedAt: 1783602399325, updatedAt: 1783602399325, mediaType: 'book', media: { metadata: { title: 'The Restaurant at the End of the Universe', titleIgnorePrefix: 'Restaurant at the End of the Universe, The', authorName: 'Douglas Adams', narratorName: '', seriesName: "Hitchhiker's Guide", genres: ['Audiobook', 'Science Fiction'], publishedYear: 1980, language: 'English', description: '<p>The second book in the Hitchhiker\'s Guide trilogy of five, following the galaxy\'s unlikeliest heroes.</p>', publisher: 'Pan Books', isbn: null }, numTracks: 5, numAudioFiles: 5, numChapters: 5, duration: 19822, size: 36000000 } },
  { id: 'ab50003', libraryId: 'abs-lib', addedAt: 1783502399325, updatedAt: 1783502399325, mediaType: 'book', media: { metadata: { title: 'Oliver Twist', titleIgnorePrefix: 'Oliver Twist', authorName: 'Charles Dickens', narratorName: '', seriesName: '', genres: ['Audiobook', 'Classics', 'Historical Fiction'], publishedYear: 1838, language: 'English', description: 'An orphan boy makes his way through the London underworld in Dickens\' second novel.', publisher: 'Penguin Audio', isbn: '9780141439747' }, numTracks: 12, numAudioFiles: 12, numChapters: 24, duration: 60200, size: 210000000 } },
  { id: 'ab50004', libraryId: 'abs-lib', addedAt: 1783402399325, updatedAt: 1783402399325, mediaType: 'book', media: { metadata: { title: 'The Hobbit', titleIgnorePrefix: 'Hobbit, The', authorName: 'J. R. R. Tolkien', narratorName: 'Andy Serkis', seriesName: '', genres: ['Audiobook', 'Fantasy'], publishedYear: 1937, language: 'English', description: 'Bilbo Baggins is swept into a quest to reclaim a treasure guarded by the dragon Smaug.', publisher: 'HarperCollins', isbn: '9780007487295' }, numTracks: 10, numAudioFiles: 10, numChapters: 19, duration: 37800, size: 150000000 } },
];

// ADR-066 / DESIGN-038 (PLAN-051) — the COLLECTION fixtures the `books-collections-sync` seed
// mirrors (verified wire shapes: Kavita GET /api/Collection + the all-v2 CollectionTags filter +
// POST /api/ReadingList/lists + GET /api/ReadingList/items; ABS GET /api/collections, books[]
// ordered). One of each concept:
//   • a Kavita COLLECTION (unordered) over the three Lily Bard books → the Books wall;
//   • a Kavita READING LIST (ordered, chapter-grain — series 105 repeats to prove the dedupe)
//     over the two Doyle books → the Books wall, "List order" drill;
//   • an ABS COLLECTION (ordered) over two Dickens audiobooks → the Audiobooks wall.
const KAVITA_COLLECTIONS = [{ id: 4, title: 'Lily Bard Mysteries', promoted: false, itemCount: 3 }];
const KAVITA_COLLECTION_SERIES: Record<number, number[]> = { 4: [102, 103, 104] };
const KAVITA_READING_LISTS = [
  { id: 11, title: 'Sherlock Holmes in Order', promoted: false, itemCount: 3 },
];
const KAVITA_READING_LIST_ITEMS: Record<number, Array<{ id: number; order: number; chapterId: number; seriesId: number }>> = {
  11: [
    { id: 900, order: 0, chapterId: 70, seriesId: 105 },
    { id: 901, order: 1, chapterId: 71, seriesId: 105 }, // same series again — dedupes to order 0
    { id: 902, order: 2, chapterId: 80, seriesId: 106 },
  ],
};
const ABS_COLLECTIONS = [
  {
    id: 'ab5c0001',
    libraryId: 'abs-lib',
    name: 'Dickens in Order',
    // DESIGN-043 D-09' — a Libretto-managed collection (the marker rides the description, mirror-pure).
    // The recipeId surfaces on books.collectionGroups so the Audiobooks collection drill renders the
    // "Edit collection" nav-out to /collections?tab=audiobooks&edit=dickens-in-order.
    description: '[libretto:dickens-in-order]',
    // collectionBook.order ASC — Oliver Twist deliberately BEFORE A Christmas Carol so the
    // drilled "List order" differs from every alphabetical/date sort.
    books: [ABS_ITEMS[2], ABS_ITEMS[0]],
    lastUpdate: 1783702399325,
    createdAt: 1783702399325,
  },
];

// GROUP-CARD ART pass (DESIGN-026 D-04 amendment) — the ABS AUTHOR directory + author images.
// Dickens and Tolkien carry a photo (`imagePath` non-null → the wall shows the portrait card);
// Douglas Adams does NOT (`imagePath: null` → the populated-value gate keeps his card on the
// cover fan). Mirrors the live shape verified 2026-07-13 (GET /api/libraries/{id}/authors).
const ABS_AUTHORS = [
  { id: 'aa900d1c-0000-4000-8000-000000000001', name: 'Charles Dickens', imagePath: '/metadata/authors/dickens.webp', updatedAt: 1783700000001, numBooks: 2, hue: 210 },
  { id: 'aa900d1c-0000-4000-8000-000000000002', name: 'Douglas Adams', imagePath: null, updatedAt: 1783700000002, numBooks: 1, hue: 0 },
  { id: 'aa900d1c-0000-4000-8000-000000000003', name: 'J. R. R. Tolkien', imagePath: '/metadata/authors/tolkien.webp', updatedAt: 1783700000003, numBooks: 1, hue: 95 },
];

/** A portrait-ish SVG avatar (gradient + head-and-shoulders silhouette + initials) so capture
 *  screenshots show a real image filling the card art box. Browsers render SVG in <img> fine;
 *  the proxy streams bytes + content-type as-is. (Hex here is stub data, not app CSS — the
 *  lint-css-hex guard scans stylesheets only.) */
function authorPortraitSvg(name: string, hue: number): string {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 3)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${hue},55%,18%)"/>
  </linearGradient></defs>
  <rect width="200" height="300" fill="url(#g)"/>
  <circle cx="100" cy="118" r="46" fill="hsl(${hue},30%,72%)"/>
  <path d="M28 300c6-64 34-96 72-96s66 32 72 96z" fill="hsl(${hue},30%,72%)"/>
  <text x="100" y="272" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="hsl(${hue},60%,90%)">${initials}</text>
</svg>`;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function png(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG_1x1);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startStubBooks(): Promise<StubBooksServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // --- Kavita ---
      if (path === '/api/Account/login' && method === 'POST') {
        return json(res, 200, { token: 'stub-kavita-jwt', apiKey: 'stub-kavita-apikey', username: 'hnetadmin' });
      }
      if (path === '/api/Library/libraries') {
        return json(res, 200, [
          { id: 1, name: 'Books', type: 2 },
          { id: 2, name: 'Comics', type: 1 },
        ]);
      }
      if (path === '/api/Series/all-v2' && method === 'POST') {
        const body = await readBody(req);
        let libraryId = 1;
        let collectionId: number | null = null;
        try {
          const parsed = JSON.parse(body) as { statements?: Array<{ field?: number; value?: string }> };
          const lib = parsed.statements?.find((s) => s.field === 19);
          if (lib?.value) libraryId = Number(lib.value);
          // ADR-066 / DESIGN-038 D-02 — the CollectionTags filter (field 7, the collection drill).
          const col = parsed.statements?.find((s) => s.field === 7);
          if (col?.value) collectionId = Number(col.value);
        } catch {
          /* default lib 1 */
        }
        const all = [...KAVITA_BOOKS, ...KAVITA_COMICS];
        const items =
          collectionId !== null
            ? all.filter((s) => (KAVITA_COLLECTION_SERIES[collectionId!] ?? []).includes(s.id))
            : libraryId === 2
              ? KAVITA_COMICS
              : KAVITA_BOOKS;
        return json(res, 200, items, {
          Pagination: JSON.stringify({ currentPage: 1, itemsPerPage: 500, totalItems: items.length, totalPages: 1 }),
        });
      }
      // ADR-066 / DESIGN-038 D-02 (PLAN-051) — the collection reads the books-collections-sync
      // seed mirrors (route shapes verified against Kavita v0.9.0.2: GET /api/Collection;
      // POST-with-query-pagination /api/ReadingList/lists; GET /api/ReadingList/items).
      if (path === '/api/Collection') return json(res, 200, KAVITA_COLLECTIONS);
      if (path === '/api/ReadingList/lists' && method === 'POST') {
        return json(res, 200, KAVITA_READING_LISTS, {
          Pagination: JSON.stringify({
            currentPage: 1,
            itemsPerPage: 100,
            totalItems: KAVITA_READING_LISTS.length,
            totalPages: 1,
          }),
        });
      }
      if (path === '/api/ReadingList/items') {
        const listId = Number(url.searchParams.get('readingListId') ?? '0');
        return json(res, 200, KAVITA_READING_LIST_ITEMS[listId] ?? []);
      }
      // DESIGN-025 D-08 (detail-page parity) — the per-series metadata enrichment call. An unknown
      // series returns the honest empty shape (all-absent → its About collapses).
      if (path === '/api/Series/metadata') {
        const seriesId = Number(url.searchParams.get('seriesId') ?? '0');
        return json(
          res,
          200,
          KAVITA_METADATA[seriesId] ?? { summary: '', genres: [], publishers: [], language: null, releaseYear: 0 },
        );
      }
      if (path === '/api/Image/series-cover') return png(res);

      // --- Audiobookshelf ---
      if (path === '/login' && method === 'POST') {
        return json(res, 200, { user: { token: 'stub-abs-token', username: 'root' }, userDefaultLibraryId: 'abs-lib' });
      }
      if (path === '/api/libraries') {
        return json(res, 200, { libraries: [{ id: 'abs-lib', name: 'Audio Books', mediaType: 'book' }] });
      }
      // ADR-066 / DESIGN-038 D-02 (PLAN-051) — the ORDERED ABS collections (books[] IS the order).
      if (path === '/api/collections') return json(res, 200, { collections: ABS_COLLECTIONS });
      if (path.startsWith('/api/libraries/') && path.endsWith('/items')) {
        const page = Number(url.searchParams.get('page') ?? '0');
        return json(res, 200, { results: page === 0 ? ABS_ITEMS : [], total: ABS_ITEMS.length, page });
      }
      if (path.startsWith('/api/libraries/') && path.endsWith('/authors')) {
        return json(res, 200, {
          authors: ABS_AUTHORS.map((a) => ({
            id: a.id,
            name: a.name,
            imagePath: a.imagePath,
            updatedAt: a.updatedAt,
            numBooks: a.numBooks,
          })),
        });
      }
      if (path.startsWith('/api/authors/') && path.endsWith('/image')) {
        const authorId = path.slice('/api/authors/'.length, -'/image'.length);
        const author = ABS_AUTHORS.find((a) => a.id === authorId);
        if (!author || author.imagePath === null) {
          return json(res, 404, { message: 'author has no image' });
        }
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        return res.end(authorPortraitSvg(author.name, author.hue));
      }
      if (path.startsWith('/api/items/') && path.endsWith('/cover')) return png(res);

      return json(res, 404, { message: `stub-books: no handler for ${method} ${path}` });
    })().catch((err: unknown) => json(res, 500, { message: `stub-books error: ${String(err)}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-books failed to bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
