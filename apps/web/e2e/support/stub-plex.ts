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

/**
 * ADR-029 — the token account, i.e. the server OWNER (`GET /api/v2/user`). Its email matches NO
 * persona by default, so the member stays a *friend* (not owner) and existing specs are unchanged.
 * The owner email is overridable at runtime via `POST /_stub/owner { email }` so the owner-state /
 * unlinked-account UX can be captured against a real persona.
 */
export const STUB_PLEX_OWNER = { id: '12874060', email: 'plex-owner@example.test', username: 'plexowner' };

type Slug = keyof typeof STUB_PLEX_TOKENS;

interface StubSection {
  key: string;
  title: string;
  type: string;
  /** plex.tv-scoped section id (the share body's library_section_ids). */
  plexId: string;
}

// The canonical e2e library set — mirrors what seed-ledger.ts seeds into plex_libraries.
// ADR-038 (PLAN-022) — k8plex also carries the two ytdl-sub "TV Show by Date" libraries.
const LIBRARIES: Record<Slug, StubSection[]> = {
  haynestower: [
    { key: '1', title: 'HNet Movies', type: 'movie', plexId: '118181361' },
    { key: '4', title: 'HNet Photos', type: 'photo', plexId: '118278404' }, // family-only
  ],
  haynesops: [{ key: '1', title: 'HOps Movies', type: 'movie', plexId: '200001' }],
  hayneskube: [
    { key: '2', title: 'HOps Music', type: 'artist', plexId: '300002' },
    { key: '4', title: 'HOps Peloton', type: 'show', plexId: '300004' },
    { key: '5', title: 'HOps YT', type: 'show', plexId: '300005' },
  ],
};

interface StubSectionItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb?: string;
  childCount?: number;
  leafCount?: number;
  year?: number;
  addedAt?: number;
  // DESIGN-017 D-09 (drill-in) — hierarchy fields for /library/metadata/{key}[/children] items.
  index?: number;
  duration?: number; // ms
  originallyAvailableAt?: string; // 'YYYY-MM-DD'
  summary?: string;
}

// ADR-038 — canned `/library/sections/{key}/all` contents per (slug, sectionKey). One show carries a
// Plex thumb (the poster-proxy round-trip); another omits it (the KindIcon fallback tile).
const SECTION_CONTENTS: Partial<Record<Slug, Record<string, StubSectionItem[]>>> = {
  hayneskube: {
    '4': [
      {
        ratingKey: '9001',
        title: 'Bike Bootcamp',
        type: 'show',
        thumb: '/library/metadata/9001/thumb/1699',
        childCount: 4,
        leafCount: 128,
        year: 2024,
        addedAt: 1_699_990_000,
      },
      { ratingKey: '9002', title: 'Power Zone Endurance', type: 'show', childCount: 3, leafCount: 57 },
    ],
    '5': [
      {
        ratingKey: '7001',
        title: 'Documentaries',
        type: 'show',
        thumb: '/library/metadata/7001/thumb/1701',
        childCount: 6,
        leafCount: 240,
        addedAt: 1_701_000_000,
      },
    ],
  },
};

// DESIGN-017 D-09 — the drill-in hierarchy for the k8plex stub: show ratingKey → its seasons;
// season ratingKey → its episodes. Every metadata item also records the section that owns it
// (`librarySectionID` — the router's confinement check). Bike Bootcamp (9001, section 4) mirrors the
// real Peloton shape: duration-encoded season titles, dated episodes with runtimes and stills.
const METADATA_SECTION: Record<string, string> = {
  '9001': '4',
  '9002': '4',
  '7001': '5',
  '9101': '4', // Bike Bootcamp — Season 30
  '9102': '4', // Bike Bootcamp — Season 45
  '9201': '4', // episodes…
  '9202': '4',
  '9203': '4',
  '7101': '5', // Documentaries — Season 2024
  '7201': '5',
};

const METADATA_CHILDREN: Record<string, StubSectionItem[]> = {
  // Bike Bootcamp → seasons (duration-encoded titles, the T-111 idiom).
  '9001': [
    {
      ratingKey: '9101',
      title: 'Season 30',
      type: 'season',
      index: 30,
      leafCount: 2,
      thumb: '/library/metadata/9101/thumb/1700',
    },
    { ratingKey: '9102', title: 'Season 45', type: 'season', index: 45, leafCount: 1 },
  ],
  // Season 30 → episodes.
  '9101': [
    {
      ratingKey: '9201',
      title: '2026-06-09 - 30 min Bootcamp',
      type: 'episode',
      index: 701,
      duration: 1_991_936,
      originallyAvailableAt: '2026-06-09',
      thumb: '/library/metadata/9201/thumb/1701',
    },
    {
      ratingKey: '9202',
      title: '2026-06-02 - 30 min Bootcamp',
      type: 'episode',
      index: 700,
      duration: 1_800_000,
      originallyAvailableAt: '2026-06-02',
    },
  ],
  // Season 45 → one episode.
  '9102': [
    {
      ratingKey: '9203',
      title: '2026-05-20 - 45 min Bootcamp',
      type: 'episode',
      index: 650,
      duration: 2_700_000,
      originallyAvailableAt: '2026-05-20',
      thumb: '/library/metadata/9203/thumb/1702',
    },
  ],
  // Documentaries (YouTube) → one season → one episode.
  '7001': [
    { ratingKey: '7101', title: 'Season 2024', type: 'season', index: 2024, leafCount: 1 },
  ],
  '7101': [
    {
      ratingKey: '7201',
      title: 'A Stub Documentary',
      type: 'episode',
      index: 1,
      duration: 3_600_000,
      originallyAvailableAt: '2024-03-15',
      thumb: '/library/metadata/7201/thumb/1703',
    },
  ],
};

