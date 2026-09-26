// ADR-093 C-07 / C-09 / C-15 / DESIGN-052 D-11..D-14 / D-23 (PLAN-072 S2 part 2) — the Deleted-Release Record and the
// Release Block, end to end on embedded PG16 with the fetch-stubbed Maintainerr and the in-memory *arr (no live API,
// ADR-010):
// - identity (D-11): the import `data.fileId` → `downloadId` → grab join and its fallbacks, an upgraded file naming the
//   latest import, the renamed-file-only record, a no-file movie, a movie already gone (the ledger), a series per
//   season / group / resolution;
// - the writer (D-13): create, idempotent, a hand edit overwritten, expiry, the 3,000 cap, the stranded in-flight
//   settle, and each refusal (`validate`, `put`, `read_back`, `duplicate_profile`);
// - the sweep (D-14): the order identity GETs → profile write → read-back → claim → handle → *arr GET → active; a failed
//   write or a malformed term pauses cleanly with nothing deleted; a failed handle, an item still present, or a claim
//   lost to a Save abandons the record and the final reconcile removes its term; no term ⇒ kept `release_unrecorded`;
//   three failed identity reads abort before Phase A;
// - Expedite item and all follow the same order and throw instead of pausing;
// - the re-add check and the Watchlists card counts (D-23).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ArrHttpError, ArrTimeoutError } from '@hnet/arr';
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashDeletedReleases,
  trashSweepStatus,
} from '@hnet/db/schema';
import {
  RELEASE_BLOCK_PROFILE_NAME,
  RELEASE_BLOCK_SENTINEL,
  RELEASE_BLOCK_TERM_CAP,
  ReleaseBlockError,
  checkReleaseBlockReadds,
  classifyHandleFailure,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  expediteDeletion,
  getReleaseBlockSummary,
  identifyRelease,
  reconcileReleaseBlock,
  reportPoolReleaseIdentity,
  termMatches,
  setAppSetting,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
  type DomainLogger,
  type StaticArrMovie,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, type MaintState } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const BABYGIRL = 'Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR';

/** A Radarr movie whose file came from a grab (import `fileId` → `downloadId` → grab). */
function grabbedMovie(id: number, over: Partial<StaticArrMovie> = {}): StaticArrMovie {
  return {
    title: 'Babygirl',
    year: 2024,
    tmdbId: 9000 + id,
    file: {
      movieId: id,
      relativePath: 'Babygirl (2024) [Remux-2160p][TrueHD 7.1][DV HDR10][HEVC]-FraMeSToR.mkv',
      sceneName: null,
      originalFilePath: null,
      releaseGroup: 'FraMeSToR',
      quality: {
        quality: {
          id: 31,
          name: 'Remux-2160p',
          resolution: 2160,
          source: 'bluray',
          modifier: 'remux',
        },
      },
      size: 53_310_000_000,
    },
    history: [
      {
        id: 1,
        eventType: 'grabbed',
        date: '2026-01-01T00:00:00Z',
        sourceTitle: BABYGIRL,
        downloadId: 'dl-1',
        episodeId: null,
        qualityName: 'Remux-2160p',
        fileId: null,
        importedPath: null,
        releaseGroup: 'FraMeSToR',
        indexer: 'NZBgeek (Prowlarr)',
      },
      {
        id: 2,
        eventType: 'downloadFolderImported',
        date: '2026-01-01T01:00:00Z',
        sourceTitle: BABYGIRL,
        downloadId: 'dl-1',
        episodeId: null,
        qualityName: 'Remux-2160p',
        fileId: id * 10,
        importedPath: '/movies/Babygirl (2024)/Babygirl (2024) [Remux-2160p].mkv',
        releaseGroup: 'FraMeSToR',
        indexer: null,
      },
    ],
    ...over,
  };
}

