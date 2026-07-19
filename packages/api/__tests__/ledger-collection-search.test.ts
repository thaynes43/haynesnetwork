// ADR-071 owner ruling 2026-07-19 — the BULK "Search Missing" for a movies/TV collection
// (ledger.forceSearchCollection): resolve the collection's still-missing members (held=false ∩
// monitored, not-on-disk, live) under the access gate, then fan out the shipped per-item *arr Force
// Search over them, capped. Gating is EXACTLY the per-item path (PR #375): authed + the shared hourly
// budget (admins bypass), NO grant; audit is one 'search_requested' ledger event per member.
// Seeded exclusively through the domain single-writers (guard-scanned file).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ledgerEvents, plexLibraries, SEEDED_PLEX_SERVER_IDS, type Database } from '@hnet/db';
import {
  forceSearchArrCollection,
  syncPlexCollections,
  syncPlexMatches,
  upsertPlexLibraries,
} from '@hnet/domain';
import { movieJson, stubArrBundle, type ArrStubRoute } from './arr-stubs';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';

async function libIdOf(db: Database, sectionKey: string) {
  const [row] = await db
    .select({ id: plexLibraries.id })
    .from(plexLibraries)
    .where(
      and(
        eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynesops),
        eq(plexLibraries.sectionKey, sectionKey),
      ),
    );
  if (!row) throw new Error(`library haynesops:${sectionKey} not seeded`);
  return row.id;
}

/** POST /command → the *arr search command ack (radarr MoviesSearch). */
const commandRoutes: ArrStubRoute[] = [
  { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 9001, name: 'MoviesSearch' } },
  // The movie lookup a search may touch — harmless if unused.
  { path: new RegExp('^/api/v3/movie/\\d+$'), body: movieJson(1) },
];

let t: TestDb;
let moviesLib: string;
let held: string;
let wanted1: string;
let wanted2: string;
let wanted3: string;
let notMonitored: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  moviesLib = await libIdOf(t.db, '1');

  held = (await seedMediaItem(t.db, 'radarr', { title: 'Held', onDiskFileCount: 1 })).id;
  wanted1 = (await seedMediaItem(t.db, 'radarr', { title: 'Wanted One', onDiskFileCount: 0 })).id;
  wanted2 = (await seedMediaItem(t.db, 'radarr', { title: 'Wanted Two', onDiskFileCount: 0 })).id;
  wanted3 = (await seedMediaItem(t.db, 'radarr', { title: 'Wanted Three', onDiskFileCount: 0 })).id;
  // Monitored-off, 0 on disk — a held=false member that is NOT "Wanted" (nobody is searching for it).
  notMonitored = (
    await seedMediaItem(t.db, 'radarr', { title: 'Unmonitored', onDiskFileCount: 0, monitored: false })
  ).id;

  await syncPlexMatches({
    db: t.db,
    matches: [{ mediaItemId: held, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' }],
    scopedLibraryIds: [moviesLib],
  });

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
        wantedMemberIds: [wanted1, wanted2, wanted3, notMonitored],
        wantedResolved: true,
      },
    ],
    scopedLibraryIds: [moviesLib],
  });
});

afterAll(async () => {
  await t?.stop();
});

async function searchEventsFor(ids: string[]) {
  const rows = await t.db
    .select({ mediaItemId: ledgerEvents.mediaItemId, eventType: ledgerEvents.eventType })
    .from(ledgerEvents);
  return rows.filter((r) => r.eventType === 'search_requested' && ids.includes(r.mediaItemId));
}

describe('ledger.forceSearchCollection — bulk movies/TV collection Force Search', () => {
  it('force-searches ONLY the wanted (monitored, not-on-disk) members, audits each, and excludes held/unmonitored', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubArrBundle(commandRoutes);
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));

    const res = await api.ledger.forceSearchCollection({ ratingKey: '88001', arrKind: 'radarr' });

    // The three Wanted members were searched; the held + unmonitored members were not.
    expect(res).toMatchObject({ ok: true, candidates: 3, searched: 3, failed: 0, rateLimited: false });
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(3);

    // One 'search_requested' audit event per searched Wanted member (single-writer, hard rule 6).
    const events = await searchEventsFor([wanted1, wanted2, wanted3]);
    expect(events).toHaveLength(3);
    // The held + unmonitored members were never touched.
    const excluded = await searchEventsFor([held, notMonitored]);
    expect(excluded).toHaveLength(0);
  });

  it('is access-gated (THE INVARIANT): a member with no library access resolves ZERO members — cannot bulk-search a hidden collection', async () => {
    const member = await createUser(t.db); // non-admin, default role, no library grants
    const stub = stubArrBundle(commandRoutes);
    const api = caller(makeCtx(t.db, sessionUser(member), stub.bundle));

    // The mutation runs (authed, NO force-search grant needed — unlike books), but the member can see
    // none of these libraries, so the gated member resolution returns nothing and no *arr call fires.
    const res = await api.ledger.forceSearchCollection({ ratingKey: '88001', arrKind: 'radarr' });
    expect(res).toMatchObject({ ok: true, candidates: 0, searched: 0 });
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
  });

  it('an unknown collection resolves zero members (no-op, no calls)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubArrBundle(commandRoutes);
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
    const res = await api.ledger.forceSearchCollection({ ratingKey: 'nope', arrKind: 'radarr' });
    expect(res).toMatchObject({ candidates: 0, searched: 0 });
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
  });

  it('the per-call CAP bounds the fan-out (domain leg)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubArrBundle(commandRoutes);
    // Three candidates, cap 2 → only two searched; candidates still reports the full set.
    const report = await forceSearchArrCollection({
      db: t.db,
      arr: stub.bundle,
      requesterId: admin.id,
      requesterIsAdmin: true,
      mediaItemIds: [wanted1, wanted2, wanted3],
      cap: 2,
    });
    expect(report).toMatchObject({ candidates: 3, searched: 2, cap: 2 });
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(2);
  });
});
