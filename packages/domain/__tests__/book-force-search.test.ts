// ADR-071 / DESIGN-033 D-09 — the books FORCE SEARCH (quick re-search) single-fire path. Proves:
// it re-grabs an on-disk title regardless of landed state (LL addBook→queueBook→searchBook /
// Kapowarr monitor→search) using the linked request's identity seed; writes ONE request_book_search
// audit and NO durable book_fix_request row (the movies "no durable row" idiom); an item with no
// acquisition identity fires nothing (honest reason), no audit. Also proves setRoleBookActions
// round-trips the new force_search_book grant. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bookFixRequests, bookRequests, booksItems, permissionAudit, roles } from '@hnet/db';
import { eq } from 'drizzle-orm';
import {
  bookActionsForRole,
  runBookItemForceSearch,
  setRoleBookActions,
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
  await t.db.delete(bookRequests);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
});

let extSeq = 0;
async function seedBook(kind: 'book' | 'audiobook' | 'comic', title = 'On Disk Copy'): Promise<string> {
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source: kind === 'audiobook' ? 'audiobookshelf' : 'kavita',
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

/** Seed a request that carries the acquisition identity seed for `booksItemId` (matched). A pairing
 *  origin satisfies the request CHECK without an integration. */
async function seedIdentity(
  booksItemId: string,
  seed: { llBookId?: string; kapowarrVolumeId?: string; comic?: boolean },
): Promise<void> {
  await t.db.insert(bookRequests).values({
    origin: 'pairing',
    pairingBooksItemId: booksItemId,
    matchedBooksItemId: booksItemId,
    title: 'On Disk Copy',
    ...(seed.comic ? { comicStatus: 'landed' as const } : {}),
    ...(seed.llBookId ? { llBookId: seed.llBookId } : {}),
    ...(seed.kapowarrVolumeId ? { kapowarrVolumeId: seed.kapowarrVolumeId } : {}),
  });
}

/** Mirrors the ACL's LlBookStatus — ADR-055 amend (2026-09-22): Force Search reads LL's own per-format
 *  state before it pushes, so the stub must be able to report a HELD format. */
interface StubLlStatus {
  ebookStatus?: string | null;
  audioStatus?: string | null;
  ebookLibrary?: string | null;
  audioLibrary?: string | null;
  ebookFile?: string | null;
  audioFile?: string | null;
}

function stubLl(statusOf?: (id: string) => StubLlStatus | null) {
  const calls: { cmd: string; id: string; format?: string }[] = [];
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: {
      // The real client returns a Map from ONE getAllBooks call; an id the fn nulls is one LL
      // does not know (absent from the map) — the default, so the push fires as it always did.
      getAllBookStatuses: async () => ({
        get: (id: string) => {
          const s = statusOf ? statusOf(id) : null;
          return s
            ? {
                bookId: id,
                ebookStatus: s.ebookStatus ?? null,
                audioStatus: s.audioStatus ?? null,
                ebookLibrary: s.ebookLibrary ?? null,
                audioLibrary: s.audioLibrary ?? null,
                ebookFile: s.ebookFile ?? null,
                audioFile: s.audioFile ?? null,
              }
            : undefined;
        },
      }),
    },
  } as unknown as Parameters<typeof runBookItemForceSearch>[0]['ll'];
  return { calls, bundle };
}

function stubKapowarr() {
  const calls: { op: string; id: number }[] = [];
  const bundle = {
    write: {
      setMonitored: async (id: number) => void calls.push({ op: 'monitor', id }),
      searchVolume: async (id: number) => void calls.push({ op: 'search', id }),
    },
  } as unknown as Parameters<typeof runBookItemForceSearch>[0]['kapowarr'];
  return { calls, bundle };
}

