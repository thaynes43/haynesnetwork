import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ROLE_IDS } from '@hnet/db/schema';
import { assignRole } from '@hnet/domain';
import { getSessionExtension } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('session extension (DESIGN-002 D-06 / DESIGN-003 D-01, ADR-012)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('hydrates the Default role + displayName for a new user (role.isAdmin false)', async () => {
    const user = await createUser(t.db, { displayName: 'Owner Haynes' });
    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: { id: SEEDED_ROLE_IDS.default, name: 'Default', isAdmin: false },
      displayName: 'Owner Haynes',
    });
  });

  it('hydrates the Admin role after assignment (role.isAdmin true)', async () => {
    const user = await createUser(t.db, { displayName: 'Admin Ada' });
    await assignRole({
      db: t.db,
      userId: user.id,
      toRoleId: SEEDED_ROLE_IDS.admin,
      initiator: { id: null, kind: 'system' },
    });
    expect(await getSessionExtension(user.id, t.db)).toEqual({
      role: { id: SEEDED_ROLE_IDS.admin, name: 'Admin', isAdmin: true },
      displayName: 'Admin Ada',
    });
  });

  it('returns null (fail closed) for a missing user', async () => {
    expect(await getSessionExtension('00000000-0000-0000-0000-000000000000', t.db)).toBeNull();
  });
});
