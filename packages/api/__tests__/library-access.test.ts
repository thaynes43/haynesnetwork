// ADR-047 / DESIGN-025 (PLAN-028) — THE INVARIANT, proven end-to-end through the real ledger router:
// a role lacking a Plex library's grant receives ZERO items from that library across search / detail /
// filterFacets / wanted, and via the poster proxy. Admin (unrestricted) sees everything; a role with a
// server-all grant sees the whole server. Matched items gate on their exact library; unmatched (missing)
// items gate on their kind's HOME library — hidden ONLY by access, never by match state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { plexLibraries, users, SEEDED_PLEX_SERVER_IDS, type Database } from '@hnet/db';
import {
  assignRole,
  createRole,
  setRoleLibraries,
  syncPlexMatches,
  upsertPlexLibraries,
} from '@hnet/domain';
import {
  isMediaItemAccessibleToUser,
  resolveArtMatchForItem,
  resolveLibraryAccessGate,
} from '../src/library-access';
import { accessibleYtdlsubLibraries } from '../src/routers/ytdlsub';
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
let moviesLib: string;
let hopsMoviesLib: string; // a SECOND movie library (mirror) — for the multi-library button test
let tvLib: string;
let pelotonLib: string;
let bothMoviesRoleId: string;
// media_items
let movieA: string;
let movieMissing: string; // present in the *arr but on-disk 0 (unmatched — no Plex match)
let showA: string;
// roles
let moviesOnlyRoleId: string;
let tvOnlyRoleId: string;
let noGrantsRoleId: string;
let serverAllRoleId: string;

beforeAll(async () => {
  t = await bootMigratedDb();

  // Libraries: Movies + TV on haynestower, Peloton on hayneskube (ytdl-sub gating).
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [
      { sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' },
      { sectionKey: '2', name: 'HNet TV', mediaType: 'show' },
    ],
  });
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynesops',
    libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
  });
  await upsertPlexLibraries({
    db: t.db,
    slug: 'hayneskube',
    libraries: [{ sectionKey: '4', name: 'HOps Peloton', mediaType: 'show' }],
  });
  moviesLib = await libIdOf(t.db, 'haynestower', '1');
  hopsMoviesLib = await libIdOf(t.db, 'haynesops', '1');
  tvLib = await libIdOf(t.db, 'haynestower', '2');
  pelotonLib = await libIdOf(t.db, 'hayneskube', '4');

  // Ledger items: two present movies, one MISSING movie (unmatched), one present show.
  movieA = (await seedMediaItem(t.db, 'radarr', { title: 'Movie A', onDiskFileCount: 1 })).id;
  const movieB = (await seedMediaItem(t.db, 'radarr', { title: 'Movie B', onDiskFileCount: 1 })).id;
  movieMissing = (
    await seedMediaItem(t.db, 'radarr', {
      title: 'Movie Missing',
      onDiskFileCount: 0,
      expectedFileCount: 1,
    })
  ).id;
  showA = (await seedMediaItem(t.db, 'sonarr', { title: 'Show A', onDiskFileCount: 1 })).id;

  // Matches: both present movies → Movies lib; the show → TV lib. Movie Missing stays UNMATCHED (so its
  // gating flows through the radarr HOME library = Movies). Establishes home(radarr)=Movies, home(sonarr)=TV.
  await syncPlexMatches({
    db: t.db,
    matches: [
      // Movie A is MIRRORED in two libraries (HNet Movies + HOps Movies) — one button per accessible one.
      { mediaItemId: movieA, plexLibraryId: moviesLib, ratingKey: '9001', matchedVia: 'tmdb' },
      { mediaItemId: movieA, plexLibraryId: hopsMoviesLib, ratingKey: '5001', matchedVia: 'tmdb' },
      { mediaItemId: movieB, plexLibraryId: moviesLib, ratingKey: '9002', matchedVia: 'tmdb' },
      { mediaItemId: showA, plexLibraryId: tvLib, ratingKey: '7001', matchedVia: 'tvdb' },
    ],
    scopedLibraryIds: [moviesLib, hopsMoviesLib, tvLib],
  });

  // Roles.
  moviesOnlyRoleId = (await createRole({ db: t.db, name: 'movies-only', actorId: null })).roleId;
  await setRoleLibraries({ db: t.db, roleId: moviesOnlyRoleId, libraryIds: [moviesLib], actorId: null });
  tvOnlyRoleId = (await createRole({ db: t.db, name: 'tv-only', actorId: null })).roleId;
  await setRoleLibraries({ db: t.db, roleId: tvOnlyRoleId, libraryIds: [tvLib], actorId: null });
  noGrantsRoleId = (await createRole({ db: t.db, name: 'no-grants', actorId: null })).roleId;
  bothMoviesRoleId = (await createRole({ db: t.db, name: 'both-movies', actorId: null })).roleId;
  await setRoleLibraries({
    db: t.db,
    roleId: bothMoviesRoleId,
    libraryIds: [moviesLib, hopsMoviesLib],
    actorId: null,
  });
  serverAllRoleId = (await createRole({ db: t.db, name: 'server-all', actorId: null })).roleId;
  await setRoleLibraries({
    db: t.db,
    roleId: serverAllRoleId,
    libraryIds: [],
    allServerIds: [SEEDED_PLEX_SERVER_IDS.haynestower],
    actorId: null,
  });
});

