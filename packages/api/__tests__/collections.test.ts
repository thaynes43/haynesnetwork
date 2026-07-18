// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the collections router gates, INCLUDING the
// FORBIDDEN paths the plan calls out: an ungranted member is FORBIDDEN everywhere; a `suggest`-only member
// can propose (from the walls, no section floor) but NOT reach the manager; a `manage` member cannot enable
// the acquisition knob (needs `acquire`, re-checked server-side); an `acquire`-holding member can. Admin
// bypasses. The confined Libretto client is stubbed in ctx (ADR-010 — no live-API tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SEEDED_ROLE_IDS,
  notificationOutbox,
  ticketEvents,
  tickets,
  type CollectionAction,
} from '@hnet/db';
import { setRoleCollectionActions, type LibrettoClientBundle } from '@hnet/domain';
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
 * draft to — the preview the size-cap guard reads (DESIGN-035 D-17). Defaults to 3 (well within the cap).
 */
function stubLibretto(workCount = 3): { ctx: Partial<TRPCContext>; recipes: Array<Record<string, unknown>> } {
  const recipes: Array<Record<string, unknown>> = [];
  const libretto = {
    read: {
      listRecipes: async () => ({ recipes, issues: [] }),
      listCollections: async () => [],
      validateRecipe: async () => ({ ok: true, issues: [], resolved: { name: 'X', workCount } }),
      getRun: async () => ({ id: 'run-1', status: 'ok', counts: { matched: 3 } }),
    },
    write: {
      upsertRecipe: async (d: Record<string, unknown>) => void recipes.push(d),
      deleteRecipe: async () => {},
      applyScope: async () => 'run-9',
    },
  } as unknown as LibrettoClientBundle;
  return { ctx: { libretto }, recipes };
}

/** Grant the seeded Default role a set of collection actions (via the audited single-writer). */
async function grantDefault(actions: CollectionAction[]): Promise<void> {
  const admin = await createUser(t.db, { admin: true });
  await setRoleCollectionActions({ db: t.db, roleId: SEEDED_ROLE_IDS.default, actions, actorId: admin.id });
}

describe('collections router — the manage/acquire/suggest gates (ADR-070 C-03/C-04)', () => {
  it('an ungranted member is FORBIDDEN from the manager overview', async () => {
    const member = await createUser(t.db);
    const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stubLibretto().ctx };
    await expect(caller(ctx).collections.overview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an ADMIN sees the overview (reachable) with canAcquire', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stubLibretto().ctx };
    const res = await caller(ctx).collections.overview();
    expect(res.reachable).toBe(true);
    expect(res.canAcquire).toBe(true);
  });

  it('a manage member reaches the overview but WITHOUT acquire', async () => {
    await grantDefault(['manage']);
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stubLibretto().ctx };
      const res = await caller(ctx).collections.overview();
      expect(res.reachable).toBe(true);
      expect(res.canAcquire).toBe(false);
    } finally {
      await grantDefault([]);
    }
  });

  it('a manage member CANNOT enable acquisition on save (FORBIDDEN)', async () => {
    await grantDefault(['manage']);
    const stub = stubLibretto();
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stub.ctx };
      await expect(
        caller(ctx).collections.save({
          id: 'dune',
          builderType: 'static_ids',
          builderRef: 'x',
          acquisitionEnabled: true,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(stub.recipes).toHaveLength(0);
    } finally {
      await grantDefault([]);
    }
  });

  it('a manage member CAN save without acquisition', async () => {
    await grantDefault(['manage']);
    const stub = stubLibretto();
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stub.ctx };
      const res = await caller(ctx).collections.save({ id: 'dune', builderType: 'static_ids', builderRef: 'x' });
      expect(res.ok).toBe(true);
      expect(stub.recipes).toHaveLength(1);
    } finally {
      await grantDefault([]);
    }
  });

  it('an acquire member CAN enable acquisition', async () => {
    await grantDefault(['manage', 'acquire']);
    const stub = stubLibretto();
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stub.ctx };
      await caller(ctx).collections.save({ id: 'd', builderType: 'static_ids', builderRef: 'x', acquisitionEnabled: true });
      expect((stub.recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(true);
    } finally {
      await grantDefault([]);
    }
  });
});

