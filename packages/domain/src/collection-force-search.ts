// ADR-072 / DESIGN-043 D-14 · DESIGN-042 D-06/D-14 (PLAN-052 PR4c) — the CRON FORCE-SEARCH leg for the
// per-collection find-missing knob (books/audiobooks). When a Libretto-managed collection has acquisition
// turned ON (`variables.acquisitionEnabled` — flipped by setCollectionFindMissing behind the find_missing
// grant), the estate should actually PULL that collection's still-missing members, not just show them as
// Wanted tiles. This pass drives that acquisition through the app's OWN confined LazyLibrarian write client
// (the exact book-fix / recordManualSearch idiom: addBook → queueBook(format) → searchBook(format)) over the
// origin='collection' book_requests the collection-wants pass already minted (#394 — each carries a resolved
// llBookId when force-searchable). It is the app-side complement to Libretto's own apply/cron acquisition;
// Movies/TV need NOTHING here — Kometa's own `radarr_add_missing`/`sonarr_add_missing` + `_search` flags do
// the acquisition on its scheduled runs (the app only compiles the flag on — DESIGN-042 D-06).
//
// Runs INSIDE the `books-collections-sync` mode AFTER the wants pass (so the origin='collection' wants +
// their llBookId are fresh), driven with an injected Libretto READ client + the confined LazyLibrarian
// bundle (tests stub both; prod builds them from env). SINGLE-WRITER + AUDIT: each force-search stamps
// last_searched_at and co-writes a `request_book_search` permission_audit row in ONE tx (hard rule 6);
// IDEMPOTENT: a cooldown window on last_searched_at means a want is not re-searched every run, and a global
// per-run cap bounds the LazyLibrarian fan-out. DEGRADING: a Libretto outage skips the whole pass (we never
// acquire against a find-missing set we could not re-confirm); a single want's LL error fails only that want.
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import {
  bookRequests,
  booksCollections,
  permissionAudit,
  type BookRequestStatus,
  type DbClient,
} from '@hnet/db';
import type { LibrettoReadClient } from '@hnet/libretto/read';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { loadParkedWantRefs, loadResolvedWantRefs, resolveMissingMembers } from './collection-wants-sync';
import {
  llFormatAlreadyHeld,
  llRecentSearchCovers,
  parkCollectionWant,
  recentlySearchedLlBookIds,
  syncCollectionWants,
} from './book-requests';
import { llBookMismatch } from './ll-book-check';
import { isForeignLanguage } from './book-language';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import {
  applyLlGoneDecision,
  decideLlGoneWant,
  emptyLlGoneTally,
  emptyLlRerequestTally,
  LL_GONE_COLLECTION_GRACE_MS,
  llSnapshotUsable,
  LlRekeyIndex,
  llRerequestOpen,
  peoplesRerequestsWaiting,
  runLlRerequests,
  type LlGoneTally,
  type LlRerequestTally,
  type LlSnapshotRow,
} from './ll-gone';

/** The Libretto read surface this pass needs — just the recipe list (which carries acquisitionEnabled). */
export type FindMissingLibretto = Pick<LibrettoReadClient, 'listRecipes'>;

/** Owner-tunable per-run bound on the LazyLibrarian force-search fan-out (politeness — env-tunable). */
export const COLLECTION_FORCE_SEARCH_CAP_PER_RUN = Number(
  process.env.COLLECTION_FORCE_SEARCH_CAP_PER_RUN ?? 25,
);
/** A want force-searched within this window is skipped (no re-churn every run) — 12h default, env-tunable. */
export const COLLECTION_FORCE_SEARCH_COOLDOWN_MS = Number(
  process.env.COLLECTION_FORCE_SEARCH_COOLDOWN_MS ?? 12 * 60 * 60 * 1000,
);

export interface ForceSearchCollectionsInput {
  db?: DbClient;
  /** The Libretto READ client (env-built in prod; stubbed in tests) — lists recipes to find acquisition ON. */
  libretto: FindMissingLibretto;
  /** The confined LazyLibrarian bundle (addBook/queueBook/searchBook). Absent ⇒ the caller skips this pass. */
  ll: LazyLibrarianClientBundle;
  /** Per-run force-search cap (default COLLECTION_FORCE_SEARCH_CAP_PER_RUN). */
  cap?: number;
  /** Cooldown window in ms (default COLLECTION_FORCE_SEARCH_COOLDOWN_MS). */
  cooldownMs?: number;
  now?: Date;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Injectable pacer (tests pass a no-op; prod paces 250ms between LL calls). */
  pacer?: (index: number) => Promise<void>;
}

