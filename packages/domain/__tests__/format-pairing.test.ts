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
  gbCallBudget,
  gbQuotaState,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
  type BooksItemInsert,
} from '@hnet/db';
import {
  classifyBookLanguage,
  createGbCallMeter,
  judgePairingWantBook,
  makeGbBudgetTracker,
  matchFormatPairs,
  mintBackoffKey,
  mintBackoffUntil,
  mintPairingWants,
  missingFormatFor,
  pairingIdentity,
  pairingTitleKey,
  peekGbQuotaGate,
  readGbBudgetUsage,
  recordGbCalls,
  runFormatPairing,
  stripAuthorDecoration,
  stripSeriesDecoration,
  syncFormatPairs,
  unparkForeignLanguageWant,
  tripGbQuotaBreaker,
  type HeldBook,
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
/** Mirrors the ACL's LlBookStatus — ADR-055 amend (2026-09-22): the library/file fields are the ones
 *  the push guard reads, so the stub has to be able to emit them. */
interface StubLlStatus {
  ebookStatus: string | null;
  audioStatus: string | null;
  ebookLibrary?: string | null;
  audioLibrary?: string | null;
  ebookFile?: string | null;
  audioFile?: string | null;
}

function stubLl(statusOf?: (id: string) => StubLlStatus | null) {
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
          return s
            ? {
                bookId: id,
                ebookStatus: s.ebookStatus,
                audioStatus: s.audioStatus,
                ebookLibrary: s.ebookLibrary ?? null,
                audioLibrary: s.audioLibrary ?? null,
                ebookFile: s.ebookFile ?? null,
                audioFile: s.audioFile ?? null,
              }
            : undefined;
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
    ...(overrides.isbn !== undefined ? { isbn: overrides.isbn } : {}),
    ...(overrides.heldBooks !== undefined ? { heldBooks: overrides.heldBooks } : {}),
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

  it('author tolerance (2026-07-21): initials spacing, initials-to-full, middle names, a leading co-author credit', () => {
    const cases: Array<[string, string]> = [
      ['J.R.R. Tolkien', 'JRR Tolkien'], // "j r r tolkien" ⇄ "jrr tolkien" — the Silmarillion class
      ['L.M. Montgomery', 'Lucy Maud Montgomery'],
      ['Dean Koontz', 'Dean Ray Koontz'],
      ['George R.R. Martin', 'Geo. R.R. Martin, Gardner Duzois, Daniel Abraham'],
    ];
    for (const [ebookAuthor, audioAuthor] of cases) {
      const book = pi({ title: 'Same Title', author: ebookAuthor, mediaKind: 'book' });
      const audio = pi({ title: 'Same Title', author: audioAuthor, mediaKind: 'audiobook' });
      expect(matchFormatPairs([book, audio]), `${ebookAuthor} vs ${audioAuthor}`).toHaveLength(1);
    }
  });

  it('author tolerance never agrees without a real-word anchor or across disjoint names', () => {
    const refused: Array<[string, string]> = [
      ['Walter Mosley', 'Homer'], // distinct works sharing a bare title
      ['Charlaine Harris', 'Harris Kelner'], // ordered alignment fails; substring fails
      ['J.', 'John Grisham'], // a bare initial alone can never anchor an agreement
    ];
    for (const [ebookAuthor, audioAuthor] of refused) {
      const book = pi({ title: 'Same Title', author: ebookAuthor, mediaKind: 'book' });
      const audio = pi({ title: 'Same Title', author: audioAuthor, mediaKind: 'audiobook' });
      expect(matchFormatPairs([book, audio]), `${ebookAuthor} vs ${audioAuthor}`).toHaveLength(0);
    }
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
  await t.db.delete(gbCallBudget);
});

let extSeq = 0;
async function seedItem(overrides: Partial<BooksItemInsert> & { title: string; mediaKind: 'book' | 'audiobook' | 'comic' }): Promise<string> {
  extSeq += 1;
  const source = overrides.mediaKind === 'audiobook' ? 'audiobookshelf' : 'kavita';
  // A Kavita book row is a series; by default it holds one book named like the series (the common
  // case). Issue #661 tests pass their own `attrs.heldBooks`.
  const attrs =
    overrides.attrs ??
    (overrides.mediaKind === 'book'
      ? { heldBooks: [{ title: overrides.title, author: overrides.author ?? null, isbn: null }] }
      : {});
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
      attrs,
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

  it('REUSES a prior PAIRING want llBookId (same work title/author) before Google Books — the quota-day GB-avoidance', async () => {
    // Run 1: a book "Dune" resolves its GB volume id and mints a pairing want.
    await seedItem({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book' });
    const ll = stubLl();
    const gb1 = stubGb(() => 'gb-dune');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb1.gb, pacer: async () => {} });

    // Run 2: an audiobook of the SAME work whose series parenthetical keeps the pairing key distinct (so it does
    // NOT auto-pair and stays an unpaired candidate), but whose reuse key (series decoration off, issue #693) +
    // author still match the resolved book want. It must reuse 'gb-dune' — NO fresh GB call, even
    // with the breaker otherwise starved. This is what keeps the pairing backlog draining on a
    // quota-exhausted day; before the reuse index drew from pairing wants it would have needed GB.
    await seedItem({ title: 'Dune (Dune Chronicles, #1)', author: 'Frank Herbert', mediaKind: 'audiobook' });
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

  it('issue #693 — never REUSES the id of another work that shares the main title (the Mistborn sequels)', async () => {
    // "Mistborn: The Final Empire" resolved first; the subtitle-cutting key used to hand its id to every "Mistborn: …".
    await seedItem({ title: 'Mistborn: The Final Empire', author: 'Brandon Sanderson', mediaKind: 'book' });
    const ll = stubLl();
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: stubGb(() => 't_ZYYXZq4RgC').gb, pacer: async () => {} });

    await seedItem({ title: 'Mistborn: Wax & Wayne', author: 'Brandon Sanderson', mediaKind: 'book' });
    const gb2 = stubGb(() => 'gb-wax-and-wayne');
    await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb2.gb, pacer: async () => {} });
    expect(gb2.calls).toHaveLength(1); // no reuse: the sequel resolved its own volume
    const wants = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(wants.find((w) => w.title === 'Mistborn: Wax & Wayne')?.llBookId).toBe('gb-wax-and-wayne');
  });

  it('an unresolvable identity mints an honest UNMINTABLE want (no push, nothing fabricated) that a later run resolves', async () => {
    await seedItem({ title: 'Obscure Title', author: 'Unknown Author', mediaKind: 'book' });
    const ll = stubLl();
    const gbFail = stubGb(() => null);
    const t0 = new Date('2026-10-06T10:00:00Z');
    const run1 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gbFail.gb, now: t0, pacer: async () => {} });
    expect(run1).toMatchObject({ attempted: 1, minted: 1, pushed: 0, unmintable: 1 });
    expect(ll.calls).toHaveLength(0);
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.llBookId).toBeNull();
    expect(want!.audioStatus).toBe('requested');

    // The retry path: the next run after the Mint Backoff (issue #740: a day after the first miss) re-attempts, GB now
    // resolves, the push fires.
    const gbOk = stubGb(() => 'gb-late');
    const t1 = new Date(t0.getTime() + 86_400_000 + 60_000);
    const run2 = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gbOk.gb, now: t1, pacer: async () => {} });
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
    // Two days on, so the two wants are past their Mint Backoff (issue #740) and need a lookup again.
    const t1 = new Date('2026-07-18T11:00:00Z');
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

  // Issue #644 — LL's searchBook ignores `type` and searches every Wanted format of the book, and the
  // pairing want reuses the llBookId of a goodreads shelf request. The two run as SEPARATE cron jobs, so they
  // share `last_searched_at`: a search by another job within the hour covers a format LL already shows as
  // Wanted. A format the push is about to FLIP is never covered (that search could not have included it).
  describe('one searchBook per book across jobs (#644)', () => {
    async function seedShelfRequestSearched(lastSearchedAt: Date | null): Promise<void> {
      await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
      const user = await createUser(t.db);
      const [integ] = await t.db
        .insert(userIntegrations)
        .values({ userId: user.id, provider: 'goodreads', externalUserId: '1', status: 'linked' })
        .returning({ id: userIntegrations.id });
      const [shelf] = await t.db
        .insert(integrationShelfItems)
        .values({ integrationId: integ!.id, shelf: 'to-read', externalBookId: 'gr-h', title: 'Hyperion' })
        .returning({ id: integrationShelfItems.id });
      await t.db.insert(bookRequests).values({
        integrationId: integ!.id,
        shelfItemId: shelf!.id,
        title: 'Hyperion',
        author: 'Dan Simmons',
        llBookId: 'gb-hyp',
        lastSearchedAt,
      });
    }
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

    it('queues but does NOT re-search a missing format LL already has Wanted when another job searched the book in the last hour', async () => {
      await seedShelfRequestSearched(minutesAgo(10));
      const ll = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: 'Open', audioStatus: 'Wanted' } : null));
      const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
      expect(run.pushed).toBe(1);
      expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);
      expect(ll.calls.filter((c) => c.cmd === 'searchBook')).toHaveLength(0);
    });

    it('still searches a format the push is FLIPPING to Wanted (a recent search could not have covered it)', async () => {
      await seedShelfRequestSearched(minutesAgo(10));
      const ll = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: 'Open', audioStatus: null } : null));
      await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
      expect(ll.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.format)).toEqual(['audiobook']);
      // The search is stamped on the pairing want — the signal the OTHER jobs read.
      const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
      expect(want!.lastSearchedAt).not.toBeNull();
    });

    it('searches per FORMAT within a run: a second want flipping the OTHER format of the same book is still searched', async () => {
      // Two distinct anchors (an ebook and an audiobook of different works) that both reuse llBookId gb-x.
      await seedItem({ title: 'Alpha Saga', author: 'Ann Author', mediaKind: 'book' });
      await seedItem({ title: 'Beta Tale', author: 'Bob Writer', mediaKind: 'audiobook' });
      const user = await createUser(t.db);
      const [integ] = await t.db
        .insert(userIntegrations)
        .values({ userId: user.id, provider: 'goodreads', externalUserId: '1', status: 'linked' })
        .returning({ id: userIntegrations.id });
      for (const [i, [title, author]] of (
        [
          ['Alpha Saga', 'Ann Author'],
          ['Beta Tale', 'Bob Writer'],
        ] as const
      ).entries()) {
        const [shelf] = await t.db
          .insert(integrationShelfItems)
          .values({ integrationId: integ!.id, shelf: 'to-read', externalBookId: `gr-${i}`, title })
          .returning({ id: integrationShelfItems.id });
        await t.db
          .insert(bookRequests)
          .values({ integrationId: integ!.id, shelfItemId: shelf!.id, title, author, llBookId: 'gb-x' });
      }
      const ll = stubLl(() => null);
      const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
      expect(run.pushed).toBe(2);
      expect(ll.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.format).sort()).toEqual([
        'audiobook',
        'ebook',
      ]);
    });

    it('searches normally when the earlier search is older than the hour window', async () => {
      await seedShelfRequestSearched(minutesAgo(180));
      const ll = stubLl((id) => (id === 'gb-hyp' ? { ebookStatus: 'Open', audioStatus: 'Wanted' } : null));
      await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
      expect(ll.calls.filter((c) => c.cmd === 'searchBook')).toHaveLength(1);
    });
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

  // ADR-055 amendment (2026-09-22) — THE PUSH GUARD on the pairing path. Both of its LL writes are
  // suppressed when LL already holds the missing format, because `queueBook` clobbers LL's status.
  it('never pushes a missing format LazyLibrarian already holds — the want still settles to landed', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    // LL already has the audiobook (Open) — the exact case the pairing mint was re-queueing daily.
    const ll = stubLl((id) =>
      id === 'gb-hyp'
        ? { ebookStatus: null, audioStatus: 'Open', audioLibrary: '2026-08-02' }
        : null,
    );
    const run = await runFormatPairing({
      db: t.db,
      ll: ll.bundle,
      gb: stubGb(() => 'gb-hyp').gb,
      pacer: async () => {},
    });

    expect(run).toMatchObject({ minted: 1, pushed: 0, skippedHeld: 1 });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook')).toHaveLength(0);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook')).toHaveLength(0);
    // The want is real and stays on the books; the reconcile settles it from LL's own status.
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.llBookId).toBe('gb-hyp');
    expect(want!.audioStatus).toBe('landed');
  });

  it('does not let the pairing Skipped sweep re-queue a Skipped-but-imported missing format', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const gb = stubGb(() => 'gb-hyp');
    await runFormatPairing({
      db: t.db,
      ll: stubLl(() => null).bundle,
      gb: gb.gb,
      pacer: async () => {},
    });

    // The missing (audio) format reads `Skipped` — but LL carries a real file for it.
    const ll = stubLl((id) =>
      id === 'gb-hyp'
        ? { ebookStatus: null, audioStatus: 'Skipped', audioFile: '/audiobooks/hyperion.m4b' }
        : null,
    );
    const run = await runFormatPairing({
      db: t.db,
      ll: ll.bundle,
      gb: gb.gb,
      pacer: async () => {},
    });

    expect(run.requeued).toBe(0);
    expect(run.skippedHeld).toBe(1);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook')).toHaveLength(0);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook')).toHaveLength(0);
  });

  // DESIGN-036 amendment (2026-10-03) — the omnibus repair parks a pairing want whose resolve landed on a
  // bundle (`unroutable_reason='wrong_volume'`, llBookId cleared) and sets the bundle Skipped in LL. Before
  // this, neither the mint nor the Skipped sweep read the park: the mint re-resolved the null id and the
  // sweep re-queued + re-searched the Skipped bundle an hour later.
  it('never re-attempts a PARKED want (wrong_volume, null llBookId): no GB resolve, no LL write, row untouched', async () => {
    const anchorId = await seedItem({ title: 'The Obelisk Gate', author: 'N.K. Jemisin', mediaKind: 'book' });
    const [parked] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchorId,
        title: 'The Obelisk Gate',
        author: 'N.K. Jemisin',
        ebookStatus: 'landed',
        audioStatus: 'wanted',
        llBookId: null,
        unroutableReason: 'wrong_volume',
      })
      .returning();
    const gb = stubGb(() => 'gb-broken-earth-trilogy');
    const ll = stubLl(() => ({ ebookStatus: 'Skipped', audioStatus: 'Skipped' }));
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(run).toMatchObject({ attempted: 0, minted: 0, pushed: 0, requeued: 0 });
    expect(gb.calls).toHaveLength(0);
    expect(ll.calls).toHaveLength(0);
    const [after] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, parked!.id));
    expect(after).toMatchObject({ llBookId: null, unroutableReason: 'wrong_volume', audioStatus: 'wanted' });
    expect(after!.updatedAt.getTime()).toBe(parked!.updatedAt.getTime());
  });

  it('keeps a PARKED want that still carries an llBookId out of the Skipped sweep (no re-queue, no re-search)', async () => {
    const anchorId = await seedItem({ title: 'Code to Zero', author: 'Ken Follett', mediaKind: 'book' });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: anchorId,
      title: 'Code to Zero',
      author: 'Ken Follett',
      ebookStatus: 'landed',
      audioStatus: 'wanted',
      llBookId: 'gb-two-in-one',
      unroutableReason: 'wrong_volume',
    });
    const ll = stubLl((id) => (id === 'gb-two-in-one' ? { ebookStatus: 'Open', audioStatus: 'Skipped' } : null));
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });

    expect(run).toMatchObject({ reconciled: 0, requeued: 0 });
    expect(ll.calls).toHaveLength(0);
  });

  it('degrades honestly with NO LL bundle: pairs + mints, pushes nothing, statuses stay requested', async () => {
    await seedItem({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const report = await runFormatPairing({
      db: t.db,
      gb: stubGb(() => 'gb-hyp').gb,
      pacer: async () => {},
    });
    expect(report).toMatchObject({ minted: 1, pushed: 0, reconciled: 0, skippedHeld: 0 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.audioStatus).toBe('requested');
    expect(want!.llBookId).toBe('gb-hyp'); // identity resolved — the next LL-armed run pushes
  });
});

// ---------------------------------------------------------------------------
// DESIGN-039 D-22 — the OLDEST-FIRST drain (ISBN-priority within the cohort).
// ---------------------------------------------------------------------------

describe('mintPairingWants — the Mint Backoff (issue #740)', () => {
  const DAY = 86_400_000;
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));
  const t0 = new Date('2026-10-06T07:33:00Z');
  const at = (days: number, hours = 0): Date => new Date(t0.getTime() + days * DAY + hours * 3_600_000);
  const wantOf = async (title: string) =>
    (await t.db.select().from(bookRequests).where(eq(bookRequests.title, title)))[0]!;

  it('a lookup that finds nothing waits 1, 3, 7, then 30 days; meanwhile no lookup is made and no cap is spent', async () => {
    await seedItem({ title: 'Never Found', author: 'Nobody', mediaKind: 'book', firstSeenAt: day(1) });
    await seedItem({ title: 'Fresh Arrival', author: 'Somebody', mediaKind: 'book', firstSeenAt: day(2) });
    const gb = stubGb(() => null);

    // Run 1 (cap 1): the oldest candidate is looked up and misses.
    const run1 = await mintPairingWants({ db: t.db, gb: gb.gb, cap: 1, now: t0, pacer: async () => {} });
    expect(run1).toMatchObject({ attempted: 1, unmintable: 1, inBackoff: 0 });
    const miss1 = await wantOf('Never Found');
    expect(miss1.mintBackoffCount).toBe(1);
    expect(miss1.mintBackoffUntil?.getTime()).toBe(at(1).getTime());
    expect(miss1.mintBackoffKey).toBe(mintBackoffKey({ title: 'Never Found', author: 'Nobody', isbn: null }));

    // Run 2, an hour later (cap 1): the waiting want is skipped without a lookup, so the cap goes to the fresh one.
    gb.calls.length = 0;
    const run2 = await mintPairingWants({ db: t.db, gb: gb.gb, cap: 1, now: at(0, 1), pacer: async () => {} });
    expect(run2).toMatchObject({ attempted: 1, inBackoff: 1 });
    expect(gb.calls).toEqual(['Fresh Arrival']);

    // Each later miss doubles up the wait: 3, 7, then 30 days, and 30 days from then on.
    const waits: number[] = [];
    let now = at(1, 1);
    for (let i = 0; i < 4; i += 1) {
      await mintPairingWants({ db: t.db, gb: gb.gb, now, pacer: async () => {} });
      const w = await wantOf('Never Found');
      waits.push(Math.round((w.mintBackoffUntil!.getTime() - now.getTime()) / DAY));
      now = new Date(w.mintBackoffUntil!.getTime() + 60_000);
    }
    expect(waits).toEqual([3, 7, 30, 30]);
    expect((await wantOf('Never Found')).mintBackoffCount).toBe(5);
    expect(mintBackoffUntil(9, t0).getTime()).toBe(at(30).getTime());
  });

  it('a changed identity (the anchor gains an ISBN) is looked up at once, and its count starts again', async () => {
    const id = await seedItem({ title: 'Quiet Book', author: 'Quiet Author', mediaKind: 'audiobook' });
    const gb = stubGb(() => null);
    await mintPairingWants({ db: t.db, gb: gb.gb, now: t0, pacer: async () => {} });
    expect((await wantOf('Quiet Book')).mintBackoffCount).toBe(1);

    await t.db.update(booksItems).set({ isbn: '9780000000001' }).where(eq(booksItems.id, id));
    gb.calls.length = 0;
    const run = await mintPairingWants({ db: t.db, gb: gb.gb, now: at(0, 1), pacer: async () => {} });
    expect(run).toMatchObject({ attempted: 1, inBackoff: 0 });
    expect(gb.calls).toEqual(['Quiet Book']);
    const after = await wantOf('Quiet Book');
    expect(after.mintBackoffCount).toBe(1);
    expect(after.mintBackoffKey).toBe(mintBackoffKey({ title: 'Quiet Book', author: 'Quiet Author', isbn: '9780000000001' }));
  });

  it('a want in backoff still mints from a book another request resolved since (no lookup), and the backoff clears', async () => {
    await seedItem({ title: 'Shared Work', author: 'Pat Writer', mediaKind: 'book' });
    await mintPairingWants({ db: t.db, gb: stubGb(() => null).gb, now: t0, pacer: async () => {} });
    expect((await wantOf('Shared Work')).mintBackoffCount).toBe(1);

    // A person's Goodreads request for the same work resolves its id.
    const user = await createUser(t.db);
    const [integ] = await t.db
      .insert(userIntegrations)
      .values({ userId: user.id, provider: 'goodreads', externalUserId: '1', status: 'linked' })
      .returning({ id: userIntegrations.id });
    const [shelf] = await t.db
      .insert(integrationShelfItems)
      .values({ integrationId: integ!.id, shelf: 'to-read', externalBookId: 'gr-shared', title: 'Shared Work' })
      .returning({ id: integrationShelfItems.id });
    await t.db.insert(bookRequests).values({
      integrationId: integ!.id,
      shelfItemId: shelf!.id,
      title: 'Shared Work',
      author: 'Pat Writer',
      llBookId: 'gb-shared',
    });

    const gb = stubGb(() => {
      throw new Error('no lookup while the want waits');
    });
    const run = await mintPairingWants({ db: t.db, gb: gb.gb, now: at(0, 1), pacer: async () => {} });
    expect(run).toMatchObject({ attempted: 1, inBackoff: 1, unmintable: 0 });
    const [after] = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(after!.llBookId).toBe('gb-shared');
    expect(after!.mintBackoffCount).toBe(0);
    expect(after!.mintBackoffUntil).toBeNull();
    expect(after!.mintBackoffKey).toBeNull();
  });

  it('a lookup that fails (an error, not an answer) is not a miss: no backoff', async () => {
    await seedItem({ title: 'Flaky Lookup', author: 'Net Work', mediaKind: 'book' });
    const gb = stubGb(() => {
      throw new Error('ECONNRESET');
    });
    const run = await mintPairingWants({ db: t.db, gb: gb.gb, now: t0, pacer: async () => {} });
    expect(run).toMatchObject({ attempted: 1, unmintable: 1 });
    const w = await wantOf('Flaky Lookup');
    expect(w.mintBackoffCount).toBe(0);
    expect(w.mintBackoffUntil).toBeNull();
  });
});

