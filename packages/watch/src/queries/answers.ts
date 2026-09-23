// DESIGN-049 D-05 / D-10 / D-17 — the reads behind the watch tools' answers: the Unfinished candidates, the
// recent Watch Events, and the recommendation inputs (library candidates with D-17's SQL pre-filter and
// anti-joins, the watchlist and TMDB-seed candidates matched to the ledger, the owner's Title States and
// live marks). SELECT only; the pure views (views.ts) and `pickRecommendations` do the rest.
import {
  mediaItems,
  mediaMetadata,
  mediaPlexMatches,
  watchEvents,
  watchMarks,
  watchTitles,
  type DbClient,
  type WatchEventRow,
  type WatchRecoSignalRow,
  type WatchTitleRow,
} from '@hnet/db';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { GENRE_SYNONYMS, canonicalGenre } from '../genres';
import { titleKeyFor } from '../identity';
import type { RecoCandidate, RecoSeed } from '../recommend';
import type { WatchKind } from '../types';
import { selectSignals } from './signals';

/** D-10 / T-245 candidates: shows with a next episode, movies resumed between 5% and 90%. */
export async function selectUnfinishedRows(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | 'any' | null } = {},
): Promise<WatchTitleRow[]> {
  const shows = and(eq(watchTitles.kind, 'show'), sql`${watchTitles.nextSeason} IS NOT NULL`);
  const movies = and(
    eq(watchTitles.kind, 'movie'),
    sql`${watchTitles.resumePercent} BETWEEN 5 AND 90`,
  );
  const kind = opts.kind ?? 'show';
  const which = kind === 'show' ? shows : kind === 'movie' ? movies : or(shows, movies);
  return db
    .select()
    .from(watchTitles)
    .where(and(eq(watchTitles.plexAccountId, plexAccountId), which));
}

/** The owner's Watch Events started since `since`, newest first (`recent_history`). */
export async function selectRecentEvents(
  db: DbClient,
  plexAccountId: number,
  since: Date,
): Promise<WatchEventRow[]> {
  return db
    .select()
    .from(watchEvents)
    .where(and(eq(watchEvents.plexAccountId, plexAccountId), gte(watchEvents.startedAt, since)))
    .orderBy(desc(watchEvents.startedAt));
}

/** The Title State columns the recommendation pipeline reads (no episode maps). */
export type RecoTitleRow = Pick<
  WatchTitleRow,
  | 'kind'
  | 'titleKey'
  | 'title'
  | 'year'
  | 'plexGuid'
  | 'tmdbId'
  | 'tvdbId'
  | 'imdbId'
  | 'genres'
  | 'isKids'
  | 'episodesWatched'
  | 'episodesTotal'
  | 'eventWatchedEpisodes'
  | 'plexWatched'
  | 'resumePercent'
  | 'nextResume'
  | 'lastWatchedAt'
>;

export interface RecommendInputs {
  /** Library, watchlist and TMDB-seed candidates, not yet merged or excluded. */
  candidates: RecoCandidate[];
  titles: RecoTitleRow[];
}

/** D-17 library pre-filter: at most this many candidates reach the scorer. */
export const LIBRARY_CANDIDATE_LIMIT = 600;

const KIDS_GENRE_PATTERNS = ['%kid%', '%children%'];
const FAMILY_GENRE_PATTERNS = ['%kid%', '%children%', '%family%', '%animat%'];

