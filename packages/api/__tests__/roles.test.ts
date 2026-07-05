// ADR-012 test strategy — roles router: list (flags + app sets + member counts), audited
// CRUD via the domain writers, and the D-13 error taxonomy (ROLE_NAME_CONFLICT,
// ROLE_IMMUTABLE) through the real errorFormatter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appCatalog, SEEDED_ROLE_IDS } from '@hnet/db';
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
let adminCaller: Caller;
let seerrId: string;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  const admin = await createUser(testDb.db, { admin: true });
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
  const [seerr] = await testDb.db
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(eq(appCatalog.slug, 'seerr'));
  seerrId = seerr!.id;
});

afterAll(async () => {
  await testDb.stop();
});

describe('roles.list', () => {
  it('lists the seeded Admin + Default roles with flags, app sets, and member counts', async () => {
    const roles = await adminCaller.roles.list();
    const byName = new Map(roles.map((r) => [r.name, r]));

    expect(byName.get('Admin')).toMatchObject({ isAdmin: true, isDefault: false, appIds: [] });
    expect(byName.get('Default')).toMatchObject({ isAdmin: false, isDefault: true, grantsAll: false });
    expect(byName.get('Default')!.appIds.length).toBe(4); // seerr/plex/k8plex/plexops seeded
    expect(byName.get('Family')).toMatchObject({ isAdmin: false, isDefault: false, grantsAll: false });
    expect(byName.get('Family')!.appIds.length).toBe(7); // everything except tautulli
    expect(byName.get('Admin')!.memberCount).toBe(1); // the admin user created above
  });
});

describe('roles.create / update / delete', () => {
  it('creates a role with an app set', async () => {
    const { roleId } = await adminCaller.roles.create({
      name: 'friends',
      description: 'pals',
      appIds: [seerrId],
    });
    const created = (await adminCaller.roles.list()).find((r) => r.id === roleId)!;
    expect(created).toMatchObject({ name: 'friends', appIds: [seerrId], memberCount: 0, grantsAll: false });
  });

  it('an "All apps" role (grantsAll) stores no explicit app rows', async () => {
    const { roleId } = await adminCaller.roles.create({ name: 'all-access', grantsAll: true });
    const created = (await adminCaller.roles.list()).find((r) => r.id === roleId)!;
    expect(created).toMatchObject({ grantsAll: true, appIds: [] });
  });

  it('a duplicate name → CONFLICT with appCode ROLE_NAME_CONFLICT', async () => {
    let thrown: unknown;
    try {
      await adminCaller.roles.create({ name: 'Default' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'CONFLICT' });
    expect(wireShape(thrown, 'roles.create').data.appCode).toBe('ROLE_NAME_CONFLICT');
  });

  it('editing the Admin role → FORBIDDEN with appCode ROLE_IMMUTABLE', async () => {
    let thrown: unknown;
    try {
      await adminCaller.roles.update({ id: SEEDED_ROLE_IDS.admin, appIds: [seerrId] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'FORBIDDEN' });
    expect(wireShape(thrown, 'roles.update').data.appCode).toBe('ROLE_IMMUTABLE');
  });

  it('renaming the Default role → FORBIDDEN (ROLE_IMMUTABLE); its apps stay editable', async () => {
    await expect(
      adminCaller.roles.update({ id: SEEDED_ROLE_IDS.default, name: 'Basic' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // apps editable:
    const res = await adminCaller.roles.update({ id: SEEDED_ROLE_IDS.default, appIds: [seerrId] });
    expect(res.changed).toBe(true);
  });

  it('deleting a system role → FORBIDDEN; a custom role deletes cleanly', async () => {
    await expect(
      adminCaller.roles.delete({ id: SEEDED_ROLE_IDS.default }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const { roleId } = await adminCaller.roles.create({ name: 'temp' });
    await adminCaller.roles.delete({ id: roleId });
    expect((await adminCaller.roles.list()).find((r) => r.id === roleId)).toBeUndefined();
  });
});
