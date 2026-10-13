// ADR-109 C-05 / DESIGN-055 D-03, D-07 (PLAN-077 P2) — the Import Check's reads and its one write, offline against the
// live reads of 2026-10-12 (Sonarr 4.0.20.3012, Radarr 6.4.4.10685; candidate `series` objects trimmed to id, title
// and year). The ManualImport bodies are pinned to the requests each *arr's own interactive-import UI sends at those
// tags (Sonarr InteractiveImportModalContent.tsx `onImportSelectedPress`; Radarr's twin), D-03's contract rule.
import { describe, expect, it } from 'vitest';
import { RadarrClient, SonarrClient } from '../src/read';
import { RadarrWriteClient, SonarrWriteClient } from '../src/write';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

const RADARR = { ...TEST_OPTS, baseUrl: 'http://radarr.test:7878' };
const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };

describe('GET /manualimport?downloadId= (DESIGN-055 D-07 step 1)', () => {
  it('Sonarr: sends only the download id (a seriesId would list the series folder) and parses the mapping', async () => {
    const stub = stubFetch([
      { path: '/api/v3/manualimport', body: fixture('sonarr.manualimport-rugrats-2021-e07') },
    ]);
    const [candidate] = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).getManualImport(
      '95b73337-326c-4063-a9c3-9273ec5c45e1',
    );
    const url = stub.calls[0]!.url;
    expect([...url.searchParams.keys()].sort()).toEqual(['downloadId', 'filterExistingFiles']);
    expect(url.searchParams.get('downloadId')).toBe('95b73337-326c-4063-a9c3-9273ec5c45e1');
    // A Rugrats (2021) release Sonarr's grab history put on the 1991 series: the mapping looks clean (no rejection).
    expect(candidate).toMatchObject({
      series: { id: 599, title: 'Rugrats', year: 1991 },
      seasonNumber: 1,
      episodes: [{ id: 53626, episodeNumber: 7, title: 'Little Dude', hasFile: true }],
      releaseType: 'singleEpisode',
      rejections: [],
    });
    // quality and languages survive whole: the command echoes them back verbatim.
    expect(candidate!.quality).toMatchObject({ quality: { id: 3, name: 'WEBDL-1080p' }, revision: { version: 1 } });
    expect(candidate!.languages!.length).toBeGreaterThan(0);
  });

  it('Sonarr: a permanent rejection keeps its reason and type', async () => {
    const stub = stubFetch([{ path: '/api/v3/manualimport', body: fixture('sonarr.manualimport-aqua-teen-s05e05') }]);
    const [candidate] = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).getManualImport('dl');
    expect(candidate!.rejections).toEqual([{ reason: 'Unable to determine if file is a sample', type: 'permanent' }]);
  });

  it('Radarr: maps the candidate onto the movie and keeps the not-an-upgrade rejection', async () => {
    const stub = stubFetch([
      { path: '/api/v3/manualimport', body: fixture('radarr.manualimport-spider-man-turkseed') },
    ]);
    const [candidate] = await new RadarrClient({ ...RADARR, fetchImpl: stub.fetchImpl }).getManualImport(
      '59d2ffec-f4ae-4164-a8b4-3b69a95210a8',
    );
    expect([...stub.calls[0]!.url.searchParams.keys()].sort()).toEqual(['downloadId', 'filterExistingFiles']);
    expect(candidate).toMatchObject({ movie: { id: 9428, title: 'Spider-Man: Brand New Day' } });
    expect(candidate!.rejections![0]).toMatchObject({ type: 'permanent' });
    expect(candidate!.rejections![0]!.reason).toMatch(/^Not a Custom Format upgrade/);
  });

  it('Radarr movie: the original title and the alternate titles reach the app', async () => {
    const stub = stubFetch([
      {
        path: '/api/v3/movie/9428',
        body: { ...fixture<Record<string, unknown>>('radarr.movie-byid'), ...fixture<Record<string, unknown>>('radarr.movie-9428') },
      },
    ]);
    const movie = await new RadarrClient({ ...RADARR, fetchImpl: stub.fetchImpl }).getMovieById(9428);
    expect(movie.originalTitle).toBe('Spider-Man: Brand New Day');
    expect(movie.alternateTitles).toEqual(expect.arrayContaining([{ title: 'Spider-Man 4' }]));
  });

  it('GET /command/{id} reads a command back', async () => {
    const stub = stubFetch([
      { path: '/api/v3/command/88', body: { id: 88, name: 'ManualImport', status: 'completed', message: 'Completed' } },
    ]);
    const command = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).getCommand(88);
    expect(command).toMatchObject({ id: 88, name: 'ManualImport', status: 'completed' });
  });
});

