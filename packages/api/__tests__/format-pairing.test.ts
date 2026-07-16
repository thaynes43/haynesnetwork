// ADR-065 / DESIGN-036 (PLAN-050) — the format-pairing API surfaces:
//   • books.detail pairing state (paired ⇒ BOTH consume buttons; unpaired ⇒ the missing format's
//     want affordance; comics carry none);
//   • books.search formatCoverage (the wall badge signal);
//   • the composed Wanted walls + wantedDetail include origin='pairing' system wants, attributed
//     "Format pairing";
//   • books.searchPairingWant — the BOOKS-gated, audited force-search for pairing wants (a member
//     with books disabled is FORBIDDEN; a goodreads want is FORBIDDEN here AND a pairing want is
//     FORBIDDEN on the owner-gated integrations.search — the two gates never blur).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookRequests, booksItems, permissionAudit } from '@hnet/db';
import {
  linkIntegration,
  runFormatPairing,
  syncBooks,
  syncGoodreadsIntegration,
  type LazyLibrarianClientBundle,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';
import type { TRPCContext } from '../src/trpc';
import type { BooksSearchEntry } from '../src';

let t: TestDb;
let adminCaller: Caller; // admin — books + integrations implied
let readerCaller: Caller; // member with books read_only, NO integrations
let disabledCaller: Caller; // default member — books disabled
let pairedBookId: string;
let unpairedBookId: string;
let comicId: string;
let pairingWantId: string;
let goodreadsWantId: string;

interface LlCall {
  cmd: string;
  id: string;
  format?: string;
}
function stubLl() {
  const calls: LlCall[] = [];
  return {
    calls,
    bundle: {
      write: {
        addBook: async (id: string) => {
          calls.push({ cmd: 'addBook', id });
          return 'OK';
        },
        queueBook: async (id: string, format: string) => {
          calls.push({ cmd: 'queueBook', id, format });
          return 'OK';
        },
        searchBook: async (id: string, format: string) => {
          calls.push({ cmd: 'searchBook', id, format });
          return 'OK';
        },
      },
      read: { getAllBookStatuses: async () => new Map() },
    } as unknown as LazyLibrarianClientBundle,
  };
}

const baseRow = {
  libraryId: '1',
  libraryName: 'Lib',
  narrator: null,
  seriesName: null,
  year: null,
  releasedAt: null,
  genres: [] as string[],
  coverRef: null,
  pageCount: null,
  wordCount: null,
  durationSeconds: null,
  sizeBytes: null,
  attrs: {},
  sourceAddedAt: null,
  sourceUpdatedAt: null,
};

beforeAll(async () => {
  t = await bootMigratedDb();
  const admin = await createUser(t.db, { admin: true, displayName: 'Owner Odin' });
  const reader = await createUser(t.db, { displayName: 'Reader Rae' });
  const disabled = await createUser(t.db, { displayName: 'Member Mia' });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin)));
  readerCaller = caller(makeCtx(t.db, sessionUser(reader, { books: 'read_only' })));
  disabledCaller = caller(makeCtx(t.db, sessionUser(disabled)));

  // The library: a PAIRED title (both formats), an UNPAIRED book (missing its audiobook), a comic.
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      { ...baseRow, source: 'kavita', mediaKind: 'book', externalId: 'k-hyp', title: 'Hyperion', sortTitle: 'hyperion', author: 'Dan Simmons', deepLinkUrl: 'https://kavita/hyperion' },
      { ...baseRow, source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a-hyp', title: 'Hyperion', sortTitle: 'hyperion', author: 'Dan Simmons', deepLinkUrl: 'https://abs/hyperion' },
      { ...baseRow, source: 'kavita', mediaKind: 'book', externalId: 'k-mar', title: 'The Martian', sortTitle: 'martian', author: 'Andy Weir', deepLinkUrl: 'https://kavita/martian' },
      { ...baseRow, source: 'kavita', mediaKind: 'comic', externalId: 'k-saga', title: 'Saga', sortTitle: 'saga', author: 'Brian K. Vaughan', deepLinkUrl: 'https://kavita/saga' },
    ],
  });
  const items = await t.db.select().from(booksItems);
  pairedBookId = items.find((i) => i.externalId === 'k-hyp')!.id;
  unpairedBookId = items.find((i) => i.externalId === 'k-mar')!.id;
  comicId = items.find((i) => i.externalId === 'k-saga')!.id;

  // One format-pairing run mints + pushes The Martian's audiobook want.
  const ll = stubLl();
  await runFormatPairing({
    db: t.db,
    ll: ll.bundle,
    gb: { resolveVolume: async () => ({ volumeId: 'gb-martian' }) },
    pacer: async () => {},
  });
  const [pairingWant] = await t.db
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.origin, 'pairing'));
  pairingWantId = pairingWant!.id;

  // A goodreads want (mint-only) for the origin cross-checks.
  const { integration } = await linkIntegration({
    db: t.db,
    userId: admin.id,
    provider: 'goodreads',
    externalUserId: '202652880',
    profileRef: '202652880',
    actorId: admin.id,
  });
  await syncGoodreadsIntegration({
    db: t.db,
    integrationId: integration.id,
    items: [
      { shelf: 'to-read', externalBookId: 'gr-tog', title: 'Throne of Glass', author: 'Sarah J. Maas', isbn: null, gbVolumeId: 'gb-tog', coverUrl: null, shelvedAt: new Date(), isComic: false },
    ],
    syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
    pacer: async () => {},
  });
  const [grWant] = await t.db
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.origin, 'goodreads'));
  goodreadsWantId = grWant!.id;
  // Clear the mint-era audits so the searchPairingWant assertions count from zero.
  await t.db.delete(permissionAudit);
});

