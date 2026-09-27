// ADR-093 / DESIGN-052 D-02 (PLAN-072 S2) — Seerr watchlist reads CLASSIFIED BY CONTENT (Seerr 3.4.1 answers a
// failed plex.tv read as HTTP 200 with an empty list, on any page). Fully offline: a consistent multi-page read; a
// short page from dropped items (still ok); 200-empty (repeated once, then empty); a page 2 answering the error body
// (`totalPages: 0`); a later page with other totals; an empty page before the last; a page repeating an earlier
// page's ratingKey (read again once, then failed); a duplicate inside one page (kept once); a non-hex ratingKey and a
// bad mediaType (failed); the user roster; and the D-02 retry policy on 429/5xx.
import { describe, expect, it } from 'vitest';
import { SeerrClient, readSeerrUserWatchlist } from '../src/read';
import type { SeerrWatchlistPage } from '../src/schemas/seerr';
import { registryRetryStatus } from '../src/http';

const A = '5d776824151a60001f24a29e';
const B = '608ae6cf5077dd002d3bb8be';
const C = '5f40b53f3ad4a8003ec80fc9';
const D = '5e161c7de9d5a1004086a1f5';

const item = (ratingKey: string, mediaType = 'movie', tmdbId: number | null = 1) => ({
  id: 1,
  ratingKey,
  title: 'x',
  mediaType,
  tmdbId,
});
const pageOf = (
  page: number,
  totalPages: number,
  totalResults: number,
  results: unknown[],
): SeerrWatchlistPage => ({ page, totalPages, totalResults, results }) as SeerrWatchlistPage;
const ERROR_BODY = (page: number) => pageOf(page, 0, 0, []);

/** A scripted reader: each full pass answers from `passes[n]` (page → body | Error). */
function scripted(passes: Array<Record<number, SeerrWatchlistPage | Error>>) {
  let pass = -1;
  const reads: Array<[number, number]> = [];
  const readPage = async (page: number) => {
    if (page === 1) pass += 1;
    reads.push([pass, page]);
    const body = passes[Math.min(pass, passes.length - 1)]![page];
    if (body === undefined) throw new Error(`no page ${page} in pass ${pass}`);
    if (body instanceof Error) throw body;
    return body;
  };
  return { readPage, reads };
}
const noSleep = { sleep: async () => {} };

