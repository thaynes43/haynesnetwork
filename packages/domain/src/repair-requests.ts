// ADR-109 C-04 / DESIGN-055 D-02 (PLAN-077 P2) — the Repair Request (T-302) single writer. A remedy a person confirmed
// in the Repair Guide is one repair_requests row: it commits with its `repair_requested` ledger event, under the same
// per-requester advisory lock and hourly budget as Fix and Force Search, BEFORE any *arr call; every later step is a
// transition here. P2 writes kind `import_download` (the Import Check's ManualImport, D-07); later phases add theirs.
//
// One open repair per grain (D-02): at most one open Repair Request or Fix Request per movie, or per (series, season);
// the check is shared both ways (createFixRequest and assertFixAllowed read open repairs too). An episode Fix knows its
// episode, not its season, so against a Fix the season grain is matched by the Fix's season (a season Fix) or by its
// episode (an episode Fix on one of the repair's episodes, or on any episode of the season the caller names).
import {
  ledgerEvents,
  mediaItems,
  repairRequests,
  users,
  fixRequests,
  type DbClient,
  type FixActionEntry,
  type FixReason,
  type RepairRequestKind,
  type RepairRequestScope,
  type RepairRequestStatus,
  type Transaction,
} from '@hnet/db';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  FixAlreadyOpenError,
  FixRateLimitError,
  InvalidFixTransitionError,
  LedgerItemTombstonedError,
  NotFoundError,
} from './errors';
import { inTransaction } from './db-client';
import { effectiveMediaActionBudget, mediaActionBudgetReachedMessage } from './media-action-budgets';
import { FIX_TIMEOUT_HORIZON_MS, OPEN_FIX_STATUSES, countRecentFixBudget } from './fix-requests';

/** D-02: the statuses that hold the one-open-repair-per-grain rule. */
export const OPEN_REPAIR_STATUSES = ['pending', 'actioned'] as const satisfies readonly RepairRequestStatus[];

export interface CreateRepairRequestInput {
  db?: DbClient;
  /**
   * The person who confirmed the remedy. null is staff working from the in-cluster tool (`repair-guide.ts`, DESIGN-055
   * P4 decision 17): no person, no budget, recorded as the staff tool, the "audited, actor null" pattern of the settings.
   */
  requesterId: string | null;
  /** Admins bypass the hourly budget (ADR-080), as for Fix. */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  kind: RepairRequestKind;
  scope: RepairRequestScope;
  /** The target's season (TV); null for a movie. */
  seasonNumber: number | null;
  /** The episodes the remedy acts on (TV); [] for a movie. */
  targetChildIds: number[];
  /** Every episode id of the target's season, when the caller has them: an open episode Fix on any of them blocks. */
  seasonEpisodeIds?: number[];
  targetLabel?: string | null;
  /** A FIX_REASONS value when the guide started from Fix; null from Force Search. */
  reason?: FixReason | null;
  /** Exactly what the person was shown and confirmed. */
  preview: Record<string, unknown>;
}

/** A literal integer[] for an id list that came through zod as integers (never interpolates anything else). */
function intArray(ids: readonly number[]) {
  const safe = [...new Set(ids.filter((n) => Number.isInteger(n)))];
  return sql.raw(`ARRAY[${safe.join(',')}]::integer[]`);
}

/**
 * The open Repair Request on a grain, if any (D-02), read inside the caller's transaction (under its advisory lock):
 * any on a movie (`seasonNumber` null and no episodes); else any on the same season, or holding one of `episodeIds`
 * (an episode Fix knows its episode, not its season).
 *
 * `episodeGrain` (DESIGN-055 P5 decision 6): a remedy that adds a file to one episode (an import, a Release Pick) meets a
 * season-wide repair on its season (a re-map) and any repair holding one of its episodes, not one on another episode of
 * the season, which touches a different file. `ignoreKinds` leaves out the open repairs a remedy follows through: an
 * import onto an episode is how a Release Pick's grab lands, so an open pick on that episode does not hold it up.
 */
