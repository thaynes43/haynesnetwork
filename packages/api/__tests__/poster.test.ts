// ADR-019 / DESIGN-008 — the poster PROXY resolution + the TMDB fallback for items removed from
// their *arr (Recently Deleted / Trash expedite): when the primary MediaCover 404s but the ledger
// still says poster_source='arr', the route streams the TMDB poster instead so the art survives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertMediaMetadataBatch } from '@hnet/domain';
import { resolvePosterUpstream, resolveTmdbPosterFallback } from '../src/poster';
import { bootMigratedDb, seedMediaItem, type TestDb } from './helpers';

let tdb: TestDb;

/** A stub fetch that answers TMDB detail requests from a fixture map keyed by URL substring. */
function stubTmdb(byPath: Record<string, unknown>, opts: { status?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, json] of Object.entries(byPath)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: opts.status ?? 404 });
  }) as unknown as typeof fetch;
}

const TMDB_ENV = { TMDB_API_KEY: 'test-key' };

const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  tdb = await bootMigratedDb();
  // resolvePosterUpstream()'s 'arr' branch calls assertArrEnv() (needs all four *arr keys).
  for (const key of [
    'RADARR_URL',
    'RADARR_API_KEY',
    'SONARR_API_KEY',
    'LIDARR_API_KEY',
    'SEERR_API_KEY',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.RADARR_URL = 'http://radarr.test';
  process.env.RADARR_API_KEY = 'r-key';
  process.env.SONARR_API_KEY = 's-key';
  process.env.LIDARR_API_KEY = 'l-key';
  process.env.SEERR_API_KEY = 'se-key';
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await tdb?.stop();
});

describe('resolvePosterUpstream — primary tier (unchanged)', () => {
  it('an arr-source item resolves to the owning *arr MediaCover (key in a header, not the url)', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Live', tmdbId: 555 });
    await upsertMediaMetadataBatch({
      db: tdb.db,
      rows: [{ mediaItemId: item.id, posterSource: 'arr', posterRef: '/MediaCover/9/poster.jpg' }],
    });
    const target = await resolvePosterUpstream(item.id, tdb.db);
    expect(target).not.toBeNull();
    expect(target!.source).toBe('arr');
    expect(target!.url).toBe(`http://radarr.test/api/v3/mediacover/${item.arrItemId}/poster-250.jpg`);
    expect(target!.headers['X-Api-Key']).toBe('r-key');
    expect(target!.url).not.toContain('r-key'); // key never on the url
  });

  it('a tmdb-source item resolves straight to the TMDB CDN w342 variant', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'TmdbPrimary', tmdbId: 556 });
    await upsertMediaMetadataBatch({
      db: tdb.db,
      rows: [{ mediaItemId: item.id, posterSource: 'tmdb', posterRef: '/xyz.jpg' }],
    });
    const target = await resolvePosterUpstream(item.id, tdb.db);
    expect(target).toMatchObject({ source: 'tmdb', url: 'https://image.tmdb.org/t/p/w342/xyz.jpg' });
  });

  it('an item with no harvested poster → null (KindIcon placeholder)', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'NoPoster', tmdbId: 557 });
    expect(await resolvePosterUpstream(item.id, tdb.db)).toBeNull();
  });

  it('a malformed id → null (no query)', async () => {
    expect(await resolvePosterUpstream('not-a-uuid', tdb.db)).toBeNull();
  });
});

describe('resolveTmdbPosterFallback — removed-item art (*arr 404 → TMDB)', () => {
  it('a radarr item with a tmdb id resolves the TMDB poster by movie id', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Removed', tmdbId: 1205225 });
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: TMDB_ENV,
      fetchImpl: stubTmdb({ '/movie/1205225': { poster_path: '/deleted.jpg' } }),
    });
    expect(fallback).toMatchObject({
      source: 'tmdb',
      url: 'https://image.tmdb.org/t/p/w342/deleted.jpg',
    });
  });

  it('a sonarr item with only a tvdb id resolves tmdb via find, then the tv poster', async () => {
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'RemovedTv', tvdbId: 424242, tmdbId: null });
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: TMDB_ENV,
      fetchImpl: stubTmdb({
        '/find/424242': { tv_results: [{ id: 987 }] },
        '/tv/987': { poster_path: '/show.jpg' },
      }),
    });
    expect(fallback).toMatchObject({ source: 'tmdb', url: 'https://image.tmdb.org/t/p/w342/show.jpg' });
  });

  it('TMDB has the record but no poster_path → null (placeholder)', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'NoTmdbArt', tmdbId: 111 });
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: TMDB_ENV,
      fetchImpl: stubTmdb({ '/movie/111': { vote_average: 5 } }),
    });
    expect(fallback).toBeNull();
  });

  it('TMDB 404 (record gone) → null (placeholder, current behavior)', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Gone', tmdbId: 222 });
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: TMDB_ENV,
      fetchImpl: stubTmdb({}), // every request 404s
    });
    expect(fallback).toBeNull();
  });

  it('a music (lidarr) item with no tmdb id → null (placeholder as today)', async () => {
    const item = await seedMediaItem(tdb.db, 'lidarr', { title: 'Band' });
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: TMDB_ENV,
      fetchImpl: stubTmdb({}),
    });
    expect(fallback).toBeNull();
  });

  it('TMDB unconfigured (no key) → null without any fetch', async () => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'NoKey', tmdbId: 333 });
    let called = false;
    const fallback = await resolveTmdbPosterFallback(item.id, {
      database: tdb.db,
      env: {}, // neither TMDB_API_KEY nor the read token
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(fallback).toBeNull();
    expect(called).toBe(false);
  });
});
