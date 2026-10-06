// Issue #759 (DESIGN-028 amendment 2026-10-06) — a collection want LazyLibrarian downloaded that the library cannot show
// reads Downloaded. Real shapes from the live audit: a `.mobi` Kavita cannot open (Eragon), a LazyLibrarian book that is
// another work (Compulsory on "Dumbing Us Down"), a file the library shows under another title (The World of Divergent).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookRequests, booksCollections } from '@hnet/db';
import {
  collectionWantDownloaded,
  getCollectionWantedBookRequests,
  libraryShowsTitle,
  libraryTitleKey,
  reconcileCollectionWantsDownloaded,
  syncBooks,
  syncBooksCollections,
  syncCollectionWants,
  type BooksItemInput,
  type LlSnapshotRow,
} from '../src';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t.stop();
});

const keys = (...titles: string[]) => titles.map(libraryTitleKey);

describe('libraryShowsTitle', () => {
  it('a title the library carries, or carries inside a longer one, is shown', () => {
    expect(libraryShowsTitle('The World of All Souls', keys('The World of All Souls'))).toBe(true);
    expect(
      libraryShowsTitle(
        'Camp Half-Blood Confidential (Percy Jackson and the Olympians)',
        keys(
          'From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide to the Demigod Training Camp',
        ),
      ),
    ).toBe(true);
    // The library title is the head of LazyLibrarian's longer name.
    expect(
      libraryShowsTitle(
        'The World of Divergent. The Path to Allegiant',
        keys('The World of Divergent'),
      ),
    ).toBe(true);
    expect(
      libraryShowsTitle('Rapport. Friendship, Solidarity, Communion, Empathy', keys('Rapport')),
    ).toBe(true);
  });

  it('a short word inside another title says nothing', () => {
    expect(libraryShowsTitle('Shatter Me', keys('Me', 'Reveal Me (Shatter Me Novella)'))).toBe(
      false,
    );
    expect(
      libraryShowsTitle(
        'Eragon',
        keys('The Fork, the Witch, and the Worm', "Eragon's Guide to Alagaesia"),
      ),
    ).toBe(false);
  });

  it('a title with nothing to compare is never claimed missing', () => {
    expect(libraryShowsTitle('', keys('Anything'))).toBe(true);
  });
});

describe('collectionWantDownloaded', () => {
  const heldEbook: LlSnapshotRow = {
    title: 'Eragon',
    author: 'Christopher Paolini',
    ebookStatus: 'Open',
  };

  it('LazyLibrarian holds the member’s book and the library shows nothing like it', () => {
    expect(
      collectionWantDownloaded({
        want: { title: 'Eragon', author: null },
        book: heldEbook,
        format: 'ebook',
        libraryKeys: keys('The Fork, the Witch, and the Worm'),
      }),
    ).toBe(true);
  });

  it('never for another work’s book, a format LazyLibrarian does not hold, or a title the library shows', () => {
    expect(
      collectionWantDownloaded({
        want: { title: 'Compulsory', author: null },
        book: { title: 'Dumbing Us Down', author: 'John Taylor Gatto', ebookStatus: 'Open' },
        format: 'ebook',
        libraryKeys: [],
      }),
    ).toBe(false);
    expect(
      collectionWantDownloaded({
        want: { title: 'Eragon', author: null },
        book: { ...heldEbook, ebookStatus: 'Wanted' },
        format: 'ebook',
        libraryKeys: [],
      }),
    ).toBe(false);
    expect(
      collectionWantDownloaded({
        want: { title: 'Eragon', author: null },
        book: heldEbook,
        format: 'audiobook',
        libraryKeys: [],
      }),
    ).toBe(false);
    expect(
      collectionWantDownloaded({
        want: { title: 'The World of Divergent: The Path to Allegiant', author: null },
        book: {
          title: 'The World of Divergent. The Path to Allegiant',
          author: 'Veronica Roth',
          ebookStatus: 'Open',
        },
        format: 'ebook',
        libraryKeys: keys('The World of Divergent'),
      }),
    ).toBe(false);
  });
});

