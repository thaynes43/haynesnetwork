// PLAN-029 (ADR-051/052/053, DESIGN-026) — the DATA/DOMAIN API surface: the library.preferences
// pair (own-row), the released_at sort (NULLS-LAST), and the per-user watch/read facets (viewer-scoped,
// under the ADR-047 access gate — an admin caller is unrestricted so the gate is a no-op here). PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  syncBooks,
  upsertMediaMetadataBatch,
  upsertUserBookProgressBatch,
  upsertUserMediaWatchBatch,
  type BooksItemInput,
} from '@hnet/domain';
import { booksItems } from '@hnet/db/schema';
import { eq } from 'drizzle-orm';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let tdb: TestDb;
let api: Caller; // admin — unrestricted access gate + books/ledger access
let adminUserId: string;

const idsByTitle = (items: Array<{ id: string; title: string }>) => items.map((i) => i.title);

beforeAll(async () => {
  tdb = await bootMigratedDb();
  const admin = await createUser(tdb.db, { admin: true, email: 'lib-admin@example.com' });
  adminUserId = admin.id;
  api = caller(makeCtx(tdb.db, sessionUser(admin)));

  // Three released movies + one date-less (null released_at → NULLS LAST).
  const mk = async (title: string, releasedAt: Date | null) => {
    const item = await seedMediaItem(tdb.db, 'radarr', { title, sortTitle: title.toLowerCase() });
    await upsertMediaMetadataBatch({ db: tdb.db, rows: [{ mediaItemId: item.id, releasedAt }] });
    return item.id;
  };
  await mk('Oldest', new Date('2000-01-01T00:00:00Z'));
  await mk('Middle', new Date('2010-06-15T00:00:00Z'));
  const newestId = await mk('Newest', new Date('2022-12-31T00:00:00Z'));
  await mk('NoDate', null);

  // Seed the caller's per-user watch on 'Newest' (watched).
  await upsertUserMediaWatchBatch({
    db: tdb.db,
    rows: [
      { mediaItemId: newestId, appUserId: adminUserId, playCount: 1, lastViewedAt: new Date(), watched: true, inProgress: false },
    ],
  });

  // Two audiobooks: one with a precise released_at + a per-user finished read; one date-less.
  const ab = (externalId: string, title: string, releasedAt: Date | null): BooksItemInput => ({
    source: 'audiobookshelf',
    mediaKind: 'audiobook',
    externalId,
    libraryId: 'lib1',
    libraryName: 'Audio Books',
    title,
    sortTitle: title.toLowerCase(),
    author: 'A',
    narrator: null,
    seriesName: null,
    year: releasedAt ? releasedAt.getUTCFullYear() : null,
    releasedAt,
    genres: [],
    coverRef: null,
    deepLinkUrl: `https://abs.example.com/item/${externalId}`,
    pageCount: null,
    wordCount: null,
    durationSeconds: 3600,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
  });
  await syncBooks({
    db: tdb.db,
    rows: [ab('ab-new', 'AudioNew', new Date('2021-01-01T00:00:00Z')), ab('ab-nodate', 'AudioNoDate', null)],
    syncedSources: ['audiobookshelf'],
  });
  const [abNew] = await tdb.db
    .select({ id: booksItems.id })
    .from(booksItems)
    .where(eq(booksItems.externalId, 'ab-new'));
  await upsertUserBookProgressBatch({
    db: tdb.db,
    rows: [{ booksItemId: abNew!.id, appUserId: adminUserId, isFinished: true, progress: 1, inProgress: false }],
  });
});

afterAll(async () => {
  await tdb?.stop();
});

