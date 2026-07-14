// ADR-055 / DESIGN-028 (PLAN-044) — the READ surface for LazyLibrarian (@hnet/lazylibrarian/read). Reads
// a book's per-format status for the goodreads-sync reconcile step (LL-status → per-format request-state
// happens in the domain). Import-unrestricted (reads are safe everywhere); the mutating surface lives in
// ./write and is import-confined to packages/domain (ADR-055, the @hnet/arr / @hnet/plex precedent).
import { LazyLibrarianHttp, type LazyLibrarianHttpOptions } from './http';
import { llBookSchema, llGetBookResponseSchema, type LlBook } from './schemas';

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
}

export function lazyLibrarianReadClient(
  options: LazyLibrarianClientOptions,
): LazyLibrarianReadClient {
  return new LazyLibrarianReadClient(options);
}
