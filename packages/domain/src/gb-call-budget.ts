// ADR-067 / DESIGN-039 (PLAN-055 amend — D-21..D-24). The daily GB CALL BUDGET: the layer that keeps
// the estate's OWN first-party Google Books consumers inside the shared key's low per-day cap FOREVER,
// unattended. The breaker (gb-quota-breaker.ts) reacts to a real 429; this budget stops us reaching one.
//
// Evidence (2026-07-19 cluster capture): with LazyLibrarian's re-add amplification already killed
// (#409 → ~13 GBRESULTS/day) the shared key STILL exhausted its per-day quota by ~07:41 UTC — spent
// almost entirely by ONE 07:32 format-pairing resolve run (25 attempts × 1–3 GB legs) plus a 07:41
// goodreads enrichment burst that hit the per-MINUTE limit first (masking the daily exhaustion the
// 08:32 run then surfaced). CORRECTION (2026-07-19, GCP-console-verified): the project quota is a
// genuine 1,000 Queries/day, NOT ~100 — the earlier "~100" was only the APP's slice of a key that was
// SHARED with LazyLibrarian + Libretto (all three on the same GCP project), which together saturated
// the one 1,000/day quota daily. That key was split (each now has its own GCP-project key), so the app
// owns its key's full ~1,000/day; prod env sets pairing 700 / goodreads 200 / bookfix 100. The
// mechanism below stands: a persistent per-consumer daily CALL budget, enforced BEFORE the GB call,
// that skips GB work for the rest of the quota-day WITHOUT tripping the shared breaker (which stays the
// hard backstop for real 429s).
//
// This module is the SINGLE WRITER for gb_call_budget (the mam_gate_state class — unaudited rebuildable
// day-rolling operational state, guard-listed). Counting itself happens in the shared @hnet/goodreads
// http wrapper via an injected `onCall` meter fired once per PHYSICAL outbound request — every metered
// HTTP call, i.e. the isbn/title/pre-colon/confirm leg fan-out of one resolveVolume AND every
// transient-retry re-send (2026-07-20 fix: Google Books meters each HTTP request, so a 503/per-minute-429
// retry counts too — counting only the logical query undercounted retries and tripped the breaker at
// ~half the counted budget). The meter's per-seam delta is attributed to a consumer and persisted here.
import { gbCallBudget, type DbClient } from '@hnet/db';
import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { resolveDb } from './db-client';
import { GB_DAILY_RESET_UTC_HOUR } from './gb-quota-breaker';

const GB_SINGLETON_ID = 'gb';

/** The estate's own GB consumers, each with its own daily slice of the shared cap. */
export type GbConsumer = 'pairing' | 'goodreads' | 'bookfix';

/**
 * The per-consumer DAILY CALL BUDGETS (env-tunable). The code defaults below (60/25/15) date from the
 * shared-key era and are conservative; PROD OVERRIDES them via env to 700/200/100 now that the app
 * owns its own ~1,000/day GB key (see the header CORRECTION). bookfix is metered but never
 * budget-blocked — the reserve is for the person waiting on an interactive Fix. The pairing resolve
 * gets the lion's share (it owns the backlog drain); goodreads enrichment a smaller slice (its
 * comic-text fallback still classifies without GB, so it degrades gracefully when its slice is spent).
 * The shared breaker remains the hard backstop, so these can safely approach the full per-key cap.
 */
export const GB_DAILY_CALL_BUDGET: Record<GbConsumer, number> = {
  pairing: Number(process.env.GB_DAILY_CALL_BUDGET_PAIRING ?? 60),
  goodreads: Number(process.env.GB_DAILY_CALL_BUDGET_GOODREADS ?? 25),
  // Metered for a complete daily accounting; NOT enforced (interactive Fix rides the reserve headroom).
  bookfix: Number(process.env.GB_DAILY_CALL_BUDGET_BOOKFIX ?? 15),
};

