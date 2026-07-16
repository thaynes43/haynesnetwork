// ADR-067 / DESIGN-039 (PLAN-055 — Google Books quota resilience). The estate's SHARED GB quota
// circuit breaker: one Google Books key serves three consumers in three processes (the web app's
// books Fix fallback, the goodreads-sync enrichment CronJob, the format-pairing mint CronJob), and
// until now none of them remembered exhaustion — the 2026-07-16 incident (a user Fix hard-failing
// in seconds against a daily quota that resets at 07:00 UTC) plus the all-day 429 burn.
//
// The single-row `gb_quota_state` table (the mam_gate_state class — unaudited rebuildable
// operational state, guard-listed, THIS file is its only writer) remembers the trip across
// processes; `guardedGbResolve` is the ONE seam every GB call site consults (gate → call →
// clear-on-success / trip-on-429). The `@hnet/goodreads` client itself stays dumb (no DB) —
// classification here is STRUCTURAL (status + body text), so this package gains no new dependency.
import { gbQuotaState, type DbClient } from '@hnet/db';
import { eq, isNotNull, or } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/**
 * The UTC hour Google's daily Books quota returns (midnight Pacific — 07:00 UTC in DST, the
 * owner-observed reset; env-tunable for the PST winter case, DESIGN-039 Q-03).
 */
export const GB_DAILY_RESET_UTC_HOUR = Number(process.env.GB_DAILY_RESET_UTC_HOUR ?? 7);

/** A per-minute (burst) 429's trip window — also the half-open probe's claim window. */
export const GB_MINUTE_TRIP_MS = 2 * 60_000;

const GB_SINGLETON_ID = 'gb';

export type GbQuotaTripKind = 'daily' | 'minute';

/**
 * Classify an error as a GB quota 429 (ADR-067 C-02) — STRUCTURAL so this package needs no
 * `@hnet/goodreads` import: any object carrying `status === 429` whose message/bodySnippet says
 * "per day"/"daily" is the DAILY quota ("Queries per day" in Google's body); any other 429 is
 * treated as PER-MINUTE (the conservative 2-minute trip). Everything else returns null — not the
 * breaker's business (non-429 errors rethrow untouched at the seam).
 */
export function classifyGb429(error: unknown): GbQuotaTripKind | null {
  if (error === null || typeof error !== 'object') return null;
  if ((error as { status?: unknown }).status !== 429) return null;
  const text = [
    (error as { message?: unknown }).message,
    (error as { bodySnippet?: unknown }).bodySnippet,
  ]
    .filter((p): p is string => typeof p === 'string')
    .join(' ');
  return /per day|daily/i.test(text) ? 'daily' : 'minute';
}

/** The next daily-quota reset (GB_DAILY_RESET_UTC_HOUR:00 UTC) STRICTLY after `now`. */
export function nextGbDailyReset(now: Date): Date {
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), GB_DAILY_RESET_UTC_HOUR),
  );
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

/**
 * OPEN the breaker (upsert the singleton): 'daily' ⇒ until the next 07:00 UTC; 'minute' ⇒
 * now + 2 min. Returns the new exhausted_until. Unaudited (ADR-067 C-09 — routine daily weather;
 * the trail is this row + the callers' one-line logs).
 */
export async function tripGbQuotaBreaker(input: {
  db?: DbClient;
  kind: GbQuotaTripKind;
  detail?: string;
  now?: Date;
}): Promise<Date> {
  const now = input.now ?? new Date();
  const exhaustedUntil =
    input.kind === 'daily' ? nextGbDailyReset(now) : new Date(now.getTime() + GB_MINUTE_TRIP_MS);
  const tripReason = input.detail ? `${input.kind}: ${input.detail}` : input.kind;
  await resolveDb(input.db)
    .insert(gbQuotaState)
    .values({
      id: GB_SINGLETON_ID,
      exhaustedUntil,
      trippedAt: now,
      tripReason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gbQuotaState.id,
      set: { exhaustedUntil, trippedAt: now, tripReason, updatedAt: now },
    });
  return exhaustedUntil;
}

