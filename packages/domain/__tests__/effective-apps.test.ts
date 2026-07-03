import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyTag,
  createApp,
  createTag,
  effectiveAppsForUser,
  grantApp,
  isEffectivelyFamily,
  removeTag,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('effectiveAppsForUser over the effective_app_grants view (DESIGN-001 D-11, R-22, AC-06)', () => {
  let t: TestDb;
  let adminId: string;
  let userId: string;
  let appA: string;
  let appB: string;
  let tagId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    adminId = (await createUser(t.db)).id;
    userId = (await createUser(t.db)).id;
    ({ appId: appA } = await createApp({
      db: t.db,
      slug: 'app-a',
      name: 'App A',
      url: 'https://app-a.haynesnetwork.com',
      sortOrder: 110,
      actorId: adminId,
    }));
    ({ appId: appB } = await createApp({
      db: t.db,
      slug: 'app-b',
      name: 'App B',
      url: 'https://app-b.haynesnetwork.com',
      sortOrder: 120,
      actorId: adminId,
    }));
    ({ tagId } = await createTag({
      db: t.db,
      name: 'bundle-b',
      bundle: { appIds: [appB] },
      actorId: adminId,
    }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('returns the union of direct grants and tag grants, each with provenance', async () => {
    await grantApp({ db: t.db, userId, appId: appA, actorId: adminId });
    await applyTag({ db: t.db, tagId, userId, actorId: adminId });

    const apps = await effectiveAppsForUser(userId, t.db);
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ appId: appA, slug: 'app-a', source: 'direct', tagId: null });
    expect(apps[1]).toMatchObject({ appId: appB, slug: 'app-b', source: 'tag', tagId });
  });

  it('keeps one row per provenance when direct and tag grants overlap (UNION ALL)', async () => {
    await grantApp({ db: t.db, userId, appId: appB, actorId: adminId }); // now B is direct AND tagged
    const apps = await effectiveAppsForUser(userId, t.db);
    expect(apps).toHaveLength(3);
    const bRows = apps.filter((a) => a.appId === appB);
    expect(bRows.map((r) => r.source).sort()).toEqual(['direct', 'tag']);
  });

  it('removing a tag removes exactly the tag-derived rows, never direct grants (AC-06)', async () => {
    await removeTag({ db: t.db, tagId, userId, actorId: adminId });
    const apps = await effectiveAppsForUser(userId, t.db);
    expect(apps).toHaveLength(2);
    expect(apps.every((a) => a.source === 'direct')).toBe(true);
    expect(apps.map((a) => a.appId).sort()).toEqual([appA, appB].sort());
  });

  it('isEffectivelyFamily: direct designation OR any family tag (D-11)', async () => {
    expect(await isEffectivelyFamily(userId, t.db)).toBe(false);

    const { tagId: familyTag } = await createTag({
      db: t.db,
      name: 'family',
      bundle: { appIds: [], isFamily: true },
      actorId: adminId,
    });
    await applyTag({ db: t.db, tagId: familyTag, userId, actorId: adminId });
    expect(await isEffectivelyFamily(userId, t.db)).toBe(true);

    await removeTag({ db: t.db, tagId: familyTag, userId, actorId: adminId });
    expect(await isEffectivelyFamily(userId, t.db)).toBe(false);
  });
});
