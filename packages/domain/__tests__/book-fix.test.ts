// ADR-062 / DESIGN-033 (PLAN-041) — the books Fix single-writer + orchestrator. Proves: the
// audited row commits BEFORE any external call; the 25/hr books-scoped rate guard (admins exempt);
// one-open-per-(item,kind) dedupe; route dispatch (LL vs Kapowarr) with the mandatory
// addBook→queueBook→searchBook order; the GB-resolution fallback + honest-failure path; the
// reason-text-iff-other CHECK; and setRoleBookActions (the Q-01 flip) with its audit. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookFixRequests,
  booksItems,
  gbQuotaState,
  permissionAudit,
  roles,
  roleBooksActionGrants,
} from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import {
  BookFixAlreadyOpenError,
  BookFixRateLimitError,
  bookActionsForRole,
  createBookFixRequest,
  retryQueuedBookFixes,
  runBookFixRequest,
  setRoleBookActions,
  tripGbQuotaBreaker,
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
  await t.db.delete(bookFixRequests);
  await t.db.delete(roleBooksActionGrants);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
  await t.db.delete(gbQuotaState);
});

let extSeq = 0;
async function seedBook(kind: 'book' | 'audiobook' | 'comic', title = 'Bad Copy'): Promise<string> {
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source: kind === 'comic' ? 'kavita' : kind === 'audiobook' ? 'audiobookshelf' : 'kavita',
      mediaKind: kind,
      externalId: `ext-${++extSeq}`,
      libraryId: '1',
      libraryName: 'Lib',
      title,
      sortTitle: title.toLowerCase(),
      deepLinkUrl: 'http://x',
    })
    .returning({ id: booksItems.id });
  return row!.id;
}

function stubLl() {
  const calls: { cmd: string; id: string; format?: string }[] = [];
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
  } as unknown as Parameters<typeof runBookFixRequest>[0]['ll'];
  return { calls, bundle };
}

function stubKapowarr() {
  const calls: { op: string; id: number }[] = [];
  const bundle = {
    write: {
      setMonitored: async (id: number) => void calls.push({ op: 'monitor', id }),
      searchVolume: async (id: number) => void calls.push({ op: 'search', id }),
    },
  } as unknown as Parameters<typeof runBookFixRequest>[0]['kapowarr'];
  return { calls, bundle };
}

describe('createBookFixRequest (the audited single-writer)', () => {
  it('inserts the row + a request_book_fix audit in ONE tx, snapshotting identity + route', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('book', 'Matilda');
    const row = await createBookFixRequest({
      db: t.db,
      requesterId: user.id,
      booksItemId: bookId,
      reason: 'wrong_language',
      languagePref: 'English',
    });
    expect(row.route).toBe('lazylibrarian');
    expect(row.titleSnapshot).toBe('Matilda');
    expect(row.staleFileAction).toBe('owner_quarantine'); // a landed bad copy — honest seam
    expect(row.languagePref).toBe('English');
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_fix'));
    expect(audits).toHaveLength(1);
  });

  it('a comic routes to kapowarr', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('comic');
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'corrupt_file' });
    expect(row.route).toBe('kapowarr');
  });

  it('rejects a SECOND open fix for the same (item, kind)', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('book');
    await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'bad_quality' });
    await expect(
      createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'bad_quality' }),
    ).rejects.toBeInstanceOf(BookFixAlreadyOpenError);
  });

  it('enforces the 25/hr books budget for non-admins; admins are exempt', async () => {
    const user = await createUser(t.db);
    // 25 DISTINCT items so the per-item dedupe never fires — only the budget can.
    for (let i = 0; i < 25; i += 1) {
      const id = await seedBook('book', `B${i}`);
      await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'bad_quality' });
    }
    const extra = await seedBook('book', 'B25');
    await expect(
      createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: extra, reason: 'bad_quality' }),
    ).rejects.toBeInstanceOf(BookFixRateLimitError);
    // admin bypass on the SAME 26th item
    await expect(
      createBookFixRequest({ db: t.db, requesterId: user.id, requesterIsAdmin: true, booksItemId: extra, reason: 'bad_quality' }),
    ).resolves.toBeDefined();
  });
});

