import { describe, expect, it } from 'vitest';
import { PlexReadClient } from '../src/read';
import { PlexParseError } from '../src/errors';
import { plexStub, TEST_CLIENT_OPTIONS, type RecordedPlexCall } from './helpers';
import {
  ACCOUNT_JSON,
  IDENTITY_JSON,
  LIBRARY_SECTIONS_JSON,
  SERVER_SECTIONS_XML,
  SHARED_SERVERS_XML,
  USERS_XML,
} from '../__fixtures__/xml';

function client(stub: ReturnType<typeof plexStub>): PlexReadClient {
  return new PlexReadClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: stub.fetchImpl });
}

describe('PlexReadClient — PMS registry reads', () => {
  it('listSections parses the /library/sections JSON', async () => {
    const stub = plexStub([{ path: '/library/sections', body: LIBRARY_SECTIONS_JSON }]);
    const sections = await client(stub).listSections();
    expect(sections.map((s) => [s.key, s.type])).toEqual([
      ['1', 'movie'],
      ['2', 'show'],
      ['3', 'artist'],
    ]);
  });

  it('getIdentity returns the machine identifier + version', async () => {
    const stub = plexStub([{ path: '/identity', body: IDENTITY_JSON }]);
    expect(await client(stub).getIdentity()).toEqual({
      machineIdentifier: 'mid-ops',
      version: '1.43.2.10687-563d026ea',
    });
  });

  it('sends the token in the X-Plex-Token header, never in the URL', async () => {
    const stub = plexStub([{ path: '/library/sections', body: LIBRARY_SECTIONS_JSON }]);
    await client(stub).listSections();
    const call = stub.calls[0]!;
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
    expect(call.url.search).toBe('');
  });
});

describe('PlexReadClient — owner account (ADR-029)', () => {
  const accountRoute = { path: '/api/v2/user', body: ACCOUNT_JSON };

  it('getOwnerAccount reads the token account from /api/v2/user (id coerced to string)', async () => {
    const account = await client(plexStub([accountRoute])).getOwnerAccount();
    expect(account).toEqual({ id: '12874060', email: 'Owner@Example.com', username: 'owneruser' });
  });

  it('getOwnerEmail returns the owner email trimmed + lowercased', async () => {
    expect(await client(plexStub([accountRoute])).getOwnerEmail()).toBe('owner@example.com');
  });

  it('caches the account — only one /api/v2/user call across repeated reads', async () => {
    const stub = plexStub([accountRoute]);
    const c = client(stub);
    await c.getOwnerAccount();
    await c.getOwnerEmail();
    expect(stub.callsFor('GET', '/api/v2/user')).toHaveLength(1);
  });

  it('addresses /api/v2/user on plex.tv (not the PMS base URL)', async () => {
    const stub = plexStub([accountRoute]);
    await client(stub).getOwnerAccount();
    const call = stub.calls[0]!;
    expect(call.url.origin).toBe('https://plex.tv');
    expect(call.url.pathname).toBe('/api/v2/user');
  });
});

describe('PlexReadClient — plex.tv sharing reads', () => {
  const usersRoute = { path: '/api/users', body: USERS_XML };
  const serverRoute = { path: /^\/api\/servers\/[^/]+$/, body: SERVER_SECTIONS_XML };
  const sharedRoute = { path: /\/shared_servers$/, body: SHARED_SERVERS_XML };

  it('listFriends extracts the friend list from XML', async () => {
    const friends = await client(plexStub([usersRoute])).listFriends();
    expect(friends.map((f) => f.email)).toEqual(['Alice@Example.com', 'bob@example.com']);
    expect(friends[0]!.id).toBe('111');
  });

  it('findFriendByEmail matches case-insensitively', async () => {
    const c = client(plexStub([usersRoute]));
    expect((await c.findFriendByEmail('alice@example.com'))?.id).toBe('111');
    expect((await c.findFriendByEmail('  BOB@EXAMPLE.COM '))?.id).toBe('222');
    expect(await c.findFriendByEmail('nobody@example.com')).toBeNull();
  });

  it('listServerSections maps section key → plex.tv id', async () => {
    const sections = await client(plexStub([serverRoute])).listServerSections();
    const byKey = new Map(sections.map((s) => [s.key, s.id]));
    expect(byKey.get('1')).toBe('118181361');
    expect(byKey.get('5')).toBe('118278994');
    expect(sections.find((s) => s.key === '2')!.title).toBe('HNet TV & Specials');
  });

  it('findSharedServerForUser returns the current shared section set (shared="1")', async () => {
    const ss = await client(plexStub([sharedRoute])).findSharedServerForUser('111');
    expect(ss).not.toBeNull();
    expect(ss!.id).toBe('30001');
    expect(ss!.sections.filter((s) => s.shared).map((s) => s.id)).toEqual(['118181361', '118251661']);
    expect(await client(plexStub([sharedRoute])).findSharedServerForUser('999')).toBeNull();
  });

  it('surfaces a missing <Server> element as PlexParseError', async () => {
    const stub = plexStub([
      { path: /^\/api\/servers\/[^/]+$/, body: '<MediaContainer size="0"></MediaContainer>' },
    ]);
    await expect(client(stub).listServerSections()).rejects.toBeInstanceOf(PlexParseError);
  });
});

// Guard: the sharing reads hit plex.tv with the machine identifier in the path.
describe('PlexReadClient — URL construction', () => {
  it('addresses /api/servers/{machineId}/shared_servers on plex.tv', async () => {
    const stub = plexStub([{ path: /\/shared_servers$/, body: SHARED_SERVERS_XML }]);
    await client(stub).listSharedServers();
    const call: RecordedPlexCall = stub.calls[0]!;
    expect(call.url.origin).toBe('https://plex.tv');
    expect(call.url.pathname).toBe('/api/servers/mid-tower/shared_servers');
  });
});
