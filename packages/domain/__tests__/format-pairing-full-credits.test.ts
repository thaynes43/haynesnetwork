// Issue #850. Finite offline fixtures and real PostgreSQL 16; one worker under nice -n 19.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookRequestEvents, bookRequests, booksFormatPairs, booksItems, booksPairingReservations } from '@hnet/db';
import {
  buildPairingAcquisitionDeferrals, buildPairingHeldCoverage, loadRemovedPairingTransitions,
  matchFormatPairs, pairingCreditsAgree, pairingIdentity, readSourceAuthors, runEnglishEditionPass,
  runFormatPairing, syncFormatPairs, type LazyLibrarianClientBundle, type PairableItem,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

const NOW = new Date('2026-10-08T18:00:00Z');
const fixtures = [
  { title: 'The War of the Ring', writers: ['Christopher Tolkien', 'J.R.R. Tolkien'], primary: 'J.R.R. Tolkien', ebookIsbn: '9780618083596', audioIsbn: '9780358726821' },
  { title: 'The Long Earth', writers: ['Stephen Baxter', 'Terry Pratchett'], primary: 'Terry Pratchett', ebookIsbn: '9781446465738', audioIsbn: null },
];
const sources = (f = fixtures[1]!): [PairableItem, PairableItem] => [
  { id: 'book', title: f.title, sortTitle: f.title, author: f.primary, mediaKind: 'book', heldBooks: [{ title: f.title, author: f.writers[0]!, authors: f.writers, isbn: f.ebookIsbn }] },
  { id: 'audio', title: f.title, sortTitle: f.title, author: f.primary, mediaKind: 'audiobook', authors: [f.primary], isbn: f.audioIsbn },
];

describe('complete declared credits', () => {
  it.each(fixtures)('refuses the actual subset counterpart for $title and defers both sides', (f) => {
    const [b, a] = sources(f);
    expect(matchFormatPairs([b, a])).toEqual([]);
    const identity = pairingIdentity(b);
    expect(identity).toMatchObject({ author: f.writers.join(', '), authors: f.writers });
    const coverage = buildPairingHeldCoverage([b, a]);
    expect(coverage.holds(a, 'ebook')).toBe(false);
    expect(identity.kind === 'one' && coverage.holds(identity, 'audiobook')).toBe(false);
    const deferrals = buildPairingAcquisitionDeferrals([b, a]);
    expect(deferrals.blocks(b.id, b, 'audiobook')).toBe(true);
    expect(deferrals.blocks(a.id, a, 'ebook')).toBe(true);
  });
  it('accepts all coauthors in either explicit order with strict initials compatibility', () => {
    const [b, a] = sources(fixtures[0]);
    const complete = { ...a, authors: ['JRR Tolkien', 'Christopher Tolkien'] };
    expect(matchFormatPairs([b, complete])).toHaveLength(1);
    const identity = pairingIdentity(b);
    expect(identity.kind === 'one' && buildPairingHeldCoverage([b, complete]).holds(identity, 'audiobook')).toBe(true);
    expect(buildPairingHeldCoverage([b, complete]).holds(complete, 'ebook')).toBe(true);
    expect(pairingCreditsAgree({ author: null, authors: ['Terry Pratchett', 'Stephen Baxter'] }, { author: 'Terry Pratchett' })).toBe(false);
  });
  it('accepts a combined ABS display only when the authoritative complete source array proves every credit', () => {
    const [b, a] = sources();
    const complete = { ...a, authors: fixtures[1]!.writers, author: 'Terry Pratchett, Stephen Baxter' };
    expect(matchFormatPairs([b, complete])).toHaveLength(1);
    const identity = pairingIdentity(b);
    expect(identity.kind === 'one' && buildPairingHeldCoverage([b, complete]).holds(identity, 'audiobook')).toBe(true);
    const deferred = buildPairingAcquisitionDeferrals([b, complete]);
    expect(deferred.blocks(b.id, b, 'audiobook')).toBe(false);
    expect(deferred.blocks(complete.id, complete, 'ebook')).toBe(false);
    const conflict = { ...complete, author: 'Terry Pratchett, Different Writer' };
    expect(buildPairingAcquisitionDeferrals([b, conflict]).blocks(conflict.id, conflict, 'ebook')).toBe(true);
  });
  it('preserves legacy singleton names without expanding a raw CSV credit into people', () => {
    const [b, a] = sources();
    const single = { ...b, heldBooks: [{ title: b.title, author: 'Terry Pratchett', isbn: null }] };
    const legacy = { ...a, authors: undefined };
    expect(matchFormatPairs([single, legacy])).toHaveLength(1);
    expect(matchFormatPairs([b, { ...a, authors: undefined, author: 'Stephen Baxter, Terry Pratchett' }])).toEqual([]);
  });
  it('never falls back from empty or partial explicit credits to a display author', () => {
    expect(readSourceAuthors({ authors: [] })).toEqual([]);
    expect(readSourceAuthors({ authors: null })).toEqual([]);
    expect(readSourceAuthors({ authors: ['Terry Pratchett', ''] })).toEqual([]);
    expect(readSourceAuthors({})).toBeUndefined();
    const [, a] = sources();
    const unknown = { ...a, authors: [] };
    expect(pairingIdentity(unknown)).toMatchObject({ author: null });
    expect(buildPairingAcquisitionDeferrals([unknown]).blocks(unknown.id, unknown, 'ebook')).toBe(true);
  });
  it('conflicting duplicate chapter credits are unknown instead of a conveniently chosen chapter or a parkable omnibus', () => {
    const [b] = sources();
    const held = b.heldBooks![0]!;
    expect(pairingIdentity({ ...b, heldBooks: [held, { ...held, author: 'Terry Pratchett', authors: ['Terry Pratchett'] }] })).toEqual({ kind: 'unknown' });
    expect(pairingIdentity({ ...b, heldBooks: [held, { ...held, authors: [...held.authors!].reverse() }] }).kind).toBe('one');
  });
  it('a singleton LL primary credit cannot replace a complete current physical edition', () => {
    const [b, a] = sources();
    const snapshot = new Map([['primary-only', { title: a.title, author: a.author, ebookStatus: 'Open' }]]);
    const coverage = buildPairingHeldCoverage([b, a], snapshot);
    expect(coverage.holds(a, 'ebook')).toBe(false);
    expect(coverage.replacementFor?.(a, 'ebook', 'gone')).toBeNull();
  });
});

let t: TestDb;
let seq = 0;
beforeAll(async () => { t = await bootMigratedDb(); });
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  await t.db.delete(bookRequestEvents);
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(booksPairingReservations);
  await t.db.delete(booksItems);
});
async function seed(value: PairableItem, removed = false) {
  const [row] = await t.db.insert(booksItems).values({
    source: value.mediaKind === 'book' ? 'kavita' : 'audiobookshelf', mediaKind: value.mediaKind,
    externalId: `credits-${++seq}`, libraryId: '1', libraryName: 'Books', title: value.title,
    sortTitle: value.sortTitle, author: value.author, isbn: value.isbn, deepLinkUrl: 'https://books.example',
    deletedAt: removed ? NOW : null,
    attrs: { ...(value.heldBooks !== undefined ? { heldBooks: value.heldBooks } : {}), ...(value.authors !== undefined ? { authors: value.authors } : {}) },
  }).returning();
  return row!;
}
async function want(anchor: string, audioStatus: 'wanted' | 'landed' = 'wanted') {
  return (await t.db.insert(bookRequests).values({ origin: 'pairing', pairingBooksItemId: anchor,
    title: 'The Long Earth', author: 'Terry Pratchett', llBookId: 'primary-only', ebookStatus: 'landed', audioStatus,
    createdAt: NOW, updatedAt: NOW }).returning())[0]!;
}
const noWrites = () => {
  const calls: string[] = [];
  const ll = { read: { getAllBookStatuses: async () => new Map([['primary-only', {
    title: 'The Long Earth', author: 'Terry Pratchett', ebookStatus: 'Open', audioStatus: 'Skipped', language: 'en',
  }]]) }, write: { addBook: async () => { calls.push('add'); }, queueBook: async () => { calls.push('queue'); },
    searchBook: async () => { calls.push('search'); }, unqueueBook: async () => { calls.push('unqueue'); } } } as unknown as LazyLibrarianClientBundle;
  return { ll, calls };
};

