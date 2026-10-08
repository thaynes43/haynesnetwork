// Issue #719 (DESIGN-028 / DESIGN-036 / DESIGN-038 amendments 2026-10-05) — a want whose LazyLibrarian (LL) book is not
// English (the F10 rule) switches to the English edition of the same work, or is parked `no_english_edition` and never
// pushed. Proves, on embedded Postgres 16 with a stub Google Books resolver and a stub LL: the switch (and that it asks
// GB for English by the want's own title and author, never by ISBN), the park, the once-per-quota-day rationing, the
// daily call budget and the breaker (a refusal is not a lookup), another volume or work being refused, a park lifting
// when LL's book is fixed, the pairing and collection wants, the goodreads push guard, and the re-key guard.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  bookRequests,
  booksCollections,
  booksFormatPairs,
  booksPairingReservations,
  booksItems,
  gbCallBudget,
  gbQuotaState,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import {
  LlRekeyIndex,
  acceptEnglishEdition,
  englishEditionOpenFormats,
  forceSearchFindMissingCollections,
  linkIntegration,
  makeGbBudgetTracker,
  runEnglishEditionPass,
  syncBooksCollections,
  syncCollectionWants,
  syncGoodreadsIntegration,
  tripGbQuotaBreaker,
  type CollectionWantsLibretto,
  type EnglishEditionVolume,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '../src';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

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
  await t.db.delete(booksCollections);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
  await t.db.delete(gbQuotaState);
  await t.db.delete(gbCallBudget);
});

const noPace = async () => {};
const DAY = 24 * 60 * 60 * 1000;
// A fixed mid-quota-day instant (the quota-day starts 07:00 UTC), so "later today" and "tomorrow" are unambiguous.
const NOW = new Date('2026-10-06T12:00:00Z');
const LATER_TODAY = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
const TOMORROW = new Date(NOW.getTime() + DAY);

type Row = Partial<LlSnapshotRow>;

/** A stub LazyLibrarian whose snapshot is a real Map (a filler row keeps it non-empty). Records every write. */
function stubLl(rows: Record<string, Row> = {}) {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const snapshot = (): Map<string, LlSnapshotRow> => {
    const map = new Map<string, LlSnapshotRow>([
      ['filler-1', { title: 'Something Else Entirely', author: 'Nobody Here', ebookStatus: 'Open', audioStatus: 'Skipped' }],
    ]);
    for (const [id, r] of Object.entries(rows)) map.set(id, { ...r });
    return map;
  };
  const bundle = {
    write: {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'true';
      },
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: { getAllBookStatuses: async () => snapshot() },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle, snapshot };
}

