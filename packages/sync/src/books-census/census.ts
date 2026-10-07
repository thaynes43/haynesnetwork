// DESIGN-028 amendment 2026-10-06 (the Books Census, glossary T-289; issues #744 and #781) — the observe-only census
// of the books estate. It flags, never acts: no source it reads is written, and nothing it finds is repaired here.
//
// Five kinds of finding, each keyed so a person can declare a hold on it (./holds.ts):
//   wrong_file      a LazyLibrarian book whose held file is another book (the Held File Check, T-290): the file's own
//                   title when it has one, else its folder and file name (`basis`)
//   missing_file    a LazyLibrarian book pointing at a file that is not on disk (a stale pointer reads as held)
//   foreign_held    a LazyLibrarian book holding a non-English file (F10): its text sample, else its declared language,
//                   else LazyLibrarian's own label when no file of that book reads English
//   foreign_wanted  a LazyLibrarian book labelled non-English that LazyLibrarian wants, or that an unparked app want with
//                   an open format points at (F10: nothing foreign is searched for)
//   foreign_item    a library item (Kavita, Audiobookshelf) whose language tag reads non-English (F10)
import {
  classifyBookLanguage,
  heldFileNameNamesBook,
  heldFileNameTitles,
  heldFileNamesBook,
  judgeableTitle,
  stripTrackMarkers,
  type LlBookNaming,
} from '@hnet/domain';
import type { FileMeta } from './file-meta';
import { classifyDeclaredLanguage, guessTextLanguage } from './language';
import { matchHold, type CensusHold } from './holds';

/** One LazyLibrarian `books` row, as the census reads it (LazyLibrarian's column names, joined with `authors`). */
export interface CensusLlBook {
  BookID: string;
  BookName: string | null;
  BookSub: string | null;
  BookLang: string | null;
  Status: string | null;
  AudioStatus: string | null;
  BookFile: string | null;
  AudioFile: string | null;
  AuthorName: string | null;
}

/** One app want (`book_requests`) with a LazyLibrarian id. */
export interface CensusWant {
  id: string;
  origin: string;
  ll_book_id: string;
  ebook_status: string;
  audio_status: string;
  unroutable_reason: string | null;
}

/** One live library item (`books_items`, not tombstoned, not a comic). */
export interface CensusItem {
  source: string;
  external_id: string;
  title: string;
  author: string | null;
  language: string | null;
}

export type CensusFormat = 'ebook' | 'audiobook';
export type CensusKind =
  'wrong_file' | 'missing_file' | 'foreign_held' | 'foreign_wanted' | 'foreign_item';
export const CENSUS_KINDS: readonly CensusKind[] = [
  'wrong_file',
  'missing_file',
  'foreign_held',
  'foreign_wanted',
  'foreign_item',
];

export interface CensusFinding {
  kind: CensusKind;
  /** The hold key: `<kind>:<llBookId>:<format>`, `foreign_wanted:<llBookId>`, `foreign_item:<source>:<externalId>`. */
  key: string;
  /** True when a declared hold covers it: reported, never alerted on. */
  held: boolean;
  holdReason?: string;
  llBookId?: string;
  format?: CensusFormat;
  title: string;
  author: string | null;
  /** The held file, relative to the books root. */
  path?: string;
  /** wrong_file: what decided it (the file's own title, or its name when it has none). */
  basis?: 'content' | 'name';
  /** The file's own title (wrong_file, foreign_held). */
  fileTitle?: string | null;
  /** The file's other titles (an audiobook's track title). */
  fileAltTitles?: string[];
  /** The titles the path gives (wrong_file). */
  nameTitles?: string[];
  /** foreign_*: the language signals: LazyLibrarian's label, the file's declared language, the text guess. */
  signals?: { label?: string | null; declared?: string | null; text?: string | null };
  /** The language a foreign finding is in. */
  language?: string | null;
  /** missing_file: LazyLibrarian's status for that format (lowercase). */
  llStatus?: string;
  /** foreign_wanted: the formats LazyLibrarian reads Wanted. */
  llWanted?: CensusFormat[];
  /** foreign_item: the library. */
  source?: string;
  externalId?: string;
  /** App wants pointing at this LazyLibrarian book (unparked): ids, first 8 characters. */
  wants?: string[];
}

