// ADR-025 / DESIGN-011 — the `trash-batch-sweep` sync mode wiring: runSync drives
// sweepExpiredBatches through the injected Maintainerr bundle, returns a `sweep` report (never a
// per-source loop / sync_runs row), and surfaces an unsafe-install refusal as sweepError +
// totalFailure. The guarded per-item deletion itself is covered by the domain suite.
//
// ADR-093 / DESIGN-052 D-14 (PLAN-072) — the mode now refreshes the Watchlist Registry inline (only when a batch is
// due) and takes the Registry Gate: a refusal is a clean `paused` report and the job exits 0 (totalFailure false),
// with trash_sweep_status recording `paused_gate`. With nothing due the sweep does nothing at all (no audit, no
// refresh, no status row).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMaintainerrClientBundle,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  createStaticWatchlistSources,
  setSeerrWatchlistEnroll,
  type SeerrEnrollClients,
  getTrashSweepStatus,
  greenlightBatch,
  upsertMediaItemsBatch,
  type MaintainerrClientBundle,
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
  insertReleaseRecords,
  silentDomainLogger,
} from '@hnet/domain';
import { trashDeletedReleases } from '@hnet/db/schema';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

interface StubState {
  safe: boolean;
  collections: Array<{ id: number; title: string; arrAction: number; deleteAfterDays: number; type: string; items: string[] }>;
  handled: string[];
}

/** A small stateful Maintainerr: one rule pool, the Leaving-Soon shell, membership writes and the per-item handle. */
function stubMaintainerr(state: StubState): MaintainerrClientBundle {
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.29.0' });
    if (method === 'GET' && path === '/settings/test/plex') return ok({ status: state.safe ? 'OK' : 'NOK', code: 1 });
    if (method === 'GET' && path === '/rules/constants')
      return ok({
        applications: state.safe
          ? [{ name: 'Radarr' }, { name: 'Sonarr' }, { name: 'Tautulli' }, { name: 'Overseerr' }]
          : [{ name: 'Sonarr' }],
      });
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections')
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: true,
          title: c.title,
          deleteAfterDays: c.deleteAfterDays,
          arrAction: c.arrAction,
          // ADR-093 / DESIGN-052 D-16 — the invariant requires both flags on a rule pool.
          listExclusions: true,
          forceSeerr: true,
          type: c.type,
          libraryId: 1,
          media: [],
        })),
      );
    const content = /^\/collections\/media\/(\d+)\/content\/\d+$/.exec(path);
    if (method === 'GET' && content) {
      const col = state.collections.find((c) => c.id === Number(content[1]));
      const items = (col?.items ?? [])
        .filter((id) => !state.handled.includes(id))
        .map((id) => ({ mediaServerId: id, tmdbId: Number(id.replace(/\D/g, '')), sizeBytes: 1000, addDate: '2026-06-01T00:00:00Z' }));
      return ok({ totalSize: items.length, items });
    }
    if (method === 'GET' && path === '/rules/exclusion') return ok([]);
    if (method === 'POST' && path === '/rules') {
      state.collections.push({ id: 99, title: String(body.name), arrAction: 4, deleteAfterDays: 0, type: 'movie', items: [] });
      return ok({ code: 1, result: 'Success' }, 201);
    }
    if (method === 'POST' && (path === '/collections/add' || path === '/collections/remove')) return ok(null, 201);
    if (method === 'POST' && path === '/collections/media/handle') {
      state.handled.push(String(body.mediaId));
      return ok(null, 201);
    }
    return ok({});
  }) as typeof fetch;
  return buildMaintainerrClientBundle({ baseUrl: 'http://maintainerr.test:6246', apiKey: 'k', retryDelayMs: 0, fetchImpl });
}

const freshState = (): StubState => ({
  safe: true,
  collections: [{ id: 7, title: 'Least watched movies', arrAction: 0, deleteAfterDays: 9999, type: 'movie', items: ['ms-1'] }],
  handled: [],
});

