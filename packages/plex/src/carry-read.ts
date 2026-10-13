// ADR-114 / DESIGN-055 P4 decisions 26-34 — the Watch Carry's Plex READS, kept beside read.ts so the shared item
// schema stays narrow. Three reads:
//   - every episode of a show with the token account's watch state AND the files each item plays (`Media[].Part[]`,
//     which the shared section-item schema strips): the carry identifies content by the file's byte size;
//   - a show's own `showOrdering` preference (`includePreferences=1`);
//   - plex.tv's shared_servers WITH each friend's per-server `accessToken`. The token is a SECRET: it reaches only the
//     caller's memory, to build that friend's own client, and is never stored, logged or printed (ADR-114 C-02).
import { z } from 'zod';
import type { PlexHttp } from './http';
import { PlexParseError } from './errors';
import { childrenNamed, type XmlElement } from './xml';

const num = z.union([z.string(), z.number()]).transform(Number);

/** One file an item plays: the file's name (no folders) and its byte size (the carry's content key). */
export interface PlexLeafPart {
  name: string;
  size: number;
}

/** One episode of a show as one account sees it on one server. */
export interface PlexLeafFile {
  ratingKey: string;
  guid: string | null;
  title: string;
  /** The season number (`parentIndex`), null for an item Plex has not numbered. */
  season: number | null;
  /** The episode number (`index`). A two-episode file is one item, at its first episode's number. */
  episode: number | null;
  /** The token account's plays (0 when Plex sends none). */
  viewCount: number;
  /** The token account's resume point in ms (0 when none). */
  viewOffset: number;
  /** The token account's last watch, epoch seconds (null when none). */
  lastViewedAt: number | null;
  /** The files the item plays, in Plex's order. */
  parts: PlexLeafPart[];
}

const partSchema = z.object({ file: z.string().optional(), size: num.optional() });
const leafSchema = z.object({
  ratingKey: z.union([z.string(), z.number()]).transform(String),
  guid: z.string().optional(),
  title: z.string().optional(),
  parentIndex: num.optional(),
  index: num.optional(),
  viewCount: num.optional(),
  viewOffset: num.optional(),
  lastViewedAt: num.optional(),
  Media: z.array(z.object({ Part: z.array(partSchema).optional().default([]) })).optional().default([]),
});
const leavesContainerSchema = z.object({
  MediaContainer: z.object({
    totalSize: num.optional(),
    Metadata: z.array(leafSchema).optional().default([]),
  }),
});

/** The last path segment of a Plex file path (Unix or Windows separators). */
export function partName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

function toLeaf(item: z.infer<typeof leafSchema>): PlexLeafFile {
  const fin = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  return {
    ratingKey: item.ratingKey,
    guid: item.guid?.trim() || null,
    title: item.title ?? '',
    season: fin(item.parentIndex),
    episode: fin(item.index),
    viewCount: Math.max(0, fin(item.viewCount) ?? 0),
    viewOffset: Math.max(0, fin(item.viewOffset) ?? 0),
    lastViewedAt: fin(item.lastViewedAt) && (item.lastViewedAt as number) > 0 ? (item.lastViewedAt as number) : null,
    parts: item.Media.flatMap((m) =>
      m.Part.filter((p) => typeof p.file === 'string' && typeof p.size === 'number' && Number.isFinite(p.size)).map(
        (p) => ({ name: partName(p.file as string), size: p.size as number }),
      ),
    ),
  };
}

/** A carry read pages at this size … */
export const LEAF_FILES_PAGE_SIZE = 500;
/** … under this cap (20 × 500 = 10,000 episodes). */
export const MAX_LEAF_FILES_PAGES = 20;

/**
 * `GET {url}` (a show's `/allLeaves`) paged to completion. A carry must see every item, so a listing that is not
 * provably complete (the page cap, a page short of the server's own total, or a total that changes between pages
 * twice) throws instead of answering a partial view.
 */
