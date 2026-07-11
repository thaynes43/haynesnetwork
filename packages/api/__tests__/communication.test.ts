// ADR-026 / ADR-050 / DESIGN-012 — the communication router: Feed (keyset + filters + attribution
// join) and the Helpdesk tickets surface (create/reply/transition gating — the PLAN-034 permission
// matrix: create = post, transitions = moderate ONLY, replies = any messages-view holder; household
// visibility). Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  createFixRequest,
  createTicket,
  recordFixAction,
  recordNotification,
} from '@hnet/domain';
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

  it('ADR-049: a role narrowed to messages-only is FORBIDDEN from the feed but can browse tickets', async () => {
    // Bulletin ENABLED (read_only) + a messages-ONLY sub-view grant (the owner's Default-role
    // shape): the feed endpoint FORBIDs — server-side, not a UI hide — while the Helpdesk (which
    // rides the `messages` view since PLAN-034) stays open.
    const messagesOnly = caller(
      makeCtx(
        t.db,
        sessionUser(memberRow, undefined, undefined, undefined, undefined, undefined, ['messages']),
      ),
    );
    await forbidden(() => messagesOnly.communication.feed({}));
    await expect(messagesOnly.communication.tickets.list({})).resolves.toMatchObject({
      items: expect.any(Array),
    });

    // The mirror: a feed-only role can read the feed but is FORBIDDEN from the Helpdesk.
    const feedOnly = caller(
      makeCtx(
        t.db,
        sessionUser(memberRow, undefined, undefined, undefined, undefined, undefined, ['feed']),
      ),
    );
    await expect(feedOnly.communication.feed({})).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await forbidden(() => feedOnly.communication.tickets.list({}));
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
      const page = await memberApi().communication.feed({
        source: 'tautulli',
        limit: 2,
        cursor: cursor ?? undefined,
      });
      for (const it of page.items) seen.push(it.id);
      cursor = page.nextCursor;
    } while (cursor && ++guard < 10);
    // All five tautulli rows, each exactly once, newest occurredAt first.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const titles = (
      await memberApi().communication.feed({ source: 'tautulli', limit: 50 })
    ).items.map((i) => i.title);
    expect(titles).toEqual(['play 4', 'play 3', 'play 2', 'play 1', 'play 0']);
  });
});

