// Issue #735 (DESIGN-028 amendment 2026-10-06) — the LazyLibrarian Release (T-283) and the Orphan LazyLibrarian Want
// census (T-284).
//
// When the app gives a want up (a pairing want re-identified or parked, a collection want parked or dropped, an
// English-edition switch or park, a Goodreads shelf item removed, a Goodreads link unlinked), the writer that does it
// records the LazyLibrarian book format the app had queued for that want (`recordLlReleases`, `ll-release-record.ts`,
// same transaction). Before this, LazyLibrarian was never told: it kept searching every abandoned book in its daily
// backlog run, one query per indexer per book per day, and could still grab the wrong work (the #686 shape).
//
// `drainLlReleases` settles the pending rows, from ONE fresh `getAllBooks` read (only when a row is pending):
//   - a live request still asks LazyLibrarian for that book and format  ⇒ dropped, nothing written (`owned`);
//   - LazyLibrarian no longer has the book                              ⇒ dropped (`gone`);
//   - LazyLibrarian holds the format (Open/Have, a library date or file) ⇒ dropped (`held`);
//   - LazyLibrarian is downloading it (`Snatched`)                      ⇒ kept pending until the download ends;
//   - LazyLibrarian shows it `Wanted` (read again just before the write) ⇒ `unqueueBook` (back to `Skipped`), dropped;
//   - anything else (`Skipped`, `Ignored`, …)                           ⇒ dropped (`not_wanted`).
// `unqueueBook` is an unguarded UPDATE in LazyLibrarian (it would overwrite an imported format as readily), which is
// why it is only ever sent for a format the fresh read shows `Wanted` and not held. An empty read decides nothing.
//
// A LIVE request (the owner rule, `liveLlFormatOwners`): an unparked, non-comic request pointing at the book whose
// acquired formats include that one (`llAcquiredFormats`), and, for a goodreads want, whose shelf item is still on the
// shelf and whose link is not unlinked. Another person's request is never cancelled: the drain asks the owner rule again
// at drain time, after this run's own mints and pushes.
//
// The census (`findOrphanLlWants`): every LazyLibrarian format that reads `Wanted`, is not held and has no live owner.
// It is the measurement the adversarial review (#731, R-02) asked for, reported by format-pairing every run.
// `unqueueOrphanLlWants` is the one-off repair of the orphans that predate the release (`ll-orphan-unqueue.ts`), with a
// keep list for books a person queued by hand on purpose.
import {
  bookRequests,
  booksCollections,
  booksItems,
  integrationShelfItems,
  llFormatReleases,
  userIntegrations,
  type DbClient,
} from '@hnet/db';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { llFormatAlreadyHeld, type LlHeldSignals } from './book-requests';
import { resolveDb } from './db-client';
import { llSnapshotUsable, type LlSnapshot, type LlSnapshotRow } from './ll-gone';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import { llAcquiredFormats, type LlFormat } from './ll-release-record';

export * from './ll-release-record';

type ReleaseLog = {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
};

/** What the drain does with one pending release. */
export type LlReleaseDecision = 'unqueue' | 'owned' | 'gone' | 'held' | 'downloading' | 'not_wanted';

/**
 * Decide one pending release from LazyLibrarian's row for the book (undefined = LazyLibrarian has no such book) and
 * whether a live request still asks for that format. Pure; the order matters: an owned format is never unqueued, and
 * a held one never (the unguarded `unqueueBook` would overwrite it).
 */
export function decideLlRelease(input: {
  row: LlHeldSignals | undefined;
  format: LlFormat;
  owned: boolean;
}): LlReleaseDecision {
  if (input.owned) return 'owned';
  if (!input.row) return 'gone';
  if (llFormatAlreadyHeld(input.row, input.format)) return 'held';
  const raw = (input.format === 'audiobook' ? input.row.audioStatus : input.row.ebookStatus)?.trim().toLowerCase();
  if (raw === 'snatched') return 'downloading';
  if (raw === 'wanted') return 'unqueue';
  return 'not_wanted';
}

