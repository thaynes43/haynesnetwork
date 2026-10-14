import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  repairRequests,
  watchCarries,
  arrQueueCleanupActions,
} from '@hnet/db';
import {
  buildArrClientBundle,
  createFixRequest,
  recordFixAction,
  ingestLedgerEvents,
  upsertMediaItemsBatch,
  setRepairGuideRemedies,
  planWrongContentRetry,
  runWrongContentRetry,
  planOwnedSonarrImport,
  runOwnedSonarrImport,
  completeFixRequests,
  deferredWrongContentFailures,
  buildQueueCleanupClients,
  evaluateQueueCleanup,
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  WRONG_CONTENT_RETRY_HOLD,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const OLD =
  'Mickey.Mouse..MixedUp.Adventures.S01E07E08.Agent.DoubleOGoof..Eggxasperating.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor';
const RIGHT =
  'Mickey.And.The.Roadster.Racers.S01E07-E08.Agent.Double-O-Goof.&amp;.Egg-xasperating.1080p.WEBRip.10bit.EAC3.2.0.x265-iVy';
const WRONG =
  'Mickey.Mouse.Mixed-up.Adventures.S01E04.Mickeys.Monstrous.Truck.Minnies.Vacation.Home.1080p.DSNP.WEB-DL.AAC2.0.H.264-CRFW';
const QUALITY = {
  quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
  revision: { version: 1, real: 0, isRepack: false },
};
const SERIES = JSON.parse(
  readFileSync(new URL('../../arr/__fixtures__/sonarr.series-byid.json', import.meta.url), 'utf8'),
);
const actor = { kind: 'staff' as const },
  evidence = 'Physical English and both canonical stories must be verified before any import.';
function stub() {
  const ep = (id: number, n: number, title: string, fileId = 0, season = 1) => ({
    id,
    seriesId: 439,
    seasonNumber: season,
    episodeNumber: n,
    title,
    monitored: true,
    hasFile: fileId > 0,
    episodeFileId: fileId,
  });
  const state = {
    episodes: [
      ep(37187, 7, 'Agent Double-O-Goof'),
      ep(37188, 8, 'Egg-xasperating!'),
      ep(37193, 13, 'Ye Olde Royal Heist', 65359),
      ep(37194, 14, 'Tea Time Trouble!', 65359),
      ep(37195, 15, 'Abra-ka-Goof!', 65359),
      ep(37196, 16, 'Happy Birthday Helpers!', 65359),
      ep(37289, 7, "Mickey's Monstrous Truck", 65380, 3),
      ep(37290, 8, "Minnie's Vacation Home!", 65380, 3),
    ],
    files: [
      { id: 65359, seriesId: 439, relativePath: 'protected-original13-16.mkv', size: 1377201632 },
      { id: 65380, seriesId: 439, relativePath: 'correct-s3-7-8.mkv', size: 1561109038 },
    ],
    history: [] as Array<{
      id: number;
      seriesId: number;
      eventType: string;
      episodeId: number;
      downloadId: string;
      sourceTitle: string;
      date: string;
      data: Record<string, string>;
    }>,
    queueTitle: WRONG,
    download: 'f707',
    removed: false,
    retryGrabbed: false,
    deleteUncertain: false,
    grabUncertain: false,
    grabAcceptedButError: false,
    newGrabWrongTargets: false,
    afterDelete: null as null | (() => void),
    rejections: [] as string[],
    writes: [] as Array<{ path: string; body: unknown }>,
    pages: [] as string[],
    candidateSize: 1560855497,
  };
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const u = new URL(String(input)),
      method = init.method ?? 'GET',
      body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET') {
      if (u.pathname.endsWith('/config/downloadclient'))
        return json({ autoRedownloadFailed: false });
      if (u.pathname.endsWith('/history/since')) return json(state.history);
      if (u.pathname.endsWith('/history/series')) return json(state.history);
      if (u.pathname.endsWith('/history')) {
        state.pages.push(u.search);
        return json({
          page: 1,
          pageSize: 200,
          totalRecords: state.history.length,
          records: state.history,
        });
      }
      if (u.pathname.endsWith('/episode')) return json(state.episodes);
      if (u.pathname.endsWith('/episodefile'))
        return json(state.files.map((f) => ({ ...f, quality: QUALITY, mediaInfo: {} })));
      if (u.pathname.endsWith('/series/439')) return json({ ...SERIES, id: 439, year: 2017 });
      if (u.pathname.endsWith('/release'))
        return json([
          {
            guid: 'distinct-ivy',
            indexerId: 1,
            indexer: 'Fixture',
            title: RIGHT,
            releaseGroup: 'iVy',
            quality: QUALITY,
            size: 682447000,
            languages: [{ id: 1, name: 'English' }],
            seasonNumber: 1,
            episodeNumbers: [7, 8],
            mappedSeasonNumber: 1,
            mappedEpisodeNumbers: [13, 14, 15, 16],
            approved: false,
            rejected: true,
            rejections: state.rejections,
            downloadAllowed: true,
            protocol: 'usenet',
          },
        ]);
      if (u.pathname.endsWith('/queue'))
        return json({
          page: 1,
          pageSize: 200,
          totalRecords: state.removed ? 0 : 2,
          records: state.removed
            ? []
            : [37187, 37188].map((episodeId, i) => ({
                id: 1000 + i,
                seriesId: 439,
                episodeId,
                downloadId: state.download,
                title: state.queueTitle,
                status: 'completed',
                trackedDownloadState: 'importPending',
                trackedDownloadStatus: 'warning',
                statusMessages: [],
              })),
        });
      if (u.pathname.endsWith('/manualimport'))
        return json([
          {
            id: 42,
            path: `/downloads/${state.queueTitle}.mkv`,
            size: state.candidateSize,
            downloadId: state.download,
            folderName: state.queueTitle,
            series: { id: 439, year: 2017 },
            seasonNumber: 1,
            episodes: state.episodes.filter((e) => [37187, 37188].includes(e.id)),
            quality: QUALITY,
            languages: [{ id: 1, name: 'English' }],
            releaseGroup: state.retryGrabbed ? 'iVy' : 'CRFW',
            indexerFlags: 0,
            releaseType: 'multiEpisode',
            rejections: [],
          },
        ]);
      if (u.pathname.endsWith('/command/77'))
        return json({ id: 77, name: 'ManualImport', status: 'completed' });
    }
    state.writes.push({
      path: u.pathname,
      body: method === 'DELETE' ? Object.fromEntries(u.searchParams) : body,
    });
    if (method === 'DELETE' && u.pathname === '/api/v3/queue/1000') {
      state.removed = true;
      state.afterDelete?.();
      return state.deleteUncertain
        ? json({ message: 'uncertain DELETE' }, 503)
        : new Response(null, { status: 200 });
    }
    if (method === 'POST' && u.pathname.endsWith('/release')) {
      if (state.grabUncertain && !state.grabAcceptedButError)
        return json({ message: 'uncertain GRAB' }, 503);
      state.retryGrabbed = true;
      state.removed = false;
      state.download = 'new-ivy';
      state.queueTitle = RIGHT;
      state.candidateSize = 682447000;
      for (const episodeId of state.newGrabWrongTargets
        ? [37193, 37194, 37195, 37196]
        : body.episodeIds)
        state.history.unshift({
          id: 67000 + episodeId,
          seriesId: 439,
          eventType: 'grabbed',
          episodeId,
          downloadId: state.download,
          sourceTitle: RIGHT,
          date: new Date().toISOString(),
          data: {},
        });
      return state.grabAcceptedButError
        ? json({ message: 'accepted but response lost' }, 503)
        : json({});
    }
    if (method === 'POST' && u.pathname.endsWith('/manualimport'))
      return json(
        body.map((f: Record<string, unknown>) => ({
          ...f,
          episodes: state.episodes.filter((e) => (f.episodeIds as number[]).includes(e.id)),
          rejections: [],
        })),
      );
    if (method === 'POST' && u.pathname.endsWith('/command')) {
      if (body.name === 'EpisodeSearch')
        return json({ id: 88, name: 'EpisodeSearch', status: 'completed' });
      for (const f of body.files)
        for (const id of f.episodeIds) {
          const e = state.episodes.find((e) => e.id === id)!;
          e.hasFile = true;
          e.episodeFileId = 80025;
          state.history.unshift({
            id: 68000 + id,
            seriesId: 439,
            eventType: 'downloadFolderImported',
            episodeId: id,
            downloadId: state.download,
            sourceTitle: RIGHT,
            date: new Date().toISOString(),
            data: { fileId: '80025' },
          });
        }
      state.files.push({
        id: 80025,
        seriesId: 439,
        relativePath: 'new-correct7-8.mkv',
        size: 682447000,
      });
      return json({ id: 77, name: 'ManualImport', status: 'completed' });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  }) as typeof fetch;
  const opts = { apiKey: 'fixture', fetchImpl, retries: 0, baseUrl: 'http://sonarr.test' };
  return {
    state,
    arr: buildArrClientBundle({ sonarr: opts, radarr: opts, lidarr: opts, bazarr: opts }),
  };
}