/**
 * The worst-case number of outbound GB getText legs a single `resolveVolume` can issue: the isbn-miss
 * leg, the primary title-miss leg, the pre-colon fallback leg, and the `/volumes/{id}` comic-confirm
 * leg (see @hnet/goodreads `resolveVolume`). Used as the per-resolve budget RESERVE so an ENFORCED
 * consumer never STARTS a resolve it cannot fully afford: `canSpend()` requires `used + reserve <=
 * budget`, so a resolve that spends its full structural fan-out still lands the consumer at or under
 * its slice — the fix for the 2026-07-20 goodreads 201/200 overshoot (a 2-leg crossing resolve started
 * at used=199 and committed to 201). Transient-retry inflation beyond the structural legs is rare and
 * remains the shared breaker's job (the hard backstop); with the enforced pairing+goodreads slices
 * summing to 900 of the ~1000/day cap, that leaves the reserve headroom to absorb it.
 */
export const GB_MAX_RESOLVE_LEGS = 4;

/**
 * The date-string (YYYY-MM-DD, UTC) of the GB_DAILY_RESET_UTC_HOUR boundary that `now` falls in — the
 * quota-day the counts belong to. Shifting `now` back by the reset hour maps every instant to the date
 * of its most-recent reset: 08:32 UTC on the 19th and 06:00 UTC on the 19th land on DIFFERENT days
 * (the 19th vs the 18th) because the quota-day starts at 07:00, not midnight.
 */
