// ADR-046 / DESIGN-024 (PLAN-023) — the READ-ONLY Kavita + Audiobookshelf clients (@hnet/books/read).
// There is deliberately NO write client and NO ./write export: Kavita/ABS are the source of truth for
// book media (hard rule 4 extension); the app only reads (sync IN + authed cover proxy). Both clients
// manage a session token (Kavita JWT + apiKey, ABS bearer) with lazy login + one 401 re-auth.
import {
  absItemsPageSchema,
  absLibrariesSchema,
  absLoginSchema,
  kavitaLibrarySchema,
  kavitaLoginSchema,
  kavitaSeriesListSchema,
  type AbsItem,
  type AbsLibrary,
  type KavitaLibrary,
  type KavitaSeries,
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

export interface KavitaSeriesPage {
  items: KavitaSeries[];
  total: number;
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
    let total = items.length;
    const header = response.headers.get('Pagination');
    if (header) {
      const parsed = paginationHeaderSchema.safeParse(JSON.parse(header));
      if (parsed.success && typeof parsed.data.totalItems === 'number') total = parsed.data.totalItems;
    }
    return { items, total };
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

  async listItemsPage(libraryId: string, page: number, limit: number): Promise<AbsItemsPageResult> {
    const path = `/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${limit}&page=${page}`;
    const response = await this.authed(path);
    const parsed = await parseJson(response, absItemsPageSchema, 'GET', path);
    return { items: parsed.results, total: parsed.total ?? parsed.results.length };
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
