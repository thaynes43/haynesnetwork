// @hnet/plex/read — the READ surface (DESIGN-007 D-03 read/write split, mirroring
// @hnet/arr/read). Consumers: the registry refresh (`/library/sections`, `/identity`) and the
// share orchestrator's read-merge-write base (the plex.tv friend list + a user's current
// SharedServer). Nothing here mutates a Plex account; the write surface lives in
// `@hnet/plex/write` and is import-guarded to packages/domain.
import type { ZodType } from 'zod';
import { PLEX_DISCOVER_BASE_URL, PLEX_TV_BASE_URL } from './config';
import { PlexHttp, type QueryParams } from './http';
import { childrenNamed, parseXml, type XmlElement } from './xml';
import { PlexHttpError, PlexParseError } from './errors';
import {
  DISCOVER_TYPE,
  discoverExternalIds,
  isDiscoverId,
  requireDiscoverId,
  type DiscoverExternalIds,
  type DiscoverKind,
} from './discover';
import {
  collectionsContainerSchema,
  discoverMatchesSchema,
  discoverUserStateSchema,
  identitySchema,
  librarySectionsSchema,
  plexAccountSchema,
  plexFriendSchema,
  metadataContainerSchema,
  plexServerSectionSchema,
  sectionContentsSchema,
  sharedServerSchema,
  watchlistContainerSchema,
  type PlexAccount,
  type PlexCollection,
  type PlexFriend,
  type PlexIdentity,
  type PlexLibrarySection,
  type PlexSectionItem,
  type PlexServerSection,
  type PlexSharedServer,
} from './schemas';

export interface PlexClientOptions {
  /** Direct PMS base URL — registry reads (`/library/sections`, `/identity`). */
  baseUrl: string;
  /** The server's owner X-Plex-Token (secret; header-only). */
  token: string;
  /** The Plex server GUID the plex.tv sharing API keys on. */
  machineIdentifier: string;
  /** plex.tv host for the sharing API. Defaults to PLEX_TV_BASE_URL. */
  plexTvBaseUrl?: string;
  /** plex.tv discover-provider host for the watchlist. Defaults to PLEX_DISCOVER_BASE_URL. */
  plexDiscoverBaseUrl?: string;
  clientIdentifier?: string;
  product?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Retries after a GET's (or an idempotent write's) first attempt; default 2 (`PlexHttpOptions.getRetries`). */
  getRetries?: number;
  /** Injectable fetch for fixture/stub-driven tests (ADR-010: no live-API tests in CI). */
  fetchImpl?: typeof fetch;
}

const xmlBool = (v: string | undefined): boolean => v === '1' || v === 'true';

/** ADR-064 — the /collections read pages in this container size … */
export const COLLECTIONS_PAGE_SIZE = 200;
/** … under a safety cap so a bad totalSize can never loop forever (the plex-match MAX_PAGES idiom). */
export const MAX_COLLECTION_PAGES = 50;

/** DESIGN-049 D-09 — a show's `allLeaves` read pages in this container size … */
export const ALL_LEAVES_PAGE_SIZE = 500;
/** … under a safety cap (20 × 500 = 10,000 episodes; the estate's longest show is ~1,000). */
export const MAX_ALL_LEAVES_PAGES = 20;
/**
 * DESIGN-049 D-09 step 6 — the discover provider REJECTS a container over 100 (HTTP 400; verified live
 * 2026-09-23: 100 → 100 items, 101 → 400), so the watchlist pages at exactly this size …
 */
export const WATCHLIST_PAGE_SIZE = 100;
/** … under a safety cap (2,000 titles). */
export const MAX_WATCHLIST_PAGES = 20;

/**
 * A fully paged Plex listing plus its completeness flag. `truncated` = the read ended WITHOUT proof of
 * completion (the page cap, or a page that contradicted the server's own totalSize): the items are a
 * PARTIAL view — a caller must not treat an absent item as absent from Plex.
 */
export interface PlexPagedListing<T> {
  items: T[];
  /** The server's own total, when it sent one. */
  totalSize: number | null;
  truncated: boolean;
}

