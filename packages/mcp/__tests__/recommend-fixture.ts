// A ledger + owner-history fixture for the D-17 library query (`selectLibraryCandidates`), seeded through
// the @hnet/domain single writers only (the no-direct-state-writes guard). Deterministic at any size: the
// Sonarr/Radarr ledger (on Plex or not, genres incl. children's, ratings), the owner's Title States linked to
// ledger items through exactly ONE identifier each (ledger link, TVDB, TMDB or IMDb) or all of them, in every
// "started or watched" flavour and untouched, some of the wrong kind, and live and reverted marks — plus
// ledger items that share a single identifier with a marked title, and cross-kind id collisions. `PROBES`
// names hand-made cases with a known answer.
import { and, eq } from 'drizzle-orm';
import { mediaItems, plexLibraries, plexServers, type Database } from '@hnet/db';
import {
  dismissTitle,
  syncPlexMatches,
  undoLastChange,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
  upsertWatchOwner,
  upsertWatchTitles,
  type MediaItemSyncFields,
  type WatchTitleWrite,
} from '@hnet/domain';
import { titleKeyFor, type WatchKind } from '@hnet/watch';

export const SCALE_OWNER = 42_424_242;
const NOW = new Date('2026-09-23T20:00:00Z');
const ACTOR = { plexAccountId: SCALE_OWNER, appUserId: null };
const CHUNK = 500;

export interface RecommendScale {
  shows: number;
  movies: number;
  /** Owner Title States (linked to ledger items as the `mode` / `state` cycles say). */
  titles: number;
  /** Ledger items dismissed through `dismissTitle` (every fifth one reverted again). */
  marks: number;
}

/** The ids each probe must (not) come back with — keyed by ledger title. */
export const PROBES = {
  excluded: [
    'Probe Link Only',
    'Probe Tvdb Only',
    'Probe Tmdb Only',
    'Probe Imdb Only',
    'Probe Movie Tmdb Only',
    'Probe Movie Link Only',
    'Probe Mark Tvdb Only',
    'Probe Mark Tmdb Only',
    'Probe Mark Imdb Only',
  ],
  included: [
    'Probe Untouched',
    'Probe Title Of Other Kind',
    'Probe Movie Tvdb',
    'Probe Mark Other Kind',
    'Probe Reverted',
  ],
} as const;

type Item = MediaItemSyncFields & { kind: 'sonarr' | 'radarr'; instance: string; genres: string[]; rating: number | null; onPlex: boolean };

const base = { monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', onDiskFileCount: 1, expectedFileCount: 1, sizeOnDisk: 1 };

function show(instance: string, arrItemId: number, title: string, ids: { tvdbId: number; tmdbId?: number | null; imdbId?: string | null }, extra: Partial<Item> = {}): Item {
  return { ...base, kind: 'sonarr', instance, arrItemId, title, sortTitle: title.toLowerCase(), year: 2010, rootFolder: '/tv', tmdbId: null, imdbId: null, genres: ['Drama'], rating: 7, onPlex: true, ...ids, ...extra };
}

function movie(instance: string, arrItemId: number, title: string, ids: { tmdbId: number; tvdbId?: number | null; imdbId?: string | null }, extra: Partial<Item> = {}): Item {
  return { ...base, kind: 'radarr', instance, arrItemId, title, sortTitle: title.toLowerCase(), year: 2012, rootFolder: '/movies', tvdbId: null, imdbId: null, genres: ['Drama'], rating: 7, onPlex: true, ...ids, ...extra };
}

const GENRES = [['Drama'], ['Comedy'], ['Science Fiction', 'Drama'], ['Sci-Fi & Fantasy'], ['Action', 'Thriller'], ['Documentary'], ['Crime', 'Mystery']];

function ledger(scale: RecommendScale): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < scale.shows; i += 1) {
    items.push(
      show('main', i + 1, `Show ${i}`, {
        tvdbId: 100_000 + i,
        tmdbId: i % 10 < 7 ? 300_000 + i : null,
        imdbId: i % 10 < 6 ? `tt${1_000_000 + i}` : null,
      }, {
        year: 1990 + (i % 35),
        genres: i % 23 === 0 ? ['Kids', 'Animation'] : i % 29 === 0 ? ['Animation', 'Family'] : (GENRES[i % GENRES.length] ?? []),
        rating: i % 17 === 0 ? null : 5 + ((i * 37) % 50) / 10,
        onPlex: i % 10 !== 9,
      }),
    );
  }
  for (let j = 0; j < scale.movies; j += 1) {
    items.push(
      movie('main', j + 1, `Movie ${j}`, {
        // Every 50th movie shares its TMDB number with a show (TV and movie ids are separate namespaces),
        // every 97th its IMDb id: neither may exclude across kinds.
        tmdbId: j % 50 === 0 && j < scale.shows && j % 10 < 7 ? 300_000 + j : 600_000 + j,
        imdbId: j % 97 === 0 && j < scale.shows ? `tt${1_000_000 + j}` : j % 10 < 7 ? `tt${2_000_000 + j}` : null,
      }, {
        year: 1980 + (j % 45),
        genres: j % 31 === 0 ? ['Children', 'Family'] : (GENRES[(j + 3) % GENRES.length] ?? []),
        rating: j % 13 === 0 ? null : 4 + ((j * 53) % 60) / 10,
        onPlex: j % 8 !== 7,
      }),
    );
  }
  return items;
}

