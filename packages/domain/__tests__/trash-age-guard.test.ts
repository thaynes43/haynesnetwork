// DESIGN-052 D-26 — the Trash Age Guard (owner ruling 2026-10-03, "Yes, newest date wins"), end to end on embedded
// PG16 with the fetch-stubbed Maintainerr, the in-memory Release Block *arr and the ledger + Plex-match tables the
// guard reads (no live API, ADR-010):
// - an upgrade (a download import) 60 days ago protects: it takes no slot in a targeted batch; an untargeted batch
//   snapshots it `pending` (as D-08 does a watchlisted title) and the sweep keeps it `recently_added`;
// - a newer date added on a second Plex server protects, though the first server's date is old;
// - a rebuild-only date does not protect: a folder import (the 2026-07-03 rebuild's shape) and the *arr's own `added`
//   date are never read, so the title is deleted;
// - a title already in a batch when it is upgraded is kept at the sweep;
// - a Plex match the sync has not dated yet keeps the title `unevaluable` (fail closed);
// - TV: any episode import of the series protects the show the pool holds;
// - the batch wall's kept reason, the space policy's deletable count and the Start-a-batch preview follow.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  SEEDED_PLEX_SERVER_IDS,
  ledgerEvents,
  mediaItems,
  mediaPlexMatches,
  permissionAudit,
  plexLibraries,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
} from '@hnet/db/schema';
import {
  TRASH_AGE_GUARD_DAYS,
  classifyForExpedite,
  classifyGuardian,
  createBatchFromPending,
  expediteDeletion,
  createStaticReleaseBlockArr,
  getBatchDetail,
  eligiblePlexAddedAt,
  isLibraryFillDay,
  judgeAge,
  listTrashPending,
  loadAgeEvidence,
  listTrashPendingCandidates,
  refreshTrashCandidates,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertPlexLibraries,
} from '../src/index';
import {
  baseState,
  makeMaintainerr,
  movieCollection,
  tvCollection,
  type MaintState,
} from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const { arr: releaseArr } = createStaticReleaseBlockArr();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** A movie pool of four items. */
function pool() {
  return movieCollection({
    items: [9101, 9102, 9103, 9104].map((tmdbId, i) => ({
      mediaServerId: `ms-${tmdbId}`,
      tmdbId,
      sizeBytes: (4 - i) * 1_000,
      addDate: '2026-06-01T00:00:00Z',
    })),
  });
}

