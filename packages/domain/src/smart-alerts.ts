// ADR-040 / DESIGN-020 (PLAN-019) — the SMART-alert TRANSITION detector + single-writer. The
// `smart-alerts` sync mode reads the smartctl series through @hnet/metrics and calls
// `evaluateSmartAlerts`, which — per drive — compares the reading to the persisted `smart_drive_state`
// row and, on a CRITICAL transition (owner ruling R-130), enqueues ONE `notification_outbox` row AND
// upserts the state row in the SAME transaction (the outbox row is the durable transition record —
// CLAUDE.md hard rule 6). FIRST sight of a drive records a BASELINE and pages nothing — so the known
// expendable-staging-pool bad state (FAILED, critical_warning bit 2, wear 100) is recorded, not paged;
// only NEW deterioration pages. The state is re-synced to the current reading EVERY run, so "transition
// since the last check" is honest (a slow drift can't double-page against a frozen baseline).
import {
  smartDriveState,
  type DbClient,
  type NotifyOutboxEventType,
  type SmartDriveStateRow,
} from '@hnet/db';
import { inArray } from 'drizzle-orm';
import { inTransaction } from './db-client';
import { enqueueOutbox } from './notify-outbox';
import { computeEarliestSend, getNotifyWindow } from './notify-window';

/** available_spare must stay this many points above its threshold before we call the spare healthy
 *  (ADR-040 D-10 — mirrors @hnet/metrics SPARE_MARGIN_PCT; kept local to keep the domain decoupled). */
export const SMART_SPARE_MARGIN_PCT = 10;
/** The critical appdata pool wear marks that page (owner ruling R-130). */
export const SMART_WEAR_MARKS = [80, 90] as const;

/**
 * The SMART reading the evaluator consumes — structurally the @hnet/metrics `DriveSmartReading` (TS
 * structural typing lets the sync CLI pass it directly; no cross-package type import). Numbers, not
 * null — a missing metric defaults NO-ALERT-safe upstream so it can't false-trigger a page.
 */
export interface SmartDriveReading {
  driveKey: string;
  label: string;
  pool: string | null;
  /** true when the drive is in the CRITICAL appdata pool (the only pool the wear-crossing marks page). */
  criticalPool: boolean;
  smartStatus: 'pass' | 'fail';
  wearPct: number;
  mediaErrors: number;
  availableSpare: number;
  availableSpareThreshold: number;
  criticalWarning: number;
}

/** The subset of the prior state the transition rules compare against. */
export interface SmartDrivePriorState {
  smartStatus: 'pass' | 'fail';
  wearPct: number;
  mediaErrors: number;
  availableSpare: number;
  criticalWarning: number;
}

export interface SmartTransition {
  event: NotifyOutboxEventType | null; // 'smart_degraded' | 'smart_recovered' | null
  reasons: string[];
}

/**
 * Detect a CRITICAL transition from `prev` (stored) to `curr` (current reading). PURE + unit-tested.
 * Degradation reasons (any ⇒ `smart_degraded`):
 *   - `smart_status`   — pass→FAIL (a drive already FAILED at baseline never re-fires)
 *   - `media_errors`   — any INCREASE (0→n and n→m are each a new deterioration; a steady count never re-fires)
 *   - `available_spare`— crossing `threshold + MARGIN` from above
 *   - `critical_warning`— a NEW bit set (`curr & ~prev`) — the staging pool's baseline bit 2 never re-fires
 *   - `wear_80`/`wear_90` — the CRITICAL pool crossing a wear mark (the expendable pool is excluded)
 * Otherwise a FAIL→pass recovery ⇒ `smart_recovered`; else null.
 */
export function detectSmartTransition(
  prev: SmartDrivePriorState,
  curr: SmartDriveReading,
): SmartTransition {
  const reasons: string[] = [];
  if (prev.smartStatus !== 'fail' && curr.smartStatus === 'fail') reasons.push('smart_status');
  if (curr.mediaErrors > prev.mediaErrors) reasons.push('media_errors');
  const spareMargin = curr.availableSpareThreshold + SMART_SPARE_MARGIN_PCT;
  if (prev.availableSpare > spareMargin && curr.availableSpare <= spareMargin) {
    reasons.push('available_spare');
  }
  // NEW critical_warning bits only (bits already set at baseline never re-fire).
  if ((curr.criticalWarning & ~prev.criticalWarning) !== 0) reasons.push('critical_warning');
  if (curr.criticalPool) {
    for (const mark of SMART_WEAR_MARKS) {
      if (prev.wearPct < mark && curr.wearPct >= mark) reasons.push(`wear_${mark}`);
    }
  }
  if (reasons.length > 0) return { event: 'smart_degraded', reasons };
  if (prev.smartStatus === 'fail' && curr.smartStatus === 'pass') {
    return { event: 'smart_recovered', reasons: ['recovered'] };
  }
  return { event: null, reasons: [] };
}

