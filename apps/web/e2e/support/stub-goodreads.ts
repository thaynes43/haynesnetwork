// ADR-055 / DESIGN-028 (PLAN-044) — the hermetic Goodreads stub: serves the VANITY-URL redirect
// (`/haynesnetwork` → `/user/show/202652880-…`, mirroring the owner's real account), the public
// want-shelf RSS, AND the Google Books volumes endpoint (one server, path-routed). The `goodreads-sync`
// mode + the `integrations.link` probe hit it; no secret. Canned data is inline (the codebase idiom — no
// fixture files).
import { createServer, type Server, type ServerResponse } from 'node:http';

/** The stub Goodreads user id (matches the owner's real vanity resolution 202652880). */
export const STUB_GOODREADS_USER_ID = '202652880';
/** A throwaway Google Books key so the enrichment path runs (the stub never checks it). */
export const STUB_GOOGLE_BOOKS_API_KEY = 'stub-gb-key';

export interface StubGoodreadsServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

// ADR-057 (PLAN-045 — all shelves acquire): the stub now serves PER-SHELF RSS keyed off the `?shelf=`
// param. The want shelf mirrors the owner's real v0.49.0 acceptance shelf: a novel that LL LANDS (→
// covered), a novel LL can't find (→ Missing + Search-again), and BOTH of his comics — Scott Pilgrim
// (GB miscategorises the ISBN edition; the /volumes GET carries the real comic BISAC) and Batman "Zero
// Year" (a category-less GB volume; the "DC Comics" title is the only signal). Both must PARK out of LL.
// currently-reading + read carry the A1-OVERRULED acquisition proof (a READ-shelf unmet want must
// mint + push), and 'did-not-finish' 404s — the conventional ABSENT custom shelf (A3 tolerance).
function rssItem(o: { title: string; bookId: string; author: string; isbn?: [string, string]; date: string }): string {
  return `  <item>
    <title><![CDATA[${o.title}]]></title>
    <book_id>${o.bookId}</book_id>
    <author_name><![CDATA[${o.author}]]></author_name>
    <isbn>${o.isbn?.[0] ?? ''}</isbn>
    <isbn13>${o.isbn?.[1] ?? ''}</isbn13>
    <user_date_added><![CDATA[${o.date}]]></user_date_added>
  </item>`;
}

