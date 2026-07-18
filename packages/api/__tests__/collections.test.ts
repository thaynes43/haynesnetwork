// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router gates, INCLUDING the FORBIDDEN
// paths the plan calls out: everyone reads + adds/edits within the cap (no grant, no section floor); an
// over-cap non-admin routes to the ticket (never a silent truncation); a non-admin CANNOT delete, approve,
// decline, read all tickets, or touch settings (FORBIDDEN); an admin bypasses the cap and does all of it.
// The confined Libretto client is stubbed in ctx (ADR-010 — no live-API tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { notificationOutbox, ticketEvents, tickets, type CollectionOverridePayload } from '@hnet/db';
import type { LibrettoClientBundle } from '@hnet/domain';
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
  ...over,
});

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

  it('Movies/TV report available:false (the Kometa leg is PR4b)', async () => {
    const member = await createUser(t.db);
    const ctx = { ...makeCtx(t.db, sessionUser(member)), ...stubLibretto().ctx };
    const res = await caller(ctx).collections.overview({ mediaType: 'movies' });
    expect(res.available).toBe(false);
    expect(res.provider).toBe('kometa');
    expect(res.recipes).toEqual([]);
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
    await expect(caller(ctx).collections.remove({ id: 'dune' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.deleted).toHaveLength(0);
  });

  it('an admin deletes the recipe', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto();
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.remove({ id: 'dune', deleteCollection: true });
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
