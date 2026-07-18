// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add). Proves: the find_missing grant matrix
// (collectionActionsForRole — admin implies all, no-row deny, exactly-granted) + the setter's same-tx
// audit (update_collection_actions) + admin immutability; the DIRECT upsert writer (cap assert + confined
// write + same-tx upsert_collection audit; admin bypass; over-cap refusal writes nothing); the over-cap
// ticket → approve materializes (unbounded) + completes in one flow, decline materializes nothing; and the
// overview honest degrade (Libretto unreachable ⇒ reachable:false). Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionAudit, roleCollectionActionGrants, roles, tickets } from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { eq } from 'drizzle-orm';
import {
  CollectionOverrideNotActionableError,
  CollectionSizeCapError,
  NotFoundError,
  approveCollectionOverride,
  collectionActionsForRole,
  createCollectionOverrideTicket,
  declineCollectionOverride,
  deleteCollectionRecipe,
  getCollectionsOverview,
  listCollectionOverrideTickets,
  setCollectionFindMissing,
  setRoleCollectionActions,
  upsertCollection,
} from '../src/index';
import type { CollectionOverridePayload } from '@hnet/db';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(tickets);
  await t.db.delete(roleCollectionActionGrants);
  await t.db.delete(permissionAudit);
});

async function adminRoleId(): Promise<string> {
  const [row] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.isAdmin, true));
  return row!.id;
}
async function makeRole(): Promise<string> {
  const [role] = await t.db
    .insert(roles)
    .values({ name: `r-${Math.random().toString(36).slice(2)}`, isAdmin: false })
    .returning();
  return role!.id;
}

/** A recording stub for the confined Libretto surface (upsert/delete/validate/read). */
function stubLibretto() {
  const recipes: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const bundle = {
    read: {
      listRecipes: async () => ({ recipes, issues: [] }),
      listCollections: async () => [],
    },
    write: {
      upsertRecipe: async (draft: Record<string, unknown>) => void recipes.push(draft),
      deleteRecipe: async (id: string) => void deleted.push(id),
    },
  } as unknown as Parameters<typeof upsertCollection>[0]['libretto'];
  return { recipes, deleted, bundle };
}

const draft = (over?: Record<string, unknown>) => ({
  id: 'stormlight',
  name: 'The Stormlight Archive',
  builder: { type: 'hardcover_series', ref: 'the-stormlight-archive' },
  variables: { syncMode: 'sync' as const, ordered: true },
  enabled: true,
  ...over,
});

const payload = (over?: Partial<CollectionOverridePayload>): CollectionOverridePayload => ({
  provider: 'libretto',
  mediaType: 'books',
  recipeId: 'imdb-top-200',
  name: 'Big List',
  builderType: 'nyt_list',
  builderRef: 'top-200',
  size: 200,
  ...over,
});

describe('collection action grants — rebuilt to find_missing (ADR-072 / DESIGN-043 D-14)', () => {
  it('admin implies the whole (single) action set with no rows', async () => {
    const roleId = await adminRoleId();
    expect(await collectionActionsForRole({ db: t.db, roleId, isAdmin: true })).toEqual(['find_missing']);
  });

  it('a non-admin role has NOTHING until granted find_missing, then exactly it (audited same-tx)', async () => {
    const roleId = await makeRole();
    const actor = await createUser(t.db);
    expect(await collectionActionsForRole({ db: t.db, roleId })).toEqual([]);

    await setRoleCollectionActions({ db: t.db, roleId, actions: ['find_missing'], actorId: actor.id });
    expect(await collectionActionsForRole({ db: t.db, roleId })).toEqual(['find_missing']);

    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_collection_actions'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { actions: string[] }).actions).toEqual(['find_missing']);
  });

  it('replace-set clears prior grants', async () => {
    const roleId = await makeRole();
    const actor = await createUser(t.db);
    await setRoleCollectionActions({ db: t.db, roleId, actions: ['find_missing'], actorId: actor.id });
    await setRoleCollectionActions({ db: t.db, roleId, actions: [], actorId: actor.id });
    expect(await collectionActionsForRole({ db: t.db, roleId })).toEqual([]);
  });

  it('refuses to mutate the Admin role', async () => {
    const roleId = await adminRoleId();
    const actor = await createUser(t.db);
    await expect(
      setRoleCollectionActions({ db: t.db, roleId, actions: ['find_missing'], actorId: actor.id }),
    ).rejects.toThrow(/ROLE_IMMUTABLE/);
  });
});

describe('direct upsert — capped, audited (D-03/D-10)', () => {
  it('a within-cap add writes the recipe (acquisition OFF) + a same-tx upsert_collection audit', async () => {
    const user = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    await upsertCollection({
      db: t.db,
      libretto: bundle,
      actorId: user.id,
      draft: draft(),
      size: 10,
      cap: 25,
      isAdmin: false,
    });
    expect(recipes).toHaveLength(1);
    expect((recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(false);
    const audit = await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'upsert_collection'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { recipe_id: string }).recipe_id).toBe('stormlight');
  });

  it('an over-cap non-admin add is REFUSED (CollectionSizeCapError) and writes nothing', async () => {
    const user = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    await expect(
      upsertCollection({ db: t.db, libretto: bundle, actorId: user.id, draft: draft(), size: 40, cap: 25, isAdmin: false }),
    ).rejects.toBeInstanceOf(CollectionSizeCapError);
    expect(recipes).toHaveLength(0);
    expect(await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'upsert_collection'))).toHaveLength(0);
  });

  it('an admin bypasses the cap outright (a 500-item add lands)', async () => {
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    await upsertCollection({ db: t.db, libretto: bundle, actorId: admin.id, draft: draft(), size: 500, cap: 25, isAdmin: true });
    expect(recipes).toHaveLength(1);
  });

  it('delete writes the confined delete + a same-tx delete_collection audit', async () => {
    const admin = await createUser(t.db);
    const { deleted, bundle } = stubLibretto();
    await deleteCollectionRecipe({ db: t.db, libretto: bundle, actorId: admin.id, id: 'stormlight', deleteCollection: true });
    expect(deleted).toEqual(['stormlight']);
    const audit = await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'delete_collection'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { also_delete_collection: boolean }).also_delete_collection).toBe(true);
  });
});

