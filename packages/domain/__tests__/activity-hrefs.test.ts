import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activityImportFailures,
  bookRequests,
  integrationShelfItems,
  mediaItems,
  userIntegrations,
} from '@hnet/db';
import { bootMigratedDb, createUser, type TestDb } from './helpers';
import { activityFamilyOf, resolveActivityHrefs } from '../src/activity/aggregate';
import type { ActivityItem } from '../src/activity/contract';

// PLAN-048 / ADR-059 / DESIGN-030 D-09 (owner CLICKABILITY ruling) — the aggregator now fills EVERY item's
// in-app `href`, not just failures. Proves the click-through map per family against a real ledger + request
// table: a non-failed *arr item → its LEDGER detail (media_items join), a book/comic want → its Wanted detail
// (book_requests join by ll_book_id / kapowarr_volume_id), a `failed` item → its failure-detail page (ledger
// join) — all `?from=activity` — and a JOIN MISS stays null (an inert tile, the honest fallback).

let boot: TestDb;
beforeAll(async () => {
  boot = await bootMigratedDb();
}, 120_000);
afterAll(async () => {
  await boot?.stop();
});
beforeEach(async () => {
  await boot.db.delete(activityImportFailures);
  await boot.db.delete(bookRequests);
  await boot.db.delete(integrationShelfItems);
  await boot.db.delete(userIntegrations);
  await boot.db.delete(mediaItems);
});

function item(over: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'stage'>): ActivityItem {
  return {
    id: over.id,
    kind: over.kind ?? 'movie',
    section: over.section ?? null,
    wall: over.wall ?? 'movies',
    title: over.title ?? over.id,
    year: over.year ?? null,
    sourceApp: over.sourceApp ?? 'radarr',
    stage: over.stage,
    progress: over.progress ?? null,
    failureReason: over.failureReason ?? null,
    failureKind: over.failureKind ?? null,
    updatedAt: over.updatedAt ?? '2026-07-14T12:00:00.000Z',
    posterUrl: null,
    href: null,
    downstreamUrl: null,
    actions: over.actions ?? [],
  };
}

describe('activityFamilyOf', () => {
  it('derives the source family from the ref prefix', () => {
    expect(activityFamilyOf('arr:radarr:601')).toBe('arr');
    expect(activityFamilyOf('books:ll:gb-1:ebook')).toBe('books');
    expect(activityFamilyOf('kapowarr:42')).toBe('kapowarr');
    expect(activityFamilyOf('mystery:9')).toBeNull();
  });
});

describe('resolveActivityHrefs — the click-through map (D-09)', () => {
  it('a non-failed *arr item links to its LEDGER detail (media_items join); a miss stays null', async () => {
    const [movie] = await boot.db
      .insert(mediaItems)
      .values({
        arrKind: 'radarr',
        arrItemId: 601,
        tmdbId: 880001,
        title: 'The Fixture',
        sortTitle: 'fixture',
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'HD-1080p',
        rootFolder: '/movies',
      })
      .returning({ id: mediaItems.id });

    const items = [
      item({ id: 'arr:radarr:601', stage: 'downloading', progress: 45 }),
      item({ id: 'arr:radarr:999', stage: 'downloading', progress: 12 }), // no ledger row → inert
    ];
    await resolveActivityHrefs(boot.db, items);

    expect(items[0]!.href).toBe(`/library/${movie!.id}?from=activity`);
    expect(items[1]!.href).toBeNull();
  });

  it('a failed item links to its failure-detail page (open ledger row); an unscanned failure stays null', async () => {
    const [row] = await boot.db
      .insert(activityImportFailures)
      .values({
        source: 'arr',
        sourceRef: 'arr:radarr:602',
        kind: 'movie',
        failureKind: 'import_blocked',
        failureReason: 'manual import required',
        title: 'Blocked Movie',
        sourceApp: 'radarr',
      })
      .returning({ id: activityImportFailures.id });

    const items = [
      item({ id: 'arr:radarr:602', stage: 'failed', failureKind: 'import_blocked' }),
      item({ id: 'arr:radarr:603', stage: 'failed', failureKind: 'download_failed' }), // no ledger row yet
    ];
    await resolveActivityHrefs(boot.db, items);

    expect(items[0]!.href).toBe(`/library/activity/${row!.id}?from=activity`);
    expect(items[1]!.href).toBeNull();
  });

  it('a non-failed book / comic want links to its Wanted detail (book_requests join)', async () => {
    const user = await createUser(boot.db);
    const [integration] = await boot.db
      .insert(userIntegrations)
      .values({ userId: user.id, provider: 'goodreads', externalUserId: 'gr-1', status: 'linked' })
      .returning({ id: userIntegrations.id });
    const [shelfItem] = await boot.db
      .insert(integrationShelfItems)
      .values({ integrationId: integration!.id, shelf: 'to-read', externalBookId: 'gr-book-1', title: 'A Wanted Book' })
      .returning({ id: integrationShelfItems.id });
    const [bookReq] = await boot.db
      .insert(bookRequests)
      .values({ integrationId: integration!.id, shelfItemId: shelfItem!.id, title: 'A Wanted Book', llBookId: 'gb-1' })
      .returning({ id: bookRequests.id });

    const [comicShelf] = await boot.db
      .insert(integrationShelfItems)
      .values({ integrationId: integration!.id, shelf: 'to-read', externalBookId: 'gr-comic-1', title: 'A Comic' })
      .returning({ id: integrationShelfItems.id });
    const [comicReq] = await boot.db
      .insert(bookRequests)
      .values({
        integrationId: integration!.id,
        shelfItemId: comicShelf!.id,
        title: 'A Comic',
        comicStatus: 'wanted',
        kapowarrVolumeId: '77',
      })
      .returning({ id: bookRequests.id });

    const items = [
      item({ id: 'books:ll:gb-1:ebook', stage: 'searching', kind: 'book', wall: 'books', section: 'books', sourceApp: 'lazylibrarian' }),
      item({ id: 'kapowarr:77', stage: 'downloading', progress: 30, kind: 'comic', wall: 'comics', section: 'books', sourceApp: 'kapowarr' }),
      item({ id: 'books:ll:unknown:audiobook', stage: 'importing', kind: 'audiobook', wall: 'audiobooks', section: 'books', sourceApp: 'lazylibrarian' }),
    ];
    await resolveActivityHrefs(boot.db, items);

    expect(items[0]!.href).toBe(`/library/books/wanted/${bookReq!.id}?from=activity`);
    expect(items[1]!.href).toBe(`/library/books/wanted/${comicReq!.id}?from=activity`);
    expect(items[2]!.href).toBeNull(); // no matching request → inert
  });
});