/** A recording Google Books seam: `answer` is what the next lookup returns (a volume, null = no match, or a throw). */
function stubGb(answer: () => EnglishEditionVolume | null | Error) {
  const queries: Array<{ isbn?: string | null; title: string; author?: string | null; language?: string | null }> = [];
  return {
    queries,
    gb: {
      resolveVolume: async (query: { isbn?: string | null; title: string; author?: string | null; language?: string | null }) => {
        queries.push(query);
        const out = answer();
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

const AZAZEL_EN: EnglishEditionVolume = {
  volumeId: 'en-azazel',
  language: 'en',
  title: 'Azazel',
  subtitle: null,
  authors: ['Isaac Asimov'],
};
const SPANISH_ROW: Row = { title: 'Azazel', author: 'Isaac Asimov', language: 'es', ebookStatus: 'Skipped', audioStatus: 'Wanted' };

let seq = 0;
async function seedGoodreadsRequest(over: Partial<typeof bookRequests.$inferInsert> = {}) {
  const user = await createUser(t.db);
  const { integration } = await linkIntegration({
    db: t.db,
    userId: user.id,
    provider: 'goodreads',
    externalUserId: String(++seq),
    profileRef: String(seq),
    actorId: user.id,
  });
  const [shelf] = await t.db
    .insert(integrationShelfItems)
    .values({
      integrationId: integration.id,
      shelf: 'to-read',
      externalBookId: `gr-${seq}`,
      title: 'Azazel',
      author: 'Isaac Asimov',
      shelvedAt: new Date(),
    })
    .returning({ id: integrationShelfItems.id });
  const [row] = await t.db
    .insert(bookRequests)
    .values({
      integrationId: integration.id,
      shelfItemId: shelf!.id,
      title: 'Azazel',
      author: 'Isaac Asimov',
      llBookId: 'PitFPgAACAAJ',
      ebookStatus: 'missing',
      audioStatus: 'wanted',
      ...over,
    })
    .returning({ id: bookRequests.id });
  return { id: row!.id, integrationId: integration.id, shelfItemId: shelf!.id };
}
const getRequest = async (id: string) => (await t.db.select().from(bookRequests).where(eq(bookRequests.id, id)))[0]!;

const snapshotOf = (rows: Record<string, Row>) => stubLl(rows).snapshot();
const SPANISH_SNAPSHOT = () => snapshotOf({ PitFPgAACAAJ: SPANISH_ROW });

// ---------------------------------------------------------------------------
// The pure pieces.
// ---------------------------------------------------------------------------

describe('acceptEnglishEdition (the volume check)', () => {
  const want = { title: 'Azazel', author: 'Isaac Asimov', llBookId: 'PitFPgAACAAJ' };
  it('accepts the same work in English', () => {
    expect(acceptEnglishEdition(want, AZAZEL_EN)).toEqual({ ok: true });
  });
  it('refuses the id the want already has, and a volume Google Books does not call English', () => {
    expect(acceptEnglishEdition(want, { ...AZAZEL_EN, volumeId: 'PitFPgAACAAJ' })).toEqual({ ok: false, reason: 'same_id' });
    expect(acceptEnglishEdition(want, { ...AZAZEL_EN, language: 'es' })).toEqual({ ok: false, reason: 'not_english' });
  });
  it('refuses another VOLUME of the work (#693): "bk 2" is not book 1', () => {
    expect(
      acceptEnglishEdition(
        { title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas', llBookId: 'es-acotar' },
        { volumeId: 'en-1', language: 'en', title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'] },
      ),
    ).toEqual({ ok: false, reason: 'volume' });
    // The same volume number is fine.
    expect(
      acceptEnglishEdition(
        { title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas', llBookId: 'es-acotar' },
        { volumeId: 'en-2', language: 'en', title: 'A Court of Mist and Fury', subtitle: 'Book 2', authors: ['Sarah J. Maas'] },
      ),
    ).toEqual({ ok: true });
  });
  it('refuses another WORK', () => {
    expect(acceptEnglishEdition(want, { volumeId: 'en-x', language: 'en', title: 'Foundation', authors: ['Isaac Asimov'] })).toEqual({
      ok: false,
      reason: 'work',
    });
  });
});

describe('englishEditionOpenFormats', () => {
  it('a goodreads want with either format landed is left alone; other origins use the formats that have not landed', () => {
    expect(englishEditionOpenFormats({ origin: 'goodreads', ebookStatus: 'missing', audioStatus: 'wanted' })).toEqual(['ebook', 'audiobook']);
    expect(englishEditionOpenFormats({ origin: 'goodreads', ebookStatus: 'landed', audioStatus: 'wanted' })).toEqual([]);
    expect(englishEditionOpenFormats({ origin: 'pairing', ebookStatus: 'landed', audioStatus: 'requested' })).toEqual(['audiobook']);
    expect(englishEditionOpenFormats({ origin: 'collection', ebookStatus: 'landed', audioStatus: 'landed' })).toEqual([]);
  });
});

describe('LlRekeyIndex never re-keys onto a non-English book', () => {
  it('skips a foreign row, so the same title and author cannot pull a switched want back', () => {
    const snapshot = new Map<string, LlSnapshotRow>([
      ['es-azazel', { title: 'Azazel', author: 'Isaac Asimov', language: 'es' }],
      ['en-other', { title: 'Something Else', author: 'Somebody' }],
    ]);
    expect(new LlRekeyIndex(snapshot).find('Azazel', 'Isaac Asimov')).toBeNull();
    snapshot.set('en-azazel', { title: 'Azazel', author: 'Isaac Asimov', language: 'en' });
    expect(new LlRekeyIndex(snapshot).find('Azazel', 'Isaac Asimov')).toBe('en-azazel');
  });
});

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

describe('runEnglishEditionPass — an English edition exists', () => {
  it('switches the request (Azazel) to it by the want\'s own title and author, never by ISBN, and it flows as a new want', async () => {
    const { id } = await seedGoodreadsRequest();
    const gb = stubGb(() => AZAZEL_EN);

    const report = await runEnglishEditionPass({
      db: t.db,
      snapshot: SPANISH_SNAPSHOT(),
      resolver: { gb: gb.gb, consumer: 'goodreads' },
      now: NOW,
    });

    expect(report).toMatchObject({ due: 1, looked: 1, switched: 1, parked: 0 });
    expect(gb.queries).toEqual([{ title: 'Azazel', author: 'Isaac Asimov', language: 'en' }]);
    const row = await getRequest(id);
    expect(row).toMatchObject({
      llBookId: 'en-azazel',
      ebookStatus: 'requested',
      audioStatus: 'requested',
      unroutableReason: null,
    });
    expect(row.englishEditionTriedAt).not.toBeNull();
  });

  it('then the existing push takes it: addBook, queueBook both formats, searchBook on the ENGLISH id only', async () => {
    const { id, integrationId, shelfItemId } = await seedGoodreadsRequest();
    const gb = stubGb(() => AZAZEL_EN);
    await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });

    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    const items: EnrichedShelfItem[] = [
      {
        shelf: 'to-read',
        externalBookId: 'gr-azazel',
        title: 'Azazel',
        author: 'Isaac Asimov',
        isbn: null,
        // The shelf mirror still carries the Spanish volume Google Books resolved first: the request's own id wins.
        gbVolumeId: 'PitFPgAACAAJ',
        coverUrl: null,
        shelvedAt: new Date(),
        isComic: false,
      },
    ];
    // Point the seeded shelf row at the same external id so the sync's upsert finds the existing request.
    await t.db.update(integrationShelfItems).set({ externalBookId: 'gr-azazel' }).where(eq(integrationShelfItems.id, shelfItemId));
    const sync = await syncGoodreadsIntegration({
      db: t.db,
      integrationId,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
      now: LATER_TODAY,
    });

    expect(sync.requestsPushed).toBe(1);
    expect(ll.calls.filter((c) => c.id === 'PitFPgAACAAJ')).toEqual([]);
    expect(ll.calls.map((c) => `${c.cmd}:${c.id}`)).toEqual(
      expect.arrayContaining(['addBook:en-azazel', 'queueBook:en-azazel', 'searchBook:en-azazel']),
    );
    expect(await getRequest(id)).toMatchObject({ llBookId: 'en-azazel', ebookStatus: 'wanted', audioStatus: 'wanted' });
  });
});

describe('runEnglishEditionPass — no English edition', () => {
  it('parks the request `no_english_edition` (open formats settle missing), stamps the lookup, and never pushes it', async () => {
    const { id, integrationId, shelfItemId } = await seedGoodreadsRequest();
    const gb = stubGb(() => null);

    const report = await runEnglishEditionPass({
      db: t.db,
      snapshot: SPANISH_SNAPSHOT(),
      resolver: { gb: gb.gb, consumer: 'goodreads' },
      now: NOW,
    });

    expect(report).toMatchObject({ looked: 1, switched: 0, parked: 1 });
    expect(await getRequest(id)).toMatchObject({
      llBookId: 'PitFPgAACAAJ',
      unroutableReason: 'no_english_edition',
      ebookStatus: 'missing',
      audioStatus: 'missing',
    });

    // The sync keeps the park (it recomputes unroutable_reason each run) and pushes nothing for the parked want.
    await t.db.update(integrationShelfItems).set({ externalBookId: 'gr-azazel' }).where(eq(integrationShelfItems.id, shelfItemId));
    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId,
      items: [
        { shelf: 'to-read', externalBookId: 'gr-azazel', title: 'Azazel', author: 'Isaac Asimov', isbn: null, gbVolumeId: 'PitFPgAACAAJ', coverUrl: null, shelvedAt: new Date(), isComic: false },
      ],
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
      now: LATER_TODAY,
    });
    expect(ll.calls).toEqual([]);
    expect(await getRequest(id)).toMatchObject({ unroutableReason: 'no_english_edition', ebookStatus: 'missing' });
  });

  it('refuses a found edition that is another volume (parks instead of switching)', async () => {
    const { id } = await seedGoodreadsRequest({ title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas', llBookId: 'es-acotar' });
    const gb = stubGb(() => ({ volumeId: 'en-1', language: 'en', title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'] }));

    const report = await runEnglishEditionPass({
      db: t.db,
      snapshot: snapshotOf({ 'es-acotar': { title: 'Una corte de rosas y espinas', author: 'Sarah J. Maas', language: 'es' } }),
      resolver: { gb: gb.gb, consumer: 'goodreads' },
      now: NOW,
    });

    expect(report).toMatchObject({ looked: 1, switched: 0, parked: 1 });
    expect(await getRequest(id)).toMatchObject({ llBookId: 'es-acotar', unroutableReason: 'no_english_edition' });
  });

  it('refuses an edition Google Books reports as non-English', async () => {
    const { id } = await seedGoodreadsRequest();
    const gb = stubGb(() => ({ ...AZAZEL_EN, language: 'fr' }));
    const report = await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(report).toMatchObject({ switched: 0, parked: 1 });
    expect((await getRequest(id)).unroutableReason).toBe('no_english_edition');
  });
});

describe('runEnglishEditionPass — rationing', () => {
  it('looks once per request per quota-day, whatever the answer; a park looks again after a week of quota-days', async () => {
    const { id } = await seedGoodreadsRequest();
    const gb = stubGb(() => null);
    const run = (now: Date) =>
      runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now });

    await run(NOW);
    expect(gb.queries).toHaveLength(1);
    // The same quota-day (hours later, and even right after the 07:00 reset boundary's day began): no second lookup.
    const again = await run(LATER_TODAY);
    expect(again).toMatchObject({ due: 0, looked: 0 });
    expect(gb.queries).toHaveLength(1);
    // A park does not retry the next quota-day (a work with no edition today almost never has one tomorrow): it waits a
    // week of them, then looks once more.
    expect(await run(TOMORROW)).toMatchObject({ due: 0, looked: 0 });
    expect(await run(new Date(NOW.getTime() + 6 * DAY))).toMatchObject({ due: 0, looked: 0 });
    expect(gb.queries).toHaveLength(1);
    const next = await run(new Date(NOW.getTime() + 7 * DAY));
    expect(next).toMatchObject({ due: 1, looked: 1, parked: 1 });
    expect(gb.queries).toHaveLength(2);
    expect((await getRequest(id)).unroutableReason).toBe('no_english_edition');
  });

  it('a failed lookup is stamped too (not retried every run) and changes nothing else', async () => {
    const { id } = await seedGoodreadsRequest();
    const gb = stubGb(() => new Error('GB 503'));
    const run = (now: Date) =>
      runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now });
    expect(await run(NOW)).toMatchObject({ looked: 1, failed: 1, parked: 0 });
    expect(await run(LATER_TODAY)).toMatchObject({ due: 0 });
    expect(gb.queries).toHaveLength(1);
    expect(await getRequest(id)).toMatchObject({ llBookId: 'PitFPgAACAAJ', unroutableReason: null, ebookStatus: 'missing', audioStatus: 'wanted' });
  });

  it('the daily call budget gates the lookup: no GB call, nothing stamped, and it runs once there is room', async () => {
    const { id } = await seedGoodreadsRequest();
    const gb = stubGb(() => AZAZEL_EN);
    // A slice too small to afford a whole resolve (reserve 4) refuses before the call.
    const tight = await makeGbBudgetTracker({ db: t.db, consumer: 'goodreads', now: NOW, budgetOverride: 3 });
    const refused = await runEnglishEditionPass({
      db: t.db,
      snapshot: SPANISH_SNAPSHOT(),
      resolver: { gb: gb.gb, consumer: 'goodreads', budget: tight },
      now: NOW,
    });
    expect(refused).toMatchObject({ due: 1, looked: 0, skippedBudget: 1, switched: 0 });
    expect(gb.queries).toHaveLength(0);
    expect((await getRequest(id)).englishEditionTriedAt).toBeNull();

    const roomy = await makeGbBudgetTracker({ db: t.db, consumer: 'goodreads', now: NOW, budgetOverride: 200 });
    const ok = await runEnglishEditionPass({
      db: t.db,
      snapshot: SPANISH_SNAPSHOT(),
      resolver: { gb: gb.gb, consumer: 'goodreads', budget: roomy },
      now: NOW,
    });
    expect(ok).toMatchObject({ looked: 1, switched: 1, skippedBudget: 0 });
  });

  it('charges the lookup\'s legs to the budget through the meter', async () => {
    await seedGoodreadsRequest();
    let taken = 0;
    const meter = { onCall: () => void (taken += 1), taken: () => taken };
    const gb = {
      resolveVolume: async () => {
        meter.onCall();
        meter.onCall();
        return AZAZEL_EN;
      },
    };
    const budget = await makeGbBudgetTracker({ db: t.db, consumer: 'goodreads', now: NOW, budgetOverride: 200 });
    await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb, consumer: 'goodreads', budget, meter }, now: NOW });
    expect(budget.used()).toBe(2);
    const [row] = await t.db.select().from(gbCallBudget);
    expect(row?.goodreadsCalls).toBe(2);
  });

  it('an open quota breaker is not a lookup: no GB call, nothing stamped', async () => {
    const { id } = await seedGoodreadsRequest();
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily', now: NOW });
    const gb = stubGb(() => AZAZEL_EN);
    const report = await runEnglishEditionPass({
      db: t.db,
      snapshot: SPANISH_SNAPSHOT(),
      resolver: { gb: gb.gb, consumer: 'goodreads' },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(report).toMatchObject({ looked: 0, skippedQuota: 1, switched: 0 });
    expect(gb.queries).toHaveLength(0);
    expect((await getRequest(id)).englishEditionTriedAt).toBeNull();
  });

  it('caps the lookups per run and resumes with the rest', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await seedGoodreadsRequest({ llBookId: `es-${i}`, title: `Book ${i}` })).id);
    }
    const snap = snapshotOf({
      'es-0': { title: 'Libro 0', author: 'Isaac Asimov', language: 'es' },
      'es-1': { title: 'Libro 1', author: 'Isaac Asimov', language: 'es' },
      'es-2': { title: 'Libro 2', author: 'Isaac Asimov', language: 'es' },
    });
    const gb = stubGb(() => null);
    const first = await runEnglishEditionPass({ db: t.db, snapshot: snap, resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW, cap: 2 });
    expect(first).toMatchObject({ due: 3, looked: 2, skippedCap: 1 });
    const second = await runEnglishEditionPass({ db: t.db, snapshot: snap, resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW, cap: 2 });
    expect(second).toMatchObject({ due: 1, looked: 1 });
  });
});