afterAll(async () => {
  await t?.stop();
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

/** PLAN-056 — narrow the composed stream to its ON-DISK rows (these assertions target library
 *  items; wanted entries carry no item metadata). */
const onDisk = (items: BooksSearchEntry[]) => items.flatMap((i) => (i.kind === 'item' ? [i] : []));

describe('books.detail — the pairing state (DESIGN-036 D-09)', () => {
  it('a PAIRED title carries BOTH consume plays, each its own deep link', async () => {
    const detail = await readerCaller.books.detail({ id: pairedBookId });
    expect(detail.play).toMatchObject({ label: 'Read in Kavita', url: 'https://kavita/hyperion' });
    expect(detail.pairing?.pairedPlay).toEqual({
      app: 'audiobookshelf',
      label: 'Listen on Audiobookshelf',
      url: 'https://abs/hyperion',
    });
    expect(detail.pairing?.missingFormat).toBeNull();
    expect(detail.pairing?.want).toBeNull();
  });

  it('an UNPAIRED book names the missing audiobook + its minted, searchable want', async () => {
    const detail = await readerCaller.books.detail({ id: unpairedBookId });
    expect(detail.pairing?.pairedPlay).toBeNull();
    expect(detail.pairing?.missingFormat).toBe('audiobook');
    expect(detail.pairing?.want).toEqual({
      requestId: pairingWantId,
      status: 'wanted',
      searchable: true,
    });
  });

  it('a comic carries NO pairing block (out of scope)', async () => {
    const detail = await readerCaller.books.detail({ id: comicId });
    expect(detail.pairing).toBeNull();
  });
});

describe('books.search — formatCoverage (the wall badge signal)', () => {
  it('the Books wall reports both / ebook; the Audiobooks wall reports both; comics stay null', async () => {
    const books = await readerCaller.books.search({ mediaKind: 'book', sort: 'title', limit: 24, cursor: 0 });
    const byTitle = Object.fromEntries(onDisk(books.items).map((i) => [i.title, i.formatCoverage]));
    expect(byTitle['Hyperion']).toBe('both');
    expect(byTitle['The Martian']).toBe('ebook');

    const audio = await readerCaller.books.search({ mediaKind: 'audiobook', sort: 'title', limit: 24, cursor: 0 });
    expect(onDisk(audio.items)[0]!.formatCoverage).toBe('both');

    const comics = await readerCaller.books.search({ mediaKind: 'comic', sort: 'title', limit: 24, cursor: 0 });
    expect(onDisk(comics.items)[0]!.formatCoverage).toBeNull();
  });
});

describe('the composed Wanted surfaces include the pairing want (ADR-065 C-04)', () => {
  it('the Audiobooks wall carries the system want, attributed "Format pairing", books-gated searchable', async () => {
    const res = await readerCaller.books.wanted({ mediaKind: 'audiobook' });
    const want = res.items.find((i) => i.requestId === pairingWantId);
    expect(want).toBeDefined();
    expect(want).toMatchObject({
      origin: 'pairing',
      title: 'The Martian',
      shelf: 'pairing',
      status: 'wanted',
      requestedBy: ['Format pairing'],
      canSearch: true, // books-gated — the reader holds books read_only
      canOpenRequest: false, // no goodreads sub-section to open
    });
  });

  it('the Books wall does NOT carry it (the held ebook is landed — only the missing leg composes)', async () => {
    const res = await readerCaller.books.wanted({ mediaKind: 'book' });
    expect(res.items.some((i) => i.requestId === pairingWantId)).toBe(false);
  });

  it('wantedDetail renders the pairing want: origin, attribution, per-format rows, books-gated search', async () => {
    const detail = await readerCaller.books.wantedDetail({ requestId: pairingWantId });
    expect(detail.origin).toBe('pairing');
    expect(detail.title).toBe('The Martian');
    expect(detail.requestedBy).toEqual(['Format pairing']);
    expect(detail.shelf).toBe('pairing');
    expect(detail.canSearch).toBe(true); // books read_only suffices for a system want
    const byFormat = Object.fromEntries(detail.formats.map((f) => [f.format, f]));
    expect(byFormat['ebook']).toMatchObject({ status: 'landed', searchable: false });
    expect(byFormat['audiobook']).toMatchObject({ status: 'wanted', searchable: true });
  });
});

describe('books.searchPairingWant — the books-gated, audited force-search (ADR-065 C-05)', () => {
  it('a books-read_only member fires it: audited request_book_search + the confined searchBook', async () => {
    const ll = stubLl();
    const reader = await createUser(t.db, { displayName: 'Reader Two' });
    const ctx: TRPCContext = {
      ...makeCtx(t.db, sessionUser(reader, { books: 'read_only' })),
      lazylibrarian: ll.bundle,
    };
    const result = await caller(ctx).books.searchPairingWant({ requestId: pairingWantId });
    expect(result.searched).toBe(true);
    expect(result.formats).toEqual(['audiobook']); // the held ebook narrows itself out
    expect(ll.calls).toEqual([{ cmd: 'searchBook', id: 'gb-martian', format: 'audiobook' }]);

    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(reader.id);
  });

  it('a member with books DISABLED is FORBIDDEN (server-refused, never client-hidden)', async () => {
    expect(await codeOf(() => disabledCaller.books.searchPairingWant({ requestId: pairingWantId }))).toBe(
      'FORBIDDEN',
    );
  });

  it('an anonymous caller is UNAUTHORIZED; an unknown id is NOT_FOUND', async () => {
    const anon = caller(makeCtx(t.db, null));
    expect(await codeOf(() => anon.books.searchPairingWant({ requestId: pairingWantId }))).toBe(
      'UNAUTHORIZED',
    );
    expect(
      await codeOf(() =>
        adminCaller.books.searchPairingWant({ requestId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('a GOODREADS want is FORBIDDEN here — it keeps the owner-gated integrations.search', async () => {
    expect(await codeOf(() => adminCaller.books.searchPairingWant({ requestId: goodreadsWantId }))).toBe(
      'FORBIDDEN',
    );
  });

  it('and a PAIRING want is FORBIDDEN on integrations.search — the ownership gate stays intact', async () => {
    expect(await codeOf(() => adminCaller.integrations.search({ requestId: pairingWantId }))).toBe(
      'FORBIDDEN',
    );
  });
});