export async function findOpenRepair(
  tx: Transaction,
  grain: { mediaItemId: string; seasonNumber: number | null; episodeIds?: readonly number[] },
  options: {
    episodeGrain?: boolean;
    ignoreKinds?: readonly RepairRequestKind[];
    /** Only these kinds count, on the whole title (`grain` is ignored): the Audio Preference's own check. */
    onlyKinds?: readonly RepairRequestKind[];
  } = {},
): Promise<{ id: string } | undefined> {
  const episodes = (grain.episodeIds ?? []).filter((n) => Number.isInteger(n));
  const seasonMatch =
    grain.seasonNumber === null
      ? null
      : options.episodeGrain
        ? sql`(${repairRequests.scope} = 'season' AND ${repairRequests.seasonNumber} = ${grain.seasonNumber})`
        : sql`${repairRequests.seasonNumber} = ${grain.seasonNumber}`;
  const conditions = [
    ...(seasonMatch ? [seasonMatch] : []),
    ...(episodes.length > 0 ? [sql`${repairRequests.targetChildIds} && ${intArray(episodes)}`] : []),
  ];
  const only = options.onlyKinds ?? [];
  const grainMatch =
    only.length > 0 || conditions.length === 0 ? sql`true` : sql`(${sql.join(conditions, sql` OR `)})`;
  const ignored = options.ignoreKinds ?? [];
  const [open] = await tx
    .select({ id: repairRequests.id })
    .from(repairRequests)
    .where(
      and(
        eq(repairRequests.mediaItemId, grain.mediaItemId),
        inArray(repairRequests.status, [...OPEN_REPAIR_STATUSES]),
        grainMatch,
        ...(ignored.length > 0 ? [notInArray(repairRequests.kind, [...ignored])] : []),
        ...(only.length > 0 ? [inArray(repairRequests.kind, [...only])] : []),
      ),
    )
    .limit(1);
  return open;
}

/**
 * DESIGN-055 P5 decision 6 — the open check for a new Repair Request: an episode remedy (an import, a Release Pick) is
 * held up only by repairs on its own episode or a season-wide one on its season; an import is never held up by the open
 * Release Pick it follows through.
 */
function openCheckOptions(kind: RepairRequestKind, scope: RepairRequestScope) {
  // DESIGN-055 P6 decision 4: the Audio Preference changes a title-wide Plex setting and no file, so only another open
  // Audio Preference on the same title holds it up (and it holds up nothing else).
  if (kind === 'audio_preference') return { onlyKinds: ['audio_preference'] as const };
  return {
    episodeGrain: scope === 'episode',
    ignoreKinds:
      kind === 'import_download' ? (['release_pick', 'audio_preference'] as const) : (['audio_preference'] as const),
  };
}

/** The open Fix Request on a repair's grain (D-02, shared both ways), if any. */
async function findOpenFixForRepair(
  tx: Transaction,
  grain: { mediaItemId: string; seasonNumber: number | null; episodeIds: readonly number[] },
): Promise<{ id: string } | undefined> {
  const ids = grain.episodeIds.filter((n) => Number.isInteger(n));
  const conditions = [
    ...(grain.seasonNumber !== null ? [sql`${fixRequests.targetSeason} = ${grain.seasonNumber}`] : []),
    ...(ids.length > 0 ? [sql`${fixRequests.targetArrChildId} = ANY (${intArray(ids)})`] : []),
  ];
  const grainMatch = conditions.length === 0 ? sql`true` : sql`(${sql.join(conditions, sql` OR `)})`;
  const [open] = await tx
    .select({ id: fixRequests.id })
    .from(fixRequests)
    .where(
      and(
        eq(fixRequests.mediaItemId, grain.mediaItemId),
        inArray(fixRequests.status, [...OPEN_FIX_STATUSES]),
        grainMatch,
      ),
    )
    .limit(1);
  return open;
}

