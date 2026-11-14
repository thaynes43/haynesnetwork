// DESIGN-025 D-11: incomplete Plex answers cannot erase fitting cached matches. Stub reads + real PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, mediaPlexMatches, plexLibraries } from '@hnet/db';
import {
  syncPlexMatches,
  upsertMediaItemsBatch,
  upsertPlexLibraries,
  type PlexClientBundle,
} from '@hnet/domain';
import type { PlexReadClient } from '@hnet/plex/read';
import type { PlexSectionItem } from '@hnet/plex';
import { fetchPlexMatchSnapshot, MAX_PAGES } from '../src/plex-match';
import { runSync } from '../src/orchestrator';
import type { SyncClients } from '../src/clients';
import type { SyncLogger } from '../src/logger';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
let movieLib: string;
let emptyLib: string;
let showLib: string;
let movieA: string;
let movieB: string;
let show: string;
const before = new Date('2026-11-01T00:00:00Z');
const now = new Date('2026-11-14T00:00:00Z');
const item = {
  ratingKey: '101',
  type: 'movie',
  title: 'Movie A',
  Guid: [{ id: 'tmdb://101' }],
} as PlexSectionItem;
type Page = { items: PlexSectionItem[]; totalSize: number | null };

beforeAll(async () => {
  t = await bootMigratedDb();
  await upsertPlexLibraries({
    db: t.db,
    slug: 'haynestower',
    libraries: [
      { sectionKey: '1', name: 'Movies', mediaType: 'movie' },
      { sectionKey: '2', name: 'Shows', mediaType: 'show' },
      { sectionKey: '3', name: 'Empty', mediaType: 'movie' },
    ],
  });
  const libs = await t.db.select().from(plexLibraries);
  movieLib = libs.find((l) => l.sectionKey === '1')!.id;
  showLib = libs.find((l) => l.sectionKey === '2')!.id;
  emptyLib = libs.find((l) => l.sectionKey === '3')!.id;
  const base = {
    monitored: true,
    qualityProfileId: 1,
    qualityProfileName: 'Any',
    rootFolder: '/movies',
  };
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'radarr',
    items: [
      { ...base, arrItemId: 101, tmdbId: 101, title: 'Movie A', sortTitle: 'movie a' },
      { ...base, arrItemId: 102, tmdbId: 102, title: 'Movie B', sortTitle: 'movie b' },
    ],
  });
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'sonarr',
    items: [{ ...base, arrItemId: 201, tvdbId: 201, title: 'Show', sortTitle: 'show' }],
  });
  const items = await t.db.select().from(mediaItems);
  movieA = items.find((i) => i.arrItemId === 101)!.id;
  movieB = items.find((i) => i.arrItemId === 102)!.id;
  show = items.find((i) => i.arrItemId === 201)!.id;
});
beforeEach(async () => {
  await syncPlexMatches({
    db: t.db,
    now: before,
    scopedLibraryIds: [],
    matches: [
      { mediaItemId: movieA, plexLibraryId: movieLib, ratingKey: '101', matchedVia: 'tmdb' },
      { mediaItemId: movieB, plexLibraryId: movieLib, ratingKey: '102', matchedVia: 'tmdb' },
      { mediaItemId: show, plexLibraryId: showLib, ratingKey: '201', matchedVia: 'tvdb' },
    ],
  });
});
afterAll(async () => {
  await t?.stop();
});

function bundle(page: (pageNumber: number) => Page, sectionKey = '1') {
  const starts: number[] = [];
  return {
    starts,
    plex: {
      read: {
        haynestower: {
          async listSections() {
            return [{ key: sectionKey, title: 'Movies', type: 'movie' }];
          },
          async listSectionContentsPage(
            _key: string,
            opts: { start: number; size: number; requireTotalSize?: boolean },
          ) {
            expect(opts.requireTotalSize).toBe(true);
            starts.push(opts.start);
            return page(starts.length);
          },
        } as unknown as PlexReadClient,
      },
    } as unknown as Pick<PlexClientBundle, 'read'>,
  };
}

async function storedIds(libraryId = movieLib) {
  const rows = await t.db
    .select({ id: mediaPlexMatches.id })
    .from(mediaPlexMatches)
    .where(eq(mediaPlexMatches.plexLibraryId, libraryId));
  return rows.map((r) => r.id).sort();
}

