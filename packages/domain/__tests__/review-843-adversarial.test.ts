// Regressions from the first adversarial review; synthetic PostgreSQL data and stub clients only.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { releasePickLists, mediaItems, trashBatchItems, trashBatches, trashRestoreKeeps } from '@hnet/db';
import {
  bootMigratedDb,
  createUser,
  seedVerifiedWatchlistRegistry,
  stampOldPlexMatches,
  type TestDb,
} from './helpers';
import { seedTrashDeletion, seedTrashRelease } from './trash-return-fixtures';
import { baseState, makeMaintainerr, movieCollection, tvCollection } from './maintainerr-stub';
import { movieJson, seriesJson, stubArrBundle } from '../../api/__tests__/arr-stubs';
import {
  createBatchFromPending,
  createStaticReleaseBlockArr,
  executeArrAdd,
  hasRestoreKeep,
  removeRestoreKeep,
  recordTrashRestoreAttempt,
  setAppSetting,
  silentDomainLogger,
  startRestoreRun,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
} from '../src/index';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
const fields = (arrItemId: number, external: number) => ({
  arrItemId,
  tmdbId: external,
  tvdbId: external,
  title: `Synthetic ${external}`,
  sortTitle: `synthetic ${external}`,
  monitored: true,
  qualityProfileId: 1,
  qualityProfileName: 'Any',
  rootFolder: '/media',
  arrTags: [] as string[],
});
async function keep(id: string) {
  const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.id, id));
  const { runId } = await startRestoreRun({
    db: t.db,
    arrKind: item!.arrKind,
    initiatedBy: null,
    preview: [{ mediaItemId: id, title: 'Synthetic' }],
  });
  await recordTrashRestoreAttempt({ db: t.db, runId, mediaItemId: id });
}
function addStub(returnedId: number, kind: 'radarr' | 'sonarr' = 'radarr') {
  return stubArrBundle([
    { path: kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series', body: [] },
    { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
    { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/media' }] },
    { path: '/api/v3/tag', body: [] },
    {
      method: 'POST',
      path: kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series',
      status: 201,
      body: kind === 'radarr' ? movieJson(returnedId) : seriesJson(returnedId),
    },
  ]);
}

it.each(['radarr', 'sonarr'] as const)(
  'keeps the original %s title after its manager ID is reused during sync',
  async (kind) => {
    const n = kind === 'radarr' ? 70001 : 71001;
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n, n)] });
    const [old] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    await keep(old!.id);
    // Normal writer, separate full-sync batches: a rebuild assigned the old manager ID to another title.
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n, n + 1)] });
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n + 2, n)] });
    const [original] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    expect(original!.id).not.toBe(old!.id);
    expect(await hasRestoreKeep(t.db, old!.id)).toBe(false);
    expect(await hasRestoreKeep(t.db, original!.id)).toBe(true);
  },
);

it.each(['radarr', 'sonarr'] as const)(
  'rechecks the %s external identity it will POST after target reads',
  async (kind) => {
    const n = 72001;
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n, n)] });
    const [item] = await t.db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, kind), eq(mediaItems.tmdbId, n)));
    const stub = addStub(n + 2, kind);
    stub.bundle.read[kind].listQualityProfiles = async () => {
      await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n, n + 1)] });
      await seedTrashRelease(t.db, {
        arrKind: kind,
        tmdbId: n,
        tvdbId: n,
        title: 'Synthetic',
        identitySource: 'none',
        state: 'active',
        origin: 'sweep',
        expiresAt: new Date(Date.now() + 86400000),
      });
      return [{ id: 1, name: 'Any' }];
    };
    const result = await executeArrAdd({
      db: t.db,
      arr: stub.bundle,
      arrKind: kind,
      initiatedBy: null,
      mediaItemIds: [item!.id],
      reason: 'ledger_add',
      searchOnAdd: false,
    });
    expect(
      stub.callsFor('POST', kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series'),
    ).toHaveLength(0);
    expect(result.skippedTrashCount).toBe(1);
    expect(
      stub.calls.filter((c) => c.method === 'PUT' || c.url.pathname.endsWith('/command')),
    ).toHaveLength(0);
  },
);

it.each(['radarr', 'sonarr'] as const)(
  'refuses %s bulk add when Trash history lands during tag creation',
  async (kind) => {
    const n = 73001;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: kind,
      items: [{ ...fields(n, n), arrTags: ['synthetic-tag'] }],
    });
    const [item] = await t.db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, kind), eq(mediaItems.tmdbId, n)));
    const stub = addStub(n + 2, kind);
    stub.bundle.write[kind].createTag = async (label) => {
      await seedTrashDeletion(t.db, item!.id);
      return { id: 4, label };
    };
    const result = await executeArrAdd({
      db: t.db,
      arr: stub.bundle,
      arrKind: kind,
      initiatedBy: null,
      mediaItemIds: [item!.id],
      reason: 'ledger_add',
      searchOnAdd: false,
    });
    expect.soft(result.skippedTrashCount).toBe(1);
    expect(
      stub.callsFor('POST', kind === 'radarr' ? '/api/v3/movie' : '/api/v3/series'),
    ).toHaveLength(0);
  },
);