describe('mintPairingWants — oldest-first drain, ISBN priority (DESIGN-039 D-22)', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));

  it('attempts the OLDEST cohort first, ISBN-bearing before title-only within it (not newest-first)', async () => {
    // The 2026-07-16-style frozen cohort shares a first_seen (day 16); a NEWER item (day 18) must not
    // jump ahead of it. Within the day-16 cohort the ISBN-bearing anchor resolves first (cheap leg).
    await seedItem({ title: 'Cohort Title Only', author: 'A One', mediaKind: 'book', firstSeenAt: day(16) });
    await seedItem({ title: 'Cohort With Isbn', author: 'A Two', mediaKind: 'book', firstSeenAt: day(16), isbn: '9781111111111' });
    await seedItem({ title: 'Newer Item', author: 'A Three', mediaKind: 'book', firstSeenAt: day(18) });

    const ll = stubLl();
    const gb = stubGb((title) => `gb-${title.slice(0, 3)}`);
    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, cap: 10, pacer: async () => {} });

    expect(report.minted).toBe(3);
    // The drain order: oldest cohort first (both day-16 anchors), ISBN-bearing first WITHIN it, then
    // the newer day-18 item last — the exact inverse of the old fresh-newest-first churn.
    expect(gb.calls).toEqual(['Cohort With Isbn', 'Cohort Title Only', 'Newer Item']);
  });
});

