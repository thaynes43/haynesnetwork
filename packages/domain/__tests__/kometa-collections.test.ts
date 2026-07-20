// ADR-072 / DESIGN-042 D-07/D-10 (PLAN-052 PR4b) — the Kometa collections orchestrator + auto-merge policy.
// Proves: the D-10 four-condition auto-merge matrix (each condition blocks in isolation → human path); the
// safe direct add AUTO-MERGES + writes a same-tx `upsert_collection` audit; a non-admin with an
// unresolvable size is refused (routes to the ticket); materialize NEVER auto-merges (human); delete
// removes the recipe; the overview reconciles live/pending_run against the mirror and degrades honestly.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, plexCollections, plexLibraries, SEEDED_PLEX_SERVER_IDS } from '@hnet/db';
import { HaynesopsUnreachableError } from '@hnet/haynesops';
import {
  CollectionSizeCapError,
  compileManagedFile,
  deleteKometaRecipe,
  evaluateKometaAutoMerge,
  getKometaCollectionsOverview,
  materializeKometaCollection,
  NotFoundError,
  setKometaFindMissing,
  upsertKometaCollection,
  type KometaRecipe,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(permissionAudit);
  await t.db.delete(plexCollections);
  await t.db.delete(plexLibraries);
});

const CONFIG_DIR = 'kubernetes/main/apps/media/kometa/app/config';

/** A recording haynes-ops git-write stub bundle. Records the PRs opened + merged and the content written. */
function stubHaynesops(opts?: {
  file?: string | null;
  /** The gate conclusion the REQUEST-path check yields (getChecksConclusion). Default 'success'. */
  checks?: 'success' | 'failure' | 'pending' | 'none';
  /** The gate conclusion the DEFERRED wait yields (waitForChecks). Default = `checks` (settled at request). */
  deferredChecks?: 'success' | 'failure' | 'pending' | 'none';
  prFiles?: string[];
  unreachable?: boolean;
  /** When true, squashMergePr throws (proves the deferred merge degrades honestly — PR left open). */
  mergeThrows?: boolean;
  openPrs?: Array<{
    number: number;
    title: string;
    url: string;
    headBranch: string;
    headSha: string;
  }>;
}) {
  const opened: Array<{ path: string; content: string; title: string }> = [];
  const merged: number[] = [];
  let waitForChecksCalls = 0;
  let n = 100;
  const throwIfDown = () => {
    if (opts?.unreachable) throw new HaynesopsUnreachableError('GET', '/x');
  };
  const bundle = {
    configDir: CONFIG_DIR,
    baseBranch: 'main',
    kometaCheckName: 'Kometa Validate Managed Files - Success',
    read: {
      getFile: async () => {
        throwIfDown();
        return opts?.file != null ? { text: opts.file, sha: 'sha1' } : null;
      },
      listOpenManagedPrs: async () => {
        throwIfDown();
        return opts?.openPrs ?? [];
      },
      listDirectory: async () => {
        throwIfDown();
        return [];
      },
      getChecksConclusion: async () => opts?.checks ?? 'success',
    },
    write: {
      getFile: async () => (opts?.file != null ? { text: opts.file, sha: 'sha1' } : null),
      openManagedFilePr: async (input: { path: string; content: string; title: string }) => {
        n += 1;
        opened.push({ path: input.path, content: input.content, title: input.title });
        return { number: n, url: `https://gh/pull/${n}`, headBranch: `b${n}`, headSha: `h${n}` };
      },
      getPrFilePaths: async () => opts?.prFiles ?? [`${CONFIG_DIR}/hnet-managed-movies.yml`],
      waitForChecks: async () => {
        waitForChecksCalls += 1;
        return opts?.deferredChecks ?? opts?.checks ?? 'success';
      },
      squashMergePr: async (num: number) => {
        if (opts?.mergeThrows) throw new Error('merge conflict');
        merged.push(num);
      },
    },
  } as unknown as Parameters<typeof upsertKometaCollection>[0]['haynesops'];
  return { bundle, opened, merged, waitForChecksCalls: () => waitForChecksCalls };
}

