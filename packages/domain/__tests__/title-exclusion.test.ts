// ADR-096 / DESIGN-052 D-26 / D-27 — the Title Exclusion, end to end on embedded PG16 with the fetch-stubbed
// Maintainerr and the in-memory Radarr / Sonarr (no live API, ADR-010):
// - the writer: each missing title POSTed, read back and audited in the same transaction; a title already excluded is a
//   no-op (no POST, no row); a failed or unstuck write throws and leaves no row; a target without the *arr's key is
//   refused;
// - the delete paths: the sweep and Expedite write the exclusion BEFORE Phase A and the Maintainerr handle (Radarr by
//   tmdb id, Sonarr by tvdb id); an exclusion Maintainerr already wrote changes nothing; a failed exclusion pauses the
//   sweep / refuses Expedite with nothing recorded, blocked or deleted;
// - the backfill: the dry run writes nothing; a title the *arr has now is left out and listed; a title deleted twice
//   counts once; a row with no key is counted; `--apply` writes the rest; a second run writes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
  trashTitleExclusions,
} from '@hnet/db/schema';
import {
  ReleaseBlockError,
  TitleExclusionError,
  backfillTitleExclusions,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  ensureTitleExclusions,
  expediteDeletion,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
  type StaticArrMovie,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, tvCollection, type MaintState } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const logger = silentDomainLogger;

/** A Radarr movie with one grabbed, imported file (recordable: the Release Block has a term for it). */
function movie(id: number, tmdbId: number, title: string): StaticArrMovie {
  const name = `${title.replace(/\s+/g, '.')}.2024.1080p.BluRay.x264-GROUP`;
  return {
    title,
    year: 2024,
    tmdbId,
    file: {
      movieId: id,
      relativePath: `${title} (2024) [Bluray-1080p]-GROUP.mkv`,
      sceneName: name,
      originalFilePath: null,
      releaseGroup: 'GROUP',
      quality: {
        quality: { id: 7, name: 'Bluray-1080p', resolution: 1080, source: 'bluray', modifier: 'none' },
      },
      size: 8_000_000_000,
    },
    history: [],
  };
}