describe('communication.tickets — the PLAN-034 permission matrix (ADR-050 option H)', () => {
  let t: TestDb;
  let member: Awaited<ReturnType<typeof createUser>>;
  let staff: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    member = await createUser(t.db, { email: 'member@example.com', displayName: 'Mem Ber' });
    staff = await createUser(t.db, { email: 'staff@example.com', displayName: 'Sta Ff' });
  });

  afterAll(async () => {
    await t?.stop();
  });

  // Callers with each grant shape (bulletin read_only default; message actions overridden).
  const reader = () => caller(makeCtx(t.db, sessionUser(member)));
  const poster = () => caller(makeCtx(t.db, sessionUser(member, undefined, undefined, ['post'])));
  const moderator = () =>
    caller(makeCtx(t.db, sessionUser(staff, undefined, undefined, ['moderate'])));

  it('a reader (no post grant) is FORBIDDEN from creating a ticket', async () => {
    await forbidden(() =>
      reader().communication.tickets.create({ title: 'nope', body: 'x', category: 'other' }),
    );
  });

  it('a moderator WITHOUT the post grant is FORBIDDEN from creating (create ≠ triage)', async () => {
    await forbidden(() =>
      moderator().communication.tickets.create({ title: 'nope', body: 'x', category: 'other' }),
    );
  });

  it('NON-STAFF are FORBIDDEN from EVERY transition — even the ticket’s own author', async () => {
    const created = await poster().communication.tickets.create({
      title: 'my own ticket',
      body: 'it broke',
      category: 'playback',
    });
    for (const toStatus of ['in_progress', 'complete', 'rejected'] as const) {
      // The author with only `post`:
      await forbidden(() =>
        poster().communication.tickets.transition({ ticketId: created.id, toStatus }),
      );
      // A plain reader:
      await forbidden(() =>
        reader().communication.tickets.transition({ ticketId: created.id, toStatus }),
      );
    }
  });

  it('ANY member with the messages view may reply — no post/moderate grant needed (Q-02)', async () => {
    const created = await poster().communication.tickets.create({
      title: 'reply target',
      body: 'details',
      category: 'audio',
    });
    const reply = await reader().communication.tickets.reply({
      ticketId: created.id,
      body: 'same here on the living-room TV',
    });
    expect(reply.id).toBeTruthy();
    // But a feed-only role (no messages view) cannot reply — or browse at all.
    const feedOnly = caller(
      makeCtx(
        t.db,
        sessionUser(member, undefined, undefined, undefined, undefined, undefined, ['feed']),
      ),
    );
    await forbidden(() =>
      feedOnly.communication.tickets.reply({ ticketId: created.id, body: 'nope' }),
    );
    await forbidden(() => feedOnly.communication.tickets.detail({ ticketId: created.id }));
  });

  it('staff transitions work with an optional note; an ILLEGAL edge is a CONFLICT', async () => {
    const created = await poster().communication.tickets.create({
      title: 'transition target',
      body: 'x',
      category: 'subtitles',
    });
    const started = await moderator().communication.tickets.transition({
      ticketId: created.id,
      toStatus: 'in_progress',
      note: 'looking into it',
    });
    expect(started.status).toBe('in_progress');
    const done = await moderator().communication.tickets.transition({
      ticketId: created.id,
      toStatus: 'complete',
      note: 'regrabbed a clean copy',
    });
    expect(done.status).toBe('complete');
    // complete is TERMINAL — any further move is a CONFLICT (TICKET_INVALID_TRANSITION).
    await expect(
      moderator().communication.tickets.transition({ ticketId: created.id, toStatus: 'open' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>);
  });

  it('rejected is RE-OPENABLE by staff (the hide/restore analog)', async () => {
    const created = await poster().communication.tickets.create({
      title: 'reopen target',
      body: 'x',
      category: 'other',
    });
    await moderator().communication.tickets.transition({
      ticketId: created.id,
      toStatus: 'rejected',
      note: 'site bug — belongs on GitHub',
    });
    const reopened = await moderator().communication.tickets.transition({
      ticketId: created.id,
      toStatus: 'open',
      note: 'actually a media issue after all',
    });
    expect(reopened.status).toBe('open');
  });

  it('detail carries the FULL timeline (creation + transitions with notes) + the reply thread — household-visible', async () => {
    const created = await poster().communication.tickets.create({
      title: 'timeline target',
      body: 'the audio drops out',
      category: 'audio',
    });
    await reader().communication.tickets.reply({ ticketId: created.id, body: 'which episode?' });
    await moderator().communication.tickets.transition({
      ticketId: created.id,
      toStatus: 'in_progress',
      note: 'checking the file',
    });

    // A plain reader (no grants at all) sees everything: household visibility (Q-01).
    const detail = await reader().communication.tickets.detail({ ticketId: created.id });
    expect(detail.found).toBe(true);
    if (!detail.found) throw new Error('unreachable');
    expect(detail.ticket.status).toBe('in_progress');
    expect(detail.events).toHaveLength(2);
    expect(detail.events[0]).toMatchObject({ fromStatus: null, toStatus: 'open' }); // "Filed"
    expect(detail.events[1]).toMatchObject({
      fromStatus: 'open',
      toStatus: 'in_progress',
      note: 'checking the file',
      actorName: 'Sta Ff',
    });
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0]).toMatchObject({ body: 'which episode?', authorName: 'Mem Ber' });
  });

  it('detail on an unknown id is found:false (never a throw)', async () => {
    const res = await reader().communication.tickets.detail({
      ticketId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res).toEqual({ found: false });
  });

  it('list filters by a state SET, counts tally per state, and a reply BUMPS the wall order', async () => {
    const a = await poster().communication.tickets.create({
      title: 'bump A',
      body: 'x',
      category: 'quality',
    });
    await poster().communication.tickets.create({ title: 'bump B', body: 'x', category: 'missing' });
    // B is newer, so it leads… until A gets a reply (last_activity_at is the wall's sort key).
    await reader().communication.tickets.reply({ ticketId: a.id, body: 'bump' });
    // HP-01 — a single-element state SET narrows to just that state (the multi-select chips send
    // the caller-authoritative visible set).
    const open = await reader().communication.tickets.list({ statuses: ['open'], limit: 10 });
    expect(open.items.every((x) => x.status === 'open')).toBe(true);
    const posA = open.items.findIndex((x) => x.title === 'bump A');
    const posB = open.items.findIndex((x) => x.title === 'bump B');
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThanOrEqual(0);
    expect(posA).toBeLessThan(posB);
    expect(open.items[posA]!.replyCount).toBe(1);

    const counts = await reader().communication.tickets.counts();
    expect(counts.open).toBeGreaterThanOrEqual(2);
    expect(counts.complete).toBeGreaterThanOrEqual(1); // from the transition test above
    expect(counts.open + counts.in_progress + counts.complete + counts.rejected).toBeGreaterThan(0);
  });

  it('list takes a MULTI-state SET (union), an EXPLICIT empty set = nothing, absent = every state (HP-01)', async () => {
    // A committed mix so open, in_progress, complete, and rejected are all represented.
    const inProg = await poster().communication.tickets.create({
      title: 'set in-progress',
      body: 'x',
      category: 'playback',
    });
    await moderator().communication.tickets.transition({
      ticketId: inProg.id,
      toStatus: 'in_progress',
    });

    // The DEFAULT wall selection {open, in_progress}: every returned row is one of the two, and a
    // Complete ticket (from the transition test above) is NOT present.
    const actionable = await reader().communication.tickets.list({
      statuses: ['open', 'in_progress'],
      limit: 200,
    });
    expect(actionable.items.length).toBeGreaterThan(0);
    expect(actionable.items.every((x) => x.status === 'open' || x.status === 'in_progress')).toBe(
      true,
    );
    expect(actionable.items.some((x) => x.status === 'complete')).toBe(false);
    expect(actionable.items.some((x) => x.id === inProg.id)).toBe(true);

    // An EXPLICIT empty set (every chip toggled off) returns nothing — never "all".
    const none = await reader().communication.tickets.list({ statuses: [], limit: 200 });
    expect(none.items).toHaveLength(0);
    expect(none.nextCursor).toBeNull();

    // Absent ⇒ no state filter (all states visible).
    const all = await reader().communication.tickets.list({ limit: 200 });
    expect(all.items.length).toBeGreaterThan(actionable.items.length);
    expect(all.items.some((x) => x.status === 'complete')).toBe(true);

    // The enum array is VALIDATED — an unknown state is rejected before the query runs.
    await expect(
      // @ts-expect-error — 'bogus' is not a TICKET_STATUS; the zod enum array must reject it.
      reader().communication.tickets.list({ statuses: ['bogus'], limit: 10 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>);
  });

  it('list + create are FORBIDDEN when bulletin is disabled', async () => {
    const disabled = caller(
      makeCtx(t.db, sessionUser(member, { bulletin: 'disabled' }, undefined, ['post', 'moderate'])),
    );
    await forbidden(() => disabled.communication.tickets.list({}));
    await forbidden(() =>
      disabled.communication.tickets.create({ title: 'x', body: 'x', category: 'other' }),
    );
  });
});

describe('communication.tickets — linked-media facts + repair-status hint (ADR-050 D-12)', () => {
  let t: TestDb;
  let author: Awaited<ReturnType<typeof createUser>>;
  let requester: Awaited<ReturnType<typeof createUser>>;
  let itemOpen: Awaited<ReturnType<typeof seedMediaItem>>;
  let itemPast: Awaited<ReturnType<typeof seedMediaItem>>;

  beforeAll(async () => {
    t = await bootMigratedDb();
    author = await createUser(t.db, { email: 'tauthor@example.com', displayName: 'Tick Author' });
    requester = await createUser(t.db, { email: 'fixer@example.com', displayName: 'Fix Er' });
    itemOpen = await seedMediaItem(t.db, 'radarr', {
      title: 'Open Fix Movie',
      tmdbId: 7001,
      year: 2021,
    });
    itemPast = await seedMediaItem(t.db, 'radarr', {
      title: 'Past Fix Movie',
      tmdbId: 7002,
      year: 2019,
    });

    // itemOpen — one OPEN (pending) fix ⇒ openFix true, fixCount 1.
    await createFixRequest({
      db: t.db,
      requesterId: requester.id,
      requesterIsAdmin: true,
      mediaItemId: itemOpen.id,
      reason: 'wont_play_corrupt',
    });
    // itemPast — two TERMINAL (failed) fixes ⇒ openFix false, fixCount 2.
    for (let i = 0; i < 2; i++) {
      const f = await createFixRequest({
        db: t.db,
        requesterId: requester.id,
        requesterIsAdmin: true,
        mediaItemId: itemPast.id,
        reason: 'wont_play_corrupt',
      });
      await recordFixAction({
        db: t.db,
        fixRequestId: f.fixRequestId,
        transition: 'failed',
        actions: [{ step: 'test_failed', at: new Date().toISOString() }],
      });
    }

    await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'open fix here',
      body: 'b',
      category: 'playback',
      mediaItemId: itemOpen.id,
    });
    await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'past fixes here',
      body: 'b',
      category: 'playback',
      mediaItemId: itemPast.id,
    });
    await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'no link here',
      body: 'b',
      category: 'other',
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const reader = () => caller(makeCtx(t.db, sessionUser(author)));

  it('list carries the linked-media tile facts; unlinked tickets carry nulls', async () => {
    const res = await reader().communication.tickets.list({ limit: 50 });
    const byTitle = (title: string) => {
      const row = res.items.find((x) => x.title === title);
      if (!row) throw new Error(`ticket not found: ${title}`);
      return row;
    };
    const linked = byTitle('open fix here');
    expect(linked.mediaItemId).toBe(itemOpen.id);
    expect(linked.mediaTitle).toBe('Open Fix Movie');
    expect(linked.mediaYear).toBe(2021);
    expect(linked.authorName).toBe('Tick Author');
    const unlinked = byTitle('no link here');
    expect(unlinked.mediaItemId).toBeNull();
    expect(unlinked.mediaYear).toBeNull();
    expect(unlinked.mediaPosterUrl).toBeNull();
  });

  it('detail computes the repair hint for the linked title (open / past / none)', async () => {
    const list = await reader().communication.tickets.list({ limit: 50 });
    const idOf = (title: string) => list.items.find((x) => x.title === title)!.id;

    const open = await reader().communication.tickets.detail({ ticketId: idOf('open fix here') });
    if (!open.found) throw new Error('missing');
    expect(open.ticket.openFix).toBe(true);
    expect(open.ticket.fixCount).toBe(1);

    const past = await reader().communication.tickets.detail({ ticketId: idOf('past fixes here') });
    if (!past.found) throw new Error('missing');
    expect(past.ticket.openFix).toBe(false);
    expect(past.ticket.fixCount).toBe(2);

    const none = await reader().communication.tickets.detail({ ticketId: idOf('no link here') });
    if (!none.found) throw new Error('missing');
    expect(none.ticket.openFix).toBe(false);
    expect(none.ticket.fixCount).toBe(0);
    expect(none.ticket.mediaPosterUrl).toBeNull();
  });
});