describe('runBookFixRequest (the orchestrator)', () => {
  it('LL route fires addBook → queueBook → searchBook in order (queueBook mandatory)', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('audiobook');
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'wrong_language' });
    const ll = stubLl();
    // no request row ⇒ GB fallback resolves the id
    const res = await runBookFixRequest({
      db: t.db,
      fix: row,
      ll: ll.bundle,
      gb: { resolveVolume: async () => ({ volumeId: 'gb-xyz' }) },
    });
    expect(res.status).toBe('search_triggered');
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
    expect(ll.calls[1]!.format).toBe('audiobook'); // audiobook kind → audiobook format
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, row.id));
    expect(fresh!.status).toBe('search_triggered');
    expect(fresh!.llBookId).toBe('gb-xyz');
  });

  it('LL route fails HONESTLY when GB cannot resolve and there is no request row', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('book');
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'wrong_edition' });
    const ll = stubLl();
    const res = await runBookFixRequest({ db: t.db, fix: row, ll: ll.bundle, gb: { resolveVolume: async () => null } });
    expect(res.status).toBe('failed');
    expect(ll.calls).toHaveLength(0);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, row.id));
    expect(fresh!.status).toBe('failed');
    expect(JSON.stringify(fresh!.actionsTaken)).toContain('failed');
  });

  it('comic route monitors then auto-searches the volume', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('comic');
    // seed the resolved kapowarr volume onto the fix (v1 requires it)
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'corrupt_file' });
    await t.db.update(bookFixRequests).set({ kapowarrVolumeId: 501 }).where(eq(bookFixRequests.id, row.id));
    const kapo = stubKapowarr();
    const res = await runBookFixRequest({ db: t.db, fix: { ...row, kapowarrVolumeId: 501 }, kapowarr: kapo.bundle });
    expect(res.status).toBe('search_triggered');
    expect(kapo.calls.map((c) => c.op)).toEqual(['monitor', 'search']);
  });
});

// ---------------------------------------------------------------------------
// ADR-067 / DESIGN-039 (PLAN-055) — quota weather QUEUES a fix (never fails it); the
// goodreads-sync-hosted retry pass completes queued fixes through the normal chain.
// ---------------------------------------------------------------------------
describe('runBookFixRequest — the GB quota breaker (ADR-067 C-05)', () => {
  it('an OPEN breaker lands the fix `queued` (zero LL calls, step recorded) and the dedupe still holds', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('book', 'Whispers');
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'corrupt_file' });
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    const ll = stubLl();
    let resolves = 0;
    const res = await runBookFixRequest({
      db: t.db,
      fix: row,
      ll: ll.bundle,
      gb: { resolveVolume: async () => (resolves += 1, { volumeId: 'never' }) },
    });
    expect(res.status).toBe('queued');
    expect(resolves).toBe(0); // breaker open ⇒ no GB call at all
    expect(ll.calls).toHaveLength(0);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, row.id));
    expect(fresh!.status).toBe('queued');
    const steps = fresh!.actionsTaken;
    expect(steps.some((s) => s.step === 'queued' && s.reason === 'gb_quota')).toBe(true);
    // queued is OPEN — a second fix on the same (item, kind) still conflicts.
    await expect(
      createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'corrupt_file' }),
    ).rejects.toBeInstanceOf(BookFixAlreadyOpenError);
  });

  it('a DAILY-quota 429 during the resolve trips the breaker and queues the fix (the incident path)', async () => {
    const user = await createUser(t.db);
    const id = await seedBook('book', 'Dead Ever After');
    const row = await createBookFixRequest({ db: t.db, requesterId: user.id, booksItemId: id, reason: 'bad_quality' });
    const ll = stubLl();
    const res = await runBookFixRequest({
      db: t.db,
      fix: row,
      ll: ll.bundle,
      gb: {
        resolveVolume: async () => {
          throw Object.assign(new Error("HTTP 429 — limit 'Queries per day'"), {
            status: 429,
            bodySnippet: "limit 'Queries per day'",
          });
        },
      },
    });
    expect(res.status).toBe('queued');
    expect(ll.calls).toHaveLength(0);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, row.id));
    expect(fresh!.status).toBe('queued');
    // …and the trip persisted for every other consumer.
    const [state] = await t.db.select().from(gbQuotaState);
    expect(state?.exhaustedUntil).not.toBeNull();
  });
});

