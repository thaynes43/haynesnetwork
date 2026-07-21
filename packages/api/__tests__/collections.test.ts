// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router gates, INCLUDING the FORBIDDEN
// paths the plan calls out: everyone reads + adds/edits within the cap (no grant, no section floor); an
// over-cap non-admin routes to the ticket (never a silent truncation); a non-admin CANNOT delete, approve,
// decline, read all tickets, or touch settings (FORBIDDEN); an admin bypasses the cap and does all of it.
// The confined Libretto client is stubbed in ctx (ADR-010 — no live-API tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  notificationOutbox,
  permissionAudit,
  plexLibraries,
  SEEDED_PLEX_SERVER_IDS,
  SEEDED_ROLE_IDS,
  ticketEvents,
  tickets,
  type CollectionOverridePayload,
} from '@hnet/db';
import { syncBooksCollections, syncPlexCollections, upsertPlexLibraries } from '@hnet/domain';
import {
  compileManagedFile,
  setRoleBookActions,
  setRoleCollectionActions,
  type LibrettoClientBundle,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  wireShape,
  type TestDb,
} from './helpers';
import { stubArrBundle } from './arr-stubs';
import type { TRPCContext } from '../src/trpc';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

/**
 * A recording Libretto stub bundle injected into ctx. `workCount` is what `validateRecipe` resolves the
 * draft to — the preview the size-cap guard reads (D-03/D-10). Defaults to 3 (well within the cap).
 */
function stubLibretto(workCount = 3): {
  ctx: Partial<TRPCContext>;
  recipes: Array<Record<string, unknown>>;
  deleted: string[];
} {
  const recipes: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const libretto = {
    read: {
      listRecipes: async () => ({ recipes, issues: [] }),
      listCollections: async () => [],
      validateRecipe: async () => ({ ok: true, issues: [], resolved: { name: 'X', workCount } }),
      getRun: async () => ({ id: 'run-1', status: 'ok', counts: { matched: 3 } }),
    },
    write: {
      upsertRecipe: async (d: Record<string, unknown>) => void recipes.push(d),
      deleteRecipe: async (id: string) => void deleted.push(id),
      applyScope: async () => 'run-9',
    },
  } as unknown as LibrettoClientBundle;
  return { ctx: { libretto }, recipes, deleted };
}

const draftInput = (over?: Record<string, unknown>) => ({
  id: 'dune',
  builderType: 'static_ids' as const,
  builderRef: 'x',
  mediaType: 'books' as const,
  ...over,
});

/**
 * A recording haynes-ops git-write stub bundle injected into ctx (ADR-072 / DESIGN-042 PR4b). `file` is the
 * managed include the read returns; `checks` is the CI conclusion `waitForChecks` yields (default success
 * ⇒ auto-merge for the safe case). Records opened + merged PRs so the auto-merge matrix is assertable.
 */
function stubHaynesops(opts?: {
  file?: string | null;
  checks?: 'success' | 'failure' | 'pending' | 'none';
  prFiles?: string[];
  /** Hand-authored config files by basename → text (owner ruling 2026-07-18 — edit the estate's config). */
  handFiles?: Record<string, string>;
}): {
  ctx: Partial<TRPCContext>;
  opened: Array<Record<string, unknown>>;
  merged: number[];
} {
  const opened: Array<Record<string, unknown>> = [];
  const merged: number[] = [];
  let n = 100;
  const configDir = 'kubernetes/main/apps/media/kometa/app/config';
  const hand = opts?.handFiles ?? {};
  const getFile = async (path: string) => {
    for (const [name, text] of Object.entries(hand)) {
      if (path === `${configDir}/${name}`) return { text, sha: `sha-${name}` };
    }
    return opts?.file != null ? { text: opts.file, sha: 'sha1' } : null;
  };
  const haynesops = {
    configDir,
    baseBranch: 'main',
    kometaCheckName: 'Kometa Validate Managed Files - Success',
    read: {
      getFile,
      listOpenManagedPrs: async () => [],
      listDirectory: async () => Object.keys(hand),
      getChecksConclusion: async () => opts?.checks ?? 'success',
    },
    write: {
      getFile,
      openManagedFilePr: async (input: Record<string, unknown>) => {
        n += 1;
        opened.push(input);
        return {
          number: n,
          url: `https://github.com/x/y/pull/${n}`,
          headBranch: `b${n}`,
          headSha: `head${n}`,
        };
      },
      getPrFilePaths: async () => opts?.prFiles ?? [`${configDir}/hnet-managed-movies.yml`],
      waitForChecks: async () => opts?.checks ?? 'success',
      squashMergePr: async (num: number) => void merged.push(num),
    },
  } as unknown as TRPCContext['haynesops'];
  return { ctx: { haynesops }, opened, merged };
}