describe('existing wants and counterpart reservations', () => {
  it.each([{ authors: [] }, { authors: null }, { authors: ['Terry Pratchett', ''] }, { authors: 'Terry Pratchett' }])('preserves an unknown-credit audio want through native and English held-format maintenance: %j', async (attrs) => {
    const [, a] = sources();
    const audio = await seed({ ...a, authors: undefined });
    await t.db.update(booksItems).set({ attrs }).where(eq(booksItems.id, audio.id));
    const before = (await t.db.insert(bookRequests).values({ origin: 'pairing', pairingBooksItemId: audio.id,
      title: a.title, author: a.author, llBookId: 'primary-only', ebookStatus: 'requested', audioStatus: 'landed',
      createdAt: NOW, updatedAt: NOW }).returning())[0]!;
    const stub = noWrites(); let resolves = 0;
    await runFormatPairing({ db: t.db, ll: stub.ll, cap: 25, pacer: async () => {}, now: NOW });
    await runEnglishEditionPass({ db: t.db, now: NOW, snapshot: await stub.ll.read.getAllBookStatuses(),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async () => { resolves += 1; return null; } } } });
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]).toEqual(before);
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
    expect(stub.calls).toEqual([]); expect(resolves).toBe(0);
  });
  it('still lands a legacy absent-array singleton want when the held counterpart is positively proved', async () => {
    const [, a] = sources(); const audio = await seed({ ...a, authors: undefined });
    const before = (await t.db.insert(bookRequests).values({ origin: 'pairing', pairingBooksItemId: audio.id,
      title: a.title, author: a.author, llBookId: 'primary-only', ebookStatus: 'requested', audioStatus: 'landed',
      createdAt: NOW, updatedAt: NOW }).returning())[0]!;
    const stub = noWrites();
    await runFormatPairing({ db: t.db, ll: stub.ll, cap: 0, pacer: async () => {}, now: NOW });
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]?.ebookStatus).toBe('landed');
    expect(await t.db.select().from(bookRequestEvents)).not.toEqual([]);
    expect(stub.calls).toEqual([]);
  });
  it('drops a false cache edge once, persists its reservation and preserves requests across subsequent native runs', async () => {
    const [b, a] = sources();
    const book = await seed(b), audio = await seed(a);
    await t.db.insert(booksFormatPairs).values({ bookItemId: book.id, audioItemId: audio.id, matchedVia: 'title_author' });
    const before = await want(book.id, 'landed');
    const stub = noWrites(); let resolves = 0;
    const run = () => runFormatPairing({ db: t.db, ll: stub.ll, gb: { resolveVolume: async () => { resolves += 1; return { volumeId: 'unproved' }; } }, cap: 25, pacer: async () => {}, now: NOW });
    await run();
    expect(await t.db.select().from(booksFormatPairs)).toHaveLength(0);
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
    await run();
    expect(await t.db.select().from(booksPairingReservations)).toHaveLength(1);
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]).toEqual(before);
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
    expect(stub.calls).toEqual([]); expect(resolves).toBe(0);
    await t.db.update(booksItems).set({ attrs: { authors: fixtures[1]!.writers } }).where(eq(booksItems.id, audio.id));
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await t.db.select().from(booksFormatPairs)).toHaveLength(1);
    expect(await t.db.select().from(booksPairingReservations)).toEqual([]);
  });
  it('keeps a queued removed predecessor reserved when its current same-title successor omits a declared contributor', async () => {
    const [b] = sources(); const old = await seed(b, true);
    const original = await want(old.id);
    await seed({ ...b, heldBooks: [{ ...b.heldBooks![0]!, author: 'Terry Pratchett', authors: ['Terry Pratchett'] }] });
    const result = await loadRemovedPairingTransitions(t.db);
    expect(result.deferred.map((r) => r.id)).toContain(original.id);
    expect(result.settle).toEqual([]);
    expect(result.protectedFormats.get('primary-only')?.has('audiobook')).toBe(true);
  });
  it('never parks/releases an existing want when duplicated chapters have conflicting credit completeness', async () => {
    const [b] = sources(); const held = b.heldBooks![0]!;
    const row = await seed({ ...b, heldBooks: [held, { ...held, author: 'Terry Pratchett', authors: ['Terry Pratchett'] }] });
    const before = await want(row.id); const stub = noWrites();
    await runFormatPairing({ db: t.db, ll: stub.ll, cap: 25, pacer: async () => {}, now: NOW });
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]).toEqual(before);
    expect(stub.calls).toEqual([]);
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
  });
  it.each([{ authors: [] }, { authors: ['Different Writer'] }, { authors: ['Terry Pratchett', 'Stephen Baxter'] }])('refuses incomplete or conflicting returned English credits $authors at the switch boundary', async ({ authors }) => {
    const [b] = sources();
    const row = await seed({ ...b, heldBooks: [{ title: b.title, author: 'Terry Pratchett', isbn: null }] });
    const before = await want(row.id);
    let resolves = 0;
    const run = () => runEnglishEditionPass({ db: t.db, now: NOW,
      snapshot: new Map([['primary-only', { title: b.title, author: 'Terry Pratchett', language: 'de' }]]),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async () => {
        resolves += 1; return { volumeId: 'candidate', title: b.title, language: 'en', authors };
      } } } });
    const report = await run();
    expect(report).toMatchObject({ looked: 1, switched: 0, parked: 0 });
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]).toMatchObject({
      title: before.title, author: before.author, llBookId: before.llBookId,
      ebookStatus: before.ebookStatus, audioStatus: before.audioStatus, unroutableReason: null,
      englishEditionTriedAt: NOW,
    });
    // Existing bookkeeping writer preserves all Request Event fields: no false status/identity event.
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
    expect(await run()).toMatchObject({ due: 0, looked: 0, switched: 0, parked: 0 });
    expect(resolves).toBe(1);
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
  });
  it('still switches a positively proven singleton English edition through its native writer', async () => {
    const [b] = sources(); const row = await seed({ ...b, heldBooks: [{ title: b.title, author: 'Terry Pratchett', isbn: null }] });
    const before = await want(row.id);
    const report = await runEnglishEditionPass({ db: t.db, now: NOW,
      snapshot: new Map([['primary-only', { title: b.title, author: 'Terry Pratchett', language: 'de' }]]),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async () => ({ volumeId: 'candidate', title: b.title, language: 'en', authors: ['Terry Pratchett'] }) } } });
    expect(report.switched).toBe(1);
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]?.llBookId).toBe('candidate');
    expect(await t.db.select().from(bookRequestEvents)).not.toEqual([]);
  });
  it('a refused first row frees the next cap-one lookup slice on the next pass', async () => {
    const [b] = sources();
    const firstAnchor = await seed({ ...b, heldBooks: [{ title: b.title, author: 'Terry Pratchett', isbn: null }] });
    const first = await want(firstAnchor.id);
    await t.db.update(bookRequests).set({ createdAt: new Date(NOW.getTime() - 1000) }).where(eq(bookRequests.id, first.id));
    const secondAnchor = await seed({ ...b, title: 'The Long Mars', heldBooks: [{ title: 'The Long Mars', author: 'Terry Pratchett', isbn: null }] });
    const second = await want(secondAnchor.id);
    await t.db.update(bookRequests).set({ title: 'The Long Mars', llBookId: 'second' }).where(eq(bookRequests.id, second.id));
    const titles: string[] = [];
    const run = () => runEnglishEditionPass({ db: t.db, now: NOW, cap: 1,
      snapshot: new Map([['primary-only', { title: b.title, author: 'Terry Pratchett', language: 'de' }],
        ['second', { title: 'The Long Mars', author: 'Terry Pratchett', language: 'de' }]]),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async (query) => {
        titles.push(query.title); return { volumeId: 'unproved', title: query.title, language: 'en', authors: ['Different Writer'] };
      } } } });
    expect(await run()).toMatchObject({ due: 2, looked: 1, switched: 0, parked: 0 });
    expect(await run()).toMatchObject({ due: 1, looked: 1, switched: 0, parked: 0 });
    expect(titles).toEqual([b.title, 'The Long Mars']);
    expect(await run()).toMatchObject({ due: 0, looked: 0 });
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
  });
  it('stamps each memo-reused credit refusal without a second provider lookup', async () => {
    const [b] = sources();
    const single = { ...b, heldBooks: [{ title: b.title, author: 'Terry Pratchett', isbn: null }] };
    const first = await want((await seed(single)).id), second = await want((await seed(single)).id);
    let resolves = 0;
    const run = () => runEnglishEditionPass({ db: t.db, now: NOW, cap: 1,
      snapshot: new Map([['primary-only', { title: b.title, author: 'Terry Pratchett', language: 'de' }]]),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async () => {
        resolves += 1; return { volumeId: 'unproved', title: b.title, language: 'en', authors: [] };
      } } } });
    expect(await run()).toMatchObject({ looked: 1, reused: 1, switched: 0, parked: 0 });
    const rows = await t.db.select().from(bookRequests);
    expect(rows.filter(r => [first.id, second.id].includes(r.id)).map(r => r.englishEditionTriedAt)).toEqual([NOW, NOW]);
    expect(await run()).toMatchObject({ due: 0, looked: 0 });
    expect(resolves).toBe(1);
    expect(await t.db.select().from(bookRequestEvents)).toEqual([]);
  });
  it('does not resolve or switch an English edition using only a preserved primary author', async () => {
    const [b] = sources(); const row = await seed(b); const before = await want(row.id);
    let resolves = 0;
    await runEnglishEditionPass({ db: t.db, now: NOW, snapshot: new Map([['primary-only', { title: b.title, author: 'Terry Pratchett', language: 'de' }]]),
      resolver: { consumer: 'pairing', gb: { resolveVolume: async () => { resolves += 1; return { volumeId: 'subset', title: b.title, language: 'en', authors: ['Terry Pratchett'] }; } } } });
    expect((await t.db.select().from(bookRequests).where(eq(bookRequests.id, before.id)))[0]).toEqual(before);
    expect(resolves).toBe(0);
  });
});
