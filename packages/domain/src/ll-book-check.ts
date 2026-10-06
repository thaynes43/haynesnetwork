// Issue #693 (DESIGN-028 amendment 2026-10-05) — is the LazyLibrarian book a want points at the book it asks for?
//
// A want reads `landed` from the per-format status of the LazyLibrarian book its `ll_book_id` names, and every push
// site queues that book. So a want pinned to ANOTHER volume ("Court of Thorns and Roses bk 2" on book 1's id) or
// ANOTHER work ("Terry Pratchett: The BBC Radio Drama Collection" on "Terry Pratchett's Discworld") reads landed for a
// book the library does not have, or sends LazyLibrarian after the wrong book. Two checks, both pure, both against the
// title LazyLibrarian holds for that id (`getAllBooks`'s `BookName` + `BookSub`, already in every run's snapshot):
//
//   • `llBookMismatch` — LENIENT, for a want whose title is its current identity. It names a mismatch only on clear
//     evidence (issue #739, DESIGN-028 amendment 2026-10-06, glossary T-280): the want names its volume and the book
//     names another; the want's series position and the book's disagree; or the book's title does not COVER the want's.
//     Covering means most of the want's distinctive words, not one shared word: two volumes of a series share the series
//     name ("Mistborn: Secret History" ⇄ "Mistborn: The Final Empire"). A book whose title only drops the want's
//     decoration or subtitle ("Caliban's War: The Expanse, Book 2" ⇄ "Caliban's War", "Picasso: A Biography" ⇄
//     "Picasso") is still the want's book.
//   • `llBookAuthorMismatch` — the Author Check (issue #771): LazyLibrarian credits the book to another author than the
//     want's. Titles alone cannot see it ("Gray Dawn" ⇄ Stewart Edward White's "The Gray Dawn").
//   • `llBookNamesTitle` — STRICT, for a want whose identity CHANGED since its id was resolved (its anchor was renamed
//     or turned out to hold another book). The old id was resolved for the old title, so it is kept only when the book
//     LazyLibrarian holds is named exactly like the new identity, decoration aside.
import { gbQueryTitle, titleVolumeNumbers, volumeNumbersAgree } from '@hnet/goodreads';

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

/** A plural and its singular are one word ("The Two Towers" ⇄ "Two Tower"); "-ss" words keep their ending. */
const stem = (w: string): string =>
  w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

const POSITION_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};
/** A whole number, never the integer part of "#2.5" (a novella between two volumes has no position of its own). */
const POSITION_NUMBER = `\\d{1,3}(?![.,]\\d)|${Object.keys(POSITION_WORDS).join('|')}`;
/** A series-position marker and its number: "Book 2", "bk 2", "Vol. 3", "Part Four", "No. 5", "Tome 2", "#6". */
const POSITION_MARKER = new RegExp(
  `(?:\\b(?:book|bk|vol|volume|part|no|number|nr|tome)\\b\\.?\\s*|#\\s*)(${POSITION_NUMBER})\\b`,
  'g',
);
const positionOf = (raw: string): number => POSITION_WORDS[raw] ?? Number(raw);
const hasPositionMarker = (s: string): boolean => new RegExp(POSITION_MARKER.source).test(s);
/** A part that ends in its volume: "Red Queen Novella #1", "Court of Thorns and Roses bk 2". */
const endsInPosition = (s: string): boolean =>
  new RegExp(`(?:${POSITION_MARKER.source})\\s*$`).test(s);