describe('runBookItemForceSearch (quick re-search, no durable row)', () => {
  it('re-grabs an on-disk book (addBook→queueBook→searchBook) and audits ONCE, writing no fix row', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('book');
    await seedIdentity(bookId, { llBookId: 'gb-42' });
    const ll = stubLl();

    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: bookId,
      requesterId: user.id,
      ll: ll.bundle,
    });

    expect(result).toEqual({ searched: true });
    // The full acquisition chain fired, in order, for the ebook format.
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
    expect(ll.calls[1]).toMatchObject({ format: 'ebook' });
    // Exactly one search audit; NO durable book_fix_request row.
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(1);
    expect(await t.db.select().from(bookFixRequests)).toHaveLength(0);
  });

  it('uses the audiobook format for an audiobook item', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('audiobook');
    await seedIdentity(bookId, { llBookId: 'gb-audio' });
    const ll = stubLl();
    await runBookItemForceSearch({ db: t.db, booksItemId: bookId, requesterId: user.id, ll: ll.bundle });
    expect(ll.calls.every((c) => c.format === undefined || c.format === 'audiobook')).toBe(true);
    expect(ll.calls.find((c) => c.cmd === 'searchBook')?.format).toBe('audiobook');
  });

  it('re-grabs a comic via Kapowarr monitor→search', async () => {
    const user = await createUser(t.db);
    const comicId = await seedBook('comic');
    await seedIdentity(comicId, { kapowarrVolumeId: '77', comic: true });
    const kap = stubKapowarr();
    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: comicId,
      requesterId: user.id,
      kapowarr: kap.bundle,
    });
    expect(result).toEqual({ searched: true });
    expect(kap.calls).toEqual([
      { op: 'monitor', id: 77 },
      { op: 'search', id: 77 },
    ]);
  });

  it('fires nothing (honest reason, no audit) when the title has no acquisition identity', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('book'); // no linked request → no ll id
    const ll = stubLl();
    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: bookId,
      requesterId: user.id,
      ll: ll.bundle,
    });
    expect(result).toEqual({ searched: false, reason: 'no_ll_id' });
    expect(ll.calls).toHaveLength(0);
    expect(await t.db.select().from(permissionAudit)).toHaveLength(0);
  });

  // ADR-055 amendment (2026-09-22) — THE PUSH GUARD. LazyLibrarian offers no third option here:
  // `queueBook` unconditionally sets Status='Wanted' (api.py::_queuebook) and `searchBook` alone is a
  // silent no-op on a non-`Wanted` book (searchbook.py only enqueues rows whose status is 'Wanted').
  // So a held format can only be "re-searched" by stranding it in LL's daily backlog — which is the
  // defect. Force Search now declines honestly, and the click is STILL audited.
  it('declines with `already_held` (writing nothing) when LazyLibrarian already holds the format', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('book');
    await seedIdentity(bookId, { llBookId: 'gb-held' });
    const ll = stubLl((id) => (id === 'gb-held' ? { ebookStatus: 'Open' } : null));

    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: bookId,
      requesterId: user.id,
      ll: ll.bundle,
    });

    expect(result).toEqual({ searched: false, reason: 'already_held' });
    expect(ll.calls).toHaveLength(0);
    // The intent is still recorded — the audit commits before the external call, as it always has.
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(1);
  });

  it('declines on a file/library signal even when the status is not Open (the Skipped-but-imported row)', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('audiobook');
    await seedIdentity(bookId, { llBookId: 'gb-skipped-held' });
    const ll = stubLl((id) =>
      id === 'gb-skipped-held'
        ? { audioStatus: 'Skipped', audioLibrary: '2026-08-02T10:00:00Z' }
        : null,
    );

    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: bookId,
      requesterId: user.id,
      ll: ll.bundle,
    });
    expect(result).toEqual({ searched: false, reason: 'already_held' });
    expect(ll.calls).toHaveLength(0);
  });

  it('still fires when the LL read fails — the guard may only ever remove a write, never add one', async () => {
    const user = await createUser(t.db);
    const bookId = await seedBook('book');
    await seedIdentity(bookId, { llBookId: 'gb-readfail' });
    const ll = stubLl();
    (ll.bundle as unknown as { read: { getAllBookStatuses: () => Promise<never> } }).read = {
      getAllBookStatuses: async () => {
        throw new Error('LL 503');
      },
    };

    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: bookId,
      requesterId: user.id,
      ll: ll.bundle,
    });
    expect(result).toEqual({ searched: true });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
  });

  it('the Kapowarr (comic) leg is untouched by the guard — searchVolume carries no status clobber', async () => {
    const user = await createUser(t.db);
    const comicId = await seedBook('comic');
    await seedIdentity(comicId, { kapowarrVolumeId: '91', comic: true });
    const kap = stubKapowarr();
    const result = await runBookItemForceSearch({
      db: t.db,
      booksItemId: comicId,
      requesterId: user.id,
      kapowarr: kap.bundle,
    });
    expect(result).toEqual({ searched: true });
    expect(kap.calls).toEqual([
      { op: 'monitor', id: 91 },
      { op: 'search', id: 91 },
    ]);
  });
});

describe('setRoleBookActions round-trips force_search_book (the grant that gates Force Search)', () => {
  it('grants both fix_book and force_search_book to a role', async () => {
    const admin = await createUser(t.db);
    const [defaultRole] = await t.db.select().from(roles).where(eq(roles.name, 'Default'));
    await setRoleBookActions({
      db: t.db,
      roleId: defaultRole!.id,
      actions: ['fix_book', 'force_search_book'],
      actorId: admin.id,
    });
    expect((await bookActionsForRole({ db: t.db, roleId: defaultRole!.id })).sort()).toEqual(
      ['fix_book', 'force_search_book'].sort(),
    );
  });
});
