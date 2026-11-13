// ADR-117 / DESIGN-052 D-29. A title tagged mediarequests is a guardian keep, and the sweep's audit
// refuses when an armed movie or TV rule has lost that clause. Embedded PG16, the fetch-stubbed
// Maintainerr and the in-memory Release Block *arr. No live API.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
} from '@hnet/db/schema';
import {
  auditMaintainerr,
  buildRuleGroupUpdate,
  classifyForExpedite,
  classifyGuardian,
  countsTowardDeletion,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  describeTrashRules,
  evaluateRequestClauses,
  expediteDeletion,
  LEAVING_SOON_COLLECTION_TITLES,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
} from '../src/index';
import {
  baseState,
  makeMaintainerr,
  movieCollection,
  type StubRuleGroup,
} from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const { arr: releaseArr } = createStaticReleaseBlockArr();

const cold = {
  protectedByTag: false,
  recentlyWatched: false,
  mediaItemId: 'm-1',
  onWatchlist: false,
  watchlistEvaluable: true,
  ruleEvaluationFailed: false,
  ageGuard: 'clear' as const,
  saveIntent: false,
  maintainerrMediaId: 'ms-1',
};

function encoded(body: Record<string, unknown>) {
  return { id: 1, isActive: true, section: 0, ruleJson: JSON.stringify(body) };
}

function requestClause(kind: 'movie' | 'show') {
  return encoded({
    operator: 0,
    action: 9,
    firstVal: kind === 'movie' ? [1, 2] : [2, 2],
    customVal: { ruleTypeId: 0, value: 'mediarequests' },
    section: 0,
  });
}

function ratingClause(kind: 'movie' | 'show', value: string) {
  return encoded({
    operator: null,
    action: 1,
    firstVal: kind === 'movie' ? [1, 16] : [2, 19],
    customVal: { ruleTypeId: 0, value },
    section: 0,
  });
}

describe('the Request Keep, the clause audit and the rule description (ADR-117)', () => {
  it('keeps a tagged title after every earlier keep, and leaves an untagged title deletable', () => {
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'] })).toEqual({
      keep: true,
      reason: 'media_request',
    });
    expect(classifyGuardian({ ...cold, arrTags: ['13-member'] })).toEqual({ keep: false });
    expect(classifyGuardian({ ...cold })).toEqual({ keep: false });
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'], ageGuard: 'recent' })).toEqual({
      keep: true,
      reason: 'recently_added',
    });
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'], onWatchlist: true })).toEqual({
      keep: true,
      reason: 'watchlisted',
    });
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'], saveIntent: true })).toEqual({
      keep: true,
      reason: 'saved',
    });
    expect(classifyForExpedite({ ...cold, arrTags: ['mediarequests'] })).toBe('protected_request');
    expect(classifyForExpedite({ ...cold, arrTags: ['13-member'] })).toBe('deletable');
    expect(countsTowardDeletion({ ...cold, arrTags: ['mediarequests'] })).toBe(false);
    expect(countsTowardDeletion({ ...cold, arrTags: [] })).toBe(true);
  });

  it('refuses when the clause is missing from either rule, and passes when both have it', () => {
    const movie = { name: 'hnet movies', isActive: true, useRules: true, dataType: 'movie' };
    const show = { name: 'hnet shows', isActive: true, useRules: true, dataType: 'show' };
    const missingMovie = evaluateRequestClauses([
      { ...movie, rules: [ratingClause('movie', '6.5')] },
      { ...show, rules: [requestClause('show')] },
    ]);
    expect(missingMovie).toHaveLength(1);
    expect(missingMovie[0]).toContain('hnet movies');
    expect(missingMovie[0]).toContain('mediarequests');
    const missingShow = evaluateRequestClauses([
      { ...movie, rules: [requestClause('movie')] },
      { ...show, rules: [ratingClause('show', '6.0')] },
    ]);
    expect(missingShow).toHaveLength(1);
    expect(missingShow[0]).toContain('hnet shows');
    expect(
      evaluateRequestClauses([
        { ...movie, rules: [ratingClause('movie', '6.5'), requestClause('movie')] },
        { ...show, rules: [ratingClause('show', '6.0'), requestClause('show')] },
      ]),
    ).toEqual([]);
    // A Leaving Soon shell is not a rule pool.
    expect(
      evaluateRequestClauses([
        {
          name: LEAVING_SOON_COLLECTION_TITLES.movie,
          isActive: true,
          useRules: false,
          dataType: 'movie',
          rules: [],
        },
      ]),
    ).toEqual([]);
    // A group the stub does not model (no rules field) is not a violation.
    expect(evaluateRequestClauses([{ ...movie }])).toEqual([]);
    // An armed group with an empty clause list is.
    expect(evaluateRequestClauses([{ ...movie, rules: [] }])).toHaveLength(1);
  });

  it('the description the app writes is the body it writes', () => {
    const rules = [ratingClause('movie', '6.5'), requestClause('movie')];
    const text = describeTrashRules(rules);
    expect(text).toContain('is below 6.5');
    expect(text).toContain('does not contain mediarequests');
    expect(text).not.toContain('6.0');
    const updated = buildRuleGroupUpdate(
      {
        id: 1,
        rules,
        description: 'IMDb rating below 6.0 and the guardian enforces requester protection',
      },
      {
        useRules: true,
        collection: { arrAction: 0, listExclusions: true, forceSeerr: true, deleteAfterDays: 9999 },
      },
    );
    expect(updated.description).toBe(text);
    const leaving = buildRuleGroupUpdate(
      {
        id: 2,
        rules: [],
        description: 'Items leaving the server soon. Save the ones you still want.',
      },
      { useRules: false, collection: {} },
    );
    expect(leaving.description).toBe(
      'Items leaving the server soon. Save the ones you still want.',
    );
  });
});

