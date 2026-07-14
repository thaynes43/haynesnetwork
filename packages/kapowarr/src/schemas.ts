// ADR-056 (PLAN-046) — the ACL zod schemas for the Kapowarr JSON responses we read. Kept tolerant
// (passthrough + nullish) because Kapowarr's shapes carry many fields we don't depend on; we only need the
// ComicVine match signals (search) and the monitored/downloaded counts (reconcile). Kapowarr wraps every
// response in `{ error, result }`; the http layer unwraps it and hands `result` to these schemas.
import { z } from 'zod';

/** Every Kapowarr API response: `{ error: <null|string>, result: <payload> }`. */
export const kapowarrEnvelopeSchema = z
  .object({
    error: z.union([z.string(), z.null()]).optional().default(null),
    result: z.unknown(),
  })
  .passthrough();

/**
 * A ComicVine search candidate (`GET /api/volumes/search?query=`). `comicvine_id` is the stable external key
 * we add with; `translated` flags a non-original-language edition (we prefer the original); `already_added`
 * is the local volume id when this ComicVine volume is ALREADY in the library (null otherwise) — so we never
 * double-add.
 */
export const kapowarrSearchResultSchema = z
  .object({
    comicvine_id: z.number(),
    title: z.string(),
    year: z.number().nullish(),
    volume_number: z.number().nullish(),
    publisher: z.string().nullish(),
    issue_count: z.number().nullish(),
    translated: z.boolean().nullish(),
    already_added: z.number().nullish(),
    cover_link: z.string().nullish(),
  })
  .passthrough();

export type KapowarrSearchResultRaw = z.infer<typeof kapowarrSearchResultSchema>;
export const kapowarrSearchResponseSchema = z.array(kapowarrSearchResultSchema);

/**
 * An ADDED volume's public data (`GET /api/volumes` / `GET /api/volumes/{id}` / the add response). We depend
 * on `id` (the local key for reconcile + force-search), `monitored`, and the `issue_count`/`issues_downloaded`
 * counts the reconcile maps to a per-format status.
 */
export const kapowarrVolumeSchema = z
  .object({
    id: z.number(),
    comicvine_id: z.number().nullish(),
    title: z.string().nullish(),
    year: z.number().nullish(),
    monitored: z.boolean().nullish(),
    issue_count: z.number().nullish(),
    issues_downloaded: z.number().nullish(),
  })
  .passthrough();

export type KapowarrVolumeRaw = z.infer<typeof kapowarrVolumeSchema>;
export const kapowarrVolumeListSchema = z.array(kapowarrVolumeSchema);

/** A root folder (`GET /api/rootfolder`) — we need its `id` to add a volume. */
export const kapowarrRootFolderSchema = z
  .object({
    id: z.number(),
    folder: z.string().nullish(),
  })
  .passthrough();

export const kapowarrRootFolderListSchema = z.array(kapowarrRootFolderSchema);
