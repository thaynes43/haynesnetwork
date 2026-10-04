// ADR-055 / DESIGN-028 (PLAN-044) — the READ surface for LazyLibrarian (@hnet/lazylibrarian/read). Reads
// a book's per-format status for the goodreads-sync reconcile step (LL-status → per-format request-state
// happens in the domain). Import-unrestricted (reads are safe everywhere); the mutating surface lives in
// ./write and is import-confined to packages/domain (ADR-055, the @hnet/arr / @hnet/plex precedent).
import { LazyLibrarianHttp, type LazyLibrarianHttpOptions } from './http';
import {
  llGetAllBooksResponseSchema,
  llGetHistoryResponseSchema,
  llGetWantedResponseSchema,
  type LlBook,
  type LlHistoryRow,
  type LlWantedRow,
} from './schemas';

/** Options shared by the read + write clients (mirrors PlexClientOptions). */
export type LazyLibrarianClientOptions = LazyLibrarianHttpOptions;

/** A book's raw LL per-format status (the strings LL reports; the domain maps them). */
export interface LlBookStatus {
  bookId: string;
  /** The book's display title (`BookName`), or null when LL omits it. Read by the queue janitor's fail-loop rows
   *  (ADR-095 / DESIGN-046 D-18). Optional so structural stubs of this type stay valid. */
  title?: string | null;
  /** The author's display name (`AuthorName`, from `getAllBooks`'s join on `authors`), or null when LL omits
   *  it. Issue #665: read with `title` to find the row LL holds for a book a want's id no longer finds.
   *  Optional so structural stubs of this type stay valid. */
  author?: string | null;
  /** The EBOOK status string (LL `Status`) — null when LL omits it. */
  ebookStatus: string | null;
  /** The AUDIOBOOK status string (LL `AudioStatus`) — null when LL omits it. */
  audioStatus: string | null;
  /**
   * ADR-055 amendment (2026-09-22 — the push guard) — LL's EBOOK import date (`BookLibrary`): non-empty
   * exactly when LL's post-processor has filed an ebook copy into its library. Raw string; the domain
   * decides (the mapLlStatus precedent). Null when LL omits it or serves it empty.
   */
  ebookLibrary: string | null;
  /** The AUDIOBOOK import date (`AudioLibrary`) — same contract. */
  audioLibrary: string | null;
  /** The EBOOK's on-disk path (`BookFile`), when the build serves it — `getAllBooks` here does not. */
  ebookFile: string | null;
  /** The AUDIOBOOK's on-disk path (`AudioFile`), when the build serves it — `getAllBooks` here does not. */
  audioFile: string | null;
}

/**
 * ADR-059 / DESIGN-030 D-11 — a wanted BOOK (`cmd=getWanted` is the book list filtered to Wanted, not a
 * grab table). Feeds the Activity `searching` stage only.
 */
export interface LlWantedBook {
  bookId: string;
  /** The book's display title (`BookName`); '' when absent. */
  title: string;
  /** The EBOOK status string (`Status`) — 'Wanted' for every row `getWanted` returns. */
  ebookStatus: string | null;
  /** The AUDIOBOOK status string (`AudioStatus`) — 'Wanted' when the audio format is wanted too. */
  audioStatus: string | null;
  /** When LL added the book (`BookAdded`); null if absent. */
  addedAt: string | null;
}

/**
 * ADR-059 / DESIGN-030 D-11 — a normalized LazyLibrarian HISTORY row (`cmd=getHistory`: one row per grab
 * attempt). Raw status/source strings ride through; the domain owns the status → Activity stage mapping.
 * `NZBurl` is deliberately never read (it embeds the indexer apikey) and `DLResult` is sanitised.
 */
