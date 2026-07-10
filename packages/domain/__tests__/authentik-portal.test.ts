import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  authentikGroupAudit,
  pendingRoleAssignments,
  permissionAudit,
  roles,
  userRoleTransitions,
  users,
} from '@hnet/db';
import type { AuthentikUser } from '@hnet/authentik';
import {
  AuthentikGroupNotOwnedError,
  SyncedTierInvalidError,
  assertGroupOwned,
  assignRolePortal,
  consumePendingRoleForUser,
  createRole,
  getAuthentikOwnedGroups,
  provisionSyncedTier,
  type AuthentikPortalBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik role-portal orchestrators. THE GUARDRAIL (a membership
// write is only ever attempted for a group in the owned-groups allowlist), the synced-tier provision
// (auto-create the Authentik + OWUI group + append the allowlist), and the assign flow (exclusive owned-
// group membership for an app user vs a parked pending intent for an Authentik-only identity).

// ---- a fake AuthentikPortalBundle: records write calls, serves configurable reads (the plex-shares
// makeFakeBundle pattern, mirrored for the Authentik + OWUI client pair). ----

interface FakeAuthentikBundle {
  bundle: AuthentikPortalBundle;
  /** name -> group pk (string), shared by both the read + write fakes. */
  groups: Map<string, string>;
  owuiGroups: Map<string, { id: string; name: string; description: string }>;
  usersByPk: Map<number, AuthentikUser>;
  calls: {
    createGroup: string[];
    addMember: Array<{ groupPk: string; userPk: number }>;
    removeMember: Array<{ groupPk: string; userPk: number }>;
    owuiCreate: Array<{ name: string; description: string }>;
  };
  ensureGroup: (name: string) => string;
  addUser: (input: {
    pk: number;
    username: string;
    email: string | null;
    name?: string;
    isActive?: boolean;
    type?: string;
    uid?: string | null;
    attributes?: Record<string, unknown> | null;
    groups?: string[];
  }) => AuthentikUser;
}

function makeFakeAuthentikBundle(opts?: {
  groups?: string[];
  owuiGroups?: string[];
}): FakeAuthentikBundle {
  let groupSeq = 0;
  const groups = new Map<string, string>();
  const owuiGroups = new Map<string, { id: string; name: string; description: string }>();
  const usersByPk = new Map<number, AuthentikUser>();
  const calls: FakeAuthentikBundle['calls'] = {
    createGroup: [],
    addMember: [],
    removeMember: [],
    owuiCreate: [],
  };

  function ensureGroup(name: string): string {
    let pk = groups.get(name);
    if (!pk) {
      pk = `akg-${++groupSeq}`;
      groups.set(name, pk);
    }
    return pk;
  }
  function nameForPk(groupPk: string): string | undefined {
    for (const [name, pk] of groups) if (pk === groupPk) return name;
    return undefined;
  }

  for (const g of opts?.groups ?? []) ensureGroup(g);
  for (const g of opts?.owuiGroups ?? []) owuiGroups.set(g, { id: `owg-${g}`, name: g, description: '' });

  function addUser(input: Parameters<FakeAuthentikBundle['addUser']>[0]): AuthentikUser {
    const groups_obj = (input.groups ?? []).map((name) => ({ pk: ensureGroup(name), name }));
    const u: AuthentikUser = {
      pk: input.pk,
      username: input.username,
      name: input.name ?? input.username,
      email: input.email,
      is_active: input.isActive ?? true,
      type: input.type ?? 'external',
      uid: input.uid ?? null,
      attributes: input.attributes ?? null,
      groups_obj,
    };
    usersByPk.set(u.pk, u);
    return u;
  }

  const bundle = {
    authentik: {
      read: {
        async getUser(pk: number) {
          const u = usersByPk.get(pk);
          if (!u) throw new Error(`fake authentik: no user pk ${pk}`);
          // Return a clone so a caller mutation can't retroactively rewrite our recorded state.
          return { ...u, groups_obj: [...u.groups_obj] };
        },
        async listUsers() {
          return [...usersByPk.values()].map((u) => ({ ...u, groups_obj: [...u.groups_obj] }));
        },
        async listGroups() {
          return [...groups.entries()].map(([name, pk]) => ({ pk, name }));
        },
      },
      write: {
        async createGroup(name: string) {
          const pk = ensureGroup(name);
          calls.createGroup.push(name);
          return { pk, name };
        },
        async addUserToGroup(groupPk: string, userPk: number) {
          calls.addMember.push({ groupPk, userPk });
          const u = usersByPk.get(userPk);
          const name = nameForPk(groupPk);
          if (u && name && !u.groups_obj.some((g) => g.name === name)) {
            u.groups_obj = [...u.groups_obj, { pk: groupPk, name }];
          }
        },
        async removeUserFromGroup(groupPk: string, userPk: number) {
          calls.removeMember.push({ groupPk, userPk });
          const u = usersByPk.get(userPk);
          if (u) u.groups_obj = u.groups_obj.filter((g) => g.pk !== groupPk);
        },
      },
    },
    owui: {
      read: {
        async listGroups() {
          return [...owuiGroups.values()];
        },
      },
      write: {
        async createGroup(name: string, description: string) {
          const g = { id: `owg-${name}`, name, description };
          owuiGroups.set(name, g);
          calls.owuiCreate.push({ name, description });
          return g;
        },
      },
    },
  } as unknown as AuthentikPortalBundle;

  return { bundle, groups, owuiGroups, usersByPk, calls, ensureGroup, addUser };
}

let t: TestDb;
let familyRoleId: string;

async function familyId(): Promise<string> {
  const [row] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Family'));
  if (!row) throw new Error('Family role not seeded');
  return row.id;
}

beforeAll(async () => {
  t = await bootMigratedDb();
  familyRoleId = await familyId();
});

afterAll(async () => {
  await t?.stop();
});

describe('assertGroupOwned — THE GUARDRAIL (ADR-045 C-02)', () => {
  it('accepts an owned group (case-insensitive)', () => {
    expect(() => assertGroupOwned('family', ['family', 'friends'])).not.toThrow();
    expect(() => assertGroupOwned('FAMILY', ['family', 'friends'])).not.toThrow();
  });

  it('throws AuthentikGroupNotOwnedError for a non-owned group', () => {
    expect(() => assertGroupOwned('mfa-exempt', ['family', 'friends'])).toThrow(
      AuthentikGroupNotOwnedError,
    );
  });
});

describe('provisionSyncedTier (ADR-045 — pre-create the Authentik + OWUI group, own the allowlist)', () => {
  it('creates both groups, appends the allowlist, and audits create_group + ensure_owui_group', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Streamers', syncedTier: true, actorId: null });
    const fake = makeFakeAuthentikBundle(); // no pre-existing groups → both must be created

    const res = await provisionSyncedTier({ db: t.db, bundle: fake.bundle, roleId, actorId: null });
    expect(res).toMatchObject({ groupName: 'streamers', authentikCreated: true, owuiCreated: true });

    // The fake recorded BOTH external creates.
    expect(fake.calls.createGroup).toContain('streamers');
    expect(fake.calls.owuiCreate.map((c) => c.name)).toContain('streamers');

    // The owned-groups allowlist now includes the new group name.
    expect(await getAuthentikOwnedGroups(t.db)).toContain('streamers');

    // The append-only external-write ledger holds one create_group + one ensure_owui_group.
    const audit = await t.db
      .select()
      .from(authentikGroupAudit)
      .where(eq(authentikGroupAudit.groupName, 'streamers'));
    expect(audit.filter((a) => a.action === 'create_group')).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'ensure_owui_group')).toHaveLength(1);
  });

  it('is idempotent — a second provision with the groups already present creates nothing', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Cinephiles', syncedTier: true, actorId: null });
    // Both groups already exist upstream (Authentik + OWUI) — ensure-exists must no-op.
    const fake = makeFakeAuthentikBundle({ groups: ['cinephiles'], owuiGroups: ['cinephiles'] });

    const res = await provisionSyncedTier({ db: t.db, bundle: fake.bundle, roleId, actorId: null });
    expect(res).toMatchObject({ groupName: 'cinephiles', authentikCreated: false, owuiCreated: false });
    expect(fake.calls.createGroup).toHaveLength(0);
    expect(fake.calls.owuiCreate).toHaveLength(0);
    const audit = await t.db
      .select()
      .from(authentikGroupAudit)
      .where(eq(authentikGroupAudit.groupName, 'cinephiles'));
    expect(audit).toHaveLength(0);
  });
});