/** CLEAR the breaker — any completed GB call (a match OR an honest no-match) proves quota. */
export async function clearGbQuotaBreaker(input: { db?: DbClient; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await resolveDb(input.db)
    .update(gbQuotaState)
    .set({ exhaustedUntil: null, trippedAt: null, tripReason: null, updatedAt: now })
    .where(or(isNotNull(gbQuotaState.exhaustedUntil), isNotNull(gbQuotaState.trippedAt)));
}

export type GbQuotaGate =
  | { state: 'closed' }
  | { state: 'open'; until: Date; reason: string | null }
  /** The window expired and THIS caller atomically claimed the single half-open probe. */
  | { state: 'probe'; until: Date };

/**
 * The write-capable gate consult (ADR-067 C-03 half-open): a live window ⇒ 'open' (do not call);
 * no row / clear row ⇒ 'closed'; an EXPIRED window ⇒ exactly ONE caller wins 'probe' — the claim
 * atomically extends exhausted_until by the 2-minute claim window (row lock), so concurrent
 * consumers keep seeing 'open' while the probe runs. The probe's outcome then decides:
 * clearGbQuotaBreaker on success, a fresh trip on a 429.
 */
export async function consultGbQuotaGate(input: { db?: DbClient; now?: Date }): Promise<GbQuotaGate> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(gbQuotaState)
      .where(eq(gbQuotaState.id, GB_SINGLETON_ID))
      .for('update');
    if (!row || row.exhaustedUntil === null) return { state: 'closed' };
    if (row.exhaustedUntil.getTime() > now.getTime()) {
      return { state: 'open', until: row.exhaustedUntil, reason: row.tripReason };
    }
    // Expired ⇒ claim the single probe (extend the window while it runs).
    const claimUntil = new Date(now.getTime() + GB_MINUTE_TRIP_MS);
    await tx
      .update(gbQuotaState)
      .set({ exhaustedUntil: claimUntil, updatedAt: now })
      .where(eq(gbQuotaState.id, GB_SINGLETON_ID));
    return { state: 'probe', until: claimUntil };
  });
}

/**
 * The READ-ONLY gate peek (run-level checks — the goodreads-sync one-line skip, the retry pass's
 * pass/skip decision). Never claims the probe: an expired window peeks as NOT open, so the run's
 * first guardedGbResolve makes the half-open probe.
 */
export async function peekGbQuotaGate(input: {
  db?: DbClient;
  now?: Date;
}): Promise<{ open: boolean; until: Date | null; reason: string | null }> {
  const now = input.now ?? new Date();
  const [row] = await resolveDb(input.db)
    .select()
    .from(gbQuotaState)
    .where(eq(gbQuotaState.id, GB_SINGLETON_ID))
    .limit(1);
  if (!row || row.exhaustedUntil === null || row.exhaustedUntil.getTime() <= now.getTime()) {
    return { open: false, until: null, reason: null };
  }
  return { open: true, until: row.exhaustedUntil, reason: row.tripReason };
}

/** The shape every injected GB resolver already satisfies (structural — ADR-010 offline tests). */
export interface GbQuotaGuardedResolver<T extends { volumeId: string }> {
  resolveVolume(query: {
    isbn?: string | null;
    title: string;
    author?: string | null;
  }): Promise<T | null>;
}

export type GuardedGbResolveResult<T extends { volumeId: string }> =
  | { outcome: 'resolved'; volume: T }
  | { outcome: 'no_match' }
  /** The breaker was OPEN — no GB call was made. */
  | { outcome: 'quota_blocked'; until: Date; reason: string | null }
  /** The GB call was made and 429'd — the breaker is now open until `until`. */
  | { outcome: 'quota_tripped'; until: Date; kind: GbQuotaTripKind };

/**
 * THE SEAM (ADR-067 C-04): every domain GB call site resolves through this. Gate consult → (open
 * ⇒ quota_blocked, resolver untouched) → resolveVolume → a COMPLETED call (match or honest
 * no-match) clears the breaker; a 429 trips it (daily → next 07:00 UTC, minute → +2 min) and
 * reports quota_tripped; any NON-429 error rethrows untouched so callers keep their existing
 * honest-failure semantics. Generic over the resolver's volume shape (the enrichment GbVolume,
 * the fix/pairing `{ volumeId }`).
 */
export async function guardedGbResolve<T extends { volumeId: string }>(input: {
  db?: DbClient;
  gb: GbQuotaGuardedResolver<T>;
  query: { isbn?: string | null; title: string; author?: string | null };
  now?: Date;
}): Promise<GuardedGbResolveResult<T>> {
  const gate = await consultGbQuotaGate({ db: input.db, ...(input.now ? { now: input.now } : {}) });
  if (gate.state === 'open') {
    return { outcome: 'quota_blocked', until: gate.until, reason: gate.reason };
  }
  let volume: T | null;
  try {
    volume = await input.gb.resolveVolume(input.query);
  } catch (error) {
    const kind = classifyGb429(error);
    if (kind === null) throw error;
    const until = await tripGbQuotaBreaker({
      db: input.db,
      kind,
      detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
      ...(input.now ? { now: input.now } : {}),
    });
    return { outcome: 'quota_tripped', until, kind };
  }
  await clearGbQuotaBreaker({ db: input.db, ...(input.now ? { now: input.now } : {}) });
  return volume === null ? { outcome: 'no_match' } : { outcome: 'resolved', volume };
}
