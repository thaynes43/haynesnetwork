// ADR-025 / DESIGN-011 — Trash curation pipeline orchestrators (embedded PG16 + fetch-stubbed
// Maintainerr, extended with the manual-collection endpoints). Proves the batch STATE MACHINE
// (legal transitions write their event same-tx; illegal ones throw; only leaving_soon expires; the
// gate_skipped path only fires when the setting is enabled and is audited), setBatchItemSaved's
// save/unsave semantics + exclusion writes + tuning rows, and the sweep honouring guardian + LIVE
// exclusions + SAFE audit with Q-08 deletion snapshots. Reuses the hostile-stub patterns from the
// 006 trash-flow tests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  permissionAudit,
  trashBatchItems,
  trashBatchSaves,
  trashBatches,
} from '@hnet/db/schema';
import {
  MaintainerrUnsafeError,
  TrashBatchEmptyError,
  TrashBatchOpenError,
  TrashBatchStateError,
  buildMaintainerrClientBundle,
  cancelBatch,
  createBatchFromPending,
  getAppSetting,
  getBatchDetail,
  getBatchSaveStats,
  greenlightBatch,
  listBatches,
  setAppSetting,
  setBatchItemSaved,
  sweepExpiredBatches,
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  type MaintainerrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ---------------------------------------------------------------------------
// Maintainerr stub — the 006 makeMaintainerr, extended with the collection surface.
// ---------------------------------------------------------------------------

interface StubItem {
  mediaServerId: string;
  tmdbId?: number;
  tvdbId?: number;
  sizeBytes: number;
  addDate: string;
}
interface StubCollection {
  id: number;
  isActive: boolean;
  deleteAfterDays: number;
  type: string;
  title: string;
  libraryId: number;
  items: StubItem[];
}
interface MaintState {
  integrations: { radarr: boolean; sonarr: boolean; tautulli: boolean; seerr: boolean };
  plexOk: boolean;
  reachable: boolean;
  exclusions: Set<string>;
  collections: StubCollection[];
  /** mediaServerIds whose per-item handle fired — dropped from collection content. */
  handled: Set<string>;
  /** the id the stub returns for POST /collections. */
  nextCollectionId: number;
  fail: Set<string>;
}
interface RecordedCall {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

function makeMaintainerr(state: MaintState): {
  bundle: MaintainerrClientBundle;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: path, query, body });
    if (!state.reachable) return new Response('unreachable', { status: 502 });
    const key = `${method} ${path}`;
    if (state.fail.has(key)) return new Response('{"message":"forced"}', { status: 500 });
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    // reads
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.17.0' });
    if (method === 'GET' && path === '/settings/test/plex')
      return ok({ status: state.plexOk ? 'OK' : 'NOK', code: state.plexOk ? 1 : 0 });
    if (method === 'GET' && path === '/rules/constants') {
      const apps: Array<{ name: string }> = [];
      if (state.integrations.radarr) apps.push({ name: 'Radarr' });
      if (state.integrations.sonarr) apps.push({ name: 'Sonarr' });
      if (state.integrations.tautulli) apps.push({ name: 'Tautulli' });
      if (state.integrations.seerr) apps.push({ name: 'Overseerr' });
      return ok({ applications: apps });
    }
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections') {
      return ok(
        state.collections.map((c) => ({
          id: c.id,
          isActive: c.isActive,
          deleteAfterDays: c.deleteAfterDays,
          type: c.type,
          title: c.title,
          libraryId: c.libraryId,
          media: [],
        })),
      );
    }
    const contentMatch = path.match(/^\/collections\/media\/(\d+)\/content\/(\d+)$/);
    if (method === 'GET' && contentMatch) {
      const cid = Number(contentMatch[1]);
      const items = (state.collections.find((c) => c.id === cid)?.items ?? []).filter(
        (i) => !state.handled.has(i.mediaServerId),
      );
      return ok({ totalSize: items.length, items });
    }
    if (method === 'GET' && path === '/rules/exclusion') {
      const id = query.mediaServerId;
      const present = id !== undefined && state.exclusions.has(id);
      return ok(present ? [{ id: 1, mediaServerId: id, ruleGroupId: null, parent: id }] : []);
    }

    // writes — exclusions
    if (method === 'POST' && path === '/rules/exclusion') {
      state.exclusions.add(String((body as { mediaId: string }).mediaId));
      return ok({ code: 1 }, 201);
    }
    const rmMatch = path.match(/^\/rules\/exclusions\/(.+)$/);
    if (method === 'DELETE' && rmMatch) {
      state.exclusions.delete(decodeURIComponent(rmMatch[1]!));
      return ok({ code: 1 });
    }
    // writes — per-item delete
    if (method === 'POST' && path === '/collections/media/handle') {
      state.handled.add(String((body as { mediaId: string }).mediaId));
      return ok(null, 201);
    }
    // writes — the Leaving-Soon manual collection surface
    if (method === 'POST' && path === '/collections') return ok({ id: state.nextCollectionId }, 201);
    if (method === 'POST' && path === '/collections/add') return ok(null, 201);
    if (method === 'POST' && path === '/collections/remove') return ok(null, 201);
    if (method === 'POST' && path === '/collections/removeCollection') return ok(null, 201);

    return new Response(JSON.stringify({ message: `no stub for ${key}` }), { status: 404 });
  }) as typeof fetch;

  return {
    bundle: buildMaintainerrClientBundle({
      baseUrl: 'http://maintainerr.test:6246',
      apiKey: 'k',
      retryDelayMs: 0,
      fetchImpl,
    }),
    calls,
  };
}