/**
 * The live owners of LazyLibrarian book formats: book id → the formats some live request asks LazyLibrarian for (the
 * owner rule in the file header). `llBookIds` narrows the read; absent reads every request with a book.
 */
export async function liveLlFormatOwners(
  db: DbClient | undefined,
  llBookIds?: readonly string[],
): Promise<Map<string, Set<LlFormat>>> {
  const owners = new Map<string, Set<LlFormat>>();
  if (llBookIds && llBookIds.length === 0) return owners;
  const rows = await resolveDb(db)
    .select({
      origin: bookRequests.origin,
      llBookId: bookRequests.llBookId,
      comicStatus: bookRequests.comicStatus,
      anchorKind: booksItems.mediaKind,
      collectionSource: booksCollections.source,
      shelfDeletedAt: integrationShelfItems.deletedAt,
      integrationStatus: userIntegrations.status,
    })
    .from(bookRequests)
    .leftJoin(booksItems, eq(booksItems.id, bookRequests.pairingBooksItemId))
    .leftJoin(booksCollections, eq(booksCollections.id, bookRequests.collectionId))
    .leftJoin(integrationShelfItems, eq(integrationShelfItems.id, bookRequests.shelfItemId))
    .leftJoin(userIntegrations, eq(userIntegrations.id, bookRequests.integrationId))
    .where(
      and(
        isNotNull(bookRequests.llBookId),
        isNull(bookRequests.unroutableReason),
        ...(llBookIds ? [inArray(bookRequests.llBookId, [...llBookIds])] : []),
      ),
    );
  for (const r of rows) {
    if (r.origin === 'goodreads' && (r.shelfDeletedAt !== null || r.integrationStatus === 'unlinked')) continue;
    const formats = llAcquiredFormats(
      { origin: r.origin, comicStatus: r.comicStatus },
      { anchorKind: r.anchorKind, collectionSource: r.collectionSource },
    );
    if (formats.length === 0) continue;
    const set = owners.get(r.llBookId!) ?? new Set<LlFormat>();
    for (const f of formats) set.add(f);
    owners.set(r.llBookId!, set);
  }
  return owners;
}

export interface LlReleaseTally {
  /** Formats this run sent back to `Skipped` (`unqueueBook`). */
  llReleasesUnqueued: number;
  /** Releases dropped without a LazyLibrarian write: owned by a live request, held, gone, or not `Wanted`. */
  llReleasesSettled: number;
  /** Releases still pending after the run: LazyLibrarian is downloading the format, or the unqueue failed. */
  llReleasesPending: number;
  /** Unqueues LazyLibrarian refused or that failed (kept pending, tried again next run). */
  llReleasesFailed: number;
}

/** One drain's outcome: the counts, and the `<id>:<format>` keys it unqueued (the census leaves those out). */
export interface LlReleaseDrain {
  tally: LlReleaseTally;
  unqueued: string[];
}

export function emptyLlReleaseTally(): LlReleaseTally {
  return { llReleasesUnqueued: 0, llReleasesSettled: 0, llReleasesPending: 0, llReleasesFailed: 0 };
}

/**
 * The last look before an `unqueueBook` (PR #751 review): LazyLibrarian offers no conditional update, and its backlog
 * search can snatch a format between the drain's read and the write, which would then reset a download to `Skipped`.
 * So the book is read once more right before each write (LazyLibrarian has no per-book read: `getAllBooks`, narrowed),
 * and the write is only sent if that read still says `Wanted` and unheld. Returns the book's row (undefined: LazyLibrarian
 * no longer has it), or null when the read failed or came back empty (send nothing this time). The window left is the
 * time between this read and the write; a format snatched inside it still imports (LazyLibrarian's post-processor works
 * from its own `wanted` row), and a failed one stays `Skipped`, which is where the release was taking it.
 */
