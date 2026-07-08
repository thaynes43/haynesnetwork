// ADR-017 / DESIGN-007 D-05 — plex router tests: admin refresh populates the registry, the
// grant matrix + setRoleLibraryGrants drive role_library_grants, self-service add/remove
// records the sharing writes on the injected stub bundle, myLibraries reflects live share
// state, and the D-13 error taxonomy (LIBRARY_NOT_ALLOWED, PLEX_ACCOUNT_UNMATCHED) flows
// through the real errorFormatter. The procedure ladder (authed / admin) is exercised too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plexLibraries, plexServers, SEEDED_PLEX_SERVER_IDS, SEEDED_ROLE_IDS } from '@hnet/db';
import { assignRole, createRole } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  forbidDbAccess,
  makeCtx,
  sessionUser,
  wireShape,
  type Caller,
  type TestDb,
} from './helpers';
import { makeApiPlexStub, type ApiPlexStub } from './plex-stubs';

let t: TestDb;
let stub: ApiPlexStub;
let adminCaller: Caller;
let memberCaller: Caller;
let moviesId: string;
let photosId: string;

const MEMBER_EMAIL = 'member-plex@example.com';

function towerConfig() {
  return {
    haynestower: {
      machineIdentifier: 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3',
      friends: [{ id: '42', email: MEMBER_EMAIL }],
      serverSections: [
        { id: '118181361', key: '1' },
        { id: '118278404', key: '4' },
      ],
      librarySections: [
        { key: '1', title: 'HNet Movies', type: 'movie' },
        { key: '4', title: 'HNet Photos', type: 'photo' },
      ],
    },
  };
}

beforeAll(async () => {
  t = await bootMigratedDb();
  stub = makeApiPlexStub(towerConfig());

  const admin = await createUser(t.db, { admin: true });
  const member = await createUser(t.db, { email: MEMBER_EMAIL });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin), undefined, stub.bundle));
  memberCaller = caller(makeCtx(t.db, sessionUser(member), undefined, stub.bundle));

  // Admin refresh populates plex_libraries for haynestower.
  await adminCaller.plex.refreshRegistry({ slugs: ['haynestower'] });
  const libs = await t.db
    .select({ id: plexLibraries.id, key: plexLibraries.sectionKey })
    .from(plexLibraries)
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(eq(plexServers.slug, 'haynestower'));
  moviesId = libs.find((l) => l.key === '1')!.id;
  photosId = libs.find((l) => l.key === '4')!.id;

  // Default role grants only Movies (not the family Photos library).
  await adminCaller.plex.setRoleLibraryGrants({
    roleId: SEEDED_ROLE_IDS.default,
    libraryIds: [moviesId],
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('plex.refreshRegistry (admin)', () => {
  it('populated two haynestower libraries', () => {
    expect(moviesId).toBeTruthy();
    expect(photosId).toBeTruthy();
  });

  it('returns the D-11 per-server summary { ok, servers: [{ slug, name, ok, libraryCount }] }', async () => {
    const summary = await adminCaller.plex.refreshRegistry({ slugs: ['haynestower'] });
    expect(summary.ok).toBe(true);
    const tower = summary.servers.find((s) => s.slug === 'haynestower')!;
    expect(tower).toMatchObject({ slug: 'haynestower', name: 'HaynesTower', ok: true, libraryCount: 2 });
    expect(tower.error).toBeUndefined();
  });
});

describe('plex.roleLibraryGrants (admin matrix)', () => {
  it('returns libraries grouped by server + grants per role', async () => {
    const matrix = await adminCaller.plex.roleLibraryGrants();
    const tower = matrix.servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.libraries.map((l) => l.name).sort()).toEqual(['HNet Movies', 'HNet Photos']);
    expect(matrix.grantsByRole[SEEDED_ROLE_IDS.default]).toEqual([moviesId]);
  });
});

describe('plex.myLibraries (self-service)', () => {
  it('shows only the role-allowed libraries, annotated with share state', async () => {
    const { servers } = await memberCaller.plex.myLibraries();
    const tower = servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.friendMatched).toBe(true);
    expect(tower.libraries.map((l) => l.name)).toEqual(['HNet Movies']); // Photos withheld (not granted)
    expect(tower.libraries[0]!.shared).toBe(false);
  });

  it('surfaces allGranted + allActive and shares every library when the role all-grants (ADR-024)', async () => {
    // The live case (owner's wife, friend id 19299967) modelled the new way: her role ALL-grants
    // haynestower and her account is in the all-libraries state. myLibraries flags both, offers
    // every available library on the server, and reports them all shared.
    const wife = await createUser(t.db, { email: 'wife-plex@example.com' });
    const { roleId } = await createRole({ db: t.db, name: 'all-tower-role', actorId: null });
    await adminCaller.plex.setRoleLibraryGrants({
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
    });
    await assignRole({ db: t.db, userId: wife.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });

    const allLibsStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        friends: [{ id: '19299967', email: 'wife-plex@example.com' }],
        shared: { '19299967': { id: 'ss-wife', sectionIds: [118181361], allLibraries: true } },
      },
    });
    const wifeCaller = caller(makeCtx(t.db, sessionUser(wife), undefined, allLibsStub.bundle));
    const { servers } = await wifeCaller.plex.myLibraries();
    const tower = servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.id).toBe(SEEDED_PLEX_SERVER_IDS.haynestower);
    expect(tower.allGranted).toBe(true);
    expect(tower.allActive).toBe(true);
    // All available libraries on the all-granted server are offered, and every one is shared.
    expect(tower.libraries.map((l) => l.name).sort()).toEqual(['HNet Movies', 'HNet Photos']);
    expect(tower.libraries.every((l) => l.shared)).toBe(true);
  });
});

