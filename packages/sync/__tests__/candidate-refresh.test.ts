// ADR-035 — the full/incremental post-step that rebuilds the Trash candidate read-model. Proves:
// the step runs when a Maintainerr read handle is supplied (snapshot lands in trash_candidates +
// state rows), is SKIPPED cleanly when absent (Maintainerr-less env), and a Maintainerr failure
// is isolated (candidateRefreshError set, totalFailure NOT set — the *arr sync must never fail
// because the read-model refresh could not reach Maintainerr).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { trashCandidatesState } from '@hnet/db/schema';
import { buildMaintainerrClientBundle } from '@hnet/domain';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

/** Minimal read-only Maintainerr stub: one movie collection, three items. */
function maintainerrReadStub(opts: { reachable: boolean }) {
  const fetchImpl = (async (input: unknown) => {
    if (!opts.reachable) return new Response('down', { status: 502 });
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, '');
    const ok = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/collections')
      return ok([
        { id: 3, isActive: true, deleteAfterDays: 30, type: 'movie', title: 'least watched', media: [] },
      ]);
    if (/^\/collections\/media\/3\/content\/\d+$/.test(path))
      return ok({
        totalSize: 3,
        items: [
          { mediaServerId: 'ms-1', tmdbId: 1, sizeBytes: 100, addDate: '2026-06-01T00:00:00Z' },
          { mediaServerId: 'ms-2', tmdbId: 2, sizeBytes: 200, addDate: '2026-06-01T00:00:00Z' },
          { mediaServerId: 'ms-3', tmdbId: 3, sizeBytes: 300, addDate: '2026-06-01T00:00:00Z' },
        ],
      });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const bundle = buildMaintainerrClientBundle({
    baseUrl: 'http://maintainerr.test:6246',
    apiKey: 'k',
    retryDelayMs: 0,
    fetchImpl,
  });
  return { read: bundle.read };
}

describe('sync post-step — trash candidate snapshot refresh (ADR-035)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => t?.stop());

  it('incremental WITH a Maintainerr handle refreshes the snapshot (report + state rows)', async () => {
    const report = await runSync({
      mode: 'incremental',
      sources: [],
      db: t.db,
      clients: {},
      maintainerrRead: maintainerrReadStub({ reachable: true }),
    });
    expect(report.totalFailure).toBe(false);
    expect(report.candidateRefresh).toMatchObject({
      kinds: [
        { mediaKind: 'movie', itemCount: 3, totalSizeBytes: 600 },
        { mediaKind: 'tv', itemCount: 0, totalSizeBytes: 0 },
      ],
    });
    const [state] = await t.db
      .select()
      .from(trashCandidatesState)
      .where(eq(trashCandidatesState.mediaKind, 'movie'));
    expect(state).toMatchObject({ itemCount: 3, totalSizeBytes: 600 });
  });

  it('skips cleanly with NO handle (Maintainerr-less env)', async () => {
    const report = await runSync({ mode: 'incremental', sources: [], db: t.db, clients: {} });
    expect(report.candidateRefresh).toBeNull();
    expect(report.candidateRefreshError).toBeUndefined();
    expect(report.totalFailure).toBe(false);
  });

  it('a Maintainerr outage is ISOLATED: candidateRefreshError set, the run itself not failed', async () => {
    const report = await runSync({
      mode: 'incremental',
      sources: [],
      db: t.db,
      clients: {},
      maintainerrRead: maintainerrReadStub({ reachable: false }),
    });
    expect(report.candidateRefresh).toBeNull();
    expect(report.candidateRefreshError).toBeTruthy();
    expect(report.totalFailure).toBe(false);
  });
});
