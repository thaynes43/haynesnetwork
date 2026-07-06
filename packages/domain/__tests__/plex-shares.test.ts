import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  plexLibraries,
  plexShareAudit,
  SEEDED_ROLE_IDS,
  SEEDED_PLEX_SERVER_IDS,
  type Database,
} from '@hnet/db';
import {
  assignRole,
  createRole,
  LibraryNotAllowedError,
  PlexAccountUnmatchedError,
  PlexAllStateError,
  setRoleLibraries,
  setServerAllShare,
  shareLibrary,
  unshareLibrary,
  type PlexClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ---- a fake PlexClientBundle: records write payloads, serves configurable reads ----

interface RecordedWrite {
  kind: 'create' | 'update' | 'delete' | 'setAll';
  librarySectionIds?: number[];
  invitedUserId?: number;
  sharedServerId?: string | null;
  on?: boolean;
}
interface SharedState {
  id: string;
  sections: Array<{ id: string; key: string; shared: boolean }>;
  /** ADR-024 — a share-everything (incl. future libraries) all-libraries grant. */
  allLibraries?: boolean;
}
interface TowerState {
  friends: Array<{ id: string; email: string }>;
  serverSections: Array<{ id: string; key: string }>;
  sharedByUser: Record<string, SharedState>;
}

function makeFakeBundle(state: TowerState): { bundle: PlexClientBundle; writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];
  const read = {
    machineIdentifier: 'mid-tower',
    async findFriendByEmail(email: string) {
      const f = state.friends.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      return f ? { id: f.id, email: f.email, username: null, title: null } : null;
    },
    async listServerSections() {
      return state.serverSections.map((s) => ({ id: s.id, key: s.key, title: '', type: 'movie' }));
    },
    async findSharedServerForUser(userId: string) {
      const s = state.sharedByUser[userId];
      return s
        ? { id: s.id, userID: userId, email: null, username: null, allLibraries: s.allLibraries ?? false, sections: s.sections }
        : null;
    },
  };
  const write = {
    async createSharedServer(input: { invitedUserId: number; librarySectionIds: number[] }) {
      writes.push({ kind: 'create', invitedUserId: input.invitedUserId, librarySectionIds: input.librarySectionIds });
      return { sharedServerId: 'new-1' };
    },
    async updateSharedServer(input: { sharedServerId: string; librarySectionIds: number[] }) {
      writes.push({ kind: 'update', sharedServerId: input.sharedServerId, librarySectionIds: input.librarySectionIds });
    },
    async deleteSharedServer(sharedServerId: string) {
      writes.push({ kind: 'delete', sharedServerId });
    },
    async updateSharedServerAll(input: {
      sharedServerId: string | null;
      invitedUserId: number;
      on: boolean;
      librarySectionIds?: number[];
    }) {
      writes.push({
        kind: 'setAll',
        sharedServerId: input.sharedServerId,
        invitedUserId: input.invitedUserId,
        on: input.on,
        librarySectionIds: input.librarySectionIds,
      });
      return { sharedServerId: input.sharedServerId ?? 'new-all-1' };
    },
  };
  const bundle = {
    read: { haynestower: read, haynesops: read, hayneskube: read },
    write: { haynestower: write, haynesops: write, hayneskube: write },
  } as unknown as PlexClientBundle;
  return { bundle, writes };
}

async function seedLibrary(db: Database, sectionKey: string, name: string): Promise<string> {
  const [row] = await db
    .insert(plexLibraries)
    .values({ serverId: SEEDED_PLEX_SERVER_IDS.haynestower, sectionKey, name, mediaType: 'movie' })
    .returning({ id: plexLibraries.id });
  return row!.id;
}

let t: TestDb;
let moviesLib: string; // granted (section key '1' → plex.tv id 118181361)
let photosLib: string; // NOT granted (section key '4')

beforeAll(async () => {
  t = await bootMigratedDb();
  moviesLib = await seedLibrary(t.db, '1', 'HNet Movies');
  photosLib = await seedLibrary(t.db, '4', 'HNet Photos');
  // Default role grants only Movies.
  await setRoleLibraries({ db: t.db, roleId: SEEDED_ROLE_IDS.default, libraryIds: [moviesLib], actorId: null });
});

afterAll(async () => {
  await t?.stop();
});

const SERVER_SECTIONS = [
  { id: '118181361', key: '1' }, // Movies
  { id: '118278404', key: '4' }, // Photos
];

