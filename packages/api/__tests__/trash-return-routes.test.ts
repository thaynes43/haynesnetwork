import {
  seedTrashRelease,
  unlinkExpiredTrashRelease,
  seedTrashDeletion,
  seedTrashBatchDeletion,
} from '../../domain/__tests__/trash-return-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledgerEvents, mediaItems, trashDeletedReleases, trashRestoreKeeps } from '@hnet/db/schema';
import {
  upsertMediaItemsBatch,
  trashHistoryIds,
  tombstoneMissingItems,
  ingestLedgerEvents,
  classifyGuardian,
  hasRestoreKeep,
} from '@hnet/domain';
import {
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
  deriveTerm,
  termMatchesRaw,
} from '../../domain/src/release-terms';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';
import { movieJson, seriesJson, stubArrBundle } from './arr-stubs';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => t?.stop());

async function deleted(kind: 'radarr' | 'sonarr', number: number) {
  const item = await seedMediaItem(t.db, kind, {
    arrItemId: number,
    tmdbId: number,
    tvdbId: number,
    title: `Deleted ${number}`,
    rootFolder: '/media',
    qualityProfileName: 'Any',
  });
  await tombstoneMissingItems({ db: t.db, arrKind: kind, seenArrItemIds: [] });
  const name = `Deleted.${number}.2024.1080p.BluRay-GROUP`;
  const term = deriveTerm({
    kind: kind === 'radarr' ? 'movie' : 'show',
    arrTitle: item.title,
    arrYears: [2024],
    releaseNames: [name],
    renamedFileName: null,
    releaseGroup: 'GROUP',
    resolution: 1080,
    remux: false,
  })!.term;
  await seedTrashRelease(t.db, {
    arrKind: kind,
    mediaItemId: item.id,
    tmdbId: number,
    tvdbId: number,
    title: item.title,
    year: 2024,
    identitySource: 'arr_grab_history',
    releaseTitle: name,
    term,
    state: 'active',
    origin: 'expedite',
    expiresAt: new Date(Date.now() + 86400000),
  });
  return { item, term, name };
}

