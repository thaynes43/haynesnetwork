// Issue #719 (DESIGN-028 amendment 2026-10-05; DESIGN-036 / DESIGN-038 for the pairing and collection wants) — the
// ENGLISH EDITION pass. The library is English-only (F10, `.agents/context/2026-07-13-f10-english-audit.md`), and
// since v0.107.6 (#715) no job queues a LazyLibrarian book that LazyLibrarian labels non-English. That left the want
// pointing at it with nothing to ask for: Azazel's Goodreads request resolved to a Spanish edition, so it sat `missing`
// and nobody got the book. This pass is what the want asks for instead. For every non-comic want (goodreads, pairing,
// collection) whose LazyLibrarian book is not English:
//   - look for the English edition of the same work (Google Books by title and author, `langRestrict=en`, the same
//     title / author / omnibus / volume guards as every resolve, and #693's volume check against the want);
//   - found ⇒ the want switches to that volume (`switchRequestToEnglishEdition`) and is an ordinary never-pushed want,
//     so the existing addBook → queueBook → searchBook path takes it on the next push;
//   - none ⇒ the want is parked `no_english_edition` (`parkRequestNoEnglishEdition`) and nothing is ever pushed for it.
//
// The Google Books budget is tight (~900 of ~1,000 a day), so the lookup is rationed three ways: at most ONE lookup
// per request per quota-day whatever it finds (`english_edition_tried_at`, stamped by the writers), the daily CALL
// BUDGET (`GbBudgetTracker.canSpend`, reserve-before-commit) and the shared quota breaker (`guardedGbResolve`), plus a
// small per-run cap. A budget or breaker refusal is not a lookup: it stamps nothing and the want is looked at again as
// soon as quota allows. A park is re-evaluated each run: it lifts when LazyLibrarian's book reads English again, and
// it retries the lookup once per quota-day (Google Books gains editions).
//
// Opens no transaction of its own (the Google Books calls stay out of any); every write is a `book-requests.ts`
// single-writer. Reads LazyLibrarian only through the snapshot the caller hands in (the run's one `getAllBooks`).
import { and, asc, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { bookRequests, booksItems, type BookRequestRow, type DbClient } from '@hnet/db';
import { resolveDb } from './db-client';
import {
  FOREIGN_LANGUAGE_REASON,
  NO_ENGLISH_EDITION_REASON,
  isForeignLanguage,
  readItemLanguage,
} from './book-language';
import {
  englishEditionOpenFormats,
  liftNoEnglishEditionPark,
  parkRequestNoEnglishEdition,
  stampEnglishEditionTried,
  switchRequestToEnglishEdition,
} from './book-requests';
import { guardedGbResolve, type GbQuotaGuardedResolver } from './gb-quota-breaker';
import type { GbBudgetTracker, GbCallMeter, GbConsumer } from './gb-call-budget';
import { gbQuotaDayStart, llSnapshotUsable, type LlSnapshot, type LlSnapshotRow } from './ll-gone';
import { llBookMismatch } from './ll-book-check';

/** Owner-tunable per-run bound on English-edition lookups (each is at most two Google Books legs). */
export const ENGLISH_EDITION_CAP_PER_RUN = Number(process.env.ENGLISH_EDITION_CAP_PER_RUN ?? 10);

/** The part of a resolved Google Books volume the pass reads (a structural subset of `@hnet/goodreads`' `GbVolume`). */
export interface EnglishEditionVolume {
  volumeId: string;
  language?: string | null;
  title?: string | null;
  subtitle?: string | null;
  authors?: readonly string[];
}

/** The Google Books seam, with the budget the lookup spends from (the goodreads-sync run's own). */
export interface EnglishEditionResolver {
  gb: GbQuotaGuardedResolver<EnglishEditionVolume>;
  /** The estate consumer the lookup is charged to (carried onto the breaker's trip line, and the budget slice). */
  consumer: GbConsumer;
  /** The run's budget tracker (absent ⇒ no budget enforcement, the pre-budget behaviour of a test or degraded run). */
  budget?: GbBudgetTracker;
  /** The call meter wired into the Google Books client; its per-lookup delta is what the budget is charged. */
  meter?: GbCallMeter;
}

export interface EnglishEditionReport {
  /** Wants whose lookup was due this run (a foreign LazyLibrarian book, open formats, not looked at today). */
  due: number;
  /** Lookups made (≤ the per-run cap). */
  looked: number;
  /** Wants switched to an English edition. */
  switched: number;
  /** Wants parked `no_english_edition` (no edition, or the one found was refused). */
  parked: number;
  /** `no_english_edition` parks lifted because LazyLibrarian's book now reads English or unknown. */
  lifted: number;
  /** Due wants left for later because the daily call budget could not afford another lookup. */
  skippedBudget: number;
  /** Due wants left for later because the Google Books breaker was open (or tripped on a lookup). */
  skippedQuota: number;
  /** Due wants left for the next run by the per-run cap. */
  skippedCap: number;
  /** Lookups that failed (a Google Books error): stamped, retried next quota-day. */
  failed: number;
}

export const emptyEnglishEditionReport = (): EnglishEditionReport => ({
  due: 0,
  looked: 0,
  switched: 0,
  parked: 0,
  lifted: 0,
  skippedBudget: 0,
  skippedQuota: 0,
  skippedCap: 0,
  failed: 0,
});

/**
 * Is a resolved English volume the want's own book? Pure. Refused when Google Books says it is not English (belt and
 * braces: the client already filters), when it is the id the want already has, and when its title names another
 * volume or work than the want (`llBookMismatch`, #693's check, against the want's OWN title — the foreign edition's
 * title is no evidence of what the person asked for).
 */
export function acceptEnglishEdition(
  want: { title: string; author: string | null; llBookId: string },
  volume: EnglishEditionVolume,
): { ok: true } | { ok: false; reason: 'same_id' | 'not_english' | 'volume' | 'work' } {
  if (volume.volumeId === want.llBookId) return { ok: false, reason: 'same_id' };
  if (isForeignLanguage(volume.language)) return { ok: false, reason: 'not_english' };
  const mismatch = llBookMismatch(want, {
    title: volume.title ?? null,
    subtitle: volume.subtitle ?? null,
    author: (volume.authors ?? []).join(', ') || null,
  });
  return mismatch ? { ok: false, reason: mismatch } : { ok: true };
}

export interface RunEnglishEditionPassInput {
  db?: DbClient;
  resolver: EnglishEditionResolver;
  /** The run's `getAllBooks` snapshot. Only a real, non-empty read can say a book is foreign; otherwise nothing runs. */
  snapshot: ReadonlyMap<string, LlSnapshotRow> | null | undefined;
  now?: Date;
  /** Per-run lookup cap (default `ENGLISH_EDITION_CAP_PER_RUN`). */
  cap?: number;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Run the pass over every request that points at a non-English LazyLibrarian book. See the file header for the
 * rules; the candidate rules, in one place:
 *   - not a comic, not matched into the library, has a LazyLibrarian id, still has open formats
 *     (`englishEditionOpenFormats`: a goodreads want with either format landed is left to the F10 audit);
 *   - unparked: the snapshot says its book is foreign. A pairing want parked `foreign_language` is taken up only when
 *     the park is the BOOK's (its anchor reads English or unknown; an anchor that is itself foreign is the anchor's
 *     problem, not an edition's) and the book is foreign; a `no_english_edition` park is lifted when the book is no
 *     longer foreign, and retried otherwise;
 *   - not looked at since the quota-day began.
 */
export async function runEnglishEditionPass(input: RunEnglishEditionPassInput): Promise<EnglishEditionReport> {
  const report = emptyEnglishEditionReport();
  if (!llSnapshotUsable(input.snapshot)) return report;
  const snapshot: LlSnapshot = input.snapshot;
  const now = input.now ?? new Date();
  const cap = input.cap ?? ENGLISH_EDITION_CAP_PER_RUN;
  const log = input.log ?? {};
  const { resolver } = input;
  const dayStart = gbQuotaDayStart(now);

  const rows = await resolveDb(input.db)
    .select()
    .from(bookRequests)
    .where(
      and(
        isNull(bookRequests.comicStatus),
        isNull(bookRequests.matchedBooksItemId),
        isNotNull(bookRequests.llBookId),
        or(
          isNull(bookRequests.unroutableReason),
          inArray(bookRequests.unroutableReason, [FOREIGN_LANGUAGE_REASON, NO_ENGLISH_EDITION_REASON]),
        ),
        or(ne(bookRequests.ebookStatus, 'landed'), ne(bookRequests.audioStatus, 'landed')),
      ),
    )
    // Never-looked-at first, then the longest-waiting; a stable tail so a capped run resumes where it stopped.
    .orderBy(sql`${bookRequests.englishEditionTriedAt} ASC NULLS FIRST`, asc(bookRequests.createdAt), asc(bookRequests.id));

  // A pairing want's anchor language: an anchor that is itself foreign is parked `foreign_language` by the pairing
  // mint, and no edition of the book fixes the anchor.
  const anchorIds = [
    ...new Set(rows.filter((r) => r.origin === 'pairing' && r.pairingBooksItemId).map((r) => r.pairingBooksItemId!)),
  ];
  const anchorLanguage = new Map<string, string | null>();
  if (anchorIds.length > 0) {
    const anchors = await resolveDb(input.db)
      .select({ id: booksItems.id, attrs: booksItems.attrs })
      .from(booksItems)
      .where(inArray(booksItems.id, anchorIds));
    for (const a of anchors) anchorLanguage.set(a.id, readItemLanguage(a.attrs));
  }
  const anchorIsForeign = (row: BookRequestRow): boolean =>
    row.origin === 'pairing' &&
    row.pairingBooksItemId !== null &&
    isForeignLanguage(anchorLanguage.get(row.pairingBooksItemId) ?? null);

  const due: BookRequestRow[] = [];
  for (const row of rows) {
    if (englishEditionOpenFormats(row).length === 0) continue;
    const llBookId = row.llBookId!;
    const book = snapshot.get(llBookId);
    const foreign = book !== undefined && isForeignLanguage(book.language);
    const reason = row.unroutableReason;
    if (reason === NO_ENGLISH_EDITION_REASON) {
      if (book !== undefined && !foreign) {
        // The park's reason is gone (the book was fixed in LazyLibrarian): an ordinary want again. Free, so it is not
        // rationed by the lookup stamp.
        if (await liftNoEnglishEditionPark({ db: input.db, requestId: row.id, llBookId, now })) {
          report.lifted += 1;
          log.info?.('english_edition_park_lifted', {
            requestId: row.id,
            origin: row.origin,
            llBookId,
            title: row.title,
            llLanguage: book.language ?? null,
          });
        }
        continue;
      }
    } else if (reason === FOREIGN_LANGUAGE_REASON) {
      if (row.origin !== 'pairing' || !foreign || anchorIsForeign(row)) continue;
    } else if (!foreign || anchorIsForeign(row)) {
      continue;
    }
    if (row.englishEditionTriedAt !== null && row.englishEditionTriedAt.getTime() >= dayStart.getTime()) continue;
    due.push(row);
  }
  report.due = due.length;

  let budgetLogged = false;
  for (let i = 0; i < due.length; i += 1) {
    if (report.looked >= cap) {
      report.skippedCap += due.length - i;
      break;
    }
    // The daily CALL BUDGET: refuse before the call (reserve-before-commit). Not a lookup: nothing is stamped, the want
    // is due again as soon as the slice has room, and the shared breaker is not involved.
    if (resolver.budget && !resolver.budget.canSpend()) {
      report.skippedBudget += due.length - i;
      if (!budgetLogged) {
        log.info?.('english_edition: GB daily call budget spent, lookups left for later', {
          consumer: resolver.budget.consumer,
          used: resolver.budget.used(),
          due: due.length - i,
        });
        budgetLogged = true;
      }
      break;
    }
    const row = due[i]!;
    const llBookId = row.llBookId!;
    const want = { title: row.title, author: row.author, llBookId };
    const before = resolver.meter?.taken() ?? 0;
    const spend = async (): Promise<void> => {
      if (resolver.budget) await resolver.budget.spend((resolver.meter?.taken() ?? 0) - before);
    };
    let guarded: Awaited<ReturnType<typeof guardedGbResolve<EnglishEditionVolume>>>;
    try {
      guarded = await guardedGbResolve({
        db: input.db,
        consumer: resolver.consumer,
        gb: resolver.gb,
        query: { title: row.title, author: row.author, language: 'en' },
        now,
      });
    } catch (error) {
      await spend();
      // A non-429 failure is a lookup that ran and failed: stamped so it is not retried every run.
      await stampEnglishEditionTried({ db: input.db, requestId: row.id, now });
      report.looked += 1;
      report.failed += 1;
      log.error?.('english_edition: Google Books lookup failed, retried next quota-day', {
        requestId: row.id,
        title: row.title,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    await spend();
    if (guarded.outcome === 'quota_blocked' || guarded.outcome === 'quota_tripped') {
      // The breaker is open (or just tripped): not a lookup, nothing stamped; every due want waits for quota.
      report.skippedQuota += due.length - i;
      log.info?.('english_edition: GB quota exhausted, lookups left for later', {
        retryAfter: guarded.until.toISOString(),
        due: due.length - i,
      });
      break;
    }
    report.looked += 1;
    const llLanguage = snapshot.get(llBookId)?.language ?? null;
    if (guarded.outcome === 'resolved') {
      const verdict = acceptEnglishEdition(want, guarded.volume);
      if (verdict.ok) {
        const moved = await switchRequestToEnglishEdition({
          db: input.db,
          requestId: row.id,
          fromLlBookId: llBookId,
          toLlBookId: guarded.volume.volumeId,
          now,
        });
        if (moved) {
          report.switched += 1;
          log.info?.('english_edition_switched', {
            requestId: row.id,
            origin: row.origin,
            title: row.title,
            llBookId,
            toLlBookId: guarded.volume.volumeId,
            llLanguage,
            gbLanguage: guarded.volume.language ?? null,
          });
        }
        continue;
      }
      log.info?.('english_edition_refused', {
        requestId: row.id,
        title: row.title,
        llBookId,
        candidate: guarded.volume.volumeId,
        candidateTitle: guarded.volume.title ?? null,
        reason: verdict.reason,
      });
    }
    // No English edition (or the one found is another volume or work): park, nothing is pushed for it.
    if (await parkRequestNoEnglishEdition({ db: input.db, requestId: row.id, llBookId, now })) {
      report.parked += 1;
      log.info?.('english_edition_none', {
        requestId: row.id,
        origin: row.origin,
        title: row.title,
        llBookId,
        llLanguage,
      });
    }
  }
  return report;
}