// ---------------------------------------------------------------------------
// DESIGN-039 D-23 — the daily CALL BUDGET skip (breaker untouched).
// ---------------------------------------------------------------------------

/** A GB stub that also feeds the call meter (simulating the http wrapper's per-leg onCall). */
function stubGbMetered(meter: { onCall: () => void }, legsPerCall: number, resolve: (title: string) => string | null) {
  const calls: string[] = [];
  return {
    calls,
    gb: {
      resolveVolume: async (input: { isbn?: string | null; title: string; author?: string | null }) => {
        calls.push(input.title);
        for (let i = 0; i < legsPerCall; i += 1) meter.onCall();
        const v = resolve(input.title);
        return v ? { volumeId: v } : null;
      },
    },
  };
}

describe('mintPairingWants — daily call budget skip (DESIGN-039 D-23)', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));
  const now = new Date('2026-07-19T08:00:00Z');

  it('spends the budget, then skips GB-requiring candidates (skippedBudget) — WITHOUT tripping the breaker', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await seedItem({ title: `Budget Book ${i}`, author: `Auth ${i}`, mediaKind: 'book', firstSeenAt: day(i) });
    }
    const ll = stubLl();
    const meter = createGbCallMeter();
    // A 2-call daily slice: the first two resolves (1 leg each) spend it, the rest skip. reserveOverride:1
    // exercises the raw per-call boundary at this tiny budget (the reserve-before-commit gate is covered
    // by the gb-call-budget 201/200 regression test).
    const budget = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now,
      budgetOverride: 2,
      reserveOverride: 1,
    });
    const gb = stubGbMetered(meter, 1, (title) => `gb-${title.slice(-1)}`);

    const report = await mintPairingWants({
      db: t.db,
      ll: ll.bundle,
      gb: gb.gb,
      meter,
      budget,
      cap: 10,
      now,
      pacer: async () => {},
    });

    expect(gb.calls).toHaveLength(2); // only two real GB resolves happened
    expect(report.attempted).toBe(2); // the budget skips consume NO cap
    expect(report.skippedBudget).toBe(3);
    expect(report.skippedQuota).toBe(0); // NOT the 429 breaker — our own pacing
    // Durably persisted for the next run.
    expect((await readGbBudgetUsage({ db: t.db, now })).pairing).toBe(2);
    // The shared breaker was NEVER tripped by a budget skip.
    expect((await peekGbQuotaGate({ db: t.db, now })).open).toBe(false);
  });

  it('an identity-holding candidate still pushes for FREE while the GB budget is spent', async () => {
    // A pairing want that ALREADY holds its llBookId (a prior run / reuse resolved it) needs no GB
    // call, so a spent GB budget does not stop it pushing the still-missing format.
    const itemId = await seedItem({ title: 'Reusable Work', author: 'Reuse Author', mediaKind: 'book', firstSeenAt: day(1) });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: itemId,
      title: 'Reusable Work',
      author: 'Reuse Author',
      llBookId: 'gb-reused',
      ebookStatus: 'landed', // the book anchor holds the ebook
      audioStatus: 'requested', // the missing audiobook is still wanted
    });

    const ll = stubLl();
    const meter = createGbCallMeter();
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 1, now }); // pre-spend the pairing slice
    const budget = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now,
      budgetOverride: 1,
      reserveOverride: 1,
    });
    expect(budget.canSpend()).toBe(false);
    const gb = stubGbMetered(meter, 1, () => 'gb-should-not-be-called');

    const report = await mintPairingWants({
      db: t.db, ll: ll.bundle, gb: gb.gb, meter, budget, cap: 10, now, pacer: async () => {},
    });

    expect(gb.calls).toHaveLength(0); // identity already held ⇒ zero GB calls
    expect(report.pushed).toBe(1); // pushed the missing audiobook via the held id
    expect(report.skippedBudget).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #661 — a Kavita row is a SERIES: the anchor is the one book it holds.
// The rows below are the live ones from the issue (Kavita series → the file it holds), 2026-10-03.
// ---------------------------------------------------------------------------

const held = (title: string | null, extra: Partial<HeldBook> = {}): HeldBook => ({
  title,
  author: extra.author ?? null,
  isbn: extra.isbn ?? null,
});

