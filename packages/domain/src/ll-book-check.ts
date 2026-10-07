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
const NAME_NOISE = new Set([
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'dr',
  'mr',
  'mrs',
  'ms',
  'sir',
  'dame',
  'phd',
  'md',
]);

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

// ---------------------------------------------------------------------------------------------------------------------
// Issues #781 / #744 (DESIGN-028 amendment 2026-10-06, glossary T-290) — the Held File Check: is the file LazyLibrarian
// holds for a book that book? LazyLibrarian imported the four-story collection as "Four: The Traitor" and linked *First
// Shift: Legacy* as "Shift"; both share the record's words, so the lenient check alone passes them. The file's own title
// (an EPUB's OPF `dc:title`, a MOBI's EXTH title, an audiobook's album tag) or its name is compared with the record.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Words that say how a file is packaged or sold, never which work it holds ("Shift Omnibus Edition", "(Kindle Single)").
 * Stemmed like `distinctiveWords` ("omnibus" is "omnibu" there).
 */
const PACKAGING_WORDS = new Set(
  [
    'omnibus',
    'edition',
    'kindle',
    'single',
    'complete',
    'ebook',
    'epub',
    'retail',
    'audiobook',
    'unabridged',
    'abridged',
    'deluxe',
    'illustrated',
    'anniversary',
    'box',
    'boxed',
    'set',
  ].map((w) => stem(w)),
);

/** A word before a period that is an abbreviation, not the end of a title part ("Mr. Mercedes", "St. Lucy"). */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'jr',
  'sr',
  'vs',
  'no',
  'vol',
  'mt',
  'ft',
  'lt',
  'col',
  'gen',
  'capt',
  'prof',
  'rev',
]);

/** Titles a tool writes when it knows none ("Unknown" is calibre's), or that credit a reader: no title to judge. */
const PLACEHOLDER_TITLES = new Set([
  'unknown',
  'untitled',
  'ebook',
  'book',
  'audiobook',
  'no title',
  'title',
]);
const PLACEHOLDER_START = /^(?:read|narrated|performed)\s+by\b/;

/**
 * LazyLibrarian writes a title's colon as a period ("Four. The Traitor", "The World of Divergent. The Path to
 * Allegiant", "Reckoners 1. Steelheart"), in its `BookName` and in the folder and file names it gives a book. Read that
 * period back as the part break it was, so the subtitle is a subtitle; an abbreviation ("Mr. Mercedes") keeps its period.
 * Pure.
 */
