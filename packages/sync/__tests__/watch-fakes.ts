// Fakes for the `watch` sync tests (DESIGN-049 D-09, PLAN-068 S6): an in-memory Plex server per slug (the
// owner's watch state, section listings with the verified `type` / `unwatched` / `inProgress` filters and
// paging, allLeaves, metadata, plex.tv owner + watchlist) and a fetch stub the REAL TautulliClient runs
// against (so `get_history` paging and the 400 / `{}` "gone" mapping go through the production client).
// READ-ONLY surfaces only: the sync never writes Plex.
import { TautulliClient } from '@hnet/arr/read';
import type { PlexServerSlug } from '@hnet/db';
import { PlexHttpError, type PlexSectionItem } from '@hnet/plex';
import type { WatchSyncPlexRead, WatchTautulliSource } from '../src/watch';

export interface SEpisode {
  ratingKey: string;
  season: number;
  episode: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
}

export interface SShow {
  ratingKey: string;
  title: string;
  year: number;
  guid: string;
  Guid?: Array<{ id: string }>;
  Genre?: Array<{ tag: string }>;
  contentRating?: string;
  episodes: SEpisode[];
}

export interface SMovie {
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

function notFound(key: string) {
  return new PlexHttpError(404, 'GET', `http://fake/library/metadata/${key}`, 'not found');
}

export class FakePlexServer {
  readonly calls: string[] = [];
  /** Method names that throw a 503 (a server outage). */
  readonly failing = new Set<string>();
  /** grandparent / show keys whose metadata read throws a 503 (Plex cannot answer for them). */
  readonly unreachableKeys = new Set<string>();
  /** Keys whose metadata read never answers (a host that hangs instead of refusing). */
  readonly hangingKeys = new Set<string>();
  owner: { id: string; username: string; email: string } | null = null;
  watchlist: PlexSectionItem[] = [];

  constructor(
    readonly slug: PlexServerSlug,
    readonly shows: SShow[] = [],
    readonly movies: SMovie[] = [],
  ) {}

  private gate(method: string) {
    this.calls.push(method);
    if (this.failing.has(method)) {
      throw new PlexHttpError(503, 'GET', `http://${this.slug}.fake/${method}`, 'unavailable');
    }
  }