// Synthetic keys are fixture identifiers, not measured household counts.
const scenarios = (['radarr', 'sonarr'] as const).flatMap((kind, k) =>
  [false, true].flatMap((force) =>
    ['null', 'obsolete'].map((link, i) => ({
      kind,
      force,
      link,
      n: 76000 + k * 100 + Number(force) * 10 + i,
    })),
  ),
);
it.each(scenarios)(
  'honors late keep: $kind, Expire now=$force, frozen=$link',
  async ({ kind, force, link, n }) => {
    const actor = (await createUser(t.db)).id;
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: actor });
    await seedVerifiedWatchlistRegistry(t.db);
    const mediaKind = kind === 'radarr' ? ('movie' as const) : ('tv' as const);
    const collection = kind === 'radarr' ? movieCollection : tvCollection;
    const state = baseState({
      collections: [
        collection({
          items: [
            {
              mediaServerId: `ms-${n}`,
              ...(kind === 'radarr' ? { tmdbId: n } : { tvdbId: n }),
              sizeBytes: 1000000000,
              addDate: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      ],
    });
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind,
      actorId: actor,
    });
    const [before] = await t.db
      .select()
      .from(trashBatchItems)
      .where(eq(trashBatchItems.batchId, batchId));
    expect(before!.mediaItemId).toBeNull();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: kind,
      items: [fields(n, n), fields(n + 1000, n + 1000)],
    });
    await stampOldPlexMatches(t.db);
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    if (link === 'obsolete') {
      const [other] = await t.db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.tmdbId, n + 1000));
      await t.db
        .update(trashBatchItems)
        .set({ mediaItemId: other!.id })
        .where(eq(trashBatchItems.id, before!.id));
    }
    if (!force)
      await t.db
        .update(trashBatches)
        .set({ expiresAt: new Date(Date.now() - 60000) })
        .where(eq(trashBatches.id, batchId));
    const { arr } = createStaticReleaseBlockArr();
    const list = arr.write[kind].listReleaseProfiles.bind(arr.write[kind]);
    let injected = false;
    arr.write[kind].listReleaseProfiles = async () => {
      if (!injected) {
        injected = true;
        await keep(item!.id);
      }
      return list();
    };
    await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      arr,
      registry: 'gate-only',
      logger: silentDomainLogger,
      ...(force ? { batchId, forceOverride: true, actorId: actor } : {}),
    });
    expect(injected).toBe(true);
    expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(0);
    const [after] = await t.db
      .select()
      .from(trashBatchItems)
      .where(eq(trashBatchItems.batchId, batchId));
    expect(after).toMatchObject({ state: 'skipped', keepReason: 'admin_restored' });
  },
);

it.each(['radarr', 'sonarr'] as const)(
  'preserves a %s keep across tombstoning and ledger removal/recreation',
  async (kind) => {
    const n = kind === 'radarr' ? 78001 : 78002;
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n, n)] });
    const [old] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    await keep(old!.id);
    await t.db
      .update(mediaItems)
      .set({ deletedFromArrAt: new Date() })
      .where(eq(mediaItems.id, old!.id));
    expect(await hasRestoreKeep(t.db, old!.id)).toBe(true);
    await t.db.delete(mediaItems).where(eq(mediaItems.id, old!.id));
    expect(
      (await t.db.select().from(trashRestoreKeeps).where(eq(trashRestoreKeeps.externalId, n)))[0],
    ).toMatchObject({ mediaItemId: null, revokedAt: null });
    await upsertMediaItemsBatch({ db: t.db, arrKind: kind, items: [fields(n + 100, n)] });
    const [replacement] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    expect(await hasRestoreKeep(t.db, replacement!.id)).toBe(true);
  },
);

it.each(['in-flight restore', 'removed keep'] as const)(
  '%s is serialized with the deletion claim',
  async (scenario) => {
    const n = scenario === 'in-flight restore' ? 79001 : 79002;
    const actor = (await createUser(t.db)).id;
    await seedVerifiedWatchlistRegistry(t.db);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: actor });
    await upsertMediaItemsBatch({ db: t.db, arrKind: 'radarr', items: [fields(n, n)] });
    await stampOldPlexMatches(t.db);
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.tmdbId, n));
    const state = baseState({
      collections: [
        movieCollection({
          items: [
            {
              mediaServerId: `ms-${n}`,
              tmdbId: n,
              sizeBytes: 1000000000,
              addDate: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      ],
    });
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId: actor,
    });
    const [offer] = await t.db.insert(releasePickLists).values({ requesterId: actor, mediaItemId: item!.id,
    arrKind: 'radarr', targetLabel: 'Synthetic', searchedAt: new Date(), reasonsVersion: 1,
    offers: [{ key: 'synthetic-pre-delete' }] }).returning();
  if (scenario === 'removed keep') {
      await keep(item!.id);
      await removeRestoreKeep({ db: t.db, mediaItemId: item!.id, actorId: actor });
    } else {
      const handle = bundle.write.handleCollectionMedia.bind(bundle.write);
      bundle.write.handleCollectionMedia = async (collection, media) => {
        await expect(keep(item!.id)).rejects.toThrow('already deleting');
        expect(await hasRestoreKeep(t.db, item!.id)).toBe(false);
        return handle(collection, media);
      };
    }
    const { arr } = createStaticReleaseBlockArr();
    await sweepExpiredBatches({
      db: t.db,
      maintainerr: bundle,
      arr,
      registry: 'gate-only',
      logger: silentDomainLogger,
      batchId,
      forceOverride: true,
      actorId: actor,
    });
    expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(1);
  expect((await t.db.select().from(releasePickLists).where(eq(releasePickLists.id, offer!.id)))[0]).toMatchObject({ offers: [], reasonsVersion: -1 });
  },
);
