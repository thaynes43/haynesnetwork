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
import { and, asc, eq, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import { bookRequests, booksCollections, permissionAudit, type DbClient } from '@hnet/db';
import type { LibrettoReadClient } from '@hnet/libretto/read';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { resolveMissingMembers } from './collection-wants-sync';
import { syncCollectionWants } from './book-requests';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';

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

export interface ForceSearchCollectionsReport {
  /** Find-missing (acquisition ON) collections that have a mirror row this run. */
  findMissingCollections: number;
  /** Searchable, cooldown-eligible wants found across those collections (pre-cap). */
  candidates: number;
  /** Wants this run actually force-searched (≤ cap). */
  searched: number;
  /** Wants whose LazyLibrarian force-search failed (logged; left for the next run). */
  failed: number;
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
  collectionId: string;
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
    if (cutoff) {
      conds.push(or(isNull(bookRequests.lastSearchedAt), lt(bookRequests.lastSearchedAt, cutoff))!);
    }
    const rows = await resolveDb(db)
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        title: bookRequests.title,
      })
      .from(bookRequests)
      .where(and(...conds))
      .orderBy(asc(bookRequests.lastSearchedAt), asc(bookRequests.createdAt))
      .limit(cap - worklist.length);
    for (const r of rows) {
      if (!r.llBookId) continue; // unresolved this run — a visible tile, not yet force-searchable
      worklist.push({ id: r.id, llBookId: r.llBookId, format, title: r.title, collectionId: collection.id });
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
  report: { searched: number; failed: number };
  log: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<void> {
  for (let i = 0; i < input.worklist.length; i += 1) {
    const want = input.worklist[i]!;
    await input.pace(i);
    try {
      // The confined LazyLibrarian force-search chain — MANDATORY queueBook after addBook (else Skipped).
      await input.ll.write.addBook(want.llBookId);
      await input.ll.write.queueBook(want.llBookId, want.format);
      await input.ll.write.searchBook(want.llBookId, want.format);
      // Stamp last_searched_at + audit in ONE tx (hard rule 6).
      await inTransaction(input.db, async (tx) => {
        await tx
          .update(bookRequests)
          .set({ lastSearchedAt: input.now, updatedAt: input.now })
          .where(eq(bookRequests.id, want.id));
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
      });
      input.report.searched += 1;
    } catch (error) {
      input.report.failed += 1;
      input.log.warn?.('collection-force-search: LazyLibrarian force-search failed (left for next run)', {
        requestId: want.id,
        error: error instanceof Error ? error.message : String(error),
      });
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
    unreachable: false,
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

  const cutoff = new Date(now.getTime() - cooldownMs);
  // Gather the searchable, cooldown-eligible wants across every find-missing collection (global cap).
  const worklist = await gatherCollectionWants(input.db, collections, cap, cutoff);
  report.candidates = worklist.length;
  if (worklist.length === 0) return report;

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
  });

  log.info?.('collection-force-search complete', {
    findMissingCollections: report.findMissingCollections,
    candidates: report.candidates,
    searched: report.searched,
    failed: report.failed,
  });
  return report;
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
    const { members } = await resolveMissingMembers(input.libretto.read, missing.missing ?? []);
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
