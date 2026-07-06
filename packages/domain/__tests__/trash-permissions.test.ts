// ADR-023 / DESIGN-010 D-03 — setRoleTrashActions single-writer + trashActionsForRole read.
// Embedded PG16. Proves: the fine-grained grant set replaces-in-place + a same-tx
// permission_audit 'update_trash_actions' row records the before/after action lists; a row is
// the grant (presence); the Admin role is immutable (ROLE_IMMUTABLE, no rows, no audit); and
// trashActionsForRole applies the Admin=all and empty-default fallbacks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  permissionAudit,
  roleTrashActionGrants,
  SEEDED_ROLE_IDS,
  TRASH_ACTIONS,
} from '@hnet/db/schema';
import {
  SystemRoleImmutableError,
  createRole,
  setRoleTrashActions,
  trashActionsForRole,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('setRoleTrashActions (ADR-023 C-03)', () => {
  let t: TestDb;
  let roleId: string;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'trash-actor@example.com' })).id;
    ({ roleId } = await createRole({ db: t.db, name: 'Trash Crew', appIds: [], actorId }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const grantRows = () =>
    t.db.select().from(roleTrashActionGrants).where(eq(roleTrashActionGrants.roleId, roleId));

  const auditRows = () =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_trash_actions'));

  it('grants a set and co-writes a permission_audit row in the same tx (before=empty)', async () => {
    const res = await setRoleTrashActions({
      db: t.db,
      roleId,
      actions: ['save_exclude', 'remove_exclude'],
      actorId,
    });
    expect(res).toEqual({
      changed: true,
      before: [],
      after: ['save_exclude', 'remove_exclude'],
    });
    const rows = await grantRows();
    expect(rows.map((r) => r.action).sort()).toEqual(['remove_exclude', 'save_exclude']);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId, roleId });
    expect(audits[0]!.detail).toMatchObject({
      before: [],
      after: ['save_exclude', 'remove_exclude'],
    });
  });

  it('replaces the whole set in place (before = the stored set)', async () => {
    const res = await setRoleTrashActions({
      db: t.db,
      roleId,
      actions: ['expedite_item', 'save_exclude'],
      actorId,
    });
    // Canonical order (TRASH_ACTIONS order) in the audit + return.
    expect(res.before).toEqual(['save_exclude', 'remove_exclude']);
    expect(res.after).toEqual(['save_exclude', 'expedite_item']);
    const rows = await grantRows();
    expect(rows).toHaveLength(2);
    expect(await auditRows()).toHaveLength(2);
  });

  it('clearing to the empty set deletes all rows (still audited)', async () => {
    const res = await setRoleTrashActions({ db: t.db, roleId, actions: [], actorId });
    expect(res.after).toEqual([]);
    expect(await grantRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(3);
  });

  it('rejects setting actions on the Admin role (ROLE_IMMUTABLE) — no rows, no audit', async () => {
    await expect(
      setRoleTrashActions({
        db: t.db,
        roleId: SEEDED_ROLE_IDS.admin,
        actions: ['save_exclude'],
        actorId,
      }),
    ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    const rows = await t.db
      .select()
      .from(roleTrashActionGrants)
      .where(eq(roleTrashActionGrants.roleId, SEEDED_ROLE_IDS.admin));
    expect(rows).toHaveLength(0);
    expect(await auditRows()).toHaveLength(3); // unchanged
  });
});

describe('trashActionsForRole (ADR-023 C-03 fallbacks)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });

  it('Admin implies every action with no query/row', async () => {
    expect(
      await trashActionsForRole({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, isAdmin: true }),
    ).toEqual([...TRASH_ACTIONS]);
  });

  it('no rows ⇒ the empty set', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Fresh Trash', appIds: [], actorId: null });
    expect(await trashActionsForRole({ db: t.db, roleId })).toEqual([]);
  });

  it('returns exactly the granted actions in canonical order', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Granted Trash', appIds: [], actorId: null });
    await setRoleTrashActions({
      db: t.db,
      roleId,
      actions: ['restore_deleted', 'save_exclude'],
      actorId: null,
    });
    expect(await trashActionsForRole({ db: t.db, roleId })).toEqual([
      'save_exclude',
      'restore_deleted',
    ]);
  });
});
