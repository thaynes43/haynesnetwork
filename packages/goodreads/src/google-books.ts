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
  const stripped = title.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return stripped.length > 0 ? stripped : title;
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
    const titlePart = `intitle:${gbQueryTitle(input.title)}`;
    const authorPart = input.author ? `+inauthor:${input.author}` : '';
    const byTitle = await this.query(`${titlePart}${authorPart}`);
    const vol = byTitle?.items?.[0];
    // The title leg is fuzzy — reject a resolve whose own title doesn't cover the queried one (2026-07-16
    // wrong-work incident; see gbResolveTitleMatches). GB splits title/subtitle, and a Goodreads title
    // often carries the subtitle after a colon — compare against BOTH. ISBN resolves above stay guard-free.
    const resolvedTitle = [vol?.volumeInfo?.title, vol?.volumeInfo?.subtitle].filter(Boolean).join(' ');
    if (vol && gbResolveTitleMatches(input.title, resolvedTitle || undefined)) {
      return this.toVolume(vol, null, input);
    }
    return null;
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