export interface ForceSearchCollectionsReport extends LlGoneTally, LlRerequestTally {
  /** Find-missing (acquisition ON) collections that have a mirror row this run. */
  findMissingCollections: number;
  /** Searchable, cooldown-eligible wants found across those collections (pre-cap). */
  candidates: number;
  /** Wants this run actually force-searched (≤ cap). */
  searched: number;
  /** Wants whose LazyLibrarian force-search failed (logged; left for the next run). */
  failed: number;
  /**
   * ADR-055 amendment (2026-09-22 — the LL push guard) — wants SUPPRESSED because LazyLibrarian already
   * holds that format. They are NOT searched and NOT failed; `last_searched_at` is still stamped (they are
   * done, not pending) so the cooldown keeps them out of the next run instead of re-checking hourly.
   */
  skippedHeld: number;
  /**
   * Issue #644 — wants whose search was SKIPPED because another job searched the book within the hour and
   * LazyLibrarian already shows the format as Wanted. Stamped (cooldown) but not audited, not `searched`.
   */
  skippedRecent: number;
  /**
   * Issue #693 — wants PARKED (`wrong_volume`, id cleared) instead of searched, because LazyLibrarian holds their
   * book as another volume or work than the member (`llBookMismatch`). No LazyLibrarian write for them.
   */
  parkedWrongVolume: number;
  /** Issue #719 — wants SUPPRESSED because LazyLibrarian labels their book non-English (the English-edition pass takes them). */
  skippedForeign: number;
  /** True when Libretto was unreachable — the whole pass was skipped. */
  unreachable: boolean;
}

const defaultPacer = (index: number): Promise<void> =>
  index === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, 250));

/** The LazyLibrarian format a collection's wants search on: audiobookshelf ⇒ audiobook, else ebook. */
function formatForSource(source: string): 'ebook' | 'audiobook' {
  return source === 'audiobookshelf' ? 'audiobook' : 'ebook';
}

/** One force-searchable want gathered off a collection's origin='collection' book_requests. */
interface CollectionWantWork {
  id: string;
  llBookId: string;
  format: 'ebook' | 'audiobook';
  title: string;
  /** The member's author (issue #693: read by the volume check before any LazyLibrarian write). */
  author: string | null;
  collectionId: string;
  /** The active format's status. Issue #665: an on-demand search lifts a settled `missing` back to `requested`. */
  status: BookRequestStatus;
}

/**
 * Gather the FORCE-SEARCHABLE, cap-bounded wants across the given collections. A want qualifies when it is an
 * unheld, routable, resolved (has an llBookId) origin='collection' request whose active format is not yet
 * `landed`. `cutoff` is the idempotency window: a Date filters out wants force-searched more recently than it
 * (the cron cooldown); `null` bypasses the cooldown entirely (the on-demand path — the caller asked for it NOW).
 * The global `cap` bounds the LazyLibrarian fan-out either way.
 */
async function gatherCollectionWants(
  db: DbClient | undefined,
  collections: ReadonlyArray<{ id: string; source: string }>,
  cap: number,
  cutoff: Date | null,
): Promise<CollectionWantWork[]> {
  const worklist: CollectionWantWork[] = [];
  for (const collection of collections) {
    if (worklist.length >= cap) break;
    const format = formatForSource(collection.source);
    const statusCol = format === 'audiobook' ? bookRequests.audioStatus : bookRequests.ebookStatus;
    const conds: SQL[] = [
      eq(bookRequests.origin, 'collection'),
      eq(bookRequests.collectionId, collection.id),
      isNull(bookRequests.matchedBooksItemId),
      isNull(bookRequests.unroutableReason),
      // Force-searchable only once resolved to an LL id (the wants pass sets it opportunistically).
      ne(statusCol, 'landed'),
    ];
    // The cooldown filter — only the cron pass applies it; on-demand (cutoff=null) re-searches regardless.
    // Issue #665: the cron also leaves a want settled `missing` (LazyLibrarian lost its book) alone; only a
    // person's on-demand Force Search re-adds it.
    if (cutoff) {
      conds.push(or(isNull(bookRequests.lastSearchedAt), lt(bookRequests.lastSearchedAt, cutoff))!);
      conds.push(ne(statusCol, 'missing'));
    }
    const rows = await resolveDb(db)
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        title: bookRequests.title,
        author: bookRequests.author,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
      })
      .from(bookRequests)
      .where(and(...conds))
      .orderBy(asc(bookRequests.lastSearchedAt), asc(bookRequests.createdAt))
      .limit(cap - worklist.length);
    for (const r of rows) {
      if (!r.llBookId) continue; // unresolved this run — a visible tile, not yet force-searchable
      worklist.push({
        id: r.id,
        llBookId: r.llBookId,
        format,
        title: r.title,
        author: r.author,
        collectionId: collection.id,
        status: format === 'audiobook' ? r.audioStatus : r.ebookStatus,
      });
    }
  }
  return worklist;
}

