// ADR-101 / DESIGN-028 amendment 2026-10-06 (issue #741) — the REQUEST EVENT. The ONLY domain module that writes
// `book_requests`: every writer (book-requests.ts, ll-gone.ts, format-pairing.ts, wrong-volume-repair.ts,
// collection-force-search.ts, collection-want-downloaded.ts) mints, changes and deletes rows through the four
// functions below, and each one inserts a `book_request_events` row per row it changed IN THE SAME TRANSACTION
// (CLAUDE.md hard rule 6, the packages/domain single-writer pattern). `__tests__/book-request-write-paths.test.ts`
// fails the build when any other file issues a book_requests write.
//
//   updateBookRequests — locks the rows `where` matches, updates them, and records one `update` event per row whose
//                        recorded fields changed (a write that changes nothing recorded writes no event).
//   insertBookRequest  — the mint; one `mint` event with every recorded field in `after`.
//   deleteBookRequests — one `delete` event per deleted row with every recorded field in `before`.
//   recordCascadedRequestDeletes — `delete` events for the wants a parent delete is about to cascade away.
//   stampBookRequests  — the bookkeeping stamps only (`last_searched_at`, …); no event, by design.
//
// And the one read of the record (issue #792, DESIGN-028 amendment 2026-10-07): `listRequestEvents`, one want's
// history newest first, for the admin-only History on the Wanted detail. It never writes.
//
// Who and where: each call names its `writer` and `reason`; `site` (the job and leg) and `actor` come from the call,
// else from the ambient scope a job or script opens with `withRequestEventScope` (the sync orchestrator opens one per
// mode, a repair script opens `actor: 'repair'`), else `actor` is `sync` and `site` NULL.
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  bookRequestEvents,
  bookRequests,
  booksCollections,
  booksItems,
  users,
  type BookRequestEventActor,
  type BookRequestEventInsert,
  type BookRequestEventKind,
  type BookRequestEventReason,
  type BookRequestInsert,
  type BookRequestRow,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { resolveDb } from './db-client';

// ---------------------------------------------------------------------------
// What an event records.
// ---------------------------------------------------------------------------

/**
 * The book_requests fields a Request Event records: the want's identity (so a deleted want can be rebuilt) and its
 * state (what it points at, each format's status, its park, the re-request). The bookkeeping stamps are left out on
 * purpose — `last_searched_at`, `last_reconciled_at`, `english_edition_tried_at`, the Mint Backoff columns,
 * `created_at`, `updated_at` — they record when the app last looked, not a decision about the want, and most runs
 * rewrite them.
 */
export const REQUEST_EVENT_FIELDS = [
  'origin',
  'integrationId',
  'shelfItemId',
  'pairingBooksItemId',
  'collectionId',
  'collectionMemberRef',
  'title',
  'author',
  'matchedBooksItemId',
  'llBookId',
  'ebookStatus',
  'audioStatus',
  'comicStatus',
  'kapowarrVolumeId',
  'comicvineId',
  'unroutableReason',
  'llRerequestedAt',
  'llRerequestFailures',
  'llRerequestFailedAt',
  'llRerequestAddedAt',
  'wrongAuthorLlBookId',
] as const satisfies ReadonlyArray<keyof BookRequestRow>;

type RecordedField = (typeof REQUEST_EVENT_FIELDS)[number];

/** The stamps `stampBookRequests` may write (nothing a Request Event records). */
const STAMP_FIELDS = [
  'lastSearchedAt',
  'lastReconciledAt',
  'englishEditionTriedAt',
  'updatedAt',
] as const;
export type BookRequestStamp = Partial<Pick<BookRequestRow, (typeof STAMP_FIELDS)[number]>>;

const COLUMNS = getTableColumns(bookRequests);
/** The column name an event keys a field by (`ll_book_id`, not `llBookId`), so SQL reads it as the table does. */
const columnName = (field: RecordedField): string => COLUMNS[field].name;

const jsonValue = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : (v ?? null));

/** Every recorded field of `row`, keyed by column name. */
export function requestEventSnapshot(row: BookRequestRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of REQUEST_EVENT_FIELDS) out[columnName(f)] = jsonValue(row[f]);
  return out;
}

