// ADR-018 / DESIGN-008 D-14 — a stub Tautulli (/api/v2) for hermetic watch-stats harvest tests.
// OPTIONAL: it is NOT wired into the default stack env (composeRuntimeEnv sets no TAUTULLI_* keys),
// so the metadata-refresh Tautulli tier stays skipped and the existing e2e specs are unaffected.
// A future harvest spec starts this inline and points TAUTULLI_API_KEY/TAUTULLI_URL at it.
import { createServer, type Server } from 'node:http';

export const STUB_TAUTULLI_API_KEY = 'stub-tautulli-key';

export interface StubTautulliServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** A minimal history + metadata dataset: one movie (tmdb 880001) watched twice, one episode
 *  (its series tvdb 990001) watched once. Enough to exercise the SUM/MAX aggregation + the
 *  guid join to media_items. */
const HISTORY = [
  { rating_key: 9001, grandparent_rating_key: null, media_type: 'movie', date: 1_700_000_000, stopped: 1_700_003_600, watched_status: 1, user: 'manofoz' },
  { rating_key: 9001, grandparent_rating_key: null, media_type: 'movie', date: 1_700_100_000, stopped: 1_700_103_600, watched_status: 1, user: 'manofoz' },
  { rating_key: 9110, grandparent_rating_key: 9100, media_type: 'episode', date: 1_700_200_000, stopped: 1_700_202_600, watched_status: 1, user: 'helmu15' },
];
const METADATA: Record<string, { guids: string[] }> = {
  '9001': { guids: ['tmdb://880001', 'imdb://tt8800010'] },
  '9100': { guids: ['tvdb://990001', 'tmdb://55501'] }, // the episode's SERIES
};

export async function startStubTautulli(): Promise<StubTautulliServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cmd = url.searchParams.get('cmd');
    const send = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: { result: 'success', message: null, data } }));
    };
    if (url.pathname !== '/api/v2') {
      res.writeHead(404);
      return res.end();
    }
    if (cmd === 'get_history') return send({ data: HISTORY, recordsFiltered: HISTORY.length });
    if (cmd === 'get_metadata') {
      const key = url.searchParams.get('rating_key') ?? '';
      return send(METADATA[key] ?? {});
    }
    return send({});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-tautulli failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