describe('runEnglishEditionPass — one lookup per work per run', () => {
  it('a goodreads want and a pairing want for the same work share ONE Google Books lookup', async () => {
    const goodreads = await seedGoodreadsRequest();
    const [anchor] = await t.db
      .insert(booksItems)
      .values({ source: 'audiobookshelf', mediaKind: 'audiobook', externalId: `abs-${++seq}`, libraryId: '1', libraryName: 'L', title: 'Azazel', sortTitle: 'azazel', author: 'Isaac Asimov', deepLinkUrl: 'http://x' })
      .returning({ id: booksItems.id });
    const [pairing] = await t.db
      .insert(bookRequests)
      .values({ origin: 'pairing', pairingBooksItemId: anchor!.id, title: 'Azazel', author: 'Isaac Asimov', llBookId: 'PitFPgAACAAJ', ebookStatus: 'requested', audioStatus: 'landed', unroutableReason: 'foreign_language' })
      .returning({ id: bookRequests.id });
    const gb = stubGb(() => AZAZEL_EN);
    const report = await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(report).toMatchObject({ due: 2, looked: 1, reused: 1, switched: 2 });
    expect(gb.queries).toHaveLength(1);
    expect((await getRequest(goodreads.id)).llBookId).toBe('en-azazel');
    expect(await getRequest(pairing!.id)).toMatchObject({ llBookId: 'en-azazel', unroutableReason: null });
  });

  it('once the budget refuses, a want an answer in hand covers is still settled, the rest wait', async () => {
    await seedGoodreadsRequest({ llBookId: 'es-a' });
    await seedGoodreadsRequest({ llBookId: 'es-a2' });
    await seedGoodreadsRequest({ llBookId: 'es-b', title: 'Foundation' });
    const snap = snapshotOf({
      'es-a': { title: 'Azazel', author: 'Isaac Asimov', language: 'es' },
      'es-a2': { title: 'Azazel', author: 'Isaac Asimov', language: 'es' },
      'es-b': { title: 'Fundacion', author: 'Isaac Asimov', language: 'es' },
    });
    const gb = stubGb(() => null);
    const report = await runEnglishEditionPass({ db: t.db, snapshot: snap, resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW, cap: 1 });
    // One lookup (Azazel); the second Azazel want is answered from it; Foundation waits for the cap.
    expect(report).toMatchObject({ due: 3, looked: 1, reused: 1, parked: 2, skippedCap: 1 });
  });
});

