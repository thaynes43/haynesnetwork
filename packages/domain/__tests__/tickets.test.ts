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
    expect(mine).toHaveLength(1);
    expect(mine[0]!.channel).toBe('pushover');
    expect(mine[0]!.payload).toMatchObject({
      ticketId: row.id,
      title: 'no sound on Outbox Movie',
      category: 'audio',
      authorName: 'Auth Or',
      mediaTitle: 'Outbox Movie',
    });
    expect(mine[0]!.sentAt).toBeNull(); // queued for the notify-outbox drainer
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
