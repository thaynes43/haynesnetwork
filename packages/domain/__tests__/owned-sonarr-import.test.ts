import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents, mediaItems, repairRequests, watchCarries } from '@hnet/db';
import {
  buildArrClientBundle,
  findOwnedSonarrImport,
  planOwnedSonarrImport,
  runOwnedSonarrImport,
  setRepairGuideRemedies,
  openReleaseList,
  completeRepairRequests,
  completeFixRequests,
  settleReleasePicks,
  upsertMediaItemsBatch,
  type OwnedImportActor,
  type OwnedImportParent,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const QUALITY = {
  quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
  revision: { version: 1, real: 0, isRepack: false },
};
const POKE =
  "Pokemon S03E12 Don't touch that 'dile 1080p JC WEB-DL x264 (AAC 2.0) [Hin+Tel+Tam+Eng]-T0Bi";
const MICKEY =
  'Mickey.Mouse..MixedUp.Adventures.S01E01E02.Mickeys.Wild.Tire..Sittin.Kitty.MULTI.1080p.DSNP.WEB-DL.AAC2.0.x264-AndreMor';
const fixture = JSON.parse(
  readFileSync(new URL('../../arr/__fixtures__/sonarr.series-byid.json', import.meta.url), 'utf8'),
);
const actor: OwnedImportActor = { kind: 'staff' };
const evidence = 'Physical story frame and actual English audio track verified';

function stub(mickey = false) {
  const sid = mickey ? 439 : 549;
  const title = mickey ? MICKEY : POKE;
  const targets = mickey ? [37181, 37182] : [49199];
  const raw = mickey ? [37181, 37182, 37183, 37184] : [49210];
  const downloadId = mickey ? 'owned-mickey' : 'owned-pokemon';
  const ep = (id: number, n: number, name: string, fileId = 0) => ({
    id,
    seriesId: sid,
    seasonNumber: mickey ? 1 : 3,
    episodeNumber: n,
    title: name,
    monitored: true,
    hasFile: fileId > 0,
    episodeFileId: fileId,
  });
  const episodes = mickey
    ? [
        ep(37181, 1, "Mickey's Wild Tire!"),
        ep(37182, 2, "Sittin' Kitty"),
        ep(37183, 3, 'Mickey Goes Fishing', 24800),
        ep(37184, 4, 'Goofy Gas', 24800),
      ]
    : [ep(49199, 1, "Don't Touch That 'Dile"), ep(49210, 12, 'The Whistle Stop', 33229)];
  const state = {
    episodes,
    files: [
      {
        id: mickey ? 24800 : 33229,
        seriesId: sid,
        relativePath: 'held-old-content.mkv',
        size: 1108994733,
      },
    ],
    history: targets.map((episodeId, i) => ({
      id: 66760 + i,
      eventType: 'grabbed',
      episodeId,
      downloadId,
      data: {} as Record<string, string>,
      sourceTitle: title,
      date: new Date(Date.now() + 1000).toISOString(),
    })),
    candidate: {
      id: 42,
      path: `/downloads/${title}/${title}.mkv`,
      downloadId,
      size: 1563438952,
      folderName: title,
      series: { id: sid, year: mickey ? 2017 : 1997 },
      seasonNumber: mickey ? 1 : 3,
      episodes: episodes.filter((e) => raw.includes(e.id)),
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
    evaluationExtraEpisode: false,
    commandThrows: false,
    queueRemoved: false,
    queueStatus: 'completed',
    queueTrackedState: null as string | null,
    keepForeignQueue: false,
    changeProtectedAfterImport: false,
    afterImport: null as null | (() => Promise<void>),
    queueDeleteReturns404AfterRemoval: false,
    complete: true,
    writes: [] as Array<{
      path: string;
      body: Record<string, unknown> | Array<Record<string, unknown>>;
    }>,
  };
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const u = new URL(String(input)),
      method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET') {
      if (u.pathname.endsWith('/history/series')) return json(state.history);
      if (u.pathname.endsWith('/episodefile'))
        return json(state.files.map((f) => ({ ...f, quality: QUALITY, mediaInfo: {} })));
      if (u.pathname.endsWith('/episode')) return json(state.episodes);
      if (u.pathname.endsWith(`/series/${sid}`))
        return json({ ...fixture, id: sid, year: mickey ? 2017 : 1997 });
      if (u.pathname.endsWith('/manualimport')) return json([state.candidate]);
      if (u.pathname.endsWith('/queue'))
        return json({
          page: 1,
          pageSize: 200,
          totalRecords: raw.length,
          records: [
            ...(state.queueRemoved
              ? []
              : raw.map((episodeId, i) => ({
                  id: 1000 + i,
                  seriesId: sid,
                  episodeId,
                  downloadId,
                  title,
                  status: state.queueStatus,
                  trackedDownloadState:
                    state.queueTrackedState ??
                    (state.queueStatus === 'completed' ? 'importPending' : 'downloading'),
                  trackedDownloadStatus: 'warning',
                  statusMessages: [],
                }))),
            ...(state.keepForeignQueue
              ? [
                  {
                    id: 9876,
                    episodeId: raw[0],
                    seriesId: sid,
                    downloadId: 'unrelated-download',
                    title: 'unrelated release',
                    status: 'completed',
                  },
                ]
              : []),
          ],
        });
      if (u.pathname.endsWith('/command/77'))
        return json({
          id: 77,
          name: 'ManualImport',
          status: state.complete ? 'completed' : 'started',
        });
    }
    if (method === 'DELETE' && u.pathname === '/api/v3/queue/1000') {
      state.writes.push({ path: u.pathname, body: Object.fromEntries(u.searchParams) });
      state.queueRemoved = true;
      for (const episodeId of raw)
        state.history.push({
          id: 80000 + episodeId,
          eventType: 'downloadIgnored',
          episodeId,
          downloadId,
          sourceTitle: title,
          date: new Date().toISOString(),
          data: {},
        });
      return state.queueDeleteReturns404AfterRemoval
        ? json({ message: 'Already absent' }, 404)
        : new Response(null, { status: 200 });
    }
    if (method === 'POST') {
      state.writes.push({ path: u.pathname, body });
      if (u.pathname.endsWith('/manualimport')) {
        const f = body[0];
        return json([
          {
            ...f,
            episodes: state.episodes.filter(
              (e) =>
                f.episodeIds.includes(e.id) ||
                (state.evaluationExtraEpisode && !targets.includes(e.id)),
            ),
            rejections: state.evaluationRejections,
          },
        ]);
      }
      if (u.pathname.endsWith('/command')) {
        if (state.commandThrows) return json({ message: 'uncertain command' }, 503);
        if (state.complete) {
          for (const f of body.files)
            for (const id of f.episodeIds) {
              const e = state.episodes.find((e) => e.id === id)!;
              e.hasFile = true;
              e.episodeFileId = 90001;
              state.history.push({
                id: 90001 + id,
                eventType: 'downloadFolderImported',
                episodeId: id,
                downloadId,
                sourceTitle: 'physical-scene-name-differs-from-grab',
                date: new Date().toISOString(),
                data: { fileId: '90001' },
              });
            }
          state.files.push({
            id: 90001,
            seriesId: sid,
            relativePath: 'correct-new-content.mkv',
            size: 1563438952,
          });
          if (state.changeProtectedAfterImport) state.files[0]!.size += 1;
          await state.afterImport?.();
        }
        return json({ id: 77, name: 'ManualImport' });
      }
    }
    return json({ message: 'unexpected stub endpoint' }, 404);
  }) as typeof fetch;
  const opts = { apiKey: 'test', retryDelayMs: 0, fetchImpl };
  const arr = buildArrClientBundle({
    sonarr: { ...opts, baseUrl: 'http://sonarr.test:8989' },
    radarr: { ...opts, baseUrl: 'http://radarr.test:7878' },
    lidarr: { ...opts, baseUrl: 'http://lidarr.test:8686' },
    bazarr: { ...opts, baseUrl: 'http://bazarr.test:6767' },
  });
  return { state, arr, sid, title, downloadId, targets };
}