/** The recorded fields that differ between two versions of a row: their values before and after. Empty = no change. */
export function requestEventDiff(
  before: BookRequestRow,
  after: BookRequestRow,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of REQUEST_EVENT_FIELDS) {
    const from = jsonValue(before[f]);
    const to = jsonValue(after[f]);
    if (from === to) continue;
    b[columnName(f)] = from;
    a[columnName(f)] = to;
  }
  return Object.keys(a).length === 0 ? null : { before: b, after: a };
}

// ---------------------------------------------------------------------------
// Who and where.
// ---------------------------------------------------------------------------

/** The ambient context a job or script opens: who is writing, and in which job. */
export interface RequestEventScope {
  actor?: BookRequestEventActor;
  /** The job (`goodreads-sync`, `wrong-volume-requests-repair`); a call's own `site` names the leg and wins. */
  site?: string | null;
  actorUserId?: string | null;
}

const scopeStore = new AsyncLocalStorage<RequestEventScope>();

/** Run `fn` with a Request Event scope; a nested scope inherits what it does not set. */
export function withRequestEventScope<T>(
  scope: RequestEventScope,
  fn: () => Promise<T>,
): Promise<T> {
  return scopeStore.run({ ...scopeStore.getStore(), ...scope }, fn);
}

/** What one write records about itself. */
export interface RequestWriteAudit {
  /** The single writer making the write (its function name). */
  writer: string;
  /** The decision that made it. */
  reason: BookRequestEventReason;
  /** The job and leg (`goodreads-sync.reconcile`). Defaults to the scope's. */
  site?: string | null;
  /** Defaults to the scope's, else `sync`. */
  actor?: BookRequestEventActor;
  /** The person, for `actor = 'user'`. Defaults to the scope's. */
  actorUserId?: string | null;
  /** The writer's own context for the decision. */
  detail?: Record<string, unknown> | null;
}

function eventBase(
  audit: RequestWriteAudit,
): Omit<BookRequestEventInsert, 'requestId' | 'kind' | 'before' | 'after'> {
  const scope = scopeStore.getStore() ?? {};
  return {
    reason: audit.reason,
    writer: audit.writer,
    site: audit.site ?? scope.site ?? null,
    actor: audit.actor ?? scope.actor ?? 'sync',
    actorUserId: audit.actorUserId ?? scope.actorUserId ?? null,
    detail: audit.detail ?? null,
  };
}

const EVENT_INSERT_CHUNK = 500;

async function insertEvents(tx: Transaction, events: BookRequestEventInsert[]): Promise<void> {
  for (let i = 0; i < events.length; i += EVENT_INSERT_CHUNK) {
    await tx.insert(bookRequestEvents).values(events.slice(i, i + EVENT_INSERT_CHUNK));
  }
}

function eventsFor(
  audit: RequestWriteAudit,
  kind: BookRequestEventKind,
  rows: ReadonlyArray<{
    requestId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }>,
): BookRequestEventInsert[] {
  const base = eventBase(audit);
  return rows.map((r) => ({
    ...base,
    requestId: r.requestId,
    kind,
    before: r.before,
    after: r.after,
  }));
}

// ---------------------------------------------------------------------------
// The writes.
// ---------------------------------------------------------------------------

/**
 * UPDATE the book_requests rows `where` matches and record one `update` event per row whose recorded fields changed.
 * The rows are locked (`FOR UPDATE`) and read first, so `before` is exactly what the update replaced; the update runs
 * against the locked ids under the same `where`. Returns the updated rows (empty when nothing matched: no UPDATE is
 * issued, which is what an UPDATE matching nothing would have done).
 */
export async function updateBookRequests(
  tx: Transaction,
  audit: RequestWriteAudit,
  where: SQL,
  set: PgUpdateSetSource<typeof bookRequests>,
): Promise<BookRequestRow[]> {
  const before = await tx.select().from(bookRequests).where(where).for('update');
  if (before.length === 0) return [];
  const after = await tx
    .update(bookRequests)
    .set(set)
    .where(
      and(
        inArray(
          bookRequests.id,
          before.map((r) => r.id),
        ),
        where,
      ),
    )
    .returning();
  const priorById = new Map(before.map((r) => [r.id, r]));
  const changed: Array<{
    requestId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }> = [];
  for (const row of after) {
    const prior = priorById.get(row.id);
    if (!prior) continue;
    const diff = requestEventDiff(prior, row);
    if (diff) changed.push({ requestId: row.id, ...diff });
  }
  if (changed.length > 0) await insertEvents(tx, eventsFor(audit, 'update', changed));
  return after;
}