/** LIKE patterns for every source spelling of a canonical genre (compound genres match by substring). */
export function genrePatterns(genre: string): string[] {
  const canonical = canonicalGenre(genre);
  if (canonical === null) return [];
  const spellings = new Set<string>([canonical]);
  for (const [spelling, target] of Object.entries(GENRE_SYNONYMS)) {
    if (target === canonical) spellings.add(spelling);
  }
  return [...spellings].map((s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

function genreLike(patterns: readonly string[]): SQL {
  const list = sql.join(
    patterns.map((p) => sql`${p}`),
    sql`, `,
  );
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${mediaMetadata.genres}) AS g(name) WHERE lower(g.name) LIKE ANY (ARRAY[${list}]::text[]))`;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function seconds(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** A ledger item's candidate fields. */
interface LedgerCandidate {
  id: string;
  arrKind: 'sonarr' | 'radarr' | 'lidarr';
  title: string;
  year: number | null;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  genres: string[] | null;
  imdbRating: string | null;
  tmdbRating: string | null;
  rtTomatometer: number | null;
  onPlex: boolean;
  addedToPlex: Date | string | null;
}

function ledgerSelect() {
  return {
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
  };
}

function kindOfArr(arrKind: string): WatchKind {
  return arrKind === 'sonarr' ? 'show' : 'movie';
}

function ledgerCandidate(m: LedgerCandidate): RecoCandidate {
  const kind = kindOfArr(m.arrKind);
  const ids = { tvdbId: kind === 'show' ? m.tvdbId : null, tmdbId: m.tmdbId, imdbId: m.imdbId };
  return {
    titleKey: titleKeyFor({ kind, title: m.title, year: m.year, ...ids }),
    kind,
    title: m.title,
    year: m.year,
    ...ids,
    genres: m.genres ?? [],
    onPlex: m.onPlex,
    addedAt: seconds(m.addedToPlex),
    ratings: { imdb: num(m.imdbRating), tmdb: num(m.tmdbRating), rottenTomatoes: num(m.rtTomatometer) },
  };
}

/**
 * D-17's library candidates: live Sonarr/Radarr items that are on Plex, with genres and ratings; SQL
 * pre-filter on kind, genre overlap and children's titles; anti-joined on the owner's Ever Watched and
 * started Title States and on every live mark; best rated first, at most 600. The pre-filter only ever
 * drops titles the pure D-18 exclusions would drop too — the exclusions still run on what survives.
 */
async function selectLibraryCandidates(
  db: DbClient,
  plexAccountId: number,
  opts: { kind: WatchKind | 'any'; genre: string | null; kids: boolean; limit: number },
): Promise<LedgerCandidate[]> {
  const arrKinds =
    opts.kind === 'show' ? ['sonarr'] : opts.kind === 'movie' ? ['radarr'] : ['sonarr', 'radarr'];
  const kindSql = sql`(CASE ${mediaItems.arrKind} WHEN 'sonarr' THEN 'show' ELSE 'movie' END)`;
  const sameTitle = (t: { kind: SQL; mediaItemId?: SQL; tvdb: SQL; tmdb: SQL; imdb: SQL }) =>
    sql`${t.kind} = ${kindSql} AND (${t.mediaItemId ? sql`${t.mediaItemId} = ${mediaItems.id} OR ` : sql``}(${mediaItems.arrKind} = 'sonarr' AND ${t.tvdb} = ${mediaItems.tvdbId}) OR ${t.tmdb} = ${mediaItems.tmdbId} OR ${t.imdb} = ${mediaItems.imdbId})`;
  const where: SQL[] = [
    inArray(mediaItems.arrKind, arrKinds as Array<'sonarr' | 'radarr'>),
    isNull(mediaItems.deletedFromArrAt),
    sql`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${watchTitles} WHERE ${watchTitles.plexAccountId} = ${plexAccountId} AND ${sameTitle(
      {
        kind: sql`${watchTitles.kind}`,
        mediaItemId: sql`${watchTitles.mediaItemId}`,
        tvdb: sql`${watchTitles.tvdbId}`,
        tmdb: sql`${watchTitles.tmdbId}`,
        imdb: sql`${watchTitles.imdbId}`,
      },
    )} AND (COALESCE(${watchTitles.episodesWatched}, 0) > 0 OR ${watchTitles.plexWatched} OR ${watchTitles.eventWatchedEpisodes} > 0 OR ${watchTitles.nextResume} OR COALESCE(${watchTitles.resumePercent}, 0) > 0))`,
    sql`NOT EXISTS (SELECT 1 FROM ${watchMarks} WHERE ${watchMarks.plexAccountId} = ${plexAccountId} AND ${watchMarks.revertedAt} IS NULL AND ${sameTitle(
      {
        kind: sql`${watchMarks.kind}`,
        tvdb: sql`${watchMarks.tvdbId}`,
        tmdb: sql`${watchMarks.tmdbId}`,
        imdb: sql`${watchMarks.imdbId}`,
      },
    )})`,
  ];
  if (opts.genre) {
    const patterns = genrePatterns(opts.genre);
    if (patterns.length > 0) where.push(genreLike(patterns));
  }
  where.push(
    opts.kids
      ? genreLike(FAMILY_GENRE_PATTERNS)
      : sql`NOT ${genreLike(KIDS_GENRE_PATTERNS)}`,
  );
  const rating = sql`COALESCE(${mediaMetadata.imdbRating}, ${mediaMetadata.tmdbRating}, ${mediaMetadata.rtTomatometer} / 10.0, 0)`;
  return db
    .select(ledgerSelect())
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(...where))
    .orderBy(desc(rating), asc(mediaItems.title), asc(mediaItems.id))
    .limit(opts.limit);
}

/** Ledger items that are the given signals (same kind, a shared TMDB / TVDB / IMDb id). */
async function selectLedgerForSignals(
  db: DbClient,
  signals: readonly WatchRecoSignalRow[],
): Promise<LedgerCandidate[]> {
  const tmdb = [...new Set(signals.flatMap((s) => (s.tmdbId ? [s.tmdbId] : [])))];
  const tvdb = [...new Set(signals.flatMap((s) => (s.tvdbId ? [s.tvdbId] : [])))];
  const imdb = [...new Set(signals.flatMap((s) => (s.imdbId ? [s.imdbId] : [])))];
  const match: SQL[] = [];
  if (tmdb.length > 0) match.push(inArray(mediaItems.tmdbId, tmdb));
  if (tvdb.length > 0) match.push(inArray(mediaItems.tvdbId, tvdb));
  if (imdb.length > 0) match.push(inArray(mediaItems.imdbId, imdb));
  if (match.length === 0) return [];
  return db
    .select(ledgerSelect())
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(
      and(
        inArray(mediaItems.arrKind, ['sonarr', 'radarr']),
        isNull(mediaItems.deletedFromArrAt),
        or(...match),
      ),
    );
}

function signalMatches(s: WatchRecoSignalRow, m: LedgerCandidate): boolean {
  if (kindOfArr(m.arrKind) !== s.kind) return false;
  return (
    (s.tmdbId !== null && s.tmdbId === m.tmdbId) ||
    (s.kind === 'show' && s.tvdbId !== null && s.tvdbId === m.tvdbId) ||
    (s.imdbId !== null && s.imdbId === m.imdbId)
  );
}

/**
 * Everything `recommend` scores (D-17): the library candidates, the watchlist (+ its ledger match, which
 * says whether it is on Plex and carries genres and ratings), the TMDB seed recommendations grouped per
 * title with every seed that listed it, and the owner's Title States (the Taste Profile and exclusions).
 * The caller adds the live marks.
 */
export async function selectRecommendInputs(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | 'any' | null; genre?: string | null; kids?: boolean; limit?: number } = {},
): Promise<RecommendInputs> {
  const kind = opts.kind ?? 'any';
  const [library, watchlist, seeds, titles] = await Promise.all([
    selectLibraryCandidates(db, plexAccountId, {
      kind,
      genre: opts.genre ?? null,
      kids: opts.kids === true,
      limit: opts.limit ?? LIBRARY_CANDIDATE_LIMIT,
    }),
    selectSignals(db, plexAccountId, 'watchlist'),
    selectSignals(db, plexAccountId, 'tmdb_seed'),
    db
      .select({
        kind: watchTitles.kind,
        titleKey: watchTitles.titleKey,
        title: watchTitles.title,
        year: watchTitles.year,
        plexGuid: watchTitles.plexGuid,
        tmdbId: watchTitles.tmdbId,
        tvdbId: watchTitles.tvdbId,
        imdbId: watchTitles.imdbId,
        genres: watchTitles.genres,
        isKids: watchTitles.isKids,
        episodesWatched: watchTitles.episodesWatched,
        episodesTotal: watchTitles.episodesTotal,
        eventWatchedEpisodes: watchTitles.eventWatchedEpisodes,
        plexWatched: watchTitles.plexWatched,
        resumePercent: watchTitles.resumePercent,
        nextResume: watchTitles.nextResume,
        lastWatchedAt: watchTitles.lastWatchedAt,
      })
      .from(watchTitles)
      .where(eq(watchTitles.plexAccountId, plexAccountId)),
  ]);
  const signals = [...watchlist, ...seeds].filter((s) => kind === 'any' || s.kind === kind);
  const ledger = await selectLedgerForSignals(db, signals);

  const lastWatched = new Map(titles.map((t) => [t.titleKey, seconds(t.lastWatchedAt)]));
  const candidates: RecoCandidate[] = library.map(ledgerCandidate);
  for (const s of signals) {
    const m = ledger.find((l) => signalMatches(s, l));
    const base = m ? ledgerCandidate(m) : null;
    const ids = {
      plexGuid: s.plexGuid,
      tmdbId: s.tmdbId ?? base?.tmdbId ?? null,
      tvdbId: s.kind === 'show' ? (s.tvdbId ?? base?.tvdbId ?? null) : null,
      imdbId: s.imdbId ?? base?.imdbId ?? null,
    };
    const seedsOf: RecoSeed[] =
      s.source === 'tmdb_seed' && s.seedTitleKey
        ? [{ titleKey: s.seedTitleKey, title: s.seedTitle ?? '', lastWatchedAt: lastWatched.get(s.seedTitleKey) ?? null }]
        : [];
    candidates.push({
      titleKey: titleKeyFor({ kind: s.kind, title: s.title, year: s.year, ...ids }),
      kind: s.kind,
      title: base?.title ?? s.title,
      year: s.year ?? base?.year ?? null,
      ...ids,
      genres: base?.genres ?? [],
      onPlex: base?.onPlex ?? false,
      addedAt: base?.addedAt ?? null,
      ratings: base?.ratings ?? null,
      watchlist: s.source === 'watchlist',
      seeds: seedsOf,
    });
  }
  return { candidates, titles };
}
