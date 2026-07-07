// ADR-023 / DESIGN-010 e2e — stub Maintainerr HTTP server (mirrors stub-arr). Serves the
// fixture-shaped READ endpoints the Trash flow resolves against (collections + paged content with
// sizes/deleteAfterDays, rules, rules/constants with all integrations configured, exclusions,
// settings, app/status, settings/test/plex) and accepts the WRITE endpoints (exclusion CRUD,
// collection handle/expedite), RECORDING every mutating call so specs can assert them. Wired into
// harness.ts / env.ts so both Playwright e2e and `pnpm dev:local` boot a complete Trash stack.
//
// Fixtures join the seed-ledger rows so the Trash UX exercises every guardian partition
// (DESIGN-010 D-09): The Fixture (tmdb 880001, recently watched → auto-protected), Stub Runner
// (tmdb 880002, dnd-tagged → already protected), Vanished Heist (tmdb 880004, cold → deletable),
// plus one item UNKNOWN to the ledger (tmdb 990009 → unverifiable/skipped). The TV collection
// holds Breaking Prod (tvdb 990001, requested → protected).
//
// Control endpoints:
//   GET  /_stub/calls         → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset         → 204 (clears calls + exclusions + handled items + integrations)
//   POST /_stub/integrations  → 204; body { name: 'radarr'|'sonarr'|'tautulli'|'overseerr'|'plex',
//                               connected: boolean } — degrade/restore one integration so specs
//                               can flip the safety banner (trash.status derives connectivity
//                               from rules/constants applications + the Plex test — D-04).
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RecordedMaintainerrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubMaintainerrServer {
  baseUrl: string;
  port: number;
  calls: RecordedMaintainerrWrite[];
  stop: () => Promise<void>;
}

/** The throwaway key the stub Maintainerr accepts (never a real credential). */
export const STUB_MAINTAINERR_API_KEY = 'stub-maintainerr-key';

/** Seed-joined Maintainerr ids (Plex ratingKeys) — exported for spec assertions. */
export const STUB_MAINT_FIXTURE_ID = 'ms-880001'; // The Fixture — recently watched
export const STUB_MAINT_RUNNER_ID = 'ms-880002'; // Stub Runner — dnd-tagged
export const STUB_MAINT_VANISHED_ID = 'ms-880004'; // Vanished Heist — cold (deletable)
export const STUB_MAINT_UNKNOWN_ID = 'ms-990009'; // not in the ledger — unverifiable
export const STUB_MAINT_TV_ID = 'ms-990001'; // Breaking Prod — requested

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface StubCollection {
  id: number;
  title: string;
  isActive: boolean;
  deleteAfterDays: number;
  type: string;
  items: Array<{
    mediaServerId: string;
    tmdbId?: number;
    tvdbId?: number;
    sizeBytes: number;
    addDate: string;
  }>;
}

/** Fresh fixture state (addDates are relative so scheduled-delete stays in the future). */
function freshCollections(): StubCollection[] {
  return [
    {
      id: 7,
      title: 'Least watched movies',
      isActive: true,
      deleteAfterDays: 30,
      type: 'movie',
      items: [
        {
          mediaServerId: STUB_MAINT_FIXTURE_ID,
          tmdbId: 880001,
          sizeBytes: 4_294_967_296,
          addDate: daysAgo(5),
        },
        {
          mediaServerId: STUB_MAINT_RUNNER_ID,
          tmdbId: 880002,
          sizeBytes: 8_589_934_592,
          addDate: daysAgo(10),
        },
        {
          mediaServerId: STUB_MAINT_VANISHED_ID,
          tmdbId: 880004,
          sizeBytes: 2_147_483_648,
          addDate: daysAgo(25),
        },
        {
          mediaServerId: STUB_MAINT_UNKNOWN_ID,
          tmdbId: 990009,
          sizeBytes: 1_073_741_824,
          addDate: daysAgo(2),
        },
      ],
    },
    {
      id: 8,
      title: 'Stale shows',
      isActive: true,
      deleteAfterDays: 45,
      type: 'show',
      items: [
        {
          mediaServerId: STUB_MAINT_TV_ID,
          tvdbId: 990001,
          sizeBytes: 21_474_836_480,
          addDate: daysAgo(7),
        },
      ],
    },
  ];
}

/** One armed rule group (round-trippable RulesDto shell — the Rules tab lists/arms/deletes it). */
function freshRules(): Array<Record<string, unknown>> {
  return [
    {
      id: 11,
      name: 'Purge stale movies',
      description: 'Unwatched 4K movies older than 90 days',
      isActive: true,
      dataType: 1,
      libraryId: 1,
      collection: { id: 7, deleteAfterDays: 30 },
      rules: [],
    },
  ];
}

