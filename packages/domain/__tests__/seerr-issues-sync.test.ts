// ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3) — the Seerr Issue mirror's single writer on embedded Postgres, against an
// in-memory Seerr (the four real issues' shapes, names and messages replaced): the upsert and its mapping (ledger item
// by tmdb or tvdb, the Sonarr episode, the reporter's app account by email, the first message), an unchanged read
// counted as such, an issue deleted in Seerr marked removed (its staff note kept), a failed list read that writes
// nothing, and the webhook's single-issue read (a fresh GET, never the webhook body), including a 404 and an outage.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seerrIssues } from '@hnet/db/schema';
import type { SeerrIssue } from '@hnet/arr';
import {
  mapSeerrIssue,
  refreshSeerrIssue,
  seerrIssueTargetLabel,
  setSeerrIssueStaffNote,
  syncSeerrIssues,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const issue = (o: Partial<SeerrIssue> & { id: number }): SeerrIssue => ({
  issueType: 1,
  status: 1,
  problemSeason: 0,
  problemEpisode: 0,
  createdAt: '2026-10-04T09:44:03.000Z',
  updatedAt: '2026-10-04T09:44:03.000Z',
  media: { mediaType: 'tv', tmdbId: 253941, tvdbId: 449872 },
  createdBy: { id: 11, email: 'Reporter@Example.com', plexUsername: 'reporter', displayName: 'Reporter One' },
  comments: [],
  ...o,
});

/** Case B: The Paper (2025) S02E06, "Missing episode 6". */
const PAPER = issue({
  id: 3,
  problemSeason: 2,
  problemEpisode: 6,
  createdAt: '2026-09-27T12:00:00.000Z',
  updatedAt: '2026-09-27T12:00:00.000Z',
  comments: [
    { id: 9, message: 'Episode 6 is in the library now.', createdAt: '2026-09-27T15:00:00.000Z' },
    { id: 4, message: '  Missing episode 6  ', createdAt: '2026-09-27T12:00:00.000Z' },
  ],
});
/** Case C: GoodFellas, a movie. */
const GOODFELLAS = issue({
  id: 2,
  status: 2,
  media: { mediaType: 'movie', tmdbId: 769, tvdbId: null },
  createdBy: { id: 16, email: 'nobody-here@example.com', displayName: 'Reporter Two' },
  comments: [{ id: 2, message: 'Says I just watched it.', createdAt: '2026-10-11T00:00:00.000Z' }],
});
/** A show the ledger does not have. */
const UNKNOWN_SHOW = issue({ id: 7, media: { mediaType: 'tv', tmdbId: 1, tvdbId: 123456 }, problemSeason: 1 });

function fakeSeerr(issues: SeerrIssue[]) {
  const state = { issues: [...issues], listCalls: 0, getCalls: [] as number[], down: false };
  return {
    state,
    reader: {
      async listAllIssues() {
        state.listCalls += 1;
        if (state.down) throw new Error('seerr down');
        return state.issues;
      },
      async getIssue(id: number) {
        state.getCalls.push(id);
        if (state.down) throw new Error('seerr down');
        return state.issues.find((i) => i.id === id) ?? null;
      },
    },
  };
}

function fakeSonarr() {
  const calls: number[] = [];
  return {
    calls,
    reader: {
      async listEpisodes(seriesId: number) {
        calls.push(seriesId);
        return [
          { id: 85210, seasonNumber: 2, episodeNumber: 1 },
          { id: 85215, seasonNumber: 2, episodeNumber: 6 },
        ];
      },
    },
  };
}

describe('mapSeerrIssue (D-10, pure)', () => {
  it("maps Seerr's numbers, picks the oldest comment as the message, and never keeps the email", () => {
    const m = mapSeerrIssue(PAPER);
    expect(m).toMatchObject({
      seerrIssueId: 3,
      issueType: 1,
      status: 'open',
      problemSeason: 2,
      problemEpisode: 6,
      mediaType: 'tv',
      tvdbId: 449872,
      reporterSeerrUserId: 11,
      reporterName: 'Reporter One',
      message: 'Missing episode 6',
      commentCount: 2,
    });
    expect(mapSeerrIssue(GOODFELLAS)).toMatchObject({ status: 'resolved', mediaType: 'movie', tvdbId: null });
    // An unknown type reads "other"; a negative season reads the whole title.
    expect(mapSeerrIssue(issue({ id: 9, issueType: 9, problemSeason: -1 }))).toMatchObject({ issueType: 4, problemSeason: 0 });
    expect(seerrIssueTargetLabel(mapSeerrIssue(PAPER))).toBe('S02E06');
    expect(seerrIssueTargetLabel({ mediaType: 'tv', problemSeason: 1, problemEpisode: 0 })).toBe('Season 1');
    expect(seerrIssueTargetLabel({ mediaType: 'movie', problemSeason: 0, problemEpisode: 0 })).toBeNull();
  });
});

describe('syncSeerrIssues and refreshSeerrIssue (D-10)', () => {
  let t: TestDb;
  let reporterId: string;
  let adminId: string;
  let paperId: string;
  let goodfellasId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    reporterId = (await createUser(t.db, { email: 'reporter@example.com', displayName: 'Reporter' })).id;
    adminId = (await createUser(t.db, { email: 'staff@example.com', displayName: 'Staff' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 864, tvdbId: 449872, title: 'The Paper (2025)', sortTitle: 'paper', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [{ arrItemId: 77, tmdbId: 769, title: 'GoodFellas', sortTitle: 'goodfellas', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' }],
    });
    const items = await t.db.query.mediaItems.findMany();
    paperId = items.find((i) => i.arrItemId === 864)!.id;
    goodfellasId = items.find((i) => i.arrItemId === 77)!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(seerrIssues);
  });

  const row = async (id: number) =>
    (await t.db.select().from(seerrIssues).where(eq(seerrIssues.seerrIssueId, id)))[0];

  it('mirrors every issue with its title, episode, reporter account and first message', async () => {
    const seerr = fakeSeerr([PAPER, GOODFELLAS, UNKNOWN_SHOW]);
    const sonarr = fakeSonarr();
    const result = await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: sonarr.reader });
    expect(result).toMatchObject({ fetched: 3, inserted: 3, updated: 0, unchanged: 0, removed: 0, episodeLookupFailures: 0 });
    expect(await row(3)).toMatchObject({
      status: 'open',
      issueType: 1,
      mediaType: 'tv',
      mediaItemId: paperId,
      targetChildId: 85215,
      reporterSeerrUserId: 11,
      reporterName: 'Reporter One',
      // Case-insensitive email match to the app account.
      reporterUserId: reporterId,
      message: 'Missing episode 6',
      commentCount: 2,
      removedAt: null,
    });
    expect(sonarr.calls).toEqual([864]);
    expect(await row(2)).toMatchObject({ status: 'resolved', mediaItemId: goodfellasId, targetChildId: null, reporterUserId: null });
    // A title the ledger does not have yet is mirrored with no item.
    expect(await row(7)).toMatchObject({ mediaItemId: null, targetChildId: null });
  });

  it('counts an unchanged read as unchanged, keeps the episode id without asking Sonarr again, and takes changes', async () => {
    const seerr = fakeSeerr([PAPER, GOODFELLAS]);
    const sonarr = fakeSonarr();
    await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: sonarr.reader });
    const before = await row(3);
    const again = await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: sonarr.reader, now: new Date(Date.now() + 60_000) });
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(sonarr.calls).toEqual([864]);
    const after = await row(3);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(after!.readAt.getTime()).toBeGreaterThan(before!.readAt.getTime());

    seerr.state.issues = [{ ...PAPER, status: 2, updatedAt: '2026-09-28T00:00:00.000Z' }, GOODFELLAS];
    const changed = await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: sonarr.reader });
    expect(changed).toMatchObject({ updated: 1, unchanged: 1 });
    expect(await row(3)).toMatchObject({ status: 'resolved' });
  });

  it('marks an issue deleted in Seerr as removed, keeps its staff note, and clears the mark if it comes back', async () => {
    const seerr = fakeSeerr([PAPER, GOODFELLAS]);
    await syncSeerrIssues({ db: t.db, seerr: seerr.reader });
    await setSeerrIssueStaffNote({ db: t.db, actorId: adminId, seerrIssueId: 2, note: 'Nothing to fix on the server.', fixedByHand: true });
    seerr.state.issues = [PAPER];
    expect(await syncSeerrIssues({ db: t.db, seerr: seerr.reader })).toMatchObject({ removed: 1 });
    const gone = await row(2);
    expect(gone!.removedAt).not.toBeNull();
    expect(gone!.staffNote).toBe('Nothing to fix on the server.');
    // Already removed: not counted again.
    expect(await syncSeerrIssues({ db: t.db, seerr: seerr.reader })).toMatchObject({ removed: 0 });
    seerr.state.issues = [PAPER, GOODFELLAS];
    await syncSeerrIssues({ db: t.db, seerr: seerr.reader });
    expect((await row(2))!.removedAt).toBeNull();
    // An empty complete read removes everything.
    seerr.state.issues = [];
    expect(await syncSeerrIssues({ db: t.db, seerr: seerr.reader })).toMatchObject({ fetched: 0, removed: 2 });
  });

  it('writes nothing when the list read fails', async () => {
    const seerr = fakeSeerr([PAPER]);
    await syncSeerrIssues({ db: t.db, seerr: seerr.reader });
    seerr.state.down = true;
    await expect(syncSeerrIssues({ db: t.db, seerr: seerr.reader })).rejects.toThrow('seerr down');
    expect((await row(3))!.removedAt).toBeNull();
  });

  it('leaves the episode unknown while Sonarr is down, and finds it on a later read', async () => {
    const seerr = fakeSeerr([PAPER]);
    const broken = { async listEpisodes(): Promise<never> { throw new Error('sonarr down'); } };
    expect(await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: broken })).toMatchObject({ episodeLookupFailures: 1 });
    expect((await row(3))!.targetChildId).toBeNull();
    await syncSeerrIssues({ db: t.db, seerr: seerr.reader, sonarr: fakeSonarr().reader });
    expect((await row(3))!.targetChildId).toBe(85215);
  });

  it('the webhook read: one fresh GET, a 404 marks the issue removed, an outage changes nothing', async () => {
    const seerr = fakeSeerr([PAPER]);
    expect(await refreshSeerrIssue({ db: t.db, seerr: seerr.reader, seerrIssueId: 3 })).toEqual({ outcome: 'inserted' });
    expect(seerr.state.getCalls).toEqual([3]);
    expect(seerr.state.listCalls).toBe(0);
    expect(await refreshSeerrIssue({ db: t.db, seerr: seerr.reader, seerrIssueId: 3 })).toEqual({ outcome: 'unchanged' });
    seerr.state.down = true;
    expect(await refreshSeerrIssue({ db: t.db, seerr: seerr.reader, seerrIssueId: 3 })).toEqual({ outcome: 'unavailable' });
    seerr.state.down = false;
    seerr.state.issues = [];
    expect(await refreshSeerrIssue({ db: t.db, seerr: seerr.reader, seerrIssueId: 3 })).toEqual({ outcome: 'not_found' });
    expect((await row(3))!.removedAt).not.toBeNull();
    // A 404 for an issue the mirror never had writes nothing.
    expect(await refreshSeerrIssue({ db: t.db, seerr: seerr.reader, seerrIssueId: 99 })).toEqual({ outcome: 'not_found' });
    expect(await row(99)).toBeUndefined();
  });
});
