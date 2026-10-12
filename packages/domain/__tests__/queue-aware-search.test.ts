// ADR-109 C-04, C-05 / DESIGN-055 D-02, D-07 (PLAN-077 P2, issue #597 Part 1) — queue-aware Force Search over the
// embedded Postgres harness and a stub *arr (ADR-010, no Docker). Case B (AC-41): Force Search on a missing episode
// whose finished download is blocked imports it and sends no search. Also: a download on its way sends nothing; a failed
// download is removed with blocklist (skipRedownload) and searched once; a plan that changed is refused; an import needs
// the confirmed plan; the remedy off and the bulk search keep today's search; the Repair Request lifecycle and budget.
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEvents, repairRequests } from '@hnet/db/schema';
import {
  FixPlanChangedError,
  FixRefusedError,
  buildArrClientBundle,
  planForceSearch,
  runForceSearch,
  setRepairGuideRemedies,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));
const seasons = JSON.parse(
  readFileSync(new URL('./fixtures/title-evidence-seasons.json', import.meta.url), 'utf8'),
) as Record<string, { seriesId: number; episodes: Array<{ id: number; seasonNumber: number; episodeNumber: number; title: string }> }>;
const paper = seasons['The Paper (2025) S2']!;

const FILE = 'The_Paper_2025_S02E06_125_Years_Young_2160p_PCOK_WEB-DL_DDP5_1_Atmos_DV_HDR_H_265-FLUX.mkv';
const RELEASE = 'The Paper 2025 S02E06 125 Years Young 2160p PCOK WEB-DL DDP5 1 Atmos DV HDR H 265-FLUX';
const FOLDER_MSG =
  'Episodes 2x07, 2x08, 2x09, 2x10 were unexpected considering the The_Paper_2025_S02E06_125_Years_Young folder name';
