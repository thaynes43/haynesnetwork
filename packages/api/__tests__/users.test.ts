// DESIGN-003 test strategy — users router: direct grants and family designation
// mutate state AND write their permission_audit row in the same transaction outcome
// (R-04, ADR-003); idempotent replays are no-ops with no audit row (D-11); users.list
// composes the R-15/R-22 admin roster.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCatalog, users as usersTable } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { isEffectivelyFamily } from '@hnet/domain';
import {
  auditRows,
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let testDb: TestDb;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let adminCaller: Caller;
let immichId: string;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { role: 'Admin', displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { role: 'Member', displayName: 'Member Mia' });
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
  const [immich] = await testDb.db
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(eq(appCatalog.slug, 'immich'));
  immichId = immich!.id;
});

afterAll(async () => {
  await testDb.stop();
});

describe('users.grantApp / users.revokeApp — audited direct grants (R-15, R-04)', () => {
  it('grantApp writes the grant and its grant_app audit row; replay is a no-op (D-11)', async () => {
    expect(await adminCaller.users.grantApp({ userId: member.id, appId: immichId })).toEqual({
      changed: true,
    });

    let rows = await auditRows(testDb.db, 'grant_app');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      subjectUserId: member.id,
      appId: immichId,
    });
    expect(rows[0]!.detail).toMatchObject({ app_slug: 'immich' });

    // Idempotent replay: no change, NO second audit row.
    expect(await adminCaller.users.grantApp({ userId: member.id, appId: immichId })).toEqual({
      changed: false,
    });
    rows = await auditRows(testDb.db, 'grant_app');
    expect(rows).toHaveLength(1);
  });

  it('revokeApp removes the grant and writes revoke_app; replay is a no-op', async () => {
    expect(await adminCaller.users.revokeApp({ userId: member.id, appId: immichId })).toEqual({
      changed: true,
    });

    let rows = await auditRows(testDb.db, 'revoke_app');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      subjectUserId: member.id,
      appId: immichId,
    });

    expect(await adminCaller.users.revokeApp({ userId: member.id, appId: immichId })).toEqual({
      changed: false,
    });
    rows = await auditRows(testDb.db, 'revoke_app');
    expect(rows).toHaveLength(1);
  });

  it('unknown app or user → NOT_FOUND', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await expect(
      adminCaller.users.grantApp({ userId: member.id, appId: ghost }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      adminCaller.users.grantApp({ userId: ghost, appId: immichId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('users.setFamily — direct designation flips EFFECTIVE isFamily (D-01/D-11)', () => {
  it('setFamily(true) flips users.is_family, effective family, and audits set_family', async () => {
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(false);

    expect(await adminCaller.users.setFamily({ userId: member.id, isFamily: true })).toEqual({
      changed: true,
    });

    const [row] = await testDb.db
      .select({ isFamily: usersTable.isFamily })
      .from(usersTable)
      .where(eq(usersTable.id, member.id));
    expect(row!.isFamily).toBe(true);
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(true);

    const rows = await auditRows(testDb.db, 'set_family');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.id, subjectUserId: member.id });

    // Idempotent replay (D-11): already Family → no change, no audit row.
    expect(await adminCaller.users.setFamily({ userId: member.id, isFamily: true })).toEqual({
      changed: false,
    });
    expect(await auditRows(testDb.db, 'set_family')).toHaveLength(1);
  });

  it('setFamily(false) flips it back and audits unset_family', async () => {
    expect(await adminCaller.users.setFamily({ userId: member.id, isFamily: false })).toEqual({
      changed: true,
    });
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(false);
    expect(await auditRows(testDb.db, 'unset_family')).toHaveLength(1);
  });
});

describe('users.list — the R-15/R-22 admin roster (D-09)', () => {
  it('composes role, direct family flag, tags, and direct grants per user', async () => {
    await adminCaller.users.grantApp({ userId: member.id, appId: immichId });
    const { tagId } = await adminCaller.tags.create({
      name: 'streamers',
      bundle: {},
    });
    await adminCaller.tags.applyToUser({ tagId, userId: member.id });

    const roster = await adminCaller.users.list();
    expect(roster.map((u) => u.displayName)).toEqual(['Admin Ada', 'Member Mia']);

    const mia = roster.find((u) => u.id === member.id)!;
    expect(mia).toMatchObject({
      email: member.email,
      role: 'Member',
      isFamily: false,
      tags: [{ id: tagId, name: 'streamers' }],
      directGrants: [{ appId: immichId }],
    });
    expect(typeof mia.createdAt).toBe('string'); // D-03: ISO-8601 on the wire
    expect(new Date(mia.createdAt).toISOString()).toBe(mia.createdAt);

    const ada = roster.find((u) => u.id === admin.id)!;
    expect(ada.tags).toEqual([]);
    expect(ada.directGrants).toEqual([]);
  });
});