afterAll(async () => {
  await t?.stop();
});

/** Make an authed caller for a fresh user assigned `roleId` (null ⇒ default; 'admin' ⇒ admin). */
async function callerFor(roleId: string | 'admin' | null) {
  const user =
    roleId === 'admin'
      ? await createUser(t.db, { admin: true })
      : await createUser(t.db);
  if (roleId !== null && roleId !== 'admin') {
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
  }
  const [fresh] = await t.db.select().from(users).where(eq(users.id, user.id));
  return { userId: user.id, c: caller(makeCtx(t.db, sessionUser(fresh!))) };
}

describe('THE INVARIANT — ledger.search is filtered to accessible libraries (ADR-047)', () => {
  it('movies-only role: Movies tab lists movies; TV tab returns ZERO (withheld library)', async () => {
    const { c } = await callerFor(moviesOnlyRoleId);
    const movies = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any' });
    // Both present movies + the missing (unmatched) movie — all gated via the radarr HOME library (Movies).
    expect(movies.items.map((i) => i.title).sort()).toEqual(['Movie A', 'Movie B', 'Movie Missing']);
    const tv = await c.ledger.search({ arrKind: 'sonarr', onDisk: 'any' });
    expect(tv.items).toHaveLength(0); // TV library withheld ⇒ zero items
    // Unfiltered search returns ONLY the accessible (radarr) items — the show never appears.
    const all = await c.ledger.search({ onDisk: 'any' });
    expect(all.items.some((i) => i.arrKind === 'sonarr')).toBe(false);
    expect(all.items).toHaveLength(3);
  });

  it('tv-only role: TV lists the show; Movies (incl. the unmatched missing movie) return ZERO', async () => {
    const { c } = await callerFor(tvOnlyRoleId);
    const tv = await c.ledger.search({ arrKind: 'sonarr', onDisk: 'any' });
    expect(tv.items.map((i) => i.title)).toEqual(['Show A']);
    const movies = await c.ledger.search({ arrKind: 'radarr', onDisk: 'any' });
    expect(movies.items).toHaveLength(0); // Movies withheld — even the unmatched missing movie is hidden
  });

  it('no-grants role: sees ZERO items of any kind', async () => {
    const { c } = await callerFor(noGrantsRoleId);
    expect((await c.ledger.search({ onDisk: 'any' })).items).toHaveLength(0);
    expect((await c.ledger.search({ arrKind: 'radarr', onDisk: 'any' })).items).toHaveLength(0);
    expect((await c.ledger.search({ arrKind: 'sonarr', onDisk: 'any' })).items).toHaveLength(0);
  });

  it('server-all grant (haynestower): sees BOTH libraries (movies + TV)', async () => {
    const { c } = await callerFor(serverAllRoleId);
    const all = await c.ledger.search({ onDisk: 'any' });
    expect(all.items).toHaveLength(4); // 2 present movies + missing movie + the show
    expect(new Set(all.items.map((i) => i.arrKind))).toEqual(new Set(['radarr', 'sonarr']));
  });

  it('admin (unrestricted): sees every item', async () => {
    const { c } = await callerFor('admin');
    expect((await c.ledger.search({ onDisk: 'any' })).items).toHaveLength(4);
  });
});