/**
 * DESIGN-055 D-02 — the single writer opening a Repair Request: the pending row (actionsTaken[0] = the requester
 * snapshot) and its `repair_requested` ledger event in ONE transaction, before any *arr call. Guards inside the same
 * transaction, under the per-requester advisory lock createFixRequest uses: the shared hourly budget (admins bypass),
 * one open repair or fix per grain, no repair on a tombstoned item.
 */
export async function createRepairRequest(input: CreateRepairRequestInput): Promise<{ repairRequestId: string }> {
  return inTransaction(input.db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('fix_requests'), hashtext(${input.requesterId ?? 'staff-tool'}))`,
    );
    let requester: { id: string; email: string | null; displayName: string | null; roleId: string | null } | null = null;
    if (input.requesterId !== null) {
      const [row] = await tx
        .select({ id: users.id, email: users.email, displayName: users.displayName, roleId: users.roleId })
        .from(users)
        .where(eq(users.id, input.requesterId));
      if (!row) throw new NotFoundError(`User ${input.requesterId} not found`);
      requester = row;
    }

    const [item] = await tx
      .select({ id: mediaItems.id, deletedFromArrAt: mediaItems.deletedFromArrAt })
      .from(mediaItems)
      .where(eq(mediaItems.id, input.mediaItemId));
    if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
    if (item.deletedFromArrAt !== null) {
      throw new LedgerItemTombstonedError(`Media item ${input.mediaItemId} is tombstoned — nothing to repair in the *arr`);
    }
    if ((input.scope === 'item') !== (input.seasonNumber === null)) {
      throw new Error('createRepairRequest: a season or an episode names its season; a movie names none');
    }

    if (requester !== null && !input.requesterIsAdmin) {
      const limit = await effectiveMediaActionBudget({ db: tx, roleId: requester.roleId });
      if (limit !== null && (await countRecentFixBudget(tx, requester.id)) >= limit) {
        throw new FixRateLimitError(mediaActionBudgetReachedMessage(limit));
      }
    }

    const grain = {
      mediaItemId: input.mediaItemId,
      seasonNumber: input.seasonNumber,
      episodeIds: [...input.targetChildIds, ...(input.seasonEpisodeIds ?? [])],
    };
    const openRepair = await findOpenRepair(
      tx,
      { mediaItemId: input.mediaItemId, seasonNumber: input.seasonNumber, episodeIds: input.targetChildIds },
      openCheckOptions(input.kind, input.scope),
    );
    if (openRepair) {
      throw new FixAlreadyOpenError(
        `An open repair (${openRepair.id}) already targets this ${input.scope === 'item' ? 'item' : 'season'}`,
      );
    }
    const openFix = input.kind === 'audio_preference' ? undefined : await findOpenFixForRepair(tx, grain);
    if (openFix) {
      throw new FixAlreadyOpenError(
        `An open fix (${openFix.id}) already targets this ${input.scope === 'item' ? 'item' : 'season'}`,
      );
    }

    const created: FixActionEntry = {
      step: 'created',
      at: new Date().toISOString(),
      requester: requester
        ? { email: requester.email, displayName: requester.displayName }
        : { staffTool: 'repair-guide.ts' },
    };
    const [row] = await tx
      .insert(repairRequests)
      .values({
        requesterId: input.requesterId,
        mediaItemId: input.mediaItemId,
        kind: input.kind,
        scope: input.scope,
        seasonNumber: input.seasonNumber,
        targetChildIds: input.targetChildIds,
        targetLabel: input.targetLabel ?? null,
        reason: input.reason ?? null,
        preview: input.preview,
        actionsTaken: [created],
      })
      .returning({ id: repairRequests.id });
    if (!row) throw new Error('repair_requests insert returned no row');

    await tx.insert(ledgerEvents).values({
      mediaItemId: input.mediaItemId,
      eventType: 'repair_requested',
      source: 'app',
      occurredAt: new Date(),
      requestedByUserId: input.requesterId,
      payload: {
        repairRequestId: row.id,
        kind: input.kind,
        scope: input.scope,
        seasonNumber: input.seasonNumber,
        targetChildIds: input.targetChildIds,
        targetLabel: input.targetLabel ?? null,
        requesterId: input.requesterId,
      },
    });
    return { repairRequestId: row.id };
  });
}

/** The lifecycle steps after `pending` (D-02). */
export type RepairTransition = 'actioned' | 'completed' | 'failed' | 'refused';

const LEGAL_REPAIR_TRANSITIONS: Record<RepairTransition, readonly RepairRequestStatus[]> = {
  actioned: ['pending'],
  completed: ['pending', 'actioned'],
  failed: ['pending', 'actioned'],
  refused: ['pending'],
};

const TRANSITION_EVENT: Partial<Record<RepairTransition, 'repair_completed' | 'repair_failed'>> = {
  completed: 'repair_completed',
  failed: 'repair_failed',
};

/**
 * DESIGN-055 D-02 — one lifecycle step: the row's status, its appended actions, and (completed, failed) the matching
 * ledger event, in one transaction. `completed` stamps completed_at. An illegal step throws InvalidFixTransitionError.
 */
export async function recordRepairTransition(input: {
  db?: DbClient;
  repairRequestId: string;
  transition: RepairTransition;
  actions?: FixActionEntry[];
}): Promise<{ status: RepairRequestStatus }> {
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({ id: repairRequests.id, status: repairRequests.status, mediaItemId: repairRequests.mediaItemId, kind: repairRequests.kind })
      .from(repairRequests)
      .where(eq(repairRequests.id, input.repairRequestId))
      .for('update');
    if (!row) throw new NotFoundError(`Repair request ${input.repairRequestId} not found`);
    if (!LEGAL_REPAIR_TRANSITIONS[input.transition].includes(row.status)) {
      throw new InvalidFixTransitionError(
        `Repair request ${row.id} cannot transition '${row.status}' → '${input.transition}'`,
      );
    }
    const actions = input.actions ?? [];
    await tx
      .update(repairRequests)
      .set({
        status: input.transition,
        ...(actions.length > 0
          ? { actionsTaken: sql`${repairRequests.actionsTaken} || ${JSON.stringify(actions)}::jsonb` }
          : {}),
        ...(input.transition === 'completed' ? { completedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(repairRequests.id, row.id));
    const eventType = TRANSITION_EVENT[input.transition];
    if (eventType) {
      await tx.insert(ledgerEvents).values({
        mediaItemId: row.mediaItemId,
        eventType,
        source: 'app',
        occurredAt: new Date(),
        payload: { repairRequestId: row.id, kind: row.kind, transition: input.transition },
      });
    }
    return { status: input.transition };
  });
}

/**
 * DESIGN-055 D-02, D-04 rule 7 (PLAN-077 P4) — append steps to an OPEN Repair Request's trail without moving its status:
 * an Episode Re-map records every move and its read-back as it goes, so a run that stops part way shows exactly which
 * moves landed. Throws InvalidFixTransitionError on a closed row.
 */
export async function appendRepairActions(input: {
  db?: DbClient;
  repairRequestId: string;
  actions: FixActionEntry[];
}): Promise<void> {
  if (input.actions.length === 0) return;
  await inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({ id: repairRequests.id, status: repairRequests.status })
      .from(repairRequests)
      .where(eq(repairRequests.id, input.repairRequestId))
      .for('update');
    if (!row) throw new NotFoundError(`Repair request ${input.repairRequestId} not found`);
    if (!(OPEN_REPAIR_STATUSES as readonly string[]).includes(row.status)) {
      throw new InvalidFixTransitionError(`Repair request ${row.id} is ${row.status}; its trail is closed`);
    }
    await tx
      .update(repairRequests)
      .set({
        actionsTaken: sql`${repairRequests.actionsTaken} || ${JSON.stringify(input.actions)}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(repairRequests.id, row.id));
  });
}

