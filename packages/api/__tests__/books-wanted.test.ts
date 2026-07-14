// ADR-057 / DESIGN-029 (PLAN-045 step 4) — the Library-Wanted COMPOSITION surface (`books.wanted`):
//   • gated by the BOOKS section exactly like the wall it rides (owner ruling Q-01): a withheld books
//     section ⇒ FORBIDDEN — its wanted tiles are withheld with it (the ADR-047 posture: server-refused,
//     never client-hidden);
//   • HOUSEHOLD visibility: any books-visible member sees every linked user's wanted tiles;
//   • per-viewer affordances are computed server-side: canSearch/canOpenRequest need OWNERSHIP of the
//     request's integration AND the integrations section (what `integrations.search` enforces);
//   • per-wall format legs: ebook ⇒ Books, audiobook ⇒ Audiobooks, comic ⇒ Comics; matched wants and
//     landed formats never compose a Wanted tile.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  linkIntegration,
  syncBooks,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
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

let t: TestDb;
let ownerCaller: Caller; // admin — owns the linked integration (books + integrations implied)
let readerCaller: Caller; // member with books read_only, NO integrations section
let disabledCaller: Caller; // default member — books disabled
let ownerName: string;

beforeAll(async () => {
  t = await bootMigratedDb();
  const owner = await createUser(t.db, { admin: true, displayName: 'Owner Odin' });
  ownerName = owner.displayName;
  const reader = await createUser(t.db, { displayName: 'Reader Rae' });
  const disabled = await createUser(t.db, { displayName: 'Member Mia' });
  ownerCaller = caller(makeCtx(t.db, sessionUser(owner)));
  readerCaller = caller(makeCtx(t.db, sessionUser(reader, { books: 'read_only' })));
  disabledCaller = caller(makeCtx(t.db, sessionUser(disabled)));

  // One library book so the MATCHED want is excluded from the overlay.
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita'],
    rows: [
      {
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-owned',
        libraryId: '1',
        libraryName: 'Books',
        title: 'Project Hail Mary',
        sortTitle: 'project hail mary',
        author: 'Andy Weir',
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: 'v1.png',
        deepLinkUrl: 'https://kavita/1',
        pageCount: null,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: {},
        sourceAddedAt: null,
        sourceUpdatedAt: null,
      },
    ],
  });

  // The owner's integration: an unmet want (both LL formats), a matched want, and a parked comic.
  const { integration } = await linkIntegration({
    db: t.db,
    userId: owner.id,
    provider: 'goodreads',
    externalUserId: '202652880',
    profileRef: '202652880',
    actorId: owner.id,
  });
  const items: EnrichedShelfItem[] = [
    { shelf: 'to-read', externalBookId: 'gr-hyp', title: 'Hyperion', author: 'Dan Simmons', isbn: null, gbVolumeId: 'gb-hyp', coverUrl: null, shelvedAt: new Date('2026-07-10T00:00:00Z'), isComic: false },
    { shelf: 'read', externalBookId: 'gr-phm', title: 'Project Hail Mary', author: 'Andy Weir', isbn: null, gbVolumeId: 'gb-phm', coverUrl: null, shelvedAt: new Date('2026-07-09T00:00:00Z'), isComic: false },
    { shelf: 'read', externalBookId: 'gr-sp', title: 'Scott Pilgrim, Vol. 1', author: 'Bryan Lee O’Malley', isbn: null, gbVolumeId: null, coverUrl: null, shelvedAt: new Date('2026-07-08T00:00:00Z'), isComic: true },
  ];
  // No LL / no Kapowarr bundle: mint-only (statuses 'requested' with the GB id; the comic parks).
  await syncGoodreadsIntegration({
    db: t.db,
    integrationId: integration.id,
    items,
    syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
    pacer: async () => {},
  });
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

describe('books.wanted — the section gate (the ADR-047 posture)', () => {
  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const anon = caller(makeCtx(t.db, null));
    expect(await codeOf(() => anon.books.wanted({ mediaKind: 'book' }))).toBe('UNAUTHORIZED');
  });

  it('a WITHHELD books section withholds its wanted tiles too (FORBIDDEN, server-refused)', async () => {
    expect(await codeOf(() => disabledCaller.books.wanted({ mediaKind: 'book' }))).toBe('FORBIDDEN');
  });
});