describe('same-parent staff wrong-content failed-grab recovery', () => {
  let t: TestDb, itemId: string, userId: string;
  beforeAll(async () => {
    t = await bootMigratedDb();
    userId = (await createUser(t.db)).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 439,
          tvdbId: 320725,
          title: 'Mickey',
          sortTitle: 'Mickey',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    itemId = (await t.db.select().from(mediaItems))[0]!.id;
    await setRepairGuideRemedies({
      db: t.db,
      remedies: { release_pick: true, import_check: true },
      actorId: null,
    });
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(async () => {
    await t.db.delete(arrQueueCleanupActions);
    await t.db.delete(repairRequests);
    await t.db.delete(watchCarries);
    await t.db.delete(fixRequests);
    await t.db.delete(ledgerEvents);
  });
  async function setup(s = stub()) {
    const { fixRequestId } = await createFixRequest({
      db: t.db,
      requesterId: null,
      mediaItemId: itemId,
      reason: 'wrong_content',
      scope: 'episode',
      targetArrChildId: 37187,
    });
    const at = new Date().toISOString();
    await recordFixAction({
      db: t.db,
      fixRequestId,
      transition: 'actioned',
      pathTaken: 'delete_search',
      actions: [
        { step: 'wrong_content_replace', at },
        { step: 'grab_intent', at, title: OLD, episodeIds: [37187, 37188] },
        { step: 'release_grab', at, ok: true, release: OLD },
      ],
    });
    await recordFixAction({ db: t.db, fixRequestId, transition: 'search_triggered' });
    // A faithful durable version-1 carry from the already-completed original deletion; no live Plex is used.
    const [carry] = await t.db
      .insert(watchCarries)
      .values({
        kind: 'wrong_content',
        mediaItemId: itemId,
        seriesId: 439,
        status: 'verified',
        takenAt: new Date(),
        detail: {
          fixRequestId,
          releases: [OLD],
          wrongContentDeletion: {
            version: 1,
            grabStarted: true,
            files: [
              { id: 24806, name: 'old-wrong7-8.mkv', size: 1560855497, episodeIds: [37187, 37188] },
            ],
          },
        },
      })
      .returning();
    // Synthetic drift regression: live 66838/66839 were E7/E8; this fixture deliberately uses E13/E14.
    // The genuine download binding, not these synthetic reparsed numbers, identifies the original stored slot.
    for (const [id, episodeId, eventType] of [
      [66838, 37193, 'grabbed'],
      [66839, 37194, 'grabbed'],
      [66840, 37193, 'downloadFailed'],
      [66841, 37194, 'downloadFailed'],
    ] as const)
      s.state.history.push({
        id,
        seriesId: 439,
        eventType,
        episodeId,
        downloadId: '301dc',
        sourceTitle: OLD,
        date: at,
        data: eventType === 'downloadFailed' ? { message: 'Duplicate NZB' } : {},
      });
    for (const episodeId of [37187, 37188])
      s.state.history.push({
        id: 66844 + episodeId - 37187,
        seriesId: 439,
        eventType: 'grabbed',
        episodeId,
        downloadId: 'f707',
        sourceTitle: WRONG,
        date: at,
        data: {},
      });
    await ingestLedgerEvents({
      db: t.db,
      source: 'sonarr',
      events: s.state.history.map((h) => ({
        mediaItemId: itemId,
        eventType: h.eventType === 'grabbed' ? ('grabbed' as const) : ('download_failed' as const),
        source: 'sonarr' as const,
        sourceEventId: String(h.id),
        occurredAt: new Date(h.date),
        payload: {
          downloadId: h.downloadId,
          sourceTitle: h.sourceTitle,
          episodeId: h.episodeId,
          seriesId: 439,
        },
      })),
    });
    return {
      ...s,
      fixRequestId,
      carryId: carry!.id,
      input: { db: t.db, arr: s.arr, actor, fixRequestId, conflictingDownloadId: 'f707' },
    };
  }
  async function selected(input: Parameters<typeof planWrongContentRetry>[0]) {
    const p = await planWrongContentRetry(input);
    return p.candidates.length ? planWrongContentRetry({ ...input, key: p.candidates[0]!.key }) : p;
  }
  it('binds the actual failed download despite raw numbers, discards once without search, and imports through the original parent', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    expect(plan.targetEpisodeIds).toEqual([37187, 37188]);
    expect(plan.failedDownloadId).toBe('301dc');
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.title).toBe(RIGHT);
    const result = await runWrongContentRetry({
      ...s.input,
      digest: plan.digest,
      key: plan.candidates[0]!.key,
      evidence,
      conflictEvidence: 'Physical English subtitles and two stories prove this source is S3 E7/E8.',
    });
    expect(result.outcome).toBe('grabbed');
    expect(s.state.writes).toEqual([
      {
        path: '/api/v3/queue/1000',
        body: { removeFromClient: 'false', blocklist: 'true', skipRedownload: 'true' },
      },
      {
        path: '/api/v3/release',
        body: expect.objectContaining({ episodeIds: [37187, 37188], shouldOverride: true }),
      },
    ]);
    const owned = {
        db: t.db,
        arr: s.arr,
        actor,
        parent: { kind: 'fix' as const, id: s.fixRequestId },
        downloadId: 'new-ivy',
      },
      next = await planOwnedSonarrImport(owned);
    expect(next.targetEpisodeIds).toEqual([37187, 37188]);
    await expect(planOwnedSonarrImport({ ...owned, downloadId: '301dc' })).rejects.toThrow();
    await expect(planOwnedSonarrImport({ ...owned, downloadId: 'f707' })).rejects.toThrow();
    expect(
      (
        await runOwnedSonarrImport({
          ...owned,
          digest: next.digest,
          evidence:
            'Physical correct Agent Double-O-Goof and Egg-xasperating plus English were independently verified.',
        })
      ).outcome,
    ).toBe('imported');
    const events = s.state.history.filter((h) => h.eventType === 'downloadFolderImported');
    await ingestLedgerEvents({
      db: t.db,
      source: 'sonarr',
      events: events.map((h) => ({
        mediaItemId: itemId,
        eventType: 'imported',
        source: 'sonarr' as const,
        sourceEventId: String(h.id),
        occurredAt: new Date(h.date),
        payload: { downloadId: h.downloadId, episodeId: h.episodeId, fileId: 80025 },
      })),
    });
    expect((await completeFixRequests({ db: t.db })).completed.map((f) => f.fixRequestId)).toEqual([
      s.fixRequestId,
    ]);
    expect(await t.db.select().from(fixRequests)).toHaveLength(1);
    expect(await t.db.select().from(watchCarries)).toHaveLength(1);
    expect(s.state.files.find((f) => f.id === 65359)?.size).toBe(1377201632);
    expect(s.state.pages.every((p) => p.includes('pageSize=200') && p.includes('page=1'))).toBe(
      true,
    );
  });
  it('does not replay an uncertain removal, even when the queue actually disappeared', async () => {
    const s = await setup();
    s.state.deleteUncertain = true;
    const plan = await selected(s.input);
    expect(
      (
        await runWrongContentRetry({
          ...s.input,
          digest: plan.digest,
          key: plan.candidates[0]!.key,
          evidence,
          conflictEvidence: 'Physical original-byte source holds wrong S3 stories.',
        })
      ).outcome,
    ).toBe('observe');
    const observe = await planWrongContentRetry({ ...s.input, key: plan.candidates[0]!.key });
    expect(observe.state).toBe('observe');
    await runWrongContentRetry({
      ...s.input,
      digest: observe.digest,
      key: plan.candidates[0]!.key,
      evidence,
    });
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/queue/1000']);
  });
  it('accepted GRAB with a 503 response still binds the real NEW download and never replays the release', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    s.state.grabAcceptedButError = true;
    expect(
      (
        await runWrongContentRetry({
          ...s.input,
          digest: plan.digest,
          key: plan.candidates[0]!.key,
          evidence,
          conflictEvidence: 'Physical source proves wrong S3 pair.',
        })
      ).outcome,
    ).toBe('observe');
    const observe = await planWrongContentRetry({ ...s.input, key: plan.candidates[0]!.key });
    await runWrongContentRetry({
      ...s.input,
      digest: observe.digest,
      key: plan.candidates[0]!.key,
      evidence,
    });
    expect(s.state.writes.filter((w) => w.path.endsWith('/release'))).toHaveLength(1);
    const owned = {
      db: t.db,
      arr: s.arr,
      actor,
      parent: { kind: 'fix' as const, id: s.fixRequestId },
      downloadId: 'new-ivy',
    };
    expect((await planOwnedSonarrImport(owned)).targetEpisodeIds).toEqual([37187, 37188]);
    const at = new Date(Date.now() + 1000),
      grab = s.state.history.find((h) => h.downloadId === 'new-ivy' && h.eventType === 'grabbed')!;
    expect(
      await deferredWrongContentFailures({
        db: t.db,
        failures: [
          {
            downloadId: 'new-ivy',
            parentId: 439,
            title: RIGHT,
            failedAt: at,
            grabbedHistory: { id: grab.id, date: grab.date, title: RIGHT, downloadId: 'new-ivy' },
          },
        ],
      }),
    ).toEqual(new Set(['new-ivy\u0000439']));
  });
  it('refuses NEW wrong-raw GRAB history before import or foreign adoption', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    s.state.newGrabWrongTargets = true;
    await runWrongContentRetry({
      ...s.input,
      digest: plan.digest,
      key: plan.candidates[0]!.key,
      evidence,
      conflictEvidence: 'Physical source proves wrong S3 pair.',
    });
    await expect(
      planOwnedSonarrImport({
        db: t.db,
        arr: s.arr,
        actor,
        parent: { kind: 'fix', id: s.fixRequestId },
        downloadId: 'new-ivy',
      }),
    ).rejects.toThrow('not the exact grab');
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/queue/1000', '/api/v3/release']);
    expect(s.state.files.find((f) => f.id === 65359)?.size).toBe(1377201632);
  });
  it('post-GRAB audit outage preserves the new intent and real download for owned observation', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    await t.pool.query(
      `CREATE FUNCTION reject_retry_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actions_taken @> '[{"step":"wrong_content_retry_grab_result"}]'::jsonb THEN RAISE EXCEPTION 'test receipt unavailable'; END IF; RETURN NEW; END $$`,
    );
    await t.pool.query(
      'CREATE TRIGGER reject_retry_receipt BEFORE UPDATE ON fix_requests FOR EACH ROW EXECUTE FUNCTION reject_retry_receipt()',
    );
    try {
      await expect(
        runWrongContentRetry({
          ...s.input,
          digest: plan.digest,
          key: plan.candidates[0]!.key,
          evidence,
          conflictEvidence: 'Physical source proves wrong S3 pair.',
        }),
      ).rejects.toThrow('test receipt unavailable');
    } finally {
      await t.pool.query('DROP TRIGGER reject_retry_receipt ON fix_requests');
      await t.pool.query('DROP FUNCTION reject_retry_receipt()');
    }
    const [row] = await t.db.select().from(fixRequests);
    expect(row!.actionsTaken.some((a) => a.step === 'grab_intent' && a.title === RIGHT)).toBe(true);
    expect(row!.actionsTaken.some((a) => a.step === 'wrong_content_retry_grab_result')).toBe(false);
    expect(
      (
        await planOwnedSonarrImport({
          db: t.db,
          arr: s.arr,
          actor,
          parent: { kind: 'fix', id: s.fixRequestId },
          downloadId: 'new-ivy',
        })
      ).targetEpisodeIds,
    ).toEqual([37187, 37188]);
    expect(s.state.writes.filter((w) => w.path.endsWith('/release'))).toHaveLength(1);
  });
  it('claims concurrent retries once and records only one queue removal and one grab', async () => {
    const s = await setup(),
      plan = await selected(s.input),
      request = {
        ...s.input,
        digest: plan.digest,
        key: plan.candidates[0]!.key,
        evidence,
        conflictEvidence: 'Physical source proves the wrong S3 pair.',
      };
    const results = await Promise.allSettled([
      runWrongContentRetry(request),
      runWrongContentRetry(request),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/queue/1000', '/api/v3/release']);
  });
  it('an audit outage saving grab intent stops before POST and leaves a durable observable removal claim', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    await t.pool.query(
      `CREATE FUNCTION reject_retry_grab_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actions_taken @> '[{"step":"wrong_content_retry_grab_intent"}]'::jsonb THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await t.pool.query(
      'CREATE TRIGGER reject_retry_grab_audit BEFORE UPDATE ON fix_requests FOR EACH ROW EXECUTE FUNCTION reject_retry_grab_audit()',
    );
    try {
      await expect(
        runWrongContentRetry({
          ...s.input,
          digest: plan.digest,
          key: plan.candidates[0]!.key,
          evidence,
          conflictEvidence: 'Physical source proves the wrong S3 pair.',
        }),
      ).rejects.toThrow('test audit unavailable');
    } finally {
      await t.pool.query('DROP TRIGGER reject_retry_grab_audit ON fix_requests');
      await t.pool.query('DROP FUNCTION reject_retry_grab_audit()');
    }
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/queue/1000']);
    const observe = await planWrongContentRetry({ ...s.input, key: plan.candidates[0]!.key });
    expect(
      (
        await runWrongContentRetry({
          ...s.input,
          digest: observe.digest,
          key: plan.candidates[0]!.key,
          evidence,
        })
      ).outcome,
    ).toBe('observe');
    expect(s.state.writes).toHaveLength(1);
    const [row] = await t.db.select().from(fixRequests);
    expect(row!.status).toBe('search_triggered');
    expect(row!.actionsTaken.some((a) => a.step === 'wrong_content_retry_intent')).toBe(true);
    expect(row!.actionsTaken.some((a) => a.step === 'wrong_content_retry_grab_intent')).toBe(false);
  });
  it('stops before grab when protected old E13–16 changes during removal', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    s.state.afterDelete = () => {
      s.state.files[0]!.size += 1;
    };
    await expect(
      runWrongContentRetry({
        ...s.input,
        digest: plan.digest,
        key: plan.candidates[0]!.key,
        evidence,
        conflictEvidence: 'Physical original-byte source holds wrong S3 stories.',
      }),
    ).rejects.toThrow('Protected files changed');
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/queue/1000']);
  });
  it('refuses stale source, member parent, native import, malformed full scope and an existing import claim before writes', async () => {
    for (const mutate of [
      async (s: Awaited<ReturnType<typeof setup>>) => {
        s.state.candidateSize++;
      },
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await t.db
          .update(fixRequests)
          .set({ requesterId: userId })
          .where(eq(fixRequests.id, s.fixRequestId));
      },
      async (s: Awaited<ReturnType<typeof setup>>) => {
        s.state.history.push({
          ...s.state.history[0]!,
          id: 69000,
          eventType: 'downloadFolderImported',
        });
      },
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await t.db
          .update(watchCarries)
          .set({
            detail: {
              fixRequestId: s.fixRequestId,
              wrongContentDeletion: {
                version: 1,
                grabStarted: true,
                files: [{ episodeIds: [37187] }],
              },
            },
          })
          .where(eq(watchCarries.id, s.carryId));
      },
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await t.db
          .update(fixRequests)
          .set({
            actionsTaken: [
              { step: 'wrong_content_replace', at: new Date().toISOString() },
              { step: 'release_grab', at: new Date().toISOString(), ok: true, release: OLD },
              { step: 'owned_import_intent', at: new Date().toISOString() },
            ],
          })
          .where(eq(fixRequests.id, s.fixRequestId));
      },
    ]) {
      await t.db.delete(watchCarries);
      await t.db.delete(fixRequests);
      await t.db.delete(ledgerEvents);
      const s = await setup();
      await mutate(s);
      await expect(planWrongContentRetry(s.input)).rejects.toThrow();
      expect(s.state.writes).toEqual([]);
    }
  });
  it('keeps hard release refusals and original-parent waiting evidence after failed grab', async () => {
    const s = await setup();
    s.state.rejections = ['Release is blocklisted'];
    expect((await planWrongContentRetry(s.input)).candidates).toEqual([]);
    s.state.rejections = [];
    const plan = await selected(s.input);
    s.state.grabUncertain = true;
    expect(
      (
        await runWrongContentRetry({
          ...s.input,
          digest: plan.digest,
          key: plan.candidates[0]!.key,
          evidence,
          conflictEvidence: 'Physical original-byte source holds wrong S3 stories.',
        })
      ).outcome,
    ).toBe('observe');
    const [row] = await t.db.select().from(fixRequests);
    expect(row!.status).toBe('search_triggered');
    expect(row!.actionsTaken.some((a) => a.step === 'wrong_content_retry_grab_intent')).toBe(true);
    expect(row!.actionsTaken.at(-1)).toMatchObject({
      step: 'wrong_content_retry_grab_result',
      ok: false,
    });
    const observe = await planWrongContentRetry({ ...s.input, key: plan.candidates[0]!.key });
    await runWrongContentRetry({
      ...s.input,
      digest: observe.digest,
      key: plan.candidates[0]!.key,
      evidence,
    });
    expect(s.state.writes.filter((w) => w.path.endsWith('/release'))).toHaveLength(1);
  });
  it('RETRY janitor records a hold without spending a search and preserves unrelated policy before ledger ingestion', async () => {
    const s = await setup();
    s.state.removed = true;
    // Actual live GRAB evidence is already read by the janitor; the app ledger may not have caught up.
    await t.db.delete(ledgerEvents);
    s.state.history.push({
      ...s.state.history[2]!,
      id: 66900,
      downloadId: 'foreign',
      sourceTitle: 'Unrelated legitimate release',
    });
    const clients = buildQueueCleanupClients(s.arr);
    clients.radarr.getQueueAll = async () => [];
    clients.lidarr.getQueueAll = async () => [];
    const config = structuredClone(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);
    config.modes.sonarr.bad_release = 'enforce';
    await evaluateQueueCleanup({ db: t.db, clients, config, now: new Date(Date.now() + 1000) });
    const rows = await t.db.select().from(arrQueueCleanupActions);
    expect(rows.filter((r) => r.downloadId === '301dc')).toHaveLength(2);
    expect(
      rows
        .filter((r) => r.downloadId === '301dc')
        .every(
          (r) =>
            r.mode === 'enforce' &&
            r.action === 'none' &&
            r.outcome === 'observed' &&
            r.reason === WRONG_CONTENT_RETRY_HOLD,
        ),
    ).toBe(true);
    expect(rows.find((r) => r.downloadId === 'foreign')).toMatchObject({
      action: 'blocklisted_searched',
      outcome: 'done',
    });
    expect(s.state.writes).toEqual([
      { path: '/api/v3/command', body: expect.objectContaining({ name: 'EpisodeSearch' }) },
    ]);
    await evaluateQueueCleanup({ db: t.db, clients, config, now: new Date(Date.now() + 2000) });
    expect(await t.db.select().from(arrQueueCleanupActions)).toHaveLength(rows.length);
    expect(s.state.writes).toHaveLength(1);
  });
  it('defers old recorded owned failures after a new receipt without adopting a later same-title foreign grab', async () => {
    const s = await setup(),
      plan = await selected(s.input);
    await runWrongContentRetry({
      ...s.input,
      digest: plan.digest,
      key: plan.candidates[0]!.key,
      evidence,
      conflictEvidence: 'Physical source proves wrong S3 pair.',
    });
    const old = s.state.history.find((h) => h.downloadId === '301dc' && h.eventType === 'grabbed')!;
    const foreign = {
      id: 69999,
      downloadId: 'later-foreign',
      title: OLD,
      date: new Date(Date.parse(old.date) + 60000).toISOString(),
    };
    const failure = {
      downloadId: '301dc',
      parentId: 439,
      title: OLD,
      failedAt: new Date(Date.parse(old.date) + 120000),
    };
    expect(
      await deferredWrongContentFailures({
        db: t.db,
        failures: [
          failure,
          { ...failure, downloadId: foreign.downloadId, grabbedHistory: foreign },
        ],
      }),
    ).toEqual(new Set(['301dc\u0000439']));
  });
  it('defers only the actual verified staff-owned failed download, not a same-grain foreign download or member parent', async () => {
    const s = await setup(),
      failedAt = new Date(Date.now() + 1000),
      failure = { downloadId: '301dc', parentId: 439, title: OLD, failedAt };
    expect(
      await deferredWrongContentFailures({
        db: t.db,
        failures: [failure, { ...failure, downloadId: 'foreign' }, { ...failure, parentId: 549 }],
      }),
    ).toEqual(new Set(['301dc\u0000439']));
    await t.db
      .update(fixRequests)
      .set({ requesterId: userId })
      .where(eq(fixRequests.id, s.fixRequestId));
    expect(await deferredWrongContentFailures({ db: t.db, failures: [failure] })).toEqual(
      new Set(),
    );
  });
});
