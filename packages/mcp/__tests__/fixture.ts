// The @hnet/mcp end-to-end fixture (PLAN-068 S7): a recording fake Plex (read + the two watched-state
// writes, and — PLAN-071 — plex.tv's discover catalog and the owner's watchlist with its two writes — NEVER a
// real server, PLAN-068's hard rule), an owner history seeded through the @hnet/domain
// single writers only (the no-direct-state-writes guard), and a tiny node:http adapter so the SDK Client
// talks to `handleMcpRequest` over real HTTP.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { mediaItems, plexLibraries, plexServers, type Database, type PlexServerSlug } from '@hnet/db';
import {
  appendWatchEvents,
  replaceRecoSignals,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
  upsertWatchOwner,
  upsertWatchTitles,
  type WatchEventInput,
  type WatchPlexClients,
} from '@hnet/domain';
import { PlexHttpError, type PlexSectionItem } from '@hnet/plex';
import {
  computeMovieProgress,
  computeShowProgress,
  episodeObsFromLeaves,
  movieCounts,
  movieObsFromItem,
  movieProgressFields,
  parsePlexItemIds,
  plexGenres,
  showCounts,
  showProgressFields,
  titleKeyFor,
  type EventObs,
} from '@hnet/watch';
import { handleMcpRequest, type McpDeps, type McpRequestOptions } from '../src/index';

export const OWNER = 12874060;
export const NOW = new Date('2026-09-23T20:00:00Z');
export const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------------------------------
// The fake Plex

export interface FEpisode {
  ratingKey: string;
  season: number;
  episode: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

export interface FShow {
  server: PlexServerSlug;
  ratingKey: string;
  title: string;
  year: number;
  guid: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  contentRating?: string;
  episodes: FEpisode[];
}

export interface FMovie {
  server: PlexServerSlug;
  ratingKey: string;
  title: string;
  year: number;
  guid: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  duration?: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

const item = (x: Record<string, unknown>) => ({ Guid: [], Label: [], ...x }) as unknown as PlexSectionItem;
const seasonKey = (s: FShow, n: number) => `${s.ratingKey}-s${n}`;
const notFound = (key: string) => new PlexHttpError(404, 'GET', `http://fake/library/metadata/${key}`, 'not found');

/** ADR-092 — a title of plex.tv's discover catalog (24-hex id, the external ids its match resolves). */
export interface FDiscoverTitle {
  id: string;
  kind: 'movie' | 'show';
  title: string;
  year: number;
  guids: string[];
}

/**
 * Which bundle a call went out on (DESIGN-051 D-15, the first pass's test fixes): `short` — the 300 ms live-read
 * bundle (`revalidatePlex`), `write` — the mark / write bundle (`markPlex`), `discover` — the one-attempt 1.5 s
 * bundle of the catalog lookup and the re-read (`discoverPlex`, D-15ab). Recorded on the watchlist calls only.
 */
export type FakeBudget = 'short' | 'write' | 'discover';

export class FakePlex {
  readonly calls: Array<{ server: PlexServerSlug; op: string; key: string; budget?: FakeBudget }> = [];
  now = NOW_S;
  /** plex.tv's discover catalog and the owner's live watchlist (discover id → watchlistedAt). */
  readonly catalog: FDiscoverTitle[] = [];
  readonly watchlist = new Map<string, number>();
  /** Discover ids whose watchlist writes fail (a 503 after the client's retries). */
  readonly failWatchlistWrites = new Set<string>();
  /** A failed watchlist write lands anyway (plex.tv applied it, then the answer was lost). */
  landFailedWatchlistWrites = false;
  /** Bundles whose discover `userState` reads get no answer (DESIGN-051 D-15b: an outcome plex.tv never confirms). */
  readonly failUserStateReads = new Set<FakeBudget>();

  constructor(
    readonly shows: FShow[],
    readonly movies: FMovie[],
  ) {}

  writes() {
    return this.calls.filter((c) => c.op === 'scrobble' || c.op === 'unscrobble');
  }

