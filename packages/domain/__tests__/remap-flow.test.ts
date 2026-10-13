// ADR-109 C-02, C-03 / DESIGN-055 D-04 (PLAN-077 P4) — the Episode Re-map over the embedded Postgres harness and a
// stateful stub Sonarr (ADR-010, no Docker). The stub follows Sonarr 4.0.20.3012's library-file ManualImport (read in its
// source: `ImportApprovedEpisodes` with `newDownload = false`): the file stays where it is, the record for its path is
// deleted and a new record links the chosen episodes, and an episode that still had another file leaves that file on
// disk but unmapped (the stub records it as orphaned, which the plan must never cause). RenameFiles renames in id order
// and skips a name another file holds. Case A (AC-40): the BiOMA shift moves 7 files highest first and loses nothing.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerEvents, repairRequests } from '@hnet/db/schema';
import {
  FixPlanChangedError,
  FixRefusedError,
  buildArrClientBundle,
  planEpisodeRemap,
  readRemapSeason,
  runEpisodeRemap,
  setRepairGuideRemedies,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import fixture from './fixtures/remap-lost-tapes-s01.json';

const SERIES_PATH = '/data/tv/Regular Show - The Lost Tapes';

interface StubFile {
  id: number;
  relativePath: string;
  size: number;
  releaseGroup: string | null;
  sceneName: string | null;
}

/** Sonarr's naming format for this series, enough to tell a renamed file from a stale one. */
const nameFor = (episodeNumbers: number[], title: string, group: string | null) =>
  `Season 1/Regular Show - The Lost Tapes (2026) - ${episodeNumbers.map((n) => `S01E${String(n).padStart(2, '0')}`).join('-')} - ${title}${group ? `-${group}` : ''}.mkv`;

function stubSonarr() {
  const episodes = fixture.episodes.map((e) => ({ ...e, episodeFileId: e.hasFile ? e.episodeFileId : 0 }));
  const files = new Map<number, StubFile>(
    fixture.files.map((f) => [f.id, { id: f.id, relativePath: f.relativePath, size: f.size, releaseGroup: f.releaseGroup, sceneName: f.sceneName }]),
  );
  const state = {
    nextFileId: 90_000,
    nextCommandId: 500,
    commands: new Map<number, { name: string; status: string }>(),
    /** Files left on disk with no record (what an import onto an occupied slot causes). */
    orphaned: [] as string[],
    /** Fail the Nth ManualImport's read-back (1-based) by leaving it queued. */
    stallImport: 0 as number,
    importsSeen: 0,
    queue: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const unlink = (fileId: number) => {
    for (const e of episodes) if (e.episodeFileId === fileId) { e.episodeFileId = 0; e.hasFile = false; }
  };
  const quality = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0 } };
  const candidate = (f: StubFile) => ({
    id: f.id * 10,
    path: `${SERIES_PATH}/${f.relativePath}`,
    relativePath: f.relativePath,
    folderName: 'Regular Show - The Lost Tapes',
    size: f.size,
    series: { id: 1061, title: 'Regular Show: The Lost Tapes', year: 2026 },
    seasonNumber: 1,
    episodes: episodes.filter((e) => e.episodeFileId === f.id).map((e) => ({ id: e.id, seasonNumber: 1, episodeNumber: e.episodeNumber, title: e.title })),
    episodeFileId: f.id,
    releaseGroup: f.releaseGroup ?? undefined,
    quality,
    languages: [{ id: 1, name: 'English' }],
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    rejections: [],
  });
  const expectedName = (f: StubFile) => {
    const on = episodes.filter((e) => e.episodeFileId === f.id).sort((a, b) => a.episodeNumber - b.episodeNumber);
    return on.length === 0 ? f.relativePath : nameFor(on.map((e) => e.episodeNumber), on[0]!.title, f.releaseGroup);
  };
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/episode') {
      return json(episodes.map((e) => ({ id: e.id, seriesId: 1061, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title, hasFile: e.episodeFileId > 0, monitored: true, ...(e.episodeFileId > 0 ? { episodeFileId: e.episodeFileId } : {}) })));
    }
    if (method === 'GET' && p === '/api/v3/episodefile') {
      return json([...files.values()].map((f) => ({ id: f.id, seriesId: 1061, seasonNumber: 1, relativePath: f.relativePath, sceneName: f.sceneName, releaseGroup: f.releaseGroup, size: f.size, quality })));
    }
    if (method === 'GET' && p === '/api/v3/queue') return json({ page: 1, pageSize: 200, totalRecords: state.queue.length, records: state.queue });
    if (method === 'GET' && p === '/api/v3/manualimport') return json([...files.values()].map(candidate));
    if (method === 'GET' && p === '/api/v3/rename') {
      return json([...files.values()].filter((f) => f.relativePath !== expectedName(f)).map((f) => ({ seriesId: 1061, seasonNumber: 1, episodeFileId: f.id, existingPath: f.relativePath, newPath: expectedName(f) })));
    }
    if (method === 'POST' && p === '/api/v3/command') {
      const id = state.nextCommandId++;
      const name = (body as { name: string }).name;
      let status = 'completed';
      if (name === 'ManualImport') {
        state.importsSeen += 1;
        if (state.importsSeen === state.stallImport) {
          status = 'queued';
        } else {
          for (const f of (body as { files: Array<{ path: string; episodeIds: number[] }> }).files) {
            const rel = f.path.slice(SERIES_PATH.length + 1);
            const old = [...files.values()].find((x) => x.relativePath === rel)!;
            // DeleteMediaFileReason.ManualOverride: the record for this path goes, the file stays.
            files.delete(old.id);
            unlink(old.id);
            for (const t of f.episodeIds) {
              const e = episodes.find((x) => x.id === t)!;
              if (e.episodeFileId > 0) {
                const other = files.get(e.episodeFileId);
                if (other) state.orphaned.push(other.relativePath);
              }
            }
            const fresh: StubFile = { ...old, id: state.nextFileId++, sceneName: null };
            files.set(fresh.id, fresh);
            for (const t of f.episodeIds) {
              const e = episodes.find((x) => x.id === t)!;
              e.episodeFileId = fresh.id;
              e.hasFile = true;
            }
          }
        }
      } else if (name === 'RenameFiles') {
        const ids = [...(body as { files: number[] }).files].sort((a, b) => a - b);
        for (const id of ids) {
          const f = files.get(id);
          if (!f) continue;
          const next = expectedName(f);
          if ([...files.values()].some((x) => x.id !== id && x.relativePath === next)) continue; // FileAlreadyExists: skipped
          f.relativePath = next;
        }
      }
      state.commands.set(id, { name, status });
      return json({ id, name });
    }
    if (method === 'GET' && p === '/api/v3/command') {
      return json([...state.commands.entries()].map(([id, c]) => ({ id, name: c.name, status: c.status })));
    }
    const cmd = /^\/api\/v3\/command\/(\d+)$/.exec(p);
    if (method === 'GET' && cmd) {
      const c = state.commands.get(Number(cmd[1]));
      return c ? json({ id: Number(cmd[1]), name: c.name, status: c.status }) : json({ message: 'no command' }, 404);
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
  const commandBodies = () =>
    state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v3/command').map((c) => c.body as Record<string, unknown>);
  const fileOn = (n: number) => {
    const e = episodes.find((x) => x.episodeNumber === n)!;
    return e.episodeFileId > 0 ? files.get(e.episodeFileId) ?? null : null;
  };
  return { state, bundle, files, episodes, commandBodies, fileOn };
}

