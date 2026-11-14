// Regressions from the first adversarial review; synthetic PostgreSQL data and stub clients only.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, releasePickLists } from '@hnet/db';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import { seedTrashRelease } from './trash-return-fixtures';
import { movieJson, seriesJson, stubArrBundle } from '../../api/__tests__/arr-stubs';
import {
  grabFromReleaseList,
  restoreDeleted,
  RELEASE_REASONS_VERSION,
  setRepairGuideRemedies,
  upsertMediaItemsBatch,
} from '../src/index';
import {
  deriveTerm,
  termMatchesRaw,
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
} from '../src/release-terms';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
it.each(['radarr', 'sonarr'] as const)(
  'refuses a cached %s offer after restore and invalidates the durable list',
  async (kind) => {
    const user = await createUser(t.db);
    await setRepairGuideRemedies({ db: t.db, remedies: { release_pick: true }, actorId: null });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: kind,
      items: [
        {
          arrItemId: 75001,
          tmdbId: 75001,
          tvdbId: 75001,
          title: 'Synthetic Movie',
          sortTitle: 'synthetic movie',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/media',
        },
      ],
    });
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.arrKind, kind));
    const name =
      kind === 'radarr'
        ? 'Synthetic.Movie.2024.1080p.BluRay-GROUP'
        : 'Synthetic.Movie.S01E01.1080p.BluRay-GROUP';
    const term = deriveTerm({
      kind: kind === 'radarr' ? 'movie' : 'show',
      arrTitle: item!.title,
      arrYears: [2024],
      releaseNames: [name],
      renamedFileName: null,
      releaseGroup: 'GROUP',
      resolution: 1080,
      remux: false,
      season: 1,
    })!.term;
    // Durable, unspent offer made before Trash installed the term, still inside the grab window.
    const [list] = await t.db
      .insert(releasePickLists)
      .values({
        requesterId: user.id,
        mediaItemId: item!.id,
        arrKind: kind,
        ...(kind === 'sonarr' ? { targetChildId: 1, seasonNumber: 1 } : {}),
        targetLabel: item!.title,
        searchedAt: new Date(),
        reasonsVersion: RELEASE_REASONS_VERSION,
        offers: [
          {
            key: 'synthetic-offer',
            guid: 'synthetic-guid',
            indexerId: 1,
            title: name,
            state: 'override',
            overrideBody: true,
            quality: { quality: { id: 7, name: 'Bluray-1080p' } },
            languages: [{ id: 1, name: 'English' }],
            reasonCodes: ['quality_not_wanted'],
            titleVerdict: 'agrees',
            numberedAs: null,
            episodeIds: null,
            holds: null,
          },
        ],
      })
      .returning();
    await seedTrashRelease(t.db, {
      arrKind: kind,
      mediaItemId: item!.id,
      tmdbId: 75001,
      tvdbId: 75001,
      title: item!.title,
      identitySource: 'arr_grab_history',
      releaseTitle: name,
      term,
      state: 'active',
      origin: 'sweep',
      expiresAt: new Date(Date.now() + 86400000),
    });
    const profile = {
      id: 1,
      name: RELEASE_BLOCK_PROFILE_NAME,
      enabled: true,
      required: [],
      ignored: [RELEASE_BLOCK_SENTINEL, term],
      indexerId: 0,
      tags: [],
    };
    const stub = stubArrBundle([
      { path: kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series', body: [] },
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/media' }] },
      { path: '/api/v3/tag', body: [] },
      { path: '/api/v3/releaseprofile', body: [profile] },
      {
        method: 'POST',
        path: kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series',
        status: 201,
        body:
          kind === 'radarr'
            ? movieJson(75002, { tmdbId: 75001, hasFile: false })
            : seriesJson(75002, { tvdbId: 75001 }),
      },
      {
        path: kind === 'radarr' ? '/api/v3/movie/75002' : '/api/v3/series/75002',
        body:
          kind === 'radarr'
            ? movieJson(75002, { tmdbId: 75001, hasFile: false })
            : seriesJson(75002, { tvdbId: 75001 }),
      },
      { path: '/api/v3/queue', body: { page: 1, pageSize: 100, totalRecords: 0, records: [] } },
      { method: 'POST', path: '/api/v3/release', body: {} },
    ]);
    const restored = await restoreDeleted({
      db: t.db,
      arr: stub.bundle,
      arrKind: kind,
      mediaItemId: item!.id,
      actorId: user.id,
    });
    expect(restored.successCount).toBe(1);
    expect(termMatchesRaw(term, name)).toBe(true);
    expect(
      (await t.db.select().from(mediaItems).where(eq(mediaItems.id, item!.id)))[0]!.arrItemId,
    ).toBe(75002);
    expect(
      (await t.db.select().from(releasePickLists).where(eq(releasePickLists.id, list!.id)))[0]!
        .offers,
    ).toEqual([]);
    const picked = await grabFromReleaseList({
      db: t.db,
      arr: stub.bundle,
      listId: list!.id,
      key: 'synthetic-offer',
      requesterId: user.id,
    });
    expect.soft(picked.outcome).not.toBe('grabbed');
    expect(stub.callsFor('POST', '/api/v3/release')).toHaveLength(0);
  },
);

it.each(['radarr', 'sonarr'] as const)(
  'checks current %s terms on both plain and override grabs, while allowing a different release',
  async (kind) => {
    const profile = {
      id: 1,
      name: RELEASE_BLOCK_PROFILE_NAME,
      enabled: true,
      required: [],
      ignored: [RELEASE_BLOCK_SENTINEL, '/Synthetic[ .]Blocked/i'],
      indexerId: 0,
      tags: [],
    };
    const stub = stubArrBundle([
      { path: '/api/v3/releaseprofile', body: [profile] },
      { method: 'POST', path: '/api/v3/release', body: {} },
    ]);
    const plain = { guid: 'synthetic-guid', indexerId: 1 };
    await expect(
      stub.bundle.write[kind].grabRelease(plain, 'Synthetic.Blocked.1080p-GROUP'),
    ).rejects.toThrow('already grabbed');
    if (kind === 'sonarr')
      await expect(
        stub.bundle.write.sonarr.grabRelease(
          {
            ...plain,
            seriesId: 1,
            episodeIds: [1],
            quality: {},
            languages: [],
            downloadClientId: null,
            shouldOverride: true,
          },
          'Synthetic.Blocked.1080p-GROUP',
        ),
      ).rejects.toThrow('already grabbed');
    else
      await expect(
        stub.bundle.write.radarr.grabRelease(
          {
            ...plain,
            movieId: 1,
            quality: {},
            languages: [],
            downloadClientId: null,
            shouldOverride: true,
          },
          'Synthetic.Blocked.1080p-GROUP',
        ),
      ).rejects.toThrow('already grabbed');
    expect(stub.callsFor('POST', '/api/v3/release')).toHaveLength(0);
    await stub.bundle.write[kind].grabRelease(plain, 'Synthetic.Different.1080p-GROUP');
    expect(stub.callsFor('POST', '/api/v3/release')).toHaveLength(1);
    expect(stub.calls.slice(-2).map((c) => c.url.pathname)).toEqual([
      '/api/v3/releaseprofile',
      '/api/v3/release',
    ]);
  },
);
