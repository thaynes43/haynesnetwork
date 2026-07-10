// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library router: the section VISIBILITY gate
// (disabled ⇒ FORBIDDEN; a role opted to read_only can list), the Plex-DIRECT read mapping (shows →
// poster-grid rows with a proxied poster URL), and the graceful degrade (an absent library ⇒ found:false).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
afterAll(async () => {
  await testDb.stop();
});

/** A k8plex stub with the two ytdl-sub libraries (titled like the real server) + shows. */
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
          },
          { ratingKey: '9002', title: 'Power Zone Endurance', childCount: 3, leafCount: 57 },
        ],
        '5': [{ ratingKey: '7001', title: 'Documentaries', thumb: '/library/metadata/7001/thumb/1' }],
      },
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
