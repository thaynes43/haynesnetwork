// ADR-064 / DESIGN-035 (PLAN-037) — THE INVARIANT for the Collections group view, proven through the
// real ledger router: a collection member whose only Plex match lives in a WITHHELD library is
// excluded from BOTH the drill-in wall (ledger.search + collection) AND the group-card count
// (ledger.collectionGroups); a collection whose members are ALL inaccessible is absent from the
// listing entirely (no title leak); the count is the accessible ledger count, never the raw Plex
// child_count. Seeded exclusively through the domain single-writers (guard-scanned file).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { plexLibraries, users, SEEDED_PLEX_SERVER_IDS, type Database } from '@hnet/db';
import {
  assignRole,
  createRole,
  setRoleLibraries,
  syncPlexCollections,
  syncPlexMatches,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';

async function libIdOf(db: Database, slug: keyof typeof SEEDED_PLEX_SERVER_IDS, sectionKey: string) {
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
let hopsMoviesLib: string; // where the mirrored collections live
let hnetMoviesLib: string; // the second (granted) movie library
// media_items
let movieBoth: string; // matched into hops + hnet — accessible to the hnet-only role
let movieHopsOnly: string; // matched ONLY into hops — WITHHELD from the hnet-only role
let movieChartOnly: string; // the only accessible member of the franchise collection (admin view)
// roles
let hnetOnlyRoleId: string;

beforeAll(async () => {
  t = await bootMigratedDb();

  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
  });
  hopsMoviesLib = await libIdOf(t.db, 'haynesops', '1');
  hnetMoviesLib = await libIdOf(t.db, 'haynestower', '1');

  movieBoth = (await seedMediaItem(t.db, 'radarr', { title: 'Movie Both' })).id;
  movieHopsOnly = (await seedMediaItem(t.db, 'radarr', { title: 'Movie Hops Only' })).id;
  movieChartOnly = (await seedMediaItem(t.db, 'radarr', { title: 'Movie Chart Only' })).id;

  // A poster for Movie Both so the cover fan has a URL to carry.
  await upsertMediaMetadataBatch({
    db: t.db,
    rows: [
      {
        mediaItemId: movieBoth,
        posterSource: 'arr',
        posterRef: '/MediaCover/1/poster.jpg?lastWrite=1',
        sources: { arr: true },
      },
    ],
  });

  // Matches: Both is mirrored across hops + hnet; the other two live ONLY in hops.
  await syncPlexMatches({
    db: t.db,
    matches: [
      { mediaItemId: movieBoth, plexLibraryId: hopsMoviesLib, ratingKey: '9001', matchedVia: 'tmdb' },
      { mediaItemId: movieBoth, plexLibraryId: hnetMoviesLib, ratingKey: '8001', matchedVia: 'tmdb' },
      { mediaItemId: movieHopsOnly, plexLibraryId: hopsMoviesLib, ratingKey: '9002', matchedVia: 'tmdb' },
      { mediaItemId: movieChartOnly, plexLibraryId: hopsMoviesLib, ratingKey: '9003', matchedVia: 'tmdb' },
    ],
    scopedLibraryIds: [hopsMoviesLib, hnetMoviesLib],
  });

  // Five mirrored HOps collections (titles chosen so the D-10 classifier spreads the buckets):
  //   • The Fixture Franchise (other) — members Both (9001) + HopsOnly (9002) + a NON-LEDGER
  //     chart entry (9999).
  //   • Hops Charts (list) — members HopsOnly (9002) + ChartOnly (9003): ALL inaccessible to
  //     hnet-only.
  //   • IMDb Top 250 (list) — member HopsOnly (9002): inaccessible to hnet-only.
  //   • Star Wars (franchise_universe) — member Both (9001): accessible to hnet-only via hnet.
  //   • The Fixture Trilogy (trilogy) — member ChartOnly (9003): inaccessible to hnet-only.
  await syncPlexCollections({
    db: t.db,
    collections: [
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77001',
        title: 'The Fixture Franchise',
        childCount: 3,
        createdBy: 'kometa',
        members: [
          { ratingKey: '9001', sortOrder: 0 },
          { ratingKey: '9002', sortOrder: 1 },
          { ratingKey: '9999', sortOrder: 2 }, // mirrored raw, no ledger match — never surfaces
        ],
        fullyRead: true,
      },
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77002',
        title: 'Hops Charts',
        childCount: 2,
        createdBy: 'kometa',
        members: [
          { ratingKey: '9002', sortOrder: 0 },
          { ratingKey: '9003', sortOrder: 1 },
        ],
        fullyRead: true,
      },
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77003',
        title: 'IMDb Top 250',
        childCount: 1,
        createdBy: 'kometa',
        members: [{ ratingKey: '9002', sortOrder: 0 }],
        fullyRead: true,
      },
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77004',
        title: 'Star Wars',
        childCount: 1,
        createdBy: 'plex',
        members: [{ ratingKey: '9001', sortOrder: 0 }],
        fullyRead: true,
      },
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77005',
        title: 'The Fixture Trilogy',
        childCount: 1,
        createdBy: null,
        members: [{ ratingKey: '9003', sortOrder: 0 }],
        fullyRead: true,
      },
    ],
    scopedLibraryIds: [hopsMoviesLib],
  });

  hnetOnlyRoleId = (await createRole({ db: t.db, name: 'hnet-only', actorId: null })).roleId;
  await setRoleLibraries({ db: t.db, roleId: hnetOnlyRoleId, libraryIds: [hnetMoviesLib], actorId: null });
});

afterAll(async () => {
  await t?.stop();
});