export function llTitleText(title: string): string {
  return title.replace(
    /(\b[A-Za-z]{2,}|\b[A-Za-z]+\s+\d{1,3})\.\s+(?=["'“‘(]?[A-Z0-9]|(?:a|an|the)\s)/g,
    (whole, before: string) => (ABBREVIATIONS.has(before.toLowerCase()) ? whole : `${before}: `),
  );
}

/**
 * The spellings two titles of one book differ in, made one, for the Held File Check only: a file extension left in a
 * title ("On Wings of Eagles.txt"), a double hyphen, bullet or underscore as a part break ("Artificial
 * Condition--The Murderbot Diaries", "The Burning Maze • The Trials of Apollo"), "Vs." for "Versus", and British
 * "-our" for American "-or" ("The Colour of Magic").
 */
function heldTitleText(title: string): string {
  return title
    .replace(/\.(?:txt|epub|mobi|azw3?|pdf|docx?|rtf|html?|m4b|mp3)\s*$/i, '')
    .replace(/\s*(?:--|•|·|_)\s*/g, ' - ')
    .replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\b([A-Za-z]{3,})our\b/g, '$1or');
}

/** A title worth judging: at least one letter, and not a placeholder. */
export function judgeableTitle(title: string | null | undefined): boolean {
  const key = words(title).join(' ');
  return /[a-z]/.test(key) && !PLACEHOLDER_TITLES.has(key) && !PLACEHOLDER_START.test(key);
}

/** A title that is only a series and a number ("Redwall - 08", "Throne of Glass bk 5", "Wild Cards VII", "Disc 01"). */
const DESIGNATION =
  /^(?=.*[a-z])[^:]*?[\s,#–-]*(?:\b(?:book|bk|vol|volume|part|no|disc|cd|tome)\b\.?\s*)?#?\s*(?:\b\d{1,3}|\b[ivx]{1,5})\s*$/;

/** Is this title only a series designation: one part, ending in its number? Its trailing parentheticals are cut first. */
export function isSeriesDesignation(title: string): boolean {
  let t = fold(heldTitleText(title)).trim();
  for (
    let m = /\s*[([][^()[\]]*[)\]]\s*$/.exec(t);
    m && m.index > 0;
    m = /\s*[([][^()[\]]*[)\]]\s*$/.exec(t)
  ) {
    t = t.slice(0, m.index).trim();
  }
  const flat = t.replace(/\s+[-–]\s+(?=\S+$)/, ' ');
  return !/:|\s[-–]\s/.test(flat) && DESIGNATION.test(flat);
}

/**
 * The Held File Check (T-290): does a held file's title name the LazyLibrarian book it is held for? `null` when the
 * file's title cannot say: none, a placeholder, or only a series designation ("Redwall - 08", "Throne of Glass bk 5",
 * which audiobook album tags often are) that names no other volume; the census then judges the file by its name.
 * Otherwise all of these must hold:
 *   1. the Volume Check (`llBookMismatch`, the record's title as the want, the file's as the book) finds no other
 *      volume: "Warriors 3" never holds "Warriors", "Book 3" never "Book 2".
 *   2. the Volume Check finds no other work, either way round: the record's title in the file's, or the file's title in
 *      the record's ("The Golden Compass" for LazyLibrarian's "His Dark Materials. The Golden Compass (Book 1)"),
 *      except when the words the file lacks name a separate work and the file lacks the record's own head ("A Plague of
 *      Zombies. An Outlander Novella" is not "Outlander"; "The Churn. an Expanse Novella" is "The Churn"). It catches
 *      another subtitle in one series ("Four: The Son" held as "Four: The Traitor"). Two titles that are one string
 *      once spaces and punctuation go ("Confessions ofanUglyStepsister") are the same.
 *   3. the file's title names nothing the record does not (`namesNothingElse`). The Volume Check passes a file whose
 *      title CONTAINS the record's, which is how a collection ("Four Divergent Stories: The Transfer, ..., and The
 *      Traitor") or another part ("First Shift - Legacy" for "Shift") looks.
 * Before 2 and 3: a file whose title is the record's with words cut is judged by `cutTitleNamesBook` alone (issue
 * #799): "Catwings" is not "Wonderful Alexander and the Catwings", "Dune" is not "Dune Messiah".
 * Pure.
 */
export function heldFileNamesBook(
  fileTitle: string | null | undefined,
  book: LlBookNaming,
  options: HeldFileCheckOptions = {},
): boolean | null {
  if (!fileTitle || !judgeableTitle(fileTitle)) return null;
  const file = heldTitleText(fileTitle);
  const recordTitle = heldTitleText(llTitleText(book.title ?? ''));
  if (!judgeableTitle(recordTitle)) return null;
  const subtitle = book.subtitle?.trim() ? heldTitleText(llTitleText(book.subtitle)) : null;
  const author = book.author ?? null;
  // One string once spaces and punctuation go, a leading article too, read with and without the possessive "'s" (issue
  // #799's repair): "Hitchhikers Guide To The Galaxy" is LazyLibrarian's "The Hitch Hiker's Guide to the Galaxy".
  const keys = (t: string): string[] => {
    const raw = t
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ');
    return [fold(t), raw].flatMap((v) => {
      const k = v.trim();
      return [k, k.replace(/^(?:the|an?)\s+/, '')].map((x) => x.replace(/[^a-z0-9]/g, ''));
    });
  };
  const sameString = (a: string, b: string): boolean => keys(a).some((k) => keys(b).includes(k));
  if (
    sameString(file, recordTitle) ||
    (subtitle !== null && sameString(file, `${recordTitle}${subtitle}`))
  )
    return true;
  const asWant = (title: string) => ({ title, author });
  const forward = llBookMismatch(asWant(recordTitle), { title: file, author });
  if (forward === 'volume') return false;
  if (isSeriesDesignation(file)) return null;
  const cut = cutTitleNamesBook(file, recordTitle, author, options);
  if (cut !== null) return cut;
  const withSub =
    subtitle !== null
      ? llBookMismatch(asWant(`${recordTitle}: ${subtitle}`), { title: file, author })
      : 'work';
  let sameWork = forward === null || withSub === null;
  if (!sameWork && llBookMismatch(asWant(file), { title: recordTitle, author }) === null) {
    const authorWords = new Set(words(author));
    const fileWords = new Set(distinctiveWords(file, authorWords));
    const headCovered = distinctiveWords(splitTitle(recordTitle).head, authorWords).every((w) =>
      fileWords.has(w),
    );
    sameWork =
      headCovered ||
      !distinctiveWords(recordTitle, authorWords).some(
        (w) => !fileWords.has(w) && SEPARATE_WORK.has(w),
      );
  }
  if (!sameWork) return false;
  return namesNothingElse(file, recordTitle, subtitle, author, options.series);
}

/** What the Held File Check may know besides the two titles. */
export interface HeldFileCheckOptions {
  /** The series name the file declares (calibre:series, belongs-to-collection). */
  series?: string | null;
  /**
   * Every title LazyLibrarian holds for the record's author (its own among them is fine): a leading run of words that
   * other titles of the author start with too is a series or character name ("Percy Jackson and the ...").
   */
  authorTitles?: readonly string[];
}

/**
 * Words a cut title may drop without naming another book: how the book is packaged or sold ("LP", "Hardcover",
 * "Sneak Peek for"), on top of `PACKAGING_WORDS`. Stemmed like `distinctiveWords`.
 */
const CUT_PACKAGING_WORDS = new Set([
  ...PACKAGING_WORDS,
  ...[
    'lp',
    'large',
    'print',
    'hardcover',
    'paperback',
    'mass',
    'market',
    'reissue',
    'collector',
    'special',
    'movie',
    'tie',
    'sneak',
    'peek',
    'preview',
    'excerpt',
    'sample',
    'sampler',
    // An interlibrary-loan marker Google Books leaves in a title ("ILL/ Where the Crawdads Sing").
    'ill',
  ].map((w) => stem(w)),
]);

/** A title's distinctive words in order (`distinctiveWords` without the de-duplication). */
function orderedWords(text: string, authorWords: ReadonlySet<string>): string[] {
  return words(fold(text).replace(POSITION_MARKER, ' '))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !authorWords.has(w))
    .map(stem);
}

/** A title's parts (trailing parentheticals and brackets cut off as decoration), each as its ordered words. */
function cutParts(
  title: string,
  authorWords: ReadonlySet<string>,
): { parts: string[][]; decoration: string[][] } {
  const decoration: string[][] = [];
  const TRAILING = /\s*[([]([^()[\]]*)[)\]]\s*$/;
  let rest = fold(title).trim();
  for (let m = TRAILING.exec(rest); m && m.index > 0; m = TRAILING.exec(rest)) {
    decoration.push(orderedWords(m[1]!, authorWords));
    rest = rest.slice(0, m.index).trim();
  }
  const parts = rest
    .split(PART_BREAK)
    .map((p) => orderedWords(p, authorWords))
    .filter((p) => p.length > 0);
  return { parts, decoration: decoration.filter((d) => d.length > 0) };
}

/** Does `run` start `title` (its words, decoration cut)? `longer`: and `title` goes on past it. */
function leadsTitle(run: readonly string[], title: readonly string[], longer = false): boolean {
  return (
    run.length > 0 &&
    title.length >= run.length + (longer ? 1 : 0) &&
    run.every((w, i) => title[i] === w)
  );
}

/**
 * Issue #799 (DESIGN-028 "Books Census", T-290 side 2) — a file whose title is the record's with words cut. The Volume
 * Check read either way round passes any such file, which is how Catwings (book 1) held as "Wonderful Alexander and the
 * Catwings" (book 3) looked, and how "Dune" held as "Dune Messiah" would. `null` when the file's title is not the
 * record's cut (it has a word the record lacks, or lacks none). Otherwise the cut words must say nothing about which
 * book it is:
 *   • a trailing cut is whole parts (a subtitle or edition part: "Dune" ⇄ "Dune: Deluxe Edition", "A Plague of Zombies"
 *     ⇄ "A Plague of Zombies. An Outlander Novella"), packaging ("Just Like Heaven LP", "... - Hufflepuff Edition"), or
 *     a collection's tail ("The Martian Way" ⇄ "The Martian Way and Other Stories");
 *   • a leading cut is whole parts (a series in front: "The Golden Compass" ⇄ "His Dark Materials. The Golden
 *     Compass"); what it cuts from the kept words' own part must be packaging ("Sneak Peek for"), the file's or the
 *     record's own series name, or words other titles of the author start with ("The Sea of Monsters" ⇄ "Percy Jackson
 *     and the Sea of Monsters" beside "Percy Jackson and the Olympians"). So "Dune" ⇄ "Dune Chronicles. God Emperor of
 *     Dune" fails, and so does "A Crash of Fate" ⇄ "Star Wars. Galaxy's Edge A Crash of Fate" unless another title
 *     vouches for "Galaxy's Edge" (a Census Hold covers the one in the library);
 *   • nothing is cut from between the kept words but packaging.
 * A cut inside the kept part that names its book fails: "Dune" ⇄ "Dune Messiah", "Catwings" ⇄ "Wonderful Alexander and
 * the Catwings", "A Secret Rage" ⇄ "A Secret Rage and Sweet and Deadly". Two guards then apply: a leading cut that names
 * a separate work ("Prologue to") fails, as before; and a file whose title is only a series name (the file's or the
 * record's own, or words other titles of the author start with: "Wild Cards" ⇄ "Wild Cards. Lowball", "Four" ⇄ "Four.
 * The Traitor") fails unless all the record adds is packaging ("Dune" ⇄ "Dune. Deluxe Hardcover Edition"). Pure.
 */
function cutTitleNamesBook(
  file: string,
  recordTitle: string,
  author: string | null,
  options: HeldFileCheckOptions,
): boolean | null {
  const authorWords = new Set(words(author));
  const fileWords = new Set(
    distinctiveWords(splitTitle(file).work.join(' : '), authorWords).filter(
      (w) => !CUT_PACKAGING_WORDS.has(w),
    ),
  );
  if (fileWords.size === 0) return null;
  const record = cutParts(recordTitle, authorWords);
  const seq = record.parts.flatMap((part, p) => part.map((w) => ({ w, p })));
  if (![...fileWords].every((w) => seq.some((s) => s.w === w))) return null;
  if (seq.every((s) => fileWords.has(s.w))) return null;
  const packaging = (run: readonly { w: string }[]): boolean =>
    run.every((s) => CUT_PACKAGING_WORDS.has(s.w));
  const runWords = (run: readonly { w: string }[]): string[] => run.map((s) => s.w);

  const own = fold(recordTitle).replace(/[^a-z0-9]/g, '');
  const others = (options.authorTitles ?? [])
    .map((t) => heldTitleText(llTitleText(t)))
    .filter((t) => fold(t).replace(/[^a-z0-9]/g, '') !== own)
    .map((t) => cutParts(t, authorWords).parts.flat());
  const seriesNames = [
    ...(options.series ? [orderedWords(options.series, authorWords)] : []),
    ...record.decoration,
  ].filter((s) => s.length > 0);
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    new Set(a).size === new Set(b).size && a.every((w) => b.includes(w));
  /**
   * A run of words that is a series or character name: declared, in the record's decoration, or what at least `shared`
   * other titles of the author start with and go on past (one title that extends the run can be the same book's other
   * edition: "The Golden Compass Graphic Novel"; a twin record titled like the run is not a series either).
   */
  const seriesRun = (run: readonly string[], shared: number): boolean =>
    seriesNames.some((s) => sameSet(run, s)) ||
    others.filter((t) => leadsTitle(run, t, true)).length >= shared ||
    (shared === 1 && others.some((t) => leadsTitle(run, t)));

  /** Is the record's title, kept from `first` to `last`, cut only where a cut says nothing? */
  const windowOk = (first: number, last: number): boolean => {
    const lead = seq.slice(0, first);
    const trail = seq.slice(last + 1);
    const inside = seq.slice(first, last + 1);
    const gap = inside.filter((s) => !fileWords.has(s.w));
    if (!packaging(gap)) return false;
    const trailOk =
      trail.length === 0 ||
      trail[0]!.p !== seq[last]!.p ||
      packaging(trail) ||
      (trail[0]!.w === 'other' && trail.length >= 2);
    // A cut in front may be whole earlier parts (a series in front). Whatever it cuts from the kept words' own part must
    // still be packaging or a series name: "Dune Chronicles. God Emperor of Dune" does not pass "Dune" on its series.
    const leadInPart = lead.filter((s) => s.p === seq[first]!.p);
    const leadOk =
      leadInPart.length === 0 ||
      packaging(leadInPart) ||
      seriesRun(runWords(leadInPart), 1) ||
      seriesRun(runWords(lead), 1);
    if (!trailOk || !leadOk) return false;
    const cutWords = [...lead, ...gap, ...trail];
    if (lead.length > 0 && cutWords.some((s) => SEPARATE_WORK.has(s.w))) return false;
    const keptWords = runWords(inside.filter((s) => fileWords.has(s.w)));
    return !(seriesRun(keptWords, 2) && !packaging(cutWords));
  };
  // The kept words are the shortest stretches of the record's title holding every word of the file's (a word can come
  // twice: "Wild Cards XII. Turn of the Cards" keeps "Turn of the Cards", not "Cards XII. Turn").
  const windows: [number, number][] = [];
  for (let first = 0; first < seq.length; first += 1) {
    if (!fileWords.has(seq[first]!.w)) continue;
    const seen = new Set<string>();
    for (let last = first; last < seq.length; last += 1) {
      if (fileWords.has(seq[last]!.w)) seen.add(seq[last]!.w);
      if (seen.size === fileWords.size) {
        windows.push([first, last]);
        break;
      }
    }
  }
  const span = Math.min(...windows.map(([a, b]) => b - a));
  return windows.filter(([a, b]) => b - a === span).some(([a, b]) => windowOk(a, b));
}

/**
 * Leading series indexes a part may carry before the work's own words ("Expanse 05 ", "[The Expanse 3.0] ", "SSQ4 ",
 * "The History of Middle-earth Vol-7- ").
 */
const LEADING_INDEX = [
  /^\s*\[[^\]]*\]\s*/,
  /^[^:]{1,40}?\b\d{1,3}(?:\.\d)?\s+(?=[a-z])/,
  /^[a-z]{2,5}\d{1,3}\s+/,
  /^[^:]{1,60}?\bvol(?:ume)?[\s.-]*\d{1,3}\b[\s.:–-]*/,
];

