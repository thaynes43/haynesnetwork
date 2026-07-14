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
      authors: z.array(z.string()).optional(),
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
 * as "Comics & Graphic Novels" — the signal we use. Unreliable-from-RSS-alone is acceptable (documented):
 * absent a GB match we default to the LL route with the caveat noted (DESIGN-028).
 */
export function isComicCategory(categories: readonly string[] | undefined): boolean {
  if (!categories) return false;
  return categories.some((c) => /comics?\s*&?\s*graphic\s*novels?/i.test(c) || /^comics?$/i.test(c.trim()));
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

  private static pickIsbn13(vol: z.infer<typeof volumeSchema>): string | null {
    const ids = vol.volumeInfo?.industryIdentifiers ?? [];
    const isbn13 = ids.find((i) => i.type === 'ISBN_13')?.identifier;
    return isbn13 ?? null;
  }

  /**
   * Resolve to a GB volume id. Tries `isbn:<isbn>` first (the most reliable key), then
   * `intitle:<title>+inauthor:<author>`. Returns null when GB has no key configured or no match — the
   * caller keeps the item as `requested` (an honest gap, not a fabricated push).
   */
  async resolveVolume(input: GbResolveInput): Promise<GbVolume | null> {
    if (!this.apiKey && this.baseUrl.startsWith('https://www.googleapis.com')) {
      // No key against the real GB API — the quota-free path is not reliable; skip enrichment cleanly.
      return null;
    }
    if (input.isbn) {
      const byIsbn = await this.query(`isbn:${input.isbn}`);
      const vol = byIsbn?.items?.[0];
      if (vol) return GoogleBooksClient.toVolume(vol, input.isbn);
    }
    const titlePart = `intitle:${input.title}`;
    const authorPart = input.author ? `+inauthor:${input.author}` : '';
    const byTitle = await this.query(`${titlePart}${authorPart}`);
    const vol = byTitle?.items?.[0];
    if (vol) return GoogleBooksClient.toVolume(vol, null);
    return null;
  }

  private static toVolume(vol: z.infer<typeof volumeSchema>, fallbackIsbn: string | null): GbVolume {
    const categories = vol.volumeInfo?.categories ?? [];
    return {
      volumeId: vol.id,
      isbn13: GoogleBooksClient.pickIsbn13(vol) ?? fallbackIsbn,
      categories,
      isComic: isComicCategory(categories),
    };
  }
}

export function googleBooksClient(options: GoogleBooksClientOptions): GoogleBooksClient {
  return new GoogleBooksClient(options);
}
