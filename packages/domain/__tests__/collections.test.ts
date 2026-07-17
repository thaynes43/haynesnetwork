// ADR-070 / DESIGN-043 (PLAN-052 — collection manager). Proves: the grants matrix
// (collectionActionsForRole — admin implies all, no-row deny, exactly-granted) + the setter's same-tx
// audit (update_collection_actions) + admin immutability; the suggestion lifecycle (create → approve
// materializes a recipe via the confined writer / decline with reason; audited same-tx + reviewer stamps);
// the acquire gate (a non-acquire approver cannot enable acquisition — CollectionAcquireForbiddenError);
// and the overview honest degrade (Libretto unreachable ⇒ reachable:false). Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectionSuggestions, permissionAudit, roleCollectionActionGrants, roles } from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { eq } from 'drizzle-orm';
import {
  CollectionAcquireForbiddenError,
  CollectionSuggestionNotOpenError,
  approveCollectionSuggestion,
  collectionActionsForRole,
  createCollectionSuggestion,
  declineCollectionSuggestion,
  getCollectionsOverview,
  listCollectionSuggestions,
  saveRecipe,
  setRoleCollectionActions,
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
  await t.db.delete(collectionSuggestions);
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

/** A recording stub for the confined Libretto write surface (upsertRecipe). */
function stubLibretto() {
  const recipes: Array<Record<string, unknown>> = [];
  const bundle = {
    read: {
      listRecipes: async () => ({ recipes, issues: [] }),
      listCollections: async () => [],
    },
    write: {
      upsertRecipe: async (draft: Record<string, unknown>) => void recipes.push(draft),
    },
  } as unknown as Parameters<typeof approveCollectionSuggestion>[0]['libretto'];
  return { recipes, bundle };
}

describe('collection action grants (ADR-070 C-03)', () => {
  it('admin implies every action with no rows', async () => {
    const roleId = await adminRoleId();
    expect(await collectionActionsForRole({ db: t.db, roleId, isAdmin: true })).toEqual([
      'suggest',
      'manage',
      'acquire',
    ]);
  });

  it('a non-admin role has NOTHING until granted, then exactly its grants (audited same-tx)', async () => {
    const roleId = await makeRole();
    const actor = await createUser(t.db);
    expect(await collectionActionsForRole({ db: t.db, roleId })).toEqual([]);

    await setRoleCollectionActions({ db: t.db, roleId, actions: ['suggest', 'manage'], actorId: actor.id });
    const got = await collectionActionsForRole({ db: t.db, roleId });
    expect(new Set(got)).toEqual(new Set(['suggest', 'manage']));
    // acquire is NOT implied by manage (ADR-070 C-04).
    expect(got.includes('acquire')).toBe(false);

    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_collection_actions'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { actions: string[] }).actions.sort()).toEqual(['manage', 'suggest']);
  });

  it('replace-set clears prior grants', async () => {
    const roleId = await makeRole();
    const actor = await createUser(t.db);
    await setRoleCollectionActions({ db: t.db, roleId, actions: ['suggest', 'manage', 'acquire'], actorId: actor.id });
    await setRoleCollectionActions({ db: t.db, roleId, actions: ['suggest'], actorId: actor.id });
    expect(await collectionActionsForRole({ db: t.db, roleId })).toEqual(['suggest']);
  });

  it('refuses to mutate the Admin role', async () => {
    const roleId = await adminRoleId();
    const actor = await createUser(t.db);
    await expect(
      setRoleCollectionActions({ db: t.db, roleId, actions: ['suggest'], actorId: actor.id }),
    ).rejects.toThrow(/ROLE_IMMUTABLE/);
  });
});

describe('the member suggestion lifecycle (ADR-070 C-05)', () => {
  it('create lands PENDING and audits create_collection_suggestion same-tx', async () => {
    const member = await createUser(t.db);
    const row = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'The Stormlight Archive',
      builderType: 'hardcover_series',
      builderRef: 'the-stormlight-archive',
      note: 'the series I started',
    });
    expect(row.status).toBe('pending');
    expect(row.provider).toBe('libretto');
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'create_collection_suggestion'));
    expect(audit).toHaveLength(1);
  });

  it('approve materializes the recipe via the confined writer (acquisition OFF by default) + audits', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    const s = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'Dune',
      builderType: 'static_ids',
      builderRef: 'dune-omnibus',
    });
    const approved = await approveCollectionSuggestion({
      db: t.db,
      libretto: bundle,
      suggestionId: s.id,
      reviewerId: admin.id,
      canAcquire: true, // reviewer HOLDS acquire but did not opt in — must stay OFF
    });
    expect(approved.status).toBe('approved');
    expect(approved.createdRecipeId).toBeTruthy();
    expect(approved.reviewedById).toBe(admin.id);
    expect(recipes).toHaveLength(1);
    expect((recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(false);
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'review_collection_suggestion'));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { decision: string }).decision).toBe('approved');
  });

  it('approve with enableAcquisition needs the acquire grant (FORBIDDEN otherwise)', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    const s = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'Wheel of Time',
      builderType: 'hardcover_series',
      builderRef: 'the-wheel-of-time',
    });
    await expect(
      approveCollectionSuggestion({
        db: t.db,
        libretto: bundle,
        suggestionId: s.id,
        reviewerId: admin.id,
        canAcquire: false,
        enableAcquisition: true,
      }),
    ).rejects.toBeInstanceOf(CollectionAcquireForbiddenError);
    // Nothing was written to Libretto, and the suggestion stays pending.
    expect(recipes).toHaveLength(0);
    const [still] = await t.db.select().from(collectionSuggestions).where(eq(collectionSuggestions.id, s.id));
    expect(still!.status).toBe('pending');
  });

  it('an acquire-holding reviewer CAN enable acquisition', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db);
    const { recipes, bundle } = stubLibretto();
    const s = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'Mistborn',
      builderType: 'hardcover_series',
      builderRef: 'the-mistborn-saga',
    });
    await approveCollectionSuggestion({
      db: t.db,
      libretto: bundle,
      suggestionId: s.id,
      reviewerId: admin.id,
      canAcquire: true,
      enableAcquisition: true,
    });
    expect((recipes[0]!.variables as { acquisitionEnabled: boolean }).acquisitionEnabled).toBe(true);
  });

  it('decline stamps declined + reason + reviewer, audited', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db);
    const s = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'Something Off',
      builderType: 'nyt_list',
      builderRef: 'not-a-real-list',
    });
    const declined = await declineCollectionSuggestion({
      db: t.db,
      suggestionId: s.id,
      reviewerId: admin.id,
      reason: 'that list is not carried',
    });
    expect(declined.status).toBe('declined');
    expect(declined.decisionNote).toBe('that list is not carried');
    expect(declined.reviewedById).toBe(admin.id);
  });

  it('a second review of a non-pending suggestion is refused (race guard)', async () => {
    const member = await createUser(t.db);
    const admin = await createUser(t.db);
    const s = await createCollectionSuggestion({
      db: t.db,
      suggesterId: member.id,
      name: 'Dune Two',
      builderType: 'static_ids',
      builderRef: 'x',
    });
    await declineCollectionSuggestion({ db: t.db, suggestionId: s.id, reviewerId: admin.id, reason: 'no' });
    await expect(
      declineCollectionSuggestion({ db: t.db, suggestionId: s.id, reviewerId: admin.id, reason: 'again' }),
    ).rejects.toBeInstanceOf(CollectionSuggestionNotOpenError);
  });

  it('lists a member’s own suggestions and the pending queue', async () => {
    const member = await createUser(t.db);
    await createCollectionSuggestion({ db: t.db, suggesterId: member.id, name: 'A', builderType: 'static_ids', builderRef: 'a' });
    await createCollectionSuggestion({ db: t.db, suggesterId: member.id, name: 'B', builderType: 'static_ids', builderRef: 'b' });
    expect(await listCollectionSuggestions({ db: t.db, suggesterId: member.id })).toHaveLength(2);
    expect(await listCollectionSuggestions({ db: t.db, status: 'pending' })).toHaveLength(2);
  });
});

describe('saveRecipe acquire gate + overview honest degrade', () => {
  it('saveRecipe refuses acquisitionEnabled without canAcquire', async () => {
    const { recipes, bundle } = stubLibretto();
    await expect(
      saveRecipe({
        libretto: bundle,
        draft: { id: 'x', builder: { type: 'static_ids', ref: 'y' }, variables: { acquisitionEnabled: true } },
        canAcquire: false,
      }),
    ).rejects.toBeInstanceOf(CollectionAcquireForbiddenError);
    expect(recipes).toHaveLength(0);
  });

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