describe('plex.myLibraries — server owner + unlinked account (ADR-029)', () => {
  it('flags the server OWNER (never in their own friend list): owner:true, friendMatched stays true, every library shared', async () => {
    const ownerUser = await createUser(t.db, { email: 'owner-plex@example.com' });
    // The stub reports this account as the haynestower OWNER and lists NO friends — exactly the
    // live shape (manofoz@gmail.com owns all three servers, is absent from every friend list).
    const ownerStub = makeApiPlexStub({
      haynestower: { ...towerConfig().haynestower, ownerEmail: 'owner-plex@example.com', friends: [] },
    });
    const ownerCaller = caller(makeCtx(t.db, sessionUser(ownerUser), undefined, ownerStub.bundle));
    const { servers } = await ownerCaller.plex.myLibraries();
    const tower = servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true);
    expect(tower.friendMatched).toBe(true); // owner takes precedence — the friend lookup is skipped
    expect(tower.available).toBe(true);
    expect(tower.libraries.length).toBeGreaterThan(0);
    expect(tower.libraries.every((l) => l.shared)).toBe(true); // all libraries implicitly the owner's
  });

  it('an unlinked account (neither owner nor friend) reports owner:false, friendMatched:false', async () => {
    const localUser = await createUser(t.db, { email: 'local-admin@example.com' });
    const stub2 = makeApiPlexStub({
      haynestower: { ...towerConfig().haynestower, ownerEmail: 'owner-plex@example.com', friends: [] },
    });
    const c = caller(makeCtx(t.db, sessionUser(localUser), undefined, stub2.bundle));
    const { servers } = await c.plex.myLibraries();
    const tower = servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(false);
    expect(tower.friendMatched).toBe(false);
  });

  it('degrades to the friend flow when the owner lookup fails — no crash, server stays available', async () => {
    const friendUser = await createUser(t.db, { email: 'degrade-plex@example.com' });
    const s = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        friends: [{ id: '77', email: 'degrade-plex@example.com' }],
      },
    });
    // The owner lookup throws (plex.tv hiccup) — myLibraries must fall back to friend matching
    // rather than marking the server unavailable.
    s.bundle.read.haynestower.getOwnerAccount = async () => {
      throw new Error('plex.tv 500');
    };
    const c = caller(makeCtx(t.db, sessionUser(friendUser), undefined, s.bundle));
    const { servers } = await c.plex.myLibraries();
    const tower = servers.find((x) => x.slug === 'haynestower')!;
    expect(tower.available).toBe(true);
    expect(tower.owner).toBe(false);
    expect(tower.friendMatched).toBe(true); // matched via the friend list despite the owner-lookup failure
  });
});