  /** The watchlist writes, as `op:id`. */
  watchlistWrites(): string[] {
    return this.calls
      .filter((c) => c.op === 'addToWatchlist' || c.op === 'removeFromWatchlist')
      .map((c) => `${c.op}:${c.key}`);
  }

  private matchDiscover(kind: 'movie' | 'show', guid: string) {
    const hits = this.catalog.filter((t) => t.guids.includes(guid));
    const hit = hits.find((t) => t.kind === kind) ?? hits[0];
    if (!hit) return null;
    const ids = { tmdbId: null as number | null, tvdbId: null as number | null, imdbId: null as string | null };
    for (const g of hit.guids) {
      const [scheme, value = ''] = g.split('://');
      if (scheme === 'tmdb') ids.tmdbId ??= Number(value);
      if (scheme === 'tvdb') ids.tvdbId ??= Number(value);
      if (scheme === 'imdb') ids.imdbId ??= value;
    }
    return { ratingKey: hit.id, guid: `plex://${hit.kind}/${hit.id}`, kind: hit.kind, title: hit.title, year: hit.year, ids };
  }

  /** The watchlist calls as `budget:op:key`, in call order. */
  watchlistCalls(): string[] {
    return this.calls.filter((c) => c.budget !== undefined).map((c) => `${c.budget}:${c.op}:${c.key}`);
  }

  private watchlistWrite(
    server: PlexServerSlug,
    op: 'addToWatchlist' | 'removeFromWatchlist',
    id: string,
    budget: FakeBudget,
  ): Promise<void> {
    this.calls.push({ server, op, key: id, budget });
    // A write on a read bundle is a wiring bug (the swap the budget-tagged fakes of DESIGN-051 D-15's first pass guard
    // against): the short one and the discover one (D-15ab) only read.
    if (budget !== 'write') return Promise.reject(new Error(`the ${budget} bundle must never write`));
    const apply = () => {
      if (op === 'addToWatchlist') {
        if (!this.watchlist.has(id)) this.watchlist.set(id, this.now);
      } else this.watchlist.delete(id);
    };
    if (this.failWatchlistWrites.has(id)) {
      if (this.landFailedWatchlistWrites) apply();
      return Promise.reject(new PlexHttpError(503, 'PUT', `https://discover.fake/actions/${op}`, 'unavailable'));
    }
    if (!this.catalog.some((t) => t.id === id)) {
      return Promise.reject(new PlexHttpError(404, 'PUT', `https://discover.fake/actions/${op}`, 'Not Found'));
    }
    apply();
    return Promise.resolve();
  }

  showItem(s: FShow) {
    const watched = s.episodes.filter((e) => (e.viewCount ?? 0) > 0).length;
    const last = Math.max(0, ...s.episodes.map((e) => e.lastViewedAt ?? 0));
    return item({
      ratingKey: s.ratingKey,
      type: 'show',
      title: s.title,
      year: s.year,
      guid: s.guid,
      Guid: s.Guid ?? [],
      ...(s.Genre ? { Genre: s.Genre } : {}),
      ...(s.contentRating ? { contentRating: s.contentRating } : {}),
      leafCount: s.episodes.length,
      viewedLeafCount: watched,
      ...(last > 0 ? { lastViewedAt: last } : {}),
    });
  }

  movieItem(m: FMovie) {
    return item({
      ratingKey: m.ratingKey,
      type: 'movie',
      title: m.title,
      year: m.year,
      guid: m.guid,
      Guid: m.Guid ?? [],
      ...(m.Genre ? { Genre: m.Genre } : {}),
      duration: m.duration ?? 6_000_000,
      ...(m.viewCount ? { viewCount: m.viewCount } : {}),
      ...(m.lastViewedAt ? { lastViewedAt: m.lastViewedAt } : {}),
      ...(m.viewOffset ? { viewOffset: m.viewOffset } : {}),
    });
  }

