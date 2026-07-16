// ADR-062 / DESIGN-033 (PLAN-041 — books/audiobooks/comics Fix). The single-writer + orchestrator
// for a LANDED-bad-copy remediation: the audited `book_fix_requests` row commits BEFORE any
// external call (fix-flow crash-safety), then the acquisition-layer re-grab fires OUTSIDE the tx —
// books/audiobooks via the confined @hnet/lazylibrarian/write (addBook → queueBook → searchBook;
// queueBook is MANDATORY — addBook alone lands Skipped), comics via @hnet/kapowarr/write
// (idempotent monitor → auto_search). Never Kavita/ABS, never MAM/qB/Prowlarr (ADR-062 C-01).
// The stale bad file is NOT moved (C-03 — the app has no filesystem surface); the row carries
// `stale_file_action` so the UI guides and the deferred Mode-2 has its signal.
import {
  bookFixRequests,
  bookRequests,
  booksItems,
  permissionAudit,
  roleBooksActionGrants,
  roles,
  BOOK_ACTIONS,
  type BookAction,
  type BookFixReason,
  type BookFixRequestRow,
  type BookFixRoute,
  type DbClient,
} from '@hnet/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import type { KapowarrClientBundle } from './kapowarr-clients';

// ---------------------------------------------------------------------------
// Errors (mapped in packages/api trpc.ts: rate → TOO_MANY_REQUESTS, open-dupe → CONFLICT).
// ---------------------------------------------------------------------------

/** The books-scoped hourly budget tripped (owner ruling 2026-07-15: 25/user/hour; admins exempt). */
export class BookFixRateLimitError extends Error {
  readonly code = 'BOOK_FIX_RATE_LIMIT' as const;
}

/** A Fix is already OPEN for this (books_item, media_kind) — the real spam guard (Q-08). */
export class BookFixAlreadyOpenError extends Error {
  readonly code = 'BOOK_FIX_ALREADY_OPEN' as const;
}

/** The fix could not resolve an acquisition identity (no request row + GB lookup failed/absent). */
export class BookFixUnroutableError extends Error {
  readonly code = 'BOOK_FIX_UNROUTABLE' as const;
}

/** Owner ruling 2026-07-15 — generous for the friends-and-family group; env-tunable. */
export const BOOK_FIX_RATE_LIMIT_PER_HOUR = Number(process.env.BOOK_FIX_RATE_LIMIT_PER_HOUR ?? 25);

const OPEN_BOOK_FIX_STATUSES = ['pending', 'search_triggered'] as const;

// ---------------------------------------------------------------------------
// Grants (the ADR-023/059 idiom — setRoleBookActions is the sole writer).
// ---------------------------------------------------------------------------

/** The books actions granted to a role (empty for admin roles — admin implies all; gate handles it). */
export async function bookActionsForRole(input: {
  db?: DbClient;
  roleId: string;
}): Promise<BookAction[]> {
  const rows = await resolveDb(input.db)
    .select({ action: roleBooksActionGrants.action })
    .from(roleBooksActionGrants)
    .where(eq(roleBooksActionGrants.roleId, input.roleId));
  return rows.map((r) => r.action);
}

/**
 * Replace-set a role's books action grants (Admin is immutable — it implies all actions and stores
 * none). Co-writes an `update_book_actions` permission_audit row in the SAME tx (hard rule 6).
 * THE Q-01 FLIP: after the owner validates the Admin-only test window, this is the call that opens
 * `fix_book` to every role.
 */
export async function setRoleBookActions(input: {
  db?: DbClient;
  roleId: string;
  actions: BookAction[];
  actorId: string;
}): Promise<BookAction[]> {
  const unique = [...new Set(input.actions)];
  for (const a of unique) {
    if (!BOOK_ACTIONS.includes(a)) throw new Error(`Unknown book action: ${a}`);
  }
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, isAdmin: roles.isAdmin, name: roles.name })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) throw new Error('ROLE_IMMUTABLE: the Admin role implies all book actions');

    await tx.delete(roleBooksActionGrants).where(eq(roleBooksActionGrants.roleId, role.id));
    if (unique.length > 0) {
      await tx
        .insert(roleBooksActionGrants)
        .values(unique.map((action) => ({ roleId: role.id, action })));
    }
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_book_actions',
      detail: { role_id: role.id, role_name: role.name, actions: unique },
    });
    return unique;
  });
}

// ---------------------------------------------------------------------------
// The Fix single-writer (tx: rate guard + dedupe + insert + audit) — DESIGN-033 D-04.
// ---------------------------------------------------------------------------

export interface CreateBookFixInput {
  db?: DbClient;
  requesterId: string;
  /** Admins bypass the hourly budget (the *arr Fix precedent). */
  requesterIsAdmin?: boolean;
  booksItemId: string;
  reason: BookFixReason;
  reasonText?: string | null;
  languagePref?: string | null;
  now?: Date;
}

