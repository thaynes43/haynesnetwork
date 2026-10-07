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
import {
  LibrettoUnreachableError,
  type LibrettoMissingMember,
  type LibrettoMissingResponse,
} from '@hnet/libretto';
import { resolveDb } from './db-client';
import {
  loadPairingCoverage,
  normTitle,
  syncCollectionWants,
  type CollectionWantMember,
} from './book-requests';

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
  /**
   * Issue #693 — missing members whose want is PARKED (`unroutable_reason`, e.g. `wrong_volume`): never re-resolved,
   * so a resolve that named another work (the BBC Radio Drama Collection → "Terry Pratchett's Discworld") cannot come
   * back. The want stays a visible, unsearchable tile.
   */
  parked: number;
  /**
   * Missing members an active pairing want covers by title + author (`loadPairingCoverage`): not resolved, because
   * syncCollectionWants skips them whatever they resolve to. Before 2026-10-07 they were resolved every pass and
   * counted in `resolved`, which made ten resolves an hour look like ids that never stuck.
   */
  covered: number;
  /** Missing members the resolve left without an id this run (Google Books has no match, or the broker failed). */
  unresolved: number;
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
 * Issue #693 — a collection's PARKED wants (`unroutable_reason` set) as their member refs. The wants pass never
 * resolves them again (`resolveMissingMembers`) and `syncCollectionWants` never refills their id, so a park — the
 * repair's answer to a resolve that named another volume or work — holds.
 */
export async function loadParkedWantRefs(
  db: DbClient | undefined,
  collectionId: string,
): Promise<Set<string>> {
  const rows = await resolveDb(db)
    .select({ ref: bookRequests.collectionMemberRef })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.collectionId, collectionId),
        eq(bookRequests.origin, 'collection'),
        isNotNull(bookRequests.unroutableReason),
      ),
    );
  return new Set(rows.map((r) => r.ref).filter((r): r is string => Boolean(r)));
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

/** What one mirror collection reads out of its recipe's missing response (issue #759). */
export type CollectionMissingSelection =
  { ok: true; missing: LibrettoMissingMember[] } | { ok: false; reason: string };

/**
 * Issue #759 — the missing members of ONE mirror collection, out of its recipe's `listMissingMembers` read.
 *
 * A recipe can target Kavita AND Audiobookshelf (ADR-076); each target has its own missing list (the works missing
 * FROM that library), carried per entry in `targets[]`. The flat top-level `missing` is only the FIRST reachable
 * target's, so reading it for both mirror collections gave the audiobook collection the Kavita list: an audiobook
 * already in Audiobookshelf stayed a Wanted tile (whenever the ebook was missing), and an audiobook missing only from
 * Audiobookshelf never got one. The entry is chosen by server (kavita ⇒ `kavita`, audiobookshelf ⇒ `abs`) and, when
 * the mirror row carries one, library id (Kavita collections span libraries, so their rows carry none).
 *
 * Fail-safe like a per-collection read error: no entry for this collection's target, an entry that reports an error,
 * or an entry without a member list is `ok: false`, and the caller leaves the collection's wants untouched (never
 * reconcile against a list it did not get). A response without `targets[]` (a Libretto that predates ADR-076) is a
 * single-target answer: its flat list is used when its `server` is this collection's (or unnamed). Pure.
 */