  leaves(s: FShow) {
    return [...s.episodes]
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .map((e) =>
        item({
          ratingKey: e.ratingKey,
          type: 'episode',
          title: `${s.title} ${e.season}x${e.episode}`,
          index: e.episode,
          parentIndex: e.season,
          parentRatingKey: seasonKey(s, e.season),
          grandparentRatingKey: s.ratingKey,
          ...(e.viewCount ? { viewCount: e.viewCount } : {}),
          ...(e.lastViewedAt ? { lastViewedAt: e.lastViewedAt } : {}),
          ...(e.viewOffset ? { viewOffset: e.viewOffset } : {}),
        }),
      );
  }

  private covered(server: PlexServerSlug, key: string): Array<FEpisode | FMovie> {
    const m = this.movies.find((x) => x.server === server && x.ratingKey === key);
    if (m) return [m];
    for (const s of this.shows) {
      if (s.server !== server) continue;
      if (s.ratingKey === key) return s.episodes;
      const season = s.episodes.filter((e) => seasonKey(s, e.season) === key);
      if (season.length > 0) return season;
      const ep = s.episodes.find((e) => e.ratingKey === key);
      if (ep) return [ep];
    }
    return [];
  }

  private write(server: PlexServerSlug, op: 'scrobble' | 'unscrobble', key: string): Promise<void> {
    this.calls.push({ server, op, key });
    const leaves = this.covered(server, key);
    if (leaves.length === 0) return Promise.reject(notFound(key));
    for (const l of leaves) {
      if (op === 'scrobble') {
        l.viewCount = (l.viewCount ?? 0) + 1;
        l.lastViewedAt = this.now;
      } else {
        l.viewCount = 0;
        delete l.lastViewedAt;
      }
      delete l.viewOffset;
    }
    return Promise.resolve();
  }

