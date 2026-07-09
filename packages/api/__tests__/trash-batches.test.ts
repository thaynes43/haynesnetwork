// ADR-025 / DESIGN-011 — the trash.batches + trash.settings surface: the gating matrix (section
// read_only for reads, manage_batches for lifecycle, the PHASE-dependent save gate, admin-only
// settings) + the poster-grid read shape. Embedded PG16 + a fetch-stubbed Maintainerr bundle
// (extended with the manual-collection endpoints). Gates read the session (AC-13), so gating cases
// only need session overrides.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { trashBatches } from '@hnet/db/schema';
import {
  buildMaintainerrClientBundle,
  upsertMediaItemsBatch,
  type MaintainerrClientBundle,
} from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  wireShape,
  type TestDb,
} from './helpers';

function stubMaintainerr(): MaintainerrClientBundle {
  const exclusions = new Set<string>();
  const handled = new Set<string>();
  // ADR-025 — created Leaving-Soon collections (id → title). v3.17.0's create returns void, so the
  // drive re-reads the id from GET /collections by title; the list must surface them.
  const manualCollections = new Map<number, string>();
  let nextManualCollectionId = 900;
  const items = [
    { mediaServerId: 'ms-1', tmdbId: 55001, sizeBytes: 4_000_000_000, addDate: '2026-06-01T00:00:00Z' },
    { mediaServerId: 'ms-2', tmdbId: 55002, sizeBytes: 2_000_000_000, addDate: '2026-06-01T00:00:00Z' },
  ];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const q = Object.fromEntries(url.searchParams.entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const ok = (b: unknown, status = 200) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && path === '/app/status') return ok({ status: 'ok', version: '3.17.0' });
    if (method === 'GET' && path === '/settings/test/plex') return ok({ status: 'OK', code: 1 });
    if (method === 'GET' && path === '/rules/constants')
      return ok({ applications: [{ name: 'Radarr' }, { name: 'Sonarr' }, { name: 'Tautulli' }, { name: 'Overseerr' }] });
    if (method === 'GET' && path === '/rules') return ok([]);
    if (method === 'GET' && path === '/collections')
      return ok([
        { id: 7, isActive: true, deleteAfterDays: 30, type: 'movie', title: 'Least watched', libraryId: 1, media: [] },
        ...[...manualCollections].map(([id, title]) => ({
          id,
          isActive: true,
          deleteAfterDays: 0,
          type: 'movie',
          title,
          libraryId: 1,
          media: [],
        })),
      ]);
    const cm = path.match(/^\/collections\/media\/(\d+)\/content\/(\d+)$/);
    if (method === 'GET' && cm)
      return ok({ totalSize: items.filter((i) => !handled.has(i.mediaServerId)).length, items: items.filter((i) => !handled.has(i.mediaServerId)) });
    if (method === 'GET' && path === '/rules/exclusion')
      return ok(q.mediaServerId !== undefined && exclusions.has(q.mediaServerId) ? [{ id: 1, mediaServerId: q.mediaServerId }] : []);
    if (method === 'POST' && path === '/rules/exclusion') {
      exclusions.add(String((body as { mediaId: string }).mediaId));
      return ok({ code: 1 }, 201);
    }
    const rm = path.match(/^\/rules\/exclusions\/(.+)$/);
    if (method === 'DELETE' && rm) {
      exclusions.delete(decodeURIComponent(rm[1]!));
      return ok({ code: 1 });
    }
    if (method === 'POST' && path === '/collections/media/handle') {
      handled.add(String((body as { mediaId: string }).mediaId));
      return ok(null, 201);
    }
    if (method === 'POST' && path === '/collections') {
      // v3.17.0 create returns NO body (void); register the collection so GET /collections surfaces it
      // for the drive's re-read-by-title.
      const title = String(((body as { collection?: { title?: unknown } })?.collection?.title) ?? '');
      manualCollections.set(++nextManualCollectionId, title);
      return ok(undefined, 201);
    }
    if (method === 'POST' && (path === '/collections/add' || path === '/collections/remove' || path === '/collections/removeCollection'))
      return ok(null, 201);
    return new Response(JSON.stringify({ message: `no stub ${method} ${path}` }), { status: 404 });
  }) as typeof fetch;
  return buildMaintainerrClientBundle({ baseUrl: 'http://maintainerr.test:6246', apiKey: 'k', retryDelayMs: 0, fetchImpl });
}

