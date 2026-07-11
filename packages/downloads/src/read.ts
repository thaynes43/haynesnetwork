// @hnet/downloads/read — the READ surface the MAM compliance governor consumes (ADR-054 / DESIGN-027,
// PLAN-039). Two read clients, both safe everywhere (no mutation):
//   • QbittorrentClient    — counts UNSATISFIED torrents in the `books-mam` category (the cap check).
//   • ProwlarrReadClient   — reads the MAM indexer's current `enable` state (the gate readback).
// Neither touches MyAnonaMouse: counting is 100% local to qBittorrent, and the gate readback is Prowlarr's
// own indexer config — so the governor adds ZERO MAM API surface (the compliance invariant: automation
// stays "Prowlarr search + dynamicSeedbox.php" only; toggling an indexer's enable is a local Prowlarr
// config change that makes no MAM call).
import { z } from 'zod';
import { DownloadsHttpError } from './errors';

/** MAM's ebook seed obligation: 72 hours (in seconds). A torrent that has SEEDED this long is satisfied. */
export const MAM_SEED_OBLIGATION_SECONDS = 72 * 60 * 60; // 259_200

// ---------------------------------------------------------------------------
// qBittorrent — the local unsatisfied count
// ---------------------------------------------------------------------------

/**
 * The subset of a `GET /api/v2/torrents/info` row the count needs. Extra keys are stripped; a MISSING or
 * malformed field defaults to the CONSERVATIVE side (progress 0 ⇒ "downloading" ⇒ unsatisfied;
 * seeding_time 0 ⇒ "< 72h" ⇒ unsatisfied) so a wire hiccup can only OVER-count (close the gate earlier),
 * never under-count.
 */
const qbTorrentSchema = z.object({
  state: z.string().optional(),
  seeding_time: z.number().optional(),
  progress: z.number().optional(),
});
const qbTorrentsSchema = z.array(qbTorrentSchema);

export interface UnsatisfiedCounts {
  /** Torrents in the counted category. */
  total: number;
  /** Not yet complete (progress < 1) — conservatively unsatisfied (owner ruling Q-01). */
  downloading: number;
  /** Complete but with < 72h accumulated ACTIVE seed time (qB `seeding_time`). */
  seedingUnder72: number;
  /** downloading + seedingUnder72 — the count the governor gates against the rank cap. */
  unsatisfied: number;
}

/** Fold a torrents-info array into the unsatisfied breakdown. PURE + unit-tested. */
export function computeUnsatisfied(
  torrents: Array<{ progress?: number; seeding_time?: number }>,
): UnsatisfiedCounts {
  let downloading = 0;
  let seedingUnder72 = 0;
  for (const t of torrents) {
    const complete = (t.progress ?? 0) >= 1;
    if (!complete) {
      downloading += 1;
      continue;
    }
    if ((t.seeding_time ?? 0) < MAM_SEED_OBLIGATION_SECONDS) seedingUnder72 += 1;
  }
  return {
    total: torrents.length,
    downloading,
    seedingUnder72,
    unsatisfied: downloading + seedingUnder72,
  };
}

export interface QbittorrentClientOptions {
  baseUrl: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). The governor fails CLOSED on any error, so keep this short. */
  timeoutMs?: number;
}

/**
 * The read-only qBittorrent WebAPI client. Speaks ONLY `GET /api/v2/torrents/info?category=…`. qB's
 * WebAPI answers unauthenticated from the cluster pod network (verified live 2026-07-11 from the
 * `frontend` namespace: `GET /api/v2/app/version` → 200 `v5.2.1`), so NO credential is carried. If qB
 * ever begins requiring auth, the request 4xxs → the governor's count throws → the mode fails closed
 * (gate closed) — the intended safe failure.
 */
export class QbittorrentClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: QbittorrentClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Count unsatisfied (not-yet-72h-seeded + still-downloading) torrents in `category`. */
  async countUnsatisfied(category: string): Promise<UnsatisfiedCounts> {
    const url = `${this.base}/api/v2/torrents/info?category=${encodeURIComponent(category)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
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
    const parsed = qbTorrentsSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new DownloadsHttpError(
        url,
        res.status,
        `unexpected torrents/info shape: ${parsed.error.message}`,
      );
    }
    return computeUnsatisfied(parsed.data);
  }
}

// ---------------------------------------------------------------------------
// Prowlarr — the MAM indexer's enable-state readback (the gate seam readback)
// ---------------------------------------------------------------------------

/**
 * The subset of `GET /api/v1/indexer/{id}` the governor reads. The FULL object is preserved verbatim by
 * the write client's GET-then-PUT (so only `enable` changes) — this schema just surfaces `enable`
 * (+ id/name for logging). `.passthrough()` keeps every other field for the write round-trip.
 */
const prowlarrIndexerSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    enable: z.boolean(),
  })
  .passthrough();

/** A Prowlarr indexer object as returned by GET (opaque bag of fields the write path round-trips). */
export type ProwlarrIndexer = z.infer<typeof prowlarrIndexerSchema>;

export interface ProwlarrReadClientOptions {
  baseUrl: string;
  /** Prowlarr's API key — required (auth header `X-Api-Key`). Never echoed in errors. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The read-only Prowlarr client. Reads the MAM indexer's current `enable` state (the gate readback) via
 * `GET /api/v1/indexer/{id}`. Prowlarr OWNS LazyLibrarian's provider entries through its LazyLibrarian
 * application (syncLevel=fullSync, verified live) — so the indexer's `enable` flag is the DURABLE source of
 * truth for the gate (a manual LL-side toggle is clobbered by the next fullSync; the Prowlarr flag is not).
 */
export class ProwlarrReadClient {
  protected readonly base: string;
  protected readonly apiKey: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;

  constructor(options: ProwlarrReadClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** `GET /api/v1/indexer/{id}` — return the full indexer object (validated to carry a boolean `enable`). */
  async getIndexer(indexerId: number): Promise<ProwlarrIndexer> {
    const url = `${this.base}/api/v1/indexer/${indexerId}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'X-Api-Key': this.apiKey },
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
    const parsed = prowlarrIndexerSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new DownloadsHttpError(
        url,
        res.status,
        `unexpected indexer shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** Convenience: is the MAM indexer currently enabled? Throws (state unknown) on any read failure. */
  async getIndexerEnabled(indexerId: number): Promise<boolean> {
    return (await this.getIndexer(indexerId)).enable;
  }
}
