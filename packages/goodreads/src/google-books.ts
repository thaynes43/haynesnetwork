// ADR-055 / DESIGN-028 (PLAN-044) — the read-only Google Books enrichment client. It resolves a shelf
// item to a Google-Books VOLUME ID (the LazyLibrarian addBook key, per the proven F-10 pattern) by ISBN
// first, then a title+author fallback. Every call goes through the mandatory retry/backoff getText (GB
// `backendFailed` bursts are transient). The key is OPTIONAL — absent ⇒ resolveVolume returns null and
// the item stays honestly un-pushable (a documented gap, never a fabricated id).
import { z } from 'zod';
import { getText, type GetOptions } from './http';

const industryIdentifierSchema = z.object({
  type: z.string().optional(),
  identifier: z.string().optional(),
});

const volumeSchema = z.object({
  id: z.string(),
  volumeInfo: z
    .object({
      title: z.string().optional(),
      subtitle: z.string().optional(),
      authors: z.array(z.string()).optional(),
      publisher: z.string().optional(),
      categories: z.array(z.string()).optional(),
      printType: z.string().optional(),
      industryIdentifiers: z.array(industryIdentifierSchema).optional(),
    })
    .optional(),
});

/**
 * Classify a volume as a COMIC / graphic novel from its GB categories. Comics acquisition is Kapowarr's
 * domain, NOT LazyLibrarian's (owner note 2026-07-13 — his real to-read shelf holds Scott Pilgrim + Batman
 * Zero Year alongside novels), so the goodreads-sync must NOT blind-fire a comic into LL. GB tags comics
 * as "Comics & Graphic Novels" (sometimes suffixed, e.g. "Comics & Graphic Novels / Literary") — the
 * substring is the signal.
 */
export function isComicCategory(categories: readonly string[] | undefined): boolean {
  if (!categories) return false;
  return categories.some((c) => /comics?\s*&?\s*graphic\s*novels?/i.test(c) || /^comics?$/i.test(c.trim()));
}

// High-precision COMIC text markers (v0.49.0 live-acceptance finding, PLAN-044). The owner's shelf leaked
// BOTH comics into LazyLibrarian because GB categories alone missed them: "Batman Zero Year" resolved to a
// sparse GB volume with NO categories, and the Scott Pilgrim ISBN edition's SEARCH result was truncated to
// ["Fiction"] (the /volumes GET carries the full BISAC list). The shelved title itself carries the strongest
// signal GB drops — a comic publisher / imprint ("DC Comics - The Legend of Batman") or a graphic-novel /
// manga marker. Each pattern is a proper-noun publisher phrase or an unambiguous format word, so a prose
// novel on a to-read shelf won't false-positive (ADR-055 comic-parking; DESIGN-028 D-03).
const COMIC_TEXT_MARKERS: readonly RegExp[] = [
  /\bcomics?\s*&\s*graphic\s+novels?\b/i,
  /\bgraphic\s+novels?\b/i,
  /\bcomic\s+books?\b/i,
  /\bmanga\b/i,
  /\bdc\s+comics\b/i,
  /\bmarvel\s+comics\b/i,
  /\bimage\s+comics\b/i,
  /\bdark\s+horse\s+comics\b/i,
  /\bidw\s+publishing\b/i,
  /\bboom!?\s+studios\b/i,
  /\bdynamite\s+entertainment\b/i,
  /\boni\s+press\b/i,
  /\bkodansha\s+comics\b/i,
  /\btitan\s+comics\b/i,
  /\bviz\s+media\b/i,
  /\bfantagraphics\b/i,
  /\bdrawn\s*&\s*quarterly\b/i,
];

/**
 * True when any text signal (a shelved title/series, an author, a publisher) carries a high-precision comic
 * marker. This catches the comics GB categories miss — e.g. "Zero Year: Part 1 (DC Comics - The Legend of
 * Batman #1)" whose resolved GB volume has no categories at all. Used both inside the GB client (combined
 * with categories) and as the goodreads-sync fallback when GB returns no match.
 */
