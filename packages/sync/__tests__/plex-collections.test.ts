// ADR-064 / DESIGN-035 (PLAN-037) — the collections mirror: the HOps-only fetcher (registered
// movie/show sections, paged collections, raw membership) + the syncPlexCollections single-writer
// (upsert + reconcile SCOPED to fully-read sections/collections — a partial read never tombstones).
// Proven against an embedded PG16 with a fake Plex read bundle (no live Plex).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  plexCollections,
  plexCollectionMembers,
  plexLibraries,
  SEEDED_PLEX_SERVER_IDS,
} from '@hnet/db';
import type { Database, PlexServerSlug } from '@hnet/db';
import {
  syncPlexCollections,
  upsertPlexLibraries,
  type PlexClientBundle,
  type PlexCollectionSyncInput,
} from '@hnet/domain';
import type { PlexReadClient } from '@hnet/plex/read';
import { fetchPlexCollectionsSnapshot } from '../src/plex-collections';
import { bootMigratedDb, type TestDb } from './helpers';

/** A fake HOps PlexReadClient: one registered Movies section with two collections, one Photos
 *  section (skipped by type), one unregistered Movies section (unmapped, skipped). */
function fakeHopsRead(): PlexReadClient {
  return {
    machineIdentifier: 'mach-ops',
    async listSections() {
      return [
        { key: '1', title: 'HOps Movies', type: 'movie' },
        { key: '9', title: 'HOps Photos', type: 'photo' },
        { key: '5', title: 'HOps 4K', type: 'movie' }, // NOT in the registry → unmapped, skipped
      ];
    },
    async listCollections(sectionKey: string) {
      if (sectionKey !== '1') throw new Error(`unexpected section ${sectionKey}`);
      return [
        { ratingKey: '77001', title: 'IMDb Top 250', childCount: 250 },
        { ratingKey: '77002', title: 'The Fixture Franchise', childCount: 2 },
      ];
    },
    async listMetadataChildren(ratingKey: string) {
      if (ratingKey === '77001') {
        return {
          items: [{ ratingKey: '9001' }, { ratingKey: '9002' }],
          librarySectionId: '1',
          totalSize: 2,
        };
      }
      // 77002 — TRUNCATED read (totalSize > items): its members must never be reconciled.
      return { items: [{ ratingKey: '9002' }], librarySectionId: '1', totalSize: 5 };
    },
  } as unknown as PlexReadClient;
}

function bundle(read: PlexReadClient, slug: PlexServerSlug = 'haynesops'): Pick<PlexClientBundle, 'read'> {
  return { read: { [slug]: read } as unknown as Record<PlexServerSlug, PlexReadClient> };
}

let t: TestDb;
let moviesLib: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  const [lib] = await t.db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynesops),
        eq(plexLibraries.sectionKey, '1'),
      ),
    );
  moviesLib = lib!.id;
});
afterAll(async () => {
  await t?.stop();
});

async function collectionRows(db: Database) {
  return db
    .select({
      ratingKey: plexCollections.ratingKey,
      title: plexCollections.title,
      childCount: plexCollections.childCount,
    })
    .from(plexCollections)
    .orderBy(asc(plexCollections.ratingKey));
}

async function memberRows(db: Database, collectionRatingKey: string) {
  return db
    .select({
      ratingKey: plexCollectionMembers.ratingKey,
      sortOrder: plexCollectionMembers.sortOrder,
    })
    .from(plexCollectionMembers)
    .innerJoin(plexCollections, eq(plexCollections.id, plexCollectionMembers.collectionId))
    .where(eq(plexCollections.ratingKey, collectionRatingKey))
    .orderBy(asc(plexCollectionMembers.sortOrder));
}