/** The issue's Kavita series, as books-sync now mirrors them (series name + attrs.heldBooks). */
const ISSUE_ROWS = {
  fireAndBlood: {
    title: 'A Song of Ice and Fire',
    author: 'George R.R. Martin',
    heldBooks: [held('Fire & Blood', { author: 'George R. R. Martin', isbn: '9781524796280' })],
  },
  beedle: {
    title: 'Hogwarts Library Books',
    author: 'J.K. Rowling',
    heldBooks: [held('The Tales of Beedle the Bard', { author: 'J. K. Rowling' })],
  },
  murtagh: {
    // The live row has no author (no author folder, no series writer); the book's writer fills it.
    title: 'The Inheritance Cycle',
    author: null,
    heldBooks: [held('Murtagh', { author: 'Christopher Paolini' })],
  },
  ssn: {
    title: 'Tom Clancy NF',
    author: 'Tom Clancy',
    heldBooks: [held('Tom Clancy NF [08] - SSN', { author: 'Martin Greenberg', isbn: '9780425173534' })],
  },
  lays: {
    title: 'The History of Middle-Earth',
    author: 'J.R.R. Tolkien',
    heldBooks: [
      held('The Lays of Beleriand (The History of Middle-Earth, Vol. 3)', {
        author: 'Christopher Tolkien (Editor)',
        isbn: '9780261102057',
      }),
    ],
  },
  jackRyan: {
    title: 'Jack Ryan',
    author: 'Tom Clancy',
    heldBooks: [held('Without Remorse', { author: 'Tom Clancy' }), held('Ryan 11: Red Rabbit', { author: 'Tom Clancy', isbn: '9780425191187' })],
  },
} as const;

describe('pairingIdentity — the anchor is the book held, never the series name (issue #661)', () => {
  const book = (r: { title: string; author: string | null; heldBooks: readonly HeldBook[] }) =>
    pi({ title: r.title, author: r.author, mediaKind: 'book', heldBooks: r.heldBooks });

  it('a one-book series is that book: its own title, the row author, the book ISBN', () => {
    expect(pairingIdentity(book(ISSUE_ROWS.fireAndBlood))).toEqual({
      kind: 'one',
      title: 'Fire & Blood',
      author: 'George R.R. Martin',
      isbn: '9781524796280',
    });
    expect(pairingIdentity(book(ISSUE_ROWS.beedle))).toMatchObject({ kind: 'one', title: 'The Tales of Beedle the Bard', author: 'J.K. Rowling' });
  });

  it("the book's writer fills a series row with no author", () => {
    expect(pairingIdentity(book(ISSUE_ROWS.murtagh))).toEqual({
      kind: 'one',
      title: 'Murtagh',
      author: 'Christopher Paolini',
      isbn: null,
    });
  });

  it('strips the series decoration Kavita titles carry (a numbered prefix, a trailing series bracket)', () => {
    expect(pairingIdentity(book(ISSUE_ROWS.ssn))).toEqual({ kind: 'one', title: 'SSN', author: 'Tom Clancy', isbn: '9780425173534' });
    expect(pairingIdentity(book(ISSUE_ROWS.lays))).toMatchObject({ kind: 'one', title: 'The Lays of Beleriand' });
  });

  it('a series holding several books is multi_book (Jack Ryan: Without Remorse + Red Rabbit)', () => {
    expect(pairingIdentity(book(ISSUE_ROWS.jackRyan))).toEqual({ kind: 'multi_book', books: 2 });
  });

  it('two copies of the same book are one book (The Dark Artifices holds Queen of Air and Darkness twice)', () => {
    const qoaad = 'Queen of Air and Darkness (The Dark Artifices #3)';
    expect(
      pairingIdentity(pi({ title: 'The Dark Artifices', author: 'Cassandra Clare', mediaKind: 'book', heldBooks: [held(qoaad), held(qoaad)] })),
    ).toEqual({ kind: 'one', title: 'Queen of Air and Darkness', author: 'Cassandra Clare', isbn: null });
  });

  it('falls back to the series name only for ONE book with no title of its own', () => {
    expect(pairingIdentity(pi({ title: 'Kiss Kiss', author: 'Roald Dahl', mediaKind: 'book', heldBooks: [held(null)] }))).toMatchObject({
      kind: 'one',
      title: 'Kiss Kiss',
    });
    // Several untitled books never fall back to the series name.
    expect(pairingIdentity(pi({ title: 'Poldark', author: 'Winston Graham', mediaKind: 'book', heldBooks: [held(null), held(null)] }))).toEqual({
      kind: 'multi_book',
      books: 2,
    });
  });

  it('no book file is no_book; a row never read for its books is unknown (never guessed)', () => {
    expect(pairingIdentity(pi({ title: 'Percy Jackson', author: 'Rick Riordan', mediaKind: 'book', heldBooks: [] }))).toEqual({ kind: 'no_book' });
    expect(pairingIdentity(pi({ title: 'Percy Jackson', author: 'Rick Riordan', mediaKind: 'book' }))).toEqual({ kind: 'unknown' });
  });

  it('an ABS audiobook is always its own one book', () => {
    expect(pairingIdentity(pi({ title: 'Outlander', author: 'Diana Gabaldon', mediaKind: 'audiobook', isbn: '9780440212560' }))).toEqual({
      kind: 'one',
      title: 'Outlander',
      author: 'Diana Gabaldon',
      isbn: '9780440212560',
    });
  });
});

describe('stripSeriesDecoration', () => {
  it('strips a leading series + number and a trailing bracket naming the series', () => {
    expect(stripSeriesDecoration('Hainish Cycle - 07 - Four Ways to Forgiveness', 'Hainish Cycle')).toBe('Four Ways to Forgiveness');
    expect(stripSeriesDecoration('Stormlight Archive [02] Words of Radiance', 'The Stormlight Archive')).toBe('Words of Radiance');
    expect(stripSeriesDecoration('Cibola Burn (The Expanse)', 'The Expanse')).toBe('Cibola Burn');
    expect(stripSeriesDecoration('The Book of Dust: La Belle Sauvage (Book of Dust, Volume 1)', 'The Book of Dust')).toBe(
      'The Book of Dust: La Belle Sauvage',
    );
  });

  it('keeps everything else exactly as Kavita has it', () => {
    // Starts with the series name but no number follows: a real title, not a decoration.
    expect(stripSeriesDecoration('Dune Messiah', 'Dune')).toBe('Dune Messiah');
    // A bracket that does not name the series stays.
    expect(stripSeriesDecoration('Project Hail Mary (Unabridged)', 'Project Hail Mary')).toBe('Project Hail Mary (Unabridged)');
    expect(stripSeriesDecoration('Murtagh (The World of Eragon)', 'The Inheritance Cycle')).toBe('Murtagh (The World of Eragon)');
    // A one-letter bracket never matches by substring.
    expect(stripSeriesDecoration('Something (A)', 'The Dark Artifices')).toBe('Something (A)');
    // A strip that would leave no title is not done.
    expect(stripSeriesDecoration('Expanse 05', 'Expanse')).toBe('Expanse 05');
    expect(stripSeriesDecoration('Fire & Blood', 'A Song of Ice and Fire')).toBe('Fire & Blood');
  });
});

describe('stripAuthorDecoration', () => {
  it('drops an author credit joined by a spaced dash, first or last', () => {
    expect(stripAuthorDecoration('Dead in the Family - Charlaine Harris', 'Charlaine Harris')).toBe('Dead in the Family');
    expect(stripAuthorDecoration('Roald Dahl - The Enormous Crocodile', 'Roald Dahl')).toBe('The Enormous Crocodile');
    expect(stripAuthorDecoration('Dean R Koontz - Mr. Murder', 'Dean Koontz')).toBe('Mr. Murder');
  });

  it('keeps a dash that does not credit the author, and everything when the author is unknown', () => {
    expect(stripAuthorDecoration('SSN - A Strategy Guide to Submarine Warfare', 'Tom Clancy')).toBe('SSN - A Strategy Guide to Submarine Warfare');
    expect(stripAuthorDecoration('The Lord of the Rings - Gary Russell', 'J.R.R. Tolkien')).toBe('The Lord of the Rings - Gary Russell');
    expect(stripAuthorDecoration('Dead in the Family - Charlaine Harris', null)).toBe('Dead in the Family - Charlaine Harris');
    expect(stripAuthorDecoration('Spider-Man', 'Stan Lee')).toBe('Spider-Man');
  });
});

