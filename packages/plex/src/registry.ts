// ADR-093 / DESIGN-052 D-01 / D-02 / D-03 (PLAN-072) — the plex.tv reads of the WATCHLIST REGISTRY (T-261), all with
// the OWNER token and all read-only: the account roster (`/api/v2/user`, `/api/users`, `/api/home/users`), the owner's
// own discover watchlist, friends' and full Home members' watchlists through community.plex.tv GraphQL, and the
// discover-id → external-id lookup. Every call has a 10 s timeout and up to 3 attempts on 429, 5xx or a network
// error, backing off 2 s times the attempt (D-02). The token rides only in the X-Plex-Token header; X-Plex-Version is
// never sent (ADR-092 C-08).
//
// PRIVACY (ADR-093 C-06): nothing here returns a username, email or title of another account — the roster carries
// ids, uuids and Home flags only, and a community answer carries discover ids and kinds only. Callers log classes
// and error classes, never bodies.
import { z } from 'zod';
import { PLEX_COMMUNITY_BASE_URL, PLEX_DISCOVER_BASE_URL, PLEX_TV_BASE_URL } from './config';
import {
  DISCOVER_ID_PATTERN,
  discoverExternalIds,
  requireDiscoverId,
  type DiscoverExternalIds,
  type DiscoverKind,
} from './discover';
import { PlexError, PlexHttpError, PlexParseError, PlexTimeoutError } from './errors';
import { PlexHttp, registryRetryStatus } from './http';
import { readAllContainerPages, type PlexPagedListing } from './paging';
import { watchlistContainerSchema, type PlexSectionItem } from './schemas';
import { childrenNamed, type XmlElement } from './xml';

/** D-02 — the per-call timeout of every registry read. */
export const REGISTRY_TIMEOUT_MS = 10_000;
/** D-02 — retries after the first attempt (3 attempts in all). */
export const REGISTRY_RETRIES = 2;
/** D-02 — the wait before retry `attempt`: 2 s times the attempt. */
export const registryBackoffMs = (attempt: number): number => 2_000 * attempt;

/** D-02 — community GraphQL page size (`first` must be 10..100) … */
export const COMMUNITY_PAGE_SIZE = 100;
/** … at most this many pages per account (a longer list fails the read) … */
export const MAX_COMMUNITY_PAGES = 50;
/** … with this pause between calls. */
export const COMMUNITY_PAGE_PAUSE_MS = 120;
/** The owner's discover watchlist: 100 per page (the provider's maximum), at most 20 pages. */
export const OWNER_WATCHLIST_PAGE_SIZE = 100;
export const MAX_OWNER_WATCHLIST_PAGES = 20;

/** The GraphQL query of D-02, verbatim (`user(id: $uuid)` answers another account's watchlist). */
export const COMMUNITY_WATCHLIST_QUERY =
  'query W($uuid: ID = "", $first: PaginationInt!, $after: String) { user(id: $uuid) { watchlist(first: $first, after: $after) { nodes { id guid type title year } pageInfo { hasNextPage endCursor } } } }';

export interface PlexRegistryClientOptions {
  /** An OWNER X-Plex-Token (secret; header-only). */
  token: string;
  plexTvBaseUrl?: string;
  plexDiscoverBaseUrl?: string;
  plexCommunityBaseUrl?: string;
  clientIdentifier?: string;
  product?: string;
  /** Per-attempt timeout (default REGISTRY_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The wait before retry `attempt` (default `registryBackoffMs`; tests pass `() => 0`). */
  retryBackoffMs?: (attempt: number) => number;
  /** The pause between community pages (default COMMUNITY_PAGE_PAUSE_MS; tests pass 0). */
  communityPauseMs?: number;
  fetchImpl?: typeof fetch;
}

/** `GET /api/v2/user` — the token account (the owner): its plex.tv id and uuid. */
export interface RosterOwner {
  id: string;
  uuid: string | null;
}