/**
 * Side 3 of the Held File Check: does `title` name nothing the record does not? True when one part of it, its decoration
 * and any leading series index cut, has words and all of them are the record's (title, subtitle, the file's own series
 * name), packaging words aside; or when the title starts with the record's whole title (two words or more) and only adds
 * a subtitle after it ("NINE TOMORROWS Tales of the Near Future"). A title with no word left passes.
 */
function namesNothingElse(
  title: string,
  recordTitle: string,
  subtitle: string | null,
  author: string | null | undefined,
  series: string | null | undefined,
): boolean {
  const authorWords = new Set(words(author));
  const recordWords = distinctiveWords(recordTitle, authorWords);
  const allowed = new Set([
    ...recordWords,
    ...(subtitle ? distinctiveWords(subtitle, authorWords) : []),
    ...(series ? distinctiveWords(series, authorWords) : []),
  ]);
  const head = words(recordTitle).join(' ');
  if (recordWords.length >= 2 && `${words(title).join(' ')} `.startsWith(`${head} `)) return true;
  const partWords = splitTitle(title)
    .work.flatMap((part) => [part, ...LEADING_INDEX.map((re) => part.replace(re, ''))])
    .map((part) => distinctiveWords(part, authorWords).filter((w) => !PACKAGING_WORDS.has(w)))
    .filter((w) => w.length > 0);
  if (partWords.length === 0) return true;
  return partWords.some((w) => w.every((x) => allowed.has(x)));
}