describe('POST /command ManualImport (DESIGN-055 D-03 contract rule)', () => {
  it('Sonarr: exactly the UI request {name, files, importMode: auto}, each file the UI fields only', async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/command', body: { id: 501, name: 'ManualImport' } }]);
    const [candidate] = fixture<Array<Record<string, unknown>>>('sonarr.manualimport-woman-of-substance-e03');
    const command = await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl }).manualImport([
      {
        path: candidate!.path as string,
        folderName: candidate!.folderName as string,
        seriesId: 29,
        episodeIds: [1305],
        releaseGroup: 'HD',
        quality: candidate!.quality as never,
        languages: candidate!.languages as never,
        indexerFlags: 0,
        releaseType: 'singleEpisode',
        downloadId: '8a449d45-b4c0-4b0a-80f2-7c28ddb95c5a',
      },
    ]);
    expect(command).toEqual({ id: 501, name: 'ManualImport' });
    const body = stub.calls[0]!.body as { name: string; importMode: string; files: Array<Record<string, unknown>> };
    expect(Object.keys(body).sort()).toEqual(['files', 'importMode', 'name']);
    expect(body).toMatchObject({ name: 'ManualImport', importMode: 'auto' });
    expect(Object.keys(body.files[0]!).sort()).toEqual(
      [
        'downloadId',
        'episodeIds',
        'folderName',
        'indexerFlags',
        'languages',
        'path',
        'quality',
        'releaseGroup',
        'releaseType',
        'seriesId',
      ].sort(),
    );
    expect(body.files[0]!.quality).toEqual(candidate!.quality);
    expect(body.files[0]!.languages).toEqual(candidate!.languages);
  });

  it('Radarr: {name, files, importMode: auto} with movieId and no Sonarr-only field', async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/command', body: { id: 502, name: 'ManualImport' } }]);
    const [candidate] = fixture<Array<Record<string, unknown>>>('radarr.manualimport-spider-man-turkseed');
    await new RadarrWriteClient({ ...RADARR, fetchImpl: stub.fetchImpl }).manualImport([
      {
        path: candidate!.path as string,
        folderName: candidate!.folderName as string,
        movieId: 9428,
        quality: candidate!.quality as never,
        languages: candidate!.languages as never,
        indexerFlags: 0,
        downloadId: '59d2ffec-f4ae-4164-a8b4-3b69a95210a8',
      },
    ]);
    const body = stub.calls[0]!.body as { files: Array<Record<string, unknown>> };
    expect(Object.keys(body.files[0]!).sort()).toEqual(
      ['downloadId', 'folderName', 'indexerFlags', 'languages', 'movieId', 'path', 'quality'].sort(),
    );
  });
});