function arrStub(kind: 'radarr' | 'sonarr', term: string, drift = false) {
  const resource = kind === 'radarr' ? 'movie' : 'series';
  return stubArrBundle([
    { path: `/api/v3/${resource}`, body: [] },
    { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
    { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/media' }] },
    { path: '/api/v3/tag', body: [] },
    {
      path: '/api/v3/releaseprofile',
      body: [
        {
          id: 1,
          name: RELEASE_BLOCK_PROFILE_NAME,
          enabled: true,
          required: [],
          ignored: [RELEASE_BLOCK_SENTINEL, ...(drift ? [] : [term]), 'older-term'],
          indexerId: 0,
          tags: [],
        },
      ],
    },
    {
      method: 'POST',
      path: `/api/v3/${resource}`,
      status: 201,
      body: kind === 'radarr' ? movieJson(90001) : seriesJson(90001),
    },
  ]);
}

describe('ADR-121 Trash return routes', () => {
  it('rejects a non-admin API call even with a stale Restore grant, before any external call', async () => {
    const user = await createUser(t.db);
    const stub = arrStub('radarr', 'unused');
    const api = caller(
      makeCtx(t.db, sessionUser(user, { trash: 'edit' }, ['restore_deleted']), stub.bundle),
    );
    await expect(
      api.trash.restoreDeleted({ media: 'movie', mediaItemId: user.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.trash.removeRestoreKeep({ mediaItemId: user.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it.each(['radarr', 'sonarr'] as const)(
    'admin Restore records a keep and leaves %s block terms and Title Exclusion untouched',
    async (kind) => {
      const admin = await createUser(t.db, { admin: true });
      const { item, term, name } = await deleted(kind, kind === 'radarr' ? 84001 : 84002);
      const stub = arrStub(kind, term);
      const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
      const result = await api.trash.restoreDeleted({
        media: kind === 'radarr' ? 'movie' : 'tv',
        mediaItemId: item.id,
      });
      expect(result.successCount).toBe(1);
      const [keep] = await t.db
        .select()
        .from(trashRestoreKeeps)
        .where(eq(trashRestoreKeeps.mediaItemId, item.id));
      expect(keep).toMatchObject({
        revokedAt: null,
        restoreRunId: result.runId,
        restoredBy: admin.id,
      });
      expect(stub.calls.filter((c) => c.method !== 'GET').map((c) => c.url.pathname)).toEqual([
        kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series',
      ]);
      const add = stub.calls.find((c) => c.method === 'POST')!;
      expect(add.body).toMatchObject({
        monitored: true,
        addOptions:
          kind === 'radarr' ? { searchForMovie: false } : { searchForMissingEpisodes: false },
      });
      const [record] = await t.db
        .select()
        .from(trashDeletedReleases)
        .where(eq(trashDeletedReleases.mediaItemId, item.id));
      expect(record!.term).toBe(term);
      expect(record!.state).toBe('active');
      // The same unchanged ignored term rejects the posted name for RSS and native searches.
      expect(termMatchesRaw(term, name)).toBe(true);
      expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
      expect(stub.callsFor('DELETE', '/api/v3/importlistexclusion')).toHaveLength(0);
      expect(
        (
          await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, item.id))
        ).filter((e) => e.eventType === 'trash_restored'),
      ).toHaveLength(1);
      await api.trash.removeRestoreKeep({ mediaItemId: item.id });
      expect(
        (
          await t.db
            .select()
            .from(trashRestoreKeeps)
            .where(eq(trashRestoreKeeps.mediaItemId, item.id))
        )[0]!.revokedAt,
      ).not.toBeNull();
    },
  );

  it.each(['block', 'profile'] as const)(
    'a refused %s pre-check creates no keep and no success marker',
    async (reason) => {
      const admin = await createUser(t.db, { admin: true });
      const { item, term } = await deleted('radarr', reason === 'block' ? 84003 : 84010);
      const stub = arrStub('radarr', term, reason === 'block');
      if (reason === 'profile') stub.bundle.read.radarr.listQualityProfiles = async () => [];
      const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
      const result = await api.trash.restoreDeleted({ media: 'movie', mediaItemId: item.id });
      expect(result.successCount).toBe(0);
      expect(stub.callsFor('POST', '/api/v3/movie')).toHaveLength(0);
      expect(
        await t.db
          .select()
          .from(trashRestoreKeeps)
          .where(eq(trashRestoreKeeps.mediaItemId, item.id)),
      ).toHaveLength(0);
      expect(
        (
          await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, item.id))
        ).filter((e) => e.eventType === 'trash_restored'),
      ).toHaveLength(0);
    },
  );

  it('keeps an uncertain add attempt, with the keep already committed before the call', async () => {
    const admin = await createUser(t.db, { admin: true });
    const { item, term } = await deleted('radarr', 84011);
    const stub = arrStub('radarr', term);
    let keptBeforeCall = false;
    stub.bundle.write.radarr.addMovie = async () => {
      keptBeforeCall = await hasRestoreKeep(t.db, item.id);
      throw new Error('add response unavailable');
    };
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
    const result = await api.trash.restoreDeleted({ media: 'movie', mediaItemId: item.id });
    expect(result.successCount).toBe(0);
    expect(keptBeforeCall).toBe(true);
    expect(await hasRestoreKeep(t.db, item.id)).toBe(true);
    expect(
      (await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, item.id))).filter(
        (e) => e.eventType === 'trash_restored',
      ),
    ).toHaveLength(0);
  });

  it('both bulk APIs exclude Trash by external identity or deletion audit and persist counts/titles in reports', async () => {
    const admin = await createUser(t.db, { admin: true });
    const { item } = await deleted('radarr', 84004);
    // Even an unlinked, expired record still excludes the title.
    await unlinkExpiredTrashRelease(t.db, item.id);
    const other = await seedMediaItem(t.db, 'radarr', {
      arrItemId: 84005,
      tmdbId: 84005,
      title: 'Trash audit only',
    });
    await seedTrashDeletion(t.db, other.id);
    const batched = await seedMediaItem(t.db, 'radarr', {
      arrItemId: 84007,
      tmdbId: 84007,
      title: 'Batch deletion only',
    });
    await seedTrashBatchDeletion(t.db, batched.id, batched.title, batched.tmdbId!);
    const stub = arrStub('radarr', 'unused');
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
    const diff = await api.restore.diff({ arrKind: 'radarr' });
    expect(diff.items.some((i) => i.mediaItemId === item.id || i.mediaItemId === other.id)).toBe(
      false,
    );
    expect(diff.skippedTrash.map((i) => i.mediaItemId)).toEqual(
      expect.arrayContaining([item.id, other.id, batched.id]),
    );
    expect(diff.skippedTrashCount).toBe(diff.skippedTrash.length);
    for (const result of [
      await api.ledgerAdmin.bulkAddAndSearch({
        arrKind: 'radarr',
        mediaItemIds: [item.id, other.id, batched.id],
      }),
      await api.restore.execute({
        arrKind: 'radarr',
        mediaItemIds: [item.id, other.id, batched.id],
      }),
    ]) {
      expect(result.skippedTrashCount).toBe(3);
      expect(result.skippedTrash.map((i) => i.title)).toEqual([
        item.title,
        other.title,
        batched.title,
      ]);
      const run = await t.db.query.restoreRuns.findFirst({
        where: (r, { eq }) => eq(r.id, result.runId),
      });
      expect(run!.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mediaItemId: item.id,
            title: item.title,
            skipReason: 'trash_deleted',
            ok: false,
          }),
        ]),
      );
    }
    expect(stub.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('bulk skips a present unmonitored Trash title, with searches on or off', async () => {
    const admin = await createUser(t.db, { admin: true });
    const item = await seedMediaItem(t.db, 'radarr', {
      arrItemId: 84008,
      tmdbId: 84008,
      monitored: false,
      title: 'Unmonitored Trash',
    });
    await seedTrashDeletion(t.db, item.id);
    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [movieJson(84008, { tmdbId: 84008, monitored: false })] },
    ]);
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
    for (const searchOnAdd of [false, true]) {
      const result = await api.ledgerAdmin.bulkAddAndSearch({
        arrKind: 'radarr',
        mediaItemIds: [item.id],
        searchOnAdd,
      });
      expect(result.skippedTrash).toEqual([{ mediaItemId: item.id, title: item.title }]);
    }
    expect(
      (await api.restore.execute({ arrKind: 'radarr', mediaItemIds: [item.id] })).skippedTrashCount,
    ).toBe(1);
    expect(stub.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('rechecks Trash history after target reads, before a bulk add', async () => {
    const admin = await createUser(t.db, { admin: true });
    const item = await seedMediaItem(t.db, 'radarr', {
      arrItemId: 84009,
      tmdbId: 84009,
      title: 'New Trash history',
      rootFolder: '/media',
    });
    const stub = arrStub('radarr', 'unused');
    const readProfiles = stub.bundle.read.radarr.listQualityProfiles.bind(stub.bundle.read.radarr);
    stub.bundle.read.radarr.listQualityProfiles = async () => {
      await seedTrashDeletion(t.db, item.id);
      return readProfiles();
    };
    const api = caller(makeCtx(t.db, sessionUser(admin), stub.bundle));
    const result = await api.ledgerAdmin.bulkAddAndSearch({
      arrKind: 'radarr',
      mediaItemIds: [item.id],
    });
    expect(result.skippedTrash).toEqual([{ mediaItemId: item.id, title: item.title }]);
    expect(stub.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it.each(['radarr', 'sonarr'] as const)(
    'a Seerr %s request event and tagged sync bypass bulk history exclusion', async (kind) => {
    const { item } = await deleted(kind, kind === 'radarr' ? 84006 : 84007);
    await ingestLedgerEvents({
      db: t.db,
      source: 'seerr',
      events: [
        {
          eventType: 'requested',
          source: 'seerr',
          sourceEventId: `843-request-${kind}`,
          occurredAt: new Date(),
          payload: { mediaType: kind === 'radarr' ? 'movie' : 'tv', tmdbId: item.tmdbId,
              tvdbId: item.tvdbId,
            },
        },
      ],
      cursor: new Date(),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: kind,
      items: [
        {
          arrItemId: 94006,
          tmdbId: item.tmdbId ?? undefined,
            tvdbId: item.tvdbId ?? undefined,
          title: item.title,
          sortTitle: item.sortTitle,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/media',
          arrTags: ['mediarequests'],
        },
      ],
    });
    const [synced] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, item.id));
    expect(
      (
        await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.sourceEventId, `843-request-${kind}`))
      )[0],
    ).toMatchObject({ eventType: 'requested' });
    expect(
      classifyGuardian({
        mediaItemId: item.id,
        saveIntent: false,
        protectedByTag: false,
        recentlyWatched: false,
        onWatchlist: false,
        watchlistEvaluable: true,
        ruleEvaluationFailed: false,
        ageGuard: 'clear',
        arrTags: synced!.arrTags,
      }),
    ).toEqual({ keep: true, reason: 'media_request' });
    expect(synced).toMatchObject({
      arrItemId: 94006,
      deletedFromArrAt: null,
      arrTags: ['mediarequests'],
    });
    expect((await trashHistoryIds(t.db, [item.id])).has(item.id)).toBe(true);
    expect(
      await t.db.select().from(trashRestoreKeeps).where(eq(trashRestoreKeeps.mediaItemId, item.id)),
    ).toHaveLength(0);
  });
});
