import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionAudit, roleAppGrants, roles, userRoleTransitions, users, SEEDED_ROLE_IDS } from '@hnet/db/schema';
import {
  ConcurrentTransitionError,
  LastAdminError,
  RoleNameConflictError,
  SystemRoleImmutableError,
  assignRole,
  createApp,
  createRole,
  deleteRole,
  updateRole,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('role writers (ADR-012, D-12)', () => {
  let t: TestDb;
  let appA: string;
  let appB: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    ({ appId: appA } = await createApp({
      db: t.db,
      slug: 'app-a',
      name: 'App A',
      url: 'https://app-a.haynesnetwork.com',
      sortOrder: 110,
      actorId: null,
    }));
    ({ appId: appB } = await createApp({
      db: t.db,
      slug: 'app-b',
      name: 'App B',
      url: 'https://app-b.haynesnetwork.com',
      sortOrder: 120,
      actorId: null,
    }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe('createRole', () => {
    it('creates a role + its app grants + a create_role audit row in one tx', async () => {
      const { roleId } = await createRole({
        db: t.db,
        name: 'streamers',
        description: 'Streaming apps',
        appIds: [appA],
        actorId: null,
      });
      const [role] = await t.db.select().from(roles).where(eq(roles.id, roleId));
      expect(role).toMatchObject({ name: 'streamers', isAdmin: false, isDefault: false });
      const grants = await t.db.select().from(roleAppGrants).where(eq(roleAppGrants.roleId, roleId));
      expect(grants.map((g) => g.appId)).toEqual([appA]);
      const audits = await t.db
        .select()
        .from(permissionAudit)
        .where(eq(permissionAudit.roleId, roleId));
      expect(audits.filter((a) => a.action === 'create_role')).toHaveLength(1);
    });

    it('rejects a duplicate name (incl. the seeded system roles) with RoleNameConflictError', async () => {
      await expect(createRole({ db: t.db, name: 'Default', actorId: null })).rejects.toBeInstanceOf(
        RoleNameConflictError,
      );
    });
  });

  describe('updateRole', () => {
    it('renames a custom role and replaces its whole app set + update_role audit', async () => {
      const { roleId } = await createRole({ db: t.db, name: 'to-edit', appIds: [appA], actorId: null });
      const res = await updateRole({ db: t.db, roleId, name: 'edited', appIds: [appB], actorId: null });
      expect(res.changed).toBe(true);
      const [role] = await t.db.select().from(roles).where(eq(roles.id, roleId));
      expect(role?.name).toBe('edited');
      const grants = await t.db.select().from(roleAppGrants).where(eq(roleAppGrants.roleId, roleId));
      expect(grants.map((g) => g.appId)).toEqual([appB]);
    });

    it('refuses to edit the Admin role (superuser, immutable)', async () => {
      await expect(
        updateRole({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, appIds: [appA], actorId: null }),
      ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    });

    it('lets the Default role apps be edited but blocks renaming it', async () => {
      const ok = await updateRole({ db: t.db, roleId: SEEDED_ROLE_IDS.default, appIds: [appA, appB], actorId: null });
      expect(ok.changed).toBe(true);
      await expect(
        updateRole({ db: t.db, roleId: SEEDED_ROLE_IDS.default, name: 'Basic', actorId: null }),
      ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    });
  });

  describe('deleteRole', () => {
    it('reassigns members to Default, then deletes (system roles are protected)', async () => {
      const { roleId } = await createRole({ db: t.db, name: 'doomed', appIds: [appA], actorId: null });
      const user = await createUser(t.db);
      await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });

      const res = await deleteRole({ db: t.db, roleId, actorId: null });
      expect(res.reassigned).toBe(1);
      const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
      expect(after?.roleId).toBe(SEEDED_ROLE_IDS.default);
      const [gone] = await t.db.select().from(roles).where(eq(roles.id, roleId));
      expect(gone).toBeUndefined();
      // A per-user transition row records the reassignment (to Default) — audit-complete.
      const transitions = await t.db
        .select()
        .from(userRoleTransitions)
        .where(eq(userRoleTransitions.userId, user.id));
      expect(transitions.some((tr) => tr.toRoleId === SEEDED_ROLE_IDS.default)).toBe(true);
    });

    it('refuses to delete the Admin or Default role', async () => {
      await expect(deleteRole({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, actorId: null })).rejects.toBeInstanceOf(
        SystemRoleImmutableError,
      );
      await expect(deleteRole({ db: t.db, roleId: SEEDED_ROLE_IDS.default, actorId: null })).rejects.toBeInstanceOf(
        SystemRoleImmutableError,
      );
    });
  });

  describe('assignRole', () => {
    it('assigns a Default user to a role and writes the transition audit in the same tx', async () => {
      const user = await createUser(t.db); // defaults to the Default role
      const { roleId } = await createRole({ db: t.db, name: 'assignable', appIds: [appA], actorId: null });
      const res = await assignRole({
        db: t.db,
        userId: user.id,
        toRoleId: roleId,
        initiator: { id: null, kind: 'system' },
      });
      expect(res).toMatchObject({ changed: true, fromRoleId: SEEDED_ROLE_IDS.default });
      const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
      expect(after?.roleId).toBe(roleId);
      const audits = await t.db
        .select()
        .from(userRoleTransitions)
        .where(eq(userRoleTransitions.userId, user.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ fromRoleId: SEEDED_ROLE_IDS.default, toRoleId: roleId });
    });

    it('is idempotent: repeating a same-role assignment is a no-op with no extra audit', async () => {
      const user = await createUser(t.db);
      const first = await assignRole({
        db: t.db,
        userId: user.id,
        toRoleId: SEEDED_ROLE_IDS.admin,
        initiator: { id: null, kind: 'system' },
      });
      expect(first.changed).toBe(true);
      const repeat = await assignRole({
        db: t.db,
        userId: user.id,
        toRoleId: SEEDED_ROLE_IDS.admin,
        initiator: { id: null, kind: 'system' },
      });
      expect(repeat.changed).toBe(false);
      const audits = await t.db
        .select()
        .from(userRoleTransitions)
        .where(eq(userRoleTransitions.userId, user.id));
      expect(audits).toHaveLength(1);
    });

    it('throws ConcurrentTransitionError when expectedFromRoleId is stale', async () => {
      const user = await createUser(t.db); // Default
      await expect(
        assignRole({
          db: t.db,
          userId: user.id,
          toRoleId: SEEDED_ROLE_IDS.admin,
          expectedFromRoleId: SEEDED_ROLE_IDS.admin, // stale: user is Default
          initiator: { id: null, kind: 'system' },
        }),
      ).rejects.toBeInstanceOf(ConcurrentTransitionError);
    });
  });
});

// Isolated DB so the admin count is deterministic (a fresh migrated DB has zero users).
describe('assignRole last-admin guard (ADR-012)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });

  it('refuses to demote the only Admin, but allows it once a second Admin exists', async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    await assignRole({ db: t.db, userId: a.id, toRoleId: SEEDED_ROLE_IDS.admin, initiator: { id: null, kind: 'system' } });

    // a is the last Admin — can't move them off.
    await expect(
      assignRole({ db: t.db, userId: a.id, toRoleId: SEEDED_ROLE_IDS.default, initiator: { id: null, kind: 'system' } }),
    ).rejects.toBeInstanceOf(LastAdminError);

    // Promote b, then a can step down.
    await assignRole({ db: t.db, userId: b.id, toRoleId: SEEDED_ROLE_IDS.admin, initiator: { id: null, kind: 'system' } });
    const res = await assignRole({
      db: t.db,
      userId: a.id,
      toRoleId: SEEDED_ROLE_IDS.default,
      initiator: { id: null, kind: 'system' },
    });
    expect(res.changed).toBe(true);
  });
});