/**
 * Create the audited fix row (BEFORE any external call). Resolves the book identity snapshot from
 * `books_items`, derives the route from media_kind, links a `book_requests` row when one matches
 * (its ll_book_id / kapowarr_volume_id seed the acquisition identity), enforces the books-scoped
 * hourly budget + one-open-per-(item,kind), and co-writes the `request_book_fix` audit — one tx.
 */
export async function createBookFixRequest(input: CreateBookFixInput): Promise<BookFixRequestRow> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [item] = await tx
      .select()
      .from(booksItems)
      .where(eq(booksItems.id, input.booksItemId))
      .limit(1);
    if (!item) throw new NotFoundError(`Books item ${input.booksItemId} not found`);
    if (item.deletedAt !== null) throw new NotFoundError(`Books item ${input.booksItemId} is tombstoned`);

    // Rate guard (books-scoped — never consumes the *arr Fix budget; owner ruling Q-08).
    if (!input.requesterIsAdmin) {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bookFixRequests)
        .where(
          and(
            eq(bookFixRequests.requesterId, input.requesterId),
            gte(bookFixRequests.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        );
      if ((count?.n ?? 0) >= BOOK_FIX_RATE_LIMIT_PER_HOUR) {
        throw new BookFixRateLimitError(
          `Book Fix limit reached (${BOOK_FIX_RATE_LIMIT_PER_HOUR} per hour) — try again in a bit`,
        );
      }
    }

    // One OPEN fix per (books_item, media_kind) — the real spam guard.
    const [open] = await tx
      .select({ id: bookFixRequests.id })
      .from(bookFixRequests)
      .where(
        and(
          eq(bookFixRequests.booksItemId, item.id),
          eq(bookFixRequests.mediaKind, item.mediaKind),
          inArray(bookFixRequests.status, [...OPEN_BOOK_FIX_STATUSES]),
        ),
      )
      .limit(1);
    if (open) throw new BookFixAlreadyOpenError(`A Fix is already in progress for "${item.title}"`);

    // Optional request-row link — seeds the acquisition identity when present.
    const [request] = await tx
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      })
      .from(bookRequests)
      .where(eq(bookRequests.matchedBooksItemId, item.id))
      .limit(1);

    const route: BookFixRoute = item.mediaKind === 'comic' ? 'kapowarr' : 'lazylibrarian';
    const [row] = await tx
      .insert(bookFixRequests)
      .values({
        requesterId: input.requesterId,
        booksItemId: item.id,
        source: item.source,
        externalId: item.externalId,
        mediaKind: item.mediaKind,
        titleSnapshot: item.title,
        route,
        reason: input.reason,
        reasonText: input.reason === 'other' ? (input.reasonText ?? null) : null,
        languagePref: input.reason === 'wrong_language' ? (input.languagePref ?? 'English') : null,
        // A landed bad copy means the old file sits on disk until quarantined (ADR-062 C-03).
        staleFileAction: 'owner_quarantine',
        status: 'pending',
        actionsTaken: [
          { step: 'requested', at: now.toISOString(), requester: input.requesterId, reason: input.reason },
        ],
        llBookId: request?.llBookId ?? null,
        kapowarrVolumeId: request?.kapowarrVolumeId != null ? Number(request.kapowarrVolumeId) : null,
        bookRequestId: request?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('book fix insert returned no row');

    await tx.insert(permissionAudit).values({
      actorId: input.requesterId,
      action: 'request_book_fix',
      detail: {
        fix_id: row.id,
        books_item_id: item.id,
        media_kind: item.mediaKind,
        title: item.title,
        reason: input.reason,
        route,
      },
    });
    return row;
  });
}

/** Append external steps (+ raw sanitized responses) and advance the status — the sole updater. */
export async function recordBookFixAction(input: {
  db?: DbClient;
  fixId: string;
  status?: 'search_triggered' | 'failed' | 'completed';
  actions: Record<string, unknown>[];
  llBookId?: string | null;
  kapowarrVolumeId?: number | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({ id: bookFixRequests.id, actionsTaken: bookFixRequests.actionsTaken })
      .from(bookFixRequests)
      .where(eq(bookFixRequests.id, input.fixId))
      .for('update');
    if (!row) throw new NotFoundError(`Book fix ${input.fixId} not found`);
    await tx
      .update(bookFixRequests)
      .set({
        actionsTaken: [...(row.actionsTaken ?? []), ...input.actions],
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.status === 'completed' ? { completedAt: now } : {}),
        ...(input.llBookId !== undefined ? { llBookId: input.llBookId } : {}),
        ...(input.kapowarrVolumeId !== undefined ? { kapowarrVolumeId: input.kapowarrVolumeId } : {}),
        updatedAt: now,
      })
      .where(eq(bookFixRequests.id, row.id));
  });
}

