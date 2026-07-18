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
import { isNotNull } from 'drizzle-orm';
import { booksCollections, type DbClient } from '@hnet/db';
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
  /** True when Libretto was unreachable — the whole pass was skipped (nothing reconciled). */
  unreachable: boolean;
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

    const members: CollectionWantMember[] = [];
    for (const raw of missing.missing ?? []) {
      const ref = collectionMemberRef(raw);
      if (!ref) continue; // unkeyable — cannot mint an idempotent want
      const title = raw.title?.trim() || raw.label?.trim() || '';
      if (!title) continue; // no display title — skip (a want with no name is not renderable)
      const author = raw.authors?.[0]?.trim() || null;

      // Opportunistic force-search resolution (best-effort — a null keeps the tile visible, not searchable).
      let llBookId: string | null = null;
      try {
        const resolved = await input.libretto.resolve({
          ...(raw.isbn ? { isbn: raw.isbn } : {}),
          title,
          ...(author ? { author } : {}),
        });
        llBookId = resolved?.volumeId ?? null;
        if (llBookId) report.resolved += 1;
      } catch {
        llBookId = null; // resolve broker unavailable/no-match — the tile still renders
      }

      members.push({ memberRef: ref, title, author, llBookId });
    }

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
    unreachable: report.unreachable,
  });
  return report;
}
