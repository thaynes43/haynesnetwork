// Issue #735 (DESIGN-028 amendment 2026-10-06) — the RECORDING half of the LazyLibrarian Release (T-283), kept in a
// leaf module so every writer that gives a want up can call it inside its own transaction without an import cycle
// (book-requests.ts, format-pairing.ts, integration-shelf-items.ts, user-integrations.ts, wrong-volume-repair.ts all
// import it; it imports nothing from them). The drain, the owner rule and the orphan census are in `ll-release.ts`.
//
// What it records: the LazyLibrarian book and formats the app itself had LazyLibrarian working on for that want — a
// goodreads or pairing format that reads `wanted` or `grabbed`, a collection format that was force-searched and has not
// landed. A format the app never queued (still `requested`, settled `missing`, already `landed`) is never recorded, so a
// book a person queued by hand under the same id is not the app's to unqueue.
import { llFormatReleases, type BookRequestOrigin, type BookRequestRow, type BooksMediaKind, type DbClient } from '@hnet/db';
import { sql } from 'drizzle-orm';
import { resolveDb } from './db-client';

/** A LazyLibrarian format (Status vs AudioStatus). */
export type LlFormat = 'ebook' | 'audiobook';

/** Why a want gave its LazyLibrarian format up (the `reason` column and the log field). */
export type LlReleaseReason =
  | 'reidentified'
  | 'parked:foreign_language'
  | 'parked:no_english_edition'
  | 'parked:multi_book'
  | 'parked:no_book'
  | 'parked:wrong_volume'
  | 'english_edition_switched'
  | 'collection_want_dropped'
  | 'shelf_removed'
  | 'unlinked'
  | 'repaired:wrong_volume'
  | 'repaired:removed_anchor';

/** The pairing want's format: the one its anchor lacks (a `book` anchor wants the audiobook, and the reverse). */
function pairingFormat(kind: BooksMediaKind | null | undefined): LlFormat | null {
  if (kind === 'book') return 'audiobook';
  if (kind === 'audiobook') return 'ebook';
  return null; // a comic anchor, or one we cannot read
}

/** A collection want's format, from its collection's source (kavita ⇒ ebook, audiobookshelf ⇒ audiobook). */
export function collectionFormatForSource(source: string): LlFormat {
  return source === 'audiobookshelf' ? 'audiobook' : 'ebook';
}

/**
 * The formats a want asks LazyLibrarian for: both for a goodreads want; the missing format for a pairing want (from its
 * anchor's media kind); the collection's own format for a collection want; none for a comic (Kapowarr's). Pure.
 */
export function llAcquiredFormats(
  want: { origin: BookRequestOrigin; comicStatus?: string | null },
  ctx: { anchorKind?: BooksMediaKind | null; collectionSource?: string | null } = {},
): LlFormat[] {
  if (want.comicStatus != null) return [];
  if (want.origin === 'goodreads') return ['ebook', 'audiobook'];
  if (want.origin === 'pairing') {
    const f = pairingFormat(ctx.anchorKind);
    return f ? [f] : [];
  }
  if (want.origin === 'collection') return ctx.collectionSource ? [collectionFormatForSource(ctx.collectionSource)] : [];
  return [];
}

/**
 * Of `scope`, the formats the app had LazyLibrarian working on for this want, i.e. the ones it queued. A goodreads or
 * pairing format reads `wanted` or `grabbed` only after a push or a re-queue; a collection want's status stays
 * `requested` while it is searched, so its evidence is `last_searched_at` and a format that has not landed. Pure.
 */
export function llQueuedFormats(
  want: Pick<BookRequestRow, 'origin' | 'ebookStatus' | 'audioStatus' | 'lastSearchedAt'>,
  scope: readonly LlFormat[],
): LlFormat[] {
  const statusOf = (f: LlFormat) => (f === 'ebook' ? want.ebookStatus : want.audioStatus);
  if (want.origin === 'collection') {
    return want.lastSearchedAt ? scope.filter((f) => statusOf(f) !== 'landed') : [];
  }
  return scope.filter((f) => statusOf(f) === 'wanted' || statusOf(f) === 'grabbed');
}

/**
 * The single writer that records a release: one row per (book, format), the latest reason and want winning when a
 * second want gives the same format up before the drain runs. Call it inside the transaction of the writer that gives
 * the want up, so the two commit together. No LazyLibrarian call here: the drain decides from a fresh read. Returns the
 * number of formats recorded.
 */
export async function recordLlReleases(
  tx: DbClient | undefined,
  input: {
    llBookId: string | null | undefined;
    formats: readonly LlFormat[];
    reason: LlReleaseReason;
    requestId: string | null;
    now?: Date;
  },
): Promise<number> {
  if (!input.llBookId || input.formats.length === 0) return 0;
  const now = input.now ?? new Date();
  const formats = [...new Set(input.formats)];
  await resolveDb(tx)
    .insert(llFormatReleases)
    .values(
      formats.map((format) => ({
        llBookId: input.llBookId!,
        format,
        reason: input.reason,
        requestId: input.requestId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [llFormatReleases.llBookId, llFormatReleases.format],
      set: {
        reason: sql`excluded.reason`,
        requestId: sql`excluded.request_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return formats.length;
}
