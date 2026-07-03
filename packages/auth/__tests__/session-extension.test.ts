import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTag, createTag } from '@hnet/domain';
import { getSessionExtension, getSessionRole } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('session extension (DESIGN-002 D-06 / DESIGN-003 D-01)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('getSessionRole returns role + displayName for a known user id', async () => {
    const user = await createUser(t.db, { displayName: 'Owner Haynes' });
    expect(await getSessionRole(user.id, t.db)).toEqual({
      role: 'Member',
      displayName: 'Owner Haynes',
    });
  });

  it('getSessionRole throws when the user disappeared between signin and lookup', async () => {
    await expect(getSessionRole('00000000-0000-0000-0000-000000000000', t.db)).rejects.toThrow(
      /disappeared/,
    );
  });

  it('getSessionExtension hydrates role and the DIRECT family designation', async () => {
    const user = await createUser(t.db, { displayName: 'Direct Family', isFamily: true });
    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: 'Member',
      displayName: 'Direct Family',
      isFamily: true,
    });
  });

  it('getSessionExtension reports EFFECTIVE family via an applied family tag (DESIGN-001 D-11)', async () => {
    const user = await createUser(t.db, { displayName: 'Tagged Family' });
    const before = await getSessionExtension(user.id, t.db);
    expect(before?.isFamily).toBe(false);

    const { tagId } = await createTag({
      db: t.db,
      name: 'household',
      bundle: { isFamily: true },
      actorId: null,
    });
    await applyTag({ db: t.db, tagId, userId: user.id, actorId: null });

    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: 'Member',
      displayName: 'Tagged Family',
      isFamily: true,
    });
  });

  it('getSessionExtension returns null (fail closed) for a missing user', async () => {
    expect(await getSessionExtension('00000000-0000-0000-0000-000000000000', t.db)).toBeNull();
  });
});
