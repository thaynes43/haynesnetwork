import { notifications, type DbClient, type NotificationSource } from '@hnet/db';
import { desc, eq } from 'drizzle-orm';
import { resolveDb } from './db-client';

/**
 * ADR-023 / DESIGN-010 D-07 (addendum c) — the single writer for the generic notification store.
 * The `POST /api/webhooks/<source>` receiver (secret-gated) hands a sanitized event here; Trash's
 * Activity tab reads it filtered to `source='maintainerr'`. Deliberately source-agnostic so
 * PLAN-009 (Bulletin) reuses it. No audit row — this is an inbound event feed, not a
 * role/permission mutation; it is single-writer-confined only so the no-direct-state-writes guard
 * passes (the write path is auditable to one place).
 */
export interface RecordNotificationInput {
  db?: DbClient;
  source: NotificationSource;
  type: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export async function recordNotification(
  input: RecordNotificationInput,
): Promise<{ id: string }> {
  const db = resolveDb(input.db);
  const [row] = await db
    .insert(notifications)
    .values({
      source: input.source,
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      payload: input.payload ?? {},
    })
    .returning({ id: notifications.id });
  if (!row) throw new Error('notification insert returned no row');
  return { id: row.id };
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
 * Read the notification feed for a source, newest first (the Trash Activity tab / a future
 * Bulletin). A plain read — unguarded.
 */
export async function listNotifications(input: {
  db?: DbClient;
  source: NotificationSource;
  limit?: number;
}): Promise<NotificationView[]> {
  const db = resolveDb(input.db);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.source, input.source))
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