describe('books.wanted — the household composition', () => {
  it('composes the Books wall leg: unmet wants only (matched excluded), badged by source shelf', async () => {
    const res = await ownerCaller.books.wanted({ mediaKind: 'book' });
    expect(res.items.map((i) => i.title)).toEqual(['Hyperion']); // PHM matched ⇒ excluded; comic ⇒ Comics wall
    const hyp = res.items[0]!;
    expect(hyp.shelf).toBe('to-read');
    expect(hyp.status).toBe('requested');
    expect(hyp.isComic).toBe(false);
    expect(hyp.requestedBy).toEqual([ownerName]);
  });

  it('the Comics wall leg carries the parked comic (honest state, not force-searchable)', async () => {
    const res = await ownerCaller.books.wanted({ mediaKind: 'comic' });
    expect(res.items.map((i) => i.title)).toEqual(['Scott Pilgrim, Vol. 1']);
    expect(res.items[0]!.parked).toBe(true);
    expect(res.items[0]!.canSearch).toBe(false); // no Kapowarr volume yet — nothing to fire
  });

  it('HOUSEHOLD visibility: a books-only member sees the tiles; affordances stay owner-scoped', async () => {
    const res = await readerCaller.books.wanted({ mediaKind: 'book' });
    expect(res.items.map((i) => i.title)).toEqual(['Hyperion']);
    // Not the owner + no integrations section ⇒ neither the force-search nor the deep link renders.
    expect(res.items[0]!.canSearch).toBe(false);
    expect(res.items[0]!.canOpenRequest).toBe(false);
  });

  it('the OWNER (integrations-visible) gets canSearch + canOpenRequest on their own request', async () => {
    const res = await ownerCaller.books.wanted({ mediaKind: 'book' });
    expect(res.items[0]!.canSearch).toBe(true); // llBookId resolved + not landed ⇒ searchable
    expect(res.items[0]!.canOpenRequest).toBe(true);
  });

  it('the Audiobooks wall mirrors the audio leg of the same unmet want', async () => {
    const res = await ownerCaller.books.wanted({ mediaKind: 'audiobook' });
    expect(res.items.map((i) => i.title)).toEqual(['Hyperion']);
  });
});

// ADR-057 amendment (PLAN-047) — the Wanted DETAIL surface (`books.wantedDetail`): reachable by whoever can
// see the card that links to it (books OR integrations section), household attribution + per-format status
// rows, and per-format `searchable` gated on OWN-the-request + integrations (exactly what integrations.search
// enforces — a books-only viewer sees the rows read-only, and the search action itself FORBIDs them).
describe('books.wantedDetail — the Movies/TV parity detail page surface', () => {
  async function hyperionRequestId(): Promise<string> {
    const res = await ownerCaller.books.wanted({ mediaKind: 'book' });
    return res.items.find((i) => i.title === 'Hyperion')!.requestId;
  }
  async function comicRequestId(): Promise<string> {
    const res = await ownerCaller.books.wanted({ mediaKind: 'comic' });
    return res.items[0]!.requestId;
  }

  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const anon = caller(makeCtx(t.db, null));
    const id = await hyperionRequestId();
    expect(await codeOf(() => anon.books.wantedDetail({ requestId: id }))).toBe('UNAUTHORIZED');
  });

  it('a caller with NEITHER books NOR integrations is FORBIDDEN (server-refused)', async () => {
    const id = await hyperionRequestId();
    expect(await codeOf(() => disabledCaller.books.wantedDetail({ requestId: id }))).toBe('FORBIDDEN');
  });

  it('NOT_FOUND for an unknown request id', async () => {
    expect(
      await codeOf(() =>
        ownerCaller.books.wantedDetail({ requestId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('the OWNER sees the full detail: shelf, household attribution, per-format rows, per-format searchable', async () => {
    const detail = await ownerCaller.books.wantedDetail({ requestId: await hyperionRequestId() });
    expect(detail.title).toBe('Hyperion');
    expect(detail.shelf).toBe('to-read');
    expect(detail.isComic).toBe(false);
    expect(detail.mediaKind).toBe('book');
    expect(detail.requestedBy).toEqual([ownerName]);
    expect(detail.canSearch).toBe(true);
    // BOTH LazyLibrarian legs, each with its own status + a searchable Force-Search (llBookId resolved, not landed).
    expect(detail.formats.map((f) => f.format)).toEqual(['ebook', 'audiobook']);
    expect(detail.formats.every((f) => f.status === 'requested')).toBe(true);
    expect(detail.formats.every((f) => f.searchable)).toBe(true);
  });

  it('HOUSEHOLD view: a books-only member can VIEW the detail but every per-format Force-Search is withheld', async () => {
    const detail = await readerCaller.books.wantedDetail({ requestId: await hyperionRequestId() });
    expect(detail.title).toBe('Hyperion'); // books gating alone lets them reach it (household, Q-01)
    expect(detail.canSearch).toBe(false);
    expect(detail.formats.some((f) => f.searchable)).toBe(false);
  });

  it('and the search ACTION itself FORBIDs a books-only member (integrations + ownership gate)', async () => {
    const id = await hyperionRequestId();
    expect(await codeOf(() => readerCaller.integrations.search({ requestId: id }))).toBe('FORBIDDEN');
    expect(await codeOf(() => readerCaller.integrations.search({ requestId: id, format: 'ebook' }))).toBe(
      'FORBIDDEN',
    );
  });

  it('a PARKED comic renders its single Kapowarr leg, not force-searchable (no volume yet)', async () => {
    const detail = await ownerCaller.books.wantedDetail({ requestId: await comicRequestId() });
    expect(detail.isComic).toBe(true);
    expect(detail.mediaKind).toBe('comic');
    expect(detail.parked).toBe(true);
    expect(detail.formats.map((f) => f.format)).toEqual(['comic']);
    expect(detail.formats[0]!.searchable).toBe(false); // no Kapowarr volume ⇒ nothing to fire
  });
});