describe('reconcileCollectionWantsDownloaded', () => {
  let collectionId: string;

  beforeEach(async () => {
    await t.db.delete(bookRequests);
    await t.db.delete(booksCollections);
    await syncBooks({ db: t.db, syncedSources: ['kavita', 'audiobookshelf'], rows: [] });
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: 'inheritance',
          kind: 'collection',
          libraryId: null,
          title: 'The Inheritance Cycle',
          itemCount: 0,
          ordered: false,
          createdBy: 'libretto',
          librettoRecipeId: 'the-inheritance-cycle',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [],
    });
    const [row] = await t.db.select({ id: booksCollections.id }).from(booksCollections);
    collectionId = row!.id;
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [{ memberRef: 'isbn:eragon', title: 'Eragon', author: null, llBookId: 'llEragon' }],
    });
  });

  const ll = (rows: Record<string, LlSnapshotRow>) => ({
    read: { getAllBookStatuses: async () => new Map(Object.entries(rows)) },
  });
  const ebookStatus = async () =>
    (
      await t.db
        .select({ s: bookRequests.ebookStatus })
        .from(bookRequests)
        .where(eq(bookRequests.collectionId, collectionId))
    )[0]?.s;
  const libraryWith = (title: string): BooksItemInput => ({
    source: 'kavita',
    mediaKind: 'book',
    externalId: 'k-eragon',
    libraryId: '1',
    libraryName: 'Books',
    title,
    sortTitle: title.toLowerCase(),
    author: null,
    narrator: null,
    seriesName: null,
    year: null,
    releasedAt: null,
    genres: [],
    coverRef: null,
    deepLinkUrl: 'http://x',
    pageCount: null,
    wordCount: null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
  });

  it('lands a held, unshown want; the drill keeps it; it goes back when the library shows the book', async () => {
    const held = ll({
      llEragon: { title: 'Eragon', author: 'Christopher Paolini', ebookStatus: 'Open' },
    });
    const first = await reconcileCollectionWantsDownloaded({ db: t.db, ll: held });
    expect(first).toEqual({ downloaded: 1, reverted: 0, skipped: false });
    expect(await ebookStatus()).toBe('landed');
    const drill = await getCollectionWantedBookRequests({ db: t.db, collectionId });
    expect(drill.map((w) => [w.title, w.status])).toEqual([['Eragon', 'landed']]);

    // A second run changes nothing.
    expect(await reconcileCollectionWantsDownloaded({ db: t.db, ll: held })).toEqual({
      downloaded: 0,
      reverted: 0,
      skipped: false,
    });

    // The library now shows an "Eragon": the file arrived and only the pairing lags, so it is not "not in the library".
    await syncBooks({ db: t.db, syncedSources: ['kavita'], rows: [libraryWith('Eragon')] });
    expect(await reconcileCollectionWantsDownloaded({ db: t.db, ll: held })).toEqual({
      downloaded: 0,
      reverted: 1,
      skipped: false,
    });
    expect(await ebookStatus()).toBe('requested');
  });

  it('reverts when LazyLibrarian no longer holds the format', async () => {
    await reconcileCollectionWantsDownloaded({
      db: t.db,
      ll: ll({ llEragon: { title: 'Eragon', author: 'Christopher Paolini', ebookStatus: 'Open' } }),
    });
    const report = await reconcileCollectionWantsDownloaded({
      db: t.db,
      ll: ll({
        llEragon: { title: 'Eragon', author: 'Christopher Paolini', ebookStatus: 'Wanted' },
      }),
    });
    expect(report.reverted).toBe(1);
    expect(await ebookStatus()).toBe('requested');
  });

  it('an empty LazyLibrarian read decides nothing', async () => {
    await reconcileCollectionWantsDownloaded({
      db: t.db,
      ll: ll({ llEragon: { title: 'Eragon', author: 'Christopher Paolini', ebookStatus: 'Open' } }),
    });
    expect(await reconcileCollectionWantsDownloaded({ db: t.db, ll: ll({}) })).toEqual({
      downloaded: 0,
      reverted: 0,
      skipped: true,
    });
    expect(await ebookStatus()).toBe('landed');
  });

  it('leaves a parked want alone', async () => {
    await t.db.update(bookRequests).set({ unroutableReason: 'wrong_volume' });
    const report = await reconcileCollectionWantsDownloaded({
      db: t.db,
      ll: ll({ llEragon: { title: 'Eragon', author: 'Christopher Paolini', ebookStatus: 'Open' } }),
    });
    expect(report.downloaded).toBe(0);
    expect(await ebookStatus()).toBe('requested');
  });
});