/** Audiobook part and track markers in a file name ("Part 01 of 39", "(10)", "- 01 of 34", "Chapter 56 - "). */
const TRACK_MARKERS = [
  /\s*[-–]?\s*\bpart\s*\d{1,4}\s*(?:of\s*\d{1,4})?\s*$/i,
  /\s*[-–]?\s*\b\d{1,4}\s*of\s*\d{1,4}\s*$/i,
  /\s*\(\d{1,4}\)\s*$/,
  /\s*[-–]\s*\d{1,4}\s*$/,
  /^\s*(?:chapter|track|disc|cd)\s*\d{1,4}\s*[-–.:]\s*/i,
  /^\s*\d{1,4}\s*[-–.:]?\s+(?=\D)/,
];

/** A track or chapter title with its track number and part marker cut ("13 Dead Ever After Part 1" → "Dead Ever After"). */
export function stripTrackMarkers(title: string): string {
  let out = title;
  for (let i = 0; i < 2; i += 1) for (const marker of TRACK_MARKERS) out = out.replace(marker, '');
  return out.trim();
}

/** An author name in "Last, First" order as well, for a file name LazyLibrarian or a release wrote. */
function authorSpellings(author: string | null | undefined): string[] {
  const a = (author ?? '').trim();
  if (!a) return [];
  const parts = a.split(/\s+/);
  return parts.length > 1 ? [a, `${parts.at(-1)!}, ${parts.slice(0, -1).join(' ')}`] : [a];
}

