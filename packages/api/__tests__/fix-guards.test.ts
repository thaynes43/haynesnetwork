// ADR-109 C-03 / DESIGN-055 D-08, D-09 (PLAN-077 P1) — the Repair Guide's Fix guards end to end: router → domain → the
// embedded Postgres 16 → fetch-stubbed *arrs (ADR-010, fully offline). Each guard refuses BEFORE the pending row (no Fix
// Request, no budget, no write), and a Fix it allows acts exactly as its plan says.
//   • Case C (AC-42): GoodFellas, no grab history, the only acceptable replacement its own release → refused;
//   • the season guard (AC-40's season half): a pack that also backs an episode marked fine is never marked failed;
//   • an episode Fix in a pack: refused until the person chooses; "replace just this episode" deletes only its file;
//   • Wrong language with the language present → refused; Playback Evidence from the stored Tautulli webhooks and the
//     Tautulli history; the settings (admin-only, audited) and the kill switch (every remedy off ⇒ no plan).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import { SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import {
  RELEASE_SEARCHES_PER_HOUR,
  allRemediesOff,
  closeFixManually,
  createFixRequest,
  planFix,
  recordNotification,
  resetReleaseSearchState,
  setKnownIssueServers,
  setRepairGuideRemedies,
  syncPlexMatches,
  upsertPlexLibraries,
  type PlaybackHistoryReader,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  wireShape,
  type TestDb,
} from './helpers';
import { episodeJson, historyPage, stubArrBundle, type ArrStubRoute } from './arr-stubs';

const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

const ALL_ON = {
  replacement_preview: true,
  season_guard: true,
  language_check: true,
  playback_triage: true,
} as const;

beforeEach(async () => {
  await setRepairGuideRemedies({ db: tdb.db, remedies: ALL_ON, actorId: null });
  resetReleaseSearchState();
});

async function fixRows(mediaItemId: string) {
  return tdb.db.select().from(schema.fixRequests).where(eq(schema.fixRequests.mediaItemId, mediaItemId));
}

/** A Radarr movie file as `GET /moviefile` returns it. */
function movieFile(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    movieId: 1,
    relativePath: 'Movie (2020) [WEBDL-1080p]-GRP.mkv',
    releaseGroup: 'GRP',
    size: 9_500_000_000,
    customFormatScore: 100,
    edition: '',
    quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080, source: 'web' }, revision: { version: 1 } },
    mediaInfo: { audioLanguages: 'eng' },
    ...overrides,
  };
}

/** A release row as `GET /release` returns it. */
function releaseRow(guid: string, overrides: Record<string, unknown> = {}) {
  return {
    guid,
    indexerId: 1,
    indexer: 'Indexer',
    title: 'Movie.2020.1080p.WEB-DL-GRP',
    size: 9_800_000_000,
    quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 }, revision: { version: 1 } },
    releaseGroup: 'GRP',
    approved: false,
    rejections: ['Existing file on disk is of equal or higher preference: WEBDL-1080p v1'],
    customFormatScore: 100,
    protocol: 'usenet',
    downloadUrl: 'https://indexer.invalid/getnzb?apikey=SECRET',
    ...overrides,
  };
}

function radarrRoutes(input: {
  grabs?: unknown[];
  files: unknown[];
  releases: unknown[];
  history?: unknown[];
}): ArrStubRoute[] {
  return [
    {
      path: '/api/v3/history/movie',
      body: (url: URL) => (url.searchParams.get('eventType') === 'grabbed' ? (input.grabs ?? []) : (input.history ?? [])),
    },
    { path: '/api/v3/moviefile', body: input.files },
    { path: '/api/v3/release', body: input.releases },
    { method: 'DELETE', path: /^\/api\/v3\/moviefile\/\d+$/, body: {} },
    { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
    { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 7001, name: 'MoviesSearch' } },
  ];
}