async function rereadLlBook(
  ll: LazyLibrarianClientBundle,
  llBookId: string,
): Promise<LlSnapshotRow | undefined | null> {
  try {
    const snapshot = await ll.read.getAllBookStatuses();
    return llSnapshotUsable(snapshot) ? snapshot.get(llBookId) : null;
  } catch {
    return null;
  }
}

/**
 * Drain the pending LazyLibrarian Releases (see the file header). Reads LazyLibrarian once, and only when a release is
 * pending; a failed or empty read decides nothing (every row stays pending). Never throws for one row's LazyLibrarian
 * error: it is logged, counted and kept for the next run. Logs `ll_format_unqueued` per unqueue and `ll_release_settled`
 * per dropped row.
 */
export async function drainLlReleases(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  site: string;
  log?: ReleaseLog;
}): Promise<LlReleaseDrain> {
  const db = resolveDb(input.db);
  const log = input.log ?? {};
  const tally = emptyLlReleaseTally();
  const unqueued: string[] = [];
  const done = (): LlReleaseDrain => ({ tally, unqueued });
  const pending = await db.select().from(llFormatReleases);
  if (pending.length === 0) return done();
  tally.llReleasesPending = pending.length;
  let snapshot: Map<string, LlSnapshotRow>;
  try {
    snapshot = await input.ll.read.getAllBookStatuses();
  } catch (error) {
    log.error?.('ll-release: LazyLibrarian getAllBooks failed, releases kept for the next run', {
      site: input.site,
      pending: pending.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return done();
  }
  if (!llSnapshotUsable(snapshot)) {
    log.warn?.('ll-release: LazyLibrarian getAllBooks came back empty, releases kept for the next run', {
      site: input.site,
      pending: pending.length,
    });
    return done();
  }
  const owners = await liveLlFormatOwners(input.db, [...new Set(pending.map((p) => p.llBookId))]);
  const drop = async (row: (typeof pending)[number]): Promise<void> => {
    // Guarded on the row being the one this drain read: a want that gave the same format up since then re-recorded it
    // (a newer `updated_at`), and that record is the next drain's to judge. Compared below the next millisecond, since
    // Postgres keeps microseconds and the read row carries milliseconds.
    await db
      .delete(llFormatReleases)
      .where(
        and(
          eq(llFormatReleases.llBookId, row.llBookId),
          eq(llFormatReleases.format, row.format),
          lt(llFormatReleases.updatedAt, new Date(row.updatedAt.getTime() + 1)),
        ),
      );
  };
  for (const row of pending) {
    const book = snapshot.get(row.llBookId);
    const owned = owners.get(row.llBookId)?.has(row.format) ?? false;
    let decision = decideLlRelease({ row: book, format: row.format, owned });
    if (decision === 'unqueue') {
      // The last look before the unguarded write (a backlog search may have snatched the format since the read above).
      const fresh = await rereadLlBook(input.ll, row.llBookId);
      if (fresh === null) {
        log.warn?.('ll-release: LazyLibrarian re-read failed before unqueueBook, release kept for the next run', {
          site: input.site,
          llBookId: row.llBookId,
          format: row.format,
        });
        continue;
      }
      decision = decideLlRelease({ row: fresh, format: row.format, owned });
    }
    const meta = {
      site: input.site,
      llBookId: row.llBookId,
      format: row.format,
      reason: row.reason,
      requestId: row.requestId,
      title: book?.title ?? null,
    };
    if (decision === 'downloading') continue; // stays pending until LazyLibrarian's download ends either way
    if (decision === 'unqueue') {
      try {
        await input.ll.write.unqueueBook(row.llBookId, row.format);
      } catch (error) {
        tally.llReleasesFailed += 1;
        log.error?.('ll-release: unqueueBook failed, release kept for the next run', {
          ...meta,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await drop(row);
      tally.llReleasesUnqueued += 1;
      tally.llReleasesPending -= 1;
      unqueued.push(llReleaseKey(row.llBookId, row.format));
      log.info?.('ll_format_unqueued', meta);
      continue;
    }
    await drop(row);
    tally.llReleasesSettled += 1;
    tally.llReleasesPending -= 1;
    log.info?.('ll_release_settled', { ...meta, decision });
  }
  return done();
}

/** One LazyLibrarian format that reads `Wanted` with nothing holding it and no live request asking for it. */
export interface OrphanLlWant {
  llBookId: string;
  format: LlFormat;
  title: string | null;
  author: string | null;
  language: string | null;
}

/**
 * The Orphan LazyLibrarian Want census (T-284): every format of every book in the snapshot that reads `Wanted`, is not
 * held and has no live owner, sorted by id then format. `exclude` drops formats this run already unqueued (the snapshot
 * predates them). An unusable snapshot answers nothing.
 */
export async function findOrphanLlWants(input: {
  db?: DbClient;
  snapshot: LlSnapshot | Map<string, LlSnapshotRow> | null | undefined;
  exclude?: ReadonlySet<string>;
}): Promise<OrphanLlWant[]> {
  if (!llSnapshotUsable(input.snapshot)) return [];
  const snapshot = input.snapshot;
  const owners = await liveLlFormatOwners(input.db);
  const orphans: OrphanLlWant[] = [];
  for (const [llBookId, row] of snapshot) {
    for (const format of ['ebook', 'audiobook'] as const) {
      const raw = format === 'ebook' ? row.ebookStatus : row.audioStatus;
      if (raw?.trim().toLowerCase() !== 'wanted') continue;
      if (llFormatAlreadyHeld(row, format)) continue;
      if (owners.get(llBookId)?.has(format)) continue;
      if (input.exclude?.has(llReleaseKey(llBookId, format))) continue;
      orphans.push({
        llBookId,
        format,
        title: row.title ?? null,
        author: row.author ?? null,
        language: row.language ?? null,
      });
    }
  }
  return orphans.sort((a, b) => a.llBookId.localeCompare(b.llBookId) || a.format.localeCompare(b.format));
}

/** The `<llBookId>:<format>` key the keep list and the census exclusions use. */
export function llReleaseKey(llBookId: string, format: LlFormat): string {
  return `${llBookId}:${format}`;
}

export interface UnqueueOrphanReport {
  dryRun: boolean;
  orphans: number;
  unqueued: number;
  kept: number;
  /** No longer `Wanted` (or unreadable) at the last look just before the write. */
  skipped: number;
  failed: number;
  rows: Array<OrphanLlWant & { action: 'unqueue' | 'would_unqueue' | 'keep' | 'skip' | 'failed'; error?: string }>;
}

/**
 * The one-off repair (issue #735) of the orphans that predate the LazyLibrarian Release: every Orphan LazyLibrarian
 * Want from one fresh read, except the `keep` list (books a person queued by hand on purpose, `<id>:<format>`), is sent
 * back to `Skipped`. The owner rule is read again just before the writes, so a want minted meanwhile keeps its book.
 * `dryRun` lists what it would do and writes nothing. Idempotent: a second run finds only the kept ones.
 */
export async function unqueueOrphanLlWants(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  snapshot: LlSnapshot | Map<string, LlSnapshotRow>;
  keep: ReadonlySet<string>;
  dryRun: boolean;
  log?: ReleaseLog;
}): Promise<UnqueueOrphanReport> {
  const log = input.log ?? {};
  const orphans = await findOrphanLlWants({ db: input.db, snapshot: input.snapshot });
  const report: UnqueueOrphanReport = {
    dryRun: input.dryRun,
    orphans: orphans.length,
    unqueued: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    rows: [],
  };
  for (const orphan of orphans) {
    if (input.keep.has(llReleaseKey(orphan.llBookId, orphan.format))) {
      report.kept += 1;
      report.rows.push({ ...orphan, action: 'keep' });
      continue;
    }
    if (input.dryRun) {
      report.rows.push({ ...orphan, action: 'would_unqueue' });
      continue;
    }
    // The same last look as the drain: skip a format that is no longer `Wanted` (or that the read cannot see).
    const fresh = await rereadLlBook(input.ll, orphan.llBookId);
    if (fresh === null || decideLlRelease({ row: fresh, format: orphan.format, owned: false }) !== 'unqueue') {
      report.skipped += 1;
      report.rows.push({ ...orphan, action: 'skip' });
      continue;
    }
    try {
      await input.ll.write.unqueueBook(orphan.llBookId, orphan.format);
      report.unqueued += 1;
      report.rows.push({ ...orphan, action: 'unqueue' });
      log.info?.('ll_format_unqueued', {
        site: 'll-orphan-unqueue',
        reason: 'orphan',
        llBookId: orphan.llBookId,
        format: orphan.format,
        title: orphan.title,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed += 1;
      report.rows.push({ ...orphan, action: 'failed', error: message });
      log.error?.('ll-release: orphan unqueueBook failed', { llBookId: orphan.llBookId, format: orphan.format, error: message });
    }
  }
  return report;
}

/** One live request format that reads `grabbed` while LazyLibrarian is not downloading it (issue #734's census). */
export interface GrabbedNotSnatched {
  requestId: string;
  llBookId: string;
  format: LlFormat;
  llStatus: string | null;
}

/**
 * Issue #734's census: every format of a live request (the owner rule) that reads `grabbed` while the LazyLibrarian
 * book it points at neither shows it `Snatched` nor holds it. After #734 the reconcile settles these each run, so the
 * number reads 0 (or only a want the run could not reconcile, such as one on a book LazyLibrarian lost, which the gone
 * rule owns). An unusable snapshot answers nothing.
 */
export async function findGrabbedNotSnatched(input: {
  db?: DbClient;
  snapshot: LlSnapshot | Map<string, LlSnapshotRow> | null | undefined;
}): Promise<GrabbedNotSnatched[]> {
  if (!llSnapshotUsable(input.snapshot)) return [];
  const snapshot = input.snapshot;
  const rows = await resolveDb(input.db)
    .select({
      id: bookRequests.id,
      origin: bookRequests.origin,
      llBookId: bookRequests.llBookId,
      comicStatus: bookRequests.comicStatus,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      anchorKind: booksItems.mediaKind,
      collectionSource: booksCollections.source,
      shelfDeletedAt: integrationShelfItems.deletedAt,
      integrationStatus: userIntegrations.status,
    })
    .from(bookRequests)
    .leftJoin(booksItems, eq(booksItems.id, bookRequests.pairingBooksItemId))
    .leftJoin(booksCollections, eq(booksCollections.id, bookRequests.collectionId))
    .leftJoin(integrationShelfItems, eq(integrationShelfItems.id, bookRequests.shelfItemId))
    .leftJoin(userIntegrations, eq(userIntegrations.id, bookRequests.integrationId))
    .where(and(isNotNull(bookRequests.llBookId), isNull(bookRequests.unroutableReason)));
  const out: GrabbedNotSnatched[] = [];
  for (const r of rows) {
    if (r.origin === 'goodreads' && (r.shelfDeletedAt !== null || r.integrationStatus === 'unlinked')) continue;
    const book = snapshot.get(r.llBookId!);
    for (const format of llAcquiredFormats(
      { origin: r.origin, comicStatus: r.comicStatus },
      { anchorKind: r.anchorKind, collectionSource: r.collectionSource },
    )) {
      if ((format === 'ebook' ? r.ebookStatus : r.audioStatus) !== 'grabbed') continue;
      if (!book) continue; // a book LazyLibrarian lost is the gone rule's (T-279)
      const raw = format === 'ebook' ? book.ebookStatus : book.audioStatus;
      if (raw?.trim().toLowerCase() === 'snatched' || llFormatAlreadyHeld(book, format)) continue;
      out.push({ requestId: r.id, llBookId: r.llBookId!, format, llStatus: raw ?? null });
    }
  }
  return out;
}
