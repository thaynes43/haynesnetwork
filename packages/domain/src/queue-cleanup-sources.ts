// ADR-095 / DESIGN-046 D-15, D-18, D-19 (PLAN-065 — the queue janitor covers the download suite). The SOURCE ADAPTER
// seam and its two adapters, LazyLibrarian (books and audiobooks, through its grab log and SABnzbd) and Kapowarr
// (comics). An adapter reads and classifies its own items, and carries out one class's action for one download; the
// shared evaluator in ./queue-cleanup applies every ADR-083 rail to it (cells, the age rail, the per-run cap, one
// action per download, retry escalation, the loop guard, the loop signals, the census rows). The *arr instances keep
// their own path (D-02..D-14).
//
// Hard rule 4 (amended by ADR-095 C-03): the write clients are built HERE, inside @hnet/domain, so @hnet/sync never
// imports @hnet/downloads/write, @hnet/lazylibrarian/write or @hnet/kapowarr/write (the arr-write-import-guard test).
// The only writes: LazyLibrarian `forceProcess`; the SABnzbd history-job delete (a LazyLibrarian bad_release, SABnzbd
// downloads only); the delete of a Processed download's completed SABnzbd folder after its library copies are
// confirmed to hold the folder's own book files (leftover, D-18 rule 5 and D-22); Kapowarr's queue removal with
// blocklist and its `auto_search`. Never library files, never a qBittorrent torrent (MAM keeps seeding).
import type { QueueCleanupActionClass, QueueCleanupSourceInstance } from '@hnet/db';
import {
  LazyLibrarianReadClient,
  sanitizeLlResult,
  type LlBookStatus,
  type LlHistoryEntry,
} from '@hnet/lazylibrarian/read';
import { LazyLibrarianWriteClient } from '@hnet/lazylibrarian/write';
import { assertLazyLibrarianEnv } from '@hnet/lazylibrarian';
import { KapowarrReadClient, type KapowarrQueueEntry } from '@hnet/kapowarr/read';
import { KapowarrWriteClient } from '@hnet/kapowarr/write';
import { KapowarrHttpError, assertKapowarrEnv } from '@hnet/kapowarr';
import {
  DownloadPathProbe,
  SabnzbdReadClient,
  llJanitorPathsFromEnv,
  type FolderCoverage,
  type FolderCoverageGap,
  type SabJanitorHistorySlot,
  type SabQueueSlot,
} from '@hnet/downloads/read';
import { DownloadFolderCleaner, SabnzbdWriteClient } from '@hnet/downloads/write';
import { assertSabnzbdEnv } from '@hnet/downloads';

// ---------------------------------------------------------------------------
// The seam (D-15).
// ---------------------------------------------------------------------------

/** One item a source adapter observed, already classified (D-15). One census row per item per run. */
export interface QueueCleanupSourceItem {
  /** The source's integer queue id (Kapowarr's queue entry id); null where the source has none (LazyLibrarian). */
  queueItemId: number | null;
  /** The source's string reference for what the item is about (LazyLibrarian `<bookId>/<ebook|audiobook>`); null
   *  otherwise. Keys the loop guard and the fail-loop signal where `targetId` cannot. */
  itemRef: string | null;
  /** The download-client id (SABnzbd `nzo_id`, torrent hash, Kapowarr queue id). Records sharing one form one
   *  download (D-11): one action, one cap slot. Null for an item that is not one download (a fail loop). */
  downloadId: string | null;
  /** The release or job name (display only; never a reason, D-10). */
  title: string | null;
  /** When the item became stuck (the download finished), for the age rail. Null when the source does not say: the
   *  evaluator then uses the janitor's own first sighting of the download. */
  addedAt: Date | null;
  /** The integer search target (Kapowarr's volume id); null otherwise. */
  targetId: number | null;
  /** The source's verdict (D-18, D-19). */
  actionClass: QueueCleanupActionClass;
  /** The message behind the verdict (≤500 chars), never a release or file name (D-10). */
  reason: string | null;
  /** `fail_loop`: the failed grabs the source recorded for the item. Null otherwise. */
  attempts: number | null;
  /** False when the janitor must never remove this item's download from its client (a qBittorrent torrent, which
   *  keeps seeding): a removing class is then `skipped_seeding`. A class that removes nothing (retry_import) may
   *  still act. */
  removable: boolean;
}

