// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the Seerr Issue bridge's single writer on embedded Postgres, against an
// in-memory Seerr that records the acting user of every write: one comment per issue across double delivery, a crash
// after the post, a failed post and its retries; `X-API-User` (the bridge user) on every write and never user 1; the
// resolve only after the linked repair completed and nothing linked is still open, never after a failed or pending one;
// the kill switch; the link a repair may carry; and the words.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appSettings,
  fixRequests,
  permissionAudit,
  repairRequests,
  seerrIssueWrites,
  seerrIssues,
} from '@hnet/db/schema';
import { SEERR_PERMISSION_ADMIN, SEERR_PERMISSION_MANAGE_ISSUES, type SeerrIssue, type SeerrUserDetail } from '@hnet/arr';
import {
  SEERR_BRIDGE_MAX_ATTEMPTS,
  createFixRequest,
  createRepairRequest,
  getSeerrIssueBridge,
  recordRepairTransition,
  runSeerrIssueBridge,
  seerrCommentKind,
  seerrIssueCommentText,
  seerrIssueLinkUrl,
  seerrResolveNoteText,
  seerrResolveOutcome,
  setSeerrIssueBridge,
  silentDomainLogger,
  syncSeerrIssues,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const BRIDGE = 19;
const ORIGIN = 'https://haynesnetwork.com';

const baseIssue = (o: Partial<SeerrIssue> & { id: number }): SeerrIssue => ({
  issueType: 1,
  status: 1,
  problemSeason: 2,
  problemEpisode: 6,
  createdAt: '2026-10-13T12:00:00.000Z',
  updatedAt: '2026-10-13T12:00:00.000Z',
  media: { mediaType: 'tv', tmdbId: 253941, tvdbId: 449872 },
  createdBy: { id: 11, email: 'reporter@example.com', displayName: 'Reporter One' },
  comments: [{ id: 1, message: 'Missing episode 6', createdAt: '2026-10-13T12:00:00.000Z', user: { id: 11 } }],
  ...o,
});

type Call = { op: 'comment' | 'resolve'; issueId: number; asUserId: number; message?: string };

/** An in-memory Seerr: issues with comments, users, and a log of every write with its acting user. */
function fakeSeerr(issues: SeerrIssue[], users: SeerrUserDetail[] = [{ id: BRIDGE, permissions: SEERR_PERMISSION_MANAGE_ISSUES, displayName: 'haynesnetwork.com' }]) {
  const state = {
    issues: issues.map((i) => structuredClone(i)),
    users,
    calls: [] as Call[],
    nextCommentId: 100,
    /** The next comment POST fails: before Seerr stores it, or after (the answer is lost). */
    failComment: null as null | 'before' | 'after',
    failResolve: false,
    down: false,
    getCalls: 0,
  };
  const find = (id: number) => state.issues.find((i) => i.id === id) ?? null;
  return {
    state,
    clients: {
      read: {
        async getIssue(id: number) {
          state.getCalls += 1;
          if (state.down) throw new Error('seerr down');
          const i = find(id);
          return i ? structuredClone(i) : null;
        },
        async getUser(id: number) {
          if (state.down) throw new Error('seerr down');
          return state.users.find((u) => u.id === id) ?? null;
        },
      },
      write: {
        async commentOnIssue(issueId: number, message: string, asUserId: number) {
          state.calls.push({ op: 'comment', issueId, asUserId, message });
          if (state.failComment === 'before') {
            state.failComment = null;
            throw new Error('Seerr 500');
          }
          const i = find(issueId);
          if (!i) throw new Error('Issue not found.');
          i.comments = [...(i.comments ?? []), { id: state.nextCommentId++, message, createdAt: new Date().toISOString(), user: { id: asUserId } }];
          if (state.failComment === 'after') {
            state.failComment = null;
            throw new Error('socket hang up');
          }
          return structuredClone(i);
        },
        async resolveIssue(issueId: number, asUserId: number) {
          state.calls.push({ op: 'resolve', issueId, asUserId });
          if (state.failResolve) {
            state.failResolve = false;
            throw new Error('Seerr 502');
          }
          const i = find(issueId);
          if (!i) throw new Error('Issue not found.');
          i.status = 2;
          return structuredClone(i);
        },
      },
      sonarr: {
        async listEpisodes() {
          return [
            { seasonNumber: 2, episodeNumber: 5, hasFile: true },
            { seasonNumber: 2, episodeNumber: 6, hasFile: false },
          ];
        },
      },
    },
  };
}

describe('the words (pure)', () => {
  it('words the comment for what was reported, with the link written out and the staff promise', () => {
    const ep = { mediaType: 'tv' as const, problemSeason: 2, problemEpisode: 6 };
    expect(seerrCommentKind({ ...ep, issueType: 1 }, false)).toBe('missing');
    expect(seerrCommentKind({ ...ep, issueType: 2 }, false)).toBe('missing');
    expect(seerrCommentKind({ ...ep, issueType: 1 }, true)).toBe('wont_play');
    expect(seerrCommentKind({ ...ep, issueType: 1 }, null)).toBe('other');
    expect(seerrCommentKind({ ...ep, issueType: 2 }, true)).toBe('wrong_language');
    expect(seerrCommentKind({ ...ep, issueType: 3 }, null)).toBe('subtitles');
    expect(seerrCommentKind({ ...ep, issueType: 4 }, true)).toBe('other');
    expect(seerrCommentKind({ mediaType: 'tv', problemSeason: 1, problemEpisode: 0, issueType: 1 }, false)).toBe('other');
    expect(seerrCommentKind({ mediaType: 'movie', problemSeason: 0, problemEpisode: 0, issueType: 1 }, false)).toBe('missing');

    const link = seerrIssueLinkUrl(`${ORIGIN}/`, 12);
    expect(link).toBe('https://haynesnetwork.com/r/seerr/12');
    for (const kind of ['missing', 'wont_play', 'wrong_language', 'subtitles', 'other'] as const) {
      const text = seerrIssueCommentText({ kind, link, issue: ep });
      expect(text).toContain(link);
      expect(text).toContain("If that doesn't sort it out, reply here and staff will take a look.");
      expect(text).not.toMatch(/[—–]/); // owner copy rules: no em or en dashes
    }
    expect(seerrIssueCommentText({ kind: 'missing', link, issue: ep })).toContain('2. Press Force Search on S02E06.');
    expect(seerrIssueCommentText({ kind: 'wrong_language', link, issue: ep })).toContain('pick Wrong language');
    expect(seerrIssueCommentText({ kind: 'subtitles', link, issue: ep })).toContain('pick Missing subtitles');
    expect(seerrIssueCommentText({ kind: 'wont_play', link, issue: { mediaType: 'movie', problemSeason: 0, problemEpisode: 0 } })).toContain(
      'The link then opens the movie this report is about.',
    );

    const note = seerrResolveNoteText(
      seerrResolveOutcome({ kind: 'repair', id: 'x', repairKind: 'import_download', targetLabel: 'S02E06 · 125 Years Young' }, 'tv'),
    );
    expect(note).toBe(
      "Fixed on haynesnetwork.com: Force Search found the stuck download for S02E06 and imported it.\n\nIf something still isn't right, use Reopen with Comment and staff will take a look.",
    );
    expect(seerrResolveOutcome({ kind: 'fix', id: 'x', repairKind: null, targetLabel: null }, 'movie')).toBe('Fix replaced the movie with a new copy.');
  });
});

describe('the Seerr Issue bridge (embedded Postgres)', () => {
  let t: TestDb;
  let memberId: string;
  let adminId: string;
  let paperId: string;
  let movieId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'reporter@example.com', displayName: 'Reporter' })).id;
    adminId = (await createUser(t.db, { email: 'staff@example.com', displayName: 'Staff' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: 864, tvdbId: 449872, title: 'The Paper (2025)', sortTitle: 'paper', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/tv' }],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [{ arrItemId: 77, tmdbId: 769, title: 'GoodFellas', sortTitle: 'goodfellas', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m', onDiskFileCount: 1 }],
    });
    const items = await t.db.query.mediaItems.findMany();
    paperId = items.find((i) => i.arrItemId === 864)!.id;
    movieId = items.find((i) => i.arrItemId === 77)!.id;
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.db.delete(seerrIssueWrites);
    await t.db.delete(repairRequests);
    await t.db.delete(fixRequests);
    await t.db.delete(seerrIssues);
    await t.db.delete(appSettings).where(eq(appSettings.key, 'seerr_issue_bridge'));
  });

  const turnOn = (value: { comment?: boolean; resolve?: boolean; bridgeUserId?: number | null } = {}, now = new Date('2026-10-13T00:00:00Z')) =>
    setSeerrIssueBridge({
      db: t.db,
      value: { comment: value.comment ?? true, resolve: value.resolve ?? true, bridgeUserId: value.bridgeUserId === undefined ? BRIDGE : value.bridgeUserId },
      actorId: adminId,
      now,
    });

  const mirror = async (seerr: ReturnType<typeof fakeSeerr>) =>
    syncSeerrIssues({ db: t.db, seerr: { listAllIssues: async () => seerr.state.issues }, sonarr: null });

  const pass = (seerr: ReturnType<typeof fakeSeerr>, issueIds?: number[]) =>
    runSeerrIssueBridge({ db: t.db, clients: seerr.clients, linkOrigin: ORIGIN, issueIds, logger: silentDomainLogger });

  const writeRow = async (issueId: number, kind: 'comment' | 'resolve') =>
    (await t.db.select().from(seerrIssueWrites).where(eq(seerrIssueWrites.seerrIssueId, issueId))).find((r) => r.kind === kind);

  const comments = (seerr: ReturnType<typeof fakeSeerr>) => seerr.state.calls.filter((c) => c.op === 'comment');

  it('the setting: either switch needs a bridge user, never user 1; turning the comment on stamps when, audited', async () => {
    await expect(turnOn({ bridgeUserId: null })).rejects.toThrow(/Name the Seerr bridge user/);
    await expect(turnOn({ bridgeUserId: 1 })).rejects.toThrow(/never the owner/);
    expect(await getSeerrIssueBridge({ db: t.db })).toEqual({ comment: false, resolve: false, bridgeUserId: null, commentFrom: null });
    const first = await turnOn({}, new Date('2026-10-13T10:00:00Z'));
    expect(first.after).toEqual({ comment: true, resolve: true, bridgeUserId: BRIDGE, commentFrom: '2026-10-13T10:00:00.000Z' });
    // Saving again with the comment still on keeps the first stamp; off clears it.
    expect((await turnOn({}, new Date('2026-10-14T10:00:00Z'))).after.commentFrom).toBe('2026-10-13T10:00:00.000Z');
    expect((await turnOn({ comment: false })).after.commentFrom).toBeNull();
    const audits = await t.db.select().from(permissionAudit).where(eq(permissionAudit.actorId, adminId));
    expect(audits.filter((a) => a.action === 'update_app_setting' && (a.detail as { key?: string }).key === 'seerr_issue_bridge').length).toBeGreaterThanOrEqual(3);
  });

  it('off, or a bridge user Seerr would not accept, writes nothing', async () => {
    const seerr = fakeSeerr([baseIssue({ id: 3 })]);
    await mirror(seerr);
    expect((await pass(seerr)).status).toBe('off');
    await turnOn();
    for (const users of [
      [] as SeerrUserDetail[],
      [{ id: BRIDGE, permissions: SEERR_PERMISSION_MANAGE_ISSUES | SEERR_PERMISSION_ADMIN }],
      [{ id: BRIDGE, permissions: 32 }],
    ]) {
      const s = fakeSeerr([baseIssue({ id: 3 })], users);
      expect((await pass(s)).status).toBe('bridge_user_invalid');
      expect(s.state.calls).toEqual([]);
    }
    expect(await t.db.select().from(seerrIssueWrites)).toEqual([]);
  });

  it('comments once per new issue as the bridge user, worded for it, and never on an old, resolved or unmapped one', async () => {
    await turnOn();
    const seerr = fakeSeerr([
      baseIssue({ id: 3 }), // missing S02E06 (Sonarr: no file)
      baseIssue({ id: 4, createdAt: '2026-10-12T23:59:59.000Z' }), // before the switch went on
      baseIssue({ id: 5, status: 2 }), // resolved
      baseIssue({ id: 6, media: { mediaType: 'tv', tmdbId: 1, tvdbId: 123 } }), // not in the Library
      baseIssue({ id: 7, issueType: 1, problemSeason: 0, problemEpisode: 0, media: { mediaType: 'movie', tmdbId: 769, tvdbId: null } }),
    ]);
    await mirror(seerr);
    const report = await pass(seerr);
    expect(report).toMatchObject({ status: 'ok', comments: { posted: 2 } });
    expect(comments(seerr).map((c) => c.issueId)).toEqual([3, 7]);
    for (const c of seerr.state.calls) expect(c.asUserId).toBe(BRIDGE);
    expect(comments(seerr)[0]!.message).toContain('2. Press Force Search on S02E06.');
    expect(comments(seerr)[0]!.message).toContain('https://haynesnetwork.com/r/seerr/3');
    expect(comments(seerr)[1]!.message).toContain("such as Won't play"); // the movie has a file
    expect(await writeRow(3, 'comment')).toMatchObject({ state: 'done', seerrUserId: BRIDGE, seerrCommentId: 100, attempts: 1 });
    // Again (the next sync, a webhook): nothing more.
    await mirror(seerr);
    expect((await pass(seerr)).comments).toEqual({});
    expect((await pass(seerr, [3])).comments).toEqual({});
    expect(comments(seerr)).toHaveLength(2);
  });

  it('two passes at once (the webhook beside the sync) post one comment', async () => {
    await turnOn();
    const seerr = fakeSeerr([baseIssue({ id: 3 })]);
    await mirror(seerr);
    const [a, b] = await Promise.all([pass(seerr), pass(seerr, [3])]);
    expect((a.comments.posted ?? 0) + (b.comments.posted ?? 0)).toBe(1);
    expect(comments(seerr)).toHaveLength(1);
  });

  it('a post whose answer was lost is adopted on the retry, never posted twice; a refused post is retried, then given up', async () => {
    await turnOn();
    const seerr = fakeSeerr([baseIssue({ id: 3 }), baseIssue({ id: 8 })]);
    await mirror(seerr);
    seerr.state.failComment = 'after'; // Seerr stored issue 3's comment, the answer never came back
    await pass(seerr, [3]);
    expect(await writeRow(3, 'comment')).toMatchObject({ state: 'failed', attempts: 1, lastError: 'socket hang up' });
    expect((await pass(seerr, [3])).comments).toEqual({ adopted: 1 });
    expect(await writeRow(3, 'comment')).toMatchObject({ state: 'done', attempts: 2, seerrCommentId: 100 });
    expect(comments(seerr).filter((c) => c.issueId === 3)).toHaveLength(1);

    // A crash between the post and the row's completion leaves `intended`: reclaimed once stale, then adopted.
    seerr.state.failComment = null;
    await t.db.update(seerrIssueWrites).set({ state: 'intended', doneAt: null, updatedAt: new Date('2026-10-13T00:00:00Z') }).where(eq(seerrIssueWrites.seerrIssueId, 3));
    expect((await pass(seerr, [3])).comments).toEqual({ adopted: 1 });
    expect(comments(seerr).filter((c) => c.issueId === 3)).toHaveLength(1);

    // Refused before storing: retried each pass up to the cap.
    for (let i = 0; i < SEERR_BRIDGE_MAX_ATTEMPTS; i += 1) {
      seerr.state.failComment = 'before';
      await pass(seerr, [8]);
    }
    expect(await writeRow(8, 'comment')).toMatchObject({ state: 'failed', attempts: SEERR_BRIDGE_MAX_ATTEMPTS, lastError: 'Seerr 500' });
    await pass(seerr, [8]);
    expect(comments(seerr).filter((c) => c.issueId === 8)).toHaveLength(SEERR_BRIDGE_MAX_ATTEMPTS);
  });

  it('a report resolved or deleted in Seerr before the post is skipped', async () => {
    await turnOn();
    const seerr = fakeSeerr([baseIssue({ id: 3 }), baseIssue({ id: 9 })]);
    await mirror(seerr);
    seerr.state.issues.find((i) => i.id === 3)!.status = 2; // the mirror still says open
    seerr.state.issues = seerr.state.issues.filter((i) => i.id !== 9);
    expect((await pass(seerr)).comments).toEqual({ skipped_resolved: 1, skipped_removed: 1 });
    expect(seerr.state.calls).toEqual([]);
  });

  it('a repair keeps the issue only when it is open and on the same title; a Fix too', async () => {
    const seerr = fakeSeerr([baseIssue({ id: 3 }), baseIssue({ id: 5, status: 2 })]);
    await mirror(seerr);
    const make = (seerrIssueId: number, mediaItemId: string) =>
      createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId, kind: 'audio_preference', scope: mediaItemId === movieId ? 'item' : 'episode', seasonNumber: mediaItemId === movieId ? null : 2, targetChildIds: [], preview: {}, seerrIssueId });
    const ok = await make(3, paperId);
    const other = await make(3, movieId);
    await recordRepairTransition({ db: t.db, repairRequestId: ok.repairRequestId, transition: 'completed' });
    const resolved = await make(5, paperId);
    const rows = await t.db.select({ id: repairRequests.id, s: repairRequests.seerrIssueId }).from(repairRequests);
    expect(rows.find((r) => r.id === ok.repairRequestId)!.s).toBe(3);
    expect(rows.find((r) => r.id === other.repairRequestId)!.s).toBeNull();
    expect(rows.find((r) => r.id === resolved.repairRequestId)!.s).toBeNull();
    const fix = await createFixRequest({ db: t.db, requesterId: memberId, mediaItemId: movieId, reason: 'wont_play_corrupt', seerrIssueId: 3 });
    expect((await t.db.select().from(fixRequests).where(eq(fixRequests.id, fix.fixRequestId)))[0]!.seerrIssueId).toBeNull();
  });

  it('resolves only after the linked repair completed and nothing linked is open; never after a failed or pending one', async () => {
    await turnOn({ comment: false });
    const seerr = fakeSeerr([baseIssue({ id: 3 })]);
    await mirror(seerr);
    const open = (kind: 'import_download' | 'release_pick') =>
      createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: paperId, kind, scope: 'episode', seasonNumber: 2, targetChildIds: [85215], targetLabel: 'S02E06 · 125 Years Young', preview: {}, seerrIssueId: 3 });

    const first = await open('import_download');
    await pass(seerr);
    expect(seerr.state.calls).toEqual([]); // pending
    await recordRepairTransition({ db: t.db, repairRequestId: first.repairRequestId, transition: 'failed' });
    await pass(seerr);
    expect(seerr.state.calls).toEqual([]); // the newest failed: staff take it

    const second = await open('release_pick');
    await recordRepairTransition({ db: t.db, repairRequestId: second.repairRequestId, transition: 'actioned' });
    await pass(seerr);
    expect(seerr.state.calls).toEqual([]); // still running
    await recordRepairTransition({ db: t.db, repairRequestId: second.repairRequestId, transition: 'completed' });
    expect((await pass(seerr)).resolves).toEqual({ resolved: 1 });
    expect(seerr.state.calls.map((c) => [c.op, c.asUserId])).toEqual([
      ['comment', BRIDGE],
      ['resolve', BRIDGE],
    ]);
    expect(seerr.state.calls[0]!.message).toBe(
      "Fixed on haynesnetwork.com: A release for S02E06 was picked from the full list of downloads and imported.\n\nIf something still isn't right, use Reopen with Comment and staff will take a look.",
    );
    expect(await writeRow(3, 'resolve')).toMatchObject({ state: 'done', repairRequestId: second.repairRequestId, seerrCommentId: 100 });
    // Reopened in Seerr: the bridge never resolves it a second time.
    seerr.state.issues[0]!.status = 1;
    await mirror(seerr);
    await pass(seerr);
    expect(seerr.state.calls).toHaveLength(2);
  });

  it('a resolve whose note posted but whose resolve failed retries the resolve without a second note', async () => {
    await turnOn({ comment: false });
    const seerr = fakeSeerr([baseIssue({ id: 3 })]);
    await mirror(seerr);
    const r = await createRepairRequest({ db: t.db, requesterId: null, mediaItemId: paperId, kind: 'import_download', scope: 'episode', seasonNumber: 2, targetChildIds: [85215], targetLabel: 'S02E06', preview: {}, seerrIssueId: 3 });
    await recordRepairTransition({ db: t.db, repairRequestId: r.repairRequestId, transition: 'completed' });
    seerr.state.failResolve = true;
    expect((await pass(seerr)).resolves).toEqual({ failed: 1 });
    expect((await pass(seerr)).resolves).toEqual({ resolved: 1 });
    expect(seerr.state.calls.map((c) => c.op)).toEqual(['comment', 'resolve', 'resolve']);
    expect(seerr.state.issues[0]!.status).toBe(2);
  });

  it('a Fix that completed resolves too; one resolved by someone else first is left alone', async () => {
    await turnOn({ comment: false });
    const seerr = fakeSeerr([
      baseIssue({ id: 7, problemSeason: 0, problemEpisode: 0, media: { mediaType: 'movie', tmdbId: 769, tvdbId: null } }),
      baseIssue({ id: 3 }),
    ]);
    await mirror(seerr);
    const fix = await createFixRequest({ db: t.db, requesterId: memberId, mediaItemId: movieId, reason: 'wont_play_corrupt', seerrIssueId: 7 });
    await t.db.update(fixRequests).set({ status: 'completed' }).where(eq(fixRequests.id, fix.fixRequestId));
    const r = await createRepairRequest({ db: t.db, requesterId: memberId, mediaItemId: paperId, kind: 'import_download', scope: 'episode', seasonNumber: 2, targetChildIds: [85215], targetLabel: 'S02E06', preview: {}, seerrIssueId: 3 });
    await recordRepairTransition({ db: t.db, repairRequestId: r.repairRequestId, transition: 'completed' });
    seerr.state.issues.find((i) => i.id === 3)!.status = 2; // resolved by someone in Seerr; the mirror still says open
    expect((await pass(seerr)).resolves).toEqual({ resolved: 1, skipped_resolved: 1 });
    expect(seerr.state.calls.find((c) => c.op === 'comment')!.message).toContain('Fixed on haynesnetwork.com: Fix replaced the movie with a new copy.');
    expect(seerr.state.calls.filter((c) => c.issueId === 3)).toEqual([]);
  });
});
