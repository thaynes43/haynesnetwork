import {
  mediaItems,
  messages,
  type DbClient,
  type MessageRow,
  type MessageStatus,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { MessageNotOwnedError, NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-026 / DESIGN-012 D-06 — the Bulletin Messages board single-writers. A Message is free-form
 * discussion/triage that COMPLEMENTS the structured Fix flow; it never mutates media/*arr state
 * (discussion only — the linked media item is a reference, never a write). Moderation is soft:
 * status transitions preserve the row + content (the audit trail). Guard-listed — `messages` is
 * written only through this module (defence-in-depth beneath the API permission gate).
 */

async function assertMediaItemExists(
  db: ReturnType<typeof resolveDb>,
  mediaItemId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .limit(1);
  if (!row) throw new NotFoundError(`Media item ${mediaItemId} not found`);
}

export interface PostMessageInput {
  db?: DbClient;
  authorId: string;
  subject?: string | null;
  body: string;
  mediaItemId?: string | null;
}

/** Post a new Message (the `post` action). Validates the optional media-item link exists. */
export async function postMessage(input: PostMessageInput): Promise<MessageRow> {
  const db = resolveDb(input.db);
  if (input.mediaItemId) await assertMediaItemExists(db, input.mediaItemId);
  const [row] = await db
    .insert(messages)
    .values({
      authorUserId: input.authorId,
      subject: input.subject ?? null,
      body: input.body,
      mediaItemId: input.mediaItemId ?? null,
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}

export interface EditMessageInput {
  db?: DbClient;
  messageId: string;
  editorId: string;
  subject?: string | null;
  body: string;
}

/**
 * Edit a Message's content (the `post` action, AUTHOR-ONLY). The author may edit their own message
 * any time; another user's message is never content-edited (moderation is status-only — content is
 * preserved). Editing a non-owned message ⇒ MessageNotOwnedError. Sets `edited_at`.
 */
export async function editMessage(input: EditMessageInput): Promise<MessageRow> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id, authorUserId: messages.authorUserId })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .for('update');
    if (!existing) throw new NotFoundError(`Message ${input.messageId} not found`);
    if (existing.authorUserId !== input.editorId) {
      throw new MessageNotOwnedError('You can only edit your own messages.');
    }
    const [row] = await tx
      .update(messages)
      .set({ subject: input.subject ?? null, body: input.body, editedAt: new Date() })
      .where(eq(messages.id, input.messageId))
      .returning();
    if (!row) throw new Error('message update returned no row');
    return row;
  });
}

export interface ModerateMessageInput {
  db?: DbClient;
  messageId: string;
  moderatorId: string;
  /** The new moderation status (visible restores, hidden soft-hides, deleted soft-deletes). */
  status: MessageStatus;
  note?: string | null;
}

/**
 * Moderate a Message (the `moderate` action) — transition its status to hidden/deleted/visible and
 * stamp the moderation trail (`moderated_by`/`moderated_at`/`moderation_note`) in one tx. Content
 * is PRESERVED (never physically removed) so the row remains an audit record. Any message may be
 * moderated (not just one's own); the `moderate` grant is enforced at the API gate.
 */
export async function moderateMessage(input: ModerateMessageInput): Promise<MessageRow> {
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .for('update');
    if (!existing) throw new NotFoundError(`Message ${input.messageId} not found`);
    const [row] = await tx
      .update(messages)
      .set({
        status: input.status,
        moderatedBy: input.moderatorId,
        moderatedAt: new Date(),
        moderationNote: input.note ?? null,
      })
      .where(eq(messages.id, input.messageId))
      .returning();
    if (!row) throw new Error('message moderation returned no row');
    return row;
  });
}
