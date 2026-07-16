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

  // Two mirrored HOps collections:
  //   • Franchise — members Both (9001) + HopsOnly (9002) + a NON-LEDGER chart entry (9999).
  //   • Hops Charts — members HopsOnly (9002) + ChartOnly (9003): ALL inaccessible to hnet-only.
  await syncPlexCollections({
    db: t.db,
    collections: [
      {
        plexLibraryId: hopsMoviesLib,
        ratingKey: '77001',
        title: 'The Fixture Franchise',
        childCount: 3,
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
        members: [
          { ratingKey: '9002', sortOrder: 0 },
          { ratingKey: '9003', sortOrder: 1 },
        ],
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
  it('admin sees both collections with ACCESSIBLE ledger counts (never the raw Plex child_count)', async () => {
    const c = await callerFor('admin');
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    expect(groups.map((g) => [g.key, g.label, g.count])).toEqual([
      ['77002', 'Hops Charts', 2],
      // Franchise childCount is 3 (raw, incl. the non-ledger 9999) but the LEDGER count is 2.
      ['77001', 'The Fixture Franchise', 2],
    ]);
    // Cover fan: the franchise's first ledger member with a poster (Movie Both) contributes.
    const franchise = groups.find((g) => g.key === '77001')!;
    expect(franchise.coverUrls).toEqual([`/api/posters/${movieBoth}`]);
    expect(franchise.imageUrl).toBeNull();
  });

  it('THE INVARIANT — a withheld member is excluded from the count; an all-withheld collection is absent', async () => {
    const c = await callerFor(hnetOnlyRoleId);
    const { groups } = await c.ledger.collectionGroups({ arrKind: 'radarr' });
    // Hops Charts (both members only in the withheld HOps library) does not exist for this caller.
    expect(groups.map((g) => [g.key, g.count])).toEqual([['77001', 1]]);
  });

  it('a kind with no collection members lists nothing', async () => {
    const c = await callerFor('admin');
    expect((await c.ledger.collectionGroups({ arrKind: 'sonarr' })).groups).toEqual([]);
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
