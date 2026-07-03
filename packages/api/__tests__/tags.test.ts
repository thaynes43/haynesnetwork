// DESIGN-003 test strategy — tags router: D-12 role-scoping of tags.list, audited
// apply/remove (R-04, D-11 idempotency), family-via-tag effective designation
// (DESIGN-001 D-11), and the TAG_NAME_CONFLICT wire code (D-13).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appCatalog } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { isEffectivelyFamily, TagNameConflictError } from '@hnet/domain';
import {
  auditRows,
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
let memberCaller: Caller;
let paperlessId: string;
let familyTagId: string;
let mediaTagId: string;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { role: 'Admin', displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { role: 'Member', displayName: 'Member Mia' });
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
  memberCaller = caller(makeCtx(testDb.db, sessionUser(member)));
  const [paperless] = await testDb.db
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(eq(appCatalog.slug, 'paperless'));
  paperlessId = paperless!.id;

  familyTagId = (
    await adminCaller.tags.create({
      name: 'family',
      description: 'Household members',
      bundle: { isFamily: true },
    })
  ).tagId;
  mediaTagId = (
    await adminCaller.tags.create({
      name: 'media',
      description: 'Media tooling',
      bundle: { appIds: [paperlessId] },
    })
  ).tagId;
});

afterAll(async () => {
  await testDb.stop();
});

describe('tags.list — role-scoped in one resolver (D-12)', () => {
  it('Member with no tags sees an empty member-scoped list', async () => {
    const result = await memberCaller.tags.list();
    expect(result).toEqual({ scope: 'member', tags: [] });
  });

  it('Admin sees ALL tags with full bundles and tagged-user counts', async () => {
    await adminCaller.tags.applyToUser({ tagId: mediaTagId, userId: member.id });

    const result = await adminCaller.tags.list();
    if (result.scope !== 'admin') throw new Error('expected admin scope');
    expect(result.tags.map((t) => t.name)).toEqual(['family', 'media']); // name-ordered

    const family = result.tags.find((t) => t.id === familyTagId)!;
    expect(family.bundle).toEqual({ appIds: [], isFamily: true });
    expect(family.taggedUserCount).toBe(0);

    const media = result.tags.find((t) => t.id === mediaTagId)!;
    expect(media.bundle).toEqual({ appIds: [paperlessId], isFamily: false });
    expect(media.taggedUserCount).toBe(1);
  });

  it('Member sees only their own applied tags, projected to {id,name,description}', async () => {
    const result = await memberCaller.tags.list();
    if (result.scope !== 'member') throw new Error('expected member scope');
    // Only the applied tag — never the full roster (family is NOT applied to Mia).
    expect(result.tags).toEqual([{ id: mediaTagId, name: 'media', description: 'Media tooling' }]);
    // No bundle contents, no counts, no other users (D-12).
    expect(Object.keys(result.tags[0]!).sort()).toEqual(['description', 'id', 'name']);
  });
});

describe('tags.applyToUser / removeFromUser — audited, idempotent (R-21, D-11)', () => {
  it('applyToUser wrote the apply_tag audit row; replay is a no-op with no extra row', async () => {
    // The apply happened in the D-12 test above — exactly one audit row so far.
    let rows = await auditRows(testDb.db, 'apply_tag');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      subjectUserId: member.id,
      tagId: mediaTagId,
    });
    expect(rows[0]!.detail).toMatchObject({ tag_name: 'media' });

    expect(await adminCaller.tags.applyToUser({ tagId: mediaTagId, userId: member.id })).toEqual({
      changed: false,
    });
    rows = await auditRows(testDb.db, 'apply_tag');
    expect(rows).toHaveLength(1);
  });

  it('a family tag flips EFFECTIVE isFamily without touching users.is_family (DESIGN-001 D-11)', async () => {
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(false);
    await adminCaller.tags.applyToUser({ tagId: familyTagId, userId: member.id });
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(true);

    await adminCaller.tags.removeFromUser({ tagId: familyTagId, userId: member.id });
    expect(await isEffectivelyFamily(member.id, testDb.db)).toBe(false);
    expect(await auditRows(testDb.db, 'remove_tag')).toHaveLength(1);
  });
});

describe('tags.create / update — TAG_NAME_CONFLICT (D-13)', () => {
  it('duplicate tag name → CONFLICT with appCode TAG_NAME_CONFLICT on the wire', async () => {
    let thrown: unknown;
    try {
      await adminCaller.tags.create({ name: 'media', bundle: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'CONFLICT' });
    expect((thrown as Error).cause).toBeInstanceOf(TagNameConflictError);
    const shape = wireShape(thrown, 'tags.create');
    expect(shape.data.appCode).toBe('TAG_NAME_CONFLICT');
  });

  it('update replaces the whole bundle and audits update_tag with the delta (D-08)', async () => {
    await adminCaller.tags.update({ id: mediaTagId, bundle: { appIds: [], isFamily: false } });

    const result = await adminCaller.tags.list();
    if (result.scope !== 'admin') throw new Error('expected admin scope');
    const media = result.tags.find((t) => t.id === mediaTagId)!;
    expect(media.bundle).toEqual({ appIds: [], isFamily: false });

    const rows = await auditRows(testDb.db, 'update_tag');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({
      before: { apps: [{ id: paperlessId, slug: 'paperless' }] },
      after: { apps: [] },
    });
  });
});
