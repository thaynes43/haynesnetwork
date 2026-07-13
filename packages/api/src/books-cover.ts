// ADR-046 / DESIGN-024 D-05 (PLAN-023, F-06 perf port of the ADR-041 idiom) — the book-cover proxy
// helper. Mirrors the ADR-019 poster proxy: the app route serves the upstream bytes with the credential
// in a SERVER-SIDE header/param so the Kavita apiKey / ABS bearer never reaches the browser. Kept out of
// the app route so the @hnet/books coupling (login + token caching) stays in @hnet/api (same split as
// resolvePosterUpstream / resolveYtdlsubThumb).
//
// F-06 (2026-07-12, measured live): Kavita serves its PRE-GENERATED cover only — ~309 KB median PNG,
// resize params ignored — while ABS resizes upstream (`?width=300&format=webp` ⇒ ~10–14 KB WebP, vs the
// ADR-041 ytdl-sub 3.5 KB WebP baseline the walls chase). So: ABS covers are requested as the sized WebP
// variant (original kept as the per-image fallback tier, ADR-041 C-02 mirror), and BOTH sources are
// memoized in the in-process byte-capped ThumbLruCache — memoization, NOT a store (no PVC, no table,
// evaporates on restart — the ADR-019 posture stands). Repeat wall paints are 304s / memory hits; the
// per-request upstream fetch (+ login dance) is gone from the hot path.
//
// SECURITY: not an open image proxy — `source` is a closed enum, `id` is format-validated per source
// (Kavita = numeric series id, ABS = uuid-shaped item id), and the ABS variant is FIXED here (never
// client-chosen dimensions). The route additionally gates on session + the `books` section.
import { createHash } from 'node:crypto';
import type { BooksSource } from '@hnet/db';
import { assertBooksEnv } from '@hnet/books';
import { booksReadClients, type BooksReadClients } from '@hnet/books/read';
import { ThumbLruCache } from './ytdlsub-poster';

export function isBooksSource(value: string): value is BooksSource {
  return value === 'kavita' || value === 'audiobookshelf';
}

/** Format-validate the external id per source so the proxy can't be pointed at an arbitrary path. */
export function isValidBooksExternalId(source: BooksSource, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
  if (source === 'kavita') return /^[0-9]+$/.test(id); // Kavita series id
  return /^[0-9a-fA-F-]{6,64}$/.test(id); // ABS library-item uuid
}

/**
 * The FIXED ABS cover variant (ADR-041 C-01 discipline: server-chosen, never client dimensions) — the
 * 2:3 poster tile at ≈2× its 132–160px box, width-only so ABS keeps each cover's native aspect.
 */
export const ABS_COVER_VARIANT = { width: 300, format: 'webp' } as const;
/** The variant token baked into the ABS ETag — bump it if ABS_COVER_VARIANT ever changes. */
const ABS_VARIANT_TOKEN = `w${ABS_COVER_VARIANT.width}${ABS_COVER_VARIANT.format}`;

/**
 * Strong ETag over (source, id, coverVersion) — the coverRef is self-versioning (Kavita) / mtime (ABS).
 * ABS additionally bakes in the variant token: the served representation is the sized WebP, so
 * pre-variant browser caches (holding JPEG originals) revalidate INTO the smaller bytes. The Kavita
 * input is deliberately the pre-F-06 formula — its bytes are unchanged and existing caches must stay
 * valid (rotating it would force a one-time ~300 KB re-pull per tile for every browser).
 */
export function booksCoverEtag(source: BooksSource, id: string, version: string): string {
  const input =
    source === 'audiobookshelf'
      ? `${source}:${id}:${version}:${ABS_VARIANT_TOKEN}`
      : `${source}:${id}:${version}`;
  return `"${createHash('sha1').update(input).digest('base64url')}"`;
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

let cacheSingleton: ThumbLruCache | undefined;
/** The route's process-wide cover cache (one per Node server — the Next standalone runtime). */
export function booksCoverCache(): ThumbLruCache {
  cacheSingleton ??= new ThumbLruCache();
  return cacheSingleton;
}

export interface BooksCoverResult {
  body: Uint8Array;
  contentType: string;
  /**
   * 'primary' = the canonical bytes (Kavita pre-generated cover / ABS sized WebP) — memoized, served
   * with the strong ETag + long Cache-Control. 'fallback' = the ABS ORIGINAL after a sized-variant miss
   * (ADR-041 C-02 mirror) — served with a short max-age and NO ETag, never memoized, so a transient
   * resize quirk can't make originals sticky in the LRU or in browser caches.
   */
  tier: 'primary' | 'fallback';
}

interface BooksCoverDeps {
  clients?: BooksReadClients | null;
  cache?: ThumbLruCache;
}

/** Buffer an upstream image Response, or null when it isn't a usable image. */
async function bufferImage(
  response: Response,
  defaultType: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  if (!response.ok || !response.body) return null;
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? defaultType,
  };
}

/**
 * Serve a book cover: LRU memory hit, else the authed upstream (Kavita series-cover as stored — resize
 * params verified ignored; ABS item-cover as the sized WebP variant with the original as the fallback
 * tier). Returns null when the env is absent, the id is unknown upstream, or the fetch throws — the app
 * route turns that into a 404 → the KindIcon fallback tile. `deps` exists for unit tests only.
 */
export async function getBooksCover(
  source: BooksSource,
  id: string,
  version: string,
  deps: BooksCoverDeps = {},
): Promise<BooksCoverResult | null> {
  const cache = deps.cache ?? booksCoverCache();
  const key = `${source}:${id}:${version}`; // version-scoped: replaced art misses, stale entries age out
  const cached = cache.get(key);
  if (cached) return { body: cached.body, contentType: cached.contentType, tier: 'primary' };

  const c = deps.clients !== undefined ? deps.clients : getClients();
  if (!c) return null;
  const etag = booksCoverEtag(source, id, version);

  try {
    if (source === 'kavita') {
      const image = await bufferImage(await c.kavita.fetchSeriesCover(id), 'image/png');
      if (!image) return null;
      cache.set(key, { ...image, etag }); // over-cap bodies are served, not cached (LRU guard)
      return { ...image, tier: 'primary' };
    }

    // ABS: the sized WebP variant. Only THIS tier is memoized — see BooksCoverResult.tier.
    const sized = await bufferImage(
      await c.audiobookshelf.fetchItemCover(id, ABS_COVER_VARIANT),
      'image/webp',
    );
    if (sized) {
      cache.set(key, { ...sized, etag });
      return { ...sized, tier: 'primary' };
    }

    // ADR-041 C-02 mirror — the original-art fallback (a resize quirk on a specific cover degrades to
    // exactly the pre-F-06 behavior, never a broken tile).
    const original = await bufferImage(await c.audiobookshelf.fetchItemCover(id), 'image/jpeg');
    if (!original) return null;
    return { ...original, tier: 'fallback' };
  } catch {
    return null;
  }
}
