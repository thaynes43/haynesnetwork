// ADR-017 / DESIGN-007 D-07 — stub Plex server for e2e (mirrors stub-arr.ts: a real node:http
// server because Next calls Plex over the network). ONE server stands in for all three PMS
// instances AND plex.tv: PMS reads (`/identity`, `/library/sections`) are disambiguated by the
// per-server X-Plex-Token; the plex.tv sharing API (`/api/servers/{machineId}/...`) is
// disambiguated by the machineIdentifier in the path. It is STATEFUL for shared_servers so an
// add → myLibraries round-trip reflects the change, and RECORDS every sharing write so specs
// can assert the read-merge-write preservation (ADR-017 D-02).
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, machineId, body}] } (sharing writes only)
//   POST /_stub/reset  → 204 (clears recorded calls AND resets shares)
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const STUB_PLEX_TOKENS = {
  haynestower: 'stub-plex-tower',
  haynesops: 'stub-plex-ops',
  hayneskube: 'stub-plex-kube',
} as const;

// The pinned machine identifiers (match packages/plex PLEX_MACHINE_IDENTIFIERS + the 0010 seed,
// so the e2e client's default machine ids route to the right server here).
export const STUB_PLEX_MACHINE_IDS = {
  haynestower: 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3',
  haynesops: '80b33acb1d207508990637ec151fe9abad8d3d7a',
  hayneskube: 'c1b23d688afea4a39ec2c214776832c16be6504d',
} as const;

/** The member persona's Plex account (email matches stub-oidc STUB_USERS.member). */
export const STUB_PLEX_MEMBER = { id: '77', email: 'member@example.test', username: 'member' };

type Slug = keyof typeof STUB_PLEX_TOKENS;

interface StubSection {
  key: string;
  title: string;
  type: string;
  /** plex.tv-scoped section id (the share body's library_section_ids). */
  plexId: string;
}

// The canonical e2e library set — mirrors what seed-ledger.ts seeds into plex_libraries.
const LIBRARIES: Record<Slug, StubSection[]> = {
  haynestower: [
    { key: '1', title: 'HNet Movies', type: 'movie', plexId: '118181361' },
    { key: '4', title: 'HNet Photos', type: 'photo', plexId: '118278404' }, // family-only
  ],
  haynesops: [{ key: '1', title: 'HOps Movies', type: 'movie', plexId: '200001' }],
  hayneskube: [{ key: '2', title: 'HOps Music', type: 'artist', plexId: '300002' }],
};

const SLUG_BY_TOKEN = new Map<string, Slug>(
  (Object.entries(STUB_PLEX_TOKENS) as Array<[Slug, string]>).map(([slug, token]) => [token, slug]),
);
const SLUG_BY_MID = new Map<string, Slug>(
  (Object.entries(STUB_PLEX_MACHINE_IDS) as Array<[Slug, string]>).map(([slug, mid]) => [mid, slug]),
);

export interface RecordedPlexShareWrite {
  method: string;
  path: string;
  machineId: string;
  body: unknown;
}

export interface StubPlexServer {
  baseUrl: string;
  port: number;
  calls: RecordedPlexShareWrite[];
  stop: () => Promise<void>;
}