describe('the Title Exclusion (ADR-096 / DESIGN-052 D-26, D-27)', () => {
  let t: TestDb;
  let admin: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'te@example.com', displayName: 'TE Admin' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9001, 9002, 9003].map((tmdbId, i) => ({
        arrItemId: i + 1,
        tmdbId,
        title: `Movie ${tmdbId}`,
        sortTitle: `movie ${tmdbId}`,
        year: 2024,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [8001, 8002].map((tvdbId, i) => ({
        arrItemId: 81 + i,
        tvdbId,
        title: `Show ${tvdbId}`,
        sortTitle: `show ${tvdbId}`,
        year: 2010,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
      })),
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashTitleExclusions);
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
    await seedVerifiedWatchlistRegistry(t.db);
  });

  const rows = () => t.db.select().from(trashTitleExclusions);
  const radarrMovies = () =>
    new Map([
      [1, movie(1, 9001, 'Movie 9001')],
      [2, movie(2, 9002, 'Movie 9002')],
      [3, movie(3, 9003, 'Movie 9003')],
    ]);

  // -------------------------------------------------------------------------------------------------------------
  describe('the writer (D-26)', () => {
    it('writes each missing title, reads it back and audits it; a title already excluded is a no-op', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr({
        importListExclusions: {
          radarr: [{ id: 5, tmdbId: 9002, tvdbId: null, title: 'Movie 9002', year: 2024 }],
          sonarr: [],
        },
      });
      const report = await ensureTitleExclusions({
        db: t.db,
        arr,
        arrKind: 'radarr',
        targets: [
          { externalId: 9001, title: 'Movie 9001', year: 2024 },
          { externalId: 9002, title: 'Movie 9002', year: 2024 },
          { externalId: 9001, title: 'Movie 9001', year: 2024 }, // a repeat counts once
        ],
        origin: 'expedite',
        logger,
      });
      expect(report).toEqual({ arrKind: 'radarr', requested: 2, alreadyExcluded: 1, written: 1 });
      expect(fixture.calls).toEqual(['radarr exclusion_list', 'radarr exclusion_add 9001', 'radarr exclusion_list']);
      const written = fixture.importListExclusions.radarr.find((e) => e.tmdbId === 9001)!;
      expect(written).toMatchObject({ title: 'Movie 9001', year: 2024 });
      expect(await rows()).toEqual([
        expect.objectContaining({
          arrKind: 'radarr',
          tmdbId: 9001,
          tvdbId: null,
          title: 'Movie 9001',
          year: 2024,
          arrExclusionId: written.id,
          origin: 'expedite',
        }),
      ]);

      // Idempotent: every title is excluded now, so nothing is written and no row is added.
      fixture.calls.length = 0;
      const again = await ensureTitleExclusions({
        db: t.db,
        arr,
        arrKind: 'radarr',
        targets: [
          { externalId: 9001, title: 'Movie 9001', year: 2024 },
          { externalId: 9002, title: 'Movie 9002', year: 2024 },
        ],
        origin: 'sweep',
        logger,
      });
      expect(again).toMatchObject({ alreadyExcluded: 2, written: 0 });
      expect(fixture.calls).toEqual(['radarr exclusion_list']);
      expect(await rows()).toHaveLength(1);
    });

    it('Sonarr is keyed by tvdb id, with no year', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      await ensureTitleExclusions({
        db: t.db,
        arr,
        arrKind: 'sonarr',
        targets: [{ externalId: 8001, title: 'Show 8001', year: null }],
        origin: 'sweep',
        logger,
      });
      expect(fixture.importListExclusions.sonarr).toEqual([
        expect.objectContaining({ tvdbId: 8001, tmdbId: null, title: 'Show 8001' }),
      ]);
      expect(await rows()).toEqual([
        expect.objectContaining({ arrKind: 'sonarr', tvdbId: 8001, tmdbId: null, year: null }),
      ]);
    });

    it('a failed read or POST, or a POST that does not stick, throws with its step and leaves no row', async () => {
      const target = [{ externalId: 9003, title: 'Movie 9003', year: 2024 }];
      for (const [setup, step] of [
        [(f: ReturnType<typeof createStaticReleaseBlockArr>['fixture']) => f.fail.add('radarr:exclusion_list'), 'read'],
        [(f: ReturnType<typeof createStaticReleaseBlockArr>['fixture']) => f.fail.add('radarr:exclusion_add'), 'write'],
        [
          (f: ReturnType<typeof createStaticReleaseBlockArr>['fixture']) => f.dropWrites.add('radarr:exclusion_add'),
          'read_back',
        ],
      ] as const) {
        const { arr, fixture } = createStaticReleaseBlockArr();
        setup(fixture);
        const err = await ensureTitleExclusions({
          db: t.db,
          arr,
          arrKind: 'radarr',
          targets: target,
          origin: 'sweep',
          logger,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TitleExclusionError);
        expect((err as TitleExclusionError).step).toBe(step);
      }
      expect(await rows()).toEqual([]);
    });

    it('refuses a target without the *arr key or a title (validate) before any read', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      for (const bad of [
        { externalId: 0, title: 'Zero', year: 2024 },
        { externalId: 9001, title: '  ', year: 2024 },
      ]) {
        const err = await ensureTitleExclusions({
          db: t.db,
          arr,
          arrKind: 'radarr',
          targets: [bad],
          origin: 'sweep',
          logger,
        }).catch((e: unknown) => e);
        expect((err as TitleExclusionError).step).toBe('validate');
      }
      expect(fixture.calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the delete paths (D-26)', () => {
    async function expiredBatch(state: MaintState, mediaKind: 'movie' | 'tv' = 'movie') {
      const { bundle } = makeMaintainerr(state);
      const created = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind, actorId: admin });
      await t.db
        .update(trashBatches)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(trashBatches.id, created.batchId));
      return created.batchId;
    }
    const linked = (state: MaintState, fixture: ReturnType<typeof createStaticReleaseBlockArr>['fixture']) => {
      state.onHandle = (ms) => {
        fixture.calls.push(`maintainerr handle ${ms}`);
        if (ms.startsWith('ms-90')) fixture.gone.radarr.add(Number(ms.slice(-1)));
        else fixture.gone.sonarr.add(ms === 'ms-8001' ? 81 : 82);
      };
    };

    it('the sweep writes each title exclusion BEFORE Phase A and the handle; the row names the batch item', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: radarrMovies() });
      linked(state, fixture);
      const { bundle } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, arr, registry: 'gate-only', logger });
      expect(report.paused).toBeNull();
      expect(report.batches[0]!.deletedCount).toBe(3);
      const at = (call: string) => fixture.calls.indexOf(call);
      for (const id of [9001, 9002, 9003]) {
        expect(at(`radarr exclusion_add ${id}`)).toBeGreaterThan(-1);
        expect(at(`radarr exclusion_add ${id}`)).toBeLessThan(at('radarr create')); // before Phase A
      }
      expect(at('radarr create')).toBeLessThan(at('maintainerr handle ms-9001')); // and before every delete
      // one list, three POSTs, one read-back: a batch is one writer call per *arr
      expect(fixture.calls.filter((c) => c.startsWith('radarr exclusion_'))).toEqual([
        'radarr exclusion_list',
        'radarr exclusion_add 9001',
        'radarr exclusion_add 9002',
        'radarr exclusion_add 9003',
        'radarr exclusion_list',
      ]);
      const items = await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId));
      const audit = await rows();
      expect(audit.map((r) => r.tmdbId).sort()).toEqual([9001, 9002, 9003]);
      for (const r of audit) {
        expect(r.origin).toBe('sweep');
        const item = items.find((i) => i.id === r.batchItemId);
        expect(item?.tmdbId).toBe(r.tmdbId);
        expect(item?.state).toBe('deleted');
        expect(r.mediaItemId).toBe(item?.mediaItemId);
      }
    });

    it('an exclusion Maintainerr already wrote is a no-op: nothing is POSTed and the delete goes on', async () => {
      const state = baseState({ collections: [movieCollection({ items: movieCollection().items.slice(0, 1) })] });
      await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: radarrMovies(),
        importListExclusions: {
          radarr: [{ id: 41, tmdbId: 9001, tvdbId: null, title: 'Movie 9001', year: 2024 }],
          sonarr: [],
        },
      });
      linked(state, fixture);
      const { bundle } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, arr, registry: 'gate-only', logger });
      expect(report.batches[0]!.deletedCount).toBe(1);
      expect(fixture.calls.filter((c) => c.startsWith('radarr exclusion_'))).toEqual(['radarr exclusion_list']);
      expect(await rows()).toEqual([]);
    });

    it('a failed exclusion pauses the sweep (step `exclusion`): nothing recorded, blocked or deleted', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: radarrMovies(),
        fail: new Set(['radarr:exclusion_add']),
      });
      linked(state, fixture);
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'refresh',
        registrySources: (await import('../src/index')).createStaticWatchlistSources({ ownerId: '1' }).sources,
        logger,
      });
      expect(report).toMatchObject({
        paused: { reason: 'release_block', step: 'exclusion' },
        outcome: 'paused_release_block',
      });
      const items = await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId));
      expect(items.every((i) => i.state === 'pending')).toBe(true);
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect(await t.db.select().from(trashDeletedReleases)).toEqual([]);
      expect(fixture.calls.some((c) => c.startsWith('radarr create') || c.startsWith('radarr update'))).toBe(false);
      expect(await rows()).toEqual([]);
      const [status] = await t.db.select().from(trashSweepStatus);
      expect(status).toMatchObject({ lastOutcome: 'paused_release_block', lastReason: 'exclusion' });
    });

    it('Expedite writes it first too (origin `expedite`), and refuses with ReleaseBlockError `exclusion` when it cannot', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: radarrMovies() });
      linked(state, fixture);
      const { bundle } = makeMaintainerr(state);
      const res = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'item',
        media: 'movie',
        actorId: admin,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9001' },
        logger,
      });
      expect(res).toMatchObject({ expeditedCount: 1 });
      expect(fixture.calls.indexOf('radarr exclusion_add 9001')).toBeLessThan(
        fixture.calls.indexOf('maintainerr handle ms-9001'),
      );
      expect(await rows()).toEqual([
        expect.objectContaining({ tmdbId: 9001, origin: 'expedite', batchItemId: null }),
      ]);

      const down = createStaticReleaseBlockArr({ movies: radarrMovies(), fail: new Set(['radarr:exclusion_list']) });
      const state2 = baseState({ collections: [movieCollection()] });
      const { bundle: bundle2, calls } = makeMaintainerr(state2);
      const err = await expediteDeletion({
        db: t.db,
        maintainerr: bundle2,
        arr: down.arr,
        scope: 'item',
        media: 'movie',
        actorId: admin,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9002' },
        logger,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseBlockError);
      expect((err as ReleaseBlockError).step).toBe('exclusion');
      expect((err as ReleaseBlockError).mayHaveWritten).toBe(false);
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect(await t.db.select().from(trashDeletedReleases).where(eq(trashDeletedReleases.tmdbId, 9002))).toEqual([]);
    });

    it('a show gets the Sonarr exclusion by tvdb id (the ledger key where Sonarr answers none)', async () => {
      const state = baseState({ collections: [tvCollection()] });
      await expiredBatch(state, 'tv');
      const { arr, fixture } = createStaticReleaseBlockArr();
      linked(state, fixture);
      const { bundle } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, arr, registry: 'gate-only', logger });
      expect(report.batches[0]!.deletedCount).toBe(2);
      expect(fixture.importListExclusions.sonarr.map((e) => e.tvdbId).sort()).toEqual([8001, 8002]);
      expect(fixture.importListExclusions.radarr).toEqual([]);
      expect((await rows()).map((r) => [r.arrKind, r.tvdbId, r.origin])).toEqual(
        expect.arrayContaining([
          ['sonarr', 8001, 'sweep'],
          ['sonarr', 8002, 'sweep'],
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the backfill (D-27)', () => {
    async function deletedRows() {
      const ids = Object.fromEntries((await t.db.select().from(mediaItems)).map((r) => [r.title, r.id]));
      const [movies] = await t.db
        .insert(trashBatches)
        .values({ mediaKind: 'movie', state: 'deleted', deletedAt: new Date('2026-08-01T00:00:00Z') })
        .returning();
      const [shows] = await t.db
        .insert(trashBatches)
        .values({ mediaKind: 'tv', state: 'deleted', deletedAt: new Date('2026-08-01T00:00:00Z') })
        .returning();
      const row = (
        batchId: string,
        i: number,
        title: string,
        ids2: { tmdbId?: number | null; tvdbId?: number | null },
        deletedAt: string,
        state: 'deleted' | 'saved' = 'deleted',
      ) => ({
        batchId,
        maintainerrMediaId: `bf-${i}`,
        mediaItemId: ids[title] ?? null,
        title,
        year: 2024,
        tmdbId: ids2.tmdbId ?? null,
        tvdbId: ids2.tvdbId ?? null,
        state,
        deletedAt: state === 'deleted' ? new Date(deletedAt) : null,
      });
      await t.db.insert(trashBatchItems).values([
        row(movies!.id, 1, 'Movie 9001', { tmdbId: 9001 }, '2026-07-10T00:00:00Z'),
        row(movies!.id, 2, 'Movie 9001', { tmdbId: 9001 }, '2026-08-10T00:00:00Z'), // deleted twice: one title
        row(movies!.id, 3, 'Movie 9002', { tmdbId: 9002 }, '2026-07-10T00:00:00Z'), // back in Radarr now
        row(movies!.id, 4, 'Movie 9003', { tmdbId: 9003 }, '2026-07-10T00:00:00Z'), // already excluded
        row(movies!.id, 5, 'No Key Movie', { tmdbId: null }, '2026-07-10T00:00:00Z'),
        row(movies!.id, 6, 'Saved Movie', { tmdbId: 9100 }, '2026-07-10T00:00:00Z', 'saved'), // never deleted
        row(shows!.id, 7, 'Show 8001', { tvdbId: 8001 }, '2026-07-10T00:00:00Z'),
      ]);
    }

    it('dry run counts only; --apply excludes the rest, never a title the *arr has now; a re-run writes nothing', async () => {
      await deletedRows();
      const { arr, fixture } = createStaticReleaseBlockArr({
        synthesize: false,
        // Movie 9002 was requested again and is in Radarr under a new id.
        movies: new Map([[77, movie(77, 9002, 'Movie 9002')]]),
        importListExclusions: {
          radarr: [{ id: 3, tmdbId: 9003, tvdbId: null, title: 'Movie 9003', year: 2024 }],
          sonarr: [],
        },
      });

      const dry = await backfillTitleExclusions({ db: t.db, arr, apply: false, logger });
      expect(dry.radarr).toEqual({
        population: 3,
        present: 1,
        alreadyExcluded: 1,
        noKey: 1,
        toExclude: 1,
        written: 0,
        failed: null,
      });
      expect(dry.sonarr).toMatchObject({ population: 1, present: 0, toExclude: 1, written: 0 });
      expect(dry.presentTitles).toEqual([{ kind: 'radarr', externalId: 9002, title: 'Movie 9002', year: 2024 }]);
      expect(dry.noKeyTitles).toEqual([{ kind: 'radarr', externalId: null, title: 'No Key Movie', year: 2024 }]);
      expect(fixture.calls.some((c) => c.includes('exclusion_add'))).toBe(false);
      expect(await rows()).toEqual([]);

      const applied = await backfillTitleExclusions({ db: t.db, arr, apply: true, logger });
      expect(applied.radarr).toMatchObject({ toExclude: 1, written: 1, failed: null });
      expect(applied.sonarr).toMatchObject({ toExclude: 1, written: 1, failed: null });
      expect(fixture.importListExclusions.radarr.map((e) => e.tmdbId).sort()).toEqual([9001, 9003]);
      expect(fixture.importListExclusions.sonarr.map((e) => e.tvdbId)).toEqual([8001]);
      const audit = await rows();
      expect(audit.map((r) => [r.arrKind, r.tmdbId ?? r.tvdbId, r.origin]).sort()).toEqual([
        ['radarr', 9001, 'backfill'],
        ['sonarr', 8001, 'backfill'],
      ]);
      // The newest deletion names the title's audit row.
      const newest = await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.maintainerrMediaId, 'bf-2'));
      expect(audit.find((r) => r.tmdbId === 9001)?.batchItemId).toBe(newest[0]!.id);

      fixture.calls.length = 0;
      const again = await backfillTitleExclusions({ db: t.db, arr, apply: true, logger });
      expect(again.radarr).toMatchObject({ alreadyExcluded: 2, toExclude: 0, written: 0 });
      expect(again.sonarr).toMatchObject({ alreadyExcluded: 1, toExclude: 0, written: 0 });
      expect(fixture.calls.some((c) => c.includes('exclusion_add'))).toBe(false);
      expect(await rows()).toHaveLength(2);
    });

    it('a failed library read writes nothing; a failed chunk stops that *arr and reports its step', async () => {
      await deletedRows();
      const down = createStaticReleaseBlockArr({ synthesize: false, fail: new Set(['radarr:library']) });
      await expect(backfillTitleExclusions({ db: t.db, arr: down.arr, apply: true, logger })).rejects.toThrow();
      expect(down.fixture.calls.some((c) => c.includes('exclusion_add'))).toBe(false);

      const flaky = createStaticReleaseBlockArr({ synthesize: false, fail: new Set(['radarr:exclusion_add']) });
      const report = await backfillTitleExclusions({ db: t.db, arr: flaky.arr, apply: true, logger });
      expect(report.radarr).toMatchObject({ written: 0, failed: 'write' });
      expect(report.sonarr).toMatchObject({ written: 1, failed: null });
      expect((await rows()).map((r) => r.arrKind)).toEqual(['sonarr']);
    });
  });
});
