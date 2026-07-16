// ADR-065 / DESIGN-036 (PLAN-050) — book ⇄ audiobook format pairing: the conservative matcher
// (author agreement REQUIRED, null-author no-pair, comics excluded), the books_format_pairs
// single-writer (upsert + tombstone reconcile), the PACED estate-wide mint (cap, deterministic
// order, reuse-first LL identity, honest unmintable retry, missing-format-ONLY confined push),
// the LL reconcile riding the existing status machinery, and the governor-untouched pin (the
// pairing path invokes nothing on the confined surface beyond addBook/queueBook/searchBook).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookRequests,
  booksFormatPairs,
  booksItems,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
  type BooksItemInsert,
} from '@hnet/db';
import {
  matchFormatPairs,
  mintPairingWants,
  missingFormatFor,
  runFormatPairing,
  syncFormatPairs,
  type LazyLibrarianClientBundle,
  type PairableItem,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

interface LlCall {
  cmd: string;
  id: string;
  format?: string;
}

/**
 * The LL stub + the ADR-065 C-08 governor pin: every property ACCESS on the write surface is
 * recorded, so a test can assert the pairing path never reaches beyond the three sanctioned
 * acquisition writes (no provider-config call exists on this path, structurally).
 */
function stubLl(
  statusOf?: (id: string) => { ebookStatus: string | null; audioStatus: string | null } | null,
) {
  const calls: LlCall[] = [];
  const writeAccessed = new Set<string>();
  const write = new Proxy(
    {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'OK';
      },
      queueBook: async (id: string, format: 'ebook' | 'audiobook') => {
        calls.push({ cmd: 'queueBook', id, format });
        return 'OK';
      },
      searchBook: async (id: string, format: 'ebook' | 'audiobook') => {
        calls.push({ cmd: 'searchBook', id, format });
        return 'OK';
      },
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (typeof prop === 'string') writeAccessed.add(prop);
        return target[prop as string];
      },
    },
  );
  const bundle = {
    write,
    read: {
      getAllBookStatuses: async () => ({
        get: (id: string) => {
          const s = statusOf ? statusOf(id) : null;
          return s ? { bookId: id, ebookStatus: s.ebookStatus, audioStatus: s.audioStatus } : undefined;
        },
      }),
    },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle, writeAccessed };
}

function stubGb(resolve: (title: string) => string | null) {
  const calls: string[] = [];
  return {
    calls,
    gb: {
      resolveVolume: async (input: { title: string; author?: string | null }) => {
        calls.push(input.title);
        const v = resolve(input.title);
        return v ? { volumeId: v } : null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The matcher (pure).
// ---------------------------------------------------------------------------

let itemSeq = 0;
function pi(overrides: Partial<PairableItem> & { title: string; mediaKind: PairableItem['mediaKind'] }): PairableItem {
  itemSeq += 1;
  return {
    id: overrides.id ?? `item-${String(itemSeq).padStart(3, '0')}`,
    title: overrides.title,
    sortTitle: overrides.sortTitle ?? overrides.title.toLowerCase(),
    author: overrides.author ?? null,
    mediaKind: overrides.mediaKind,
  };
}

describe('matchFormatPairs (the conservative matcher)', () => {
  it('pairs a book with its audiobook on normalized title + author agreement', () => {
    const book = pi({ title: 'The Way of Kings', author: 'Brandon Sanderson', mediaKind: 'book' });
    const audio = pi({ title: 'Way of Kings', author: 'Sanderson', mediaKind: 'audiobook' });
    const pairs = matchFormatPairs([book, audio]);
    expect(pairs).toEqual([
      { bookItemId: book.id, audioItemId: audio.id, matchedVia: 'title_author' },
    ]);
  });

  it('pairs across subtitle/edition variants (the normTitle cut at ":" / "(")', () => {
    const book = pi({ title: 'Project Hail Mary: A Novel', author: 'Andy Weir', mediaKind: 'book' });
    const audio = pi({ title: 'Project Hail Mary (Unabridged)', author: 'Andy Weir', mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audio])).toHaveLength(1);
  });

  it('REQUIRES author agreement — a same-title different-author audio never pairs', () => {
    const book = pi({ title: 'It', author: 'Stephen King', mediaKind: 'book' });
    const audio = pi({ title: 'It', author: 'Alexa Chung', mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audio])).toEqual([]);
  });

  it('a null/empty author on EITHER side pairs nothing', () => {
    const bookNull = pi({ title: 'Dune', author: null, mediaKind: 'book' });
    const audio = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'audiobook' });
    expect(matchFormatPairs([bookNull, audio])).toEqual([]);
    const book = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book' });
    const audioNull = pi({ title: 'Dune', author: null, mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audioNull])).toEqual([]);
  });

  it('comics never participate (a Kavita comic is not an ebook)', () => {
    const comic = pi({ title: 'Saga', author: 'Brian K. Vaughan', mediaKind: 'comic' });
    const audio = pi({ title: 'Saga', author: 'Brian K. Vaughan', mediaKind: 'audiobook' });
    expect(matchFormatPairs([comic, audio])).toEqual([]);
  });

  it('is greedy one-to-one and deterministic — one audio pairs with exactly one book', () => {
    const b1 = pi({ id: 'b-aaa', title: 'Dune', sortTitle: 'dune', author: 'Frank Herbert', mediaKind: 'book' });
    const b2 = pi({ id: 'b-bbb', title: 'Dune', sortTitle: 'dune', author: 'Frank Herbert', mediaKind: 'book' });
    const a1 = pi({ id: 'a-aaa', title: 'Dune', author: 'Frank Herbert', mediaKind: 'audiobook' });
    const pairs = matchFormatPairs([b2, b1, a1]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ bookItemId: 'b-aaa', audioItemId: 'a-aaa' }); // sortTitle,id order
  });
});

