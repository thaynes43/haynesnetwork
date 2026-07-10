import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ROLE_IDS } from '@hnet/db/schema';
import { assignRole, createApp, createRole, effectiveAppsForUser, updateRole } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('effectiveAppsForUser (ADR-012 — role-based, replaces the tri-union view)', () => {
  let t: TestDb;
  let appA: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    ({ appId: appA } = await createApp({
      db: t.db,
      slug: 'extra',
      name: 'Extra',
      url: 'https://extra.haynesnetwork.com',
      sortOrder: 200,
      actorId: null,
    }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('a Default-role user sees exactly the Default role app set (seeded default-visible + plexops)', async () => {
    const user = await createUser(t.db); // role_id defaults to Default
    const apps = await effectiveAppsForUser(user.id, t.db);
    expect(apps.map((a) => a.slug)).toEqual(['seerr', 'plex', 'k8plex', 'plexops']);
  });

  it('an Admin-role user sees EVERY catalog app (implicit all-apps, including hidden/new ones)', async () => {
    const admin = await createUser(t.db);
    await assignRole({
      db: t.db,
      userId: admin.id,
      toRoleId: SEEDED_ROLE_IDS.admin,
      initiator: { id: null, kind: 'system' },
    });
    const slugs = (await effectiveAppsForUser(admin.id, t.db)).map((a) => a.slug);
    expect(slugs).toHaveLength(11); // 10 seeded (+ kavita/audiobookshelf, ADR-046) + 'extra'
    expect(slugs).toContain('extra');
    expect(slugs).toContain('tautulli'); // a normally-hidden app — admins still see it
    expect(slugs).toContain('kavita'); // ADR-046 — seeded book-server card, admins see it implicitly
  });

  it('a custom role grants exactly its app set, and editing the role updates effective apps', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'extra-only', appIds: [appA], actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    expect((await effectiveAppsForUser(user.id, t.db)).map((a) => a.slug)).toEqual(['extra']);

    await updateRole({ db: t.db, roleId, appIds: [], actorId: null }); // empty the set
    expect(await effectiveAppsForUser(user.id, t.db)).toHaveLength(0);
  });

  // Runs LAST — it adds a catalog app, which would perturb the exact-count assertions above.
  it('a grants_all role sees EVERY app — including one added after the role was created', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'all-access', grantsAll: true, actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    const before = (await effectiveAppsForUser(user.id, t.db)).map((a) => a.slug);
    expect(before).toContain('extra');
    expect(before).toContain('tautulli'); // grants_all includes normally-hidden apps
    // A brand-new catalog app is auto-included without touching the role.
    await createApp({
      db: t.db,
      slug: 'brand-new',
      name: 'Brand New',
      url: 'https://brand-new.haynesnetwork.com',
      sortOrder: 300,
      actorId: null,
    });
    expect((await effectiveAppsForUser(user.id, t.db)).map((a) => a.slug)).toContain('brand-new');
  });
});
