// DESIGN-049 D-17 / D-18 — the `recommend` library query (`selectLibraryCandidates`) is anti-joined on the
// owner's started-or-watched Title States and live marks through excluded-id ARRAYS (one per identifier and
// kind) instead of one correlated `NOT EXISTS` OR-ing the four identifiers (≈ 0.5–1 s at 7k ledger items ×
// 1.5k titles). This pins the rewrite to the old query — kept here verbatim as the reference — on a fixture
// whose titles and marks reach ledger items through exactly one identifier each (ledger link, TVDB, TMDB,
// IMDb), through all of them, through the wrong kind, untouched, and reverted: the same rows, in the same
// order, for every kind / genre / kids / limit combination.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { mediaItems, mediaMetadata, mediaPlexMatches, watchMarks, watchTitles, type Database } from '@hnet/db';
import {
  genrePatterns,
  ledgerExclusions,
  selectLibraryCandidates,
  selectLiveMarks,
  selectRecommendInputs,
  selectTitleRows,
  titleKeyFor,
  type WatchKind,
} from '@hnet/watch';
import { bootMigratedDb, type TestDb } from './helpers';
import { PROBES, SCALE_OWNER, seedRecommendScale } from './recommend-fixture';

let t: TestDb;
let db: Database;

type Opts = { kind: WatchKind | 'any'; genre: string | null; kids: boolean; limit: number };

const KIDS_GENRE_PATTERNS = ['%kid%', '%children%'];
const FAMILY_GENRE_PATTERNS = ['%kid%', '%children%', '%family%', '%animat%'];

