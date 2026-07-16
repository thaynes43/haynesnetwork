import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  users,
  type DbClient,
  type FixActionEntry,
  type FixPath,
  type FixReason,
  type FixStatus,
  type Transaction,
} from '@hnet/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  FixAlreadyOpenError,
  FixRateLimitError,
  InvalidFixTransitionError,
  LedgerItemTombstonedError,
  NotFoundError,
} from './errors';
import { inTransaction } from './db-client';
import { resolveFixTarget, type SearchScope } from './action-scope';

/**
 * R-47 / PRD Q-05 default: max fix requests per requester per rolling hour (admins bypass).
 * Owner ruling 2026-07-15: raised 5 → 25 so the friends-and-family group effectively never
 * hits it. Still a fixed constant (Q-05 keeps admin-configurability out of scope).
 */
export const FIX_RATE_LIMIT_PER_HOUR = 25;

/** D-09: statuses that count as an open fix for the one-open-fix-per-target rule. */
export const OPEN_FIX_STATUSES = ['pending', 'actioned', 'search_triggered'] as const;

/** Terminal statuses a fix rests at — none block a new fix on the same target. */
export const TERMINAL_FIX_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'closed_manually',
] as const;

/**
 * The auto-close horizon (default 48h) for an OPEN fix that never reaches a confirmed import.
 * A fire-and-forget bazarr_subtitle fix (completeFixRequests never closes it) or any search that
 * simply never landed a replacement would otherwise sit in an OPEN status forever, permanently
 * tripping FixAlreadyOpenError on that target. expireStaleFixRequests sweeps them to 'timed_out'.
 * Env-tunable (cluster CronJob) like the ADR-028 windows; unset/invalid ⇒ the 48h default.
 */
export const FIX_TIMEOUT_HORIZON_MS = ((): number => {
  const raw = process.env.FIX_TIMEOUT_HORIZON_MS;
  if (raw === undefined || raw === '') return 48 * 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 48 * 60 * 60 * 1000;
})();

/**
 * DESIGN-005 D-09/D-17 — the SHARED per-requester hourly budget: a Fix and a Force
 * Search both draw down the same 25/hour allowance, so a member can't sidestep the
 * limit by alternating the two actions. Counts this requester's fix_requests plus
 * their 'search_requested' ledger events inside the rolling hour. Callers run this
 * under the per-requester advisory lock so parallel submissions can't race past it.
 */
export async function countRecentFixBudget(
  tx: Transaction,
  requesterId: string,
): Promise<number> {
  const [fixes] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(fixRequests)
    .where(
      and(
        eq(fixRequests.requesterId, requesterId),
        sql`${fixRequests.createdAt} > now() - interval '1 hour'`,
      ),
    );
  const [searches] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.eventType, 'search_requested'),
        eq(ledgerEvents.requestedByUserId, requesterId),
        sql`${ledgerEvents.recordedAt} > now() - interval '1 hour'`,
      ),
    );
  return (fixes?.count ?? 0) + (searches?.count ?? 0);
}

export interface CreateFixRequestInput {
  db?: DbClient;
  requesterId: string;
  /** Admins bypass the hourly rate limit (D-09). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /**
   * The fix scope (media-hierarchy actions): radarr 'item'; sonarr 'season' | 'episode';
   * lidarr 'album'. Omitted ⇒ the legacy default (radarr → item, sonarr → episode,
   * lidarr → album). Whole-show/artist are Force-Search-only (D-15) — resolveFixTarget
   * rejects them (widened to SearchScope only so the caller's union flows through).
   */
  scope?: SearchScope;
  /** Episode id (sonarr) / album id (lidarr); absent for radarr / a season (D-15). */
  targetArrChildId?: number | null;
  /** Sonarr season number — for the 'season' scope. */
  seasonNumber?: number | null;
  /** Display-durable label, e.g. 'S06E02 · Rich' / album title / 'Season 6'. */
  targetLabel?: string | null;
  reason: FixReason;
  /** Required iff reason === 'other' — backstopped by the D-09 CHECK (SQLSTATE 23514). */
  reasonText?: string | null;
}