/** A title part that ends in a bare series index after words: "Wild Cards 2", "Chroniken der Unterwelt (4)". */
const SERIES_AND_NUMBER = /^(.*[a-z].*?)(?:\s+#?\s*|\s*[([#]\s*)(\d{1,3})\s*[)\]]?$/;
/** Where a title's parts meet: a colon, a spaced dash, or an alternative title ("The Hobbit, or There and Back Again"). */
const PART_BREAK = /\s*:\s*|\s+[-–—]\s+|[,;]\s*or,?\s+/;
/** A packaged set: its title names the series and the packaging, not a work ("Harry Potter Boxed Set, Books 1-5"). */
const PACKAGED_SET =
  /\b(?:box(?:ed)?\s*set|omnibus|bundle|books\s+\d{1,3}\s*[-–]\s*\d{1,3})\b|#\s*\d{1,3}\s*[-–]\s*\d{1,3}\b/;
/** Subtitle words that name a separate work, never a description of the same one ("The Duke and I: The 2nd Epilogue"). */
const SEPARATE_WORK = new Set([
  'epilogue',
  'prologue',
  'novella',
  'novelette',
  'prequel',
  'sequel',
  'companion',
  'bonus',
]);

/** The distinctive words of a title: no stop word, no number, no position marker, no word of either author's name. */
function distinctiveWords(title: string, authorWords: ReadonlySet<string>): string[] {
  const out = words(fold(title).replace(POSITION_MARKER, ' ')).filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !authorWords.has(w),
  );
  return [...new Set(out.map(stem))];
}

/** The book's full name as LazyLibrarian holds it: `BookName` and `BookSub` joined like a title and subtitle. */
function bookText(book: LlBookNaming): string {
  return [book.title, book.subtitle].filter((p): p is string => Boolean(p && p.trim())).join(': ');
}

/** A title cut into its work and its series decoration (`splitTitle`). */
interface TitleParts {
  /** The work's own title, in parts: what is left once the decoration is cut. */
  work: string[];
  /** The decoration's text: the series name with its index, an edition note. */
  decoration: string[];
  /** The series positions the decoration names ("(Harry Potter, #3)" → 3). */
  positions: Set<number>;
  /** The title's first part as written (decoration included): "Beacon 23" of "Beacon 23: The Complete Novel". */
  head: string;
  /** The series index of a head that is a series name and a number ("Wild Cards 2"), whether or not it was cut. */
  headNumber: number | null;
  /**
   * The whole title is a series designation, not a work's title: one part that names its volume ("Red Queen Novella
   * #1", "Wild Cards 2", "A Court of Thorns and Roses 6"), or a packaged set ("Harry Potter Boxed Set, Books 1-5").
   */
  designation: boolean;
}

/**
 * Cut a title into the work and its series decoration: the shapes `gbQueryTitle` strips and the ones it leaves.
 *   - A trailing parenthetical or bracket ("(Harry Potter, #3)", "[Summer, Book 1]", "(Unabridged)").
 *   - A leading series index ("Wheel of Time [09]: ", "Lily Bard #05 - ", "Expanse 05 - ", "02 - ").
 *   - A first part that is a series name and an index before a subtitle ("Wild Cards 2: Aces High", "Chroniken der
 *     Unterwelt (4): City of Fallen Angels"), unless the title names its volume elsewhere ("Beacon 23: Part Four:
 *     Company" is volume 4 of "Beacon 23").
 *   - A later part that positions the book in its series ("Caliban's War: The Expanse, Book 2", "The Way of Kings:
 *     Book One of the Stormlight Archive", "Aces Abroad: Wild Cards 4").
 * Pure.
 */