describe('fetchPlexCollectionsSnapshot + syncPlexCollections (ADR-064)', () => {
  it('mirrors the registered section\'s collections + raw members; skips photo/unmapped sections', async () => {
    const snap = await fetchPlexCollectionsSnapshot({ db: t.db, plex: bundle(fakeHopsRead()) });
    expect(snap.stats.sectionsRead).toBe(1);
    expect(snap.stats.unmappedSections).toBe(1); // the 4K section absent from the registry
    expect(snap.stats.collectionsFetched).toBe(2);
    expect(snap.stats.truncatedCollections).toBe(1); // 77002 (totalSize 5 > 1 item)
    expect(snap.scopedLibraryIds).toEqual([moviesLib]);
    const top = snap.collections.find((c) => c.ratingKey === '77001')!;
    expect(top.fullyRead).toBe(true);
    expect(top.members).toEqual([
      { ratingKey: '9001', sortOrder: 0 },
      { ratingKey: '9002', sortOrder: 1 },
    ]);
    const franchise = snap.collections.find((c) => c.ratingKey === '77002')!;
    expect(franchise.fullyRead).toBe(false); // truncated — never member-reconciled

    const report = await syncPlexCollections({
      db: t.db,
      collections: snap.collections,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    expect(report.collectionsUpserted).toBe(2);
    expect(report.membersUpserted).toBe(3);
    expect(await collectionRows(t.db)).toEqual([
      { ratingKey: '77001', title: 'IMDb Top 250', childCount: 250 },
      { ratingKey: '77002', title: 'The Fixture Franchise', childCount: 2 },
    ]);
    // RAW membership regardless of ledger match (owner R3) — no media_items exist at all here.
    expect(await memberRows(t.db, '77001')).toEqual([
      { ratingKey: '9001', sortOrder: 0 },
      { ratingKey: '9002', sortOrder: 1 },
    ]);
  });

  it('a truncated member read never tombstones members it did not see (D-08 scope)', async () => {
    // Re-sync 77002 still truncated, now returning a DIFFERENT single member: the old member must
    // survive (no member reconcile for un-fullyRead collections), the new one upserts alongside.
    const truncated: PlexCollectionSyncInput = {
      plexLibraryId: moviesLib,
      ratingKey: '77002',
      title: 'The Fixture Franchise',
      childCount: 2,
      members: [{ ratingKey: '9003', sortOrder: 0 }],
      fullyRead: false,
    };
    const report = await syncPlexCollections({
      db: t.db,
      collections: [truncated],
      scopedLibraryIds: [], // partial run — collections aren't reconciled either
    });
    expect(report.membersRemoved).toBe(0);
    expect((await memberRows(t.db, '77002')).map((m) => m.ratingKey).sort()).toEqual([
      '9002',
      '9003',
    ]);
    // The un-scoped run also left 77001 fully intact.
    expect(await memberRows(t.db, '77001')).toHaveLength(2);
  });

  it('reconciles a vanished member (fully-read collection) and a vanished collection (scoped library)', async () => {
    // Fresh full run: 77001 keeps only member 9001 (retitled), 77002 is GONE from Plex.
    const report = await syncPlexCollections({
      db: t.db,
      collections: [
        {
          plexLibraryId: moviesLib,
          ratingKey: '77001',
          title: 'IMDb Top 250 (2026)',
          childCount: 249,
          members: [{ ratingKey: '9001', sortOrder: 0 }],
          fullyRead: true,
        },
      ],
      scopedLibraryIds: [moviesLib],
    });
    expect(report.membersRemoved).toBe(1); // 9002 left the fully-read 77001
    expect(report.collectionsRemoved).toBe(1); // 77002 vanished from the scoped library
    expect(await collectionRows(t.db)).toEqual([
      { ratingKey: '77001', title: 'IMDb Top 250 (2026)', childCount: 249 },
    ]);
    expect(await memberRows(t.db, '77001')).toEqual([{ ratingKey: '9001', sortOrder: 0 }]);
    // 77002's members CASCADEd away with it.
    expect(await memberRows(t.db, '77002')).toHaveLength(0);
  });

  it('a section whose collections listing fails is not scoped (nothing reconciled)', async () => {
    const failingRead = {
      ...fakeHopsRead(),
      async listCollections() {
        throw new Error('plex down');
      },
    } as unknown as PlexReadClient;
    const snap = await fetchPlexCollectionsSnapshot({ db: t.db, plex: bundle(failingRead) });
    expect(snap.collections).toHaveLength(0);
    expect(snap.scopedLibraryIds).toHaveLength(0);
    await syncPlexCollections({
      db: t.db,
      collections: snap.collections,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    // The prior mirror survives untouched.
    expect(await collectionRows(t.db)).toHaveLength(1);
    expect(await memberRows(t.db, '77001')).toHaveLength(1);
  });

  it('a member-read failure keeps the collection row but never reconciles its members', async () => {
    const memberFailRead = {
      ...fakeHopsRead(),
      async listCollections() {
        return [{ ratingKey: '77001', title: 'IMDb Top 250 (2027)', childCount: 251 }];
      },
      async listMetadataChildren() {
        throw new Error('children read failed');
      },
    } as unknown as PlexReadClient;
    const snap = await fetchPlexCollectionsSnapshot({ db: t.db, plex: bundle(memberFailRead) });
    expect(snap.collections).toEqual([
      {
        plexLibraryId: moviesLib,
        ratingKey: '77001',
        title: 'IMDb Top 250 (2027)',
        childCount: 251,
        members: [],
        fullyRead: false,
      },
    ]);
    await syncPlexCollections({
      db: t.db,
      collections: snap.collections,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    // Title advanced; the existing member survived (no reconcile without a full member read).
    expect(await collectionRows(t.db)).toEqual([
      { ratingKey: '77001', title: 'IMDb Top 250 (2027)', childCount: 251 },
    ]);
    expect(await memberRows(t.db, '77001')).toEqual([{ ratingKey: '9001', sortOrder: 0 }]);
  });
});
