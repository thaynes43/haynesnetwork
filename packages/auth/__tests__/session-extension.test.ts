import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGE_ACTIONS, SEEDED_ROLE_IDS, TRASH_ACTIONS } from '@hnet/db/schema';
import { assignRole, createRole, setRoleTrashActions, setSectionPermission } from '@hnet/domain';
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
        // ADR-021 — no rows ⇒ the documented section defaults (ADR-032 flipped ledger to
        // disabled; bulletin stays read_only — the Feed is for everyone).
        sectionPermissions: { ledger: 'disabled', trash: 'disabled', bulletin: 'read_only' },
        // ADR-023 — no grant rows ⇒ no Trash actions.
        trashActions: [],
        // ADR-026 — no grant rows ⇒ no Bulletin message actions.
        messageActions: [],
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
        sectionPermissions: { ledger: 'edit', trash: 'edit', bulletin: 'edit' },
        // ADR-023 C-03 — admin implies EVERY Trash action (no rows).
        trashActions: [...TRASH_ACTIONS],
        // ADR-026 C-04 — admin implies EVERY Bulletin message action (no rows).
        messageActions: [...MESSAGE_ACTIONS],
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
    // Custom role, no rows yet ⇒ the ledger default (disabled — ADR-032).
    const before = await getSessionExtension(user.id, t.db);
    expect(before!.role.sectionPermissions.ledger).toBe('disabled');
    await setSectionPermission({
      db: t.db,
      roleId,
      sectionId: 'ledger',
      level: 'read_only',
      actorId: null,
    });
    const after = await getSessionExtension(user.id, t.db);
    expect(after!.role.sectionPermissions).toEqual({
      ledger: 'read_only',
      trash: 'disabled',
      bulletin: 'read_only',
    });
  });

  it('hydrates the fine-grained Trash action grants after setRoleTrashActions (ADR-023 C-03)', async () => {
    const { roleId } = await createRole({
      db: t.db,
      name: 'Trash Saver',
      appIds: [],
      actorId: null,
    });
    const user = await createUser(t.db, { displayName: 'Save Sam', roleId });
    // No grant rows yet ⇒ empty action set.
    const before = await getSessionExtension(user.id, t.db);
    expect(before!.role.trashActions).toEqual([]);
    await setRoleTrashActions({
      db: t.db,
      roleId,
      actions: ['save_exclude', 'remove_exclude'],
      actorId: null,
    });
    const after = await getSessionExtension(user.id, t.db);
    // Canonical order preserved (TRASH_ACTIONS order), grants reflected.
    expect(after!.role.trashActions).toEqual(['save_exclude', 'remove_exclude']);
  });

  it('returns null (fail closed) for a missing user', async () => {
    expect(await getSessionExtension('00000000-0000-0000-0000-000000000000', t.db)).toBeNull();
  });
});
