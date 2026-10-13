// ADR-112 C-02, C-03 / DESIGN-055 D-10, D-11, D-12 (PLAN-077 P3) — the Seerr Issue mirror's admin side on embedded
// Postgres: the staff note and the fixed-by-hand mark persist with their permission_audit row in the same transaction;
// the linked repairs come from the app's own Repair Requests, Fixes and Force Searches (by title, grain and time, never
// from Seerr's status); the title page reads (reporter's name for admins only, "you reported this" for the reporter);
// and the `/r/seerr/<id>` lookup. Nothing scores an outcome (ADR-112 C-01).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixRequests, ledgerEvents, permissionAudit, repairRequests, roles, seerrIssues } from '@hnet/db/schema';
import type { SeerrIssue } from '@hnet/arr';
import {
  NotFoundError,
  createRepairRequest,
  listSeerrIssuesForAdmin,
  recordSearchRequest,
  repairMatchesIssue,
  seerrIssueLinkTarget,
  seerrIssuesForItem,
  setSeerrIssueStaffNote,
  syncSeerrIssues,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const base = {
  status: 1,
  problemSeason: 0,
  problemEpisode: 0,
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: { id: 11, email: 'member@example.com', displayName: 'Plex Member' },
};
const ISSUES: SeerrIssue[] = [
  // Case B: an episode report on The Paper, open.
  { ...base, id: 3, issueType: 1, problemSeason: 2, problemEpisode: 6, createdAt: '2026-10-01T00:00:00.000Z', media: { mediaType: 'tv', tvdbId: 449872 }, comments: [{ id: 1, message: 'Missing episode 6', createdAt: '2026-10-01T00:00:00.000Z' }] },
  // A season report on The Paper, open.
  { ...base, id: 4, issueType: 4, problemSeason: 1, createdAt: '2026-10-01T00:00:00.000Z', media: { mediaType: 'tv', tvdbId: 449872 }, comments: [{ id: 2, message: 'Season 1 is shifted', createdAt: '2026-10-01T00:00:00.000Z' }] },
  // Case C: a movie report, resolved on 2026-10-02.
  { ...base, id: 2, issueType: 2, status: 2, updatedAt: '2026-10-02T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', media: { mediaType: 'movie', tmdbId: 769 }, createdBy: { id: 16, email: 'someone-else@example.com', displayName: 'Other Person' }, comments: [{ id: 3, message: 'Wrong language', createdAt: '2026-10-01T00:00:00.000Z' }] },
  // A title the ledger does not have.
  { ...base, id: 5, issueType: 1, createdAt: '2026-10-01T00:00:00.000Z', media: { mediaType: 'movie', tmdbId: 1 }, comments: [] },
];

describe('Seerr issues: staff note, linked repairs and reads (DESIGN-055 D-10..D-12)', () => {
  let t: TestDb;
  let memberId: string;
  let adminId: string;
  let paperId: string;
  let movieId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'member@example.com', displayName: 'Member' })).id;
    const [adminRole] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.isAdmin, true));
    adminId = (await createUser(t.db, { email: 'admin@example.com', displayName: 'Staff', roleId: adminRole!.id })).id;
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
    movieId = items.find((i) => i.arrItemId === 77)!.id;
    const sonarr = { async listEpisodes() { return [{ id: 85215, seasonNumber: 2, episodeNumber: 6 }]; } };
    await syncSeerrIssues({ db: t.db, seerr: { listAllIssues: async () => ISSUES }, sonarr });
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(repairRequests);
    await t.db.delete(fixRequests);
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.eventType, 'search_requested'));
    await t.db.update(seerrIssues).set({ staffHandledAt: null, staffHandledBy: null, staffNote: null });
    await t.db.delete(permissionAudit).where(eq(permissionAudit.action, 'update_seerr_issue_note'));
  });

  const audits = () =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'update_seerr_issue_note'));

  it('marks an issue fixed by hand with its note and an audit row, edits the note, and clears both', async () => {
    const marked = await setSeerrIssueStaffNote({
      db: t.db,
      actorId: adminId,
      seerrIssueId: 3,
      note: '  Imported by hand: the file name read as a range.  ',
      fixedByHand: true,
    });
    expect(marked).toMatchObject({ fixedByHand: true, note: 'Imported by hand: the file name read as a range.' });
    let [row] = await t.db.select().from(seerrIssues).where(eq(seerrIssues.seerrIssueId, 3));
    expect(row).toMatchObject({ staffHandledBy: adminId, staffNote: 'Imported by hand: the file name read as a range.' });
    const firstAt = row!.staffHandledAt!.getTime();

    // Editing the note keeps the first mark's time and person.
    await setSeerrIssueStaffNote({ db: t.db, actorId: memberId, seerrIssueId: 3, note: 'Missing: an import for a name read as a range.', fixedByHand: true });
    [row] = await t.db.select().from(seerrIssues).where(eq(seerrIssues.seerrIssueId, 3));
    expect(row!.staffHandledAt!.getTime()).toBe(firstAt);
    expect(row!.staffHandledBy).toBe(adminId);

    await setSeerrIssueStaffNote({ db: t.db, actorId: adminId, seerrIssueId: 3, note: '', fixedByHand: false });
    [row] = await t.db.select().from(seerrIssues).where(eq(seerrIssues.seerrIssueId, 3));
    expect(row).toMatchObject({ staffHandledAt: null, staffHandledBy: null, staffNote: null });

    const trail = await audits();
    expect(trail).toHaveLength(3);
    expect(trail.map((a) => a.detail)).toEqual(
      expect.arrayContaining([
        { seerrIssueId: 3, before: { fixedByHand: false, note: null }, after: { fixedByHand: true, note: 'Imported by hand: the file name read as a range.' } },
        { seerrIssueId: 3, before: { fixedByHand: true, note: 'Missing: an import for a name read as a range.' }, after: { fixedByHand: false, note: null } },
      ]),
    );
  });

  it('refuses a fixed-by-hand mark without a note, and an issue the mirror does not have', async () => {
    await expect(
      setSeerrIssueStaffNote({ db: t.db, actorId: adminId, seerrIssueId: 3, note: '   ', fixedByHand: true }),
    ).rejects.toThrow(/needs a note/);
    await expect(
      setSeerrIssueStaffNote({ db: t.db, actorId: adminId, seerrIssueId: 999, note: 'x', fixedByHand: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await audits()).toHaveLength(0);
  });

  it("links the app's own repairs by title, grain and time", async () => {
    const at = (iso: string) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });
    // The member's Import on S02E06 (linked to issue 3 by its episode id).
    const { repairRequestId } = await createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: paperId, kind: 'import_download', scope: 'episode', seasonNumber: 2, targetChildIds: [85215], targetLabel: 'S02E06 · 125 Years Young', preview: {} });
    // A Fix on another episode of season 2: not issue 3's episode, not issue 4's season.
    await t.db.insert(fixRequests).values({ requesterId: memberId, mediaItemId: paperId, targetArrChildId: 85299, targetScope: 'episode', targetLabel: 'S02E09 · Other', reason: 'wrong_language', status: 'completed', ...at('2026-10-05T00:00:00Z') });
    // A season-1 Fix (issue 4) by staff.
    await t.db.insert(fixRequests).values({ requesterId: adminId, mediaItemId: paperId, targetScope: 'season', targetSeason: 1, targetLabel: 'Season 1', reason: 'wrong_content', status: 'completed', ...at('2026-10-05T00:00:00Z') });
    // An episode Force Search in season 1, by label only (issue 4).
    const search = await recordSearchRequest({ db: t.db, requesterId: memberId, mediaItemId: paperId, scope: 'episode', targetArrChildId: 85101, seasonNumber: null, targetLabel: 'S01E03 · Third' });
    // A Fix on The Paper made BEFORE the reports: never linked.
    await t.db.insert(fixRequests).values({ requesterId: memberId, mediaItemId: paperId, targetScope: 'season', targetSeason: 1, targetLabel: 'Season 1', reason: 'other', reasonText: 'early', status: 'completed', ...at('2026-09-01T00:00:00Z') });
    // The movie: one Fix inside the window (before the resolve plus a day), one long after.
    await t.db.insert(fixRequests).values({ requesterId: memberId, mediaItemId: movieId, targetScope: 'item', reason: 'wrong_language', status: 'completed', ...at('2026-10-02T12:00:00Z') });
    await t.db.insert(fixRequests).values({ requesterId: memberId, mediaItemId: movieId, targetScope: 'item', reason: 'other', reasonText: 'later', status: 'completed', ...at('2026-11-01T00:00:00Z') });

    const { items } = await listSeerrIssuesForAdmin({ db: t.db, filter: 'all', limit: 50 });
    const byId = new Map(items.map((i) => [i.seerrIssueId, i]));
    expect(byId.get(3)!.linkedRepairs.map((r) => [r.kind, r.what, r.targetLabel, r.requesterIsAdmin])).toEqual([
      ['repair', 'Import', 'S02E06 · 125 Years Young', false],
    ]);
    expect(byId.get(3)!.linkedRepairs[0]!.id).toBe(repairRequestId);
    const four = byId.get(4)!.linkedRepairs.map((r) => [r.kind, r.targetLabel, r.requesterName, r.requesterIsAdmin]);
    expect(four).toEqual(
      expect.arrayContaining([
        ['fix', 'Season 1', 'Staff', true],
        ['search', 'S01E03 · Third', 'Member', false],
      ]),
    );
    expect(four).toHaveLength(2);
    expect(byId.get(4)!.linkedRepairs.find((r) => r.kind === 'search')!.id).toBe(search.eventId);
    expect(byId.get(2)!.linkedRepairs.map((r) => r.what)).toEqual(['Fix: Wrong language']);
    expect(byId.get(5)!.linkedRepairs).toEqual([]);

    // Shape: title, label, reporter name and account for the admin.
    expect(byId.get(3)).toMatchObject({
      status: 'open',
      targetLabel: 'S02E06',
      item: { id: paperId, title: 'The Paper (2025)', arrKind: 'sonarr' },
      reporterName: 'Plex Member',
      reporterAccount: { id: memberId, displayName: 'Member' },
      message: 'Missing episode 6',
    });
    expect(byId.get(5)!.item).toBeNull();
  });

  it('pages and filters the admin list (open only, newest issue first)', async () => {
    const open = await listSeerrIssuesForAdmin({ db: t.db, filter: 'open', limit: 50 });
    expect(open.items.map((i) => i.seerrIssueId)).toEqual([5, 4, 3]);
    const first = await listSeerrIssuesForAdmin({ db: t.db, filter: 'all', limit: 2 });
    expect(first.items.map((i) => i.seerrIssueId)).toEqual([5, 4]);
    const second = await listSeerrIssuesForAdmin({ db: t.db, filter: 'all', limit: 2, before: first.nextBefore });
    expect(second.items.map((i) => i.seerrIssueId)).toEqual([3, 2]);
    expect(second.nextBefore).toBeNull();
  });

  it('the title page: open reports, the arrived one whatever its status, and the name for admins only', async () => {
    const asMember = await seerrIssuesForItem({ db: t.db, mediaItemId: paperId, viewerUserId: memberId, viewerIsAdmin: false });
    expect(asMember.map((i) => i.seerrIssueId).sort()).toEqual([3, 4]);
    expect(asMember.find((i) => i.seerrIssueId === 3)).toMatchObject({ viewerIsReporter: true, reporterName: null, targetChildId: 85215, targetLabel: 'S02E06' });
    const asAdmin = await seerrIssuesForItem({ db: t.db, mediaItemId: paperId, viewerUserId: adminId, viewerIsAdmin: true });
    expect(asAdmin.find((i) => i.seerrIssueId === 3)).toMatchObject({ viewerIsReporter: false, reporterName: 'Plex Member' });
    // The movie's only report is resolved: hidden, unless the link arrived with it.
    expect(await seerrIssuesForItem({ db: t.db, mediaItemId: movieId, viewerUserId: memberId, viewerIsAdmin: false })).toEqual([]);
    const arrived = await seerrIssuesForItem({ db: t.db, mediaItemId: movieId, viewerUserId: memberId, viewerIsAdmin: false, arrivedIssueId: 2 });
    expect(arrived).toMatchObject([{ seerrIssueId: 2, status: 'resolved', issueType: 2, viewerIsReporter: false }]);
    // An id that belongs to another title brings nothing extra.
    const other = await seerrIssuesForItem({ db: t.db, mediaItemId: movieId, viewerUserId: memberId, viewerIsAdmin: false, arrivedIssueId: 3 });
    expect(other).toEqual([]);
  });

  it('the link lookup: a title, no title yet, removed, or unknown', async () => {
    expect(await seerrIssueLinkTarget({ db: t.db, seerrIssueId: 3 })).toEqual({ kind: 'title', mediaItemId: paperId, status: 'open', reporterUserId: memberId });
    expect(await seerrIssueLinkTarget({ db: t.db, seerrIssueId: 5 })).toEqual({ kind: 'no_title', status: 'open', mediaType: 'movie' });
    expect(await seerrIssueLinkTarget({ db: t.db, seerrIssueId: 404 })).toEqual({ kind: 'unknown' });
    await t.db.update(seerrIssues).set({ removedAt: new Date() }).where(eq(seerrIssues.seerrIssueId, 4));
    try {
      expect(await seerrIssueLinkTarget({ db: t.db, seerrIssueId: 4 })).toEqual({ kind: 'removed' });
    } finally {
      await t.db.update(seerrIssues).set({ removedAt: null }).where(eq(seerrIssues.seerrIssueId, 4));
    }
  });
});

