// ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — the Title Check census and its single writer, on embedded Postgres
// against an in-memory Sonarr, with Case A's real names (Regular Show: The Lost Tapes S01, the season's TVDB titles from
// fixtures/title-evidence-seasons.json):
// - the Disney+ "All You Can Fit" file filed on E24 disagrees (best E23); the HMAX "S01E10.Spice.It.Up" file on E11
//   agrees (the title outranks the number); a BiOMA name is silent; a two-episode file is judged against both;
// - any agreeing name wins over another name, and the name that decided is stored;
// - the cursor and its overlap (a re-run writes nothing new); a flag is cleared once its file left the episode, and a
//   re-read of the same import never reopens it; a failed series read is counted and skipped;
// - listTitleFlags verifies live and clears a stale flag; sourceTitlesForSeries;
// - the backfill: a dry run writes nothing, a scene name judges a file with no import record, the library file name
//   (`relativePath`) is never evidence, a file that no longer exists is not judged;
// - the nightly digest's count line.
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationOutbox, titleChecks } from '@hnet/db';
import { ArrHttpError, type SonarrImportHistoryRecord } from '@hnet/arr';
import {
  backfillTitleChecks,
  judgeTitleCheckFile,
  listTitleFlags,
  renderOutboxEmail,
  runFailureDigest,
  runTitleCheck,
  sourceTitlesForSeries,
  upsertMediaItemsBatch,
  type TitleCheckEpisode,
  type TitleCheckEpisodeFile,
  type TitleEvidenceEpisode,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

// Sonarr `GET /api/v3/episode?seriesId=` season lists, read live 2026-10-12 (titles verbatim).
const SEASONS = JSON.parse(
  readFileSync(new URL('./fixtures/title-evidence-seasons.json', import.meta.url), 'utf8'),
) as Record<string, { seriesId: number; season: number; episodes: TitleEvidenceEpisode[] }>;
const LOST_TAPES = SEASONS['Regular Show: The Lost Tapes S1']!;
const SERIES = LOST_TAPES.seriesId; // 1061
const ep = (n: number) => {
  const e = LOST_TAPES.episodes.find((x) => x.episodeNumber === n);
  if (!e) throw new Error(`no E${n}`);
  return e.id;
};

const DSNP = 'Regular.Show..The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-AndreMor';
const HMAX = 'Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT';
const BIOMA = 'Regular.Show.The.Lost.Tapes.S01E11.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA';
const TWO_PART = 'Regular.Show.The.Lost.Tapes.S01E16E17.Clean.the.Living.Room.Artists.Block.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune';

const NOW = new Date('2026-10-12T12:00:00Z');
const at = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();
const HOUR = 60 * 60 * 1000;

let nextHistoryId = 1;
function imported(o: {
  fileId: number;
  episode: number;
  sourceTitle: string | null;
  dropped?: string | null;
  date: string;
  seriesId?: number;
}): SonarrImportHistoryRecord {
  return {
    id: nextHistoryId++,
    eventType: 'downloadFolderImported',
    date: o.date,
    seriesId: o.seriesId ?? SERIES,
    episodeId: ep(o.episode),
    sourceTitle: o.sourceTitle,
    downloadId: `dl-${o.fileId}`,
    fileId: o.fileId,
    droppedPath:
      o.dropped === undefined ? `/data/usenet/complete-k8s/tv/${o.sourceTitle}/${o.sourceTitle}.mkv` : o.dropped,
    importedPath: null,
    releaseGroup: null,
  };
}

/** The season's episodes, with these files on these episode numbers. */
function seasonEpisodes(files: Record<number, number>): TitleCheckEpisode[] {
  return LOST_TAPES.episodes.map((e) => ({
    id: e.id,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    title: e.title,
    episodeFileId: files[e.episodeNumber] ?? 0,
  }));
}

function fakeSonarr(init: {
  history: SonarrImportHistoryRecord[];
  files: Record<number, number>;
  episodeFiles?: TitleCheckEpisodeFile[];
}) {
  const state = {
    history: init.history,
    episodes: new Map<number, TitleCheckEpisode[]>([[SERIES, seasonEpisodes(init.files)]]),
    episodeFiles: new Map<number, TitleCheckEpisodeFile[]>([[SERIES, init.episodeFiles ?? []]]),
    failing: new Set<number>(),
    since: [] as Date[],
    episodeReads: [] as number[],
    pages: [] as number[],
  };
  const reader = {
    async getImportHistorySince(date: Date) {
      state.since.push(date);
      return state.history.filter((r) => new Date(r.date) >= date);
    },
    async getImportHistoryPage({ page, pageSize = 1000 }: { page: number; pageSize?: number }) {
      state.pages.push(page);
      return { totalRecords: state.history.length, records: state.history.slice((page - 1) * pageSize, page * pageSize) };
    },
    async listEpisodes(seriesId: number) {
      state.episodeReads.push(seriesId);
      if (state.failing.has(seriesId)) throw new Error(`sonarr: http_503 for ${seriesId}`);
      return state.episodes.get(seriesId) ?? [];
    },
    async listEpisodeFileReleases(seriesId: number) {
      if (state.failing.has(seriesId)) throw new Error(`sonarr: http_503 for ${seriesId}`);
      return state.episodeFiles.get(seriesId) ?? [];
    },
  };
  return { state, reader };
}

/** Case A as Sonarr filed it: the DSNP file on E24, the HMAX file on E11, a BiOMA file on E12, a two-part file. */
const caseA = () =>
  fakeSonarr({
    history: [
      imported({ fileId: 9024, episode: 24, sourceTitle: DSNP, date: at(3 * HOUR) }),
      imported({ fileId: 9011, episode: 11, sourceTitle: HMAX, date: at(2 * HOUR) }),
      imported({ fileId: 9012, episode: 12, sourceTitle: BIOMA, date: at(2 * HOUR) }),
      imported({ fileId: 9016, episode: 16, sourceTitle: TWO_PART, date: at(1 * HOUR) }),
      imported({ fileId: 9016, episode: 17, sourceTitle: TWO_PART, date: at(1 * HOUR) }),
    ],
    files: { 24: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016 },
  });

describe('judgeTitleCheckFile (D-05, pure)', () => {
  const episodes = LOST_TAPES.episodes;
  it("keeps any agreeing name, else the first disagreeing one, and stores the name that decided", () => {
    const silentThenAgrees = judgeTitleCheckFile({
      names: [BIOMA.replace('S01E11', 'S01E23'), 'Regular.Show.The.Lost.Tapes.S01E23.All.You.Can.Fit.1080p'],
      episodes,
      fileEpisodeIds: [ep(23)],
    });
    expect(silentThenAgrees).toMatchObject({
      verdict: 'agrees',
      name: 'Regular.Show.The.Lost.Tapes.S01E23.All.You.Can.Fit.1080p',
      episodeId: ep(23),
      seasonNumber: 1,
    });
    // A disagreeing name beats a silent one; it keeps its best episode and scores.
    const j = judgeTitleCheckFile({ names: [BIOMA.replace('S01E11', 'S01E24'), DSNP], episodes, fileEpisodeIds: [ep(24)] });
    expect(j).toMatchObject({ verdict: 'disagrees', name: DSNP, bestEpisodeId: ep(23), bestScore: 1 });
    // No names, or none of the file's episodes on the series: nothing to judge.
    expect(judgeTitleCheckFile({ names: [null, ' '], episodes, fileEpisodeIds: [ep(24)] })).toBeNull();
    expect(judgeTitleCheckFile({ names: [DSNP], episodes, fileEpisodeIds: [999_999] })).toBeNull();
  });
});

describe('the Title Check census (D-05)', () => {
  let t: TestDb;
  let itemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: SERIES,
          tvdbId: 465012,
          title: 'Regular Show: The Lost Tapes',
          sortTitle: 'regular show the lost tapes',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    itemId = (await t.db.query.mediaItems.findMany())[0]!.id;
  }, 240_000);

  afterAll(async () => {
    await t?.stop();
  });

  beforeEach(async () => {
    await t.db.delete(titleChecks);
    await t.db.delete(notificationOutbox);
  });

  const rowFor = async (fileId: number) =>
    (await t.db.select().from(titleChecks).where(eq(titleChecks.episodeFileId, fileId)))[0];

  it("judges Case A's imports: E24's Disney+ file disagrees (E23), E11's HMAX file agrees, BiOMA is silent", async () => {
    const sonarr = caseA();
    const result = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    expect(sonarr.state.since[0]!.toISOString()).toBe(at(48 * HOUR));
    expect(result).toMatchObject({
      records: 5,
      files: 4,
      skipped: 0,
      verdicts: { agrees: 2, disagrees: 1, silent: 1, ambiguous: 0 },
      inserted: 4,
      written: 4,
      flagsOpened: 1,
      flagsCleared: 0,
      errors: 0,
    });
    // One episode read per touched series (the open flag's series was already read: no second read).
    expect(sonarr.state.episodeReads).toEqual([SERIES]);

    expect(await rowFor(9024)).toMatchObject({
      instance: 'sonarr',
      seriesId: SERIES,
      mediaItemId: itemId,
      seasonNumber: 1,
      episodeId: ep(24),
      episodeIds: [ep(24)],
      verdict: 'disagrees',
      bestEpisodeId: ep(23),
      score: 0,
      bestScore: 1,
      sourceTitle: DSNP,
      origin: 'history',
      clearedAt: null,
    });
    expect((await rowFor(9024))!.importedAt.toISOString()).toBe(at(3 * HOUR));
    expect(await rowFor(9011)).toMatchObject({ verdict: 'agrees', episodeId: ep(11), bestEpisodeId: ep(11) });
    expect(await rowFor(9012)).toMatchObject({ verdict: 'silent', bestEpisodeId: null, score: null, bestScore: null });
    // The two-part file: both episodes, in episode order (E16's id is the larger one), judged together.
    expect(await rowFor(9016)).toMatchObject({
      verdict: 'agrees',
      episodeId: ep(16),
      episodeIds: [ep(16), ep(17)],
    });
  });

  it('a two-part file filed on the wrong pair disagrees, pointing at its first episode', async () => {
    const sonarr = fakeSonarr({
      history: [
        imported({ fileId: 9018, episode: 18, sourceTitle: TWO_PART, date: at(HOUR) }),
        imported({ fileId: 9018, episode: 19, sourceTitle: TWO_PART, date: at(HOUR) }),
      ],
      files: { 18: 9018, 19: 9018 },
    });
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    expect(await rowFor(9018)).toMatchObject({
      verdict: 'disagrees',
      episodeIds: [ep(18), ep(19)],
      bestEpisodeId: ep(16),
    });
  });

  it('reads from its cursor less two hours, and a re-run of the same history writes no new row', async () => {
    const sonarr = caseA();
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    const later = new Date(NOW.getTime() + HOUR);
    const again = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: later });
    // The newest history row was imported an hour before NOW: the cursor is that, less the overlap.
    expect(sonarr.state.since[1]!.toISOString()).toBe(at(3 * HOUR));
    // The overlap re-reads every Case A import (the oldest sits exactly at the window's start): all unchanged.
    expect(again).toMatchObject({ records: 5, files: 4, inserted: 0, updated: 0, unchanged: 4, written: 0, flagsOpened: 0 });
    expect(await t.db.select().from(titleChecks)).toHaveLength(4);

    // A new import adds one row, and moves the cursor.
    sonarr.state.history.push(
      imported({ fileId: 9023, episode: 23, sourceTitle: DSNP.replace('S01E24', 'S01E23'), date: later.toISOString() }),
    );
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 24: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016, 23: 9023 }));
    const third = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(later.getTime() + HOUR) });
    expect(third).toMatchObject({ files: 5, inserted: 1, unchanged: 4, verdicts: { agrees: 3 } });
    expect(sonarr.state.since[2]!.toISOString()).toBe(at(3 * HOUR));
    expect(await t.db.select().from(titleChecks)).toHaveLength(5);
    // The next run starts two hours before that import.
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(later.getTime() + 2 * HOUR) });
    expect(sonarr.state.since[3]!.toISOString()).toBe(new Date(later.getTime() - 2 * HOUR).toISOString());
  });

  it("clears a flag once its file has left the episode, and a re-read of the same import doesn't reopen it", async () => {
    const sonarr = caseA();
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    expect(await rowFor(9024)).toMatchObject({ verdict: 'disagrees', clearedAt: null });

    // The file on E24 was replaced (an upgrade); no new import history for it in this window.
    sonarr.state.history = [];
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 24: 9100, 11: 9011, 12: 9012, 16: 9016, 17: 9016 }));
    const later = new Date(NOW.getTime() + HOUR);
    const result = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: later });
    expect(result).toMatchObject({ records: 0, files: 0, flagsCleared: 1, seriesRead: 1 });
    expect((await rowFor(9024))!.clearedAt?.toISOString()).toBe(later.toISOString());

    // The overlap re-reads the original import: the row is unchanged and the flag stays closed.
    sonarr.state.history = [imported({ fileId: 9024, episode: 24, sourceTitle: DSNP, date: at(3 * HOUR) })];
    const reread = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(later.getTime() + 60_000) });
    expect(reread).toMatchObject({ unchanged: 1, flagsOpened: 0 });
    expect((await rowFor(9024))!.clearedAt).not.toBeNull();
  });

  it('an update keeps a cleared flag closed on the same episodes, and a new mapping is judged afresh', async () => {
    const sonarr = caseA();
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    // The DSNP file moved to E25 (still the wrong episode): the flag on E24 closes.
    sonarr.state.history = [];
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 25: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016 }));
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(NOW.getTime() + HOUR) });
    const cleared = (await rowFor(9024))!.clearedAt;
    expect(cleared).not.toBeNull();

    // The same import re-read with a changed name updates the row (same episodes): it stays closed.
    sonarr.state.history = [
      imported({ fileId: 9024, episode: 24, sourceTitle: `${DSNP}.REPACK`, dropped: null, date: at(3 * HOUR) }),
    ];
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 24: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016 }));
    const updated = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(NOW.getTime() + 2 * HOUR) });
    expect(updated).toMatchObject({ updated: 1, flagsOpened: 0 });
    expect((await rowFor(9024))!.clearedAt?.getTime()).toBe(cleared!.getTime());

    // The backfill judges the file where it sits now (E25): a new mapping, still disagreeing, so the flag opens again.
    sonarr.state.history = [imported({ fileId: 9024, episode: 24, sourceTitle: DSNP, date: at(3 * HOUR) })];
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 25: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016 }));
    const report = await backfillTitleChecks({ db: t.db, sonarr: sonarr.reader, dryRun: false, now: NOW });
    expect(report).toMatchObject({ flagsOpened: 1 });
    expect(await rowFor(9024)).toMatchObject({
      verdict: 'disagrees',
      episodeIds: [ep(25)],
      bestEpisodeId: ep(23),
      clearedAt: null,
      // The row keeps how it was first written.
      origin: 'history',
    });
  });

  it('counts a failed series read and holds the cursor at it, so nothing after it is skipped for good', async () => {
    const sonarr = caseA();
    sonarr.state.history.push(imported({ fileId: 7001, episode: 1, sourceTitle: DSNP, date: at(HOUR), seriesId: 2000 }));
    sonarr.state.failing.add(2000);
    const result = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    // The import an hour ago could not be read; the two-part file imported then waits with it (cursor held).
    expect(result).toMatchObject({ files: 3, skipped: 1, deferred: 1, errors: 1, written: 3 });
    expect(result.errorSamples[0]).toMatch(/series 2000: .*http_503/);
    expect(await rowFor(7001)).toBeUndefined();
    expect(await rowFor(9016)).toBeUndefined();
    // Sonarr answers again: the next run reads from before the held import and lands both.
    sonarr.state.failing.delete(2000);
    sonarr.state.episodes.set(2000, [{ id: ep(1), seasonNumber: 1, episodeNumber: 1, title: 'Pilot', episodeFileId: 7001 }]);
    const next = await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: new Date(NOW.getTime() + HOUR) });
    expect(next).toMatchObject({ deferred: 0, errors: 0 });
    expect(await rowFor(7001)).toBeDefined();
    expect(await rowFor(9016)).toBeDefined();
  });

  it('a series Sonarr no longer has (404) is skipped without holding the cursor', async () => {
    const sonarr = caseA();
    sonarr.state.history.push(imported({ fileId: 7002, episode: 1, sourceTitle: DSNP, date: at(HOUR), seriesId: 2001 }));
    const reader = {
      ...sonarr.reader,
      listEpisodes: async (id: number) => {
        if (id === 2001) throw new ArrHttpError(404, 'GET', 'http://sonarr.test/api/v3/episode?seriesId=2001');
        return sonarr.reader.listEpisodes(id);
      },
    };
    const result = await runTitleCheck({ db: t.db, sonarr: reader, now: NOW });
    expect(result).toMatchObject({ files: 4, skipped: 1, deferred: 0, errors: 1, written: 4 });
  });

  it('a failed history read throws (the mode reports it) and writes nothing', async () => {
    const sonarr = caseA();
    sonarr.reader.getImportHistorySince = async () => Promise.reject(new Error('sonarr: http_502'));
    await expect(runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW })).rejects.toThrow(/http_502/);
    expect(await t.db.select().from(titleChecks)).toEqual([]);
  });

  it('listTitleFlags returns the open flags verified live, leaves out and clears a stale one', async () => {
    const sonarr = caseA();
    await runTitleCheck({ db: t.db, sonarr: sonarr.reader, now: NOW });
    const reads = sonarr.state.episodeReads.length;
    const flags = await listTitleFlags({ db: t.db, sonarr: sonarr.reader, mediaItemId: itemId });
    expect(sonarr.state.episodeReads).toHaveLength(reads + 1);
    expect(flags).toEqual([
      {
        titleCheckId: (await rowFor(9024))!.id,
        seasonNumber: 1,
        episodeId: ep(24),
        episodeNumber: 24,
        episodeTitle: "Don's Back",
        episodeIds: [ep(24)],
        episodeFileId: 9024,
        sourceTitle: DSNP,
        best: { episodeId: ep(23), episodeNumber: 23, title: 'All You Can Fit' },
        score: 0,
        bestScore: 1,
      },
    ]);

    // The person re-mapped the file onto E23: the flag is stale, left out and cleared.
    sonarr.state.episodes.set(SERIES, seasonEpisodes({ 23: 9024, 11: 9011, 12: 9012, 16: 9016, 17: 9016 }));
    expect(await listTitleFlags({ db: t.db, sonarr: sonarr.reader, mediaItemId: itemId, now: NOW })).toEqual([]);
    expect((await rowFor(9024))!.clearedAt).not.toBeNull();

    // No open flag: no Sonarr read. An unknown item: none.
    const before = sonarr.state.episodeReads.length;
    expect(await listTitleFlags({ db: t.db, sonarr: sonarr.reader, mediaItemId: itemId })).toEqual([]);
    expect(await listTitleFlags({ db: t.db, sonarr: sonarr.reader, mediaItemId: '00000000-0000-0000-0000-000000000000' })).toEqual([]);
    expect(sonarr.state.episodeReads).toHaveLength(before);
  });

  it('sourceTitlesForSeries maps each file to its judged name', async () => {
    await runTitleCheck({ db: t.db, sonarr: caseA().reader, now: NOW });
    const names = await sourceTitlesForSeries({ db: t.db, seriesId: SERIES });
    expect(names.get(9024)).toBe(DSNP);
    expect(names.get(9016)).toBe(TWO_PART);
    expect(names.size).toBe(4);
  });

  describe('backfillTitleChecks', () => {
    const SCENE_E30 = 'Regular.Show.The.Lost.Tapes.S01E30.Dip.Deep.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb';
    const library = () =>
      fakeSonarr({
        history: [
          imported({ fileId: 9024, episode: 24, sourceTitle: DSNP, date: at(30 * 24 * HOUR) }),
          // An import whose file is gone (upgraded since): never judged.
          imported({ fileId: 9005, episode: 5, sourceTitle: DSNP.replace('S01E24', 'S01E05'), date: at(40 * 24 * HOUR) }),
        ],
        files: { 24: 9024, 5: 9105, 30: 9030, 31: 9031 },
        episodeFiles: [
          { id: 9024, sceneName: null, dateAdded: at(30 * 24 * HOUR) },
          // No import record: its scene name is the evidence. Its library name (which Sonarr gave it after E30, "Wet
          // Phone") would agree, and is never read.
          {
            id: 9030,
            sceneName: SCENE_E30,
            dateAdded: '2026-09-10T15:04:00Z',
            relativePath: 'Season 1/Regular Show - The Lost Tapes (2026) - S01E30 - Wet Phone [WEBDL-1080p]-NTb.mkv',
          } as TitleCheckEpisodeFile,
          // Neither an import record nor a scene name: nothing to judge (the library name is not evidence).
          {
            id: 9031,
            sceneName: null,
            relativePath: 'Season 1/Regular Show - The Lost Tapes (2026) - S01E31 - Wet Phone [WEBDL-1080p].mkv',
          } as TitleCheckEpisodeFile,
          { id: 9105, sceneName: null },
        ],
      });

    it('a dry run reports and writes nothing', async () => {
      const sonarr = library();
      const progress: string[] = [];
      const report = await backfillTitleChecks({
        db: t.db,
        sonarr: sonarr.reader,
        dryRun: true,
        now: NOW,
        onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
      });
      expect(report).toMatchObject({
        dryRun: true,
        historyRecords: 2,
        historyFiles: 2,
        series: 1,
        filesJudged: 2,
        fromHistory: 1,
        fromSceneName: 1,
        noEvidence: 2,
        verdicts: { disagrees: 2, agrees: 0, silent: 0, ambiguous: 0 },
        written: 0,
        flagsOpened: 2,
        errors: 0,
      });
      expect(report.disagrees).toEqual([
        {
          seriesId: SERIES,
          seriesTitle: 'Regular Show: The Lost Tapes',
          seasonNumber: 1,
          episodeFileId: 9024,
          episode: { episodeId: ep(24), episodeNumber: 24, title: "Don's Back" },
          episodeIds: [ep(24)],
          best: { episodeId: ep(23), episodeNumber: 23, title: 'All You Can Fit' },
          score: 0,
          bestScore: 1,
          name: DSNP,
          nameFrom: 'history',
        },
        expect.objectContaining({
          episodeFileId: 9030,
          episode: { episodeId: ep(30), episodeNumber: 30, title: 'Wet Phone' },
          best: { episodeId: ep(31), episodeNumber: 31, title: 'Dip Deep' },
          name: SCENE_E30,
          nameFrom: 'scene_name',
        }),
      ]);
      expect(progress).toEqual(['history:2/2', 'series:1/1']);
      expect(await t.db.select().from(titleChecks)).toEqual([]);
    });

    it('writes backfill rows: the history time, else the date the file was added', async () => {
      const report = await backfillTitleChecks({ db: t.db, sonarr: library().reader, dryRun: false, now: NOW });
      expect(report).toMatchObject({ written: 2, flagsOpened: 2 });
      expect(await rowFor(9024)).toMatchObject({ origin: 'backfill', verdict: 'disagrees', mediaItemId: itemId });
      expect((await rowFor(9024))!.importedAt.toISOString()).toBe(at(30 * 24 * HOUR));
      expect(await rowFor(9030)).toMatchObject({ origin: 'backfill', sourceTitle: SCENE_E30, bestEpisodeId: ep(31) });
      expect((await rowFor(9030))!.importedAt.toISOString()).toBe('2026-09-10T15:04:00.000Z');
      expect(await rowFor(9005)).toBeUndefined();
      expect(await rowFor(9031)).toBeUndefined();

      // A backfill row never moves the hourly cursor: the first hourly run still reads the last 48 hours.
      const hourly = caseA();
      hourly.state.history = [];
      await runTitleCheck({ db: t.db, sonarr: hourly.reader, now: NOW });
      expect(hourly.state.since[0]!.toISOString()).toBe(at(48 * HOUR));
      // Re-running the backfill writes nothing new.
      const again = await backfillTitleChecks({ db: t.db, sonarr: library().reader, dryRun: false, now: NOW });
      expect(again).toMatchObject({ written: 0, flagsOpened: 0 });
    });

    it('pages the whole history and counts a failed series', async () => {
      const sonarr = library();
      sonarr.state.history = Array.from({ length: 1001 }, (_, i) =>
        imported({ fileId: 50_000 + i, episode: 1, sourceTitle: BIOMA, date: at(HOUR), seriesId: 3000 + (i % 2) }),
      );
      sonarr.state.failing.add(3001);
      const report = await backfillTitleChecks({ db: t.db, sonarr: sonarr.reader, dryRun: true, now: NOW, concurrency: 2 });
      expect(sonarr.state.pages).toEqual([1, 2]);
      expect(report).toMatchObject({ historyRecords: 1001, series: 2, errors: 1, filesJudged: 0 });
    });
  });

  it("the nightly digest gains the Title Check's count line", async () => {
    await runTitleCheck({ db: t.db, sonarr: caseA().reader, now: NOW });
    const report = await runFailureDigest({ db: t.db, now: NOW, adminEmail: 'admin@haynesnetwork.com' });
    expect(report).toMatchObject({ openCount: 0, enqueued: 1, titleCheck: { opened24h: 1, open: 1 } });
    const [row] = await t.db.select().from(notificationOutbox);
    const mail = renderOutboxEmail(row!)!;
    expect(mail.subject).toBe('[haynesnetwork] Title Check: 1 file flagged as mislabelled (24h)');
    expect(mail.text).toContain('Title Check (last 24h): 1 file flagged as mislabelled, 1 open flag in all.');

    // A day later the flag is still open but not new: it rides a digest going out anyway, never sends one by itself.
    await t.db.delete(notificationOutbox);
    const nextDay = await runFailureDigest({ db: t.db, now: new Date(NOW.getTime() + 25 * HOUR) });
    expect(nextDay).toMatchObject({ enqueued: 0, titleCheck: { opened24h: 0, open: 1 } });
    expect(await t.db.select().from(notificationOutbox)).toEqual([]);
  });
});
