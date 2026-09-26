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
 */
export async function readAllContainerPages(
  http: PlexHttp,
  url: string,
  query: QueryParams,
  pageSize: number,
  maxPages: number,
  schema: ZodType<PagedContainer>,
): Promise<PlexPagedListing<PlexSectionItem>> {
  const items: PlexSectionItem[] = [];
  let start = 0;
  let totalSize: number | null = null;
  let truncated = true; // proven complete only by a terminating condition below
  for (let page = 0; page < maxPages; page += 1) {
    const body = await http.requestJson('GET', url, schema, {
      query: { ...query, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': pageSize },
    });
    const mc = body.MediaContainer;
    items.push(...mc.Metadata);
    start += mc.Metadata.length;
    totalSize = mc.totalSize ?? null;
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
  return { items, totalSize, truncated };
}
