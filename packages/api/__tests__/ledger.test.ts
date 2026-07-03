// DESIGN-005 D-17 — ledger router integration tests: embedded PG16; search filters +
// keyset pagination, detail with event history, the live children proxy (D-06), and
// the wanted view (D-08). Seeding goes through the D-12 single writers only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestLedgerEvents, tombstoneMissingItems } from '@hnet/domain';
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
import { episodeJson, stubArrBundle } from './arr-stubs';

let tdb: TestDb;
let api: Caller;
let ids: Record<string, string>;
let member: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  tdb = await bootMigratedDb();
  member = await createUser(tdb.db);

  // A small mixed library: complete/partial/none on-disk states, three kinds,
  // one tombstoned row.
  const alpha = await seedMediaItem(tdb.db, 'sonarr', {
    title: 'Alpha Complete',
    arrItemId: 301,
    onDiskFileCount: 10,
    expectedFileCount: 10,
  });
  const bravo = await seedMediaItem(tdb.db, 'sonarr', {
    title: 'Bravo Partial',
    arrItemId: 302,
    onDiskFileCount: 4,
    expectedFileCount: 10,
  });
  const charlie = await seedMediaItem(tdb.db, 'radarr', {
    title: 'Charlie Wanted',
    arrItemId: 303,
    onDiskFileCount: 0,
    expectedFileCount: 1,
  });
  const delta = await seedMediaItem(tdb.db, 'lidarr', {
    title: 'Delta Artist',
    arrItemId: 304,
    onDiskFileCount: 5,
    expectedFileCount: 5,
    rootFolder: '/data/media/music',
  });
  const echo = await seedMediaItem(tdb.db, 'radarr', {
    title: 'Echo Tombstoned',
    arrItemId: 305,
    onDiskFileCount: 1,
    expectedFileCount: 1,
  });
  await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [303] });

  await ingestLedgerEvents({
    db: tdb.db,
    source: 'sonarr',
    events: [
      {
        mediaItemId: alpha.id,
        eventType: 'grabbed',
        source: 'sonarr',
        sourceEventId: 'sonarr:1',
        occurredAt: new Date('2026-07-01T10:00:00Z'),
        payload: { rawEventType: 'grabbed', sourceTitle: 'Alpha.S01E01.1080p' },
      },
      {
        mediaItemId: alpha.id,
        eventType: 'imported',
        source: 'sonarr',
        sourceEventId: 'sonarr:2',
        occurredAt: new Date('2026-07-01T11:00:00Z'),
        payload: { rawEventType: 'downloadFolderImported', episodeId: 30101 },
      },
      {
        mediaItemId: alpha.id,
        eventType: 'deleted',
        source: 'sonarr',
        sourceEventId: 'sonarr:3',
        occurredAt: new Date('2026-07-02T09:00:00Z'),
        payload: { rawEventType: 'episodeFileDeleted', kind: 'file_deleted' },
      },
    ],
  });

  ids = {
    alpha: alpha.id,
    bravo: bravo.id,
    charlie: charlie.id,
    delta: delta.id,
    echo: echo.id,
    member: member.id,
  };
  api = caller(makeCtx(tdb.db, sessionUser(member)));
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

