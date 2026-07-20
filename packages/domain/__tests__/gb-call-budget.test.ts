// ADR-067 / DESIGN-039 (PLAN-055 amend — D-21..D-24) — the daily GB CALL BUDGET. Proves: the
// quota-day boundary math (07:00 UTC, not midnight); durable per-consumer accounting that ROLLS to 0
// across the day boundary in one statement; the run-scoped tracker's canSpend/spend enforcement and
// the per-consumer split; and that the unenforced 'bookfix' slice is metered but never blocked.
// Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gbCallBudget } from '@hnet/db';
import {
  GB_MAX_RESOLVE_LEGS,
  createGbCallMeter,
  gbQuotaDayString,
  makeGbBudgetTracker,
  readGbBudgetUsage,
  recordGbCalls,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(gbCallBudget);
});

// The quota-day (07:00 UTC boundary): everything from 07:00 on day N until 06:59:59 on day N+1 is
// one quota-day, dated N.
describe('gbQuotaDayString (07:00 UTC boundary, not midnight)', () => {
  it('maps 08:32 UTC to that calendar day and 06:00 UTC to the PREVIOUS day', () => {
    expect(gbQuotaDayString(new Date('2026-07-19T08:32:03Z'))).toBe('2026-07-19');
    expect(gbQuotaDayString(new Date('2026-07-19T07:00:00Z'))).toBe('2026-07-19');
    // 06:00 is still yesterday's quota-day (before the 07:00 reset).
    expect(gbQuotaDayString(new Date('2026-07-19T06:59:59Z'))).toBe('2026-07-18');
    expect(gbQuotaDayString(new Date('2026-07-19T00:30:00Z'))).toBe('2026-07-18');
  });
});

describe('recordGbCalls / readGbBudgetUsage — durable per-consumer accounting', () => {
  const day = new Date('2026-07-19T08:00:00Z');

  it('accumulates per consumer within a quota-day', async () => {
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 5, now: day });
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 3, now: day });
    await recordGbCalls({ db: t.db, consumer: 'goodreads', count: 2, now: day });
    await recordGbCalls({ db: t.db, consumer: 'bookfix', count: 1, now: day });
    const usage = await readGbBudgetUsage({ db: t.db, now: day });
    expect(usage).toMatchObject({ quotaDay: '2026-07-19', pairing: 8, goodreads: 2, bookfix: 1 });
  });

  it('a count of 0 is a no-op (never creates a row / never advances)', async () => {
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 0, now: day });
    const [row] = await t.db.select().from(gbCallBudget);
    expect(row).toBeUndefined();
  });

  it('ROLLS every counter to 0 when the quota-day changes (the day-boundary reset)', async () => {
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 40, now: day });
    await recordGbCalls({ db: t.db, consumer: 'goodreads', count: 20, now: day });
    // A read on the NEXT quota-day sees zero even before the physical roll…
    const nextDay = new Date('2026-07-20T07:30:00Z');
    expect(await readGbBudgetUsage({ db: t.db, now: nextDay })).toMatchObject({
      quotaDay: '2026-07-20',
      pairing: 0,
      goodreads: 0,
      bookfix: 0,
    });
    // …and the first write on the new day physically rolls the row (old tallies gone, new day counts).
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 4, now: nextDay });
    const usage = await readGbBudgetUsage({ db: t.db, now: nextDay });
    expect(usage).toMatchObject({ quotaDay: '2026-07-20', pairing: 4, goodreads: 0, bookfix: 0 });
    // The stored row now belongs to the new day only.
    const [row] = await t.db.select().from(gbCallBudget);
    expect(row?.quotaDay).toBe('2026-07-20');
    expect(row?.goodreadsCalls).toBe(0);
  });
});

