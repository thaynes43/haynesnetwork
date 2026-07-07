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
  TrashSaveNotOwnedError,
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
  /** Test seam (F2): fired on every GET /rules/exclusion — lets a test land a concurrent DB write
   *  (e.g. a Save) in the sweep's window between candidate-select and the guarded item-write. */
  onExclusionCheck?: (mediaServerId: string) => Promise<void> | void;
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
      if (id !== undefined) await state.onExclusionCheck?.(id);
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
    // writes — the Leaving-Soon manual collection surface. This stub enforces v3.17.0's REAL create
    // contracts (verified 2026-07-07): `type` is z.enum(MediaItemTypes) — a STRING (numeric → 400);
    // `arrAction` is REQUIRED; `deleteAfterDays` is z.coerce.number() so null coerces to 0; and the
    // handler returns NO body (void). It also simulates the aging worker: the collection worker's ONLY
    // per-collection skip is arrAction===DO_NOTHING(4), so a collection created with any other arrAction
    // (with deleteAfterDays coerced to 0) would have its WHOLE membership estate-deleted on the next
    // worker run — a loud contract violation the test must never trip (F1 safety inversion).
    if (method === 'POST' && path === '/collections') {
      const payload = (body ?? {}) as {
        collection?: Record<string, unknown>;
        media?: Array<{ mediaServerId: string }>;
      };
      const col = payload.collection ?? {};
      const type = col.type;
      if (typeof type !== 'string' || !['movie', 'show', 'season', 'episode'].includes(type)) {
        return new Response(
          JSON.stringify({ message: `type: expected MediaItemTypes enum string, got ${JSON.stringify(type)}` }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (typeof col.arrAction !== 'number') {
        return new Response(JSON.stringify({ message: 'arrAction: Required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const rawDelete = col.deleteAfterDays;
      const coerced = rawDelete === undefined || rawDelete === null ? 0 : Number(rawDelete);
      if (col.arrAction !== 4) {
        throw new Error(
          `STUB CONTRACT VIOLATION (Maintainerr v3.17.0): Leaving-Soon collection ${JSON.stringify(col.title)} ` +
            `created with arrAction=${col.arrAction} (≠ DO_NOTHING=4) and deleteAfterDays ` +
            `${JSON.stringify(rawDelete)}→${coerced}; the estate aging worker would delete all ` +
            `${(payload.media ?? []).length} members on its next run.`,
        );
      }
      const id = state.nextCollectionId;
      state.collections.push({
        id,
        isActive: true,
        deleteAfterDays: coerced,
        type,
        title: String(col.title ?? ''),
        libraryId: Number(col.libraryId ?? 0),
        items: (payload.media ?? []).map((m) => ({
          mediaServerId: m.mediaServerId,
          sizeBytes: 0,
          addDate: new Date().toISOString(),
        })),
      });
      return ok(undefined, 201); // v3.17.0 create returns NO body
    }
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
    const createdCollection = (create!.body as { collection: Record<string, unknown> }).collection;
    expect(createdCollection.visibleOnHome).toBe(true);
    // F1 — the create body carries the VERIFIED v3.17.0 contract: arrAction DO_NOTHING(4) (the worker's
    // only skip) + the STRING MediaItemTypes `type`. Its id is re-read via GET /collections (void create).
    expect(createdCollection.arrAction).toBe(4);
    expect(createdCollection.type).toBe('movie');
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

  it('un-save during leaving_soon is owner-or-manager only (DESIGN-011 D-05 — TrashSaveNotOwnedError)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const memberA = (await createUser(t.db, { email: 'familyA@example.com' })).id;
    const memberB = (await createUser(t.db, { email: 'familyB@example.com' })).id;
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    // Open window (future expiry) — the family save exercise is live.
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: 14, actorId });
    const items = await itemsOf(batchId);
    const itemA = items.find((i) => i.maintainerrMediaId === 'ms-9001')!;
    const itemB = items.find((i) => i.maintainerrMediaId === 'ms-9004')!;

    // Family member A rescues item A (save is ungated — anyone with the window grant may lock).
    const savedA = await setBatchItemSaved({
      db: t.db, maintainerr: bundle, batchId, itemId: itemA.id, saved: true, actorId: memberA, callerCanManage: false,
    });
    expect(savedA).toEqual({ changed: true, state: 'saved' });
    const [rowA] = await t.db.select().from(trashBatchItems).where(eq(trashBatchItems.id, itemA.id));
    expect(rowA!.savedBy).toBe(memberA);

    // Family member B (save_leaving_soon only) CANNOT un-save A's rescue → FORBIDDEN.
    await expect(
      setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: itemA.id, saved: false, actorId: memberB, callerCanManage: false }),
    ).rejects.toBeInstanceOf(TrashSaveNotOwnedError);
    // Fail-closed BEFORE any external release — item A stays saved.
    expect((await itemsOf(batchId)).find((i) => i.id === itemA.id)!.state).toBe('saved');

    // B CAN un-save B's OWN rescue.
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: itemB.id, saved: true, actorId: memberB, callerCanManage: false });
    const unsaveOwn = await setBatchItemSaved({
      db: t.db, maintainerr: bundle, batchId, itemId: itemB.id, saved: false, actorId: memberB, callerCanManage: false,
    });
    expect(unsaveOwn).toEqual({ changed: true, state: 'pending' });

    // A manager (manage_batches/admin ⇒ callerCanManage) can un-save ANYONE's rescue — A's item.
    const unsaveByManager = await setBatchItemSaved({
      db: t.db, maintainerr: bundle, batchId, itemId: itemA.id, saved: false, actorId, callerCanManage: true,
    });
    expect(unsaveByManager).toEqual({ changed: true, state: 'pending' });
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

  it('getBatchSaveStats is NET: save→unsave→save = 1 saved; save→unsave = 0 saved (churn never inflates)', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const items = await itemsOf(batchId);
    const kept = items.find((i) => i.maintainerrMediaId === 'ms-9001')!;
    const dropped = items.find((i) => i.maintainerrMediaId === 'ms-9004')!;

    // Item A: save → unsave → save ⇒ nets to 1 save (still held). Item B: save → unsave ⇒ nets to 0.
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: kept.id, saved: true, actorId });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: kept.id, saved: false, actorId });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: kept.id, saved: true, actorId });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: dropped.id, saved: true, actorId });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: dropped.id, saved: false, actorId });

    const stats = await getBatchSaveStats({ db: t.db, batchId });
    expect(stats.totalSaves).toBe(1); // NOT 3 raw saves — only item A is currently held
    expect(stats.netSaved).toBe(1);
    expect(stats.totalUnsaves).toBe(1); // NOT 3 raw unsaves — only item B is net-released
    expect(stats.byUser.find((u) => u.userId === actorId)).toMatchObject({ saves: 1, unsaves: 1 });

    // The raw audit log is intact — every flip is still recorded (the PLAN-014 tuning dataset).
    const events = await t.db
      .select()
      .from(trashBatchSaves)
      .innerJoin(trashBatchItems, eq(trashBatchItems.id, trashBatchSaves.batchItemId))
      .where(eq(trashBatchItems.batchId, batchId));
    expect(events).toHaveLength(5); // A: save,unsave,save + B: save,unsave
  });

  it('getBatchSaveStats is NET: a two-user tug-of-war is attributed to the FINAL holder only', async () => {
    const { bundle } = makeMaintainerr(baseState());
    const alice = (await createUser(t.db, { email: 'tug-alice@example.com' })).id;
    const bob = (await createUser(t.db, { email: 'tug-bob@example.com' })).id;
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const contested = (await itemsOf(batchId)).find((i) => i.maintainerrMediaId === 'ms-9001')!;

    // Alice saves, Alice unsaves, Bob saves ⇒ Bob holds it (and only Bob is credited).
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: contested.id, saved: true, actorId: alice });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: contested.id, saved: false, actorId: alice });
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: contested.id, saved: true, actorId: bob });

    const held = await getBatchSaveStats({ db: t.db, batchId });
    expect(held.totalSaves).toBe(1);
    expect(held.totalUnsaves).toBe(0); // currently saved — nobody nets an un-save
    expect(held.byUser).toHaveLength(1);
    expect(held.byUser[0]).toMatchObject({ userId: bob, saves: 1, unsaves: 0 });

    // Bob releases it last ⇒ now a net un-save credited to Bob; nobody nets a save.
    await setBatchItemSaved({ db: t.db, maintainerr: bundle, batchId, itemId: contested.id, saved: false, actorId: bob });
    const released = await getBatchSaveStats({ db: t.db, batchId });
    expect(released.totalSaves).toBe(0);
    expect(released.totalUnsaves).toBe(1);
    expect(released.byUser).toHaveLength(1);
    expect(released.byUser[0]).toMatchObject({ userId: bob, saves: 0, unsaves: 1 });
  });

  it('F1 — green-light re-reads the collection id via GET /collections (void create) and is idempotent', async () => {
    // Pre-seed a Leaving-Soon collection with OUR exact title — models a retry after a crash between
    // create and the DB commit. The drive must REUSE it (no duplicate create).
    const state = baseState({ nextCollectionId: 8123 });
    state.collections.push({
      id: 8123,
      isActive: true,
      deleteAfterDays: 0,
      type: 'movie',
      title: 'Leaving Soon — Movies',
      libraryId: 1,
      items: [],
    });
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    const res = await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: 7, actorId });
    // Reused the pre-existing collection's id — NO create POST fired; membership topped up via add.
    expect(res.collectionId).toBe(8123);
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/collections')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/collections/add')).toBe(true);
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.maintainerrCollectionId).toBe(8123);
  });

  it('F2 — a Save landing mid-sweep (after candidate-select) is NOT deleted (guarded item-write)', async () => {
    const state = baseState();
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: -1, actorId });
    const cold = (await itemsOf(batchId)).find((i) => i.maintainerrMediaId === 'ms-9001')!;
    // The sweep captures ms-9001 as a pending candidate, THEN (during its live-exclusion check, which
    // runs before the guarded delete-write) a concurrent Save flips the row to 'saved'. The guarded
    // `... AND state='pending'` write must claim 0 rows ⇒ skip the delete + the handle.
    let flipped = false;
    state.onExclusionCheck = async (id) => {
      if (id === 'ms-9001' && !flipped) {
        flipped = true;
        await t.db
          .update(trashBatchItems)
          .set({ state: 'saved', savedBy: actorId, savedAt: new Date() })
          .where(eq(trashBatchItems.id, cold.id));
      }
    };
    const report = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId });
    const r = report.batches[0]!;
    expect(r.deletedCount).toBe(0); // the only cold item was saved just in time
    expect(r.raceSkipped).toBe(1);
    expect(calls.some((c) => c.pathname === '/collections/media/handle')).toBe(false); // no handle fired
    const after = (await itemsOf(batchId)).find((i) => i.maintainerrMediaId === 'ms-9001')!;
    expect(after.state).toBe('saved'); // the guarded write did NOT overwrite 'saved' with 'deleted'
    // No trash_expedited intent event was written for the raced item IN THIS batch (the shared ledger
    // carries expedite events from earlier tests — scope by batchId).
    const exped = await t.db.select().from(ledgerEvents).where(eq(ledgerEvents.eventType, 'trash_expedited'));
    expect(
      exped.some((e) => {
        const p = e.payload as Record<string, unknown>;
        return p.batchId === batchId && p.maintainerrMediaId === 'ms-9001';
      }),
    ).toBe(false);
  });

  it('F3 — the sweep aborts after 3 consecutive handle failures and resumes on the next sweep', async () => {
    // Four cold, ledger-resolved movies in their own collection; every per-item handle fails.
    const tmdbs = [9101, 9102, 9103, 9104];
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: tmdbs.map((tmdb, i) => ({
        arrItemId: 200 + i,
        tmdbId: tmdb,
        title: `Cold ${tmdb}`,
        sortTitle: `cold${tmdb}`,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/m',
      })),
    });
    const rows = await t.db.select().from(mediaItems);
    const byTmdb = new Map(rows.map((r) => [r.tmdbId, r.id]));
    await upsertMediaMetadataBatch({
      db: t.db,
      rows: tmdbs.map((tmdb) => ({ mediaItemId: byTmdb.get(tmdb)!, lastViewedAt: new Date(OLD), resolution: '1080p' })),
    });
    const coldCollection = {
      id: 70,
      isActive: true,
      deleteAfterDays: 30,
      type: 'movie',
      title: 'Cold movies',
      libraryId: 1,
      items: tmdbs.map((tmdb) => ({ mediaServerId: `ms-${tmdb}`, tmdbId: tmdb, sizeBytes: 1_000_000_000, addDate: '2026-06-01T00:00:00Z' })),
    };
    const state = baseState({
      collections: [coldCollection],
      nextCollectionId: 606,
      fail: new Set(['POST /collections/media/handle']),
    });
    const { bundle, calls } = makeMaintainerr(state);
    const { batchId } = await createBatchFromPending({ db: t.db, maintainerr: bundle, mediaKind: 'movie', actorId });
    await greenlightBatch({ db: t.db, maintainerr: bundle, batchId, windowDays: -1, actorId });

    const first = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId });
    const r = first.batches[0]!;
    expect(r.aborted).toBe(true);
    expect(r.handleErrors).toBe(3); // stopped at the 3rd consecutive failure
    expect(r.deletedCount).toBe(3);
    expect(calls.filter((c) => c.pathname === '/collections/media/handle')).toHaveLength(3);
    // The batch is LEFT open for resume; one item remains pending.
    const [mid] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(mid!.state).toBe('leaving_soon');
    expect((await itemsOf(batchId)).filter((i) => i.state === 'pending')).toHaveLength(1);

    // Next sweep with the handle healthy resumes the remaining pending item and closes the batch.
    state.fail.delete('POST /collections/media/handle');
    const second = await sweepExpiredBatches({ db: t.db, maintainerr: bundle, actorId });
    expect(second.batches[0]!.aborted).toBe(false);
    expect(second.batches[0]!.deletedCount).toBe(1);
    const [done] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(done!.state).toBe('deleted');
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