export interface CensusSummary {
  llBooks: number;
  ebookFiles: number;
  audioFiles: number;
  /** Files whose own metadata was read. */
  read: number;
  /** Read, but with no title worth judging. */
  untitled: number;
  /** A kind the census does not read (PDF). */
  unsupported: number;
  /** Could not be parsed (the reason is in the debug lines). */
  unreadable: number;
  /** Files judged by content, and by name only. */
  judgedContent: number;
  judgedName: number;
  /** Findings no hold covers, per kind (what the alerts read). */
  wrongFile: number;
  missingFile: number;
  foreignHeld: number;
  foreignWanted: number;
  foreignItems: number;
  /** Findings a hold covers, per kind. */
  held: Record<CensusKind, number>;
  /** foreign_item per library (unheld). */
  foreignItemsBySource: Record<string, number>;
  /** Holds that matched nothing this run (stale: the finding is gone). */
  unusedHolds: string[];
}

export interface CensusInput {
  llBooks: readonly CensusLlBook[];
  wants: readonly CensusWant[];
  items: readonly CensusItem[];
  holds: readonly CensusHold[];
  /** Read what a held file says about itself (./file-meta.ts readFileMeta; a fake in tests). */
  readMeta: (path: string) => Promise<FileMeta>;
  /** The books root LazyLibrarian's paths start with, cut from reported paths. */
  booksRoot?: string;
  now?: Date;
  /** How many files are read at once (the share is NFS: latency, not CPU). */
  concurrency?: number;
  /** A per-file note for the debug log (unreadable reasons). */
  onFile?: (path: string, meta: FileMeta) => void;
}

export interface CensusResult {
  findings: CensusFinding[];
  summary: CensusSummary;
}

const short = (id: string): string => id.slice(0, 8);

/**
 * The content side of the Held File Check over every title a file carries. Its primary title (an EPUB's `dc:title`, an
 * audiobook's album tag) decides; its other titles (an audiobook's track title) can only clear it: an album tag is often
 * the series ("Shadowhunter Academy") while the track names the book ("07 Bitter of Tongue"), and track titles are too
 * often chapter names or codes ("01: High Chasaline", "WHITESAND01P04") to condemn a file.
 */
