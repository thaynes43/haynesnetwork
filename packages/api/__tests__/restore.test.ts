// DESIGN-005 D-16/D-17 — restore router integration tests: embedded PG16 +
// fetch-stubbed *arr bundles. Covers AC-09: the diff lists exactly the ledger items
// absent from the live *arr (tombstoned included), execute re-adds them monitored
// with mapped profile/folder/tags and searches OFF, and the run row is the report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import { tombstoneMissingItems } from '@hnet/domain';
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

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

describe('restore.diff / restore.execute (AC-09)', () => {
  it('diffs by external id, re-adds with searches OFF, and reports per item', async () => {
    const admin = await createUser(tdb.db, { admin: true });

    // Three monitored sonarr rows; the live *arr only still has 'Kept Show'.
    // 'Lost Show' is additionally tombstoned (the disaster case, D-16 step 1).
    const kept = await seedMediaItem(tdb.db, 'sonarr', {
      title: 'Kept Show',
      arrItemId: 701,
      tvdbId: 900701,
    });
    const lost = await seedMediaItem(tdb.db, 'sonarr', {
      title: 'Lost Show',
      arrItemId: 702,
      tvdbId: 900702,
      qualityProfileName: 'HD-1080p',
      arrTags: ['mediarequests', 'brand-new-tag'],
      arrAttrs: { seriesType: 'anime', seasonFolder: false, monitorNewItems: 'all' },
    });
    const missing = await seedMediaItem(tdb.db, 'sonarr', {
      title: 'Missing Show',
      arrItemId: 703,
      tvdbId: 900703,
      qualityProfileName: 'HD-1080p',
    });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'sonarr', seenArrItemIds: [701, 703] });

    let nextTagId = 40;
    let seriesSeq = 0;
    const stub = stubArrBundle([
      { path: '/api/v3/series', body: [seriesJson(701, { tvdbId: 900701 })], method: 'GET' },
      {
        path: '/api/v3/qualityprofile',
        body: [
          { id: 11, name: 'HD-1080p' },
          { id: 1, name: 'Any' },
        ],
      },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/data/haynestower/Media/TV Shows' }] },
      { path: '/api/v3/tag', body: [{ id: 5, label: 'mediarequests' }] },
      {
        method: 'POST',
        path: '/api/v3/tag',
        body: (url: URL) => ({ id: ++nextTagId, label: `created-${url.pathname.length}` }),
      },
      {
        method: 'POST',
        path: '/api/v3/series',
        status: 201,
        body: () => seriesJson(7000 + ++seriesSeq, { tvdbId: 900702 }),
      },
    ]);

    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    // ---- Diff (D-16 step 1): exactly the two absent rows, tombstone badged. ----
    const diff = await api.restore.diff({ arrKind: 'sonarr' });
    const byId = new Map(diff.map((d) => [d.mediaItemId, d]));
    expect(byId.has(kept.id)).toBe(false);
    expect(byId.get(lost.id)).toMatchObject({
      title: 'Lost Show',
      externalId: '900702',
      qualityProfileName: 'HD-1080p',
      arrTags: ['mediarequests', 'brand-new-tag'],
    });
    expect(byId.get(lost.id)!.tombstonedAt).not.toBeNull();
    expect(byId.get(missing.id)!.tombstonedAt).toBeNull();

    // ---- Execute (D-16 step 2): approved = both; kept id sneaks in → skipped. ----
    const { runId, status } = await api.restore.execute({
      arrKind: 'sonarr',
      mediaItemIds: [lost.id, missing.id, kept.id],
    });
    expect(status).toBe('completed');

    const adds = stub.callsFor('POST', '/api/v3/series');
    expect(adds).toHaveLength(2);
    const lostAdd = adds.find((c) => (c.body as { tvdbId: number }).tvdbId === 900702)!;
    expect(lostAdd.body).toMatchObject({
      title: 'Lost Show',
      qualityProfileId: 11, // remapped BY NAME, not the snapshot id
      rootFolderPath: '/data/haynestower/Media/TV Shows',
      monitored: true,
      seasonFolder: false,
      seriesType: 'anime',
      addOptions: { monitor: 'all', searchForMissingEpisodes: false }, // Q-04: searches OFF
    });
    // Tag labels resolved against live ids; the missing label was created first.
    expect((lostAdd.body as { tags: number[] }).tags).toContain(5);
    expect(stub.callsFor('POST', '/api/v3/tag')).toHaveLength(1);

    // ---- Report (AC-09): run row has preview + per-item results + counts. ----
    const run = await api.restore.run({ id: runId });
    expect(run.status).toBe('completed');
    expect(run.itemCount).toBe(2);
    expect(run.successCount).toBe(2);
    expect(run.preview.map((p) => p.mediaItemId).sort()).toEqual([lost.id, missing.id].sort());
    const skipped = run.results.find((r) => r.mediaItemId === kept.id)!;
    expect(skipped.ok).toBe(false);
    expect(skipped.error).toContain('already present');
    expect(run.results.filter((r) => r.ok)).toHaveLength(2);
    expect(run.initiatedByDisplayName).toBe(admin.displayName);

    // Success clears the tombstone and adopts the new *arr id (D-16 write-back).
    const [restored] = await tdb.db
      .select()
      .from(schema.mediaItems)
      .where(eq(schema.mediaItems.id, lost.id));
    expect(restored!.deletedFromArrAt).toBeNull();
    expect(restored!.arrItemId).toBeGreaterThan(7000);
    const events = await tdb.db
      .select({ eventType: schema.ledgerEvents.eventType })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.mediaItemId, lost.id));
    expect(events.map((e) => e.eventType)).toContain('restored');

    // The runs list surfaces it (R-52 audit browsing).
    const runs = await api.restore.runs();
    expect(runs.some((r) => r.id === runId)).toBe(true);
  });

  it('records an unmapped quality profile as a per-item failure (never a default)', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const item = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Orphan Movie',
      arrItemId: 801,
      tmdbId: 950801,
      qualityProfileName: 'UHD-Remux', // absent from the live target
      rootFolder: '/data/haynestower/Media/Movies',
    });
    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [] },
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/data/haynestower/Media/Movies' }] },
      { path: '/api/v3/tag', body: [] },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    const { runId, status } = await api.restore.execute({
      arrKind: 'radarr',
      mediaItemIds: [item.id],
    });
    expect(status).toBe('completed_with_errors');
    const run = await api.restore.run({ id: runId });
    expect(run.successCount).toBe(0);
    expect(run.results[0]).toMatchObject({ mediaItemId: item.id, ok: false });
    expect(run.results[0]!.error).toContain("quality profile 'UHD-Remux' not found");
    expect(stub.callsFor('POST', '/api/v3/movie')).toHaveLength(0); // no blind re-add
  });

  // ADR-022 C-02 — restore_runs is shared between the failsafe Restore (reason 'restore')
  // and the Ledger Add-&-search (reason 'ledger_add'); the admin Restore projections MUST be
  // reason-scoped so a ledger_add run never leaks into restore.run / restore.runs.
  it('a Ledger add run (reason ledger_add) is NOT visible via restore.run/runs', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const absent = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Ledger Add Only',
      arrItemId: 7301,
      tmdbId: 973001,
      monitored: false,
      qualityProfileName: 'Any',
      rootFolder: '/movies',
    });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [] });

    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [] }, // nothing live → absent → add
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/movies' }] },
      { path: '/api/v3/tag', body: [] },
      { method: 'POST', path: '/api/v3/movie', status: 201, body: () => movieJson(6301, { tmdbId: 973001, monitored: true }) },
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 1, name: 'MoviesSearch' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));

    // Create the ledger_add run through the Ledger surface (admin has 'edit' everywhere).
    const { runId } = await api.ledgerAdmin.bulkAddAndSearch({
      arrKind: 'radarr',
      mediaItemIds: [absent.id],
      searchOnAdd: true,
    });

    // Reason-scoped Restore projections must NOT surface it (the C-02 defect).
    await expect(api.restore.run({ id: runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.restore.runs()).some((r) => r.id === runId)).toBe(false);

    // Positive control: it IS visible via the reason-scoped Ledger projections.
    expect((await api.ledgerAdmin.run({ id: runId })).reason).toBe('ledger_add');
    expect((await api.ledgerAdmin.runs()).some((r) => r.id === runId)).toBe(true);
  });

  it('a Restore run (reason restore) is visible via restore.run/runs but NOT ledgerAdmin.run', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const item = await seedMediaItem(tdb.db, 'radarr', {
      title: 'Restore Scoped',
      arrItemId: 7401,
      tmdbId: 974001,
      qualityProfileName: 'Any',
      rootFolder: '/movies',
    });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [] });
    const stub = stubArrBundle([
      { path: '/api/v3/movie', body: [] },
      { path: '/api/v3/qualityprofile', body: [{ id: 1, name: 'Any' }] },
      { path: '/api/v3/rootfolder', body: [{ id: 1, path: '/movies' }] },
      { path: '/api/v3/tag', body: [] },
      { method: 'POST', path: '/api/v3/movie', status: 201, body: () => movieJson(6401, { tmdbId: 974001 }) },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));
    const { runId } = await api.restore.execute({ arrKind: 'radarr', mediaItemIds: [item.id] });

    expect((await api.restore.run({ id: runId })).id).toBe(runId);
    expect((await api.restore.runs()).some((r) => r.id === runId)).toBe(true);
    await expect(api.ledgerAdmin.run({ id: runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('surfaces a dead *arr as ARR_UPSTREAM_UNAVAILABLE on diff', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const stub = stubArrBundle([
      { path: '/api/v1/artist', status: 500, body: { message: 'down' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));
    await expect(api.restore.diff({ arrKind: 'lidarr' })).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
    });
  });
});
