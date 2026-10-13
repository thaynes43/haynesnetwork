// ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — the `title-check` sync mode wiring: runSync drives the domain
// runTitleCheck single writer through the injected (read-only) Sonarr reader, returns a `titleCheck` report (no
// per-source loop, no sync_runs row), requires the reader, and turns a failed history read into totalFailure. The
// census's rules themselves are covered by the @hnet/domain suite (title-check.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRuns, titleChecks } from '@hnet/db';
import { upsertMediaItemsBatch } from '@hnet/domain';
import type { SonarrImportHistoryRecord } from '@hnet/arr';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

const DSNP = 'Regular.Show..The.Lost.Tapes.S01E24.All.You.Can.Fit.1080p.DSNP.WEB-DL.DDP5.1.H.264-AndreMor';

const IMPORT: SonarrImportHistoryRecord = {
  id: 1,
  eventType: 'downloadFolderImported',
  date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  seriesId: 1061,
  episodeId: 118420,
  sourceTitle: DSNP,
  downloadId: 'dl-1',
  fileId: 9024,
  droppedPath: `/data/usenet/complete-k8s/tv/${DSNP}/${DSNP}.mkv`,
  importedPath: null,
  releaseGroup: 'AndreMor',
};

const EPISODES = [
  { id: 118419, seasonNumber: 1, episodeNumber: 23, title: 'All You Can Fit', episodeFileId: 0 },
  { id: 118420, seasonNumber: 1, episodeNumber: 24, title: "Don's Back", episodeFileId: 9024 },
];

describe('runSync — title-check mode (DESIGN-055 D-05)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 1061, tvdbId: 465012, title: 'Regular Show: The Lost Tapes', sortTitle: 'regular show the lost tapes', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
  });
  afterAll(async () => t?.stop());

  it('records one verdict per imported file, read-only, with no sync_runs row', async () => {
    const reads: string[] = [];
    const report = await runSync({
      mode: 'title-check',
      clients: {},
      titleCheck: {
        sonarr: {
          getImportHistorySince: async () => (reads.push('history'), [IMPORT]),
          listEpisodes: async (id: number) => (reads.push(`episodes:${id}`), EPISODES),
        },
      },
      db: t.db,
    });
    expect(report.mode).toBe('title-check');
    expect(report.sources).toEqual([]);
    expect(report.totalFailure).toBe(false);
    expect(report.titleCheck).toMatchObject({ records: 1, files: 1, written: 1, flagsOpened: 1, errors: 0 });
    expect(reads).toEqual(['history', 'episodes:1061']);
    const [row] = await t.db.select().from(titleChecks);
    expect(row).toMatchObject({ episodeFileId: 9024, verdict: 'disagrees', bestEpisodeId: 118419, origin: 'history' });
    expect(await t.db.select().from(syncRuns)).toEqual([]);
  });

  it('a failed history read is a totalFailure and keeps the rows', async () => {
    const report = await runSync({
      mode: 'title-check',
      clients: {},
      titleCheck: {
        sonarr: {
          getImportHistorySince: async () => Promise.reject(new Error('sonarr: http_503')),
          listEpisodes: async () => EPISODES,
        },
      },
      db: t.db,
    });
    expect(report.totalFailure).toBe(true);
    expect(report.titleCheckError).toMatch(/http_503/);
    expect(report.titleCheck).toBeNull();
    expect(await t.db.select().from(titleChecks)).toHaveLength(1);
  });

  it('requires the Sonarr reader', async () => {
    await expect(runSync({ mode: 'title-check', clients: {}, db: t.db })).rejects.toThrow(/Sonarr reader/);
  });
});