describe('collections overview — everyone reads, no grant, no section floor (ADR-072)', () => {
  it('a plain member (no integrations section) reads the Books overview', async () => {
    const member = await createUser(t.db);
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx };
    const res = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(res.available).toBe(true);
    expect(res.reachable).toBe(true);
    expect(res.provider).toBe('libretto');
    expect(res.canFindMissing).toBe(false); // ungranted
    expect(res.capBypass).toBe(false);
  });

  it('wires a comics recipe mixed id/slug array ref to a joined display string (PR #11 shape)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    // A hardcover_comics recipe carries a MIXED number/string array; a numeric hardcover_series id is a scalar.
    stub.recipes.push({
      id: 'invincible-omni',
      name: 'Invincible Universe',
      builder: { type: 'hardcover_comics', ref: [14911, 'guarding-the-globe'] },
      enabled: true,
    });
    stub.recipes.push({
      id: 'goosebumps',
      name: 'Goosebumps',
      builder: { type: 'hardcover_series', ref: 508783 },
      enabled: true,
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const res = await caller(ctx).collections.overview({ mediaType: 'books' });
    // The array is joined for display (the id-list convention); the numeric scalar is stringified.
    expect(res.recipes.find((r) => r.id === 'invincible-omni')!.builderRef).toBe('14911, guarding-the-globe');
    expect(res.recipes.find((r) => r.id === 'goosebumps')!.builderRef).toBe('508783');
  });

  it('Movies/TV bind Kometa and read the managed include (available:true, provider kometa)', async () => {
    const member = await createUser(t.db);
    const ctx = {
      ...makeCtx(t.db, sessionUser(member)),
      ...stubLibretto().ctx,
      ...stubHaynesops({ file: null }).ctx,
    };
    const res = await caller(ctx).collections.overview({ mediaType: 'movies' });
    expect(res.available).toBe(true);
    expect(res.provider).toBe('kometa');
    expect(res.recipes).toEqual([]);
    expect(res.pendingPrs).toEqual([]);
  });

  it('mirror source is the media-type authority — an ABS-produced recipe lands on Audiobooks, not Books (D-09; the live dune-audiobooks miss)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    // A recipe whose produced collection Libretto's own read does NOT surface (listCollections
    // empty) — the targetKind heuristic alone would default it to Books. The mirror knows better.
    stub.recipes.push({
      id: 'dune-audiobooks',
      name: 'Dune',
      builder: { type: 'hardcover_series', ref: 'dune' },
      enabled: true,
    });
    // Seed through the SANCTIONED domain writer (never a direct insert — the
    // no-direct-state-writes guard forbids it, the books-collections.test.ts idiom).
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'audiobookshelf',
          externalId: 'abs-dune-1',
          kind: 'collection',
          libraryId: 'lib1',
          title: 'Dune',
          itemCount: 6,
          ordered: true,
          createdBy: 'libretto',
          librettoRecipeId: 'dune-audiobooks',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [{ source: 'audiobookshelf', kind: 'collection' }],
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    // ADR-075 C-01 — the manager's Books tab spans both formats now; 'audiobooks' stays accepted
    // as a legacy alias for the same merged tab, so the ABS-produced recipe lands on BOTH reads.
    const audiobooks = await caller(ctx).collections.overview({ mediaType: 'audiobooks' });
    expect(audiobooks.recipes.map((r) => r.id)).toContain('dune-audiobooks');
    const books = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(books.recipes.map((r) => r.id)).toContain('dune-audiobooks');
  });

  it('an ADMIN reads with capBypass + canFindMissing', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx };
    const res = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(res.capBypass).toBe(true);
    expect(res.canFindMissing).toBe(true);
  });
});

describe('direct upsert — capped, everyone, admin bypass (D-03/D-10)', () => {
  it('a plain member within the cap adds directly (recipe lands, acquisition OFF)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto(10);
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const res = await caller(ctx).collections.upsert(draftInput({ id: 'within' }));
    expect(res.ok).toBe(true);
    expect(stub.recipes).toHaveLength(1);
    expect((stub.recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(
      false,
    );
  });

  it('a non-admin OVER the cap is UNPROCESSABLE_CONTENT (appCode COLLECTION_SIZE_CAP_EXCEEDED); NO recipe lands', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto(30); // 30 > the default cap of 25
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const err = await caller(ctx)
      .collections.upsert(draftInput({ id: 'imdb-top-200' }))
      .then(
        () => {
          throw new Error('expected the over-cap upsert to reject');
        },
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect(wireShape(err, 'collections.upsert').data).toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      appCode: 'COLLECTION_SIZE_CAP_EXCEEDED',
    });
    expect(stub.recipes).toHaveLength(0);
  });

  it('a non-admin AT the cap (inclusive) adds fine', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto(25);
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const res = await caller(ctx).collections.upsert(draftInput({ id: 'at-cap' }));
    expect(res.ok).toBe(true);
    expect(stub.recipes).toHaveLength(1);
  });

  it('an ADMIN bypasses the cap — an over-cap draft adds (the LISTS exception)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto(500);
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.upsert(draftInput({ id: 'imdb-top-500' }));
    expect(res.ok).toBe(true);
    expect(stub.recipes).toHaveLength(1);
  });
});

describe('delete — ADMIN only (D-03)', () => {
  it('a non-admin CANNOT delete (FORBIDDEN)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    await expect(
      caller(ctx).collections.remove({ id: 'dune', mediaType: 'books' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(stub.deleted).toHaveLength(0);
  });

  it('an admin deletes the recipe', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.remove({
      id: 'dune',
      mediaType: 'books',
      deleteCollection: true,
    });
    expect(res.ok).toBe(true);
    expect(stub.deleted).toEqual(['dune']);
  });
});

