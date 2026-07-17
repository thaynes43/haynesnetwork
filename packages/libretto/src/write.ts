// @hnet/libretto/write — the WRITE surface (ADR-069 C-01, read/write split). The ONLY sanctioned Libretto
// mutations: upsert a recipe (validate-first is the CALLER's job — DESIGN-042 D-03; PUT is idempotent,
// strictObject → a 400 with per-path issues surfaced as LibrettoHttpError.issues), delete a recipe (does
// NOT cascade — orphans the target collection unless ?deleteCollection=true; ADR-069 C-08), and apply a
// scope (async → 202 { runId }). This entrypoint may be imported ONLY by the packages/domain collections
// orchestrator and by packages/libretto itself — enforced by the arr-write-import-guard test (extended for
// @hnet/libretto/write). These are the CONTENT-PULLING writes: NEVER reached from the browser — every call
// goes through a role-gated tRPC procedure.
import { LibrettoHttp } from './http';
import type { LibrettoClientOptions } from './read';
import {
  librettoApplyResponseSchema,
  librettoRecipeDraftSchema,
  type LibrettoRecipeDraft,
} from './schemas';

export class LibrettoWriteClient {
  private readonly http: LibrettoHttp;

  constructor(options: LibrettoClientOptions) {
    this.http = new LibrettoHttp(options);
  }

  /**
   * `PUT /api/recipes/:id` — idempotent save. Libretto validates against its strictObject schema and
   * writes the YAML file (the ONLY way Libretto touches its own config, DESIGN-037 D-01). An unknown key
   * or bad shape comes back 400 with per-path issues (LibrettoHttpError.issues) — surface them, do not
   * swallow. `acquisitionEnabled` inside variables is the content-pull knob — the caller must be
   * `acquire`-gated to set it true (enforced in the domain orchestrator, re-checked server-side).
   */
  async upsertRecipe(draft: LibrettoRecipeDraft): Promise<void> {
    const parsed = librettoRecipeDraftSchema.parse(draft);
    await this.http.requestJson({
      method: 'PUT',
      path: `/api/recipes/${encodeURIComponent(parsed.id)}`,
      body: parsed,
    });
  }

  /**
   * `DELETE /api/recipes/:id[?deleteCollection=true]` — remove the recipe YAML. By DEFAULT the produced
   * collection SURVIVES in the target orphaned (marker present, no recipe) — the UI warns about this
   * (ADR-069 C-08). `deleteCollection: true` also deletes the target collection.
   */
  async deleteRecipe(id: string, opts?: { deleteCollection?: boolean }): Promise<void> {
    const q = opts?.deleteCollection ? '?deleteCollection=true' : '';
    await this.http.requestJson({
      method: 'DELETE',
      path: `/api/recipes/${encodeURIComponent(id)}${q}`,
    });
  }

  /**
   * `POST /api/apply { scope }` → 202 `{ runId }` — kick an async, serialized reconcile. `scope` is
   * `'all'` or a recipe id. Returns the runId so the caller can poll `GET /api/runs/:id` (read client).
   */
  async applyScope(scope: string): Promise<string> {
    const raw = await this.http.requestParsed(
      { method: 'POST', path: '/api/apply', body: { scope } },
      librettoApplyResponseSchema,
    );
    return raw.runId;
  }
}

export function librettoWriteClient(options: LibrettoClientOptions): LibrettoWriteClient {
  return new LibrettoWriteClient(options);
}