/**
 * The titles a held file's PATH gives (T-290, the name side): its folder (LazyLibrarian files a book under `$Title`) and
 * its name without the extension, the author ("Hugh Howey - ", " - Veronica Roth", "Howey, Hugh - ") and track markers
 * ("Part 01 of 39", "(10)") cut. Pure.
 */
export function heldFileNameTitles(path: string, author: string | null | undefined): string[] {
  const segments = path.split('/').filter((s) => s.length > 0);
  const base = (segments.at(-1) ?? '').replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const folder = segments.at(-2) ?? '';
  const strip = (name: string): string => {
    let out = name;
    for (const spelling of authorSpellings(author)) {
      const esc = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`^\\s*${esc}\\s*[-–]\\s*`, 'i'), '');
      out = out.replace(new RegExp(`\\s*[-–]\\s*${esc}\\s*$`, 'i'), '');
    }
    return llTitleText(stripTrackMarkers(out));
  };
  return [...new Set([strip(folder), strip(base)].filter((t) => judgeableTitle(t)))];
}

/**
 * The name side of the Held File Check: false only when NO title the path gives names the book; null when there is none
 * to judge. A name is shorter than a title (LazyLibrarian's "The Traitor" folder holds "Four: The Traitor"), so only
 * sides 1 and 3 apply: the name names no other volume, and nothing the record does not ("First Shift - Legacy" for
 * "Shift" does).
 */
export function heldFileNameNamesBook(path: string, book: LlBookNaming): boolean | null {
  const recordTitle = heldTitleText(llTitleText(book.title ?? ''));
  if (!judgeableTitle(recordTitle)) return null;
  const subtitle = book.subtitle?.trim() ? heldTitleText(llTitleText(book.subtitle)) : null;
  const titles = heldFileNameTitles(path, book.author).map((t) => heldTitleText(t));
  if (titles.length === 0) return null;
  return titles.some(
    (t) =>
      llBookMismatch(
        { title: recordTitle, author: book.author ?? null },
        { title: t, author: book.author ?? null },
      ) !== 'volume' && namesNothingElse(t, recordTitle, subtitle, book.author, null),
  );
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
