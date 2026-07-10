import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  authentikUsers,
  pendingRoleAssignments,
  type AuthentikUserInsert,
} from '@hnet/db';
import type { AuthentikUser } from '@hnet/authentik';
import {
  createRole,
  listAuthentikDirectory,
  syncAuthentikUsers,
  upsertAuthentikUsers,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik DIRECTORY mirror single-writer + the /admin/users read
// model. upsertAuthentikUsers is the guarded single-writer (INSERT … ON CONFLICT (pk)); syncAuthentikUsers
// reads the live directory and upserts it; listAuthentikDirectory joins the mirror to app users + roles +
// live pending assignments.

/** Build a live Authentik user (the syncAuthentikUsers input shape). */
function mkAkUser(overrides: Partial<AuthentikUser> & { pk: number; username: string }): AuthentikUser {
  return {
    pk: overrides.pk,
    username: overrides.username,
    name: overrides.name ?? overrides.username,
    email: overrides.email ?? null,
    is_active: overrides.is_active ?? true,
    type: overrides.type ?? 'internal',
    uid: overrides.uid ?? null,
    attributes: overrides.attributes ?? null,
    groups_obj: overrides.groups_obj ?? [],
  };
}

/** Build a mirror row (the upsertAuthentikUsers input shape). */
function mirrorRow(overrides: Partial<AuthentikUserInsert> & { pk: number }): AuthentikUserInsert {
  return {
    username: `ak-${overrides.pk}`,
    name: '',
    email: null,
    userType: 'internal',
    sources: [],
    groups: [],
    isActive: true,
    uid: null,
    ...overrides,
  };
}

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(pendingRoleAssignments);
  await t.db.delete(authentikUsers);
});

describe('upsertAuthentikUsers — the guarded mirror single-writer', () => {
  it('inserts rows, then updates in place on a pk conflict (no duplicate rows)', async () => {
    const first = await upsertAuthentikUsers({
      db: t.db,
      users: [
        mirrorRow({ pk: 1, username: 'alice', email: 'alice@example.com', groups: ['family'] }),
        mirrorRow({ pk: 2, username: 'bob', email: 'bob@example.com' }),
      ],
    });
    expect(first.upserted).toBe(2);
    let rows = await t.db.select().from(authentikUsers);
    expect(rows).toHaveLength(2);

    // Re-upsert pk 1 with a changed username + groups — an UPDATE, not a second row.
    const second = await upsertAuthentikUsers({
      db: t.db,
      users: [mirrorRow({ pk: 1, username: 'alice-renamed', email: 'alice@example.com', groups: ['family', 'friends'] })],
    });
    expect(second.upserted).toBe(1);
    rows = await t.db.select().from(authentikUsers);
    expect(rows).toHaveLength(2); // still 2, not 3
    const [alice] = await t.db.select().from(authentikUsers).where(eq(authentikUsers.pk, 1));
    expect(alice?.username).toBe('alice-renamed');
    expect(alice?.groups).toEqual(['family', 'friends']);
  });

  it('no-ops on an empty input', async () => {
    const res = await upsertAuthentikUsers({ db: t.db, users: [] });
    expect(res.upserted).toBe(0);
  });
});

describe('syncAuthentikUsers — reads the live directory and upserts the mirror', () => {
  it('upserts every identity; normalizes type (clamped), sources, and groups', async () => {
    const live: AuthentikUser[] = [
      mkAkUser({
        pk: 10,
        username: 'plexguy',
        email: 'plexguy@example.com',
        type: 'external',
        attributes: { 'goauthentik.io/user/sources': ['HaynesTower'] },
        groups_obj: [{ pk: 'g1', name: 'family' }],
      }),
      mkAkUser({
        pk: 11,
        username: 'weird',
        email: null,
        type: 'not-a-real-type', // must clamp to 'internal'
        groups_obj: [],
      }),
    ];
    const report = await syncAuthentikUsers({ db: t.db, authentik: { listUsers: async () => live } });
    expect(report.fetched).toBe(2);
    expect(report.upserted).toBe(2);

    const [plexguy] = await t.db.select().from(authentikUsers).where(eq(authentikUsers.pk, 10));
    expect(plexguy?.userType).toBe('external');
    expect(plexguy?.sources).toEqual(['HaynesTower']); // extracted from attributes
    expect(plexguy?.groups).toEqual(['family']); // from groups_obj names

    const [weird] = await t.db.select().from(authentikUsers).where(eq(authentikUsers.pk, 11));
    expect(weird?.userType).toBe('internal'); // clamped from an unknown type
    expect(weird?.sources).toEqual([]);
    expect(weird?.email).toBeNull();
  });
});

describe('listAuthentikDirectory — the /admin/users read model', () => {
  it('links the mirror to app users (by email), roles, and live pending assignments', async () => {
    // (1) A mirror row whose email matches an app user (case-insensitive) — appUser + role resolve.
    const appUser = await createUser(t.db, { email: 'linked@example.com' });
    await upsertAuthentikUsers({
      db: t.db,
      users: [mirrorRow({ pk: 20, username: 'linked', email: 'LINKED@example.com' })],
    });

    // (2) A mirror row with a live pending assignment but NO app user — pendingRoleName resolves.
    const { roleId: pendingRoleId } = await createRole({ db: t.db, name: 'PendingRole', actorId: null });
    await upsertAuthentikUsers({
      db: t.db,
      users: [mirrorRow({ pk: 21, username: 'awaiting', email: 'awaiting@example.com' })],
    });
    await t.db.insert(pendingRoleAssignments).values({
      authentikUserPk: 21,
      authentikUsername: 'awaiting',
      email: 'awaiting@example.com',
      roleId: pendingRoleId,
      assignedBy: null,
    });

    // (3) A mirror-only row (never logged in, no pending) — appUserId null.
    await upsertAuthentikUsers({
      db: t.db,
      users: [mirrorRow({ pk: 22, username: 'stranger', email: 'stranger@example.com' })],
    });

    const dir = await listAuthentikDirectory(t.db);
    const byPk = new Map(dir.map((r) => [r.pk, r]));

    const linked = byPk.get(20)!;
    expect(linked.appUserId).toBe(appUser.id);
    expect(linked.appRoleName).toBe('Default'); // a fresh user lands in the Default role
    expect(linked.pendingRoleId).toBeNull();

    const awaiting = byPk.get(21)!;
    expect(awaiting.appUserId).toBeNull(); // no app user with this email
    expect(awaiting.pendingRoleId).toBe(pendingRoleId);
    expect(awaiting.pendingRoleName).toBe('PendingRole');

    const stranger = byPk.get(22)!;
    expect(stranger.appUserId).toBeNull();
    expect(stranger.appRoleName).toBeNull();
    expect(stranger.pendingRoleName).toBeNull();
  });
});
