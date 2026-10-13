// ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3) — the `seerr-issues` sync mode wiring: runSync drives the domain
// syncSeerrIssues single-writer through the injected (read-only) Seerr and Sonarr readers, returns a `seerrIssues`
// report (no per-source loop, no sync_runs row), requires the Seerr reader, and turns a failed Seerr read into
// totalFailure. The mirror's rules themselves are covered by the @hnet/domain suite (seerr-issues-sync.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seerrIssues, syncRuns } from '@hnet/db';
import { upsertMediaItemsBatch } from '@hnet/domain';
import type { SeerrIssue } from '@hnet/arr';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

const PAPER: SeerrIssue = {
  id: 3,
  issueType: 1,
  status: 1,
  problemSeason: 2,
  problemEpisode: 6,
  createdAt: '2026-09-27T12:00:00.000Z',
  updatedAt: '2026-09-27T12:00:00.000Z',
  media: { mediaType: 'tv', tmdbId: 253941, tvdbId: 449872 },
  createdBy: { id: 11, displayName: 'Reporter One' },
  comments: [{ id: 4, message: 'Missing episode 6', createdAt: '2026-09-27T12:00:00.000Z' }],
};

describe('runSync — seerr-issues mode (DESIGN-055 D-10)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 864, tvdbId: 449872, title: 'The Paper (2025)', sortTitle: 'paper', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
  });
  afterAll(async () => t?.stop());

  it('mirrors the issues read-only and reports the counts, with no sync_runs row', async () => {
    const reads: string[] = [];
    const report = await runSync({
      mode: 'seerr-issues',
      clients: {},
      seerrIssues: {
        seerr: { listAllIssues: async () => (reads.push('issues'), [PAPER]) },
        sonarr: { listEpisodes: async (id: number) => (reads.push(`episodes:${id}`), [{ id: 85215, seasonNumber: 2, episodeNumber: 6 }]) },
      },
      db: t.db,
    });
    expect(report.mode).toBe('seerr-issues');
    expect(report.sources).toEqual([]);
    expect(report.totalFailure).toBe(false);
    expect(report.seerrIssues).toMatchObject({ fetched: 1, inserted: 1, removed: 0 });
    expect(reads).toEqual(['issues', 'episodes:864']);
    const [row] = await t.db.select().from(seerrIssues);
    expect(row).toMatchObject({ seerrIssueId: 3, targetChildId: 85215, message: 'Missing episode 6' });
    expect(await t.db.select().from(syncRuns)).toEqual([]);
  });

  it('a failed Seerr read is a totalFailure and keeps the last mirror', async () => {
    const report = await runSync({
      mode: 'seerr-issues',
      clients: {},
      seerrIssues: { seerr: { listAllIssues: async () => Promise.reject(new Error('seerr: http_503')) }, sonarr: null },
      db: t.db,
    });
    expect(report.totalFailure).toBe(true);
    expect(report.seerrIssuesError).toMatch(/http_503/);
    expect(report.seerrIssues).toBeNull();
    expect(await t.db.select().from(seerrIssues)).toHaveLength(1);
  });

  it('requires the Seerr reader', async () => {
    await expect(runSync({ mode: 'seerr-issues', clients: {}, db: t.db })).rejects.toThrow(/Seerr issue reader/);
  });
});