export interface LlHistoryEntry {
  bookId: string;
  /** The release/NZB title (display). */
  title: string;
  /** The per-grab status (Snatched / Failed / Processed / Seeding). */
  status: string;
  /** The download client the grab routed to (sabnzbd / qbittorrent / direct), lowercased; null if absent. */
  source: string | null;
  /** The client-side id — the SAB `nzo_id` / torrent hash (the join key to SAB); null if absent. */
  downloadId: string | null;
  /** The format the grab is for ('ebook' | 'audiobook'), mapped from `AuxInfo`; null if unmapped. */
  format: 'ebook' | 'audiobook' | null;
  /** The failure text (`DLResult`) on a Failed row — markup stripped, keys redacted; null otherwise/empty. */
  dlResult: string | null;
  /**
   * ADR-095 / DESIGN-046 D-18 — the recorded library destination: `DLResult` on a Processed or Seeding row, RAW (only
   * trimmed) and only when it is an absolute path, so the queue janitor can check the file on disk. The sanitized
   * `dlResult` collapses whitespace and cuts long values, which would miss real paths. Null otherwise.
   */
  destination?: string | null;
  /** When the grab was snatched (`NZBdate`, LL-local `YYYY-MM-DD HH:MM:SS`); null if absent. */
  snatchedAt: string | null;
  /** When the download finished (`Completed` epoch seconds → ISO); null while unfinished (`0`). */
  completedAt: string | null;
}

export class LazyLibrarianReadClient {
  private readonly http: LazyLibrarianHttp;

  constructor(options: LazyLibrarianClientOptions) {
    this.http = new LazyLibrarianHttp(options);
  }

  /**
   * `cmd=getAllBooks` — the per-format status of EVERY book LL tracks, keyed by BookID. The deployed LL
   * build has no `getBook` command (it answers `Unknown command`), so reconcile reads the whole list once
   * per sync run and looks books up locally. Returns an empty map on an unknown/error response (the domain
   * treats a missing entry as "LL doesn't know this book" and leaves the request untouched).
   *
   * Since the 2026-09-22 push guard this ONE read serves three consumers per run: the addBook seat gate
   * (DESIGN-039 D-18), the status reconcile, and the held-format push guard — so the guard costs zero
   * extra LL calls on both sync paths.
   */
  async getAllBookStatuses(): Promise<Map<string, LlBookStatus>> {
    const raw = await this.http.commandJson('getAllBooks', llGetAllBooksResponseSchema);
    const rows: LlBook[] = Array.isArray(raw)
      ? raw
      : raw != null && typeof raw === 'object' && 'data' in raw
        ? (raw as { data: LlBook[] }).data
        : [];
    const byId = new Map<string, LlBookStatus>();
    for (const row of rows) {
      if (row.BookID == null) continue;
      const bookId = String(row.BookID);
      byId.set(bookId, {
        bookId,
        title: blankToNull(row.BookName),
        author: blankToNull(row.AuthorName),
        ebookStatus: row.Status ?? null,
        audioStatus: row.AudioStatus ?? null,
        ebookLibrary: blankToNull(row.BookLibrary),
        audioLibrary: blankToNull(row.AudioLibrary),
        ebookFile: blankToNull(row.BookFile),
        audioFile: blankToNull(row.AudioFile),
      });
    }
    return byId;
  }

  /**
   * ADR-059 / DESIGN-030 D-11 — `cmd=getWanted` — the books LL currently wants (the Activity `searching`
   * stage). NOT a grab table: one BOOK row per book with `Status` Wanted. Tolerant of LL's array /
   * `{ data }` / error-string shapes (→ [] on an unknown/error response).
   */
  async getWanted(): Promise<LlWantedBook[]> {
    const raw = await this.http.commandJson('getWanted', llGetWantedResponseSchema);
    const rows: LlWantedRow[] = Array.isArray(raw)
      ? raw
      : raw != null && typeof raw === 'object' && 'data' in raw
        ? raw.data
        : [];
    const out: LlWantedBook[] = [];
    for (const r of rows) {
      if (r.BookID == null || String(r.BookID) === '') continue;
      out.push({
        bookId: String(r.BookID),
        title: (r.BookName ?? '').trim(),
        ebookStatus: r.Status ?? null,
        audioStatus: r.AudioStatus ?? null,
        addedAt: blankToNull(r.BookAdded),
      });
    }
    return out;
  }