export function missingForCollection(
  response: LibrettoMissingResponse,
  collection: { source: string; libraryId: string | null },
): CollectionMissingSelection {
  const server = collection.source === 'audiobookshelf' ? 'abs' : 'kavita';
  const targets = response.targets;
  if (targets && targets.length > 0) {
    const sameServer = targets.filter((t) => t.server === server);
    const entry = collection.libraryId
      ? sameServer.find((t) => t.libraryId === collection.libraryId)
      : sameServer[0];
    if (!entry) return { ok: false, reason: `recipe has no ${server} target for this collection` };
    if (entry.error) return { ok: false, reason: entry.error };
    if (!Array.isArray(entry.missing))
      return { ok: false, reason: `${server} entry carries no member list` };
    return { ok: true, missing: entry.missing };
  }
  if (response.server && response.server !== server) {
    return { ok: false, reason: `missing list is for ${response.server}, not ${server}` };
  }
  return { ok: true, missing: response.missing ?? [] };
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
  parkedRefs?: ReadonlySet<string>,
  pairingCovers?: (m: Pick<CollectionWantMember, 'title' | 'author' | 'llBookId'>) => boolean,
): Promise<{
  members: CollectionWantMember[];
  resolved: number;
  reused: number;
  parked: number;
  covered: number;
  unresolved: number;
}> {
  const members: CollectionWantMember[] = [];
  let resolved = 0;
  let reused = 0;
  let parked = 0;
  let covered = 0;
  let unresolved = 0;
  for (const raw of missing) {
    const ref = collectionMemberRef(raw);
    if (!ref) continue; // unkeyable — cannot mint an idempotent want
    const title = raw.title?.trim() || raw.label?.trim() || '';
    if (!title) continue; // no display title — skip (a want with no name is not renderable)
    const author = raw.authors?.[0]?.trim() || null;

    // Issue #693 — a parked want is never resolved again (its id stays cleared; `syncCollectionWants` keeps it so).
    if (parkedRefs?.has(ref)) {
      parked += 1;
      members.push({ memberRef: ref, title, author, llBookId: null });
      continue;
    }

    // Reuse a prior resolution — never re-spend a Google-Books call on an already-resolved want (its
    // llBookId is kept by syncCollectionWants regardless, so the re-resolve is pure quota waste).
    const prior = resolvedRefs?.get(ref);
    if (prior) {
      reused += 1;
      members.push({ memberRef: ref, title, author, llBookId: prior });
      continue;
    }

    // A member an active pairing want covers by title + author is skipped by syncCollectionWants whatever it resolves
    // to, so its resolve would be a Google Books call nothing keeps (`loadPairingCoverage`).
    if (pairingCovers?.({ title, author, llBookId: null })) {
      covered += 1;
      members.push({ memberRef: ref, title, author, llBookId: null });
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
    } catch {
      llBookId = null; // resolve broker unavailable/no-match — the tile still renders
    }
    if (llBookId) resolved += 1;
    else unresolved += 1;

    members.push({ memberRef: ref, title, author, llBookId });
  }
  return { members, resolved, reused, parked, covered, unresolved };
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
    parked: 0,
    covered: 0,
    unresolved: 0,
    unreachable: false,
  };

  // Only Libretto-produced collections carry a recipe (and therefore a missing set); hand-made
  // Kavita/ABS collections have no recipe — nothing to want.
  const collections = await resolveDb(input.db)
    .select({
      id: booksCollections.id,
      source: booksCollections.source,
      libraryId: booksCollections.libraryId,
      title: booksCollections.title,
      recipeId: booksCollections.librettoRecipeId,
    })
    .from(booksCollections)
    .where(isNotNull(booksCollections.librettoRecipeId));

  // Issue #759 — a Kavita + Audiobookshelf recipe backs TWO mirror collections; one read per recipe per run serves
  // both (each takes its own target's entry), so the second collection costs no second library listing.
  const reads = new Map<string, Promise<LibrettoMissingResponse>>();
  // The pairing wants' coverage per format, read once per pass (the sync re-reads it in its own transaction).
  const pairingCoverage = new Map<
    'ebook' | 'audiobook',
    Awaited<ReturnType<typeof loadPairingCoverage>>
  >();

  for (const collection of collections) {
    const recipeId = collection.recipeId;
    if (!recipeId) continue;

    let response: LibrettoMissingResponse;
    try {
      let read = reads.get(recipeId);
      if (!read) {
        read = input.libretto.listMissingMembers(recipeId);
        reads.set(recipeId, read);
      }
      response = await read;
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

    // Issue #759 — this collection's own target's list (the audiobook collection never reads the Kavita one).
    const selected = missingForCollection(response, collection);
    if (!selected.ok) {
      report.collectionsSkipped += 1;
      log.warn?.(
        'collection-wants: no missing list for this collection’s target — collection skipped',
        {
          collectionId: collection.id,
          recipeId,
          source: collection.source,
          reason: selected.reason,
        },
      );
      continue;
    }

    // Quota thrift — reuse already-resolved wants (skip their Google-Books resolve). Without this the pass
    // re-resolves every held member every run and exhausts Libretto's shared daily key before it reaches the
    // still-NULL members of late-iteration collections (The Expanse), so those never resolve.
    const resolvedRefs = await loadResolvedWantRefs(input.db, collection.id);
    const parkedRefs = await loadParkedWantRefs(input.db, collection.id);
    const format = formatForSource(collection.source);
    let coverage = pairingCoverage.get(format);
    if (!coverage) {
      coverage = await loadPairingCoverage(input.db, format);
      pairingCoverage.set(format, coverage);
    }
    const { members, resolved, reused, parked, covered, unresolved } = await resolveMissingMembers(
      input.libretto,
      selected.missing,
      resolvedRefs,
      parkedRefs,
      coverage,
    );
    report.resolved += resolved;
    report.reused += reused;
    report.parked += parked;
    report.covered += covered;
    report.unresolved += unresolved;

    const result = await syncCollectionWants({
      db: input.db,
      collectionId: collection.id,
      format,
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
    parked: report.parked,
    covered: report.covered,
    unresolved: report.unresolved,
    unreachable: report.unreachable,
  });
  return report;
}
