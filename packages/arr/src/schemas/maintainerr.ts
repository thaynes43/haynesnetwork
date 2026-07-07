// ADR-018 / DESIGN-008 D-06 + ADR-023 / DESIGN-010 D-02 — Maintainerr ACL. Only the fields we key
// on cross this boundary (strip mode); the rest is dropped. Shapes derived from the Maintainerr
// v3.17.0 source (controllers + Zod/DTO bodies — no live call): `GET /api/collections`,
// `GET /api/collections/media/:id/content/:page`, `GET /api/rules`, `GET /api/rules/constants`,
// `GET /api/rules/exclusion`, `GET /api/settings`, `GET /api/app/status`, `GET /api/settings/test/plex`.
// Verified reachable 2026-07-06 (svc :6246). NOTE v3.x renamed `plexId` → `mediaServerId` (a Plex
// ratingKey when Plex is active) — that string is Maintainerr's exclusion/handle key.
import { z } from 'zod';

/**
 * A media entry inside a Maintainerr collection. The `GET /api/collections` `media` array is a
 * PREVIEW subset (full membership comes from the paged content endpoint — mediaCount is the total).
 * Carries the tmdb/tvdb ids we join to media_items on, plus the Maintainerr server id + per-item
 * size (bytes). `sizeBytes` and the ids are nullish (Maintainerr may not have resolved them).
 */
export const maintainerrMediaSchema = z.object({
  id: z.number().int().nullish(),
  collectionId: z.number().int().nullish(),
  mediaServerId: z.union([z.string(), z.number()]).nullish(), // Plex ratingKey (v3 exclusion/handle key)
  tmdbId: z.number().int().nullish(),
  tvdbId: z.number().int().nullish(),
  plexId: z.number().int().nullish(), // legacy pre-v3 alias — still tolerated
  addDate: z.string().nullish(), // when Maintainerr added it to the collection
  sizeBytes: z.number().nullish(), // per-item on-disk size (bigint on the wire → number)
  image_path: z.string().nullish(),
  isManual: z.boolean().nullish(),
});
export type MaintainerrMedia = z.infer<typeof maintainerrMediaSchema>;

export const maintainerrCollectionSchema = z.object({
  id: z.number().int().nullish(),
  title: z.string().nullish(),
  isActive: z.boolean().nullish(),
  /** Days after addDate an item is deleted — the (constant per collection) delete-date driver. */
  deleteAfterDays: z.number().int().nullish(),
  libraryId: z.union([z.string(), z.number()]).nullish(),
  type: z.union([z.string(), z.number()]).nullish(), // MediaItemType (movie|show|… as string OR 1..4)
  mediaCount: z.number().int().nullish(),
  totalSizeBytes: z.number().nullish(),
  handledMediaSizeBytes: z.number().nullish(),
  media: z.array(maintainerrMediaSchema).nullish(),
});
export type MaintainerrCollection = z.infer<typeof maintainerrCollectionSchema>;

/** `GET /api/collections/media/:id/content/:page` — paged membership with per-item size + live ids. */
export const maintainerrCollectionContentSchema = z.object({
  totalSize: z.number().int(),
  items: z.array(maintainerrMediaSchema),
});
export type MaintainerrCollectionContent = z.infer<typeof maintainerrCollectionContentSchema>;