describe('makeGbBudgetTracker — per-consumer enforcement + split', () => {
  const day = new Date('2026-07-19T08:00:00Z');

  it('enforces the consumer budget: canSpend flips false once the slice is spent', async () => {
    // reserveOverride:1 isolates the raw commit boundary (used < budget) from the reserve gate,
    // which the dedicated reserve test below covers.
    const tracker = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now: day,
      budgetOverride: 6,
      reserveOverride: 1,
    });
    expect(tracker.canSpend()).toBe(true);
    await tracker.spend(4);
    expect(tracker.canSpend()).toBe(true); // 4 < 6
    expect(tracker.used()).toBe(4);
    await tracker.spend(2);
    expect(tracker.canSpend()).toBe(false); // 6 >= 6 — spent
    // Persisted durably for the next run / a concurrent process.
    expect((await readGbBudgetUsage({ db: t.db, now: day })).pairing).toBe(6);
  });

  it('starts from the persisted start-of-run usage (a fresh tracker sees prior spend)', async () => {
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 5, now: day });
    const tracker = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now: day,
      budgetOverride: 6,
      reserveOverride: 1,
    });
    expect(tracker.used()).toBe(5);
    expect(tracker.canSpend()).toBe(true);
    await tracker.spend(1);
    expect(tracker.canSpend()).toBe(false); // 6 >= 6
  });

  it('reserves a full worst-case resolve before committing — no crossing overshoot (the 201/200 fix)', async () => {
    // The 2026-07-20 goodreads trip spent 201 of a 200 slice: the old gate (used < budget) started a
    // resolve at used=199 and that 2-leg resolve committed to 201. The reserve gate only STARTS a
    // resolve while `used + reserve <= budget`, so the last started resolve begins at used <= budget -
    // reserve and its full structural fan-out lands the consumer at or under the slice — never 201.
    expect(GB_MAX_RESOLVE_LEGS).toBe(4);
    await recordGbCalls({ db: t.db, consumer: 'goodreads', count: 196, now: day });
    const tracker = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'goodreads',
      now: day,
      budgetOverride: 200,
    });
    expect(tracker.used()).toBe(196);
    expect(tracker.canSpend()).toBe(true); // 196 + 4 <= 200 — a full worst-case resolve still fits
    await tracker.spend(4); // a 4-leg resolve lands exactly on the slice
    expect(tracker.used()).toBe(200);
    expect(tracker.canSpend()).toBe(false); // 200 + 4 > 200 — no further resolve starts (never 201)

    // Within the reserve band (used=197: 197 + 4 > 200) a fresh resolve is already refused — it can't
    // afford a full worst-case fan-out, so the slice stops before it can overshoot.
    await recordGbCalls({ db: t.db, consumer: 'pairing', count: 197, now: day });
    const near = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now: day,
      budgetOverride: 200,
    });
    expect(near.used()).toBe(197);
    expect(near.canSpend()).toBe(false); // 197 + 4 > 200
  });

  it("the 'bookfix' slice is metered but NEVER budget-blocked (the reserved headroom)", async () => {
    const tracker = await makeGbBudgetTracker({ db: t.db, consumer: 'bookfix', now: day, budgetOverride: 1 });
    await tracker.spend(50); // way over its nominal slice…
    expect(tracker.canSpend()).toBe(true); // …still allowed (interactive Fix rides the reserve)
    expect((await readGbBudgetUsage({ db: t.db, now: day })).bookfix).toBe(50); // but metered honestly
  });

  it('one consumer spending its slice does NOT block another (independent splits)', async () => {
    const pairing = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'pairing',
      now: day,
      budgetOverride: 2,
      reserveOverride: 1,
    });
    await pairing.spend(2);
    expect(pairing.canSpend()).toBe(false);
    const goodreads = await makeGbBudgetTracker({
      db: t.db,
      consumer: 'goodreads',
      now: day,
      budgetOverride: 2,
      reserveOverride: 1,
    });
    expect(goodreads.canSpend()).toBe(true); // goodreads slice untouched
  });
});

describe('createGbCallMeter — in-memory leg counter (the http-wrapper hook)', () => {
  it('counts each onCall and reports the running total', () => {
    const meter = createGbCallMeter();
    expect(meter.taken()).toBe(0);
    meter.onCall();
    meter.onCall();
    expect(meter.taken()).toBe(2);
  });
});