/**
 * INSERT one book_requests row (the mint) and record its `mint` event. With `onConflictDoNothing` (the pairing want's
 * race guard) a conflict inserts nothing, records nothing and returns null.
 */
export async function insertBookRequest(
  tx: Transaction,
  audit: RequestWriteAudit,
  values: BookRequestInsert,
  opts: { onConflictDoNothing?: { target: PgColumn | PgColumn[]; where?: SQL } } = {},
): Promise<BookRequestRow | null> {
  const insert = tx.insert(bookRequests).values(values);
  const [row] = opts.onConflictDoNothing
    ? await insert.onConflictDoNothing(opts.onConflictDoNothing).returning()
    : await insert.returning();
  if (!row) return null;
  await insertEvents(
    tx,
    eventsFor(audit, 'mint', [{ requestId: row.id, before: {}, after: requestEventSnapshot(row) }]),
  );
  return row;
}

/** DELETE the book_requests rows `where` matches and record one `delete` event per row. Returns the deleted rows. */
export async function deleteBookRequests(
  tx: Transaction,
  audit: RequestWriteAudit,
  where: SQL,
): Promise<BookRequestRow[]> {
  const deleted = await tx.delete(bookRequests).where(where).returning();
  if (deleted.length > 0) {
    await insertEvents(
      tx,
      eventsFor(
        audit,
        'delete',
        deleted.map((row) => ({ requestId: row.id, before: requestEventSnapshot(row), after: {} })),
      ),
    );
  }
  return deleted;
}

/**
 * Record `delete` events for the wants a parent delete is about to take with it (`ON DELETE CASCADE`: a books
 * collection that left its server takes its collection wants). Call it in the parent delete's transaction, before the
 * delete; the rows are locked so nothing changes them in between. Returns how many it recorded.
 */
export async function recordCascadedRequestDeletes(
  tx: Transaction,
  audit: RequestWriteAudit,
  where: SQL,
): Promise<number> {
  const leaving = await tx.select().from(bookRequests).where(where).for('update');
  if (leaving.length > 0) {
    await insertEvents(
      tx,
      eventsFor(
        audit,
        'delete',
        leaving.map((row) => ({ requestId: row.id, before: requestEventSnapshot(row), after: {} })),
      ),
    );
  }
  return leaving.length;
}

/**
 * Write bookkeeping stamps only (`last_searched_at`, `last_reconciled_at`, `english_edition_tried_at`, `updated_at`).
 * No event: nothing a Request Event records changes. Any other field is refused, so a state change can never slip
 * through here unrecorded. Returns the ids stamped.
 */
export async function stampBookRequests(
  executor: DbClient | Transaction | undefined,
  where: SQL,
  set: BookRequestStamp,
): Promise<Array<{ id: string }>> {
  for (const key of Object.keys(set)) {
    if (!(STAMP_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `stampBookRequests: "${key}" is not a bookkeeping stamp (use updateBookRequests)`,
      );
    }
  }
  return resolveDb(executor as DbClient | undefined)
    .update(bookRequests)
    .set(set)
    .where(where)
    .returning({ id: bookRequests.id });
}

// ---------------------------------------------------------------------------
// Reading the history (issue #792, DESIGN-028 amendment 2026-10-07).
// ---------------------------------------------------------------------------

/** Where a page of history ends: the last event's `created_at` at full (microsecond) precision, and its id. */
export interface RequestEventCursor {
  /** ISO 8601 with microseconds (`2026-10-07T20:32:04.069123Z`); a JS Date would drop them and skip events. */
  at: string;
  id: string;
}

