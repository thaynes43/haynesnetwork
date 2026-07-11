// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library router: the section VISIBILITY gate
// (disabled ⇒ FORBIDDEN; a role opted to read_only can list), the Plex-DIRECT read mapping (shows →
// poster-grid rows with a proxied poster URL), and the graceful degrade (an absent library ⇒ found:false).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_PLEX_SERVER_IDS, SEEDED_ROLE_IDS } from '@hnet/db';
import { setRoleLibraries, upsertPlexLibraries } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type TestDb,
} from './helpers';
import { makeApiPlexStub } from './plex-stubs';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await bootMigratedDb();
  // ADR-047 (PLAN-028) — the k8plex ytdl-sub libraries are Plex libraries too: a caller sees Peloton/YouTube
  // only when their role can access the matching hayneskube library. Register the sections and grant the
  // Default role hayneskube-all so a non-admin `read_only` member can list them (admins are unrestricted).
  await upsertPlexLibraries({
    db: testDb.db,
    slug: 'hayneskube',
    libraries: [
      { sectionKey: '3', name: 'HOps Music', mediaType: 'artist' },
      { sectionKey: '4', name: 'HOps Peloton', mediaType: 'show' },
      { sectionKey: '5', name: 'HOps YT', mediaType: 'show' },
    ],
  });
  await setRoleLibraries({
    db: testDb.db,
    roleId: SEEDED_ROLE_IDS.default,
    libraryIds: [],
    allServerIds: [SEEDED_PLEX_SERVER_IDS.hayneskube],
    actorId: null,
  });
});
afterAll(async () => {
  await testDb.stop();
});

/** A k8plex stub with the two ytdl-sub libraries (titled like the real server) + shows + hierarchy. */
function ytdlsubBundle() {
  return makeApiPlexStub({
    hayneskube: {
      machineIdentifier: 'mid-kube',
      friends: [],
      serverSections: [],
      librarySections: [
        { key: '3', title: 'HOps Music', type: 'artist' },
        { key: '4', title: 'HOps Peloton', type: 'show' },
        { key: '5', title: 'HOps YT', type: 'show' },
      ],
      sectionContents: {
        '4': [
          {
            ratingKey: '9001',
            title: 'Bike Bootcamp',
            thumb: '/library/metadata/9001/thumb/1699',
            childCount: 4,
            leafCount: 128,
            summary: 'Clip in.',
          },
          { ratingKey: '9002', title: 'Power Zone Endurance', childCount: 3, leafCount: 57 },
        ],
        '5': [{ ratingKey: '7001', title: 'Documentaries', thumb: '/library/metadata/7001/thumb/1' }],
      },
      // DESIGN-017 D-09 — the drill-in hierarchy: Bike Bootcamp's seasons + one season's episodes.
      metadataChildren: {
        '9001': [
          { ratingKey: '9102', title: 'Season 45', type: 'season', index: 45, leafCount: 1 },
          {
            ratingKey: '9101',
            title: 'Season 30',
            type: 'season',
            index: 30,
            leafCount: 2,
            // PLAN-030 — the season's restored duration poster (surfaces as the season-row icon).
            thumb: '/library/metadata/9101/thumb/1700',
          },
        ],
        '9101': [
          {
            ratingKey: '9201',
            title: '2026-06-09 - 30 min Bootcamp',
            type: 'episode',
            index: 701,
            duration: 1_991_936,
            originallyAvailableAt: '2026-06-09',
            thumb: '/library/metadata/9201/thumb/1701',
          },
          { ratingKey: '9202', title: '2026-06-02 - 30 min Bootcamp', type: 'episode', index: 700 },
        ],
      },
      metadataSection: { '9001': '4', '9002': '4', '7001': '5', '9101': '4', '9102': '4' },
    },
  }).bundle;
}

describe('ytdlsub.list — visibility gate + Plex-direct mapping', () => {
  it('a caller whose ytdlsub section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    await expect(
      caller(makeCtx(testDb.db, sessionUser(member), undefined, ytdlsubBundle())).ytdlsub.list({
        library: 'peloton',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin lists Peloton shows mapped to poster-grid rows (proxied poster URL, null → fallback)', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const res = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, ytdlsubBundle()),
    ).ytdlsub.list({ library: 'peloton' });
    expect(res.found).toBe(true);
    expect(res.unavailable).toBe(false);
    expect(res.items.map((i) => [i.title, i.seasonCount, i.episodeCount])).toEqual([
      ['Bike Bootcamp', 4, 128],
      ['Power Zone Endurance', 3, 57],
    ]);
    // A show with a Plex thumb gets the AUTHED proxy URL (the raw thumb path is url-encoded, never leaked raw).
    expect(res.items[0]!.posterUrl).toBe(
      '/api/ytdlsub/poster?thumb=' + encodeURIComponent('/library/metadata/9001/thumb/1699'),
    );
    // A show with NO thumb → null → the MediaPoster KindIcon fallback tile.
    expect(res.items[1]!.posterUrl).toBeNull();
  });

  it('a member opted to read_only can list (server-authoritative visibility)', async () => {
    const member = await createUser(testDb.db);
    const res = await caller(
      makeCtx(testDb.db, sessionUser(member, { ytdlsub: 'read_only' }), undefined, ytdlsubBundle()),
    ).ytdlsub.list({ library: 'youtube' });
    expect(res.found).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.title).toBe('Documentaries');
  });

  it('an absent library degrades to found:false (never a crash)', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    // A k8plex with only Music — neither Peloton nor YouTube is present.
    const bundle = makeApiPlexStub({
      hayneskube: {
        machineIdentifier: 'mid-kube',
        friends: [],
        serverSections: [],
        librarySections: [{ key: '3', title: 'HOps Music', type: 'artist' }],
      },
    }).bundle;
    const res = await caller(makeCtx(testDb.db, sessionUser(admin), undefined, bundle)).ytdlsub.list({
      library: 'peloton',
    });
    expect(res).toEqual({ items: [], found: false, unavailable: false });
  });
});