describe('the Request Keep on the four deletion paths (ADR-117)', () => {
  let t: TestDb;
  let admin: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (
      await createUser(t.db, { email: 'request-keep@example.com', displayName: 'Request Keep' })
    ).id;
    const common = {
      monitored: true,
      qualityProfileId: 1,
      qualityProfileName: 'Any',
      rootFolder: '/movies',
    };
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          ...common,
          arrItemId: 1,
          tmdbId: 9201,
          title: 'Requested One',
          sortTitle: 'requested one',
          arrTags: ['mediarequests'],
        },
        {
          ...common,
          arrItemId: 2,
          tmdbId: 9202,
          title: 'Cold One',
          sortTitle: 'cold one',
          arrTags: [],
        },
        {
          ...common,
          arrItemId: 3,
          tmdbId: 9203,
          title: 'Named One',
          sortTitle: 'named one',
          arrTags: ['13-member'],
        },
      ],
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await t.db.delete(trashDeletedReleases);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
    await seedVerifiedWatchlistRegistry(t.db);
  });

  function pool() {
    return movieCollection({
      items: [9201, 9202, 9203].map((tmdbId, i) => ({
        mediaServerId: `ms-${tmdbId}`,
        tmdbId,
        sizeBytes: (3 - i) * 1_000_000_000,
        addDate: '2024-01-01T00:00:00Z',
      })),
    });
  }

  async function itemStates(batchId: string) {
    return Object.fromEntries(
      (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map(
        (row) => [row.maintainerrMediaId, { state: row.state, keepReason: row.keepReason }],
      ),
    );
  }

  it('a targeted batch gives it no slot; an untargeted batch snapshots it and the sweep keeps it', async () => {
    const state = baseState({ collections: [pool()] });
    const targeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
      targeting: { maxItems: 1 },
    });
    // The tagged title is the largest. The slot goes to the cold one.
    expect(Object.keys(await itemStates(targeted.batchId))).toEqual(['ms-9202']);
    await t.db.delete(trashBatches);

    const untargeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    expect(await itemStates(untargeted.batchId)).toMatchObject({
      'ms-9201': { state: 'pending', keepReason: null },
      'ms-9202': { state: 'pending', keepReason: null },
      'ms-9203': { state: 'pending', keepReason: null },
    });
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, untargeted.batchId));
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      registry: 'gate-only',
      logger: silentDomainLogger,
    });
    expect(await itemStates(untargeted.batchId)).toEqual({
      'ms-9201': { state: 'skipped', keepReason: 'media_request' },
      'ms-9202': { state: 'deleted', keepReason: null },
      'ms-9203': { state: 'deleted', keepReason: null },
    });
  });

  it('Expire now keeps the tagged title while the window is still open', async () => {
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    const open = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(open[0]!.state).toBe('leaving_soon');
    expect(open[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      registry: 'gate-only',
      batchId,
      forceOverride: true,
      actorId: admin,
      logger: silentDomainLogger,
    });
    expect(await itemStates(batchId)).toEqual({
      'ms-9201': { state: 'skipped', keepReason: 'media_request' },
      'ms-9202': { state: 'deleted', keepReason: null },
      'ms-9203': { state: 'deleted', keepReason: null },
    });
  });

  it('Expedite keeps the tagged title, item and all, and does not auto-save it', async () => {
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    const item = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId: admin,
      item: { collectionId: 7, maintainerrMediaId: 'ms-9201' },
      logger: silentDomainLogger,
    });
    expect(item).toMatchObject({ protectedCount: 1, expeditedCount: 0, skippedCount: 0 });
    expect(state.exclusions.has('ms-9201')).toBe(false);
    const all = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId: admin,
      snapshotMediaIds: ['ms-9201', 'ms-9202', 'ms-9203'],
      logger: silentDomainLogger,
    });
    expect([...all.expeditedIds].sort()).toEqual(['ms-9202', 'ms-9203']);
    expect(all.protectedCount).toBe(1);
    expect(state.exclusions.has('ms-9201')).toBe(false);
  });

  it('the audit refuses a sweep when either armed rule has lost the clause, and passes when both have it', async () => {
    const collection = pool();
    const movieGroup = (rules: unknown[]): StubRuleGroup => ({
      id: 1,
      name: 'hnet movies',
      isActive: true,
      useRules: true,
      libraryId: '1',
      dataType: 'movie',
      collectionId: collection.id,
      rules,
    });
    const showGroup = (rules: unknown[]): StubRuleGroup => ({
      id: 2,
      name: 'hnet shows',
      isActive: true,
      useRules: true,
      libraryId: '2',
      dataType: 'show',
      collectionId: collection.id,
      rules,
    });
    const missing = baseState({
      collections: [collection],
      ruleGroups: [movieGroup([ratingClause('movie', '6.5')]), showGroup([requestClause('show')])],
    });
    const refused = await auditMaintainerr({ maintainerr: makeMaintainerr(missing).bundle });
    expect(refused.safe).toBe(false);
    expect(
      refused.agingViolations.some(
        (line) => line.includes('hnet movies') && line.includes('mediarequests'),
      ),
    ).toBe(true);
    const present = baseState({
      collections: [collection],
      ruleGroups: [
        movieGroup([ratingClause('movie', '6.5'), requestClause('movie')]),
        showGroup([ratingClause('show', '6.0'), requestClause('show')]),
      ],
    });
    const passed = await auditMaintainerr({ maintainerr: makeMaintainerr(present).bundle });
    expect(passed.safe).toBe(true);
    expect(passed.agingViolations).toEqual([]);
  });
});