describe('runSync — trash-batch-sweep mode (ADR-025, ADR-093)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
    // The pool item is known to the ledger (else the guardian keeps it `unevaluable`).
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 1, tmdbId: 1, title: 'One', sortTitle: 'one', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/movies' },
      ],
    });
  });
  afterAll(async () => t?.stop());

  /** An expired leaving_soon movie batch (green-lit with a -1 day window, the e2e time-travel idiom). */
  async function dueBatch(bundle: MaintainerrClientBundle): Promise<void> {
    const created = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId: null });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId: created.batchId, windowDays: -1, actorId: null });
  }

  it('nothing due ⇒ no audit, no refresh, no status row; no per-source rows', async () => {
    const { sources, calls } = createStaticWatchlistSources({ ownerId: '1' });
    const report = await runSync({
      mode: 'trash-batch-sweep',
      clients: {},
      maintainerr: stubMaintainerr({ ...freshState(), safe: false }),
      watchlistRegistry: sources,
      releaseBlockArr: createStaticReleaseBlockArr().arr,
      db: t.db,
    });
    expect(report.mode).toBe('trash-batch-sweep');
    expect(report.sources).toEqual([]);
    expect(report.sweep).toMatchObject({ batchesSwept: 0, due: 0, paused: null, outcome: null });
    expect(report.totalFailure).toBe(false);
    expect(calls.roster).toBeUndefined();
  });

  describe('with a batch due', () => {
    let state: StubState;
    let bundle: MaintainerrClientBundle;
    beforeEach(async () => {
      state = freshState();
      bundle = stubMaintainerr(state);
      await dueBatch(bundle);
    });

    it('a stale registry pauses cleanly: nothing handled, paused_gate recorded, the job exits 0', async () => {
      const failing = createStaticWatchlistSources({ ownerId: '1', rosterFails: true });
      const report = await runSync({
        mode: 'trash-batch-sweep',
        clients: {},
        maintainerr: bundle,
        watchlistRegistry: failing.sources,
        releaseBlockArr: createStaticReleaseBlockArr().arr,
        db: t.db,
      });
      expect(report.sweep).toMatchObject({ paused: { reason: 'gate', step: 'stale' }, outcome: 'paused_gate' });
      expect(report.totalFailure).toBe(false);
      expect(state.handled).toEqual([]);
      expect((await getTrashSweepStatus({ db: t.db })).lastOutcome).toBe('paused_gate');

      // The next run with a readable registry refreshes inline, passes the gate and sweeps.
      const ok = createStaticWatchlistSources({ ownerId: '1' });
      const swept = await runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: bundle, watchlistRegistry: ok.sources, releaseBlockArr: createStaticReleaseBlockArr().arr, db: t.db });
      expect(swept.sweep).toMatchObject({ batchesSwept: 1, paused: null, outcome: 'ok' });
      expect(state.handled).toEqual(['ms-1']);
    });

    it('an unsafe Maintainerr install fails the sweep (sweepError + totalFailure)', async () => {
      state.safe = false;
      const { sources } = createStaticWatchlistSources({ ownerId: '1' });
      const report = await runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: bundle, watchlistRegistry: sources, releaseBlockArr: createStaticReleaseBlockArr().arr, db: t.db });
      expect(report.sweep).toBeNull();
      expect(report.sweepError).toBeDefined();
      expect(report.totalFailure).toBe(true);
      // Leave nothing due for the next case.
      state.safe = true;
      await runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: bundle, watchlistRegistry: sources, releaseBlockArr: createStaticReleaseBlockArr().arr, db: t.db });
    });
  });

  it('requires a maintainerr bundle, the registry sources and the Release Block clients', async () => {
    await expect(runSync({ mode: 'trash-batch-sweep', clients: {}, db: t.db })).rejects.toThrow(/maintainerr/);
    await expect(
      runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: stubMaintainerr(freshState()), db: t.db }),
    ).rejects.toThrow(/Watchlist Registry/);
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    await expect(
      runSync({ mode: 'trash-batch-sweep', clients: {}, maintainerr: stubMaintainerr(freshState()), watchlistRegistry: sources, db: t.db }),
    ).rejects.toThrow(/Release Block/);
  });

  it('runs the hourly re-add check after the sweep, whether or not a batch was due (D-23)', async () => {
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    const { arr, fixture } = createStaticReleaseBlockArr();
    const report = await runSync({
      mode: 'trash-batch-sweep',
      clients: {},
      maintainerr: stubMaintainerr(freshState()),
      watchlistRegistry: sources,
      releaseBlockArr: arr,
      db: t.db,
    });
    expect(report.releaseBlockReadds).toMatchObject({ checked: expect.any(Number), failed: 0 });
    expect(report.totalFailure).toBe(false);
    expect(fixture.calls.every((c) => !c.includes('create') && !c.includes('update'))).toBe(true);
    // Nothing stranded or expiring, no live term and no profile: the upkeep read each profile once (D-25ce) and wrote
    // nothing.
    expect(report.releaseBlockUpkeep).toEqual([
      { arrKind: 'radarr', stranded: 0, expiring: 0, drift: null, report: null, error: null },
      { arrKind: 'sonarr', stranded: 0, expiring: 0, drift: null, report: null, error: null },
    ]);
    expect(fixture.calls.filter((c) => c.endsWith(' list'))).toEqual(['radarr list', 'sonarr list']);
  });

  it('D-25br: a nothing-due sweep job settles a record an ambiguous handle stranded, and drops its term', async () => {
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    const { arr, fixture } = createStaticReleaseBlockArr();
    const term = (n: number) =>
      `/^stub[^a-z0-9]+movie[^a-z0-9]+${n}[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]stub(?:[^a-z0-9]|$)/i`;
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    // Radarr 5: a 502 handle left it in flight, and Radarr still has it. Radarr 6: the answer was lost after the delete.
    fixture.gone.radarr.add(6);
    // Recorded through the domain writer (in flight, two hours ago), as the sweep's Phase A would have.
    await insertReleaseRecords({
      db: t.db,
      origin: 'sweep',
      state: 'in_flight',
      recordedAt: twoHoursAgo,
      logger: silentDomainLogger,
      items: [5, 6].map((id) => ({
        key: `ms-${id}`,
        drafts: [
          {
            arrKind: 'radarr' as const,
            arrItemId: id,
            mediaItemId: null,
            tmdbId: null,
            tvdbId: null,
            imdbId: null,
            title: `Stub Movie ${id}`,
            year: 2020,
            season: null,
            identitySource: 'arr_grab_history' as const,
            releaseTitle: null,
            releaseGroup: 'STUB',
            quality: null,
            resolution: 1080,
            sizeBytes: null,
            fileName: null,
            indexer: null,
            years: [2020],
            term: term(id),
            termConfidence: 'verified' as const,
            shape: 'group' as const,
          },
        ],
      })),
    });
    fixture.profiles.radarr.push({
      id: 1,
      name: RELEASE_BLOCK_PROFILE_NAME,
      enabled: true,
      required: [],
      ignored: [RELEASE_BLOCK_SENTINEL, term(5), term(6)],
      indexerId: 0,
      tags: [],
    });
    const report = await runSync({
      mode: 'trash-batch-sweep',
      clients: {},
      maintainerr: stubMaintainerr(freshState()),
      watchlistRegistry: sources,
      releaseBlockArr: arr,
      db: t.db,
    });
    expect(report.sweep).toMatchObject({ due: 0 });
    expect(report.totalFailure).toBe(false);
    expect(report.releaseBlockUpkeep?.[0]).toMatchObject({ arrKind: 'radarr', stranded: 2, report: { settled: 2 } });
    const states = Object.fromEntries(
      (await t.db.select().from(trashDeletedReleases))
        .filter((r) => r.arrItemId === 5 || r.arrItemId === 6)
        .map((r) => [r.arrItemId, r.state]),
    );
    expect(states).toEqual({ 5: 'abandoned', 6: 'active' });
    expect(fixture.profiles.radarr[0]!.ignored.sort()).toEqual([RELEASE_BLOCK_SENTINEL, term(6)].sort());
  });
});

