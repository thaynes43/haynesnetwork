// ADR-080 (PLAN-041 Gap B — per-role media-action rate budgets). Proves the single-writer
// (setRoleMediaActionBudget: 0..1000, refuses Admin, audits in-tx), the resolver
// (effectiveMediaActionBudget: admin bypass → the role's row → fallback 25), and the wiring into
// every budget check: per-role differentiation on the arr pool, the fallback when a role has no row,
// admin bypass, 0 blocking non-admins, the two pools staying SEPARATE (arr Fix + Force Search share
// one counter; books Fix + book-item Force Search share the other), and books Force Search now drawing
// the books pool. Embedded PG16 (CLAUDE.md rule 1); every guarded write goes through a single-writer.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  bookFixRequests,
  bookRequests,
  booksItems,
  fixRequests,
  ledgerEvents,
  mediaItems,
  permissionAudit,
  roleMediaActionBudgets,
  roles,
} from '@hnet/db';
import {
  BookFixRateLimitError,
  FixRateLimitError,
  MediaActionBudgetRangeError,
  MEDIA_ACTION_BUDGET_FALLBACK,
  SystemRoleImmutableError,
  createBookFixRequest,
  createFixRequest,
  createRole,
  effectiveMediaActionBudget,
  recordSearchRequest,
  runBookItemForceSearch,
  setRoleMediaActionBudget,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
let sonarrItemId: string;
let radarrItemId: string;
let adminActorId: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  adminActorId = (await createUser(t.db, { email: 'actor@example.com' })).id;
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'sonarr',
    items: [
      {
        arrItemId: 1,
        tvdbId: 111,
        title: 'Budget Show',
        sortTitle: 'budget show',
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
      },
    ],
  });
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'radarr',
    items: [
      {
        arrItemId: 1,
        tmdbId: 222,
        title: 'Budget Movie',
        sortTitle: 'budget movie',
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/movies',
      },
    ],
  });
  const items = await t.db.select().from(mediaItems);
  sonarrItemId = items.find((i) => i.arrKind === 'sonarr')!.id;
  radarrItemId = items.find((i) => i.arrKind === 'radarr')!.id;
});

afterAll(async () => {
  await t?.stop();
});

// Clean the per-test state (never the seeded media items); role/budget rows go through the
// single-writer / createRole, so we clear them by clearing the derived write tables here.
beforeEach(async () => {
  await t.db.delete(fixRequests);
  await t.db.delete(ledgerEvents);
  await t.db.delete(bookFixRequests);
  await t.db.delete(bookRequests);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
});

/** Create a role, set its budget through the single-writer, and return its id + a user in it. */
async function roleWithBudget(name: string, fixPerHour: number): Promise<{ roleId: string; userId: string }> {
  const { roleId } = await createRole({ db: t.db, name, actorId: adminActorId });
  await setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour, actorId: adminActorId });
  const userId = (await createUser(t.db, { roleId })).id;
  return { roleId, userId };
}

let extSeq = 0;
async function seedBook(kind: 'book' | 'audiobook' = 'book'): Promise<string> {
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source: kind === 'audiobook' ? 'audiobookshelf' : 'kavita',
      mediaKind: kind,
      externalId: `ext-${++extSeq}`,
      libraryId: '1',
      libraryName: 'Lib',
      title: 'On Disk Copy',
      sortTitle: 'on disk copy',
      deepLinkUrl: 'http://x',
    })
    .returning({ id: booksItems.id });
  return row!.id;
}

async function seedIdentity(booksItemId: string, llBookId: string): Promise<void> {
  await t.db.insert(bookRequests).values({
    origin: 'pairing',
    pairingBooksItemId: booksItemId,
    matchedBooksItemId: booksItemId,
    title: 'On Disk Copy',
    llBookId,
  });
}

function stubLl() {
  const bundle = {
    write: {
      addBook: async () => {},
      queueBook: async () => {},
      searchBook: async () => {},
    },
  } as unknown as Parameters<typeof runBookItemForceSearch>[0]['ll'];
  return bundle;
}

