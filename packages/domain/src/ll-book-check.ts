// Issue #693 (DESIGN-028 amendment 2026-10-05) — is the LazyLibrarian book a want points at the book it asks for?
//
// A want reads `landed` from the per-format status of the LazyLibrarian book its `ll_book_id` names, and every push
// site queues that book. So a want pinned to ANOTHER volume ("Court of Thorns and Roses bk 2" on book 1's id) or
// ANOTHER work ("Terry Pratchett: The BBC Radio Drama Collection" on "Terry Pratchett's Discworld") reads landed for a
// book the library does not have, or sends LazyLibrarian after the wrong book. Two checks, both pure, both against the
// title LazyLibrarian holds for that id (`getAllBooks`'s `BookName` + `BookSub`, already in every run's snapshot):
//
//   • `llBookMismatch` — LENIENT, for a want whose title is its current identity. It names a mismatch only on clear
//     evidence: the want names its volume and the book names a different one (or none, for a volume after the first),
//     or the two titles share no distinctive word once the authors' names are set aside. Anything less is a match:
//     a book whose title merely differs in decoration ("Caliban's War: The Expanse, Book 2" ⇄ "Caliban's War") is the
//     want's book, so this check can only clear a pointer that is plainly wrong.
//   • `llBookNamesTitle` — STRICT, for a want whose identity CHANGED since its id was resolved (its anchor was renamed
//     or turned out to hold another book). The old id was resolved for the old title, so it is kept only when the book
//     LazyLibrarian holds is named exactly like the new identity, decoration aside.
import { gbQueryTitle, volumeNumbersAgree } from '@hnet/goodreads';

/** The part of a LazyLibrarian `getAllBooks` row these checks read (a structural subset of the ACL's row). */
export interface LlBookNaming {
  /** LazyLibrarian's `BookName`. */
  title?: string | null;
  /** LazyLibrarian's `BookSub`. */
  subtitle?: string | null;
  /** LazyLibrarian's `AuthorName`. */
  author?: string | null;
}

/** Why the book is not the want's: another volume of it, or another work. */
export type LlBookMismatch = 'volume' | 'work';

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]s\b/g, '')
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ');

/** Words that say nothing about which work a title names. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'from',
  'vol',
  'volume',
  'part',
  'book',
  'bk',
  'no',
  'edition',
  'novel',
  'unabridged',
  'abridged',
  'series',
]);

const words = (s: string | null | undefined): string[] =>
  fold(s ?? '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

/** The distinctive words of a title: no stop word, no number, no word of either author's name. */
function distinctiveWords(title: string, authorWords: ReadonlySet<string>): string[] {
  return words(title).filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !authorWords.has(w),
  );
}

/** The book's full name as LazyLibrarian holds it: `BookName` and `BookSub` joined like a title and subtitle. */
function bookText(book: LlBookNaming): string {
  return [book.title, book.subtitle].filter((p): p is string => Boolean(p && p.trim())).join(': ');
}

/**
 * The lenient check. `null` = nothing says the book is another one (including: no book, or a book with no title).
 * `'volume'` = the want names its volume and the book names another, or none for a volume after the first
 * (`volumeNumbersAgree`, the resolve's own guard). `'work'` = no distinctive word in common.
 */
export function llBookMismatch(
  want: { title: string; author: string | null },
  book: LlBookNaming | null | undefined,
): LlBookMismatch | null {
  if (!book) return null;
  const text = bookText(book);
  if (text.length === 0) return null;
  if (!volumeNumbersAgree(want.title, text)) return 'volume';
  const authorWords = new Set([...words(want.author), ...words(book.author)]);
  // The want side drops its series decoration first ("(Crowns of Nyaxia, #1)", "Lily Bard #05 - "), so a series
  // name shared with the book cannot pass for the work.
  const wanted = distinctiveWords(gbQueryTitle(want.title), authorWords);
  const held = new Set(distinctiveWords(text, authorWords));
  if (wanted.length === 0 || held.size === 0) return null;
  return wanted.some((w) => held.has(w)) ? null : 'work';
}

const NOISE_WORDS = new Set(['a', 'an', 'the', 'novel', 'unabridged', 'abridged', 'edition']);

/** The strict title key: decoration stripped (`gbQueryTitle`), punctuation and the edition-noise words dropped. */
export function workTitleKey(title: string | null | undefined): string {
  if (!title) return '';
  return words(gbQueryTitle(title))
    .filter((w) => !NOISE_WORDS.has(w))
    .join(' ');
}

/** The strict check: does LazyLibrarian hold this book under exactly this title (by itself, or with its subtitle)? */
export function llBookNamesTitle(title: string, book: LlBookNaming | null | undefined): boolean {
  if (!book) return false;
  const key = workTitleKey(title);
  if (key.length === 0) return false;
  return workTitleKey(book.title) === key || workTitleKey(bookText(book)) === key;
}
