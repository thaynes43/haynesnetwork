// DESIGN-038 D-13 (2026-07-18) — the COLLECTION Wanted-tiles pass: for every Libretto-managed books /
// audiobooks collection in the mirror, read the recipe's MISSING members (Libretto's member-level
// `read.listMissingMembers(recipeId)`), opportunistically resolve each to a Google-Books volume id (the
// LL bookid — makes the want force-searchable) via Libretto's resolve broker, and mint/reconcile
// `book_requests` (origin='collection') through the `syncCollectionWants` single-writer. Held tiles +
// these Wanted tiles then render side by side on the collection drill (the owner's "3 held + 15 wanted").
//
// Runs INSIDE the `books-collections-sync` mode AFTER the mirror upsert (so `libretto_recipe_id` is fresh),
// driven with an injected Libretto READ client (tests stub it; prod builds it from env). Best-effort and
// DEGRADING: if Libretto is unreachable the whole pass is skipped (no reconcile — we never delete wants we
// couldn't re-see); a single collection's read error skips ONLY that collection (its wants are left
// untouched — the fully-resolved discipline). External I/O stays OUT of the domain write transaction (the
// goodreads-sync idiom): resolve + missing reads happen here, then the confined `syncCollectionWants` commits.
import { and, eq, isNotNull } from 'drizzle-orm';
import { booksCollections, bookRequests, type DbClient } from '@hnet/db';
import type { LibrettoReadClient } from '@hnet/libretto/read';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { resolveDb } from './db-client';
import { normTitle, syncCollectionWants, type CollectionWantMember } from './book-requests';

/**
 * The Libretto read surface this pass needs (stubbed in tests — a structural subset of LibrettoReadClient).
 * `listRecipes` is carried so the SAME injected client also drives the PR4c cron force-search leg
 * (forceSearchFindMissingCollections reads acquisitionEnabled off the recipe list).
 */
export type CollectionWantsLibretto = Pick<
  LibrettoReadClient,
  'listMissingMembers' | 'resolve' | 'listRecipes'
>;

export interface RunCollectionWantsSyncInput {
  db?: DbClient;
  /** The Libretto READ client (env-built in prod; fetch-stubbed in tests). */
  libretto: CollectionWantsLibretto;
  now?: Date;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface CollectionWantsSyncReport {
  /** Libretto-managed collections whose missing set was read + reconciled this run. */
  collectionsProcessed: number;
  /** Collections skipped (a per-collection Libretto read error — their wants left untouched). */
  collectionsSkipped: number;
  minted: number;
  updated: number;
  removed: number;
  /** Missing members that resolved to a GB volume id this run (became force-searchable). */
  resolved: number;
  /**
   * Missing members whose want ALREADY carried a resolved id — reused verbatim, NOT re-resolved (a
   * Google-Books call saved). The hourly pass re-sees every held member every run, and syncCollectionWants
   * keeps a want's existing llBookId regardless of this run's resolution; re-resolving an already-resolved
   * want is therefore pure Google-Books waste that (pre-fix) exhausted Libretto's shared daily quota before
   * late-iteration collections were ever reached. This counts the saved calls (observability of the thrift).
   */
  reused: number;
  /** True when Libretto was unreachable — the whole pass was skipped (nothing reconciled). */
  unreachable: boolean;
}

/**
 * Load a collection's ALREADY-RESOLVED collection wants as `memberRef → llBookId`, so the wants pass can
 * REUSE a prior resolution instead of re-spending a Google-Books call on it. Only non-null ids are returned
 * (a still-NULL want is left out so it is retried this run). This is the quota-thrift that keeps Libretto's
 * shared daily Google-Books key from exhausting on already-resolved members before it reaches the still-NULL
 * ones (the root cause of popular collections — The Expanse — sitting permanently unresolved).
 */
export async function loadResolvedWantRefs(
  db: DbClient | undefined,
  collectionId: string,
): Promise<Map<string, string>> {
  const rows = await resolveDb(db)
    .select({ ref: bookRequests.collectionMemberRef, llBookId: bookRequests.llBookId })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.collectionId, collectionId),
        eq(bookRequests.origin, 'collection'),
        isNotNull(bookRequests.llBookId),
      ),
    );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.ref && row.llBookId) map.set(row.ref, row.llBookId);
  }
  return map;
}

/**
 * The STABLE per-member key within a collection: ISBN-13 → the first identifier ref → 'title:<normalized>'.
 * Returns null when the member carries no usable identity (skip it — cannot key an idempotent want). Pure.
 */
export function collectionMemberRef(member: {
  isbn?: string | null;
  identifiers?: string[] | null;
  title?: string | null;
}): string | null {
  const isbn = member.isbn?.trim();
  if (isbn) return `isbn:${isbn}`;
  const id = member.identifiers?.map((x) => x?.trim()).find((x) => x && x.length > 0);
  if (id) return id;
  const t = normTitle(member.title ?? '');
  return t ? `title:${t}` : null;
}

/**
 * The collection's wall format from its source: kavita ⇒ 'ebook', audiobookshelf ⇒ 'audiobook'. Comics
 * (Kapowarr's domain) are out of this leg — a comic-majority Kavita collection is a documented v1 edge.
 */
function formatForSource(source: string): 'ebook' | 'audiobook' {
  return source === 'audiobookshelf' ? 'audiobook' : 'ebook';
}

