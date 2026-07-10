// ADR-046 / DESIGN-024 (PLAN-023) — the book-cover proxy helper. Mirrors the ADR-019 poster proxy: the
// app route streams the upstream bytes with the credential in a SERVER-SIDE header/param so the Kavita
// apiKey / ABS bearer never reaches the browser. Kept out of the app route so the @hnet/books coupling
// (login + token caching) stays in @hnet/api (same split as resolvePosterUpstream / resolveYtdlsubThumb).
//
// SECURITY: not an open image proxy — `source` is a closed enum and `id` is format-validated per source
// (Kavita = numeric series id, ABS = uuid-shaped item id). The route additionally gates on session +
// the `books` section (never client-hidden only).
import { createHash } from 'node:crypto';
import type { BooksSource } from '@hnet/db';
import { assertBooksEnv } from '@hnet/books';
import { booksReadClients, type BooksReadClients } from '@hnet/books/read';

export function isBooksSource(value: string): value is BooksSource {
  return value === 'kavita' || value === 'audiobookshelf';
}

/** Format-validate the external id per source so the proxy can't be pointed at an arbitrary path. */
export function isValidBooksExternalId(source: BooksSource, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
  if (source === 'kavita') return /^[0-9]+$/.test(id); // Kavita series id
  return /^[0-9a-fA-F-]{6,64}$/.test(id); // ABS library-item uuid
}

/** Strong ETag over (source, id, coverVersion) — the coverRef is self-versioning (Kavita) / mtime (ABS). */
export function booksCoverEtag(source: BooksSource, id: string, version: string): string {
  return `"${createHash('sha1').update(`${source}:${id}:${version}`).digest('base64url')}"`;
}

let clients: BooksReadClients | null = null;
/** Lazily build the singleton read clients from env; null if the books env is absent/misconfigured. */
function getClients(): BooksReadClients | null {
  if (clients) return clients;
  try {
    clients = booksReadClients(assertBooksEnv());
    return clients;
  } catch {
    return null; // KAVITA_PASSWORD/AUDIOBOOKSHELF_PASSWORD absent ⇒ the route 404s → fallback tile
  }
}

/**
 * Fetch a book cover from the owning server (Kavita series-cover / ABS item-cover), authed server-side.
 * Returns the raw upstream Response, or null when the env is absent or the fetch throws. The caller (the
 * app route) checks `.ok`/`.body` and streams the bytes; any miss → 404 → the KindIcon fallback tile.
 */
export async function fetchBooksCover(source: BooksSource, id: string): Promise<Response | null> {
  const c = getClients();
  if (!c) return null;
  try {
    return source === 'kavita'
      ? await c.kavita.fetchSeriesCover(id)
      : await c.audiobookshelf.fetchItemCover(id);
  } catch {
    return null;
  }
}
