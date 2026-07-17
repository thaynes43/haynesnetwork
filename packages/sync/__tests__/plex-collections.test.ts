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
      return {
        collections: [
          { ratingKey: '77001', title: 'IMDb Top 250', childCount: 250 },
          { ratingKey: '77002', title: 'The Fixture Franchise', childCount: 2 },
        ],
        truncated: false,
      };
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
    // Provenance + category — 77001 carries Kometa's managed label plus an owner `List` category
    // label (→ createdBy 'kometa', category 'List'); 77002 is hand-made (no labels → 'plex', null).
    async readCollectionLabels(ratingKey: string) {
      return ratingKey === '77001' ? ['Kometa', 'List'] : [];
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
      // DESIGN-035 D-10' — the label-derived category annotation the writer stores per upsert.
      category: plexCollections.category,
      // Provenance the writer stored (from the collection's labels this run).
      createdBy: plexCollections.createdBy,
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
    expect(top.createdBy).toBe('kometa'); // Kometa label present → 'kometa'
    const franchise = snap.collections.find((c) => c.ratingKey === '77002')!;
    expect(franchise.fullyRead).toBe(false); // truncated — never member-reconciled
    expect(franchise.createdBy).toBe('plex'); // no labels → hand-made

    const report = await syncPlexCollections({
      db: t.db,
      collections: snap.collections,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    expect(report.collectionsUpserted).toBe(2);
    expect(report.membersUpserted).toBe(3);
    expect(await collectionRows(t.db)).toEqual([
      // D-10' — the writer stores the label-derived category: 77001's owner `List` label → 'List',
      // 77002 carries no owner/section label → null (shows only under "All", no chip).
      { ratingKey: '77001', title: 'IMDb Top 250', childCount: 250, category: 'List', createdBy: 'kometa' },
      { ratingKey: '77002', title: 'The Fixture Franchise', childCount: 2, category: null, createdBy: 'plex' },
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
      createdBy: null, // this partial re-sync did not read labels — the writer preserves 'plex'
      category: null, // ...and preserves the prior category (null here) via COALESCE
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
          createdBy: 'kometa',
          category: 'List',
          members: [{ ratingKey: '9001', sortOrder: 0 }],
          fullyRead: true,
        },
      ],
      scopedLibraryIds: [moviesLib],
    });
    expect(report.membersRemoved).toBe(1); // 9002 left the fully-read 77001
    expect(report.collectionsRemoved).toBe(1); // 77002 vanished from the scoped library
    expect(await collectionRows(t.db)).toEqual([
      { ratingKey: '77001', title: 'IMDb Top 250 (2026)', childCount: 249, category: 'List', createdBy: 'kometa' },
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
        return {
          collections: [{ ratingKey: '77001', title: 'IMDb Top 250 (2027)', childCount: 251 }],
          truncated: false,
        };
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
        createdBy: 'kometa', // the label read still succeeded (only the member read failed)
        category: 'List', // ...so the category derived from those labels too
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
      { ratingKey: '77001', title: 'IMDb Top 250 (2027)', childCount: 251, category: 'List', createdBy: 'kometa' },
    ]);
    expect(await memberRows(t.db, '77001')).toEqual([{ ratingKey: '9001', sortOrder: 0 }]);
  });

  // Adversarial-review fix — a truncated /collections LISTING (page cap / totalSize contradiction)
  // mirrors the member-path fullyRead discipline at SECTION grain: everything seen upserts, but the
  // library is NOT scoped, so nothing of it can reconcile-delete from a partial read.
  it('a truncated collections LISTING never scopes the library (upserts land, zero deletes)', async () => {
    const truncatedListingRead = {
      ...fakeHopsRead(),
      async listCollections() {
        return {
          collections: [{ ratingKey: '77009', title: 'Beyond The Cap', childCount: 1 }],
          truncated: true,
        };
      },
      async listMetadataChildren() {
        return { items: [{ ratingKey: '9009' }], librarySectionId: '1', totalSize: 1 };
      },
    } as unknown as PlexReadClient;
    const snap = await fetchPlexCollectionsSnapshot({ db: t.db, plex: bundle(truncatedListingRead) });
    expect(snap.stats.sectionsRead).toBe(1);
    expect(snap.stats.truncatedSections).toBe(1);
    expect(snap.scopedLibraryIds).toHaveLength(0); // NOT scoped — the writer's reconcile must skip
    const report = await syncPlexCollections({
      db: t.db,
      collections: snap.collections,
      scopedLibraryIds: snap.scopedLibraryIds,
    });
    // 77001 is ABSENT from the partial read yet SURVIVES; the newly-seen 77009 upserts alongside.
    expect(report.collectionsRemoved).toBe(0);
    expect(report.membersRemoved).toBe(0);
    expect((await collectionRows(t.db)).map((c) => c.ratingKey)).toEqual(['77001', '77009']);
    expect(await memberRows(t.db, '77001')).toEqual([{ ratingKey: '9001', sortOrder: 0 }]);
    expect(await memberRows(t.db, '77009')).toEqual([{ ratingKey: '9009', sortOrder: 0 }]);
  });

  // DESIGN-035 D-10' — the category is RECOMPUTED from labels at every upsert: when the owner
  // relabels a collection the category flips in the same conflict-update; a null (label read failed)
  // PRESERVES the prior category via COALESCE (a transient read never wipes it). Rebuildable, no backfill.
  it('recomputes the category when labels change, and preserves it on a null read', async () => {
    const before = (await collectionRows(t.db)).find((c) => c.ratingKey === '77009')!;
    expect(before).toMatchObject({ title: 'Beyond The Cap', category: null }); // no owner label yet
    // Owner adds a `Universe` label → the derived category the writer receives is 'Universe'.
    await syncPlexCollections({
      db: t.db,
      collections: [
        {
          plexLibraryId: moviesLib,
          ratingKey: '77009',
          title: 'Beyond The Cap',
          childCount: 3,
          createdBy: 'kometa',
          category: 'Universe',
          members: [],
          fullyRead: false,
        },
      ],
      scopedLibraryIds: [],
    });
    expect((await collectionRows(t.db)).find((c) => c.ratingKey === '77009')).toMatchObject({
      category: 'Universe',
    });
    // A later sync whose label read FAILED (category null) preserves the stored 'Universe'.
    await syncPlexCollections({
      db: t.db,
      collections: [
        {
          plexLibraryId: moviesLib,
          ratingKey: '77009',
          title: 'Beyond The Cap',
          childCount: 3,
          createdBy: null,
          category: null,
          members: [],
          fullyRead: false,
        },
      ],
      scopedLibraryIds: [],
    });
    expect((await collectionRows(t.db)).find((c) => c.ratingKey === '77009')).toMatchObject({
      category: 'Universe',
    });
  });
});
