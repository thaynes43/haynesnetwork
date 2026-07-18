// ADR-070 / DESIGN-043 (PLAN-052) — the READ surface for Libretto (@hnet/libretto/read). Lists recipes
// (+ the invalid-file issues[]), produced collections, and run state, and RESOLVES a draft ref through
// POST /api/validate for the composer's preview (ADR-070 C-07). Import-unrestricted (reads are safe
// everywhere); the mutating surface lives in ./write and is import-confined to packages/domain (the
// @hnet/lazylibrarian precedent). Every method surfaces LibrettoUnreachableError untouched so the manager
// can degrade to its honest `unreachable` state (ADR-070 C-09).
import { LibrettoHttp, type LibrettoHttpOptions } from './http';
import {
  librettoCollectionsResponseSchema,
  librettoHealthResponseSchema,
  librettoMissingResponseSchema,
  librettoPreviewResponseSchema,
  librettoRecipeDraftSchema,
  librettoRecipesResponseSchema,
  librettoResolveResponseSchema,
  librettoRunSchema,
  librettoSearchResponseSchema,
  librettoValidateResponseSchema,
  type LibrettoCollection,
  type LibrettoIssue,
  type LibrettoMissingResponse,
  type LibrettoPreviewResponse,
  type LibrettoRecipe,
  type LibrettoRecipeDraft,
  type LibrettoResolved,
  type LibrettoRun,
  type LibrettoSearchResponse,
  type LibrettoValidateResponse,
} from './schemas';

/** The shape the resolve broker accepts (`POST /api/resolve`). At least one of isbn/title/identifiers. */
export interface LibrettoResolveRequest {
  isbn?: string;
  title?: string;
  author?: string;
  identifiers?: string[];
}

/** Typeahead search parameters (`GET /api/search`). `q` is the free text; `limit` caps the hits. */
export interface LibrettoSearchRequest {
  /** The builder type whose ref is being searched (e.g. `hardcover_series`, `nyt_list`). */
  type: string;
  q: string;
  limit?: number;
}

/**
 * A DRAFT builder to preview (`POST /api/preview`). `ref` is a string for hardcover_series/nyt_list and
 * a string array for static_ids — passed through to Libretto, which validates and 400s a bad shape.
 */
export interface LibrettoPreviewRequest {
  builder: { type: string; ref: string | number | string[] };
  limit?: number;
}

/** Options shared by the read + write clients (mirrors LazyLibrarianClientOptions). */
export type LibrettoClientOptions = LibrettoHttpOptions;

export interface LibrettoRecipesResult {
  recipes: LibrettoRecipe[];
  /** Invalid recipe FILES (never valid recipes) — surfaced in the manager's "needs attention" band. */
  issues: LibrettoIssue[];
}

export class LibrettoReadClient {
  private readonly http: LibrettoHttp;

  constructor(options: LibrettoClientOptions) {
    this.http = new LibrettoHttp(options);
  }

  /** `GET /api/recipes` → `{ recipes, issues }` (invalid recipe files land in issues[], never recipes[]). */
  async listRecipes(): Promise<LibrettoRecipesResult> {
    const raw = await this.http.requestParsed(
      { method: 'GET', path: '/api/recipes' },
      librettoRecipesResponseSchema,
    );
    return { recipes: raw.recipes ?? [], issues: raw.issues ?? [] };
  }

  /** `GET /api/collections` — the collections Libretto PRODUCED (read back from the targets). */
  async listCollections(): Promise<LibrettoCollection[]> {
    const raw = await this.http.requestParsed(
      { method: 'GET', path: '/api/collections' },
      librettoCollectionsResponseSchema,
    );
    return raw.collections ?? [];
  }

  /**
   * `GET /api/collections/:recipeId/missing` — the recipe's wanted-but-unheld member IDENTITIES
   * (title/author/ISBN/identifier refs) plus held/missing counts. This is the member-level data the
   * books Wanted-tiles need: enough per missing book to mint one `book_requests` row (the collections
   * agent owns the wanted-tile UI + the origin-minting; this method only surfaces the data). A recipe
   * with no missing members returns `missing: []`. `recipeId` is path-encoded.
   */
  async listMissingMembers(recipeId: string): Promise<LibrettoMissingResponse> {
    return this.http.requestParsed(
      { method: 'GET', path: `/api/collections/${encodeURIComponent(recipeId)}/missing` },
      librettoMissingResponseSchema,
    );
  }