/** The classes a source adapter can carry out for one download (`retry_import` is `retryImports`, once per run). */
export type QueueCleanupSourceActClass = 'bad_release' | 'leftover';

/** What one `act` call did beyond the removal itself. */
export interface QueueCleanupSourceActResult {
  /** The items whose target was searched again after the removal (Kapowarr's volume search). */
  searched: QueueCleanupSourceItem[];
  /** The removal landed, but a follow-up (the monitored check or the search) failed: the rows keep the removal
   *  with `outcome: 'error'` (the D-11 rule 4 shape). */
  followUpError?: string;
}

/** The source no longer holds the download (a 404, or a folder already gone): `skipped_gone`, not an error. */
export class QueueCleanupItemGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueCleanupItemGoneError';
  }
}

interface SourceLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * The per-source surface the shared evaluator drives (D-15). Tests inject a stub; prod wires the real clients
 * (`buildLazyLibrarianQueueCleanupAdapter`, `buildKapowarrQueueCleanupAdapter`).
 */
export interface QueueCleanupSourceAdapter {
  readonly instance: QueueCleanupSourceInstance;
  /** Read and classify every item worth a census row (read-only). Throws when the source cannot be read. */
  observe(ctx?: { logger?: SourceLogger }): Promise<QueueCleanupSourceItem[]>;
  /** Carry out a removing class for ONE download's items (they share `downloadId`). Throws when nothing was done
   *  (QueueCleanupItemGoneError when the source no longer holds it). */
  act(actionClass: QueueCleanupSourceActClass, items: QueueCleanupSourceItem[]): Promise<QueueCleanupSourceActResult>;
  /** retry_import's source-wide verb (LazyLibrarian `forceProcess`), at most once per run. Absent: no retry cell. */
  retryImports?(): Promise<void>;
}

const truncate = (s: string): string => (s.length > 500 ? s.slice(0, 500) : s);
const nonEmpty = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null);

// ---------------------------------------------------------------------------
// LazyLibrarian (D-18) — pure classification.
// ---------------------------------------------------------------------------

/** A book format with at least this many failed grabs in LazyLibrarian's log, still Wanted, is a `fail_loop` (D-18).
 *  The coordinator's audit (2026-09-29) counted 60 such pairs, the worst at 173. */
export const FAIL_LOOP_MIN_FAILURES = 5;

/** LazyLibrarian's SABnzbd category (its `sab_cat`, live 2026-09-29). */
export const LL_SAB_CATEGORY_DEFAULT = 'lazylibrarian';

/**
 * Turn a LazyLibrarian or SABnzbd failure text into a message fit for the `reason` column (D-10: a message, never a
 * release, file or path name; D-18). LazyLibrarian embeds names, paths and indexer URLs in many of them. Markup and
 * keys are stripped first (`sanitizeLlResult`). Pure.
 */