// ---------------------------------------------------------------------------
// The orchestrator (OUTSIDE any tx — the fix-flow discipline) — DESIGN-033 D-04.
// ---------------------------------------------------------------------------

/** The GB resolver seam ({ resolveVolume }) — injected so tests stay offline (ADR-010). */
export interface BookFixGbResolver {
  resolveVolume(input: { isbn?: string | null; title: string; author?: string | null }): Promise<{ volumeId: string } | null>;
}

export interface RunBookFixInput {
  db?: DbClient;
  fix: BookFixRequestRow;
  ll?: LazyLibrarianClientBundle;
  kapowarr?: KapowarrClientBundle;
  /** GB fallback for the LL identity when no request row seeded it (quota-fragile — fail honest). */
  gb?: BookFixGbResolver | null;
  logger?: { info?: (m: string, x?: Record<string, unknown>) => void; error?: (m: string, x?: Record<string, unknown>) => void };
}

/**
 * Fire the acquisition-layer re-grab for a created fix. Books/audiobooks: resolve the LL book id
 * (fix row seed → GB lookup fallback) → addBook → queueBook(format) → searchBook(format). Comics:
 * resolve the Kapowarr volume (fix row seed only in v1) → setMonitored → auto_search. Each step's
 * raw response is appended; any failure lands the fix `failed` with the honest error.
 */
export async function runBookFixRequest(input: RunBookFixInput): Promise<{ status: string }> {
  const fix = input.fix;
  const log = input.logger ?? {};
  const steps: Record<string, unknown>[] = [];
  const stamp = () => new Date().toISOString();

  try {
    if (fix.route === 'kapowarr') {
      if (!input.kapowarr) throw new BookFixUnroutableError('Kapowarr is not configured');
      const volumeId = fix.kapowarrVolumeId;
      if (volumeId == null) {
        throw new BookFixUnroutableError(
          'This comic has no Kapowarr volume yet — request it via Integrations first',
        );
      }
      await input.kapowarr.write.setMonitored(volumeId, true);
      steps.push({ step: 'kapowarr_monitored', at: stamp(), volumeId });
      await input.kapowarr.write.searchVolume(volumeId);
      steps.push({ step: 'kapowarr_auto_search', at: stamp(), volumeId });
      await recordBookFixAction({ db: input.db, fixId: fix.id, status: 'search_triggered', actions: steps });
      return { status: 'search_triggered' };
    }

    // lazylibrarian — books/audiobooks.
    if (!input.ll) throw new BookFixUnroutableError('LazyLibrarian is not configured');
    let llBookId = fix.llBookId;
    if (llBookId == null) {
      const resolved = input.gb
        ? await input.gb.resolveVolume({ title: fix.titleSnapshot, author: null })
        : null;
      if (resolved == null) {
        throw new BookFixUnroutableError(
          'Could not resolve this book against Google Books (no request row to reuse) — try again later',
        );
      }
      llBookId = resolved.volumeId;
      steps.push({ step: 'gb_resolved', at: stamp(), llBookId });
    }
    const format = fix.mediaKind === 'audiobook' ? ('audiobook' as const) : ('ebook' as const);
    await input.ll.write.addBook(llBookId);
    steps.push({ step: 'll_add_book', at: stamp(), llBookId });
    await input.ll.write.queueBook(llBookId, format); // MANDATORY — addBook alone lands Skipped.
    steps.push({ step: 'll_queue_book', at: stamp(), llBookId, format });
    await input.ll.write.searchBook(llBookId, format);
    steps.push({ step: 'll_search_book', at: stamp(), llBookId, format });
    await recordBookFixAction({
      db: input.db,
      fixId: fix.id,
      status: 'search_triggered',
      actions: steps,
      llBookId,
    });
    return { status: 'search_triggered' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error?.('book-fix: acquisition step failed', { fixId: fix.id, error: message });
    steps.push({ step: 'failed', at: stamp(), error: message });
    await recordBookFixAction({ db: input.db, fixId: fix.id, status: 'failed', actions: steps });
    return { status: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** A user's fixes newest-first (parity with fix.myFixes). */
export async function listBookFixes(input: {
  db?: DbClient;
  requesterId?: string;
  limit?: number;
}): Promise<BookFixRequestRow[]> {
  const db = resolveDb(input.db);
  const base = db.select().from(bookFixRequests);
  const rows = await (input.requesterId !== undefined
    ? base.where(eq(bookFixRequests.requesterId, input.requesterId))
    : base
  )
    .orderBy(sql`${bookFixRequests.createdAt} DESC`)
    .limit(input.limit ?? 50);
  return rows;
}

/** One fix row (progress joins live Activity state in the API layer). */
export async function getBookFix(input: { db?: DbClient; fixId: string }): Promise<BookFixRequestRow | null> {
  const [row] = await resolveDb(input.db)
    .select()
    .from(bookFixRequests)
    .where(eq(bookFixRequests.id, input.fixId))
    .limit(1);
  return row ?? null;
}
