// ADR-109 C-02, C-06 / DESIGN-055 D-03, D-06 (PLAN-077 P5) — the Release Pick's grab, `POST /api/v3/release`, against
// fetch stubs only. Each body is pinned to what the running UI sends, read from the source at the running tags:
// - Sonarr v4.0.20.3012 frontend/src/InteractiveSearch/InteractiveSearchRow.tsx `onGrabPress({guid, indexerId})` (a row
//   with downloadAllowed) and OverrideMatch/OverrideMatchModalContent.tsx `grabRelease({guid, indexerId, seriesId,
//   episodeIds, quality, languages, downloadClientId, shouldOverride: true})`;
// - Radarr v6.4.4.10685 the same row grab, and OverrideMatchModalContent.tsx `grabRelease({indexerId, guid, movieId,
//   quality, languages, downloadClientId, shouldOverride: true})`.
// `downloadClientId` is null unless a client is picked in that dialog (the app never picks one). The row's quality and
// languages go back verbatim, so the read keeps them raw (`qualityModel`, `languageModels`).
import { describe, expect, it } from 'vitest';
import { RadarrWriteClient, SonarrWriteClient } from '../src/write';
import { RELEASE_SEARCH_TIMEOUT_MS } from '../src/read';
import { ArrHttpError } from '../src/errors';
import { arrReleaseSchema } from '../src/schemas';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };
const RADARR = { ...TEST_OPTS, baseUrl: 'http://radarr.test:7878' };

describe('the interactive-search release row keeps what a grab echoes (DESIGN-055 D-06)', () => {
  it('keeps the QualityModel and the languages exactly as Sonarr sent them, and the downloadAllowed flag', () => {
    const raw = (fixture('sonarr.release-season-lost-tapes') as Array<Record<string, unknown>>)[0]!;
    const row = arrReleaseSchema.parse(raw);
    expect(row.qualityModel).toEqual(raw.quality);
    expect(row.qualityModel).toEqual({
      quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
      revision: { version: 2, real: 0, isRepack: true },
    });
    expect(row.languageModels).toEqual(raw.languages);
    expect(row.downloadAllowed).toBe(true);
    // The names the guards read are unchanged.
    expect(row).toMatchObject({ qualityName: 'WEBDL-1080p', resolution: 1080, revision: 2, languages: ['English'] });
  });

  it('a row with no quality and no flag reads as unknown quality and not grabbable plainly', () => {
    const row = arrReleaseSchema.parse({ guid: 'g', title: 'X' });
    expect(row).toMatchObject({ qualityModel: null, qualityName: null, languageModels: [], downloadAllowed: false });
  });
});

describe('POST /release (DESIGN-055 D-06)', () => {
  const quality = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0, isRepack: false } };
  const languages = [{ id: 1, name: 'English' }];

  it('Sonarr: the plain grab sends exactly {guid, indexerId}', async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/release', body: { guid: 'g1', indexerId: 3 } }]);
    await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl }).grabRelease({ guid: 'g1', indexerId: 3 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ method: 'POST' });
    expect(stub.calls[0]!.url.pathname).toBe('/api/v3/release');
    expect(stub.calls[0]!.body).toEqual({ guid: 'g1', indexerId: 3 });
  });

  it("Sonarr: the override grab sends exactly OverrideMatchModalContent's body", async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/release', body: {} }]);
    await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl }).grabRelease({
      guid: 'g2',
      indexerId: 3,
      seriesId: 1061,
      episodeIds: [118407],
      quality,
      languages,
      downloadClientId: null,
      shouldOverride: true,
    });
    expect(stub.calls[0]!.body).toEqual({
      guid: 'g2',
      indexerId: 3,
      seriesId: 1061,
      episodeIds: [118407],
      quality,
      languages,
      downloadClientId: null,
      shouldOverride: true,
    });
    expect(Object.keys(stub.calls[0]!.body as object)).toEqual([
      'guid', 'indexerId', 'seriesId', 'episodeIds', 'quality', 'languages', 'downloadClientId', 'shouldOverride',
    ]);
  });

  it("Radarr: the plain grab and the override grab, each exactly as Radarr's UI sends them", async () => {
    const stub = stubFetch([{ method: 'POST', path: '/api/v3/release', body: {} }]);
    const client = new RadarrWriteClient({ ...RADARR, fetchImpl: stub.fetchImpl });
    await client.grabRelease({ guid: 'm1', indexerId: 2 });
    await client.grabRelease({ indexerId: 2, guid: 'm2', movieId: 2934, quality, languages, downloadClientId: null, shouldOverride: true });
    expect(stub.calls[0]!.body).toEqual({ guid: 'm1', indexerId: 2 });
    expect(stub.calls[1]!.body).toEqual({ indexerId: 2, guid: 'm2', movieId: 2934, quality, languages, downloadClientId: null, shouldOverride: true });
    expect(Object.keys(stub.calls[1]!.body as object)).toEqual([
      'indexerId', 'guid', 'movieId', 'quality', 'languages', 'downloadClientId', 'shouldOverride',
    ]);
  });

  it('a refused grab surfaces the *arr status (404 cache expired, 409 the site refused) and is never retried', async () => {
    const stub = stubFetch([
      { method: 'POST', path: '/api/v3/release', status: 409, body: { message: 'Getting release from indexer failed' } },
    ]);
    const err = await new SonarrWriteClient({ ...SONARR, fetchImpl: stub.fetchImpl })
      .grabRelease({ guid: 'g3', indexerId: 3 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArrHttpError);
    expect((err as ArrHttpError).status).toBe(409);
    expect(stub.calls).toHaveLength(1);
    // The grab waits on the indexer and the download client: it gets the release search's long bound.
    expect(RELEASE_SEARCH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
