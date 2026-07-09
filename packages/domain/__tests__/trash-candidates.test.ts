// ADR-035 / DESIGN-010 amendment — the Trash candidate READ-MODEL. Proves: the refresher's
// snapshot-replace semantics (upsert + tombstone: a vanished Maintainerr item leaves the snapshot
// on refresh), per-kind bucketing + state-row bookkeeping, Leaving-Soon collections never
// snapshotted, removeTrashCandidateRows' row drop + count recompute (refreshed_at untouched), the
// freshness policy (fresh serves with ZERO Maintainerr calls; inline mode re-crawls; missing state
// refreshes inline), and the paginated read's snapshot backing + live page-scoped exclusions.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { trashCandidates, trashCandidatesState } from '@hnet/db/schema';
import {
  __setCandidateFreshnessForTests,
  countTrashPending,
  listTrashPendingCandidates,
  listTrashPendingPage,
  refreshTrashCandidates,
  removeTrashCandidateRows,
} from '../src/index';
import { LEAVING_SOON_COLLECTION_TITLES } from '../src/trash-flow';
import { bootMigratedDb, type TestDb } from './helpers';
import { baseState, makeMaintainerr, movieCollection, tvCollection } from './maintainerr-stub';

describe('trash candidate read-model (ADR-035)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => t?.stop());
  afterEach(() => __setCandidateFreshnessForTests(null));

  it('refresh snapshots both kinds + state rows; a re-refresh REPLACES (tombstone semantics)', async () => {
    const s = baseState({ collections: [movieCollection(), tvCollection()] });
    const { bundle } = makeMaintainerr(s);
    const report = await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    expect(report.kinds).toEqual([
      { mediaKind: 'movie', itemCount: 3, totalSizeBytes: 9_000_000_000 },
      { mediaKind: 'tv', itemCount: 2, totalSizeBytes: 11_000_000_000 },
    ]);
    const movieRows = await t.db
      .select()
      .from(trashCandidates)
      .where(eq(trashCandidates.mediaKind, 'movie'));
    expect(movieRows.map((r) => r.maintainerrMediaId).sort()).toEqual([
      'ms-9001',
      'ms-9002',
      'ms-9003',
    ]);
    // addDate round-trips VERBATIM (text column — the wire shape must not mutate through PG).
    expect(movieRows[0]!.addDate).toBe('2026-06-01T00:00:00Z');

    // Maintainerr moves on: one movie vanishes, one arrives. The refresh REPLACES the snapshot —
    // the vanished row is tombstoned out, never orphaned.
    s.collections[0]!.items = [
      s.collections[0]!.items[0]!,
      { mediaServerId: 'ms-9009', tmdbId: 9009, sizeBytes: 1_000_000_000, addDate: '2026-06-02T00:00:00Z' },
    ];
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const after = await t.db
      .select()
      .from(trashCandidates)
      .where(eq(trashCandidates.mediaKind, 'movie'));
    expect(after.map((r) => r.maintainerrMediaId).sort()).toEqual(['ms-9001', 'ms-9009']);
    const [movieState] = await t.db
      .select()
      .from(trashCandidatesState)
      .where(eq(trashCandidatesState.mediaKind, 'movie'));
    expect(movieState).toMatchObject({ itemCount: 2, totalSizeBytes: 5_000_000_000 });
  });

  it('our Leaving-Soon manual collections are NEVER snapshotted (ADR-025 C-04)', async () => {
    const s = baseState({
      collections: [
        movieCollection(),
        movieCollection({
          id: 99,
          title: LEAVING_SOON_COLLECTION_TITLES.movie,
          items: [{ mediaServerId: 'ms-9001', tmdbId: 9001, sizeBytes: 4_000_000_000, addDate: '2026-06-01T00:00:00Z' }],
        }),
      ],
    });
    const { bundle } = makeMaintainerr(s);
    const report = await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    expect(report.kinds.find((k) => k.mediaKind === 'movie')).toMatchObject({ itemCount: 3 });
    const rows = await t.db
      .select()
      .from(trashCandidates)
      .where(eq(trashCandidates.collectionId, 99));
    expect(rows).toHaveLength(0);
  });

  it('removeTrashCandidateRows drops the rows + recomputes counts, refreshed_at untouched', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection(), tvCollection()] }));
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    const [before] = await t.db
      .select()
      .from(trashCandidatesState)
      .where(eq(trashCandidatesState.mediaKind, 'movie'));

    const res = await removeTrashCandidateRows({
      db: t.db,
      maintainerrMediaIds: ['ms-9001', 'ms-9003', 'ms-not-there'],
    });
    expect(res.removed).toBe(2);
    const [after] = await t.db
      .select()
      .from(trashCandidatesState)
      .where(eq(trashCandidatesState.mediaKind, 'movie'));
    expect(after).toMatchObject({ itemCount: 1, totalSizeBytes: 3_000_000_000 });
    expect(after!.refreshedAt.getTime()).toBe(before!.refreshedAt.getTime()); // honest staleness
    // Empty list is a no-op (no transaction, no state churn).
    expect(await removeTrashCandidateRows({ db: t.db, maintainerrMediaIds: [] })).toEqual({
      removed: 0,
    });
  });

  it('freshness: a FRESH snapshot serves with ZERO Maintainerr calls; inline mode re-crawls per read', async () => {
    const s = baseState();
    const { bundle, calls } = makeMaintainerr(s);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });

    __setCandidateFreshnessForTests({ maxAgeMs: 60_000, serveStale: true });
    const baseline = calls.length;
    const count = await countTrashPending({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(count).toMatchObject({ count: 3, totalSizeBytes: 9_000_000_000 });
    const list = await listTrashPendingCandidates({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(list.count).toBe(3);
    expect(list.refreshedAt).toBe(count.refreshedAt);
    expect(calls.length).toBe(baseline); // count + candidate list: Postgres only, no crawl

    // Inline (non-prod default) mode: the SAME read re-crawls first — read-through equivalence.
    __setCandidateFreshnessForTests({ maxAgeMs: 0, serveStale: false });
    s.collections[0]!.items = s.collections[0]!.items.slice(0, 1);
    const fresh = await countTrashPending({ db: t.db, maintainerr: bundle, media: 'movie' });
    expect(fresh.count).toBe(1);
    expect(calls.length).toBeGreaterThan(baseline);
  });

  it('a NEVER-REFRESHED install refreshes inline even in serve-stale mode (no empty flash)', async () => {
    await t.db.delete(trashCandidates);
    await t.db.delete(trashCandidatesState);
    __setCandidateFreshnessForTests({ maxAgeMs: 60_000, serveStale: true });
    const { bundle } = makeMaintainerr(baseState());
    const page = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 10,
      offset: 0,
    });
    expect(page.total).toBe(3);
    expect(Date.parse(page.refreshedAt)).toBeGreaterThan(0);
  });

  it('the paginated read serves the snapshot but cross-checks page exclusions LIVE', async () => {
    const s = baseState();
    const { bundle, calls } = makeMaintainerr(s);
    await refreshTrashCandidates({ db: t.db, maintainerr: bundle });
    __setCandidateFreshnessForTests({ maxAgeMs: 60_000, serveStale: true });

    // An exclusion lands OUTSIDE this app (another session / Maintainerr UI) AFTER the snapshot —
    // the page still shows it Protected because the per-page check is live, never snapshotted.
    s.exclusions.add('ms-9002');
    const page = await listTrashPendingPage({
      db: t.db,
      maintainerr: bundle,
      media: 'movie',
      limit: 10,
      offset: 0,
    });
    const item = page.items.find((i) => i.maintainerrMediaId === 'ms-9002');
    expect(item?.protectedByExclusion).toBe(true);
    const exclusionReads = calls.filter((c) => c.pathname === '/rules/exclusion');
    expect(exclusionReads.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.pathname === '/collections').length).toBe(1); // refresh only
  });
});
