// A recording fake of the Plex surface the Watch Companion flows use (DESIGN-049 D-11/D-14/D-15): per-server
// shows (with seasons and episodes, specials included) and movies, the owner's watched state, and the two
// watched-state writes; and (ADR-092 / DESIGN-051) plex.tv's discover catalog, the owner's watchlist and its two
// writes, recorded like the rest. Like a real PMS, scrobbling a show or season key flips every leaf under it,
// unscrobbling clears resume points too, and a ratingKey answers only on its own server (a mix-up 404s).
// PLAN-068 hard rule: nothing in the Watch Companion work orders scrobbles a REAL server — only this fake
// and the e2e stub.
import { PlexHttpError, PlexTimeoutError, type PlexSectionItem } from '@hnet/plex';
import type { PlexServerSlug } from '@hnet/db';
import type { WatchPlexClients } from '../src/watch/plex';

export interface FakeEpisode {
  ratingKey: string;
  season: number;
  episode: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

export interface FakeShow {
  server: PlexServerSlug;
  ratingKey: string;
  title: string;
  year: number;
  guid: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  contentRating?: string;
  episodes: FakeEpisode[];
}

export interface FakeMovie {
  server: PlexServerSlug;
  ratingKey: string;
  title: string;
  year: number;
  guid: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  contentRating?: string;
  duration?: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

export interface FakeCall {
  server: PlexServerSlug;
  op:
    | 'scrobble'
    | 'unscrobble'
    | 'getMetadataItem'
    | 'listAllLeaves'
    | 'findByGuid'
    | 'matchDiscover'
    | 'getDiscoverUserState'
    | 'addToWatchlist'
    | 'removeFromWatchlist';
  key: string;
}

/**
 * ADR-092 / DESIGN-051 — a title of plex.tv's discover catalog: its 24-hex discover id and the external ids
 * `library/metadata/matches` resolves (`tmdb://…`, `tvdb://…`, `imdb://…`).
 */
export interface FakeDiscoverTitle {
  id: string;
  kind: 'movie' | 'show';
  title: string;
  year: number;
  guids: string[];
}

const seasonKey = (show: FakeShow, season: number) => `${show.ratingKey}-s${season}`;

function notFound(server: string, key: string): PlexHttpError {
  return new PlexHttpError(404, 'GET', `http://${server}.fake/library/metadata/${key}`, 'not found');
}

export class FakePlex {
  readonly calls: FakeCall[] = [];
  /** `${server}:${ratingKey}` of writes that fail (a 503 after retries). */
  readonly failWrites = new Set<string>();
  /** `${server}:${op}` reads that fail. */
  readonly failReads = new Set<string>();
  /** Delay every read by this many ms (revalidation budget tests). */
  readDelayMs = 0;
  /**
   * When set, every `allLeaves` answers only its first N leaves flagged `truncated` — a listing that ran
   * past the client's page cap (the real client's `truncated` flag).
   */
  truncateLeavesAt: number | null = null;
  now = 1_790_000_000;
  /** plex.tv's discover catalog (the external-id match) and the owner's watchlist: discover id → watchlistedAt. */
  readonly catalog: FakeDiscoverTitle[] = [];
  readonly watchlist = new Map<string, number>();
  /** Discover ids whose watchlist writes fail with a 503 (after the client's retries), and whether they land anyway. */
  readonly failWatchlistWrites = new Set<string>();
  landFailedWatchlistWrites = false;
  /**
   * How those writes fail: a 503 (plex.tv answered every attempt), a 429 (a definitive refusal, never re-read) or a
   * client-side timeout (the attempt went out and may still land, DESIGN-051 D-15n).
   */
  failWatchlistWritesWith: 503 | 429 | 'timeout' = 503;
  /** Discover reads that fail (`matchDiscover`, `getDiscoverUserState`). */
  readonly failDiscoverReads = new Set<'matchDiscover' | 'getDiscoverUserState'>();

  constructor(
    readonly shows: FakeShow[] = [],
    readonly movies: FakeMovie[] = [],
  ) {}

  writes(): FakeCall[] {
    return this.calls.filter((c) => c.op === 'scrobble' || c.op === 'unscrobble');
  }

  /** The watchlist writes, as `op:id`, in call order. */
  watchlistWrites(): string[] {
    return this.calls
      .filter((c) => c.op === 'addToWatchlist' || c.op === 'removeFromWatchlist')
      .map((c) => `${c.op}:${c.key}`);
  }

  /** Every Plex call of any kind (reads and writes), as `op:key`. */
  opKeys(): string[] {
    return this.calls.map((c) => `${c.op}:${c.key}`);
  }

