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

const KAVITA_BOOKS = [
  { id: 101, name: 'The Penny Dreadfuls', sortName: 'Penny Dreadfuls', pages: 320, wordCount: 90000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Various', lowestFolderPath: '/data/EBooks/Various/The Penny Dreadfuls', coverImage: 'v1_c1.png', created: '2026-07-10T12:00:00', lastChapterAddedUtc: '2026-07-10T12:00:00' },
  { id: 102, name: "Shakespeare's Landlord", sortName: "Shakespeare's Landlord", pages: 210, wordCount: 53000, format: 3, libraryId: 1, libraryName: 'Books', folderPath: '/data/EBooks/Charlaine Harris', lowestFolderPath: "/data/EBooks/Charlaine Harris/Shakespeare's Landlord", coverImage: 'v2_c2.png', created: '2026-07-09T12:00:00', lastChapterAddedUtc: '2026-07-09T12:00:00' },
];
const KAVITA_COMICS = [
  { id: 201, name: 'Amazing Spider-Man', sortName: 'Amazing Spider-Man', pages: 494, wordCount: 0, format: 1, libraryId: 2, libraryName: 'Comics', folderPath: '/data/Comics/Amazing Spider-Man', lowestFolderPath: '/data/Comics/Amazing Spider-Man', coverImage: 'v3_c3.png', created: '2026-07-08T12:00:00', lastChapterAddedUtc: '2026-07-08T12:00:00' },
];
const ABS_ITEMS = [
  { id: 'abs-1', libraryId: 'abs-lib', addedAt: 1783702399325, updatedAt: 1783702399325, mediaType: 'book', media: { metadata: { title: 'A Christmas Carol', titleIgnorePrefix: 'Christmas Carol, A', authorName: 'Charles Dickens', narratorName: 'Tim Curry', seriesName: '', genres: ['Audiobook', 'Classics'], publishedYear: 1843, language: 'English' }, numTracks: 6, numChapters: 6, duration: 12600, size: 90000000 } },
  { id: 'abs-2', libraryId: 'abs-lib', addedAt: 1783602399325, updatedAt: 1783602399325, mediaType: 'book', media: { metadata: { title: 'The Restaurant at the End of the Universe', titleIgnorePrefix: 'Restaurant at the End of the Universe, The', authorName: 'Douglas Adams', narratorName: '', seriesName: "Hitchhiker's Guide", genres: ['Audiobook'], publishedYear: 1980, language: 'English' }, numTracks: 5, numChapters: 5, duration: 19822, size: 36000000 } },
];

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
        try {
          const parsed = JSON.parse(body) as { statements?: Array<{ field?: number; value?: string }> };
          const stmt = parsed.statements?.find((s) => s.field === 19);
          if (stmt?.value) libraryId = Number(stmt.value);
        } catch {
          /* default lib 1 */
        }
        const items = libraryId === 2 ? KAVITA_COMICS : KAVITA_BOOKS;
        return json(res, 200, items, {
          Pagination: JSON.stringify({ currentPage: 1, itemsPerPage: 500, totalItems: items.length, totalPages: 1 }),
        });
      }
      if (path === '/api/Image/series-cover') return png(res);

      // --- Audiobookshelf ---
      if (path === '/login' && method === 'POST') {
        return json(res, 200, { user: { token: 'stub-abs-token', username: 'root' }, userDefaultLibraryId: 'abs-lib' });
      }
      if (path === '/api/libraries') {
        return json(res, 200, { libraries: [{ id: 'abs-lib', name: 'Audio Books', mediaType: 'book' }] });
      }
      if (path.startsWith('/api/libraries/') && path.endsWith('/items')) {
        const page = Number(url.searchParams.get('page') ?? '0');
        return json(res, 200, { results: page === 0 ? ABS_ITEMS : [], total: ABS_ITEMS.length, page });
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
