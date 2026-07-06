// ADR-018 / DESIGN-008 D-06 — Maintainerr collection subset (best-effort computed-props tier;
// lands in media_metadata.extra.maintainerr). Verified reachable 2026-07-06 (svc :6246). Only
// the fields we key on cross the ACL; the rest is dropped (strip mode).
import { z } from 'zod';

/** A media entry inside a Maintainerr collection (carries the tmdb id to join to media_items). */
export const maintainerrMediaSchema = z.object({
  tmdbId: z.number().int().nullish(),
  plexId: z.number().int().nullish(),
  addDate: z.string().nullish(),
});

export const maintainerrCollectionSchema = z.object({
  id: z.number().int().nullish(),
  title: z.string().nullish(),
  isActive: z.boolean().nullish(),
  deleteAfterDays: z.number().int().nullish(),
  media: z.array(maintainerrMediaSchema).nullish(),
});
export type MaintainerrCollection = z.infer<typeof maintainerrCollectionSchema>;
