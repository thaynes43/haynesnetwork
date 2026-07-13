// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state). Proves the pure attribution helpers
// (mergeUserWatchContributions, deriveBookProgress), the app-user↔account MAPPING seam (upsert + reads +
// auto-fill), the per-user VIDEO watch read-model, and the per-user ABS BOOK read-state. Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booksItems, mediaItems } from '@hnet/db/schema';
import {
  deriveBookProgress,
  ensurePlexUserIdMapping,
  getAbsExternalIdToBooksItemId,
  getPlexUserIdToAppUserMap,
  getUserAccountMap,
  getUserMediaWatch,
  listMappedAbsUsers,
  mergeUserWatchContributions,
  syncBooks,
  upsertMediaItemsBatch,
  upsertUserAccountHandles,
  upsertUserBookProgressBatch,
  upsertUserMediaWatchBatch,
  viewerHasBookProgress,
  viewerHasWatchData,
  type BooksItemInput,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('mergeUserWatchContributions (pure, DESIGN-026 D-07)', () => {
  it('SUMs plays, MAXes last-viewed, watched=any, inProgress only when unfinished', () => {
    const r = mergeUserWatchContributions([
      { playCount: 2, lastViewedAt: new Date('2024-01-01T00:00:00Z'), watched: false, inProgress: true },
      { playCount: 3, lastViewedAt: new Date('2024-06-01T00:00:00Z'), watched: true, inProgress: false },
    ]);
    expect(r.playCount).toBe(5);
    expect(r.lastViewedAt?.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(r.watched).toBe(true);
    expect(r.inProgress).toBe(false); // watched wins — a finished title is not "in progress"
  });

  it('inProgress when only partial plays, never watched', () => {
    const r = mergeUserWatchContributions([
      { playCount: 1, lastViewedAt: null, watched: false, inProgress: true },
    ]);
    expect(r).toMatchObject({ watched: false, inProgress: true });
  });
});

describe('deriveBookProgress (pure, DESIGN-026 D-07)', () => {
  it('isFinished wins; progress clamps to [0,1]; inProgress = started-but-unfinished', () => {
    expect(deriveBookProgress({ isFinished: true, progress: 1 })).toEqual({
      isFinished: true,
      progress: 1,
      inProgress: false,
    });
    expect(deriveBookProgress({ isFinished: false, progress: 0.4 })).toEqual({
      isFinished: false,
      progress: 0.4,
      inProgress: true,
    });
    expect(deriveBookProgress({ progress: 5 })).toEqual({ isFinished: false, progress: 1, inProgress: true });
    expect(deriveBookProgress({})).toEqual({ isFinished: false, progress: null, inProgress: false });
  });
});

describe('the per-user seam (mapping + watch + read) — embedded PG16', () => {
  let t: TestDb;
  let userA: string;
  let userB: string;
  let movieId: string;
  let audiobookId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    userA = (await createUser(t.db, { email: 'watch-a@example.com' })).id;
    userB = (await createUser(t.db, { email: 'watch-b@example.com' })).id;

    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 7,
          tmdbId: 603,
          title: 'The Matrix',
          sortTitle: 'matrix',
          year: 1999,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'HD-1080p',
          rootFolder: '/data/movies',
        },
      ],
    });
    const [mi] = await t.db.select({ id: mediaItems.id }).from(mediaItems);
    movieId = mi!.id;

    const abRow: BooksItemInput = {
      source: 'audiobookshelf',
      mediaKind: 'audiobook',
      externalId: 'abs-item-1',
      libraryId: 'lib1',
      libraryName: 'Audio Books',
      title: 'Dune',
      sortTitle: 'dune',
      author: 'Frank Herbert',
      narrator: null,
      seriesName: null,
      year: 1965,
      releasedAt: null,
      genres: [],
      coverRef: null,
      deepLinkUrl: 'https://abs.example.com/item/abs-item-1',
      pageCount: null,
      wordCount: null,
      durationSeconds: 3600,
      sizeBytes: null,
      attrs: {},
      sourceAddedAt: null,
      sourceUpdatedAt: null,
    };
    await syncBooks({ db: t.db, rows: [abRow], syncedSources: ['audiobookshelf'] });
    const [ab] = await t.db.select({ id: booksItems.id }).from(booksItems);
    audiobookId = ab!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('upsertUserAccountHandles + reads: plex map / ABS list / partial update preserves handles', async () => {
    await upsertUserAccountHandles({ db: t.db, userId: userA, plexUserId: '12874060', absUserId: 'absA' });
    const plexMap = await getPlexUserIdToAppUserMap(t.db);
    expect(plexMap.get('12874060')).toBe(userA);
    expect(await listMappedAbsUsers(t.db)).toEqual([{ appUserId: userA, absUserId: 'absA' }]);

    // A partial update (only kavitaUsername) preserves the existing handles (undefined = keep).
    await upsertUserAccountHandles({ db: t.db, userId: userA, kavitaUsername: 'tomh' });
    const row = await getUserAccountMap(t.db, userA);
    expect(row).toMatchObject({ plexUserId: '12874060', absUserId: 'absA', kavitaUsername: 'tomh' });
  });

  it('ensurePlexUserIdMapping never clobbers a set id, but fills an empty one', async () => {
    // userA already has 12874060 → no-op.
    expect(await ensurePlexUserIdMapping({ db: t.db, userId: userA, plexUserId: '999' })).toEqual({
      changed: false,
    });
    // userB has no row → it fills.
    expect(await ensurePlexUserIdMapping({ db: t.db, userId: userB, plexUserId: '424242' })).toEqual({
      changed: true,
    });
    expect((await getPlexUserIdToAppUserMap(t.db)).get('424242')).toBe(userB);
  });

  it('upsertUserMediaWatchBatch is viewer-scoped + populated-value-gated + idempotent', async () => {
    await upsertUserMediaWatchBatch({
      db: t.db,
      rows: [
        { mediaItemId: movieId, appUserId: userA, playCount: 2, lastViewedAt: new Date('2024-05-05T00:00:00Z'), watched: true, inProgress: false },
      ],
    });
    expect(await viewerHasWatchData(t.db, userA)).toBe(true);
    expect(await viewerHasWatchData(t.db, userB)).toBe(false);
    expect(await getUserMediaWatch(t.db, movieId, userA)).toMatchObject({ watched: true, playCount: 2 });

    // Re-upsert REPLACES (idempotent — never a duplicate row).
    await upsertUserMediaWatchBatch({
      db: t.db,
      rows: [
        { mediaItemId: movieId, appUserId: userA, playCount: 5, lastViewedAt: null, watched: false, inProgress: true },
      ],
    });
    expect(await getUserMediaWatch(t.db, movieId, userA)).toMatchObject({
      watched: false,
      inProgress: true,
      playCount: 5,
    });
  });

  it('upsertUserBookProgressBatch + the external-id map + the read gate', async () => {
    const extMap = await getAbsExternalIdToBooksItemId(t.db);
    expect(extMap.get('abs-item-1')).toBe(audiobookId);

    await upsertUserBookProgressBatch({
      db: t.db,
      rows: [{ booksItemId: audiobookId, appUserId: userA, isFinished: true, progress: 1, inProgress: false }],
    });
    expect(await viewerHasBookProgress(t.db, userA)).toBe(true);
    expect(await viewerHasBookProgress(t.db, userB)).toBe(false);
  });
});
