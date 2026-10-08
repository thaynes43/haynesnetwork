// Issue #825: PostgreSQL 16 and bounded offline LL stubs; run serial under nice -n 19.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookRequestEvents,
  bookRequests,
  booksFormatPairs,
  booksPairingReservations,
  booksItems,
} from '@hnet/db';
import {
  buildPairingHeldCoverage,
  buildPairingAcquisitionDeferrals,
  pairingAuthorsAgree,
  pairingIdentity,
  matchFormatPairs,
  readHeldBooks,
  runFormatPairing,
  syncFormatPairs,
  type HeldBook,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
  type PairableItem,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const NOW = new Date('2026-10-07T23:55:00Z');
const book = (title: string, authors: string[], isbn: string | null = null): HeldBook => ({
  title,
  author: authors[0] ?? null,
  authors,
  isbn,
});
const cases = [
  {
    title: 'The Confession - A Novel',
    author: 'John Grisham',
    held: [book('The Confession', ['John Grisham']), book('The Confession', ['R.L. Stine'])],
  },
  {
    title: 'Love in the Time of Cholera',
    author: 'Gabriel García Márquez',
    held: [book('Love in the Time of Cholera', ['Edith Grossman', 'Gabriel García Márquez'])],
  },
  {
    title: 'Redwall',
    author: 'Brian Jacques',
    held: [book('Redwall', ['Brian Jacques']), book('Loamhedge', ['Brian Jacques'])],
  },
  {
    title: 'Man of Two Worlds',
    author: 'Frank Herbert',
    held: [book('Man Of Two Worlds', ['Brian Herbert', 'Frank Herbert'])],
  },
  {
    title: 'How to Win Friends and Influence People in the Digital Age',
    author: 'Dale Carnegie',
    held: [
      book('How to Win Friends and Influence People in the Digital Age', [
        'Associates',
        'Dale Carnegie',
      ]),
    ],
    ambiguous: true,
  },
  {
    title: 'The Odyssey',
    author: 'Homer',
    held: [book('The Odyssey', ['Robert Fitzgerald'])],
    llHeld: true,
  },
  {
    title: 'A Memory of Light',
    author: 'Robert Jordan',
    held: [book('A Memory of Light', ['Brandon Sanderson', 'Robert Jordan'], '9780748117222')],
  },
];
const pairable = (c: (typeof cases)[number]): PairableItem => ({
  id: 'book',
  mediaKind: 'book',
  title: c.title,
  sortTitle: c.title,
  author: c.author,
  heldBooks: c.held,
});
const uncertainCredits = [
  {
    title: "Hunter's Run",
    writer: 'George R.R. Martin',
    audio: 'Geo. R.R. Martin, Gardner Duzois, Daniel Abraham',
  },
  { title: 'Fear', writer: 'Roald Dahl', audio: 'Roald Dahl - editor' },
  {
    title: 'Indigo',
    writer: 'Charlaine Harris',
    audio: 'Charlaine Harris/Christopher Golden/Jonathan Maberry',
  },
];
const uncertainTitles = [
  ['The Final Empire', 'Mistborn - The Final Empire', 'Brandon Sanderson'],
  ['Mitosis', 'Mitosis - A Reckoners Story', 'Brandon Sanderson'],
  ['Alcatraz versus the Knights of Crystallia', 'The Knights of Crystallia', 'Brandon Sanderson'],
  ['Ghosts of the Shadow Market Box Set', 'Ghosts of the Shadow Market', 'Cassandra Clare'],
  [
    'Lord John and the Brotherhood of the Blade - 02',
    'Lord John and the Brotherhood of the Blade',
    'Diana Gabaldon',
  ],
  ['The Reluctant Assassin', 'WARP Book 1 The Reluctant Assassin', 'Eoin Colfer'],
  ['A Time to Kill', 'A Time to Kill: Jack Brigance, Book 1', 'John Grisham'],
  ['The Abduction', 'Theodore Boone, The Abduction', 'John Grisham'],
  ['The Accused', 'Theodore Boone, The Accused', 'John Grisham'],
  ['The Activist', 'Theodore Boone, The Activist', 'John Grisham'],
  ['The Fugitive', 'Theodore Boone The Fugitive [Disc 1]', 'John Grisham'],
  ['The Scandal', 'Theodore Boone, The Scandal', 'John Grisham'],
  ['To the Blight: The Eye of the World', 'The Eye of the World', 'Robert Jordan'],
  ['Without Remorse', 'Without Remorse (Movie Tie-In)', 'Tom Clancy'],
];

describe('strong actual work coverage', () => {
  it.each(cases)('proves the held ebook for $title without claiming a multi-book pair', (c) => {
    const snapshot = c.llHeld
      ? new Map([
          [
            'different-edition',
            { title: c.title, author: c.author, language: 'en', ebookStatus: 'Open' },
          ],
        ])
      : null;
    expect(buildPairingHeldCoverage([pairable(c)], snapshot).holds(c, 'ebook')).toBe(!c.ambiguous);
  });
  it('complete-name proof refuses surname/given fragments but retains real initials, middle names and mononyms', () => {
    for (const [left, right] of [
      ['Grisham', 'John Grisham'],
      ['Orson Scott', 'Orson Scott Card'],
      ['Frank Herbert', 'Brian Herbert'],
      ['Dean Ray Koontz', 'Dean Richard Koontz'],
      ['TOM CLANCY', 'Tim Clancy'],
      ['JIM AUTHOR', 'James Author'],
    ])
      expect(pairingAuthorsAgree(left!, right!)).toBe(false);
    for (const [left, right] of [
      ['Homer', 'Homer'],
      ['J.R.R. Tolkien', 'JRR Tolkien'],
      ['G.R.R. Martin', 'GRR Martin'],
      ['R.L. Stine', 'RL Stine'],
      ['L.M. Montgomery', 'Lucy Maud Montgomery'],
      ['Dean Koontz', 'Dean Ray Koontz'],
      ['Gabriel García Márquez', 'Gabriel Garcia Marquez'],
    ])
      expect(pairingAuthorsAgree(left!, right!)).toBe(true);
  });
  it('fragmented multiple Writers prove neither a pair nor held ebook even when the audio repeats the fragment', () => {
    const item: PairableItem = {
      id: 'book',
      mediaKind: 'book',
      title: 'The Client',
      sortTitle: 'The Client',
      author: 'Grisham',
      heldBooks: [book('The Client', ['Grisham', 'John'])],
    };
    for (const author of ['John Grisham', 'Grisham']) {
      const audio: PairableItem = {
        id: 'audio',
        mediaKind: 'audiobook',
        title: 'The Client',
        sortTitle: 'The Client',
        author,
      };
      expect(matchFormatPairs([item, audio])).toEqual([]);
      expect(buildPairingHeldCoverage([item]).holds(audio, 'ebook')).toBe(false);
      expect(buildPairingAcquisitionDeferrals([item, audio]).blocks(audio.id, audio, 'ebook')).toBe(
        true,
      );
    }
    const mononym = { ...item, author: 'Homer', heldBooks: [book('The Client', ['Homer'])] };
    expect(
      matchFormatPairs([
        mononym,
        {
          id: 'audio',
          mediaKind: 'audiobook',
          title: 'The Client',
          sortTitle: 'The Client',
          author: 'Homer',
        },
      ]),
    ).toHaveLength(1);
  });
  it('prefers a folder author only when an actual Writer proves that credit, and never collapses distinct authors', () => {
    expect(pairingIdentity(pairable(cases[3]!))).toMatchObject({
      kind: 'one',
      author: 'Frank Herbert',
    });
    expect(pairingIdentity(pairable(cases[5]!))).toMatchObject({
      kind: 'one',
      author: 'Robert Fitzgerald',
    });
    expect(
      pairingIdentity({
        ...pairable(cases[3]!),
        heldBooks: [book('Man Of Two Worlds', ['Brian Herbert'])],
      }),
    ).toMatchObject({ kind: 'one', author: 'Brian Herbert' });
    expect(
      pairingIdentity({
        ...pairable(cases[0]!),
        title: 'City of Bones',
        author: 'Cassandra Clare',
        heldBooks: [
          book('City of Bones', ['Cassandra Clare'], 'same-isbn'),
          book('City of Bones', ['Martha Wells'], 'same-isbn'),
        ],
      }),
    ).toMatchObject({ kind: 'multi_book', books: 2 });
    expect(
      pairingIdentity({ ...pairable(cases[0]!), heldBooks: [book('The Confession', [])] }),
    ).toMatchObject({ kind: 'one', author: null });
  });
  it('preserves all actual Writers while reading old first-writer-only snapshots', () => {
    expect(
      readHeldBooks({
        heldBooks: [cases[3]!.held[0], { title: 'Older', author: 'Old Writer', isbn: null }],
      }),
    ).toEqual([cases[3]!.held[0], { title: 'Older', author: 'Old Writer', isbn: null }]);
  });
  it('refuses wrong/unknown writers, unrelated subtitles, foreign copies and unread chapters', () => {
    const identity = { title: 'Dune', author: 'Frank Herbert' };
    const item: PairableItem = {
      id: 'book',
      mediaKind: 'book',
      title: 'Dune',
      sortTitle: 'Dune',
      author: 'Frank Herbert',
    };
    for (const candidate of [
      item,
      { ...item, heldBooks: [book('Dune', [])] },
      { ...item, heldBooks: [book('Dune', ['Brian Herbert'])] },
      { ...item, language: 'de', heldBooks: [book('Dune', ['Frank Herbert'])] },
    ]) {
      expect(buildPairingHeldCoverage([candidate]).holds(identity, 'ebook')).toBe(false);
    }
    for (const row of [
      { title: 'Dune', author: 'Brian Herbert', ebookStatus: 'Open' },
      { title: 'Dune', author: null, ebookStatus: 'Open' },
      { title: 'Dune', author: 'Frank Herbert', language: 'de', ebookStatus: 'Open' },
      { title: 'Dune', author: 'Frank Herbert', ebookStatus: 'Wanted' },
    ])
      expect(buildPairingHeldCoverage([], new Map([['row', row]])).holds(identity, 'ebook')).toBe(
        false,
      );
    expect(buildPairingHeldCoverage([], new Map()).holds(identity, 'ebook')).toBe(false);
    expect(
      buildPairingHeldCoverage(
        [],
        new Map([
          [
            'row',
            { title: 'Dune', subtitle: 'Book One', author: 'Frank Herbert', ebookStatus: 'Open' },
          ],
        ]),
      ).holds({ title: 'Dune: A Different Work', author: 'Frank Herbert' }, 'ebook'),
    ).toBe(false);
  });
  it('a same-author novella subtitle cannot cover the main title or erase a requested subtitle', () => {
    const held = new Map([
      [
        'novella',
        {
          title: 'Outlander',
          subtitle: 'A Plague of Zombies',
          author: 'Diana Gabaldon',
          ebookStatus: 'Open',
        },
      ],
    ]);
    const coverage = buildPairingHeldCoverage([], held);
    expect(coverage.holds({ title: 'Outlander', author: 'Diana Gabaldon' }, 'ebook')).toBe(false);
    expect(
      coverage.holds(
        { title: 'Outlander: A Plague of Zombies', author: 'Diana Gabaldon' },
        'ebook',
      ),
    ).toBe(true);
    expect(
      coverage.holds(
        { title: 'Outlander: The Scottish Prisoner', author: 'Diana Gabaldon' },
        'ebook',
      ),
    ).toBe(false);
  });
  it('legacy credit uncertainty does not defer different authors or interior-only title resemblance', () => {
    const item: PairableItem = {
      id: 'book',
      title: 'City of Bones',
      sortTitle: 'City of Bones',
      author: 'Cassandra Clare',
      mediaKind: 'book',
      heldBooks: [book('City of Bones', ['Cassandra Clare'])],
    };
    for (const audio of [
      { ...item, id: 'audio', mediaKind: 'audiobook' as const, author: 'Martha Wells' },
      {
        ...item,
        id: 'audio',
        mediaKind: 'audiobook' as const,
        title: 'Another City of Bones Elsewhere',
        author: 'Cassandra Clare - editor',
      },
      {
        ...item,
        id: 'audio',
        mediaKind: 'audiobook' as const,
        language: 'de',
        author: 'Cassandra Clare - editor',
      },
    ]) {
      const deferred = buildPairingAcquisitionDeferrals([item, audio]);
      expect(deferred.uncertainCreditItemIds.size).toBe(0);
      expect(deferred.blocks(item.id, item, 'audiobook')).toBe(false);
      expect(deferred.blocks(audio.id, audio, 'ebook')).toBe(false);
    }
  });
  it('title uncertainty requires a complete whole-word boundary and refuses known numbered/Roman sequel conflicts', () => {
    for (const [left, right] of [
      ['The Science of Discworld III: Darwin’s Watch', 'The Science of Discworld'],
      ['The Science of Discworld III: Darwin’s Watch', 'The Science of Discworld I'],
      ['The Science of Discworld III: Darwin’s Watch', 'The Science of Discworld II'],
      ['The Work: Part 2', 'The Work: Part 3'],
      ['Cat', 'Catwings'],
      ['The Journey', 'A Different Journey Elsewhere'],
    ]) {
      const b: PairableItem = {
        id: 'book',
        title: left!,
        sortTitle: left!,
        mediaKind: 'book',
        author: 'Complete Writer',
        heldBooks: [book(left!, ['Complete Writer'])],
      };
      const a: PairableItem = {
        id: 'audio',
        title: right!,
        sortTitle: right!,
        mediaKind: 'audiobook',
        author: 'Complete Writer',
      };
      const deferred = buildPairingAcquisitionDeferrals([b, a]);
      expect(deferred.uncertainTitleItemIds.size).toBe(0);
      expect(deferred.blocks(b.id, { title: left!, author: 'Complete Writer' }, 'audiobook')).toBe(
        false,
      );
      expect(deferred.blocks(a.id, a, 'ebook')).toBe(false);
    }
  });
  it('a bracketed partial-disc title defers acquisition without becoming a pair or complete-work coverage', () => {
    const b: PairableItem = {
      id: 'book',
      title: 'The Fugitive',
      sortTitle: 'The Fugitive',
      mediaKind: 'book',
      author: 'John Grisham',
      heldBooks: [book('The Fugitive', ['John Grisham'])],
    };
    for (const marker of ['[Disc 1]', '(CD 1 of 4)', '[Track 2]']) {
      const a: PairableItem = {
        id: 'audio',
        title: `Theodore Boone The Fugitive ${marker}`,
        sortTitle: 'The Fugitive',
        mediaKind: 'audiobook',
        author: 'John Grisham',
      };
      const original = a.title;
      const deferred = buildPairingAcquisitionDeferrals([b, a]);
      expect(deferred.blocks(b.id, b, 'audiobook')).toBe(true);
      expect(deferred.blocks(a.id, a, 'ebook')).toBe(true);
      expect(matchFormatPairs([b, a])).toEqual([]);
      expect(buildPairingHeldCoverage([b, a]).holds(b, 'audiobook')).toBe(false);
      expect(pairingIdentity(a)).toMatchObject({ kind: 'one', title: original });
      expect(a.title).toBe(original);
    }
  });
});

let t: TestDb;
let seq = 0;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(bookRequestEvents);
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(booksItems);
});
async function seed(
  title: string,
  author: string,
  kind: 'book' | 'audiobook',
  attrs: Record<string, unknown> = {},
) {
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source: kind === 'book' ? 'kavita' : 'audiobookshelf',
      mediaKind: kind,
      externalId: `coverage-${++seq}`,
      libraryId: '1',
      libraryName: 'Books',
      title,
      sortTitle: title,
      author,
      attrs,
      deepLinkUrl: 'https://books.example',
    })
    .returning();
  return row!;
}
function clients(snapshot: Map<string, LlSnapshotRow>) {
  const calls: string[] = [];
  const ll = {
    read: { getAllBookStatuses: async () => snapshot },
    write: Object.fromEntries(
      ['addBook', 'queueBook', 'searchBook', 'unqueueBook'].map((cmd) => [
        cmd,
        async () => {
          calls.push(cmd);
          return 'OK';
        },
      ]),
    ),
  } as unknown as LazyLibrarianClientBundle;
  const gb = {
    resolveVolume: async () => {
      calls.push('GB.resolveVolume');
      return { volumeId: 'new-edition' };
    },
  };
  return { calls, ll, gb };
}

