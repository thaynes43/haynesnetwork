// ADR-109 C-02, C-06 / DESIGN-055 D-06 (PLAN-077 P5) — the fix router's Release Pick surface end to end on embedded
// Postgres with a fetch-stubbed Sonarr: the switch, the list (a mutation: one budget unit, guids never on the wire), the
// confirmed override grab with the body Sonarr's UI sends, the grab's live phase, and the refusals as outcomes.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setRepairGuideRemedies, resetReleaseSearchState } from '@hnet/domain';
import { bootMigratedDb, caller, createUser, makeCtx, seedMediaItem, sessionUser, type TestDb } from './helpers';
import { stubArrBundle } from './arr-stubs';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

beforeEach(async () => {
  resetReleaseSearchState();
  await setRepairGuideRemedies({ db: tdb.db, remedies: { release_pick: false }, actorId: null });
});

const QUALITY_720 = { quality: { id: 5, name: 'WEBDL-720p', source: 'web', resolution: 720 }, revision: { version: 1, real: 0, isRepack: false } };
const LANGS = [{ id: 1, name: 'English' }, { id: 3, name: 'Portuguese' }];
const row = (o: Record<string, unknown>) => ({
  indexerId: 3, indexer: 'NZBgeek (Prowlarr)', size: 671_334_000, protocol: 'usenet', approved: false, rejected: true,
  downloadAllowed: true, seasonNumber: 1, mappedSeasonNumber: 1, fullSeason: false, customFormatScore: 75, languages: LANGS, ...o,
});

const seriesFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('../../arr/__fixtures__/sonarr.series-byid.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function lostTapesE13(seriesId: number) {
  let grabbed = false;
  const stub = stubArrBundle([
    {
      path: '/api/v3/episode',
      body: () => [
        { id: 118408, seriesId, seasonNumber: 1, episodeNumber: 12, title: 'Secret Menu Item', hasFile: true, monitored: true, episodeFileId: 1 },
        { id: 118409, seriesId, seasonNumber: 1, episodeNumber: 13, title: 'Regular Show Presents: Terror Tales of the Park VII Halloween Special', hasFile: false, monitored: true },
        { id: 118410, seriesId, seasonNumber: 1, episodeNumber: 14, title: 'Smoke Alarm on the Water', hasFile: true, monitored: true, episodeFileId: 2 },
      ],
    },
    { path: `/api/v3/series/${seriesId}`, body: { ...seriesFixture(), id: seriesId, title: 'Regular Show: The Lost Tapes', year: 2026 } },
    {
      path: '/api/v3/queue',
      body: () => ({
        page: 1, pageSize: 200, totalRecords: grabbed ? 1 : 0,
        records: grabbed
          ? [{ id: 9, seriesId, episodeId: 118409, seasonNumber: 1, downloadId: 'dl-1', title: 'grab', status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', size: 1e9, sizeleft: 2.5e8, added: new Date().toISOString() }]
          : [],
      }),
    },
    {
      path: '/api/v3/release',
      body: [
        row({ guid: 'https://indexer.example/details/andremor', title: 'Regular.Show.The.Lost.Tapes.S01E13.Regular.Show.Presents.Terror.Tales.of.the.Park.VII.Halloween.Special.MULTI.720p.HMAX.WEB-DL.DDP5.1.x264-AndreMor', quality: QUALITY_720, episodeNumbers: [13], mappedEpisodeNumbers: [13], rejections: ['WEBDL-720p is not wanted in profile'], releaseGroup: 'AndreMor' }),
        row({ guid: 'akari', title: 'Regular.Show.The.Lost.Tapes.S01E13.Smoke.Alarm.on.the.Water.1080p.HMAX.WEB-DL.DDP2.0.H.265-AKARi', quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 } }, episodeNumbers: [13], mappedEpisodeNumbers: [13], rejections: ['Custom Formats HMAX, x265 (HD) have score -9925 below Series profile minimum 0'], releaseGroup: 'AKARi' }),
      ],
    },
    { method: 'POST', path: '/api/v3/release', body: () => { grabbed = true; return {}; } },
    { path: /^\/api\/v3\/history\/series$|^\/api\/v3\/history$/, body: { page: 1, pageSize: 50, totalRecords: 0, records: [] } },
  ]);
  return stub;
}

describe('fix router: the Release Pick (DESIGN-055 D-06)', () => {
  it('lists in plain words, grabs the override with Sonarr’s own body, follows it live, and refuses as outcomes', async () => {
    const member = await createUser(tdb.db, { email: 'pick-member@example.com' });
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Regular Show: The Lost Tapes', arrItemId: 1061 });
    const stub = lostTapesE13(1061);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const target = { mediaItemId: item.id, scope: 'episode' as const, targetChildId: 118409 };

    expect((await api.fix.guideConfig()).releasePickOn).toBe(false);
    await expect(api.fix.releaseList(target)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(0);

    await setRepairGuideRemedies({ db: tdb.db, remedies: { release_pick: true }, actorId: null });
    expect((await api.fix.guideConfig()).releasePickOn).toBe(true);
    const list = await api.fix.releaseList(target);
    expect(list).toMatchObject({ status: 'list', canPick: true, budget: { used: 1 } });
    expect(list.rows.map((r) => [r.releaseGroup, r.state])).toEqual([
      ['AndreMor', 'override'],
      ['AKARi', 'not_allowed'],
    ]);
    expect(list.rows[0]!.reasons.map((r) => r.text)).toEqual(['Not a quality the library usually keeps (720p)']);
    expect(list.rows[1]!.reasons[0]!.text).toBe("Its name says it's a different episode (S01E14 · Smoke Alarm on the Water)");
    // The guid (an indexer URL) never reaches the browser.
    expect(JSON.stringify(list)).not.toContain('indexer.example');

    // A key the list does not offer is not grabbed.
    expect((await api.fix.releaseGrab({ listId: list.listId!, key: list.rows[1]!.key })).outcome).toBe('not_allowed');
    const grab = await api.fix.releaseGrab({ listId: list.listId!, key: list.recommendedKey! });
    expect(grab).toMatchObject({ outcome: 'grabbed', override: true, targetLabel: expect.stringContaining('S01E13') });
    const [sent] = stub.callsFor('POST', '/api/v3/release');
    expect(sent!.body).toEqual({
      guid: 'https://indexer.example/details/andremor',
      indexerId: 3,
      seriesId: 1061,
      episodeIds: [118409],
      quality: QUALITY_720,
      languages: LANGS,
      downloadClientId: null,
      shouldOverride: true,
    });
    const live = await api.fix.repairProgress({ repairRequestId: grab.repairRequestId! });
    expect(live).toMatchObject({ phase: 'downloading', progressPct: 75 });

    // Someone else cannot follow another person's pick.
    const other = await createUser(tdb.db, { email: 'pick-other@example.com' });
    const otherApi = caller(makeCtx(tdb.db, sessionUser(other), stub.bundle));
    await expect(otherApi.fix.repairProgress({ repairRequestId: grab.repairRequestId! })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(otherApi.fix.releaseGrab({ listId: list.listId!, key: list.recommendedKey! })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // With the download on its way, a new list costs nothing and shows it.
    const busy = await api.fix.releaseList(target);
    expect(busy).toMatchObject({ status: 'on_its_way', rows: [], budget: { used: 2 } });
  });
});
