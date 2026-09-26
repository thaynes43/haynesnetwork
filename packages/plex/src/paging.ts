// The container-bounded paging loop shared by the read clients (DESIGN-049 D-09 step 6; ADR-093 / DESIGN-052 D-02).
// Extracted from PlexReadClient so the Watchlist Registry client (registry.ts) pages the owner's discover watchlist
// with exactly the same termination rules without importing read.ts.
import type { ZodType } from 'zod';
import type { PlexHttp, QueryParams } from './http';
import type { PlexSectionItem } from './schemas';

/**
 * A fully paged Plex listing plus its completeness flag. `truncated` = the read ended WITHOUT proof of
 * completion (the page cap, or a page that contradicted the server's own totalSize): the items are a
 * PARTIAL view — a caller must not treat an absent item as absent from Plex.
 */
export interface PlexPagedListing<T> {
  items: T[];
  /** The server's own total, when it sent one. */
  totalSize: number | null;
  truncated: boolean;
}

/** The `MediaContainer` subset every paged metadata listing shares. */
export type PagedContainer = {
  MediaContainer: { totalSize?: number; Metadata: PlexSectionItem[] };
};

/**
 * Page a container-bounded listing to completion with the X-Plex-Container-Start/-Size loop, under a
 * page cap. Termination follows listCollections exactly: with `totalSize` on the wire the loop ends at
 * `start >= totalSize`; without it only an empty or short page ends it; anything else (the cap, or an
 * empty page that contradicts totalSize) returns `truncated: true`. The returned-page `size` is never
 * mistaken for the grand total.
 *
 * A listing that CHANGES between page reads is not believed (DESIGN-052 D-25bn): the first page's
 * `totalSize` is the listing's total, and a later page reporting a different one means the list shifted
 * under the offsets (a title removed from the pages already read moves an unread title back across the
 * page boundary, where no offset ever reads it). The whole read is repeated once from `start=0`; a second
 * inconsistent read returns `truncated: true` — a PARTIAL view, never a silently shorter "complete" one.
 */
export async function readAllContainerPages(
  http: PlexHttp,
  url: string,
  query: QueryParams,
  pageSize: number,
  maxPages: number,
  schema: ZodType<PagedContainer>,
): Promise<PlexPagedListing<PlexSectionItem>> {
  const first = await readPass(http, url, query, pageSize, maxPages, schema);
  if (!first.shifted) return first.listing;
  const second = await readPass(http, url, query, pageSize, maxPages, schema);
  return second.shifted ? { ...second.listing, truncated: true } : second.listing;
}

/** One pass of the paging loop; `shifted` = a later page's totalSize differed from the first page's. */
async function readPass(
  http: PlexHttp,
  url: string,
  query: QueryParams,
  pageSize: number,
  maxPages: number,
  schema: ZodType<PagedContainer>,
): Promise<{ listing: PlexPagedListing<PlexSectionItem>; shifted: boolean }> {
  const items: PlexSectionItem[] = [];
  let start = 0;
  let totalSize: number | null = null;
  let truncated = true; // proven complete only by a terminating condition below
  for (let page = 0; page < maxPages; page += 1) {
    const body = await http.requestJson('GET', url, schema, {
      query: { ...query, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': pageSize },
    });
    const mc = body.MediaContainer;
    const pageTotal = mc.totalSize ?? null;
    if (page === 0) totalSize = pageTotal;
    else if (pageTotal !== totalSize) return { listing: { items, totalSize, truncated: true }, shifted: true };
    items.push(...mc.Metadata);
    start += mc.Metadata.length;
    if (totalSize !== null) {
      if (start >= totalSize) {
        truncated = false;
        break;
      }
      if (mc.Metadata.length === 0) break; // under-delivered against its own totalSize — PARTIAL
    } else if (mc.Metadata.length < pageSize) {
      truncated = false; // no totalSize: an empty/short page is the only honest completion signal
      break;
    }
  }
  return { listing: { items, totalSize, truncated }, shifted: false };
}
