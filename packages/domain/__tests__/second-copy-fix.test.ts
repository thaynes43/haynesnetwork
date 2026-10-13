// DESIGN-055 P4 decision 25 (issue #928) — the staff Second-Copy Fix over the embedded Postgres harness and a small
// stateful stub Sonarr: the copy is deleted only when the episode it holds keeps its own file and nothing else in the
// season says it is the emptied episode; the Fix Request has no requester; the emptied episode is searched.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents } from '@hnet/db/schema';
import {
  FixPlanChangedError,
  FixRefusedError,
  buildArrClientBundle,
  planSecondCopyFix,
  runSecondCopyFix,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const SERIES_ID = 888;
const TITLES = ['Alpha Run', 'Bravo Night', 'Charlie Comes Home', 'Delta Force Five', 'Echo Lake'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Season 1: E3's file is a second copy of E5 ("Echo Lake"); E5 has its own file. `names` overrides scene names. */
function stubSonarr(opts: { e5HasFile?: boolean; names?: Record<number, string>; deleteNoop?: boolean } = {}) {
  const episodes = TITLES.map((title, i) => ({ id: 300 + i + 1, seasonNumber: 1, episodeNumber: i + 1, title, episodeFileId: 0 }));
  const files = new Map<number, { id: number; relativePath: string; sceneName: string; size: number }>();
  const contentOn: Array<[number, number]> = [[1, 1], [2, 2], [3, 5], [4, 4]];
  if (opts.e5HasFile !== false) contentOn.push([5, 5]);
  for (const [slot, content] of contentOn) {
    const id = 6000 + slot;
    episodes[slot - 1]!.episodeFileId = id;
    files.set(id, {
      id,
      relativePath: `Season 1/Show - S01E${pad(slot)} - ${TITLES[slot - 1]}.mkv`,
      sceneName: opts.names?.[slot] ?? `Show.S01E${pad(slot)}.${TITLES[content - 1]!.replace(/ /g, '.')}.1080p.WEB-DL-GRP`,
      size: 1000 + slot,
    });
  }
  const state = { deleted: [] as number[], searched: [] as number[][], nextCommand: 700 };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const quality = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0 } };
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/episode') {
      return json(episodes.map((e) => ({ id: e.id, seriesId: SERIES_ID, seasonNumber: 1, episodeNumber: e.episodeNumber, title: e.title, hasFile: e.episodeFileId > 0, monitored: true, ...(e.episodeFileId > 0 ? { episodeFileId: e.episodeFileId } : {}) })));
    }
    if (method === 'GET' && p === '/api/v3/episodefile') {
      return json([...files.values()].map((f) => ({ id: f.id, seriesId: SERIES_ID, seasonNumber: 1, relativePath: f.relativePath, sceneName: f.sceneName, releaseGroup: 'GRP', size: f.size, quality })));
    }
    if (method === 'GET' && p === '/api/v3/queue') return json({ page: 1, pageSize: 200, totalRecords: 0, records: [] });
    if (method === 'GET' && p === '/api/v3/command') return json([]);
    const del = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p);
    if (method === 'DELETE' && del) {
      const id = Number(del[1]);
      if (opts.deleteNoop) return json({});
      files.delete(id);
      for (const e of episodes) if (e.episodeFileId === id) e.episodeFileId = 0;
      state.deleted.push(id);
      return json({});
    }
    if (method === 'POST' && p === '/api/v3/command') {
      const b = body as { name: string; episodeIds?: number[] };
      if (b.name === 'EpisodeSearch') state.searched.push(b.episodeIds ?? []);
      return json({ id: state.nextCommand++, name: b.name });
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
  return { state, bundle, files, episodes };
}

