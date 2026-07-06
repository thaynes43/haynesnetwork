// ADR-021 / DESIGN-009 D-03 — setSectionPermission single-writer + sectionLevelForRole read.
// Embedded PG16. Proves: the role's section level upserts + a same-tx permission_audit row
// records before/after; replace-in-place on a second call; the Admin role is immutable
// (ROLE_IMMUTABLE, no row written, no audit); and sectionLevelForRole applies the Admin=Edit
// and no-row=default fallbacks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { permissionAudit, roleSectionPermissions, SEEDED_ROLE_IDS } from '@hnet/db/schema';
import {
  SystemRoleImmutableError,
  createRole,
  sectionLevelForRole,
  setSectionPermission,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('setSectionPermission (ADR-021 C-02)', () => {
  let t: TestDb;
  let roleId: string;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'sec-actor@example.com' })).id;
    ({ roleId } = await createRole({ db: t.db, name: 'Ledger Crew', appIds: [], actorId }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const levelRows = () =>
    t.db
      .select()
      .from(roleSectionPermissions)
      .where(
        and(
          eq(roleSectionPermissions.roleId, roleId),
          eq(roleSectionPermissions.sectionId, 'ledger'),
        ),
      );

  const auditRows = () =>
    t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_section_permission'));

  it('upserts the level and co-writes a permission_audit row in the same tx (before=default)', async () => {
    const res = await setSectionPermission({
      db: t.db,
      roleId,
      sectionId: 'ledger',
      level: 'edit',
      actorId,
    });
    expect(res).toEqual({ changed: true, before: 'read_only', after: 'edit' });

    const rows = await levelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('edit');

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId, roleId });
    expect(audits[0]!.detail).toMatchObject({
      section_id: 'ledger',
      before: 'read_only',
      after: 'edit',
    });
  });

  it('replaces in place on a second call (before = the stored level)', async () => {
    const res = await setSectionPermission({
      db: t.db,
      roleId,
      sectionId: 'ledger',
      level: 'disabled',
      actorId,
    });
    expect(res).toEqual({ changed: true, before: 'edit', after: 'disabled' });
    const rows = await levelRows();
    expect(rows).toHaveLength(1); // still one row — upsert, not append
    expect(rows[0]!.level).toBe('disabled');
    expect(await auditRows()).toHaveLength(2);
  });

  it('rejects setting a level on the Admin role (ROLE_IMMUTABLE) — no row, no audit', async () => {
    await expect(
      setSectionPermission({
        db: t.db,
        roleId: SEEDED_ROLE_IDS.admin,
        sectionId: 'ledger',
        level: 'read_only',
        actorId,
      }),
    ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    const rows = await t.db
      .select()
      .from(roleSectionPermissions)
      .where(eq(roleSectionPermissions.roleId, SEEDED_ROLE_IDS.admin));
    expect(rows).toHaveLength(0);
    expect(await auditRows()).toHaveLength(2); // unchanged from the prior test
  });
});

describe('sectionLevelForRole (ADR-021 C-01/C-03 fallbacks)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });

  it('Admin implies edit with no query/row', async () => {
    expect(
      await sectionLevelForRole({
        db: t.db,
        roleId: SEEDED_ROLE_IDS.admin,
        sectionId: 'ledger',
        isAdmin: true,
      }),
    ).toBe('edit');
  });

  it('no row ⇒ the section default (ledger=read_only, trash=disabled)', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Fresh Role',
      appIds: [],
      actorId: null,
    });
    expect(await sectionLevelForRole({ db: t.db, roleId, sectionId: 'ledger' })).toBe('read_only');
    expect(await sectionLevelForRole({ db: t.db, roleId, sectionId: 'trash' })).toBe('disabled');
  });

  it('returns the stored level once set', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Stored Role',
      appIds: [],
      actorId: null,
    });
    await setSectionPermission({ db: t.db, roleId, sectionId: 'ledger', level: 'disabled', actorId: null });
    expect(await sectionLevelForRole({ db: t.db, roleId, sectionId: 'ledger' })).toBe('disabled');
  });
});