// ADR-109 C-02 / DESIGN-055 D-04 rules 7-8 (PLAN-077 P4) — the Episode Re-map's reads and writes, offline against the live
// read of Regular Show: The Lost Tapes S01 (series 1061, Sonarr 4.0.20.3012, 2026-10-12, after the hand fix).
describe('the Episode Re-map surface (DESIGN-055 D-04)', () => {
  it('GET /manualimport?seriesId=&seasonNumber=&filterExistingFiles=false lists the season library files with their ids', async () => {
    const stub = stubFetch([{ path: '/api/v3/manualimport', body: fixture('sonarr.manualimport-season-lost-tapes-s01') }]);
    const candidates = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).listSeasonImportCandidates(1061, 1);
    const url = stub.calls[0]!.url;
    expect(Object.fromEntries(url.searchParams)).toEqual({ seriesId: '1061', seasonNumber: '1', filterExistingFiles: 'false' });
    expect(candidates.map((c) => [c.episodeFileId, c.episodes?.map((e) => e.episodeNumber)])).toEqual([
      [78961, [23]],
      [78962, [19]],
    ]);
    expect(candidates[0]).toMatchObject({ folderName: 'Regular Show - The Lost Tapes', releaseGroup: 'AndreMor', rejections: [] });
    expect(candidates[0]!.path).toMatch(/^\/data\/haynestower\/Media\/TV Shows\/Regular Show - The Lost Tapes\/Season 1\//);
  });

  it('GET /rename?seriesId=&seasonNumber= reads the files whose name is stale', async () => {
    const stub = stubFetch([
      {
        path: '/api/v3/rename',
        body: [{ seriesId: 1061, seasonNumber: 1, episodeNumbers: [23], episodeFileId: 78961, existingPath: 'Season 1/a.mkv', newPath: 'Season 1/b.mkv' }],
      },
    ]);
    const rows = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).listRenamePreview(1061, 1);
    expect(Object.fromEntries(stub.calls[0]!.url.searchParams)).toEqual({ seriesId: '1061', seasonNumber: '1' });
    expect(rows).toEqual([{ seriesId: 1061, seasonNumber: 1, episodeNumbers: [23], episodeFileId: 78961, existingPath: 'Season 1/a.mkv', newPath: 'Season 1/b.mkv' }]);
  });

  it('GET /command lists the running and recent commands', async () => {
    const stub = stubFetch([
      { path: '/api/v3/command', body: [{ id: 398069, name: 'ManualImport', status: 'started', message: '', started: '2026-10-13T01:08:00Z' }] },
    ]);
    const cmds = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).listCommands();
    expect(cmds).toMatchObject([{ id: 398069, name: 'ManualImport', status: 'started' }]);
  });

  it('RenameFiles sends exactly Organize\'s body {name, seriesId, files}', async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/command', status: 201, body: { id: 9, name: 'RenameFiles' } }]);
    await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl }).renameFiles(1061, [78968, 78962]);
    expect(stub.calls[0]!.body).toEqual({ name: 'RenameFiles', seriesId: 1061, files: [78968, 78962] });
  });

  it('a library-file ManualImport carries its episodeFileId and no download id, importMode move', async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/command', status: 201, body: { id: 10, name: 'ManualImport' } }]);
    const [c] = fixture('sonarr.manualimport-season-lost-tapes-s01') as Array<Record<string, unknown>>;
    await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl }).manualImport(
      [
        {
          path: c!.path as string,
          folderName: c!.folderName as string,
          seriesId: 1061,
          episodeIds: [118419],
          releaseGroup: 'AndreMor',
          quality: c!.quality as never,
          languages: c!.languages as never,
          indexerFlags: 0,
          releaseType: 'singleEpisode',
          episodeFileId: 78961,
        },
      ],
      'move',
    );
    const body = stub.calls[0]!.body as { name: string; importMode: string; files: Array<Record<string, unknown>> };
    expect(body.name).toBe('ManualImport');
    expect(body.importMode).toBe('move');
    expect(Object.keys(body.files[0]!).sort()).toEqual(
      ['episodeFileId', 'episodeIds', 'folderName', 'indexerFlags', 'languages', 'path', 'quality', 'releaseGroup', 'releaseType', 'seriesId'].sort(),
    );
  });
});