describe('every automatic pairing boundary honors held work coverage', () => {
  it('a covered open want lands both proven formats once and counts only real transitions', async () => {
    const row = await seed('Complete Work', 'Complete Writer', 'book', {
      heldBooks: [book('Complete Work', ['Complete Writer'])],
    });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: row.id,
        title: 'Complete Work',
        author: 'Complete Writer',
        ebookStatus: 'wanted',
        audioStatus: 'wanted',
        llBookId: 'selected',
      })
      .returning();
    const stub = clients(
      new Map([
        [
          'selected',
          {
            title: 'Complete Work',
            author: 'Complete Writer',
            ebookStatus: 'Wanted',
            audioStatus: 'Wanted',
          },
        ],
        [
          'held-other-edition',
          {
            title: 'Complete Work',
            author: 'Complete Writer',
            audioStatus: 'Open',
            language: 'en',
          },
        ],
      ]),
    );
    const first = await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 0,
      now: NOW,
      pacer: async () => {},
    });
    expect(first.heldLanded).toBe(1);
    expect(first.skippedHeld).toBe(1); // one coverage skip; the sweep must not count an unchanged missing format again
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(2);
    const second = await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 0,
      now: new Date(NOW.getTime() + 86_400_000),
      pacer: async () => {},
    });
    expect(second).toMatchObject({ heldLanded: 0, skippedHeld: 1 });
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(2);
    expect(stub.calls).toEqual([]);
  });
  it.each(['old-work', 'gone-old-work'])(
    'covered preserved audio cannot falsely land the old request ebook from a conflicting current Book (%s)',
    async (oldLlBookId) => {
      const row = await seed('Old Canonical Work', 'Canonical Writer', 'book', {
        heldBooks: [book('New Derived Work', ['Different Writer'])],
      });
      const [want] = await t.db
        .insert(bookRequests)
        .values({
          origin: 'pairing',
          pairingBooksItemId: row.id,
          title: 'Old Canonical Work',
          author: 'Canonical Writer',
          ebookStatus: 'wanted',
          audioStatus: 'wanted',
          llBookId: oldLlBookId,
        })
        .returning();
      const stub = clients(
        new Map([
          [
            'old-work',
            { title: 'Old Canonical Work', author: 'Canonical Writer', audioStatus: 'Open' },
          ],
        ]),
      );
      const result = await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 0,
        now: NOW,
        pacer: async () => {},
      });
      expect(result).toMatchObject({ heldLanded: 0, skippedHeld: 1 });
      expect(
        (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
      ).toMatchObject({
        title: 'Old Canonical Work',
        author: 'Canonical Writer',
        llBookId: 'old-work',
        ebookStatus: 'wanted',
        audioStatus: 'landed',
      });
      expect(await t.db.select().from(bookRequestEvents)).toHaveLength(
        oldLlBookId === 'old-work' ? 1 : 2,
      );
      expect(stub.calls).toEqual([]);
    },
  );
  it('the current Outlander identity rejects an old null-author request pointing at Drums of Autumn/Outlander 4', async () => {
    const row = await seed('Outlander', 'Diana Gabaldon', 'book', {
      heldBooks: [book('Outlander', ['Diana Gabaldon'])],
    });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: row.id,
        title: 'Outlander',
        author: null,
        ebookStatus: 'landed',
        audioStatus: 'landed',
        llBookId: '3nyUar3bx0QC',
      })
      .returning();
    const stub = clients(
      new Map([
        [
          '3nyUar3bx0QC',
          {
            title: 'Drums Of Autumn',
            subtitle:
              'The spellbinding Scottish historical romance from the epic, bestselling series (Outlander 4)',
            author: 'Diana Gabaldon',
            audioStatus: 'Open',
            ebookStatus: 'Skipped',
            language: 'en',
          },
        ],
      ]),
    );
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 0,
      now: NOW,
      pacer: async () => {},
    });
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({
      title: 'Outlander',
      author: 'Diana Gabaldon',
      llBookId: null,
      ebookStatus: 'landed',
      audioStatus: 'requested',
    });
    expect(
      (await t.db.select().from(bookRequestEvents)).some(
        (e) => e.reason === 'pairing_want_reidentified',
      ),
    ).toBe(true);
    expect(stub.calls).toEqual([]);
  });
  it.each(uncertainTitles)(
    'defers both sides of plausible decorated titles %s and %s without asserting ownership across repeated runs',
    async (title, audioTitle, author) => {
      await seed(title!, author!, 'book', { heldBooks: [book(title!, [author!])] });
      await seed(audioTitle!, author!, 'audiobook');
      const stub = clients(
        new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
      );
      for (const now of [NOW, new Date(NOW.getTime() + 86_400_000)])
        await runFormatPairing({
          db: t.db,
          ll: stub.ll,
          gb: stub.gb,
          cap: 25,
          now,
          pacer: async () => {},
        });
      expect(stub.calls).toEqual([]);
      expect(await t.db.select().from(bookRequests)).toEqual([]);
      expect(await t.db.select().from(booksFormatPairs)).toEqual([]);
    },
  );
  it.each(['book', 'audiobook'] as const)(
    'a complete held LL title/subtitle can defer the %s anchor without making its title an ownership alias',
    async (kind) => {
      await seed(
        'The Final Empire',
        'Brandon Sanderson',
        kind,
        kind === 'book'
          ? {
              heldBooks: [book('The Final Empire', ['Brandon Sanderson'])],
            }
          : {},
      );
      const snapshot = new Map([
        [
          'held',
          {
            title: 'Mistborn',
            subtitle: 'The Final Empire',
            author: 'Brandon Sanderson',
            language: 'en',
            ebookStatus: 'Open',
            audioStatus: 'Open',
          },
        ],
      ]);
      const stub = clients(snapshot);
      for (const now of [NOW, new Date(NOW.getTime() + 86_400_000)])
        await runFormatPairing({
          db: t.db,
          ll: stub.ll,
          gb: stub.gb,
          cap: 25,
          now,
          pacer: async () => {},
        });
      expect(stub.calls).toEqual([]);
      expect(await t.db.select().from(bookRequests)).toEqual([]);
      expect(await t.db.select().from(booksFormatPairs)).toEqual([]);
      expect(
        buildPairingHeldCoverage([], snapshot).holds(
          { title: 'The Final Empire', author: 'Brandon Sanderson' },
          kind === 'book' ? 'audiobook' : 'ebook',
        ),
      ).toBe(false);
    },
  );
  it('held LL uncertainty ignores a foreign or wrong-author edition and failed or empty snapshots', () => {
    const item: PairableItem = {
      id: 'audio',
      title: 'The Final Empire',
      sortTitle: 'The Final Empire',
      mediaKind: 'audiobook',
      author: 'Brandon Sanderson',
    };
    for (const snapshot of [
      null,
      new Map(),
      new Map([
        [
          'foreign',
          {
            title: 'Mistborn',
            subtitle: 'The Final Empire',
            author: 'Brandon Sanderson',
            language: 'de',
            ebookStatus: 'Open',
          },
        ],
      ]),
      new Map([
        [
          'different',
          {
            title: 'Mistborn',
            subtitle: 'The Final Empire',
            author: 'Another Writer',
            ebookStatus: 'Open',
          },
        ],
      ]),
      new Map([
        [
          'unheld',
          {
            title: 'Mistborn',
            subtitle: 'The Final Empire',
            author: 'Brandon Sanderson',
            ebookStatus: 'Skipped',
          },
        ],
      ]),
    ]) {
      const deferred = buildPairingAcquisitionDeferrals([item], new Set(), snapshot);
      expect(deferred.blocks(item.id, item, 'ebook')).toBe(false);
    }
  });
  it('positive complete-work LL coverage can land the preserved request through credit uncertainty', async () => {
    const b = await seed('Fear', 'Roald Dahl', 'book', {
      heldBooks: [book('Fear', ['Roald Dahl'])],
    });
    const a = await seed('Fear', 'Roald Dahl - editor', 'audiobook');
    await t.db.insert(bookRequests).values([
      {
        origin: 'pairing',
        pairingBooksItemId: b.id,
        title: 'Fear',
        author: 'Roald Dahl',
        ebookStatus: 'landed',
        audioStatus: 'missing',
        llBookId: 'gone-book-id',
      },
      {
        origin: 'pairing',
        pairingBooksItemId: a.id,
        title: 'Fear',
        author: 'Roald Dahl',
        ebookStatus: 'missing',
        audioStatus: 'landed',
        llBookId: 'gone-audio-id',
      },
    ]);
    const stub = clients(
      new Map([
        [
          'held',
          {
            title: 'Fear',
            author: 'Roald Dahl',
            language: 'en',
            ebookStatus: 'Open',
            audioStatus: 'Open',
          },
        ],
      ]),
    );
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 25,
      now: NOW,
      pacer: async () => {},
    });
    expect(stub.calls).toEqual([]);
    const wants = await t.db.select().from(bookRequests);
    expect(
      wants.every(
        (w) =>
          w.title === 'Fear' &&
          w.author === 'Roald Dahl' &&
          w.ebookStatus === 'landed' &&
          w.audioStatus === 'landed',
      ),
    ).toBe(true);
    expect(new Set(wants.map((w) => w.llBookId))).toEqual(new Set(['held']));
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(4);
    expect(await t.db.select().from(booksFormatPairs)).toEqual([]);
  });
  it.each(uncertainCredits)(
    'defers both missing formats of $title across repeated runs without minting or claiming a pair',
    async (c) => {
      await seed(c.title, c.writer, 'book', { heldBooks: [book(c.title, [c.writer])] });
      await seed(c.title, c.audio, 'audiobook');
      const stub = clients(
        new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
      );
      for (const now of [NOW, new Date(NOW.getTime() + 86_400_000)])
        await runFormatPairing({
          db: t.db,
          ll: stub.ll,
          gb: stub.gb,
          cap: 25,
          now,
          pacer: async () => {},
        });
      expect(stub.calls).toEqual([]);
      expect(await t.db.select().from(bookRequests)).toEqual([]);
      expect(await t.db.select().from(booksFormatPairs)).toEqual([]);
    },
  );
  it.each(uncertainCredits)(
    'preserves existing identities, ids and states for both $title wants while their credits remain uncertain',
    async (c) => {
      const b = await seed(c.title, c.writer, 'book', { heldBooks: [book(c.title, [c.writer])] });
      const a = await seed(c.title, c.audio, 'audiobook');
      const wants = await t.db
        .insert(bookRequests)
        .values([
          {
            origin: 'pairing' as const,
            pairingBooksItemId: b.id,
            title: c.title,
            author: c.writer,
            ebookStatus: 'landed' as const,
            audioStatus: 'missing' as const,
            llBookId: 'gone-book-id',
          },
          {
            origin: 'pairing' as const,
            pairingBooksItemId: a.id,
            title: c.title,
            author: c.writer,
            ebookStatus: 'landed' as const,
            audioStatus: 'landed' as const,
            llBookId: 'gone-audio-id',
          },
        ])
        .returning();
      const stub = clients(
        new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
      );
      for (const now of [NOW, new Date(NOW.getTime() + 86_400_000)])
        await runFormatPairing({
          db: t.db,
          ll: stub.ll,
          gb: stub.gb,
          cap: 25,
          now,
          pacer: async () => {},
        });
      expect(stub.calls).toEqual([]);
      expect(await t.db.select().from(bookRequests)).toEqual(wants);
      expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
    },
  );
  it.each([
    ['Stormlight Archive [02] Words of Radiance', 'Words of Radiance', 'Brandon Sanderson'],
    [
      'Aurora Teagarden #03 - Three Bedrooms, One Corpse',
      'Three Bedrooms, One Corpse',
      'Charlaine Harris',
    ],
    [
      "Outlander [08] Written in My Own Heart's Blood",
      "Written in My Own Heart's Blood",
      'Diana Gabaldon',
    ],
    ['Jack Ryan [07] - Debt of Honor', 'Debt of Honor', 'Tom Clancy'],
    [
      'Hainish Cycle - 07 - Four Ways to Forgiveness',
      'Four Ways to Forgiveness',
      'Ursula K. Le Guin',
    ],
    ['Dollenganger 01 Flowers In the Attic', 'Flowers In the Attic', 'V.C. Andrews'],
    ['Dollenganger 03 If There Be a Thorns', 'If There Be a Thorns', 'V.C. Andrews'],
  ])(
    'defers both sides of lost grouping context in %s without stripping an alias or pushing a duplicate',
    async (raw, suffix, author) => {
      await seed(raw!, author!, 'book', { heldBooks: [book(raw!, [author!])] });
      await seed(suffix!, author!, 'audiobook');
      const stub = clients(
        new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
      );
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 25,
        now: NOW,
        pacer: async () => {},
      });
      expect(stub.calls).toEqual([]);
      expect(await t.db.select().from(bookRequests)).toEqual([]);
      expect(await t.db.select().from(booksFormatPairs)).toEqual([]);
    },
  );
  it('does not strip a meaningful numbered subtitle while complete current work coverage still lands it', () => {
    const anchor: PairableItem = {
      id: 'book',
      mediaKind: 'book',
      title: 'Area 51: The Truth',
      sortTitle: 'Area 51: The Truth',
      author: 'Bob Mayer',
      heldBooks: [book('Area 51: The Truth', ['Bob Mayer'])],
    };
    expect(pairingIdentity(anchor)).toMatchObject({ title: 'Area 51: The Truth' });
    expect(
      buildPairingHeldCoverage([
        {
          id: 'audio',
          mediaKind: 'audiobook',
          title: 'Area 51: The Truth',
          sortTitle: 'Area 51: The Truth',
          author: 'Bob Mayer',
        },
      ]).holds({ title: 'Area 51: The Truth', author: 'Bob Mayer' }, 'audiobook'),
    ).toBe(true);
  });
  it('composed numbered-prefix and CSV-Writer ambiguity defers the suffix audio across repeated runs', async () => {
    const raw = 'Stormlight Archive [2] Words of Radiance';
    await seed(raw, 'Brandon Sanderson', 'book', {
      heldBooks: [book(raw, ['Sanderson', 'Brandon'])],
    });
    const audio = await seed('Words of Radiance', 'Brandon Sanderson', 'audiobook');
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: audio.id,
        title: 'Words of Radiance',
        author: 'Brandon Sanderson',
        ebookStatus: 'missing',
        audioStatus: 'landed',
        llBookId: 'gone-edition',
        createdAt: new Date('2026-07-01'),
      })
      .returning();
    const stub = clients(
      new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
    );
    for (const now of [NOW, new Date(NOW.getTime() + 86_400_000)])
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 25,
        now,
        pacer: async () => {},
      });
    expect(stub.calls).toEqual([]);
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({
      title: 'Words of Radiance',
      ebookStatus: 'missing',
      llBookId: 'gone-edition',
    });
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
  });
  it.each(cases)('does not mint a duplicate ebook for $title', async (c) => {
    // Odyssey's ebook coverage comes solely from another verified LL edition, independent of its translator metadata.
    if (!c.llHeld) await seed(c.title, c.author, 'book', { heldBooks: c.held });
    await seed(c.title, c.author, 'audiobook');
    const snapshot = c.llHeld
      ? new Map([
          [
            'different-edition',
            { title: c.title, author: c.author, ebookStatus: 'Open', language: 'en' },
          ],
        ])
      : new Map([['unrelated', { title: 'Unrelated', author: 'Other', ebookStatus: 'Skipped' }]]);
    const stub = clients(snapshot);
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 1,
      now: NOW,
      pacer: async () => {},
    });
    expect(stub.calls).toEqual([]);
    expect(await t.db.select().from(bookRequests)).toHaveLength(0);
  });
  it.each(['landed', 'missing', 'requested', 'grabbed'] as const)(
    'retains or lands a %s old-id want without gone retry or Skipped writes',
    async (status) => {
      const audio = await seed('Redwall', 'Brian Jacques', 'audiobook');
      const bookRow = await seed('Redwall', 'Brian Jacques', 'book', { heldBooks: cases[2]!.held });
      await t.db.insert(booksFormatPairs).values({
        bookItemId: bookRow.id,
        audioItemId: audio.id,
        matchedVia: 'title_author',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      });
      const [want] = await t.db
        .insert(bookRequests)
        .values({
          origin: 'pairing',
          pairingBooksItemId: audio.id,
          title: 'Redwall',
          author: 'Brian Jacques',
          ebookStatus: status,
          audioStatus: 'landed',
          llBookId: 'old-edition',
          createdAt: new Date('2026-07-01'),
        })
        .returning();
      const stub = clients(
        new Map([
          [
            'old-edition',
            {
              title: 'Redwall',
              author: 'Brian Jacques',
              ebookStatus: 'Skipped',
              audioStatus: 'Open',
            },
          ],
        ]),
      );
      const report = await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 1,
        now: NOW,
        pacer: async () => {},
      });
      expect(report).toMatchObject({
        dropped: 1,
        revived: 0,
        requestsLandedReverted: 0,
        llRerequested: 0,
        requeued: 0,
      });
      expect(stub.calls).toEqual([]);
      expect(
        (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
      ).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed', llBookId: 'old-edition' });
      if (status !== 'landed') expect(await t.db.select().from(bookRequestEvents)).toHaveLength(1);
    },
  );
  it('lands an absent-id want from another English held LL edition without add, queue, search or resolver', async () => {
    const audio = await seed('The Odyssey', 'Homer', 'audiobook');
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: audio.id,
        title: 'The Odyssey',
        author: 'Homer',
        ebookStatus: 'missing',
        audioStatus: 'landed',
        llBookId: 'gone-edition',
        createdAt: new Date('2026-07-01'),
      })
      .returning();
    const stub = clients(
      new Map([
        [
          'different-edition',
          {
            title: 'The Odyssey',
            author: 'Homer',
            ebookStatus: 'Skipped',
            ebookFile: '/owned/odyssey.epub',
            language: 'en',
          },
        ],
      ]),
    );
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 1,
      now: NOW,
      pacer: async () => {},
    });
    expect(stub.calls).toEqual([]);
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'landed',
      llBookId: 'different-edition',
    });
    const events = await t.db.select().from(bookRequestEvents);
    expect(
      events.some(
        (e) => e.writer === 'repointRequestLlBook' && e.reason === 'll_book_gone_repointed',
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.writer === 'landPairingHeldFormat' && e.reason === 'pairing_held_format_landed',
      ),
    ).toBe(true);
  });
  it('an unread pair reserves its audio across two failed reads and a successfully read but untitled chapter', async () => {
    const bookRow = await seed('Murtagh', 'Christopher Paolini', 'book', {
      heldBooks: [book('Murtagh', ['Christopher Paolini'])],
    });
    const audio = await seed('Murtagh', 'Christopher Paolini', 'audiobook');
    await syncFormatPairs({ db: t.db, now: NOW });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: audio.id,
        title: 'Murtagh',
        author: 'Christopher Paolini',
        ebookStatus: 'landed',
        audioStatus: 'landed',
        llBookId: 'old-id',
        createdAt: new Date('2026-07-01'),
      })
      .returning();
    const stub = clients(
      new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
    );
    await t.db.update(booksItems).set({ attrs: {} }).where(eq(booksItems.id, bookRow.id));
    const warnings: Record<string, unknown>[] = [];
    const run = (now: Date) =>
      runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 1,
        now,
        pacer: async () => {},
        logger: {
          warn: (_message, data) => {
            warnings.push(data!);
          },
        },
      });
    expect(await run(NOW)).toMatchObject({
      dropped: 1,
      revived: 0,
      requestsLandedReverted: 0,
      pushed: 0,
    });
    const [edge] = await t.db.select().from(booksPairingReservations);
    expect(edge).toMatchObject({ bookItemId: bookRow.id, audioItemId: audio.id, openedAt: NOW });
    expect(await run(new Date(NOW.getTime() + 60 * 60_000))).toMatchObject({
      dropped: 0,
      revived: 0,
      requestsLandedReverted: 0,
      pushed: 0,
    });
    expect(await t.db.select().from(booksPairingReservations)).toEqual([edge]);
    await t.db
      .update(booksItems)
      .set({ attrs: { heldBooks: [{ title: null, author: null, authors: [], isbn: null }] } })
      .where(eq(booksItems.id, bookRow.id));
    expect(await run(new Date(NOW.getTime() + 2 * 60 * 60_000))).toMatchObject({
      requestsLandedReverted: 0,
      pushed: 0,
    });
    expect(warnings.at(-1)).toMatchObject({
      unreadBookItemCount: 0,
      reservedAudioItemCount: 1,
      reservedAudioItemIds: [audio.id],
      deferredRequestIds: [want!.id],
    });
    expect(stub.calls).toEqual([]);
    expect((await t.db.select().from(bookRequests))[0]).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'landed',
      llBookId: 'old-id',
    });
    await t.db
      .update(booksItems)
      .set({ attrs: { heldBooks: [book('Murtagh', ['Christopher Paolini'])] } })
      .where(eq(booksItems.id, bookRow.id));
    expect(await run(new Date(NOW.getTime() + 3 * 60 * 60_000))).toMatchObject({ paired: 1 });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(0);
  });
  it('clears a prior reservation only after a known original identity or positive held work coverage', async () => {
    const bookRow = await seed('Dune', 'Frank Herbert', 'book', {});
    const audio = await seed('Dune', 'Frank Herbert', 'audiobook');
    await t.db.insert(booksFormatPairs).values({
      bookItemId: bookRow.id,
      audioItemId: audio.id,
      matchedVia: 'title_author',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
    await seed('Other', 'Other Writer', 'book', {
      heldBooks: [book('Dune', ['Frank Herbert']), book('Another Book', ['Other Writer'])],
    });
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(0);
    // A separate old edge can clear when a successful fresh read proves the original now holds another work.
    await t.db
      .insert(booksPairingReservations)
      .values({ bookItemId: bookRow.id, audioItemId: audio.id });
    await t.db
      .update(booksItems)
      .set({ attrs: { heldBooks: [book('Heretics of Dune', ['Frank Herbert'])] } })
      .where(eq(booksItems.id, bookRow.id));
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(0);
  });
  it('a tombstoned original reservation waits for unread inventory, then clears when the mirror is fully known', async () => {
    const bookRow = await seed('Dune', 'Frank Herbert', 'book', {});
    const audio = await seed('Dune', 'Frank Herbert', 'audiobook');
    await t.db
      .insert(booksPairingReservations)
      .values({ bookItemId: bookRow.id, audioItemId: audio.id });
    await t.db.update(booksItems).set({ deletedAt: NOW }).where(eq(booksItems.id, bookRow.id));
    const unknown = await seed('Unread', 'Other', 'book', {});
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
    await t.db
      .update(booksItems)
      .set({ attrs: { heldBooks: [{ title: null, author: null, authors: [], isbn: null }] } })
      .where(eq(booksItems.id, unknown.id));
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
    await t.db
      .update(booksItems)
      .set({ attrs: { heldBooks: [] } })
      .where(eq(booksItems.id, unknown.id));
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(0);
  });
  it.each(['live_partial', 'already_tombstoned'] as const)(
    'archives a previous %s pair before deleting it and protects the audio after an untitled replacement read',
    async (state) => {
      const original = await seed('Murtagh', 'Christopher Paolini', 'book', {
        heldBooks: [book('Murtagh', ['Christopher Paolini'])],
      });
      const audio = await seed('Murtagh', 'Christopher Paolini', 'audiobook');
      await syncFormatPairs({ db: t.db, now: NOW });
      const [want] = await t.db
        .insert(bookRequests)
        .values({
          origin: 'pairing',
          pairingBooksItemId: audio.id,
          title: 'Murtagh',
          author: 'Christopher Paolini',
          ebookStatus: 'landed',
          audioStatus: 'landed',
          llBookId: 'old-id',
          createdAt: new Date('2026-07-01'),
        })
        .returning();
      let replacement = original;
      if (state === 'already_tombstoned') {
        await t.db.update(booksItems).set({ deletedAt: NOW }).where(eq(booksItems.id, original.id));
        replacement = await seed('Unread replacement', 'Christopher Paolini', 'book', {});
      } else {
        await t.db
          .update(booksItems)
          .set({
            attrs: {
              heldBooks: [
                book('Other Work', ['Other Writer']),
                { title: null, author: null, authors: [], isbn: null },
              ],
            },
          })
          .where(eq(booksItems.id, original.id));
      }
      const stub = clients(
        new Map([['unrelated', { title: 'Other', author: 'Other', ebookStatus: 'Skipped' }]]),
      );
      const run = () =>
        runFormatPairing({
          db: t.db,
          ll: stub.ll,
          gb: stub.gb,
          cap: 1,
          now: NOW,
          pacer: async () => {},
        });
      expect(await run()).toMatchObject({
        dropped: 1,
        revived: 0,
        requestsLandedReverted: 0,
        llRerequested: 0,
      });
      expect(await t.db.select().from(booksPairingReservations)).toMatchObject([
        { bookItemId: original.id, audioItemId: audio.id },
      ]);
      await t.db
        .update(booksItems)
        .set({ attrs: { heldBooks: [{ title: null, author: null, authors: [], isbn: null }] } })
        .where(eq(booksItems.id, replacement.id));
      expect(await run()).toMatchObject({
        dropped: 0,
        revived: 0,
        requestsLandedReverted: 0,
        llRerequested: 0,
      });
      expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
      expect(stub.calls).toEqual([]);
      expect(
        (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
      ).toMatchObject({ ebookStatus: 'landed', llBookId: 'old-id' });
    },
  );
  it('unknown actual Writers and contrary folder/chapter credits defer both directions without false landing', async () => {
    const audio = await seed('The Odyssey', 'Homer', 'audiobook');
    await seed('The Odyssey', 'Homer', 'book', {
      heldBooks: [book('The Odyssey', ['Robert Fitzgerald'])],
    });
    const stub = clients(
      new Map([
        [
          'other-edition',
          { title: 'The Odyssey', author: 'Homer', ebookStatus: 'Open', language: 'en' },
        ],
      ]),
    );
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 5,
      now: NOW,
      pacer: async () => {},
    });
    expect(stub.calls).toEqual([]); // ABS text covered; Fitzgerald audio acquisition waits for the metadata conflict.
    expect(await t.db.select().from(bookRequests)).toHaveLength(0);
    await t.db.delete(booksItems).where(eq(booksItems.id, audio.id));
    const unknownWriter = await seed('Feeling Good', 'David D. Burns', 'book', {
      heldBooks: [book('Feeling Good - David D. Burns', [])],
    });
    const feeling = await seed('Feeling Good', 'David D. Burns', 'audiobook');
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: feeling.id,
        title: 'Feeling Good',
        author: 'David D. Burns',
        ebookStatus: 'missing',
        audioStatus: 'landed',
        llBookId: 'gone',
        createdAt: new Date('2026-07-01'),
      })
      .returning();
    expect(
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 5,
        now: NOW,
        pacer: async () => {},
      }),
    ).toMatchObject({ pushed: 0, llRerequested: 0 });
    expect(stub.calls).toEqual([]);
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({ ebookStatus: 'missing', audioStatus: 'landed', llBookId: 'gone' });
    const identity = pairingIdentity({
      ...unknownWriter,
      heldBooks: readHeldBooks(unknownWriter.attrs),
    });
    expect(identity).toMatchObject({ kind: 'one', author: null });
  });
  it('City of Bones wrong-author chapter causes deferral, never a pair or held assertion', async () => {
    await seed('City of Bones', 'Cassandra Clare', 'book', {
      heldBooks: [book('City of Bones', ['Martha Wells'])],
    });
    const audio = await seed('City of Bones', 'Cassandra Clare', 'audiobook');
    const stub = clients(
      new Map([['other', { title: 'Other', author: 'Other', ebookStatus: 'Open' }]]),
    );
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 5,
      now: NOW,
      pacer: async () => {},
    });
    expect(report).toMatchObject({ paired: 0, pushed: 0, skippedUncertainHeld: 2 });
    expect(stub.calls).toEqual([]);
    expect(await t.db.select().from(bookRequests)).toHaveLength(0);
    expect(
      buildPairingHeldCoverage([
        {
          id: 'book',
          mediaKind: 'book',
          title: 'City of Bones',
          sortTitle: '',
          author: 'Clare',
          heldBooks: [book('City of Bones', ['Martha Wells'])],
        },
      ]).holds(audio, 'ebook'),
    ).toBe(false);
  });
  it.each(['requested', 'wanted', 'landed'] as const)(
    'preserves the old canonical %s snapshot and LL id on contrary fresh Writer metadata',
    async (status) => {
      const row = await seed('The Odyssey', 'Homer', 'book', {
        heldBooks: [book('The Odyssey', ['Robert Fitzgerald'])],
      });
      const [want] = await t.db
        .insert(bookRequests)
        .values({
          origin: 'pairing',
          pairingBooksItemId: row.id,
          title: 'The Odyssey',
          author: 'Homer',
          ebookStatus: 'landed',
          audioStatus: status,
          llBookId: 'canonical-id',
          createdAt: new Date('2026-07-01'),
        })
        .returning();
      const stub = clients(
        new Map([
          [
            'canonical-id',
            {
              title: 'The Odyssey',
              author: 'Homer',
              ebookStatus: 'Open',
              audioStatus: 'Skipped',
              language: 'en',
            },
          ],
        ]),
      );
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 5,
        now: NOW,
        pacer: async () => {},
      });
      expect(stub.calls).toEqual([]);
      expect(
        (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
      ).toMatchObject({
        title: 'The Odyssey',
        author: 'Homer',
        llBookId: 'canonical-id',
        ebookStatus: 'landed',
        audioStatus: status,
      });
      expect(await t.db.select().from(bookRequestEvents)).toHaveLength(0);
      await seed('The Odyssey', 'Homer', 'audiobook');
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 5,
        now: NOW,
        pacer: async () => {},
      });
      expect(stub.calls).toEqual([]);
      expect(
        (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
      ).toMatchObject({
        title: 'The Odyssey',
        author: 'Homer',
        llBookId: 'canonical-id',
        ebookStatus: 'landed',
        audioStatus: 'landed',
      });
    },
  );
  it('new derived work coverage cannot land an unrelated preserved old request on a conflicting Book source', async () => {
    const row = await seed('Old Canonical Work', 'Canonical Writer', 'book', {
      heldBooks: [book('New Derived Work', ['Different Writer'])],
    });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: row.id,
        title: 'Old Canonical Work',
        author: 'Canonical Writer',
        ebookStatus: 'landed',
        audioStatus: 'missing',
        llBookId: 'gone-old-work',
        createdAt: new Date('2026-07-01'),
      })
      .returning();
    const stub = clients(
      new Map([
        [
          'new-derived-work',
          {
            title: 'New Derived Work',
            author: 'Different Writer',
            audioStatus: 'Open',
            language: 'en',
          },
        ],
      ]),
    );
    await runFormatPairing({
      db: t.db,
      ll: stub.ll,
      gb: stub.gb,
      cap: 5,
      now: NOW,
      pacer: async () => {},
    });
    expect(stub.calls).toEqual([]);
    expect(
      (await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id)))[0],
    ).toMatchObject({
      title: 'Old Canonical Work',
      author: 'Canonical Writer',
      ebookStatus: 'landed',
      audioStatus: 'missing',
      llBookId: 'gone-old-work',
    });
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(0);
  });
  it('known untitled White Sand does not globally block an unrelated valid audio acquisition', async () => {
    await seed('White Sand', 'Brandon Sanderson', 'book', {
      heldBooks: [{ title: null, author: null, authors: [], isbn: null }],
    });
    await seed('Actually Missing Text', 'Writer', 'audiobook');
    const stub = clients(
      new Map([['other', { title: 'Other', author: 'Other', ebookStatus: 'Open' }]]),
    );
    expect(
      await runFormatPairing({
        db: t.db,
        ll: stub.ll,
        gb: stub.gb,
        cap: 1,
        now: NOW,
        pacer: async () => {},
      }),
    ).toMatchObject({ pushed: 1 });
    expect(stub.calls).toEqual(['GB.resolveVolume', 'addBook', 'queueBook', 'searchBook']);
    expect(
      buildPairingAcquisitionDeferrals([
        {
          id: 'white-sand',
          mediaKind: 'book',
          title: 'White Sand',
          sortTitle: '',
          author: 'Brandon Sanderson',
          heldBooks: [{ title: null, author: null, isbn: null }],
        },
      ]).unreadBookItemIds.size,
    ).toBe(0);
  });
});