  /**
   * ADR-059 / DESIGN-030 D-11 — `cmd=getHistory` — the snatch table, one row per grab attempt with
   * Snatched / Failed / Processed / Seeding status, source, `DownloadID`, format (`AuxInfo`), failure text
   * and completion time. The full log (it is never pruned and takes no filter), so callers reduce it to the
   * latest row per book+format. Tolerant of array / `{ data }` / error-string shapes (→ []). Rows without
   * a `BookID` are dropped.
   */
  async getHistory(): Promise<LlHistoryEntry[]> {
    const raw = await this.http.commandJson('getHistory', llGetHistoryResponseSchema);
    const rows: LlHistoryRow[] = Array.isArray(raw)
      ? raw
      : raw != null && typeof raw === 'object' && 'data' in raw
        ? raw.data
        : [];
    const out: LlHistoryEntry[] = [];
    for (const r of rows) {
      if (r.BookID == null || String(r.BookID) === '') continue;
      const completed = Number(r.Completed ?? 0);
      out.push({
        bookId: String(r.BookID),
        title: r.NZBtitle ?? '',
        status: (r.Status ?? '').trim(),
        source:
          r.Source != null && String(r.Source).trim() !== ''
            ? String(r.Source).trim().toLowerCase()
            : null,
        downloadId:
          r.DownloadID != null && String(r.DownloadID) !== '' ? String(r.DownloadID) : null,
        format: mapAuxFormat(r.AuxInfo),
        dlResult: sanitizeLlResult(r.DLResult),
        destination: rawDestination(r.Status, r.DLResult),
        snatchedAt: blankToNull(r.NZBdate),
        completedAt:
          Number.isFinite(completed) && completed > 0
            ? new Date(completed * 1000).toISOString()
            : null,
      });
    }
    return out;
  }
}

/**
 * LL's `DLResult` on a Failed row can embed the Prowlarr download URL — inside an HTML anchor, with its
 * `apikey=` — ("Failed to send nzb to @ <a href="...apikey=…">SABNZBD</a>"). It ends up in the failure
 * ledger and the UI, so strip markup, redact any key-shaped query parameter and bound the length.
 */
export function sanitizeLlResult(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw
    .replace(/<[^>]*>/g, '')
    .replace(/((?:api[_-]?key|apikey|token|passkey)=)[^&\s"'<>]*/gi, '$1REDACTED')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return null;
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

/** A Processed / Seeding row's `DLResult` when it is an absolute path (the recorded destination), else null. */
function rawDestination(status: string | null | undefined, raw: string | null | undefined): string | null {
  const st = (status ?? '').trim().toLowerCase();
  if (st !== 'processed' && st !== 'seeding') return null;
  const s = (raw ?? '').trim();
  return s.startsWith('/') ? s : null;
}

/** LL serves absent per-format file/library fields as `null`, `''` or `'None'` depending on the row age. */
function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value.trim();
  if (s === '' || s.toLowerCase() === 'none') return null;
  return s;
}

/** Map LL's `AuxInfo` format tag ('eBook'/'AudioBook') to our format union; null when unrecognized. */
function mapAuxFormat(aux: string | null | undefined): 'ebook' | 'audiobook' | null {
  if (!aux) return null;
  const s = aux.trim().toLowerCase();
  if (s === 'ebook') return 'ebook';
  if (s === 'audiobook') return 'audiobook';
  return null;
}

export function lazyLibrarianReadClient(
  options: LazyLibrarianClientOptions,
): LazyLibrarianReadClient {
  return new LazyLibrarianReadClient(options);
}
