// ADR-027 / DESIGN-004 D-15 (PLAN-010) — MOTD tRPC surface. Proves: getActive is an authed read
// EVERY user gets (active MOTD or null, honoring the enabled + time-window predicate); set/get/clear
// are adminProcedure (a member → FORBIDDEN before any logic); and MotdInput rejects an over-long
// message + an inverted window (startsAt > endsAt) at the zod edge (BAD_REQUEST).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, type users } from '@hnet/db';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let testDb: TestDb;
let admin: typeof users.$inferSelect;
let member: typeof users.$inferSelect;
let adminCaller: Caller;
let memberCaller: Caller;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { displayName: 'Member Mia' }); // Default role
  adminCaller = caller(makeCtx(testDb.db, sessionUser(admin)));
  memberCaller = caller(makeCtx(testDb.db, sessionUser(member)));
});

afterAll(async () => {
  await testDb.stop();
});

describe('motd.getActive — the authed dashboard read (every user)', () => {
  it('returns null when nothing is set', async () => {
    expect(await memberCaller.motd.getActive()).toBeNull();
  });

  it('an admin-set enabled MOTD is visible to a member, with a version', async () => {
    await adminCaller.motd.set({
      message: 'Welcome to the new dashboard!',
      severity: 'info',
      enabled: true,
    });
    const active = await memberCaller.motd.getActive();
    expect(active).toMatchObject({ message: 'Welcome to the new dashboard!', severity: 'info' });
    expect(typeof active!.version).toBe('string');

    // The write was audited via the shared app_settings action (no bespoke motd action).
    const audits = await testDb.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.at(-1)!.actorId).toBe(admin.id);
  });

  it('disabling it hides it for the member', async () => {
    await adminCaller.motd.clear();
    expect(await memberCaller.motd.getActive()).toBeNull();
  });

  it('an out-of-window MOTD (endsAt in the past) is null even when enabled', async () => {
    await adminCaller.motd.set({
      message: 'Old news',
      severity: 'warning',
      enabled: true,
      endsAt: '2000-01-01T00:00:00.000Z',
    });
    expect(await memberCaller.motd.getActive()).toBeNull();
  });
});

describe('motd admin gate — set/get/clear require admin', () => {
  it('a member calling set/get/clear is FORBIDDEN', async () => {
    await expect(
      memberCaller.motd.set({ message: 'nope', severity: 'info', enabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.motd.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCaller.motd.clear()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin can read the raw record via get (compose-form prefill)', async () => {
    const rec = await adminCaller.motd.get();
    expect(rec).toHaveProperty('message');
    expect(rec).toHaveProperty('enabled');
  });
});

describe('MotdInput validation (zod edge → BAD_REQUEST)', () => {
  it('rejects a message longer than 500 chars (the D-17 markdown budget)', async () => {
    await expect(
      adminCaller.motd.set({ message: 'x'.repeat(501), severity: 'info', enabled: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a blank message', async () => {
    await expect(
      adminCaller.motd.set({ message: '   ', severity: 'info', enabled: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an inverted window (startsAt after endsAt)', async () => {
    await expect(
      adminCaller.motd.set({
        message: 'Bad window',
        severity: 'info',
        enabled: true,
        startsAt: '2026-07-08T00:00:00.000Z',
        endsAt: '2026-07-07T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown severity', async () => {
    await expect(
      // @ts-expect-error — deliberately invalid severity to prove the enum rejects it
      adminCaller.motd.set({ message: 'ok', severity: 'critical', enabled: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