/**
 * A capturing scheduler for the DEFERRED auto-merge: the request path hands its background task here instead
 * of firing it, so a test runs it deterministically (and asserts it was NOT run when it shouldn't be).
 */
function captureScheduler() {
  const tasks: Array<() => Promise<void>> = [];
  return {
    schedule: (task: () => Promise<void>) => void tasks.push(task),
    count: () => tasks.length,
    runAll: async () => {
      for (const task of tasks) await task();
    },
  };
}

/** The 1-attempt / fake-sleep poll knobs every deferred-path test injects (never a real 15s wait). */
const FAST_POLL = { attempts: 1, sleepImpl: async () => {} };

const recipe = (over?: Partial<KometaRecipe>): KometaRecipe => ({
  id: 'christmas',
  name: 'Christmas HNet',
  mediaType: 'movies',
  builderType: 'tmdb_movie',
  builderRef: '1, 2, 3',
  findMissing: false,
  ...over,
});

describe('evaluateKometaAutoMerge — the D-10 eligibility matrix (compile/PR-time conditions)', () => {
  // The runtime CI gate is NOT part of this pure decision (2026-07-20): it is enforced separately by the
  // scoped, named checks conclusion once a PR is eligible. This policy proves ONLY "is this the kind of write
  // we auto-merge?" over the three compile/PR-time conditions.
  const eligible = {
    capAsserted: true,
    isMaterialization: false,
    findMissing: false,
    managedFileOnly: true,
  };
  it('is eligible to arm only when all three compile/PR-time conditions hold', () => {
    expect(evaluateKometaAutoMerge(eligible).autoMerge).toBe(true);
  });
  it('each condition independently prevents arming', () => {
    expect(evaluateKometaAutoMerge({ ...eligible, capAsserted: false }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...eligible, isMaterialization: true }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...eligible, findMissing: true }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...eligible, managedFileOnly: false }).autoMerge).toBe(false);
  });
});

