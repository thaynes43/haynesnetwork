// ADR-026 / DESIGN-012 — the communication router: Feed (keyset + filters + attribution join) and
// Messages (post/edit/moderate action gating, moderator-only hidden visibility). Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { moderateMessage, postMessage, recordNotification } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  type TestDb,
} from './helpers';

async function forbidden(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>);
}

describe('communication.feed (ADR-026 D-05)', () => {
  let t: TestDb;
  let memberRow: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberRow = await createUser(t.db, { email: 'member@example.com' });
    await createUser(t.db, { email: 'req@example.com', displayName: 'Reqi Requester' });
    await seedMediaItem(t.db, 'radarr', { title: 'Linked Movie', tmdbId: 603 });

    // A seerr event that attributes to the requester + links the movie by tmdbId.
    await recordNotification({
      db: t.db,
      source: 'seerr',
      type: 'MEDIA_APPROVED',
      title: 'Linked Movie',
      body: 'approved',
      sourceEventId: 'MEDIA_APPROVED:1',
      tmdbId: 603,
      mediaType: 'movie',
      requesterEmail: 'req@example.com',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
    });
    // Five tautulli events with increasing occurredAt for the keyset walk (no media, unattributed).
    for (let i = 0; i < 5; i++) {
      await recordNotification({
        db: t.db,
        source: 'tautulli',
        type: 'playback.start',
        title: `play ${i}`,
        body: '',
        sourceEventId: `play:${i}`,
        occurredAt: new Date(`2026-07-02T00:0${i}:00Z`),
      });
    }
  });

  afterAll(async () => {
    await t?.stop();
  });

  const memberApi = () => caller(makeCtx(t.db, sessionUser(memberRow)));

  it('is readable by a member (bulletin defaults read_only) and joins attribution + media', async () => {
    const res = await memberApi().communication.feed({ source: 'seerr' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      source: 'seerr',
      eventType: 'MEDIA_APPROVED',
      mediaTitle: 'Linked Movie',
      attributedUserName: 'Reqi Requester',
    });
    expect(res.items[0]!.mediaItemId).not.toBeNull();
  });

  it('is FORBIDDEN when the caller’s bulletin section is disabled', async () => {
    const disabled = caller(makeCtx(t.db, sessionUser(memberRow, { bulletin: 'disabled' })));
    await forbidden(() => disabled.communication.feed({}));
  });

  it('filters by hasMedia', async () => {
    const withMedia = await memberApi().communication.feed({ hasMedia: true });
    expect(withMedia.items.every((i) => i.mediaItemId !== null)).toBe(true);
    const withoutMedia = await memberApi().communication.feed({ hasMedia: false });
    expect(withoutMedia.items.every((i) => i.mediaItemId === null)).toBe(true);
  });

  it('keyset-paginates newest-first with stable, non-overlapping pages', async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let guard = 0;
    do {
      const page = await memberApi().communication.feed({ source: 'tautulli', limit: 2, cursor: cursor ?? undefined });
      for (const it of page.items) seen.push(it.id);
      cursor = page.nextCursor;
    } while (cursor && ++guard < 10);
    // All five tautulli rows, each exactly once, newest occurredAt first.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const titles = (await memberApi().communication.feed({ source: 'tautulli', limit: 50 })).items.map(
      (i) => i.title,
    );
    expect(titles).toEqual(['play 4', 'play 3', 'play 2', 'play 1', 'play 0']);
  });
});

describe('communication.messages — action gating + moderation (ADR-026 D-06)', () => {
  let t: TestDb;
  let author: Awaited<ReturnType<typeof createUser>>;
  let other: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    author = await createUser(t.db, { email: 'author@example.com', displayName: 'Auth Or' });
    other = await createUser(t.db, { email: 'other@example.com', displayName: 'Oth Er' });
  });

  afterAll(async () => {
    await t?.stop();
  });

  // Callers with each grant shape (bulletin read_only default; message actions overridden).
  const reader = () => caller(makeCtx(t.db, sessionUser(author)));
  const poster = () => caller(makeCtx(t.db, sessionUser(author, undefined, undefined, ['post'])));
  const posterOther = () => caller(makeCtx(t.db, sessionUser(other, undefined, undefined, ['post'])));
  const moderator = () => caller(makeCtx(t.db, sessionUser(other, undefined, undefined, ['moderate'])));

  it('a reader (no post grant) is FORBIDDEN from posting', async () => {
    await forbidden(() => reader().communication.messages.post({ body: 'nope' }));
  });

  it('a poster can post + edit their OWN message but not another’s', async () => {
    const posted = await poster().communication.messages.post({ subject: 'hi', body: 'first' });
    expect(posted.id).toBeTruthy();
    const edited = await poster().communication.messages.edit({ messageId: posted.id, body: 'edited' });
    expect(edited.editedAt).not.toBeNull();
    // Another poster editing it → domain MessageNotOwned → FORBIDDEN.
    await forbidden(() =>
      posterOther().communication.messages.edit({ messageId: posted.id, body: 'hijack' }),
    );
  });

  it('a poster (no moderate grant) is FORBIDDEN from moderating', async () => {
    const posted = await poster().communication.messages.post({ body: 'to moderate' });
    await forbidden(() =>
      poster().communication.messages.moderate({ messageId: posted.id, status: 'hidden' }),
    );
  });

  it('hidden/deleted messages are invisible to members but visible to moderators', async () => {
    const posted = await poster().communication.messages.post({ body: 'controversial' });
    await moderator().communication.messages.moderate({
      messageId: posted.id,
      status: 'hidden',
      note: 'off-topic',
    });
    const memberList = await reader().communication.messages.list({});
    expect(memberList.items.find((m) => m.id === posted.id)).toBeUndefined();

    const modList = await moderator().communication.messages.list({ status: 'hidden' });
    const seen = modList.items.find((m) => m.id === posted.id);
    expect(seen).toBeDefined();
    expect(seen!.body).toBe('controversial'); // content preserved
    expect(seen!.moderationNote).toBe('off-topic'); // moderation trail exposed to moderators
  });

  it('the moderation trail is NOT leaked to non-moderators', async () => {
    // Seed a visible message that was previously moderated (visible again) via the domain writer.
    const posted = await postMessage({ db: t.db, authorId: author.id, body: 'restored later' });
    await moderateMessage({ db: t.db, messageId: posted.id, moderatorId: other.id, status: 'visible', note: 'ok' });
    const memberList = await reader().communication.messages.list({});
    const seen = memberList.items.find((m) => m.id === posted.id);
    expect(seen).toBeDefined();
    expect(seen!.moderatedBy).toBeNull();
    expect(seen!.moderationNote).toBeNull();
  });

  it('list + post are FORBIDDEN when bulletin is disabled', async () => {
    const disabled = caller(
      makeCtx(t.db, sessionUser(author, { bulletin: 'disabled' }, undefined, ['post', 'moderate'])),
    );
    await forbidden(() => disabled.communication.messages.list({}));
    await forbidden(() => disabled.communication.messages.post({ body: 'x' }));
  });
});