describe('the Trash Age Guard (DESIGN-052 D-26)', () => {
  let t: TestDb;
  let admin: string;
  let opsMovies: string;
  let towerMovies: string;
  let opsShows: string;
  const ids = new Map<number, string>(); // tmdb / tvdb id → media_items.id
  let eventSeq = 0;

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'age-guard@example.com', displayName: 'Age Admin' }))
      .id;
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [
        { sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'HOps Shows', mediaType: 'show' },
      ],
    });
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynestower',
      libraries: [{ sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' }],
    });
    const libs = await t.db.select().from(plexLibraries);
    const lib = (server: string, key: string) =>
      libs.find((l) => l.serverId === server && l.sectionKey === key)!.id;
    opsMovies = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '1');
    opsShows = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '2');
    towerMovies = lib(SEEDED_PLEX_SERVER_IDS.haynestower, '1');

    const common = { monitored: true, qualityProfileId: 1, qualityProfileName: 'Any' };
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9101, 9102, 9103, 9104].map((tmdbId, i) => ({
        ...common,
        arrItemId: i + 1,
        tmdbId,
        title: `Movie ${tmdbId}`,
        sortTitle: `movie ${tmdbId}`,
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [8001, 8002].map((tvdbId, i) => ({
        ...common,
        arrItemId: i + 1,
        tvdbId,
        title: `Show ${tvdbId}`,
        sortTitle: `show ${tvdbId}`,
        rootFolder: '/tv',
      })),
    });
    // ADR-117 — one hundred extra movies so a library-day can meet the fill cutoff of 100.
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: Array.from({ length: 100 }, (_, i) => ({
        ...common,
        arrItemId: 101 + i,
        tmdbId: 9201 + i,
        title: `Fill ${9201 + i}`,
        sortTitle: `fill ${9201 + i}`,
        rootFolder: '/movies',
      })),
    });
    for (const r of await t.db.select().from(mediaItems)) ids.set((r.tmdbId ?? r.tvdbId)!, r.id);
    // The 2026-07-03 rebuild shape: every movie's *arr `added` is recent. The guard never reads it.
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [9101, 9102, 9103, 9104].map((id) => ({
        mediaItemId: ids.get(id)!,
        arrAddedAt: daysAgo(92),
      })),
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(ledgerEvents);
    await t.db.delete(mediaPlexMatches);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
    await seedVerifiedWatchlistRegistry(t.db);
    // ADR-117 ships off. Reset it so a library-fill test cannot leak into the D-26 cases.
    await setAppSetting({
      db: t.db,
      key: 'age_guard_ignore_library_fill',
      value: false,
      actorId: admin,
    });
    // Every movie is on both servers, added long ago; every show on HaynesOps, added long ago.
    await plexDates(
      [9101, 9102, 9103, 9104].flatMap((id) => [
        { ext: id, lib: opsMovies, at: daysAgo(400) },
        { ext: id, lib: towerMovies, at: daysAgo(300) },
      ]),
    );
    await plexDates([8001, 8002].map((id) => ({ ext: id, lib: opsShows, at: daysAgo(500) })));
  });

  /** Upsert the Plex matches (one per library) with their date added. */
  async function plexDates(rows: Array<{ ext: number; lib: string; at: Date | null }>) {
    await syncPlexMatches({
      db: t.db,
      matches: rows.map((r, i) => ({
        mediaItemId: ids.get(r.ext)!,
        plexLibraryId: r.lib,
        ratingKey: `${r.ext}-${i}`,
        matchedVia: 'tmdb' as const,
        plexAddedAt: r.at,
      })),
      scopedLibraryIds: [],
    });
  }

  /** An *arr history import in the ledger (`downloadFolderImported` = a download or an upgrade). */
  async function imported(
    ext: number,
    at: Date,
    rawEventType = 'downloadFolderImported',
    source: 'radarr' | 'sonarr' = 'radarr',
  ) {
    eventSeq += 1;
    await t.db.insert(ledgerEvents).values({
      mediaItemId: ids.get(ext)!,
      eventType: 'imported',
      source,
      sourceEventId: `age-${eventSeq}`,
      occurredAt: at,
      payload: { rawEventType, sourceTitle: `Release.${ext}.2160p` },
    });
  }

  async function createBatch(
    state: MaintState,
    mediaKind: 'movie' | 'tv' = 'movie',
    maxItems?: number,
  ) {
    const { bundle } = makeMaintainerr(state);
    return createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind,
      actorId: admin,
      ...(maxItems !== undefined ? { targeting: { maxItems } } : {}),
    });
  }

  async function expire(batchId: string) {
    await t.db
      .update(trashBatches)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(trashBatches.id, batchId));
  }

  async function sweep(state: MaintState) {
    const { bundle } = makeMaintainerr(state);
    return sweepExpiredBatches({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      registry: 'gate-only',
      logger: silentDomainLogger,
    });
  }

  const itemStates = async (batchId: string) =>
    Object.fromEntries(
      (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map(
        (r) => [r.maintainerrMediaId, { state: r.state, keepReason: r.keepReason }],
      ),
    );

  /** ADR-117 — tmdb ids 9201..9300. A shared added instant is one America/New_York library-day. */
  const COHORT = Array.from({ length: 100 }, (_, i) => 9201 + i);

  async function setFillRule(on: boolean) {
    await setAppSetting({
      db: t.db,
      key: 'age_guard_ignore_library_fill',
      value: on,
      actorId: admin,
    });
  }

  /** Stamp the first `n` cohort movies. `towerAt` null leaves them on one server. */
  async function stampCohort(
    n: number,
    opsAt: Date,
    towerAt: Date | null,
    opsLib: string = opsMovies,
  ) {
    const rows: Array<{ ext: number; lib: string; at: Date | null }> = [];
    for (const ext of COHORT.slice(0, n)) {
      rows.push({ ext, lib: opsLib, at: opsAt });
      if (towerAt) rows.push({ ext, lib: towerMovies, at: towerAt });
    }
    await plexDates(rows);
  }

  async function ageOf(ext: number) {
    const id = ids.get(ext)!;
    const evidence = await loadAgeEvidence({ db: t.db, arrKind: 'radarr', mediaItemIds: [id] });
    const row = evidence.get(id);
    return { row, judgement: judgeAge(row, Date.now()) };
  }

  it('judgeAge: newest date wins; a recent signal beats an undated match; old and dated is clear', () => {
    const now = Date.now();
    const ev = (o: Partial<Parameters<typeof judgeAge>[0] & object>) => ({
      newestImportAt: null,
      newestPlexAddedAt: null,
      plexMatches: 1,
      plexUndated: 0,
      ...o,
    });
    expect(judgeAge(undefined, now).ageGuard).toBe('unknown');
    expect(judgeAge(ev({ newestPlexAddedAt: daysAgo(400) }), now).ageGuard).toBe('clear');
    const upgraded = daysAgo(60);
    expect(
      judgeAge(ev({ newestPlexAddedAt: daysAgo(400), newestImportAt: upgraded }), now),
    ).toEqual({
      ageGuard: 'recent',
      newestAddedAt: upgraded.toISOString(),
    });
    expect(
      judgeAge(ev({ newestPlexAddedAt: daysAgo(TRASH_AGE_GUARD_DAYS + 1) }), now).ageGuard,
    ).toBe('clear');
    expect(
      judgeAge(ev({ newestPlexAddedAt: daysAgo(TRASH_AGE_GUARD_DAYS - 1) }), now).ageGuard,
    ).toBe('recent');
    expect(judgeAge(ev({ newestImportAt: daysAgo(10), plexUndated: 1 }), now).ageGuard).toBe(
      'recent',
    );
    expect(
      judgeAge(ev({ newestPlexAddedAt: daysAgo(400), plexMatches: 2, plexUndated: 1 }), now)
        .ageGuard,
    ).toBe('unknown');
    // No Plex match at all: judged on imports alone.
    expect(judgeAge(ev({ plexMatches: 0 }), now).ageGuard).toBe('clear');
    // Q-14 — the guardian itself carries the Age Guard, after tag / recently watched / watchlisted.
    const g = (o: Partial<Parameters<typeof classifyGuardian>[0]>) => ({
      protectedByTag: false,
      recentlyWatched: false,
      mediaItemId: 'm-1',
      onWatchlist: false,
      watchlistEvaluable: true,
      ruleEvaluationFailed: false,
      ageGuard: 'clear' as const,
      saveIntent: false,
      ...o,
    });
    expect(classifyGuardian(g({ ageGuard: 'recent' }))).toEqual({
      keep: true,
      reason: 'recently_added',
    });
    // ADR-099 D-4 — a Save still comes first.
    expect(classifyGuardian(g({ ageGuard: 'recent', saveIntent: true }))).toEqual({
      keep: true,
      reason: 'saved',
    });
    expect(classifyGuardian(g({ ageGuard: 'unknown' }))).toEqual({
      keep: true,
      reason: 'unevaluable',
    });
    expect(classifyGuardian(g({}))).toEqual({ keep: false });
    expect(classifyGuardian(g({ ageGuard: 'recent', recentlyWatched: true }))).toEqual({
      keep: true,
      reason: 'recently_watched',
    });
    expect(classifyGuardian(g({ ageGuard: 'recent', onWatchlist: true }))).toEqual({
      keep: true,
      reason: 'watchlisted',
    });
    // ADR-117 does not weaken the earlier keeps: a clear age still loses to a tag and to a watchlist.
    expect(classifyGuardian(g({ ageGuard: 'clear', protectedByTag: true }))).toEqual({
      keep: true,
      reason: 'tag',
    });
    expect(classifyGuardian(g({ ageGuard: 'clear', onWatchlist: true }))).toEqual({
      keep: true,
      reason: 'watchlisted',
    });
    expect(classifyForExpedite({ ...g({ ageGuard: 'recent' }), maintainerrMediaId: 'ms-1' })).toBe(
      'protected_recent',
    );
    expect(classifyForExpedite({ ...g({ ageGuard: 'unknown' }), maintainerrMediaId: 'ms-1' })).toBe(
      'unverifiable',
    );
  });

  it('an upgrade 60 days ago protects: no targeted slot; an untargeted batch snapshots it and the sweep keeps it', async () => {
    await imported(9101, daysAgo(60));
    const state = baseState({ collections: [pool()] });
    const { bundle } = makeMaintainerr(state);
    const pending = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      watchlist: null,
    });
    const byId = new Map(pending.items.map((i) => [i.maintainerrMediaId, i]));
    expect(byId.get('ms-9101')?.ageGuard).toBe('recent');
    expect(Date.parse(byId.get('ms-9101')!.newestAddedAt!)).toBeCloseTo(daysAgo(60).getTime(), -4);
    expect(byId.get('ms-9102')?.ageGuard).toBe('clear');

    // The Start-a-batch preview's wire says so too.
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const cands = await listTrashPendingCandidates({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
    });
    expect(cands.candidates.find((c) => c.maintainerrMediaId === 'ms-9101')?.recentlyAdded).toBe(
      true,
    );
    expect(cands.candidates.find((c) => c.maintainerrMediaId === 'ms-9102')?.recentlyAdded).toBe(
      false,
    );
    const targeted = await createBatch(state, 'movie', 2);
    // ms-9101 is the largest but never takes a slot.
    expect(Object.keys(await itemStates(targeted.batchId)).sort()).toEqual(['ms-9102', 'ms-9103']);
    await t.db.delete(trashBatches);
    const untargeted = await createBatch(state);
    expect(await itemStates(untargeted.batchId)).toMatchObject({
      'ms-9101': { state: 'pending', keepReason: null },
    });
    await expire(untargeted.batchId);
    await sweep(state);
    expect(await itemStates(untargeted.batchId)).toEqual({
      'ms-9101': { state: 'skipped', keepReason: 'recently_added' },
      'ms-9102': { state: 'deleted', keepReason: null },
      'ms-9103': { state: 'deleted', keepReason: null },
      'ms-9104': { state: 'deleted', keepReason: null },
    });
  });

  it('a title already in a batch when it is upgraded, or added to a second server, is kept at the sweep', async () => {
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    expect(Object.keys(await itemStates(batchId))).toHaveLength(4);
    // After the batch was built: ms-9101 is upgraded (60 days ago, as Troll was), ms-9102 lands on HaynesTower 120
    // days ago (newer than HaynesOps' 400), ms-9103 gets a folder import 20 days ago (the rebuild's shape: no file
    // arrived), ms-9104 is untouched.
    await imported(9101, daysAgo(60));
    await plexDates([{ ext: 9102, lib: towerMovies, at: daysAgo(120) }]);
    await imported(9103, daysAgo(20), 'movieFolderImported');
    await expire(batchId);
    const report = await sweep(state);
    expect(await itemStates(batchId)).toEqual({
      'ms-9101': { state: 'skipped', keepReason: 'recently_added' },
      'ms-9102': { state: 'skipped', keepReason: 'recently_added' },
      'ms-9103': { state: 'deleted', keepReason: null },
      'ms-9104': { state: 'deleted', keepReason: null },
    });
    expect(report.batches[0]!.keptByReason).toEqual({ recently_added: 2 });

    // The batch wall carries the reason on the kept rows (its "Kept: …" tooltip reads keepReason).
    const detail = await getBatchDetail({ db: t.db, batchId });
    const kept = detail.items.filter((i) => i.state === 'skipped').map((i) => i.keepReason);
    expect(kept).toEqual(['recently_added', 'recently_added']);
  });

  it('a rebuild-only date does not protect: the *arr `added` and folder imports are never read', async () => {
    // Every movie has arr_added_at 92 days ago (beforeAll) and a folder import 92 days ago; both servers say old.
    for (const id of [9101, 9102, 9103, 9104])
      await imported(id, daysAgo(92), 'movieFolderImported');
    // An upgrade 200 days ago is outside the window.
    await imported(9104, daysAgo(200));
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    await expire(batchId);
    await sweep(state);
    expect(Object.values(await itemStates(batchId)).map((s) => s.state)).toEqual([
      'deleted',
      'deleted',
      'deleted',
      'deleted',
    ]);
  });

  it('a Plex match the sync has not dated yet keeps the title `unevaluable` (fail closed)', async () => {
    const state = baseState({ collections: [pool()] });
    const { batchId } = await createBatch(state);
    await plexDates([{ ext: 9103, lib: towerMovies, at: null }]); // as on every row right after migration 0086
    await expire(batchId);
    await sweep(state);
    const states = await itemStates(batchId);
    expect(states['ms-9103']).toEqual({ state: 'skipped', keepReason: 'unevaluable' });
    expect(states['ms-9101']).toEqual({ state: 'deleted', keepReason: null });
  });

  it('TV: an episode imported 30 days ago protects the series the pool holds', async () => {
    await imported(8001, daysAgo(30), 'downloadFolderImported', 'sonarr');
    await imported(8002, daysAgo(30), 'downloadFolderImported', 'radarr'); // wrong source: not this series' history
    const state = baseState({ collections: [tvCollection()] });
    // A targeted batch leaves the protected show out; an untargeted one snapshots it and the sweep keeps it.
    const targeted = await createBatch(state, 'tv', 2);
    expect(Object.keys(await itemStates(targeted.batchId))).toEqual(['ms-8002']);
    await t.db.delete(trashBatches);
    const { batchId } = await createBatch(state, 'tv');
    await expire(batchId);
    await sweep(state);
    expect(await itemStates(batchId)).toEqual({
      'ms-8001': { state: 'skipped', keepReason: 'recently_added' },
      'ms-8002': { state: 'deleted', keepReason: null },
    });
  });

  it('Q-14: Expedite never deletes a title inside the Age Guard, item or all, and never auto-saves it', async () => {
    await imported(9101, daysAgo(60)); // upgraded 60 days ago
    await plexDates([{ ext: 9102, lib: towerMovies, at: daysAgo(30) }]); // added to a second server 30 days ago
    const state = baseState({ collections: [pool()] });
    const { bundle, calls } = makeMaintainerr(state);
    const item = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'item',
      media: 'movie',
      actorId: admin,
      item: { collectionId: 7, maintainerrMediaId: 'ms-9101' },
      logger: silentDomainLogger,
    });
    expect(item).toMatchObject({ protectedCount: 1, expeditedCount: 0, skippedCount: 0 });
    const all = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId: admin,
      snapshotMediaIds: ['ms-9101', 'ms-9102', 'ms-9103', 'ms-9104'],
      logger: silentDomainLogger,
    });
    expect(all).toMatchObject({ protectedCount: 2, expeditedCount: 2 });
    expect([...all.expeditedIds].sort()).toEqual(['ms-9103', 'ms-9104']);
    const handled = calls
      .filter((c) => c.method === 'POST' && c.pathname === '/collections/media/handle')
      .map((c) => (c.body as { mediaId: string }).mediaId);
    expect(handled).not.toContain('ms-9101');
    expect(handled).not.toContain('ms-9102');
    // Never auto-saved: no exclusion was written for either kept title.
    expect(state.exclusions.has('ms-9101')).toBe(false);
    expect(state.exclusions.has('ms-9102')).toBe(false);
  });

  it('ADR-117: a fill-only date does not protect when an older date exists on another server', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    const older = daysAgo(400);
    await stampCohort(100, recent, older);
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('clear');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(older.toISOString());
    // The pending read uses the same evidence. Off, below, this title is recent.
    const { bundle } = makeMaintainerr(
      baseState({
        collections: [
          movieCollection({
            items: [
              {
                mediaServerId: 'ms-9201',
                tmdbId: 9201,
                sizeBytes: 1_000,
                addDate: '2020-01-01T00:00:00Z',
              },
            ],
          }),
        ],
      }),
    );
    const on = await listTrashPending({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      watchlist: null,
    });
    expect(on.items.find((i) => i.maintainerrMediaId === 'ms-9201')?.ageGuard).toBe('clear');
    const turnedOn = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(
      turnedOn
        .filter((a) => (a.detail as { key?: string }).key === 'age_guard_ignore_library_fill')
        .at(-1)?.detail,
    ).toMatchObject({ key: 'age_guard_ignore_library_fill', after: true });
  });

  it('ADR-117: the setting off keeps today, including a fill date that is the newest', async () => {
    const recent = daysAgo(30);
    const older = daysAgo(400);
    await stampCohort(100, recent, older);
    const { row, judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    const fillAudits = audits.filter(
      (a) => (a.detail as { key?: string }).key === 'age_guard_ignore_library_fill',
    );
    expect(fillAudits.length).toBeGreaterThan(0);
    expect(fillAudits.at(-1)?.detail).toMatchObject({
      key: 'age_guard_ignore_library_fill',
      after: false,
    });
  });

  it('ADR-117: a download import inside 180 days still protects on a fill day', async () => {
    await setFillRule(true);
    await stampCohort(100, daysAgo(30), daysAgo(400));
    const importedAt = daysAgo(10);
    await imported(9201, importedAt);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: importedAt.toISOString() });
  });

  it('ADR-117: a title on one server only keeps the fill date', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, null);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-117: a one-title arrival on a second server still protects when the setting is on', async () => {
    await setFillRule(true);
    const added = daysAgo(120);
    await plexDates([{ ext: 9102, lib: towerMovies, at: added }]);
    const { judgement } = await ageOf(9102);
    expect(judgement.ageGuard).toBe('recent');
    expect(judgement.newestAddedAt).toBe(added.toISOString());
  });

  it('ADR-117: a day under the cutoff is not a fill (the pre-history trickle, and a midnight split)', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(12, recent, daysAgo(400));
    expect((await ageOf(9201)).judgement.ageGuard).toBe('recent');
    await t.db.delete(mediaPlexMatches);
    await stampCohort(60, recent, daysAgo(400));
    const split = await ageOf(9201);
    expect(split.judgement.ageGuard).toBe('recent');
    expect(split.row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });

  it('ADR-117: a mass day where every title has a nearby import is not a fill', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    for (const ext of COHORT) await imported(ext, new Date(recent.getTime() - 60_000));
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });

  it('ADR-117: an older date that is still inside 180 days keeps the title', async () => {
    await setFillRule(true);
    const older = daysAgo(100);
    await stampCohort(100, daysAgo(30), older);
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(older.toISOString());
  });

  it('ADR-117: the same instant on the other server is not an older date, so the fill date stays', async () => {
    await setFillRule(true);
    const at = daysAgo(30);
    await stampCohort(100, at, at);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: at.toISOString() });
  });

  it('ADR-117: an undated other server does not retire a fill date', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, null);
    await plexDates([{ ext: 9201, lib: towerMovies, at: null }]);
    const { row, judgement } = await ageOf(9201);
    expect(row?.plexUndated).toBe(1);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-117: a second library on the same server does not retire a fill date', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, null, opsShows);
    await plexDates([{ ext: 9201, lib: opsMovies, at: daysAgo(400) }]);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-117: a show-library fill date does not protect a movie that is older on another server', async () => {
    await setFillRule(true);
    await stampCohort(100, daysAgo(30), daysAgo(400), opsShows);
    const { judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('clear');
  });

  it("ADR-117: one nearby import keeps that title's stamp on an otherwise fill day", async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    await imported(9201, new Date(recent.getTime() - 60_000));
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });
});