describe('upsertKometaCollection — direct add + auto-merge (D-07/D-10)', () => {
  it('merges in-request when the validate gate is already green + writes a same-tx audit', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(true);
    expect(res.autoMergeArmed).toBe(false);
    expect(hs.merged).toEqual([res.prNumber]);
    // The request path NEVER runs the long deferred poll when the gate is already settled (fast return).
    expect(hs.waitForChecksCalls()).toBe(0);
    expect(hs.opened[0]!.content).toContain('radarr_add_missing: false');
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.actorId, user.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('upsert_collection');
    expect((audit[0]!.detail as { provider: string; merged: boolean }).provider).toBe('kometa');
    expect((audit[0]!.detail as { merged: boolean }).merged).toBe(true);
    expect((audit[0]!.detail as { auto_merge_armed: boolean }).auto_merge_armed).toBe(false);
  });

  it('ARMS the deferred merge (no in-request poll) when the gate has not settled; the task merges when green', async () => {
    const user = await createUser(t.db);
    // Gate not reported yet at request time; it goes green by the time the deferred wait runs.
    const hs = stubHaynesops({ file: null, checks: 'pending', deferredChecks: 'success' });
    const sched = captureScheduler();
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
      scheduleAutoMerge: sched.schedule,
      checkPoll: FAST_POLL,
    });
    // Returns immediately: armed, NOT merged yet, and the deferred task is queued (not run).
    expect(res.merged).toBe(false);
    expect(res.autoMergeArmed).toBe(true);
    expect(res.autoMergeBlockedReason).toBeNull();
    expect(hs.merged).toEqual([]);
    expect(sched.count()).toBe(1);
    expect(hs.waitForChecksCalls()).toBe(0);
    // The audit is written at request time recording the ARMED state (merged still false).
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.actorId, user.id));
    expect((audit[0]!.detail as { auto_merge_armed: boolean }).auto_merge_armed).toBe(true);
    expect((audit[0]!.detail as { merged: boolean }).merged).toBe(false);
    // Running the deferred task waits the named gate green, then squash-merges.
    await sched.runAll();
    expect(hs.waitForChecksCalls()).toBe(1);
    expect(hs.merged).toEqual([res.prNumber]);
  });

  it('the deferred task does NOT merge when the gate ends red (honest degrade — PR left for a human)', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'pending', deferredChecks: 'failure' });
    const sched = captureScheduler();
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
      scheduleAutoMerge: sched.schedule,
      checkPoll: FAST_POLL,
    });
    expect(res.autoMergeArmed).toBe(true);
    await sched.runAll();
    expect(hs.merged).toEqual([]); // gate failed → never merged
  });

  it('the deferred task swallows a merge error (honest degrade — never throws to the request path)', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({
      file: null,
      checks: 'pending',
      deferredChecks: 'success',
      mergeThrows: true,
    });
    const sched = captureScheduler();
    await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
      scheduleAutoMerge: sched.schedule,
      checkPoll: FAST_POLL,
    });
    await expect(sched.runAll()).resolves.toBeUndefined(); // the merge threw, but the task self-catches
    expect(hs.merged).toEqual([]);
  });

  it('leaves the PR for a human (never arms) when the CI gate is already red at request time', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'failure' });
    const sched = captureScheduler();
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
      scheduleAutoMerge: sched.schedule,
    });
    expect(res.merged).toBe(false);
    expect(res.autoMergeArmed).toBe(false);
    expect(sched.count()).toBe(0); // a red gate is never armed
    expect(hs.merged).toEqual([]);
    expect(res.autoMergeBlockedReason).toMatch(/gate/i);
  });

  it('leaves the PR for a human when the diff touches a file outside the managed include', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({
      file: null,
      checks: 'success',
      prFiles: [`${CONFIG_DIR}/movies-charts.yml`],
    });
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe(),
      size: 3,
      cap: 25,
      isAdmin: false,
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(false);
    expect(res.autoMergeBlockedReason).toMatch(/outside the managed include/i);
  });

  it('a non-admin whose size is unresolvable (a URL builder) is refused (routes to the ticket)', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null });
    await expect(
      upsertKometaCollection({
        db: t.db,
        haynesops: hs.bundle,
        actorId: user.id,
        recipe: recipe({ builderType: 'imdb_list', builderRef: 'https://www.imdb.com/list/ls1/' }),
        size: null,
        cap: 25,
        isAdmin: false,
      }),
    ).rejects.toBeInstanceOf(CollectionSizeCapError);
    expect(hs.opened).toHaveLength(0);
  });

  it('an admin with an unresolvable size still adds (bypass) and auto-merges', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const res = await upsertKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe({ builderType: 'imdb_list', builderRef: 'https://www.imdb.com/list/ls1/' }),
      size: null,
      cap: 25,
      isAdmin: true,
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(true);
  });
});