export function normalizeLlFailure(raw: string | null | undefined): string | null {
  const clean = sanitizeLlResult(raw);
  if (clean === null) return null;
  // No query string or fragment of any URL survives (an indexer link can carry a key under any parameter name).
  const s = clean.replace(/(\bhttps?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1');
  const rules: Array<[RegExp, string | ((...m: string[]) => string)]> = [
    [/^Rejecting torrent name .*?, contains (\S+)\.?$/i, (_m, w) => `Rejecting torrent name, contains ${w}`],
    [
      /^Unable to locate a valid filetype \((\w+)\).*?(, leaving for manual processing)?$/i,
      (_m, t, tail) => `Unable to locate a valid filetype (${t})${tail ?? ''}`,
    ],
    [/^Unable to copy file\b.*$/i, 'Unable to copy file'],
    [/^URL Fetching failed;.*$/i, 'URL Fetching failed'],
    [/^Got a (\d{3}) response for\b.*$/i, (_m, code) => `Got a ${code} response from the indexer`],
    [/^(Repair failed, not enough repair blocks) \(\d+ short\).*$/i, (_m, head) => head],
    [/^Failed to send nzb to\b.*$/i, 'Failed to send nzb to SABnzbd'],
    [/^Failed to send torrent to (\S+).*$/i, (_m, c) => `Failed to send torrent to ${c}`],
    [/^.* was sent to (\S+) \d+ hours? ago\..*$/i, (_m, c) => `Sent to ${c}, never finished`],
    [/^.* was aborted by (\S+)$/i, (_m, c) => `Aborted by ${c}`],
  ];
  for (const [re, out] of rules) {
    const m = s.match(re);
    if (m) {
      const text = typeof out === 'string' ? out : out(...(m as unknown as string[]));
      return truncate(text);
    }
  }
  // Anything else: drop any absolute path it names (a folder or file name is not a reason).
  return truncate(s.replace(/(?:^|\s)\/[^\s,]+/g, ' …').replace(/\s+/g, ' ').trim());
}

/** `<bookId>/<ebook|audiobook>` — the book format a LazyLibrarian row is about (the rows' `item_ref`). */
export function llItemRef(bookId: string, format: 'ebook' | 'audiobook' | null): string {
  return `${bookId}/${format ?? 'unknown'}`;
}

const FORMAT_LABEL = { ebook: 'eBook', audiobook: 'audiobook' } as const;

/** A SABnzbd job the leftover census found on disk (the folder exists), with its LazyLibrarian rows' library copies
 *  checked (D-18). Built by the adapter's IO; classified purely. */
export interface LlLeftoverCandidate {
  slot: SabJanitorHistorySlot;
  /** More than one SABnzbd job names this folder (a later job reused the name of one whose folder had been
   *  deleted): the folder may hold another download, so it is never a leftover. */
  shared?: boolean;
  /** Every recorded library destination of the download's Processed rows, and whether it exists as a file. */
  libraryCopies: Array<{ path: string | null; exists: boolean }>;
  /** D-22 — whether every book file of the folder has its counterpart among the files of those destinations'
   *  directories (audio by name and size, eBook by extension and size). Checked only for a folder that passed every
   *  other test; absent or null reads as not compared, never as a leftover. */
  coverage?: FolderCoverage | null;
}

/** D-22 rule 5 — the report-only reason for each way a folder can fail the content check. Messages, no names. */
export const LEFTOVER_COVERAGE_REASONS: Record<FolderCoverageGap | 'not_compared', string> = {
  not_matched: 'Library copy differs from the download folder, the download folder may be the only copy',
  no_book_file: 'No book file in the download folder to compare with the library copy',
  archive: 'Download folder holds an archive, it cannot be compared with the library copy',
  unreadable: 'Download folder could not be compared with the library copy',
  not_compared: 'Download folder could not be compared with the library copy',
};

/** The inputs of one LazyLibrarian classification pass (D-18). */
export interface LlClassifyInput {
  /** LazyLibrarian's whole grab log (`cmd=getHistory`). */
  history: LlHistoryEntry[];
  /** Every book's per-format status (`cmd=getAllBooks`). */
  books: Map<string, LlBookStatus>;
  /** SABnzbd's queue (in-flight jobs). */
  sabQueue: SabQueueSlot[];
  /** The SABnzbd history jobs of the Snatched rows, from both views (live and archive). */
  sabJobs: SabJanitorHistorySlot[];
  /** The leftover census: null when the mounts are absent (then no leftover is observed at all). */
  leftovers: LlLeftoverCandidate[] | null;
}

const isFailedSab = (slot: SabJanitorHistorySlot): boolean =>
  slot.status.toLowerCase() === 'failed' || nonEmpty(slot.failMessage) !== null;

/**
 * Classify LazyLibrarian's state into census items (D-18). Pure. Three populations, in this order:
 *
 * 1. **Snatches** — every `Snatched` row (in flight or stranded), one item per row. SABnzbd: a job still in SABnzbd's
 *    queue is in flight (`unknown`); a finished job LazyLibrarian has not imported is `retry_import` (it never aborts a
 *    download at 100%, so without the janitor it strands for ever); a failed job it has not aborted is `bad_release`;
 *    a job SABnzbd no longer shows is `unknown` (LazyLibrarian aborts it itself). qBittorrent: a finished torrent not
 *    imported is `retry_import`, never removable (MAM keeps seeding); otherwise in flight.
 * 2. **Leftovers** (only with the mounts) — one item per SABnzbd job of LazyLibrarian's category whose completed
 *    folder is still on disk: `leftover` when every LazyLibrarian row of the download is Processed, every library
 *    copy it recorded exists, and every book file of the folder has its counterpart among those copies' files (D-22:
 *    audio by name and size, eBook by extension and size); `unknown` when a copy is missing or differs (the folder may
 *    be the only copy), when the folder cannot be compared, or when the download failed (DESIGN-046 Q-06). A job with
 *    a Snatched row is left to population 1.
 * 3. **Fail loops** — one item per book format with FAIL_LOOP_MIN_FAILURES or more failed grabs that is still Wanted:
 *    `fail_loop`, report only, with the failure count and the most frequent failure.
 */
export function classifyLazyLibrarian(input: LlClassifyInput): QueueCleanupSourceItem[] {
  const items: QueueCleanupSourceItem[] = [];
  const queued = new Set(input.sabQueue.map((s) => s.nzoId));
  const jobs = new Map<string, SabJanitorHistorySlot>();
  for (const slot of input.sabJobs) if (!jobs.has(slot.nzoId)) jobs.set(slot.nzoId, slot);

  // 1. Snatches.
  for (const row of input.history) {
    if (row.status.toLowerCase() !== 'snatched') continue;
    const downloadId = nonEmpty(row.downloadId);
    const base = {
      queueItemId: null,
      itemRef: llItemRef(row.bookId, row.format),
      downloadId,
      title: nonEmpty(row.title),
      targetId: null,
      attempts: null,
    };
    const completedAt = row.completedAt ? new Date(row.completedAt) : null;
    if (row.source === 'sabnzbd' && downloadId !== null) {
      const job = jobs.get(downloadId);
      if (queued.has(downloadId)) {
        items.push({ ...base, addedAt: null, actionClass: 'unknown', reason: null, removable: true });
      } else if (job && isFailedSab(job)) {
        items.push({
          ...base,
          addedAt: job.completedAt ?? completedAt,
          actionClass: 'bad_release',
          reason: normalizeLlFailure(job.failMessage) ?? 'Download failed in SABnzbd',
          removable: true,
        });
      } else if (job && job.status.toLowerCase() === 'completed') {
        items.push({
          ...base,
          addedAt: job.completedAt ?? completedAt,
          actionClass: 'retry_import',
          reason: 'Download finished, LazyLibrarian has not imported it',
          removable: true,
        });
      } else if (job) {
        // SABnzbd is still post-processing it (Verifying, Repairing, Extracting…): in flight.
        items.push({ ...base, addedAt: null, actionClass: 'unknown', reason: null, removable: true });
      } else {
        items.push({
          ...base,
          addedAt: null,
          actionClass: 'unknown',
          reason: 'Not in SABnzbd, LazyLibrarian aborts the snatch itself',
          removable: false,
        });
      }
      continue;
    }
    if (row.source === 'qbittorrent' && completedAt !== null) {
      items.push({
        ...base,
        addedAt: completedAt,
        actionClass: 'retry_import',
        reason: 'Torrent finished, LazyLibrarian has not imported it',
        removable: false,
      });
      continue;
    }
    items.push({ ...base, addedAt: null, actionClass: 'unknown', reason: null, removable: false });
  }

  // 2. Leftovers.
  if (input.leftovers !== null) {
    const rowsByDownload = new Map<string, LlHistoryEntry[]>();
    for (const row of input.history) {
      const id = nonEmpty(row.downloadId);
      if (id === null) continue;
      const list = rowsByDownload.get(id) ?? [];
      list.push(row);
      rowsByDownload.set(id, list);
    }
    for (const candidate of input.leftovers) {
      const { slot } = candidate;
      const rows = rowsByDownload.get(slot.nzoId) ?? [];
      const statuses = new Set(rows.map((r) => r.status.toLowerCase()));
      if (statuses.has('snatched')) continue; // population 1 has it
      const first = rows[0];
      const base = {
        queueItemId: null,
        itemRef: first ? llItemRef(first.bookId, first.format) : null,
        downloadId: slot.nzoId,
        title: nonEmpty(slot.name),
        addedAt: slot.completedAt,
        targetId: null,
        attempts: null,
        removable: true,
      };
      if (candidate.shared) {
        items.push({ ...base, actionClass: 'unknown', reason: 'Download folder named by more than one SABnzbd job' });
      } else if (rows.length === 0) {
        items.push({ ...base, actionClass: 'unknown', reason: 'Download folder with no LazyLibrarian record' });
      } else if ([...statuses].every((st) => st === 'processed')) {
        const allCopies =
          candidate.libraryCopies.length === rows.length && candidate.libraryCopies.every((c) => c.exists);
        const coverage = candidate.coverage ?? null;
        if (!allCopies) {
          items.push({
            ...base,
            actionClass: 'unknown',
            reason: 'Library copy not found at the recorded destination, the download folder may be the only copy',
          });
        } else if (coverage?.covered) {
          items.push({ ...base, actionClass: 'leftover', reason: 'Imported, the download folder is still in SABnzbd' });
        } else {
          // D-22: the copy exists but is not proven to hold this folder's book files. Report only, never deleted.
          items.push({
            ...base,
            actionClass: 'unknown',
            reason: LEFTOVER_COVERAGE_REASONS[coverage ? coverage.gap : 'not_compared'],
          });
        }
      } else if (statuses.has('failed')) {
        items.push({ ...base, actionClass: 'unknown', reason: 'Folder of a failed download left in SABnzbd' });
      } else {
        items.push({ ...base, actionClass: 'unknown', reason: `Download folder of a ${[...statuses].join('/')} grab` });
      }
    }
  }

  // 3. Fail loops.
  const failed = new Map<string, LlHistoryEntry[]>();
  for (const row of input.history) {
    if (row.status.toLowerCase() !== 'failed' || row.format === null || nonEmpty(row.bookId) === null) continue;
    const ref = llItemRef(row.bookId, row.format);
    const list = failed.get(ref) ?? [];
    list.push(row);
    failed.set(ref, list);
  }
  const loops: QueueCleanupSourceItem[] = [];
  for (const [ref, rows] of failed) {
    if (rows.length < FAIL_LOOP_MIN_FAILURES) continue;
    const { bookId, format } = rows[0]!;
    const book = input.books.get(bookId);
    const status = format === 'audiobook' ? book?.audioStatus : book?.ebookStatus;
    if ((status ?? '').toLowerCase() !== 'wanted') continue;
    // The most frequent failure; a tie goes to the most recent grab (rows are in log order, oldest first).
    const counts = new Map<string, { n: number; last: number }>();
    rows.forEach((r, i) => {
      const reason = normalizeLlFailure(r.dlResult) ?? 'No reason recorded';
      const c = counts.get(reason) ?? { n: 0, last: -1 };
      counts.set(reason, { n: c.n + 1, last: i });
    });
    const [reason] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)[0]!;
    const name = nonEmpty(book?.title) ?? nonEmpty(rows[rows.length - 1]!.title) ?? bookId;
    loops.push({
      queueItemId: null,
      itemRef: ref,
      downloadId: null,
      title: `${name} (${FORMAT_LABEL[format!]})`,
      addedAt: null,
      targetId: null,
      actionClass: 'fail_loop',
      reason,
      attempts: rows.length,
      removable: false,
    });
  }
  loops.sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0) || (a.itemRef ?? '').localeCompare(b.itemRef ?? ''));
  items.push(...loops);
  return items;
}

