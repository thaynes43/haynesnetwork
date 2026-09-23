// DESIGN-049 D-05 / D-10 / D-17 — the reads behind the watch tools' answers: the Unfinished candidates, the
// recent Watch Events, and the recommendation inputs (library candidates with D-17's SQL pre-filter and
// anti-joins, the watchlist and TMDB-seed candidates matched to the ledger, the owner's Title States and
// live marks). SELECT only; the pure views (views.ts) and `pickRecommendations` do the rest.
import {
  mediaItems,
  mediaMetadata,
  mediaPlexMatches,
  watchEvents,
  watchTitles,
  type DbClient,
  type WatchEventRow,
  type WatchMarkRow,
  type WatchRecoSignalRow,
  type WatchTitleRow,
} from '@hnet/db';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { GENRE_SYNONYMS, canonicalGenre } from '../genres';
import { titleKeyFor } from '../identity';
import type { RecoCandidate, RecoSeed } from '../recommend';
import type { WatchKind } from '../types';
import { selectLiveMarks } from './marks';
import { selectSignals } from './signals';

/**
 * The Title State columns `unfinished` ranks, filters and speaks: no episode map, Plex counters or `on_plex`
 * (the live revalidation loads those whole rows for the few titles it reports — `selectTitleRows`).
 */
export type UnfinishedRow = Pick<
  WatchTitleRow,
  | 'id'
  | 'kind'
  | 'titleKey'
  | 'title'
  | 'year'
  | 'plexGuid'
  | 'tmdbId'
  | 'tvdbId'
  | 'imdbId'
  | 'isKids'
  | 'episodesWatched'
  | 'episodesTotal'
  | 'nextSeason'
  | 'nextEpisode'
  | 'nextResume'
  | 'resumePercent'
  | 'plexWatched'
  | 'lastWatchedAt'
  | 'rewatch'
  | 'showStatus'
>;