// DESIGN-017 D-09 (R-132) — the read-only drill-in: seasons, lazy episodes, section confinement.
describe('ytdlsub.detail + ytdlsub.episodes — drill-in + confinement', () => {
  it('a caller whose ytdlsub section is DISABLED is FORBIDDEN', async () => {
    const member = await createUser(testDb.db);
    const ctx = makeCtx(testDb.db, sessionUser(member), undefined, ytdlsubBundle());
    await expect(
      caller(ctx).ytdlsub.detail({ library: 'peloton', ratingKey: '9001' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(ctx).ytdlsub.episodes({ library: 'peloton', seasonRatingKey: '9101' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('detail returns the show head + index-sorted seasons', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const res = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, ytdlsubBundle()),
    ).ytdlsub.detail({ library: 'peloton', ratingKey: '9001' });
    expect(res.found).toBe(true);
    expect(res.unavailable).toBe(false);
    expect(res.show).toMatchObject({
      ratingKey: '9001',
      title: 'Bike Bootcamp',
      summary: 'Clip in.',
      seasonCount: 4,
      episodeCount: 128,
    });
    expect(res.show!.posterUrl).toBe(
      '/api/ytdlsub/poster?thumb=' + encodeURIComponent('/library/metadata/9001/thumb/1699'),
    );
    // Seasons come back sorted by index even though the stub returns 45 before 30.
    expect(res.seasons.map((s) => [s.title, s.index, s.episodeCount])).toEqual([
      ['Season 30', 30, 2],
      ['Season 45', 45, 1],
    ]);
    // PLAN-030 — the season ROW carries its poster (grid variant) when Plex has season art; null otherwise.
    expect(res.seasons[0]!.posterUrl).toBe(
      '/api/ytdlsub/poster?thumb=' +
        encodeURIComponent('/library/metadata/9101/thumb/1700') +
        '&size=grid',
    );
    expect(res.seasons[1]!.posterUrl).toBeNull(); // Season 45 has no thumb ⇒ no icon
  });

  it('episodes maps title/index/air date/duration and builds `size=still` proxy URLs', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const res = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, ytdlsubBundle()),
    ).ytdlsub.episodes({ library: 'peloton', seasonRatingKey: '9101' });
    expect(res.found).toBe(true);
    expect(res.episodes.map((e) => [e.title, e.index, e.airDate, e.durationMs])).toEqual([
      ['2026-06-09 - 30 min Bootcamp', 701, '2026-06-09', 1_991_936],
      ['2026-06-02 - 30 min Bootcamp', 700, null, null],
    ]);
    expect(res.episodes[0]!.stillUrl).toBe(
      '/api/ytdlsub/poster?thumb=' +
        encodeURIComponent('/library/metadata/9201/thumb/1701') +
        '&size=still',
    );
    expect(res.episodes[1]!.stillUrl).toBeNull();
  });

  it('SECTION CONFINEMENT: a ratingKey from another library/section is found:false (never data)', async () => {
    const admin = await createUser(testDb.db, { admin: true });
    const ctx = makeCtx(testDb.db, sessionUser(admin), undefined, ytdlsubBundle());
    // 7001 lives in the YouTube section (5) — asking for it under Peloton must not leak it.
    const cross = await caller(ctx).ytdlsub.detail({ library: 'peloton', ratingKey: '7001' });
    expect(cross).toEqual({ found: false, unavailable: false, show: null, seasons: [] });
    // A season of a Peloton show is likewise invisible through the YouTube library.
    const crossEpisodes = await caller(ctx).ytdlsub.episodes({
      library: 'youtube',
      seasonRatingKey: '9101',
    });
    expect(crossEpisodes).toEqual({ found: false, unavailable: false, episodes: [] });
    // A bogus ratingKey is a clean not-found, never a throw.
    const bogus = await caller(ctx).ytdlsub.detail({ library: 'peloton', ratingKey: '424242' });
    expect(bogus.found).toBe(false);
  });
});

describe('ytdlsub.access + ytdlsub.libraries', () => {
  it('access reports visibility; libraries resolves both tabs with found flags', async () => {
    const member = await createUser(testDb.db);
    const admin = await createUser(testDb.db, { admin: true });

    expect(await caller(makeCtx(testDb.db, sessionUser(member))).ytdlsub.access()).toEqual({
      canSee: false,
    });
    expect(await caller(makeCtx(testDb.db, sessionUser(admin))).ytdlsub.access()).toEqual({
      canSee: true,
    });

    const libs = await caller(
      makeCtx(testDb.db, sessionUser(admin), undefined, ytdlsubBundle()),
    ).ytdlsub.libraries();
    expect(libs.libraries).toEqual([
      { id: 'peloton', label: 'Peloton', found: true },
      { id: 'youtube', label: 'YouTube', found: true },
    ]);
  });
});