describe('over-cap ticket — file / approve / decline (D-11)', () => {
  it('any member files a collection_override ticket carrying the full payload + creation event same-tx', async () => {
    const member = await createUser(t.db, { displayName: 'Over Requester' });
    const stub = stubLibretto(200);
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const { ticketId } = await caller(ctx).collections.requestOverride({
      id: 'imdb-top-200',
      name: 'IMDb Top 200',
      builderType: 'nyt_list',
      builderRef: 'top-200',
      mediaType: 'books',
    });
    expect(ticketId).toBeTruthy();

    const [ticket] = await t.db
      .select()
      .from(tickets)
      .where(sql`${tickets.id} = ${ticketId}`);
    expect(ticket!.category).toBe('collection_override');
    expect(ticket!.authorUserId).toBe(member.id);
    // The full requested definition rides the payload column (so Approve can materialize it).
    const payload = ticket!.collectionOverridePayload as CollectionOverridePayload;
    expect(payload.recipeId).toBe('imdb-top-200');
    expect(payload.size).toBe(200); // the SERVER-resolved size (never a client-sent number)
    expect(payload.mediaType).toBe('books');

    const events = await t.db
      .select()
      .from(ticketEvents)
      .where(sql`${ticketEvents.ticketId} = ${ticketId}`);
    expect(events).toHaveLength(1);
    const outbox = (
      await t.db
        .select()
        .from(notificationOutbox)
        .where(sql`${notificationOutbox.eventType} = 'ticket_created'`)
    ).filter((o) => (o.payload as { ticketId?: string }).ticketId === ticketId);
    expect(outbox.map((o) => o.channel).sort()).toEqual(['email', 'pushover']);
  });

  it('a non-admin CANNOT approve / decline / read all tickets (FORBIDDEN)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const uuid = '00000000-0000-0000-0000-000000000000';
    await expect(caller(ctx).collections.approveOverride({ ticketId: uuid })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      caller(ctx).collections.declineOverride({ ticketId: uuid, reason: 'no' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(ctx).collections.allTickets()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin approves → materializes the collection unbounded + completes the ticket', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto(200);
    const memberCtx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const { ticketId } = await caller(memberCtx).collections.requestOverride({
      id: 'big-list',
      name: 'Big List',
      builderType: 'nyt_list',
      builderRef: 'top-200',
      mediaType: 'books',
    });
    stub.recipes.length = 0; // ignore any preview side effects; assert on the materialize write only

    const adminCtx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(adminCtx).collections.approveOverride({ ticketId });
    expect(res.status).toBe('complete');
    expect(stub.recipes).toHaveLength(1);
    expect(stub.recipes[0]!.id).toBe('big-list');

    // The requester sees their own ticket as complete; the admin sees it in the all-tickets lens.
    const mine = await caller(memberCtx).collections.myTickets();
    expect(mine.tickets.find((x) => x.id === ticketId)?.status).toBe('complete');
    const all = await caller(adminCtx).collections.allTickets();
    expect(all.tickets.some((x) => x.id === ticketId)).toBe(true);
  });

  it('an admin declines → materializes nothing, ticket rejected', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto(200);
    const memberCtx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const { ticketId } = await caller(memberCtx).collections.requestOverride({
      id: 'nope-list',
      name: 'Nope',
      builderType: 'nyt_list',
      builderRef: 'top-200',
      mediaType: 'books',
    });
    stub.recipes.length = 0;
    const adminCtx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(adminCtx).collections.declineOverride({
      ticketId,
      reason: 'too large for now',
    });
    expect(res.status).toBe('rejected');
    expect(stub.recipes).toHaveLength(0);
  });
});

describe('settings — ADMIN only (D-10)', () => {
  it('a non-admin CANNOT read or set the cap (FORBIDDEN)', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member));
    await expect(caller(ctx).collections.settings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(ctx).collections.setSizeCap({ value: 50 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('an admin reads then sets the cap (audited setAppSetting)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx = makeCtx(t.db, sessionUser(admin));
    const before = await caller(ctx).collections.settings();
    expect(before.sizeCap).toBeGreaterThan(0);
    const res = await caller(ctx).collections.setSizeCap({ value: 42 });
    expect(res.sizeCap).toBe(42);
    const after = await caller(ctx).collections.settings();
    expect(after.sizeCap).toBe(42);
    // restore the default so other suites see the seeded cap
    await caller(ctx).collections.setSizeCap({ value: 25 });
  });
});

describe('Kometa (Movies/TV) write path — router wiring (ADR-072 / DESIGN-042 PR4b)', () => {
  it('a member adds a within-cap Movies collection through the compiler + auto-merge', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(ctx).collections.upsert(
      draftInput({
        id: 'unbreakable',
        name: 'Unbreakable',
        builderType: 'tmdb_movie',
        builderRef: '9741, 358',
        mediaType: 'movies',
      }),
    );
    expect(res.ok).toBe(true);
    expect((res as { provider: string }).provider).toBe('kometa');
    expect((res as { merged: boolean }).merged).toBe(true);
    expect(hs.merged).toHaveLength(1);
    // The compiled managed include carries the acquisition-off recipe + the namespace marker.
    expect(hs.opened[0]!.content as string).toContain('radarr_add_missing: false');
    expect(hs.opened[0]!.content as string).toContain('label: "HNet Managed"');
  });

  it('a Libretto builder on a Movies draft is rejected (KOMETA_RECIPE_INVALID)', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const err = await caller(ctx)
      .collections.upsert(
        draftInput({
          id: 'x',
          builderType: 'hardcover_series',
          builderRef: 'y',
          mediaType: 'movies',
        }),
      )
      .then(
        () => {
          throw new Error('expected reject');
        },
        (e: unknown) => e,
      );
    expect(wireShape(err, 'collections.upsert').data).toMatchObject({
      appCode: 'KOMETA_RECIPE_INVALID',
    });
    expect(hs.opened).toHaveLength(0);
  });

  it('a non-admin Movies add whose size is unresolvable (a URL builder) routes to the over-cap ticket', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const err = await caller(ctx)
      .collections.upsert(
        draftInput({
          id: 'christmas',
          builderType: 'imdb_list',
          builderRef: 'https://www.imdb.com/list/ls012345678/',
          mediaType: 'movies',
        }),
      )
      .then(
        () => {
          throw new Error('expected reject');
        },
        (e: unknown) => e,
      );
    expect(wireShape(err, 'collections.upsert').data).toMatchObject({
      appCode: 'COLLECTION_SIZE_CAP_EXCEEDED',
    });
    expect(hs.opened).toHaveLength(0);
  });

  it('an admin approves a Kometa over-cap ticket → opens a HUMAN-merged PR (never auto-merged) + completes', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db, { admin: true });
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const memberCtx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const { ticketId } = await caller(memberCtx).collections.requestOverride(
      draftInput({
        id: 'big-imdb',
        name: 'Big IMDb',
        builderType: 'imdb_list',
        builderRef: 'https://www.imdb.com/list/ls012345678/',
        mediaType: 'movies',
      }),
    );
    const [ticket] = await t.db
      .select()
      .from(tickets)
      .where(sql`${tickets.id} = ${ticketId}`);
    expect((ticket!.collectionOverridePayload as CollectionOverridePayload).provider).toBe(
      'kometa',
    );

    const adminCtx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(adminCtx).collections.approveOverride({ ticketId });
    expect(res.status).toBe('complete');
    expect(hs.opened).toHaveLength(1); // a config PR opened
    expect(hs.merged).toHaveLength(0); // but NOT auto-merged (over-cap is human-merged — D-10)
  });

  it('an admin removes a Movies recipe through a managed-include PR', async () => {
    const admin = await createUser(t.db, { admin: true });
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(ctx).collections.remove({ id: 'christmas', mediaType: 'movies' });
    expect(res.ok).toBe(true);
    expect((res as { provider: string }).provider).toBe('kometa');
    expect(hs.opened).toHaveLength(1);
  });
});