describe('setRoleMediaActionBudget (single-writer)', () => {
  it('upserts the row AND writes an update_media_action_budget audit in the SAME tx (before/after)', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Auditable', actorId: adminActorId });

    // First edit: before is the fallback (no row yet), after is the new value.
    const first = await setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: 7, actorId: adminActorId });
    expect(first).toEqual({ changed: true, before: MEDIA_ACTION_BUDGET_FALLBACK, after: 7 });

    const [row] = await t.db
      .select()
      .from(roleMediaActionBudgets)
      .where(eq(roleMediaActionBudgets.roleId, roleId));
    expect(row?.fixPerHour).toBe(7);

    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(and(eq(permissionAudit.action, 'update_media_action_budget'), eq(permissionAudit.roleId, roleId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ before: MEDIA_ACTION_BUDGET_FALLBACK, after: 7 });

    // Second edit: before is now the stored value.
    const second = await setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: 3, actorId: adminActorId });
    expect(second).toEqual({ changed: true, before: 7, after: 3 });
  });

  it('refuses the Admin role (it bypasses budgets) with ROLE_IMMUTABLE', async () => {
    const [admin] = await t.db.select().from(roles).where(eq(roles.isAdmin, true));
    await expect(
      setRoleMediaActionBudget({ db: t.db, roleId: admin!.id, fixPerHour: 5, actorId: adminActorId }),
    ).rejects.toThrow(SystemRoleImmutableError);
    // No row, no audit written for the refused mutation.
    expect(
      await t.db.select().from(roleMediaActionBudgets).where(eq(roleMediaActionBudgets.roleId, admin!.id)),
    ).toHaveLength(0);
  });

  it('validates 0..1000 (rejects negative, > 1000, and non-integers)', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Ranged', actorId: adminActorId });
    for (const bad of [-1, 1001, 25.5]) {
      await expect(
        setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: bad, actorId: adminActorId }),
      ).rejects.toThrow(MediaActionBudgetRangeError);
    }
    // The bounds themselves are accepted.
    await expect(
      setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: 0, actorId: adminActorId }),
    ).resolves.toMatchObject({ after: 0 });
    await expect(
      setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: 1000, actorId: adminActorId }),
    ).resolves.toMatchObject({ after: 1000 });
  });
});

describe('effectiveMediaActionBudget (resolver)', () => {
  it('returns the role row when present, the fallback when absent, and null for admin', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'Resolver', actorId: adminActorId });
    // No row ⇒ fallback.
    expect(await effectiveMediaActionBudget({ db: t.db, roleId })).toBe(MEDIA_ACTION_BUDGET_FALLBACK);
    // A row ⇒ its value.
    await setRoleMediaActionBudget({ db: t.db, roleId, fixPerHour: 4, actorId: adminActorId });
    expect(await effectiveMediaActionBudget({ db: t.db, roleId })).toBe(4);
    // Admin ⇒ null (bypass), whether resolved by id, by role object, or by the isAdmin flag.
    const [admin] = await t.db.select().from(roles).where(eq(roles.isAdmin, true));
    expect(await effectiveMediaActionBudget({ db: t.db, roleId: admin!.id })).toBeNull();
    expect(await effectiveMediaActionBudget({ db: t.db, role: { id: admin!.id, isAdmin: true } })).toBeNull();
    expect(await effectiveMediaActionBudget({ db: t.db, isAdmin: true })).toBeNull();
  });
});