// ---------------------------------------------------------------------------
// LazyLibrarian (D-18) — the adapter.
// ---------------------------------------------------------------------------

export interface LazyLibrarianQueueCleanupClients {
  ll: Pick<LazyLibrarianReadClient, 'getHistory' | 'getAllBookStatuses'>;
  llWrite: Pick<LazyLibrarianWriteClient, 'forceProcess'>;
  sab: Pick<SabnzbdReadClient, 'getQueue' | 'listHistory'>;
  sabWrite: Pick<SabnzbdWriteClient, 'deleteHistoryJob'>;
  /** The leftover checks; absent or unavailable ⇒ no leftover census (D-18). */
  probe?: Pick<
    DownloadPathProbe,
    | 'available'
    | 'listDownloadFolders'
    | 'downloadFolderName'
    | 'downloadFolderExists'
    | 'libraryFileExists'
    | 'folderCoverage'
  >;
  cleaner?: Pick<DownloadFolderCleaner, 'removeFolder'>;
  /** LazyLibrarian's SABnzbd category (default `lazylibrarian`). */
  sabCategory?: string;
}

/** Where a leftover item's folder is and what the delete must re-check (kept beside the item, never persisted). */
interface LeftoverPlan {
  storage: string;
  libraryPaths: string[];
}