/** One `<User>` of `GET /api/users` (D-01): no username, email or title crosses this boundary. */
export interface RosterUser {
  id: string;
  /** From `thumb` (`https://plex.tv/users/<uuid>/avatar?c=…`) — the community read's key. */
  uuid: string | null;
  home: boolean;
  restricted: boolean;
}

/** One `<User>` of `GET /api/home/users` (D-01): Home membership, `restricted` and `admin`. */
export interface HomeUser {
  id: string;
  uuid: string | null;
  admin: boolean;
  restricted: boolean;
}

/** One community watchlist node, mapped (D-02): the discover id and the kind. */
export interface CommunityWatchlistNode {
  discoverId: string;
  kind: DiscoverKind;
}

/**
 * A community GraphQL answer, classified by content (D-02):
 * - `answered`  — HTTP 200, `data.user.watchlist` present and NO `errors` entry, on every page (nodes may be none);
 * - `not_found` — HTTP 200 with no data whose errors ALL start with `User not found:` (a managed user, a made-up
 *                 uuid, or a private list — it does NOT mean "no list");
 * - `failed`    — anything else, with an error CLASS (never a body): non-200, non-JSON, any other `errors` entry
 *                 (a partial answer with data AND errors included), a node `type` other than MOVIE/SHOW, a node `id`
 *                 that is not 24-hex, more than MAX_COMMUNITY_PAGES pages.
 */
export type CommunityWatchlistAnswer =
  | { kind: 'answered'; nodes: CommunityWatchlistNode[] }
  | { kind: 'not_found' }
  | { kind: 'failed'; errorClass: string };

/** The external ids of one discover title (D-03), and its kind when plex.tv says. */
export interface DiscoverMetadata {
  kind: DiscoverKind | null;
  ids: DiscoverExternalIds;
}

const rosterOwnerSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  uuid: z.string().nullish(),
});

