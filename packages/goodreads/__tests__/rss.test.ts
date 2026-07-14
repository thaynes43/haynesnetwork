import { describe, expect, it, vi } from 'vitest';
import {
  GOODREADS_BUILTIN_SHELVES,
  GoodreadsHttpError,
  GoodreadsRssClient,
  isAbsentCustomShelfError,
  parseGoodreadsIdFromRef,
  parseShelfRss,
} from '../src/index';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title><![CDATA[manofoz's bookshelf: to-read]]></title>
  <item>
    <title><![CDATA[Ready Player One]]></title>
    <book_id>9969571</book_id>
    <author_name><![CDATA[Ernest Cline]]></author_name>
    <isbn>0307887436</isbn>
    <isbn13>9780307887436</isbn13>
    <book_image_url><![CDATA[https://images.example/rpo.jpg]]></book_image_url>
    <user_date_added><![CDATA[Sun, 13 Jul 2026 10:00:00 -0700]]></user_date_added>
  </item>
  <item>
    <title>Scott Pilgrim, Vol. 1</title>
    <book_id>9312</book_id>
    <author_name>Bryan Lee O'Malley &amp; friends</author_name>
    <isbn>nan</isbn>
    <isbn13>nan</isbn13>
  </item>
  <item>
    <title>No Id Here</title>
    <author_name>Nobody</author_name>
  </item>
</channel></rss>`;

describe('parseShelfRss', () => {
  it('parses items, CDATA, entities, ISBN preference, and skips id-less items', () => {
    const items = parseShelfRss(FEED);
    expect(items).toHaveLength(2); // the id-less item is skipped
    const rpo = items[0]!;
    expect(rpo.externalBookId).toBe('9969571');
    expect(rpo.title).toBe('Ready Player One');
    expect(rpo.author).toBe('Ernest Cline');
    expect(rpo.isbn).toBe('9780307887436'); // isbn13 preferred
    expect(rpo.coverUrl).toBe('https://images.example/rpo.jpg');
    expect(rpo.shelvedAt).toBeInstanceOf(Date);
    const sp = items[1]!;
    expect(sp.author).toBe("Bryan Lee O'Malley & friends"); // entity decoded
    expect(sp.isbn).toBeNull(); // 'nan' normalized to null
  });
});

describe('parseGoodreadsIdFromRef', () => {
  it('extracts ids and returns null for a vanity url', () => {
    expect(parseGoodreadsIdFromRef('202652880')).toBe('202652880');
    expect(parseGoodreadsIdFromRef('https://www.goodreads.com/user/show/202652880-manofoz')).toBe('202652880');
    expect(parseGoodreadsIdFromRef('https://www.goodreads.com/haynesnetwork')).toBeNull();
  });
});

describe('GoodreadsRssClient.resolveUserId', () => {
  it('resolves a vanity URL by following the redirect to /user/show/<id>', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: '/user/show/202652880-manofoz' },
      }),
    ) as unknown as typeof fetch;
    const client = new GoodreadsRssClient({ baseUrl: 'https://www.goodreads.com', fetchImpl });
    expect(await client.resolveUserId('https://www.goodreads.com/haynesnetwork')).toBe('202652880');
    // A bare id needs no network call.
    const fetchImpl2 = vi.fn() as unknown as typeof fetch;
    const client2 = new GoodreadsRssClient({ baseUrl: 'https://www.goodreads.com', fetchImpl: fetchImpl2 });
    expect(await client2.resolveUserId('202652880')).toBe('202652880');
    expect(fetchImpl2).not.toHaveBeenCalled();
  });

  it('fetches + parses a shelf', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    ) as unknown as typeof fetch;
    const client = new GoodreadsRssClient({ baseUrl: 'https://www.goodreads.com', fetchImpl });
    const items = await client.fetchShelf('202652880', 'to-read');
    expect(items).toHaveLength(2);
  });
});

// ADR-057 / PLAN-045 A3 — absent-CUSTOM-shelf tolerance ('did-not-finish' usually doesn't exist).
describe('isAbsentCustomShelfError', () => {
  it('tolerates a 404 ONLY for a custom shelf — never for a built-in (that means private/unreachable)', () => {
    const notFound = new GoodreadsHttpError(404, 'http://gr/review/list_rss/1?shelf=did-not-finish');
    expect(isAbsentCustomShelfError('did-not-finish', notFound)).toBe(true);
    expect(isAbsentCustomShelfError('some-custom-shelf', notFound)).toBe(true);
    for (const builtin of GOODREADS_BUILTIN_SHELVES) {
      expect(isAbsentCustomShelfError(builtin, notFound)).toBe(false);
    }
  });

  it('never tolerates a non-404 / non-HTTP failure (transient errors must surface)', () => {
    expect(isAbsentCustomShelfError('did-not-finish', new GoodreadsHttpError(503, 'http://gr'))).toBe(false);
    expect(isAbsentCustomShelfError('did-not-finish', new Error('boom'))).toBe(false);
  });
});