  /** The per-server clients; `budget` tags the watchlist calls (and only the `write` bundle writes). */
  clients(budget: FakeBudget = 'write'): WatchPlexClients {
    const read: WatchPlexClients['read'] = {};
    const write: WatchPlexClients['write'] = {};
    for (const server of ['haynesops', 'haynestower', 'hayneskube'] as const) {
      read[server] = {
        getMetadataItem: async (key) => {
          this.calls.push({ server, op: 'getMetadataItem', key });
          const s = this.shows.find((x) => x.server === server && x.ratingKey === key);
          if (s) return { item: this.showItem(s), librarySectionId: '2' };
          const m = this.movies.find((x) => x.server === server && x.ratingKey === key);
          if (m) return { item: this.movieItem(m), librarySectionId: '1' };
          throw notFound(key);
        },
        listAllLeaves: async (key) => {
          this.calls.push({ server, op: 'listAllLeaves', key });
          const s = this.shows.find((x) => x.server === server && x.ratingKey === key);
          if (!s) throw notFound(key);
          const items = this.leaves(s);
          return { items, totalSize: items.length, truncated: false };
        },
        findByGuid: async (guid) => {
          this.calls.push({ server, op: 'findByGuid', key: guid });
          return [
            ...this.shows.filter((s) => s.server === server && s.guid === guid).map((s) => this.showItem(s)),
            ...this.movies.filter((m) => m.server === server && m.guid === guid).map((m) => this.movieItem(m)),
          ];
        },
        matchDiscover: async ({ kind, guid }) => {
          this.calls.push({ server, op: 'matchDiscover', key: `${kind}:${guid}`, budget });
          return this.matchDiscover(kind, guid);
        },
        getDiscoverUserState: async (id) => {
          this.calls.push({ server, op: 'getDiscoverUserState', key: id, budget });
          if (this.failUserStateReads.has(budget)) throw new Error('plex.tv did not answer in time');
          return { watchlistedAt: this.watchlist.get(id) ?? null };
        },
      };
      write[server] = {
        scrobble: (key) => this.write(server, 'scrobble', key),
        unscrobble: (key) => this.write(server, 'unscrobble', key),
        addToWatchlist: (id) => this.watchlistWrite(server, 'addToWatchlist', id, budget),
        removeFromWatchlist: (id) => this.watchlistWrite(server, 'removeFromWatchlist', id, budget),
      };
    }
    return { read, write };
  }
}

// ---------------------------------------------------------------------------------------------------
// The owner's world

function show(
  server: PlexServerSlug,
  key: string,
  title: string,
  year: number,
  opts: {
    seasons: number[];
    watched: number;
    lastViewedAt?: number;
    Guid?: Array<{ id: string }>;
    Genre?: string[];
    contentRating?: string;
  },
): FShow {
  const episodes: FEpisode[] = [];
  let n = 0;
  opts.seasons.forEach((count, i) => {
    for (let e = 1; e <= count; e += 1) {
      const watched = n < opts.watched;
      episodes.push({
        ratingKey: `${key}-${i + 1}-${e}`,
        season: i + 1,
        episode: e,
        ...(watched ? { viewCount: 1, lastViewedAt: (opts.lastViewedAt ?? NOW_S) - (opts.watched - n) * 60 } : {}),
      });
      n += 1;
    }
  });
  return {
    server,
    ratingKey: key,
    title,
    year,
    guid: `plex://show/${key}`,
    Guid: opts.Guid ?? [],
    ...(opts.Genre ? { Genre: opts.Genre.map((tag) => ({ tag })) } : {}),
    ...(opts.contentRating ? { contentRating: opts.contentRating } : {}),
    episodes,
  };
}

export function ownerWorld(): FakePlex {
  const shows: FShow[] = [
    show('haynesops', 'silo', 'Silo', 2023, {
      seasons: [10],
      watched: 7,
      lastViewedAt: NOW_S - 2 * DAY,
      Guid: [{ id: 'tvdb://403245' }, { id: 'tmdb://125988' }],
      Genre: ['Drama', 'Science Fiction'],
    }),
    show('haynestower', 'fam', 'For All Mankind', 2019, {
      seasons: [10, 10],
      watched: 13,
      lastViewedAt: NOW_S - 11 * DAY,
      Guid: [{ id: 'tvdb://356202' }],
      Genre: ['Drama', 'Science Fiction'],
    }),
    show('haynestower', 'robot', 'Mr. Robot', 2015, {
      seasons: [10, 12, 10, 13],
      watched: 20,
      lastViewedAt: NOW_S - 30 * DAY,
      Guid: [{ id: 'tvdb://289590' }],
      Genre: ['Crime', 'Drama', 'Thriller'],
    }),
    show('haynestower', 'lasso', 'Ted Lasso', 2020, {
      seasons: [10, 12, 12],
      watched: 10,
      lastViewedAt: NOW_S - 50 * DAY,
      Guid: [{ id: 'tvdb://383203' }],
      Genre: ['Comedy', 'Drama'],
    }),
    show('haynestower', 'trg', 'The Righteous Gemstones', 2019, {
      seasons: [9, 9, 9, 9, 9],
      watched: 36,
      lastViewedAt: at('2025-03-10T02:00:00Z'),
      Guid: [{ id: 'tvdb://351335' }],
      Genre: ['Comedy'],
    }),
    show('haynestower', 'exp', 'The Expanse', 2015, {
      seasons: [10, 13],
      watched: 23,
      lastViewedAt: at('2025-03-15T02:00:00Z'),
      Guid: [{ id: 'tvdb://280619' }, { id: 'tmdb://63639' }],
      Genre: ['Science Fiction', 'Drama'],
    }),
    show('haynestower', 'bb', 'Big Brother', 2000, {
      seasons: [40],
      watched: 1,
      lastViewedAt: at('2026-05-01T02:00:00Z'),
      Guid: [{ id: 'tvdb://76706' }],
      Genre: ['Reality'],
    }),
    show('haynesops', 'bluey', 'Bluey', 2018, {
      seasons: [20],
      watched: 5,
      lastViewedAt: NOW_S - DAY,
      Guid: [{ id: 'tvdb://353546' }],
      Genre: ['Animation', 'Kids'],
      contentRating: 'TV-Y',
    }),
    // On Plex, never watched: the recommendation candidates the ledger knows.
    show('haynesops', 'found', 'Foundation', 2021, {
      seasons: [10],
      watched: 0,
      Guid: [{ id: 'tvdb://366972' }, { id: 'tmdb://93740' }],
      Genre: ['Science Fiction', 'Drama'],
    }),
    show('haynestower', 'sev', 'Severance', 2022, {
      seasons: [9],
      watched: 0,
      Guid: [{ id: 'tvdb://371980' }, { id: 'tmdb://95396' }],
      Genre: ['Drama', 'Mystery', 'Science Fiction'],
    }),
  ];
  const movies: FMovie[] = [
    {
      server: 'haynesops',
      ratingKey: 'fix',
      title: 'The Fixture',
      year: 2022,
      guid: 'plex://movie/fix',
      Guid: [{ id: 'tmdb://880001' }],
      Genre: [{ tag: 'Action' }, { tag: 'Thriller' }],
      viewCount: 1,
      lastViewedAt: NOW_S - 5 * DAY,
    },
    {
      server: 'haynesops',
      ratingKey: 'run',
      title: 'Stub Runner',
      year: 2020,
      guid: 'plex://movie/run',
      Guid: [{ id: 'tmdb://880002' }],
      Genre: [{ tag: 'Science Fiction' }],
      viewOffset: 1_800_000,
      duration: 6_000_000,
      lastViewedAt: NOW_S - DAY,
    },
    { server: 'haynesops', ratingKey: 'dune21', title: 'Dune', year: 2021, guid: 'plex://movie/dune21', Guid: [{ id: 'tmdb://438631' }] },
    { server: 'haynesops', ratingKey: 'dune84', title: 'Dune', year: 1984, guid: 'plex://movie/dune84', Guid: [{ id: 'tmdb://841' }] },
    { server: 'haynestower', ratingKey: 'arr', title: 'Arrival', year: 2016, guid: 'plex://movie/arrival', Guid: [{ id: 'tmdb://329865' }] },
  ];
  const fake = new FakePlex(shows, movies);
  // plex.tv's discover catalog (ADR-092): the watchlist titles, the on-Plex library titles, a title not on Plex.
  fake.catalog.push(
    { id: DISCOVER.severance, kind: 'show', title: 'Severance', year: 2022, guids: ['tmdb://95396', 'tvdb://371980'] },
    { id: DISCOVER.darkMatter, kind: 'show', title: 'Dark Matter', year: 2024, guids: ['tmdb://203744'] },
    { id: DISCOVER.foundation, kind: 'show', title: 'Foundation', year: 2021, guids: ['tmdb://93740', 'tvdb://366972'] },
    { id: DISCOVER.arrival, kind: 'movie', title: 'Arrival', year: 2016, guids: ['tmdb://329865'] },
    { id: DISCOVER.andor, kind: 'show', title: 'Andor', year: 2022, guids: ['tmdb://83867'] },
    { id: DISCOVER.silo, kind: 'show', title: 'Silo', year: 2023, guids: ['tmdb://125988', 'tvdb://403245'] },
  );
  // The owner's live plex.tv watchlist: what the cache below was read from.
  fake.watchlist.set(DISCOVER.severance, NOW_S - 86_400);
  fake.watchlist.set(DISCOVER.darkMatter, NOW_S - 2 * 86_400);
  return fake;
}

/** Discover ids (24 hex) of the fixture's catalog titles. */
export const DISCOVER = {
  severance: '5d9c086c46115600200aa9b1',
  darkMatter: '65f1c0a2b3d4e5f601234567',
  foundation: '5d9c09e1ffd9ef001e99e1d0',
  arrival: '5d77682e880197001ec9a3c1',
  andor: '5d9c0874ffd9ef001e99607a',
  silo: '5d9c0a6c2df347001e3b1b2f',
} as const;

const HISTORY_SHOWS = ['silo', 'fam', 'robot', 'lasso', 'trg', 'exp', 'bb', 'bluey'];
const HISTORY_MOVIES = ['fix', 'run'];

function episodeEvent(rowId: number, s: FShow, e: FEpisode, startedAt: number): WatchEventInput {
  return {
    instance: s.server,
    tautulliRowId: rowId,
    kind: 'episode',
    itemGuid: `plex://episode/${e.ratingKey}`,
    showGuid: s.guid,
    title: `${s.title} ${e.season}x${e.episode}`,
    showTitle: s.title,
    season: e.season,
    episode: e.episode,
    year: s.year,
    ratingKey: e.ratingKey,
    grandparentRatingKey: s.ratingKey,
    startedAt: new Date(startedAt * 1000),
    stoppedAt: new Date((startedAt + 2_700) * 1000),
    percentComplete: 100,
    watched: true,
  };
}

/** Seed the owner, the event log, the Title States (as the sync would compute them), the ledger and signals. */
export async function seedWorld(db: Database, fake: FakePlex): Promise<void> {
  await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });

