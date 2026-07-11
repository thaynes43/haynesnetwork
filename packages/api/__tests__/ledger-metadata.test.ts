// ADR-018 / DESIGN-008 D-09 — the metadata sort/filter contract (the substrate PLAN-005/006
// reuse). Exercises the generalized keyset cursor HARD: sort by a nullable metadata field
// asc + desc with NULLS LAST, paged across boundaries, plus the facet filters + filterFacets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertMediaMetadataBatch, type MediaMetadataFields } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let tdb: TestDb;
let api: Caller;

beforeAll(async () => {
  tdb = await bootMigratedDb();
  // ADR-047 (PLAN-028) — metadata sort/filter/facet MECHANICS, orthogonal to the access gate; an admin
  // caller is `unrestricted` so the gate is a no-op (the gate is proven in library-access.test.ts).
  const member = await createUser(tdb.db, { admin: true });
  api = caller(makeCtx(tdb.db, sessionUser(member)));

  // Five radarr movies with varied ratings incl. TWO with NO metadata (null rating → last).
  const mk = async (title: string, meta: Omit<MediaMetadataFields, 'mediaItemId'> | null) => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title, sortTitle: title.toLowerCase() });
    if (meta) await upsertMediaMetadataBatch({ db: tdb.db, rows: [{ mediaItemId: item.id, ...meta }] });
    return item.id;
  };

  await mk('High', {
    imdbRating: 9.0,
    genres: ['Drama'],
    resolution: '2160p',
    requesters: ['manofoz'],
    playCount: 10,
    posterSource: 'arr',
    posterRef: '/MediaCover/1/poster.jpg',
  });
  await mk('Mid', {
    imdbRating: 6.5,
    genres: ['Comedy', 'Drama'],
    resolution: '1080p',
    requesters: ['helmu15'],
    playCount: 2,
  });
  await mk('Low', {
    imdbRating: 3.2,
    genres: ['Horror'],
    resolution: '1080p',
    requesters: [],
    playCount: 0,
  });
  // TmdbOnly: a harvested row with NO imdb_rating, only tmdb_rating (the Sonarr/Lidarr shape,
  // ADR-018 C-07) — exercises the rating filter's COALESCE(imdb, tmdb). Kept disjoint on every
  // facet (empty genres/requesters, null resolution) so it doesn't perturb the facet tests, and
  // it has null imdb_rating so it sorts with the trailing nulls on imdb_rating.
  await mk('TmdbOnly', {
    tmdbRating: 8.8,
    genres: [],
    requesters: [],
  });
  await mk('NullA', null); // no metadata row at all
  await mk('NullB', null);
});

afterAll(async () => {
  await tdb?.stop();
});

// NB: the imdb-null rows (NullA/NullB have no metadata; TmdbOnly has only a tmdb_rating) tie on
// the imdb_rating sort value (null) and break by id ASC (a random uuid), so their RELATIVE order
// is nondeterministic — assert the non-null ordering exactly and the null rows as a trailing SET.
const NULLS = ['NullA', 'NullB', 'TmdbOnly'];