/**
 * Map a recipe's raw MISSING members to keyed, resolve-enriched want members — the shared body of the cron
 * wants pass AND the on-demand collection Force Search (collection-force-search.ts). Each member is keyed by
 * its stable ref (unkeyable/nameless members are skipped) and OPPORTUNISTICALLY resolved to a Google-Books
 * volume id (the LL bookid) so the want becomes force-searchable; a null resolve keeps the tile visible, just
 * not searchable (an honest gap). External resolve I/O only — no DB writes (the caller's single-writer commits).
 *
 * `resolvedRefs` (memberRef → llBookId, from `loadResolvedWantRefs`) is the QUOTA-THRIFT seam: a member whose
 * want already carries a resolved id is reused verbatim and its Google-Books resolve call is SKIPPED — the
 * result would be discarded by syncCollectionWants anyway (existing id wins), and re-resolving every held
 * member every run is what exhausted Libretto's shared daily Google-Books key before late collections
 * resolved. Omit it (tests / one-shot callers) to resolve every member as before.
 */
export async function resolveMissingMembers(
  libretto: Pick<CollectionWantsLibretto, 'resolve'>,
  missing: ReadonlyArray<{
    isbn?: string | null;
    identifiers?: string[] | null;
    title?: string | null;
    label?: string | null;
    authors?: string[] | null;
  }>,
  resolvedRefs?: ReadonlyMap<string, string>,
): Promise<{ members: CollectionWantMember[]; resolved: number; reused: number }> {
  const members: CollectionWantMember[] = [];
  let resolved = 0;
  let reused = 0;
  for (const raw of missing) {
    const ref = collectionMemberRef(raw);
    if (!ref) continue; // unkeyable — cannot mint an idempotent want
    const title = raw.title?.trim() || raw.label?.trim() || '';
    if (!title) continue; // no display title — skip (a want with no name is not renderable)
    const author = raw.authors?.[0]?.trim() || null;

    // Reuse a prior resolution — never re-spend a Google-Books call on an already-resolved want (its
    // llBookId is kept by syncCollectionWants regardless, so the re-resolve is pure quota waste).
    const prior = resolvedRefs?.get(ref);
    if (prior) {
      reused += 1;
      members.push({ memberRef: ref, title, author, llBookId: prior });
      continue;
    }

    // Opportunistic force-search resolution (best-effort — a null keeps the tile visible, not searchable).
    let llBookId: string | null = null;
    try {
      const hit = await libretto.resolve({
        ...(raw.isbn ? { isbn: raw.isbn } : {}),
        title,
        ...(author ? { author } : {}),
      });
      llBookId = hit?.volumeId ?? null;
      if (llBookId) resolved += 1;
    } catch {
      llBookId = null; // resolve broker unavailable/no-match — the tile still renders
    }

    members.push({ memberRef: ref, title, author, llBookId });
  }
  return { members, resolved, reused };
}

/**
 * Drive the collection Wanted-tiles mint/reconcile across every Libretto-managed mirror collection. See the
 * file header for the degradation contract. Never throws for a single collection's Libretto error (logged +
 * skipped); only a DB failure propagates.
 */
export async function runCollectionWantsSync(
  input: RunCollectionWantsSyncInput,
): Promise<CollectionWantsSyncReport> {
  const now = input.now ?? new Date();
  const log = input.logger ?? {};
  const report: CollectionWantsSyncReport = {
    collectionsProcessed: 0,
    collectionsSkipped: 0,
    minted: 0,
    updated: 0,
    removed: 0,
    resolved: 0,
    reused: 0,
    unreachable: false,
  };

  // Only Libretto-produced collections carry a recipe (and therefore a missing set); hand-made
  // Kavita/ABS collections have no recipe — nothing to want.
  const collections = await resolveDb(input.db)
    .select({
      id: booksCollections.id,
      source: booksCollections.source,
      title: booksCollections.title,
      recipeId: booksCollections.librettoRecipeId,
    })
    .from(booksCollections)
    .where(isNotNull(booksCollections.librettoRecipeId));

  for (const collection of collections) {
    const recipeId = collection.recipeId;
    if (!recipeId) continue;

    let missing: Awaited<ReturnType<CollectionWantsLibretto['listMissingMembers']>>;
    try {
      missing = await input.libretto.listMissingMembers(recipeId);
    } catch (error) {
      if (error instanceof LibrettoUnreachableError) {
        // Libretto is down — abort the whole pass (never reconcile wants we cannot re-see).
        report.unreachable = true;
        log.warn?.('collection-wants: Libretto unreachable — pass skipped', {
          recipeId,
          error: error.message,
        });
        return report;
      }
      report.collectionsSkipped += 1;
      log.warn?.('collection-wants: missing read failed — collection skipped', {
        collectionId: collection.id,
        recipeId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Quota thrift — reuse already-resolved wants (skip their Google-Books resolve). Without this the pass
    // re-resolves every held member every run and exhausts Libretto's shared daily key before it reaches the
    // still-NULL members of late-iteration collections (The Expanse), so those never resolve.
    const resolvedRefs = await loadResolvedWantRefs(input.db, collection.id);
    const { members, resolved, reused } = await resolveMissingMembers(
      input.libretto,
      missing.missing ?? [],
      resolvedRefs,
    );
    report.resolved += resolved;
    report.reused += reused;

    const result = await syncCollectionWants({
      db: input.db,
      collectionId: collection.id,
      format: formatForSource(collection.source),
      members,
      now,
    });
    report.collectionsProcessed += 1;
    report.minted += result.minted;
    report.updated += result.updated;
    report.removed += result.removed;
  }

  log.info?.('collection-wants complete', {
    collectionsProcessed: report.collectionsProcessed,
    collectionsSkipped: report.collectionsSkipped,
    minted: report.minted,
    removed: report.removed,
    resolved: report.resolved,
    reused: report.reused,
    unreachable: report.unreachable,
  });
  return report;
}