  // Events: the last three watched episodes of each history show, and the two movie plays.
  const events: WatchEventInput[] = [];
  let row = 1;
  for (const key of HISTORY_SHOWS) {
    const s = fake.shows.find((x) => x.ratingKey === key);
    if (!s) continue;
    const watched = s.episodes.filter((e) => (e.viewCount ?? 0) > 0).slice(-3);
    for (const e of watched) events.push(episodeEvent(row++, s, e, (e.lastViewedAt ?? NOW_S) - 2_700));
  }
  for (const key of HISTORY_MOVIES) {
    const m = fake.movies.find((x) => x.ratingKey === key);
    if (!m) continue;
    events.push({
      instance: m.server,
      tautulliRowId: row++,
      kind: 'movie',
      itemGuid: m.guid,
      showGuid: null,
      title: m.title,
      showTitle: null,
      season: null,
      episode: null,
      year: m.year,
      ratingKey: m.ratingKey,
      grandparentRatingKey: null,
      startedAt: new Date(((m.lastViewedAt ?? NOW_S) - 6_000) * 1000),
      stoppedAt: new Date((m.lastViewedAt ?? NOW_S) * 1000),
      percentComplete: m.viewCount ? 100 : 30,
      watched: Boolean(m.viewCount),
    });
  }
  await appendWatchEvents({ db, plexAccountId: OWNER, events });

