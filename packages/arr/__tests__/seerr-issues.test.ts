// ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3) — the Seerr Issue mirror's reads against a sanitized recording of Seerr
// 3.5.0's `GET /api/v1/issue` (2026-10-12, the four real issues; names, emails and messages replaced). Offline: the
// query the list sends, the strip-mode parse (no avatar, token or permission field survives), paging to the end, an
// issue that shifts pages counted once, the page cap, the detail read, and a 404 read as "no such issue".
import { describe, expect, it } from 'vitest';
import { SeerrClient, SEERR_ISSUE_PAGE_SIZE } from '../src/read';
import { ArrHttpError } from '../src/errors';
import { fixture, stubFetch, type StubRoute } from './helpers';

const TEST_OPTS = { apiKey: 'test-seerr-key', timeoutMs: 1_000, getRetries: 0 } as const;

function client(routes: StubRoute[]) {
  const stub = stubFetch(routes);
  return {
    client: new SeerrClient({ baseUrl: 'http://seerr.test:5055', fetchImpl: stub.fetchImpl, ...TEST_OPTS }),
    ...stub,
  };
}

type Page = { pageInfo: { pages: number; pageSize: number; results: number; page: number }; results: Array<Record<string, unknown>> };
const recorded = () => fixture<Page>('seerr.issues');

describe('SeerrClient issue reads (DESIGN-055 D-10)', () => {
  it('lists every issue, all statuses, newest first, and strips what the mirror never reads', async () => {
    const { client: seerr, calls } = client([{ path: '/api/v1/issue', body: recorded() }]);
    const issues = await seerr.listAllIssues();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('filter')).toBe('all');
    expect(calls[0]!.url.searchParams.get('sort')).toBe('added');
    expect(calls[0]!.url.searchParams.get('take')).toBe(String(SEERR_ISSUE_PAGE_SIZE));
    expect(calls[0]!.url.searchParams.get('skip')).toBe('0');
    expect(calls[0]!.headers.get('x-api-key')).toBe('test-seerr-key');
    expect(issues.map((i) => i.id)).toEqual([4, 3, 2, 1]);

    const paper = issues.find((i) => i.id === 3)!;
    expect(paper).toMatchObject({
      issueType: 1,
      status: 2,
      problemSeason: 2,
      problemEpisode: 6,
      media: { mediaType: 'tv', tmdbId: 253941, tvdbId: 449872 },
      createdBy: { id: 11, email: 'reporter-one@example.test', displayName: 'Reporter One' },
    });
    expect(paper.comments).toHaveLength(3);
    expect(paper.comments![0]!.message).toBe('Missing episode 6');
    // Strip mode: the user's token, avatar and permissions never cross the boundary.
    expect(Object.keys(paper.createdBy!)).not.toContain('plexToken');
    expect(Object.keys(paper.createdBy!)).not.toContain('avatar');
    expect(Object.keys(paper)).not.toContain('modifiedBy');
    // A movie issue carries no tvdb id.
    expect(issues.find((i) => i.id === 2)!.media).toMatchObject({ mediaType: 'movie', tmdbId: 769, tvdbId: null });
  });

  it('pages to the end and counts an issue that shifted pages once', async () => {
    const all = Array.from({ length: SEERR_ISSUE_PAGE_SIZE + 2 }, (_, n) => ({
      ...recorded().results[0]!,
      id: 500 - n,
    }));
    const first = all.slice(0, SEERR_ISSUE_PAGE_SIZE);
    // A new issue filed between the reads pushes the last issue of page 1 onto page 2.
    const second = [first[first.length - 1]!, ...all.slice(SEERR_ISSUE_PAGE_SIZE)];
    let n = 0;
    const stub = stubFetch([]);
    const seerr = new SeerrClient({
      baseUrl: 'http://seerr.test:5055',
      ...TEST_OPTS,
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        await stub.fetchImpl(input as string, init);
        n += 1;
        const results = n === 1 ? first : second;
        const body = { pageInfo: { pages: 2, pageSize: SEERR_ISSUE_PAGE_SIZE, results: all.length, page: n }, results };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const issues = await seerr.listAllIssues();
    expect(stub.calls.map((c) => c.url.searchParams.get('skip'))).toEqual(['0', String(SEERR_ISSUE_PAGE_SIZE)]);
    expect(issues).toHaveLength(all.length);
    expect(new Set(issues.map((i) => i.id)).size).toBe(all.length);
  });

  it('refuses a list that never ends rather than answer a partial mirror', async () => {
    const full = Array.from({ length: SEERR_ISSUE_PAGE_SIZE }, (_, n) => ({ ...recorded().results[0]!, id: n + 1 }));
    let page = 0;
    const seerr = new SeerrClient({
      baseUrl: 'http://seerr.test:5055',
      ...TEST_OPTS,
      fetchImpl: (async () => {
        page += 1;
        const results = full.map((r) => ({ ...r, id: (r.id as number) + page * 1000 }));
        const body = { pageInfo: { pages: 999, pageSize: 100, results: 99_999, page }, results };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    await expect(seerr.listAllIssues()).rejects.toThrow(/did not end/);
  });

  it('reads one issue with its comment authors, and answers null for an issue Seerr does not have', async () => {
    const one = { ...recorded().results[1]!, comments: [{ id: 1, message: 'Missing episode 6', createdAt: '2026-09-27T00:00:00.000Z', user: { id: 11, displayName: 'Reporter One' } }] };
    const { client: seerr, calls } = client([
      { path: '/api/v1/issue/3', body: one },
      { path: '/api/v1/issue/99', status: 404, body: { message: 'Issue not found.' } },
      { path: '/api/v1/issue/7', status: 500, body: { message: 'boom' } },
    ]);
    const paper = await seerr.getIssue(3);
    expect(paper?.comments?.[0]?.user).toMatchObject({ id: 11, displayName: 'Reporter One' });
    expect(await seerr.getIssue(99)).toBeNull();
    await expect(seerr.getIssue(7)).rejects.toBeInstanceOf(ArrHttpError);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
