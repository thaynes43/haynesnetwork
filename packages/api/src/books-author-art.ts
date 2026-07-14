// DESIGN-026 D-04 amendment (group-card art) — ABS AUTHOR PORTRAITS for the grouped-by-Author
// walls, the ADR-041 idiom a third time (after the ytdl-sub poster proxy and the F-06 cover
// proxy): a FIXED server-chosen WebP variant, the in-process byte-capped ThumbLruCache, and a
// strong version-rotating ETag. Two seams:
//
//   • The DIRECTORY — an in-process TTL cache of ABS's author list (name → {id, updatedAt,
//     hasImage}), read via the @hnet/books listAuthors read (ADR-046 — read-only, no ./write).
//     `books.groups` looks each author card's label up here and attaches a portrait URL ONLY when
//     ABS actually holds a photo (`imagePath` non-null) — populated-value-gated (ADR-051 C-06):
//     a card NEVER points at a 404. ABS unreachable / env absent ⇒ null directory ⇒ every card
//     keeps the stacked-cover fan (the universal fallback), never an error.
//   • The IMAGE read — getAbsAuthorImage mirrors getBooksCover's ABS branch exactly: LRU hit →
//     sized WebP variant (memoized + ETagged) → original fallback tier (served, never memoized,
//     ADR-041 C-02 discipline). Served by /api/books/author-image (session + books-section gated
//     like its parent /api/books/cover).
//
// Live-verified 2026-07-13 (port-forward probe): GET /api/libraries/{id}/authors carries
// imagePath/updatedAt; GET /api/authors/{id}/image?width=300&format=webp returns a ~2.7 KB WebP
// (400×267 WebP original); updatedAt rotates on an author re-match.
import { createHash } from 'node:crypto';
import type { BooksReadClients } from '@hnet/books/read';
import { booksClientsSingleton, booksCoverCache } from './books-cover';
import type { ThumbLruCache } from './ytdlsub-poster';

/** The FIXED author-portrait variant (ADR-041 C-01 discipline — server-chosen, never client dims). */
export const ABS_AUTHOR_IMAGE_VARIANT = { width: 300, format: 'webp' } as const;
/** Baked into the ETag — bump if ABS_AUTHOR_IMAGE_VARIANT ever changes. */
const VARIANT_TOKEN = `w${ABS_AUTHOR_IMAGE_VARIANT.width}${ABS_AUTHOR_IMAGE_VARIANT.format}`;

/** ABS author ids are uuid-shaped (same closed shape as ABS item ids in the cover proxy). */
export function isValidAbsAuthorId(id: string): boolean {
  return typeof id === 'string' && /^[0-9a-fA-F-]{6,64}$/.test(id);
}

/** The version is the author row's `updatedAt` ms epoch — digits only, bounded. */
export function isValidAbsAuthorVersion(v: string): boolean {
  return typeof v === 'string' && /^[0-9]{1,16}$/.test(v);
}

/** Strong ETag over (author id, updatedAt, variant) — a re-matched photo rotates updatedAt ⇒ the URL + this. */
export function absAuthorImageEtag(id: string, version: string): string {
  const input = `abs-author:${id}:${version}:${VARIANT_TOKEN}`;
  return `"${createHash('sha1').update(input).digest('base64url')}"`;
}

// ---------------------------------------------------------------------------
// The author directory (name → art ref), TTL-memoized in-process
// ---------------------------------------------------------------------------

export interface AbsAuthorArtRef {
  id: string;
  /** ms epoch — the art URL's `v` (rotates the ETag when the photo changes). */
  updatedAt: number;
  /** True only when ABS holds a photo (`imagePath` non-null) — the populated-value gate. */
  hasImage: boolean;
}

/** Directory lookups are by TRIMMED, case-folded author name (books_items.author is the same
 *  ABS-authored string, so an exact fold matches; multi-author "A, B" labels simply miss → fan). */
export function normalizeAuthorName(name: string): string {
  return name.trim().toLowerCase();
}

const DIRECTORY_TTL_MS = 10 * 60_000; // fresh enough that an ABS "match authors" run shows up fast
const DIRECTORY_FAILURE_TTL_MS = 60_000; // a down ABS is retried gently, never hammered per request

interface DirectoryState {
  map: Map<string, AbsAuthorArtRef> | null;
  fetchedAt: number;
}

let directoryState: DirectoryState = { map: null, fetchedAt: 0 };
let directoryInflight: Promise<Map<string, AbsAuthorArtRef> | null> | null = null;

/** Test hook — drop the memoized directory (module-level state, one per Node server). */
export function resetAbsAuthorDirectory(): void {
  directoryState = { map: null, fetchedAt: 0 };
  directoryInflight = null;
}