describe('matchFormatPairs — a one-book Kavita series pairs on the book it holds (issue #661)', () => {
  it('a series named for its book keeps its pair when a second series holds the same book', () => {
    // Live: "Heretics of Dune" (series) and "Dune" (series) both hold Heretics of Dune; one audiobook.
    const named = pi({ title: 'Heretics of Dune', author: 'Frank Herbert', mediaKind: 'book', heldBooks: [held('Heretics of Dune')] });
    const other = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book', heldBooks: [held('Heretics Of Dune')] });
    const audio = pi({ title: 'Heretics of Dune', author: 'Frank Herbert', mediaKind: 'audiobook' });
    // "dune" sorts before "heretics of dune", yet the series named for the book claims the audiobook.
    expect(matchFormatPairs([other, named, audio])).toEqual([{ bookItemId: named.id, audioItemId: audio.id, matchedVia: 'title_author' }]);
  });

  it('pairs the held book with its audiobook, where the series name never could', () => {
    const series = pi({ title: 'Bobiverse', author: 'Dennis E. Taylor', mediaKind: 'book', heldBooks: [held("Heaven's River")] });
    const audio = pi({ title: "Heaven's River", author: 'Dennis E. Taylor', mediaKind: 'audiobook' });
    expect(matchFormatPairs([series, audio])).toEqual([{ bookItemId: series.id, audioItemId: audio.id, matchedVia: 'title_author' }]);
  });

  it("no longer pairs a series with an audiobook named like the series (Dune holding Heretics of Dune is not 'Dune')", () => {
    const series = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book', heldBooks: [held('Heretics Of Dune')] });
    const audio = pi({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'audiobook' });
    expect(matchFormatPairs([series, audio])).toEqual([]);
  });

  it("uses the book's writer when the series row has no author (Murtagh)", () => {
    const series = pi({ ...ISSUE_ROWS.murtagh, mediaKind: 'book' });
    const audio = pi({ title: 'Murtagh', author: 'Christopher Paolini', mediaKind: 'audiobook' });
    expect(matchFormatPairs([series, audio])).toHaveLength(1);
  });

  it('a multi-book or unread series keeps its row title (no change for them)', () => {
    const multi = pi({ title: 'Dreamblood', author: 'N.K. Jemisin', mediaKind: 'book', heldBooks: [held('The Killing Moon'), held('The Shadowed Sun')] });
    const unread = pi({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'book' });
    const a1 = pi({ title: 'Dreamblood', author: 'N.K. Jemisin', mediaKind: 'audiobook' });
    const a2 = pi({ title: 'Hyperion', author: 'Dan Simmons', mediaKind: 'audiobook' });
    expect(matchFormatPairs([multi, unread, a1, a2])).toHaveLength(2);
  });
});

describe('mintPairingWants — the want describes the book held (issue #661)', () => {
  async function seedSeries(r: { title: string; author: string | null; heldBooks?: readonly HeldBook[] }): Promise<string> {
    return seedItem({
      title: r.title,
      author: r.author,
      mediaKind: 'book',
      attrs: r.heldBooks !== undefined ? { heldBooks: r.heldBooks } : {},
    });
  }

  it('resolves and snapshots each issue row by its held book, and skips the two-book series', async () => {
    const ids = {
      fireAndBlood: await seedSeries(ISSUE_ROWS.fireAndBlood),
      beedle: await seedSeries(ISSUE_ROWS.beedle),
      murtagh: await seedSeries(ISSUE_ROWS.murtagh),
      ssn: await seedSeries(ISSUE_ROWS.ssn),
      jackRyan: await seedSeries(ISSUE_ROWS.jackRyan),
    };
    const ll = stubLl();
    // The resolver answers ONLY for single-book titles; a series name would be a box set (left unanswered).
    const volumes: Record<string, string> = {
      'Fire & Blood': 'gb-fire-and-blood',
      'The Tales of Beedle the Bard': 'gb-beedle',
      Murtagh: 'gb-murtagh',
      SSN: 'gb-ssn',
    };
    const gb = stubGb((title) => volumes[title] ?? null);

    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(report).toMatchObject({ attempted: 4, minted: 4, pushed: 4, unmintable: 0, skippedNotOneBook: 1, skippedUnknownHeld: 0, parked: 0 });
    // The GB resolve saw the books, never a series name.
    expect(gb.inputs.map((i) => i.title).sort()).toEqual(['Fire & Blood', 'Murtagh', 'SSN', 'The Tales of Beedle the Bard']);
    expect(gb.inputs.find((i) => i.title === 'Fire & Blood')).toMatchObject({ isbn: '9781524796280', author: 'George R.R. Martin' });
    expect(gb.inputs.find((i) => i.title === 'SSN')).toMatchObject({ isbn: '9780425173534', author: 'Tom Clancy' });
    expect(gb.inputs.find((i) => i.title === 'Murtagh')).toMatchObject({ author: 'Christopher Paolini' });

    const wants = await t.db.select().from(bookRequests);
    const byAnchor = new Map(wants.map((w) => [w.pairingBooksItemId, w]));
    expect(byAnchor.get(ids.fireAndBlood)).toMatchObject({ title: 'Fire & Blood', llBookId: 'gb-fire-and-blood', audioStatus: 'wanted' });
    expect(byAnchor.get(ids.beedle)).toMatchObject({ title: 'The Tales of Beedle the Bard', llBookId: 'gb-beedle' });
    expect(byAnchor.get(ids.murtagh)).toMatchObject({ title: 'Murtagh', author: 'Christopher Paolini', llBookId: 'gb-murtagh' });
    expect(byAnchor.get(ids.ssn)).toMatchObject({ title: 'SSN', llBookId: 'gb-ssn' });
    // The two-book series mints nothing and pushes nothing.
    expect(byAnchor.has(ids.jackRyan)).toBe(false);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.id).sort()).toEqual(
      ['gb-beedle', 'gb-fire-and-blood', 'gb-murtagh', 'gb-ssn'],
    );
  });

  it('a series not yet read for its held books waits: no GB call, no want, no cap spent', async () => {
    await seedSeries({ title: 'A Song of Ice and Fire', author: 'George R.R. Martin' }); // attrs {} — unread
    const gb = stubGb(() => 'gb-box-set');
    const report = await mintPairingWants({ db: t.db, gb: gb.gb, pacer: async () => {} });
    expect(report).toMatchObject({ attempted: 0, minted: 0, skippedUnknownHeld: 1 });
    expect(gb.calls).toHaveLength(0);
    expect(await t.db.select().from(bookRequests)).toHaveLength(0);
  });

  it('parks an UNPUSHED want on a multi-book series, and leaves a pushed one to LazyLibrarian', async () => {
    const jackRyan = await seedSeries(ISSUE_ROWS.jackRyan);
    const dreamblood = await seedSeries({
      title: 'Dreamblood',
      author: 'N.K. Jemisin',
      heldBooks: [held('The Killing Moon'), held('The Shadowed Sun')],
    });
    const [unpushed] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: jackRyan, title: 'Jack Ryan', author: 'Tom Clancy', ebookStatus: 'landed', audioStatus: 'requested' })
      .returning();
    const [pushed] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: dreamblood, title: 'Dreamblood', author: 'N.K. Jemisin', llBookId: 'gb-dreamblood', ebookStatus: 'landed', audioStatus: 'wanted' })
      .returning();
    const gb = stubGb(() => 'gb-jack-ryan-books-7-12');
    const ll = stubLl();

    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(report).toMatchObject({ attempted: 0, parked: 1 });
    expect(gb.calls).toHaveLength(0);
    expect(ll.calls).toHaveLength(0);
    const [a] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, unpushed!.id));
    expect(a).toMatchObject({ unroutableReason: 'multi_book', llBookId: null, audioStatus: 'requested' });
    const [b] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, pushed!.id));
    expect(b).toMatchObject({ unroutableReason: null, llBookId: 'gb-dreamblood', audioStatus: 'wanted' });
    expect(b!.updatedAt.getTime()).toBe(pushed!.updatedAt.getTime());
  });

  it('a lifted park re-resolves to the held book and pushes it (the stale status resets to requested)', async () => {
    // The 2026-10-03 bundle audit parked this want (box set) and cleared its id; the park is lifted by
    // clearing unroutable_reason. Its audio status still reads `grabbed` from the box set.
    const anchor = await seedSeries(ISSUE_ROWS.murtagh);
    const [lifted] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchor,
        title: 'The Inheritance Cycle',
        author: null,
        llBookId: null,
        unroutableReason: null,
        ebookStatus: 'landed',
        audioStatus: 'grabbed',
      })
      .returning();
    const gb = stubGb((title) => (title === 'Murtagh' ? 'gb-murtagh' : 'gb-inheritance-box-set'));
    const ll = stubLl();

    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(report).toMatchObject({ attempted: 1, minted: 0, pushed: 1 });
    expect(gb.inputs).toEqual([expect.objectContaining({ title: 'Murtagh', author: 'Christopher Paolini' })]);
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-murtagh' },
      { cmd: 'queueBook', id: 'gb-murtagh', format: 'audiobook' },
      { cmd: 'searchBook', id: 'gb-murtagh', format: 'audiobook' },
    ]);
    const [after] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, lifted!.id));
    expect(after).toMatchObject({ title: 'Murtagh', author: 'Christopher Paolini', llBookId: 'gb-murtagh', audioStatus: 'wanted', ebookStatus: 'landed' });
  });
});

describe('syncFormatPairs — the re-vanish heals only a pair that dropped this run', () => {
  it('never resets a landed want on an anchor that was not paired (LazyLibrarian holds the format)', async () => {
    const anchor = await seedItem({ title: 'Lonely Book', author: 'Someone', mediaKind: 'book' });
    const [want] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: anchor, title: 'Lonely Book', author: 'Someone', llBookId: 'gb-lonely', ebookStatus: 'landed', audioStatus: 'landed' })
      .returning();
    const report = await syncFormatPairs({ db: t.db });
    expect(report.revived).toBe(0);
    const [after] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id));
    expect(after!.audioStatus).toBe('landed');
  });

  it('a pair that breaks because the series turns out to hold another book revives its want', async () => {
    // Paired on the series name before the held books were read; once read, the series holds Heretics
    // of Dune, the pair drops, and the landed want wants the held book's audiobook again.
    const series = await seedItem({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'book', attrs: {} });
    await seedItem({ title: 'Dune', author: 'Frank Herbert', mediaKind: 'audiobook' });
    expect((await syncFormatPairs({ db: t.db })).paired).toBe(1);
    const [want] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: series, title: 'Dune', author: 'Frank Herbert', llBookId: 'gb-dune', ebookStatus: 'landed', audioStatus: 'landed' })
      .returning();
    await t.db.update(booksItems).set({ attrs: { heldBooks: [held('Heretics Of Dune')] } }).where(eq(booksItems.id, series));

    const report = await syncFormatPairs({ db: t.db });
    expect(report).toMatchObject({ paired: 0, dropped: 1, revived: 1 });
    const [after] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id));
    expect(after!.audioStatus).toBe('requested');
  });
});