describe('the library-fill predicate (ADR-117)', () => {
  const at = (iso: string) => new Date(iso);

  it('labels only a large day with almost no nearby imports', () => {
    expect(isLibraryFillDay(8, 0)).toBe(false);
    expect(isLibraryFillDay(99, 0)).toBe(false);
    expect(isLibraryFillDay(100, 5)).toBe(true);
    expect(isLibraryFillDay(100, 6)).toBe(false);
    expect(isLibraryFillDay(232, 1)).toBe(true);
    expect(isLibraryFillDay(638, 0)).toBe(true);
    expect(isLibraryFillDay(141, 141)).toBe(false);
    expect(isLibraryFillDay(100.5, 0)).toBe(false);
  });

  it('drops a fill stamp only when another server is strictly older and the stamp has no nearby import', () => {
    const fill = at('2026-07-02T22:00:00.000Z');
    const older = at('2024-01-01T00:00:00.000Z');
    const stamps = [
      { serverId: 'ops', addedAt: fill, fillDay: true, nearImport: false },
      { serverId: 'tower', addedAt: older, fillDay: false, nearImport: false },
    ];
    expect(eligiblePlexAddedAt(stamps)?.toISOString()).toBe(older.toISOString());
    expect(
      eligiblePlexAddedAt([
        { serverId: 'ops', addedAt: fill, fillDay: true, nearImport: false },
      ])?.toISOString(),
    ).toBe(fill.toISOString());
    expect(
      eligiblePlexAddedAt([
        { serverId: 'ops', addedAt: fill, fillDay: true, nearImport: true },
        { serverId: 'tower', addedAt: older, fillDay: false, nearImport: false },
      ])?.toISOString(),
    ).toBe(fill.toISOString());
  });
});