  private showItem(s: SShow) {
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

  private movieItem(m: SMovie) {
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

  private leaf(s: SShow, e: SEpisode) {
    return item({
      ratingKey: e.ratingKey,
      type: 'episode',
      title: `${s.title} ${e.season}x${e.episode}`,
      index: e.episode,
      parentIndex: e.season,
      parentRatingKey: `${s.ratingKey}-s${e.season}`,
      grandparentRatingKey: s.ratingKey,
      grandparentGuid: s.guid,
      ...(e.viewCount ? { viewCount: e.viewCount } : {}),
      ...(e.lastViewedAt ? { lastViewedAt: e.lastViewedAt } : {}),
      ...(e.viewOffset ? { viewOffset: e.viewOffset } : {}),
    });
  }

  read(): WatchSyncPlexRead {
    return {
      getOwnerAccount: async () => {
        this.gate('getOwnerAccount');
        if (!this.owner) throw new PlexHttpError(401, 'GET', 'https://plex.tv/api/v2/user', 'unauthorized');
        return { id: this.owner.id, username: this.owner.username, email: this.owner.email };
      },
      listSections: async () => {
        this.gate('listSections');
        return [
          ...(this.movies.length > 0 ? [{ key: '1', title: 'Movies', type: 'movie' }] : []),
          ...(this.shows.length > 0 ? [{ key: '2', title: 'TV', type: 'show' }] : []),
        ];
      },
      listSectionContentsPage: async (sectionKey, opts) => {
        this.gate('listSectionContentsPage');
        this.calls.push(`list:${sectionKey}:${opts.type}:${String(opts.unwatched)}:${String(opts.inProgress)}`);
        let items: PlexSectionItem[] = [];
        if (sectionKey === '2' && opts.type === 2) items = this.shows.map((s) => this.showItem(s));
        if (sectionKey === '1' && opts.type === 1) {
          items = this.movies
            .filter((m) => opts.unwatched !== false || (m.viewCount ?? 0) > 0)
            .filter((m) => !opts.inProgress || (m.viewOffset ?? 0) > 0)
            .map((m) => this.movieItem(m));
        }
        return { items: items.slice(opts.start, opts.start + opts.size), totalSize: items.length };
      },
      listAllLeaves: async (key) => {
        this.gate('listAllLeaves');
        this.calls.push(`leaves:${key}`);
        const s = this.shows.find((x) => x.ratingKey === key);
        if (!s) throw notFound(key);
        const items = [...s.episodes]
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
          .map((e) => this.leaf(s, e));
        return { items, totalSize: items.length, truncated: false };
      },
      getMetadataItem: async (key) => {
        this.gate('getMetadataItem');
        this.calls.push(`meta:${key}`);
        if (this.unreachableKeys.has(key)) {
          throw new PlexHttpError(503, 'GET', `http://${this.slug}.fake/library/metadata/${key}`, 'unavailable');
        }
        if (this.hangingKeys.has(key)) await new Promise<never>(() => {});
        const s = this.shows.find((x) => x.ratingKey === key);
        if (s) return { item: this.showItem(s), librarySectionId: '2' };
        const m = this.movies.find((x) => x.ratingKey === key);
        if (m) return { item: this.movieItem(m), librarySectionId: '1' };
        throw notFound(key);
      },
      getWatchlist: async () => {
        this.gate('getWatchlist');
        return { items: this.watchlist, totalSize: this.watchlist.length, truncated: false };
      },
    };
  }
}

/** A Tautulli history row as `get_history` serves it (grouping=0). */
export interface HRow {
  row_id: number | null;
  user_id: number;
  media_type: 'movie' | 'episode' | 'track';
  started: number;
  stopped: number;
  title: string;
  grandparent_title?: string;
  rating_key: number;
  grandparent_rating_key?: number | '';
  parent_media_index?: number | '';
  media_index?: number | '';
  year?: number;
  guid: string;
  percent_complete: number;
  watched_status: number;
}

export interface FakeTautulli {
  source: WatchTautulliSource;
  /** Every get_history request's query, in order. */
  requests: URLSearchParams[];
  rows: HRow[];
  /** get_metadata answers: data, 'gone400' (current Tautulli), 'goneEmpty' (older builds: 200 + {}). */
  metadata: Map<string, Record<string, unknown> | 'gone400' | 'goneEmpty'>;
  /** Every get_metadata request's rating key, in order (retries included). */
  metadataRequests: string[];
  /** Make every call answer HTTP 500. */
  down: boolean;
  /** Make get_metadata alone answer HTTP 500 (history still pages). */
  metadataDown: boolean;
}

/** The REAL TautulliClient over an in-memory history. */
export function fakeTautulli(slug: PlexServerSlug, rows: HRow[] = []): FakeTautulli {
  const state: FakeTautulli = {
    source: undefined as unknown as WatchTautulliSource,
    requests: [],
    rows,
    metadata: new Map(),
    metadataRequests: [],
    down: false,
    metadataDown: false,
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    const p = url.searchParams;
    if (state.down) return reply(500, { response: { result: 'error', message: 'boom', data: {} } });
    if (p.get('cmd') === 'get_history') {
      state.requests.push(p);
      const after = p.get('after');
      const filtered = state.rows
        .filter((r) => p.get('user_id') === null || String(r.user_id) === p.get('user_id'))
        .filter((r) => p.get('include_activity') !== '0' || r.row_id !== null)
        .filter((r) => after === null || new Date(r.started * 1000).toISOString().slice(0, 10) >= after)
        .sort((a, b) => (p.get('order_dir') === 'asc' ? a.started - b.started : b.started - a.started));
      const start = Number(p.get('start') ?? 0);
      const length = Number(p.get('length') ?? 25);
      return reply(200, {
        response: {
          result: 'success',
          message: null,
          data: { recordsFiltered: filtered.length, recordsTotal: state.rows.length, data: filtered.slice(start, start + length) },
        },
      });
    }
    if (p.get('cmd') === 'get_metadata') {
      const key = p.get('rating_key') ?? '';
      state.metadataRequests.push(key);
      if (state.metadataDown) return reply(500, { response: { result: 'error', message: 'boom', data: {} } });
      const md = state.metadata.get(key);
      if (md === undefined || md === 'gone400') {
        return reply(400, {
          response: { result: 'error', message: `Unable to retrieve metadata for rating_key '${key}'`, data: {} },
        });
      }
      if (md === 'goneEmpty') return reply(200, { response: { result: 'success', message: null, data: {} } });
      return reply(200, { response: { result: 'success', message: null, data: md } });
    }
    return reply(400, { response: { result: 'error', message: 'Unknown command', data: {} } });
  }) as typeof fetch;
  state.source = {
    slug,
    client: new TautulliClient({ baseUrl: `http://${slug}.tautulli`, apiKey: `key-${slug}`, fetchImpl, retryDelayMs: 0 }),
  };
  return state;
}

let nextRow = 1000;

export function episodeRow(
  owner: number,
  show: { title: string; ratingKey: number; year: number },
  ep: { ratingKey: number; season: number; episode: number },
  startedIso: string,
  percent = 100,
): HRow {
  const started = Math.floor(Date.parse(startedIso) / 1000);
  return {
    row_id: nextRow++,
    user_id: owner,
    media_type: 'episode',
    started,
    stopped: started + 2700,
    title: `${show.title} ${ep.season}x${ep.episode}`,
    grandparent_title: show.title,
    rating_key: ep.ratingKey,
    grandparent_rating_key: show.ratingKey,
    parent_media_index: ep.season,
    media_index: ep.episode,
    year: show.year,
    guid: `plex://episode/${ep.ratingKey}`,
    percent_complete: percent,
    watched_status: percent >= 85 ? 1 : 0,
  };
}

export function movieRow(
  owner: number,
  movie: { title: string; ratingKey: number; year: number; guid: string },
  startedIso: string,
  percent = 100,
): HRow {
  const started = Math.floor(Date.parse(startedIso) / 1000);
  return {
    row_id: nextRow++,
    user_id: owner,
    media_type: 'movie',
    started,
    stopped: started + 6000,
    title: movie.title,
    rating_key: movie.ratingKey,
    grandparent_rating_key: '',
    parent_media_index: '',
    media_index: '',
    year: movie.year,
    guid: movie.guid,
    percent_complete: percent,
    watched_status: percent >= 85 ? 1 : 0,
  };
}
