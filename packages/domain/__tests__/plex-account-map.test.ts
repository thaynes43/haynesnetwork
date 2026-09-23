// ADR-053 / DESIGN-026 D-07 (PLAN-029 R7) — the Plex Account Map AUTO-FILL wiring (DESIGN-026 D-07
// status note, 2026-09-23). ensurePlexUserIdMapping shipped with no caller, so user_account_map stayed
// empty in production and the harvest attributed nothing. These prove the resolution helper the
// sign-in hook calls (mapPlexUserIdFromStoredIdentity) and the metadata-refresh reconcile
// (reconcilePlexUserIdMappings): claim → map, fill-if-empty, the admin-set value always wins, the
// admin users.plex_* overrides never invent a numeric id, conflicts are left for an admin, idempotent.
// Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, userAccountMap } from '@hnet/db/schema';
import {
  getPlexUserIdToAppUserMap,
  getUserAccountMap,
  mapPlexUserIdFromStoredIdentity,
  reconcilePlexUserIdMappings,
  upsertUserAccountHandles,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

/** A JWT-shaped id_token whose payload carries `claims` (decode-only — the app never re-verifies it). */
function idTokenWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

let accountSeq = 0;

/** Link an Authentik account row carrying `claims` on its id_token (what Better Auth stores at sign-in). */
async function linkAccount(
  t: TestDb,
  userId: string,
  claims: Record<string, unknown>,
  updatedAt?: Date,
): Promise<void> {
  const sub = `sub-${++accountSeq}`;
  await t.db.insert(account).values({
    userId,
    providerId: 'authentik',
    accountId: sub,
    idToken: idTokenWith({ sub, ...claims }),
    ...(updatedAt ? { updatedAt } : {}),
  });
}

describe('mapPlexUserIdFromStoredIdentity (the sign-in hook resolution) — embedded PG16', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('maps the plex_user_id claim, then is an idempotent no-op', async () => {
    const u = await createUser(t.db);
    await linkAccount(t, u.id, { email: 'owner@haynesnetwork.com', plex_user_id: '12874060' });

    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
      outcome: 'mapped',
      plexUserId: '12874060',
    });
    expect((await getUserAccountMap(t.db, u.id))?.plexUserId).toBe('12874060');
    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
      outcome: 'already_mapped',
      plexUserId: '12874060',
    });
  });

  it('normalizes a numeric claim to the string form Tautulli history is joined on', async () => {
    const u = await createUser(t.db);
    await linkAccount(t, u.id, { plex_user_id: 4242 });
    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
      outcome: 'mapped',
      plexUserId: '4242',
    });
    expect((await getPlexUserIdToAppUserMap(t.db)).get('4242')).toBe(u.id);
  });

  it('no claim / no linked account ⇒ no_claim and no row written', async () => {
    const claimless = await createUser(t.db);
    await linkAccount(t, claimless.id, { email: 'plain@example.com' });
    const unlinked = await createUser(t.db);

    for (const u of [claimless, unlinked]) {
      expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
        outcome: 'no_claim',
        plexUserId: null,
      });
      expect(await getUserAccountMap(t.db, u.id)).toBeNull();
    }
  });

  it('the admin users.plex_email/plex_username override never invents a numeric id (claim-only)', async () => {
    const u = await createUser(t.db, { plexEmail: 'friend@plex.tv', plexUsername: 'friend' });
    await linkAccount(t, u.id, { email: 'friend@haynesnetwork.com' });
    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
      outcome: 'no_claim',
      plexUserId: null,
    });
    expect(await getUserAccountMap(t.db, u.id)).toBeNull();
  });

  it('an admin-set plex id WINS — the auto-fill never overwrites it (other handles untouched)', async () => {
    const u = await createUser(t.db);
    await upsertUserAccountHandles({
      db: t.db,
      userId: u.id,
      plexUserId: '777',
      absUserId: 'abs-7',
    });
    await linkAccount(t, u.id, { plex_user_id: '888' });

    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).toEqual({
      outcome: 'already_mapped',
      plexUserId: '777',
    });
    expect(await getUserAccountMap(t.db, u.id)).toMatchObject({
      plexUserId: '777',
      absUserId: 'abs-7',
    });
  });

  it('fills the plex id on an existing row that carries only book handles', async () => {
    const u = await createUser(t.db);
    await upsertUserAccountHandles({ db: t.db, userId: u.id, absUserId: 'abs-9' });
    await linkAccount(t, u.id, { plex_user_id: '9009' });

    expect((await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).outcome).toBe(
      'mapped',
    );
    expect(await getUserAccountMap(t.db, u.id)).toMatchObject({
      plexUserId: '9009',
      absUserId: 'abs-9',
    });
  });

  it('an id another app user already holds is a CONFLICT — nothing moves, nothing throws', async () => {
    const holder = await createUser(t.db);
    await linkAccount(t, holder.id, { plex_user_id: '555' });
    await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: holder.id });

    const dupe = await createUser(t.db);
    await linkAccount(t, dupe.id, { plex_user_id: '555' });
    expect(await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: dupe.id })).toEqual({
      outcome: 'conflict',
      plexUserId: '555',
    });
    expect(await getUserAccountMap(t.db, dupe.id)).toBeNull();
    expect((await getPlexUserIdToAppUserMap(t.db)).get('555')).toBe(holder.id);
  });

  it("reads the user's FRESHEST token when more than one account row exists", async () => {
    const u = await createUser(t.db);
    await linkAccount(t, u.id, { plex_user_id: '1111' }, new Date('2026-07-01T00:00:00Z'));
    await linkAccount(t, u.id, { plex_user_id: '2222' }, new Date('2026-09-01T00:00:00Z'));
    expect((await mapPlexUserIdFromStoredIdentity({ db: t.db, userId: u.id })).plexUserId).toBe(
      '2222',
    );
  });
});