describe('the Release Block (ADR-093 / DESIGN-052 D-11..D-14, D-23)', () => {
  let t: TestDb;
  let admin: string;
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger: DomainLogger = {
    info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
  };

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'rb@example.com', displayName: 'RB Admin' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [9001, 9002, 9003].map((tmdbId, i) => ({
        arrItemId: i + 1,
        tmdbId,
        title: `Movie ${tmdbId}`,
        sortTitle: `movie ${tmdbId}`,
        year: 2024,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      })),
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 50,
          tvdbId: 8050,
          title: 'The Office (US)',
          sortTitle: 'office us',
          year: 2005,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    logs.length = 0;
    await t.db.delete(trashDeletedReleases);
    await t.db.delete(trashBatches);
    await t.db.delete(trashSweepStatus);
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId: admin });
    await seedVerifiedWatchlistRegistry(t.db);
  });

  const mediaItemId = async (arrKind: 'radarr' | 'sonarr', arrItemId: number) => {
    const [row] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, arrKind), eq(mediaItems.arrItemId, arrItemId)));
    return row!.id;
  };
  const records = () => t.db.select().from(trashDeletedReleases);

  // -------------------------------------------------------------------------------------------------------------
  describe('identity (D-11)', () => {
    it('joins the file to its grab through the import (fileId → downloadId) and names the grabbed release', async () => {
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, grabbedMovie(1)]]) });
      const id = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('radarr', 1),
      });
      expect(id.status).toBe('recordable');
      const [d] = id.status === 'recordable' ? id.drafts : [];
      expect(d).toMatchObject({
        identitySource: 'arr_grab_history',
        releaseTitle: BABYGIRL,
        releaseGroup: 'FraMeSToR',
        quality: 'Remux-2160p',
        resolution: 2160,
        indexer: 'NZBgeek (Prowlarr)',
        termConfidence: 'verified',
        shape: 'group',
      });
      expect(d!.term).toContain('framestor');
    });

    it('falls back to importedPath, then sceneName, and an upgraded file names the LATEST import’s grab', async () => {
      const older = {
        ...grabbedMovie(1).history![0]!,
        id: 10,
        downloadId: 'dl-old',
        sourceTitle: 'Babygirl.2024.1080p.WEB-DL.DDP5.1.H.264-OLDGRP',
        date: '2025-01-01T00:00:00Z',
      };
      const olderImport = {
        ...grabbedMovie(1).history![1]!,
        id: 11,
        downloadId: 'dl-old',
        fileId: 99,
        date: '2025-01-01T01:00:00Z',
        importedPath: '/movies/x/old.mkv',
      };
      const byPath = grabbedMovie(1);
      byPath.history = [
        older,
        olderImport,
        byPath.history![0]!,
        { ...byPath.history![1]!, fileId: null },
      ];
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, byPath]]) });
      byPath.file!.relativePath = 'Babygirl (2024) [Remux-2160p].mkv';
      let id = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('radarr', 1),
      });
      expect(id.status === 'recordable' && id.drafts[0]!.releaseTitle).toBe(BABYGIRL);
      // sceneName fallback: no fileId, no matching path, but the import's sourceTitle is the file's scene name.
      byPath.file!.relativePath = 'renamed.mkv';
      byPath.file!.sceneName = BABYGIRL;
      id = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('radarr', 1),
      });
      expect(id.status === 'recordable' && id.drafts[0]!.identitySource).toBe('arr_grab_history');
      expect(id.status === 'recordable' && id.drafts[0]!.releaseTitle).toBe(BABYGIRL);
    });

    it('a renamed file with a group but no release name is recorded low_confidence (arr_file)', async () => {
      const m = grabbedMovie(1, { history: [] });
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, m]]) });
      const id = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('radarr', 1),
      });
      expect(id.status === 'recordable' && id.drafts[0]).toMatchObject({
        identitySource: 'arr_file',
        termConfidence: 'low_confidence',
        years: [2023, 2024, 2025],
      });
    });

    it('no group and no release name: unrecordable (the item will be kept); no file: a term-less `none` record', async () => {
      const bare = grabbedMovie(1, { history: [] });
      bare.file = { ...bare.file!, releaseGroup: null, relativePath: 'Babygirl (2024).mkv' };
      let { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, bare]]) });
      expect(
        await identifyRelease({
          db: t.db,
          arr: arr.read,
          mediaItemId: await mediaItemId('radarr', 1),
        }),
      ).toEqual({
        status: 'unrecordable',
        reason: 'no_term',
      });
      ({ arr } = createStaticReleaseBlockArr({
        movies: new Map([[1, grabbedMovie(1, { file: null })]]),
      }));
      const none = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('radarr', 1),
      });
      expect(none.status === 'recordable' && none.drafts[0]).toMatchObject({
        identitySource: 'none',
        term: null,
        shape: 'none',
      });
    });

    it('a movie already gone from Radarr is identified from the ledger’s import and its grab, or kept', async () => {
      const mid = await mediaItemId('radarr', 2);
      const { arr, fixture } = createStaticReleaseBlockArr();
      fixture.gone.radarr.add(2);
      expect(await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid })).toEqual({
        status: 'unrecordable',
        reason: 'gone',
      });
      await t.db.insert(ledgerEvents).values([
        {
          mediaItemId: mid,
          eventType: 'grabbed',
          source: 'radarr',
          sourceEventId: 'rb-g1',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          payload: {
            sourceTitle: 'Movie.9002.2024.1080p.BluRay.x264-SPARKS',
            downloadId: 'L1',
            releaseGroup: 'SPARKS',
            quality: 'Bluray-1080p',
            indexer: 'geek',
          },
        },
        {
          mediaItemId: mid,
          eventType: 'imported',
          source: 'radarr',
          sourceEventId: 'rb-i1',
          occurredAt: new Date('2026-01-01T01:00:00Z'),
          payload: {
            sourceTitle: 'Movie.9002.2024.1080p.BluRay.x264-SPARKS',
            downloadId: 'L1',
            quality: 'Bluray-1080p',
          },
        },
      ]);
      const id = await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid });
      expect(id.status === 'recordable' && id.drafts[0]).toMatchObject({
        identitySource: 'ledger_grab',
        releaseGroup: 'SPARKS',
        resolution: 1080,
        indexer: 'geek',
      });
      await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, mid));
    });

    it('a series: one record per season, group and resolution; specials skipped', async () => {
      const { arr } = createStaticReleaseBlockArr({
        series: new Map([
          [
            50,
            {
              title: 'The Office (US)',
              year: 2005,
              tvdbId: 8050,
              files: [
                {
                  seriesId: 50,
                  seasonNumber: 0,
                  relativePath: 'Specials/x.mkv',
                  sceneName: null,
                  originalFilePath: null,
                  releaseGroup: 'X',
                  quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
                  size: 1,
                },
                {
                  seriesId: 50,
                  seasonNumber: 1,
                  relativePath: 's1e1.mkv',
                  sceneName: 'The.Office.US.S01E01.1080p.BluRay.x264-SHORTBREHD',
                  originalFilePath: null,
                  releaseGroup: 'SHORTBREHD',
                  quality: { quality: { name: 'Bluray-1080p', resolution: 1080 } },
                  size: 10,
                },
                {
                  seriesId: 50,
                  seasonNumber: 1,
                  relativePath: 's1e2.mkv',
                  sceneName: 'The.Office.US.S01E02.1080p.BluRay.x264-SHORTBREHD',
                  originalFilePath: null,
                  releaseGroup: 'SHORTBREHD',
                  quality: { quality: { name: 'Bluray-1080p', resolution: 1080 } },
                  size: 10,
                },
                {
                  seriesId: 50,
                  seasonNumber: 2,
                  relativePath: 's2e1.mkv',
                  sceneName: 'The.Office.US.S02E01.720p.WEB-DL.x264-NTb',
                  originalFilePath: null,
                  releaseGroup: 'NTb',
                  quality: { quality: { name: 'WEBDL-720p', resolution: 720 } },
                  size: 5,
                },
              ],
              history: [],
            },
          ],
        ]),
      });
      const id = await identifyRelease({
        db: t.db,
        arr: arr.read,
        mediaItemId: await mediaItemId('sonarr', 50),
      });
      expect(id.status).toBe('recordable');
      const drafts = id.status === 'recordable' ? id.drafts : [];
      expect(drafts.map((d) => [d.season, d.releaseGroup, d.resolution, d.sizeBytes])).toEqual([
        [1, 'SHORTBREHD', 1080, 20],
        [2, 'NTb', 720, 5],
      ]);
      expect(drafts.every((d) => d.termConfidence === 'verified')).toBe(true);
    });
  });

  it('a series group term that fails the self-check yields one exact record per release name (never only the first)', async () => {
    const file = (n: number, sceneName: string | null) => ({
      seriesId: 50,
      seasonNumber: 3,
      relativePath: `Season 03/The Office (US) - S03E0${n} - Title [WEBDL-1080p]-GRP.mkv`,
      sceneName,
      originalFilePath: null,
      releaseGroup: 'GRP',
      quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
      size: 1,
    });
    const { arr } = createStaticReleaseBlockArr({
      series: new Map([
        [
          50,
          {
            title: 'The Office (US)',
            year: 2005,
            tvdbId: 8050,
            files: [
              file(1, 'The.Office.US.S03E01.1080p.WEB-DL.x264-GRP'),
              file(2, 'Office.S03E02.1080p.WEB-DL.x264-GRP'), // another title spelling: the group term cannot match both
            ],
            history: [],
          },
        ],
      ]),
    });
    const id = await identifyRelease({
      db: t.db,
      arr: arr.read,
      mediaItemId: await mediaItemId('sonarr', 50),
    });
    const drafts = id.status === 'recordable' ? id.drafts : [];
    // Each release name gets its own record (its own title spelling: a per-name group term), never only the first.
    expect(drafts.map((d) => [d.season, d.releaseTitle])).toEqual([
      [3, 'The.Office.US.S03E01.1080p.WEB-DL.x264-GRP'],
      [3, 'Office.S03E02.1080p.WEB-DL.x264-GRP'],
    ]);
    expect(termMatches(drafts[0]!.term!, 'The.Office.US.S03E07.1080p.WEB-DL.x264-GRP')).toBe(true);
    expect(termMatches(drafts[1]!.term!, 'Office.S03E09.1080p.WEB-DL.x264-GRP')).toBe(true);
    // Renamed files only (no release name) with a group: one low-confidence group record.
    const { arr: arr2 } = createStaticReleaseBlockArr({
      series: new Map([
        [
          50,
          {
            title: 'The Office (US)',
            year: 2005,
            tvdbId: 8050,
            files: [file(1, null), file(2, null)],
            history: [],
          },
        ],
      ]),
    });
    expect(
      (
        await identifyRelease({
          db: t.db,
          arr: arr2.read,
          mediaItemId: await mediaItemId('sonarr', 50),
        })
      ).status,
    ).toBe('recordable');
  });

  it('D-25bb: an SD series key with one named file and one nameless file keeps the series (the nameless release would go unblocked)', async () => {
    const f = (n: number, sceneName: string | null) => ({
      seriesId: 50,
      seasonNumber: 1,
      relativePath: `Season 01/The Office (US) - S01E0${n} - Ep [SDTV]-LOL.mkv`,
      sceneName,
      originalFilePath: null,
      releaseGroup: 'LOL',
      quality: { quality: { name: 'SDTV', resolution: 480 } },
      size: 1,
    });
    const series = (files: ReturnType<typeof f>[]) =>
      createStaticReleaseBlockArr({
        series: new Map([[50, { title: 'The Office (US)', year: 2005, tvdbId: 8050, files, history: [] }]]),
      }).arr;
    const mid = await mediaItemId('sonarr', 50);
    // One named file + one nameless file of the same (season, group, resolution): the group term needs `480p`, which
    // SD scene names never carry, so it falls back to exact — and the nameless file's release has no name to block.
    expect(
      await identifyRelease({
        db: t.db,
        arr: series([f(1, 'The.Office.US.S01E01.HDTV.x264-LOL'), f(2, null)]).read,
        mediaItemId: mid,
      }),
    ).toEqual({ status: 'unrecordable', reason: 'no_term' });
    // The same shape with every file named: one exact record per name, each blocking its own release.
    const named = await identifyRelease({
      db: t.db,
      arr: series([f(1, 'The.Office.US.S01E01.HDTV.x264-LOL'), f(2, 'The.Office.US.S01E02.HDTV.x264-LOL')]).read,
      mediaItemId: mid,
    });
    const drafts = named.status === 'recordable' ? named.drafts : [];
    expect(drafts.map((d) => d.shape)).toEqual(['exact', 'exact']);
    for (const n of ['The.Office.US.S01E01.HDTV.x264-LOL', 'The.Office.US.S01E02.HDTV.x264-LOL']) {
      expect(drafts.some((d) => termMatches(d.term!, n))).toBe(true);
    }
  });

  it('D-25bc: a series gone from Sonarr records every import of a key whose term fell back to exact (never only the newest)', async () => {
    const mid = await mediaItemId('sonarr', 50);
    const ev = (n: number, h: number, group = 'LOL', quality = 'SDTV') => [
      {
        mediaItemId: mid,
        eventType: 'grabbed' as const,
        source: 'sonarr' as const,
        sourceEventId: `bc-g${n}`,
        occurredAt: new Date(Date.UTC(2025, 0, 1, h)),
        payload: {
          sourceTitle: `The.Office.US.S01E0${n}.HDTV.x264-${group}`,
          downloadId: `BC${n}`,
          releaseGroup: group,
          quality,
        },
      },
      {
        mediaItemId: mid,
        eventType: 'imported' as const,
        source: 'sonarr' as const,
        sourceEventId: `bc-i${n}`,
        occurredAt: new Date(Date.UTC(2025, 0, 1, h, 30)),
        payload: { sourceTitle: `The.Office.US.S01E0${n}.HDTV.x264-${group}`, downloadId: `BC${n}`, quality },
      },
    ];
    await t.db.insert(ledgerEvents).values([...ev(1, 1), ...ev(2, 2)]);
    try {
      const { arr, fixture } = createStaticReleaseBlockArr();
      fixture.gone.sonarr.add(50);
      const id = await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid });
      const drafts = id.status === 'recordable' ? id.drafts : [];
      expect(drafts.map((d) => [d.identitySource, d.shape])).toEqual([
        ['ledger_grab', 'exact'],
        ['ledger_grab', 'exact'],
      ]);
      for (const n of ['The.Office.US.S01E01.HDTV.x264-LOL', 'The.Office.US.S01E02.HDTV.x264-LOL']) {
        expect(drafts.some((d) => termMatches(d.term!, n))).toBe(true);
      }
      // A 1080p key whose group term matches every import stays ONE group record.
      await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, mid));
      const hd = (n: number, h: number) =>
        ev(n, h, 'NTb', 'WEBDL-1080p').map((e) => ({
          ...e,
          sourceEventId: `${e.sourceEventId}-hd`,
          payload: {
            ...e.payload,
            sourceTitle: `The.Office.US.S01E0${n}.1080p.WEB-DL.x264-NTb`,
          },
        }));
      await t.db.insert(ledgerEvents).values([...hd(1, 3), ...hd(2, 4)]);
      const one = await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid });
      expect(one.status === 'recordable' && one.drafts.map((d) => d.shape)).toEqual(['group']);
    } finally {
      await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, mid));
    }
  });

  it('D-25bd: a stale ledger import (another group / resolution) never names a disk-imported file; an agreeing one still does', async () => {
    const mid = await mediaItemId('radarr', 3);
    const ledgerImport = async (name: string, group: string, quality: string) =>
      t.db.insert(ledgerEvents).values([
        {
          mediaItemId: mid,
          eventType: 'grabbed',
          source: 'radarr',
          sourceEventId: `bd-g-${group}`,
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          payload: { sourceTitle: name, downloadId: `BD-${group}`, releaseGroup: group, quality },
        },
        {
          mediaItemId: mid,
          eventType: 'imported',
          source: 'radarr',
          sourceEventId: `bd-i-${group}`,
          occurredAt: new Date('2025-01-01T01:00:00Z'),
          payload: { sourceTitle: name, downloadId: `BD-${group}`, quality },
        },
      ]);
    const diskImported: StaticArrMovie = {
      title: 'Movie 9003',
      year: 2024,
      tmdbId: 9003,
      file: {
        movieId: 3,
        relativePath: 'Movie 9003 (2024) [Bluray-1080p][x264]-NEWGRP.mkv',
        sceneName: null,
        originalFilePath: null,
        releaseGroup: 'NEWGRP',
        quality: {
          quality: { id: 7, name: 'Bluray-1080p', resolution: 1080, source: 'bluray', modifier: 'none' },
        },
        size: 9_000_000_000,
      },
      history: [],
    };
    const { arr } = createStaticReleaseBlockArr({ movies: new Map([[3, diskImported]]) });
    try {
      await ledgerImport('Movie.9003.2024.720p.WEB-DL.DDP5.1.H.264-OLDGRP', 'OLDGRP', 'WEBDL-720p');
      const stale = await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid });
      const d = stale.status === 'recordable' ? stale.drafts[0]! : null;
      expect(d).toMatchObject({ identitySource: 'arr_file', shape: 'group', termConfidence: 'low_confidence' });
      expect(termMatches(d!.term!, 'Movie.9003.2024.1080p.BluRay.x264-NEWGRP')).toBe(true);
      expect(termMatches(d!.term!, 'Movie.9003.2024.720p.WEB-DL.DDP5.1.H.264-OLDGRP')).toBe(false);

      await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, mid));
      await ledgerImport('Movie.9003.2024.1080p.BluRay.x264-NEWGRP', 'NEWGRP', 'Bluray-1080p');
      const agrees = await identifyRelease({ db: t.db, arr: arr.read, mediaItemId: mid });
      expect(agrees.status === 'recordable' && agrees.drafts[0]).toMatchObject({
        identitySource: 'ledger_grab',
        releaseTitle: 'Movie.9003.2024.1080p.BluRay.x264-NEWGRP',
        termConfidence: 'verified',
      });
    } finally {
      await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, mid));
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the writer (D-13)', () => {
    const insertActive = async (
      terms: string[],
      at = new Date(),
      expiresAt = new Date(Date.now() + 86_400_000),
    ) => {
      if (terms.length === 0) return;
      await t.db.insert(trashDeletedReleases).values(
        terms.map((term, i) => ({
          arrKind: 'radarr' as const,
          title: `t${i}`,
          identitySource: 'arr_file' as const,
          term,
          state: 'active' as const,
          origin: 'sweep' as const,
          recordedAt: new Date(at.getTime() + i),
          expiresAt,
        })),
      );
    };
    const exact = (tok: string) => `/^${tok}(?:[^a-z0-9]|$)/i`;

    it('creates the profile with the sentinel and the live terms, is idempotent, and overwrites a hand edit', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      await insertActive([exact('aaa'), exact('bbb')]);
      const first = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(first).toMatchObject({ total: 2, added: 2, wrote: true });
      expect(fixture.profiles.radarr).toHaveLength(1);
      expect(fixture.profiles.radarr[0]).toMatchObject({
        name: RELEASE_BLOCK_PROFILE_NAME,
        enabled: true,
        required: [],
        indexerId: 0,
        tags: [],
      });
      expect(new Set(fixture.profiles.radarr[0]!.ignored)).toEqual(
        new Set([RELEASE_BLOCK_SENTINEL, exact('aaa'), exact('bbb')]),
      );
      const again = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(again.wrote).toBe(false);
      // A hand edit (a disabled profile with a stray term) is overwritten.
      fixture.profiles.radarr[0] = {
        ...fixture.profiles.radarr[0]!,
        enabled: false,
        ignored: [...fixture.profiles.radarr[0]!.ignored, 'stray'],
      };
      const fixed = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(fixed).toMatchObject({ wrote: true, removed: 1 });
      expect(fixture.profiles.radarr[0]!.enabled).toBe(true);
      expect(fixture.profiles.radarr[0]!.ignored).not.toContain('stray');
      expect(logs.some((l) => l.msg === '[release-block] reconciled')).toBe(true);
    });

    it('expires terms past their 365 days, and prunes the oldest active ones beyond the 3,000 cap', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      await insertActive([exact('old')], new Date(Date.now() - 1000), new Date(Date.now() - 1));
      await insertActive(
        Array.from({ length: RELEASE_BLOCK_TERM_CAP + 2 }, (_, i) => exact(`t${i}`)),
        new Date(Date.now() - 10 * 86_400_000),
      );
      const report = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(report).toMatchObject({ expired: 1, pruned: 2, total: RELEASE_BLOCK_TERM_CAP });
      const ignored = fixture.profiles.radarr[0]!.ignored;
      expect(ignored).toHaveLength(RELEASE_BLOCK_TERM_CAP + 1);
      expect(ignored).not.toContain(exact('old'));
      expect(ignored).not.toContain(exact('t0')); // the oldest two were pruned
      expect(ignored).not.toContain(exact('t1'));
      expect(ignored).toContain(exact(`t${RELEASE_BLOCK_TERM_CAP + 1}`));
      const states = (await records()).map((r) => r.state);
      expect(states.filter((s) => s === 'pruned')).toHaveLength(2);
      expect(states.filter((s) => s === 'expired')).toHaveLength(1);
      expect(logs.some((l) => l.msg === '[release-block] pruned' && l.level === 'warn')).toBe(true);
    });

    it('settles a stranded in-flight row: 404 ⇒ active, present ⇒ abandoned, unreachable ⇒ left in place', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      await t.db.insert(trashDeletedReleases).values(
        [1, 2, 3].map((arrItemId) => ({
          arrKind: 'radarr' as const,
          arrItemId,
          title: `m${arrItemId}`,
          identitySource: 'arr_file' as const,
          term: exact(`m${arrItemId}`),
          state: 'in_flight' as const,
          origin: 'sweep' as const,
          recordedAt: twoHoursAgo,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      );
      fixture.gone.radarr.add(1);
      const origFind = arr.read.radarr.findMovie.bind(arr.read.radarr);
      arr.read.radarr.findMovie = async (id: number) => {
        if (id === 3) throw new Error('unreachable');
        return origFind(id);
      };
      const report = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(report.settled).toBe(2);
      const byItem = Object.fromEntries((await records()).map((r) => [r.arrItemId, r.state]));
      expect(byItem).toEqual({ 1: 'active', 2: 'abandoned', 3: 'in_flight' });
      expect(fixture.profiles.radarr[0]!.ignored.sort()).toEqual(
        [RELEASE_BLOCK_SENTINEL, exact('m1'), exact('m3')].sort(),
      );
    });

    it('refuses before any write: a term outside the grammar (validate), a copied profile (duplicate_profile)', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      await insertActive(['/^foo.*/i']);
      const err = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ReleaseBlockError);
      expect((err as ReleaseBlockError).step).toBe('validate');
      expect(
        fixture.calls.filter((c) => c.startsWith('radarr create') || c.startsWith('radarr update')),
      ).toEqual([]);
      await t.db.delete(trashDeletedReleases);
      const dup = {
        id: 1,
        name: RELEASE_BLOCK_PROFILE_NAME,
        enabled: true,
        required: [],
        ignored: ['x'],
        indexerId: 0,
        tags: [],
      };
      fixture.profiles.radarr = [dup, { ...dup, id: 2 }];
      const err2 = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger }).catch(
        (e: unknown) => e,
      );
      expect((err2 as ReleaseBlockError).step).toBe('duplicate_profile');
      expect(
        logs.some(
          (l) => l.msg === '[release-block] failed' && l.fields?.step === 'duplicate_profile',
        ),
      ).toBe(true);
    });

    it('a failed write is `put`; a write that does not stick is `read_back`', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      await insertActive([exact('aaa')]);
      fixture.fail.add('radarr:create');
      expect(
        (
          (await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr' }).catch(
            (e: unknown) => e,
          )) as ReleaseBlockError
        ).step,
      ).toBe('put');
      fixture.fail.clear();
      fixture.dropWrites.add('radarr:create');
      expect(
        (
          (await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr' }).catch(
            (e: unknown) => e,
          )) as ReleaseBlockError
        ).step,
      ).toBe('read_back');
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the sweep (D-14)', () => {
    /** A leaving_soon, expired batch over movieCollection() (ms-9001..9003 ⇄ Radarr 1..3). */
    async function expiredBatch(state: MaintState) {
      const { bundle } = makeMaintainerr(state);
      const created = await createBatchFromPending({
        db: t.db,
        maintainerr: bundle,
        mediaKind: 'movie',
        actorId: admin,
      });
      await t.db
        .update(trashBatches)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(trashBatches.id, created.batchId));
      return created.batchId;
    }
    const radarrIdOf = (ms: string) => Number(ms.slice(-1));
    const itemStates = async (batchId: string) =>
      Object.fromEntries(
        (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map(
          (r) => [r.maintainerrMediaId, { state: r.state, keepReason: r.keepReason }],
        ),
      );
    const linked = (
      state: MaintState,
      fixture: ReturnType<typeof createStaticReleaseBlockArr>['fixture'],
    ) => {
      state.onHandle = (ms) => {
        fixture.calls.push(`maintainerr handle ${ms}`);
        fixture.gone.radarr.add(radarrIdOf(ms));
      };
    };

    it('records and blocks before the handle, in order, and turns the record active after the *arr 404', async () => {
      const state = baseState({
        collections: [movieCollection({ items: movieCollection().items.slice(0, 1) })],
      });
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: new Map([[1, grabbedMovie(1)]]),
      });
      linked(state, fixture);
      // At the moment of the handle: the item is claimed and its record is in flight, tied to it, its term written.
      let atHandle: unknown = null;
      const prev = state.onHandle!;
      state.onHandle = async (ms) => {
        const [rec] = await records();
        const [item] = await t.db
          .select()
          .from(trashBatchItems)
          .where(eq(trashBatchItems.batchId, batchId));
        atHandle = {
          record: rec?.state,
          tied: rec?.batchItemId === item?.id,
          item: item?.state,
          blocked: fixture.profiles.radarr[0]?.ignored.includes(rec!.term!),
        };
        await prev(ms);
      };
      const { bundle } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(report.paused).toBeNull();
      expect(report.batches[0]!.deletedCount).toBe(1);
      expect(atHandle).toEqual({ record: 'in_flight', tied: true, item: 'deleted', blocked: true });
      expect(fixture.calls).toEqual([
        'radarr find 1',
        'radarr files 1',
        'radarr history 1',
        'radarr list', // Phase A: the profile write…
        'radarr create',
        'radarr list', // …and its read-back
        'maintainerr handle ms-9001',
        'radarr find 1', // the settle: 404 ⇒ active
      ]);
      const [rec] = await records();
      expect(rec).toMatchObject({
        state: 'active',
        origin: 'sweep',
        identitySource: 'arr_grab_history',
        releaseTitle: BABYGIRL,
      });
      expect(rec!.activatedAt).not.toBeNull();
      const [event] = await t.db
        .select()
        .from(ledgerEvents)
        .where(eq(ledgerEvents.eventType, 'trash_expedited'));
      expect((event!.payload as { releaseRecordIds: string[] }).releaseRecordIds).toEqual([
        rec!.id,
      ]);
      expect(
        logs.some(
          (l) =>
            l.msg === '[release-block] recorded' && l.fields?.identitySource === 'arr_grab_history',
        ),
      ).toBe(true);
    });

    it('a failed profile write pauses the sweep cleanly: nothing claimed or deleted, the records abandoned', async () => {
      const state = baseState();
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr({ fail: new Set(['radarr:create']) });
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'refresh',
        registrySources: (await import('../src/index')).createStaticWatchlistSources({
          ownerId: '1',
        }).sources,
        logger,
      });
      expect(report).toMatchObject({
        paused: { reason: 'release_block', step: 'put' },
        outcome: 'paused_release_block',
      });
      expect(Object.values(await itemStates(batchId)).every((i) => i.state === 'pending')).toBe(
        true,
      );
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect((await records()).every((r) => r.state === 'abandoned')).toBe(true);
      const [status] = await t.db.select().from(trashSweepStatus);
      expect(status).toMatchObject({ lastOutcome: 'paused_release_block', lastReason: 'put' });
      expect(fixture.calls.filter((c) => c.startsWith('radarr create'))).toHaveLength(1);
    });

    it('a malformed stored term pauses the sweep before any write (validate)', async () => {
      const state = baseState();
      await expiredBatch(state);
      await t.db.insert(trashDeletedReleases).values({
        arrKind: 'radarr',
        title: 'bad',
        identitySource: 'arr_file',
        term: '/^bad(.*/i',
        state: 'active',
        origin: 'sweep',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const { arr, fixture } = createStaticReleaseBlockArr();
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(report.paused).toEqual({ reason: 'release_block', step: 'validate' });
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect(
        fixture.calls.some((c) => c.startsWith('radarr create') || c.startsWith('radarr update')),
      ).toBe(false);
    });

    it('a failed handle, or an item the *arr still has, abandons its record; the final reconcile drops the term', async () => {
      const state = baseState();
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr();
      // ms-9001: Maintainerr answers 409/500 (no delete). ms-9002: the handle "succeeds" but Radarr keeps it.
      // ms-9003: deleted.
      state.onHandle = (ms) => {
        if (ms === 'ms-9003') fixture.gone.radarr.add(3);
      };
      const { bundle } = makeMaintainerr(state);
      const orig = bundle.write.handleCollectionMedia.bind(bundle.write);
      bundle.write.handleCollectionMedia = async (c: number, ms: string) => {
        if (ms === 'ms-9001') {
          // Maintainerr's executor lock: a definitive refusal (it answered, and did not delete).
          throw new ArrHttpError(409, 'POST', 'http://maintainerr/api/collections/media/handle');
        }
        return orig(c, ms);
      };
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(report.batches[0]!.deletedCount).toBe(3); // intent-first: the rows are durably `deleted`
      const byItem = Object.fromEntries((await records()).map((r) => [r.arrItemId, r.state]));
      expect(byItem).toEqual({ 1: 'abandoned', 2: 'abandoned', 3: 'active' });
      const live = (await records()).find((r) => r.arrItemId === 3)!.term!;
      expect(fixture.profiles.radarr[0]!.ignored.sort()).toEqual(
        [RELEASE_BLOCK_SENTINEL, live].sort(),
      );
      expect(logs.filter((l) => l.msg === '[release-block] handle_not_effective')).toHaveLength(2);
      expect((await itemStates(batchId))['ms-9003']!.state).toBe('deleted');
    });

    it('D-25ax: a handle whose answer is lost AFTER Maintainerr deleted the item keeps the block (active, term stays)', async () => {
      const state = baseState({
        collections: [movieCollection({ items: movieCollection().items.slice(0, 2) })],
      });
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr();
      const { bundle } = makeMaintainerr(state);
      bundle.write.handleCollectionMedia = async (_c: number, ms: string) => {
        if (ms === 'ms-9001') {
          fixture.gone.radarr.add(1); // Maintainerr's handleMedia deleted the Radarr movie first…
          throw new ArrTimeoutError('POST', 'http://maintainerr/api/collections/media/handle', 30_000); // …the client gave up
        }
        // ms-9002: the socket drops before anything ran (the item is still there) — a 5xx-like ambiguous failure.
        throw new ArrHttpError(502, 'POST', 'http://maintainerr/api/collections/media/handle');
      };
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(report.batches[0]).toMatchObject({ deletedCount: 2, handleErrors: 2 });
      const byItem = Object.fromEntries((await records()).map((r) => [r.arrItemId, r.state]));
      // 1: the *arr 404s ⇒ active (the delete happened). 2: present after an ambiguous failure ⇒ still in flight.
      expect(byItem).toEqual({ 1: 'active', 2: 'in_flight' });
      const terms = (await records()).map((r) => r.term!);
      expect(fixture.profiles.radarr[0]!.ignored.sort()).toEqual([RELEASE_BLOCK_SENTINEL, ...terms].sort());
      expect(termMatches(terms[0]!, 'Stub.Movie.1.2020.1080p.BluRay.x264-STUB')).toBe(true);
      expect(logs.filter((l) => l.msg === '[release-block] handle_not_effective')).toHaveLength(0);
      // D-21 / D-25az — one `[trash] deleted` line per delete, after its settle.
      expect(
        logs
          .filter((l) => l.msg === '[trash] deleted')
          .map((l) => [l.fields?.maintainerrMediaId, l.fields?.handled, l.fields?.records]),
      ).toEqual([
        ['ms-9001', false, 'active'],
        ['ms-9002', false, 'in_flight'],
      ]);
      expect((await itemStates(batchId))['ms-9001']!.state).toBe('deleted');
      // An hour later the stranded settle decides the ambiguous one by presence: still there ⇒ abandoned, term gone.
      await reconcileReleaseBlock({
        db: t.db,
        arr,
        arrKind: 'radarr',
        logger,
        now: new Date(Date.now() + 2 * 3_600_000),
      });
      const after = Object.fromEntries((await records()).map((r) => [r.arrItemId, r.state]));
      expect(after).toEqual({ 1: 'active', 2: 'abandoned' });
      expect(fixture.profiles.radarr[0]!.ignored).not.toContain(
        (await records()).find((r) => r.arrItemId === 2)!.term,
      );
    });

    it('classifyHandleFailure: a 4xx or a code-0 ReturnStatus is a refusal; a timeout, a 5xx or anything else is ambiguous', () => {
      const url = 'http://maintainerr/api/collections/media/handle';
      const wrap = (cause: unknown) => Object.assign(new Error('maintainerr POST failed'), { cause });
      expect(classifyHandleFailure(wrap(new ArrHttpError(409, 'POST', url)))).toBe('refused');
      expect(classifyHandleFailure(new ArrHttpError(404, 'POST', url))).toBe('refused');
      expect(classifyHandleFailure(wrap(new ArrHttpError(500, 'POST', url)))).toBe('ambiguous');
      expect(classifyHandleFailure(wrap(new ArrTimeoutError('POST', url, 30_000)))).toBe('ambiguous');
      expect(classifyHandleFailure(new TypeError('fetch failed'))).toBe('ambiguous');
      expect(classifyHandleFailure(null)).toBe('ambiguous');
    });

    it('a claim lost to a Save between Phase A and the claim abandons that record', async () => {
      const state = baseState({
        collections: [movieCollection({ items: movieCollection().items.slice(0, 1) })],
      });
      const batchId = await expiredBatch(state);
      const { arr, fixture } = createStaticReleaseBlockArr();
      linked(state, fixture);
      // The read-back is the last step before the claim: a Save lands right then.
      const origList = arr.write.radarr.listReleaseProfiles.bind(arr.write.radarr);
      let lists = 0;
      arr.write.radarr.listReleaseProfiles = async () => {
        lists += 1;
        if (lists === 2)
          await t.db
            .update(trashBatchItems)
            .set({ state: 'saved' })
            .where(eq(trashBatchItems.batchId, batchId));
        return origList();
      };
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(report.batches[0]).toMatchObject({ deletedCount: 0, raceSkipped: 1 });
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect((await records())[0]!.state).toBe('abandoned');
      expect(fixture.profiles.radarr[0]!.ignored).toEqual([RELEASE_BLOCK_SENTINEL]);
    });

    it('an item with no recordable term is kept `release_unrecorded` (no term, no delete)', async () => {
      const state = baseState();
      const batchId = await expiredBatch(state);
      const bare = grabbedMovie(2, { history: [] });
      bare.file = { ...bare.file!, releaseGroup: null, relativePath: 'Movie (2024).mkv' };
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: new Map([[2, bare]]) });
      linked(state, fixture);
      const { bundle, calls } = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(await itemStates(batchId)).toMatchObject({
        'ms-9001': { state: 'deleted' },
        'ms-9002': { state: 'skipped', keepReason: 'release_unrecorded' },
        'ms-9003': { state: 'deleted' },
      });
      expect(report.batches[0]!.keptByReason).toEqual({ release_unrecorded: 1 });
      expect(
        calls
          .filter((c) => c.pathname === '/collections/media/handle')
          .map((c) => (c.body as { mediaId: string }).mediaId),
      ).toEqual(['ms-9001', 'ms-9003']);
    });

    it('three failed identity reads in a row abort before Phase A (aborted_arr); one between successes keeps only that item', async () => {
      let state = baseState();
      let batchId = await expiredBatch(state);
      let { arr } = createStaticReleaseBlockArr({ fail: new Set(['radarr:find']) });
      let maint = makeMaintainerr(state);
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: maint.bundle,
        arr,
        registry: 'refresh',
        registrySources: (await import('../src/index')).createStaticWatchlistSources({
          ownerId: '1',
        }).sources,
        logger,
      });
      expect(report.batches[0]).toMatchObject({
        aborted: true,
        abortReason: 'arr_identity',
        deletedCount: 0,
      });
      expect(report.outcome).toBe('aborted_arr');
      expect(Object.values(await itemStates(batchId)).every((i) => i.state === 'pending')).toBe(
        true,
      );
      expect(await records()).toEqual([]);
      const [status] = await t.db.select().from(trashSweepStatus);
      expect(status).toMatchObject({ lastOutcome: 'aborted_arr', lastReason: 'arr_identity' });

      await t.db.delete(trashBatches);
      state = baseState();
      batchId = await expiredBatch(state);
      ({ arr } = createStaticReleaseBlockArr());
      const origFind = arr.read.radarr.findMovie.bind(arr.read.radarr);
      arr.read.radarr.findMovie = async (id: number) => {
        if (id === 2) throw new Error('503');
        return origFind(id);
      };
      maint = makeMaintainerr(state);
      await sweepExpiredBatches({
        db: t.db,
        maintainerr: maint.bundle,
        arr,
        registry: 'gate-only',
        logger,
      });
      expect(await itemStates(batchId)).toMatchObject({
        'ms-9001': { state: 'deleted' },
        'ms-9002': { state: 'skipped', keepReason: 'release_unrecorded' },
        'ms-9003': { state: 'deleted' },
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('Expedite (D-14)', () => {
    it('item: identity → profile write → read-back → intent → handle → settle; no term ⇒ skipped, never handled', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: new Map([[1, grabbedMovie(1)]]),
      });
      state.onHandle = (ms) => {
        fixture.calls.push(`maintainerr handle ${ms}`);
        fixture.gone.radarr.add(Number(ms.slice(-1)));
      };
      const { bundle } = makeMaintainerr(state);
      const res = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'item',
        media: 'movie',
        actorId: admin,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9001' },
        logger,
      });
      expect(res).toMatchObject({ expeditedCount: 1, unrecordedCount: 0 });
      expect(fixture.calls).toEqual([
        'radarr find 1',
        'radarr files 1',
        'radarr history 1',
        'radarr list',
        'radarr create',
        'radarr list',
        'maintainerr handle ms-9001',
        'radarr find 1',
      ]);
      expect((await records())[0]).toMatchObject({ state: 'active', origin: 'expedite' });

      const bare = grabbedMovie(2, { history: [] });
      bare.file = { ...bare.file!, releaseGroup: null, relativePath: 'Movie (2024).mkv' };
      fixture.movies.set(2, bare);
      const kept = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'item',
        media: 'movie',
        actorId: admin,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9002' },
      });
      expect(kept).toMatchObject({ expeditedCount: 0, skippedCount: 1, unrecordedCount: 1 });
      expect(fixture.calls).not.toContain('maintainerr handle ms-9002');
    });

    it('all: a failed profile write throws ReleaseBlockError and deletes nothing', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const { arr } = createStaticReleaseBlockArr({ fail: new Set(['radarr:create']) });
      const { bundle, calls } = makeMaintainerr(state);
      const intents = async () =>
        (
          await t.db
            .select()
            .from(ledgerEvents)
            .where(eq(ledgerEvents.eventType, 'trash_expedited'))
        ).length;
      const before = await intents();
      const err = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'all',
        media: 'movie',
        actorId: admin,
        snapshotMediaIds: ['ms-9001', 'ms-9002', 'ms-9003'],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseBlockError);
      expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
      expect(await intents()).toBe(before);
      expect((await records()).every((r) => r.state === 'abandoned')).toBe(true);
    });

    it('D-25ax: item — a handle that times out after the delete still leaves the record active and rethrows', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const { arr, fixture } = createStaticReleaseBlockArr();
      const { bundle } = makeMaintainerr(state);
      bundle.write.handleCollectionMedia = async () => {
        fixture.gone.radarr.add(1);
        throw new ArrTimeoutError('POST', 'http://maintainerr/api/collections/media/handle', 30_000);
      };
      const err = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'item',
        media: 'movie',
        actorId: admin,
        item: { collectionId: 7, maintainerrMediaId: 'ms-9001' },
        logger,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const [rec] = await records();
      expect(rec!.state).toBe('active');
      expect(fixture.profiles.radarr[0]!.ignored).toContain(rec!.term);
      expect(
        logs.find((l) => l.msg === '[trash] expedited')?.fields,
      ).toMatchObject({ scope: 'item', maintainerrMediaId: 'ms-9001', handled: false, records: 'active' });
    });

    it('all: records every survivor before the first handle, then settles each', async () => {
      const state = baseState({ collections: [movieCollection()] });
      const { arr, fixture } = createStaticReleaseBlockArr();
      state.onHandle = async (ms) => {
        fixture.calls.push(`maintainerr handle ${ms}`);
        fixture.gone.radarr.add(Number(ms.slice(-1)));
      };
      const { bundle } = makeMaintainerr(state);
      const res = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'all',
        media: 'movie',
        actorId: admin,
        snapshotMediaIds: ['ms-9001', 'ms-9002', 'ms-9003'],
      });
      expect(res.expeditedCount).toBe(3);
      const firstHandle = fixture.calls.findIndex((c) => c.startsWith('maintainerr handle'));
      const write = fixture.calls.findIndex((c) => c === 'radarr create');
      expect(write).toBeGreaterThan(-1);
      expect(write).toBeLessThan(firstHandle);
      expect((await records()).map((r) => r.state)).toEqual(['active', 'active', 'active']);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the read-only pool report (PLAN-072 S6(e))', () => {
    it('counts what the sweep would record for the pending pool, per shape, confidence and reason, and writes nothing', async () => {
      const bare = grabbedMovie(2, { history: [] });
      bare.file = { ...bare.file!, releaseGroup: null, relativePath: 'Movie (2024).mkv' };
      const renamedOnly = grabbedMovie(3, { history: [] });
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: new Map([
          [1, grabbedMovie(1)],
          [2, bare],
          [3, renamedOnly],
        ]),
      });
      const { bundle, calls } = makeMaintainerr(baseState());
      const report = await reportPoolReleaseIdentity({ db: t.db, maintainerr: bundle, arr: arr.read, logger });
      const movies = report.kinds.find((k) => k.media === 'movie')!;
      expect(movies).toMatchObject({
        pool: 3,
        recordable: 2,
        unrecordable: { no_term: 1, gone: 0, no_ledger_item: 0, read_failed: 0 },
        unrecordedShare: 0.333,
        shape: { group: 2, exact: 0, none: 0 },
        confidence: { verified: 1, low_confidence: 1 },
        identitySource: { arr_grab_history: 1, arr_file: 1 },
        nullGroup: 0,
      });
      expect(movies.unrecorded).toEqual([{ title: expect.any(String), reason: 'no_term' }]);
      expect(report.kinds.find((k) => k.media === 'tv')!.pool).toBe(0);
      // Read-only: no record, no profile call, no Maintainerr write.
      expect(await records()).toEqual([]);
      expect(fixture.calls.filter((c) => / (list|create|update)$/.test(c))).toEqual([]);
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('re-adds and the card counts (D-23)', () => {
    it('D-25bh: counts re-added TITLES (a title with two records once) and a no-grab stamp separately', async () => {
      const stamped = (over: Record<string, unknown>) => ({
        arrKind: 'radarr' as const,
        arrItemId: 1,
        title: 't',
        identitySource: 'arr_grab_history' as const,
        term: '/^t[^a-z0-9]*x(?:[^a-z0-9]|$)/i',
        state: 'active' as const,
        origin: 'backfill' as const,
        expiresAt: new Date(Date.now() + 86_400_000),
        readdSeenAt: new Date(),
        ...over,
      });
      await t.db.insert(trashDeletedReleases).values([
        // One title (tmdb 1), two records (the FLUX and Kitsune releases): one matched the grab.
        stamped({ tmdbId: 1, readdSameRelease: true }),
        stamped({ tmdbId: 1, readdSameRelease: false }),
        // tmdb 2: a different release.
        stamped({ tmdbId: 2, arrItemId: 2, readdSameRelease: false }),
        // tmdb 3: no grab within 7 days (seen, no verdict).
        stamped({ tmdbId: 3, arrItemId: 3, readdSameRelease: null }),
        // a series (tvdb 50), two seasons, a different release.
        stamped({ arrKind: 'sonarr', arrItemId: 50, tvdbId: 50, season: 1, readdSameRelease: false }),
        stamped({ arrKind: 'sonarr', arrItemId: 50, tvdbId: 50, season: 2, readdSameRelease: false }),
      ]);
      const { arr } = createStaticReleaseBlockArr();
      expect((await getReleaseBlockSummary({ db: t.db, arr })).readds).toEqual({
        total: 4,
        sameRelease: 1,
        noGrab: 1,
        windowDays: 30,
      });
    });

    it('stamps a re-add: the same release is an error, a different one is not, no grab waits (then 7 days)', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr();
      const term =
        '/^movie[^a-z0-9]+9003[^a-z0-9]+2024[^a-z0-9](?=.*(?<![a-z0-9])1080p(?![a-z0-9])).*[^a-z0-9]sparks(?:[^a-z0-9]|$)/i';
      // The deleted Radarr 3 (tmdb 9003) is live again in the ledger as Radarr 3 → re-added as Radarr 33.
      await t.db
        .update(mediaItems)
        .set({ arrItemId: 33 })
        .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.tmdbId, 9003)));
      const [rec] = await t.db
        .insert(trashDeletedReleases)
        .values({
          arrKind: 'radarr',
          arrItemId: 3,
          tmdbId: 9003,
          title: 'Movie 9003',
          identitySource: 'arr_grab_history',
          term,
          state: 'active',
          origin: 'sweep',
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      fixture.movies.set(33, { ...grabbedMovie(33), history: [] });
      let report = await checkReleaseBlockReadds({ db: t.db, arr: arr.read, logger });
      expect(report).toMatchObject({ checked: 1, stamped: 0 }); // no grab yet: look again next hour
      fixture.movies.get(33)!.history = [
        {
          id: 1,
          eventType: 'grabbed',
          date: null,
          sourceTitle: 'Movie.9003.2024.1080p.BluRay.x264-SPARKS',
          downloadId: 'x',
          episodeId: null,
          qualityName: null,
          fileId: null,
          importedPath: null,
          releaseGroup: null,
          indexer: null,
        },
      ];
      report = await checkReleaseBlockReadds({ db: t.db, arr: arr.read, logger });
      expect(report).toMatchObject({ stamped: 1, sameRelease: 1 });
      const [after] = await t.db
        .select()
        .from(trashDeletedReleases)
        .where(eq(trashDeletedReleases.id, rec!.id));
      expect(after).toMatchObject({ readdSameRelease: true });
      expect(logs.some((l) => l.msg === '[release-block] readd' && l.level === 'error')).toBe(true);
      // Stamped once: not checked again.
      expect((await checkReleaseBlockReadds({ db: t.db, arr: arr.read, logger })).checked).toBe(0);
      await t.db
        .update(mediaItems)
        .set({ arrItemId: 3 })
        .where(and(eq(mediaItems.arrKind, 'radarr'), eq(mediaItems.tmdbId, 9003)));

      const summary = await getReleaseBlockSummary({ db: t.db, arr });
      expect(summary.readds).toEqual({ total: 1, sameRelease: 1, noGrab: 0, windowDays: 30 });
      expect(summary.kinds[0]).toMatchObject({
        arrKind: 'radarr',
        terms: 1,
        cap: RELEASE_BLOCK_TERM_CAP,
        oldestTermDays: 0,
        importListExclusions: 0,
      });
      fixture.exclusions.sonarr = null;
      expect(
        (await getReleaseBlockSummary({ db: t.db, arr })).kinds[1]!.importListExclusions,
      ).toBeNull();
    });
  });
});
