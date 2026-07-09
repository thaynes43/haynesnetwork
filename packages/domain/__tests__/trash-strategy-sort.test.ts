// DESIGN-010/014 amendment (2026-07-09, build D) — the strategy-mirrored wall order. Proves the SHARED
// compareByStrategy ranking (worst-rated: unrated first, then rating asc, ties size desc, then title;
// largest: size desc, then title) AND that listTrashPendingPage's DEFAULT sort is 'strategy', mirroring
// the ACTIVE space-policy strategy for the kind (worst-rated by default; 'largest' when configured) so
// the top of the wall is the front of the deletion queue. The retired 'scheduled' sort is gone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaItems } from '@hnet/db/schema';
import {
  APP_SETTING_DEFAULTS,
  compareByStrategy,
  listTrashPendingPage,
  setAppSetting,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  type BatchStrategy,
  type StrategyRankItem,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import { baseState, makeMaintainerr, movieCollection } from './maintainerr-stub';

const item = (over: Partial<StrategyRankItem> & { title: string }): StrategyRankItem => ({
  imdbRating: null,
  tmdbRating: null,
  sizeBytes: 1_000_000_000,
  ...over,
});

const order = (xs: StrategyRankItem[], strategy: BatchStrategy): string[] =>
  [...xs].sort((a, b) => compareByStrategy(a, b, strategy)).map((i) => i.title);

describe('compareByStrategy (the shared batch/wall ranking)', () => {
  it('worst-rated: UNRATED first, then rating asc, ties broken by size desc, then title', () => {
    const xs = [
      item({ title: 'hi', imdbRating: 8.5 }),
      item({ title: 'mid', imdbRating: 6.0 }),
      item({ title: 'lo', tmdbRating: 3.0 }),
      item({ title: 'unrated-big', sizeBytes: 5e9 }),
      item({ title: 'unrated-small', sizeBytes: 2e9 }),
    ];
    expect(order(xs, 'worst-rated')).toEqual(['unrated-big', 'unrated-small', 'lo', 'mid', 'hi']);
  });

  it('worst-rated: equal ratings break by size desc, then title asc', () => {
    const xs = [
      item({ title: 'b-same', imdbRating: 5, sizeBytes: 2e9 }),
      item({ title: 'a-same', imdbRating: 5, sizeBytes: 2e9 }),
      item({ title: 'bigger', imdbRating: 5, sizeBytes: 9e9 }),
    ];
    expect(order(xs, 'worst-rated')).toEqual(['bigger', 'a-same', 'b-same']);
  });

  it('worst-rated: imdb takes precedence over tmdb; a 0 rating is a real (worst non-null) rating', () => {
    const xs = [
      item({ title: 'zero', imdbRating: 0 }),
      item({ title: 'unrated', sizeBytes: 9e9 }), // null still sorts before an actual 0
      item({ title: 'imdb-wins', imdbRating: 2, tmdbRating: 9 }),
    ];
    expect(order(xs, 'worst-rated')).toEqual(['unrated', 'zero', 'imdb-wins']);
  });

  it('largest: size desc, ties broken by title asc (ratings ignored)', () => {
    const xs = [
      item({ title: 'small', sizeBytes: 1e9, imdbRating: 1 }),
      item({ title: 'huge', sizeBytes: 9e9, imdbRating: 9 }),
      item({ title: 'b-mid', sizeBytes: 5e9 }),
      item({ title: 'a-mid', sizeBytes: 5e9 }),
    ];
    expect(order(xs, 'largest')).toEqual(['huge', 'a-mid', 'b-mid', 'small']);
  });
});

describe('listTrashPendingPage default sort mirrors the active strategy (build D)', () => {
  let t: TestDb;
  let actorId: string;

  // movieCollection() items: ms-9001 (tmdb 9001, 4e9) · ms-9002 (9002, 3e9) · ms-9003 (9003, 2e9).
  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'sort-admin@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 9001, tmdbId: 9001, title: 'Alpha', sortTitle: 'alpha', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
        { arrItemId: 9002, tmdbId: 9002, title: 'Bravo', sortTitle: 'bravo', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
        { arrItemId: 9003, tmdbId: 9003, title: 'Charlie', sortTitle: 'charlie', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
      ],
    });
    const rows = await t.db.select().from(mediaItems);
    const byTmdb = new Map(rows.map((r) => [r.tmdbId, r.id]));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        // 9001 highest rating + biggest file; 9003 UNRATED + smallest — so worst-rated and largest
        // produce OPPOSITE orders (worst-rated leads with the unrated smallest; largest with the biggest).
        { mediaItemId: byTmdb.get(9001)!, imdbRating: 8.0, tmdbRating: 8.2 },
        { mediaItemId: byTmdb.get(9002)!, imdbRating: 3.0 },
        { mediaItemId: byTmdb.get(9003)! },
      ],
    });
  });
  afterAll(async () => t?.stop());

  const setStrategy = (strategy: BatchStrategy) =>
    setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        ...APP_SETTING_DEFAULTS.space_policy,
        perKind: {
          ...APP_SETTING_DEFAULTS.space_policy.perKind,
          movie: { ...APP_SETTING_DEFAULTS.space_policy.perKind.movie, strategy },
        },
      },
      actorId,
    });

  const defaultOrder = async (): Promise<string[]> => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    // No `sort` passed ⇒ the server's default (the strategy sort).
    const page = await listTrashPendingPage({ db: t.db, maintainerr: bundle, media: 'movie', limit: 10, offset: 0 });
    return page.items.map((i) => i.maintainerrMediaId!);
  };

  it("worst-rated (the owner default) leads with the unrated title, then rating asc", async () => {
    await setStrategy('worst-rated');
    // 9003 unrated → 9002 (3.0) → 9001 (8.0).
    expect(await defaultOrder()).toEqual(['ms-9003', 'ms-9002', 'ms-9001']);
  });

  it("configured 'largest' flips the default to size desc (mirrors the batch pick)", async () => {
    await setStrategy('largest');
    // 4e9 → 3e9 → 2e9.
    expect(await defaultOrder()).toEqual(['ms-9001', 'ms-9002', 'ms-9003']);
  });

  it('an explicit Title sort still overrides the default', async () => {
    await setStrategy('worst-rated');
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const page = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      sort: { field: 'title', dir: 'asc' },
      limit: 10,
      offset: 0,
    });
    expect(page.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});
