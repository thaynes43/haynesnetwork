// ADR-109 / DESIGN-055 D-08, D-09 (PLAN-077 P1) — the reads the Repair Guide's Fix guards add, offline against sanitized
// recordings of the 2026-10-12 live reads (Radarr 6.4.4 GoodFellas, movie 2934; Sonarr 4.0.20 Regular Show: The Lost
// Tapes S01, series 1061). Guids and every URL field were replaced before the fixtures were written.
import { describe, expect, it } from 'vitest';
import { RadarrClient, SonarrClient, RELEASE_SEARCH_TIMEOUT_MS } from '../src/read';
import { TautulliClient } from '../src/tautulli';
import { arrReleaseSchema } from '../src/schemas';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

const RADARR = { ...TEST_OPTS, baseUrl: 'http://radarr.test:7878' };
const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };

describe('GET /release — the interactive release list (DESIGN-055 D-09)', () => {
  it('Radarr: one movie, normalized rows in the *arr decision order, no URL carried over', async () => {
    const stub = stubFetch([{ path: '/api/v3/release', body: fixture('radarr.release-goodfellas') }]);
    const releases = await new RadarrClient({ ...RADARR, fetchImpl: stub.fetchImpl }).listMovieReleases(2934);
    expect(stub.calls).toHaveLength(1);
    expect(Object.fromEntries(stub.calls[0]!.url.searchParams)).toEqual({ movieId: '2934' });
    expect(releases.map((r) => r.guid)).toEqual([
      'radarr-goodfellas-0',
      'radarr-goodfellas-1',
      'radarr-goodfellas-2',
      'radarr-goodfellas-3',
      'radarr-goodfellas-17',
      'radarr-goodfellas-32',
      'radarr-goodfellas-74',
      'radarr-goodfellas-415',
    ]);
    expect(releases[0]).toMatchObject({
      title: 'Goodfellas.1990.UHD.BluRay.2160p.DTS-HD.MA.5.1.HDR10.DV.HEVC.HYBRiD.REMUX-FraMeSToR',
      releaseGroup: 'FraMeSToR',
      qualityName: 'Remux-2160p',
      resolution: 2160,
      revision: 1,
      size: 99476445308,
      protocol: 'usenet',
      customFormatScore: 5950,
      approved: false,
      rejections: ['Existing file on disk has a equal or higher Custom Format score: 5950'],
      languages: ['English'],
    });
    // The URL-bearing fields (which can hold indexer keys) never cross the boundary.
    for (const r of releases) {
      expect(Object.keys(r)).not.toContain('downloadUrl');
      expect(Object.keys(r)).not.toContain('infoUrl');
      expect(Object.keys(r)).not.toContain('commentUrl');
    }
    expect(releases[7]!.releaseGroup).toBeNull();
  });

  it('Sonarr: an episode, and a season search with the mapped numbers and the full-season flag', async () => {
    const stub = stubFetch([{ path: '/api/v3/release', body: fixture('sonarr.release-season-lost-tapes') }]);
    const client = new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl });
    await client.listEpisodeReleases(118397);
    const season = await client.listSeasonReleases(1061, 1);
    expect(Object.fromEntries(stub.calls[0]!.url.searchParams)).toEqual({ episodeId: '118397' });
    expect(Object.fromEntries(stub.calls[1]!.url.searchParams)).toEqual({ seriesId: '1061', seasonNumber: '1' });
    expect(season[0]).toMatchObject({ seasonNumber: 1, episodeNumbers: [1], fullSeason: false });
    const pack = season.find((r) => r.fullSeason)!;
    // A season pack is mapped onto every episode of the season (the *arr's own mappedEpisodeNumbers).
    expect(pack).toMatchObject({ seasonNumber: 1, fullSeason: true });
    expect(pack.episodeNumbers).toContain(11);
    expect(pack.rejections[0]).toMatch(/smaller than minimum/);
  });

  it('a release search is never retried and gets the long bound (it searches every indexer)', async () => {
    const stub = stubFetch([{ path: '/api/v3/release', status: 503, body: { message: 'indexers down' } }]);
    await expect(
      new RadarrClient({ ...RADARR, fetchImpl: stub.fetchImpl }).listMovieReleases(2934),
    ).rejects.toThrow();
    expect(stub.calls).toHaveLength(1); // a GET would otherwise retry twice on a 503
    expect(RELEASE_SEARCH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('accepts the older {reason, type} rejection objects and the plain strings alike', () => {
    const row = arrReleaseSchema.parse({
      guid: 'g',
      title: 'X',
      rejections: [{ reason: 'Release is blocklisted', type: 'permanent' }, 'Existing file meets cutoff: WEBDL-1080p'],
      mappedEpisodeNumbers: [11],
      episodeNumbers: [10],
      mappedSeasonNumber: 1,
      seasonNumber: 1,
    });
    expect(row.rejections).toEqual(['Release is blocklisted', 'Existing file meets cutoff: WEBDL-1080p']);
    // The *arr's own mapping wins over the parsed number (a release named E10 the *arr maps to E11).
    expect(row.episodeNumbers).toEqual([11]);
  });
});

describe('file reads carry what the guards need (DESIGN-055 D-08, D-09)', () => {
  it('Radarr movie file: custom-format score, edition, revision and the audio languages', async () => {
    const stub = stubFetch([{ path: '/api/v3/moviefile', body: fixture('radarr.moviefile-goodfellas') }]);
    const [file] = await new RadarrClient({ ...RADARR, fetchImpl: stub.fetchImpl }).listMovieFiles(2934);
    expect(file).toMatchObject({
      id: 1507,
      releaseGroup: 'FRAMESTOR',
      size: 87610002547,
      customFormatScore: 5950,
      edition: '',
      quality: { quality: { name: 'Remux-2160p', resolution: 2160 }, revision: { version: 1 } },
      mediaInfo: { audioLanguages: 'eng/eng/eng' },
    });
  });

  it('Sonarr episode file: the scene name and the audio languages', async () => {
    const stub = stubFetch([{ path: '/api/v3/episodefile', body: fixture('sonarr.episodefile-lost-tapes') }]);
    const files = await new SonarrClient({ ...SONARR, fetchImpl: stub.fetchImpl }).listEpisodeFileReleases(1061);
    expect(files[0]).toMatchObject({
      sceneName: 'Regular.Show.The.Lost.Tapes.S01E06.Boba.or.Bo-Bust.REPACK.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune',
      mediaInfo: { audioLanguages: 'eng' },
      customFormatScore: 1780,
    });
  });
});

describe('TautulliClient.getHistory — one title (Playback Evidence, DESIGN-055 D-09)', () => {
  it('sends rating_key for a movie and grandparent_rating_key for a show', async () => {
    const stub = stubFetch([{ path: '/api/v2', body: fixture('tautulli.history-owner') }]);
    const client = new TautulliClient({
      baseUrl: 'http://tautulli.test:8181',
      apiKey: 'taut-key',
      retryDelayMs: 0,
      fetchImpl: stub.fetchImpl,
    });
    await client.getHistory({ ratingKey: 4242, after: '2026-10-10' });
    await client.getHistory({ grandparentRatingKey: '777' });
    expect(stub.calls[0]!.url.searchParams.get('rating_key')).toBe('4242');
    expect(stub.calls[0]!.url.searchParams.get('grandparent_rating_key')).toBeNull();
    expect(stub.calls[1]!.url.searchParams.get('grandparent_rating_key')).toBe('777');
    expect(stub.calls[1]!.url.searchParams.get('rating_key')).toBeNull();
  });
});