// ---------------------------------------------------------------------------
// The DB-backed vertical.
// ---------------------------------------------------------------------------

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
});

let extSeq = 0;
async function seedItem(overrides: Partial<BooksItemInsert> & { title: string; mediaKind: 'book' | 'audiobook' | 'comic' }): Promise<string> {
  extSeq += 1;
  const source = overrides.mediaKind === 'audiobook' ? 'audiobookshelf' : 'kavita';
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source,
      externalId: overrides.externalId ?? `ext-${extSeq}`,
      libraryId: '1',
      libraryName: 'Lib',
      sortTitle: overrides.sortTitle ?? overrides.title.toLowerCase(),
      deepLinkUrl: overrides.deepLinkUrl ?? 'http://x',
      ...overrides,
    })
    .returning({ id: booksItems.id });
  return row!.id;
}

describe('syncFormatPairs (the derived-cache single-writer)', () => {
  it('inserts fresh pairs, keeps survivors, and drops a pair whose side tombstoned', async () => {
    const bookId = await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const audioId = await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'audiobook' });
    await seedItem({ title: 'Lonely Book', author: 'Someone Else', mediaKind: 'book' });

    const first = await syncFormatPairs({ db: t.db });
    expect(first).toEqual({ paired: 1, added: 1, dropped: 0 });
    const [pair] = await t.db.select().from(booksFormatPairs);
    expect(pair).toMatchObject({ bookItemId: bookId, audioItemId: audioId, matchedVia: 'title_author' });

    // An unchanged re-run adds/drops nothing (the survivor advances last_seen_at).
    const second = await syncFormatPairs({ db: t.db, now: new Date(Date.now() + 1000) });
    expect(second).toEqual({ paired: 1, added: 0, dropped: 0 });

    // Tombstone the audio side — the pair drops on the next run (the reconcile).
    await t.db.update(booksItems).set({ deletedAt: new Date() }).where(eq(booksItems.id, audioId));
    const third = await syncFormatPairs({ db: t.db });
    expect(third).toEqual({ paired: 0, added: 0, dropped: 1 });
    expect(await t.db.select().from(booksFormatPairs)).toHaveLength(0);
  });
});

