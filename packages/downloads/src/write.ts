// @hnet/downloads/write — the WRITE surface (the MAM-governor gate seam). ADR-054: the ONLY sanctioned
// downloads-stack write is TOGGLING the MyAnonaMouse Prowlarr indexer's `enable` flag (pause the torrent
// fallback near the rank cap; resume when headroom returns). This entrypoint may be imported ONLY by
// packages/domain (the governor evaluator) — enforced by the arr-write-import-guard test, extended to cover
// `@hnet/downloads/write`. Exercised exclusively via fetch stubs in tests; never in @hnet/sync.
//
// Seam choice (ADR-054 C-01): Prowlarr's OWN indexer `enable` flag, NOT the LazyLibrarian provider toggle.
// Prowlarr owns LL's provider entries through its LazyLibrarian application (syncLevel=fullSync, verified
// live): a manual LL-side `enabled` edit is CLOBBERED by the next fullSync (it re-enabled a manually
// disabled provider within the hour), so the LL-side seam is NOT durable. Disabling the Prowlarr indexer,
// by contrast, TRIGGERS a fullSync that propagates `enabled=false` down to LL's Torznab_0 (verified live:
// within ~6s LL listNabProviders flips MAM Enabled 1→0 and config.ini drops the `enabled` line), so LL
// stops QUERYING the provider entirely — no failed Torznab searches, so LL's provider-failure blocklist is
// never tripped. Re-enabling propagates back cleanly. Single durable seam, blast radius = the MAM indexer.
//
// GET-then-PUT discipline (owner ruling 2026-07-11 (d)): the toggle GETs the FULL indexer object and PUTs
// it back with ONLY `enable` changed — it never rewrites priority/fields/categories (Prowlarr indexer
// priority is owner-tuned to 50 to pin usenet-first via the LL dlpriority = 51 − priority mapping).
import { z } from 'zod';
import { DownloadsHttpError } from './errors';
import { ProwlarrReadClient, type ProwlarrReadClientOptions } from './read';

/** Prowlarr's PUT echoes the updated indexer; we only assert `enable` came back as requested. */
const prowlarrPutEchoSchema = z.object({ enable: z.boolean().optional() }).passthrough();

export type ProwlarrWriteClientOptions = ProwlarrReadClientOptions;

/**
 * The confined Prowlarr WRITE client. Its ONE method flips the MAM indexer's `enable` flag via a
 * GET-then-PUT of the full indexer object (`GET /api/v1/indexer/{id}` → set `enable` → `PUT
 * /api/v1/indexer/{id}`, verified live: PUT → HTTP 202). A non-2xx (or a non-boolean echo) throws so the
 * governor never records a gate change that did not actually take. Idempotent: PUTting the current value
 * back is a harmless no-op the evaluator avoids by reading first.
 */
export class ProwlarrWriteClient extends ProwlarrReadClient {
  constructor(options: ProwlarrWriteClientOptions) {
    super(options);
  }

  /** GET the indexer, set ONLY `enable`, PUT the full object back. */
  async setIndexerEnabled(indexerId: number, enabled: boolean): Promise<void> {
    const current = await this.getIndexer(indexerId);
    const body = { ...current, enable: enabled };
    const url = `${this.base}/api/v1/indexer/${indexerId}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-Api-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DownloadsHttpError(
        url,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) throw new DownloadsHttpError(url, res.status);
    // Prowlarr PUT echoes the updated indexer; confirm the flag took (a 200/202 with the old value would
    // be a phantom success). An empty/near-empty body is tolerated (some builds 202 with no echo).
    const raw = await res.text();
    if (raw.trim() !== '') {
      const parsed = prowlarrPutEchoSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.enable !== undefined && parsed.data.enable !== enabled) {
        throw new DownloadsHttpError(
          url,
          res.status,
          `indexer enable did not take (wanted ${enabled}, got ${parsed.data.enable})`,
        );
      }
    }
  }
}