/**
 * DESIGN-055 D-02 — completion is read, never assumed: an `actioned` import, or an `actioned` Release Pick (P5), whose
 * every target episode (or, for a movie, the movie) has an `imported` ledger event since the request was opened
 * completes, with a `repair_completed` event. Runs in the sync post-steps beside completeFixRequests (an import the
 * guide could not wait out, and a picked release once its download is imported, by the *arr itself, by the Import Check
 * or by the janitor).
 */
export async function completeRepairRequests(input: { db?: DbClient } = {}): Promise<{ completed: string[] }> {
  return inTransaction(input.db, async (tx) => {
    const open = await tx
      .select({
        id: repairRequests.id,
        mediaItemId: repairRequests.mediaItemId,
        targetChildIds: repairRequests.targetChildIds,
        createdAt: repairRequests.createdAt,
        kind: repairRequests.kind,
      })
      .from(repairRequests)
      .where(
        and(
          eq(repairRequests.status, 'actioned'),
          inArray(repairRequests.kind, ['import_download', 'release_pick']),
        ),
      )
      .for('update');
    const completed: string[] = [];
    for (const r of open) {
      const children = r.targetChildIds.length > 0 ? r.targetChildIds : [null];
      let all = true;
      const eventIds: string[] = [];
      for (const child of children) {
        const childMatch = child === null ? sql`true` : sql`${ledgerEvents.payload}->>'episodeId' = ${String(child)}`;
        const [event] = await tx
          .select({ id: ledgerEvents.id })
          .from(ledgerEvents)
          .where(
            and(
              eq(ledgerEvents.mediaItemId, r.mediaItemId),
              eq(ledgerEvents.eventType, 'imported'),
              sql`${ledgerEvents.occurredAt} >= ${r.createdAt.toISOString()}::timestamptz`,
              childMatch,
            ),
          )
          .limit(1);
        if (!event) {
          all = false;
          break;
        }
        eventIds.push(event.id);
      }
      if (!all) continue;
      const note: FixActionEntry = { step: 'completed', at: new Date().toISOString(), importedEventIds: eventIds };
      await tx
        .update(repairRequests)
        .set({
          status: 'completed',
          completedAt: sql`now()`,
          actionsTaken: sql`${repairRequests.actionsTaken} || ${JSON.stringify([note])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(repairRequests.id, r.id));
      await tx.insert(ledgerEvents).values({
        mediaItemId: r.mediaItemId,
        eventType: 'repair_completed',
        source: 'app',
        occurredAt: new Date(),
        payload: { repairRequestId: r.id, kind: r.kind, importedEventIds: eventIds },
      });
      completed.push(r.id);
    }
    return { completed };
  });
}

/**
 * DESIGN-055 D-02 — the never-stuck net: an open Repair Request older than the 48-hour horizon (FIX_TIMEOUT_HORIZON_MS)
 * closes to `timed_out` with a note, releasing its grain. No ledger event, as for a timed-out Fix.
 */
export async function expireStaleRepairRequests(
  input: { db?: DbClient; horizonMs?: number; asOf?: Date } = {},
): Promise<{ timedOut: string[] }> {
  const horizonMs = input.horizonMs ?? FIX_TIMEOUT_HORIZON_MS;
  const horizonHours = Math.max(1, Math.round(horizonMs / 3_600_000));
  const ref = input.asOf ? sql`${input.asOf.toISOString()}::timestamptz` : sql`now()`;
  return inTransaction(input.db, async (tx) => {
    const stale = await tx
      .select({ id: repairRequests.id })
      .from(repairRequests)
      .where(
        and(
          inArray(repairRequests.status, [...OPEN_REPAIR_STATUSES]),
          sql`${repairRequests.createdAt} < ${ref} - (interval '1 millisecond' * ${horizonMs})`,
        ),
      )
      .for('update');
    const timedOut: string[] = [];
    for (const r of stale) {
      const note: FixActionEntry = {
        step: 'timed_out',
        at: new Date().toISOString(),
        note: `auto-closed after ${horizonHours}h with no confirmed result`,
      };
      await tx
        .update(repairRequests)
        .set({
          status: 'timed_out',
          actionsTaken: sql`${repairRequests.actionsTaken} || ${JSON.stringify([note])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(repairRequests.id, r.id));
      timedOut.push(r.id);
    }
    return { timedOut };
  });
}
