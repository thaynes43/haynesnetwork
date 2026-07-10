// ADR-045 / DESIGN-023 (PLAN-026) — a stub Authentik REST API for the /admin/users portal e2e + capture.
// Mirrors the *arr / OWUI stubs: a scriptable HTTP server with a deterministic in-memory directory the
// `authentik-users` sync pages (GET /api/v3/core/users/ + /groups/) and the portal writes against
// (POST /groups/, /groups/{pk}/add_user/, /groups/{pk}/remove_user/). Requires the bearer token — a
// missing/wrong token answers 403 (Authentik's contract).
//
// Seeded directory: an app-known admin (matches the bootstrap-admin persona), a Plex-external identity in
// `family` (for the exclusive-tier flip), a native identity, and a service account. Groups seed `family`
// (owned) + `mfa-exempt` (NON-owned — the guardrail must never touch it).
import { createServer, type IncomingMessage, type Server } from 'node:http';

/** The throwaway API token the stub Authentik accepts (never a real credential). */
export const STUB_AUTHENTIK_API_TOKEN = 'stub-authentik-token';

interface StubUser {
  pk: number;
  username: string;
  name: string;
  email: string | null;
  is_active: boolean;
  type: 'external' | 'internal' | 'internal_service_account';
  uid: string;
  sources: string[];
}

interface StubGroup {
  pk: string;
  name: string;
  members: Set<number>;
}

export interface StubAuthentikServer {
  baseUrl: string;
  /** Live membership accessor for assertions: the group names a user pk currently belongs to. */
  groupsOfUser: (pk: number) => string[];
  /** The names of groups created via POST /groups/ this run. */
  createdGroups: string[];
  stop: () => Promise<void>;
}

export async function startStubAuthentik(): Promise<StubAuthentikServer> {
  const users: StubUser[] = [
    { pk: 1, username: 'bootstrap-admin', name: 'Bootstrap Admin', email: 'bootstrap-admin@example.test', is_active: true, type: 'internal', uid: 'uid-admin', sources: [] },
    { pk: 2, username: 'plexguy', name: 'Plex Guy', email: 'plexguy@example.test', is_active: true, type: 'external', uid: 'uid-plexguy', sources: ['HaynesTower'] },
    { pk: 3, username: 'nativeuser', name: 'Native User', email: 'native@example.test', is_active: true, type: 'internal', uid: 'uid-native', sources: [] },
    { pk: 4, username: 'ak-outpost-x', name: 'Outpost Service Account', email: null, is_active: true, type: 'internal_service_account', uid: 'uid-outpost', sources: [] },
  ];
  const groups: StubGroup[] = [
    { pk: 'grp-family', name: 'family', members: new Set([2]) },
    { pk: 'grp-mfa-exempt', name: 'mfa-exempt', members: new Set() },
    { pk: 'grp-admins', name: 'authentik Admins', members: new Set([1]) },
  ];
  const createdGroups: string[] = [];

  const groupsOfUser = (pk: number): string[] =>
    groups.filter((g) => g.members.has(pk)).map((g) => g.name);

  const userDto = (u: StubUser) => ({
    pk: u.pk,
    username: u.username,
    name: u.name,
    email: u.email,
    is_active: u.is_active,
    type: u.type,
    uid: u.uid,
    attributes: u.sources.length > 0 ? { 'goauthentik.io/user/sources': u.sources } : {},
    groups_obj: groups
      .filter((g) => g.members.has(u.pk))
      .map((g) => ({ pk: g.pk, name: g.name })),
  });

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // Control surface (no auth) — specs GET the live state to assert group writes (mirrors *arr's
      // /_stub/calls). NOT part of the Authentik API.
      if (req.method === 'GET' && path === '/_stub/state') {
        return json(200, {
          users: users.map((u) => ({ pk: u.pk, username: u.username, groups: groupsOfUser(u.pk) })),
          groups: groups.map((g) => ({ name: g.name, members: [...g.members] })),
          createdGroups,
        });
      }

      if (req.headers['authorization'] !== `Bearer ${STUB_AUTHENTIK_API_TOKEN}`) {
        return json(403, { detail: 'Authentication credentials were not provided.' });
      }

      // GET /api/v3/core/users/  (paginated envelope; a single page suffices for the stub)
      if (req.method === 'GET' && path === '/api/v3/core/users/') {
        return json(200, {
          pagination: { next: 0, count: users.length },
          results: users.map(userDto),
        });
      }
      // GET /api/v3/core/users/{pk}/
      const userMatch = path.match(/^\/api\/v3\/core\/users\/(\d+)\/$/);
      if (req.method === 'GET' && userMatch) {
        const u = users.find((x) => x.pk === Number(userMatch[1]));
        return u ? json(200, userDto(u)) : json(404, { detail: 'Not found.' });
      }
      // GET /api/v3/core/groups/  (optional ?name= exact filter)
      if (req.method === 'GET' && path === '/api/v3/core/groups/') {
        const nameFilter = url.searchParams.get('name');
        const list = groups
          .filter((g) => nameFilter === null || g.name === nameFilter)
          .map((g) => ({ pk: g.pk, name: g.name }));
        return json(200, { pagination: { next: 0, count: list.length }, results: list });
      }
      // POST /api/v3/core/groups/  (create)
      if (req.method === 'POST' && path === '/api/v3/core/groups/') {
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
        const name = body.name ?? '';
        const created: StubGroup = { pk: `grp-${name}`, name, members: new Set() };
        groups.push(created);
        createdGroups.push(name);
        return json(201, { pk: created.pk, name: created.name });
      }
      // POST /api/v3/core/groups/{pk}/add_user/  and  /remove_user/
      const memberMatch = path.match(/^\/api\/v3\/core\/groups\/([^/]+)\/(add_user|remove_user)\/$/);
      if (req.method === 'POST' && memberMatch) {
        const group = groups.find((g) => g.pk === decodeURIComponent(memberMatch[1]!));
        if (!group) return json(404, { detail: 'Not found.' });
        const body = JSON.parse((await readBody(req)) || '{}') as { pk?: number };
        const userPk = Number(body.pk);
        if (memberMatch[2] === 'add_user') group.members.add(userPk);
        else group.members.delete(userPk);
        return json(204, null);
      }
      return json(404, { detail: `stub-authentik: no handler for ${req.method} ${path}` });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-authentik failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    groupsOfUser,
    createdGroups,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
