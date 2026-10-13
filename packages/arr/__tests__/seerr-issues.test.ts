// ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3) — the Seerr Issue mirror's reads against a sanitized recording of Seerr
// 3.5.0's `GET /api/v1/issue` (2026-10-12, the four real issues; names, emails and messages replaced). Offline: the
// query the list sends, the strip-mode parse (no avatar, token or permission field survives), paging to the end, an
// issue that shifts pages counted once, the page cap, the detail read, and a 404 read as "no such issue".
import { describe, expect, it } from 'vitest';
import { SeerrClient, SEERR_ISSUE_PAGE_SIZE } from '../src/read';
import { SeerrWriteClient } from '../src/write';
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

// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the Seerr Issue bridge's read of its user and its two writes, with the
// bodies Seerr 3.5.0's own UI sends (IssueDetails: `{message}` to `/comment`, nothing to `/resolved`) and `X-API-User`
// naming the bridge user on every write. The key stays in `X-Api-Key`; user 1 (the owner) is refused before any call.
describe('the Seerr Issue bridge clients (PLAN-077 P7)', () => {
  const ISSUE = {
    id: 12,
    issueType: 1,
    status: 1,
    problemSeason: 2,
    problemEpisode: 6,
    createdAt: '2026-10-13T12:00:00.000Z',
    updatedAt: '2026-10-13T12:05:00.000Z',
    media: { mediaType: 'tv', tmdbId: 253941, tvdbId: 449872 },
    createdBy: { id: 1, displayName: 'admin' },
    comments: [
      { id: 40, message: 'Missing episode 6', createdAt: '2026-10-13T12:00:00.000Z', user: { id: 1 } },
      { id: 41, message: 'Thanks for the report.', createdAt: '2026-10-13T12:05:00.000Z', user: { id: 19, displayName: 'haynesnetwork.com' } },
    ],
  };

  function writer(routes: StubRoute[]) {
    const stub = stubFetch(routes);
    return {
      client: new SeerrWriteClient({ baseUrl: 'http://seerr.test:5055', fetchImpl: stub.fetchImpl, ...TEST_OPTS }),
      ...stub,
    };
  }

  it('reads the bridge user (id, permission bits, type, name only) and answers a missing user with null', async () => {
    const { client: seerr, calls } = client([
      { path: '/api/v1/user/19', body: { id: 19, permissions: 1048576, userType: 2, displayName: 'haynesnetwork.com', email: 'x@example.com', settings: {} } },
      { path: '/api/v1/user/20', status: 404, body: { message: 'User not found.' } },
    ]);
    expect(await seerr.getUser(19)).toEqual({ id: 19, permissions: 1048576, userType: 2, displayName: 'haynesnetwork.com' });
    expect(await seerr.getUser(20)).toBeNull();
    expect(calls.map((c) => c.headers.get('x-api-user'))).toEqual([null, null]);
  });

  it('comments with exactly {message} and resolves with no body, both as the bridge user', async () => {
    const { client: seerr, calls } = writer([
      { method: 'POST', path: '/api/v1/issue/12/comment', body: ISSUE },
      { method: 'POST', path: '/api/v1/issue/12/resolved', body: { ...ISSUE, status: 2 } },
    ]);
    const after = await seerr.commentOnIssue(12, 'Thanks for the report.', 19);
    expect(after.comments?.at(-1)).toMatchObject({ id: 41, user: { id: 19 } });
    expect((await seerr.resolveIssue(12, 19)).status).toBe(2);
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['POST', '/api/v1/issue/12/comment', { message: 'Thanks for the report.' }],
      ['POST', '/api/v1/issue/12/resolved', undefined],
    ]);
    for (const c of calls) {
      expect(c.headers.get('x-api-user')).toBe('19');
      expect(c.headers.get('x-api-key')).toBe('test-seerr-key');
    }
  });

  it('refuses to write as user 1 or with no usable user, before any call', async () => {
    const { client: seerr, calls } = writer([]);
    for (const bad of [1, 0, -3, 1.5, Number.NaN]) {
      expect(() => seerr.commentOnIssue(12, 'x', bad)).toThrow(/never user 1/);
      expect(() => seerr.resolveIssue(12, bad)).toThrow(/never user 1/);
      expect(() => seerr.createIssue(10974, 'staff smoke', bad)).toThrow(/never user 1/);
      expect(() => seerr.deleteIssue(12, bad)).toThrow(/never user 1/);
    }
    expect(calls).toEqual([]);
  });

  it('reads only the movie fixture identity, creates as the bridge reporter, and deletes with no body', async () => {
    const read = client([
      {
        path: '/api/v1/movie/65465',
        body: {
          title: 'The Canterville Ghost',
          mediaInfo: { id: 10974, tmdbId: 65465, status: 5 },
          overview: 'not consumed',
        },
      },
    ]);
    expect(await read.client.getMovieIssueTarget(65465)).toEqual({
      title: 'The Canterville Ghost',
      mediaInfo: { id: 10974, tmdbId: 65465 },
    });
    const { client: seerr, calls } = writer([
      { method: 'POST', path: '/api/v1/issue', body: ISSUE },
      { method: 'DELETE', path: '/api/v1/issue/12', body: undefined },
    ]);
    await seerr.createIssue(10974, 'marked staff smoke', 19);
    await seerr.deleteIssue(12, 19);
    expect(
      calls.map((c) => [c.method, c.url.pathname, c.body, c.headers.get('x-api-user')]),
    ).toEqual([
      [
        'POST',
        '/api/v1/issue',
        { issueType: 4, mediaId: 10974, message: 'marked staff smoke' },
        '19',
      ],
      ['DELETE', '/api/v1/issue/12', undefined, '19'],
    ]);
    for (const id of [1, 2, 3, 4]) expect(() => seerr.deleteIssue(id, 19)).toThrow(/issues 1 to 4/);
    expect(calls).toHaveLength(2);
  });

  it('a refused write is an error with its status, and is not retried (a POST is not idempotent)', async () => {
    const { client: seerr, calls } = writer([{ method: 'POST', path: '/api/v1/issue/12/comment', status: 502, body: { message: 'bad gateway' } }]);
    await expect(seerr.commentOnIssue(12, 'x', 19)).rejects.toBeInstanceOf(ArrHttpError);
    expect(calls).toHaveLength(1);
  });
});
