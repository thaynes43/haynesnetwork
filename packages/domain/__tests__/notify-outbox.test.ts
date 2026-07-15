// ADR-034 / DESIGN-015 (PLAN-016) — Pushover batch-lifecycle notifications. Proves the DELIVERY-WINDOW
// math (inside/before/after · timezone · day-before-expiry reminder · sub-1-day clamp), the SAME-TX
// enqueue from the batch writers (batch_created on create; batch_leaving_soon + reminder on green-light;
// rollback ⇒ no row; policy source), the DRAINER (marks sent / backoff+park on failure / NO-CREDS
// no-op with rows untouched / rendered copy + deep-link), and the audited settings read/write.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { notificationOutbox, permissionAudit, trashBatches } from '@hnet/db/schema';
import {
  computeEarliestSend,
  computeReminderSend,
  createBatchFromPending,
  deliverOutbox,
  getFinalWarning,
  getNotifyWindow,
  greenlightBatch,
  renderOutboxEmail,
  renderOutboxMessage,
  setAppSetting,
  smtpSenderFromEnv,
  type NotifyWindow,
  type OutboxMessage,
} from '../src/index';
import { baseState, makeMaintainerr, movieCollection } from './maintainerr-stub';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const ET: NotifyWindow = { startHour: 18, endHour: 22, tz: 'America/New_York' };

// ---------------------------------------------------------------------------
// 1. Delivery-window math (pure — no DB)
// ---------------------------------------------------------------------------