describe('Case C: the Replacement Preview refuses the Same Release (AC-42, DESIGN-055 D-09)', () => {
  it('GoodFellas with no grab history: the preview names its own FraMeSToR remux, and the Fix deletes nothing', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'GoodFellas', arrItemId: 2934 });
    const stub = stubArrBundle(
      radarrRoutes({ files: arrFixture('radarr.moviefile-goodfellas') as unknown[], releases: arrFixture('radarr.release-goodfellas') as unknown[] }),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const { plan } = await api.fix.preview({ mediaItemId: item.id });
    expect(plan).toMatchObject({
      kind: 'delete',
      file: { fileId: 1507, releaseGroup: 'FRAMESTOR', qualityName: 'Remux-2160p' },
      replacement: {
        verdict: 'same_release',
        basis: 'identity',
        candidate: { releaseGroup: 'FraMeSToR', qualityName: 'Remux-2160p', protocol: 'usenet' },
      },
    });
    // The preview carries no indexer URL or guid.
    expect(JSON.stringify(plan)).not.toMatch(/indexer\.invalid|radarr-goodfellas-0/);

    const err = await api.fix
      .create({ mediaItemId: item.id, reason: 'wont_play_corrupt', planDigest: plan!.digest })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data).toMatchObject({ code: 'PRECONDITION_FAILED', appCode: 'FIX_REFUSED' });
    expect(shape.message).toMatch(/same release again/);
    expect(await fixRows(item.id)).toHaveLength(0); // no pending row, no budget used
    expect(stub.callsFor('DELETE', '/api/v3/moviefile')).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
  });

  it('a different release next: deletes the file, searches once, and records the plan it acted on', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Better Out There', arrItemId: 3001 });
    const stub = stubArrBundle(
      radarrRoutes({
        files: [movieFile(31)],
        releases: [
          releaseRow('hard', { rejections: ['Release is blocklisted'] }),
          releaseRow('next', { releaseGroup: 'NEW', title: 'Movie.2020.1080p.WEB-DL-NEW' }),
        ],
      }),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const { plan } = await api.fix.preview({ mediaItemId: item.id });
    expect(plan).toMatchObject({ kind: 'delete', replacement: { verdict: 'ok', candidate: { releaseGroup: 'NEW' } } });

    const result = await api.fix.create({ mediaItemId: item.id, reason: 'wont_play_corrupt', planDigest: plan!.digest });
    expect(result).toMatchObject({ status: 'search_triggered', pathTaken: 'delete_search' });
    expect(stub.callsFor('DELETE', '/api/v3/moviefile').map((c) => c.url.pathname)).toEqual(['/api/v3/moviefile/31']);
    const commands = stub.callsFor('POST', '/api/v3/command');
    expect(commands.map((c) => c.body)).toEqual([{ name: 'MoviesSearch', movieIds: [3001] }]);
    const [row] = await fixRows(item.id);
    expect(row!.actionsTaken.map((a) => a.step)).toEqual(['created', 'guard_plan', 'delete_file', 'trigger_search']);
    expect(row!.actionsTaken[1]).toMatchObject({
      plan: 'delete',
      fileId: 31,
      replacement: { verdict: 'ok', group: 'NEW' },
    });
  });

  it('nothing acceptable to replace it: refused, nothing written', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Nothing Out There', arrItemId: 3002 });
    const stub = stubArrBundle(
      radarrRoutes({ files: [movieFile(32)], releases: [releaseRow('cam', { rejections: ['CAM is not wanted in profile'] })] }),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const err = await api.fix.create({ mediaItemId: item.id, reason: 'wrong_version_quality' }).catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.appCode).toBe('FIX_REFUSED');
    expect(shape.message).toMatch(/nothing to replace it/);
    expect(await fixRows(item.id)).toHaveLength(0);
  });

  it('a plan that changed since the preview is refused, not run (FIX_PLAN_CHANGED)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Moving Target', arrItemId: 3003 });
    const stub = stubArrBundle(
      radarrRoutes({ files: [movieFile(33)], releases: [releaseRow('next', { releaseGroup: 'NEW' })] }),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const err = await api.fix
      .create({ mediaItemId: item.id, reason: 'wont_play_corrupt', planDigest: 'deadbeefdeadbeef' })
      .catch((e: unknown) => e);
    expect(wireShape(err, 'fix.create').data).toMatchObject({ code: 'CONFLICT', appCode: 'FIX_PLAN_CHANGED' });
    expect(await fixRows(item.id)).toHaveLength(0);
    expect(stub.callsFor('DELETE', '/api/v3/moviefile')).toHaveLength(0);
  });

  it('with a grab on record the movie Fix blocklists as before, through the plan', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Grabbed Movie', arrItemId: 3004 });
    const stub = stubArrBundle(
      radarrRoutes({
        grabs: [
          { id: 555, movieId: 3004, eventType: 'grabbed', date: '2026-10-01T00:00:00Z', sourceTitle: 'Movie.2020-GRP', downloadId: 'd1' },
        ],
        files: [movieFile(34)],
        releases: [],
      }),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const result = await api.fix.create({ mediaItemId: item.id, reason: 'wont_play_corrupt' });
    expect(result.pathTaken).toBe('blocklist_search');
    expect(stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname)).toEqual([
      '/api/v3/history/failed/555',
    ]);
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(0); // nothing is deleted, so no release search
  });
});