describe('ledger.search (R-43)', () => {
  it('lists live rows by default (tombstoned excluded), sorted by title', async () => {
    const { items, nextCursor } = await api.ledger.search({});
    expect(items.map((i) => i.title)).toEqual([
      'Alpha Complete',
      'Bravo Partial',
      'Charlie Wanted',
      'Delta Artist',
    ]);
    expect(nextCursor).toBeNull();
    expect(items[0]).toMatchObject({
      arrKind: 'sonarr',
      monitored: true,
      onDiskFileCount: 10,
      expectedFileCount: 10,
      tombstoned: false,
    });
  });

  it('filters by title query, arr kind, and on-disk state', async () => {
    const byQuery = await api.ledger.search({ query: 'bravo' });
    expect(byQuery.items.map((i) => i.title)).toEqual(['Bravo Partial']);

    const byKind = await api.ledger.search({ arrKind: 'radarr' });
    expect(byKind.items.map((i) => i.title)).toEqual(['Charlie Wanted']);

    const partial = await api.ledger.search({ onDisk: 'partial' });
    expect(partial.items.map((i) => i.title)).toEqual(['Bravo Partial']);

    const none = await api.ledger.search({ onDisk: 'none' });
    expect(none.items.map((i) => i.title)).toEqual(['Charlie Wanted']);

    const complete = await api.ledger.search({ onDisk: 'complete' });
    expect(complete.items.map((i) => i.title)).toEqual(['Alpha Complete', 'Delta Artist']);
  });

  it('wanted=true narrows to the D-08 view semantics; includeTombstoned widens', async () => {
    const wanted = await api.ledger.search({ wanted: true });
    expect(wanted.items.map((i) => i.title)).toEqual(['Charlie Wanted']);

    const all = await api.ledger.search({ includeTombstoned: true });
    expect(all.items.map((i) => i.title)).toContain('Echo Tombstoned');
    expect(all.items.find((i) => i.title === 'Echo Tombstoned')!.tombstoned).toBe(true);
  });

  it('paginates with an opaque keyset cursor (no overlap, stable order)', async () => {
    const page1 = await api.ledger.search({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await api.ledger.search({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    const seen = [...page1.items, ...page2.items].map((i) => i.title);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual(['Alpha Complete', 'Bravo Partial', 'Charlie Wanted', 'Delta Artist']);

    await expect(api.ledger.search({ cursor: '!!not-a-cursor!!' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('ledger.detail / ledger.events', () => {
  it('returns the full item, newest-first events, and the item fix list', async () => {
    const detail = await api.ledger.detail({ id: ids.alpha! });
    expect(detail.item).toMatchObject({
      title: 'Alpha Complete',
      arrKind: 'sonarr',
      qualityProfileName: 'Any',
      tombstonedAt: null,
    });
    expect(detail.events.map((e) => e.eventType)).toEqual(['deleted', 'imported', 'grabbed']);
    expect(detail.events[0]!.occurredAt).toBe('2026-07-02T09:00:00.000Z');
    expect(detail.fixes).toEqual([]);

    await expect(
      api.ledger.detail({ id: '00000000-0000-4000-8000-00000000dead' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pages events by (occurred_at, id) desc', async () => {
    const page1 = await api.ledger.events({ mediaItemId: ids.alpha!, limit: 2 });
    expect(page1.events.map((e) => e.eventType)).toEqual(['deleted', 'imported']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await api.ledger.events({
      mediaItemId: ids.alpha!,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.events.map((e) => e.eventType)).toEqual(['grabbed']);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('ledger.children (D-06 live proxy)', () => {
  it('proxies sonarr episodes live with SxxEyy labels', async () => {
    const stub = stubArrBundle([
      {
        path: '/api/v3/episode',
        body: [
          episodeJson(30102, 1, 2, { seriesId: 301, title: 'Rich', hasFile: false }),
          episodeJson(30101, 1, 1, { seriesId: 301, title: 'Pilot' }),
        ],
      },
    ]);
    const children = await caller(
      makeCtx(tdb.db, sessionUser(member), stub.bundle),
    ).ledger.children({ mediaItemId: ids.alpha! });
    expect(children).toEqual([
      { arrChildId: 30101, label: 'S01E01 · Pilot', hasFile: true, monitored: true },
      { arrChildId: 30102, label: 'S01E02 · Rich', hasFile: false, monitored: true },
    ]);
    expect(stub.callsFor('GET', '/api/v3/episode')[0]!.url.searchParams.get('seriesId')).toBe(
      '301',
    );
  });

  it('returns [] for radarr (the movie is the target) and for tombstoned items', async () => {
    const stub = stubArrBundle([]);
    const c = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    expect(await c.ledger.children({ mediaItemId: ids.charlie! })).toEqual([]);
    expect(await c.ledger.children({ mediaItemId: ids.echo! })).toEqual([]);
    expect(stub.calls).toHaveLength(0); // no live call for either
  });
});

describe('ledger.wanted (D-08 view)', () => {
  it('serves the wanted_items view, filterable by kind', async () => {
    const wanted = await api.ledger.wanted({});
    expect(wanted.items.map((i) => i.title)).toEqual(['Charlie Wanted']);
    expect(wanted.items[0]).toMatchObject({ arrKind: 'radarr', expectedFileCount: 1 });
    const sonarrOnly = await api.ledger.wanted({ arrKind: 'sonarr' });
    expect(sonarrOnly.items).toEqual([]);
  });
});
