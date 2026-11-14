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
import { eq, sql } from 'drizzle-orm';
import {
  SEEDED_PLEX_SERVER_IDS,
  appSettings,
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
  ledgerCoversAgeWindow,
  listTrashPending,
  loadAgeEvidence,
  listTrashPendingCandidates,
  refreshTrashCandidates,
  setAgeGuardIgnoreLibraryFill,
  setAppSetting,
  silentDomainLogger,
  sweepExpiredBatches,
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

function nyParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** UTC instant of a wall-clock time in America/New_York. One offset correction is enough away from a DST jump. */
function nyInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const seen = nyParts(guess);
  const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess.getTime() + (target - seenUtc));
}

function nyMidnightContaining(instant: Date): Date {
  const p = nyParts(instant);
  return nyInstant(p.year, p.month, p.day, 0, 0);
}

function nyDateKey(date: Date): string {
  const p = nyParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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
  let towerShows: string;
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
      libraries: [
        { sectionKey: '1', name: 'HNet Movies', mediaType: 'movie' },
        { sectionKey: '2', name: 'HNet Shows', mediaType: 'show' },
      ],
    });
    const libs = await t.db.select().from(plexLibraries);
    const lib = (server: string, key: string) =>
      libs.find((l) => l.serverId === server && l.sectionKey === key)!.id;
    opsMovies = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '1');
    opsShows = lib(SEEDED_PLEX_SERVER_IDS.haynesops, '2');
    towerMovies = lib(SEEDED_PLEX_SERVER_IDS.haynestower, '1');
    towerShows = lib(SEEDED_PLEX_SERVER_IDS.haynestower, '2');

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
    // ADR-119 — one hundred extra movies, and one hundred shows, so a library-day can meet the fill cutoff.
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
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: Array.from({ length: 100 }, (_, i) => ({
        ...common,
        arrItemId: 101 + i,
        tvdbId: 8201 + i,
        title: `Show ${8201 + i}`,
        sortTitle: `show ${8201 + i}`,
        rootFolder: '/tv',
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
    // ADR-119 ships off. Reset it so a library-fill test cannot leak into the D-26 cases.
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

  /**
   * Upsert the Plex matches (one per library) with their date added. This writes the rows directly.
   * `syncPlexMatches` would delete a cross-type row in the same transaction (ADR-123), and these cases
   * include a movie dated in a show library so the fill rule can be read with that row present.
   */
  async function plexDates(rows: Array<{ ext: number; lib: string; at: Date | null }>) {
    if (rows.length === 0) return;
    const now = new Date();
    await t.db
      .insert(mediaPlexMatches)
      .values(
        rows.map((r, i) => ({
          mediaItemId: ids.get(r.ext)!,
          plexLibraryId: r.lib,
          ratingKey: `${r.ext}-${i}`,
          matchedVia: 'tmdb' as const,
          plexAddedAt: r.at,
          firstSeenAt: now,
          lastSeenAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [mediaPlexMatches.mediaItemId, mediaPlexMatches.plexLibraryId],
        set: {
          ratingKey: sql`excluded.rating_key`,
          matchedVia: sql`excluded.matched_via`,
          plexAddedAt: sql`excluded.plex_added_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
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

  /** ADR-119 — tmdb ids 9201..9300. A shared added instant is one America/New_York library-day. */
  const COHORT = Array.from({ length: 100 }, (_, i) => 9201 + i);

  async function setFillRule(on: boolean) {
    await setAppSetting({
      db: t.db,
      key: 'age_guard_ignore_library_fill',
      value: on,
      actorId: admin,
    });
  }

  /**
   * One download import old enough that this *arr's ledger covers the 180-day window. Without it the fill rule
   * leaves every stamp in place, so a test of the rule itself would pass for the wrong reason.
   */
  async function coverLedger(source: 'radarr' | 'sonarr' = 'radarr', ageDays = TRASH_AGE_GUARD_DAYS + 1) {
    const ext = source === 'radarr' ? 9104 : 8002;
    await imported(ext, daysAgo(ageDays), 'downloadFolderImported', source);
  }

  async function armFill() {
    await setFillRule(true);
    await coverLedger('radarr');
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

  async function ageOfKind(ext: number, arrKind: 'radarr' | 'sonarr') {
    const id = ids.get(ext)!;
    const evidence = await loadAgeEvidence({ db: t.db, arrKind, mediaItemIds: [id] });
    const row = evidence.get(id);
    return { row, judgement: judgeAge(row, Date.now()) };
  }

  async function ageOf(ext: number) {
    return ageOfKind(ext, 'radarr');
  }

  const SHOW_COHORT = Array.from({ length: 100 }, (_, i) => 8201 + i);

  async function stampShows(n: number, opsAt: Date, towerAt: Date | null) {
    const rows: Array<{ ext: number; lib: string; at: Date | null }> = [];
    for (const ext of SHOW_COHORT.slice(0, n)) {
      rows.push({ ext, lib: opsShows, at: opsAt });
      if (towerAt) rows.push({ ext, lib: towerShows, at: towerAt });
    }
    await plexDates(rows);
  }

  async function stampHalf(exts: number[], at: Date, towerAt: Date) {
    const rows: Array<{ ext: number; lib: string; at: Date | null }> = [];
    for (const ext of exts) {
      rows.push({ ext, lib: opsMovies, at });
      rows.push({ ext, lib: towerMovies, at: towerAt });
    }
    await plexDates(rows);
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
    // No Plex match, and no import inside the window: unknown keeps the title (ADR-119). A recent import still wins.
    expect(judgeAge(ev({ plexMatches: 0 }), now).ageGuard).toBe('unknown');
    expect(judgeAge(ev({ plexMatches: 0, newestImportAt: daysAgo(400) }), now).ageGuard).toBe(
      'unknown',
    );
    expect(judgeAge(ev({ plexMatches: 0, newestImportAt: daysAgo(10) }), now).ageGuard).toBe(
      'recent',
    );
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
    // ADR-119 does not weaken the earlier keeps: a clear age still loses to a tag and to a watchlist.
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

  it('ADR-119: a fill-only date does not protect when an older date exists on another server', async () => {
    await armFill();
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

  it('ADR-119: the setting off keeps today, including a fill date that is the newest', async () => {
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

  it('ADR-119: a download import inside 180 days still protects on a fill day', async () => {
    await armFill();
    await stampCohort(100, daysAgo(30), daysAgo(400));
    const importedAt = daysAgo(10);
    await imported(9201, importedAt);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: importedAt.toISOString() });
  });

  it('ADR-119: a title on one server only keeps the fill date', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, null);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: a one-title arrival on a second server still protects when the setting is on', async () => {
    await armFill();
    const added = daysAgo(120);
    await plexDates([{ ext: 9102, lib: towerMovies, at: added }]);
    const { judgement } = await ageOf(9102);
    expect(judgement.ageGuard).toBe('recent');
    expect(judgement.newestAddedAt).toBe(added.toISOString());
  });

  it('ADR-119: a day under the cutoff is not a fill (the pre-history trickle, and a midnight split)', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(12, recent, daysAgo(400));
    expect((await ageOf(9201)).judgement.ageGuard).toBe('recent');
    await t.db.delete(mediaPlexMatches);
    await stampCohort(60, recent, daysAgo(400));
    const split = await ageOf(9201);
    expect(split.judgement.ageGuard).toBe('recent');
    expect(split.row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });

  it('ADR-119: a mass day where every title has a nearby import is not a fill', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    for (const ext of COHORT) await imported(ext, new Date(recent.getTime() - 60_000));
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });

  it('ADR-119: an older date that is still inside 180 days keeps the title', async () => {
    await armFill();
    const older = daysAgo(100);
    await stampCohort(100, daysAgo(30), older);
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(older.toISOString());
  });

  it('ADR-119: the same instant on the other server is not an older date, so the fill date stays', async () => {
    await armFill();
    const at = daysAgo(30);
    await stampCohort(100, at, at);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: at.toISOString() });
  });

  it('ADR-119: an undated other server does not retire a fill date', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, null);
    await plexDates([{ ext: 9201, lib: towerMovies, at: null }]);
    const { row, judgement } = await ageOf(9201);
    expect(row?.plexUndated).toBe(1);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: a second library on the same server does not retire a fill date', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, null, opsShows);
    await plexDates([{ ext: 9201, lib: opsMovies, at: daysAgo(400) }]);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: a show-library fill date does not protect a movie that is older on another server', async () => {
    await armFill();
    await stampCohort(100, daysAgo(30), daysAgo(400), opsShows);
    const { judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('clear');
  });

  it("ADR-119: one nearby import keeps that title's stamp on an otherwise fill day", async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    await imported(9201, new Date(recent.getTime() - 60_000));
    const { row, judgement } = await ageOf(9201);
    expect(judgement.ageGuard).toBe('recent');
    expect(row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
  });

  it('ADR-119: ledger history that starts inside the window leaves every fill stamp in place', async () => {
    await setFillRule(true);
    await coverLedger('radarr', TRASH_AGE_GUARD_DAYS - 1);
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: no download import at all leaves every fill stamp in place', async () => {
    await setFillRule(true);
    const recent = daysAgo(30);
    await stampCohort(100, recent, daysAgo(400));
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: an absent row and a non-boolean value both read as off', async () => {
    const recent = daysAgo(30);
    const older = daysAgo(400);
    await armFill();
    await stampCohort(100, recent, older);
    expect((await ageOf(9201)).judgement.ageGuard).toBe('clear');

    await t.db.delete(appSettings).where(eq(appSettings.key, 'age_guard_ignore_library_fill'));
    expect((await ageOf(9201)).judgement).toEqual({
      ageGuard: 'recent',
      newestAddedAt: recent.toISOString(),
    });

    await t.db.insert(appSettings).values({
      key: 'age_guard_ignore_library_fill',
      value: 'yes',
    });
    expect((await ageOf(9201)).judgement).toEqual({
      ageGuard: 'recent',
      newestAddedAt: recent.toISOString(),
    });
    await t.db.execute(sql`
      update app_settings
      set value = '1'::jsonb
      where key = 'age_guard_ignore_library_fill'
    `);
    expect((await ageOf(9201)).judgement.ageGuard).toBe('recent');
  });

  it('ADR-119: 99 titles are not a fill and 100 titles are, at the database', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(99, recent, daysAgo(400));
    expect((await ageOf(9201)).judgement.ageGuard).toBe('recent');
    await t.db.delete(mediaPlexMatches);
    await stampCohort(100, recent, daysAgo(400));
    expect((await ageOf(9201)).judgement.ageGuard).toBe('clear');
  });

  it('ADR-119: 6 hours keeps the stamp and 6 hours 1 second does not, at the database', async () => {
    await armFill();
    const recent = daysAgo(30);
    const older = daysAgo(400);
    await stampCohort(100, recent, older);
    const sixHours = 6 * 60 * 60 * 1000;
    await imported(9201, new Date(recent.getTime() - sixHours));
    await imported(9202, new Date(recent.getTime() - sixHours - 1000));
    const kept = await ageOf(9201);
    expect(kept.row?.newestPlexAddedAt?.toISOString()).toBe(recent.toISOString());
    expect(kept.judgement.ageGuard).toBe('recent');
    // The import sits next to a stamp inside the window, so it still protects the title. The boundary
    // shows up on the stamp: exactly 6 hours keeps it, one second further leaves the older date.
    const dropped = await ageOf(9202);
    expect(dropped.row?.newestPlexAddedAt?.toISOString()).toBe(older.toISOString());
    expect(dropped.judgement.ageGuard).toBe('recent');
  });

  it('ADR-119: a scan across New York midnight is two days, and one New York day across UTC midnight is a fill', async () => {
    await armFill();
    const older = daysAgo(400);
    const split = nyMidnightContaining(daysAgo(30));
    const before = new Date(split.getTime() - 30 * 60 * 1000);
    const after = new Date(split.getTime() + 30 * 60 * 1000);
    expect(nyDateKey(before)).not.toBe(nyDateKey(after));
    expect(utcDateKey(before)).toBe(utcDateKey(after));
    await t.db.delete(mediaPlexMatches);
    await stampHalf(COHORT.slice(0, 50), before, older);
    await stampHalf(COHORT.slice(50), after, older);
    expect((await ageOf(9201)).judgement.ageGuard).toBe('recent');
    expect((await ageOf(9251)).judgement.ageGuard).toBe('recent');

    const midnight = nyMidnightContaining(daysAgo(40));
    const early = new Date(midnight.getTime() + 30 * 60 * 1000);
    const late = new Date(midnight.getTime() + (22 * 60 + 30) * 60 * 1000);
    expect(nyDateKey(early)).toBe(nyDateKey(late));
    expect(utcDateKey(early)).not.toBe(utcDateKey(late));
    await t.db.delete(mediaPlexMatches);
    await stampHalf(COHORT.slice(0, 50), early, older);
    await stampHalf(COHORT.slice(50), late, older);
    expect((await ageOf(9201)).judgement.ageGuard).toBe('clear');
    expect((await ageOf(9251)).judgement.ageGuard).toBe('clear');
  });

  it('ADR-119: a wrong-type match is not the older date that retires a fill stamp', async () => {
    await armFill();
    const recent = daysAgo(30);
    await stampCohort(100, recent, null);
    await plexDates([{ ext: 9201, lib: towerShows, at: daysAgo(400) }]);
    const { judgement } = await ageOf(9201);
    expect(judgement).toEqual({ ageGuard: 'recent', newestAddedAt: recent.toISOString() });
  });

  it('ADR-119: a Sonarr show is released by a fill, and one episode import keeps it', async () => {
    await setFillRule(true);
    // A Radarr import does not open Sonarr's window.
    await coverLedger('radarr');
    const recent = daysAgo(30);
    const showOlder = daysAgo(400);
    await stampShows(100, recent, showOlder);
    expect((await ageOfKind(8201, 'sonarr')).judgement).toEqual({
      ageGuard: 'recent',
      newestAddedAt: recent.toISOString(),
    });
    await coverLedger('sonarr');
    const released = await ageOfKind(8201, 'sonarr');
    expect(released.judgement.ageGuard).toBe('clear');
    expect(released.row?.newestPlexAddedAt?.toISOString()).toBe(showOlder.toISOString());
    const importedAt = daysAgo(12);
    await imported(8202, importedAt, 'downloadFolderImported', 'sonarr');
    expect((await ageOfKind(8202, 'sonarr')).judgement).toEqual({
      ageGuard: 'recent',
      newestAddedAt: importedAt.toISOString(),
    });
  });

  it('ADR-119: a pool member with no Plex match is unknown, with the setting off or on', async () => {
    await t.db.delete(mediaPlexMatches).where(eq(mediaPlexMatches.mediaItemId, ids.get(9101)!));
    expect((await ageOf(9101)).judgement.ageGuard).toBe('unknown');
    await imported(9101, daysAgo(400));
    expect((await ageOf(9101)).judgement.ageGuard).toBe('unknown');
    await setFillRule(true);
    expect((await ageOf(9101)).judgement.ageGuard).toBe('unknown');
    const importedAt = daysAgo(10);
    await imported(9101, importedAt);
    expect((await ageOf(9101)).judgement).toEqual({
      ageGuard: 'recent',
      newestAddedAt: importedAt.toISOString(),
    });
  });

  it('ADR-119: setAgeGuardIgnoreLibraryFill audits the value on and back', async () => {
    const on = await setAgeGuardIgnoreLibraryFill({ db: t.db, enabled: true, actorId: admin });
    expect(on).toMatchObject({ before: false, after: true, changed: true });
    const back = await setAgeGuardIgnoreLibraryFill({ db: t.db, enabled: false, actorId: admin });
    expect(back).toMatchObject({ before: true, after: false, changed: true });
    await expect(
      setAgeGuardIgnoreLibraryFill({
        db: t.db,
        enabled: 'yes' as unknown as boolean,
        actorId: admin,
      }),
    ).rejects.toThrow(/boolean/);
  });

  function fillPool(idsIn: number[]) {
    return baseState({
      collections: [
        movieCollection({
          items: idsIn.map((tmdbId) => ({
            mediaServerId: `ms-${tmdbId}`,
            tmdbId,
            sizeBytes: 1_000,
            addDate: '2020-01-01T00:00:00Z',
          })),
        }),
      ],
    });
  }

  it('ADR-119: with the setting on, the sweep deletes a released fill title and keeps an import', async () => {
    await armFill();
    await stampCohort(100, daysAgo(30), daysAgo(400));
    await imported(9202, daysAgo(10));
    const state = fillPool([9201, 9202]);
    const { batchId } = await createBatch(state);
    await expire(batchId);
    await sweep(state);
    expect(await itemStates(batchId)).toEqual({
      'ms-9201': { state: 'deleted', keepReason: null },
      'ms-9202': { state: 'skipped', keepReason: 'recently_added' },
    });
  });

  it('ADR-119: with the setting on, Expedite deletes a released fill title and keeps an import', async () => {
    await armFill();
    await stampCohort(100, daysAgo(30), daysAgo(400));
    await imported(9202, daysAgo(10));
    const state = fillPool([9201, 9202]);
    const { bundle } = makeMaintainerr(state);
    const all = await expediteDeletion({
      arr: releaseArr,
      db: t.db,
      maintainerr: bundle,
      scope: 'all',
      media: 'movie',
      actorId: admin,
      snapshotMediaIds: ['ms-9201', 'ms-9202'],
      logger: silentDomainLogger,
    });
    expect(all.protectedCount).toBe(1);
    expect([...all.expeditedIds].sort()).toEqual(['ms-9201']);
  });
});

describe('the library-fill predicate (ADR-119)', () => {
  const at = (iso: string) => new Date(iso);
  const stamp = (
    serverId: string,
    addedAt: Date,
    over: Partial<{ fillDay: boolean; nearImport: boolean; fitsTitle: boolean }> = {},
  ) => ({
    serverId,
    addedAt,
    fillDay: false,
    nearImport: false,
    fitsTitle: true,
    ...over,
  });

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
    expect(
      eligiblePlexAddedAt([
        stamp('ops', fill, { fillDay: true }),
        stamp('tower', older),
      ])?.toISOString(),
    ).toBe(older.toISOString());
    expect(eligiblePlexAddedAt([stamp('ops', fill, { fillDay: true })])?.toISOString()).toBe(
      fill.toISOString(),
    );
    expect(
      eligiblePlexAddedAt([
        stamp('ops', fill, { fillDay: true, nearImport: true }),
        stamp('tower', older),
      ])?.toISOString(),
    ).toBe(fill.toISOString());
  });

  it('a wrong-type stamp is not the older date', () => {
    const fill = at('2026-07-02T22:00:00.000Z');
    const older = at('2024-01-01T00:00:00.000Z');
    expect(
      eligiblePlexAddedAt([
        stamp('ops', fill, { fillDay: true }),
        stamp('tower', older, { fitsTitle: false }),
      ])?.toISOString(),
    ).toBe(fill.toISOString());
  });

  it('covers the window only when the first import is at least 180 days old', () => {
    const now = Date.UTC(2026, 10, 13);
    expect(ledgerCoversAgeWindow(new Date(now - 180 * DAY), now)).toBe(true);
    expect(ledgerCoversAgeWindow(new Date(now - 180 * DAY + 1), now)).toBe(false);
    expect(ledgerCoversAgeWindow(null, now)).toBe(false);
  });
});