async function writeLedger(db: Database, items: readonly Item[], libs: { show: string; movie: string }): Promise<void> {
  for (const kind of ['sonarr', 'radarr'] as const) {
    const byInstance = new Map<string, Item[]>();
    for (const it of items) if (it.kind === kind) byInstance.set(it.instance, [...(byInstance.get(it.instance) ?? []), it]);
    for (const [instance, list] of byInstance) {
      for (let i = 0; i < list.length; i += CHUNK) {
        await upsertMediaItemsBatch({ db, arrKind: kind, arrInstanceId: instance, items: list.slice(i, i + CHUNK) });
      }
    }
  }
  const rows = await db.select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrInstanceId: mediaItems.arrInstanceId, arrItemId: mediaItems.arrItemId }).from(mediaItems);
  const idOf = new Map(rows.map((r) => [`${r.arrKind}|${r.arrInstanceId}|${r.arrItemId}`, r.id]));
  const withIds = items.map((it) => ({ it, id: idOf.get(`${it.kind}|${it.instance}|${it.arrItemId}`) as string }));
  for (let i = 0; i < withIds.length; i += CHUNK) {
    const chunk = withIds.slice(i, i + CHUNK);
    await upsertMediaMetadataBatch({ db, rows: chunk.map(({ it, id }) => ({ mediaItemId: id, genres: it.genres, imdbRating: it.rating })) });
    await syncPlexMatches({
      db,
      matches: chunk
        .filter(({ it }) => it.onPlex)
        .map(({ it, id }) => ({ mediaItemId: id, plexLibraryId: it.kind === 'sonarr' ? libs.show : libs.movie, ratingKey: `rk-${id}`, matchedVia: 'tmdb' as const })),
      scopedLibraryIds: [],
      now: NOW,
    });
  }
}

type State = 'watched' | 'plex_watched' | 'event' | 'resume' | 'percent' | 'untouched';

function progress(kind: WatchKind, state: State): Omit<WatchTitleWrite, 'kind' | 'titleKey' | 'plexGuid' | 'tmdbId' | 'tvdbId' | 'imdbId' | 'mediaItemId' | 'title' | 'year' | 'genres' | 'contentRating' | 'isKids' | 'onPlex' | 'plexCounts' | 'showStatus'> {
  return {
    episodeMap: null,
    episodesTotal: kind === 'show' ? 10 : null,
    episodesWatched: kind === 'show' ? (state === 'watched' ? 4 : 0) : null,
    furthestSeason: null,
    furthestEpisode: null,
    nextSeason: null,
    nextEpisode: null,
    nextTitle: null,
    nextServer: null,
    nextRatingKey: null,
    nextResume: state === 'resume',
    resumePercent: state === 'percent' ? 35 : null,
    plexWatched: state === 'plex_watched',
    plexLastViewedAt: null,
    eventPlays: state === 'event' ? 2 : 0,
    eventWatchedEpisodes: state === 'event' ? 1 : 0,
    firstWatchedAt: null,
    lastWatchedAt: state === 'untouched' ? null : NOW,
    rewatch: false,
  };
}