export async function readLeafFiles(http: PlexHttp, url: string, pageSize = LEAF_FILES_PAGE_SIZE): Promise<PlexLeafFile[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const items: PlexLeafFile[] = [];
    let start = 0;
    let total: number | null = null;
    let complete = false;
    let shifted = false;
    for (let page = 0; page < MAX_LEAF_FILES_PAGES; page += 1) {
      const body = await http.requestJson('GET', url, leavesContainerSchema, {
        query: { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': pageSize },
      });
      const mc = body.MediaContainer;
      const pageTotal = mc.totalSize ?? null;
      if (page === 0) total = pageTotal;
      else if (pageTotal !== total) {
        shifted = true;
        break;
      }
      items.push(...mc.Metadata.map(toLeaf));
      start += mc.Metadata.length;
      if (total !== null ? start >= total : mc.Metadata.length < pageSize) {
        complete = true;
        break;
      }
      if (mc.Metadata.length === 0) break;
    }
    if (complete) return items;
    if (!shifted) break;
  }
  throw new PlexParseError('GET', url, ['the episode listing could not be read completely']);
}

const prefsContainerSchema = z.object({
  MediaContainer: z.object({
    Metadata: z
      .array(
        z.object({
          ratingKey: z.union([z.string(), z.number()]).transform(String),
          Preferences: z
            .object({
              Setting: z
                .array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).nullish() }))
                .optional()
                .default([]),
            })
            .nullish(),
        }),
      )
      .optional()
      .default([]),
  }),
});

/** The values Plex Web offers for a show's "Episode ordering" (`''` is the library default). */
export const SHOW_ORDERINGS = ['', 'tmdbAiring', 'tvdbAiring', 'tvdbDvd', 'tvdbAbsolute'] as const;
export type PlexShowOrdering = (typeof SHOW_ORDERINGS)[number];

export function isShowOrdering(value: string): value is PlexShowOrdering {
  return (SHOW_ORDERINGS as readonly string[]).includes(value);
}

/**
 * `GET /library/metadata/{show}?includePreferences=1` — the show's own `showOrdering` (`''` = the library default).
 * Null when the item is missing or offers no such setting (not a show).
 */
export async function readShowOrdering(http: PlexHttp, url: string): Promise<string | null> {
  const body = await http.requestJson('GET', url, prefsContainerSchema, { query: { includePreferences: 1 } });
  const item = body.MediaContainer.Metadata[0];
  const setting = item?.Preferences?.Setting.find((s) => s.id === 'showOrdering');
  if (!setting) return null;
  return setting.value === null || setting.value === undefined ? '' : String(setting.value);
}

/** One friend's share of a server, with the per-server token that reads and writes as that friend. SECRET token. */
export interface PlexSharedServerAccess {
  /** The friend's plex.tv account id. */
  userId: string;
  /** The friend's per-server token. A secret: never store, log or print it. */
  accessToken: string;
  /** Shared every library of the server. */
  allLibraries: boolean;
  /** The server section keys shared with the friend (when not all libraries). */
  sectionKeys: string[];
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/** Parse plex.tv's shared_servers XML into access rows; a share without a user id or a token is left out. */
export function parseSharedServerAccess(root: XmlElement): PlexSharedServerAccess[] {
  const out: PlexSharedServerAccess[] = [];
  for (const ss of childrenNamed(root, 'SharedServer')) {
    const userId = (ss.attrs.userID ?? '').trim();
    const accessToken = (ss.attrs.accessToken ?? '').trim();
    if (!userId || !accessToken) continue;
    out.push({
      userId,
      accessToken,
      allLibraries: truthy(ss.attrs.allLibraries),
      sectionKeys: childrenNamed(ss, 'Section')
        .filter((s) => truthy(s.attrs.shared))
        .map((s) => (s.attrs.key ?? '').trim())
        .filter((k) => k.length > 0),
    });
  }
  return out;
}
