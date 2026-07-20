// ADR-072 / DESIGN-042 D-02/D-10 (PLAN-052 PR4b) — the confined haynes-ops GitHub REST client. Proves the
// env contract (missing token → typed config error, never echoed), the read surface (getFile base64 decode
// + 404→null, the managed-PR filter, the checks roll-up), and the write dance (branch → commit → PR →
// files → checks → squash-merge). All offline against an injected fetchImpl (ADR-010 — no live-API tests).
import { describe, expect, it } from 'vitest';
import { assertHaynesopsEnv, HaynesopsConfigError, HaynesopsHttpError } from '../src/index';
import { HaynesopsReadClient } from '../src/read';
import { HaynesopsWriteClient } from '../src/write';

const OPTS = {
  token: 't',
  apiBaseUrl: 'https://api.github.com',
  repo: 'o/r',
  baseBranch: 'main',
  retries: 0,
};

/** A tiny router over (method, path) → canned Response. */
function fetchStub(routes: Array<{ m: string; p: RegExp; status?: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const route = routes.find((r) => r.m === method && r.p.test(url));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('assertHaynesopsEnv', () => {
  it('throws a typed config error naming the missing token (never its value)', () => {
    try {
      assertHaynesopsEnv({});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HaynesopsConfigError);
      expect((e as HaynesopsConfigError).missing).toContain('HAYNESOPS_WRITE_TOKEN');
    }
  });

  it('defaults the repo/branch/dir and reads the token', () => {
    const cfg = assertHaynesopsEnv({ HAYNESOPS_WRITE_TOKEN: 'secret' });
    expect(cfg.repo).toBe('thaynes43/haynes-ops');
    expect(cfg.baseBranch).toBe('main');
    expect(cfg.configDir).toContain('kometa/app/config');
  });
});

describe('HaynesopsReadClient', () => {
  it('getFile base64-decodes and returns null on 404', async () => {
    const present = fetchStub([
      {
        m: 'GET',
        p: /contents\/a\.yml/,
        body: { content: b64('hello: world'), encoding: 'base64', sha: 's1' },
      },
    ]);
    const c = new HaynesopsReadClient({ ...OPTS, fetchImpl: present.fetchImpl });
    expect(await c.getFile('a.yml')).toEqual({ text: 'hello: world', sha: 's1' });

    const missing = fetchStub([{ m: 'GET', p: /contents\/missing/, status: 404 }]);
    const c2 = new HaynesopsReadClient({ ...OPTS, fetchImpl: missing.fetchImpl });
    expect(await c2.getFile('missing.yml')).toBeNull();
  });

  it('listOpenManagedPrs keeps only app-namespaced PRs on this repo', async () => {
    const s = fetchStub([
      {
        m: 'GET',
        p: /pulls\?state=open/,
        body: [
          {
            number: 1,
            title: 'app',
            html_url: 'u1',
            head: { ref: 'hnet-collections/x', sha: 'h1', repo: { full_name: 'o/r' } },
          },
          {
            number: 2,
            title: 'other',
            html_url: 'u2',
            head: { ref: 'feature/y', sha: 'h2', repo: { full_name: 'o/r' } },
          },
          {
            number: 3,
            title: 'fork',
            html_url: 'u3',
            head: { ref: 'hnet-collections/z', sha: 'h3', repo: { full_name: 'other/r' } },
          },
        ],
      },
    ]);
    const c = new HaynesopsReadClient({ ...OPTS, fetchImpl: s.fetchImpl });
    const prs = await c.listOpenManagedPrs();
    expect(prs.map((p) => p.number)).toEqual([1]);
  });

  it('getChecksConclusion rolls up success/failure/pending/none', async () => {
    const mk = (runs: unknown[]) =>
      new HaynesopsReadClient({
        ...OPTS,
        fetchImpl: fetchStub([{ m: 'GET', p: /check-runs/, body: { check_runs: runs } }]).fetchImpl,
      });
    expect(await mk([]).getChecksConclusion('h')).toBe('none');
    expect(
      await mk([{ status: 'completed', conclusion: 'success' }]).getChecksConclusion('h'),
    ).toBe('success');
    expect(
      await mk([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ]).getChecksConclusion('h'),
    ).toBe('failure');
    expect(await mk([{ status: 'in_progress' }]).getChecksConclusion('h')).toBe('pending');
  });

  it('getChecksConclusion SCOPED to the named gate ignores the sibling Flux Local matrix (D-10 2026-07-20)', async () => {
    const GATE = 'Kometa Validate Managed Files - Success';
    // The live haynes-ops #2170 shape: the named validate gate is green on the first poll while the Flux Local
    // matrix + Diff Scope are still in progress. Unscoped this false-negatives to 'pending'; scoped it is green.
    const matrixInProgress = [
      { name: GATE, status: 'completed', conclusion: 'success' },
      { name: 'Flux Local - Diff (main/helmrelease)', status: 'in_progress' },
      { name: 'Flux Local - Test (edge)', status: 'in_progress' },
      { name: 'Diff Scope - Success', status: 'in_progress' },
    ];
    const c = new HaynesopsReadClient({
      ...OPTS,
      fetchImpl: fetchStub([{ m: 'GET', p: /check-runs/, body: { check_runs: matrixInProgress } }])
        .fetchImpl,
    });
    expect(await c.getChecksConclusion('h')).toBe('pending'); // the OLD roll-up-everything false-negative
    expect(await c.getChecksConclusion('h', { requiredCheckName: GATE })).toBe('success'); // scoped = fixed

    // A red named gate is a failure even if every sibling is green.
    const gateRed = new HaynesopsReadClient({
      ...OPTS,
      fetchImpl: fetchStub([
        {
          m: 'GET',
          p: /check-runs/,
          body: {
            check_runs: [
              { name: GATE, status: 'completed', conclusion: 'failure' },
              { name: 'Flux Local - Success', status: 'completed', conclusion: 'success' },
            ],
          },
        },
      ]).fetchImpl,
    });
    expect(await gateRed.getChecksConclusion('h', { requiredCheckName: GATE })).toBe('failure');

    // The named gate has not reported yet (only sibling checks present) → PENDING, never a merge.
    const gateAbsent = new HaynesopsReadClient({
      ...OPTS,
      fetchImpl: fetchStub([
        {
          m: 'GET',
          p: /check-runs/,
          body: {
            check_runs: [
              { name: 'Flux Local - Success', status: 'completed', conclusion: 'success' },
            ],
          },
        },
      ]).fetchImpl,
    });
    expect(await gateAbsent.getChecksConclusion('h', { requiredCheckName: GATE })).toBe('pending');
  });
});

describe('HaynesopsWriteClient — the open-PR dance', () => {
  it('creates a branch, commits the file (with the existing sha), opens the PR', async () => {
    const s = fetchStub([
      { m: 'GET', p: /git\/ref\/heads\/main/, body: { object: { sha: 'base-sha' } } },
      { m: 'POST', p: /git\/refs/, body: {} },
      {
        m: 'GET',
        p: /contents\/.*hnet-managed-movies\.yml/,
        body: { content: b64('old'), encoding: 'base64', sha: 'old-sha' },
      },
      { m: 'PUT', p: /contents\/.*hnet-managed-movies\.yml/, body: { commit: { sha: 'c' } } },
      {
        m: 'POST',
        p: /\/pulls$/,
        body: { number: 42, html_url: 'https://gh/pull/42', head: { sha: 'head42' } },
      },
    ]);
    const c = new HaynesopsWriteClient({ ...OPTS, fetchImpl: s.fetchImpl });
    const pr = await c.openManagedFilePr({
      path: 'kubernetes/main/apps/media/kometa/app/config/hnet-managed-movies.yml',
      content: 'new content',
      branchSlug: 'movies-x-abc',
      title: 'add X',
      body: 'b',
    });
    expect(pr).toMatchObject({ number: 42, url: 'https://gh/pull/42', headSha: 'head42' });
    // The commit carried the existing blob sha (an UPDATE, not a create).
    const put = s.calls.find((cc) => cc.method === 'PUT');
    expect((put!.body as { sha?: string }).sha).toBe('old-sha');
    // The branch ref was app-namespaced.
    const refPost = s.calls.find((cc) => cc.method === 'POST' && /git\/refs/.test(cc.url));
    expect((refPost!.body as { ref: string }).ref).toBe('refs/heads/hnet-collections/movies-x-abc');
  });

  it('getPrFilePaths + squashMergePr hit the right endpoints', async () => {
    const s = fetchStub([
      { m: 'GET', p: /pulls\/42\/files/, body: [{ filename: 'a.yml' }, { filename: 'b.yml' }] },
      { m: 'PUT', p: /pulls\/42\/merge/, body: { merged: true } },
    ]);
    const c = new HaynesopsWriteClient({ ...OPTS, fetchImpl: s.fetchImpl });
    expect(await c.getPrFilePaths(42)).toEqual(['a.yml', 'b.yml']);
    await c.squashMergePr(42, 'add X');
    const merge = s.calls.find((cc) => /merge/.test(cc.url));
    expect((merge!.body as { merge_method: string }).merge_method).toBe('squash');
  });

  it('waitForChecks returns success as soon as the gate settles', async () => {
    const c = new HaynesopsWriteClient({
      ...OPTS,
      fetchImpl: fetchStub([
        {
          m: 'GET',
          p: /check-runs/,
          body: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
        },
      ]).fetchImpl,
    });
    expect(await c.waitForChecks('h', { attempts: 1, sleepImpl: async () => {} })).toBe('success');
  });

  it('surfaces a 4xx as a typed HttpError (never a silent success)', async () => {
    const c = new HaynesopsWriteClient({
      ...OPTS,
      fetchImpl: fetchStub([{ m: 'GET', p: /git\/ref/, status: 422, body: { message: 'bad' } }])
        .fetchImpl,
    });
    await expect(
      c.openManagedFilePr({ path: 'p', content: 'c', branchSlug: 's', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(HaynesopsHttpError);
  });
});
