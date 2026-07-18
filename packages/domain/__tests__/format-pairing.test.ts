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
  gbQuotaState,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
  type BooksItemInsert,
} from '@hnet/db';
import {
  matchFormatPairs,
  mintPairingWants,
  missingFormatFor,
  pairingTitleKey,
  runFormatPairing,
  syncFormatPairs,
  tripGbQuotaBreaker,
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
  const inputs: Array<{ isbn?: string | null; title: string; author?: string | null }> = [];
  return {
    calls,
    inputs,
    gb: {
      resolveVolume: async (input: { isbn?: string | null; title: string; author?: string | null }) => {
        calls.push(input.title);
        inputs.push(input);
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

  it('pairs across edition-noise variants (": A Novel" / "(Unabridged)" strip to the same key)', () => {
    const book = pi({ title: 'Project Hail Mary: A Novel', author: 'Andy Weir', mediaKind: 'book' });
    const audio = pi({ title: 'Project Hail Mary (Unabridged)', author: 'Andy Weir', mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audio])).toHaveLength(1);
    expect(pairingTitleKey('Project Hail Mary: A Novel')).toBe('project hail mary');
    expect(pairingTitleKey('Project Hail Mary (Unabridged)')).toBe('project hail mary');
  });

  it('NEVER collapses distinct franchise works — the full title is load-bearing (review finding 1)', () => {
    // The subtitle-cutting goodreads normTitle would key BOTH as "star wars" and mispair them.
    const book = pi({ title: 'Star Wars: Heir to the Empire', author: 'Timothy Zahn', mediaKind: 'book' });
    const audio = pi({ title: 'Star Wars: Thrawn', author: 'Timothy Zahn', mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audio])).toEqual([]);
    expect(pairingTitleKey('Star Wars: Heir to the Empire')).toBe('star wars heir to empire');
    expect(pairingTitleKey('Star Wars: Thrawn')).toBe('star wars thrawn');
  });

  it('a bare stem does NOT pair with a subtitled edition — the conservative miss is correct', () => {
    const book = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book' });
    const audio = pi({ title: 'Dune: Book One of the Dune Chronicles', author: 'Frank Herbert', mediaKind: 'audiobook' });
    expect(matchFormatPairs([book, audio])).toEqual([]);
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
  await t.db.delete(gbQuotaState);
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
    expect(first).toEqual({ paired: 1, added: 1, dropped: 0, revived: 0 });
    const [pair] = await t.db.select().from(booksFormatPairs);
    expect(pair).toMatchObject({ bookItemId: bookId, audioItemId: audioId, matchedVia: 'title_author' });

    // An unchanged re-run adds/drops nothing (the survivor advances last_seen_at).
    const second = await syncFormatPairs({ db: t.db, now: new Date(Date.now() + 1000) });
    expect(second).toEqual({ paired: 1, added: 0, dropped: 0, revived: 0 });

    // Tombstone the audio side — the pair drops on the next run (the reconcile).
    await t.db.update(booksItems).set({ deletedAt: new Date() }).where(eq(booksItems.id, audioId));
    const third = await syncFormatPairs({ db: t.db });
    expect(third).toEqual({ paired: 0, added: 0, dropped: 1, revived: 0 });
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

  it('passes the anchor ISBN to the GB resolve (PLAN-059 — the reliable `isbn:` leg fires first)', async () => {
    // An ABS audiobook anchor carrying a valid ISBN, with a messy file-derived title that the fuzzy
    // title leg would miss. The fix feeds the ISBN through so the resolver's `isbn:` leg resolves it.
    await seedItem({
      title: 'Expanse 05 - Nemesis Games',
      author: 'James S.A. Corey',
      mediaKind: 'audiobook',
      isbn: '9780316334716',
    });
    const ll = stubLl();
    const gb = stubGb(() => 'gb-nemesis');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    // The resolver was handed the anchor's ISBN (not just title/author) — the crux of the fix.
    expect(gb.inputs).toHaveLength(1);
    expect(gb.inputs[0]).toMatchObject({ isbn: '9780316334716', author: 'James S.A. Corey' });
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ origin: 'pairing', llBookId: 'gb-nemesis', ebookStatus: 'wanted' });
  });

  it('a null-ISBN anchor still resolves via title+author (no regression)', async () => {
    await seedItem({ title: 'Piranesi', author: 'Susanna Clarke', mediaKind: 'book' });
    const ll = stubLl();
    const gb = stubGb(() => 'gb-pir');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(gb.inputs[0]).toMatchObject({ isbn: null, title: 'Piranesi', author: 'Susanna Clarke' });
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.llBookId).toBe('gb-pir');
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

  it('REUSES a prior PAIRING want llBookId (same normalized title/author) before Google Books — the quota-day GB-avoidance', async () => {
    // Run 1: a book "Dune" resolves its GB volume id and mints a pairing want.
    await seedItem({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book' });
    const ll = stubLl();
    const gb1 = stubGb(() => 'gb-dune');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb1.gb, pacer: async () => {} });

    // Run 2: an audiobook of the SAME work whose subtitle keeps the pairing key distinct (so it does
    // NOT auto-pair and stays an unpaired candidate), but whose goodreads-style normalized title +
    // author still match the resolved book want. It must reuse 'gb-dune' — NO fresh GB call, even
    // with the breaker otherwise starved. This is what keeps the pairing backlog draining on a
    // quota-exhausted day; before the reuse index drew from pairing wants it would have needed GB.
    await seedItem({ title: 'Dune: Special Edition', author: 'Frank Herbert', mediaKind: 'audiobook' });
    const gb2 = stubGb(() => {
      throw new Error('GB must not be called when a prior pairing want already resolved this work');
    });
    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb2.gb, pacer: async () => {} });
    expect(gb2.calls).toHaveLength(0);
    const wants = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(wants).toHaveLength(2);
    expect(wants.every((w) => w.llBookId === 'gb-dune')).toBe(true);
    expect(report.pushed).toBe(1);
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

  it('SKIPS addBook when LazyLibrarian already holds the volume — queueBook+searchBook only, no GB re-resolve (DESIGN-039 D-18)', async () => {
    // First push: LL does NOT yet hold the volume, so addBook seats it (the pre-D-18 behaviour, and
    // the safe default when `llHasSeededBook` is absent).
    await seedItem({ title: 'Neuromancer', author: 'William Gibson', mediaKind: 'book' });
    const first = stubLl();
    await mintPairingWants({ db: t.db, ll: first.bundle, gb: stubGb(() => 'gb-neuro').gb, pacer: async () => {} });
    expect(first.calls.filter((c) => c.cmd === 'addBook')).toHaveLength(1);

    // Model a re-push: force the want's missing (audiobook) leg back to `requested` so it re-enters
    // the retry queue with its llBookId already resolved (the exact shape of the ~23 titles LL was
    // re-adding every run).
    await t.db
      .update(bookRequests)
      .set({ audioStatus: 'requested' })
      .where(eq(bookRequests.origin, 'pairing'));

    // Re-push, now telling mint that LL ALREADY seats 'gb-neuro'. addBook must be SKIPPED; the
    // acquisition retry (queueBook + searchBook — neither hits Google Books) still fires. The GB stub
    // throws to prove no fresh resolve happens on our side either (the id is reused).
    const second = stubLl();
    const gbBoom = stubGb(() => {
      throw new Error('GB must not be called on an already-resolved re-push');
    });
    const report = await mintPairingWants({
      db: t.db,
      ll: second.bundle,
      gb: gbBoom.gb,
      pacer: async () => {},
      llHasSeededBook: (id) => id === 'gb-neuro',
    });
    expect(report.pushed).toBe(1);
    expect(gbBoom.calls).toHaveLength(0);
    expect(second.calls.filter((c) => c.cmd === 'addBook')).toHaveLength(0);
    expect(second.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);
    expect(second.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.format)).toEqual(['audiobook']);
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

  // -------------------------------------------------------------------------
  // ADR-067 C-08 (PLAN-055) — the GB quota breaker closes the PLAN-050 residual: doomed resolves
  // no longer burn the mint cap, and identity-holding mints still drain the backlog on quota days.
  // -------------------------------------------------------------------------

  it('an OPEN breaker skips GB-requiring candidates WITHOUT burning the cap; a reuse-mint still proceeds', async () => {
    // Two GB-needing candidates (oldest — the old behavior would have burned the whole cap here)…
    await seedItem({ title: 'Needs GB One', author: 'Author One', mediaKind: 'book', firstSeenAt: day(1) });
    await seedItem({ title: 'Needs GB Two', author: 'Author Two', mediaKind: 'book', firstSeenAt: day(2) });
    // …and a NEWEST candidate whose LL identity reuses a goodreads request (no GB call needed).
    await seedItem({ title: 'The Martian', author: 'Andy Weir', mediaKind: 'book', firstSeenAt: day(3) });
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
      title: 'The Martian',
      author: 'Andy Weir',
      llBookId: 'gb-reused',
    });

    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    const ll = stubLl();
    const gb = stubGb(() => 'gb-never');
    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, cap: 2, pacer: async () => {} });

    // The two doomed candidates were SKIPPED (no cap spent, no rows minted, resolver untouched);
    // the reuse candidate — behind them in the queue — still minted and pushed.
    expect(report).toMatchObject({ candidates: 3, attempted: 1, minted: 1, pushed: 1, skippedQuota: 2 });
    expect(gb.calls).toHaveLength(0); // the breaker gates BEFORE the resolver
    const wants = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(wants).toHaveLength(1);
    expect(wants[0]!.llBookId).toBe('gb-reused');
  });

  it('a mid-run daily 429 trips ONCE, stops further GB calls, and never churns existing wants', async () => {
    await seedItem({ title: 'Solo Alpha', author: 'Author A', mediaKind: 'book', firstSeenAt: day(1) });
    await seedItem({ title: 'Solo Beta', author: 'Author B', mediaKind: 'book', firstSeenAt: day(2) });
    const t0 = new Date('2026-07-16T10:00:00Z');
    // Run 1 (quota fine, GB has no match): two honest unmintable wants exist.
    const run1 = await mintPairingWants({ db: t.db, ll: stubLl().bundle, gb: stubGb(() => null).gb, now: t0, pacer: async () => {} });
    expect(run1).toMatchObject({ attempted: 2, minted: 2, unmintable: 2, skippedQuota: 0 });
    const before = await t.db.select().from(bookRequests).orderBy(bookRequests.id);

    // Run 2: GB is exhausted — the FIRST resolve 429s (daily), the second is never made.
    let calls = 0;
    const gb429 = {
      resolveVolume: async () => {
        calls += 1;
        throw Object.assign(new Error("HTTP 429 — limit 'Queries per day'"), {
          status: 429,
          bodySnippet: "limit 'Queries per day'",
        });
      },
    };
    const t1 = new Date('2026-07-16T11:00:00Z');
    const ll = stubLl();
    const run2 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb429, now: t1, pacer: async () => {} });
    expect(run2).toMatchObject({ attempted: 0, minted: 0, pushed: 0, skippedQuota: 2 });
    expect(calls).toBe(1);
    expect(ll.calls).toHaveLength(0);

    // The retry-recency key did NOT advance — a skipped candidate keeps its place in the queue.
    const after = await t.db.select().from(bookRequests).orderBy(bookRequests.id);
    expect(after.map((w) => w.updatedAt.getTime())).toEqual(before.map((w) => w.updatedAt.getTime()));
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

  it('RE-VANISH self-heal (review finding 3): pair forms, want lands, the audio side tombstones — the want resets to requested and re-mints under the cap', async () => {
    // 1. Only the book exists — the mint pushes the audio want.
    const bookId = await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const gb = stubGb(() => 'gb-hyp');
    await runFormatPairing({ db: t.db, ll: stubLl(() => null).bundle, gb: gb.gb, pacer: async () => {} });

    // 2. The audiobook arrives: the pair forms and LL reports both legs Open — the want goes
    //    both-landed (inert). Nothing revives while the pair stands.
    const audioId = await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'audiobook' });
    const llLanded = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: 'Open', audioStatus: 'Open' } : null));
    const run2 = await runFormatPairing({ db: t.db, ll: llLanded.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run2).toMatchObject({ paired: 1, added: 1, revived: 0 });
    const [landed] = await t.db.select().from(bookRequests);
    expect(landed!.ebookStatus).toBe('landed');
    expect(landed!.audioStatus).toBe('landed');

    // 3. The audio side vanishes: the pair drops AND the inert want's missing format resets to
    //    `requested` in the same run — the mint retry re-pushes it under the cap.
    await t.db.update(booksItems).set({ deletedAt: new Date() }).where(eq(booksItems.id, audioId));
    const ll3 = stubLl(() => null);
    const run3 = await runFormatPairing({ db: t.db, ll: ll3.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run3).toMatchObject({ paired: 0, dropped: 1, revived: 1, minted: 0, pushed: 1 });
    const [revived] = await t.db.select().from(bookRequests);
    expect(revived!.pairingBooksItemId).toBe(bookId);
    expect(revived!.ebookStatus).toBe('landed'); // the held format stays ours
    expect(revived!.audioStatus).toBe('wanted'); // reset to requested, then re-pushed
    expect(ll3.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);
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
