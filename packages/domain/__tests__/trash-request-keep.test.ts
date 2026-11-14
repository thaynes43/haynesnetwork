// ADR-118 / DESIGN-052 D-30. A title tagged mediarequests is a guardian keep, and the sweep's audit
// refuses when an armed movie or TV rule has lost that clause. Embedded PG16, the fetch-stubbed
// Maintainerr and the in-memory Release Block *arr. No live API.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mediaItems,
  plexLibraries,
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
  trashWallProtection,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  createStaticWatchlistSources,
  describeTrashRules,
  evaluateRequestClauses,
  expediteDeletion,
  LEAVING_SOON_COLLECTION_TITLES,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
} from '../src/index';
import {
  baseState,
  makeMaintainerr,
  movieCollection,
  tvCollection,
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

function requestClause(kind: 'movie' | 'show', over: Record<string, unknown> = {}) {
  return encoded({
    operator: 0,
    action: 9,
    firstVal: kind === 'movie' ? [1, 2] : [2, 2],
    customVal: { ruleTypeId: 2, value: 'mediarequests' },
    section: 0,
    ...over,
  });
}

function viewsClause(operator: unknown, section = 0) {
  return encoded({
    operator,
    action: 1,
    firstVal: [0, 17],
    customVal: { ruleTypeId: 0, value: '1' },
    section,
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

describe('the Request Keep, the clause audit and the rule description (ADR-118)', () => {
  it('keeps a title tagged mediarequests whose file has no verified release name, and reports media_request', () => {
    // The Request Keep is before unevaluable. release_unverified (ADR-117) is after unevaluable.
    // First match wins, so the reported reason is media_request. The title is still kept.
    const item = { ...cold, arrTags: ['mediarequests'], releaseName: 'unverified' as const };
    expect(classifyGuardian(item)).toEqual({ keep: true, reason: 'media_request' });
    expect(trashWallProtection(item)).toBe('media_request');
    expect(countsTowardDeletion(item)).toBe(false);
    expect(classifyForExpedite(item)).toBe('protected_request');
    expect(classifyGuardian({ ...cold, releaseName: 'unverified' })).toEqual({
      keep: true,
      reason: 'release_unverified',
    });
  });

  it('keeps a tagged title after every earlier keep, and leaves an untagged title deletable', () => {
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'] })).toEqual({
      keep: true,
      reason: 'media_request',
    });
    expect(classifyGuardian({ ...cold, arrTags: ['13-member'] })).toEqual({ keep: false });
    expect(classifyGuardian({ ...cold })).toEqual({ keep: false });
    expect(classifyGuardian({ ...cold, arrTags: ['mediarequests'], protectedByTag: true })).toEqual(
      {
        keep: true,
        reason: 'tag',
      },
    );
    expect(
      classifyGuardian({ ...cold, arrTags: ['mediarequests'], recentlyWatched: true }),
    ).toEqual({
      keep: true,
      reason: 'recently_watched',
    });
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
    expect(classifyForExpedite({ ...cold, arrTags: ['mediarequests'], protectedByTag: true })).toBe(
      'protected_tag',
    );
    expect(
      classifyForExpedite({ ...cold, arrTags: ['mediarequests'], recentlyWatched: true }),
    ).toBe('protected_watched');
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
    // A Leaving Soon shell is exempt because useRules is false, not because of its name.
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
    // The same name with useRules on, and no clause, is a violation.
    expect(
      evaluateRequestClauses([
        {
          name: LEAVING_SOON_COLLECTION_TITLES.movie,
          isActive: true,
          useRules: true,
          dataType: 'movie',
          rules: [],
        },
      ]),
    ).toHaveLength(1);
    // An armed group whose rules were not an array cannot be confirmed.
    expect(evaluateRequestClauses([{ ...movie }])).toHaveLength(1);
    expect(evaluateRequestClauses([{ ...movie, rules: null }])).toHaveLength(1);
    expect(evaluateRequestClauses([{ ...movie, useRules: undefined }])[0]).toContain(
      'could not be read',
    );
    // useRules false is the only armed exemption, even with no rules field.
    expect(evaluateRequestClauses([{ ...movie, useRules: false }])).toEqual([]);
    // An armed group with an empty clause list is a violation.
    expect(evaluateRequestClauses([{ ...movie, rules: [] }])).toHaveLength(1);
    // A disarmed group is not checked.
    expect(evaluateRequestClauses([{ ...movie, isActive: false }])).toEqual([]);
  });

  it('recognises the clause the way Maintainerr stores it, including a string operator', () => {
    const movie = { name: 'hnet movies', isActive: true, useRules: true, dataType: 'movie' };
    const stringOp = evaluateRequestClauses([
      {
        ...movie,
        rules: [
          ratingClause('movie', '6.5'),
          requestClause('movie', { operator: '0', action: '9', firstVal: ['1', '2'] }),
        ],
      },
    ]);
    expect(stringOp).toEqual([]);
    const listed = evaluateRequestClauses([
      {
        ...movie,
        rules: [
          requestClause('movie', {
            customVal: { ruleTypeId: 2, value: '["Other","MediaRequests"]' },
          }),
        ],
      },
    ]);
    expect(listed).toEqual([]);
    const mixedCase = evaluateRequestClauses([
      {
        ...movie,
        rules: [requestClause('movie', { customVal: { value: 'MediaRequests' } })],
      },
    ]);
    expect(mixedCase).toEqual([]);
  });

  it('accepts a first request clause with no operator, and refuses one later that has none', () => {
    const movie = { name: 'hnet movies', isActive: true, useRules: true, dataType: 'movie' };
    const absent = requestClause('movie', { operator: undefined });
    // JSON.stringify drops an undefined key, which is how a first clause loses its operator.
    expect(JSON.parse(String(absent.ruleJson))).not.toHaveProperty('operator');
    expect(evaluateRequestClauses([{ ...movie, rules: [absent] }])).toEqual([]);
    expect(
      evaluateRequestClauses([{ ...movie, rules: [requestClause('movie', { operator: null })] }]),
    ).toEqual([]);
    expect(
      evaluateRequestClauses([{ ...movie, rules: [requestClause('movie', { operator: 0 })] }]),
    ).toEqual([]);
    expect(
      evaluateRequestClauses([{ ...movie, rules: [requestClause('movie', { operator: '0' })] }]),
    ).toEqual([]);
    expect(evaluateRequestClauses([{ ...movie, rules: [absent, viewsClause(0)] }])).toEqual([]);
    const laterAbsent = evaluateRequestClauses([
      {
        ...movie,
        rules: [ratingClause('movie', '6.5'), requestClause('movie', { operator: undefined })],
      },
    ]);
    expect(laterAbsent).toHaveLength(1);
    expect(laterAbsent[0]).toContain('OR');
    const laterNull = evaluateRequestClauses([
      {
        ...movie,
        rules: [ratingClause('movie', '6.5'), requestClause('movie', { operator: null })],
      },
    ]);
    expect(laterNull).toHaveLength(1);
    expect(laterNull[0]).toContain('OR');
  });

  it('refuses a later OR, including a second section, and accepts a second section joined by AND', () => {
    const movie = { name: 'hnet movies', isActive: true, useRules: true, dataType: 'movie' };
    const withClause = [ratingClause('movie', '6.5'), requestClause('movie')];
    const orAfter = evaluateRequestClauses([{ ...movie, rules: [...withClause, viewsClause(1)] }]);
    expect(orAfter).toHaveLength(1);
    expect(orAfter[0]).toContain('OR');
    const nullLater = evaluateRequestClauses([
      {
        ...movie,
        rules: [ratingClause('movie', '6.5'), requestClause('movie', { operator: null })],
      },
    ]);
    expect(nullLater[0]).toContain('OR');
    const sectionOr = evaluateRequestClauses([
      { ...movie, rules: [...withClause, viewsClause(1, 1)] },
    ]);
    expect(sectionOr[0]).toContain('OR');
    const sectionAnd = evaluateRequestClauses([
      {
        ...movie,
        rules: [ratingClause('movie', '6.5'), requestClause('movie', { section: 1 })],
      },
    ]);
    expect(sectionAnd).toEqual([]);
  });

  it('holds a season or episode group to the show-tag clause, and refuses an unknown type', () => {
    const armed = { name: 'hnet seasons', isActive: true, useRules: true };
    expect(
      evaluateRequestClauses([{ ...armed, dataType: 'season', rules: [requestClause('show')] }]),
    ).toEqual([]);
    expect(
      evaluateRequestClauses([{ ...armed, dataType: 'episode', rules: [requestClause('show')] }]),
    ).toEqual([]);
    expect(
      evaluateRequestClauses([{ ...armed, dataType: 'episode', rules: [requestClause('movie')] }]),
    ).toHaveLength(1);
    const unknown = evaluateRequestClauses([
      { ...armed, dataType: 'music', rules: [requestClause('movie')] },
    ]);
    expect(unknown[0]).toContain('type cannot be checked');
  });

  it('the description the app writes matches the body and keeps the caller notes', () => {
    const rules = [ratingClause('movie', '6.5'), requestClause('movie')];
    const text = describeTrashRules(rules);
    expect(text).toContain('is below 6.5');
    expect(text).toContain('does not contain mediarequests');
    expect(text).not.toContain('6.0');
    const notes = 'Pool flags and the ruling dates stay.';
    const separator = ' — ';
    const live = {
      useRules: true,
      collection: { arrAction: 0, listExclusions: true, forceSeerr: true, deleteAfterDays: 9999 },
    };
    const written = (payload: Record<string, unknown>): string => {
      if (typeof payload.description !== 'string') throw new Error('description was not a string');
      return payload.description;
    };
    const updated = buildRuleGroupUpdate({ id: 1, rules, description: notes }, live);
    const saved = written(updated);
    expect(saved).toBe(`${text}${separator}${notes}`);
    const rulesEdited = [ratingClause('movie', '6.0'), requestClause('movie')];
    const editedText = describeTrashRules(rulesEdited);
    const edited = written(
      buildRuleGroupUpdate({ id: 1, rules: rulesEdited, description: saved }, live),
    );
    expect(edited).toBe(`${editedText}${separator}${notes}`);
    expect(edited).toContain('is below 6.0');
    expect(edited).not.toContain('6.5');
    expect(edited.split(separator)).toEqual([editedText, notes]);
    const third = written(
      buildRuleGroupUpdate({ id: 1, rules: rulesEdited, description: edited }, live),
    );
    expect(third).toBe(edited);
    // A description from before the separator is notes, kept whole once, then left unchanged.
    const handwritten = 'Hand-written notes. The old sentence stays in this text.';
    const once = written(
      buildRuleGroupUpdate({ id: 1, rules: rulesEdited, description: handwritten }, live),
    );
    expect(once).toBe(`${editedText}${separator}${handwritten}`);
    const twice = written(
      buildRuleGroupUpdate({ id: 1, rules: rulesEdited, description: once }, live),
    );
    expect(twice).toBe(once);
    const twoProperties = describeTrashRules([
      encoded({ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }),
    ]);
    expect(twoProperties).toBe('property 1,0 is above property 0,4');
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

  it('describes the corrected TV rule of DESIGN-014 D-15, and that rule passes the audit', () => {
    const rules = [
      encoded({
        operator: null,
        action: 1,
        firstVal: [2, 19],
        customVal: { ruleTypeId: 0, value: '6.0' },
        section: 0,
      }),
      encoded({
        operator: 0,
        action: 0,
        firstVal: [2, 20],
        customVal: { ruleTypeId: 0, value: '99' },
        section: 0,
      }),
      requestClause('show'),
      encoded({
        operator: 0,
        action: 2,
        firstVal: [2, 7],
        customVal: { ruleTypeId: 3, value: '1' },
        section: 0,
      }),
      encoded({
        operator: 0,
        action: 5,
        firstVal: [0, 27],
        customVal: { ruleTypeId: 0, value: '15552000' },
        section: 0,
      }),
    ];
    expect(describeTrashRules(rules)).toBe(
      'Sonarr show rating is below 6.0, and Sonarr show vote count is above 99, and Sonarr tags does not contain mediarequests, and Sonarr show ended equals 1, and Plex last episode aired is before 180 days',
    );
    const show = { name: 'hnet shows', isActive: true, useRules: true, dataType: 'show' };
    expect(evaluateRequestClauses([{ ...show, rules }])).toEqual([]);
    // A write that stops after rating and votes has lost the clause.
    expect(evaluateRequestClauses([{ ...show, rules: rules.slice(0, 2) }])).toHaveLength(1);
  });
});

describe('the Request Keep on the four deletion paths (ADR-118)', () => {
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
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          ...common,
          rootFolder: '/tv',
          arrItemId: 1,
          tvdbId: 8001,
          title: 'Requested Show',
          sortTitle: 'requested show',
          arrTags: ['mediarequests'],
        },
        {
          ...common,
          rootFolder: '/tv',
          arrItemId: 2,
          tvdbId: 8002,
          title: 'Cold Show',
          sortTitle: 'cold show',
          arrTags: [],
        },
      ],
    });
    // ADR-119 keeps a title with no Plex match. Date these titles 400 days ago so the Age Guard is
    // clear and the Request Keep is the reason under test.
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [
        { sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'HOps Shows', mediaType: 'show' },
      ],
    });
    const libs = await t.db.select().from(plexLibraries);
    const movies = libs.find((l) => l.name === 'HOps Movies')!.id;
    const shows = libs.find((l) => l.name === 'HOps Shows')!.id;
    const old = new Date(Date.now() - 400 * 86_400_000);
    const rows = await t.db.select().from(mediaItems);
    await syncPlexMatches({
      db: t.db,
      scopedLibraryIds: [],
      matches: rows.map((r) => ({
        mediaItemId: r.id,
        plexLibraryId: r.arrKind === 'sonarr' ? shows : movies,
        ratingKey: `${r.arrKind}-${r.arrItemId}`,
        matchedVia: r.arrKind === 'sonarr' ? ('tvdb' as const) : ('tmdb' as const),
        plexAddedAt: old,
      })),
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

  async function setMovieTags(tags: Record<number, string[]>) {
    const common = {
      monitored: true,
      qualityProfileId: 1,
      qualityProfileName: 'Any',
      rootFolder: '/movies',
    };
    const titles: Record<number, string> = {
      9201: 'Requested One',
      9202: 'Cold One',
      9203: 'Named One',
    };
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9201, 9202, 9203].map((tmdbId, i) => ({
        ...common,
        arrItemId: i + 1,
        tmdbId,
        title: titles[tmdbId]!,
        sortTitle: titles[tmdbId]!.toLowerCase(),
        arrTags: tags[tmdbId] ?? [],
      })),
    });
  }

  it('every batch leaves a tagged title out, and a row already pending is kept at the sweep', async () => {
    const state = baseState({ collections: [pool()] });
    const targeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
      targeting: { maxItems: 1 },
    });
    // The tagged title is the largest, and it is not a candidate. The slot goes to the cold one.
    expect(Object.keys(await itemStates(targeted.batchId))).toEqual(['ms-9202']);
    await t.db.delete(trashBatches);

    const untargeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    const leftOut = await itemStates(untargeted.batchId);
    expect(leftOut['ms-9201']).toBeUndefined();
    expect(leftOut).toMatchObject({
      'ms-9202': { state: 'pending', keepReason: null },
      'ms-9203': { state: 'pending', keepReason: null },
    });
    await t.db.delete(trashBatches);

    // A title that was snapshotted, then tagged, is kept when the window closes.
    await setMovieTags({ 9201: [], 9202: [], 9203: ['13-member'] });
    const pending = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    expect((await itemStates(pending.batchId))['ms-9201']).toEqual({
      state: 'pending',
      keepReason: null,
    });
    await setMovieTags({ 9201: ['mediarequests'], 9202: [], 9203: ['13-member'] });
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, pending.batchId));
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      registry: 'gate-only',
      logger: silentDomainLogger,
    });
    expect(await itemStates(pending.batchId)).toEqual({
      'ms-9201': { state: 'skipped', keepReason: 'media_request' },
      'ms-9202': { state: 'deleted', keepReason: null },
      'ms-9203': { state: 'deleted', keepReason: null },
    });
  });

  it('Expire now keeps a tagged title that is already pending while the window is still open', async () => {
    await setMovieTags({ 9201: [], 9202: [], 9203: ['13-member'] });
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    await setMovieTags({ 9201: ['mediarequests'], 9202: [], 9203: ['13-member'] });
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
    await setMovieTags({ 9201: ['mediarequests'], 9202: [], 9203: ['13-member'] });
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

  it('a tagged show is kept on each path, and an untagged show is not', async () => {
    const shows = tvCollection({
      items: [8001, 8002].map((tvdbId, i) => ({
        mediaServerId: `ms-${tvdbId}`,
        tvdbId,
        sizeBytes: (2 - i) * 1_000_000_000,
        addDate: '2024-01-01T00:00:00Z',
      })),
    });
    const state = baseState({ collections: [shows] });
    const targeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'tv',
      actorId: admin,
      targeting: { maxItems: 1 },
    });
    expect(Object.keys(await itemStates(targeted.batchId))).toEqual(['ms-8002']);
    await t.db.delete(trashBatches);
    const untargeted = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'tv',
      actorId: admin,
    });
    expect(await itemStates(untargeted.batchId)).toEqual({
      'ms-8002': { state: 'pending', keepReason: null },
    });
    await t.db.delete(trashBatches);

    const { bundle } = makeMaintainerr(state);
    const item = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'tv',
      actorId: admin,
      item: { collectionId: shows.id, maintainerrMediaId: 'ms-8001' },
      logger: silentDomainLogger,
    });
    expect(item).toMatchObject({ protectedCount: 1, expeditedCount: 0 });
    expect(state.exclusions.has('ms-8001')).toBe(false);
    const all = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'tv',
      actorId: admin,
      snapshotMediaIds: ['ms-8001', 'ms-8002'],
      logger: silentDomainLogger,
    });
    expect([...all.expeditedIds]).toEqual(['ms-8002']);
    expect(all.protectedCount).toBe(1);

    // Expedite above removed the untagged show from that stub. A fresh stub still has both,
    // so the sweep and Expire now can snapshot the show and then see the tag.
    const pool = baseState({ collections: [shows] });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
          arrItemId: 1,
          tvdbId: 8001,
          title: 'Requested Show',
          sortTitle: 'requested show',
          arrTags: [],
        },
      ],
    });
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(pool).bundle,
      mediaKind: 'tv',
      actorId: admin,
    });
    expect(Object.keys(await itemStates(batchId)).sort()).toEqual(['ms-8001', 'ms-8002']);
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
          arrItemId: 1,
          tvdbId: 8001,
          title: 'Requested Show',
          sortTitle: 'requested show',
          arrTags: ['mediarequests'],
        },
      ],
    });
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, batchId));
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: makeMaintainerr(pool).bundle,
      registry: 'gate-only',
      logger: silentDomainLogger,
    });
    expect(await itemStates(batchId)).toMatchObject({
      'ms-8001': { state: 'skipped', keepReason: 'media_request' },
      'ms-8002': { state: 'deleted', keepReason: null },
    });

    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
          arrItemId: 1,
          tvdbId: 8001,
          title: 'Requested Show',
          sortTitle: 'requested show',
          arrTags: [],
        },
      ],
    });
    const opened = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(pool).bundle,
      mediaKind: 'tv',
      actorId: admin,
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
          arrItemId: 1,
          tvdbId: 8001,
          title: 'Requested Show',
          sortTitle: 'requested show',
          arrTags: ['mediarequests'],
        },
      ],
    });
    await sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: makeMaintainerr(pool).bundle,
      registry: 'gate-only',
      batchId: opened.batchId,
      forceOverride: true,
      actorId: admin,
      logger: silentDomainLogger,
    });
    expect((await itemStates(opened.batchId))['ms-8001']).toEqual({
      state: 'skipped',
      keepReason: 'media_request',
    });
  });

  it('a scheduled sweep with a batch due refuses when the clause is gone or the rules cannot be read', async () => {
    await setMovieTags({ 9201: ['mediarequests'], 9202: [], 9203: ['13-member'] });
    const collection = pool();
    const armed = (rules: unknown[]): StubRuleGroup => ({
      id: 1,
      name: 'hnet movies',
      isActive: true,
      useRules: true,
      libraryId: '1',
      dataType: 'movie',
      collectionId: collection.id,
      rules,
    });
    const state = baseState({
      collections: [collection],
      ruleGroups: [armed([ratingClause('movie', '6.5'), requestClause('movie')])],
    });
    const { batchId } = await createBatchFromPending({
      db: t.db,
      maintainerr: makeMaintainerr(state).bundle,
      mediaKind: 'movie',
      actorId: admin,
    });
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, batchId));
    state.ruleGroups = [armed([ratingClause('movie', '6.5')])];
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      info: () => {},
      error: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => {
        logs.push({ msg, fields });
      },
    };
    const { sources } = createStaticWatchlistSources({ ownerId: '1' });
    await expect(
      sweepExpiredBatches({
        arr: releaseArr,
        db: t.db,
        maintainerr: makeMaintainerr(state).bundle,
        registry: 'refresh',
        registrySources: sources,
        logger,
      }),
    ).rejects.toThrow(/mediarequests/);
    const paused = logs.find((l) => l.msg === '[trash] sweep_paused');
    expect(paused?.fields).toMatchObject({ reason: 'audit_unsafe', step: 'unsafe' });
    expect(JSON.stringify(paused?.fields?.violations)).toContain('mediarequests');
    expect((await itemStates(batchId))['ms-9202']).toEqual({ state: 'pending', keepReason: null });

    state.fail.add('GET /rules');
    const unread = await auditMaintainerr({ maintainerr: makeMaintainerr(state).bundle });
    expect(unread.safe).toBe(false);
    expect(unread.agingViolations.join(' ')).toContain('could not be read');
    await expect(
      sweepExpiredBatches({
        arr: releaseArr,
        db: t.db,
        maintainerr: makeMaintainerr(state).bundle,
        registry: 'gate-only',
        logger: silentDomainLogger,
      }),
    ).rejects.toThrow(/could not be read/);
    expect((await itemStates(batchId))['ms-9202']).toEqual({ state: 'pending', keepReason: null });
  });
});
