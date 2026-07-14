// ADR-055 / DESIGN-028 (PLAN-044) — env contract for the read-only Goodreads + Google Books clients.
// Goodreads shelf RSS is PUBLIC (no key); the base URL is overridable for the hermetic stub. Google Books
// enrichment resolves a volume id for the LazyLibrarian addBook key; its key is OPTIONAL (absent ⇒ GB
// enrichment degrades to skipped — items without a derivable id stay honestly `requested`). All non-secret
// except the GB key, which travels only as the `key` query param and is never echoed.

export const GOODREADS_BASE_URL_DEFAULT = 'https://www.goodreads.com';
export const GOOGLE_BOOKS_URL_DEFAULT = 'https://www.googleapis.com/books/v1';

export interface GoodreadsEnvConfig {
  goodreadsBaseUrl: string;
  googleBooksUrl: string;
  googleBooksApiKey?: string;
}

export function goodreadsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GoodreadsEnvConfig {
  const key = env.GOOGLE_BOOKS_API_KEY?.trim();
  return {
    goodreadsBaseUrl: (env.GOODREADS_BASE_URL?.trim() || GOODREADS_BASE_URL_DEFAULT).replace(/\/+$/, ''),
    googleBooksUrl: (env.GOOGLE_BOOKS_URL?.trim() || GOOGLE_BOOKS_URL_DEFAULT).replace(/\/+$/, ''),
    ...(key ? { googleBooksApiKey: key } : {}),
  };
}
