// ADR-055 / DESIGN-028 (PLAN-044) — the read-only Goodreads shelf-RSS client. A Goodreads shelf RSS lives
// at `{base}/review/list_rss/{userId}?shelf={shelf}` (PUBLIC — the shelf must be public; no OAuth, no key;
// the durable path since the Goodreads API was retired 2020 — see the books-list-sources research §0/§1).
// Each <item> carries flat, non-namespaced custom tags (book_id, author_name, isbn, book_image_url,
// user_date_added). The parser tolerates the feed's sparseness (any field may be missing/blank) and
// CDATA-wrapped text (titles/descriptions). feedparser semantics, hand-rolled to avoid an XML dependency.
import { GoodreadsHttpError } from './errors';
import { getText, type GetOptions } from './http';

/** One book read off a shelf RSS <item>. Fields the feed omits come back null (sparseness-tolerant). */
export interface GoodreadsShelfItem {
  /** The Goodreads book id (<book_id>) — the stable per-item key. */
  externalBookId: string;
  title: string;
  author: string | null;
  /** ISBN13 preferred, else ISBN10 (<isbn13>/<isbn>). Blank feed values → null. */
  isbn: string | null;
  /** The <book_image_url> — an external Goodreads CDN cover (fallback art). */
  coverUrl: string | null;
  /** When the user shelved it (<user_date_added>/<pubDate>). Null when unparseable. */
  shelvedAt: Date | null;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** Read one tag's text out of an <item> block, unwrapping CDATA and decoding entities. */
function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  let inner = (m[1] ?? '').trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  if (cdata) inner = (cdata[1] ?? '').trim();
  else inner = decodeEntities(inner);
  return inner.length > 0 ? inner : null;
}

const toDate = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Parse a Goodreads shelf RSS document into items. Exported for unit tests (fixture feeds incl. sparse
 * entries). Items without a <book_id> are skipped (nothing to key on).
 */
export function parseShelfRss(xml: string): GoodreadsShelfItem[] {
  const items: GoodreadsShelfItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? '';
    const externalBookId = tag(block, 'book_id') ?? tag(block, 'guid');
    if (!externalBookId) continue;
    const isbn13 = tag(block, 'isbn13');
    const isbn = isbn13 && isbn13 !== 'nan' ? isbn13 : normalizeIsbn(tag(block, 'isbn'));
    items.push({
      externalBookId,
      title: tag(block, 'title') ?? '(untitled)',
      author: tag(block, 'author_name'),
      isbn,
      coverUrl: tag(block, 'book_large_image_url') ?? tag(block, 'book_image_url'),
      shelvedAt: toDate(tag(block, 'user_date_added') ?? tag(block, 'pubDate')),
    });
  }
  return items;
}

/** Goodreads writes 'nan' / blank for missing ISBNs — normalize those to null. */
function normalizeIsbn(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 && t.toLowerCase() !== 'nan' ? t : null;
}

/**
 * Extract the numeric Goodreads user id from a reference WITHOUT a network call. Handles a bare id, a
 * `/user/show/12345-name` URL, or a `/review/list[_rss]/12345` URL. Returns null for a VANITY URL
 * (`.../haynesnetwork`) — those are resolved by following the redirect (resolveUserId).
 */
export function parseGoodreadsIdFromRef(ref: string): string | null {
  const t = (ref ?? '').trim();
  if (/^\d{1,20}$/.test(t)) return t;
  const m = /goodreads\.com\/(?:user\/show|review\/list(?:_rss)?)\/(\d{1,20})/i.exec(t);
  return m?.[1] ?? null;
}

/**
 * The three BUILT-IN Goodreads exclusive shelves — they exist on every account (even empty), so a fetch
 * failure on one of them means "private / unreachable / transient", never "the shelf does not exist".
 */
export const GOODREADS_BUILTIN_SHELVES = ['to-read', 'currently-reading', 'read'] as const;

/**
 * ADR-057 / PLAN-045 A3 — is this fetch failure "a CUSTOM shelf that simply doesn't exist"? Goodreads
 * 404s the shelf RSS for a slug the account never created (e.g. 'did-not-finish', which is a conventional
 * custom shelf, not a built-in). The sync treats that as an EMPTY shelf (zero items, still synced), NOT an
 * integration error. A built-in shelf is never "absent" — a 404 there means the profile went private /
 * unreachable, which must surface as the integration error it is (and must NOT tombstone the mirror).
 */
export function isAbsentCustomShelfError(shelf: string, error: unknown): boolean {
  if ((GOODREADS_BUILTIN_SHELVES as readonly string[]).includes(shelf)) return false;
  return error instanceof GoodreadsHttpError && error.status === 404;
}

export interface GoodreadsRssClientOptions extends GetOptions {
  baseUrl: string;
}

export class GoodreadsRssClient {
  private readonly baseUrl: string;
  private readonly opts: GetOptions;

  constructor(options: GoodreadsRssClientOptions) {
    const { baseUrl, ...rest } = options;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.opts = rest;
  }

  /** The public shelf RSS URL for a (userId, shelf). */
  shelfUrl(userId: string, shelf: string): string {
    return `${this.baseUrl}/review/list_rss/${encodeURIComponent(userId)}?shelf=${encodeURIComponent(shelf)}`;
  }

  /**
   * Resolve a profile reference (a numeric id, a `/user/show/…` URL, OR a VANITY url like
   * `https://www.goodreads.com/haynesnetwork`) to the numeric Goodreads user id. A vanity URL is resolved
   * server-side by following its redirect (Goodreads 30x-redirects `/haynesnetwork` → `/user/show/202652880-…`)
   * and reading the id out of the redirect target. Throws GoodreadsHttpError if nothing yields an id.
   */
  async resolveUserId(ref: string): Promise<string> {
    const direct = parseGoodreadsIdFromRef(ref);
    if (direct) return direct;
    const start = /^https?:\/\//i.test(ref.trim())
      ? ref.trim()
      : `${this.baseUrl}/${ref.trim().replace(/^\/+/, '')}`;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let url = start;
    for (let hop = 0; hop < 5; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'text/html,*/*' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        url = new URL(loc, url).toString();
        const id = parseGoodreadsIdFromRef(url);
        if (id) return id;
        continue;
      }
      const id = parseGoodreadsIdFromRef(res.url && res.url.length > 0 ? res.url : url);
      if (id) return id;
      break;
    }
    throw new GoodreadsHttpError(0, start, 'could not resolve a Goodreads user id');
  }

  /** Fetch + parse one shelf. A non-2xx / network failure throws (the caller records status 'error'). */
  async fetchShelf(userId: string, shelf: string): Promise<GoodreadsShelfItem[]> {
    const xml = await getText(this.shelfUrl(userId, shelf), {
      ...this.opts,
      accept: 'application/rss+xml, text/xml, application/xml, */*',
    });
    return parseShelfRss(xml);
  }
}

export function goodreadsRssClient(options: GoodreadsRssClientOptions): GoodreadsRssClient {
  return new GoodreadsRssClient(options);
}
