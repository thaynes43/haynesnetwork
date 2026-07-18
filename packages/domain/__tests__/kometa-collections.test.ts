// ADR-072 / DESIGN-042 D-07/D-10 (PLAN-052 PR4b) — the Kometa collections orchestrator + auto-merge policy.
// Proves: the D-10 four-condition auto-merge matrix (each condition blocks in isolation → human path); the
// safe direct add AUTO-MERGES + writes a same-tx `upsert_collection` audit; a non-admin with an
// unresolvable size is refused (routes to the ticket); materialize NEVER auto-merges (human); delete
// removes the recipe; the overview reconciles live/pending_run against the mirror and degrades honestly.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  permissionAudit,
  plexCollections,
  plexLibraries,
  SEEDED_PLEX_SERVER_IDS,
} from '@hnet/db';
import { HaynesopsUnreachableError } from '@hnet/haynesops';
import {
  CollectionSizeCapError,
  compileManagedFile,
  deleteKometaRecipe,
  evaluateKometaAutoMerge,
  getKometaCollectionsOverview,
  materializeKometaCollection,
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
  checks?: 'success' | 'failure' | 'pending' | 'none';
  prFiles?: string[];
  unreachable?: boolean;
  openPrs?: Array<{ number: number; title: string; url: string; headBranch: string; headSha: string }>;
}) {
  const opened: Array<{ path: string; content: string; title: string }> = [];
  const merged: number[] = [];
  let n = 100;
  const throwIfDown = () => {
    if (opts?.unreachable) throw new HaynesopsUnreachableError('GET', '/x');
  };
  const bundle = {
    configDir: CONFIG_DIR,
    baseBranch: 'main',
    read: {
      getFile: async () => {
        throwIfDown();
        return opts?.file != null ? { text: opts.file, sha: 'sha1' } : null;
      },
      listOpenManagedPrs: async () => {
        throwIfDown();
        return opts?.openPrs ?? [];
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
      waitForChecks: async () => opts?.checks ?? 'success',
      squashMergePr: async (num: number) => void merged.push(num),
    },
  } as unknown as Parameters<typeof upsertKometaCollection>[0]['haynesops'];
  return { bundle, opened, merged };
}

const recipe = (over?: Partial<KometaRecipe>): KometaRecipe => ({
  id: 'christmas',
  name: 'Christmas HNet',
  mediaType: 'movies',
  builderType: 'tmdb_movie',
  builderRef: '1, 2, 3',
  findMissing: false,
  ...over,
});

describe('evaluateKometaAutoMerge — the D-10 four-condition matrix', () => {
  const green = {
    capAsserted: true,
    isMaterialization: false,
    findMissing: false,
    managedFileOnly: true,
    checksGreen: true,
  };
  it('auto-merges only when all four hold', () => {
    expect(evaluateKometaAutoMerge(green).autoMerge).toBe(true);
  });
  it('each condition blocks in isolation', () => {
    expect(evaluateKometaAutoMerge({ ...green, capAsserted: false }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...green, isMaterialization: true }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...green, findMissing: true }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...green, managedFileOnly: false }).autoMerge).toBe(false);
    expect(evaluateKometaAutoMerge({ ...green, checksGreen: false }).autoMerge).toBe(false);
  });
});

describe('upsertKometaCollection — direct add + auto-merge (D-07/D-10)', () => {
  it('auto-merges the safe case and writes a same-tx upsert_collection audit', async () => {
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
    expect(hs.merged).toEqual([res.prNumber]);
    expect(hs.opened[0]!.content).toContain('radarr_add_missing: false');
    const audit = await t.db.select().from(permissionAudit).where(eq(permissionAudit.actorId, user.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('upsert_collection');
    expect((audit[0]!.detail as { provider: string; merged: boolean }).provider).toBe('kometa');
    expect((audit[0]!.detail as { merged: boolean }).merged).toBe(true);
  });

  it('leaves the PR for a human when the CI gate is not green', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'failure' });
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
    expect(hs.merged).toEqual([]);
    expect(res.autoMergeBlockedReason).toMatch(/gate/i);
  });

  it('leaves the PR for a human when the diff touches a file outside the managed include', async () => {
    const user = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success', prFiles: [`${CONFIG_DIR}/movies-charts.yml`] });
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
    const start = compileManagedFile({ mediaType: 'movies', recipes: [recipe(), recipe({ id: 'keep', name: 'Keep' })] });
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

describe('getKometaCollectionsOverview — reconcile + honest degrade (D-07)', () => {
  async function seedProducedCollection(title: string) {
    const [lib] = await t.db
      .insert(plexLibraries)
      .values({ serverId: SEEDED_PLEX_SERVER_IDS.haynesops, sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' })
      .returning();
    await t.db
      .insert(plexCollections)
      .values({ plexLibraryId: lib!.id, ratingKey: '900', title, childCount: 12, createdBy: 'kometa' });
  }

  it('reconciles a recipe to live when its produced collection is mirrored, else pending_run', async () => {
    await seedProducedCollection('Christmas HNet');
    const file = compileManagedFile({
      mediaType: 'movies',
      recipes: [recipe(), recipe({ id: 'other', name: 'Not Built Yet' })],
    });
    const hs = stubHaynesops({ file, openPrs: [{ number: 7, title: 'materialize Big', url: 'https://gh/pull/7', headBranch: 'b', headSha: 'h' }] });
    const overview = await getKometaCollectionsOverview({ db: t.db, haynesops: hs.bundle, mediaType: 'movies' });
    expect(overview.reachable).toBe(true);
    const byId = new Map(overview.recipes.map((r) => [r.id, r.state]));
    expect(byId.get('christmas')).toBe('live');
    expect(byId.get('other')).toBe('pending_run');
    expect(overview.pendingPrs).toHaveLength(1);
    expect(overview.collections.map((c) => c.title)).toContain('Christmas HNet');
  });

  it('degrades to reachable:false when haynes-ops is unreachable', async () => {
    const hs = stubHaynesops({ unreachable: true });
    const overview = await getKometaCollectionsOverview({ db: t.db, haynesops: hs.bundle, mediaType: 'movies' });
    expect(overview.reachable).toBe(false);
    expect(overview.recipes).toEqual([]);
  });
});