describe('parent-owned Sonarr Import Check (bounded, single worker)', () => {
  let t: TestDb;
  let userId: string;
  let itemIds: Record<number, string>;
  beforeAll(async () => {
    t = await bootMigratedDb();
    userId = (await createUser(t.db)).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [549, 439].map((arrItemId) => ({
        arrItemId,
        tvdbId: arrItemId,
        title: 'Owned import fixture',
        sortTitle: 'fixture',
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
      })),
    });
    itemIds = Object.fromEntries(
      (await t.db.select().from(mediaItems)).map((m) => [m.arrItemId, m.id]),
    );
    await setRepairGuideRemedies({
      db: t.db,
      remedies: { import_check: true, release_pick: true },
      actorId: null,
    });
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(async () => {
    await t.db.delete(repairRequests);
    await t.db.delete(fixRequests);
    await t.db.delete(watchCarries);
    await t.db.delete(ledgerEvents);
  });
  async function setup(s = stub(), kind: 'fix' | 'release_pick' = 'fix') {
    const mediaItemId = itemIds[s.sid]!;
    let parent: OwnedImportParent;
    if (kind === 'fix') {
      const [p] = await t.db
        .insert(fixRequests)
        .values({
          mediaItemId,
          requesterId: null,
          reason: 'wrong_content',
          targetScope: 'episode',
          targetArrChildId: s.targets[0],
          status: 'search_triggered',
          pathTaken: 'delete_search',
          actionsTaken: [
            { step: 'wrong_content_replace', at: new Date().toISOString() },
            { step: 'release_grab', at: new Date().toISOString(), ok: true, release: s.title },
          ],
        })
        .returning();
      parent = { kind, id: p!.id };
      await t.db.insert(watchCarries).values({
        kind: 'wrong_content',
        mediaItemId,
        seriesId: s.sid,
        status: 'verified',
        takenAt: new Date(),
        detail: {
          fixRequestId: parent.id,
          releases: [s.title],
          wrongContentDeletion: {
            version: 1,
            grabStarted: true,
            files: [{ episodeIds: s.targets }],
          },
        },
      });
    } else {
      const [p] = await t.db
        .insert(repairRequests)
        .values({
          mediaItemId,
          requesterId: userId,
          kind: 'release_pick',
          scope: 'episode',
          seasonNumber: 3,
          targetChildIds: s.targets,
          status: 'actioned',
          preview: { title: s.title },
          actionsTaken: [{ step: 'grab', at: new Date().toISOString(), ok: true, title: s.title }],
        })
        .returning();
      parent = { kind, id: p!.id };
    }
    return {
      ...s,
      input: {
        db: t.db,
        arr: s.arr,
        parent,
        downloadId: s.downloadId,
        actor: kind === 'fix' ? actor : { kind: 'user' as const, userId, isAdmin: false },
      },
    };
  }
  it('imports the owned Pokémon E12-named file only onto intended E1, preserves old E12, audits original Fix and adopts without replay', async () => {
    const s = await setup();
    const plan = await planOwnedSonarrImport(s.input);
    expect(plan).toMatchObject({
      state: 'import',
      targetEpisodeIds: [49199],
      protectedFiles: [{ episodeId: 49210, fileId: 33229 }],
    });
    expect(s.state.writes).toEqual([]);
    const result = await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence });
    expect(result).toMatchObject({ outcome: 'imported', verified: true, protectedUnchanged: true });
    expect(s.state.episodes.find((e) => e.id === 49210)!.episodeFileId).toBe(33229);
    expect(s.state.writes.map((w) => w.path)).toEqual([
      '/api/v3/manualimport',
      '/api/v3/command',
      '/api/v3/queue/1000',
    ]);
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('search_triggered');
    expect(fix!.actionsTaken.map((a) => a.step)).toContain('owned_import_intent');
    expect(await t.db.select().from(repairRequests)).toEqual([]);
    expect(
      (await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).verified,
    ).toBe(true);
    expect(s.state.writes).toHaveLength(3);
    await t.db.update(fixRequests).set({ status: 'completed' });
    expect(
      (await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).verified,
    ).toBe(true);
    expect(s.state.writes).toHaveLength(3);
  });
  it('re-evaluates Mickey against intended E1/E2 through Sonarr, keeps E3/E4 and imports the whole pair', async () => {
    const s = await setup(stub(true));
    const plan = await planOwnedSonarrImport(s.input);
    expect(plan.state).toBe('reevaluate');
    expect(plan.check!.reason).toBe('have_better');
    expect(
      (await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).verified,
    ).toBe(true);
    expect(
      s.state.episodes.filter((e) => [37183, 37184].includes(e.id)).map((e) => e.episodeFileId),
    ).toEqual([24800, 24800]);
    const f = (s.state.writes[1]!.body as { files: Array<{ episodeIds: number[] }> }).files[0]!;
    expect(f.episodeIds).toEqual([37181, 37182]);
  });
  it('continues the same user-owned Release Pick with no Watch Carry and no second Repair Request', async () => {
    const s = await setup(stub(), 'release_pick');
    const discovered = await findOwnedSonarrImport({
      ...s.input,
      mediaItemId: itemIds[549]!,
      targetEpisodeId: 49199,
    });
    expect(discovered).toMatchObject({ parent: s.input.parent });
    const plan = await planOwnedSonarrImport(s.input);
    expect(
      (await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).verified,
    ).toBe(true);
    expect(await t.db.select().from(repairRequests)).toHaveLength(1);
    expect(await t.db.select().from(watchCarries)).toEqual([]);
  });
  it('refuses an unverified carry, failed parent and no-grab parent before remote writes', async () => {
    const s = await setup();
    await t.db.update(watchCarries).set({ status: 'cleared' });
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/verified Watch Carry/);
    await t.db.update(watchCarries).set({ status: 'verified' });
    await t.db.update(fixRequests).set({ status: 'failed' });
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/not open/);
    await t.db.update(fixRequests).set({ status: 'actioned', actionsTaken: [] });
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/successful or reconcilable grab/);
    expect(s.state.writes).toEqual([]);
  });
  it('returns waiting for an exact owned downloading grab even when native numbers differ, with no remote write', async () => {
    const s = await setup(stub(), 'release_pick');
    s.state.queueStatus = 'downloading';
    const plan = await planOwnedSonarrImport(s.input);
    expect(plan).toMatchObject({ state: 'waiting', source: null, targetEpisodeIds: [49199] });
    expect(await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).toMatchObject(
      { waiting: true, verified: false },
    );
    expect(s.state.writes).toEqual([]);
  });
  it('invalidates a confirmed plan when the parent changes without any remote write', async () => {
    const s = await setup();
    const plan = await planOwnedSonarrImport(s.input);
    await t.db.update(fixRequests).set({ status: 'actioned' });
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/changed/);
    expect(s.state.writes).toEqual([]);
  });
  it('claims an uncertain command once and performs no queue forget before verified import', async () => {
    const s = await setup();
    s.state.commandThrows = true;
    const plan = await planOwnedSonarrImport(s.input);
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow();
    expect(await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).toMatchObject(
      { verified: false, queueForgot: false },
    );
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/manualimport', '/api/v3/command']);
  });
  it('never forgets the queue when an unselected physical file changed after import', async () => {
    const s = await setup();
    s.state.changeProtectedAfterImport = true;
    const plan = await planOwnedSonarrImport(s.input);
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/unselected/);
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/manualimport', '/api/v3/command']);
  });
  it.each(['fix', 'release_pick'] as const)(
    'adopts a completed %s with its still-present owned queue once, concurrent observers cannot repeat cleanup or import',
    async (kind) => {
      const s = await setup(stub(), kind);
      s.state.keepForeignQueue = true;
      let started!: () => void;
      let release!: () => void;
      const imported = new Promise<void>((resolve) => {
        started = resolve;
      });
      const continueResponse = new Promise<void>((resolve) => {
        release = resolve;
      });
      s.state.afterImport = async () => {
        if (kind === 'fix') await t.db.update(fixRequests).set({ status: 'completed' });
        else await t.db.update(repairRequests).set({ status: 'completed' });
        started();
        await continueResponse;
      };
      const plan = await planOwnedSonarrImport(s.input);
      const first = runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence });
      await imported;
      const results = await Promise.all([
        runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
        runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
      ]);
      release();
      results.push(await first);
      expect(results.every((r) => r.verified)).toBe(true);
      expect(s.state.writes.filter((w) => w.path === '/api/v3/command')).toHaveLength(1);
      expect(s.state.writes.filter((w) => w.path === '/api/v3/queue/1000')).toHaveLength(1);
      expect(s.state.writes.at(-1)!.body).toEqual({
        removeFromClient: 'false',
        blocklist: 'false',
        skipRedownload: 'true',
      });
      expect((await s.arr.read.sonarr.getQueue(s.sid)).map((q) => q.downloadId)).toEqual([
        'unrelated-download',
      ]);
    },
  );
  it('adopts neutral-delete absence after a 404, without repeating its command', async () => {
    const s = await setup();
    s.state.queueDeleteReturns404AfterRemoval = true;
    const plan = await planOwnedSonarrImport(s.input);
    expect(await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence })).toMatchObject(
      { verified: true, queueForgot: true },
    );
    expect(s.state.writes.filter((w) => w.path === '/api/v3/queue/1000')).toHaveLength(1);
  });
  it('keeps an audited verified neutral forget from failing its Release Pick; real import ledger still completes it', async () => {
    const s = await setup(stub(), 'release_pick');
    const plan = await planOwnedSonarrImport(s.input);
    await runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence });
    // Opening a list first settles history, then refuses because this target now has a file.
    await expect(
      openReleaseList({
        db: t.db,
        arr: s.arr,
        mediaItemId: itemIds[549]!,
        requesterId: userId,
        requesterIsAdmin: true,
        scope: 'episode',
        targetChildId: 49199,
      }),
    ).resolves.toMatchObject({ status: 'has_file' });
    expect((await t.db.select().from(repairRequests))[0]!.status).toBe('actioned');
    await t.db.insert(ledgerEvents).values([
      {
        mediaItemId: itemIds[549]!,
        eventType: 'imported',
        source: 'sonarr',
        occurredAt: new Date(Date.now() + 1000),
        payload: { episodeId: 49199, downloadId: s.downloadId },
      },
      {
        mediaItemId: itemIds[549]!,
        eventType: 'download_failed',
        source: 'sonarr',
        occurredAt: new Date(Date.now() + 1000),
        payload: { episodeId: 49199, downloadId: s.downloadId },
      },
    ]);
    expect((await settleReleasePicks({ db: t.db })).failed).toEqual([]);
    expect((await completeRepairRequests({ db: t.db })).completed).toContain(s.input.parent.id);
  });
  it('an ordinary ignored Release Pick still fails; an imported-looking title alone grants no exemption', async () => {
    const s = await setup(stub(), 'release_pick');
    s.state.queueRemoved = true;
    s.state.history.push({
      ...s.state.history[0]!,
      id: 777,
      eventType: 'downloadIgnored',
      date: new Date(Date.now() + 1500).toISOString(),
    });
    await expect(
      openReleaseList({
        db: t.db,
        arr: s.arr,
        mediaItemId: itemIds[549]!,
        requesterId: userId,
        requesterIsAdmin: true,
        scope: 'episode',
        targetChildId: 49199,
      }),
    ).rejects.toThrow();
    expect((await t.db.select().from(repairRequests))[0]!.status).toBe('failed');
    expect(s.state.writes).toEqual([]);
  });
  it('keeps a multipart WrongContent Fix open through its first import; all intended parts complete it', async () => {
    const s = await setup(stub(true));
    await t.db.update(fixRequests).set({
      actionsTaken: [
        { step: 'wrong_content_replace', at: new Date().toISOString() },
        { step: 'release_grab', ok: true, at: new Date().toISOString(), release: s.title },
      ],
    });
    await t.db.update(watchCarries).set({
      detail: {
        fixRequestId: s.input.parent.id,
        releases: [s.title],
        wrongContentDeletion: {
          version: 1,
          grabStarted: true,
          files: [
            { id: 123, name: 'wrong-shared-file.mkv', size: 1234567, episodeIds: [37181, 37182] },
          ],
        },
      },
    });
    await t.db.insert(ledgerEvents).values({
      mediaItemId: itemIds[439]!,
      eventType: 'imported',
      source: 'sonarr',
      occurredAt: new Date(Date.now() + 1000),
      payload: { episodeId: 37181 },
    });
    expect((await completeFixRequests({ db: t.db })).completed).toEqual([]);
    expect((await t.db.select().from(fixRequests))[0]!.status).toBe('search_triggered');
    await t.db.insert(ledgerEvents).values({
      mediaItemId: itemIds[439]!,
      eventType: 'imported',
      source: 'sonarr',
      occurredAt: new Date(Date.now() + 1000),
      payload: { episodeId: 37182 },
    });
    expect((await completeFixRequests({ db: t.db })).completed.map((c) => c.fixRequestId)).toEqual([
      s.input.parent.id,
    ]);
  });
  it('malformed linked WrongContent slot metadata cannot fall back to first-episode completion', async () => {
    const s = await setup(stub(true));
    await t.db
      .update(fixRequests)
      .set({ actionsTaken: [{ step: 'wrong_content_replace', at: new Date().toISOString() }] });
    await t.db.update(watchCarries).set({
      detail: {
        fixRequestId: s.input.parent.id,
        wrongContentDeletion: {
          version: 1,
          grabStarted: true,
          files: [{ id: 123, name: 'wrong.mkv', size: 123 }],
        },
      },
    });
    await t.db.insert(ledgerEvents).values({
      mediaItemId: itemIds[439]!,
      eventType: 'imported',
      source: 'sonarr',
      occurredAt: new Date(Date.now() + 1000),
      payload: { episodeId: 37181 },
    });
    expect((await completeFixRequests({ db: t.db })).completed).toEqual([]);
    expect((await t.db.select().from(fixRequests))[0]!.status).toBe('search_triggered');
  });
  it('refuses another owner, a forged parent, and a different download with no writes', async () => {
    const s = await setup(stub(), 'release_pick');
    await expect(planOwnedSonarrImport({ ...s.input, actor })).rejects.toThrow(
      /another request owner/,
    );
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        actor,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'staff', downloadId: s.downloadId });
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        actor,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49210,
      }),
    ).toBeNull();
    await expect(
      planOwnedSonarrImport({ ...s.input, parent: { kind: 'fix', id: s.input.parent.id } }),
    ).rejects.toThrow(/not open/);
    await expect(planOwnedSonarrImport({ ...s.input, downloadId: 'unowned' })).rejects.toThrow(
      /exact grab/,
    );
    expect(s.state.writes).toEqual([]);
  });
  it.each(['wrong_language', 'wrong_content'] as const)(
    'ordinary %s Fix discovery reports its downloading status without an import handle',
    async (reason) => {
      const s = await setup();
      await t.db.update(fixRequests).set({
        reason,
        requesterId: userId,
        actionsTaken: [
          { step: 'release_grab', at: new Date().toISOString(), ok: true, release: s.title },
        ],
      });
      s.state.queueStatus = 'downloading';
      const discovered = await findOwnedSonarrImport({
        ...s.input,
        actor: { kind: 'user', userId, isAdmin: false },
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      });
      expect(discovered).toEqual({ state: 'waiting', downloadId: s.downloadId });
      expect(s.state.writes).toEqual([]);
    },
  );
  it('an ordinary import repair remains read-only and cannot fall through to another write', async () => {
    const s = await setup(stub(), 'release_pick');
    await t.db.update(repairRequests).set({ kind: 'import_download' });
    s.state.queueStatus = 'downloading';
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'waiting', downloadId: s.downloadId });
    s.state.queueStatus = 'completed';
    s.state.queueTrackedState = 'importing';
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'waiting', downloadId: s.downloadId });
    s.state.queueRemoved = true;
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'staff', downloadId: null });
    expect(s.state.writes).toEqual([]);
  });
  it('a foreign downloading Release Pick shows queue progress without granting ownership', async () => {
    const s = await setup(stub(), 'release_pick');
    s.state.queueStatus = 'downloading';
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        actor,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'waiting', downloadId: s.downloadId });
    await expect(planOwnedSonarrImport({ ...s.input, actor })).rejects.toThrow(
      /another request owner/,
    );
    expect(s.state.writes).toEqual([]);
  });
  it('missing exact grab history reports waiting or staff, never a continuation or absent request', async () => {
    const s = await setup(stub(), 'release_pick');
    s.state.history = [];
    s.state.queueStatus = 'downloading';
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'waiting', downloadId: s.downloadId });
    s.state.queueRemoved = true;
    expect(
      await findOwnedSonarrImport({
        ...s.input,
        mediaItemId: itemIds[549]!,
        targetEpisodeId: 49199,
      }),
    ).toEqual({ state: 'staff', downloadId: null });
    expect(s.state.writes).toEqual([]);
  });
  it('refuses an extra GRAB episode and a grab predating the parent', async () => {
    const s = await setup();
    s.state.history.push({ ...s.state.history[0]!, id: 2, episodeId: 49210 });
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/exact grab/);
    s.state.history.splice(1);
    s.state.history[0]!.date = '2020-01-01T00:00:00Z';
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/exact grab/);
    expect(s.state.writes).toEqual([]);
  });
  it('refuses a stale physical source or held file identity without starting any remote write', async () => {
    const s = await setup();
    const plan = await planOwnedSonarrImport(s.input);
    s.state.candidate.size += 1;
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/changed/);
    s.state.candidate.size -= 1;
    s.state.files[0]!.relativePath = 'changed-held-name.mkv';
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/changed/);
    expect(s.state.writes).toEqual([]);
  });
  it('preserves a genuine re-evaluated quality refusal, and never sends ManualImport or replays it', async () => {
    const s = await setup(stub(true));
    s.state.evaluationRejections = [
      { type: 'permanent', reason: 'Not a Custom Format upgrade for existing episode file(s).' },
    ];
    const plan = await planOwnedSonarrImport(s.input);
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/have_better/);
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/manualimport']);
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/have_better/);
    expect(s.state.writes.map((w) => w.path)).toEqual([
      '/api/v3/manualimport',
      '/api/v3/manualimport',
    ]);
  });
  it('refuses any re-evaluation that adds unselected coverage, without a library command', async () => {
    const s = await setup();
    s.state.evaluationExtraEpisode = true;
    const plan = await planOwnedSonarrImport(s.input);
    await expect(
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ).rejects.toThrow(/coverage/);
    expect(s.state.writes.map((w) => w.path)).toEqual(['/api/v3/manualimport']);
  });
  it('keeps an uncertain ManualImport claimed; simultaneous/next callers cannot replay it', async () => {
    const s = await setup();
    s.state.complete = false;
    const plan = await planOwnedSonarrImport(s.input);
    const results = await Promise.all([
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
      runOwnedSonarrImport({ ...s.input, digest: plan.digest, evidence }),
    ]);
    expect(results.every((r) => r.outcome === 'importing')).toBe(true);
    expect(s.state.writes.filter((w) => w.path === '/api/v3/command')).toHaveLength(1);
  });
  it('keeps other open parents guarded and refuses a target with a new existing file', async () => {
    const s = await setup();
    await t.db.insert(repairRequests).values({
      mediaItemId: itemIds[549]!,
      kind: 'remap',
      requesterId: null,
      scope: 'season',
      seasonNumber: 3,
      targetChildIds: [49199],
      preview: {},
      status: 'pending',
    });
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/Another repair/);
    await t.db.delete(repairRequests);
    s.state.episodes[0]!.episodeFileId = 99;
    await expect(planOwnedSonarrImport(s.input)).rejects.toThrow(/already has a file/);
    expect(s.state.writes).toEqual([]);
  });
});