const QUALITY = { quality: { id: 19, name: 'WEBDL-2160p', source: 'web', resolution: 2160 }, revision: { version: 1, real: 0, isRepack: false } };

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** A small stateful Sonarr + Radarr: queue, manual import, the ManualImport command, the episode list. */
function stubArr() {
  const state = {
    queue: [] as Array<Record<string, unknown>>,
    radarrQueue: [] as Array<Record<string, unknown>>,
    candidates: [] as Array<Record<string, unknown>>,
    hasFile: new Set<number>(),
    commandStatus: 'completed',
    calls: [] as Call[],
  };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const page = (records: unknown[]) => ({ page: 1, pageSize: 200, totalRecords: records.length, records });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const sonarr = url.host.startsWith('sonarr');
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/queue') return json(page(sonarr ? state.queue : state.radarrQueue));
    if (method === 'GET' && p === '/api/v3/episode') {
      return json(
        paper.episodes.map((e) => ({ ...e, seriesId: 864, hasFile: state.hasFile.has(e.id) || e.id !== 85215, monitored: true })),
      );
    }
    if (method === 'GET' && p === '/api/v3/series/864') {
      return json({ ...(arrFixture('sonarr.series-byid') as Record<string, unknown>), id: 864, title: 'The Paper (2025)', year: 2025 });
    }
    if (method === 'GET' && p === '/api/v3/manualimport') return json(state.candidates);
    if (method === 'POST' && p === '/api/v3/command') {
      const name = (body as { name: string }).name;
      if (name === 'ManualImport') {
        for (const f of (body as { files: Array<{ episodeIds: number[] }> }).files) for (const id of f.episodeIds) state.hasFile.add(id);
        state.queue = [];
      }
      return json({ id: 77, name });
    }
    if (method === 'GET' && p === '/api/v3/command/77') return json({ id: 77, name: 'ManualImport', status: state.commandStatus });
    if (method === 'DELETE' && p.startsWith('/api/v3/queue/')) {
      state.queue = [];
      return json(undefined);
    }
    return json({ message: `no stub for ${method} ${p}` }, 404);
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  const bundle: ArrClientBundle = buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
  return { state, bundle, commands: () => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v3/command').map((c) => (c.body as { name: string }).name) };
}

function blockedRecord(o: Record<string, unknown> = {}) {
  return {
    id: 4401, seriesId: 864, episodeId: 85215, seasonNumber: 2, downloadId: 'SABnzbd_nzo_paper', title: RELEASE,
    status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importPending', size: 2.8e9, sizeleft: 0,
    added: '2026-09-09T00:00:00Z', statusMessages: [{ title: RELEASE, messages: [FOLDER_MSG] }], ...o,
  };
}

function paperCandidate(o: Record<string, unknown> = {}) {
  return {
    id: 1, path: `/downloads/tv/${RELEASE}/${FILE}`, relativePath: FILE, folderName: RELEASE, name: FILE.replace(/\.mkv$/, ''),
    size: 2.8e9, series: { id: 864, title: 'The Paper (2025)', year: 2025 }, seasonNumber: 2,
    episodes: [{ id: 85215, seriesId: 864, seasonNumber: 2, episodeNumber: 6, title: '125 Years Young', hasFile: false }],
    releaseGroup: 'FLUX', quality: QUALITY, languages: [{ id: 1, name: 'English' }], indexerFlags: 0,
    releaseType: 'singleEpisode', downloadId: 'SABnzbd_nzo_paper', rejections: [{ reason: FOLDER_MSG, type: 'permanent' }], ...o,
  };
}

describe('queue-aware Force Search (DESIGN-055 D-07)', () => {
  let t: TestDb;
  let memberId: string;
  let paperItemId: string;
  const target = () => ({ mediaItemId: paperItemId, scope: 'episode' as const, targetChildId: 85215 });
  const WAIT = { timeoutMs: 50, intervalMs: 5 };

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'paper@example.com', displayName: 'Paper Reader' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 864, tvdbId: 425007, title: 'The Paper (2025)', sortTitle: 'paper 2025', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
    const [row] = await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, 864) });
    paperItemId = row!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await setRepairGuideRemedies({ db: t.db, remedies: { import_check: true }, actorId: null });
    await t.db.delete(repairRequests).where(eq(repairRequests.mediaItemId, paperItemId));
  });

  it('Case B (AC-41): a blocked finished download is imported and no search is sent', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord()];
    arr.state.candidates = [paperCandidate()];
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    expect(plan).toMatchObject({
      queueAware: true,
      state: 'import',
      targetLabel: 'S02E06 · 125 Years Young',
      check: { verdict: 'importable', title: { verdict: 'agrees' }, file: { fileName: FILE, targetIds: [85215] } },
    });
    // The plan is read-only: no command, no row.
    expect(arr.commands()).toEqual([]);
    expect(await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, paperItemId))).toEqual([]);

    const result = await runForceSearch({
      db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: plan.digest }, commandWait: WAIT,
    });
    expect(result).toMatchObject({ outcome: 'imported', eventId: null, commandName: 'ManualImport' });
    expect(arr.commands()).toEqual(['ManualImport']);
    const command = arr.state.calls.find((c) => c.method === 'POST')!.body as { importMode: string; files: unknown[] };
    expect(command).toMatchObject({ importMode: 'auto', files: [{ seriesId: 864, episodeIds: [85215], downloadId: 'SABnzbd_nzo_paper' }] });

    const [repair] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
    expect(repair).toMatchObject({ kind: 'import_download', scope: 'episode', seasonNumber: 2, targetChildIds: [85215], status: 'completed' });
    expect(repair!.completedAt).not.toBeNull();
    expect(repair!.actionsTaken.map((a) => a.step)).toEqual(['created', 'manual_import', 'read_back']);
    const events = await t.db
      .select({ type: ledgerEvents.eventType })
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.mediaItemId, paperItemId)));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['repair_requested', 'repair_completed']));
    expect(events.map((e) => e.type)).not.toContain('search_requested');
  });

  it('an import that is still running answers `importing` and leaves the repair actioned', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord()];
    arr.state.candidates = [paperCandidate()];
    arr.state.commandStatus = 'started';
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    const result = await runForceSearch({
      db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: plan.digest }, commandWait: WAIT,
    });
    expect(result.outcome).toBe('importing');
    const [repair] = await t.db.select().from(repairRequests).where(eq(repairRequests.id, result.repairRequestId!));
    expect(repair!.status).toBe('actioned');
  });

  it('an import needs the plan the person saw: no digest is refused, a changed plan is refused', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord()];
    arr.state.candidates = [paperCandidate()];
    await expect(runForceSearch({ db: t.db, arr: arr.bundle, requesterId: memberId, ...target() })).rejects.toBeInstanceOf(
      FixRefusedError,
    );
    await expect(
      runForceSearch({ db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: 'stale' } }),
    ).rejects.toBeInstanceOf(FixPlanChangedError);
    expect(arr.commands()).toEqual([]);
  });

  it('a download on its way sends nothing and costs nothing', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord({ status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', sizeleft: 1.4e9, statusMessages: [] })];
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    expect(plan).toMatchObject({ state: 'on_its_way', download: { progress: 0.5 } });
    const result = await runForceSearch({ db: t.db, arr: arr.bundle, requesterId: memberId, ...target() });
    expect(result).toMatchObject({ outcome: 'on_its_way', eventId: null, repairRequestId: null });
    expect(arr.commands()).toEqual([]);
  });

  it('a failed download is removed with blocklist (skipRedownload) and searched once, audited first', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord({ status: 'failed', trackedDownloadStatus: 'error', trackedDownloadState: 'failed', statusMessages: [] })];
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    expect(plan).toMatchObject({ state: 'remove_and_search', removeWhy: 'failed' });
    const result = await runForceSearch({
      db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: plan.digest },
    });
    expect(result.outcome).toBe('removed_and_searched');
    const removal = arr.state.calls.find((c) => c.method === 'DELETE')!;
    expect(removal.path).toBe('/api/v3/queue/4401');
    expect(Object.fromEntries(removal.query)).toEqual({ removeFromClient: 'true', blocklist: 'true', skipRedownload: 'true' });
    expect(arr.commands()).toEqual(['EpisodeSearch']);
    const [event] = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.id, result.eventId!));
    expect(event!.payload).toMatchObject({ queueRemoval: { downloadId: 'SABnzbd_nzo_paper', why: 'failed' } });
  });

  it('a packed download is for staff: refused, nothing sent', async () => {
    const arr = stubArr();
    arr.state.queue = [blockedRecord({ statusMessages: [{ title: RELEASE, messages: ['Found archive file, might need to be extracted'] }] })];
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    expect(plan).toMatchObject({ state: 'staff', check: { verdict: 'archive' } });
    await expect(
      runForceSearch({ db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: plan.digest } }),
    ).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.commands()).toEqual([]);
  });

  it('nothing queued searches as today; the remedy off and the bulk search never read the queue', async () => {
    const arr = stubArr();
    const plan = await planForceSearch({ db: t.db, arr: arr.bundle, ...target() });
    expect(plan).toMatchObject({ queueAware: true, state: 'search' });
    expect((await runForceSearch({ db: t.db, arr: arr.bundle, requesterId: memberId, ...target(), confirm: { digest: plan.digest } })).outcome).toBe('searched');

    await setRepairGuideRemedies({ db: t.db, remedies: { import_check: false }, actorId: null });
    const off = stubArr();
    off.state.queue = [blockedRecord()];
    expect(await planForceSearch({ db: t.db, arr: off.bundle, ...target() })).toMatchObject({ queueAware: false, state: 'search' });
    expect((await runForceSearch({ db: t.db, arr: off.bundle, requesterId: memberId, ...target() })).outcome).toBe('searched');
    expect(off.state.calls.some((c) => c.path === '/api/v3/queue' || c.path === '/api/v3/manualimport')).toBe(false);
    // The in-cluster tool previews as if the remedy were on; a press never does.
    off.state.candidates = [paperCandidate()];
    expect(await planForceSearch({ db: t.db, arr: off.bundle, ...target(), importCheckOn: true })).toMatchObject({ queueAware: true, state: 'import' });

    await setRepairGuideRemedies({ db: t.db, remedies: { import_check: true }, actorId: null });
    const bulk = stubArr();
    bulk.state.queue = [blockedRecord()];
    expect((await runForceSearch({ db: t.db, arr: bulk.bundle, requesterId: memberId, ...target(), searchOnly: true })).outcome).toBe('searched');
    expect(bulk.state.calls.some((c) => c.path === '/api/v3/manualimport')).toBe(false);
  });
});
