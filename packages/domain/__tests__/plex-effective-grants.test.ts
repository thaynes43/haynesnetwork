import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  permissionAudit,
  plexLibraries,
  roleLibraryGrants,
  rolePlexServerAllGrants,
  roles,
  SEEDED_ROLE_IDS,
  SEEDED_PLEX_SERVER_IDS,
  type Database,
} from '@hnet/db';
import {
  allGrantedServerIdsForUser,
  assignRole,
  createRole,
  effectiveAllowedLibrariesForUser,
  setRoleLibraries,
  SystemRoleImmutableError,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

async function seedLibrary(
  db: Database,
  serverId: string,
  sectionKey: string,
  name: string,
  mediaType: 'movie' | 'show' | 'artist' | 'photo',
  available = true,
): Promise<string> {
  const [row] = await db
    .insert(plexLibraries)
    .values({ serverId, sectionKey, name, mediaType, available })
    .returning({ id: plexLibraries.id });
  return row!.id;
}

let t: TestDb;
let familyRoleId: string;
// haynestower libraries
let hnetMovies: string;
let hnetPhotos: string; // family
let hnetHomeVideos: string; // family
let hopsMovies: string; // haynesops

beforeAll(async () => {
  t = await bootMigratedDb();
  const tower = SEEDED_PLEX_SERVER_IDS.haynestower;
  const ops = SEEDED_PLEX_SERVER_IDS.haynesops;
  hnetMovies = await seedLibrary(t.db, tower, '1', 'HNet Movies', 'movie');
  hnetPhotos = await seedLibrary(t.db, tower, '4', 'HNet Photos', 'photo');
  hnetHomeVideos = await seedLibrary(t.db, tower, '5', 'HNet Home Videos', 'movie');
  hopsMovies = await seedLibrary(t.db, ops, '1', 'HOps Movies', 'movie');

  const [family] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Family'));
  familyRoleId = family!.id;

  // Default role → the non-family set; Family role → everything incl. the two family libs.
  await setRoleLibraries({
    db: t.db,
    roleId: SEEDED_ROLE_IDS.default,
    libraryIds: [hnetMovies, hopsMovies],
    actorId: null,
  });
  await setRoleLibraries({
    db: t.db,
    roleId: familyRoleId,
    libraryIds: [hnetMovies, hopsMovies, hnetPhotos, hnetHomeVideos],
    actorId: null,
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('effectiveAllowedLibrariesForUser (ADR-017 D-04/D-08)', () => {
  it('a Default-role user sees the non-family set — family libraries excluded (R-26)', async () => {
    const user = await createUser(t.db); // defaults to Default role
    const names = (await effectiveAllowedLibrariesForUser(user.id, t.db)).map((l) => l.name);
    expect(names).toEqual(['HOps Movies', 'HNet Movies']); // ordered by server slug then name
    expect(names).not.toContain('HNet Photos');
    expect(names).not.toContain('HNet Home Videos');
  });

  it('a Family-role user sees the family libraries too', async () => {
    const user = await createUser(t.db);
    await assignRole({ db: t.db, userId: user.id, toRoleId: familyRoleId, initiator: { id: null, kind: 'system' } });
    const names = (await effectiveAllowedLibrariesForUser(user.id, t.db)).map((l) => l.name);
    expect(names).toContain('HNet Photos');
    expect(names).toContain('HNet Home Videos');
  });

  it('an Admin-role user sees EVERY available library (no grant rows — D-08)', async () => {
    const admin = await createUser(t.db);
    await assignRole({ db: t.db, userId: admin.id, toRoleId: SEEDED_ROLE_IDS.admin, initiator: { id: null, kind: 'system' } });
    const libs = await effectiveAllowedLibrariesForUser(admin.id, t.db);
    expect(libs).toHaveLength(4);
    // Admin has no role_library_grants rows.
    const adminGrants = await t.db
      .select()
      .from(roleLibraryGrants)
      .where(eq(roleLibraryGrants.roleId, SEEDED_ROLE_IDS.admin));
    expect(adminGrants).toHaveLength(0);
  });

  it('a grants_all (non-admin) role still needs explicit library grants (D-08 — no short-circuit)', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'all-apps-no-libs', grantsAll: true, actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    expect(await effectiveAllowedLibrariesForUser(user.id, t.db)).toHaveLength(0);
  });

  it('withholds an unavailable library even when its grant survives (soft-state — D-04)', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'temp-role', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [hnetMovies], actorId: null });
    expect(await effectiveAllowedLibrariesForUser(user.id, t.db)).toHaveLength(1);
    await t.db.update(plexLibraries).set({ available: false }).where(eq(plexLibraries.id, hnetMovies));
    expect(await effectiveAllowedLibrariesForUser(user.id, t.db)).toHaveLength(0);
    await t.db.update(plexLibraries).set({ available: true }).where(eq(plexLibraries.id, hnetMovies)); // restore
  });
});

describe('setRoleLibraries (ADR-017 D-04/D-07)', () => {
  it('replaces the whole grant set and writes one update_role_libraries audit row', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'edit-me', actorId: null });
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [hnetMovies, hopsMovies], actorId: null });
    let grants = await t.db.select().from(roleLibraryGrants).where(eq(roleLibraryGrants.roleId, roleId));
    expect(grants).toHaveLength(2);

    await setRoleLibraries({ db: t.db, roleId, libraryIds: [hopsMovies], actorId: null }); // shrink
    grants = await t.db.select().from(roleLibraryGrants).where(eq(roleLibraryGrants.roleId, roleId));
    expect(grants.map((g) => g.plexLibraryId)).toEqual([hopsMovies]);

    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_role_libraries'));
    expect(audits.filter((a) => a.roleId === roleId)).toHaveLength(2);
  });

  it('refuses to edit the Admin role (it implicitly sees every library)', async () => {
    await expect(
      setRoleLibraries({ db: t.db, roleId: SEEDED_ROLE_IDS.admin, libraryIds: [hnetMovies], actorId: null }),
    ).rejects.toBeInstanceOf(SystemRoleImmutableError);
  });
});