describe('runEnglishEditionPass — what it leaves alone', () => {
  const run = (snapshot: Map<string, LlSnapshotRow>, gb: ReturnType<typeof stubGb>) =>
    runEnglishEditionPass({ db: t.db, snapshot, resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });

  it('an English or unknown LazyLibrarian book, a missing book, an empty snapshot', async () => {
    await seedGoodreadsRequest({ llBookId: 'en-1' });
    await seedGoodreadsRequest({ llBookId: 'unk-1' });
    await seedGoodreadsRequest({ llBookId: 'gone-1' });
    const gb = stubGb(() => AZAZEL_EN);
    const report = await run(
      snapshotOf({ 'en-1': { title: 'Azazel', language: 'en-US' }, 'unk-1': { title: 'Azazel', language: 'Unknown' } }),
      gb,
    );
    expect(report.due).toBe(0);
    expect(await run(new Map(), gb)).toMatchObject({ due: 0 });
    expect(gb.queries).toHaveLength(0);
  });

  it('a goodreads want with a landed format, a comic, a library match', async () => {
    await seedGoodreadsRequest({ ebookStatus: 'landed' });
    await seedGoodreadsRequest({ comicStatus: 'wanted', ebookStatus: 'missing', audioStatus: 'missing' });
    const [item] = await t.db
      .insert(booksItems)
      .values({ source: 'kavita', mediaKind: 'book', externalId: 'm-1', libraryId: '1', libraryName: 'L', title: 'Azazel', sortTitle: 'azazel', author: 'Isaac Asimov', deepLinkUrl: 'http://x' })
      .returning({ id: booksItems.id });
    await seedGoodreadsRequest({ matchedBooksItemId: item!.id, ebookStatus: 'landed', audioStatus: 'landed' });
    const gb = stubGb(() => AZAZEL_EN);
    expect(await run(SPANISH_SNAPSHOT(), gb)).toMatchObject({ due: 0 });
    expect(gb.queries).toHaveLength(0);
  });

  it('a different park (`wrong_volume`)', async () => {
    await seedGoodreadsRequest({ unroutableReason: 'wrong_volume' });
    const gb = stubGb(() => AZAZEL_EN);
    expect(await run(SPANISH_SNAPSHOT(), gb)).toMatchObject({ due: 0 });
  });
});