  // Title States, computed from the fake exactly as the `watch` sync would.
  const evObs = (guid: string): EventObs[] =>
    events
      .filter((e) => e.showGuid === guid || e.itemGuid === guid)
      .map((e) => ({
        season: e.season,
        episode: e.episode,
        watched: e.watched,
        startedAt: Math.floor(e.startedAt.getTime() / 1000),
        stoppedAt: e.stoppedAt ? Math.floor(e.stoppedAt.getTime() / 1000) : null,
      }));
  const titles = [];
  for (const key of HISTORY_SHOWS) {
    const s = fake.shows.find((x) => x.ratingKey === key);
    if (!s) continue;
    const meta = fake.showItem(s);
    const ids = parsePlexItemIds(meta);
    const genres = plexGenres(meta);
    const p = computeShowProgress([{ server: s.server, episodes: episodeObsFromLeaves(fake.leaves(s)) }], evObs(s.guid));
    titles.push({
      kind: 'show' as const,
      titleKey: titleKeyFor({ kind: 'show', title: s.title, year: s.year, ...ids }),
      plexGuid: ids.plexGuid,
      tmdbId: ids.tmdbId,
      tvdbId: ids.tvdbId,
      imdbId: ids.imdbId,
      mediaItemId: null,
      title: s.title,
      year: s.year,
      genres,
      contentRating: s.contentRating ?? null,
      isKids: s.contentRating === 'TV-Y',
      onPlex: [{ server: s.server, ratingKey: s.ratingKey, local: false }],
      plexCounts: { [s.server]: showCounts(meta) },
      showStatus: key === 'exp' ? ('ended' as const) : ('continuing' as const),
      ...showProgressFields(p),
    });
  }
  for (const key of HISTORY_MOVIES) {
    const m = fake.movies.find((x) => x.ratingKey === key);
    if (!m) continue;
    const meta = fake.movieItem(m);
    const ids = parsePlexItemIds(meta);
    const obs = movieObsFromItem(m.server, meta);
    titles.push({
      kind: 'movie' as const,
      titleKey: titleKeyFor({ kind: 'movie', title: m.title, year: m.year, ...ids }),
      plexGuid: ids.plexGuid,
      tmdbId: ids.tmdbId,
      tvdbId: null,
      imdbId: ids.imdbId,
      mediaItemId: null,
      title: m.title,
      year: m.year,
      genres: plexGenres(meta),
      contentRating: null,
      isKids: false,
      onPlex: [{ server: m.server, ratingKey: m.ratingKey, local: false }],
      plexCounts: { [m.server]: movieCounts(obs) },
      showStatus: null,
      ...movieProgressFields(computeMovieProgress([obs], evObs(m.guid)), [obs]),
    });
  }
  await upsertWatchTitles({ db, plexAccountId: OWNER, titles, now: NOW });

