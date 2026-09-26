// DESIGN-049 D-11 / D-14 / D-15 (+ DESIGN-051 D-03 / D-04, the watchlist) — the Plex surface the Watch Companion's domain flows use, narrowed to the
// calls they make. A full `PlexClientBundle` (plexClientBundleFromEnv) satisfies it; tests inject recording
// fakes. `@hnet/plex/write` stays confined to this package (ADR-017 C-10): nothing outside @hnet/domain
// constructs a write client — the MCP layer receives the bundle from here.
import type { PlexServerSlug } from '@hnet/db';
import { PlexHttpError } from '@hnet/plex';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexWriteClient } from '@hnet/plex/write';

/** The plex.tv discover reads of a Watchlist Change (ADR-092 / DESIGN-051 D-03 steps 3–4, D-06). */
export type WatchDiscoverRead = Pick<PlexReadClient, 'matchDiscover' | 'getDiscoverUserState'>;
/** The reads the watch flows make on one server (and, with its owner token, on plex.tv's discover provider). */
export type WatchPlexRead = Pick<PlexReadClient, 'getMetadataItem' | 'listAllLeaves' | 'findByGuid'> &
  WatchDiscoverRead;
/**
 * The owner writes: the two watched-state writes (a Watch Mark and its undo — never the sync) and — ADR-092 —
 * the two watchlist writes (a Watchlist Change and its undo).
 */
export type WatchPlexWrite = Pick<PlexWriteClient, 'scrobble' | 'unscrobble' | 'addToWatchlist' | 'removeFromWatchlist'>;

/** Per-server Plex clients for the watch flows. `PlexClientBundle` is assignable. */
export interface WatchPlexClients {
  read: Partial<Record<PlexServerSlug, WatchPlexRead>>;
  write: Partial<Record<PlexServerSlug, WatchPlexWrite>>;
}

/**
 * A read-only view on the SHORT live-read budget (DESIGN-049 D-11: ≈ 300 ms per attempt): the revalidation
 * reads, and the discover reads of a Watchlist Change (DESIGN-051 D-03, D-13).
 */
export interface WatchPlexReaders {
  read: Partial<Record<PlexServerSlug, Pick<PlexReadClient, 'getMetadataItem' | 'listAllLeaves'> & Partial<WatchDiscoverRead>>>;
}

/**
 * DESIGN-051 D-15ab — the plex.tv discover reads a Watchlist Change must not cut short, on their own budget (one
 * attempt of about 1.5 s): the catalog lookup (`matchDiscover`, which plex.tv answers in 0.3 to 1.3 s for a
 * long-running show, cold or warm) and the `userState` re-read after a failed PUT. A `PlexClientBundle` is assignable.
 */
export interface WatchDiscoverReaders {
  read: Partial<Record<PlexServerSlug, Partial<WatchDiscoverRead>>>;
}

/**
 * ADR-092 / DESIGN-051 D-03 step 6 — the owner token a watchlist call goes out with: HaynesOps, else HaynesTower
 * (the `watch` sync's order for the watchlist read). The watchlist is the owner's plex.tv account's, not a
 * server's, so any owner token reaches it; the first configured one is used (no fail-over on an error).
 */
export const WATCHLIST_TOKEN_ORDER: readonly PlexServerSlug[] = ['haynesops', 'haynestower'];

/** The first client of `clients` in {@link WATCHLIST_TOKEN_ORDER}, or null when neither is configured. */
export function watchlistClient<T>(clients: Partial<Record<PlexServerSlug, T>>): T | null {
  for (const slug of WATCHLIST_TOKEN_ORDER) {
    const c = clients[slug];
    if (c) return c;
  }
  return null;
}

/** Plex answered 404: the item is gone from that server. */
export function isPlexNotFound(error: unknown): boolean {
  return error instanceof PlexHttpError && error.status === 404;
}

/** A short, credential-free error line for `watch_marks.plex_error` (PlexErrors never carry the token). */
export function plexErrorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Run `tasks` with at most `limit` in flight; results keep input order. Never rejects. */
export async function settleLimited<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) continue;
      try {
        results[i] = { status: 'fulfilled', value: await task() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

/** Thrown by {@link withDeadline} when the budget ran out first. */
export class WatchBudgetExceeded extends Error {
  constructor() {
    super('watch revalidation budget exceeded');
    this.name = 'WatchBudgetExceeded';
  }
}

/**
 * Race `promise` against an absolute deadline (ms since the epoch). The losing request is not aborted —
 * its client timeout bounds it — the caller simply stops waiting (D-11: "on timeout the snapshot answers").
 */
export async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    promise.catch(() => {});
    throw new WatchBudgetExceeded();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WatchBudgetExceeded()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => {});
  }
}