/** D-10 / T-245 candidates: shows with a next episode, movies resumed between 5% and 90%. */
export async function selectUnfinishedRows(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | 'any' | null } = {},
): Promise<UnfinishedRow[]> {
  const shows = and(eq(watchTitles.kind, 'show'), sql`${watchTitles.nextSeason} IS NOT NULL`);
  const movies = and(
    eq(watchTitles.kind, 'movie'),
    sql`${watchTitles.resumePercent} BETWEEN 5 AND 90`,
  );
  const kind = opts.kind ?? 'show';
  const which = kind === 'show' ? shows : kind === 'movie' ? movies : or(shows, movies);
  return db
    .select({
      id: watchTitles.id,
      kind: watchTitles.kind,
      titleKey: watchTitles.titleKey,
      title: watchTitles.title,
      year: watchTitles.year,
      plexGuid: watchTitles.plexGuid,
      tmdbId: watchTitles.tmdbId,
      tvdbId: watchTitles.tvdbId,
      imdbId: watchTitles.imdbId,
      isKids: watchTitles.isKids,
      episodesWatched: watchTitles.episodesWatched,
      episodesTotal: watchTitles.episodesTotal,
      nextSeason: watchTitles.nextSeason,
      nextEpisode: watchTitles.nextEpisode,
      nextResume: watchTitles.nextResume,
      resumePercent: watchTitles.resumePercent,
      plexWatched: watchTitles.plexWatched,
      lastWatchedAt: watchTitles.lastWatchedAt,
      rewatch: watchTitles.rewatch,
      showStatus: watchTitles.showStatus,
    })
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
  | 'mediaItemId'
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
  /** The owner's live (unreverted) marks — the same rows the library query was anti-joined on. */
  marks: WatchMarkRow[];
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
export interface LedgerCandidate {
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

/** One kind's excluded ledger identifiers (no NULLs, no duplicates). */
export interface ExcludedLedgerIds {
  mediaItemIds: string[];
  tvdbIds: number[];
  tmdbIds: number[];
  imdbIds: string[];
}

/** D-17's anti-join inputs per kind: what a ledger item of that kind must not share. */
export interface LedgerExclusions {
  show: ExcludedLedgerIds;
  movie: ExcludedLedgerIds;
}

type ExclusionTitle = Pick<
  WatchTitleRow,
  | 'kind'
  | 'mediaItemId'
  | 'tvdbId'
  | 'tmdbId'
  | 'imdbId'
  | 'episodesWatched'
  | 'plexWatched'
  | 'eventWatchedEpisodes'
  | 'nextResume'
  | 'resumePercent'
>;
type ExclusionMark = Pick<WatchMarkRow, 'kind' | 'tvdbId' | 'tmdbId' | 'imdbId' | 'revertedAt'>;

/**
 * The identifiers D-17 anti-joins the ledger on: from every Title State the owner started or watched (its
 * ledger link, TVDB, TMDB and IMDb ids) and from every live mark (its ids — a mark has no ledger link), per
 * kind. A ledger item is excluded when it shares one of them with a title of its own kind (TVDB: shows only).
 */
export function ledgerExclusions(
  titles: readonly ExclusionTitle[],
  marks: readonly ExclusionMark[],
): LedgerExclusions {
  const empty = () => ({
    mediaItemIds: new Set<string>(),
    tvdbIds: new Set<number>(),
    tmdbIds: new Set<number>(),
    imdbIds: new Set<string>(),
  });
  const sets = { show: empty(), movie: empty() };
  const add = (r: { kind: WatchKind; tvdbId: number | null; tmdbId: number | null; imdbId: string | null }, mediaItemId: string | null) => {
    const k = sets[r.kind];
    if (mediaItemId !== null) k.mediaItemIds.add(mediaItemId);
    if (r.tvdbId !== null) k.tvdbIds.add(r.tvdbId);
    if (r.tmdbId !== null) k.tmdbIds.add(r.tmdbId);
    if (r.imdbId !== null) k.imdbIds.add(r.imdbId);
  };
  for (const t of titles) {
    const startedOrWatched =
      (t.episodesWatched ?? 0) > 0 || t.plexWatched || t.eventWatchedEpisodes > 0 || t.nextResume || (t.resumePercent ?? 0) > 0;
    if (startedOrWatched) add(t, t.mediaItemId);
  }
  for (const m of marks) if (!m.revertedAt) add(m, null);
  const out = (k: ReturnType<typeof empty>): ExcludedLedgerIds => ({
    mediaItemIds: [...k.mediaItemIds],
    tvdbIds: [...k.tvdbIds],
    tmdbIds: [...k.tmdbIds],
    imdbIds: [...k.imdbIds],
  });
  return { show: out(sets.show), movie: out(sets.movie) };
}

/**
 * `column` is none of `ids` — ONE array parameter, which Postgres (≥ 14) hashes; a NULL column is never
 * excluded (as a NULL comparison never matched in the anti-join).
 */
function noneOf(column: SQL, ids: readonly unknown[], type: 'uuid' | 'integer' | 'text'): SQL {
  return sql`(${column} IS NULL OR ${column} <> ALL (${sql.param(ids)}::${sql.raw(type)}[]))`;
}

/**
 * D-17's library candidates: live Sonarr/Radarr items that are on Plex, with genres and ratings; SQL
 * pre-filter on kind, genre overlap and children's titles; anti-joined on the owner's Ever Watched and
 * started Title States and on every live mark (`ledgerExclusions`); best rated first, at most 600. The
 * pre-filter only ever drops titles the pure D-18 exclusions would drop too — the exclusions still run on
 * what survives.
 *
 * The anti-join takes the excluded ids as arrays, one per identifier and kind. The first cut OR-ed the four
 * identifiers inside one correlated `NOT EXISTS`, which left `kind` as the only joinable equality: Postgres
 * compared every candidate with every owner title of its kind (≈ 0.5–1 s per `recommend` at 7k ledger items
 * × 1.5k titles, before `LIMIT` could help). EXPLAIN ANALYZE on that fixture: ≈ 630 ms (OR-ed) → 38 ms (one
 * `NOT EXISTS` per identifier, 12 ms of it planning the eight joins) → 18 ms (these arrays).
 */
export async function selectLibraryCandidates(
  db: DbClient,
  opts: {
    kind: WatchKind | 'any';
    genre: string | null;
    kids: boolean;
    limit: number;
    exclusions: LedgerExclusions;
  },
): Promise<LedgerCandidate[]> {
  const arrKinds =
    opts.kind === 'show' ? ['sonarr'] : opts.kind === 'movie' ? ['radarr'] : ['sonarr', 'radarr'];
  const { show, movie } = opts.exclusions;
  const where: SQL[] = [
    inArray(mediaItems.arrKind, arrKinds as Array<'sonarr' | 'radarr'>),
    isNull(mediaItems.deletedFromArrAt),
    sql`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
    sql`(CASE WHEN ${mediaItems.arrKind} = 'sonarr' THEN ${sql.join(
      [
        noneOf(sql`${mediaItems.id}`, show.mediaItemIds, 'uuid'),
        noneOf(sql`${mediaItems.tvdbId}`, show.tvdbIds, 'integer'),
        noneOf(sql`${mediaItems.tmdbId}`, show.tmdbIds, 'integer'),
        noneOf(sql`${mediaItems.imdbId}`, show.imdbIds, 'text'),
      ],
      sql` AND `,
    )} ELSE ${sql.join(
      [
        noneOf(sql`${mediaItems.id}`, movie.mediaItemIds, 'uuid'),
        noneOf(sql`${mediaItems.tmdbId}`, movie.tmdbIds, 'integer'),
        noneOf(sql`${mediaItems.imdbId}`, movie.imdbIds, 'text'),
      ],
      sql` AND `,
    )} END)`,
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
 * title with every seed that listed it, the owner's Title States (the Taste Profile and exclusions) and
 * live marks. The Title States and marks load first: the library query is anti-joined on their ids.
 */
export async function selectRecommendInputs(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | 'any' | null; genre?: string | null; kids?: boolean; limit?: number } = {},
): Promise<RecommendInputs> {
  const kind = opts.kind ?? 'any';
  const [watchlist, seeds, titles, marks] = await Promise.all([
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
        mediaItemId: watchTitles.mediaItemId,
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
    selectLiveMarks(db, plexAccountId),
  ]);
  const signals = [...watchlist, ...seeds].filter((s) => kind === 'any' || s.kind === kind);
  const [library, ledger] = await Promise.all([
    selectLibraryCandidates(db, {
      kind,
      genre: opts.genre ?? null,
      kids: opts.kids === true,
      limit: opts.limit ?? LIBRARY_CANDIDATE_LIMIT,
      exclusions: ledgerExclusions(titles, marks),
    }),
    selectLedgerForSignals(db, signals),
  ]);

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
  return { candidates, titles, marks };
}