/** Find one metadata item (show/season/episode) by ratingKey across the canned hierarchy. */
function findMetadataItem(ratingKey: string): StubSectionItem | undefined {
  for (const items of Object.values(SECTION_CONTENTS.hayneskube ?? {})) {
    const hit = items.find((i) => i.ratingKey === ratingKey);
    if (hit) return hit;
  }
  for (const items of Object.values(METADATA_CHILDREN)) {
    const hit = items.find((i) => i.ratingKey === ratingKey);
    if (hit) return hit;
  }
  return undefined;
}

// A 1x1 transparent PNG the stub streams for any Plex thumb path (so the poster proxy returns a 200).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
  // ADR-029 — the OWNER account email `GET /api/v2/user` reports (runtime-overridable for UX capture).
  let ownerEmail = STUB_PLEX_OWNER.email;
  const resetState = () => {
    calls.length = 0;
    shares.clear();
    ownerEmail = STUB_PLEX_OWNER.email;
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
      // ADR-029 — set the OWNER email so a persona can be recognized as the server owner.
      if (path === '/_stub/owner' && method === 'POST') {
        const raw = await readBody(req);
        const b = raw === '' ? {} : (JSON.parse(raw) as { email?: string });
        ownerEmail = (b.email ?? '').trim();
        res.writeHead(204);
        return res.end();
      }

      // ---- plex.tv account read (owner identity — ADR-029) ----
      if (path === '/api/v2/user') {
        return json(res, 200, {
          id: Number(STUB_PLEX_OWNER.id),
          uuid: 'stub-owner-uuid',
          username: STUB_PLEX_OWNER.username,
          title: 'Stub Owner',
          email: ownerEmail,
        });
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
      // ADR-038 (PLAN-022) — a library section's contents (the ytdl-sub shows).
      const allMatch = path.match(/^\/library\/sections\/([^/]+)\/all$/);
      if (allMatch) {
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        const key = allMatch[1]!;
        const Metadata = (slug && SECTION_CONTENTS[slug]?.[key]) || [];
        return json(res, 200, { MediaContainer: { size: Metadata.length, Metadata } });
      }
      // ADR-043 (PLAN-024) — the poster-upload WRITE surface (the confined Plex write client's uploadPoster): the poster
      // guard POSTs raw image bytes to select a durable override poster. Record the call (so a guard
      // integration test can assert which ratingKeys were re-pushed) and 200. This is the ONLY direct-PMS
      // write the stub accepts.
      const postersMatch = path.match(/^\/library\/metadata\/([^/]+)\/posters$/);
      if (postersMatch && method === 'POST') {
        const raw = await readBody(req);
        const slug = tokenStr ? SLUG_BY_TOKEN.get(tokenStr) : undefined;
        calls.push({ method, path, machineId: slug ?? '', body: `poster:${raw.length}` });
        return json(res, 200, { MediaContainer: { size: 1 } });
      }
      // ADR-038 — the Plex thumb the poster proxy streams (a tiny PNG for any /library/…/thumb/… path).
      if (/^\/library\/metadata\/[^/]+\/thumb\//.test(path)) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(TINY_PNG.length) });
        return res.end(TINY_PNG);
      }
      // ADR-041 D-07 — the photo-transcode endpoint the sized poster variants ride. The stub serves
      // the same tiny image (webp-labelled) for any known /library/… url= target; an unknown target
      // 404s so the route's original-art fallback is exercised in tests that want it.
      if (path === '/photo/:/transcode') {
        const target = url.searchParams.get('url') ?? '';
        if (!target.startsWith('/library/')) return json(res, 404, { message: 'bad transcode url' });
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(TINY_PNG.length) });
        return res.end(TINY_PNG);
      }
      // DESIGN-017 D-09 — a show's/season's children (seasons/episodes) with the owning section id.
      const childrenMatch = path.match(/^\/library\/metadata\/([^/]+)\/children$/);
      if (childrenMatch) {
        const key = childrenMatch[1]!;
        const Metadata = METADATA_CHILDREN[key] ?? [];
        return json(res, 200, {
          MediaContainer: {
            size: Metadata.length,
            totalSize: Metadata.length,
            librarySectionID: METADATA_SECTION[key] ? Number(METADATA_SECTION[key]) : undefined,
            Metadata,
          },
        });
      }
      // DESIGN-017 D-09 — one metadata item (the drill-in head), with librarySectionID on the item.
      const metaMatch = path.match(/^\/library\/metadata\/([^/]+)$/);
      if (metaMatch) {
        const key = metaMatch[1]!;
        const item = findMetadataItem(key);
        if (!item) return json(res, 404, { message: 'no such metadata' });
        const sectionId = METADATA_SECTION[key];
        return json(res, 200, {
          MediaContainer: {
            size: 1,
            Metadata: [{ ...item, librarySectionID: sectionId ? Number(sectionId) : undefined }],
          },
        });
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