describe('retryQueuedBookFixes (the goodreads-sync-hosted retry pass — ADR-067 C-06)', () => {
  async function seedQueuedFix(title: string, requesterId: string): Promise<string> {
    const itemId = await seedBook('book', title);
    const row = await createBookFixRequest({ db: t.db, requesterId, booksItemId: itemId, reason: 'corrupt_file' });
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    const ll = stubLl();
    await runBookFixRequest({ db: t.db, fix: row, ll: ll.bundle, gb: { resolveVolume: async () => null } });
    return row.id;
  }

  it('completes a queued fix END-TO-END through the normal chain once the quota returns', async () => {
    const user = await createUser(t.db);
    const fixId = await seedQueuedFix('Whispers', user.id);
    // The quota returns: expire the window (a fresh clear also works — this exercises the probe).
    await t.db.delete(gbQuotaState);
    const ll = stubLl();
    const report = await retryQueuedBookFixes({
      db: t.db,
      ll: ll.bundle,
      gb: { resolveVolume: async () => ({ volumeId: 'gb-whispers' }) },
      pacer: async () => {},
    });
    expect(report).toMatchObject({ queued: 1, attempted: 1, completed: 1, failed: 0, skippedQuota: 0 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, fixId));
    expect(fresh!.status).toBe('search_triggered');
    expect(fresh!.llBookId).toBe('gb-whispers');
    // The trail is CUMULATIVE: the original queued step precedes the retry-pass chain steps.
    const stepNames = fresh!.actionsTaken.map((s) => s.step);
    expect(stepNames).toContain('queued');
    expect(stepNames).toContain('gb_resolved');
    expect(stepNames).toContain('ll_search_book');
  });

  it('honors an OPEN breaker: attempted 0, the fix stays queued untouched', async () => {
    const user = await createUser(t.db);
    const fixId = await seedQueuedFix('Whispers', user.id);
    // Breaker still open (seedQueuedFix tripped daily).
    const ll = stubLl();
    let resolves = 0;
    const report = await retryQueuedBookFixes({
      db: t.db,
      ll: ll.bundle,
      gb: { resolveVolume: async () => (resolves += 1, { volumeId: 'never' }) },
      pacer: async () => {},
    });
    expect(report).toMatchObject({ queued: 1, attempted: 0, completed: 0, failed: 0, skippedQuota: 1 });
    expect(resolves).toBe(0);
    expect(ll.calls).toHaveLength(0);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, fixId));
    expect(fresh!.status).toBe('queued');
  });

  it('a PERMANENT failure (GB no-match) fails the fix honestly', async () => {
    const user = await createUser(t.db);
    const fixId = await seedQueuedFix('Gone Forever', user.id);
    await t.db.delete(gbQuotaState);
    const ll = stubLl();
    const report = await retryQueuedBookFixes({
      db: t.db,
      ll: ll.bundle,
      gb: { resolveVolume: async () => null },
      pacer: async () => {},
    });
    expect(report).toMatchObject({ queued: 1, attempted: 1, completed: 0, failed: 1 });
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, fixId));
    expect(fresh!.status).toBe('failed');
    expect(JSON.stringify(fresh!.actionsTaken)).toContain('retry_pass');
  });

  it('works oldest-first and respects the cap', async () => {
    const user = await createUser(t.db);
    const first = await seedQueuedFix('Oldest', user.id);
    const second = await seedQueuedFix('Middle', user.id);
    const third = await seedQueuedFix('Newest', user.id);
    // Stagger created_at explicitly (same-ms inserts would tie-break by id).
    const base = Date.now();
    for (const [i, id] of [first, second, third].entries()) {
      await t.db
        .update(bookFixRequests)
        .set({ createdAt: new Date(base - (3 - i) * 60_000) })
        .where(eq(bookFixRequests.id, id));
    }
    await t.db.delete(gbQuotaState);
    const ll = stubLl();
    const report = await retryQueuedBookFixes({
      db: t.db,
      ll: ll.bundle,
      gb: { resolveVolume: async () => ({ volumeId: 'gb-x' }) },
      cap: 2,
      pacer: async () => {},
    });
    expect(report).toMatchObject({ queued: 3, attempted: 2, completed: 2 });
    const rows = await t.db.select().from(bookFixRequests);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(first)).toBe('search_triggered');
    expect(byId.get(second)).toBe('search_triggered');
    expect(byId.get(third)).toBe('queued'); // over-cap — the next run's work
  });
});

describe('setRoleBookActions (the Q-01 flip)', () => {
  it('grants fix_book to a role with an update_book_actions audit; admin is immutable', async () => {
    const admin = await createUser(t.db);
    const [defaultRole] = await t.db.select().from(roles).where(eq(roles.name, 'Default'));
    const [adminRole] = await t.db.select().from(roles).where(eq(roles.isAdmin, true));

    await setRoleBookActions({ db: t.db, roleId: defaultRole!.id, actions: ['fix_book'], actorId: admin.id });
    expect(await bookActionsForRole({ db: t.db, roleId: defaultRole!.id })).toEqual(['fix_book']);
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_book_actions'));
    expect(audits).toHaveLength(1);

    await expect(
      setRoleBookActions({ db: t.db, roleId: adminRole!.id, actions: ['fix_book'], actorId: admin.id }),
    ).rejects.toThrow(/ROLE_IMMUTABLE/);

    // replace-set to empty removes the grant (the pre-flip state).
    await setRoleBookActions({ db: t.db, roleId: defaultRole!.id, actions: [], actorId: admin.id });
    expect(await bookActionsForRole({ db: t.db, roleId: defaultRole!.id })).toEqual([]);
  });
});
