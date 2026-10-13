// DESIGN-055 P4 decisions 18-23 (issue #916) — the Season Re-map over the embedded Postgres harness and a stateful stub
// Sonarr that follows Sonarr 4.0.20.3012's library-file ManualImport (the file stays on disk, its record is replaced, an
// import onto an episode that still had a file orphans that file) and RenameFiles (a name another file holds is skipped,
// never overwritten). The season holds a swap and a three-file rotation by the files' own names: every file must end on
// its own episode under its own name, through the parking episode, with nothing orphaned and the file count unchanged.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repairRequests, titleChecks } from '@hnet/db/schema';
import {
  FixPlanChangedError,
  FixRefusedError,
  TITLE_EVIDENCE_VERSION,
  buildArrClientBundle,
  planSeasonRemap,
  runSeasonRemap,
  setRepairGuideRemedies,
  upsertMediaItemsBatch,
  type ArrClientBundle,
  type SeasonPlexReader,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const SERIES_PATH = '/data/tv/Show';
const SERIES_ID = 777;
const TITLES = ['Alpha Run', 'Bravo Night', 'Charlie Comes Home', 'Delta Force Five', 'Echo Lake', 'Foxtrot Finale', 'Golf Course'];

interface StubEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  episodeFileId: number;
}
interface StubFile {
  id: number;
  relativePath: string;
  size: number;
  sceneName: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const nameFor = (e: StubEpisode) =>
  `${e.seasonNumber === 0 ? 'Specials' : `Season ${e.seasonNumber}`}/Show - S${pad(e.seasonNumber)}E${pad(e.episodeNumber)} - ${e.title}-GRP.mkv`;

/**
 * Season 1: E1 Alpha (right), E2/E3 a swap (Charlie on E2, Bravo on E3), E4..E6 a rotation (Echo on E4, Foxtrot on E5,
 * Delta on E6), E7 Golf (right). Specials: S00E01 has no file (the parking episode).
 */
function stubSonarr(opts: { strayName?: string } = {}) {
  const episodes: StubEpisode[] = TITLES.map((title, i) => ({ id: 100 + i + 1, seasonNumber: 1, episodeNumber: i + 1, title, episodeFileId: 0 }));
  episodes.push({ id: 901, seasonNumber: 0, episodeNumber: 1, title: 'Behind the Scenes', episodeFileId: 0 });
  const contentOn: Array<[number, number]> = [
    [1, 1],
    [2, 3],
    [3, 2],
    [4, 5],
    [5, 6],
    [6, 4],
    [7, 7],
  ];
  const files = new Map<number, StubFile>();
  for (const [slot, content] of contentOn) {
    const id = 5000 + content;
    const e = episodes.find((x) => x.seasonNumber === 1 && x.episodeNumber === slot)!;
    e.episodeFileId = id;
    files.set(id, {
      id,
      relativePath: nameFor(e),
      size: 10_000 + content,
      sceneName: `Show.S01E${pad(slot)}.${TITLES[content - 1]!.replace(/ /g, '.')}.1080p.WEB-DL-GRP`,
    });
  }
  const state = {
    nextFileId: 90_000,
    nextCommandId: 500,
    commands: new Map<number, { name: string; status: string }>(),
    orphaned: [] as string[],
    /** Paths on disk that Sonarr does not track (a stray file holding a name). */
    stray: new Set<string>(opts.strayName ? [opts.strayName] : []),
    calls: [] as Array<{ method: string; path: string; body: unknown; query: string }>,
  };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const quality = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0 } };
  const seasonOf = (f: StubFile) => episodes.find((e) => e.episodeFileId === f.id)?.seasonNumber ?? 1;
  const expectedName = (f: StubFile) => {
    const on = episodes.filter((e) => e.episodeFileId === f.id).sort((a, b) => a.episodeNumber - b.episodeNumber);
    return on.length === 0 ? f.relativePath : nameFor(on[0]!);
  };
  const taken = (path: string, except: number) =>
    state.stray.has(path) || [...files.values()].some((x) => x.id !== except && x.relativePath === path);
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path: url.pathname, body, query: url.search });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/episode') {
      return json(
        episodes.map((e) => ({
          id: e.id,
          seriesId: SERIES_ID,
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.episodeFileId > 0,
          monitored: true,
          ...(e.episodeFileId > 0 ? { episodeFileId: e.episodeFileId } : {}),
        })),
      );
    }
    if (method === 'GET' && p === '/api/v3/episodefile') {
      return json(
        [...files.values()].map((f) => ({ id: f.id, seriesId: SERIES_ID, seasonNumber: seasonOf(f), relativePath: f.relativePath, sceneName: f.sceneName, releaseGroup: 'GRP', size: f.size, quality })),
      );
    }
    if (method === 'GET' && p === '/api/v3/queue') return json({ page: 1, pageSize: 200, totalRecords: 0, records: [] });
    if (method === 'GET' && p === '/api/v3/manualimport') {
      // Sonarr lists the files the database maps to that season (`GetFilesBySeason`).
      const season = Number(url.searchParams.get('seasonNumber'));
      return json(
        [...files.values()]
          .filter((f) => seasonOf(f) === season)
          .map((f) => ({
            id: f.id * 10,
            path: `${SERIES_PATH}/${f.relativePath}`,
            relativePath: f.relativePath,
            folderName: 'Show',
            size: f.size,
            series: { id: SERIES_ID, title: 'Show', year: 2020 },
            seasonNumber: season,
            episodes: [],
            episodeFileId: f.id,
            releaseGroup: 'GRP',
            quality,
            languages: [{ id: 1, name: 'English' }],
            indexerFlags: 0,
            releaseType: 'singleEpisode',
            rejections: [],
          })),
      );
    }
    if (method === 'GET' && p === '/api/v3/rename') {
      const season = Number(url.searchParams.get('seasonNumber'));
      return json(
        [...files.values()]
          .filter((f) => seasonOf(f) === season && f.relativePath !== expectedName(f))
          .map((f) => ({ seriesId: SERIES_ID, seasonNumber: season, episodeFileId: f.id, existingPath: f.relativePath, newPath: expectedName(f) })),
      );
    }
    if (method === 'POST' && p === '/api/v3/command') {
      const id = state.nextCommandId++;
      const name = (body as { name: string }).name;
      if (name === 'ManualImport') {
        for (const f of (body as { files: Array<{ path: string; episodeIds: number[] }> }).files) {
          const rel = f.path.slice(SERIES_PATH.length + 1);
          const old = [...files.values()].find((x) => x.relativePath === rel)!;
          files.delete(old.id);
          for (const e of episodes) if (e.episodeFileId === old.id) e.episodeFileId = 0;
          for (const t of f.episodeIds) {
            const e = episodes.find((x) => x.id === t)!;
            if (e.episodeFileId > 0) {
              const other = files.get(e.episodeFileId);
              if (other) state.orphaned.push(other.relativePath);
            }
          }
          const fresh: StubFile = { ...old, id: state.nextFileId++, sceneName: null };
          files.set(fresh.id, fresh);
          for (const t of f.episodeIds) episodes.find((x) => x.id === t)!.episodeFileId = fresh.id;
        }
      } else if (name === 'RenameFiles') {
        for (const fid of (body as { files: number[] }).files) {
          const f = files.get(fid);
          if (!f) continue;
          const next = expectedName(f);
          if (taken(next, fid)) continue; // FileAlreadyExists: skipped, never overwritten
          f.relativePath = next;
        }
      }
      state.commands.set(id, { name, status: 'completed' });
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
  const o = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  const bundle: ArrClientBundle = buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...o },
    radarr: { baseUrl: 'http://radarr.test:7878', ...o },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...o },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...o },
  });
  const commands = () => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v3/command').map((c) => c.body as Record<string, unknown>);
  const fileOn = (season: number, n: number) => {
    const e = episodes.find((x) => x.seasonNumber === season && x.episodeNumber === n)!;
    return e.episodeFileId > 0 ? files.get(e.episodeFileId) ?? null : null;
  };
  return { state, bundle, files, episodes, commands, fileOn };
}

