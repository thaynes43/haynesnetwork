// ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034 Helpdesk) — the ticket single-writers: the FULL 4×4
// state-machine matrix, the append-only event history (creation-inclusive, notes carried), the
// reply thread's activity bump, and the ticket_created outbox SAME-TX proof (both directions:
// committed together, rolled back together). Embedded PG16.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  mediaItems,
  notificationOutbox,
  tickets,
  ticketEvents,
  TICKET_STATUSES,
  type TicketStatus,
} from '@hnet/db';
import {
  addTicketReply,
  canTransitionTicket,
  createCollectionOverrideTicket,
  createTicket,
  transitionTicket,
  upsertMediaItemsBatch,
  InvalidTicketTransitionError,
  NotFoundError,
  TICKET_TRANSITIONS,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
let author: Awaited<ReturnType<typeof createUser>>;
let staff: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  t = await bootMigratedDb();
  author = await createUser(t.db, { email: 'author@example.com', displayName: 'Auth Or' });
  staff = await createUser(t.db, { email: 'staff@example.com', displayName: 'Sta Ff' });
});

afterAll(async () => {
  await t?.stop();
});

const file = (title = 'a ticket') =>
  createTicket({ db: t.db, authorId: author.id, title, body: 'body', category: 'playback' });

/** Drive a fresh ticket into `state` via legal edges only. */
async function ticketIn(state: TicketStatus): Promise<string> {
  const row = await file(`fixture → ${state}`);
  if (state === 'open') return row.id;
  if (state === 'in_progress' || state === 'complete') {
    await transitionTicket({ db: t.db, ticketId: row.id, actorId: staff.id, toStatus: state });
    return row.id;
  }
  // rejected
  await transitionTicket({ db: t.db, ticketId: row.id, actorId: staff.id, toStatus: 'rejected' });
  return row.id;
}