  // The *arr ledger (the recommendation library) with its Plex matches, genres and ratings.
  const base = { monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', onDiskFileCount: 1, expectedFileCount: 1, sizeOnDisk: 1 };
  await upsertMediaItemsBatch({
    db,
    arrKind: 'sonarr',
    items: [
      { ...base, arrItemId: 1, tvdbId: 366972, tmdbId: 93740, title: 'Foundation', sortTitle: 'foundation', year: 2021, rootFolder: '/tv' },
      { ...base, arrItemId: 2, tvdbId: 371980, tmdbId: 95396, title: 'Severance', sortTitle: 'severance', year: 2022, rootFolder: '/tv' },
      { ...base, arrItemId: 3, tvdbId: 403245, tmdbId: 125988, title: 'Silo', sortTitle: 'silo', year: 2023, rootFolder: '/tv' },
      { ...base, arrItemId: 4, tvdbId: 272472, title: 'Paw Patrol', sortTitle: 'paw patrol', year: 2013, rootFolder: '/tv' },
    ],
  });
  await upsertMediaItemsBatch({
    db,
    arrKind: 'radarr',
    items: [
      { ...base, arrItemId: 11, tmdbId: 438631, title: 'Dune', sortTitle: 'dune', year: 2021, rootFolder: '/movies' },
      { ...base, arrItemId: 12, tmdbId: 841, title: 'Dune', sortTitle: 'dune', year: 1984, rootFolder: '/movies' },
      { ...base, arrItemId: 13, tmdbId: 329865, title: 'Arrival', sortTitle: 'arrival', year: 2016, rootFolder: '/movies' },
      { ...base, arrItemId: 14, tmdbId: 880001, title: 'The Fixture', sortTitle: 'fixture', year: 2022, rootFolder: '/movies' },
    ],
  });
  const ledger = await db.select().from(mediaItems);
  const idOf = (title: string, year: number) => ledger.find((m) => m.title === title && m.year === year)?.id as string;
  const meta: Array<[string, number, string[], number]> = [
    ['Foundation', 2021, ['Science Fiction', 'Drama'], 7.5],
    ['Severance', 2022, ['Drama', 'Mystery', 'Science Fiction'], 8.7],
    ['Silo', 2023, ['Drama', 'Science Fiction'], 8.1],
    ['Paw Patrol', 2013, ['Animation', 'Children'], 6.2],
    ['Dune', 2021, ['Science Fiction', 'Adventure'], 8.0],
    ['Dune', 1984, ['Science Fiction'], 6.3],
    ['Arrival', 2016, ['Science Fiction', 'Drama'], 7.9],
    ['The Fixture', 2022, ['Action', 'Thriller'], 6.8],
  ];
  await upsertMediaMetadataBatch({
    db,
    rows: meta.map(([t, y, genres, imdbRating]) => ({ mediaItemId: idOf(t, y), genres, imdbRating })),
  });
  for (const slug of ['haynesops', 'haynestower'] as const) {
    await upsertPlexLibraries({
      db,
      slug,
      libraries: [
        { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'TV', mediaType: 'show' },
      ],
    });
  }
  const lib = async (slug: PlexServerSlug, section: string) => {
    const [r] = await db
      .select({ id: plexLibraries.id })
      .from(plexLibraries)
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .where(and(eq(plexServers.slug, slug), eq(plexLibraries.sectionKey, section)));
    return r?.id as string;
  };
  const matches: Array<[string, number, PlexServerSlug, string, string]> = [
    ['Foundation', 2021, 'haynesops', '2', 'found'],
    ['Severance', 2022, 'haynestower', '2', 'sev'],
    ['Silo', 2023, 'haynesops', '2', 'silo'],
    ['Paw Patrol', 2013, 'haynesops', '2', 'paw'],
    ['Dune', 2021, 'haynesops', '1', 'dune21'],
    ['Dune', 1984, 'haynesops', '1', 'dune84'],
    ['Arrival', 2016, 'haynestower', '1', 'arr'],
    ['The Fixture', 2022, 'haynesops', '1', 'fix'],
  ];
  await syncPlexMatches({
    db,
    matches: await Promise.all(
      matches.map(async ([t, y, slug, section, ratingKey]) => ({
        mediaItemId: idOf(t, y),
        plexLibraryId: await lib(slug, section),
        ratingKey,
        matchedVia: 'tmdb' as const,
      })),
    ),
    scopedLibraryIds: [],
    now: new Date(NOW.getTime() - 60 * DAY * 1000),
  });

  // The watchlist and one TMDB seed (The Expanse recommends Foundation and Andor).
  const none = { tvdbId: null, imdbId: null, plexGuid: null };
  await replaceRecoSignals({
    db,
    plexAccountId: OWNER,
    source: 'watchlist',
    rows: [
      { ...none, kind: 'show', title: 'Severance', year: 2022, tmdbId: 95396, tvdbId: 371980, rank: 0 },
      { ...none, kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744, plexGuid: `plex://show/${DISCOVER.darkMatter}`, rank: 1 },
    ],
    fetchedAt: NOW,
  });
  const expanseKey = titleKeyFor({ kind: 'show', title: 'The Expanse', year: 2015, plexGuid: 'plex://show/exp', tvdbId: 280619, tmdbId: 63639 });
  await replaceRecoSignals({
    db,
    plexAccountId: OWNER,
    source: 'tmdb_seed',
    rows: [
      { ...none, kind: 'show', title: 'Foundation', year: 2021, tmdbId: 93740, seedTitleKey: expanseKey, seedTitle: 'The Expanse', rank: 0 },
      { ...none, kind: 'show', title: 'Andor', year: 2022, tmdbId: 83867, seedTitleKey: expanseKey, seedTitle: 'The Expanse', rank: 1 },
    ],
    fetchedAt: NOW,
  });
}

// ---------------------------------------------------------------------------------------------------
// The HTTP adapter

export interface McpHttp {
  url: string;
  logs: string[];
  stop: () => Promise<void>;
}

function headersOf(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  }
  return out;
}

/** Serve `handleMcpRequest` on a free port (the Next route's job, minus Next). */
export async function serveMcp(
  deps: McpDeps,
  env: Record<string, string | undefined>,
  opts: Pick<McpRequestOptions, 'deadlineMs' | 'authenticate'> & { path?: string } = {},
): Promise<McpHttp> {
  const logs: string[] = [];
  const withLogs: McpDeps = { ...deps, log: (line) => logs.push(line) };
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const method = req.method ?? 'GET';
      const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method,
        headers: headersOf(req.headers),
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
      });
      const { path: _path, ...handlerOpts } = opts;
      const response = await handleMcpRequest(request, { deps: withLogs, env, ...handlerOpts });
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}${opts.path ?? '/api/mcp'}`,
    logs,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