/** Read both SABnzbd history views (a job is in exactly one of them). */
async function sabHistoryBothViews(
  sab: LazyLibrarianQueueCleanupClients['sab'],
  query: { category?: string; status?: string; nzoIds?: string[] },
): Promise<SabJanitorHistorySlot[]> {
  const [live, archived] = await Promise.all([
    sab.listHistory({ ...query, archive: false }),
    sab.listHistory({ ...query, archive: true }),
  ]);
  return [...live, ...archived];
}

/**
 * Wire LazyLibrarian, SABnzbd and the mount checks into one source adapter (D-18). `observe` reads LazyLibrarian's
 * grab log and book list, SABnzbd's queue and the jobs of the Snatched rows (both history views), and, only when both
 * mounts are present, the whole LazyLibrarian category history of SABnzbd plus one listing of the download folder.
 * `act('bad_release')` deletes the SABnzbd job (LazyLibrarian then aborts the snatch); `act('leftover')` re-checks the
 * folder and every library copy, then deletes the folder. `retryImports` is `forceProcess`.
 */
export function buildLazyLibrarianQueueCleanupAdapter(
  clients: LazyLibrarianQueueCleanupClients,
): QueueCleanupSourceAdapter {
  const category = clients.sabCategory ?? LL_SAB_CATEGORY_DEFAULT;
  const plans = new WeakMap<QueueCleanupSourceItem, LeftoverPlan>();

  return {
    instance: 'lazylibrarian',

    async observe(ctx) {
      const [history, books, sabQueue] = await Promise.all([
        clients.ll.getHistory(),
        clients.ll.getAllBookStatuses(),
        clients.sab.getQueue(),
      ]);
      const snatchedIds = [
        ...new Set(
          history
            .filter((r) => r.status.toLowerCase() === 'snatched' && r.source === 'sabnzbd')
            .map((r) => nonEmpty(r.downloadId))
            .filter((id): id is string => id !== null),
        ),
      ];
      const sabJobs = snatchedIds.length > 0 ? await sabHistoryBothViews(clients.sab, { nzoIds: snatchedIds }) : [];

      let leftovers: LlLeftoverCandidate[] | null = null;
      const leftoverPaths = new Map<string, LeftoverPlan>();
      if (clients.probe && clients.cleaner && (await clients.probe.available())) {
        const [completed, live, folders] = await Promise.all([
          sabHistoryBothViews(clients.sab, { category, status: 'Completed' }),
          // Every live job, whatever its status (a job still post-processing may already own a folder name).
          clients.sab.listHistory({ archive: false, category }),
          clients.probe.listDownloadFolders(),
        ]);
        // Which jobs name each folder: SABnzbd reuses a name once its folder is gone, so an old archived job can point
        // at a newer download's folder. A folder named by more than one job is never a leftover.
        const claims = new Map<string, Set<string>>();
        for (const slot of [...completed, ...live]) {
          const name = clients.probe.downloadFolderName(slot.storage);
          if (name === null) continue;
          const set = claims.get(name) ?? new Set<string>();
          set.add(slot.nzoId);
          claims.set(name, set);
        }
        const rowsByDownload = new Map<string, LlHistoryEntry[]>();
        for (const row of history) {
          const id = nonEmpty(row.downloadId);
          if (id !== null) rowsByDownload.set(id, [...(rowsByDownload.get(id) ?? []), row]);
        }
        leftovers = [];
        const seen = new Set<string>();
        for (const slot of completed) {
          const name = clients.probe.downloadFolderName(slot.storage);
          if (name === null || !folders.has(name) || seen.has(slot.nzoId)) continue;
          seen.add(slot.nzoId);
          if (!(await clients.probe.downloadFolderExists(slot.storage))) continue;
          const rows = rowsByDownload.get(slot.nzoId) ?? [];
          const processed = rows.filter((r) => r.status.toLowerCase() === 'processed');
          const destination = (r: LlHistoryEntry) => r.destination ?? null;
          const libraryCopies: LlLeftoverCandidate['libraryCopies'] = [];
          for (const row of processed) {
            libraryCopies.push({
              path: destination(row),
              exists: await clients.probe.libraryFileExists(destination(row)),
            });
          }
          const shared = (claims.get(name)?.size ?? 0) > 1;
          // D-22: compare the folder's book files with the copies only when every other leftover test passed (the
          // walk costs one lstat per file, so a folder that cannot be a leftover anyway is not walked).
          const comparable =
            !shared && processed.length > 0 && processed.length === rows.length && libraryCopies.every((c) => c.exists);
          const coverage = comparable
            ? await clients.probe.folderCoverage(slot.storage, processed.map(destination))
            : null;
          leftovers.push({ slot, libraryCopies, shared, coverage });
          leftoverPaths.set(slot.nzoId, {
            storage: slot.storage!,
            libraryPaths: processed.map((r) => destination(r) ?? ''),
          });
        }
      } else {
        ctx?.logger?.info?.('queue-cleanup: leftover census off, the LazyLibrarian mounts are not present', {
          instance: 'lazylibrarian',
        });
      }

      const items = classifyLazyLibrarian({ history, books, sabQueue, sabJobs, leftovers });
      for (const item of items) {
        if (item.actionClass !== 'leftover' || item.downloadId === null) continue;
        const plan = leftoverPaths.get(item.downloadId);
        if (plan) plans.set(item, plan);
      }
      return items;
    },

    async act(actionClass, items) {
      const primary = items[0];
      const downloadId = nonEmpty(primary?.downloadId);
      if (!primary || downloadId === null) throw new Error('no download to act on');
      if (actionClass === 'bad_release') {
        // SABnzbd downloads only (the evaluator never sends a non-removable item). LazyLibrarian aborts the snatch
        // itself once SABnzbd no longer shows the job: no search here, LazyLibrarian wants the format again.
        await clients.sabWrite.deleteHistoryJob(downloadId);
        return { searched: [] };
      }
      // leftover — re-check the folder, every library copy and the content match in the same call, then delete.
      const plan = plans.get(primary);
      if (!plan || !clients.probe || !clients.cleaner) throw new Error('no leftover plan for this download');
      if (!(await clients.probe.downloadFolderExists(plan.storage))) {
        throw new QueueCleanupItemGoneError('download folder already gone');
      }
      for (const path of plan.libraryPaths) {
        if (!(await clients.probe.libraryFileExists(path))) {
          throw new Error('library copy no longer found at the recorded destination, folder kept');
        }
      }
      // D-22: a later grab can overwrite a destination between the census and the delete (the issue #621 shape), so
      // the folder's book files are compared with the copies again, in the same call as the delete.
      if (!(await clients.probe.folderCoverage(plan.storage, plan.libraryPaths)).covered) {
        throw new Error('library copy no longer matches the download folder, folder kept');
      }
      await clients.cleaner.removeFolder(plan.storage);
      return { searched: [] };
    },

    async retryImports() {
      await clients.llWrite.forceProcess();
    },
  };
}