describe('ledger.search — sort by a nullable metadata field (NULLS LAST, keyset)', () => {
  it('imdb_rating desc: highest first, unrated rows last', async () => {
    const { items } = await api.ledger.search({ sort: { field: 'imdb_rating', dir: 'desc' } });
    const titles = items.map((i) => i.title);
    expect(titles.slice(0, 3)).toEqual(['High', 'Mid', 'Low']);
    expect(titles.slice(3).sort()).toEqual(NULLS);
  });

  it('imdb_rating asc: lowest first, unrated rows STILL last (nulls last in both dirs)', async () => {
    const { items } = await api.ledger.search({ sort: { field: 'imdb_rating', dir: 'asc' } });
    const titles = items.map((i) => i.title);
    expect(titles.slice(0, 3)).toEqual(['Low', 'Mid', 'High']);
    expect(titles.slice(3).sort()).toEqual(NULLS);
  });

  it('paginates a sorted-by-rating list across the null boundary with a stable cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 10 && cursor !== null; i++) {
      const page = await api.ledger.search({
        sort: { field: 'imdb_rating', dir: 'desc' },
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((it) => it.title));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    // Every row exactly once across the null boundary — no dup/skip; non-nulls in order, nulls last.
    expect(seen.slice(0, 3)).toEqual(['High', 'Mid', 'Low']);
    expect(seen.slice(3).sort()).toEqual(NULLS);
    expect(new Set(seen).size).toBe(6);
  });

  it('play_count asc keyset paginates cleanly (numeric field)', async () => {
    const p1 = await api.ledger.search({ sort: { field: 'play_count', dir: 'asc' }, limit: 3 });
    const p2 = await api.ledger.search({
      sort: { field: 'play_count', dir: 'asc' },
      limit: 3,
      cursor: p1.nextCursor!,
    });
    const seen = [...p1.items, ...p2.items].map((i) => i.title);
    expect(seen.slice(0, 3)).toEqual(['Low', 'Mid', 'High']); // 0,2,10; nulls after
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });
});

describe('ledger.search — metadata filters', () => {
  it('genres facet (same-field OR)', async () => {
    const { items } = await api.ledger.search({ genres: ['Horror', 'Comedy'] });
    expect(items.map((i) => i.title).sort()).toEqual(['Low', 'Mid']);
  });

  it('resolutions facet', async () => {
    const { items } = await api.ledger.search({ resolutions: ['1080p'] });
    expect(items.map((i) => i.title).sort()).toEqual(['Low', 'Mid']);
  });

  it('requesters facet', async () => {
    const { items } = await api.ledger.search({ requesters: ['manofoz'] });
    expect(items.map((i) => i.title)).toEqual(['High']);
  });

  it('rating range (min/max) on COALESCE(imdb, tmdb)', async () => {
    // [4,8]: Mid (imdb 6.5) is in range; High (9) / Low (3.2) are out; TmdbOnly (tmdb 8.8) is out.
    const { items } = await api.ledger.search({ ratingMin: 4, ratingMax: 8 });
    expect(items.map((i) => i.title)).toEqual(['Mid']);
  });

  it('rating filter coalesces imdb→tmdb: a tmdb-only row matches; both-null rows never do', async () => {
    // ratingMin 8.5: High (imdb 9) AND TmdbOnly (no imdb, tmdb 8.8 via COALESCE) both qualify.
    const { items } = await api.ledger.search({ ratingMin: 8.5 });
    const titles = items.map((i) => i.title);
    expect(titles.sort()).toEqual(['High', 'TmdbOnly']);
    // The unrated rows (no imdb AND no tmdb) are excluded by any bound.
    expect(titles).not.toContain('NullA');
    expect(titles).not.toContain('NullB');
  });

  it('exposes the metadata block + poster URL on items', async () => {
    const { items } = await api.ledger.search({ requesters: ['manofoz'] });
    const high = items[0]!;
    expect(high.metadata).toMatchObject({ imdbRating: 9, resolution: '2160p', genres: ['Drama'] });
    expect(high.posterUrl).toBe(`/api/posters/${high.id}`);
    const noPoster = (await api.ledger.search({ resolutions: ['1080p'] })).items[0]!;
    expect(noPoster.posterUrl).toBeNull();
  });
});

describe('ledger.filterFacets', () => {
  it('returns the distinct harvested facet values', async () => {
    const facets = await api.ledger.filterFacets({ arrKind: 'radarr' });
    expect(facets.genres.sort()).toEqual(['Comedy', 'Drama', 'Horror']);
    // Resolutions come back in RESOLUTIONS enum order (best-first), NOT alphabetical.
    expect(facets.resolutions).toEqual(['2160p', '1080p']);
    expect(facets.requesters.sort()).toEqual(['helmu15', 'manofoz']);
  });
});