describe('all-libraries server grants (ADR-024)', () => {
  it('effective set = explicit grants ∪ all available libraries of all-granted servers', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'union-role', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    // explicit: HNet Movies (tower); all-grant: haynesops (→ its one library, HOps Movies).
    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [hnetMovies],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynesops],
      actorId: null,
    });
    const names = (await effectiveAllowedLibrariesForUser(user.id, t.db)).map((l) => l.name);
    expect(names.sort()).toEqual(['HNet Movies', 'HOps Movies']);
  });

  it('an all-grant covers a whole server and de-dupes a library that is ALSO explicitly granted', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'dedupe-role', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    // Explicit HNet Movies AND an all-grant on haynestower (which itself covers HNet Movies).
    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [hnetMovies],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
      actorId: null,
    });
    const libs = await effectiveAllowedLibrariesForUser(user.id, t.db);
    expect(libs.filter((l) => l.name === 'HNet Movies')).toHaveLength(1); // no duplicate
    expect(libs.map((l) => l.name).sort()).toEqual(['HNet Home Videos', 'HNet Movies', 'HNet Photos']);
  });

  it('allGrantedServerIdsForUser: a role returns its all-grants; Admin returns every server', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'allgrant-role', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynesops],
      actorId: null,
    });
    expect([...(await allGrantedServerIdsForUser(user.id, t.db))]).toEqual([SEEDED_PLEX_SERVER_IDS.haynesops]);

    const admin = await createUser(t.db);
    await assignRole({ db: t.db, userId: admin.id, toRoleId: SEEDED_ROLE_IDS.admin, initiator: { id: null, kind: 'system' } });
    expect((await allGrantedServerIdsForUser(admin.id, t.db)).size).toBe(3); // all three seeded servers
  });

  it('setRoleLibraries replace-sets the all-grants and records them in the audit detail', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'audit-all-role', actorId: null });
    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower, SEEDED_PLEX_SERVER_IDS.haynesops],
      actorId: null,
    });
    let rows = await t.db
      .select()
      .from(rolePlexServerAllGrants)
      .where(eq(rolePlexServerAllGrants.roleId, roleId));
    expect(rows).toHaveLength(2);

    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
      actorId: null,
    });
    rows = await t.db
      .select()
      .from(rolePlexServerAllGrants)
      .where(eq(rolePlexServerAllGrants.roleId, roleId));
    expect(rows.map((r) => r.plexServerId)).toEqual([SEEDED_PLEX_SERVER_IDS.haynestower]);

    const audits = await t.db.select().from(permissionAudit).where(eq(permissionAudit.roleId, roleId));
    const last = audits.at(-1)!;
    expect((last.detail as { all_servers_after: unknown[] }).all_servers_after).toHaveLength(1);
  });

  it('omitting allServerIds leaves existing all-grants untouched (back-compat)', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'untouched-role', actorId: null });
    await setRoleLibraries({
      db: t.db,
      roleId,
      libraryIds: [],
      allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
      actorId: null,
    });
    // A later call that only manages the per-library set must NOT wipe the all-grant.
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [hnetMovies], actorId: null });
    const rows = await t.db
      .select()
      .from(rolePlexServerAllGrants)
      .where(eq(rolePlexServerAllGrants.roleId, roleId));
    expect(rows).toHaveLength(1);
  });
});
