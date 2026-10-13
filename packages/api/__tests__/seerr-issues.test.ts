// ADR-111 C-02 / ADR-112 C-02 / DESIGN-055 D-10, D-12 (PLAN-077 P3) — the seerrIssues tRPC surface. Proves: `forItem`
// returns the title's open reports to anyone who can see the title, with the reporter's name for admins only, and
// NOT_FOUND for a title the caller cannot see (ADR-047); `adminList` and `setStaffNote` are admin-only; a
// fixed-by-hand mark without a note is refused at the zod edge; the mark is audited; an unknown issue is NOT_FOUND.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { plexLibraries, SEEDED_ROLE_IDS, type users } from '@hnet/db';
import { setRoleLibraries, syncPlexMatches, syncSeerrIssues, upsertPlexLibraries } from '@hnet/domain';
import {
  auditRows,
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let t: TestDb;
let admin: typeof users.$inferSelect;
let member: typeof users.$inferSelect;
let adminCaller: Caller;
let memberCaller: Caller;
let showId: string;
let hiddenId: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  admin = await createUser(t.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(t.db, { displayName: 'Member Mia', email: 'mia@example.com' });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin)));
  memberCaller = caller(makeCtx(t.db, sessionUser(member)));
  const show = await seedMediaItem(t.db, 'sonarr', { title: 'The Paper (2025)', tvdbId: 449872 });
  showId = show.id;
  // The show sits in the TV library, which the Default role is granted (ADR-047); another show sits nowhere it can see.
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [
      { sectionKey: '2', name: 'HNet TV', mediaType: 'show' },
      { sectionKey: '9', name: 'Hidden TV', mediaType: 'show' },
    ],
  });
  const libId = async (key: string) =>
    (await t.db.select({ id: plexLibraries.id }).from(plexLibraries).where(and(eq(plexLibraries.sectionKey, key))))[0]!.id;
  const tvLib = await libId('2');
  const hiddenLib = await libId('9');
  hiddenId = (await seedMediaItem(t.db, 'sonarr', { title: 'Hidden Show' })).id;
  await syncPlexMatches({
    db: t.db,
    matches: [
      { mediaItemId: showId, plexLibraryId: tvLib, ratingKey: '7001', matchedVia: 'tvdb' },
      { mediaItemId: hiddenId, plexLibraryId: hiddenLib, ratingKey: '7002', matchedVia: 'tvdb' },
    ],
    scopedLibraryIds: [tvLib, hiddenLib],
  });
  await setRoleLibraries({ db: t.db, roleId: SEEDED_ROLE_IDS.default, libraryIds: [tvLib], actorId: null });
  await syncSeerrIssues({
    db: t.db,
    seerr: {
      listAllIssues: async () => [
        {
          id: 3,
          issueType: 1,
          status: 1,
          problemSeason: 2,
          problemEpisode: 6,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          media: { mediaType: 'tv', tvdbId: 449872 },
          createdBy: { id: 11, email: 'MIA@example.com', displayName: 'Plex Mia' },
          comments: [{ id: 1, message: 'Missing episode 6', createdAt: '2026-10-01T00:00:00.000Z' }],
        },
      ],
    },
  });
});

afterAll(async () => {
  await t.stop();
});

describe('seerrIssues.forItem (D-10)', () => {
  it('a member who can see the title gets its report, marked as theirs, without the reporter name', async () => {
    const issues = await memberCaller.seerrIssues.forItem({ mediaItemId: showId });
    expect(issues).toMatchObject([
      { seerrIssueId: 3, issueType: 1, targetLabel: 'S02E06', message: 'Missing episode 6', viewerIsReporter: true, reporterName: null },
    ]);
  });

  it('an admin sees who reported it', async () => {
    const issues = await adminCaller.seerrIssues.forItem({ mediaItemId: showId });
    expect(issues[0]).toMatchObject({ viewerIsReporter: false, reporterName: 'Plex Mia' });
  });

  it('a title the caller cannot see is NOT_FOUND', async () => {
    await expect(
      memberCaller.seerrIssues.forItem({ mediaItemId: hiddenId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      memberCaller.seerrIssues.forItem({ mediaItemId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('seerrIssues admin surface (D-12)', () => {
  it('is admin-only', async () => {
    await expect(memberCaller.seerrIssues.adminList({ filter: 'all' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      memberCaller.seerrIssues.setStaffNote({ seerrIssueId: 3, note: 'x', fixedByHand: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a fixed-by-hand mark with no note at the edge, and an unknown issue', async () => {
    await expect(
      adminCaller.seerrIssues.setStaffNote({ seerrIssueId: 3, note: '  ', fixedByHand: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      adminCaller.seerrIssues.setStaffNote({ seerrIssueId: 404, note: 'x', fixedByHand: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('marks it fixed by hand with an audit row, and the list shows the note and the title', async () => {
    const res = await adminCaller.seerrIssues.setStaffNote({
      seerrIssueId: 3,
      note: 'Imported by hand. Missing: Force Search could not import a download named as a range.',
      fixedByHand: true,
    });
    expect(res.fixedByHand).toBe(true);
    const audit = await auditRows(t.db, 'update_seerr_issue_note');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(admin.id);
    const list = await adminCaller.seerrIssues.adminList({ filter: 'all' });
    expect(list.nextCursor).toBeNull();
    expect(list.items[0]).toMatchObject({
      seerrIssueId: 3,
      item: { id: showId, title: 'The Paper (2025)' },
      reporterName: 'Plex Mia',
      reporterAccount: { id: member.id, displayName: 'Member Mia' },
      staff: { fixedByHand: true, byName: 'Admin Ada' },
      linkedRepairs: [],
    });
  });
});