// ---- Sonarr: a season with a pack (E1+E2, one download), a solo grab (E3), and one with no record (E4) ----
const SERIES = 7100;
const E = (n: number) => 71000 + n;

function seasonEpisodes() {
  return [1, 2, 3, 4].map((n) => episodeJson(E(n), 1, n, { seriesId: SERIES, episodeFileId: 9000 + n }));
}

function seasonHistory() {
  return [
    { id: 801, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', downloadId: 'PACK', episodeId: E(1), sourceTitle: 'Show.S01.1080p.WEB-DL-PK' },
    { id: 802, eventType: 'grabbed', date: '2026-09-01T00:00:00Z', downloadId: 'PACK', episodeId: E(2), sourceTitle: 'Show.S01.1080p.WEB-DL-PK' },
    { id: 803, eventType: 'grabbed', date: '2026-09-02T00:00:00Z', downloadId: 'SOLO3', episodeId: E(3), sourceTitle: 'Show.S01E03.1080p.WEB-DL-AB' },
  ];
}

function episodeFiles() {
  return [1, 2, 3, 4].map((n) => ({
    id: 9000 + n,
    seriesId: SERIES,
    seasonNumber: 1,
    relativePath: `Show - S01E0${n}.mkv`,
    releaseGroup: n <= 2 ? 'PK' : n === 3 ? 'AB' : 'OLD',
    size: 1_000_000_000,
    customFormatScore: 10,
    quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 }, revision: { version: 1 } },
    mediaInfo: { audioLanguages: n === 1 ? 'por/eng' : 'eng' },
  }));
}

function sonarrRoutes(extra: ArrStubRoute[] = []): ArrStubRoute[] {
  return [
    ...extra,
    { path: '/api/v3/episode', body: seasonEpisodes() },
    { path: '/api/v3/history/series', body: seasonHistory() },
    { path: '/api/v3/episodefile', body: episodeFiles() },
    { path: '/api/v3/history', body: historyPage([]) },
    { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
    { method: 'DELETE', path: /^\/api\/v3\/episodefile\/\d+$/, body: {} },
    { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 7002, name: 'EpisodeSearch' } },
  ];
}