describe('plex.myLibraries — real Plex identity (fix/plex-identity-mapping)', () => {
  // Ensure the Default role grants Movies so these callers get a haynestower group.
  beforeAll(async () => {
    await adminCaller.plex.setRoleLibraryGrants({ roleId: SEEDED_ROLE_IDS.default, libraryIds: [moviesId] });
  });

  it('recognizes the OWNER by the resolved Plex email even when the app (OIDC) email differs', async () => {
    // The reported bug: the owner's Authentik email is admin@haynesnetwork.com but their plex.tv
    // owner email is manofoz@gmail.com — email-matching missed them. The id_token claim / admin
    // override surfaces the real identity, so owner detection now fires. Mixed case ⇒ case-insensitive.
    const owner = await createUser(t.db, { email: 'admin@haynesnetwork.com' });
    const ownerStub = makeApiPlexStub({
      haynestower: { ...towerConfig().haynestower, ownerEmail: 'Manofoz@Gmail.COM', friends: [] },
    });
    const identity = { userId: null, email: 'manofoz@gmail.com', username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(owner, undefined, undefined, undefined, identity), undefined, ownerStub.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true);
    expect(tower.friendMatched).toBe(true);
    expect(tower.libraries.every((l) => l.shared)).toBe(true);
  });

  it('recognizes the OWNER by Plex username when both emails differ', async () => {
    const owner = await createUser(t.db, { email: 'admin2@haynesnetwork.com' });
    const ownerStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerEmail: 'someone-else@plex.tv',
        ownerUsername: 'manofoz',
        friends: [],
      },
    });
    const identity = { userId: null, email: null, username: 'manofoz' };
    const c = caller(
      makeCtx(t.db, sessionUser(owner, undefined, undefined, undefined, identity), undefined, ownerStub.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true);
  });

  it('resolves the identity from the admin OVERRIDE column (no explicit claim)', async () => {
    // sessionUser() with no explicit identity resolves from the row's plex_email/plex_username —
    // mirroring prod where getSessionExtension uses the override when the token carries no claim.
    const owner = await createUser(t.db, { email: 'admin3@haynesnetwork.com', plexEmail: 'manofoz@gmail.com' });
    const ownerStub = makeApiPlexStub({
      haynestower: { ...towerConfig().haynestower, ownerEmail: 'manofoz@gmail.com', friends: [] },
    });
    const c = caller(makeCtx(t.db, sessionUser(owner), undefined, ownerStub.bundle));
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true);
  });

  it('matches a FRIEND by their Plex email when it differs from the app email', async () => {
    const user = await createUser(t.db, { email: 'authentik-friend@haynesnetwork.com' });
    const friendStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerEmail: 'owner@plex.tv',
        friends: [{ id: '55', email: 'friend-plex@example.com' }],
      },
    });
    const identity = { userId: null, email: 'friend-plex@example.com', username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(user, undefined, undefined, undefined, identity), undefined, friendStub.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(false);
    expect(tower.friendMatched).toBe(true);
  });

  it('still falls back to the app email when no identity is resolved (unchanged behavior)', async () => {
    const user = await createUser(t.db, { email: 'friend-by-app-email@example.com' });
    const friendStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerEmail: 'owner@plex.tv',
        friends: [{ id: '56', email: 'friend-by-app-email@example.com' }],
      },
    });
    // No plexIdentity, no override column ⇒ empty identity ⇒ match by app email.
    const c = caller(makeCtx(t.db, sessionUser(user), undefined, friendStub.bundle));
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.friendMatched).toBe(true);
  });
});