export interface CreateFixRequestResult {
  fixRequestId: string;
  status: FixStatus; // 'pending'
}

/**
 * DESIGN-005 D-09/D-12 — the single writer opening a fix: the fix_requests row
 * (status 'pending', actionsTaken[0] = requester snapshot) and its 'fix_requested'
 * ledger event commit in ONE transaction, BEFORE any *arr call — a crash mid-fix
 * leaves an admin-visible pending row, never a silent half-action.
 *
 * Guards inside the same transaction, under a per-requester advisory lock so parallel
 * submissions can't slip past (R-47): hourly rate limit (admins bypass), one open fix
 * per (media_item_id, target_arr_child_id), kind-specific target validation (D-15),
 * and no fixes on tombstoned items (nothing to fix in the *arr).
 */
export async function createFixRequest(
  input: CreateFixRequestInput,
): Promise<CreateFixRequestResult> {
  return inTransaction(input.db, async (tx) => {
    // Serialize this requester's submissions for the rate-limit count (D-09).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('fix_requests'), hashtext(${input.requesterId}))`,
    );

    const [requester] = await tx
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.requesterId));
    if (!requester) {
      throw new NotFoundError(`User ${input.requesterId} not found`);
    }

    const [item] = await tx
      .select({
        id: mediaItems.id,
        arrKind: mediaItems.arrKind,
        title: mediaItems.title,
        deletedFromArrAt: mediaItems.deletedFromArrAt,
      })
      .from(mediaItems)
      .where(eq(mediaItems.id, input.mediaItemId));
    if (!item) {
      throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
    }
    if (item.deletedFromArrAt !== null) {
      throw new LedgerItemTombstonedError(
        `Media item ${input.mediaItemId} is tombstoned — nothing to fix in the *arr`,
      );
    }

    // D-15 target validation (hierarchy-actions): radarr → the movie ('item'); sonarr →
    // a single 'episode' or a whole 'season'; lidarr → an 'album'. Whole-show/artist
    // are Force-Search-only, so resolveFixTarget rejects them here.
    const { scope, targetChildId, seasonNumber } = resolveFixTarget(item.arrKind, {
      scope: input.scope,
      targetChildId: input.targetArrChildId,
      seasonNumber: input.seasonNumber,
    });
    const targetArrChildId = targetChildId; // fix_requests column name

    if (!input.requesterIsAdmin) {
      // D-17: Fix + Force Search share one hourly budget (countRecentFixBudget).
      const used = await countRecentFixBudget(tx, input.requesterId);
      if (used >= FIX_RATE_LIMIT_PER_HOUR) {
        throw new FixRateLimitError(
          `Fix rate limit reached: ${FIX_RATE_LIMIT_PER_HOUR} requests per hour`,
        );
      }
    }

    // One open fix per (item, scope, child, season): the scope + season keep two
    // different SEASONS of one show from colliding (both carry a null child id).
    const [open] = await tx
      .select({ id: fixRequests.id })
      .from(fixRequests)
      .where(
        and(
          eq(fixRequests.mediaItemId, input.mediaItemId),
          eq(fixRequests.targetScope, scope),
          sql`${fixRequests.targetArrChildId} IS NOT DISTINCT FROM ${targetArrChildId}`,
          sql`${fixRequests.targetSeason} IS NOT DISTINCT FROM ${seasonNumber}`,
          inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
        ),
      );
    if (open) {
      throw new FixAlreadyOpenError(
        `An open fix (${open.id}) already targets this ${scope === 'item' ? 'item' : scope}`,
      );
    }

    const createdSnapshot: FixActionEntry = {
      step: 'created',
      at: new Date().toISOString(),
      requester: { email: requester.email, displayName: requester.displayName },
    };
    const [fix] = await tx
      .insert(fixRequests)
      .values({
        requesterId: input.requesterId,
        mediaItemId: input.mediaItemId,
        targetScope: scope,
        targetArrChildId,
        targetSeason: seasonNumber,
        targetLabel: input.targetLabel ?? null,
        reason: input.reason,
        reasonText: input.reasonText ?? null,
        actionsTaken: [createdSnapshot],
      })
      .returning({ id: fixRequests.id, status: fixRequests.status });
    if (!fix) {
      throw new Error('fix_requests insert returned no row');
    }

    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId,
      eventType: 'fix_requested',
      source: 'app',
      occurredAt: new Date(),
      payload: {
        fixRequestId: fix.id,
        reason: input.reason,
        reasonText: input.reasonText ?? null,
        scope,
        targetArrChildId,
        seasonNumber,
        targetLabel: input.targetLabel ?? null,
        requesterId: input.requesterId,
      },
    });

    return { fixRequestId: fix.id, status: fix.status };
  });
}