export function isComicText(...parts: Array<string | null | undefined>): boolean {
  const hay = parts.filter((p): p is string => Boolean(p)).join(' ␟ ');
  if (!hay) return false;
  return COMIC_TEXT_MARKERS.some((re) => re.test(hay));
}

/**
 * Strip the TRAILING Goodreads series parenthetical ("(Crowns of Nyaxia, #1)") for the `intitle:` query.
 * Left in, it dilutes GB's title matching enough to resolve a different work entirely — the 2026-07-16
 * live incident: "The Serpent and the Wings of Night (Crowns of Nyaxia, #1)" (a prose novel) resolved to
 * a comic-categorized volume, was durably classified a comic (ADR-056), and routed a junk 319-issue
 * ComicVine volume into Kapowarr. The RAW title still feeds isComicText + pickBestVolume — only the GB
 * query is de-noised.
 */
export function gbQueryTitle(title: string): string {
  let stripped = title.replace(/\s*\([^()]*\)\s*$/, '').trim();
  // Trailing library/series bracket annotation ("… [Summer, Book 1]", "… [Unabridged]") — the
  // bracket analog of the Goodreads parenthetical above; GB indexes under the bare work title.
  stripped = stripped.replace(/\s*\[[^\][]*\]\s*$/, '').trim();
  // LEADING series/volume prefix on Kavita/ABS file-derived titles (PLAN-059 pairing-resolve gap):
  //   "Wheel of Time [09]: Winter's Heart", "Lily Bard #05 - Shakespeare's Counselor" (a bracket/hash
  //   index prefix) and "Expanse 05 - Nemesis Games", "Broken Wings 2 - Midnight Flight" (a series
  //   word + a 1-3 digit index + a dash). GB never indexes under the series prefix — the work title
  //   trails it. The resolve's title-coverage + author guards (gbResolveTitleMatches / gbAuthorsMatch)
  //   catch an over-strip, so a wrong strip fails to a null (an honest gap), never a wrong-work push.
  //   A colon after a BARE number ("Beacon 23: Part One") is deliberately NOT a series prefix — only
  //   a bracket/hash index may use ':' — so integral-number titles survive.
  stripped = stripped.replace(/^.*?(?:\[\d{1,3}\]|#\d{1,3})\s*[-–:]\s+(?=\S)/, '').trim();
  stripped = stripped.replace(/^.+?\s\d{1,3}\s*[-–]\s+(?=\S)/, '').trim();
  // Bare leading series-index ("02 - Grave Surprise", "1. The Colour of Magic") — digits + a
  // separator + real text. Bare numeric titles ("1984") and slash dates ("11/22/63") are untouched.
  stripped = stripped.replace(/^\d{1,3}\s*[-–.]\s+(?=\S)/, '').trim();
  return stripped.length > 0 ? stripped : title;
}

/**
 * Loose author agreement for the title-search resolve guard: the queried author and at least one
 * resolved-volume author must share a SURNAME-ish token (the longest name token ≥3 chars, so
 * "Dean Koontz" vs "Simon Beckett" rejects while "C. Harris" vs "Charlaine Harris" accepts).
 */
export function gbAuthorsMatch(queryAuthor: string, resolvedAuthors: readonly string[]): boolean {
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3);
  const q = new Set(tokens(queryAuthor));
  if (q.size === 0) return true; // nothing usable to compare — do not reject on noise
  return resolvedAuthors.some((a) => tokens(a).some((t) => q.has(t)));
}

const TITLE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'vol', 'volume', 'part', 'book', 'no', 'edition',
]);

/** Lowercased DISTINCTIVE tokens for the resolve-guard overlap check (mirrors the comicTokens idiom) —
 * stop words dropped so "the/and/of" overlap can't fake a title match. */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !TITLE_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Guard a TITLE-SEARCH resolve (the fuzzy leg — ISBN resolves skip this): the resolved volume's own title
 * must cover at least half of the queried title's distinctive tokens, or the resolve is rejected as a
 * different work. The GB volume id is the LazyLibrarian addBook key AND the comic-classification source,
 * so a wrong-work resolve mints the wrong book / mis-classifies — null (an honest gap) is strictly better.
 */