// ---------------------------------------------------------------------------
// Issue #693 — a want is never satisfied by another volume or work (DESIGN-036 amendment 2026-10-05).
// ---------------------------------------------------------------------------

/** An LL stub whose snapshot is a REAL map with titles (the usable snapshot the identity check needs). */
function stubLlBooks(books: Record<string, StubLlStatus & { title: string; subtitle?: string; author?: string; language?: string | null }>) {
  const ll = stubLl();
  const map = new Map(
    Object.entries(books).map(([id, b]) => [
      id,
      {
        bookId: id,
        title: b.title,
        subtitle: b.subtitle ?? null,
        author: b.author ?? null,
        language: b.language ?? null,
        ebookStatus: b.ebookStatus,
        audioStatus: b.audioStatus,
        ebookLibrary: b.ebookLibrary ?? null,
        audioLibrary: b.audioLibrary ?? null,
        ebookFile: b.ebookFile ?? null,
        audioFile: b.audioFile ?? null,
      },
    ]),
  );
  (ll.bundle.read as { getAllBookStatuses: () => Promise<unknown> }).getAllBookStatuses = async () => map;
  return ll;
}

describe('judgePairingWantBook (issue #693)', () => {
  it('clears a current want whose book LazyLibrarian names as another volume (ACOTAR bk 2 on book 1)', () => {
    expect(
      judgePairingWantBook({
        want: { title: 'Court of Thorns and Roses bk 2', llBookId: 'E-kdBQAAQBAJ' },
        identity: { title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas' },
        book: { title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas' },
      }),
    ).toEqual({ kind: 'clear', reason: 'volume' });
  });

  it('clears a want whose anchor now holds another book and whose id names the old one (Twilight → Breaking Dawn)', () => {
    expect(
      judgePairingWantBook({
        want: { title: 'Twilight', llBookId: 'o37NuQEACAAJ' },
        identity: { title: 'Breaking Dawn', author: 'Stephenie Meyer' },
        book: { title: 'Twilight', author: 'Stephenie Meyer' },
      }),
    ).toEqual({ kind: 'clear', reason: 'identity' });
    // An id LazyLibrarian no longer holds cannot vouch for the new book either.
    expect(
      judgePairingWantBook({
        want: { title: 'Fear Street', llBookId: 'gone' },
        identity: { title: 'The Prom Queen', author: 'R.L. Stine' },
        book: undefined,
      }),
    ).toEqual({ kind: 'clear', reason: 'identity' });
  });

  it('only re-titles when the id already names the new book, and keeps a decorated match', () => {
    expect(
      judgePairingWantBook({
        want: { title: 'Twilight Saga 3 - Eclipse', llBookId: 'fpV0' },
        identity: { title: 'Eclipse', author: 'Stephenie Meyer' },
        book: { title: 'Eclipse', author: 'Stephenie Meyer' },
      }),
    ).toEqual({ kind: 'retitle' });
    expect(
      judgePairingWantBook({
        want: { title: "Caliban's War: The Expanse, Book 2", llBookId: 'tXG' },
        identity: { title: "Caliban's War: The Expanse, Book 2", author: 'James S. A. Corey' },
        book: { title: "Caliban's War", author: 'James S. A. Corey' },
      }),
    ).toEqual({ kind: 'keep' });
    // A current want whose id LazyLibrarian lost is the gone rule's (#665), not this check's.
    expect(
      judgePairingWantBook({
        want: { title: 'Hyperion', llBookId: 'gone' },
        identity: { title: 'Hyperion', author: 'Dan Simmons' },
        book: undefined,
      }),
    ).toEqual({ kind: 'keep' });
  });
});

describe('runFormatPairing — the identity check (issue #693)', () => {
  it('the Breaking Dawn shape: a series now holding another book drops the old id and wants its own book', async () => {
    const anchor = await seedItem({
      title: 'Twilight',
      author: 'Stephenie Meyer',
      mediaKind: 'book',
      attrs: { heldBooks: [{ title: 'Breaking Dawn', author: 'Stephenie Meyer', isbn: null }] },
    });
    // Minted when the anchor was keyed on its series name: Twilight's id, and LazyLibrarian holds Twilight's audio.
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: anchor,
      title: 'Twilight',
      author: 'Stephenie Meyer',
      llBookId: 'o37NuQEACAAJ',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    const ll = stubLlBooks({
      o37NuQEACAAJ: { title: 'Twilight', author: 'Stephenie Meyer', ebookStatus: 'Open', audioStatus: 'Open' },
    });
    const gb = stubGb((title) => (title === 'Breaking Dawn' ? 'gb-breaking-dawn' : null));
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(run).toMatchObject({ reidentified: 1, pushed: 1 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ title: 'Breaking Dawn', llBookId: 'gb-breaking-dawn', audioStatus: 'wanted', ebookStatus: 'landed' });
    // LazyLibrarian was asked for Breaking Dawn only; Twilight was never queued for this want.
    expect(ll.calls.every((c) => c.id === 'gb-breaking-dawn')).toBe(true);
  });

  it('the ACOTAR bk 2 shape: a want on book 1 re-opens, and book 1 is refused when it resolves again', async () => {
    const anchor = await seedItem({ title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas', mediaKind: 'audiobook' });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: anchor,
      title: 'Court of Thorns and Roses bk 2',
      author: 'Sarah J. Maas',
      llBookId: 'E-kdBQAAQBAJ',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    const ll = stubLlBooks({
      'E-kdBQAAQBAJ': { title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas', ebookStatus: 'Open', audioStatus: 'Open' },
    });
    // A resolver that hands book 1 back for the book-2 title (what Google Books did before its volume guard).
    const gb = stubGb(() => 'E-kdBQAAQBAJ');
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(run).toMatchObject({ reidentified: 1, rejectedResolves: 1, unmintable: 1, pushed: 0, reconciled: 0 });
    const [want] = await t.db.select().from(bookRequests);
    // Truthful: the book-2 eBook is wanted, not landed, and the want no longer points at book 1.
    expect(want).toMatchObject({ llBookId: null, ebookStatus: 'requested', audioStatus: 'landed' });
    expect(ll.calls).toHaveLength(0);
  });

  it('a renamed audiobook that now pairs keeps nothing of the old book: id cleared, format landed by the pair', async () => {
    const audio = await seedItem({ title: 'A Court of Mist and Fury', author: 'Sarah J. Maas', mediaKind: 'audiobook' });
    await seedItem({ title: 'A Court of Mist and Fury', author: 'Sarah J. Maas', mediaKind: 'book' });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: audio,
      title: 'Court of Thorns and Roses bk 2',
      author: 'Sarah J. Maas',
      llBookId: 'E-kdBQAAQBAJ',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    const ll = stubLlBooks({
      'E-kdBQAAQBAJ': { title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas', ebookStatus: 'Open', audioStatus: 'Open' },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run.reidentified).toBe(1);
    const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.pairingBooksItemId, audio));
    expect(want).toMatchObject({ title: 'A Court of Mist and Fury', llBookId: null, ebookStatus: 'landed', audioStatus: 'landed' });
    expect(ll.calls).toHaveLength(0);
  });

  it('only re-titles a want whose id already names the renamed book (no LazyLibrarian call, status kept)', async () => {
    const audio = await seedItem({ title: 'Eclipse', author: 'Stephenie Meyer', mediaKind: 'audiobook' });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: audio,
      title: 'Twilight Saga 3 - Eclipse',
      author: 'Stephenie Meyer',
      llBookId: 'fpV0',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    const ll = stubLlBooks({ fpV0: { title: 'Eclipse', author: 'Stephenie Meyer', ebookStatus: 'Open', audioStatus: 'Open' } });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run).toMatchObject({ retitled: 1, reidentified: 0 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ title: 'Eclipse', llBookId: 'fpV0', ebookStatus: 'landed' });
    expect(ll.calls).toHaveLength(0);
  });

  it('decides nothing on an empty LazyLibrarian read (an error answer is not proof every book is gone)', async () => {
    const audio = await seedItem({ title: 'A Court of Mist and Fury', author: 'Sarah J. Maas', mediaKind: 'audiobook' });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: audio,
      title: 'Court of Thorns and Roses bk 2',
      author: 'Sarah J. Maas',
      llBookId: 'E-kdBQAAQBAJ',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    const run = await runFormatPairing({ db: t.db, ll: stubLlBooks({}).bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run).toMatchObject({ reidentified: 0, retitled: 0 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.llBookId).toBe('E-kdBQAAQBAJ');
  });

  it('without the identity check (degraded run) a stale id is still never reused for the new book', async () => {
    const anchor = await seedItem({
      title: 'Twilight',
      author: 'Stephenie Meyer',
      mediaKind: 'book',
      attrs: { heldBooks: [{ title: 'Breaking Dawn', author: 'Stephenie Meyer', isbn: null }] },
    });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: anchor,
      title: 'Twilight',
      author: 'Stephenie Meyer',
      llBookId: 'o37NuQEACAAJ',
      ebookStatus: 'landed',
      audioStatus: 'requested', // the re-vanish put it back on the retry queue
    });
    const gb = stubGb((title) => (title === 'Breaking Dawn' ? 'gb-breaking-dawn' : null));
    const report = await mintPairingWants({ db: t.db, gb: gb.gb, pacer: async () => {} });
    expect(report.attempted).toBe(1);
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ title: 'Breaking Dawn', llBookId: 'gb-breaking-dawn' });
  });
});

// ---------------------------------------------------------------------------
// Issue #700 — the F10 English-only rule: pairing never asks for the other format of a foreign-language item.
// ---------------------------------------------------------------------------

describe('classifyBookLanguage (issue #700)', () => {
  it('English: en, eng, en-*, English in any case', () => {
    for (const v of ['en', 'EN', 'eng', 'ENG', 'en-US', 'en-GB', 'English', 'english', ' English ']) {
      expect(classifyBookLanguage(v), v).toBe('english');
    }
  });

  it('unknown (pairing allowed): blank, null, XXX and LazyLibrarian\'s Unknown', () => {
    for (const v of [null, undefined, '', '   ', 'XXX', 'xxx', 'Unknown']) {
      expect(classifyBookLanguage(v), String(v)).toBe('unknown');
    }
  });

  it('foreign: any other value, code or name', () => {
    for (const v of ['nl', 'de', 'es', 'German', 'Dutch', 'fr-CA', 'eng-ish', 'ger']) {
      expect(classifyBookLanguage(v), v).toBe('foreign');
    }
  });
});

describe('mintPairingWants — the language rule (issue #700)', () => {
  it('mints for English and unknown anchors only; a foreign anchor (both sources) gets no want and no push', async () => {
    const english = {
      en: await seedItem({ title: 'Anchor En', author: 'A Writer', mediaKind: 'audiobook', attrs: { language: 'en' } }),
      enUs: await seedItem({ title: 'Anchor EnUs', author: 'A Writer', mediaKind: 'book', attrs: { language: 'en-US', heldBooks: [{ title: 'Anchor EnUs', author: 'A Writer', isbn: null }] } }),
      english: await seedItem({ title: 'Anchor English', author: 'A Writer', mediaKind: 'audiobook', attrs: { language: 'English' } }),
    };
    const unknown = {
      blank: await seedItem({ title: 'Anchor Blank', author: 'A Writer', mediaKind: 'audiobook', attrs: { language: '' } }),
      xxx: await seedItem({ title: 'Anchor Xxx', author: 'A Writer', mediaKind: 'audiobook', attrs: { language: 'XXX' } }),
      none: await seedItem({ title: 'Anchor None', author: 'A Writer', mediaKind: 'audiobook', attrs: {} }),
    };
    const foreign = {
      de: await seedItem({ title: 'Chroniken der Unterwelt (4-6)', author: 'Cassandra Clare', mediaKind: 'audiobook', attrs: { language: 'de' } }),
      nl: await seedItem({ title: 'Anchor Nl', author: 'A Writer', mediaKind: 'book', attrs: { language: 'nl', heldBooks: [{ title: 'Anchor Nl', author: 'A Writer', isbn: null }] } }),
      es: await seedItem({ title: 'Anchor Es', author: 'A Writer', mediaKind: 'book', attrs: { language: 'es', heldBooks: [{ title: 'Anchor Es', author: 'A Writer', isbn: null }] } }),
      german: await seedItem({ title: 'Anchor German', author: 'A Writer', mediaKind: 'audiobook', attrs: { language: 'German' } }),
    };
    const gb = stubGb((title) => `gb-${title.replace(/\W+/g, '-').toLowerCase()}`);
    const ll = stubLl();

    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(report).toMatchObject({ attempted: 6, minted: 6, pushed: 6, skippedForeign: 4, parked: 0 });
    const wants = await t.db.select().from(bookRequests);
    const anchors = new Set(wants.map((w) => w.pairingBooksItemId));
    for (const id of [...Object.values(english), ...Object.values(unknown)]) expect(anchors.has(id)).toBe(true);
    for (const id of Object.values(foreign)) expect(anchors.has(id)).toBe(false);
    // Nothing was resolved or pushed for a foreign title.
    expect(gb.calls.some((c) => /Chroniken|Nl|Es|German/.test(c))).toBe(false);
    expect(ll.calls.every((c) => !/chroniken|nl|es$|german/.test(c.id))).toBe(true);
  });

  it('parks every OPEN want on a foreign anchor (the de Audiobookshelf shape), and leaves a landed one alone', async () => {
    const chroniken = await seedItem({ title: 'Chroniken der Unterwelt (4-6)', author: 'Cassandra Clare', mediaKind: 'audiobook', attrs: { language: 'de' } });
    const dutch = await seedItem({ title: 'Een Boek', author: 'Een Schrijver', mediaKind: 'book', attrs: { language: 'nl', heldBooks: [{ title: 'Een Boek', author: 'Een Schrijver', isbn: null }] } });
    const [unpushed] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: chroniken, title: 'Chroniken der Unterwelt (4-6)', author: 'Cassandra Clare', llBookId: 'ik6xzgEACAAJ', ebookStatus: 'requested', audioStatus: 'landed' })
      .returning();
    // Pushed and in flight (LazyLibrarian is working it), and one settled `missing`: both are open, so both park.
    const [pushed] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: dutch, title: 'Een Boek', author: 'Een Schrijver', llBookId: 'gb-een-boek', ebookStatus: 'landed', audioStatus: 'wanted' })
      .returning();
    const gone = await seedItem({ title: 'Ein Buch', author: 'Ein Autor', mediaKind: 'book', attrs: { language: 'de', heldBooks: [{ title: 'Ein Buch', author: 'Ein Autor', isbn: null }] } });
    const [missing] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: gone, title: 'Ein Buch', author: 'Ein Autor', llBookId: 'gb-ein-buch', ebookStatus: 'landed', audioStatus: 'missing' })
      .returning();
    // The other format already landed: nothing is wanted, so nothing to park.
    const done = await seedItem({ title: 'Un Livre', author: 'Un Auteur', mediaKind: 'book', attrs: { language: 'fr', heldBooks: [{ title: 'Un Livre', author: 'Un Auteur', isbn: null }] } });
    const [landed] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: done, title: 'Un Livre', author: 'Un Auteur', llBookId: 'gb-un-livre', ebookStatus: 'landed', audioStatus: 'landed' })
      .returning();
    const gb = stubGb(() => 'gb-should-not-resolve');
    const ll = stubLl();

    const report = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(report).toMatchObject({ attempted: 0, minted: 0, pushed: 0, parked: 3, skippedForeign: 0 });
    expect(gb.calls).toHaveLength(0);
    expect(ll.calls).toHaveLength(0);
    const [a] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, unpushed!.id));
    expect(a).toMatchObject({ unroutableReason: 'foreign_language', ebookStatus: 'requested' });
    const [b] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, pushed!.id));
    expect(b).toMatchObject({ unroutableReason: 'foreign_language', llBookId: 'gb-een-boek', audioStatus: 'wanted' });
    const [m] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, missing!.id));
    expect(m).toMatchObject({ unroutableReason: 'foreign_language', audioStatus: 'missing' });
    const [l] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, landed!.id));
    expect(l).toMatchObject({ unroutableReason: null, audioStatus: 'landed' });
    expect(l!.updatedAt.getTime()).toBe(landed!.updatedAt.getTime());

    // A parked want stays parked on the next run (the park is its own decision).
    const again = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(again).toMatchObject({ attempted: 0, parked: 0 });
    expect(ll.calls).toHaveLength(0);
  });
});