/**
 * Drive the confined LazyLibrarian force-search chain (addBook→queueBook→searchBook — the exact book-fix
 * idiom) over a worklist, stamping `last_searched_at` + a `request_book_search` audit in ONE tx per want
 * (hard rule 6). Shared by the cron leg (`actorId: null`, `via: 'find_missing_cron'`) and the on-demand
 * collection Force Search (`actorId`/`subjectUserId` = the caller, `via: 'collection_force_search'`, tagging
 * the single collection). Never throws for a single want's LL error (logged + counted into `report.failed`);
 * only a DB failure propagates.
 */
async function runForceSearchWorklist(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  worklist: ReadonlyArray<CollectionWantWork>;
  now: Date;
  pace: (index: number) => Promise<void>;
  via: 'find_missing_cron' | 'collection_force_search';
  actorId: string | null;
  subjectUserId?: string | null;
  /** Tag the audit with the single collection (on-demand path); omitted for the multi-collection cron leg. */
  tagCollection?: boolean;
  /** The `getAllBooks` snapshot the caller already read this run (the cron's gone pass), so it is not read twice. */
  snapshot?: Map<string, LlSnapshotRow> | null;
  report: {
    searched: number;
    failed: number;
    skippedHeld: number;
    skippedRecent: number;
    parkedWrongVolume: number;
    skippedForeign: number;
  };
  log: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<void> {
  // ADR-055 amendment (2026-09-22 — the LL push guard). ONE `getAllBooks` for the whole worklist (≤ cap),
  // taken before the first write. This pass is the most exposed of all the push sites: it is unattended,
  // hourly, and its "still missing" test is OUR row's status (`ne(statusCol,'landed')`), which says nothing
  // about what LazyLibrarian holds — so a want whose copy LL imported but whose row never reconciled was
  // re-clobbered to `Wanted` every 12h, forever. On a read failure the map is empty and every want pushes,
  // exactly as before: the guard may suppress a write, never invent one.
  let held: Map<string, LlSnapshotRow> = input.snapshot ?? new Map<string, LlSnapshotRow>();
  if (input.worklist.length > 0 && input.snapshot == null) {
    try {
      held = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      input.log.warn?.(
        'collection-force-search: LL getAllBooks failed — push guard degraded to search-everything',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // ONE LazyLibrarian searchBook per book per run (issue #644). LL's `searchBook` ignores its `type`
  // parameter (`api.py::_searchbook` only logs it) and searches EVERY format of the book that is `Wanted`,
  // so the worklist rows for one llBookId — an ebook and an audiobook collection both holding the book, or
  // the book in two collections — must share a single call. Rows stay per collection and format (each keeps
  // its own cooldown stamp and audit row); only the LL chain is shared. First-seen order is preserved.
  const groups = new Map<string, CollectionWantWork[]>();
  for (const want of input.worklist) {
    const group = groups.get(want.llBookId);
    if (group) group.push(want);
    else groups.set(want.llBookId, [want]);
  }

  // Cross-JOB leg (cron only — an on-demand click asked for the search NOW and always fires): a book another
  // job (goodreads-sync, format-pairing) searched within the hour, with every format we would search already
  // `Wanted` in LL, was covered by that search — queueBook still runs, only the searchBook is skipped.
  const recent =
    input.via === 'find_missing_cron' && groups.size > 0
      ? await recentlySearchedLlBookIds(input.db, input.now)
      : new Set<string>();

  let i = 0;
  for (const [llBookId, wants] of groups) {
    const toSearch: CollectionWantWork[] = [];
    for (const want of wants) {
      // Issue #693 — never queue a book LazyLibrarian holds as another volume or work than the member: the "BBC Radio
      // Drama Collection" want queued "Terry Pratchett's Discworld" and LazyLibrarian took 32 Discworld releases for it.
      // The want is parked instead (id cleared), so no job pushes that book for it again.
      const mismatch = llBookMismatch(want, held.get(llBookId));
      if (mismatch) {
        if (await parkCollectionWant({ db: input.db, requestId: want.id, llBookId, now: input.now })) {
          input.report.parkedWrongVolume += 1;
        }
        input.log.warn?.('ll_push_skipped_wrong_volume', {
          site: `collection-force-search.${input.via}`,
          requestId: want.id,
          llBookId,
          title: want.title,
          llTitle: held.get(llBookId)?.title ?? null,
          reason: mismatch,
        });
        continue;
      }
      // Issue #719 — never queue a book LazyLibrarian labels non-English (the F10 rule). The want is left as it is: the
      // English-edition pass (goodreads-sync) switches it to an English edition or parks it. `last_searched_at` is
      // stamped (no audit: nothing was asked of LazyLibrarian) so the cooldown keeps it out of the next run's worklist.
      if (isForeignLanguage(held.get(llBookId)?.language)) {
        input.report.skippedForeign += 1;
        input.log.info?.('ll_push_skipped_foreign', {
          site: `collection-force-search.${input.via}`,
          requestId: want.id,
          llBookId,
          formats: [want.format],
          title: want.title,
          llLanguage: held.get(llBookId)?.language ?? null,
        });
        await inTransaction(input.db, async (tx) => {
          await tx
            .update(bookRequests)
            .set({ lastSearchedAt: input.now, updatedAt: input.now })
            .where(eq(bookRequests.id, want.id));
        });
        continue;
      }
      if (llFormatAlreadyHeld(held.get(llBookId), want.format)) {
        input.report.skippedHeld += 1;
        input.log.info?.('ll_push_skipped_have', {
          site: `collection-force-search.${input.via}`,
          requestId: want.id,
          llBookId,
          formats: [want.format],
          title: want.title,
        });
        // Stamp last_searched_at anyway (no audit — nothing was requested of LL). The want is settled on
        // LL's side, so the 12h cooldown should keep it out of the next run rather than re-reading it hourly.
        await inTransaction(input.db, async (tx) => {
          await tx
            .update(bookRequests)
            .set({ lastSearchedAt: input.now, updatedAt: input.now })
            .where(eq(bookRequests.id, want.id));
        });
      } else {
        toSearch.push(want);
      }
    }
    if (toSearch.length === 0) continue;
    await input.pace(i);
    i += 1;
    try {
      // The confined LazyLibrarian force-search chain — MANDATORY queueBook after addBook (else Skipped).
      // addBook once, queueBook once per distinct format, then the single searchBook that covers them all.
      const formats = [...new Set(toSearch.map((w) => w.format))];
      // DESIGN-039 D-18, now here too (issue #665): addBook ONLY seats a book LazyLibrarian does not hold. On a
      // book it holds, `add_bookid_to_db` re-runs its upsert, which resets BOTH formats to the new-book status
      // (`Skipped`): the other format's `Wanted` is dropped and its import status overwritten. A failed read
      // leaves `held` empty, so this degrades to the old always-addBook.
      if (held.get(llBookId) == null) await input.ll.write.addBook(llBookId);
      for (const format of formats) await input.ll.write.queueBook(llBookId, format);
      const coveredByRecent = llRecentSearchCovers(recent, llBookId, held.get(llBookId), formats);
      if (!coveredByRecent) await input.ll.write.searchBook(llBookId, formats[0]!);
      else {
        input.log.info?.('ll_search_skipped_covered', {
          site: `collection-force-search.${input.via}`,
          llBookId,
          requestIds: toSearch.map((w) => w.id),
          formats,
        });
      }
      // Stamp last_searched_at + audit EVERY row the call covered, in ONE tx (hard rule 6). A search another
      // job already ran covers these rows: they are stamped (the cooldown settles them) but NOT audited
      // and NOT counted as searched — nothing was asked of LazyLibrarian by this pass.
      await inTransaction(input.db, async (tx) => {
        for (const want of toSearch) {
          // A want settled `missing` (issue #665: LazyLibrarian lost its book) that a person force-searched is
          // back in LazyLibrarian: its active format returns to `requested`, the collection want's working state.
          const lift =
            want.status === 'missing'
              ? want.format === 'audiobook'
                ? { audioStatus: 'requested' as const }
                : { ebookStatus: 'requested' as const }
              : {};
          await tx
            .update(bookRequests)
            .set({ lastSearchedAt: input.now, updatedAt: input.now, ...lift })
            .where(eq(bookRequests.id, want.id));
          if (coveredByRecent) continue;
          await tx.insert(permissionAudit).values({
            actorId: input.actorId,
            ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
            action: 'request_book_search',
            detail: {
              request_id: want.id,
              ll_book_id: want.llBookId,
              title: want.title,
              format: want.format,
              origin: 'collection',
              ...(input.tagCollection ? { collection_id: want.collectionId } : {}),
              via: input.via,
            },
          });
        }
      });
      if (coveredByRecent) input.report.skippedRecent += toSearch.length;
      else input.report.searched += toSearch.length;
    } catch (error) {
      input.report.failed += toSearch.length;
      input.log.warn?.(
        'collection-force-search: LazyLibrarian force-search failed (left for next run)',
        {
          requestIds: toSearch.map((w) => w.id),
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

/**
 * Drive the app-side acquisition for every find-missing (acquisition ON) Libretto collection. See the file
 * header for the degradation + idempotency contract. Never throws for a single want's LazyLibrarian error
 * (logged + counted); only a DB failure propagates.
 */
export async function forceSearchFindMissingCollections(
  input: ForceSearchCollectionsInput,
): Promise<ForceSearchCollectionsReport> {
  const now = input.now ?? new Date();
  const cap = input.cap ?? COLLECTION_FORCE_SEARCH_CAP_PER_RUN;
  const cooldownMs = input.cooldownMs ?? COLLECTION_FORCE_SEARCH_COOLDOWN_MS;
  const pace = input.pacer ?? defaultPacer;
  const log = input.logger ?? {};
  const report: ForceSearchCollectionsReport = {
    findMissingCollections: 0,
    candidates: 0,
    searched: 0,
    failed: 0,
    skippedHeld: 0,
    skippedRecent: 0,
    parkedWrongVolume: 0,
    skippedForeign: 0,
    unreachable: false,
    ...emptyLlGoneTally(),
    ...emptyLlRerequestTally(),
  };

  // Which Libretto recipes have acquisition turned ON? (A Libretto outage skips the whole pass.)
  let acquisitionRecipeIds: Set<string>;
  try {
    const { recipes } = await input.libretto.listRecipes();
    acquisitionRecipeIds = new Set(
      recipes.filter((r) => r.variables?.acquisitionEnabled === true).map((r) => r.id),
    );
  } catch (error) {
    if (error instanceof LibrettoUnreachableError) {
      report.unreachable = true;
      log.warn?.('collection-force-search: Libretto unreachable — pass skipped', {
        error: error.message,
      });
      return report;
    }
    throw error;
  }
  if (acquisitionRecipeIds.size === 0) return report;

  // The mirror collections bound to those recipes (only Libretto-produced ones carry a recipe id).
  const collections = (
    await resolveDb(input.db)
      .select({
        id: booksCollections.id,
        source: booksCollections.source,
        recipeId: booksCollections.librettoRecipeId,
      })
      .from(booksCollections)
  ).filter((c) => c.recipeId && acquisitionRecipeIds.has(c.recipeId));
  report.findMissingCollections = collections.length;
  if (collections.length === 0) return report;

  // Issue #665 — settle the wants whose LazyLibrarian book is gone BEFORE gathering, across every find-missing
  // collection regardless of cooldown (so the backlog settles on the first run, not as each want comes due).
  const snapshot = await settleGoneCollectionWants({
    db: input.db,
    ll: input.ll,
    collectionIds: collections.map((c) => c.id),
    now,
    cooldownMs,
    report,
    log,
  });
  // Issue #668 — the one re-request of a settled want: addBook + queueBook, no search (LazyLibrarian's daily backlog
  // search looks for it). It stamps `last_searched_at`, so the gather below leaves it to that daily search.
  const rerequestSnapshot = await rerequestGoneCollectionWants({
    db: input.db,
    ll: input.ll,
    collectionIds: collections.map((c) => c.id),
    now,
    snapshot,
    pace,
    report,
    log,
  });

  const cutoff = new Date(now.getTime() - cooldownMs);
  // Gather the searchable, cooldown-eligible wants across every find-missing collection (global cap).
  const worklist = await gatherCollectionWants(input.db, collections, cap, cutoff);
  report.candidates = worklist.length;
  if (worklist.length === 0) {
    if (
      report.llGoneRekeyed +
        report.llGoneSettled +
        report.llRerequested +
        report.llRerequestLanded +
        report.llRerequestNotAdded +
        report.llRerequestDeferred >
      0
    ) {
      log.info?.('collection-force-search complete', { ...report });
    }
    return report;
  }

  // Ownerless system leg ⇒ actor/subject null; no per-collection tag (one worklist spans many collections).
  await runForceSearchWorklist({
    db: input.db,
    ll: input.ll,
    worklist,
    now,
    pace,
    via: 'find_missing_cron',
    actorId: null,
    report,
    log,
    ...(rerequestSnapshot ? { snapshot: rerequestSnapshot } : {}),
  });

  log.info?.('collection-force-search complete', {
    findMissingCollections: report.findMissingCollections,
    candidates: report.candidates,
    searched: report.searched,
    failed: report.failed,
    skippedHeld: report.skippedHeld,
    skippedRecent: report.skippedRecent,
    parkedWrongVolume: report.parkedWrongVolume,
    skippedForeign: report.skippedForeign,
    llGoneRekeyed: report.llGoneRekeyed,
    llGoneSettled: report.llGoneSettled,
    llRerequested: report.llRerequested,
    llRerequestLanded: report.llRerequestLanded,
    llRerequestNotAdded: report.llRerequestNotAdded,
    llRerequestDeferred: report.llRerequestDeferred,
  });
  return report;
}

/**
 * Issue #668 (DESIGN-028 amendment 2026-10-04, the owner ruling) — the collection leg of the one re-request. A
 * collection want of a find-missing collection whose active format was settled `missing` (its LazyLibrarian book is
 * gone) and that was never re-requested is handed back to LazyLibrarian by `runLlRerequests` (addBook + queueBook, no
 * search), with `last_searched_at` stamped so this pass's gather does not also search it. A format LazyLibrarian
 * holds under another id for the same title and author lands instead. Libretto decides whether the LIBRARY holds a
 * member: a held member's want is dropped by the wants pass, so a want still here is missing from the library. Reads
 * the snapshot only when a candidate exists and none was read yet; returns it.
 */
async function rerequestGoneCollectionWants(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  collectionIds: string[];
  now: Date;
  snapshot: Map<string, LlSnapshotRow> | null;
  pace: (index: number) => Promise<void>;
  report: LlRerequestTally;
  log: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<Map<string, LlSnapshotRow> | null> {
  if (input.collectionIds.length === 0) return input.snapshot;
  const candidates = (
    await resolveDb(input.db)
      .select({ want: bookRequests, source: booksCollections.source })
      .from(bookRequests)
      .innerJoin(booksCollections, eq(booksCollections.id, bookRequests.collectionId))
      .where(
        and(
          eq(bookRequests.origin, 'collection'),
          inArray(bookRequests.collectionId, input.collectionIds),
          isNull(bookRequests.matchedBooksItemId),
          isNull(bookRequests.unroutableReason),
          llRerequestOpen(input.now),
          isNotNull(bookRequests.llBookId),
        ),
      )
      .orderBy(asc(bookRequests.llRerequestFailures), asc(bookRequests.createdAt), asc(bookRequests.id))
  ).filter(({ want, source }) => {
    const status = formatForSource(source) === 'audiobook' ? want.audioStatus : want.ebookStatus;
    return status === 'missing';
  });
  if (candidates.length === 0) return input.snapshot;
  let snapshot = input.snapshot;
  if (snapshot == null) {
    try {
      snapshot = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      input.log.warn?.('collection-force-search: LL getAllBooks failed — re-request pass skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (!llSnapshotUsable(snapshot)) return snapshot;
  const tally = await runLlRerequests({
    db: input.db,
    ll: input.ll,
    candidates: candidates.map(({ want, source }) => ({
      want,
      formats: [formatForSource(source)],
      collection: true,
    })),
    snapshot,
    now: input.now,
    site: 'collection-force-search.rerequest',
    deferAdds: await peoplesRerequestsWaiting(input.db, snapshot, input.now),
    pace: input.pace,
    log: { info: input.log.info, error: input.log.warn },
  });
  input.report.llRerequested += tally.llRerequested;
  input.report.llRerequestLanded += tally.llRerequestLanded;
  input.report.llRerequestNotAdded += tally.llRerequestNotAdded;
  input.report.llRerequestDeferred += tally.llRerequestDeferred;
  return snapshot;
}

/**
 * Issue #665 (DESIGN-028 amendment 2026-10-04) — the collection leg of the gone-book rule. A collection want the
 * cron force-searched (`last_searched_at` set, older than the collection grace: 1 h, and never more than half the
 * cooldown, since each due re-search re-stamps it) whose id the `getAllBooks` snapshot lacks
 * lost its LazyLibrarian book: LazyLibrarian deleted it, or never kept it (`addBook` declined). Re-adding it every
 * cooldown is the churn this stops. It is re-keyed (repointed to the one row LazyLibrarian holds for the same
 * title and author; the next due run pushes that) or settled: its active format becomes `missing`, which the cron
 * gather skips and a person's on-demand Force Search lifts. No LazyLibrarian write. The snapshot is read only when
 * a candidate exists and is returned for the worklist (one `getAllBooks` per run, not two); null when there was no
 * read or it failed.
 */
async function settleGoneCollectionWants(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  collectionIds: string[];
  now: Date;
  cooldownMs: number;
  report: LlGoneTally;
  log: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<Map<string, LlSnapshotRow> | null> {
  if (input.collectionIds.length === 0) return null;
  // The collection grace, NOT the 24 h one: every cooldown the cron re-stamps `last_searched_at`, so the grace
  // must be shorter than the cooldown or a lost book is re-added before it can ever count as gone.
  const graceMs = Math.min(LL_GONE_COLLECTION_GRACE_MS, input.cooldownMs / 2);
  const graceCutoff = new Date(input.now.getTime() - graceMs);
  const candidates = await resolveDb(input.db)
    .select({
      id: bookRequests.id,
      llBookId: bookRequests.llBookId,
      title: bookRequests.title,
      author: bookRequests.author,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      lastSearchedAt: bookRequests.lastSearchedAt,
      source: booksCollections.source,
    })
    .from(bookRequests)
    .innerJoin(booksCollections, eq(booksCollections.id, bookRequests.collectionId))
    .where(
      and(
        eq(bookRequests.origin, 'collection'),
        inArray(bookRequests.collectionId, input.collectionIds),
        isNull(bookRequests.matchedBooksItemId),
        isNull(bookRequests.unroutableReason),
        isNotNull(bookRequests.llBookId),
        isNotNull(bookRequests.lastSearchedAt),
        lt(bookRequests.lastSearchedAt, graceCutoff),
      ),
    );
  // Only wants whose active format is still being acquired (not landed, not already settled).
  const open = candidates.filter((c) => {
    const status = formatForSource(c.source) === 'audiobook' ? c.audioStatus : c.ebookStatus;
    return status !== 'landed' && status !== 'missing';
  });
  if (open.length === 0) return null;

  let snapshot: Map<string, LlSnapshotRow>;
  try {
    snapshot = await input.ll.read.getAllBookStatuses();
  } catch (error) {
    input.log.warn?.('collection-force-search: LL getAllBooks failed — gone-book pass skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!llSnapshotUsable(snapshot)) return snapshot;
  const index = new LlRekeyIndex(snapshot);
  for (const want of open) {
    if (snapshot.has(want.llBookId!)) continue;
    try {
      await applyLlGoneDecision({
        db: input.db,
        requestId: want.id,
        llBookId: want.llBookId!,
        decision: decideLlGoneWant({
          want: { ...want, lastSeenAt: want.lastSearchedAt },
          snapshot,
          index,
          now: input.now,
          formats: [formatForSource(want.source)],
          collection: true,
          graceMs,
        }),
        snapshot,
        reconcile: false,
        tally: input.report,
        site: 'collection-force-search.find_missing_cron',
        now: input.now,
        log: input.log,
      });
    } catch (error) {
      input.log.warn?.('collection-force-search: gone-book settle failed', {
        requestId: want.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return snapshot;
}

// ── The ON-DEMAND collection Force Search (owner ruling 2026-07-18) ───────────────────────────────────
// The /collections Books/Audiobooks rows replace the retired "Run now" with the estate-standard Force Search
// (ADR-071 <MediaAction action="forceSearch">). One honest whole action, composed server-side in order:
//   (a) RE-APPLY the recipe (the old applyScope) so the collection's membership is fresh;
//   (b) REFRESH the collection's missing-member wants (the #394 mint — listMissingMembers → resolve →
//       syncCollectionWants), so the searchable set + their llBookIds are current;
//   (c) FORCE-SEARCH the resolved missing members NOW through the confined LazyLibrarian chain — the SAME
//       PR4c leg, run on demand: the 12h cron cooldown is BYPASSED (the caller asked for it now) but the
//       per-call cap still bounds the fan-out.
// Grant-gated at the API by the books Force Search grant (`force_search_book`); this domain trusts the gate.
// Single-writer + audit: each search stamps last_searched_at + a `request_book_search` row (via
// 'collection_force_search', tagged with the collection) in ONE tx (hard rule 6). Movies/TV never reach here
// (Kometa's own cron does acquisition — no app-side on-demand path). A Libretto outage degrades honestly.

export interface ForceSearchCollectionNowInput {
  db?: DbClient;
  /** The confined Libretto surface: applyScope (re-apply) + listMissingMembers/resolve (re-mint the wants). */
  libretto: {
    read: Pick<LibrettoReadClient, 'listMissingMembers' | 'resolve'>;
    write: { applyScope: (scope: string) => Promise<string> };
  };
  /** The confined LazyLibrarian bundle (addBook/queueBook/searchBook). */
  ll: LazyLibrarianClientBundle;
  /** The Libretto recipe id whose bound mirror collection to force-search. */
  recipeId: string;
  /** The caller — audited as actor + subject of every search. */
  actorId: string;
  /** Per-call force-search cap (default COLLECTION_FORCE_SEARCH_CAP_PER_RUN). Cooldown is always bypassed. */
  cap?: number;
  now?: Date;
  pacer?: (index: number) => Promise<void>;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface ForceSearchCollectionNowReport {
  /** The Libretto apply run id (poll getCollectionRun for its live counts); null if apply yielded none. */
  runId: string | null;
  /** Wants minted / reconciled-away by the refresh (the #394 mint for this one collection). */
  minted: number;
  removed: number;
  /** Resolved, searchable wants this call force-searched against (pre-cap gathering already applied). */
  candidates: number;
  /** Wants this call actually force-searched (≤ cap). */
  searched: number;
  /** Wants whose LazyLibrarian force-search failed (logged; left for the next run). */
  failed: number;
  /** ADR-055 amendment (2026-09-22) — wants suppressed because LazyLibrarian already holds that format. */
  skippedHeld: number;
  /** Issue #644 — always 0 here: an on-demand click asked for the search now, so it never defers to a recent one. */
  skippedRecent: number;
  /** Issue #693 — wants parked (`wrong_volume`) because LazyLibrarian holds their book as another volume or work. */
  parkedWrongVolume: number;
  /** Issue #719 — wants suppressed because LazyLibrarian labels their book non-English (the English-edition pass takes them). */
  skippedForeign: number;
  /** True when Libretto was unreachable — the apply/refresh could not run, so nothing was searched. */
  unreachable: boolean;
}

/**
 * Fire an on-demand Force Search for one Libretto-managed (books/audiobooks) collection. See the section
 * header for the (a) apply → (b) refresh → (c) search contract. Throws NotFoundError when no mirror
 * collection is bound to the recipe; degrades (unreachable=true, nothing searched) on a Libretto outage;
 * never throws for a single want's LazyLibrarian error (counted into `failed`).
 */
export async function forceSearchCollectionNow(
  input: ForceSearchCollectionNowInput,
): Promise<ForceSearchCollectionNowReport> {
  const now = input.now ?? new Date();
  const cap = input.cap ?? COLLECTION_FORCE_SEARCH_CAP_PER_RUN;
  const pace = input.pacer ?? defaultPacer;
  const log = input.logger ?? {};
  const report: ForceSearchCollectionNowReport = {
    runId: null,
    minted: 0,
    removed: 0,
    candidates: 0,
    searched: 0,
    failed: 0,
    skippedHeld: 0,
    skippedRecent: 0,
    parkedWrongVolume: 0,
    skippedForeign: 0,
    unreachable: false,
  };

  // The mirror collection bound to this recipe (only Libretto-produced collections carry a recipe id).
  const [collection] = await resolveDb(input.db)
    .select({
      id: booksCollections.id,
      source: booksCollections.source,
      recipeId: booksCollections.librettoRecipeId,
    })
    .from(booksCollections)
    .where(eq(booksCollections.librettoRecipeId, input.recipeId))
    .limit(1);
  if (!collection || !collection.recipeId) {
    throw new NotFoundError(`No collection is bound to recipe "${input.recipeId}"`);
  }

  // (a) re-apply the recipe (fresh membership) + (b) refresh the missing-member wants. A Libretto outage
  // aborts BEFORE any search (we never force-search a missing set we could not re-confirm).
  try {
    report.runId = await input.libretto.write.applyScope(input.recipeId);
    const missing = await input.libretto.read.listMissingMembers(input.recipeId);
    // Quota thrift (shared with the hourly pass) — reuse already-resolved wants, don't re-spend GB on them.
    const resolvedRefs = await loadResolvedWantRefs(input.db, collection.id);
    const { members } = await resolveMissingMembers(
      input.libretto.read,
      missing.missing ?? [],
      resolvedRefs,
      await loadParkedWantRefs(input.db, collection.id),
    );
    const synced = await syncCollectionWants({
      db: input.db,
      collectionId: collection.id,
      format: formatForSource(collection.source),
      members,
      now,
    });
    report.minted = synced.minted;
    report.removed = synced.removed;
  } catch (error) {
    if (error instanceof LibrettoUnreachableError) {
      report.unreachable = true;
      log.warn?.('collection-force-search (on-demand): Libretto unreachable — nothing searched', {
        recipeId: input.recipeId,
        error: error.message,
      });
      return report;
    }
    throw error;
  }

  // (c) force-search this collection's resolved wants NOW — cooldown BYPASSED (cutoff=null), cap honored.
  const worklist = await gatherCollectionWants(input.db, [collection], cap, null);
  report.candidates = worklist.length;
  if (worklist.length === 0) return report;

  await runForceSearchWorklist({
    db: input.db,
    ll: input.ll,
    worklist,
    now,
    pace,
    via: 'collection_force_search',
    actorId: input.actorId,
    subjectUserId: input.actorId,
    tagCollection: true,
    report,
    log,
  });

  log.info?.('collection-force-search (on-demand) complete', {
    recipeId: input.recipeId,
    candidates: report.candidates,
    searched: report.searched,
    failed: report.failed,
  });
  return report;
}