const sizeOn = (fixtureNumber: number) => {
  const e = fixture.episodes.find((x) => x.episodeNumber === fixtureNumber)!;
  return fixture.files.find((f) => f.id === e.episodeFileId)!.size;
};

describe('Episode Re-map (DESIGN-055 D-04)', () => {
  let t: TestDb;
  let memberId: string;
  let itemId: string;
  const WAIT = { timeoutMs: 50, intervalMs: 5 };
  const SHIFT = { kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 18, by: 1 } as const;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'tapes@example.com', displayName: 'Tape Watcher' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 1061, tvdbId: 451113, title: 'Regular Show: The Lost Tapes', sortTitle: 'regular show the lost tapes', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/data/tv' }],
    });
    const [row] = await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, 1061) });
    itemId = row!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await setRepairGuideRemedies({ db: t.db, remedies: { episode_remap: true }, actorId: null });
    await t.db.delete(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
  });

  it('Case A (AC-40): moves the 7 BiOMA files one slot later, highest first, renames them, and loses nothing', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const plan = await planEpisodeRemap({ ...target, claim: SHIFT });
    expect(plan.refusal).toBeNull();
    expect(plan.remapOn).toBe(true);
    // The plan is read-only.
    expect(arr.commandBodies()).toEqual([]);

    const result = await runEpisodeRemap({ ...target, claim: SHIFT, planDigest: plan.digest, requesterId: memberId, commandWait: WAIT });
    expect(result).toMatchObject({ outcome: 'moved', moved: 7, planned: 7, renamed: true, stoppedText: null });
    expect(result.vacated.map((e) => e.episodeNumber)).toEqual([11, 13]);
    expect(result.mislabelGroups).toEqual([{ releaseGroup: 'BiOMA', fileCount: 7 }]);

    // Highest first: each ManualImport lands on a free slot, one file per command, no download id.
    const imports = arr.commandBodies().filter((b) => b.name === 'ManualImport');
    expect(imports.map((b) => (b.files as Array<{ episodeIds: number[] }>)[0]!.episodeIds[0])).toEqual(
      [19, 18, 17, 16, 15, 14, 12].map((n) => fixture.episodes.find((e) => e.episodeNumber === n)!.id),
    );
    for (const b of imports) {
      expect(b.importMode).toBe('move');
      const f = (b.files as Array<Record<string, unknown>>)[0]!;
      expect(Object.keys(f).sort()).toEqual(
        ['episodeFileId', 'episodeIds', 'folderName', 'indexerFlags', 'languages', 'path', 'quality', 'releaseGroup', 'releaseType', 'seriesId'].sort(),
      );
    }
    expect(arr.state.orphaned).toEqual([]);
    // Every file is where its content belongs, and named for it.
    for (const [was, now] of [[11, 12], [13, 14], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19]] as const) {
      expect(arr.fileOn(now)?.size).toBe(sizeOn(was));
      expect(arr.fileOn(now)?.relativePath).toContain(`S01E${now}`);
    }
    expect(arr.fileOn(11)).toBeNull();
    expect(arr.fileOn(13)).toBeNull();
    expect(arr.files.size).toBe(fixture.files.length);
    expect(arr.commandBodies().filter((b) => b.name === 'RenameFiles')).toHaveLength(1);

    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect(row).toMatchObject({ kind: 'remap', scope: 'season', seasonNumber: 1, status: 'completed', reason: null });
    expect(row!.preview).toMatchObject({ claim: SHIFT, seriesId: 1061, mislabelGroups: [{ releaseGroup: 'BiOMA', fileCount: 7 }] });
    const steps = (row!.actionsTaken as Array<{ step: string }>).map((a) => a.step);
    expect(steps.filter((s) => s === 'remap_move')).toHaveLength(7);
    expect(steps.filter((s) => s === 'remap_read_back')).toHaveLength(7);
    expect(steps.at(-1)).toBe('remap_done');
    const events = await t.db.select({ type: ledgerEvents.eventType }).from(ledgerEvents).where(eq(ledgerEvents.mediaItemId, itemId));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['repair_requested', 'repair_completed']));
  });

  it('then moves the Disney+ file from E24 to E23, and a second rename pass is not needed', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const e24 = fixture.episodes.find((e) => e.episodeNumber === 24)!.id;
    const e23 = fixture.episodes.find((e) => e.episodeNumber === 23)!.id;
    const claim = { kind: 'single', fromEpisodeId: e24, toEpisodeId: e23 } as const;
    const plan = await planEpisodeRemap({ ...target, claim });
    expect(plan.moves[0]!.nameSays).toMatchObject({ verdict: 'agrees' });
    const result = await runEpisodeRemap({ ...target, claim, planDigest: plan.digest, requesterId: memberId, commandWait: WAIT, reason: 'wrong_content' });
    expect(result).toMatchObject({ outcome: 'moved', moved: 1, renamed: true });
    expect(arr.fileOn(23)?.relativePath).toContain('S01E23 - All You Can Fit');
    expect(arr.fileOn(24)).toBeNull();
  });

  it('staff run it from the in-cluster tool with no person: requester null, the trail says so (P4 decision 17)', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const e24 = fixture.episodes.find((e) => e.episodeNumber === 24)!.id;
    const e23 = fixture.episodes.find((e) => e.episodeNumber === 23)!.id;
    const claim = { kind: 'single', fromEpisodeId: e24, toEpisodeId: e23 } as const;
    const plan = await planEpisodeRemap({ ...target, claim });
    const result = await runEpisodeRemap({ ...target, claim, planDigest: plan.digest, requesterId: null, commandWait: WAIT });
    expect(result).toMatchObject({ outcome: 'moved', moved: 1 });
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect(row).toMatchObject({ requesterId: null, kind: 'remap', status: 'completed' });
    expect((row!.actionsTaken as Array<Record<string, unknown>>)[0]).toMatchObject({ step: 'created', requester: { staffTool: 'repair-guide.ts' } });
  });

  it('refuses a plan that changed since the person saw it, writing nothing', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const plan = await planEpisodeRemap({ ...target, claim: SHIFT });
    arr.files.get(fixture.episodes.find((e) => e.episodeNumber === 13)!.episodeFileId)!.size += 1;
    await expect(
      runEpisodeRemap({ ...target, claim: SHIFT, planDigest: plan.digest, requesterId: memberId, commandWait: WAIT }),
    ).rejects.toBeInstanceOf(FixPlanChangedError);
    expect(arr.commandBodies()).toEqual([]);
    expect(await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId))).toHaveLength(0);
  });

  it('refuses a move onto an occupied slot and anything while the remedy is off, writing nothing', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const claim = { kind: 'shift', fromEpisodeNumber: 10, throughEpisodeNumber: 10, by: 1 } as const;
    const plan = await planEpisodeRemap({ ...target, claim });
    expect(plan.refusal).toBe('occupied');
    await expect(
      runEpisodeRemap({ ...target, claim, planDigest: plan.digest, requesterId: memberId, commandWait: WAIT }),
    ).rejects.toMatchObject({ reason: 'remap_refused' });
    await setRepairGuideRemedies({ db: t.db, remedies: { episode_remap: false }, actorId: null });
    const ok = await planEpisodeRemap({ ...target, claim: SHIFT });
    expect(ok.remapOn).toBe(false);
    await expect(
      runEpisodeRemap({ ...target, claim: SHIFT, planDigest: ok.digest, requesterId: memberId, commandWait: WAIT }),
    ).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.commandBodies()).toEqual([]);
  });

  it('stops at the first move that does not land, leaving every earlier move whole and renamed', async () => {
    const arr = stubSonarr();
    arr.state.stallImport = 3; // the third ManualImport stays queued past the wait
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 };
    const plan = await planEpisodeRemap({ ...target, claim: SHIFT });
    const result = await runEpisodeRemap({ ...target, claim: SHIFT, planDigest: plan.digest, requesterId: memberId, commandWait: WAIT });
    expect(result).toMatchObject({ outcome: 'stopped', moved: 2, planned: 7, vacated: [], mislabelGroups: [] });
    expect(result.stoppedText).toContain('still busy');
    // E18 → E19 and E17 → E18 landed; nothing else was sent after the stall.
    expect(arr.fileOn(19)?.size).toBe(sizeOn(18));
    expect(arr.fileOn(18)?.size).toBe(sizeOn(17));
    expect(arr.fileOn(16)?.size).toBe(sizeOn(16));
    expect(arr.commandBodies().filter((b) => b.name === 'ManualImport')).toHaveLength(3);
    expect(arr.state.orphaned).toEqual([]);
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect(row!.status).toBe('failed');
    // While Sonarr still holds the stalled move, nothing new is planned onto the season.
    const rest = { kind: 'shift', fromEpisodeNumber: 11, throughEpisodeNumber: 16, by: 1 } as const;
    expect((await planEpisodeRemap({ ...target, claim: rest })).refusal).toBe('sonarr_busy');
    // Once it is gone, the grain is released and the remaining moves plan cleanly, highest first.
    for (const c of arr.state.commands.values()) c.status = 'failed';
    const again = await planEpisodeRemap({ ...target, claim: rest });
    expect(again.refusal).toBeNull();
    expect(again.moves.map((m) => m.from[0]!.episodeNumber)).toEqual([16, 15, 14, 13, 11]);
  });

  it('refuses while a download for the season is queued', async () => {
    const arr = stubSonarr();
    arr.state.queue = [{ id: 1, seriesId: 1061, episodeId: 118425, seasonNumber: 1, title: 'x', status: 'downloading', size: 1, sizeleft: 1 }];
    const plan = await planEpisodeRemap({ db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, claim: SHIFT });
    expect(plan.refusal).toBe('queue_busy');
    expect(plan.refusalText).toBe('A download for this season is still being added. Try again once it has finished.');
  });

  it('reads the season for the guide with the suggested claim', async () => {
    const arr = stubSonarr();
    const view = await readRemapSeason({ db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1 });
    expect(view.remapOn).toBe(true);
    expect(view.episodes).toHaveLength(38);
    expect(view.episodes.find((e) => e.episodeNumber === 24)).toMatchObject({ hasFile: true, label: "S01E24 · Don's Back" });
    expect(view.suggestion.claim).toMatchObject({ kind: 'single' });
  });
});