function splitTitle(title: string): TitleParts {
  const decoration: string[] = [];
  const positions = new Set<number>();
  const decorate = (part: string): void => {
    decoration.push(part);
    for (const m of part.matchAll(POSITION_MARKER)) positions.add(positionOf(m[1]!));
    const bare = /^\s*#?(\d{1,3})\s*$/.exec(part);
    if (bare) positions.add(Number(bare[1]));
  };
  const TRAILING = /\s*[([]([^()[\]]*)[)\]]\s*$/;
  let rest = fold(title).trim();
  for (let m = TRAILING.exec(rest); m && m.index > 0; m = TRAILING.exec(rest)) {
    decorate(m[1]!);
    rest = rest.slice(0, m.index).trim();
  }
  const prefix =
    /^.*?(?:\[\d{1,3}\]|#\d{1,3})\s*[-–:]\s+(?=\S)/.exec(rest) ??
    /^.+?\s\d{1,3}\s*[-–]\s+(?=\S)/.exec(rest) ??
    /^\d{1,3}\s*[-–.]\s+(?=\S)/.exec(rest);
  if (prefix) {
    decoration.push(prefix[0]);
    for (const n of prefix[0].match(/\d{1,3}/g) ?? []) positions.add(Number(n));
    rest = rest.slice(prefix[0].length).trim();
  }
  const parts = rest.split(PART_BREAK).filter((p) => p.length > 0);
  const namesVolume = titleVolumeNumbers(title).size > 0;
  const headIndexed = SERIES_AND_NUMBER.exec(parts[0] ?? '');
  const headNumber = headIndexed && !namesVolume ? Number(headIndexed[2]) : null;
  const work: string[] = [];
  parts.forEach((part, i) => {
    const indexed = SERIES_AND_NUMBER.exec(part);
    if (i === 0) {
      if (headNumber !== null && parts.length > 1) {
        decoration.push(headIndexed![1]!);
        positions.add(headNumber);
      } else work.push(part);
    } else if (hasPositionMarker(part)) decorate(part);
    else if (indexed) {
      decoration.push(indexed[1]!);
      positions.add(Number(indexed[2]));
    } else work.push(part);
  });
  const designation =
    PACKAGED_SET.test(fold(title)) ||
    (parts.length === 1 && (headNumber !== null || endsInPosition(parts[0]!)));
  return { work, decoration, positions, head: parts[0] ?? '', headNumber, designation };
}

/** Does a text name this number: bare ("Wild Cards 2: Aces High") or marked ("Book 2"), never as a count ("of 2")? */
function namesNumber(text: string, n: number): boolean {
  const tokens = fold(text).split(/[^a-z0-9]+/);
  return tokens.some((w, i) => /^\d{1,3}$/.test(w) && Number(w) === n && tokens[i - 1] !== 'of');
}

/** At least one of `wanted`, and at least `ratio` of them, are in `held`. */
const covers = (held: ReadonlySet<string>, wanted: readonly string[], ratio: number): boolean =>
  wanted.filter((w) => held.has(w)).length >= Math.max(1, Math.ceil(wanted.length * ratio));

/**
 * The lenient check (issue #739). `null` = nothing says the book is another one (including: no book, or a book with no
 * title). In order:
 *   1. `'volume'` when the want names its volume and the book names another, or none for a volume after the first
 *      (`volumeNumbersAgree`, the resolve's own guard; a whole title "Wild Cards 2" names volume 2 the same way).
 *   2. `'volume'` when the want's series position and the book's disagree ("Dune (Dune, #1)" ⇄ "Dune Messiah: Dune Book
 *      2"), unless the book's title has no word the want lacks: two sources number some series differently.
 *   3. A title that is only a series designation, on either side ("Red Queen Novella #1" ⇄ "Queen Song", "A Court of
 *      Thorns and Roses 6", "Harry Potter Boxed Set, Books 1-5"), has no work title to cover: one shared word is a
 *      match, as before #739.
 *   4. A match when the book's title COVERS the want's work title (its decoration cut): 60 percent of its distinctive
 *      words (the `gbResolveTitleMatches` ratio), and half of those that are not series-name words.
 *   5. A match when the book's title is the want's without its subtitle ("Picasso: A Biography" ⇄ "Picasso"): every
 *      word of the book's title is the want's, the book holds the want's whole first part (and its number, "Beacon 23:
 *      The Complete Novel" ⇄ "Beacon 23"), and the words it lacks do not name a separate work ("The 2nd Epilogue").
 *   6. Otherwise `'volume'` when the book's title is only the want's series name ("Wild Cards 2: Aces High" ⇄ "Wild
 *      Cards"), else `'work'`.
 */
export function llBookMismatch(
  want: { title: string; author: string | null },
  book: LlBookNaming | null | undefined,
): LlBookMismatch | null {
  if (!book) return null;
  const text = bookText(book);
  if (text.length === 0) return null;
  if (!volumeNumbersAgree(want.title, text)) return 'volume';
  const wantParts = splitTitle(want.title);
  const bare = wantParts.designation ? wantParts.headNumber : null;
  if (bare !== null && !namesNumber(text, bare) && (bare !== 1 || /\d/.test(text))) return 'volume';

  const authorWords = new Set([...words(want.author), ...words(book.author)]);
  const wanted = distinctiveWords(wantParts.work.join(' : '), authorWords);
  const seriesWords = new Set(distinctiveWords(wantParts.decoration.join(' : '), authorWords));
  const held = new Set(distinctiveWords(text, authorWords));
  const wantWords = new Set([...wanted, ...seriesWords]);
  const bookAddsNothing = [...held].every((w) => wantWords.has(w));

  const bookParts = splitTitle(text);
  const bookPositions = new Set(bookParts.positions);
  for (const m of fold(text).matchAll(POSITION_MARKER)) bookPositions.add(positionOf(m[1]!));
  if (wantParts.positions.size > 0 && bookPositions.size > 0) {
    const agree = [...wantParts.positions].some((n) => bookPositions.has(n));
    if (!agree && !bookAddsNothing) return 'volume';
  }

  if (wanted.length === 0 || held.size === 0) return null;
  if (wantParts.designation || bookParts.designation)
    return [...wantWords].some((w) => held.has(w)) ? null : 'work';
  const core = wanted.filter((w) => !seriesWords.has(w));
  if (covers(held, wanted, 0.6) && covers(held, core.length > 0 ? core : wanted, 0.5)) return null;

  const head = distinctiveWords(wantParts.head, authorWords);
  const lacking = [...wantWords].filter((w) => !held.has(w));
  if (
    bookAddsNothing &&
    head.length > 0 &&
    head.every((w) => held.has(w)) &&
    (wantParts.headNumber === null || namesNumber(text, wantParts.headNumber)) &&
    !lacking.some((w) => SEPARATE_WORK.has(w))
  ) {
    return null;
  }
  return [...held].every((w) => seriesWords.has(w)) ? 'volume' : 'work';
}

/** Name parts that say nothing about who wrote a book. */
const NAME_NOISE = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'dr', 'mr', 'mrs', 'ms', 'sir', 'dame', 'phd', 'md']);