const communityResponseSchema = z
  .object({
    data: z
      .object({
        user: z
          .object({
            watchlist: z
              .object({
                nodes: z.array(z.object({ id: z.unknown(), type: z.unknown() }).passthrough()),
                pageInfo: z.object({
                  hasNextPage: z.boolean(),
                  endCursor: z.string().nullish(),
                }),
              })
              .nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    errors: z.array(z.object({ message: z.string().nullish() }).passthrough()).nullish(),
  })
  .passthrough();

const discoverMetadataSchema = z.object({
  MediaContainer: z.object({
    Metadata: z
      .array(
        z
          .object({
            type: z.string().optional(),
            Guid: z
              .array(z.object({ id: z.string() }))
              .optional()
              .default([]),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  }),
});

const xmlBool = (v: string | undefined): boolean => v === '1' || v === 'true';

/** The account uuid a roster `thumb` carries (`https://plex.tv/users/<uuid>/avatar?c=…`), lower-cased; else null. */
export function uuidFromThumb(thumb: string | undefined | null): string | null {
  const m = /\/users\/([0-9a-f]{8,64})\/avatar/i.exec(thumb ?? '');
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** A usable community key: 8..64 hex digits (plex.tv uuids are 16). */
export function isAccountUuid(uuid: string | null | undefined): uuid is string {
  return typeof uuid === 'string' && /^[0-9a-f]{8,64}$/.test(uuid);
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** A stable error class for a failed call (for logs and `last_error_class`, never the body). */
export function plexErrorClass(error: unknown): string {
  if (error instanceof PlexHttpError) return `http_${error.status}`;
  if (error instanceof PlexTimeoutError) return 'timeout';
  if (error instanceof PlexParseError) return 'parse';
  if (error instanceof PlexError) return 'network';
  return 'error';
}

/** Map the GraphQL enum (`MOVIE` / `SHOW`, verified live 2026-09-26) to a kind; anything else is null. */
function communityKind(type: unknown): DiscoverKind | null {
  if (type === 'MOVIE') return 'movie';
  if (type === 'SHOW') return 'show';
  return null;
}

export class PlexRegistryClient {
  private readonly http: PlexHttp;
  private readonly plexTvBaseUrl: string;
  private readonly plexDiscoverBaseUrl: string;
  private readonly plexCommunityBaseUrl: string;
  private readonly communityPauseMs: number;

  constructor(options: PlexRegistryClientOptions) {
    this.http = new PlexHttp({
      token: options.token,
      clientIdentifier: options.clientIdentifier,
      product: options.product,
      timeoutMs: options.timeoutMs ?? REGISTRY_TIMEOUT_MS,
      getRetries: REGISTRY_RETRIES,
      retryStatus: registryRetryStatus,
      retryBackoffMs: options.retryBackoffMs ?? registryBackoffMs,
      fetchImpl: options.fetchImpl,
    });
    this.plexTvBaseUrl = (options.plexTvBaseUrl ?? PLEX_TV_BASE_URL).replace(/\/+$/, '');
    this.plexDiscoverBaseUrl = (options.plexDiscoverBaseUrl ?? PLEX_DISCOVER_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.plexCommunityBaseUrl = (options.plexCommunityBaseUrl ?? PLEX_COMMUNITY_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.communityPauseMs = Math.max(0, options.communityPauseMs ?? COMMUNITY_PAGE_PAUSE_MS);
  }

  // ---- the roster (D-01) ----

  /** `GET /api/v2/user` (JSON) — the owner's account id and uuid. */
  async getOwner(): Promise<RosterOwner> {
    const account = await this.http.requestJson(
      'GET',
      `${this.plexTvBaseUrl}/api/v2/user`,
      rosterOwnerSchema,
    );
    if (!account.id)
      throw new PlexParseError('GET', `${this.plexTvBaseUrl}/api/v2/user`, ['no account id']);
    const uuid = account.uuid?.trim().toLowerCase() ?? null;
    return { id: account.id, uuid: isAccountUuid(uuid) ? uuid : null };
  }

  /** `GET /api/users` (XML) — one `<User>` per account the owner shares with, Home members included. */
  async listUsers(): Promise<RosterUser[]> {
    const url = `${this.plexTvBaseUrl}/api/users`;
    const root = await this.http.requestXml('GET', url);
    return this.users(root, url).map((u) => ({
      id: u.id,
      uuid: uuidFromThumb(u.el.attrs.thumb),
      home: xmlBool(u.el.attrs.home),
      restricted: xmlBool(u.el.attrs.restricted),
    }));
  }

  /** `GET /api/home/users` (XML) — the Plex Home: membership, `restricted` (managed) and `admin` (the owner). */
  async listHomeUsers(): Promise<HomeUser[]> {
    const url = `${this.plexTvBaseUrl}/api/home/users`;
    const root = await this.http.requestXml('GET', url);
    return this.users(root, url).map((u) => {
      const attrUuid = u.el.attrs.uuid?.trim().toLowerCase() ?? null;
      return {
        id: u.id,
        uuid: isAccountUuid(attrUuid) ? attrUuid : uuidFromThumb(u.el.attrs.thumb),
        admin: xmlBool(u.el.attrs.admin),
        restricted: xmlBool(u.el.attrs.restricted),
      };
    });
  }

  /** Every `<User>` with an id; a `<User>` without one is a malformed roster (the whole read fails). */
  private users(root: XmlElement, url: string): Array<{ id: string; el: XmlElement }> {
    // parseXml returns the document element — the `<MediaContainer>` whose children are the `<User>`s.
    const container =
      root.tag === 'MediaContainer' ? root : (childrenNamed(root, 'MediaContainer')[0] ?? root);
    const out: Array<{ id: string; el: XmlElement }> = [];
    for (const el of childrenNamed(container, 'User')) {
      const id = el.attrs.id?.trim();
      if (!id || !/^\d+$/.test(id))
        throw new PlexParseError('GET', url, ['a <User> has no numeric id']);
      out.push({ id, el });
    }
    return out;
  }

  // ---- the owner's own list (D-02) ----

  /**
   * The owner's discover watchlist (`/library/sections/watchlist/all`, `includeGuids=1`), 100 per page, at most 20
   * pages — the read `PlexReadClient.getWatchlist` makes, under the registry's timeout and retry policy. A
   * `truncated` listing is a failed owner read (D-04).
   */
  async getOwnerWatchlist(): Promise<PlexPagedListing<PlexSectionItem>> {
    return readAllContainerPages(
      this.http,
      `${this.plexDiscoverBaseUrl}/library/sections/watchlist/all`,
      { includeGuids: 1, sort: 'watchlistedAt:desc' },
      OWNER_WATCHLIST_PAGE_SIZE,
      MAX_OWNER_WATCHLIST_PAGES,
      watchlistContainerSchema,
    );
  }

  // ---- friends and full Home members: community.plex.tv GraphQL (D-02) ----

  /** One account's watchlist through community GraphQL, classified by content (never throws). */
  async communityWatchlist(uuid: string): Promise<CommunityWatchlistAnswer> {
    if (!isAccountUuid(uuid)) return { kind: 'failed', errorClass: 'bad_uuid' };
    const url = `${this.plexCommunityBaseUrl}/api`;
    const nodes: CommunityWatchlistNode[] = [];
    let after: string | null = null;
    for (let page = 1; page <= MAX_COMMUNITY_PAGES; page += 1) {
      if (page > 1) await sleep(this.communityPauseMs);
      let body: z.infer<typeof communityResponseSchema>;
      try {
        body = await this.http.requestJson('GET', url, communityResponseSchema, {
          query: {
            query: COMMUNITY_WATCHLIST_QUERY,
            variables: JSON.stringify({ uuid, first: COMMUNITY_PAGE_SIZE, after }),
          },
        });
      } catch (error) {
        return { kind: 'failed', errorClass: plexErrorClass(error) };
      }
      const errors = body.errors ?? [];
      const watchlist = body.data?.user?.watchlist ?? null;
      if (errors.length > 0) {
        const noData = (body.data?.user ?? null) === null;
        const allNotFound = errors.every((e) => (e.message ?? '').startsWith('User not found:'));
        // Only a first page can say "not found"; a later page saying it contradicts the pages before it.
        if (noData && allNotFound && page === 1) return { kind: 'not_found' };
        return {
          kind: 'failed',
          errorClass: page === 1 ? 'graphql_error' : 'graphql_error_later_page',
        };
      }
      if (watchlist === null) return { kind: 'failed', errorClass: 'no_data' };
      for (const node of watchlist.nodes) {
        const kind = communityKind(node.type);
        if (kind === null) return { kind: 'failed', errorClass: 'bad_type' };
        const id = typeof node.id === 'string' ? node.id.trim().toLowerCase() : '';
        if (!DISCOVER_ID_PATTERN.test(id)) return { kind: 'failed', errorClass: 'bad_id' };
        nodes.push({ discoverId: id, kind });
      }
      if (!watchlist.pageInfo.hasNextPage) return { kind: 'answered', nodes };
      const cursor = watchlist.pageInfo.endCursor ?? null;
      if (cursor === null || cursor === after) return { kind: 'failed', errorClass: 'bad_cursor' };
      after = cursor;
    }
    return { kind: 'failed', errorClass: 'too_many_pages' };
  }

  // ---- the discover-id map (D-03) ----

  /**
   * `GET {discover}/library/metadata/{id}?includeGuids=1` — the title's tmdb/tvdb/imdb ids and kind; null when plex.tv
   * answers 404 (the caller stamps `not_found_at`). Any other failure throws (the caller tries again next run).
   */
  async discoverMetadata(id: string): Promise<DiscoverMetadata | null> {
    const key = requireDiscoverId(id);
    let body: z.infer<typeof discoverMetadataSchema>;
    try {
      body = await this.http.requestJson(
        'GET',
        `${this.plexDiscoverBaseUrl}/library/metadata/${key}`,
        discoverMetadataSchema,
        { query: { includeGuids: 1 } },
      );
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 404) return null;
      throw error;
    }
    const item = body.MediaContainer.Metadata[0];
    if (!item) return null;
    const kind: DiscoverKind | null =
      item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : null;
    return { kind, ids: discoverExternalIds(item.Guid) };
  }
}
