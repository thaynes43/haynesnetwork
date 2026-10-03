// DESIGN-052 D-26 — the Trash Age Guard (owner ruling 2026-10-03, "Yes, newest date wins"), end to end on embedded
// PG16 with the fetch-stubbed Maintainerr, the in-memory Release Block *arr and the ledger + Plex-match tables the
// guard reads (no live API, ADR-010):
// - an upgrade (a download import) 60 days ago protects: never proposed, kept `recently_added` at the sweep;
// - a newer date added on a second Plex server protects, though the first server's date is old;
// - a rebuild-only date does not protect: a folder import (the 2026-07-03 rebuild's shape) and the *arr's own `added`
//   date are never read, so the title is deleted;
// - a title already in a batch when it is upgraded is kept at the sweep;
// - a Plex match the sync has not dated yet keeps the title `unevaluable` (fail closed);
// - TV: any episode import of the series protects the show the pool holds;
// - the batch wall's kept reason, the space policy's deletable count and the Start-a-batch preview follow.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  SEEDED_PLEX_SERVER_IDS,
  ledgerEvents,
  mediaItems,
  mediaPlexMatches,
  plexLibraries,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
} from '@hnet/db/schema';
import {
  TRASH_AGE_GUARD_DAYS,
  classifyAgeGuard,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  getBatchDetail,
  judgeAge,
  listTrashPending,
  listTrashPendingCandidates,
  refreshTrashCandidates,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, tvCollection, type MaintState } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const { arr: releaseArr } = createStaticReleaseBlockArr();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** A movie pool of four items. */
function pool() {
  return movieCollection({
    items: [9101, 9102, 9103, 9104].map((tmdbId, i) => ({
      mediaServerId: `ms-${tmdbId}`,
      tmdbId,
      sizeBytes: (4 - i) * 1_000,
      addDate: '2026-06-01T00:00:00Z',
    })),
  });
}