describe('mintPairingWants (the paced estate-wide backfill)', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));

  async function seedUnpairedBooks(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      ids.push(
        await seedItem({
          title: `Solo Book ${String(i + 1).padStart(2, '0')}`,
          author: `Author ${i + 1}`,
          mediaKind: 'book',
          firstSeenAt: day(i + 1),
        }),
      );
    }
    return ids;
  }

  it('mints exactly CAP of an over-cap backlog, oldest-first, and RESUMES on the next run', async () => {
    const ids = await seedUnpairedBooks(5);
    const ll = stubLl();
    const gb = stubGb((title) => `gb-${title.slice(-2)}`);

    const run1 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, cap: 2, pacer: async () => {} });
    expect(run1).toMatchObject({ candidates: 5, attempted: 2, minted: 2, pushed: 2, unmintable: 0 });
    const afterRun1 = await t.db.select().from(bookRequests);
    expect(afterRun1).toHaveLength(2);
    // Oldest-first deterministic: the two oldest anchors minted first.
    expect(afterRun1.map((w) => w.pairingBooksItemId).sort()).toEqual([ids[0], ids[1]].sort());

    const run2 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, cap: 2, pacer: async () => {} });
    expect(run2).toMatchObject({ candidates: 5, attempted: 2, minted: 2, pushed: 2 });
    const run3 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, cap: 2, pacer: async () => {} });
    expect(run3).toMatchObject({ attempted: 1, minted: 1, pushed: 1 });
    expect(await t.db.select().from(bookRequests)).toHaveLength(5);
  });

  it('pushes the confined chain for ONLY the missing format and lands the want origin=pairing', async () => {
    const anchorId = await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const ll = stubLl();
    const gb = stubGb(() => 'gb-hyp');

    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    // The chain: one addBook, queue+search for the AUDIOBOOK leg only — the held ebook is never queued.
    expect(ll.calls.filter((c) => c.cmd === 'addBook')).toHaveLength(1);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.format)).toEqual(['audiobook']);

    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({
      origin: 'pairing',
      pairingBooksItemId: anchorId,
      integrationId: null,
      shelfItemId: null,
      llBookId: 'gb-hyp',
      ebookStatus: 'landed', // held — honest
      audioStatus: 'wanted', // pushed
      matchedBooksItemId: null,
      comicStatus: null,
    });
  });

  it('an audiobook anchor mints the EBOOK leg (the mirror direction)', async () => {
    await seedItem({ title: 'Piranesi', author: 'Susanna Clarke', mediaKind: 'audiobook' });
    const ll = stubLl();
    const gb = stubGb(() => 'gb-pir');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['ebook']);
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.ebookStatus).toBe('wanted');
    expect(want!.audioStatus).toBe('landed');
    expect(missingFormatFor('audiobook')).toBe('ebook');
  });

  it('REUSES an existing goodreads request llBookId (same normalized title/author) before Google Books', async () => {
    await seedItem({ title: 'The Martian', author: 'Andy Weir', mediaKind: 'book' });
    // A goodreads want for the same title/author already resolved its LL id.
    const user = await createUser(t.db);
    const [integ] = await t.db
      .insert(userIntegrations)
      .values({ userId: user.id, provider: 'goodreads', externalUserId: '1', status: 'linked' })
      .returning({ id: userIntegrations.id });
    const [shelf] = await t.db
      .insert(integrationShelfItems)
      .values({ integrationId: integ!.id, shelf: 'to-read', externalBookId: 'gr-m', title: 'The Martian' })
      .returning({ id: integrationShelfItems.id });
    await t.db.insert(bookRequests).values({
      integrationId: integ!.id,
      shelfItemId: shelf!.id,
      title: 'The Martian (Special Edition)',
      author: 'Andy Weir',
      llBookId: 'gb-reused',
    });

    const ll = stubLl();
    const gb = stubGb(() => {
      throw new Error('GB must not be called when a reuse candidate exists');
    });
    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(report).toMatchObject({ attempted: 1, minted: 1, pushed: 1 });
    const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(want!.llBookId).toBe('gb-reused');
    expect(gb.calls).toHaveLength(0);
  });

  it('an unresolvable identity mints an honest UNMINTABLE want (no push, nothing fabricated) that a later run resolves', async () => {
    await seedItem({ title: 'Obscure Title', author: 'Unknown Author', mediaKind: 'book' });
    const ll = stubLl();
    const gbFail = stubGb(() => null);
    const run1 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gbFail.gb, pacer: async () => {} });
    expect(run1).toMatchObject({ attempted: 1, minted: 1, pushed: 0, unmintable: 1 });
    expect(ll.calls).toHaveLength(0);
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.llBookId).toBeNull();
    expect(want!.audioStatus).toBe('requested');

    // The retry path: the next run re-attempts (backoff-by-recency), GB now resolves, the push fires.
    const gbOk = stubGb(() => 'gb-late');
    const run2 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gbOk.gb, pacer: async () => {} });
    expect(run2).toMatchObject({ attempted: 1, minted: 0, pushed: 1, unmintable: 0 });
    const [after] = await t.db.select().from(bookRequests);
    expect(after!.llBookId).toBe('gb-late');
    expect(after!.audioStatus).toBe('wanted');
  });

  it('a comic never becomes a candidate (out of scope by owner ruling R1a)', async () => {
    await seedItem({ title: 'Saga', author: 'Brian K. Vaughan', mediaKind: 'comic' });
    const ll = stubLl();
    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: stubGb(() => 'gb-x').gb, pacer: async () => {} });
    expect(report.candidates).toBe(0);
    expect(await t.db.select().from(bookRequests)).toHaveLength(0);
  });

  it('a PAIRED title never mints (both formats present)', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'audiobook' });
    await syncFormatPairs({ db: t.db });
    const report = await mintPairingWants({ db: t.db, ll: stubLl().bundle, gb: stubGb(() => 'gb-x').gb, pacer: async () => {} });
    expect(report.candidates).toBe(0);
  });
});