/** One Request Event as the history reads it: the row, plus the person's display name for a `user` event. */
export interface RequestEventView {
  id: string;
  requestId: string;
  kind: BookRequestEventKind;
  reason: BookRequestEventReason;
  writer: string;
  site: string | null;
  actor: BookRequestEventActor;
  /** The person's display name when `actor = 'user'` and the account still exists; else null. */
  actorName: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

/** Names for the ids a page of events holds, so the history shows titles instead of ids. */
export interface RequestEventRefs {
  /** `books_items` named by `matched_books_item_id` / `pairing_books_item_id`: title, and whether it is still live. */
  items: Record<string, { title: string; live: boolean }>;
  /** `books_collections` named by `collection_id`: title. */
  collections: Record<string, string>;
}

const ITEM_REF_COLUMNS = ['matched_books_item_id', 'pairing_books_item_id'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The created_at text a cursor carries: UTC, microseconds. */
const createdAtText = sql<string>`to_char(${bookRequestEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One want's Request Events, newest first (`book_request_events_request_created_idx`), `limit` at a time after
 * `before`. Events written in one transaction share its `created_at`; they are ordered by id, since their order inside
 * the transaction is not recorded. The want need not exist: a deleted want keeps its events (no foreign key). Also
 * returns the titles of the library items and collections the page's events name. Read-only.
 */
export async function listRequestEvents(input: {
  db?: DbClient;
  requestId: string;
  before?: RequestEventCursor | null;
  limit: number;
}): Promise<{
  events: RequestEventView[];
  next: RequestEventCursor | null;
  refs: RequestEventRefs;
}> {
  const db = resolveDb(input.db);
  const where: SQL[] = [eq(bookRequestEvents.requestId, input.requestId)];
  if (input.before) {
    where.push(
      sql`(${bookRequestEvents.createdAt}, ${bookRequestEvents.id}) < (${input.before.at}::timestamptz, ${input.before.id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: bookRequestEvents.id,
      requestId: bookRequestEvents.requestId,
      kind: bookRequestEvents.kind,
      reason: bookRequestEvents.reason,
      writer: bookRequestEvents.writer,
      site: bookRequestEvents.site,
      actor: bookRequestEvents.actor,
      actorName: users.displayName,
      before: bookRequestEvents.before,
      after: bookRequestEvents.after,
      detail: bookRequestEvents.detail,
      createdAt: bookRequestEvents.createdAt,
      at: createdAtText,
    })
    .from(bookRequestEvents)
    .leftJoin(users, eq(users.id, bookRequestEvents.actorUserId))
    .where(and(...where))
    .orderBy(desc(bookRequestEvents.createdAt), desc(bookRequestEvents.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const events: RequestEventView[] = page.map((e) => ({
    id: e.id,
    requestId: e.requestId,
    kind: e.kind,
    reason: e.reason,
    writer: e.writer,
    site: e.site,
    actor: e.actor,
    actorName: e.actor === 'user' ? (e.actorName ?? null) : null,
    before: e.before,
    after: e.after,
    detail: e.detail ?? null,
    createdAt: e.createdAt,
  }));

  const itemIds = new Set<string>();
  const collectionIds = new Set<string>();
  for (const e of events) {
    for (const side of [e.before, e.after]) {
      for (const col of ITEM_REF_COLUMNS) {
        const v = side[col];
        if (typeof v === 'string' && UUID_RE.test(v)) itemIds.add(v);
      }
      const c = side.collection_id;
      if (typeof c === 'string' && UUID_RE.test(c)) collectionIds.add(c);
    }
  }
  const refs: RequestEventRefs = { items: {}, collections: {} };
  if (itemIds.size > 0) {
    const items = await db
      .select({ id: booksItems.id, title: booksItems.title, deletedAt: booksItems.deletedAt })
      .from(booksItems)
      .where(inArray(booksItems.id, [...itemIds]));
    for (const i of items) refs.items[i.id] = { title: i.title, live: i.deletedAt === null };
  }
  if (collectionIds.size > 0) {
    const cols = await db
      .select({ id: booksCollections.id, title: booksCollections.title })
      .from(booksCollections)
      .where(inArray(booksCollections.id, [...collectionIds]));
    for (const c of cols) refs.collections[c.id] = c.title;
  }

  return {
    events,
    next: rows.length > input.limit && last !== undefined ? { at: last.at, id: last.id } : null,
    refs,
  };
}
