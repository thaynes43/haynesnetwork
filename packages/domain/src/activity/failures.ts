// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the DURABLE failure ledger single-writer +
// the audited Admin actions. `evaluateActivityFailures` is the `activity-scan` sync mode's body: in ONE
// transaction it upserts the current OPEN import-failure set and CLOSES (resolved_at) the failures a scan no
// longer sees — never deleting them, so the detail page + audit survive. It enqueues NOTHING: ADR-090 /
// DESIGN-030 D-07a retired the per-failure `activity_import_failed` outbox row (owner ruling — NO per-event
// push, in-app only). The only failure notification is the nightly `failure-digest` email, which reads the
// OPEN ledger rows directly (activity/digest.ts). The retry-import / force-research actions stamp the row +
// co-write a permission_audit row in one tx (hard rule 6, the recordManualSearch precedent); the confined
// LL write fires AFTER commit in the API resolver.
import {
  activityImportFailures,
  permissionAudit,
  type ActivityImportFailureRow,
  type DbClient,
  type PermissionAuditAction,
} from '@hnet/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { inTransaction, resolveDb } from '../db-client';
import { NotFoundError } from '../errors';
import type { ActivityFailureKind, ActivityItem } from './contract';

/** One failure the scan observed (extracted from an adapter's `failed` items). */
export interface ActivityFailureInput {
  source: string;
  sourceRef: string;
  kind: string;
  section: string | null;
  failureKind: ActivityFailureKind;
  failureReason: string | null;
  title: string;
  year: number | null;
  sourceApp: string | null;
  downstreamUrl: string | null;
}

/** Pick the `failed` items of one adapter's output into ledger inputs. */
export function toFailureInputs(source: string, items: readonly ActivityItem[]): ActivityFailureInput[] {
  return items
    .filter((it) => it.stage === 'failed' && it.failureKind !== null)
    .map((it) => ({
      source,
      sourceRef: it.id,
      kind: it.kind,
      section: it.section,
      failureKind: it.failureKind as ActivityFailureKind,
      failureReason: it.failureReason,
      title: it.title,
      year: it.year,
      sourceApp: it.sourceApp,
      downstreamUrl: it.downstreamUrl,
    }));
}

export interface ActivityFailuresReport {
  /** Failures seen this scan. */
  seen: number;
  /** Newly-recorded (or re-opened) failures. Counted for the run log only — nothing is enqueued for them. */
  opened: number;
  /** Previously-open failures that cleared this scan. */
  resolved: number;
}

/**
 * Upsert the current failure set in one transaction. Only the `scannedSources` are reconciled (so a
 * books-only scan never resolves an *arr failure, and a source that was unreachable this run keeps its open
 * rows). A recurring failure whose row was resolved is RE-OPENED (first_seen_at restarts, the prior action
 * stamps clear so the badge re-arms); a still-open failure just refreshes last_seen_at and its display facts.
 *
 * Writes NO notification_outbox row (ADR-090 / DESIGN-030 D-07a): the owner ruled NO per-event push, and the
 * nightly `failure-digest` reads the open rows straight from this ledger. `notified_at` is RETIRED — nothing
 * writes or reads it any more; the column stays (no destructive migration) and is null on every row written
 * since.
 */
