// ADR-060 / DESIGN-031 D-06 (PLAN-035) — the profile notification-preference endpoints: the
// caller's OWN opt-in (no section gate), defaults OFF with no row, upsert roundtrip, auth gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

describe('profile.notificationPreference (R-196)', () => {
  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const anon = caller(makeCtx(t.db, null));
    await expect(anon.profile.notificationPreference()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('defaults OFF with no row, upserts on set, and is PER USER', async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    const asA = caller(makeCtx(t.db, sessionUser(a)));
    const asB = caller(makeCtx(t.db, sessionUser(b)));

    expect(await asA.profile.notificationPreference()).toEqual({ emailTicketUpdates: false });

    expect(await asA.profile.setNotificationPreference({ emailTicketUpdates: true })).toEqual({
      emailTicketUpdates: true,
    });
    expect(await asA.profile.notificationPreference()).toEqual({ emailTicketUpdates: true });
    // B is untouched by A's toggle.
    expect(await asB.profile.notificationPreference()).toEqual({ emailTicketUpdates: false });

    // Toggle back off (the upsert path, not a second insert).
    await asA.profile.setNotificationPreference({ emailTicketUpdates: false });
    expect(await asA.profile.notificationPreference()).toEqual({ emailTicketUpdates: false });
  });
});