describe('the season guard (AC-40 season half, DESIGN-055 D-09)', () => {
  it('lists the on-disk episodes with the download behind each (no release search)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show A', arrItemId: SERIES + 1 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const choices = await api.fix.seasonChoices({ mediaItemId: item.id, seasonNumber: 1 });
    expect(choices.map((c) => [c.label, c.downloadEpisodes, c.releaseName])).toEqual([
      ['S01E01 · Episode 1', 2, 'Show.S01.1080p.WEB-DL-PK'],
      ['S01E02 · Episode 2', 2, 'Show.S01.1080p.WEB-DL-PK'],
      ['S01E03 · Episode 3', 1, 'Show.S01E03.1080p.WEB-DL-AB'],
      ['S01E04 · Episode 4', 0, null],
    ]);
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(0);
  });

  it('chosen E1 and E3: the solo download is marked; the pack (which also holds E2) is left alone', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show B', arrItemId: SERIES + 2 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const input = { mediaItemId: item.id, scope: 'season' as const, seasonNumber: 1, episodeIds: [E(1), E(3)] };
    const { plan } = await api.fix.preview(input);
    expect(plan).toMatchObject({
      kind: 'season',
      mode: 'blocklist',
      marks: [{ grabId: 803, episodes: [{ episodeId: E(3) }] }],
      heldBack: [{ chosen: [{ episodeId: E(1) }], others: [{ episodeId: E(2) }] }],
      noRecord: [],
      actionable: true,
    });
    const result = await api.fix.create({ ...input, reason: 'wrong_content', planDigest: plan!.digest });
    expect(result.pathTaken).toBe('blocklist_search');
    // The pack's records (801, 802) are never marked: marking one would fail the whole download.
    expect(stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname)).toEqual([
      '/api/v3/history/failed/803',
    ]);
    expect(stub.callsFor('POST', '/api/v3/command').map((c) => c.body)).toEqual([
      { name: 'EpisodeSearch', episodeIds: [E(3)] },
    ]);
  });

  it('every episode chosen: the pack and the solo are marked; the one with no record is left for an episode Fix', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show C', arrItemId: SERIES + 3 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const input = { mediaItemId: item.id, scope: 'season' as const, seasonNumber: 1, episodeIds: [E(1), E(2), E(3), E(4)] };
    const { plan } = await api.fix.preview(input);
    expect(plan).toMatchObject({ marks: [{ grabId: 801 }, { grabId: 803 }], noRecord: [{ episodeId: E(4) }] });
    await api.fix.create({ ...input, reason: 'wrong_content', planDigest: plan!.digest });
    expect(stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname)).toEqual([
      '/api/v3/history/failed/801',
      '/api/v3/history/failed/803',
    ]);
  });

  it('only a pack episode chosen: nothing can be fixed safely as a season (refused, nothing written)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show D', arrItemId: SERIES + 4 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const err = await api.fix
      .create({ mediaItemId: item.id, scope: 'season', seasonNumber: 1, episodeIds: [E(1)], reason: 'wrong_content' })
      .catch((e: unknown) => e);
    expect(wireShape(err, 'fix.create').data.appCode).toBe('FIX_REFUSED');
    expect(await fixRows(item.id)).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
  });

  it('with the season guard off, a season Fix marks every backing download as before', async () => {
    await setRepairGuideRemedies({ db: tdb.db, remedies: { season_guard: false }, actorId: null });
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show E', arrItemId: SERIES + 5 });
    const stub = stubArrBundle(sonarrRoutes([{ method: 'POST', path: '/api/v3/command', status: 201, body: { id: 1, name: 'SeasonSearch' } }]));
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    await api.fix.create({ mediaItemId: item.id, scope: 'season', seasonNumber: 1, episodeIds: [E(1)], reason: 'wrong_content' });
    expect(stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname)).toEqual([
      '/api/v3/history/failed/801',
      '/api/v3/history/failed/803',
    ]);
    expect(stub.callsFor('POST', '/api/v3/command')[0]!.body).toEqual({
      name: 'SeasonSearch',
      seriesId: item.arrItemId,
      seasonNumber: 1,
    });
  });
});

