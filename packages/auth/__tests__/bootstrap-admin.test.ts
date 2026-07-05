import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { roles, userRoleTransitions, users, SEEDED_ROLE_IDS, type Database } from '@hnet/db';
import { bootstrapAdminOnSignin } from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ENV hygiene: tests own process.env.BOOTSTRAP_ADMIN_EMAILS via vi.stubEnv — nothing
// is read from .env.local (vitest loads no dotenv files).

describe('bootstrapAdminOnSignin (DESIGN-002 D-05, R-02, AC-03)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  beforeEach(() => {
    // Start every test from a clean allowlist regardless of the host environment.
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function auditRowsFor(userId: string) {
    return t.db.select().from(userRoleTransitions).where(eq(userRoleTransitions.userId, userId));
  }

  async function roleOf(userId: string) {
    const [row] = await t.db
      .select({ name: roles.name })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, userId));
    return row?.name;
  }

  it('promotes an allowlisted email to Admin on first sign-in with a system audit row', async () => {
    const user = await createUser(t.db, { email: 'owner@example.com' });
    expect(await roleOf(user.id)).toBe('Default'); // R-03 default
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'owner@example.com');

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);

    expect(await roleOf(user.id)).toBe('Admin');
    const audits = await auditRowsFor(user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      fromRoleId: SEEDED_ROLE_IDS.default,
      toRoleId: SEEDED_ROLE_IDS.admin,
      initiatorId: null,
      initiatorKind: 'system',
      note: 'BOOTSTRAP_ADMIN_EMAILS promotion',
    });
  });

  it('is a no-op on the second sign-in — still exactly one audit row (AC-03)', async () => {
    const user = await createUser(t.db, { email: 'repeat@example.com' });
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'repeat@example.com');

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);
    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);

    expect(await roleOf(user.id)).toBe('Admin');
    expect(await auditRowsFor(user.id)).toHaveLength(1);
  });

  it('leaves non-allowlisted users as Member with no audit row', async () => {
    const user = await createUser(t.db, { email: 'guest@example.com' });
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'owner@example.com,other@example.com');

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);

    expect(await roleOf(user.id)).toBe('Default');
    expect(await auditRowsFor(user.id)).toHaveLength(0);
  });

  it('matches case-insensitively in both directions (R-02)', async () => {
    const user = await createUser(t.db, { email: 'MiXeD.Case@Example.COM' });
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'mixed.case@example.com');

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);
    expect(await roleOf(user.id)).toBe('Admin');

    const other = await createUser(t.db, { email: 'lower@example.com' });
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'LOWER@EXAMPLE.COM');

    await bootstrapAdminOnSignin({ id: other.id, email: other.email }, t.db);
    expect(await roleOf(other.id)).toBe('Admin');
  });

  it('parses a multi-email list with whitespace and empty segments', async () => {
    const user = await createUser(t.db, { email: 't.haynes43@gmail.com' });
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', ' manofoz@gmail.com , t.haynes43@gmail.com ,, ');

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);

    expect(await roleOf(user.id)).toBe('Admin');
    expect(await auditRowsFor(user.id)).toHaveLength(1);
  });

  it('is a no-op when BOOTSTRAP_ADMIN_EMAILS is unset (DESIGN-002 D-08)', async () => {
    const user = await createUser(t.db, { email: 'unset-env@example.com' });
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;

    await bootstrapAdminOnSignin({ id: user.id, email: user.email }, t.db);

    expect(await roleOf(user.id)).toBe('Default');
    expect(await auditRowsFor(user.id)).toHaveLength(0);
  });

  it('is a no-op when the user row is missing (deleted between sign-in and hook)', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'ghost@example.com');

    await expect(
      bootstrapAdminOnSignin(
        { id: '00000000-0000-0000-0000-000000000000', email: 'ghost@example.com' },
        t.db,
      ),
    ).resolves.toBeUndefined();
  });

  it('never throws into the auth flow — DB failures are logged and swallowed', async () => {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAILS', 'owner@example.com');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      select() {
        throw new Error('connection lost');
      },
    } as unknown as Database;

    await expect(
      bootstrapAdminOnSignin({ id: 'irrelevant', email: 'owner@example.com' }, broken),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