describe('delivery-window math (T-101)', () => {
  it('inside the window ⇒ send ASAP (returns now)', () => {
    // 2026-07-08 20:00 EDT (UTC-4) — hour 20 is in [18,22).
    const now = new Date('2026-07-09T00:00:00.000Z');
    expect(computeEarliestSend(now, ET).getTime()).toBe(now.getTime());
  });

  it('before the window opens ⇒ today at startHour in tz', () => {
    // 2026-07-08 10:00 EDT — before 18:00 ET; window opens today 18:00 EDT = 22:00Z.
    const now = new Date('2026-07-08T14:00:00.000Z');
    expect(computeEarliestSend(now, ET).toISOString()).toBe('2026-07-08T22:00:00.000Z');
  });

  it('at/after the window closes ⇒ tomorrow at startHour in tz', () => {
    // 2026-07-08 23:00 EDT — past 22:00 ET; next open tomorrow (07-09) 18:00 EDT = 07-09 22:00Z.
    const now = new Date('2026-07-09T03:00:00.000Z');
    expect(computeEarliestSend(now, ET).toISOString()).toBe('2026-07-09T22:00:00.000Z');
  });

  it('reminder = window-open on the day BEFORE expiry (in tz)', () => {
    const expiresAt = new Date('2026-09-04T12:00:00.000Z'); // a September expiry (still EDT)
    const now = new Date('2026-08-01T00:00:00.000Z');
    // Day before = 2026-09-03, 18:00 EDT = 22:00Z.
    expect(computeReminderSend(expiresAt, ET, now).toISOString()).toBe('2026-09-03T22:00:00.000Z');
  });

  it('reminder clamps forward when the day-before slot is already past (window < ~1 day)', () => {
    const now = new Date('2026-07-08T14:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 12 * 3_600_000); // ~12h window
    // The day-before window-open is in the past ⇒ clamp to the next window-open (== computeEarliestSend).
    expect(computeReminderSend(expiresAt, ET, now).getTime()).toBe(
      computeEarliestSend(now, ET).getTime(),
    );
  });

  it('an inverted/garbage window falls back to the default pair (never empty)', () => {
    const bad = { startHour: 22, endHour: 6, tz: 'America/New_York' } as NotifyWindow;
    const now = new Date('2026-07-08T14:00:00.000Z'); // 10:00 ET
    // Inverted (start >= end) ⇒ both hours revert to the default pair, now ALL-DAY [0,24) ⇒ ASAP.
    expect(computeEarliestSend(now, bad).getTime()).toBe(now.getTime());
  });
});

// ---------------------------------------------------------------------------
// 2. Enqueue — same-tx from the batch writers
// ---------------------------------------------------------------------------

describe('enqueue (same-tx from the batch writers)', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (
      await createUser(t.db, { email: 'notify-admin@example.com', displayName: 'Notify Admin' })
    ).id;
  });
  afterAll(async () => t?.stop());

  beforeEach(async () => {
    await t.db.delete(notificationOutbox);
    await t.db.delete(trashBatches); // cascades items + saves
    // A wide window so every enqueue is "in-window" (earliest_send_at = now) — deterministic.
    await setAppSetting({
      db: t.db,
      key: 'notify_window',
      value: { startHour: 0, endHour: 24, tz: 'UTC' },
      actorId,
    });
    await setAppSetting({ db: t.db, key: 'trash_skip_admin_gate', value: false, actorId });
  });
  afterEach(async () => {
    await t.db.delete(trashBatches);
  });

  it('createBatchFromPending enqueues ONE batch_created row (payload counts + bytes)', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
    });

    const rows = await t.db.select().from(notificationOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('batch_created');
    expect(rows[0]!.channel).toBe('pushover');
    expect(rows[0]!.sentAt).toBeNull();
    const p = rows[0]!.payload as Record<string, unknown>;
    expect(p.batchId).toBe(created.batchId);
    expect(p.mediaKind).toBe('movie');
    expect(p.itemCount).toBe(3);
    expect(p.totalBytes).toBe(9_000_000_000); // 4e9 + 3e9 + 2e9
    expect(p.source).toBe('manual');
  });

  it('greenlightBatch enqueues batch_leaving_soon + batch_leaving_soon_reminder (with the deadline)', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
    });
    await t.db.delete(notificationOutbox); // drop the create ping — assert only the green-light pings

    const promoted = await greenlightBatch({
      db: t.db,
      maintainerr: bundle,
      batchId: created.batchId,
      windowDays: 21,
      actorId,
    });

    const rows = await t.db.select().from(notificationOutbox);
    const types = rows.map((r) => r.eventType).sort();
    // The final-warning ping (ON by default, DESIGN-015) rides along on a window ≫ its 2h lead.
    expect(types).toEqual([
      'batch_final_warning',
      'batch_leaving_soon',
      'batch_leaving_soon_reminder',
    ]);
    for (const r of rows) {
      const p = r.payload as Record<string, unknown>;
      expect(p.batchId).toBe(created.batchId);
      expect(p.expiresAt).toBe(promoted.expiresAt);
      expect(p.pendingCount).toBe(3);
      expect(p.pendingBytes).toBe(9_000_000_000);
    }
    // The reminder is scheduled for the day BEFORE expiry (earlier than the immediate notice).
    const reminder = rows.find((r) => r.eventType === 'batch_leaving_soon_reminder')!;
    const notice = rows.find((r) => r.eventType === 'batch_leaving_soon')!;
    expect(reminder.earliestSendAt.getTime()).toBeGreaterThan(notice.earliestSendAt.getTime());
  });

  it('green-light enqueues a batch_final_warning at expires_at − N hours (DESIGN-015 amendment)', async () => {
    // N is READ AT GREEN-LIGHT (default { enabled:true, hoursBefore:2 }, unset here).
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
    });
    await t.db.delete(notificationOutbox);

    const promoted = await greenlightBatch({
      db: t.db,
      maintainerr: bundle,
      batchId: created.batchId,
      windowDays: 21, // 504h window ≫ the 2h lead ⇒ enqueued
      actorId,
    });

    const rows = await t.db.select().from(notificationOutbox);
    const finalWarn = rows.find((r) => r.eventType === 'batch_final_warning');
    expect(finalWarn).toBeDefined();
    // earliest_send_at == expires_at − 2h EXACTLY (deadline-relative, NOT run through the quiet-hours window).
    expect(finalWarn!.earliestSendAt.getTime()).toBe(
      Date.parse(promoted.expiresAt) - 2 * 3_600_000,
    );
    const p = finalWarn!.payload as Record<string, unknown>;
    expect(p.pendingCount).toBe(3);
    expect(p.expiresAt).toBe(promoted.expiresAt);
  });

  it('SKIPS the final warning when the window is shorter than N hours', async () => {
    // N = 48h but the window is 1 day (24h) ⇒ expires_at − 48h is already past ⇒ no row.
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: true, hoursBefore: 48 },
      actorId,
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
    });
    await t.db.delete(notificationOutbox);
    await greenlightBatch({
      db: t.db,
      maintainerr: bundle,
      batchId: created.batchId,
      windowDays: 1,
      actorId,
    });
    const rows = await t.db.select().from(notificationOutbox);
    expect(rows.some((r) => r.eventType === 'batch_final_warning')).toBe(false);
    // The leaving-soon + reminder rows still enqueue (only the final warning is window-gated).
    expect(rows.some((r) => r.eventType === 'batch_leaving_soon')).toBe(true);
    // Reset for the sibling tests.
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: true, hoursBefore: 2 },
      actorId,
    });
  });

  it('enqueues NO final warning when the setting is disabled', async () => {
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: false, hoursBefore: 2 },
      actorId,
    });
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    const created = await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
    });
    await t.db.delete(notificationOutbox);
    await greenlightBatch({
      db: t.db,
      maintainerr: bundle,
      batchId: created.batchId,
      windowDays: 21,
      actorId,
    });
    const rows = await t.db.select().from(notificationOutbox);
    expect(rows.some((r) => r.eventType === 'batch_final_warning')).toBe(false);
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: true, hoursBefore: 2 },
      actorId,
    });
  });

  it('source: policy is recorded on the batch_created row (space policy reuses createBatchFromPending)', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    await createBatchFromPending({
      db: t.db,
      maintainerr: bundle,
      mediaKind: 'movie',
      actorId,
      source: 'policy',
    });
    const [row] = await t.db.select().from(notificationOutbox);
    expect((row!.payload as Record<string, unknown>).source).toBe('policy');
  });

  it('a rolled-back create writes NO outbox row (atomic with the transition)', async () => {
    const { bundle } = makeMaintainerr(baseState({ collections: [movieCollection()] }));
    class Rollback extends Error {}
    await t.db
      .transaction(async (tx) => {
        await createBatchFromPending({ db: tx, maintainerr: bundle, mediaKind: 'movie', actorId });
        // Inside the tx BOTH the batch and its outbox row exist...
        expect(await tx.select().from(notificationOutbox)).toHaveLength(1);
        expect(await tx.select().from(trashBatches)).toHaveLength(1);
        throw new Rollback(); // ...abort — both must vanish together.
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    expect(await t.db.select().from(trashBatches)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. deliverOutbox — the notify-outbox drainer
// ---------------------------------------------------------------------------

describe('deliverOutbox (the notify-outbox drainer)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => t?.stop());

  beforeEach(async () => {
    await t.db.delete(notificationOutbox);
  });

  const seedRow = (over: Partial<typeof notificationOutbox.$inferInsert> = {}) =>
    t.db
      .insert(notificationOutbox)
      .values({
        eventType: 'batch_created',
        payload: { batchId: 'b1', mediaKind: 'movie', itemCount: 3, totalBytes: 9_000_000_000 },
        earliestSendAt: new Date(Date.now() - 60_000), // due
        ...over,
      })
      .returning()
      .then((r) => r[0]!);

  it('sends DUE rows and marks sent_at; leaves future/parked rows alone', async () => {
    const due = await seedRow();
    const future = await seedRow({ earliestSendAt: new Date(Date.now() + 3_600_000) });
    const parked = await seedRow({ attempts: 5 }); // already parked
    const sent: OutboxMessage[] = [];
    const report = await deliverOutbox({ db: t.db, sender: async (m) => void sent.push(m) });

    expect(report.skipped).toBe(false);
    expect(report.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(
      (await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, due.id)))[0]!
        .sentAt,
    ).not.toBeNull();
    expect(
      (await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, future.id)))[0]!
        .sentAt,
    ).toBeNull();
    expect(
      (await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, parked.id)))[0]!
        .sentAt,
    ).toBeNull();
  });

  it('NO CREDENTIALS ⇒ a clean no-op: rows untouched, skipped=true (disabled-safe)', async () => {
    const row = await seedRow();
    const report = await deliverOutbox({ db: t.db, sender: null }); // force the no-creds path
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe('no_credentials');
    expect(report.dueCount).toBe(1);
    const after = (
      await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, row.id))
    )[0]!;
    expect(after.sentAt).toBeNull();
    expect(after.attempts).toBe(0); // attempts NOT burned on a config-absent skip
  });

  it('a delivery failure increments attempts + records last_error + backs off', async () => {
    const row = await seedRow();
    const now = new Date();
    const report = await deliverOutbox({
      db: t.db,
      now,
      sender: async () => {
        throw new Error('pushover 500: down');
      },
    });
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(0);
    const after = (
      await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, row.id))
    )[0]!;
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('pushover 500');
    expect(after.sentAt).toBeNull();
    expect(after.earliestSendAt.getTime()).toBeGreaterThan(now.getTime()); // backed off into the future
  });

  it('parks a row after the 5th failure (excluded from the due scan thereafter)', async () => {
    const row = await seedRow({ attempts: 4 }); // one more failure (→ 5) parks it
    const report = await deliverOutbox({
      db: t.db,
      now: new Date(),
      sender: async () => {
        throw new Error('still down');
      },
    });
    expect(report.parked).toBe(1);
    const after = (
      await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, row.id))
    )[0]!;
    expect(after.attempts).toBe(5);
    // A subsequent run does not select it (attempts >= 5), even with a working sender.
    const again = await deliverOutbox({ db: t.db, sender: async () => {} });
    expect(again.dueCount).toBe(0);
  });

  it('renders owner-voiced copy + a per-kind deep-link URL', async () => {
    await t.db.delete(notificationOutbox);
    await seedRow({
      eventType: 'batch_created',
      payload: { mediaKind: 'movie', itemCount: 17, totalBytes: 114_000_000_000 },
    });
    await seedRow({
      eventType: 'batch_swept',
      payload: { mediaKind: 'tv', deletedCount: 4, reclaimedBytes: 20_000_000_000 },
    });
    const sent: OutboxMessage[] = [];
    await deliverOutbox({ db: t.db, sender: async (m) => void sent.push(m) });

    const created = sent.find((m) => m.title.startsWith('New Movies'))!;
    expect(created.title).toBe('New Movies batch');
    expect(created.message).toContain('17 items');
    expect(created.message).toContain('review it');
    expect(created.url).toBe('https://haynesnetwork.com/trash?tab=movies');

    const swept = sent.find((m) => m.title.includes('swept'))!;
    expect(swept.title).toBe('TV batch swept');
    expect(swept.url).toBe('https://haynesnetwork.com/trash?tab=tv');
  });

  it('renderOutboxMessage formats the leaving-soon deadline in the given tz', () => {
    const msg = renderOutboxMessage(
      {
        eventType: 'batch_leaving_soon',
        payload: { mediaKind: 'movie', pendingCount: 5, expiresAt: '2026-09-04T12:00:00Z' },
      },
      'America/New_York',
    );
    expect(msg.title).toBe('Movies batch is Leaving Soon');
    expect(msg.message).toContain('Sep 4');
    expect(msg.message).toContain('5 items');
  });

  it('renderOutboxMessage renders the final-warning last-call copy with the close TIME (DESIGN-015)', () => {
    const msg = renderOutboxMessage(
      {
        eventType: 'batch_final_warning',
        // 2026-09-04 11:04 PM EDT.
        payload: { mediaKind: 'tv', pendingCount: 7, expiresAt: '2026-09-05T03:04:00Z' },
      },
      'America/New_York',
    );
    expect(msg.title).toBe('Last call — TV batch');
    expect(msg.message).toBe(
      'Last call: the TV batch closes at 11:04 PM — 7 items still slated. Save anything you want to keep.',
    );
    expect(msg.url).toBe('https://haynesnetwork.com/trash?tab=tv');
  });
});