function title(
  n: number,
  kind: WatchKind,
  state: State,
  ids: { mediaItemId?: string | null; tvdbId?: number | null; tmdbId?: number | null; imdbId?: string | null },
): WatchTitleWrite {
  const t = {
    kind,
    title: `Owner Title ${n}`,
    year: 2000 + (n % 20),
    plexGuid: null,
    // Unique, never-matching ids unless the case sets one.
    tvdbId: kind === 'show' ? 900_000 + n : null,
    tmdbId: 950_000 + n,
    imdbId: `tt${9_000_000 + n}`,
    mediaItemId: null,
    ...ids,
  };
  return {
    ...t,
    titleKey: titleKeyFor(t),
    genres: ['Drama'],
    contentRating: null,
    isKids: false,
    onPlex: [],
    plexCounts: {},
    showStatus: null,
    ...progress(kind, state),
  };
}

const MODES = ['link', 'tvdb', 'tmdb', 'imdb', 'all', 'other_kind', 'none'] as const;
const STATES: State[] = ['watched', 'plex_watched', 'event', 'resume', 'percent', 'untouched'];

async function writeTitles(db: Database, titles: WatchTitleWrite[]): Promise<void> {
  for (let i = 0; i < titles.length; i += CHUNK) {
    const report = await upsertWatchTitles({ db, plexAccountId: SCALE_OWNER, titles: titles.slice(i, i + CHUNK), now: NOW });
    if (report.conflicts > 0) throw new Error(`fixture titles merged (${report.conflicts} conflicts)`);
  }
}

async function libraries(db: Database): Promise<{ show: string; movie: string }> {
  await upsertPlexLibraries({
    db,
    slug: 'haynesops',
    libraries: [
      { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
      { sectionKey: '2', name: 'TV', mediaType: 'show' },
    ],
  });
  const lib = async (section: string) => {
    const [r] = await db
      .select({ id: plexLibraries.id })
      .from(plexLibraries)
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .where(and(eq(plexServers.slug, 'haynesops'), eq(plexLibraries.sectionKey, section)));
    return r?.id as string;
  };
  return { show: await lib('2'), movie: await lib('1') };
}

async function dismiss(db: Database, query: string, i: number): Promise<void> {
  const out = await dismissTitle({ db, actor: ACTOR, consumer: 'fixture', query, reason: i % 2 === 0 ? 'not_interested' : 'not_mine', now: new Date(NOW.getTime() + i * 1_000) });
  if (out.status !== 'done') throw new Error(`fixture dismiss of ${query}: ${out.status}`);
}

async function undo(db: Database, i: number): Promise<void> {
  const out = await undoLastChange({ db, plex: { read: {}, write: {} }, actor: ACTOR, now: new Date(NOW.getTime() + i * 1_000 + 500) });
  if (out.status !== 'done') throw new Error(`fixture undo: ${out.status}`);
}

/** Seed the owner, the ledger, the Title States, the marks and the probes. */
export async function seedRecommendScale(db: Database, scale: RecommendScale): Promise<void> {
  await upsertWatchOwner({ db, account: { id: String(SCALE_OWNER), username: 'scaleowner', email: null }, now: NOW });
  const libs = await libraries(db);
  const items = ledger(scale);
  await writeLedger(db, items, libs);
  const rows = await db.select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId }).from(mediaItems);
  const idOf = new Map(rows.map((r) => [`${r.arrKind}|${r.arrItemId}`, r.id]));

  // Owner Title States, each linked to a ledger item through the mode's identifier(s) — a distinct item each
  // (a stride coprime with the ledger size), so no two titles share an identity key and merge.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let stride = 7;
  while (gcd(stride, items.length) !== 1) stride += 2;
  if (scale.titles > items.length) throw new Error('fixture: more titles than ledger items');
  const titles: WatchTitleWrite[] = [];
  for (let n = 0; n < scale.titles; n += 1) {
    const target = items[(n * stride) % items.length];
    if (!target) continue;
    const kind: WatchKind = target.kind === 'sonarr' ? 'show' : 'movie';
    const mode = MODES[n % MODES.length] ?? 'none';
    const state = STATES[Math.floor(n / MODES.length) % STATES.length] ?? 'untouched';
    const id = idOf.get(`${target.kind}|${target.arrItemId}`) ?? null;
    const ids =
      mode === 'link' ? { mediaItemId: id }
      : mode === 'tvdb' ? { tvdbId: target.tvdbId ?? null }
      : mode === 'tmdb' ? { tmdbId: target.tmdbId ?? null }
      : mode === 'imdb' ? { imdbId: target.imdbId ?? null }
      : mode === 'all' ? { mediaItemId: id, tvdbId: kind === 'show' ? (target.tvdbId ?? null) : null, tmdbId: target.tmdbId ?? null, imdbId: target.imdbId ?? null }
      : mode === 'other_kind' ? { tmdbId: target.tmdbId ?? null, imdbId: target.imdbId ?? null, tvdbId: null }
      : {};
    titles.push(title(n, mode === 'other_kind' ? (kind === 'show' ? 'movie' : 'show') : kind, state, ids));
  }
  await writeTitles(db, titles);

  // Marks: dismissals of ledger titles (every fifth undone again, so it must no longer exclude).
  for (let m = 0; m < scale.marks; m += 1) {
    const target = items[(m * 13 + 5) % items.length];
    if (!target) continue;
    await dismiss(db, target.title, m);
    if (m % 5 === 4) await undo(db, m);
  }

  await seedProbes(db, libs, scale);
}