describe('the Trash Age Guard (DESIGN-052 D-26)', () => {
  let t: TestDb;
  let admin: string;
  let opsMovies: string;
  let towerMovies: string;
  let opsShows: string;
  const ids = new Map<number, string>(); // tmdb / tvdb id → media_items.id
  let eventSeq = 0;

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'age-guard@example.com', displayName: 'Age Admin' })).id;
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [
        { sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'HOps Shows', mediaType: 'show' },
      ],
    });
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynestower',
      libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
    });
    const libs = await t.db.select().from(plexLibraries);
    const lib = (server: string, key: string) =>
      libs.find((l) => l.serverId === server && l.sectionKey === key)!.id;
    opsMovies = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '1');
    opsShows = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '2');
    towerMovies = lib(SEEDED_PLEX_SERVER_IDS.haynestower, '1');

    const common = { monitored: true, qualityProfileId: 1, qualityProfileName: 'Any' };
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9101, 9102, 9103, 9104].map((tmdbId, i) => ({
        ...common,
        arrItemId: i + 1,
        tmdbId,
        title: `Movie ${tmdbId}`,
        sortTitle: `movie ${tmdbId}`,
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [8001, 8002].map((tvdbId, i) => ({
        ...common,
        arrItemId: i + 1,
        tvdbId,
        title: `Show ${tvdbId}`,
        sortTitle: `show ${tvdbId}`,
        rootFolder: '/tv',
      })),
    });
    for (const r of await t.db.select().from(mediaItems)) ids.set((r.tmdbId ?? r.tvdbId)!, r.id);
    // The 2026-07-03 rebuild shape: every movie's *arr `added` is recent. The guard never reads it.
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [9101, 9102, 9103, 9104].map((id) => ({ mediaItemId: ids.get(id)!, arrAddedAt: daysAgo(92) })),
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(ledgerEvents);
    await t.db.delete(mediaPlexMatches);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
    await seedVerifiedWatchlistRegistry(t.db);
    // Every movie is on both servers, added long ago; every show on HaynesOps, added long ago.
    await plexDates(
      [9101, 9102, 9103, 9104].flatMap((id) => [
        { ext: id, lib: opsMovies, at: daysAgo(400) },
        { ext: id, lib: towerMovies, at: daysAgo(300) },
      ]),
    );
    await plexDates([8001, 8002].map((id) => ({ ext: id, lib: opsShows, at: daysAgo(500) })));
  });

  /** Upsert the Plex matches (one per library) with their date added. */
  async function plexDates(rows: Array<{ ext: number; lib: string; at: Date | null }>) {
    await syncPlexMatches({
      db: t.db,
      matches: rows.map((r, i) => ({
        mediaItemId: ids.get(r.ext)!,
        plexLibraryId: r.lib,
        ratingKey: `${r.ext}-${i}`,
        matchedVia: 'tmdb' as const,
        plexAddedAt: r.at,
      })),
      scopedLibraryIds: [],
    });
  }

  /** An *arr history import in the ledger (`downloadFolderImported` = a download or an upgrade). */
  async function imported(
    ext: number,
    at: Date,
    rawEventType = 'downloadFolderImported',
    source: 'radarr' | 'sonarr' = 'radarr',
  ) {
    eventSeq += 1;
    await t.db.insert(ledgerEvents).values({
      mediaItemId: ids.get(ext)!,
      eventType: 'imported',
      source,
      sourceEventId: `age-${eventSeq}`,
      occurredAt: at,
      payload: { rawEventType, sourceTitle: `Release.${ext}.2160p` },
    });
  }

  async function createBatch(state: MaintState, mediaKind: 'movie' | 'tv' = 'movie', maxItems?: number) {
    const { bundle } = makeMaintainerr(state);
    return createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind,
      actorId: admin,
      ...(maxItems !== undefined ? { targeting: { maxItems } } : {}),
    });
  }

  async function expire(batchId: string) {
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, batchId));
  }

  async function sweep(state: MaintState) {
    const { bundle } = makeMaintainerr(state);
    return sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      logger: silentDomainLogger,
    });
  }

  const itemStates = async (batchId: string) =>
    Object.fromEntries(
      (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map((r) => [
        r.maintainerrMediaId,
        { state: r.state, keepReason: r.keepReason },
      ]),
    );

  it('judgeAge: newest date wins; a recent signal beats an undated match; old and dated is clear', () => {
    const now = Date.now();
    const ev = (o: Partial<Parameters<typeof judgeAge>[0] & object>) => ({
      newestImportAt: null,
      newestPlexAddedAt: null,
      plexMatches: 1,
      plexUndated: 0,
      ...o,
    });
    expect(judgeAge(undefined, now).ageGuard).toBe('unknown');
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(400) }), now).ageGuard).toBe('clear');
    const upgraded = daysAgo(60);
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(400), newestImportAt: upgraded }), now)).toEqual({
      ageGuard: 'recent',
      newestAddedAt: upgraded.toISOString(),
    });
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(TRASH_AGE_GUARD_DAYS + 1) }), now).ageGuard).toBe('clear');
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(TRASH_AGE_GUARD_DAYS - 1) }), now).ageGuard).toBe('recent');
    expect(judgeAge(ev({ newestImportAt: daysAgo(10), plexUndated: 1 }), now).ageGuard).toBe('recent');
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(400), plexMatches: 2, plexUndated: 1 }), now).ageGuard).toBe(
      'unknown',
    );
    // No Plex match at all: judged on imports alone.
    expect(judgeAge(ev({ plexMatches: 0 }), now).ageGuard).toBe('clear');
    expect(classifyAgeGuard({ ageGuard: 'recent' })).toEqual({ keep: true, reason: 'recently_added' });
    expect(classifyAgeGuard({ ageGuard: 'unknown' })).toEqual({ keep: true, reason: 'unevaluable' });
    expect(classifyAgeGuard({ ageGuard: 'clear' })).toEqual({ keep: false });
  });

  it('an upgrade 60 days ago protects: the pending read says recent, and no batch (targeted or not) takes it', async () => {
    await imported(9101, daysAgo(60));
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    const pending = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      watchlist: null,
    });
    const byId = new Map(pending.items.map((i) => [i.maintainerrMediaId, i]));
    expect(byId.get('ms-9101')?.ageGuard).toBe('recent');
    expect(Date.parse(byId.get('ms-9101')!.newestAddedAt!)).toBeCloseTo(daysAgo(60).getTime(), -4);
    expect(byId.get('ms-9102')?.ageGuard).toBe('clear');

    const untargeted = await createBatch(state);
    expect(Object.keys(await itemStates(untargeted.batchId)).sort()).toEqual(['ms-9102', 'ms-9103', 'ms-9104']);
    await t.db.delete(trashBatches);
    const targeted = await createBatch(state, 'movie', 2);
    // ms-9101 is the largest but never takes a slot.
    expect(Object.keys(await itemStates(targeted.batchId)).sort()).toEqual(['ms-9102', 'ms-9103']);

    // The Start-a-batch preview's wire says so too.
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const cands = await listTrashPendingCandidates({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(cands.candidates.find((c) => c.maintainerrMediaId === 'ms-9101')?.recentlyAdded).toBe(true);
    expect(cands.candidates.find((c) => c.maintainerrMediaId === 'ms-9102')?.recentlyAdded).toBe(false);
  });

  it('a title already in a batch when it is upgraded, or added to a second server, is kept at the sweep', async () => {
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    expect(Object.keys(await itemStates(batchId))).toHaveLength(4);
    // After the batch was built: ms-9101 is upgraded (60 days ago, as Troll was), ms-9102 lands on HaynesTower 120
    // days ago (newer than HaynesOps' 400), ms-9103 gets a folder import 20 days ago (the rebuild's shape: no file
    // arrived), ms-9104 is untouched.
    await imported(9101, daysAgo(60));
    await plexDates([{ ext: 9102, lib: towerMovies, at: daysAgo(120) }]);
    await imported(9103, daysAgo(20), 'movieFolderImported');
    await expire(batchId);
    const report = await sweep(state);
    expect(await itemStates(batchId)).toEqual({
      'ms-9101': { state: 'skipped', keepReason: 'recently_added' },
      'ms-9102': { state: 'skipped', keepReason: 'recently_added' },
      'ms-9103': { state: 'deleted', keepReason: null },
      'ms-9104': { state: 'deleted', keepReason: null },
    });
    expect(report.batches[0]!.keptByReason).toEqual({ recently_added: 2 });

    // The batch wall carries the reason on the kept rows (its "Kept: …" tooltip reads keepReason).
    const detail = await getBatchDetail({ db: t.db, batchId });
    const kept = detail.items.filter((i) => i.state === 'skipped').map((i) => i.keepReason);
    expect(kept).toEqual(['recently_added', 'recently_added']);
  });

  it('a rebuild-only date does not protect: the *arr `added` and folder imports are never read', async () => {
    // Every movie has arr_added_at 92 days ago (beforeAll) and a folder import 92 days ago; both servers say old.
    for (const id of [9101, 9102, 9103, 9104]) await imported(id, daysAgo(92), 'movieFolderImported');
    // An upgrade 200 days ago is outside the window.
    await imported(9104, daysAgo(200));
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    await expire(batchId);
    await sweep(state);
    expect(Object.values(await itemStates(batchId)).map((s) => s.state)).toEqual([
      'deleted',
      'deleted',
      'deleted',
      'deleted',
    ]);
  });

  it('a Plex match the sync has not dated yet keeps the title `unevaluable` (fail closed)', async () => {
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    await plexDates([{ ext: 9103, lib: towerMovies, at: null }]); // as on every row right after migration 0086
    await expire(batchId);
    await sweep(state);
    const states = await itemStates(batchId);
    expect(states['ms-9103']).toEqual({ state: 'skipped', keepReason: 'unevaluable' });
    expect(states['ms-9101']).toEqual({ state: 'deleted', keepReason: null });
  });

  it('TV: an episode imported 30 days ago protects the series the pool holds', async () => {
    await imported(8001, daysAgo(30), 'downloadFolderImported', 'sonarr');
    await imported(8002, daysAgo(30), 'downloadFolderImported', 'radarr'); // wrong source: not this series' history
    const state = baseState({ collections: [tvCollection()] });
    // An untargeted batch never proposes the protected show.
    const { batchId } = await createBatch(state, 'tv');
    expect(Object.keys(await itemStates(batchId))).toEqual(['ms-8002']);
    // Snapshot it anyway (as a batch built before the import would have) and sweep.
    await t.db.insert(trashBatchItems).values({
      batchId,
      maintainerrMediaId: 'ms-8001',
      collectionId: 8,
      mediaItemId: ids.get(8001)!,
      title: 'Show 8001',
      tvdbId: 8001,
      sizeBytes: 6_000,
    });
    await expire(batchId);
    await sweep(state);
    expect(await itemStates(batchId)).toEqual({
      'ms-8001': { state: 'skipped', keepReason: 'recently_added' },
      'ms-8002': { state: 'deleted', keepReason: null },
    });
  });
});
