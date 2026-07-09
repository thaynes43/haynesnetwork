// DESIGN-010/014 amendment (2026-07-09, build D) — DEBOUNCED POOL REFRESH AFTER SAVE. When the
// `pool_refresh_after_save` setting is on, a save/un-save on a pending wall asks Maintainerr to
// RE-EVALUATE its rules `delayMinutes` later, so a shielded (excluded) item drops out of the pending
// pool quickly instead of waiting up to Maintainerr's own rule-handler cadence (every 8 h on the live
// install). Two triggers drain the debounce:
//   (ii) FAST PATH — an in-process timer in the web pod, reset per save (trailing debounce). It is a
//        nicety: it works while the pod lives and is LOST on restart (documented, acceptable).
//   (i)  BACKSTOP — the incremental sync post-step (every 15 min) drains any `due_at <= now` marker.
//        Crash-safe: a marker survives a pod restart, so the refresh still fires (just later).
// Both drains call the SAME `drainDuePoolRefreshes`, which coalesces to ONE `POST /api/rules/execute`
// (Maintainerr re-evaluates ALL active rule groups — safe: it re-computes collection membership, never
// deletes) and deletes the drained markers. Concurrency: the in-process `executing` promise coalesces
// local fires, and Maintainerr's own single-run guard (409 'already running') is the cross-process
// backstop — a non-confirmed run leaves the marker for the next tick. Never throws for a Maintainerr
// outage (best-effort, like triggerCandidateRefresh).
import { pendingPoolRefresh, type DbClient, type TrashMediaKind } from '@hnet/db';
import { and, inArray, lte } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { getPoolRefreshAfterSave } from './app-settings';
import type { MaintainerrClientBundle } from './maintainerr-clients';

/** The write surface the refresh needs (executeAllRules) — the full bundle satisfies it. */
type PoolRefreshMaintainerr = Pick<MaintainerrClientBundle, 'write'>;

const MINUTE_MS = 60_000;

// One in-process timer per kind (reset on each save). `executing` coalesces concurrent local fires so a
// movie + tv timer landing together issue ONE rule execution.
const refreshTimers = new Map<TrashMediaKind, ReturnType<typeof setTimeout>>();
let executing: Promise<boolean> | null = null;

/** Coalesced, best-effort single rule execution. Returns true only when the POST was accepted; a 409
 *  'already running' / outage resolves to false so the marker is kept for the backstop to retry. */
function executeRulesOnce(maintainerr: PoolRefreshMaintainerr): Promise<boolean> {
  if (executing !== null) return executing;
  executing = maintainerr.write
    .executeAllRules()
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      executing = null;
    });
  return executing;
}

function scheduleInProcessTimer(
  kind: TrashMediaKind,
  delayMs: number,
  ctx: { db?: DbClient; maintainerr: PoolRefreshMaintainerr },
): void {
  const existing = refreshTimers.get(kind);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    refreshTimers.delete(kind);
    void drainDuePoolRefreshes({ db: ctx.db, maintainerr: ctx.maintainerr }).catch(() => undefined);
  }, delayMs);
  // Never keep the process (or a test runner) alive on account of the debounce timer.
  const maybeUnref = timer as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
  refreshTimers.set(kind, timer);
}

export interface RequestPoolRefreshInput {
  db?: DbClient;
  maintainerr: PoolRefreshMaintainerr;
  /** The saved item's kind (the wall is per-kind). */
  kind: TrashMediaKind;
  /** Attribution for the marker (best-effort). */
  actorId?: string | null;
  now?: Date;
  /** Test seam — skip arming the in-process timer (the marker + drain are exercised directly). */
  scheduleTimer?: boolean;
}

/**
 * Called after a save/un-save: if the setting is ON, upsert this kind's debounce marker with a future
 * `due_at` (= now + delayMinutes — a trailing debounce that COALESCES a burst of saves into one run
 * `delayMinutes` after the LAST save) and arm the in-process timer. A no-op when the setting is OFF
 * (respects enabled=false). The marker upsert is durable BEFORE we return so the backstop covers a pod
 * that dies before its timer fires.
 */
export async function requestPoolRefreshAfterSave(
  input: RequestPoolRefreshInput,
): Promise<{ enabled: boolean; dueAt: string | null }> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const setting = await getPoolRefreshAfterSave(input.db);
  if (!setting.enabled) return { enabled: false, dueAt: null };

  const dueAt = new Date(now.getTime() + setting.delayMinutes * MINUTE_MS);
  await db
    .insert(pendingPoolRefresh)
    .values({
      mediaKind: input.kind,
      dueAt,
      requestedAt: now,
      requestedBy: input.actorId ?? null,
    })
    .onConflictDoUpdate({
      target: pendingPoolRefresh.mediaKind,
      set: { dueAt, requestedAt: now, requestedBy: input.actorId ?? null },
    });

  if (input.scheduleTimer !== false) {
    scheduleInProcessTimer(input.kind, setting.delayMinutes * MINUTE_MS, {
      db: input.db,
      maintainerr: input.maintainerr,
    });
  }
  return { enabled: true, dueAt: dueAt.toISOString() };
}

export interface DrainPoolRefreshResult {
  /** The kinds whose markers were due this drain. */
  dueKinds: TrashMediaKind[];
  /** A rule execution was accepted (markers deleted). */
  executed: boolean;
  /** The setting was OFF at drain time — due markers cleared WITHOUT executing. */
  disabled: boolean;
}

/**
 * Drain every `due_at <= now` marker: coalesce to ONE Maintainerr rule execution and delete the drained
 * markers on success. Called by BOTH the in-process timer (fast path) and the incremental-sync backstop
 * (crash-safe). Respects enabled=false (clears due markers without executing). A failed/again-running
 * execution keeps the markers so the next backstop tick retries. Cheap no-op (no Maintainerr call) when
 * nothing is due.
 */
export async function drainDuePoolRefreshes(input: {
  db?: DbClient;
  maintainerr: PoolRefreshMaintainerr;
  now?: Date;
}): Promise<DrainPoolRefreshResult> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();

  const due = await db
    .select({ mediaKind: pendingPoolRefresh.mediaKind })
    .from(pendingPoolRefresh)
    .where(lte(pendingPoolRefresh.dueAt, now));
  const dueKinds = due.map((r) => r.mediaKind);
  if (dueKinds.length === 0) return { dueKinds: [], executed: false, disabled: false };

  const setting = await getPoolRefreshAfterSave(input.db);
  if (!setting.enabled) {
    await db.delete(pendingPoolRefresh).where(inArray(pendingPoolRefresh.mediaKind, dueKinds));
    return { dueKinds, executed: false, disabled: true };
  }

  const executed = await executeRulesOnce(input.maintainerr);
  if (executed) {
    // Delete only what was due AT `now` — a marker a concurrent save re-armed to the future survives.
    await db
      .delete(pendingPoolRefresh)
      .where(and(inArray(pendingPoolRefresh.mediaKind, dueKinds), lte(pendingPoolRefresh.dueAt, now)));
  }
  return { dueKinds, executed, disabled: false };
}

/** Test seam — cancel every armed in-process timer + reset the coalescing guard between tests. */
export function __clearPoolRefreshTimersForTests(): void {
  for (const t of refreshTimers.values()) clearTimeout(t);
  refreshTimers.clear();
  executing = null;
}
