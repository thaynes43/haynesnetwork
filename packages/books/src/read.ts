// ADR-046 / DESIGN-024 (PLAN-023) — the READ-ONLY Kavita + Audiobookshelf clients (@hnet/books/read).
// There is deliberately NO write client and NO ./write export: Kavita/ABS are the source of truth for
// book media (hard rule 4 extension); the app only reads (sync IN + authed cover proxy). Both clients
// manage a session token (Kavita JWT + apiKey, ABS bearer) with lazy login + one 401 re-auth.
import {
  absAuthorsResponseSchema,
  absCollectionsResponseSchema,
  absItemsPageSchema,
  absLibrariesSchema,
  absLoginSchema,
  absUserSchema,
  kavitaCollectionListSchema,
  kavitaLibrarySchema,
  kavitaLoginSchema,
  kavitaReadingListItemListSchema,
  kavitaReadingListListSchema,
  kavitaSeriesListSchema,
  kavitaSeriesMetadataSchema,
  type AbsAuthor,
  type AbsCollection,
  type AbsItem,
  type AbsLibrary,
  type AbsMediaProgress,
  type KavitaCollection,
  type KavitaLibrary,
  type KavitaReadingList,
  type KavitaReadingListItem,
  type KavitaSeries,
  type KavitaSeriesMetadata,
} from './schemas';
import { z } from 'zod';
import { BooksAuthError, BooksHttpError } from './errors';
import { parseJson, rawFetch } from './http';

export interface BooksClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Kavita LibraryType → the app media_kind. 2=Book (EBooks) → 'book'; 1=Comic → 'comic'. */
export function kavitaLibraryKind(type: number): 'book' | 'comic' | null {
  if (type === 2) return 'book';
  if (type === 1) return 'comic';
  return null; // Manga (0) / LightNovel (4) / Images (3) — not surfaced in v1
}

// ---------------------------------------------------------------------------
// Kavita
// ---------------------------------------------------------------------------

const paginationHeaderSchema = z.object({ totalItems: z.number().int().nullable().optional() });

/**
 * Read the list total from Kavita's `Pagination` response header. Returns NULL when the header is
 * absent or malformed — the caller decides what a missing total means (adversarial-review fix: a
 * silent page-length fallback PROVES completion on a full first page, which would let a paged
 * reconcile delete the unseen tail).
 */
function totalFromPaginationHeader(response: Response): number | null {
  const header = response.headers.get('Pagination');
  if (header) {
    try {
      const parsed = paginationHeaderSchema.safeParse(JSON.parse(header));
      if (parsed.success && typeof parsed.data.totalItems === 'number') return parsed.data.totalItems;
    } catch {
      // malformed header — not authoritative
    }
  }
  return null;
}

export interface KavitaSeriesPage {
  items: KavitaSeries[];
  /** The header total when authoritative, else the PAGE length (the legacy fallback value). */
  total: number;
  /**
   * True when `total` came from the `Pagination` response header. False = the page-length
   * fallback — a FULL page with this false cannot prove the read is complete, so
   * completion-sensitive callers (the books-collections-sync reconcile scoping) must treat it as
   * TRUNCATED unless the page came back SHORT (a short page is an honest end-of-list).
   */
  hasAuthoritativeTotal: boolean;
}

export interface KavitaReadingListPage {
  items: KavitaReadingList[];
  total: number;
  /** Same contract as KavitaSeriesPage.hasAuthoritativeTotal. */
  hasAuthoritativeTotal: boolean;
}

export class KavitaClient {
  private readonly baseUrl: string;
  private readonly opts: BooksClientOptions;
  private token: string | null = null;
  private apiKeyValue: string | null = null;

  constructor(options: BooksClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.opts = options;
  }

  private async login(): Promise<void> {
    const url = `${this.baseUrl}/api/Account/login`;
    let response: Response;
    try {
      response = await rawFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
        retries: 0,
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
    } catch (error) {
      throw new BooksAuthError('Kavita', error instanceof Error ? error.message : undefined);
    }
    const login = await parseJson(response, kavitaLoginSchema, 'POST', url);
    this.token = login.token;
    this.apiKeyValue = login.apiKey;
  }