  private discoverRead<T>(server: PlexServerSlug, op: 'matchDiscover' | 'getDiscoverUserState', key: string, fn: () => T): Promise<T> {
    this.calls.push({ server, op, key });
    if (this.failDiscoverReads.has(op)) {
      return Promise.reject(new PlexHttpError(503, 'GET', `https://discover.fake/${op}`, 'unavailable'));
    }
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private watchlistWrite(server: PlexServerSlug, op: 'addToWatchlist' | 'removeFromWatchlist', id: string): Promise<void> {
    if (!/^[0-9a-f]{24}$/.test(id)) return Promise.reject(new TypeError('not a discover id'));
    this.calls.push({ server, op, key: id });
    const apply = () => {
      if (op === 'addToWatchlist') {
        if (!this.watchlist.has(id)) this.watchlist.set(id, this.now);
      } else this.watchlist.delete(id);
    };
    if (this.failWatchlistWrites.has(id)) {
      if (this.landFailedWatchlistWrites) apply();
      const url = `https://discover.fake/actions/${op}`;
      const how = this.failWatchlistWritesWith;
      return Promise.reject(
        how === 'timeout'
          ? new PlexTimeoutError('PUT', url, 800)
          : new PlexHttpError(how, 'PUT', url, how === 429 ? 'Too Many Requests' : 'unavailable'),
      );
    }
    if (!this.catalog.some((t) => t.id === id)) {
      return Promise.reject(new PlexHttpError(404, 'PUT', `https://discover.fake/actions/${op}`, 'Not Found'));
    }
    apply();
    return Promise.resolve();
  }

  /** The (server, ratingKey) of every watched leaf, sorted — the state an undo must restore. */
  watchedState(): string[] {
    const out: string[] = [];
    for (const s of this.shows)
      for (const e of s.episodes) if ((e.viewCount ?? 0) > 0) out.push(`${s.server}:${e.ratingKey}`);
    for (const m of this.movies) if ((m.viewCount ?? 0) > 0) out.push(`${m.server}:${m.ratingKey}`);
    return out.sort();
  }

  private showOn(server: PlexServerSlug, key: string): FakeShow | undefined {
    return this.shows.find((s) => s.server === server && s.ratingKey === key);
  }

  /** Every leaf a key covers on a server: a show, a season, an episode or a movie. */
  private leavesFor(server: PlexServerSlug, key: string): Array<FakeEpisode | FakeMovie> {
    const movie = this.movies.find((m) => m.server === server && m.ratingKey === key);
    if (movie) return [movie];
    for (const s of this.shows) {
      if (s.server !== server) continue;
      if (s.ratingKey === key) return s.episodes;
      const inSeason = s.episodes.filter((e) => seasonKey(s, e.season) === key);
      if (inSeason.length > 0) return inSeason;
      const ep = s.episodes.find((e) => e.ratingKey === key);
      if (ep) return [ep];
    }
    return [];
  }

  private leafItem(show: FakeShow, e: FakeEpisode): PlexSectionItem {
    return {
      ratingKey: e.ratingKey,
      type: 'episode',
      title: `${show.title} ${e.season}x${e.episode}`,
      index: e.episode,
      parentIndex: e.season,
      parentRatingKey: seasonKey(show, e.season),
      grandparentRatingKey: show.ratingKey,
      grandparentTitle: show.title,
      grandparentGuid: show.guid,
      guid: `plex://episode/${e.ratingKey}`,
      Guid: [],
      Label: [],
      ...(e.viewCount ? { viewCount: e.viewCount } : {}),
      ...(e.lastViewedAt ? { lastViewedAt: e.lastViewedAt } : {}),
      ...(e.viewOffset ? { viewOffset: e.viewOffset } : {}),
    };
  }

  private showItem(show: FakeShow): PlexSectionItem {
    const watched = show.episodes.filter((e) => (e.viewCount ?? 0) > 0);
    const last = Math.max(0, ...show.episodes.map((e) => e.lastViewedAt ?? 0));
    return {
      ratingKey: show.ratingKey,
      type: 'show',
      title: show.title,
      year: show.year,
      guid: show.guid,
      Guid: show.Guid ?? [],
      Label: [],
      ...(show.Genre ? { Genre: show.Genre } : {}),
      ...(show.contentRating ? { contentRating: show.contentRating } : {}),
      leafCount: show.episodes.length,
      viewedLeafCount: watched.length,
      ...(last > 0 ? { lastViewedAt: last } : {}),
    };
  }

  private movieItem(m: FakeMovie): PlexSectionItem {
    return {
      ratingKey: m.ratingKey,
      type: 'movie',
      title: m.title,
      year: m.year,
      guid: m.guid,
      Guid: m.Guid ?? [],
      Label: [],
      ...(m.Genre ? { Genre: m.Genre } : {}),
      ...(m.contentRating ? { contentRating: m.contentRating } : {}),
      duration: m.duration ?? 6_000_000,
      ...(m.viewCount ? { viewCount: m.viewCount } : {}),
      ...(m.lastViewedAt ? { lastViewedAt: m.lastViewedAt } : {}),
      ...(m.viewOffset ? { viewOffset: m.viewOffset } : {}),
    };
  }

  private async read<T>(server: PlexServerSlug, op: FakeCall['op'], key: string, fn: () => T): Promise<T> {
    this.calls.push({ server, op, key });
    if (this.readDelayMs > 0) await new Promise((r) => setTimeout(r, this.readDelayMs));
    if (this.failReads.has(`${server}:${op}`)) {
      throw new PlexHttpError(503, 'GET', `http://${server}.fake/${op}`, 'unavailable');
    }
    return fn();
  }

  private write(server: PlexServerSlug, op: 'scrobble' | 'unscrobble', key: string): Promise<void> {
    this.calls.push({ server, op, key });
    if (this.failWrites.has(`${server}:${key}`)) {
      return Promise.reject(new PlexHttpError(503, 'GET', `http://${server}.fake/:/${op}`, 'unavailable'));
    }
    const leaves = this.leavesFor(server, key);
    if (leaves.length === 0) return Promise.reject(notFound(server, key));
    for (const leaf of leaves) {
      if (op === 'scrobble') {
        leaf.viewCount = (leaf.viewCount ?? 0) + 1;
        leaf.lastViewedAt = this.now;
        delete leaf.viewOffset;
      } else {
        leaf.viewCount = 0;
        delete leaf.lastViewedAt;
        delete leaf.viewOffset;
      }
    }
    return Promise.resolve();
  }

  clients(): WatchPlexClients & { read: Required<WatchPlexClients['read']> } {
    const servers: PlexServerSlug[] = ['haynesops', 'haynestower', 'hayneskube'];
    const read = {} as Required<WatchPlexClients['read']>;
    const write = {} as Required<WatchPlexClients['write']>;
    for (const server of servers) {
      read[server] = {
        getMetadataItem: (key: string) =>
          this.read(server, 'getMetadataItem', key, () => {
            const show = this.showOn(server, key);
            if (show) return { item: this.showItem(show), librarySectionId: '2' };
            const movie = this.movies.find((m) => m.server === server && m.ratingKey === key);
            if (movie) return { item: this.movieItem(movie), librarySectionId: '1' };
            throw notFound(server, key);
          }),
        listAllLeaves: (key: string) =>
          this.read(server, 'listAllLeaves', key, () => {
            const show = this.showOn(server, key);
            if (!show) throw notFound(server, key);
            const items = [...show.episodes]
              .sort((a, b) => a.season - b.season || a.episode - b.episode)
              .map((e) => this.leafItem(show, e));
            if (this.truncateLeavesAt !== null && items.length > this.truncateLeavesAt) {
              return { items: items.slice(0, this.truncateLeavesAt), totalSize: items.length, truncated: true };
            }
            return { items, totalSize: items.length, truncated: false };
          }),
        findByGuid: (guid: string) =>
          this.read(server, 'findByGuid', guid, () => [
            ...this.shows.filter((s) => s.server === server && s.guid === guid).map((s) => this.showItem(s)),
            ...this.movies.filter((m) => m.server === server && m.guid === guid).map((m) => this.movieItem(m)),
          ]),
        matchDiscover: ({ kind, guid }: { kind: 'movie' | 'show'; guid: string }) =>
          this.discoverRead(server, 'matchDiscover', `${kind}:${guid}`, () => {
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
          }),
        getDiscoverUserState: (id: string) =>
          this.discoverRead(server, 'getDiscoverUserState', id, () => {
            if (!/^[0-9a-f]{24}$/.test(id)) throw new TypeError('not a discover id');
            return { watchlistedAt: this.watchlist.get(id) ?? null };
          }),
      };
      write[server] = {
        scrobble: (key: string) => this.write(server, 'scrobble', key),
        unscrobble: (key: string) => this.write(server, 'unscrobble', key),
        addToWatchlist: (id: string) => this.watchlistWrite(server, 'addToWatchlist', id),
        removeFromWatchlist: (id: string) => this.watchlistWrite(server, 'removeFromWatchlist', id),
      };
    }
    return { read, write };
  }
}

export const seasonKeyOf = seasonKey;
