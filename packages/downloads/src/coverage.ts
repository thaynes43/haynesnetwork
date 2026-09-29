// DESIGN-046 D-22 (issue #621) — the content check behind the janitor's LazyLibrarian `leftover` class. D-18 rule 5
// proved that a recorded library destination EXISTS; it never proved that it holds the folder's book. LazyLibrarian
// tracks some series as one book, so every grab of a volume overwrote the same destination: the census counted eight
// folders of volume 3 as leftovers although the destination held volume 6 and the folders were the only copy.
//
// The ruling: a folder is a leftover only when EVERY book file in it (audio or eBook, anywhere in the folder) has a
// counterpart among the files of its destinations' directories. The counterpart depends on the format, because
// LazyLibrarian keeps audio names and renames every eBook file to `<title> - <author>.<ext>`
// (`_process_destination`, `_get_dest_filename`):
//
//   - audio: the same file name and the same byte size. Size alone is no identity for audio: parts ripped at a
//     constant bitrate and split at fixed lengths are the same size across different books, and the audio folder of
//     a series tracked as one book mixes volumes.
//   - eBook: the same extension and the same byte size, any name (the name can never match).
//
// Anything else (no book file, an archive left behind, a symlinked book file, an unreadable or oversized folder) is
// not covered, so the census reports it and never deletes it. This module is pure; the IO is
// `DownloadPathProbe.folderCoverage` (./paths).
import { basename, extname } from 'node:path';

/** Audio formats a download folder can hold (LazyLibrarian's `audiobook_type` and the other common ones). */
export const AUDIO_BOOK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.m4a',
  '.m4b',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.wav',
  '.aax',
  '.aa',
  '.mka',
]);

/** eBook formats (LazyLibrarian's `ebook_type`, the Kindle and comic containers, and the other common ones). */
export const EBOOK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.epub',
  '.kepub',
  '.mobi',
  '.azw',
  '.azw3',
  '.azw4',
  '.kfx',
  '.pdf',
  '.fb2',
  '.djvu',
  '.lit',
  '.lrf',
  '.pdb',
  '.prc',
  '.rtf',
  '.doc',
  '.docx',
  '.cbz',
  '.cbr',
  '.cb7',
  '.cbt',
]);

/** Archives: LazyLibrarian unpacks them, so one left behind may hold anything and cannot be compared. */
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz']);
/** Split RAR volumes (`.r00`, `.r01` …) and numbered 7z/zip parts (`.001` …). */
const ARCHIVE_PART = /^\.(?:r\d{2,3}|\d{3})$/;

export type BookFileKind = 'audio' | 'ebook' | 'archive' | 'other';

/** What a file in a download folder is, by its extension (case-insensitive). Everything unlisted (nfo, jpg, sfv,
 *  diz, url, m3u, txt, opf, par2 …) is `other` and is not compared. Pure. */
export function bookFileKind(name: string): BookFileKind {
  const ext = extname(name).toLowerCase();
  if (AUDIO_BOOK_EXTENSIONS.has(ext)) return 'audio';
  if (EBOOK_EXTENSIONS.has(ext)) return 'ebook';
  if (ARCHIVE_EXTENSIONS.has(ext) || ARCHIVE_PART.test(ext)) return 'archive';
  return 'other';
}

/** One file found in the download folder: its path relative to the folder, its size, and whether it is a regular
 *  file (false for a symlink or anything else that is not a plain file). */
export interface FolderFile {
  path: string;
  size: number;
  regular: boolean;
}

/** One regular file in a destination's directory (the top level only). */
export interface LibraryFile {
  name: string;
  size: number;
}

/** Why a folder is not covered (each has its own report-only reason in the census, DESIGN-046 D-22 rule 5). */
export type FolderCoverageGap = 'not_matched' | 'no_book_file' | 'archive' | 'unreadable';

export type FolderCoverage =
  | { covered: true; bookFiles: number }
  | { covered: false; gap: FolderCoverageGap; bookFiles: number; unmatched: number };

/**
 * Compare a download folder's files with its destinations' files (DESIGN-046 D-22). Covered only when the folder
 * holds at least one book file, no archive, and every book file has its counterpart: audio by name and size, eBook
 * by extension and size. A book file that is not a regular file (a symlink) never matches. Pure.
 */
export function compareFolderToLibrary(folder: FolderFile[], library: LibraryFile[]): FolderCoverage {
  const books = folder.filter((f) => {
    const kind = bookFileKind(f.path);
    return kind === 'audio' || kind === 'ebook';
  });
  if (folder.some((f) => bookFileKind(f.path) === 'archive')) {
    return { covered: false, gap: 'archive', bookFiles: books.length, unmatched: books.length };
  }
  if (books.length === 0) return { covered: false, gap: 'no_book_file', bookFiles: 0, unmatched: 0 };

  const byName = new Map<string, Set<number>>();
  const byExtension = new Map<string, Set<number>>();
  for (const f of library) {
    const nameSizes = byName.get(f.name) ?? new Set<number>();
    nameSizes.add(f.size);
    byName.set(f.name, nameSizes);
    const ext = extname(f.name).toLowerCase();
    const extSizes = byExtension.get(ext) ?? new Set<number>();
    extSizes.add(f.size);
    byExtension.set(ext, extSizes);
  }

  let unmatched = 0;
  for (const f of books) {
    const matched =
      f.regular &&
      (bookFileKind(f.path) === 'audio'
        ? (byName.get(basename(f.path))?.has(f.size) ?? false)
        : (byExtension.get(extname(f.path).toLowerCase())?.has(f.size) ?? false));
    if (!matched) unmatched += 1;
  }
  return unmatched === 0
    ? { covered: true, bookFiles: books.length }
    : { covered: false, gap: 'not_matched', bookFiles: books.length, unmatched };
}
