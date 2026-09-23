// The production dependencies of the MCP handler: the lazy app database and the clients built once from env.
// Plex is sized per use (DESIGN-049 D-11: 300 ms per revalidation read; D-14: ≈ 800 ms per mark attempt, a
// mark keeps the GET retries); missing Plex or TMDB configuration degrades (revalidation skipped, a mark
// recorded as failed in Plex, no TMDB fallback) instead of failing the call.
import { resolveTmdbConfig } from '@hnet/arr';
import { TmdbClient } from '@hnet/arr/read';
import { db } from '@hnet/db';
import { plexClientBundleFromEnv, type PlexClientBundle } from '@hnet/domain';
import type { McpDeps } from './answers';

const REVALIDATE_TIMEOUT_MS = 300;
const MARK_TIMEOUT_MS = 800;
const MARK_RETRY_DELAY_MS = 100;
const TMDB_TIMEOUT_MS = 1_500;

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
    tmdb: lazy(() => {
      const cfg = resolveTmdbConfig(process.env);
      return cfg ? new TmdbClient({ ...cfg, timeoutMs: TMDB_TIMEOUT_MS, retryDelayMs: 0 }) : null;
    }),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
  return cached;
}
