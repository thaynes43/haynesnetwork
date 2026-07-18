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
import { and, asc, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { bookRequests, booksCollections, permissionAudit, type DbClient } from '@hnet/db';
import type { LibrettoReadClient } from '@hnet/libretto/read';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { inTransaction, resolveDb } from './db-client';
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
  const worklist: Array<{ id: string; llBookId: string; format: 'ebook' | 'audiobook'; title: string }> = [];
  for (const collection of collections) {
    if (worklist.length >= cap) break;
    const format = formatForSource(collection.source);
    const statusCol = format === 'audiobook' ? bookRequests.audioStatus : bookRequests.ebookStatus;
    const rows = await resolveDb(input.db)
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        title: bookRequests.title,
      })
      .from(bookRequests)
      .where(
        and(
          eq(bookRequests.origin, 'collection'),
          eq(bookRequests.collectionId, collection.id),
          isNull(bookRequests.matchedBooksItemId),
          isNull(bookRequests.unroutableReason),
          // Force-searchable only once resolved to an LL id (the wants pass sets it opportunistically).
          ne(statusCol, 'landed'),
          or(isNull(bookRequests.lastSearchedAt), lt(bookRequests.lastSearchedAt, cutoff)),
        ),
      )
      .orderBy(asc(bookRequests.lastSearchedAt), asc(bookRequests.createdAt))
      .limit(cap - worklist.length);
    for (const r of rows) {
      if (!r.llBookId) continue; // unresolved this run — a visible tile, not yet force-searchable
      worklist.push({ id: r.id, llBookId: r.llBookId, format, title: r.title });
    }
  }
  report.candidates = worklist.length;
  if (worklist.length === 0) return report;

  for (let i = 0; i < worklist.length; i += 1) {
    const want = worklist[i]!;
    await pace(i);
    try {
      // The confined LazyLibrarian force-search chain — MANDATORY queueBook after addBook (else Skipped).
      await input.ll.write.addBook(want.llBookId);
      await input.ll.write.queueBook(want.llBookId, want.format);
      await input.ll.write.searchBook(want.llBookId, want.format);
      // Stamp last_searched_at + audit in ONE tx (hard rule 6). Ownerless system want ⇒ actor/subject null.
      await inTransaction(input.db, async (tx) => {
        await tx
          .update(bookRequests)
          .set({ lastSearchedAt: now, updatedAt: now })
          .where(eq(bookRequests.id, want.id));
        await tx.insert(permissionAudit).values({
          actorId: null,
          action: 'request_book_search',
          detail: {
            request_id: want.id,
            ll_book_id: want.llBookId,
            title: want.title,
            format: want.format,
            origin: 'collection',
            via: 'find_missing_cron',
          },
        });
      });
      report.searched += 1;
    } catch (error) {
      report.failed += 1;
      log.warn?.('collection-force-search: LazyLibrarian force-search failed (left for next run)', {
        requestId: want.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info?.('collection-force-search complete', {
    findMissingCollections: report.findMissingCollections,
    candidates: report.candidates,
    searched: report.searched,
    failed: report.failed,
  });
  return report;
}
