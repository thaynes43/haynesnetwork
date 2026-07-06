// ADR-017 / DESIGN-007 D-05 — plex router tests: admin refresh populates the registry, the
// grant matrix + setRoleLibraryGrants drive role_library_grants, self-service add/remove
// records the sharing writes on the injected stub bundle, myLibraries reflects live share
// state, and the D-13 error taxonomy (LIBRARY_NOT_ALLOWED, PLEX_ACCOUNT_UNMATCHED) flows
// through the real errorFormatter. The procedure ladder (authed / admin) is exercised too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plexLibraries, plexServers, SEEDED_ROLE_IDS } from '@hnet/db';
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
