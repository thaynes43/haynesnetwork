// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations router: the section VISIBILITY gate (unauth ⇒
// UNAUTHORIZED; a non-admin whose `integrations` section is the default `disabled` ⇒ FORBIDDEN; admin ⇒
// implied edit), the link flow (vanity/URL resolve + public-shelf probe via the injected Goodreads client),
// and the manual re-search ownership check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GbVolume, GoodreadsRssClient, GoodreadsShelfItem, GoogleBooksClient } from '@hnet/goodreads';
import type { LazyLibrarianClientBundle } from '@hnet/domain';
import { bootMigratedDb, caller, createUser, makeCtx, sessionUser, type TestDb } from './helpers';
import type { TRPCContext } from '../src/trpc';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

/** A stub Goodreads RSS client (resolve + probe) injected into the context. */
function stubGoodreads(opts?: {
  resolveUserId?: (ref: string) => Promise<string>;
  fetchShelf?: (userId: string, shelf: string) => Promise<unknown[]>;
}): GoodreadsRssClient {
  return {
    resolveUserId: opts?.resolveUserId ?? (async () => '202652880'),
    fetchShelf: opts?.fetchShelf ?? (async () => []),
  } as unknown as GoodreadsRssClient;
}

/** A stub Google Books client (resolve → a fixed volume) injected into the context. */
function stubGoogleBooks(volume: GbVolume | null): GoogleBooksClient {
  return { resolveVolume: async () => volume } as unknown as GoogleBooksClient;
}

/** A no-op LazyLibrarian bundle so the fresh-link first sync pushes instantly (no network). */
function stubLazyLibrarian(): LazyLibrarianClientBundle {
  return {
    read: { getAllBookStatuses: async () => new Map() },
    write: { addBook: async () => {}, queueBook: async () => {}, searchBook: async () => {} },
  } as unknown as LazyLibrarianClientBundle;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('integrations router — section gate', () => {
  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const ctx = makeCtx(t.db, null);
    expect(await codeOf(() => caller(ctx).integrations.status())).toBe('UNAUTHORIZED');
  });

  it('rejects a non-admin (integrations defaults to disabled) with FORBIDDEN', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member));
    expect(await codeOf(() => caller(ctx).integrations.status())).toBe('FORBIDDEN');
    expect(await codeOf(() => caller(ctx).integrations.requests())).toBe('FORBIDDEN');
  });

  it('allows a member whose role opted into read_only', async () => {
    const member = await createUser(t.db);
    const ctx = makeCtx(t.db, sessionUser(member, { integrations: 'read_only' }));
    const res = await caller(ctx).integrations.status();
    expect(res.integration.linked).toBe(false);
  });
});

describe('integrations router — link + shelf', () => {
  it('resolves the profile, probes the shelf, links, and reports coverage', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = { ...makeCtx(t.db, sessionUser(admin)), goodreads: stubGoodreads() };

    const linked = await caller(ctx).integrations.link({
      profileRef: 'https://www.goodreads.com/haynesnetwork',
    });
    expect(linked.integration.linked).toBe(true);
    expect(linked.integration.externalUserId).toBe('202652880');

    const status = await caller(ctx).integrations.status();
    expect(status.integration.linked).toBe(true);

    const shelf = await caller(ctx).integrations.shelf();
    expect(shelf.coverage).toEqual({ total: 0, covered: 0, pct: 0 });

    // Unlink flips it back.
    const un = await caller(ctx).integrations.unlink();
    expect(un.changed).toBe(true);
    expect((await caller(ctx).integrations.status()).integration.linked).toBe(false);
  });

  it('runs the FIRST shelf sync on link so the wall is not a "0 of 0" dead-end (fix 3a)', async () => {
    const admin = await createUser(t.db, { admin: true });
    const shelfItem: GoodreadsShelfItem = {
      externalBookId: 'gr-dune',
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: '9780593099322',
      coverUrl: null,
      shelvedAt: new Date(),
    };
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(admin)),
      // ADR-057 — the link now defaults to ALL FOUR shelves; the book lives on to-read only (the
      // realistic shape — Goodreads exclusive shelves), the rest come back empty.
      goodreads: stubGoodreads({
        fetchShelf: async (_userId, shelf) => (shelf === 'to-read' ? [shelfItem] : []),
      }),
      googleBooks: stubGoogleBooks({
        volumeId: 'gb-dune',
        isbn13: '9780593099322',
        categories: ['Fiction'],
        isComic: false,
      }),
      lazylibrarian: stubLazyLibrarian(),
    };

    // Before the sync stamps last_synced_at, the wire signals PENDING (the UI shows "first sync in progress",
    // never a 0% dead-end — fix 3b). The background sync then mints the request.
    const linked = await caller(ctx).integrations.link({ profileRef: '202652880' });
    expect(linked.integration.linked).toBe(true);

    // The first sync fires in the background — poll until it mirrors + mints the request.
    let requests: Awaited<ReturnType<ReturnType<typeof caller>['integrations']['requests']>>['requests'] = [];
    for (let i = 0; i < 50 && requests.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      requests = (await caller(ctx).integrations.requests()).requests;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe('Dune');

    // And once synced, last_synced_at is stamped → the card leaves the pending state.
    const shelf = await caller(ctx).integrations.shelf();
    expect(shelf.integration.lastSyncedAt).not.toBeNull();

    await caller(ctx).integrations.unlink();
  });

  it('rejects an unreadable/private shelf with UNPROCESSABLE_CONTENT', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(admin)),
      goodreads: stubGoodreads({
        fetchShelf: async () => {
          throw new Error('403 private');
        },
      }),
    };
    expect(
      await codeOf(() => caller(ctx).integrations.link({ profileRef: '202652880' })),
    ).toBe('UNPROCESSABLE_CONTENT');
  });

  it('rejects an unresolvable profile with UNPROCESSABLE_CONTENT', async () => {
    const admin = await createUser(t.db, { admin: true });
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(admin)),
      goodreads: stubGoodreads({
        resolveUserId: async () => {
          throw new Error('no id');
        },
      }),
    };
    expect(
      await codeOf(() => caller(ctx).integrations.link({ profileRef: 'https://x/nope' })),
    ).toBe('UNPROCESSABLE_CONTENT');
  });
});