export function gbResolveTitleMatches(queryTitle: string, resolvedTitle: string | undefined): boolean {
  if (!resolvedTitle) return false;
  const q = titleTokens(gbQueryTitle(queryTitle));
  if (q.length === 0) return true;
  const resolved = new Set(titleTokens(resolvedTitle));
  const covered = q.filter((t) => resolved.has(t)).length;
  // 60% coverage: a 2-token title must cover both ("Kingdom of Ash" ≠ "Kingdom Hearts"), longer titles
  // tolerate a missing word or two ("The Serpent … Night" still accepts an "&"-styled edition).
  return covered >= Math.max(1, Math.ceil(q.length * 0.6));
}

// ---------------------------------------------------------------------------------------------------
// VOLUME guard (issue #693, 2026-10-05). The coverage guard above drops numbers and the words "book" / "vol"
// / "part", so "Court of Thorns and Roses bk 2" covered "A Court of Thorns and Roses" (book 1) at 3 of 4
// tokens and two pairing wants for book 2 were pinned to book 1's id, then read `landed` from its files.
// A title that NAMES its volume ("bk 2", "Book 2", "Part Four: Company", "Vol. 3") must resolve to a volume
// that names the same number. Shared by the app's resolve guard and the domain's LazyLibrarian book check.
// ---------------------------------------------------------------------------------------------------

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const NUMBER_WORD = `\\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')}`;
/** A volume marker and its number: "bk 2", "Book Two", "Vol. 3", "Part 4", "No. 5", "#6". */
const MARKED_NUMBER = new RegExp(
  `(?:\\b(?:book|bk|vol|volume|part|no|number|nr|tome)\\b\\.?\\s*|#\\s*)(${NUMBER_WORD})\\b`,
  'gi',
);
/** The same, anchored at the start of a subtitle segment ("Part Four: Company"). */
const LEADING_MARKED_NUMBER = new RegExp(
  `^\\s*(?:\\b(?:book|bk|vol|volume|part|no|number|nr|tome)\\b\\.?\\s*|#\\s*)(${NUMBER_WORD})\\b`,
  'i',
);

const foldTitle = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const toNumber = (raw: string): number => WORD_NUMBERS[raw.toLowerCase()] ?? Number(raw);

/** A marker number followed by "of" positions the book in a SERIES ("Book Two of the Expanse"), not a volume. */
const followedByOf = (text: string, end: number): boolean => /^\s+of\b/i.test(text.slice(end));

/**
 * The volume numbers a WANTED title names for itself: a marked number in its main title ("Court of Thorns and
 * Roses bk 2" → 2), or at the start of a colon segment ("Beacon 23: Part Four: Company" → 4). The series
 * decoration is left out: the trailing parenthetical and the leading index prefix (`gbQueryTitle`), and a marker
 * inside a later segment ("Caliban's War: The Expanse, Book 2") or followed by "of" ("Book Two of the Expanse
 * series"), because those position the book in its series while the title itself names the work.
 */
export function titleVolumeNumbers(title: string): Set<number> {
  const out = new Set<number>();
  const segments = foldTitle(gbQueryTitle(title)).split(':');
  const head = segments[0] ?? '';
  for (const m of head.matchAll(MARKED_NUMBER)) {
    if (!followedByOf(head, (m.index ?? 0) + m[0].length)) out.add(toNumber(m[1]!));
  }
  for (const segment of segments.slice(1)) {
    const m = LEADING_MARKED_NUMBER.exec(segment);
    if (m && !followedByOf(segment, m.index + m[0].length)) out.add(toNumber(m[1]!));
  }
  return out;
}

/**
 * Does a candidate's text (a Google Books title + subtitle, or a LazyLibrarian book name + subtitle) name the
 * volume a wanted title names? True when the wanted title names none; when the candidate names one of its
 * numbers anywhere (marked, or a bare 1-3 digit number: "A Court of Thorns and Roses, Book 2", "Wild Cards 2:
 * Aces High"), except a count after "of" ("Book 1 of 2" names volume 1, not 2); or when the wanted volume is 1 and
 * the candidate names no volume at all (a first book is often unnumbered). Roman numerals are not read.
 */