function genreLike(patterns: readonly string[]): SQL {
  const list = sql.join(
    patterns.map((p) => sql`${p}`),
    sql`, `,
  );
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${mediaMetadata.genres}) AS g(name) WHERE lower(g.name) LIKE ANY (ARRAY[${list}]::text[]))`;
}

/** The library query as PLAN-068 S7 first shipped it (commit 63435f5) — the reference. */
function referenceLibraryCandidates(plexAccountId: number, opts: Opts) {
  const arrKinds = opts.kind === 'show' ? ['sonarr'] : opts.kind === 'movie' ? ['radarr'] : ['sonarr', 'radarr'];
  const kindSql = sql`(CASE ${mediaItems.arrKind} WHEN 'sonarr' THEN 'show' ELSE 'movie' END)`;
  const sameTitle = (x: { kind: SQL; mediaItemId?: SQL; tvdb: SQL; tmdb: SQL; imdb: SQL }) =>
    sql`${x.kind} = ${kindSql} AND (${x.mediaItemId ? sql`${x.mediaItemId} = ${mediaItems.id} OR ` : sql``}(${mediaItems.arrKind} = 'sonarr' AND ${x.tvdb} = ${mediaItems.tvdbId}) OR ${x.tmdb} = ${mediaItems.tmdbId} OR ${x.imdb} = ${mediaItems.imdbId})`;
  const where: SQL[] = [
    inArray(mediaItems.arrKind, arrKinds as Array<'sonarr' | 'radarr'>),
    isNull(mediaItems.deletedFromArrAt),
    sql`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${watchTitles} WHERE ${watchTitles.plexAccountId} = ${plexAccountId} AND ${sameTitle({
      kind: sql`${watchTitles.kind}`,
      mediaItemId: sql`${watchTitles.mediaItemId}`,
      tvdb: sql`${watchTitles.tvdbId}`,
      tmdb: sql`${watchTitles.tmdbId}`,
      imdb: sql`${watchTitles.imdbId}`,
    })} AND (COALESCE(${watchTitles.episodesWatched}, 0) > 0 OR ${watchTitles.plexWatched} OR ${watchTitles.eventWatchedEpisodes} > 0 OR ${watchTitles.nextResume} OR COALESCE(${watchTitles.resumePercent}, 0) > 0))`,
    sql`NOT EXISTS (SELECT 1 FROM ${watchMarks} WHERE ${watchMarks.plexAccountId} = ${plexAccountId} AND ${watchMarks.revertedAt} IS NULL AND ${sameTitle({
      kind: sql`${watchMarks.kind}`,
      tvdb: sql`${watchMarks.tvdbId}`,
      tmdb: sql`${watchMarks.tmdbId}`,
      imdb: sql`${watchMarks.imdbId}`,
    })})`,
  ];
  if (opts.genre) {
    const patterns = genrePatterns(opts.genre);
    if (patterns.length > 0) where.push(genreLike(patterns));
  }
  where.push(opts.kids ? genreLike(FAMILY_GENRE_PATTERNS) : sql`NOT ${genreLike(KIDS_GENRE_PATTERNS)}`);
  const rating = sql`COALESCE(${mediaMetadata.imdbRating}, ${mediaMetadata.tmdbRating}, ${mediaMetadata.rtTomatometer} / 10.0, 0)`;
  return db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      title: mediaItems.title,
      year: mediaItems.year,
      tvdbId: mediaItems.tvdbId,
      tmdbId: mediaItems.tmdbId,
      imdbId: mediaItems.imdbId,
      genres: mediaMetadata.genres,
      imdbRating: mediaMetadata.imdbRating,
      tmdbRating: mediaMetadata.tmdbRating,
      rtTomatometer: mediaMetadata.rtTomatometer,
      onPlex: sql<boolean>`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
      addedToPlex: sql<Date | string | null>`(SELECT min(${mediaPlexMatches.firstSeenAt}) FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(...where))
    .orderBy(desc(rating), asc(mediaItems.title), asc(mediaItems.id))
    .limit(opts.limit);
}

async function candidates(opts: Opts) {
  const exclusions = ledgerExclusions(await selectTitleRows(db, SCALE_OWNER), await selectLiveMarks(db, SCALE_OWNER));
  return selectLibraryCandidates(db, { ...opts, exclusions });
}

beforeAll(async () => {
  t = await bootMigratedDb();
  db = t.db;
  await seedRecommendScale(db, { shows: 400, movies: 600, titles: 300, marks: 12 });
});

afterAll(async () => {
  await t.stop();
});

describe('the D-17 library query (anti-join on excluded-id arrays)', () => {
  it('returns exactly the reference query\'s rows, in its order, for every kind, genre, kids and limit', async () => {
    let compared = 0;
    for (const kind of ['any', 'show', 'movie'] as const) {
      for (const genre of [null, 'drama', 'sci-fi', 'animation', 'nonsense-genre']) {
        for (const kids of [false, true]) {
          for (const limit of [600, 7, 100_000]) {
            const opts = { kind, genre, kids, limit };
            const expected = await referenceLibraryCandidates(SCALE_OWNER, opts);
            const actual = await candidates(opts);
            expect(actual, JSON.stringify(opts)).toEqual(expected);
            compared += expected.length;
          }
        }
      }
    }
    // The fixture is not vacuous: hundreds of rows were compared.
    expect(compared).toBeGreaterThan(1_000);
  });

  it('excludes a title shared through ONE identifier only, and never across kinds, untouched or reverted', async () => {
    const all = await candidates({ kind: 'any', genre: null, kids: false, limit: 100_000 });
    const reference = await referenceLibraryCandidates(SCALE_OWNER, { kind: 'any', genre: null, kids: false, limit: 100_000 });
    const titles = new Set(all.map((c) => c.title));
    const referenceTitles = new Set(reference.map((c) => c.title));
    for (const probe of PROBES.excluded) {
      expect(titles.has(probe), probe).toBe(false);
      expect(referenceTitles.has(probe), `reference: ${probe}`).toBe(false);
    }
    for (const probe of PROBES.included) {
      expect(titles.has(probe), probe).toBe(true);
      expect(referenceTitles.has(probe), `reference: ${probe}`).toBe(true);
    }
    // The random part of the fixture excludes through every identifier too (so the comparison above covers
    // more than the probes): some ledger items are anti-joined away, most are not.
    const ledger = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(sql`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`);
    expect(all.length).toBeLessThan(ledger.length - 100);
    expect(all.length).toBeGreaterThan(ledger.length / 2);
  });

  it('selectRecommendInputs serves the same library candidates and hands back the live marks it excluded', async () => {
    const inputs = await selectRecommendInputs(db, SCALE_OWNER, { now: new Date(), kind: 'any', genre: null, kids: false });
    const reference = await referenceLibraryCandidates(SCALE_OWNER, { kind: 'any', genre: null, kids: false, limit: 600 });
    // The fixture has no watchlist or TMDB seeds, so every candidate is a library candidate.
    expect(inputs.candidates.map((c) => c.titleKey)).toEqual(
      reference.map((m) => {
        const kind: WatchKind = m.arrKind === 'sonarr' ? 'show' : 'movie';
        return titleKeyFor({ kind, title: m.title, year: m.year, tvdbId: kind === 'show' ? m.tvdbId : null, tmdbId: m.tmdbId, imdbId: m.imdbId });
      }),
    );
    const live = await selectLiveMarks(db, SCALE_OWNER);
    expect(inputs.marks.map((m) => m.id).sort()).toEqual(live.map((m) => m.id).sort());
    expect(inputs.marks.every((m) => m.revertedAt === null)).toBe(true);
    expect(inputs.titles.some((x) => x.mediaItemId !== null)).toBe(true);
  });
});
