import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ROLE_IDS } from '@hnet/db/schema';
import { assignRole, createRole, setSectionPermission } from '@hnet/domain';
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
      role: {
        id: SEEDED_ROLE_IDS.default,
        name: 'Default',
        isAdmin: false,
        // ADR-021 — no rows ⇒ the documented section defaults.
        sectionPermissions: { ledger: 'read_only', trash: 'disabled' },
      },
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
      role: {
        id: SEEDED_ROLE_IDS.admin,
        name: 'Admin',
        isAdmin: true,
        // ADR-021 C-03 — admin implies Edit on every section (no rows).
        sectionPermissions: { ledger: 'edit', trash: 'edit' },
      },
      displayName: 'Admin Ada',
    });
  });

  it('hydrates a non-default section level after setSectionPermission (ADR-021 C-02)', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Ledger-Locked',
      appIds: [],
      actorId: null,
    });
    const user = await createUser(t.db, { displayName: 'Locked Lou', roleId });
    // Custom role, no rows yet ⇒ the ledger default (read_only).
    const before = await getSessionExtension(user.id, t.db);
    expect(before!.role.sectionPermissions.ledger).toBe('read_only');
    await setSectionPermission({
      db: t.db,
      roleId,
      sectionId: 'ledger',
      level: 'disabled',
      actorId: null,
    });
    const after = await getSessionExtension(user.id, t.db);
    expect(after!.role.sectionPermissions).toEqual({ ledger: 'disabled', trash: 'disabled' });
  });

  it('returns null (fail closed) for a missing user', async () => {
    expect(await getSessionExtension('00000000-0000-0000-0000-000000000000', t.db)).toBeNull();
  });
});