describe("runFormatPairing — the push-time guard on LazyLibrarian's own language (issue #700)", () => {
  /** An anchor the library reads as English (the 525913ff shape) whose LazyLibrarian book may say otherwise. */
  async function seedEnglishAnchor(title = 'Chroniken der Unterwelt'): Promise<string> {
    return seedItem({ title, author: 'Cassandra Clare', mediaKind: 'audiobook', attrs: { language: 'English' } });
  }

  it("a book LazyLibrarian labels German is not queued or searched: the want is parked foreign_language", async () => {
    const anchor = await seedEnglishAnchor();
    const ll = stubLlBooks({
      'gb-chroniken': { title: 'Chroniken der Unterwelt', author: 'Cassandra Clare', ebookStatus: 'Skipped', audioStatus: 'Skipped', language: 'de' },
    });
    const gb = stubGb(() => 'gb-chroniken');

    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });

    expect(run).toMatchObject({ minted: 1, pushed: 0, refusedForeignBook: 1, parked: 1, requeued: 0 });
    expect(ll.calls).toHaveLength(0); // no addBook (already seated), no queueBook, no searchBook
    const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.pairingBooksItemId, anchor));
    expect(want).toMatchObject({ unroutableReason: 'foreign_language', ebookStatus: 'requested' });

    // Parked: a second run attempts nothing and still pushes nothing.
    const again = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(again).toMatchObject({ attempted: 0, pushed: 0, requeued: 0 });
    expect(ll.calls).toHaveLength(0);
  });

  it.each([
    ['en', 'en'],
    ['blank', null],
    ['Unknown', 'Unknown'],
  ])('proceeds when LazyLibrarian says %s', async (_label, language) => {
    await seedEnglishAnchor('Plain English Book');
    const ll = stubLlBooks({
      'gb-plain': { title: 'Plain English Book', author: 'Cassandra Clare', ebookStatus: 'Skipped', audioStatus: 'Skipped', language },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => 'gb-plain').gb, pacer: async () => {} });

    expect(run).toMatchObject({ pushed: 1, refusedForeignBook: 0, parked: 0 });
    // The mint's own chain (the snapshot still shows Skipped, so the run's sweep queues once more after it).
    expect(ll.calls.map((c) => c.cmd).slice(0, 2)).toEqual(['queueBook', 'searchBook']);
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ unroutableReason: null, ebookStatus: 'wanted' });
  });

  it('re-reads LazyLibrarian after an addBook that first seats the book, and refuses it when foreign', async () => {
    await seedEnglishAnchor('Frisch Gesetzt');
    // The run's snapshot holds another book only (so it is usable), and the book appears once addBook has run.
    const ll = stubLlBooks({
      'gb-other': { title: 'Another Book', author: 'Someone Else', ebookStatus: 'Open', audioStatus: 'Open' },
    });
    let added = false;
    const base = await ll.bundle.read.getAllBookStatuses();
    const withNew = new Map(base);
    withNew.set('gb-frisch', {
      bookId: 'gb-frisch',
      title: 'Frisch Gesetzt',
      subtitle: null,
      author: 'Cassandra Clare',
      language: 'de',
      ebookStatus: 'Skipped',
      audioStatus: 'Skipped',
      ebookLibrary: null,
      audioLibrary: null,
      ebookFile: null,
      audioFile: null,
    } as never);
    const write = ll.bundle.write as unknown as { addBook: (id: string) => Promise<string> };
    const origAdd = write.addBook;
    (ll.bundle.write as unknown as Record<string, unknown>).addBook = async (id: string) => {
      added = true;
      return origAdd(id);
    };
    (ll.bundle.read as { getAllBookStatuses: () => Promise<unknown> }).getAllBookStatuses = async () => (added ? withNew : base);

    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => 'gb-frisch').gb, pacer: async () => {} });

    expect(run).toMatchObject({ pushed: 0, refusedForeignBook: 1, parked: 1 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook']); // seated, never queued or searched
    const [want] = await t.db.select().from(bookRequests);
    expect(want).toMatchObject({ unroutableReason: 'foreign_language' });
  });

  it('the Skipped sweep never re-queues a book LazyLibrarian labels foreign', async () => {
    const anchor = await seedEnglishAnchor();
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: anchor,
      title: 'Chroniken der Unterwelt',
      author: 'Cassandra Clare',
      llBookId: 'gb-chroniken',
      ebookStatus: 'requested',
      audioStatus: 'landed',
    });
    const ll = stubLlBooks({
      'gb-chroniken': { title: 'Chroniken der Unterwelt', author: 'Cassandra Clare', ebookStatus: 'Skipped', audioStatus: 'Open', language: 'de' },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });

    expect(run).toMatchObject({ requeued: 0 });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook' || c.cmd === 'searchBook')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #712 — a foreign_language park is re-evaluated every run and lifts when the language turns English.