// ADR-072 / DESIGN-043 D-14 / DESIGN-042 D-06 (PLAN-052 PR4c) — the per-collection find-missing knob is
// GRANT-GATED (collectionActionProcedure('find_missing') — admin implies it). Proves the FORBIDDEN path a
// forged flag hits, the granted Libretto direct-write path, and the admin Kometa human-merged-PR path.
describe('setFindMissing — grant-gated acquisition knob (D-14)', () => {
  /** Grant find_missing to the Default role (the FLIP, via the domain single-writer) so a member passes. */
  async function setDefaultFindMissing(on: boolean) {
    const actor = await createUser(t.db, { admin: true });
    await setRoleCollectionActions({
      db: t.db,
      roleId: SEEDED_ROLE_IDS.default,
      actions: on ? ['find_missing'] : [],
      actorId: actor.id,
    });
  }

  it('a non-admin WITHOUT the grant is FORBIDDEN (a forged flag never enables acquisition)', async () => {
    await setDefaultFindMissing(false);
    const member = await createUser(t.db);
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    await expect(
      caller(ctx).collections.setFindMissing({ id: 'dune', mediaType: 'books', on: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.recipes).toHaveLength(0);
  });

  it('a GRANTED non-admin turns find missing ON for a Libretto collection (direct re-PUT)', async () => {
    await setDefaultFindMissing(true);
    const member = await createUser(t.db);
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    // Seed the recipe so the re-PUT can find it (listRecipes returns the stub's recorded recipes).
    await caller(ctx).collections.upsert(draftInput({ id: 'dune' }));
    const res = await caller(ctx).collections.setFindMissing({
      id: 'dune',
      mediaType: 'books',
      on: true,
    });
    expect(res).toMatchObject({ ok: true, provider: 'libretto', findMissing: true });
    const last = stub.recipes[stub.recipes.length - 1]!;
    expect((last.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(true);
    await setDefaultFindMissing(false);
  });

  it('an ADMIN enables find missing on a Kometa collection via a HUMAN-merged PR (never auto-merged)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const managed = compileManagedFile({
      mediaType: 'movies',
      recipes: [
        {
          id: 'marvel',
          name: 'Marvel',
          mediaType: 'movies',
          builderType: 'tmdb_movie',
          builderRef: '1, 2, 3',
          findMissing: false,
        },
      ],
    });
    const hs = stubHaynesops({ file: managed, checks: 'success' });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(ctx).collections.setFindMissing({
      id: 'marvel',
      mediaType: 'movies',
      on: true,
    });
    expect(res).toMatchObject({ ok: true, provider: 'kometa', findMissing: true, merged: false });
    expect(hs.opened).toHaveLength(1);
    expect(hs.merged).toHaveLength(0); // acquisition lever is human-merged (D-10)
    expect(hs.opened[0]!.content as string).toContain('radarr_add_missing: true');
  });
});

// DESIGN-042 D-02 / DESIGN-043 D-02 amend (2026-07-18, owner-reported gap) — every tab lists BOTH
// populations: app-managed recipes AND the mirror collections with no managed recipe, the latter as
// READ-ONLY rows. Proves the read-only rows are present, the recipe rows are unchanged, a no-recipe
// mirror row appears, and a recipe-JOINED mirror row is NOT duplicated into the read-only group.
describe('overview — two-population list: read-only estate/hand-made rows (D-02 amend)', () => {
  async function movieLibId(): Promise<string> {
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
    });
    const [row] = await t.db
      .select({ id: plexLibraries.id })
      .from(plexLibraries)
      .where(
        and(
          eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynesops),
          eq(plexLibraries.sectionKey, '1'),
        ),
      );
    if (!row) throw new Error('movie library not seeded');
    return row.id;
  }

  it('Kometa: a no-recipe config collection is a read-only kometa_config row; a recipe-joined mirror row does NOT duplicate', async () => {
    const member = await createUser(t.db);
    const movieLib = await movieLibId();
    // Two mirrored Kometa collections: "Marvel" matches a managed recipe (joins → not read-only);
    // "Estate Only" has no managed recipe (→ read-only). Seeded through the sanctioned domain writer.
    await syncPlexCollections({
      db: t.db,
      collections: [
        {
          plexLibraryId: movieLib,
          ratingKey: 'k-marvel',
          title: 'Marvel',
          childCount: 30,
          createdBy: 'kometa',
          category: null,
          members: [],
          fullyRead: true,
        },
        {
          plexLibraryId: movieLib,
          ratingKey: 'k-estate',
          title: 'Estate Only',
          childCount: 12,
          createdBy: 'kometa',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedLibraryIds: [movieLib],
    });
    const managed = compileManagedFile({
      mediaType: 'movies',
      recipes: [
        {
          id: 'marvel',
          name: 'Marvel',
          mediaType: 'movies',
          builderType: 'tmdb_movie',
          builderRef: '1, 2, 3',
          findMissing: false,
        },
      ],
    });
    const ctx = {
      ...makeCtx(t.db, sessionUser(member)),
      ...stubLibretto().ctx,
      ...stubHaynesops({ file: managed }).ctx,
    };
    const res = await caller(ctx).collections.overview({ mediaType: 'movies' });
    // The managed recipe stays a full-control row (unchanged).
    expect(res.recipes.map((r) => r.id)).toContain('marvel');
    // Owner ruling 2026-07-18: Kometa mirror rows with no recipe and no hand file are Defaults-produced
    // handCollections (source 'default', never editable); the recipe-joined one is NOT duplicated there.
    const estate = res.handCollections.find((h) => h.name === 'Estate Only');
    expect(estate).toBeDefined();
    expect(estate!.source).toBe('default');
    expect(estate!.editable).toBe(false);
    expect(estate!.itemCount).toBe(12);
    expect(res.handCollections.map((h) => h.name)).not.toContain('Marvel');
    // The Kometa tab no longer uses the books read-only group.
    expect(res.readOnly).toHaveLength(0);
  });

  it('Libretto: a hand-made (recipe-less) mirror collection is a read-only hand_made row on the matching tab only', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    // A managed Libretto recipe so the managed group is non-empty and provably unchanged.
    stub.recipes.push({
      id: 'stormlight',
      name: 'Stormlight',
      builder: { type: 'hardcover_series', ref: 'stormlight' },
      enabled: true,
    });
    // Two hand-made (librettoRecipeId null) mirror rows: a Kavita one (→ Books) and an ABS one
    // (→ Audiobooks). Seeded through the sanctioned domain writer (never a direct insert).
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: 'handmade-kavita',
          kind: 'collection',
          libraryId: null,
          title: 'Kavita Hand Picks',
          itemCount: 9,
          ordered: false,
          createdBy: 'kavita',
          librettoRecipeId: null,
          category: null,
          members: [],
          fullyRead: true,
        },
        {
          source: 'audiobookshelf',
          externalId: 'handmade-abs',
          kind: 'collection',
          libraryId: 'lib1',
          title: 'ABS Hand Picks',
          itemCount: 4,
          ordered: true,
          createdBy: 'audiobookshelf',
          librettoRecipeId: null,
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [{ source: 'kavita', kind: 'collection' }],
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };

    const books = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(books.readOnly.map((r) => r.name)).toContain('Kavita Hand Picks');
    // ADR-075 C-01 — the merged Books tab lists hand-made rows from BOTH sources.
    expect(books.readOnly.map((r) => r.name)).toContain('ABS Hand Picks');
    expect(books.readOnly.find((r) => r.name === 'Kavita Hand Picks')).toMatchObject({
      managedBy: 'hand_made',
      source: 'kavita',
    });
    // The managed recipe is unchanged — a full-control row, never a read-only one.
    expect(books.recipes.map((r) => r.id)).toContain('stormlight');
    expect(books.readOnly.map((r) => r.name)).not.toContain('Stormlight');

    // The legacy 'audiobooks' alias reads the SAME merged tab (ADR-075 C-01) — both sources.
    const audiobooks = await caller(ctx).collections.overview({ mediaType: 'audiobooks' });
    expect(audiobooks.readOnly.map((r) => r.name)).toContain('ABS Hand Picks');
    expect(audiobooks.readOnly.map((r) => r.name)).toContain('Kavita Hand Picks');
  });
});