export async function evaluateActivityFailures(input: {
  db?: DbClient;
  failures: ActivityFailureInput[];
  /** The source families this scan covered (only these are reconciled/closed). */
  scannedSources: string[];
  now?: Date;
}): Promise<ActivityFailuresReport> {
  const now = input.now ?? new Date();

  let opened = 0;
  let resolved = 0;

  await inTransaction(input.db, async (tx) => {
    const currentRefs: string[] = [];
    for (const f of input.failures) {
      currentRefs.push(`${f.source}\u0000${f.sourceRef}`);
      const [existing] = await tx
        .select()
        .from(activityImportFailures)
        .where(and(eq(activityImportFailures.source, f.source), eq(activityImportFailures.sourceRef, f.sourceRef)))
        .for('update');

      const reopened = existing !== undefined && existing.resolvedAt !== null;

      if (existing) {
        await tx
          .update(activityImportFailures)
          .set({
            kind: f.kind,
            section: f.section,
            failureKind: f.failureKind,
            failureReason: f.failureReason,
            title: f.title,
            year: f.year,
            sourceApp: f.sourceApp,
            downstreamUrl: f.downstreamUrl,
            lastSeenAt: now,
            resolvedAt: null,
            // Re-opening clears the prior action so the badge re-arms.
            ...(reopened
              ? { firstSeenAt: now, lastActionAt: null, lastActionBy: null, lastAction: null }
              : {}),
          })
          .where(eq(activityImportFailures.id, existing.id));
      } else {
        await tx.insert(activityImportFailures).values({
          source: f.source,
          sourceRef: f.sourceRef,
          kind: f.kind,
          section: f.section,
          failureKind: f.failureKind,
          failureReason: f.failureReason,
          title: f.title,
          year: f.year,
          sourceApp: f.sourceApp,
          downstreamUrl: f.downstreamUrl,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }

      if (!existing || reopened) opened += 1;
    }

    // Close open failures for the scanned sources that the scan no longer sees.
    const openRows = await tx
      .select({ id: activityImportFailures.id, source: activityImportFailures.source, sourceRef: activityImportFailures.sourceRef })
      .from(activityImportFailures)
      .where(and(isNull(activityImportFailures.resolvedAt), inArray(activityImportFailures.source, input.scannedSources)));
    const currentSet = new Set(currentRefs);
    const toClose = openRows.filter((r) => !currentSet.has(`${r.source}\u0000${r.sourceRef}`)).map((r) => r.id);
    if (toClose.length > 0) {
      await tx
        .update(activityImportFailures)
        .set({ resolvedAt: now })
        .where(inArray(activityImportFailures.id, toClose));
      resolved = toClose.length;
    }
  });

  return { seen: input.failures.length, opened, resolved };
}

// ---------------------------------------------------------------------------
// Reads — the ledger for the tab join + the failure detail page.
// ---------------------------------------------------------------------------

/** Read one open/closed failure row by id (the detail resolver). */
export async function getActivityFailure(input: {
  db?: DbClient;
  failureId: string;
}): Promise<ActivityImportFailureRow | null> {
  const [row] = await resolveDb(input.db)
    .select()
    .from(activityImportFailures)
    .where(eq(activityImportFailures.id, input.failureId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Actions — the USER-initiated, AUDITED writes (R2). The confined LL write fires AFTER this commits.
// ---------------------------------------------------------------------------

export type ActivityActionKind = 'retry_import' | 'force_research';

/**
 * Record a retry-import / force-research on a failure: stamp last_action_* and co-write the matching
 * permission_audit row in ONE transaction (hard rule 6). Returns the failure row so the orchestrator can
 * fire the confined LazyLibrarian write (`forceProcess` / `searchBook`) after commit. NOT_FOUND for an
 * unknown id.
 */
export async function recordActivityAction(input: {
  db?: DbClient;
  failureId: string;
  action: ActivityActionKind;
  actorId: string | null;
}): Promise<{ failure: ActivityImportFailureRow }> {
  const auditAction: PermissionAuditAction =
    input.action === 'retry_import' ? 'activity_retry_import' : 'activity_force_search';
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(activityImportFailures)
      .where(eq(activityImportFailures.id, input.failureId))
      .for('update');
    if (!row) throw new NotFoundError(`Activity failure ${input.failureId} not found`);

    const now = new Date();
    await tx
      .update(activityImportFailures)
      .set({ lastActionAt: now, lastActionBy: input.actorId, lastAction: input.action })
      .where(eq(activityImportFailures.id, row.id));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: auditAction,
      detail: {
        failure_id: row.id,
        source: row.source,
        source_ref: row.sourceRef,
        failure_kind: row.failureKind,
        title: row.title,
      },
    });

    return { failure: { ...row, lastActionAt: now, lastActionBy: input.actorId, lastAction: input.action } };
  });
}