describe('an episode Fix in a pack (DESIGN-055 D-09)', () => {
  it('refuses until the person chooses; the preview names what the blocklist would cost', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show F', arrItemId: SERIES + 6 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const { plan } = await api.fix.preview({ mediaItemId: item.id, scope: 'episode', targetChildId: E(1) });
    expect(plan).toMatchObject({ kind: 'blocklist', packCost: [{ episodeId: E(2), label: 'S01E02 · Episode 2' }] });
    const err = await api.fix
      .create({ mediaItemId: item.id, scope: 'episode', targetChildId: E(1), reason: 'wont_play_corrupt' })
      .catch((e: unknown) => e);
    expect(wireShape(err, 'fix.create').data.appCode).toBe('FIX_REFUSED');
    expect(await fixRows(item.id)).toHaveLength(0);

    // Block the whole pack, having seen the cost: the pack is marked.
    await api.fix.create({
      mediaItemId: item.id,
      scope: 'episode',
      targetChildId: E(1),
      reason: 'wont_play_corrupt',
      blockWholePack: true,
      planDigest: plan!.digest,
    });
    expect(stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname)).toEqual([
      '/api/v3/history/failed/801',
    ]);
  });

  it('"Replace just this episode": the guarded delete path, its own file only', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Pack Show G', arrItemId: SERIES + 7 });
    const stub = stubArrBundle(
      sonarrRoutes([
        {
          path: '/api/v3/release',
          body: [
            releaseRow('e2', { episodeNumbers: [2], seasonNumber: 1, releaseGroup: 'NEW' }),
            releaseRow('e1', { episodeNumbers: [1], seasonNumber: 1, releaseGroup: 'NEW', size: 1_050_000_000 }),
          ],
        },
      ]),
    );
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const input = { mediaItemId: item.id, scope: 'episode' as const, targetChildId: E(1), replaceFile: true };
    const { plan } = await api.fix.preview(input);
    expect(plan).toMatchObject({
      kind: 'delete',
      insteadOfPack: true,
      packCost: [{ episodeId: E(2) }],
      file: { fileId: 9001 },
      replacement: { verdict: 'ok', candidate: { releaseGroup: 'NEW' } },
    });
    await api.fix.create({ ...input, reason: 'wont_play_corrupt', planDigest: plan!.digest });
    expect(stub.callsFor('DELETE', '/api/v3/episodefile').map((c) => c.url.pathname)).toEqual(['/api/v3/episodefile/9001']);
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/command').map((c) => c.body)).toEqual([
      { name: 'EpisodeSearch', episodeIds: [E(1)] },
    ]);
  });
});

describe('Wrong language reads the audio first (DESIGN-055 D-08 rules 1-3)', () => {
  it('lists the languages in the file, and refuses a Fix when the wanted one is there', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Dubbed Show', arrItemId: SERIES + 8 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const audio = await api.fix.audioLanguages({ mediaItemId: item.id, scope: 'episode', targetChildId: E(1) });
    expect(audio.languages).toEqual([
      { code: 'por', name: 'Portuguese' },
      { code: 'eng', name: 'English' },
    ]);
    const err = await api.fix
      .create({ mediaItemId: item.id, scope: 'episode', targetChildId: E(1), reason: 'wrong_language', wantedLanguage: 'eng' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.appCode).toBe('FIX_REFUSED');
    expect(shape.message).toMatch(/English audio is already in this file/);
    expect(await fixRows(item.id)).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
  });

  it('a language the file lacks goes on to the guarded Fix', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Dubbed Show 2', arrItemId: SERIES + 9 });
    const stub = stubArrBundle(sonarrRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const result = await api.fix.create({
      mediaItemId: item.id,
      scope: 'episode',
      targetChildId: E(3),
      reason: 'wrong_language',
      wantedLanguage: 'jpn',
    });
    expect(result.pathTaken).toBe('blocklist_search');
    const [row] = await fixRows(item.id);
    expect(row!.actionsTaken[1]).toMatchObject({ step: 'guard_plan', wantedLanguage: 'jpn' });
  });
});

