// ADR-109 C-02 / DESIGN-055 D-04, D-05 (PLAN-077 P4) — the fix router's Episode Re-map surface end to end on embedded
// Postgres with a fetch-stubbed Sonarr: the remedy switch, the read-only plan, the confirmed run (one ManualImport of the
// library file, then RenameFiles), the switch-off refusal, and the Title Check flags read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import { setRepairGuideRemedies } from '@hnet/domain';
import { bootMigratedDb, caller, createUser, makeCtx, seedMediaItem, sessionUser, type TestDb } from './helpers';
import { stubArrBundle, type StubbedArrBundle } from './arr-stubs';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

beforeEach(async () => {
  await setRepairGuideRemedies({ db: tdb.db, remedies: { episode_remap: false }, actorId: null });
});

const SERIES_PATH = '/data/tv/Regular Show - The Lost Tapes';
const FILE_PATH = 'Season 1/Regular Show - The Lost Tapes (2026) - S01E24 - Dons Back [DSNP WEBDL-1080p]-AndreMor.mkv';
const QUALITY = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0 } };

/** Case A's Disney+ file: named for E23 "All You Can Fit", filed on E24 "Don's Back". */
function lostTapesStub(seriesId: number): StubbedArrBundle {
  let stub: StubbedArrBundle | null = null;
  const sent = (name: string) => (stub?.callsFor('POST', '/api/v3/command') ?? []).some((c) => (c.body as { name: string }).name === name);
  // A library-file import re-links the file under a new id; only RenameFiles changes its name on disk.
  const imported = () => sent('ManualImport');
  const renamed = () => sent('RenameFiles');
  const fileId = () => (imported() ? 9100 : 9024);
  const episode = (id: number, n: number, title: string, hasFile: boolean) => ({
    id, seriesId, seasonNumber: 1, episodeNumber: n, title, hasFile, monitored: true, ...(hasFile ? { episodeFileId: fileId() } : {}),
  });
  stub = stubArrBundle([
    {
      path: '/api/v3/episode',
      body: () => [episode(118418, 23, 'All You Can Fit', imported()), episode(118419, 24, "Don's Back", !imported())],
    },
    {
      path: '/api/v3/episodefile',
      body: () => [{
        id: fileId(), seriesId, seasonNumber: 1, size: 378_391_500, releaseGroup: 'AndreMor', quality: QUALITY,
        relativePath: renamed() ? FILE_PATH.replace('S01E24 - Dons Back', 'S01E23 - All You Can Fit') : FILE_PATH,
        sceneName: imported() ? null : 'Regular.Show..The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-AndreMor',
      }],
    },
    { path: '/api/v3/queue', body: { page: 1, pageSize: 200, totalRecords: 0, records: [] } },
    { path: '/api/v3/command', body: [] },
    {
      path: '/api/v3/manualimport',
      body: () => [{
        id: 1, path: `${SERIES_PATH}/${FILE_PATH}`, relativePath: FILE_PATH, folderName: 'Regular Show - The Lost Tapes',
        size: 378_391_500, series: { id: seriesId, title: 'Regular Show: The Lost Tapes', year: 2026 }, seasonNumber: 1,
        episodes: [{ id: 118419, seasonNumber: 1, episodeNumber: 24, title: "Don's Back" }], episodeFileId: 9024,
        releaseGroup: 'AndreMor', quality: QUALITY, languages: [{ id: 1, name: 'English' }], indexerFlags: 0,
        releaseType: 'singleEpisode', rejections: [],
      }],
    },
    { path: '/api/v3/rename', body: [] },
    { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 5001, name: 'ManualImport' } },
    { path: /^\/api\/v3\/command\/\d+$/, body: { id: 5001, name: 'ManualImport', status: 'completed' } },
  ]);
  return stub;
}

describe('fix router: the Episode Re-map (DESIGN-055 D-04)', () => {
  it('plans read-only, refuses while the remedy is off, and moves the file once it is on', async () => {
    const member = await createUser(tdb.db, { email: 'remap-member@example.com' });
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Regular Show: The Lost Tapes', arrItemId: 1061 });
    const stub = lostTapesStub(1061);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const claim = { kind: 'single' as const, fromEpisodeId: 118419, toEpisodeId: 118418 };

    expect((await api.fix.guideConfig()).remapOn).toBe(false);
    const plan = await api.fix.remapPlan({ mediaItemId: item.id, seasonNumber: 1, claim });
    expect(plan.refusal).toBeNull();
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.nameSays).toMatchObject({ verdict: 'agrees' });
    expect(stub.callsFor('POST', '/api/v3/command')).toEqual([]);

    await expect(
      api.fix.remap({ mediaItemId: item.id, seasonNumber: 1, claim, planDigest: plan.digest }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(stub.callsFor('POST', '/api/v3/command')).toEqual([]);

    await setRepairGuideRemedies({ db: tdb.db, remedies: { episode_remap: true }, actorId: null });
    expect((await api.fix.guideConfig()).remapOn).toBe(true);
    const result = await api.fix.remap({ mediaItemId: item.id, seasonNumber: 1, claim, planDigest: plan.digest, reason: 'wrong_content' });
    expect(result).toMatchObject({ outcome: 'moved', moved: 1, planned: 1 });
    const bodies = stub.callsFor('POST', '/api/v3/command').map((c) => c.body as Record<string, unknown>);
    expect(bodies.map((b) => b.name)).toEqual(['ManualImport', 'RenameFiles']);
    expect(bodies[0]).toMatchObject({ importMode: 'move', files: [{ episodeIds: [118418], episodeFileId: 9024, seriesId: 1061 }] });
    expect(bodies[1]).toEqual({ name: 'RenameFiles', seriesId: 1061, files: [9100] });
    const [row] = await tdb.db.select().from(schema.repairRequests).where(eq(schema.repairRequests.mediaItemId, item.id));
    expect(row).toMatchObject({ kind: 'remap', status: 'completed', reason: 'wrong_content', requesterId: member.id });
  });

  it('reads the Title Check flags with the switch', async () => {
    const member = await createUser(tdb.db, { email: 'flags-member@example.com' });
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Flagless Show' });
    const api = caller(makeCtx(tdb.db, sessionUser(member), lostTapesStub(item.arrItemId).bundle));
    expect(await api.fix.titleFlags({ mediaItemId: item.id })).toEqual({ remapOn: false, flags: [] });
  });
});