// ---------------------------------------------------------------------------
// Kapowarr (D-19).
// ---------------------------------------------------------------------------

/**
 * Classify Kapowarr's queue (D-19). Pure. One item per queue entry: `failed` is `bad_release`; everything else is in
 * flight (`unknown`). Kapowarr drops a failed download from its queue and blocklists it itself, so a `failed` entry
 * that stays is stuck. Kapowarr gives no timestamp, so the age rail uses the janitor's own first sighting.
 */
export function classifyKapowarrQueue(entries: KapowarrQueueEntry[]): QueueCleanupSourceItem[] {
  return entries.map((e) => {
    const failed = e.status === 'failed';
    return {
      queueItemId: e.id,
      itemRef: null,
      // Kapowarr's queue id is a SQLite rowid, reused once the queue drains: the download is the id AND what it
      // fetches, so a reused id never inherits an old download's age or removals.
      downloadId:
        e.id != null ? `${e.id}|${e.volumeId ?? ''}|${e.issueId ?? ''}|${e.webLink ?? e.title ?? ''}` : null,
      title: nonEmpty(e.title),
      addedAt: null,
      targetId: e.volumeId,
      actionClass: failed ? 'bad_release' : 'unknown',
      reason: failed ? 'Download failed in Kapowarr' : null,
      attempts: null,
      removable: true,
    };
  });
}

