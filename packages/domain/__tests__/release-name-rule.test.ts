// ADR-117 / DESIGN-052 D-29 (story 838, owner ruling 2026-11-13) — Trash deletes a title only when each file on disk
// has a verified posted release name, and writes a term for every posted name of the title first. On embedded PG16
// with the fetch-stubbed Maintainerr and the in-memory *arr (no live API, ADR-010):
// - what names a file: the *arr's record, the ledger's download import, a legacy file record of the IDENTICAL size;
//   never the renamed file, never a size ratio, never a folder import;
// - every posted name gets a term (the ledger, the legacy tables, a failed grab), a size-matched old job only adds
//   (review F1), an untrimmed name is not verified (F3), a name the grammar cannot write keeps the title (F4), the
//   ledger read pages by keyset and keeps the title past its bound;
// - a title with no verified name is kept on each of the four delete paths (batch build, the sweep, Expedite item
//   and all, Expire now), and counted;
// - the cap keeps a title and never prunes an older term on a delete path (F7);
// - the Release Name Check (the database's view) and the guardian, the wall protection and the Expedite preview.
// Every title, group and release name here is invented.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  ledgerEvents,
  legacyDownloadJobs,
  legacyReleaseNames,
  mediaItems,
  trashBatchItems,
  trashBatches,
  trashCandidates,
  trashDeletedReleases,
  trashSweepStatus,
} from '@hnet/db/schema';
import {
  RELEASE_BLOCK_TERM_CAP,
  ReleaseBlockError,
  classifyForExpedite,
  classifyGuardian,
  createBatchFromPending,
  createStaticReleaseBlockArr,
  deriveTerm,
  draftForVerifiedName,
  expediteDeletion,
  identifyRelease,
  keepReasonForUnrecorded,
  ledgerPostedReleases,
  listTrashPending,
  loadLegacyReleaseNames,
  loadReleaseNameStates,
  matchLegacySab,
  partitionPendingForExpedite,
  postedReleaseName,
  reconcileReleaseBlock,
  reserveTermsUnderCap,
  setAppSetting,
  sweepExpiredBatches,
  termMatchesRaw,
  trashWallProtection,
  upsertMediaItemsBatch,
  type DomainLogger,
  type ReleaseIdentity,
  type StaticArrMovie,
  type StaticArrSeries,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection, type MaintState } from './maintainerr-stub';
import { bootMigratedDb, createUser, seedVerifiedWatchlistRegistry, type TestDb } from './helpers';

const FILE_SIZE = 9_000_000_000;
const POSTED = (tmdb: number) => `Movie.${tmdb}.2024.1080p.BluRay.x264-NEWGRP`;

/** A Radarr movie whose file Radarr only knows by the name it gave it on rename: no grab, no scene name. */
function diskMovie(id: number, over: Partial<StaticArrMovie> = {}): StaticArrMovie {
  const tmdb = 9000 + id;
  return {
    title: `Movie ${tmdb}`,
    year: 2024,
    tmdbId: tmdb,
    file: {
      movieId: id,
      relativePath: `Movie ${tmdb} (2024) [Bluray-1080p][x264]-NEWGRP.mkv`,
      sceneName: null,
      originalFilePath: null,
      releaseGroup: 'NEWGRP',
      quality: { quality: { id: 7, name: 'Bluray-1080p', resolution: 1080, source: 'bluray', modifier: 'none' } },
      size: FILE_SIZE,
    },
    history: [],
    ...over,
  };
}

const tsv = (...fields: Array<string | number>) => fields.join('\t');
const radarrFile = (tmdb: number, name: string, size: number, group = 'NEWGRP') =>
  tsv(tmdb, 2024, name, group, size, 'Bluray-1080p', '2025-02-01 00:00:00', `Movie ${tmdb}`);
const radarrEvent = (tmdb: number, eventType: 1 | 3 | 4, name: string, group = '') =>
  tsv(tmdb, 2024, eventType, '2025-01-15 10:00:00', name, 'dl-legacy', '', group, `Movie ${tmdb}`);

