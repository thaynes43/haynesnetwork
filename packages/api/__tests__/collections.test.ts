// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the collections router gates, INCLUDING the
// FORBIDDEN paths the plan calls out: an ungranted member is FORBIDDEN everywhere; a `suggest`-only member
// can propose (from the walls, no section floor) but NOT reach the manager; a `manage` member cannot enable
// the acquisition knob (needs `acquire`, re-checked server-side); an `acquire`-holding member can. Admin
// bypasses. The confined Libretto client is stubbed in ctx (ADR-010 — no live-API tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDED_ROLE_IDS, type CollectionAction } from '@hnet/db';
import { setRoleCollectionActions, type LibrettoClientBundle } from '@hnet/domain';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, type TestDb } from './helpers';
import type { TRPCContext } from '../src/trpc';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

/** A recording Libretto stub bundle injected into ctx. */
function stubLibretto(): { ctx: Partial<TRPCContext>; recipes: Array<Record<string, unknown>> } {
  const recipes: Array<Record<string, unknown>> = [];
  const libretto = {
    read: {
      listRecipes: async () => ({ recipes, issues: [] }),
      listCollections: async () => [],
      validateRecipe: async () => ({ ok: true, issues: [], resolved: { name: 'X', workCount: 3 } }),
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
