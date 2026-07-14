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

// ---------------------------------------------------------------------------
// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the READ-ONLY download-state shapes the
// Kapowarr Activity adapter folds. Kapowarr's own download machinery (GetComics DDL) — NEVER MAM/qB/Prowlarr.
// ---------------------------------------------------------------------------

/**
 * A live download-queue entry (`GET /api/activity/queue`). Kapowarr's `DownloadState` values are
 * queued/paused/downloading/seeding/importing/failed/canceled/shutdown; `progress` is a 0..100 float; the
 * entry is keyed to a `volume_id` (+ optional `issue_id`). Tolerant/passthrough — we read only the state
 * signals the stage machine needs (Kapowarr carries many transport fields we don't depend on).
 */
export const kapowarrQueueEntrySchema = z
  .object({
    id: z.number().nullish(),
    volume_id: z.number().nullish(),
    issue_id: z.number().nullish(),
    status: z.string().nullish(),
    progress: z.number().nullish(),
    size: z.number().nullish(),
    title: z.string().nullish(),
    web_title: z.string().nullish(),
    source: z.string().nullish(),
  })
  .passthrough();

export type KapowarrQueueEntryRaw = z.infer<typeof kapowarrQueueEntrySchema>;
export const kapowarrQueueListSchema = z.array(kapowarrQueueEntrySchema);

/**
 * A completed-download history row (`GET /api/activity/history`) — Kapowarr logs the downloads it landed.
 * `downloaded_at` is epoch SECONDS. Keyed to `volume_id`; the adapter reads the recent ones as the
 * `completed` signal (a download the live queue no longer holds).
 */
export const kapowarrHistoryEntrySchema = z
  .object({
    volume_id: z.number().nullish(),
    issue_id: z.number().nullish(),
    web_title: z.string().nullish(),
    file_title: z.string().nullish(),
    title: z.string().nullish(),
    downloaded_at: z.number().nullish(),
    /** Some Kapowarr builds flag success on the row; default true (the history logs LANDED downloads). */
    success: z.boolean().nullish(),
  })
  .passthrough();

export type KapowarrHistoryEntryRaw = z.infer<typeof kapowarrHistoryEntrySchema>;
export const kapowarrHistoryListSchema = z.array(kapowarrHistoryEntrySchema);

/**
 * A planned/running background task (`GET /api/system/tasks`). A per-volume search carries `volume_id`; a
 * monitored/mass search runs with `volume_id: null`. The adapter reads only search-shaped tasks (the
 * honest `searching` signal — we never claim a search the API doesn't show).
 */
export const kapowarrTaskSchema = z
  .object({
    task_id: z.number().nullish(),
    action: z.string().nullish(),
    display_title: z.string().nullish(),
    volume_id: z.number().nullish(),
    issue_id: z.number().nullish(),
  })
  .passthrough();

export type KapowarrTaskRaw = z.infer<typeof kapowarrTaskSchema>;
export const kapowarrTaskListSchema = z.array(kapowarrTaskSchema);