describe('assignRolePortal — APP USER path (exclusive owned-group membership)', () => {
  it('assigns the seeded Family tier to an app user already in the family group (no membership churn)', async () => {
    const user = await createUser(t.db, { email: 'fam-user@example.com' });
    const fake = makeFakeAuthentikBundle({ groups: ['family'] });
    fake.addUser({ pk: 500, username: 'fam', email: 'fam-user@example.com', groups: ['family'] });

    const res = await assignRolePortal({
      db: t.db,
      bundle: fake.bundle,
      authentikUserPk: 500,
      username: 'fam',
      email: 'fam-user@example.com',
      roleId: familyRoleId,
      appUserId: user.id,
      actor: { id: null, kind: 'system' },
    });

    expect(res.pending).toBe(false);
    expect(res.groupName).toBe('family');
    // Already in the desired (and only owned) group → nothing to add or remove.
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);

    const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.roleId).toBe(familyRoleId);
    const transitions = await t.db
      .select()
      .from(userRoleTransitions)
      .where(eq(userRoleTransitions.userId, user.id));
    expect(transitions.some((tr) => tr.toRoleId === familyRoleId)).toBe(true);
  });

  it('EXCLUSIVE: moving from Family to Friends joins friends + leaves family (both audited + written)', async () => {
    // Provision a second owned tier, 'friends'.
    const { roleId: friendsRoleId } = await createRole({
      db: t.db,
      name: 'Friends',
      syncedTier: true,
      actorId: null,
    });
    const fake = makeFakeAuthentikBundle({ groups: ['family'] });
    await provisionSyncedTier({ db: t.db, bundle: fake.bundle, roleId: friendsRoleId, actorId: null });

    const owned = await getAuthentikOwnedGroups(t.db);
    expect(owned).toEqual(expect.arrayContaining(['family', 'friends']));

    const user = await createUser(t.db, { email: 'exclusive@example.com' });
    fake.addUser({ pk: 600, username: 'excl', email: 'exclusive@example.com', groups: ['family'] });

    const res = await assignRolePortal({
      db: t.db,
      bundle: fake.bundle,
      authentikUserPk: 600,
      username: 'excl',
      email: 'exclusive@example.com',
      roleId: friendsRoleId,
      appUserId: user.id,
      actor: { id: null, kind: 'system' },
    });

    expect(res.pending).toBe(false);
    expect(res.groupName).toBe('friends');
    expect(res.added).toContain('friends');
    expect(res.removed).toContain('family');

    // The external ledger: an add_member(friends) + a remove_member(family) for this subject.
    const audit = await t.db
      .select()
      .from(authentikGroupAudit)
      .where(eq(authentikGroupAudit.authentikUserPk, 600));
    expect(
      audit.some((a) => a.action === 'add_member' && a.groupName === 'friends'),
    ).toBe(true);
    expect(
      audit.some((a) => a.action === 'remove_member' && a.groupName === 'family'),
    ).toBe(true);

    // The fake write client actually flipped the memberships (friends pk added, family pk removed).
    const friendsPk = fake.groups.get('friends');
    const familyPk = fake.groups.get('family');
    expect(fake.calls.addMember).toContainEqual({ groupPk: friendsPk, userPk: 600 });
    expect(fake.calls.removeMember).toContainEqual({ groupPk: familyPk, userPk: 600 });

    const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.roleId).toBe(friendsRoleId);
  });
});

