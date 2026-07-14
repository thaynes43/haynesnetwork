// fix/live-status-precedence (v0.55.0 owner report) — the LIVE-STATE-WINS precedence for a WANT format row.
// The wall reads `activity.wallStages` (live per-source) and the Wanted detail's per-format row reads the
// reconciled `book_requests` snapshot (`comic_status`/`ebook_status`/`audio_status`, stamped hourly by the
// goodreads-sync). When the two disagree — Kapowarr is actively downloading a comic whose snapshot still reads
// `missing` — the LIVE signal must win, everywhere, ON LOAD (not only after a search fires). This pure module
// is the ONE precedence rule (framework-free → exhaustively unit-tested); the Wanted detail + any other
// snapshot/live meeting point consume it so they can never drift apart. Kept type-only imports so it stays a
// pure lib (no client component pulled in — the vitest `lib/__tests__` runner is code-only).
import type { BookRequestStatus } from '@hnet/db';
import type { CardActivityStage } from '@/components/cards';

/** The per-format live status the Wanted detail reads from `activity.itemStatus` (the #279 poll shape). */
export interface FormatLiveStatus {
  /** The format is still in some live in-flight/landed stage. False ⇒ no live signal (cleared / never grabbed). */
  present: boolean;
  stage: CardActivityStage | null;
  /** The first poll answer is still loading (no stage to show yet). */
  pending: boolean;
}

/**
 * LIVE-STATE-WINS: does the live signal OVERRIDE the reconciled snapshot for this format?
 *
 *  • A present live stage (searching / downloading % / importing / failed / completed) ALWAYS wins — the row
 *    shows the live stage (the Fix grammar), never the stale snapshot. Completed-live ⇒ show the landed state
 *    immediately (don't wait for the hourly reconcile).
 *  • On FIRST load, while the poll is still pending, a snapshot of `missing` is NOT trusted — we withhold the
 *    "Missing" word (show the neutral checking chip) until the poll answers, because the wall may already show
 *    an active grab. Every other snapshot (landed/wanted/grabbed/requested) renders immediately during pending
 *    (it is never the contradictory case the owner reported).
 *  • Otherwise the snapshot renders (truly missing + no live activity, or wanted-idle).
 *
 * The TERMINOLOGY GUARD falls out of this: a format with an active grab (present live stage) reports the live
 * stage, so "Missing" is reserved for exactly no-live-activity + snapshot-missing.
 */
export function formatLiveWins(snapshotStatus: BookRequestStatus, live: FormatLiveStatus): boolean {
  if (live.present && live.stage !== null) return true;
  if (live.pending && snapshotStatus === 'missing') return true;
  return false;
}

/**
 * The live-EFFECTIVE per-format status the DOMINANT hero badge collapses over (so the hero can't read "Missing"
 * while a format is actively downloading, contradicting the row on the same page). Same precedence as
 * `formatLiveWins`, mapped onto the snapshot vocabulary: a present in-flight grab (searching/downloading/
 * importing) ⇒ `grabbed` (actively acquiring — never `missing`); completed-live ⇒ `landed`; a live `failed`
 * grab or no live signal ⇒ the snapshot stands; a still-pending `missing` snapshot ⇒ `grabbed` (withhold the
 * word until the poll answers).
 */
export function effectiveFormatStatus(snapshotStatus: BookRequestStatus, live: FormatLiveStatus): BookRequestStatus {
  if (live.present && live.stage !== null) {
    if (live.stage === 'completed') return 'landed';
    if (live.stage !== 'failed') return 'grabbed';
    return snapshotStatus; // a live failure — nothing landed; the snapshot stands
  }
  if (live.pending && snapshotStatus === 'missing') return 'grabbed';
  return snapshotStatus;
}

/**
 * The `activity.itemStatus` poll key for ONE format of a request — the single-family id the (single-family)
 * itemStatus procedure answers for. The comic leg is reachable from a `book_requests` ref by its
 * `kapowarr_volume_id` (`kapowarr:<volumeId>`); a book/audiobook leg by its LazyLibrarian book id
 * (`books:ll:<llBookId>:<format>`). Null ⇒ not yet routed (no live key to watch — the snapshot stands).
 */
export function formatActivityId(
  format: 'ebook' | 'audiobook' | 'comic',
  refs: { llBookId: string | null; kapowarrVolumeId: string | null },
): string | null {
  if (format === 'comic') {
    return refs.kapowarrVolumeId != null ? `kapowarr:${refs.kapowarrVolumeId}` : null;
  }
  return refs.llBookId != null ? `books:ll:${refs.llBookId}:${format}` : null;
}
