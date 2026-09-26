// The production dependencies of the MCP handler: the lazy app database and the clients built once from env.
// Plex is sized per use (DESIGN-049 D-11: 300 ms per revalidation read; D-14: ≈ 800 ms per mark attempt, a
// mark keeps the GET retries; DESIGN-051 D-15ab: one 1.5 s attempt for a Watchlist Change's catalog lookup and its
// re-read); missing Plex or TMDB configuration degrades (revalidation skipped, a mark recorded as failed in Plex,
// no TMDB fallback) instead of failing the call.
import { resolveTmdbConfig } from '@hnet/arr';
import { TmdbClient } from '@hnet/arr/read';
import { db } from '@hnet/db';
import { plexClientBundleFromEnv, type PlexBundleTuning, type PlexClientBundle } from '@hnet/domain';
import type { McpDeps } from './answers';

const REVALIDATE_TIMEOUT_MS = 300;
const MARK_TIMEOUT_MS = 800;
const MARK_RETRY_DELAY_MS = 100;
const TMDB_TIMEOUT_MS = 1_500;

/**
 * DESIGN-051 D-15ab — the discover bundle's tuning. plex.tv's `matches` answers a long-running show in 0.3 to 1.3 s,
 * warm or cold (measured 2026-09-26: Law & Order SVU 634 to 1,102 ms, CSI up to 1,274 ms), so the catalog lookup gets
 * one attempt of 1.5 s (a retry on the same slow endpoint would not beat it), and so does the re-read after a failed
 * PUT.
 */
export const DISCOVER_PLEX_TUNING: Readonly<Required<PlexBundleTuning>> = {
  timeoutMs: 1_500,
  retryDelayMs: 0,
  getRetries: 0,
};

function lazy<T>(build: () => T | null): () => T | null {
  let built = false;
  let value: T | null = null;
  return () => {
    if (!built) {
      try {
        value = build();
      } catch {
        value = null; // e.g. a missing PLEX_*_TOKEN — the calls degrade, the error is not the caller's
      }
      built = true;
    }
    return value;
  };
}

/**
 * The TMDB search built from env, or null when TMDB is not configured. The resolver's last resort (DESIGN-049 D-13)
 * keeps the client's GET retries; `once` makes a single attempt, for `set_watchlist` (DESIGN-051 D-15g: with the
 * discover reads, the PUT and its re-read, the add's worst case stays inside the 9 s deadline) and for any tool's
 * call made while the pool already has an answer (D-15aa: `mark_watched`'s Plex work follows it). Each attempt's
 * timer covers the response body too (D-15p): a body that stalled after its headers otherwise held the call, and
 * the write it leads to, for undici's 300 s body timeout, long after the caller was answered.
 */
export function tmdbSearchFromEnv(
  env: Record<string, string | undefined>,
  opts: { once: boolean; fetchImpl?: typeof fetch },
): TmdbClient | null {
  const cfg = resolveTmdbConfig(env);
  if (!cfg) return null;
  return new TmdbClient({
    ...cfg,
    timeoutMs: TMDB_TIMEOUT_MS,
    retryDelayMs: 0,
    timeoutCoversBody: true,
    ...(opts.once ? { getRetries: 0 } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

let cached: McpDeps | undefined;

export function defaultDeps(): McpDeps {
  cached ??= {
    db,
    revalidatePlex: lazy<PlexClientBundle>(() =>
      plexClientBundleFromEnv(process.env, { timeoutMs: REVALIDATE_TIMEOUT_MS, retryDelayMs: 0 }),
    ),
    markPlex: lazy<PlexClientBundle>(() =>
      plexClientBundleFromEnv(process.env, { timeoutMs: MARK_TIMEOUT_MS, retryDelayMs: MARK_RETRY_DELAY_MS }),
    ),
    discoverPlex: lazy<PlexClientBundle>(() => plexClientBundleFromEnv(process.env, { ...DISCOVER_PLEX_TUNING })),
    tmdb: lazy(() => tmdbSearchFromEnv(process.env, { once: false })),
    // DESIGN-051 D-15g: `set_watchlist`'s fallback makes ONE attempt, so its worst case (with the
    // discover reads, the PUT and its re-read) stays inside the 9 s deadline; D-15aa: so does every tool's call
    // made while the pool already has an answer.
    tmdbOnce: lazy(() => tmdbSearchFromEnv(process.env, { once: true })),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
  return cached;
}