describe('Second-Copy Fix (DESIGN-055 P4 decision 25)', () => {
  let t: TestDb;
  let itemId: string;
  const EVIDENCE = 'Subtitles 5:00-7:30 match line for line; durations 1321s and 1322s.';

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: SERIES_ID, tvdbId: 888_000, title: 'Show', sortTitle: 'show', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/data/tv' }],
    });
    const [row] = await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, SERIES_ID) });
    itemId = row!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, itemId));
    await t.db.delete(fixRequests).where(eq(fixRequests.mediaItemId, itemId));
  });

  it('deletes the copy on E3, keeps E5 own file, and searches E3, as staff', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 3 };
    const plan = await planSecondCopyFix(target);
    expect(plan.refusal).toBeNull();
    expect(plan.copy).toMatchObject({ fileId: 6003 });
    expect(plan.original).toMatchObject({ episodeNumber: 5, fileId: 6005 });
    expect(arr.state.deleted).toEqual([]); // the plan only reads

    const result = await runSecondCopyFix({ ...target, planDigest: plan.digest, evidence: EVIDENCE });
    expect(arr.state.deleted).toEqual([6003]);
    expect(arr.state.searched).toEqual([[303]]);
    expect(arr.files.has(6005)).toBe(true);
    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.fixRequestId));
    expect(row).toMatchObject({ requesterId: null, reason: 'wrong_content', status: 'search_triggered', pathTaken: 'delete_search', targetArrChildId: 303 });
    const trail = row!.actionsTaken as Array<Record<string, unknown>>;
    expect(trail[0]).toMatchObject({ step: 'created', requester: { staffTool: 'repair-guide.ts' } });
    expect(trail.find((a) => a.step === 'second_copy')).toMatchObject({ evidence: EVIDENCE });
    expect(trail.find((a) => a.step === 'delete_read_back')).toMatchObject({ ok: true, slotEmpty: true, copyGone: true, originalKept: true });
  });

  it('refuses the only copy, a file another one claims the slot of, and a name that agrees', async () => {
    const only = stubSonarr({ e5HasFile: false });
    expect((await planSecondCopyFix({ db: t.db, arr: only.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 3 })).refusal).toBe('only_copy');

    // E4's file says it is "Charlie Comes Home" (E3): E3's real content is in the library, so this is a re-map.
    const claimed = stubSonarr({ names: { 4: 'Show.S01E04.Charlie.Comes.Home.1080p.WEB-DL-GRP' } });
    const p = await planSecondCopyFix({ db: t.db, arr: claimed.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 3 });
    expect(p.refusal).toBe('content_elsewhere');
    expect(p.namedElsewhere).toEqual([expect.objectContaining({ episodeNumber: 4 })]);

    const agrees = stubSonarr();
    expect((await planSecondCopyFix({ db: t.db, arr: agrees.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 })).refusal).toBe('not_a_copy');
    // Staff evidence can name the original when the name does not.
    const named = await planSecondCopyFix({ db: t.db, arr: agrees.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2, copyOf: 4 });
    expect(named.refusal).toBeNull();
    expect(named.original).toMatchObject({ episodeNumber: 4 });
  });

  it('stops as failed, without searching, when the delete does not read back', async () => {
    const arr = stubSonarr({ deleteNoop: true });
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 3 };
    const plan = await planSecondCopyFix(target);
    await expect(runSecondCopyFix({ ...target, planDigest: plan.digest, evidence: EVIDENCE })).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.state.searched).toEqual([]);
    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.mediaItemId, itemId));
    expect(row!.status).toBe('failed');
    expect((row!.actionsTaken as Array<{ step: string }>).map((a) => a.step)).toContain('delete_not_landed');
  });

  it('refuses a changed plan and a run without evidence, writing nothing', async () => {
    const arr = stubSonarr();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 3 };
    const plan = await planSecondCopyFix(target);
    await expect(runSecondCopyFix({ ...target, planDigest: 'deadbeefdeadbeef', evidence: EVIDENCE })).rejects.toBeInstanceOf(FixPlanChangedError);
    await expect(runSecondCopyFix({ ...target, planDigest: plan.digest, evidence: 'none' })).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.state.deleted).toEqual([]);
    expect(await t.db.select().from(fixRequests).where(eq(fixRequests.mediaItemId, itemId))).toEqual([]);
  });
});
