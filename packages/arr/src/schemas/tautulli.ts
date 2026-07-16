// ADR-018 / DESIGN-008 D-04 — Tautulli /api/v2 response subsets (BC-03 ACL: only the
// consumed fields cross the boundary). Verified live 2026-07-06 against Tautulli on the
// HaynesOps + HaynesKube instances. Tautulli wraps every response in
// `{ response: { result, message, data } }`; `data` shape is per-command.
import { z } from 'zod';

/** Tautulli's uniform envelope, generic over the per-command `data` payload. */
export const tautulliEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    response: z.object({
      result: z.string(),
      message: z.string().nullish(),
      data,
    }),
  });

/** rating_key comes back as a number in history rows, a string elsewhere — accept both. */
const ratingKey = z.union([z.number(), z.string()]).nullish();

/**
 * `cmd=get_history` row. The GUID that identifies the title is NOT on the history row
 * (tmdb_id/imdb_id are null there); it is resolved via get_metadata by rating_key. For
 * episodes the SERIES is `grandparent_rating_key`. `date`/`stopped` are unix seconds.
 */
export const tautulliHistoryRowSchema = z.object({
  rating_key: ratingKey,
  grandparent_rating_key: ratingKey,
  media_type: z.string().nullish(),
  date: z.number().nullish(),
  stopped: z.number().nullish(),
  watched_status: z.number().nullish(), // 1 = watched, 0.x = partial
  user: z.string().nullish(),
  // ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch-state) — the plex.tv NUMERIC user id (Tautulli
  // returns it as a number; a string form is tolerated). The join key from a household history row to the
  // signed-in app user, via user_account_map.plex_user_id. Previously the harvest discarded the per-user
  // dimension (collapsing to a household SUM/MAX); this one-field add restores it (additively).
  user_id: z.union([z.number(), z.string()]).nullish(),
  title: z.string().nullish(),
  grandparent_title: z.string().nullish(),
});
export type TautulliHistoryRow = z.infer<typeof tautulliHistoryRowSchema>;

export const tautulliHistoryDataSchema = z.object({
  data: z.array(tautulliHistoryRowSchema),
  recordsFiltered: z.number().nullish(),
  recordsTotal: z.number().nullish(),
});
export type TautulliHistoryData = z.infer<typeof tautulliHistoryDataSchema>;

/**
 * `cmd=get_libraries_table` row (subset — ADR-068 / DESIGN-040 D-02, the estate play
 * scoreboard read). Verified live 2026-07-16 against the HaynesTower instance: rows live
 * under `response.data.data[]`; `plays`/`duration` are numbers (duration = SECONDS) and
 * `section_type ∈ movie|show|artist|photo` — but Tautulli is loose with numerics elsewhere,
 * so string forms are tolerated (the aggregator coerces; non-finite ⇒ 0).
 */
export const tautulliLibrariesTableRowSchema = z.object({
  section_name: z.string().nullish(),
  section_type: z.string().nullish(),
  plays: z.union([z.number(), z.string()]).nullish(),
  duration: z.union([z.number(), z.string()]).nullish(),
});
export type TautulliLibrariesTableRow = z.infer<typeof tautulliLibrariesTableRowSchema>;

export const tautulliLibrariesTableDataSchema = z.object({
  data: z.array(tautulliLibrariesTableRowSchema),
});
export type TautulliLibrariesTableData = z.infer<typeof tautulliLibrariesTableDataSchema>;

/**
 * `cmd=get_metadata` payload (subset). `guids` carries the external ids as scheme URIs
 * (`imdb://tt…`, `tmdb://…`, `tvdb://…`) — the join key to media_items. `last_viewed_at`
 * is unix seconds. An unknown rating_key returns an empty object, so all fields are optional.
 */
export const tautulliMetadataSchema = z.object({
  guid: z.string().nullish(),
  guids: z.array(z.string()).nullish(),
  last_viewed_at: z.union([z.number(), z.string()]).nullish(),
  media_type: z.string().nullish(),
  grandparent_rating_key: ratingKey,
});
export type TautulliMetadata = z.infer<typeof tautulliMetadataSchema>;