describe('readSeerrUserWatchlist (D-02 content rules)', () => {
  it('a consistent multi-page read is ok, pages read in order', async () => {
    const s = scripted([
      { 1: pageOf(1, 2, 3, [item(A), item(B, 'tv', 7)]), 2: pageOf(2, 2, 3, [item(C)]) },
    ]);
    const answer = await readSeerrUserWatchlist(s.readPage, noSleep);
    expect(answer).toEqual({
      kind: 'ok',
      totalResults: 3,
      items: [
        { discoverId: A, kind: 'movie', tmdbId: 1 },
        { discoverId: B, kind: 'show', tmdbId: 7 },
        { discoverId: C, kind: 'movie', tmdbId: 1 },
      ],
    });
    expect(s.reads).toEqual([
      [0, 1],
      [0, 2],
    ]);
  });

  it('a short page from dropped items is still ok (results are never summed against totalResults)', async () => {
    const s = scripted([{ 1: pageOf(1, 2, 40, [item(A)]), 2: pageOf(2, 2, 40, [item(B)]) }]);
    await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('200-empty is repeated once after 2 s, then classed empty', async () => {
    const slept: number[] = [];
    const s = scripted([{ 1: ERROR_BODY(1) }, { 1: ERROR_BODY(1) }]);
    const answer = await readSeerrUserWatchlist(s.readPage, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(answer).toEqual({ kind: 'empty' });
    expect(slept).toEqual([2000]);
    expect(s.reads).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it('an empty first read that answers on the repeat is ok', async () => {
    const s = scripted([{ 1: ERROR_BODY(1) }, { 1: pageOf(1, 1, 1, [item(A)]) }]);
    await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('page 2 answering the error body (totalPages 0) is inconsistent; twice ⇒ failed', async () => {
    const pass = { 1: pageOf(1, 2, 25, [item(A)]), 2: ERROR_BODY(2) };
    const s = scripted([pass, pass]);
    await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'inconsistent',
    });
    expect(s.reads).toHaveLength(4);
  });

  it('an inconsistent read that is consistent on the repeat is ok', async () => {
    const s = scripted([
      { 1: pageOf(1, 2, 25, [item(A)]), 2: ERROR_BODY(2) },
      { 1: pageOf(1, 2, 25, [item(A)]), 2: pageOf(2, 2, 25, [item(B)]) },
    ]);
    await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('a later page with other totals, an empty page before the last, a repeated ratingKey: failed after the repeat', async () => {
    const otherTotals = { 1: pageOf(1, 2, 25, [item(A)]), 2: pageOf(2, 3, 26, [item(B)]) };
    const emptyMiddle = {
      1: pageOf(1, 3, 45, [item(A)]),
      2: pageOf(2, 3, 45, []),
      3: pageOf(3, 3, 45, [item(C)]),
    };
    const repeated = { 1: pageOf(1, 2, 25, [item(A), item(B)]), 2: pageOf(2, 2, 25, [item(B)]) };
    for (const pass of [otherTotals, emptyMiddle, repeated]) {
      const s = scripted([pass, pass]);
      await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toEqual({
        kind: 'failed',
        errorClass: 'inconsistent',
      });
    }
  });

  it('a duplicate inside ONE page is kept once and never aborts', async () => {
    const s = scripted([{ 1: pageOf(1, 1, 2, [item(A), item(A)]) }]);
    await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toEqual({
      kind: 'ok',
      totalResults: 2,
      items: [{ discoverId: A, kind: 'movie', tmdbId: 1 }],
    });
  });

  it('a non-hex ratingKey or a mediaType other than movie/tv fails the read', async () => {
    for (const [bad, errorClass] of [
      [item('12345'), 'bad_rating_key'],
      [item(D, 'person'), 'bad_media_type'],
    ] as const) {
      const s = scripted([{ 1: pageOf(1, 1, 1, [bad]) }]);
      await expect(readSeerrUserWatchlist(s.readPage, noSleep)).resolves.toEqual({
        kind: 'failed',
        errorClass,
      });
    }
  });

  it('an HTTP failure is failed with its class', async () => {
    const client = new SeerrClient({
      baseUrl: 'http://seerr.test',
      apiKey: 'k',
      retryDelayMs: 0,
      fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    });
    await expect(client.readUserWatchlist(3, noSleep)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'http_401',
    });
  });
});

describe('SeerrClient registry reads', () => {
  it('lists users (take=100 pages) with plexId as a string and the user type', async () => {
    const calls: string[] = [];
    const client = new SeerrClient({
      baseUrl: 'http://seerr.test',
      apiKey: 'k',
      fetchImpl: (async (input: unknown) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        return new Response(
          JSON.stringify({
            pageInfo: { pages: 1, pageSize: 100, results: 2, page: 1 },
            results: [
              { id: 1, plexId: 12874060, userType: 1, email: 'owner@example.test' },
              { id: 5, plexId: null, userType: 2 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const users = await client.listUsers();
    expect(users).toEqual([
      { id: 1, plexId: '12874060', userType: 1 },
      { id: 5, plexId: null, userType: 2 },
    ]);
    expect(JSON.stringify(users)).not.toContain('example.test');
    expect(calls).toEqual(['/api/v1/user?take=100&skip=0']);
  });

  it('reads every page by its `page` query (a consistent two-page list), and fails a page 2 answering the error body', async () => {
    const serve = (page2: (page: number) => SeerrWatchlistPage) => {
      const pages: number[] = [];
      const client = new SeerrClient({
        baseUrl: 'http://seerr.test',
        apiKey: 'k',
        fetchImpl: (async (input: unknown) => {
          const url = new URL(String(input));
          expect(url.pathname).toBe('/api/v1/user/7/watchlist');
          const page = Number(url.searchParams.get('page'));
          pages.push(page);
          const body = page === 1 ? pageOf(1, 2, 3, [item(A), item(B, 'tv')]) : page2(page);
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      });
      return { client, pages };
    };
    const ok = serve((page) => pageOf(page, 2, 3, [item(C)]));
    await expect(ok.client.readUserWatchlist(7, noSleep)).resolves.toEqual({
      kind: 'ok',
      totalResults: 3,
      items: [
        { discoverId: A, kind: 'movie', tmdbId: 1 },
        { discoverId: B, kind: 'show', tmdbId: 1 },
        { discoverId: C, kind: 'movie', tmdbId: 1 },
      ],
    });
    expect(ok.pages).toEqual([1, 2]);
    // Seerr's failed plex.tv read, on page 2: 200 {totalPages: 0, totalResults: 0, results: []} — twice ⇒ failed.
    const broken = serve((page) => ERROR_BODY(page));
    await expect(broken.client.readUserWatchlist(7, noSleep)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'inconsistent',
    });
    expect(broken.pages).toEqual([1, 2, 1, 2]);
  });

  it('reads /user/{id}/watchlist?page= and retries 429/5xx under the registry policy', async () => {
    let n = 0;
    const client = new SeerrClient({
      baseUrl: 'http://seerr.test',
      apiKey: 'k',
      retryStatus: registryRetryStatus,
      retryBackoffMs: () => 0,
      fetchImpl: (async (input: unknown) => {
        n += 1;
        if (n === 1) return new Response('{}', { status: 429 });
        if (n === 2) return new Response('{}', { status: 500 });
        expect(new URL(String(input)).pathname).toBe('/api/v1/user/7/watchlist');
        return new Response(JSON.stringify(pageOf(1, 1, 1, [item(A)])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await expect(client.readUserWatchlist(7, noSleep)).resolves.toMatchObject({ kind: 'ok' });
    expect(n).toBe(3);
  });
});