describe('runSync — watchlist-registry mode (ADR-093 / DESIGN-052 D-20)', () => {
  let t: TestDb;
  beforeAll(async () => (t = await bootMigratedDb()));
  afterAll(async () => t?.stop());

  it('refreshes the registry (no sync_runs row); a clean failed run exits 0; a thrown one fails the job', async () => {
    const { sources } = createStaticWatchlistSources({ ownerId: '1', owner: [{ discoverId: '5d776824151a60001f24a29e', kind: 'movie' }] });
    const ok = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: sources, db: t.db });
    expect(ok.watchlistRegistry).toMatchObject({ status: 'ok' });
    expect(ok.sources).toEqual([]);
    expect(ok.totalFailure).toBe(false);

    const failing = createStaticWatchlistSources({ ownerId: '1', ownerFailure: 'throw' });
    const failed = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: failing.sources, db: t.db });
    expect(failed.watchlistRegistry).toMatchObject({ status: 'failed', failure: 'owner' });
    expect(failed.totalFailure).toBe(false);

    const broken = {
      ...sources,
      get plex(): never {
        throw new Error('reader construction exploded');
      },
    };
    const thrown = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: broken, db: t.db });
    expect(thrown.watchlistRegistryError).toMatch(/exploded/);
    expect(thrown.totalFailure).toBe(true);
  });

  it('requires the registry sources', async () => {
    await expect(runSync({ mode: 'watchlist-registry', clients: {}, db: t.db })).rejects.toThrow(/Watchlist Registry/);
  });

  it('D-25cf: runs the Release Block upkeep at the end of every run (the sweep CronJob may be suspended)', async () => {
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    const { arr, fixture } = createStaticReleaseBlockArr();
    const term = '/^stub[^a-z0-9]+movie[^a-z0-9]+7[^a-z0-9]+2020[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]stub(?:[^a-z0-9]|$)/i';
    // An Expedite whose handle answer was lost two hours ago left Radarr 7's record in flight; Radarr still has it.
    await insertReleaseRecords({
      db: t.db,
      origin: 'expedite',
      state: 'in_flight',
      recordedAt: new Date(Date.now() - 2 * 3_600_000),
      logger: silentDomainLogger,
      items: [
        {
          key: 'ms-7',
          drafts: [
            {
              arrKind: 'radarr' as const,
              arrItemId: 7,
              mediaItemId: null,
              tmdbId: null,
              tvdbId: null,
              imdbId: null,
              title: 'Stub Movie 7',
              year: 2020,
              season: null,
              identitySource: 'arr_grab_history' as const,
              releaseTitle: null,
              releaseGroup: 'STUB',
              quality: null,
              resolution: 1080,
              sizeBytes: null,
              fileName: null,
              indexer: null,
              years: [2020],
              term,
              termConfidence: 'verified' as const,
              shape: 'group' as const,
            },
          ],
        },
      ],
    });
    fixture.profiles.radarr.push({
      id: 1,
      name: RELEASE_BLOCK_PROFILE_NAME,
      enabled: true,
      required: [],
      ignored: [RELEASE_BLOCK_SENTINEL, term],
      indexerId: 0,
      tags: [],
    });
    const report = await runSync({
      mode: 'watchlist-registry',
      clients: {},
      watchlistRegistry: sources,
      releaseBlockArr: arr,
      db: t.db,
    });
    expect(report.watchlistRegistry).toMatchObject({ status: 'ok' });
    expect(report.releaseBlockUpkeep?.[0]).toMatchObject({ arrKind: 'radarr', stranded: 1, report: { settled: 1 } });
    const [rec] = (await t.db.select().from(trashDeletedReleases)).filter((r) => r.arrItemId === 7);
    expect(rec?.state).toBe('abandoned');
    expect(fixture.profiles.radarr[0]!.ignored).toEqual([RELEASE_BLOCK_SENTINEL]);
    // A failing *arr never fails the registry job; without the clients the step is skipped.
    fixture.fail.add('radarr:list');
    fixture.profiles.radarr[0] = { ...fixture.profiles.radarr[0]!, enabled: false };
    const failing = await runSync({
      mode: 'watchlist-registry',
      clients: {},
      watchlistRegistry: sources,
      releaseBlockArr: arr,
      db: t.db,
    });
    expect(failing.releaseBlockUpkeep?.[0]).toMatchObject({ arrKind: 'radarr', error: expect.any(String) });
    expect(failing.totalFailure).toBe(false);
    const none = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: sources, db: t.db });
    expect(none.releaseBlockUpkeep).toBeNull();
  });

  it('runs the Seerr enrollment step after the refresh while the setting is on (D-17); off does nothing', async () => {
    const writes: number[] = [];
    const seerrEnroll: SeerrEnrollClients = {
      read: {
        listUsers: async () => [{ id: 2, plexId: '200', userType: 1 }],
        getUserWatchlistSync: async () => ({ movies: false, tv: false }),
        listSonarrServers: async () => [],
      },
      write: {
        setWatchlistSync: async (id: number) => {
          writes.push(id);
          return { movies: true, tv: true };
        },
        setSonarrAnimeTags: async () => {
          throw new Error('not used');
        },
      },
    };
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    const off = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: sources, seerrEnroll, db: t.db });
    expect(off.seerrEnroll).toMatchObject({ status: 'disabled' });
    await setSeerrWatchlistEnroll({ db: t.db, value: { enabled: true, onlyUserIds: [2] }, actorId: null });
    const on = await runSync({ mode: 'watchlist-registry', clients: {}, watchlistRegistry: sources, seerrEnroll, db: t.db });
    expect(on.seerrEnroll).toMatchObject({ status: 'ok', enrolled: 1 });
    expect(writes).toEqual([2]);
    expect(on.totalFailure).toBe(false);
  });
});