/** The lifecycle steps recordFixAction may land (D-09; 'completed' is completeFixRequests'). */
export type FixTransition = 'actioned' | 'search_triggered' | 'failed';

/** Legal predecessors per transition (Fix Lifecycle, DDD-001 T-43). */
const LEGAL_TRANSITIONS: Record<FixTransition, readonly FixStatus[]> = {
  actioned: ['pending'],
  search_triggered: ['actioned'],
  failed: ['pending', 'actioned'],
};

export interface RecordFixActionInput {
  db?: DbClient;
  fixRequestId: string;
  transition: FixTransition;
  /** Required when transition === 'actioned' (AC-07 blocklist vs AC-08 delete fallback). */
  pathTaken?: FixPath;
  /** Ordered steps to append to actions_taken — raw *arr responses included (AC-07). */
  actions?: FixActionEntry[];
}

export interface RecordFixActionResult {
  status: FixStatus;
}

/**
 * DESIGN-005 D-09/D-12 — the single writer for fix lifecycle steps: one transaction
 * per step updates fix_requests.{status, path_taken, actions_taken} and writes the
 * matching ledger event ('fix_actioned' | 'fix_failed'; the search_triggered step
 * writes no event — LEDGER_EVENT_TYPES has no search marker, the accepted command id
 * lives in actions_taken). Illegal transitions throw InvalidFixTransitionError:
 * 'completed' and 'failed' are terminal — users re-raise rather than retry in place.
 */
