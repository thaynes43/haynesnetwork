// DESIGN-003 / ADR-012 — users router: the admin roster carries each user's single role
// { id, name, isAdmin }; setRole delegates to the assignRole single-writer (idempotent,
// last-admin-guarded), surfacing the D-13 appCodes on the wire.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ROLE_IDS } from '@hnet/db';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  wireShape,
  type Caller,
  type TestDb,
} from './helpers';

let testDb: TestDb;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let adminCaller: Caller;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { displayName: 'Member Mia' }); // Default role
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
});

afterAll(async () => {
  await testDb.stop();
});

describe('users.list — the admin roster (ADR-012, D-09)', () => {
  it('returns each user with their single role { id, name, isAdmin } and ISO createdAt', async () => {
    const roster = await adminCaller.users.list();
    expect(roster.map((u) => u.displayName)).toEqual(['Admin Ada', 'Member Mia']);

    const mia = roster.find((u) => u.id === member.id)!;
    expect(mia).toMatchObject({
      email: member.email,
      role: { id: SEEDED_ROLE_IDS.default, name: 'Default', isAdmin: false },
    });
    expect(typeof mia.createdAt).toBe('string'); // D-03: ISO-8601 on the wire
    expect(new Date(mia.createdAt).toISOString()).toBe(mia.createdAt);

    const ada = roster.find((u) => u.id === admin.id)!;
    expect(ada.role).toMatchObject({ name: 'Admin', isAdmin: true });
  });
});

describe('users.setRole — role assignment (ADR-012, R-04)', () => {
  it('assigns a user to a role; an idempotent replay is a no-op', async () => {
    const { roleId } = await adminCaller.roles.create({ name: 'assignees', appIds: [] });
    const first = await adminCaller.users.setRole({ userId: member.id, roleId });
    expect(first).toMatchObject({ changed: true, fromRoleId: SEEDED_ROLE_IDS.default });

    const repeat = await adminCaller.users.setRole({ userId: member.id, roleId });
    expect(repeat.changed).toBe(false);

    await adminCaller.users.setRole({ userId: member.id, roleId: SEEDED_ROLE_IDS.default }); // restore
  });

  it('unknown user or role → NOT_FOUND', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await expect(
      adminCaller.users.setRole({ userId: ghost, roleId: SEEDED_ROLE_IDS.default }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      adminCaller.users.setRole({ userId: member.id, roleId: ghost }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('demoting the last Admin → CONFLICT with appCode LAST_ADMIN (D-13)', async () => {
    let thrown: unknown;
    try {
      await adminCaller.users.setRole({ userId: admin.id, roleId: SEEDED_ROLE_IDS.default });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'CONFLICT' });
    expect(wireShape(thrown, 'users.setRole').data.appCode).toBe('LAST_ADMIN');
  });
});