function shelfRss(shelf: string, items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title><![CDATA[manofoz's bookshelf: ${shelf}]]></title>
${items.join('\n')}
</channel></rss>`;
}

const SHELVES: Record<string, string> = {
  'to-read': shelfRss('to-read', [
    rssItem({ title: 'Ready Player One', bookId: '9969571', author: 'Ernest Cline', isbn: ['0307887436', '9780307887436'], date: 'Mon, 13 Jul 2026 10:00:00 -0700' }),
    rssItem({ title: 'Throne of Glass', bookId: '7896527', author: 'Sarah J. Maas', isbn: ['1619630346', '9781619630345'], date: 'Mon, 13 Jul 2026 09:00:00 -0700' }),
    rssItem({ title: "Scott Pilgrim's Precious Little Life (Scott Pilgrim, #1)", bookId: '9312', author: "Bryan Lee O'Malley", isbn: ['1932664084', '9781932664089'], date: 'Mon, 13 Jul 2026 08:00:00 -0700' }),
    rssItem({ title: 'Zero Year: Part 1 (DC Comics - The Legend of Batman #1)', bookId: '18510', author: 'Scott Snyder', date: 'Mon, 13 Jul 2026 07:00:00 -0700' }),
  ]),
  'currently-reading': shelfRss('currently-reading', [
    rssItem({ title: 'Project Hail Mary', bookId: '54493401', author: 'Andy Weir', date: 'Sun, 12 Jul 2026 10:00:00 -0700' }),
  ]),
  read: shelfRss('read', [
    // Covered: LL already holds it (stub-ll gb-martian → Open/Open → landed).
    rssItem({ title: 'The Martian', bookId: '18007564', author: 'Andy Weir', date: 'Sat, 11 Jul 2026 10:00:00 -0700' }),
    // THE acquisition proof: a READ-shelf want we don't hold — must mint + push (LL Wanted).
    rssItem({ title: 'Hyperion', bookId: '77566', author: 'Dan Simmons', date: 'Fri, 10 Jul 2026 10:00:00 -0700' }),
  ]),
  // 'did-not-finish' deliberately ABSENT → the handler 404s it (the A3 tolerance path).
};

/**
 * A Google Books SEARCH result (`/volumes?q=`) for a query. Faithful to the live quirk that motivated the
 * classifier fix: the search endpoint TRUNCATES `categories`, so Scott Pilgrim comes back as ["Fiction"]
 * (the /volumes GET below carries its true comic BISAC), and Batman's sparse volume has NO categories at
 * all (only the "DC Comics" title marker classifies it).
 */
function gbVolumeFor(q: string): { id: string; volumeInfo: Record<string, unknown> } | null {
  const s = q.toLowerCase();
  if (s.includes('9780307887436') || s.includes('ready')) {
    return { id: 'gb-rpo', volumeInfo: { title: 'Ready Player One', categories: ['Fiction'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780307887436' }] } };
  }
  if (s.includes('9781619630345') || s.includes('throne')) {
    return { id: 'gb-tog', volumeInfo: { title: 'Throne of Glass', categories: ['Young Adult Fiction'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781619630345' }] } };
  }
  if (s.includes('9781932664089') || s.includes('scott') || s.includes('pilgrim')) {
    // TRUNCATED search category — not a comic on its face; the confirm GET recovers the truth.
    return { id: 'gb-scottpilgrim', volumeInfo: { title: 'Scott Pilgrim', categories: ['Fiction'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781932664089' }] } };
  }
  if (s.includes('zero year') || s.includes('batman')) {
    // A sparse catalog volume — NO categories; only the shelved "DC Comics" title marker classifies it.
    return { id: 'gb-batman', volumeInfo: { title: 'Zero Year', publisher: 'Eaglemoss Collections' } };
  }
  // ADR-057 (PLAN-045) — the currently-reading / read shelf novels.
  if (s.includes('hail mary')) {
    return { id: 'gb-phm', volumeInfo: { title: 'Project Hail Mary', categories: ['Fiction'] } };
  }
  if (s.includes('martian')) {
    return { id: 'gb-martian', volumeInfo: { title: 'The Martian', categories: ['Fiction'] } };
  }
  if (s.includes('hyperion')) {
    return { id: 'gb-hyp', volumeInfo: { title: 'Hyperion', categories: ['Fiction'] } };
  }
  return null;
}

/** The FULL `/volumes/{id}` record (the untruncated BISAC list). Scott Pilgrim's carries the comic tag. */
function gbVolumeById(id: string): { id: string; volumeInfo: Record<string, unknown> } | null {
  if (id === 'gb-scottpilgrim') {
    return {
      id,
      volumeInfo: {
        title: 'Scott Pilgrim’s Precious Little Life: Volume 1',
        publisher: 'HarperCollins UK',
        categories: ['Fiction / Humorous / General', 'Comics & Graphic Novels / Literary'],
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781932664089' }],
      },
    };
  }
  return gbVolumeFor(id) ?? { id, volumeInfo: {} };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startStubGoodreads(): Promise<StubGoodreadsServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // Vanity URL → redirect to the numeric-id profile (the resolveUserId path).
    if (path === `/${'haynesnetwork'}` || path === '/haynesnetwork') {
      res.writeHead(302, { location: `/user/show/${STUB_GOODREADS_USER_ID}-manofoz` });
      res.end();
      return;
    }
    // The resolved profile page (in case a redirect is followed rather than read from Location).
    if (path.startsWith('/user/show/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>manofoz</body></html>');
      return;
    }
    // The public shelf RSS — per-shelf; an unknown shelf 404s (Goodreads' absent-custom-shelf shape).
    if (path.startsWith('/review/list_rss/')) {
      const shelf = url.searchParams.get('shelf') ?? 'to-read';
      const rss = SHELVES[shelf];
      if (rss === undefined) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body>shelf not found</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(rss);
      return;
    }
    // Google Books single-volume GET (the classifier's full-category confirm step) — must precede the
    // search handler below (this path is more specific).
    if (path.startsWith('/books/v1/volumes/')) {
      const id = decodeURIComponent(path.slice('/books/v1/volumes/'.length));
      const vol = gbVolumeById(id);
      if (vol) json(res, 200, vol);
      else json(res, 404, { error: { code: 404, message: 'volume not found' } });
      return;
    }
    // Google Books search.
    if (path === '/books/v1/volumes') {
      const q = url.searchParams.get('q') ?? '';
      const vol = gbVolumeFor(q);
      json(res, 200, vol ? { totalItems: 1, items: [vol] } : { totalItems: 0, items: [] });
      return;
    }
    json(res, 404, { message: `stub-goodreads: no handler for ${req.method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-goodreads: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