async function fetchDirectory(clients: BooksReadClients): Promise<Map<string, AbsAuthorArtRef>> {
  const map = new Map<string, AbsAuthorArtRef>();
  const libraries = await clients.audiobookshelf.listLibraries();
  for (const library of libraries) {
    if (library.mediaType !== 'book') continue;
    const authors = await clients.audiobookshelf.listAuthors(library.id);
    for (const author of authors) {
      const key = normalizeAuthorName(author.name);
      if (key === '' || map.has(key)) continue; // first library wins on a duplicate name
      map.set(key, {
        id: author.id,
        updatedAt: author.updatedAt ?? 0,
        hasImage: typeof author.imagePath === 'string' && author.imagePath !== '',
      });
    }
  }
  return map;
}

/**
 * The ABS author directory (normalized name → art ref), or null when ABS is unavailable (env
 * absent / unreachable). TTL-memoized; concurrent callers share one in-flight fetch; a failure is
 * negative-cached briefly so a down ABS can't be hammered by every wall paint.
 */
export async function absAuthorDirectory(
  deps: { clients?: BooksReadClients | null; now?: number } = {},
): Promise<Map<string, AbsAuthorArtRef> | null> {
  const now = deps.now ?? Date.now();
  const ttl = directoryState.map ? DIRECTORY_TTL_MS : DIRECTORY_FAILURE_TTL_MS;
  if (directoryState.fetchedAt !== 0 && now - directoryState.fetchedAt < ttl) {
    return directoryState.map;
  }
  if (directoryInflight) return directoryInflight;

  const clients = deps.clients !== undefined ? deps.clients : booksClientsSingleton();
  if (!clients) {
    directoryState = { map: null, fetchedAt: now };
    return null;
  }

  directoryInflight = fetchDirectory(clients)
    .then((map) => {
      directoryState = { map, fetchedAt: Date.now() };
      return map;
    })
    .catch(() => {
      directoryState = { map: null, fetchedAt: Date.now() };
      return null;
    })
    .finally(() => {
      directoryInflight = null;
    });
  return directoryInflight;
}

/**
 * The authed portrait-proxy URL for one author name, or null (no directory / unknown author /
 * no photo) — null keeps the card on the stacked-cover fan. Pure over the directory map.
 */
export function absAuthorImageUrlFor(
  directory: Map<string, AbsAuthorArtRef> | null,
  authorName: string,
): string | null {
  if (!directory) return null;
  const ref = directory.get(normalizeAuthorName(authorName));
  if (!ref || !ref.hasImage) return null;
  return `/api/books/author-image?id=${encodeURIComponent(ref.id)}&v=${encodeURIComponent(String(ref.updatedAt))}`;
}

// ---------------------------------------------------------------------------
// The image read (LRU → sized variant → original fallback tier)
// ---------------------------------------------------------------------------

export interface AbsAuthorImageResult {
  body: Uint8Array;
  contentType: string;
  /** 'primary' = the sized WebP (memoized + ETagged); 'fallback' = the original after a resize
   *  quirk (short max-age, no ETag, never memoized — the ADR-041 C-02 mirror). */
  tier: 'primary' | 'fallback';
}

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
 * Serve one author portrait: LRU memory hit, else the authed upstream sized-WebP variant with the
 * original as the fallback tier. Null on env-absent / unknown author / fetch failure — the route
 * turns that into a 404 (and the CARD never linked here unless ABS reported a photo, so a 404 is
 * a race with a just-deleted image, not the steady state). `deps` exists for unit tests only.
 */
export async function getAbsAuthorImage(
  id: string,
  version: string,
  deps: { clients?: BooksReadClients | null; cache?: ThumbLruCache } = {},
): Promise<AbsAuthorImageResult | null> {
  const cache = deps.cache ?? booksCoverCache();
  const key = `abs-author:${id}:${version}`; // prefixed — never collides with cover keys
  const cached = cache.get(key);
  if (cached) return { body: cached.body, contentType: cached.contentType, tier: 'primary' };

  const clients = deps.clients !== undefined ? deps.clients : booksClientsSingleton();
  if (!clients) return null;
  const etag = absAuthorImageEtag(id, version);

  try {
    const sized = await bufferImage(
      await clients.audiobookshelf.fetchAuthorImage(id, ABS_AUTHOR_IMAGE_VARIANT),
      'image/webp',
    );
    if (sized) {
      cache.set(key, { ...sized, etag }); // over-cap bodies are served, not cached (LRU guard)
      return { ...sized, tier: 'primary' };
    }

    const original = await bufferImage(
      await clients.audiobookshelf.fetchAuthorImage(id),
      'image/jpeg',
    );
    if (!original) return null;
    return { ...original, tier: 'fallback' };
  } catch {
    return null;
  }
}