describe('Playback Evidence (T-309, DESIGN-055 D-09)', () => {
  it('no play, a Known-Issue Server, then a play from Tautulli history on a healthy server', async () => {
    const member = await createUser(tdb.db, { email: 'viewer@example.com', plexUsername: 'viewer1' });
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Evidence Movie', arrItemId: 4001, tmdbId: 990001 });
    await upsertPlexLibraries({
      db: tdb.db,
      slug: 'hayneskube',
      libraries: [{ sectionKey: '91', name: 'Kube Movies', mediaType: 'movie' }],
    });
    const [lib] = await tdb.db
      .select({ id: schema.plexLibraries.id })
      .from(schema.plexLibraries)
      .where(and(eq(schema.plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.hayneskube), eq(schema.plexLibraries.sectionKey, '91')));
    await syncPlexMatches({
      db: tdb.db,
      matches: [{ mediaItemId: item.id, plexLibraryId: lib!.id, ratingKey: '4242', matchedVia: 'tmdb' }],
      scopedLibraryIds: [lib!.id],
    });
    let historyRows: Array<Record<string, unknown>> = [];
    const calls: unknown[] = [];
    const reader: PlaybackHistoryReader = {
      slug: 'hayneskube',
      getHistory: async (params) => {
        calls.push(params);
        return historyRows as never;
      },
    };
    const ctx = { ...makeCtx(tdb.db, sessionUser(member)), playbackHistory: [reader] };
    const api = caller(ctx);

    expect(await api.fix.playbackEvidence({ mediaItemId: item.id })).toMatchObject({ verdict: 'no_play', plays: [] });
    expect(calls[0]).toMatchObject({ ratingKey: '4242' });

    // The stored Tautulli webhook: a play by this person (Plex email) that reached HaynesOps.
    await recordNotification({
      db: tdb.db,
      source: 'tautulli',
      type: 'play',
      title: 'Evidence Movie',
      tmdbId: 990001,
      mediaType: 'movie',
      requesterEmail: 'viewer@example.com',
      payload: { event_type: 'play', user: 'viewer1', user_email: 'viewer@example.com', server: 'HaynesOps' },
    });
    // Someone else's play never counts.
    await recordNotification({
      db: tdb.db,
      source: 'tautulli',
      type: 'play',
      title: 'Evidence Movie',
      tmdbId: 990001,
      mediaType: 'movie',
      payload: { event_type: 'play', user: 'someoneelse', user_email: 'else@example.com', server: 'HaynesKube' },
    });
    await setKnownIssueServers({ db: tdb.db, servers: ['haynesops'], actorId: null });
    const known = await api.fix.playbackEvidence({ mediaItemId: item.id });
    expect(known).toMatchObject({ verdict: 'known_issue_server', servers: ['haynesops'], knownIssueServers: ['haynesops'] });
    expect(known.plays).toHaveLength(1);
    expect(known.serverNames.haynesops).toBe('HaynesOps');

    // A play in this person's history on HaynesKube (no known issue): played.
    historyRows = [{ rating_key: 4242, user: 'Viewer1', started: Math.floor(Date.now() / 1000) - 600, date: Math.floor(Date.now() / 1000) - 600 }];
    const played = await api.fix.playbackEvidence({ mediaItemId: item.id });
    expect(played).toMatchObject({ verdict: 'played', servers: ['hayneskube', 'haynesops'] });

    // Most accounts carry their Plex identity only in the sign-in claims (the session), not on the user row: a history
    // row is theirs by plex.tv id even under a display name that differs.
    historyRows = [
      { rating_key: 4242, user: 'Display Name', user_id: 424242, started: Math.floor(Date.now() / 1000) - 300 },
      { rating_key: 9999, user: 'Display Name', user_id: 424242, started: Math.floor(Date.now() / 1000) - 300 },
    ];
    const claimsOnly = await createUser(tdb.db, { email: 'claims@example.com' });
    const claimsApi = caller({
      ...makeCtx(tdb.db, sessionUser(claimsOnly, undefined, undefined, undefined, { userId: '424242', email: null, username: null })),
      playbackHistory: [reader],
    });
    const byId = await claimsApi.fix.playbackEvidence({ mediaItemId: item.id });
    expect(byId).toMatchObject({ verdict: 'played', servers: ['hayneskube'], historyMatched: true });
    expect(byId.plays).toHaveLength(1); // the other rating key is another title
    await setKnownIssueServers({ db: tdb.db, servers: [], actorId: null });
  });
});