export function volumeNumbersAgree(wantedTitle: string, candidateText: string): boolean {
  const wanted = titleVolumeNumbers(wantedTitle);
  if (wanted.size === 0) return true;
  const text = foldTitle(candidateText);
  const marked = new Set<number>();
  for (const m of text.matchAll(MARKED_NUMBER)) marked.add(toNumber(m[1]!));
  const named = new Set<number>(marked);
  const tokens = text.split(/[^a-z0-9]+/);
  tokens.forEach((w, i) => {
    if (/^\d{1,3}$/.test(w) && tokens[i - 1] !== 'of') named.add(Number(w));
  });
  if ([...wanted].some((n) => named.has(n))) return true;
  return [...wanted].every((n) => n === 1) && marked.size === 0;
}

/**
 * OMNIBUS guard (2026-10-03 live incident) — is this resolved volume a bundle / box set / multi-work compilation
 * the QUERY did not ask for? The 60% title-coverage guard above compares against `title + subtitle`, and an
 * omnibus lists its contents in the subtitle ("The Odd Thomas Series 7-Book Bundle: Odd Thomas, Forever Odd, …,
 * Odd Interlude, …", "Dean Koontz: Winter Moon; Icebound"), so a lookup for ONE member of the set covers its
 * tokens and resolves to the whole bundle. That bundle id then became the want's LL `addBook` key and LL
 * hunted a 7-book duplicate of books already owned individually (Odd Interlude #1/#2), and a want for
 * "Dean R Koontz - Winter Moon" was pinned to a junk compilation row. Two signals, either rejects:
 *   - a packaging marker: bundle, omnibus, box/boxed set, compendium, starter pack or "N-Book" in the title
 *     or subtitle, or "collection"/"trilogy" in the TITLE only (a single novel's subtitle often reads "The
 *     Grisha Trilogy, Book 1"), or
 *   - a contents-list subtitle (a `;`, or four-plus comma-separated parts),
 * unless the QUERY itself carries the same signal (a wanted "Complete Collection" boxed set resolves to a
 * boxed set — that is the ask). Null (an honest gap) is strictly better than the wrong volume.
 */
// STRONG markers name a packaged set wherever they appear (title or subtitle). WEAK markers ("trilogy",
// "collection") also appear in the subtitle of an ordinary single book ("The Grisha Trilogy, Book 1",
// "A Collection of Stories"), so they count only in the TITLE.
const OMNIBUS_STRONG =
  /\b(bundle|omnibus|box(?:ed)? ?set|compendium|starter pack|\d+[- ]books?|(?:two|three|four|five|six|seven|eight|nine|ten)[- ]books?)\b/i;
const OMNIBUS_WEAK = /\b(collection|trilogy)\b/i;
const anyMarker = (s: string): boolean => OMNIBUS_STRONG.test(s) || OMNIBUS_WEAK.test(s);

function hasContentsList(text: string): boolean {
  return text.includes(';') || text.split(',').length >= 4;
}

export function gbIsOmnibusVolume(
  volume: { title?: string | undefined; subtitle?: string | undefined },
  ...queryTitles: ReadonlyArray<string>
): boolean {
  // The query side is tested PER title (callers pass the raw and the de-noised title, usually the same text
  // twice) - joining them would double the commas and fake a contents list.
  // De-noised first (gbQueryTitle drops a trailing series parenthetical): "Shadow and Bone (The Grisha Trilogy, #1)"
  // is a request for ONE book, not for a trilogy.
  const queries = queryTitles.map(gbQueryTitle);
  const queryAsksForSet = queries.some(anyMarker);
  const volumeText = [volume.title, volume.subtitle].filter(Boolean).join(' ');
  if (!queryAsksForSet && (OMNIBUS_STRONG.test(volumeText) || OMNIBUS_WEAK.test(volume.title ?? ''))) {
    return true;
  }
  if (volume.subtitle && hasContentsList(volume.subtitle) && !queries.some(hasContentsList)) return true;
  return false;
}

