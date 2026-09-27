// ADR-093 / DESIGN-052 D-20 / D-25cp (PLAN-072 S2) — the Playwright-free smoke of the `pnpm dev:local` stubs the
// Release Block and the grown safety invariant read, through the REAL clients:
// - stub Radarr serves The Fixture's grab and its import linked by `downloadId` and the import's `data.fileId` (its
//   file 9601), so the dev:local walk records the `arr_grab_history` identity, not only the file's scene name;
// - stub Maintainerr's `GET /collections` carries the flags a rule PUT stored on the pool, so an Arm/Disarm that drops
//   `listExclusions` or `forceSeerr` makes the dev:local safety audit unsafe (the PLAN-072 S2 walk check);
// - D-25da: stub Radarr and stub Sonarr keep one release profile each (told apart by their keys), so the upkeep that
//   checks both *arrs every registry and sweep run keeps a Radarr term and logs no drift (embedded PG16 for the records).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@hnet/db';
import { runMigrations } from '@hnet/db/migrate';
import {
  auditMaintainerr,
  buildMaintainerrClientBundle,
  deriveTerm,
  insertReleaseRecords,
  reconcileReleaseBlock,
  reconcileReleaseBlockIfDue,
  releaseBlockArrClientsFromEnv,
  type DomainLogger,
} from '@hnet/domain';
import { startPostgres, type StartedPostgres } from '@hnet/test-utils/postgres';
import { composeRuntimeEnv } from '../../e2e/support/env';
import {
  STUB_MOVIE_ID,
  STUB_RADARR_API_KEY,
  STUB_SONARR_API_KEY,
  startStubArr,
  type StubArrServer,
} from '../../e2e/support/stub-arr';
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

describe('stub Radarr and Sonarr — one release profile each (D-25da)', () => {
  let pg: StartedPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
    await runMigrations({ databaseUrl: pg.connectionString });
    process.env.DATABASE_URL = pg.connectionString; // the domain's lazy client (db omitted below)
  }, 120_000);
  afterAll(async () => {
    await getPool()
      .end()
      .catch(() => {});
    await pg?.stop();
  });

  it('a Radarr term survives the upkeep, which checks both *arrs and finds no drift on either', async () => {
    // The dev:local / e2e wiring itself: env.ts points both *arrs at this one stub.
    const runtime = composeRuntimeEnv({
      databaseUrl: pg.connectionString,
      stubOidcBaseUrl: 'http://oidc.invalid',
      stubOidcDiscoveryUrl: 'http://oidc.invalid/.well-known/openid-configuration',
      stubArrBaseUrl: arr.baseUrl,
      stubBazarrBaseUrl: 'http://stub.invalid',
      stubPlexBaseUrl: 'http://stub.invalid',
      stubTautulliBaseUrl: 'http://stub.invalid',
      stubMaintainerrBaseUrl: 'http://stub.invalid',
      stubPrometheusBaseUrl: 'http://stub.invalid',
      stubGatusBaseUrl: 'http://stub.invalid',
      stubOpenWebUiBaseUrl: 'http://stub.invalid',
      stubAuthentikBaseUrl: 'http://stub.invalid',
      stubBooksBaseUrl: 'http://stub.invalid',
      stubGoodreadsBaseUrl: 'http://stub.invalid',
      stubLazyLibrarianBaseUrl: 'http://stub.invalid',
      stubSabnzbdBaseUrl: 'http://stub.invalid',
      stubKapowarrBaseUrl: 'http://stub.invalid',
      stubLibrettoBaseUrl: 'http://stub.invalid',
      stubSmtpPort: 1,
      stubSmtpRecorderUrl: 'http://stub.invalid',
      appUrl: 'http://app.invalid',
    }) as unknown as Record<string, string>;
    expect([runtime.RADARR_API_KEY, runtime.SONARR_API_KEY]).toEqual([STUB_RADARR_API_KEY, STUB_SONARR_API_KEY]);
    const clients = releaseBlockArrClientsFromEnv(runtime);

    const name = 'The.Fixture.2022.1080p.WEB-DL.DDP5.1.H.264-STUB';
    const derived = deriveTerm({
      kind: 'movie',
      arrTitle: 'The Fixture',
      arrYears: [2022],
      releaseNames: [name],
      renamedFileName: null,
      releaseGroup: 'STUB',
      resolution: 1080,
      remux: false,
    })!;
    await insertReleaseRecords({
      state: 'active',
      origin: 'sweep',
      items: [
        {
          key: 'fixture',
          drafts: [
            {
              arrKind: 'radarr',
              arrItemId: STUB_MOVIE_ID,
              mediaItemId: null,
              tmdbId: null,
              tvdbId: null,
              imdbId: null,
              title: 'The Fixture',
              year: 2022,
              season: null,
              identitySource: 'arr_grab_history',
              releaseTitle: name,
              releaseGroup: 'STUB',
              quality: 'WEBDL-1080p',
              resolution: 1080,
              sizeBytes: null,
              fileName: null,
              indexer: null,
              years: derived.years,
              term: derived.term,
              termConfidence: derived.confidence,
              shape: derived.shape,
            },
          ],
        },
      ],
    });
    const warnings: string[] = [];
    const logger: DomainLogger = {
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: (msg) => warnings.push(msg),
    };
    // The delete path's reconcile writes Radarr's profile; then two upkeep runs (the registry job, the sweep job).
    await reconcileReleaseBlock({ arr: clients, arrKind: 'radarr', logger });
    const first = await reconcileReleaseBlockIfDue({ arr: clients, logger });
    const second = await reconcileReleaseBlockIfDue({ arr: clients, logger });
    expect([...first, ...second].map((k) => k.drift)).toEqual([null, null, null, null]);
    expect(warnings).toEqual([]);
    const profiles = (await (await fetch(`${arr.baseUrl}/_stub/release-profiles`)).json()) as {
      radarr: Array<{ ignored: string[] }>;
      sonarr: Array<{ ignored: string[] }>;
    };
    expect(profiles.radarr).toHaveLength(1);
    expect(profiles.radarr[0]!.ignored).toContain(derived.term);
    // Nothing is live for Sonarr: its own profile was never created, and Radarr's term never reached it.
    expect(profiles.sonarr).toEqual([]);
  });
});
