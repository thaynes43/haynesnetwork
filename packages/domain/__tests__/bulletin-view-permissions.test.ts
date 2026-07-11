// ADR-049 / DESIGN-012 amend (PLAN-027) — setRoleBulletinViews single-writer + bulletinViewsForRole
// read. Embedded PG16. Proves: replace-in-place set + a same-tx permission_audit 'update_bulletin_views'
// row records before/after; a row is the grant; the RESOLUTION defaults to BOTH views when no rows
// exist (ADR-026 C-02 "Bulletin is for everyone"); clearing the set RE-OPENS both; the Admin role is
// immutable (ROLE_IMMUTABLE, no rows, no audit); resolveBulletinViews applies Admin=all + default-both.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  BULLETIN_VIEWS,
  SEEDED_ROLE_IDS,
  permissionAudit,
  roleBulletinViewGrants,
} from '@hnet/db/schema';
import {
  SystemRoleImmutableError,
  bulletinViewsForRole,
  createRole,
  resolveBulletinViews,
  setRoleBulletinViews,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('setRoleBulletinViews / bulletinViewsForRole (ADR-049 C-02)', () => {
  let t: TestDb;
  let roleId: string;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'view-actor@example.com' })).id;
    ({ roleId } = await createRole({ db: t.db, name: 'Viewers', appIds: [], actorId }));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const grantRows = () =>
    t.db.select().from(roleBulletinViewGrants).where(eq(roleBulletinViewGrants.roleId, roleId));
  const auditRows = () =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_bulletin_views'));

  it('no rows ⇒ resolves to BOTH views (the "Bulletin is for everyone" default)', async () => {
    expect(await grantRows()).toHaveLength(0);
    expect(await bulletinViewsForRole({ db: t.db, roleId })).toEqual([...BULLETIN_VIEWS]);
  });

  it('narrows to messages-only in place + writes a same-tx audit row (before/after)', async () => {
    const res = await setRoleBulletinViews({ db: t.db, roleId, views: ['messages'], actorId });
    expect(res.after).toEqual(['messages']);
    expect(res.changed).toBe(true);
    // A stored row now exists ⇒ the resolver returns EXACTLY the allowlist (feed FORBIDDEN elsewhere).
    expect(await bulletinViewsForRole({ db: t.db, roleId })).toEqual(['messages']);

    const grants = await grantRows();
    expect(grants.map((g) => g.view)).toEqual(['messages']);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ before: [], after: ['messages'] });
  });

  it('re-setting both restores the canonical order', async () => {
    const res = await setRoleBulletinViews({
      db: t.db,
      roleId,
      views: ['messages', 'feed'],
      actorId,
    });
    expect(res.before).toEqual(['messages']);
    expect(res.after).toEqual([...BULLETIN_VIEWS]);
    expect(await bulletinViewsForRole({ db: t.db, roleId })).toEqual([...BULLETIN_VIEWS]);
  });

  it('clearing the set RE-OPENS both views (empty ⇒ the default, NOT deny)', async () => {
    await setRoleBulletinViews({ db: t.db, roleId, views: [], actorId });
    expect(await grantRows()).toHaveLength(0);
    // No rows again ⇒ the both-views default (this is the key divergence from message-actions).
    expect(await bulletinViewsForRole({ db: t.db, roleId })).toEqual([...BULLETIN_VIEWS]);
  });

  it('rejects editing the Admin role (immutable — implies both, no rows, no audit)', async () => {
    const auditBefore = (await auditRows()).length;
    await expect(
      setRoleBulletinViews({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, views: ['feed'], actorId }),
    ).rejects.toBeInstanceOf(SystemRoleImmutableError);
    expect((await auditRows()).length).toBe(auditBefore);
    // Admin resolves to BOTH via the short-circuit (no rows queried).
    expect(await bulletinViewsForRole({ roleId: SEEDED_ROLE_IDS.admin, isAdmin: true })).toEqual([
      ...BULLETIN_VIEWS,
    ]);
  });

  it('the seeded Default role is narrowed to messages-only by migration 0039', async () => {
    // The migration seeds the Default role's messages-only row (the owner's intent), so the resolver
    // returns exactly ['messages'] — the Feed is FORBIDDEN for the Default role out of the box.
    expect(await bulletinViewsForRole({ db: t.db, roleId: SEEDED_ROLE_IDS.default })).toEqual([
      'messages',
    ]);
  });

  it('resolveBulletinViews applies the Admin=all + no-row=both + allowlist rules', () => {
    expect(resolveBulletinViews(true, [])).toEqual([...BULLETIN_VIEWS]); // admin ⇒ both
    expect(resolveBulletinViews(false, [])).toEqual([...BULLETIN_VIEWS]); // no rows ⇒ both
    expect(resolveBulletinViews(false, ['messages'])).toEqual(['messages']); // rows ⇒ allowlist
    expect(resolveBulletinViews(false, ['messages', 'feed'])).toEqual([...BULLETIN_VIEWS]); // canonical order
  });
});