describe('collections router — the member contribution (ADR-070 C-05)', () => {
  it('a member WITHOUT suggest is FORBIDDEN from suggest', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member));
    await expect(
      caller(ctx).collections.suggest({ name: 'A', builderType: 'static_ids', builderRef: 'a' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a suggest member can propose (NO integrations section needed — the wall affordance)', async () => {
    await grantDefault(['suggest']);
    try {
      const member = await createUser(t.db);
      // integrations stays DISABLED (default) — proves suggest has no section floor.
      const ctx = makeCtx(t.db, sessionUser(member));
      const res = await caller(ctx).collections.suggest({
        name: 'The Stormlight Archive',
        builderType: 'hardcover_series',
        builderRef: 'stormlight',
      });
      expect(res.status).toBe('pending');
      const mine = await caller(ctx).collections.mySuggestions();
      expect(mine.suggestions).toHaveLength(1);
    } finally {
      await grantDefault([]);
    }
  });

  it('a suggest-only member CANNOT reach the manager overview', async () => {
    await grantDefault(['suggest']);
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stubLibretto().ctx };
      await expect(caller(ctx).collections.overview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await grantDefault([]);
    }
  });

  it('a manage admin approves a suggestion → recipe materialized', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto();
    const suggester = await createUser(t.db);
    // The suggester files it (grant suggest to Default so the suggester can call).
    await grantDefault(['suggest']);
    let suggestionId: string;
    try {
      const sCtx = makeCtx(t.db, sessionUser(suggester));
      const s = await caller(sCtx).collections.suggest({ name: 'Dune', builderType: 'static_ids', builderRef: 'x' });
      suggestionId = s.id;
    } finally {
      await grantDefault([]);
    }
    const aCtx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(aCtx).collections.reviewSuggestion({ decision: 'approve', suggestionId });
    expect(res.status).toBe('approved');
    expect(stub.recipes).toHaveLength(1);
  });
});

// DESIGN-035 D-17 — the non-admin collection SIZE CAP fence on save: the composer previews the draft's
// resolved membership (stub-Libretto validateRecipe → workCount), reads the live `collection_size_cap`
// (default 25), and refuses an over-cap CREATE for a non-admin BEFORE the confined Libretto write ever
// lands. Admins bypass the cap outright.
describe('collections router — the non-admin size cap on save (DESIGN-035 D-17)', () => {
  it('a non-admin manage member over the cap is UNPROCESSABLE_CONTENT (appCode COLLECTION_SIZE_CAP_EXCEEDED); NO recipe lands', async () => {
    await grantDefault(['manage']);
    const stub = stubLibretto(30); // resolved membership 30 > the default cap of 25
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stub.ctx };
      const err = await caller(ctx)
        .collections.save({ id: 'imdb-top-200', builderType: 'static_ids', builderRef: 'x' })
        .then(
          () => {
            throw new Error('expected the over-cap save to reject');
          },
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
      // The wire shape carries the machine-readable appCode the composer switches on (opens the Modal).
      expect(wireShape(err, 'collections.save').data).toMatchObject({
        code: 'UNPROCESSABLE_CONTENT',
        appCode: 'COLLECTION_SIZE_CAP_EXCEEDED',
      });
      // The guard fires BEFORE the confined write — nothing partial reached Libretto.
      expect(stub.recipes).toHaveLength(0);
    } finally {
      await grantDefault([]);
    }
  });

  it('a non-admin AT the cap (inclusive) saves fine', async () => {
    await grantDefault(['manage']);
    const stub = stubLibretto(25); // exactly the cap — allowed
    try {
      const member = await createUser(t.db);
      const ctx = { ...makeCtx(t.db, sessionUser(member, { integrations: 'read_only' })), ...stub.ctx };
      const res = await caller(ctx).collections.save({ id: 'at-cap', builderType: 'static_ids', builderRef: 'x' });
      expect(res.ok).toBe(true);
      expect(stub.recipes).toHaveLength(1);
    } finally {
      await grantDefault([]);
    }
  });

  it('an ADMIN bypasses the cap — an over-cap draft saves (the LISTS exception)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const stub = stubLibretto(500); // far over the cap — an admin-curated IMDb top-500
    const ctx = { ...makeCtx(t.db, sessionUser(admin)), ...stub.ctx };
    const res = await caller(ctx).collections.save({ id: 'imdb-top-500', builderType: 'static_ids', builderRef: 'x' });
    expect(res.ok).toBe(true);
    expect(stub.recipes).toHaveLength(1);
  });
});