  /** Run an authed GET/POST, logging in first and re-authing once on a 401. */
  private async authed(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    if (!this.token) await this.login();
    const url = `${this.baseUrl}${path}`;
    const doFetch = (): Promise<Response> =>
      rawFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token ?? ''}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        retries: method === 'GET' ? 2 : 0,
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
    try {
      return await doFetch();
    } catch (error) {
      if (error instanceof BooksHttpError && error.status === 401) {
        this.token = null;
        await this.login();
        return doFetch();
      }
      throw error;
    }
  }

  /** The stable per-user API key (used server-side as the cover-endpoint query param). */
  async apiKey(): Promise<string> {
    if (!this.apiKeyValue) await this.login();
    if (!this.apiKeyValue) throw new BooksAuthError('Kavita', 'no apiKey in login response');
    return this.apiKeyValue;
  }

  async listLibraries(): Promise<KavitaLibrary[]> {
    const response = await this.authed('GET', '/api/Library/libraries');
    return parseJson(response, z.array(kavitaLibrarySchema), 'GET', '/api/Library/libraries');
  }

  /**
   * One page of series in a library, filtered server-side (all-v2 FilterV2Dto: field 19 = Library,
   * comparison 0 = Equal, combination 1 = AND). The total is read from the `Pagination` response header.
   */
  async listSeriesPage(
    libraryId: number,
    pageNumber: number,
    pageSize: number,
  ): Promise<KavitaSeriesPage> {
    const path = `/api/Series/all-v2?PageNumber=${pageNumber}&PageSize=${pageSize}`;
    const filter = {
      statements: [{ comparison: 0, field: 19, value: String(libraryId) }],
      combination: 1,
      limitTo: 0,
    };
    const response = await this.authed('POST', path, filter);
    const items = await parseJson(response, kavitaSeriesListSchema, 'POST', path);
    const headerTotal = totalFromPaginationHeader(response);
    return {
      items,
      total: headerTotal ?? items.length,
      hasAuthoritativeTotal: headerTotal !== null,
    };
  }

  /**
   * ADR-066 / DESIGN-038 D-02 (PLAN-051) — all collections visible to the service user
   * (`GET /api/Collection` — AppUserCollectionDto[], verified v0.9.0.2). Unpaged upstream.
   */
  async listCollections(): Promise<KavitaCollection[]> {
    const response = await this.authed('GET', '/api/Collection');
    return parseJson(response, kavitaCollectionListSchema, 'GET', '/api/Collection');
  }

  /**
   * DESIGN-038 D-02 — one page of a COLLECTION's series, filtered server-side (the shipped
   * `listSeriesPage` idiom on the same all-v2 endpoint: field 7 = CollectionTags, comparison 0 =
   * Equal — `HasCollectionTags` treats Equal/Contains identically, verified v0.9.0.2 source).
   */
  async listCollectionSeriesPage(
    collectionId: number,
    pageNumber: number,
    pageSize: number,
  ): Promise<KavitaSeriesPage> {
    const path = `/api/Series/all-v2?PageNumber=${pageNumber}&PageSize=${pageSize}`;
    const filter = {
      statements: [{ comparison: 0, field: 7, value: String(collectionId) }],
      combination: 1,
      limitTo: 0,
    };
    const response = await this.authed('POST', path, filter);
    const items = await parseJson(response, kavitaSeriesListSchema, 'POST', path);
    const headerTotal = totalFromPaginationHeader(response);
    return {
      items,
      total: headerTotal ?? items.length,
      hasAuthoritativeTotal: headerTotal !== null,
    };
  }

  /**
   * DESIGN-038 D-02 — one page of the user's reading lists
   * (`POST /api/ReadingList/lists?PageNumber=&PageSize=&includePromoted=true` — the route is
   * POST-with-query-pagination, verified v0.9.0.2 + live-probed; total from the Pagination header).
   */
  async listReadingListsPage(pageNumber: number, pageSize: number): Promise<KavitaReadingListPage> {
    const path = `/api/ReadingList/lists?PageNumber=${pageNumber}&PageSize=${pageSize}&includePromoted=true`;
    const response = await this.authed('POST', path);
    const items = await parseJson(response, kavitaReadingListListSchema, 'POST', path);
    const headerTotal = totalFromPaginationHeader(response);
    return {
      items,
      total: headerTotal ?? items.length,
      hasAuthoritativeTotal: headerTotal !== null,
    };
  }

  /**
   * DESIGN-024 D-01 amendment (detail-page parity) — one series' rich metadata
   * (`GET /api/Series/metadata?seriesId=` — SeriesMetadataDto: summary/genres/publishers/language/
   * releaseYear, verified live 2026-07-17). The series LIST carries none of this, so the books-sync
   * calls this per CHANGED series (the change-gate). Read-only, like every @hnet/books surface.
   */
  async getSeriesMetadata(seriesId: string): Promise<KavitaSeriesMetadata> {
    const path = `/api/Series/metadata?seriesId=${encodeURIComponent(seriesId)}`;
    const response = await this.authed('GET', path);
    return parseJson(response, kavitaSeriesMetadataSchema, 'GET', path);
  }

  /**
   * DESIGN-038 D-02/D-09 — a reading list's items WITH their explicit positions
   * (`GET /api/ReadingList/items?readingListId=` — ReadingListItemDto[], CHAPTER-grain; the
   * mirror dedupes to series grain at the earliest `order`). Unpaged upstream.
   */
  async listReadingListItems(readingListId: number): Promise<KavitaReadingListItem[]> {
    const path = `/api/ReadingList/items?readingListId=${readingListId}`;
    const response = await this.authed('GET', path);
    return parseJson(response, kavitaReadingListItemListSchema, 'GET', path);
  }

  /**
   * Fetch a series cover image server-side (the apiKey stays in the URL server-side only — the app cover
   * PROXY streams the bytes so the key never reaches the browser). Returns the RAW Response so the caller
   * decides on status (a 404 upstream → the fallback tile, not a thrown 500). Re-auths once on a 401.
   */
  async fetchSeriesCover(seriesId: string): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const attempt = async (): Promise<Response> => {
      const key = await this.apiKey();
      const url = `${this.baseUrl}/api/Image/series-cover?seriesId=${encodeURIComponent(seriesId)}&apiKey=${encodeURIComponent(key)}`;
      return fetchImpl(url, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(10_000) });
    };
    const response = await attempt();
    if (response.status === 401) {
      this.token = null;
      this.apiKeyValue = null;
      return attempt();
    }
    return response;
  }
}

