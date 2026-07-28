// ADR-081 C-01/C-02/C-03/C-06 — the library-access bootstrap: the from-scratch Default all-grant SEED and
// the Plex-server REGISTRATION writer's in-transaction auto-grant. Proven against an embedded PG16 with the
// real migrations. role_plex_server_all_grants + permission_audit are guarded tables; these writers live in
// packages/domain and co-write the audit row in the same transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  permissionAudit,
  plexServers,
  rolePlexServerAllGrants,
  roles,
  SEEDED_PLEX_SERVER_IDS,
  SEEDED_ROLE_IDS,
} from '@hnet/db';
import { registerPlexServer, seedDefaultServerAllGrantsIfBootstrap } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

function defaultAllGrants(t: TestDb) {
  return t.db
    .select()
    .from(rolePlexServerAllGrants)
    .where(eq(rolePlexServerAllGrants.roleId, SEEDED_ROLE_IDS.default));
}

function defaultGrantAudits(t: TestDb) {
  return t.db
    .select()
    .from(permissionAudit)
    .where(
      and(
        eq(permissionAudit.roleId, SEEDED_ROLE_IDS.default),
        eq(permissionAudit.action, 'update_role_libraries'),
      ),
    );
}

describe('seedDefaultServerAllGrantsIfBootstrap (ADR-081 C-01/C-02/C-03)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });

  it('a fresh bootstrap (zero users) grants Default all-libraries on EVERY server + audits each (C-01)', async () => {
    const result = await seedDefaultServerAllGrantsIfBootstrap({ db: t.db });
    expect(result).toEqual({ seeded: true, servers: 3, granted: 3 });

    const grants = await defaultAllGrants(t);
    expect(grants.map((g) => g.plexServerId).sort()).toEqual(
      [
        SEEDED_PLEX_SERVER_IDS.haynestower,
        SEEDED_PLEX_SERVER_IDS.haynesops,
        SEEDED_PLEX_SERVER_IDS.hayneskube,
      ].sort(),
    );

    // Same audit trail a manual server-all grant produces (hard rule 6): one update_role_libraries row/server.
    const audits = await defaultGrantAudits(t);
    expect(audits).toHaveLength(3);
    expect(
      audits.every((a) => (a.detail as { reason?: string }).reason === 'bootstrap_default_all_grant'),
    ).toBe(true);

    // C-03 — non-default roles are untouched (Family holds no all-grants from the seed).
    const [family] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Family'));
    const familyGrants = await t.db
      .select()
      .from(rolePlexServerAllGrants)
      .where(eq(rolePlexServerAllGrants.roleId, family!.id));
    expect(familyGrants).toHaveLength(0);
  });

  it('is idempotent — a second run adds no new grants and no new audit rows', async () => {
    const result = await seedDefaultServerAllGrantsIfBootstrap({ db: t.db });
    expect(result).toEqual({ seeded: true, servers: 3, granted: 0 });
    expect(await defaultAllGrants(t)).toHaveLength(3);
    expect(await defaultGrantAudits(t)).toHaveLength(3);
  });

  it('is a clean no-op once a user exists — no widening, a revocation is never re-asserted (C-02)', async () => {
    await createUser(t.db); // the DB is now "populated" — no longer a fresh bootstrap
    // Simulate an admin revoking the hayneskube all-grant AFTER bootstrap.
    await t.db
      .delete(rolePlexServerAllGrants)
      .where(
        and(
          eq(rolePlexServerAllGrants.roleId, SEEDED_ROLE_IDS.default),
          eq(rolePlexServerAllGrants.plexServerId, SEEDED_PLEX_SERVER_IDS.hayneskube),
        ),
      );
    expect(await defaultAllGrants(t)).toHaveLength(2);

    const result = await seedDefaultServerAllGrantsIfBootstrap({ db: t.db });
    expect(result).toEqual({ seeded: false, servers: 0, granted: 0 });
    // The revoked grant stays revoked — the guard blocked the seed entirely.
    expect(await defaultAllGrants(t)).toHaveLength(2);
  });
});

describe('registerPlexServer (ADR-081 C-01/C-06)', () => {
  let t: TestDb;
  // A fresh registration payload for a slug we clear first (the three seeded servers are migration infra
  // facts + slug-CHECK-capped, so a test simulates a first registration by deleting one and adding it back).
  const server = {
    slug: 'haynesops' as const,
    name: 'HaynesOps',
    baseUrl: 'http://plexops.media.svc.cluster.local:32400',
    machineIdentifier: '80b33acb1d207508990637ec151fe9abad8d3d7a',
    tokenRef: 'PLEX_HAYNESOPS_TOKEN',
  };

  beforeAll(async () => {
    t = await bootMigratedDb();
    // Clear the seeded haynesops row so registerPlexServer performs a genuine first registration.
    await t.db.delete(plexServers).where(eq(plexServers.slug, 'haynesops'));
  });
  afterAll(async () => {
    await t?.stop();
  });

  it('auto-grants Default an all-libraries grant IN THE SAME TRANSACTION + audits it (C-06)', async () => {
    const result = await registerPlexServer({ db: t.db, server });
    expect(result.created).toBe(true);
    expect(result.defaultGranted).toBe(true);

    const grants = await defaultAllGrants(t);
    expect(grants.map((g) => g.plexServerId)).toEqual([result.serverId]);

    const audits = await defaultGrantAudits(t);
    expect(audits).toHaveLength(1);
    expect((audits[0]!.detail as { reason?: string }).reason).toBe('bootstrap_default_all_grant');
  });

  it('does NOT re-assert on a re-registration of an existing slug (created:false)', async () => {
    const result = await registerPlexServer({ db: t.db, server });
    expect(result.created).toBe(false);
    expect(result.defaultGranted).toBe(false);
    expect(await defaultAllGrants(t)).toHaveLength(1);
    expect(await defaultGrantAudits(t)).toHaveLength(1); // no new audit row
  });

  it('respects a revocation — an existing server is never re-granted (auto-grant fires only at first reg)', async () => {
    // An admin revokes the auto-grant.
    await t.db
      .delete(rolePlexServerAllGrants)
      .where(eq(rolePlexServerAllGrants.roleId, SEEDED_ROLE_IDS.default));
    expect(await defaultAllGrants(t)).toHaveLength(0);

    const result = await registerPlexServer({ db: t.db, server });
    expect(result.created).toBe(false);
    expect(result.defaultGranted).toBe(false);
    // The grant stays revoked — registration never re-asserts it.
    expect(await defaultAllGrants(t)).toHaveLength(0);
  });
});
