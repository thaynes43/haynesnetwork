// ADR-060 follow-up (PLAN-048 tail, 2026-07-15) — the NIGHTLY admin failure digest: one
// email-channel outbox row summarizing every OPEN activity_import_failures row (the durable
// failure ledger evaluateActivityFailures maintains). Clean ledger ⇒ NO email (quiet success).
// Runs as the `failure-digest` sync mode (nightly CronJob); the notify-outbox drainer delivers.
// The recipient rides payload.to, resolved here at enqueue time (ADR-060 C-02).
import { activityImportFailures, type DbClient } from '@hnet/db';
import { asc, isNull } from 'drizzle-orm';
import { resolveDb } from '../db-client';
import { enqueueOutbox } from '../notify-outbox';
import { computeEarliestSend, getNotifyWindow } from '../notify-window';
import { buildQueueCleanupDigestSection } from '../queue-cleanup';
import { ticketAdminEmail } from '../tickets';
import { titleCheckDigestCounts } from '../title-check';

/** The digest lists at most this many failures in the email body (the count is always exact). */
const DIGEST_ITEM_CAP = 20;

export interface FailureDigestReport {
  /** OPEN failures at digest time (resolved_at IS NULL). */
  openCount: number;
  /** 1 when a digest email row was enqueued, 0 on a clean ledger AND a janitor-silent 24h. */
  enqueued: number;
  /** ADR-083 / DESIGN-046 D-07 — queue-janitor rows observed in the last 24h (0 when the janitor was silent). */
  queueObserved: number;
  /**
   * DESIGN-055 D-05 (PLAN-077 P4) — the Title Check line: flags opened in the last 24h and open in all. Present only when
   * either is above zero.
   */
  titleCheck?: { opened24h: number; open: number };
}

/**
 * Enqueue the nightly failure digest: ONE `activity_failure_digest` email row carrying the open
 * count + the oldest `DIGEST_ITEM_CAP` failures (title / kind / source). A clean ledger enqueues
 * nothing. The window read happens before the insert (the batch-writer pattern); a nightly
 * schedule inside quiet hours simply delivers at the window open.
 */
export async function runFailureDigest(input: {
  db?: DbClient;
  now?: Date;
  /** Recipient override (tests); defaults to `ticketAdminEmail()` (R-195's mailbox). */
  adminEmail?: string;
}): Promise<FailureDigestReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();

  const open = await db
    .select({
      title: activityImportFailures.title,
      failureKind: activityImportFailures.failureKind,
      source: activityImportFailures.source,
      sourceApp: activityImportFailures.sourceApp,
      firstSeenAt: activityImportFailures.firstSeenAt,
    })
    .from(activityImportFailures)
    .where(isNull(activityImportFailures.resolvedAt))
    .orderBy(asc(activityImportFailures.firstSeenAt));

  // ADR-083 / DESIGN-046 D-07 — the janitor section: the digest now enqueues when EITHER open failures exist
  // OR the janitor observed anything in the last 24h (a clean ledger no longer suppresses janitor visibility).
  const queueCleanup = await buildQueueCleanupDigestSection({ db: input.db, now });
  const queueObserved = queueCleanup?.observed ?? 0;

  // DESIGN-055 D-05 — the Title Check's one count line. A flag opened in 24h sends the digest by itself; open flags
  // alone only ride a digest that is going out anyway (no nightly mail for an old, unchanged flag).
  const flags = await titleCheckDigestCounts({ db: input.db, now });
  const titleCheck = flags.opened24h > 0 || flags.open > 0 ? flags : null;

  if (open.length === 0 && queueCleanup === null && flags.opened24h === 0) {
    return { openCount: 0, enqueued: 0, queueObserved: 0, ...(titleCheck ? { titleCheck } : {}) };
  }

  const window = await getNotifyWindow(input.db);
  await enqueueOutbox(db, {
    channel: 'email',
    eventType: 'activity_failure_digest',
    payload: {
      to: input.adminEmail ?? ticketAdminEmail(),
      count: open.length,
      items: open.slice(0, DIGEST_ITEM_CAP).map((f) => ({
        title: f.title,
        failureKind: f.failureKind,
        source: f.source,
        sourceApp: f.sourceApp,
      })),
      // The janitor rollup rides the SAME digest row (D-07); renderOutboxEmail composes the section +
      // appends '[janitor: promotion due]' to the subject when promotionDue.
      ...(queueCleanup ? { queueCleanup } : {}),
      ...(titleCheck ? { titleCheck } : {}),
    },
    earliestSendAt: computeEarliestSend(now, window),
  });
  return { openCount: open.length, enqueued: 1, queueObserved, ...(titleCheck ? { titleCheck } : {}) };
}