/** The parts of an author's name that can agree with another credit: two letters or more, no title or suffix. */
const nameTokens = (name: string): string[] =>
  words(name).filter((w) => w.length >= 2 && !NAME_NOISE.has(w));

/**
 * Issue #771 (DESIGN-028 amendment 2026-10-06, glossary T-286) — the Author Check: does LazyLibrarian credit the want's
 * book to another author? True only when both name an author and no credit of the want's (a comma, semicolon, "&" or
 * "and" list) has LazyLibrarian's `AuthorName`'s surname (its last name part, a title or suffix aside), nor does either
 * surname appear run together in the other ("Le Guin" and "LeGuin"). A shared first name is no agreement ("Rick
 * Riordan" and "Rick Harrison"). "Gray Dawn" (Walter Mosley) on Stewart Edward White's "The Gray Dawn" is another
 * work; "J.R.R. Tolkien" and "J. R. R. Tolkien", or "Hunters of Dune" by Brian Herbert in Frank Herbert's series, are
 * not. No author on either side decides nothing, so a want whose member carries none is never judged by it. Pure.
 */
export function llBookAuthorMismatch(
  wantAuthor: string | null | undefined,
  book: LlBookNaming | null | undefined,
): boolean {
  const theirs = book?.author?.trim();
  if (!wantAuthor?.trim() || !theirs) return false;
  const credits = wantAuthor
    .split(/\s*(?:[,;&]|\band\b)\s*/i)
    .map((c) => c.trim())
    .filter((c) => nameTokens(c).length > 0);
  if (credits.length === 0 || nameTokens(theirs).length === 0) return false;
  const squash = (name: string): string => nameTokens(name).join('');
  const surname = (name: string): string => nameTokens(name).at(-1) ?? '';
  const theirSurname = surname(theirs);
  const agrees = (credit: string): boolean => {
    const ours = surname(credit);
    return (
      ours === theirSurname ||
      (ours.length >= 4 && squash(theirs).includes(ours)) ||
      (theirSurname.length >= 4 && squash(credit).includes(theirSurname))
    );
  };
  return !credits.some(agrees);
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
