// PLAN-015 / ADR-028 — the Action Feedback phase-derivation matrix + the two projectors.
// Part 1 is a pure, DB-free sweep of (row status | queue record | ledger milestones | windows)
// → phase, incl. the pct math, the found-nothing window, the stalled threshold, error states,
// and the roll-up least-advanced aggregation. Part 2 wires computeFixProgress /
// computeSearchProgress against embedded PG16 + a fetch-stubbed queue (ADR-010, no live APIs):
// own-fix vs admin auth, a non-existent fixId, fail-closed on a queue read error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { fixRequests, ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  ArrUpstreamError,
  FOUND_NOTHING_WINDOW_MS,
  NotFoundError,
  STALLED_THRESHOLD_MS,
  buildArrClientBundle,
  computeFixProgress,
  computeSearchProgress,
  createFixRequest,
  derivePhaseForTarget,
  ingestLedgerEvents,
  phaseFromQueueRecord,
  recordFixAction,
  recordSearchRequest,
  rollupHeadlinePhase,
  upsertMediaItemsBatch,
  type ActionPhase,
  type ArrClientBundle,
  type NormalizedQueueRecord,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ---------------------------------------------------------------------------
// Part 1 — pure derivation matrix (no DB, no *arr).
// ---------------------------------------------------------------------------

const qrec = (o: Partial<NormalizedQueueRecord> = {}): NormalizedQueueRecord => ({
  status: 'downloading',
  trackedDownloadStatus: 'ok',
  trackedDownloadState: 'downloading',
  size: 1000,
  sizeleft: 500,
  estimatedCompletionTime: null,
  message: null,
  childId: null,
  seasonNumber: null,
  ...o,
});