describe('runEnglishEditionPass — a park lifts when LazyLibrarian\'s book is fixed', () => {
  it('no_english_edition → ordinary (goodreads missing formats return to requested), free of the lookup stamp', async () => {
    const { id } = await seedGoodreadsRequest({
      unroutableReason: 'no_english_edition',
      ebookStatus: 'missing',
      audioStatus: 'missing',
      englishEditionTriedAt: NOW,
    });
    const gb = stubGb(() => AZAZEL_EN);
    const report = await runEnglishEditionPass({
      db: t.db,
      snapshot: snapshotOf({ PitFPgAACAAJ: { ...SPANISH_ROW, language: 'en' } }),
      resolver: { gb: gb.gb, consumer: 'goodreads' },
      now: LATER_TODAY,
    });
    expect(report).toMatchObject({ lifted: 1, looked: 0 });
    expect(await getRequest(id)).toMatchObject({
      unroutableReason: null,
      ebookStatus: 'requested',
      audioStatus: 'requested',
      englishEditionTriedAt: null,
    });
    expect(gb.queries).toHaveLength(0);
  });
});

describe('runEnglishEditionPass — pairing and collection wants', () => {
  async function seedAnchor(language: string | null) {
    const [item] = await t.db
      .insert(booksItems)
      .values({
        source: 'audiobookshelf',
        mediaKind: 'audiobook',
        externalId: `abs-${++seq}`,
        libraryId: '1',
        libraryName: 'L',
        title: 'Azazel',
        sortTitle: 'azazel',
        author: 'Isaac Asimov',
        deepLinkUrl: 'http://x',
        ...(language ? { attrs: { language } } : {}),
      })
      .returning({ id: booksItems.id });
    return item!.id;
  }
  const seedPairing = (anchorId: string, over: Partial<typeof bookRequests.$inferInsert> = {}) =>
    t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchorId,
        title: 'Azazel',
        author: 'Isaac Asimov',
        llBookId: 'PitFPgAACAAJ',
        ebookStatus: 'requested',
        audioStatus: 'landed',
        ...over,
      })
      .returning({ id: bookRequests.id })
      .then((r) => r[0]!.id);

  it('a pairing want parked `foreign_language` on the BOOK (anchor reads English) switches: the missing format returns to requested', async () => {
    const anchor = await seedAnchor('English');
    const id = await seedPairing(anchor, { unroutableReason: 'foreign_language' });
    const gb = stubGb(() => AZAZEL_EN);
    const report = await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(report.switched).toBe(1);
    expect(await getRequest(id)).toMatchObject({
      llBookId: 'en-azazel',
      unroutableReason: null,
      ebookStatus: 'requested',
      audioStatus: 'landed',
    });
  });

  it('a pairing want whose ANCHOR is itself foreign is not an edition problem: untouched', async () => {
    const anchor = await seedAnchor('es');
    const id = await seedPairing(anchor, { unroutableReason: 'foreign_language' });
    const gb = stubGb(() => AZAZEL_EN);
    expect(await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW })).toMatchObject({ due: 0 });
    expect(await getRequest(id)).toMatchObject({ llBookId: 'PitFPgAACAAJ', unroutableReason: 'foreign_language' });
  });

  it('a pairing want with no English edition parks `no_english_edition` and keeps its working status', async () => {
    const anchor = await seedAnchor(null);
    const id = await seedPairing(anchor);
    const gb = stubGb(() => null);
    const report = await runEnglishEditionPass({ db: t.db, snapshot: SPANISH_SNAPSHOT(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(report.parked).toBe(1);
    expect(await getRequest(id)).toMatchObject({ unroutableReason: 'no_english_edition', ebookStatus: 'requested', audioStatus: 'landed' });
  });

  it.each(['reserved', 'unread', 'reserved_park_fixed'] as const)('preserves an audio pairing request during %s ebook uncertainty in the separate English-edition pass', async (state) => {
    const anchor = await seedAnchor('English');
    const [book] = await t.db.insert(booksItems).values({
      source: 'kavita', mediaKind: 'book', externalId: `uncertain-${++seq}`,
      libraryId: '1', libraryName: 'Books', title: 'Unread counterpart', sortTitle: 'unread counterpart',
      author: 'Isaac Asimov', deepLinkUrl: 'http://x',
      attrs: state === 'unread' ? {} : { heldBooks: [{ title: null, author: null, isbn: null }] },
    }).returning();
    if (state !== 'unread') await t.db.insert(booksPairingReservations).values({ bookItemId: book!.id, audioItemId: anchor });
    const id = await seedPairing(anchor, state === 'reserved_park_fixed' ? { unroutableReason: 'no_english_edition' } : {});
    const before = await getRequest(id);
    const gb = stubGb(() => AZAZEL_EN);
    const snapshot = state === 'reserved_park_fixed' ? snapshotOf({ PitFPgAACAAJ: { ...SPANISH_ROW, language: 'en' } }) : SPANISH_SNAPSHOT();
    const warnings: Record<string, unknown>[] = [];
    const run = (now: Date) => runEnglishEditionPass({ db: t.db, snapshot, resolver: { gb: gb.gb, consumer: 'goodreads' }, now, log: { warn: (_message, data) => { warnings.push(data!); } } });
    expect(await run(NOW)).toMatchObject({ due: 0, switched: 0, parked: 0, lifted: 0 });
    expect(await run(TOMORROW)).toMatchObject({ due: 0, switched: 0, parked: 0, lifted: 0 });
    expect(gb.queries).toEqual([]);
    expect(await getRequest(id)).toEqual(before);
    expect(warnings.at(-1)).toMatchObject({ deferredRequestCount: 1, deferredRequestIds: [id] });
  });

  it('lands verified existing-request coverage without rekeying a deferred audio pairing request', async () => {
    const anchor = await seedAnchor('English');
    const [book] = await t.db.insert(booksItems).values({ source: 'kavita', mediaKind: 'book', externalId: `unknown-${++seq}`, libraryId: '1', libraryName: 'Books', title: 'Unread', sortTitle: 'unread', author: 'Isaac Asimov', deepLinkUrl: 'http://x', attrs: {} }).returning();
    await t.db.insert(booksPairingReservations).values({ bookItemId: book!.id, audioItemId: anchor });
    const id = await seedPairing(anchor);
    const gb = stubGb(() => AZAZEL_EN);
    const snapshot = snapshotOf({ PitFPgAACAAJ: SPANISH_ROW, 'held-english': { title: 'Azazel', author: 'Isaac Asimov', language: 'en', ebookStatus: 'Open' } });
    expect(await runEnglishEditionPass({ db: t.db, snapshot, resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW })).toMatchObject({ due: 0, switched: 0 });
    expect(gb.queries).toEqual([]);
    expect(await getRequest(id)).toMatchObject({ llBookId: 'PitFPgAACAAJ', ebookStatus: 'landed', audioStatus: 'landed', englishEditionTriedAt: null });
  });

  async function seedCollection() {
    await syncBooksCollections({
      db: t.db,
      collections: [
        { source: 'kavita', externalId: 'asimov', kind: 'collection', libraryId: null, title: 'Asimov', itemCount: 0, ordered: false, createdBy: 'libretto', librettoRecipeId: 'recipe-asimov', category: null, members: [], fullyRead: true },
      ],
      scopedFamilies: [],
    });
    const [row] = await t.db
      .select({ id: booksCollections.id })
      .from(booksCollections)
      .where(and(eq(booksCollections.externalId, 'asimov'), eq(booksCollections.kind, 'collection')));
    await syncCollectionWants({
      db: t.db,
      collectionId: row!.id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:azazel', title: 'Azazel', author: 'Isaac Asimov', llBookId: 'PitFPgAACAAJ' }],
    });
    return row!.id;
  }
  const wantOf = async (collectionId: string) =>
    (await t.db.select().from(bookRequests).where(eq(bookRequests.collectionId, collectionId)))[0]!;

  it('a collection want switches too, and the force-search then queues the ENGLISH book, never the Spanish one', async () => {
    const colId = await seedCollection();
    const gb = stubGb(() => AZAZEL_EN);
    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    await runEnglishEditionPass({ db: t.db, snapshot: ll.snapshot(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(await wantOf(colId)).toMatchObject({ llBookId: 'en-azazel', unroutableReason: null, ebookStatus: 'requested' });

    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({ recipes: [{ id: 'recipe-asimov', builder: { type: 'x', ref: 'x' }, variables: { acquisitionEnabled: true } }], issues: [] }),
      } as unknown as CollectionWantsLibretto,
      ll: ll.bundle,
      pacer: noPace,
      now: LATER_TODAY,
    });
    expect(report.searched).toBe(1);
    expect(ll.calls.filter((c) => c.id === 'PitFPgAACAAJ')).toEqual([]);
    expect(ll.calls.map((c) => `${c.cmd}:${c.id}`)).toContain('searchBook:en-azazel');
  });

  it('a switched collection want is never settled `missing` by the gone pass before the English book is searched', async () => {
    const colId = await seedCollection();
    // The Spanish book was force-searched two hours ago: left stamped, the English id (not in LazyLibrarian yet) would
    // read as a book LazyLibrarian lost once the 1 h collection grace ran out.
    await t.db.update(bookRequests).set({ lastSearchedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }).where(eq(bookRequests.collectionId, colId));
    const gb = stubGb(() => AZAZEL_EN);
    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    await runEnglishEditionPass({ db: t.db, snapshot: ll.snapshot(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect((await wantOf(colId)).lastSearchedAt).toBeNull();

    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({ recipes: [{ id: 'recipe-asimov', builder: { type: 'x', ref: 'x' }, variables: { acquisitionEnabled: true } }], issues: [] }),
      } as unknown as CollectionWantsLibretto,
      ll: ll.bundle,
      pacer: noPace,
      now: LATER_TODAY,
    });
    expect(report.llGoneSettled).toBe(0);
    expect(report.searched).toBe(1);
    expect(await wantOf(colId)).toMatchObject({ llBookId: 'en-azazel', ebookStatus: 'requested' });
    expect(ll.calls.map((c) => `${c.cmd}:${c.id}`)).toContain('searchBook:en-azazel');
  });

  it('the collection force-search never queues a book LazyLibrarian labels non-English (before the pass has run)', async () => {
    const colId = await seedCollection();
    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({ recipes: [{ id: 'recipe-asimov', builder: { type: 'x', ref: 'x' }, variables: { acquisitionEnabled: true } }], issues: [] }),
      } as unknown as CollectionWantsLibretto,
      ll: ll.bundle,
      pacer: noPace,
      now: NOW,
    });
    expect(report).toMatchObject({ skippedForeign: 1, searched: 0 });
    expect(ll.calls).toEqual([]);
    expect((await wantOf(colId)).lastSearchedAt).not.toBeNull();
  });

  // Issue #794 (DESIGN-028 amendment 2026-10-06): LazyLibrarian labels a book's language only once addBook has seated it,
  // so a book it did not hold is read again before anything is queued. The live case: want 76848581, "Crescent City - La
  // casa di terra e sangue", seated as LazyLibrarian `LgDwDwAAQBAJ` (`it`) and queued and searched on 2026-10-06.
  /** A LazyLibrarian that does not hold the book until addBook seats it with `language`; `failReadAfterSeat` breaks reads after. */
  function seatingLl(language: string | null, opts: { failReadAfterSeat?: boolean } = {}) {
    const ll = stubLl({});
    let seated = false;
    const bundle = {
      write: {
        ...ll.bundle.write,
        addBook: async (id: string) => {
          seated = true;
          return ll.bundle.write.addBook(id);
        },
      },
      read: {
        getAllBookStatuses: async () => {
          if (seated && opts.failReadAfterSeat) throw new Error('LL down');
          const map = ll.snapshot();
          if (seated) {
            map.set('PitFPgAACAAJ', { title: 'Azazel', author: 'Isaac Asimov', language, ebookStatus: 'Skipped', audioStatus: 'Skipped' });
          }
          return map;
        },
      },
    } as unknown as LazyLibrarianClientBundle;
    return { calls: ll.calls, bundle };
  }
  const findMissing = (ll: LazyLibrarianClientBundle, now: Date) =>
    forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({ recipes: [{ id: 'recipe-asimov', builder: { type: 'x', ref: 'x' }, variables: { acquisitionEnabled: true } }], issues: [] }),
      } as unknown as CollectionWantsLibretto,
      ll,
      pacer: noPace,
      now,
    });
  const searchAudits = () =>
    t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'request_book_search'));

  it('the collection force-search leaves a book its own addBook seats as non-English as seated: no queueBook, no searchBook', async () => {
    const colId = await seedCollection();
    const ll = seatingLl('it');
    const report = await findMissing(ll.bundle, NOW);
    expect(report).toMatchObject({ skippedForeign: 1, searched: 0, failed: 0, skippedHeld: 0 });
    expect(ll.calls).toEqual([{ cmd: 'addBook', id: 'PitFPgAACAAJ' }]);
    // Stamped (the cooldown keeps it out of the next run), not audited (nothing was asked of LazyLibrarian), still open.
    expect(await wantOf(colId)).toMatchObject({ lastSearchedAt: NOW, ebookStatus: 'requested', llBookId: 'PitFPgAACAAJ' });
    expect(await searchAudits()).toEqual([]);

    // Once the cooldown has run out, the book is in the snapshot and the check before the push skips it: no second add.
    const later = await findMissing(ll.bundle, new Date(NOW.getTime() + DAY));
    expect(later).toMatchObject({ skippedForeign: 1, searched: 0 });
    expect(ll.calls).toEqual([{ cmd: 'addBook', id: 'PitFPgAACAAJ' }]);
  });

  it('a book the force-search seats as English is queued and searched as before', async () => {
    const colId = await seedCollection();
    const ll = seatingLl('en');
    const report = await findMissing(ll.bundle, NOW);
    expect(report).toMatchObject({ skippedForeign: 0, searched: 1, failed: 0 });
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'PitFPgAACAAJ' },
      { cmd: 'queueBook', id: 'PitFPgAACAAJ', format: 'ebook' },
      { cmd: 'searchBook', id: 'PitFPgAACAAJ', format: 'ebook' },
    ]);
    expect((await wantOf(colId)).lastSearchedAt).toEqual(NOW);
    expect(await searchAudits()).toHaveLength(1);
  });

  it('a failed read after the seat is unknown, so the force-search goes on (the guard only withholds a write)', async () => {
    await seedCollection();
    const ll = seatingLl('it', { failReadAfterSeat: true });
    const report = await findMissing(ll.bundle, NOW);
    expect(report).toMatchObject({ skippedForeign: 0, searched: 1, failed: 0 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
  });

  it('a parked collection want is out of the force-search', async () => {
    const colId = await seedCollection();
    const gb = stubGb(() => null);
    const ll = stubLl({ PitFPgAACAAJ: SPANISH_ROW });
    await runEnglishEditionPass({ db: t.db, snapshot: ll.snapshot(), resolver: { gb: gb.gb, consumer: 'goodreads' }, now: NOW });
    expect(await wantOf(colId)).toMatchObject({ unroutableReason: 'no_english_edition', llBookId: 'PitFPgAACAAJ' });
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({ recipes: [{ id: 'recipe-asimov', builder: { type: 'x', ref: 'x' }, variables: { acquisitionEnabled: true } }], issues: [] }),
      } as unknown as CollectionWantsLibretto,
      ll: ll.bundle,
      pacer: noPace,
      now: LATER_TODAY,
    });
    expect(report.candidates).toBe(0);
    expect(ll.calls).toEqual([]);
  });
});