// ---------------------------------------------------------------------------
// 4. getNotifyWindow + audited settings
// ---------------------------------------------------------------------------

describe('getNotifyWindow + audited settings', () => {
  let t: TestDb;
  let actorId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    actorId = (await createUser(t.db, { email: 'win-admin@example.com', displayName: 'Win Admin' }))
      .id;
  });
  afterAll(async () => t?.stop());

  it('defaults to ALL DAY (0–24 America/New_York, no gating) when unset', async () => {
    const w = await getNotifyWindow(t.db);
    expect(w).toEqual({ startHour: 0, endHour: 24, tz: 'America/New_York' });
  });

  it('the all-day default sends every push ASAP (enqueue math is a no-op — no gating)', async () => {
    const w = await getNotifyWindow(t.db);
    // At any wall-clock hour, [0,24) contains it ⇒ earliest_send_at == now (send immediately).
    for (const iso of ['2026-07-08T00:30:00Z', '2026-07-08T12:00:00Z', '2026-07-08T06:15:00Z']) {
      const now = new Date(iso);
      expect(computeEarliestSend(now, w).getTime()).toBe(now.getTime());
    }
  });

  it('setAppSetting(notify_window) writes an update_app_setting audit row and round-trips', async () => {
    const before = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    await setAppSetting({
      db: t.db,
      key: 'notify_window',
      value: { startHour: 19, endHour: 23, tz: 'America/Chicago' },
      actorId,
    });
    const after = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(after.length).toBeGreaterThan(before.length);
    expect(await getNotifyWindow(t.db)).toEqual({
      startHour: 19,
      endHour: 23,
      tz: 'America/Chicago',
    });
  });

  it('final_warning defaults to { enabled:true, hoursBefore:2 } and round-trips with an audit row (DESIGN-015)', async () => {
    expect(await getFinalWarning(t.db)).toEqual({ enabled: true, hoursBefore: 2 });
    const before = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: true, hoursBefore: 6 },
      actorId,
    });
    const after = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(after.length).toBeGreaterThan(before.length);
    expect(await getFinalWarning(t.db)).toEqual({ enabled: true, hoursBefore: 6 });
  });

  it('final_warning fails safe on a garbage row (non-numeric hours / truthy-string enable ⇒ default)', async () => {
    await setAppSetting({
      db: t.db,
      key: 'final_warning',
      value: { enabled: 'yes', hoursBefore: 'lots' } as unknown as {
        enabled: boolean;
        hoursBefore: number;
      },
      actorId,
    });
    // enabled non-boolean ⇒ default ON; hoursBefore non-finite ⇒ clamped to the 2h default.
    expect(await getFinalWarning(t.db)).toEqual({ enabled: true, hoursBefore: 2 });
  });

  it('fails safe on a garbage stored row (both hours non-numeric ⇒ all-day default)', async () => {
    await setAppSetting({
      db: t.db,
      key: 'notify_window',
      value: { startHour: 'nope', endHour: 'nah', tz: 'Not/AZone' } as unknown as NotifyWindow,
      actorId,
    });
    // Both hours non-numeric ⇒ revert to the default pair (now all-day 0–24); tz invalid ⇒ default tz.
    expect(await getNotifyWindow(t.db)).toEqual({
      startHour: 0,
      endHour: 24,
      tz: 'America/New_York',
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-060 / DESIGN-031 (PLAN-035) — the EMAIL channel: renderer, per-channel routing,
// per-channel disabled-safety (R-197), and the env-contract sender gate.
// ---------------------------------------------------------------------------
describe('the email channel (ADR-060)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    await t.db.delete(notificationOutbox);
  });

  type OutboxEmail = NonNullable<ReturnType<typeof renderOutboxEmail>>;

  const seed = (over: Partial<typeof notificationOutbox.$inferInsert> = {}) =>
    t.db
      .insert(notificationOutbox)
      .values({
        channel: 'email',
        eventType: 'ticket_created',
        payload: { to: 'admin@haynesnetwork.com', ticketId: 'tk-1', title: 'No audio', authorName: 'Mem Ber' },
        earliestSendAt: new Date(Date.now() - 60_000),
        ...over,
      })
      .returning()
      .then((r) => r[0]!);

  it('renderOutboxEmail renders the three ticket events; null without payload.to or for foreign events', () => {
    const created = renderOutboxEmail({
      eventType: 'ticket_created',
      payload: { to: 'a@x.com', ticketId: 't1', title: 'No audio', authorName: 'Mem Ber', category: 'audio' },
    })!;
    expect(created.to).toBe('a@x.com');
    expect(created.subject).toContain('New ticket: No audio');
    expect(created.text).toContain('Mem Ber');
    expect(created.text).toContain('https://haynesnetwork.com/bulletin/ticket/t1');

    const replied = renderOutboxEmail({
      eventType: 'ticket_replied',
      payload: { to: 'a@x.com', ticketId: 't1', title: 'No audio', replyAuthorName: 'Sta Ff', snippet: 'on it' },
    })!;
    expect(replied.subject).toContain('Re: No audio');
    expect(replied.text).toContain('on it');

    const moved = renderOutboxEmail({
      eventType: 'ticket_status_changed',
      payload: { to: 'a@x.com', ticketId: 't1', title: 'No audio', toStatus: 'in_progress', actorName: 'Sta Ff' },
    })!;
    expect(moved.subject).toContain('in progress');

    expect(renderOutboxEmail({ eventType: 'ticket_created', payload: { ticketId: 't1' } })).toBeNull();
    expect(renderOutboxEmail({ eventType: 'batch_created', payload: { to: 'a@x.com' } })).toBeNull();
  });

  it('routes rows per channel: email rows to the email sender, pushover rows to pushover', async () => {
    const mailRow = await seed();
    await seed({ channel: 'pushover', eventType: 'mam_gate_paused', payload: { unsatisfied: 15, limit: 20 } });
    const mails: OutboxEmail[] = [];
    const pushes: OutboxMessage[] = [];
    const report = await deliverOutbox({
      db: t.db,
      senders: { pushover: async (m) => void pushes.push(m), email: async (m) => void mails.push(m) },
    });
    expect(report.sent).toBe(2);
    expect(report.skippedChannels).toBeUndefined();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('admin@haynesnetwork.com');
    expect(mails[0]!.subject).toContain('No audio');
    expect(pushes).toHaveLength(1);
    const [sentRow] = await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, mailRow.id));
    expect(sentRow!.sentAt).not.toBeNull();
  });

  it('R-197 — a channel without credentials is EXCLUDED: its rows wait untouched, no attempts burned', async () => {
    const mailRow = await seed();
    await seed({ channel: 'pushover', eventType: 'mam_gate_paused', payload: { unsatisfied: 15, limit: 20 } });
    const pushes: OutboxMessage[] = [];
    const report = await deliverOutbox({
      db: t.db,
      senders: { pushover: async (m) => void pushes.push(m), email: null },
    });
    expect(report.sent).toBe(1); // the pushover row only
    expect(report.skippedChannels).toEqual(['email']);
    const [waiting] = await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, mailRow.id));
    expect(waiting!.sentAt).toBeNull();
    expect(waiting!.attempts).toBe(0); // NOT failed — waiting for credentials
  });

  it('an unrenderable email row (payload.to missing) FAILS loudly into backoff, never sends empty', async () => {
    const bad = await seed({ payload: { ticketId: 'tk-9', title: 'orphan' } });
    const mails: OutboxEmail[] = [];
    const report = await deliverOutbox({
      db: t.db,
      senders: { pushover: null, email: async (m) => void mails.push(m) },
    });
    expect(mails).toHaveLength(0);
    expect(report.failed).toBe(1);
    const [row] = await t.db.select().from(notificationOutbox).where(eq(notificationOutbox.id, bad.id));
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain('unrenderable');
  });

  it('smtpSenderFromEnv gates on the FULL five-var contract', () => {
    const full = { SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@x' };
    expect(smtpSenderFromEnv(full)).not.toBeNull();
    for (const missing of Object.keys(full)) {
      expect(smtpSenderFromEnv({ ...full, [missing]: undefined }), missing).toBeNull();
    }
  });
});
