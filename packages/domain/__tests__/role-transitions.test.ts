import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userRoleTransitions, users } from '@hnet/db/schema';
import { ConcurrentTransitionError, transitionRole } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('transitionRole (DESIGN-001 D-04/D-12, AC-03)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('promotes Member → Admin and writes the audit row in the same transaction', async () => {
    const user = await createUser(t.db);
    expect(user.role).toBe('Member'); // R-03 default

    const result = await transitionRole({
      db: t.db,
      userId: user.id,
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
      note: 'BOOTSTRAP_ADMIN_EMAILS promotion',
    });
    expect(result).toEqual({ changed: true, fromRole: 'Member' });

    const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.role).toBe('Admin');

    const audits = await t.db
      .select()
      .from(userRoleTransitions)
      .where(eq(userRoleTransitions.userId, user.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      fromRole: 'Member',
      toRole: 'Admin',
      initiatorId: null,
      initiatorKind: 'system',
      note: 'BOOTSTRAP_ADMIN_EMAILS promotion',
    });
  });

  it('is idempotent: repeating the transition is a no-op with no extra audit row', async () => {
    const user = await createUser(t.db);
    await transitionRole({
      db: t.db,
      userId: user.id,
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
    });

    const repeat = await transitionRole({
      db: t.db,
      userId: user.id,
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
    });
    expect(repeat).toEqual({ changed: false, fromRole: 'Admin' });

    const audits = await t.db
      .select()
      .from(userRoleTransitions)
      .where(eq(userRoleTransitions.userId, user.id));
    expect(audits).toHaveLength(1);
  });

  it('supports admin-initiated transitions with the initiator recorded', async () => {
    const admin = await createUser(t.db);
    await transitionRole({
      db: t.db,
      userId: admin.id,
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
    });
    const member = await createUser(t.db);

    await transitionRole({
      db: t.db,
      userId: member.id,
      toRole: 'Admin',
      initiator: { id: admin.id, kind: 'admin' },
    });
    const audits = await t.db
      .select()
      .from(userRoleTransitions)
      .where(eq(userRoleTransitions.userId, member.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ initiatorId: admin.id, initiatorKind: 'admin' });
  });

  it('throws ConcurrentTransitionError when expectedFromRole is stale (donor guard)', async () => {
    const user = await createUser(t.db);
    await transitionRole({
      db: t.db,
      userId: user.id,
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
    });

    await expect(
      transitionRole({
        db: t.db,
        userId: user.id,
        toRole: 'Member',
        expectedFromRole: 'Member', // stale: user is already Admin
        initiator: { id: null, kind: 'system' },
      }),
    ).rejects.toBeInstanceOf(ConcurrentTransitionError);
  });
});