describe('goodreads-sync push — never queues a non-English LazyLibrarian book', () => {
  const items: EnrichedShelfItem[] = [
    { shelf: 'to-read', externalBookId: 'gr-azazel', title: 'Azazel', author: 'Isaac Asimov', isbn: null, gbVolumeId: 'PitFPgAACAAJ', coverUrl: null, shelvedAt: new Date(), isComic: false },
  ];
  async function integration() {
    const user = await createUser(t.db);
    return (await linkIntegration({ db: t.db, userId: user.id, provider: 'goodreads', externalUserId: '1', profileRef: '1', actorId: user.id })).integration;
  }

  it('a book LazyLibrarian already holds as Spanish is not pushed (the English-edition pass takes it)', async () => {
    const integ = await integration();
    const ll = stubLl({ PitFPgAACAAJ: { ...SPANISH_ROW, ebookStatus: 'Skipped', audioStatus: 'Skipped' } });
    const report = await syncGoodreadsIntegration({ db: t.db, integrationId: integ.id, items, syncedShelves: ['to-read'], ll: ll.bundle, pacer: noPace, now: NOW });
    expect(report).toMatchObject({ requestsMinted: 1, requestsPushed: 0, pushesSkippedForeign: 1 });
    expect(ll.calls).toEqual([]);
    const [row] = await t.db.select().from(bookRequests);
    // The reconcile in the same run reads LazyLibrarian's `Skipped` as `missing`; nothing was queued.
    expect(row).toMatchObject({ llBookId: 'PitFPgAACAAJ', ebookStatus: 'missing', audioStatus: 'missing' });
  });

  it('a book the push\'s own addBook seats as Spanish is left as seated: no queueBook, no searchBook', async () => {
    const integ = await integration();
    // LL does not hold it before the push; once addBook has run, the read-back shows it as Spanish.
    const ll = stubLl({});
    let seated = false;
    const bundle = {
      write: {
        ...ll.bundle.write,
        addBook: async (id: string) => {
          seated = true;
          return ll.bundle.write.addBook(id);
        },
      },
      read: {
        getAllBookStatuses: async () => {
          const map = ll.snapshot();
          if (seated) map.set('PitFPgAACAAJ', { ...SPANISH_ROW, ebookStatus: 'Skipped', audioStatus: 'Skipped' });
          return map;
        },
      },
    } as unknown as LazyLibrarianClientBundle;
    const report = await syncGoodreadsIntegration({ db: t.db, integrationId: integ.id, items, syncedShelves: ['to-read'], ll: bundle, pacer: noPace, now: NOW });
    expect(report).toMatchObject({ requestsPushed: 0, pushesSkippedForeign: 1 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook']);
    const [row] = await t.db.select().from(bookRequests);
    expect(row).toMatchObject({ ebookStatus: 'missing', audioStatus: 'missing' });
  });
});