describe('assignRolePortal — AUTHENTIK-ONLY path (park a pending intent)', () => {
  it('parks a pending_role_assignments row + assign_pending_role audit; a re-assign supersedes it', async () => {
    const { roleId: parkedRoleId } = await createRole({ db: t.db, name: 'Parked', actorId: null });
    const fake = makeFakeAuthentikBundle();
    fake.addUser({ pk: 700, username: 'parked', email: 'Parked.User@Example.com', groups: [] });

    const res = await assignRolePortal({
      db: t.db,
      bundle: fake.bundle,
      authentikUserPk: 700,
      username: 'parked',
      email: 'Parked.User@Example.com',
      uid: 'uid-700',
      roleId: parkedRoleId,
      appUserId: null, // no app row yet ⇒ pending
      actor: { id: null, kind: 'system' },
    });

    expect(res.pending).toBe(true);
    // Non-synced role ⇒ no group membership write at all.
    expect(res.groupName).toBeNull();
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);

    const live = await t.db
      .select()
      .from(pendingRoleAssignments)
      .where(
        and(eq(pendingRoleAssignments.authentikUserPk, 700), isNull(pendingRoleAssignments.consumedAt)),
      );
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      email: 'parked.user@example.com', // lowercased
      roleId: parkedRoleId,
      consumedAt: null,
    });

    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'assign_pending_role'));
    expect(audit.some((a) => a.roleId === parkedRoleId)).toBe(true);

    // Re-assign the SAME identity to a different role — the prior live intent is superseded (one live row).
    const { roleId: parked2 } = await createRole({ db: t.db, name: 'Parked2', actorId: null });
    await assignRolePortal({
      db: t.db,
      bundle: fake.bundle,
      authentikUserPk: 700,
      username: 'parked',
      email: 'Parked.User@Example.com',
      roleId: parked2,
      appUserId: null,
      actor: { id: null, kind: 'system' },
    });
    const liveAfter = await t.db
      .select()
      .from(pendingRoleAssignments)
      .where(
        and(eq(pendingRoleAssignments.authentikUserPk, 700), isNull(pendingRoleAssignments.consumedAt)),
      );
    expect(liveAfter).toHaveLength(1);
    expect(liveAfter[0]?.roleId).toBe(parked2);
  });
});

