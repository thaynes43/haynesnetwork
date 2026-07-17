// ADR-069 / DESIGN-042 (PLAN-052) — the READ surface for Libretto (@hnet/libretto/read). Lists recipes
// (+ the invalid-file issues[]), produced collections, and run state, and RESOLVES a draft ref through
// POST /api/validate for the composer's preview (ADR-069 C-07). Import-unrestricted (reads are safe
// everywhere); the mutating surface lives in ./write and is import-confined to packages/domain (the
// @hnet/lazylibrarian precedent). Every method surfaces LibrettoUnreachableError untouched so the manager
// can degrade to its honest `unreachable` state (ADR-069 C-09).
import { LibrettoHttp, type LibrettoHttpOptions } from './http';
import {
  librettoCollectionsResponseSchema,
  librettoHealthResponseSchema,
  librettoRecipeDraftSchema,
  librettoRecipesResponseSchema,
  librettoRunSchema,
  librettoValidateResponseSchema,
  type LibrettoCollection,
  type LibrettoIssue,
  type LibrettoRecipe,
  type LibrettoRecipeDraft,
  type LibrettoRun,
  type LibrettoValidateResponse,
} from './schemas';

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

  /** `GET /api/runs/:id` — one run's state + counts (Libretto keeps only the last 50 — DESIGN-037 D-03). */
  async getRun(runId: string): Promise<LibrettoRun> {
    return this.http.requestParsed(
      { method: 'GET', path: `/api/runs/${encodeURIComponent(runId)}` },
      librettoRunSchema,
    );
  }

  /**
   * `POST /api/validate` — validate a draft recipe (schema + ref resolution + target reachability),
   * mutating NOTHING. The composer's ref PREVIEW (ADR-069 C-07): a resolved name + work count when
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
    await this.http.requestParsed({ method: 'GET', path: '/api/health' }, librettoHealthResponseSchema);
    return true;
  }
}

export function librettoReadClient(options: LibrettoClientOptions): LibrettoReadClient {
  return new LibrettoReadClient(options);
}