describe('the release search is spent sparingly (every indexer, capped API hits)', () => {
  it('a preview and its confirm share one search; a request refused anyway runs none', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'One Search', arrItemId: 6001 });
    const stub = stubArrBundle(radarrRoutes({ files: [movieFile(61)], releases: [releaseRow('next', { releaseGroup: 'NEW' })] }));
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const { plan } = await api.fix.preview({ mediaItemId: item.id });
    await api.fix.preview({ mediaItemId: item.id }); // back and forth in the guide
    await api.fix.create({ mediaItemId: item.id, reason: 'wont_play_corrupt', planDigest: plan!.digest });
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(1);

    // The Fix is now open on this movie: a second preview or create is refused before any search.
    resetReleaseSearchState();
    const previewErr = await api.fix.preview({ mediaItemId: item.id }).catch((e: unknown) => e);
    expect(wireShape(previewErr, 'fix.preview').data.appCode).toBe('FIX_ALREADY_OPEN');
    const createErr = await api.fix.create({ mediaItemId: item.id, reason: 'wont_play_corrupt' }).catch((e: unknown) => e);
    expect(wireShape(createErr, 'fix.create').data.appCode).toBe('FIX_ALREADY_OPEN');
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(1);
  });

  it('a member over the hourly budget gets no preview and no search', async () => {
    const member = await createUser(tdb.db);
    const other = await seedMediaItem(tdb.db, 'radarr', { title: 'Budget Filler', arrItemId: 6002 });
    for (let i = 0; i < 25; i += 1) {
      const { fixRequestId } = await createFixRequest({
        db: tdb.db,
        requesterId: member.id,
        mediaItemId: other.id,
        reason: 'other',
        reasonText: `filler ${i}`,
      });
      // Close each one through its single writer, so the next one is not "already open" (the budget still counts it).
      await closeFixManually({ db: tdb.db, fixRequestId, actorId: member.id });
    }
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Over Budget', arrItemId: 6003 });
    const stub = stubArrBundle(radarrRoutes({ files: [movieFile(63)], releases: [releaseRow('next', { releaseGroup: 'NEW' })] }));
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const err = await api.fix.preview({ mediaItemId: item.id }).catch((e: unknown) => e);
    expect(wireShape(err, 'fix.preview').data).toMatchObject({ code: 'TOO_MANY_REQUESTS', appCode: 'FIX_RATE_LIMIT_EXCEEDED' });
    expect(stub.calls).toHaveLength(0);
  });

  it(`a member's live searches are capped at ${RELEASE_SEARCHES_PER_HOUR} an hour; cached lists and admins are not`, async () => {
    const member = await createUser(tdb.db);
    const items = [];
    for (let i = 0; i <= RELEASE_SEARCHES_PER_HOUR; i += 1) {
      items.push(await seedMediaItem(tdb.db, 'radarr', { title: `Throttle ${i}`, arrItemId: 6100 + i }));
    }
    const stub = stubArrBundle(radarrRoutes({ files: [movieFile(64)], releases: [releaseRow('next', { releaseGroup: 'NEW' })] }));
    let clock = 1_000_000;
    const plan = (mediaItemId: string, requesterIsAdmin = false) =>
      planFix({
        db: tdb.db,
        arr: stub.bundle,
        mediaItemId,
        remedies: { ...allRemediesOff(), replacement_preview: true },
        requesterId: member.id,
        requesterIsAdmin,
        now: () => clock,
      });
    for (const item of items.slice(0, RELEASE_SEARCHES_PER_HOUR)) await plan(item.id);
    await plan(items[0]!.id); // cached: free
    await expect(plan(items[RELEASE_SEARCHES_PER_HOUR]!.id)).rejects.toMatchObject({ code: 'FIX_RATE_LIMIT_EXCEEDED' });
    await plan(items[RELEASE_SEARCHES_PER_HOUR]!.id, true); // an admin is not throttled
    clock += 3_600_001; // an hour later the member may search again (the cached list has expired too)
    const before = stub.callsFor('GET', '/api/v3/release').length;
    await plan(items[RELEASE_SEARCHES_PER_HOUR]!.id);
    expect(stub.callsFor('GET', '/api/v3/release')).toHaveLength(before + 1);
  });
});

