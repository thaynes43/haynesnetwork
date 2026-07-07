import { notifications, type DbClient, type NotificationSource } from '@hnet/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { resolveMediaItemId, resolveUserIdByEmail } from './ledger-ingest';

/**
 * ADR-023 / DESIGN-010 D-07 (addendum c) + ADR-026 / DESIGN-012 D-03 — the single writer for the
 * generic notification store. The `POST /api/webhooks/<source>` receiver (secret-gated) hands a
 * sanitized event here; Trash's Activity tab reads `source='maintainerr'` and the Bulletin Feed
 * browses the whole set. Deliberately source-agnostic. No audit row — this is an inbound event
 * feed, not a role/permission mutation; it is single-writer-confined only so the
 * no-direct-state-writes guard passes (the write path is auditable to one place).
 *
 * ADR-026 adds ATTRIBUTION + DEDUPE: the requester email is resolved to an app user via the SAME
 * email-only match Seerr ledger attribution uses (`resolveUserIdByEmail` — never a second path),
 * and the tmdb/tvdb id to a Media Item (`resolveMediaItemId`). Both best-effort — an unmatched
 * value stays null ("unattributed", ADR-008 C-05). Idempotent: an insert with a `sourceEventId`
 * conflicts on the `(source, source_event_id)` partial-unique index and DOES NOTHING (re-delivery
 * is a no-op), returning the existing row's id with `deduped: true`.
 */
export interface RecordNotificationInput {
  db?: DbClient;
  source: NotificationSource;
  type: string;
  title: string;
  body?: string;
  /** Source event time; defaults to now() when absent. */
  occurredAt?: Date | null;
  /** The source's stable event id — the dedupe key (null ⇒ always insert). */
  sourceEventId?: string | null;
  /** External ids for the Media Item match (+ the Seerr media_type hint). */
  tmdbId?: number | null;
  tvdbId?: number | null;
  mediaType?: string | null;
  /** The requester/viewer email for the email-only user attribution. */
  requesterEmail?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordNotification(
  input: RecordNotificationInput,
): Promise<{ id: string; deduped: boolean }> {
  const db = resolveDb(input.db);
  const actorUserId = await resolveUserIdByEmail(db, input.requesterEmail ?? null);
  const mediaItemId = await resolveMediaItemId(db, {
    mediaType: input.mediaType ?? null,
    tmdbId: input.tmdbId ?? null,
    tvdbId: input.tvdbId ?? null,
  });
  const [row] = await db
    .insert(notifications)
    .values({
      source: input.source,
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      occurredAt: input.occurredAt ?? undefined,
      sourceEventId: input.sourceEventId ?? null,
      tmdbId: input.tmdbId ?? null,
      tvdbId: input.tvdbId ?? null,
      mediaItemId,
      actorUserId,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (row) return { id: row.id, deduped: false };
  // Deduped (partial-unique conflict) — return the existing row's id so the receiver still 202s.
  if (input.sourceEventId) {
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.source, input.source),
          eq(notifications.sourceEventId, input.sourceEventId),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, deduped: true };
  }
  throw new Error('notification insert returned no row');
}

export interface NotificationView {
  id: string;
  source: NotificationSource;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/**
 * Read the notification feed newest first (the Trash Activity tab / a future Bulletin). A plain read
 * — unguarded. Pass a single `source` OR a `sources` set: the Trash Activity tab reads BOTH the
 * webhook-sourced `maintainerr` events AND the app's own `trash` deletion events (Maintainerr never
 * webhooks our API-triggered per-item deletes, so app-initiated deletions arrive only via `trash`).
 */
export async function listNotifications(input: {
  db?: DbClient;
  source?: NotificationSource;
  sources?: NotificationSource[];
  limit?: number;
}): Promise<NotificationView[]> {
  const db = resolveDb(input.db);
  const sources = input.sources ?? (input.source !== undefined ? [input.source] : []);
  if (sources.length === 0) {
    throw new Error('listNotifications requires a source or a non-empty sources array');
  }
  const rows = await db
    .select()
    .from(notifications)
    .where(
      sources.length === 1
        ? eq(notifications.source, sources[0]!)
        : inArray(notifications.source, sources),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(input.limit ?? 50);
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    type: r.type,
    title: r.title,
    body: r.body,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
    readAt: r.readAt === null ? null : r.readAt.toISOString(),
  }));
}