describe('runFormatPairing (the mode body: pairs → mint → reconcile)', () => {
  it('reconciles pushed pairing wants through the existing machinery, never regressing the held format', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const gb = stubGb(() => 'gb-hyp');

    // Run 1: pair pass finds nothing to pair, the mint pushes the audio leg.
    const ll1 = stubLl(() => null);
    const run1 = await runFormatPairing({ db: t.db, ll: ll1.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run1).toMatchObject({ paired: 0, minted: 1, pushed: 1, reconciled: 0 });

    // Run 2: LL reports the audio leg Snatched — and (not knowing our library) the ebook leg Skipped.
    // advanceStatus keeps the held ebook `landed`; the audio advances to grabbed.
    const ll2 = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: 'Skipped', audioStatus: 'Snatched' } : null));
    const run2 = await runFormatPairing({ db: t.db, ll: ll2.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run2.reconciled).toBe(1);
    expect(run2.requeued).toBe(0); // the held format's raw Skipped is OURS to ignore — never re-queued
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.ebookStatus).toBe('landed');
    expect(want!.audioStatus).toBe('grabbed');
    expect(ll2.calls.filter((c) => c.cmd === 'queueBook')).toHaveLength(0);
  });

  it('sweeps a raw-Skipped MISSING format (re-queue + re-search, the goodreads-sync discipline)', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const gb = stubGb(() => 'gb-hyp');
    await runFormatPairing({ db: t.db, ll: stubLl(() => null).bundle, gb: gb.gb, pacer: async () => {} });

    const ll = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: null, audioStatus: 'Skipped' } : null));
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run.requeued).toBe(1);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.format)).toEqual(['audiobook']);
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.audioStatus).toBe('wanted');
  });

  it('GOVERNOR PIN (ADR-065 C-08): the pairing path touches nothing on the confined write surface beyond the three acquisition writes', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    await seedItem({ title: 'Piranesi', author: 'Susanna Clarke', mediaKind: 'audiobook' });
    const ll = stubLl((id) => (id ? { ebookStatus: 'Wanted', audioStatus: 'Wanted' } : null));
    await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb((t2) => `gb-${t2.length}`).gb, pacer: async () => {} });
    // Every write-surface property the run reached is one of the three sanctioned acquisition writes —
    // no provider-config surface exists on this path (the MAM governor sits at the Prowlarr seam).
    for (const prop of ll.writeAccessed) {
      expect(['addBook', 'queueBook', 'searchBook']).toContain(prop);
    }
    expect(ll.writeAccessed.size).toBeGreaterThan(0);
  });

  it('degrades honestly with NO LL bundle: pairs + mints, pushes nothing, statuses stay requested', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const report = await runFormatPairing({ db: t.db, gb: stubGb(() => 'gb-hyp').gb, pacer: async () => {} });
    expect(report).toMatchObject({ minted: 1, pushed: 0, reconciled: 0 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.audioStatus).toBe('requested');
    expect(want!.llBookId).toBe('gb-hyp'); // identity resolved — the next LL-armed run pushes
  });
});