interface SharedServerState {
  id: string;
  userId: string;
  sectionIds: Set<string>; // plex.tv section ids currently shared
  /** ADR-017 C-14 — a share-everything (incl. future libraries) grant; read-only in self-service. */
  allLibraries?: boolean;
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  res.end(JSON.stringify(body));
}
function xml(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

export async function startStubPlex(): Promise<StubPlexServer> {
  const calls: RecordedPlexShareWrite[] = [];
  // Per-machine shared_servers state (userId → SharedServerState).
  const shares = new Map<string, Map<string, SharedServerState>>();
  const sharesFor = (mid: string) => {
    let m = shares.get(mid);
    if (!m) shares.set(mid, (m = new Map()));
    return m;
  };
  // ADR-024 (live 2026-07-06) — the member's role ALL-grants haynesops (seed-ledger) and their
  // account starts in the plex.tv all-libraries state on that server (share-everything, incl. future
  // libraries; the owner's-wife case). The My Plex page can then exercise the leave-All / re-enter-All
  // flow. Set directly (NOT via a recorded write) so the add/remove specs' call log stays clean.
  const seedFixtures = () => {
    const opsMid = STUB_PLEX_MACHINE_IDS.haynesops;
    sharesFor(opsMid).set(STUB_PLEX_MEMBER.id, {
      id: 'ss-alllibs',
      userId: STUB_PLEX_MEMBER.id,
      sectionIds: new Set(LIBRARIES.haynesops.map((s) => s.plexId)),
      allLibraries: true,
    });
  };
  const resetState = () => {
    calls.length = 0;
    shares.clear();
    seedFixtures();
  };
  seedFixtures();

  const usersXml = () =>
    `<MediaContainer friendlyName="StubPlex" identifier="com.plexapp.plugins.myplex" size="1">` +
    `<User id="${STUB_PLEX_MEMBER.id}" title="Marge Member" username="${STUB_PLEX_MEMBER.username}" email="${esc(STUB_PLEX_MEMBER.email)}" home="0" restricted="0">` +
    `<Server id="900" machineIdentifier="${STUB_PLEX_MACHINE_IDS.haynestower}" name="HaynesTower" owned="0" allLibraries="0" numLibraries="2"/>` +
    `</User></MediaContainer>`;

  const serverSectionsXml = (slug: Slug) =>
    `<MediaContainer size="1"><Server name="${slug}" machineIdentifier="${STUB_PLEX_MACHINE_IDS[slug]}">` +
    LIBRARIES[slug]
      .map((s) => `<Section id="${s.plexId}" key="${s.key}" type="${s.type}" title="${esc(s.title)}"/>`)
      .join('') +
    `</Server></MediaContainer>`;

  const sharedServersXml = (slug: Slug, mid: string) => {
    const state = sharesFor(mid);
    const rows = [...state.values()]
      .map((ss) => {
        const sections = LIBRARIES[slug]
          .map(
            (s) =>
              `<Section id="${s.plexId}" key="${s.key}" title="${esc(s.title)}" type="${s.type}" shared="${ss.sectionIds.has(s.plexId) ? '1' : '0'}"/>`,
          )
          .join('');
        return (
          `<SharedServer id="${ss.id}" username="${STUB_PLEX_MEMBER.username}" email="${esc(STUB_PLEX_MEMBER.email)}" userID="${ss.userId}" name="${slug}" allLibraries="${ss.allLibraries ? '1' : '0'}" owned="0">` +
          sections +
          `</SharedServer>`
        );
      })
      .join('');
    return `<MediaContainer size="${state.size}" machineIdentifier="${mid}">${rows}</MediaContainer>`;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const token = req.headers['x-plex-token'];
      const tokenStr = Array.isArray(token) ? token[0] : token;

      // ---- control surface ----
      if (path === '/_stub/calls') return json(res, 200, { calls });
      if (path === '/_stub/reset' && method === 'POST') {
        resetState();
        res.writeHead(204);
        return res.end();
      }

      // ---- PMS reads (disambiguated by token) ----
      if (path === '/identity') {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const mid = slug ? STUB_PLEX_MACHINE_IDS[slug] : 'stub-unknown';
        return json(res, 200, { MediaContainer: { machineIdentifier: mid, version: '1.43.2.10687-e2e' } });
      }
      if (path === '/library/sections') {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const Directory = slug
          ? LIBRARIES[slug].map((s) => ({ key: s.key, type: s.type, title: s.title, agent: 'tv.plex.agents.none' }))
          : [];
        return json(res, 200, { MediaContainer: { size: Directory.length, Directory } });
      }

      // ---- plex.tv sharing API (disambiguated by machineId in the path) ----
      if (path === '/api/users') return xml(res, 200, usersXml());

      const serverMatch = path.match(/^\/api\/servers\/([^/]+)(\/shared_servers(?:\/([^/]+))?)?$/);
      if (serverMatch) {
        const mid = serverMatch[1]!;
        const isShared = Boolean(serverMatch[2]);
        const sharedServerId = serverMatch[3];
        const slug = SLUG_BY_MID.get(mid);
        if (!slug) return xml(res, 404, `<MediaContainer size="0"/>`);

        if (!isShared && method === 'GET') return xml(res, 200, serverSectionsXml(slug));

        if (isShared && method === 'GET') return xml(res, 200, sharedServersXml(slug, mid));

        // Mutations — record + mutate state.
        if (isShared && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
          const raw = await readBody(req);
          const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
          calls.push({ method, path, machineId: mid, body });
          const state = sharesFor(mid);

          if (method === 'POST') {
            const b = body as {
              shared_server?: { library_section_ids?: number[]; invited_id?: number; all_libraries?: boolean };
            };
            const invited = String(b.shared_server?.invited_id ?? STUB_PLEX_MEMBER.id);
            const all = b.shared_server?.all_libraries === true; // ADR-024 enter-all create
            const ids = (b.shared_server?.library_section_ids ?? []).map(String);
            const id = `ss-${invited}`;
            state.set(invited, { id, userId: invited, sectionIds: new Set(ids), allLibraries: all });
            return xml(
              res,
              201,
              `<MediaContainer size="1"><SharedServer id="${id}" userID="${invited}" username="${STUB_PLEX_MEMBER.username}" allLibraries="${all ? '1' : '0'}"/></MediaContainer>`,
            );
          }
          if (method === 'PUT') {
            const b = body as { shared_server?: { library_section_ids?: number[]; all_libraries?: boolean } };
            const all = b.shared_server?.all_libraries;
            for (const ss of state.values()) {
              if (ss.id !== sharedServerId) continue;
              if (all === true) {
                // ADR-024 enter-all: set the flag; the section set is irrelevant while all.
                ss.allLibraries = true;
              } else {
                // Explicit list (all_libraries omitted or false) demotes from all-libraries.
                ss.allLibraries = false;
                if (b.shared_server?.library_section_ids !== undefined) {
                  ss.sectionIds = new Set(b.shared_server.library_section_ids.map(String));
                }
              }
            }
            return xml(res, 200, `<MediaContainer size="1"/>`);
          }
          // DELETE
          for (const [uid, ss] of state) if (ss.id === sharedServerId) state.delete(uid);
          return xml(res, 200, `<MediaContainer size="0"/>`);
        }
      }

      return json(res, 404, { message: `stub-plex: no handler for ${method} ${path}` });
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-plex error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-plex failed to bind a port');
  }
  const port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