describe('setCollectionFindMissing — Libretto acquisition knob (PR4c / D-14)', () => {
  it('flips acquisitionEnabled ON via a full re-PUT + a same-tx upsert_collection(find_missing) audit', async () => {
    const user = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    // Seed the recipe (acquisition OFF) so listRecipes can find it for the re-PUT.
    await upsertCollection({ db: t.db, libretto: bundle, actorId: user.id, draft: draft(), size: 5, cap: 25, isAdmin: false });
    await t.db.delete(permissionAudit); // isolate the find-missing audit

    const res = await setCollectionFindMissing({ db: t.db, libretto: bundle, actorId: user.id, id: 'stormlight', on: true });
    expect(res.findMissing).toBe(true);
    const last = recipes[recipes.length - 1]!;
    expect((last.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(true);
    // The re-PUT preserved the builder (a full PUT, not a partial patch).
    expect((last.builder as { type: string }).type).toBe('hardcover_series');
    const audit = await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'upsert_collection'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { find_missing?: boolean }).find_missing).toBe(true);
  });

  it('a recipe that does not exist is a NotFound (writes nothing)', async () => {
    const user = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    await expect(
      setCollectionFindMissing({ db: t.db, libretto: bundle, actorId: user.id, id: 'ghost', on: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(recipes).toHaveLength(0);
  });
});

describe('over-cap ticket → approve materializes / decline does not (D-11)', () => {
  it('approve materializes the collection unbounded (confined write) + completes the ticket in one flow', async () => {
    const user = await createUser(t.db);
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    const ticket = await createCollectionOverrideTicket({ db: t.db, authorId: user.id, cap: 25, payload: payload({ size: 200 }) });

    const res = await approveCollectionOverride({ db: t.db, libretto: bundle, ticketId: ticket.id, actorId: admin.id });
    expect(res.ticket.status).toBe('complete');
    // The full-size recipe was materialized (acquisition OFF), driven from the payload.
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.id).toBe('imdb-top-200');
    expect((recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(false);
    // The ticket transition history row landed (the transition audit).
    const [reloaded] = await t.db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(reloaded!.status).toBe('complete');
  });

  it('decline materializes nothing and rejects the ticket with the reason', async () => {
    const user = await createUser(t.db);
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    void bundle;
    const ticket = await createCollectionOverrideTicket({ db: t.db, authorId: user.id, cap: 25, payload: payload() });
    const res = await declineCollectionOverride({ db: t.db, ticketId: ticket.id, actorId: admin.id, reason: 'too large for now' });
    expect(res.ticket.status).toBe('rejected');
    expect(recipes).toHaveLength(0);
  });

  it('approving an already-decided request is refused (CollectionOverrideNotActionableError)', async () => {
    const user = await createUser(t.db);
    const admin = await createUser(t.db);
    const { bundle } = stubLibretto();
    const ticket = await createCollectionOverrideTicket({ db: t.db, authorId: user.id, cap: 25, payload: payload() });
    await declineCollectionOverride({ db: t.db, ticketId: ticket.id, actorId: admin.id, reason: 'no' });
    await expect(
      approveCollectionOverride({ db: t.db, libretto: bundle, ticketId: ticket.id, actorId: admin.id }),
    ).rejects.toBeInstanceOf(CollectionOverrideNotActionableError);
  });

  it('lists the requester own tickets and (unfiltered) all of them', async () => {
    const a = await createUser(t.db);
    const b = await createUser(t.db);
    await createCollectionOverrideTicket({ db: t.db, authorId: a.id, cap: 25, payload: payload({ recipeId: 'x', name: 'X' }) });
    await createCollectionOverrideTicket({ db: t.db, authorId: b.id, cap: 25, payload: payload({ recipeId: 'y', name: 'Y' }) });
    expect(await listCollectionOverrideTickets({ db: t.db, authorId: a.id })).toHaveLength(1);
    expect(await listCollectionOverrideTickets({ db: t.db })).toHaveLength(2);
  });
});

describe('overview honest degrade', () => {
  it('getCollectionsOverview degrades to reachable:false when Libretto is unreachable', async () => {
    const bundle = {
      read: {
        listRecipes: async () => {
          throw new LibrettoUnreachableError('GET', '/api/recipes');
        },
        listCollections: async () => [],
      },
      write: {},
    } as unknown as Parameters<typeof getCollectionsOverview>[0]['libretto'];
    const overview = await getCollectionsOverview({ libretto: bundle });
    expect(overview.reachable).toBe(false);
    expect(overview.recipes).toEqual([]);
  });
});
