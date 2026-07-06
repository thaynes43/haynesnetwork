import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  permissionAudit,
  plexLibraries,
  roleLibraryGrants,
  roles,
  SEEDED_ROLE_IDS,
  SEEDED_PLEX_SERVER_IDS,
  type Database,
} from '@hnet/db';
import {
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