describe('consumePendingRoleForUser (ADR-045 C-05 — apply the parked intent on first login)', () => {
  it('applies the role, stamps consumed_at + consumedUserId, and a second call is a no-op', async () => {
    const { roleId: consumeRoleId } = await createRole({ db: t.db, name: 'ConsumeRole', actorId: null });
    const fake = makeFakeAuthentikBundle();
    fake.addUser({ pk: 800, username: 'consume', email: 'consume@example.com', groups: [] });
    await assignRolePortal({
      db: t.db,
      bundle: fake.bundle,
      authentikUserPk: 800,
      username: 'consume',
      email: 'consume@example.com',
      roleId: consumeRoleId,
      appUserId: null,
      actor: { id: null, kind: 'system' },
    });

    // The identity logs into haynesnetwork for the first time — the app user row now exists.
    const user = await createUser(t.db, { email: 'consume@example.com' });
    const applied = await consumePendingRoleForUser({
      db: t.db,
      userId: user.id,
      email: 'consume@example.com',
    });
    expect(applied.appliedRoleId).toBe(consumeRoleId);

    const [after] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.roleId).toBe(consumeRoleId);

    const [pendingRow] = await t.db
      .select()
      .from(pendingRoleAssignments)
      .where(eq(pendingRoleAssignments.authentikUserPk, 800));
    expect(pendingRow?.consumedAt).not.toBeNull();
    expect(pendingRow?.consumedUserId).toBe(user.id);

    // Nothing left to consume the second time.
    const again = await consumePendingRoleForUser({
      db: t.db,
      userId: user.id,
      email: 'consume@example.com',
    });
    expect(again.appliedRoleId).toBeNull();
  });
});

describe('assignRolePortal — synced-tier guard (SyncedTierInvalidError)', () => {
  it('refuses to assign a synced-tier role whose group is not in the owned allowlist', async () => {
    // Flagged as a synced tier but NEVER provisioned into the allowlist (its group is unknown).
    const { roleId: phantomRoleId } = await createRole({
      db: t.db,
      name: 'Phantom',
      syncedTier: true,
      actorId: null,
    });
    const fake = makeFakeAuthentikBundle();
    fake.addUser({ pk: 900, username: 'phantom', email: 'phantom@example.com', groups: [] });

    await expect(
      assignRolePortal({
        db: t.db,
        bundle: fake.bundle,
        authentikUserPk: 900,
        username: 'phantom',
        email: 'phantom@example.com',
        roleId: phantomRoleId,
        appUserId: null,
        actor: { id: null, kind: 'system' },
      }),
    ).rejects.toBeInstanceOf(SyncedTierInvalidError);

    // Nothing was written — the guard fires before any external call or local pending write.
    expect(fake.calls.addMember).toHaveLength(0);
    const pending = await t.db
      .select()
      .from(pendingRoleAssignments)
      .where(eq(pendingRoleAssignments.authentikUserPk, 900));
    expect(pending).toHaveLength(0);
  });
});