describe('section completeness and stale-delete scope', () => {
  it.each([
    {
      name: 'empty first page with a positive total',
      reason: 'short_read',
      pages: () => ({ items: [], totalSize: 2 }),
    },
    {
      name: 'empty later page before the total',
      reason: 'short_read',
      pages: (n: number) => ({ items: n === 1 ? [item] : [], totalSize: 2 }),
    },
    {
      name: 'missing total on an empty first page',
      reason: 'unknown_total',
      pages: () => ({ items: [], totalSize: null }),
    },
    {
      name: 'missing total despite returned items',
      reason: 'unknown_total',
      pages: () => ({ items: [item], totalSize: null }),
    },
    {
      name: 'missing total on a later page',
      reason: 'unknown_total',
      pages: (n: number) => ({ items: [item], totalSize: n === 1 ? 3 : null }),
    },
    {
      name: 'reported zero with stored matches',
      reason: 'unexpected_zero',
      pages: () => ({ items: [], totalSize: 0 }),
    },
    {
      name: 'total shrinks between pages',
      reason: 'changed_total',
      pages: (n: number) => ({ items: [item], totalSize: n === 1 ? 3 : 1 }),
    },
    {
      name: 'total grows between pages',
      reason: 'changed_total',
      pages: (n: number) => ({ items: [item], totalSize: n === 1 ? 3 : 4 }),
    },
    {
      name: 'invalid negative total',
      reason: 'unknown_total',
      pages: () => ({ items: [], totalSize: -1 }),
    },
    {
      name: 'page cap without completion',
      reason: 'page_cap',
      pages: () => ({ items: [item], totalSize: MAX_PAGES + 1 }),
    },
    {
      name: 'total reached on the cap page',
      reason: 'page_cap',
      pages: () => ({ items: [item], totalSize: MAX_PAGES }),
    },
    {
      name: 'exception after a partial page',
      reason: 'read_failed',
      pages: (n: number) => {
        if (n > 1) throw new Error('stub read failed');
        return { items: [item], totalSize: 2 };
      },
    },
  ])('keeps every stored fitting row: $name', async ({ reason, pages }) => {
    const ids = await storedIds();
    const otherIds = await storedIds(showLib);
    const errors: Array<{ msg: string; fields: unknown }> = [];
    const logger: SyncLogger = {
      info() {},
      warn() {},
      error(msg, fields) {
        errors.push({ msg, fields });
      },
    };
    const fake = bundle(pages);
    const snapshot = await fetchPlexMatchSnapshot({ db: t.db, plex: fake.plex, logger });
    expect(snapshot.scopedLibraryIds).toEqual([]);
    expect(snapshot.stats.scopedLibraryIds).toEqual([]);
    expect(snapshot.stats.incompleteSections).toBe(1);
    expect(errors).toContainEqual({
      msg: 'plex-match: section read incomplete (not scoped)',
      fields: expect.objectContaining({
        libraryId: movieLib,
        reason,
        itemsRead: expect.any(Number),
        pagesRead: fake.starts.length - (reason === 'read_failed' ? 1 : 0),
      }),
    });
    if (reason === 'page_cap') expect(fake.starts).toHaveLength(MAX_PAGES);
    if (reason === 'short_read' && fake.starts.length === 2) expect(fake.starts).toEqual([0, 1]);
    const result = await syncPlexMatches({ db: t.db, ...snapshot, now });
    expect(result.removed).toBe(0);
    expect(result.crossTypeRemoved).toBe(0);
    expect(await storedIds()).toEqual(ids);
    expect(await storedIds(showLib)).toEqual(otherIds);
  });

  it('scopes a complete read and removes a stale row, preserving another library', async () => {
    const otherIds = await storedIds(showLib);
    const fake = bundle(() => ({ items: [item], totalSize: 1 }));
    const snapshot = await fetchPlexMatchSnapshot({ db: t.db, plex: fake.plex });
    expect(snapshot.scopedLibraryIds).toEqual([movieLib]);
    expect(snapshot.stats.incompleteSections).toBe(0);
    const report = await syncPlexMatches({ db: t.db, ...snapshot, now });
    expect(report.removed).toBe(1);
    expect(await storedIds()).toHaveLength(1);
    expect(await storedIds(showLib)).toEqual(otherIds);
  });

  it('can finish immediately below the page cap', async () => {
    const fake = bundle(() => ({ items: [item], totalSize: MAX_PAGES - 1 }));
    const snapshot = await fetchPlexMatchSnapshot({ db: t.db, plex: fake.plex });
    expect(fake.starts).toHaveLength(MAX_PAGES - 1);
    expect(snapshot.scopedLibraryIds).toEqual([movieLib]);
    expect(snapshot.stats.incompleteSections).toBe(0);
  });

  it('scopes a truly empty library with no stored rows', async () => {
    const ids = await storedIds();
    const fake = bundle(() => ({ items: [], totalSize: 0 }), '3');
    const snapshot = await fetchPlexMatchSnapshot({ db: t.db, plex: fake.plex });
    expect(snapshot.scopedLibraryIds).toEqual([emptyLib]);
    expect(snapshot.stats.incompleteSections).toBe(0);
    expect(snapshot.matches).toEqual([]);
    const report = await syncPlexMatches({ db: t.db, ...snapshot, now });
    expect(report.removed).toBe(0);
    expect(await storedIds()).toEqual(ids);
  });

  it('still removes an ADR-123 cross-type row while an incomplete library keeps its fitting rows', async () => {
    const ids = await storedIds();
    // Fixture for a historical wrong match; the production writer rejects/removes such a row today.
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: show,
      plexLibraryId: movieLib,
      ratingKey: 'wrong',
      matchedVia: 'tvdb',
    });
    const fake = bundle(() => ({ items: [], totalSize: 2 }));
    const snapshot = await fetchPlexMatchSnapshot({ db: t.db, plex: fake.plex });
    expect(snapshot.scopedLibraryIds).toEqual([]);
    const report = await syncPlexMatches({ db: t.db, ...snapshot, now });
    expect(report.crossTypeRemoved).toBe(1);
    expect(report.removed).toBe(0);
    expect(await storedIds()).toEqual(ids);
  });

  it('reports an incomplete section in the orchestrator completion stats', async () => {
    const ids = await storedIds();
    const infos: Array<{ msg: string; fields: unknown }> = [];
    const fake = bundle(() => ({ items: [], totalSize: 2 }));
    const report = await runSync({
      db: t.db,
      mode: 'plex-match',
      clients: {} as SyncClients,
      plex: fake.plex as PlexClientBundle,
      now,
      logger: {
        info(msg, fields) {
          infos.push({ msg, fields });
        },
        warn() {},
        error() {},
      },
    });
    expect(report.plexMatch?.stats.incompleteSections).toBe(1);
    expect(report.totalFailure).toBe(true);
    expect(infos).toContainEqual({
      msg: 'plex-match complete',
      fields: expect.objectContaining({ incompleteSections: 1, scopedLibraries: 0, removed: 0 }),
    });
    expect(await storedIds()).toEqual(ids);
  });
});