// OWNER RULING 2026-07-18 (evening) — the Movies/TV tabs EDIT the estate's hand-authored Kometa collections
// (not read-only). Proves: the overview parses hand files into one source-badged list with editability +
// mirror item counts; an edit opens a HUMAN-merged config-file PR (never auto-merged) preserving the file;
// a too-custom collection rejects; delete is admin-only + human-merged; find-missing splices the hand file.
const HAND_MOVIES_FILE = 'movies-franchises.yml';
const HAND_MOVIES_TEXT = [
  '# estate movie franchises (hand-authored)',
  'templates:',
  '  Movies:',
  '    tmdb_collection_details: <<collection>>',
  '    imdb_list: <<imdb_list>>',
  '',
  'collections:',
  '  Goosebumps:',
  '    template: {name: Movies, collection: 508783}',
  '    sort_title: "!E Goosebumps"',
  '  A24:',
  '    imdb_search:',
  '      type: movie',
  '      company: co0390816',
  '',
].join('\n');

describe('hand-authored Kometa collections — edit-in-place (owner ruling 2026-07-18)', () => {
  async function movieLib(): Promise<string> {
    await upsertPlexLibraries({
      db: t.db,
      slug: 'haynesops',
      libraries: [{ sectionKey: '1', name: 'HOps Movies', mediaType: 'movie' }],
    });
    const [row] = await t.db
      .select({ id: plexLibraries.id })
      .from(plexLibraries)
      .where(
        and(
          eq(plexLibraries.serverId, SEEDED_PLEX_SERVER_IDS.haynesops),
          eq(plexLibraries.sectionKey, '1'),
        ),
      );
    if (!row) throw new Error('movie library not seeded');
    return row.id;
  }

  it('the overview parses hand files into ONE source-badged list with editability + mirror counts', async () => {
    const member = await createUser(t.db);
    const lib = await movieLib();
    await syncPlexCollections({
      db: t.db,
      collections: [
        {
          plexLibraryId: lib,
          ratingKey: 'k-goose',
          title: 'Goosebumps',
          childCount: 5,
          createdBy: 'kometa',
          category: null,
          members: [],
          fullyRead: true,
        },
        {
          plexLibraryId: lib,
          ratingKey: 'k-default',
          title: 'Universe Only',
          childCount: 9,
          createdBy: 'kometa',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedLibraryIds: [lib],
    });
    const ctx = {
      ...makeCtx(t.db, sessionUser(member)),
      ...stubLibretto().ctx,
      ...stubHaynesops({ file: null, handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT } }).ctx,
    };
    const res = await caller(ctx).collections.overview({ mediaType: 'movies' });
    const goose = res.handCollections.find((h) => h.name === 'Goosebumps')!;
    expect(goose.source).toBe('hand');
    expect(goose.editable).toBe(true);
    expect(goose.builderType).toBe('tmdb_collection_details');
    expect(goose.builderRef).toBe('508783');
    expect(goose.file).toBe(HAND_MOVIES_FILE);
    expect(goose.itemCount).toBe(5); // joined from the mirror by title
    const a24 = res.handCollections.find((h) => h.name === 'A24')!;
    expect(a24.editable).toBe(false); // imdb_search — too custom
    expect(a24.editableReason).toBeTruthy();
    // A Defaults-produced mirror row (no hand file) is listed but never editable.
    const universe = res.handCollections.find((h) => h.name === 'Universe Only')!;
    expect(universe.source).toBe('default');
    expect(universe.editable).toBe(false);
    // The Kometa tab does not use the books read-only group.
    expect(res.readOnly).toHaveLength(0);
  });

  it('editHandCollection opens a HUMAN-merged PR on the hand file with the new ref (never auto-merged)', async () => {
    // Admin (the owner path) bypasses the cap; a collection-id ref is unprovable without egress, so a
    // non-admin edit would route to the over-cap ticket (asserted separately below).
    const admin = await createUser(t.db, { admin: true });
    const hs = stubHaynesops({
      file: null,
      handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT },
      checks: 'success',
    });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(ctx).collections.editHandCollection({
      mediaType: 'movies',
      file: HAND_MOVIES_FILE,
      name: 'Goosebumps',
      builderType: 'tmdb_collection_details',
      builderRef: '999999',
    });
    expect(res).toMatchObject({ ok: true, provider: 'kometa', merged: false });
    expect(hs.opened).toHaveLength(1);
    expect(hs.merged).toHaveLength(0); // hand-file PRs are ALWAYS human-merged
    expect(hs.opened[0]!.path).toBe(
      `kubernetes/main/apps/media/kometa/app/config/${HAND_MOVIES_FILE}`,
    );
    const content = hs.opened[0]!.content as string;
    expect(content).toContain('    template: {name: Movies, collection: 999999}');
    // Fidelity: the untouched A24 block + the template header survive byte-for-byte.
    expect(content).toContain('  A24:');
    expect(content).toContain('      company: co0390816');
    expect(content).toContain('    tmdb_collection_details: <<collection>>');
    // Audited same-tx.
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.actorId, admin.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('upsert_collection');
    expect((audit[0]!.detail as { hand_edit?: boolean }).hand_edit).toBe(true);
  });

  it('a non-admin editing a hand collection with an unprovable-size ref hits the cap (ticket path)', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null, handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT } });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const err = await caller(ctx)
      .collections.editHandCollection({
        mediaType: 'movies',
        file: HAND_MOVIES_FILE,
        name: 'Goosebumps',
        builderType: 'tmdb_collection_details',
        builderRef: '999999',
      })
      .then(
        () => {
          throw new Error('expected the over-cap hand edit to reject');
        },
        (e: unknown) => e,
      );
    expect(wireShape(err, 'collections.editHandCollection').data).toMatchObject({
      appCode: 'COLLECTION_SIZE_CAP_EXCEEDED',
    });
    expect(hs.opened).toHaveLength(0);
  });

  it('editHandCollection rejects a too-custom collection (never a lossy rewrite)', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null, handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT } });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    await expect(
      caller(ctx).collections.editHandCollection({
        mediaType: 'movies',
        file: HAND_MOVIES_FILE,
        name: 'A24',
        builderType: 'imdb_list',
        builderRef: 'https://www.imdb.com/list/ls000000001/',
      }),
    ).rejects.toBeTruthy();
    expect(hs.opened).toHaveLength(0);
  });

  it('delete of a hand collection is admin-only + a HUMAN-merged PR removing its block', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db, { admin: true });
    const hsMember = stubHaynesops({
      file: null,
      handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT },
    });
    const memberCtx = {
      ...makeCtx(t.db, sessionUser(member)),
      ...stubLibretto().ctx,
      ...hsMember.ctx,
    };
    await expect(
      caller(memberCtx).collections.remove({
        id: 'Goosebumps',
        mediaType: 'movies',
        handFile: HAND_MOVIES_FILE,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const hs = stubHaynesops({ file: null, handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT } });
    const adminCtx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(adminCtx).collections.remove({
      id: 'Goosebumps',
      mediaType: 'movies',
      handFile: HAND_MOVIES_FILE,
    });
    expect(res).toMatchObject({ ok: true, provider: 'kometa', merged: false });
    expect(hs.merged).toHaveLength(0);
    const content = hs.opened[0]!.content as string;
    expect(content).not.toContain('  Goosebumps:');
    expect(content).toContain('  A24:'); // the neighbor survives
  });

  it('find-missing on a hand collection splices that file via a HUMAN-merged PR (admin)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const hs = stubHaynesops({
      file: null,
      handFiles: { [HAND_MOVIES_FILE]: HAND_MOVIES_TEXT },
      checks: 'success',
    });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx, ...hs.ctx };
    const res = await caller(ctx).collections.setFindMissing({
      id: 'Goosebumps',
      mediaType: 'movies',
      on: true,
      handFile: HAND_MOVIES_FILE,
    });
    expect(res).toMatchObject({ ok: true, provider: 'kometa', findMissing: true, merged: false });
    expect(hs.merged).toHaveLength(0);
    const content = hs.opened[0]!.content as string;
    expect(content).toContain('    radarr_add_missing: true');
    expect(content).toContain('    radarr_search: true');
  });
});