async function freshUser(email: string) {
  return createUser(t.db, { email });
}

async function auditFor(userId: string) {
  return t.db.select().from(plexShareAudit).where(eq(plexShareAudit.userId, userId));
}

describe('shareLibrary — role gate (ADR-017 D-04)', () => {
  it('throws LibraryNotAllowedError and makes NO write-client call for a non-granted library', async () => {
    const user = await freshUser('gate@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '42', email: 'gate@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    await expect(
      shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: photosLib, actorId: user.id }),
    ).rejects.toBeInstanceOf(LibraryNotAllowedError);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });

  it('throws PlexAccountUnmatchedError when the user is not a Plex friend (no write, no audit)', async () => {
    const user = await freshUser('stranger@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '42', email: 'someone-else@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    await expect(
      shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id }),
    ).rejects.toBeInstanceOf(PlexAccountUnmatchedError);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });
});

describe('shareLibrary — read-merge-write (ADR-017 D-02)', () => {
  it('creates a new SharedServer when the user has none', async () => {
    const user = await freshUser('new@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '7', email: 'new@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    const res = await shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(res).toMatchObject({ changed: true, event: 'share_added', libraryName: 'HNet Movies' });
    expect(writes).toEqual([{ kind: 'create', invitedUserId: 7, librarySectionIds: [118181361] }]);
    const audit = await auditFor(user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('share_added');
  });

  it('PRESERVES the user’s existing sections when adding (never blind-overwrite)', async () => {
    const user = await freshUser('existing@example.com');
    // The user already shares an UNRELATED section 999 (a real other library).
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '9', email: 'existing@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {
        '9': { id: 'ss-9', sections: [{ id: '999', key: '2', shared: true }] },
      },
    });
    await shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.kind).toBe('update');
    expect(writes[0]!.sharedServerId).toBe('ss-9');
    // union: the pre-existing 999 survives AND the target 118181361 is added.
    expect(writes[0]!.librarySectionIds!.sort()).toEqual([999, 118181361].sort());
    const audit = await auditFor(user.id);
    expect(audit[0]!.detail).toMatchObject({ previous_section_ids: [999], new_section_ids: [999, 118181361] });
  });

  it('is idempotent — adding an already-shared library makes no write and no audit row', async () => {
    const user = await freshUser('idem@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '11', email: 'idem@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {
        '11': { id: 'ss-11', sections: [{ id: '118181361', key: '1', shared: true }] },
      },
    });
    const res = await shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });
});

