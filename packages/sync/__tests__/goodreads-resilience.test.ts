// ADR-057 amend (goodreads-sync resilience) — a transient upstream blip on a Goodreads shelf must NOT flip
// the integration to 'error' (which the UI renders as "unlinked" and which used to drop the row out of the
// hourly worklist forever). Proves the run-level behaviors: (1) a 502 on ONE shelf keeps the link, syncs
// the rest, and tombstones nothing on the un-read shelf; (2) ALL shelves blipping keeps the link WITHOUT
// advancing last_synced_at; (3) an existing 'error' row past its backoff is retried and self-heals to
// 'linked' on a clean run; (4) an 'error' row retried past its backoff that blips on EVERY shelf again
// stays 'error', records the note, and BUMPS updated_at so the persistently-5xx profile is held back
// another backoff window (self-heal + backoff composed — not hammered). Embedded PG16; RSS/GB stubbed
// offline (ADR-010).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { integrationShelfItems, permissionAudit, userIntegrations } from '@hnet/db';
import { linkIntegration, markIntegrationSynced } from '@hnet/domain';
import { GoodreadsHttpError, type GoodreadsRssClient, type GoogleBooksClient } from '@hnet/goodreads';
import { runGoodreadsSync } from '../src/goodreads';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(permissionAudit);
});

// A GB stub that never matches — items mirror honestly un-enriched (gbVolumeId null). Keeps the resilience
// tests focused on the READ path, not enrichment.
const gbNoMatch = { resolveVolume: async () => null } as unknown as GoogleBooksClient;

type ShelfBehavior =
  | { items: Array<{ id: string; title: string; author?: string }> }
  | { throw: unknown };

/** Per-shelf RSS stub: a shelf returns its items, throws a configured error, or (absent) reads empty. */
function stubRss(shelves: Record<string, ShelfBehavior>): GoodreadsRssClient {
  return {
    fetchShelf: async (_userId: string, shelf: string) => {
      const b = shelves[shelf];
      if (!b) return [];
      if ('throw' in b) throw b.throw;
      return b.items.map((i) => ({
        externalBookId: i.id,
        title: i.title,
        author: i.author ?? null,
        isbn: null,
        coverUrl: null,
        shelvedAt: null,
      }));
    },
  } as unknown as GoodreadsRssClient;
}

async function linkTwoShelfIntegration(externalUserId: string, shelves: string[]): Promise<string> {
  const user = await createUser(t.db);
  const { integration } = await linkIntegration({
    db: t.db,
    userId: user.id,
    provider: 'goodreads',
    externalUserId,
    profileRef: `https://www.goodreads.com/user/show/${externalUserId}`,
    shelves,
    actorId: user.id,
  });
  return integration.id;
}

const T0 = new Date('2026-07-16T00:00:00Z');
const T1 = new Date('2026-07-16T01:00:00Z');
const T2 = new Date('2026-07-16T02:00:00Z');