const plexFollowingTvdb: SeasonPlexReader = {
  async seasonTitles() {
    return [{ server: 'haynestower', items: TITLES.map((title, i) => ({ episodeNumber: i + 1, title })) }];
  },
};

describe('Season Re-map (DESIGN-055 P4 decisions 18-23)', () => {
  let t: TestDb;
  let itemId: string;
  const WAIT = { timeoutMs: 50, intervalMs: 5 };

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: SERIES_ID, tvdbId: 777_000, title: 'Show', sortTitle: 'show', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/data/tv' }],
    });
    const [row] = await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, SERIES_ID) });
    itemId = row!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await setRepairGuideRemedies({ db: t.db, remedies: { episode_remap: true }, actorId: null });
    await t.db.delete(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    await t.db.delete(titleChecks).where(eq(titleChecks.seriesId, SERIES_ID));
  });

  it('puts every file on the episode its name says, through the parking episode, renamed, losing nothing', async () => {
    const arr = stubSonarr();
    // The census flagged the file on E2 ("Charlie Comes Home", E3).
    const charlie = 'Show.S01E02.Charlie.Comes.Home.1080p.WEB-DL-GRP';
    await t.db.insert(titleChecks).values({
      instance: 'sonarr',
      seriesId: SERIES_ID,
      mediaItemId: itemId,
      seasonNumber: 1,
      episodeId: 102,
      episodeNumber: 2,
      episodeIds: [102],
      episodeFileId: 5003,
      sourceTitle: charlie,
      verdict: 'disagrees',
      bestEpisodeId: 103,
      bestEpisodeNumber: 3,
      score: 0,
      bestScore: 1,
      evidenceVersion: TITLE_EVIDENCE_VERSION,
      origin: 'backfill',
      importedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    expect(plan.refusal).toBeNull();
    expect(plan.plexCheck?.ok).toBe(true);
    expect(plan.moved).toBe(5);
    expect(plan.parking).toMatchObject({ seasonNumber: 0, episodeNumber: 1 });
    expect(plan.steps.filter((s) => s.kind === 'park')).toHaveLength(2);
    expect(arr.commands()).toEqual([]); // the plan only reads

    const result = await runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0 });
    expect(result).toMatchObject({ outcome: 'moved', done: plan.steps.length, planned: plan.steps.length, moved: 5, parked: null, fileCountUnchanged: true, stoppedText: null });
    expect(arr.state.orphaned).toEqual([]);
    for (let n = 1; n <= 7; n += 1) {
      const f = arr.fileOn(1, n)!;
      expect(f.size, `E${n} holds its own content`).toBe(10_000 + n);
      expect(f.relativePath).toBe(`Season 1/Show - S01E${pad(n)} - ${TITLES[n - 1]}-GRP.mkv`);
    }
    expect(arr.fileOn(0, 1)).toBeNull();
    expect(arr.files.size).toBe(7);
    // One RenameFiles per step, each for that step's file only.
    const renames = arr.commands().filter((b) => b.name === 'RenameFiles');
    expect(renames).toHaveLength(plan.steps.length);
    expect(renames.every((b) => (b.files as number[]).length === 1)).toBe(true);
    // A parked file is read back from the parking season's import candidates.
    expect(arr.state.calls.some((c) => c.path === '/api/v3/manualimport' && c.query.includes('seasonNumber=0'))).toBe(true);

    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect(row).toMatchObject({ kind: 'remap', scope: 'season', seasonNumber: 1, status: 'completed', requesterId: null });
    expect((row!.preview as { claim: { kind: string } }).claim.kind).toBe('names');
    const trail = row!.actionsTaken as Array<{ step: string; ok?: boolean }>;
    expect(trail[0]).toMatchObject({ step: 'created', requester: { staffTool: 'repair-guide.ts' } });
    expect(trail.filter((a) => a.step === 'season_remap_rename').every((a) => a.ok)).toBe(true);
    expect(trail.at(-1)).toMatchObject({ step: 'season_remap_done', ok: true, fileCountUnchanged: true });

    // The census follows the files: the old flag is cleared and each moved file's new id carries its names, agreeing.
    const rows = await t.db.select().from(titleChecks).where(eq(titleChecks.seriesId, SERIES_ID));
    expect(rows.find((r) => r.episodeFileId === 5003)!.clearedAt).not.toBeNull();
    const carried = rows.filter((r) => r.episodeFileId >= 90_000);
    expect(carried).toHaveLength(5);
    expect(carried.every((r) => r.verdict === 'agrees' && r.origin === 'backfill')).toBe(true);
    expect(carried.find((r) => r.sourceTitle === charlie)).toMatchObject({ episodeIds: [103], importedAt: new Date('2026-01-01T00:00:00Z') });

    // Afterwards every name agrees with its episode: nothing left to move.
    const again = await planSeasonRemap(target);
    expect(again.refusal).toBe('nothing_to_move');
  });

  it('stops at a rename Sonarr skips and reports the parked file with where it belongs', async () => {
    // A stray file already holds the parking episode's name, so the rename after the first park is skipped and the run
    // stops there: the parked file is reported with the episode it belongs on.
    const arr = stubSonarr({ strayName: 'Specials/Show - S00E01 - Behind the Scenes-GRP.mkv' });
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    const result = await runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0 });
    expect(result.outcome).toBe('stopped');
    expect(result.done).toBe(0);
    expect(result.stoppedText).toMatch(/kept its old name/);
    // Charlie (on E2, the lowest file of the first cycle) went to the parking episode and belongs on E3.
    expect(result.parked).toMatchObject({ on: { episodeNumber: 1 }, belongs: [expect.objectContaining({ episodeNumber: 3 })] });
    expect(arr.state.orphaned).toEqual([]);
    expect(result.fileCountUnchanged).toBe(true);
    const [row] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect(row!.status).toBe('failed');
  });

  it('refuses a changed season, a failed Plex check, and the remedy switched off, writing nothing', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    await expect(runSeasonRemap({ ...target, planDigest: 'deadbeefdeadbeef', commandWait: WAIT })).rejects.toBeInstanceOf(FixPlanChangedError);

    const plexOther: SeasonPlexReader = {
      async seasonTitles() {
        // Plex numbers E2 and E3 like the files (as a streaming order would): moving them would make both titles wrong.
        return [{ server: 'haynesops', items: TITLES.map((title, i) => ({ episodeNumber: i + 1, title: i === 1 ? TITLES[2]! : i === 2 ? TITLES[1]! : title })) }];
      },
    };
    const withOther = { ...target, plex: plexOther };
    const view = await planSeasonRemap(withOther);
    expect(view.plexCheck?.ok).toBe(false);
    await expect(runSeasonRemap({ ...withOther, planDigest: view.digest, commandWait: WAIT })).rejects.toBeInstanceOf(FixRefusedError);

    // A Plex server that cannot be read: the plan says why, and a run refuses with the reason.
    const plexDown: SeasonPlexReader = {
      async seasonTitles() {
        throw new Error('haynesops: connect ECONNREFUSED');
      },
    };
    const down = await planSeasonRemap({ ...target, plex: plexDown });
    expect(down.plexCheck).toBeNull();
    expect(down.plexError).toMatch(/ECONNREFUSED/);
    await expect(runSeasonRemap({ ...target, plex: plexDown, planDigest: down.digest, commandWait: WAIT })).rejects.toThrow(/ECONNREFUSED/);

    await setRepairGuideRemedies({ db: t.db, remedies: { episode_remap: false }, actorId: null });
    await expect(runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT })).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.commands()).toEqual([]);
    expect(await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId))).toEqual([]);
  });
});
