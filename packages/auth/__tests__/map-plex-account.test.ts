import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, type Database } from '@hnet/db';
import { getUserAccountMap, upsertUserAccountHandles } from '@hnet/domain';
import { mapPlexAccountOnSignin } from '../src/index';
import { OIDC_PROVIDER_ID } from '../src/env';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ADR-053 / DESIGN-026 D-07 (PLAN-029 R7) — the sign-in hook that records a user's plex.tv numeric id
// in the Plex Account Map. It shipped unwired (ensurePlexUserIdMapping had no caller), so
// user_account_map — and therefore user_media_watch — stayed empty in production (2026-09-23).

/** A JWT-shaped id_token whose payload carries `claims` (decode-only — the app never re-verifies it). */
function idTokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

/** Link the Authentik account row Better Auth writes (with the fresh id_token) before the session. */
async function linkAccount(db: Database, userId: string, claims: Record<string, unknown>) {
  await db.insert(account).values({
    userId,
    providerId: OIDC_PROVIDER_ID,
    accountId: `sub-${userId}`,
    idToken: idTokenWith({ sub: `sub-${userId}`, ...claims }),
  });
}

describe('mapPlexAccountOnSignin (ADR-053 / DESIGN-026 D-07)', () => {
  let t: TestDb;
  let connectionString: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    // helpers.ts builds the pool from the embedded server's connection string — reuse it for config.ts.
    connectionString = (t.pool.options as { connectionString?: string }).connectionString!;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("records the id_token's plex_user_id claim; a repeat sign-in is a no-op", async () => {
    const user = await createUser(t.db);
    await linkAccount(t.db, user.id, {
      email: 'owner@haynesnetwork.com',
      plex_user_id: '12874060',
    });

    await mapPlexAccountOnSignin({ id: user.id }, t.db);
    expect((await getUserAccountMap(t.db, user.id))?.plexUserId).toBe('12874060');

    await mapPlexAccountOnSignin({ id: user.id }, t.db);
    expect((await getUserAccountMap(t.db, user.id))?.plexUserId).toBe('12874060');
  });

  it('never overwrites an admin-set plex id', async () => {
    const user = await createUser(t.db);
    await upsertUserAccountHandles({ db: t.db, userId: user.id, plexUserId: '777' });
    await linkAccount(t.db, user.id, { plex_user_id: '888' });

    await mapPlexAccountOnSignin({ id: user.id }, t.db);
    expect((await getUserAccountMap(t.db, user.id))?.plexUserId).toBe('777');
  });

  it('a token without the claim writes nothing', async () => {
    const user = await createUser(t.db);
    await linkAccount(t.db, user.id, { email: 'plain@example.com' });

    await mapPlexAccountOnSignin({ id: user.id }, t.db);
    expect(await getUserAccountMap(t.db, user.id)).toBeNull();
  });

  it('a conflicting id warns and leaves both users as they were — never throws', async () => {
    const holder = await createUser(t.db);
    await linkAccount(t.db, holder.id, { plex_user_id: '31337' });
    await mapPlexAccountOnSignin({ id: holder.id }, t.db);
    const dupe = await createUser(t.db);
    await linkAccount(t.db, dupe.id, { plex_user_id: '31337' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(mapPlexAccountOnSignin({ id: dupe.id }, t.db)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await getUserAccountMap(t.db, dupe.id)).toBeNull();
    expect((await getUserAccountMap(t.db, holder.id))?.plexUserId).toBe('31337');
  });

  it('swallows + logs a DB failure (the session already exists; the reconcile retries)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = new Proxy({} as Database, {
      get() {
        throw new Error('db unreachable');
      },
    });

    await expect(mapPlexAccountOnSignin({ id: 'u-1' }, broken)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  // The defect was a MISSING CALLER, so prove the wiring itself: Better Auth's session.create.after
  // hook (the one every sign-in fires, after it has stored the fresh id_token on the account row)
  // now maps the user. config.ts is imported fresh against this embedded PG via the lazy @hnet/db client.
  it('is wired into the Better Auth session.create.after hook (every sign-in)', async () => {
    const user = await createUser(t.db);
    await linkAccount(t.db, user.id, { plex_user_id: '24681357' });

    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.resetModules();
    const { auth } = await import('../src/config');
    const { getPool } = await import('@hnet/db');
    try {
      const after = auth.options.databaseHooks?.session?.create?.after;
      expect(typeof after).toBe('function');
      const now = new Date();
      await after!({
        id: 'session-1',
        userId: user.id,
        token: 'token-1',
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      await getPool().end();
    }
    expect((await getUserAccountMap(t.db, user.id))?.plexUserId).toBe('24681357');
  });
});