describe('materializeKometaCollection — over-cap, human-merged (D-07 case 3 / D-10)', () => {
  it('opens a PR but NEVER auto-merges', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const res = await materializeKometaCollection({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      recipe: recipe({ builderType: 'imdb_list', builderRef: 'https://www.imdb.com/list/ls1/' }),
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(false);
    expect(hs.merged).toEqual([]);
    expect(res.autoMergeBlockedReason).toMatch(/materialization/i);
  });
});

describe('deleteKometaRecipe — removes the recipe from the managed include (D-03)', () => {
  it('recompiles without the recipe (the orphan is intentional)', async () => {
    const user = await createUser(t.db);
    const start = compileManagedFile({
      mediaType: 'movies',
      recipes: [recipe(), recipe({ id: 'keep', name: 'Keep' })],
    });
    const hs = stubHaynesops({ file: start, checks: 'success' });
    const res = await deleteKometaRecipe({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      id: 'christmas',
      mediaType: 'movies',
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(true);
    expect(hs.opened[0]!.content).not.toContain('Christmas HNet');
    expect(hs.opened[0]!.content).toContain('Keep');
  });
});

describe('setKometaFindMissing — the per-collection acquisition lever (PR4c / D-06/D-14)', () => {
  it('enabling flips findMissing on, emits radarr_add_missing: true, and NEVER auto-merges (human)', async () => {
    const user = await createUser(t.db);
    const start = compileManagedFile({ mediaType: 'movies', recipes: [recipe()] });
    const hs = stubHaynesops({ file: start, checks: 'success' });
    const res = await setKometaFindMissing({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      id: 'christmas',
      mediaType: 'movies',
      on: true,
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(false); // acquisition lever is always human-merged (D-10)
    expect(hs.merged).toEqual([]);
    expect(res.autoMergeBlockedReason).toMatch(/find-missing/i);
    expect(hs.opened[0]!.content).toContain('radarr_add_missing: true');
    expect(hs.opened[0]!.content).toContain('radarr_search: true');
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.actorId, user.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('upsert_collection');
    expect((audit[0]!.detail as { find_missing?: boolean }).find_missing).toBe(true);
  });

  it('disabling returns the recipe to grouping-only, which may auto-merge', async () => {
    const user = await createUser(t.db);
    const start = compileManagedFile({
      mediaType: 'movies',
      recipes: [recipe({ findMissing: true })],
    });
    const hs = stubHaynesops({ file: start, checks: 'success' });
    const res = await setKometaFindMissing({
      db: t.db,
      haynesops: hs.bundle,
      actorId: user.id,
      id: 'christmas',
      mediaType: 'movies',
      on: false,
      branchSuffix: 'x',
    });
    expect(res.merged).toBe(true);
    expect(hs.opened[0]!.content).toContain('radarr_add_missing: false');
  });

  it('a recipe not present in the managed include is a NotFound (never a fabricated write)', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success' });
    await expect(
      setKometaFindMissing({
        db: t.db,
        haynesops: hs.bundle,
        actorId: user.id,
        id: 'ghost',
        mediaType: 'movies',
        on: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(hs.opened).toHaveLength(0);
  });
});

describe('getKometaCollectionsOverview — reconcile + honest degrade (D-07)', () => {
  async function seedProducedCollection(title: string) {
    const [lib] = await t.db
      .insert(plexLibraries)
      .values({
        serverId: SEEDED_PLEX_SERVER_IDS.haynesops,
        sectionKey: '1',
        name: 'HOps Movies',
        mediaType: 'movie',
      })
      .returning();
    await t.db
      .insert(plexCollections)
      .values({
        plexLibraryId: lib!.id,
        ratingKey: '900',
        title,
        childCount: 12,
        createdBy: 'kometa',
      });
  }

  it('reconciles a recipe to live when its produced collection is mirrored, else pending_run', async () => {
    await seedProducedCollection('Christmas HNet');
    const file = compileManagedFile({
      mediaType: 'movies',
      recipes: [recipe(), recipe({ id: 'other', name: 'Not Built Yet' })],
    });
    const hs = stubHaynesops({
      file,
      openPrs: [
        {
          number: 7,
          title: 'materialize Big',
          url: 'https://gh/pull/7',
          headBranch: 'b',
          headSha: 'h',
        },
      ],
    });
    const overview = await getKometaCollectionsOverview({
      db: t.db,
      haynesops: hs.bundle,
      mediaType: 'movies',
    });
    expect(overview.reachable).toBe(true);
    const byId = new Map(overview.recipes.map((r) => [r.id, r.state]));
    expect(byId.get('christmas')).toBe('live');
    expect(byId.get('other')).toBe('pending_run');
    expect(overview.pendingPrs).toHaveLength(1);
    expect(overview.collections.map((c) => c.title)).toContain('Christmas HNet');
  });

  it('degrades to reachable:false when haynes-ops is unreachable', async () => {
    const hs = stubHaynesops({ unreachable: true });
    const overview = await getKometaCollectionsOverview({
      db: t.db,
      haynesops: hs.bundle,
      mediaType: 'movies',
    });
    expect(overview.reachable).toBe(false);
    expect(overview.recipes).toEqual([]);
  });
});
