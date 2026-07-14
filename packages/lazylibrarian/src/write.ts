// @hnet/lazylibrarian/write — the WRITE surface (ADR-055 / DESIGN-028, read/write split). The ONLY
// sanctioned LazyLibrarian write-backs are the PLAN-044 acquisition pushes: add a book by its resolved id,
// mark a format Wanted (queueBook — MANDATORY after addBook, which alone lands the book `Skipped`), and
// trigger a search (searchBook). This entrypoint may be imported ONLY by the packages/domain goodreads
// orchestrator and by packages/lazylibrarian itself — enforced by the arr-write-import-guard test
// (extended for @hnet/lazylibrarian/write). It NEVER touches LL provider config (Prowlarr fullSync owns
// that — OPS-013 / PLAN-044 hard constraint); it only drives the per-book acquisition state machine.
import { LazyLibrarianHttp } from './http';
import type { LazyLibrarianClientOptions } from './read';

/** The two book formats LL tracks as separate per-book statuses (Status vs AudioStatus). */
export type LlFormat = 'ebook' | 'audiobook';

/** Map our format to LL's DLTYPES vocabulary ('E'/'A' → eBook/AudioBook). */
function llTypeParam(format: LlFormat): string {
  return format === 'audiobook' ? 'AudioBook' : 'eBook';
}

export class LazyLibrarianWriteClient {
  private readonly http: LazyLibrarianHttp;

  constructor(options: LazyLibrarianClientOptions) {
    this.http = new LazyLibrarianHttp(options);
  }

  /**
   * `cmd=addBook&id=<bookId>` — add a book to LL by its resolved id (the Google-Books volume id the
   * goodreads-sync enrichment derived). addBook ALONE lands the book `Skipped` — the caller MUST follow
   * with queueBook to reach `Wanted` (the F-10 field lesson, R2). Returns the ack text.
   */
  async addBook(bookId: string): Promise<string> {
    return this.http.commandText('addBook', { id: bookId });
  }

  /**
   * `cmd=queueBook&id=<bookId>&type=<eBook|AudioBook>` — mark the given FORMAT Wanted (the mandatory
   * step after addBook). Every request queues BOTH formats (owner ruling — "we grab both so it's one for
   * all"): the orchestrator calls this once per format.
   */
  async queueBook(bookId: string, format: LlFormat): Promise<string> {
    return this.http.commandText('queueBook', { id: bookId, type: llTypeParam(format) });
  }

  /**
   * `cmd=searchBook&id=<bookId>&type=<eBook|AudioBook>` — trigger a real search for the given format
   * (usenet-first via LL's own dlpriority + the PLAN-039 governor at the Prowlarr seam — this app never
   * bypasses provider selection). This is the write the manual "Search again" fires (R3 / AC-04) and the
   * final step of the initial push. `searchItem` is NOT a title search — this is the id-keyed search.
   */
  async searchBook(bookId: string, format: LlFormat): Promise<string> {
    return this.http.commandText('searchBook', { id: bookId, type: llTypeParam(format) });
  }

  /**
   * ADR-059 / DESIGN-030 (PLAN-048 — Activity retry-import) — `cmd=forceProcess` re-runs LazyLibrarian's
   * post-processor over its download dir, importing any completed-but-stranded grabs (the in-app analog of
   * the OPS-013 §11.3 break-glass `forceProcess`). This is the write the Admin "Retry import" fires on a
   * stranded/postprocess-failed book. Read-only to LL's PROVIDER config (never touches it — Prowlarr's
   * fullSync owns that, OPS-013 hard constraint); it only nudges the import worklist. Returns the ack text.
   */
  async forceProcess(): Promise<string> {
    return this.http.commandText('forceProcess');
  }
}

export function lazyLibrarianWriteClient(
  options: LazyLibrarianClientOptions,
): LazyLibrarianWriteClient {
  return new LazyLibrarianWriteClient(options);
}