describe('unshareLibrary (ADR-017 D-02)', () => {
  it('subtracts the section, preserving the rest', async () => {
    const user = await freshUser('rm@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '21', email: 'rm@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {
        '21': {
          id: 'ss-21',
          sections: [
            { id: '118181361', key: '1', shared: true },
            { id: '999', key: '2', shared: true },
          ],
        },
      },
    });
    const res = await unshareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(res).toMatchObject({ changed: true, event: 'share_removed' });
    expect(writes).toEqual([{ kind: 'update', sharedServerId: 'ss-21', librarySectionIds: [999] }]);
    expect((await auditFor(user.id))[0]!.event).toBe('share_removed');
  });

  it('DELETEs the SharedServer when the removed section was the last one', async () => {
    const user = await freshUser('last@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '31', email: 'last@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {
        '31': { id: 'ss-31', sections: [{ id: '118181361', key: '1', shared: true }] },
      },
    });
    await unshareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(writes).toEqual([{ kind: 'delete', sharedServerId: 'ss-31' }]);
  });

  it('is a no-op when the library is not currently shared', async () => {
    const user = await freshUser('noop@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '41', email: 'noop@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    const res = await unshareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('per-library add/remove refuses to demote an all-libraries account (ADR-024)', () => {
  // A friend whose current SharedServer is allLibraries="1" (share-everything, incl. future
  // libraries). A per-library add/remove would PUT an explicit list and silently demote the
  // superset — so both throw PLEX_ALL_STATE before any Plex write (the user must leave All first).
  function allLibrariesBundle(email: string, friendId: string) {
    return makeFakeBundle({
      friends: [{ id: friendId, email }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {
        [friendId]: {
          id: `ss-${friendId}`,
          allLibraries: true,
          sections: [{ id: '118181361', key: '1', shared: true }],
        },
      },
    });
  }

  it('add throws PlexAllStateError and makes NO write-client call', async () => {
    const user = await freshUser('alllibs-add@example.com');
    const { bundle, writes } = allLibrariesBundle('alllibs-add@example.com', '191');
    await expect(
      shareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id }),
    ).rejects.toBeInstanceOf(PlexAllStateError);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });

  it('remove throws PlexAllStateError and makes NO write-client call', async () => {
    const user = await freshUser('alllibs-rm@example.com');
    const { bundle, writes } = allLibrariesBundle('alllibs-rm@example.com', '192');
    await expect(
      unshareLibrary({ db: t.db, plex: bundle, userId: user.id, libraryId: moviesLib, actorId: user.id }),
    ).rejects.toBeInstanceOf(PlexAllStateError);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });
});

describe('setServerAllShare (ADR-024 — role-scoped all-libraries self-toggle)', () => {
  const TOWER = SEEDED_PLEX_SERVER_IDS.haynestower;

  /** A user whose role holds an all-libraries grant on haynestower. */
  async function allGrantedUser(email: string) {
    const { roleId } = await createRole({ db: t.db, name: `all-${email}`, actorId: null });
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [], allServerIds: [TOWER], actorId: null });
    const user = await createUser(t.db, { email });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    return user;
  }

  it('role gate: a user whose role does NOT all-grant the server → LibraryNotAllowedError, no write', async () => {
    const user = await freshUser('all-gate@example.com'); // Default role — no all-grant
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '60', email: 'all-gate@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    await expect(
      setServerAllShare({ db: t.db, plex: bundle, userId: user.id, serverId: TOWER, on: true, actorId: user.id }),
    ).rejects.toBeInstanceOf(LibraryNotAllowedError);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });

  it('ON: enters all-libraries (create when no share) and audits share_all_enabled', async () => {
    const user = await allGrantedUser('all-on@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '61', email: 'all-on@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: {},
    });
    const res = await setServerAllShare({ db: t.db, plex: bundle, userId: user.id, serverId: TOWER, on: true, actorId: user.id });
    expect(res).toMatchObject({ changed: true, event: 'share_all_enabled', allActive: true });
    expect(writes).toEqual([{ kind: 'setAll', sharedServerId: null, invitedUserId: 61, on: true, librarySectionIds: undefined }]);
    const audit = await auditFor(user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('share_all_enabled');
    expect(audit[0]!.plexLibraryId).toBeNull();
  });

  it('ON: idempotent when already all — no write, no audit', async () => {
    const user = await allGrantedUser('all-idem@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '62', email: 'all-idem@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: { '62': { id: 'ss-62', allLibraries: true, sections: [] } },
    });
    const res = await setServerAllShare({ db: t.db, plex: bundle, userId: user.id, serverId: TOWER, on: true, actorId: user.id });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });

  it('OFF: leaves all, seeding the explicit full section set, audits share_all_disabled', async () => {
    const user = await allGrantedUser('all-off@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '63', email: 'all-off@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: { '63': { id: 'ss-63', allLibraries: true, sections: [] } },
    });
    const res = await setServerAllShare({ db: t.db, plex: bundle, userId: user.id, serverId: TOWER, on: false, actorId: user.id });
    expect(res).toMatchObject({ changed: true, event: 'share_all_disabled', allActive: false });
    // Seeded with EVERY server section id (no access loss).
    expect(writes).toEqual([
      { kind: 'setAll', sharedServerId: 'ss-63', invitedUserId: 63, on: false, librarySectionIds: [118181361, 118278404] },
    ]);
    const audit = await auditFor(user.id);
    expect(audit[0]!.event).toBe('share_all_disabled');
    expect(audit[0]!.detail).toMatchObject({ seeded_section_ids: [118181361, 118278404] });
  });

  it('OFF: idempotent when the account is not all — no write', async () => {
    const user = await allGrantedUser('all-off-noop@example.com');
    const { bundle, writes } = makeFakeBundle({
      friends: [{ id: '64', email: 'all-off-noop@example.com' }],
      serverSections: SERVER_SECTIONS,
      sharedByUser: { '64': { id: 'ss-64', allLibraries: false, sections: [{ id: '118181361', key: '1', shared: true }] } },
    });
    const res = await setServerAllShare({ db: t.db, plex: bundle, userId: user.id, serverId: TOWER, on: false, actorId: user.id });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
