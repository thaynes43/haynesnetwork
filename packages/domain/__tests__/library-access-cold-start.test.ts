// ADR-081 C-05 — the honest cold-start distinction on the access gate: an empty Library because the match
// table is EMPTY (cold_start, transient) vs because the role holds no intersecting grant (no_access, a true
// denial). Computed server-side. Proven against an embedded PG16 with the real migrations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  mediaItems,
  plexLibraries,
  SEEDED_PLEX_SERVER_IDS,
  SEEDED_ROLE_IDS,
  type Database,
} from '@hnet/db';
import {
  assignRole,
  createRole,
  libraryEmptyReason,
  resolveLibraryAccessGate,
  setRoleLibraries,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

async function moviesLibId(db: Database): Promise<string> {
  const [row] = await db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynestower),
        eq(plexLibraries.sectionKey, '1'),
      ),
    );
  if (!row) throw new Error('Movies library not seeded');
  return row.id;
}

let t: TestDb;
let moviesLib: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
  });
  moviesLib = await moviesLibId(t.db);
});

afterAll(async () => {
  await t?.stop();
});

describe('resolveLibraryAccessGate cold-start reason (ADR-081 C-05)', () => {
  it('cold_start — an EMPTY match table ⇒ matchTableEmpty and cold_start for a non-admin, whatever the grants', async () => {
    // No media_plex_matches rows exist yet.
    const user = await createUser(t.db); // Default role
    const gate = await resolveLibraryAccessGate(user.id, t.db);
    expect(gate.matchTableEmpty).toBe(true);
    expect(gate.visibleArrKinds.size).toBe(0);
    expect(libraryEmptyReason(gate)).toBe('cold_start');
  });

  it('no_access — a POPULATED match table but no intersecting grant ⇒ no_access, not cold_start', async () => {
    // Populate the match table: one radarr item matched into Movies.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 5001,
          tmdbId: 5001,
          title: 'Movie A',
          sortTitle: 'movie a',
          year: 2020,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/data/haynestower/Media/Movies',
          onDiskFileCount: 1,
          expectedFileCount: 1,
        },
      ],
    });
    const [mi] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.arrItemId, 5001));
    await syncPlexMatches({
      db: t.db,
      matches: [{ mediaItemId: mi!.id, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' }],
      scopedLibraryIds: [moviesLib],
    });

    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'cs-no-grant', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });

    const gate = await resolveLibraryAccessGate(user.id, t.db);
    expect(gate.matchTableEmpty).toBe(false);
    expect(gate.visibleArrKinds.size).toBe(0);
    expect(libraryEmptyReason(gate)).toBe('no_access');
  });

  it('resolves with no empty reason once the role is granted the library', async () => {
    const user = await createUser(t.db);
    const { roleId } = await createRole({ db: t.db, name: 'cs-granted', actorId: null });
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [moviesLib], actorId: null });

    const gate = await resolveLibraryAccessGate(user.id, t.db);
    expect(gate.visibleArrKinds.has('radarr')).toBe(true);
    expect(libraryEmptyReason(gate)).toBeNull();
  });

  it('admin ⇒ unrestricted with no empty reason (matchTableEmpty still reflects the table)', async () => {
    const admin = await createUser(t.db);
    await assignRole({
      db: t.db,
      userId: admin.id,
      toRoleId: SEEDED_ROLE_IDS.admin,
      initiator: { id: null, kind: 'system' },
    });
    const gate = await resolveLibraryAccessGate(admin.id, t.db);
    expect(gate.unrestricted).toBe(true);
    expect(gate.matchTableEmpty).toBe(false); // a match was seeded in the no_access test
    expect(libraryEmptyReason(gate)).toBeNull();
  });
});