export async function recordFixAction(input: RecordFixActionInput): Promise<RecordFixActionResult> {
  if (input.transition === 'actioned' && input.pathTaken === undefined) {
    throw new Error('recordFixAction: pathTaken is required for the actioned transition');
  }
  return inTransaction(input.db, async (tx) => {
    const [fix] = await tx
      .select({
        id: fixRequests.id,
        status: fixRequests.status,
        mediaItemId: fixRequests.mediaItemId,
      })
      .from(fixRequests)
      .where(eq(fixRequests.id, input.fixRequestId))
      .for('update');
    if (!fix) {
      throw new NotFoundError(`Fix request ${input.fixRequestId} not found`);
    }
    if (!LEGAL_TRANSITIONS[input.transition].includes(fix.status)) {
      throw new InvalidFixTransitionError(
        `Fix request ${fix.id} cannot transition '${fix.status}' → '${input.transition}'`,
      );
    }

    const actions = input.actions ?? [];
    await tx
      .update(fixRequests)
      .set({
        status: input.transition,
        ...(input.pathTaken !== undefined ? { pathTaken: input.pathTaken } : {}),
        ...(actions.length > 0
          ? {
              actionsTaken: sql`${fixRequests.actionsTaken} || ${JSON.stringify(actions)}::jsonb`,
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(fixRequests.id, fix.id));

    if (input.transition !== 'search_triggered') {
      await tx.insert(ledgerEvents).values({
        mediaItemId: fix.mediaItemId,
        eventType: input.transition === 'actioned' ? 'fix_actioned' : 'fix_failed',
        source: 'app',
        occurredAt: new Date(),
        payload: {
          fixRequestId: fix.id,
          transition: input.transition,
          ...(input.pathTaken !== undefined ? { pathTaken: input.pathTaken } : {}),
        },
      });
    }

    return { status: input.transition };
  });
}

export interface CompleteFixRequestsInput {
  db?: DbClient;
}

export interface CompletedFix {
  fixRequestId: string;
  completedEventId: string;
}

/**
 * DESIGN-005 D-09/D-12 — the matcher writer invoked by sync after import ingestion
 * (asynchronous by design — ADR-007 C-06): every 'search_triggered' fix whose target
 * has a later 'imported' ledger event (same media_item_id; child match via
 * payload.episodeId/payload.albumId for sonarr/lidarr, any import for radarr) flips
 * to 'completed', links completed_event_id, and writes a 'fix_completed' event — all
 * in one transaction.
 *
 * ADR-016 / D-19: subtitle fixes (path_taken 'bazarr_subtitle') are EXCLUDED — Bazarr
 * downloads subtitles, producing no 'imported' event, so an UNRELATED later import on the
 * same item (a normal re-grab of another file) must not spuriously flip the subtitle fix
 * to completed. They rest at 'search_triggered' (fire-and-forget).
 */
export async function completeFixRequests(
  input: CompleteFixRequestsInput = {},
): Promise<{ completed: CompletedFix[] }> {
  return inTransaction(input.db, async (tx) => {
    const open = await tx
      .select({
        id: fixRequests.id,
        mediaItemId: fixRequests.mediaItemId,
        targetArrChildId: fixRequests.targetArrChildId,
        createdAt: fixRequests.createdAt,
      })
      .from(fixRequests)
      .where(
        and(
          eq(fixRequests.status, 'search_triggered'),
          sql`${fixRequests.pathTaken} IS DISTINCT FROM 'bazarr_subtitle'`,
        ),
      )
      .for('update');

    const completed: CompletedFix[] = [];
    for (const fix of open) {
      const childMatch =
        fix.targetArrChildId === null
          ? sql`true`
          : sql`(${ledgerEvents.payload}->>'episodeId' = ${String(fix.targetArrChildId)}
              OR ${ledgerEvents.payload}->>'albumId' = ${String(fix.targetArrChildId)})`;
      const [event] = await tx
        .select({ id: ledgerEvents.id })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.mediaItemId, fix.mediaItemId),
            eq(ledgerEvents.eventType, 'imported'),
            gte(ledgerEvents.occurredAt, fix.createdAt),
            childMatch,
          ),
        )
        .orderBy(ledgerEvents.occurredAt)
        .limit(1);
      if (!event) continue;

      await tx
        .update(fixRequests)
        .set({ status: 'completed', completedEventId: event.id, updatedAt: sql`now()` })
        .where(eq(fixRequests.id, fix.id));
      await tx.insert(ledgerEvents).values({
        mediaItemId: fix.mediaItemId,
        eventType: 'fix_completed',
        source: 'app',
        occurredAt: new Date(),
        payload: { fixRequestId: fix.id, completedEventId: event.id },
      });
      completed.push({ fixRequestId: fix.id, completedEventId: event.id });
    }

    return { completed };
  });
}

export interface ExpireStaleFixRequestsInput {
  db?: DbClient;
  /** Override the age horizon (tests); default FIX_TIMEOUT_HORIZON_MS (48h, env-tunable). */
  horizonMs?: number;
  /** Reference "now" for the cutoff (tests/replay); default the DB clock. */
  asOf?: Date;
}

export interface TimedOutFix {
  fixRequestId: string;
}

/**
 * The never-stuck safety net (runs in the sync cron path alongside completeFixRequests). Any fix
 * still in an OPEN status (pending / actioned / search_triggered) older than the horizon closes to
 * the terminal 'timed_out' with an actions_taken audit note — no ledger event type is added (the
 * row IS the BC-03 audit record, exactly as the search_triggered step writes none). This is the
 * ONLY lifecycle path that closes a bazarr_subtitle fix: it is fire-and-forget (completeFixRequests
 * excludes it — no 'imported' event ever lands), so without a timeout it would hold the
 * one-open-fix-per-target lock forever. 'timed_out' is NOT an OPEN status, so the block releases.
 * Anchored on created_at (updated_at only advances on a lifecycle transition, which stops at
 * search_triggered, so it can't distinguish a live download); 48h is well beyond any real import.
 */