// ids: 9001 cold-deletable, 9002 recently-watched, 9003 dnd-tagged, 9004 requested, 9009 unresolved.
const RECENT = new Date(Date.now() - 3 * 86_400_000).toISOString();
const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();

function movieCollection(over: Partial<StubCollection> = {}): StubCollection {
  return {
    id: 7,
    isActive: true,
    deleteAfterDays: 30,
    type: 'movie',
    title: 'Least watched movies',
    libraryId: 1,
    items: [
      { mediaServerId: 'ms-9001', tmdbId: 9001, sizeBytes: 4_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9002', tmdbId: 9002, sizeBytes: 3_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9003', tmdbId: 9003, sizeBytes: 2_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9004', tmdbId: 9004, sizeBytes: 1_000_000_000, addDate: '2026-06-01T00:00:00Z' },
      { mediaServerId: 'ms-9009', tmdbId: 9009, sizeBytes: 500_000_000, addDate: '2026-06-01T00:00:00Z' },
    ],
    ...over,
  };
}
const baseState = (over: Partial<MaintState> = {}): MaintState => ({
  integrations: { radarr: true, sonarr: true, tautulli: true, seerr: true },
  plexOk: true,
  reachable: true,
  exclusions: new Set(),
  collections: [movieCollection()],
  handled: new Set(),
  nextCollectionId: 555,
  fail: new Set(),
  ...over,
});

describe('trash curation pipeline (ADR-025 / DESIGN-011)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'batch-admin@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 91, tmdbId: 9001, title: 'Cold Movie', sortTitle: 'cold', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
        { arrItemId: 92, tmdbId: 9002, title: 'Watched Movie', sortTitle: 'watched', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
        { arrItemId: 93, tmdbId: 9003, title: 'Dnd Movie', sortTitle: 'dnd', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m', arrTags: ['dnd'] },
        { arrItemId: 94, tmdbId: 9004, title: 'Requested Movie', sortTitle: 'requested', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
      ],
    });
    const rows = await t.db.select().from(mediaItems);
    const byTmdb = new Map(rows.map((r) => [r.tmdbId, r.id]));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: [
        { mediaItemId: byTmdb.get(9001)!, lastViewedAt: new Date(OLD), resolution: '2160p', imdbRating: 7.5, tmdbRating: 8.1 },
        { mediaItemId: byTmdb.get(9002)!, lastViewedAt: new Date(RECENT) },
        { mediaItemId: byTmdb.get(9003)!, lastViewedAt: new Date(OLD) },
        { mediaItemId: byTmdb.get(9004)!, lastViewedAt: new Date(OLD), requesters: ['alice'] },
      ],
    });
  });
  afterAll(async () => t?.stop());

  // Every test leaves the DB with no OPEN batch (the one-open-per-kind index would block the next).
  afterEach(async () => {
    const open = await t.db
      .select({ id: trashBatches.id })
      .from(trashBatches)
      .where(inArray(trashBatches.state, ['draft', 'admin_review', 'leaving_soon']));
    if (open.length > 0) {
      const { bundle } = makeMaintainerr(baseState());
      for (const b of open) await cancelBatch({ db: t.db, maintainerr: bundle, batchId: b.id, actorId });
    }
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: false, actorId });
  });

  const itemsOf = (batchId: string) =>
    t.db.select().from(trashBatchItems).where(eq(trashBatchItems.batchId, batchId));

  it('createBatchFromPending snapshots the pending set into admin_review (dnd → protected)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const res = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    expect(res.state).toBe('admin_review');
    expect(res.gateSkipped).toBe(false);
    expect(res.itemCount).toBe(5); // all five carry a Maintainerr id

    const items = await itemsOf(res.batchId);
    const byMedia = new Map(items.map((i) => [i.maintainerrMediaId, i]));
    expect(byMedia.get('ms-9003')!.state).toBe('protected'); // dnd-tagged
    expect(byMedia.get('ms-9001')!.state).toBe('pending');
    expect(byMedia.get('ms-9009')!.state).toBe('pending'); // unresolved but still snapshotted
    expect(byMedia.get('ms-9009')!.mediaItemId).toBeNull();

    const events = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_batch_transition'));
    expect(events.some((e) => (e.payload as Record<string, unknown>).to === 'admin_review')).toBe(true);
  });

  it('refuses a second OPEN batch for the same media kind (TrashBatchOpenError)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await expect(
      createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId }),
    ).rejects.toBeInstanceOf(TrashBatchOpenError);
  });

  it('refuses to batch when there is nothing pending (TrashBatchEmptyError)', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [] }));
    await expect(
      createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId }),
    ).rejects.toBeInstanceOf(TrashBatchEmptyError);
  });

  it('greenlightBatch: admin_review → leaving_soon, sets the window + drives the Plex collection', async () => {
    const { bundle, calls } = makeMaintainerr(baseState({ nextCollectionId: 777 }));
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const res = await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: 14, actorId });
    expect(res.state).toBe('leaving_soon');
    expect(res.windowDays).toBe(14);
    expect(res.collectionId).toBe(777);
    // The manual Leaving-Soon collection was created (visible + seeded with the pending items).
    const create = calls.find((c) => c.method === 'POST' && c.pathname === '/collections');
    expect(create).toBeTruthy();
    expect((create!.body as { collection: Record<string, unknown> }).collection.visibleOnHome).toBe(true);
    expect((create!.body as { collection: Record<string, unknown> }).collection.deleteAfterDays).toBeNull();
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.state).toBe('leaving_soon');
    expect(row!.maintainerrCollectionId).toBe(777);
    expect(row!.expiresAt).not.toBeNull();
  });

  it('greenlight REFUSES a batch that is not in admin_review (illegal transition)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, actorId });
    await expect(
      greenlightBatch({ db: t.db, maintainerr: bundle, batchId, actorId }),
    ).rejects.toBeInstanceOf(TrashBatchStateError);
  });

  it('cancelBatch → cancelled (any non-terminal); a terminal batch cannot be cancelled', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, actorId });
    await cancelBatch({ db: t.db, maintainerr: bundle, batchId, actorId });
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.state).toBe('cancelled');
    await expect(
      cancelBatch({ db: t.db, maintainerr: bundle, batchId, actorId }),
    ).rejects.toBeInstanceOf(TrashBatchStateError);
  });

  it('setBatchItemSaved: save protects (exclusion + tuning row) and un-save reverses it', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const items = await itemsOf(batchId);
    const cold = items.find((i) => i.maintainerrMediaId === 'ms-9001')!;

    const saved = await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: cold.id, saved: true, actorId });
    expect(saved).toEqual({ changed: true, state: 'saved' });
    const [afterSave] = await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.id, cold.id));
    expect(afterSave!.state).toBe('saved');
    expect(afterSave!.savedBy).toBe(actorId);
    // Idempotent — saving again is a no-op.
    expect(await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: cold.id, saved: true, actorId })).toEqual({ changed: false, state: 'saved' });
    // Save event + exclusion event recorded.
    const saveRows = await t.db.select().from(trashBatchSaves).where(eq(trashBatchSaves.batchItemId, cold.id));
    expect(saveRows.filter((r) => r.action === 'save')).toHaveLength(1);
    const excl = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_excluded'));
    expect(excl.length).toBeGreaterThanOrEqual(1);

    const unsaved = await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: cold.id, saved: false, actorId });
    expect(unsaved).toEqual({ changed: true, state: 'pending' });
    const unsaveRows = await t.db.select().from(trashBatchSaves).where(and(eq(trashBatchSaves.batchItemId, cold.id), eq(trashBatchSaves.action, 'unsave')));
    expect(unsaveRows).toHaveLength(1);
  });

  it('skip-gate: with the setting ON, createBatch auto-green-lights straight to leaving_soon (audited gate_skipped)', async () => {
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: true, actorId });
    const { bundle } = makeMaintainerr(baseState({ nextCollectionId: 42 }));
    const res = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    expect(res.state).toBe('leaving_soon');
    expect(res.gateSkipped).toBe(true);
    expect(res.expiresAt).not.toBeNull();
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, res.batchId));
    expect(row!.gateSkipped).toBe(true);
    expect(row!.greenlitAt).not.toBeNull();
    // Two transition events for the skip path: draft, then leaving_soon(gateSkipped).
    const evs = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.eventType, 'trash_batch_transition'));
    const forBatch = evs.filter((e) => (e.payload as Record<string, unknown>).batchId === row!.id);
    expect(forBatch.some((e) => (e.payload as Record<string, unknown>).gateSkipped === true)).toBe(true);
  });

  it('sweep REFUSES on an unsafe Maintainerr install (MaintainerrUnsafeError), deletes nothing', async () => {
    const state = baseState();
    const { bundle } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: -1, actorId }); // already expired
    state.integrations.sonarr = false; // required integration down
    await expect(
      sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId }),
    ).rejects.toBeInstanceOf(MaintainerrUnsafeError);
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.state).toBe('leaving_soon'); // untouched
  });

  it('sweep deletes only cold survivors: guardian keeps watched/requested/unevaluable; snapshot captured', async () => {
    const { bundle, calls } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: -1, actorId });
    const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId });

    expect(report.batchesSwept).toBe(1);
    const r = report.batches[0]!;
    expect(r.deletedCount).toBe(1); // only 9001 (cold)
    expect(r.skippedCount).toBe(3); // 9002 watched, 9004 requested, 9009 unevaluable
    expect(r.protectedCount).toBe(1); // 9003 dnd

    // Exactly one per-item handle fired — for the cold item.
    const handles = calls.filter((c) => c.pathname === '/collections/media/handle');
    expect(handles).toHaveLength(1);
    expect((handles[0]!.body as { mediaId: string }).mediaId).toBe('ms-9001');

    const items = await itemsOf(batchId);
    const cold = items.find((i) => i.maintainerrMediaId === 'ms-9001')!;
    expect(cold.state).toBe('deleted');
    expect(cold.deletedSizeBytes).toBe(4_000_000_000);
    expect(cold.deletedResolution).toBe('2160p');
    expect(Number(cold.deletedImdbRating)).toBe(7.5);
    expect(items.find((i) => i.maintainerrMediaId === 'ms-9002')!.state).toBe('skipped');
    expect(items.find((i) => i.maintainerrMediaId === 'ms-9009')!.state).toBe('skipped');

    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.state).toBe('deleted');

    // The deletion wrote a trash_expedited intent event scoped to the batch.
    const exped = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_expedited'));
    expect(exped.some((e) => (e.payload as Record<string, unknown>).batchId === batchId)).toBe(true);
  });

  it('sweep KEEPS a live-excluded (freshly-saved) item and never deletes a saved item', async () => {
    const state = baseState();
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const items = await itemsOf(batchId);
    // Save the cold item (leaves the batch as 'saved') before green-light.
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: items.find((i) => i.maintainerrMediaId === 'ms-9001')!.id, saved: true, actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: -1, actorId });
    const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId });

    expect(report.batches[0]!.deletedCount).toBe(0); // the only cold item was saved
    expect(report.batches[0]!.savedCount).toBe(1);
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false);
    const saved = (await itemsOf(batchId)).find((i) => i.maintainerrMediaId === 'ms-9001')!;
    expect(saved.state).toBe('saved'); // untouched by the sweep
  });

  it('manual expire (batchId) REFUSES a batch whose window has not closed', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: 21, actorId }); // future
    await expect(
      sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId, batchId }),
    ).rejects.toBeInstanceOf(TrashBatchStateError);
  });

  it('listBatches + getBatchDetail + getBatchSaveStats expose the poster-grid + tuning shapes', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const items = await itemsOf(batchId);
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: items.find((i) => i.maintainerrMediaId === 'ms-9004')!.id, saved: true, actorId });

    const list = await listBatches({ db: t.db, mediaKind: 'movie' });
    const summary = list.find((b) => b.id === batchId)!;
    expect(summary.counts.total).toBe(5);
    expect(summary.counts.saved).toBe(1);

    const detail = await getBatchDetail({ db: t.db, batchId });
    expect(detail.items).toHaveLength(5);
    expect(detail.items[0]!.sizeBytes).toBeGreaterThanOrEqual(detail.items[1]!.sizeBytes); // sorted by size desc

    const stats = await getBatchSaveStats({ db: t.db, batchId });
    expect(stats.totalSaves).toBe(1);
    expect(stats.netSaved).toBe(1);
    expect(stats.byUser.some((u) => u.userId === actorId)).toBe(true);
  });
});

describe('app_settings single-writer (ADR-025 C-06)', () => {
  let t: TestDb;
  let actorId: string;
  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'settings@example.com' })).id;
  });
  afterAll(async () => t?.stop());

  it('returns the documented default when unset', async () => {
    expect(await getAppSetting(t.db, 'trash_skip_admin_gate')).toBe(false);
    expect(await getAppSetting(t.db, 'trash_default_window_days')).toBe(21);
  });

  it('setAppSetting upserts the value AND writes an update_app_setting audit row (same tx)', async () => {
    const res = await setAppSetting({ db: t.db, key: 'trash_default_window_days', value: 30, actorId });
    expect(res).toMatchObject({ changed: true, before: 21, after: 30 });
    expect(await getAppSetting(t.db, 'trash_default_window_days')).toBe(30);
    const audit = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ key: 'trash_default_window_days', before: 21, after: 30 });
    // Re-setting the same value reports changed:false.
    expect((await setAppSetting({ db: t.db, key: 'trash_default_window_days', value: 30, actorId })).changed).toBe(false);
  });
});