export function gbQuotaDayString(now: Date, resetHour: number = GB_DAILY_RESET_UTC_HOUR): string {
  const shifted = new Date(now.getTime() - resetHour * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * A tiny in-memory call counter wired into the GB client's http wrapper (`onCall`). It just counts —
 * durability is the DB row's job (recordGbCalls persists the per-seam delta). Kept dependency-free so
 * @hnet/goodreads stays dumb (no DB), exactly like the breaker's structural classification.
 */
export interface GbCallMeter {
  /** Invoked by the http wrapper before each outbound GB request. */
  onCall(): void;
  /** Total calls counted since construction. */
  taken(): number;
}

export function createGbCallMeter(): GbCallMeter {
  let count = 0;
  return {
    onCall: () => {
      count += 1;
    },
    taken: () => count,
  };
}

export interface GbBudgetUsage {
  quotaDay: string;
  pairing: number;
  goodreads: number;
  bookfix: number;
}

const ZERO_USAGE = (quotaDay: string): GbBudgetUsage => ({
  quotaDay,
  pairing: 0,
  goodreads: 0,
  bookfix: 0,
});

/**
 * Read today's per-consumer usage. A row whose stored `quota_day` is NOT the current one (the day
 * rolled over since the last write) reads as all-zero — the counters are logically reset even before
 * the next write physically rolls them (recordGbCalls does the physical roll in the same statement).
 */
export async function readGbBudgetUsage(input: { db?: DbClient; now?: Date }): Promise<GbBudgetUsage> {
  const now = input.now ?? new Date();
  const today = gbQuotaDayString(now);
  const [row] = await resolveDb(input.db)
    .select()
    .from(gbCallBudget)
    .where(eq(gbCallBudget.id, GB_SINGLETON_ID))
    .limit(1);
  if (!row || row.quotaDay !== today) return ZERO_USAGE(today);
  return {
    quotaDay: today,
    pairing: row.pairingCalls,
    goodreads: row.goodreadsCalls,
    bookfix: row.bookfixCalls,
  };
}

/**
 * Persist `count` GB calls for `consumer` against the current quota-day (single-writer upsert). The
 * ON CONFLICT clause ROLLS the day atomically: when the stored `quota_day` is stale every counter
 * resets to 0 first (only this consumer's column gets `count`), so a new quota-day starts clean
 * without a cron. A no-op when count <= 0.
 */
export async function recordGbCalls(input: {
  db?: DbClient;
  consumer: GbConsumer;
  count: number;
  now?: Date;
}): Promise<void> {
  if (input.count <= 0) return;
  const now = input.now ?? new Date();
  const today = gbQuotaDayString(now);
  const inc = (c: GbConsumer): number => (c === input.consumer ? input.count : 0);

  // For each column: if the stored day is the current one, add this write's increment to the EXISTING
  // value; else the day rolled — reset to just this write's increment (0 for the other consumers). The
  // existing-value ref is TABLE-QUALIFIED (`"gb_call_budget"."pairing_calls"`) so it is unambiguous
  // against the ON CONFLICT `excluded` pseudo-row.
  const rolled = (col: AnyPgColumn, increment: number) =>
    sql`CASE WHEN ${gbCallBudget.quotaDay} = ${today} THEN ${col} + ${increment} ELSE ${increment} END`;

  await resolveDb(input.db)
    .insert(gbCallBudget)
    .values({
      id: GB_SINGLETON_ID,
      quotaDay: today,
      pairingCalls: inc('pairing'),
      goodreadsCalls: inc('goodreads'),
      bookfixCalls: inc('bookfix'),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gbCallBudget.id,
      set: {
        pairingCalls: rolled(gbCallBudget.pairingCalls, inc('pairing')),
        goodreadsCalls: rolled(gbCallBudget.goodreadsCalls, inc('goodreads')),
        bookfixCalls: rolled(gbCallBudget.bookfixCalls, inc('bookfix')),
        quotaDay: today,
        updatedAt: now,
      },
    });
}

/**
 * A run-scoped budget tracker: read the consumer's start-of-run usage once, then let the run enforce
 * the remaining allowance locally as it spends GB legs (persisting each delta durably so the NEXT run
 * / a concurrent process sees it). `spend` records the meter delta and decrements the local remaining;
 * `canSpend` gates the next GB-needing item. Enforced only for consumers with a budget in
 * GB_DAILY_CALL_BUDGET; `bookfix` is metered (spend persists) but always `canSpend` (the reserve).
 */
export interface GbBudgetTracker {
  readonly consumer: GbConsumer;
  /**
   * True while this consumer can afford to START another resolve — i.e. its whole worst-case
   * structural fan-out (`reserve`) still fits under the slice (`used + reserve <= budget`). Reserving
   * before committing is what keeps a multi-leg crossing resolve from overshooting the slice (the
   * 201/200 fix). Always true for the unenforced `bookfix`.
   */
  canSpend(): boolean;
  /** Persist `legs` GB calls (physical requests) for this consumer and decrement the local remaining. */
  spend(legs: number): Promise<void>;
  /** Calls spent by this consumer so far today (start-of-run + this run). */
  used(): number;
}

const ENFORCED: Record<GbConsumer, boolean> = { pairing: true, goodreads: true, bookfix: false };

export async function makeGbBudgetTracker(input: {
  db?: DbClient;
  consumer: GbConsumer;
  now?: Date;
  /** Explicit daily allowance (tests / a caller override); defaults to GB_DAILY_CALL_BUDGET. */
  budgetOverride?: number;
  /**
   * Per-resolve reserve for the reserve-before-commit gate (tests / a caller override); defaults to
   * GB_MAX_RESOLVE_LEGS. A resolve is only STARTED while `used + reserve <= budget`.
   */
  reserveOverride?: number;
}): Promise<GbBudgetTracker> {
  const now = input.now ?? new Date();
  const usage = await readGbBudgetUsage({ db: input.db, now });
  const budget = input.budgetOverride ?? GB_DAILY_CALL_BUDGET[input.consumer];
  const reserve = input.reserveOverride ?? GB_MAX_RESOLVE_LEGS;
  let used = usage[input.consumer];
  return {
    consumer: input.consumer,
    // Reserve a whole worst-case resolve before committing, so the crossing resolve can't overshoot
    // the slice (the 2026-07-20 201/200 fix). Unenforced `bookfix` always spends (rides the reserve).
    canSpend: () => !ENFORCED[input.consumer] || used + reserve <= budget,
    used: () => used,
    spend: async (legs: number) => {
      if (legs <= 0) return;
      used += legs;
      await recordGbCalls({ db: input.db, consumer: input.consumer, count: legs, now });
    },
  };
}