// ---------------------------------------------------------------------------

describe('foreign_language parks are re-evaluated every run (issue #712)', () => {
  const heldOne = (title: string) => [{ title, author: 'A Writer', isbn: null }];
  /** A Kavita BOOK anchor (holds one book) plus its open want, parked `foreign_language` the way #700 left it. */
  async function seedParked(opts: { title: string; language: string; llBookId?: string | null; reason?: string }) {
    const anchor = await seedItem({
      title: opts.title,
      author: 'A Writer',
      mediaKind: 'book',
      attrs: { language: opts.language, heldBooks: heldOne(opts.title) },
    });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchor,
        title: opts.title,
        author: 'A Writer',
        llBookId: opts.llBookId === undefined ? null : opts.llBookId,
        ebookStatus: 'landed',
        audioStatus: 'requested',
        unroutableReason: opts.reason ?? 'foreign_language',
      })
      .returning();
    return { anchor, want: want! };
  }
  const setLanguage = (anchor: string, language: string, title: string) =>
    t.db
      .update(booksItems)
      .set({ attrs: { language, heldBooks: heldOne(title) } })
      .where(eq(booksItems.id, anchor));
  const reasonOf = async (id: string) =>
    (await t.db.select().from(bookRequests).where(eq(bookRequests.id, id)))[0]!.unroutableReason;

  it('lifts the park once the anchor reads English, and the want flows through the mint in the same run', async () => {
    const { anchor, want } = await seedParked({ title: 'Fixed In Kavita', language: 'nl' });
    const gb = stubGb(() => 'gb-fixed');
    const ll = stubLl();

    // Still Dutch: stays parked, nothing attempted.
    const still = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(still).toMatchObject({ unparked: 0, attempted: 0, parked: 0 });
    expect(await reasonOf(want.id)).toBe('foreign_language');

    // The language is corrected (what books-sync now carries over from Kavita): the next run lifts it and mints.
    await setLanguage(anchor, 'en', 'Fixed In Kavita');
    const before = (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want.id)))[0]!;
    const run = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: gb.gb, pacer: async () => {} });
    expect(run).toMatchObject({ unparked: 1, attempted: 1, pushed: 1 });
    const after = (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want.id)))[0]!;
    expect(after.unroutableReason).toBeNull();
    expect(after.llBookId).toBe('gb-fixed');
    expect(before.updatedAt.getTime()).toBeLessThanOrEqual(after.updatedAt.getTime());
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
  });

  it('lifts for an anchor that now reads unknown (blank), too', async () => {
    const { anchor, want } = await seedParked({ title: 'Blank Now', language: 'de' });
    await setLanguage(anchor, '', 'Blank Now');
    const run = await mintPairingWants({ db: t.db, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run.unparked).toBe(1);
    expect(await reasonOf(want.id)).toBeNull();
  });

  it('stays parked while the anchor is still foreign (any foreign value), however often it runs', async () => {
    const a = await seedParked({ title: 'Still Dutch', language: 'nl' });
    const b = await seedParked({ title: 'Still German', language: 'German' });
    const ll = stubLl();
    for (let i = 0; i < 3; i += 1) {
      const run = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: stubGb(() => 'gb-x').gb, pacer: async () => {} });
      expect(run).toMatchObject({ unparked: 0, attempted: 0, parked: 0 });
    }
    expect(await reasonOf(a.want.id)).toBe('foreign_language');
    expect(await reasonOf(b.want.id)).toBe('foreign_language');
    expect(ll.calls).toHaveLength(0);
  });

  it('never lifts any other park reason, even on an English anchor', async () => {
    const wrongVolume = await seedParked({ title: 'Omnibus Repair', language: 'en', reason: 'wrong_volume' });
    const multi = await seedParked({ title: 'Many Books', language: 'en', reason: 'multi_book' });
    const none = await seedParked({ title: 'No Books', language: 'en', reason: 'no_book' });
    const ll = stubLl();
    const run = await mintPairingWants({ db: t.db, ll: ll.bundle, gb: stubGb(() => 'gb-x').gb, pacer: async () => {} });
    expect(run).toMatchObject({ unparked: 0, attempted: 0 });
    expect(await reasonOf(wrongVolume.want.id)).toBe('wrong_volume');
    expect(await reasonOf(multi.want.id)).toBe('multi_book');
    expect(await reasonOf(none.want.id)).toBe('no_book');
    expect(ll.calls).toHaveLength(0);
  });

  it('the single-writer lifts only foreign_language rows', async () => {
    const fl = await seedParked({ title: 'Writer Foreign', language: 'en' });
    const wv = await seedParked({ title: 'Writer Wrong Volume', language: 'en', reason: 'wrong_volume' });
    expect(await unparkForeignLanguageWant({ db: t.db, requestId: wv.want.id })).toBe(false);
    expect(await reasonOf(wv.want.id)).toBe('wrong_volume');
    expect(await unparkForeignLanguageWant({ db: t.db, requestId: fl.want.id })).toBe(true);
    expect(await unparkForeignLanguageWant({ db: t.db, requestId: fl.want.id })).toBe(false); // already free
  });

  it("with LazyLibrarian's book in hand: an English anchor whose BookLang is still German stays parked; an English BookLang lifts", async () => {
    const german = await seedParked({ title: 'Anchor English Book German', language: 'English', llBookId: 'gb-de' });
    const english = await seedParked({ title: 'Anchor English Book English', language: 'en', llBookId: 'gb-en' });
    const ll = stubLlBooks({
      'gb-de': { title: 'Anchor English Book German', author: 'A Writer', ebookStatus: 'Open', audioStatus: 'Skipped', language: 'de' },
      'gb-en': { title: 'Anchor English Book English', author: 'A Writer', ebookStatus: 'Open', audioStatus: 'Skipped', language: 'en' },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run.unparked).toBe(1);
    expect(await reasonOf(german.want.id)).toBe('foreign_language'); // the push-time park (LL's own language) stands
    expect(await reasonOf(english.want.id)).toBeNull();
    // Nothing was queued or searched for the German book.
    expect(ll.calls.filter((c) => c.id === 'gb-de')).toHaveLength(0);
  });

  it('a degraded run (no LazyLibrarian language read) lifts nothing it cannot verify, but a want with no LL book still lifts', async () => {
    const withBook = await seedParked({ title: 'Has LL Book', language: 'en', llBookId: 'gb-has' });
    const without = await seedParked({ title: 'No LL Book Yet', language: 'en' });
    const run = await mintPairingWants({ db: t.db, gb: stubGb(() => null).gb, pacer: async () => {} });
    expect(run.unparked).toBe(1);
    expect(await reasonOf(withBook.want.id)).toBe('foreign_language');
    expect(await reasonOf(without.want.id)).toBeNull();
  });
});