describe('the verified-name rule (ADR-117 / DESIGN-052 D-29)', () => {
  let t: TestDb;
  let admin: string;
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger: DomainLogger = {
    info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
  };

  /** Radarr 1..3 ⇄ tmdb 9001..9003 (the stub collection's ms-9001..9003); `files` is the ledger's on-disk count. */
  const seedMovies = async (files: number) =>
    upsertMediaItemsBatch({
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
        onDiskFileCount: files,
        expectedFileCount: 1,
        sizeOnDisk: files > 0 ? FILE_SIZE : 0,
      })),
    });

  beforeAll(async () => {
    t = await bootMigratedDb();
    admin = (await createUser(t.db, { email: 'rule@example.com', displayName: 'Rule Admin' })).id;
    await seedMovies(0);
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 50,
          tvdbId: 8050,
          title: 'Night Shift',
          sortTitle: 'night shift',
          year: 2019,
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
    await t.db.delete(ledgerEvents);
    await t.db.execute(sql`TRUNCATE legacy_release_names, legacy_download_jobs`);
    await seedMovies(0);
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
  const loadLegacy = (files: Parameters<typeof loadLegacyReleaseNames>[0]['files']) =>
    loadLegacyReleaseNames({ db: t.db, files, apply: true, logger });
  const identify = async (arrKind: 'radarr' | 'sonarr', id: number, arr: { read: unknown }) =>
    identifyRelease({
      db: t.db,
      arr: arr.read as Parameters<typeof identifyRelease>[0]['arr'],
      mediaItemId: await mediaItemId(arrKind, id),
    });
  const drafts = (identity: ReleaseIdentity) => (identity.status === 'recordable' ? identity.drafts : []);
  const ledgerEvent = async (
    arrItemId: number,
    eventType: 'grabbed' | 'imported' | 'download_failed',
    payload: Record<string, unknown>,
    key: string,
    occurredAt = new Date('2025-03-01T00:00:00Z'),
  ) =>
    t.db.insert(ledgerEvents).values({
      mediaItemId: await mediaItemId('radarr', arrItemId),
      eventType,
      source: 'radarr',
      sourceEventId: key,
      occurredAt,
      payload,
    });

  // -------------------------------------------------------------------------------------------------------------
  describe('what names the file on disk', () => {
    it('a file known only by its renamed name is not named: the title is kept, nothing is recorded', async () => {
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });
      expect(keepReasonForUnrecorded('unverified_name')).toBe('release_unverified');
      expect(keepReasonForUnrecorded('cap')).toBe('release_block_full');
      expect(keepReasonForUnrecorded('no_term')).toBe('release_unrecorded');
    });

    it('a legacy file record of the same title with the IDENTICAL byte size names it; one byte off, or another title, does not', async () => {
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      // One byte short, and the right size under another title's id: neither names the file.
      await loadLegacy({
        radarrFiles: [radarrFile(9001, POSTED(9001), FILE_SIZE - 1), radarrFile(9002, POSTED(9001), FILE_SIZE)].join(
          '\n',
        ),
      });
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });

      await loadLegacy({ radarrFiles: radarrFile(9001, POSTED(9001), FILE_SIZE) });
      const identity = await identify('radarr', 1, arr);
      expect(identity.status).toBe('recordable');
      const file = drafts(identity).find((d) => d.releaseTitle === POSTED(9001));
      expect(file).toMatchObject({ identitySource: 'legacy_arr', termConfidence: 'verified', sizeBytes: FILE_SIZE });
      expect(termMatchesRaw(file!.term as string, POSTED(9001))).toBe(true);
      // The other file record of the id (one byte short) is still a name the title once had: it gets its term too,
      // here the same one. No record is built from the renamed file.
      expect(drafts(identity).every((d) => d.termConfidence === 'verified' && d.releaseTitle !== null)).toBe(true);
    });

    it('the ledger names the file through its newest download import; a folder import names nothing', async () => {
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      await ledgerEvent(
        1,
        'imported',
        { rawEventType: 'movieFolderImported', sourceTitle: POSTED(9001), releaseGroup: 'NEWGRP' },
        'folder-import',
      );
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });

      await ledgerEvent(
        1,
        'imported',
        {
          rawEventType: 'downloadFolderImported',
          sourceTitle: POSTED(9001),
          downloadId: 'dl-9',
          releaseGroup: 'NEWGRP',
          quality: 'Bluray-1080p',
        },
        'download-import',
      );
      const identity = await identify('radarr', 1, arr);
      expect(drafts(identity)[0]).toMatchObject({
        identitySource: 'ledger_grab',
        releaseTitle: POSTED(9001),
        termConfidence: 'verified',
      });
    });

    it('a grab or a failed download of the title does not name the file on disk', async () => {
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      await ledgerEvent(1, 'grabbed', { sourceTitle: 'Movie.9001.2024.720p.WEB-DL.x264-OTHER', downloadId: 'g1' }, 'g1');
      await ledgerEvent(1, 'download_failed', { sourceTitle: 'Movie.9001.2024.2160p.WEB-DL.x265-FAIL' }, 'f1');
      await loadLegacy({ radarrHistory: radarrEvent(9001, 1, 'Movie.9001.2024.1080p.WEB-DL.x264-EARLY', 'EARLY') });
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });
      expect(await records()).toHaveLength(0);
    });

    it('a title already gone from the *arr with grabs and no import is kept (`gone`): there is no file to name', async () => {
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      fixture.gone.radarr.add(1);
      await ledgerEvent(1, 'grabbed', { sourceTitle: POSTED(9001), downloadId: 'g1' }, 'g1');
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'gone' });
    });

    it('a series needs a name for EVERY episode file; a legacy file record of the season and exact size supplies one', async () => {
      const named = 'Night.Shift.S01E01.1080p.WEB-DL.x264-TVGRP';
      const legacyName = 'Night.Shift.S01E02.1080p.WEB-DL.x264-TVGRP';
      const file = (episode: number, sceneName: string | null, size: number) => ({
        seriesId: 50,
        seasonNumber: 1,
        relativePath: `Season 01/Night Shift - S01E0${episode} [WEBDL-1080p]-TVGRP.mkv`,
        sceneName,
        originalFilePath: null,
        releaseGroup: 'TVGRP',
        quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080, source: 'web', modifier: 'none' } },
        size,
      });
      const series: StaticArrSeries = {
        title: 'Night Shift',
        year: 2019,
        tvdbId: 8050,
        files: [file(1, named, 1_000_000_001), file(2, null, 1_000_000_002)],
        history: [],
      };
      const { arr } = createStaticReleaseBlockArr({ series: new Map([[50, series]]) });
      // One named file and one known only by its renamed name: the whole series is kept.
      expect(await identify('sonarr', 50, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });
      // The right size in another season does not name it.
      const sonarrFile = (season: number, size: number) =>
        tsv(8050, season, legacyName, 'TVGRP', size, 'WEBDL-1080p', '2025-02-01 00:00:00', 'Night Shift');
      await loadLegacy({ sonarrFiles: sonarrFile(2, 1_000_000_002) });
      expect(await identify('sonarr', 50, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });
      await loadLegacy({ sonarrFiles: sonarrFile(1, 1_000_000_002) });
      const identity = await identify('sonarr', 50, arr);
      expect(identity.status).toBe('recordable');
      const terms = drafts(identity).map((d) => d.term as string);
      expect(terms.some((term) => termMatchesRaw(term, named))).toBe(true);
      expect(terms.some((term) => termMatchesRaw(term, legacyName))).toBe(true);
      expect(drafts(identity).every((d) => d.termConfidence === 'verified')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('every posted name of the title gets a term', () => {
    const namedMovie = async () => {
      await loadLegacy({ radarrFiles: radarrFile(9001, POSTED(9001), FILE_SIZE) });
      return createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
    };

    it('the legacy grabbed, imported and failed names, the ledger`s grabs and its failed downloads are all termed', async () => {
      const { arr } = await namedMovie();
      const legacyGrab = 'Movie.9001.2024.720p.WEB-DL.x264-EARLY';
      const legacyFail = 'Movie.9001.2024.2160p.UHD.BluRay.x265-BROKEN';
      const legacyImport = 'Movie.9001.2024.720p.HDTV.x264-IMPORTED';
      const ledgerGrab = 'Movie.9001.2024.1080p.WEB-DL.DDP5.1.H.264-LATER';
      const ledgerFail = 'Movie.9001.2024.1080p.WEBRip.x264-FAILED';
      await loadLegacy({
        radarrHistory: [
          radarrEvent(9001, 1, legacyGrab, 'EARLY'),
          radarrEvent(9001, 4, legacyFail, 'BROKEN'),
          radarrEvent(9001, 3, legacyImport, 'IMPORTED'),
          // Another title's grab is not this title's.
          radarrEvent(9002, 1, 'Movie.9002.2024.1080p.BluRay.x264-ELSE', 'ELSE'),
        ].join('\n'),
      });
      await ledgerEvent(1, 'grabbed', { sourceTitle: ledgerGrab, downloadId: 'g1', releaseGroup: 'LATER' }, 'g1');
      await ledgerEvent(1, 'download_failed', { sourceTitle: ledgerFail, releaseGroup: 'FAILED' }, 'f1');
      const identity = await identify('radarr', 1, arr);
      expect(identity.status).toBe('recordable');
      const terms = drafts(identity).map((d) => d.term as string);
      for (const name of [POSTED(9001), legacyGrab, legacyFail, legacyImport, ledgerGrab, ledgerFail]) {
        expect(terms.some((term) => termMatchesRaw(term, name)), name).toBe(true);
      }
      expect(terms.some((term) => termMatchesRaw(term, 'Movie.9002.2024.1080p.BluRay.x264-ELSE'))).toBe(false);
      expect(drafts(identity).find((d) => d.releaseTitle === legacyFail)).toMatchObject({ identitySource: 'legacy_arr' });
      expect(drafts(identity).find((d) => d.releaseTitle === ledgerFail)).toMatchObject({ identitySource: 'ledger_grab' });
      expect(new Set(terms).size).toBe(terms.length);
    });

    it('review F1: a size-matched old job adds its term, keeps the file`s own, and names nothing', async () => {
      const otherGroup = 'Movie.9001.2024.1080p.BluRay.x264-OTHERGRP';
      const sameGroup = POSTED(9001);
      const job = (name: string, bytes: number) => tsv('old-history-a', name, bytes, 1_700_000_000, 'movies', 'Completed');
      // 96 percent of the job: inside the D-15 window.
      const jobBytes = Math.round(FILE_SIZE / 0.96);
      await loadLegacy({ sabJobs: [job(otherGroup, jobBytes), job(sameGroup, jobBytes + 1)].join('\n') });
      expect(await t.db.select().from(legacyDownloadJobs)).toHaveLength(2);
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      // Neither a job of another group nor one of the file's own group makes the file count as named.
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'unverified_name' });

      // Once the file is named by its own record, the matched jobs add their terms beside it.
      await loadLegacy({ radarrFiles: radarrFile(9001, POSTED(9001), FILE_SIZE) });
      const identity = await identify('radarr', 1, arr);
      const terms = drafts(identity).map((d) => d.term as string);
      expect(terms.some((term) => termMatchesRaw(term, POSTED(9001)))).toBe(true);
      expect(terms.some((term) => termMatchesRaw(term, otherGroup))).toBe(true);
      expect(drafts(identity).find((d) => d.releaseTitle === otherGroup)).toMatchObject({ identitySource: 'legacy_sab' });
      expect(drafts(identity)[0]).toMatchObject({ identitySource: 'legacy_arr', releaseTitle: POSTED(9001) });
    });

    it('the size rule itself still needs the title, the year and the 90 to 100 percent window', () => {
      const item = { title: 'Movie 9001', year: 2024, deletedAt: new Date('2026-01-01T00:00:00Z'), deletedSizeBytes: 900 };
      const job = (name: string, bytes: number) => ({ name, bytes, completedAt: new Date('2025-01-01T00:00:00Z') });
      expect(matchLegacySab(item, [job(POSTED(9001), 1000)])).toHaveLength(1);
      expect(matchLegacySab(item, [job(POSTED(9001), 1001)])).toHaveLength(0);
      expect(matchLegacySab(item, [job(POSTED(9001), 899)])).toHaveLength(0);
      expect(matchLegacySab(item, [job('Movie.9002.2024.1080p.BluRay.x264-NEWGRP', 1000)])).toHaveLength(0);
    });

    it('review F3: a name is used as stored; an untrimmed name its term cannot match is not verified and keeps the title', async () => {
      expect(postedReleaseName(`  ${POSTED(9001)} `)).toBe(`  ${POSTED(9001)} `);
      expect(postedReleaseName('   ')).toBeNull();
      expect(postedReleaseName('https://example.invalid/x')).toBeNull();
      const base = {
        arrKind: 'radarr' as const,
        arrItemId: 1,
        mediaItemId: null,
        title: 'Movie 9001',
        year: 2024,
        tmdbId: 9001,
        tvdbId: null,
        imdbId: null,
        arrYears: [2024],
      };
      const posted = (name: string) => ({
        name,
        releaseGroup: null,
        quality: null,
        indexer: null,
        source: 'ledger_grab' as const,
        sizeBytes: null,
      });
      const clean = draftForVerifiedName({ ...base, posted: posted(POSTED(9001)) });
      expect(clean).toMatchObject({ releaseTitle: POSTED(9001), termConfidence: 'verified' });
      expect(draftForVerifiedName({ ...base, posted: posted(` ${POSTED(9001)} `) })).toBe('untermed');

      const { arr } = await namedMovie();
      await ledgerEvent(1, 'grabbed', { sourceTitle: ` ${POSTED(9001)} `, downloadId: 'g1' }, 'g1');
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'no_term' });
    });

    it('review F4: a name the grammar cannot write keeps the title; a name with no mark of a release is skipped and counted', async () => {
      const { arr } = await namedMovie();
      await ledgerEvent(1, 'grabbed', { sourceTitle: 'Movie 9001', downloadId: 'bare' }, 'bare');
      const skipped = await identify('radarr', 1, arr);
      expect(skipped).toMatchObject({ status: 'recordable', skippedNames: 1 });

      await ledgerEvent(
        1,
        'download_failed',
        { sourceTitle: '[01/54] - "Movie.9001.2024.1080p.BluRay.x264-NEWGRP.part01.rar" yEnc' },
        'odd',
      );
      expect(await identify('radarr', 1, arr)).toEqual({ status: 'unrecordable', reason: 'no_term' });
    });

    it('the ledger read pages by keyset, repeats and skips nothing at equal timestamps, and is `truncated` past its bound', async () => {
      const mid = await mediaItemId('radarr', 1);
      const at = new Date('2025-03-01T00:00:00Z');
      await t.db.insert(ledgerEvents).values(
        Array.from({ length: 23 }, (_, i) => ({
          mediaItemId: mid,
          eventType: (i % 4 === 0 ? 'download_failed' : 'grabbed') as 'grabbed' | 'download_failed',
          source: 'radarr' as const,
          sourceEventId: `page-${i}`,
          // Runs of identical timestamps cross every page edge.
          occurredAt: new Date(at.getTime() + Math.floor(i / 7) * 1000),
          payload: { sourceTitle: `Movie.9001.2024.1080p.WEB-DL.x264-G${i}`, downloadId: `d${i}` },
        })),
      );
      const all = await ledgerPostedReleases(t.db, mid, new Date(), { pageSize: 5, maxPages: 40 });
      expect(all).not.toBe('truncated');
      expect((all as Array<{ name: string }>).map((p) => p.name).sort()).toEqual(
        Array.from({ length: 23 }, (_, i) => `Movie.9001.2024.1080p.WEB-DL.x264-G${i}`).sort(),
      );
      // 23 rows in pages of 5 need five pages; a bound of four leaves rows unread, so the read is not a list.
      expect(await ledgerPostedReleases(t.db, mid, new Date(), { pageSize: 5, maxPages: 4 })).toBe('truncated');
      // An event after `before` is not the delete's.
      expect(await ledgerPostedReleases(t.db, mid, new Date('2025-02-01T00:00:00Z'))).toEqual([]);

      // More rows than the old bound of 200 no longer keep the title: every one is read and termed.
      await t.db.delete(ledgerEvents);
      await t.db.insert(ledgerEvents).values(
        Array.from({ length: 450 }, (_, i) => ({
          mediaItemId: mid,
          eventType: 'grabbed' as const,
          source: 'radarr' as const,
          sourceEventId: `many-${i}`,
          occurredAt: new Date(at.getTime() + i),
          payload: { sourceTitle: `Movie.9001.2024.1080p.WEB-DL.x264-M${i}`, downloadId: `m${i}` },
        })),
      );
      const { arr } = await namedMovie();
      const identity = await identify('radarr', 1, arr);
      expect(identity.status).toBe('recordable');
      expect(drafts(identity)).toHaveLength(451);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('a title with no verified name is kept on every path that deletes', () => {
    const one = () => baseState({ collections: [movieCollection({ items: movieCollection().items.slice(0, 1) })] });
    const handled = (calls: Array<{ pathname: string }>) =>
      calls.some((call) => call.pathname === '/collections/media/handle');
    const itemStates = async (batchId: string) =>
      Object.fromEntries(
        (await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId))).map((r) => [
          r.maintainerrMediaId,
          { state: r.state, keepReason: r.keepReason },
        ]),
      );
    async function expiredBatch(state: MaintState) {
      const { bundle } = makeMaintainerr(state);
      const created = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId: admin });
      await t.db
        .update(trashBatches)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(trashBatches.id, created.batchId));
      return created.batchId;
    }

    it('batch build: a targeted batch never takes it, and the pending item says why', async () => {
      await seedMovies(1); // the ledger: each movie has a file, and nothing names it
      const state = baseState({ collections: [movieCollection()] });
      const { bundle } = makeMaintainerr(state);
      const pending = await listTrashPending({ db: t.db, maintainerr: bundle, media: 'movie', watchlist: null });
      expect(pending.items.map((i) => i.releaseName)).toEqual(['unverified', 'unverified', 'unverified']);
      // Name one of the three: only that one can be proposed.
      await loadLegacy({ radarrFiles: radarrFile(9002, POSTED(9002), FILE_SIZE) });
      const created = await createBatchFromPending({
        db: t.db,
        maintainerr: bundle,
        mediaKind: 'movie',
        actorId: admin,
        targeting: { maxItems: 3, strategy: 'largest' },
      });
      expect(Object.keys(await itemStates(created.batchId))).toEqual(['ms-9002']);
    });

    it('the sweep: the guardian keeps it `release_unverified` before any *arr read, and counts it', async () => {
      const state = one();
      const batchId = await expiredBatch(state); // proposed while the ledger showed no file (untargeted)
      await seedMovies(1);
      const { bundle, calls } = makeMaintainerr(state);
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, arr, registry: 'gate-only', logger });
      expect(report.paused).toBeNull();
      expect(report.batches[0]).toMatchObject({ deletedCount: 0, skippedNames: 0 });
      expect(report.batches[0]!.keptByReason).toEqual({ release_unverified: 1 });
      expect(await itemStates(batchId)).toEqual({ 'ms-9001': { state: 'skipped', keepReason: 'release_unverified' } });
      expect(handled(calls)).toBe(false);
      expect(fixture.calls.some((c) => c.startsWith('radarr'))).toBe(false);
      expect(await records()).toHaveLength(0);
      expect(logs.find((l) => l.msg === '[trash] sweep_summary')?.fields).toMatchObject({
        deleted: 0,
        releaseUnverifiedKept: 1,
        releaseBlockFullKept: 0,
        skippedNames: 0,
      });
    });

    it('the sweep: when the ledger cannot tell, the delete path`s own read of the file keeps it the same way', async () => {
      const state = one();
      const batchId = await expiredBatch(state);
      // The ledger still shows no file (a stale sync), so the guardian passes it; Radarr has one, with no name.
      const { bundle, calls } = makeMaintainerr(state);
      const { arr, fixture } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, arr, registry: 'gate-only', logger });
      expect(report.batches[0]!.keptByReason).toEqual({ release_unverified: 1 });
      expect(await itemStates(batchId)).toEqual({ 'ms-9001': { state: 'skipped', keepReason: 'release_unverified' } });
      expect(handled(calls)).toBe(false);
      expect(fixture.calls.some((c) => c.includes('create') || c.includes('update'))).toBe(false);
      expect(await records()).toHaveLength(0);
    });

    it('Expire now (the manual sweep of one batch) keeps it too', async () => {
      const state = one();
      const batchId = await expiredBatch(state);
      await seedMovies(1);
      const { bundle, calls } = makeMaintainerr(state);
      const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
      const report = await sweepExpiredBatches({
        db: t.db,
        maintainerr: bundle,
        arr,
        batchId,
        forceOverride: true,
        actorId: admin,
        registry: 'gate-only',
        logger,
      });
      expect(report.batches[0]!.keptByReason).toEqual({ release_unverified: 1 });
      expect(report.batches[0]!.deletedCount).toBe(0);
      expect(handled(calls)).toBe(false);
    });

    it('Expedite, one item: refused by the guardian, and by the delete path when the ledger cannot tell', async () => {
      const expedite = async () => {
        const { bundle, calls } = makeMaintainerr(one());
        const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]) });
        const result = await expediteDeletion({
          db: t.db,
          maintainerr: bundle,
          arr,
          scope: 'item',
          media: 'movie',
          actorId: admin,
          item: { collectionId: 7, maintainerrMediaId: 'ms-9001' },
          logger,
        });
        return { result, calls };
      };
      const byReadOfFile = await expedite(); // the ledger shows no file; Radarr's file has no name
      expect(byReadOfFile.result).toMatchObject({
        expeditedCount: 0,
        skippedCount: 1,
        unrecordedCount: 1,
        unverifiedNameCount: 1,
        blockFullCount: 0,
      });
      expect(handled(byReadOfFile.calls)).toBe(false);

      await seedMovies(1);
      const byGuardian = await expedite();
      expect(byGuardian.result).toMatchObject({ expeditedCount: 0, skippedCount: 1, unverifiedNameCount: 1 });
      expect(handled(byGuardian.calls)).toBe(false);
      expect(await records()).toHaveLength(0);
    });

    it('Expedite all: the unnamed titles are skipped and counted; the one with a verified name is deleted behind its terms', async () => {
      await seedMovies(1);
      await loadLegacy({
        radarrFiles: radarrFile(9002, POSTED(9002), FILE_SIZE),
        radarrHistory: radarrEvent(9002, 4, 'Movie.9002.2024.720p.WEB-DL.x264-FAILED', 'FAILED'),
      });
      const state = baseState({ collections: [movieCollection()] });
      const { bundle, calls } = makeMaintainerr(state);
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: new Map([
          [1, diskMovie(1)],
          [2, diskMovie(2)],
          [3, diskMovie(3)],
        ]),
      });
      let termsAtHandle: string[] = [];
      state.onHandle = () => {
        termsAtHandle = [...(fixture.profiles.radarr[0]?.ignored ?? [])];
        fixture.gone.radarr.add(2);
      };
      const result = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'all',
        media: 'movie',
        actorId: admin,
        snapshotMediaIds: ['ms-9001', 'ms-9002', 'ms-9003'],
        logger,
      });
      expect(result).toMatchObject({ expeditedCount: 1, skippedCount: 2, unverifiedNameCount: 2, blockFullCount: 0 });
      expect(result.expeditedIds).toEqual(['ms-9002']);
      expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(1);
      // Written and read back before the handle: the file's name and the failed grab.
      expect(termsAtHandle.some((term) => termMatchesRaw(term, POSTED(9002)))).toBe(true);
      expect(termsAtHandle.some((term) => termMatchesRaw(term, 'Movie.9002.2024.720p.WEB-DL.x264-FAILED'))).toBe(true);
      const rows = await records();
      expect(rows.every((r) => r.tmdbId === 9002 && r.state === 'active' && r.termConfidence === 'verified')).toBe(true);
      expect(rows).toHaveLength(2);
    });

    it('a write that fails, or a read-back that does not stick, still deletes nothing', async () => {
      await loadLegacy({ radarrFiles: radarrFile(9001, POSTED(9001), FILE_SIZE) });
      for (const broken of [{ fail: new Set(['radarr:create']) }, { dropWrites: new Set(['radarr:create']) }]) {
        await t.db.delete(trashDeletedReleases);
        const { bundle, calls } = makeMaintainerr(one());
        const { arr } = createStaticReleaseBlockArr({ movies: new Map([[1, diskMovie(1)]]), ...broken });
        const err = await expediteDeletion({
          db: t.db,
          maintainerr: bundle,
          arr,
          scope: 'item',
          media: 'movie',
          actorId: admin,
          item: { collectionId: 7, maintainerrMediaId: 'ms-9001' },
          logger,
        }).catch((error: unknown) => error);
        expect(err).toBeInstanceOf(ReleaseBlockError);
        expect(handled(calls)).toBe(false);
        expect((await records()).every((row) => row.state === 'abandoned')).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the cap never prunes on a delete (review F7)', () => {
    const capTerm = (i: number) =>
      deriveTerm({
        kind: 'movie',
        arrTitle: `Cap ${i}`,
        arrYears: [2020],
        releaseNames: [`Cap.${i}.2020.1080p.BluRay.x264-CAPGRP`],
        renamedFileName: null,
        releaseGroup: 'CAPGRP',
        resolution: 1080,
        remux: false,
      })!.term;
    const fill = async (count: number) => {
      const at = Date.now() - 86_400_000;
      const rows = Array.from({ length: count }, (_, i) => ({
        arrKind: 'radarr' as const,
        title: `Cap ${i}`,
        identitySource: 'arr_grab_history' as const,
        term: capTerm(i),
        termConfidence: 'verified' as const,
        state: 'active' as const,
        origin: 'sweep' as const,
        recordedAt: new Date(at + i),
        expiresAt: new Date(Date.now() + 100 * 86_400_000),
      }));
      for (let from = 0; from < rows.length; from += 500) {
        await t.db.insert(trashDeletedReleases).values(rows.slice(from, from + 500));
      }
    };
    const activeCount = async () =>
      (await t.db.select().from(trashDeletedReleases).where(eq(trashDeletedReleases.state, 'active'))).length;

    it('counts only terms that are new, and adds nothing when the item does not fit', () => {
      const live = new Set(['a', 'b']);
      expect(reserveTermsUnderCap(live, [{ term: 'a' }, { term: 'c' }, { term: null }], 3)).toEqual({ fits: true, fresh: 1 });
      expect([...live]).toEqual(['a', 'b', 'c']);
      expect(reserveTermsUnderCap(live, [{ term: 'd' }], 3)).toEqual({ fits: false, fresh: 1 });
      expect(live.has('d')).toBe(false);
    });

    it('a title whose terms would not all fit is kept `release_block_full`; one that fits still goes; no older term is pruned', async () => {
      await fill(RELEASE_BLOCK_TERM_CAP - 1);
      // Movie 1: its file and one failed grab are two new terms, one too many. Movie 2: one new term, which fits.
      await loadLegacy({
        radarrFiles: [radarrFile(9001, POSTED(9001), FILE_SIZE), radarrFile(9002, POSTED(9002), FILE_SIZE)].join('\n'),
        radarrHistory: radarrEvent(9001, 4, 'Movie.9001.2024.720p.WEB-DL.x264-FAILED', 'FAILED'),
      });
      const state = baseState({ collections: [movieCollection({ items: movieCollection().items.slice(0, 2) })] });
      const { bundle, calls } = makeMaintainerr(state);
      const { arr, fixture } = createStaticReleaseBlockArr({
        movies: new Map([
          [1, diskMovie(1)],
          [2, diskMovie(2)],
        ]),
      });
      state.onHandle = () => {
        fixture.gone.radarr.add(2);
      };
      const result = await expediteDeletion({
        db: t.db,
        maintainerr: bundle,
        arr,
        scope: 'all',
        media: 'movie',
        actorId: admin,
        snapshotMediaIds: ['ms-9001', 'ms-9002'],
        logger,
      });
      expect(result).toMatchObject({ expeditedCount: 1, skippedCount: 1, blockFullCount: 1, unverifiedNameCount: 0 });
      expect(result.expeditedIds).toEqual(['ms-9002']);
      expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(1);
      // Every older term is still live, and the profile holds exactly the cap.
      expect(await activeCount()).toBe(RELEASE_BLOCK_TERM_CAP);
      expect((await records()).some((r) => r.state === 'pruned')).toBe(false);
      expect(fixture.profiles.radarr[0]!.ignored).toHaveLength(RELEASE_BLOCK_TERM_CAP + 1); // + the sentinel
      expect(logs.some((l) => l.msg === '[release-block] cap_kept')).toBe(true);
    });

    it('the reconcile a delete path runs refuses over the cap (`cap`) and prunes nothing; the upkeep`s still prunes', async () => {
      await fill(RELEASE_BLOCK_TERM_CAP + 1);
      const { arr, fixture } = createStaticReleaseBlockArr();
      const err = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger, prune: false }).catch(
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ReleaseBlockError);
      expect((err as ReleaseBlockError).step).toBe('cap');
      expect((err as ReleaseBlockError).mayHaveWritten).toBe(false);
      expect(await activeCount()).toBe(RELEASE_BLOCK_TERM_CAP + 1);
      expect(fixture.profiles.radarr).toHaveLength(0);

      const upkeep = await reconcileReleaseBlock({ db: t.db, arr, arrKind: 'radarr', logger });
      expect(upkeep.pruned).toBe(1);
      expect(await activeCount()).toBe(RELEASE_BLOCK_TERM_CAP);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('the Release Name Check, the guardian and the wall', () => {
    it('reads the database only: no file, a named download import, or a legacy record of the exact size verify a movie', async () => {
      await seedMovies(1);
      const ids = await Promise.all([1, 2, 3].map((n) => mediaItemId('radarr', n)));
      const check = async () => {
        const states = await loadReleaseNameStates({ db: t.db, arrKind: 'radarr', mediaItemIds: ids });
        return ids.map((id) => states.get(id));
      };
      expect(await check()).toEqual(['unverified', 'unverified', 'unverified']);

      // Movie 1: the import carries no name of its own, its grab (the same download) does.
      await ledgerEvent(1, 'grabbed', { sourceTitle: POSTED(9001), downloadId: 'dl-1' }, 'g1');
      await ledgerEvent(1, 'imported', { rawEventType: 'downloadFolderImported', downloadId: 'dl-1' }, 'i1');
      // Movie 2: a folder import and a bare grab name nothing; a legacy record one byte off does not either.
      await ledgerEvent(2, 'imported', { rawEventType: 'movieFolderImported', sourceTitle: POSTED(9002) }, 'i2');
      await ledgerEvent(2, 'grabbed', { sourceTitle: POSTED(9002), downloadId: 'dl-2' }, 'g2');
      await loadLegacy({
        radarrFiles: [radarrFile(9002, POSTED(9002), FILE_SIZE + 1), radarrFile(9003, POSTED(9003), FILE_SIZE)].join('\n'),
      });
      expect(await check()).toEqual(['verified', 'unverified', 'verified']);

      await seedMovies(0); // no file on disk: nothing to name
      expect(await check()).toEqual(['verified', 'verified', 'verified']);

      const series = await mediaItemId('sonarr', 50);
      const tv = await loadReleaseNameStates({ db: t.db, arrKind: 'sonarr', mediaItemIds: [series] });
      expect(tv.get(series)).toBe('unchecked');
    });

    it('the runbook`s pool query (docs/ops/017) counts exactly what the check decides', async () => {
      const runbook = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'ops', '017-watchlist-protection.md'),
        'utf8',
      );
      const from = runbook.indexOf('```sql', runbook.indexOf('Pool titles the Release Name Check lets go'));
      const statement = runbook.slice(from + '```sql'.length, runbook.indexOf('```', from + 6));
      expect(statement).toContain('legacy_release_names');
      await seedMovies(1);
      await t.db.delete(trashCandidates);
      await t.db.insert(trashCandidates).values(
        [9001, 9002, 9003].map((tmdbId, ord) => ({
          mediaKind: 'movie' as const,
          collectionId: 7,
          maintainerrMediaId: `ms-${tmdbId}`,
          tmdbId,
          sizeBytes: FILE_SIZE,
          ord,
        })),
      );
      try {
        // Movie 1: named by the ledger. Movie 2: nothing. Movie 3: a legacy record of the exact size.
        await ledgerEvent(1, 'imported', { rawEventType: 'downloadFolderImported', sourceTitle: POSTED(9001) }, 'i1');
        await ledgerEvent(2, 'grabbed', { sourceTitle: POSTED(9002), downloadId: 'dl-2' }, 'g2');
        await loadLegacy({ radarrFiles: radarrFile(9003, POSTED(9003), FILE_SIZE) });
        const counts = async () => (await t.pool.query(statement)).rows[0] as Record<string, string>;
        expect(await counts()).toEqual({
          pool: '3',
          no_file: '0',
          ledger_names_it: '1',
          legacy_names_it: '1',
          deletable: '2',
          kept_no_verified_name: '1',
        });
        const ids = await Promise.all([1, 2, 3].map((n) => mediaItemId('radarr', n)));
        const states = await loadReleaseNameStates({ db: t.db, arrKind: 'radarr', mediaItemIds: ids });
        expect(ids.map((id) => states.get(id))).toEqual(['verified', 'unverified', 'verified']);
        await seedMovies(0);
        expect(await counts()).toMatchObject({ pool: '3', no_file: '3', deletable: '3', kept_no_verified_name: '0' });
      } finally {
        await t.db.delete(trashCandidates);
      }
    });

    it('the guardian keeps an unverified title after every other keep; the wall names the reason; the preview counts it', () => {
      const item = {
        maintainerrMediaId: 'ms-1',
        mediaItemId: 'uuid-1',
        protectedByTag: false,
        recentlyWatched: false,
        onWatchlist: false,
        watchlistEvaluable: true,
        ruleEvaluationFailed: false,
        ageGuard: 'clear' as const,
        saveIntent: false,
        releaseName: 'unverified' as const,
      };
      expect(classifyGuardian(item)).toEqual({ keep: true, reason: 'release_unverified' });
      expect(classifyForExpedite(item)).toBe('unverifiable');
      expect(trashWallProtection(item)).toBe('release_unverified');
      expect(classifyGuardian({ ...item, releaseName: 'verified' })).toEqual({ keep: false });
      expect(classifyGuardian({ ...item, releaseName: 'unchecked' })).toEqual({ keep: false });
      expect(trashWallProtection({ ...item, releaseName: 'verified' })).toBeNull();
      // A deliberate keep, or something that cannot be checked at all, still names itself first.
      expect(classifyGuardian({ ...item, onWatchlist: true })).toEqual({ keep: true, reason: 'watchlisted' });
      expect(classifyGuardian({ ...item, ageGuard: 'unknown' })).toEqual({ keep: true, reason: 'unevaluable' });
      expect(trashWallProtection({ ...item, ageGuard: 'recent' })).toBe('recently_added');
    });

    it('the pending read carries the verdict and the Expedite preview counts the titles kept for want of a name', async () => {
      await seedMovies(1);
      await loadLegacy({ radarrFiles: radarrFile(9003, POSTED(9003), FILE_SIZE) });
      const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
      const pending = await listTrashPending({ db: t.db, maintainerr: bundle, media: 'movie', watchlist: null });
      expect(pending.items.map((i) => [i.maintainerrMediaId, i.releaseName])).toEqual([
        ['ms-9001', 'unverified'],
        ['ms-9002', 'unverified'],
        ['ms-9003', 'verified'],
      ]);
      // With no watchlist snapshot every item is unevaluable, which is counted unverifiable but not for want of a name.
      expect(partitionPendingForExpedite(pending.items)).toMatchObject({ deletable: 0, unverifiable: 3, releaseUnverified: 0 });
      const evaluable = pending.items.map((i) => ({ ...i, watchlistEvaluable: true }));
      expect(partitionPendingForExpedite(evaluable)).toMatchObject({
        deletable: 1,
        unverifiable: 2,
        releaseUnverified: 2,
      });
    });
  });

  it('migration 0110: neither legacy table can hold a URL, whatever writes it', async () => {
    await expect(
      t.db.insert(legacyReleaseNames).values({
        arrKind: 'radarr',
        externalId: 9001,
        recordKind: 'grabbed',
        releaseName: 'https://example.invalid/x',
        dedupeKey: 'url-1',
      }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(legacyDownloadJobs).values({
        source: 'old-history-a',
        name: 'https://example.invalid/x',
        bytes: 1,
        completedAt: new Date(),
        dedupeKey: 'url-2',
      }),
    ).rejects.toThrow();
  });
});
