// A numbered Release Pick remains owned by its authenticated caller when Sonarr tracks the completed file elsewhere.
// Router -> common domain writer -> Postgres 16 + bounded fetch stub. One worker; no load or looped tests.
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents, repairRequests, watchCarries } from '@hnet/db';
import { buildArrClientBundle, setRepairGuideRemedies } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';

const QUALITY = {
  quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
  revision: { version: 1, real: 0, isRepack: false },
};
const POKE =
  "Pokemon S03E12 Don't touch that 'dile 1080p JC WEB-DL x264 (AAC 2.0) [Hin+Tel+Tam+Eng]-T0Bi";
const MICKEY =
  'Mickey.Mouse..MixedUp.Adventures.S01E01E02.Mickeys.Wild.Tire..Sittin.Kitty.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor';
const seriesFixture = JSON.parse(
  readFileSync(new URL('../../arr/__fixtures__/sonarr.series-byid.json', import.meta.url), 'utf8'),
);

function ownedArr(mickey = false) {
  const seriesId = mickey ? 439 : 549;
  const title = mickey ? MICKEY : POKE;
  const targetIds = mickey ? [37181, 37182] : [49199];
  const rawIds = mickey ? [37181, 37182, 37183, 37184] : [49210];
  const downloadId = `consumer-${seriesId}`;
  const episode = (id: number, episodeNumber: number, name: string, episodeFileId = 0) => ({
    id,
    seriesId,
    seasonNumber: mickey ? 1 : 3,
    episodeNumber,
    title: name,
    hasFile: episodeFileId > 0,
    episodeFileId,
    monitored: true,
  });
  const episodes = mickey
    ? [
        episode(37181, 1, "Mickey's Wild Tire!"),
        episode(37182, 2, "Sittin' Kitty"),
        episode(37183, 3, 'Mickey Goes Fishing', 24800),
        episode(37184, 4, 'Goofy Gas', 24800),
      ]
    : [episode(49199, 1, "Don't Touch That 'Dile"), episode(49210, 12, 'The Whistle Stop', 33229)];
  const state = {
    episodes,
    files: [
      {
        id: mickey ? 24800 : 33229,
        seriesId,
        relativePath: 'protected-old-content.mkv',
        size: 1_108_994_733,
      },
    ],
    history: targetIds.map((episodeId, i) => ({
      id: 66760 + i,
      eventType: 'grabbed',
      episodeId,
      downloadId,
      sourceTitle: title,
      date: new Date(Date.now() + 1000).toISOString(),
      data: {} as Record<string, string>,
    })),
    candidate: {
      id: 42,
      path: `/downloads/${title}/${title}.mkv`,
      downloadId,
      size: 1_563_438_952,
      folderName: title,
      series: { id: seriesId, year: mickey ? 2017 : 1997 },
      seasonNumber: mickey ? 1 : 3,
      episodes: episodes.filter((e) => rawIds.includes(e.id)),
      quality: QUALITY,
      languages: [{ id: 1, name: 'English' }],
      releaseGroup: mickey ? 'AndreMor' : 'T0Bi',
      indexerFlags: 0,
      releaseType: mickey ? 'multiEpisode' : 'singleEpisode',
      rejections: [
        {
          type: 'permanent',
          reason: mickey
            ? 'Not a Custom Format upgrade for existing episode file(s).'
            : "Episode 3x12 was not found in the grabbed release: Pokemon S03E12 Don't touch that 'dile",
        },
      ],
    },
    evaluationRejections: [] as Array<{ type: string; reason: string }>,
    complete: true,
    queueStatus: 'completed',
    queueTrackedState: 'importPending',
    queueForgotten: false,
    writes: [] as Array<{ path: string; body: unknown; query: Record<string, string> }>,
  };
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET') {
      if (url.pathname.endsWith('/history/series')) return json(state.history);
      if (url.pathname.endsWith('/episodefile'))
        return json(state.files.map((f) => ({ ...f, quality: QUALITY, mediaInfo: {} })));
      if (url.pathname.endsWith('/episode')) return json(state.episodes);
      if (url.pathname.endsWith(`/series/${seriesId}`))
        return json({ ...seriesFixture, id: seriesId, year: mickey ? 2017 : 1997 });
      if (url.pathname.endsWith('/manualimport')) return json([state.candidate]);
      if (url.pathname.endsWith('/queue'))
        return json({
          page: 1,
          pageSize: 200,
          totalRecords: state.queueForgotten ? 0 : rawIds.length,
          records: (state.queueForgotten ? [] : rawIds).map((episodeId, i) => ({
            id: 1000 + i,
            seriesId,
            episodeId,
            downloadId,
            title,
            status: state.queueStatus,
            trackedDownloadState: state.queueTrackedState,
            trackedDownloadStatus: 'warning',
            statusMessages: [],
          })),
        });
      if (url.pathname.endsWith('/command/77'))
        return json({
          id: 77,
          name: 'ManualImport',
          status: state.complete ? 'completed' : 'started',
        });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/v3/queue/')) {
      state.writes.push({ path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
      state.queueForgotten = true;
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      state.writes.push({ path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
      if (url.pathname.endsWith('/manualimport')) {
        const file = body[0] as { episodeIds: number[] };
        return json([
          {
            ...state.candidate,
            ...file,
            episodes: state.episodes.filter((e) => file.episodeIds.includes(e.id)),
            rejections: state.evaluationRejections,
          },
        ]);
      }
      if (url.pathname.endsWith('/command')) {
        if (state.complete) {
          for (const file of body.files as Array<{ episodeIds: number[] }>)
            for (const id of file.episodeIds) {
              const e = state.episodes.find((x) => x.id === id)!;
              e.hasFile = true;
              e.episodeFileId = 90001;
              state.history.push({
                id: 90001 + id,
                eventType: 'downloadFolderImported',
                episodeId: id,
                downloadId,
              sourceTitle: title,
              date: new Date().toISOString(),
              data: { fileId: '90001' },
              });
            }
          state.files.push({
            id: 90001,
            seriesId,
            relativePath: 'correct-new-content.mkv',
            size: 1_563_438_952,
          });
        }
        return json({ id: 77, name: 'ManualImport' });
      }
    }
    return json({ message: 'Unexpected endpoint' }, 404);
  }) as typeof fetch;
  const opts = { apiKey: 'test', fetchImpl, retryDelayMs: 0 };
  const arr = buildArrClientBundle({
    sonarr: { ...opts, baseUrl: 'http://sonarr.test:8989' },
    radarr: { ...opts, baseUrl: 'http://radarr.test:7878' },
    lidarr: { ...opts, baseUrl: 'http://lidarr.test:8686' },
    bazarr: { ...opts, baseUrl: 'http://bazarr.test:6767' },
  });
  return { state, arr, seriesId, title, targetIds };
}

describe('authenticated parent-owned Force Search continuation', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  }, 120_000);
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(async () => {
    await t.db.delete(repairRequests);
    await t.db.delete(fixRequests);
    await t.db.delete(watchCarries);
    await setRepairGuideRemedies({ db: t.db, remedies: { import_check: true }, actorId: null });
  });
  async function setup(mickey = false, staffFix = false) {
    const s = ownedArr(mickey);
    const user = await createUser(t.db, { admin: staffFix });
    const item = await seedMediaItem(t.db, 'sonarr', {
      arrItemId: s.seriesId,
      title: 'Owned import fixture',
    });
    let parentId: string;
    if (staffFix) {
      const [parent] = await t.db
        .insert(fixRequests)
        .values({
          mediaItemId: item.id,
          requesterId: null,
          reason: 'wrong_content',
          targetScope: 'episode',
          targetArrChildId: s.targetIds[0],
          status: 'search_triggered',
          pathTaken: 'delete_search',
          actionsTaken: [
            { step: 'release_grab', at: new Date().toISOString(), ok: true, release: s.title },
          ],
        })
        .returning();
      parentId = parent!.id;
      await t.db.insert(watchCarries).values({
        kind: 'wrong_content',
        mediaItemId: item.id,
        seriesId: s.seriesId,
        status: 'verified',
        takenAt: new Date(),
        scope: { pendingDeletes: [] },
        detail: {
          fixRequestId: parentId,
          releases: [s.title],
          wrongContentDeletion: {
            version: 1,
            grabStarted: true,
            files: [{ episodeIds: s.targetIds }],
          },
        },
      });
    } else {
      const [parent] = await t.db
        .insert(repairRequests)
        .values({
          mediaItemId: item.id,
          requesterId: user.id,
          kind: 'release_pick',
          scope: 'episode',
          seasonNumber: mickey ? 1 : 3,
          targetChildIds: s.targetIds,
          status: 'actioned',
          preview: { title: s.title },
          actionsTaken: [{ step: 'grab', at: new Date().toISOString(), ok: true, title: s.title }],
        })
        .returning();
      parentId = parent!.id;
    }
    return {
      ...s,
      user,
      item,
      parentId,
      api: caller(makeCtx(t.db, sessionUser(user), s.arr)),
      target: { mediaItemId: item.id, scope: 'episode' as const, targetChildId: s.targetIds[0]! },
    };
  }

  it('finds a wrong-number queue through authenticated ownership and continues the same Release Pick', async () => {
    const s = await setup();
    const plan = await s.api.fix.searchPlan(s.target);
    expect(plan).toMatchObject({
      state: 'import',
      needsTargetCheck: false,
      intendedImportTargetIds: [49199],
      check: { verdict: 'importable', title: { verdict: 'agrees' } },
      replaces: [],
    });
    expect(JSON.stringify(plan)).not.toContain('/downloads/');
    expect(JSON.stringify(plan)).not.toContain(s.parentId);
    expect(s.state.writes).toEqual([]);
    const result = await s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest });
    expect(result).toMatchObject({
      outcome: 'imported',
      repairRequestId: s.parentId,
      fixRequestId: null,
      eventId: null,
    });
    expect(s.state.writes.map((w) => w.path)).toEqual([
      '/api/v3/manualimport',
      '/api/v3/command',
      '/api/v3/queue/1000',
    ]);
    expect(s.state.writes[1]!.body).toMatchObject({
      name: 'ManualImport',
      files: [{ episodeIds: [49199] }],
    });
    expect(s.state.writes[2]!.query).toEqual({
      removeFromClient: 'false',
      blocklist: 'false',
      skipRedownload: 'true',
    });
    expect(s.state.episodes.find((e) => e.id === 49210)!.episodeFileId).toBe(33229);
    const rows = await t.db
      .select()
      .from(repairRequests)
      .where(eq(repairRequests.mediaItemId, s.item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: s.parentId, kind: 'release_pick', status: 'actioned' });
    const intent = rows[0]!.actionsTaken.find((a) => a.step === 'owned_import_intent')!;
    expect(intent.evidence).toContain(`Authenticated user ${s.user.id} confirmed`);
    expect(String(intent.evidence)).not.toMatch(/physical|audio.*verified/i);
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.mediaItemId, s.item.id));
    expect(events.some((e) => e.eventType === 'search_requested')).toBe(false);
  });

  it('keeps raw quality refusal truthful, shows separate whole intended coverage and preserves fresh hard reasons', async () => {
    const s = await setup(true);
    const plan = await s.api.fix.searchPlan(s.target);
    expect(plan).toMatchObject({
      state: 'import',
      needsTargetCheck: true,
      intendedImportTargetIds: [37181, 37182],
      check: {
        verdict: 'not_importable',
        reason: 'have_better',
        detail: s.state.candidate.rejections[0]!.reason,
      },
    });
    s.state.evaluationRejections = [
      { type: 'permanent', reason: 'Not a Custom Format upgrade for existing episode file(s).' },
    ];
    await expect(
      s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/manualimport']);
    expect(s.state.episodes.map((e) => e.episodeFileId)).toEqual([0, 0, 24800, 24800]);
    expect(await t.db.select().from(repairRequests)).toHaveLength(1);
  });

  it('refuses stale source identity and an attempt to slice or redirect an owned whole file', async () => {
    const s = await setup(true);
    const plan = await s.api.fix.searchPlan(s.target);
    await expect(
      s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest, ontoEpisodeId: 37181 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    s.state.candidate.size += 1;
    await expect(
      s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.state.writes).toEqual([]);
    expect(await t.db.select().from(repairRequests)).toHaveLength(1);
  });

  it('cannot use injected owner/admin/parent fields to continue another user request', async () => {
    const s = await setup();
    const other = await createUser(t.db);
    const api = caller(makeCtx(t.db, sessionUser(other), s.arr));
    const injected = {
      ...s.target,
      requesterId: s.user.id,
      requesterIsAdmin: true,
      parentId: s.parentId,
    };
    await expect(api.fix.searchPlan(injected)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(api.fix.forceSearch(injected)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(s.state.writes).toEqual([]);
    expect(await t.db.select().from(repairRequests)).toHaveLength(1);
  });

  it('keeps another overlapping parent blocked instead of opening a parallel import', async () => {
    const s = await setup();
    await t.db.insert(repairRequests).values({
      mediaItemId: s.item.id,
      requesterId: s.user.id,
      kind: 'remap',
      scope: 'season',
      seasonNumber: 3,
      targetChildIds: [49199],
      status: 'pending',
    });
    await expect(s.api.fix.searchPlan(s.target)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(s.state.writes).toEqual([]);
    expect(await t.db.select().from(repairRequests)).toHaveLength(2);
  });

  it('observes a recorded import intent without sending another command or pretending the parent completed', async () => {
    const s = await setup();
    s.state.complete = false;
    const first = await s.api.fix.searchPlan(s.target);
    expect(await s.api.fix.forceSearch({ ...s.target, planDigest: first.digest })).toMatchObject({
      outcome: 'importing',
      repairRequestId: s.parentId,
    });
    const next = await s.api.fix.searchPlan(s.target);
    expect(next).toMatchObject({ state: 'on_its_way', intendedImportTargetIds: [49199] });
    expect(await s.api.fix.forceSearch({ ...s.target, planDigest: next.digest })).toMatchObject({
      outcome: 'on_its_way',
      repairRequestId: s.parentId,
    });
    expect(s.state.writes).toHaveLength(2);
    expect((await t.db.select().from(repairRequests))[0]!.status).toBe('actioned');
  });

  it('shows an owned wrong-number download still in progress as on its way, with no search or parallel repair', async () => {
    const s = await setup();
    s.state.queueStatus = 'downloading';
    s.state.queueTrackedState = 'downloading';
    const plan = await s.api.fix.searchPlan(s.target);
    expect(plan).toMatchObject({ state: 'on_its_way', intendedImportTargetIds: [49199] });
    expect(await s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest })).toMatchObject({
      outcome: 'on_its_way',
      repairRequestId: s.parentId,
      fixRequestId: null,
      commandName: null,
    });
    expect(s.state.writes).toEqual([]);
    expect(await t.db.select().from(repairRequests)).toHaveLength(1);
    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.mediaItemId, s.item.id));
    expect(events.some((e) => e.eventType === 'search_requested')).toBe(false);
  });

  it('returns an existing staff Fix ID separately for an authenticated admin, never as a Repair Request ID', async () => {
    const s = await setup(false, true);
    const plan = await s.api.fix.searchPlan(s.target);
    expect(await s.api.fix.forceSearch({ ...s.target, planDigest: plan.digest })).toMatchObject({
      outcome: 'imported',
      repairRequestId: null,
      fixRequestId: s.parentId,
    });
    expect(await t.db.select().from(repairRequests)).toEqual([]);
    expect((await t.db.select().from(fixRequests))[0]!.status).toBe('search_triggered');
  });
});