describe('the settings and the kill switch (DESIGN-055 D-01)', () => {
  it('admin-only, audited; every remedy off ⇒ no plan and the guide stays closed', async () => {
    const admin = await createUser(tdb.db, { admin: true });
    const member = await createUser(tdb.db);
    const adminApi = caller(makeCtx(tdb.db, sessionUser(admin)));
    const memberApi = caller(makeCtx(tdb.db, sessionUser(member)));

    await expect(memberApi.fix.setGuideSettings({ remedies: { season_guard: false } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const saved = await adminApi.fix.setGuideSettings({
      remedies: { replacement_preview: false, season_guard: false, language_check: false, playback_triage: false },
      knownIssueServers: ['haynesops', 'not-a-server'],
    });
    expect(saved).toEqual({
      remedies: {
        replacement_preview: false,
        season_guard: false,
        language_check: false,
        playback_triage: false,
        // PLAN-077 P2 (DESIGN-055 D-07): Force Search's remedy, untouched by this write, ships off.
        import_check: false,
      },
      knownIssueServers: ['haynesops'],
    });
    const audit = await tdb.db
      .select({ detail: schema.permissionAudit.detail })
      .from(schema.permissionAudit)
      .where(eq(schema.permissionAudit.actorId, admin.id));
    expect(audit.map((a) => (a.detail as { key: string }).key).sort()).toEqual([
      'playback_known_issue_servers',
      'repair_guide_remedies',
    ]);
    expect(await memberApi.fix.guideConfig()).toMatchObject({ guideOn: false, importCheckOn: false });
    // Force Search's remedy alone never opens the Fix guide (DESIGN-055 D-07, PLAN-077 P2).
    await adminApi.fix.setGuideSettings({ remedies: { import_check: true } });
    expect(await memberApi.fix.guideConfig()).toMatchObject({ guideOn: false, importCheckOn: true });
    await adminApi.fix.setGuideSettings({ remedies: { import_check: false } });

    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Switch Off', arrItemId: 5001 });
    const stub = stubArrBundle(radarrRoutes({ files: [movieFile(51)], releases: [] }));
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    expect(await api.fix.preview({ mediaItemId: item.id })).toEqual({ plan: null });
    await setKnownIssueServers({ db: tdb.db, servers: [], actorId: null });
  });
});

describe('queue-aware Force Search through the router (DESIGN-055 D-07, PLAN-077 P2)', () => {
  const MATCHED = 'Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.';
  const turkseed = (arrFixture('radarr.manualimport-spider-man-turkseed') as Array<Record<string, unknown>>)[0]!;

  it('searchPlan shows the import; forceSearch with its digest imports through ManualImport and sends no search', async () => {
    await setRepairGuideRemedies({ db: tdb.db, remedies: { import_check: true }, actorId: null });
    try {
      const member = await createUser(tdb.db);
      const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Spider-Man: Brand New Day', arrItemId: 9428 });
      let imported = false;
      const movie = { ...(arrFixture('radarr.movie-byid') as Record<string, unknown>), ...(arrFixture('radarr.movie-9428') as Record<string, unknown>) };
      const stub = stubArrBundle([
        {
          path: '/api/v3/queue',
          body: () => ({
            page: 1,
            pageSize: 200,
            totalRecords: imported ? 0 : 1,
            records: imported
              ? []
              : [
                  {
                    id: 5501, movieId: 9428, downloadId: '59d2ffec', title: turkseed.folderName, status: 'completed',
                    trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked', size: 1, sizeleft: 0,
                    added: '2026-10-06T00:19:18Z', statusMessages: [{ title: turkseed.folderName, messages: [MATCHED] }],
                  },
                ],
          }),
        },
        { path: '/api/v3/manualimport', body: [{ ...turkseed, rejections: [{ reason: MATCHED, type: 'permanent' }] }] },
        { path: '/api/v3/movie/9428', body: () => ({ ...movie, hasFile: imported }) },
        {
          method: 'POST',
          path: '/api/v3/command',
          body: () => {
            imported = true;
            return { id: 91, name: 'ManualImport' };
          },
        },
        { path: '/api/v3/command/91', body: { id: 91, name: 'ManualImport', status: 'completed' } },
      ]);
      const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
      const plan = await api.fix.searchPlan({ mediaItemId: item.id });
      expect(plan).toMatchObject({ queueAware: true, state: 'import', check: { verdict: 'importable', title: { verdict: 'agrees' } } });
      // Nothing about the plan leaks the command body or the file's full path.
      expect(JSON.stringify(plan)).not.toContain('/data/haynestower');

      const result = await api.fix.forceSearch({ mediaItemId: item.id, planDigest: plan.digest });
      expect(result).toMatchObject({ outcome: 'imported', commandName: 'ManualImport', eventId: null });
      const commands = stub.callsFor('POST', '/api/v3/command').map((c) => (c.body as { name: string }).name);
      expect(commands).toEqual(['ManualImport']);
      const [row] = await tdb.db.select().from(schema.repairRequests).where(eq(schema.repairRequests.mediaItemId, item.id));
      expect(row).toMatchObject({ kind: 'import_download', scope: 'item', status: 'completed', requesterId: member.id });
    } finally {
      await setRepairGuideRemedies({ db: tdb.db, remedies: { import_check: false }, actorId: null });
    }
  });
});