/** The `MediaContainer` subset every paged metadata listing shares. */
type PagedContainer = { MediaContainer: { totalSize?: number; Metadata: PlexSectionItem[] } };

/** ADR-064 — a section's paged /collections listing plus its completeness flag. */
export interface PlexCollectionsListing {
  collections: PlexCollection[];
  /**
   * True when the read ended WITHOUT proof of completion (the MAX_COLLECTION_PAGES cap, or a
   * totalSize-contradicting empty page). A truncated listing is PARTIAL: reconcile-deleting
   * against it would tombstone everything past the cut — callers must not scope it.
   */
  truncated: boolean;
}

/** ADR-092 / DESIGN-051 D-06 — a discover title found by an external id (`matchDiscover`). */
export interface DiscoverMatch {
  /** The discover id (24 hex digits) — the watchlist actions' `ratingKey`. */
  ratingKey: string;
  /** Its `plex://movie|show/<id>` guid, when plex.tv sent one. */
  guid: string | null;
  kind: DiscoverKind;
  /** plex.tv's title and year — what `set_watchlist` says back (ADR-092 C-07). */
  title: string;
  year: number | null;
  ids: DiscoverExternalIds;
}

function attr(el: XmlElement, name: string): string | undefined {
  return el.attrs[name];
}

export class PlexReadClient {
  protected readonly http: PlexHttp;
  protected readonly baseUrl: string;
  protected readonly plexTvBaseUrl: string;
  protected readonly plexDiscoverBaseUrl: string;
  readonly machineIdentifier: string;
  /** Cache for `getOwnerAccount` — the owner is stable for the client's lifetime. */
  private ownerAccount?: PlexAccount;

  constructor(options: PlexClientOptions) {
    this.http = new PlexHttp(options);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.plexTvBaseUrl = (options.plexTvBaseUrl ?? PLEX_TV_BASE_URL).replace(/\/+$/, '');
    this.plexDiscoverBaseUrl = (options.plexDiscoverBaseUrl ?? PLEX_DISCOVER_BASE_URL).replace(/\/+$/, '');
    this.machineIdentifier = options.machineIdentifier;
  }

  /**
   * Page a container-bounded listing to completion with the X-Plex-Container-Start/-Size loop, under a
   * page cap. Termination follows listCollections exactly: with `totalSize` on the wire the loop ends at
   * `start >= totalSize`; without it only an empty or short page ends it; anything else (the cap, or an
   * empty page that contradicts totalSize) returns `truncated: true`. The returned-page `size` is never
   * mistaken for the grand total.
   */
  private async readAllPages(
    url: string,
    query: QueryParams,
    pageSize: number,
    maxPages: number,
    schema: ZodType<PagedContainer>,
  ): Promise<PlexPagedListing<PlexSectionItem>> {
    const items: PlexSectionItem[] = [];
    let start = 0;
    let totalSize: number | null = null;
    let truncated = true; // proven complete only by a terminating condition below
    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.http.requestJson('GET', url, schema, {
        query: { ...query, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': pageSize },
      });
      const mc = body.MediaContainer;
      items.push(...mc.Metadata);
      start += mc.Metadata.length;
      totalSize = mc.totalSize ?? null;
      if (totalSize !== null) {
        if (start >= totalSize) {
          truncated = false;
          break;
        }
        if (mc.Metadata.length === 0) break; // under-delivered against its own totalSize — PARTIAL
      } else if (mc.Metadata.length < pageSize) {
        truncated = false; // no totalSize: an empty/short page is the only honest completion signal
        break;
      }
    }
    return { items, totalSize, truncated };
  }

  // ---- PMS reads (registry refresh) ----