// DESIGN-035 D-17 — the over-cap admin-override request: a non-admin whose create hit the cap files a
// `collection_override` ticket (reusing the ADR-050 helpdesk board + its atomic `ticket_created` outbox
// ping + admin email). The permission matrix mirrors save (integrations-floored `manage`); admin bypasses.
describe('collections router — requestOverride (DESIGN-035 D-17)', () => {
  it('an ungranted member is FORBIDDEN from requestOverride', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member, { integrations: 'read_only' }));
    await expect(
      caller(ctx).collections.requestOverride({ collectionName: 'IMDb Top 200', size: 200 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A member without even the integrations floor is FORBIDDEN too (the section gate fires first).
    const noSection = makeCtx(t.db, sessionUser(member));
    await expect(
      caller(noSection).collections.requestOverride({ collectionName: 'IMDb Top 200', size: 200 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a manage member files the collection_override ticket — creation event + outbox rows in the SAME tx', async () => {
    await grantDefault(['manage']);
    try {
      const member = await createUser(t.db, { displayName: 'Over Requester' });
      const ctx = makeCtx(t.db, sessionUser(member, { integrations: 'read_only' }));
      const { ticketId } = await caller(ctx).collections.requestOverride({
        collectionName: 'IMDb Top 200',
        size: 200,
      });
      expect(ticketId).toBeTruthy();

      // The ticket: category collection_override, the requester is the author, the live cap (25) rides the body.
      const [ticket] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${ticketId}`);
      expect(ticket!.category).toBe('collection_override');
      expect(ticket!.authorUserId).toBe(member.id);
      expect(ticket!.title).toBe('Collection override request: IMDb Top 200');
      expect(ticket!.body).toContain('200 items');
      expect(ticket!.body).toContain('25 items'); // the live cap the server read (never a client-sent cap)

      // The "Filed" creation event landed in the same tx (single-writer audit trail).
      const events = await t.db
        .select()
        .from(ticketEvents)
        .where(sql`${ticketEvents.ticketId} = ${ticketId}`);
      expect(events).toHaveLength(1);
      expect([events[0]!.fromStatus, events[0]!.toStatus]).toEqual([null, 'open']);
      expect(events[0]!.actorUserId).toBe(member.id);

      // And the ticket_created outbox pings (pushover + admin email) committed with it.
      const outbox = (
        await t.db.select().from(notificationOutbox).where(sql`${notificationOutbox.eventType} = 'ticket_created'`)
      ).filter((o) => (o.payload as { ticketId?: string }).ticketId === ticketId);
      expect(outbox.map((o) => o.channel).sort()).toEqual(['email', 'pushover']);
    } finally {
      await grantDefault([]);
    }
  });

  it('an ADMIN can also file an override request', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx = makeCtx(t.db, sessionUser(admin));
    const { ticketId } = await caller(ctx).collections.requestOverride({
      collectionName: 'Admin List',
      size: 999,
    });
    const [ticket] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${ticketId}`);
    expect(ticket!.category).toBe('collection_override');
    expect(ticket!.authorUserId).toBe(admin.id);
  });
});
