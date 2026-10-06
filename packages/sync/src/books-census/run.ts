// DESIGN-028 amendment 2026-10-06 (the Books Census) — one census pass: read the snapshot (LazyLibrarian's database
// read-only, the app's Postgres through a read-only session), read each held file's metadata from the share (mounted
// read-only), run the census, log. The sources are the owed-check runner's (DESIGN-053 D-04), opened the same way.
import type { SyncLogger } from '../logger';
import { openAppDb, openLlDb } from '../owed-checks/sources';
import { loadTrackerText } from '../owed-checks/tracker';
import {
  runBooksCensus,
  type CensusFinding,
  type CensusItem,
  type CensusKind,
  type CensusLlBook,
  type CensusSummary,
  type CensusWant,
} from './census';
import { readFileMeta, type FileMeta } from './file-meta';
import { parseHolds, type CensusHold } from './holds';

export interface CensusPassConfig {
  /** LazyLibrarian's database file (opened mode=ro, query_only). */
  llDbPath: string;
  /** The app's Postgres, pointed at the read-only service. Absent: no app reads (wants and library tags skipped). */
  databaseUrl?: string;
  /** Where the holds file is: a URL (main on GitHub) or a path. Absent: no holds. */
  holds?: string;
  /** The books root LazyLibrarian's paths start with. */
  booksRoot: string;
  readMeta?: (path: string) => Promise<FileMeta>;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface CensusPassResult {
  findings: CensusFinding[];
  summary: CensusSummary;
}

export const LL_BOOKS_SQL = `select b.BookID as BookID, b.BookName as BookName, b.BookSub as BookSub, b.BookLang as BookLang,
  b.Status as Status, b.AudioStatus as AudioStatus, b.BookFile as BookFile, b.AudioFile as AudioFile,
  a.AuthorName as AuthorName
  from books b left join authors a on a.AuthorID = b.AuthorID`;

export const APP_WANTS_SQL = `select id::text as id, origin, ll_book_id, ebook_status, audio_status, unroutable_reason
  from book_requests where ll_book_id is not null and comic_status is null`;

export const APP_ITEMS_SQL = `select source, external_id, title, author, attrs ->> 'language' as language
  from books_items where deleted_at is null and media_kind <> 'comic'`;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** How many sample titles the summary line carries per kind. */
const SAMPLES = 5;

/** One census pass. Logs `books_census_finding` per finding and one `books_census` line; returns what it found. */
export async function runCensusPass(
  config: CensusPassConfig,
  log: SyncLogger,
): Promise<CensusPassResult> {
  const started = Date.now();
  let holds: CensusHold[] = [];
  let holdsStatus = 'none';
  if (config.holds) {
    try {
      holds = parseHolds(await loadTrackerText(config.holds, config.fetchImpl));
      holdsStatus = 'ok';
    } catch (error) {
      // An unreadable holds file over-reports (every finding alerts) rather than hiding one.
      holdsStatus = 'error';
      log.error('books_census_holds_invalid', {
        holds: config.holds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ll = openLlDb(config.llDbPath);
  let llBooks: CensusLlBook[];
  try {
    llBooks = ll.query(LL_BOOKS_SQL).map((r) => ({
      BookID: String(r.BookID),
      BookName: str(r.BookName),
      BookSub: str(r.BookSub),
      BookLang: str(r.BookLang),
      Status: str(r.Status),
      AudioStatus: str(r.AudioStatus),
      BookFile: str(r.BookFile),
      AudioFile: str(r.AudioFile),
      AuthorName: str(r.AuthorName),
    }));
  } finally {
    ll.close();
  }

  let wants: CensusWant[] = [];
  let items: CensusItem[] = [];
  let appDbStatus = 'none';
  if (config.databaseUrl) {
    try {
      const app = await openAppDb(config.databaseUrl, 'books-census');
      try {
        wants = (await app.query(APP_WANTS_SQL)).map((r) => ({
          id: String(r.id),
          origin: String(r.origin),
          ll_book_id: String(r.ll_book_id),
          ebook_status: String(r.ebook_status),
          audio_status: String(r.audio_status),
          unroutable_reason: str(r.unroutable_reason),
        }));
        items = (await app.query(APP_ITEMS_SQL)).map((r) => ({
          source: String(r.source),
          external_id: String(r.external_id),
          title: String(r.title),
          author: str(r.author),
          language: str(r.language),
        }));
      } finally {
        await app.close().catch(() => {});
      }
      appDbStatus = 'ok';
    } catch (error) {
      // LazyLibrarian's side still runs; the summary says the app side did not.
      appDbStatus = 'error';
      wants = [];
      items = [];
      log.error('books_census_app_db_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unreadable: { path: string; error: string }[] = [];
  const { findings, summary } = await runBooksCensus({
    llBooks,
    wants,
    items,
    holds,
    readMeta: config.readMeta ?? readFileMeta,
    booksRoot: config.booksRoot,
    ...(config.now ? { now: config.now } : {}),
    onFile: (path, meta) => {
      if (meta.status === 'unreadable') unreadable.push({ path, error: meta.error ?? '' });
    },
  });

  for (const f of findings) log.info('books_census_finding', { ...f });
  if (unreadable.length > 0) {
    log.warn('books_census_unreadable', {
      count: unreadable.length,
      sample: unreadable.slice(0, 20).map((u) => ({
        path: u.path.startsWith(config.booksRoot)
          ? u.path.slice(config.booksRoot.replace(/\/?$/, '/').length)
          : u.path,
        error: u.error.slice(0, 160),
      })),
    });
  }
  const samples: Partial<Record<CensusKind, string[]>> = {};
  for (const f of findings) {
    if (f.held) continue;
    const list = (samples[f.kind] ??= []);
    if (list.length < SAMPLES) list.push(`${f.title}${f.author ? ` (${f.author})` : ''}`);
  }
  log.info('books_census', {
    ...summary,
    holds: holdsStatus,
    holdCount: holds.length,
    appDb: appDbStatus,
    samples,
    durationMs: Date.now() - started,
  });
  return { findings, summary };
}
