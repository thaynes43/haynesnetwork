import { describe, expect, it } from 'vitest';
import type { DbClient } from '@hnet/db';
import { assertSabnzbdEnv } from '@hnet/downloads';
import {
  aggregateActivity,
  describeSourceError,
  lazyActivityAdapter,
} from '../src/activity/aggregate';
import type { ActivityItem, ActivitySourceAdapter } from '../src/activity/contract';

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the AGGREGATOR's per-source FAILURE ISOLATION.
// The live prod incident: a missing SABNZBD_API_KEY made the books adapter throw AT CONSTRUCTION, blanking
// the whole Activity read (an endless skeleton wall + a bare "0 items" flash). The contract now: one adapter
// throwing (missing env, source down, timeout) returns the OTHER sources' items PLUS a per-source
// `unavailable` marker — never propagates. A source that merely returns [] is available-with-nothing, NOT
// unavailable. The failure-ledger href join is orthogonal here, so the ledger read is stubbed empty.

const NO_LEDGER: DbClient = {
  // loadFailureHrefs does `db.select({...}).from(table).where(isNull(...))` → awaited rows; stub it empty.
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as unknown as DbClient;

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

function okAdapter(source: string, label: string, items: ActivityItem[]): ActivitySourceAdapter {
  return { source, label, list: async () => items };
}
function throwingAdapter(source: string, label: string, err: Error): ActivitySourceAdapter {
  return {
    source,
    label,
    list: async () => {
      throw err;
    },
  };
}

const arrItems: ActivityItem[] = [
  item({ id: 'arr:radarr:601', stage: 'downloading', kind: 'movie', wall: 'movies', progress: 34 }),
  item({ id: 'arr:radarr:602', stage: 'failed', kind: 'movie', wall: 'movies', failureKind: 'import_blocked' }),
];

describe('aggregateActivity — per-source failure isolation', () => {
  it('one throws, the others still flow (+ a per-source unavailable marker)', async () => {
    const res = await aggregateActivity({
      db: NO_LEDGER,
      visibleSections: ['books'],
      adapters: [
        okAdapter('arr', 'Movies, TV & music', arrItems),
        throwingAdapter('books', 'Books & audiobooks', new Error('SAB queue read timed out')),
      ],
    });

    // The reachable *arr items are all present…
    expect(res.items.map((i) => i.id)).toEqual(['arr:radarr:601', 'arr:radarr:602']);
    expect(res.counts.total).toBe(2);
    // …and the down source is reported, not swallowed and not thrown.
    expect(res.unavailable).toEqual([
      { source: 'books', label: 'Books & audiobooks', reason: 'SAB queue read timed out' },
    ]);
  });

  it('all sources throw → no items, a marker each, still resolves (never propagates)', async () => {
    const res = await aggregateActivity({
      db: NO_LEDGER,
      visibleSections: ['books'],
      adapters: [
        throwingAdapter('arr', 'Movies, TV & music', new Error('ECONNREFUSED')),
        throwingAdapter('books', 'Books & audiobooks', new Error('SAB down')),
        throwingAdapter('kapowarr', 'Comics', new Error('Kapowarr 503')),
      ],
    });

    expect(res.items).toEqual([]);
    expect(res.counts.total).toBe(0);
    expect(res.unavailable.map((u) => u.source)).toEqual(['arr', 'books', 'kapowarr']);
  });

  it('env-missing (the exact prod scenario): an assertSabnzbdEnv construction throw DEGRADES, never propagates', async () => {
    // The books adapter is built lazily; its construction asserts SABNZBD_API_KEY. With it absent, resolve()
    // throws the real DownloadsConfigError — which must now land inside the aggregator's isolation, not crash
    // the read. The *arr source keeps flowing.
    const booksLazy = lazyActivityAdapter({
      source: 'books',
      label: 'Books & audiobooks',
      resolve: () => {
        assertSabnzbdEnv({}); // throws: no SABNZBD_API_KEY → the exact prod construction failure
        // (never reached) — the real bundle would be built here once the env is present.
        return okAdapter('books', 'Books & audiobooks', []);
      },
    });

    const res = await aggregateActivity({
      db: NO_LEDGER,
      visibleSections: ['books'],
      adapters: [okAdapter('arr', 'Movies, TV & music', arrItems), booksLazy],
    });

    expect(res.items.map((i) => i.id)).toEqual(['arr:radarr:601', 'arr:radarr:602']);
    const books = res.unavailable.find((u) => u.source === 'books');
    expect(books).toBeDefined();
    // The reason names the ABSENT variable (never its value) — the operator-safe env-assertion message.
    expect(books?.reason).toMatch(/SABNZBD_API_KEY/);
  });

  it('a source that returns [] is available-with-nothing, NOT unavailable', async () => {
    const res = await aggregateActivity({
      db: NO_LEDGER,
      visibleSections: ['books'],
      adapters: [
        okAdapter('arr', 'Movies, TV & music', []),
        okAdapter('books', 'Books & audiobooks', []),
      ],
    });
    expect(res.items).toEqual([]);
    expect(res.unavailable).toEqual([]); // empty ≠ unavailable
  });

  it('section gating still applies to the reachable items while a source is down', async () => {
    // A member (no visible sections) sees the universal *arr items but not book items; a down books source is
    // still reported. (Here the books source is UP and returns a book item that must be gated OUT for a member.)
    const res = await aggregateActivity({
      db: NO_LEDGER,
      visibleSections: [], // member
      adapters: [
        okAdapter('arr', 'Movies, TV & music', arrItems),
        okAdapter('books', 'Books & audiobooks', [
          item({ id: 'books:ll:9:ebook', stage: 'searching', kind: 'book', wall: 'books', section: 'books' }),
        ]),
        throwingAdapter('kapowarr', 'Comics', new Error('Kapowarr unreachable')),
      ],
    });
    // Book item gated out (section not visible); *arr items kept; kapowarr reported down.
    expect(res.items.map((i) => i.id)).toEqual(['arr:radarr:601', 'arr:radarr:602']);
    expect(res.unavailable.map((u) => u.source)).toEqual(['kapowarr']);
  });
});

describe('describeSourceError', () => {
  it('returns the terse message for an Error', () => {
    expect(describeSourceError(new Error('boom'))).toBe('boom');
  });
  it('collapses whitespace and clamps a very long message', () => {
    const long = describeSourceError(new Error('x'.repeat(400)));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });
  it('falls back for a non-Error / empty throw', () => {
    expect(describeSourceError('')).toBe('the source is unreachable');
  });
});
