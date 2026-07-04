// DESIGN-005 D-14 full sync through the orchestrator: fixture-driven upserts are
// idempotent, tombstones + guard behave per Q-03, per-source failures stay isolated,
// and every source gets its sync_runs row (D-11).
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems, syncRuns } from '@hnet/db/schema';
import { runSync } from '../src/index';
import {
  bootMigratedDb,
  fixture,
  fixtureArrClients,
  radarrStub,
  seriesJson,
  sonarrStub,
  type TestDb,
} from './helpers';

describe('full sync (DESIGN-005 D-14)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('creates ledger rows for all three *arrs from the recorded fixtures', async () => {
    const report = await runSync({
      mode: 'full',
      sources: ['sonarr', 'radarr', 'lidarr'],
      db: t.db,
      clients: fixtureArrClients(),
    });

    expect(report.totalFailure).toBe(false);
    expect(report.sources.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    for (const source of report.sources) {
      // lidarr's fixture carries an extra never-refreshed artist (no statistics
      // object — live drift seen 2026-07-04) to pin the optional-statistics path.
      const expected = source.source === 'lidarr' ? 4 : 3;
      expect(source.stats).toMatchObject({ itemsSeen: expected, inserted: expected, tombstoned: 0 });
    }

    // The statistics-less artist lands with nothing-on-disk counts, not a crash.
    const [neverRefreshed] = await t.db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.title, 'Never Refreshed'));
    expect(neverRefreshed).toMatchObject({
      arrKind: 'lidarr',
      onDiskFileCount: 0,
      expectedFileCount: 0,
      sizeOnDisk: '0',
    });

    // Spot-check the adapters: names/labels snapshotted, external ids per kind (D-05).
    const [gray] = await t.db.select().from(mediaItems).where(eq(mediaItems.title, 'Gray'));
    expect(gray).toMatchObject({
      arrKind: 'sonarr',
      arrInstanceId: 'main',
      qualityProfileName: 'FHD-UHD', // id 9 resolved through the profile fixture
      rootFolder: '/data/haynestower/Media/TV Shows',
    });
    expect(gray!.tvdbId).toBe(440_218);
    expect(gray!.arrAttrs).toMatchObject({ seriesType: 'standard' });

    const radarrRows = await t.db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.arrKind, 'radarr'));
    expect(radarrRows).toHaveLength(3);
    expect(radarrRows.every((r) => typeof r.tmdbId === 'number')).toBe(true);
    expect(radarrRows.every((r) => r.expectedFileCount === 1)).toBe(true);

    const lidarrRows = await t.db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.arrKind, 'lidarr'));
    expect(lidarrRows).toHaveLength(3);
    expect(lidarrRows.every((r) => /^[0-9a-f-]{36}$/.test(r.musicbrainzArtistId ?? ''))).toBe(
      true,
    );
    const not = lidarrRows.find((r) => r.title === '$NOT')!;
    expect(not.qualityProfileName).toBe('Any'); // lidarr profile 1 per the fixture
    expect(not.metadataProfileId).toBeTypeOf('number');

    // Tag labels snapshot via the sonarr fixture ("Gray" carries no tags in the
    // recorded list, so assert on the synthetic guard-library rows later; here the
    // sonarr fixture tag map resolves ids → labels for any tagged series).
    expect(gray!.arrTags).toEqual([]);

    // D-11: one sync_runs row per source, succeeded, with stats.
    const runs = await t.db.select().from(syncRuns).where(eq(syncRuns.runKind, 'full'));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'succeeded' && r.finishedAt !== null)).toBe(true);
  });

  it('is idempotent: a second identical run updates in place, no duplicates', async () => {
    const report = await runSync({
      mode: 'full',
      sources: ['sonarr', 'radarr', 'lidarr'],
      db: t.db,
      clients: fixtureArrClients(),
    });
    for (const source of report.sources) {
      expect(source.status).toBe('succeeded');
      expect(source.stats).toMatchObject({
        inserted: 0,
        updated: source.source === 'lidarr' ? 4 : 3,
        rematched: 0,
        tombstoned: 0,
      });
    }
    const all = await t.db.select().from(mediaItems);
    expect(all).toHaveLength(9);
  });

  it('tombstones a vanished item (under guard bounds) with a deleted(item_removed) event', async () => {
    const list = fixture<Array<{ id: number }>>('sonarr.series-list');
    const shrunk = list.filter((s) => s.id !== 1); // "Gray" left Sonarr
    const report = await runSync({
      mode: 'full',
      sources: ['sonarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([
          { path: '/api/v3/series', body: shrunk },
          { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('sonarr.tag') },
        ]),
      },
    });
    expect(report.sources[0]).toMatchObject({ status: 'succeeded' });
    expect(report.sources[0]!.stats).toMatchObject({ itemsSeen: 2, tombstoned: 1 });

    const [gone] = await t.db.select().from(mediaItems).where(eq(mediaItems.title, 'Gray'));
    expect(gone!.deletedFromArrAt).not.toBeNull();
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.mediaItemId, gone!.id), eq(ledgerEvents.eventType, 'deleted')));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: 'item_removed' });

    // Seen again next run → un-tombstoned (D-14 step 3).
    await runSync({
      mode: 'full',
      sources: ['sonarr'],
      db: t.db,
      clients: fixtureArrClients(),
    });
    const [back] = await t.db.select().from(mediaItems).where(eq(mediaItems.title, 'Gray'));
    expect(back!.deletedFromArrAt).toBeNull();
  });

  describe('mass-tombstone guard (Q-03: >20% AND >10 rows)', () => {
    const guardInstance = 'guard';
    const bigLibrary = Array.from({ length: 20 }, (_, i) => seriesJson(500 + i));
    const shrunkLibrary = bigLibrary.slice(0, 5); // 15/20 = 75% missing

    const sonarrWith = (series: unknown[]) =>
      sonarrStub([
        { path: '/api/v3/series', body: series },
        { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
        { path: '/api/v3/tag', body: fixture('sonarr.tag') },
      ]);

    it('trips at the threshold: run aborted, error recorded, NOTHING tombstoned', async () => {
      await runSync({
        mode: 'full',
        sources: ['sonarr'],
        arrInstanceId: guardInstance,
        db: t.db,
        clients: { sonarr: sonarrWith(bigLibrary) },
      });
      // Tag ids resolved to LABEL snapshots via the tag fixture (D-05 decision 3).
      const [seeded] = await t.db
        .select()
        .from(mediaItems)
        .where(and(eq(mediaItems.arrInstanceId, guardInstance), eq(mediaItems.arrItemId, 500)));
      expect(seeded!.arrTags).toEqual(['mediarequests']);

      const report = await runSync({
        mode: 'full',
        sources: ['sonarr'],
        arrInstanceId: guardInstance,
        db: t.db,
        clients: { sonarr: sonarrWith(shrunkLibrary) },
      });
      expect(report.sources[0]!.status).toBe('aborted');
      expect(report.sources[0]!.error).toMatch(/--force-tombstones/);
      expect(report.totalFailure).toBe(true); // the only requested source did not succeed

      const [run] = await t.db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.id, report.sources[0]!.runId!));
      expect(run).toMatchObject({ status: 'aborted' });
      expect(run!.error).toMatch(/would tombstone 15 of 20/);

      const rows = await t.db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.arrInstanceId, guardInstance));
      expect(rows.every((r) => r.deletedFromArrAt === null)).toBe(true);
    });

    it('--force-tombstones overrides the guard', async () => {
      const report = await runSync({
        mode: 'full',
        sources: ['sonarr'],
        arrInstanceId: guardInstance,
        forceTombstones: true,
        db: t.db,
        clients: { sonarr: sonarrWith(shrunkLibrary) },
      });
      expect(report.sources[0]!.status).toBe('succeeded');
      expect(report.sources[0]!.stats).toMatchObject({ tombstoned: 15 });

      const rows = await t.db
        .select()
        .from(mediaItems)
        .where(
          and(
            eq(mediaItems.arrInstanceId, guardInstance),
            inArray(
              mediaItems.arrItemId,
              bigLibrary.slice(5).map((s) => s.id as number),
            ),
          ),
        );
      expect(rows).toHaveLength(15);
      expect(rows.every((r) => r.deletedFromArrAt !== null)).toBe(true);
    });
  });

  it('isolates failures per source: sonarr down, radarr still syncs (D-14)', async () => {
    const report = await runSync({
      mode: 'full',
      sources: ['sonarr', 'radarr'],
      arrInstanceId: 'iso',
      db: t.db,
      clients: {
        // Everything Sonarr 500s (list, profiles, tags) — the instance is down.
        sonarr: sonarrStub([{ path: /^\/api\/v3\//, status: 500, body: { error: 'down' } }]),
        radarr: radarrStub([
          { path: '/api/v3/movie', body: fixture('radarr.movie-list') },
          { path: '/api/v3/qualityprofile', body: fixture('radarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('radarr.tag') },
        ]),
      },
    });

    expect(report.sources[0]).toMatchObject({ source: 'sonarr', status: 'failed' });
    expect(report.sources[0]!.error).toMatch(/HTTP 500/);
    expect(report.sources[1]).toMatchObject({ source: 'radarr', status: 'succeeded' });
    expect(report.totalFailure).toBe(false);

    const [failedRun] = await t.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, report.sources[0]!.runId!));
    expect(failedRun).toMatchObject({ status: 'failed' });
    expect(failedRun!.error).toMatch(/HTTP 500/);
  });
});