describe('repairMatchesIssue (D-12 grain rule, pure)', () => {
  const episode = { mediaType: 'tv' as const, problemSeason: 2, problemEpisode: 6, targetChildId: 85215 };
  const season = { mediaType: 'tv' as const, problemSeason: 2, problemEpisode: 0, targetChildId: null };
  const movie = { mediaType: 'movie' as const, problemSeason: 0, problemEpisode: 0, targetChildId: null };
  const rec = (scope: string, o: { season?: number | null; childIds?: number[]; label?: string | null } = {}) => ({
    scope,
    season: o.season ?? null,
    childIds: o.childIds ?? [],
    label: o.label ?? null,
  });
  it('an episode report matches its episode (by id or label), its season and the whole show', () => {
    expect(repairMatchesIssue(episode, rec('episode', { childIds: [85215] }))).toBe(true);
    expect(repairMatchesIssue(episode, rec('episode', { label: 'S02E06 · Title' }))).toBe(true);
    expect(repairMatchesIssue(episode, rec('episode', { childIds: [1], label: 'S02E07' }))).toBe(false);
    expect(repairMatchesIssue(episode, rec('season', { season: 2 }))).toBe(true);
    expect(repairMatchesIssue(episode, rec('season', { season: 3 }))).toBe(false);
    expect(repairMatchesIssue(episode, rec('show'))).toBe(true);
  });
  it('a season report matches the season and its episodes; a movie report matches the movie', () => {
    expect(repairMatchesIssue(season, rec('episode', { label: 'S02E01' }))).toBe(true);
    expect(repairMatchesIssue(season, rec('episode', { season: 2, childIds: [9] }))).toBe(true);
    expect(repairMatchesIssue(season, rec('episode', { label: 'S03E01' }))).toBe(false);
    expect(repairMatchesIssue(movie, rec('item'))).toBe(true);
    expect(repairMatchesIssue(movie, rec('album'))).toBe(false);
  });
});
