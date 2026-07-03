import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionAudit, userAppGrants, users, type PermissionAuditAction } from '@hnet/db/schema';
import {
  ForbiddenHostError,
  ReorderMismatchError,
  TagNameConflictError,
  createApp,
  createTag,
  grantApp,
  revokeApp,
  setFamilyDesignation,
  reorderCatalog,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('permission_audit single-writers (DESIGN-001 D-12, R-04)', () => {
  let t: TestDb;
  let adminId: string;
  let memberId: string;
  let appId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    adminId = (await createUser(t.db)).id;
    memberId = (await createUser(t.db)).id;
    ({ appId } = await createApp({
      db: t.db,
      slug: 'test-app',
      name: 'Test App',
      url: 'https://test-app.haynesnetwork.com',
      actorId: adminId,
    }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const grantRows = () =>
    t.db
      .select()
      .from(userAppGrants)
      .where(and(eq(userAppGrants.userId, memberId), eq(userAppGrants.appId, appId)));

  const auditRows = (action: PermissionAuditAction) =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, action));

  it('createApp audited its own creation (create_app)', async () => {
    const audits = await auditRows('create_app');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: adminId,
      appId,
      detail: expect.objectContaining({ app_slug: 'test-app' }),
    });
  });

  it('grantApp inserts the grant and its grant_app audit row together', async () => {
    const result = await grantApp({ db: t.db, userId: memberId, appId, actorId: adminId });
    expect(result).toEqual({ changed: true });

    expect(await grantRows()).toHaveLength(1);
    const audits = await auditRows('grant_app');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: adminId,
      subjectUserId: memberId,
      appId,
      detail: { app_slug: 'test-app', app_name: 'Test App' },
    });
  });

  it('grantApp is idempotent: repeat grant writes nothing, audits nothing (D-11)', async () => {
    const repeat = await grantApp({ db: t.db, userId: memberId, appId, actorId: adminId });
    expect(repeat).toEqual({ changed: false });
    expect(await grantRows()).toHaveLength(1);
    expect(await auditRows('grant_app')).toHaveLength(1);
  });

  it('revokeApp removes the grant and audits revoke_app together; repeat is a no-op', async () => {
    const result = await revokeApp({ db: t.db, userId: memberId, appId, actorId: adminId });
    expect(result).toEqual({ changed: true });
    expect(await grantRows()).toHaveLength(0);
    expect(await auditRows('revoke_app')).toHaveLength(1);

    const repeat = await revokeApp({ db: t.db, userId: memberId, appId, actorId: adminId });
    expect(repeat).toEqual({ changed: false });
    expect(await auditRows('revoke_app')).toHaveLength(1);
  });

  it('a failed audit write rolls back the mutation — neither row lands (R-04 atomicity)', async () => {
    // Force the audit INSERT to fail so the transaction must roll the grant back too.
    await t.pool.query(`
      CREATE FUNCTION test_block_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit blocked (test)'; END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_block_permission_audit
        BEFORE INSERT ON permission_audit
        FOR EACH ROW EXECUTE FUNCTION test_block_audit();
    `);
    try {
      await expect(
        grantApp({ db: t.db, userId: memberId, appId, actorId: adminId }),
      ).rejects.toThrow(/audit blocked/);
      expect(await grantRows()).toHaveLength(0); // the grant did NOT survive
      expect(await auditRows('grant_app')).toHaveLength(1); // only the pre-trigger row from earlier
    } finally {
      await t.pool.query(`
        DROP TRIGGER test_block_permission_audit ON permission_audit;
        DROP FUNCTION test_block_audit();
      `);
    }
  });

  it('setFamilyDesignation flips users.is_family with set_family/unset_family audits, idempotently', async () => {
    expect(
      await setFamilyDesignation({ db: t.db, userId: memberId, isFamily: true, actorId: adminId }),
    ).toEqual({ changed: true });
    expect(
      await setFamilyDesignation({ db: t.db, userId: memberId, isFamily: true, actorId: adminId }),
    ).toEqual({ changed: false });

    const [row] = await t.db.select().from(users).where(eq(users.id, memberId));
    expect(row?.isFamily).toBe(true);
    expect(await auditRows('set_family')).toHaveLength(1);

    expect(
      await setFamilyDesignation({ db: t.db, userId: memberId, isFamily: false, actorId: adminId }),
    ).toEqual({ changed: true });
    expect(await auditRows('unset_family')).toHaveLength(1);
  });

  it('createApp rejects a *.haynesops.com URL before touching the database', async () => {
    await expect(
      createApp({
        db: t.db,
        slug: 'sonarr',
        name: 'Sonarr',
        url: 'https://sonarr.haynesops.com',
        actorId: adminId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(await auditRows('create_app')).toHaveLength(1); // no new audit row
  });

  it('createTag rejects duplicate names with TagNameConflictError', async () => {
    await createTag({ db: t.db, name: 'streamers', actorId: adminId });
    await expect(
      createTag({ db: t.db, name: 'streamers', actorId: adminId }),
    ).rejects.toBeInstanceOf(TagNameConflictError);
  });

  it('reorderCatalog rejects a partial id set with ReorderMismatchError', async () => {
    await expect(
      reorderCatalog({ db: t.db, orderedIds: [appId, appId], actorId: adminId }),
    ).rejects.toBeInstanceOf(ReorderMismatchError);
  });
});