describe('trash.batches + trash.settings (ADR-025 / DESIGN-011)', () => {
  let t: TestDb;
  let member: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    member = await createUser(t.db, { email: 'batch-member@example.com' });
    admin = await createUser(t.db, { email: 'batch-admin@example.com', admin: true });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        { arrItemId: 71, tmdbId: 55001, title: 'A', sortTitle: 'a', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
        { arrItemId: 72, tmdbId: 55002, title: 'B', sortTitle: 'b', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/m' },
      ],
    });
  });
  afterAll(async () => t?.stop());

  const adminCall = () => caller(makeCtx(t.db, sessionUser(admin), undefined, undefined, stubMaintainerr()));
  const memberCall = (level: 'edit' | 'read_only' | 'disabled', actions: Parameters<typeof sessionUser>[2] = []) =>
    caller(makeCtx(t.db, sessionUser(member, { trash: level }, actions), undefined, undefined, stubMaintainerr()));

  // Leave no OPEN batch behind (one-open-per-kind would block the next create).
  afterEach(async () => {
    const open = await t.db.select({ id: trashBatches.id, state: trashBatches.state }).from(trashBatches);
    const c = adminCall();
    for (const b of open) {
      if (b.state === 'draft' || b.state === 'admin_review' || b.state === 'leaving_soon') {
        await c.trash.batches.cancel({ batchId: b.id });
      }
    }
  });

  it('reads (batches.list) require section read_only — Disabled is FORBIDDEN', async () => {
    await expect(memberCall('disabled').trash.batches.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(memberCall('read_only').trash.batches.list()).resolves.toEqual([]);
  });

  it('create requires manage_batches — a read_only member without it is FORBIDDEN; admin succeeds', async () => {
    await expect(
      memberCall('read_only').trash.batches.create({ mediaKind: 'movie' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const res = await adminCall().trash.batches.create({ mediaKind: 'movie' });
    expect(res.state).toBe('admin_review');
    expect(res.itemCount).toBe(2);
  });

  it('a member GRANTED manage_batches can create + green-light', async () => {
    const c = memberCall('read_only', ['manage_batches']);
    const { batchId } = await c.trash.batches.create({ mediaKind: 'movie' });
    const gl = await c.trash.batches.greenlight({ batchId, windowDays: 14 });
    expect(gl.state).toBe('leaving_soon');
  });

  it('a second open batch for the same kind CONFLICTs (TRASH_BATCH_ALREADY_OPEN)', async () => {
    const c = adminCall();
    await c.trash.batches.create({ mediaKind: 'movie' });
    try {
      await c.trash.batches.create({ mediaKind: 'movie' });
      throw new Error('expected conflict');
    } catch (err) {
      expect(wireShape(err, 'trash.batches.create').data.appCode).toBe('TRASH_BATCH_ALREADY_OPEN');
    }
  });

  it('create with targeting snapshots the greedily-chosen subset (targetBytes, largest-first)', async () => {
    // Stub pool: ms-1 (4e9) + ms-2 (2e9). Target 3e9 largest ⇒ ms-1 alone crosses ⇒ 1 item.
    const res = await adminCall().trash.batches.create({
      mediaKind: 'movie',
      targetBytes: 3_000_000_000,
      strategy: 'largest',
    });
    expect(res.itemCount).toBe(1);
    const detail = await adminCall().trash.batches.get({ batchId: res.batchId });
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.maintainerrMediaId).toBe('ms-1');
  });

  it('force-expire is manage_batches-gated; an admin overrides a still-open window, a member cannot', async () => {
    const admin = adminCall();
    const { batchId } = await admin.trash.batches.create({ mediaKind: 'movie' });
    await admin.trash.batches.greenlight({ batchId, windowDays: 21 }); // FUTURE window (mid-window)

    // A member WITHOUT manage_batches cannot force (nor plain-expire) — FORBIDDEN.
    await expect(
      memberCall('read_only').trash.batches.expire({ batchId, forceOverride: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Even the admin is refused mid-window WITHOUT the override (window not closed → CONFLICT).
    try {
      await admin.trash.batches.expire({ batchId });
      throw new Error('expected conflict');
    } catch (err) {
      expect(wireShape(err, 'trash.batches.expire').data.appCode).toBe('TRASH_BATCH_STATE');
    }

    // WITH the override the admin sweeps NOW → the batch is terminal (its kind slot frees).
    const report = await admin.trash.batches.expire({ batchId, forceOverride: true });
    expect(report.batchesSwept).toBe(1);
    expect(report.batches[0]!.deletedCount).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(trashBatches).where(eq(trashBatches.id, batchId));
    expect(row!.state).toBe('deleted');
  });

  it('batches.get returns the poster-grid shape (posterUrl per resolved item)', async () => {
    const { batchId } = await adminCall().trash.batches.create({ mediaKind: 'movie' });
    const detail = await memberCall('read_only').trash.batches.get({ batchId });
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0]).toHaveProperty('posterUrl');
    expect(detail.counts.total).toBe(2);
  });

  it('setItemSaved is PHASE-gated: admin_review needs manage_batches, leaving_soon needs save_leaving_soon', async () => {
    const { batchId } = await adminCall().trash.batches.create({ mediaKind: 'movie' });
    const detail = await adminCall().trash.batches.get({ batchId });
    const itemId = detail.items[0]!.id;

    // admin_review phase — save_leaving_soon alone is NOT enough; manage_batches is.
    await expect(
      memberCall('read_only', ['save_leaving_soon']).trash.batches.setItemSaved({ batchId, itemId, saved: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await memberCall('read_only', ['manage_batches']).trash.batches.setItemSaved({ batchId, itemId, saved: false });

    // Green-light → leaving_soon phase — now save_leaving_soon works and manage_batches-only does NOT.
    await adminCall().trash.batches.greenlight({ batchId, windowDays: 14 });
    await expect(
      memberCall('read_only', ['manage_batches']).trash.batches.setItemSaved({ batchId, itemId, saved: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ok = await memberCall('read_only', ['save_leaving_soon']).trash.batches.setItemSaved({ batchId, itemId, saved: true });
    expect(ok.state).toBe('saved');
  });

  it('unprotectItem is PHASE-gated exactly like setItemSaved (admin_review→manage_batches, leaving_soon→save_leaving_soon)', async () => {
    // The api layer OWNS the phase gate; the un-protect + reclassification behaviour is proven against a
    // real `protected` item in the @hnet/domain suite (direct guarded-table writes are domain-only).
    const { batchId } = await adminCall().trash.batches.create({ mediaKind: 'movie' });
    const detail = await adminCall().trash.batches.get({ batchId });
    const itemId = detail.items[0]!.id;

    // admin_review phase — save_leaving_soon alone is NOT enough; manage_batches is.
    await expect(
      memberCall('read_only', ['save_leaving_soon']).trash.batches.unprotectItem({ batchId, itemId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A manage_batches holder passes the gate (the item is not protected, so the domain call is an inert no-op).
    const reviewOk = await memberCall('read_only', ['manage_batches']).trash.batches.unprotectItem({ batchId, itemId });
    expect(reviewOk).toHaveProperty('state');

    // Green-light → leaving_soon phase — now save_leaving_soon passes and manage_batches-only does NOT.
    await adminCall().trash.batches.greenlight({ batchId, windowDays: 14 });
    await expect(
      memberCall('read_only', ['manage_batches']).trash.batches.unprotectItem({ batchId, itemId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const windowOk = await memberCall('read_only', ['save_leaving_soon']).trash.batches.unprotectItem({ batchId, itemId });
    expect(windowOk).toHaveProperty('state');
  });

  it('save_exclude (global Save) IMPLIES save_leaving_soon — a save_exclude-only role rescues in the window (ADR-025 errata)', async () => {
    const { batchId } = await adminCall().trash.batches.create({ mediaKind: 'movie' });
    const detail = await adminCall().trash.batches.get({ batchId });
    const itemId = detail.items[0]!.id;
    await adminCall().trash.batches.greenlight({ batchId, windowDays: 14 });
    // The role holds ONLY the anytime whitelist power (save_exclude) — NOT save_leaving_soon — yet the
    // windowed rescue is honored because global Save is a superset (computed, no stored grant).
    const ok = await memberCall('read_only', ['save_exclude']).trash.batches.setItemSaved({ batchId, itemId, saved: true });
    expect(ok.state).toBe('saved');
  });

  it('settings.get/set are admin-only; get returns the documented defaults', async () => {
    await expect(memberCall('edit', ['manage_batches']).trash.settings.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const defaults = await adminCall().trash.settings.get();
    expect(defaults).toMatchObject({ trash_skip_admin_gate: false, trash_default_window_days: 21 });
    const updated = await adminCall().trash.settings.set({ trashDefaultWindowDays: 30, trashSkipAdminGate: true });
    expect(updated).toMatchObject({ trash_skip_admin_gate: true, trash_default_window_days: 30 });
    // reset so the skip-gate does not leak into other tests
    await adminCall().trash.settings.set({ trashSkipAdminGate: false, trashDefaultWindowDays: 21 });
  });
});