describe('arr pool — per-role differentiation, fallback, admin bypass, zero blocks', () => {
  async function fix(userId: string, child: number) {
    return createFixRequest({
      db: t.db,
      requesterId: userId,
      mediaItemId: sonarrItemId,
      targetArrChildId: child,
      reason: 'wrong_version_quality',
    });
  }

  it('two roles with different budgets trip at their OWN numbers', async () => {
    const tight = await roleWithBudget('Tight', 2);
    const loose = await roleWithBudget('Loose', 5);

    // Tight: 2 succeed, the 3rd trips.
    await fix(tight.userId, 1);
    await fix(tight.userId, 2);
    await expect(fix(tight.userId, 3)).rejects.toThrow(FixRateLimitError);

    // Loose (same window, different role): 5 succeed, the 6th trips.
    for (let i = 10; i < 15; i++) await fix(loose.userId, i);
    await expect(fix(loose.userId, 15)).rejects.toThrow(FixRateLimitError);
  });

  it('a role with no budget row falls back to 25', async () => {
    const { roleId } = await createRole({ db: t.db, name: 'NoRow', actorId: adminActorId });
    const userId = (await createUser(t.db, { roleId })).id;
    for (let i = 0; i < MEDIA_ACTION_BUDGET_FALLBACK; i++) await fix(userId, 100 + i);
    await expect(fix(userId, 999)).rejects.toThrow(FixRateLimitError);
  });

  it('admins bypass entirely (requesterIsAdmin), regardless of any budget', async () => {
    const admin = await createUser(t.db, { email: 'bypass@example.com' });
    for (let i = 0; i < MEDIA_ACTION_BUDGET_FALLBACK + 3; i++) {
      const res = await createFixRequest({
        db: t.db,
        requesterId: admin.id,
        requesterIsAdmin: true,
        mediaItemId: sonarrItemId,
        targetArrChildId: 200 + i,
        reason: 'wrong_version_quality',
      });
      expect(res.status).toBe('pending');
    }
  });

  it('a budget of 0 blocks a non-admin on the very first action (C-05)', async () => {
    const blocked = await roleWithBudget('Blocked', 0);
    await expect(fix(blocked.userId, 1)).rejects.toThrow(FixRateLimitError);
    // Nothing landed.
    expect(
      await t.db.select().from(fixRequests).where(eq(fixRequests.requesterId, blocked.userId)),
    ).toHaveLength(0);
  });

  it('Fix and Force Search SHARE the arr-pool counter (D-17 unchanged)', async () => {
    const { userId } = await roleWithBudget('Shared', 2);
    await fix(userId, 1); // arr pool = 1
    await recordSearchRequest({ db: t.db, requesterId: userId, mediaItemId: radarrItemId }); // = 2
    // The next of EITHER kind is blocked by the shared budget.
    await expect(
      recordSearchRequest({ db: t.db, requesterId: userId, mediaItemId: radarrItemId }),
    ).rejects.toThrow(FixRateLimitError);
    await expect(fix(userId, 2)).rejects.toThrow(FixRateLimitError);
  });
});

describe('books pool — separate from the arr pool; Force Search now draws it', () => {
  async function bookFix(userId: string, booksItemId: string) {
    return createBookFixRequest({
      db: t.db,
      requesterId: userId,
      booksItemId,
      reason: 'corrupt_file',
    });
  }

  it('book Fix draws the role budget on the BOOKS pool independently of the arr pool', async () => {
    const { userId } = await roleWithBudget('Reader', 2);
    // Exhaust the ARR pool.
    await createFixRequest({
      db: t.db,
      requesterId: userId,
      mediaItemId: sonarrItemId,
      targetArrChildId: 1,
      reason: 'wrong_version_quality',
    });
    await createFixRequest({
      db: t.db,
      requesterId: userId,
      mediaItemId: sonarrItemId,
      targetArrChildId: 2,
      reason: 'wrong_version_quality',
    });
    // The BOOKS pool is untouched — a book Fix still goes through (pools are separate).
    const b1 = await seedBook();
    await expect(bookFix(userId, b1)).resolves.toBeDefined();
  });

  it('book-item Force Search draws the SAME books pool as book Fix (closes the unbudgeted hole)', async () => {
    const { userId } = await roleWithBudget('Bookish', 2);
    const fsBook = await seedBook();
    await seedIdentity(fsBook, 'gb-1');
    // Two Force Searches consume the whole books budget of 2.
    await runBookItemForceSearch({ db: t.db, booksItemId: fsBook, requesterId: userId, ll: stubLl() });
    await runBookItemForceSearch({ db: t.db, booksItemId: fsBook, requesterId: userId, ll: stubLl() });
    // A book Fix on a DIFFERENT title is now blocked — Force Search drew the pool down.
    const other = await seedBook();
    await expect(bookFix(userId, other)).rejects.toThrow(BookFixRateLimitError);
    // A third Force Search is likewise blocked (before any audit or external call).
    await expect(
      runBookItemForceSearch({ db: t.db, booksItemId: fsBook, requesterId: userId, ll: stubLl() }),
    ).rejects.toThrow(BookFixRateLimitError);
  });

  it('admins bypass the books pool (Force Search)', async () => {
    const admin = await createUser(t.db, { email: 'bookadmin@example.com' });
    const fsBook = await seedBook();
    await seedIdentity(fsBook, 'gb-2');
    for (let i = 0; i < MEDIA_ACTION_BUDGET_FALLBACK + 2; i++) {
      const res = await runBookItemForceSearch({
        db: t.db,
        booksItemId: fsBook,
        requesterId: admin.id,
        requesterIsAdmin: true,
        ll: stubLl(),
      });
      expect(res).toEqual({ searched: true });
    }
  });
});
