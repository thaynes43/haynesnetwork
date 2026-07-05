import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCatalog, permissionAudit, type PermissionAuditAction } from '@hnet/db/schema';
import {
  InvalidCatalogUrlError,
  ReorderMismatchError,
  createApp,
  reorderCatalog,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

describe('catalog single-writers + audit atomicity (DESIGN-001 D-12, R-04)', () => {
  let t: TestDb;
  let appId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  const auditRows = (action: PermissionAuditAction) =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, action));

  it('createApp writes the row and its create_app audit together', async () => {
    ({ appId } = await createApp({
      db: t.db,
      slug: 'test-app',
      name: 'Test App',
      url: 'https://test-app.haynesnetwork.com',
      actorId: null,
    }));
    const audits = await auditRows('create_app');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      appId,
      detail: expect.objectContaining({ app_slug: 'test-app' }),
    });
  });

  it('createApp accepts a *.haynesops.com URL and stores it canonical (ADR-013 BRANCH-A)', async () => {
    const { appId: opsAppId } = await createApp({
      db: t.db,
      slug: 'sonarr',
      name: 'Sonarr',
      url: 'sonarr.haynesops.com',
      actorId: null,
    });
    const [row] = await t.db.select().from(appCatalog).where(eq(appCatalog.id, opsAppId));
    expect(row?.url).toBe('https://sonarr.haynesops.com'); // scheme defaulted, canonical
    expect(await auditRows('create_app')).toHaveLength(2);
  });

  it('createApp rejects a truly-invalid URL before touching the database (InvalidCatalogUrlError)', async () => {
    await expect(
      createApp({
        db: t.db,
        slug: 'bad',
        name: 'Bad',
        url: 'javascript:alert(1)',
        actorId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidCatalogUrlError);
    expect(await auditRows('create_app')).toHaveLength(2); // no new audit row
  });

  it('reorderCatalog rejects a partial/duplicated id set with ReorderMismatchError', async () => {
    await expect(
      reorderCatalog({ db: t.db, orderedIds: [appId, appId], actorId: null }),
    ).rejects.toBeInstanceOf(ReorderMismatchError);
  });

  it('a failed audit write rolls back the mutation — neither row lands (R-04 atomicity)', async () => {
    // Force the audit INSERT to fail so the transaction must roll the app insert back too.
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
        createApp({
          db: t.db,
          slug: 'rolled-back',
          name: 'RB',
          url: 'https://rb.haynesnetwork.com',
          actorId: null,
        }),
      ).rejects.toThrow(/audit blocked/);
      const [row] = await t.db.select().from(appCatalog).where(eq(appCatalog.slug, 'rolled-back'));
      expect(row).toBeUndefined(); // the app insert did NOT survive the rolled-back tx
    } finally {
      await t.pool.query(`
        DROP TRIGGER test_block_permission_audit ON permission_audit;
        DROP FUNCTION test_block_audit();
      `);
    }
  });
});
