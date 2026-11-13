// ADR-117 / DESIGN-052 D-29 — the posted-name backfill and the download-history page read, on embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
} from '@hnet/db/schema';
import {
  RELEASE_BLOCK_SENTINEL,
  RELEASE_BLOCK_TERM_CAP,
  RELEASE_TERM_LIFETIME_DAYS,
  backfillPostedReleaseNames,
  createStaticReleaseBlockArr,
  downloadHistoryFromEnv,
  loadReleaseDownloadHistory,
  silentDomainLogger,
  type DomainLogger,
  type PostedNameBackfillClass,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const DAY = 86_400_000;
const NOW = new Date('2026-11-13T18:00:00Z');
const DELETED = new Date('2026-08-01T00:00:00Z');
const EXPIRED = new Date('2024-01-01T00:00:00Z');

function sums(row: PostedNameBackfillClass): void {
  expect(row.expired + row.named + row.unnamed + row.noNewTerm).toBe(row.candidates);
}

describe('download history paging (D-29)', () => {
  it('reads both views a page at a time and stops on a short page', async () => {
    const calls: Array<{ archive: boolean; start: number }> = [];
    const page = (slotCount: number) => ({
      jobs: Array.from({ length: slotCount }, (_, i) => ({
        name: `Name.${slotCount}.${i}.2020.1080p.BluRay.x264-GRP`,
        bytes: 100,
        completedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      slotCount,
    });
    const { jobs, truncated } = await loadReleaseDownloadHistory({
      listReleaseJobs: async (query) => {
        calls.push({ archive: query.archive, start: query.start });
        if (!query.archive && query.start === 0) return page(1000);
        return page(2);
      },
    });
    expect(truncated).toBe(false);
    expect(calls).toEqual([
      { archive: false, start: 0 },
      { archive: false, start: 1000 },
      { archive: true, start: 0 },
    ]);
    expect(jobs).toHaveLength(1004);
  });

  it('a missing key does not throw and returns no jobs', async () => {
    const warnings: string[] = [];
    const logger: DomainLogger = {
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
    };
    expect(await downloadHistoryFromEnv({}, logger)).toBeUndefined();
    expect(warnings).toEqual(['[release-block] download_history_unavailable']);
  });
});

describe('the posted-name backfill (DESIGN-052 D-29)', () => {
  let t: TestDb;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertBoth();
    for (const row of await t.db.select().from(mediaItems)) ids[row.title] = row.id;
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(trashBatchItems);
    await t.db.delete(trashBatches);
    await t.db.delete(ledgerEvents);
  });

  async function upsertBoth(): Promise<void> {
    const { upsertMediaItemsBatch } = await import('../src/index');
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        ['Posted Movie', 7001, 2020],
        ['Renamed Movie', 7002, 2019],
        ['Live Movie', 7003, 2018],
        ['Old Movie', 7004, 2017],
        ['Sized Movie', 7005, 2016],
      ].map(([title, tmdbId, year], i) => ({
        arrItemId: 800 + i,
        tmdbId: tmdbId as number,
        title: title as string,
        sortTitle: String(title).toLowerCase(),
        year: year as number,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 80,
          tvdbId: 8001,
          title: 'Nameless Show',
          sortTitle: 'nameless show',
          year: 2015,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
  }

  async function deletedBatch(
    kind: 'movie' | 'tv',
    rows: Array<{
      title: string;
      year: number;
      tmdbId?: number;
      tvdbId?: number;
      deletedAt: Date;
      size?: number;
    }>,
  ): Promise<void> {
    const [batch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: kind, state: 'deleted', deletedAt: rows[0]!.deletedAt })
      .returning();
    await t.db.insert(trashBatchItems).values(
      rows.map((row, i) => ({
        batchId: batch!.id,
        maintainerrMediaId: `bf-${kind}-${i}`,
        mediaItemId: ids[row.title]!,
        title: row.title,
        year: row.year,
        tmdbId: row.tmdbId ?? null,
        tvdbId: row.tvdbId ?? null,
        state: 'deleted' as const,
        deletedAt: row.deletedAt,
        deletedSizeBytes: row.size ?? null,
      })),
    );
  }

  it('dry-run counts each class and writes nothing; apply keeps the renamed row and blocks the verified names', async () => {
    await t.db.update(mediaItems).set({ deletedFromArrAt: DELETED });
    await t.db.update(mediaItems).set({ deletedFromArrAt: null }).where(eq(mediaItems.tmdbId, 7003));
    await deletedBatch('movie', [
      { title: 'Posted Movie', year: 2020, tmdbId: 7001, deletedAt: DELETED, size: 5_000 },
      { title: 'Renamed Movie', year: 2019, tmdbId: 7002, deletedAt: DELETED, size: 5_000 },
      { title: 'Live Movie', year: 2018, tmdbId: 7003, deletedAt: DELETED, size: 5_000 },
      { title: 'Old Movie', year: 2017, tmdbId: 7004, deletedAt: EXPIRED, size: 5_000 },
      { title: 'Sized Movie', year: 2016, tmdbId: 7005, deletedAt: DELETED, size: 9_600 },
    ]);
    await deletedBatch('tv', [{ title: 'Nameless Show', year: 2015, tvdbId: 8001, deletedAt: DELETED }]);
    await t.db.insert(ledgerEvents).values([
      {
        mediaItemId: ids['Posted Movie']!,
        eventType: 'grabbed',
        source: 'radarr',
        sourceEventId: 'bf-g1',
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        payload: {
          sourceTitle: 'Posted.Movie.2020.1080p.BluRay.x264-GRP',
          releaseGroup: 'GRP',
          quality: 'Bluray-1080p',
          indexer: 'indexer A',
        },
      },
      {
        mediaItemId: ids['Posted Movie']!,
        eventType: 'download_failed',
        source: 'radarr',
        sourceEventId: 'bf-f1',
        occurredAt: new Date('2026-06-01T00:00:00Z'),
        payload: { sourceTitle: 'Posted.Movie.2020.720p.WEB.x264-OTHER', releaseGroup: 'OTHER', quality: 'WEBDL-720p' },
      },
      {
        mediaItemId: ids['Posted Movie']!,
        eventType: 'grabbed',
        source: 'radarr',
        sourceEventId: 'bf-url',
        occurredAt: new Date('2026-05-01T00:00:00Z'),
        payload: { sourceTitle: 'https://download.example/get?id=1' },
      },
      {
        mediaItemId: ids['Renamed Movie']!,
        eventType: 'grabbed',
        source: 'radarr',
        sourceEventId: 'bf-g2',
        occurredAt: new Date('2026-07-02T00:00:00Z'),
        payload: { sourceTitle: 'Renamed.Movie.2019.1080p.BluRay.x264-SPARKS', releaseGroup: 'SPARKS', quality: 'Bluray-1080p' },
      },
    ]);
    await t.db.insert(trashDeletedReleases).values({
      arrKind: 'radarr',
      tmdbId: 7002,
      mediaItemId: ids['Renamed Movie']!,
      title: 'Renamed Movie',
      year: 2019,
      identitySource: 'arr_file',
      termConfidence: 'low_confidence',
      term: '/^kept(?:[^a-z0-9]|$)/i',
      state: 'active',
      origin: 'sweep',
      recordedAt: DELETED,
      expiresAt: new Date(DELETED.getTime() + RELEASE_TERM_LIFETIME_DAYS * DAY),
    });
    const jobs = [
      {
        name: 'Sized.Movie.2016.1080p.BluRay.x264-GRP',
        bytes: 10_000,
        completedAt: new Date('2026-07-01T00:00:00Z'),
      },
    ];
    const { arr, fixture } = createStaticReleaseBlockArr({ synthesize: false });
    const dry = await backfillPostedReleaseNames({
      db: t.db,
      arr,
      apply: false,
      legacySab: jobs,
      now: NOW,
      logger: silentDomainLogger,
    });
    expect(dry.apply).toBe(false);
    expect(dry.reconciled).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(await t.db.select().from(trashDeletedReleases)).toHaveLength(1);
    sums(dry.lowConfidence);
    sums(dry.movies);
    sums(dry.shows);
    expect(dry.lowConfidence).toMatchObject({ candidates: 1, named: 1, records: 1, unnamed: 0 });
    expect(dry.movies).toMatchObject({
      candidates: 3,
      named: 2,
      expired: 1,
      unnamed: 0,
      skippedLive: 1,
    });
    expect(dry.movies.records).toBe(3);
    expect(dry.movies.urlsSkipped).toBe(1);
    expect(dry.lowConfidence.urlsSkipped).toBe(0);
    expect(dry.shows).toMatchObject({ candidates: 1, unnamed: 1, named: 0, skippedLive: 0 });
    // The URL was on Posted Movie, which is in the movies class (no low-confidence row).
    expect(dry.movies.namesSeen).toBeGreaterThan(0);

    const applied = await backfillPostedReleaseNames({
      db: t.db,
      arr,
      apply: true,
      legacySab: jobs,
      now: NOW,
      logger: silentDomainLogger,
    });
    expect(applied.lowConfidence.records).toBe(1);
    expect(applied.reconciled.map((row) => row.arrKind)).toEqual(['radarr']);
    const rows = await t.db.select().from(trashDeletedReleases);
    const renamed = rows.filter((row) => row.tmdbId === 7002 && row.identitySource === 'arr_file');
    expect(renamed).toHaveLength(1);
    expect(rows.filter((row) => row.tmdbId === 7002 && row.identitySource === 'ledger_grab' && row.state === 'active')).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.tmdbId === 7001 && row.state === 'active').map((row) => row.identitySource).sort()).toEqual([
      'ledger_grab',
      'ledger_grab',
    ]);
    expect(rows.filter((row) => row.tmdbId === 7005 && row.identitySource === 'legacy_sab')).toHaveLength(1);
    expect(rows.some((row) => row.tmdbId === 7004)).toBe(false);
    expect(rows.some((row) => row.tmdbId === 7003)).toBe(false);
    expect(rows.some((row) => (row.releaseTitle ?? '').includes('://'))).toBe(false);
    expect(fixture.profiles.radarr[0]!.ignored).toContain(RELEASE_BLOCK_SENTINEL);
    const verified = rows.find((row) => row.tmdbId === 7001);
    expect(fixture.profiles.radarr[0]!.ignored).toContain(verified!.term);

    const second = await backfillPostedReleaseNames({
      db: t.db,
      arr,
      apply: false,
      legacySab: jobs,
      now: NOW,
      logger: silentDomainLogger,
    });
    expect(second.movies.named).toBe(0);
    expect(second.lowConfidence.named).toBe(0);
  });

  it('apply respects the 3,000-term cap through the same reconcile', async () => {
    await t.db.update(mediaItems).set({ deletedFromArrAt: DELETED }).where(eq(mediaItems.tmdbId, 7001));
    await deletedBatch('movie', [{ title: 'Posted Movie', year: 2020, tmdbId: 7001, deletedAt: DELETED, size: 5_000 }]);
    await t.db.insert(ledgerEvents).values({
      mediaItemId: ids['Posted Movie']!,
      eventType: 'grabbed',
      source: 'radarr',
      sourceEventId: 'bf-cap',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      payload: { sourceTitle: 'Posted.Movie.2020.1080p.BluRay.x264-CAPGRP', releaseGroup: 'CAPGRP', quality: 'Bluray-1080p' },
    });
    const old = new Date(NOW.getTime() - 10 * DAY);
    await t.db.insert(trashDeletedReleases).values(
      Array.from({ length: RELEASE_BLOCK_TERM_CAP }, (_, i) => ({
        arrKind: 'radarr' as const,
        title: `cap${i}`,
        identitySource: 'arr_file' as const,
        term: `/^c${i}(?:[^a-z0-9]|$)/i`,
        state: 'active' as const,
        origin: 'sweep' as const,
        recordedAt: new Date(old.getTime() + i),
        expiresAt: new Date(NOW.getTime() + DAY),
      })),
    );
    const { arr, fixture } = createStaticReleaseBlockArr({ synthesize: false });
    const report = await backfillPostedReleaseNames({
      db: t.db,
      arr,
      apply: true,
      now: NOW,
      logger: silentDomainLogger,
    });
    expect(report.movies.records).toBe(1);
    expect(report.reconciled[0]).toMatchObject({ pruned: 1, total: RELEASE_BLOCK_TERM_CAP });
    expect(fixture.profiles.radarr[0]!.ignored).toHaveLength(RELEASE_BLOCK_TERM_CAP + 1);
    const added = (await t.db.select().from(trashDeletedReleases)).find((row) => row.origin === 'backfill');
    expect(fixture.profiles.radarr[0]!.ignored).toContain(added!.term);
    expect(fixture.profiles.radarr[0]!.ignored).not.toContain('/^c0(?:[^a-z0-9]|$)/i');
  });
});