describe('reconcilePlexUserIdMappings (the metadata-refresh backfill) — embedded PG16', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('maps every claim-carrying unmapped user, skips mapped/admin rows, and is idempotent', async () => {
    const a = await createUser(t.db);
    await linkAccount(t, a.id, { plex_user_id: '100' });
    const b = await createUser(t.db);
    await linkAccount(t, b.id, { plex_user_id: 101 });
    const claimless = await createUser(t.db);
    await linkAccount(t, claimless.id, { email: 'old-token@example.com' });
    await createUser(t.db); // never signed in — no account row, never a candidate
    const admin = await createUser(t.db);
    await upsertUserAccountHandles({ db: t.db, userId: admin.id, plexUserId: '777' });
    await linkAccount(t, admin.id, { plex_user_id: '888' });
    const dupe = await createUser(t.db);
    await linkAccount(t, dupe.id, { plex_user_id: '100' }); // same plex.tv account as `a`

    const first = await reconcilePlexUserIdMappings({ db: t.db });
    expect(first).toMatchObject({ candidates: 4, mapped: 2, noClaim: 1, conflicts: 1, failed: 0 });
    expect(first.issues).toHaveLength(1);
    expect(first.issues[0]!.outcome).toBe('conflict');
    expect([a.id, dupe.id]).toContain(first.issues[0]!.userId);

    const map = await getPlexUserIdToAppUserMap(t.db);
    expect([a.id, dupe.id]).toContain(map.get('100')); // first-come keeps it; the other is flagged
    expect(map.get('101')).toBe(b.id);
    expect(map.get('777')).toBe(admin.id); // the admin-set id is untouched…
    expect(map.has('888')).toBe(false); // …and the claim never replaced it

    // Second run: only the still-unmapped users are walked, and nothing changes.
    const before = await t.db.select().from(userAccountMap);
    const second = await reconcilePlexUserIdMappings({ db: t.db });
    expect(second).toMatchObject({ candidates: 2, mapped: 0, noClaim: 1, conflicts: 1, failed: 0 });
    expect(await t.db.select().from(userAccountMap)).toEqual(before);
  });
});