  /**
   * `POST /api/resolve` — the ISBN-first resolve broker (M3 direction-a): resolve an ISBN|title+author to
   * a Google-Books volume id (the LazyLibrarian addBook key), ISBN-first with a guarded title fallback.
   * Mutates nothing. Returns the resolved volume (or `null` on an honest no-match). A `LibrettoHttpError`
   * with status 503 means the broker is not configured Libretto-side (GOOGLE_BOOKS_API_KEY unset).
   */
  async resolve(request: LibrettoResolveRequest): Promise<LibrettoResolved | null> {
    const raw = await this.http.requestParsed(
      { method: 'POST', path: '/api/resolve', body: request },
      librettoResolveResponseSchema,
    );
    return raw.resolved;
  }

  /**
   * `GET /api/search?type=&q=&limit=` — typeahead for a builder's ref: find a series/list by NAME so a
   * user never pastes a slug. `hardcover_series` proxies Hardcover's series search; `nyt_list` filters the
   * built-in list names; `static_ids` returns none (free-form). Result counts are capped Libretto-side
   * (the caller owns debounce). An unknown type is a `LibrettoHttpError` 400; an unconfigured source (503)
   * is transient in the shared http wrapper and surfaces as `LibrettoUnreachableError` — the field shows
   * an honest "search unavailable" note either way.
   */
  async search(request: LibrettoSearchRequest): Promise<LibrettoSearchResponse> {
    const params = new URLSearchParams({ type: request.type, q: request.q });
    if (request.limit !== undefined) params.set('limit', String(request.limit));
    return this.http.requestParsed(
      { method: 'GET', path: `/api/search?${params.toString()}` },
      librettoSearchResponseSchema,
    );
  }

  /**
   * `POST /api/preview` — the MEMBER-LEVEL identities a draft builder would resolve to (the full
   * membership a run would produce, NOT just the missing ones), so the app can split held vs missing
   * against its own mirrors (books_items) BEFORE save + drive the cap meter. Mutates nothing. Bounded at
   * 100 members with an honest `truncated` flag; a 0-member container slug returns `total: 0`. A
   * `LibrettoHttpError` 502 means the builder source is unavailable (e.g. HARDCOVER_TOKEN unset).
   */
  async preview(request: LibrettoPreviewRequest): Promise<LibrettoPreviewResponse> {
    return this.http.requestParsed(
      { method: 'POST', path: '/api/preview', body: request },
      librettoPreviewResponseSchema,
    );
  }

  /** `GET /api/runs/:id` — one run's state + counts (Libretto keeps only the last 50 — DESIGN-037 D-03). */
  async getRun(runId: string): Promise<LibrettoRun> {
    return this.http.requestParsed(
      { method: 'GET', path: `/api/runs/${encodeURIComponent(runId)}` },
      librettoRunSchema,
    );
  }

  /**
   * `POST /api/validate` — validate a draft recipe (schema + ref resolution + target reachability),
   * mutating NOTHING. The composer's ref PREVIEW (ADR-070 C-07): a resolved name + work count when
   * Libretto can resolve the builder ref, plus any blocking issues. A 0-work container-series slug comes
   * back resolved with workCount 0 (the honest silent-failure guard) — the UI surfaces it, never fabricates.
   */
  async validateRecipe(draft: LibrettoRecipeDraft): Promise<LibrettoValidateResponse> {
    const parsed = librettoRecipeDraftSchema.parse(draft);
    return this.http.requestParsed(
      { method: 'POST', path: '/api/validate', body: parsed },
      librettoValidateResponseSchema,
    );
  }

  /** `GET /api/health` — liveness probe. Returns true on any 2xx; a LibrettoUnreachableError means down. */
  async health(): Promise<boolean> {
    await this.http.requestParsed(
      { method: 'GET', path: '/api/health' },
      librettoHealthResponseSchema,
    );
    return true;
  }
}

export function librettoReadClient(options: LibrettoClientOptions): LibrettoReadClient {
  return new LibrettoReadClient(options);
}