const now = new Date('2026-07-07T12:00:00Z');
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('phaseFromQueueRecord — one live queue record → phase', () => {
  const cases: [Partial<NormalizedQueueRecord>, ActionPhase][] = [
    [{ status: 'queued', trackedDownloadState: 'downloading' }, 'queued'],
    [{ status: 'delay' }, 'queued'],
    [{ status: 'paused' }, 'queued'],
    [{ status: 'downloading', trackedDownloadState: 'downloading' }, 'downloading'],
    [{ status: 'completed', trackedDownloadState: 'importPending' }, 'importing'],
    [{ status: 'completed', trackedDownloadState: 'importing' }, 'importing'],
    [{ trackedDownloadState: 'imported' }, 'completed'],
    // Import needs manual attention → stalled (recoverable), not failed.
    [{ status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked' }, 'stalled'],
    [{ trackedDownloadState: 'importFailed' }, 'stalled'],
    // A hard tracked-download error is stalled immediately (ADR-028 D3).
    [{ trackedDownloadStatus: 'error', trackedDownloadState: 'downloading' }, 'stalled'],
    // A transient client warning with no import/download signal keeps moving (queued).
    [{ status: 'warning', trackedDownloadStatus: 'warning', trackedDownloadState: '' }, 'queued'],
    // Definitive download failure.
    [{ status: 'failed', trackedDownloadState: 'failed' }, 'failed'],
    [{ trackedDownloadState: 'failedPending' }, 'failed'],
  ];
  it.each(cases)('%o → %s', (rec, expected) => {
    expect(phaseFromQueueRecord(qrec(rec)).phase).toBe(expected);
  });
});

describe('derivePhaseForTarget — the full (status × queue × history × window) matrix', () => {
  const base = { now, anchorAt: minsAgo(2) };

  it('no queue, no grab, within the found-nothing window → searching', () => {
    expect(derivePhaseForTarget({ ...base, queueRecords: [] }).phase).toBe('searching');
  });

  it('no queue, no grab, past the found-nothing window → nothing_found (never stuck)', () => {
    const anchorAt = new Date(now.getTime() - FOUND_NOTHING_WINDOW_MS - 60_000);
    expect(derivePhaseForTarget({ now, anchorAt, queueRecords: [] }).phase).toBe('nothing_found');
  });

  it('grabbed but not yet in the queue → grabbed', () => {
    const r = derivePhaseForTarget({ ...base, queueRecords: [], hasGrabbed: true, lastActivityAt: minsAgo(1) });
    expect(r.phase).toBe('grabbed');
  });

  it('grabbed but silent past the stalled threshold → stalled', () => {
    const lastActivityAt = new Date(now.getTime() - STALLED_THRESHOLD_MS - 60_000);
    const r = derivePhaseForTarget({ now, anchorAt: lastActivityAt, queueRecords: [], hasGrabbed: true, lastActivityAt });
    expect(r.phase).toBe('stalled');
  });

  it('downloading → downloading with pct from size/sizeleft', () => {
    const r = derivePhaseForTarget({ ...base, queueRecords: [qrec({ size: 1000, sizeleft: 250 })] });
    expect(r.phase).toBe('downloading');
    expect(r.progressPct).toBe(75);
  });

  it('downloading → etaSeconds from estimatedCompletionTime', () => {
    const eta = new Date(now.getTime() + 90_000).toISOString();
    const r = derivePhaseForTarget({
      ...base,
      queueRecords: [qrec({ size: 1000, sizeleft: 300, estimatedCompletionTime: eta })],
    });
    expect(r.etaSeconds).toBe(90);
  });

  it('importing (trackedDownloadState) → importing', () => {
    const r = derivePhaseForTarget({ ...base, queueRecords: [qrec({ status: 'completed', trackedDownloadState: 'importing' })] });
    expect(r.phase).toBe('importing');
  });

  it('a matching imported milestone → completed (pct 100), even before the cron flips the row', () => {
    const r = derivePhaseForTarget({ ...base, queueRecords: [], hasImported: true });
    expect(r.phase).toBe('completed');
    expect(r.progressPct).toBe(100);
  });

  it('the durable fix row status is authority: rowTerminal completed/failed win', () => {
    expect(derivePhaseForTarget({ ...base, rowTerminal: 'completed', queueRecords: [] }).phase).toBe('completed');
    expect(derivePhaseForTarget({ ...base, rowTerminal: 'failed', queueRecords: [qrec()] }).phase).toBe('failed');
  });

  it('a download_failed milestone with an empty queue → failed', () => {
    const r = derivePhaseForTarget({ ...base, queueRecords: [], hasDownloadFailed: true });
    expect(r.phase).toBe('failed');
  });

  it('trackedDownloadStatus error on a live record → stalled with the reason message', () => {
    const r = derivePhaseForTarget({
      ...base,
      queueRecords: [qrec({ trackedDownloadStatus: 'error', message: 'no files found' })],
    });
    expect(r.phase).toBe('stalled');
    expect(r.message).toBe('no files found');
  });

  it('a bazarr_subtitle fix rests at searching and never derives nothing_found/stalled', () => {
    const anchorAt = new Date(now.getTime() - STALLED_THRESHOLD_MS - 60_000); // long past both windows
    const r = derivePhaseForTarget({ now, anchorAt, isSubtitle: true, queueRecords: [] });
    expect(r.phase).toBe('searching');
  });
});

describe('rollupHeadlinePhase — least-advanced non-terminal, else best terminal', () => {
  it('picks the least-advanced non-terminal child', () => {
    expect(rollupHeadlinePhase(['downloading', 'importing', 'queued'])).toBe('queued');
    expect(rollupHeadlinePhase(['searching', 'completed'])).toBe('searching');
    expect(rollupHeadlinePhase(['downloading', 'completed', 'nothing_found'])).toBe('downloading');
  });
  it('all terminal → completed if any imported, else stalled, else nothing_found', () => {
    expect(rollupHeadlinePhase(['completed', 'nothing_found'])).toBe('completed');
    expect(rollupHeadlinePhase(['nothing_found', 'stalled'])).toBe('stalled');
    expect(rollupHeadlinePhase(['nothing_found', 'nothing_found'])).toBe('nothing_found');
  });
  it('empty → nothing_found', () => {
    expect(rollupHeadlinePhase([])).toBe('nothing_found');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the two projectors over embedded PG16 + a fetch-stubbed queue.
// ---------------------------------------------------------------------------

interface StubRoute {
  method?: string;
  path: string | RegExp;
  status?: number;
  body?: unknown | ((url: URL) => unknown);
}

function stubBundle(routes: StubRoute[]): ArrClientBundle {
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const opts = { apiKey: 'test-key', retryDelayMs: 0, fetchImpl } as const;
  return buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
}

const queuePage = (records: unknown[]) => ({
  page: 1,
  pageSize: 200,
  sortKey: 'timeleft',
  sortDirection: 'ascending',
  totalRecords: records.length,
  records,
});

/** A minimal sonarr queue record for the stub. */
function sonarrQueueRec(o: Record<string, unknown>) {
  return {
    id: 1,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size: 1000,
    sizeleft: 400,
    seriesId: 900,
    ...o,
  };
}

function episodeJson(id: number, seasonNumber: number, episodeNumber: number, hasFile = true) {
  return {
    id,
    seriesId: 900,
    seasonNumber,
    episodeNumber,
    title: `Chapter ${episodeNumber}`,
    airDateUtc: '2021-03-02T01:00:00Z',
    hasFile,
    monitored: true,
    ...(hasFile ? { episodeFileId: id * 10 } : {}),
  };
}

describe('computeFixProgress / computeSearchProgress (projectors)', () => {
  let t: TestDb;
  let memberId: string;
  let otherId: string;
  let adminId: string;
  let sonarrItemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'ap-member@example.com' })).id;
    otherId = (await createUser(t.db, { email: 'ap-other@example.com' })).id;
    // Any user id — the admin READ path is driven by the requesterIsAdmin flag, not the row's role.
    adminId = (await createUser(t.db, { email: 'ap-admin@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 900,
          tvdbId: 900900,
          title: 'Progress Show',
          sortTitle: 'progress show',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.arrItemId, 900));
    sonarrItemId = item!.id;
  }, 120_000);

  afterAll(async () => {
    await t?.stop();
  });

  async function openFix(requesterId: string, targetArrChildId: number): Promise<string> {
    const { fixRequestId } = await createFixRequest({
      db: t.db,
      requesterId,
      requesterIsAdmin: true, // bypass the shared hourly budget in this fixture (ownership is by requesterId)
      mediaItemId: sonarrItemId,
      targetArrChildId,
      targetLabel: `S01E0${targetArrChildId % 10}`,
      reason: 'wont_play_corrupt',
    });
    await recordFixAction({ db: t.db, fixRequestId, transition: 'actioned', pathTaken: 'blocklist_search' });
    await recordFixAction({ db: t.db, fixRequestId, transition: 'search_triggered' });
    return fixRequestId;
  }

  it('derives downloading + pct from the live queue for an episode fix', async () => {
    const fixId = await openFix(memberId, 91001);
    const arr = stubBundle([
      { path: '/api/v3/queue', body: queuePage([sonarrQueueRec({ episodeId: 91001, size: 1000, sizeleft: 200 })]) },
    ]);
    const progress = await computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: memberId });
    expect(progress.phase).toBe('downloading');
    expect(progress.progressPct).toBe(80);
  });

  it('own-fix or admin may read; a different member gets NOT_FOUND (no leak)', async () => {
    const fixId = await openFix(memberId, 91002);
    const arr = stubBundle([{ path: '/api/v3/queue', body: queuePage([]) }]);
    // owner
    await expect(
      computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: memberId }),
    ).resolves.toBeDefined();
    // admin
    await expect(
      computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: adminId, requesterIsAdmin: true }),
    ).resolves.toBeDefined();
    // a different, non-admin member
    await expect(
      computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: otherId }),
    ).rejects.toThrow(NotFoundError);
  });

  it('a non-existent fixId → NotFoundError', async () => {
    const arr = stubBundle([{ path: '/api/v3/queue', body: queuePage([]) }]);
    await expect(
      computeFixProgress({
        db: t.db,
        arr,
        fixRequestId: '00000000-0000-4000-8000-0000000000ff',
        requesterId: memberId,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('a queue read failure fails closed (ArrUpstreamError) — never a false terminal', async () => {
    const fixId = await openFix(memberId, 91003);
    const arr = stubBundle([{ path: '/api/v3/queue', status: 500, body: { message: 'boom' } }]);
    await expect(
      computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: memberId }),
    ).rejects.toThrow(ArrUpstreamError);
    // The read wrote nothing: the fix row is untouched at search_triggered.
    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixId));
    expect(row!.status).toBe('search_triggered');
  });

  it('completed once the replacement import lands (before any row flip)', async () => {
    const fixId = await openFix(memberId, 91004);
    await ingestLedgerEvents({
      db: t.db,
      source: 'sonarr',
      events: [
        {
          mediaItemId: sonarrItemId,
          eventType: 'imported',
          source: 'sonarr',
          sourceEventId: 'imp-91004',
          occurredAt: new Date(),
          payload: { rawEventType: 'downloadFolderImported', episodeId: 91004 },
        },
      ],
    });
    const arr = stubBundle([{ path: '/api/v3/queue', body: queuePage([]) }]);
    const progress = await computeFixProgress({ db: t.db, arr, fixRequestId: fixId, requesterId: memberId });
    expect(progress.phase).toBe('completed');
  });

  it('season roll-up: per-child episode phases + least-advanced headline', async () => {
    const { fixRequestId } = await createFixRequest({
      db: t.db,
      requesterId: memberId,
      requesterIsAdmin: true, // bypass the shared hourly budget in this fixture
      mediaItemId: sonarrItemId,
      scope: 'season',
      seasonNumber: 5,
      targetLabel: 'Season 5',
      reason: 'wrong_version_quality',
    });
    await recordFixAction({ db: t.db, fixRequestId, transition: 'actioned', pathTaken: 'blocklist_search' });
    await recordFixAction({ db: t.db, fixRequestId, transition: 'search_triggered' });

    const arr = stubBundle([
      {
        path: '/api/v3/episode',
        body: [episodeJson(95001, 5, 1), episodeJson(95002, 5, 2), episodeJson(95003, 5, 3), episodeJson(94001, 4, 1)],
      },
      {
        path: '/api/v3/queue',
        body: queuePage([
          sonarrQueueRec({ id: 1, episodeId: 95001, seasonNumber: 5, size: 1000, sizeleft: 100, status: 'downloading', trackedDownloadState: 'downloading' }),
          sonarrQueueRec({ id: 2, episodeId: 95002, seasonNumber: 5, status: 'completed', trackedDownloadState: 'importing', size: 1000, sizeleft: 0 }),
          // 95003 has no queue record → searching (within window)
        ]),
      },
    ]);
    const progress = await computeFixProgress({ db: t.db, arr, fixRequestId, requesterId: memberId });
    expect(progress.perChild).toBeDefined();
    const byChild = Object.fromEntries(progress.perChild!.map((c) => [c.childId, c.phase]));
    expect(byChild[95001]).toBe('downloading');
    expect(byChild[95002]).toBe('importing');
    expect(byChild[95003]).toBe('searching');
    // Headline = least-advanced non-terminal child (searching).
    expect(progress.phase).toBe('searching');
  });

  it('computeSearchProgress keys off the latest search_requested event (own/admin auth)', async () => {
    await recordSearchRequest({
      db: t.db,
      requesterId: memberId,
      requesterIsAdmin: true, // bypass the shared hourly budget in this fixture
      mediaItemId: sonarrItemId,
      scope: 'episode',
      targetArrChildId: 96001,
      targetLabel: 'S01E01',
    });
    const arr = stubBundle([
      { path: '/api/v3/queue', body: queuePage([sonarrQueueRec({ episodeId: 96001, size: 1000, sizeleft: 500 })]) },
    ]);
    const progress = await computeSearchProgress({
      db: t.db,
      arr,
      mediaItemId: sonarrItemId,
      scope: 'episode',
      targetChildId: 96001,
      requesterId: memberId,
    });
    expect(progress.phase).toBe('downloading');
    expect(progress.progressPct).toBe(50);

    // A different member cannot read another's force search (NOT_FOUND).
    await expect(
      computeSearchProgress({
        db: t.db,
        arr,
        mediaItemId: sonarrItemId,
        scope: 'episode',
        targetChildId: 96001,
        requesterId: otherId,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('computeSearchProgress: no search on record for the grain → NotFoundError', async () => {
    const arr = stubBundle([{ path: '/api/v3/queue', body: queuePage([]) }]);
    await expect(
      computeSearchProgress({
        db: t.db,
        arr,
        mediaItemId: sonarrItemId,
        scope: 'episode',
        targetChildId: 99999,
        requesterId: memberId,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('computeSearchProgress: an old search past the found-nothing window → nothing_found', async () => {
    // Insert an old search_requested event directly (occurredAt beyond the window).
    await t.db.insert(ledgerEvents).values({
      mediaItemId: sonarrItemId,
      eventType: 'search_requested',
      source: 'app',
      occurredAt: new Date(Date.now() - FOUND_NOTHING_WINDOW_MS - 5 * 60_000),
      requestedByUserId: memberId,
      payload: { scope: 'episode', targetArrChildId: 97001, seasonNumber: null, arrKind: 'sonarr' },
    });
    const arr = stubBundle([{ path: '/api/v3/queue', body: queuePage([]) }]);
    const progress = await computeSearchProgress({
      db: t.db,
      arr,
      mediaItemId: sonarrItemId,
      scope: 'episode',
      targetChildId: 97001,
      requesterId: memberId,
    });
    expect(progress.phase).toBe('nothing_found');
  });
});