export function contentNamesBook(
  meta: FileMeta,
  book: LlBookNaming,
  authorTitles: readonly string[] = [],
): boolean | null {
  if (meta.status !== 'read') return null;
  const options = { series: meta.series, authorTitles };
  const primary = heldFileNamesBook(meta.title, book, options);
  if (primary === true) return true;
  const cleared = meta.altTitles.some(
    (t) => heldFileNamesBook(stripTrackMarkers(t), book, options) === true,
  );
  return cleared ? true : primary;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Run the census over one snapshot. Pure apart from `readMeta`. */
export async function runBooksCensus(input: CensusInput): Promise<CensusResult> {
  const now = input.now ?? new Date();
  const root = input.booksRoot ? input.booksRoot.replace(/\/?$/, '/') : null;
  const rel = (p: string): string => (root && p.startsWith(root) ? p.slice(root.length) : p);
  const findings: CensusFinding[] = [];
  const usedHolds = new Set<string>();
  const add = (f: Omit<CensusFinding, 'held'>, path?: string): void => {
    const hold = matchHold(input.holds, f.key, path ? rel(path) : undefined, now);
    if (hold) usedHolds.add(hold.key + (hold.path ? `@${hold.path}` : ''));
    findings.push({ ...f, held: hold !== null, ...(hold ? { holdReason: hold.reason } : {}) });
  };

  const wantsByBook = new Map<string, CensusWant[]>();
  for (const w of input.wants) {
    if (w.unroutable_reason) continue;
    const list = wantsByBook.get(w.ll_book_id) ?? [];
    list.push(w);
    wantsByBook.set(w.ll_book_id, list);
  }
  const wantIds = (id: string): string[] => (wantsByBook.get(id) ?? []).map((w) => short(w.id));
  // Issue #799: every title LazyLibrarian holds per author, so a cut title can tell a series name from a work's.
  const titlesByAuthor = new Map<string, string[]>();
  for (const b of input.llBooks) {
    if (!b.BookName?.trim()) continue;
    const key = (b.AuthorName ?? '').trim().toLowerCase();
    const list = titlesByAuthor.get(key) ?? [];
    list.push(b.BookName);
    titlesByAuthor.set(key, list);
  }

  const summary: CensusSummary = {
    llBooks: input.llBooks.length,
    ebookFiles: 0,
    audioFiles: 0,
    read: 0,
    untitled: 0,
    unsupported: 0,
    unreadable: 0,
    judgedContent: 0,
    judgedName: 0,
    wrongFile: 0,
    missingFile: 0,
    foreignHeld: 0,
    foreignWanted: 0,
    foreignItems: 0,
    held: { wrong_file: 0, missing_file: 0, foreign_held: 0, foreign_wanted: 0, foreign_item: 0 },
    foreignItemsBySource: {},
    unusedHolds: [],
  };

  // Every file LazyLibrarian points at, one read each.
  const files: { book: CensusLlBook; format: CensusFormat; path: string }[] = [];
  for (const book of input.llBooks) {
    if (book.BookFile?.trim()) files.push({ book, format: 'ebook', path: book.BookFile.trim() });
    if (book.AudioFile?.trim())
      files.push({ book, format: 'audiobook', path: book.AudioFile.trim() });
  }
  summary.ebookFiles = files.filter((f) => f.format === 'ebook').length;
  summary.audioFiles = files.length - summary.ebookFiles;
  const metas = await mapLimit(files, input.concurrency ?? 4, (f) => input.readMeta(f.path));

  // A record whose own file reads English (text or declared language) is not foreign by LazyLibrarian's label alone:
  // LazyLibrarian labels a record by the edition it resolved (Goldmann's German "Grey"), not by the file it holds.
  const textOf = (i: number): string | null =>
    files[i]!.format === 'ebook' ? guessTextLanguage(metas[i]!.textSample).language : null;
  const contentEnglish = new Set<string>();
  files.forEach(({ book }, i) => {
    const text = textOf(i);
    if (
      text === 'en' ||
      (text === null && classifyDeclaredLanguage(metas[i]!.language) === 'english')
    )
      contentEnglish.add(book.BookID);
  });

  files.forEach(({ book, format, path }, i) => {
    const meta = metas[i]!;
    input.onFile?.(path, meta);
    const naming = { title: book.BookName, subtitle: book.BookSub, author: book.AuthorName };
    const status =
      (format === 'ebook' ? book.Status : book.AudioStatus)?.trim().toLowerCase() ?? '';
    const base = {
      llBookId: book.BookID,
      format,
      title: book.BookName ?? '',
      author: book.AuthorName,
      path: rel(path),
      wants: wantIds(book.BookID),
    };
    if (meta.status === 'missing') {
      add(
        {
          kind: 'missing_file',
          key: `missing_file:${book.BookID}:${format}`,
          ...base,
          llStatus: status,
        },
        path,
      );
      return;
    }
    if (meta.status === 'unsupported') summary.unsupported += 1;
    else if (meta.status === 'unreadable') summary.unreadable += 1;
    else {
      summary.read += 1;
      if (!judgeableTitle(meta.title)) summary.untitled += 1;
    }

    // The Held File Check: the file's own title decides when it has one; its name otherwise.
    const content = contentNamesBook(
      meta,
      naming,
      titlesByAuthor.get((book.AuthorName ?? '').trim().toLowerCase()),
    );
    const byName = content === null ? heldFileNameNamesBook(path, naming) : null;
    if (content !== null) summary.judgedContent += 1;
    else if (byName !== null) summary.judgedName += 1;
    if (content === false || byName === false) {
      add(
        {
          kind: 'wrong_file',
          key: `wrong_file:${book.BookID}:${format}`,
          ...base,
          basis: content === false ? 'content' : 'name',
          fileTitle: meta.title,
          ...(meta.altTitles.length > 0 ? { fileAltTitles: meta.altTitles } : {}),
          nameTitles: heldFileNameTitles(path, book.AuthorName),
        },
        path,
      );
    }

    // F10 on a held file: the text sample decides when it says something, else the declared language, else the label.
    const text = textOf(i);
    const declared = meta.language;
    const label = book.BookLang;
    let language: string | null = null;
    if (text !== null) language = text === 'en' ? null : text;
    else if (classifyDeclaredLanguage(declared) !== 'unknown')
      language = classifyDeclaredLanguage(declared) === 'foreign' ? declared : null;
    else if (classifyBookLanguage(label) === 'foreign' && !contentEnglish.has(book.BookID))
      language = label;
    if (language !== null) {
      add(
        {
          kind: 'foreign_held',
          key: `foreign_held:${book.BookID}:${format}`,
          ...base,
          fileTitle: meta.title,
          language,
          signals: { label, declared, text },
        },
        path,
      );
    }
  });

  // F10 on what is searched for: a foreign-labelled book LazyLibrarian wants, or an unparked app want still asks for.
  for (const book of input.llBooks) {
    if (classifyBookLanguage(book.BookLang) !== 'foreign') continue;
    const llWanted: CensusFormat[] = [];
    if (book.Status?.trim() === 'Wanted') llWanted.push('ebook');
    if (book.AudioStatus?.trim() === 'Wanted') llWanted.push('audiobook');
    const open = (wantsByBook.get(book.BookID) ?? []).filter(
      (w) =>
        (w.ebook_status !== 'landed' && w.ebook_status !== 'missing') ||
        (w.audio_status !== 'landed' && w.audio_status !== 'missing'),
    );
    if (llWanted.length === 0 && open.length === 0) continue;
    add({
      kind: 'foreign_wanted',
      key: `foreign_wanted:${book.BookID}`,
      llBookId: book.BookID,
      title: book.BookName ?? '',
      author: book.AuthorName,
      language: book.BookLang,
      llWanted,
      wants: open.map((w) => short(w.id)),
    });
  }

  // F10 on the libraries' own tags.
  for (const item of input.items) {
    if (classifyBookLanguage(item.language) !== 'foreign') continue;
    add({
      kind: 'foreign_item',
      key: `foreign_item:${item.source}:${item.external_id}`,
      source: item.source,
      externalId: item.external_id,
      title: item.title,
      author: item.author,
      language: item.language,
    });
  }

  for (const f of findings) {
    if (f.held) {
      summary.held[f.kind] += 1;
      continue;
    }
    if (f.kind === 'wrong_file') summary.wrongFile += 1;
    else if (f.kind === 'missing_file') summary.missingFile += 1;
    else if (f.kind === 'foreign_held') summary.foreignHeld += 1;
    else if (f.kind === 'foreign_wanted') summary.foreignWanted += 1;
    else {
      summary.foreignItems += 1;
      const s = f.source ?? 'unknown';
      summary.foreignItemsBySource[s] = (summary.foreignItemsBySource[s] ?? 0) + 1;
    }
  }
  summary.unusedHolds = input.holds
    .filter((h) => !usedHolds.has(h.key + (h.path ? `@${h.path}` : '')))
    .map((h) => h.key);
  return { findings, summary };
}