describe('plex.myLibraries — plex.tv numeric id (fix/plex-numeric-id)', () => {
  beforeAll(async () => {
    await adminCaller.plex.setRoleLibraryGrants({ roleId: SEEDED_ROLE_IDS.default, libraryIds: [moviesId] });
  });

  // The RECOMMENDED automatic path: the owner's id_token carries ONLY plex_user_id (12874060) —
  // no plex_email/username — so owner recognition must fire from the numeric id alone. Neither the
  // app email nor the owner-account email/username agree here; only the id does.
  it('recognizes the OWNER by the plex.tv numeric id alone (no email/username claim)', async () => {
    const owner = await createUser(t.db, { email: 'linked-owner-id@haynesnetwork.com' });
    const ownerStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerId: '12874060',
        ownerEmail: 'someone-else@plex.tv',
        ownerUsername: 'somebodyelse',
        friends: [],
      },
    });
    const identity = { userId: '12874060', email: null, username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(owner, undefined, undefined, undefined, identity), undefined, ownerStub.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true);
    expect(tower.friendMatched).toBe(true);
    expect(tower.libraries.every((l) => l.shared)).toBe(true);
  });

  it('matches a FRIEND by their plex.tv numeric id alone', async () => {
    const user = await createUser(t.db, { email: 'friend-by-id@haynesnetwork.com' });
    const friendStub = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerId: 'owner-xyz',
        ownerEmail: 'owner@plex.tv',
        friends: [{ id: '55', email: 'plex-friend@example.com', username: 'plexfriend' }],
      },
    });
    const identity = { userId: '55', email: null, username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(user, undefined, undefined, undefined, identity), undefined, friendStub.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(false);
    expect(tower.friendMatched).toBe(true);
  });

  // Precedence: the numeric id WINS over a conflicting email. The caller's id identifies the OWNER;
  // their app email happens to match a DIFFERENT friend on the server. Resolving by email would
  // mis-identify them as that friend — the id must take precedence.
  it('numeric id WINS over a conflicting email (id → OWNER, not the email-matched friend)', async () => {
    const user = await createUser(t.db, { email: 'collides@haynesnetwork.com' });
    const stubX = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerId: '12874060',
        ownerEmail: 'owner-real@plex.tv',
        friends: [{ id: '55', email: 'collides@haynesnetwork.com' }], // same as the app email
      },
    });
    const identity = { userId: '12874060', email: null, username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(user, undefined, undefined, undefined, identity), undefined, stubX.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(true); // id → owner, NOT the friend whose email matches the app email
  });

  // Honesty about staleness: a numeric id that matches NOTHING on the server (owner or friend) must
  // NOT lock the caller out — we fall through to the email/username layers (the id may be stale).
  it('a STALE numeric id that matches nothing falls through to the email layer', async () => {
    const user = await createUser(t.db, { email: 'stale-id@haynesnetwork.com' });
    const stubY = makeApiPlexStub({
      haynestower: {
        ...towerConfig().haynestower,
        ownerId: 'owner-xyz',
        ownerEmail: 'owner@plex.tv',
        friends: [{ id: '55', email: 'real-plex@example.com' }],
      },
    });
    // id 424242 matches neither the owner nor any friend; the email DOES match friend 55.
    const identity = { userId: '424242', email: 'real-plex@example.com', username: null };
    const c = caller(
      makeCtx(t.db, sessionUser(user, undefined, undefined, undefined, identity), undefined, stubY.bundle),
    );
    const tower = (await c.plex.myLibraries()).servers.find((s) => s.slug === 'haynestower')!;
    expect(tower.owner).toBe(false);
    expect(tower.friendMatched).toBe(true); // fell through to the email layer despite the present id
  });
});

describe('plex.addLibrary / removeLibrary (self-service)', () => {
  it('add records a sharing write and myLibraries then shows it shared', async () => {
    stub.writes.length = 0;
    const res = await memberCaller.plex.addLibrary({ libraryId: moviesId });
    expect(res).toMatchObject({ changed: true, event: 'share_added' });
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]).toMatchObject({ slug: 'haynestower', librarySectionIds: [118181361] });

    const { servers } = await memberCaller.plex.myLibraries();
    expect(servers.find((s) => s.slug === 'haynestower')!.libraries[0]!.shared).toBe(true);
  });

  it('remove records the un-share', async () => {
    stub.writes.length = 0;
    const res = await memberCaller.plex.removeLibrary({ libraryId: moviesId });
    expect(res).toMatchObject({ changed: true, event: 'share_removed' });
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]!.kind).toBe('delete'); // was the only shared section
  });

  it('rejects a non-permitted library with LIBRARY_NOT_ALLOWED (FORBIDDEN)', async () => {
    stub.writes.length = 0;
    try {
      await memberCaller.plex.addLibrary({ libraryId: photosId });
      throw new Error('expected throw');
    } catch (err) {
      const shape = wireShape(err, 'plex.addLibrary');
      expect(shape.data.code).toBe('FORBIDDEN');
      expect(shape.data.appCode).toBe('LIBRARY_NOT_ALLOWED');
    }
    expect(stub.writes).toHaveLength(0);
  });

  it('surfaces PLEX_ACCOUNT_UNMATCHED when the caller is not a Plex friend', async () => {
    const stranger = await createUser(t.db, { email: 'stranger-plex@example.com' });
    // grant Movies to stranger's role so the gate passes and we reach the friend lookup
    await adminCaller.plex.setRoleLibraryGrants({ roleId: SEEDED_ROLE_IDS.default, libraryIds: [moviesId] });
    const strangerCaller = caller(makeCtx(t.db, sessionUser(stranger), undefined, stub.bundle));
    try {
      await strangerCaller.plex.addLibrary({ libraryId: moviesId });
      throw new Error('expected throw');
    } catch (err) {
      const shape = wireShape(err, 'plex.addLibrary');
      expect(shape.data.appCode).toBe('PLEX_ACCOUNT_UNMATCHED');
    }
  });
});