export async function expireStaleFixRequests(
  input: ExpireStaleFixRequestsInput = {},
): Promise<{ timedOut: TimedOutFix[] }> {
  const horizonMs = input.horizonMs ?? FIX_TIMEOUT_HORIZON_MS;
  const horizonHours = Math.max(1, Math.round(horizonMs / 3_600_000));
  const ref = input.asOf ? sql`${input.asOf.toISOString()}::timestamptz` : sql`now()`;
  return inTransaction(input.db, async (tx) => {
    const stale = await tx
      .select({ id: fixRequests.id })
      .from(fixRequests)
      .where(
        and(
          inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
          sql`${fixRequests.createdAt} < ${ref} - (interval '1 millisecond' * ${horizonMs})`,
        ),
      )
      .for('update');

    const timedOut: TimedOutFix[] = [];
    for (const fix of stale) {
      const note: FixActionEntry = {
        step: 'timed_out',
        at: new Date().toISOString(),
        note: `auto-closed after ${horizonHours}h with no confirmed import`,
      };
      await tx
        .update(fixRequests)
        .set({
          status: 'timed_out',
          actionsTaken: sql`${fixRequests.actionsTaken} || ${JSON.stringify([note])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(fixRequests.id, fix.id));
      timedOut.push({ fixRequestId: fix.id });
    }
    return { timedOut };
  });
}

export interface CloseFixManuallyInput {
  db?: DbClient;
  fixRequestId: string;
  /** The actor closing the fix — must be the requester or an admin (else NOT_FOUND, no leak). */
  actorId: string;
  actorIsAdmin?: boolean;
}

/**
 * The manual unblock (fix.close) — cheap insurance when a fix is stuck open but the requester or an
 * admin knows it is done/abandoned. Closes an OPEN fix to the terminal 'closed_manually' with an
 * actions_taken audit note (actor + timestamp). Own-fix or admin only; a non-owner gets NOT_FOUND
 * (never reveal another member's fix). An already-terminal fix throws InvalidFixTransitionError.
 * Like 'timed_out', 'closed_manually' is not an OPEN status, so it releases the one-open-fix block.
 */
export async function closeFixManually(
  input: CloseFixManuallyInput,
): Promise<{ status: FixStatus }> {
  return inTransaction(input.db, async (tx) => {
    const [fix] = await tx
      .select({
        id: fixRequests.id,
        status: fixRequests.status,
        requesterId: fixRequests.requesterId,
      })
      .from(fixRequests)
      .where(eq(fixRequests.id, input.fixRequestId))
      .for('update');
    if (!fix) {
      throw new NotFoundError(`Fix request ${input.fixRequestId} not found`);
    }
    // Own-fix or admin. Non-owners get NOT_FOUND (mirrors computeFixProgress — no leak).
    if (fix.requesterId !== input.actorId && !input.actorIsAdmin) {
      throw new NotFoundError(`Fix request ${input.fixRequestId} not found`);
    }
    if (!(OPEN_FIX_STATUSES as readonly string[]).includes(fix.status)) {
      throw new InvalidFixTransitionError(
        `Fix request ${fix.id} is already '${fix.status}' — nothing to close`,
      );
    }

    const note: FixActionEntry = {
      step: 'closed_manually',
      at: new Date().toISOString(),
      by: input.actorId,
      priorStatus: fix.status,
    };
    await tx
      .update(fixRequests)
      .set({
        status: 'closed_manually',
        actionsTaken: sql`${fixRequests.actionsTaken} || ${JSON.stringify([note])}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(fixRequests.id, fix.id));
    return { status: 'closed_manually' };
  });
}
