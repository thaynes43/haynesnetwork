import { describe, expect, it } from 'vitest';
import { PlexWriteClient } from '../src/write';
import { PlexHttpError } from '../src/errors';
import { plexStub, TEST_CLIENT_OPTIONS } from './helpers';
import { CREATED_SHARED_SERVER_XML } from '../__fixtures__/xml';

function client(stub: ReturnType<typeof plexStub>): PlexWriteClient {
  return new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: stub.fetchImpl });
}

describe('PlexWriteClient — the sharing write surface', () => {
  it('createSharedServer POSTs invited_id + library_section_ids and returns the new id', async () => {
    const stub = plexStub([
      { method: 'POST', path: /\/shared_servers$/, status: 201, body: CREATED_SHARED_SERVER_XML },
    ]);
    const result = await client(stub).createSharedServer({
      invitedUserId: 222,
      librarySectionIds: [118181361],
    });
    expect(result.sharedServerId).toBe('30099');
    const call = stub.callsFor('POST', '/shared_servers')[0]!;
    expect(call.url.pathname).toBe('/api/servers/mid-tower/shared_servers');
    expect(call.body).toEqual({
      server_id: 'mid-tower',
      shared_server: { library_section_ids: [118181361], invited_id: 222 },
    });
  });

  it('updateSharedServer PUTs the merged section set to the shared-server id', async () => {
    const stub = plexStub([{ method: 'PUT', path: /\/shared_servers\/\d+$/, body: '<ok/>' }]);
    await client(stub).updateSharedServer({
      sharedServerId: '30001',
      librarySectionIds: [118181361, 118251661, 118278404],
    });
    const call = stub.callsFor('PUT', '/shared_servers/30001')[0]!;
    expect(call.url.pathname).toBe('/api/servers/mid-tower/shared_servers/30001');
    expect(call.body).toEqual({
      server_id: 'mid-tower',
      shared_server: { library_section_ids: [118181361, 118251661, 118278404] },
    });
    // No invited_id on an update (it's an existing SharedServer).
    expect((call.body as { shared_server: Record<string, unknown> }).shared_server).not.toHaveProperty(
      'invited_id',
    );
  });

  it('deleteSharedServer DELETEs the shared-server id (empty-set unshare)', async () => {
    const stub = plexStub([{ method: 'DELETE', path: /\/shared_servers\/\d+$/, body: '<ok/>' }]);
    await client(stub).deleteSharedServer('30001');
    const call = stub.callsFor('DELETE', '/shared_servers/30001')[0]!;
    expect(call.url.pathname).toBe('/api/servers/mid-tower/shared_servers/30001');
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
  });

  // ADR-043 (PLAN-024) — the poster-upload write (the only direct-PMS write) goes to the SERVER baseUrl,
  // not plex.tv, with image/png bytes and the token header-only.
  it('uploadPoster POSTs image bytes to {baseUrl}/library/metadata/{id}/posters, token header-only', async () => {
    const stub = plexStub([
      { method: 'POST', path: /\/library\/metadata\/[^/]+\/posters$/, body: '<ok/>' },
    ]);
    await client(stub).uploadPoster({ ratingKey: '448155', body: new Uint8Array([137, 80, 78, 71]) });
    const call = stub.callsFor('POST', '/library/metadata/448155/posters')[0]!;
    // The upload targets the PMS server (baseUrl), NOT the plex.tv sharing host.
    expect(call.url.origin).toBe('http://plexops.test:32400');
    expect(call.url.pathname).toBe('/library/metadata/448155/posters');
    expect(call.headers['Content-Type']).toBe('image/png');
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
  });
});

// ADR-088 / DESIGN-049 D-14/D-15 (PLAN-068 S3) — the watched-state writes. Stub-only: these are NEVER
// exercised against a real server here (PLAN-068: no Plex write before S5's undo test passes).
describe('PlexWriteClient — scrobble / unscrobble (the Watch Mark write-back)', () => {
  it('scrobble GETs {baseUrl}/:/scrobble with the library identifier and key; token header-only', async () => {
    const stub = plexStub([{ path: '/:/scrobble', body: '' }]);
    await client(stub).scrobble('45724');
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url.origin).toBe('http://plexops.test:32400'); // the PMS itself, not plex.tv
    expect(call.url.pathname).toBe('/:/scrobble');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      identifier: 'com.plexapp.plugins.library',
      key: '45724',
    });
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(call.url.toString()).not.toContain('owner-secret-token');
    expect(call.body).toBeUndefined();
  });

  it('unscrobble GETs {baseUrl}/:/unscrobble the same way', async () => {
    const stub = plexStub([{ path: '/:/unscrobble', body: '' }]);
    await client(stub).unscrobble(' 45668 ');
    const call = stub.callsFor('GET', '/:/unscrobble')[0]!;
    expect(call.url.searchParams.get('key')).toBe('45668');
    expect(call.url.searchParams.get('identifier')).toBe('com.plexapp.plugins.library');
  });

  it('keeps the GET retry policy: a transient 503 is retried (idempotent on watched state)', async () => {
    let n = 0;
    const flaky = plexStub([
      { path: '/:/scrobble', status: 503, body: 'busy' },
    ]);
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      n += 1;
      if (n === 1) return flaky.fetchImpl(input as string, init);
      return new Response('', { status: 200 });
    }) as typeof fetch;
    await new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl }).scrobble('1');
    expect(n).toBe(2);
  });

  it('a non-retryable status fails once and is typed (never a silent success)', async () => {
    const stub = plexStub([{ path: '/:/scrobble', status: 404, body: 'no such item' }]);
    await expect(client(stub).scrobble('999')).rejects.toBeInstanceOf(PlexHttpError);
    expect(stub.calls).toHaveLength(1);
  });

  it('refuses a blank ratingKey before any request', async () => {
    const stub = plexStub([]);
    await expect(client(stub).scrobble('  ')).rejects.toBeInstanceOf(TypeError);
    await expect(client(stub).unscrobble('')).rejects.toBeInstanceOf(TypeError);
    expect(stub.calls).toHaveLength(0);
  });
});
