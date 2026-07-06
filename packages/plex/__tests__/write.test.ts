import { describe, expect, it } from 'vitest';
import { PlexWriteClient } from '../src/write';
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
});
