import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  repairRequests,
  users,
  watchCarries,
  type DbClient,
  type FixActionEntry,
  type FixPath,
  type FixReason,
  type FixStatus,
  type Transaction,
} from '@hnet/db';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  FixAlreadyOpenError,
  FixRateLimitError,
  InvalidFixTransitionError,
  LedgerItemTombstonedError,
  NotFoundError,
} from './errors';
import { inTransaction } from './db-client';
import { seerrIssueLinkFor } from './seerr-issue-link';
import { effectiveMediaActionBudget, mediaActionBudgetReachedMessage } from './media-action-budgets';
import { resolveFixTarget, type FixScope, type SearchScope } from './action-scope';

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
  // DESIGN-055 D-02, D-06 (PLAN-077 P5) — opening the Release Pick's list is one unit too (`release_list_requested`).
  const [searches] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEvents)
    .where(
      and(
        inArray(ledgerEvents.eventType, ['search_requested', 'release_list_requested']),
        eq(ledgerEvents.requestedByUserId, requesterId),
        sql`${ledgerEvents.recordedAt} > now() - interval '1 hour'`,
      ),
    );
  // ADR-109 C-04 / DESIGN-055 D-02 (PLAN-077 P2) — a confirmed Repair Request is one unit of the same budget.
  const [repairs] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.requesterId, requesterId),
        sql`${repairRequests.createdAt} > now() - interval '1 hour'`,
      ),
    );
  return (fixes?.count ?? 0) + (searches?.count ?? 0) + (repairs?.count ?? 0);
}

/**
 * ADR-109 C-04 / DESIGN-055 D-02 (PLAN-077 P2) — the open Repair Request on a Fix's grain, if any: the open check is
 * shared both ways. A movie Fix meets any open repair on the movie; a season Fix one on that season; an episode Fix one
 * that acts on its episode. (repair-requests.ts runs the reverse check.)
 */
async function findOpenRepairForFix(
  tx: Transaction,
  grain: { mediaItemId: string; scope: string; targetArrChildId: number | null; seasonNumber: number | null },
): Promise<{ id: string } | undefined> {
  const grainMatch =
    grain.scope === 'season' && grain.seasonNumber !== null
      ? sql`${repairRequests.seasonNumber} = ${grain.seasonNumber}`
      : grain.targetArrChildId !== null && Number.isInteger(grain.targetArrChildId)
        ? sql`${repairRequests.targetChildIds} @> ${sql.raw(`ARRAY[${grain.targetArrChildId}]::integer[]`)}`
        : sql`true`;
  const [open] = await tx
    .select({ id: repairRequests.id })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, grain.mediaItemId),
        inArray(repairRequests.status, ['pending', 'actioned']),
        grainMatch,
        // DESIGN-055 P6 decision 4: an Audio Preference touches no file, so it never holds up a Fix.
        ne(repairRequests.kind, 'audio_preference'),
      ),
    )
    .limit(1);
  return open;
}