const ALL_APPLICATIONS = [
  { id: 0, name: 'Plex' },
  { id: 2, name: 'Radarr' },
  { id: 3, name: 'Sonarr' },
  { id: 4, name: 'Overseerr' },
  { id: 5, name: 'Tautulli' },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startStubMaintainerr(): Promise<StubMaintainerrServer> {
  const calls: RecordedMaintainerrWrite[] = [];
  const exclusions = new Set<string>();
  /** mediaServerIds whose per-item handle (delete) has fired — dropped from collection content. */
  const handled = new Set<string>();
  /** lowercased application names currently "disconnected" (dropped from rules/constants). */
  const disconnected = new Set<string>();
  let collections = freshCollections();
  let rules = freshRules();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname.replace(/^\/api/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      if (url.pathname === '/_stub/calls') return json(res, 200, { calls });
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        exclusions.clear();
        handled.clear();
        disconnected.clear();
        collections = freshCollections();
        rules = freshRules();
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/integrations' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { name: string; connected: boolean };
        if (body.connected) disconnected.delete(body.name.toLowerCase());
        else disconnected.add(body.name.toLowerCase());
        res.writeHead(204);
        return res.end();
      }

      if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });
        if (method === 'POST' && path === '/rules/exclusion') {
          exclusions.add(String((body as { mediaId?: unknown })?.mediaId ?? ''));
          return json(res, 201, { code: 1 });
        }
        if (method === 'DELETE' && /^\/rules\/exclusions\/.+$/.test(path)) {
          exclusions.delete(decodeURIComponent(path.split('/').pop() ?? ''));
          return json(res, 200, { code: 1 });
        }
        if (method === 'POST' && path === '/collections/media/handle') {
          // The per-item delete trigger (the ONLY one expedite may use — C-07a): the item
          // leaves its collection so a pending refetch shows it gone.
          handled.add(String((body as { mediaId?: unknown })?.mediaId ?? ''));
          return json(res, 201, {});
        }
        if (method === 'POST' && path === '/collections/handle') {
          // The estate-wide handler expedite must NEVER call (C-07a). Accept it (Maintainerr
          // would) so the guard is the spec's /_stub/calls assertion, not a stub 404.
          return json(res, 201, {});
        }
        if ((method === 'POST' || method === 'PUT') && path === '/rules') {
          const dto = body as Record<string, unknown>;
          if (method === 'PUT' && typeof dto?.id === 'number') {
            rules = rules.map((r) => (r.id === dto.id ? { ...r, ...dto } : r));
          }
          return json(res, 201, { code: 1 });
        }
        if (method === 'DELETE' && /^\/rules\/\d+$/.test(path)) {
          const id = Number(path.split('/').pop());
          rules = rules.filter((r) => r.id !== id);
          return json(res, 200, { code: 1 });
        }
        // BasicResponseDto (code:1 = success) — the write client fails closed on code:0 (P1a).
        if (method === 'PATCH' && path === '/settings')
          return json(res, 200, { status: 'OK', code: 1, message: 'Success' });
        return json(res, 404, {
          message: `stub-maintainerr: no write handler for ${method} ${path}`,
        });
      }

      // ---- reads ----
      switch (true) {
        case path === '/app/status':
          return json(res, 200, {
            status: 'ok',
            version: '3.17.0',
            commitTag: 'e2e',
            updateAvailable: false,
          });
        case path === '/settings/test/plex':
          return disconnected.has('plex')
            ? json(res, 200, { status: 'NOK', code: 0, message: 'Plex unreachable (stub)' })
            : json(res, 200, { status: 'OK', code: 1, message: 'Plex 1.40 (stub)' });
        case path === '/rules/constants':
          return json(res, 200, {
            applications: ALL_APPLICATIONS.filter((a) => !disconnected.has(a.name.toLowerCase())),
          });
        case path === '/rules':
          return json(res, 200, rules);
        case path === '/settings':
          return json(res, 200, {
            radarr_tag_exclusions: true,
            radarr_exclusion_tag: 'dnd',
            radarr_untag_on_unexclude: true,
            sonarr_tag_exclusions: true,
            sonarr_exclusion_tag: 'dnd',
            sonarr_untag_on_unexclude: true,
          });
        case path === '/collections':
          return json(
            res,
            200,
            collections.map((c) => ({
              id: c.id,
              title: c.title,
              isActive: c.isActive,
              deleteAfterDays: c.deleteAfterDays,
              type: c.type,
              media: [], // the list serves a PREVIEW subset — content is the paged endpoint
            })),
          );
        case /^\/collections\/media\/\d+\/content\/\d+$/.test(path): {
          const cid = Number(path.split('/')[3]);
          const items =
            collections
              .find((c) => c.id === cid)
              ?.items.filter((i) => !handled.has(i.mediaServerId)) ?? [];
          return json(res, 200, { totalSize: items.length, items });
        }
        case path === '/rules/exclusion': {
          const id = query.mediaServerId;
          return json(
            res,
            200,
            id !== undefined && exclusions.has(id)
              ? [{ id: 1, mediaServerId: id, ruleGroupId: null, parent: id }]
              : [],
          );
        }
        default:
          return json(res, 404, { message: `stub-maintainerr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) =>
      json(res, 500, { message: `stub-maintainerr error: ${String(err)}` }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-maintainerr failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