/** The hand-made cases (`PROBES`): each excluded through one identifier only, or deliberately not. */
async function seedProbes(db: Database, libs: { show: string; movie: string }, scale: RecommendScale): Promise<void> {
  const at = 10_000 + scale.shows + scale.movies;
  // Mark sources first — the probes that share one identifier with them come after the marks, so the
  // resolver cannot fold them into the marked title.
  const markSource = show('probe', at + 1, 'Probe Mark Source', { tvdbId: 870_001, tmdbId: 870_101, imdbId: 'tt8700001' });
  const reverted = show('probe', at + 2, 'Probe Reverted', { tvdbId: 870_002, tmdbId: 870_102, imdbId: 'tt8700002' });
  await writeLedger(db, [markSource, reverted], libs);
  await dismiss(db, 'Probe Mark Source', 900);
  await dismiss(db, 'Probe Reverted', 901);
  await undo(db, 901);

  const probes: Item[] = [
    show('probe', at + 10, 'Probe Link Only', { tvdbId: 880_010, tmdbId: 880_110, imdbId: 'tt8800010' }),
    show('probe', at + 11, 'Probe Tvdb Only', { tvdbId: 880_011 }),
    show('probe', at + 12, 'Probe Tmdb Only', { tvdbId: 880_012, tmdbId: 880_112 }),
    show('probe', at + 13, 'Probe Imdb Only', { tvdbId: 880_013, imdbId: 'tt8800013' }),
    show('probe', at + 14, 'Probe Untouched', { tvdbId: 880_014 }),
    show('probe', at + 15, 'Probe Title Of Other Kind', { tvdbId: 880_015, tmdbId: 880_115 }),
    movie('probe', at + 20, 'Probe Movie Tmdb Only', { tmdbId: 880_120 }),
    movie('probe', at + 21, 'Probe Movie Link Only', { tmdbId: 880_121 }),
    // A Radarr item with a TVDB id: TVDB matches shows only.
    movie('probe', at + 22, 'Probe Movie Tvdb', { tmdbId: 880_122, tvdbId: 880_922 }),
    // One identifier shared with the marked "Probe Mark Source" each (another *arr instance, so the ledger
    // writer does not take them for the same series).
    show('probe-b', at + 30, 'Probe Mark Tvdb Only', { tvdbId: 870_001 }),
    show('probe-c', at + 31, 'Probe Mark Tmdb Only', { tvdbId: 870_031, tmdbId: 870_101 }),
    show('probe-c', at + 32, 'Probe Mark Imdb Only', { tvdbId: 870_032, imdbId: 'tt8700001' }),
    movie('probe', at + 33, 'Probe Mark Other Kind', { tmdbId: 870_101 }),
  ];
  await writeLedger(db, probes, libs);
  const rows = await db.select({ id: mediaItems.id, title: mediaItems.title }).from(mediaItems);
  const id = (t: string) => rows.find((r) => r.title === t)?.id as string;
  const n = 100_000;
  await writeTitles(db, [
    title(n + 1, 'show', 'watched', { mediaItemId: id('Probe Link Only') }),
    title(n + 2, 'show', 'event', { tvdbId: 880_011 }),
    title(n + 3, 'show', 'resume', { tmdbId: 880_112 }),
    title(n + 4, 'show', 'watched', { imdbId: 'tt8800013' }),
    title(n + 5, 'show', 'untouched', { tvdbId: 880_014, mediaItemId: id('Probe Untouched') }),
    title(n + 6, 'movie', 'plex_watched', { tmdbId: 880_115 }),
    title(n + 7, 'movie', 'plex_watched', { tmdbId: 880_120 }),
    title(n + 8, 'movie', 'percent', { mediaItemId: id('Probe Movie Link Only') }),
    title(n + 9, 'movie', 'plex_watched', { tvdbId: 880_922 }),
  ]);
}