export interface SmartAlertsReport {
  /** drives evaluated this run. */
  evaluated: number;
  /** first-seen drives recorded as a baseline (no page). */
  baselined: number;
  /** `smart_degraded` transitions this run. */
  degraded: number;
  /** `smart_recovered` transitions this run. */
  recovered: number;
  /** outbox rows enqueued this run (= degraded + recovered). */
  enqueued: number;
}

function toPrior(row: SmartDriveStateRow): SmartDrivePriorState {
  return {
    smartStatus: row.smartStatus === 'fail' ? 'fail' : 'pass',
    wearPct: row.wearPct,
    mediaErrors: row.mediaErrors,
    availableSpare: row.availableSpare,
    criticalWarning: row.criticalWarning,
  };
}

/**
 * Evaluate the SMART readings against stored state and enqueue transition pushes. Reads the delivery
 * window ONCE before the transaction (a stale-by-seconds window is harmless); then, in ONE transaction,
 * for each drive: baseline-insert a first-seen drive (no enqueue), or diff a known drive and — on a
 * transition — enqueue one outbox row AND re-sync its state row. Every drive's snapshot is refreshed
 * each run so "transition since the last check" stays honest. Disabled-safe: the enqueue ALWAYS records
 * the transition; the notify-outbox drainer no-ops when PUSHOVER_* is absent (ADR-034 C-03).
 */
export async function evaluateSmartAlerts(input: {
  db?: DbClient;
  drives: SmartDriveReading[];
  now?: Date;
}): Promise<SmartAlertsReport> {
  const now = input.now ?? new Date();
  const window = await getNotifyWindow(input.db);
  const earliestSendAt = computeEarliestSend(now, window);

  return inTransaction(input.db, async (tx) => {
    const keys = input.drives.map((d) => d.driveKey);
    const existingRows = keys.length
      ? await tx.select().from(smartDriveState).where(inArray(smartDriveState.driveKey, keys))
      : [];
    const existing = new Map(existingRows.map((r) => [r.driveKey, r]));

    let baselined = 0;
    let degraded = 0;
    let recovered = 0;
    let enqueued = 0;

    for (const d of input.drives) {
      const prevRow = existing.get(d.driveKey);
      let eventType: NotifyOutboxEventType | null = null;

      if (!prevRow) {
        baselined += 1; // first sight — record a baseline, page nothing
      } else {
        const { event, reasons } = detectSmartTransition(toPrior(prevRow), d);
        if (event !== null) {
          eventType = event;
          await enqueueOutbox(tx, {
            eventType: event,
            payload: {
              driveKey: d.driveKey,
              label: d.label,
              pool: d.pool,
              reasons,
              smartStatus: d.smartStatus,
              wearPct: d.wearPct,
              mediaErrors: d.mediaErrors,
              availableSpare: d.availableSpare,
              availableSpareThreshold: d.availableSpareThreshold,
              criticalWarning: d.criticalWarning,
            },
            earliestSendAt,
          });
          enqueued += 1;
          if (event === 'smart_degraded') degraded += 1;
          else recovered += 1;
        }
      }

      const lastEventType = eventType ?? prevRow?.lastEventType ?? null;
      await tx
        .insert(smartDriveState)
        .values({
          driveKey: d.driveKey,
          label: d.label,
          pool: d.pool,
          smartStatus: d.smartStatus,
          wearPct: Math.round(d.wearPct),
          mediaErrors: d.mediaErrors,
          availableSpare: d.availableSpare,
          criticalWarning: d.criticalWarning,
          lastEventType,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: smartDriveState.driveKey,
          set: {
            label: d.label,
            pool: d.pool,
            smartStatus: d.smartStatus,
            wearPct: Math.round(d.wearPct),
            mediaErrors: d.mediaErrors,
            availableSpare: d.availableSpare,
            criticalWarning: d.criticalWarning,
            lastEventType,
            updatedAt: now,
          },
        });
    }

    return { evaluated: input.drives.length, baselined, degraded, recovered, enqueued };
  });
}