// ---------------------------------------------------------------------------
// Audiobookshelf
// ---------------------------------------------------------------------------

export interface AbsItemsPageResult {
  items: AbsItem[];
  total: number;
}

export class AudiobookshelfClient {
  private readonly baseUrl: string;
  private readonly opts: BooksClientOptions;
  private token: string | null = null;

  constructor(options: BooksClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.opts = options;
  }

  private async login(): Promise<void> {
    const url = `${this.baseUrl}/login`;
    let response: Response;
    try {
      response = await rawFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
        retries: 0,
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
    } catch (error) {
      throw new BooksAuthError('Audiobookshelf', error instanceof Error ? error.message : undefined);
    }
    const login = await parseJson(response, absLoginSchema, 'POST', url);
    this.token = login.user.token;
  }

  private async authed(path: string): Promise<Response> {
    if (!this.token) await this.login();
    const url = `${this.baseUrl}${path}`;
    const doFetch = (): Promise<Response> =>
      rawFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token ?? ''}`, Accept: 'application/json' },
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
    try {
      return await doFetch();
    } catch (error) {
      if (error instanceof BooksHttpError && error.status === 401) {
        this.token = null;
        await this.login();
        return doFetch();
      }
      throw error;
    }
  }

  /** The bearer token (used server-side by the cover proxy's Authorization header). */
  async bearerToken(): Promise<string> {
    if (!this.token) await this.login();
    if (!this.token) throw new BooksAuthError('Audiobookshelf', 'no token in login response');
    return this.token;
  }

  async listLibraries(): Promise<AbsLibrary[]> {
    const response = await this.authed('/api/libraries');
    const parsed = await parseJson(response, absLibrariesSchema, 'GET', '/api/libraries');
    return parsed.libraries;
  }

  /**
   * ADR-066 / DESIGN-038 D-02 (PLAN-051) — all collections visible to the service user
   * (`GET /api/collections`). The per-collection `books` array is returned
   * `collectionBook.order ASC` (verified v2.35.1 source) — the array order IS the curated order,
   * so ABS collections mirror as ORDERED.
   */
  async listCollections(): Promise<AbsCollection[]> {
    const response = await this.authed('/api/collections');
    const parsed = await parseJson(response, absCollectionsResponseSchema, 'GET', '/api/collections');
    return parsed.collections;
  }

  async listItemsPage(libraryId: string, page: number, limit: number): Promise<AbsItemsPageResult> {
    const path = `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${limit}&page=${page}`;
    const response = await this.authed(path);
    const parsed = await parseJson(response, absItemsPageSchema, 'GET', path);
    return { items: parsed.results, total: parsed.total ?? parsed.results.length };
  }

  /**
   * ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user read-state) — read ANY user's per-item listening
   * progress via the ADMIN/service token (`GET /api/users/{id}` → `mediaProgress[]`). The join key back
   * to books_items is each entry's `libraryItemId` (= books_items.external_id for ABS rows). Returns the
   * (possibly empty) progress array; the per-user book-read seam maps it to user_book_progress.
   */
  async getUserProgress(userId: string): Promise<AbsMediaProgress[]> {
    const path = `/api/users/${encodeURIComponent(userId)}`;
    const response = await this.authed(path);
    const parsed = await parseJson(response, absUserSchema, 'GET', path);
    return parsed.mediaProgress ?? [];
  }

  /**
   * DESIGN-026 D-04 amendment (group-card art) — a library's authors (`GET /api/libraries/{id}/authors`).
   * Feeds the in-process author DIRECTORY the grouped-by-Author walls use to attach portrait art:
   * `imagePath` presence is the populated-value gate (a card never points at a photo ABS doesn't hold).
   * Read-only, like every @hnet/books surface.
   */
  async listAuthors(libraryId: string): Promise<AbsAuthor[]> {
    const path = `/api/libraries/${encodeURIComponent(libraryId)}/authors`;
    const response = await this.authed(path);
    const parsed = await parseJson(response, absAuthorsResponseSchema, 'GET', path);
    return parsed.authors;
  }

  /**
   * Fetch an AUTHOR photo server-side (`GET /api/authors/{id}/image` — bearer in a SERVER-SIDE
   * header). Mirrors fetchItemCover exactly: pass `variant` for the upstream-resized tile (verified
   * live 2026-07-13: a 400×267 WebP original becomes a ~2.7 KB 300-wide WebP), omit it for the
   * original (the proxy's fallback tier). Returns the RAW Response (an authorless 404 → the caller's
   * fallback, never a thrown 500); re-auths once on a 401.
   */
  async fetchAuthorImage(
    authorId: string,
    variant?: { width: number; format: 'webp' | 'jpeg' },
  ): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const query = variant ? `?width=${variant.width}&format=${variant.format}` : '';
    const attempt = async (): Promise<Response> => {
      const token = await this.bearerToken();
      const url = `${this.baseUrl}/api/authors/${encodeURIComponent(authorId)}/image${query}`;
      return fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'image/*' },
        signal: AbortSignal.timeout(10_000),
      });
    };
    const response = await attempt();
    if (response.status === 401) {
      this.token = null;
      return attempt();
    }
    return response;
  }

  /**
   * Fetch a library-item cover image server-side (bearer in a SERVER-SIDE header — never the browser). The
   * app cover PROXY streams the bytes. Returns the RAW Response so the caller decides on status (a 404 →
   * the fallback tile). Re-auths once on a 401.
   *
   * F-06 / ADR-041 idiom: ABS resizes + re-encodes covers UPSTREAM via `?width=&format=` (verified live
   * 2026-07-12: a ~20 KB JPEG original becomes a ~10–14 KB 300-wide WebP) — pass `variant` to request the
   * sized tile; omit it for the original (the proxy's per-image fallback tier).
   */
  async fetchItemCover(
    itemId: string,
    variant?: { width: number; format: 'webp' | 'jpeg' },
  ): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const query = variant ? `?width=${variant.width}&format=${variant.format}` : '';
    const attempt = async (): Promise<Response> => {
      const token = await this.bearerToken();
      const url = `${this.baseUrl}/api/items/${encodeURIComponent(itemId)}/cover${query}`;
      return fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'image/*' },
        signal: AbortSignal.timeout(10_000),
      });
    };
    const response = await attempt();
    if (response.status === 401) {
      this.token = null;
      return attempt();
    }
    return response;
  }
}

// ---------------------------------------------------------------------------
// Env factory
// ---------------------------------------------------------------------------

export interface BooksReadClients {
  kavita: KavitaClient;
  audiobookshelf: AudiobookshelfClient;
}

/** Build both read clients from a resolved BooksEnvConfig (see assertBooksEnv). */
export function booksReadClients(
  config: {
    kavita: { baseUrl: string; username: string; password: string };
    audiobookshelf: { baseUrl: string; username: string; password: string };
  },
  fetchImpl?: typeof fetch,
): BooksReadClients {
  return {
    kavita: new KavitaClient({ ...config.kavita, ...(fetchImpl ? { fetchImpl } : {}) }),
    audiobookshelf: new AudiobookshelfClient({
      ...config.audiobookshelf,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  };
}