/** Combined comic classification from every signal we hold: GB categories OR a text marker in title/author/publisher. */
export function classifyComic(sig: {
  categories?: readonly string[] | undefined;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
}): boolean {
  return isComicCategory(sig.categories) || isComicText(sig.title, sig.author, sig.publisher);
}

const volumesResponseSchema = z.object({
  totalItems: z.number().optional(),
  items: z.array(volumeSchema).optional(),
});

export interface GbResolveInput {
  isbn?: string | null;
  title: string;
  author?: string | null;
}

export interface GbVolume {
  volumeId: string;
  /** The ISBN13 GB reports for the resolved volume (when present) — persisted for later matching. */
  isbn13: string | null;
  /** The GB categories (for comic classification / audit). */
  categories: string[];
  /** True when GB tags this as a comic / graphic novel (do NOT route to LazyLibrarian — Kapowarr's domain). */
  isComic: boolean;
}

export interface GoogleBooksClientOptions extends GetOptions {
  baseUrl: string;
  apiKey?: string;
}

export class GoogleBooksClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly opts: GetOptions;

  constructor(options: GoogleBooksClientOptions) {
    const { baseUrl, apiKey, ...rest } = options;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (apiKey) this.apiKey = apiKey;
    this.opts = rest;
  }

  private async query(q: string): Promise<z.infer<typeof volumesResponseSchema> | null> {
    const params = new URLSearchParams({ q, maxResults: '5', country: 'US' });
    if (this.apiKey) params.set('key', this.apiKey);
    const url = `${this.baseUrl}/volumes?${params.toString()}`;
    const text = await getText(url, this.opts);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = volumesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Fetch the FULL volume record by id. The `/volumes?q=` search endpoint truncates `categories` (it can
   * drop "Comics & Graphic Novels / Literary" to just "Fiction" — the live PLAN-044 Scott Pilgrim leak),
   * whereas `/volumes/{id}` returns the complete BISAC list. Used as the comic-classification confirm step.
   */
  private async fetchVolume(id: string): Promise<z.infer<typeof volumeSchema> | null> {
    const params = new URLSearchParams({ country: 'US' });
    if (this.apiKey) params.set('key', this.apiKey);
    const url = `${this.baseUrl}/volumes/${encodeURIComponent(id)}?${params.toString()}`;
    const text = await getText(url, this.opts);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = volumeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private static pickIsbn13(vol: z.infer<typeof volumeSchema>): string | null {
    const ids = vol.volumeInfo?.industryIdentifiers ?? [];
    const isbn13 = ids.find((i) => i.type === 'ISBN_13')?.identifier;
    return isbn13 ?? null;
  }

  /**
   * Resolve to a GB volume id. Tries `isbn:<isbn>` first (the most reliable key), then
   * `intitle:<title>+inauthor:<author>`. Returns null when GB has no key configured or no match — the
   * caller keeps the item as `requested` (an honest gap, not a fabricated push).
   *
   * Comic classification combines the search categories, the shelved title/author (the "DC Comics" signal
   * GB categories miss), and — when those say "not a comic" but the search DID carry a (possibly truncated)
   * category — a `/volumes/{id}` confirm GET for the full BISAC list. Both are PLAN-044 live-leak fixes.
   */
  async resolveVolume(input: GbResolveInput): Promise<GbVolume | null> {
    if (!this.apiKey && this.baseUrl.startsWith('https://www.googleapis.com')) {
      // No key against the real GB API — the quota-free path is not reliable; skip enrichment cleanly.
      return null;
    }
    if (input.isbn) {
      const byIsbn = await this.query(`isbn:${input.isbn}`);
      const vol = byIsbn?.items?.[0];
      if (vol) return this.toVolume(vol, input.isbn, input);
    }
    const primary = await this.resolveByTitle(gbQueryTitle(input.title), input);
    if (primary) return primary;
    // Pre-colon fallback (the "Dead Ever After: A Sookie Stackhouse Novel" no-match, 2026-07-17):
    // colon subtitles are often edition dressing GB doesn't index under. Only fires on a MISS, so
    // meaningful subtitles never lose to it; one extra GB call on the miss path only.
    const preColon = input.title.split(':')[0]?.trim();
    if (preColon && preColon.length >= 3 && preColon !== input.title.trim()) {
      return this.resolveByTitle(gbQueryTitle(preColon), input);
    }
    return null;
  }

  private async resolveByTitle(queryTitle: string, input: GbResolveInput): Promise<GbVolume | null> {
    const authorPart = input.author ? `+inauthor:${input.author}` : '';
    const byTitle = await this.query(`intitle:${queryTitle}${authorPart}`);
    const vol = byTitle?.items?.[0];
    if (!vol) return null;
    // The title leg is fuzzy — reject a resolve whose own title doesn't cover the queried one (2026-07-16
    // wrong-work incident; see gbResolveTitleMatches). GB splits title/subtitle, and a Goodreads title
    // often carries the subtitle after a colon — compare against BOTH. ISBN resolves above stay guard-free.
    const resolvedTitle = [vol.volumeInfo?.title, vol.volumeInfo?.subtitle].filter(Boolean).join(' ');
    // Guard against the title we actually QUERIED (the pre-colon fallback deliberately narrows it).
    if (!gbResolveTitleMatches(queryTitle, resolvedTitle || undefined)) return null;
    // Omnibus guard: a bundle/box set that LISTS the queried work in its subtitle passes the coverage check above.
    if (gbIsOmnibusVolume(vol.volumeInfo ?? {}, queryTitle, input.title)) return null;
    // Volume guard (issue #693): a title that names its volume ("Court of Thorns and Roses bk 2") never resolves to
    // a different or unnumbered later volume. Read off the ORIGINAL title, so the pre-colon fallback ("… : Book 2"
    // narrowed to "…") cannot drop the number it was asked for.
    if (!volumeNumbersAgree(input.title, resolvedTitle)) return null;
    // Author guard (the "Whispers" wrong-book incident, 2026-07-17: a title-only resolve returned a
    // DIFFERENT author's similarly-titled work): when the caller knows the author AND the resolved
    // volume carries authors, require a shared surname token — else reject as a different work.
    // GB usually honors inauthor, but this holds even when the query ran title-only upstream.
    if (input.author && (vol.volumeInfo?.authors?.length ?? 0) > 0) {
      if (!gbAuthorsMatch(input.author, vol.volumeInfo?.authors ?? [])) return null;
    }
    return this.toVolume(vol, null, input);
  }

  private async toVolume(
    vol: z.infer<typeof volumeSchema>,
    fallbackIsbn: string | null,
    input: GbResolveInput,
  ): Promise<GbVolume> {
    let categories = vol.volumeInfo?.categories ?? [];
    let isComic = classifyComic({
      categories,
      title: input.title,
      author: input.author,
      publisher: vol.volumeInfo?.publisher,
    });
    // Confirm a NEGATIVE against the full volume record only when the search returned a category list that
    // GB may have truncated (empty ⇒ the /volumes GET won't have them either; skip the quota spend).
    if (!isComic && this.apiKey && categories.length > 0) {
      const full = await this.fetchVolume(vol.id).catch(() => null);
      const fullCategories = full?.volumeInfo?.categories;
      if (fullCategories && fullCategories.length > 0) {
        categories = fullCategories;
        isComic = classifyComic({
          categories,
          title: input.title,
          author: input.author,
          publisher: full?.volumeInfo?.publisher ?? vol.volumeInfo?.publisher,
        });
      }
    }
    return {
      volumeId: vol.id,
      isbn13: GoogleBooksClient.pickIsbn13(vol) ?? fallbackIsbn,
      categories,
      isComic,
    };
  }
}

export function googleBooksClient(options: GoogleBooksClientOptions): GoogleBooksClient {
  return new GoogleBooksClient(options);
}
