// ADR-026 / DESIGN-012 D-06 — the Messages board single-writers: postMessage (+ optional media FK
// validation), editMessage (author-only), moderateMessage (soft status transitions preserve
// content). Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, messages } from '@hnet/db/schema';
import {
  MessageModeratedError,
  MessageNotOwnedError,
  NotFoundError,
  editMessage,
  moderateMessage,
  postMessage,
  upsertMediaItemsBatch,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

describe('Messages board writers (ADR-026 D-06)', () => {
  let t: TestDb;
  let authorId: string;
  let otherId: string;
  let moderatorId: string;
  let mediaItemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    authorId = (await createUser(t.db, { email: 'author@example.com' })).id;
    otherId = (await createUser(t.db, { email: 'other@example.com' })).id;
    moderatorId = (await createUser(t.db, { email: 'mod@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 7100,
          tmdbId: 7100,
          title: 'Broken Movie',
          sortTitle: 'broken movie',
          year: 2020,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/data/movies',
          onDiskFileCount: 1,
          expectedFileCount: 1,
          sizeOnDisk: 1,
        },
      ],
    });
    const [row] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.arrItemId, 7100))
      .limit(1);
    mediaItemId = row!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('posts a message with an optional subject + media link', async () => {
    const row = await postMessage({
      db: t.db,
      authorId,
      subject: 'It wont play',
      body: 'The Matrix buffers forever',
      mediaItemId,
    });
    expect(row.status).toBe('visible');
    expect(row.authorUserId).toBe(authorId);
    expect(row.mediaItemId).toBe(mediaItemId);
    expect(row.subject).toBe('It wont play');
  });

  it('posts a subject-less message (subject optional, body required)', async () => {
    const row = await postMessage({ db: t.db, authorId, body: 'general question' });
    expect(row.subject).toBeNull();
    expect(row.mediaItemId).toBeNull();
  });

  it('rejects a message linked to a non-existent media item (NotFound)', async () => {
    await expect(
      postMessage({
        db: t.db,
        authorId,
        body: 'x',
        mediaItemId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets the AUTHOR edit their own message (edited_at set)', async () => {
    const posted = await postMessage({ db: t.db, authorId, body: 'typo here' });
    expect(posted.editedAt).toBeNull();
    const edited = await editMessage({
      db: t.db,
      messageId: posted.id,
      editorId: authorId,
      body: 'fixed now',
    });
    expect(edited.body).toBe('fixed now');
    expect(edited.editedAt).not.toBeNull();
  });

  it('rejects editing another user’s message (MessageNotOwned)', async () => {
    const posted = await postMessage({ db: t.db, authorId, body: 'mine' });
    await expect(
      editMessage({ db: t.db, messageId: posted.id, editorId: otherId, body: 'hijack' }),
    ).rejects.toBeInstanceOf(MessageNotOwnedError);
  });

  it('moderation hides/deletes/restores WITHOUT destroying content (soft status)', async () => {
    const posted = await postMessage({ db: t.db, authorId, body: 'spicy take' });
    const hidden = await moderateMessage({
      db: t.db,
      messageId: posted.id,
      moderatorId,
      status: 'hidden',
      note: 'off-topic',
    });
    expect(hidden.status).toBe('hidden');
    expect(hidden.body).toBe('spicy take'); // content preserved
    expect(hidden.moderatedBy).toBe(moderatorId);
    expect(hidden.moderationNote).toBe('off-topic');
    expect(hidden.moderatedAt).not.toBeNull();

    const deleted = await moderateMessage({ db: t.db, messageId: posted.id, moderatorId, status: 'deleted' });
    expect(deleted.status).toBe('deleted');
    expect(deleted.body).toBe('spicy take');

    const restored = await moderateMessage({ db: t.db, messageId: posted.id, moderatorId, status: 'visible' });
    expect(restored.status).toBe('visible');

    // The row is never physically removed by any status transition.
    const [still] = await t.db.select().from(messages).where(eq(messages.id, posted.id));
    expect(still).toBeDefined();
  });

  it('the AUTHOR cannot rewrite a hidden/deleted message (moderated content is the audit record)', async () => {
    const posted = await postMessage({ db: t.db, authorId, body: 'evidence' });
    await moderateMessage({ db: t.db, messageId: posted.id, moderatorId, status: 'hidden' });
    await expect(
      editMessage({ db: t.db, messageId: posted.id, editorId: authorId, body: 'nothing to see' }),
    ).rejects.toBeInstanceOf(MessageModeratedError);
    await moderateMessage({ db: t.db, messageId: posted.id, moderatorId, status: 'deleted' });
    await expect(
      editMessage({ db: t.db, messageId: posted.id, editorId: authorId, body: 'gone' }),
    ).rejects.toBeInstanceOf(MessageModeratedError);
    // Content survived both edit attempts…
    const [row] = await t.db.select().from(messages).where(eq(messages.id, posted.id));
    expect(row!.body).toBe('evidence');
    // …and a moderator restore makes it editable again.
    await moderateMessage({ db: t.db, messageId: posted.id, moderatorId, status: 'visible' });
    const edited = await editMessage({
      db: t.db,
      messageId: posted.id,
      editorId: authorId,
      body: 'clarified',
    });
    expect(edited.body).toBe('clarified');
  });

  it('moderating a non-existent message is NotFound', async () => {
    await expect(
      moderateMessage({
        db: t.db,
        messageId: '00000000-0000-0000-0000-000000000000',
        moderatorId,
        status: 'hidden',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
