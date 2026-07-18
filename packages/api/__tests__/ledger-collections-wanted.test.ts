// DESIGN-035 D-16 — Wanted-tile membership through the real ledger router: a mirrored collection's
// full membership is held (Plex-child → media_plex_matches) UNION wanted (*arr-native held=false rows
// → media_items directly). collectionGroups counts both and reports wantedCount; the drop-empty
// INVARIANT is SOFTENED (a 0-held/N-wanted collection now renders its Wanted tiles); the ?collection
// drill surfaces held + wanted; the writer's wanted reconcile is scoped to resolved collections.
// Seeded exclusively through the domain single-writers (guard-scanned file).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { plexLibraries, SEEDED_PLEX_SERVER_IDS, type Database } from '@hnet/db';
import { syncPlexCollections, syncPlexMatches, upsertPlexLibraries } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';

async function libIdOf(
  db: Database,
  slug: keyof typeof SEEDED_PLEX_SERVER_IDS,
  sectionKey: string,
) {
  const [row] = await db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS[slug]),
        eq(plexLibraries.sectionKey, sectionKey),
      ),
    );
  if (!row) throw new Error(`library ${slug}:${sectionKey} not seeded`);
  return row.id;
}

let t: TestDb;
let moviesLib: string;
let held: string; // on disk, in Plex → a HELD member
let wanted1: string; // monitored, 0 on disk → a WANTED member
let wanted2: string; // monitored, 0 on disk → a WANTED member

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  moviesLib = await libIdOf(t.db, 'haynesops', '1');

  held = (await seedMediaItem(t.db, 'radarr', { title: 'Held Movie', onDiskFileCount: 1 })).id;
  wanted1 = (await seedMediaItem(t.db, 'radarr', { title: 'Wanted One', onDiskFileCount: 0 })).id;
  wanted2 = (await seedMediaItem(t.db, 'radarr', { title: 'Wanted Two', onDiskFileCount: 0 })).id;

  // The held member is matched into Plex (rating_key 9001); the wanted ones are NOT in Plex.
  await syncPlexMatches({
    db: t.db,
    matches: [
      { mediaItemId: held, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' },
    ],
    scopedLibraryIds: [moviesLib],
  });
});

afterAll(async () => {
  await t?.stop();
});

async function seedCollections(franchiseWanted: string[], opts: { allWanted?: string[] } = {}) {
  await syncPlexCollections({
    db: t.db,
    collections: [
      {
        plexLibraryId: moviesLib,
        ratingKey: '88001',
        title: 'Franchise A',
        childCount: 1,
        createdBy: 'kometa',
        category: 'Sequels',
        members: [{ ratingKey: '9001', sortOrder: 0 }], // the held member
        fullyRead: true,
        wantedMemberIds: franchiseWanted,
        wantedResolved: true,
      },
      {
        plexLibraryId: moviesLib,
        ratingKey: '88002',
        title: 'Held Only',
        childCount: 1,
        createdBy: 'kometa',
        category: 'Universe',
        members: [{ ratingKey: '9001', sortOrder: 0 }],
        fullyRead: true,
        wantedMemberIds: [],
        wantedResolved: true,
      },
      {
        plexLibraryId: moviesLib,
        ratingKey: '88003',
        title: 'All Wanted',
        childCount: 0,
        createdBy: 'kometa',
        category: 'List',
        members: [], // ZERO held members — previously DROPPED; now renders its Wanted tiles
        fullyRead: true,
        wantedMemberIds: opts.allWanted ?? [wanted1],
        wantedResolved: true,
      },
    ],
    scopedLibraryIds: [moviesLib],
  });
}

async function adminCaller() {
  const user = await createUser(t.db, { admin: true });
  return caller(makeCtx(t.db, sessionUser(user)));
}

describe('ledger.collectionGroups — Wanted-tile membership (DESIGN-035 D-16)', () => {
  it('counts held + wanted, reports wantedCount, and RENDERS a 0-held/N-wanted collection', async () => {
    await seedCollections([wanted1, wanted2]);
    const c = await adminCaller();
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    const byKey = new Map(groups.map((g) => [g.key, g]));

    // Franchise A: 1 held + 2 wanted = 3 total; wantedCount 2.
    expect(byKey.get('88001')).toMatchObject({ count: 3, wantedCount: 2 });
    // Held Only: 1 held, 0 wanted.
    expect(byKey.get('88002')).toMatchObject({ count: 1, wantedCount: 0 });
    // All Wanted: 0 held, 1 wanted — the drop-empty INVARIANT is softened, so it RENDERS (was absent).
    expect(byKey.get('88003')).toMatchObject({ count: 1, wantedCount: 1 });
  });

  it('the ?collection drill surfaces held AND wanted members (the full membership)', async () => {
    await seedCollections([wanted1, wanted2]);
    const c = await adminCaller();
    // Franchise A drills to its held + wanted members.
    const res = await c.ledger.search({ arrKind: 'radarr', collection: '88001', limit: 50 });
    const ids = res.items.map((i) => i.id).sort();
    expect(ids).toEqual([held, wanted1, wanted2].sort());
    // The all-wanted collection drills to just its wanted member.
    const res2 = await c.ledger.search({ arrKind: 'radarr', collection: '88003', limit: 50 });
    expect(res2.items.map((i) => i.id)).toEqual([wanted1]);
  });

  it('the WANTED reconcile is scoped: a dropped wanted member is removed, held survives, on re-sync', async () => {
    await seedCollections([wanted1, wanted2]); // 2 wanted
    await seedCollections([wanted1]); // wanted2 dropped from the resolved membership
    const c = await adminCaller();
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    const franchise = groups.find((g) => g.key === '88001')!;
    // wanted2 reconciled away; the held member + wanted1 survive → count 2, wantedCount 1.
    expect(franchise).toMatchObject({ count: 2, wantedCount: 1 });
    const drill = await c.ledger.search({ arrKind: 'radarr', collection: '88001', limit: 50 });
    expect(drill.items.map((i) => i.id).sort()).toEqual([held, wanted1].sort());
  });
});