describe('the state machine — the FULL matrix (ADR-050)', () => {
  // The normative matrix (requirement 5): open ⇄ in_progress, either closes to complete|rejected;
  // complete is TERMINAL; rejected re-opens to open ONLY. Self-transitions are always illegal.
  const EXPECTED: Record<TicketStatus, Record<TicketStatus, boolean>> = {
    open: { open: false, in_progress: true, complete: true, rejected: true },
    in_progress: { open: true, in_progress: false, complete: true, rejected: true },
    complete: { open: false, in_progress: false, complete: false, rejected: false },
    rejected: { open: true, in_progress: false, complete: false, rejected: false },
  };

  it('canTransitionTicket + TICKET_TRANSITIONS agree with the normative matrix, cell by cell', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        expect(canTransitionTicket(from, to), `${from} → ${to}`).toBe(EXPECTED[from][to]);
        expect(TICKET_TRANSITIONS[from].includes(to), `${from} → ${to}`).toBe(EXPECTED[from][to]);
      }
    }
  });

  it('transitionTicket ENFORCES every cell against the database (legal moves apply, illegal throw)', async () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        const id = await ticketIn(from);
        if (EXPECTED[from][to]) {
          const { ticket } = await transitionTicket({
            db: t.db,
            ticketId: id,
            actorId: staff.id,
            toStatus: to,
          });
          expect(ticket.status, `${from} → ${to}`).toBe(to);
        } else {
          await expect(
            transitionTicket({ db: t.db, ticketId: id, actorId: staff.id, toStatus: to }),
            `${from} → ${to}`,
          ).rejects.toBeInstanceOf(InvalidTicketTransitionError);
          // And the row is untouched — the guard fires BEFORE any write.
          const [row] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${id}`);
          expect(row!.status, `${from} → ${to}`).toBe(from);
        }
      }
    }
  });

  it('a transition on a missing ticket is NotFound', async () => {
    await expect(
      transitionTicket({
        db: t.db,
        ticketId: '00000000-0000-4000-8000-000000000000',
        actorId: staff.id,
        toStatus: 'in_progress',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the append-only event history (ADR-050 option F)', () => {
  it('creation writes the "Filed" event; every transition appends with actor + optional note', async () => {
    const row = await file('history ticket');
    await transitionTicket({
      db: t.db,
      ticketId: row.id,
      actorId: staff.id,
      toStatus: 'in_progress',
      note: 'on it',
    });
    await transitionTicket({
      db: t.db,
      ticketId: row.id,
      actorId: staff.id,
      toStatus: 'rejected',
      note: 'dupe of an existing ticket',
    });
    await transitionTicket({ db: t.db, ticketId: row.id, actorId: staff.id, toStatus: 'open' });

    const events = await t.db
      .select()
      .from(ticketEvents)
      .where(sql`${ticketEvents.ticketId} = ${row.id}`)
      .orderBy(ticketEvents.createdAt, ticketEvents.id);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, 'open'], // Filed (the creation event — actor is the author)
      ['open', 'in_progress'],
      ['in_progress', 'rejected'],
      ['rejected', 'open'], // the re-open
    ]);
    expect(events[0]!.actorUserId).toBe(author.id);
    expect(events[1]!.note).toBe('on it');
    expect(events[2]!.note).toBe('dupe of an existing ticket');
    expect(events[3]!.note).toBeNull(); // the note is OPTIONAL on every transition
    expect(events.slice(1).every((e) => e.actorUserId === staff.id)).toBe(true);
  });

  it('replies and transitions BUMP last_activity_at (the wall sort key) in the same tx', async () => {
    const row = await file('bump ticket');
    const before = row.lastActivityAt;
    const replyAt = new Date(before.getTime() + 60_000);
    await addTicketReply({
      db: t.db,
      ticketId: row.id,
      authorId: author.id,
      body: 'any news?',
      now: replyAt,
    });
    const [afterReply] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${row.id}`);
    expect(afterReply!.lastActivityAt.getTime()).toBe(replyAt.getTime());

    const transitionAt = new Date(before.getTime() + 120_000);
    await transitionTicket({
      db: t.db,
      ticketId: row.id,
      actorId: staff.id,
      toStatus: 'in_progress',
      now: transitionAt,
    });
    const [afterMove] = await t.db.select().from(tickets).where(sql`${tickets.id} = ${row.id}`);
    expect(afterMove!.lastActivityAt.getTime()).toBe(transitionAt.getTime());
  });

  it('a reply on a missing ticket is NotFound', async () => {
    await expect(
      addTicketReply({
        db: t.db,
        ticketId: '00000000-0000-4000-8000-000000000000',
        authorId: author.id,
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the ticket_created outbox — SAME-TX with the ticket insert (ADR-034 C-01, Q-04)', () => {
  it('createTicket commits the ticket + creation event + outbox row TOGETHER, payload carrying the ping facts', async () => {
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          title: 'Outbox Movie',
          arrItemId: 990001,
          tmdbId: 990001,
          tvdbId: null,
          musicbrainzArtistId: null,
          sortTitle: 'outbox movie',
          year: 2024,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          metadataProfileId: null,
          metadataProfileName: null,
          rootFolder: '/data/movies',
          arrTags: [],
          onDiskFileCount: 1,
          expectedFileCount: 1,
          sizeOnDisk: 1000,
          arrAttrs: {},
        },
      ],
    });
    const [movie] = await t.db
      .select()
      .from(mediaItems)
      .where(sql`${mediaItems.title} = 'Outbox Movie'`);
    const row = await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'no sound on Outbox Movie',
      body: 'silent from minute 3',
      category: 'audio',
      mediaItemId: movie!.id,
    });

    const outbox = await t.db
      .select()
      .from(notificationOutbox)
      .where(sql`${notificationOutbox.eventType} = 'ticket_created'`);
    const mine = outbox.filter(
      (o) => (o.payload as { ticketId?: string }).ticketId === row.id,
    );
    // ADR-060 / R-195 (PLAN-035) — creation enqueues TWO rows: the owner Pushover ping AND the
    // unconditional admin email (payload.to resolved at enqueue time).
    expect(mine).toHaveLength(2);
    const push = mine.find((o) => o.channel === 'pushover')!;
    const mail = mine.find((o) => o.channel === 'email')!;
    for (const o of [push, mail]) {
      expect(o.payload).toMatchObject({
        ticketId: row.id,
        title: 'no sound on Outbox Movie',
        category: 'audio',
        authorName: 'Auth Or',
        mediaTitle: 'Outbox Movie',
      });
      expect(o.sentAt).toBeNull(); // queued for the notify-outbox drainer
    }
    expect((push.payload as { to?: string }).to).toBeUndefined();
    expect((mail.payload as { to?: string }).to).toBe('admin@haynesnetwork.com');
  });

  it('when the outbox INSERT fails, the whole creation ROLLS BACK — no ticket without a ping', async () => {
    const countTickets = async () =>
      (await t.db.select({ n: sql<number>`count(*)::int` }).from(tickets))[0]!.n;
    const before = await countTickets();

    // Force the enqueue to fail AFTER the ticket insert by hiding the outbox table; the same-tx
    // invariant means the ticket + event inserts must roll back with it.
    await t.db.execute(sql`ALTER TABLE notification_outbox RENAME TO notification_outbox_hidden`);
    try {
      await expect(
        createTicket({
          db: t.db,
          authorId: author.id,
          title: 'phantom ticket',
          body: 'x',
          category: 'other',
        }),
      ).rejects.toThrow();
    } finally {
      await t.db.execute(sql`ALTER TABLE notification_outbox_hidden RENAME TO notification_outbox`);
    }
    expect(await countTickets()).toBe(before);
    const phantoms = await t.db
      .select()
      .from(tickets)
      .where(sql`${tickets.title} = 'phantom ticket'`);
    expect(phantoms).toHaveLength(0);
  });

  it('createTicket validates the linked media item exists (NotFound BEFORE any write)', async () => {
    await expect(
      createTicket({
        db: t.db,
        authorId: author.id,
        title: 'bad link',
        body: 'x',
        category: 'other',
        mediaItemId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// DESIGN-035 D-17 — the over-cap admin-override request is a thin single-writer wrapper over createTicket:
// it files a `collection_override` ticket carrying the structured facts, and — because it goes through the
// SAME createTicket writer — inherits the atomic creation event + `ticket_created` outbox ping (same tx,
// rolls back together). No new approval subsystem.
describe('createCollectionOverrideTicket (DESIGN-035 D-17)', () => {
  it('files a collection_override ticket authored by the requester, with the facts in the body', async () => {
    const row = await createCollectionOverrideTicket({
      db: t.db,
      authorId: author.id,
      provider: 'libretto',
      collectionName: 'IMDb Top 200',
      size: 200,
      cap: 25,
      adminEmail: 'admin@example.com',
    });
    expect(row.category).toBe('collection_override');
    expect(row.authorUserId).toBe(author.id);
    expect(row.status).toBe('open');
    expect(row.title).toBe('Collection override request: IMDb Top 200');
    expect(row.body).toContain('Provider: libretto');
    expect(row.body).toContain('Collection: IMDb Top 200');
    expect(row.body).toContain('200 items');
    expect(row.body).toContain('25 items');

    // The "Filed" creation event landed in the same tx — the single-writer audit trail.
    const events = await t.db
      .select()
      .from(ticketEvents)
      .where(sql`${ticketEvents.ticketId} = ${row.id}`);
    expect(events).toHaveLength(1);
    expect([events[0]!.fromStatus, events[0]!.toStatus]).toEqual([null, 'open']);
    expect(events[0]!.actorUserId).toBe(author.id);

    // And the ticket_created outbox pings (owner pushover + the admin email) committed WITH it.
    const outbox = (
      await t.db.select().from(notificationOutbox).where(sql`${notificationOutbox.eventType} = 'ticket_created'`)
    ).filter((o) => (o.payload as { ticketId?: string }).ticketId === row.id);
    expect(outbox).toHaveLength(2);
    const mail = outbox.find((o) => o.channel === 'email')!;
    expect((mail.payload as { to?: string }).to).toBe('admin@example.com');
    expect(mail.payload).toMatchObject({ title: 'Collection override request: IMDb Top 200', category: 'collection_override' });
    expect(outbox.every((o) => o.sentAt === null)).toBe(true);
  });

  it('inherits createTicket atomicity — a failed outbox INSERT rolls the whole request back (no orphan ticket)', async () => {
    const countTickets = async () =>
      (await t.db.select({ n: sql<number>`count(*)::int` }).from(tickets))[0]!.n;
    const before = await countTickets();
    await t.db.execute(sql`ALTER TABLE notification_outbox RENAME TO notification_outbox_hidden`);
    try {
      await expect(
        createCollectionOverrideTicket({
          db: t.db,
          authorId: author.id,
          provider: 'kometa',
          collectionName: 'phantom override',
          size: 99,
          cap: 25,
        }),
      ).rejects.toThrow();
    } finally {
      await t.db.execute(sql`ALTER TABLE notification_outbox_hidden RENAME TO notification_outbox`);
    }
    expect(await countTickets()).toBe(before);
    const phantoms = await t.db
      .select()
      .from(tickets)
      .where(sql`${tickets.title} = 'Collection override request: phantom override'`);
    expect(phantoms).toHaveLength(0);
  });
});

// ADR-060 / DESIGN-031 D-02 (PLAN-035) — the R-196 author opt-in email enqueues on replies and
// state transitions: OFF ⇒ no row; ON + someone ELSE acts ⇒ one email row to the author;
// ON + the author's own action ⇒ no row.
describe('ticket author opt-in emails (R-196)', () => {
  const emailRowsFor = async (ticketId: string) =>
    (await t.db.select().from(notificationOutbox).where(sql`${notificationOutbox.channel} = 'email'`)).filter(
      (o) => (o.payload as { ticketId?: string }).ticketId === ticketId,
    );

  it('enqueues NOTHING for reply/transition while the author has not opted in (default OFF)', async () => {
    const row = await file('opt-out ticket');
    await addTicketReply({ db: t.db, ticketId: row.id, authorId: staff.id, body: 'a staff reply' });
    await transitionTicket({ db: t.db, ticketId: row.id, actorId: staff.id, toStatus: 'in_progress' });
    expect((await emailRowsFor(row.id)).filter((o) => o.eventType !== 'ticket_created')).toHaveLength(0);
  });

  it('opted in: someone ELSE replying/transitioning enqueues the author email; own actions never do', async () => {
    const { setNotificationPreference } = await import('../src/index');
    await setNotificationPreference({ db: t.db, userId: author.id, emailTicketUpdates: true });
    try {
      const row = await file('opt-in ticket');

      // The author's OWN reply — no email.
      await addTicketReply({ db: t.db, ticketId: row.id, authorId: author.id, body: 'my own note' });
      expect((await emailRowsFor(row.id)).filter((o) => o.eventType === 'ticket_replied')).toHaveLength(0);

      // Staff replies — ONE ticket_replied email to the author.
      await addTicketReply({ db: t.db, ticketId: row.id, authorId: staff.id, body: 'we are on it — checking the transcode logs now' });
      const replied = (await emailRowsFor(row.id)).filter((o) => o.eventType === 'ticket_replied');
      expect(replied).toHaveLength(1);
      expect(replied[0]!.payload).toMatchObject({
        to: 'author@example.com',
        title: 'opt-in ticket',
        replyAuthorName: 'Sta Ff',
      });
      expect((replied[0]!.payload as { snippet?: string }).snippet).toContain('transcode logs');

      // Staff transitions — ONE ticket_status_changed email to the author, note carried.
      await transitionTicket({ db: t.db, ticketId: row.id, actorId: staff.id, toStatus: 'in_progress', note: 'repro confirmed' });
      const moved = (await emailRowsFor(row.id)).filter((o) => o.eventType === 'ticket_status_changed');
      expect(moved).toHaveLength(1);
      expect(moved[0]!.payload).toMatchObject({
        to: 'author@example.com',
        fromStatus: 'open',
        toStatus: 'in_progress',
        actorName: 'Sta Ff',
        note: 'repro confirmed',
      });
    } finally {
      await setNotificationPreference({ db: t.db, userId: author.id, emailTicketUpdates: false });
    }
  });
});

// ADR-061 / DESIGN-032 D-03 (PLAN-038) — the media LOCATOR: consistency matrix + persistence +
// the snapshotted label riding the notification payloads.
describe('ticket media locator (ADR-061)', () => {
  async function seedShow(): Promise<string> {
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          title: 'Locator Show',
          arrItemId: 880001,
          tmdbId: null,
          tvdbId: 880001,
          musicbrainzArtistId: null,
          sortTitle: 'locator show',
          year: 2024,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          metadataProfileId: null,
          metadataProfileName: null,
          rootFolder: '/data/tv',
          arrTags: [],
          onDiskFileCount: 10,
          expectedFileCount: 10,
          sizeOnDisk: 1000,
          arrAttrs: {},
        },
      ],
    });
    const [show] = await t.db
      .select()
      .from(mediaItems)
      .where(sql`${mediaItems.title} = 'Locator Show'`);
    return show!.id;
  }

  it('persists an episode locator + the label rides both ticket_created payloads', async () => {
    const showId = await seedShow();
    const row = await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'no audio on the finale',
      body: 'x',
      category: 'audio',
      mediaItemId: showId,
      target: { kind: 'episode', childId: 42, season: 6, episode: 2, label: 'S06E02 · Rich' },
    });
    expect(row.targetKind).toBe('episode');
    expect(row.targetChildId).toBe(42);
    expect(row.targetSeason).toBe(6);
    expect(row.targetEpisode).toBe(2);
    expect(row.targetLabel).toBe('S06E02 · Rich');

    const outbox = await t.db
      .select()
      .from(notificationOutbox)
      .where(sql`${notificationOutbox.eventType} = 'ticket_created'`);
    const mine = outbox.filter((o) => (o.payload as { ticketId?: string }).ticketId === row.id);
    expect(mine).toHaveLength(2);
    for (const o of mine)
      expect((o.payload as { targetLabel?: string }).targetLabel).toBe('S06E02 · Rich');
  });

  it('a season scope needs no child id; whole-title tickets stay locator-free', async () => {
    const showId = await seedShow();
    const season = await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'season 3 all stutters',
      body: 'x',
      category: 'playback',
      mediaItemId: showId,
      target: { kind: 'season', season: 3, label: 'Season 3' },
    });
    expect(season.targetKind).toBe('season');
    expect(season.targetChildId).toBeNull();

    const whole = await createTicket({
      db: t.db,
      authorId: author.id,
      title: 'whole show missing',
      body: 'x',
      category: 'missing',
      mediaItemId: showId,
    });
    expect(whole.targetKind).toBeNull();
    expect(whole.targetLabel).toBeNull();
  });

  it('rejects inconsistent locators BEFORE any write', async () => {
    const showId = await seedShow();
    const { InvalidTicketTargetError } = await import('../src/errors');
    const cases: Array<Parameters<typeof createTicket>[0]> = [
      // album/track on a sonarr item
      { db: t.db, authorId: author.id, title: 'x', body: 'x', category: 'audio', mediaItemId: showId, target: { kind: 'album', childId: 1, label: 'A' } },
      // target without a media link
      { db: t.db, authorId: author.id, title: 'x', body: 'x', category: 'audio', target: { kind: 'episode', childId: 1, season: 1, episode: 1, label: 'E' } },
      // season without its number
      { db: t.db, authorId: author.id, title: 'x', body: 'x', category: 'audio', mediaItemId: showId, target: { kind: 'season', label: 'Season ?' } },
      // episode without its child id
      { db: t.db, authorId: author.id, title: 'x', body: 'x', category: 'audio', mediaItemId: showId, target: { kind: 'episode', season: 1, episode: 1, label: 'E' } },
    ];
    const before = (await t.db.select().from(tickets)).length;
    for (const input of cases) {
      await expect(createTicket(input), JSON.stringify(input.target)).rejects.toBeInstanceOf(
        InvalidTicketTargetError,
      );
    }
    expect((await t.db.select().from(tickets)).length).toBe(before);
  });
});
