// ADR-026 / DESIGN-012 D-04 — setRoleMessageActions single-writer + messageActionsForRole read.
// Embedded PG16. Proves: replace-in-place set + a same-tx permission_audit 'update_message_actions'
// row records before/after; a row is the grant; the Admin role is immutable (ROLE_IMMUTABLE, no
// rows, no audit); and messageActionsForRole applies the Admin=all + empty-default fallbacks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  MESSAGE_ACTIONS,
  SEEDED_ROLE_IDS,
  permissionAudit,
  roleMessageActionGrants,
} from '@hnet/db/schema';
import {
  SystemRoleImmutableError,
  createRole,
  messageActionsForRole,
  setRoleMessageActions,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('setRoleMessageActions / messageActionsForRole (ADR-026 C-04)', () => {
  let t: TestDb;
  let roleId: string;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'msg-actor@example.com' })).id;
    ({ roleId } = await createRole({ db: t.db, name: 'Posters', appIds: [], actorId }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const grantRows = () =>
    t.db.select().from(roleMessageActionGrants).where(eq(roleMessageActionGrants.roleId, roleId));
  const auditRows = () =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_message_actions'));

  it('starts with no grants (absence ⇒ no actions)', async () => {
    expect(await messageActionsForRole({ db: t.db, roleId })).toEqual([]);
    expect(await grantRows()).toHaveLength(0);
  });

  it('replaces the grant set in place + writes a same-tx audit row (before/after)', async () => {
    const res = await setRoleMessageActions({ db: t.db, roleId, actions: ['post'], actorId });
    expect(res.after).toEqual(['post']);
    expect(res.changed).toBe(true);
    expect(await messageActionsForRole({ db: t.db, roleId })).toEqual(['post']);

    const grants = await grantRows();
    expect(grants.map((g) => g.action)).toEqual(['post']);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ before: [], after: ['post'] });

    // Replace with the full set (canonical order preserved).
    const res2 = await setRoleMessageActions({
      db: t.db,
      roleId,
      actions: ['moderate', 'post'],
      actorId,
    });
    expect(res2.before).toEqual(['post']);
    expect(res2.after).toEqual([...MESSAGE_ACTIONS]);
    expect(await messageActionsForRole({ db: t.db, roleId })).toEqual([...MESSAGE_ACTIONS]);
  });

  it('clears the set to empty', async () => {
    await setRoleMessageActions({ db: t.db, roleId, actions: [], actorId });
    expect(await grantRows()).toHaveLength(0);
    expect(await messageActionsForRole({ db: t.db, roleId })).toEqual([]);
  });

  it('rejects editing the Admin role (immutable — implies all, no rows, no audit)', async () => {
    const auditBefore = (await auditRows()).length;
    await expect(
      setRoleMessageActions({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, actions: ['post'], actorId }),
    ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    expect((await auditRows()).length).toBe(auditBefore);
    // Admin resolves to EVERY action via the fallback (no rows queried).
    expect(await messageActionsForRole({ roleId: SEEDED_ROLE_IDS.admin, isAdmin: true })).toEqual([
      ...MESSAGE_ACTIONS,
    ]);
  });
});