async function callerFor(roleId: string | 'admin') {
  const user = roleId === 'admin' ? await createUser(t.db, { admin: true }) : await createUser(t.db);
  if (roleId !== 'admin') {
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
  }
  const [fresh] = await t.db.select().from(users).where(eq(users.id, user.id));
  return caller(makeCtx(t.db, sessionUser(fresh!)));
}

describe('ledger.collectionGroups (ADR-064 / DESIGN-035 D-03)', () => {
  it('admin sees every collection with ACCESSIBLE ledger counts (never the raw Plex child_count) + its D-10 type', async () => {
    const c = await callerFor('admin');
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    expect(groups.map((g) => [g.key, g.label, g.count, g.type])).toEqual([
      ['77002', 'Hops Charts', 2, 'list'],
      ['77003', 'IMDb Top 250', 1, 'list'],
      ['77004', 'Star Wars', 1, 'franchise_universe'],
      // Franchise childCount is 3 (raw, incl. the non-ledger 9999) but the LEDGER count is 2.
      ['77001', 'The Fixture Franchise', 2, 'other'],
      ['77005', 'The Fixture Trilogy', 1, 'trilogy'],
    ]);
    // Cover fan: the franchise's first ledger member with a poster (Movie Both) contributes.
    const franchise = groups.find((g) => g.key === '77001')!;
    expect(franchise.coverUrls).toEqual([`/api/posters/${movieBoth}`]);
    expect(franchise.imageUrl).toBeNull();
    // PROVENANCE badge — created_by resolved to its display name: 'kometa' → 'Kometa', 'plex' →
    // 'Plex', and a null created_by (The Fixture Trilogy) yields null (no badge).
    expect(groups.map((g) => [g.key, g.provenance])).toEqual([
      ['77002', 'Kometa'],
      ['77003', 'Kometa'],
      ['77004', 'Plex'],
      ['77001', 'Kometa'],
      ['77005', null],
    ]);
  });

  it('THE INVARIANT — a withheld member is excluded from the count; an all-withheld collection is absent', async () => {
    const c = await callerFor(hnetOnlyRoleId);
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    // Hops Charts / IMDb Top 250 / The Fixture Trilogy (members only in the withheld HOps
    // library) do not exist for this caller.
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['77004', 1],
      ['77001', 1],
    ]);
  });

  it('a kind with no collection members lists nothing', async () => {
    const c = await callerFor('admin');
    expect((await c.ledger.collectionGroups({ arrKind: 'sonarr' })).groups).toEqual([]);
  });
});

describe('ledger.collectionGroups Type facet (DESIGN-035 D-11 / R-214 — PLAN-053)', () => {
  it('ctype filters the CARDS server-side while typeCounts stay unfiltered (chip numbers hold steady)', async () => {
    const c = await callerFor('admin');
    const res = await c.ledger.collectionGroups({ arrKind: 'radarr', ctype: 'list' });
    expect(res.groups.map((g) => [g.key, g.type])).toEqual([
      ['77002', 'list'],
      ['77003', 'list'],
    ]);
    // Full accessible-collection counts, zeros included — NOT narrowed by the active chip.
    expect(res.typeCounts).toEqual({
      trilogy: 1,
      franchise_universe: 1,
      director: 0,
      actor: 0,
      list: 2,
      other: 1,
    });
    // A bucket with no accessible collections filters to an empty card grid (the chip still
    // renders client-side — owner ruling: filters, never hides).
    const none = await c.ledger.collectionGroups({ arrKind: 'radarr', ctype: 'director' });
    expect(none.groups).toEqual([]);
  });

  it('THE INVARIANT for counts — a chip count respects the same gating as the cards (R-214)', async () => {
    const c = await callerFor(hnetOnlyRoleId);
    const res = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    // The two list collections + the trilogy are all-withheld for this caller: they are neither
    // carded NOR counted — a leaked chip count would name what the caller can't see.
    expect(res.typeCounts).toEqual({
      trilogy: 0,
      franchise_universe: 1,
      director: 0,
      actor: 0,
      list: 0,
      other: 1,
    });
    // And filtering to an all-withheld bucket yields nothing (no error, no leak).
    expect((await c.ledger.collectionGroups({ arrKind: 'radarr', ctype: 'list' })).groups).toEqual([]);
  });
});

describe('ledger.search + collection drill-in (ADR-064 / DESIGN-035 D-04)', () => {
  it('narrows the wall to the collection members (admin — both ledger members, never the raw 9999)', async () => {
    const c = await callerFor('admin');
    const res = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any', collection: '77001' });
    expect(res.items.map((i) => i.title).sort()).toEqual(['Movie Both', 'Movie Hops Only']);
  });

  it('THE INVARIANT — the drilled wall excludes a member whose only match is a withheld library', async () => {
    const c = await callerFor(hnetOnlyRoleId);
    const franchise = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any', collection: '77001' });
    expect(franchise.items.map((i) => i.title)).toEqual(['Movie Both']);
    // The all-withheld collection drills to an EMPTY wall (its card never rendered anyway).
    const charts = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any', collection: '77002' });
    expect(charts.items).toHaveLength(0);
  });

  it('composes with the other filters unchanged (text query inside the drill)', async () => {
    const c = await callerFor('admin');
    const res = await c.ledger.search({
      arrKind: 'radarr',
      onDisk: 'any',
      collection: '77001',
      query: 'hops',
    });
    expect(res.items.map((i) => i.title)).toEqual(['Movie Hops Only']);
  });

  it('an unknown collection key yields an empty wall (no error, no leak)', async () => {
    const c = await callerFor('admin');
    const res = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any', collection: 'nope' });
    expect(res.items).toHaveLength(0);
  });
});