export interface CreateFixRequestInput {
  db?: DbClient;
  /**
   * The person asking. null is staff working from the in-cluster tool (`repair-guide.ts copy-run`, DESIGN-055 P4
   * decision 25): no person, no budget, recorded as the staff tool (the P4 decision 17 pattern of Repair Requests).
   */
  requesterId: string | null;
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
  /**
   * PLAN-077 P7 — the Seerr issue the guide was opened from. Kept only for an open, mirrored issue on this title
   * (`seerrIssueLinkFor`); anything else links nothing and the Fix goes ahead. Its completion resolves the issue.
   */
  seerrIssueId?: number | null;
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
      sql`SELECT pg_advisory_xact_lock(hashtext('fix_requests'), hashtext(${input.requesterId ?? 'staff-tool'}))`,
    );

    let requester: { id: string; email: string | null; displayName: string | null; roleId: string | null } | null = null;
    if (input.requesterId !== null) {
      const [row] = await tx
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          roleId: users.roleId,
        })
        .from(users)
        .where(eq(users.id, input.requesterId));
      if (!row) {
        throw new NotFoundError(`User ${input.requesterId} not found`);
      }
      requester = row;
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

    if (requester !== null && !input.requesterIsAdmin) {
      // ADR-080 C-03/C-04 — the arr pool draws the REQUESTER'S ROLE budget (admin ⇒ null bypass,
      // else the role's row, else fallback 25). D-17 unchanged: Fix + Force Search share one hourly
      // counter (countRecentFixBudget) so the two actions can't be alternated to dodge the limit.
      const limit = await effectiveMediaActionBudget({ db: tx, roleId: requester.roleId });
      if (limit !== null) {
        const used = await countRecentFixBudget(tx, requester.id);
        if (used >= limit) {
          throw new FixRateLimitError(mediaActionBudgetReachedMessage(limit));
        }
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
    const openRepair = await findOpenRepairForFix(tx, {
      mediaItemId: input.mediaItemId,
      scope,
      targetArrChildId,
      seasonNumber,
    });
    if (openRepair) {
      throw new FixAlreadyOpenError(
        `An open repair (${openRepair.id}) already targets this ${scope === 'item' ? 'item' : scope}`,
      );
    }

    const createdSnapshot: FixActionEntry = {
      step: 'created',
      at: new Date().toISOString(),
      requester: requester
        ? { email: requester.email, displayName: requester.displayName }
        : { staffTool: 'repair-guide.ts' },
    };
    const [fix] = await tx
      .insert(fixRequests)
      .values({
        seerrIssueId: await seerrIssueLinkFor(tx, { seerrIssueId: input.seerrIssueId, mediaItemId: input.mediaItemId }),
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

/**
 * ADR-109 / DESIGN-055 D-09 (PLAN-077 P1) — the guards createFixRequest applies, read-only and before any *arr read:
 * the requester's hourly budget (admins bypass) and one open fix per grain. A guarded Fix and its preview call this
 * BEFORE they plan, because planning may run a live release search across every indexer; a request that would be
 * refused anyway must not cost one. createFixRequest still checks both again under its advisory lock (the
 * authoritative check); this one only refuses early.
 */
export async function assertFixAllowed(input: {
  db?: DbClient;
  /** null: the staff tool, matching createFixRequest's budget and audit convention. */
  requesterId: string | null;
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  scope: FixScope;
  targetArrChildId: number | null;
  seasonNumber: number | null;
}): Promise<void> {
  return inTransaction(input.db, async (tx) => {
    if (input.requesterId !== null && !input.requesterIsAdmin) {
      const [requester] = await tx
        .select({ roleId: users.roleId })
        .from(users)
        .where(eq(users.id, input.requesterId));
      if (!requester) throw new NotFoundError(`User ${input.requesterId} not found`);
      const limit = await effectiveMediaActionBudget({ db: tx, roleId: requester.roleId });
      if (limit !== null && (await countRecentFixBudget(tx, input.requesterId)) >= limit) {
        throw new FixRateLimitError(mediaActionBudgetReachedMessage(limit));
      }
    }
    const [open] = await tx
      .select({ id: fixRequests.id })
      .from(fixRequests)
      .where(
        and(
          eq(fixRequests.mediaItemId, input.mediaItemId),
          eq(fixRequests.targetScope, input.scope),
          sql`${fixRequests.targetArrChildId} IS NOT DISTINCT FROM ${input.targetArrChildId}`,
          sql`${fixRequests.targetSeason} IS NOT DISTINCT FROM ${input.seasonNumber}`,
          inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
        ),
      );
    if (open) {
      throw new FixAlreadyOpenError(
        `An open fix (${open.id}) already targets this ${input.scope === 'item' ? 'item' : input.scope}`,
      );
    }
    const openRepair = await findOpenRepairForFix(tx, {
      mediaItemId: input.mediaItemId,
      scope: input.scope,
      targetArrChildId: input.targetArrChildId,
      seasonNumber: input.seasonNumber,
    });
    if (openRepair) {
      throw new FixAlreadyOpenError(
        `An open repair (${openRepair.id}) already targets this ${input.scope === 'item' ? 'item' : input.scope}`,
      );
    }
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

/** Append a follow-through step to the original open Fix without pretending its lifecycle completed. */
export async function appendFixActions(input: {
  db?: DbClient;
  fixRequestId: string;
  actions: FixActionEntry[];
  /** Verified-import follow-through audit only; completed lifecycle is retained. */
  allowCompleted?: boolean;
}): Promise<void> {
  if (input.actions.length === 0) return;
  await inTransaction(input.db, async (tx) => {
    const [row] = await tx.select({ status: fixRequests.status }).from(fixRequests)
      .where(eq(fixRequests.id, input.fixRequestId)).for('update');
    if (!row || (!(OPEN_FIX_STATUSES as readonly string[]).includes(row.status) &&
      !(input.allowCompleted && row.status === 'completed'))) {
      throw new InvalidFixTransitionError('The Fix audit trail is closed');
    }
    await tx.update(fixRequests).set({
      actionsTaken: sql`${fixRequests.actionsTaken} || ${JSON.stringify(input.actions)}::jsonb`,
      updatedAt: sql`now()`,
    }).where(eq(fixRequests.id, input.fixRequestId));
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
        reason: fixRequests.reason,
        pathTaken: fixRequests.pathTaken,
        actionsTaken: fixRequests.actionsTaken,
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
      const matchedEventIds: string[] = [];
      let replacementIds: number[] | null = null;
      if (fix.reason === 'wrong_content' && fix.pathTaken === 'delete_search' &&
        fix.actionsTaken.some(a => a.step === 'wrong_content_replace')) {
        const carries = await tx.select().from(watchCarries).where(and(eq(watchCarries.mediaItemId, fix.mediaItemId),
          eq(watchCarries.kind, 'wrong_content')));
        const linked = carries.filter(c => c.detail.fixRequestId === fix.id);
        const carry = linked.length === 1 ? linked[0]! : null;
        const deletion = carry?.detail.wrongContentDeletion as { version?: number; grabStarted?: boolean; files?: Array<{
          id?: number; name?: string; size?: number; episodeIds?: number[] }> } | undefined;
        if (!carry || carry.status !== 'verified' || deletion?.version !== 1 || deletion.grabStarted !== true ||
          !Array.isArray(deletion.files) || !deletion.files.length || (Array.isArray(carry.scope.pendingDeletes) && carry.scope.pendingDeletes.length)) continue;
        if (deletion.files.some(f => !f || !Number.isInteger(f.id) || (f.id ?? 0) <= 0 || typeof f.name !== 'string' || !f.name ||
          typeof f.size !== 'number' || f.size <= 0 || !Array.isArray(f.episodeIds) || !f.episodeIds.length ||
          f.episodeIds.some(n => !Number.isInteger(n) || n <= 0))) continue;
        replacementIds = deletion.files.flatMap(f => f.episodeIds!);
        const [item] = await tx.select({ arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId }).from(mediaItems)
          .where(eq(mediaItems.id, fix.mediaItemId));
        if (!item || item.arrKind !== 'sonarr' || item.arrItemId !== carry.seriesId ||
          !replacementIds.includes(fix.targetArrChildId ?? -1) || new Set(replacementIds).size !== replacementIds.length) continue;
        for (const episodeId of replacementIds) {
          const [event] = await tx.select({ id: ledgerEvents.id }).from(ledgerEvents).where(and(
            eq(ledgerEvents.mediaItemId, fix.mediaItemId), eq(ledgerEvents.eventType, 'imported'),
            gte(ledgerEvents.occurredAt, fix.createdAt), sql`${ledgerEvents.payload}->>'episodeId' = ${String(episodeId)}`))
            .orderBy(ledgerEvents.occurredAt).limit(1);
          if (event) matchedEventIds.push(event.id);
        }
        if (matchedEventIds.length !== replacementIds.length) continue;
      }
      const childMatch =
        fix.targetArrChildId === null
          ? sql`true`
          : sql`(${ledgerEvents.payload}->>'episodeId' = ${String(fix.targetArrChildId)}
              OR ${ledgerEvents.payload}->>'albumId' = ${String(fix.targetArrChildId)})`;
      const [ordinaryEvent] = replacementIds ? [] : await tx
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
      const event = replacementIds ? { id: matchedEventIds[0]! } : ordinaryEvent;
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
        payload: { fixRequestId: fix.id, completedEventId: event.id,
          ...(replacementIds ? { targetEpisodeIds: replacementIds, completedEventIds: matchedEventIds } : {}) },
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