// ADR-071 / DESIGN-043 D-02/D-07 amend (owner ruling 2026-07-18) — the on-demand collection FORCE SEARCH
// that replaced the retired "Run now". Proves the grant matrix (ungranted FORBIDDEN — the books
// force_search_book gate, the same as the books detail; granted member passes; admin implies), the
// server-side compose ORDER (apply → refresh missing → LL search), the caller-tagged audit row, and the
// overview's canForceSearch flag + per-recipe missingCount the modal copy reads.
describe('forceSearchCollection — the on-demand collection Force Search (ADR-071)', () => {
  /** Flip the Default role's books force_search_book grant (the same grid the owner granted to all roles). */
  async function setDefaultForceSearch(on: boolean) {
    const actor = await createUser(t.db, { admin: true });
    await setRoleBookActions({
      db: t.db,
      roleId: SEEDED_ROLE_IDS.default,
      actions: on ? ['force_search_book'] : [],
      actorId: actor.id,
    });
  }

  /** Seed a Libretto-bound mirror collection (the sanctioned domain writer — never a direct insert). */
  async function seedMirror(recipeId: string) {
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: `fs-${recipeId}`,
          kind: 'collection',
          libraryId: null,
          title: `FS ${recipeId}`,
          itemCount: 0,
          ordered: false,
          createdBy: 'libretto',
          librettoRecipeId: recipeId,
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [],
    });
  }

  /**
   * The on-demand stub pair: ONE shared `events` log records the Libretto apply, the missing read, and each
   * confined LL step in call order — the compose-order proof. `resolveByTitle` maps a missing title → volume id.
   */
  function stubOnDemand(opts: {
    missing?: Array<{ isbn?: string; title?: string }>;
    resolveByTitle?: Record<string, string>;
  }) {
    const events: string[] = [];
    const libretto = {
      read: {
        listRecipes: async () => ({ recipes: [], issues: [] }),
        listCollections: async () => [],
        listMissingMembers: async () => {
          events.push('missing');
          return { missing: opts.missing ?? [] };
        },
        resolve: async (req: { title?: string }) => {
          const vol = opts.resolveByTitle?.[req.title ?? ''];
          return vol ? { volumeId: vol } : null;
        },
      },
      write: {
        applyScope: async (scope: string) => {
          events.push(`apply:${scope}`);
          return 'run-od-1';
        },
      },
    } as unknown as LibrettoClientBundle;
    const lazylibrarian = {
      write: {
        addBook: async (id: string) => void events.push(`addBook:${id}`),
        queueBook: async (id: string, format: string) =>
          void events.push(`queueBook:${id}:${format}`),
        searchBook: async (id: string, format: string) =>
          void events.push(`searchBook:${id}:${format}`),
      },
    } as unknown as NonNullable<TRPCContext['lazylibrarian']>;
    return { events, ctx: { libretto, lazylibrarian } };
  }

  it('is FORBIDDEN without the force_search_book grant (a forged call never searches)', async () => {
    await setDefaultForceSearch(false);
    await seedMirror('fs-forbidden');
    const member = await createUser(t.db);
    const stub = stubOnDemand({
      missing: [{ isbn: '1', title: 'One' }],
      resolveByTitle: { One: 'gb1' },
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    await expect(
      caller(ctx).collections.forceSearchCollection({ recipeId: 'fs-forbidden' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.events).toHaveLength(0); // nothing applied, read, or searched
  });

  it('a GRANTED member composes apply → refresh missing → LL search, audited as the caller', async () => {
    await setDefaultForceSearch(true);
    await seedMirror('fs-granted');
    const member = await createUser(t.db);
    const stub = stubOnDemand({
      missing: [{ isbn: '1', title: 'One' }],
      resolveByTitle: { One: 'gb1' },
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const res = await caller(ctx).collections.forceSearchCollection({ recipeId: 'fs-granted' });
    expect(res).toMatchObject({
      ok: true,
      runId: 'run-od-1',
      minted: 1,
      searched: 1,
      failed: 0,
      unreachable: false,
    });
    // The compose ORDER: the recipe re-applies FIRST, the missing set refreshes SECOND, the confined LL
    // chain (addBook → queueBook → searchBook) fires LAST.
    expect(stub.events).toEqual([
      'apply:fs-granted',
      'missing',
      'addBook:gb1',
      'queueBook:gb1:ebook',
      'searchBook:gb1:ebook',
    ]);
    // The audit row carries the caller + the on-demand via tag.
    const audits = (
      await t.db
        .select()
        .from(permissionAudit)
        .where(eq(permissionAudit.action, 'request_book_search'))
    ).filter((a) => (a.detail as { via?: string }).via === 'collection_force_search');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(member.id);
    await setDefaultForceSearch(false);
  });

  it('an ADMIN implies the grant (no role row needed)', async () => {
    await seedMirror('fs-admin');
    const admin = await createUser(t.db, { admin: true });
    const stub = stubOnDemand({ missing: [], resolveByTitle: {} });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.forceSearchCollection({ recipeId: 'fs-admin' });
    expect(res).toMatchObject({ ok: true, searched: 0 }); // nothing missing — honest zero, not an error
    expect(stub.events[0]).toBe('apply:fs-admin');
  });

  it('overview carries canForceSearch (grant-driven) and each recipe missingCount for the modal copy', async () => {
    await setDefaultForceSearch(false);
    await seedMirror('fs-count');
    const member = await createUser(t.db);
    const stubbed = stubLibretto();
    stubbed.recipes.push({
      id: 'fs-count',
      name: 'FS Count',
      builder: { type: 'hardcover_series', ref: 'fs' },
      enabled: true,
    });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubbed.ctx };
    const ungranted = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(ungranted.canForceSearch).toBe(false);

    await setDefaultForceSearch(true);
    const granted = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(granted.canForceSearch).toBe(true);
    const row = granted.recipes.find((r) => r.id === 'fs-count');
    expect(row?.missingCount).toBe(0); // a mirror-bound recipe with no open wants counts an honest 0

    const admin = await createUser(t.db, { admin: true });
    const adminView = await caller({
      ...makeCtx(t.db, sessionUser(admin)),
      ...stubbed.ctx,
    }).collections.overview({
      mediaType: 'books',
    });
    expect(adminView.canForceSearch).toBe(true);
    await setDefaultForceSearch(false);
  });
});

// ── DESIGN-044 — the builder page's search + preview procedures (D-04/D-05) ─────────────────────
describe('collections.search + collections.preview (DESIGN-044 builder page)', () => {
  /** A Libretto stub that also answers the builder-page search + preview reads. */
  function stubBuilderLibretto(opts: {
    search?: unknown;
    preview?: unknown;
    searchThrows?: unknown;
  }): Partial<TRPCContext> {
    const libretto = {
      read: {
        listRecipes: async () => ({ recipes: [], issues: [] }),
        listCollections: async () => [],
        search: async () => {
          if (opts.searchThrows) throw opts.searchThrows;
          return opts.search ?? { results: [], truncated: false };
        },
        preview: async () => opts.preview ?? { total: 0, truncated: false, members: [] },
      },
      write: {},
    } as unknown as TRPCContext['libretto'];
    return { libretto };
  }

  it('proxies a books ref search through Libretto (everyone, no grant)', async () => {
    const member = await createUser(t.db);
    const ctx = {
      ...makeCtx(t.db, sessionUser(member), stubArrBundle([]).bundle),
      ...stubBuilderLibretto({
        search: {
          results: [
            { ref: '42', name: 'The Stormlight Archive', author: 'Sanderson', workCount: 5 },
          ],
          truncated: false,
        },
      }),
    };
    const res = await caller(ctx).collections.search({
      mediaType: 'books',
      builderType: 'hardcover_series',
      q: 'storm',
    });
    expect(res.reachable).toBe(true);
    expect(res.results[0]).toMatchObject({ ref: '42', name: 'The Stormlight Archive' });
  });

  it('reads a movie franchise through the confined @hnet/arr lookup', async () => {
    const member = await createUser(t.db);
    const arr = stubArrBundle([
      {
        path: '/api/v3/movie/lookup',
        body: [
          {
            title: 'The Fellowship of the Ring',
            year: 2001,
            tmdbId: 120,
            collection: { name: 'The Lord of the Rings Collection', tmdbId: 119 },
          },
          { title: 'A Standalone', year: 2010, tmdbId: 900 },
        ],
      },
    ]);
    const ctx = { ...makeCtx(t.db, sessionUser(member), arr.bundle), ...stubBuilderLibretto({}) };
    const res = await caller(ctx).collections.search({
      mediaType: 'movies',
      builderType: 'tmdb_collection_details',
      q: 'lord',
    });
    const enabled = res.results.filter((r) => !r.disabled);
    expect(enabled[0]).toMatchObject({ ref: '119', name: 'The Lord of the Rings Collection' });
  });

  it('degrades search to unreachable on a provider outage (falls back to manual entry)', async () => {
    const member = await createUser(t.db);
    const { LibrettoUnreachableError } = await import('@hnet/libretto');
    const ctx = {
      ...makeCtx(t.db, sessionUser(member), stubArrBundle([]).bundle),
      ...stubBuilderLibretto({ searchThrows: new LibrettoUnreachableError('GET', '/api/search') }),
    };
    const res = await caller(ctx).collections.search({
      mediaType: 'books',
      builderType: 'nyt_list',
      q: 'fiction',
    });
    expect(res.reachable).toBe(false);
    expect(res.results).toEqual([]);
  });

  it('previews books members split held/missing (empty mirror ⇒ all missing, honest)', async () => {
    const member = await createUser(t.db);
    const ctx = {
      ...makeCtx(t.db, sessionUser(member), stubArrBundle([]).bundle),
      ...stubBuilderLibretto({
        preview: {
          total: 2,
          truncated: false,
          members: [
            { title: 'A', author: 'X', isbn: null },
            { title: 'B', author: 'Y', isbn: null },
          ],
        },
      }),
    };
    const res = await caller(ctx).collections.preview({
      mediaType: 'books',
      builderType: 'hardcover_series',
      ref: '42',
    });
    expect(res.available).toBe(true);
    expect(res.total).toBe(2);
    expect(res.missingCount).toBe(2);
    expect(res.heldCount).toBe(0);
  });

  it('renders the honest preview-unavailable state for a URL-ref builder (Q-01)', async () => {
    const member = await createUser(t.db);
    const ctx = {
      ...makeCtx(t.db, sessionUser(member), stubArrBundle([]).bundle),
      ...stubBuilderLibretto({}),
    };
    const res = await caller(ctx).collections.preview({
      mediaType: 'movies',
      builderType: 'imdb_list',
      ref: 'https://www.imdb.com/list/ls012345678/',
    });
    expect(res.available).toBe(false);
    expect(res.unavailableReason).toContain('list link');
  });

  it('forbids an anonymous caller from the builder reads (authed only)', async () => {
    const ctx = { ...makeCtx(t.db, null), ...stubBuilderLibretto({}) };
    await expect(
      caller(ctx).collections.search({
        mediaType: 'books',
        builderType: 'hardcover_series',
        q: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      caller(ctx).collections.preview({
        mediaType: 'books',
        builderType: 'hardcover_series',
        ref: '42',
      }),
    ).rejects.toThrow();
  });
});