  /** `GET /identity` — the server GUID + version. */
  async getIdentity(): Promise<{ machineIdentifier: string; version: string | null }> {
    const body: PlexIdentity = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/identity`,
      identitySchema,
    );
    return {
      machineIdentifier: body.MediaContainer.machineIdentifier,
      version: body.MediaContainer.version ?? null,
    };
  }

  /** `GET /library/sections` — the server's libraries (registry upsert source). */
  async listSections(): Promise<PlexLibrarySection[]> {
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections`,
      librarySectionsSchema,
    );
    return body.MediaContainer.Directory;
  }

  /**
   * ADR-038 / DESIGN-017 (PLAN-022) — `GET /library/sections/{key}/all`: the section's top-level items
   * (the shows of a TV-Show-by-Date ytdl-sub library). Read-only, container-size bounded (ADR-038 C-08);
   * the token stays in the X-Plex-Token header, never the URL. Consumed by the ytdl-sub Library router.
   */
  async listSectionContents(
    sectionKey: string,
    opts?: { limit?: number },
  ): Promise<PlexSectionItem[]> {
    const size = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`,
      sectionContentsSchema,
      { query: { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size } },
    );
    return body.MediaContainer.Metadata;
  }

  /**
   * ADR-047 / DESIGN-025 (PLAN-028 — plex-match) — ONE page of `GET /library/sections/{key}/all`
   * (`X-Plex-Container-Start`/`-Size`), returning the items plus the library's `totalSize` so the
   * match sweep can page a large Movies/TV library to completion. `includeGuids=1` is REQUIRED:
   * without it Plex OMITS the external `Guid` array (tmdb://, imdb://, tvdb://, mbid://) from
   * section listings — verified live against k8plex 2026-07-11 (the v0.40.0 sweep matched 0/17,269
   * indexed titles without it; with the param the mbid:// GUIDs appear). Read-only; token stays in
   * the header. Callers loop `start += size` until `start >= totalSize` (or a short page returns).
   */
  async listSectionContentsPage(
    sectionKey: string,
    opts: {
      start: number;
      size: number;
      /**
       * DESIGN-049 D-09 — the Plex metadata `type` to list (1 movie, 2 show, 3 season, 4 episode). Omitted ⇒
       * the section's own top-level type.
       */
      type?: number;
      /**
       * DESIGN-049 D-09 — `true` ⇒ `unwatched=1` (unwatched only); `false` ⇒ `unwatched=0` (WATCHED only).
       * Verified live 2026-09-23 on a 5,273-movie section: unwatched=0 → 310 + unwatched=1 → 4,963 = the
       * unfiltered total, and every unwatched=0 item has viewCount ≥ 1 (a full scan agreed: 310). On a SHOW
       * section `unwatched=0` means FULLY watched shows only — read show progress from the plain listing.
       */
      unwatched?: boolean;
      /**
       * DESIGN-049 D-09 — `true` ⇒ `inProgress=1`: items with a resume point (viewOffset > 0). Verified live
       * 2026-09-23 (HaynesTower movies: 97, every one with a viewOffset; HaynesOps: 0, and a full scan found no
       * viewOffset either). `false`/omitted ⇒ no filter.
       */
      inProgress?: boolean;
    },
  ): Promise<{ items: PlexSectionItem[]; totalSize: number | null }> {
    const size = Math.min(Math.max(opts.size, 1), 1000);
    const start = Math.max(opts.start, 0);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all`,
      sectionContentsSchema,
      {
        query: {
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': size,
          includeGuids: 1,
          type: opts.type,
          unwatched: opts.unwatched === undefined ? undefined : opts.unwatched ? 1 : 0,
          inProgress: opts.inProgress ? 1 : undefined,
        },
      },
    );
    return {
      items: body.MediaContainer.Metadata,
      totalSize: body.MediaContainer.totalSize ?? body.MediaContainer.size ?? null,
    };
  }

  /**
   * ADR-064 / DESIGN-035 D-02 (PLAN-037 — mirrored collections) — `GET
   * /library/sections/{key}/collections`: a section's Plex collections, paged with the
   * X-Plex-Container-Start/-Size loop (the /collections listing is container-bounded like /all —
   * the plex-match lesson) under a MAX_COLLECTION_PAGES cap. Read-only; token stays in the header.
   * A collection's MEMBERS are its `/library/metadata/{ratingKey}/children` — read via the existing
   * listMetadataChildren.
   *
   * Termination (adversarial-review fix): `size` (the RETURNED PAGE COUNT) is NEVER substituted
   * for the grand total — that would end the loop after one page and let a reconciling caller
   * tombstone everything past it. With `totalSize` on the wire the loop ends at
   * `start >= totalSize`; without it, only an EMPTY or SHORT page (< COLLECTIONS_PAGE_SIZE) ends
   * it. Any other exit — the page cap, or a totalSize-contradicting empty page — marks the
   * listing `truncated`: callers must treat it as PARTIAL (upsert what was seen, never reconcile
   * on it — the fetcher leaves the library unscoped).
   */
  async listCollections(sectionKey: string): Promise<PlexCollectionsListing> {
    const collections: PlexCollection[] = [];
    let start = 0;
    let truncated = true; // proven complete only by a terminating condition below
    for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
      const body = await this.http.requestJson(
        'GET',
        `${this.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/collections`,
        collectionsContainerSchema,
        {
          query: {
            'X-Plex-Container-Start': start,
            'X-Plex-Container-Size': COLLECTIONS_PAGE_SIZE,
          },
        },
      );
      const mc = body.MediaContainer;
      collections.push(...mc.Metadata);
      start += mc.Metadata.length;
      const totalSize = mc.totalSize ?? null;
      if (totalSize !== null) {
        if (start >= totalSize) {
          truncated = false;
          break;
        }
        // The server under-delivered against its own totalSize — stop, but stay PARTIAL.
        if (mc.Metadata.length === 0) break;
      } else if (mc.Metadata.length < COLLECTIONS_PAGE_SIZE) {
        // No totalSize on the wire: an empty/short page is the only honest completion signal.
        truncated = false;
        break;
      }
    }
    return { collections, truncated };
  }

  /**
   * DESIGN-017 D-09 (ytdl-sub drill-in) — `GET /library/metadata/{ratingKey}`: one item (a show /
   * season / episode) plus the library section that owns it (the drill-in's section-confinement
   * check). Read-only; token in the header. A bogus ratingKey throws the typed 404 PlexHttpError —
   * callers map it to their not-found shape.
   */
  async getMetadataItem(
    ratingKey: string,
  ): Promise<{ item: PlexSectionItem; librarySectionId: string | null } | null> {
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}`,
      metadataContainerSchema,
    );
    const item = body.MediaContainer.Metadata[0];
    if (!item) return null;
    return {
      item,
      librarySectionId: item.librarySectionID ?? body.MediaContainer.librarySectionID ?? null,
    };
  }

  /**
   * DESIGN-017 D-09 (ytdl-sub drill-in) — `GET /library/metadata/{ratingKey}/children`: a show's
   * seasons or a season's episodes, container-size bounded like listSectionContents (ADR-038 C-08).
   * Returns the items plus the owning librarySectionID (container-level) for section confinement.
   */
  async listMetadataChildren(
    ratingKey: string,
    opts?: { limit?: number },
  ): Promise<{ items: PlexSectionItem[]; librarySectionId: string | null; totalSize: number | null }> {
    const size = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}/children`,
      metadataContainerSchema,
      { query: { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size } },
    );
    const mc = body.MediaContainer;
    return {
      items: mc.Metadata,
      librarySectionId: mc.librarySectionID ?? mc.Metadata[0]?.librarySectionID ?? null,
      totalSize: mc.totalSize ?? null,
    };
  }

  /**
   * Collection PROVENANCE (owner directive 2026-07-16) — read a collection's Plex LABELS via
   * `GET /library/metadata/{ratingKey}?includeLabels=1` and return their `tag` strings. Kometa
   * labels the collections it manages (`Kometa`), so the collections-sync derives created_by from
   * this. The listing endpoint does NOT carry labels (verified live) — this per-collection read is
   * the only source. Read-only; token stays in the header. A missing item returns [].
   */
  async readCollectionLabels(ratingKey: string): Promise<string[]> {
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}`,
      metadataContainerSchema,
      { query: { includeLabels: 1 } },
    );
    const item = body.MediaContainer.Metadata[0];
    return item ? item.Label.map((l) => l.tag) : [];
  }

  /**
   * ADR-088 / DESIGN-049 D-09/D-11 (PLAN-068) — `GET /library/metadata/{ratingKey}/allLeaves`: EVERY episode
   * of a show (specials included — season 0 — callers exclude them), paged to completion, each with its
   * `index`, `parentIndex`, and the token account's `viewCount` / `lastViewedAt` / `viewOffset` when it has
   * one (verified live 2026-09-23: a 106-episode show → 106 leaves, and the leaves with viewCount > 0 matched
   * the show's viewedLeafCount, 28 = 28). Read-only; token in the header.
   */
  async listAllLeaves(
    ratingKey: string,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<PlexPagedListing<PlexSectionItem>> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? ALL_LEAVES_PAGE_SIZE, 1), 1000);
    return this.readAllPages(
      `${this.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`,
      {},
      pageSize,
      opts.maxPages ?? MAX_ALL_LEAVES_PAGES,
      metadataContainerSchema,
    );
  }

  /**
   * ADR-088 / DESIGN-049 D-14 step 2 (PLAN-068) — `GET /library/all?guid=<plex guid>`: every item on THIS
   * server carrying that Plex guid (`plex://show/…`, `plex://movie/…`), across all sections — the live "does
   * this server hold it" lookup when neither the snapshot nor the ledger knows. Verified live 2026-09-23 (one
   * hit, the same ratingKey the section listing carries). A blank guid answers [] without a request.
   */
  async findByGuid(guid: string): Promise<PlexSectionItem[]> {
    const needle = guid.trim();
    if (!needle) return [];
    const body = await this.http.requestJson(
      'GET',
      `${this.baseUrl}/library/all`,
      metadataContainerSchema,
      { query: { guid: needle, includeGuids: 1 } },
    );
    return body.MediaContainer.Metadata;
  }

  // ---- plex.tv discover provider (the watchlist) ----

  /**
   * ADR-089 / DESIGN-049 D-09 step 6 (PLAN-068) — the TOKEN ACCOUNT's plex.tv watchlist (use an owner
   * token — every server token here is the owner's): `GET {discover}/library/sections/watchlist/all` with
   * `includeGuids=1`, newest-watchlisted first (`sort=watchlistedAt:desc`, also the provider's default),
   * paged at WATCHLIST_PAGE_SIZE (the provider rejects larger containers). Verified live 2026-09-23: 151
   * titles in two pages. Items carry no watchlist timestamp — position is the order. Read-only.
   */
  async getWatchlist(
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<PlexPagedListing<PlexSectionItem>> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? WATCHLIST_PAGE_SIZE, 1), WATCHLIST_PAGE_SIZE);
    return this.readAllPages(
      `${this.plexDiscoverBaseUrl}/library/sections/watchlist/all`,
      { includeGuids: 1, sort: 'watchlistedAt:desc' },
      pageSize,
      opts.maxPages ?? MAX_WATCHLIST_PAGES,
      watchlistContainerSchema,
    );
  }

  /**
   * ADR-092 / DESIGN-051 D-03 step 3 / D-06 (PLAN-071) — resolve an external id to the discover title:
   * `GET {discover}/library/metadata/matches?type=<1 movie|2 show>&guid=<tmdb|tvdb|imdb>://<id>` (`type` is
   * mandatory; verified live 2026-09-25). Returns the first item of the asked kind (else the first item, whose
   * `kind` the caller checks), with its discover id, title, year and external ids; null when nothing matched
   * (an empty or absent list, or a 404). An item without a valid discover id is not a match. Read-only.
   */
  async matchDiscover(input: { kind: DiscoverKind; guid: string }): Promise<DiscoverMatch | null> {
    const guid = input.guid.trim();
    if (!/^(tmdb|tvdb|imdb):\/\/\S+$/i.test(guid)) {
      throw new TypeError('plex discover: matchDiscover takes a tmdb://, tvdb:// or imdb:// guid');
    }
    let body;
    try {
      body = await this.http.requestJson(
        'GET',
        `${this.plexDiscoverBaseUrl}/library/metadata/matches`,
        discoverMatchesSchema,
        { query: { type: DISCOVER_TYPE[input.kind], guid } },
      );
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 404) return null;
      throw error;
    }
    const mc = body.MediaContainer;
    const items = [...(mc?.Metadata ?? []), ...(mc?.Video ?? [])].filter((i) => isDiscoverId(i.ratingKey));
    const kindOf = (type: string | undefined): DiscoverKind | null =>
      type === 'movie' ? 'movie' : type === 'show' ? 'show' : null;
    const hit = items.find((i) => kindOf(i.type) === input.kind) ?? items[0];
    const kind = kindOf(hit?.type);
    if (!hit || !kind) return null;
    return {
      ratingKey: hit.ratingKey,
      guid: hit.guid?.trim() || null,
      kind,
      title: hit.title?.trim() ?? '',
      year: typeof hit.year === 'number' && Number.isFinite(hit.year) && hit.year > 0 ? hit.year : null,
      ids: discoverExternalIds(hit.Guid),
    };
  }

  /**
   * ADR-092 / DESIGN-051 D-03 step 4 / D-06 — the token account's own state of one discover title:
   * `GET {discover}/library/metadata/<id>/userState`. On the watchlist ⇔ `watchlistedAt` is present (epoch
   * seconds). `UserState` may be an object or a one-element array (both seen live). The id is validated
   * before the URL is built. Read-only.
   *
   * DESIGN-051 D-06 (review A3): only a state OF THIS TITLE counts — an element whose `ratingKey` is the requested
   * id, or that names none. A response whose every element names another title is not an answer: it throws a
   * PlexParseError (the caller's "unknown"), never falls back to another title's state. No `UserState` (or an
   * empty list) is "not on the watchlist".
   */
  async getDiscoverUserState(id: string): Promise<{ watchlistedAt: number | null }> {
    const key = requireDiscoverId(id);
    const url = `${this.plexDiscoverBaseUrl}/library/metadata/${key}/userState`;
    const body = await this.http.requestJson('GET', url, discoverUserStateSchema);
    const state = body.MediaContainer?.UserState;
    const all = state === undefined ? [] : Array.isArray(state) ? state : [state];
    if (all.length === 0) return { watchlistedAt: null };
    const one = all.find((s) => s.ratingKey === key) ?? all.find((s) => s.ratingKey === undefined);
    if (!one) throw new PlexParseError('GET', url, ['UserState names another title']);
    const at = one.watchlistedAt;
    return { watchlistedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null };
  }

  // ---- plex.tv account read (owner identity) ----

  /**
   * `GET /api/v2/user` (JSON) — the account the owner token authenticates as (the server OWNER).
   * The owner is NEVER in their own friend list (`/api/users` lists friends only), so
   * owner-vs-friend must be resolved here, not via `findFriendByEmail` (ADR-029). Cached per
   * client (the owner account is stable for the client's lifetime). Throws the usual typed
   * PlexError on failure — callers that want to degrade (plex.myLibraries) catch it.
   */
  async getOwnerAccount(): Promise<PlexAccount> {
    if (this.ownerAccount) return this.ownerAccount;
    const account = await this.http.requestJson(
      'GET',
      `${this.plexTvBaseUrl}/api/v2/user`,
      plexAccountSchema,
    );
    this.ownerAccount = account;
    return account;
  }

  /** The server owner's plex.tv account email, trimmed + lowercased — or null if it has none. */
  async getOwnerEmail(): Promise<string | null> {
    const email = (await this.getOwnerAccount()).email?.trim().toLowerCase();
    return email ? email : null;
  }

  // ---- plex.tv v1 sharing reads (share orchestration base) ----

  /** `GET /api/users` — the account's friend list (maps app user → Plex account by email). */
  async listFriends(): Promise<PlexFriend[]> {
    const root = await this.http.requestXml('GET', `${this.plexTvBaseUrl}/api/users`);
    return childrenNamed(root, 'User').map((u) =>
      plexFriendSchema.parse({
        id: attr(u, 'id') ?? '',
        email: attr(u, 'email') ?? null,
        username: attr(u, 'username') ?? null,
        title: attr(u, 'title') ?? null,
      }),
    );
  }

  /**
   * fix/plex-numeric-id — resolve an app user to their Plex friend account by the plex.tv NUMERIC
   * user id (the friend list's `<User id=…>`). The id is immutable and the one identity Authentik
   * reliably surfaces for a source-linked account, so callers try this BEFORE email/username
   * matching. Exact string match (both sides are the plex.tv id as a string); blank id → null.
   */
  async findFriendById(plexUserId: string): Promise<PlexFriend | null> {
    const needle = plexUserId.trim();
    if (!needle) return null;
    const friends = await this.listFriends();
    return friends.find((f) => f.id === needle) ?? null;
  }

  /** Case-insensitive email match against the friend list (ADR-017 D-01 user→account map). */
  async findFriendByEmail(email: string): Promise<PlexFriend | null> {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;
    const friends = await this.listFriends();
    return friends.find((f) => (f.email ?? '').toLowerCase() === needle) ?? null;
  }

  /**
   * fix/plex-identity-mapping — resolve an app user to their Plex friend account by the caller's
   * REAL Plex identity (email OR username, case-insensitive), falling back to their app/OIDC email.
   * The OIDC id_token carries the Authentik email, which for a linked pre-existing account need NOT
   * equal the plex.tv email/username; email-only matching (findFriendByEmail) therefore misses such
   * users. The username arm covers accounts whose plex.tv email is private/absent but whose
   * username is known. Returns the first matching friend, or null.
   */
  async findFriendByIdentity(
    identity: { email: string | null; username: string | null },
    fallbackEmail: string,
  ): Promise<PlexFriend | null> {
    const emails = new Set(
      [identity.email, fallbackEmail]
        .map((e) => (e ?? '').trim().toLowerCase())
        .filter((e): e is string => e.length > 0),
    );
    const username = (identity.username ?? '').trim().toLowerCase();
    if (emails.size === 0 && !username) return null;
    const friends = await this.listFriends();
    return (
      friends.find((f) => {
        const fe = (f.email ?? '').trim().toLowerCase();
        const fu = (f.username ?? '').trim().toLowerCase();
        return (fe !== '' && emails.has(fe)) || (username !== '' && fu === username);
      }) ?? null
    );
  }

  /**
   * `GET /api/servers/{machineId}` — the section-id map: each `<Section>` carries both the
   * server section `key` (our registry identity) and the plex.tv `id` the share body uses.
   */
  async listServerSections(): Promise<PlexServerSection[]> {
    const root = await this.http.requestXml(
      'GET',
      `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}`,
    );
    const server = childrenNamed(root, 'Server')[0];
    if (!server) {
      throw new PlexParseError('GET', `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}`, [
        'no <Server> element in /api/servers response',
      ]);
    }
    return childrenNamed(server, 'Section').map((s) =>
      plexServerSectionSchema.parse({
        id: attr(s, 'id') ?? '',
        key: attr(s, 'key') ?? '',
        title: attr(s, 'title') ?? '',
        type: attr(s, 'type') ?? '',
      }),
    );
  }

  /** `GET /api/servers/{machineId}/shared_servers` — every friend the server is shared with. */
  async listSharedServers(): Promise<PlexSharedServer[]> {
    const root = await this.http.requestXml(
      'GET',
      `${this.plexTvBaseUrl}/api/servers/${this.machineIdentifier}/shared_servers`,
    );
    return childrenNamed(root, 'SharedServer').map((ss) =>
      sharedServerSchema.parse({
        id: attr(ss, 'id') ?? '',
        userID: attr(ss, 'userID') ?? null,
        email: attr(ss, 'email') ?? null,
        username: attr(ss, 'username') ?? null,
        allLibraries: xmlBool(attr(ss, 'allLibraries')),
        sections: childrenNamed(ss, 'Section').map((sec) => ({
          id: attr(sec, 'id') ?? '',
          key: attr(sec, 'key') ?? '',
          shared: xmlBool(attr(sec, 'shared')),
        })),
      }),
    );
  }

  /** The SharedServer for a Plex user id, or null when the server isn't shared with them yet. */
  async findSharedServerForUser(plexUserId: string): Promise<PlexSharedServer | null> {
    const all = await this.listSharedServers();
    return all.find((ss) => ss.userID === plexUserId) ?? null;
  }
}

export function plexReadClient(options: PlexClientOptions): PlexReadClient {
  return new PlexReadClient(options);
}

export { parseXml };
export type {
  PlexAccount,
  PlexCollection,
  PlexFriend,
  PlexServerSection,
  PlexSharedServer,
  PlexLibrarySection,
};