/** `GET /api/rules` — a rule group (RulesDto subset — the listing/editor shell keys). */
export const maintainerrRuleGroupSchema = z
  .object({
    id: z.number().int().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    isActive: z.boolean().nullish(),
    libraryId: z.union([z.string(), z.number()]).nullish(),
    dataType: z.union([z.string(), z.number()]).nullish(),
    collection: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough(); // keep the full RulesDto for round-trip PUTs (editor is UX follow-up)
export type MaintainerrRuleGroup = z.infer<typeof maintainerrRuleGroupSchema>;

/** `GET /api/rules/constants` — the rule-schema catalog. `applications` is filtered at runtime to
 *  CONFIGURED integrations (Radarr/Sonarr/Tautulli/Seerr dropped if not set up) — the audit's
 *  integration-presence signal. */
export const maintainerrRuleConstantsSchema = z
  .object({
    applications: z
      .array(
        z
          .object({
            id: z.union([z.string(), z.number()]).nullish(),
            name: z.string().nullish(),
            mediaType: z.union([z.string(), z.number()]).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();
export type MaintainerrRuleConstants = z.infer<typeof maintainerrRuleConstantsSchema>;

/** `GET /api/rules/exclusion` — an exclusion/whitelist row (ruleGroupId null = global). */
export const maintainerrExclusionSchema = z
  .object({
    id: z.number().int().nullish(),
    mediaServerId: z.union([z.string(), z.number()]).nullish(),
    plexId: z.union([z.string(), z.number()]).nullish(), // legacy alias
    ruleGroupId: z.number().int().nullish(),
    // v3.17.0 `Exclusion.parent` is a STRING (the Plex ratingKey, written on every exclusion) — a
    // number-only schema 502'd `getExclusions` for every already-excluded item, breaking idempotency
    // + un-save on the real estate (P2). Accept either; verified against the source entity.
    parent: z.union([z.string(), z.number()]).nullish(),
    type: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();
export type MaintainerrExclusion = z.infer<typeof maintainerrExclusionSchema>;

/**
 * Shared WRITE envelope. Maintainerr's rule/exclusion writes return a `ReturnStatus`
 * (`{ code:0|1, result?, message?, skipped? }`) at HTTP 201/200 **even on LOGICAL failure** —
 * e.g. `setExclusion` → `{ code:0, message:'Failed - no metadata' }` — and the settings `PATCH`/`POST`
 * return a `BasicResponseDto` (`{ status:'OK'|'NOK', code:0|1, message }`) that ALSO carries the same
 * numeric `code`. In BOTH shapes `code === 0` is the logical-failure signal. Parsing writes through
 * this schema (instead of HTTP-status-only `requestVoid`) is what lets us fail CLOSED on a `code:0`
 * (P1a). Verified against maintainerr v3.17.0 (`createReturnStatus(success, result)` →
 * `{ code: success ? 1 : 0, result, message: result }`; `patchSettings`/`updateSettings` →
 * `BasicResponseDto`). `code` is required — a body that drops it is upstream drift and fails closed.
 */
export const maintainerrReturnStatusSchema = z
  .object({
    code: z.number().int(),
    result: z.string().nullish(),
    message: z.string().nullish(),
    status: z.string().nullish(), // BasicResponseDto (settings PATCH/POST) carries this instead of `result`
  })
  .passthrough();
export type MaintainerrReturnStatus = z.infer<typeof maintainerrReturnStatusSchema>;

/**
 * ADR-025 / DESIGN-011 — the permissive parse of a `POST /api/collections` (create) response: the
 * v3.17.0 handler returns the created Collection entity, of which we key ONLY on `id` (the id we
 * store on the batch to drive add/remove/removeCollection). Everything else passes through.
 */
export const maintainerrCollectionRefSchema = z
  .object({
    id: z.number().int().nullish(),
  })
  .passthrough();
export type MaintainerrCollectionRef = z.infer<typeof maintainerrCollectionRefSchema>;

/** `GET /api/settings` — the subset we read (secrets are masked upstream). The tag-exclusion
 *  fields (enabling the `dnd` protective tag on Radarr/Sonarr) are a documented deploy step. */
export const maintainerrSettingsSchema = z
  .object({
    radarr_tag_exclusions: z.boolean().nullish(),
    radarr_exclusion_tag: z.string().nullish(),
    radarr_untag_on_unexclude: z.boolean().nullish(),
    sonarr_tag_exclusions: z.boolean().nullish(),
    sonarr_exclusion_tag: z.string().nullish(),
    sonarr_untag_on_unexclude: z.boolean().nullish(),
  })
  .passthrough();
export type MaintainerrSettings = z.infer<typeof maintainerrSettingsSchema>;

/** `GET /api/app/status` — VersionResponse (may arrive double-encoded as a JSON string; the client
 *  pre-parses). */
export const maintainerrAppStatusSchema = z
  .object({
    status: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    version: z.string().nullish(),
    commitTag: z.string().nullish(),
    updateAvailable: z.boolean().nullish(),
  })
  .passthrough();
export type MaintainerrAppStatus = z.infer<typeof maintainerrAppStatusSchema>;

/** `GET /api/settings/test/plex` — BasicResponseDto ({ status:'OK'|'NOK', code, message }). */
export const maintainerrBasicResponseSchema = z
  .object({
    status: z.string().nullish(),
    code: z.number().int().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();
export type MaintainerrBasicResponse = z.infer<typeof maintainerrBasicResponseSchema>;
