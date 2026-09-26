// ADR-093 / DESIGN-052 D-20 / D-25cp (PLAN-072 S2) — the Playwright-free smoke of the `pnpm dev:local` stubs the
// Release Block and the grown safety invariant read, through the REAL clients:
// - stub Radarr serves The Fixture's grab and its import linked by `downloadId` and the import's `data.fileId` (its
//   file 9601), so the dev:local walk records the `arr_grab_history` identity, not only the file's scene name;
// - stub Maintainerr's `GET /collections` carries the flags a rule PUT stored on the pool, so an Arm/Disarm that drops
//   `listExclusions` or `forceSeerr` makes the dev:local safety audit unsafe (the PLAN-072 S2 walk check).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditMaintainerr,
  buildMaintainerrClientBundle,
  releaseBlockArrClientsFromEnv,
} from '@hnet/domain';
import { STUB_MOVIE_ID, startStubArr, type StubArrServer } from '../../e2e/support/stub-arr';
import { startStubMaintainerr, type StubMaintainerrServer } from '../../e2e/support/stub-maintainerr';

let arr: StubArrServer;
let maint: StubMaintainerrServer;

beforeAll(async () => {
  arr = await startStubArr();
  maint = await startStubMaintainerr();
});

afterAll(async () => {
  await arr?.stop();
  await maint?.stop();
});

describe('stub Radarr — The Fixture`s grab-to-import history (D-20)', () => {
  it('the import names file 9601 and shares the grab`s downloadId; the grab carries the release name', async () => {
    const clients = releaseBlockArrClientsFromEnv({
      RADARR_URL: arr.baseUrl,
      RADARR_API_KEY: 'stub',
      SONARR_URL: arr.baseUrl,
      SONARR_API_KEY: 'stub',
    });
    const history = await clients.read.radarr.getMovieReleaseHistory(STUB_MOVIE_ID);
    const grab = history.find((h) => h.eventType === 'grabbed');
    const imported = history.find((h) => h.eventType === 'downloadFolderImported');
    expect(imported).toMatchObject({ fileId: 9601, downloadId: grab?.downloadId });
    expect(grab).toMatchObject({
      sourceTitle: 'The.Fixture.2022.1080p.WEB-DL.DDP5.1.H.264-STUB',
      releaseGroup: 'STUB',
      indexer: 'Stub Indexer (Prowlarr)',
    });
    const [file] = await clients.read.radarr.listMovieFiles(STUB_MOVIE_ID);
    expect(file?.id).toBe(imported?.fileId);
    expect(await clients.read.radarr.getMovieReleaseHistory(STUB_MOVIE_ID + 1)).toEqual([]);
  });
});

describe('stub Maintainerr — the pool flags a rule PUT stored (D-16)', () => {
  it('a PUT that drops listExclusions makes the audit unsafe; putting it back makes it safe again', async () => {
    const bundle = buildMaintainerrClientBundle({ baseUrl: maint.baseUrl, apiKey: 'stub' } as never);
    expect((await auditMaintainerr({ maintainerr: bundle })).safe).toBe(true);
    const put = (flags: { listExclusions: boolean; forceSeerr: boolean }) =>
      fetch(`${maint.baseUrl}/api/rules`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 11,
          name: 'Purge stale movies',
          description: 'Unwatched 4K movies older than 90 days',
          isActive: true,
          dataType: 'movie',
          libraryId: '1',
          radarrSettingsId: 3,
          arrAction: 0,
          ...flags,
          rules: [{ operator: null, action: 0, firstVal: [1, 0], lastVal: [0, 4], section: 0 }],
        }),
      });
    expect((await put({ listExclusions: false, forceSeerr: true })).ok).toBe(true);
    const [pool] = (await bundle.read.getCollections()).filter((c) => c.id === 7);
    expect(pool).toMatchObject({ listExclusions: false, forceSeerr: true });
    expect((await auditMaintainerr({ maintainerr: bundle })).safe).toBe(false);
    expect((await put({ listExclusions: true, forceSeerr: true })).ok).toBe(true);
    expect((await auditMaintainerr({ maintainerr: bundle })).safe).toBe(true);
  });
});