describe('plex.setServerAll (ADR-024)', () => {
  it('rejects a server the role does not all-grant with LIBRARY_NOT_ALLOWED (FORBIDDEN)', async () => {
    // member's Default role holds no all-grant on haynestower.
    try {
      await memberCaller.plex.setServerAll({ serverId: SEEDED_PLEX_SERVER_IDS.haynestower, on: true });
      throw new Error('expected throw');
    } catch (err) {
      const shape = wireShape(err, 'plex.setServerAll');
      expect(shape.data.code).toBe('FORBIDDEN');
      expect(shape.data.appCode).toBe('LIBRARY_NOT_ALLOWED');
    }
  });

  it('turns All on then off for an all-granted user; myLibraries reflects allActive both ways', async () => {
    const user = await createUser(t.db, { email: 'toggler@example.com' });
    const { roleId } = await createRole({ db: t.db, name: 'toggle-role', actorId: null });
    await adminCaller.plex.setRoleLibraryGrants({
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
    });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });

    const s = makeApiPlexStub({
      haynestower: { ...towerConfig().haynestower, friends: [{ id: '88', email: 'toggler@example.com' }] },
    });
    const c = caller(makeCtx(t.db, sessionUser(user), undefined, s.bundle));

    const on = await c.plex.setServerAll({ serverId: SEEDED_PLEX_SERVER_IDS.haynestower, on: true });
    expect(on).toMatchObject({ changed: true, event: 'share_all_enabled', allActive: true });
    expect(s.writes.at(-1)).toMatchObject({ slug: 'haynestower', kind: 'setAll', on: true });
    let libs = await c.plex.myLibraries();
    expect(libs.servers.find((x) => x.slug === 'haynestower')!.allActive).toBe(true);

    const off = await c.plex.setServerAll({ serverId: SEEDED_PLEX_SERVER_IDS.haynestower, on: false });
    expect(off).toMatchObject({ changed: true, event: 'share_all_disabled', allActive: false });
    expect(s.writes.at(-1)).toMatchObject({ slug: 'haynestower', kind: 'setAll', on: false });
    libs = await c.plex.myLibraries();
    expect(libs.servers.find((x) => x.slug === 'haynestower')!.allActive).toBe(false);
  });
});

describe('plex.roleLibraryGrants — per-server all-grants (ADR-024)', () => {
  it('setRoleLibraryGrants persists all-grants and roleLibraryGrants surfaces allGrantsByRole + server id', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'matrix-all-role', actorId: null });
    await adminCaller.plex.setRoleLibraryGrants({
      roleId,
      libraryIds: [moviesId],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
    });
    const matrix = await adminCaller.plex.roleLibraryGrants();
    expect(matrix.grantsByRole[roleId]).toEqual([moviesId]);
    expect(matrix.allGrantsByRole[roleId]).toEqual([SEEDED_PLEX_SERVER_IDS.haynestower]);
    const tower = matrix.servers.find((srv) => srv.slug === 'haynestower')!;
    expect(tower.id).toBe(SEEDED_PLEX_SERVER_IDS.haynestower);
  });
});

describe('procedure ladder', () => {
  it('myLibraries requires a session (UNAUTHORIZED)', async () => {
    const anon = caller(makeCtx(forbidDbAccess(), null, undefined, stub.bundle));
    await expect(anon.plex.myLibraries()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refreshRegistry + setRoleLibraryGrants require admin (FORBIDDEN)', async () => {
    await expect(memberCaller.plex.refreshRegistry({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.plex.setRoleLibraryGrants({ roleId: SEEDED_ROLE_IDS.default, libraryIds: [] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