export interface KapowarrQueueCleanupClients {
  read: Pick<KapowarrReadClient, 'getQueue' | 'getVolume'>;
  write: Pick<KapowarrWriteClient, 'deleteQueueItem' | 'searchVolume'>;
}

/**
 * Wire Kapowarr into one source adapter (D-19). `act('bad_release')` removes the queue entry with blocklist, then
 * searches its volume once (`auto_search`) while the volume is monitored and still missing issues. Calls stay sparse:
 * one removal and at most one search per download (Kapowarr's 429s are burst-rate).
 */
export function buildKapowarrQueueCleanupAdapter(clients: KapowarrQueueCleanupClients): QueueCleanupSourceAdapter {
  return {
    instance: 'kapowarr',
    async observe() {
      return classifyKapowarrQueue(await clients.read.getQueue());
    },
    async act(actionClass, items) {
      const primary = items[0];
      if (actionClass !== 'bad_release' || !primary || primary.queueItemId === null) {
        throw new Error(`kapowarr cannot act on ${actionClass} without a queue id`);
      }
      try {
        await clients.write.deleteQueueItem(primary.queueItemId, { blocklist: true });
      } catch (err) {
        if (err instanceof KapowarrHttpError && err.status === 404) {
          throw new QueueCleanupItemGoneError('Kapowarr no longer holds the download');
        }
        throw err;
      }
      try {
        const searched: QueueCleanupSourceItem[] = [];
        const volumes = [...new Set(items.map((i) => i.targetId).filter((v): v is number => v != null))];
        for (const volumeId of volumes) {
          const volume = await clients.read.getVolume(volumeId);
          if (!volume || !volume.monitored || volume.issuesDownloaded >= volume.issueCount) continue;
          await clients.write.searchVolume(volumeId);
          searched.push(...items.filter((i) => i.targetId === volumeId));
        }
        return { searched };
      } catch (err) {
        return { searched: [], followUpError: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The prod bundle (D-15) — built from env, inside @hnet/domain.
// ---------------------------------------------------------------------------

/** An adapter for a source whose env is missing: every read fails with the config error (the instance reports
 *  `read: false`, the run goes on). */
function unconfiguredAdapter(instance: QueueCleanupSourceInstance, error: unknown): QueueCleanupSourceAdapter {
  const message = error instanceof Error ? error.message : String(error);
  return {
    instance,
    observe: () => Promise.reject(new Error(`not configured: ${message}`)),
    act: () => Promise.reject(new Error(`not configured: ${message}`)),
  };
}

/**
 * Build the suite adapters from env (D-15): LazyLibrarian needs `LAZYLIBRARIAN_API_KEY` and `SABNZBD_API_KEY`, Kapowarr
 * `KAPOWARR_API_KEY` (URLs default to the in-cluster services). A missing key yields an adapter whose reads fail with
 * the config error, so the *arr instances still run. The leftover mounts are `JANITOR_LL_DOWNLOAD_ROOT` and
 * `JANITOR_LL_LIBRARY_ROOTS` (defaults: the live paths); absent mounts switch the leftover census off.
 */
export function queueCleanupSourceAdaptersFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<QueueCleanupSourceInstance, QueueCleanupSourceAdapter> {
  let lazylibrarian: QueueCleanupSourceAdapter;
  try {
    const ll = assertLazyLibrarianEnv(env);
    const sab = assertSabnzbdEnv(env);
    const paths = llJanitorPathsFromEnv(env);
    lazylibrarian = buildLazyLibrarianQueueCleanupAdapter({
      ll: new LazyLibrarianReadClient({ ...ll, timeoutMs: 60_000 }),
      llWrite: new LazyLibrarianWriteClient(ll),
      sab: new SabnzbdReadClient({ ...sab, timeoutMs: 60_000 }),
      sabWrite: new SabnzbdWriteClient(sab),
      probe: new DownloadPathProbe(paths),
      cleaner: new DownloadFolderCleaner(paths.downloadRoot),
      sabCategory: env.JANITOR_LL_SAB_CATEGORY?.trim() || LL_SAB_CATEGORY_DEFAULT,
    });
  } catch (err) {
    lazylibrarian = unconfiguredAdapter('lazylibrarian', err);
  }
  let kapowarr: QueueCleanupSourceAdapter;
  try {
    const k = assertKapowarrEnv(env);
    kapowarr = buildKapowarrQueueCleanupAdapter({
      read: new KapowarrReadClient(k),
      write: new KapowarrWriteClient(k),
    });
  } catch (err) {
    kapowarr = unconfiguredAdapter('kapowarr', err);
  }
  return { lazylibrarian, kapowarr };
}