describe('library.preferences (ADR-052 / DESIGN-026 D-06) — own-row get/set', () => {
  it('get on an unset wall returns the R2/R6 default (source: default)', async () => {
    const pref = await api.library.preferences.get({ wall: 'movies' });
    expect(pref).toMatchObject({ wall: 'movies', view: 'flat', source: 'default' });
  });

  it('set persists and a later get reads it back (source: stored)', async () => {
    const set = await api.library.preferences.set({
      wall: 'movies',
      view: 'grouped',
      groupBy: 'decade',
      sortField: 'released_at',
      sortDir: 'desc',
    });
    expect(set).toMatchObject({ wall: 'movies', view: 'grouped', groupBy: 'decade', source: 'stored' });
    const got = await api.library.preferences.get({ wall: 'movies' });
    expect(got).toMatchObject({ view: 'grouped', sortField: 'released_at', source: 'stored' });
  });

  it('getAll returns every wall (stored merged over defaults)', async () => {
    const all = await api.library.preferences.getAll();
    expect(all).toHaveLength(8);
    expect(all.find((w) => w.wall === 'movies')).toMatchObject({ source: 'stored' });
    expect(all.find((w) => w.wall === 'tv')).toMatchObject({ view: 'hierarchy', source: 'default' });
  });

  it('a preference is per-user (another member sees only defaults)', async () => {
    const member = await createUser(tdb.db, { email: 'lib-member@example.com' });
    const memberApi = caller(makeCtx(tdb.db, sessionUser(member)));
    expect(await memberApi.library.preferences.get({ wall: 'movies' })).toMatchObject({ source: 'default' });
  });
});

describe('ledger.search — released_at sort (ADR-051 C-05 / DESIGN-026 D-05), NULLS-LAST both dirs', () => {
  it('desc: newest → oldest, then the date-less row last', async () => {
    const res = await api.ledger.search({ sort: { field: 'released_at', dir: 'desc' }, limit: 50 });
    expect(idsByTitle(res.items)).toEqual(['Newest', 'Middle', 'Oldest', 'NoDate']);
    expect(res.items[0]!.metadata.releasedAt).toBe('2022-12-31T00:00:00.000Z');
    expect(res.items[3]!.metadata.releasedAt).toBeNull();
  });

  it('asc: oldest → newest, then the date-less row last (NULLS LAST)', async () => {
    const res = await api.ledger.search({ sort: { field: 'released_at', dir: 'asc' }, limit: 50 });
    expect(idsByTitle(res.items)).toEqual(['Oldest', 'Middle', 'Newest', 'NoDate']);
  });
});

describe('ledger.search — per-user watch facet (ADR-053 / DESIGN-026 D-07), viewer-scoped', () => {
  it('watchState=watched returns only the viewer-watched item', async () => {
    const res = await api.ledger.search({ watchState: 'watched', limit: 50 });
    expect(idsByTitle(res.items)).toEqual(['Newest']);
  });

  it('watchState=unwatched excludes the viewer-watched item', async () => {
    const res = await api.ledger.search({ watchState: 'unwatched', limit: 50 });
    expect(idsByTitle(res.items).sort()).toEqual(['Middle', 'NoDate', 'Oldest']);
  });
});

describe('books.search — released sort + per-user read facet (PLAN-029)', () => {
  it('released sort puts the dated audiobook before the date-less one', async () => {
    const res = await api.books.search({ mediaKind: 'audiobook', sort: 'released', limit: 50 });
    expect(res.items.map((i) => i.title)).toEqual(['AudioNew', 'AudioNoDate']);
    expect(res.items[0]!.releasedAt).toBe('2021-01-01T00:00:00.000Z');
  });

  it('readState=read returns only the viewer-finished audiobook; unread excludes it', async () => {
    const read = await api.books.search({ mediaKind: 'audiobook', readState: 'read', limit: 50 });
    expect(read.items.map((i) => i.title)).toEqual(['AudioNew']);
    const unread = await api.books.search({ mediaKind: 'audiobook', readState: 'unread', limit: 50 });
    expect(unread.items.map((i) => i.title)).toEqual(['AudioNoDate']);
  });
});