describe('THE INVARIANT — detail / wanted / poster proxy re-gate by direct id (ADR-047)', () => {
  it('detail of a withheld item is NOT_FOUND; an accessible present item carries ONE button per accessible library', async () => {
    const { c } = await callerFor(moviesOnlyRoleId);
    await expect(c.ledger.detail({ id: showA })).rejects.toBeInstanceOf(TRPCError);
    const detail = await c.ledger.detail({ id: movieA });
    // Movie A is mirrored in HNet Movies + HOps Movies; this role only accesses HNet Movies → 1 button.
    expect(detail.item.play).toHaveLength(1);
    expect(detail.item.play[0]!.app).toBe('plex');
    expect(detail.item.play[0]!.libraryName).toBe('HNet Movies');
    expect(detail.item.play[0]!.label).toBe('Watch on Plex — HNet Movies');
    expect(detail.item.play[0]!.url).toContain('app.plex.tv');
    expect(detail.item.play[0]!.url).toContain('metadata%2F9001');
  });

  it('one button PER accessible library — a role granted both movie libraries gets two buttons', async () => {
    const { c } = await callerFor(bothMoviesRoleId);
    const detail = await c.ledger.detail({ id: movieA });
    expect(detail.item.play.map((p) => p.libraryName).sort()).toEqual(['HNet Movies', 'HOps Movies']);
  });

  it('a PRESENT-but-unmatched movie has no play link (matched-only deep link)', async () => {
    const { c } = await callerFor(moviesOnlyRoleId);
    const detail = await c.ledger.detail({ id: movieMissing });
    // Movie Missing is on-disk 0 → not present → no play link even though its kind is accessible.
    expect(detail.item.play).toHaveLength(0);
  });

  it('wanted view is gated: tv-only sees the missing radarr item nowhere', async () => {
    const tv = await callerFor(tvOnlyRoleId);
    const wanted = await tv.c.ledger.wanted({});
    expect(wanted.items.some((i) => i.arrKind === 'radarr')).toBe(false);
  });

  it('poster proxy access matches the tRPC gate', async () => {
    const movies = await callerFor(moviesOnlyRoleId);
    expect(await isMediaItemAccessibleToUser(movies.userId, movieA, t.db)).toBe(true);
    expect(await isMediaItemAccessibleToUser(movies.userId, showA, t.db)).toBe(false); // TV withheld
    const tv = await callerFor(tvOnlyRoleId);
    expect(await isMediaItemAccessibleToUser(tv.userId, showA, t.db)).toBe(true);
    expect(await isMediaItemAccessibleToUser(tv.userId, movieA, t.db)).toBe(false);
  });
});

describe('PLAN-030 (ADR-048) — the season/episode ART source is gated exactly like the item', () => {
  it('resolveArtMatchForItem returns the matched Plex server+ratingKey for an accessible show, null for a withheld one', async () => {
    // Admin (unrestricted) resolves the show's matched art source (haynestower TV, ratingKey 7001).
    const admin = await createUser(t.db, { admin: true });
    const adminGate = await resolveLibraryAccessGate(admin.id, t.db);
    expect(await resolveArtMatchForItem(t.db, adminGate, showA)).toEqual({
      serverSlug: 'haynestower',
      ratingKey: '7001',
    });

    // A TV-granted role resolves the same source — art comes from a library the role CAN access.
    const tv = await callerFor(tvOnlyRoleId);
    const tvGate = await resolveLibraryAccessGate(tv.userId, t.db);
    expect(await resolveArtMatchForItem(t.db, tvGate, showA)).toEqual({
      serverSlug: 'haynestower',
      ratingKey: '7001',
    });

    // THE INVARIANT — a movies-only role can access NONE of the show's libraries ⇒ NO art source (null),
    // so its season rows show no icon and no episode-still fetch can resolve a Plex thumb for it.
    const movies = await callerFor(moviesOnlyRoleId);
    const moviesGate = await resolveLibraryAccessGate(movies.userId, t.db);
    expect(await resolveArtMatchForItem(t.db, moviesGate, showA)).toBeNull();

    // An unmatched item (present in the *arr, not yet in Plex) has no art source even for admin.
    expect(await resolveArtMatchForItem(t.db, adminGate, movieMissing)).toBeNull();
  });
});

describe('THE INVARIANT — ytdl-sub per-library gate (ADR-047)', () => {
  it('a role granted Peloton (hayneskube) sees peloton but not youtube; admin sees both', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'peloton-only', actorId: null });
    await setRoleLibraries({ db: t.db, roleId, libraryIds: [pelotonLib], actorId: null });
    const user = await createUser(t.db);
    await assignRole({ db: t.db, userId: user.id, toRoleId: roleId, initiator: { id: null, kind: 'system' } });
    const allowed = await accessibleYtdlsubLibraries(user.id, false, t.db);
    expect([...allowed]).toEqual(['peloton']);

    const admin = await createUser(t.db, { admin: true });
    const adminAllowed = await accessibleYtdlsubLibraries(admin.id, true, t.db);
    expect(adminAllowed.has('peloton')).toBe(true);
    expect(adminAllowed.has('youtube')).toBe(true);

    // A role with no library grants sees neither.
    const none = await createUser(t.db);
    await assignRole({
      db: t.db,
      userId: none.id,
      toRoleId: noGrantsRoleId,
      initiator: { id: null, kind: 'system' },
    });
    expect((await accessibleYtdlsubLibraries(none.id, false, t.db)).size).toBe(0);
  });
});