describe('runGoodreadsSync — transient shelf blip keeps the link (ADR-057 amend)', () => {
  it('a 502 on ONE shelf keeps status linked, syncs the rest, tombstones nothing, then recovers', async () => {
    const integrationId = await linkTwoShelfIntegration('42', ['to-read', 'read']);

    // Run 1 (both clean) — both shelves mirror their items and last_synced_at advances to T0.
    await runGoodreadsSync({
      db: t.db,
      now: T0,
      goodreads: {
        rss: stubRss({
          'to-read': { items: [{ id: 'tr1', title: 'To Read One' }] },
          read: { items: [{ id: 'rd1', title: 'Read One' }] },
        }),
        googleBooks: gbNoMatch,
      },
    });
    const readBefore = await t.db
      .select()
      .from(integrationShelfItems)
      .where(eq(integrationShelfItems.shelf, 'read'));
    expect(readBefore).toHaveLength(1);
    expect(readBefore[0]!.deletedAt).toBeNull();

    // Run 2 (blip) — 'read' throws a transient 502; 'to-read' still returns its item.
    const report = await runGoodreadsSync({
      db: t.db,
      now: T1,
      goodreads: {
        rss: stubRss({
          'to-read': { items: [{ id: 'tr1', title: 'To Read One' }] },
          read: { throw: new GoodreadsHttpError(502, 'http://gr/review/list_rss/42?shelf=read') },
        }),
        googleBooks: gbNoMatch,
      },
    });

    const [row] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('linked'); // NEVER flipped to 'error'
    expect(row!.lastSyncError).toContain('502'); // the soft note
    expect(row!.lastSyncedAt?.getTime()).toBe(T1.getTime()); // partial success advanced it
    expect(report.synced).toBe(1);
    expect(report.transientBlips).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.perIntegration[0]).toMatchObject({ ok: true });
    expect(report.perIntegration[0]!.blip).toContain('502');

    // The un-read 'read' shelf's mirror row is NOT tombstoned; 'to-read' is still live.
    const readAfter = await t.db
      .select()
      .from(integrationShelfItems)
      .where(eq(integrationShelfItems.shelf, 'read'));
    expect(readAfter).toHaveLength(1);
    expect(readAfter[0]!.deletedAt).toBeNull();
    const toReadLive = (
      await t.db
        .select()
        .from(integrationShelfItems)
        .where(eq(integrationShelfItems.shelf, 'to-read'))
    ).filter((r) => r.deletedAt === null);
    expect(toReadLive).toHaveLength(1);

    // Run 3 (both clean again) — it retried and recovered; the soft note clears.
    await runGoodreadsSync({
      db: t.db,
      now: T2,
      goodreads: {
        rss: stubRss({
          'to-read': { items: [{ id: 'tr1', title: 'To Read One' }] },
          read: { items: [{ id: 'rd1', title: 'Read One' }] },
        }),
        googleBooks: gbNoMatch,
      },
    });
    const [recovered] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(recovered!.status).toBe('linked');
    expect(recovered!.lastSyncError).toBeNull();
    expect(recovered!.lastSyncedAt?.getTime()).toBe(T2.getTime());
  });

  it('ALL shelves blipping keeps the link, notes the blip, and does NOT advance last_synced_at', async () => {
    const integrationId = await linkTwoShelfIntegration('43', ['to-read', 'read']);

    const report = await runGoodreadsSync({
      db: t.db,
      now: T1,
      goodreads: {
        rss: stubRss({
          'to-read': { throw: new GoodreadsHttpError(503, 'http://gr/review/list_rss/43?shelf=to-read') },
          read: { throw: new GoodreadsHttpError(503, 'http://gr/review/list_rss/43?shelf=read') },
        }),
        googleBooks: gbNoMatch,
      },
    });

    const [row] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('linked'); // still linked
    expect(row!.lastSyncError).toContain('503');
    expect(row!.lastSyncedAt).toBeNull(); // NOT advanced — nothing was truthfully read
    expect(report.synced).toBe(0);
    expect(report.transientBlips).toBe(1);
    expect(report.failed).toBe(0);

    // No orchestrator ran ⇒ no mirror rows created / tombstoned.
    const mirror = await t.db.select().from(integrationShelfItems);
    expect(mirror).toHaveLength(0);
  });

  it('an existing "error" row past its backoff is retried on the worklist and self-heals to "linked"', async () => {
    const integrationId = await linkTwoShelfIntegration('44', ['to-read']);
    // Break it AND stamp updated_at > ERROR_RETRY_BACKOFF_MS ago (via the domain writer's `now`) so the
    // worklist deems it due — no direct guarded-table write from the test.
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await markIntegrationSynced({ db: t.db, integrationId, error: 'boom', now: stale });

    const report = await runGoodreadsSync({
      db: t.db,
      goodreads: {
        rss: stubRss({ 'to-read': { items: [{ id: 'x1', title: 'X One' }] } }),
        googleBooks: gbNoMatch,
      },
    });

    const [row] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('linked'); // upgraded 'error' → 'linked'
    expect(row!.lastSyncError).toBeNull();
    expect(row!.lastSyncedAt).not.toBeNull();
    expect(report.integrations).toBe(1); // it WAS on the worklist (self-heal)
    expect(report.synced).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('an "error" row retried past its backoff that blips on EVERY shelf again STAYS "error", records the note, bumps updated_at, and is held back another backoff window (not hammered)', async () => {
    // The composition of self-heal + backoff the per-unit tests miss: a genuinely-broken row is re-attempted
    // once it ages past ERROR_RETRY_BACKOFF_MS, but a re-attempt that only hits transient blips must NOT
    // reset the backoff clock to "always due" — it records the blip, keeps status 'error', and BUMPS
    // updated_at so a persistently-5xx profile is spaced out (retried ~hourly-cron at the backoff cadence),
    // never hammered every run.
    const integrationId = await linkTwoShelfIntegration('46', ['to-read', 'read']);

    // Break it and stamp updated_at 7h before the run clock (> the 6h backoff), so the worklist deems it
    // due at T. Every write goes through the domain writer's `now` — no direct guarded-table write here.
    const T = new Date('2026-07-16T12:00:00Z');
    const stale = new Date(T.getTime() - 7 * 60 * 60 * 1000); // 7h ago → past backoff → due at T
    await markIntegrationSynced({ db: t.db, integrationId, error: 'boom', now: stale });

    const allShelvesBlip = stubRss({
      'to-read': { throw: new GoodreadsHttpError(503, 'http://gr/review/list_rss/46?shelf=to-read') },
      read: { throw: new GoodreadsHttpError(502, 'http://gr/review/list_rss/46?shelf=read') },
    });

    // Run at T: the row IS re-attempted (past backoff), but EVERY shelf blips transiently again.
    const report = await runGoodreadsSync({
      db: t.db,
      now: T,
      goodreads: { rss: allShelvesBlip, googleBooks: gbNoMatch },
    });

    const [row] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(report.integrations).toBe(1); // it WAS on the worklist (retried past backoff)
    expect(row!.status).toBe('error'); // a transient re-blip does NOT self-heal — still 'error'
    expect(row!.lastSyncError).toMatch(/HTTP 50[23]/); // the soft blip note is (re)recorded
    expect(row!.lastSyncedAt).toBeNull(); // never advanced — nothing was truthfully read
    expect(row!.updatedAt.getTime()).toBe(T.getTime()); // BUMPED to the run clock (from the 7h-stale stamp)
    expect(report.transientBlips).toBe(1);
    expect(report.synced).toBe(0);
    expect(report.failed).toBe(0); // a blip is NOT a failure — the row was not hammered into a fresh error

    // No orchestrator ran ⇒ no mirror rows created / tombstoned.
    const mirror = await t.db.select().from(integrationShelfItems);
    expect(mirror).toHaveLength(0);

    // The bumped updated_at holds it back: a SECOND run one hour later (still inside the 6h backoff) does
    // NOT re-attempt it — the persistently-5xx profile is spaced out, not hammered every run.
    const soon = new Date(T.getTime() + 60 * 60 * 1000); // T + 1h < 6h backoff
    const report2 = await runGoodreadsSync({
      db: t.db,
      now: soon,
      goodreads: { rss: allShelvesBlip, googleBooks: gbNoMatch },
    });
    expect(report2.integrations).toBe(0); // off the worklist — held back another backoff window
    const [row2] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(row2!.updatedAt.getTime()).toBe(T.getTime()); // untouched by the skipped (non-)run
  });

  it('a PERMANENT failure (a built-in shelf 404 — profile private/deleted) still flips to "error"', async () => {
    const integrationId = await linkTwoShelfIntegration('45', ['to-read', 'read']);

    const report = await runGoodreadsSync({
      db: t.db,
      now: T1,
      goodreads: {
        rss: stubRss({
          'to-read': { throw: new GoodreadsHttpError(404, 'http://gr/review/list_rss/45?shelf=to-read') },
          read: { items: [{ id: 'rd1', title: 'Read One' }] },
        }),
        googleBooks: gbNoMatch,
      },
    });

    const [row] = await t.db
      .select()
      .from(userIntegrations)
      .where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('error'); // genuinely broken profile still surfaces
    expect(row!.lastSyncError).toContain('404');
    expect(row!.lastSyncedAt).toBeNull(); // never advanced — we threw before the orchestrator
    expect(report.failed).toBe(1);
    expect(report.synced).toBe(0);
    expect(report.transientBlips).toBe(0);
    // No partial mirror was written for a permanently-broken profile.
    const mirror = await t.db.select().from(integrationShelfItems);
    expect(mirror).toHaveLength(0);
  });
});
