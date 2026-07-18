// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router gates, INCLUDING the FORBIDDEN
// paths the plan calls out: everyone reads + adds/edits within the cap (no grant, no section floor); an
// over-cap non-admin routes to the ticket (never a silent truncation); a non-admin CANNOT delete, approve,
// decline, read all tickets, or touch settings (FORBIDDEN); an admin bypasses the cap and does all of it.
// The confined Libretto client is stubbed in ctx (ADR-010 — no live-API tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  notificationOutbox,
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
  setRoleCollectionActions,
  type LibrettoClientBundle,
} from '@hnet/domain';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, wireShape, type TestDb } from './helpers';
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
function stubLibretto(workCount = 3): { ctx: Partial<TRPCContext>; recipes: Array<Record<string, unknown>>; deleted: string[] } {
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
function stubHaynesops(opts?: { file?: string | null; checks?: 'success' | 'failure' | 'pending' | 'none'; prFiles?: string[] }): {
  ctx: Partial<TRPCContext>;
  opened: Array<Record<string, unknown>>;
  merged: number[];
} {
  const opened: Array<Record<string, unknown>> = [];
  const merged: number[] = [];
  let n = 100;
  const configDir = 'kubernetes/main/apps/media/kometa/app/config';
  const haynesops = {
    configDir,
    baseBranch: 'main',
    read: {
      getFile: async () => (opts?.file != null ? { text: opts.file, sha: 'sha1' } : null),
      listOpenManagedPrs: async () => [],
      getChecksConclusion: async () => opts?.checks ?? 'success',
    },
    write: {
      getFile: async () => (opts?.file != null ? { text: opts.file, sha: 'sha1' } : null),
      openManagedFilePr: async (input: Record<string, unknown>) => {
        n += 1;
        opened.push(input);
        return { number: n, url: `https://github.com/x/y/pull/${n}`, headBranch: `b${n}`, headSha: `head${n}` };
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
    const audiobooks = await caller(ctx).collections.overview({ mediaType: 'audiobooks' });
    expect(audiobooks.recipes.map((r) => r.id)).toContain('dune-audiobooks');
    const books = await caller(ctx).collections.overview({ mediaType: 'books' });
    expect(books.recipes.map((r) => r.id)).not.toContain('dune-audiobooks');
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
    expect((stub.recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(false);
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
    await expect(caller(ctx).collections.remove({ id: 'dune', mediaType: 'books' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(stub.deleted).toHaveLength(0);
  });

  it('an admin deletes the recipe', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.remove({ id: 'dune', mediaType: 'books', deleteCollection: true });
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

    const [ticket] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${ticketId}`);
    expect(ticket!.category).toBe('collection_override');
    expect(ticket!.authorUserId).toBe(member.id);
    // The full requested definition rides the payload column (so Approve can materialize it).
    const payload = ticket!.collectionOverridePayload as CollectionOverridePayload;
    expect(payload.recipeId).toBe('imdb-top-200');
    expect(payload.size).toBe(200); // the SERVER-resolved size (never a client-sent number)
    expect(payload.mediaType).toBe('books');

    const events = await t.db.select().from(ticketEvents).where(sql`${ticketEvents.ticketId} = ${ticketId}`);
    expect(events).toHaveLength(1);
    const outbox = (
      await t.db.select().from(notificationOutbox).where(sql`${notificationOutbox.eventType} = 'ticket_created'`)
    ).filter((o) => (o.payload as { ticketId?: string }).ticketId === ticketId);
    expect(outbox.map((o) => o.channel).sort()).toEqual(['email', 'pushover']);
  });

  it('a non-admin CANNOT approve / decline / read all tickets (FORBIDDEN)', async () => {
    const member = await createUser(t.db);
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stub.ctx };
    const uuid = '00000000-0000-0000-0000-000000000000';
    await expect(caller(ctx).collections.approveOverride({ ticketId: uuid })).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    const res = await caller(adminCtx).collections.declineOverride({ ticketId, reason: 'too large for now' });
    expect(res.status).toBe('rejected');
    expect(stub.recipes).toHaveLength(0);
  });
});

describe('settings — ADMIN only (D-10)', () => {
  it('a non-admin CANNOT read or set the cap (FORBIDDEN)', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member));
    await expect(caller(ctx).collections.settings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(ctx).collections.setSizeCap({ value: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
      draftInput({ id: 'unbreakable', name: 'Unbreakable', builderType: 'tmdb_movie', builderRef: '9741, 358', mediaType: 'movies' }),
    );
    expect(res.ok).toBe(true);
    expect((res as { provider: string }).provider).toBe('kometa');
    expect((res as { merged: boolean }).merged).toBe(true);
    expect(hs.merged).toHaveLength(1);
    // The compiled managed include carries the acquisition-off recipe + the namespace marker.
    expect((hs.opened[0]!.content as string)).toContain('radarr_add_missing: false');
    expect((hs.opened[0]!.content as string)).toContain('label: "HNet Managed"');
  });

  it('a Libretto builder on a Movies draft is rejected (KOMETA_RECIPE_INVALID)', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const err = await caller(ctx)
      .collections.upsert(draftInput({ id: 'x', builderType: 'hardcover_series', builderRef: 'y', mediaType: 'movies' }))
      .then(() => { throw new Error('expected reject'); }, (e: unknown) => e);
    expect(wireShape(err, 'collections.upsert').data).toMatchObject({ appCode: 'KOMETA_RECIPE_INVALID' });
    expect(hs.opened).toHaveLength(0);
  });

  it('a non-admin Movies add whose size is unresolvable (a URL builder) routes to the over-cap ticket', async () => {
    const member = await createUser(t.db);
    const hs = stubHaynesops({ file: null });
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const err = await caller(ctx)
      .collections.upsert(
        draftInput({ id: 'christmas', builderType: 'imdb_list', builderRef: 'https://www.imdb.com/list/ls012345678/', mediaType: 'movies' }),
      )
      .then(() => { throw new Error('expected reject'); }, (e: unknown) => e);
    expect(wireShape(err, 'collections.upsert').data).toMatchObject({ appCode: 'COLLECTION_SIZE_CAP_EXCEEDED' });
    expect(hs.opened).toHaveLength(0);
  });

  it('an admin approves a Kometa over-cap ticket → opens a HUMAN-merged PR (never auto-merged) + completes', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db, { admin: true });
    const hs = stubHaynesops({ file: null, checks: 'success' });
    const memberCtx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx, ...hs.ctx };
    const { ticketId } = await caller(memberCtx).collections.requestOverride(
      draftInput({ id: 'big-imdb', name: 'Big IMDb', builderType: 'imdb_list', builderRef: 'https://www.imdb.com/list/ls012345678/', mediaType: 'movies' }),
    );
    const [ticket] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${ticketId}`);
    expect((ticket!.collectionOverridePayload as CollectionOverridePayload).provider).toBe('kometa');

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
    const res = await caller(ctx).collections.setFindMissing({ id: 'dune', mediaType: 'books', on: true });
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
    const res = await caller(ctx).collections.setFindMissing({ id: 'marvel', mediaType: 'movies', on: true });
    expect(res).toMatchObject({ ok: true, provider: 'kometa', findMissing: true, merged: false });
    expect(hs.opened).toHaveLength(1);
    expect(hs.merged).toHaveLength(0); // acquisition lever is human-merged (D-10)
    expect((hs.opened[0]!.content as string)).toContain('radarr_add_missing: true');
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
    // The no-recipe config collection is read-only; the recipe-joined one is NOT duplicated there.
    expect(res.readOnly.map((r) => r.name)).toContain('Estate Only');
    expect(res.readOnly.map((r) => r.name)).not.toContain('Marvel');
    expect(res.readOnly.every((r) => r.managedBy === 'kometa_config')).toBe(true);
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
    expect(books.readOnly.map((r) => r.name)).not.toContain('ABS Hand Picks');
    expect(books.readOnly.find((r) => r.name === 'Kavita Hand Picks')).toMatchObject({
      managedBy: 'hand_made',
      source: 'kavita',
    });
    // The managed recipe is unchanged — a full-control row, never a read-only one.
    expect(books.recipes.map((r) => r.id)).toContain('stormlight');
    expect(books.readOnly.map((r) => r.name)).not.toContain('Stormlight');

    const audiobooks = await caller(ctx).collections.overview({ mediaType: 'audiobooks' });
    expect(audiobooks.readOnly.map((r) => r.name)).toContain('ABS Hand Picks');
    expect(audiobooks.readOnly.map((r) => r.name)).not.toContain('Kavita Hand Picks');
  });
});
