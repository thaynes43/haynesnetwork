// ADR-055 / DESIGN-028 (PLAN-044) — the READ surface for LazyLibrarian (@hnet/lazylibrarian/read). Reads
// a book's per-format status for the goodreads-sync reconcile step (LL-status → per-format request-state
// happens in the domain). Import-unrestricted (reads are safe everywhere); the mutating surface lives in
// ./write and is import-confined to packages/domain (ADR-055, the @hnet/arr / @hnet/plex precedent).
import { LazyLibrarianHttp, type LazyLibrarianHttpOptions } from './http';
import {
  llBookSchema,
  llGetBookResponseSchema,
  llGetWantedResponseSchema,
  type LlBook,
  type LlWantedRow,
} from './schemas';

/** Options shared by the read + write clients (mirrors PlexClientOptions). */
export type LazyLibrarianClientOptions = LazyLibrarianHttpOptions;

/** A book's raw LL per-format status (the strings LL reports; the domain maps them). */
export interface LlBookStatus {
  bookId: string;
  /** The EBOOK status string (LL `Status`) — null when LL omits it. */
  ebookStatus: string | null;
  /** The AUDIOBOOK status string (LL `AudioStatus`) — null when LL omits it. */
  audioStatus: string | null;
}

/**
 * ADR-059 / DESIGN-030 (PLAN-048) — a normalized LazyLibrarian wanted-table row (the acquisition worklist).
 * Raw status/source strings ride through; the domain owns the status → Activity stage mapping.
 */
export interface LlWantedEntry {
  bookId: string;
  /** The release/NZB title (display fallback). */
  title: string;
  /** The per-grab wanted status (Wanted / Snatched / Processed / Failed). */
  status: string;
  /** The download client the grab routed to (SABNZBD / NZB / TORRENT / DIRECT), lowercased; null if absent. */
  source: string | null;
  /** The client-side id — the SAB `nzo_id` / torrent hash (the join key to SAB); null if absent. */
  downloadId: string | null;
  /** The format the grab is for ('ebook' | 'audiobook'), mapped from `AuxInfo`; null if unmapped. */
  format: 'ebook' | 'audiobook' | null;
  /** The LL post-process failure text (`DLResult`), when the grab failed. */
  dlResult: string | null;
  /** When the grab was snatched (`NZBdate`) — the staleness signal for strand detection; null if absent. */
  snatchedAt: string | null;
}

/** Pull the first LlBook out of the several response shapes LL builds (object / {data} / array). */
function extractBook(raw: unknown): LlBook | null {
  if (raw == null || typeof raw === 'string') return null;
  if (Array.isArray(raw)) return raw.length > 0 ? (raw[0] as LlBook) : null;
  const obj = raw as Record<string, unknown>;
  if ('data' in obj) {
    const data = obj.data;
    if (Array.isArray(data)) return data.length > 0 ? (data[0] as LlBook) : null;
    const parsed = llBookSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
  const parsed = llBookSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

export class LazyLibrarianReadClient {
  private readonly http: LazyLibrarianHttp;

  constructor(options: LazyLibrarianClientOptions) {
    this.http = new LazyLibrarianHttp(options);
  }

  /**
   * `cmd=getBook&id=<bookId>` — the current per-format status of a book LL knows. Returns null when LL has
   * no such book (unknown id / error response). The status strings are returned RAW for the domain to map.
   */
  async getBook(bookId: string): Promise<LlBookStatus | null> {
    const raw = await this.http.commandJson('getBook', llGetBookResponseSchema, { id: bookId });
    const book = extractBook(raw);
    if (!book) return null;
    return {
      bookId: book.BookID != null ? String(book.BookID) : bookId,
      ebookStatus: book.Status ?? null,
      audioStatus: book.AudioStatus ?? null,
    };
  }

  /**
   * ADR-059 / DESIGN-030 (PLAN-048) — `cmd=getWanted` — the wanted-table worklist (the Activity books
   * adapter's LL half). Returns every current grab attempt with its status/source/DownloadID/format, so the
   * domain can pair a `Snatched` row to its SAB job (via `downloadId`) and detect strands. Tolerant of LL's
   * array / `{ data }` / error-string shapes (→ [] on an unknown/error response). Format from `AuxInfo`.
   */
  async getWanted(): Promise<LlWantedEntry[]> {
    const raw = await this.http.commandJson('getWanted', llGetWantedResponseSchema);
    const rows: LlWantedRow[] = Array.isArray(raw)
      ? raw
      : raw != null && typeof raw === 'object' && 'data' in raw
        ? raw.data
        : [];
    return rows.map((r) => ({
      bookId: r.BookID != null ? String(r.BookID) : '',
      title: r.NZBtitle ?? '',
      status: (r.Status ?? '').trim(),
      source: r.Source != null ? String(r.Source).trim().toLowerCase() : null,
      downloadId: r.DownloadID != null && String(r.DownloadID) !== '' ? String(r.DownloadID) : null,
      format: mapAuxFormat(r.AuxInfo),
      dlResult: r.DLResult != null && r.DLResult !== '' ? r.DLResult : null,
      snatchedAt: r.NZBdate != null && r.NZBdate !== '' ? r.NZBdate : null,
    }));
  }
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
