// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the BOOKS activity client bundle: the LL read
// (wanted table) + SAB read (queue/history) that feed the pure normalizer, plus the confined LL write
// (`forceProcess`/`searchBook`) the Admin actions fire. `@hnet/lazylibrarian/write` is import-guarded to
// packages/domain (the arr-write-import-guard); the API/sync layers receive this bundle as an opaque type
// and inject fetch-stubbed clients in tests — the plex-clients / mam-clients precedent.
import { assertLazyLibrarianEnv } from '@hnet/lazylibrarian';
import { LazyLibrarianReadClient, type LazyLibrarianClientOptions } from '@hnet/lazylibrarian/read';
import { LazyLibrarianWriteClient } from '@hnet/lazylibrarian/write';
import { assertSabnzbdEnv } from '@hnet/downloads';
import { SabnzbdReadClient } from '@hnet/downloads/read';
import { buildBooksActivity, BOOKS_ACTIVITY_SOURCE } from './books-adapter';
import type { ActivitySourceAdapter } from './contract';

/** The read clients the books adapter reads through (tests inject fetch-stubbed instances). */
export interface BooksActivityReadClients {
  ll: Pick<LazyLibrarianReadClient, 'getWanted'>;
  sab: Pick<SabnzbdReadClient, 'getQueue' | 'getHistory'>;
}

export interface BooksActivityAdapterOptions {
  llBaseUrl?: string | null;
  sabBaseUrl?: string | null;
  strandHorizonMs?: number;
  now?: () => Date;
}

/**
 * Build the books ActivitySourceAdapter — its `list()` reads the LL wanted table + the SAB queue/history
 * LIVE and folds them through the pure normalizer. A read failure propagates so the aggregator can degrade
 * the books source without failing the whole read.
 */
export function buildBooksActivityAdapter(
  clients: BooksActivityReadClients,
  opts: BooksActivityAdapterOptions = {},
): ActivitySourceAdapter {
  return {
    source: BOOKS_ACTIVITY_SOURCE,
    async list() {
      const [llWanted, sabQueue, sabHistory] = await Promise.all([
        clients.ll.getWanted(),
        clients.sab.getQueue(),
        clients.sab.getHistory(),
      ]);
      return buildBooksActivity(
        { llWanted, sabQueue, sabHistory },
        {
          now: (opts.now ?? (() => new Date()))(),
          ...(opts.strandHorizonMs !== undefined ? { strandHorizonMs: opts.strandHorizonMs } : {}),
          llBaseUrl: opts.llBaseUrl ?? null,
          sabBaseUrl: opts.sabBaseUrl ?? null,
        },
      );
    },
  };
}

/** The full books activity bundle: the adapter (reads) + the confined LL write (retry-import/force-search). */
export interface BooksActivityBundle {
  adapter: ActivitySourceAdapter;
  write: LazyLibrarianWriteClient;
}

/** Build the bundle from explicit LL options + a SAB read client (tests inject fetch stubs). */
export function buildBooksActivityBundle(input: {
  llOptions: LazyLibrarianClientOptions;
  sab: SabnzbdReadClient;
  adapterOptions?: BooksActivityAdapterOptions;
}): BooksActivityBundle {
  const read = new LazyLibrarianReadClient(input.llOptions);
  const adapter = buildBooksActivityAdapter({ ll: read, sab: input.sab }, input.adapterOptions ?? {});
  return { adapter, write: new LazyLibrarianWriteClient(input.llOptions) };
}

/**
 * Build the books activity bundle from the env contract: `LAZYLIBRARIAN_URL`/`LAZYLIBRARIAN_API_KEY` +
 * `SABNZBD_URL`/`SABNZBD_API_KEY`. A missing required key throws a config error naming the absent variable
 * (never its value). The downstream deep-link base URLs default to the same in-cluster service URLs.
 */
export function booksActivityBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): BooksActivityBundle {
  const ll = assertLazyLibrarianEnv(env);
  const sab = assertSabnzbdEnv(env);
  return buildBooksActivityBundle({
    llOptions: { baseUrl: ll.baseUrl, apiKey: ll.apiKey },
    sab: new SabnzbdReadClient({ baseUrl: sab.baseUrl, apiKey: sab.apiKey }),
    adapterOptions: { llBaseUrl: ll.baseUrl, sabBaseUrl: sab.baseUrl },
  });
}
