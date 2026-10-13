// DESIGN-055 P7 decision 11. CPU budget: one affected file, one worker, nice -n 19; no wide suites or load loops.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mediaItems,
  permissionAudit,
  repairRequests,
  seerrIssueWrites,
  seerrIssues,
} from '@hnet/db';
import { type SeerrIssue, SEERR_PERMISSION_MANAGE_ISSUES } from '@hnet/arr';
import {
  getAppSetting,
  runSeerrIssueBridgeSmoke,
  seerrBridgeSmokeFixtureProblem,
  setSeerrIssueBridge,
  upsertMediaItemsBatch,
  type SeerrBridgeSmokeClients,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

function fakeSeerr() {
  const state = {
    issues: [] as SeerrIssue[],
    calls: [] as Array<{ op: string; id: number; user: number; message?: string }>,
    history: [] as SeerrIssue[],
    createFailure: null as null | 'before' | 'after',
    deleteFailure: null as null | 'before' | 'after',
    movieId: 10974,
    movieTitle: 'The Canterville Ghost',
    hideFixture: false,
    beforeCreate: null as null | (() => Promise<void>),
  };
  const find = (id: number) => state.issues.find((i) => i.id === id) ?? null;
  const clients: SeerrBridgeSmokeClients = {
    read: {
      getUser: async (id) => ({ id, permissions: SEERR_PERMISSION_MANAGE_ISSUES, userType: 2 }),
      getMovieIssueTarget: async () => ({
        title: state.movieTitle,
        mediaInfo: { id: state.movieId, tmdbId: 65465 },
      }),
      listAllIssues: async () => structuredClone(state.hideFixture ? [] : state.issues),
      getIssue: async (id) => structuredClone(find(id)),
    },
    write: {
      createIssue: async (mediaId, message, user) => {
        state.calls.push({ op: 'create', id: mediaId, user, message });
        await state.beforeCreate?.();
        if (state.createFailure === 'before') throw new Error('refused before storing');
        const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
        const issue: SeerrIssue = {
          id: 5,
          issueType: 4,
          status: 1,
          problemSeason: 0,
          problemEpisode: 0,
          createdAt: now,
          updatedAt: now,
          media: { id: mediaId, mediaType: 'movie', tmdbId: 65465 },
          createdBy: { id: user },
          comments: [{ id: 1, message, createdAt: now, user: { id: user } }],
        };
        state.issues.push(issue);
        if (state.createFailure === 'after') throw new Error('answer lost after storing');
        return structuredClone(issue);
      },
      commentOnIssue: async (id, message, user) => {
        state.calls.push({ op: 'comment', id, user, message });
        const issue = find(id)!;
        issue.comments!.push({
          id: issue.comments!.length + 1,
          message,
          createdAt: new Date().toISOString(),
          user: { id: user },
        });
        return structuredClone(issue);
      },
      resolveIssue: async (id, user) => {
        state.calls.push({ op: 'resolve', id, user });
        find(id)!.status = 2;
        return structuredClone(find(id)!);
      },
      deleteIssue: async (id, user) => {
        state.calls.push({ op: 'delete', id, user });
        if (state.deleteFailure === 'before') throw new Error('delete refused');
        state.history.push(structuredClone(find(id)!));
        state.issues = state.issues.filter((i) => i.id !== id);
        if (state.deleteFailure === 'after') throw new Error('delete answer lost');
      },
    },
  };
  return { state, clients };
}

describe('the bounded staff Seerr bridge smoke', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 199,
          tmdbId: 65465,
          title: 'The Canterville Ghost',
          sortTitle: 'canterville ghost',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
          onDiskFileCount: 1,
        },
      ],
    });
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(async () => {
    await t.pool.query(
      'TRUNCATE seerr_issue_writes, seerr_issues, repair_requests, permission_audit, ledger_events, app_settings CASCADE',
    );
    await setSeerrIssueBridge({
      db: t.db,
      actorId: null,
      value: { bridgeUserId: 19, comment: true, resolve: true },
      now: new Date(Date.now() - 60_000),
    });
  });
  const run = (server: ReturnType<typeof fakeSeerr>, cleanupOnly = false) =>
    runSeerrIssueBridgeSmoke({
      db: t.db,
      clients: server.clients,
      linkOrigin: 'https://haynesnetwork.com',
      cleanupOnly,
    });

  it('posts one exact invitation, keeps the exact repair link, refuses to resolve pending, resolves completed once and deletes only its fixture', async () => {
    const server = fakeSeerr();
    const report = await run(server);
    expect(report).toMatchObject({
      issueId: 5,
      invitationVerified: true,
      pendingVerified: true,
      resolveVerified: true,
      deleted: true,
    });
    expect(server.state.calls.map((c) => c.op)).toEqual([
      'create',
      'comment',
      'comment',
      'resolve',
      'delete',
    ]);
    expect(server.state.calls.every((c) => c.user === 19)).toBe(true);
    expect(server.state.calls.every((c) => c.op === 'create' || c.id > 4)).toBe(true);
    const invitation = server.state.calls.find((c) =>
      c.message?.startsWith('Thanks for the report.'),
    )!;
    expect(invitation.message).toContain('/r/seerr/5');
    expect(
      server.state.history[0]!.comments!.filter((c) => c.message === invitation.message),
    ).toHaveLength(1);
    const repair = await t.db.query.repairRequests.findFirst({
      where: eq(repairRequests.id, report.repairRequestId!),
    });
    expect(repair).toMatchObject({
      seerrIssueId: 5,
      status: 'completed',
      preview: { staffSmoke: true, simulated: true, noLibraryWrites: true },
    });
    expect(repair!.actionsTaken.at(-1)).toMatchObject({
      step: 'staff_smoke_simulated_completion',
      simulated: true,
      noLibraryWrites: true,
    });
    expect(
      (await t.db.query.seerrIssues.findFirst({ where: eq(seerrIssues.seerrIssueId, 5) }))!
        .removedAt,
    ).not.toBeNull();
    const audit = await t.db.select().from(permissionAudit);
    expect(
      audit.filter((a) => (a.detail as { key?: string })?.key === 'seerr_issue_bridge_smoke')
        .length,
    ).toBeGreaterThan(6);
    expect(
      (await t.db.select().from(seerrIssueWrites)).map((w) => [w.kind, w.state, w.attempts]),
    ).toEqual([
      ['comment', 'done', 1],
      ['resolve', 'done', 1],
    ]);
    await run(server);
    expect(server.state.calls).toHaveLength(5); // rerunning does not create another fixture
  });

  it('adopts an ambiguous create by its unique marker without a second POST', async () => {
    const server = fakeSeerr();
    server.state.createFailure = 'after';
    expect((await run(server)).deleted).toBe(true);
    expect(server.state.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('never retries an ambiguous absent create; cleanup can finish its saved intent without touching any issue', async () => {
    const server = fakeSeerr();
    server.state.createFailure = 'before';
    await expect(run(server)).rejects.toThrow(/unknown outcome/);
    server.state.createFailure = null;
    await expect(run(server)).rejects.toThrow(/no new create/);
    expect(server.state.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(await run(server, true)).toMatchObject({ issueId: null, deleted: true });
    expect(server.state.calls).toHaveLength(1);
  });

  it('rejects duplicate marker adoption instead of creating or deleting either issue', async () => {
    const server = fakeSeerr();
    server.state.createFailure = 'after';
    server.state.hideFixture = true;
    await expect(run(server)).rejects.toThrow(/unknown outcome/);
    server.state.hideFixture = false;
    server.state.issues.push({ ...structuredClone(server.state.issues[0]!), id: 6 });
    await expect(run(server, true)).rejects.toThrow(/more than one issue/);
    expect(server.state.calls).toHaveLength(1);
  });

  it('serializes concurrent staff invocations before the non-idempotent create', async () => {
    const server = fakeSeerr();
    let entered!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.state.beforeCreate = async () => {
      entered();
      await gate;
    };
    const first = run(server);
    await started;
    try {
      await expect(run(server)).rejects.toThrow(/another staff run/);
    } finally {
      release();
    }
    await first;
    expect(server.state.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('checks the exact title before any create and rejects old ids, other media, another reporter and a changed initial report', async () => {
    const server = fakeSeerr();
    server.state.movieTitle = 'Another movie';
    await expect(run(server)).rejects.toThrow(/not The Canterville Ghost/);
    expect(server.state.calls).toHaveLength(0);
    server.state.movieTitle = 'The Canterville Ghost';
    server.state.deleteFailure = 'before';
    await expect(run(server)).rejects.toThrow(/delete refused/);
    const state = (await getAppSetting(t.db, 'seerr_issue_bridge_smoke'))!;
    const fixture = structuredClone(server.state.issues[0]!);
    expect(seerrBridgeSmokeFixtureProblem({ ...fixture, id: 4 }, state)).toMatch(/protected/);
    expect(
      seerrBridgeSmokeFixtureProblem({ ...fixture, media: { ...fixture.media, id: 1780 } }, state),
    ).toMatch(/another title/);
    expect(seerrBridgeSmokeFixtureProblem({ ...fixture, createdBy: { id: 1 } }, state)).toMatch(
      /another reporter/,
    );
    server.state.issues[0]!.comments![0]!.message = 'A real person reported this';
    await expect(run(server, true)).rejects.toThrow(/marked staff report/);
    expect(server.state.calls.filter((c) => c.op === 'delete')).toHaveLength(1);
    server.state.issues[0] = fixture;
    server.state.deleteFailure = null;
    expect((await run(server, true)).deleted).toBe(true);
  });

  it('adopts a lost delete answer and tombstones the mirror without a second DELETE', async () => {
    const server = fakeSeerr();
    server.state.deleteFailure = 'after';
    await expect(run(server)).rejects.toThrow(/delete answer lost/);
    expect((await run(server, true)).deleted).toBe(true);
    expect(server.state.calls.filter((c) => c.op === 'delete')).toHaveLength(1);
    expect(
      (await t.db.query.seerrIssues.findFirst({ where: eq(seerrIssues.seerrIssueId, 5) }))!
        .removedAt,
    ).not.toBeNull();
  });

  it('has no cleanup surface for an arbitrary existing issue and does not mutate media metadata', async () => {
    const server = fakeSeerr();
    const before = await t.db.select().from(mediaItems);
    expect(await run(server, true)).toMatchObject({ issueId: null, deleted: true });
    expect(server.state.calls).toEqual([]);
    await run(server);
    expect(await t.db.select().from(mediaItems)).toEqual(before);
  });
});
